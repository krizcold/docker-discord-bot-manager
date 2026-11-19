import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-l5-ab-'));
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
import { claimFleetBackupBusy, isFleetBackupBusy, releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { KEPT_TEXT, keptRunningOp } from '../../src/instance/keptData';
import { resetDocker, docker } from './nm2-docker';
import { clearRegistry } from './nm2-harness';
import { resetRun } from './nm31-run';
import { patchRegistry, resetSeed } from './nm31-seed';
import { bot, fwd, keptAfterStart, pressBack, resetBack, stored } from './nm31-back';

const SLOT_TEXT = 'A backup or restore operation is in progress on this database - wait for it to finish';
const R11 = 'Docker did not say whether the bot is running, so nothing was changed; retry in a moment';

/** The backup slot as admission's read of the app container saw it. */
function slotAtAppReads(): boolean[] {
  const seen: boolean[] = [];
  vi.spyOn(containerManager, 'appContainerRunning').mockImplementationOnce(async () => {
    seen.push(isFleetBackupBusy('a'));
    return false;
  });
  return seen;
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
  resetSeed();
  resetBack();
  h.hookBodies.length = 0;
});
afterEach(() => {
  releaseFleetBackupBusy('a');
  vi.restoreAllMocks();
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('nm31 l5 ab: admission of Put back and the backup slot', () => {
  it('a folder set is refused while a backup holds the slot, and the slot stays the backup\'s', async () => {
    await keptAfterStart('folder');
    expect(claimFleetBackupBusy('a')).toBe(true);
    expect(await pressBack()).toEqual({ success: false, status: 409, error: SLOT_TEXT });
    expect(bot().keptOp).toBeUndefined();
    expect(bot().keptSets?.map(x => x.id)).toEqual([fwd().stamp]);
    expect(isFleetBackupBusy('a')).toBe(true);
  });

  it('an open put-back record of one set refuses a press of another set with the open-record text', async () => {
    await keptAfterStart('main');
    docker.overrides.unshift({ match: a => a[0] === 'stop', answer: { ok: false, stderr: 'Error response from daemon: cannot stop container: permission denied' } });
    expect(await pressBack()).toMatchObject({ success: false, open: true });
    docker.overrides.shift();
    const rec = stored().keptOp;
    expect(rec).toMatchObject({ op: 'put-back', set: fwd().stamp, step: 'recorded' });
    expect(await pressBack('2026-01-01T00-00-00-000Z')).toEqual({ success: false, status: 409, error: containerManager.keptOpOpenText(rec) });
    expect(stored().keptOp).toEqual(rec);
  });

  it('a set that holds nothing is refused T-P-EMPTY', async () => {
    await keptAfterStart('folder');
    const set = { ...bot().keptSets![0], folder: null };
    patchRegistry('a', { keptSets: [set] });
    expect(await pressBack()).toEqual({ success: false, status: 409, error: KEPT_TEXT.pEmpty(fwd().stamp) });
    expect(bot().keptSets).toEqual([set]);
    expect(bot().keptOp).toBeUndefined();
  });

  it('a database set holds the backup slot through its run', async () => {
    await keptAfterStart('main');
    const seen = slotAtAppReads();
    { const ans = await pressBack(); expect(ans).toEqual(expect.objectContaining({ success: true })); }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(x => x === true)).toBe(true);
    expect(isFleetBackupBusy('a')).toBe(false);
  });

  it('a folder set runs without the backup slot', async () => {
    await keptAfterStart('folder');
    const seen = slotAtAppReads();
    { const ans = await pressBack(); expect(ans).toEqual(expect.objectContaining({ success: true })); }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(x => x === false)).toBe(true);
  });

  it('a database set whose admission throws gives the slot back', async () => {
    await keptAfterStart('main');
    vi.spyOn(containerManager, 'appContainerRunning').mockRejectedValue(new Error('the docker socket closed'));
    expect(await pressBack()).toMatchObject({ success: false, status: 500 });
    expect(isFleetBackupBusy('a')).toBe(false);
    expect(keptRunningOp('a')).toBeNull();
  });

  it('a folder set whose admission throws leaves a slot a backup took meanwhile with the backup', async () => {
    await keptAfterStart('folder');
    vi.spyOn(containerManager, 'appContainerRunning').mockImplementation(async () => {
      claimFleetBackupBusy('a');
      throw new Error('the docker socket closed');
    });
    expect(await pressBack()).toMatchObject({ success: false, status: 500 });
    expect(isFleetBackupBusy('a')).toBe(true);
  });

  it('a folder set refused in admission leaves a slot a backup took meanwhile with the backup', async () => {
    await keptAfterStart('folder');
    vi.spyOn(containerManager, 'appContainerRunning').mockImplementation(async () => {
      claimFleetBackupBusy('a');
      return null;
    });
    expect(await pressBack()).toEqual({ success: false, status: 409, error: R11 });
    expect(isFleetBackupBusy('a')).toBe(true);
  });
});
