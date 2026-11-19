import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-l5-aa-'));
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
import * as dbLogin from '../../src/instance/dbLogin';
import * as maintenance from '../../src/instance/maintenance';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { KEPT_TEXT, keptDate, putBack, putBackDone, startOnNewDatabase } from '../../src/instance/keptData';
import { resetDocker } from './nm2-docker';
import { clearRegistry } from './nm2-harness';
import { resetRun, run } from './nm31-run';
import { answerDatabase, app, CONTAINER, COPY_CONTAINER, COPY_VOLUME, dataDirOf, patchRegistry, resetSeed, seedCopy, seedExternal } from './nm31-seed';
import { answerOrders, asideDir, bot, fwd, keptAfterStart, LATER, LATER_STAMP, orders, pressBack, resetBack, stored } from './nm31-back';
import { docker } from './nm2-docker';

const LATER_ISO = new Date(LATER).toISOString();
const DATE = keptDate(fwd().stamp);
const realSave = containerManager.saveKeptOpIf;
const realSwap = containerManager.swapKeptData;
const realOrder = maintenance.runOrderInOp;
const realGetBot = containerManager.getBot;
const CLOSED = `Put back stopped: ${containerManager.KEPT_RECORD_CLOSED}; nothing more was done`;
const orderText = () => (orders[orders.length - 1] as { text: string }).text;

/** The open answer of the stored record with `reason`. */
function opened(reason: string) {
  const rec = stored().keptOp;
  expect(rec.lastError).toBe(reason);
  return { success: false, status: expect.any(Number), open: true, error: KEPT_TEXT.pOpen(reason, putBackDone(rec), !!rec.undo) };
}

/** From the save of `step` on, lstat of the data folder fails with EACCES. */
function lstatFailsAfter(step: string): void {
  let armed = false;
  vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation((id, key, patch) => {
    const r = realSave(id, key, patch);
    if (patch.step === step) armed = true;
    return r;
  });
  const realLstat = fs.lstatSync;
  vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, o?: any) => {
    if (armed && String(p) === dataDirOf('a')) throw Object.assign(new Error('EACCES: permission denied, lstat'), { code: 'EACCES' });
    return realLstat(p, o);
  }) as typeof fs.lstatSync);
}

/** A Put back of the main's kept set left open before P3 (the compose change fails), then reversed: U-a runs. */
async function reversedBeforeSwap(): Promise<void> {
  await keptAfterStart('main');
  const spy = vi.spyOn(containerManager, 'takeFleetDbServicesOut').mockReturnValueOnce({ success: false, error: 'EIO: i/o error' });
  expect(await pressBack()).toMatchObject({ success: false, open: true });
  expect(stored().keptOp.step).toBe('db-stopped');
  spy.mockRestore();
}

const reverse = () => pressBack(fwd().stamp, { reverse: true });

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

