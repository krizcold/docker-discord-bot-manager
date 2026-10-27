import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  inst: null as any,
  env: { vars: {} as Record<string, string>, undecryptable: [] as string[], encrypted: [] as string[], corrupt: false },
  envCalls: 0,
  envThrowAt: 0,
  lock: null as string | null,
  busyFn: null as null | (() => string | null),
  shutFn: null as null | (() => boolean),
  passes: 0,
  hold: false,
  holdActions: [] as string[],
  app: true as boolean | null,
  appCalls: 0,
  appGate: null as null | Promise<void>,
  appThrow: null as string | null,
  onApp: null as null | (() => void),
  onLock: null as null | (() => void),
  sidecar: true as boolean | null,
  stopKeepsDb: false,
  db: { inRecovery: false, canLogin: true as boolean | null, sessions: 1 },
  readFail: null as string | null,
  readBlockedAfterOpen: false,
  ensure: { ok: true } as any,
  block: { ok: true } as any,
  blockThrow: null as string | null,
  hook: (_body: any): any => ({ ok: true, status: 200, body: { success: true } }),
  start: { success: true } as { success: boolean; error?: string },
  stop: { success: true } as { success: boolean; error?: string },
  events: [] as string[],
  writes: [] as any[],
  failWrite: (_n: number, _rec: any): string | null => null,
  crashAt: null as string | null,
}));

const NOHOOKS_URL = 'https://github.com/x/db-without-hooks';
vi.mock('../../src/config/appCapabilities', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/config/appCapabilities')>();
  return {
    ...orig,
    findAppCapabilities: (url: string | null | undefined) => {
      if (url === NOHOOKS_URL) {
        const caps = orig.findAppCapabilities('https://github.com/x/fully-modular-discord-bot');
        return caps ? { ...caps, hooks: undefined } : null;
      }
      return orig.findAppCapabilities(url);
    },
  };
});
vi.mock('../../src/env/manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/env/manager')>()),
  getEnvVarsWithStatus: () => { h.envCalls++; if (h.envCalls === h.envThrowAt) throw new Error('store gone'); return h.env; },
}));

const crash = (step: string) => { if (h.crashAt === step) { h.crashAt = null; throw new Error(`crash at ${step}`); } };

vi.mock('../../src/docker/containerManager', () => ({
  SHUTDOWN_REFUSAL: 'shutting down',
  isShuttingDown: () => (h.shutFn ? h.shutFn() : false),
  registryFault: () => { h.passes++; return null; },
  getBot: (id: string) => (h.inst && h.inst.id === id ? JSON.parse(JSON.stringify(h.inst)) : null),
  getAllBots: () => (h.inst ? [JSON.parse(JSON.stringify(h.inst))] : []),
  isBotBusy: () => (h.busyFn ? h.busyFn() : h.lock),
  databaseHoldRefusal: (_id: string, action: string) => { h.holdActions.push(action); return h.hold ? { success: false, error: 'held' } : null; },
  deleteLaneRefusal: () => null,
  updateInstanceMaintenance: (_id: string, rec: any) => {
    const err = h.failWrite(h.writes.length + 1, rec);
    if (err) throw new Error(err);
    h.writes.push(rec ? JSON.parse(JSON.stringify(rec)) : null);
    if (rec) h.inst.maintenance = JSON.parse(JSON.stringify(rec));
    else delete h.inst.maintenance;
  },
  withExternalBotOp: async (_id: string, op: string, fn: () => Promise<unknown>) => {
    if (h.lock) throw new Error(`Operation '${h.lock}' is already in progress for this bot`);
    h.lock = op;
    h.onLock?.();
    try { return await fn(); } finally { h.lock = null; }
  },
  appContainerRunning: async () => {
    h.appCalls++;
    if (h.appGate) await h.appGate;
    h.onApp?.();
    if (h.appThrow) throw new Error(h.appThrow);
    return h.app;
  },
  startBotInOp: async () => { h.events.push('start'); if (h.start.success || h.start.error === 'Bot is already running') h.app = true; return h.start; },
  stopBotInOp: async () => {
    crash('stop');
    h.events.push('stop');
    if (h.stop.success) { h.app = false; if (!h.stopKeepsDb) h.sidecar = false; }
    return h.stop;
  },
  startFleetDbSidecar: async () => { h.events.push('db-up'); h.sidecar = true; return { success: true }; },
}));

