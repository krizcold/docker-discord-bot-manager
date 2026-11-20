// NM33 L5 group c: runCore's save-order steps from the order write on (the wait, the final read, the stop's held
// answer, the end-of-pass login read) and resetMaintenanceState, on nx5-kit's fake save-order database.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/docker/processStart', async (o) => (await import('./nx5-kit')).processStartMock(await o()));
vi.mock('../../src/instance/switchSql', async (o) => (await import('./nx5-kit')).switchSqlMock(await o()));
vi.mock('../../src/env/manager', async (o) => (await import('./nx5-kit')).envMock(await o()));
vi.mock('../../src/config/appCapabilities', async (o) => (await import('./nx5-kit')).capsMock(await o()));
vi.mock('../../src/docker/containerManager', async () => (await import('./nx5-kit')).containerManagerMock());
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./nx5-kit')).dbLoginMock(await o()));
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./nx5-kit')).appHookMock(await o()));
vi.mock('../../src/instance/fleetReplication', async (o) => (await import('./nx5-kit')).fleetReplicationMock(await o()));

import { MAINTENANCE_TIMING, maintenanceStatus, resetMaintenanceState, runMaintenanceOrder } from '../../src/instance/maintenance';
import { CONTAINER, claim, h, k, resetH, resetKit, saveOrderWrites, settledRec, setupBot, wire } from './nx5-kit';
import { TX } from './nx5-texts-kit';

const T = MAINTENANCE_TIMING as any;
const d = () => k.dbs[CONTAINER];
const rec = () => h.inst.maintenance;
const BLOCKED = () => ({ inRecovery: false, canLogin: false, sessions: 0 });
const OPEN = () => ({ inRecovery: false, canLogin: true, sessions: 1 });
const DISK = 'ERROR:  disk full';
const TIMEOUT = 'ERROR:  canceling statement due to statement timeout';
const BLOCKED_AT = '2026-11-16T09:00:00.000Z';
const NOT_RECORDED = (to: string, e: string) => `${to} is not confirmed. The manager could not record this (${e}); the record still holds the order as not confirmed, so the manager runs it again within 30 seconds, except that a retry never starts the bot or its database.`;

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
afterEach(() => {
  vi.useRealTimers();
});

const M = (message = 'Back soon') => runMaintenanceOrder('b1', 'maintenance', message);
const OFF = (message = 'Gone') => runMaintenanceOrder('b1', 'off', message);
const retry = (to = 'maintenance') => runMaintenanceOrder('b1', to as any, '', { retry: true });
const resumed = (to = 'maintenance') => runMaintenanceOrder('b1', to as any, '', { resumed: true });
const readsBefore = (step: string) => h.events.slice(0, Math.max(0, h.events.indexOf(step))).filter(e => e === 'read').length;
const loginReads = () => h.events.filter(e => e === 'login-read').length;
const status = async () => (await maintenanceStatus(JSON.parse(JSON.stringify(h.inst)), null)).summary;
const row = (id: string, over: Record<string, unknown> = {}) => ({ id, state: 'maintenance' as const, message: 'old', generation: 3, reason: 'order' as const, upMs: 100_000, ...over });
/** A settled Maintenance whose order X every process (p1 on host-a) answered, the login blocked since. */
const settledX = () => {
  setupBot(settledRec('maintenance', { fleet: { orderId: 'X', generation: 3, upMs: 100_000, askedBlocked: false, blockedAt: BLOCKED_AT, orderFor: '2026-10-01T00:00:00.000Z', verdict: { kind: 'confirmed' } } }));
  h.db = BLOCKED();
  d().order = row('X');
  d().claims = [claim('p1', 'host-a')];
  d().acks = [{ process: 'p1', order: 'X', saved: true }];
};

