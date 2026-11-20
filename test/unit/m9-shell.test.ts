import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import { EventEmitter } from 'events';
import net from 'net';
import { PassThrough } from 'stream';
import http from 'http';
import os from 'os';
import path from 'path';
import { WebSocketServer } from 'ws';
import { Client, WS_HANDSHAKE_MS } from '../../src/cli/client';
import { PASTE_OFF } from '../../src/cli/tui/codes';
import { shellRouteHandOff, shellWay } from '../../src/cli/tui/run';
import { SHELL_RETURN } from '../../src/cli/tui/shell';
import { runShellRoute } from '../../src/cli/tui/shellroute';

type Msg = Record<string, unknown>;

// /ws as client.openWs gives it; the test opens it, sends the manager's frames and closes it.
function fakeClient(opts: { throws?: string } = {}) {
  const sent: Msg[] = [];
  const st = { opened: false, closedByCaller: 0, opens: 0 };
  let onMessage: (m: Msg) => void = () => {};
  let onOpen: (() => void) | undefined;
  let onClose: ((r: string) => void) | undefined;
  const client = {
    openWs(m: (msg: Msg) => void, o?: () => void, c?: (r: string) => void) {
      st.opens += 1;
      if (opts.throws) throw new Error(opts.throws);
      onMessage = m;
      onOpen = o;
      onClose = c;
      return {
        close: () => { st.closedByCaller += 1; },
        send: (msg: unknown) => {
          if (!st.opened) return false;
          sent.push(msg as Msg);
          return true;
        },
      };
    },
  };
  return {
    client: client as never,
    sent,
    st,
    open: () => { st.opened = true; onOpen?.(); },
    frame: (m: Msg) => onMessage(m),
    drop: (reason: string) => { st.opened = false; onClose?.(reason); },
  };
}

function terminal(opts: { tty?: boolean; raw?: boolean; columns?: number; rows?: number } = {}) {
  const input = new PassThrough() as PassThrough & { isRaw?: boolean; setRawMode?: (on: boolean) => unknown };
  const rawCalls: boolean[] = [];
  if (opts.tty !== false) {
    input.isRaw = opts.raw === true;
    input.setRawMode = (on: boolean) => {
      rawCalls.push(on);
      input.isRaw = on;
      return input;
    };
  }
  input.pause();
  const written: Buffer[] = [];
  const output = Object.assign(new EventEmitter(), {
    columns: opts.columns as number | undefined,
    rows: opts.rows as number | undefined,
    write: (chunk: string | Uint8Array) => {
      written.push(Buffer.from(chunk as never));
      return true;
    },
  });
  return { input, output, rawCalls, text: () => Buffer.concat(written).toString('utf8') };
}

async function within<T>(p: Promise<T>, ms: number): Promise<T | 'pending'> {
  const end = Date.now() + ms;
  let done: { v: T } | null = null;
  void p.then((v) => (done = { v }));
  while (!done && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  return done ? (done as { v: T }).v : 'pending';
}
const tick = () => new Promise((r) => setTimeout(r, 15));
const b64 = (s: string | number[]) => Buffer.from(s as never).toString('base64');

function setup(t = terminal({ columns: 120, rows: 40 }), f = fakeClient(), answerMs?: number) {
  const p = runShellRoute(f.client, 'b1', 'mybot-bot-1', { input: t.input, output: t.output, answerMs });
  return { t, f, p };
}
const atRest = (t: ReturnType<typeof terminal>) => ({
  data: t.input.listenerCount('data'),
  end: t.input.listenerCount('end'),
  close: t.input.listenerCount('close'),
  resize: t.output.listenerCount('resize'),
  paused: t.input.isPaused(),
});
const REST = { data: 0, end: 0, close: 0, resize: 0, paused: true };

describe('m9 shell: the client', () => {
  it('onSocket says whether the target is the local socket', () => {
    expect(new Client({ socketPath: '/run/dbm/manager.sock' }).onSocket).toBe(true);
    expect(new Client({ host: '127.0.0.1', port: 8080 }).onSocket).toBe(false);
  });

  it('openWs returns send: false before the channel opens, then the message reaches the manager as JSON', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/ws' });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    const got: string[] = [];
    wss.on('connection', (ws) => ws.on('message', (raw) => got.push(raw.toString())));
    const port = (wss.address() as { port: number }).port;
    let opened = false;
    const conn = new Client({ host: '127.0.0.1', port }).openWs(() => {}, () => { opened = true; });
    const early = conn.send({ type: 'terminal:stop' });
    for (let i = 0; i < 200 && !opened; i++) await tick();
    const late = conn.send({ type: 'terminal:input', data: 'eA==' });
    for (let i = 0; i < 200 && got.length === 0; i++) await tick();
    conn.close();
    for (let i = 0; i < 200 && wss.clients.size > 0; i++) await tick();
    const after = conn.send({ type: 'terminal:stop' });
    await new Promise<void>((r) => wss.close(() => r()));
    expect(early).toBe(false);
    expect(opened).toBe(true);
    expect(late).toBe(true);
    expect(got).toEqual([JSON.stringify({ type: 'terminal:input', data: 'eA==' })]);
    expect(after).toBe(false);
  });
});

