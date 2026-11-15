import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm22-sites-tick-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

vi.mock('child_process', async (o) => (await import('./switch-harness')).childProcessMock(await o()));
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./switch-harness')).dbLoginMock(await o()));
vi.mock('../../src/instance/maintenance', async (o) => (await import('./switch-harness')).maintenanceMock(await o()));
vi.mock('../../src/docker/containerManager', async (o) => (await import('./switch-harness')).containerManagerMock(await o()));
vi.mock('../../src/instance/fleetBackup', async (o) => (await import('./switch-harness')).fleetBackupMock(await o()));
vi.mock('../../src/instance/fleetJoin', async (o) => (await import('./switch-harness')).fleetJoinMock(await o()));
vi.mock('../../src/instance/fleetReplica', async (o) => (await import('./switch-harness')).fleetReplicaMock(await o()));
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./switch-harness')).appHookMock(await o()));
vi.mock('../../src/instance/backupCheck', async (o) => (await import('./switch-harness')).backupCheckMock(await o()));
vi.mock('../../src/env/manager', async (o) => (await import('./switch-harness')).envMock(await o()));
vi.mock('../../src/config/appCapabilities', async (o) => (await import('./switch-harness')).capsMock(await o()));
vi.mock('../../src/instance/fleetReplication', async (o) => ({
  ...(await o<typeof import('../../src/instance/fleetReplication')>()),
  getJoinCode: async () => ({ success: true, joinCode: (await import('./join-fake')).fakeJoinCode({ host: 'main.example', port: 5433 }) }),
}));

import * as fs from 'fs';
import { composeJoinCode, resetSwitchState, SWITCH_TIMING, switchTick, takeOverMain } from '../../src/instance/fleetSwitch';
import { receive } from '../../src/instance/fleetMove';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { decodeJoinCode } from '../../src/config/joinCode';
import { copyLogin, copySlot } from '../../src/instance/switchSql';
import * as containerManager from '../../src/docker/containerManager';
import { COPY_PEM, copyFixture, fake, freshDb, h, mainFixture, MAIN, resetHarness, stored, writeRegistry } from './switch-harness';
import { fakeJoinCode } from './join-fake';

const ID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const OWN = copyLogin(ID);
const OWN_SLOT = copySlot(ID);
const hex = (c: string) => c.repeat(32);
const SLOT_B = `fleet_standby_${hex('b')}`;
const LOGIN_B = `smdb_copy_${hex('b')}`;
const LOGIN_C = `smdb_copy_${hex('c')}`;
const SLOT_D = `fleet_standby_${hex('d')}`;
let now = Date.parse('2026-11-15T10:00:00Z');

const withMain = (db: Record<string, unknown> = {}, inst: Record<string, unknown> = {}) =>
  writeRegistry({ [ID]: mainFixture({ displayName: 'A', fleetDb: { ...MAIN, ...db }, ...inst }) });

const seen: { warn: string[]; log: string[] } = { warn: [], log: [] };
const all = () => [...seen.warn, ...seen.log];
const ev = (prefix: string) => h.events.filter(e => e.startsWith(prefix));

