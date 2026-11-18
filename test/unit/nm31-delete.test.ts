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

describe('nm31 delete: a clean run', () => {
  it('continue (1 of 3): a database and folder set: copied, dumped, checked, archived and checked, then removed', async () => {
    await kept('main');
    const answer = await deleteKept('a', set());
    expectDeleted(answer, { volume: OLD, folder: true });
    expect(changes()).toEqual([...volumeChanges(OLD), 'tar -cf', 'tar -xf']);
    expect(fs.existsSync(path.join(backupsKept(), `${set()}.check`))).toBe(false);
  });

  it('continue (2 of 3): a folder set: archived, checked and removed; no scratch copy and no dump', async () => {
    await kept('folder');
    const answer = await deleteKept('a', set());
    expectDeleted(answer, { folder: true });
    expect(changes()).toEqual(['tar -cf', 'tar -xf']);
    expect(fs.existsSync(dumpsDir()) ? fs.readdirSync(dumpsDir()) : []).toEqual([]);
  });

  it('continue (3 of 3): a live copy set: its volume dumped as a copy dump, then removed with the folder', async () => {
    await kept('copy');
    const answer = await deleteKept('a', set());
    expectDeleted(answer, { volume: COPY_VOLUME, copy: true, folder: true });
    expect(changes()).toEqual([...volumeChanges(COPY_VOLUME), 'tar -cf', 'tar -xf']);
    expect(holder.spawned[0]).toContain('smdb');
  });
});

/** A refusal: the answer, and nothing changed in the registry or the folders, and no state-changing docker call. */
async function refusedWith(error: string, status = 409, setId = set()): Promise<void> {
  const reg = regText();
  const folder = treeOf(keptDir());
  const answer = await deleteKept('a', setId);
  expect(answer).toEqual({ success: false, status, error });
  expect(regText()).toBe(reg);
  expect(treeOf(keptDir())).toEqual(folder);
  expect(changes()).toEqual([]);
  expect(h.remove.calls).toEqual([]);
  expect(keptRunningOp('a')).toBeNull();
  expect(claimFleetBackupBusy('a')).toBe(true);
  releaseFleetBackupBusy('a');
}

describe('nm31 delete: admission (X0)', () => {
  it('X0 (1 of 9): the kept volume is the one the bot uses now: T-X-CURRENT', async () => {
    await kept('main');
    const reg = JSON.parse(regText());
    reg.instances.a.fleetDb.volume = OLD;
    fs.writeFileSync(registryPath(), JSON.stringify(reg, null, 2));
    await refusedWith(KEPT_TEXT.xCurrent(OLD));
  });

  it('X0 (2 of 9): a container mounts the kept volume: T-X-INUSE', async () => {
    await kept('main');
    docker.overrides.unshift({ match: a => a[0] === 'ps' && a.includes(`volume=${OLD}`), answer: { ok: true, stdout: 'old-db\n' } });
    await refusedWith(KEPT_TEXT.xInUse(OLD, 'old-db'));
  });

  it('X0 (3 of 9): the kept folder is not beside the data folder: T-X-PATH', async () => {
    await kept('folder');
    const elsewhere = path.join(h.dir, 'elsewhere', 'data.kept-x');
    fs.mkdirSync(elsewhere, { recursive: true });
    const reg = JSON.parse(regText());
    reg.instances.a.keptSets[0].folder = elsewhere;
    fs.writeFileSync(registryPath(), JSON.stringify(reg, null, 2));
    await refusedWith(KEPT_TEXT.xPath(elsewhere));
    expect(fs.existsSync(elsewhere)).toBe(true);
  });

  it('X0 (4 of 9): the bot\'s own kept volume passes sharedVolumeReason and the kept-volume check (its own set left out)', async () => {
    await kept('main');
    expect(containerManager.keptVolumeReason(OLD, { botId: 'a' })).not.toBeNull();
    expect(containerManager.keptVolumeReason(OLD, { botId: 'a', exceptSet: set() })).toBeNull();
    const answer = await deleteKept('a', set());
    expectDeleted(answer, { volume: OLD, folder: true });
  });

  it('X0 (5 of 9): another instance\'s kept set names the volume: refused', async () => {
    await kept('main');
    seedBot({ sourceUrl: SMDB, displayName: 'Bot B', keptSets: [{ id: 'x', keptAt: LATER_ISO, by: 'new-start', folder: null, db: { containerName: 'botb-fleet-postgres', user: 'u', db: 'd', volume: OLD } }] }, 'b');
    await refusedWith(KEPT_TEXT.xShared(OLD, 'it is kept by Bot B\'s Kept data'));
  });

  it('X0 (6 of 9): docker does not say whether the kept volume exists: T-A-DOCKER', async () => {
    await kept('main');
    run.volumes[OLD] = 'unknown';
    await refusedWith(KEPT_TEXT.aDocker(OLD));
  });

  it('X0 (7 of 9): the kept volume no longer exists: its part is dropped and the folder alone is deleted, the answer says so', async () => {
    await kept('main');
    run.volumes[OLD] = 'absent';
    const answer = await deleteKept('a', set());
    expectDeleted(answer, { folder: true, dropped: OLD });
    expect(changes()).toEqual(['tar -cf', 'tar -xf']);
  });

  it('X0 (8 of 9): another record is open (a Start on a new database that stopped): A5', async () => {
    await keptAfterStart('main');
    docker.overrides.unshift({ match: a => a[0] === 'stop', answer: { ok: false, stderr: 'Error response from daemon: cannot stop' } });
    expect(await startOnNewDatabase('a')).toMatchObject({ success: false, open: true });
    docker.calls.length = 0;
    expect(stored().keptOp.op).toBe('new-start');
    await refusedWith(containerManager.keptOpOpenText(stored().keptOp));
  });

  it('X0 (9 of 9): the manager is shutting down: refused', async () => {
    await kept('main');
    const shutting = vi.spyOn(containerManager, 'isShuttingDown').mockReturnValue(true);
    const reg = regText();
    expect(await deleteKept('a', set())).toEqual({ success: false, status: 503, error: containerManager.SHUTDOWN_REFUSAL });
    shutting.mockRestore();
    expect(regText()).toBe(reg);
    expect(changes()).toEqual([]);
    expect(h.remove.calls).toEqual([]);
    expect(keptRunningOp('a')).toBeNull();
  });
});

