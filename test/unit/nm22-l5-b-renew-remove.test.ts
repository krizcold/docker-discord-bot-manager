import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm22-l5-b-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    loginWrites: [] as unknown[],
    replAnswers: [] as Array<'false' | string>,
    echoOwn: false,
    partialOut: null as string | null,
    killedAfter: null as null | { match: string; out: string },
  };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const base: any = (await import('./nm22-lane-fake')).laneChildProcess(real);
  const spawn = (cmd: string, args: string[], ...rest: any[]) => {
    const child = base.spawn(cmd, args, ...rest);
    const out = h.partialOut;
    if (out !== null) setTimeout(() => child.stdout.write(out), 1);
    return child;
  };
  // A -c call that printed its answer and was then killed on its time limit, as execFile reports it.
  const execFile = (cmd: string, args: string[], opts: any, cb?: any) => {
    const k = h.killedAfter;
    if (k === null || !args.join(' ').includes(k.match)) return base.execFile(cmd, args, opts, cb);
    const done = typeof opts === 'function' ? opts : cb;
    setImmediate(() => done(Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', code: null }), k.out, ''));
    return new (require('events').EventEmitter)();
  };
  return { ...base, spawn, execFile, default: { ...base.default, spawn, execFile } };
});
vi.mock('../../src/instance/fleetJoin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetJoin')>()),
  sendAddresses: async () => ({ state: 'applied' }),
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  const { lane } = await import('./nm22-lane-fake');
  return {
    ...real,
    updateInstanceFleetLogin: (id: string, login: any) => {
      h.loginWrites.push(login);
      if (h.echoOwn && login?.password) {
        lane.rules.push({ match: "SELECT 'renewed'", code: 3, out: 'SET\nSET\nSET\nBEGIN\n', err: `psql:<stdin>:6: ERROR:  password "${login.password}" is too long\n`, once: true });
      }
      return (real as any).updateInstanceFleetLogin(id, login);
    },
    updateInstanceFleetDbReplication: (...a: any[]) => {
      if (h.replAnswers.shift() === 'false') return false;
      return (real as any).updateInstanceFleetDbReplication(...a);
    },
  };
});

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { QUIET_ROLE_SESSION_SQL } from '../../src/config/secretText';
import { getFleetReplicationStatus, removeCopyLogin, renewJoinCode } from '../../src/instance/fleetReplication';
import { ROLE_SETTINGS_RESET_SQL, lockedRoleWriteSql } from '../../src/instance/switchSql';
import * as fleetBackupGuards from '../../src/instance/fleetBackupGuards';
import { lane, resetLane } from './nm22-lane-fake';

const ID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const A = 'smdb_copy_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SA = 'fleet_standby_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OWN_PW = 'Own-Machine-Secret-01';
const REGISTRY = path.join(h.dir, 'instances.json');
const dbUrl = 'postgresql://smdb:Db-Secret%2C%25x@m-fleet-postgres:5432/smdb?sslmode=no-verify';
const fleetDb = { containerName: 'm-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'm-fleet-postgres-data', password: 'Db-Secret,%x' };
const replication = { role: 'smdb_join', password: 'Join-Secret-0123456789', hostPort: 15432, publicHost: 'main.invalid', certHost: 'main.invalid', slotWalKeepMb: 4096 };
const switchRecord = { machine: 'copy.invalid', host: 'copy.invalid', port: 15433, generation: 3, own: 2, since: null, at: '2026-11-01T00:00:00.000Z' };
const DONE_OWN = "Made a new join code and gave this machine's own login a new password. The old code no longer adds machines; machines that joined before keep their logins.";
const DONE_KEPT = "Made a new join code. The old code no longer adds machines; machines that joined before keep their logins. This machine's own login kept its password, because the database on copy.invalid still holds it for this machine.";

const writeRegistry = (db: Record<string, unknown> | null = { ...fleetDb, replication }, id = ID): void => {
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { [id]: {
    id, sanitizedName: 'm', displayName: 'M', titleName: 'M', status: 'running', sourceType: 'git',
    sourceUrl: 'https://example.invalid/fake/super-modular-discord-bot', envVars: { DATA_BACKEND: 'postgres' },
    createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', ...(db ? { fleetDb: db } : {}),
  } } }));
  if (db) (containerManager as any).updateInstanceFleetLogin(id, { password: OWN_PW });
  h.loginWrites = [];
};
const bot = (id = ID) => containerManager.getBot(id)!;
const renewCall = () => lane.calls.find(c => c.stdin.includes("SELECT 'renewed'"))!;
const probes = () => lane.calls.filter(c => c.args.includes('postgres:16-alpine')).length;

