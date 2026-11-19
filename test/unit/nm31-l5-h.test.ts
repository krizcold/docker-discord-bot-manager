import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-l5-h-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, notDir: null as null | ((p: string) => boolean) };
});

vi.mock('child_process', async (importOriginal) => (await import('./nm31-run')).childProcessMock(await importOriginal(), require('fs')));
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const base = (await import('./nm31-run')).fsMock(real);
  // As Linux answers a path that runs through a file: ENOTDIR, not ENOENT.
  const realpathSync = Object.assign((p: import('fs').PathLike, o?: any) => {
    if (h.notDir?.(String(p).replace(/\\/g, '/'))) throw Object.assign(new Error(`ENOTDIR: not a directory, lstat '${p}'`), { code: 'ENOTDIR' });
    return real.realpathSync(p, o);
  }, { native: real.realpathSync.native });
  return { ...base, realpathSync, default: { ...(base.default as object), realpathSync } };
});
vi.mock('../../src/docker/dockerClient', async (importOriginal) => {
  const { run } = await import('./nm31-run');
  return {
    ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
    volumeState: (name: string) => run.volumes[name] ?? 'absent',
    listBotContainersAsync: async () => [],
    listComposeContainers: async () => [],
  };
});
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  callAppHook: async () => ({ ok: true, body: { saved: true } }),
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as maintenance from '../../src/instance/maintenance';
import * as repoManager from '../../src/git/repoManager';
import * as terminal from '../../src/webui/terminal';
import * as keptData from '../../src/instance/keptData';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { newStartNames } from '../../src/instance/keptData';
import { createBotRoutes } from '../../src/webui/routes/bots';
import { resetDocker } from './nm2-docker';
import { clearRegistry } from './nm2-harness';
import { resetRun } from './nm31-run';
import { dataDirOf, resetSeed, seedExternal, treeOf } from './nm31-seed';
import { keptAfterStart, NOW, resetBack } from './nm31-back';

const names = () => newStartNames({ sanitizedName: 'bota' }, dataDirOf('a'), NOW);
const filesGate = (p: string) => `${p} is kept data of this bot (Kept data in its Database window), and the Files panel does not change it; nothing was changed`;
const posix = (p: string) => p.replace(/\\/g, '/');
const botDir = () => path.dirname(dataDirOf('a'));

function linkFolder(target: string, at: string): void {
  try {
    fs.symlinkSync(target, at, 'dir');
  } catch (err) {
    if (process.platform !== 'win32') throw err;
    fs.symlinkSync(target, at, 'junction');
  }
}

async function keptUnderFilesBase(): Promise<string> {
  await keptAfterStart('folder', { off: false });
  vi.spyOn(repoManager, 'getDataPath').mockReturnValue(botDir());
  const kept = path.basename(names().outDir);
  expect(fs.existsSync(path.join(botDir(), kept, 'state.json'))).toBe(true);
  return kept;
}