describe('nm31 l5 aa: the end of Put back (P7, P8)', () => {
  it('a resume after the settled save reads Off as recorded and orders no Off again', async () => {
    await keptAfterStart('main');
    vi.mocked(maintenance.runOrderInOp).mockImplementationOnce(async (...args) => {
      const r = await realOrder(...args);
      orders.push(r);
      app.a = true;
      return r;
    });
    expect(await pressBack()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.step).toBe('settled');
    app.a = false;
    orders.length = 0;
    const answer = await pressBack();
    expect(orders).toEqual([]);
    expect(answer).toMatchObject({ success: true });
    expect((answer as { text: string }).text.endsWith(' Off is confirmed.')).toBe(true);
  });

  it('docker does not answer whether the app runs at P8: the record stays open with that reason', async () => {
    await keptAfterStart('main');
    vi.mocked(maintenance.runOrderInOp).mockImplementationOnce(async (...args) => {
      const r = await realOrder(...args);
      orders.push(r);
      app.a = null;
      return r;
    });
    expect(await pressBack()).toEqual(opened('docker did not say whether the bot runs'));
    expect(stored().keptOp.step).toBe('settled');
  });

  it('another kept set before the one put aside: the answer names the aside set, the other set is kept whole, the gone volume pruned only from the aside set', async () => {
    const before = await keptAfterStart('main');
    const otherDir = `${dataDirOf('a')}.kept-other`;
    fs.mkdirSync(otherDir);
    fs.writeFileSync(path.join(otherDir, 'state.json'), '{}');
    const other = {
      id: '20261001-000000', keptAt: '2026-10-01T00:00:00.000Z', by: 'new-start', folder: otherDir,
      db: { containerName: CONTAINER, user: before.inst.fleetDb!.user, db: before.inst.fleetDb!.db, volume: 'bota-other-volume', password: before.inst.fleetDb!.password },
    };
    patchRegistry('a', { keptSets: [other, ...bot().keptSets!] });
    run.volumes[fwd().newVolume] = 'absent';
    const answer = await pressBack();
    expect(answer).toEqual({
      success: true,
      text: KEPT_TEXT.pDone({ date: DATE, volume: before.inst.fleetDb!.volume, folder: dataDirOf('a'), asideFolder: asideDir(), orderText: orderText() }),
    });
    expect(bot().keptSets).toEqual([other, { id: LATER_STAMP, keptAt: LATER_ISO, by: 'put-back', folder: asideDir() }]);
  });

  it('a clean run reads the data folder at P8 only for a reverse that found it missing', async () => {
    const before = await keptAfterStart('main');
    lstatFailsAfter('settled');
    const answer = await pressBack();
    expect(answer).toMatchObject({ success: true });
    expect(bot().fleetDb).toEqual(before.inst.fleetDb);
  });

  it('a reverse that found the data folder missing, whose P8 read of it fails, stays open with that reason', async () => {
    await seedExternal('a', { certs: true });
    answerDatabase();
    let done = false;
    run.beforeRename = (from) => {
      if (!done && from === dataDirOf('a')) {
        done = true;
        throw Object.assign(new Error('the manager stopped here'), { code: 'the' });
      }
    };
    expect(await startOnNewDatabase('a')).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.step).toBe('swapped');
    run.beforeRename = null;
    fs.rmSync(dataDirOf('a'), { recursive: true });
    lstatFailsAfter('settled');
    const answer = await putBack('a', fwd().stamp, {});
    expect(stored().keptOp).toMatchObject({ undo: true, step: 'settled', folderMissing: true });
    expect(answer).toEqual(opened('the data folders could not be read (EACCES: permission denied, lstat)'));
  });

  it('a reverse after the folders were exchanged names the data folder put back and says nothing of a missing folder', async () => {
    await keptAfterStart('main');
    let done = false;
    run.beforeRename = (from) => {
      if (!done && from === dataDirOf('a')) {
        done = true;
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
    };
    expect(await pressBack()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.step).toBe('swapped');
    run.beforeRename = null;
    const answer = await reverse();
    expect(answer).toMatchObject({ success: true });
    const text = (answer as { text: string }).text;
    expect(text.startsWith(`Put back. The kept data of ${keptDate(LATER_STAMP)} is in use again: the volume ${fwd().newVolume} and the data folder ${dataDirOf('a')}.`), text).toBe(true);
    expect(text).not.toContain('missing');
  });

  it('the close throws: the record stays open with the run-it-again reason and status 500', async () => {
    await keptAfterStart('main');
    vi.spyOn(containerManager, 'closeKeptOp').mockImplementationOnce(() => { throw new Error('EIO: i/o error'); });
    const answer = await pressBack();
    expect(answer).toEqual(opened('the end could not be recorded (EIO: i/o error); run it again'));
    expect((answer as { status: number }).status).toBe(500);
  });

  it('the close finds the record changed: the closed refusal, not done', async () => {
    await keptAfterStart('main');
    vi.spyOn(containerManager, 'closeKeptOp').mockReturnValueOnce('the record changed');
    expect(await pressBack()).toEqual({ success: false, status: 409, error: CLOSED });
  });

  it('a done Put back logs the sets in use and kept', async () => {
    await keptAfterStart('main');
    expect(await pressBack()).toMatchObject({ success: true });
    expect(vi.mocked(console.log)).toHaveBeenCalledWith(`[KeptData] ${bot().displayName}: Put back done (set ${fwd().stamp} in use, set ${LATER_STAMP} kept)`);
  });
});