describe('nm31 delete: a step fails, and nothing is removed', () => {
  it('X1 (1 of 2): the scratch disk has too little room: T-X-DISK, the scratch removed', async () => {
    await kept('main');
    size.freeKb = 500 * 1024;
    const answer = await deleteKept('a', set());
    openWith(answer, KEPT_TEXT.xDisk(500, 1025), 'recorded');
    nothingRemoved();
    expect(changes().slice(-3)).toEqual([`rm -f ${CP}`, `rm -f ${S}`, `volume rm ${S}`]);
    expect(claimFleetBackupBusy('a')).toBe(true);
  });

  it('X1 (2 of 2): the copy fails: T-X-DUMP with the copy\'s error, the scratch removed', async () => {
    await kept('main');
    docker.overrides.unshift({ match: a => a[0] === 'run' && a.includes(COPY), answer: { ok: false, stderr: 'cp: write error: No space left on device' } });
    const answer = await deleteKept('a', set());
    openWith(answer, KEPT_TEXT.xDump('the kept database could not be copied (cp: write error: No space left on device)'), 'recorded');
    nothingRemoved();
    expect(changes().slice(-3)).toEqual([`rm -f ${CP}`, `rm -f ${S}`, `volume rm ${S}`]);
  });

  it('X2 (1 of 3): the scratch copy does not start: T-X-DUMP, the scratch removed', async () => {
    await kept('main');
    docker.overrides.unshift({ match: a => a[0] === 'run' && a.includes('-d') && a.includes(S), answer: { ok: false, stderr: 'docker: Error response from daemon: Conflict.' } });
    const answer = await deleteKept('a', set());
    openWith(answer, KEPT_TEXT.xDump('the scratch copy did not start (docker: Error response from daemon: Conflict.)'), 'copy-made');
    nothingRemoved();
    expect(changes().slice(-2)).toEqual([`rm -f ${S}`, `volume rm ${S}`]);
  });

  it('X2 (2 of 3): the dump fails: T-X-DUMP with its error, no dump kept, the scratch removed', async () => {
    await kept('main');
    holder.failQueue.push('FATAL:  the database system is starting up');
    const answer = await deleteKept('a', set());
    const error = (answer as { error: string }).error;
    expect(error).toMatch(/^The dump of the kept database failed \(.*the database system is starting up.*\), so nothing was deleted\. Run Delete again, or Keep it\.$/);
    openWith(answer, error, 'copy-made');
    nothingRemoved();
    expect(fs.existsSync(dumpsDir()) ? fs.readdirSync(dumpsDir()).filter(f => f.includes('pre-delete')) : []).toEqual([]);
    expect(changes().slice(-2)).toEqual([`rm -f ${S}`, `volume rm ${S}`]);
  });

  it('X2 (3 of 3): the cluster has no dbm_work login: T-X-DUMP and T-X-NOWORK', async () => {
    await kept('main');
    holder.failQueue.push('psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  role "dbm_work" does not exist');
    const answer = await deleteKept('a', set());
    const error = (answer as { error: string }).error;
    expect(error.startsWith('The dump of the kept database failed (')).toBe(true);
    expect(error.endsWith(`, so nothing was deleted.${KEPT_TEXT.xNoWork(OLD)}`), 'B2 (NM34 code review 1): no Run Delete again before T-X-NOWORK').toBe(true);
    expect(error).not.toContain('Run Delete again');
    openWith(answer, error, 'copy-made');
    nothingRemoved();
  });

  it('X3: the scratch copy cannot be removed after the dump: open, the dump kept', async () => {
    await kept('main');
    let n = 0;
    docker.overrides.unshift({ match: a => a[0] === 'volume' && a[1] === 'rm' && a[2] === S && ++n === 2, answer: { ok: false, stderr: 'Error response from daemon: volume is in use' } });
    const answer = await deleteKept('a', set());
    openedFor(answer, `the scratch copy ${S} could not be removed (Error response from daemon: volume is in use)`);
    expect(stored().keptOp).toMatchObject({ step: 'dumped', dump: dumpName() });
    nothingRemoved();
    expect(fs.existsSync(path.join(dumpsDir(), dumpName()))).toBe(true);
  });

  it('X4: the dump does not restore cleanly: T-X-CHECK, the dump stays, the throwaway removed', async () => {
    await kept('main');
    docker.restore = { code: 1, stderr: 'pg_restore: error: could not read input file' };
    const answer = await deleteKept('a', set());
    const reason = 'pg_restore exited with code 1: pg_restore: error: could not read input file';
    openWith(answer, KEPT_TEXT.xCheck(dumpName(), reason), 'scratch-gone');
    nothingRemoved();
    expect(fs.existsSync(path.join(dumpsDir(), dumpName()))).toBe(true);
    expect(changes().slice(-2)).toEqual([`rm -f ${CK}`, `volume rm ${CK}`]);
  });

  it('X5: the folder cannot be archived: T-X-ARCHIVE, no archive file left', async () => {
    await kept('main');
    tarFail.cf = 'tar: write error: No space left on device';
    const answer = await deleteKept('a', set());
    openWith(answer, KEPT_TEXT.xArchive('tar: write error: No space left on device'), 'checked');
    nothingRemoved();
    expect(fs.readdirSync(backupsKept())).toEqual([]);
  });

  it('X6: the archive cannot be extracted: T-X-ARCHCHECK, the archive set aside as rejected and the record back before X5 (B2 code review 1)', async () => {
    await kept('main');
    tarFail.xf = 'tar: Unexpected EOF in archive';
    const answer = await deleteKept('a', set());
    const rejected = `${archiveName()}.rejected-${stampOf(LATER)}`;
    openWith(answer, KEPT_TEXT.xArchCheck(rejected, 'the archive could not be extracted (tar: Unexpected EOF in archive)', backupsKept()), 'checked');
    nothingRemoved();
    expect(fs.readdirSync(backupsKept())).toEqual([rejected]);
  });

  it('X8: docker does not remove the volume: T-X-PARTIAL, the folder stays', async () => {
    await kept('main');
    h.remove.fail = true;
    const answer = await deleteKept('a', set());
    openWith(answer, KEPT_TEXT.xPartial({ volume: OLD, err: 'docker did not remove it', dump: dumpName(), archive: archiveName() }), 'removing');
    expect(run.volumes[OLD]).toBe('exists');
    expect(fs.existsSync(keptDir())).toBe(true);
  });

  it('X9: the folder cannot be removed: T-X-PARTIAL, the set stays recorded', async () => {
    await kept('main');
    run.beforeRm = (target) => {
      if (target === keptDir()) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    };
    const answer = await deleteKept('a', set());
    openWith(answer, KEPT_TEXT.xPartial({ folder: keptDir(), err: 'EBUSY: resource busy or locked', dump: dumpName(), archive: archiveName() }), 'removing');
    expect(run.volumes[OLD]).toBe('absent');
    expect(fs.existsSync(keptDir())).toBe(true);
    expect(stored().keptSets.map((x: { id: string }) => x.id)).toEqual([set()]);
  });
});