beforeEach(() => {
  resetLane();
  h.replAnswers = [];
  h.echoOwn = false;
  h.partialOut = null;
  h.killedAfter = null;
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', ID, 'env'), { recursive: true });
  writeRegistry();
  envManager.setEnvVars(ID, { DATA_BACKEND_URL: dbUrl });
});
afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));

describe('NM22 L5 b: New join code', () => {
  it('no replication: refused with success false', async () => {
    writeRegistry({ ...fleetDb });
    expect(await renewJoinCode(bot())).toEqual({ success: false, error: 'Replication is not enabled, so there is no join code.' });
  });

  it('the database is down: refused with success false', async () => {
    lane.running = 'false';
    expect(await renewJoinCode(bot())).toEqual({ success: false, error: 'The database container is not running, so the join code was not renewed' });
  });

  it('an instance id that makes no machine login name: refused before any save or psql call', async () => {
    const odd = 'Main-Bot-01';
    writeRegistry({ ...fleetDb, replication }, odd);
    expect(await renewJoinCode(bot(odd))).toEqual({ success: false, error: 'The join code was not renewed (smdb_copy_MainBot01 is not a machine login name); the current code still works, and nothing was changed.' });
    expect(h.loginWrites).toHaveLength(0);
    expect(lane.calls.some(c => c.stdin.includes("SELECT 'renewed'"))).toBe(false);
  });

  it('the failed transaction names the new own password: the text hides it', async () => {
    h.echoOwn = true;
    const r = await renewJoinCode(bot());
    const pw = (h.loginWrites[0] as any).password as string;
    expect(r).toEqual({ success: false, error: 'The join code was not renewed (password "***" is too long); the current code still works, and nothing was changed.' });
    expect(r.error).not.toContain(pw);
  });

  it('the own login kept: the transaction text holds only the join login', async () => {
    writeRegistry({ ...fleetDb, replication, replacedBy: switchRecord });
    expect(await renewJoinCode(bot())).toEqual({ success: true, text: DONE_KEPT });
    const s = renewCall().stdin;
    const v = /ALTER ROLE smdb_join LOGIN PASSWORD '([^']+)';/.exec(s)![1];
    expect(s).toBe(`${QUIET_ROLE_SESSION_SQL}BEGIN;
${lockedRoleWriteSql(['smdb_join'])}ALTER ROLE smdb_join LOGIN PASSWORD '${v}';
${ROLE_SETTINGS_RESET_SQL('smdb_join')}SELECT 'committing';
COMMIT;
SELECT 'renewed';
SELECT 'ended|' || pg_catalog.count(pg_catalog.pg_terminate_backend(a.pid, 5000)) FROM pg_catalog.pg_stat_activity a WHERE a.usename IN ('smdb_join') AND a.pid <> pg_catalog.pg_backend_pid();
SELECT 'unlinked|' || pg_catalog.count(pg_catalog.lo_unlink(l.oid)) FROM pg_catalog.pg_largeobject_metadata l;
`);
  });

  it('the own login kept and the transaction fails: success false, no own password written back', async () => {
    writeRegistry({ ...fleetDb, replication, replacedBy: switchRecord });
    lane.rules.push({ match: "SELECT 'renewed'", code: 3, out: 'SET\nSET\nSET\nBEGIN\n', err: 'psql:<stdin>:5: ERROR:  canceling statement due to lock timeout\n' });
    expect(await renewJoinCode(bot())).toEqual({ success: false, error: 'The join code was not renewed (canceling statement due to lock timeout); the current code still works, and nothing was changed.' });
    expect(h.loginWrites).toHaveLength(0);
  });

  it('renewed and the sessions ended, then the slot step fails: its note names the slot step', async () => {
    lane.rules.push({ match: "SELECT 'renewed'", code: 3, out: 'COMMIT\nrenewed\nended|1\nunlinked|0\n', err: 'psql:<stdin>:14: ERROR:  out of shared memory\n' });
    expect(await renewJoinCode(bot())).toEqual({ success: true, text: `${DONE_OWN} The renewal stands, but removing a slot or address of this machine's own login failed (out of shared memory).` });
  });

  it('renewed, then the call hangs and is killed: the renewal stands, never the can\'t-confirm text', async () => {
    lane.rules.push({ match: "SELECT 'renewed'", hang: true });
    h.partialOut = 'SET\nSET\nSET\nBEGIN\nALTER ROLE\nCOMMIT\nrenewed\n';
    vi.useFakeTimers();
    try {
      const pending = renewJoinCode(bot());
      await vi.advanceTimersByTimeAsync(31_000);
      expect(await pending).toEqual({ success: true, text: `${DONE_OWN} The renewal stands, but ending the old sessions failed (docker did not answer within 30 s).` });
    } finally {
      vi.useRealTimers();
    }
  });

  it('the record is gone when the join password is saved: the text says so', async () => {
    h.replAnswers = ['false'];
    expect(await renewJoinCode(bot())).toEqual({ success: false, error: "The old join code no longer adds machines, but the new password could not be saved (the bot's record is no longer in the registry), so no code can be shown for it; press New join code again." });
  });

  it('a renewal clears the cached reachability probe', async () => {
    await getFleetReplicationStatus(bot(), { probeEndpoint: true });
    await getFleetReplicationStatus(bot(), { probeEndpoint: true });
    expect(probes()).toBe(1);
    expect((await renewJoinCode(bot())).success).toBe(true);
    await getFleetReplicationStatus(bot(), { probeEndpoint: true });
    expect(probes()).toBe(2);
  });
});

