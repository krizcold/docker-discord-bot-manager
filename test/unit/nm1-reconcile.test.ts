import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  inst: null as any,
  env: { vars: { DATA_BACKEND: 'postgres' } as Record<string, string>, undecryptable: [] as string[], encrypted: [] as string[], corrupt: false },
  lock: null as string | null,
  hold: false,
  fault: null as string | null,
  shutting: false,
  app: true as boolean | null,
  sidecar: true as boolean | null,
  db: { inRecovery: false, canLogin: false, sessions: 0 } as any,
  readFail: null as string | null,
  events: [] as string[],
  hook: { ok: true, status: 200, body: { success: true } } as any,
  hookGate: null as null | Promise<void>,
  onSidecar: null as null | (() => void),
  onApp: null as null | (() => void),
  writeFail: null as string | null,
}));

vi.mock('../../src/env/manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/env/manager')>()),
  getEnvVarsWithStatus: () => h.env,
}));
vi.mock('../../src/docker/containerManager', () => ({
  SHUTDOWN_REFUSAL: 'shutting down',
  isShuttingDown: () => h.shutting,
  registryFault: () => h.fault,
  getBot: (id: string) => (h.inst?.id === id ? JSON.parse(JSON.stringify(h.inst)) : null),
  getAllBots: () => (h.inst ? [JSON.parse(JSON.stringify(h.inst))] : []),
  isBotBusy: () => h.lock,
  databaseHoldRefusal: () => (h.hold ? { success: false, error: 'held' } : null),
  deleteLaneRefusal: () => null,
  updateInstanceMaintenance: (_id: string, rec: any) => { if (h.writeFail) throw new Error(h.writeFail); h.events.push('write'); if (rec) h.inst.maintenance = JSON.parse(JSON.stringify(rec)); else delete h.inst.maintenance; },
  withExternalBotOp: async (_id: string, op: string, fn: () => Promise<unknown>) => {
    if (h.lock) throw new Error(`Operation '${h.lock}' is already in progress for this bot`);
    h.lock = op;
    try { return await fn(); } finally { h.lock = null; }
  },
  appContainerRunning: async () => { h.onApp?.(); return h.app; },
  startBotInOp: async () => { h.events.push('start'); h.app = true; return { success: true }; },
  stopBotInOp: async () => { h.events.push('stop'); h.app = false; return { success: true }; },
  startFleetDbSidecar: async () => { h.events.push('db-up'); h.sidecar = true; return { success: true }; },
}));
vi.mock('../../src/instance/dbLogin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/dbLogin')>()),
  sidecarRunning: async () => { h.onSidecar?.(); return h.sidecar; },
  ensureManagerDbRole: async () => { h.events.push('ensure'); return { ok: true }; },
  readBotLogin: async () => { h.events.push('read'); return h.readFail ? { ok: false, cls: 'other', error: h.readFail } : { ok: true, login: { ...h.db } }; },
  blockBotLogin: async () => { h.events.push('block'); h.db.canLogin = false; return { ok: true }; },
  endBotSessions: async () => { h.events.push('end-sessions'); h.db.sessions = 0; return { ok: true }; },
  openBotLogin: async () => { h.events.push('open'); h.db.canLogin = true; return { ok: true }; },
}));
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  callAppHook: async (_i: any, _a: string, _m: string, body: any) => { h.events.push(`hook:${body.state}`); if (h.hookGate) await h.hookGate; return h.hook; },
}));

import { reconcileMaintenance, setMaintenanceListener, resetMaintenanceState, getMaintenanceDrift, startMaintenanceReconciler, stopMaintenanceReconciler, MAINTENANCE_TIMING } from '../../src/instance/maintenance';