describe('nm31 delete: a crash after each step, then Run again ends as a clean run', () => {
  const saves: Array<[string, string]> = [
    ['X1', 'copy-made'], ['X2', 'dumped'], ['X3', 'scratch-gone'], ['X4', 'checked'], ['X5', 'archived'], ['X6', 'archive-checked'], ['X7', 'removing'],
  ];
  for (const [cell, step] of saves) {
    it(`${cell}: the manager stops before step ${step} is saved; Run again goes on`, async () => {
      await kept('main');
      crashOnStep(step);
      const first = await deleteKept('a', set());
      expect(first).toMatchObject({ success: false, open: true });
      expect(h.remove.calls).toEqual([]);
      const again = await deleteKept('a', set(), { again: true });
      expectDeleted(again, { volume: OLD, folder: true });
    });
  }

  it('X8: the manager stops after the volume is removed; Run again counts it removed and goes on', async () => {
    await kept('main');
    h.remove.throws = true;
    const first = await deleteKept('a', set());
    expect(first).toMatchObject({ success: false });
    expect(stored().keptOp.step).toBe('removing');
    expect(run.volumes[OLD]).toBe('absent');
    const again = await deleteKept('a', set(), { again: true });
    expectDeleted(again, { volume: OLD, folder: true });
    expect(h.remove.calls).toEqual([OLD]);
  });

  it('X9: the manager stops after the folder is removed, before the close; Run again closes', async () => {
    await kept('main');
    let done = false;
    vi.spyOn(containerManager, 'closeKeptOp').mockImplementation((id, key, close) => {
      if (!done) {
        done = true;
        throw new Error('the manager stopped here');
      }
      return realClose(id, key, close);
    });
    const first = await deleteKept('a', set());
    expect(first).toMatchObject({ success: false, open: true });
    expect(fs.existsSync(keptDir())).toBe(false);
    const again = await deleteKept('a', set(), { again: true });
    expectDeleted(again, { volume: OLD, folder: true });
  });
});

