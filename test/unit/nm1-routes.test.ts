import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm1-routes-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    broadcasts: [] as Array<{ type: string; payload: any }>,
    admission: { accepted: true } as any,
    result: { settled: true, text: 'done' } as any,
    orders: [] as any[],
    drift: null as string | null,
    sidecar: true as boolean | null,
    read: { ok: true, login: { inRecovery: false, canLogin: false, sessions: 0 } } as any,
    listener: null as null | ((botId: string, result: any, notify: boolean) => void),
  };
});

vi.mock('../../src/webui/server', () => ({ broadcastToClients: (_w: unknown, type: string, payload: unknown) => { h.broadcasts.push({ type, payload }); } }));
vi.mock('../../src/env/manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/env/manager')>()),
  getEnvVarsWithStatus: () => ({ vars: { DATA_BACKEND: 'postgres' }, undecryptable: [], encrypted: [], corrupt: false }),
}));
vi.mock('../../src/instance/dbLogin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/dbLogin')>()),
  sidecarRunning: async () => h.sidecar,
  readBotLogin: async () => h.read,
}));
vi.mock('../../src/instance/maintenance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/maintenance')>()),
  orderMaintenance: async (botId: string, to: string, message: string, onDone: (r: unknown) => void) => {
    h.orders.push({ botId, to, message });
    if (h.admission.accepted) setImmediate(() => onDone(h.result));
    return h.admission;
  },
  getMaintenanceDrift: () => h.drift,
  setMaintenanceListener: (fn: any) => { h.listener = fn; },
}));

import * as fs from 'fs';
import * as path from 'path';
import { createBotRoutes, collectHealthChanges } from '../../src/webui/routes/bots';
import { startPreflightRefusal } from '../../src/docker/containerManager';

const SMDB = 'https://github.com/x/fully-modular-discord-bot';
const base = (id: string, over: Record<string, unknown> = {}) => ({
  id, displayName: id.toUpperCase(), sanitizedName: id, titleName: id, sourceUrl: SMDB, sourceId: null, status: 'running', containerIds: [],
  envVars: {}, lastBuiltCommit: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...over,
});
const fleetDb = { containerName: 'db1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'v' };
const maint = (state: string, over: Record<string, unknown> = {}) => ({ state, message: 'Back soon', orderedAt: '2026-10-02T10:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: 'maintenance', ...over });
function writeRegistry(instances: Record<string, unknown>): void {
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances }, null, 2));
}

const router = createBotRoutes({ clients: new Set() } as any);
const call = async (method: 'get' | 'put', routePath: string, id: string, body: unknown = {}): Promise<{ status: number; body: any }> => {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
  const res: any = { statusCode: 200 };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  await layer.route.stack[layer.route.stack.length - 1].handle({ params: { id }, query: {}, body }, res);
  return { status: res.statusCode, body: res.body };
};

afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));
beforeEach(() => {
  h.broadcasts = []; h.orders = []; h.admission = { accepted: true }; h.result = { settled: true, text: 'done' }; h.drift = null;
  h.sidecar = true; h.read = { ok: true, login: { inRecovery: false, canLogin: false, sessions: 0 } };
  writeRegistry({
    b1: base('b1', { maintenance: maint('maintenance') }),
    db1: base('db1', { fleetDb, maintenance: maint('maintenance') }),
    off1: base('off1', { status: 'stopped', maintenance: maint('off') }),
  });
});

describe('the reconciler listener', () => {
  it('F3 a reconciler result carries whether it notifies', () => {
    h.listener!('b1', { settled: false, text: 'x' }, true);
    h.listener!('b1', { settled: false, text: 'x' }, false);
    expect(h.broadcasts.map(b => [b.type, b.payload.id, b.payload.notify])).toEqual([['bot:maintenance', 'b1', true], ['bot:maintenance', 'b1', false]]);
  });
});

describe('PUT /:id/maintenance', () => {
  it('P1 a valid order answers an opId and broadcasts one bot:maintenance at its end', async () => {
    const r = await call('put', '/:id/maintenance', 'b1', { state: 'maintenance', message: 'Back soon' });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.opId).toBeTruthy();
    expect(h.orders).toEqual([{ botId: 'b1', to: 'maintenance', message: 'Back soon' }]);
    await new Promise(res => setImmediate(res));
    await new Promise(res => setImmediate(res));
    const pushes = h.broadcasts.filter(b => b.type === 'bot:maintenance');
    expect(pushes.length).toBe(1);
    expect(pushes[0].payload).toMatchObject({ id: 'b1', opId: r.body.opId, settled: true, text: 'done', maintenance: { state: 'maintenance' } });
    expect(pushes[0].payload).toHaveProperty('activeOp');
    expect(pushes[0].payload).toHaveProperty('maintenanceDrift');
  });
  it('a missing message is sent as blank', async () => {
    await call('put', '/:id/maintenance', 'b1', { state: 'off' });
    expect(h.orders[0].message).toBe('');
    await new Promise(res => setImmediate(res));
  });
  it.each([
    [400, 'State must be running, maintenance or off'],
    [404, 'Bot not found'],
    [409, "Operation 'start' already in progress"],
    [500, 'The state change was not recorded, so nothing was changed: x'],
  ])('P2 a refusal %i answers its status and text, no opId, no broadcast', async (status, error) => {
    h.admission = { accepted: false, status, error };
    const r = await call('put', '/:id/maintenance', 'b1', { state: 'maintenance' });
    expect(r).toEqual({ status, body: { success: false, error } });
    await new Promise(res => setImmediate(res));
    expect(h.broadcasts).toEqual([]);
  });
  it('a non-string message is refused before the order', async () => {
    const r = await call('put', '/:id/maintenance', 'b1', { state: 'maintenance', message: 5 });
    expect(r.status).toBe(400);
    expect(h.orders).toEqual([]);
  });
});

