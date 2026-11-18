// NM33 L5 survivors in maintenance.ts lines 400 to 749: the restore note's log, the finished order's text and stored
// reason, the order write's answer texts and argv, Running's row argv, and the admission write's fleet keys.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const B = vi.hoisted(() => ({ clock: null as string | null, orderAnswer: null as string | null }));

vi.mock('../../src/docker/processStart', async (o) => (await import('./nx5-kit')).processStartMock(await o()));
vi.mock('../../src/instance/switchSql', async (o) => {
  const base = (await import('./nx5-kit')).switchSqlMock(await o()) as any;
  return {
    ...base,
    CLAIM_CLOCK_READ_SQL: '-- nx5b:clock\n',
    saveOrderSql: (p: unknown) => (B.orderAnswer !== null ? '-- nx5b:order\n' : base.saveOrderSql(p)),
  };
});
vi.mock('../../src/env/manager', async (o) => (await import('./nx5-kit')).envMock(await o()));
vi.mock('../../src/config/appCapabilities', async (o) => (await import('./nx5-kit')).capsMock(await o()));
vi.mock('../../src/docker/containerManager', async () => (await import('./nx5-kit')).containerManagerMock());
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./nx5-kit')).dbLoginMock(await o()));
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./nx5-kit')).appHookMock(await o()));
vi.mock('../../src/instance/fleetReplication', async (o) => (await import('./nx5-kit')).fleetReplicationMock(await o()));

import { MAINTENANCE_TIMING, noteRestoredOrder, resetMaintenanceState, runMaintenanceOrder } from '../../src/instance/maintenance';
import { CONTAINER, claim, h, k, resetH, resetKit, settledRec, setupBot, wire } from './nx5-kit';
import { TX } from './nx5-texts-kit';

const T = MAINTENANCE_TIMING as any;
const d = () => k.dbs[CONTAINER];
const rec = () => h.inst.maintenance;
const BLOCKED = () => ({ inRecovery: false, canLogin: false, sessions: 0 });
const DISK = 'ERROR:  disk full';
const M = (message = 'Back soon') => runMaintenanceOrder('b1', 'maintenance', message);
const OFF = (message = 'Gone') => runMaintenanceOrder('b1', 'off', message);
const RUN = () => runMaintenanceOrder('b1', 'running', '');
const hookBody = (body: Record<string, unknown>) => () => ({ ok: true, status: 200, body: { success: true, ...body } });
const scriptOf = (tag: string) => k.scripts.find(s => s.sql.includes(tag));
const LONG = `first line\n${'y'.repeat(250)}\n`;
const EXTERNAL_ENV = { vars: { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: 'postgresql://u:p@db.elsewhere.test:5432/smdb' }, undecryptable: [], encrypted: [], corrupt: false };

beforeEach(() => {
  resetMaintenanceState();
  resetH();
  resetKit();
  wire();
  setupBot();
  B.clock = null;
  B.orderAnswer = null;
  k.other = (_args, sql) => {
    if (sql.includes('-- nx5b:clock')) return { code: 0, stdout: B.clock ?? `clock|${d().claimTables && d().clock !== null ? d().clock : ''}\n`, stderr: '' };
    if (sql.includes('-- nx5b:order')) return { code: 0, stdout: B.orderAnswer ?? '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  T.ackPollMs = 2;
  T.ackWaitMs = 60;
  MAINTENANCE_TIMING.hookWaitMs = 30;
  MAINTENANCE_TIMING.hookWaitPauseMs = 1;
  MAINTENANCE_TIMING.hookWaitTryMs = 10;
});

afterEach(() => vi.restoreAllMocks());

describe('noteRestoredOrder when the record write fails', () => {
  it('logs the exact line naming the bot and the error', () => {
    setupBot(settledRec('maintenance', { fleet: { orderId: 'X', blockedAt: '2026-11-16T09:00:00.000Z' } }));
    h.writeFail = () => 'the registry disk is full';
    const logged: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logged.push(a); });
    noteRestoredOrder('b1', 'R1');
    expect(logged).toEqual([['[Maintenance] B1: the record could not keep the save order a restore wrote: the registry disk is full']]);
    expect(rec().fleet.orderId).toBe('X');
  });
});

describe("the finished order's text and stored reason", () => {
  it('a confirmed verdict stores no reason', async () => {
    d().claims = [claim('p1', 'host-a')];
    d().autoAck = { p1: { saved: true } };
    const r = await M();
    expect(r.settled).toBe(true);
    expect(rec().fleet.verdict.kind).toBe('confirmed');
    expect(rec().lastError).toBeUndefined();
    expect('lastError' in rec()).toBe(false);
  });
  it('Off whose stop failed after the verdict was written: the stop text alone, with no verdict sentence', async () => {
    d().claims = [claim('p1', 'host-a')];
    d().autoAck = { p1: { saved: true } };
    h.stop = { success: false, error: 'boom' };
    const r = await OFF();
    expect(rec().fleet.verdict.kind).toBe('confirmed');
    expect(r.settled).toBe(false);
    expect(r.text).toBe("Off is not confirmed: the stop failed (boom). The bot's database login is blocked, so it cannot write. Choose Off again to retry.");
    expect(rec().lastError).toBe('the stop failed (boom)');
  });
  it('Off whose block and stop both failed does not say the login is blocked', async () => {
    h.saveOrder = false;
    setupBot(settledRec('running'));
    h.block = { ok: false, cls: 'other', error: 'ERROR:  permission denied' };
    h.stop = { success: false, error: 'boom' };
    const r = await OFF();
    expect(h.events).toContain('block');
    expect(h.events).toContain('stop:maintenance');
    expect(r.text).toBe('Off is not confirmed: the stop failed (boom). Choose Off again to retry.');
  });
});

