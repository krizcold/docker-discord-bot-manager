import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';

// `docker ps` (the container list) answers from h.ps; every spawn is recorded, so a row can see that no docker exec ran.
const h = vi.hoisted(() => ({ ps: 'app-bot-1\trunning\n', spawns: [] as string[][], children: [] as any[] }));

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const spawn = (_cmd: string, args: string[]) => {
    h.spawns.push(args);
    const child: any = new EventEmitter();
    child.kill = () => true;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    h.children.push(child);
    if (args[0] === 'ps') {
      setImmediate(() => {
        child.stdout.write(h.ps);
        child.stdout.end();
        child.emit('close', 0);
      });
    }
    return child;
  };
  return { ...real, spawn, default: { ...real, spawn } };
});
vi.mock('../../src/docker/containerManager', async (orig) => ({
  ...(await orig<any>()),
  getBot: (id: string) => {
    if (id === 'unreadable') throw new Error('the registry could not be read');
    return id === 'b1' ? { id: 'b1', sanitizedName: 'app' } : undefined;
  },
}));

import { dockerSocketPath, openExecTty, termSize } from '../../src/webui/execTty';
import { closeTerminal, handleTerminalMessage } from '../../src/webui/terminal';

const WIN = process.platform === 'win32';
const WRAP = 'stty rows 30 cols 100 2>/dev/null; if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi';

interface Call { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }

// The stand-in for the Docker socket: an HTTP server on a pipe or socket path that answers the four exec calls.
interface Daemon {
  host: string;
  calls: Call[];
  streams: net.Socket[];
  received: () => string;
  streamClosed: () => boolean;
  create: { status: number; body: string; hold?: boolean };
  start: { status: number; body: string } | null;
  /** hold: the start is never answered. endless: a 200 whose body goes on in 16 KiB pieces. drip: a 200 whose body is one byte every 20 ms. */
  startMode: 'answer' | 'hold' | 'endless' | 'drip';
  inspect: { status: number; body: string };
  releaseCreate: () => void;
  stop: () => Promise<void>;
}

let seq = 0;
let tmpDir = '';

async function daemon(): Promise<Daemon> {
  seq += 1;
  const sockPath = WIN ? `\\\\.\\pipe\\m9-exec-${process.pid}-${seq}` : path.join(tmpDir, `d${seq}.sock`);
  const calls: Call[] = [];
  const streams: net.Socket[] = [];
  const upgrades: net.Socket[] = [];
  const timers: NodeJS.Timeout[] = [];
  let got = '';
  let closedStream = false;
  const held: Array<() => void> = [];
  const d: Daemon = {
    host: (WIN ? 'npipe://' : 'unix://') + sockPath,
    calls,
    streams,
    received: () => got,
    streamClosed: () => closedStream,
    create: { status: 201, body: JSON.stringify({ Id: 'e1abc' }) },
    start: null,
    startMode: 'answer',
    inspect: { status: 200, body: JSON.stringify({ Running: false, ExitCode: 7 }) },
    releaseCreate: () => held.splice(0).forEach((f) => f()),
    stop: async () => {},
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = req.url || '';
      calls.push({ method: req.method || '', url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      const answer = (a: { status: number; body: string }) => {
        res.writeHead(a.status, { 'Content-Type': 'application/json' });
        res.end(a.body);
      };
      if (req.method === 'POST' && /^\/containers\/[^/]+\/exec$/.test(url)) {
        if (d.create.hold) held.push(() => answer(d.create));
        else answer(d.create);
      } else if (req.method === 'POST' && /^\/exec\/[^/]+\/resize\?/.test(url)) answer({ status: 200, body: '' });
      else if (req.method === 'GET' && /^\/exec\/[^/]+\/json$/.test(url)) answer(d.inspect);
      else answer({ status: 404, body: JSON.stringify({ message: 'page not found' }) });
    });
  });
  server.on('upgrade', (req, socket, head) => {
    upgrades.push(socket as net.Socket);
    const need = Number(req.headers['content-length'] || 0);
    let body = Buffer.from(head);
    let started = false;
    const begin = () => {
      started = true;
      calls.push({ method: req.method || '', url: req.url || '', headers: req.headers, body: body.subarray(0, need).toString('utf8') });
      const rest = body.subarray(need);
      if (d.startMode === 'hold') return;
      if (d.startMode === 'endless' || d.startMode === 'drip') {
        socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/vnd.docker.raw-stream\r\n\r\n');
        const piece = d.startMode === 'endless' ? Buffer.alloc(16 * 1024, 0x78) : Buffer.from('x');
        timers.push(setInterval(() => { if (!socket.destroyed) socket.write(piece); }, d.startMode === 'endless' ? 5 : 20));
        return;
      }
      if (d.start) {
        socket.end(`HTTP/1.1 ${d.start.status} X\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(d.start.body)}\r\nConnection: close\r\n\r\n${d.start.body}`);
        return;
      }
      socket.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
      streams.push(socket as net.Socket);
      got += rest.toString('utf8');
    };
    socket.on('data', (c: Buffer) => {
      if (started) {
        got += c.toString('utf8');
        return;
      }
      body = Buffer.concat([body, c]);
      if (body.length >= need) begin();
    });
    // An http.Server socket stays half open: the peer's end is this side's news that the stream closed.
    socket.on('end', () => { closedStream = true; socket.end(); });
    socket.on('close', () => { closedStream = true; });
    socket.on('error', () => { closedStream = true; });
    if (body.length >= need) begin();
  });
  await new Promise<void>((resolve) => server.listen(sockPath, resolve));
  d.stop = () => new Promise<void>((resolve) => {
    d.releaseCreate();
    for (const t of timers) clearInterval(t);
    for (const s of upgrades) s.destroy();
    server.closeAllConnections();
    server.close(() => resolve());
  });
  return d;
}

