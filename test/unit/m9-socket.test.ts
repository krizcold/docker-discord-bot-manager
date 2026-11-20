import { afterAll, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'm9-socket-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  process.env.PORT = '0';
  delete process.env.MANAGER_SOCKET;
  delete process.env.MANAGER_SOCKET_OWNER;
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
import * as net from 'net';
import * as path from 'path';
import WebSocket from 'ws';
import { broadcastToClients, createServer, startLocalSocket, startServer } from '../../src/webui/server';
import { listenLocal, socketOwner } from '../../src/webui/localSocket';
import { createGate, type Gate } from '../../src/webui/gate';
import { Client, LoopbackError, resolveTarget } from '../../src/cli/client';
import { isReservedName, sanitizeName } from '../../src/naming';
import { RESERVED_NAMES } from '../../src/types';

afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

const WIN = process.platform === 'win32';
const PCS = { remote: '172.20.0.8', local: '::ffff:172.20.0.4' };
let seq = 0;
const sockPath = (): string => {
  seq += 1;
  return WIN ? `\\\\.\\pipe\\m9-${process.pid}-${seq}` : path.join(tmp.dir, `s${seq}.sock`);
};

const closedGate = (): Gate => createGate({ secret: '', network: '', failClosed: true, readAddresses: async () => [] });

type Served = { port: number; sock: string; server: http.Server; local: http.Server; wss: any; close: () => Promise<void> };

async function serve(gate: Gate, remote: string | null = PCS.remote): Promise<Served> {
  const { server, local, wss } = createServer(gate);
  server.prependListener('connection', (s: any) => {
    Object.defineProperty(s, 'remoteAddress', { value: remote ?? undefined, configurable: true });
    Object.defineProperty(s, 'localAddress', { value: PCS.local, configurable: true });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const sock = sockPath();
  await new Promise<void>((r) => local.listen(sock, () => r()));
  const close = async () => {
    wss.clients.forEach((c: any) => c.terminate());
    for (const s of [server, local]) {
      await new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections?.(); });
    }
  };
  return { port: (server.address() as any).port, sock, server, local, wss, close };
}

function get(target: { port: number } | { socketPath: string }, url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const where = 'port' in target ? { host: '127.0.0.1', port: target.port } : { socketPath: target.socketPath };
    const req = http.request({ ...where, method: 'GET', path: url, agent: false, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let body: any;
        try { body = JSON.parse(text); } catch { body = undefined; }
        resolve({ status: res.statusCode || 0, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// 'refused' only when the client saw an error or a close; a socket left hanging is 'no answer'.
function wsOutcome(url: string, opts: Record<string, unknown> = {}): Promise<'open' | 'refused' | 'no answer'> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, opts);
    const timer = setTimeout(() => { resolve('no answer'); ws.terminate(); }, 1500);
    const settle = (v: 'open' | 'refused') => { clearTimeout(timer); resolve(v); };
    ws.on('open', () => { ws.close(); settle('open'); });
    ws.on('error', () => settle('refused'));
    ws.on('close', () => settle('refused'));
  });
}

function probeSocket() {
  const sock: any = new EventEmitter();
  sock.destroyed = false;
  sock.destroy = () => { sock.destroyed = true; };
  return sock;
}
const socketStat = { isSocket: () => true };

type Call = [string, ...unknown[]];
function fakeFs(calls: Call[], over: Record<string, (...a: any[]) => any> = {}) {
  return {
    lstatSync: (p: string) => { calls.push(['lstat', p]); const e: any = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
    unlinkSync: (p: string) => { calls.push(['unlink', p]); },
    chmodSync: (p: string, mode: number) => { calls.push(['chmod', p, mode]); },
    chownSync: (p: string, uid: number, gid: number) => { calls.push(['chown', p, uid, gid]); },
    ...over,
  } as any;
}

const closeServer = (s: http.Server) => new Promise<void>((r) => { if (!s.listening) return r(); s.close(() => r()); s.closeAllConnections?.(); });

describe("M9: the manager's local socket", () => {
  let s: Served;
  it('setup', async () => {
    const gate = closedGate();
    expect(gate.active).toBe(true);
    s = await serve(gate);
  });

  it('1. the API answers on the local socket under a gate that accepts nothing else', async () => {
    expect((await get({ socketPath: s.sock }, '/api/health')).status).toBe(200);
    const bots = await get({ socketPath: s.sock }, '/api/bots');
    expect(bots.status).toBe(200);
    expect(bots.body.success).toBe(true);
  });

  it('2. TCP from pcs stays refused, beside an open local connection and with any header', async () => {
    expect((await get({ port: s.port }, '/api/health')).status).toBe(403);
    expect((await get({ port: s.port }, '/api/bots')).status).toBe(403);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const held = await new Promise<number>((resolve, reject) => {
      const req = http.request({ socketPath: s.sock, path: '/api/health', agent }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode || 0)); });
      req.on('error', reject);
      req.end();
    });
    const openLocal = await new Promise<number>((r) => s.local.getConnections((_e, n) => r(n)));
    const during = await get({ port: s.port }, '/api/bots');
    const headers = {
      'x-dbm-gateway': 'x', 'x-dbm-local': '1', 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1',
      forwarded: 'for=127.0.0.1', 'remote-user': 'admin', host: 'localhost',
    };
    const withHeaders = await get({ port: s.port }, '/api/bots', headers);
    agent.destroy();
    expect(held).toBe(200);
    expect(openLocal).toBeGreaterThanOrEqual(1);
    expect(during.status).toBe(403);
    expect(withHeaders.status).toBe(403);
    expect(withHeaders.body).toEqual({ success: false, error: 'The manager refused this request: MANAGER_GATE_NETWORK is not set, so it cannot tell its AppShield from other apps on this machine. Update the app; its compose sets it.' });
  });

  it('3. /ws opens on the local socket and not over TCP from pcs', async () => {
    expect(await wsOutcome('ws://localhost/ws', { createConnection: () => net.connect(s.sock) })).toBe('open');
    expect(await wsOutcome(`ws://127.0.0.1:${s.port}/ws`)).toBe('refused');
    expect(await wsOutcome('ws://localhost/other', { createConnection: () => net.connect(s.sock) })).toBe('refused');
  });

  it('3b. a TCP connection whose address is missing gets no bypass: 403 and a refused /ws', async () => {
    const noAddress = await serve(closedGate(), null);
    const seen: unknown[] = [];
    noAddress.server.on('request', (req) => seen.push(req.socket.remoteAddress));
    const health = await get({ port: noAddress.port }, '/api/health');
    const bots = await get({ port: noAddress.port }, '/api/bots');
    const ws = await wsOutcome(`ws://127.0.0.1:${noAddress.port}/ws`);
    const onSocket = await get({ socketPath: noAddress.sock }, '/api/health');
    await noAddress.close();
    expect(seen).toEqual([undefined, undefined]);
    expect(health.status).toBe(403);
    expect(bots.status).toBe(403);
    expect(ws).toBe('refused');
    expect(onSocket.status).toBe(200);
  });

  it('10. Client on the socket: a GET, a POST with a body, an SSE read', async () => {
    const c = new Client({ socketPath: s.sock });
    const health = await c.request('GET', '/api/health');
    expect(health.status).toBe(200);
    expect((health.body as any).status).toBe('ok');
    const post = await c.request('POST', '/api/bots', { body: { sourceType: 'docker-image', displayName: 'x' } });
    expect(post.status).toBe(400);
    expect(post.body).toEqual({ success: false, error: 'imageRef is required for docker-image source type' });
    const frames: unknown[] = [];
    const ended = await c.sse('/api/bots/a/build-logs', (f) => frames.push(f.data));
    expect(ended).toBe('end');
    expect(frames.length).toBeGreaterThan(0);
  });

  it('10b. an abort signal ends an SSE read on the socket as it does over TCP', async () => {
    const streams: http.ServerResponse[] = [];
    const closed: string[] = [];
    const handler = (name: string) => (_req: http.IncomingMessage, res: http.ServerResponse) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"n":1}\n\n');
      streams.push(res);
      res.on('close', () => closed.push(name));
    };
    const onSock = http.createServer(handler('socket'));
    const onTcp = http.createServer(handler('tcp'));
    const p = sockPath();
    await new Promise<void>((r) => onSock.listen(p, () => r()));
    await new Promise<void>((r) => onTcp.listen(0, '127.0.0.1', () => r()));
    const read = async (c: Client): Promise<{ outcome: string; frames: unknown[] }> => {
      const abort = new AbortController();
      const frames: unknown[] = [];
      const outcome = await c.sse('/x', (f) => { frames.push(f.data); abort.abort(); }, { signal: abort.signal })
        .then((v) => `resolved:${v}`, (e) => `rejected:${e?.name}`);
      return { outcome, frames };
    };
    const viaSocket = await read(new Client({ socketPath: p }));
    const viaTcp = await read(new Client({ host: '127.0.0.1', port: (onTcp.address() as any).port }));
    await vi.waitFor(() => { if (closed.length < 2) throw new Error('streams still open'); }, { timeout: 2000, interval: 20 });
    await closeServer(onSock);
    await closeServer(onTcp);
    expect(viaSocket.frames).toEqual([{ n: 1 }]);
    expect(viaSocket.outcome).toBe(viaTcp.outcome);
    expect(closed.sort()).toEqual(['socket', 'tcp']);
  });

  it('11. openWs on the socket receives a broadcast frame and closes', async () => {
    const c = new Client({ socketPath: s.sock });
    const got: Array<{ type: string; data: unknown }> = [];
    const lost: string[] = [];
    let opened = false;
    const before = s.wss.clients.size;
    const ws = c.openWs((m) => { if (m.type === 'm9:probe') got.push(m); }, () => { opened = true; }, (reason) => lost.push(reason));
    await vi.waitFor(() => { if (!opened) throw new Error('not open'); }, { timeout: 2000, interval: 20 });
    broadcastToClients(s.wss, 'm9:probe', { n: 7 });
    await vi.waitFor(() => { if (got.length === 0) throw new Error('no frame'); }, { timeout: 2000, interval: 20 });
    ws.close();
    await vi.waitFor(() => { if (s.wss.clients.size !== before) throw new Error('still connected'); }, { timeout: 2000, interval: 20 });
    expect(got[0].type).toBe('m9:probe');
    expect(got[0].data).toEqual({ n: 7 });
    expect(lost).toEqual([]);
  });

  it('teardown', async () => {
    await s.close();
  });

  it('4. socketOwner reads <uid>:<gid> and nothing else', () => {
    expect(socketOwner('1000:1000')).toEqual({ uid: 1000, gid: 1000 });
    expect(socketOwner('0:0')).toEqual({ uid: 0, gid: 0 });
    expect(socketOwner('1000:33')).toEqual({ uid: 1000, gid: 33 });
    for (const bad of ['', undefined, 'node', '1000', '-1:0', '1000:1000:1', '1000:', ':1000', ' 1000:1000', '1000:1000 ', '1e3:1', '0x10:1', '1.5:1']) {
      expect(socketOwner(bad)).toBeNull();
    }
  });

  it('5. listenLocal sets mode 0600, then the owner; with no owner it calls no chown', async () => {
    const calls: Call[] = [];
    const lines: string[] = [];
    const a = http.createServer();
    const pa = sockPath();
    const okA = await listenLocal(a, pa, { uid: 1000, gid: 1000 }, { fs: fakeFs(calls), log: (l) => lines.push(l) });
    const listeningA = a.listening;
    const callsB: Call[] = [];
    const b = http.createServer();
    const pb = sockPath();
    const okB = await listenLocal(b, pb, null, { fs: fakeFs(callsB), log: (l) => lines.push(l) });
    await closeServer(a);
    await closeServer(b);
    expect(okA).toBe(true);
    expect(listeningA).toBe(true);
    expect(calls).toEqual([['lstat', pa], ['chmod', pa, 0o600], ['chown', pa, 1000, 1000]]);
    expect(okB).toBe(true);
    expect(callsB).toEqual([['lstat', pb], ['chmod', pb, 0o600]]);
    expect(lines).toEqual([
      `[Server] The local socket ${pa} is open for uid 1000, gid 1000`,
      `[Server] The local socket ${pb} is open for this process's own user`,
    ]);
  });

  it('5b. a failed chmod or chown closes the socket and says so', async () => {
    const lines: string[] = [];
    const boom = () => { throw new Error('EPERM: not permitted'); };
    const a = http.createServer();
    const pa = sockPath();
    const okA = await listenLocal(a, pa, null, { fs: fakeFs([], { chmodSync: boom }), log: (l) => lines.push(l) });
    const listeningA = a.listening;
    const callsB: Call[] = [];
    const b = http.createServer();
    const pb = sockPath();
    const okB = await listenLocal(b, pb, { uid: 1000, gid: 1000 }, { fs: fakeFs(callsB, { chownSync: boom }), log: (l) => lines.push(l) });
    const listeningB = b.listening;
    await closeServer(a);
    await closeServer(b);
    expect(okA).toBe(false);
    expect(listeningA).toBe(false);
    expect(okB).toBe(false);
    expect(listeningB).toBe(false);
    expect(lines).toEqual([
      `[Server] The local socket ${pa} was closed again: its mode could not be set to 0600 (EPERM: not permitted)`,
      `[Server] The local socket ${pb} was closed again: it could not be given to uid 1000, gid 1000 (EPERM: not permitted)`,
    ]);
  });

  it('5c. the socket is bound under umask 0177, and the old umask is back before anything else runs', async () => {
    const events: Call[] = [];
    const a = http.createServer();
    const listen = a.listen.bind(a) as (...args: any[]) => http.Server;
    (a as any).listen = (...args: any[]) => { events.push(['listen']); return listen(...args); };
    const pa = sockPath();
    const ok = await listenLocal(a, pa, null, {
      fs: fakeFs(events),
      log: () => {},
      umask: (mask: number) => { events.push(['umask', mask]); return 0o022; },
      afterListen: () => { events.push(['afterListen']); },
    });
    await closeServer(a);

    const thrown: Call[] = [];
    const lines: string[] = [];
    const broken: any = { once: () => broken, off: () => broken, listen: () => { thrown.push(['listen']); throw new Error('listen blew up'); } };
    const pb = sockPath();
    const failed = await listenLocal(broken, pb, null, {
      fs: fakeFs(thrown),
      log: (l) => lines.push(l),
      umask: (mask: number) => { thrown.push(['umask', mask]); return 0o002; },
    });

    expect(ok).toBe(true);
    expect(events).toEqual([['lstat', pa], ['umask', 0o177], ['listen'], ['umask', 0o022], ['afterListen'], ['chmod', pa, 0o600]]);
    expect(failed).toBe(false);
    expect(thrown).toEqual([['lstat', pb], ['umask', 0o177], ['listen'], ['umask', 0o002]]);
    expect(lines).toEqual([`[Server] The local socket was not opened: listening at ${pb} failed (listen blew up)`]);
  });

  it.skipIf(WIN)('5d. under umask 000 the socket file is 0600 from its bind, before the chmod', async () => {
    const saved = process.umask(0o000);
    const p = sockPath();
    const a = http.createServer();
    let atBind = -1;
    let ok = false;
    let after = -1;
    try {
      ok = await listenLocal(a, p, null, { log: () => {}, afterListen: () => { atBind = fs.lstatSync(p).mode & 0o777; } });
      after = process.umask();
    } finally {
      process.umask(saved);
    }
    await closeServer(a);
    expect(ok).toBe(true);
    expect(atBind).toBe(0o600);
    expect(after).toBe(0o000);
  });

  it('6b. a socket that answers a connect is left alone: nothing is removed and nothing opened', async () => {
    const calls: Call[] = [];
    const lines: string[] = [];
    const probe = probeSocket();
    const a = http.createServer();
    const p = sockPath();
    const ok = await listenLocal(a, p, null, {
      fs: fakeFs(calls, { lstatSync: (q: string) => { calls.push(['lstat', q]); return socketStat; } }),
      log: (l) => lines.push(l),
      connect: (q: string) => { calls.push(['connect', q]); setImmediate(() => probe.emit('connect')); return probe; },
    });
    const listening = a.listening;
    await closeServer(a);
    expect(ok).toBe(false);
    expect(listening).toBe(false);
    expect(calls).toEqual([['lstat', p], ['connect', p]]);
    expect(probe.destroyed).toBe(true);
    expect(lines).toEqual([`[Server] The local socket was not opened: another process listens at ${p}`]);
  });

  it.each(['ECONNREFUSED', 'ENOENT'])('6c. a socket whose connect fails with %s is stale: removed, then the socket opens', async (code) => {
    const calls: Call[] = [];
    const probe = probeSocket();
    const a = http.createServer();
    const p = sockPath();
    const ok = await listenLocal(a, p, null, {
      fs: fakeFs(calls, { lstatSync: (q: string) => { calls.push(['lstat', q]); return socketStat; } }),
      log: () => {},
      connect: (q: string) => {
        calls.push(['connect', q]);
        setImmediate(() => probe.emit('error', Object.assign(new Error(`connect ${code} ${q}`), { code })));
        return probe;
      },
    });
    const listening = a.listening;
    await closeServer(a);
    expect(ok).toBe(true);
    expect(listening).toBe(true);
    expect(calls).toEqual([['lstat', p], ['connect', p], ['unlink', p], ['chmod', p, 0o600]]);
    expect(probe.destroyed).toBe(true);
  });

  it("6d. a connect that neither opens nor fails, or fails another way, removes nothing and says can't confirm", async () => {
    const run = async (answer: (probe: any, q: string) => void, probeMs?: number) => {
      const calls: Call[] = [];
      const lines: string[] = [];
      const probe = probeSocket();
      const a = http.createServer();
      const p = sockPath();
      const started = Date.now();
      const ok = await listenLocal(a, p, null, {
        fs: fakeFs(calls, { lstatSync: (q: string) => { calls.push(['lstat', q]); return socketStat; } }),
        log: (l) => lines.push(l),
        connect: (q: string) => { calls.push(['connect', q]); answer(probe, q); return probe; },
        probeMs,
      });
      const took = Date.now() - started;
      const listening = a.listening;
      await closeServer(a);
      return { ok, listening, calls, lines, p, took, destroyed: probe.destroyed };
    };
    const silent = await run(() => {}, 60);
    const denied = await run((probe, q) => setImmediate(() => probe.emit('error', Object.assign(new Error(`connect EACCES ${q}`), { code: 'EACCES' }))));
    expect(silent.ok).toBe(false);
    expect(silent.listening).toBe(false);
    expect(silent.calls).toEqual([['lstat', silent.p], ['connect', silent.p]]);
    expect(silent.destroyed).toBe(true);
    expect(silent.took).toBeLessThan(1500);
    expect(silent.lines).toEqual([
      `[Server] The local socket was not opened: the manager could not tell whether ${silent.p} is in use (can't confirm: a connect neither opened nor failed within 0.06 s)`,
    ]);
    expect(denied.ok).toBe(false);
    expect(denied.calls).toEqual([['lstat', denied.p], ['connect', denied.p]]);
    expect(denied.lines).toEqual([
      `[Server] The local socket was not opened: the manager could not tell whether ${denied.p} is in use (can't confirm: connect EACCES ${denied.p})`,
    ]);
  });

  it.skipIf(WIN)("6e. a second manager on a live manager's socket opens nothing, and the first still answers", async () => {
    const p = sockPath();
    const first = http.createServer((_q, res) => res.end('first'));
    await new Promise<void>((r) => first.listen(p, () => r()));
    const lines: string[] = [];
    const second = http.createServer((_q, res) => res.end('second'));
    const ok = await listenLocal(second, p, null, { log: (l) => lines.push(l) });
    const secondListening = second.listening;
    const answer = await new Promise<string>((resolve, reject) => {
      const req = http.request({ socketPath: p, path: '/', agent: false }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve(t)); });
      req.on('error', reject);
      req.end();
    });
    await closeServer(second);
    await closeServer(first);
    expect(ok).toBe(false);
    expect(secondListening).toBe(false);
    expect(answer).toBe('first');
    expect(lines).toEqual([`[Server] The local socket was not opened: another process listens at ${p}`]);
  });

  it("6f. a bot cannot take the terminal service's container name", () => {
    expect(sanitizeName('Discord Bot Manager Terminal')).toBe('discordbotmanagerterminal');
    expect(RESERVED_NAMES).toContain('discordbotmanagerterminal');
    expect(isReservedName(sanitizeName('Discord Bot Manager Terminal'))).toBe(true);
    expect(isReservedName(sanitizeName('discord-bot-manager-terminal'))).toBe(true);
  });

  it.skipIf(WIN)('6. a stale socket is replaced with mode 0600 and the owner; a regular file is left alone', async () => {
    const p = sockPath();
    const stale = http.createServer();
    await new Promise<void>((r) => stale.listen(`${p}.old`, () => r()));
    // A closed server removes the path it listened at; the renamed file stays, as after a killed manager.
    fs.renameSync(`${p}.old`, p);
    await closeServer(stale);
    const wasSocket = fs.lstatSync(p).isSocket();
    const lines: string[] = [];
    const fresh = http.createServer((_q, res) => res.end('fresh'));
    const ok = await listenLocal(fresh, p, { uid: 1000, gid: 1000 }, { log: (l) => lines.push(l) });
    const st = fs.lstatSync(p);
    const answer = await new Promise<string>((resolve, reject) => {
      const req = http.request({ socketPath: p, path: '/', agent: false }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve(t)); });
      req.on('error', reject);
      req.end();
    });
    await closeServer(fresh);

    const file = path.join(tmp.dir, 'regular');
    fs.writeFileSync(file, 'keep me');
    const other = http.createServer();
    const refusedLines: string[] = [];
    const refused = await listenLocal(other, file, { uid: 1000, gid: 1000 }, { log: (l) => refusedLines.push(l) });
    const otherListening = other.listening;
    await closeServer(other);

    expect(wasSocket).toBe(true);
    expect(ok).toBe(true);
    expect(st.isSocket()).toBe(true);
    expect(st.mode & 0o7777).toBe(0o600);
    expect([st.uid, st.gid]).toEqual([1000, 1000]);
    expect(answer).toBe('fresh');
    expect(refused).toBe(false);
    expect(otherListening).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('keep me');
    expect(refusedLines).toEqual([`[Server] The local socket was not opened: ${file} exists and is not a socket, so it was left as it is`]);
  });

  it('7. a path in a missing folder: false, one line, and the TCP server still answers', async () => {
    const { server, local, wss } = createServer(createGate({ secret: '', network: '', failClosed: false, readAddresses: async () => [] }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const missing = WIN ? path.join(tmp.dir, 'none', 'x', 'manager.sock') : path.join(tmp.dir, 'none', 'manager.sock');
    const lines: string[] = [];
    const ok = await listenLocal(local, missing, null, { log: (l) => lines.push(l) });
    const health = await get({ port: (server.address() as any).port }, '/api/health');
    const localListening = local.listening;
    wss.clients.forEach((c: any) => c.terminate());
    await closeServer(server);
    await closeServer(local);
    expect(ok).toBe(false);
    expect(localListening).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith('[Server] The local socket was not opened: ')).toBe(true);
    expect(lines[0]).toContain(missing);
    expect(health.status).toBe(200);
  });

  it('8. MANAGER_SOCKET unset: no listen call and no file-system call', async () => {
    const calls: Call[] = [];
    const lines: string[] = [];
    const fake: any = { listen: (...a: unknown[]) => { calls.push(['listen', ...a]); }, once: () => fake, off: () => fake, on: () => fake };
    const fsAll = fakeFs(calls);
    const unset = await startLocalSocket(fake, {}, { fs: fsAll, log: (l) => lines.push(l) });
    const empty = await startLocalSocket(fake, { MANAGER_SOCKET: '', MANAGER_SOCKET_OWNER: '1000:1000' }, { fs: fsAll, log: (l) => lines.push(l) });
    expect(unset).toBe(false);
    expect(empty).toBe(false);
    expect(calls).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('8b. MANAGER_SOCKET set: the socket opens for MANAGER_SOCKET_OWNER; an owner that cannot be read opens nothing', async () => {
    const p = sockPath();
    const calls: Call[] = [];
    const lines: string[] = [];
    const a = http.createServer();
    const ok = await startLocalSocket(a, { MANAGER_SOCKET: p, MANAGER_SOCKET_OWNER: '1000:1000' }, { fs: fakeFs(calls), log: (l) => lines.push(l) });
    const listening = a.listening;
    await closeServer(a);
    const badCalls: Call[] = [];
    const b = http.createServer();
    const bad = await startLocalSocket(b, { MANAGER_SOCKET: p, MANAGER_SOCKET_OWNER: 'node' }, { fs: fakeFs(badCalls), log: (l) => lines.push(l) });
    const badListening = b.listening;
    await closeServer(b);
    expect(ok).toBe(true);
    expect(listening).toBe(true);
    expect(calls).toEqual([['lstat', p], ['chmod', p, 0o600], ['chown', p, 1000, 1000]]);
    expect(bad).toBe(false);
    expect(badListening).toBe(false);
    expect(badCalls).toEqual([]);
    expect(lines[1]).toBe(`[Server] The local socket was not opened: ${p} is set in MANAGER_SOCKET, and MANAGER_SOCKET_OWNER is not <uid>:<gid>`);
  });

  it('8c. startServer opens the socket named in MANAGER_SOCKET on the gated app', async () => {
    const p = sockPath();
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.MANAGER_SOCKET = p;
    let started: ReturnType<typeof startServer>;
    try {
      started = startServer(closedGate(), { fs: fakeFs([]), log: (l) => lines.push(l) });
    } finally {
      delete process.env.MANAGER_SOCKET;
    }
    await vi.waitFor(() => { if (lines.length === 0 || !started.server.listening) throw new Error('not up'); }, { timeout: 2000, interval: 20 });
    const health = await get({ socketPath: p }, '/api/bots');
    started.wss.clients.forEach((c: any) => c.terminate());
    await closeServer(started.server);
    await closeServer(started.local);
    log.mockRestore();
    expect(health.status).toBe(200);
    expect(lines).toEqual([`[Server] The local socket ${p} is open for this process's own user`]);
  });

  it('9. resolveTarget: DBM_SOCKET gives the socket unless --port or --url is given', () => {
    const saved = { sock: process.env.DBM_SOCKET, port: process.env.PORT };
    const out: Record<string, unknown> = {};
    try {
      process.env.PORT = '8123';
      process.env.DBM_SOCKET = '/run/dbm/manager.sock';
      out.socket = resolveTarget({});
      out.port = resolveTarget({ port: '8090' });
      out.url = resolveTarget({ url: 'http://localhost:9000' });
      try { resolveTarget({ url: 'http://10.0.0.5:8080' }); out.remote = 'accepted'; } catch (e) { out.remote = e; }
      delete process.env.DBM_SOCKET;
      out.unset = resolveTarget({});
      process.env.DBM_SOCKET = '';
      out.empty = resolveTarget({});
    } finally {
      if (saved.sock === undefined) delete process.env.DBM_SOCKET; else process.env.DBM_SOCKET = saved.sock;
      if (saved.port === undefined) delete process.env.PORT; else process.env.PORT = saved.port;
    }
    expect(out.socket).toEqual({ socketPath: '/run/dbm/manager.sock' });
    expect(out.port).toEqual({ host: '127.0.0.1', port: 8090 });
    expect(out.url).toEqual({ host: 'localhost', port: 9000 });
    expect(out.remote).toBeInstanceOf(LoopbackError);
    expect((out.remote as Error).message).toBe('--url must be loopback (127.0.0.1/::1/localhost), got 10.0.0.5');
    expect(out.unset).toEqual({ host: '127.0.0.1', port: 8123 });
    expect(out.empty).toEqual({ host: '127.0.0.1', port: 8123 });
  });
});
