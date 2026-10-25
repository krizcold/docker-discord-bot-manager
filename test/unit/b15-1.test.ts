import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b15-1-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    volumes: new Map<string, 'exists' | 'unknown'>(),
    removedVolumes: [] as string[],
    inRecovery: 't' as 't' | 'f' | 'error',
    running: 'true' as 'true' | 'false',
    posture: { read: 'none' } as unknown,
    replicaRemoved: [] as string[],
    spawns: [] as string[][],
  };
});

const volState = (name: string): 'exists' | 'absent' | 'unknown' => h.volumes.get(name) ?? 'absent';

// A fake docker: volumes answer from h.volumes, a psql exec answers h.inRecovery,
// an inspect answers h.running, and every docker run exits 0 (the primary probe
// says the source is out of recovery).
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const execFile = (_cmd: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (args[0] === 'volume' && args[1] === 'inspect') {
      const state = volState(args[args.length - 1]);
      if (state === 'exists') return done(null, '2026-10-01T00:00:00Z\n', '');
      return done(new Error('fail'), '', state === 'absent' ? 'Error: No such volume' : 'Cannot connect to the Docker daemon');
    }
    if (args[0] === 'inspect') return done(null, `${h.running}\n`, '');
    if (args[0] === 'exec') {
      if (h.inRecovery === 'error') return done(new Error('fail'), '', 'psql: error: connection refused (fake)');
      return done(null, `${h.inRecovery}|streaming|t|0\n`, '');
    }
    done(null, '', '');
  };
  const exec = (cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (cmd.startsWith('docker inspect')) done(new Error('Error: No such object'));
    else if (cmd.startsWith('docker rm')) done(new Error('Error: No such container'));
    else done(null, { stdout: '', stderr: '' });
  };
  const spawn = (_cmd: string, args: string[]) => {
    h.spawns.push(args);
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    setTimeout(() => {
      child.stdout.end(args.includes('SELECT pg_is_in_recovery()') ? 'f\n' : '');
      child.stderr.end('');
      setTimeout(() => child.emit('close', 0), 1);
    }, 1);
    return child;
  };
  const mod = { ...real, execFile, exec, spawn };
  return { ...mod, default: mod };
});
vi.mock('../../src/docker/dockerClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
  composeDown: async () => {},
  imageState: async () => 'absent',
  removeImage: async () => true,
  listProjectVolumes: () => [],
  removeVolume: (name: string) => { h.removedVolumes.push(name); h.volumes.delete(name); return true; },
  checkDockerConnection: async () => true,
  listContainersByBotId: async () => [],
  volumeState: (name: string) => volState(name),
}));
vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  deployedComposeExists: () => true,
  applyFleetDbReplicaService: async () => ({ success: true }),
  markPendingApplyIfRunning: async () => {},
  removeFleetDbReplicaService: async (_id: string, name: string) => { h.replicaRemoved.push(name); return { success: true }; },
}));
vi.mock('../../src/instance/appLifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appLifecycle')>()),
  readStandInPosture: async () => h.posture,
}));
vi.mock('../../src/instance/fleetReplication', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetReplication')>()),
  generateCertPair: async (dir: string) => {
    const nodeFs = await import('fs');
    const nodePath = await import('path');
    for (const file of ['server.key', 'server.crt']) nodeFs.writeFileSync(nodePath.join(dir, file), 'fake');
    return { ok: true };
  },
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
import { createBotRoutes } from '../../src/webui/routes/bots';
import { dispatch } from '../../src/cli/commands';

const PEM = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----';
const DSN = 'postgresql://replicator:fakepass@primary.invalid:5433/smdb';
const DB = 'bot1-fleet-postgres-data';
const REPLICA_VOL = 'bot1-fleet-postgres-replica-data';
const FLEET_URL = 'https://example.invalid/fake/super-modular-discord-bot';
const fleetDb = { containerName: 'bot1-fleet-postgres', user: 'smdb', db: 'smdb', volume: DB };
const REPLICA = {
  containerName: 'bot1-fleet-postgres-replica', volume: REPLICA_VOL, slot: 'fleet_standby_b1',
  primaryHost: 'primary.invalid', primaryPort: 5433, publicHost: 'standby.invalid', hostPort: 5440, certHost: 'standby.invalid',
  user: 'smdb', db: 'smdb',
};

const registryPath = path.join(h.dir, 'instances.json');
const writeRegistry = (over: Record<string, unknown> = {}): void => {
  fs.writeFileSync(registryPath, JSON.stringify({
    instances: {
      b1: {
        id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'stopped',
        sourceType: 'docker-image', envVars: {},
        createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
        ...over,
      },
    },
  }));
};
const registered = (): boolean => 'b1' in JSON.parse(fs.readFileSync(registryPath, 'utf-8')).instances;
const dataDir = path.join(h.dir, 'bots', 'b1', 'data');
const bot = () => containerManager.getBot('b1')!;
const waitFor = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
};
const wiped = () => h.spawns.some((a) => a.some((s) => s.includes('rm -rf')));

