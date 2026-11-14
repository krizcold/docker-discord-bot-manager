import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NM20 part 3: where provisionRoles runs (the start, the start lane, the maintenance check, Enable, the join code) and
// fleetReplication's statements by login. docker is a fake that answers psql by its SQL and records the login; the
// real provisionRoles runs over it, so each row picks the roles read the cluster answers.
type Answer = string | { err: string };
const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm20-code3-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    shell: [] as string[],
    psql: [] as Array<{ login: string; db: string; sql: string; pins: boolean; stdin: boolean }>,
    other: [] as string[],
    events: [] as string[],
    notReady: false,
    running: 'true',
    roles: [] as Array<string | { err: string }>,
    fail: (_p: { login: string; db: string; sql: string }): string | undefined => undefined,
    reply: (_p: { login: string; db: string; sql: string }): string | undefined => undefined,
    env: { DATABASE_URL: '' } as Record<string, string>,
    saveFails: '',
  };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return {
    ...real,
    updateInstanceFleetDbPassword: (botId: string, password: string) => {
      if (h.saveFails) throw new Error(h.saveFails);
      return real.updateInstanceFleetDbPassword(botId, password);
    },
  };
});

// The roles read of a set-up cluster, in rolesReadSql's field order (recovery, bot rights, bot is oid 10, owner, ...).
const SET_UP_READ = 'false|false|false|true|false|true|ok|ok|ok|ok|ok|ok|4';
const line = (over: Record<number, string>) => SET_UP_READ.split('|').map((f, i) => over[i] ?? f).join('|');
const RECOVERY = line({ 0: 'true' });
const BOT_FIRST = line({ 2: 'true' });
const NO_DB = line({ 3: 'nodb' });
const ADMIN_PW = line({ 4: 'true' });
const NO_ADMIN_PATH = line({ 5: 'false' });
const BOT_MISSING = line({ 1: 'missing', 3: 'other' });
const LOW_RESERVED = line({ 12: '3' });

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const { FIXTURE_PEM } = await import('./join-fake');
  const answer = (args: string[], stdin: string | undefined): { code: number; out: string; err: string } => {
    const i = args.indexOf('psql');
    if (i < 0) {
      h.other.push(args.join(' '));
      if (args[0] === 'inspect') return { code: 0, out: `${h.running}\n`, err: '' };
      if (args[0] === 'ps') return { code: 0, out: '', err: '' };
      if (args.includes('cat') && args.join(' ').includes('server.crt')) return { code: 0, out: FIXTURE_PEM, err: '' };
      return { code: 0, out: '', err: '' };
    }
    const login = args[args.indexOf('-U') + 1];
    const db = args[args.indexOf('-d') + 1];
    const sql = stdin ?? args[args.length - 1];
    const p = { login, db, sql, pins: args.some(a => a.startsWith('PGOPTIONS=-c search_path')), stdin: stdin !== undefined };
    h.psql.push(p);
    if (sql.includes('pg_catalog.pg_is_in_recovery()::text,')) {
      h.events.push('roles');
      const a = h.roles.length ? h.roles.shift()! : SET_UP_READ;
      return typeof a === 'string' ? { code: 0, out: `${a}\n`, err: '' } : { code: 1, out: '', err: a.err };
    }
    if (sql.includes("'v|'") && sql.includes("rolname = 'smdb'")) h.events.push('fill');
    const f = h.fail(p);
    if (f !== undefined) return { code: 1, out: '', err: f };
    const r = h.reply(p);
    if (r !== undefined) return { code: 0, out: r, err: '' };
    if (sql.includes("'owner|'")) return { code: 0, out: 'owner|dbm_meta|ok\n', err: '' };
    if (sql.includes("'drift|'")) return { code: 0, out: 'drift|0|0|0\n', err: '' };
    if (sql.includes("'v|'")) return { code: 0, out: 'missing\n', err: '' };
    if (sql.includes('pg_read_file')) return { code: 0, out: '0\n', err: '' };
    if (sql.includes("FROM pg_roles WHERE rolname = 'replicator'")) return { code: 0, out: '1\n', err: '' };
    if (sql.includes("current_setting('max_connections')")) return { code: 0, out: '100|3|4|true\n', err: '' };
    if (sql.includes('smdb_data.shard_nodes')) return { code: 0, out: '[{"restartable":true,"overlap":false}]\n', err: '' };
    if (sql.includes("current_setting('ssl')")) return { code: 0, out: 'on|||4096MB\n', err: '' };
    if (sql.includes("to_regclass('smdb_manager.addresses') IS NULL")) return { code: 0, out: '[]\n', err: '' };
    return { code: 0, out: '', err: '' };
  };
  const execFile = (_f: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    const a = answer(args, undefined);
    setImmediate(() => done(a.code ? Object.assign(new Error(a.err), { code: a.code }) : null, a.out, a.err));
    return { stdin: null };
  };
  const spawn = (_cmd: string, args: string[]) => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    let input = '';
    child.stdin.on('data', (d: Buffer) => { input += d; });
    const fed = args.includes('-i');
    const finish = () => {
      const a = answer(args, fed ? input : undefined);
      child.stdout.end(a.out);
      child.stderr.end(a.err);
      setTimeout(() => child.emit('close', a.code), 1);
    };
    if (fed) child.stdin.on('finish', () => setTimeout(finish, 1));
    else setTimeout(finish, 1);
    return child;
  };
  const exec = (cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    h.shell.push(cmd);
    if (h.notReady && cmd.includes('pg_isready')) done(Object.assign(new Error('the database system is starting up'), { code: 1 }));
    else done(null, { stdout: '', stderr: '' });
  };
  const mod = { ...real, exec, execFile, spawn, execFileSync: () => '', execSync: () => '' };
  return { ...mod, default: mod };
});
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/docker/dockerClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
  composeUp: async () => {},
  verifyComposeProjectRunning: async () => ({ allRunning: true, problems: [] }),
  listBotContainers: async () => [],
}));
vi.mock('../../src/templates/pcsProcessing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/templates/pcsProcessing')>()),
  fleetAppContainerName: () => 'app-1',
}));
vi.mock('../../src/config/appCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/config/appCapabilities')>()),
  findAppCapabilities: () => ({ companionDb: { env: { url: 'DATABASE_URL' } } }),
}));
vi.mock('../../src/env/manager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/env/manager')>();
  return {
    ...real,
    getEnvVars: () => ({ ...h.env }),
    getEnvVarsWithStatus: () => ({ vars: { ...h.env }, corrupt: false, undecryptable: [] }),
    setEnvVars: () => {},
  };
});
// Only the callers in containerManager and maintenance see these; fleetReplication keeps the real module.
vi.mock('../../src/instance/dbLogin', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/instance/dbLogin')>();
  return {
    ...real,
    ensureManagerDbRole: vi.fn(async () => { h.events.push('ensure'); return { ok: true }; }),
    sidecarRunning: vi.fn(async () => true),
    readBotLogin: vi.fn(async () => { h.events.push('read-login'); return { ok: true, login: { inRecovery: false, canLogin: true, sessions: 0 } }; }),
    checkRolesDrift: vi.fn(real.checkRolesDrift),
  };
});
vi.mock('../../src/instance/fleetSwitch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetSwitch')>()),
  ensureMainGeneration: vi.fn(async () => { h.events.push('generation'); }),
}));
vi.mock('../../src/instance/fleetBackup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetBackup')>()),
  fenceStartWarning: vi.fn(async () => null),
}));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as dbLogin from '../../src/instance/dbLogin';
import * as fleetReplication from '../../src/instance/fleetReplication';
import { reconcileMaintenance, resetMaintenanceState } from '../../src/instance/maintenance';
import { decodeJoinCode } from '../../src/config/joinCode';
import { scramSha256Verifier } from '../../src/config/secretText';
import { logCollectors } from '../../src/build/logCollector';

