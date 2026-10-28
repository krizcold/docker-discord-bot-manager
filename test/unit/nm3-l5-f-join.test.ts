import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm3-l5f-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir, marks: [] as string[], envWriteFail: '', fault: '' as string,
    execCalls: [] as { cmd: string; args: string[]; opts: unknown }[],
    joinWrites: [] as any[],
  };
});

vi.mock('child_process', async (importOriginal) => {
  const mod = (await import('./join-fake')).childProcessMock(await importOriginal<typeof import('child_process')>()) as any;
  const inner = mod.execFile;
  const execFile = (cmd: string, args: string[], opts: unknown, cb?: unknown) => {
    h.execCalls.push({ cmd, args, opts: typeof opts === 'function' ? undefined : opts });
    return inner(cmd || 'docker', args, opts, cb);
  };
  return { ...mod, execFile, default: { ...mod.default, execFile } };
});
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/env/manager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/env/manager')>();
  return {
    ...real,
    setEnvVars: (id: string, vars: Record<string, string>) => {
      if (h.envWriteFail) throw new Error(h.envWriteFail);
      return real.setEnvVars(id, vars);
    },
  };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return {
    ...real,
    registryFault: () => h.fault || real.registryFault(),
    markPendingApplyIfRunning: async (id: string) => { h.marks.push(id); },
    updateInstanceFleetJoin: (id: string, join: any) => {
      h.joinWrites.push(join);
      return real.updateInstanceFleetJoin(id, join);
    },
  };
});

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { certSource, joinFleet, machineNameOf, readCopyCert, readCopyFacts, refreshJoin, registerOwnCopy, resolveStoredJoinCode } from '../../src/instance/fleetJoin';
import { COPY_FP, COPY_PEM, docker, fakeJoinCode, fakeJoinRecord, FIXTURE_FP, FIXTURE_PEM, resetDocker } from './join-fake';

const SMDB = 'https://example.invalid/fake/super-modular-discord-bot';
const REGISTRY = path.join(h.dir, 'instances.json');
const base = (over: Record<string, unknown> = {}) => ({
  id: 'b', sanitizedName: 'b', displayName: 'B', titleName: 'B', status: 'running', sourceType: 'git', sourceUrl: SMDB,
  envVars: { DATA_BACKEND: 'postgres' }, createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', ...over,
});
const REPLICA = {
  containerName: 'b-fleet-postgres-replica', volume: 'b-fleet-postgres-replica-data', slot: 'fleet_standby_b',
  primaryHost: 'main.invalid', primaryPort: 15432, publicHost: 'copy.invalid', hostPort: 15433, certHost: 'copy.invalid',
  user: 'smdb', db: 'smdb', seededAt: 1,
};
const writeRegistry = (over: Record<string, unknown> = {}) =>
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { b: base(over) } }, null, 2));
const bot = () => containerManager.getBot('b')!;
const certDir = path.join(h.dir, 'bots', 'b', 'data', 'db-certs');
const envUrl = () => envManager.getEnvVars('b').DATA_BACKEND_URL;
const realFetch = certSource.fetch;
const MAIN_URL = `postgresql://smdb:app%2Cpa%25ss@main.invalid:15432/smdb?sslmode=verify-full&sslrootcert=/data/db-certs/${FIXTURE_FP.slice(0, 16)}.crt`;
const JOINED = 'Joined the main at main.invalid:15432. The bot uses the 1 database address(es) from its next start (Apply on the card, or Restart).';
const FOLLOWS = (h2: string, p: number) => ` The copy on this machine still follows ${h2}:${p}; press Re-seed to rebuild it from main.invalid:15432.`;
let warn: ReturnType<typeof vi.spyOn>;
const fleetWarns = () => warn.mock.calls.map((c: unknown[]) => String(c[0])).filter((s: string) => s.startsWith('[FleetCopy]'));