const SMDB = 'https://github.com/x/fully-modular-discord-bot';
const rec = (state: string, over: Record<string, unknown> = {}) => ({ state, message: 'm', orderedAt: '2026-10-01T00:00:00.000Z', settled: true, hook: 'confirmed', login: state === 'running' ? 'open' : 'blocked', savedByBot: state === 'running' ? 'running' : 'maintenance', ...over });
const setup = (maintenance?: any, kind: 'database' | 'json' = 'database') => {
  h.inst = { id: 'b1', displayName: 'B1', sourceUrl: SMDB, envVars: {}, createdAt: 'x', maintenance };
  if (kind === 'database') { h.inst.fleetDb = { containerName: 'b1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'v' }; h.env.vars = { DATA_BACKEND: 'postgres' }; }
  else h.env.vars = {};
};
const settle = async () => { for (let i = 0; i < 50 && h.lock; i++) await new Promise(r => setTimeout(r, 2)); };

let logs: string[] = [];
beforeEach(() => {
  resetMaintenanceState();
  MAINTENANCE_TIMING.hookWaitMs = 20; MAINTENANCE_TIMING.hookWaitPauseMs = 1; MAINTENANCE_TIMING.hookWaitTryMs = 10;
  h.lock = null; h.hold = false; h.fault = null; h.shutting = false; h.app = true; h.sidecar = true;
  h.db = { inRecovery: false, canLogin: false, sessions: 0 }; h.readFail = null; h.events = [];
  h.hook = { ok: true, status: 200, body: { success: true } }; h.hookGate = null; h.onSidecar = null; h.onApp = null; h.writeFail = null;
  setup(rec('maintenance'));
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((m: unknown) => { logs.push(String(m)); });
  vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { logs.push(String(m)); });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); stopMaintenanceReconciler(); setMaintenanceListener(null); });

const pass = async () => { await reconcileMaintenance(); await settle(); };

