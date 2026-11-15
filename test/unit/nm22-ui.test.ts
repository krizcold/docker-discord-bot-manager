import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm22-ui-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, replFails: [] as string[], migrating: null as null | { success: false; error: string }, deleteImpl: null as null | ((notes: string[]) => Promise<boolean>), removalRefusal: null as unknown };
});

vi.mock('child_process', async (importOriginal) => (await import('./nm22-lane-fake')).laneChildProcess(await importOriginal<typeof import('child_process')>()));
vi.mock('../../src/instance/fleetJoin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetJoin')>()),
  sendAddresses: async () => ({ state: 'applied' }),
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return {
    ...real,
    updateInstanceFleetDbReplication: (...a: any[]) => {
      const fail = h.replFails.shift();
      if (fail) throw new Error(fail);
      return (real as any).updateInstanceFleetDbReplication(...a);
    },
    migrateRefusal: (...a: any[]) => h.migrating ?? (real as any).migrateRefusal(...a),
    deleteBot: (id: string, keepData?: boolean, keepEnv?: boolean, cf?: boolean, cp?: boolean, notes: string[] = []) =>
      h.deleteImpl ? h.deleteImpl(notes) : real.deleteBot(id, keepData, keepEnv, cf, cp, notes),
  };
});
vi.mock('../../src/instance/fleetReplica', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetReplica')>()),
  instanceRemovalRefusal: async () => h.removalRefusal,
}));

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { createBotRoutes } from '../../src/webui/routes/bots';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { COPY_SESSION_OPTIONS } from '../../src/instance/dbLogin';
import { getJoinCode, removeCopyLogin, renewJoinCode } from '../../src/instance/fleetReplication';
import { REMOVE_BLOCK_SQL, ROLE_SETTINGS_RESET_SQL } from '../../src/instance/switchSql';
import { lane, resetLane } from './nm22-lane-fake';
import http from 'http';
import { AddressInfo } from 'net';
import { Client } from '../../src/cli/client';
import { dispatch } from '../../src/cli/commands';
import { actionRows, DISABLE_QUESTION } from '../../src/cli/tui/actions';
import { deleteBot as tuiDeleteBot, readReplication } from '../../src/cli/tui/api';
import { deleteDoneText } from '../../src/cli/tui/botdelete';
import { JOIN_CODE_NOTES } from '../../src/cli/tui/codes';
import { DatabaseScreen } from '../../src/cli/tui/database';
import { replicationLines } from '../../src/cli/tui/dbtext';
import { fake, ok as cliOk, noAnswer as cliNoAnswer, refused as cliRefused } from './m2-fake';
import { mainBot, replicationOn } from './m4-fake';

const ID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const OWN = 'smdb_copy_0f1e2d3c4b5a49688776655443322110';
const A = 'smdb_copy_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SA = 'fleet_standby_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REGISTRY = path.join(h.dir, 'instances.json');
const fleetDb = { containerName: 'm-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'm-fleet-postgres-data', password: 'Db-Secret,%x' };
const replication = { role: 'smdb_join', password: 'Join-Secret-0123456789', hostPort: 15432, publicHost: 'main.invalid', certHost: 'main.invalid', slotWalKeepMb: 4096 };

const bot = () => containerManager.getBot(ID)!;
const block = () => lane.calls.find(c => c.stdin.includes("SELECT 'blocked|'"));
const callOf = (needle: string | RegExp) => lane.calls.find(c => typeof needle === 'string' ? `${c.args} ${c.stdin}`.includes(needle) : needle.test(`${c.args} ${c.stdin}`));
const indexOf = (needle: string | RegExp) => { const c = callOf(needle); return c ? lane.calls.indexOf(c) : -1; };
const CLOSE = new RegExp(`-c ALTER ROLE "${A}" NOLOGIN PASSWORD NULL;`);
const stepText = (step: string, reason: string) => `The login ${A} was not removed completely: ${step} failed (${reason}). It is blocked: it cannot log in, other machines stop listing it within an hour, and this database ends its open sessions within 5 minutes. Press Remove again to finish.`;
const LISTED = 'It is blocked: it cannot log in, and other machines stop listing it within an hour. Press Remove again to finish.';
const DONE = `Removed the login ${A}: its sessions were ended, its slot dropped, its address taken off the list and what it owned dropped. A machine that holds this database's join code can join again; New join code stops that.`;

beforeEach(() => {
  resetLane();
  h.replFails = [];
  h.migrating = null;
  h.deleteImpl = null;
  h.removalRefusal = null;
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', ID, 'env'), { recursive: true });
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { [ID]: {
    id: ID, sanitizedName: 'm', displayName: 'M', titleName: 'M', status: 'running', sourceType: 'git',
    sourceUrl: 'https://example.invalid/fake/super-modular-discord-bot', envVars: { DATA_BACKEND: 'postgres' },
    createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', fleetDb: { ...fleetDb, replication },
  } } }));
  (containerManager as any).updateInstanceFleetLogin(ID, { password: 'Own-Machine-Secret-01' });
  envManager.setEnvVars(ID, { DATA_BACKEND_URL: 'postgresql://smdb:Db-Secret%2C%25x@m-fleet-postgres:5432/smdb?sslmode=no-verify' });
  lane.slotActive = 'false';
  lane.slotStates = ['false', 'absent'];
});
afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));