const C = 'bot1-fleet-postgres';
const U = 'smdb';
const DB = 'smdb';
const PW = 'Rec-pw-1234';
const replication = { role: 'replicator', password: 'Repl-Secret-0123456789', hostPort: 15432, publicHost: 'main.invalid', certHost: 'main.invalid', slotWalKeepMb: 4096 };
const fleetDb = { containerName: C, user: U, db: DB, volume: `${C}-data`, password: PW };

const mocked = (f: unknown) => f as ReturnType<typeof vi.fn>;
const ensure = () => mocked(dbLogin.ensureManagerDbRole);
const reads = () => h.events.filter(e => e === 'roles').length;

const PV_LOG = (e: string) => `[ContainerManager] b1: the database's roles could not be set up: ${e}`;
const PV_MT = (e: string) => `[Maintenance] Bot 1: the database's roles could not be set up: ${e}`;
const PV_NOPASS = `the role ${U} does not exist, and no password is on record that this database was created with (a Database URL naming this database with its password records it), so the manager cannot create it`;
const PV_FIRST = `the bot's role ${U} is this database's first role, which Postgres keeps a superuser; a database the manager creates now starts with dbm_admin as its first role, so the bot's role gets less than superuser rights only on a new install`;
const PV_CONFIRM_PW = 'the roles did not read back as set (dbm_admin still has a password)';
const READ_ONLY = 'ERROR:  cannot execute ALTER ROLE in a read-only transaction';
const READ_ONLY_STEP = `setting up dbm_meta, dbm_work and the settings of ${DB} failed (${READ_ONLY})`;
const READ_FAILED = (why: string) => `reading the roles failed (${why})`;
const JC_ROLES = (e: string) => `The bot's database login could not be confirmed as limited to its own database (${e}), so no join code was made`;
const JC_RECOVERY = "This database is a live copy, so it makes no join code; copy the code from the main's manager";
const EN_ROLES = (e: string) => `Enable was refused: the database's roles could not be set up (${e}); replication was not set up`;
const JC_RECEIVING = 'This machine is receiving a bot; make the join code after the push ends (nothing was changed)';
const RECEIVE = { startedAt: '2026-11-14T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', safetyDump: 'pre.dump', pushId: 'p1', dbOid: '16384' };
const PUSH_BROKEN = { at: '2026-11-14T00:00:00.000Z', safetyDump: 'pre.dump' };
const LANE_NOANSWER = "The database did not answer within 30 seconds of the start, so the manager could not check it for a write fence yet; the maintenance check sets up the database's roles at its next pass";
const failScript1 = () => { h.fail = p => (p.sql.includes('ALTER ROLE dbm_admin SET search_path') ? READ_ONLY : undefined); };

const record = (over: Record<string, unknown> = {}) => ({
  id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'stopped',
  sourceType: 'docker-image', imageRef: 'example/bot:1', sourceUrl: 'https://example.invalid/fake/bot', envVars: {}, containerIds: [], fleetDb,
  createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', ...over,
});
const writeRegistry = (b1: Record<string, unknown>) => fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances: { b1 } }));
const arrange = (over: Record<string, unknown> = {}) => {
  const appDir = path.join(h.dir, 'DATA', 'AppData', 'casaos', 'apps', 'bot1');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'docker-compose.yml'), `name: bot1\nservices:\n  fleet-postgres:\n    container_name: ${C}\n    image: postgres:16\n`);
  const botDir = path.join(h.dir, 'bots', 'b1');
  fs.mkdirSync(path.join(botDir, 'env'), { recursive: true });
  fs.writeFileSync(path.join(botDir, 'docker-compose.yml'), 'name: bot1\nservices:\n  app:\n    image: example/bot:1\n');
  writeRegistry(record(over));
};
const bot = () => containerManager.getBot('b1')!;

let warned: string[] = [];
beforeEach(() => {
  h.shell = []; h.psql = []; h.other = []; h.events = []; h.roles = []; h.notReady = false; h.running = 'true';
  h.fail = () => undefined; h.reply = () => undefined; h.env = { DATABASE_URL: '' }; h.saveFails = '';
  Object.assign(containerManager.START_DB_READY, { deadlineMs: 30_000, tryMs: 5_000, pauseMs: 1000 });
  ensure().mockReset();
  ensure().mockImplementation(async () => { h.events.push('ensure'); return { ok: true }; });
  resetMaintenanceState();
  arrange();
  warned = [];
  vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { warned.push(String(m)); });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));

