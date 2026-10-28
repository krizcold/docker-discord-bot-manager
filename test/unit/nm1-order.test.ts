import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const s = {
    inst: null as any,
    env: { vars: {} as Record<string, string>, undecryptable: [] as string[], encrypted: [] as string[], corrupt: false },
    lock: null as string | null,
    hold: false,
    deleteLane: false,
    app: true as boolean | null,
    appAfterStart: true,
    sidecar: true as boolean | null,
    db: { inRecovery: false, canLogin: true as boolean | null, sessions: 1 },
    readFail: null as string | null,
    readOpenAfterBlock: false,
    dbUp: { success: true } as { success: boolean; error?: string },
    dbUpCalls: 0,
    ensure: { ok: true } as any,
    block: { ok: true } as any,
    end: { ok: true } as any,
    open: { ok: true } as any,
    hook: (_body: any): any => ({ ok: true, status: 200, body: { success: true } }),
    hookBodies: [] as any[],
    start: { success: true } as { success: boolean; error?: string },
    stop: { success: true } as { success: boolean; error?: string },
    events: [] as string[],
    writes: [] as any[],
    failWrite: (_n: number, _rec: any): string | null => null,
    crashAt: null as string | null,
  };
  return s;
});

vi.mock('../../src/env/manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/env/manager')>()),
  getEnvVarsWithStatus: () => h.env,
}));

const crash = (step: string) => { if (h.crashAt === step) { h.crashAt = null; throw new Error(`crash at ${step}`); } };

vi.mock('../../src/docker/containerManager', () => ({
  SHUTDOWN_REFUSAL: 'shutting down',
  isShuttingDown: () => false,
  registryFault: () => null,
  getBot: (id: string) => (h.inst && h.inst.id === id ? JSON.parse(JSON.stringify(h.inst)) : null),
  getAllBots: () => (h.inst ? [JSON.parse(JSON.stringify(h.inst))] : []),
  isBotBusy: () => h.lock,
  databaseHoldRefusal: (_id: string, action: string) => (h.hold ? { success: false, error: `A database restore is running on this instance's database; ${action} is refused until it ends` } : null),
  deleteLaneRefusal: (_id: string, action: string) => (h.deleteLane ? { success: false, error: `A Delete of this instance did not finish, so its containers, image or compose may already be gone; ${action} is refused until Delete is run again` } : null),
  updateInstanceMaintenance: (_id: string, rec: any) => {
    const n = h.writes.length + 1;
    const err = h.failWrite(n, rec);
    if (err) throw new Error(err);
    h.writes.push(rec ? JSON.parse(JSON.stringify(rec)) : null);
    if (rec) h.inst.maintenance = JSON.parse(JSON.stringify(rec));
    else delete h.inst.maintenance;
  },
  withExternalBotOp: async (_id: string, op: string, fn: () => Promise<unknown>) => {
    if (h.lock) throw new Error(`Operation '${h.lock}' is already in progress for this bot`);
    h.lock = op;
    try { return await fn(); } finally { h.lock = null; }
  },
  appContainerRunning: async () => h.app,
  startBotInOp: async (_id: string, op: string) => {
    crash('start');
    h.events.push(`start:${op}`);
    if (h.start.success) h.app = h.appAfterStart;
    return h.start;
  },
  stopBotInOp: async (_id: string, op: string) => {
    crash('stop');
    h.events.push(`stop:${op}`);
    if (h.stop.success) { h.app = false; h.sidecar = false; }
    return h.stop;
  },
  startFleetDbSidecar: async () => {
    crash('db-up');
    h.dbUpCalls++;
    h.events.push('db-up');
    if (h.dbUp.success) h.sidecar = true;
    return h.dbUp;
  },
}));

vi.mock('../../src/instance/dbLogin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/dbLogin')>()),
  readWriteFence: async () => ({ ok: true, on: false }),
  sidecarRunning: async () => h.sidecar,
  ensureManagerDbRole: async () => { h.events.push('ensure'); return h.ensure; },
  readBotLogin: async () => (h.readFail ? { ok: false, cls: 'other', error: h.readFail } : { ok: true, login: { ...h.db } }),
  blockBotLogin: async () => {
    crash('block');
    h.events.push('block');
    if (h.block.ok) h.db.canLogin = h.readOpenAfterBlock ? true : false;
    return h.block;
  },
  endBotSessions: async () => {
    crash('end-sessions');
    h.events.push('end-sessions');
    if (h.end.ok) h.db.sessions = 0;
    return h.end;
  },
  openBotLogin: async () => {
    crash('open');
    h.events.push('open');
    if (h.open.ok) h.db.canLogin = true;
    return h.open;
  },
}));

vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  callAppHook: async (_inst: any, action: string, method: string, body: any, timeout: number) => {
    crash('hook');
    h.events.push(`hook:${body.state}`);
    h.hookBodies.push({ action, method, body, timeout });
    return h.hook(body);
  },
}));

import { runMaintenanceOrder, orderMaintenance, reconcileMaintenance, resetMaintenanceState, MAINTENANCE_TIMING } from '../../src/instance/maintenance';