describe('NM22 Remove a machine\'s login (O5 M1 to M32, as R4, R20, R27, R31 and R40 give them)', () => {
  it('M1, M8, M12, M14, M18, M21, M23, M27 an inactive login: every step in order, RM-DONE', async () => {
    expect(await removeCopyLogin(bot(), A, false)).toEqual({ success: true, text: DONE });
    const order = [
      "SELECT 'login|'",
      "SELECT 'blocked|'",
      'pg_catalog.count(pg_catalog.pg_terminate_backend(pid, 5000))',
      'pg_catalog.count(*) FROM pg_catalog.pg_stat_activity',
      'SELECT coalesce((SELECT active::text',
      'SELECT pg_catalog.pg_drop_replication_slot',
      `DELETE FROM smdb_manager.addresses WHERE slot = '${SA}'`,
      `DROP OWNED BY "${A}";`,
      `ALTER ROLE "${A}" LOGIN PASSWORD NULL;`,
      'DROP OWNED BY CURRENT_USER',
      CLOSE,
      `DROP ROLE IF EXISTS "${A}";`,
    ].map(indexOf);
    expect(order.every(i => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(block()!.stdin).toBe(REMOVE_BLOCK_SQL(A));
    expect(callOf(`DELETE FROM smdb_manager.addresses WHERE slot = '${SA}'`)!.args).toContain('-U dbm_meta -d smdb');
    expect(callOf(`DROP OWNED BY "${A}";`)!.args).toContain('-U dbm_admin -d postgres');
  });

  it('5b opens the login with its settings reset and no password in one stdin call, and drops as the login over the socket with COPY_SESSION_OPTIONS', async () => {
    expect((await removeCopyLogin(bot(), A, false)).success).toBe(true);
    expect(callOf(`ALTER ROLE "${A}" LOGIN PASSWORD NULL;`)!.stdin).toBe(`${ROLE_SETTINGS_RESET_SQL(A)}ALTER ROLE "${A}" LOGIN PASSWORD NULL;\n`);
    expect(callOf('DROP OWNED BY CURRENT_USER')!.args).toBe(`exec -e PGOPTIONS=${COPY_SESSION_OPTIONS} m-fleet-postgres psql -U ${A} -d smdb -tA -v ON_ERROR_STOP=1 -c DROP OWNED BY CURRENT_USER`);
  });

  it('5b exit 0 is success whatever WARNING lines it printed', async () => {
    lane.rules.push({ match: 'DROP OWNED BY CURRENT_USER', out: 'DROP OWNED\n', err: 'WARNING:  no privileges could be revoked for "t"\nWARNING:  no privileges could be revoked for column "a" of relation "t"\n' });
    expect(await removeCopyLogin(bot(), A, false)).toEqual({ success: true, text: DONE });
  });

  it('M2 the own login: RM-OWN, no docker call', async () => {
    expect(await removeCopyLogin(bot(), OWN, true)).toEqual({ success: false, error: `${OWN} is this machine's own login, which it uses to rejoin another machine as a copy; it is not removed here.` });
    expect(lane.dockerCalls).toBe(0);
  });

  it.each(['replicator', 'smdb_join', 'smdb_copy_ABC', `${A}x`])('M3 a name off the pattern (%s): RM-UNKNOWN, no docker call', async (name) => {
    expect(await removeCopyLogin(bot(), name, true)).toEqual({ success: false, error: `No machine login named ${name} exists on this database; reload the Database window.` });
    expect(lane.dockerCalls).toBe(0);
  });

  it('M3 no role of that name: RM-UNKNOWN, nothing changed', async () => {
    lane.roleExists = 'false';
    expect(await removeCopyLogin(bot(), A, true)).toEqual({ success: false, error: `No machine login named ${A} exists on this database; reload the Database window.` });
    expect(block()).toBeUndefined();
  });

  it('M4 and M5 a streaming login without confirm: needsConfirm with RM-CONFIRM naming its machine, nothing changed', async () => {
    lane.slotActive = 'true';
    lane.client = '10.0.0.9';
    lane.addresses = JSON.stringify([{ slot: SA, machine: 'copy-a', host: 'a.invalid', port: 15433 }]);
    expect(await removeCopyLogin(bot(), A, false)).toEqual({ success: false, needsConfirm: true, error: `The machine with the login ${A} streams from this database now (copy-a). Removing its login ends that stream, drops its slot and takes its address off the list: its copy stops following this database, and other machines stop listing it within an hour. Its manager can join again while it holds this join code; make a new join code too if that machine should stay out. Remove it?` });
    expect(block()).toBeUndefined();
  });

  it('M4 with no address row the confirm names the client address', async () => {
    lane.slotActive = 'true';
    lane.client = '10.0.0.9';
    expect((await removeCopyLogin(bot(), A, false)).error).toContain(`streams from this database now (10.0.0.9).`);
  });

  it('M4 confirmed: the stream on its slot is ended at step 3 and the Remove finishes', async () => {
    lane.slotActive = 'true';
    lane.slotStates = ['true', 'false', 'absent'];
    expect(await removeCopyLogin(bot(), A, true)).toEqual({ success: true, text: DONE });
    expect(indexOf(`pg_terminate_backend(active_pid) FROM pg_catalog.pg_replication_slots WHERE slot_name = '${SA}'`)).toBeGreaterThan(indexOf("SELECT 'blocked|'"));
  });

  it('M6 a write fence stands: RM-FENCE, nothing changed', async () => {
    lane.rules.push({ match: "WHERE line LIKE '%", out: '2\n' });
    lane.rules.push({ match: 'smdb-fence-owner=', out: '-\n' });
    const r = await removeCopyLogin(bot(), A, true);
    expect(r.error).toMatch(new RegExp(`^The login ${A} was not removed: a write fence stands in pg_hba.conf \\(lines ending in .+\\); no lane of this manager set its lines; .+; nothing was changed\\.$`));
    expect(callOf("SELECT 'login|'")).toBeUndefined();
  });

  it('M6 whether a fence stands could not be read: RM-FENCE in that form', async () => {
    lane.rules.push({ match: "WHERE line LIKE '%", code: 1, err: 'ERROR:  permission denied for function pg_read_file\n' });
    expect((await removeCopyLogin(bot(), A, true)).error).toBe(`The login ${A} was not removed: whether a write fence stands in pg_hba.conf could not be read (ERROR:  permission denied for function pg_read_file); nothing was changed.`);
  });

  it('M7 the database is down: its refusal, nothing changed', async () => {
    lane.running = 'false';
    expect(await removeCopyLogin(bot(), A, true)).toEqual({ success: false, error: 'Database container is not running' });
  });

  it('M8 blocked|true|true|false goes on: 5b clears what an open session wrote', async () => {
    lane.rules.push({ match: "SELECT 'blocked|'", out: 'BEGIN\nDO\nALTER ROLE\nDO\nALTER ROLE\ncommitting\nCOMMIT\nblocked|true|true|false\n' });
    expect(await removeCopyLogin(bot(), A, false)).toEqual({ success: true, text: DONE });
  });

  it('M9 no blocked| line: RM-BLOCK with the reason, nothing after it', async () => {
    lane.rules.push({ match: "SELECT 'blocked|'", code: 3, out: 'BEGIN\n', err: `psql:<stdin>:2: ERROR:  role "${A}" is a member of role "smdb_copies"\n` });
    expect(await removeCopyLogin(bot(), A, false)).toEqual({ success: false, error: `The login ${A} was not removed: blocking it failed (role "${A}" is a member of role "smdb_copies"); nothing was changed.` });
    expect(callOf('pg_terminate_backend(pid, 5000)')).toBeUndefined();
  });

  it.each([
    ['false|true|true', 'its membership in smdb_copies'],
    ['true|false|true', 'its right to log in'],
    ['false|false|false', 'its membership in smdb_copies and its right to log in'],
  ])('M32 blocked|%s: RM-BLOCK-AGAIN names what came back', async (fields, what) => {
    lane.rules.push({ match: "SELECT 'blocked|'", out: `BEGIN\nDO\nALTER ROLE\nDO\nALTER ROLE\ncommitting\nCOMMIT\nblocked|${fields}\n` });
    expect(await removeCopyLogin(bot(), A, false)).toEqual({ success: false, error: `The login ${A} was blocked, but the check that followed found ${what} back; something with rights over roles changed it. Press Remove again to block it again and finish.` });
    expect(callOf('pg_terminate_backend(pid, 5000)')).toBeUndefined();
  });

  it('M10 and M11 a Remove that stopped after step 1 is finished by the next one, which blocks again first', async () => {
    lane.rules.push({ match: 'pg_catalog.count(pg_catalog.pg_terminate_backend(pid, 5000))', code: 1, err: 'ERROR:  canceling statement due to user request\n', once: true });
    expect(await removeCopyLogin(bot(), A, false)).toEqual({ success: false, error: stepText('ending its sessions', 'canceling statement due to user request') });
    lane.calls = [];
    lane.slotStates = ['absent'];
    expect(await removeCopyLogin(bot(), A, false)).toEqual({ success: true, text: DONE });
    expect(block()!.stdin).toBe(REMOVE_BLOCK_SQL(A));
  });

  it.each([
    ['replication off', { replication: undefined }, 'It is blocked: it cannot log in. Press Remove again to finish.'],
    ['a receive', { replication, receive: { startedAt: '2026-11-15T09:00:00.000Z', expiresAt: '2026-11-15T11:00:00.000Z', safetyDump: 'pre-receive-x.dump', pushId: '0123456789abcdef01234567', dbOid: '16384' } }, LISTED],
    ['a broken push', { replication, pushBroken: { at: '2026-11-15T09:00:00.000Z', safetyDump: 'x.dump' } }, LISTED],
  ])('RM-STEP with %s: the tick does not end the blocked login\'s sessions, so the text does not say it will; Remove still runs', async (_n, db, tail) => {
    const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf-8'));
    reg.instances[ID].fleetDb = { ...reg.instances[ID].fleetDb, ...db };
    fs.writeFileSync(REGISTRY, JSON.stringify(reg));
    lane.rules.push({ match: 'pg_catalog.count(pg_catalog.pg_terminate_backend(pid, 5000))', code: 1, err: 'ERROR:  canceling statement due to user request\n', once: true });
    expect(await removeCopyLogin(bot(), A, false)).toEqual({ success: false, error: `The login ${A} was not removed completely: ending its sessions failed (canceling statement due to user request). ${tail}` });
    lane.calls = [];
    lane.slotStates = ['absent'];
    expect(await removeCopyLogin(bot(), A, false)).toEqual({ success: true, text: DONE });
  });

  it('code review 1 finding 1: step 1 ends on the call\'s own time limit: the block can\'t be confirmed, never "nothing was changed"', async () => {
    lane.rules.push({ match: "SELECT 'blocked|'", hang: true });
    vi.useFakeTimers();
    try {
      const pending = removeCopyLogin(bot(), A, false);
      await vi.advanceTimersByTimeAsync(31_000);
      expect(await pending).toEqual({ success: false, error: `The manager can't confirm whether the login ${A} was blocked: the database did not answer within 30 s, and the block may still be applied there. Press Remove again to finish.` });
    } finally {
      vi.useRealTimers();
    }
    expect(callOf('pg_terminate_backend(pid, 5000)')).toBeUndefined();
  });

  it('code review 1 finding 1: step 1 stops on its 5 s lock limit: an ordinary failure with Postgres\'s reason', async () => {
    lane.rules.push({ match: "SELECT 'blocked|'", code: 3, out: 'BEGIN\nSET\nclosed|0\n', err: 'psql:<stdin>:6: ERROR:  canceling statement due to lock timeout\n' });
    expect(await removeCopyLogin(bot(), A, false)).toEqual({ success: false, error: `The login ${A} was not removed: blocking it failed (canceling statement due to lock timeout); nothing was changed.` });
  });

  it.each([
    ['1', 'its open session was ended'],
    ['3', 'its 3 open sessions were ended'],
  ])('code review 2 finding 1: step 1 ended %s sessions before the lock limit stopped it: the text says so', async (n, ended) => {
    lane.rules.push({ match: "SELECT 'blocked|'", code: 3, out: `BEGIN\nSET\nclosed|${n}\n`, err: 'psql:<stdin>:6: ERROR:  canceling statement due to lock timeout\n' });
    expect(await removeCopyLogin(bot(), A, false)).toEqual({ success: false, error: `The login ${A} was not removed: blocking it failed (canceling statement due to lock timeout); ${ended}; nothing else was changed.` });
  });

  it('M13 sessions still open after 10 seconds: RM-STEP ending its sessions', async () => {
    lane.rules.push({ match: 'pg_catalog.count(*) FROM pg_catalog.pg_stat_activity', out: '2\n' });
    expect(await removeCopyLogin(bot(), A, false)).toEqual({ success: false, error: stepText('ending its sessions', '2 of its sessions were still open after 10 seconds') });
    expect(callOf('SELECT pg_catalog.pg_drop_replication_slot')).toBeUndefined();
  }, 30_000);

  it('M16 the slot drop fails: RM-STEP dropping its slot', async () => {
    lane.rules.push({ match: 'SELECT pg_catalog.pg_drop_replication_slot', code: 1, err: `ERROR:  replication slot "${SA}" is active for PID 812\n` });
    expect(await removeCopyLogin(bot(), A, false)).toEqual({ success: false, error: stepText(`dropping its slot ${SA}`, `replication slot "${SA}" is active for PID 812`) });
  });

  it('M16 a stream takes the slot again after the drop', async () => {
    lane.slotStates = ['false', 'true'];
    expect((await removeCopyLogin(bot(), A, false)).error).toBe(stepText(`dropping its slot ${SA}`, 'a stream took it again'));
  });

  it('M17 no slot: step 3 drops nothing and the Remove goes on', async () => {
    lane.slotStates = ['absent'];
    expect(await removeCopyLogin(bot(), A, false)).toEqual({ success: true, text: DONE });
    expect(callOf('SELECT pg_catalog.pg_drop_replication_slot')).toBeUndefined();
    expect(callOf('pg_terminate_backend(active_pid)')).toBeUndefined();
  });

  it('M19 the row delete fails: RM-STEP taking its address off the list', async () => {
    lane.rules.push({ match: `DELETE FROM smdb_manager.addresses WHERE slot = '${SA}'`, code: 1, err: 'ERROR:  permission denied for table addresses\n' });
    expect((await removeCopyLogin(bot(), A, false)).error).toBe(stepText('taking its address off the list', 'permission denied for table addresses'));
  });

  it('M22 DROP OWNED in postgres fails: RM-STEP, nothing after it', async () => {
    lane.rules.push({ match: `DROP OWNED BY "${A}";`, code: 1, err: 'ERROR:  out of shared memory\n' });
    expect((await removeCopyLogin(bot(), A, false)).error).toBe(stepText('dropping what it owns in the postgres database', 'out of shared memory'));
    expect(callOf(`ALTER ROLE "${A}" LOGIN PASSWORD NULL;`)).toBeUndefined();
  });

  it('M24 the session in the bot\'s database fails: RM-STEP, and the closing NOLOGIN still runs', async () => {
    lane.rules.push({ match: 'DROP OWNED BY CURRENT_USER', code: 2, err: `psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  permission denied for database "smdb"\n` });
    expect((await removeCopyLogin(bot(), A, false)).error).toBe(stepText("dropping what it owns in the bot's database", 'connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  permission denied for database "smdb"'));
    expect(callOf(CLOSE)).toBeDefined();
    expect(callOf('DROP ROLE IF EXISTS')).toBeUndefined();
  });

  it('M24 the opening statement fails: no session, the closing NOLOGIN still runs', async () => {
    lane.rules.push({ match: `ALTER ROLE "${A}" LOGIN PASSWORD NULL;`, code: 3, err: 'psql:<stdin>:8: ERROR:  tuple concurrently updated\n' });
    expect((await removeCopyLogin(bot(), A, false)).error).toBe(stepText("dropping what it owns in the bot's database", 'tuple concurrently updated'));
    expect(callOf('DROP OWNED BY CURRENT_USER')).toBeUndefined();
    expect(callOf(CLOSE)).toBeDefined();
  });

  it('M25 the closing NOLOGIN fails: RM-REOPENED', async () => {
    lane.rules.push({ match: CLOSE, code: 1, err: 'ERROR:  tuple concurrently updated\n' });
    expect(await removeCopyLogin(bot(), A, false)).toEqual({ success: false, error: `The login ${A} was not removed completely: closing it again after dropping what it owned failed (tuple concurrently updated). It has no password, and other machines stop listing it within an hour, so no machine can log in with it from outside this database's container. Press Remove again to finish.` });
  });

  it('M26 step 1 of the next Remove closes a login left open: REMOVE_BLOCK_SQL sets NOLOGIN PASSWORD NULL', () => {
    expect(REMOVE_BLOCK_SQL(A)).toContain(`ALTER ROLE "${A}" NOLOGIN PASSWORD NULL;`);
  });

  it('M28 something still depends on it: RM-LEFT with the DETAIL line', async () => {
    lane.rules.push({ match: 'DROP ROLE IF EXISTS', code: 1, err: `ERROR:  role "${A}" cannot be dropped because some objects depend on it\nDETAIL:  1 object in database smdb\n` });
    expect(await removeCopyLogin(bot(), A, false)).toEqual({ success: false, error: `The login ${A} is blocked (it cannot log in, and other machines stop listing it within an hour), but it was not dropped: Postgres still records 1 object in database smdb. That is a right the bot's own login granted it in the bot's database, as a grant or a default privilege, which only the bot's login can take back. Press Remove again once it is revoked.` });
  });

  it('M29 another DROP ROLE failure: RM-STEP dropping the login', async () => {
    lane.rules.push({ match: 'DROP ROLE IF EXISTS', code: 1, err: 'ERROR:  out of shared memory\n' });
    expect((await removeCopyLogin(bot(), A, false)).error).toBe(stepText('dropping the login', 'out of shared memory'));
  });

  it('M30 a login already gone is dropped with IF EXISTS', async () => {
    expect((await removeCopyLogin(bot(), A, false)).success).toBe(true);
    expect(callOf('DROP ROLE IF EXISTS')!.args).toContain(`-c DROP ROLE IF EXISTS "${A}";`);
  });
});

describe('NM22 E32 New join code, then a refused fetch of the code (R47, module level)', () => {
  it('the renewal answers success and the fetch after it answers its own refusal', async () => {
    expect((await renewJoinCode(bot())).success).toBe(true);
    lane.copyRoles = 'copyroles|function-acl';
    expect(await getJoinCode(bot())).toEqual({ success: false, error: 'The logins that machines get with the join code are not set up as the manager needs (function-acl), so no join code was made; press Enable replication to set them up again' });
  });
});

const router = createBotRoutes({ clients: new Set() } as any);
const handlerOf = (method: string, routePath: string) => {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`no route ${method} ${routePath}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};
const route = async (method: 'get' | 'post' | 'delete', routePath: string, params: Record<string, string>, body: unknown = {}, query: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
  const res: any = { statusCode: 200 };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  await handlerOf(method, routePath)({ params, query, body }, res);
  return { status: res.statusCode, body: res.body };
};
const LOGIN_ROUTE = '/:id/fleet-replication/logins/:login';
const RENEW_ROUTE = '/:id/fleet-replication/join-code/renew';
const removeRoute = (login: string, body: unknown = {}) => route('delete', LOGIN_ROUTE, { id: ID, login }, body);
const RENEW_DONE = "Made a new join code and gave this machine's own login a new password. The old code no longer adds machines; machines that joined before keep their logins.";
const MIGRATING = { success: false as const, error: 'A move of this database is open; finish or cancel it first.' };

describe('NM22 the Remove route answers what removeCopyLogin answers (M1 to M32 through DELETE /fleet-replication/logins/:login)', () => {
  const fresh = (setup: () => void) => { resetLane(); lane.slotActive = 'false'; lane.slotStates = ['false', 'absent']; setup(); };
  const cases: Array<[string, string, boolean, () => void]> = [
    ['M1 an inactive login', A, false, () => {}],
    ['M2 the own login', OWN, true, () => {}],
    ['M3 a name off the pattern', 'replicator', true, () => {}],
    ['M3 no role of that name', A, true, () => { lane.roleExists = 'false'; }],
    ['M4 streaming, no confirm', A, false, () => { lane.slotActive = 'true'; lane.client = '10.0.0.9'; }],
    ['M4 streaming, confirmed', A, true, () => { lane.slotActive = 'true'; lane.slotStates = ['true', 'false', 'absent']; }],
    ['M6 a write fence', A, true, () => { lane.rules.push({ match: "WHERE line LIKE '%", code: 1, err: 'ERROR:  permission denied for function pg_read_file\n' }); }],
    ['M7 the database down', A, true, () => { lane.running = 'false'; }],
    ['M9 the block fails', A, false, () => { lane.rules.push({ match: "SELECT 'blocked|'", code: 3, out: 'BEGIN\n', err: 'psql:<stdin>:2: ERROR:  out of shared memory\n' }); }],
    ['M16 the slot drop fails', A, false, () => { lane.rules.push({ match: 'SELECT pg_catalog.pg_drop_replication_slot', code: 1, err: 'ERROR:  out of shared memory\n' }); }],
    ['M19 the row delete fails', A, false, () => { lane.rules.push({ match: `DELETE FROM smdb_manager.addresses WHERE slot = '${SA}'`, code: 1, err: 'ERROR:  permission denied for table addresses\n' }); }],
    ['M22 DROP OWNED in postgres fails', A, false, () => { lane.rules.push({ match: `DROP OWNED BY "${A}";`, code: 1, err: 'ERROR:  out of shared memory\n' }); }],
    ['M24 the session in the bot\'s database fails', A, false, () => { lane.rules.push({ match: 'DROP OWNED BY CURRENT_USER', code: 2, err: 'psql: error: FATAL:  permission denied for database "smdb"\n' }); }],
    ['M25 the closing NOLOGIN fails', A, false, () => { lane.rules.push({ match: CLOSE, code: 1, err: 'ERROR:  tuple concurrently updated\n' }); }],
    ['M28 something depends on it', A, false, () => { lane.rules.push({ match: 'DROP ROLE IF EXISTS', code: 1, err: `ERROR:  role "${A}" cannot be dropped because some objects depend on it\nDETAIL:  1 object in database smdb\n` }); }],
    ['M29 another DROP ROLE failure', A, false, () => { lane.rules.push({ match: 'DROP ROLE IF EXISTS', code: 1, err: 'ERROR:  out of shared memory\n' }); }],
    ['M32 the block undone', A, false, () => { lane.rules.push({ match: "SELECT 'blocked|'", out: 'BEGIN\nDO\nALTER ROLE\nDO\nALTER ROLE\ncommitting\nCOMMIT\nblocked|false|true|true\n' }); }],
  ];
  it.each(cases)('%s', async (_name, login, confirm, setup) => {
    fresh(setup);
    const viaRoute = await removeRoute(login, { confirm });
    const routeCalls = lane.calls.map(c => c.args);
    fresh(setup);
    const direct = await removeCopyLogin(bot(), login, confirm);
    expect(viaRoute).toEqual({ status: 200, body: direct });
    expect(routeCalls).toEqual(lane.calls.map(c => c.args));
  });

  it('M1 through the route: RM-DONE, and the login is taken from the path as sent', async () => {
    expect(await removeRoute(A, { confirm: false })).toEqual({ status: 200, body: { success: true, text: DONE } });
    expect(block()!.stdin).toBe(REMOVE_BLOCK_SQL(A));
  });

  it('M4 and M5: a confirm other than true is no confirm; nothing changed', async () => {
    lane.slotActive = 'true';
    for (const body of [{}, { confirm: 'true' }, { confirm: 1 }, undefined]) {
      const r = await removeRoute(A, body);
      expect(r.body.needsConfirm).toBe(true);
      expect(r.body.success).toBe(false);
    }
    expect(block()).toBeUndefined();
  });

  it('refused while a move of the database is open, before any docker call', async () => {
    h.migrating = MIGRATING;
    expect(await removeRoute(A, { confirm: true })).toEqual({ status: 409, body: MIGRATING });
    expect(lane.dockerCalls).toBe(0);
  });

  it('an unknown bot: 404, nothing run', async () => {
    expect(await route('delete', LOGIN_ROUTE, { id: 'nope', login: A }, { confirm: true })).toEqual({ status: 404, body: { success: false, error: 'Bot not found' } });
    expect(lane.dockerCalls).toBe(0);
  });
});

describe('NM22 the New join code route (E16 to E18, E32 through POST /fleet-replication/join-code/renew)', () => {
  it('E16 RENEW-DONE, and the join code route then gives a code with the new password', async () => {
    const before = bot().fleetDb!.replication!.password;
    expect(await route('post', RENEW_ROUTE, { id: ID })).toEqual({ status: 200, body: { success: true, text: RENEW_DONE } });
    expect(bot().fleetDb!.replication!.password).not.toBe(before);
    const code = await route('get', '/:id/fleet-replication/join-code', { id: ID });
    expect(code.body.success).toBe(true);
    expect(code.body.joinCode).toBeTruthy();
  });

  it('E17 the transaction fails: RENEW-FAIL', async () => {
    lane.rules.push({ match: "SELECT 'renewed'", code: 3, out: 'SET\nSET\nSET\nBEGIN\n', err: `psql:<stdin>:6: ERROR:  role "${OWN}" does not exist\n` });
    expect(await route('post', RENEW_ROUTE, { id: ID })).toEqual({ status: 200, body: { success: false, error: `The join code was not renewed (role "${OWN}" does not exist); the current code still works, and nothing was changed.` } });
  });

  it('E18 the join password save fails: RENEW-UNSAVED', async () => {
    h.replFails = ['disk full'];
    expect(await route('post', RENEW_ROUTE, { id: ID })).toEqual({ status: 200, body: { success: false, error: 'The old join code no longer adds machines, but the new password could not be saved (disk full), so no code can be shown for it; press New join code again.' } });
  });

  it('E32 the renewal succeeds and the join code route then answers its refusal', async () => {
    expect((await route('post', RENEW_ROUTE, { id: ID })).body.success).toBe(true);
    lane.copyRoles = 'copyroles|function-acl';
    expect(await route('get', '/:id/fleet-replication/join-code', { id: ID })).toEqual({ status: 200, body: { success: false, error: 'The logins that machines get with the join code are not set up as the manager needs (function-acl), so no join code was made; press Enable replication to set them up again' } });
  });

  it('R43 the join code route answers the note beside the code', async () => {
    lane.copyRoles = 'copyroles|role-settings';
    lane.holders = 'smdb_copies';
    const r = await route('get', '/:id/fleet-replication/join-code', { id: ID });
    expect(r.body.success).toBe(true);
    expect(r.body.joinCode).toBeTruthy();
    expect(r.body.note).toBe("Some logins carry session settings of their own, which the manager's sessions override: smdb_copies (press Enable replication).");
  });

  it('refused while a move of the database is open, before any docker call', async () => {
    h.migrating = MIGRATING;
    expect(await route('post', RENEW_ROUTE, { id: ID })).toEqual({ status: 409, body: MIGRATING });
    expect(lane.dockerCalls).toBe(0);
  });

  it('an unknown bot: 404, nothing run', async () => {
    expect(await route('post', RENEW_ROUTE, { id: 'nope' })).toEqual({ status: 404, body: { success: false, error: 'Bot not found' } });
    expect(lane.dockerCalls).toBe(0);
  });
});

describe('NM22 the delete route answers the notes as warning (R24)', () => {
  const DEL_ROW = "This machine's address could not be taken off the main's list (the main at main.invalid:15432 did not answer).";
  const DEL_LOGIN = `Its login ${OWN} stays on the main at main.invalid:15432 until the main's operator removes it in the Database window, which also drops its slot and any row left.`;
  const del = () => route('delete', '/:id', { id: ID }, {}, { keepData: 'false', keepEnv: 'false' });

  it('the notes deleteBot pushed come back as one warning, in order', async () => {
    h.deleteImpl = async (notes) => { notes.push(DEL_ROW, DEL_LOGIN); return true; };
    const r = await del();
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.warning).toBe(`${DEL_ROW} ${DEL_LOGIN}`);
  });

  it('no notes: no warning field', async () => {
    h.deleteImpl = async () => true;
    const r = await del();
    expect(r.body.success).toBe(true);
    expect('warning' in r.body).toBe(false);
  });

  it('a delete that found no bot answers 404 with no warning', async () => {
    h.deleteImpl = async (notes) => { notes.push(DEL_LOGIN); return false; };
    expect(await del()).toEqual({ status: 404, body: { success: false, error: 'Bot not found' } });
  });
});

