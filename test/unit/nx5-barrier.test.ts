// NX5 test 11: Maintenance and Off on a save-order app: the order row, the wait for every claim holder's answer, the
// block, the final read and its verdict, with every failure rule of decision 4 (H3, J1, L4, P1, P2, R1, R2).
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/docker/processStart', async (o) => (await import('./nx5-kit')).processStartMock(await o()));
vi.mock('../../src/instance/switchSql', async (o) => (await import('./nx5-kit')).switchSqlMock(await o()));
vi.mock('../../src/env/manager', async (o) => (await import('./nx5-kit')).envMock(await o()));
vi.mock('../../src/config/appCapabilities', async (o) => (await import('./nx5-kit')).capsMock(await o()));
vi.mock('../../src/docker/containerManager', async () => (await import('./nx5-kit')).containerManagerMock());
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./nx5-kit')).dbLoginMock(await o()));
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./nx5-kit')).appHookMock(await o()));
vi.mock('../../src/instance/fleetReplication', async (o) => (await import('./nx5-kit')).fleetReplicationMock(await o()));

import * as switchSql from '../../src/instance/switchSql';
import { MAINTENANCE_TIMING, maintenanceStatus, noteRestoredOrder, reconcileMaintenance, resetMaintenanceState, runMaintenanceOrder } from '../../src/instance/maintenance';
import { CONTAINER, claim, h, k, resetH, resetKit, saveOrderWrites, settledRec, setupBot, wire } from './nx5-kit';
import { TX } from './nx5-texts-kit';

const T = MAINTENANCE_TIMING as any;
const d = () => k.dbs[CONTAINER];
const rec = () => h.inst.maintenance;
const BLOCKED = () => ({ inRecovery: false, canLogin: false, sessions: 0 });
const DISK = 'ERROR:  disk full';
const TIMEOUT = 'ERROR:  canceling statement due to statement timeout';
const LOGIN_ERR = 'docker did not answer within 30 s';

beforeEach(() => {
  resetMaintenanceState();
  resetH();
  resetKit();
  wire();
  setupBot();
  T.ackPollMs = 2;
  T.ackWaitMs = 60;
  MAINTENANCE_TIMING.hookWaitMs = 30;
  MAINTENANCE_TIMING.hookWaitPauseMs = 1;
  MAINTENANCE_TIMING.hookWaitTryMs = 10;
});

const M = (message = 'Back soon') => runMaintenanceOrder('b1', 'maintenance', message);
const OFF = (message = 'Gone') => runMaintenanceOrder('b1', 'off', message);
const RUN = () => runMaintenanceOrder('b1', 'running', '');
const retry = (to = 'maintenance') => runMaintenanceOrder('b1', to as any, '', { retry: true });
const resumed = (to = 'maintenance') => runMaintenanceOrder('b1', to as any, '', { resumed: true });
const readsBefore = (step: string) => h.events.slice(0, Math.max(0, h.events.indexOf(step))).filter(e => e === 'read').length;
const idle = async () => { for (let i = 0; i < 100 && h.lock; i++) await new Promise(r => setTimeout(r, 2)); };
const row = (id: string, over: Record<string, unknown> = {}) => ({ id, state: 'maintenance' as const, message: 'old', generation: 3, reason: 'order' as const, upMs: 100_000, ...over });
/** A settled Maintenance whose order X every process (p1 on host-a) answered, the login blocked since. */
const settledX = (over: Record<string, unknown> = {}) => {
  setupBot(settledRec('maintenance', { fleet: { orderId: 'X', generation: 3, upMs: 100_000, askedBlocked: false, blockedAt: '2026-11-16T09:00:00.000Z', orderFor: '2026-10-01T00:00:00.000Z', verdict: { kind: 'confirmed' } }, ...over }));
  h.db = BLOCKED();
  d().order = row('X');
  d().claims = [claim('p1', 'host-a')];
  d().acks = [{ process: 'p1', order: 'X', saved: true }];
};

