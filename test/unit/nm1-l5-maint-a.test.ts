import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  inst: null as any,
  botAt: null as null | ((n: number) => any),
  botCalls: 0,
  caps: undefined as any,
  shutting: false,
  env: { vars: {} as Record<string, string>, undecryptable: [] as string[], encrypted: [] as string[], corrupt: false },
  lock: null as string | null,
  app: true as boolean | null,
  appAfterStart: true,
  sidecar: true as boolean | null,
  sidecarSeq: null as null | (boolean | null)[],
  sidecarCalls: 0,
  db: { inRecovery: false, canLogin: true as boolean | null, sessions: 1 },
  dbUp: { success: true } as { success: boolean; error?: string },
  dbUpCalls: 0,
  ensure: { ok: true } as any,
  block: { ok: true } as any,
  end: { ok: true } as any,
  open: { ok: true } as any,
  hook: (_body: any): any => ({ ok: true, status: 200, body: { success: true } }),
  start: { success: true } as { success: boolean; error?: string },
  stop: { success: true } as { success: boolean; error?: string },
  events: [] as string[],
  writes: [] as any[],
  failWrite: (_n: number, _rec: any): string | null => null,
  crashAt: null as string | null,
}));

vi.mock('../../src/config/appCapabilities', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/config/appCapabilities')>();
  return { ...real, findAppCapabilities: (url: string) => (h.caps !== undefined ? h.caps : real.findAppCapabilities(url)) };
});

vi.mock('../../src/env/manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/env/manager')>()),
  getEnvVarsWithStatus: () => h.env,
}));

const crash = (step: string) => { if (h.crashAt === step) { h.crashAt = null; throw new Error(`crash at ${step}`); } };

vi.mock('../../src/docker/containerManager', () => ({
  SHUTDOWN_REFUSAL: 'shutting down',
  isShuttingDown: () => h.shutting,
  registryFault: () => null,
  getBot: (id: string) => (h.botAt ? h.botAt(++h.botCalls) : h.inst && h.inst.id === id ? JSON.parse(JSON.stringify(h.inst)) : null),
  getAllBots: () => (h.inst ? [JSON.parse(JSON.stringify(h.inst))] : []),
  isBotBusy: () => h.lock,
  databaseHoldRefusal: () => null,
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
    try { return await fn(); } finally { h.lock = null; }
  },
  appContainerRunning: async () => h.app,
  startBotInOp: async () => {
    h.events.push('start');
    if (h.start.success) h.app = h.appAfterStart;
    return h.start;
  },
  stopBotInOp: async () => {
    h.events.push('stop');
    if (h.stop.success) { h.app = false; h.sidecar = false; }
    return h.stop;
  },
  startFleetDbSidecar: async () => {
    h.dbUpCalls++;
    h.events.push('db-up');
    if (h.dbUp.success) h.sidecar = true;
    return h.dbUp;
  },
}));

vi.mock('../../src/instance/dbLogin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/dbLogin')>()),
  sidecarRunning: async () => { h.sidecarCalls++; return h.sidecarSeq ? h.sidecarSeq.shift() ?? null : h.sidecar; },
  ensureManagerDbRole: async () => { h.events.push('ensure'); return h.ensure; },
  readBotLogin: async () => ({ ok: true, login: { ...h.db } }),
  blockBotLogin: async () => {
    h.events.push('block');
    if (h.block.ok) h.db.canLogin = false;
    return h.block;
  },
  endBotSessions: async () => {
    h.events.push('end-sessions');
    if (h.end.ok) h.db.sessions = 0;
    return h.end;
  },
  openBotLogin: async () => {
    h.events.push('open');
    if (h.open.ok) h.db.canLogin = true;
    return h.open;
  },
}));

vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  callAppHook: async (_inst: any, _action: string, _method: string, body: any) => {
    crash('hook');
    h.events.push(`hook:${body.state}`);
    return h.hook(body);
  },
}));

import { setMaintenanceListener, reconcileMaintenance, runMaintenanceOrder, maintenanceKind, readKind, resetMaintenanceState, MAINTENANCE_TIMING } from '../../src/instance/maintenance';