describe('nm31 l5 aa: the reverse before the swap (U-a)', () => {
  it('the database service cannot be written: the record stays open with the compose reason', async () => {
    await reversedBeforeSwap();
    vi.spyOn(containerManager, 'writeFleetDbService').mockResolvedValueOnce({ success: false, error: 'EROFS: read-only file system' } as any);
    expect(await reverse()).toEqual(opened("the database's service could not be written into the deployed compose (EROFS: read-only file system)"));
  });

  it('the close throws: the record stays open with the run-it-again reason and status 500', async () => {
    await reversedBeforeSwap();
    vi.spyOn(containerManager, 'closeKeptOp').mockImplementationOnce(() => { throw new Error('EIO: i/o error'); });
    const answer = await reverse();
    expect(answer).toEqual(opened('the end could not be recorded (EIO: i/o error); run it again'));
    expect((answer as { status: number }).status).toBe(500);
  });

  it('the close finds the record changed: the closed refusal, not done', async () => {
    await reversedBeforeSwap();
    vi.spyOn(containerManager, 'closeKeptOp').mockReturnValueOnce('the record changed');
    expect(await reverse()).toEqual({ success: false, status: 409, error: CLOSED });
  });

  it('a done U-a logs that nothing was swapped', async () => {
    await reversedBeforeSwap();
    expect(await reverse()).toMatchObject({ success: true });
    expect(vi.mocked(console.log)).toHaveBeenCalledWith(`[KeptData] ${bot().displayName}: Put back before the earlier data was set aside: nothing was swapped`);
  });

  it('an Off order that does not settle is the answer\'s warning', async () => {
    await reversedBeforeSwap();
    vi.mocked(dbLogin.blockBotLogin).mockResolvedValue({ ok: false, cls: 'other', error: 'permission denied to alter role' });
    const answer = await reverse();
    expect(orderText()).toMatch(/permission denied to alter role/);
    expect(answer).toEqual({ success: true, text: KEPT_TEXT.uNothing(orderText()), warning: orderText() });
  });

  it('the bot is removed from the registry after admission: Bot not found', async () => {
    await reversedBeforeSwap();
    let admitted = false;
    vi.mocked(console.log).mockImplementation((line: unknown) => {
      if (String(line).includes('Put back reverses')) admitted = true;
    });
    let after = 0;
    vi.spyOn(containerManager, 'getBot').mockImplementation((id: string) => (admitted && ++after === 2 ? null : realGetBot(id)) as any);
    expect(await reverse()).toEqual({ success: false, status: 404, error: 'Bot not found' });
    expect(after).toBeGreaterThanOrEqual(2);
  });

  it('a live copy reversed before the swap is written and started again', async () => {
    await seedCopy();
    answerOrders();
    run.volumes[COPY_VOLUME] = 'exists';
    vi.mocked(containerManager.appContainerRunning).mockReset().mockResolvedValueOnce(false).mockResolvedValue(true);
    expect(await startOnNewDatabase('a')).toMatchObject({ success: false });
    expect(stored().keptOp).toMatchObject({ op: 'new-start' });
    vi.mocked(containerManager.appContainerRunning).mockReset().mockImplementation(async (id: string) => (id in app ? app[id] : false));
    vi.mocked(Date.now).mockReturnValue(LATER);
    expect(docker.running[COPY_CONTAINER]).not.toBe(true);
    const apply = vi.spyOn(containerManager, 'applyFleetDbReplicaService');
    const answer = await reverse();
    expect(answer).toMatchObject({ success: true });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(docker.running[COPY_CONTAINER]).toBe(true);
  });

  it('a folder-only set reversed before the swap on an instance that holds a live copy starts no copy', async () => {
    await keptAfterStart('folder');
    const replica = {
      containerName: COPY_CONTAINER, volume: COPY_VOLUME, user: 'smdb', db: 'smdb', slot: 's1', primaryHost: 'main.invalid', primaryPort: 15432,
      publicHost: 'copy.example', hostPort: 25432, certHost: COPY_CONTAINER, seededAt: 1,
    };
    patchRegistry('a', { fleetDbReplica: replica });
    vi.spyOn(containerManager, 'swapKeptData').mockImplementationOnce(() => { throw new Error('the manager stopped here'); });
    expect(await pressBack()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.step).toBe('recorded');
    vi.mocked(containerManager.swapKeptData).mockImplementation(realSwap);
    const apply = vi.spyOn(containerManager, 'applyFleetDbReplicaService').mockResolvedValue({ success: false, error: 'not expected' } as any);
    const answer = await reverse();
    expect(answer).toMatchObject({ success: true });
    expect(apply).not.toHaveBeenCalled();
  });
});

