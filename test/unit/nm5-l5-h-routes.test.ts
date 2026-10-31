import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'stream';

const r = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-l5-h-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    broadcasts: [] as Array<{ type: string; data: any }>,
    lane: null as null | ((admit: () => void) => Promise<any>),
    calls: [] as unknown[][],
    upload: null as null | ((res: any) => Promise<any>),
    download: null as any,
  };
});

vi.mock('../../src/webui/server', () => ({ broadcastToClients: (_w: unknown, type: string, data: unknown) => { r.broadcasts.push({ type, data }); } }));
vi.mock('../../src/casaos/detector', () => ({ getDeploymentMode: async () => 'docker' }));
vi.mock('../../src/webui/dbProbe', () => ({ probeDatabaseUrl: async () => ({ success: true, ok: true, probed: true }) }));
vi.mock('../../src/instance/fleetSwitch', async (o) => {
  const real = await o<typeof import('../../src/instance/fleetSwitch')>();
  return {
    ...real,
    handOverMain: (_id: string, slot: string, c: boolean, admit: () => void) => { r.calls.push(['handover', slot, c]); return r.lane!(admit); },
    cancelMove: (_id: string, c: boolean) => { r.calls.push(['cancel', c]); return r.lane!(() => undefined); },
    takeOver: (_id: string, o: unknown, admit: () => void) => { r.calls.push(['takeover', o]); return r.lane!(admit); },
    keepMain: () => { r.calls.push(['keep']); return r.lane!(() => undefined); },
    rejoinComposed: () => ({ success: true, rejoined: true }),
  };
});
vi.mock('../../src/instance/fleetMove', async (o) => ({
  ...(await o<typeof import('../../src/instance/fleetMove')>()),
  receiveMain: () => { r.calls.push(['receive']); return r.lane!(() => undefined); },
  stopReceiving: () => { r.calls.push(['stop']); return r.lane!(() => undefined); },
  pushMain: (_id: string, code: string, c: boolean, admit: () => void) => { r.calls.push(['push', code, c]); return r.lane!(admit); },
  moveOut: (_id: string, c: boolean) => { r.calls.push(['moveout', c]); return r.lane!(() => undefined); },
  downloadPath: () => r.download,
  receiveUpload: (_id: string, req: any) => r.upload!(req.res),
}));
vi.mock('../../src/instance/fleetReplica', async (o) => ({
  ...(await o<typeof import('../../src/instance/fleetReplica')>()),
  reseedStalePrimary: () => ({ success: true, reseeded: true }),
  fleetDbPasswordFallback: async () => undefined,
}));
vi.mock('../../src/instance/fleetReplication', async (o) => ({
  ...(await o<typeof import('../../src/instance/fleetReplication')>()),
  enableFleetReplication: async () => ({ success: true, addresses: 'ADDR' }),
  disableFleetReplication: async () => ({ success: true }),
}));
vi.mock('../../src/instance/fleetJoin', async (o) => ({
  ...(await o<typeof import('../../src/instance/fleetJoin')>()),
  addressesText: (a: unknown) => (a ? `offered ${a}` : ''),
}));

import * as fs from 'fs';
import * as path from 'path';
import { createBotRoutes } from '../../src/webui/routes/bots';

const router = createBotRoutes({ clients: new Set() } as any);
const handlerOf = (method: string, routePath: string) => {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};
const call = async (method: 'get' | 'post' | 'delete', routePath: string, body: unknown = {}, query: Record<string, string> = {}, params: any = { id: 'a' }): Promise<{ status: number; body: any }> => {
  const res: any = { statusCode: 200 };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  await handlerOf(method, routePath)({ params, query, body }, res);
  return { status: res.statusCode, body: res.body };
};
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const crash = { status: 500, body: { success: false, error: "TypeError: Cannot read properties of null (reading 'id')" } };

beforeEach(() => {
  r.broadcasts = [];
  r.lane = null;
  r.calls = [];
  fs.writeFileSync(path.join(r.dir, 'instances.json'), JSON.stringify({ instances: {
    a: { id: 'a', sanitizedName: 'a', displayName: 'A', status: 'running', sourceUrl: 'https://example.invalid/x', createdAt: 'x', updatedAt: 'x',
      fleetDb: { containerName: 'a-pg', user: 'app', db: 'app', volume: 'v' } },
  } }));
});
afterAll(() => fs.rmSync(r.dir, { recursive: true, force: true }));