describe('the wait for every expected process (decision 3)', () => {
  it('every expected process answered: the hook follows the first poll', async () => {
    d().claims = [claim('p1', 'host-a'), claim('p2', 'host-b')];
    d().autoAck = { p1: { saved: true }, p2: { saved: true } };
    const r = await M();
    expect(h.events.indexOf('order-write')).toBeGreaterThanOrEqual(0);
    expect(readsBefore('hook:maintenance')).toBe(1);
    expect(h.events.indexOf('hook:maintenance')).toBeLessThan(h.events.indexOf('block'));
    expect(r.settled).toBe(true);
    expect(r.text).toContain(TX.covered(2, 'host-a, host-b'));
    expect(rec().fleet.verdict.kind).toBe('confirmed');
  });
  it('one never answers (a crashed holder stays expected): the block at the bound, the text names its machine and last renewal', async () => {
    d().claims = [claim('p1', 'host-a'), claim('p2', 'host-b', 200_000, { agoMs: 4000 })];
    d().autoAck = { p1: { saved: true } };
    T.ackWaitMs = 600;
    const r = await M();
    expect(readsBefore('block')).toBeGreaterThan(2);
    expect(r.settled).toBe(true);
    expect(r.text).toContain(TX.uncovered('host-b', '4 seconds'));
    expect(r.text).not.toContain(TX.update);
    expect(r.text).not.toMatch(/60.second/);
  });
  it('no process answered at all: the text adds the update clause', async () => {
    d().claims = [claim('p2', 'host-b', 200_000, { agoMs: 4000 })];
    const r = await M();
    expect(r.text).toContain(TX.uncovered('host-b', '4 seconds') + TX.update);
  });
  it('a process that took a shard after the order began is expected', async () => {
    d().claims = [claim('p1', 'host-a')];
    d().autoAck = { p1: { saved: true } };
    k.onRead = (db, n) => { if (n === 1) db.claims.push(claim('p3', 'host-c', 300_000, { agoMs: 3000 })); };
    const r = await M();
    expect(r.text).toContain(TX.uncovered('host-c', '3 seconds'));
  });
  it('a process whose rows were released is not expected', async () => {
    d().claims = [claim('p1', 'host-a'), claim('p2', 'host-b', 200_000, { released: true })];
    d().autoAck = { p1: { saved: true } };
    const r = await M();
    expect(r.text).toContain(TX.covered(1, 'host-a'));
    expect(r.text).not.toContain('host-b');
  });
  it('a row that lapsed before the order is not seen, and named', async () => {
    d().claims = [claim('p1', 'host-a'), claim('p3', 'host-c', 50_000, { agoMs: 130_000 })];
    d().autoAck = { p1: { saved: true } };
    const r = await M();
    expect(r.text).toContain(TX.notSeen('host-c', 'Maintenance', '2 minutes'));
    expect(r.text).toContain(TX.covered(1, 'host-a'));
  });
  it('a row that lapses during the wait keeps its holder expected', async () => {
    d().claims = [claim('p1', 'host-a'), claim('p2', 'host-b', 100_500, { agoMs: 6000 })];
    d().autoAck = { p1: { saved: true } };
    k.onRead = (db) => { db.clock = 400_000; };
    const r = await M();
    expect(r.text).toContain(TX.uncovered('host-b', '6 seconds'));
    expect(r.text).not.toContain('was not waited for');
  });
  it.each([['standby', false], ['flipped', false], ['done', true]] as const)("NB9's to_count rows while the reshard is %s", async (state, counts) => {
    d().claims = [claim('p1', 'host-a', 200_000, { count: 2 }), claim('p9', 'host-s', 200_000, { count: 4 })];
    d().reshard = { state, toCount: 4 };
    d().autoAck = { p1: { saved: true } };
    const r = await M();
    if (counts) expect(r.text).toContain(TX.uncovered('host-s', '4 seconds'));
    else expect(r.text).toContain(TX.covered(1, 'host-a'));
  });
  it("a newer process's true answer on the same node does not cover a process that still holds rows", async () => {
    d().claims = [claim('old', 'host-a', 200_000, { node: 'n1' }), claim('new', 'host-a', 200_000, { node: 'n1' })];
    d().autoAck = { new: { saved: true } };
    const r = await M();
    expect(r.text).toContain(TX.uncovered('host-a', '4 seconds'));
  });
  it('two processes of one node both must answer', async () => {
    d().claims = [claim('p1', 'host-a', 200_000, { node: 'n1' }), claim('p2', 'host-a', 200_000, { node: 'n1' })];
    d().autoAck = { p1: { saved: true }, p2: { saved: true } };
    const r = await M();
    expect(r.text).toContain(TX.covered(2, 'host-a'));
  });
  it('answers false and null map to their texts', async () => {
    d().claims = [claim('p2', 'host-b'), claim('p3', 'host-c')];
    d().autoAck = { p2: { saved: false, unsavedGuilds: 2, unsavedFiles: 1 }, p3: { saved: null, unansweredGuilds: 3 } };
    const r = await M();
    expect(r.text).toContain(TX.unsaved('host-b', 2, 1));
    expect(r.text).toContain(TX.unconfirmed('host-c', 3));
  });
  it.each([['Maintenance', 'maintenance'], ['Off', 'off']] as const)('the waiting line of %s names the machines not yet covered', async (to, state) => {
    d().claims = [claim('p1', 'host-a'), claim('p2', 'host-b')];
    d().autoAck = { p1: { saved: true } };
    T.ackWaitMs = 600;
    const lines: string[] = [];
    k.onRead = async (_db, n) => { if (n === 2) lines.push((await maintenanceStatus(JSON.parse(JSON.stringify(h.inst)), null)).summary); };
    await runMaintenanceOrder('b1', state, 'x');
    expect(lines[0]).toMatch(TX.waiting(to, 'host-b'));
  });
  it('an empty expected set settles with the waited-for-none text', async () => {
    const r = await M();
    expect(r.settled).toBe(true);
    expect(r.text).toContain(TX.empty('Maintenance'));
    expect(readsBefore('block')).toBe(1);
  });
});

