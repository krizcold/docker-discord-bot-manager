import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-l5-o-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  const hooks = {
    lstatFail: null as null | ((p: string) => Error | null),
    reverseUnder: null as null | string,
    dirOpens: [] as string[],
    dirSyncs: [] as number[],
    dirCloses: [] as number[],
  };
  (globalThis as { __nm31o?: typeof hooks }).__nm31o = hooks;
  return { dir, hooks };
});

vi.mock('child_process', async (importOriginal) => (await import('./nm31-run')).childProcessMock(await importOriginal(), require('fs')));
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const base = (await import('./nm31-run')).fsMock(real) as Record<string, any>;
  const hk = (globalThis as { __nm31o?: any }).__nm31o;
  const FAKE = 900000;
  const lstatSync = (p: import('fs').PathLike, o?: unknown) => {
    const err = hk.lstatFail?.(String(p));
    if (err) throw err;
    return base.lstatSync(p, o);
  };
  const readdirSync = (p: import('fs').PathLike, o?: any) => {
    const out = real.readdirSync(p, o);
    return hk.reverseUnder && String(p).startsWith(hk.reverseUnder) ? [...out].reverse() : out;
  };
  const openSync = (p: import('fs').PathLike, flags?: any, mode?: any) => {
    if (flags === 'r' && real.existsSync(p) && real.statSync(p).isDirectory()) {
      hk.dirOpens.push(String(p));
      return FAKE + hk.dirOpens.length;
    }
    return real.openSync(p, flags, mode);
  };
  const fsyncSync = (fd: number) => (fd > FAKE ? void hk.dirSyncs.push(fd) : real.fsyncSync(fd));
  const closeSync = (fd: number) => (fd > FAKE ? void hk.dirCloses.push(fd) : real.closeSync(fd));
  const wrap = { lstatSync, readdirSync, openSync, fsyncSync, closeSync };
  return { ...base, ...wrap, default: { ...base.default, ...wrap } };
});
vi.mock('../../src/docker/dockerClient', async (importOriginal) => {
  const { run } = await import('./nm31-run');
  return {
    ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
    volumeState: (name: string) => run.volumes[name] ?? 'absent',
    listBotContainersAsync: async () => [],
  };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { KEPT_TEXT, newFolderState, newStartNames, startOnNewDatabase } from '../../src/instance/keptData';
import { resetDocker } from './nm2-docker';
import { clearRegistry } from './nm2-harness';
import { resetRun, run } from './nm31-run';
import { answerDatabase, dataDirOf, resetSeed, seedCopy, seedMain, stored, treeOf } from './nm31-seed';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const names = () => newStartNames({ sanitizedName: 'bota' }, dataDirOf('a'), NOW);
const realPlatform = process.platform;
const setPlatform = (p: string) => Object.defineProperty(process, 'platform', { value: p, configurable: true });

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  resetDocker();
  resetRun();
  clearRegistry();
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  resetSeed();
  Object.assign(h.hooks, { lstatFail: null, reverseUnder: null, dirOpens: [], dirSyncs: [], dirCloses: [] });
});
afterEach(() => {
  setPlatform(realPlatform);
  releaseFleetBackupBusy('a');
  vi.restoreAllMocks();
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

/** A main start stopped after N5: the data folder set aside, the new folder built at inDir, nothing at dataDir. */
async function stopAfterSetAside(): Promise<void> {
  await seedMain();
  answerDatabase();
  let done = false;
  run.beforeRename = (from) => {
    if (!done && from === names().inDir) {
      done = true;
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    }
  };
  expect(await startOnNewDatabase('a')).toMatchObject({ success: false, open: true });
  run.beforeRename = null;
  expect(fs.existsSync(dataDirOf('a'))).toBe(false);
  expect(newFolderState(names().inDir)).toBe('built');
}

describe('nm31 l5 o: the data folder a compose up left (folderData)', () => {
  it('folderData (1 of 3): an empty data folder is cleared and the new folder brought in', async () => {
    await stopAfterSetAside();
    fs.mkdirSync(dataDirOf('a'));
    const answer = await startOnNewDatabase('a');
    expect((answer as { error?: string }).error).toBeUndefined();
    expect(answer).toMatchObject({ success: true });
    expect(fs.existsSync(names().inDir)).toBe(false);
    expect(Object.keys(treeOf(dataDirOf('a')))).toEqual(['maintenance.json']);
  });

  it('folderData (2 of 3): a data folder holding a file is not ours and is left as it is', async () => {
    await stopAfterSetAside();
    fs.mkdirSync(dataDirOf('a'));
    fs.writeFileSync(path.join(dataDirOf('a'), 'stray.txt'), 'x');
    const answer = await startOnNewDatabase('a');
    expect(answer).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.lastError).toBe(KEPT_TEXT.nNotOurs(dataDirOf('a'), ['stray.txt']));
    expect(treeOf(dataDirOf('a'))).toEqual({ 'stray.txt': 'x' });
    expect(newFolderState(names().inDir)).toBe('built');
  });

  it('folderData (3 of 3): an lstat error other than ENOENT opens the record, nothing moved', async () => {
    await stopAfterSetAside();
    h.hooks.lstatFail = (p) => (p === dataDirOf('a') ? Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) : null);
    const answer = await startOnNewDatabase('a');
    expect(answer).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.lastError).toMatch(/^the data folders could not be read \(.*EACCES: permission denied.*\)$/);
    h.hooks.lstatFail = null;
    expect(fs.existsSync(dataDirOf('a'))).toBe(false);
    expect(newFolderState(names().inDir)).toBe('built');
  });
});

