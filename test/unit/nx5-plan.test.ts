// NX5 test 10: the plans of a save-order app, the retry filter, and what a new order's record keeps.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/docker/processStart', async (o) => (await import('./nx5-kit')).processStartMock(await o()));
vi.mock('../../src/instance/switchSql', async (o) => (await import('./nx5-kit')).switchSqlMock(await o()));
vi.mock('../../src/env/manager', async (o) => (await import('./nx5-kit')).envMock(await o()));
vi.mock('../../src/config/appCapabilities', async (o) => (await import('./nx5-kit')).capsMock(await o()));
vi.mock('../../src/docker/containerManager', async () => (await import('./nx5-kit')).containerManagerMock());
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./nx5-kit')).dbLoginMock(await o()));
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./nx5-kit')).appHookMock(await o()));
vi.mock('../../src/instance/fleetReplication', async (o) => (await import('./nx5-kit')).fleetReplicationMock(await o()));

import { MAINTENANCE_TIMING, orderPlan, resetMaintenanceState, runMaintenanceOrder } from '../../src/instance/maintenance';
import { CONTAINER, claim, h, k, resetH, resetKit, settledRec, setupBot, SMDB, wire } from './nx5-kit';

const T = MAINTENANCE_TIMING as any;

beforeEach(() => {
  resetMaintenanceState();
  resetH();
  resetKit();
  wire();
  setupBot();
  T.ackPollMs = 2;
  T.ackWaitMs = 40;
  MAINTENANCE_TIMING.hookWaitMs = 30;
  MAINTENANCE_TIMING.hookWaitPauseMs = 1;
  MAINTENANCE_TIMING.hookWaitTryMs = 10;
});

const plan = (to: 'running' | 'maintenance' | 'off', app: boolean, fromOff: boolean, saveOrder: boolean, hooks = true) =>
  (orderPlan as any)({ kind: 'database', to, fromOff, app, savedByBot: 'maintenance', hooks, saveOrder });

describe('orderPlan with the save order declared (decision 4, H4)', () => {
  it.each([
    ['Maintenance, own container running', 'maintenance', true, false, ['db-up', 'order', 'acks', 'hook', 'block', 'end-sessions', 'final']],
    ['Maintenance from Off', 'maintenance', false, true, ['db-up', 'order', 'acks', 'block', 'end-sessions', 'final', 'start', 'hook-wait']],
    ['Maintenance, own container stopped, not Off', 'maintenance', false, false, ['db-up', 'order', 'acks', 'block', 'end-sessions', 'final']],
    ['Off, own container running', 'off', true, false, ['db-up', 'order', 'acks', 'hook', 'block', 'end-sessions', 'final', 'stop', 'db-up-alone']],
    ['Off, own container stopped', 'off', false, false, ['db-up', 'order', 'acks', 'block', 'end-sessions', 'final', 'db-up-alone']],
    ['Off from Off, stopped', 'off', false, true, ['db-up', 'order', 'acks', 'block', 'end-sessions', 'final', 'db-up-alone']],
    ['guard: Running, running', 'running', true, false, ['db-up', 'open', 'hook']],
    ['guard: Running from Off', 'running', false, true, ['db-up', 'open', 'start', 'hook-wait']],
  ] as const)('%s', (_n, to, app, fromOff, steps) => {
    expect(plan(to, app, fromOff, true)).toEqual({ steps });
  });
  it('stopped, not Off: order, acks and final, no hook and no stop', () => {
    for (const to of ['maintenance', 'off'] as const) {
      const { steps } = plan(to, false, false, true);
      expect(steps).toEqual(expect.arrayContaining(['order', 'acks', 'final']));
      expect(steps).not.toContain('hook');
      expect(steps).not.toContain('stop');
    }
  });
  it('an app without hooks drops only the hook steps', () => {
    expect(plan('maintenance', true, false, true, false)).toEqual({ steps: ['db-up', 'order', 'acks', 'block', 'end-sessions', 'final'] });
  });
});

describe('guard: an app without the save order keeps today\'s plans', () => {
  it.each([
    ['maintenance', true, false, ['hook', 'db-up', 'block', 'end-sessions']],
    ['maintenance', false, true, ['db-up', 'block', 'end-sessions', 'start', 'hook-wait']],
    ['maintenance', false, false, ['db-up', 'block', 'end-sessions']],
    ['off', true, false, ['hook', 'db-up', 'block', 'end-sessions', 'stop', 'db-up-alone']],
    ['off', false, false, ['db-up', 'block', 'end-sessions', 'db-up-alone']],
    ['running', true, false, ['db-up', 'open', 'hook']],
  ] as const)('%s app %s fromOff %s', (to, app, fromOff, steps) => {
    expect(plan(to, app, fromOff, false)).toEqual({ steps });
  });
});

describe('the manifest', () => {
  it("our bot's manifest declares companionDb.saveOrder", async () => {
    const real = await vi.importActual<typeof import('../../src/config/appCapabilities')>('../../src/config/appCapabilities');
    expect((real.findAppCapabilities(SMDB)?.companionDb as any)?.saveOrder).toBe(true);
  });
});