beforeEach(() => {
  resetDocker();
  h.marks = []; h.envWriteFail = ''; h.fault = ''; h.execCalls = []; h.joinWrites = [];
  certSource.fetch = async () => ({ ok: true, pem: FIXTURE_PEM, fp: FIXTURE_FP });
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', 'b', 'env'), { recursive: true });
  writeRegistry();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { warn.mockRestore(); });
afterAll(() => {
  certSource.fetch = realFetch;
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('readCopyFacts and readCopyCert', () => {
  const rec = { containerName: 'b-fleet-postgres-replica', user: 'smdb', db: 'smdb' };
  it('an unreadable answer names the copy', async () => {
    docker.copy = 'maybe|streaming|x|1|0/1';
    expect(await readCopyFacts(rec)).toEqual({ ok: false, reason: "the copy's database did not answer" });
  });
  it('a copy out of recovery reads inRecovery false', async () => {
    docker.copy = 'false||7001|1|0/4000000';
    const r = await readCopyFacts(rec);
    expect(r.ok && r.facts.inRecovery).toBe(false);
  });
  it('reads the certificate with docker exec under the read timeout', async () => {
    expect(await readCopyCert('b-fleet-postgres-replica')).toBe(COPY_PEM.trim());
    const call = h.execCalls.find(c => c.args.includes('cat'))!;
    expect(call.cmd).toBe('docker');
    expect(call.opts).toEqual({ timeout: 30_000 });
  });
  it('machineNameOf an instance with no name is unnamed', () => {
    expect(machineNameOf(base({ displayName: '' }) as any)).toBe('unnamed');
  });
});

describe('join admission', () => {
  const replication = (over: Record<string, unknown>) => writeRegistry({ fleetDb: { containerName: 'b-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'v', replication: { role: 'replicator', password: 'x', hostPort: 15432, publicHost: 'main.invalid', certHost: 'main.invalid', ...over } } });
  const HOLDS = 'This instance holds the main database itself, so it cannot join another one.';
  it('another host on the same port is not its own database', async () => {
    replication({ publicHost: 'else.invalid' });
    expect(await joinFleet(bot(), fakeJoinCode())).toEqual({ success: false, error: HOLDS });
  });
  it('a main with no public host is not its own database', async () => {
    replication({ publicHost: undefined });
    expect(await joinFleet(bot(), fakeJoinCode())).toEqual({ success: false, error: HOLDS });
  });
  it('the same host on another port is not its own database', async () => {
    replication({ hostPort: 15999 });
    expect(await joinFleet(bot(), fakeJoinCode())).toEqual({ success: false, error: HOLDS });
  });
  it('a Data Backend with spaces around postgres admits', async () => {
    writeRegistry({ envVars: { DATA_BACKEND: ' postgres ' } });
    expect(await joinFleet(bot(), fakeJoinCode())).toEqual({ success: true, message: JOINED, addressCount: 1 });
  });
  it('a broken registry refuses with its fault', async () => {
    h.fault = 'registry broken';
    expect(await joinFleet(bot(), fakeJoinCode())).toEqual({ success: false, error: 'registry broken' });
  });
  it('a cleared copy is not read', async () => {
    writeRegistry({ fleetDbReplica: { ...REPLICA, copyCleared: true } });
    docker.copy = null;
    expect(await joinFleet(bot(), fakeJoinCode())).toEqual({ success: true, message: JOINED, addressCount: 1 });
  });
  it('a code with whitespace inside joins', async () => {
    const c = fakeJoinCode();
    expect((await joinFleet(bot(), `${c.slice(0, 20)} \n ${c.slice(20)}`)).success).toBe(true);
  });
  it('no companion is refused before the op lock', async () => {
    writeRegistry({ sourceUrl: 'https://example.invalid/other' });
    let release!: () => void;
    const held = containerManager.withExternalBotOp('b', 'x', () => new Promise<void>(r => { release = r; }));
    expect(await joinFleet(bot(), fakeJoinCode())).toEqual({ success: false, error: 'This app declares no managed database companion' });
    release();
    await held;
  });
  it('the join runs under the fleet-join op', async () => {
    let seen: string | null = null;
    certSource.fetch = async () => { seen = containerManager.isBotBusy('b'); return { ok: true, pem: FIXTURE_PEM, fp: FIXTURE_FP }; };
    await joinFleet(bot(), fakeJoinCode());
    expect(seen).toBe('fleet-join');
  });
  it('an instance missing from the registry is not found', async () => {
    expect(await joinFleet(base({ id: 'zz' }) as any, fakeJoinCode())).toEqual({ success: false, error: 'Bot not found' });
  });
});

describe('the join record', () => {
  const kept = [{ host: 'kept.invalid', port: 15434, slot: 'fleet_standby_k', cert: COPY_PEM, machine: 'k' }];
  it('the same code keeps its first join time', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord() });
    await joinFleet(bot(), fakeJoinCode());
    expect(bot().fleetJoin?.joinedAt).toBe('2026-10-20T00:00:00.000Z');
  });
  it('another code takes a new join time', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord({}, { repl: { user: 'replicator', password: 'older' } }) });
    await joinFleet(bot(), fakeJoinCode());
    expect(bot().fleetJoin?.joinedAt).not.toBe('2026-10-20T00:00:00.000Z');
  });
  it('a failed read with a prior on another port keeps nothing and sets no read time', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord({ addresses: kept }, { port: 15999 }) });
    docker.addressFail = 'ERROR: x';
    await joinFleet(bot(), fakeJoinCode());
    expect(bot().fleetJoin?.addresses).toEqual([]);
    expect('addressesReadAt' in h.joinWrites[h.joinWrites.length - 1]).toBe(false);
  });
  it('a failed read with a prior of another system id keeps nothing', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord({ addresses: kept, systemId: '9999' }, { repl: { user: 'replicator', password: 'older' } }) });
    docker.addressFail = 'ERROR: x';
    await joinFleet(bot(), fakeJoinCode());
    expect(bot().fleetJoin?.addresses).toEqual([]);
  });
});

