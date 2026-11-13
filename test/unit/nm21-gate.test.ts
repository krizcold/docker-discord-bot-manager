import { afterAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm21-gate-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  nodeFs.writeFileSync(nodePath.join(dir, 'instances.json'), JSON.stringify({ instances: {
    a: { id: 'a', displayName: 'a', sanitizedName: 'bot-a', status: 'stopped', sourceType: 'docker-image', updateToken: 'tok-a' },
  } }, null, 2));
  return { dir, docker: [] as string[] };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const exec = (cmd: string, opts: any, cb?: any) => { tmp.docker.push(cmd); (typeof opts === 'function' ? opts : cb)(null, { stdout: '', stderr: '' }); };
  const execFile = (_c: string, args: string[], opts: any, cb?: any) => { tmp.docker.push(args.join(' ')); (typeof opts === 'function' ? opts : cb)(null, '', ''); };
  return { ...real, exec, execFile, default: { ...real, exec, execFile } };
});

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import WebSocket from 'ws';
import YAML from 'yaml';
import * as containerManager from '../../src/docker/containerManager';
import { createServer } from '../../src/webui/server';
import { createGate, initGate, readGateAddresses, type Gate } from '../../src/webui/gate';

afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

const NET = 'discordbotmanager_internal';
const SHIELD = { remote: '172.19.0.2', local: '::ffff:172.19.0.3' };
const PCS = { remote: '172.20.0.8', local: '::ffff:172.20.0.4' };
const UNREAD = 'The manager refused this request: it could not read its own address on the network discordbotmanager_internal, so it cannot tell its AppShield from other apps. It reads it again at most every 30 seconds; reload in a minute, and restart the app if this stays.';
const NOT_SET = 'The manager refused this request: MANAGER_GATE_NETWORK is not set, so it cannot tell its AppShield from other apps on this machine. Update the app; its compose sets it.';

type Addr = { remote: string; local: string };
type Served = { port: number; at: Addr; close: () => Promise<void> };

async function serve(gate: Gate): Promise<Served> {
  const { server, wss } = createServer(gate);
  const served: any = { at: SHIELD };
  server.prependListener('connection', (s: any) => {
    Object.defineProperty(s, 'remoteAddress', { value: served.at.remote, configurable: true });
    Object.defineProperty(s, 'localAddress', { value: served.at.local, configurable: true });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  served.port = (server.address() as any).port;
  served.close = () => new Promise<void>((r) => { wss.clients.forEach((c) => c.terminate()); server.close(() => r()); server.closeAllConnections?.(); });
  return served;
}

async function call(s: Served, at: Addr, method: string, url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any; text: string }> {
  s.at = at;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: s.port, method, path: url, agent: false, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let body: any;
        try { body = JSON.parse(text); } catch { body = undefined; }
        resolve({ status: res.statusCode || 0, body, text });
      });
    });
    req.on('error', reject);
    req.end(method === 'GET' ? undefined : '{}');
  });
}