const unsettled = (state: string, fleet: Record<string, unknown> | undefined, over: Record<string, unknown> = {}) => ({
  state, message: 'm', orderedAt: '2026-11-16T10:00:00.000Z', settled: false, hook: 'confirmed', login: 'unconfirmed', savedByBot: 'maintenance',
  prior: { state: 'running', message: '' }, ...(fleet ? { fleet } : {}), ...over,
});
const retry = (to = 'maintenance') => runMaintenanceOrder('b1', to as any, 'm', { retry: true });
const before = (a: string, b: string) => h.events.indexOf(a) >= 0 && h.events.indexOf(a) < h.events.indexOf(b);

describe("the retry filter (decision 4's retry and resume, P1)", () => {
  it('runs order while the mark orderFor is missing, with the login read blocked', async () => {
    setupBot(unsettled('maintenance', { orderId: 'X', blockedAt: '2026-11-16T09:00:00.000Z' }));
    h.db = { inRecovery: false, canLogin: false, sessions: 0 };
    await retry();
    expect(h.events).toContain('order-write');
  });
  it('runs order while the login reads open at the start of the pass, though the mark is set', async () => {
    setupBot(unsettled('maintenance', { orderId: 'X', orderFor: '2026-11-16T10:00:00.000Z', generation: 3, upMs: 100_000 }));
    k.dbs[CONTAINER].order = { id: 'X', state: 'maintenance', message: 'm', generation: 3, reason: 'order', upMs: 100_000 };
    k.dbs[CONTAINER].claims = [claim('p1', 'host-a')];
    k.dbs[CONTAINER].autoAck = { p1: { saved: true } };
    await retry();
    expect(h.events).toContain('order-write');
    expect(before('read', 'block')).toBe(true);
  });
  it('runs no order with the mark set and the login blocked, and no acks before the block', async () => {
    setupBot(unsettled('maintenance', { orderId: 'X', orderFor: '2026-11-16T10:00:00.000Z', blockedAt: '2026-11-16T10:00:05.000Z', generation: 3, upMs: 100_000 }));
    k.dbs[CONTAINER].order = { id: 'X', state: 'maintenance', message: 'm', generation: 3, reason: 'order', upMs: 100_000 };
    h.db = { inRecovery: false, canLogin: false, sessions: 0 };
    await retry();
    expect(h.events).not.toContain('order-write');
    expect(h.events.indexOf('read')).toBeGreaterThan(h.events.indexOf('block'));
  });
  it('runs final while the record holds no verdict, and not once one is recorded', async () => {
    setupBot(unsettled('maintenance', { orderId: 'X', orderFor: '2026-11-16T10:00:00.000Z', blockedAt: '2026-11-16T10:00:05.000Z', generation: 3, upMs: 100_000 }));
    k.dbs[CONTAINER].order = { id: 'X', state: 'maintenance', message: 'm', generation: 3, reason: 'order', upMs: 100_000 };
    h.db = { inRecovery: false, canLogin: false, sessions: 0 };
    await retry();
    expect(h.events).toContain('read');
    expect(h.inst.maintenance.fleet.verdict).toBeDefined();

    setupBot(unsettled('off', { orderId: 'X', orderFor: '2026-11-16T10:00:00.000Z', blockedAt: '2026-11-16T10:00:05.000Z', verdict: { kind: 'confirmed' } }, { prior: { state: 'maintenance', message: 'm' } }));
    h.db = { inRecovery: false, canLogin: false, sessions: 0 };
    h.events = [];
    await retry('off');
    expect(h.events).toContain('stop:maintenance');
    expect(h.events).not.toContain('read');
    expect(h.events).not.toContain('order-write');
  });
  it('runs order, acks and final only with the database up: a retry never starts it', async () => {
    setupBot(unsettled('maintenance', { orderId: 'X' }));
    h.sidecar = false;
    const down = await retry();
    expect(h.events).not.toContain('db-up');
    expect(h.events.filter(e => e === 'order-write' || e === 'read')).toEqual([]);
    expect(down.text).toContain('the database is not running, and a retry does not start it');
    h.sidecar = true;
    h.events = [];
    await retry();
    expect(h.events).not.toContain('db-up');
    expect(h.events.indexOf('order-write')).toBeGreaterThanOrEqual(0);
    expect(h.events.indexOf('read')).toBeGreaterThan(h.events.indexOf('order-write'));
  });
});

describe("a new order's record (P1)", () => {
  it('keeps only orderId, blockedAt and askedBlocked of the settled record before it', async () => {
    setupBot(settledRec('maintenance', {
      fleet: {
        orderId: 'X', generation: 3, upMs: 5, askedBlocked: false, blockedAt: '2026-11-16T09:00:00.000Z', orderFor: '2026-10-01T00:00:00.000Z',
        verdict: { kind: 'confirmed' }, orderFails: 1, orderError: { reason: 'r', login: 'open' },
      },
    }));
    h.db = { inRecovery: false, canLogin: false, sessions: 0 };
    await runMaintenanceOrder('b1', 'off', 'gone');
    expect(h.writes[0].fleet).toEqual({ orderId: 'X', blockedAt: '2026-11-16T09:00:00.000Z', askedBlocked: false });
  });
  it('a Running record keeps only orderId', async () => {
    setupBot(settledRec('maintenance', { fleet: { orderId: 'X', blockedAt: '2026-11-16T09:00:00.000Z', askedBlocked: true, verdict: { kind: 'confirmed' }, orderFor: '2026-10-01T00:00:00.000Z' } }));
    h.db = { inRecovery: false, canLogin: false, sessions: 0 };
    await runMaintenanceOrder('b1', 'running', '');
    expect(h.writes[0].fleet).toEqual({ orderId: 'X' });
  });
});