describe('the copy after a join', () => {
  it('a cleared copy registers nothing and logs nothing', async () => {
    writeRegistry({ fleetDbReplica: { ...REPLICA, copyCleared: true } });
    await joinFleet(bot(), fakeJoinCode());
    expect(fleetWarns()).toEqual([]);
  });
  it('an unseeded copy registers nothing and logs nothing', async () => {
    const { seededAt: _s, ...rest } = REPLICA;
    writeRegistry({ fleetDbReplica: rest });
    await joinFleet(bot(), fakeJoinCode());
    expect(fleetWarns()).toEqual([]);
    expect(docker.events).not.toContain('register');
  });
  it('a registered copy logs nothing', async () => {
    writeRegistry({ fleetDbReplica: REPLICA });
    await joinFleet(bot(), fakeJoinCode());
    expect(docker.events).toContain('register');
    expect(fleetWarns()).toEqual([]);
  });
  it.each([
    ['the same address', 'main.invalid', 15432, ''],
    ['another host', 'old.invalid', 15432, FOLLOWS('old.invalid', 15432)],
    ['another port', 'main.invalid', 15000, FOLLOWS('main.invalid', 15000)],
  ])('a copy that follows %s', async (_n, host, port, tail) => {
    writeRegistry({ fleetDbReplica: { ...REPLICA, primaryHost: host, primaryPort: port } });
    const r = await joinFleet(bot(), fakeJoinCode());
    expect(r).toEqual({ success: true, message: JOINED.replace(' 1 database', ' 2 database') + tail, addressCount: 2 });
  });
});

