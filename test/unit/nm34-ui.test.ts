import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm34-ui-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    broadcasts: [] as Array<{ type: string; payload: any }>,
    maintListener: null as null | ((botId: string, result: any, notify: boolean) => void),
    migrateListener: null as null | ((botId: string, ev: any) => void),
    /** Runs inside the order stub before its callback. */
    beforeDone: null as null | (() => void),
    doneThrew: null as unknown,
  };
});

vi.mock('child_process', async (importOriginal) => (await import('./nm31-run')).childProcessMock(await importOriginal(), require('fs')));
vi.mock('fs', async (importOriginal) => (await import('./nm31-run')).fsMock(await importOriginal()));
vi.mock('../../src/docker/dockerClient', async (importOriginal) => {
  const { run } = await import('./nm31-run');
  return {
    ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
    volumeState: (name: string) => run.volumes[name] ?? 'absent',
    listBotContainersAsync: async () => [],
  };
});
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  callAppHook: async () => ({ ok: true, body: { saved: true } }),
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: (_w: unknown, type: string, payload: unknown) => { h.broadcasts.push({ type, payload }); } }));
vi.mock('../../src/instance/maintenance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/maintenance')>()),
  orderMaintenance: async (_botId: string, _to: string, _message: string, onDone: (r: unknown) => void) => {
    h.beforeDone?.();
    try { onDone({ settled: false, text: 'x' }); } catch (e) { h.doneThrew = e; }
    return { accepted: true };
  },
  setMaintenanceListener: (fn: any) => { h.maintListener = fn; },
}));
vi.mock('../../src/instance/migrate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/migrate')>()),
  setMigrateListener: (fn: any) => { h.migrateListener = fn; },
}));

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as dbLogin from '../../src/instance/dbLogin';
import * as envManager from '../../src/env/manager';
import * as maintenance from '../../src/instance/maintenance';
import { createBotRoutes } from '../../src/webui/routes/bots';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { resetDocker } from './nm2-docker';
import { clearRegistry } from './nm2-harness';
import { resetRun } from './nm31-run';
import { offOrder, resetSeed, seedMain } from './nm31-seed';
import { offOrderNoAdmin, resetOwner } from './nm34-seed';

afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

const pageHtml = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
const pageFunction = (name: string): string => {
  let start = pageHtml.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`no function ${name}`);
  if (pageHtml.slice(start - 6, start) === 'async ') start -= 6;
  let i = pageHtml.indexOf('(', start);
  for (let depth = 0; ; i++) {
    if (pageHtml[i] === '(') depth++;
    else if (pageHtml[i] === ')' && --depth === 0) break;
  }
  i = pageHtml.indexOf('{', i);
  for (let depth = 0; ; i++) {
    if (pageHtml[i] === '{') depth++;
    else if (pageHtml[i] === '}' && --depth === 0) return pageHtml.slice(start, i + 1);
  }
};

const PAGE_FNS = ['keptStartShown', 'keptStartVariant', 'keptStartConfirmText', 'keptAnswer', 'keptStart', 'mergeBotState', 'onBotMaintenance'];

/** The page's functions over `bots`, as the page holds them after a list load. */
const page = (bots: unknown[]) => {
  const confirms: string[] = [];
  const ctx = vm.createContext({
    api: async () => ({ success: true, text: 'done' }),
    showMessage: () => {},
    showNoAnswer: () => {},
    confirm: (t: string) => { confirms.push(t); return false; },
    loadBots: async () => {},
    clearActiveOp: () => {},
    redraw: () => {},
    refreshStateLine: () => {},
    setTimeout: () => 0,
    bots,
    document: { getElementById: () => ({ innerHTML: '', textContent: '', isConnected: true, classList: { remove: () => {}, add: () => {} } }) },
    Array, String, Number, JSON, Date, Math, Object, encodeURIComponent,
  });
  vm.runInContext(['escapeHtml', 'jsArg', ...PAGE_FNS].map(pageFunction).join('\n'), ctx);
  return { ctx, confirms };
};

const router = createBotRoutes({ clients: new Set() } as any);
const call = async (method: 'get' | 'put', routePath: string, params: Record<string, string>, body: unknown = {}): Promise<{ status: number; body: any }> => {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
  const res: any = { statusCode: 200 };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  await layer.route.stack[layer.route.stack.length - 1].handle({ params, query: {}, body }, res);
  return { status: res.statusCode, body: res.body };
};