describe('m9 shell: the client, a manager that accepts and says nothing', () => {
  let seq = 0;
  // Where a stand-in manager listens: a TCP port, or a socket path (a pipe path on Windows).
  const places = (kind: string): { listen: unknown[]; client: (srv: net.Server | http.Server) => Client; done: () => void } => {
    if (kind === 'tcp') {
      return { listen: [0, '127.0.0.1'], client: (srv) => new Client({ host: '127.0.0.1', port: (srv.address() as net.AddressInfo).port }), done: () => {} };
    }
    seq += 1;
    const dir = process.platform === 'win32' ? '' : fs.mkdtempSync(path.join(os.tmpdir(), 'm9-ws-'));
    const sock = dir ? path.join(dir, 'm.sock') : `\\\\.\\pipe\\m9-shell-${process.pid}-${seq}`;
    return { listen: [sock], client: () => new Client({ socketPath: sock }), done: () => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } };
  };

  it.each(['tcp', 'socket'])('openWs reports the channel lost when the handshake is not answered within its bound, 45 s unless given (%s)', async (kind) => {
    const place = places(kind);
    const held: net.Socket[] = [];
    const silent = net.createServer((sock) => { held.push(sock); sock.on('error', () => {}); });
    await new Promise<void>((r) => (silent.listen as any)(...place.listen, () => r()));
    const lost: string[] = [];
    let opened = false;
    const started = Date.now();
    const conn = place.client(silent).openWs(() => {}, () => { opened = true; }, (reason) => lost.push(reason), 100);
    for (let i = 0; i < 100 && lost.length === 0; i++) await tick();
    const took = Date.now() - started;
    const accepted = held.length;
    conn.close();
    for (const sock of held) sock.destroy();
    await new Promise<void>((r) => silent.close(() => r()));
    place.done();
    expect(accepted).toBe(1);
    expect(lost).toEqual(['Opening handshake has timed out']);
    expect(opened).toBe(false);
    expect(took).toBeLessThan(1400);
    expect(WS_HANDSHAKE_MS).toBe(45000);
  });

  it.each(['tcp', 'socket'])('an open channel with nothing on it outlives the handshake bound (%s)', async (kind) => {
    const place = places(kind);
    const server = http.createServer();
    const wss = new WebSocketServer({ server, path: '/ws' });
    const got: string[] = [];
    wss.on('connection', (ws) => ws.on('message', (raw) => got.push(raw.toString())));
    await new Promise<void>((r) => (server.listen as any)(...place.listen, () => r()));
    const lost: string[] = [];
    let opened = false;
    const conn = place.client(server).openWs(() => {}, () => { opened = true; }, (reason) => lost.push(reason), 100);
    for (let i = 0; i < 100 && !opened; i++) await tick();
    await new Promise((r) => setTimeout(r, 400));
    const lostWhileIdle = [...lost];
    const sent = conn.send({ type: 'terminal:stop' });
    for (let i = 0; i < 100 && got.length === 0; i++) await tick();
    conn.close();
    for (let i = 0; i < 100 && wss.clients.size > 0; i++) await tick();
    await new Promise<void>((r) => wss.close(() => r()));
    await new Promise<void>((r) => server.close(() => r()));
    place.done();
    expect(opened).toBe(true);
    expect(lostWhileIdle).toEqual([]);
    expect(sent).toBe(true);
    expect(got).toEqual([JSON.stringify({ type: 'terminal:stop' })]);
    expect(lost).toEqual([]);
  });
});

