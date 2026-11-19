import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm37-fence-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    /** The removal of an owner file is answered by docker's error. */
    rmFails: false,
    /** A fence read on the named container waits for the promise. */
    hold: null as null | { container: string; until: Promise<void>; reached: () => void },
  };
});

const DAEMON = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';

// The owner file's removal (exec -u root ... grep -qx ... rm -f) is recorded in docker.calls, and fails while h.rmFails.
vi.mock('child_process', async (importOriginal) => {
  const m = await (await import('./nm31-run')).childProcessMock(await importOriginal(), require('fs')) as any;
  const { docker } = await import('./nm2-docker');
  const execFile = (cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown): unknown => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (err: Error | null, stdout: string, stderr: string) => void;
    const drop = cmd === 'docker' && args[0] === 'exec' && args[1] === '-u' && args[2] === 'root' && args.join(' ').includes('grep -qx');
    if (h.hold && cmd === 'docker' && args[0] === 'exec' && args.includes(h.hold.container) && args.join(' ').includes('pg_read_file')) {
      h.hold.reached();
      void h.hold.until.then(() => m.execFile(cmd, args, optsOrCb, maybeCb));
      return undefined;
    }
    if (!drop) return m.execFile(cmd, args, optsOrCb, maybeCb);
    docker.calls.push(args);
    if (!h.rmFails) return m.execFile(cmd, args, optsOrCb, maybeCb);
    setTimeout(() => cb(Object.assign(new Error(`Command failed: docker ${args.join(' ')}\n${DAEMON}\n`), { code: 1 }), '', `${DAEMON}\n`), 1);
    return undefined;
  };
  return { ...m, execFile, default: { ...m.default, execFile } };
});
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
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as dbLogin from '../../src/instance/dbLogin';
import * as fleetBackup from '../../src/instance/fleetBackup';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { startOnNewDatabase } from '../../src/instance/keptData';
import { docker, resetDocker } from './nm2-docker';
import { clearRegistry, startedWithTick, tickOnce } from './nm2-harness';
import { fenceOwners } from './fence-fake';
import { resetRun, run } from './nm31-run';
import { CONTAINER, patchRegistry, resetSeed, seedMain, stored } from './nm31-seed';
import { answerOrders, bot, fwd, resetBack } from './nm31-back';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const B_CONTAINER = 'botb-fleet-postgres';
const OWNER = 'restore:1763380800000';
const STOP_ERROR = 'Error response from daemon: cannot stop container: bota-fleet-postgres: permission denied';
const realSave = containerManager.saveKeptOpIf;
/** Containers whose fence read answers read-only on. */
const readOnly = new Set<string>();

/** Throws once from the save of `step`; every other save runs. */
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

/** Bot a as seedMain leaves it with Off settled, and bot b with a plain main whose container runs. */
async function fixture(): Promise<void> {
  await seedMain();
  await seedMain('b', { off: false });
  // No scheduled dump or test restore: the tick's stuck-fence pass is the row's subject.
  for (const id of ['a', 'b']) patchRegistry(id, { fleetBackup: { enabled: false, hour: 4, keep: 7 } });
  answerOrders();
  expect(containerManager.getBot('b')!.fleetDb!.containerName).toBe(B_CONTAINER);
  run.volumes[bot().fleetDb!.volume] = 'exists';
  docker.overrides.unshift({
    match: a => a[a.length - 1] === 'SHOW default_transaction_read_only' && readOnly.has(a[a.indexOf('psql') - 1]),
    answer: { ok: true, stdout: 'on\n' },
  });
}

/** A press that leaves the forward record open at `step` with the new database's container running. */
async function runTo(step: 'db-in' | 'db-up'): Promise<void> {
  crashOnStep(step === 'db-in' ? 'db-up' : 'login');
  expect(await startOnNewDatabase('a')).toMatchObject({ success: false, open: true });
  vi.mocked(containerManager.saveKeptOpIf).mockRestore();
  expect(stored().keptOp).toMatchObject({ op: 'new-start', step });
  expect(bot().fleetDb!.volume).toBe(fwd().newVolume);
  expect(docker.running[CONTAINER]).toBe(true);
}