describe('H1: validate-db refuses a move code without probing', () => {
  it('answers the move-code text; a plain address is probed', async () => {
    expect(await call('post', '/:id/validate-db', { url: ' smdbmove1.abc ' })).toEqual({ status: 200, body: { success: true, ok: false, notTested: true, error: 'This is a move code, not a database address; paste it into Push the main in the Database window of the machine that holds the main.' } });
    expect((await call('post', '/:id/validate-db', { url: 'postgres://u@h/d' })).body).toMatchObject({ ok: true });
  });
});

describe('H2: fleet-replication offers the addresses text', () => {
  it('carries addressesText only when there is one', async () => {
    expect((await call('post', '/:id/fleet-replication', { enabled: true, publicHost: 'h.example' })).body).toEqual({ success: true, addresses: 'ADDR', addressesText: 'offered ADDR' });
    expect((await call('post', '/:id/fleet-replication', { enabled: false })).body).toEqual({ success: true });
  });
});

describe('H3: fleet-reseed with replaced', () => {
  it('rejoins only when replaced is true and the join code is empty', async () => {
    const rejoin = { status: 200, body: { success: true, rejoined: true } };
    const reseed = { status: 200, body: { success: true, reseeded: true } };
    const missing = { status: 400, body: { success: false, error: 'joinCode is required' } };
    expect(await call('post', '/:id/fleet-reseed', { replaced: true })).toEqual(rejoin);
    expect(await call('post', '/:id/fleet-reseed', { replaced: true, joinCode: '  ' })).toEqual(rejoin);
    expect(await call('post', '/:id/fleet-reseed', { replaced: true, joinCode: 'code' })).toEqual(reseed);
    expect(await call('post', '/:id/fleet-reseed', { replaced: false })).toEqual(missing);
    expect(await call('post', '/:id/fleet-reseed', {})).toEqual(missing);
  });
});

describe('H4: lane answers and pushes', () => {
  it('bot:switch carries the bot fields and the file', async () => {
    r.lane = async admit => { admit(); await settle(); return { success: true, text: 'Done', file: 'x.dump' }; };
    const answered = await call('post', '/:id/fleet-handover', { slot: 's1' });
    await settle(); await settle();
    const pushed = r.broadcasts.find(b => b.type === 'bot:switch');
    expect(pushed?.data).toMatchObject({ id: 'a', displayName: 'A', opId: answered.body.opId, success: true, text: 'Done', file: 'x.dump' });
  });
  it('a lane that ends before its admit broadcasts bot:updated and answers the file', async () => {
    r.lane = async () => ({ success: true, text: 'Saved here', file: 'y.dump' });
    expect(await call('post', '/:id/fleet-keep-main')).toEqual({ status: 200, body: { success: true, text: 'Saved here', file: 'y.dump' } });
    expect(r.broadcasts.map(b => b.type)).toEqual(['bot:updated']);
    expect(r.broadcasts[0].data).toMatchObject({ id: 'a', displayName: 'A' });
  });
});