describe('m9 shell: a manager that does not answer', () => {
  const SILENT = "Could not open a shell in mybot-bot-1: the manager did not answer within 0.06 s; can't confirm whether a shell was opened";

  it('a channel that opens and gets no answer ends as refused after the bound, and asks the manager to stop', async () => {
    const { t, f, p } = setup(undefined, undefined, 60);
    f.open();
    expect(await within(p, 1500)).toBe(SILENT);
    expect(f.sent).toEqual([
      { type: 'terminal:start', botId: 'b1', container: 'mybot-bot-1', tty: true, cols: 120, rows: 40 },
      { type: 'terminal:stop' },
    ]);
    expect(t.rawCalls).toEqual([]);
    expect(atRest(t)).toEqual(REST);
    expect(f.st.closedByCaller).toBe(1);
  });

  it('a channel that neither opens nor fails ends the same way, with nothing sent', async () => {
    const { t, f, p } = setup(undefined, undefined, 60);
    expect(await within(p, 1500)).toBe(SILENT);
    expect(f.sent).toEqual([]);
    expect(t.rawCalls).toEqual([]);
    expect(f.st.closedByCaller).toBe(1);
  });

  it('the bound stops counting once the manager says ready', async () => {
    const { f, p } = setup(undefined, undefined, 60);
    f.open();
    f.frame({ type: 'terminal:ready', container: 'mybot-bot-1' });
    expect(await within(p, 250)).toBe('pending');
    expect(f.sent.length).toBe(1);
    f.frame({ type: 'terminal:exit', code: 0 });
    expect(await p).toBeUndefined();
  });

  it('the bound is 60 s when none is given', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let result: string | undefined | 'pending' = 'pending';
    let before: typeof result = 'pending';
    try {
      const { f, p } = setup();
      void p.then((v) => { result = v; });
      f.open();
      await vi.advanceTimersByTimeAsync(59999);
      before = result;
      await vi.advanceTimersByTimeAsync(1);
    } finally {
      vi.useRealTimers();
    }
    expect(before).toBe('pending');
    expect(result).toBe("Could not open a shell in mybot-bot-1: the manager did not answer within 60 s; can't confirm whether a shell was opened");
  });
});

describe('m9 shell: opening', () => {
  it('sends terminal:start with tty and the terminal size once the channel opens, and raw mode waits for ready', async () => {
    const { t, f, p } = setup();
    await tick();
    expect(f.sent).toEqual([]);
    f.open();
    expect(f.sent).toEqual([{ type: 'terminal:start', botId: 'b1', container: 'mybot-bot-1', tty: true, cols: 120, rows: 40 }]);
    t.input.write('early');
    await tick();
    expect(t.rawCalls).toEqual([]);
    expect(f.sent.length).toBe(1);
    f.frame({ type: 'terminal:ready', container: 'mybot-bot-1' });
    expect(t.rawCalls).toEqual([true]);
    await tick();
    // Keys typed before ready wait in the paused input and reach the shell once it is ready.
    expect(f.sent.slice(1)).toEqual([{ type: 'terminal:input', data: b64('early') }]);
    f.frame({ type: 'terminal:exit', code: 0 });
    expect(await p).toBeUndefined();
  });

  it('a terminal without a size asks for 80 by 24', async () => {
    const { f, p } = setup(terminal());
    f.open();
    expect(f.sent[0]).toMatchObject({ cols: 80, rows: 24 });
    f.frame({ type: 'terminal:error', message: 'x' });
    await p;
  });

  it('relays keys as terminal:input and output bytes to the terminal', async () => {
    const { t, f, p } = setup();
    f.open();
    f.frame({ type: 'terminal:ready', container: 'mybot-bot-1' });
    t.input.write('ls\r');
    t.input.write(Buffer.from([3]));
    await tick();
    expect(f.sent.slice(1)).toEqual([
      { type: 'terminal:input', data: b64('ls\r') },
      { type: 'terminal:input', data: b64([3]) },
    ]);
    f.frame({ type: 'terminal:data', data: b64('caf\u00e9 $ ') });
    f.frame({ type: 'status', data: { other: true } });
    f.frame({ type: 'terminal:data', data: 7 });
    expect(t.text()).toBe('caf\u00e9 $ ');
    f.frame({ type: 'terminal:exit', code: 0 });
    await p;
  });

  it('sends the new size on resize', async () => {
    const { t, f, p } = setup();
    f.open();
    t.output.emit('resize');
    expect(f.sent.length).toBe(1);
    f.frame({ type: 'terminal:ready', container: 'mybot-bot-1' });
    t.output.columns = 132;
    t.output.rows = 43;
    t.output.emit('resize');
    expect(f.sent.at(-1)).toEqual({ type: 'terminal:resize', cols: 132, rows: 43 });
    f.frame({ type: 'terminal:exit', code: 0 });
    await p;
  });
});

