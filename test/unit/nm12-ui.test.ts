import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm12-ui-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

const bot = { id: 'a', displayName: 'A', sanitizedName: 'a', sourceUrl: 'x', updateToken: 't', envVars: {} };
vi.mock('../../src/docker/containerManager', async (o) => ({
  ...(await o<typeof import('../../src/docker/containerManager')>()),
  getAllBots: () => [bot],
  getBot: () => bot,
  runningAppContainer: async () => 'c1',
  getAppMemory: async () => ({ running: true, useMb: 300, limitMb: 0 }),
}));
vi.mock('../../src/docker/dockerClient', async (o) => ({
  ...(await o<typeof import('../../src/docker/dockerClient')>()),
  containerStartedAt: async () => '2026-11-12T10:00:00.000Z',
}));
vi.mock('../../src/instance/appHookClient', async (o) => ({
  ...(await o<typeof import('../../src/instance/appHookClient')>()),
  hasAppHooks: () => true,
  callAppHook: async () => ({ ok: false, status: 404, error: 'memory returned 404' }),
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import { runMemorySendTick } from '../../src/instance/memorySend';
import { createBotRoutes } from '../../src/webui/routes/bots';

const pageHtml = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
const pageFunction = (name: string): string => {
  const start = pageHtml.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`no function ${name}`);
  let i = pageHtml.indexOf('{', pageHtml.indexOf(')', start));
  for (let depth = 0; ; i++) {
    if (pageHtml[i] === '{') depth++;
    else if (pageHtml[i] === '}' && --depth === 0) return pageHtml.slice(start, i + 1);
  }
};
const ctx = vm.createContext({});
vm.runInContext(pageFunction('memoryLineText'), ctx);
const text = (res: unknown): string => ctx.memoryLineText(res);

const lead = 'Room to reshard beside the running shards: ';
const readings = [
  [{ running: true, room: true, useMb: 300, freeMb: 1000 }, `${lead}yes, 1000 MB free for 300 MB`],
  [{ running: true, room: false, useMb: 300, freeMb: 212 }, `${lead}no, 212 MB free for 300 MB`],
  [{ running: true, room: null, useMb: 300, freeMb: null, error: 'docker did not answer' }, `${lead}can't confirm: docker did not answer`],
] as const;

describe('NM12: the memory line names what the bot got', () => {
  for (const [memory, base] of readings) {
    it(`${base}: no-hook, failed and taken`, () => {
      expect(text({ success: true, memory, sent: { kind: 'no-hook', at: 1 } })).toBe(`${base}; this bot's build does not take the reading`);
      expect(text({ success: true, memory, sent: { kind: 'failed', at: 1, error: 'memory unreachable: fetch failed' } })).toBe(`${base}; the bot did not get it: memory unreachable: fetch failed`);
      expect(text({ success: true, memory, sent: { kind: 'failed', at: 1, unknown: true, error: 'no answer within 10 s' } })).toBe(`${base}; can't confirm the bot got it: no answer within 10 s`);
      expect(text({ success: true, memory, sent: { kind: 'taken', at: 1 } })).toBe(base);
      expect(text({ success: true, memory })).toBe(base);
    });
  }
  it('a stopped bot and the manager errors get nothing', () => {
    for (const sent of [{ kind: 'no-hook', at: 1 }, { kind: 'failed', at: 1, error: 'x' }]) {
      expect(text({ success: true, memory: { running: false }, sent })).toBe(`${lead}the bot is not running`);
      expect(text({ success: false, error: 'Bot not found', sent })).toBe(`${lead}can't confirm: Bot not found`);
    }
    expect(text(null)).toBe(`${lead}can't confirm: no answer from the manager`);
  });
});

describe('NM12: the memory route answers sent', () => {
  const router = createBotRoutes({ clients: new Set() } as any);
  const call = async (): Promise<any> => {
    const layer = (router as any).stack.find((l: any) => l.route?.path === '/:id/memory' && l.route.methods.get);
    const res: any = { statusCode: 200 };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    await layer.route.stack[layer.route.stack.length - 1].handle({ params: { id: 'a' }, query: {}, body: {} }, res);
    return res.body;
  };
  it('no sent key before any tick, the outcome after one', async () => {
    const before = await call();
    expect(before.success).toBe(true);
    expect('sent' in before).toBe(false);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runMemorySendTick(5_000);
    const after = await call();
    expect(after.sent).toEqual({ kind: 'no-hook', at: 5_000 });
    fs.rmSync(h.dir, { recursive: true, force: true });
  });
});
