// NX5 test 12, the runCore part: Off's stop keeps the hook answer it replaced as `before`, with `shut` (J2, L3), and
// a lane meets an order left unsettled by a failed final read at requireMaintenance.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/docker/processStart', async (o) => (await import('./nx5-kit')).processStartMock(await o()));
vi.mock('../../src/instance/switchSql', async (o) => (await import('./nx5-kit')).switchSqlMock(await o()));
vi.mock('../../src/env/manager', async (o) => (await import('./nx5-kit')).envMock(await o()));
vi.mock('../../src/config/appCapabilities', async (o) => (await import('./nx5-kit')).capsMock(await o()));
vi.mock('../../src/docker/containerManager', async () => (await import('./nx5-kit')).containerManagerMock());
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./nx5-kit')).dbLoginMock(await o()));
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./nx5-kit')).appHookMock(await o()));
vi.mock('../../src/instance/fleetReplication', async (o) => (await import('./nx5-kit')).fleetReplicationMock(await o()));

import { MAINTENANCE_TIMING, requireMaintenance, resetMaintenanceState, runMaintenanceOrder } from '../../src/instance/maintenance';
import { CONTAINER, h, k, resetH, resetKit, setupBot, wire } from './nx5-kit';
import { TX } from './nx5-texts-kit';

const T = MAINTENANCE_TIMING as any;
const rec = () => h.inst.maintenance;

beforeEach(() => {
  resetMaintenanceState();
  resetH();
  resetKit();
  wire();
  setupBot();
  T.ackPollMs = 2;
  T.ackWaitMs = 20;
});

const OFF = () => runMaintenanceOrder('b1', 'off', 'Gone');
const SAVED_FALSE = () => ({ ok: true, status: 200, body: { success: true, saved: false, unsavedGuilds: 2, unsavedFiles: 1 } });
const SAVED_NULL = () => ({ ok: true, status: 200, body: { success: true, saved: null } });
const TIMED_OUT = () => ({ ok: false, unknown: true, error: 'maintenance sent, no answer within 30 s' });

describe("the stop's record (J2, L3)", () => {
  it.each([[true], [false]])("hook saved false, then the stop with the block landed: before 'no' with the counts, shut true (save order %s)", async (saveOrder) => {
    h.saveOrder = saveOrder;
    h.hook = SAVED_FALSE;
    await OFF();
    expect(rec().held).toEqual({ state: 'stopped', before: { state: 'no', guilds: 2, files: 1 }, shut: true });
  });
  it("hook answered null: before 'unknown'", async () => {
    h.hook = SAVED_NULL;
    await OFF();
    expect(rec().held).toEqual({ state: 'stopped', before: { state: 'unknown' }, shut: true });
  });
  it('hook timed out: no before, shut true', async () => {
    h.hook = TIMED_OUT;
    await OFF();
    expect(rec().held).toEqual({ state: 'stopped', shut: true });
  });
  it('the block fails (a psql timeout): shut false; the retry blocks, settles, and keeps that answer as it was', async () => {
    h.hook = SAVED_FALSE;
    h.block = { ok: false, cls: 'other', error: 'docker did not answer within 30 s' };
    await OFF();
    expect(rec().held).toEqual({ state: 'stopped', before: { state: 'no', guilds: 2, files: 1 }, shut: false });
    h.block = { ok: true };
    const r = await runMaintenanceOrder('b1', 'off', '', { retry: true });
    expect(r.settled).toBe(true);
    expect(rec().held).toEqual({ state: 'stopped', before: { state: 'no', guilds: 2, files: 1 }, shut: false });
  });
  it('end-sessions leaves one session: shut false', async () => {
    h.hook = SAVED_FALSE;
    h.end = { ok: false, left: 1, error: '1 session left' };
    await OFF();
    expect(rec().held).toMatchObject({ state: 'stopped', shut: false });
  });
  it("guard: a hook that answered saved true keeps 'yes' after the stop", async () => {
    await OFF();
    expect(rec().held).toMatchObject({ state: 'yes' });
  });
});

describe('a lane meets an order a failed final read left unsettled', () => {
  it('is refused at requireMaintenance with the stored reason', async () => {
    const reason = TX.finalReason('ERROR:  canceling statement due to statement timeout');
    k.dbs[CONTAINER].failNext.read = ['', 'ERROR:  canceling statement due to statement timeout'];
    const r = await runMaintenanceOrder('b1', 'maintenance', 'm');
    expect(r.settled).toBe(false);
    expect(rec()).toMatchObject({ state: 'maintenance', settled: false, lastError: reason });
    expect(rec().fleet.verdict).toBeUndefined();
    h.lock = 'handover';
    const p = await requireMaintenance('b1', 'database');
    expect(p).toEqual({ ok: false, error: `The bot's change to Maintenance is not confirmed yet (${reason}), so it does not count as maintenance` });
  });
});
