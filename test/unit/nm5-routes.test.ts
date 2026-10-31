import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const r = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-routes-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    broadcasts: [] as Array<{ type: string; data: any }>,
    lane: null as null | ((admit: () => void) => Promise<any>),
    adopt: { success: true } as any,
    adoptCalls: 0,
    takeOpts: [] as unknown[],
  };
});

vi.mock('../../src/webui/server', () => ({ broadcastToClients: (_w: unknown, type: string, data: unknown) => { r.broadcasts.push({ type, data }); } }));
vi.mock('../../src/instance/fleetSwitch', async (o) => {
  const real = await o<typeof import('../../src/instance/fleetSwitch')>();
  const lane = (admit: () => void) => r.lane!(admit);
  return {
    ...real,
    handOverMain: (_id: string, _s: string, _c: boolean, admit: () => void) => lane(admit),
    cancelMove: () => lane(() => undefined),
    takeOver: (_id: string, o: unknown, admit: () => void) => { r.takeOpts.push(o); return lane(admit); },
    keepMain: () => lane(() => undefined),
    streamingCopies: async () => [{ slot: 'slot_c', machine: 'copy.example', streaming: true }],
  };
});
vi.mock('../../src/instance/fleetMove', async (o) => ({
  ...(await o<typeof import('../../src/instance/fleetMove')>()),
  receiveMain: () => r.lane!(() => undefined),
  pushMain: (_id: string, _c: string, _f: boolean, admit: () => void) => r.lane!(admit),
}));
vi.mock('../../src/instance/fleetReplica', async (o) => ({
  ...(await o<typeof import('../../src/instance/fleetReplica')>()),
  adoptPromotedReplica: async () => { r.adoptCalls++; return r.adopt; },
}));

import * as fs from 'fs';
import * as path from 'path';
import { createBotRoutes } from '../../src/webui/routes/bots';

const router = createBotRoutes({ clients: new Set() } as any);
const call = async (method: 'get' | 'post' | 'delete', routePath: string, body: unknown = {}, id = 'a', query: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
  const res: any = { statusCode: 200 };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  await layer.route.stack[layer.route.stack.length - 1].handle({ params: { id }, query, body }, res);
  return { status: res.statusCode, body: res.body };
};
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

beforeEach(() => {
  r.broadcasts = [];
  r.lane = null;
  r.adopt = { success: true };
  r.takeOpts = [];
  fs.writeFileSync(path.join(r.dir, 'instances.json'), JSON.stringify({ instances: {
    a: { id: 'a', sanitizedName: 'a', displayName: 'A', status: 'running', sourceUrl: 'https://example.invalid/x', createdAt: 'x', updatedAt: 'x',
      fleetDb: { containerName: 'a-pg', user: 'app', db: 'app', volume: 'v', handover: { mode: 'stream', phase: 'stopped', machine: 'copy.example', host: 'copy.example', port: 5434, cert: 'PEM', generation: 4, at: '2026-10-30T09:00:00.000Z' } } },
  } }));
});
afterAll(() => fs.rmSync(r.dir, { recursive: true, force: true }));

describe('W1: the synchronous shapes and statuses', () => {
  it('a missing slot or move code is 400', async () => {
    expect(await call('post', '/:id/fleet-handover', {})).toEqual({ status: 400, body: { success: false, error: 'slot is required' } });
    expect(await call('post', '/:id/fleet-push', { moveCode: ' ' })).toEqual({ status: 400, body: { success: false, error: 'moveCode is required' } });
  });
  it('an unknown bot is 404', async () => {
    expect(await call('post', '/:id/fleet-takeover', {}, 'zz')).toEqual({ status: 404, body: { success: false, error: 'Bot not found' } });
  });
  it('a refusal before the admit is its status with the text; a question carries needsConfirm', async () => {
    r.lane = async () => ({ success: false, status: 409, text: 'refused here' });
    expect(await call('post', '/:id/fleet-keep-main')).toEqual({ status: 409, body: { success: false, error: 'refused here' } });
    r.lane = async () => ({ success: false, status: 409, needsConfirm: true, text: 'Take over now?' });
    expect(await call('post', '/:id/fleet-takeover')).toEqual({ status: 409, body: { success: false, error: 'Take over now?', needsConfirm: true } });
  });
  it('a lane that ends before its admit answers its text (and the move code)', async () => {
    r.lane = async () => ({ success: true, text: 'Paste this move code', moveCode: 'smdbmove1.x' });
    expect(await call('post', '/:id/fleet-receive')).toEqual({ status: 200, body: { success: true, text: 'Paste this move code', moveCode: 'smdbmove1.x' } });
  });
});