const pageHtml = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
const pageFunction = (name: string): string => {
  let start = pageHtml.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`no function ${name}`);
  if (pageHtml.slice(start - 6, start) === 'async ') start -= 6;
  let i = pageHtml.indexOf('(', start);
  for (let depth = 0; ; i++) {
    if (pageHtml[i] === '(') depth++;
    else if (pageHtml[i] === ')' && --depth === 0) break;
  }
  i = pageHtml.indexOf('{', i);
  for (let depth = 0; ; i++) {
    if (pageHtml[i] === '{') depth++;
    else if (pageHtml[i] === '}' && --depth === 0) return pageHtml.slice(start, i + 1);
  }
};

type PageEl = { innerHTML: string; textContent: string; value?: string; disabled?: boolean; isConnected: boolean; checked?: boolean };
const page = (names: string[], answers: unknown[], extra: Record<string, unknown> = {}) => {
  const els: Record<string, PageEl> = {};
  const calls: Array<[string, string, unknown]> = [];
  const confirms: string[] = [];
  const messages: string[][] = [];
  const reads: string[] = [];
  const ctx = vm.createContext({
    api: async (method: string, url: string, body?: unknown) => {
      calls.push([method, url, body]);
      const a = answers.shift();
      if (a instanceof Error) throw a;
      return a;
    },
    confirm: (text: string) => { confirms.push(text); return extra.confirmAnswer !== false; },
    window: { confirm: (text: string) => { confirms.push(text); return extra.confirmAnswer !== false; } },
    showMessage: (type: string, text: string) => { messages.push([type, text]); },
    showNoAnswer: (op: string) => { messages.push(['noanswer', op]); },
    renderFleetReplication: (id: string) => { reads.push(`replication:${id}`); },
    renderFleetSwitch: () => {},
    loadBots: async () => {},
    panelHasEntry: () => false,
    setTimeout: () => 0,
    fleetBackupBotId: 'm',
    bots: [],
    document: { getElementById: (id: string) => (els[id] ??= { innerHTML: '', textContent: '', isConnected: true }) },
    navigator: { clipboard: { writeText: async () => undefined } },
    Array, String, Number, JSON, Date, Math, Object, encodeURIComponent,
    ...extra,
  });
  vm.runInContext(['escapeHtml', 'jsArg', ...names].map(pageFunction).join('\n'), ctx);
  return { ctx: ctx as any, els, calls, confirms, messages, reads };
};
const noAnswer = () => Object.assign(new Error('No answer from the manager'), { noAnswer: true });
const lines = (html: string) => [...html.matchAll(/<div class="(?:env-tip|error-message)"[^>]*>(.*?)<\/div>/g)].map(m => m[1].replace(/<button[^>]*>[^<]*<\/button>/g, '').replace(/<[^>]+>/g, '').trim());
const buttonsOf = (html: string) => [...html.matchAll(/<button [^>]*>([^<]*)<\/button>/g)].map(m => m[1]);