/** The list route's entry for bot a. */
async function listed(): Promise<any> {
  const r = await call('get', '/', {});
  expect(r.body.success).toBe(true);
  return r.body.bots.find((b: { id: string }) => b.id === 'a');
}

/** A main whose Off ran on a cluster with no dbm_admin. */
async function naOff(): Promise<void> {
  await seedMain('a', { off: false });
  await offOrderNoAdmin('a');
  expect(maintenance.noAdminOff(containerManagerBot().maintenance!)).toBe(true);
}

/** A main whose Off stayed unsettled for another reason: the bot's login could not be blocked. */
async function otherOff(seed = true): Promise<void> {
  if (seed) await seedMain('a', { off: false });
  await offOrder('a', { blockFails: 'ERROR:  permission denied to alter role' });
}

function containerManagerBot() {
  const reg = JSON.parse(fs.readFileSync(path.join(h.dir, 'instances.json'), 'utf-8'));
  return reg.instances.a as { maintenance?: Parameters<typeof maintenance.noAdminOff>[0] };
}

const SENTENCE = " Its Off is not confirmed because the database has no dbm_admin role; the start first checks, as the bot's own role and without writing, that no session of the bot uses the database.";
const MAIN_FIRST = "The bot's database is stopped, and its volume and the bot's data folder are kept as they are, the folder under the name data.kept-<the start's time>. A new empty database starts on a new volume with the same login, so the Database URL does not change.";

const payloads = (type: string) => h.broadcasts.filter(b => b.type === type).map(b => b.payload);

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  resetDocker();
  resetRun();
  clearRegistry();
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  resetSeed();
  resetOwner();
  dbLogin.resetManagerRoleCache();
  h.broadcasts = [];
  h.beforeDone = null;
  h.doneThrew = null;
});
afterEach(() => {
  releaseFleetBackupBusy('a');
  vi.restoreAllMocks();
});

describe('nm34 ui: the button and its confirm', () => {
  it('keptStartShown (1 of 2): an Off left unsettled only by the missing dbm_admin shows Start on a new database', async () => {
    await naOff();
    const bot = await listed();
    expect(bot.maintenance).toMatchObject({ state: 'off', settled: false });
    const { ctx } = page([bot]);
    expect(ctx.keptStartShown(bot)).toBe(true);
  });

  it('keptStartShown (2 of 2): an Off unsettled for another reason does not show it', async () => {
    await otherOff();
    const bot = await listed();
    expect(bot.maintenance).toMatchObject({ state: 'off', settled: false });
    expect(bot.keptNoAdminOff).toBe(false);
    const { ctx } = page([bot]);
    expect(ctx.keptStartShown(bot)).toBe(false);
  });

  it('confirm: the NA Off adds the sentence before Put back\'s line', async () => {
    await naOff();
    const bot = await listed();
    const { ctx, confirms } = page([bot]);
    const text = `Start on a new database?\n\n${MAIN_FIRST} The bot gets a new data folder that holds maintenance.json so its next start is a maintenance boot. The bot stays stopped, and its State becomes Running.${SENTENCE}\n\nPut back returns the kept database and folder; Delete removes them after a dump.`;
    expect(ctx.keptStartConfirmText(bot)).toBe(text);
    await ctx.keptStart('a');
    expect(confirms).toEqual([text]);
  });
});

describe('nm34 ui: the list route', () => {
  it('G1 (code review 1): a no-dbm_admin Off on a bot whose variant is no longer the main one: keptNoAdminOff false, the button hidden', async () => {
    await naOff();
    envManager.setEnvVars('a', { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: 'postgresql://smdb:pw@db.example:5432/smdb' });
    expect(maintenance.noAdminOff(containerManagerBot().maintenance!)).toBe(true);
    const bot = await listed();
    expect(bot.keptStartVariant).toBe('folder');
    expect(bot.maintenance).toMatchObject({ state: 'off', settled: false });
    expect(bot.keptNoAdminOff).toBe(false);
    const { ctx } = page([bot]);
    expect(ctx.keptStartShown(bot)).toBe(false);
  });

  it('list (1 of 2): keptNoAdminOff true for the NA Off, beside the variant', async () => {
    await naOff();
    const bot = await listed();
    expect(bot.keptNoAdminOff).toBe(true);
    expect(bot.keptStartVariant).toBe('main');
  });

  it('list (2 of 2): keptNoAdminOff false for a settled Off, and its confirm has no NA sentence', async () => {
    await seedMain('a');
    const bot = await listed();
    expect(bot.maintenance).toMatchObject({ state: 'off', settled: true });
    expect(bot.keptNoAdminOff).toBe(false);
    expect(bot.keptStartVariant).toBe('main');
    const { ctx } = page([bot]);
    expect(ctx.keptStartConfirmText(bot)).not.toContain(SENTENCE);
  });
});