beforeEach(() => {
  resetHarness();
  resetSwitchState();
  releaseFleetBackupBusy(ID);
  fake.dbs['a-pg'] = freshDb();
  withMain();
  now += 6 * 60_000;
  seen.warn = [];
  seen.log = [];
  vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { seen.warn.push(String(m)); });
  vi.spyOn(console, 'log').mockImplementation((m: unknown) => { seen.log.push(String(m)); });
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

const ENDED = 'was ended';
const NOT_ENDED = 'could not be ended, and the next check tries again';
const GONE = 'had already ended';
const DROPPED = 'was dropped, so its machine rebuilds its copy';
const KEPT = 'was kept because its machine streams on it again; if that copy stops following, re-seed it on its machine';
const LOG_FOREIGN = (login: string, slot: string, stream: string, kept: string) => `[Switch] A: the login ${login} streamed on the slot ${slot}, which belongs to another machine. The login is now blocked (it cannot log in, and other machines stop listing its machine within an hour); its stream ${stream}; the slot ${kept}. Remove the login in the Database window.`;
const LOG_OWN = (slot: string, tail: string) => `[Switch] A: this machine's own login ${OWN} streamed on the slot ${slot}, which belongs to another machine, so its password is known outside this manager. Its stream ${ENDED}; the slot ${DROPPED}.${tail}`;

describe('O6 the main tick (R3, R31): W1 to W16', () => {
  it('W1, W2: another machine login on a machine slot: blocked, then its stream ended and the slot dropped; LOG-FOREIGN', async () => {
    fake.dbs['a-pg'].foreign = [`${SLOT_B}|${LOGIN_C}|4242`];
    await switchTick(now);
    expect(h.events.filter(e => /^(foreign-read|block:|tainted:)/.test(e))).toEqual(['foreign-read', `block:${LOGIN_C}`, `tainted:${SLOT_B}`]);
    expect(seen.warn).toContain(LOG_FOREIGN(LOGIN_C, SLOT_B, ENDED, DROPPED));
  });

  it('the tick steps run as dbm_admin on postgres after the copies list, in R3 order', async () => {
    fake.dbs['a-pg'].foreign = [`${SLOT_B}|${LOGIN_C}|4242`];
    await switchTick(now);
    const order = ['copies-sync', 'foreign-read', `block:${LOGIN_C}`, `tainted:${SLOT_B}`, 'blocked-sessions', 'lobj', 'new-logins'];
    expect(h.events.filter(e => order.includes(e))).toEqual(order);
    const steps = fake.calls.filter(c => /usename IS DISTINCT FROM 'smdb_copy_'|GRANTED BY %I|SELECT 'slot\||client_addr IS NOT NULL|pg_largeobject_metadata|string_agg\(m\.member/.test(c.input));
    expect(steps).toHaveLength(6);
    for (const c of steps) expect(c.args.slice(c.args.indexOf('psql'))).toEqual(expect.arrayContaining(['-U', 'dbm_admin', '-d', 'postgres']));
  });

  it('W3: the owner streams again between the statements: the slot is kept and the line says so', async () => {
    fake.dbs['a-pg'].foreign = [`${SLOT_B}|${LOGIN_C}|4242`];
    fake.dbs['a-pg'].tainted[SLOT_B] = 'true\nslot|kept';
    await switchTick(now);
    expect(seen.warn).toContain(LOG_FOREIGN(LOGIN_C, SLOT_B, ENDED, KEPT));
  });

  it('code review 2 finding 3: the block ended the login\'s sessions and the slot step found no stream: LOG-FOREIGN says the block ended it', async () => {
    fake.dbs['a-pg'].foreign = [`${SLOT_B}|${LOGIN_C}|4242`];
    fake.dbs['a-pg'].blockAnswer[LOGIN_C] = 'closed|1\nblocked|true|true|true';
    fake.dbs['a-pg'].tainted[SLOT_B] = 'slot|dropped';
    await switchTick(now);
    expect(seen.warn).toContain(LOG_FOREIGN(LOGIN_C, SLOT_B, 'was ended when the login was blocked', DROPPED));
  });

  it('a stream that had already ended: no terminate line', async () => {
    fake.dbs['a-pg'].foreign = [`${SLOT_B}|${LOGIN_C}|4242`];
    fake.dbs['a-pg'].tainted[SLOT_B] = 'slot|dropped';
    await switchTick(now);
    expect(seen.warn).toContain(LOG_FOREIGN(LOGIN_C, SLOT_B, GONE, DROPPED));
  });

  it('W4: this machine\'s own login on another slot: not blocked; LOG-FOREIGN-OWN asks for New join code', async () => {
    fake.dbs['a-pg'].foreign = [`${SLOT_B}|${OWN}|77`];
    await switchTick(now);
    expect(ev('block:')).toEqual([]);
    expect(ev('tainted:')).toEqual([`tainted:${SLOT_B}`]);
    expect(seen.warn).toContain(LOG_OWN(SLOT_B, " Press New join code to give this machine's own login a new password."));
  });

  it.each([
    ['formerMain', { formerMain: { code: fakeJoinCode({ host: 'old.example', port: 5500 }), slot: 'slot_o', machine: 'old.example', host: 'old.example', port: 5500, generation: 2, at: '2026-11-01T00:00:00.000Z' } }, 'old.example'],
    ['mainConflict', { mainConflict: { machine: 'peer.example', host: 'peer.example', port: 5501, generation: 3, at: '2026-11-01T00:00:00.000Z' } }, 'peer.example'],
    ['handover with mode stream (R48)', { handover: { mode: 'stream', phase: 'stopped', machine: 'copy.example', host: 'copy.example', port: 5434, cert: COPY_PEM, generation: 4, at: '2026-11-01T00:00:00.000Z' } }, 'copy.example'],
  ])('W4 (R26): own login while %s stands: the line says why New join code keeps the password', async (_n, rec, machine) => {
    withMain(rec);
    fake.dbs['a-pg'].foreign = [`${SLOT_B}|${OWN}|77`];
    h.peer = () => ({ kind: 'unreachable', reason: 'connection refused' }) as any;
    await switchTick(now);
    expect(seen.warn).toContain(LOG_OWN(SLOT_B, ` New join code keeps this password while the database on ${machine} still holds it for this machine; until then this check ends such streams every 5 minutes.`));
  });

  it('W5: a role that is not a machine login: not blocked; LOG-FOREIGN-OTHER', async () => {
    fake.dbs['a-pg'].foreign = [`${SLOT_B}|botrole|90`];
    await switchTick(now);
    expect(ev('block:')).toEqual([]);
    expect(ev('tainted:')).toEqual([`tainted:${SLOT_B}`]);
    expect(seen.warn).toContain(`[Switch] A: the role botrole streamed on the slot ${SLOT_B}, which belongs to a machine login. Its stream ${ENDED}; the slot ${DROPPED}. It is not a machine login, so it was not blocked.`);
  });

  it('W6: no foreign stream: nothing blocked, nothing ended, no line', async () => {
    await switchTick(now);
    expect(h.events).toContain('foreign-read');
    expect(ev('block:')).toEqual([]);
    expect(ev('tainted:')).toEqual([]);
    expect(all().filter(l => l.includes('streamed on the slot'))).toEqual([]);
  });

  it('W7: the terminate answers false: the line says the stream could not be ended; the next tick finds it again', async () => {
    fake.dbs['a-pg'].foreign = [`${SLOT_B}|${LOGIN_C}|4242`];
    fake.dbs['a-pg'].tainted[SLOT_B] = 'false\nslot|kept';
    await switchTick(now);
    expect(seen.warn).toContain(LOG_FOREIGN(LOGIN_C, SLOT_B, NOT_ENDED, 'was kept, since the stream on it still runs'));
    await switchTick(now + 6 * 60_000);
    expect(ev('tainted:')).toHaveLength(2);
  });

  // Under psql -q a committed block and a failed one print alike, so only the 'again' state says the block failed.
  it.each([
    ['the block fails', { fail: { block: 'psql:<stdin>:4: ERROR:  permission denied to alter role\n' }, failCodes: { block: 3 } }, "the manager can't confirm the login was blocked (psql:<stdin>:4: ERROR:  permission denied to alter role)"],
    ['the connection ends (exit 2, a FATAL line, no stdout)', { fail: { block: 'psql:<stdin>:15: FATAL:  terminating connection due to administrator command\n' }, failCodes: { block: 2 } }, "the manager can't confirm the login was blocked (psql:<stdin>:15: FATAL:  terminating connection due to administrator command)"],
    ['the check finds the membership back', { blockAnswer: { [LOGIN_C]: 'blocked|false|true|true' } }, 'blocking the login failed (a check after the block found it undone (blocked|false|true|true))'],
    ['no blocked line came back', { blockAnswer: { [LOGIN_C]: '' } }, "the manager can't confirm the login was blocked (no blocked line came back)"],
  ])('W8: %s: LOG-FOREIGN-FAIL, the stream is left; the next tick repeats', async (_n, over, said) => {
    Object.assign(fake.dbs['a-pg'], over, { foreign: [`${SLOT_B}|${LOGIN_C}|4242`] });
    await switchTick(now);
    expect(ev('tainted:')).toEqual([]);
    expect(seen.warn).toContain(`[Switch] A: a stream on the slot ${SLOT_B} by ${LOGIN_C} was not handled: ${said}; the next check tries again`);
    await switchTick(now + 6 * 60_000);
    expect(ev('block:')).toHaveLength(2);
  });

  it('W9: open sessions of blocked logins over TCP: one line each', async () => {
    fake.dbs['a-pg'].blockedSessions = [`${LOGIN_B}|true`, `${LOGIN_C}|false`];
    await switchTick(now);
    expect(seen.warn).toContain(`[Switch] A: ended an open session of the blocked login ${LOGIN_B}`);
    expect(seen.warn).toContain(`[Switch] A: an open session of the blocked login ${LOGIN_C} could not be ended; the next check tries again`);
  });

  it('W10: large objects in postgres are unlinked, one line per owner; none gives no line', async () => {
    fake.dbs['a-pg'].lobj = ['smdb_join|2', `${LOGIN_B}|1`];
    await switchTick(now);
    expect(seen.warn).toContain('[Switch] A: removed 2 large objects that smdb_join made in the postgres database; the manager keeps none there');
    expect(seen.warn).toContain(`[Switch] A: removed 1 large objects that ${LOGIN_B} made in the postgres database; the manager keeps none there`);
    seen.warn = [];
    await switchTick(now + 6 * 60_000);
    expect(seen.warn.filter(l => l.includes('large objects'))).toEqual([]);
  });

  it('W11: a line of another shape is logged once and nothing is done for it', async () => {
    fake.dbs['a-pg'].foreign = [`${SLOT_B}|${LOGIN_C}|4242|x`];
    await switchTick(now);
    await switchTick(now + 6 * 60_000);
    expect(ev('block:')).toEqual([]);
    expect(seen.warn.filter(l => l.includes(`${SLOT_B}|${LOGIN_C}|4242|x`))).toEqual([`[Switch] A: a line of the streams on the machines' slots is not in the form the manager reads (${SLOT_B}|${LOGIN_C}|4242|x)`]);
  });

  it.each([
    ['foreign-read', "the streams on the machines' slots could not be read"],
    ['blocked-sessions', 'the open sessions of blocked machine logins could not be checked'],
    ['lobj', 'the large objects in the postgres database could not be checked'],
    ['new-logins', 'the machine logins could not be read'],
  ])('W12: %s fails: logged once per distinct error; the other steps still run', async (step, what) => {
    fake.dbs['a-pg'].fail[step] = 'ERROR:  canceling statement due to statement timeout';
    await switchTick(now);
    await switchTick(now + 6 * 60_000);
    expect(seen.warn.filter(l => l.includes(what))).toEqual([`[Switch] A: ${what} (ERROR:  canceling statement due to statement timeout); the manager tries again every 5 minutes`]);
    for (const e of ['foreign-read', 'blocked-sessions', 'lobj', 'new-logins']) expect(h.events.filter(x => x === e)).toHaveLength(2);
  });

  it.each([
    ['a receive', { receive: { startedAt: '2026-11-15T09:00:00.000Z', expiresAt: '2026-11-15T11:00:00.000Z', safetyDump: 'pre-receive-x.dump', pushId: '0123456789abcdef01234567', dbOid: '16384' } }],
    ['a broken push', { pushBroken: { at: '2026-11-15T09:00:00.000Z', safetyDump: 'x.dump' } }],
  ])('W13: %s on this database: none of the additions run', async (_n, db) => {
    withMain(db);
    fake.dbs['a-pg'].foreign = [`${SLOT_B}|${LOGIN_C}|4242`];
    await switchTick(now);
    for (const e of ['foreign-read', 'blocked-sessions', 'lobj', 'new-logins']) expect(h.events).not.toContain(e);
  });

  it('W14: a stop after the block, before the slot step: the next tick blocks again and ends the stream', async () => {
    fake.dbs['a-pg'].foreign = [`${SLOT_B}|${LOGIN_C}|4242`];
    fake.dbs['a-pg'].fail.tainted = 'psql: error: connection to server on socket failed';
    await switchTick(now);
    expect(ev('block:')).toEqual([`block:${LOGIN_C}`]);
    expect(seen.warn).toContain(`[Switch] A: the stream on the slot ${SLOT_B} by ${LOGIN_C} could not be ended and its slot could not be dropped (connection to server on socket failed); the manager tries again every 5 minutes`);
    delete fake.dbs['a-pg'].fail.tainted;
    await switchTick(now + 6 * 60_000);
    expect(ev('block:')).toEqual([`block:${LOGIN_C}`, `block:${LOGIN_C}`]);
    expect(seen.warn).toContain(LOG_FOREIGN(LOGIN_C, SLOT_B, ENDED, DROPPED));
  });

  it('R3: a slot step that keeps failing with one error is logged once; another error is logged again', async () => {
    fake.dbs['a-pg'].foreign = [`${SLOT_B}|${LOGIN_C}|4242`];
    fake.dbs['a-pg'].fail.tainted = 'ERROR:  canceling statement due to statement timeout';
    await switchTick(now);
    await switchTick(now + 6 * 60_000);
    fake.dbs['a-pg'].fail.tainted = 'ERROR:  out of shared memory';
    await switchTick(now + 12 * 60_000);
    expect(ev('tainted:')).toHaveLength(3);
    expect(seen.warn.filter(l => l.includes('could not be ended and its slot could not be dropped'))).toEqual([
      `[Switch] A: the stream on the slot ${SLOT_B} by ${LOGIN_C} could not be ended and its slot could not be dropped (ERROR:  canceling statement due to statement timeout); the manager tries again every 5 minutes`,
      `[Switch] A: the stream on the slot ${SLOT_B} by ${LOGIN_C} could not be ended and its slot could not be dropped (ERROR:  out of shared memory); the manager tries again every 5 minutes`,
    ]);
  });

  it('code review 1 finding 1: the block ends on the call\'s time limit: the line says the block can\'t be confirmed, and the stream is left', async () => {
    const readMs = SWITCH_TIMING.readMs;
    SWITCH_TIMING.readMs = 2000;
    try {
      fake.dbs['a-pg'].foreign = [`${SLOT_B}|${LOGIN_C}|4242`];
      fake.dbs['a-pg'].beforeAnswer = async (sql) => { if (sql.includes("SELECT 'blocked|'")) await new Promise(() => {}); };
      await switchTick(now);
    } finally {
      SWITCH_TIMING.readMs = readMs;
    }
    expect(ev('tainted:')).toEqual([]);
    expect(seen.warn).toContain(`[Switch] A: a stream on the slot ${SLOT_B} by ${LOGIN_C} was not handled: the manager can't confirm the login was blocked (no answer within 2 seconds); the next check tries again`);
  }, 30_000);

  it('W15: a new member after the first read: LOG-NEWLOGIN once; none for the logins present at the first read', async () => {
    fake.dbs['a-pg'].members = [LOGIN_B];
    await switchTick(now);
    fake.dbs['a-pg'].members = [LOGIN_B, LOGIN_C];
    await switchTick(now + 6 * 60_000);
    await switchTick(now + 12 * 60_000);
    expect(seen.log.filter(l => l.includes('got a login with the join code'))).toEqual([`[Switch] A: a machine got a login with the join code: ${LOGIN_C}`]);
  });

  it('W16: the block answers blocked|true|true|false: the slot step still runs', async () => {
    fake.dbs['a-pg'].foreign = [`${SLOT_B}|${LOGIN_C}|4242`];
    fake.dbs['a-pg'].blockAnswer[LOGIN_C] = 'blocked|true|true|false';
    await switchTick(now);
    expect(ev('tainted:')).toEqual([`tainted:${SLOT_B}`]);
    expect(seen.warn).toContain(LOG_FOREIGN(LOGIN_C, SLOT_B, ENDED, DROPPED));
  });
});

describe('O7 switches and peers (3.9, R5, R10, R11)', () => {
  const ADDR = (slot: string | null, host: string) => ({ host, port: 5434, slot, machine: host, cert: COPY_PEM });

  it('X11: ownPeers probes rows of member logins with LOGIN, never the own slot or a slot of another shape', async () => {
    fake.dbs['a-pg'].addresses = [ADDR(null, 'main.example'), ADDR(SLOT_B, 'b.example'), ADDR(`fleet_standby_${hex('c')}`, 'c.example'), ADDR(OWN_SLOT, 'own.example'), ADDR('slot_x', 'x.example'), ADDR(SLOT_D, 'd.example')];
    fake.dbs['a-pg'].members = [LOGIN_B, OWN, `smdb_copy_${hex('d')}`];
    await switchTick(now);
    expect(h.events.filter(e => e.startsWith('probe:'))).toEqual(['probe:b.example', 'probe:d.example']);
    const sql = fake.calls.find(c => c.input.includes("AND a.slot <> '"))!.input;
    expect(sql).toContain(`a.slot <> '${OWN_SLOT}'`);
    expect(sql).toContain("m.roleid = pg_catalog.to_regrole('smdb_copies')");
    expect(sql).toContain('r.rolcanlogin');
  });

  it('L21: a main with no stored own login probes no peer and marks nothing', async () => {
    withMain({}, { fleetLogin: undefined });
    fake.dbs['a-pg'].addresses = [ADDR(SLOT_B, 'b.example')];
    h.peer = () => ({ kind: 'writable', systemId: '7001', timeline: 2, gen: { generation: 9, machine: 'b.example', since: null }, receiveMark: false }) as any;
    await switchTick(now);
    expect(h.events.filter(e => e.startsWith('probe:'))).toEqual([]);
    expect(stored(ID).fleetDb.replacedBy).toBeUndefined();
    expect(stored(ID).fleetDb.mainConflict).toBeUndefined();
  });

  const TARGET = { host: 'peer.example', port: 5500, cert: COPY_PEM, machine: 'peer.example' };

  it('X2, X3: composeJoinCode carries this machine\'s own login, with no replication record needed', () => {
    withMain({ replication: undefined });
    const r = composeJoinCode(containerManager.getBot(ID)!, TARGET);
    expect(r.ok).toBe(true);
    const d = decodeJoinCode((r as { text: string }).text);
    expect(d.ok && d.code.repl).toEqual({ user: OWN, password: 'ownpass' });
  });

  it.each([
    ['absent', undefined],
    ['lost', { password: '' }],
  ])('X10: no stored own password (%s): CJ-NOLOGIN', (_n, login) => {
    withMain({}, { fleetLogin: login });
    expect(composeJoinCode(containerManager.getBot(ID)!, TARGET)).toEqual({ ok: false, error: "this machine's own login to the other databases is not stored" });
  });

  it('R11: the automatic rejoin\'s refused login names this machine\'s own login', async () => {
    withMain({ handover: { mode: 'stream', phase: 'stopped', machine: 'copy.example', host: 'copy.example', port: 5434, cert: COPY_PEM, generation: 4, at: '2026-11-15T09:00:00.000Z' } });
    h.peer = () => ({ kind: 'login-refused', reason: 'password authentication failed' }) as any;
    await switchTick(now);
    expect(stored(ID).fleetDb.handover.rejoinError).toBe("copy.example refused this machine's own login (password authentication failed). Copy copy.example's join code and paste it into Rejoin as a copy.");
  });

  it('R9, S6 at sw:1476: formerCheck registers without a slot and logs ADDR-TAKEN as registerAddress answers it', async () => {
    const FORMER = { code: fakeJoinCode({ host: 'old.example', port: 5500, machine: 'old.example' }), slot: OWN_SLOT, machine: 'old.example', host: 'old.example', port: 5500, generation: 2, at: '2026-11-01T00:00:00.000Z' };
    withMain({ formerMain: FORMER });
    h.peer = (host: string) => (host === 'old.example' ? { kind: 'writable', systemId: '7001', timeline: 3, gen: { generation: 2, machine: 'old.example', since: null }, receiveMark: false } : { kind: 'unreachable', reason: 'x' }) as any;
    const taken = `its address main.example:5433 is listed on the main for the machine login ${LOGIN_B}. If no machine uses that address under that login any more, remove the login ${LOGIN_B} in the main's Database window; this machine then adds its address at its next hourly check`;
    h.register = taken;
    await switchTick(now);
    expect(h.registerCalls).toEqual([{ host: 'old.example', port: 5500, row: { host: 'main.example', port: 5433, cert: COPY_PEM, machine: 'main.example' } }]);
    expect(seen.warn).toContain(`[Switch] A: the old main old.example runs again as a main; this machine's address could not be added to its copy list (${taken})`);
  });

  it('X4 (R10): take-over\'s oldRow deletes every row of the old list in one text', async () => {
    fake.dbs['c-pg'] = freshDb({ recovery: true, generation: { generation: 3, machine: 'main.invalid', since: '2026-10-28T10:00:00Z' }, handover: { slot: 'slot_c', machine: 'copy.example', generation: 4 }, addresses: [
      { host: 'main.invalid', port: 15432, slot: null, machine: 'main.invalid', cert: COPY_PEM },
      { host: 'older.example', port: 15430, slot: null, machine: 'older.example', cert: COPY_PEM },
      { host: 'copy.example', port: 5434, slot: 'slot_c', machine: 'copy.example', cert: COPY_PEM },
    ] });
    writeRegistry({ c: copyFixture() });
    expect((await takeOverMain('c')).success).toBe(true);
    const raise = fake.calls.find(c => c.input.includes('INSERT INTO smdb_manager.generation AS g'))!.input;
    expect(raise).toContain("DO $$ BEGIN\nIF to_regclass('smdb_manager.addresses') IS NOT NULL THEN\n  DELETE FROM smdb_manager.addresses;\nEND IF;\nEND $$;");
    expect(raise).not.toContain('EXECUTE format');
    expect(fake.dbs['c-pg'].addresses).toEqual([]);
  });

  it('mv:292, mv:293 (3.10, R11): Receive makes sure smdb_copies exists; its refusal names the group', async () => {
    withMain({}, { maintenance: { state: 'off', message: '', orderedAt: '2026-11-15T00:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: 'maintenance' } });
    fake.dbs['a-pg'].fail['role-ensure'] = 'ERROR:  permission denied to create role';
    const r = await receive(ID);
    expect(r).toMatchObject({ success: false, status: 500, text: "The manager could not make sure the group of the machines' logins (smdb_copies) exists in this database's cluster (ERROR:  permission denied to create role), and a pushed database that grants to it would not restore; nothing was changed" });
    const ensure = fake.calls.find(c => c.input.includes('CREATE ROLE'))!.input;
    expect(ensure).toContain('CREATE ROLE smdb_copies NOLOGIN');
    expect(ensure).not.toContain('REPLICATION');
  });
});
