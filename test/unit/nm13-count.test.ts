import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm13-count-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    inspect: { err: null as string | null, out: 'true\n' },
    settings: { code: 0, out: '100|3|0|true\n', err: '' },
    nodes: { code: 0, out: '[]\n', err: '' },
    sql: [] as string[],
  };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const execFile = (_cmd: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    setImmediate(() => args[0] === 'inspect' && h.inspect.err !== null
      ? done(new Error(h.inspect.err), '', h.inspect.err)
      : done(null, args[0] === 'inspect' ? h.inspect.out : '', ''));
    return {} as any;
  };
  const spawn = (_cmd: string, args: string[]) => {
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: () => true, end: () => undefined, on: () => undefined };
    child.kill = () => undefined;
    const sql = args[args.length - 1];
    h.sql.push(sql);
    const a = sql.includes("current_setting('max_connections')") ? h.settings
      : sql.includes('smdb_data.shard_nodes') ? h.nodes : { code: 0, out: '', err: '' };
    setImmediate(() => {
      if (a.out) child.stdout.emit('data', a.out);
      if (a.err) child.stderr.emit('data', a.err);
      child.emit('close', a.code);
    });
    return child;
  };
  const mod = { ...real, execFile, spawn };
  return { ...mod, default: mod };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import { BOT_PROCESS_CONNECTIONS, WEB_UI_CONNECTIONS, connectionReading, fleetConnectionCount } from '../../src/instance/fleetReplication';
import { createBotRoutes } from '../../src/webui/routes/bots';

const inst = { id: 'a', sanitizedName: 'a', fleetDb: { containerName: 'a-pg', user: 'app', db: 'app', volume: 'v' } } as any;
const node = (restartable: boolean, overlap: boolean) => ({ restartable, overlap });

beforeEach(() => {
  h.sql = [];
  h.inspect = { err: null, out: 'true\n' };
  h.settings = { code: 0, out: '100|3|0|true\n', err: '' };
  h.nodes = { code: 0, out: '[]\n', err: '' };
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances: { a: inst } }));
});
afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));

describe('CN1: fleetConnectionCount', () => {
  it('the constants', () => {
    expect(BOT_PROCESS_CONNECTIONS).toBe(19);
    expect(WEB_UI_CONNECTIONS).toBe(6);
  });
  it('no nodes', () => {
    expect(fleetConnectionCount([])).toEqual({ count: 0, overlap: false });
  });
  it('one node with the web UI and overlap: 19 + 6 + 19', () => {
    expect(fleetConnectionCount([node(true, true)])).toEqual({ count: 44, overlap: true });
  });
  it('one node without the web UI: 19, no standby', () => {
    expect(fleetConnectionCount([node(false, true)])).toEqual({ count: 19, overlap: false });
  });
  it('two nodes, one with overlap false', () => {
    expect(fleetConnectionCount([node(true, true), node(true, false)])).toEqual({ count: 50, overlap: false });
  });
  it('three nodes with the web UI and overlap', () => {
    expect(fleetConnectionCount([node(true, true), node(true, true), node(true, true)])).toEqual({ count: 132, overlap: true });
  });
});

describe('CN2: connectionReading', () => {
  it('none: no fleetDb', async () => {
    expect(await connectionReading({ id: 'b', sanitizedName: 'b' } as any)).toEqual({ state: 'none' });
  });
  it('none: the database container is not running', async () => {
    h.inspect = { err: null, out: 'false\n' };
    expect(await connectionReading(inst)).toEqual({ state: 'none' });
  });
  it('none: docker cannot say', async () => {
    h.inspect = { err: 'Cannot connect to the Docker daemon', out: '' };
    expect(await connectionReading(inst)).toEqual({ state: 'none' });
  });
  it('none: no shard_nodes table, and the rows are not asked', async () => {
    h.settings.out = '100|3|0|false\n';
    expect(await connectionReading(inst)).toEqual({ state: 'none' });
    expect(h.sql.some(s => s.includes('json_agg'))).toBe(false);
  });
  it('none: no row in the last 7 days', async () => {
    expect(await connectionReading(inst)).toEqual({ state: 'none' });
    expect(h.sql.find(s => s.includes('json_agg'))).toContain("interval '7 days'");
  });
  it('unread: the settings psql fails', async () => {
    h.settings = { code: 2, out: '', err: 'first\npsql: connection refused\n' };
    expect(await connectionReading(inst)).toEqual({ state: 'unread', error: 'the database did not answer (psql: connection refused)' });
  });
  it('unread: a psql fails with no stderr', async () => {
    h.nodes = { code: 1, out: '', err: '' };
    expect(await connectionReading(inst)).toEqual({ state: 'unread', error: 'the database did not answer (no answer)' });
  });
  it('unread: settings output that does not parse', async () => {
    h.settings.out = 'garbage\n';
    expect(await connectionReading(inst)).toEqual({ state: 'unread', error: 'the database answered in a form the manager does not read' });
  });
  it('unread: rows output that does not parse', async () => {
    h.nodes.out = '{not json\n';
    expect(await connectionReading(inst)).toEqual({ state: 'unread', error: 'the database answered in a form the manager does not read' });
    h.nodes.out = '[{"restartable":"yes","overlap":true}]\n';
    expect(await connectionReading(inst)).toEqual({ state: 'unread', error: 'the database answered in a form the manager does not read' });
  });
  it('read: three machines over the default 100 with 3 reserved', async () => {
    h.nodes.out = `${JSON.stringify([node(true, true), node(true, true), node(true, true)])}\n`;
    expect(await connectionReading(inst)).toEqual({ state: 'read', machines: 3, count: 132, overlap: true, max: 100, reserved: 3, allowed: 97 });
  });
  it('read: reserved_connections adds to the reserved places', async () => {
    h.settings.out = '200|3|5|true\n';
    h.nodes.out = `${JSON.stringify([node(false, false)])}\n`;
    expect(await connectionReading(inst)).toEqual({ state: 'read', machines: 1, count: 19, overlap: false, max: 200, reserved: 8, allowed: 192 });
  });
});

describe('CN3: GET /:id/fleet-connections', () => {
  const router = createBotRoutes({ clients: new Set() } as any);
  const call = async (id: string): Promise<{ status: number; body: any }> => {
    const layer = (router as any).stack.find((l: any) => l.route?.path === '/:id/fleet-connections' && l.route.methods.get);
    const res: any = { statusCode: 200 };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    await layer.route.stack[layer.route.stack.length - 1].handle({ params: { id }, query: {}, body: {} }, res);
    return { status: res.statusCode, body: res.body };
  };
  it('an unknown bot: 404', async () => {
    expect(await call('zz')).toEqual({ status: 404, body: { success: false, error: 'Bot not found' } });
  });
  it('a known bot: the reading', async () => {
    h.nodes.out = `${JSON.stringify([node(true, true)])}\n`;
    expect(await call('a')).toEqual({ status: 200, body: { success: true, connections: { state: 'read', machines: 1, count: 44, overlap: true, max: 100, reserved: 3, allowed: 97 } } });
  });
});
