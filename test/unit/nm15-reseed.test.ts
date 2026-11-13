import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const r = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm15-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, calls: [] as unknown[][] };
});

vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => undefined }));
vi.mock('../../src/casaos/detector', () => ({ getDeploymentMode: async () => 'docker' }));
vi.mock('../../src/instance/fleetSwitch', async (o) => ({
  ...(await o<typeof import('../../src/instance/fleetSwitch')>()),
  rejoinComposed: (id: string) => { r.calls.push(['rejoin', id]); return { success: true, rejoined: true }; },
}));
vi.mock('../../src/instance/fleetReplica', async (o) => ({
  ...(await o<typeof import('../../src/instance/fleetReplica')>()),
  reseedStalePrimary: (bot: any, code: string) => { r.calls.push(['reseed', bot.id, code]); return { success: true, reseeded: true }; },
}));

import * as fs from 'fs';
import * as path from 'path';
import { createBotRoutes } from '../../src/webui/routes/bots';

const router = createBotRoutes({ clients: new Set() } as any);
const handler = (() => {
  const layer = (router as any).stack.find((l: any) => l.route?.path === '/:id/fleet-reseed' && l.route.methods.post);
  return layer.route.stack[layer.route.stack.length - 1].handle;
})();
const post = async (body: unknown): Promise<{ status: number; body: any }> => {
  const res: any = { statusCode: 200 };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  await handler({ params: { id: 'a' }, query: {}, body }, res);
  return { status: res.statusCode, body: res.body };
};
const seed = (fleetDb?: Record<string, unknown>) => {
  fs.writeFileSync(path.join(r.dir, 'instances.json'), JSON.stringify({ instances: {
    a: { id: 'a', sanitizedName: 'a', displayName: 'A', status: 'running', sourceUrl: 'https://example.invalid/x', createdAt: 'x', updatedAt: 'x',
      ...(fleetDb ? { fleetDb: { containerName: 'a-pg', user: 'app', db: 'app', volume: 'v', ...fleetDb } } : {}) },
  } }));
};
const refused = { status: 200, body: { success: false, error: 'Replication is not enabled on this database, so it cannot rejoin as a copy from a join code; enable it in the Replication section first; nothing was changed' } };
const reseeded = { status: 200, body: { success: true, reseeded: true } };

beforeEach(() => { r.calls = []; });
afterAll(() => fs.rmSync(r.dir, { recursive: true, force: true }));

describe('NM15: fleet-reseed with replication off', () => {
  it('case 1: refuses a join code and calls nothing', async () => {
    seed({});
    expect(await post({ joinCode: 'code' })).toEqual(refused);
    expect(await post({ joinCode: 'code', replaced: true })).toEqual(refused);
    expect(r.calls).toEqual([]);
  });
  it('case 2: replication on passes the code', async () => {
    seed({ replication: { publicHost: 'h.invalid' } });
    expect(await post({ joinCode: 'code' })).toEqual(reseeded);
    expect(r.calls).toEqual([['reseed', 'a', 'code']]);
  });
  it.each([
    ['replacedBy', { replacedBy: { machine: 'b', host: 'h.invalid', port: 5432, generation: 2, own: 1, since: null, at: '2026-11-12T00:00:00.000Z' } }],
    ['mainConflict', { mainConflict: { machine: 'b', host: 'h.invalid', port: 5432, generation: 2, at: '2026-11-12T00:00:00.000Z' } }],
    ['stopped stream hand-over', { handover: { mode: 'stream', phase: 'stopped', at: '2026-11-12T00:00:00.000Z' } }],
  ])('case 3: a recorded rejoin (%s) passes the code', async (_n, extra) => {
    seed(extra);
    expect(await post({ joinCode: 'code' })).toEqual(reseeded);
    expect(r.calls).toEqual([['reseed', 'a', 'code']]);
  });
  it.each([
    ['stream not stopped', { handover: { mode: 'stream', phase: 'waiting', at: '2026-11-12T00:00:00.000Z' } }],
    ['stopped, not a stream', { handover: { mode: 'push', phase: 'stopped', at: '2026-11-12T00:00:00.000Z' } }],
  ])('a hand-over %s refuses as case 1', async (_n, extra) => {
    seed(extra);
    expect(await post({ joinCode: 'code' })).toEqual(refused);
    expect(r.calls).toEqual([]);
  });
  it('case 4: no fleetDb goes to reseedStalePrimary', async () => {
    seed();
    expect(await post({ joinCode: 'code' })).toEqual(reseeded);
    expect(r.calls).toEqual([['reseed', 'a', 'code']]);
  });
  it('case 5: replaced with no code rejoins without replication', async () => {
    seed({});
    expect(await post({ replaced: true })).toEqual({ status: 200, body: { success: true, rejoined: true } });
    expect(r.calls).toEqual([['rejoin', 'a']]);
  });
});