describe('m9 shell: endings', () => {
  it('exit code 0 returns at once with no notice and restores the terminal', async () => {
    const { t, f, p } = setup();
    f.open();
    f.frame({ type: 'terminal:ready', container: 'mybot-bot-1' });
    f.frame({ type: 'terminal:exit', code: 0 });
    expect(await within(p, 500)).toBeUndefined();
    expect(t.rawCalls).toEqual([true, false]);
    expect(atRest(t)).toEqual(REST);
    expect(f.st.closedByCaller).toBe(1);
    expect(t.text()).not.toContain(SHELL_RETURN);
  });

  it('raw mode goes back to what it was before the shell', async () => {
    const { t, f, p } = setup(terminal({ raw: true }));
    f.open();
    f.frame({ type: 'terminal:ready', container: 'mybot-bot-1' });
    f.frame({ type: 'terminal:exit', code: 0 });
    await p;
    expect(t.rawCalls).toEqual([true, true]);
  });

  it('another exit code leaves raw mode, waits for Enter and gives the notice', async () => {
    const { t, f, p } = setup();
    f.open();
    f.frame({ type: 'terminal:ready', container: 'mybot-bot-1' });
    f.frame({ type: 'terminal:exit', code: 3 });
    expect(await within(p, 150)).toBe('pending');
    expect(t.rawCalls).toEqual([true, false]);
    expect(t.text()).toContain(SHELL_RETURN);
    expect(f.st.closedByCaller).toBe(1);
    const before = f.sent.length;
    t.input.write('x');
    expect(await within(p, 100)).toBe('pending');
    t.input.write('\r');
    expect(await within(p, 500)).toBe('The shell in mybot-bot-1 ended with exit code 3.');
    expect(f.sent.length).toBe(before);
    expect(atRest(t)).toEqual(REST);
  });

  it("an exit without a code says can't confirm, after Enter", async () => {
    const { t, f, p } = setup();
    f.open();
    f.frame({ type: 'terminal:ready', container: 'mybot-bot-1' });
    f.frame({ type: 'terminal:exit', code: null });
    expect(await within(p, 100)).toBe('pending');
    t.input.write('\n');
    expect(await within(p, 500)).toBe("The shell in mybot-bot-1 ended; can't confirm its exit code.");
    f.frame({ type: 'terminal:exit' });
    expect(t.rawCalls).toEqual([true, false]);
  });

  it('an exit the daemon reports as still running says the connection closed, not that the shell ended', async () => {
    const { t, f, p } = setup();
    f.open();
    f.frame({ type: 'terminal:ready', container: 'mybot-bot-1' });
    f.frame({ type: 'terminal:exit', code: null, running: true });
    expect(await within(p, 100)).toBe('pending');
    expect(t.text()).toContain(SHELL_RETURN);
    t.input.write('\r');
    expect(await within(p, 500)).toBe('The connection to the shell in mybot-bot-1 closed; the Docker daemon reports the shell still running.');
    expect(t.rawCalls).toEqual([true, false]);
    expect(atRest(t)).toEqual(REST);
  });

  it("the route's refusal is the notice, at once, and raw mode never starts", async () => {
    const { t, f, p } = setup();
    f.open();
    f.frame({ type: 'terminal:error', message: 'Container is not running' });
    expect(await within(p, 500)).toBe('Could not open a shell in mybot-bot-1: Container is not running');
    expect(t.rawCalls).toEqual([]);
    expect(atRest(t)).toEqual(REST);
    expect(f.st.closedByCaller).toBe(1);
  });

  it('a refusal without a text still names the container', async () => {
    const { f, p } = setup();
    f.open();
    f.frame({ type: 'terminal:error' });
    expect(await p).toBe('Could not open a shell in mybot-bot-1: the manager gave no reason');
  });

  it('a channel that never opens is "could not open" with its reason', async () => {
    const { t, f, p } = setup();
    f.drop('connect ENOENT /run/dbm/manager.sock');
    expect(await within(p, 500)).toBe('Could not open a shell in mybot-bot-1: the connection to the manager did not open (connect ENOENT /run/dbm/manager.sock)');
    expect(t.rawCalls).toEqual([]);
    expect(f.sent).toEqual([]);
  });

  it('a channel that closes before the manager answers is "could not open"', async () => {
    const { t, f, p } = setup();
    f.open();
    f.drop('closed (code 1006)');
    expect(await within(p, 500)).toBe('Could not open a shell in mybot-bot-1: the connection to the manager closed before it answered (closed (code 1006))');
    expect(t.rawCalls).toEqual([]);
    expect(atRest(t)).toEqual(REST);
  });

  it("a channel that closes while the shell is open restores the terminal and says can't confirm", async () => {
    const { t, f, p } = setup();
    f.open();
    f.frame({ type: 'terminal:ready', container: 'mybot-bot-1' });
    f.drop('closed (code 1006)');
    expect(await within(p, 100)).toBe('pending');
    expect(t.rawCalls).toEqual([true, false]);
    expect(t.text()).toContain(SHELL_RETURN);
    t.input.write('\r');
    expect(await within(p, 500)).toBe(
      "The connection to the manager closed while the shell in mybot-bot-1 was open; can't confirm whether a program started in it still runs.",
    );
    expect(atRest(t)).toEqual(REST);
  });

  it('openWs throwing is "could not open" and leaves the terminal as it was', async () => {
    const t = terminal();
    const f = fakeClient({ throws: 'no ws here' });
    const r = await runShellRoute(f.client, 'b1', 'c', { input: t.input, output: t.output });
    expect(r).toBe('Could not open a shell in c: no ws here');
    expect(t.rawCalls).toEqual([]);
    expect(atRest(t)).toEqual(REST);
  });

  it("the terminal's input ending while the shell is open stops the shell and says so", async () => {
    const { t, f, p } = setup();
    f.open();
    f.frame({ type: 'terminal:ready', container: 'mybot-bot-1' });
    t.input.end();
    expect(await within(p, 500)).toBe(
      "This terminal's input ended while the shell in mybot-bot-1 was open, so its connection was closed; can't confirm whether a program started in it still runs.",
    );
    expect(f.sent.at(-1)).toEqual({ type: 'terminal:stop' });
    expect(t.rawCalls).toEqual([true, false]);
    expect(f.st.closedByCaller).toBe(1);
  });

  it('an input that is not a terminal has no raw mode and still relays', async () => {
    const { t, f, p } = setup(terminal({ tty: false }));
    f.open();
    f.frame({ type: 'terminal:ready', container: 'mybot-bot-1' });
    t.input.write('id\n');
    await tick();
    expect(f.sent.at(-1)).toEqual({ type: 'terminal:input', data: b64('id\n') });
    f.frame({ type: 'terminal:exit', code: 0 });
    expect(await p).toBeUndefined();
  });

  it('frames after the ending change nothing', async () => {
    const { t, f, p } = setup();
    f.open();
    f.frame({ type: 'terminal:ready', container: 'mybot-bot-1' });
    f.frame({ type: 'terminal:exit', code: 0 });
    f.frame({ type: 'terminal:ready', container: 'mybot-bot-1' });
    f.frame({ type: 'terminal:data', data: b64('late') });
    f.drop('closed (code 1000)');
    expect(await p).toBeUndefined();
    expect(t.rawCalls).toEqual([true, false]);
    expect(t.text()).not.toContain('late');
    expect(f.st.closedByCaller).toBe(1);
  });
});