const SMDB = 'https://github.com/x/fully-modular-discord-bot';
const fleetDb = { containerName: 'b1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'v' };
const COMPANION = { engine: 'postgres', user: 'smdb', database: 'smdb', env: { url: 'DATA_BACKEND_URL', mode: { key: 'DATA_BACKEND', value: 'postgres' } }, appEnvFile: '.env' };
const HOOKS = { basePath: '/api/managed', port: 8080, portEnvKey: 'WEBUI_PORT' };
const rec0 = (state: string, over: Record<string, unknown> = {}) => ({ state, message: 'old', orderedAt: '2026-10-01T00:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: state === 'running' ? 'running' : 'maintenance', ...over });

type Kind = 'database' | 'json' | 'none';
function setup(kind: Kind, maintenance?: any): void {
  const base: any = { id: 'b1', displayName: 'B1', sourceUrl: SMDB, envVars: {}, createdAt: '2026-10-01T00:00:00.000Z', status: 'running' };
  let vars: Record<string, string> = { DATA_BACKEND: 'postgres' };
  if (kind === 'database') base.fleetDb = { ...fleetDb };
  if (kind === 'json') vars = {};
  if (kind === 'none') { base.sourceUrl = 'https://github.com/x/plain-bot'; vars = {}; }
  if (maintenance) base.maintenance = maintenance;
  h.inst = base;
  h.env = { vars, undecryptable: [], encrypted: [], corrupt: false };
}

const HOOK_UNREACHABLE = () => ({ ok: false, error: 'maintenance unreachable: fetch failed' });
const HOOK_404 = () => ({ ok: false, status: 404, error: 'maintenance returned 404' });
const HOOK_UNKNOWN = () => ({ ok: false, unknown: true, error: 'no answer' });

beforeEach(() => {
  resetMaintenanceState();
  MAINTENANCE_TIMING.hookWaitMs = 30;
  MAINTENANCE_TIMING.hookWaitPauseMs = 1;
  MAINTENANCE_TIMING.hookWaitTryMs = 10;
  h.botAt = null; h.botCalls = 0; h.caps = undefined; h.shutting = false;
  h.lock = null; h.app = true; h.appAfterStart = true; h.sidecar = true; h.sidecarSeq = null; h.sidecarCalls = 0;
  h.db = { inRecovery: false, canLogin: true, sessions: 1 };
  h.dbUp = { success: true }; h.dbUpCalls = 0; h.ensure = { ok: true }; h.block = { ok: true }; h.end = { ok: true }; h.open = { ok: true };
  h.hook = () => ({ ok: true, status: 200, body: { success: true } }); h.start = { success: true }; h.stop = { success: true };
  h.events = []; h.writes = []; h.failWrite = () => null; h.crashAt = null;
  setup('database');
});
afterEach(() => { vi.restoreAllMocks(); });

const rec = () => h.inst.maintenance;
const order = (to: string, message = 'Back soon') => runMaintenanceOrder('b1', to as any, message);
const retry = (to: string) => runMaintenanceOrder('b1', to as any, '', { retry: true });
const resumed = (to: string) => runMaintenanceOrder('b1', to as any, '', { resumed: true });
const inst = (over: Record<string, unknown> = {}) => ({ id: 'b1', displayName: 'B1', sourceUrl: SMDB, envVars: {}, createdAt: 'x', ...over }) as any;

describe('the kind of a bot', () => {
  it('a blank URL of spaces is the managed main', () => {
    expect(maintenanceKind(inst({ fleetDb }), { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: '   ' })).toBe('database');
  });
  it('a URL that does not parse is not the managed main', () => {
    expect(maintenanceKind(inst({ fleetDb }), { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: 'not a url' })).toBe('external');
  });
  it('a public host set does not make another host the main', () => {
    const db = { ...fleetDb, replication: { publicHost: 'pub.example.test' } };
    expect(maintenanceKind(inst({ fleetDb: db }), { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: 'postgresql://u:p@other.test:5432/d' })).toBe('external');
  });
  it('an app with hooks and no companion database is json', () => {
    h.caps = { match: { urlContains: 'x' }, hooks: HOOKS };
    expect(maintenanceKind(inst({ fleetDb }), {})).toBe('json');
  });
  it('a companion with no mode key is always postgres', () => {
    h.caps = { match: { urlContains: 'x' }, companionDb: { ...COMPANION, env: { url: 'DATA_BACKEND_URL' } }, hooks: HOOKS };
    expect(maintenanceKind(inst({ fleetDb }), {})).toBe('database');
  });
  it('a URL with a no-break space around it is still the managed main', () => {
    expect(maintenanceKind(inst({ fleetDb }), { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: ' postgres://u:p@b1-fleet-postgres:5432/x﻿' })).toBe('database');
  });
  it('readKind merges the record env under the store', () => {
    h.env = { vars: {}, undecryptable: [], encrypted: [], corrupt: false };
    expect(readKind(inst({ fleetDb, envVars: { DATA_BACKEND: 'postgres' } }))).toEqual({ kind: 'database' });
  });
});

describe('runCore entry', () => {
  it('an unknown bot answers Bot not found', async () => {
    expect(await runMaintenanceOrder('zz', 'maintenance', '')).toEqual({ settled: false, text: 'Bot not found' });
  });
  it('a shutdown refuses', async () => {
    h.shutting = true;
    expect(await order('maintenance')).toEqual({ settled: false, text: 'shutting down' });
  });
  it('a resumed run of a settled Running answers it is confirmed', async () => {
    setup('database', rec0('running', { login: 'open' }));
    expect(await resumed('running')).toEqual({ settled: true, text: 'Running is already confirmed; nothing ran again.' });
  });
  it('a resumed run takes the state from the record, not the call', async () => {
    setup('database', rec0('maintenance', { settled: false, hook: 'unconfirmed', login: 'unconfirmed' }));
    await runMaintenanceOrder('b1', 'off', 'x', { resumed: true });
    expect(h.events).not.toContain('stop');
    expect(rec().state).toBe('maintenance');
  });
  it('an unexpected error is stored as the order error', async () => {
    h.crashAt = 'hook';
    await expect(order('maintenance')).rejects.toThrow('crash at hook');
    expect(rec().lastError).toBe('The order stopped on an unexpected error: crash at hook');
  });
  it('a settled Running record does not count as from Off through its prior', async () => {
    setup('json', rec0('running', { prior: { state: 'off', message: '' }, savedByBot: 'maintenance' }));
    h.app = false;
    expect((await order('maintenance')).text).toContain('The bot is stopped, and it enters maintenance only through its own answer.');
    expect(h.events).toEqual([]);
  });
  it('an unsettled order whose prior is not Off is not from Off', async () => {
    setup('json', rec0('maintenance', { settled: false, prior: { state: 'running', message: '' }, savedByBot: 'maintenance' }));
    h.app = false;
    expect((await order('maintenance')).text).toContain('The bot is stopped, and it enters maintenance only through its own answer.');
    expect(h.events).toEqual([]);
  });
  it('an order sends the hook even when the record says missing', async () => {
    setup('database', rec0('maintenance', { hook: 'missing' }));
    await order('maintenance');
    expect(h.events).toContain('hook:maintenance');
  });
  it('an order with the app stopped does not take the record hook missing', async () => {
    setup('database', rec0('running', { hook: 'missing', login: 'open' }));
    h.app = false;
    expect((await order('maintenance')).text).toBe("Maintenance is on: the bot's database login is blocked. The bot is stopped; it takes the message when it next runs.");
  });
});

describe('retry and resumed runs', () => {
  it('a retry with docker silent on the database runs no database step', async () => {
    setup('database', rec0('maintenance', { settled: false, hook: 'confirmed', login: 'unconfirmed' }));
    h.sidecar = null;
    const r = await retry('maintenance');
    expect(r.settled).toBe(false);
    expect(rec().lastError).toBe('docker did not say whether the database runs, and a retry does not start it');
    expect(h.events).not.toContain('block');
  });
  it('a retry whose role cannot be made does not block', async () => {
    setup('database', rec0('maintenance', { settled: false, hook: 'confirmed', login: 'unconfirmed' }));
    h.ensure = { ok: false, error: 'denied' };
    await retry('maintenance');
    expect(h.events).toEqual(['ensure']);
  });
  it('a retry with the hook confirmed and the app running says no session open', async () => {
    setup('database', rec0('maintenance', { settled: false, hook: 'confirmed', login: 'unconfirmed' }));
    expect(await retry('maintenance')).toEqual({ settled: true, text: "Maintenance is on: the bot's database login is blocked with no session open." });
  });
  it('a retry owed a start from Off with the login blocked', async () => {
    setup('database', rec0('maintenance', { settled: false, hook: 'unconfirmed', login: 'unconfirmed', prior: { state: 'off', message: '' } }));
    h.app = false;
    expect(await retry('maintenance')).toEqual({ settled: false, text: 'Maintenance is not confirmed: the bot is stopped, and a retry does not start it. Its database login is blocked, so it cannot write. Choose Maintenance again to start it.' });
  });
  it('a json retry owed a start', async () => {
    setup('json', rec0('maintenance', { settled: false, hook: 'unconfirmed', login: 'not-managed', prior: { state: 'off', message: '' } }));
    h.app = false;
    expect(await retry('maintenance')).toEqual({ settled: false, text: 'Maintenance is not confirmed: the bot is stopped, and a retry does not start it. Choose Maintenance again to start it.' });
  });
  it('a retry of a bot whose setup lost maintenance', async () => {
    setup('none', rec0('maintenance', { settled: false, hook: 'unconfirmed', login: 'not-managed' }));
    expect(await retry('maintenance')).toEqual({ settled: false, text: "Maintenance is not on: the bot's setup changed, and it now has no maintenance hook and no database login this manager can block, so nothing can hold it in maintenance. Choose Off to stop it, or Running." });
    expect(rec().lastError).toBe("the bot's setup no longer allows maintenance");
  });
  it('a retry of a stopped json bot not from Off', async () => {
    setup('json', rec0('maintenance', { settled: false, hook: 'unconfirmed', login: 'not-managed' }));
    h.app = false;
    expect(await retry('maintenance')).toEqual({ settled: false, text: 'Maintenance is not on: the bot is stopped, so it did not get the order. Start it, then choose Maintenance again.' });
    expect(rec().lastError).toBe('the bot is stopped, so it did not get the order');
  });
  it('a json retry with the hook confirmed says on', async () => {
    setup('json', rec0('maintenance', { settled: false, hook: 'confirmed', login: 'not-managed' }));
    expect(await retry('maintenance')).toEqual({ settled: true, text: 'Maintenance is on: the bot took the message.' });
  });
  it('a json retry with no hook to send says it did not answer', async () => {
    setup('json', rec0('maintenance', { settled: false, hook: 'none', login: 'not-managed' }));
    expect(await retry('maintenance')).toEqual({ settled: false, text: 'Maintenance is not on yet: the bot could not be reached (it did not answer). The manager sends the order again every 30 seconds while the bot runs.' });
    expect(rec().lastError).toBe('the bot could not be reached (it did not answer)');
  });
  it('a retry keeps the record unsettled while it runs', async () => {
    setup('json', rec0('maintenance', { settled: false, hook: 'unconfirmed', login: 'not-managed' }));
    await retry('maintenance');
    expect(h.writes[0]).toMatchObject({ settled: false, hook: 'confirmed' });
  });
  it('a resumed database run marks the login unconfirmed', async () => {
    setup('database', rec0('maintenance', { settled: false, hook: 'unconfirmed', login: 'blocked' }));
    await resumed('maintenance');
    expect(h.writes[0]).toMatchObject({ login: 'unconfirmed' });
  });
  it('a retry database run keeps the login it read', async () => {
    setup('database', rec0('maintenance', { settled: false, hook: 'unconfirmed', login: 'blocked' }));
    await retry('maintenance');
    expect(h.writes[0]).toMatchObject({ login: 'blocked' });
  });
  it('a resumed run of a bot with no hook still blocks', async () => {
    setup('database', rec0('maintenance', { settled: false, hook: 'missing', login: 'unconfirmed' }));
    await resumed('maintenance');
    expect(h.events).toContain('block');
    expect(h.events).not.toContain('hook:maintenance');
  });
  it('a resumed run from Off of a bot with no hook does not wait for it', async () => {
    setup('database', rec0('maintenance', { settled: false, hook: 'missing', login: 'unconfirmed', prior: { state: 'off', message: '' } }));
    h.app = false;
    await resumed('maintenance');
    expect(h.events).toContain('start');
    expect(h.events.filter(e => e.startsWith('hook'))).toEqual([]);
  });
  it('a retry of Off whose stop leaves the database down', async () => {
    setup('database', rec0('off', { settled: false, hook: 'confirmed', login: 'unconfirmed' }));
    const r = await retry('off');
    expect(r.settled).toBe(true);
    expect(rec().lastError).toBe('the database is not running after the stop');
  });
  it('a retry of Off with no stop asks docker about the database once', async () => {
    setup('database', rec0('off', { settled: false, hook: 'confirmed', login: 'unconfirmed' }));
    h.app = false; h.sidecarSeq = [true, null]; h.db = { inRecovery: false, canLogin: false, sessions: 0 };
    expect(await retry('off')).toEqual({ settled: true, text: "The bot is off: it is stopped, and its database keeps running for backups and copies with the bot's login blocked." });
    expect(h.sidecarCalls).toBe(1);
    expect(rec().lastError).toBeUndefined();
  });
  it('a json retry owed a Running start', async () => {
    setup('json', rec0('running', { settled: false, hook: 'unconfirmed', login: 'not-managed', prior: { state: 'off', message: '' } }));
    h.app = false;
    expect(await retry('running')).toEqual({ settled: false, text: 'Running is not confirmed: the bot is stopped, and a retry does not start it. Choose Running again to start it.' });
  });
});

describe('a rerun that finds the order settled', () => {
  it('does not notify', async () => {
    setup('json', rec0('maintenance', { settled: false, hook: 'confirmed', login: 'not-managed' }));
    const unsettled = JSON.parse(JSON.stringify(h.inst));
    const done = JSON.parse(JSON.stringify({ ...h.inst, maintenance: { ...h.inst.maintenance, settled: true } }));
    h.botAt = (n) => (n === 1 ? unsettled : done);
    const got = new Promise<any[]>(resolve => setMaintenanceListener((_id, result, notify) => resolve([result, notify])));
    await reconcileMaintenance();
    expect(await got).toEqual([{ settled: true, text: 'Maintenance is already confirmed; nothing ran again.' }, false]);
    setMaintenanceListener(null);
  });
});

describe('a json Running retry with no hook to send', () => {
  it('says the bot did not answer', async () => {
    setup('json', rec0('running', { settled: false, hook: 'none', login: 'not-managed' }));
    expect(await retry('running')).toEqual({ settled: false, text: 'Running is not confirmed: the bot did not confirm it left maintenance (it did not answer); it keeps answering with the maintenance message until it does. The manager sends the order again every 30 seconds while the bot runs.' });
  });
});

describe('hook texts', () => {
  it('a refusal with no error says no reason given', async () => {
    setup('json');
    h.hook = () => ({ ok: false, status: 500 });
    const r = await order('maintenance');
    expect(r.text).toBe('Maintenance is not on yet: the bot refused the order (no reason given). The manager sends the order again every 30 seconds while the bot runs.');
  });
  it('a hook-wait that cannot reach the bot keeps that reason', async () => {
    setup('database', rec0('off', { hook: 'none' }));
    h.app = false; h.hook = HOOK_UNREACHABLE;
    const r = await order('maintenance');
    expect(r.text).toBe("Maintenance is on: the bot's database login is blocked with no session open. The bot did not take the message (the bot could not be reached: maintenance unreachable: fetch failed), so it answers with the last message it saved or its default text; the manager sends the message again every 30 seconds while the bot runs.");
  });
  it('a hook-wait at its deadline asks once more only before it', async () => {
    setup('database', rec0('off', { hook: 'none' }));
    h.app = false; h.hook = HOOK_UNKNOWN;
    MAINTENANCE_TIMING.hookWaitMs = 0;
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    await order('maintenance');
    expect(h.events.filter(e => e.startsWith('hook'))).toHaveLength(1);
  }, 3000);
  it('a hook-wait records the hook before the final write', async () => {
    setup('database', rec0('off', { hook: 'none' }));
    h.app = false;
    await order('maintenance');
    expect(h.writes).toHaveLength(3);
    expect(h.writes[1]).toMatchObject({ settled: false, hook: 'confirmed' });
  });
  it('a database failure with a 404 hook names the missing hook', async () => {
    h.hook = HOOK_404; h.block = { ok: false, error: 'denied' };
    expect((await order('maintenance')).text).toBe('Maintenance is not confirmed: the database login could not be blocked (denied). The bot did not take the message (its build has no maintenance hook). Choose Maintenance again to retry.');
  });
  it('a database failure with an unreachable hook names the reason', async () => {
    h.hook = HOOK_UNREACHABLE; h.block = { ok: false, error: 'denied' };
    expect((await order('maintenance')).text).toBe('Maintenance is not confirmed: the database login could not be blocked (denied). The bot did not take the message (the bot could not be reached: maintenance unreachable: fetch failed). Choose Maintenance again to retry.');
  });
  it('a 404 hook stores the missing hook reason', async () => {
    h.hook = HOOK_404;
    await order('maintenance');
    expect(rec().lastError).toBe('the bot did not take the message (its build has no maintenance hook)');
  });
  it('an unreachable hook stores its reason', async () => {
    h.hook = HOOK_UNREACHABLE;
    await order('maintenance');
    expect(rec().lastError).toBe('the bot did not take the message (the bot could not be reached: maintenance unreachable: fetch failed)');
  });
  it('a hook save that fails stops the order before the database', async () => {
    h.failWrite = (n) => (n === 2 ? 'disk full' : null);
    const r = await order('maintenance');
    expect(h.events).not.toContain('block');
    expect(r.text.startsWith('Maintenance is not confirmed. The manager could not record this (disk full)')).toBe(true);
  });
});

describe('Maintenance from Off, database', () => {
  it('a start that leaves the bot stopped', async () => {
    setup('database', rec0('off', { hook: 'none' }));
    h.app = false; h.appAfterStart = false;
    expect((await order('maintenance')).text).toBe('Maintenance is not confirmed: the bot did not start (it was not running after the start). Its database login is blocked, so it cannot write. Choose Maintenance again to retry.');
  });
  it('a failed start stores its reason', async () => {
    setup('database', rec0('off'));
    h.app = false; h.start = { success: false, error: 'image missing' };
    await order('maintenance');
    expect(rec().lastError).toBe('the bot did not start (image missing)');
  });
  it('a failed block skips the start', async () => {
    setup('database', rec0('off'));
    h.app = false; h.block = { ok: false, error: 'denied' };
    await order('maintenance');
    expect(h.events).not.toContain('start');
  });
});

describe('json Maintenance from Off', () => {
  it('a failed start stores its reason', async () => {
    setup('json', rec0('off'));
    h.app = false; h.start = { success: false, error: 'image missing' };
    await order('maintenance');
    expect(rec().lastError).toBe('the bot did not start (image missing)');
  });
});

describe('Off texts', () => {
  it('a json stop that leaves the bot running', async () => {
    setup('json');
    h.stop = { success: false, error: 'Bot is not running' };
    const r = await order('off');
    expect(r).toEqual({ settled: false, text: 'Off is not confirmed: the stop failed (the bot still runs after the stop). Choose Off again to retry.' });
    expect(rec().lastError).toBe('the stop failed (the bot still runs after the stop)');
  });
  it('a stop with no error says no reason given', async () => {
    setup('json');
    h.stop = { success: false };
    expect((await order('off')).text).toBe('Off is not confirmed: the stop failed (no reason given). Choose Off again to retry.');
  });
  it('a database stop failure after a failed block says nothing of a block', async () => {
    h.block = { ok: false, error: 'denied' }; h.stop = { success: false, error: 'x' };
    expect((await order('off')).text).toBe('Off is not confirmed: the stop failed (x). Choose Off again to retry.');
  });
  it('the database left running is not started again', async () => {
    h.stop = { success: false, error: 'Bot is not running' };
    await order('off');
    expect(h.dbUpCalls).toBe(0);
  });
  it('a database that does not start again with no error', async () => {
    h.dbUp = { success: false };
    await order('off');
    expect(rec().lastError).toBe('the database did not start again after the stop (no reason given)');
  });
  it('a json Off whose hook fails stores the reason', async () => {
    setup('json', rec0('running', { savedByBot: 'running' }));
    h.hook = HOOK_UNREACHABLE;
    expect((await order('off')).text).toBe('The bot is off: it is stopped. It did not confirm it saved maintenance before it stopped (the bot could not be reached: maintenance unreachable: fetch failed), so Maintenance from Off is refused for it until it runs again.');
    expect(rec().lastError).toBe('the bot did not confirm it saved maintenance (the bot could not be reached: maintenance unreachable: fetch failed)');
  });
  it('a json Off whose bot saved maintenance before', async () => {
    setup('json', rec0('maintenance'));
    h.hook = HOOK_UNREACHABLE;
    expect((await order('off')).text).toBe('The bot is off: it is stopped.');
  });
});

describe('end-sessions failures', () => {
  it('an error with no count', async () => {
    h.end = { ok: false, error: 'boom' };
    await order('maintenance');
    expect(rec().lastError).toBe("the manager can't confirm the login is blocked: boom");
  });
  it('a left key that is undefined', async () => {
    h.end = { ok: false, left: undefined, error: 'boom' };
    await order('maintenance');
    expect(rec().lastError).toBe("the manager can't confirm the login is blocked: boom");
  });
});

describe('Running texts', () => {
  it('a database login that is not restored stores its reason', async () => {
    setup('database', rec0('maintenance'));
    h.db.canLogin = false; h.open = { ok: false, error: 'denied' };
    await order('running');
    expect(rec().lastError).toBe("the bot's database login could not be restored (denied)");
    expect(h.events.filter(e => e.startsWith('hook'))).toEqual([]);
  });
  it('a json start that leaves the bot stopped', async () => {
    setup('json', rec0('off'));
    h.app = false; h.appAfterStart = false;
    expect(await order('running')).toEqual({ settled: false, text: 'Running is not confirmed: the bot did not start (it was not running after the start). Start it, or choose Running again.' });
    expect(rec().lastError).toBe('the bot did not start (it was not running after the start)');
  });
  it('a json start that fails', async () => {
    setup('json', rec0('off'));
    h.app = false; h.start = { success: false, error: 'image missing' };
    expect((await order('running')).text).toBe('Running is not confirmed: the bot did not start (image missing). Start it, or choose Running again.');
  });
  it('a json hook that does not answer stores its reason', async () => {
    setup('json', rec0('maintenance'));
    h.hook = HOOK_UNREACHABLE;
    await order('running');
    expect(rec().lastError).toBe('the bot did not confirm it left maintenance (the bot could not be reached: maintenance unreachable: fetch failed)');
  });
  it('a bot with no hooks stopped', async () => {
    setup('none', rec0('running', { hook: 'none', login: 'not-managed' }));
    h.app = false;
    expect(await order('running')).toEqual({ settled: true, text: 'The state is Running. The bot is stopped.' });
  });
  it('a database bot with no hooks stopped', async () => {
    h.caps = { match: { urlContains: 'x' }, companionDb: COMPANION };
    setup('database', rec0('maintenance', { hook: 'none' }));
    h.app = false; h.db.canLogin = false;
    expect(await order('running')).toEqual({ settled: true, text: "The state is Running, and the bot's database login is restored. The bot is stopped." });
  });
  it('a json bot with hooks stopped', async () => {
    setup('json', rec0('maintenance'));
    h.app = false;
    expect(await order('running')).toEqual({ settled: true, text: 'The state is Running. The bot is stopped, so it takes the order when it next runs.' });
  });
  it('a json bot with no hook in its build', async () => {
    setup('json', rec0('maintenance'));
    h.hook = HOOK_404;
    expect((await order('running')).text).toBe('The bot is running normally. Its build has no maintenance hook, so it was never in maintenance.');
  });
  it('a json bot started from Off', async () => {
    setup('json', rec0('off'));
    h.app = false;
    expect((await order('running')).text).toBe('The bot is running normally: it started and it took the order to leave maintenance.');
  });
  it('a bot with no hooks started', async () => {
    setup('none', rec0('off', { hook: 'none', login: 'not-managed' }));
    h.app = false;
    expect((await order('running')).text).toBe('The bot is running normally: it started.');
  });
  it('a database bot with no hooks started', async () => {
    h.caps = { match: { urlContains: 'x' }, companionDb: COMPANION };
    setup('database', rec0('off', { hook: 'none' }));
    h.app = false; h.db.canLogin = false;
    expect((await order('running')).text).toBe('The bot is running normally: it started, and its database login is restored.');
  });
  it('a database bot with no hooks running', async () => {
    h.caps = { match: { urlContains: 'x' }, companionDb: COMPANION };
    setup('database', rec0('maintenance', { hook: 'none' }));
    h.db.canLogin = false;
    expect((await order('running')).text).toBe('The bot is running normally: its database login is restored.');
  });
  it('a bot with no hooks running', async () => {
    setup('none', rec0('running', { hook: 'none', login: 'not-managed' }));
    expect((await order('running')).text).toBe('The bot is running normally.');
  });
});

describe('a database bot with no hooks in Maintenance', () => {
  it('says the login is blocked with no session open', async () => {
    h.caps = { match: { urlContains: 'x' }, companionDb: COMPANION };
    h.app = false;
    expect(await order('maintenance')).toEqual({ settled: true, text: "Maintenance is on: the bot's database login is blocked with no session open." });
  });
});