describe('a database without the claim tables (H3)', () => {
  it('missing shard_claims: cantConfirm with the no-tables reason, acks ends at once', async () => {
    d().claimTables = false;
    const r = await M();
    expect(readsBefore('block')).toBeLessThanOrEqual(1);
    expect(r.settled).toBe(true);
    expect(r.text).toContain(TX.cant(TX.noTables, TX.once));
    expect(rec().fleet.verdict.kind).toBe('cantConfirm');
  });
  it.each([['maintenance', 'Maintenance'], ['off', 'Off']] as const)('no claim_clock: %s settles with up_ms NULL and the can\'t-confirm verdict', async (state: 'maintenance' | 'off', _to: string) => {
    d().clock = null;
    const r = await runMaintenanceOrder('b1', state, 'x');
    expect(d().order!.upMs).toBeNull();
    expect(r.settled).toBe(true);
    expect(r.text).toContain(TX.cant(TX.noTables, TX.once));
  });
});

describe('the order row: resume, keep and new ids (G5, L4, P1)', () => {
  const pending = (fleet: Record<string, unknown>) => setupBot({ state: 'maintenance', message: 'm', orderedAt: '2026-11-16T10:00:00.000Z', settled: false, hook: 'unconfirmed', login: 'unconfirmed', savedByBot: 'running', prior: { state: 'running', message: '' }, fleet });
  it('a manager restart during the wait resumes with the recorded id when the row carries it', async () => {
    pending({ orderId: 'X', generation: 3, upMs: 100_000, orderFor: '2026-11-16T10:00:00.000Z' });
    d().order = row('X'); d().claims = [claim('p1', 'host-a')]; d().autoAck = { p1: { saved: true } };
    const r = await resumed();
    expect(h.events).toContain('order-write');
    expect(d().order!.id).toBe('X');
    expect(d().order!.message).toBe('m');
    expect(rec().fleet.orderId).toBe('X');
    expect(rec().fleet.verdict.kind).toBe('confirmed');
    expect(r.text).toContain(TX.covered(1, 'host-a'));
  });
  it('and writes a new id when the row does not carry it', async () => {
    pending({ orderId: 'X', generation: 3, upMs: 100_000, orderFor: '2026-11-16T10:00:00.000Z' });
    d().order = row('Y');
    await resumed();
    expect(['X', 'Y']).not.toContain(d().order!.id);
    expect(rec().fleet.orderId).toBe(d().order!.id);
  });
  it.each([
    ['current, at maintenance, the recorded id, blockedAt set: kept', {}, {}, true],
    ['blockedAt unset: a new id', { blockedAt: undefined }, {}, false],
    ['the row of a lower generation: a new id', {}, { generation: 2 }, false],
    ["the row at 'running': a new id", {}, { state: 'running' }, false],
  ] as const)('with the login blocked, %s', async (_n, fleetOver, rowOver, kept) => {
    settledX();
    const fleet = { ...rec().fleet, ...fleetOver };
    if ('blockedAt' in fleetOver) delete fleet.blockedAt;
    h.inst.maintenance.fleet = fleet;
    d().order = row('X', rowOver);
    await M('again');
    expect(h.events).toContain('order-write');
    expect(d().order!.id === 'X').toBe(kept);
    expect(d().order!.message).toBe('again');
    expect(rec().fleet.orderId).toBe(d().order!.id);
    if (kept) expect(d().acks).toHaveLength(1);
    else expect(d().acks).toEqual([]);
  });
  it('Running, then a tie\'s block, then Maintenance: a new id, no answers, asked blocked', async () => {
    settledX();
    await RUN();
    expect(d().order).toMatchObject({ id: 'X', state: 'running' });
    expect(rec().fleet).toEqual({ orderId: 'X' });
    h.db = BLOCKED();
    const r = await M();
    expect(d().order!.id).not.toBe('X');
    expect(d().acks).toEqual([]);
    expect(rec().fleet.askedBlocked).toBe(true);
    expect(r.text).toContain(TX.askedBlocked);
  });
  it("a row of reason 'restore' is reason 'order' after Running", async () => {
    settledX();
    d().order = row('X', { reason: 'restore' });
    await RUN();
    expect(d().order).toMatchObject({ state: 'running', reason: 'order' });
    expect(d().acks).toEqual([]);
  });
  it('the block saves blockedAt at once, before the settle write', async () => {
    d().claims = [claim('p1', 'host-a')]; d().autoAck = { p1: { saved: true } };
    await M();
    const first = h.writes.findIndex(w => w?.fleet?.blockedAt);
    expect(first).toBeGreaterThan(0);
    expect(h.writes[first].settled).toBe(false);
  });
  it('a manager restart between block and final resumes with blockedAt set and keeps the answers', async () => {
    pending({ orderId: 'X', generation: 3, upMs: 100_000, orderFor: '2026-11-16T10:00:00.000Z', askedBlocked: false, blockedAt: '2026-11-16T10:00:05.000Z' });
    h.db = BLOCKED();
    d().order = row('X'); d().claims = [claim('p1', 'host-a')]; d().acks = [{ process: 'p1', order: 'X', saved: true }];
    const r = await resumed();
    expect(d().order!.id).toBe('X');
    expect(d().acks).toHaveLength(1);
    expect(r.text).toContain(TX.covered(1, 'host-a'));
  });
});

