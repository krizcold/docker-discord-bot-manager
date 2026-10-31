import { beforeEach, describe, expect, it, vi } from 'vitest';

// Contract 1's `saved` answer, read into the maintenance record's `held` by each caller of the hook, and carried by
// the proof a planned move reads (the stand-in for the bot's side until NB2).
const h = vi.hoisted(() => ({
  inst: null as any,
  lock: null as string | null,
  app: false as boolean | null,
  hooks: [] as any[],
  answers: [] as any[],
  writes: [] as any[],
  stop: { success: true } as { success: boolean; error?: string },
  canLogin: false,
}));

vi.mock('../../src/env/manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/env/manager')>()),
  getEnvVarsWithStatus: () => ({ vars: h.inst?.fleetDb ? { DATA_BACKEND: 'postgres' } : {}, undecryptable: [], encrypted: [], corrupt: false }),
}));
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
  updateInstanceMaintenance: (_id: string, rec: any) => { h.writes.push(JSON.parse(JSON.stringify(rec))); h.inst.maintenance = rec; },
  stopBotInOp: async () => { if (h.stop.success) h.app = false; return h.stop; },
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
  callAppHook: async (_i: any, action: string, _m: string, body: any) => { h.hooks.push({ action, body }); return h.answers.length > 1 ? h.answers.shift() : h.answers[0]; },
}));

import { heldOf, reconcileMaintenance, requireMaintenance, resetMaintenanceState, runMaintenanceOrder } from '../../src/instance/maintenance';