describe('NM22 the Machine logins list (3.11 as R4 amends it)', () => {
  const entry = (over: Record<string, unknown>) => ({ login: A, own: false, member: true, canLogin: true, slot: SA, slotState: 'absent', machine: 'copy-a', address: 'a.invalid:15433', client: null, ...over });
  const render = async (logins: unknown, extraReplication: Record<string, unknown> = {}) => {
    const answer = { success: true, replication: { enabled: true, publicHost: 'main.example', hostPort: 5433, live: { sslOn: true, standbys: [], slots: [], slotWalKeep: '4096MB', ...(logins === undefined ? {} : { logins }) }, ...extraReplication } };
    const p = page(['renderFleetReplication'], [answer]);
    await p.ctx.renderFleetReplication('m');
    return p.els['fleet-replication-body'].innerHTML as string;
  };

  it('one line per state, the own login marked, a Remove button on every other line', async () => {
    const html = await render([
      entry({ login: OWN, own: true, slot: null, machine: 'main.example' }),
      entry({ slotState: 'active', client: '10.0.0.9' }),
      entry({ login: 'smdb_copy_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', slotState: 'kept', machine: null }),
      entry({ login: 'smdb_copy_cccccccccccccccccccccccccccccccc', slotState: 'lost', machine: 'copy-c' }),
      entry({ login: 'smdb_copy_dddddddddddddddddddddddddddddddd', slotState: 'absent', machine: 'copy-d' }),
      entry({ login: 'smdb_copy_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', canLogin: false, machine: 'copy-e' }),
      entry({ login: 'smdb_copy_ffffffffffffffffffffffffffffffff', member: false, canLogin: false, machine: null }),
    ]);
    const at = lines(html).indexOf('Machine logins');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines(html).slice(at + 1, at + 8)).toEqual([
      `main.example (${OWN}) (this machine): no slot`,
      `copy-a (${A}): streaming from 10.0.0.9`,
      'no address listed (smdb_copy_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb): not connected',
      'copy-c (smdb_copy_cccccccccccccccccccccccccccccccc): not connected',
      'copy-d (smdb_copy_dddddddddddddddddddddddddddddddd): no slot',
      'copy-e (smdb_copy_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee): closed (replication was disabled)',
      'no address listed (smdb_copy_ffffffffffffffffffffffffffffffff): blocked, not removed yet',
    ]);
    expect(buttonsOf(html).filter(b => b === 'Remove')).toHaveLength(6);
    expect(html).not.toContain(`removeMachineLogin('m', &quot;${OWN}&quot;)`);
    expect(html).toContain(`removeMachineLogin('m', &quot;${A}&quot;)`);
  });

  it('a list the main could not read says so', async () => {
    expect(lines(await render(undefined))).toContain('The machine logins could not be read.');
  });

  it('New join code sits beside Copy join code', async () => {
    const b = buttonsOf(await render([]));
    expect(b.indexOf('New join code')).toBe(b.indexOf('Copy join code') + 1);
  });

  it('the unfinished-Disable notice names the join login and the machines\' logins (R11)', async () => {
    const since = '2026-11-01T10:00:00.000Z';
    const html = await render([], { disablingSince: since });
    expect(lines(html)).toContain(`A Disable of replication started on ${new Date(since).toLocaleString()} did not finish: some of its steps may already have run (the join login and the machines' logins may be closed, the copies' slots dropped). Press Disable replication to finish it.`);
  });
});