describe("Running's texts on a bot without a managed database", () => {
  beforeEach(() => {
    setupBot(settledRec('maintenance', { login: 'not-managed' }), { fleetDb: undefined });
    h.env = { ...EXTERNAL_ENV, vars: { ...EXTERNAL_ENV.vars } };
  });
  it("stays: the text has no database clause", async () => {
    h.hook = hookBody({ restarting: false, stays: 'order' });
    const r = await RUN();
    expect(r.text).toBe(TX.stays(TX.staysOrder, false));
  });
  it('unread: the text has no database clause', async () => {
    h.hook = hookBody({ restarting: null, unread: 'no answer within 3 seconds' });
    const r = await RUN();
    expect(r.text).toBe(TX.unreadRunning('no answer within 3 seconds', false));
  });
});

describe("the order write's answers (writeSaveOrder)", () => {
  it('a claim clock read psql did not answer as expected: the text quotes its last line, cut to 200 characters', async () => {
    B.clock = LONG;
    const r = await M();
    const reason = `the claim clock read answered '${'y'.repeat(200)}'`;
    expect(r.text).toBe(TX.orderFail('Maintenance', reason));
    expect(rec().lastError).toBe(`the manager could not ask the bots to save (${reason})`);
    expect(d().orderWrites).toBe(0);
  });
  it('an order write psql did not answer as expected: the text quotes its last line, cut to 200 characters', async () => {
    B.orderAnswer = LONG;
    const r = await M();
    const reason = `the order write answered '${'y'.repeat(200)}'`;
    expect(scriptOf('-- nx5b:order')).toBeDefined();
    expect(r.text).toBe(TX.orderFail('Maintenance', reason));
    expect(rec().fleet.orderError).toEqual({ reason, login: 'open' });
  });
  it('the claim clock read goes to psql on stdin', async () => {
    d().claims = [claim('p1', 'host-a')];
    d().autoAck = { p1: { saved: true } };
    await M();
    const s = scriptOf('-- nx5b:clock')!;
    expect(s.args).toContain('-i');
    expect(s.args).not.toContain('-c');
    expect(s.args).toContain('dbm_work');
  });
  it('the order write runs exempt from the read-only fence, so it lands on a fenced database', async () => {
    d().readOnly = true;
    d().claims = [claim('p1', 'host-a')];
    d().autoAck = { p1: { saved: true } };
    await M();
    const s = scriptOf('-- nx5:order')!;
    expect(s.args.some(a => a.includes('default_transaction_read_only=off'))).toBe(true);
    expect(s.args).toContain('-i');
    expect(d().order?.state).toBe('maintenance');
    expect(rec().fleet.orderId).toBe(d().order!.id);
    expect(rec().fleet.orderError).toBeUndefined();
  });
});

describe("Running's row on a save-order app", () => {
  it('goes to psql on stdin', async () => {
    setupBot(settledRec('maintenance', { fleet: { orderId: 'X', blockedAt: '2026-11-16T10:00:05.000Z' } }));
    h.db = BLOCKED();
    await RUN();
    const s = scriptOf('-- nx5:running')!;
    expect(s.args).toContain('-i');
    expect(s.args).not.toContain('-c');
    expect(d().runningWrites).toBe(1);
  });
});

describe("the admission write's fleet keys (P1)", () => {
  it('an app without the save order never gets a fleet record', async () => {
    h.saveOrder = false;
    const r = await M();
    expect(h.writes.length).toBeGreaterThan(0);
    expect(h.writes.every(w => w && !('fleet' in w))).toBe(true);
    expect(r.settled).toBe(true);
  });
  it("a save-order app on a database this manager does not run ('external') never gets a fleet record", async () => {
    setupBot(settledRec('running', { login: 'not-managed' }), { fleetDb: undefined });
    h.env = { ...EXTERNAL_ENV, vars: { ...EXTERNAL_ENV.vars } };
    const r = await M();
    expect(h.writes.length).toBeGreaterThan(0);
    expect(h.writes.every(w => w && !('fleet' in w))).toBe(true);
    expect(d().orderWrites).toBe(0);
    expect(r.settled).toBe(true);
  });
  it('Running from a Maintenance with no order id writes no fleet record', async () => {
    setupBot(settledRec('maintenance'));
    h.db = BLOCKED();
    await RUN();
    expect(h.writes.length).toBeGreaterThan(0);
    expect(h.writes.every(w => w && !('fleet' in w))).toBe(true);
  });
  it('Running keeps only the order id', async () => {
    setupBot(settledRec('maintenance', { fleet: { orderId: 'X', blockedAt: '2026-11-16T10:00:05.000Z', askedBlocked: false } }));
    h.db = BLOCKED();
    await RUN();
    expect(h.writes[0].fleet).toEqual({ orderId: 'X' });
  });
  it('a new Maintenance keeps the block mark of an order whose write failed with the login blocked', async () => {
    h.db = BLOCKED();
    d().failNext.order = [DISK];
    await M();
    const blockedAt = rec().fleet.blockedAt;
    expect(typeof blockedAt).toBe('string');
    expect(rec().fleet.orderId).toBeUndefined();
    expect(rec().fleet.orderError).toEqual({ reason: DISK, login: 'blocked' });
    h.writes = [];
    await M('Again');
    expect(h.writes[0].fleet).toEqual({ blockedAt });
  });
});
