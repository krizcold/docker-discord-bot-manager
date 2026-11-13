import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as http from 'http';

const h = vi.hoisted(() => ({
  port: 0,
  status: 200,
  body: '{"success":true}' as string,
  type: 'application/json',
  hold: null as null | Promise<void>,
  requests: [] as Array<{ method: string; path: string; token: string; body: any }>,
  containerId: 'c1' as string | null | undefined,
  startedAt: '2026-11-12T10:00:00.000Z' as string | null,
  inspected: [] as string[],
  app: { running: true, useMb: 300, limitMb: 0 } as any,
  host: { ok: true, availableMb: 1000 } as any,
}));

const bot = { id: 'b1', displayName: 'Bot One', sanitizedName: 'b1', sourceUrl: 'x', updateToken: 'tok', envVars: {} };
vi.mock('../../src/docker/containerManager', () => ({
  readDeployedCompose: () => 'services: {}',
  getAllBots: () => [bot],
  getBot: () => bot,
  runningAppContainer: async () => h.containerId,
  getAppMemory: async () => h.app,
}));
vi.mock('../../src/docker/dockerClient', () => ({ containerStartedAt: async (id: string) => { h.inspected.push(id); return h.startedAt; } }));
vi.mock('../../src/templates/pcsProcessing', () => ({ fleetAppContainerName: () => '127.0.0.1' }));
vi.mock('../../src/config/appCapabilities', async (o) => ({ ...(await o<typeof import('../../src/config/appCapabilities')>()), findAppCapabilities: () => ({ hooks: { port: h.port, basePath: '/api/managed' } }) }));
vi.mock('../../src/instance/fleetSwitch', () => ({ switchTickOn: () => false }));
vi.mock('../../src/instance/memoryRoom', async (o) => ({ ...(await o<typeof import('../../src/instance/memoryRoom')>()), readHostMemory: () => h.host }));

import { MEMORY_SEND_TIMING, memorySendState, runMemorySendTick } from '../../src/instance/memorySend';

let server: http.Server;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', async () => {
      h.requests.push({ method: req.method!, path: req.url!, token: String(req.headers['x-bot-token']), body: raw ? JSON.parse(raw) : null });
      if (h.hold) await h.hold;
      res.writeHead(h.status, { 'content-type': h.type });
      res.end(h.body);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  h.port = (server.address() as any).port;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