describe('NM22 Remove on the page (3.11)', () => {
  const url = `/bots/m/fleet-replication/logins/${A}`;
  it('an inactive login: one call, RM-DONE, the list read again', async () => {
    const p = page(['removeMachineLogin'], [{ success: true, text: DONE }]);
    await p.ctx.removeMachineLogin('m', A);
    expect(p.calls).toEqual([['DELETE', url, { confirm: false }]]);
    expect(p.confirms).toEqual([]);
    expect(p.messages).toEqual([['success', DONE]]);
    expect(p.reads).toEqual(['replication:m']);
  });

  it('a streaming login: RM-CONFIRM asked, then the call again with confirm', async () => {
    const q = `The machine with the login ${A} streams from this database now (copy-a). Remove it?`;
    const p = page(['removeMachineLogin'], [{ success: false, needsConfirm: true, error: q }, { success: true, text: DONE }]);
    await p.ctx.removeMachineLogin('m', A);
    expect(p.confirms).toEqual([q]);
    expect(p.calls).toEqual([['DELETE', url, { confirm: false }], ['DELETE', url, { confirm: true }]]);
    expect(p.messages).toEqual([['success', DONE]]);
  });

  it('the confirm declined: nothing removed, one call', async () => {
    const p = page(['removeMachineLogin'], [{ success: false, needsConfirm: true, error: 'Q' }], { confirmAnswer: false });
    await p.ctx.removeMachineLogin('m', A);
    expect(p.calls).toHaveLength(1);
    expect(p.messages).toEqual([['info', 'Nothing was removed']]);
  });

  it('a refusal or a failed step is shown as the server gave it', async () => {
    const p = page(['removeMachineLogin'], [{ success: false, error: stepText('dropping the login', 'out of shared memory') }]);
    await p.ctx.removeMachineLogin('m', A);
    expect(p.messages).toEqual([['error', stepText('dropping the login', 'out of shared memory')]]);
    expect(p.reads).toEqual(['replication:m']);
  });

  it('no answer: the manager may still be running it, and the list is read again', async () => {
    const p = page(['removeMachineLogin'], [noAnswer()]);
    await p.ctx.removeMachineLogin('m', A);
    expect(p.messages).toEqual([['noanswer', 'login removal']]);
    expect(p.reads).toEqual(['replication:m']);
  });
});

