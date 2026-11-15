import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm22-l5-f-adopt-'));
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
    conninfo: '',
    loginFail: '',
    loginCalls: 0,
  };
});

// A fake docker: inspect says running, the status probe answers h.probe, and the
// fence strip (a root sh -c naming the fence marker) fails when h.stripFails.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const { roleVerifierAnswer } = await import('./join-fake');
  const execFile = (_cmd: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    h.calls.push(args);
    const line = args.join(' ');
    if (args[0] === 'inspect') setImmediate(() => done(null, 'true\n', ''));
    else if (args[0] === 'exec' && args.join(' ').includes('pg_authid')) setImmediate(() => done(null, roleVerifierAnswer('Db-Secret-0123456789'), ''));
    else if (args[0] === 'exec' && line.includes('smdb-write-fence')) {
      setImmediate(() => h.stripFails ? done(new Error('exit 1'), '', 'sed: cannot rename pg_hba.conf: Read-only file system\n') : done(null, '', ''));
    } else if (args[0] === 'exec' && line.includes('pg_is_in_recovery(),')) setImmediate(() => done(null, h.probe, ''));
    else if (args[0] === 'exec' && line.includes("grep '^primary_conninfo'")) setImmediate(() => done(null, h.conninfo, ''));
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
vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  appContainerRunning: async () => false,
  updateInstanceFleetLogin: () => { h.loginCalls++; if (h.loginFail) throw new Error(h.loginFail); },
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
  h.conninfo = '';
  h.loginFail = '';
  h.loginCalls = 0;
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', 'b1', 'env'), { recursive: true });
  writeRegistry({ fleetDbReplica: { ...REPLICA } });
  envManager.setEnvVars('b1', { DATA_BACKEND_URL: dbUrl });
});

afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('the adopt when the copy\'s own login password cannot be saved', () => {
  it('the adopt goes on, and the warning names the save error', async () => {
    h.conninfo = `primary_conninfo = 'user=smdb_copy_b1 password=Copy-Own-Secret-01 host=primary.invalid port=5433 sslmode=verify-full sslrootcert=/var/lib/postgresql/data/primary-ca.crt require_auth=scram-sha-256 application_name=fleet_standby_b1'\n`;
    h.loginFail = 'ENOSPC: no space left on device';
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { warns.push(String(m)); });
    try {
      expect((await fleetReplica.adoptPromotedReplica(bot())).success).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(h.loginCalls).toBe(1);
    expect(warns).toContain("[FleetReplica] b1: the password of this machine's own login, read from the copy, could not be saved (ENOSPC: no space left on device); join codes to this bot's other databases cannot be composed until a Join or Re-seed saves one");
    expect(bot().fleetLogin).toBeUndefined();
  });
});