let logs: string[] = [];
let t0 = 1_000_000_000;
beforeEach(() => {
  t0 += 100_000_000;
  bot.id = `b${t0}`;
  h.status = 200; h.body = '{"success":true}'; h.type = 'application/json'; h.hold = null;
  h.requests = [];
  h.containerId = `c${t0}`;
  h.startedAt = '2026-11-12T10:00:00.000Z';
  h.inspected = [];
  h.app = { running: true, useMb: 300, limitMb: 0 };
  h.host = { ok: true, availableMb: 1000 };
  logs = [];
  for (const k of ['log', 'warn', 'error'] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
});
afterEach(() => vi.restoreAllMocks());

const NOT_FOUND = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot POST /api/managed/memory</pre>\n</body>\n</html>\n';
const memLogs = () => logs.filter(l => l.startsWith('[Memory]'));

describe('NM12: the sender', () => {
  it('the timing', () => {
    expect(MEMORY_SEND_TIMING).toEqual({ firstTickMs: 30_000, tickMs: 30_000, everyMs: 300_000, freshMs: 180_000, hookMs: 10_000 });
  });

  it('a first send at the first tick: path, token, body without error when room is true', async () => {
    await runMemorySendTick(t0);
    expect(h.requests).toHaveLength(1);
    const r = h.requests[0];
    expect(r.method).toBe('POST');
    expect(r.path).toBe('/api/managed/memory');
    expect(r.token).toBe('tok');
    expect(Object.keys(r.body).sort()).toEqual(['at', 'freeMb', 'room', 'useMb']);
    expect(r.body).toMatchObject({ room: true, useMb: 300, freeMb: 1000 });
    expect(new Date(r.body.at).toISOString()).toBe(r.body.at);
    expect(memorySendState(bot.id)).toEqual({ kind: 'taken', at: expect.any(Number) });
    expect(memLogs()).toEqual([]);
  });

  it('room null: the error rides the body', async () => {
    h.host = { ok: false, error: '/proc/meminfo has no MemAvailable line' };
    await runMemorySendTick(t0);
    expect(h.requests[0].body).toMatchObject({ room: null, useMb: 300, freeMb: null, error: '/proc/meminfo has no MemAvailable line' });
  });

  it('a negative free reading is floored at 0', async () => {
    h.app = { running: true, useMb: 600, limitMb: 500 };
    await runMemorySendTick(t0);
    expect(h.requests[0].body).toMatchObject({ room: false, useMb: 600, freeMb: 0 });
    expect('error' in h.requests[0].body).toBe(false);
  });

  it('no second send before 5 minutes, one at 5 minutes', async () => {
    await runMemorySendTick(t0);
    await runMemorySendTick(t0 + 30_000);
    await runMemorySendTick(t0 + 299_999);
    expect(h.requests).toHaveLength(1);
    await runMemorySendTick(t0 + 300_000);
    expect(h.requests).toHaveLength(2);
  });

  it('a new container id sends at once', async () => {
    await runMemorySendTick(t0);
    h.containerId = `d${t0}`;
    await runMemorySendTick(t0 + 30_000);
    expect(h.requests).toHaveLength(2);
  });

  it('a restart in place (same id, new start time) sends at once', async () => {
    await runMemorySendTick(t0);
    await runMemorySendTick(t0 + 30_000);
    expect(h.requests).toHaveLength(1);
    expect(h.inspected).toEqual([`c${t0}`, `c${t0}`]);
    h.startedAt = '2026-11-12T10:05:00.000Z';
    await runMemorySendTick(t0 + 60_000);
    expect(h.requests).toHaveLength(2);
  });

  it('an inspect that fails counts as changed: a send is due', async () => {
    await runMemorySendTick(t0);
    h.startedAt = null;
    await runMemorySendTick(t0 + 30_000);
    expect(h.requests).toHaveLength(2);
  });

  it("no answer within the bound: unknown, the window and the log say can't confirm", async () => {
    const was = MEMORY_SEND_TIMING.hookMs;
    MEMORY_SEND_TIMING.hookMs = 1_000;
    let release!: () => void;
    h.hold = new Promise<void>(r => { release = r; });
    try {
      await runMemorySendTick(t0);
    } finally {
      MEMORY_SEND_TIMING.hookMs = was;
      release();
    }
    expect(memorySendState(bot.id)).toEqual({ kind: 'failed', at: t0, unknown: true, error: 'no answer within 1 s' });
    expect(memLogs()).toEqual(["[Memory] Bot One: can't confirm the bot got the memory reading: no answer within 1 s"]);
  });

  it('three ticks with the inspect failing and a 404 print one log line', async () => {
    h.startedAt = null;
    h.status = 404; h.body = NOT_FOUND; h.type = 'text/html; charset=utf-8';
    await runMemorySendTick(t0);
    await runMemorySendTick(t0 + 30_000);
    await runMemorySendTick(t0 + 60_000);
    expect(h.requests).toHaveLength(3);
    expect(memLogs()).toEqual(["[Memory] Bot One: this bot's build does not take the memory reading (it answered 404)"]);
  });

  it('a stopped container sends nothing and drops the entry', async () => {
    await runMemorySendTick(t0);
    expect(memorySendState(bot.id)).not.toBeNull();
    h.containerId = null;
    await runMemorySendTick(t0 + 300_000);
    expect(h.requests).toHaveLength(1);
    expect(memorySendState(bot.id)).toBeNull();
  });

  it('docker unanswered sends nothing and keeps the entry', async () => {
    await runMemorySendTick(t0);
    h.containerId = undefined;
    await runMemorySendTick(t0 + 300_000);
    expect(h.requests).toHaveLength(1);
    expect(memorySendState(bot.id)).toEqual({ kind: 'taken', at: expect.any(Number) });
  });

  it('a reading of a stopped app sends nothing', async () => {
    h.app = { running: false };
    await runMemorySendTick(t0);
    expect(h.requests).toHaveLength(0);
  });

  it('a failed send is retried each tick for 3 minutes of the container, then every 5 minutes', async () => {
    h.status = 400; h.body = JSON.stringify({ success: false, error: 'room must be true, false or null' });
    await runMemorySendTick(t0);
    expect(memorySendState(bot.id)).toEqual({ kind: 'failed', at: expect.any(Number), error: 'room must be true, false or null' });
    expect(memLogs()).toEqual(["[Memory] Bot One: the memory reading was not delivered: room must be true, false or null"]);
    await runMemorySendTick(t0 + 29_999);
    expect(h.requests).toHaveLength(1);
    await runMemorySendTick(t0 + 30_000);
    await runMemorySendTick(t0 + 60_000);
    await runMemorySendTick(t0 + 150_000);
    expect(h.requests).toHaveLength(4);
    await runMemorySendTick(t0 + 180_000);
    await runMemorySendTick(t0 + 300_000);
    expect(h.requests).toHaveLength(4);
    await runMemorySendTick(t0 + 450_000);
    expect(h.requests).toHaveLength(5);
    expect(memLogs()).toHaveLength(1);
    h.status = 200; h.body = '{"success":true}';
    await runMemorySendTick(t0 + 750_000);
    expect(memLogs()[1]).toBe('[Memory] Bot One: the bot took the memory reading');
  });

  it("Express's 404: no-hook and one log line, a second 404 no second line", async () => {
    h.status = 404; h.body = NOT_FOUND; h.type = 'text/html; charset=utf-8';
    await runMemorySendTick(t0);
    expect(memorySendState(bot.id)).toEqual({ kind: 'no-hook', at: expect.any(Number) });
    await runMemorySendTick(t0 + 300_000);
    expect(h.requests).toHaveLength(2);
    expect(memLogs()).toEqual(["[Memory] Bot One: this bot's build does not take the memory reading (it answered 404)"]);
  });

  it('a tick still running starts no second pass', async () => {
    let release!: () => void;
    h.hold = new Promise<void>(r => { release = r; });
    const first = runMemorySendTick(t0);
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    h.containerId = `e${t0}`;
    await runMemorySendTick(t0 + 1);
    release();
    await first;
    expect(h.requests).toHaveLength(1);
  });
});