const router = createBotRoutes({ clients: new Set() } as any);
const handler = (method: string, routePath: string) => {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};
const call = async (method: string, routePath: string, req: any): Promise<{ status: number; body: any }> => {
  const out = { status: 200, body: undefined as any };
  const res = { status(code: number) { out.status = code; return res; }, json(body: any) { out.body = body; return res; } };
  await handler(method, routePath)({ query: {}, body: {}, ...req }, res);
  return out;
};

beforeEach(async () => {
  await waitFor(() => containerManager.isBotBusy('b1') === null);
  h.volumes = new Map();
  h.removedVolumes = [];
  h.inRecovery = 't';
  h.running = 'true';
  h.posture = { read: 'none' };
  h.replicaRemoved = [];
  h.spawns = [];
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', 'b1', 'env'), { recursive: true });
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('a data-deleting Remove of an instance holding the fleet database', () => {
  it('refuses while the database volume exists, and removes nothing', async () => {
    writeRegistry({ fleetDb });
    h.volumes.set(DB, 'exists');
    await expect(containerManager.deleteBot('b1', false, false)).rejects.toThrow(/hosts the fleet database in volume bot1-fleet-postgres-data\. Decommission it/);
    expect(h.removedVolumes).toEqual([]);
    expect(registered()).toBe(true);
    expect(fs.existsSync(path.join(h.dir, 'bots', 'b1'))).toBe(true);
  });

  it('refuses when docker does not say whether the volume exists', async () => {
    writeRegistry({ fleetDb });
    h.volumes.set(DB, 'unknown');
    await expect(containerManager.deleteBot('b1', false, false)).rejects.toThrow(/bot1-fleet-postgres-data exists, so the manager can't confirm/);
    expect(registered()).toBe(true);
  });

  it('goes ahead once the volume is proven gone', async () => {
    writeRegistry({ fleetDb });
    await expect(containerManager.deleteBot('b1', false, false)).resolves.toBe(true);
    expect(registered()).toBe(false);
  });

  it('refuses while the standby copy volume exists', async () => {
    writeRegistry({ fleetDbReplica: REPLICA });
    h.volumes.set(REPLICA_VOL, 'exists');
    await expect(containerManager.deleteBot('b1', false, false)).rejects.toThrow(/copy of the fleet database in volume bot1-fleet-postgres-replica-data/);
    expect(h.removedVolumes).toEqual([]);
    expect(registered()).toBe(true);
  });

  it('the route answers 409 before the vault is touched', async () => {
    writeRegistry({ fleetDb });
    h.volumes.set(DB, 'exists');
    const res = await call('delete', '/:id', { params: { id: 'b1' }, query: { keepData: 'false', keepEnv: 'false' } });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Decommission it/);
    expect(registered()).toBe(true);
  });

  it('the answer names the dumps and the kept replica volume a data-deleting Remove leaves', async () => {
    writeRegistry({ fleetDbReplicaKept: { volume: REPLICA_VOL, removedAt: '2026-10-20T00:00:00.000Z', held: 'standby' } });
    const dumps = path.join(h.dir, 'backups', 'b1', 'fleet-postgres');
    fs.mkdirSync(dumps, { recursive: true });
    fs.writeFileSync(path.join(dumps, 'pre-decommission-1.dump'), 'x');
    const res = await call('delete', '/:id', { params: { id: 'b1' }, query: { keepData: 'false', keepEnv: 'false' } });
    expect(res.body).toMatchObject({ success: true, dbDumpsKept: { count: 1, folder: 'backups/b1/fleet-postgres' }, keptReplicaVolume: REPLICA_VOL });
    expect(fs.existsSync(path.join(dumps, 'pre-decommission-1.dump'))).toBe(true);
  });

  it('the route keeps the data when keepData is not given', async () => {
    writeRegistry({ fleetDb });
    h.volumes.set(DB, 'exists');
    const res = await call('delete', '/:id', { params: { id: 'b1' }, query: { keepEnv: 'false' } });
    expect(res.body).toMatchObject({ success: true });
    expect(h.removedVolumes).toEqual([]);
    expect(h.volumes.get(DB)).toBe('exists');
  });
});

describe('any Remove while a database lane owns the instance', () => {
  it('refuses a keep-data Remove while a failback run is on record', async () => {
    writeRegistry({ fleetDb, fleetFailback: { mode: 'failback', phase: 'seeding', startedAt: 1 } });
    await expect(containerManager.deleteBot('b1', true, true)).rejects.toThrow(/failback run is on this instance/);
    expect(registered()).toBe(true);
  });

  it('refuses a keep-data Remove while the copy stands in for the master', async () => {
    writeRegistry({ fleetDbReplica: REPLICA });
    h.posture = { read: 'ok', posture: { role: 'stand-in', live: true, coveringNodeId: 'node-master-1', standInNodeId: null, holdsWrites: true } };
    await expect(containerManager.deleteBot('b1', true, true)).rejects.toThrow(/standing in for/);
    expect(registered()).toBe(true);
  });
});

describe('a data-deleting Remove of a fleet node', () => {
  it('asks before deleting a data folder that holds entries, and deletes it once confirmed', async () => {
    writeRegistry({ sourceType: 'git', sourceUrl: FLEET_URL });
    fs.mkdirSync(path.join(dataDir, 'guilds', 'g1'), { recursive: true });
    const res = await call('delete', '/:id', { params: { id: 'b1' }, query: { keepData: 'false', keepEnv: 'false' } });
    expect(res.status).toBe(409);
    expect(res.body.needsConfirm).toBe(true);
    expect(res.body.error).toMatch(/can be a fleet node.*holds 1 entry/);
    expect(fs.existsSync(path.join(dataDir, 'guilds', 'g1'))).toBe(true);
    await expect(containerManager.deleteBot('b1', false, false)).rejects.toThrow(/fleet node/);
    expect(fs.existsSync(path.join(dataDir, 'guilds', 'g1'))).toBe(true);
    const confirmed = await call('delete', '/:id', { params: { id: 'b1' }, query: { keepData: 'false', keepEnv: 'false', confirmFleetData: 'true' } });
    expect(confirmed.body).toMatchObject({ success: true });
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  it('goes ahead without asking when the data folder is empty', async () => {
    writeRegistry({ sourceType: 'git', sourceUrl: FLEET_URL });
    fs.mkdirSync(dataDir, { recursive: true });
    await expect(containerManager.deleteBot('b1', false, false)).resolves.toBe(true);
  });
});

describe('dbm bots delete', () => {
  const sent = async (flags: Record<string, string | boolean>): Promise<string> => {
    let seen = '';
    const client = { request: async (_m: string, p: string) => { seen = p; return { ok: true, status: 200, body: { success: true } }; } };
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as any);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as any);
    try {
      await dispatch(client as any, ['bots', 'delete', 'b1'], flags).catch(() => {});
    } finally {
      exit.mockRestore();
      out.mockRestore();
    }
    return seen;
  };

  it('keeps the data unless --delete-data is given', async () => {
    expect(await sent({})).toMatch(/keepData=true/);
    expect(await sent({ 'delete-data': true })).toMatch(/keepData=false/);
    expect(await sent({ 'delete-data': true, 'confirm-fleet-data': true })).toMatch(/confirmFleetData=true/);
  });
});

describe('minting a fleet database password', () => {
  const instance = (): any => ({ ...bot(), sourceType: 'git', sourceUrl: FLEET_URL, envVars: { DATA_BACKEND: 'postgres' } });

  it('refuses when the volume of that name already exists', () => {
    writeRegistry({ sourceType: 'git', sourceUrl: FLEET_URL, envVars: { DATA_BACKEND: 'postgres' } });
    h.volumes.set(DB, 'exists');
    expect(() => containerManager.ensureFleetDataBackend(instance())).toThrow(/bot1-fleet-postgres-data already exists/);
    expect(envManager.getEnvVars('b1').DATA_BACKEND_URL).toBeUndefined();
    expect(bot().fleetDb).toBeUndefined();
  });

  it('mints when the volume is proven absent', () => {
    writeRegistry({ sourceType: 'git', sourceUrl: FLEET_URL, envVars: { DATA_BACKEND: 'postgres' } });
    expect(containerManager.ensureFleetDataBackend(instance())).toMatchObject({ volume: DB });
    expect(bot().fleetDb?.volume).toBe(DB);
  });
});

describe('provisioning a standby over a kept volume', () => {
  const worker = { sourceType: 'git', sourceUrl: FLEET_URL, envVars: { BOT_NODE_ROLE: 'co-worker' } };

  it('asks, naming the volume, and clears nothing', async () => {
    writeRegistry(worker);
    h.volumes.set(REPLICA_VOL, 'exists');
    const res = fleetReplica.provisionFleetReplica(bot(), DSN, PEM, 'standby.invalid', 5440);
    expect(res).toMatchObject({ success: false, needsConfirm: true, confirmVolume: REPLICA_VOL });
    expect(res.error).toMatch(/bot1-fleet-postgres-replica-data already exists/);
    await new Promise((r) => setTimeout(r, 30));
    expect(wiped()).toBe(false);
    expect(bot().fleetDbReplicaSeed).toBeUndefined();
  });

  it('a confirm for a different question does not clear it', async () => {
    writeRegistry(worker);
    h.volumes.set(REPLICA_VOL, 'exists');
    const res = fleetReplica.provisionFleetReplica(bot(), DSN, PEM, 'standby.invalid', 5440, true);
    expect(res).toMatchObject({ success: false, needsConfirm: true });
    expect(wiped()).toBe(false);
  });

  it('names what Remove replica recorded about the volume', () => {
    writeRegistry({ ...worker, fleetDbReplicaKept: { volume: REPLICA_VOL, removedAt: '2026-10-20T00:00:00.000Z', held: 'promoted' } });
    h.volumes.set(REPLICA_VOL, 'exists');
    const res = fleetReplica.provisionFleetReplica(bot(), DSN, PEM, 'standby.invalid', 5440);
    expect(res.error).toMatch(/Remove replica left it on 2026-10-20.*promoted/);
  });

  it('refuses when docker does not say whether the volume exists', () => {
    writeRegistry(worker);
    h.volumes.set(REPLICA_VOL, 'unknown');
    const res = fleetReplica.provisionFleetReplica(bot(), DSN, PEM, 'standby.invalid', 5440, false, { confirmVolume: REPLICA_VOL });
    expect(res.success).toBe(false);
    expect(res.needsConfirm).toBeUndefined();
    expect(res.error).toMatch(/can't confirm/);
  });

  it('clears it once the confirm names the volume', async () => {
    writeRegistry(worker);
    h.volumes.set(REPLICA_VOL, 'exists');
    const res = fleetReplica.provisionFleetReplica(bot(), DSN, PEM, 'standby.invalid', 5440, false, { confirmVolume: REPLICA_VOL });
    expect(res).toMatchObject({ success: true });
    await waitFor(() => !bot().fleetDbReplicaSeed);
    expect(wiped()).toBe(true);
    expect(bot().fleetDbReplica?.volume).toBe(REPLICA_VOL);
  });

  it('the run refuses a volume that appeared after the request was checked', async () => {
    writeRegistry(worker);
    const res = fleetReplica.provisionFleetReplica(bot(), DSN, PEM, 'standby.invalid', 5440);
    expect(res).toMatchObject({ success: true });
    h.volumes.set(REPLICA_VOL, 'exists');
    await waitFor(() => bot().fleetDbReplicaSeed?.parked === true);
    expect(bot().fleetDbReplicaSeed?.lastError).toMatch(/bot1-fleet-postgres-replica-data already exists/);
    expect(wiped()).toBe(false);
  });
});

describe('Remove replica', () => {
  const worker = { sourceType: 'git', sourceUrl: FLEET_URL, envVars: { BOT_NODE_ROLE: 'co-worker' } };

  it('asks before removing a copy that was promoted, and records what it held', async () => {
    writeRegistry({ ...worker, fleetDbReplica: REPLICA });
    h.inRecovery = 'f';
    const asked = await fleetReplica.removeFleetReplica(bot());
    expect(asked).toMatchObject({ success: false, needsConfirm: true });
    expect(asked.error).toMatch(/promoted/);
    expect(h.replicaRemoved).toEqual([]);
    expect(bot().fleetDbReplica).toBeDefined();
    const done = await fleetReplica.removeFleetReplica(bot(), { confirmPromoted: true });
    expect(done.success).toBe(true);
    expect(h.replicaRemoved).toEqual([REPLICA.containerName]);
    expect(bot().fleetDbReplicaKept).toMatchObject({ volume: REPLICA_VOL, held: 'promoted' });
  });

  it('refuses when the running copy cannot be read, naming the stop for a running instance', async () => {
    writeRegistry({ ...worker, status: 'running', fleetDbReplica: REPLICA });
    h.inRecovery = 'error';
    const res = await fleetReplica.removeFleetReplica(bot(), { confirmPromoted: true });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/can't confirm/);
    expect(res.error).toMatch(/stop the instance \(its copy's container stops with it\), then Remove replica keeps the volume/);
    expect(h.replicaRemoved).toEqual([]);
  });

  it('names stopping the copy itself when the instance is stopped but its copy runs', async () => {
    writeRegistry({ ...worker, fleetDbReplica: REPLICA });
    h.inRecovery = 'error';
    const res = await fleetReplica.removeFleetReplica(bot(), { confirmPromoted: true });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/did not answer/);
    expect(res.error).toContain(`docker stop ${REPLICA.containerName}`);
    expect(res.error).not.toMatch(/stop the instance/);
    expect(h.replicaRemoved).toEqual([]);
  });

  it('does not call an instance in error stopped when its copy runs unread', async () => {
    writeRegistry({ ...worker, status: 'error', fleetDbReplica: REPLICA });
    h.inRecovery = 'error';
    const res = await fleetReplica.removeFleetReplica(bot(), { confirmPromoted: true });
    expect(res.success).toBe(false);
    expect(res.error).toContain(`docker stop ${REPLICA.containerName}`);
    expect(res.error).toMatch(/Stop refuses an instance that is not running/);
    expect(res.error).not.toMatch(/is stopped/);
    expect(h.replicaRemoved).toEqual([]);
  });

  it('says a running copy with no database identity on its record was not probed', async () => {
    const { user: _u, db: _d, ...bare } = REPLICA;
    writeRegistry({ ...worker, fleetDbReplica: bare });
    const res = await fleetReplica.removeFleetReplica(bot(), { confirmPromoted: true });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/no database identity/);
    expect(res.error).not.toMatch(/did not answer/);
    expect(res.error).toContain(`docker stop ${REPLICA.containerName}`);
    expect(h.replicaRemoved).toEqual([]);
  });

  it('records a standby copy, and an unread stopped one as unknown', async () => {
    writeRegistry({ ...worker, fleetDbReplica: REPLICA });
    expect((await fleetReplica.removeFleetReplica(bot())).success).toBe(true);
    expect(bot().fleetDbReplicaKept).toMatchObject({ volume: REPLICA_VOL, held: 'standby' });
    writeRegistry({ ...worker, fleetDbReplica: REPLICA });
    h.running = 'false';
    h.inRecovery = 'error';
    expect((await fleetReplica.removeFleetReplica(bot())).success).toBe(true);
    expect(bot().fleetDbReplicaKept).toMatchObject({ volume: REPLICA_VOL, held: 'unknown' });
  });
});

describe('a failback seed retried over the replica volume its first seed made', () => {
  const master = { sourceType: 'git', sourceUrl: FLEET_URL, envVars: { BOT_NODE_ROLE: 'master' } };
  const run = (consentAt: number | null) => ({ mode: 'failback', phase: 'seeding', startedAt: 7, updatedAt: 7, consentAt, dump: null, block: null });

  it('clears it without a confirm once the run holds the wipe consent', async () => {
    writeRegistry({ ...master, fleetFailback: run(8) });
    h.volumes.set(REPLICA_VOL, 'exists');
    const res = fleetReplica.provisionFleetReplica(bot(), DSN, PEM, 'standby.invalid', 5440, false, { run: 7 });
    expect(res).toMatchObject({ success: true, started: true });
    await waitFor(() => !bot().fleetDbReplicaSeed || bot().fleetDbReplicaSeed?.parked === true);
    expect(bot().fleetDbReplicaSeed?.lastError).toBeUndefined();
    expect(wiped()).toBe(true);
  });

  it('still asks for a run that holds no consent', () => {
    writeRegistry({ ...master, fleetFailback: run(null) });
    h.volumes.set(REPLICA_VOL, 'exists');
    const res = fleetReplica.provisionFleetReplica(bot(), DSN, PEM, 'standby.invalid', 5440, false, { run: 7 });
    expect(res).toMatchObject({ success: false, needsConfirm: true, confirmVolume: REPLICA_VOL });
  });
});

describe('database dumps after the record is removed', () => {
  it('the dump listing and the removed-instance listing still answer after deleteBot', async () => {
    writeRegistry();
    const dumps = path.join(h.dir, 'backups', 'b1', 'fleet-postgres');
    fs.mkdirSync(dumps, { recursive: true });
    fs.writeFileSync(path.join(dumps, 'pre-decommission-1.dump'), 'x');
    await expect(containerManager.deleteBot('b1', false, false)).resolves.toBe(true);
    expect(registered()).toBe(false);
    const listed = await call('get', '/:id/fleet-backups', { params: { id: 'b1' } });
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ success: true, removed: true, backups: [{ file: 'pre-decommission-1.dump' }] });
    const folders = await call('get', '/fleet/orphan-backups', {});
    expect(folders.body).toMatchObject({ success: true, folders: [{ id: 'b1', dumps: 1, folder: 'backups/b1/fleet-postgres' }] });
    fs.rmSync(path.join(h.dir, 'backups'), { recursive: true, force: true });
  });

  it('answers 404 for an id with no record and no dumps, and for a path-like id', async () => {
    writeRegistry();
    expect((await call('get', '/:id/fleet-backups', { params: { id: 'nobody' } })).status).toBe(404);
    expect((await call('get', '/:id/fleet-backups', { params: { id: '..' } })).status).toBe(404);
    expect((await call('get', '/fleet/orphan-backups', {})).body).toMatchObject({ success: true, folders: [] });
  });

  it('lists nothing as removed while the registry cannot be read', async () => {
    const dumps = path.join(h.dir, 'backups', 'b1', 'fleet-postgres');
    fs.mkdirSync(dumps, { recursive: true });
    fs.writeFileSync(path.join(dumps, 'pre-decommission-1.dump'), 'x');
    fs.writeFileSync(registryPath, '{ torn');
    try {
      expect((await call('get', '/fleet/orphan-backups', {})).status).toBe(503);
      expect((await call('get', '/:id/fleet-backups', { params: { id: 'b1' } })).status).toBe(503);
    } finally {
      writeRegistry();
      fs.rmSync(path.join(h.dir, 'backups'), { recursive: true, force: true });
    }
  });
});

describe('a keep-data Remove of an instance whose copy a transfer or a promote holds', () => {
  const worker = { sourceType: 'git', sourceUrl: FLEET_URL, envVars: { BOT_NODE_ROLE: 'co-worker' }, fleetDbReplica: REPLICA };

  it('refuses while a transfer is parked at promoting', async () => {
    writeRegistry({ ...worker, fleetTransfer: { phase: 'promoting', startedAt: 1, updatedAt: 1, retireOldMaster: false, parked: true } });
    await expect(containerManager.deleteBot('b1', true, true)).rejects.toThrow(/app was promoting this copy/);
    expect(registered()).toBe(true);
  });

  it('refuses while a transfer is asking the app to promote the copy', async () => {
    writeRegistry(worker);
    let release!: () => void;
    const promoting = fleetReplica.whilePromoting('b1', () => new Promise<void>((r) => { release = r; }));
    try {
      await expect(containerManager.deleteBot('b1', true, true)).rejects.toThrow(/asking the app to promote this copy/);
      expect(registered()).toBe(true);
    } finally {
      release();
      await promoting;
    }
  });

  it('asks before removing over a promoted copy, and goes on once confirmed', async () => {
    writeRegistry(worker);
    h.inRecovery = 'f';
    const asked = await call('delete', '/:id', { params: { id: 'b1' }, query: { keepData: 'true', keepEnv: 'true' } });
    expect(asked.status).toBe(409);
    expect(asked.body).toMatchObject({ success: false, needsConfirm: true, confirmFlag: 'confirmPromoted' });
    expect(asked.body.error).toMatch(/promoted/);
    expect(registered()).toBe(true);
    await expect(containerManager.deleteBot('b1', true, true)).rejects.toThrow(/promoted/);
    expect(registered()).toBe(true);
    const confirmed = await call('delete', '/:id', { params: { id: 'b1' }, query: { keepData: 'true', keepEnv: 'true', confirmPromoted: 'true' } });
    expect(confirmed.body).toMatchObject({ success: true });
    expect(registered()).toBe(false);
  });

  it('refuses when the running copy cannot be read, naming the stop that works on a stopped instance', async () => {
    writeRegistry(worker);
    h.inRecovery = 'error';
    const err = await containerManager.deleteBot('b1', true, true, false, true).then(() => null, (e: Error) => e.message);
    expect(err).toMatch(/can't confirm/);
    expect(err).toContain(`docker stop ${REPLICA.containerName}`);
    expect(err).not.toMatch(/stop the instance/);
    expect(registered()).toBe(true);
  });

  it('refuses a keep-data Remove over a running copy with no database identity, saying so', async () => {
    const { user: _u, db: _d, ...bare } = REPLICA;
    writeRegistry({ ...worker, fleetDbReplica: bare });
    const err = await containerManager.deleteBot('b1', true, true, false, true).then(() => null, (e: Error) => e.message);
    expect(err).toMatch(/no database identity/);
    expect(err).not.toMatch(/did not answer/);
    expect(registered()).toBe(true);
  });

  it('dbm sends the promoted-copy confirm', async () => {
    let seen = '';
    const client = { request: async (_m: string, p: string) => { seen = p; return { ok: true, status: 200, body: { success: true } }; } };
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as any);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as any);
    try {
      await dispatch(client as any, ['bots', 'delete', 'b1'], { 'confirm-promoted': true }).catch(() => {});
    } finally {
      exit.mockRestore();
      out.mockRestore();
    }
    expect(seen).toMatch(/confirmPromoted=true/);
  });
});