/** A Delete record left open by a check that failed (X4), as Keep it and Run again find it. */
async function openAtCheck(): Promise<void> {
  await kept('main');
  docker.restore = { code: 1, stderr: 'pg_restore: error: bad' };
  expect(await deleteKept('a', set())).toMatchObject({ success: false, open: true });
  docker.restore = { code: 0 };
  docker.calls.length = 0;
}

describe('nm31 delete: Keep it, Run again and the bot during a Delete', () => {
  it('X11: Keep it before removing: the record closed, the scratch removed, the dump stays, the set kept', async () => {
    await openAtCheck();
    const answer = await keepKept('a');
    const text = KEPT_TEXT.xKept({ date: keptDate(set()), dump: dumpName() });
    expect(answer).toEqual({ success: true, text });
    expect(stored().keptOp).toBeUndefined();
    expect(stored().keptLast).toEqual({ op: 'abandoned', set: set(), outcome: 'done', text, at: LATER_ISO });
    nothingRemoved();
    expect(fs.existsSync(path.join(dumpsDir(), dumpName()))).toBe(true);
    expect(changes()).toEqual([`rm -f ${CP}`, `rm -f ${S}`, `volume rm ${S}`, `rm -f ${CK}`, `volume rm ${CK}`]);
    expect(keptRunningOp('a')).toBeNull();
  });

  it('X12: Keep it while a Delete runs in this process: T-X-RUNNING, and the Delete ends as a clean run', async () => {
    await kept('main');
    const hold = holdDump();
    const running = deleteKept('a', set());
    await until(hold.reached);
    expect(await keepKept('a')).toEqual({ success: false, status: 409, error: KEPT_TEXT.xRunning });
    expect(stored().keptOp.op).toBe('delete');
    hold.release();
    expectDeleted(await running, { volume: OLD, folder: true });
  });

  it('X13: Keep it once the removal began: T-X-NOABANDON, the record stays', async () => {
    await kept('main');
    h.remove.fail = true;
    await deleteKept('a', set());
    expect(stored().keptOp.step).toBe('removing');
    const reg = regText();
    docker.calls.length = 0;
    expect(await keepKept('a')).toEqual({ success: false, status: 409, error: KEPT_TEXT.xNoAbandon });
    expect(regText()).toBe(reg);
    expect(changes()).toEqual([]);
  });

  it('X14: after a restart the record stays, nothing runs, and Run again first removes the scratch left behind', async () => {
    await kept('main');
    crashOnStep('copy-made');
    await deleteKept('a', set());
    expect(stored().keptOp).toMatchObject({ op: 'delete', step: 'recorded' });
    expect(keptRunningOp('a')).toBeNull();
    expect(claimFleetBackupBusy('a')).toBe(true);
    releaseFleetBackupBusy('a');
    docker.calls.length = 0;
    const again = await deleteKept('a', set(), { again: true });
    expect(changes().slice(0, 3)).toEqual([`rm -f ${CP}`, `rm -f ${S}`, `volume rm ${S}`]);
    expectDeleted(again, { volume: OLD, folder: true });
  });

  it('X15: the bot keeps its controls during a Delete: no op lock is held, another lane runs, and a running bot does not stop it', async () => {
    await kept('main');
    app.a = true;
    const hold = holdDump();
    const running = deleteKept('a', set());
    await until(hold.reached);
    const busy = containerManager.isBotBusy('a');
    const lane = await containerManager.withExternalBotOp('a', 'stop', async () => 'ran');
    hold.release();
    expect(busy).toBeNull();
    expect(lane).toBe('ran');
    expectDeleted(await running, { volume: OLD, folder: true });
  });
});