describe('maintenance reconciler', () => {
  it('C1 first pass: an unsettled record runs again in full, logged', async () => {
    setup(rec('off', { settled: false, hook: 'unconfirmed', login: 'unconfirmed' }));
    await pass();
    expect(h.events).toContain('stop');
    expect(h.inst.maintenance).toMatchObject({ state: 'off', settled: true });
    expect(logs).toContain('[Maintenance] B1: the manager restarted before the order Off of 2026-10-01T00:00:00.000Z was confirmed; running it again');
  });
  it('the first pass makes sure of the manager role for a database bot whose sidecar runs', async () => {
    await pass();
    expect(h.events).toContain('ensure');
  });
  it.each([['an op lock', () => { h.lock = 'restore'; }], ['a database lane hold', () => { h.hold = true; }]])('C2 a bot under %s is skipped', async (_n, arrange) => {
    setup(rec('maintenance', { settled: false }));
    arrange();
    const lock = h.lock;
    await reconcileMaintenance();
    expect(h.events).toEqual([]);
    expect(h.lock).toBe(lock);
  });
  it('C3 settled maintenance, hook unconfirmed, app running: hook again, confirmed', async () => {
    setup(rec('maintenance', { hook: 'unconfirmed', savedByBot: null }));
    await pass();
    expect(h.events).toContain('hook:maintenance');
    expect(h.inst.maintenance).toMatchObject({ hook: 'confirmed', savedByBot: 'maintenance', settled: true });
    expect(logs).toContain('[Maintenance] B1: the bot took the Maintenance order on a retry');
  });
  it('C4 maintenance, the read shows the login open: blocked again, logged', async () => {
    h.db.canLogin = true; h.db.sessions = 1;
    await pass();
    expect(h.events).toEqual(expect.arrayContaining(['block', 'end-sessions']));
    expect(logs).toContain('[Maintenance] B1: the database login was open while the state is Maintenance; blocked it again');
  });
  it('C5 running, the read shows the login blocked: drift, no write, cleared when open', async () => {
    setup(rec('running'));
    await pass();
    expect(getMaintenanceDrift('b1')).toBe("The bot's database login is blocked, but its state is Running, so every process of this bot answers with the maintenance message. Choose Running in State to restore the login.");
    expect(h.events).not.toContain('write');
    expect(h.events).not.toContain('open');
    expect(logs).toContain("[Maintenance] B1: the bot's database login is blocked while its state is Running");
    await pass();
    expect(logs.filter(l => l.includes('blocked while its state is Running')).length).toBe(1);
    h.db.canLogin = true;
    await pass();
    expect(getMaintenanceDrift('b1')).toBeNull();
  });
  it('C6 off and the app runs: drift; cleared when none runs', async () => {
    setup(rec('off'));
    await pass();
    expect(getMaintenanceDrift('b1')).toBe('The state is Off, but the bot runs (it was started outside the manager). Choose Off in State to stop it, or Running.');
    expect(h.events).not.toContain('stop');
    h.app = false;
    await pass();
    expect(getMaintenanceDrift('b1')).toBeNull();
  });
  it('C7 sidecar not running: nothing', async () => {
    setup(rec('running'));
    await pass();
    h.sidecar = false; h.events = [];
    await pass();
    expect(h.events.filter(e => e !== 'read')).toEqual([]);
    expect(getMaintenanceDrift('b1')).not.toBeNull();
  });
  it('C8 the read fails: nothing, the drift unchanged', async () => {
    setup(rec('running'));
    await pass();
    h.readFail = 'no answer'; h.events = [];
    await pass();
    expect(h.events.filter(e => e !== 'read')).toEqual([]);
    expect(getMaintenanceDrift('b1')).not.toBeNull();
  });
  it('C9 registry broken: the pass is skipped', async () => {
    h.fault = 'broken';
    await pass();
    expect(h.events).toEqual([]);
  });
  it('C10 shutting down: the pass is skipped', async () => {
    h.shutting = true;
    await pass();
    expect(h.events).toEqual([]);
  });
  it('C11 unsettled after the first pass: the remaining steps again, a stop but never a start, then the verdict', async () => {
    setup(rec('running'));
    h.db.canLogin = true;
    await pass();
    setup(rec('off', { settled: false, login: 'unconfirmed' }));
    h.db.canLogin = true; h.app = true; h.events = [];
    await pass();
    expect(h.events).not.toContain('start');
    expect(h.events).not.toContain('db-up');
    expect(h.events).toEqual(expect.arrayContaining(['block', 'end-sessions', 'stop']));
    expect(h.events.indexOf('block')).toBeLessThan(h.events.indexOf('stop'));
    expect(h.inst.maintenance.settled).toBe(true);
  });
  it('C11 a retry owed a start does not start the bot and stays unsettled', async () => {
    await pass();
    setup(rec('maintenance', { settled: false, login: 'unconfirmed', prior: { state: 'off', message: '' } }));
    h.app = false; h.events = [];
    await pass();
    expect(h.events).not.toContain('start');
    expect(h.events).not.toContain('db-up');
    expect(h.events).toEqual(expect.arrayContaining(['block', 'end-sessions']));
    expect(h.inst.maintenance).toMatchObject({ settled: false, lastError: 'the bot is stopped, and a retry does not start it' });
  });
  it('C12 running, hook unconfirmed, app running: the running hook again', async () => {
    setup(rec('running', { hook: 'unconfirmed' }));
    h.db.canLogin = true;
    await pass();
    expect(h.events).toContain('hook:running');
    expect(h.inst.maintenance).toMatchObject({ hook: 'confirmed', savedByBot: 'running' });
  });
  it('C13 a second pass while the first runs is skipped', async () => {
    setup(rec('maintenance', { hook: 'unconfirmed' }));
    let release!: () => void;
    h.hookGate = new Promise<void>(r => { release = r; });
    const first = reconcileMaintenance();
    await new Promise(r => setTimeout(r, 5));
    await reconcileMaintenance();
    expect(h.events.filter(e => e.startsWith('hook')).length).toBe(1);
    release();
    await first;
    await settle();
  });
  it('the reconciler runs a pass at once and on its 30 s interval', async () => {
    vi.useFakeTimers();
    setup(rec('running'));
    startMaintenanceReconciler();
    await vi.advanceTimersByTimeAsync(10);
    const after = h.events.filter(e => e === 'read').length;
    expect(after).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.events.filter(e => e === 'read').length).toBeGreaterThan(after);
    stopMaintenanceReconciler();
  });
  it('F1 a Running order that settles after the pass read the record: the retry replays nothing', async () => {
    await pass();
    setup(rec('maintenance', { settled: false, login: 'unconfirmed' }));
    h.events = [];
    h.onSidecar = () => { h.onSidecar = null; h.inst.maintenance = rec('running'); h.db.canLogin = true; };
    await pass();
    expect(h.events).not.toContain('hook:maintenance');
    expect(h.events).not.toContain('block');
    expect(h.inst.maintenance).toMatchObject({ state: 'running', settled: true, login: 'open' });
  });
  it('F1 C4 re-reads the record under its lock: a Running order that settled meanwhile is not blocked', async () => {
    await pass();
    setup(rec('maintenance'));
    h.db.canLogin = true; h.events = [];
    h.onSidecar = () => { h.onSidecar = null; h.inst.maintenance = rec('running'); };
    await pass();
    expect(h.events).not.toContain('block');
  });
  it('F1 D-OFF re-reads the record: a Running order that settled meanwhile sets no drift', async () => {
    await pass();
    setup(rec('off', { login: 'not-managed' }), 'json');
    h.app = true;
    h.onApp = () => { h.onApp = null; h.inst.maintenance = rec('running', { login: 'not-managed' }); };
    await pass();
    expect(getMaintenanceDrift('b1')).toBeNull();
  });
  it('F1 D-LOGIN re-reads the record: a Maintenance order that settled after the pass read the list sets no drift', async () => {
    await pass();
    setup(rec('running'));
    h.db.canLogin = false; h.events = [];
    h.onSidecar = () => { h.onSidecar = null; h.inst.maintenance = rec('maintenance'); };
    await pass();
    expect(getMaintenanceDrift('b1')).toBeNull();
    expect(logs.some(l => l.includes('blocked while its state is Running'))).toBe(false);
  });
  it('F3 a retry broadcasts only when the order settles or its error text changes', async () => {
    await pass();
    setup(rec('maintenance', { settled: false, login: 'unconfirmed', lastError: 'the database did not start (x)' }));
    h.sidecar = false;
    const heard: boolean[] = [];
    setMaintenanceListener((_id, _r, notify) => { heard.push(notify); });
    await pass();
    await pass();
    expect(heard).toEqual([true, false]);
    h.sidecar = true;
    await pass();
    expect(heard).toEqual([true, false, true]);
    expect(h.inst.maintenance.settled).toBe(true);
  });
});

describe('round 2', () => {
  it('N2 a save that fails on every pass broadcasts once, then only when its text changes', async () => {
    setup(rec('running', { settled: false, hook: 'unconfirmed', login: 'not-managed' }), 'json');
    h.app = true;
    h.writeFail = 'disk full';
    const heard: boolean[] = [];
    setMaintenanceListener((_id, _r, notify) => { heard.push(notify); });
    await pass();
    await pass();
    expect(heard).toEqual([true, false]);
    h.writeFail = 'EACCES';
    await pass();
    expect(heard).toEqual([true, false, true]);
  });
});

describe('round 3', () => {
  it('R2 D-OFF is cleared once the record is not Off, for a json bot', async () => {
    setup(rec('off', { login: 'not-managed' }), 'json');
    h.app = true;
    await pass();
    expect(getMaintenanceDrift('b1')).not.toBeNull();
    h.inst.maintenance = rec('running', { login: 'not-managed' });
    await pass();
    expect(getMaintenanceDrift('b1')).toBeNull();
  });
});