describe('startFleetDbSidecar (O2, O3, R3.1, R3.4)', () => {
  it('C20, L1: the ready loop asks over 127.0.0.1, then ensureManagerDbRole, provisioning (read and confirm) and ensureMainGeneration', async () => {
    expect(await containerManager.startFleetDbSidecar('b1')).toEqual({ success: true });
    expect(h.shell.find(c => c.includes('pg_isready'))).toBe(`docker exec "${C}" pg_isready -h 127.0.0.1 -U "${U}" -d "${DB}"`);
    expect(h.events).toEqual(['ensure', 'roles', 'roles', 'generation']);
    expect(dbLogin.isRolesConfirmed(C)).toBe(true);
    expect(warned).toEqual([]);
  });

  it('C22: ensureManagerDbRole fails: no provisioning, and the old line is logged', async () => {
    ensure().mockImplementation(async () => ({ ok: false, cls: 'missing-role', error: 'role missing' }));
    expect(await containerManager.startFleetDbSidecar('b1')).toEqual({ success: true });
    expect(reads()).toBe(0);
    expect(warned).toEqual(["[ContainerManager] b1: the manager's database role dbm_admin could not be confirmed: role missing"]);
  });

  it.each([
    ['PV-NOPASS', () => { arrange({ fleetDb: { ...fleetDb, password: undefined } }); h.roles = [BOT_MISSING]; }, PV_NOPASS],
    ['PV-FIRST', () => { h.roles = [BOT_FIRST]; }, PV_FIRST],
    ['PV-SCHEMA', () => { h.reply = p => (p.sql.includes("'owner|'") ? 'owner|someone|ok\n' : undefined); }, `the schema smdb_manager in ${DB} belongs to someone, not dbm_meta`],
    ['PV-NAME', () => arrange({ fleetDb: { ...fleetDb, db: 'Smdb' } }), 'the database name Smdb cannot be used by the manager (it must be a plain lower-case name)'],
    ['PV-READ', () => { h.roles = ['garbage']; }, "the database's roles read back as garbage"],
  ])('C21, C34: %s ends the start at once: PV-LOG, success, no generation write', async (_n, arrangeIt, error) => {
    arrangeIt();
    expect(await containerManager.startFleetDbSidecar('b1')).toEqual({ success: true });
    expect(reads()).toBeLessThanOrEqual(1);
    expect(warned).toEqual([PV_LOG(error)]);
    expect(h.events).not.toContain('generation');
  });

  it.each([
    ['PV-STEP of the read', [{ err: 'FATAL:  the database system is starting up' }], 3],
    ['PV-DB', [NO_DB], 3],
    ['PV-CONFIRM', [ADMIN_PW, ADMIN_PW], 4],
  ] as Array<[string, Answer[], number]>)('L2, C33: %s is tried again after the pause, and a later confirm logs nothing', async (_n, answers, total) => {
    Object.assign(containerManager.START_DB_READY, { pauseMs: 5 });
    h.roles = [...answers];
    expect(await containerManager.startFleetDbSidecar('b1')).toEqual({ success: true });
    expect(reads()).toBe(total);
    expect(warned).toEqual([]);
    expect(h.events.filter(e => e === 'generation')).toHaveLength(1);
  });

  it('L3, U5, W10: a step refused by a kept write fence on every try until the bound: PV-LOG with psql\'s text, never JC-RECOVERY', async () => {
    Object.assign(containerManager.START_DB_READY, { deadlineMs: 150, pauseMs: 10 });
    h.roles = Array(100).fill(NO_ADMIN_PATH);
    failScript1();
    expect(await containerManager.startFleetDbSidecar('b1')).toEqual({ success: true });
    expect(reads()).toBeGreaterThan(2);
    expect(warned).toEqual([PV_LOG(READ_ONLY_STEP)]);
    expect(warned.join('\n')).not.toContain('live copy');
    expect(h.events).not.toContain('generation');
  });

  it('a live copy (in-recovery) is silent and the generation step runs as before', async () => {
    h.roles = [RECOVERY];
    expect(await containerManager.startFleetDbSidecar('b1')).toEqual({ success: true });
    expect(warned).toEqual([]);
    expect(h.events).toEqual(['ensure', 'roles', 'generation']);
  });
});

describe('the start lane (C23, C24, R3.4)', () => {
  it('C23, L1: databaseReady asks over 127.0.0.1, then the ensure and the provisioning run', async () => {
    const r = await containerManager.startBot('b1');
    expect(r.success).toBe(true);
    expect(h.shell.filter(c => c.includes('pg_isready'))).toEqual([`docker exec "${C}" pg_isready -h 127.0.0.1 -U "${U}" -d "${DB}"`]);
    expect(h.events).toEqual(['ensure', 'roles', 'roles']);
    expect(warned.filter(w => w.includes('roles'))).toEqual([]);
  });

  it('C24: a failure is logged as PV-LOG and the start answers success', async () => {
    arrange({ fleetDb: { ...fleetDb, password: undefined } });
    h.roles = [BOT_MISSING];
    const r = await containerManager.startBot('b1');
    expect(r.success).toBe(true);
    expect(warned).toContain(PV_LOG(PV_NOPASS));
  });

  it('the ensure fails: no provisioning', async () => {
    ensure().mockImplementation(async () => ({ ok: false, cls: 'other', error: 'refused' }));
    await containerManager.startBot('b1');
    expect(reads()).toBe(0);
  });

  it('LANE-NOANSWER: no answer within the bound gives the new text and no provisioning', async () => {
    Object.assign(containerManager.START_DB_READY, { deadlineMs: 30, pauseMs: 1 });
    h.notReady = true;
    logCollectors.get('b1').clear();
    const r = await containerManager.startBot('b1');
    expect(r.success).toBe(true);
    expect(r.warning).toBe(LANE_NOANSWER);
    expect(logCollectors.get('b1').getLogs().map(l => l.message)).toContain(`[Start] ${LANE_NOANSWER}`);
    expect(reads()).toBe(0);
  });
});

