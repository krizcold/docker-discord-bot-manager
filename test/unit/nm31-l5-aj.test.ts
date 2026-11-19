import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-l5-aj-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    /** removeVolume: the names it was called with; `throws` marks the volume gone and throws once; `listed` answers true and leaves it listed. */
    remove: { calls: [] as string[], throws: false, listed: false },
    /** rmSync of this path answers as done and leaves the folder in place. */
    rmKeeps: null as string | null,
  };
});

vi.mock('child_process', async (importOriginal) => (await import('./nm31-run')).childProcessMock(await importOriginal(), require('fs')));
vi.mock('fs', async (importOriginal) => {
  const m = (await import('./nm31-run')).fsMock(await importOriginal()) as Record<string, any>;
  const rm = m.rmSync;
  const rmSync = (target: unknown, opts?: unknown) => {
    if (h.rmKeeps && String(target) === h.rmKeeps) return;
    rm(target, opts);
  };
  return { ...m, rmSync, default: { ...m.default, rmSync } };
});
vi.mock('../../src/docker/dockerClient', async (importOriginal) => {
  const { run } = await import('./nm31-run');
  return {
    ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
    volumeState: (name: string) => run.volumes[name] ?? 'absent',
    removeVolume: (name: string) => {
      h.remove.calls.push(name);
      if (h.remove.listed) return true;
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
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { deleteDone, deleteKept, KEPT_TEXT, keptDate } from '../../src/instance/keptData';
import { stampOf } from '../../src/instance/backupFiles';
import { docker, resetDocker } from './nm2-docker';
import { holder } from './dump-fake';
import { clearRegistry, registryPath } from './nm2-harness';
import { resetRun, run } from './nm31-run';
import { resetSeed } from './nm31-seed';
import { fakeJoinRecord } from './join-fake';
import { fwd, keptAfterStart, LATER, resetBack, stored, Variant } from './nm31-back';

const OLD = 'bota-fleet-postgres-data';
const CK = 'smdb-keptcheck-a';
const SIZE = 'du -sk /from && df -Pk /to';
const set = () => fwd().stamp;
const keptDir = () => fwd().outDir;
const backupsKept = () => path.join(h.dir, 'backups', 'a', 'kept');
const archiveName = () => `${set()}.tar`;
const dumpName = () => `pre-delete-${stampOf(LATER)}.dump`;
const realSave = containerManager.saveKeptOpIf;
const realClose = containerManager.closeKeptOp;
const realGet = containerManager.getBot;
const regText = () => fs.readFileSync(registryPath(), 'utf-8');
const label = () => realGet('a')!.displayName;
const editReg = (change: (a: any) => void) => {
  const reg = JSON.parse(regText());
  change(reg.instances.a);
  fs.writeFileSync(registryPath(), JSON.stringify(reg, null, 2));
};

let afterExtract: ((dir: string) => void) | null = null;
let tarXfFail: string | null = null;

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
        const [, file, , parent, base] = args;
        const snap = path.join(h.dir, 'snaps', String(++n));
        fs.cpSync(path.join(parent, base), path.join(snap, base), { recursive: true, verbatimSymlinks: true });
        fs.writeFileSync(file, snap);
        return { ok: true };
      }
      if (tarXfFail) { const e = tarXfFail; tarXfFail = null; return { ok: false, stderr: e }; }
      const [, file, , dir] = args;
      fs.cpSync(fs.readFileSync(file, 'utf-8'), dir, { recursive: true, verbatimSymlinks: true });
      afterExtract?.(dir);
      return { ok: true };
    },
  });
}

function containerReads(): void {
  docker.overrides.push({
    match: a => a[0] === 'run' && a.includes(SIZE),
    answer: () => ({ ok: true, stdout: `1000\t/from\nFilesystem 1024-blocks Used Available Capacity Mounted on\noverlay 100000000 10 ${50 * 1024 * 1024} 1% /to\n` }),
  });
  docker.overrides.push({
    match: a => a[0] === 'exec' && a[1] === CK && a.includes('psql'),
    answer: () => ({ ok: true, stdout: Object.entries(holder.counts).map(([k, v]) => `count|${k}|${v}\n`).join('') }),
  });
}

async function kept(variant: Variant): Promise<void> {
  await keptAfterStart(variant, { off: false });
  docker.calls.length = 0;
  run.execCalls.length = 0;
}