describe('nm31 delete: the archive compare (X6) refuses each kind of mismatch, and the archive is set aside as rejected (B2 code review 1)', () => {
  async function mismatch(change: (extracted: string) => void, difference: (kept: string) => string, prepare?: (kept: string) => void): Promise<void> {
    await kept('folder');
    prepare?.(keptDir());
    afterExtract = (dir) => change(path.join(dir, path.basename(keptDir())));
    const answer = await deleteKept('a', set());
    const rejected = `${archiveName()}.rejected-${stampOf(LATER)}`;
    openWith(answer, KEPT_TEXT.xArchCheck(rejected, difference(keptDir()), backupsKept()), 'recorded');
    expect(fs.existsSync(keptDir())).toBe(true);
    expect(fs.readdirSync(backupsKept())).toEqual([rejected]);
    expect(stored().keptSets.map((x: { id: string }) => x.id)).toEqual([set()]);
  }

  it('compare (1 of 7): a file of the folder is missing from the archive', async () => {
    await mismatch(d => fs.rmSync(path.join(d, 'state.json')), () => 'state.json is missing from the archive');
  });

  it('compare (2 of 7): the archive holds a path the folder does not', async () => {
    await mismatch(d => fs.writeFileSync(path.join(d, 'extra.txt'), 'x'), () => 'extra.txt is in the archive but not in the folder');
  });

  it('compare (3 of 7): a path is a file in the folder and a folder in the archive', async () => {
    await mismatch(d => { fs.rmSync(path.join(d, 'state.json')); fs.mkdirSync(path.join(d, 'state.json')); }, () => 'state.json is a file in the folder and a folder in the archive');
  });

  it('compare (4 of 7): a file differs in size', async () => {
    await mismatch(d => fs.writeFileSync(path.join(d, 'state.json'), '{"a":1}'), () => 'state.json differs in size (2 bytes in the folder, 7 in the archive)');
  });

  it('compare (5 of 7): a file has the same size and other content', async () => {
    await mismatch(d => fs.writeFileSync(path.join(d, 'state.json'), '[]'), () => 'state.json differs in content');
  });

  it.skipIf(process.platform === 'win32')('compare (6 of 7): a link points elsewhere in the archive', async () => {
    await mismatch(
      d => { fs.rmSync(path.join(d, 'link')); fs.symlinkSync('other', path.join(d, 'link')); },
      () => 'link points to state.json in the folder and to other in the archive',
      k => fs.symlinkSync('state.json', path.join(k, 'link')),
    );
  });

  it.skipIf(process.platform === 'win32')('compare (7 of 7): an entry that is neither a file, a folder nor a link refuses', async () => {
    const { execFileSync } = await vi.importActual<typeof import('child_process')>('child_process');
    await mismatch(
      () => {},
      () => 'pipe is neither a file, a folder nor a link',
      k => execFileSync('mkfifo', [path.join(k, 'pipe')]),
    );
  });
});