describe('NM22 L5 b: Remove', () => {
  beforeEach(() => {
    lane.slotActive = 'false';
    lane.slotStates = ['false', 'absent'];
  });

  it('a backup holds the lane: the refusal names Remove', async () => {
    expect(fleetBackupGuards.claimFleetBackupBusy(ID)).toBe(true);
    try {
      expect(await removeCopyLogin(bot(), A, false)).toEqual({ success: false, error: 'A backup, restore or standby re-seed is running on this instance; Remove is refused until it finishes (nothing was changed)' });
    } finally {
      fleetBackupGuards.releaseFleetBackupBusy(ID);
    }
  });

  it('the bot left the registry: Bot not found', async () => {
    const gone = { ...bot(), id: '11111111-2222-4333-8444-555555555555' };
    expect(await removeCopyLogin(gone, A, false)).toEqual({ success: false, error: 'Bot not found (nothing was changed)' });
  });

  it('no managed database: refused', async () => {
    writeRegistry(null);
    expect(await removeCopyLogin(bot(), A, false)).toEqual({ success: false, error: 'This instance hosts no managed fleet database' });
  });

  it('a long name off the pattern: the text shows its first 80 characters', async () => {
    const name = `smdb_copy_${'z'.repeat(100)}`;
    expect(await removeCopyLogin(bot(), name, false)).toEqual({ success: false, error: `No machine login named ${name.slice(0, 80)} exists on this database; reload the Database window.` });
  });

  it('a name that is not a string, even one that prints as a login: unknown, no docker call', async () => {
    expect(await removeCopyLogin(bot(), [A] as any, true)).toEqual({ success: false, error: `No machine login named ${A} exists on this database; reload the Database window.` });
    expect(lane.dockerCalls).toBe(0);
  });

  it('the fence read fails: refused with success false', async () => {
    lane.rules.push({ match: "WHERE line LIKE '%", code: 1, err: 'ERROR:  could not open file "pg_hba.conf"\n' });
    expect(await removeCopyLogin(bot(), A, false)).toEqual({ success: false, error: `The login ${A} was not removed: whether a write fence stands in pg_hba.conf could not be read (ERROR:  could not open file "pg_hba.conf"); nothing was changed.` });
  });

  it('the admission read fails: reading it failed', async () => {
    lane.rules.push({ match: "SELECT 'login|'", code: 1, err: 'psql: error: connection to server on socket failed: FATAL:  the database system is shutting down\n' });
    const r = await removeCopyLogin(bot(), A, false);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(new RegExp(`^The login ${A} was not removed: reading it failed \\(.+\\); nothing was changed\\.$`));
  });

  it('the admission read prints no line the manager reads', async () => {
    lane.rules.push({ match: "SELECT 'login|'", code: 0, out: '' });
    expect(await removeCopyLogin(bot(), A, false)).toEqual({ success: false, error: `The login ${A} was not removed: the database answered in a form the manager does not read; nothing was changed.` });
  });

  it('streaming, and only another slot has an address row: the question names the client address', async () => {
    lane.slotActive = 'true';
    lane.client = '10.0.0.9';
    lane.addresses = JSON.stringify([{ slot: 'fleet_standby_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', machine: 'copy-b', host: 'b.invalid', port: 15433 }]);
    expect((await removeCopyLogin(bot(), A, false)).error).toContain(`The machine with the login ${A} streams from this database now (10.0.0.9).`);
    expect(SA).toBe(`fleet_standby_${A.slice(10)}`);
  });

  it('streaming, and the address read printed its row before it was killed on its time limit: the question names the client address', async () => {
    lane.slotActive = 'true';
    lane.client = '10.0.0.7';
    h.killedAfter = { match: "to_regclass('smdb_manager.addresses') IS NULL", out: `[{"slot":"${SA}","machine":"m-b","host":"b.invalid","port":15433}]\n` };
    const r = await removeCopyLogin(bot(), A, false);
    expect(r.needsConfirm).toBe(true);
    expect(r.error).toContain(`The machine with the login ${A} streams from this database now (10.0.0.7).`);
  });
});