describe('the order step', () => {
  it('a role that does not exist reads as unread: no write, the reason names the role, the pass ends', async () => {
    h.db = { inRecovery: false, canLogin: null, sessions: 0 };
    const r = await M();
    const reason = "it could not read the bot's database login: the role smdb does not exist";
    expect(saveOrderWrites()).toEqual([]);
    expect(rec().fleet.orderError).toEqual({ reason, login: 'unread' });
    expect(r).toEqual({ settled: false, text: TX.orderFail('Maintenance', reason) });
    expect(h.events).not.toContain('block');
  });
  it('a resumed order whose login reads blocked writes its order again (the kept row takes the message)', async () => {
    setupBot({ state: 'maintenance', message: 'm', orderedAt: '2026-11-16T10:00:00.000Z', settled: false, hook: 'unconfirmed', login: 'unconfirmed', savedByBot: 'running', prior: { state: 'running', message: '' }, fleet: { orderId: 'X', generation: 3, upMs: 100_000, orderFor: '2026-11-16T10:00:00.000Z', askedBlocked: false, blockedAt: '2026-11-16T10:00:05.000Z' } });
    h.db = BLOCKED();
    d().order = row('X'); d().claims = [claim('p1', 'host-a')]; d().acks = [{ process: 'p1', order: 'X', saved: true }];
    await resumed();
    expect(d().orderWrites).toBe(1);
    expect(d().order).toMatchObject({ id: 'X', message: 'm' });
  });
  it('a kept row under a blocked login keeps askedBlocked true and its verdict', async () => {
    settledX();
    h.inst.maintenance.fleet.askedBlocked = true;
    const r = await M('again');
    expect(d().order!.id).toBe('X');
    expect(rec().fleet.askedBlocked).toBe(true);
    expect(rec().fleet.verdict.kind).toBe('askedBlocked');
    expect(r.text).toContain(TX.askedBlocked);
  });
  it('a failed record write after the order landed ends the pass before the hook and the block', async () => {
    let n = 0;
    h.writeFail = (x: any) => (x?.fleet?.orderFor && n++ === 0 ? 'disk full' : null);
    const r = await M();
    expect(d().orderWrites).toBe(1);
    expect(r).toEqual({ settled: false, text: NOT_RECORDED('Maintenance', 'disk full') });
    expect(h.events).not.toContain('block');
    expect(h.events.some(e => e.startsWith('hook'))).toBe(false);
    expect(h.events.filter(e => e === 'read')).toEqual([]);
  });
  it('a failed record write after a failed order under a blocked login ends the pass before the block', async () => {
    settledX();
    d().failNext.order = [DISK];
    let n = 0;
    h.writeFail = (x: any) => (x?.fleet?.orderFails && n++ === 0 ? 'disk full' : null);
    const r = await M('again');
    expect(r).toEqual({ settled: false, text: NOT_RECORDED('Maintenance', 'disk full') });
    expect(h.events).not.toContain('block');
    expect(h.events.some(e => e.startsWith('hook'))).toBe(false);
  });
  it('an order that failed with the login open reads no login afterwards and keeps the block mark', async () => {
    settledX();
    h.db = OPEN();
    d().failNext.order = [DISK];
    const r = await M('again');
    expect(r).toEqual({ settled: false, text: TX.orderFail('Maintenance', DISK) });
    expect(loginReads()).toBe(1);
    expect(rec().fleet.blockedAt).toBe(BLOCKED_AT);
    expect(rec().login).toBe('unconfirmed');
  });
  it('a retry whose only database step is a failing order still records the login as unconfirmed', async () => {
    d().failNext.read = ['', TIMEOUT];
    const first = await M();
    expect(first).toEqual({ settled: false, text: TX.finalFail('Maintenance', TIMEOUT) });
    expect(rec().login).toBe('blocked');
    h.db = OPEN();
    d().failNext.order = [DISK];
    h.events = [];
    const r = await retry();
    expect(h.events).toContain('order-write');
    expect(h.events).not.toContain('block');
    expect(r).toEqual({ settled: false, text: TX.orderFail('Maintenance', DISK) });
    expect(rec().login).toBe('unconfirmed');
  });
});