const SMDB = 'https://github.com/x/fully-modular-discord-bot';
const fleetDb = { containerName: 'b1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'v' };
const settled = (state: string, over: Record<string, unknown> = {}) => ({ state, message: 'old', orderedAt: '2026-10-01T00:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: state === 'running' ? 'running' : 'maintenance', ...over });

type Kind = 'database' | 'copy' | 'external' | 'json' | 'none';
function setup(kind: Kind, maintenance?: any): void {
  const base: any = { id: 'b1', displayName: 'B1', sourceUrl: SMDB, envVars: {}, createdAt: '2026-10-01T00:00:00.000Z', status: 'running' };
  let vars: Record<string, string> = { DATA_BACKEND: 'postgres' };
  if (kind === 'database') base.fleetDb = { ...fleetDb };
  if (kind === 'copy') { base.fleetDbReplica = { containerName: 'b1-replica' }; vars = { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: 'postgresql://u:p@main.example.test:15432/smdb' }; }
  if (kind === 'external') vars = { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: 'postgresql://u:p@db.elsewhere.test:5432/smdb' };
  if (kind === 'json') vars = {};
  if (kind === 'none') { base.sourceUrl = 'https://github.com/x/plain-bot'; vars = {}; }
  if (maintenance) base.maintenance = maintenance;
  h.inst = base;
  h.env = { vars, undecryptable: [], encrypted: [], corrupt: false };
}

const HOOK_OK = () => ({ ok: true, status: 200, body: { success: true } });
const HOOK_UNKNOWN = () => ({ ok: false, unknown: true, error: 'maintenance sent, no answer within 30 s' });
const HOOK_UNREACHABLE = () => ({ ok: false, error: 'maintenance unreachable: fetch failed' });
const HOOK_404 = () => ({ ok: false, status: 404, error: 'maintenance returned 404' });
const HOOK_REFUSED = () => ({ ok: false, status: 200, body: { success: false, error: 'busy' }, error: 'busy' });

beforeEach(() => {
  resetMaintenanceState();
  MAINTENANCE_TIMING.hookWaitMs = 30;
  MAINTENANCE_TIMING.hookWaitPauseMs = 1;
  MAINTENANCE_TIMING.hookWaitTryMs = 10;
  h.lock = null; h.hold = false; h.deleteLane = false; h.app = true; h.appAfterStart = true; h.sidecar = true;
  h.db = { inRecovery: false, canLogin: true, sessions: 1 }; h.readFail = null; h.readOpenAfterBlock = false;
  h.dbUp = { success: true }; h.dbUpCalls = 0; h.ensure = { ok: true }; h.block = { ok: true }; h.end = { ok: true }; h.open = { ok: true };
  h.hook = HOOK_OK; h.hookBodies = []; h.start = { success: true }; h.stop = { success: true };
  h.events = []; h.writes = []; h.failWrite = () => null; h.crashAt = null;
  setup('database');
});

const rec = () => h.inst.maintenance;
const order = (to: string, message = 'Back soon') => runMaintenanceOrder('b1', to as any, message);

const S_M_DB = 'Maintenance is on: the bot took the message, and its database login is blocked with no session open.';
const NOHOOK = (reason: string) => `Maintenance is on: the bot's database login is blocked with no session open. The bot did not take the message (${reason}), so it answers with the last message it saved or its default text; the manager sends the message again every 30 seconds while the bot runs.`;
const F_M_DB = (reason: string, clause = 'The bot took the message. ') => `Maintenance is not confirmed: ${reason}. ${clause}Choose Maintenance again to retry.`;
const NOT_RECORDED = (err: string) => ` The manager could not record this (${err}); the record still holds the order as not confirmed, so the manager runs it again within 30 seconds, except that a retry never starts the bot or its database.`;

describe('the hook body is exactly { state, message } (contract 1)', () => {
  it('Maintenance sends state maintenance and the message, POST, 30 s', async () => {
    await order('maintenance', 'Upgrading');
    expect(h.hookBodies).toEqual([{ action: 'maintenance', method: 'POST', body: { state: 'maintenance', message: 'Upgrading' }, timeout: 30_000 }]);
  });
  it('Off sends state maintenance', async () => {
    await order('off', 'Gone');
    expect(h.hookBodies[0].body).toEqual({ state: 'maintenance', message: 'Gone' });
  });
  it('Running sends state running', async () => {
    setup('database', settled('maintenance'));
    h.db.canLogin = false; h.db.sessions = 0;
    await order('running', '');
    expect(h.hookBodies[0].body).toEqual({ state: 'running', message: '' });
  });
});

describe('order Maintenance, kind database', () => {
  it('M1 every step ok', async () => {
    const r = await order('maintenance');
    expect(r).toEqual({ settled: true, text: S_M_DB });
    expect(h.events).toEqual(['hook:maintenance', 'ensure', 'block', 'end-sessions']);
    expect(rec()).toMatchObject({ state: 'maintenance', message: 'Back soon', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: 'maintenance' });
    expect(rec().lastError).toBeUndefined();
    expect(h.writes[0]).toMatchObject({ state: 'maintenance', settled: false, hook: 'unconfirmed', login: 'unconfirmed' });
  });
  it('M2 W1 throws: nothing changed, R12', async () => {
    h.failWrite = (n) => (n === 1 ? 'disk full' : null);
    const r = await order('maintenance');
    expect(r.text).toBe('The state change was not recorded, so nothing was changed: disk full');
    expect(r.settled).toBe(false);
    expect(h.events).toEqual([]);
    expect(rec()).toBeUndefined();
  });
  it('M3 hook times out', async () => {
    h.hook = HOOK_UNKNOWN;
    const r = await order('maintenance');
    expect(r).toEqual({ settled: true, text: NOHOOK('no answer within 30 seconds') });
    expect(rec()).toMatchObject({ settled: true, hook: 'unconfirmed', login: 'blocked' });
    expect(h.events).toContain('block');
  });
  it('M4 hook unreachable', async () => {
    h.hook = HOOK_UNREACHABLE;
    const r = await order('maintenance');
    expect(r).toEqual({ settled: true, text: NOHOOK('the bot could not be reached: maintenance unreachable: fetch failed') });
  });
  it('M5 hook 404', async () => {
    h.hook = HOOK_404;
    const r = await order('maintenance');
    expect(r).toEqual({ settled: true, text: "Maintenance is on: the bot's database login is blocked with no session open. This bot's build has no maintenance hook (it answered 404), so it cannot show the message; update the bot to a build that has one." });
    expect(rec()).toMatchObject({ settled: true, hook: 'missing' });
  });
  it('M6 hook success false', async () => {
    h.hook = HOOK_REFUSED;
    const r = await order('maintenance');
    expect(r).toEqual({ settled: true, text: NOHOOK('the bot answered: busy') });
    expect(rec()).toMatchObject({ settled: true, hook: 'unconfirmed', savedByBot: null });
  });
  it('M7 sidecar down, starts', async () => {
    h.sidecar = false;
    const r = await order('maintenance');
    expect(r).toEqual({ settled: true, text: S_M_DB });
    expect(h.dbUpCalls).toBe(1);
  });
  it('M8 sidecar does not start', async () => {
    h.sidecar = false; h.dbUp = { success: false, error: 'compose failed' };
    const r = await order('maintenance');
    expect(r).toEqual({ settled: false, text: F_M_DB('the database did not start (compose failed)') });
    expect(rec()).toMatchObject({ settled: false, login: 'unconfirmed' });
    expect(rec().lastError).toBe('the database did not start (compose failed)');
    expect(h.events).not.toContain('block');
  });
  it('M9 dbm_admin missing and cannot be created', async () => {
    h.ensure = { ok: false, cls: 'refused-login', error: 'FATAL:  role "smdb" is not permitted to log in' };
    const r = await order('maintenance');
    expect(r.text).toBe(F_M_DB("the manager's database role dbm_admin could not be created (FATAL:  role \"smdb\" is not permitted to log in)"));
    expect(r.settled).toBe(false);
  });
  it('M10 database in recovery', async () => {
    h.block = { ok: false, cls: 'recovery', error: 'in recovery' };
    const r = await order('maintenance');
    expect(r.text).toBe(F_M_DB("the database is a live copy in recovery, so its login cannot be blocked on this machine; block it from the main's manager"));
  });
  it('M11 ALTER ROLE fails', async () => {
    h.block = { ok: false, cls: 'other', error: 'ERROR:  permission denied' };
    const r = await order('maintenance');
    expect(r.text).toBe(F_M_DB('the database login could not be blocked (ERROR:  permission denied)'));
    expect(h.events).not.toContain('end-sessions');
  });
  it('M12 sessions left after 3 rounds', async () => {
    h.end = { ok: false, left: 2, error: '2 sessions left' };
    const r = await order('maintenance');
    expect(r.text).toBe(F_M_DB("2 session(s) of the bot's database role were still open after three attempts to end them"));
    expect(r.settled).toBe(false);
  });
  it('M13 read-back fails', async () => {
    h.readFail = 'docker: no answer';
    const r = await order('maintenance');
    expect(h.events).toContain('end-sessions');
    expect(r.text).toBe(F_M_DB("the manager can't confirm the login is blocked: docker: no answer"));
    expect(r.settled).toBe(false);
    expect(rec().login).toBe('unconfirmed');
  });
  it('M14 read-back shows the login open', async () => {
    h.readOpenAfterBlock = true;
    const r = await order('maintenance');
    expect(r.text).toBe(F_M_DB('the login read back as open after it was blocked'));
    expect(r.settled).toBe(false);
  });
  it('M15 the settle write throws', async () => {
    h.failWrite = (_n, r) => (r?.settled ? 'disk full' : null);
    const r = await order('maintenance');
    expect(r).toEqual({ settled: false, text: S_M_DB + NOT_RECORDED('disk full') });
    expect(rec()).toMatchObject({ state: 'maintenance', settled: false });
  });
  it('M20 app stopped (not Off)', async () => {
    h.app = false;
    const r = await order('maintenance');
    expect(r).toEqual({ settled: true, text: "Maintenance is on: the bot's database login is blocked. The bot is stopped; it takes the message when it next runs." });
    expect(rec()).toMatchObject({ settled: true, hook: 'unconfirmed', login: 'blocked' });
    expect(h.events).not.toContain('hook:maintenance');
  });
  it('M21 another order while one runs: R4', async () => {
    h.lock = 'start';
    const a = await orderMaintenance('b1', 'maintenance', '', () => {});
    expect(a).toEqual({ accepted: false, status: 409, error: "Operation 'start' already in progress" });
    expect(h.writes).toEqual([]);
  });
  it('M22 Maintenance again with a new message', async () => {
    await order('maintenance', 'first');
    h.hookBodies = [];
    const r = await order('maintenance', 'second');
    expect(r).toEqual({ settled: true, text: S_M_DB });
    expect(h.hookBodies[0].body).toEqual({ state: 'maintenance', message: 'second' });
    expect(rec().message).toBe('second');
  });
  it('M24 docker does not answer whether the app runs: R11', async () => {
    h.app = null;
    const a = await orderMaintenance('b1', 'maintenance', '', () => {});
    expect(a).toEqual({ accepted: false, status: 409, error: 'Docker did not say whether the bot is running, so nothing was changed; retry in a moment' });
    expect(h.writes).toEqual([]);
  });
  it('M25 from Off: db-up, block, start, hook-wait ok', async () => {
    setup('database', settled('off', { hook: 'none' }));
    h.app = false; h.sidecar = false;
    const r = await order('maintenance');
    expect(r).toEqual({ settled: true, text: 'Maintenance is on: the bot started and took the message, and its database login is blocked with no session open.' });
    expect(h.events.filter(e => e !== 'ensure')).toEqual(['db-up', 'block', 'end-sessions', 'start:maintenance', 'hook:maintenance']);
    expect(rec()).toMatchObject({ settled: true, hook: 'confirmed', prior: { state: 'off', message: 'old' } });
  });
  it('M26 from Off: start fails', async () => {
    setup('database', settled('off'));
    h.app = false; h.start = { success: false, error: 'image missing' };
    const r = await order('maintenance');
    expect(r).toEqual({ settled: false, text: 'Maintenance is not confirmed: the bot did not start (image missing). Its database login is blocked, so it cannot write. Choose Maintenance again to retry.' });
    expect(rec()).toMatchObject({ settled: false, login: 'blocked' });
  });
  it('M27 from Off: hook-wait ends with no answer', async () => {
    setup('database', settled('off'));
    h.app = false; h.hook = HOOK_UNKNOWN;
    MAINTENANCE_TIMING.hookWaitMs = 2000;
    const r = await order('maintenance');
    expect(r).toEqual({ settled: true, text: NOHOOK('no answer within 2 seconds of the start') });
    expect(rec()).toMatchObject({ settled: true, hook: 'unconfirmed' });
    expect(h.hookBodies.length).toBeGreaterThan(1);
  });
  it('M28 a database lane hold: R5', async () => {
    h.hold = true;
    const a = await orderMaintenance('b1', 'maintenance', '', () => {});
    expect(a).toEqual({ accepted: false, status: 409, error: "A database restore is running on this instance's database; the state change is refused until it ends" });
  });
  it('M29 delete lane unfinished: R6', async () => {
    h.deleteLane = true;
    const a = await orderMaintenance('b1', 'maintenance', '', () => {});
    expect(a).toEqual({ accepted: false, status: 409, error: 'A Delete of this instance did not finish, so its containers, image or compose may already be gone; a state change is refused until Delete is run again' });
  });
  it('M30 the bot role name is refused: R14', async () => {
    h.inst.fleetDb.user = 'Bad';
    const a = await orderMaintenance('b1', 'maintenance', '', () => {});
    expect(a).toEqual({ accepted: false, status: 409, error: "The app's database role name Bad cannot be used by the maintenance tool (it must be a plain lower-case name other than dbm_admin and replicator); nothing was changed" });
  });
});

describe('crash cells: the order is cut, then the first reconciler pass runs it again', () => {
  const resume = async () => {
    h.lock = null;
    await reconcileMaintenance();
    for (let i = 0; i < 50 && (h.lock || !rec()?.settled); i++) await new Promise(r => setTimeout(r, 2));
  };
  it.each([
    ['M16 after W1, before the hook', 'hook'],
    ['M17 after the hook, before its write', 'hook-write'],
    ['M18 after ALTER, before end-sessions', 'end-sessions'],
    ['M19 after end-sessions, before the settle write', 'settle-write'],
  ])('%s', async (_n, at) => {
    if (at === 'hook-write') h.failWrite = (n) => (n === 2 ? 'killed' : null);
    else if (at === 'settle-write') h.failWrite = (_n2, r) => (r?.settled ? 'killed' : null);
    else h.crashAt = at;
    await order('maintenance').catch(() => null);
    expect(rec().settled).toBe(false);
    h.failWrite = () => null;
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((m: string) => { logs.push(String(m)); });
    const warn = vi.spyOn(console, 'warn').mockImplementation((m: string) => { logs.push(String(m)); });
    await resume();
    spy.mockRestore(); warn.mockRestore();
    expect(rec()).toMatchObject({ state: 'maintenance', settled: true, hook: 'confirmed', login: 'blocked' });
    expect(logs.some(l => /^\[Maintenance\] B1: the manager restarted before the order Maintenance of .+ was confirmed; running it again$/.test(l))).toBe(true);
  });
  it('O6 after the stop, before db-up-alone', async () => {
    // The sidecar runs, so the first start of it is db-up-alone, after the stop took the project down.
    h.crashAt = 'db-up';
    await order('off').catch(() => null);
    expect(h.events).toContain('stop:maintenance');
    expect(rec()).toMatchObject({ state: 'off', settled: false });
    h.events = [];
    await resume();
    expect(rec()).toMatchObject({ state: 'off', settled: true, login: 'blocked' });
    expect(h.events).toContain('db-up');
  });
  it('R8 after open, before start', async () => {
    setup('database', settled('off'));
    h.app = false; h.db.canLogin = false; h.db.sessions = 0;
    h.crashAt = 'start';
    await order('running').catch(() => null);
    expect(rec()).toMatchObject({ state: 'running', settled: false });
    h.events = [];
    await resume();
    expect(rec()).toMatchObject({ state: 'running', settled: true, login: 'open', hook: 'confirmed' });
    expect(h.events).toContain('start:maintenance');
  });
  it('R9 after start, before the hook', async () => {
    setup('database', settled('off'));
    h.app = false; h.db.canLogin = false; h.db.sessions = 0;
    h.crashAt = 'hook';
    await order('running').catch(() => null);
    expect(rec().settled).toBe(false);
    h.start = { success: false, error: 'Bot is already running' };
    await resume();
    expect(rec()).toMatchObject({ state: 'running', settled: true, hook: 'confirmed' });
  });
  it('H9 json: after W1, before the hook', async () => {
    setup('json');
    h.crashAt = 'hook';
    await order('maintenance').catch(() => null);
    expect(rec().settled).toBe(false);
    await resume();
    expect(rec()).toMatchObject({ state: 'maintenance', settled: true, hook: 'confirmed', login: 'not-managed' });
  });
  it('H10 json: after the hook, before its write', async () => {
    setup('json');
    h.failWrite = (n) => (n === 2 ? 'killed' : null);
    await order('maintenance');
    expect(rec().settled).toBe(false);
    h.failWrite = () => null;
    await resume();
    expect(rec()).toMatchObject({ state: 'maintenance', settled: true, hook: 'confirmed' });
    expect(h.hookBodies.length).toBe(2);
  });
});

describe('order Maintenance, kinds copy, external, json', () => {
  const COPY_TAIL = " Its database login is not blocked from here: this machine holds a live copy, and only the main's manager can block it.";
  const EXT_TAIL = ' Its database login is not blocked: the database is not run by this manager.';
  it.each([['json', ''], ['copy', COPY_TAIL], ['external', EXT_TAIL]] as const)('H1 %s hook ok', async (kind, tail) => {
    setup(kind);
    const r = await order('maintenance');
    expect(r).toEqual({ settled: true, text: `Maintenance is on: the bot took the message.${tail}` });
    expect(rec()).toMatchObject({ settled: true, hook: 'confirmed', login: 'not-managed', savedByBot: 'maintenance' });
    expect(h.events).toEqual(['hook:maintenance']);
  });
  it('H2 hook unknown: kept, unsettled', async () => {
    setup('json');
    h.hook = HOOK_UNKNOWN;
    const r = await order('maintenance');
    expect(r).toEqual({ settled: false, text: "Maintenance can't be confirmed: the order reached the bot's address, but no answer came within 30 seconds, so the bot may or may not be in maintenance. The manager sends it again every 30 seconds." });
    expect(rec()).toMatchObject({ state: 'maintenance', settled: false, hook: 'unconfirmed' });
  });
  it('H3 hook unreachable: kept, unsettled', async () => {
    setup('json');
    h.hook = HOOK_UNREACHABLE;
    const r = await order('maintenance');
    expect(r).toEqual({ settled: false, text: 'Maintenance is not on yet: the bot could not be reached (maintenance unreachable: fetch failed). The manager sends the order again every 30 seconds while the bot runs.' });
    expect(rec()).toMatchObject({ state: 'maintenance', settled: false });
  });
  it('H4 hook 404: the order stays, unsettled, hook missing', async () => {
    setup('json');
    h.hook = HOOK_404;
    const r = await order('maintenance');
    expect(r).toEqual({ settled: false, text: "Maintenance is not on: this bot's build has no maintenance hook (it answered 404), and the bot keeps its data in files, so nothing can hold it in maintenance, and the manager does not send the order again. Choose Running or Off." });
    expect(rec()).toMatchObject({ state: 'maintenance', settled: false, hook: 'missing' });
  });
  it('H4 copy hook 404: the order stays, unsettled, hook missing', async () => {
    setup('copy', settled('running', { hook: 'confirmed', login: 'not-managed' }));
    h.hook = HOOK_404;
    const r = await order('maintenance');
    expect(r.text).toBe("Maintenance is not on: this bot's build has no maintenance hook (it answered 404), and its database login cannot be blocked from this manager, so nothing can hold it in maintenance, and the manager does not send the order again. Choose Running or Off.");
    expect(rec()).toMatchObject({ state: 'maintenance', settled: false, hook: 'missing', prior: { state: 'running', message: 'old' } });
  });
  it('H5 hook success false: the order stays, unsettled', async () => {
    setup('json');
    h.hook = HOOK_REFUSED;
    const r = await order('maintenance');
    expect(r).toEqual({ settled: false, text: 'Maintenance is not on yet: the bot refused the order (busy). The manager sends the order again every 30 seconds while the bot runs.' });
    expect(rec()).toMatchObject({ state: 'maintenance', settled: false, hook: 'unconfirmed', lastError: 'the bot refused the order (busy)' });
  });
  it('H6 app stopped, not from Off: R9', async () => {
    setup('json');
    h.app = false;
    const a = await orderMaintenance('b1', 'maintenance', '', () => {});
    expect(a).toEqual({ accepted: false, status: 409, error: 'The bot is stopped, and it enters maintenance only through its own answer. Start it, then choose Maintenance; nothing was changed' });
  });
  it('H7 from Off after the bot saved maintenance: start, hook-wait', async () => {
    setup('json', settled('off', { login: 'not-managed', savedByBot: 'maintenance' }));
    h.app = false;
    const r = await order('maintenance');
    expect(r).toEqual({ settled: true, text: 'Maintenance is on: the bot started and took the message.' });
    expect(h.events).toEqual(['start:maintenance', 'hook:maintenance']);
  });
  it('H8 from Off, the bot did not save maintenance: R10', async () => {
    setup('json', settled('off', { login: 'not-managed', savedByBot: 'running' }));
    h.app = false;
    const a = await orderMaintenance('b1', 'maintenance', '', () => {});
    expect(a).toEqual({ accepted: false, status: 409, error: 'The bot did not confirm it saved maintenance before it was turned off, so starting it would run its modules until it answers. Choose Running, then Maintenance; nothing was changed' });
  });
  it('H11 kind none: R7', async () => {
    setup('none');
    const a = await orderMaintenance('b1', 'maintenance', '', () => {});
    expect(a).toEqual({ accepted: false, status: 409, error: 'This app declares no lifecycle hooks, so the manager cannot put it into maintenance; Off stops it' });
  });
  it('H12 a refusal whose hook write throws', async () => {
    setup('json');
    h.hook = HOOK_REFUSED;
    h.failWrite = (n) => (n >= 2 ? 'disk full' : null);
    const r = await order('maintenance');
    expect(r).toEqual({ settled: false, text: 'Maintenance is not confirmed.' + NOT_RECORDED('disk full') });
    expect(rec()).toMatchObject({ state: 'maintenance', settled: false });
  });
  it('H13 from Off: start fails', async () => {
    setup('json', settled('off', { login: 'not-managed', savedByBot: 'maintenance' }));
    h.app = false; h.start = { success: false, error: 'image missing' };
    const r = await order('maintenance');
    expect(r).toEqual({ settled: false, text: 'Maintenance is not confirmed: the bot did not start (image missing). Choose Maintenance again to retry.' });
    expect(rec().settled).toBe(false);
  });
});

describe('order Off', () => {
  const S_O_DB = "The bot is off: it is stopped, and its database keeps running for backups and copies with the bot's login blocked.";
  it('O1 database, app running', async () => {
    const r = await order('off');
    expect(r).toEqual({ settled: true, text: S_O_DB });
    expect(h.events.filter(e => e !== 'ensure')).toEqual(['hook:maintenance', 'block', 'end-sessions', 'stop:maintenance', 'db-up']);
    expect(rec()).toMatchObject({ state: 'off', settled: true, login: 'blocked' });
  });
  it('O2 database: the hook fails', async () => {
    h.hook = HOOK_UNREACHABLE;
    const r = await order('off');
    expect(r).toEqual({ settled: true, text: S_O_DB });
  });
  it('O3 database: a DB step fails; the stop runs', async () => {
    h.block = { ok: false, cls: 'other', error: 'ERROR:  x' };
    const r = await order('off');
    expect(r).toEqual({ settled: false, text: 'The bot is stopped, but Off is not confirmed: the database login could not be blocked (ERROR:  x), so any other process of this bot can still log in to the database. Choose Off again to retry.' });
    expect(h.events).toContain('stop:maintenance');
    expect(rec()).toMatchObject({ settled: false, login: 'unconfirmed' });
  });
  it('O4 the stop fails, the block landed', async () => {
    h.stop = { success: false, error: 'compose down failed' };
    const r = await order('off');
    expect(r).toEqual({ settled: false, text: "Off is not confirmed: the stop failed (compose down failed). The bot's database login is blocked, so it cannot write. Choose Off again to retry." });
  });
  it('O4 json: the stop fails', async () => {
    setup('json');
    h.stop = { success: false, error: 'compose down failed' };
    const r = await order('off');
    expect(r).toEqual({ settled: false, text: 'Off is not confirmed: the stop failed (compose down failed). Choose Off again to retry.' });
  });
  it('O5 db-up-alone fails after the stop', async () => {
    const ok = { success: true };
    const failed = { success: false, error: 'compose failed' };
    Object.defineProperty(h, 'dbUp', { configurable: true, get: () => (h.events.includes('stop:maintenance') ? failed : ok), set: () => {} });
    const r = await order('off');
    delete (h as any).dbUp;
    h.dbUp = ok;
    expect(h.dbUpCalls).toBe(1);
    expect(r).toEqual({ settled: true, text: "The bot is off: it is stopped, and its database login is blocked. The database did not start again after the stop (compose failed), so backups and copies wait until it runs; choose Off again to retry." });
    expect(rec()).toMatchObject({ settled: true, lastError: 'the database did not start again after the stop (compose failed)' });
  });
  it('O7 database, app already stopped', async () => {
    h.app = false;
    const r = await order('off');
    expect(r).toEqual({ settled: true, text: S_O_DB });
    expect(h.events.some(e => e.startsWith('stop') || e.startsWith('hook'))).toBe(false);
  });
  it.each(['json', 'copy', 'external'] as const)('O8 %s: hook ok, stop ok', async (kind) => {
    setup(kind);
    const r = await order('off');
    expect(r).toEqual({ settled: true, text: 'The bot is off: it is stopped.' });
    expect(h.events).toEqual(['hook:maintenance', 'stop:maintenance']);
    expect(rec()).toMatchObject({ savedByBot: 'maintenance' });
  });
  it('O9 json: hook fails, stop ok', async () => {
    setup('json');
    h.hook = HOOK_UNREACHABLE;
    const r = await order('off');
    expect(r).toEqual({ settled: true, text: 'The bot is off: it is stopped. It did not confirm it saved maintenance before it stopped (the bot could not be reached: maintenance unreachable: fetch failed), so Maintenance from Off is refused for it until it runs again.' });
    expect(rec().savedByBot).toBeNull();
  });
  it('O10 none: stop ok', async () => {
    setup('none');
    const r = await order('off');
    expect(r).toEqual({ settled: true, text: 'The bot is off: it is stopped.' });
    expect(h.events).toEqual(['stop:maintenance']);
  });
});

describe('order Running', () => {
  const fromMaint = (kind: Kind = 'database') => {
    setup(kind, settled('maintenance', kind === 'database' ? {} : { login: 'not-managed' }));
    h.db.canLogin = false; h.db.sessions = 0;
  };
  const fromOff = (kind: Kind = 'database') => {
    setup(kind, settled('off', kind === 'database' ? {} : { login: 'not-managed' }));
    h.db.canLogin = false; h.db.sessions = 0; h.app = false;
  };
  const F_R_HOOK = (reason: string, db = true) => `Running is not confirmed:${db ? ' its database login is restored, but' : ''} the bot did not confirm it left maintenance (${reason}); it keeps answering with the maintenance message until it does. The manager sends the order again every 30 seconds while the bot runs.`;
  it('R1 database, from maintenance, app running', async () => {
    fromMaint();
    const r = await order('running');
    expect(r).toEqual({ settled: true, text: "The bot is running normally: its database login is restored, and it took the order to leave maintenance. Whether it restarts is not confirmed (it answered that it can't confirm, or did not say). If a restore ran while it was in maintenance, restart the bot so it loads the restored data." });
    expect(h.events.filter(e => e !== 'ensure')).toEqual(['open', 'hook:running']);
    expect(rec()).toMatchObject({ state: 'running', settled: true, login: 'open', savedByBot: 'running' });
  });
  it('R2 open fails: no hook', async () => {
    fromMaint();
    h.open = { ok: false, cls: 'other', error: 'ERROR:  x' };
    const r = await order('running');
    expect(r).toEqual({ settled: false, text: "Running is not confirmed: the bot's database login could not be restored (ERROR:  x). The bot answers with the maintenance message until it is. Choose Running again to retry." });
    expect(h.events.some(e => e.startsWith('hook'))).toBe(false);
  });
  it('R3 hook fails', async () => {
    fromMaint();
    h.hook = HOOK_UNREACHABLE;
    const r = await order('running');
    expect(r).toEqual({ settled: false, text: F_R_HOOK('the bot could not be reached: maintenance unreachable: fetch failed') });
  });
  it('R4 app stopped (not Off)', async () => {
    fromMaint();
    h.app = false;
    const r = await order('running');
    expect(r).toEqual({ settled: true, text: "The state is Running, and the bot's database login is restored. The bot is stopped, so it takes the order when it next runs." });
    expect(rec()).toMatchObject({ settled: true, hook: 'unconfirmed' });
  });
  it('R5 from Off', async () => {
    fromOff();
    const r = await order('running');
    expect(r).toEqual({ settled: true, text: "The bot is running normally: it started, its database login is restored, and it took the order to leave maintenance. Whether it restarts is not confirmed (it answered that it can't confirm, or did not say). If a restore ran while it was in maintenance, restart the bot so it loads the restored data." });
    expect(h.events.filter(e => e !== 'ensure')).toEqual(['open', 'start:maintenance', 'hook:running']);
  });
  it('R6 from Off: start fails', async () => {
    fromOff();
    h.start = { success: false, error: 'image missing' };
    const r = await order('running');
    expect(r).toEqual({ settled: false, text: 'Running is not confirmed: the bot did not start (image missing). Its database login is restored. Start it, or choose Running again.' });
    expect(rec()).toMatchObject({ settled: false, login: 'open' });
  });
  it('R7 from Off: hook-wait ends with no answer', async () => {
    fromOff();
    h.hook = HOOK_UNKNOWN;
    MAINTENANCE_TIMING.hookWaitMs = 2000;
    const r = await order('running');
    expect(r).toEqual({ settled: false, text: F_R_HOOK('no answer within 2 seconds of the start') });
  });
  it('R10 hook 404', async () => {
    fromMaint();
    h.hook = HOOK_404;
    const r = await order('running');
    expect(r).toEqual({ settled: true, text: 'The bot is running normally: its database login is restored. Its build has no maintenance hook, so it was never in maintenance.' });
    expect(rec().hook).toBe('missing');
  });
  it('R11 json from maintenance: hook ok', async () => {
    fromMaint('json');
    const r = await order('running');
    expect(r).toEqual({ settled: true, text: "The bot is running normally: it took the order to leave maintenance. Whether it restarts is not confirmed (it answered that it can't confirm, or did not say). If a restore ran while it was in maintenance, restart the bot so it loads the restored data." });
  });
  it('R12 json: hook fails', async () => {
    fromMaint('json');
    h.hook = HOOK_UNKNOWN;
    const r = await order('running');
    expect(r).toEqual({ settled: false, text: F_R_HOOK('no answer within 30 seconds', false) });
  });
  it('R13 none, from Off: start ok', async () => {
    fromOff('none');
    const r = await order('running');
    expect(r).toEqual({ settled: true, text: 'The bot is running normally: it started.' });
    expect(h.events).toEqual(['start:maintenance']);
  });
  it('R14 database in recovery', async () => {
    fromMaint();
    h.open = { ok: false, cls: 'recovery', error: 'in recovery' };
    const r = await order('running');
    expect(r).toEqual({ settled: false, text: "Running is not confirmed: the bot's database login could not be restored (the database is a live copy in recovery). The bot answers with the maintenance message until it is. Choose Running again to retry." });
  });
});

describe('route entry refusals', () => {
  it('R1 a bad state', async () => {
    expect(await orderMaintenance('b1', 'paused' as any, '', () => {})).toEqual({ accepted: false, status: 400, error: 'State must be running, maintenance or off' });
  });
  it('R2 a long message', async () => {
    expect(await orderMaintenance('b1', 'maintenance', 'x'.repeat(1501), () => {})).toEqual({ accepted: false, status: 400, error: 'The maintenance message is longer than 1500 characters' });
  });
  it('R3 no such bot', async () => {
    expect(await orderMaintenance('nope', 'maintenance', '', () => {})).toEqual({ accepted: false, status: 404, error: 'Bot not found' });
  });
  it('R8 a broken env store', async () => {
    h.env = { ...h.env, corrupt: true };
    expect(await orderMaintenance('b1', 'maintenance', '', () => {})).toEqual({ accepted: false, status: 409, error: "The env store for this instance cannot be read, so the manager can't tell which database the bot uses; nothing was changed" });
  });
  it('an accepted order calls onDone once with its result', async () => {
    const results: any[] = [];
    const a = await orderMaintenance('b1', 'maintenance', 'm', (r) => results.push(r));
    expect(a).toEqual({ accepted: true });
    for (let i = 0; i < 50 && results.length === 0; i++) await new Promise(r => setTimeout(r, 2));
    expect(results).toEqual([{ settled: true, text: S_M_DB }]);
  });
});

describe('round 1 fixes: a retry runs only the steps it may, and says only what ran', () => {
  const retry = (to: string) => runMaintenanceOrder('b1', to as any, 'm', { retry: true });
  it('F3a Running with the database down: no hook before the login is open, and no claim it is', async () => {
    setup('database', settled('maintenance'));
    h.sidecar = false; h.dbUp = { success: false, error: 'compose failed' };
    await order('running');
    h.events = [];
    const r = await retry('running');
    expect(h.events.some(e => e.startsWith('hook'))).toBe(false);
    expect(rec().savedByBot).toBe('maintenance');
    expect(r).toEqual({ settled: false, text: "Running is not confirmed: the bot's database login could not be restored (the database is not running, and a retry does not start it). The bot answers with the maintenance message until it is. Choose Running again to retry." });
  });
  it('F3b Off after a failed stop: the retry stops the bot and names only what ran', async () => {
    setup('database', settled('running', { login: 'open' }));
    h.stop = { success: false, error: 'x' };
    await order('off');
    h.stop = { success: true };
    h.events = [];
    const r = await retry('off');
    expect(h.events).toContain('stop:maintenance');
    expect(h.events.some(e => e.startsWith('start') || e === 'db-up')).toBe(false);
    expect(r).toEqual({ settled: true, text: "The bot is off: it is stopped, and its database login is blocked. Its database is not running, so backups and copies wait until it runs; choose Off again to start it." });
    expect(rec()).toMatchObject({ state: 'off', settled: true, login: 'blocked' });
  });
  it('F3c after M8, a retry names no start and no block it did not run', async () => {
    h.sidecar = false; h.dbUp = { success: false, error: 'compose failed' };
    await order('maintenance');
    h.events = [];
    const r = await retry('maintenance');
    expect(h.events.filter(e => e !== 'ensure')).toEqual([]);
    expect(r).toEqual({ settled: false, text: 'Maintenance is not confirmed: the database is not running, and a retry does not start it. Choose Maintenance again to retry.' });
  });
  it('F3d a start the order owes is never run by a retry: the operator chooses the state again', async () => {
    setup('database', settled('off'));
    h.db.canLogin = false; h.db.sessions = 0; h.app = false;
    h.start = { success: false, error: 'image missing' };
    await order('running');
    h.start = { success: true };
    h.events = [];
    const r = await retry('running');
    expect(h.events.some(e => e.startsWith('start') || e.startsWith('hook'))).toBe(false);
    expect(r).toEqual({ settled: false, text: 'Running is not confirmed: the bot is stopped, and a retry does not start it. Its database login is restored. Choose Running again to start it.' });
    expect(rec()).toMatchObject({ state: 'running', settled: false });
  });
  it('F3e the retry takes the order from the stored record, not from its caller', async () => {
    setup('database', settled('running', { login: 'open' }));
    h.events = [];
    const r = await runMaintenanceOrder('b1', 'maintenance', 'stale', { retry: true });
    expect(h.events).toEqual([]);
    expect(r.settled).toBe(true);
    expect(rec()).toMatchObject({ state: 'running', settled: true });
  });
  it('F5 a refusal after the order started the bot: reported as a refusal; the order stays and a retry sends it again', async () => {
    setup('json', settled('off', { login: 'not-managed' }));
    h.app = false; h.hook = HOOK_REFUSED;
    const r = await order('maintenance');
    expect(r).toEqual({ settled: false, text: 'Maintenance is not on yet: the bot refused the order (busy). The manager sends the order again every 30 seconds while the bot runs.' });
    const again = await retry('maintenance');
    expect(h.app).toBe(true);
    expect(rec()).toMatchObject({ state: 'maintenance', settled: false });
    expect(again.text).toBe('Maintenance is not on yet: the bot refused the order (busy). The manager sends the order again every 30 seconds while the bot runs.');
    expect(h.hookBodies.at(-1).body).toEqual({ state: 'maintenance', message: 'Back soon' });
  });
  it('F6 a refusal while the record before was unsettled keeps the order, unsettled, with its prior', async () => {
    setup('json', settled('running', { login: 'not-managed' }));
    h.hook = HOOK_UNKNOWN;
    await order('maintenance');
    expect(rec()).toMatchObject({ state: 'maintenance', settled: false });
    h.hook = HOOK_REFUSED;
    const r = await order('maintenance');
    expect(r).toEqual({ settled: false, text: 'Maintenance is not on yet: the bot refused the order (busy). The manager sends the order again every 30 seconds while the bot runs.' });
    expect(rec()).toMatchObject({ state: 'maintenance', settled: false, prior: { state: 'running', message: 'old' } });
  });
  it('F6 with no prior, the order stays, unsettled', async () => {
    setup('json', { state: 'maintenance', message: 'm', orderedAt: '2026-10-01T00:00:00.000Z', settled: false, hook: 'unconfirmed', login: 'not-managed', savedByBot: null });
    h.hook = HOOK_REFUSED;
    const r = await order('maintenance');
    expect(r.text).toBe('Maintenance is not on yet: the bot refused the order (busy). The manager sends the order again every 30 seconds while the bot runs.');
    expect(rec()).toMatchObject({ state: 'maintenance', settled: false });
  });
});

describe('round 2', () => {
  it('N1 a refusal while the app runs keeps the order, never a settled Off', async () => {
    setup('json', settled('off', { login: 'not-managed' }));
    h.app = false; h.hook = HOOK_REFUSED;
    await order('maintenance');
    expect(h.app).toBe(true);
    const r = await order('maintenance');
    expect(rec()).not.toMatchObject({ state: 'off', settled: true });
    expect(rec()).toMatchObject({ state: 'maintenance', settled: false });
    expect(r).toEqual({ settled: false, text: 'Maintenance is not on yet: the bot refused the order (busy). The manager sends the order again every 30 seconds while the bot runs.' });
  });
  it('N1 a 404 while the app runs keeps the order, hook missing', async () => {
    setup('json', settled('off', { login: 'not-managed' }));
    h.app = false; h.hook = HOOK_REFUSED;
    await order('maintenance');
    h.hook = HOOK_404;
    const r = await order('maintenance');
    expect(rec()).toMatchObject({ state: 'maintenance', settled: false, hook: 'missing' });
    expect(r.text).toBe("Maintenance is not on: this bot's build has no maintenance hook (it answered 404), and the bot keeps its data in files, so nothing can hold it in maintenance, and the manager does not send the order again. Choose Running or Off.");
  });
  it('N1 a refusal while the app stops keeps the order, unsettled', async () => {
    setup('json', settled('off', { login: 'not-managed' }));
    h.app = false; h.hook = HOOK_REFUSED;
    await order('maintenance');
    h.hook = () => { h.app = false; return HOOK_REFUSED(); };
    const r = await order('maintenance');
    expect(rec()).toMatchObject({ state: 'maintenance', settled: false });
    expect(r.text).toBe('Maintenance is not on yet: the bot refused the order (busy). The manager sends the order again every 30 seconds while the bot runs.');
  });
  it('N3 a retry the plan refuses with R7 names the kind, not a stop', async () => {
    setup('none', { state: 'maintenance', message: 'm', orderedAt: '2026-10-01T00:00:00.000Z', settled: false, hook: 'none', login: 'unconfirmed', savedByBot: null });
    h.app = true;
    const r = await runMaintenanceOrder('b1', 'maintenance', 'm', { retry: true });
    expect(r.text).not.toContain('the bot is stopped');
    expect(r.settled).toBe(false);
  });
});

describe('round 3: a refusal or a 404 keeps the order as the record', () => {
  const REFUSED_TEXT = 'Maintenance is not on yet: the bot refused the order (busy). The manager sends the order again every 30 seconds while the bot runs.';
  const MISSING_TEXT = "Maintenance is not on: this bot's build has no maintenance hook (it answered 404), and the bot keeps its data in files, so nothing can hold it in maintenance, and the manager does not send the order again. Choose Running or Off.";
  const retry = () => runMaintenanceOrder('b1', 'maintenance', 'ignored', { retry: true });
  it('R1 a json bot settled Off and started outside the manager refuses Maintenance: the order stays, unsettled, hook not confirmed', async () => {
    setup('json', settled('off', { login: 'not-managed' }));
    h.app = true; h.hook = HOOK_REFUSED;
    const r = await order('maintenance');
    expect(r).toEqual({ settled: false, text: REFUSED_TEXT });
    expect(rec()).toMatchObject({ state: 'maintenance', message: 'Back soon', settled: false, hook: 'unconfirmed', lastError: 'the bot refused the order (busy)' });
    expect(rec().hook).not.toBe('confirmed');
  });
  it('2(a) a refusal after an unsettled Running from Maintenance writes no settled state', async () => {
    setup('json', settled('maintenance', { login: 'not-managed' }));
    h.hook = HOOK_UNKNOWN;
    await order('running');
    expect(rec()).toMatchObject({ state: 'running', settled: false });
    h.hook = HOOK_REFUSED;
    const r = await order('maintenance');
    expect(r.text).not.toContain('The state stays');
    expect(r).toEqual({ settled: false, text: REFUSED_TEXT });
    expect(rec()).toMatchObject({ state: 'maintenance', settled: false, hook: 'unconfirmed' });
    expect(h.writes.every((w: any) => !w || !w.settled)).toBe(true);
  });
  it('a 404 is recorded as hook missing, unsettled, and a retry does not send the hook again', async () => {
    setup('json');
    h.hook = HOOK_404;
    const r = await order('maintenance');
    expect(r).toEqual({ settled: false, text: MISSING_TEXT });
    expect(rec()).toMatchObject({ state: 'maintenance', settled: false, hook: 'missing', lastError: 'its build has no maintenance hook' });
    h.hookBodies = [];
    const again = await retry();
    expect(h.hookBodies).toEqual([]);
    expect(again).toEqual({ settled: false, text: MISSING_TEXT });
    expect(rec()).toMatchObject({ state: 'maintenance', settled: false, hook: 'missing' });
  });
  it('a 404 is not sent again by the first reconciler pass either', async () => {
    setup('json');
    h.hook = HOOK_404;
    await order('maintenance');
    h.hookBodies = [];
    await reconcileMaintenance();
    for (let i = 0; i < 50 && h.lock; i++) await new Promise(r => setTimeout(r, 2));
    expect(h.hookBodies).toEqual([]);
    expect(rec()).toMatchObject({ state: 'maintenance', settled: false, hook: 'missing' });
  });
  it('a refusal is retried: the next pass sends the hook again and settles on success', async () => {
    setup('json');
    h.hook = HOOK_REFUSED;
    await order('maintenance');
    h.hook = HOOK_OK; h.hookBodies = [];
    const again = await retry();
    expect(h.hookBodies.map(b => b.body)).toEqual([{ state: 'maintenance', message: 'Back soon' }]);
    expect(again).toEqual({ settled: true, text: 'Maintenance is on: the bot took the message.' });
    expect(rec()).toMatchObject({ state: 'maintenance', settled: true, hook: 'confirmed' });
  });
  it('a 404 order keeps its text and reason after the bot stops', async () => {
    setup('json');
    h.hook = HOOK_404;
    await order('maintenance');
    h.app = false;
    const r = await retry();
    expect(r.text).toBe(MISSING_TEXT);
    expect(rec().lastError).toBe('its build has no maintenance hook');
  });
  it('a 404 order from Off with savedByBot maintenance keeps its text after the bot stops', async () => {
    setup('json', settled('off', { savedByBot: 'maintenance' }));
    h.hook = HOOK_404;
    await order('maintenance');
    h.app = false;
    const r = await retry();
    expect(r.text).toBe(MISSING_TEXT);
    expect(rec().lastError).toBe('its build has no maintenance hook');
  });
});