describe('resolveStoredJoinCode', () => {
  const emitted: string[] = [];
  const emit = (m: string) => { emitted.push(m); };
  beforeEach(() => { emitted.length = 0; });
  it('a stored code with whitespace inside is joined', async () => {
    const c = fakeJoinCode();
    envManager.setEnvVars('b', { DATA_BACKEND_URL: `${c.slice(0, 20)}\n${c.slice(20)}` });
    expect(await resolveStoredJoinCode(bot(), emit)).toBeNull();
    expect(envUrl()).toBe(MAIN_URL);
  });
  it('the joined code writes the list without a join or a mark', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord() });
    envManager.setEnvVars('b', { DATA_BACKEND_URL: fakeJoinCode() });
    expect(await resolveStoredJoinCode(bot(), emit)).toBeNull();
    expect(emitted).toEqual([]);
    expect(envUrl()).toBe(MAIN_URL);
    expect(h.marks).toEqual([]);
  });
  it('the joined code with a refused env write names it', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord() });
    envManager.setEnvVars('b', { DATA_BACKEND_URL: fakeJoinCode() });
    h.envWriteFail = 'EROFS';
    expect(await resolveStoredJoinCode(bot(), emit)).toBe('The join code in the Database URL could not be used: The join code is saved, but the Database URL could not be written (EROFS).');
  });
});

describe('registerOwnCopy', () => {
  it('no stored code', async () => {
    writeRegistry({ fleetDbReplica: REPLICA });
    expect(await registerOwnCopy(bot())).toBe('the stored join code cannot be read');
  });
  it('a cleared copy has no row', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord(), fleetDbReplica: { ...REPLICA, copyCleared: true } });
    expect(await registerOwnCopy(bot(), FIXTURE_PEM)).toBe("the copy's certificate could not be read");
    expect(docker.events).not.toContain('register');
  });
  it('an unseeded copy has no row', async () => {
    const { seededAt: _s, ...rest } = REPLICA;
    writeRegistry({ fleetJoin: fakeJoinRecord(), fleetDbReplica: rest });
    expect(await registerOwnCopy(bot(), FIXTURE_PEM)).toBe("the copy's certificate could not be read");
  });
  it('an unreadable copy certificate', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord(), fleetDbReplica: REPLICA });
    docker.copyCert = null;
    expect(await registerOwnCopy(bot(), FIXTURE_PEM)).toBe("the copy's certificate could not be read");
  });
  it('a given main certificate is not fetched again', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord(), fleetDbReplica: REPLICA });
    certSource.fetch = async () => ({ ok: false, reason: 'down' });
    expect(await registerOwnCopy(bot(), FIXTURE_PEM)).toBeNull();
    expect(docker.events).toContain('register');
  });
});

describe('refreshJoin', () => {
  it('a code replaced during the read is not given the error', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord() });
    const start = bot();
    certSource.fetch = async () => {
      writeRegistry({ fleetJoin: fakeJoinRecord({}, { repl: { user: 'replicator', password: 'newer' } }) });
      return { ok: false, reason: 'down' };
    };
    await refreshJoin(start);
    expect(bot().fleetJoin?.addressesError).toBeUndefined();
  });
  it('an unread list is recorded', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord() });
    docker.addressFail = 'ERROR: x';
    await refreshJoin(bot());
    expect(bot().fleetJoin?.addressesError).toBe('The list of the other databases could not be read from the main (ERROR: x); the manager tries again every hour.');
  });
  it('registers the copy and logs nothing when it is added', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord(), fleetDbReplica: REPLICA });
    await refreshJoin(bot());
    expect(docker.events).toContain('register');
    expect(fleetWarns()).toEqual([]);
  });
  it('a refused registration is logged', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord(), fleetDbReplica: REPLICA });
    docker.registerFail = 'ERROR: denied';
    await refreshJoin(bot());
    expect(fleetWarns()).toEqual(["[FleetCopy] B: the copy's address could not be added to the main's list: ERROR: denied"]);
  });
  it('writes the main and listed certificates, and fills a missing system id', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord({ systemId: undefined }) });
    docker.addresses = [{ host: 'other.invalid', port: 15434, slot: 'fleet_standby_x', cert: COPY_PEM, machine: 'other' }];
    await refreshJoin(bot());
    expect(fs.readdirSync(certDir).sort()).toEqual([`${COPY_FP.slice(0, 16)}.crt`, `${FIXTURE_FP.slice(0, 16)}.crt`].sort());
    expect(bot().fleetJoin?.systemId).toBe('7001');
  });
});
