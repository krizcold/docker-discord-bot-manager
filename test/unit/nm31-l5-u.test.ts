import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-l5-u-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
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
  callAppHook: async () => ({ ok: true, body: { saved: true } }),
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import { claimFleetBackupBusy, releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { KEPT_TEXT, KEPT_TIMING, keptRunningOp, newStartDone, putBackDone, startOnNewDatabase } from '../../src/instance/keptData';
import { resetDocker } from './nm2-docker';
import { clearRegistry } from './nm2-harness';
import { resetRun } from './nm31-run';
import { app, resetSeed, seedMain } from './nm31-seed';
import { answerOrders, bot, fwd, keptAfterStart, pressBack, resetBack, stored } from './nm31-back';
import type { KeptOpRecord } from '../../src/types';

const realSave = containerManager.saveKeptOpIf;
const RUNS = KEPT_TEXT.nRuns('f00dcafe1234');
const SLOT = 'A backup or restore operation is in progress on this database - wait for it to finish';
const CLOSED = `Put back stopped: ${containerManager.KEPT_RECORD_CLOSED}; nothing more was done`;

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

describe('nm31 l5 u: the route of Start on a new database', () => {
  it('an unknown bot while the manager shuts down answers Bot not found', async () => {
    vi.spyOn(containerManager, 'isShuttingDown').mockReturnValue(true);
    expect(await startOnNewDatabase('zz')).toEqual({ success: false, status: 404, error: 'Bot not found' });
  });

  it('shutting down while another operation holds the bot answers the shutdown refusal', async () => {
    await seedMain();
    let release!: () => void;
    const holding = containerManager.withExternalBotOp('a', 'build', () => new Promise<void>(r => { release = r; }));
    vi.spyOn(containerManager, 'isShuttingDown').mockReturnValue(true);
    try {
      expect(await startOnNewDatabase('a')).toEqual({ success: false, status: 503, error: containerManager.SHUTDOWN_REFUSAL });
    } finally {
      release();
      await holding;
    }
  });

  it('the bot is claimed for new-database while the lock is held, and released after', async () => {
    await seedMain();
    let seen: string | null = 'unset';
    vi.spyOn(containerManager, 'withExternalBotOp').mockImplementation(async () => {
      seen = keptRunningOp('a');
      return { success: false, status: 409, error: 'x' } as never;
    });
    await startOnNewDatabase('a');
    expect(seen).toBe('new-database');
    expect(keptRunningOp('a')).toBeNull();
  });

  it('a refusal for the backup slot leaves the slot with its holder', async () => {
    await seedMain();
    expect(claimFleetBackupBusy('a')).toBe(true);
    expect(await startOnNewDatabase('a')).toEqual({ success: false, status: 409, error: SLOT });
    expect(claimFleetBackupBusy('a')).toBe(false);
  });

  it('an unexpected error after which another operation took the bot answers that operation is busy', async () => {
    await seedMain();
    let thrown = false;
    vi.spyOn(containerManager, 'withExternalBotOp').mockImplementation(async () => { thrown = true; throw new Error('boom'); });
    vi.spyOn(containerManager, 'isBotBusy').mockImplementation(() => (thrown ? 'build' : null));
    expect(await startOnNewDatabase('a')).toEqual({ success: false, status: 409, error: "Operation 'build' already in progress" });
  });

  it('an unexpected error answers 500 and logs it', async () => {
    await seedMain();
    vi.spyOn(containerManager, 'withExternalBotOp').mockRejectedValue(new Error('boom'));
    expect(await startOnNewDatabase('a')).toEqual({ success: false, status: 500, error: 'Start on a new database stopped on an unexpected error: boom' });
    expect(console.error).toHaveBeenCalledWith('[KeptData] a: Start on a new database stopped on an unexpected error: boom');
  });

  it('a later unexpected error saves nothing on the record of an earlier run that ended', async () => {
    await keptAfterStart('main');
    vi.spyOn(containerManager, 'withExternalBotOp').mockRejectedValue(new Error('boom'));
    const save = vi.spyOn(containerManager, 'saveKeptOpIf');
    await startOnNewDatabase('a');
    expect(save).not.toHaveBeenCalled();
  });
});

describe('nm31 l5 u: KEPT_TIMING', () => {
  it('the copy waits 60 min and the tar 30 min (design section 4)', () => {
    expect(KEPT_TIMING.copyMs).toBe(3_600_000);
    expect(KEPT_TIMING.tarMs).toBe(1_800_000);
  });
});

describe('nm31 l5 u: the open text of a record when the app runs', () => {
  it('an open put-back answers Put back\'s open text', async () => {
    await keptAfterStart('main');
    let done = false;
    vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation((id, key, patch) => {
      if (!done && patch.step === 'folder') { done = true; throw new Error('the manager stopped here'); }
      return realSave(id, key, patch);
    });
    expect(await pressBack()).toMatchObject({ success: false, open: true });
    app.a = true;
    const answer = await pressBack();
    const rec = stored().keptOp as KeptOpRecord;
    expect(rec.op).toBe('put-back');
    expect(answer).toEqual({ success: false, status: 409, open: true, error: KEPT_TEXT.pOpen(RUNS, putBackDone(rec), false) });
  });

  it('an open forward new-start answers its own open text', async () => {
    await seedMain();
    answerOrders();
    let done = false;
    vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation((id, key, patch) => {
      if (!done && patch.step === 'db-stopped') { done = true; throw new Error('the manager stopped here'); }
      return realSave(id, key, patch);
    });
    expect(await startOnNewDatabase('a')).toMatchObject({ success: false, open: true });
    const rec = stored().keptOp as KeptOpRecord;
    expect(rec).toMatchObject({ op: 'new-start', set: fwd().stamp });
    expect(rec.undo).toBeFalsy();
    app.a = true;
    expect(await pressBack()).toEqual({ success: false, status: 409, open: true, error: KEPT_TEXT.nOpen(RUNS, newStartDone(rec)) });
  });
});

const isBegin = (patch: Partial<KeptOpRecord>) => 'folderGone' in patch && !('step' in patch);

describe('nm31 l5 u: the saves of Put back', () => {
  it('the begin save throws: 500 open, the reason saved and logged', async () => {
    await keptAfterStart('main');
    vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation((id, key, patch) => {
      if (isBegin(patch)) throw new Error('boom');
      return realSave(id, key, patch);
    });
    const answer = await pressBack();
    const rec = stored().keptOp as KeptOpRecord;
    const reason = 'the record could not be saved (boom)';
    expect(rec.lastError).toBe(reason);
    expect(answer).toEqual({ success: false, status: 500, open: true, error: KEPT_TEXT.pOpen(reason, putBackDone(rec), false) });
    expect(console.warn).toHaveBeenCalledWith(`[KeptData] ${bot().displayName}: Put back stopped at step ${rec.step}: ${reason}`);
  });

  it('the begin save and the stop\'s save both throw: the stop is logged as not recorded', async () => {
    await keptAfterStart('main');
    vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation((id, key, patch) => {
      if ('lastError' in patch) throw new Error('boom');
      return realSave(id, key, patch);
    });
    await pressBack();
    expect(console.error).toHaveBeenCalledWith(`[KeptData] ${bot().displayName}: the stop of Put back could not be recorded: boom`);
  });

  it('the begin save finds the record closed: the closed refusal', async () => {
    await keptAfterStart('main');
    vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation((id, key, patch) => {
      if (isBegin(patch)) return containerManager.KEPT_RECORD_CLOSED;
      return realSave(id, key, patch);
    });
    expect(await pressBack()).toEqual({ success: false, status: 409, error: CLOSED });
  });

  it('a step save finds the record closed: the closed refusal', async () => {
    await keptAfterStart('main');
    vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation((id, key, patch) => {
      if (patch.step === 'db-stopped') return containerManager.KEPT_RECORD_CLOSED;
      return realSave(id, key, patch);
    });
    expect(await pressBack()).toEqual({ success: false, status: 409, error: CLOSED });
  });
});
