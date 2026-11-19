import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-delete-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    /** removeVolume: the names it was called with; `fail` answers false once; `throws` marks the volume gone and throws once. */
    remove: { calls: [] as string[], fail: false, throws: false },
  };
});

vi.mock('child_process', async (importOriginal) => (await import('./nm31-run')).childProcessMock(await importOriginal(), require('fs')));
vi.mock('fs', async (importOriginal) => (await import('./nm31-run')).fsMock(await importOriginal()));
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
import { stampOf } from '../../src/instance/backupFiles';
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

type Inst = NonNullable<ReturnType<typeof containerManager.getBot>>;

/** From the moment the Delete record is opened, getBot answers `change` of the stored bot (the registry changed under the run). */
function afterRecord(change: (inst: Inst) => Inst | null): void {
  let opened = false;
  const realCreate = containerManager.createKeptOpIf;
  const realGet = containerManager.getBot;
  vi.spyOn(containerManager, 'createKeptOpIf').mockImplementation((...a: Parameters<typeof realCreate>) => {
    const r = realCreate(...a);
    opened = true;
    return r;
  });
  vi.spyOn(containerManager, 'getBot').mockImplementation((id: string) => {
    const b = realGet(id);
    return opened && b ? change(structuredClone(b)) : b;
  });
}

const withSet = (inst: Inst, f: (s: NonNullable<Inst['keptSets']>[number]) => void): Inst => {
  f(inst.keptSets!.find(x => x.id === set())!);
  return inst;
};

describe('nm31 l5 ah: runDelete reads the bot and the set again', () => {
  it('the bot is gone once the record is open: 404 Bot not found', async () => {
    await kept('main');
    afterRecord(() => null);
    expect(await deleteKept('a', set())).toEqual({ success: false, status: 404, error: 'Bot not found' });
  });

  it('the set is no longer recorded: the record stays open with that reason', async () => {
    await kept('main');
    afterRecord(inst => ({ ...inst, keptSets: [] }));
    const answer = await deleteKept('a', set());
    openedFor(answer, `the kept data ${set()} is no longer recorded`);
    expect(h.remove.calls).toEqual([]);
  });

  it('a database set no longer names its database: the record stays open, nothing copied', async () => {
    await kept('main');
    afterRecord(inst => withSet(inst, s => { delete s.db; }));
    const answer = await deleteKept('a', set());
    openedFor(answer, `the kept data ${set()} no longer names its database volume`);
    expect(changes()).toEqual([]);
  });

  it('a live copy set no longer names its live copy: the record stays open, nothing copied', async () => {
    await kept('copy');
    afterRecord(inst => withSet(inst, s => { delete s.copy; }));
    const answer = await deleteKept('a', set());
    openedFor(answer, `the kept data ${set()} no longer names its live copy volume`);
    expect(changes()).toEqual([]);
  });

  it('a set no longer names its folder: the record stays open, nothing copied', async () => {
    await kept('main');
    afterRecord(inst => withSet(inst, s => { s.folder = null; }));
    const answer = await deleteKept('a', set());
    openedFor(answer, `the kept data ${set()} no longer names its folder`);
    expect(changes()).toEqual([]);
  });

  it('another set listed first is not the one deleted', async () => {
    await kept('main');
    afterRecord(inst => ({ ...inst, keptSets: [{ id: 'other', keptAt: LATER_ISO, by: 'new-start', folder: null }, ...inst.keptSets!] }));
    const answer = await deleteKept('a', set());
    expect(answer).toMatchObject({ success: true });
    expect(changes()).toEqual([...volumeChanges(OLD), 'tar -cf', 'tar -xf']);
  });
});

const copyRuns = () => changes().filter(c => c === `run ${CP} ${SIZE}` || c === `run ${S} ${IMAGE}`);

