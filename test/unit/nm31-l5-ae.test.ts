import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-l5-ae-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    remove: { calls: [] as string[], fail: false, throws: false },
    /** fs hooks of this file: a hook answering null or undefined leaves the real call. */
    fsh: {
      readdir: null as null | ((p: string, names: string[]) => string[]),
      lstat: null as null | ((p: string) => 'link' | 'other' | null),
      readlink: null as null | ((p: string) => string | undefined),
      open: [] as Array<[string, unknown, number]>,
      fsync: [] as number[],
      close: [] as number[],
      fsyncFail: null as null | string,
      events: [] as string[],
    },
  };
});

vi.mock('child_process', async (importOriginal) => (await import('./nm31-run')).childProcessMock(await importOriginal(), require('fs')));
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const base = (await import('./nm31-run')).fsMock(real) as Record<string, any>;
  const fakeStat = (kind: 'link' | 'other') => ({
    isSymbolicLink: () => kind === 'link', isDirectory: () => false, isFile: () => false, size: 0, uid: 1000,
  });
  const wrap = {
    readdirSync: (p: any, o?: any) => {
      const names = real.readdirSync(p, o) as any;
      return h.fsh.readdir && !o ? h.fsh.readdir(String(p), names) : names;
    },
    lstatSync: (p: any, o?: any) => {
      const k = h.fsh.lstat?.(String(p));
      return k ? fakeStat(k) : base.lstatSync(p, o);
    },
    readlinkSync: (p: any, o?: any) => h.fsh.readlink?.(String(p)) ?? real.readlinkSync(p, o),
    openSync: (p: any, flags?: any, mode?: any) => {
      const fd = real.openSync(p, flags, mode);
      h.fsh.open.push([String(p), flags, fd]);
      h.fsh.events.push(`open ${fd}`);
      return fd;
    },
    fsyncSync: (fd: number) => {
      h.fsh.fsync.push(fd);
      h.fsh.events.push(`fsync ${fd}`);
      if (h.fsh.fsyncFail) throw new Error(h.fsh.fsyncFail);
      real.fsyncSync(fd);
    },
    closeSync: (fd: number) => {
      h.fsh.close.push(fd);
      h.fsh.events.push(`close ${fd}`);
      real.closeSync(fd);
    },
  };
  return { ...base, ...wrap, default: { ...base.default, ...wrap } };
});
vi.mock('../../src/docker/dockerClient', async (importOriginal) => {
  const { run } = await import('./nm31-run');
  return {
    ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
    volumeState: (name: string) => run.volumes[name] ?? 'absent',
    removeVolume: (name: string) => {
      h.remove.calls.push(name);
      run.volumes[name] = 'absent';
      return true;
    },
    listBotContainersAsync: async () => [],
  };
});
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  callAppHook: async () => ({ ok: true, body: { saved: true } }),
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as fleetReplica from '../../src/instance/fleetReplica';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { deleteDone, deleteKept, KEPT_TEXT } from '../../src/instance/keptData';
import { stampOf } from '../../src/instance/backupFiles';
import { docker, resetDocker } from './nm2-docker';
import { clearRegistry } from './nm2-harness';
import { resetRun, run } from './nm31-run';
import { resetSeed, treeOf } from './nm31-seed';
import { fwd, keptAfterStart, LATER, resetBack, stored, Variant } from './nm31-back';

const OLD = 'bota-fleet-postgres-data';
const set = () => fwd().stamp;
const keptDir = () => fwd().outDir;
const backupsKept = () => path.join(h.dir, 'backups', 'a', 'kept');
const archiveName = () => `${set()}.tar`;
const rejected = () => `${archiveName()}.rejected-${stampOf(LATER)}`;
const realSave = containerManager.saveKeptOpIf;
const realClose = containerManager.closeKeptOp;
const label = () => containerManager.getBot('a')!.displayName;
const inCheck = (p: string) => p.includes(`${set()}.check`);

let afterExtract: ((dir: string) => void) | null = null;
const tarFail: { cf?: string } = {};