describe('nm31 delete: the guards around the kept data', () => {
  it('the kept volume is only ever mounted read-only: every docker call naming it is the in-use read or the :ro copy mount', async () => {
    await kept('main');
    expectDeleted(await deleteKept('a', set()), { volume: OLD, folder: true });
    const naming = docker.calls.filter(a => a.some(x => x.includes(OLD)));
    expect(naming.length).toBeGreaterThanOrEqual(3);
    for (const a of naming) {
      if (a[0] === 'ps') {
        expect(a).toEqual(['ps', '-a', '--filter', `volume=${OLD}`, '--format', '{{.Names}}']);
        continue;
      }
      expect(a[0]).toBe('run');
      expect(a.filter(x => x.includes(OLD))).toEqual([`${OLD}:/from:ro`]);
    }
  });

  it('a compare-and-save after the record was closed elsewhere stops the run with nothing more done', async () => {
    await kept('main');
    const hold = holdDump();
    const running = deleteKept('a', set());
    await until(hold.reached);
    const reg = JSON.parse(regText());
    delete reg.instances.a.keptOp;
    fs.writeFileSync(registryPath(), JSON.stringify(reg, null, 2));
    hold.release();
    expect(await running).toEqual({ success: false, status: 409, error: `Delete stopped: ${containerManager.KEPT_RECORD_CLOSED}; nothing more was done` });
    nothingRemoved();
    expect(docker.calls.some(a => a[0] === '-cf')).toBe(false);
    expect(stored().keptOp).toBeUndefined();
  });

  it('the scratch, its copy helper and the check throwaway carry only the throwaway label', async () => {
    await kept('main');
    expectDeleted(await deleteKept('a', set()), { volume: OLD, folder: true });
    const made = docker.calls.filter(a => (a[0] === 'run' || (a[0] === 'volume' && a[1] === 'create')));
    expect(made.length).toBe(6);
    for (const a of made) {
      const labels = a.flatMap((x, i) => (a[i - 1] === '--label' ? [x] : []));
      expect(labels).toEqual([LABEL]);
      expect(a.join(' ')).not.toMatch(/bot-id|managed-by/);
    }
  });

  it('X1 removes a copy helper left behind before anything else', async () => {
    await kept('main');
    await deleteKept('a', set());
    const first = docker.calls.findIndex(a => a[0] === 'rm' || a[0] === 'volume' || a[0] === 'run');
    expect(docker.calls[first]).toEqual(['rm', '-f', CP]);
  });

  it('X11 removes a copy helper left behind before the scratch and the throwaway', async () => {
    await openAtCheck();
    await keepKept('a');
    expect(docker.calls.find(a => a[0] === 'rm' || a[0] === 'volume')).toEqual(['rm', '-f', CP]);
  });

  it('Keep it deletes the record before its first docker call', async () => {
    await openAtCheck();
    let atFirstCall: unknown = 'not reached';
    let seen = false;
    docker.overrides.unshift({
      match: a => {
        if (!seen && a[0] === 'rm') {
          seen = true;
          atFirstCall = stored().keptOp;
        }
        return false;
      },
      answer: { ok: true },
    });
    expect(await keepKept('a')).toMatchObject({ success: true });
    expect(seen).toBe(true);
    expect(atFirstCall).toBeUndefined();
  });

  it('X16 (1 of 2): Run again while a Delete runs: T-X-RUNNING, and the running Delete is unaffected', async () => {
    await kept('main');
    const hold = holdDump();
    const running = deleteKept('a', set());
    await until(hold.reached);
    expect(await deleteKept('a', set(), { again: true })).toEqual({ success: false, status: 409, error: KEPT_TEXT.xRunning });
    hold.release();
    expectDeleted(await running, { volume: OLD, folder: true });
  });

  it('X16 (2 of 2): Run again after Keep it finds no record: T-X-NOREC', async () => {
    await openAtCheck();
    expect(await keepKept('a')).toMatchObject({ success: true });
    const reg = regText();
    docker.calls.length = 0;
    expect(await deleteKept('a', set(), { again: true })).toEqual({ success: false, status: 409, error: KEPT_TEXT.xNoRec });
    expect(regText()).toBe(reg);
    expect(changes()).toEqual([]);
  });
});