async function wsOpens(s: Served, at: Addr, headers: Record<string, string> = {}): Promise<boolean> {
  s.at = at;
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`, { headers });
    ws.on('open', () => { ws.close(); resolve(true); });
    ws.on('error', () => resolve(false));
    ws.on('close', () => resolve(false));
  });
}

const forbidden = (r: { status: number; body: any }, error = 'Forbidden') => {
  expect(r.status).toBe(403);
  expect(r.body).toEqual({ success: false, error });
};

describe('NM21: on Yundera the manager answers only through its AppShield', () => {
  let s: Served;
  it('setup', async () => {
    const gate = createGate({ secret: '', network: NET, failClosed: true, readAddresses: async () => ['172.19.0.3/16'] });
    await gate.refresh();
    expect(gate.active).toBe(true);
    s = await serve(gate);
  });

  it('1. AppShield gets the API and the page', async () => {
    expect((await call(s, SHIELD, 'GET', '/api/health')).status).toBe(200);
    expect((await call(s, SHIELD, 'GET', '/api/bots')).status).toBe(200);
    const page = await call(s, SHIELD, 'GET', '/');
    expect(page.status).toBe(200);
    expect(page.text).toMatch(/<html/i);
  });

  it('2. another app on pcs is refused everywhere', async () => {
    forbidden(await call(s, PCS, 'GET', '/api/health'));
    forbidden(await call(s, PCS, 'GET', '/api/bots'));
    forbidden(await call(s, PCS, 'GET', '/'));
    forbidden(await call(s, PCS, 'POST', '/api/bots'));
    forbidden(await call(s, PCS, 'PUT', '/api/system/deployment'));
  });

  it('3. loopback passes whatever address it arrived on', async () => {
    expect((await call(s, { remote: '127.0.0.1', local: PCS.local }, 'GET', '/api/health')).status).toBe(200);
  });

  it('4. /ws opens from AppShield and not from pcs', async () => {
    expect(await wsOpens(s, PCS)).toBe(false);
    expect(await wsOpens(s, SHIELD)).toBe(true);
  });

  it('5. hooks from pcs pass only with a token, on their own method', async () => {
    const pull = vi.spyOn(containerManager, 'pullAndRebuild').mockResolvedValue({ success: true } as any);
    const tok = { 'x-bot-token': 'tok-a' };
    const wrong = { 'x-bot-token': 'wrong' };
    expect((await call(s, PCS, 'GET', '/api/bots/a/updates', tok)).status).toBe(200);
    forbidden(await call(s, PCS, 'GET', '/api/bots/a/updates', wrong), 'Invalid bot token');
    forbidden(await call(s, PCS, 'GET', '/api/bots/a/updates'));
    const ready = await call(s, PCS, 'POST', '/api/bots/a/webui-ready', tok);
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ success: true });
    forbidden(await call(s, PCS, 'POST', '/api/bots/a/webui-ready', wrong), 'Invalid token');
    forbidden(await call(s, PCS, 'POST', '/api/bots/a/webui-ready'));
    expect((await call(s, PCS, 'POST', '/api/bots/a/request-update', tok)).status).toBe(200);
    forbidden(await call(s, PCS, 'POST', '/api/bots/a/request-update', wrong), 'Invalid token');
    forbidden(await call(s, PCS, 'POST', '/api/bots/a/request-update'));
    forbidden(await call(s, PCS, 'POST', '/api/bots/a/updates', tok));
    forbidden(await call(s, PCS, 'GET', '/api/bots/a/webui-ready', tok));
    forbidden(await call(s, PCS, 'GET', '/api/bots/a/updates/x', tok));
    expect(await wsOpens(s, PCS, tok)).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(pull).toHaveBeenCalledTimes(1);
    pull.mockRestore();
    await s.close();
  });
});

describe('NM21: the other platforms', () => {
  it('6. Linux: the gateway header passes, the hooks pass with a token', async () => {
    const s = await serve(createGate({ secret: 's3cret', network: '', failClosed: false, readAddresses: async () => [] }));
    expect((await call(s, PCS, 'GET', '/api/bots', { 'x-dbm-gateway': 's3cret' })).status).toBe(200);
    forbidden(await call(s, PCS, 'GET', '/api/bots', { 'x-dbm-gateway': 'nope' }));
    forbidden(await call(s, PCS, 'GET', '/api/bots'));
    expect((await call(s, PCS, 'POST', '/api/bots/a/webui-ready', { 'x-bot-token': 'tok-a' })).status).toBe(200);
    await s.close();
  });

  it('7. no setting off CasaOS: the gate is off', async () => {
    const gate = createGate({ secret: '', network: '', failClosed: false, readAddresses: async () => [] });
    expect(gate.active).toBe(false);
    const s = await serve(gate);
    expect((await call(s, PCS, 'GET', '/api/bots')).status).toBe(200);
    await s.close();
  });

  it('8. fail closed with no setting: only loopback and hooks', async () => {
    const s = await serve(createGate({ secret: '', network: '', failClosed: true, readAddresses: async () => ['172.19.0.3/16'] }));
    forbidden(await call(s, PCS, 'GET', '/api/bots'), NOT_SET);
    forbidden(await call(s, SHIELD, 'GET', '/api/bots'), NOT_SET);
    expect((await call(s, { remote: '127.0.0.1', local: '127.0.0.1' }, 'GET', '/api/bots')).status).toBe(200);
    expect((await call(s, PCS, 'POST', '/api/bots/a/webui-ready', { 'x-bot-token': 'tok-a' })).status).toBe(200);
    await s.close();
  });

  it('9. an unread address refuses, re-reads at most every 30 s, and heals', async () => {
    let t = 1_000_000;
    let answer: string[] = [];
    let reads = 0;
    let last: Promise<string[]> = Promise.resolve([]);
    const logs: string[] = [];
    const gate = createGate({
      secret: '', network: NET, failClosed: true, now: () => t, log: (l) => logs.push(l),
      readAddresses: (n) => { reads++; expect(n).toBe(NET); last = Promise.resolve([...answer]); return last; },
    });
    await gate.refresh();
    expect(reads).toBe(1);
    const s = await serve(gate);
    forbidden(await call(s, SHIELD, 'GET', '/api/bots'), UNREAD);
    t += 29_999;
    forbidden(await call(s, SHIELD, 'GET', '/api/bots'), UNREAD);
    forbidden(await call(s, PCS, 'GET', '/api/bots'), UNREAD);
    expect(reads).toBe(1);
    t += 1;
    answer = ['172.19.0.3/16'];
    forbidden(await call(s, SHIELD, 'GET', '/api/bots'), UNREAD);
    expect(reads).toBe(2);
    await last;
    await new Promise((r) => setTimeout(r, 0));
    expect((await call(s, SHIELD, 'GET', '/api/bots')).status).toBe(200);
    forbidden(await call(s, PCS, 'GET', '/api/bots'));
    expect(logs.filter((l) => l === `[Gate] Read this container's address on the network ${NET}: its requests are accepted again`)).toHaveLength(1);
    await s.close();
  });

  it('10. the local address is normalized before it is compared', async () => {
    const gate = createGate({ secret: '', network: NET, failClosed: true, readAddresses: async () => ['172.19.0.3/16'] });
    await gate.refresh();
    const s = await serve(gate);
    expect((await call(s, { remote: '172.19.0.2', local: '172.19.0.3' }, 'GET', '/api/bots')).status).toBe(200);
    expect((await call(s, { remote: '172.19.0.2', local: '::ffff:172.19.0.3' }, 'GET', '/api/bots')).status).toBe(200);
    forbidden(await call(s, { remote: '172.19.0.2', local: '::ffff:172.19.0.30' }, 'GET', '/api/bots'));
    await s.close();
  });

  it('11. readGateAddresses reads only the named network', async () => {
    const json = '{"discordbotmanager_internal":{"IPAddress":"172.19.0.3","IPPrefixLen":16,"GlobalIPv6Address":""},"pcs":{"IPAddress":"172.20.0.4","GlobalIPv6Address":""}}';
    expect(await readGateAddresses(NET, async () => json)).toEqual(['172.19.0.3/16']);
    expect(await readGateAddresses('other', async () => json)).toEqual([]);
    expect(await readGateAddresses(NET, async () => { throw new Error('no docker'); })).toEqual([]);
    expect(await readGateAddresses(NET, (() => { throw new Error('sync'); }) as any)).toEqual([]);
    expect(await readGateAddresses(NET, async () => 'not json')).toEqual([]);
  });

  it('12. initGate picks the gate from the env and the mode', async () => {
    const read = async () => ['172.19.0.3/16'];
    const off = await initGate({ env: {}, mode: async () => 'docker', readAddresses: read });
    expect(off.active).toBe(false);
    for (const mode of [async () => 'casaos' as const, async () => { throw new Error('unreadable'); }]) {
      const g = await initGate({ env: {}, mode: mode as any, readAddresses: read });
      const s = await serve(g);
      forbidden(await call(s, PCS, 'GET', '/api/bots'), NOT_SET);
      await s.close();
    }
    const on = await initGate({ env: { MANAGER_GATE_NETWORK: NET }, mode: async () => 'casaos', readAddresses: read });
    const s = await serve(on);
    expect((await call(s, SHIELD, 'GET', '/api/bots')).status).toBe(200);
    forbidden(await call(s, PCS, 'GET', '/api/bots'));
    await s.close();
  });

  it('14. the internal address reached from another network is refused', async () => {
    const gate = createGate({ secret: '', network: NET, failClosed: true, readAddresses: async () => ['172.19.0.3/16'] });
    await gate.refresh();
    const s = await serve(gate);
    forbidden(await call(s, { remote: '172.20.0.8', local: '::ffff:172.19.0.3' }, 'GET', '/api/bots'));
    forbidden(await call(s, { remote: '172.20.0.8', local: '172.19.0.3' }, 'GET', '/'));
    expect(await wsOpens(s, { remote: '172.20.0.8', local: '::ffff:172.19.0.3' })).toBe(false);
    await s.close();
  });

  it('15. a remote address inside the subnet passes, also IPv4-mapped', async () => {
    const gate = createGate({ secret: '', network: NET, failClosed: true, readAddresses: async () => ['172.19.0.3/16'] });
    await gate.refresh();
    const s = await serve(gate);
    expect((await call(s, { remote: '172.19.200.9', local: '172.19.0.3' }, 'GET', '/api/bots')).status).toBe(200);
    expect((await call(s, { remote: '::ffff:172.19.0.2', local: '::ffff:172.19.0.3' }, 'GET', '/api/bots')).status).toBe(200);
    forbidden(await call(s, { remote: '::ffff:172.20.0.8', local: '::ffff:172.19.0.3' }, 'GET', '/api/bots'));
    await s.close();
  });

  it('16. the subnet edges', async () => {
    const gate = createGate({ secret: '', network: NET, failClosed: true, readAddresses: async () => ['172.19.0.3/24'] });
    await gate.refresh();
    const s = await serve(gate);
    const local = '172.19.0.3';
    expect((await call(s, { remote: '172.19.0.0', local }, 'GET', '/api/bots')).status).toBe(200);
    expect((await call(s, { remote: '172.19.0.255', local }, 'GET', '/api/bots')).status).toBe(200);
    forbidden(await call(s, { remote: '172.18.255.255', local }, 'GET', '/api/bots'));
    forbidden(await call(s, { remote: '172.19.1.0', local }, 'GET', '/api/bots'));
    await s.close();
  });

  it('17. an inspect with no prefix length cannot place a request: refused as unread', async () => {
    const json = '{"discordbotmanager_internal":{"IPAddress":"172.19.0.3","GlobalIPv6Address":""}}';
    expect(await readGateAddresses(NET, async () => json)).toEqual([]);
    const gate = createGate({ secret: '', network: NET, failClosed: true, readAddresses: (n) => readGateAddresses(n, async () => json) });
    await gate.refresh();
    const s = await serve(gate);
    forbidden(await call(s, SHIELD, 'GET', '/api/bots'), UNREAD);
    await s.close();
  });

  it('13. the Yundera compose routes AppShield to the gate alias', () => {
    const root = path.join(__dirname, '..', '..');
    const y = YAML.parse(fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8'));
    const app = y.services.discordbotmanagerapp;
    expect(app.environment.MANAGER_GATE_NETWORK).toBe(y.networks.internal.name);
    expect(app.networks.internal.aliases).toContain(y.services.discordbotmanager.environment.BACKEND_HOST);
    expect(app.networks.pcs?.aliases).toBeUndefined();
    for (const f of ['docker-compose.remote.yml', 'docker-compose.standalone.yml']) {
      const other = YAML.parse(fs.readFileSync(path.join(root, f), 'utf8'));
      for (const svc of Object.values<any>(other.services)) {
        const env = svc.environment || {};
        const keys = Array.isArray(env) ? env.map((e: string) => e.split('=')[0]) : Object.keys(env);
        expect(keys).not.toContain('MANAGER_GATE_NETWORK');
      }
    }
  });
});