describe('nm31 l5 o: certificate names (certNames)', () => {
  it('certNames (1 of 2): only the *.crt files of db-certs are carried; another file stays in the kept folder', async () => {
    await seedCopy();
    answerDatabase();
    fs.writeFileSync(path.join(dataDirOf('a'), 'db-certs', 'notes.txt'), 'x');
    const before = treeOf(dataDirOf('a'));
    const answer = await startOnNewDatabase('a');
    expect((answer as { error?: string }).error).toBeUndefined();
    expect(answer).toMatchObject({ success: true });
    expect(treeOf(names().outDir)).toEqual(before);
    const now = treeOf(dataDirOf('a'));
    expect(now['db-certs/notes.txt']).toBeUndefined();
    expect(Object.keys(now).filter(k => k.startsWith('db-certs/')).sort()).toEqual(Object.keys(before).filter(k => k.endsWith('.crt')).sort());
  });

  it('certNames (2 of 2): the kept and new db-certs compare equal when the disk lists them in another order', async () => {
    await seedCopy();
    answerDatabase();
    h.hooks.reverseUnder = path.join(names().outDir, 'db-certs');
    const answer = await startOnNewDatabase('a');
    expect((answer as { error?: string }).error).toBeUndefined();
    expect(answer).toMatchObject({ success: true });
  });
});

describe('nm31 l5 o: folder syncs (fsyncDir)', () => {
  it('fsyncDir (1 of 2): on Linux the new folder and its parent are synced, every handle closed', async () => {
    await seedMain();
    answerDatabase();
    setPlatform('linux');
    const answer = await startOnNewDatabase('a');
    setPlatform(realPlatform);
    expect(answer).toMatchObject({ success: true });
    expect(h.hooks.dirOpens).toContain(names().inDir);
    expect(h.hooks.dirOpens).toContain(path.dirname(names().inDir));
    const fds = h.hooks.dirOpens.map((_, i) => 900001 + i);
    expect(h.hooks.dirSyncs).toEqual(fds);
    expect(h.hooks.dirCloses).toEqual(fds);
  });

  it('fsyncDir (2 of 2): on Windows no folder is opened', async () => {
    await seedMain();
    answerDatabase();
    setPlatform('win32');
    const answer = await startOnNewDatabase('a');
    setPlatform(realPlatform);
    expect(answer).toMatchObject({ success: true });
    expect(h.hooks.dirOpens).toEqual([]);
  });
});

describe('nm31 l5 o: newFolderState', () => {
  const saved = JSON.stringify({ state: 'maintenance', message: 'Back soon', since: '2026-11-17T10:00:00.000Z' }, null, 2);
  const mk = (name: string) => {
    const d = path.join(h.dir, 'nfs', name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };

  it('newFolderState (1 of 5): an lstat error other than ENOENT is foreign', () => {
    const d = mk('eacces');
    h.hooks.lstatFail = (p) => (p === d ? Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) : null);
    const got = newFolderState(d);
    h.hooks.lstatFail = null;
    expect(got).toBe('foreign');
  });

  it('newFolderState (2 of 5): a folder at the state file name is foreign', () => {
    const d = mk('state-dir');
    fs.mkdirSync(path.join(d, 'maintenance.json'));
    expect(newFolderState(d)).toBe('foreign');
  });

  it('newFolderState (3 of 5): a folder at the .tmp name is foreign', () => {
    const d = mk('tmp-dir');
    fs.writeFileSync(path.join(d, 'maintenance.json'), saved);
    fs.mkdirSync(path.join(d, 'maintenance.json.tmp'));
    expect(newFolderState(d)).toBe('foreign');
  });

  it('newFolderState (4 of 5): another folder holding only *.crt files is foreign', () => {
    const d = mk('other-dir');
    fs.writeFileSync(path.join(d, 'maintenance.json'), saved);
    fs.mkdirSync(path.join(d, 'certs'));
    fs.writeFileSync(path.join(d, 'certs', 'main.crt'), 'cert');
    expect(newFolderState(d)).toBe('foreign');
  });

  it('newFolderState (5 of 5): a file at db-certs is foreign', () => {
    const d = mk('certs-file');
    fs.writeFileSync(path.join(d, 'maintenance.json'), saved);
    fs.writeFileSync(path.join(d, 'db-certs'), 'x');
    expect(newFolderState(d)).toBe('foreign');
  });
});
