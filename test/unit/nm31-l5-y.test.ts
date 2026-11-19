import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-l5-y-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, hookBodies: [] as Array<{ action: string; body: any }> };
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
  callAppHook: async (_i: unknown, action: string, _method: string, body: unknown) => { h.hookBodies.push({ action, body }); return { ok: true, body: { saved: true } }; },
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { KEPT_TEXT, putBackDone, startOnNewDatabase } from '../../src/instance/keptData';
import { resetDocker, docker } from './nm2-docker';
import { clearRegistry } from './nm2-harness';
import { resetRun, run } from './nm31-run';
import { COPY_CONTAINER, COPY_VOLUME, CONTAINER, dataDirOf, offOrder, patchRegistry, resetSeed, treeOf } from './nm31-seed';
import { answerOrders, bot, fwd, keptAfterStart, LATER_STAMP, login, orders, pressBack, resetBack, stored } from './nm31-back';

const realSave = containerManager.saveKeptOpIf;
const realRunning = containerManager.containerRunningExact;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-17T12:00:00.000Z'));
  resetDocker();
  resetRun();
  clearRegistry();
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  resetSeed();
  resetBack();
  h.hookBodies.length = 0;
});
afterEach(() => {
  releaseFleetBackupBusy('a');
  vi.restoreAllMocks();
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

const NO_ANSWER = 'docker did not say whether the bot runs';

/** The open answer for `reason`, with the steps the stored record reached. */
function opened(reason: string) {
  const rec = stored().keptOp;
  expect(rec.lastError).toBe(reason);
  return { success: false, status: expect.any(Number), open: true, error: KEPT_TEXT.pOpen(rec.lastError, putBackDone(rec), !!rec.undo) };
}

/** containerRunningExact answers `answer` for `name` while the record is at 'swapped' (the stopped read), the fakes otherwise. */
function runningAtStoppedRead(name: string, answer: boolean | null, asked: string[]): void {
  vi.spyOn(containerManager, 'containerRunningExact').mockImplementation(async (n) => {
    if (stored().keptOp?.step === 'swapped') {
      asked.push(n);
      if (n === name) return answer;
    }
    return realRunning(n);
  });
}

/** A put back of `variant`'s set cut by a crash at the 'folder' save, so its undo runs the folder step back. */
async function cutAtFolder(variant: 'main' | 'copy'): Promise<void> {
  let done = false;
  const spy = vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation((id, key, patch) => {
    if (!done && patch.step === 'folder') {
      done = true;
      throw new Error('the manager stopped here');
    }
    return realSave(id, key, patch);
  });
  expect(await pressBack()).toMatchObject({ success: false, open: true });
  spy.mockRestore();
  expect(stored().keptOp.step).toBe('swapped');
  if (variant === 'main') expect(bot().fleetDb?.containerName).toBe(CONTAINER);
  else expect(bot().fleetDbReplica?.containerName).toBe(COPY_CONTAINER);
}

const STAMP2 = '2026-11-17T14-00-00-000Z';

/** After a clean Put back of the copy's set, a second Start on a new database and Off again: sets [the aside set, the new one]. */
async function twoCopySets(): Promise<void> {
  await keptAfterStart('copy');
  expect(await pressBack()).toMatchObject({ success: true });
  vi.mocked(Date.now).mockReturnValue(Date.parse('2026-11-17T14:00:00.000Z'));
  expect(await startOnNewDatabase('a')).toMatchObject({ success: true });
  run.volumes[COPY_VOLUME] = 'exists';
  vi.mocked(Date.now).mockReturnValue(Date.parse('2026-11-17T15:00:00.000Z'));
  await offOrder('a');
  login.canLogin = false;
  answerOrders();
  orders.length = 0;
  expect(bot().keptSets!.map(x => [x.id, x.copy?.containerName])).toEqual([[LATER_STAMP, undefined], [STAMP2, COPY_CONTAINER]]);
  expect(bot().fleetDbReplica).toBeUndefined();
}

const removals = (into: string[]) => vi.spyOn(containerManager, 'removeFleetDbReplicaService')
  .mockImplementation(async (_id, name) => { into.push(name); return { success: true }; });

describe('nm31 l5 y: the stopped read before P4', () => {
  it('docker does not answer for the database in use: open at swapped, the folder not moved', async () => {
    await keptAfterStart('main');
    const inUse = treeOf(dataDirOf('a'));
    const asked: string[] = [];
    runningAtStoppedRead(CONTAINER, null, asked);
    expect(await pressBack()).toEqual(opened(NO_ANSWER));
    expect(asked).toEqual([CONTAINER]);
    expect(stored().keptOp.step).toBe('swapped');
    expect(treeOf(dataDirOf('a'))).toEqual(inUse);
  });

  it('the database in use runs: T-N-RUNS names it', async () => {
    await keptAfterStart('main');
    const inUse = treeOf(dataDirOf('a'));
    runningAtStoppedRead(CONTAINER, true, []);
    expect(await pressBack()).toEqual(opened(KEPT_TEXT.nRuns(CONTAINER)));
    expect(treeOf(dataDirOf('a'))).toEqual(inUse);
  });

  it('the undo of a database put back onto no database reads the container of the set it brings back', async () => {
    await keptAfterStart('main');
    patchRegistry('a', { fleetDb: undefined });
    docker.running[CONTAINER] = false;
    await cutAtFolder('main');
    const asked: string[] = [];
    runningAtStoppedRead(CONTAINER, true, asked);
    expect(await pressBack(fwd().stamp, { reverse: true })).toEqual(opened(KEPT_TEXT.nRuns(CONTAINER)));
    expect(asked).toEqual([CONTAINER]);
  });

  it('the undo of a live copy put back onto no copy reads the copy of the set it brings back', async () => {
    await keptAfterStart('copy');
    await cutAtFolder('copy');
    const asked: string[] = [];
    runningAtStoppedRead(COPY_CONTAINER, true, asked);
    expect(await pressBack(fwd().stamp, { reverse: true })).toEqual(opened(KEPT_TEXT.nRuns(COPY_CONTAINER)));
    expect(asked).toEqual([COPY_CONTAINER]);
  });
});

describe('nm31 l5 y: P1 and P2', () => {
  it('a folder set saves no db-stopped or db-out step', async () => {
    await keptAfterStart('folder');
    const steps: unknown[] = [];
    vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation((id, key, patch) => { steps.push(patch.step); return realSave(id, key, patch); });
    expect(await pressBack()).toMatchObject({ success: true });
    expect(steps).toEqual([undefined, 'folder', 'db-in', 'settled']);
  });

  it('the undo of a live copy put back: the copy in use does not stop', async () => {
    await keptAfterStart('copy');
    await cutAtFolder('copy');
    vi.spyOn(containerManager, 'stopContainerExact').mockResolvedValue({ ok: false, error: 'permission denied' } as any);
    expect(await pressBack(fwd().stamp, { reverse: true })).toEqual(opened('the live copy in use did not stop (permission denied)'));
  });

  it('a live copy set put back onto no copy removes the service of the set\'s copy', async () => {
    await keptAfterStart('copy');
    const removed: string[] = [];
    removals(removed);
    expect(await pressBack()).toMatchObject({ success: true });
    expect(removed).toEqual([COPY_CONTAINER]);
  });

  it('with an earlier set that has no copy, the removal names the put back set\'s copy', async () => {
    await twoCopySets();
    const removed: string[] = [];
    removals(removed);
    expect(await pressBack(STAMP2)).toMatchObject({ success: true });
    expect(removed).toEqual([COPY_CONTAINER]);
  });

  it('the copy\'s service cannot be removed: open at db-stopped with its error', async () => {
    await keptAfterStart('copy');
    const error = 'the standby service could not be removed from the deployed compose (EACCES: permission denied); the standby was left as it is';
    vi.spyOn(containerManager, 'removeFleetDbReplicaService').mockResolvedValue({ success: false, error });
    expect(await pressBack()).toEqual(opened(error));
    expect(stored().keptOp.step).toBe('db-stopped');
  });
});
