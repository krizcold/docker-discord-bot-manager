import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-l5-al-'));
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
import { KEPT_RECORD_CLOSED } from '../../src/docker/containerManager';
import { claimFleetBackupBusy, releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { deleteKept, folderStep, keepKept, KEPT_TEXT, keptDate, keptRunningOp, startOnNewDatabase } from '../../src/instance/keptData';
import { stampOf } from '../../src/instance/backupFiles';
import { docker, resetDocker } from './nm2-docker';
import { holder } from './dump-fake';
import { clearRegistry, registryPath } from './nm2-harness';
import { resetRun, run } from './nm31-run';
import { resetSeed, seedMain } from './nm31-seed';
import { answerOrders, fwd, keptAfterStart, LATER, resetBack, stored, Variant } from './nm31-back';


const CK = 'smdb-keptcheck-a';
const SIZE = 'du -sk /from && df -Pk /to';
const set = () => fwd().stamp;

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

const realSave = containerManager.saveKeptOpIf;
const dumpName = () => `pre-delete-${stampOf(LATER)}.dump`;
const regText = () => fs.readFileSync(registryPath(), 'utf-8');
const name = () => containerManager.getBot('a')!.displayName;
const IN_USE = 'Error response from daemon: volume is in use';

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

async function kept(variant: Variant): Promise<void> {
  await keptAfterStart(variant, { off: false });
  docker.calls.length = 0;
  run.execCalls.length = 0;
}

async function openAtCheck(): Promise<void> {
  await kept('main');
  docker.restore = { code: 1, stderr: 'pg_restore: error: bad' };
  expect(await deleteKept('a', set())).toMatchObject({ success: false, open: true });
  docker.restore = { code: 0 };
  docker.calls.length = 0;
}

/** Calls `fn` once, synchronously, at the first docker call made while `when` holds. */
function atDockerCall(when: () => boolean, fn: () => void): void {
  let done = false;
  docker.overrides.unshift({
    match: () => {
      if (!done && when()) {
        done = true;
        fn();
      }
      return false;
    },
    answer: { ok: true },
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
  Object.assign(h.remove, { calls: [], fail: false, throws: false });
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

describe('nm31 l5 al: deleteKept', () => {
  it('an unknown bot: 404 Bot not found', async () => {
    expect(await deleteKept('zz', 'any')).toEqual({ success: false, status: 404, error: 'Bot not found' });
  });

  it('an unknown bot while the manager shuts down: still 404 Bot not found', async () => {
    vi.spyOn(containerManager, 'isShuttingDown').mockReturnValue(true);
    expect(await deleteKept('zz', 'any')).toEqual({ success: false, status: 404, error: 'Bot not found' });
  });

  it('Delete and Keep it while a Start on a new database runs: its busy text, not T-X-RUNNING', async () => {
    await seedMain();
    answerOrders();
    let del: Promise<unknown> | null = null;
    let keep: Promise<unknown> | null = null;
    atDockerCall(() => keptRunningOp('a') === 'new-database', () => {
      del = deleteKept('a', 'any');
      keep = keepKept('a');
    });
    expect(await startOnNewDatabase('a')).toMatchObject({ success: true });
    expect(await del).toEqual({ success: false, status: 409, error: "Operation 'new-database' already in progress" });
    expect(await keep).toEqual({ success: false, status: 409, error: "Operation 'new-database' already in progress" });
  });

  it('a refused admission leaves a backup slot another holder claimed', async () => {
    await kept('main');
    expect(claimFleetBackupBusy('a')).toBe(true);
    expect(await deleteKept('a', 'no-such-set')).toMatchObject({ success: false, status: 409 });
    expect(claimFleetBackupBusy('a')).toBe(false);
  });

  it('a database set: the slot is freed once the dump is checked, and a holder claiming it then keeps it after the run', async () => {
    await kept('main');
    let claimed: boolean | null = null;
    afterExtract = () => { claimed = claimFleetBackupBusy('a'); };
    expect(await deleteKept('a', set())).toMatchObject({ success: true });
    expect(claimed).toBe(true);
    expect(claimFleetBackupBusy('a')).toBe(false);
  });

  it('a folder set takes no slot, so it never frees one another holder claimed', async () => {
    await kept('folder');
    expect(claimFleetBackupBusy('a')).toBe(true);
    expect(await deleteKept('a', set())).toMatchObject({ success: true });
    expect(claimFleetBackupBusy('a')).toBe(false);
  });

  it('an unexpected error logs its exact line', async () => {
    await kept('main');
    h.remove.throws = true;
    await deleteKept('a', set());
    expect(console.error).toHaveBeenCalledWith('[KeptData] a: Delete stopped on an unexpected error: the manager stopped here');
  });

  it('a later route that throws before it begins a run does not write its error on the record an earlier run left open', async () => {
    await openAtCheck();
    const before = stored().keptOp.lastError;
    const real = containerManager.getBot;
    let n = 0;
    vi.spyOn(containerManager, 'getBot').mockImplementation((id) => {
      if (++n === 2) throw new Error('EACCES: permission denied');
      return real(id);
    });
    expect(await deleteKept('a', set(), { again: true })).toEqual({ success: false, status: 500, error: 'Delete stopped on an unexpected error: EACCES: permission denied' });
    expect(stored().keptOp.lastError).toBe(before);
  });
});

describe('nm31 l5 al: rejected archives in Keep it', () => {
  it('names only this set\'s rejected archives, sorted, whatever order the folder lists them in', async () => {
    await openAtCheck();
    const dir = path.join(h.dir, 'backups', 'a', 'kept');
    fs.mkdirSync(dir, { recursive: true });
    const r1 = `${set()}.tar.rejected-${stampOf(LATER)}`;
    const r2 = `${set()}.tar.rejected-${stampOf(LATER + 60_000)}`;
    for (const f of [r1, r2, 'other.tar.rejected-x', `${set()}.tar`]) fs.writeFileSync(path.join(dir, f), 'x');
    const real = fs.readdirSync;
    vi.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike, o?: unknown) => {
      const out = (real as (p: fs.PathLike, o?: unknown) => unknown)(p, o);
      return path.resolve(String(p)) === path.resolve(dir) && Array.isArray(out) ? [...out].sort().reverse() : out;
    }) as typeof fs.readdirSync);
    const answer = await keepKept('a');
    expect(answer).toEqual({ success: true, text: KEPT_TEXT.xKept({ date: keptDate(set()), dump: dumpName(), rejected: [r1, r2] }) });
  });
});

describe('nm31 l5 al: keepKept', () => {
  it('Keep it claims the bot while it runs: a Delete then answers T-X-RUNNING', async () => {
    await openAtCheck();
    let op: string | null = 'not reached';
    let del: Promise<unknown> | null = null;
    atDockerCall(() => true, () => {
      op = keptRunningOp('a');
      del = deleteKept('a', set());
    });
    expect(await keepKept('a')).toMatchObject({ success: true });
    expect(op).toBe('abandon');
    expect(await del).toEqual({ success: false, status: 409, error: KEPT_TEXT.xRunning });
  });

  it('an open Start on a new database: T-X-NOKEEP, the record stays', async () => {
    await seedMain();
    answerOrders();
    crashOnStep('db-stopped');
    await startOnNewDatabase('a');
    vi.mocked(containerManager.saveKeptOpIf).mockRestore();
    expect(stored().keptOp.op).toBe('new-start');
    const reg = regText();
    expect(await keepKept('a')).toEqual({ success: false, status: 409, error: KEPT_TEXT.xNoKeep });
    expect(regText()).toBe(reg);
  });

  it('a record at removing whose registry read fails: T-X-NOABANDON before any close', async () => {
    await kept('main');
    h.remove.fail = true;
    await deleteKept('a', set());
    expect(stored().keptOp.step).toBe('removing');
    const close = vi.spyOn(containerManager, 'closeKeptDeleteIf').mockImplementation(() => { throw new Error('EACCES: permission denied'); });
    expect(await keepKept('a')).toEqual({ success: false, status: 409, error: KEPT_TEXT.xNoAbandon });
    expect(close).not.toHaveBeenCalled();
  });

  it('a record with its archive: the answer names the archive', async () => {
    await kept('main');
    crashOnStep('archive-checked');
    await deleteKept('a', set());
    vi.mocked(containerManager.saveKeptOpIf).mockRestore();
    expect(stored().keptOp).toMatchObject({ step: 'archived', archive: `${set()}.tar` });
    expect(await keepKept('a')).toEqual({ success: true, text: KEPT_TEXT.xKept({ date: keptDate(set()), dump: dumpName(), archive: `${set()}.tar` }) });
  });

  it('the close cannot be saved: 500 with its exact text', async () => {
    await openAtCheck();
    vi.spyOn(containerManager, 'closeKeptDeleteIf').mockImplementation(() => { throw new Error('ENOSPC: no space left on device'); });
    expect(await keepKept('a')).toEqual({ success: false, status: 500, error: 'Keep it was not recorded, so the Delete stays open: ENOSPC: no space left on device' });
  });

  it('the close finds the removal began: T-X-NOABANDON', async () => {
    await openAtCheck();
    vi.spyOn(containerManager, 'closeKeptDeleteIf').mockReturnValue('removing');
    expect(await keepKept('a')).toEqual({ success: false, status: 409, error: KEPT_TEXT.xNoAbandon });
  });

  it('the close finds the record closed: T-X-NOKEEP, and no scratch removal', async () => {
    await openAtCheck();
    vi.spyOn(containerManager, 'closeKeptDeleteIf').mockReturnValue(KEPT_RECORD_CLOSED);
    expect(await keepKept('a')).toEqual({ success: false, status: 409, error: KEPT_TEXT.xNoKeep });
    expect(docker.calls).toEqual([]);
  });

  it('logs its exact line', async () => {
    await openAtCheck();
    await keepKept('a');
    expect(console.log).toHaveBeenCalledWith(`[KeptData] ${name()}: Delete of ${set()} stopped with Keep it`);
  });

  it('the scratch and the throwaway cannot be removed: both failures in the answer and the warning', async () => {
    await openAtCheck();
    docker.overrides.unshift({ match: a => a[0] === 'volume' && a[1] === 'rm', answer: { ok: false, stderr: IN_USE } });
    const text = KEPT_TEXT.xKept({ date: keptDate(set()), dump: dumpName() });
    expect(await keepKept('a')).toEqual({ success: true, text: `${text} The scratch copy could not be removed (${IN_USE}; ${IN_USE}); the next Delete removes it first.` });
    expect(console.warn).toHaveBeenCalledWith(`[KeptData] ${name()}: the scratch copy of Delete could not be removed (${IN_USE}; ${IN_USE})`);
  });
});

describe('nm31 l5 al: folderStep', () => {
  it('forward with a folder read as present: refused, the new data folder was not read', () => {
    expect(folderStep('forward', 'full', 'absent', 'present')).toEqual({ refuse: 'the new data folder was not read' });
  });

  it('forward, data present, set aside, the new folder partial or foreign: T-N-NOTOURS on the new folder', () => {
    for (const data of ['full', 'empty'] as const) {
      for (const inState of ['partial', 'foreign'] as const) {
        expect(folderStep('forward', data, 'present', inState)).toEqual({ refuse: 'the new data folder holds files this start did not write', notOurs: 'in' });
      }
    }
  });
});
