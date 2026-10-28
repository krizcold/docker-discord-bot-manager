import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm3-join-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, marks: [] as string[], markFail: '', joinWriteFail: '', envWriteFail: '', corrupt: false };
});

vi.mock('child_process', async (importOriginal) => (await import('./join-fake')).childProcessMock(await importOriginal<typeof import('child_process')>()));
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
    getEnvVarsWithStatus: (id: string) => (h.corrupt ? { vars: {}, undecryptable: [], encrypted: [], corrupt: true } : real.getEnvVarsWithStatus(id)),
  };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return {
    ...real,
    markPendingApplyIfRunning: async (id: string) => {
      if (h.markFail) throw new Error(h.markFail);
      h.marks.push(id);
    },
    updateInstanceFleetJoin: (id: string, join: any) => {
      if (h.joinWriteFail) throw new Error(h.joinWriteFail);
      return real.updateInstanceFleetJoin(id, join);
    },
  };
});

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { certSource, joinFleet, resolveStoredJoinCode } from '../../src/instance/fleetJoin';
import { createBotRoutes } from '../../src/webui/routes/bots';
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
const writeRegistry = (over: Record<string, unknown> = {}, more: Record<string, unknown> = {}) =>
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { b: base(over), ...more } }, null, 2));
const bot = () => containerManager.getBot('b')!;
const certDir = path.join(h.dir, 'bots', 'b', 'data', 'db-certs');
const envUrl = () => envManager.getEnvVars('b').DATA_BACKEND_URL;
/** Everything a refused join must leave as it was: the registry file, the env store and the certificate files. */
const snapshot = () => JSON.stringify({
  registry: fs.readFileSync(REGISTRY, 'utf-8'),
  env: envManager.getEnvVars('b'),
  certs: fs.existsSync(certDir) ? fs.readdirSync(certDir) : null,
});
const realFetch = certSource.fetch;

beforeEach(() => {
  resetDocker();
  h.marks = []; h.markFail = ''; h.joinWriteFail = ''; h.envWriteFail = ''; h.corrupt = false;
  certSource.fetch = async () => ({ ok: true, pem: FIXTURE_PEM, fp: FIXTURE_FP });
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', 'b', 'env'), { recursive: true });
  writeRegistry();
});
afterAll(() => {
  certSource.fetch = realFetch;
  fs.rmSync(h.dir, { recursive: true, force: true });
});

const MAIN_URL = `postgresql://smdb:app%2Cpa%25ss@main.invalid:15432/smdb?sslmode=verify-full&sslrootcert=/data/db-certs/${FIXTURE_FP.slice(0, 16)}.crt`;

