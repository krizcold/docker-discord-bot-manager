// NM33 L5 survivors in maintenance.ts lines 1 to 399: the verdict's texts on a replaced main, the counts and ages it
// names, the read's error text, the Running hook's stays mark, and the block mark's failed drop.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/docker/processStart', async (o) => (await import('./nx5-kit')).processStartMock(await o()));
vi.mock('../../src/instance/switchSql', async (o) => (await import('./nx5-kit')).switchSqlMock(await o()));
vi.mock('../../src/env/manager', async (o) => (await import('./nx5-kit')).envMock(await o()));
vi.mock('../../src/config/appCapabilities', async (o) => (await import('./nx5-kit')).capsMock(await o()));
vi.mock('../../src/docker/containerManager', async () => (await import('./nx5-kit')).containerManagerMock());
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./nx5-kit')).dbLoginMock(await o()));
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./nx5-kit')).appHookMock(await o()));
vi.mock('../../src/instance/fleetReplication', async (o) => (await import('./nx5-kit')).fleetReplicationMock(await o()));

import { clearBlockedAt, finalVerdict, MAINTENANCE_TIMING, readSaveRows, resetMaintenanceState, runMaintenanceOrder } from '../../src/instance/maintenance';
import { CONTAINER, h, k, resetH, resetKit, settledRec, setupBot, wire } from './nx5-kit';
import { TX } from './nx5-texts-kit';

const REPLACED = 'Another database replaced this one as the main, so Running is refused here; rejoin this machine as a copy instead.';
const ZERO = { unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, unconfirmedFiles: 0, unansweredFiles: 0 };
const ORDER = { id: 'X', state: 'maintenance' as const, message: 'm', current: true, reason: 'order' as const, upMs: 100_000 };
const rowsOf = (over: Record<string, unknown> = {}): any => ({
  order: { ...ORDER }, claims: true, expected: [{ process: 'p1', name: 'host-a', agoMs: 4000 }], notSeen: [],
  acks: [{ process: 'p1', order: 'X', saved: true, ...ZERO }], ...over,
});
const FLEET = { orderId: 'X', askedBlocked: false };
const verdict = (rows: any, fleet: Record<string, unknown> = FLEET, replaced = false) => finalVerdict(rows, fleet as any, 'maintenance', replaced, 'm');

beforeEach(() => {
  resetMaintenanceState();
  resetH();
  resetKit();
  wire();
  MAINTENANCE_TIMING.hookWaitMs = 30;
  MAINTENANCE_TIMING.hookWaitPauseMs = 1;
  MAINTENANCE_TIMING.hookWaitTryMs = 10;
});
afterEach(() => vi.restoreAllMocks());

describe('finalVerdict on a replaced main ends each text with the rejoin way', () => {
  it('askedBlocked', () => {
    expect(verdict(rowsOf(), { ...FLEET, askedBlocked: true }, true)).toEqual({
      kind: 'askedBlocked', text: `The login was already blocked when this order asked the bots to save, so no bot could answer. ${REPLACED}`,
    });
  });
  it('no shard claim tables', () => {
    expect(verdict(rowsOf({ claims: false }), FLEET, true)).toEqual({
      kind: 'cantConfirm', text: `The manager can't confirm which bot processes use this database (this database has no shard claim tables), so Hand over, Push and Move by file are refused. ${REPLACED}`,
    });
  });
  it('the row is not the order this maintenance wrote', () => {
    expect(verdict(rowsOf({ order: { ...ORDER, id: 'Y' } }), FLEET, true)).toEqual({
      kind: 'notAsked', text: `This order did not ask the bots to save: the database's save order is not the one this maintenance wrote (a switch, a restore, another order, or the database's first generation record replaced it). ${REPLACED}`,
    });
  });
  it('the order write failed with the login blocked', () => {
    const fleet = { askedBlocked: false, orderError: { reason: 'ERROR:  disk full', login: 'blocked' } };
    expect(verdict(rowsOf(), fleet, true)).toEqual({
      kind: 'notAsked', text: `This order did not ask the bots to save: the manager could not write the save order (ERROR:  disk full). ${REPLACED}`,
    });
  });
  it('the login read failed before the order write', () => {
    const fleet = { askedBlocked: false, orderError: { reason: "it could not read the bot's database login: ERROR:  timeout", login: 'unread' } };
    expect(verdict(rowsOf(), fleet, true)).toEqual({
      kind: 'unread', text: `The manager can't confirm that this order asked the bots to save: it could not read the bot's database login before writing the order (ERROR:  timeout). ${REPLACED}`,
    });
  });
});