describe('nm34 ui: bot:maintenance through onBotMaintenance', () => {
  it('merge (1 of 2): a payload carrying keptNoAdminOff true shows the button', async () => {
    await otherOff();
    const bots = [await listed()];
    const { ctx } = page(bots);
    expect(ctx.keptStartShown(ctx.bots[0])).toBe(false);
    const r = await offOrderNoAdmin('a');
    h.maintListener!('a', r, true);
    const [payload] = payloads('bot:maintenance');
    expect(payload.keptNoAdminOff).toBe(true);
    ctx.onBotMaintenance(payload);
    expect(ctx.bots[0].keptNoAdminOff).toBe(true);
    expect(ctx.keptStartShown(ctx.bots[0])).toBe(true);
  });

  it('merge (2 of 2): a payload carrying keptNoAdminOff false replaces the stale true and hides the button', async () => {
    await naOff();
    const bots = [await listed()];
    const { ctx } = page(bots);
    expect(ctx.keptStartShown(ctx.bots[0])).toBe(true);
    await otherOff(false);
    h.maintListener!('a', { settled: false, text: 'x' }, true);
    const [payload] = payloads('bot:maintenance');
    expect(payload.keptNoAdminOff).toBe(false);
    ctx.onBotMaintenance(payload);
    expect(ctx.bots[0].keptNoAdminOff).toBe(false);
    expect(ctx.keptStartShown(ctx.bots[0])).toBe(false);
  });
});

describe('nm34 ui: the broadcasts that carry the two fields', () => {
  it('broadcast (1 of 3): the maintenance listener\'s bot:maintenance', async () => {
    await naOff();
    h.maintListener!('a', { settled: false, text: 'x' }, false);
    expect(payloads('bot:maintenance')).toEqual([expect.objectContaining({ id: 'a', keptNoAdminOff: true, keptStartVariant: 'main' })]);
  });

  it('broadcast (2 of 3): the order callback\'s bot:maintenance', async () => {
    await naOff();
    const r = await call('put', '/:id/maintenance', { id: 'a' }, { state: 'off' });
    expect(r.body.success).toBe(true);
    expect(h.doneThrew).toBeNull();
    expect(payloads('bot:maintenance')).toEqual([expect.objectContaining({ id: 'a', opId: r.body.opId, keptNoAdminOff: true, keptStartVariant: 'main' })]);
  });

  it('broadcast (3 of 3): bot:migrate', async () => {
    await naOff();
    h.migrateListener!('a', { text: 'Migration runs', final: false });
    expect(payloads('bot:migrate')).toEqual([expect.objectContaining({ id: 'a', text: 'Migration runs', keptNoAdminOff: true, keptStartVariant: 'main' })]);
  });
});

describe('nm34 ui: the bot deleted before a broadcast', () => {
  const lacksFields = (p: Record<string, unknown>) => {
    expect(p.id).toBe('a');
    expect('keptNoAdminOff' in p).toBe(false);
    expect('keptStartVariant' in p).toBe(false);
  };

  it('deleted (1 of 3): the maintenance listener sends no field and throws nothing', async () => {
    await naOff();
    clearRegistry();
    expect(() => h.maintListener!('a', { settled: false, text: 'x' }, false)).not.toThrow();
    const sent = payloads('bot:maintenance');
    expect(sent.length).toBe(1);
    lacksFields(sent[0]);
  });

  it('deleted (2 of 3): the order callback sends no field and throws nothing', async () => {
    await naOff();
    h.beforeDone = () => clearRegistry();
    const r = await call('put', '/:id/maintenance', { id: 'a' }, { state: 'off' });
    expect(r.body.success).toBe(true);
    expect(h.doneThrew).toBeNull();
    const sent = payloads('bot:maintenance');
    expect(sent.length).toBe(1);
    lacksFields(sent[0]);
  });

  it('deleted (3 of 3): bot:migrate sends no field and throws nothing', async () => {
    await naOff();
    clearRegistry();
    expect(() => h.migrateListener!('a', { text: 'Migration runs', final: true })).not.toThrow();
    const sent = payloads('bot:migrate');
    expect(sent.length).toBe(1);
    lacksFields(sent[0]);
  });
});