// flushed: the send callbacks, which ws calls once a frame has left its buffer; a row calls them itself.
interface Channel { ws: any; sent: any[]; flushed: Array<() => void> }
function channel(): Channel {
  const sent: any[] = [];
  const flushed: Array<() => void> = [];
  const ws: any = {
    readyState: 1,
    bufferedAmount: 0,
    send: (s: string, cb?: () => void) => {
      sent.push(JSON.parse(s));
      if (cb) flushed.push(cb);
    },
  };
  return { ws, sent, flushed };
}
const dataOf = (c: Channel): string => Buffer.concat(c.sent.filter((m) => m.type === 'terminal:data').map((m) => Buffer.from(m.data, 'base64'))).toString('utf8');

async function until(cond: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  return cond();
}
const pause = (ms = 150) => new Promise((r) => setTimeout(r, ms));

const START = { type: 'terminal:start', botId: 'b1', container: 'app-bot-1', tty: true, cols: 100, rows: 30 };
const say = (c: Channel, msg: unknown) => handleTerminalMessage(c.ws, JSON.stringify(msg));
const types = (c: Channel) => c.sent.map((m) => m.type);
const execSpawns = () => h.spawns.filter((a) => a[0] === 'exec');

let d: Daemon;
let savedHost: string | undefined;
const channels: Channel[] = [];
const open = async (start: unknown = START): Promise<Channel> => {
  const c = channel();
  channels.push(c);
  say(c, start);
  return c;
};

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm9x-'));
  h.ps = 'app-bot-1\trunning\n';
  h.spawns.length = 0;
  h.children.length = 0;
  savedHost = process.env.DOCKER_HOST;
  d = await daemon();
  process.env.DOCKER_HOST = d.host;
});
afterEach(async () => {
  for (const c of channels.splice(0)) closeTerminal(c.ws);
  await d.stop();
  if (savedHost === undefined) delete process.env.DOCKER_HOST;
  else process.env.DOCKER_HOST = savedHost;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('m9 exec: where the daemon is and the size', () => {
  it('dockerSocketPath reads a local DOCKER_HOST, falls back to the platform default, and gives null for a network one', () => {
    expect(dockerSocketPath({}, 'linux')).toBe('/var/run/docker.sock');
    expect(dockerSocketPath({}, 'win32')).toBe('//./pipe/docker_engine');
    expect(dockerSocketPath({ DOCKER_HOST: 'unix:///run/user/1000/docker.sock' }, 'linux')).toBe('/run/user/1000/docker.sock');
    expect(dockerSocketPath({ DOCKER_HOST: 'npipe:////./pipe/other' }, 'win32')).toBe('//./pipe/other');
    expect(dockerSocketPath({ DOCKER_HOST: 'tcp://10.0.0.1:2375' }, 'linux')).toBeNull();
    expect(dockerSocketPath({ DOCKER_HOST: 'unix://' }, 'linux')).toBeNull();
    expect(dockerSocketPath({ DOCKER_HOST: 'npipe://' }, 'win32')).toBeNull();
  });

  it('termSize keeps whole sizes from 1 to 1000 and falls back to 80 by 24', () => {
    expect(termSize(100, 30)).toEqual({ cols: 100, rows: 30 });
    expect(termSize('120', '40')).toEqual({ cols: 120, rows: 40 });
    expect(termSize(100.9, 30.2)).toEqual({ cols: 100, rows: 30 });
    expect(termSize(1, 1000)).toEqual({ cols: 1, rows: 1000 });
    expect(termSize(0, 1001)).toEqual({ cols: 80, rows: 24 });
    expect(termSize(undefined, '1; reboot')).toEqual({ cols: 80, rows: 24 });
    expect(termSize(-5, Infinity)).toEqual({ cols: 80, rows: 24 });
  });
});

describe('m9 exec: terminal:start with tty', () => {
  it('creates an exec with a TTY and the page wrapper, starts it with an upgrade to a raw stream, and says ready', async () => {
    const c = await open();
    expect(await until(() => c.sent.length > 0)).toBe(true);
    expect(c.sent).toEqual([{ type: 'terminal:ready', container: 'app-bot-1' }]);
    expect(d.calls.map((x) => `${x.method} ${x.url}`)).toEqual(['POST /containers/app-bot-1/exec', 'POST /exec/e1abc/start']);
    expect(JSON.parse(d.calls[0].body)).toEqual({
      AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true, ConsoleSize: [30, 100], Cmd: ['/bin/sh', '-c', WRAP],
    });
    expect(d.calls[0].headers['content-type']).toBe('application/json');
    expect(JSON.parse(d.calls[1].body)).toEqual({ Detach: false, Tty: true, ConsoleSize: [30, 100] });
    expect(String(d.calls[1].headers.upgrade).toLowerCase()).toBe('tcp');
    expect(String(d.calls[1].headers.connection).toLowerCase()).toBe('upgrade');
    expect(execSpawns()).toEqual([]);
  });

  it('a size that is not a whole number from 1 to 1000 becomes 80 by 24', async () => {
    const c = await open({ ...START, cols: '5; reboot', rows: 0 });
    expect(await until(() => c.sent.length > 0)).toBe(true);
    const body = JSON.parse(d.calls[0].body);
    expect(body.ConsoleSize).toEqual([24, 80]);
    expect(body.Cmd[2]).toContain('stty rows 24 cols 80 ');
  });

  it('carries bytes both ways', async () => {
    const c = await open();
    expect(await until(() => d.streams.length === 1)).toBe(true);
    await until(() => c.sent.length > 0);
    say(c, { type: 'terminal:input', data: Buffer.from('ls -la\r').toString('base64') });
    say(c, { type: 'terminal:input', data: Buffer.from([3]).toString('base64') });
    expect(await until(() => d.received() === 'ls -la\r\x03')).toBe(true);
    d.streams[0].write(Buffer.from('caf\u00e9 $ \x1b[1m', 'utf8'));
    expect(await until(() => c.sent.some((m) => m.type === 'terminal:data'))).toBe(true);
    const out = Buffer.concat(c.sent.filter((m) => m.type === 'terminal:data').map((m) => Buffer.from(m.data, 'base64')));
    expect(out.toString('utf8')).toBe('caf\u00e9 $ \x1b[1m');
    expect(execSpawns()).toEqual([]);
  });

  it('terminal:resize asks the daemon for the new height and width', async () => {
    const c = await open();
    await until(() => c.sent.length > 0);
    say(c, { type: 'terminal:resize', cols: 132, rows: 43 });
    expect(await until(() => d.calls.length === 3)).toBe(true);
    expect(`${d.calls[2].method} ${d.calls[2].url}`).toBe('POST /exec/e1abc/resize?h=43&w=132');
    say(c, { type: 'terminal:resize', cols: 'x', rows: -1 });
    await pause();
    expect(d.calls.length).toBe(3);
  });

  it('terminal:exit carries the exit code the daemon reports once the stream ends', async () => {
    const c = await open();
    expect(await until(() => d.streams.length === 1)).toBe(true);
    await until(() => c.sent.length > 0);
    d.streams[0].end('bye\r\n');
    expect(await until(() => types(c).includes('terminal:exit'))).toBe(true);
    expect(c.sent.at(-1)).toEqual({ type: 'terminal:exit', code: 7 });
    expect(types(c).filter((t) => t === 'terminal:exit').length).toBe(1);
    expect(d.calls.at(-1)!.url).toBe('/exec/e1abc/json');
    expect(c.ws.__term).toBeUndefined();
    say(c, { type: 'terminal:input', data: Buffer.from('late').toString('base64') });
    say(c, { type: 'terminal:resize', cols: 90, rows: 20 });
    await pause();
    expect(d.calls.filter((x) => x.url.includes('/resize')).length).toBe(0);
    expect(types(c).filter((t) => t === 'terminal:exit').length).toBe(1);
  });

  it('terminal:exit says the shell is still running when the daemon reports it so', async () => {
    d.inspect = { status: 200, body: JSON.stringify({ Running: true, ExitCode: null }) };
    const c = await open();
    expect(await until(() => d.streams.length === 1)).toBe(true);
    d.streams[0].end();
    expect(await until(() => types(c).includes('terminal:exit'))).toBe(true);
    expect(c.sent.at(-1)).toEqual({ type: 'terminal:exit', code: null, running: true });
  });

  it.each([
    ['a refused inspect', { status: 500, body: JSON.stringify({ message: 'boom' }) }],
    ['an answer that is not JSON', { status: 200, body: 'nope' }],
    ['an answer without a number', { status: 200, body: JSON.stringify({ Running: false }) }],
  ])('terminal:exit carries null when the daemon gives no exit code (%s)', async (_n, inspect) => {
    d.inspect = inspect;
    const c = await open();
    expect(await until(() => d.streams.length === 1)).toBe(true);
    d.streams[0].end();
    expect(await until(() => types(c).includes('terminal:exit'))).toBe(true);
    expect(c.sent.at(-1)).toEqual({ type: 'terminal:exit', code: null });
  });

  it('exit code 0 is carried as 0', async () => {
    d.inspect = { status: 200, body: JSON.stringify({ Running: false, ExitCode: 0 }) };
    const c = await open();
    expect(await until(() => d.streams.length === 1)).toBe(true);
    d.streams[0].end();
    expect(await until(() => types(c).includes('terminal:exit'))).toBe(true);
    expect(c.sent.at(-1)).toEqual({ type: 'terminal:exit', code: 0 });
  });
});

describe('m9 exec: a channel that does not drain', () => {
  const MIB = 1024 * 1024;
  const KIB = 1024;

  it('stops reading the daemon while over 1 MiB waits in the channel, and reads on under 256 KiB with every byte in order', async () => {
    const c = await open();
    expect(await until(() => d.streams.length === 1 && c.sent.length > 0)).toBe(true);
    const daemonSide = d.streams[0];
    const a = 'a'.repeat(700);
    const b = 'b'.repeat(700);
    const held = 'c'.repeat(700) + 'd'.repeat(700);
    const last = 'e'.repeat(700);

    c.ws.bufferedAmount = MIB;
    daemonSide.write(a);
    const atMark = await until(() => dataOf(c) === a);
    c.ws.bufferedAmount = MIB + 1;
    daemonSide.write(b);
    const overMark = await until(() => dataOf(c) === a + b);
    daemonSide.write(held.slice(0, 700));
    await pause(100);
    daemonSide.write(held.slice(700));
    await pause(200);
    const whilePaused = dataOf(c);
    const callbacks = c.flushed.length;

    c.ws.bufferedAmount = 256 * KIB;
    c.flushed.shift()!();
    await pause(200);
    const atLowMark = dataOf(c);

    c.ws.bufferedAmount = 256 * KIB - 1;
    c.flushed.shift()!();
    const resumed = await until(() => dataOf(c) === a + b + held);
    c.ws.bufferedAmount = 0;
    daemonSide.write(last);
    const after = await until(() => dataOf(c) === a + b + held + last);

    expect(atMark).toBe(true);
    expect(overMark).toBe(true);
    expect(whilePaused).toBe(a + b);
    expect(callbacks).toBeGreaterThanOrEqual(2);
    expect(atLowMark).toBe(a + b);
    expect(resumed).toBe(true);
    expect(after).toBe(true);
    expect(dataOf(c)).toBe(a + b + held + last);
  });

  it('reads on once every held frame has left, though other frames keep the channel over the mark', async () => {
    const c = await open();
    expect(await until(() => d.streams.length === 1 && c.sent.length > 0)).toBe(true);
    c.ws.bufferedAmount = MIB + 1;
    d.streams[0].write('x'.repeat(500));
    const first = await until(() => dataOf(c).length === 500);
    d.streams[0].write('y'.repeat(500));
    await pause(150);
    const whileHeld = dataOf(c).length;
    const waiting = c.flushed.length;

    // Broadcasts to the same channel have no callback and can keep bufferedAmount high after the shell's frames left.
    for (const done of c.flushed.splice(0, waiting - 1)) done();
    await pause(100);
    const beforeLast = dataOf(c).length;
    c.flushed.shift()!();
    const readAgain = await until(() => dataOf(c).length === 1000);

    expect(first).toBe(true);
    expect(whileHeld).toBe(500);
    expect(waiting).toBeGreaterThanOrEqual(1);
    expect(beforeLast).toBe(500);
    expect(readAgain).toBe(true);
    expect(dataOf(c)).toBe('x'.repeat(500) + 'y'.repeat(500));
    expect(c.ws.bufferedAmount).toBe(MIB + 1);
  });

  it('a channel closed while the stream is held back ends the stream', async () => {
    const c = await open();
    expect(await until(() => d.streams.length === 1 && c.sent.length > 0)).toBe(true);
    c.ws.bufferedAmount = MIB + 1;
    d.streams[0].write('x'.repeat(500));
    expect(await until(() => dataOf(c).length === 500)).toBe(true);
    d.streams[0].write('y'.repeat(500));
    await pause(100);
    closeTerminal(c.ws);
    expect(await until(() => d.streamClosed())).toBe(true);
    expect(dataOf(c).length).toBe(500);
  });
});

describe('m9 exec: a daemon that does not answer', () => {
  const opts = (over: Record<string, unknown> = {}) => ({
    socketPath: d.host.replace(/^(unix|npipe):\/\//, ''),
    container: 'app-bot-1',
    cmd: ['/bin/sh'],
    cols: 80,
    rows: 24,
    onData: () => {},
    onExit: () => {},
    callTimeoutMs: 80,
    ...over,
  });
  const outcome = async (o: ReturnType<typeof opts>): Promise<{ said: string; took: number }> => {
    const started = Date.now();
    const said = await openExecTty(o as never).then((tty) => { tty.close(); return 'opened'; }, (err: Error) => err.message);
    return { said, took: Date.now() - started };
  };

  it('an exec create with no answer within the bound is refused naming the socket and the bound', async () => {
    d.create = { ...d.create, hold: true };
    const o = opts();
    const r = await outcome(o);
    expect(r.said).toBe(`the Docker socket ${o.socketPath} did not answer (no answer within 0.08 s)`);
    expect(r.took).toBeLessThan(2000);
    expect(d.calls.length).toBe(1);
  });

  it('an exec start with no answer within the bound is refused the same way', async () => {
    d.startMode = 'hold';
    const o = opts();
    const r = await outcome(o);
    expect(r.said).toBe(`the Docker socket ${o.socketPath} did not answer (no answer within 0.08 s)`);
    expect(r.took).toBeLessThan(2000);
    expect(d.calls.length).toBe(2);
  });

  it('a start answered 200 with a body that goes on is cut at 64 KiB and its connection closed', async () => {
    d.startMode = 'endless';
    const c = await open();
    expect(await until(() => c.sent.length > 0)).toBe(true);
    expect(c.sent).toEqual([{ type: 'terminal:error', message: 'the Docker daemon answered 200 to the exec start with an answer longer than 64 KiB' }]);
    expect(await until(() => d.streamClosed())).toBe(true);
    expect(c.ws.__term).toBeUndefined();
  });

  it('a start answered 200 with a body that never ends is cut at the bound', async () => {
    d.startMode = 'drip';
    const r = await outcome(opts({ callTimeoutMs: 150 }));
    expect(r.said).toBe('the Docker daemon answered 200 to the exec start with an answer that did not end within 0.15 s');
    expect(r.took).toBeLessThan(2000);
    expect(await until(() => d.streamClosed())).toBe(true);
  });
});

describe('m9 exec: refusals', () => {
  it('a failure inside the manager while it opens the shell is shown as terminal:error', async () => {
    const c = await open({ ...START, botId: 'unreadable' });
    expect(await until(() => c.sent.length > 0)).toBe(true);
    await pause();
    expect(c.sent).toEqual([{ type: 'terminal:error', message: 'the manager failed while opening the shell (the registry could not be read)' }]);
    expect(d.calls).toEqual([]);
    expect(c.ws.__term).toBeUndefined();
  });

  it('a container of another bot is refused before any call to the daemon', async () => {
    h.ps = 'other-bot-1\trunning\n';
    const c = await open();
    expect(await until(() => c.sent.length > 0)).toBe(true);
    await pause();
    expect(c.sent).toEqual([{ type: 'terminal:error', message: 'Container does not belong to this bot' }]);
    expect(d.calls).toEqual([]);
    expect(execSpawns()).toEqual([]);
  });

  it('an unknown bot and a stopped container are refused before any call to the daemon', async () => {
    const a = await open({ ...START, botId: 'nope' });
    h.ps = 'app-bot-1\texited\n';
    const b = await open();
    expect(await until(() => a.sent.length > 0 && b.sent.length > 0)).toBe(true);
    await pause();
    expect(a.sent).toEqual([{ type: 'terminal:error', message: 'Bot not found' }]);
    expect(b.sent).toEqual([{ type: 'terminal:error', message: 'Container is not running' }]);
    expect(d.calls).toEqual([]);
  });

  it('a refused exec create is shown as terminal:error with the daemon message', async () => {
    d.create = { status: 409, body: JSON.stringify({ message: 'Container abc is paused, unpause the container before exec' }) };
    const c = await open();
    expect(await until(() => c.sent.length > 0)).toBe(true);
    expect(c.sent).toEqual([{
      type: 'terminal:error',
      message: 'the Docker daemon answered 409 to the exec create: Container abc is paused, unpause the container before exec',
    }]);
    expect(d.calls.length).toBe(1);
    expect(c.ws.__term).toBeUndefined();
  });

  it('a create answer without an exec id is shown as terminal:error and nothing is started', async () => {
    d.create = { status: 201, body: JSON.stringify({ Id: '../x' }) };
    const c = await open();
    expect(await until(() => c.sent.length > 0)).toBe(true);
    expect(c.sent).toEqual([{ type: 'terminal:error', message: 'the Docker daemon answered the exec create without an exec id' }]);
    expect(d.calls.length).toBe(1);
  });

  it('a refused exec start is shown as terminal:error with the daemon message', async () => {
    d.start = { status: 409, body: JSON.stringify({ message: 'container is stopped' }) };
    const c = await open();
    expect(await until(() => c.sent.length > 0)).toBe(true);
    expect(c.sent).toEqual([{ type: 'terminal:error', message: 'the Docker daemon answered 409 to the exec start: container is stopped' }]);
    expect(c.ws.__term).toBeUndefined();
  });

  it('a daemon that is not there is shown as terminal:error naming the socket', async () => {
    const gone = WIN ? `\\\\.\\pipe\\m9-exec-gone-${process.pid}` : path.join(tmpDir, 'gone.sock');
    process.env.DOCKER_HOST = (WIN ? 'npipe://' : 'unix://') + gone;
    const c = await open();
    expect(await until(() => c.sent.length > 0)).toBe(true);
    expect(types(c)).toEqual(['terminal:error']);
    expect(c.sent[0].message).toContain(`the Docker socket ${gone} did not answer (`);
    expect(d.calls).toEqual([]);
  });

  it('a DOCKER_HOST that is not a local socket is refused with its reason and no call', async () => {
    process.env.DOCKER_HOST = 'tcp://127.0.0.1:1';
    const c = await open();
    expect(await until(() => c.sent.length > 0)).toBe(true);
    expect(c.sent).toEqual([{ type: 'terminal:error', message: 'DOCKER_HOST does not name a local socket, so no terminal can be asked from the Docker daemon' }]);
    expect(d.calls).toEqual([]);
    expect(execSpawns()).toEqual([]);
  });
});

describe('m9 exec: endings from the channel', () => {
  it('a closed channel ends the stream and sends no exit', async () => {
    const c = await open();
    expect(await until(() => d.streams.length === 1)).toBe(true);
    await until(() => c.sent.length > 0);
    closeTerminal(c.ws);
    expect(await until(() => d.streamClosed())).toBe(true);
    await pause();
    expect(types(c)).toEqual(['terminal:ready']);
    expect(d.calls.some((x) => x.url.endsWith('/json'))).toBe(false);
    expect(c.ws.__term).toBeUndefined();
  });

  it('terminal:stop ends the stream', async () => {
    const c = await open();
    expect(await until(() => d.streams.length === 1)).toBe(true);
    say(c, { type: 'terminal:stop' });
    expect(await until(() => d.streamClosed())).toBe(true);
  });

  it('a channel closed while the daemon is still answering the create leaves no stream open and says nothing', async () => {
    d.create = { ...d.create, hold: true };
    const c = await open();
    expect(await until(() => d.calls.length === 1)).toBe(true);
    closeTerminal(c.ws);
    c.ws.readyState = 3;
    d.releaseCreate();
    expect(await until(() => d.calls.length === 2 && d.streamClosed())).toBe(true);
    await pause();
    expect(c.sent).toEqual([]);
    expect(c.ws.__term).toBeUndefined();
  });

  it('a channel that closed during the container check makes no call to the daemon', async () => {
    const c = channel();
    say(c, START);
    c.ws.readyState = 3;
    await pause();
    expect(d.calls).toEqual([]);
    expect(c.ws.__term).toBeUndefined();
  });

  it('a second start on the channel ends the first stream', async () => {
    const c = await open();
    expect(await until(() => d.streams.length === 1)).toBe(true);
    const first = d.streams[0];
    let firstClosed = false;
    first.on('close', () => { firstClosed = true; });
    say(c, START);
    expect(await until(() => d.streams.length === 2 && firstClosed)).toBe(true);
    await pause();
    expect(types(c)).toEqual(['terminal:ready', 'terminal:ready']);
    d.streams[1].write('second');
    expect(await until(() => c.sent.some((m) => m.type === 'terminal:data'))).toBe(true);
  });
});

describe('m9 exec: a start without tty', () => {
  it('runs docker exec as before and makes no call to the daemon', async () => {
    const c = await open({ type: 'terminal:start', botId: 'b1', container: 'app-bot-1', cols: 100, rows: 30 });
    expect(await until(() => c.sent.length > 0)).toBe(true);
    expect(c.sent).toEqual([{ type: 'terminal:ready', container: 'app-bot-1' }]);
    expect(execSpawns()).toEqual([['exec', '-i', '-t', 'app-bot-1', '/bin/sh', '-c', WRAP]]);
    say(c, { type: 'terminal:resize', cols: 132, rows: 43 });
    await pause();
    expect(d.calls).toEqual([]);
    h.children.at(-1).emit('exit', 0);
    expect(c.sent.at(-1)).toEqual({ type: 'terminal:exit' });
  });
});