describe('the wait for the answers', () => {
  it('no wait after a second failed order under an open login: the block follows with no read', async () => {
    d().failNext.order = [DISK, DISK];
    await M();
    h.events = [];
    const r = await retry();
    expect(h.events).toContain('block');
    expect(readsBefore('block')).toBe(0);
    expect(r.text).toContain(TX.cant(TX.notWritten(DISK)));
  });
  it('a row another order replaced ends the wait at the first read', async () => {
    d().claims = [claim('p1', 'host-a')];
    T.ackWaitMs = 600;
    k.onRead = (db, n) => { if (n === 1) db.order = { ...db.order!, id: 'Z' }; };
    const r = await M();
    expect(readsBefore('hook:maintenance')).toBe(1);
    expect(rec().fleet.verdict.kind).toBe('notAsked');
    expect(r.text).toContain(TX.notAsked);
  });
  it('the waiting line names the elapsed and the total seconds', async () => {
    d().claims = [claim('p1', 'host-a'), claim('p2', 'host-b')];
    d().autoAck = { p1: { saved: true } };
    T.ackWaitMs = 600_000;
    const lines: string[] = [];
    k.onRead = async (db, n) => {
      if (n !== 3) return;
      lines.push(await status());
      db.acks.push({ process: 'p2', order: db.order!.id, saved: true });
    };
    const r = await M();
    expect(lines).toHaveLength(1);
    const m = /^Maintenance: waiting for the bot on host-b to save what it holds \((\d+) of (\d+) seconds\); this database still accepts its login\.$/.exec(lines[0]);
    expect(m).not.toBeNull();
    expect(Number(m![2])).toBe(600);
    expect(Number(m![1])).toBeLessThanOrEqual(600);
    expect(r.text).toContain(TX.covered(2, 'host-a, host-b'));
  });
  it('the wait ends at the deadline itself, not one poll after it', async () => {
    const at = Date.parse('2026-11-17T10:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at);
    T.ackWaitMs = 600;
    d().claims = [claim('p1', 'host-a')];
    k.onRead = (_db, n) => { vi.setSystemTime(at + 600 + (n - 1)); };
    await M();
    expect(readsBefore('hook:maintenance')).toBe(1);
  });
  it('the waiting line is gone once the wait ends, so an unsettled order shows its reason', async () => {
    d().claims = [claim('p1', 'host-a'), claim('p2', 'host-b')];
    d().autoAck = { p1: { saved: true } };
    h.block = { ok: false, error: 'ERROR:  permission denied' };
    const r = await M();
    expect(r.settled).toBe(false);
    expect(rec().lastError).toBe('the database login could not be blocked (ERROR:  permission denied)');
    expect(await status()).toBe('State: Maintenance, not confirmed: the database login could not be blocked (ERROR:  permission denied)');
  });
  it('resetMaintenanceState drops a waiting line', async () => {
    d().claims = [claim('p1', 'host-a'), claim('p2', 'host-b')];
    d().autoAck = { p1: { saved: true } };
    T.ackWaitMs = 600_000;
    const lines: string[] = [];
    k.onRead = async (db, n) => {
      if (n !== 2) return;
      lines.push(await status());
      resetMaintenanceState();
      lines.push(await status());
      db.acks.push({ process: 'p2', order: db.order!.id, saved: true });
    };
    await M();
    expect(lines[0]).toMatch(TX.waiting('Maintenance', 'host-b'));
    expect(lines[1]).toBe('State: Maintenance, not confirmed: the order has not finished');
  });
});

describe('the final read', () => {
  it('a failed block skips the final read: no verdict recorded', async () => {
    h.block = { ok: false, error: 'ERROR:  permission denied' };
    const r = await M();
    expect(d().reads).toBe(1);
    expect(rec().fleet.verdict).toBeUndefined();
    expect(r.settled).toBe(false);
  });
  it('a failed record write of the verdict ends an Off before the stop', async () => {
    let n = 0;
    h.writeFail = (x: any) => (x?.fleet?.verdict && n++ === 0 ? 'disk full' : null);
    const r = await OFF();
    expect(r).toEqual({ settled: false, text: NOT_RECORDED('Off', 'disk full') });
    expect(h.events).toContain('block');
    expect(h.events.some(e => e.startsWith('stop'))).toBe(false);
  });
});

describe('the stop keeps the answer it replaced', () => {
  const NO = { success: true, saved: false, unsavedGuilds: 2, unsavedFiles: 1 };
  it('a retried stop keeps the held answer the first stop recorded', async () => {
    h.hook = () => ({ ok: true, status: 200, body: NO });
    h.appAfterStop = true;
    const first = await OFF();
    expect(first.settled).toBe(false);
    const held = { state: 'stopped', before: { state: 'no', guilds: 2, files: 1 }, shut: true };
    expect(rec().held).toEqual(held);
    h.appAfterStop = false;
    h.events = [];
    const r = await retry('off');
    expect(h.events).toContain('stop:maintenance');
    expect(r.settled).toBe(true);
    expect(rec().held).toEqual(held);
  });
  it('a bot whose data is in files is not shut by a block mark left in its record', async () => {
    setupBot({ state: 'off', message: 'Gone', orderedAt: '2026-11-16T10:00:00.000Z', settled: false, hook: 'unconfirmed', login: 'not-managed', savedByBot: 'running', prior: { state: 'running', message: '' }, fleet: { orderId: 'X', blockedAt: BLOCKED_AT } });
    h.env.vars = { DATA_BACKEND: 'json' };
    h.hook = () => ({ ok: true, status: 200, body: NO });
    await resumed('off');
    expect(h.events).toEqual(['hook:maintenance', 'stop:maintenance']);
    expect(rec().held).toEqual({ state: 'stopped', before: { state: 'no', guilds: 2, files: 1 }, shut: false });
  });
});

describe('the login read at the end of the pass', () => {
  it('a login found open after the block drops the block mark', async () => {
    k.onRead = () => { if (h.events.includes('block')) h.db.canLogin = true; };
    const r = await M();
    expect(r.settled).toBe(false);
    expect(rec().lastError).toBe('the login read back as open after it was blocked');
    expect(rec().fleet.blockedAt).toBeUndefined();
  });
  it('a blocked login on a database in recovery keeps the block mark', async () => {
    k.onRead = () => { if (h.events.includes('block')) h.db.inRecovery = true; };
    const r = await M();
    expect(r.settled).toBe(false);
    expect(rec().lastError).toBe('the login read back as open after it was blocked');
    expect(typeof rec().fleet.blockedAt).toBe('string');
  });
});