describe('nm31 delete: code review 1, fix 1', () => {
  it('B2 (code review 1): a fresh Delete with a stale archive of the set rebuilds it, and the run ends', async () => {
    await kept('folder');
    const stale = path.join(h.dir, 'snaps', 'stale');
    fs.cpSync(keptDir(), path.join(stale, path.basename(keptDir())), { recursive: true });
    fs.writeFileSync(path.join(stale, path.basename(keptDir()), 'gone-since.txt'), 'x');
    fs.mkdirSync(backupsKept(), { recursive: true });
    fs.writeFileSync(path.join(backupsKept(), archiveName()), stale);
    const answer = await deleteKept('a', set());
    expectDeleted(answer, { folder: true });
    expect(changes()).toEqual(['tar -cf', 'tar -xf']);
  });

  it('B2 (code review 1): Run it again after T-X-ARCHCHECK sets the rejected archive aside, builds a new one and ends', async () => {
    await kept('folder');
    let once = true;
    afterExtract = (dir) => {
      if (!once) return;
      once = false;
      const snap = fs.readFileSync(path.join(backupsKept(), archiveName()), 'utf-8');
      fs.writeFileSync(path.join(snap, path.basename(keptDir()), 'extra.txt'), 'x');
      fs.writeFileSync(path.join(dir, path.basename(keptDir()), 'extra.txt'), 'x');
    };
    const first = await deleteKept('a', set());
    expect(first).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.archive).toBeUndefined();
    const rejected = `${archiveName()}.rejected-${stampOf(LATER)}`;
    expect(fs.readdirSync(backupsKept()).sort()).toEqual([rejected]);
    const answer = await deleteKept('a', set(), { again: true });
    expect(answer).toEqual({ success: true, text: KEPT_TEXT.xDone({ date: keptDate(set()), folder: keptDir(), archive: archiveName() }) });
    expect(stored().keptSets).toBeUndefined();
    expect(fs.existsSync(keptDir())).toBe(false);
    expect(fs.readdirSync(backupsKept()).sort()).toEqual([archiveName(), rejected].sort());
  });

  it('B5 (a) (code review 1): a missing volume whose Delete record cannot be saved keeps its part in the set', async () => {
    await kept('main');
    run.volumes[OLD] = 'absent';
    const reg = regText();
    vi.spyOn(containerManager, 'createKeptOpIf').mockImplementation(() => { throw new Error('ENOSPC: no space left on device'); });
    const answer = await deleteKept('a', set());
    expect(answer).toEqual({ success: false, status: 500, error: 'Delete was not recorded, so nothing was changed: ENOSPC: no space left on device' });
    expect(regText()).toBe(reg);
    expect(stored().keptSets[0].db.volume).toBe(OLD);
  });

  it('B5 (b) (code review 1): a set with a missing volume and no folder is removed, and the answer says nothing was deleted', async () => {
    await kept('main');
    run.volumes[OLD] = 'absent';
    const reg = JSON.parse(regText());
    reg.instances.a.keptSets[0].folder = null;
    fs.writeFileSync(registryPath(), JSON.stringify(reg, null, 2));
    const answer = await deleteKept('a', set());
    expect(answer).toEqual({
      success: true,
      text: `The kept volume ${OLD} no longer exists (docker says no such volume), and the set named nothing else, so it was removed from Kept data; nothing was deleted.`,
    });
    expect(stored().keptSets).toBeUndefined();
    expect(stored().keptOp).toBeUndefined();
    expect(h.remove.calls).toEqual([]);
    expect(fs.existsSync(keptDir())).toBe(true);
  });

  it('B5 (c) (code review 1): a missing volume\'s note is in the open answer of a run that stops, and in the done answer of Run it again', async () => {
    await kept('main');
    run.volumes[OLD] = 'absent';
    tarFail.cf = 'tar: write error: No space left on device';
    const note = KEPT_TEXT.xDropped(OLD, keptDir());
    const answer = await deleteKept('a', set());
    expect(answer).toEqual({ success: false, status: 409, open: true, error: `${KEPT_TEXT.xArchive('tar: write error: No space left on device')}.${note}` }); // B9 and C8 (code review 2): the sentence ends before the note
    const again = await deleteKept('a', set(), { again: true });
    expectDeleted(again, { folder: true, dropped: OLD });
  });
});