describe('NM22 the join code\'s note and New join code on the page (R43, R47, E32)', () => {
  const NOTE = "Some logins carry session settings of their own, which the manager's sessions override: smdb_copies (press Enable replication).";
  const COPIED = 'Join code copied. It holds database passwords: paste it only into your own managers.';
  const JC = 'The logins that machines get with the join code are not set up as the manager needs (function-acl), so no join code was made; press Enable replication to set them up again';
  const RENEW_ASK = "Make a new join code? The current code stops adding machines at once, and its open sessions on this database are ended. This machine's own login also gets a new password. Machines that joined already keep their own logins.";

  it('copy with a note: one warning message holding both texts', async () => {
    const p = page(['fetchJoinCode', 'copyJoinCode'], [{ success: true, joinCode: 'smdbjoin1.abc', note: NOTE }]);
    await p.ctx.copyJoinCode('m');
    expect(p.messages).toEqual([['warning', `${COPIED} ${NOTE}`]]);
  });

  it('copy without a note: the success message alone', async () => {
    const p = page(['fetchJoinCode', 'copyJoinCode'], [{ success: true, joinCode: 'smdbjoin1.abc' }]);
    await p.ctx.copyJoinCode('m');
    expect(p.messages).toEqual([['success', COPIED]]);
  });

  it('show with a note: the code in the field and the note as one warning; without a note no message', async () => {
    const p = page(['fetchJoinCode', 'showJoinCode'], [{ success: true, joinCode: 'smdbjoin1.abc', note: NOTE }, { success: true, joinCode: 'smdbjoin1.def' }]);
    await p.ctx.showJoinCode('m');
    expect(p.els['fleet-join-code-shown'].innerHTML).toContain('smdbjoin1.abc');
    expect(p.messages).toEqual([['warning', NOTE]]);
    await p.ctx.showJoinCode('m');
    expect(p.els['fleet-join-code-shown'].innerHTML).toContain('smdbjoin1.def');
    expect(p.messages).toHaveLength(1);
  });

  it.each(['copyJoinCode', 'showJoinCode'])('%s on a refused fetch: one error message; on no answer, the no-answer message', async (fn) => {
    const p = page(['fetchJoinCode', fn], [{ success: false, error: JC }, { success: false }, noAnswer()]);
    await p.ctx[fn]('m');
    await p.ctx[fn]('m');
    await p.ctx[fn]('m');
    expect(p.messages).toEqual([['error', JC], ['error', 'No join code was made'], ['noanswer', 'join code']]);
  });

  it('New join code asks RENEW-ASK, renews, then fetches and shows the code with RENEW-DONE', async () => {
    const p = page(['fetchJoinCode', 'renewJoinCode'], [{ success: true, text: RENEW_DONE }, { success: true, joinCode: 'smdbjoin1.new' }]);
    await p.ctx.renewJoinCode('m');
    expect(p.confirms).toEqual([RENEW_ASK]);
    expect(p.calls).toEqual([['POST', '/bots/m/fleet-replication/join-code/renew', {}], ['GET', '/bots/m/fleet-replication/join-code', undefined]]);
    expect(p.els['fleet-join-code-shown'].innerHTML).toContain('smdbjoin1.new');
    expect(p.messages).toEqual([['success', RENEW_DONE]]);
  });

  it('New join code with a note: one warning message holding both texts', async () => {
    const p = page(['fetchJoinCode', 'renewJoinCode'], [{ success: true, text: RENEW_DONE }, { success: true, joinCode: 'smdbjoin1.new', note: NOTE }]);
    await p.ctx.renewJoinCode('m');
    expect(p.messages).toEqual([['warning', `${RENEW_DONE} ${NOTE}`]]);
  });

  it('E32 the fetch after the renewal is refused or gets no answer: RENEW-NOCODE in one error message', async () => {
    const refused = page(['fetchJoinCode', 'renewJoinCode'], [{ success: true, text: RENEW_DONE }, { success: false, error: JC }]);
    await refused.ctx.renewJoinCode('m');
    expect(refused.messages).toEqual([['error', `${RENEW_DONE} But the code could not be shown: ${JC}`]]);
    const lost = page(['fetchJoinCode', 'renewJoinCode'], [{ success: true, text: RENEW_DONE }, noAnswer()]);
    await lost.ctx.renewJoinCode('m');
    expect(lost.messages).toEqual([['error', `${RENEW_DONE} But the code could not be shown: the manager did not answer`]]);
  });

  it('the confirm declined: no call; a refused renewal: its error alone, no fetch', async () => {
    const declined = page(['fetchJoinCode', 'renewJoinCode'], [], { confirmAnswer: false });
    await declined.ctx.renewJoinCode('m');
    expect(declined.calls).toEqual([]);
    const err = 'The join code was not renewed (x); the current code still works, and nothing was changed.';
    const refused = page(['fetchJoinCode', 'renewJoinCode'], [{ success: false, error: err }]);
    await refused.ctx.renewJoinCode('m');
    expect(refused.calls).toHaveLength(1);
    expect(refused.messages).toEqual([['error', err]]);
  });

  it('New join code with no answer: the no-answer message, no fetch', async () => {
    const p = page(['fetchJoinCode', 'renewJoinCode'], [noAnswer()]);
    await p.ctx.renewJoinCode('m');
    expect(p.calls).toHaveLength(1);
    expect(p.messages).toEqual([['noanswer', 'join code renewal']]);
  });
});

describe('NM22 the replication panel\'s refresh keeps a shown join code (code review 1 lane B finding 1)', () => {
  const enabled = () => ({ success: true, replication: { enabled: true, publicHost: 'main.example', hostPort: 5433, live: { sslOn: true, standbys: [], slots: [], slotWalKeep: '4096MB', logins: [] } } });
  const panel = (answers: unknown[]) => {
    const timers: Array<() => void> = [];
    const els: Record<string, any> = {};
    els['fleet-join-code-shown'] = { innerHTML: '', textContent: '', isConnected: true };
    els['fleet-replication-body'] = {
      innerHTML: '', textContent: '', isConnected: true,
      querySelector: (sel: string) => sel === '#fleet-join-code-shown textarea' && els['fleet-join-code-shown'].innerHTML.includes('<textarea') ? {} : null,
    };
    const p = page(['renderFleetReplication', 'fetchJoinCode', 'renewJoinCode', 'showJoinCode', 'hideJoinCode'], answers, {
      setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; },
      document: { getElementById: (id: string) => (els[id] ??= { innerHTML: '', textContent: '', isConnected: true }) },
    });
    const reads = () => p.calls.filter(c => c[0] === 'GET' && c[1] === '/bots/m/fleet-replication').length;
    const tick = async () => { timers.shift()!(); for (let i = 0; i < 5; i++) await Promise.resolve(); };
    return { ...p, els, timers, reads, tick };
  };

  it('after New join code the next tick leaves the code in the field and checks again; after Hide it refreshes', async () => {
    const p = panel([enabled(), { success: true, text: RENEW_DONE }, { success: true, joinCode: 'smdbjoin1.new' }, enabled()]);
    await p.ctx.renderFleetReplication('m');
    expect(p.timers).toHaveLength(1);
    await p.ctx.renewJoinCode('m');
    expect(p.els['fleet-join-code-shown'].innerHTML).toContain('smdbjoin1.new');
    await p.tick();
    expect(p.reads()).toBe(1);
    expect(p.els['fleet-join-code-shown'].innerHTML).toContain('smdbjoin1.new');
    expect(p.timers).toHaveLength(1);
    p.ctx.hideJoinCode();
    await p.tick();
    expect(p.reads()).toBe(2);
  });

  it('after Show the next tick leaves the code in the field and checks again', async () => {
    const p = panel([enabled(), { success: true, joinCode: 'smdbjoin1.abc' }, enabled()]);
    await p.ctx.renderFleetReplication('m');
    await p.ctx.showJoinCode('m');
    await p.tick();
    await p.tick();
    expect(p.reads()).toBe(1);
    expect(p.els['fleet-join-code-shown'].innerHTML).toContain('smdbjoin1.abc');
    expect(p.timers).toHaveLength(1);
  });
});

describe('NM22 the delete\'s warning and the Disable confirm on the page (R36, R11)', () => {
  const W = `Its login ${OWN} stays on the main at main.invalid:15432 until the main's operator removes it in the Database window, which also drops its slot and any row left.`;
  const del = (answer: unknown) => {
    const checks: Record<string, boolean> = { 'delete-also-data': true, 'delete-also-env': false };
    return page(['confirmDeleteBot'], [answer], {
      bots: [], deleteBotId: 'b1', busyBots: new Set(), isTransientStatus: () => false,
      document: { getElementById: (id: string) => ({ checked: checks[id] }) },
      hideDeleteModal: () => {}, renderBots: () => {},
    });
  };

  it('a delete with a warning: one message of type warning holding both texts', async () => {
    const p = del({ success: true, vaulted: false, envDeleted: false, warning: W });
    await p.ctx.confirmDeleteBot();
    expect(p.messages).toEqual([['warning', `Bot removed. ${W}`]]);
  });

  it('a delete without a warning: the success message as before', async () => {
    const p = del({ success: true, vaulted: false, envDeleted: false });
    await p.ctx.confirmDeleteBot();
    expect(p.messages).toEqual([['success', 'Bot removed']]);
  });

  it('the Disable confirm names the join login and every machine\'s login (R11)', async () => {
    const p = page(['disableFleetReplication'], [{ success: true }], { confirmAnswer: false });
    await p.ctx.disableFleetReplication('m');
    expect(p.confirms).toEqual(['Disable replication?\n\nRefused while a copy streams or a seed copies this database, or while a backup or restore runs. Otherwise the inactive copies\' slots are dropped and the join login and every machine\'s login are closed at once; the published port closes at the next restart, and a database URL that names this database is set back to its private form then.']);
  });
});

