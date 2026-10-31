import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  inst: null as any,
  lock: null as string | null,
  app: false as boolean | null,
  answers: [] as any[],
  canLogin: false as boolean | null,
  noHooks: false,
}));

vi.mock('../../src/env/manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/env/manager')>()),
  getEnvVarsWithStatus: () => ({ vars: h.inst?.fleetDb ? { DATA_BACKEND: 'postgres' } : {}, undecryptable: [], encrypted: [], corrupt: false }),
}));
vi.mock('../../src/config/appCapabilities', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/config/appCapabilities')>();
  return {
    ...real,
    findAppCapabilities: (url: string) => {
      const caps = real.findAppCapabilities(url);
      return caps && h.noHooks ? { ...caps, hooks: undefined } : caps;
    },
  };
});
vi.mock('../../src/docker/containerManager', () => ({
  getBot: (id: string) => (h.inst?.id === id ? JSON.parse(JSON.stringify(h.inst)) : null),
  getAllBots: () => (h.inst ? [JSON.parse(JSON.stringify(h.inst))] : []),
  isBotBusy: () => h.lock,
  isShuttingDown: () => false,
  registryFault: () => null,
  databaseHoldRefusal: () => null,
  deleteLaneRefusal: () => null,
  appContainerRunning: async () => h.app,
  withExternalBotOp: async (_id: string, op: string, fn: () => Promise<unknown>) => { h.lock = op; try { return await fn(); } finally { h.lock = null; } },
  updateInstanceMaintenance: (_id: string, rec: any) => { h.inst.maintenance = JSON.parse(JSON.stringify(rec)); },
  stopBotInOp: async () => { h.app = false; return { success: true }; },
  startBotInOp: async () => { h.app = true; return { success: true }; },
  startFleetDbSidecar: async () => ({ success: true }),
  readDeployedCompose: () => 'compose',
}));
vi.mock('../../src/templates/pcsProcessing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/templates/pcsProcessing')>()),
  fleetAppContainerName: () => 'app-1',
}));
vi.mock('../../src/instance/dbLogin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/dbLogin')>()),
  readWriteFence: async () => ({ ok: true, on: false }),
  readBotLogin: async () => ({ ok: true, login: { inRecovery: false, canLogin: h.canLogin, sessions: 0 } }),
  sidecarRunning: async () => true,
  ensureManagerDbRole: async () => ({ ok: true }),
  blockBotLogin: async () => { h.canLogin = false; return { ok: true }; },
  endBotSessions: async () => ({ ok: true }),
  openBotLogin: async () => { h.canLogin = true; return { ok: true }; },
}));
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  callAppHook: async () => (h.answers.length > 1 ? h.answers.shift() : h.answers[0]),
}));

import { getMaintenanceDrift, heldOf, reconcileMaintenance, requireMaintenance, resetMaintenanceState, runMaintenanceOrder } from '../../src/instance/maintenance';

const SMDB = 'https://github.com/x/fully-modular-discord-bot';
const rec = (state: string, over: Record<string, unknown> = {}) => ({ state, message: 'Back soon', orderedAt: '2026-10-01T00:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: 'maintenance', ...over });

function setup(kind: 'database' | 'json', maintenance: any): void {
  h.inst = { id: 'b1', displayName: 'B1', sourceUrl: SMDB, envVars: {}, createdAt: 'x', maintenance };
  if (kind === 'database') h.inst.fleetDb = { containerName: 'b1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'v' };
}

beforeEach(() => {
  h.lock = null;
  h.app = true;
  h.canLogin = false;
  h.noHooks = false;
  h.answers = [{ ok: true, status: 200, body: { success: true, state: 'maintenance', saved: true } }];
  resetMaintenanceState();
  setup('database', rec('running'));
});

describe('the answer parse', () => {
  it('a negative count reads as 0', () => {
    expect(heldOf({ saved: false, unsavedGuilds: -1, unsavedFiles: -3 })).toEqual({ state: 'no', guilds: 0, files: 0 });
  });
});

describe('held: not-running only for a new order away from Running with no hook step', () => {
  it('a Running order of a json bot that is not running records no held', async () => {
    setup('json', rec('maintenance', { login: 'not-managed' }));
    h.app = false;
    await runMaintenanceOrder('b1', 'running', '');
    expect(h.inst.maintenance.state).toBe('running');
    expect(h.inst.maintenance.held).toBeUndefined();
  });
  it('a retry of Maintenance with no bot running records no held', async () => {
    setup('database', rec('maintenance', { settled: false, hook: 'unconfirmed', login: 'unconfirmed' }));
    h.app = false;
    await runMaintenanceOrder('b1', 'maintenance', 'Back soon', { retry: true });
    expect(h.inst.maintenance.settled).toBe(true);
    expect(h.inst.maintenance.held).toBeUndefined();
  });
  it('a Maintenance order of a running bot without hooks records no held', async () => {
    h.noHooks = true;
    setup('database', rec('running', { hook: 'none' }));
    h.app = true;
    await runMaintenanceOrder('b1', 'maintenance', 'Back soon');
    expect(h.inst.maintenance.state).toBe('maintenance');
    expect(h.inst.maintenance.held).toBeUndefined();
  });
});

describe('a confirmed Running hook leaves held as it was', () => {
  it('on a retry of Running', async () => {
    setup('database', rec('running', { settled: false, hook: 'unconfirmed', login: 'unconfirmed', held: { state: 'yes' } }));
    h.answers = [{ ok: true, status: 200, body: { success: true, restarting: true } }];
    await runMaintenanceOrder('b1', 'running', '', { retry: true });
    expect(h.inst.maintenance.hook).toBe('confirmed');
    expect(h.inst.maintenance.held).toEqual({ state: 'yes' });
  });
  it("on the reconciler's hook retry of Running", async () => {
    setup('json', rec('running', { hook: 'unconfirmed', login: 'not-managed', held: { state: 'yes' } }));
    h.answers = [{ ok: true, status: 200, body: { success: true, restarting: true } }];
    await reconcileMaintenance();
    await reconcileMaintenance();
    expect(h.inst.maintenance.hook).toBe('confirmed');
    expect(h.inst.maintenance.held).toEqual({ state: 'yes' });
  });
});

describe('proofs and drift', () => {
  it("the Off proof of a json bot carries the recorded held", async () => {
    setup('json', rec('off', { login: 'not-managed', held: { state: 'stopped' } }));
    h.app = false;
    h.lock = 'handover';
    expect(await requireMaintenance('b1', 'any')).toEqual({ ok: true, state: 'off', enforcement: 'stopped', botConfirmed: true, held: { state: 'stopped' } });
  });
  it('an open login clears the blocked-login drift while a switch mark stands', async () => {
    setup('database', rec('running', { login: 'open', savedByBot: 'running' }));
    h.canLogin = false;
    await reconcileMaintenance();
    expect(getMaintenanceDrift('b1')).not.toBeNull();
    h.inst.fleetDb.handover = { slot: 's', machine: 'm', generation: 2 };
    h.canLogin = true;
    await reconcileMaintenance();
    expect(getMaintenanceDrift('b1')).toBeNull();
  });
});
