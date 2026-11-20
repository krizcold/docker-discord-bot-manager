// NX5 test 13: Running's one transaction on the bot's database, its fence and recovery rules, and the texts of a
// Running hook answer that carries stays, unread or starting (decision 11, L2, G7-1).
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
import { MAINTENANCE_TIMING, maintenanceStatus, resetMaintenanceState, runMaintenanceOrder } from '../../src/instance/maintenance';
import { CONTAINER, h, k, resetH, resetKit, settledRec, setupBot, wire } from './nx5-kit';
import { TX } from './nx5-texts-kit';

const H_FALSE = ' It answered that it does not restart';
const H_NULL = ' Whether it restarts is not confirmed';
const RUN = () => runMaintenanceOrder('b1', 'running', '');
const fromMaint = () => {
  setupBot(settledRec('maintenance', { fleet: { orderId: 'X', blockedAt: '2026-11-16T10:00:05.000Z' } }));
  h.db = { inRecovery: false, canLogin: false, sessions: 0 };
  k.dbs[CONTAINER].order = { id: 'X', state: 'maintenance', message: 'm', generation: 3, reason: 'order', upMs: 100_000 };
  k.dbs[CONTAINER].acks = [{ process: 'p1', order: 'X', saved: true }];
};
const hookBody = (body: Record<string, unknown>) => () => ({ ok: true, status: 200, body: { success: true, ...body } });

beforeEach(() => {
  resetMaintenanceState();
  resetH();
  resetKit();
  wire();
  MAINTENANCE_TIMING.hookWaitMs = 30;
  MAINTENANCE_TIMING.hookWaitPauseMs = 1;
  MAINTENANCE_TIMING.hookWaitTryMs = 10;
});

