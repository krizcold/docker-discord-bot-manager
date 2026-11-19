import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-l5-ai-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    /** removeVolume: the names it was called with; `fail` answers false once; `throws` marks the volume gone and throws once. */
    remove: { calls: [] as string[], fail: false, throws: false },
    /** Every path fs.openSync was called with. */
    opens: [] as string[],
    /** Every execFile call with its options. */
    execOpts: [] as { cmd: string; args: string[]; opts?: { timeout?: number } }[],
  };
});

vi.mock('child_process', async (importOriginal) => {
  const base = await (await import('./nm31-run')).childProcessMock(await importOriginal(), require('fs')) as { execFile: (...a: unknown[]) => unknown; default: object };
  const execFile = (cmd: string, args: string[], ...rest: unknown[]) => {
    h.execOpts.push({ cmd, args, opts: typeof rest[0] === 'function' ? undefined : rest[0] as { timeout?: number } | undefined });
    return base.execFile(cmd, args, ...rest);
  };
  return { ...base, execFile, default: { ...base.default, execFile } };
});
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const base = (await import('./nm31-run')).fsMock(real) as { default: object };
  const openSync = ((p: import('fs').PathLike, ...r: unknown[]) => {
    h.opens.push(String(p));
    return (real.openSync as (...x: unknown[]) => number)(p, ...r);
  }) as typeof real.openSync;
  return { ...base, openSync, default: { ...base.default, openSync } };
});
vi.mock('../../src/docker/dockerClient', async (importOriginal) => {
  const { run } = await import('./nm31-run');
  return {
    ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
    volumeState: (name: string) => run.volumes[name] ?? 'absent',
    removeVolume: (name: string) => {
      h.remove.calls.push(name);
      if (h.remove.fail) {
        h.remove.fail = false;
        return false;
      }
      run.volumes[name] = 'absent';
      if (h.remove.throws) {
        h.remove.throws = false;
        throw new Error('the manager stopped here');
      }
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
import { claimFleetBackupBusy, releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { deleteDone, deleteKept, keepKept, KEPT_TEXT, keptDate, keptRunningOp, startOnNewDatabase } from '../../src/instance/keptData';
import { stampOf, validateDumpMeta } from '../../src/instance/backupFiles';
const SCRATCH_RM_ON_AGAIN = 0;
import { docker, resetDocker } from './nm2-docker';
import { holder } from './dump-fake';
import { clearRegistry, dumpsDir, registryPath, seedBot } from './nm2-harness';
import { resetRun, run } from './nm31-run';
import { app, COPY_VOLUME, dataDirOf, pageOpenLine, resetSeed, SMDB, treeOf } from './nm31-seed';
import { fwd, keptAfterStart, LATER, resetBack, stored, Variant } from './nm31-back';

const OLD = 'bota-fleet-postgres-data';
const S = 'smdb-keptcopy-a';
const CP = 'smdb-keptcopy-a-cp';
const CK = 'smdb-keptcheck-a';
const LABEL = 'smdb.testrestore=a';
const IMAGE = 'postgres:16-alpine';
const SIZE = 'du -sk /from && df -Pk /to';
const COPY = 'cp -a /from/. /to/';
const LATER_ISO = new Date(LATER).toISOString();
const set = () => fwd().stamp;
const keptDir = () => fwd().outDir;
const backupsKept = () => path.join(h.dir, 'backups', 'a', 'kept');
const archiveName = () => `${set()}.tar`;
const dumpName = (copy = false) => `${copy ? 'copy-' : ''}pre-delete-${stampOf(LATER)}.dump`;
const realSave = containerManager.saveKeptOpIf;
const realClose = containerManager.closeKeptOp;
const regText = () => fs.readFileSync(registryPath(), 'utf-8');

/** What the size read answers: the kept database's size and the scratch disk's free space, in KiB. */
const size = { kb: 1000, freeKb: 50 * 1024 * 1024 };

/** Runs after the fake tar extracts, with the extracted folder; a row changes the copy there. */
let afterExtract: ((dir: string) => void) | null = null;
/** One failure for the next tar of each mode. */
const tarFail: { cf?: string; xf?: string } = {};

/** tar as an in-process copy: -cf keeps a snapshot of the folder and names it in the archive; -xf copies the snapshot out. */
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
      if (tarFail.xf) { const e = tarFail.xf; delete tarFail.xf; return { ok: false, stderr: e }; }
      const [, file, , dir] = args;
      fs.cpSync(fs.readFileSync(file, 'utf-8'), dir, { recursive: true, verbatimSymlinks: true });
      afterExtract?.(dir);
      return { ok: true };
    },
  });
}

/** The size read, and the count read in the check throwaway answering the counts the holder printed. */
function containerReads(): void {
  docker.overrides.push({
    match: a => a[0] === 'run' && a.includes(SIZE),
    answer: () => ({ ok: true, stdout: `${size.kb}\t/from\nFilesystem 1024-blocks Used Available Capacity Mounted on\noverlay 100000000 10 ${size.freeKb} 1% /to\n` }),
  });
  docker.overrides.push({
    match: a => a[0] === 'exec' && a[1] === CK && a.includes('psql'),
    answer: () => ({ ok: true, stdout: Object.entries(holder.counts).map(([k, v]) => `count|${k}|${v}\n`).join('') }),
  });
}

/** The state-changing calls of a run, in order: removals, creations, runs and the two tars. */
const changes = () => docker.calls
  .filter(a => a[0] === 'rm' || (a[0] === 'volume' && (a[1] === 'rm' || a[1] === 'create')) || a[0] === 'run' || a[0] === '-cf' || a[0] === '-xf')
  .map(a => (a[0] === 'run' ? `run ${a[a.indexOf('--name') + 1]} ${a[a.length - 1]}` : a[0] === '-cf' || a[0] === '-xf' ? `tar ${a[0]}` : a.join(' ')));

const volumeChanges = (vol: string) => {
  void vol;
  return [
    `rm -f ${CP}`, `rm -f ${S}`, `volume rm ${S}`, `volume create --label ${LABEL} ${S}`,
    `run ${CP} ${SIZE}`, `run ${CP} ${COPY}`, `run ${S} ${IMAGE}`,
    `rm -f ${S}`, `volume rm ${S}`,
    `rm -f ${CK}`, `volume rm ${CK}`, `volume create --label ${LABEL} ${CK}`, `run ${CK} ${IMAGE}`,
    `rm -f ${CK}`, `volume rm ${CK}`,
  ];
};

function crashOnStep(step: string): void {
  let done = false;
  vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation((id, key, patch) => {
    if (!done && patch.step === step) {
      done = true;
      throw new Error('the manager stopped here');
    }
    return realSave(id, key, patch);
  });
}

/** A kept set as a forward run leaves it; the bot is left as the run left it (Running, stopped). */
async function kept(variant: Variant): Promise<void> {
  await keptAfterStart(variant, { off: false });
  docker.calls.length = 0;
  run.execCalls.length = 0;
}

type End = { volume?: string; copy?: boolean; folder?: boolean; dropped?: string };

/** The end state of a clean Delete: the set gone, the volume and folder removed, the dump and archive kept, the slot free. */
function expectDeleted(answer: unknown, end: End): void {
  const dump = end.volume ? dumpName(end.copy) : undefined;
  const text = KEPT_TEXT.xDone({
    date: keptDate(set()), ...(end.volume ? { volume: end.volume, dump } : {}), ...(end.folder ? { folder: keptDir(), archive: archiveName() } : {}),
  }) + (end.dropped ? ` The kept volume ${end.dropped} no longer existed (docker said no such volume), so only the folder was deleted.` : ''); // B9 (code review 2)
  expect(answer).toEqual({ success: true, text });
  const after = stored();
  expect(after.keptSets).toBeUndefined();
  expect(after.keptOp).toBeUndefined();
  expect(after.keptLast).toEqual({ op: 'delete', set: set(), outcome: 'done', text, at: LATER_ISO });
  if (end.folder) {
    expect(fs.existsSync(keptDir())).toBe(false);
    expect(fs.existsSync(path.join(backupsKept(), archiveName()))).toBe(true);
    expect(fs.readdirSync(backupsKept())).toEqual([archiveName()]);
  }
  expect(fs.existsSync(dataDirOf('a'))).toBe(true);
  if (end.volume) {
    expect(h.remove.calls.filter(v => v === end.volume).length).toBeGreaterThanOrEqual(1);
    expect(run.volumes[end.volume]).toBe('absent');
    expect(fs.existsSync(path.join(dumpsDir(), dump!))).toBe(true);
    expect(fs.existsSync(path.join(dumpsDir(), `${dump}.json`))).toBe(true);
  } else {
    expect(h.remove.calls).toEqual([]);
  }
  expect(keptRunningOp('a')).toBeNull();
  expect(containerManager.isBotBusy('a')).toBeNull();
  expect(claimFleetBackupBusy('a')).toBe(true);
  releaseFleetBackupBusy('a');
}

/** The open answer and record of a Delete stopped by a failure whose text the sheet gives as a whole sentence. */
function openWith(answer: unknown, error: string, step: string): void {
  expect(answer).toEqual({ success: false, status: expect.any(Number), open: true, error });
  expect(stored().keptOp).toMatchObject({ op: 'delete', set: set(), step, lastError: error });
}

/** The open answer of a Delete stopped for `reason`, in T-X-OPEN with the steps the stored record reached. */
function openedFor(answer: unknown, reason: string): void {
  const rec = stored().keptOp;
  expect(rec.lastError).toBe(reason);
  expect(answer).toEqual({ success: false, status: expect.any(Number), open: true, error: KEPT_TEXT.xOpen(reason, deleteDone(rec), rec.step !== 'removing') });
}

/** Nothing of the kept set was removed. */
function nothingRemoved(volume: string | null = OLD): void {
  expect(h.remove.calls).toEqual([]);
  if (volume) expect(run.volumes[volume]).toBe('exists');
  expect(fs.existsSync(keptDir())).toBe(true);
  expect(stored().keptSets.map((x: { id: string }) => x.id)).toEqual([set()]);
}

/** A Delete held at its dump until `release` is called. */
function holdDump(): { release: () => void; reached: () => boolean } {
  let release!: () => void;
  docker.dumpHold = new Promise<void>(r => { release = r; });
  return { release: () => release(), reached: () => docker.calls.some(a => a.includes('pg_dump')) };
}

async function until(test: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !test(); i++) await new Promise(r => setTimeout(r, 5));
  expect(test()).toBe(true);
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
  Object.assign(h.remove, { calls: [], fail: false, throws: false });
  Object.assign(size, { kb: 1000, freeKb: 50 * 1024 * 1024 });
  afterExtract = null;
  delete tarFail.cf;
  delete tarFail.xf;
  tarFake();
  containerReads();
});
afterEach(() => {
  releaseFleetBackupBusy('a');
  vi.restoreAllMocks();
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

const label = () => containerManager.getBot('a')!.displayName;
const warns = () => (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(c => String(c[0]));
const checkDir = () => path.join(backupsKept(), `${set()}.check`);

/** A Delete whose save of step "checked" fails: the record stays at scratch-gone with the dump named. */
async function stoppedAtScratchGone(): Promise<string> {
  crashOnStep('checked');
  expect(await deleteKept('a', set())).toMatchObject({ success: false, open: true });
  vi.mocked(containerManager.saveKeptOpIf).mockRestore();
  expect(stored().keptOp.step).toBe('scratch-gone');
  docker.calls.length = 0;
  return stored().keptOp.dump as string;
}

describe('nm31 l5 ai: runDelete X2 to X4', () => {
  it('X2: the dump fails and the scratch copy cannot be removed: the warning names it and the next Delete', async () => {
    await kept('main');
    holder.failQueue.push('FATAL:  the database system is starting up');
    let n = 0;
    docker.overrides.unshift({ match: a => a[0] === 'volume' && a[1] === 'rm' && a[2] === S && ++n === 2, answer: { ok: false, stderr: 'Error response from daemon: volume is in use' } });
    const answer = await deleteKept('a', set());
    expect(answer).toMatchObject({ success: false, open: true });
    expect(warns()).toContain(`[KeptData] ${label()}: the scratch copy ${S} could not be removed (Error response from daemon: volume is in use); the next Delete removes it first`);
  });

  it('X2: the dump fails and the scratch copy is removed: no warning about it', async () => {
    await kept('main');
    holder.failQueue.push('FATAL:  the database system is starting up');
    await deleteKept('a', set());
    expect(warns().filter(w => w.includes('could not be removed'))).toEqual([]);
  });

  it('X3: Run again from a saved scratch-gone step does not remove the scratch copy again', async () => {
    await kept('main');
    await stoppedAtScratchGone();
    const answer = await deleteKept('a', set(), { again: true });
    expectDeleted(answer, { volume: OLD, folder: true });
    expect(changes().filter(c => c === `volume rm ${S}`).length).toBe(SCRATCH_RM_ON_AGAIN);
  });

  it('X4: the counts file of the dump does not validate: T-X-CHECK with its reason', async () => {
    await kept('main');
    const dump = await stoppedAtScratchGone();
    fs.writeFileSync(path.join(dumpsDir(), `${dump}.json`), '{}');
    const v = validateDumpMeta({});
    expect(v.ok).toBe(false);
    const answer = await deleteKept('a', set(), { again: true });
    openWith(answer, KEPT_TEXT.xCheck(dump, `the counts recorded with the dump could not be read (${(v as { error: string }).error})`), 'scratch-gone');
  });

  it('X4: the counts file of the dump is not JSON: T-X-CHECK with the parse error', async () => {
    await kept('main');
    const dump = await stoppedAtScratchGone();
    fs.writeFileSync(path.join(dumpsDir(), `${dump}.json`), 'not json');
    let msg = '';
    try { JSON.parse('not json'); } catch (e) { msg = (e as Error).message; }
    const answer = await deleteKept('a', set(), { again: true });
    openWith(answer, KEPT_TEXT.xCheck(dump, `the check stopped on an error: ${msg}`), 'scratch-gone');
  });

  it('X4: the check throwaway cannot be removed: the warning names it', async () => {
    await kept('main');
    let n = 0;
    docker.overrides.unshift({ match: a => a[0] === 'volume' && a[1] === 'rm' && a[2] === CK && ++n === 2, answer: { ok: false, stderr: 'Error response from daemon: volume is in use' } });
    await deleteKept('a', set());
    expect(warns()).toContain(`[KeptData] ${label()}: the check throwaway ${CK} could not be removed (Error response from daemon: volume is in use); the next Delete removes it first`);
  });

  it('X4: a clean run warns of no throwaway left behind', async () => {
    await kept('main');
    expectDeleted(await deleteKept('a', set()), { volume: OLD, folder: true });
    expect(warns().filter(w => w.includes('could not be removed'))).toEqual([]);
  });

  it('the backup slot is free while the folder is archived and checked', async () => {
    await kept('main');
    const free: boolean[] = [];
    afterExtract = () => {
      const got = claimFleetBackupBusy('a');
      free.push(got);
      if (got) releaseFleetBackupBusy('a');
    };
    expectDeleted(await deleteKept('a', set()), { volume: OLD, folder: true });
    expect(free).toEqual([true]);
  });
});

describe('nm31 l5 ai: runDelete X5 and X6', () => {
  it('X5: the tar argv names the archive tmp and the folder through -C', async () => {
    await kept('folder');
    expectDeleted(await deleteKept('a', set()), { folder: true });
    const archive = path.join(backupsKept(), archiveName());
    expect(docker.calls.find(a => a[0] === '-cf')).toEqual(['-cf', `${archive}.tmp`, '-C', path.dirname(keptDir()), path.basename(keptDir())]);
    expect(docker.calls.find(a => a[0] === '-xf')).toEqual(['-xf', archive, '-C', checkDir()]);
  });

  it('X5: the archive tmp is synced before its rename, and the kept backups folder after it on Linux', async () => {
    await kept('folder');
    h.opens.length = 0;
    expectDeleted(await deleteKept('a', set()), { folder: true });
    expect(h.opens).toContain(path.join(backupsKept(), `${archiveName()}.tmp`));
    if (process.platform !== 'win32') expect(h.opens).toContain(backupsKept());
  });

  it('X5: the old archive tmp cannot be removed: T-X-ARCHIVE and no tar runs', async () => {
    await kept('folder');
    const tmp = path.join(backupsKept(), `${archiveName()}.tmp`);
    run.beforeRm = (target) => {
      if (target === tmp) { run.beforeRm = null; throw new Error('EPERM: operation not permitted'); }
    };
    const answer = await deleteKept('a', set());
    openWith(answer, KEPT_TEXT.xArchive('EPERM: operation not permitted'), 'recorded');
    expect(changes()).toEqual([]);
    expect(fs.existsSync(keptDir())).toBe(true);
  });

  it('X5: the archive cannot be renamed into place: T-X-ARCHIVE, the tmp removed', async () => {
    await kept('folder');
    const tmp = path.join(backupsKept(), `${archiveName()}.tmp`);
    run.beforeRename = (from) => {
      if (from === tmp) { run.beforeRename = null; throw new Error('EXDEV: cross-device link not permitted'); }
    };
    const answer = await deleteKept('a', set());
    openWith(answer, KEPT_TEXT.xArchive('EXDEV: cross-device link not permitted'), 'recorded');
    expect(fs.existsSync(tmp)).toBe(false);
    expect(fs.existsSync(path.join(backupsKept(), archiveName()))).toBe(false);
    expect(fs.existsSync(keptDir())).toBe(true);
  });

  it('X6: a check folder left with files by a stopped run is removed before the extract', async () => {
    await kept('folder');
    fs.mkdirSync(path.join(checkDir(), 'old'), { recursive: true });
    fs.writeFileSync(path.join(checkDir(), 'old', 'f.txt'), 'x');
    expectDeleted(await deleteKept('a', set()), { folder: true });
  });

  it('X6: the check folder is made owner-only (Linux)', async () => {
    await kept('folder');
    const modes: number[] = [];
    afterExtract = () => { modes.push(fs.statSync(checkDir()).mode & 0o777); };
    expectDeleted(await deleteKept('a', set()), { folder: true });
    if (process.platform !== 'win32') expect(modes).toEqual([0o700]);
  });

  it('X6: the check folder cannot be cleared: T-X-ARCHCHECK with "the folders could not be read"', async () => {
    await kept('folder');
    const check = checkDir();
    run.beforeRm = (target) => {
      if (target === check) { run.beforeRm = null; throw new Error('EACCES: permission denied'); }
    };
    const answer = await deleteKept('a', set());
    const rejected = `${archiveName()}.rejected-${stampOf(LATER)}`;
    openWith(answer, KEPT_TEXT.xArchCheck(rejected, 'the folders could not be read (EACCES: permission denied)', backupsKept()), 'recorded');
    expect(warns().filter(w => w.includes('could not be removed'))).toEqual([]);
  });

  it('X6: the check folder cannot be removed after the compare: warned, and the run ends', async () => {
    await kept('folder');
    const check = checkDir();
    let n = 0;
    run.beforeRm = (target) => {
      if (target === check && ++n === 2) throw new Error('EBUSY: resource busy or locked');
    };
    expect(await deleteKept('a', set())).toMatchObject({ success: true });
    expect(stored().keptSets).toBeUndefined();
    expect(fs.existsSync(check)).toBe(true);
    expect(warns()).toContain(`[KeptData] ${label()}: ${check} could not be removed (EBUSY: resource busy or locked)`);
  });

  it('X6: a clean run removes the extracted check folder with no warning', async () => {
    await kept('folder');
    expectDeleted(await deleteKept('a', set()), { folder: true });
    expect(fs.existsSync(checkDir())).toBe(false);
    expect(warns().filter(w => w.includes('could not be removed'))).toEqual([]);
  });
});

describe('nm31 l5 ai: verifier rows', () => {
  it('X6: Run again after the kept backups folder was removed makes it again, and the extract failure is the reason', async () => {
    await kept('folder');
    crashOnStep('archive-checked');
    expect(await deleteKept('a', set())).toMatchObject({ success: false, open: true });
    vi.mocked(containerManager.saveKeptOpIf).mockRestore();
    expect(stored().keptOp).toMatchObject({ step: 'archived', archive: archiveName() });
    fs.rmSync(backupsKept(), { recursive: true, force: true });
    tarFail.xf = 'tar: Cannot open: No such file or directory';
    await deleteKept('a', set(), { again: true });
    expect(stored().keptOp.lastError).toContain('the archive could not be extracted (');
    expect(fs.existsSync(backupsKept())).toBe(true);
  });

  it('the copy gets the hour timeout and both tars the half hour (design 429, 432)', async () => {
    await kept('main');
    h.execOpts.length = 0;
    expectDeleted(await deleteKept('a', set()), { volume: OLD, folder: true });
    const copy = h.execOpts.filter(c => c.args[c.args.length - 1] === COPY);
    expect(copy.length).toBe(1);
    expect(copy[0].opts?.timeout).toBe(3_600_000);
    const tars = h.execOpts.filter(c => c.args[0] === '-cf' || c.args[0] === '-xf');
    expect(tars.map(c => [c.args[0], c.opts?.timeout])).toEqual([['-cf', 1_800_000], ['-xf', 1_800_000]]);
  });
});