describe('finalVerdict on a main that was not replaced', () => {
  it('the row is not the order this maintenance wrote: the not-asked text with Running then Maintenance', () => {
    expect(verdict(rowsOf({ order: { ...ORDER, id: 'Y' } }))).toEqual({ kind: 'notAsked', text: TX.notAsked });
  });
  it('every expected process saved: the covered text alone, nothing appended', () => {
    expect(verdict(rowsOf())).toEqual({ kind: 'confirmed', text: TX.covered(1, 'host-a') });
  });
  it('a process renewed one second ago and never answered: "1 second", the uncovered and update texts only', () => {
    const rows = rowsOf({ expected: [{ process: 'p1', name: 'host-a', agoMs: 1000 }], acks: [] });
    expect(verdict(rows)).toEqual({ kind: 'uncovered', text: TX.uncovered('host-a', '1 second') + TX.update });
  });
  it('an answer to another order counts as no answer to this one: the update text follows', () => {
    const rows = rowsOf({ acks: [{ process: 'p1', order: 'OLD', saved: true, ...ZERO }] });
    expect(verdict(rows)).toEqual({ kind: 'uncovered', text: TX.uncovered('host-a', '4 seconds') + TX.update });
  });
  it('a false answer whose file count is NULL says the bot could not count them', () => {
    const rows = rowsOf({ acks: [{ process: 'p1', order: 'X', saved: false, ...ZERO, unsavedGuilds: 2, unsavedFiles: null }] });
    expect(verdict(rows)).toEqual({ kind: 'uncovered', text: 'The bot on host-a reports changes it could not save (the bot could not count them); its log names them.' });
  });
});

describe("readSaveRows: the error names the read's last answered line", () => {
  const OTHER = 'other-container';
  it.each([
    ['a padded last line', 'first line\n  not json  \n', '  not json'],
    ['a last line past 200 characters, cut to 200', `x\n${'y'.repeat(250)}\n`, 'y'.repeat(200)],
  ])('%s', async (_n, stdout, shown) => {
    k.other = () => ({ code: 0, stdout, stderr: '' });
    const r = await readSaveRows({ container: OTHER, user: 'smdb' }, 'smdb');
    expect(r).toEqual({ ok: false, error: `the read answered '${shown}'` });
    expect(k.scripts.filter(s => s.container === OTHER)).toHaveLength(1);
  });
});

describe("Running's hook answer", () => {
  it('a stays mark that is not order, login or file reads as no mark', async () => {
    setupBot(settledRec('maintenance', { fleet: { orderId: 'X', blockedAt: '2026-11-16T10:00:05.000Z' } }));
    h.db = { inRecovery: false, canLogin: false, sessions: 0 };
    k.dbs[CONTAINER].order = { id: 'X', state: 'maintenance', message: 'm', generation: 3, reason: 'order', upMs: 100_000 };
    k.dbs[CONTAINER].acks = [{ process: 'p1', order: 'X', saved: true }];
    h.hook = () => ({ ok: true, status: 200, body: { success: true, stays: 'shards' } });
    const r = await runMaintenanceOrder('b1', 'running', '');
    expect(r.text).toBe("The bot is running normally: its database login is restored, and it took the order to leave maintenance. Whether it restarts is not confirmed (it answered that it can't confirm, or did not say). If a restore ran while it was in maintenance, restart the bot so it loads the restored data.");
  });
});

describe('clearBlockedAt', () => {
  it('a failed record write logs that the block mark stayed', () => {
    setupBot(settledRec('maintenance', { fleet: { orderId: 'X', blockedAt: '2026-11-16T10:00:05.000Z' } }));
    h.writeFail = () => 'the registry is read-only';
    const logged: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logged.push(a); });
    clearBlockedAt('b1');
    expect(logged).toEqual([['[Maintenance] B1: the record could not drop its block mark after the login was found open: the registry is read-only']]);
    expect(h.inst.maintenance.fleet.blockedAt).toBe('2026-11-16T10:00:05.000Z');
  });
});