describe("Running's transaction (decision 4, H2)", () => {
  it("G8-1: the 'running' row and the answers' delete commit in one transaction as dbm_meta on the bot's database, then openBotLogin opens the login", async () => {
    fromMaint();
    h.realRunning = true;
    const r = await RUN();
    const rows = k.scripts.filter(s => /INSERT INTO smdb_manager\.save_order/.test(s.sql));
    expect(rows).toHaveLength(1);
    const s = rows[0];
    expect(s.db).toBe('smdb');
    expect(s.args[s.args.indexOf('-U') + 1]).toBe('dbm_meta');
    expect(s.sql.match(/\bBEGIN\b/g)).toHaveLength(1);
    expect(s.sql.match(/\bCOMMIT\b/g)).toHaveLength(1);
    expect(s.sql).toContain((switchSql as any).SAVE_ORDER_DDL('smdb'));
    expect(s.sql).not.toMatch(/ALTER ROLE/);
    expect(s.sql).toContain("'running'");
    expect(s.sql).toContain("'order'");
    expect(s.sql.indexOf('BEGIN')).toBeLessThan(s.sql.indexOf('CREATE SCHEMA'));
    expect(s.sql.indexOf('DELETE FROM smdb_manager.save_acks')).toBeGreaterThan(s.sql.indexOf('INSERT INTO smdb_manager.save_order'));
    expect(s.sql.indexOf('DELETE FROM smdb_manager.save_acks')).toBeLessThan(s.sql.indexOf('COMMIT'));
    expect(h.events.filter(e => e === 'open')).toHaveLength(1);
    expect(h.events.indexOf('running')).toBeGreaterThanOrEqual(0);
    expect(h.events.indexOf('running')).toBeLessThan(h.events.indexOf('open'));
    expect(r.settled).toBe(true);
    expect(h.db.canLogin).toBe(true);
    expect(k.dbs[CONTAINER].order).toMatchObject({ id: 'X', state: 'running', reason: 'order' });
    expect(k.dbs[CONTAINER].acks).toEqual([]);
  });
  it("G8-1: the row commits and the open fails: Running is not confirmed with its own text, the login stays blocked under the 'running' row, and the retry opens the login", async () => {
    fromMaint();
    h.open = { ok: false, cls: 'other', error: 'ERROR:  could not open the role' };
    const r = await RUN();
    expect(r).toEqual({ settled: false, text: "Running is not confirmed: the bot's database login could not be restored (ERROR:  could not open the role). The bot answers with the maintenance message until it is. Choose Running again to retry." });
    expect(k.dbs[CONTAINER].order).toMatchObject({ id: 'X', state: 'running' });
    expect(k.dbs[CONTAINER].acks).toEqual([]);
    expect(h.db.canLogin).toBe(false);
    expect(h.events).not.toContain('hook:running');
    expect((await maintenanceStatus(JSON.parse(JSON.stringify(h.inst)), null)).summary).toBe("State: Running, not confirmed: the bot's database login could not be restored (ERROR:  could not open the role)");
    h.open = { ok: true };
    h.events = [];
    const again = await runMaintenanceOrder('b1', 'running', '', { retry: true });
    expect(h.events.indexOf('running')).toBeLessThan(h.events.indexOf('open'));
    expect(h.db.canLogin).toBe(true);
    expect(again.settled).toBe(true);
    expect(k.dbs[CONTAINER].order).toMatchObject({ id: 'X', state: 'running' });
  });
  it('G8-1: the pass ends between the row and the open (an unexpected error): the record stays not confirmed with a true line, and the resumed Running opens the login', async () => {
    fromMaint();
    h.open = () => { throw new Error('the manager stopped'); };
    await expect(RUN()).rejects.toThrow('the manager stopped');
    expect(k.dbs[CONTAINER].order).toMatchObject({ id: 'X', state: 'running' });
    expect(h.db.canLogin).toBe(false);
    expect(h.inst.maintenance).toMatchObject({ state: 'running', settled: false });
    expect((await maintenanceStatus(JSON.parse(JSON.stringify(h.inst)), null)).summary).toBe('State: Running, not confirmed: The order stopped on an unexpected error: the manager stopped');
    h.open = { ok: true };
    h.events = [];
    const again = await runMaintenanceOrder('b1', 'running', '', { resumed: true });
    expect(h.events.indexOf('running')).toBeGreaterThanOrEqual(0);
    expect(h.events.indexOf('running')).toBeLessThan(h.events.indexOf('open'));
    expect(h.db.canLogin).toBe(true);
    expect(again.settled).toBe(true);
  });
  it('a database without the tables still opens', async () => {
    fromMaint();
    k.dbs[CONTAINER].tables = false;
    k.dbs[CONTAINER].order = null;
    const r = await RUN();
    expect(r.settled).toBe(true);
    expect(k.dbs[CONTAINER].order).toMatchObject({ state: 'running', reason: 'order' });
  });
  it('a retried Running on a fenced database gives the FENCED text after the fence read', async () => {
    fromMaint();
    h.inst.maintenance = { ...h.inst.maintenance, state: 'running', settled: false, login: 'unconfirmed', prior: { state: 'maintenance', message: 'm' } };
    k.dbs[CONTAINER].readOnly = true;
    h.fence = { ok: true, on: true, owner: null, persisted: true };
    const r = await runMaintenanceOrder('b1', 'running', '', { retry: true });
    expect(h.events).toContain('fence-read');
    expect(r).toEqual({ settled: false, text: "Running is not confirmed: the bot's login could not be restored, because its database is READ-ONLY and this manager cannot tell which step left it so. Choose Running again once the database is writable." });
  });
  it("G8-6: the row write failing with class 'other' does not read the read-only layer again", async () => {
    fromMaint();
    k.dbs[CONTAINER].failNext.running = ['ERROR:  connection to server lost'];
    const r = await RUN();
    expect(h.events.filter(e => e === 'fence-read')).toEqual(['fence-read']);
    expect(h.events).not.toContain('open');
    expect(r.text).toBe("Running is not confirmed: the bot's database login could not be restored (ERROR:  connection to server lost). The bot answers with the maintenance message until it is. Choose Running again to retry.");
  });
  it.each([
    ['the row write', () => { k.dbs[CONTAINER].failNext.running = ['ERROR:  connection to server lost']; }, 'ERROR:  connection to server lost'],
    ['the login open', () => { h.open = { ok: false, cls: 'other', error: 'ERROR:  could not open the role' }; }, 'ERROR:  could not open the role'],
  ])('Running from Off whose %s fails skips the start, and the text says the bot is stopped', async (_n, arrange, err) => {
    setupBot(settledRec('off', { fleet: { orderId: 'X' } }));
    h.db = { inRecovery: false, canLogin: false, sessions: 0 };
    h.app = false;
    arrange();
    const r = await RUN();
    expect(h.events.some(e => e.startsWith('start'))).toBe(false);
    expect(r).toEqual({ settled: false, text: `Running is not confirmed: the bot's database login could not be restored (${err}). The bot is stopped. Choose Running again to retry.` });
    expect(r.text).not.toContain('maintenance message');
  });
  it('a database in recovery gives RECOVERY_OPEN without running the transaction', async () => {
    fromMaint();
    h.db = { inRecovery: true, canLogin: false, sessions: 0 };
    const r = await RUN();
    expect(k.dbs[CONTAINER].runningWrites).toBe(0);
    expect(r.text).toBe("Running is not confirmed: the bot's database login could not be restored (the database is a live copy in recovery). The bot answers with the maintenance message until it is. Choose Running again to retry.");
  });
});