describe('O3: a join that succeeds', () => {
  it('writes the record, the certificate files and the list, and marks the running bot (T-25)', async () => {
    docker.addresses = [{ host: 'other.invalid', port: 15434, slot: 'fleet_standby_x', cert: COPY_PEM, machine: 'other' }];
    const r = await joinFleet(bot(), fakeJoinCode());
    expect(r).toEqual({ success: true, message: 'Joined the main at main.invalid:15432. The bot uses the 2 database address(es) from its next start (Apply on the card, or Restart).', addressCount: 2 });
    expect(envUrl()).toBe(`${MAIN_URL},postgresql://smdb:app%2Cpa%25ss@other.invalid:15434/smdb?sslmode=verify-full&sslrootcert=/data/db-certs/${COPY_FP.slice(0, 16)}.crt`);
    expect(bot().fleetJoin).toMatchObject({ host: 'main.invalid', port: 15432, fp: FIXTURE_FP, systemId: '7001', addresses: [expect.objectContaining({ host: 'other.invalid' })] });
    expect(fs.readdirSync(certDir).sort()).toEqual([`${COPY_FP.slice(0, 16)}.crt`, `${FIXTURE_FP.slice(0, 16)}.crt`].sort());
    expect(h.marks).toEqual(['b']);
    expect(docker.events).toEqual(expect.arrayContaining(['image', 'main-probe', 'address-read']));
  });

  it('C34: the same code again changes nothing and marks nothing', async () => {
    await joinFleet(bot(), fakeJoinCode());
    const before = envUrl();
    h.marks = [];
    const r = await joinFleet(bot(), fakeJoinCode());
    expect(r.success).toBe(true);
    expect(envUrl()).toBe(before);
    expect(h.marks).toEqual([]);
  });

  it('C28: another code replaces the record and the list', async () => {
    await joinFleet(bot(), fakeJoinCode());
    const r = await joinFleet(bot(), fakeJoinCode({ host: 'main2.invalid', port: 15440 }));
    expect(r.success).toBe(true);
    expect(bot().fleetJoin).toMatchObject({ host: 'main2.invalid', port: 15440 });
    expect(envUrl()).toContain('@main2.invalid:15440/');
  });

  it('C23: an unread address list still joins with the main alone, and says so (T-21)', async () => {
    docker.addressFail = 'ERROR:  relation "smdb_manager.addresses" does not exist';
    const r = await joinFleet(bot(), fakeJoinCode());
    expect(r.success).toBe(true);
    if (r.success) expect(r.message).toContain('The list of the other databases could not be read from the main (ERROR:  relation "smdb_manager.addresses" does not exist); the manager tries again every hour.');
    expect(bot().fleetJoin?.addressesError).toMatch(/could not be read from the main/);
    expect(envUrl()).toBe(MAIN_URL);
  });

  it('T-26: a copy here that follows another address is named', async () => {
    writeRegistry({ fleetDbReplica: { ...REPLICA, primaryHost: 'old.invalid', primaryPort: 15000 } });
    const r = await joinFleet(bot(), fakeJoinCode());
    expect(r.success).toBe(true);
    if (r.success) expect(r.message).toContain(' The copy on this machine still follows old.invalid:15000; press Re-seed to rebuild it from main.invalid:15432.');
    expect(envUrl()!.split(',')[0]).toBe('postgresql://smdb:app%2Cpa%25ss@b-fleet-postgres-replica:5432/smdb?sslmode=no-verify');
  });

  it('C31: a refused Apply mark still succeeds and names the restart (T-27)', async () => {
    h.markFail = 'EACCES';
    const r = await joinFleet(bot(), fakeJoinCode());
    expect(r.success).toBe(true);
    if (r.success) expect(r.message).toContain(' The manager could not record that the bot must be recreated (EACCES); Restart the instance so the bot uses them.');
  });
});

