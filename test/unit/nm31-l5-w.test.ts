import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-l5-w-'));
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
import { stampOf } from '../../src/instance/backupFiles';
import { resetDocker } from './nm2-docker';
import { clearRegistry } from './nm2-harness';
import { resetRun, run } from './nm31-run';
import { patchRegistry, resetSeed, seedMain, offOrder } from './nm31-seed';
import { answerOrders, bot, fwd, keptAfterStart, LATER, LATER_STAMP, login, pressBack, resetBack, stored } from './nm31-back';

const LATER_ISO = new Date(LATER).toISOString();
const realSwap = containerManager.swapKeptData;
const notice = (file: string) => ({ file, text: `Restore of ${file} failed: x`, at: '2026-11-17T11:00:00.000Z' });

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

describe('nm31 l5 w: P3 swap of Put back', () => {
  it('a folder-only set on a database instance with a restore notice: the aside set keeps no database and no notice, the database and notice in use stay', async () => {
    await keptAfterStart('main');
    expect(containerManager.dropKeptPart('a', fwd().stamp, 'db')).toBeNull();
    patchRegistry('a', { fleetRestoreError: notice('new.dump') });
    const fleetDb = bot().fleetDb;
    expect(await pressBack()).toMatchObject({ success: true });
    expect(bot().keptSets).toEqual([{ id: LATER_STAMP, keptAt: LATER_ISO, by: 'put-back', folder: expect.any(String) }]);
    expect(bot().fleetDb).toEqual(fleetDb);
    expect(bot().fleetRestoreError).toEqual(notice('new.dump'));
  });

  it('a folder-only set on a live copy instance: the aside set keeps no copy and the copy in use stays', async () => {
    const before = await keptAfterStart('copy');
    expect(containerManager.dropKeptPart('a', fwd().stamp, 'copy')).toBeNull();
    patchRegistry('a', { fleetDbReplica: before.inst.fleetDbReplica });
    const replica = bot().fleetDbReplica;
    expect(replica).toBeTruthy();
    expect(await pressBack()).toMatchObject({ success: true });
    expect(bot().keptSets).toEqual([{ id: LATER_STAMP, keptAt: LATER_ISO, by: 'put-back', folder: expect.any(String), join: bot().fleetJoin }]);
    expect(bot().fleetDbReplica).toEqual(replica);
  });

  it('a database set kept with a restore notice: the notice comes back in use, and the newer notice goes with the aside set', async () => {
    await seedMain();
    patchRegistry('a', { fleetRestoreError: notice('old.dump') });
    answerOrders();
    const oldVolume = bot().fleetDb!.volume;
    expect(await startOnNewDatabase('a')).toMatchObject({ success: true });
    run.volumes[oldVolume] = 'exists';
    run.volumes[fwd().newVolume] = 'exists';
    expect(bot().keptSets![0].restoreNotice).toEqual(notice('old.dump'));
    expect(bot().fleetRestoreError).toBeUndefined();
    vi.mocked(Date.now).mockReturnValue(LATER);
    await offOrder('a');
    login.canLogin = false;
    answerOrders();
    patchRegistry('a', { fleetRestoreError: notice('new.dump') });
    expect(await pressBack()).toMatchObject({ success: true });
    expect(bot().fleetRestoreError).toEqual(notice('old.dump'));
    expect(bot().keptSets).toEqual([expect.objectContaining({ id: LATER_STAMP, restoreNotice: notice('new.dump') })]);
  });

  it('two kept sets: the swap takes the set pressed, not the first recorded', async () => {
    const before = await keptAfterStart('main');
    const decoyClean = { id: stampOf(Date.parse('2026-11-01T10:00:00.000Z')), keptAt: '2026-11-01T10:00:00.000Z', by: 'put-back', folder: null };
    patchRegistry('a', { keptSets: [decoyClean, ...bot().keptSets!] });
    expect(await pressBack()).toMatchObject({ success: true });
    expect(bot().fleetDb).toEqual(before.inst.fleetDb);
    expect(bot().keptSets!.map(s => s.id)).toEqual([decoyClean.id, LATER_STAMP]);
  });

  it('the set is deleted between the check and the swap\'s load: the run stops open with the reason', async () => {
    await keptAfterStart('main');
    const id = fwd().stamp;
    vi.spyOn(containerManager, 'swapKeptData').mockImplementation((...args) => {
      patchRegistry('a', { keptSets: [] });
      return realSwap(...args);
    });
    const answer = await pressBack();
    const rec = stored().keptOp;
    expect(rec.lastError).toBe(`the record could not be saved (the kept data ${id} is no longer recorded)`);
    expect(answer).toEqual({ success: false, status: 500, open: true, error: KEPT_TEXT.pOpen(rec.lastError, putBackDone(rec)) });
  });
});