describe('m9 shell: the hand-off', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shellWay is the route when the client is on the socket and docker exec otherwise', () => {
    expect(shellWay({ onSocket: true })).toBe('route');
    expect(shellWay({ onSocket: false })).toBe('docker');
    expect(shellWay({})).toBe('docker');
  });

  it('turns bracketed paste off and writes the banner before the channel opens, then enters the frame again', async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as never);
    const t = terminal();
    const f = fakeClient();
    const p = shellRouteHandOff(f.client, 'b1', 'mybot-bot-1', { enter: '<enter>', leave: '<leave>' }, { input: t.input, output: t.output });
    await tick();
    const atOpen = writes.length;
    const opens = f.st.opens;
    f.open();
    const start = f.sent[0];
    f.frame({ type: 'terminal:error', message: 'Bot not found' });
    const notice = await p;
    vi.restoreAllMocks();
    expect(opens).toBe(1);
    expect(atOpen).toBe(2);
    expect(writes[0]).toBe(PASTE_OFF);
    expect(writes[1]).toContain('<leave>');
    expect(writes[1]).toContain('Shell in mybot-bot-1.');
    expect(start).toMatchObject({ type: 'terminal:start', botId: 'b1', container: 'mybot-bot-1', tty: true });
    expect(notice).toBe('Could not open a shell in mybot-bot-1: Bot not found');
    expect(writes.at(-1)).toBe('<enter>');
  });
});