const SMDB = 'https://github.com/x/fully-modular-discord-bot';
const rec = (state: string, over: Record<string, unknown> = {}) => ({ state, message: 'Back soon', orderedAt: '2026-10-01T00:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: 'maintenance', ...over });
const okAnswer = (body: Record<string, unknown>) => ({ ok: true, status: 200, body: { success: true, state: 'maintenance', ...body } });

function setup(kind: 'database' | 'json', maintenance: any): void {
  h.inst = { id: 'b1', displayName: 'B1', sourceUrl: SMDB, envVars: {}, createdAt: 'x', maintenance };
  if (kind === 'database') h.inst.fleetDb = { containerName: 'b1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'v' };
}

beforeEach(() => {
  h.lock = null;
  h.app = true;
  h.hooks = [];
  h.writes = [];
  h.stop = { success: true };
  h.canLogin = false;
  h.answers = [okAnswer({ saved: true })];
  resetMaintenanceState();
  setup('database', rec('running'));
});

describe('the answer parse', () => {
  it.each([
    [{ saved: true }, { state: 'yes' }],
    [{ saved: false, unsavedGuilds: 3, unsavedFiles: 2 }, { state: 'no', guilds: 3, files: 2 }],
    [{ saved: false, unsavedGuilds: ['g1', 'g2'], unsavedFiles: ['a.json'] }, { state: 'no', guilds: 2, files: 1 }],
    [{ saved: false }, { state: 'no', guilds: 0, files: 0 }],
    [{ saved: null, note: 'busy' }, { state: 'unknown', note: 'busy' }],
    [{}, { state: 'unknown' }],
    [{ saved: 'yes' }, { state: 'unknown' }],
  ])('%j reads as %j', (body, want) => {
    expect(heldOf({ success: true, ...body })).toEqual(want);
  });
});

describe('each caller of the maintenance hook records held', () => {
  it('the order (recordHook) writes the answer, and a refusal leaves it absent', async () => {
    h.answers = [okAnswer({ saved: false, unsavedGuilds: 1, unsavedFiles: 0 })];
    await runMaintenanceOrder('b1', 'maintenance', 'Back soon');
    expect(h.inst.maintenance.held).toEqual({ state: 'no', guilds: 1, files: 0 });
    h.answers = [{ ok: false, status: 409, error: 'busy' }];
    setup('database', rec('running'));
    await runMaintenanceOrder('b1', 'maintenance', 'Back soon');
    expect(h.inst.maintenance.held).toBeUndefined();
  });
  it('W1: a new order starts without the last one\'s answer', async () => {
    setup('database', rec('maintenance', { held: { state: 'yes' } }));
    h.answers = [{ ok: false, status: 404, error: 'no route' }];
    await runMaintenanceOrder('b1', 'off', 'Back soon');
    expect(h.writes[0].held).toBeUndefined();
  });
  it("Off's stop turns an answer other than yes into stopped, and keeps yes", async () => {
    h.answers = [okAnswer({ saved: null })];
    await runMaintenanceOrder('b1', 'off', '');
    expect(h.inst.maintenance.held).toEqual({ state: 'stopped' });
    setup('database', rec('running'));
    h.app = true;
    h.answers = [okAnswer({ saved: true })];
    await runMaintenanceOrder('b1', 'off', '');
    expect(h.inst.maintenance.held).toEqual({ state: 'yes' });
  });
  it('an order with no bot running and no hook step records not-running', async () => {
    h.app = false;
    setup('database', rec('maintenance'));
    await runMaintenanceOrder('b1', 'off', '');
    expect(h.inst.maintenance.held).toEqual({ state: 'not-running' });
    expect(h.hooks).toEqual([]);
  });
  it('a Running order records no held', async () => {
    setup('database', rec('maintenance', { held: { state: 'yes' } }));
    h.answers = [{ ok: true, status: 200, body: { success: true, restarting: true, saved: true } }];
    await runMaintenanceOrder('b1', 'running', '');
    expect(h.inst.maintenance.held).toBeUndefined();
  });
  it('the reconciler\'s hook retry (C3) writes it', async () => {
    setup('json', rec('maintenance', { hook: 'unconfirmed', login: 'not-managed' }));
    h.answers = [okAnswer({ saved: true })];
    await reconcileMaintenance();
    await reconcileMaintenance();
    expect(h.inst.maintenance.held).toEqual({ state: 'yes' });
    expect(h.hooks[h.hooks.length - 1]).toEqual({ action: 'maintenance', body: { state: 'maintenance', message: 'Back soon' } });
  });
  it('the live proof of a json bot parses the answer it gets', async () => {
    setup('json', rec('maintenance', { login: 'not-managed' }));
    h.lock = 'handover';
    h.answers = [okAnswer({ saved: false, unsavedFiles: ['x'] })];
    expect(await requireMaintenance('b1', 'any')).toEqual({ ok: true, state: 'maintenance', enforcement: 'hook', botConfirmed: true, held: { state: 'no', guilds: 0, files: 1 } });
  });
  it('the database proof carries the recorded answer (contract 1 stand-in)', async () => {
    setup('database', rec('maintenance', { held: { state: 'yes' } }));
    h.lock = 'handover';
    expect(await requireMaintenance('b1', 'database')).toEqual({ ok: true, state: 'maintenance', enforcement: 'database', botConfirmed: true, held: { state: 'yes' } });
  });
  it("a 'running' answer still gives NM4's restarting and no held", async () => {
    setup('database', rec('maintenance'));
    h.answers = [{ ok: true, status: 200, body: { success: true, restarting: false, saved: true } }];
    const r = await runMaintenanceOrder('b1', 'running', '');
    expect(r.text).toContain('It answered that it does not restart');
    expect(h.inst.maintenance.held).toBeUndefined();
  });
});

describe('callAppHook reads a non-2xx answer (D32)', () => {
  const answer = (body: string, status: number) => vi.stubGlobal('fetch', async () => new Response(body, { status }));
  const real = () => vi.importActual<typeof import('../../src/instance/appHookClient')>('../../src/instance/appHookClient');
  const inst = () => ({ id: 'b1', sourceUrl: SMDB, updateToken: 'tok', envVars: {} }) as any;
  it("a 502 with unknown: true is the bot's can't-confirm, with its body", async () => {
    const body = { success: false, unknown: true, error: 'Discord did not answer' };
    answer(JSON.stringify(body), 502);
    expect(await (await real()).callAppHook(inst(), 'switch-notice', 'POST', {})).toEqual({ ok: false, status: 502, body, error: 'Discord did not answer', unknown: true });
    vi.unstubAllGlobals();
  });
  it('a 502 without it is a refusal, not unknown', async () => {
    const body = { success: false, error: 'Discord refused the message' };
    answer(JSON.stringify(body), 502);
    const r = await (await real()).callAppHook(inst(), 'notify-owner', 'POST', {});
    expect(r).toEqual({ ok: false, status: 502, body, error: 'Discord refused the message' });
    expect(r.unknown).toBeFalsy();
    vi.unstubAllGlobals();
  });
  it('a 409 keeps its body', async () => {
    const body = { success: false, error: 'no writable database at generation 4 for that machine' };
    answer(JSON.stringify(body), 409);
    expect(await (await real()).callAppHook(inst(), 'switch-notice', 'POST', {})).toEqual({ ok: false, status: 409, body, error: body.error });
    vi.unstubAllGlobals();
  });
});

describe("notifyOwner reads contract 7's answer", () => {
  const send = async () => (await import('../../src/instance/backupCheck')).notifyOwner(h.inst, 'text', 'b1:replaced:4');
  it.each([
    [{ ok: true, status: 200, body: { success: true, posted: true, place: 'channel', note: 'pinned' } }, { dm: 'sent', posted: true, place: 'channel', note: 'pinned' }],
    [{ ok: true, status: 200, body: { success: true, posted: true, place: 'dm' } }, { dm: 'sent', posted: true, place: 'dm' }],
    [{ ok: true, status: 200, body: { success: true, posted: false, note: 'already posted at 10:00' } }, { dm: 'sent', posted: false, note: 'already posted at 10:00' }],
    [{ ok: false, status: 404, error: 'notify-owner returned 404' }, { dm: 'failed', dmError: 'notify-owner returned 404', notFound: true }],
    [{ ok: false, status: 502, unknown: true, error: 'no answer from Discord' }, { dm: 'unknown', dmError: 'no answer from Discord' }],
    [{ ok: false, status: 502, error: 'Discord refused' }, { dm: 'failed', dmError: 'Discord refused' }],
  ])('%j', async (answer, want) => {
    h.answers = [answer];
    expect(await send()).toEqual(want);
    expect(h.hooks[0]).toEqual({ action: 'notify-owner', body: { text: 'text', key: 'b1:replaced:4' } });
  });
});