describe('a failing order write (H3, J1, L4)', () => {
  it('fails once with the login open: nothing blocked, unsettled, orderFails 1 saved; the second failure blocks, ends the sessions and records cantConfirm', async () => {
    d().failNext.order = [DISK, DISK];
    const r = await M();
    expect(r).toEqual({ settled: false, text: TX.orderFail('Maintenance', DISK) });
    expect(h.events).not.toContain('block');
    expect(h.events).not.toContain('hook:maintenance');
    expect(rec().fleet).toMatchObject({ orderFails: 1, orderError: { login: 'open' } });
    h.events = [];
    const again = await retry();
    expect(h.events).toEqual(expect.arrayContaining(['block', 'end-sessions']));
    expect(again.settled).toBe(true);
    expect(again.text).toContain(TX.cant(TX.notWritten(DISK)));
    expect(rec().fleet.verdict.kind).toBe('cantConfirm');
  });
  it('an Off whose second failure comes after a manager restart stops the bot', async () => {
    d().failNext.order = [DISK, DISK];
    const r = await OFF();
    expect(r).toEqual({ settled: false, text: TX.orderFail('Off', DISK) });
    h.events = [];
    const again = await resumed('off');
    expect(h.events).toEqual(expect.arrayContaining(['block', 'end-sessions', 'stop:maintenance']));
    expect(again.text).toContain(TX.cant(TX.notWritten(DISK)));
  });
  it("the reviewer's sequence (X settled, Running, a Maintenance whose order fails, a tie's block, the retry) never records X's verdict", async () => {
    settledX();
    await RUN();
    d().failNext.order = [DISK, DISK];
    await M();
    h.db = BLOCKED();
    const r = await retry();
    expect(['cantConfirm', 'notAsked']).toContain(rec().fleet.verdict?.kind);
    expect(r.text).not.toContain('Every bot process');
  });
  it('Maintenance from Off whose write fails once with the login blocked settles in that pass: started, hook waited, not asked', async () => {
    setupBot(settledRec('off', { hook: 'none' }));
    h.app = false; h.db = BLOCKED();
    d().failNext.order = [DISK];
    const r = await M();
    expect(h.events).toEqual(expect.arrayContaining(['block', 'end-sessions', 'start:maintenance', 'hook:maintenance']));
    expect(r.settled).toBe(true);
    expect(r.text).toContain(TX.notAskedErr(DISK));
    expect(rec().fleet.verdict.kind).toBe('notAsked');
  });
  it('a Maintenance whose order failed once, then Off: the Off starts with no failure count and ends its pass at its first failure', async () => {
    d().failNext.order = [DISK, DISK];
    await M();
    expect(rec().fleet.orderFails).toBe(1);
    h.events = [];
    const r = await OFF();
    expect(r).toEqual({ settled: false, text: TX.orderFail('Off', DISK) });
    expect(rec().fleet.orderFails).toBe(1);
    expect(h.events).not.toContain('block');
  });
  it('Off from Maintenance with the bot running, the login blocked and the order failing: the hook goes before the stop', async () => {
    settledX();
    h.inst.maintenance.fleet.blockedAt = undefined;
    d().failNext.order = [DISK];
    await OFF();
    expect(h.events.indexOf('order-write')).toBeGreaterThanOrEqual(0);
    expect(h.events.indexOf('order-write')).toBeLessThan(h.events.indexOf('hook:maintenance'));
    expect(h.events.indexOf('hook:maintenance')).toBeLessThan(h.events.indexOf('stop:maintenance'));
    expect(rec().fleet.orderError).toEqual({ reason: DISK, login: 'blocked' });
  });
  it('a kept row whose new message fails under blockedAt records the answers\' verdict with the message sentence', async () => {
    settledX();
    d().failNext.order = [DISK];
    const r = await M('new text');
    expect(r.settled).toBe(true);
    expect(r.text).toContain(TX.covered(1, 'host-a'));
    expect(r.text).toContain(TX.msgWrite(DISK));
  });
  it("review 2 finding 3: the order lands, the block fails, two retries fail the keep write of the same message: the verdict has no message sentence", async () => {
    d().claims = [claim('p1', 'host-a')]; d().autoAck = { p1: { saved: true } };
    h.block = { ok: false, error: 'ERROR:  permission denied' };
    const first = await M('Back soon');
    expect(first.settled).toBe(false);
    expect(d().order).toMatchObject({ message: 'Back soon', reason: 'order' });
    expect(h.events).toEqual(expect.arrayContaining(['order-write', 'block']));
    d().failNext.order = [DISK, DISK];
    const once = await retry();
    expect(once.settled).toBe(false);
    expect(rec().fleet).toMatchObject({ orderFails: 1, orderError: { reason: DISK, login: 'open' } });
    h.block = { ok: true };
    const again = await retry();
    expect(again.settled).toBe(true);
    expect(rec().fleet.verdict.kind).toBe('confirmed');
    expect(again.text).toContain(TX.covered(1, 'host-a'));
    expect(again.text).not.toContain(TX.msgWrite(DISK));
    expect(again.text).not.toContain('could not write the new message');
  });
  it("round 4: the login opened outside Running, the block-again clears blockedAt, an Off whose new id fails: the record loses orderId and blockedAt first, then 'not asked'", async () => {
    settledX();
    h.db = { inRecovery: false, canLogin: true, sessions: 0 };
    await reconcileMaintenance();
    await idle();
    expect(rec().fleet.blockedAt).toBeUndefined();
    expect(h.db.canLogin).toBe(false);
    h.writes = [];
    d().failNext.order = [DISK];
    const r = await OFF();
    const cleared = h.writes.findIndex((w, i) => i > 0 && w?.fleet && !w.fleet.orderId && !w.fleet.blockedAt);
    const failed = h.writes.findIndex(w => w?.fleet?.orderFails);
    expect(cleared).toBeGreaterThan(0);
    expect(cleared).toBeLessThan(failed);
    expect(r.text).toContain(TX.notAskedErr(DISK));
    expect(r.text).not.toContain('Every bot process');
  });
});