describe('the provisioning target and RES-LOW', () => {
  it('V1: the record password, no candidates', () => {
    expect(fleetReplication.provisionTarget(bot())).toEqual({ container: C, user: U, db: DB, botId: 'b1', password: PW, candidates: [], recordUnchanged: expect.any(Function) });
  });

  it('V2: no record password: the Database URL passwords, the managed database first', () => {
    arrange({ fleetDb: { ...fleetDb, password: undefined } });
    h.env = { DATABASE_URL: `postgresql://x:other-pw@elsewhere.invalid:5432/other,postgresql://${U}:url-pw@${C}:5432/${DB}` };
    expect(fleetReplication.provisionTarget(bot())).toMatchObject({ password: null, candidates: ['url-pw', 'other-pw'] });
  });

  it('a record password that no longer decrypts is not passed on', () => {
    arrange({ fleetDb: { ...fleetDb, password: '' } });
    expect(fleetReplication.provisionTarget(bot())).toMatchObject({ password: null, candidates: [] });
  });

  it('RES-LOW (S8, U6) is logged once per container, and not for 4', async () => {
    arrange({ fleetDb: { ...fleetDb, containerName: 'res-low-pg' } });
    h.roles = [LOW_RESERVED, LOW_RESERVED, LOW_RESERVED, LOW_RESERVED];
    expect(await fleetReplication.provisionManagedRoles(bot(), { reread: true })).toEqual({ ok: true, wrote: [], reserved: 3 });
    await fleetReplication.provisionManagedRoles(bot(), { reread: true });
    expect(warned).toEqual(["[Database] res-low-pg: reserved_connections is 3, below the 4 the manager's logins need; the next start after a build recreates the database container with it"]);
    arrange({ fleetDb: { ...fleetDb, containerName: 'res-ok-pg' } });
    await fleetReplication.provisionManagedRoles(bot(), { reread: true });
    expect(warned).toHaveLength(1);
  });
});

describe('the maintenance check (C25, C26, L3, U2, S6)', () => {
  const pass = () => reconcileMaintenance();
  const failRead = (why: string, n = 1) => { h.roles = Array(n).fill({ err: why }); };

  it('C25, L3: a container not in the confirmed set is provisioned on every pass, not only the first', async () => {
    failRead('A', 3);
    await pass(); await pass(); await pass();
    expect(reads()).toBe(3);
  });

  it('C26: PV-MT once per distinct error, and the pass goes on', async () => {
    h.roles = [{ err: 'A' }, { err: 'A' }, { err: 'B' }, { err: 'A' }];
    for (let i = 0; i < 4; i++) await pass();
    expect(warned).toEqual([PV_MT(READ_FAILED('A')), PV_MT(READ_FAILED('B')), PV_MT(READ_FAILED('A'))]);
    expect(h.events.filter(e => e === 'read-login')).toHaveLength(4);
  });

  it('an ok answer clears the logged error, so the same error later is logged again', async () => {
    h.roles = [{ err: 'A' }, SET_UP_READ, SET_UP_READ, { err: 'A' }];
    await pass();
    await pass();
    h.reply = p => (p.sql.includes("'drift|'") ? 'garbled\n' : undefined);
    await pass();
    expect(warned).toEqual([PV_MT(READ_FAILED('A')), PV_MT(READ_FAILED('A'))]);
  });

  it('in-recovery is silent; a failed ensure or a stopped sidecar gets no provisioning', async () => {
    h.roles = [RECOVERY];
    await pass();
    expect(warned).toEqual([]);
    expect(reads()).toBe(1);
    ensure().mockImplementation(async () => ({ ok: false, cls: 'missing-role', error: 'gone' }));
    await pass();
    expect(reads()).toBe(1);
    ensure().mockImplementation(async () => ({ ok: true }));
    mocked(dbLogin.sidecarRunning).mockImplementationOnce(async () => false);
    await pass();
    expect(reads()).toBe(1);
  });

  it('A1, D42: no provisioning while this machine receives a push or a push broke; the first pass after the receive ends provisions', async () => {
    await pass();
    expect(reads()).toBe(2);
    dbLogin.noteLoginFault(C);
    for (const state of [{ receive: RECEIVE }, { pushBroken: PUSH_BROKEN }]) {
      arrange({ fleetDb: { ...fleetDb, ...state } });
      await pass();
      expect(reads()).toBe(2);
    }
    expect(h.psql.filter(p => p.sql.includes("'drift|'"))).toEqual([]);
    arrange();
    await pass();
    expect(reads()).toBe(4);
  });

  describe('a confirmed container (U2 parts 2 and 3, S6, W9)', () => {
    const confirm = async () => {
      await pass();
      expect(dbLogin.isRolesConfirmed(C)).toBe(true);
      h.events = [];
      h.psql = [];
    };

    it('the drift read finds nothing: no provisioning; it runs as dbm_admin on postgres', async () => {
      await confirm();
      await pass();
      expect(reads()).toBe(0);
      expect(mocked(dbLogin.checkRolesDrift)).toHaveBeenLastCalledWith({ container: C, db: DB });
      expect(h.psql.map(p => [p.login, p.db])).toEqual([['dbm_admin', 'postgres']]);
    });

    it.each(['drift|1|0|0', 'drift|0|1|0', 'drift|0|0|1', 'garbled'])('W8, W9: the drift read answers %s: the same pass provisions', async (answer) => {
      await confirm();
      h.reply = p => (p.sql.includes("'drift|'") ? `${answer}\n` : undefined);
      await pass();
      expect(reads()).toBe(2);
    });

    it.each([
      ['S6: a dbm_work read fails with a message no list names', () => dbLogin.runCall(C, dbLogin.workPsql(C, DB, 'SELECT count(*) FROM smdb_data.shard_claims')), 'ERROR:  something nobody listed'],
      ['W9: a dbm_meta write fails under a read-only default', () => dbLogin.runCall(C, dbLogin.metaPsql(C, DB, 'UPDATE smdb_manager.generation SET n = n')), 'ERROR:  cannot execute UPDATE in a read-only transaction'],
    ])('%s: the set drops the container and the next pass provisions', async (_n, call, stderr) => {
      await confirm();
      h.fail = p => (p.login !== 'dbm_admin' ? stderr : undefined);
      expect((await call()).ok).toBe(false);
      expect(dbLogin.isRolesConfirmed(C)).toBe(false);
      h.fail = () => undefined;
      await pass();
      expect(reads()).toBe(2);
      expect(dbLogin.isRolesConfirmed(C)).toBe(true);
    });
  });
});