/** tar as an in-process copy, as nm31-delete.test.ts fakes it. */
function tarFake(): void {
  let args: string[] = [];
  let n = 0;
  docker.overrides.push({
    match: a => {
      if (a[0] !== '-cf' && a[0] !== '-xf') return false;
      args = a;
      return true;
    },
    answer: () => {
      if (args[0] === '-cf') {
        if (tarFail.cf) { const e = tarFail.cf; delete tarFail.cf; return { ok: false, stderr: e }; }
        const [, file, , parent, base] = args;
        const snap = path.join(h.dir, 'snaps', String(++n));
        fs.cpSync(path.join(parent, base), path.join(snap, base), { recursive: true, verbatimSymlinks: true });
        fs.writeFileSync(file, snap);
        return { ok: true };
      }
      const [, file, , dir] = args;
      fs.cpSync(fs.readFileSync(file, 'utf-8'), dir, { recursive: true, verbatimSymlinks: true });
      afterExtract?.(dir);
      return { ok: true };
    },
  });
}

async function kept(variant: Variant): Promise<void> {
  await keptAfterStart(variant, { off: false });
  docker.calls.length = 0;
  run.execCalls.length = 0;
}

/** A folder set whose extracted archive `change` alters; the answer of its Delete. */
async function folderDelete(change: ((extracted: string) => void) | null, prepare?: (k: string) => void): Promise<unknown> {
  await kept('folder');
  prepare?.(keptDir());
  if (change) afterExtract = (dir) => change(path.join(dir, path.basename(keptDir())));
  return deleteKept('a', set());
}

function archCheckOpen(answer: unknown, difference: string): void {
  const error = KEPT_TEXT.xArchCheck(rejected(), difference, backupsKept());
  expect(answer).toEqual({ success: false, status: 409, open: true, error });
  expect(stored().keptOp).toMatchObject({ op: 'delete', set: set(), step: 'recorded', lastError: error });
  expect(fs.existsSync(keptDir())).toBe(true);
}