describe("a Running hook answer with stays, unread or starting (decision 11)", () => {
  it.each([
    ['order', TX.staysOrder],
    ['login', TX.staysLogin],
    ['file', TX.staysFile],
  ])("stays '%s'", async (cause, words) => {
    fromMaint();
    h.hook = hookBody({ restarting: false, stays: cause });
    const r = await RUN();
    expect(r.text).toBe(TX.stays(words));
    expect(r.text).not.toContain('running normally');
    expect(r.text).not.toContain(H_FALSE);
  });
  it('unread: the can\'t-confirm text with the reason', async () => {
    fromMaint();
    h.hook = hookBody({ restarting: null, unread: 'no answer within 3 seconds' });
    const r = await RUN();
    expect(r.text).toBe(TX.unreadRunning('no answer within 3 seconds'));
    expect(r.text).not.toContain('running normally');
    expect(r.text).not.toContain(H_NULL);
  });
  it('unread is cut to 200 characters', async () => {
    fromMaint();
    h.hook = hookBody({ restarting: null, unread: 'x'.repeat(500) });
    const r = await RUN();
    expect(r.text).toBe(TX.unreadRunning('x'.repeat(200)));
  });
  it("starting, Running from Off on kind 'external': the still-starting text", async () => {
    setupBot(settledRec('off', { login: 'not-managed' }), { fleetDb: undefined });
    h.env = { vars: { DATA_BACKEND: 'postgres', DATA_BACKEND_URL:'postgresql://u:p@db.elsewhere.test:5432/smdb' }, undecryptable: [], encrypted: [], corrupt: false };
    h.app = false;
    h.hook = hookBody({ restarting: false, starting: true });
    const r = await RUN();
    expect(r.text).toBe(TX.starting);
  });
  it("starting on kind 'database' changes no text", async () => {
    setupBot(settledRec('off', { fleet: { orderId: 'X' } }));
    h.db = { inRecovery: false, canLogin: false, sessions: 0 };
    h.app = false;
    h.hook = hookBody({ restarting: false, starting: true });
    const r = await RUN();
    expect(h.events.indexOf('running')).toBeGreaterThanOrEqual(0);
    expect(h.events.indexOf('running')).toBeLessThan(h.events.indexOf('open'));
    expect(h.events.indexOf('open')).toBeLessThan(h.events.indexOf('start:maintenance'));
    expect(k.dbs[CONTAINER].order).toMatchObject({ state: 'running', reason: 'order' });
    expect(r.text.startsWith('The bot is running normally: it started, its database login is restored, and it took the order to leave maintenance.')).toBe(true);
  });
  it('guard: an answer with no mark keeps today\'s text', async () => {
    fromMaint();
    h.hook = hookBody({});
    const r = await RUN();
    expect(r.text).toBe("The bot is running normally: its database login is restored, and it took the order to leave maintenance. Whether it restarts is not confirmed (it answered that it can't confirm, or did not say). If a restore ran while it was in maintenance, restart the bot so it loads the restored data.");
  });
});