describe('GET /:id/maintenance', () => {
  it('P3 kind database, the read answers: the summary follows the record and the read', async () => {
    const r = await call('get', '/:id/maintenance', 'db1');
    expect(r.body).toEqual({ success: true, state: 'maintenance', message: 'Back soon', settled: true, kind: 'database', orderedAt: '2026-10-02T10:00:00.000Z', lastError: null, summary: "State: Maintenance. The bot's database login is blocked and none of its sessions is open." });
  });
  it('P3 the read shows the login open', async () => {
    h.read = { ok: true, login: { inRecovery: false, canLogin: true, sessions: 0 } };
    const r = await call('get', '/:id/maintenance', 'db1');
    expect(r.body.summary).toBe("State: Maintenance, but the bot's database login is open; the manager blocks it again within 30 seconds.");
  });
  it('P3 the database is not running', async () => {
    h.sidecar = false;
    const r = await call('get', '/:id/maintenance', 'db1');
    expect(r.body.summary).toBe('State: Maintenance. The database is not running, so its login cannot be read now; the block is stored in the database and holds when it starts.');
  });
  it('P4 the read fails', async () => {
    h.read = { ok: false, cls: 'other', error: 'no answer' };
    const r = await call('get', '/:id/maintenance', 'db1');
    expect(r.body.summary).toBe("State: Maintenance. The manager can't confirm the database login is blocked: no answer.");
  });
  it('an external-database bot in maintenance', async () => {
    const r = await call('get', '/:id/maintenance', 'b1');
    expect(r.body.kind).toBe('external');
    expect(r.body.summary).toBe("State: Maintenance, through the bot's own answer. Its database login is not blocked: the database is not run by this manager.");
  });
  it('an unsettled record', async () => {
    writeRegistry({ b1: base('b1', { maintenance: maint('off', { settled: false, lastError: 'the stop failed (x)' }) }) });
    const r = await call('get', '/:id/maintenance', 'b1');
    expect(r.body.summary).toBe('State: Off, not confirmed: the stop failed (x)');
  });
  it('no record reads Running', async () => {
    writeRegistry({ b1: base('b1') });
    const r = await call('get', '/:id/maintenance', 'b1');
    expect(r.body).toMatchObject({ state: 'running', settled: true, summary: 'State: Running.' });
  });
  it('a drift shows as the drift text', async () => {
    h.drift = 'The state is Off, but the bot runs (it was started outside the manager). Choose Off in State to stop it, or Running.';
    writeRegistry({ b1: base('b1', { maintenance: maint('off') }) });
    const r = await call('get', '/:id/maintenance', 'b1');
    expect(r.body.summary).toBe(h.drift);
  });
  it('an unknown bot answers 404', async () => {
    const r = await call('get', '/:id/maintenance', 'nope');
    expect(r).toEqual({ status: 404, body: { success: false, error: 'Bot not found' } });
  });
});

describe('health pushes carry maintenanceDrift', () => {
  it('a drift change reaches collectHealthChanges', () => {
    writeRegistry({ b1: base('b1') });
    const seen = new Map<string, string>();
    expect(collectHealthChanges(seen)).toEqual([expect.objectContaining({ id: 'b1', maintenanceDrift: null })]);
    expect(collectHealthChanges(seen)).toEqual([]);
    h.drift = 'drifted';
    expect(collectHealthChanges(seen)).toEqual([expect.objectContaining({ id: 'b1', maintenanceDrift: 'drifted' })]);
  });
});

describe('O11 Start on an Off bot', () => {
  it('startPreflightRefusal answers S-OFF', () => {
    expect(startPreflightRefusal('off1')).toEqual({ success: false, error: 'This bot is Off. Choose Running in its State window to start it' });
  });
  it('a bot in Maintenance may start', () => {
    expect(startPreflightRefusal('b1')).toBeNull();
  });
  it('the start route refuses with 409', async () => {
    const layer = (router as any).stack.find((l: any) => l.route?.path === '/:id/start' && l.route.methods.post);
    const res: any = { statusCode: 200 };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    await layer.route.stack[layer.route.stack.length - 1].handle({ params: { id: 'off1' }, query: {}, body: {} }, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('This bot is Off. Choose Running in its State window to start it');
  });
});
