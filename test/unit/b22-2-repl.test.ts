import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b22-2-repl-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, refuseEnv: false, refuseDelete: '', refuseFlip: false, exec: 'f|||\n', conninfo: '' };
});

// A fake docker: inspect says running, exec answers h.exec, and every psql
// through spawn answers an empty result with exit 0.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const execFile = (_cmd: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (args[0] === 'inspect') setImmediate(() => done(null, 'true\n', ''));
    else if (args[0] === 'exec' && h.conninfo && args.join(' ').includes("grep '^primary_conninfo'")) setImmediate(() => done(null, h.conninfo, ''));
    else if (args[0] === 'exec') setImmediate(() => done(null, h.exec, ''));
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
vi.mock('../../src/env/manager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/env/manager')>();
  return {
    ...real,
    setEnvVars: (id: string, vars: Record<string, string>) => {
      if (h.refuseEnv) throw new Error('ENOSPC: no space left on device');
      return real.setEnvVars(id, vars);
    },
    deleteEnvVar: (id: string, key: string) => {
      if (h.refuseDelete === key) throw new Error('ENOSPC: no space left on device');
      return real.deleteEnvVar(id, key);
    },
  };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return {
    ...real,
    adoptFleetDbReplicaAsPrimary: (id: string, replication?: any) => {
      if (h.refuseFlip) throw new Error('ENOSPC: no space left on device');
      return real.adoptFleetDbReplicaAsPrimary(id, replication);
    },
  };
});
vi.mock('../../src/instance/appLifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appLifecycle')>()),
  readStandInPosture: async () => ({ read: 'none' }),
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
import { disableFleetReplication, enableFleetReplication } from '../../src/instance/fleetReplication';
import * as fleetReplica from '../../src/instance/fleetReplica';
const { adoptPromotedReplica } = fleetReplica;

const dbUrl = 'postgresql://smdb:Db-Secret-0123456789@bot1-fleet-postgres:5432/smdb';
const fleetDb = { containerName: 'bot1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'bot1-fleet-postgres-data' };
const replication = { role: 'replicator', password: 'Repl-Secret-0123456789', hostPort: 15432, publicHost: 'primary.invalid', certHost: 'primary.invalid', slotWalKeepMb: 4096 };
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
  h.refuseEnv = false;
  h.refuseDelete = '';
  h.refuseFlip = false;
  h.exec = 'f|||\n';
  h.conninfo = '';
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', 'b1', 'env'), { recursive: true });
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('R42-J3: a Disable whose closing writes are refused names what changed and Disable again', () => {
  it('answers success:false with the real state', async () => {
    writeRegistry({ fleetDb: { ...fleetDb, replication } });
    envManager.setEnvVars('b1', { DATA_BACKEND_URL: dbUrl });
    h.refuseEnv = true;
    const res = await disableFleetReplication(bot());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/slots are dropped and the replication login is revoked/);
    expect(res.error).toMatch(/ENOSPC/);
    expect(res.error).toMatch(/press Disable replication again to finish it/);
    expect(bot().fleetDb?.replication?.disablingSince).toBeTypeOf('string');
  });
});

describe('R42-J3: an adopt whose env or record write is refused changes nothing', () => {
  for (const [label, conninfo] of [['without', ''], ['with', "primary_conninfo = 'host=primary.invalid port=5433 user=replicator password=Repl-Secret-0123456789 sslmode=verify-full'\n"]] as const) {
    it(`a refused env write leaves the standby a standby, ${label} the replicator credential in the copy`, async () => {
      writeRegistry({ fleetDbReplica: { ...REPLICA } });
      envManager.setEnvVars('b1', { DATA_BACKEND_URL: dbUrl });
      h.conninfo = conninfo;
      h.refuseEnv = true;
      const res = await adoptPromotedReplica(bot());
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/ENOSPC/);
      expect(res.error).toMatch(/not adopted; nothing was changed/);
      expect(res.error).not.toMatch(/Enable replication/);
      expect(bot().fleetDb).toBeUndefined();
      expect(bot().fleetDbReplica?.containerName).toBe(REPLICA.containerName);
    });
  }

  it('a refused record flip puts the env store back, with the replicator credential in the copy', async () => {
    writeRegistry({ fleetDbReplica: { ...REPLICA } });
    envManager.setEnvVars('b1', { DATA_BACKEND_URL: dbUrl });
    h.conninfo = "primary_conninfo = 'host=primary.invalid port=5433 user=replicator password=Repl-Secret-0123456789 sslmode=verify-full'\n";
    h.refuseFlip = true;
    const res = await adoptPromotedReplica(bot());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/record could not be written \(ENOSPC.*not adopted; nothing was changed/);
    expect(bot().fleetDb).toBeUndefined();
    expect(envManager.getEnvVars('b1').DATA_BACKEND_URL).toBe(dbUrl);
  });

  it('lets Enable recover the password from a fallback when the manager env holds no URL', async () => {
    writeRegistry({ fleetDb: { ...fleetDb } });
    // Past the password the fake docker has no openssl, so the cert step fails; only the password refusal matters here.
    const res = await enableFleetReplication(bot(), 'primary.invalid', 15432, undefined, { dbPassword: 'Db-Secret-0123456789' } as any).catch((e: unknown) => ({ success: false, error: String(e) }));
    expect(res.error ?? '').not.toMatch(/Could not recover the database password/);
  });
});

describe('R43-J1: a re-seed whose pins retire was refused offers Finish retire', () => {
  const seed = (extra: Record<string, unknown> = {}) => ({
    purpose: 'reseed-stale-primary', phase: 'preparing', startedAt: 4000, updatedAt: 4000,
    publicHost: 'standby.invalid', hostPort: 5440, primaryHost: 'primary.invalid', primaryPort: 5433, slot: 'fleet_standby_b1',
    committed: true, parked: true, lastError: 'the env pins could not be removed', pinsUnretired: ['DATA_BACKEND_URL', 'DATA_BACKEND'],
    ...extra,
  });

  it('removes every pin still stored and says what the node is now', async () => {
    writeRegistry({ fleetDbReplicaSeed: seed() });
    envManager.setEnvVars('b1', { DATA_BACKEND_URL: dbUrl, DATA_BACKEND: 'postgres', OTHER: 'kept' });
    const res = await fleetReplica.finishPinsRetire(bot());
    expect(res.success).toBe(true);
    const stored = envManager.getEnvVars('b1');
    expect(stored.DATA_BACKEND_URL).toBeUndefined();
    expect(stored.DATA_BACKEND).toBeUndefined();
    expect(stored.OTHER).toBe('kept');
    expect(bot().fleetDbReplicaSeed?.pinsUnretired).toBeUndefined();
    expect(bot().fleetDbReplicaSeed?.lastError).toMatch(/env pins are removed/);
  });

  it('tries every key and names the ones it could not retire', async () => {
    writeRegistry({ fleetDbReplicaSeed: seed() });
    envManager.setEnvVars('b1', { DATA_BACKEND_URL: dbUrl, DATA_BACKEND: 'postgres' });
    h.refuseDelete = 'DATA_BACKEND_URL';
    const res = await fleetReplica.finishPinsRetire(bot());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/DATA_BACKEND_URL/);
    expect(envManager.getEnvVars('b1').DATA_BACKEND).toBeUndefined();
    expect(bot().fleetDbReplicaSeed?.pinsUnretired).toEqual(['DATA_BACKEND_URL']);
  });
});