vi.mock('../../src/instance/dbLogin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/dbLogin')>()),
  resetManagerRoleCache: () => { h.events.push('reset-role-cache'); },
  sidecarRunning: async () => h.sidecar,
  ensureManagerDbRole: async () => { h.events.push('ensure'); return h.ensure; },
  readBotLogin: async () => {
    h.events.push('read');
    if (h.readFail) return { ok: false, cls: 'other', error: h.readFail };
    return { ok: true, login: { ...h.db, ...(h.readBlockedAfterOpen ? { canLogin: false } : {}) } };
  },
  blockBotLogin: async () => {
    if (h.blockThrow) throw new Error(h.blockThrow);
    h.events.push('block');
    if (h.block.ok) h.db.canLogin = false;
    return h.block;
  },
  endBotSessions: async () => { h.events.push('end-sessions'); h.db.sessions = 0; return { ok: true }; },
  openBotLogin: async () => { h.events.push('open'); h.db.canLogin = true; return { ok: true }; },
}));

vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  callAppHook: async (_inst: any, _action: string, _method: string, body: any) => {
    h.events.push(`hook:${body.state}`);
    return h.hook(body);
  },
}));

import {
  runMaintenanceOrder, orderMaintenance, requireMaintenance, maintenanceView, maintenanceStatus, reconcileMaintenance,
  resetMaintenanceState, setMaintenanceListener, getMaintenanceDrift, startMaintenanceReconciler, stopMaintenanceReconciler,
  MAINTENANCE_TIMING,
} from '../../src/instance/maintenance';

const SMDB = 'https://github.com/x/fully-modular-discord-bot';
const settled = (state: string, over: Record<string, unknown> = {}) => ({ state, message: 'old', orderedAt: '2026-10-01T00:00:00.000Z', settled: true, hook: 'confirmed', login: state === 'running' ? 'open' : 'blocked', savedByBot: state === 'running' ? 'running' : 'maintenance', ...over });

type Kind = 'database' | 'copy' | 'external' | 'json' | 'none';
function setup(kind: Kind, maintenance?: any): void {
  const base: any = { id: 'b1', displayName: 'B1', sourceUrl: SMDB, envVars: {}, createdAt: '2026-10-01T00:00:00.000Z' };
  let vars: Record<string, string> = { DATA_BACKEND: 'postgres' };
  if (kind === 'database') base.fleetDb = { containerName: 'b1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'v' };
  if (kind === 'copy') { base.fleetDbReplica = { containerName: 'b1-replica' }; vars = { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: 'postgresql://u:p@main.example.test:15432/smdb' }; }
  if (kind === 'external') vars = { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: 'postgresql://u:p@db.elsewhere.test:5432/smdb' };
  if (kind === 'json') vars = {};
  if (kind === 'none') { base.sourceUrl = 'https://github.com/x/plain-bot'; vars = {}; }
  if (maintenance) base.maintenance = maintenance;
  h.inst = base;
  h.env = { vars, undecryptable: [], encrypted: [], corrupt: false };
}

const HOOK_UNKNOWN = () => ({ ok: false, unknown: true, error: 'maintenance sent, no answer within 30 s' });
const HOOK_404 = () => ({ ok: false, status: 404, error: 'maintenance returned 404' });
const HOOK_REFUSED = () => ({ ok: false, status: 200, body: { success: false, error: 'busy' }, error: 'busy' });

let logs: string[] = [];
let errors: string[] = [];
let heard: { result: any; notify: boolean }[] = [];
beforeEach(() => {
  resetMaintenanceState();
  MAINTENANCE_TIMING.hookWaitMs = 30; MAINTENANCE_TIMING.hookWaitPauseMs = 1; MAINTENANCE_TIMING.hookWaitTryMs = 10;
  h.envCalls = 0; h.envThrowAt = 0; h.lock = null; h.busyFn = null; h.shutFn = null; h.passes = 0; h.hold = false; h.holdActions = [];
  h.app = true; h.appCalls = 0; h.appGate = null; h.appThrow = null; h.onApp = null; h.onLock = null;
  h.sidecar = true; h.stopKeepsDb = false; h.db = { inRecovery: false, canLogin: true, sessions: 1 }; h.readFail = null; h.readBlockedAfterOpen = false;
  h.ensure = { ok: true }; h.block = { ok: true }; h.blockThrow = null;
  h.hook = () => ({ ok: true, status: 200, body: { success: true } }); h.start = { success: true }; h.stop = { success: true };
  h.events = []; h.writes = []; h.failWrite = () => null; h.crashAt = null;
  setup('database');
  logs = []; errors = []; heard = [];
  setMaintenanceListener((_id, result, notify) => heard.push({ result, notify }));
  vi.spyOn(console, 'log').mockImplementation((m: unknown) => { logs.push(String(m)); });
  vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { logs.push(String(m)); });
  vi.spyOn(console, 'error').mockImplementation((m: unknown) => { errors.push(String(m)); });
});
afterEach(() => { stopMaintenanceReconciler(); setMaintenanceListener(null); vi.useRealTimers(); vi.restoreAllMocks(); });