const fenceRead = (c: string) => docker.calls.filter(a => a[0] === 'exec' && a.includes(c) && a[a.length - 1] === 'SHOW default_transaction_read_only');
const rootExec = (c: string) => docker.calls.filter(a => a[0] === 'exec' && a[1] === '-u' && a[2] === 'root' && a[3] === c);
const onC = () => docker.calls.filter(a => a.includes(CONTAINER));

/** The scheduler's start with its interval captured; answers once the start's pass has read b's fence. */
async function started(): Promise<() => void> {
  docker.calls.length = 0;
  const tick = startedWithTick(fleetBackup);
  await vi.waitFor(() => expect(fenceRead(B_CONTAINER).length).toBeGreaterThan(0), { timeout: 4000, interval: 5 });
  return tick;
}

/** One backup tick, ended, in which the stuck-fence pass read b's fence. */
async function ticked(tick: () => void): Promise<void> {
  docker.calls.length = 0;
  await tickOnce(fleetBackup, tick);
  expect(fenceRead(B_CONTAINER).length).toBeGreaterThan(0);
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  h.rmFails = false;
  h.hold = null;
  readOnly.clear();
  fenceOwners.clear();
  resetDocker();
  resetRun();
  clearRegistry();
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.rmSync(path.join(h.dir, 'backups'), { recursive: true, force: true });
  resetSeed();
  resetBack();
  dbLogin.resetManagerRoleCache();
});
afterEach(async () => {
  // The entries a row left in fleetBackup's memory go with their bots: a tick on an empty registry drops them.
  releaseFleetBackupBusy('a');
  h.rmFails = false;
  readOnly.clear();
  fenceOwners.clear();
  clearRegistry();
  await tickOnce(fleetBackup, startedWithTick(fleetBackup));
  expect(fleetBackup.getFleetFenceStuck('a')).toBeNull();
  expect(fleetBackup.getFleetFenceStuck('b')).toBeNull();
  vi.restoreAllMocks();
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('nm37 fence: the scheduler\'s start leaves an unchecked new database alone (F1)', () => {
  async function ownerFileOver(step: 'db-in' | 'db-up'): Promise<void> {
    await fixture();
    await runTo(step);
    fenceOwners.set(CONTAINER, OWNER);
    await started();
  }

  it('F1: a record at db-in, an owner file over a database that is not read-only: no fence read and no removal on its container', async () => {
    await ownerFileOver('db-in');
    await new Promise(r => setTimeout(r, 30));
    expect(onC()).toEqual([]);
    expect(fenceOwners.get(CONTAINER)).toBe(OWNER);
  });

  it('F1c (the control): the same at db-up: the fence is read and the owner file removed', async () => {
    await ownerFileOver('db-up');
    await vi.waitFor(() => expect(rootExec(CONTAINER).length).toBe(1), { timeout: 4000, interval: 5 });
    expect(fenceRead(CONTAINER).length).toBe(1);
    expect(rootExec(CONTAINER)[0].join(' ')).toContain('rm -f');
    await vi.waitFor(() => expect(fenceOwners.has(CONTAINER)).toBe(false));
  });
});

describe('nm37 fence: a start pressed while the scheduler\'s start reads an earlier bot (F1)', () => {
  it('F1h: b comes first and its fence read is held; a gets its record at db-in meanwhile; released: no call on a\'s container', async () => {
    await seedMain('b', { off: false });
    await seedMain();
    for (const id of ['a', 'b']) patchRegistry(id, { fleetBackup: { enabled: false, hour: 4, keep: 7 } });
    answerOrders();
    expect(containerManager.getAllBots().map(b => b.id)).toEqual(['b', 'a']);
    run.volumes[bot().fleetDb!.volume] = 'exists';
    let release!: () => void;
    let reached!: () => void;
    const atRead = new Promise<void>(r => { reached = r; });
    h.hold = { container: B_CONTAINER, until: new Promise<void>(r => { release = r; }), reached };
    startedWithTick(fleetBackup);
    await atRead;
    await runTo('db-in');
    fenceOwners.set(CONTAINER, OWNER);
    docker.calls.length = 0;
    h.hold = null;
    release();
    await vi.waitFor(() => expect(fenceRead(B_CONTAINER).length).toBeGreaterThan(0), { timeout: 4000, interval: 5 });
    await new Promise(r => setTimeout(r, 50));
    expect(onC()).toEqual([]);
    expect(fenceOwners.get(CONTAINER)).toBe(OWNER);
  });
});

describe('nm37 fence: the backup tick\'s pass over an owner file left before the start (F2, fb:962)', () => {
  /** The scheduler started on the kept database, each owner file's removal failing; then the run to `step`. */
  async function staleOwner(step: 'db-in' | 'db-up'): Promise<() => void> {
    await fixture();
    fenceOwners.set(CONTAINER, OWNER);
    fenceOwners.set(B_CONTAINER, OWNER);
    h.rmFails = true;
    docker.running[CONTAINER] = true;
    const tick = await started();
    await vi.waitFor(() => expect(rootExec(CONTAINER).length + rootExec(B_CONTAINER).length).toBe(2), { timeout: 4000, interval: 5 });
    await new Promise(r => setTimeout(r, 30));
    await runTo(step);
    // The new volume holds no owner file.
    fenceOwners.delete(CONTAINER);
    h.rmFails = false;
    return tick;
  }

  it('F2: the record at db-in: the tick makes no call on the container', async () => {
    await ticked(await staleOwner('db-in'));
    expect(onC()).toEqual([]);
  });

  it('F2c (the control): the record at db-up: the tick reads the fence on the container', async () => {
    await ticked(await staleOwner('db-up'));
    expect(fenceRead(CONTAINER).length).toBe(1);
  });
});

describe('nm37 fence: the backup tick\'s pass over a stuck entry set before the swap (F2, fb:971)', () => {
  /**
   * The kept database reads read-only with no entry in memory; the first stop of the press fails, so the record stays
   * at 'recorded' with the container running on the kept volume; the scheduler's start sets the entry; then Run it
   * again goes to `step`.
   */
  async function stuckBeforeSwap(step: 'db-in' | 'db-up'): Promise<{ tick: () => void; text: string }> {
    await fixture();
    readOnly.add(CONTAINER);
    readOnly.add(B_CONTAINER);
    let failed = false;
    docker.overrides.unshift({
      match: a => a[0] === 'stop' && !failed,
      answer: () => { failed = true; return { ok: false, stderr: STOP_ERROR }; },
    });
    expect(fleetBackup.getFleetFenceStuck('a')).toBeNull();
    expect(await startOnNewDatabase('a')).toMatchObject({ success: false, open: true });
    expect(stored().keptOp).toMatchObject({ op: 'new-start', step: 'recorded' });
    expect(stored().keptOp.lastError).toContain(STOP_ERROR);
    docker.running[CONTAINER] = true;
    const tick = await started();
    await vi.waitFor(() => expect(fleetBackup.getFleetFenceStuck('a')).not.toBeNull(), { timeout: 4000, interval: 5 });
    await vi.waitFor(() => expect(fleetBackup.getFleetFenceStuck('b')).not.toBeNull(), { timeout: 4000, interval: 5 });
    const text = fleetBackup.getFleetFenceStuck('a')!;
    await runTo(step);
    return { tick, text };
  }

  it('F3: the record at db-in: the tick makes no call on the container and the entry stays', async () => {
    const { tick, text } = await stuckBeforeSwap('db-in');
    await ticked(tick);
    expect(onC()).toEqual([]);
    expect(fleetBackup.getFleetFenceStuck('a')).toBe(text);
  });

  it('F3c (the control): the record at db-up and the fence read answering no layer: the read shows and the entry is cleared', async () => {
    const { tick } = await stuckBeforeSwap('db-up');
    readOnly.delete(CONTAINER);
    await ticked(tick);
    expect(fenceRead(CONTAINER).length).toBe(1);
    expect(fleetBackup.getFleetFenceStuck('a')).toBeNull();
  });
});