describe('getJoinCode (C27 to C30, L5, ruling 5)', () => {
  beforeEach(() => arrange({ fleetDb: { ...fleetDb, replication } }));

  it('C27, L5: a container in the confirmed set is read again, then the code holds the bot role', async () => {
    await fleetReplication.provisionManagedRoles(bot());
    expect(dbLogin.isRolesConfirmed(C)).toBe(true);
    h.events = [];
    const r = await fleetReplication.getJoinCode(bot());
    expect(r.success).toBe(true);
    expect(reads()).toBe(2);
    const d = decodeJoinCode(r.joinCode!);
    expect(d.ok && d.code.app).toEqual({ user: U, password: PW });
  });

  it('C28: a failure answers JC-ROLES and the certificate is not read', async () => {
    h.roles = [ADMIN_PW, ADMIN_PW];
    expect(await fleetReplication.getJoinCode(bot())).toEqual({ success: false, error: JC_ROLES(PV_CONFIRM_PW) });
    expect(h.other.some(o => o.includes('server.crt'))).toBe(false);
  });

  it('C29: an old cluster (bot role is oid 10): JC-ROLES with PV-FIRST', async () => {
    h.roles = [BOT_FIRST];
    expect(await fleetReplication.getJoinCode(bot())).toEqual({ success: false, error: JC_ROLES(PV_FIRST) });
  });

  it('JC-RECOVERY only for in-recovery; U5, W10: a step refused as read-only is JC-ROLES', async () => {
    h.roles = [RECOVERY];
    expect(await fleetReplication.getJoinCode(bot())).toEqual({ success: false, error: JC_RECOVERY });
    h.roles = [NO_ADMIN_PATH];
    failScript1();
    expect(await fleetReplication.getJoinCode(bot())).toEqual({ success: false, error: JC_ROLES(READ_ONLY_STEP) });
  });

  it('A1: a receiving machine or one whose push broke makes no join code and runs no provisioning', async () => {
    arrange({ fleetDb: { ...fleetDb, replication, receive: RECEIVE } });
    expect(await fleetReplication.getJoinCode(bot())).toEqual({ success: false, error: JC_RECEIVING });
    arrange({ fleetDb: { ...fleetDb, replication, pushBroken: PUSH_BROKEN } });
    expect(await fleetReplication.getJoinCode(bot())).toEqual({ success: false, error: 'A push into this database did not finish; restore the dump pre.dump or receive a push again, then make the join code (nothing was changed)' });
    expect(h.psql).toEqual([]);
  });

  it('C30: a repeat after a fix reads again', async () => {
    h.roles = [{ err: 'x' }];
    expect((await fleetReplication.getJoinCode(bot())).success).toBe(false);
    expect((await fleetReplication.getJoinCode(bot())).success).toBe(true);
    expect(reads()).toBe(3);
  });

  it('ruling 5: the password fill runs only after provisioning answers ok', async () => {
    arrange({ fleetDb: { ...fleetDb, password: undefined, replication } });
    h.env = { DATABASE_URL: `postgresql://${U}:url-pw@${C}:5432/${DB}` };
    h.roles = [{ err: 'refused' }];
    await fleetReplication.getJoinCode(bot());
    expect(h.events).toEqual(['roles']);
    h.events = [];
    await fleetReplication.getJoinCode(bot());
    expect(h.events).toEqual(['roles', 'roles', 'fill']);
  });
});