// D1: psql (no -q) prints a tag per statement and `committing` just before it sends COMMIT; the connection ended
// before the result line.
const LOST = { code: 2, err: 'psql:<stdin>:15: FATAL:  terminating connection due to administrator command\npsql:<stdin>:15: error: connection to server was lost\n' };
const CLOSED = { code: 2, err: 'psql:<stdin>:14: server closed the connection unexpectedly\n\tThis probably means the server terminated abnormally\n\tbefore or while processing the request.\npsql:<stdin>:14: error: connection to server was lost\n' };
const RENEW_BEFORE_OWN = 'SET\nSET\nSET\nBEGIN\nSET\nclosed|0\nALTER ROLE\nALTER ROLE\nDO\nALTER ROLE\nDO\nALTER ROLE\n';
const RENEW_TAGS_OWN = `${RENEW_BEFORE_OWN}committing\nCOMMIT\n`;
const RENEW_TAGS_KEPT = 'SET\nSET\nSET\nBEGIN\nSET\nclosed|0\nALTER ROLE\nDO\nALTER ROLE\ncommitting\nCOMMIT\n';
const BLOCK_BEFORE = 'BEGIN\nSET\nclosed|0\nDO\nALTER ROLE\nDO\nALTER ROLE\n';
const BLOCK_TAGS = `${BLOCK_BEFORE}committing\nCOMMIT\n`;
const RENEW_UNCONFIRMED = (why: string) => `The manager can't confirm whether the join code was renewed: the manager did not read the result (${why}), and the change may be applied there. Press New join code again.`;
const BLOCK_UNCONFIRMED = (why: string) => `The manager can't confirm whether the login ${A} was blocked: the manager did not read the result (${why}), and the block may be applied there. Press Remove again to finish.`;
const RENEW_UNCONFIRMED_LOST = RENEW_UNCONFIRMED('terminating connection due to administrator command');
const callsAfter = (marker: string) => lane.calls.slice(lane.calls.findIndex(c => c.stdin.includes(marker)) + 1);

