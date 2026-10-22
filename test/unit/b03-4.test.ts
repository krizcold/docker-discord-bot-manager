import http from 'http';
import { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { Client } from '../../src/cli/client';
import { dispatch } from '../../src/cli/commands';

class Exit extends Error {
  constructor(public code: number) { super(`exit ${code}`); }
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, ws: { send: (type: string, data: unknown) => void; closeAll: () => void }) => void;

let server: http.Server;
let wss: WebSocketServer;
let handler: Handler;
let out = '';
let err = '';

const wsApi = {
  send: (type: string, data: unknown) => {
    for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type, data }));
  },
  closeAll: () => { for (const c of wss.clients) c.terminate(); },
};

beforeEach(async () => {
  out = '';
  err = '';
  server = http.createServer((req, res) => handler(req, res, wsApi));
  wss = new WebSocketServer({ server, path: '/ws' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Exit(code ?? 0); }) as never);
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out += s; return true; }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => { err += s; return true; }) as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  wsApi.closeAll();
  wss.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

function client(): Client {
  return new Client({ host: '127.0.0.1', port: (server.address() as AddressInfo).port });
}

async function run(positionals: string[], flags: Record<string, string | boolean> = {}): Promise<number> {
  try {
    await dispatch(client(), positionals, { json: true, ...flags });
  } catch (e) {
    if (e instanceof Exit) return e.code;
    throw e;
  }
  return await new Promise<number>((resolve, reject) => {
    (process.exit as unknown as { mockImplementation: (f: (c?: number) => never) => void }).mockImplementation(((c?: number) => {
      resolve(c ?? 0);
      throw new Exit(c ?? 0);
    }) as never);
    setTimeout(() => reject(new Error('no exit')), 8000);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

describe('B03-4 dbm lifecycle answers', () => {
  it('a start without --wait says accepted and not finished', async () => {
    handler = (_q, res) => json(res, 200, { success: true, message: 'Starting bot', opId: 'op1' });
    const code = await run(['bots', 'start', 'b1']);
    expect(code).toBe(0);
    const body = JSON.parse(out);
    expect(body.accepted).toBe(true);
    expect(body.finished).toBe(false);
  });

  it('--wait ignores a terminal event of another op for the same bot', async () => {
    handler = (_q, res, ws) => {
      json(res, 200, { success: true, message: 'Restarting bot', opId: 'mine' });
      setTimeout(() => {
        ws.send('bot:restarted', { id: 'b1', opId: 'other' });
        ws.send('bot:restarted', { id: 'b1' });
        ws.send('bot:restart-failed', { id: 'b1', opId: 'mine', error: 'boom' });
      }, 50);
    };
    expect(await run(['bots', 'restart', 'b1'], { wait: true })).toBe(1);
    expect(JSON.parse(out).event.type).toBe('bot:restart-failed');
  });

  it('--wait matches an event that lands before the POST answer is read', async () => {
    handler = (_q, res, ws) => {
      ws.send('bot:started', { id: 'b1', opId: 'early' });
      setTimeout(() => json(res, 200, { success: true, opId: 'early' }), 50);
    };
    expect(await run(['bots', 'start', 'b1'], { wait: true })).toBe(0);
  });

  it('a wait that gives up exits EXIT_TIMEOUT and says the op may still run', async () => {
    handler = (_q, res) => json(res, 200, { success: true, opId: 'op1' });
    expect(await run(['bots', 'build', 'b1'], { wait: true, timeout: '1' })).toBe(3);
    expect(err).toContain('may still be running');
  });

  it('--wait fails at once when the event channel drops', async () => {
    handler = (_q, res, ws) => {
      json(res, 200, { success: true, opId: 'op1' });
      setTimeout(() => ws.closeAll(), 50);
    };
    const t0 = Date.now();
    expect(await run(['bots', 'start', 'b1'], { wait: true, timeout: '5' })).toBe(1);
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(err).toContain('event channel closed');
  });
});

describe('B03-4 dbm streams, lookups and polls', () => {
  const sse = (frames: object[], end: boolean): Handler => (_q, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`);
    if (end) res.end();
    else setTimeout(() => res.destroy(), 50);
  };

  it('a build-log stream ending on done exits 0', async () => {
    handler = sse([{ type: 'log' }, { type: 'done' }], true);
    expect(await run(['bots', 'build-logs', 'b1'])).toBe(0);
  });

  it('a build-log stream ending on failed exits 1', async () => {
    handler = sse([{ type: 'log' }, { type: 'failed', error: 'x' }], true);
    expect(await run(['bots', 'build-logs', 'b1'])).toBe(1);
  });

  it('a build-log stream cut before its terminal frame exits EXIT_TIMEOUT', async () => {
    handler = sse([{ type: 'status' }, { type: 'log' }], false);
    expect(await run(['bots', 'build-logs', 'b1'])).toBe(3);
  });

  it('a bot lookup whose list read fails names the read, not a missing bot', async () => {
    handler = (_q, res) => json(res, 500, { success: false, error: 'registry broken' });
    expect(await run(['bots', 'port', 'b1'])).toBe(1);
    expect(err).toContain('could not list bots: registry broken');
  });

  it('wait --until never judges an error answer and names it at the deadline', async () => {
    handler = (_q, res) => json(res, 503, { success: false, error: 'down' });
    expect(await run(['wait'], { get: '/api/health', until: 'true', interval: '100', timeout: '1' })).toBe(3);
    expect(err).toContain('GET /api/health answered 503: down');
  });

  it('wait --until polls through a refused connection', async () => {
    const port = (server.address() as AddressInfo).port;
    let n = 0;
    handler = (_q, res) => json(res, 200, { ready: true });
    const c = new Client({ host: '127.0.0.1', port });
    const orig = c.request.bind(c);
    c.request = ((...a: Parameters<Client['request']>) => (n++ === 0 ? Promise.reject(new Error('connect ECONNREFUSED')) : orig(...a))) as Client['request'];
    let code = -1;
    try {
      await dispatch(c, ['wait'], { json: true, get: '/x', until: 'data.ready', interval: '50', timeout: '3' });
    } catch (e) {
      if (e instanceof Exit) code = e.code; else throw e;
    }
    expect(code).toBe(0);
    expect(n).toBe(2);
  });
});