describe('round 5: the mark and the final read (P1, P2)', () => {
  it("X settled, the login opened and blocked again, an Off whose db-up fails, the database back, the retry: order runs under the block, the record loses orderId first, 'asked blocked'", async () => {
    settledX();
    h.db = { inRecovery: false, canLogin: true, sessions: 0 };
    await reconcileMaintenance();
    await idle();
    h.sidecar = false; h.dbUp = { success: false, error: 'compose failed' };
    await OFF();
    expect(rec().settled).toBe(false);
    h.sidecar = true; h.events = []; h.writes = [];
    const r = await retry('off');
    expect(h.events).toContain('order-write');
    expect(d().order!.id).not.toBe('X');
    expect(h.writes.some(w => w?.fleet && !w.fleet.orderId)).toBe(true);
    expect(r.text).toContain(TX.askedBlocked);
    expect(r.text).not.toContain('Every bot process');
  });
  it('the final read failing once leaves Maintenance from Off unsettled with its text and reason; the bot still starts; the retry settles', async () => {
    setupBot(settledRec('off', { hook: 'none' }));
    h.app = false; h.db = BLOCKED();
    d().failNext.read = [TIMEOUT];
    const r = await M();
    expect(r).toEqual({ settled: false, text: TX.finalFail('Maintenance', TIMEOUT) });
    expect(rec().lastError).toBe(TX.finalReason(TIMEOUT));
    expect(rec().fleet.verdict).toBeUndefined();
    expect(h.events).toContain('start:maintenance');
    const again = await retry();
    expect(again.settled).toBe(true);
    expect(rec().fleet.verdict).toBeDefined();
  });
  it('the final read failing once leaves Off unsettled with its text; the stop still runs', async () => {
    settledX();
    d().failNext.read = [TIMEOUT];
    const r = await OFF();
    expect(r).toEqual({ settled: false, text: TX.finalFail('Off', TIMEOUT) });
    expect(h.events).toContain('stop:maintenance');
    expect(r.text).not.toContain('the stop failed');
  });
  it('a final failure beside a dbFail keeps the dbFail text', async () => {
    settledX();
    h.readQueue = [null, LOGIN_ERR];
    d().failNext.read = [TIMEOUT];
    const r = await M();
    expect(h.events.filter(e => e === 'read')).toHaveLength(1);
    expect(d().failNext.read).toEqual([]);
    expect(rec().fleet.verdict).toBeUndefined();
    expect(r.text.startsWith(`Maintenance is not confirmed: the manager can't confirm the login is blocked: ${LOGIN_ERR}.`)).toBe(true);
    expect(rec().lastError).toBe(`the manager can't confirm the login is blocked: ${LOGIN_ERR}`);
    expect(r.text).not.toContain('could not read whether');
  });
  it("a row written under a blocked login with a non-empty expected set records 'asked blocked', never the not-covered text", async () => {
    setupBot(settledRec('maintenance'));
    h.db = BLOCKED();
    d().claims = [claim('p1', 'host-a')];
    const r = await M();
    expect(r.text).toContain(TX.askedBlocked);
    expect(r.text).not.toContain('did not confirm that it saved');
  });
  it("a kept row of reason 'restore' records 'restored'", async () => {
    settledX();
    d().order = row('X', { reason: 'restore' });
    d().acks = [];
    const r = await M();
    expect(r.text).toContain(TX.restored);
    expect(rec().fleet.verdict.kind).toBe('restored');
  });
  it("P2's condition: an Off whose container still runs after the stop, with the final read failing, keeps today's stop text", async () => {
    settledX();
    h.appAfterStop = true;
    d().failNext.read = [TIMEOUT];
    const r = await OFF();
    expect(h.events.filter(e => e === 'read')).toHaveLength(1);
    expect(d().failNext.read).toEqual([]);
    expect(rec().fleet.verdict).toBeUndefined();
    expect(r.text).toBe("Off is not confirmed: the stop failed (the bot still runs after the stop). The bot's database login is blocked, so it cannot write. Choose Off again to retry.");
    expect(rec().lastError).toBe('the stop failed (the bot still runs after the stop)');
  });
  it("P2's condition: Maintenance from Off whose bot is not running after the start, with the final read failing, says the bot did not start", async () => {
    setupBot(settledRec('off', { hook: 'none' }));
    h.app = false; h.appAfterStart = false; h.db = BLOCKED();
    d().failNext.read = [TIMEOUT];
    const r = await M();
    expect(h.events.filter(e => e === 'read')).toHaveLength(1);
    expect(d().failNext.read).toEqual([]);
    expect(rec().fleet.verdict).toBeUndefined();
    expect(r.text).toContain('the bot did not start');
    expect(r.text).not.toContain('could not read whether');
  });
});