const order = (to: string, message = 'Back soon') => runMaintenanceOrder('b1', to as any, message);
const retry = () => runMaintenanceOrder('b1', 'running', 'x', { retry: true });
const wait = async (cond: () => boolean) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise(r => setTimeout(r, 2)); };
const pass = async () => { await reconcileMaintenance(); await wait(() => !h.lock); };
const rec = () => h.inst.maintenance;

describe('the end of an order', () => {
  it('a start that answers the bot is already running counts as started', async () => {
    setup('none', settled('off', { hook: 'none', login: 'not-managed', savedByBot: null }));
    h.app = false;
    h.start = { success: false, error: 'Bot is already running' };
    const r = await order('running');
    expect(r).toEqual({ settled: true, text: 'The bot is running normally: it started.' });
  });
  it('a start that fails with no reason says so', async () => {
    setup('none', settled('off', { hook: 'none', login: 'not-managed', savedByBot: null }));
    h.app = false;
    h.start = { success: false };
    const r = await order('running');
    expect(r.text).toBe('Running is not confirmed: the bot did not start (no reason given). Start it, or choose Running again.');
  });
  it('a retry of Off whose stop leaves the database running claims no database stop', async () => {
    setup('database', settled('off', { settled: false, login: 'unconfirmed' }));
    h.db.canLogin = false; h.db.sessions = 0; h.stopKeepsDb = true;
    const r = await retry();
    expect(r).toEqual({ settled: true, text: "The bot is off: it is stopped, and its database keeps running for backups and copies with the bot's login blocked." });
  });
  it('a read-back failure after Running names the open login', async () => {
    setup('database', settled('maintenance'));
    h.db.canLogin = false; h.db.sessions = 0; h.readFail = 'no answer';
    const r = await order('running');
    expect(r.text).toBe("Running is not confirmed: the bot's database login could not be restored (the manager can't confirm the login is open: no answer). The bot answers with the maintenance message until it is. Choose Running again to retry.");
    expect(rec().login).toBe('unconfirmed');
  });
  it('a login that reads back blocked after Running is not confirmed', async () => {
    setup('database', settled('maintenance'));
    h.db.canLogin = false; h.db.sessions = 0; h.readBlockedAfterOpen = true;
    const r = await order('running');
    expect(r).toEqual({ settled: false, text: "Running is not confirmed: the bot's database login could not be restored (the login read back as blocked after it was restored). The bot answers with the maintenance message until it is. Choose Running again to retry." });
    expect(rec()).toMatchObject({ login: 'unconfirmed', settled: false });
  });
  it('a json order reads no database login', async () => {
    setup('json');
    h.db.canLogin = true;
    const r = await order('maintenance');
    expect(r.settled).toBe(true);
    expect(h.events).not.toContain('read');
  });
  it('a settled order clears the drift of the bot', async () => {
    setup('database', settled('running'));
    h.db.canLogin = false;
    await pass();
    expect(getMaintenanceDrift('b1')).not.toBeNull();
    h.db.canLogin = false; h.db.sessions = 0;
    await order('running');
    expect(getMaintenanceDrift('b1')).toBeNull();
  });
  it('a crash mid-order records the unexpected error, unsettled', async () => {
    setup('json');
    h.crashAt = 'stop';
    await expect(order('off')).rejects.toThrow('crash at stop');
    expect(rec()).toMatchObject({ state: 'off', settled: false, lastError: 'The order stopped on an unexpected error: crash at stop' });
  });
  it('a crash whose record write fails is logged', async () => {
    setup('json');
    h.crashAt = 'stop';
    h.failWrite = (_n, r) => (r?.lastError?.startsWith('The order stopped') ? 'disk full' : null);
    await expect(order('off')).rejects.toThrow('crash at stop');
    expect(errors).toContain('[Maintenance] b1: the unexpected error could not be recorded: disk full');
  });
  it('a busy bot answers the busy text, unsettled', async () => {
    h.lock = 'restore';
    expect(await order('maintenance')).toEqual({ settled: false, text: "Operation 'restore' already in progress" });
  });
});

