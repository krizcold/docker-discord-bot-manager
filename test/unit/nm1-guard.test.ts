import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  inst: null as any,
  env: { vars: {} as Record<string, string>, undecryptable: [] as string[], encrypted: [] as string[], corrupt: false },
  lock: null as string | null,
  app: false as boolean | null,
  read: { ok: true, login: { inRecovery: false, canLogin: false, sessions: 0 } } as any,
  hook: { ok: true, status: 200, body: { success: true } } as any,
  hookBodies: [] as any[],
}));

vi.mock('../../src/env/manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/env/manager')>()),
  getEnvVarsWithStatus: () => h.env,
}));
vi.mock('../../src/docker/containerManager', () => ({
  getBot: (id: string) => (h.inst?.id === id ? JSON.parse(JSON.stringify(h.inst)) : null),
  isBotBusy: () => h.lock,
  appContainerRunning: async () => h.app,
}));
vi.mock('../../src/instance/dbLogin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/dbLogin')>()),
  readBotLogin: async () => h.read,
}));
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  callAppHook: async (_i: any, action: string, method: string, body: any, timeout: number) => { h.hookBodies.push({ action, method, body, timeout }); return h.hook; },
}));

import { requireMaintenance } from '../../src/instance/maintenance';

const SMDB = 'https://github.com/x/fully-modular-discord-bot';
const rec = (state: string, over: Record<string, unknown> = {}) => ({ state, message: 'Back soon', orderedAt: '2026-10-01T00:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: 'maintenance', ...over });
function setup(kind: 'database' | 'json' | 'copy' | 'external' | 'none', maintenance: any): void {
  h.inst = { id: 'b1', displayName: 'B1', sourceUrl: SMDB, envVars: {}, createdAt: 'x', maintenance };
  h.env = { vars: { DATA_BACKEND: 'postgres' }, undecryptable: [], encrypted: [], corrupt: false };
  if (kind === 'database') h.inst.fleetDb = { containerName: 'b1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'v' };
  if (kind === 'json') h.env.vars = {};
  if (kind === 'copy') { h.inst.fleetDbReplica = { containerName: 'r' }; h.env.vars.DATA_BACKEND_URL = 'postgresql://u:p@main.test:1/d'; }
  if (kind === 'external') h.env.vars.DATA_BACKEND_URL = 'postgresql://u:p@ext.test:1/d';
  if (kind === 'none') h.inst.sourceUrl = 'https://github.com/x/plain-bot';
}

beforeEach(() => {
  h.lock = 'restore';
  h.app = false;
  h.read = { ok: true, login: { inRecovery: false, canLogin: false, sessions: 0 } };
  h.hook = { ok: true, status: 200, body: { success: true } };
  h.hookBodies = [];
  setup('database', rec('maintenance'));
});

describe('requireMaintenance', () => {
  it('G0a database, settled maintenance, login blocked, no session', async () => {
    expect(await requireMaintenance('b1', 'database')).toEqual({ ok: true, state: 'maintenance', enforcement: 'database', botConfirmed: true });
    setup('database', rec('off', { hook: 'unconfirmed' }));
    expect(await requireMaintenance('b1', 'any')).toEqual({ ok: true, state: 'off', enforcement: 'database', botConfirmed: false });
  });
  it('G0b need any, json, settled maintenance, the hook re-sent answers', async () => {
    setup('json', rec('maintenance', { login: 'not-managed' }));
    expect(await requireMaintenance('b1', 'any')).toEqual({ ok: true, state: 'maintenance', enforcement: 'hook', botConfirmed: true });
    expect(h.hookBodies).toEqual([{ action: 'maintenance', method: 'POST', body: { state: 'maintenance', message: 'Back soon' }, timeout: 30_000 }]);
  });
  it('G0c need any, json, settled off, no app container', async () => {
    setup('json', rec('off', { login: 'not-managed' }));
    expect(await requireMaintenance('b1', 'any')).toEqual({ ok: true, state: 'off', enforcement: 'stopped', botConfirmed: true });
  });
  it('G1 state running', async () => {
    setup('database', undefined);
    expect(await requireMaintenance('b1', 'database')).toEqual({ ok: false, error: 'This bot is not in maintenance; put it into Maintenance or Off first' });
  });
  it('G2 not settled', async () => {
    setup('database', rec('maintenance', { settled: false, lastError: 'the database did not start (x)' }));
    expect(await requireMaintenance('b1', 'database')).toEqual({ ok: false, error: "The bot's change to Maintenance is not confirmed yet (the database did not start (x)), so it does not count as maintenance" });
  });
  it.each([
    ['json', 'This bot keeps its data in files, so the manager cannot hold its database in maintenance'],
    ['copy', "This machine holds a live copy, so this manager cannot confirm the bot's database login is blocked"],
    ['external', "The bot's database is not run by this manager, so this manager cannot confirm its login is blocked"],
  ] as const)('G3 need database, kind %s', async (kind, error) => {
    setup(kind, rec('maintenance', { login: 'not-managed' }));
    expect(await requireMaintenance('b1', 'database')).toEqual({ ok: false, error });
  });
  it('G4 the read fails', async () => {
    h.read = { ok: false, cls: 'other', error: 'no answer' };
    expect(await requireMaintenance('b1', 'database')).toEqual({ ok: false, error: "The manager can't confirm the bot's database login is blocked: no answer" });
  });
  it('G5 the read shows the login open', async () => {
    h.read = { ok: true, login: { inRecovery: false, canLogin: true, sessions: 0 } };
    expect(await requireMaintenance('b1', 'database')).toEqual({ ok: false, error: "The bot's database login is open although the state is Maintenance; the manager blocks it again within 30 seconds, then retry" });
  });
  it('G5 a missing role never reads as blocked', async () => {
    h.read = { ok: true, login: { inRecovery: false, canLogin: null, sessions: 0 } };
    expect((await requireMaintenance('b1', 'database')).ok).toBe(false);
  });
  it('G6 sessions open', async () => {
    h.read = { ok: true, login: { inRecovery: false, canLogin: false, sessions: 2 } };
    expect(await requireMaintenance('b1', 'database')).toEqual({ ok: false, error: "2 session(s) of the bot's database role are open although its login is blocked; retry in a moment" });
  });
  it('G7 in recovery', async () => {
    h.read = { ok: true, login: { inRecovery: true, canLogin: false, sessions: 0 } };
    expect(await requireMaintenance('b1', 'database')).toEqual({ ok: false, error: "The database is a live copy in recovery, so it is not this bot's main database" });
  });
  it('G8 need any, the hook re-send fails', async () => {
    setup('json', rec('maintenance', { login: 'not-managed' }));
    h.hook = { ok: false, unknown: true, error: 'x' };
    expect(await requireMaintenance('b1', 'any')).toEqual({ ok: false, error: 'The bot did not confirm it is in maintenance (no answer within 30 seconds)' });
  });
  it('G9 need any, off, the app runs', async () => {
    setup('json', rec('off', { login: 'not-managed' }));
    h.app = true;
    expect(await requireMaintenance('b1', 'any')).toEqual({ ok: false, error: 'The state is Off, but the bot runs; choose Off again' });
  });
  it.each([[null], ['maintenance']])('G10 the op lock is %s', async (lock) => {
    h.lock = lock;
    expect(await requireMaintenance('b1', 'database')).toEqual({ ok: false, error: 'The maintenance check ran outside an operation on this bot, so its answer could not hold; nothing was changed' });
  });
  it.each([
    ['copy', 'maintenance'], ['copy', 'off'], ['external', 'maintenance'], ['external', 'off'], ['none', 'off'],
  ] as const)('F7 need any, kind %s, state %s: refused, the database does not enforce it', async (kind, state) => {
    setup(kind, rec(state, { login: 'not-managed' }));
    const r = await requireMaintenance('b1', 'any');
    expect(r.ok).toBe(false);
    expect(h.hookBodies).toEqual([]);
    expect((r as any).error).toBe(kind === 'none'
      ? 'This bot has no database this manager blocks, so maintenance is not enforced on its data and the operation cannot run; nothing was changed'
      : "This manager does not block this bot's database login, so its database does not enforce maintenance and the operation cannot run; nothing was changed");
  });
  it('G11 need any, off, docker does not answer', async () => {
    setup('json', rec('off', { login: 'not-managed' }));
    h.app = null;
    expect(await requireMaintenance('b1', 'any')).toEqual({ ok: false, error: "Docker did not say whether the bot runs, so the manager can't confirm it is off" });
  });
});