describe('round 6: a login read before order that fails (R1, R2)', () => {
  it('times out once with the login open: no save_order write, no hook, no block, orderFails 1 with login unread; the retry writes, waits, and names the silent machine', async () => {
    h.failPreBlock = LOGIN_ERR;
    const r = await M();
    expect(saveOrderWrites()).toEqual([]);
    expect(h.events.some(e => e.startsWith('hook'))).toBe(false);
    expect(h.events).not.toContain('block');
    expect(rec().fleet).toMatchObject({ orderFails: 1, orderError: { login: 'unread' } });
    expect(r).toEqual({ settled: false, text: TX.orderFail('Maintenance', TX.readReason(LOGIN_ERR)) });
    h.failPreBlock = null; h.events = [];
    d().claims = [claim('p2', 'host-b', 200_000, { agoMs: 4000 })];
    const again = await retry();
    expect(h.events).toContain('order-write');
    expect(readsBefore('block')).toBeGreaterThan(1);
    expect(again.text).toContain(TX.uncovered('host-b', '4 seconds'));
    expect(again.text).not.toMatch(/60.second/);
  });
  it("a second failed read lets block, end-sessions and final run with no transaction and records 'unread'", async () => {
    h.failPreBlock = LOGIN_ERR;
    await M();
    h.events = [];
    const r = await retry();
    expect(saveOrderWrites()).toEqual([]);
    expect(h.events).toEqual(expect.arrayContaining(['block', 'end-sessions']));
    expect(rec().fleet.verdict.kind).toBe('unread');
    expect(r.text).toContain(TX.unread(LOGIN_ERR));
    expect(r.text).not.toContain('did not confirm that it saved');
    expect(r.text).not.toMatch(/within 60 seconds/);
  });
  it('with blockedAt set and two failed reads the recorded id stays and the answers\' verdict carries the did-not-write sentence', async () => {
    settledX();
    h.failPreBlock = LOGIN_ERR;
    await M('new text');
    h.events = [];
    const r = await retry();
    expect(rec().fleet.orderId).toBe('X');
    expect(r.text).toContain(TX.covered(1, 'host-a'));
    expect(r.text).toContain(TX.msgRead(LOGIN_ERR));
  });
  it('with blockedAt unset a failed read saves the record without orderId before the pass ends', async () => {
    settledX();
    delete h.inst.maintenance.fleet.blockedAt;
    h.failPreBlock = LOGIN_ERR;
    await OFF();
    expect(rec().fleet.orderId).toBeUndefined();
    expect(rec().settled).toBe(false);
  });
  it('Maintenance from Off whose first read fails ends its pass; the retry reads blocked, records a verdict, starts nothing, and ends with RETRY_NO_START', async () => {
    setupBot(settledRec('off', { hook: 'none' }));
    h.app = false; h.db = BLOCKED();
    h.failPreBlock = LOGIN_ERR;
    const r = await M();
    expect(r.settled).toBe(false);
    expect(h.events.some(e => e.startsWith('start'))).toBe(false);
    h.failPreBlock = null; h.events = [];
    const again = await retry();
    expect(h.events).toContain('order-write');
    expect(rec().fleet.verdict).toBeDefined();
    expect(h.events.some(e => e.startsWith('start'))).toBe(false);
    expect(again.text).toContain('the bot is stopped, and a retry does not start it');
  });
  it('R2: a row first written under the block and kept under an open login is judged by the wait that ran', async () => {
    setupBot(settledRec('off', { hook: 'none' }));
    h.app = false; h.db = BLOCKED();
    d().claims = [claim('p1', 'host-a')]; d().autoAck = { p1: { saved: true } };
    const first = await M();
    expect(first.text).toContain(TX.askedBlocked);
    const y = d().order!.id;
    expect(rec().fleet.askedBlocked).toBe(true);
    h.db = { inRecovery: false, canLogin: true, sessions: 0 };
    const second = await M();
    expect(d().order!.id).toBe(y);
    expect(rec().fleet.askedBlocked).toBe(false);
    expect(second.text).toContain(TX.covered(1, 'host-a'));
    expect(rec().fleet.verdict.kind).toBe('confirmed');
    const third = await M();
    expect(d().order!.id).toBe(y);
    expect(rec().fleet.askedBlocked).toBe(false);
    expect(third.text).toContain(TX.covered(1, 'host-a'));
  });
});