describe('nm31 l5 ah: Run again uses the dump on disk, or makes it again', () => {
  it('stopped at dumped with the dump and its counts on disk: no second copy or dump', async () => {
    await kept('main');
    crashOnStep('scratch-gone');
    expect(await deleteKept('a', set())).toMatchObject({ success: false, open: true });
    expect(stored().keptOp).toMatchObject({ step: 'dumped', dump: dumpName() });
    docker.calls.length = 0;
    const again = await deleteKept('a', set(), { again: true });
    expectDeleted(again, { volume: OLD, folder: true });
    expect(copyRuns()).toEqual([]);
  });

  it('stopped at dumped with the counts file gone: the copy and dump are made again', async () => {
    await kept('main');
    crashOnStep('scratch-gone');
    await deleteKept('a', set());
    fs.rmSync(path.join(dumpsDir(), `${dumpName()}.json`));
    docker.calls.length = 0;
    const again = await deleteKept('a', set(), { again: true });
    expectDeleted(again, { volume: OLD, folder: true });
    expect(copyRuns()).toEqual([`run ${CP} ${SIZE}`, `run ${S} ${IMAGE}`]);
  });

  it('stopped at copy-made with an earlier dump on disk: the copy and dump are made again', async () => {
    await kept('main');
    crashOnStep('scratch-gone');
    await deleteKept('a', set());
    fs.rmSync(path.join(dumpsDir(), `${dumpName()}.json`));
    vi.mocked(containerManager.saveKeptOpIf).mockRestore();
    crashOnStep('dumped');
    await deleteKept('a', set(), { again: true });
    expect(stored().keptOp).toMatchObject({ step: 'copy-made', dump: dumpName() });
    expect(fs.existsSync(path.join(dumpsDir(), `${dumpName()}.json`))).toBe(true);
    docker.calls.length = 0;
    const again = await deleteKept('a', set(), { again: true });
    expectDeleted(again, { volume: OLD, folder: true });
    expect(copyRuns()).toEqual([`run ${CP} ${SIZE}`, `run ${S} ${IMAGE}`]);
  });
});

const COPY_FAILS = { match: (a: string[]) => a[0] === 'run' && a.includes(COPY), answer: { ok: false, stderr: 'cp: write error: No space left on device' } };
const leftLines = () => vi.mocked(console.warn).mock.calls.map(c => String(c[0])).filter(l => l.includes('could not be removed'));

describe('nm31 l5 ah: the scratch copy left behind after X1 and X2 fail', () => {
  it('X1 fails and the scratch volume cannot be removed: the warning names it and the reason', async () => {
    await kept('main');
    docker.overrides.unshift(COPY_FAILS);
    docker.overrides.unshift({
      match: (a: string[]) => a[0] === 'volume' && a[1] === 'rm' && a[2] === S && docker.calls.some(c => c.includes(COPY)),
      answer: { ok: false, stderr: 'Error response from daemon: remove smdb-keptcopy-a: volume is in use' },
    });
    await deleteKept('a', set());
    expect(leftLines()).toEqual([`[KeptData] ${stored().displayName}: the scratch copy ${S} could not be removed (Error response from daemon: remove smdb-keptcopy-a: volume is in use); the next Delete removes it first`]);
  });

  it('X1 fails and the scratch is removed: no warning', async () => {
    await kept('main');
    docker.overrides.unshift(COPY_FAILS);
    await deleteKept('a', set());
    expect(leftLines()).toEqual([]);
  });

  it('X2 fails: only the scratch copy and its volume are removed, not the copy helper', async () => {
    await kept('main');
    docker.overrides.unshift({ match: (a: string[]) => a[0] === 'run' && a.includes('-d') && a.includes(S), answer: { ok: false, stderr: 'docker: Error response from daemon: Conflict.' } });
    await deleteKept('a', set());
    const all = changes();
    expect(all.slice(all.indexOf(`run ${S} ${IMAGE}`) + 1)).toEqual([`rm -f ${S}`, `volume rm ${S}`]);
  });
});
