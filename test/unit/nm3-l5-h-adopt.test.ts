import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm3-l5-h-adopt-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    probe: 'f|||\n',
    stripFails: false,
    calls: [] as string[][],
    enabled: 0,
    enableOpts: [] as unknown[],
    hooks: false,
    facts: {} as Record<string, unknown>,
  };
});

// A fake docker: inspect says running, the status probe answers h.probe, and the
// fence strip (a root sh -c naming the fence marker) fails when h.stripFails.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const execFile = (_cmd: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    h.calls.push(args);
    const line = args.join(' ');
    if (args[0] === 'inspect') setImmediate(() => done(null, 'true\n', ''));
    else if (args[0] === 'exec' && line.includes('smdb-write-fence')) {
      setImmediate(() => h.stripFails ? done(new Error('exit 1'), '', 'sed: cannot rename pg_hba.conf: Read-only file system\n') : done(null, '', ''));
    } else if (args[0] === 'exec' && line.includes('pg_is_in_recovery(),')) setImmediate(() => done(null, h.probe, ''));
    else setImmediate(() => done(null, '', ''));
    const child: any = new EventEmitter();
    child.stdin = new PassThrough();
    return child;
  };
  const spawn = () => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    setTimeout(() => { child.stdout.end(''); child.stderr.end(''); setTimeout(() => child.emit('close', 0), 1); }, 1);
    return child;
  };
  return { ...real, execFile, spawn, default: { ...real, execFile, spawn } };
});
vi.mock('../../src/instance/fleetReplication', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetReplication')>()),
  enableFleetReplication: async (...args: unknown[]) => { h.enabled++; h.enableOpts.push(args[4]); return { success: true }; },
}));
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  hasAppHooks: () => h.hooks,
}));
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  capabilityRefusal: () => null,
  getAppFacts: async () => ({ success: true, facts: h.facts }),
}));
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import * as fleetReplica from '../../src/instance/fleetReplica';

const dbUrl = 'postgresql://smdb:Db-Secret-0123456789@bot1-fleet-postgres:5432/smdb';
const REPLICA = {
  containerName: 'bot1-fleet-postgres-replica', volume: 'bot1-fleet-postgres-replica-data', slot: 'fleet_standby_b1',
  primaryHost: 'primary.invalid', primaryPort: 5433, publicHost: 'standby.invalid', hostPort: 5440, certHost: 'standby.invalid',
  user: 'smdb', db: 'smdb',
};

const writeRegistry = (extra: Record<string, unknown> = {}): void => {
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({
    instances: {
      b1: {
        id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'running',
        sourceType: 'git', sourceUrl: 'https://example.invalid/fake/super-modular-discord-bot',
        envVars: { DATA_BACKEND: 'postgres' },
        createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
        ...extra,
      },
    },
  }));
};
const bot = () => containerManager.getBot('b1')!;

beforeEach(() => {
  h.probe = 'f|||\n';
  h.stripFails = false;
  h.calls.length = 0;
  h.enabled = 0;
  h.enableOpts = [];
  h.hooks = false;
  h.facts = {};
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', 'b1', 'env'), { recursive: true });
  writeRegistry({ fleetDbReplica: { ...REPLICA } });
  envManager.setEnvVars('b1', { DATA_BACKEND_URL: dbUrl });
});

afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('the adopt of a promoted copy', () => {
  it('hands the recovered database password to the enable', async () => {
    const res = await fleetReplica.adoptPromotedReplica(bot());
    expect(res.success).toBe(true);
    expect(h.enableOpts).toEqual([{ dbPassword: 'Db-Secret-0123456789' }]);
  });

  it('refuses a copy set up without an address for other machines', async () => {
    const { publicHost: _h, hostPort: _p, ...noAddress } = REPLICA;
    writeRegistry({ fleetDbReplica: noAddress });
    expect(await fleetReplica.adoptPromotedReplica(bot())).toEqual({
      success: false, error: 'This copy was set up without an address for other machines, so it cannot become their main. A machine that cannot open a port can be the main only when it runs alone.',
    });
    expect(h.enabled).toBe(0);
  });
});