describe("the restore's rewrite (decision 7)", () => {
  it("rides the restore's raise: the generation first, then the DDL, the answers' delete and the row with the recorded id and reason 'restore' at the raised generation", () => {
    const sql: string = (switchSql as any).raiseSql('main.example', 5, (switchSql as any).restoreOrderSql({ user: 'smdb', orderId: 'X', message: 'm' }));
    expect(sql.match(/\bBEGIN\b/g)).toHaveLength(1);
    expect(sql.match(/\bCOMMIT\b/g)).toHaveLength(1);
    const raise = sql.indexOf('INSERT INTO smdb_manager.generation');
    const ddl = sql.indexOf((switchSql as any).SAVE_ORDER_DDL('smdb'));
    const del = sql.indexOf('DELETE FROM smdb_manager.save_acks;');
    const at = sql.indexOf('INSERT INTO smdb_manager.save_order');
    expect(raise).toBeGreaterThan(0);
    expect(raise).toBeLessThan(ddl);
    expect(ddl).toBeLessThan(del);
    expect(del).toBeLessThan(at);
    expect(at).toBeLessThan(sql.indexOf('COMMIT'));
    const write = sql.slice(at, sql.indexOf(';', at));
    expect(write).toContain("'X', 'maintenance', 'm', coalesce((SELECT generation FROM smdb_manager.generation), 0), 'restore'");
    expect(write).toContain("order_id = EXCLUDED.order_id, state = 'maintenance'");
    expect(write).toContain("reason = 'restore'");
  });
  it('the record takes the id and a block mark when it had none, and keeps the mark it had', () => {
    setupBot(settledRec('maintenance'));
    noteRestoredOrder('b1', 'X');
    expect(rec().fleet.orderId).toBe('X');
    expect(typeof rec().fleet.blockedAt).toBe('string');
    setupBot(settledRec('maintenance', { fleet: { orderId: 'X', blockedAt: '2026-11-16T09:00:00.000Z', askedBlocked: true } }));
    noteRestoredOrder('b1', 'X');
    expect(rec().fleet).toEqual({ orderId: 'X', blockedAt: '2026-11-16T09:00:00.000Z', askedBlocked: true, verdict: { kind: 'restored', text: TX.restored } });
  });
  it("review 2 finding 2: after an 'uncovered' settle the restore records 'restored' and its text replaces the refusal warning", async () => {
    d().claims = [claim('p1', 'host-a')];
    const r = await M();
    expect(r.settled).toBe(true);
    expect(rec().fleet.verdict.kind).toBe('uncovered');
    expect(rec().lastError).toContain('Hand over, Push and Move by file are refused until every bot confirms');
    noteRestoredOrder('b1', rec().fleet.orderId);
    expect(rec().fleet.verdict).toEqual({ kind: 'restored', text: TX.restored });
    expect(rec().lastError).toBe(TX.restored);
    expect(rec().settled).toBe(true);
  });
  it('review 2 finding 2: a reason that is not the verdict\'s warning stays the record\'s lastError', () => {
    setupBot(settledRec('maintenance', { settled: false, lastError: 'the hook did not answer', fleet: { orderId: 'X', blockedAt: '2026-11-16T09:00:00.000Z', verdict: { kind: 'uncovered', text: 'U' } } }));
    noteRestoredOrder('b1', 'X');
    expect(rec().fleet.verdict.kind).toBe('restored');
    expect(rec().lastError).toBe('the hook did not answer');
  });
  it("a restore in a maintenance whose record had no fleet: the next Maintenance keeps the restore's row and records 'restored'", async () => {
    setupBot(settledRec('maintenance'));
    h.db = BLOCKED();
    d().order = row('X', { reason: 'restore' });
    noteRestoredOrder('b1', 'X');
    const r = await M();
    expect(d().order).toMatchObject({ id: 'X', reason: 'restore' });
    expect(rec().fleet.verdict.kind).toBe('restored');
    expect(r.text).toContain(TX.restored);
  });
});