describe('O3: every refused phase changes nothing (C15 to C29)', () => {
  it.each([
    ['C15 not a code', () => {}, 'postgresql://a:b@c/d', 'This is not a join code: it does not start with smdbjoin1.'],
    ['C17 the instance holds the main', () => writeRegistry({ fleetDb: { containerName: 'b-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'v' } }), fakeJoinCode(), 'This instance holds the main database itself, so it cannot join another one.'],
    ['C17 its own main', () => writeRegistry({ fleetDb: { containerName: 'b-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'v', replication: { role: 'replicator', password: 'x', hostPort: 15432, publicHost: 'main.invalid', certHost: 'main.invalid' } } }), fakeJoinCode(), "That join code is this instance's own database."],
    ['C17 data in JSON files', () => writeRegistry({ envVars: { DATA_BACKEND: 'file' } }), fakeJoinCode(), 'This bot keeps its data in JSON files (Data Backend is file). Set Data Backend to postgres in the env editor first; a bot that already holds data in JSON files moves it with the JSON-to-Postgres migration instead.'],
    ['C17 no companion database', () => writeRegistry({ sourceUrl: 'https://example.invalid/other' }), fakeJoinCode(), 'This app declares no managed database companion'],
    ['C17 the env store unreadable', () => { h.corrupt = true; }, fakeJoinCode(), 'The env store for this instance cannot be read (a copy is kept beside it as storage.json.corrupt-<time> when it could be read); restore it before joining'],
    ['C19 unreachable (T-15)', () => { certSource.fetch = async () => ({ ok: false, reason: 'connect ECONNREFUSED' }); }, fakeJoinCode(), "Can't reach the main at main.invalid:15432 (connect ECONNREFUSED); nothing was changed. The main's machine must accept connections on that port. A machine that cannot open a port can be the main only when it runs alone."],
    ['C19 another certificate (T-16)', () => { certSource.fetch = async () => ({ ok: true, pem: COPY_PEM, fp: COPY_FP }); }, fakeJoinCode(), `The database at main.invalid:15432 shows a certificate with fingerprint ${COPY_FP.slice(0, 16)}..., not the ${FIXTURE_FP.slice(0, 16)}... in the join code, so the manager did not trust it; nothing was changed. Copy a new join code from the main's manager. If the main's certificate did not change, something else answers at that address.`],
    ['C20 the image pull fails', () => { docker.imagePresent = false; docker.pullFail = 'toomanyrequests: rate limit'; }, fakeJoinCode(), 'could not pull postgres:16-alpine: toomanyrequests: rate limit'],
    ['C21 the login is refused (T-17)', () => { docker.main.fail = 'psql: error: FATAL:  password authentication failed for user "replicator"'; }, fakeJoinCode(), 'The main at main.invalid:15432 refused the join code\'s login (FATAL:  password authentication failed for user "replicator"); nothing was changed. Replication may have been disabled there, or its password changed: copy a new join code from the main\'s manager.'],
    ['C21 the main follows another (T-18)', () => { docker.main.inRecovery = true; }, fakeJoinCode(), 'The database at main.invalid:15432 follows another database itself, so it cannot be joined; copy the join code from the manager of the machine that holds the main database.'],
    ['C22 a copy of another database (T-19)', () => { writeRegistry({ fleetDbReplica: REPLICA }); docker.copy = 'true|streaming|9999|1|0/1'; }, fakeJoinCode(), 'This join code is for a different database (system id 7001) from the copy on this machine (system id 9999); nothing was changed. Remove the copy first to follow that database.'],
    ['C22 a copy that does not answer (T-20)', () => { writeRegistry({ fleetDbReplica: REPLICA }); docker.copy = null; }, fakeJoinCode(), "The copy on this machine did not answer, so the manager can't confirm it belongs to the database in this join code; nothing was changed. Start the instance and try again."],
    ['C26 the record write is refused (T-23)', () => { h.joinWriteFail = 'ENOSPC'; }, fakeJoinCode(), 'The join code could not be saved (ENOSPC); the database addresses were not changed.'],
  ])('%s', async (_n, arrange, code, error) => {
    arrange();
    const certsBefore = snapshot();
    const r = await joinFleet(bot(), code as string);
    expect(r).toEqual({ success: false, error });
    const after = JSON.parse(snapshot());
    const before = JSON.parse(certsBefore);
    expect(after.registry).toBe(before.registry);
    expect(after.env).toEqual(before.env);
    if (!error.startsWith('The join code could not be saved')) expect(after.certs).toEqual(before.certs);
  });

  it('C24: certificate files that cannot be written give T-22, and nothing else changes', async () => {
    fs.mkdirSync(path.join(h.dir, 'bots', 'b', 'data'), { recursive: true });
    fs.writeFileSync(certDir, 'a file where the folder goes');
    const before = fs.readFileSync(REGISTRY, 'utf-8');
    const r = await joinFleet(bot(), fakeJoinCode());
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/^The certificate files could not be written to .*db-certs \(.*\); nothing else was changed\.$/);
    expect(fs.readFileSync(REGISTRY, 'utf-8')).toBe(before);
  });

  it('C29: a refused env write keeps the record and says the watcher writes it (T-24)', async () => {
    h.envWriteFail = 'EROFS';
    const r = await joinFleet(bot(), fakeJoinCode());
    expect(r).toEqual({ success: false, error: 'The join code is saved, but the Database URL could not be written (EROFS). The manager writes it again within 5 minutes; press Join again to try now.' });
    expect(bot().fleetJoin?.host).toBe('main.invalid');
  });

  it('C18: a second join while an operation runs is refused by the op lock', async () => {
    let release!: () => void;
    const held = containerManager.withExternalBotOp('b', 'fleet-join', () => new Promise<void>(r => { release = r; }));
    const r = await joinFleet(bot(), fakeJoinCode());
    expect(r).toEqual({ success: false, error: "Operation 'fleet-join' is running on this instance; wait for it to finish" });
    release();
    await held;
  });
});

describe('O4: a join code in the Database URL is joined by the build', () => {
  const emitted: string[] = [];
  const emit = (m: string) => { emitted.push(m); };
  beforeEach(() => { emitted.length = 0; });

  it('C37: converts the code into the list and logs it', async () => {
    envManager.setEnvVars('b', { DATA_BACKEND_URL: fakeJoinCode() });
    expect(await resolveStoredJoinCode(bot(), emit)).toBeNull();
    expect(envUrl()).toBe(MAIN_URL);
    expect(emitted).toEqual(['[Fleet] Checking the join code in the Database URL...', '[Fleet] Joined the main at main.invalid:15432; the Database URL now lists 1 database address(es)']);
    expect(h.marks).toEqual([]);
  });

  it('C35: a code that cannot be used ends the build with the reason and changes nothing', async () => {
    envManager.setEnvVars('b', { DATA_BACKEND_URL: fakeJoinCode() });
    docker.main.inRecovery = true;
    const error = await resolveStoredJoinCode(bot(), emit);
    expect(error).toBe('The join code in the Database URL could not be used: The database at main.invalid:15432 follows another database itself, so it cannot be joined; copy the join code from the manager of the machine that holds the main database.');
    expect(emitted[1]).toBe(`[Error] ${error}`);
    expect(envUrl()).toBe(fakeJoinCode());
    expect(bot().fleetJoin).toBeUndefined();
  });

  it('a URL or a list is left alone', async () => {
    envManager.setEnvVars('b', { DATA_BACKEND_URL: 'postgresql://a:b@c:5432/d' });
    expect(await resolveStoredJoinCode(bot(), emit)).toBeNull();
    expect(emitted).toEqual([]);
  });

  it('C38: every other lane refuses a stored code at mergedEnvVars (T-28)', () => {
    envManager.setEnvVars('b', { DATA_BACKEND_URL: fakeJoinCode() });
    expect(() => containerManager.mergedEnvVars(bot())).toThrow('The Database URL of B holds a join code the manager has not checked yet. Build the instance, or paste the code into Join in its Database window.');
  });

  it('ensureFleetDataBackend mints no database for a list or a code', () => {
    envManager.setEnvVars('b', { DATA_BACKEND_URL: `${MAIN_URL},postgresql://x:y@z:1/smdb` });
    expect(containerManager.ensureFleetDataBackend(bot())).toBeNull();
    writeRegistry({ fleetJoin: fakeJoinRecord() });
    envManager.setEnvVars('b', { DATA_BACKEND_URL: MAIN_URL });
    expect(containerManager.ensureFleetDataBackend(bot())).toBeNull();
    expect(bot().fleetDb).toBeUndefined();
  });
});

describe('the stored code is a record secret', () => {
  it('is encrypted at rest, blank in a browser copy, and its passwords are scrubbed', async () => {
    await joinFleet(bot(), fakeJoinCode());
    const raw = JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')).instances.b.fleetJoin;
    expect(raw.code).toMatch(/^v2:/);
    expect(bot().fleetJoin?.code).toBe(fakeJoinCode());
    expect(containerManager.withoutRecordSecrets(bot())!.fleetJoin?.code).toBe('');
    const secrets = containerManager.recordSecrets(bot());
    expect(secrets).toEqual(expect.arrayContaining([fakeJoinCode(), 'replpass', 'app,pa%ss']));
  });

  it('a code that no longer decrypts reads blank, and its ciphertext survives a save', () => {
    writeRegistry({ fleetJoin: fakeJoinRecord({ code: 'v2:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }) });
    expect(bot().fleetJoin?.code).toBe('');
    containerManager.updateInstanceFleetJoin('b', { ...bot().fleetJoin!, addressesError: 'x' });
    expect(JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')).instances.b.fleetJoin.code).toBe('v2:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  });
});

describe('routes', () => {
  const router = createBotRoutes({ clients: new Set() } as any);
  const call = async (method: 'get' | 'post', routePath: string, body: unknown = {}): Promise<{ status: number; body: any }> => {
    const layer = (router as any).stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
    const res: any = { statusCode: 200 };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    await layer.route.stack[layer.route.stack.length - 1].handle({ params: { id: 'b' }, query: {}, body }, res);
    return { status: res.statusCode, body: res.body };
  };

  it('POST /fleet-join needs a code and answers the join', async () => {
    expect(await call('post', '/:id/fleet-join', {})).toEqual({ status: 400, body: { success: false, error: 'joinCode is required' } });
    const r = await call('post', '/:id/fleet-join', { joinCode: fakeJoinCode() });
    expect(r.body).toMatchObject({ success: true, addressCount: 1 });
  });

  it('validate-db refuses a list (T-47)', async () => {
    const r = await call('post', '/:id/validate-db', { url: `${MAIN_URL},postgresql://x:y@z:1/smdb` });
    expect(r.body).toEqual({ success: true, ok: false, notTested: true, error: 'This value is a list of database addresses the manager writes from a join code; check them in the Database window.' });
  });

  it('GET /fleet-replica carries the join and the rebuild data', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord({ addressesError: 'boom' }) });
    const r = await call('get', '/:id/fleet-replica');
    expect(r.body.join).toEqual({ host: 'main.invalid', port: 15432, machine: 'main.invalid', joinedAt: '2026-10-20T00:00:00.000Z', addressCount: 0, addressesReadAt: expect.any(Number), addressesError: 'boom', codeUnreadable: false });
    expect(r.body.rebuild).toBeNull();
  });
});

describe('N6: a join on a machine that holds a live copy adds the copy to the main\'s list', () => {
  it('registers the copy at the end of the join', async () => {
    writeRegistry({ fleetDbReplica: REPLICA });
    const r = await joinFleet(bot(), fakeJoinCode());
    expect(r.success).toBe(true);
    expect(docker.events).toContain('register');
  });

  it('a refused registration is logged, and the join still succeeds', async () => {
    writeRegistry({ fleetDbReplica: REPLICA });
    docker.registerFail = 'ERROR:  permission denied for table addresses';
    const warn = vi.spyOn(console, 'warn');
    const r = await joinFleet(bot(), fakeJoinCode());
    expect(r.success).toBe(true);
    expect(warn.mock.calls.map(c => c[0])).toContain("[FleetCopy] B: the copy's address could not be added to the main's list: ERROR:  permission denied for table addresses");
    warn.mockRestore();
  });

  it('a machine without a copy registers nothing', async () => {
    await joinFleet(bot(), fakeJoinCode());
    expect(docker.events).not.toContain('register');
  });
});

describe('F9: a join whose address read fails', () => {
  const kept = [{ host: 'kept.invalid', port: 15434, slot: 'fleet_standby_k', cert: COPY_PEM, machine: 'k' }];
  const T0 = Date.now() - 600_000;

  it('the same code keeps the known addresses and their read time (C34, C54)', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord({ addresses: kept, addressesReadAt: T0 }) });
    docker.addressFail = 'ERROR: x';
    const r = await joinFleet(bot(), fakeJoinCode());
    expect(r.success).toBe(true);
    expect(bot().fleetJoin?.addresses).toEqual(kept);
    expect(bot().fleetJoin?.addressesReadAt).toBe(T0);
    expect(envUrl()).toContain('@kept.invalid:15434/');
  });

  it('a new code for the same main keeps them too', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord({ addresses: kept, addressesReadAt: T0 }, { repl: { user: 'replicator', password: 'older' } }) });
    docker.addressFail = 'ERROR: x';
    const r = await joinFleet(bot(), fakeJoinCode());
    expect(r.success).toBe(true);
    expect(bot().fleetJoin?.addresses).toEqual(kept);
    expect(bot().fleetJoin?.addressesReadAt).toBe(T0);
  });

  it('a code for another main joins with the main alone and leaves the read time unset, so the next check reads again (C23, C28)', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord({ addresses: kept, addressesReadAt: T0 }, { host: 'old.invalid' }) });
    docker.addressFail = 'ERROR: x';
    const r = await joinFleet(bot(), fakeJoinCode());
    expect(r.success).toBe(true);
    expect(bot().fleetJoin?.addresses).toEqual([]);
    expect(bot().fleetJoin?.addressesReadAt).toBeUndefined();
    expect(envUrl()).toBe(MAIN_URL);
  });
});