describe('H5: each lane route passes its op name and its confirm', () => {
  const thrown = async () => { throw new Error('boom'); };
  const stopped = (op: string) => ({ status: 500, body: { success: false, error: `The ${op} stopped on an unexpected error: boom` } });
  it('the op names reach the error text', async () => {
    r.lane = thrown;
    expect(await call('post', '/:id/fleet-handover', { slot: 's1' })).toEqual(stopped('handover'));
    expect(await call('delete', '/:id/fleet-handover')).toEqual(stopped('handover'));
    expect(await call('post', '/:id/fleet-takeover')).toEqual(stopped('takeover'));
    expect(await call('post', '/:id/fleet-receive')).toEqual(stopped('receive'));
    expect(await call('delete', '/:id/fleet-receive')).toEqual(stopped('receive'));
    expect(await call('post', '/:id/fleet-push', { moveCode: 'm' })).toEqual(stopped('push'));
    expect(await call('post', '/:id/fleet-move-out')).toEqual(stopped('move-out'));
    expect(await call('post', '/:id/fleet-keep-main')).toEqual(stopped('keep-main'));
    expect(r.calls.map(c => c[0])).toEqual(['handover', 'cancel', 'takeover', 'receive', 'stop', 'push', 'moveout', 'keep']);
  });
  it('confirm is true only for the literal true (and ?confirm=1)', async () => {
    r.lane = async () => ({ success: false, status: 409, text: 'no' });
    await call('post', '/:id/fleet-handover', { slot: 's1', confirm: true });
    await call('post', '/:id/fleet-handover', { slot: 's1', confirm: 'true' });
    await call('delete', '/:id/fleet-handover', {}, { confirm: '1' });
    await call('delete', '/:id/fleet-handover', {}, { confirm: 'yes' });
    await call('delete', '/:id/fleet-handover', {}, {});
    await call('post', '/:id/fleet-takeover', {});
    await call('post', '/:id/fleet-takeover', { confirm: true, start: false });
    await call('post', '/:id/fleet-push', { moveCode: 'm', confirm: true });
    await call('post', '/:id/fleet-push', { moveCode: 'm', confirm: 1 });
    await call('post', '/:id/fleet-move-out', { confirm: true });
    await call('post', '/:id/fleet-move-out', { confirm: 'true' });
    expect(r.calls).toEqual([
      ['handover', 's1', true], ['handover', 's1', false],
      ['cancel', true], ['cancel', false], ['cancel', false],
      ['takeover', { confirm: false, start: true, confirmUnchecked: false }],
      ['takeover', { confirm: true, start: false, confirmUnchecked: false }],
      ['push', 'm', true], ['push', 'm', false],
      ['moveout', true], ['moveout', false],
    ]);
  });
  it('an error in the route answers 500 with its text', async () => {
    expect(await call('post', '/:id/fleet-handover', { slot: 's1' }, {}, null)).toEqual(crash);
    expect(await call('delete', '/:id/fleet-handover', {}, {}, null)).toEqual(crash);
    expect(await call('post', '/:id/fleet-takeover', {}, {}, null)).toEqual(crash);
    expect(await call('post', '/:id/fleet-receive', {}, {}, null)).toEqual(crash);
    expect(await call('delete', '/:id/fleet-receive', {}, {}, null)).toEqual(crash);
    expect(await call('post', '/:id/fleet-push', { moveCode: 'm' }, {}, null)).toEqual(crash);
    expect(await call('post', '/:id/fleet-move-out', {}, {}, null)).toEqual(crash);
    expect(await call('post', '/:id/fleet-keep-main', {}, {}, null)).toEqual(crash);
    expect(await call('get', '/:id/fleet-switch', {}, {}, null)).toEqual(crash);
  });
});

describe('H6: the backup download', () => {
  const download = async (id: string, done: (res: any) => boolean) => {
    const res: any = new PassThrough();
    res.statusCode = 200;
    res.headers = {} as Record<string, string>;
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    handlerOf('get', '/:id/fleet-backups/:file/download')({ params: { id, file: 'b.dump' }, query: {} }, res);
    for (let i = 0; i < 50 && !done(res); i++) await settle();
    return { res, data: Buffer.concat(chunks).toString() };
  };
  it('an unknown bot is 404', async () => {
    const { res } = await download('zz', () => true);
    expect([res.statusCode, res.body]).toEqual([404, { success: false, error: 'Bot not found' }]);
  });
  it('a refused file answers its status and error', async () => {
    r.download = { ok: false, status: 410, error: 'That backup is gone' };
    const { res } = await download('a', () => true);
    expect([res.statusCode, res.body]).toEqual([410, { success: false, error: 'That backup is gone' }]);
  });
  it('a file streams with its headers', async () => {
    const file = path.join(r.dir, 'b.dump');
    fs.writeFileSync(file, 'DUMPDATA');
    r.download = { ok: true, path: file };
    const { res, data } = await download('a', x => x.writableEnded);
    expect(data).toBe('DUMPDATA');
    expect(res.headers).toEqual({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="b.dump"' });
  });
  it('a read error destroys the response', async () => {
    r.download = { ok: true, path: path.join(r.dir, 'missing.dump') };
    const { res } = await download('a', x => x.destroyed);
    expect(res.destroyed).toBe(true);
  });
});

describe('H7: the backup upload answers once', () => {
  const upload = async (impl: (res: any) => Promise<any>, params: any = { id: 'a' }) => {
    r.upload = impl;
    const res: any = { statusCode: 200, headersSent: false, writableEnded: false, sent: [] as unknown[] };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.sent.push([res.statusCode, b]); return res; };
    await handlerOf('post', '/:id/fleet-backups/upload')({ params, query: {}, res }, res);
    return res.sent;
  };
  it('the outcome is sent only while nothing was sent', async () => {
    expect(await upload(async () => ({ status: 201, body: { success: true } }))).toEqual([[201, { success: true }]]);
    expect(await upload(async res => { res.headersSent = true; return { status: 201, body: {} }; })).toEqual([]);
    expect(await upload(async res => { res.writableEnded = true; return { status: 201, body: {} }; })).toEqual([]);
  });
  it('an error answers 500 unless headers went out', async () => {
    expect(await upload(async () => { throw new Error('disk'); })).toEqual([[500, { success: false, error: 'Error: disk' }]]);
    expect(await upload(async res => { res.headersSent = true; throw new Error('disk'); })).toEqual([]);
  });
});