describe('nm31 delete: code review 1, fix 2', () => {
  const STAY = () => `; nothing was deleted, and the dump ${dumpName()} and the archive ${archiveName()} stay in the backups folder`;

  it('B6 (code review 1): docker silent about the kept volume at X7: the answer names the dump and archive that stay, not "nothing was changed"', async () => {
    await kept('main');
    afterExtract = () => { run.volumes[OLD] = 'unknown'; };
    const answer = await deleteKept('a', set());
    openWith(answer, `Docker did not say whether the volume ${OLD} exists${STAY()}; try again`, 'archive-checked');
    expect(fs.existsSync(path.join(dumpsDir(), dumpName()))).toBe(true);
    expect(fs.readdirSync(backupsKept())).toEqual([archiveName()]);
  });

  it('B6 (code review 1): the data folder unreadable at X7: the answer names the dump and archive that stay, not "nothing was changed"', async () => {
    await kept('main');
    afterExtract = () => { vi.spyOn(fleetReplica, 'instanceDataDir').mockRejectedValue(new Error('EACCES: permission denied')); };
    const answer = await deleteKept('a', set());
    openWith(answer, `The bot's data folder ${dataDirOf('a')} could not be read (EACCES: permission denied)${STAY()}`, 'archive-checked');
  });

  it('B2 (code review 1, follow-up): Keep it after a rejected archive names the rejected file that stays, beside the dump', async () => {
    await kept('main');
    tarFail.xf = 'tar: Unexpected EOF in archive';
    expect(await deleteKept('a', set())).toMatchObject({ success: false, open: true });
    const rejected = `${archiveName()}.rejected-${stampOf(LATER)}`;
    expect(fs.readdirSync(backupsKept())).toEqual([rejected]);
    const answer = await keepKept('a');
    expect(answer).toEqual({ success: true, text: `Kept: the kept data of ${keptDate(set())} was not deleted. The dump ${dumpName()} and the rejected archive ${rejected} made so far stay in the backups folder.` });
    expect(fs.readdirSync(backupsKept())).toEqual([rejected]);
  });
});

describe('nm31 delete: code review 2', () => {
  it('B9 and C8 (code review 2): an open answer that is a whole sentence ending "; try again" gets its period before the dropped-volume note', async () => {
    await kept('main');
    run.volumes[OLD] = 'absent';
    afterExtract = () => { vi.spyOn(fleetReplica, 'instanceDataDir').mockRejectedValue(new Error('EACCES: permission denied')); };
    const answer = await deleteKept('a', set());
    const note = KEPT_TEXT.xDropped(OLD, keptDir());
    expect(answer).toMatchObject({ success: false, open: true });
    const error = (answer as { error: string }).error;
    expect(error.endsWith(note)).toBe(true);
    const sentence = error.slice(0, -note.length);
    expect(sentence).toMatch(/^The bot's data folder .* could not be read \(EACCES: permission denied\)/);
    expect(sentence.endsWith('.')).toBe(true);
  });
});

describe('nm31 delete: code review 6', () => {
  it('B11 Delete (code review 6): a Delete stopped with T-X-CHECK, then Run it again: while X4 runs the record has no reason', async () => {
    await openAtCheck();
    expect(stored().keptOp.lastError).toMatch(/^The dump /);
    const seen: Array<Record<string, unknown>> = [];
    docker.overrides.unshift({
      match: a => {
        if (a[0] === 'run' && a[a.indexOf('--name') + 1] === CK) seen.push({ ...stored().keptOp });
        return false;
      },
      answer: { ok: true },
    });
    const again = await deleteKept('a', set(), { again: true });
    expect(seen, JSON.stringify(again)).toHaveLength(1);
    expect(seen[0].lastError).toBeUndefined();
    expect(pageOpenLine(seen[0]).startsWith('Delete has not finished: it runs now, or the manager restarted while it ran.')).toBe(true);
    expectDeleted(again, { volume: OLD, folder: true });
  });

  it('C19 (code review 6): a removal that throws answers the 500 text and saves the reason the page line names', async () => {
    await kept('main');
    h.remove.throws = true;
    expect(await deleteKept('a', set())).toEqual({ success: false, status: 500, error: 'Delete stopped on an unexpected error: the manager stopped here' });
    const rec = stored().keptOp;
    expect(rec.step).toBe('removing');
    expect(rec.lastError).toBe('an unexpected error (the manager stopped here)');
    const line = pageOpenLine(rec);
    expect(line.startsWith('Delete stopped before it finished: an unexpected error (the manager stopped here). Done so far: ')).toBe(true);
    expect(line.endsWith(' Run it again to go on.')).toBe(true);
    expect(keptRunningOp('a')).toBeNull();
  });
});