describe('review round 1 (G8-6, finding 4)', () => {
  const exempt = (s: { args: string[] }) => s.args.some(a => a.includes('default_transaction_read_only=off'));
  it.each([['Maintenance', M], ['Off', OFF]] as const)('%s on a fenced database settles with a recorded verdict: the order write and the final read run exempt', async (_n, run) => {
    d().readOnly = true;
    d().claims = [claim('p1', 'host-a')]; d().autoAck = { p1: { saved: true } };
    const r = await run();
    expect(r.settled).toBe(true);
    expect(d().orderWrites).toBe(1);
    expect(rec().fleet.verdict.kind).toBe('confirmed');
    expect(r.text).toContain(TX.covered(1, 'host-a'));
    expect(exempt(k.scripts.find(s => s.sql.includes('-- nx5:order'))!)).toBe(true);
    expect(exempt(k.scripts.filter(s => s.sql.includes('-- nx5:read')).pop()!)).toBe(true);
  });
  it.each([['Maintenance', M], ['Off', OFF]] as const)("%s: a block refused with class 'write-fence' gives the fenced text", async (_n, run) => {
    d().readOnly = true;
    h.block = { ok: false, cls: 'write-fence', error: 'ERROR:  cannot execute ALTER ROLE in a read-only transaction' };
    const r = await run();
    expect(r.settled).toBe(false);
    expect(r.text).toContain('the database is READ-ONLY under a write fence');
    expect(r.text).not.toContain('could not be blocked');
  });
  it('a failed record write of the block mark ends the pass with the not-recorded text; the retry blocks again, saves the mark and records the verdict', async () => {
    d().claims = [claim('p1', 'host-a')]; d().autoAck = { p1: { saved: true } };
    let n = 0;
    h.writeFail = (r: any) => (r?.fleet?.blockedAt && n++ === 0 ? 'disk full' : null);
    const r = await M();
    expect(r).toEqual({ settled: false, text: 'Maintenance is not confirmed. The manager could not record this (disk full); the record still holds the order as not confirmed, so the manager runs it again within 30 seconds, except that a retry never starts the bot or its database.' });
    expect(h.events.slice(h.events.indexOf('block'))).toEqual(['block']);
    expect(rec().fleet.blockedAt).toBeUndefined();
    expect(rec().settled).toBe(false);
    h.events = [];
    const again = await retry();
    expect(h.events).toContain('block');
    expect(again.settled).toBe(true);
    expect(typeof rec().fleet.blockedAt).toBe('string');
    expect(rec().fleet.verdict.kind).toBe('confirmed');
    expect(again.text).toContain(TX.covered(1, 'host-a'));
  });
  it("a standing row of reason 'restore' under an open login is replaced by a new id of reason 'order', so the answers are asked again", async () => {
    settledX();
    h.db = { inRecovery: false, canLogin: true, sessions: 1 };
    d().order = row('X', { reason: 'restore' });
    d().acks = [];
    d().autoAck = { p1: { saved: false, unsavedGuilds: 2 } };
    const r = await M();
    expect(d().order!.id).not.toBe('X');
    expect(d().order!.reason).toBe('order');
    expect(rec().fleet.orderId).toBe(d().order!.id);
    expect(rec().fleet.verdict.kind).toBe('uncovered');
    expect(r.text).toContain(TX.unsaved('host-a', 2, 0));
    expect(r.text).not.toContain(TX.restored);
  });
});

describe('review 2 finding 4: a NULL count is never shown as 0 (G8-5)', () => {
  it('an answer of saved false with NULL counts says the bot could not count them', async () => {
    d().claims = [claim('p1', 'host-a')]; d().autoAck = { p1: { saved: false, unsavedGuilds: null, unsavedFiles: null } };
    const r = await M();
    expect(r.text).toContain('The bot on host-a reports changes it could not save (the bot could not count them); its log names them.');
    expect(r.text).not.toContain('0 guild(s)');
  });
  it('an answer of saved null with one NULL count says the bot could not count them', async () => {
    d().claims = [claim('p1', 'host-a')]; d().autoAck = { p1: { saved: null, unansweredGuilds: 2, unconfirmedFiles: null } };
    const r = await M();
    expect(r.text).toContain("The bot on host-a can't confirm that every change it holds is saved (the bot could not count them).");
    expect(r.text).not.toMatch(/\d+ save\(s\)/);
  });
});

describe('a push cap (round 3 minor 1)', () => {
  it("a holder renewed two minutes ago whose claim the cap expired is named 'not seen' with the clock wording, no takeover delay", async () => {
    d().claims = [claim('p4', 'host-d', 100_000, { agoMs: 120_000 })];
    const r = await M();
    expect(r.text).toContain(TX.notSeen('host-d', 'Maintenance', '2 minutes'));
    expect(r.text).not.toMatch(/takeover/i);
  });
});