const T_B = '/api/bots/b1';
const T_LOGIN_B = 'smdb_copy_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const T_NOTE = "Some logins carry session settings of their own, which the manager's sessions override: smdb_copies (press Enable replication).";
const T_JC = 'The logins that machines get with the join code are not set up as the manager needs (function-acl), so no join code was made; press Enable replication to set them up again';
const T_RM_Q = `The machine with the login ${A} streams from this database now (copy-a). Removing its login ends that stream, drops its slot and takes its address off the list: its copy stops following this database, and other machines stop listing it within an hour. Its manager can join again while it holds this join code; make a new join code too if that machine should stay out. Remove it?`;
const T_RENEW_ASK = "Make a new join code? The current code stops adding machines at once, and its open sessions on this database are ended. This machine's own login also gets a new password. Machines that joined already keep their own logins.";
const tLogin = (over: Record<string, unknown> = {}) => ({ login: A, own: false, member: true, canLogin: true, slot: SA, slotState: 'absent', machine: 'copy-a', address: 'a.invalid:15433', client: null, ...over });
const tReplication = (logins?: unknown) => ({ enabled: true, publicHost: 'main.example', hostPort: 15432, live: { sslOn: true, standbys: [], slots: [], slotWalKeep: '4096MB', ...(logins === undefined ? {} : { logins }) } });
const tUntil = async (test: () => boolean) => {
  for (const end = Date.now() + 5000; Date.now() < end && !test();) await new Promise(r => setTimeout(r, 10));
  expect(test()).toBe(true);
};
const tEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('NM22 the terminal\'s Database screen: the logins list, Remove and New join code (3.11, R11, R43, R47)', () => {
  const open: DatabaseScreen[] = [];
  afterEach(() => { for (const s of open.splice(0)) s.close(); });

  const screen = async (logins: unknown, routes: Record<string, unknown> = {}) => {
    const f = fake().on('GET', `${T_B}/fleet-replication`, replicationOn(tReplication(logins)));
    for (const [k, v] of Object.entries(routes)) {
      const [method, p] = k.split(' ');
      f.on(method, p, v as never);
    }
    const shown: Array<{ title: string; code: string; notes: string[] }> = [];
    const reports: Array<{ ok: boolean | null; text: string }> = [];
    const b = mainBot();
    const source = { bot: () => b, list: { bots: [b], readAt: 0, error: null } };
    const s = new DatabaseScreen(f.client, () => {}, 'b1', source as never, { everyMs: 60_000, limitMs: 2000, env: { HOST_DATA_DIR: '/srv/smdb/data' }, timeZone: 'UTC' },
      (r) => { reports.push(r as never); }, (c) => { shown.push(c); return true; });
    open.push(s);
    s.open();
    await tUntil(() => s.actionRows().some(r => r.kind === 'disable'));
    const pick = (label: string) => {
      const i = s.actionRows().findIndex(r => r.label === label);
      expect(i).toBeGreaterThanOrEqual(0);
      s.key('a', {});
      for (let k = 0; k < i; k++) s.key('', { downArrow: true });
      s.key('', { return: true });
    };
    const dialog = () => s.view(100, 80).body.join(' ').replace(/\s+/g, ' ');
    const yes = () => { s.view(100, 80); s.key('y', {}); };
    const sent = () => f.calls.filter(c => c.method !== 'GET' || c.path.endsWith('/join-code')).map(c => [c.method, c.path, c.body]);
    return { s, f, shown, reports, pick, dialog, yes, sent };
  };
  const RM_PATH = `${T_B}/fleet-replication/logins/${A}`;
  const RENEW_PATH = `${T_B}/fleet-replication/join-code/renew`;
  const CODE_PATH = `${T_B}/fleet-replication/join-code`;

  it('the Actions list: Remove on every login but the own one, then New join code, then Disable', () => {
    const read = (logins?: unknown) => ({ replication: { ok: true as const, value: { replication: tReplication(logins) as never } } });
    const logins = [tLogin({ login: OWN, own: true, machine: 'main' }), tLogin({ slotState: 'active', client: '10.0.0.5' }), tLogin({ login: T_LOGIN_B, member: false, machine: null })];
    expect(actionRows('main', read(logins))).toEqual([
      { kind: 'remove-login', label: `Remove the login ${A} (copy-a)`, login: A },
      { kind: 'remove-login', label: `Remove the login ${T_LOGIN_B}`, login: T_LOGIN_B },
      { kind: 'renew-code', label: 'New join code' },
      { kind: 'disable', label: 'Disable replication' },
    ]);
    expect(actionRows('main', read()).map(r => r.kind)).toEqual(['renew-code', 'disable']);
    expect(actionRows('main', { replication: { ok: true, value: { replication: { enabled: false } } } }).map(r => r.kind)).toEqual(['enable']);
  });

  it('the Machine logins lines, one per state, the own login marked; an unread list says so', () => {
    const text = (rep: unknown) => replicationLines({ ok: true, value: { replication: rep as never } }, () => 'then').map(l => l.text);
    const C = 'smdb_copy_cccccccccccccccccccccccccccccccc';
    const D = 'smdb_copy_dddddddddddddddddddddddddddddddd';
    const all = text(tReplication([
      tLogin({ login: OWN, own: true, machine: 'main' }),
      tLogin({ slotState: 'active', client: '10.0.0.5' }),
      tLogin({ login: T_LOGIN_B, slotState: 'kept', machine: null }),
      tLogin({ login: C, member: false, machine: 'copy-c' }),
      tLogin({ login: D, canLogin: false, machine: 'copy-d', slotState: 'active' }),
    ]));
    const at = all.indexOf('Machine logins');
    expect(at).toBeGreaterThan(0);
    expect(all.slice(at)).toEqual([
      'Machine logins',
      `main (${OWN}) (this machine): no slot`,
      `copy-a (${A}): streaming from 10.0.0.5`,
      `no address listed (${T_LOGIN_B}): not connected`,
      `copy-c (${C}): blocked, not removed yet`,
      `copy-d (${D}): closed (replication was disabled)`,
    ]);
    expect(text(tReplication())).toContain('The machine logins could not be read.');
    expect(text({ ...tReplication(), live: undefined }).join(' ')).not.toContain('logins');
  });

  it('the Disable question and the unfinished-Disable line name the join login and the machines\' logins (R11)', () => {
    expect(DISABLE_QUESTION).toEqual([
      'Disable replication?',
      'Refused while a copy streams or a seed copies this database, or while a backup or restore runs. Otherwise the inactive copies\' slots are dropped and the join login and every machine\'s login are closed at once; the published port closes at the next restart, and a database URL that names this database is set back to its private form then.',
    ]);
    const lines = replicationLines({ ok: true, value: { replication: { ...tReplication([]), disablingSince: '2026-11-14T08:00:00.000Z' } as never } }, () => 'Nov 14 08:00').map(l => l.text);
    expect(lines).toContain("A Disable of replication started on Nov 14 08:00 did not finish: some of its steps may already have run (the join login and the machines' logins may be closed, the copies' slots dropped). Press Disable replication to finish it.");
  });

  it('Remove on a login that does not stream: one call with confirm false, the answer\'s text', async () => {
    const t = await screen([tLogin()], { [`DELETE ${RM_PATH}`]: cliOk({ success: true, text: DONE }) });
    t.pick(`Remove the login ${A} (copy-a)`);
    await tUntil(() => t.s.notice !== null);
    expect(t.sent()).toEqual([['DELETE', RM_PATH, { confirm: false }]]);
    expect(t.s.notice).toBe(DONE);
    expect(t.reports.at(-1)).toEqual({ ok: true, text: DONE });
  });

  it('Remove on a streaming login: the server\'s RM-CONFIRM asked, then the call again with confirm true', async () => {
    const t = await screen([tLogin({ slotState: 'active', client: '10.0.0.5' })], {
      [`DELETE ${RM_PATH}`]: (body: any) => cliOk(body.confirm === true ? { success: true, text: DONE } : { success: false, needsConfirm: true, error: T_RM_Q }),
    });
    t.pick(`Remove the login ${A} (copy-a)`);
    await tUntil(() => t.dialog().includes('Remove it?'));
    expect(t.dialog()).toContain(T_RM_Q);
    t.yes();
    await tUntil(() => t.s.notice !== null);
    expect(t.sent()).toEqual([['DELETE', RM_PATH, { confirm: false }], ['DELETE', RM_PATH, { confirm: true }]]);
    expect(t.s.notice).toBe(DONE);
  });

  it('Remove\'s question declined: one call, nothing removed', async () => {
    const t = await screen([tLogin({ slotState: 'active' })], { [`DELETE ${RM_PATH}`]: cliOk({ success: false, needsConfirm: true, error: T_RM_Q }) });
    t.pick(`Remove the login ${A} (copy-a)`);
    await tUntil(() => t.dialog().includes('Remove it?'));
    t.s.key('n', {});
    expect(t.s.notice).toBe('Cancelled: nothing was removed.');
    expect(t.sent()).toEqual([['DELETE', RM_PATH, { confirm: false }]]);
  });

  it('Remove refused, a step failed, or no answer: the server\'s text, or the may-still-be-running text', async () => {
    const STEP = stepText('dropping its slot ' + SA, 'boom');
    const a = await screen([tLogin()], { [`DELETE ${RM_PATH}`]: cliOk({ success: false, error: STEP }) });
    a.pick(`Remove the login ${A} (copy-a)`);
    await tUntil(() => a.s.notice !== null);
    expect(a.s.notice).toBe(STEP);
    expect(a.reports.at(-1)?.ok).toBe(false);
    const b = await screen([tLogin()], { [`DELETE ${RM_PATH}`]: cliNoAnswer() });
    b.pick(`Remove the login ${A} (copy-a)`);
    await tUntil(() => b.s.notice !== null);
    expect(b.s.notice).toMatch(/^No answer from the manager \(.+\); the login removal may still be running\. Check its state before trying again\.$/);
    expect(b.reports.at(-1)?.ok).toBe(null);
  });

  it('New join code: RENEW-ASK, the renewal, then the code on the code screen and RENEW-DONE', async () => {
    const t = await screen([], { [`POST ${RENEW_PATH}`]: cliOk({ success: true, text: RENEW_DONE }), [`GET ${CODE_PATH}`]: cliOk({ success: true, joinCode: 'CODE-1' }) });
    t.pick('New join code');
    expect(t.dialog()).toContain(T_RENEW_ASK);
    expect(t.sent()).toEqual([]);
    t.yes();
    await tUntil(() => t.s.notice !== null);
    expect(t.sent()).toEqual([['POST', RENEW_PATH, {}], ['GET', CODE_PATH, undefined]]);
    expect(t.shown).toEqual([{ title: 'Join code of mybot', code: 'CODE-1', notes: JOIN_CODE_NOTES }]);
    expect(t.s.notice).toBe(RENEW_DONE);
    expect(t.reports.at(-1)).toEqual({ ok: true, text: RENEW_DONE });
  });

  it('New join code with a note: the note under the code and in the one line (R43)', async () => {
    const t = await screen([], { [`POST ${RENEW_PATH}`]: cliOk({ success: true, text: RENEW_DONE }), [`GET ${CODE_PATH}`]: cliOk({ success: true, joinCode: 'CODE-1', note: T_NOTE }) });
    t.pick('New join code');
    t.yes();
    await tUntil(() => t.s.notice !== null);
    expect(t.shown).toEqual([{ title: 'Join code of mybot', code: 'CODE-1', notes: [...JOIN_CODE_NOTES, T_NOTE] }]);
    expect(t.s.notice).toBe(`${RENEW_DONE} ${T_NOTE}`);
  });

  it('E32 in the terminal: the fetch after the renewal is refused, empty or unanswered: RENEW-NOCODE in one line', async () => {
    for (const [answer, reason] of [
      [cliOk({ success: false, error: T_JC }), T_JC],
      [cliOk({ success: true }), 'No join code was made'],
      [cliRefused(500, { success: false }), 'No join code was made'],
    ] as const) {
      const t = await screen([], { [`POST ${RENEW_PATH}`]: cliOk({ success: true, text: RENEW_DONE }), [`GET ${CODE_PATH}`]: answer });
      t.pick('New join code');
      t.yes();
      await tUntil(() => t.s.notice !== null);
      expect(t.s.notice).toBe(`${RENEW_DONE} But the code could not be shown: ${reason}`);
      expect(t.reports.at(-1)?.ok).toBe(false);
      expect(t.shown).toEqual([]);
    }
    const t = await screen([], { [`POST ${RENEW_PATH}`]: cliOk({ success: true, text: RENEW_DONE }), [`GET ${CODE_PATH}`]: cliNoAnswer() });
    t.pick('New join code');
    t.yes();
    await tUntil(() => t.s.notice !== null);
    expect(t.s.notice).toMatch(new RegExp(`^${tEscape(RENEW_DONE)} But the code could not be shown: the manager did not answer \\(.+\\)$`));
    expect(t.shown).toEqual([]);
  });

  it('New join code declined, refused or unanswered: no fetch', async () => {
    const a = await screen([], { [`POST ${RENEW_PATH}`]: cliOk({ success: true, text: RENEW_DONE }) });
    a.pick('New join code');
    a.s.view(100, 80);
    a.s.key('n', {});
    expect(a.s.notice).toBe('Cancelled: no new join code was made.');
    expect(a.sent()).toEqual([]);
    const FAIL = 'The join code was not renewed (boom); the current code still works, and nothing was changed.';
    const b = await screen([], { [`POST ${RENEW_PATH}`]: cliOk({ success: false, error: FAIL }) });
    b.pick('New join code');
    b.yes();
    await tUntil(() => b.s.notice !== null);
    expect(b.s.notice).toBe(FAIL);
    expect(b.sent()).toEqual([['POST', RENEW_PATH, {}]]);
    const c = await screen([], { [`POST ${RENEW_PATH}`]: cliNoAnswer() });
    c.pick('New join code');
    c.yes();
    await tUntil(() => c.s.notice !== null);
    expect(c.s.notice).toMatch(/^No answer from the manager \(.+\); the join code renewal may still be running\. Check its state before trying again\.$/);
    expect(c.sent()).toEqual([['POST', RENEW_PATH, {}]]);
  });

  it('J shows the join code\'s note under the code (R43)', async () => {
    const t = await screen([], { [`GET ${CODE_PATH}`]: cliOk({ success: true, joinCode: 'CODE-2', note: T_NOTE }) });
    t.s.key('j', {});
    await tUntil(() => t.shown.length > 0);
    expect(t.shown).toEqual([{ title: 'Join code of mybot', code: 'CODE-2', notes: [...JOIN_CODE_NOTES, T_NOTE] }]);
    const u = await screen([], { [`GET ${CODE_PATH}`]: cliOk({ success: true, joinCode: 'CODE-3' }) });
    u.s.key('j', {});
    await tUntil(() => u.shown.length > 0);
    expect(u.shown[0].notes).toEqual(JOIN_CODE_NOTES);
  });

  it('the replication read carries the logins as the route gives them', async () => {
    const logins = [tLogin()];
    const f = fake().on('GET', `${T_B}/fleet-replication`, replicationOn(tReplication(logins)));
    const r = await readReplication(f.client, 'b1', 2000);
    expect(r.ok === true && r.value.replication?.live?.logins).toEqual(logins);
  });
});

