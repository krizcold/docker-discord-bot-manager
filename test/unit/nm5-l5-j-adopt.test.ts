import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-l5-j-adopt-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    enableResult: { success: true } as { success: boolean; error?: string },
    busy: null as string | null,
    conninfo: '',
    adoptedWith: [] as unknown[],
  };
});

// The fake docker of nm3-l5-h-adopt.test.ts: a promoted copy, with a settable primary_conninfo line.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const { roleVerifierAnswer } = await import('./join-fake');
  const execFile = (_cmd: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    const line = args.join(' ');
    if (args[0] === 'inspect') setImmediate(() => done(null, 'true\n', ''));
    else if (args[0] === 'exec' && args.join(' ').includes('pg_authid')) setImmediate(() => done(null, roleVerifierAnswer('Db-Secret-0123456789'), ''));
    else if (args[0] === 'exec' && line.includes("grep '^primary_conninfo'")) setImmediate(() => done(null, h.conninfo, ''));
    else if (args[0] === 'exec' && line.includes('pg_is_in_recovery(),')) setImmediate(() => done(null, 'f|||\n', ''));
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
  enableFleetReplication: async () => h.enableResult,
}));
vi.mock('../../src/instance/fleetJoin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetJoin')>()),
  sendAddresses: async () => ({ state: 'applied', note: 'offered' }),
}));
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  capabilityRefusal: () => null,
  hasAppHooks: () => false,
  getAppFacts: async () => ({ success: true, facts: {} }),
}));
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return {
    ...real,
    appContainerRunning: async () => false,
    isBotBusy: () => h.busy,
    adoptFleetDbReplicaAsPrimary: (...args: any[]) => {
      h.adoptedWith.push(args[1]);
      return (real.adoptFleetDbReplicaAsPrimary as any)(...args);
    },
  };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { getDataPath } from '../../src/git/repoManager';
import { adoptPromotedReplica } from '../../src/instance/fleetReplica';

const dbUrl = 'postgresql://smdb:Db-Secret-0123456789@bot1-fleet-postgres:5432/smdb';
const REPLICA = {
  containerName: 'bot1-fleet-postgres-replica', volume: 'bot1-fleet-postgres-replica-data', slot: 'fleet_standby_b1',
  primaryHost: 'primary.invalid', primaryPort: 5433, publicHost: 'standby.invalid', hostPort: 5440, certHost: 'standby.invalid',
  user: 'smdb', db: 'smdb',
};
const OFFERED = { state: 'applied', note: 'offered' };

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
  h.enableResult = { success: true };
  h.busy = null;
  h.conninfo = '';
  h.adoptedWith = [];
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', 'b1', 'env'), { recursive: true });
  writeRegistry({ fleetDbReplica: { ...REPLICA } });
  envManager.setEnvVars('b1', { DATA_BACKEND_URL: dbUrl });
});

afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('the adopt answers', () => {
  it('refuses while another operation runs', async () => {
    h.busy = 'restart';
    expect(await adoptPromotedReplica(bot())).toEqual({ success: false, error: "Operation 'restart' is running on this instance; wait for it to finish" });
  });

  it('runs under the operation its caller holds', async () => {
    h.busy = 'switch';
    expect(await adoptPromotedReplica(bot(), { op: 'switch' })).toEqual({ success: true, restartRequired: true, flipped: true, addresses: OFFERED });
  });

  it('refuses a copy with an address but no port when it does not run alone', async () => {
    const { hostPort: _p, ...noPort } = REPLICA;
    writeRegistry({ fleetDbReplica: noPort });
    expect((await adoptPromotedReplica(bot())).error).toBe('This copy was set up without an address for other machines, so it cannot become their main. A machine that cannot open a port can be the main only when it runs alone.');
  });

  it('a copy that runs alone is adopted without Enable', async () => {
    const { publicHost: _h, hostPort: _p, ...noAddress } = REPLICA;
    writeRegistry({ fleetDbReplica: noAddress });
    expect(await adoptPromotedReplica(bot(), { alone: true })).toEqual({ success: true, restartRequired: true, alone: true, flipped: true, addresses: OFFERED });
  });

  it('a failed Enable keeps the flip and names the failure', async () => {
    h.enableResult = { success: false, error: 'ssl refused' };
    expect(await adoptPromotedReplica(bot())).toEqual({
      success: false, flipped: true, addresses: OFFERED,
      error: 'The database was adopted, but enabling replication on it failed (retry from the Replication section): ssl refused',
    });
  });

  it('a seed credential of another role is not filed', async () => {
    h.conninfo = "primary_conninfo = 'user=other password=pw host=primary.invalid'\n";
    expect((await adoptPromotedReplica(bot())).success).toBe(true);
    expect(h.adoptedWith).toEqual([undefined]);
  });

  it('the password comes from the bot env file when the manager env has no URL', async () => {
    envManager.setEnvVars('b1', { DATA_BACKEND_URL: '' });
    fs.mkdirSync(getDataPath('b1'), { recursive: true });
    fs.writeFileSync(path.join(getDataPath('b1'), '.env'), `DATA_BACKEND_URL=${dbUrl}\n`);
    expect((await adoptPromotedReplica(bot())).success).toBe(true);
  });
});