describe('the notify flag of orders run again', () => {
  it('a resumed order that stays unsettled with the same error still notifies', async () => {
    setup('json');
    h.stop = { success: false, error: 'compose down failed' };
    await order('off');
    expect(rec().settled).toBe(false);
    await pass();
    await wait(() => heard.length > 0);
    expect(heard).toEqual([{ result: { settled: false, text: 'Off is not confirmed: the stop failed (compose down failed). Choose Off again to retry.' }, notify: true }]);
  });
  it('a resumed order with the same unsaved text as its order still notifies', async () => {
    setup('json');
    h.failWrite = (n) => (n >= 2 ? 'disk full' : null);
    const first = await order('maintenance');
    await pass();
    await wait(() => heard.length > 0);
    expect(heard).toEqual([{ result: first, notify: true }]);
  });
  it('a retry notifies an unsaved text again once a save went through between', async () => {
    setup('json', settled('maintenance', { settled: false, hook: 'unconfirmed', savedByBot: null }));
    h.hook = HOOK_REFUSED;
    h.failWrite = () => 'disk full';
    await pass();
    await wait(() => heard.length > 0);
    await pass();
    expect(heard.map(x => x.notify)).toEqual([true, false]);
    h.failWrite = () => null;
    await pass();
    h.failWrite = () => 'disk full';
    await pass();
    expect(heard.map(x => x.notify)).toEqual([true, false, true, true]);
  });
});

describe('the route entry', () => {
  it('a bot that is gone answers 404 without taking the op lock, even while a lane holds its id', async () => {
    let locked = 0;
    h.onLock = () => { locked++; };
    const NF = { accepted: false, status: 404, error: 'Bot not found' };
    expect(await orderMaintenance('gone', 'running', '', () => {})).toEqual(NF);
    h.busyFn = () => 'delete';
    expect(await orderMaintenance('gone', 'running', '', () => {})).toEqual(NF);
    expect(locked).toBe(0);
  });
  it('a message of exactly the limit is accepted', async () => {
    const results: any[] = [];
    expect(await orderMaintenance('b1', 'maintenance', 'x'.repeat(1500), r => results.push(r))).toEqual({ accepted: true });
    await wait(() => results.length > 0);
  });
  it('a crash before the order is recorded answers 500 with the error', async () => {
    h.appThrow = 'docker gone';
    const done: any[] = [];
    expect(await orderMaintenance('b1', 'maintenance', 'm', r => done.push(r))).toEqual({ accepted: false, status: 500, error: 'The order stopped on an unexpected error: docker gone' });
    expect(done).toEqual([]);
  });
  it('a crash before admission while another op took the bot answers busy', async () => {
    let n = 0;
    h.busyFn = () => (n++ === 0 ? null : 'restore');
    h.lock = null;
    h.onLock = () => { throw new Error('taken'); };
    expect(await orderMaintenance('b1', 'maintenance', 'm', () => {})).toEqual({ accepted: false, status: 409, error: "Operation 'restore' already in progress" });
  });
  it('a crash before admission while the bot shows this op answers 500', async () => {
    let n = 0;
    h.busyFn = () => (n++ === 0 ? null : 'maintenance');
    h.appThrow = 'docker gone';
    expect(await orderMaintenance('b1', 'maintenance', 'm', () => {})).toEqual({ accepted: false, status: 500, error: 'The order stopped on an unexpected error: docker gone' });
  });
  it('a crash after admission reaches onDone, unsettled', async () => {
    setup('json');
    h.crashAt = 'stop';
    const done: any[] = [];
    expect(await orderMaintenance('b1', 'off', 'm', r => done.push(r))).toEqual({ accepted: true });
    await wait(() => done.length > 0);
    expect(done).toEqual([{ settled: false, text: 'The order stopped on an unexpected error: crash at stop' }]);
  });
});