describe('W2: an admitted lane answers its opId and ends with bot:switch', () => {
  it('the text reaches the browser by the push', async () => {
    r.lane = async admit => { admit(); await settle(); return { success: true, text: 'This machine is the main now' }; };
    const answered = await call('post', '/:id/fleet-handover', { slot: 'slot_c' });
    expect(answered.status).toBe(200);
    expect(answered.body).toEqual({ success: true, opId: expect.any(String) });
    await settle();
    await settle();
    const pushed = r.broadcasts.find(b => b.type === 'bot:switch');
    expect(pushed?.data).toMatchObject({ id: 'a', opId: answered.body.opId, success: true, text: 'This machine is the main now' });
  });
});

describe('W3: GET /fleet-switch', () => {
  it('the view of the records and the streaming copies', async () => {
    const got = await call('get', '/:id/fleet-switch');
    expect(got.body).toMatchObject({ success: true, copies: [{ slot: 'slot_c', machine: 'copy.example', streaming: true }], badges: [{ text: 'Handed over', danger: false }] });
    expect(got.body.lines[0]).toBe('Handed over to copy.example on 2026-10-30 09:00 UTC. This machine rejoins as its copy once copy.example is the main; last check: not checked yet.');
    expect(JSON.stringify(got.body)).not.toContain('PEM');
  });
});

describe('W9: POST /fleet-adopt-primary is gone (D46)', () => {
  it('W9: POST /fleet-adopt-primary is gone: the router passes it on, so Express answers 404, and no adopt runs', async () => {
    expect((router as any).stack.some((l: any) => l.route?.path === '/:id/fleet-adopt-primary')).toBe(false);
    const passedOn = await new Promise<boolean>(resolve => {
      const res: any = { statusCode: 200, headersSent: false, setHeader: () => undefined, getHeader: () => undefined };
      res.status = (c: number) => { res.statusCode = c; return res; };
      res.json = () => { resolve(false); return res; };
      res.send = () => { resolve(false); return res; };
      res.end = () => { resolve(false); return res; };
      (router as any).handle({ method: 'POST', url: '/a/fleet-adopt-primary', originalUrl: '/a/fleet-adopt-primary', headers: {}, query: {}, body: {} }, res, (err?: unknown) => resolve(!err));
    });
    expect(passedOn).toBe(true);
    expect(r.adoptCalls).toBe(0);
  });
});

describe('W13 (D67): the unchecked-mark confirm through the route', () => {
  it('confirmUnchecked reaches takeOver only when it is true, and the 409 answer carries confirmFlag', async () => {
    r.lane = async () => ({ success: false, status: 409, needsConfirm: true, confirmFlag: 'confirmUnchecked', text: 'Take over anyway?' });
    expect(await call('post', '/:id/fleet-takeover', { confirm: true })).toEqual({ status: 409, body: { success: false, error: 'Take over anyway?', needsConfirm: true, confirmFlag: 'confirmUnchecked' } });
    await call('post', '/:id/fleet-takeover', { confirm: true, confirmUnchecked: true });
    await call('post', '/:id/fleet-takeover', { confirm: true, confirmUnchecked: 'true' });
    expect(r.takeOpts).toEqual([
      { confirm: true, start: true, confirmUnchecked: false },
      { confirm: true, start: true, confirmUnchecked: true },
      { confirm: true, start: true, confirmUnchecked: false },
    ]);
  });
});