describe('Enable (EN-ROLES, L4, ruling 5)', () => {
  beforeEach(() => {
    arrange({ fleetDb: { ...fleetDb, replication } });
    h.env = { DATABASE_URL: `postgresql://${U}:${encodeURIComponent(PW)}@${C}:5432/${DB}?sslmode=no-verify` };
  });
  const enable = () => fleetReplication.enableFleetReplication(bot(), 'main.invalid', 15432, 4096, { offerAddresses: false });
  const isRead = (sql: string) => sql.includes('pg_catalog.pg_is_in_recovery()::text,') || sql.includes("'owner|'");

  it('L4: a failure answers EN-ROLES and nothing else runs: no fence read, role, ssl, pg_hba or certificate change', async () => {
    arrange({ fleetDb: { ...fleetDb, password: undefined, replication } });
    h.roles = [BOT_MISSING];
    expect(await enable()).toEqual({ success: false, error: EN_ROLES(PV_NOPASS) });
    expect(h.psql.every(p => isRead(p.sql))).toBe(true);
    expect(h.other.filter(o => !o.startsWith('inspect'))).toEqual([]);
  });

  it('in-recovery is refused with EN-ROLES as well', async () => {
    h.roles = [RECOVERY];
    expect(await enable()).toEqual({ success: false, error: EN_ROLES('the database is a live copy in recovery, which takes its roles from its main') });
  });

  it('A3: the fence refusal after provisioning says replication was not set up', async () => {
    h.reply = p => (p.sql.includes('pg_read_file') ? 'garbled\n' : undefined);
    expect(await enable()).toEqual({ success: false, error: 'Enable rewrites pg_hba.conf, but whether a write fence stands in pg_hba.conf could not be read (no answer); replication was not set up, so retry Enable after that' });
  });

  it('provisioning runs before fenceLinesRefusal; a confirmed container is not read again', async () => {
    expect((await enable()).success).toBe(true);
    const fence = h.psql.findIndex(p => p.sql.includes('pg_read_file'));
    expect(h.psql.slice(0, fence).every(p => isRead(p.sql))).toBe(true);
    expect(fence).toBe(4);
    h.events = [];
    expect((await enable()).success).toBe(true);
    expect(reads()).toBe(0);
  });

  it('ruling 5: the password fill runs only after provisioning answers ok', async () => {
    arrange({ fleetDb: { ...fleetDb, password: undefined, replication } });
    h.roles = [{ err: 'refused' }];
    await enable();
    expect(h.events).toEqual(['roles']);
    h.events = [];
    await enable();
    expect(h.events).toEqual(['roles', 'roles', 'fill']);
  });

  it('R3.3: cluster statements as dbm_admin on postgres with no pins; the address table as dbm_meta in the bot database on stdin', async () => {
    expect((await enable()).success).toBe(true);
    const where = (needle: string) => h.psql.filter(p => p.sql.includes(needle)).map(p => `${p.login}@${p.db}${p.pins ? '+pins' : ''}${p.stdin ? '+stdin' : ''}`);
    expect(where('pg_read_file')).toEqual(['dbm_admin@postgres']);
    expect(where('pg_stat_ssl')).toEqual(['dbm_admin@postgres']);
    expect(where("rolname = 'replicator'")).toEqual(['dbm_admin@postgres']);
    expect(where('ROLE replicator WITH REPLICATION LOGIN')).toEqual(['dbm_admin@postgres+stdin']);
    expect(where('ALTER SYSTEM')).toEqual(Array(4).fill('dbm_admin@postgres'));
    expect(where('pg_reload_conf')).toEqual(['dbm_admin@postgres']);
    expect(where('CREATE TABLE IF NOT EXISTS smdb_manager.addresses')).toEqual(['dbm_meta@smdb+pins+stdin']);
    expect(h.psql.every(p => p.login === 'dbm_meta' || p.db === 'postgres')).toBe(true);
  });
});

describe('the addresses table grants SELECT to dbm_work (Linux PG finding c, 2026-11-13)', () => {
  it("addressTableSql grants it beside the replication login's grants", () => {
    expect(fleetReplication.addressTableSql('h', 1, 'pem', 'm', null)).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON smdb_manager.addresses TO replicator;\nGRANT SELECT ON smdb_manager.addresses TO dbm_work;\n');
  });
});

describe('A2-1, Invariant A: no join code, move code or Enable while dbm_admin keeps its password (V3)', () => {
  const URL_PW = 'url-pw-5678';
  const STEP8 = 'ALTER ROLE dbm_admin PASSWORD NULL';
  const ran = (sql: string) => h.psql.findIndex(p => p.sql === sql);
  beforeEach(() => {
    arrange({ fleetDb: { ...fleetDb, password: undefined, replication } });
    h.env = { DATABASE_URL: `postgresql://${U}:${URL_PW}@${C}:5432/${DB}` };
    const verifier = scramSha256Verifier(URL_PW);
    h.reply = p => (p.sql.includes("'v|'") && p.sql.includes("rolname = 'smdb'") ? `v|${verifier}\n` : undefined);
  });

  it('getJoinCode: the fill records the password, the second provisioning still reads a password on dbm_admin: no code', async () => {
    h.roles = [ADMIN_PW, ADMIN_PW, ADMIN_PW, ADMIN_PW];
    expect(await fleetReplication.getJoinCode(bot())).toEqual({ success: false, error: JC_ROLES(PV_CONFIRM_PW) });
    expect(bot().fleetDb!.password).toBe(URL_PW);
  });

  it('getJoinCode: the second provisioning runs step 8 and confirms, then the code is made', async () => {
    h.roles = [ADMIN_PW, ADMIN_PW, ADMIN_PW];
    const r = await fleetReplication.getJoinCode(bot());
    expect(r.success).toBe(true);
    expect(ran(STEP8)).toBeGreaterThan(h.psql.findIndex(p => p.sql.includes("'v|'") && p.sql.includes("rolname = 'smdb'")));
    expect(dbLogin.isRolesConfirmed(C)).toBe(true);
  });

  it('Enable: no replication change while dbm_admin keeps its password; set up once the second provisioning confirms', async () => {
    const enable = () => fleetReplication.enableFleetReplication(bot(), 'main.invalid', 15432, 4096, { offerAddresses: false });
    h.roles = [ADMIN_PW, ADMIN_PW, ADMIN_PW, ADMIN_PW];
    expect(await enable()).toEqual({ success: false, error: EN_ROLES(PV_CONFIRM_PW) });
    expect(h.psql.some(p => p.sql.includes('ALTER SYSTEM') || p.sql.includes('ROLE replicator WITH REPLICATION LOGIN'))).toBe(false);
    h.psql = [];
    h.roles = [ADMIN_PW, SET_UP_READ];
    expect((await enable()).success).toBe(true);
    expect(ran(STEP8)).toBeGreaterThanOrEqual(0);
    expect(ran(STEP8)).toBeLessThan(h.psql.findIndex(p => p.sql.includes('ALTER SYSTEM')));
  });

  it('A3-2: the next maintenance pass after V3 records the password and runs step 8', async () => {
    h.roles = [ADMIN_PW, ADMIN_PW, ADMIN_PW];
    await reconcileMaintenance();
    expect(bot().fleetDb!.password).toBe(URL_PW);
    expect(ran(STEP8)).toBeGreaterThanOrEqual(0);
    expect(dbLogin.isRolesConfirmed(C)).toBe(true);
    expect(warned).toEqual([]);
  });

  it('A3-2: V3 with a Database URL Enable keeps: Enable confirms and goes on', async () => {
    h.env = { DATABASE_URL: `postgresql://x:other-pw@elsewhere.invalid:5432/other,postgresql://${U}:${URL_PW}@${C}:5432/${DB}` };
    h.roles = [ADMIN_PW, ADMIN_PW, ADMIN_PW];
    const r = await fleetReplication.enableFleetReplication(bot(), 'main.invalid', 15432, 4096, { offerAddresses: false });
    expect(r.success).toBe(true);
    expect(bot().fleetDb!.password).toBe(URL_PW);
    expect(ran(STEP8)).toBeGreaterThanOrEqual(0);
    expect(ran(STEP8)).toBeLessThan(h.psql.findIndex(p => p.sql.includes('ALTER SYSTEM')));
  });

  it('A3-2: a failed record write leaves dbm_admin its password and answers PV-UNSAVED', async () => {
    h.saveFails = 'the registry could not be saved (disk full)';
    h.roles = [ADMIN_PW, ADMIN_PW];
    await reconcileMaintenance();
    expect(warned).toEqual([PV_MT(`the role ${U} was created, but its password could not be recorded (the registry could not be saved (disk full)); it is recorded at the next check`)]);
    expect(ran(STEP8)).toBe(-1);
    expect(bot().fleetDb!.password).toBeUndefined();
    expect(dbLogin.isRolesConfirmed(C)).toBe(false);
  });

  it('Receive (forReceive): the move code is not made while dbm_admin has a password, and no provisioning runs', async () => {
    arrange({ fleetDb: { ...fleetDb, replication, receive: RECEIVE } });
    h.roles = [ADMIN_PW];
    expect(await fleetReplication.getJoinCode(bot(), { forReceive: true })).toEqual({ success: false, error: JC_ROLES(PV_CONFIRM_PW) });
    h.roles = [SET_UP_READ];
    expect((await fleetReplication.getJoinCode(bot(), { forReceive: true })).success).toBe(true);
    expect(h.psql.every(p => !p.stdin && !p.sql.includes('ALTER ') && !p.sql.includes('CREATE '))).toBe(true);
  });
});