describe('requireMaintenance', () => {
  const req = (need: 'database' | 'any') => requireMaintenance('b1', need);
  beforeEach(() => { h.lock = 'backup'; });
  it('no bot', async () => {
    h.inst = null;
    expect(await req('any')).toEqual({ ok: false, error: 'Bot not found' });
  });
  it('an unsettled record with no error names the unfinished order', async () => {
    setup('json', settled('maintenance', { settled: false }));
    expect(await req('any')).toEqual({ ok: false, error: "The bot's change to Maintenance is not confirmed yet (the order has not finished), so it does not count as maintenance" });
  });
  it('a database with no bot role', async () => {
    setup('database', settled('maintenance'));
    h.db = { inRecovery: false, canLogin: null, sessions: 0 };
    expect(await req('database')).toEqual({ ok: false, error: "The manager can't confirm the bot's database login is blocked: the role smdb does not exist" });
  });
  it('a database bot whose hook is not confirmed is not bot-confirmed', async () => {
    setup('database', settled('maintenance', { hook: 'unconfirmed' }));
    h.db = { inRecovery: false, canLogin: false, sessions: 0 };
    expect(await req('database')).toEqual({ ok: true, state: 'maintenance', enforcement: 'database', botConfirmed: false });
  });
  it('a plain bot with no database needs a database: files', async () => {
    setup('none', settled('maintenance', { hook: 'none', login: 'not-managed', savedByBot: null }));
    expect(await req('database')).toEqual({ ok: false, error: 'This bot keeps its data in files, so the manager cannot hold its database in maintenance' });
  });
  it('a bot with no hooks on a postgres it does not run: not run by this manager', async () => {
    setup('none', settled('maintenance', { hook: 'none', login: 'not-managed', savedByBot: null }));
    h.inst.sourceUrl = NOHOOKS_URL;
    h.env.vars = { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: 'postgresql://u:p@db.elsewhere.test:5432/smdb' };
    expect(await req('database')).toEqual({ ok: false, error: "The bot's database is not run by this manager, so this manager cannot confirm its login is blocked" });
  });
  it('a json bot whose backend key cannot be decrypted keeps its data in files', async () => {
    setup('json', settled('maintenance'));
    h.inst.envVars = { DATA_BACKEND: 'postgres' };
    h.env.undecryptable = ['DATA_BACKEND'];
    expect(await req('database')).toEqual({ ok: false, error: 'This bot keeps its data in files, so the manager cannot hold its database in maintenance' });
  });
  it('a bot with no hooks whose backend is only in its record: not run by this manager', async () => {
    setup('none', settled('maintenance', { hook: 'none', login: 'not-managed', savedByBot: null }));
    h.inst.sourceUrl = NOHOOKS_URL;
    h.inst.envVars = { DATA_BACKEND: 'postgres' };
    h.env.vars = {};
    expect(await req('database')).toEqual({ ok: false, error: "The bot's database is not run by this manager, so this manager cannot confirm its login is blocked" });
  });
  it('a bot with no hooks whose env store fails on the second read keeps its data in files', async () => {
    setup('none', settled('maintenance', { hook: 'none', login: 'not-managed', savedByBot: null }));
    h.inst.sourceUrl = NOHOOKS_URL;
    h.envThrowAt = 2;
    expect(await req('database')).toEqual({ ok: false, error: 'This bot keeps its data in files, so the manager cannot hold its database in maintenance' });
  });
  it('a json bot Off whose hook is not confirmed is not bot-confirmed', async () => {
    setup('json', settled('off', { hook: 'unconfirmed' }));
    h.app = false;
    expect(await req('any')).toEqual({ ok: true, state: 'off', enforcement: 'stopped', botConfirmed: false });
  });
  it('a json bot whose hook is 404 names the missing hook', async () => {
    setup('json', settled('maintenance'));
    h.hook = HOOK_404;
    expect(await req('any')).toEqual({ ok: false, error: 'The bot did not confirm it is in maintenance (its build has no maintenance hook)' });
  });
});