const router = createBotRoutes({ clients: new Set() } as any);
const call = async (method: 'get' | 'post', routePath: string, params: Record<string, string>, body: unknown = {}): Promise<{ status: number; body: any }> => {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
  expect(layer, `${method} ${routePath}`).toBeTruthy();
  const res: any = { statusCode: 200 };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  await layer.route.stack[layer.route.stack.length - 1].handle({ params, query: {}, body }, res);
  return { status: res.statusCode, body: res.body };
};

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  h.notDir = null;
  resetDocker();
  resetRun();
  clearRegistry();
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.rmSync(path.join(h.dir, 'other'), { recursive: true, force: true });
  resetSeed();
  resetBack();
  maintenance.resetMaintenanceState();
});
afterEach(() => {
  h.notDir = null;
  releaseFleetBackupBusy('a');
  vi.restoreAllMocks();
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('nm31 l5 h: the Files panel kept-folder gate', () => {
  it('a folder whose name only contains data.kept- is not kept: a save there succeeds', async () => {
    await keptUnderFilesBase();
    fs.mkdirSync(path.join(botDir(), 'mydata.kept-1'));
    const r = await terminal.fsWrite('a', 'host', 'mydata.kept-1/x.txt', 'hello');
    expect(r).toMatchObject({ success: true });
    expect(fs.readFileSync(path.join(botDir(), 'mydata.kept-1', 'x.txt'), 'utf-8')).toBe('hello');
  });

  it('a Files base inside a folder named data.new-...: a save below the base succeeds', async () => {
    await seedExternal('a');
    const base = path.join(h.dir, 'other', 'data.new-x', 'app');
    fs.mkdirSync(base, { recursive: true });
    vi.spyOn(repoManager, 'getDataPath').mockReturnValue(base);
    const r = await terminal.fsWrite('a', 'host', 'notes.txt', 'hello');
    expect(r).toMatchObject({ success: true });
    expect(fs.readFileSync(path.join(base, 'notes.txt'), 'utf-8')).toBe('hello');
  });

  it('a mkdir two levels below a link into the kept folder is refused, naming where it lands, nothing made', async () => {
    const kept = await keptUnderFilesBase();
    linkFolder(path.join(botDir(), kept), path.join(dataDirOf('a'), 'old'));
    const before = treeOf(names().outDir);
    const real = posix(path.join(fs.realpathSync(path.join(botDir(), kept)), 'sub', 'deeper'));
    expect(await terminal.fsMkdir('a', 'host', 'data/old/sub/deeper')).toEqual({ success: false, error: filesGate(real) });
    expect(treeOf(names().outDir)).toEqual(before);
  });

  it('a path whose realpath fails with other than ENOENT is not walked up into the kept folder', async () => {
    const kept = await keptUnderFilesBase();
    linkFolder(path.join(botDir(), kept), path.join(dataDirOf('a'), 'old'));
    h.notDir = (p) => /\/state\.json\/x(\/|$)/.test(p);
    const before = treeOf(names().outDir);
    const r = await terminal.fsMkdir('a', 'host', 'data/old/state.json/x/y');
    h.notDir = null;
    expect(r.success).toBe(false);
    expect(r.error).not.toContain('is kept data of this bot');
    expect(treeOf(names().outDir)).toEqual(before);
  });

  it('a folder named as kept that links to a plain folder is still refused by its name', async () => {
    await keptUnderFilesBase();
    const plain = path.join(botDir(), 'plain');
    fs.mkdirSync(plain);
    const linkName = 'data.kept-2026-01-01T00-00-00-000Z';
    linkFolder(plain, path.join(botDir(), linkName));
    const abs = posix(path.join(botDir(), linkName, 'x.txt'));
    expect(await terminal.fsWrite('a', 'host', `${linkName}/x.txt`, 'hello')).toEqual({ success: false, error: filesGate(abs) });
    expect(fs.readdirSync(plain)).toEqual([]);
  });

  it('a save to a missing folder inside the kept folder is refused before the folder is made', async () => {
    const kept = await keptUnderFilesBase();
    const before = treeOf(names().outDir);
    const abs = posix(path.join(botDir(), kept, 'sub', 'new.txt'));
    expect(await terminal.fsWrite('a', 'host', `${kept}/sub/new.txt`, 'hello')).toEqual({ success: false, error: filesGate(abs) });
    expect(treeOf(names().outDir)).toEqual(before);
  });

  it('a mkdir outside the kept folder answers success with its path', async () => {
    await keptUnderFilesBase();
    const abs = posix(path.join(dataDirOf('a'), 'fresh'));
    expect(await terminal.fsMkdir('a', 'host', 'data/fresh')).toEqual({ success: true, path: abs });
    expect(fs.statSync(path.join(dataDirOf('a'), 'fresh')).isDirectory()).toBe(true);
  });
});

describe('nm31 l5 h: the routes', () => {
  it('GET / carries keptStartVariant for a hooks bot', async () => {
    await seedExternal('a');
    const r = await call('get', '/', {});
    const bot = (Array.isArray(r.body) ? r.body : r.body.bots).find((b: any) => b.id === 'a');
    expect(bot.keptStartVariant).toBe('folder');
  });

  const throwing: Array<[string, string, Record<string, string>, string]> = [
    ['new-start', '/:id/fleet-db/new-start', { id: 'a' }, 'startOnNewDatabase'],
    ['put-back', '/:id/fleet-db/kept/:set/put-back', { id: 'a', set: 's' }, 'putBack'],
    ['delete', '/:id/fleet-db/kept/:set/delete', { id: 'a', set: 's' }, 'deleteKept'],
    ['abandon', '/:id/fleet-db/kept/abandon', { id: 'a' }, 'keepKept'],
  ];
  for (const [name, route, params, fn] of throwing) {
    it(`${name}: a throw answers 500 with success false and the error`, async () => {
      vi.spyOn(keptData as any, fn).mockRejectedValue(new Error('boom'));
      expect(await call('post', route, params)).toEqual({ status: 500, body: { success: false, error: 'Error: boom' } });
    });
  }
});