describe('Fix 7d: the V3 fill in provisionManagedRoles (A4-1, A4-2)', () => {
  const URL_PW = 'url-pw-5678';
  const STEP8 = 'ALTER ROLE dbm_admin PASSWORD NULL';
  const ran = (sql: string) => h.psql.findIndex(p => p.sql === sql);
  const isBotVerifierRead = (p: { sql: string }) => p.sql.includes("'v|'") && p.sql.includes("rolname = 'smdb'");
  const V3 = { ...fleetDb, password: undefined, replication };
  const replyVerifier = (pw: string, then?: () => void) => {
    const verifier = scramSha256Verifier(pw);
    h.reply = p => {
      if (!isBotVerifierRead(p)) return undefined;
      then?.();
      return `v|${verifier}\n`;
    };
  };
  const RECORD_CHANGED = `the bot's database record changed while its roles were set up, so the password the role ${U} accepts was not recorded; the next check reads the new record`;
  const KEPT = (detail?: string) => `dbm_admin keeps its password because no password is on record for the role ${U}${detail ? ` (${detail})` : ''}`;
  const KEPT_LOST = "dbm_admin keeps its password because the bot's database password on record no longer decrypts";
  const enable = () => fleetReplication.enableFleetReplication(bot(), 'main.invalid', 15432, 4096, { offerAddresses: false });
  beforeEach(() => {
    arrange({ fleetDb: V3 });
    h.env = { DATABASE_URL: `postgresql://${U}:${URL_PW}@${C}:5432/${DB}` };
  });

  it.each([
    ['its shape changed', { ...V3, volume: 'other-volume' }],
    ['it gained a password', { ...V3, password: 'Other-pw-9999' }],
  ])('A4-1: the record changed while the pass ran (%s): nothing written, no step 8', async (_n, changed) => {
    replyVerifier(URL_PW, () => writeRegistry(record({ fleetDb: changed })));
    h.roles = Array(2).fill(ADMIN_PW);
    await reconcileMaintenance();
    expect(warned).toEqual([PV_MT(RECORD_CHANGED)]);
    expect(bot().fleetDb!.password).toBe((changed as { password?: string }).password);
    expect(ran(STEP8)).toBe(-1);
  });

  it('A4-2: the fill finds no password the role accepts: logged once, and getJoinCode refuses with it', async () => {
    replyVerifier('some-other-password');
    h.roles = Array(4).fill(ADMIN_PW);
    await reconcileMaintenance();
    await reconcileMaintenance();
    const text = KEPT(`the database does not accept the password in the Database URL for ${U}`);
    expect(warned).toEqual([PV_MT(text)]);
    h.roles = Array(2).fill(ADMIN_PW);
    expect(await fleetReplication.getJoinCode(bot())).toEqual({ success: false, error: JC_ROLES(text) });
    expect(ran(STEP8)).toBe(-1);
  });

  it('A4-2: the Database URL holds no password: logged once with the fill\'s detail, and Enable refuses with it', async () => {
    h.env = { DATABASE_URL: '' };
    h.roles = Array(4).fill(ADMIN_PW);
    await reconcileMaintenance();
    await reconcileMaintenance();
    const text = KEPT('the Database URL holds no password to check');
    expect(warned).toEqual([PV_MT(text)]);
    h.roles = Array(2).fill(ADMIN_PW);
    expect(await enable()).toEqual({ success: false, error: EN_ROLES(text) });
  });

  it('Fix 7e: a start in V3 with no accepted password logs once, is not tried again, and runs ensureMainGeneration', async () => {
    Object.assign(containerManager.START_DB_READY, { pauseMs: 5 });
    replyVerifier('some-other-password');
    h.roles = Array(6).fill(ADMIN_PW);
    expect(await containerManager.startFleetDbSidecar('b1')).toEqual({ success: true });
    expect(warned).toEqual([PV_LOG(KEPT(`the database does not accept the password in the Database URL for ${U}`))]);
    expect(reads()).toBe(2);
    expect(h.events.filter(e => e === 'generation')).toHaveLength(1);
  });

  it('Fix 7f: a start whose record write fails logs PV-UNSAVED once and runs ensureMainGeneration', async () => {
    Object.assign(containerManager.START_DB_READY, { pauseMs: 5 });
    replyVerifier(URL_PW);
    h.saveFails = 'the registry could not be saved (disk full)';
    h.roles = Array(6).fill(ADMIN_PW);
    expect(await containerManager.startFleetDbSidecar('b1')).toEqual({ success: true });
    expect(warned).toEqual([PV_LOG(`the role ${U} was created, but its password could not be recorded (the registry could not be saved (disk full)); it is recorded at the next check`)]);
    expect(reads()).toBe(2);
    expect(h.events.filter(e => e === 'generation')).toHaveLength(1);
  });

  it('Fix 7e: a start whose record changed while it provisioned logs once and runs ensureMainGeneration', async () => {
    Object.assign(containerManager.START_DB_READY, { pauseMs: 5 });
    replyVerifier(URL_PW, () => writeRegistry(record({ fleetDb: { ...V3, volume: 'other-volume' } })));
    h.roles = Array(6).fill(ADMIN_PW);
    expect(await containerManager.startFleetDbSidecar('b1')).toEqual({ success: true });
    expect(warned).toEqual([PV_LOG(RECORD_CHANGED)]);
    expect(reads()).toBe(2);
    expect(h.events.filter(e => e === 'generation')).toHaveLength(1);
  });

  it('A4-2: a fill answer with no detail ends the text at the role name', () => {
    expect(fleetReplication.adminKeptText(U, { ok: false, why: 'absent' })).toBe(KEPT());
  });

  it('A4-2: the record password no longer decrypts: logged once, and Enable refuses with it', async () => {
    arrange({ fleetDb: { ...V3, password: '' } });
    h.roles = Array(4).fill(ADMIN_PW);
    await reconcileMaintenance();
    await reconcileMaintenance();
    expect(warned).toEqual([PV_MT(KEPT_LOST)]);
    h.roles = Array(2).fill(ADMIN_PW);
    expect(await enable()).toEqual({ success: false, error: EN_ROLES(KEPT_LOST) });
  });

  it('the second provisioning fails its read: that failure is the answer, and the record already holds the password', async () => {
    replyVerifier(URL_PW);
    h.roles = [ADMIN_PW, ADMIN_PW, { err: 'X' }];
    await reconcileMaintenance();
    expect(warned).toEqual([PV_MT(READ_FAILED('X'))]);
    expect(bot().fleetDb!.password).toBe(URL_PW);
    expect(ran(STEP8)).toBe(-1);
  });
});