function closeThrowsOnce(): void {
  let done = false;
  vi.spyOn(containerManager, 'closeKeptOp').mockImplementation((id, key, close) => {
    if (!done) { done = true; throw new Error('the manager stopped here'); }
    return realClose(id, key, close);
  });
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-17T12:00:00.000Z'));
  resetDocker();
  resetRun();
  clearRegistry();
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.rmSync(path.join(h.dir, 'backups'), { recursive: true, force: true });
  fs.rmSync(path.join(h.dir, 'snaps'), { recursive: true, force: true });
  resetSeed();
  resetBack();
  run.holderToBase = true;
  h.remove.calls = [];
  Object.assign(h.fsh, { readdir: null, lstat: null, readlink: null, open: [], fsync: [], close: [], fsyncFail: null, events: [] });
  afterExtract = null;
  delete tarFail.cf;
  tarFake();
});
afterEach(() => {
  releaseFleetBackupBusy('a');
  vi.restoreAllMocks();
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('nm31 l5 ae: the kept folder guard', () => {
  it('a kept folder that is the data folder itself is refused with T-X-PATH, nothing changed', async () => {
    await kept('folder');
    vi.spyOn(fleetReplica, 'instanceDataDir').mockResolvedValue(keptDir());
    const before = treeOf(keptDir());
    const answer = await deleteKept('a', set());
    expect(answer).toEqual({ success: false, status: 409, error: KEPT_TEXT.xPath(keptDir()) });
    expect(treeOf(keptDir())).toEqual(before);
    expect(stored().keptOp).toBeUndefined();
    expect(docker.calls.some(a => a[0] === '-cf')).toBe(false);
  });
});

describe('nm31 l5 ae: the archive compare', () => {
  it('two paths missing from the archive: the first in name order is named, whatever order the folder lists', async () => {
    h.fsh.readdir = (p, names) => (path.resolve(p) === path.resolve(keptDir()) ? [...names].sort().reverse() : names);
    const answer = await folderDelete(d => { fs.rmSync(path.join(d, 'a.txt')); fs.rmSync(path.join(d, 'z.txt')); },
      k => { fs.writeFileSync(path.join(k, 'a.txt'), 'a'); fs.writeFileSync(path.join(k, 'z.txt'), 'z'); });
    archCheckOpen(answer, 'a.txt is missing from the archive');
  });

  it('a file missing inside a subfolder of the archive is found', async () => {
    const answer = await folderDelete(d => fs.rmSync(path.join(d, 'sub', 'deep.txt')),
      k => { fs.mkdirSync(path.join(k, 'sub')); fs.writeFileSync(path.join(k, 'sub', 'deep.txt'), 'x'); });
    archCheckOpen(answer, 'sub/deep.txt is missing from the archive');
  });

  it('a link in the folder that is a file in the archive names both kinds', async () => {
    h.fsh.lstat = p => (!inCheck(p) && path.basename(p) === 'state.json' ? 'link' : null);
    h.fsh.readlink = p => (path.basename(p) === 'state.json' ? 'target' : undefined);
    const answer = await folderDelete(null);
    archCheckOpen(answer, 'state.json is a link in the folder and a file in the archive');
  });

  it('a file in the folder that is another kind of entry in the archive names both kinds', async () => {
    h.fsh.lstat = p => (inCheck(p) && path.basename(p) === 'state.json' ? 'other' : null);
    const answer = await folderDelete(null);
    archCheckOpen(answer, 'state.json is a file in the folder and another kind of entry in the archive');
  });

  it('a link with the same target in the folder and the archive matches, and the Delete ends', async () => {
    h.fsh.lstat = p => (path.basename(p) === 'state.json' ? 'link' : null);
    h.fsh.readlink = p => (path.basename(p) === 'state.json' ? 'target' : undefined);
    const answer = await folderDelete(null);
    expect(answer).toMatchObject({ success: true });
    expect(stored().keptSets).toBeUndefined();
  });
});

describe('nm31 l5 ae: the archive is synced before it is named', () => {
  it('the temporary archive is opened, synced and closed before it is renamed', async () => {
    const answer = await folderDelete(null, () => {
      run.beforeRename = (from) => { if (from.endsWith('.tar.tmp')) h.fsh.events.push('rename'); };
    });
    expect(answer).toMatchObject({ success: true });
    const tmp = path.join(backupsKept(), `${archiveName()}.tmp`);
    const opened = h.fsh.open.filter(([p]) => path.resolve(p) === path.resolve(tmp));
    expect(opened.map(([, f]) => f)).toEqual(['r+']);
    const fd = opened[0][2];
    expect(h.fsh.fsync).toContain(fd);
    expect(h.fsh.close).toContain(fd);
    const ev = h.fsh.events;
    const opened2 = ev.lastIndexOf(`open ${fd}`, ev.indexOf('rename'));
    const synced = ev.indexOf(`fsync ${fd}`, opened2);
    const closed = ev.indexOf(`close ${fd}`, opened2);
    expect([opened2 >= 0, synced > opened2, closed > synced, ev.indexOf('rename') > closed]).toEqual([true, true, true, true]);
  });

  it('a sync that fails stops the Delete with T-X-ARCHIVE and no archive', async () => {
    await kept('folder');
    h.fsh.fsyncFail = 'EIO: i/o error, fsync';
    const answer = await deleteKept('a', set());
    const error = KEPT_TEXT.xArchive('EIO: i/o error, fsync');
    expect(answer).toEqual({ success: false, status: 409, open: true, error });
    expect(stored().keptOp).toMatchObject({ step: 'recorded', lastError: error });
    expect(fs.readdirSync(backupsKept())).toEqual([]);
  });
});

describe('nm31 l5 ae: the stops of a Delete', () => {
  it('a rejected archive logs the stop at the step the record went back to', async () => {
    const answer = await folderDelete(d => fs.rmSync(path.join(d, 'state.json')));
    archCheckOpen(answer, 'state.json is missing from the archive');
    const reason = KEPT_TEXT.xArchCheck(rejected(), 'state.json is missing from the archive', backupsKept());
    expect(console.warn).toHaveBeenCalledWith(`[KeptData] ${label()}: Delete stopped at step recorded: ${reason}`);
  });

  it('a stop whose record was closed elsewhere does not take the patch, and logs the step the run reached', async () => {
    const answer = await folderDelete(d => fs.rmSync(path.join(d, 'state.json')), () => {
      vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation((id, key, patch) =>
        (patch.lastError && patch.step === 'recorded' ? 'closed elsewhere' : realSave(id, key, patch)));
    });
    const reason = KEPT_TEXT.xArchCheck(rejected(), 'state.json is missing from the archive', backupsKept());
    expect(answer).toEqual({ success: false, status: 409, open: true, error: reason });
    expect(console.warn).toHaveBeenCalledWith(`[KeptData] ${label()}: Delete stopped at step archived: ${reason}`);
  });

  it('a stop that cannot be recorded logs that, and still answers open', async () => {
    vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation((id, key, patch) => {
      if (patch.lastError) throw new Error('EACCES: registry not writable');
      return realSave(id, key, patch);
    });
    await kept('folder');
    tarFail.cf = 'tar: write error';
    const answer = await deleteKept('a', set());
    expect(answer).toEqual({ success: false, status: 409, open: true, error: KEPT_TEXT.xArchive('tar: write error') });
    expect(console.error).toHaveBeenCalledWith(`[KeptData] ${label()}: the stop of Delete could not be recorded: EACCES: registry not writable`);
  });

  it('the end not recorded after the removal: T-X-OPEN without Keep it, status 500', async () => {
    const answer = await folderDelete(null, closeThrowsOnce);
    const rec = stored().keptOp;
    expect(rec.step).toBe('removing');
    const reason = 'the end could not be recorded (the manager stopped here); run it again';
    expect(answer).toEqual({ success: false, status: 500, open: true, error: KEPT_TEXT.xOpen(reason, deleteDone(rec), false) });
  });

  it('an open answer that ends with a period takes the dropped-volume note with no second period', async () => {
    await kept('main');
    run.volumes[OLD] = 'absent';
    closeThrowsOnce();
    const answer = await deleteKept('a', set());
    const rec = stored().keptOp;
    const sentence = KEPT_TEXT.xOpen('the end could not be recorded (the manager stopped here); run it again', deleteDone(rec), false);
    expect(sentence.endsWith('.')).toBe(true);
    expect(answer).toEqual({ success: false, status: 500, open: true, error: sentence + KEPT_TEXT.xDropped(OLD, keptDir()) });
  });

  it('the run\'s first save throws: status 500 and the reason, nothing archived', async () => {
    await kept('folder');
    let done = false;
    vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation((id, key, patch) => {
      if (!done && 'folderGone' in patch) { done = true; throw new Error('EIO: write failed'); }
      return realSave(id, key, patch);
    });
    const answer = await deleteKept('a', set());
    const rec = stored().keptOp;
    expect(rec.step).toBe('recorded');
    expect(answer).toEqual({ success: false, status: 500, open: true, error: KEPT_TEXT.xOpen('the record could not be saved (EIO: write failed)', deleteDone(rec), true) });
    expect(docker.calls.some(a => a[0] === '-cf')).toBe(false);
  });

  it('the run\'s first save finds the record closed: stopped with nothing more done', async () => {
    await kept('folder');
    vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation((id, key, patch) =>
      ('folderGone' in patch ? 'closed' : realSave(id, key, patch)));
    const answer = await deleteKept('a', set());
    expect(answer).toEqual({ success: false, status: 409, error: `Delete stopped: ${containerManager.KEPT_RECORD_CLOSED}; nothing more was done` });
    expect(docker.calls.some(a => a[0] === '-cf')).toBe(false);
    expect(fs.existsSync(keptDir())).toBe(true);
  });

  it('a step save throws: status 500 and the reason in T-X-OPEN', async () => {
    let done = false;
    vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation((id, key, patch) => {
      if (!done && patch.step === 'archived') { done = true; throw new Error('EIO: write failed'); }
      return realSave(id, key, patch);
    });
    await kept('folder');
    const answer = await deleteKept('a', set());
    const rec = stored().keptOp;
    expect(rec.step).toBe('recorded');
    expect(answer).toEqual({ success: false, status: 500, open: true, error: KEPT_TEXT.xOpen('the record could not be saved (EIO: write failed)', deleteDone(rec), true) });
  });
});
