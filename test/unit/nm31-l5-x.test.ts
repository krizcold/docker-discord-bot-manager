import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-putback-'));
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
import { KEPT_TEXT, putBackDone } from '../../src/instance/keptData';
import { docker, resetDocker } from './nm2-docker';
import { clearRegistry } from './nm2-harness';
import { resetRun } from './nm31-run';
import { app, COPY_CONTAINER, dataDirOf, resetSeed, treeOf } from './nm31-seed';
import { bot, fwd, keptAfterStart, pressBack, resetBack, stored } from './nm31-back';

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
});
afterEach(() => {
  releaseFleetBackupBusy('a');
  vi.restoreAllMocks();
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

const NO_ANSWER = 'docker did not say whether the bot runs';
const realSave = containerManager.saveKeptOpIf;
const realSwap = containerManager.swapKeptData;

/** The open answer for `reason`, with the steps the stored record reached. */
function opened(reason: string) {
  const rec = stored().keptOp;
  expect(rec.lastError).toBe(reason);
  return { success: false, status: 409, open: true, error: KEPT_TEXT.pOpen(rec.lastError, putBackDone(rec), !!rec.undo) };
}

/** Runs the real swap, then `after`, as an event right after P3's save. */
function afterSwap(after: () => void): void {
  vi.spyOn(containerManager, 'swapKeptData').mockImplementation((...args) => {
    const r = realSwap(...args);
    after();
    return r;
  });
}

describe('nm31 L5 x: runPutBack before P4', () => {
  it('docker does not say whether the app runs at the stopped read before P4: the record opens at swapped and no folder moves', async () => {
    await keptAfterStart('folder');
    const inUse = treeOf(dataDirOf('a'));
    afterSwap(() => { app.a = null; });
    expect(await pressBack()).toEqual(opened(NO_ANSWER));
    expect(stored().keptOp.step).toBe('swapped');
    expect(treeOf(dataDirOf('a'))).toEqual(inUse);
    expect(fs.existsSync(fwd().outDir)).toBe(true);
  });

  it('a folder set put back on an instance whose live copy runs: the stopped read does not read the copy, and the run ends done', async () => {
    await keptAfterStart('copy');
    expect(await pressBack()).toMatchObject({ success: true });
    expect(bot().fleetDbReplica?.containerName).toBe(COPY_CONTAINER);
    expect(docker.running[COPY_CONTAINER]).toBe(true);
    const aside = bot().keptSets![0];
    expect(aside.copy).toBeUndefined();
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-11-17T14:00:00.000Z'));
    const answer = await pressBack(aside.id);
    expect(answer).toMatchObject({ success: true });
    expect(stored().keptOp).toBeUndefined();
    expect(docker.running[COPY_CONTAINER]).toBe(true);
  });

  it('the reverse of a live copy put back: the copy it sets aside, started outside after the swap, opens T-N-RUNS before P4', async () => {
    await keptAfterStart('copy');
    let done = false;
    vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation((id, key, patch) => {
      if (!done && patch.step === 'folder') {
        done = true;
        throw new Error('the manager stopped here');
      }
      return realSave(id, key, patch);
    });
    expect(await pressBack()).toMatchObject({ success: false, open: true });
    const inUse = treeOf(dataDirOf('a'));
    afterSwap(() => { docker.running[COPY_CONTAINER] = true; });
    expect(await pressBack(fwd().stamp, { reverse: true })).toEqual(opened(KEPT_TEXT.nRuns(COPY_CONTAINER)));
    expect(stored().keptOp.step).toBe('swapped');
    expect(bot().keptSets!.map(x => x.id)).toEqual([fwd().stamp]);
    expect(bot().keptSets![0].copy?.containerName).toBe(COPY_CONTAINER);
    expect(treeOf(dataDirOf('a'))).toEqual(inUse);
  });
});
