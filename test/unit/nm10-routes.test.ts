import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm10-routes-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, broadcasts: [] as Array<{ type: string; payload: any }>, admission: { accepted: true } as any, runs: [] as any[], listener: null as any };
});

vi.mock('../../src/webui/server', () => ({ broadcastToClients: (_w: unknown, type: string, payload: unknown) => { h.broadcasts.push({ type, payload }); } }));
vi.mock('../../src/env/manager', async (o) => ({
  ...(await o<typeof import('../../src/env/manager')>()),
  getEnvVarsWithStatus: () => ({ vars: { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: 'postgresql://smdb:secretpw@b1-fleet-postgres:5432/smdb' }, undecryptable: [], encrypted: [], corrupt: false }),
}));
vi.mock('../../src/instance/migrate', async (o) => ({
  ...(await o<typeof import('../../src/instance/migrate')>()),
  runMigration: async (id: string, to: unknown, mode: string) => { h.runs.push({ id, to, mode }); return h.admission; },
  setMigrateListener: (fn: any) => { h.listener = fn; },
}));

import * as fs from 'fs';
import * as path from 'path';
import { createBotRoutes } from '../../src/webui/routes/bots';
import { withoutRecordSecrets, getBot } from '../../src/docker/containerManager';

const SMDB = 'https://github.com/x/fully-modular-discord-bot';
const SETTLED = { state: 'maintenance', message: '', orderedAt: '2026-10-30T00:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: 'maintenance' };
const base = { id: 'b1', displayName: 'B1', sanitizedName: 'b1', titleName: 'b1', sourceUrl: SMDB, sourceId: null, status: 'running', containerIds: [], envVars: {}, lastBuiltCommit: null, createdAt: 'x', updatedAt: 'x', maintenance: SETTLED, fleetDb: { containerName: 'b1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'v' } };

const router = createBotRoutes({ clients: new Set() } as any);
const call = async (method: 'get' | 'post', routePath: string, id: string, body: unknown = {}) => {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
  const res: any = { statusCode: 200 };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  await layer.route.stack[layer.route.stack.length - 1].handle({ params: { id }, query: {}, body }, res);
  return { status: res.statusCode, body: res.body };
};

afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));
beforeEach(() => {
  h.broadcasts = []; h.runs = []; h.admission = { accepted: true };
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances: { b1: base } }));
});

describe('the two routes', () => {
  it('POST /:id/migrate answers an opId at admission', async () => {
    const r = await call('post', '/:id/migrate', 'b1', { to: 'file' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, opId: expect.any(String) });
    expect(h.runs).toEqual([{ id: 'b1', to: 'file', mode: 'press' }]);
  });
  it('a refusal answers its status and text', async () => {
    h.admission = { accepted: false, status: 409, error: 'Migrate runs with the bot in Maintenance; choose Maintenance in State first; nothing was changed' };
    expect(await call('post', '/:id/migrate', 'b1', { to: 'file' })).toEqual({ status: 409, body: { success: false, error: h.admission.error } });
  });
  it('GET /:id/migrate answers the view: direction, destination identity, no URL', async () => {
    const r = await call('get', '/:id/migrate', 'b1');
    expect(r.body).toMatchObject({ success: true, hidden: false, to: 'file' });
    expect(JSON.stringify(r.body)).not.toContain('secretpw');
    expect((await call('get', '/:id/migrate', 'zz')).status).toBe(404);
  });
  it('bot:migrate carries the text and whether it is final', () => {
    h.listener('b1', { text: 'Migration mgr-a is running', final: false });
    expect(h.broadcasts[0]).toMatchObject({ type: 'bot:migrate', payload: { id: 'b1', text: 'Migration mgr-a is running', final: false } });
  });
  it('withoutRecordSecrets carries migrate and migrateLast (null when absent) and no URL', () => {
    const out = withoutRecordSecrets(getBot('b1'))!;
    expect(out.migrate).toBeNull();
    expect(out.migrateLast).toBeNull();
    expect(JSON.stringify(out)).not.toContain('secretpw');
  });
});