describe('the state line', () => {
  const m = (over: Record<string, unknown> = {}) => settled('maintenance', over) as any;
  const live = (login: Record<string, unknown>) => ({ ok: true as const, login: { inRecovery: false, canLogin: false, sessions: 0, ...login } as any });
  it('unsettled with no error', () => {
    expect(maintenanceView(m({ settled: false }), 'json', null)).toBe('State: Maintenance, not confirmed: the order has not finished');
  });
  it('database in recovery', () => {
    expect(maintenanceView(m(), 'database', null, live({ inRecovery: true }))).toBe("State: Maintenance. The manager can't confirm the database login is blocked: the database is a live copy in recovery.");
  });
  it('database role missing', () => {
    expect(maintenanceView(m(), 'database', null, live({ canLogin: null }))).toBe("State: Maintenance. The manager can't confirm the database login is blocked: the bot's database role does not exist.");
  });
  it('database sessions open', () => {
    expect(maintenanceView(m(), 'database', null, live({ sessions: 2 }))).toBe("State: Maintenance. The manager can't confirm the database login is blocked: 2 session(s) of the bot's role are still open.");
  });
  it('database off and blocked', () => {
    expect(maintenanceView(settled('off') as any, 'database', null, live({}))).toBe('State: Off. The bot is stopped, and its database login is blocked with none of its sessions open.');
  });
  it('json off', () => {
    expect(maintenanceView(settled('off') as any, 'json', null)).toBe('State: Off. The bot is stopped.');
  });
  it('copy, external and json maintenance tails', () => {
    expect(maintenanceView(m(), 'copy', null)).toBe("State: Maintenance, through the bot's own answer. Its database login is not blocked from here: this machine holds a live copy, and only the main's manager can block it.");
    expect(maintenanceView(m(), 'json', null)).toBe("State: Maintenance, through the bot's own answer.");
  });
  it('a running database bot gets no live read', async () => {
    setup('database', settled('running'));
    const s = await maintenanceStatus(h.inst, null);
    expect(s.summary).toBe('State: Running.');
    expect(h.events).not.toContain('read');
  });
  it('docker does not say whether the database runs', async () => {
    setup('database', settled('maintenance'));
    h.sidecar = null;
    expect((await maintenanceStatus(h.inst, null)).summary).toBe("State: Maintenance. The manager can't confirm the database login is blocked: docker did not say whether the database runs.");
  });
});