describe('NM22 fix review round 1: the committing marker decides whether COMMIT was sent', () => {
  it('New join code: committing printed, the server gone before the COMMIT tag: can\'t confirm, the new own password stays', async () => {
    lane.rules.push({ match: "SELECT 'renewed'", out: `${RENEW_BEFORE_OWN}committing\n`, ...CLOSED });
    const r = await renewJoinCode(bot());
    expect(r).toEqual({ success: false, error: RENEW_UNCONFIRMED('connection to server was lost') });
    const written = (h.loginWrites[0] as any).password as string;
    expect(h.loginWrites).toHaveLength(1);
    expect(bot().fleetLogin!.password).toBe(written);
    expect(callsAfter("SELECT 'renewed'")).toEqual([]);
  });

  it('New join code: no committing line, so COMMIT was never sent: not renewed, the earlier password written back', async () => {
    lane.rules.push({ match: "SELECT 'renewed'", out: RENEW_BEFORE_OWN, ...CLOSED });
    expect(await renewJoinCode(bot())).toEqual({ success: false, error: 'The join code was not renewed (connection to server was lost); the current code still works, and nothing was changed.' });
    expect(h.loginWrites).toHaveLength(2);
    expect(h.loginWrites[1]).toEqual({ password: OWN_PW });
    expect(bot().fleetLogin!.password).toBe(OWN_PW);
  });

  it('Remove: committing printed, the server gone before the COMMIT tag: can\'t confirm the block', async () => {
    lane.slotActive = 'false';
    lane.rules.push({ match: "SELECT 'blocked|'", out: `${BLOCK_BEFORE}committing\n`, ...CLOSED });
    expect(await removeCopyLogin(bot(), A, false)).toEqual({ success: false, error: BLOCK_UNCONFIRMED('connection to server was lost') });
    expect(callsAfter("SELECT 'blocked|'")).toEqual([]);
  });

  it('Remove: no committing line: blocking it failed, nothing was changed', async () => {
    lane.slotActive = 'false';
    lane.rules.push({ match: "SELECT 'blocked|'", out: BLOCK_BEFORE, ...CLOSED });
    expect(await removeCopyLogin(bot(), A, false)).toEqual({ success: false, error: `The login ${A} was not removed: blocking it failed (connection to server was lost); nothing was changed.` });
    expect(callsAfter("SELECT 'blocked|'")).toEqual([]);
  });
});

const DAEMON = { code: 1, err: 'Error response from daemon: container m-fleet-postgres is not running\n' };
const NO_RESULT = "the database's answer held no result line";

describe('NM22 fix review round 2: only psql\'s own stop before COMMIT reads as not committed', () => {
  it('New join code: exit 0 with no result line: can\'t confirm, the new own password stays, nothing after runs', async () => {
    lane.rules.push({ match: "SELECT 'renewed'", out: '' });
    expect(await renewJoinCode(bot())).toEqual({ success: false, error: RENEW_UNCONFIRMED(NO_RESULT) });
    expect(h.loginWrites).toHaveLength(1);
    expect(bot().fleetLogin!.password).toBe((h.loginWrites[0] as any).password);
    expect(callsAfter("SELECT 'renewed'")).toEqual([]);
  });

  it('New join code: a failure with no psql line (docker\'s own error): can\'t confirm, nothing written back', async () => {
    lane.rules.push({ match: "SELECT 'renewed'", out: '', ...DAEMON });
    expect(await renewJoinCode(bot())).toEqual({ success: false, error: RENEW_UNCONFIRMED('the call ended without an answer from psql') });
    expect(h.loginWrites).toHaveLength(1);
    expect(bot().fleetLogin!.password).toBe((h.loginWrites[0] as any).password);
  });

  it('Remove: exit 0 with no result line: can\'t confirm the block', async () => {
    lane.slotActive = 'false';
    lane.rules.push({ match: "SELECT 'blocked|'", out: '' });
    expect(await removeCopyLogin(bot(), A, false)).toEqual({ success: false, error: BLOCK_UNCONFIRMED(NO_RESULT) });
    expect(callsAfter("SELECT 'blocked|'")).toEqual([]);
  });

  it('Remove: a failure with no psql line (docker\'s own error): can\'t confirm the block', async () => {
    lane.slotActive = 'false';
    lane.rules.push({ match: "SELECT 'blocked|'", out: '', ...DAEMON });
    expect(await removeCopyLogin(bot(), A, false)).toEqual({ success: false, error: BLOCK_UNCONFIRMED('the call ended without an answer from psql') });
    expect(callsAfter("SELECT 'blocked|'")).toEqual([]);
  });
});