describe('NM22 the delete\'s warning in the terminal and in `dbm bots delete` (R36, R42)', () => {
  const W = `Its login ${OWN} stays on the main at main.invalid:15432 until the main's operator removes it in the Database window, which also drops its slot and any row left.`;

  it('the terminal\'s delete line holds the success text and the warning', async () => {
    const f = fake()
      .on('DELETE', '/api/bots/b1?keepData=false&keepEnv=true', cliOk({ success: true, vaulted: false, envDeleted: false, warning: W }))
      .on('DELETE', '/api/bots/b1?keepData=true&keepEnv=true', cliOk({ success: true, vaulted: true, envDeleted: false }));
    const r = await tuiDeleteBot(f.client, 'b1', false, true, []);
    expect(r.ok === true && deleteDoneText(r.value, false, true)).toBe(`Bot removed. ${W}`);
    const s = await tuiDeleteBot(f.client, 'b1', true, true, []);
    expect(s.ok === true && deleteDoneText(s.value, true, true)).toBe('Bot removed (data preserved); environment values copied to the vault');
  });

  const cli = async (status: number, body: unknown, flags: Record<string, string | boolean> = {}) => {
    let out = '';
    let err = '';
    let code = -1;
    const server = http.createServer((_req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const exit = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw Object.assign(new Error('exit'), { exitCode: c ?? 0 }); }) as never);
    const o = vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out += s; return true; }) as never);
    const e = vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => { err += s; return true; }) as never);
    const tty = process.stdout.isTTY;
    process.stdout.isTTY = true;
    try {
      await dispatch(new Client({ host: '127.0.0.1', port: (server.address() as AddressInfo).port }), ['bots', 'delete', 'b1'], flags);
    } catch (x) {
      if ((x as { exitCode?: number }).exitCode === undefined) throw x;
      code = (x as { exitCode: number }).exitCode;
    } finally {
      process.stdout.isTTY = tty;
      exit.mockRestore();
      o.mockRestore();
      e.mockRestore();
      server.closeAllConnections();
      await new Promise<void>(r => server.close(() => r()));
    }
    return { out, err, code };
  };

  it('a delete that succeeded prints the page\'s text on one line, each body field in its clause', async () => {
    const cases: Array<[Record<string, string | boolean>, Record<string, unknown>, string]> = [
      [{}, { vaulted: false, envDeleted: false }, 'Bot removed (data preserved)'],
      [{}, { vaulted: true, envDeleted: false, keptDataDir: '/data/bots/b1' }, 'Bot removed; its data stays in /data/bots/b1, and a new install does not reuse that folder; environment values copied to the vault'],
      [{ 'delete-data': true, 'no-keep-env': true }, { vaulted: false, envDeleted: true, keptReplicaVolume: 'b1-replica', dbDumpsKept: { count: 2, folder: 'backups/b1' } },
        "Bot removed; the replica volume b1-replica that Remove replica kept was not deleted; its 2 database dumps stay in the manager's backups/b1 folder; environment values deleted"],
      [{ 'delete-data': true, 'no-keep-env': true }, { vaulted: false, envDeleted: false, dbDumpsKept: { count: 1, folder: 'backups/b1' } },
        "Bot removed; its 1 database dump stays in the manager's backups/b1 folder; deleting the environment values could not be confirmed"],
      [{ 'delete-data': true }, { vaulted: false, envDeleted: false, warning: W }, `Bot removed. ${W}`],
    ];
    for (const [flags, body, line] of cases) {
      const r = await cli(200, { success: true, ...body }, flags);
      expect(r.out).toBe(`${line}\n`);
      expect(r.err).toBe('');
      expect(r.code).toBe(0);
    }
  });

  it('--json prints the body as it came, warning included', async () => {
    const body = { success: true, vaulted: false, envDeleted: false, warning: W };
    const r = await cli(200, body, { json: true });
    expect(JSON.parse(r.out)).toEqual(body);
    expect(r.code).toBe(0);
  });

  it('a refused delete (needsConfirm, 404) prints the body as JSON and the error line, never Bot removed', async () => {
    for (const [status, body] of [
      [409, { success: false, needsConfirm: true, confirmFlag: 'confirmFleetData', error: 'This bot holds the fleet database; pass --confirm-fleet-data' }],
      [404, { success: false, error: 'Bot not found' }],
    ] as const) {
      const r = await cli(status, body);
      expect(JSON.parse(r.out)).toEqual(body);
      expect(r.out).not.toContain('Bot removed');
      expect(r.err).toBe(`dbm: request failed: ${body.error}\n`);
      expect(r.code).toBe(1);
    }
  });
});