describe('the reconciler', () => {
  it('a fresh module runs its first pass as a resumed order', async () => {
    vi.resetModules();
    const fresh = await import('../../src/instance/maintenance');
    setup('json', settled('off', { settled: false }));
    await fresh.reconcileMaintenance();
    await wait(() => !h.lock);
    expect(logs).toContain('[Maintenance] B1: the manager restarted before the order Off of 2026-10-01T00:00:00.000Z was confirmed; running it again');
  });
  it('reset clears the drift and the role cache', async () => {
    setup('database', settled('running'));
    h.db.canLogin = false;
    await pass();
    h.events = [];
    resetMaintenanceState();
    expect(getMaintenanceDrift('b1')).toBeNull();
    expect(h.events).toContain('reset-role-cache');
  });
  it('reset forgets the logged drift: the next drift is logged again', async () => {
    setup('database', settled('running'));
    h.db.canLogin = false;
    await pass();
    resetMaintenanceState();
    await pass();
    expect(logs.filter(l => l.includes('blocked while its state is Running')).length).toBe(2);
  });
  it('reset forgets the unsaved text: the next retry notifies', async () => {
    setup('json', settled('maintenance', { settled: false, hook: 'unconfirmed', savedByBot: null }));
    h.hook = HOOK_REFUSED;
    h.failWrite = () => 'disk full';
    await pass();
    await wait(() => heard.length > 0);
    await pass();
    resetMaintenanceState();
    h.hold = true;
    await pass();
    h.hold = false;
    await pass();
    expect(heard.map(x => x.notify)).toEqual([true, false, true]);
  });
  it('a drift cleared then found again is logged again', async () => {
    setup('database', settled('running'));
    h.db.canLogin = false;
    await pass();
    h.db.canLogin = true;
    await pass();
    h.db.canLogin = false;
    await pass();
    expect(logs.filter(l => l.includes('blocked while its state is Running')).length).toBe(2);
  });
  it('a failed rerun is logged', async () => {
    setup('json', settled('off', { settled: false }));
    h.crashAt = 'stop';
    await pass();
    await wait(() => errors.length > 0);
    expect(errors).toContain('[Maintenance] B1: running the order Off again failed: crash at stop');
  });
  it('the hold check names the maintenance check', async () => {
    await pass();
    expect(h.holdActions).toContain('the maintenance check');
  });
  it('Off with no answer from docker keeps the drift', async () => {
    setup('json', settled('off'));
    await pass();
    expect(getMaintenanceDrift('b1')).toBe('The state is Off, but the bot runs (it was started outside the manager). Choose Off in State to stop it, or Running.');
    h.app = null;
    await pass();
    expect(getMaintenanceDrift('b1')).toBe('The state is Off, but the bot runs (it was started outside the manager). Choose Off in State to stop it, or Running.');
  });
  it('the first pass with the sidecar down makes no manager role', async () => {
    h.sidecar = false;
    await pass();
    expect(h.events).not.toContain('ensure');
  });
  it('a running drift is logged once while the app is stopped', async () => {
    setup('database', settled('running'));
    h.db.canLogin = false; h.app = false;
    await pass();
    await pass();
    expect(logs.filter(l => l.includes('blocked while its state is Running')).length).toBe(1);
  });
  it('no hook retry while the app is stopped', async () => {
    setup('json', settled('maintenance', { hook: 'unconfirmed', savedByBot: null }));
    h.app = false;
    await pass();
    expect(h.events.filter(e => e.startsWith('hook'))).toEqual([]);
  });
  it('no hook retry for Off', async () => {
    setup('json', settled('off', { hook: 'unconfirmed', savedByBot: null }));
    await pass();
    expect(h.events.filter(e => e.startsWith('hook'))).toEqual([]);
  });
  it('no hook retry when the state changed before the lock', async () => {
    setup('json', settled('maintenance', { hook: 'unconfirmed', savedByBot: null }));
    h.onApp = () => { h.inst.maintenance = settled('running', { hook: 'unconfirmed', savedByBot: null }); };
    await pass();
    expect(h.events.filter(e => e.startsWith('hook'))).toEqual([]);
  });
  it('no hook retry when the hook was confirmed before the lock', async () => {
    setup('json', settled('maintenance', { hook: 'unconfirmed', savedByBot: null }));
    h.onApp = () => { h.inst.maintenance = settled('maintenance'); };
    await pass();
    expect(h.events.filter(e => e.startsWith('hook'))).toEqual([]);
  });
  it('no hook retry when the pass read a confirmed hook', async () => {
    setup('json', settled('maintenance'));
    h.onApp = () => { h.inst.maintenance = settled('maintenance', { hook: 'unconfirmed', savedByBot: null }); };
    await pass();
    expect(h.events.filter(e => e.startsWith('hook'))).toEqual([]);
  });
  it('a hook retry with no answer writes nothing', async () => {
    setup('json', settled('maintenance', { hook: 'unconfirmed', savedByBot: null }));
    h.hook = HOOK_UNKNOWN;
    await pass();
    expect(h.events).toContain('hook:maintenance');
    expect(h.writes).toEqual([]);
  });
  it('a hook retry answered 404 records missing, keeps the error and logs nothing', async () => {
    setup('json', settled('maintenance', { hook: 'unconfirmed', savedByBot: null, lastError: 'the bot did not take the message (busy)' }));
    h.hook = HOOK_404;
    await pass();
    expect(rec()).toEqual(settled('maintenance', { hook: 'missing', savedByBot: null, lastError: 'the bot did not take the message (busy)' }));
    expect(logs.filter(l => l.includes('on a retry'))).toEqual([]);
  });
  it('a confirmed hook retry drops the take-the-message error', async () => {
    setup('json', settled('maintenance', { hook: 'unconfirmed', savedByBot: null, lastError: 'the bot did not take the message (busy)' }));
    await pass();
    expect(rec()).toEqual(settled('maintenance'));
  });
  it('a confirmed hook retry keeps another error', async () => {
    setup('json', settled('maintenance', { hook: 'unconfirmed', savedByBot: null, lastError: 'something else' }));
    await pass();
    expect(rec()).toEqual(settled('maintenance', { lastError: 'something else' }));
  });
  it('a hook retry whose write fails is logged', async () => {
    setup('json', settled('maintenance', { hook: 'unconfirmed', savedByBot: null }));
    h.failWrite = () => 'disk full';
    await pass();
    expect(errors).toContain('[Maintenance] B1: the hook retry failed: disk full');
  });
  it('no login read while the sidecar is down', async () => {
    await pass();
    h.sidecar = false; h.events = [];
    await pass();
    expect(h.events).not.toContain('read');
  });
  it('a running drift stays when the role does not exist', async () => {
    setup('database', settled('running'));
    h.db.canLogin = false;
    await pass();
    h.db.canLogin = null;
    await pass();
    expect(getMaintenanceDrift('b1')).not.toBeNull();
  });
  it('maintenance with the login blocked: nothing is blocked again', async () => {
    h.inst.maintenance = settled('maintenance');
    h.db.canLogin = false;
    await pass();
    expect(h.events).not.toContain('block');
  });
  it('maintenance whose state turned Running under the lock: nothing is blocked', async () => {
    h.inst.maintenance = settled('maintenance');
    h.db.canLogin = true;
    await pass();
    h.events = [];
    h.db.canLogin = true;
    h.onLock = () => { h.inst.maintenance = settled('running'); };
    await pass();
    expect(h.events).not.toContain('block');
  });
  it('the manager role fails: nothing is blocked', async () => {
    h.inst.maintenance = settled('maintenance');
    h.db.canLogin = true;
    h.ensure = { ok: false, error: 'x' };
    await pass();
    expect(h.events).not.toContain('block');
  });
  it('the block fails: no sessions ended, nothing logged', async () => {
    h.inst.maintenance = settled('maintenance');
    h.db.canLogin = true;
    h.block = { ok: false, error: 'x' };
    await pass();
    expect(h.events).not.toContain('end-sessions');
    expect(logs.filter(l => l.includes('blocked it again'))).toEqual([]);
  });
  it('a block that throws is logged', async () => {
    h.inst.maintenance = settled('maintenance');
    h.db.canLogin = true;
    h.blockThrow = 'pg gone';
    await pass();
    expect(errors).toContain('[Maintenance] B1: blocking the login again failed: pg gone');
  });
  it('a second pass while the first waits on docker does nothing', async () => {
    let release!: () => void;
    h.appGate = new Promise<void>(r => { release = r; });
    const first = reconcileMaintenance();
    await new Promise(r => setTimeout(r, 5));
    await reconcileMaintenance();
    expect(h.appCalls).toBe(1);
    release();
    await first;
  });
  it('a shutdown that starts during the pass skips the bot', async () => {
    let n = 0;
    h.shutFn = () => n++ > 0;
    await pass();
    expect(h.appCalls).toBe(0);
  });
  it('a bot whose check throws is logged', async () => {
    h.appThrow = 'docker gone';
    await pass();
    expect(errors).toContain('[Maintenance] B1: the state check failed: docker gone');
  });
  it('a second start makes no second timer; stop ends the timer', async () => {
    vi.useFakeTimers();
    setup('json', settled('running'));
    startMaintenanceReconciler();
    startMaintenanceReconciler();
    await vi.advanceTimersByTimeAsync(1);
    stopMaintenanceReconciler();
    const n = h.passes;
    await vi.advanceTimersByTimeAsync(MAINTENANCE_TIMING.reconcileMs * 3);
    expect(h.passes).toBe(n);
  });
  it('a timer with no unref starts', () => {
    vi.spyOn(globalThis, 'setInterval').mockReturnValue({} as any);
    expect(() => startMaintenanceReconciler()).not.toThrow();
  });
});