describe("fleetReplication's other statements by login (R3.3, R4)", () => {
  beforeEach(() => arrange({ fleetDb: { ...fleetDb, replication } }));
  const logins = () => h.psql.map(p => `${p.login}@${p.db}${p.pins ? '+pins' : ''}`);

  it('getFleetReplicationStatus: the probe as dbm_admin on postgres, the address rows as dbm_meta', async () => {
    const s = await fleetReplication.getFleetReplicationStatus(bot(), { probeEndpoint: false });
    expect(s.live?.sslOn).toBe(true);
    expect(logins()).toEqual(['dbm_admin@postgres', 'dbm_meta@smdb+pins']);
  });

  it('dropFleetSlot splits the slot drop (dbm_admin on postgres) from the address delete (dbm_meta)', async () => {
    expect(await fleetReplication.dropFleetSlot(bot(), 'fleet_standby_x')).toEqual({ success: true });
    expect(logins()).toEqual(['dbm_admin@postgres', 'dbm_meta@smdb+pins']);
    expect(h.psql[0].sql).toContain("pg_drop_replication_slot('fleet_standby_x')");
    expect(h.psql[0].sql).not.toContain('smdb_manager');
    expect(h.psql[1].sql).toContain("DELETE FROM smdb_manager.addresses WHERE slot = %L', 'fleet_standby_x'");
  });

  it('dropFleetSlot: a failed slot drop leaves the address row; a failed delete after the drop says the slot is gone', async () => {
    h.fail = p => (p.sql.includes('pg_drop_replication_slot') ? 'ERROR:  no slot named fleet_standby_x\nCONTEXT:  PL/pgSQL function inline_code_block line 4 at RAISE' : undefined);
    expect(await fleetReplication.dropFleetSlot(bot(), 'fleet_standby_x')).toEqual({ success: false, error: 'no slot named fleet_standby_x' });
    expect(h.psql).toHaveLength(1);
    h.fail = p => (p.login === 'dbm_meta' ? 'ERROR:  permission denied for table addresses' : undefined);
    expect(await fleetReplication.dropFleetSlot(bot(), 'fleet_standby_x')).toEqual({
      success: false, error: 'the slot fleet_standby_x was dropped, but its row in the address list could not be removed (permission denied for table addresses)',
    });
  });

  it('disableFleetReplication runs every statement as dbm_admin on postgres', async () => {
    h.env = { DATABASE_URL: `postgresql://${U}:${encodeURIComponent(PW)}@${C}:5432/${DB}?sslmode=no-verify` };
    const r = await fleetReplication.disableFleetReplication(bot());
    expect(r.success).toBe(true);
    expect(new Set(logins())).toEqual(new Set(['dbm_admin@postgres']));
  });

  it('fenceLinesRefusal reads pg_hba as dbm_admin on postgres', async () => {
    expect(await fleetReplication.fenceLinesRefusal(C)).toBeNull();
    expect(logins()).toEqual(['dbm_admin@postgres']);
  });

  it('connectionReading (G3) and W7: both statements as dbm_work with the pins; the 4 reserved places count against the limit', async () => {
    expect(await fleetReplication.connectionReading(bot())).toEqual({ state: 'read', machines: 1, count: 25, overlap: false, max: 100, reserved: 7, allowed: 93 });
    expect(logins()).toEqual(['dbm_work@smdb+pins', 'dbm_work@smdb+pins']);
  });

  it('a dbm_work failure in connectionReading names psql\'s line', async () => {
    h.fail = () => 'psql: error: FATAL:  permission denied for database "smdb"';
    expect(await fleetReplication.connectionReading(bot())).toEqual({ state: 'unread', error: 'the database did not answer (psql: error: FATAL:  permission denied for database "smdb")' });
  });
});

