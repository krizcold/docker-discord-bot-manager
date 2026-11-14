import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NM20 part 3: where provisionRoles runs (the start, the start lane, the maintenance check, Enable, the join code) and
// fleetReplication's statements by login. docker is a fake that answers psql by its SQL and records the login; the
// real provisionRoles runs over it, so each row picks the roles read the cluster answers.
type Answer = string | { err: string };
const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm20-l5-g-'));
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

// L5 survivors (writer g): provisionMayPass's step texts, provisionAtStart's bounds and the start lane's deadline.
const once = (match: (sql: string) => boolean, err = 'ERROR:  canceling statement due to conflict with recovery') => {
  let left = 1;
  h.fail = p => (match(p.sql) && left-- > 0 ? err : undefined);
};
const URL_PW = 'url-pw-5678';

describe('a step that failed once is tried again at the start', () => {
  const steps: Array<[string, () => void]> = [
    ['creating the schema smdb_manager as dbm_meta', () => once(s => s.includes("'owner|'"))],
    ["reading dbm_admin's password verifier", () => {
      arrange({ fleetDb: { ...fleetDb, password: undefined } });
      h.env = { DATABASE_URL: `postgresql://${U}:${URL_PW}@${C}:5432/${DB}` };
      const r = line({ 1: 'missing', 3: 'other', 4: 'true' });
      h.roles = [r, r];
      once(s => s.includes("'v|'") && s.includes("rolname = 'dbm_admin'"));
      const v = scramSha256Verifier(URL_PW);
      h.reply = p => (p.sql.includes("'v|'") && p.sql.includes("rolname = 'dbm_admin'") ? `v|${v}\n` : undefined);
    }],
    [`creating the role ${U}`, () => { h.roles = [BOT_MISSING, BOT_MISSING]; once(s => s.includes(`CREATE ROLE "${U}"`)); }],
    [`removing superuser rights from ${U}`, () => { const r = line({ 1: 'true' }); h.roles = [r, r]; once(s => s.startsWith(`ALTER ROLE "${U}"`)); }],
    [`setting the role memberships and giving ${DB} to ${U}`, () => { const r = line({ 3: 'false' }); h.roles = [r, r]; once(s => s.includes('OWNER TO')); }],
    ["removing dbm_admin's password", () => { h.roles = [ADMIN_PW, ADMIN_PW]; once(s => s === 'ALTER ROLE dbm_admin PASSWORD NULL'); }],
  ];
  it.each(steps)('%s failed once: a second try confirms, nothing is logged and the generation step runs', async (_step, arrangeIt) => {
    Object.assign(containerManager.START_DB_READY, { pauseMs: 5 });
    arrangeIt();
    expect(await containerManager.startFleetDbSidecar('b1')).toEqual({ success: true });
    expect(warned).toEqual([]);
    expect(reads()).toBe(3);
    expect(h.events.filter(e => e === 'generation')).toHaveLength(1);
    expect(dbLogin.isRolesConfirmed(C)).toBe(true);
  });
});

describe('provisionAtStart bounds', () => {
  it('the record loses its database between tries: no generation step and nothing logged', async () => {
    Object.assign(containerManager.START_DB_READY, { pauseMs: 5 });
    let left = 1;
    h.fail = p => {
      if (!p.sql.includes("'owner|'") || left-- <= 0) return undefined;
      writeRegistry(record({ fleetDb: undefined }));
      return 'ERROR:  canceling statement due to conflict with recovery';
    };
    expect(await containerManager.startFleetDbSidecar('b1')).toEqual({ success: true });
    expect(reads()).toBe(1);
    expect(h.events).not.toContain('generation');
    expect(warned).toEqual([]);
  });

  it('exactly one pause left before the deadline: no further try, the failure is logged', async () => {
    Object.assign(containerManager.START_DB_READY, { deadlineMs: 5, pauseMs: 5 });
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-14T00:00:00.000Z'));
    h.roles = [NO_DB];
    const r = await containerManager.startBot('b1');
    expect(r.success).toBe(true);
    expect(reads()).toBe(1);
    expect(warned).toContain(PV_LOG(`the database ${DB} does not exist in this container`));
  });

  it('the start lane tries a missing database again within its deadline and logs nothing', async () => {
    Object.assign(containerManager.START_DB_READY, { pauseMs: 5 });
    h.roles = [NO_DB];
    const r = await containerManager.startBot('b1');
    expect(r.success).toBe(true);
    expect(reads()).toBe(3);
    expect(warned.filter(w => w.includes('roles'))).toEqual([]);
  });
});