const doneText = (o: { volume?: boolean; folder?: boolean } = { volume: true, folder: true }) => KEPT_TEXT.xDone({
  date: keptDate(set()),
  ...(o.volume ? { volume: OLD, dump: dumpName() } : {}),
  ...(o.folder ? { folder: keptDir(), archive: archiveName() } : {}),
});

function openWith(answer: unknown, error: string, step: string, status = 409): void {
  expect(answer).toEqual({ success: false, status, open: true, error });
  expect(stored().keptOp).toMatchObject({ op: 'delete', set: set(), step, lastError: error });
}

const psOld = (calls: string[][]) => calls.filter(a => a[0] === 'ps' && a.includes(`volume=${OLD}`)).length;

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
  Object.assign(h.remove, { calls: [], throws: false, listed: false });
  h.rmKeeps = null;
  afterExtract = null;
  tarXfFail = null;
  tarFake();
  containerReads();
});
afterEach(() => {
  releaseFleetBackupBusy('a');
  vi.restoreAllMocks();
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('nm31 l5 aj: X6 sets a rejected archive aside', () => {
  it('the rejected archive cannot be renamed: the answer names the archive itself and the log says the next run builds over it', async () => {
    await kept('folder');
    tarXfFail = 'tar: Unexpected EOF in archive';
    run.beforeRename = (_from, to) => {
      if (to.includes('.rejected-')) throw new Error('EACCES: permission denied');
    };
    const answer = await deleteKept('a', set());
    openWith(answer, KEPT_TEXT.xArchCheck(archiveName(), 'the archive could not be extracted (tar: Unexpected EOF in archive)', backupsKept()), 'recorded');
    expect(console.warn).toHaveBeenCalledWith(`[KeptData] ${label()}: the rejected archive ${path.join(backupsKept(), archiveName())} could not be set aside (EACCES: permission denied); the next run builds over it`);
    expect(fs.existsSync(keptDir())).toBe(true);
  });
});

describe('nm31 l5 aj: X7 checks the guards again', () => {
  it('the bot is gone from the registry at X7: Bot not found, nothing removed', async () => {
    await kept('main');
    let gone = false;
    vi.spyOn(containerManager, 'getBot').mockImplementation(id => (gone ? null : realGet(id)));
    afterExtract = () => { gone = true; };
    const answer = await deleteKept('a', set());
    expect(answer).toEqual({ success: false, status: 404, error: 'Bot not found' });
    expect(h.remove.calls).toEqual([]);
    expect(fs.existsSync(keptDir())).toBe(true);
  });

  it('the kept volume is gone at X7: no in-use read for it, no removal, and the run ends', async () => {
    await kept('main');
    let mark = -1;
    afterExtract = () => { run.volumes[OLD] = 'absent'; mark = docker.calls.length; };
    const answer = await deleteKept('a', set());
    expect(answer).toEqual({ success: true, text: doneText() });
    expect(mark).toBeGreaterThan(0);
    expect(psOld(docker.calls.slice(mark))).toBe(0);
    expect(h.remove.calls).toEqual([]);
  });

  it('a container mounts the kept volume at X7: T-X-INUSE is the whole answer, nothing removed', async () => {
    await kept('main');
    let mark = -1;
    afterExtract = () => {
      mark = docker.calls.length;
      docker.overrides.unshift({ match: a => a[0] === 'ps' && a.includes(`volume=${OLD}`), answer: { ok: true, stdout: 'old-db\n' } });
    };
    const answer = await deleteKept('a', set());
    openWith(answer, KEPT_TEXT.xInUse(OLD, 'old-db'), 'archive-checked');
    expect(psOld(docker.calls.slice(mark))).toBe(1);
    expect(h.remove.calls).toEqual([]);
    expect(run.volumes[OLD]).toBe('exists');
    expect(fs.existsSync(keptDir())).toBe(true);
  });

  it('the set names another folder at X7: T-X-PATH for the run\'s folder is the whole answer, nothing removed', async () => {
    await kept('main');
    afterExtract = () => editReg(a => { a.keptSets[0].folder = path.join(h.dir, 'bots', 'a', 'data.kept-other'); });
    const answer = await deleteKept('a', set());
    openWith(answer, KEPT_TEXT.xPath(keptDir()), 'archive-checked');
    expect(h.remove.calls).toEqual([]);
    expect(fs.existsSync(keptDir())).toBe(true);
  });

  it('another kept set listed first: the run checks its own set\'s folder, ends, and the other set stays recorded', async () => {
    await kept('main');
    const other = { id: 'other', keptAt: new Date(LATER).toISOString(), by: 'new-start', folder: null, db: { containerName: 'x', user: 'u', db: 'd', volume: 'other-vol' } };
    afterExtract = () => editReg(a => { a.keptSets.unshift(other); });
    const answer = await deleteKept('a', set());
    expect(answer).toEqual({ success: true, text: doneText() });
    expect(stored().keptSets).toEqual([other]);
    expect(stored().keptOp).toBeUndefined();
  });

  it('Run again on a record at removing does not save removing again', async () => {
    await kept('main');
    h.remove.throws = true;
    expect(await deleteKept('a', set())).toMatchObject({ success: false, status: 500 });
    expect(stored().keptOp.step).toBe('removing');
    vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation((id, key, patch) => {
      if (patch.step === 'removing') throw new Error('ENOSPC: no space left on device');
      return realSave(id, key, patch);
    });
    const again = await deleteKept('a', set(), { again: true });
    expect(again).toEqual({ success: true, text: doneText() });
  });
});

describe('nm31 l5 aj: X8 to X10', () => {
  it('a clean run logs the volume removal, the folder removal and the end', async () => {
    await kept('main');
    expect(await deleteKept('a', set())).toEqual({ success: true, text: doneText() });
    const logs = vi.mocked(console.log).mock.calls.map(c => c[0]);
    expect(logs).toContain(`[KeptData] ${label()}: Delete removes the kept volume ${OLD}`);
    expect(logs).toContain(`[KeptData] ${label()}: Delete removes the kept folder ${keptDir()}`);
    expect(logs).toContain(`[KeptData] ${label()}: Delete done (set ${set()})`);
  });

  it('docker removes the volume and still lists it: T-X-PARTIAL names the volume and "docker still lists it"', async () => {
    await kept('main');
    h.remove.listed = true;
    const answer = await deleteKept('a', set());
    openWith(answer, KEPT_TEXT.xPartial({ volume: OLD, err: 'docker still lists it', dump: dumpName(), archive: archiveName() }), 'removing');
    expect(fs.existsSync(keptDir())).toBe(true);
  });

  it('the folder removal returns and the folder is still there: T-X-PARTIAL names the folder and "it is still there"', async () => {
    await kept('main');
    h.rmKeeps = keptDir();
    const answer = await deleteKept('a', set());
    openWith(answer, KEPT_TEXT.xPartial({ folder: keptDir(), err: 'it is still there', dump: dumpName(), archive: archiveName() }), 'removing');
    expect(stored().keptSets.map((x: { id: string }) => x.id)).toEqual([set()]);
  });

  it('a set that holds only a join (no volume, no folder): the done answer says it held nothing to remove', async () => {
    await kept('main');
    editReg(a => { delete a.keptSets[0].db; delete a.keptSets[0].copy; a.keptSets[0].folder = null; a.keptSets[0].join = fakeJoinRecord(); });
    const answer = await deleteKept('a', set());
    expect(answer).toEqual({ success: true, text: KEPT_TEXT.xDoneEmpty(keptDate(set())) });
    expect(stored().keptSets).toBeUndefined();
    expect(h.remove.calls).toEqual([]);
  });

  it('the close throws: a 500 open answer whose reason says the end was not recorded', async () => {
    await kept('main');
    vi.spyOn(containerManager, 'closeKeptOp').mockImplementation(() => { throw new Error('ENOSPC: no space left on device'); });
    const answer = await deleteKept('a', set());
    const reason = 'the end could not be recorded (ENOSPC: no space left on device); run it again';
    const rec = stored().keptOp;
    expect(rec.lastError).toBe(reason);
    expect(answer).toEqual({ success: false, status: 500, open: true, error: KEPT_TEXT.xOpen(reason, deleteDone(rec), rec.step !== 'removing') });
  });

  it('the record was closed elsewhere before the close: the run answers it stopped, not done', async () => {
    await kept('main');
    vi.spyOn(containerManager, 'closeKeptOp').mockImplementation((id, key, close) => {
      editReg(a => { delete a.keptOp; });
      return realClose(id, key, close);
    });
    const answer = await deleteKept('a', set());
    expect(answer).toEqual({ success: false, status: 409, error: `Delete stopped: ${containerManager.KEPT_RECORD_CLOSED}; nothing more was done` });
    expect(vi.mocked(console.log).mock.calls.map(c => c[0])).not.toContain(`[KeptData] ${label()}: Delete done (set ${set()})`);
  });
});