// A psql WARNING is not psql's stop: the process was killed (exit 137) without the call's time limit.
const KILLED_WARNING = { code: 137, err: 'psql:<stdin>:6: WARNING:  PID 4242 is not a PostgreSQL backend process\n' };

describe('NM22 fix review round 3: only an error line of psql reads as its stop', () => {
  it('New join code: only a WARNING line and exit 137: can\'t confirm, nothing written back', async () => {
    lane.rules.push({ match: "SELECT 'renewed'", out: '', ...KILLED_WARNING });
    expect(await renewJoinCode(bot())).toEqual({ success: false, error: RENEW_UNCONFIRMED('the call ended without an answer from psql') });
    expect(h.loginWrites).toHaveLength(1);
    expect(bot().fleetLogin!.password).toBe((h.loginWrites[0] as any).password);
  });

  it('Remove: only a WARNING line and exit 137: can\'t confirm the block', async () => {
    lane.slotActive = 'false';
    lane.rules.push({ match: "SELECT 'blocked|'", out: '', ...KILLED_WARNING });
    expect(await removeCopyLogin(bot(), A, false)).toEqual({ success: false, error: BLOCK_UNCONFIRMED('the call ended without an answer from psql') });
    expect(callsAfter("SELECT 'blocked|'")).toEqual([]);
  });
});

describe('NM22 fix D1: a COMMIT tag with no result line after it', () => {
  it('New join code with a new own password: can\'t confirm, the new own password stays on record, nothing after runs', async () => {
    lane.rules.push({ match: "SELECT 'renewed'", out: RENEW_TAGS_OWN, ...LOST });
    const r = await renewJoinCode(bot());
    expect(r).toEqual({ success: false, error: RENEW_UNCONFIRMED_LOST });
    expect(r.error).not.toContain('nothing was changed');
    const written = (h.loginWrites[0] as any).password as string;
    expect(written).not.toBe(OWN_PW);
    expect(h.loginWrites).toHaveLength(1);
    expect(bot().fleetLogin!.password).toBe(written);
    expect(bot().fleetDb!.replication!.password).toBe(replication.password);
    expect(callsAfter("SELECT 'renewed'")).toEqual([]);
  });

  it('New join code with the own login kept: can\'t confirm, no own password written, nothing after runs', async () => {
    writeRegistry({ ...fleetDb, replication, replacedBy: switchRecord });
    lane.rules.push({ match: "SELECT 'renewed'", out: RENEW_TAGS_KEPT, ...LOST });
    expect(await renewJoinCode(bot())).toEqual({ success: false, error: RENEW_UNCONFIRMED_LOST });
    expect(h.loginWrites).toHaveLength(0);
    expect(bot().fleetLogin!.password).toBe(OWN_PW);
    expect(bot().fleetDb!.replication!.password).toBe(replication.password);
    expect(callsAfter("SELECT 'renewed'")).toEqual([]);
  });

  it('Remove: can\'t confirm the block, and no step after it runs', async () => {
    lane.slotActive = 'false';
    lane.rules.push({ match: "SELECT 'blocked|'", out: BLOCK_TAGS, ...LOST });
    const r = await removeCopyLogin(bot(), A, false);
    expect(r).toEqual({ success: false, error: BLOCK_UNCONFIRMED('terminating connection due to administrator command') });
    expect(callsAfter("SELECT 'blocked|'")).toEqual([]);
  });
});
