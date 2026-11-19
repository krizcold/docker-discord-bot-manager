import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-l5-z-'));
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
import * as maintenance from '../../src/instance/maintenance';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { KEPT_TEXT, keptDate, putBackDone } from '../../src/instance/keptData';
import { docker, resetDocker } from './nm2-docker';
import { clearRegistry, registryPath } from './nm2-harness';
import { resetRun } from './nm31-run';
import { app, COPY_VOLUME, dataDirOf, patchRegistry, resetSeed } from './nm31-seed';
import { asideDir, fwd, keptAfterStart, orders, pressBack, resetBack, stored } from './nm31-back';

const DATE = keptDate(fwd().stamp);
const realSave = containerManager.saveKeptOpIf;
const realSwap = containerManager.swapKeptData;
const realOrder = maintenance.runOrderInOp;
const orderText = (i = orders.length - 1) => (orders[i] as { text: string }).text;

function opened(reason: string) {
  const rec = stored().keptOp;
  expect(rec.lastError).toBe(reason);
  return { success: false, status: 409, open: true, error: KEPT_TEXT.pOpen(reason, putBackDone(rec)) };
}

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

/** Runs `then` once right after the real swap of P3 saved. */
function afterSwap(then: () => void): void {
  vi.spyOn(containerManager, 'swapKeptData').mockImplementation((...args) => {
    const r = realSwap(...args);
    then();
    return r;
  });
}

function copyStreams(row: string): void {
  docker.overrides.unshift({ match: a => a[0] === 'exec' && a.join(' ').includes('pg_is_in_recovery'), answer: { ok: true, stdout: `${row}\n` } });
}

/** After P3 the aside name is taken and the data folder holds files the run did not write. */
function notOursAfterSwap(names: string[], then: () => void = () => {}): void {
  afterSwap(() => {
    fs.mkdirSync(asideDir(), { recursive: true });
    fs.writeFileSync(path.join(asideDir(), 'x'), 'x');
    for (const n of names) fs.writeFileSync(path.join(dataDirOf('a'), n), n);
    then();
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
  resetSeed();
  resetBack();
  h.hookBodies.length = 0;
});
afterEach(() => {
  releaseFleetBackupBusy('a');
  vi.restoreAllMocks();
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('nm31 l5 z: P3 and the folder loop', () => {
  it('P3: a swap that finds the record closed answers the closed refusal and moves no folder', async () => {
    await keptAfterStart('folder');
    vi.spyOn(containerManager, 'swapKeptData').mockReturnValue(containerManager.KEPT_RECORD_CLOSED);
    const renames: string[] = [];
    const realRename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => { if (String(from) === dataDirOf('a') || String(from) === fwd().outDir) renames.push(String(from)); realRename(from, to); });
    expect(await pressBack()).toEqual({ success: false, status: 409, error: `Put back stopped: ${containerManager.KEPT_RECORD_CLOSED}; nothing more was done` });
    expect(renames).toEqual([]);
  });

  it('P4/P5: renames that leave the folders as they were stop after four rounds with the end-state text', async () => {
    await keptAfterStart('folder');
    let outs = 0;
    let all = 0;
    const real = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from) === dataDirOf('a') || String(from) === fwd().outDir) {
        if (++all > 20) throw new Error('rename loop guard');
        if (String(from) === dataDirOf('a')) outs++;
        return;
      }
      real(from, to);
    });
    expect(await pressBack()).toEqual(opened('the data folders did not reach the end state of this put back'));
    expect(outs).toBe(4);
    expect(stored().keptOp.step).toBe('swapped');
  });

  it('P4: the data folder cannot be read: the open names the read error', async () => {
    await keptAfterStart('folder');
    const realLstat = fs.lstatSync;
    let armed = false;
    afterSwap(() => { armed = true; });
    vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, o?: any) => {
      if (armed && String(p) === dataDirOf('a')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return realLstat(p, o);
    }) as any);
    expect(await pressBack()).toEqual(opened('the data folders could not be read (EACCES: permission denied)'));
  });

  it('P4: a data folder with files the run did not write opens with its first five names sorted', async () => {
    await keptAfterStart('folder');
    notOursAfterSwap(['g1', 'b1', 'f1', 'a1', 'e1', 'c1', 'd1']);
    const realReaddir = fs.readdirSync;
    vi.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike, o?: any) => {
      const r = realReaddir(p, o) as unknown[];
      return String(p) === dataDirOf('a') && !o ? [...r].reverse() : r;
    }) as any);
    const answer = await pressBack();
    const expected = [...realReaddir(dataDirOf('a'))].sort().slice(0, 5);
    expect(expected).toHaveLength(5);
    expect([...realReaddir(dataDirOf('a'))].length).toBeGreaterThan(5);
    expect(answer).toEqual(opened(`the data folder holds files this run did not write (${expected.join(', ')})`));
  });

  it('P4: the names of a data folder that cannot be listed any more are left empty', async () => {
    await keptAfterStart('folder');
    let armed = false;
    let reads = 0;
    notOursAfterSwap(['z1'], () => { armed = true; });
    const realReaddir = fs.readdirSync;
    vi.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike, o?: any) => {
      if (armed && String(p) === dataDirOf('a') && !o && ++reads === 2) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return realReaddir(p, o);
    }) as any);
    expect(await pressBack()).toEqual(opened('the data folder holds files this run did not write ()'));
    expect(reads).toBe(2);
  });
});

describe('nm31 l5 z: the folder save and P6', () => {
  it('a set without a folder saves the folder step with no folderMissing', async () => {
    await keptAfterStart('main');
    const reg = JSON.parse(fs.readFileSync(registryPath(), 'utf-8'));
    reg.instances.a.keptSets[0].folder = null;
    fs.writeFileSync(registryPath(), JSON.stringify(reg, null, 2));
    const patches: Array<Record<string, unknown>> = [];
    vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation((id, key, patch) => {
      patches.push({ ...patch });
      return realSave(id, key, patch);
    });
    expect(await pressBack()).toMatchObject({ success: true });
    expect(patches.filter(p => p.step === 'folder')).toEqual([{ step: 'folder' }]);
  });

  it('a folder exchanged in full says so in a later open, never that it was found missing', async () => {
    await keptAfterStart('main');
    vi.mocked(maintenance.runOrderInOp).mockImplementationOnce(async (...args) => {
      const r = await realOrder(...args);
      orders.push(r);
      app.a = true;
      return r;
    });
    const answer = await pressBack() as { error: string };
    expect(stored().keptOp.folderMissing).toBeUndefined();
    expect(answer.error).toContain('the data folders were exchanged');
    expect(answer.error).not.toContain('found missing');
  });

  it('a resume from db-in does not write the database service again', async () => {
    await keptAfterStart('main');
    crashOnStep('settled');
    expect(await pressBack()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.step).toBe('db-in');
    vi.mocked(containerManager.saveKeptOpIf).mockRestore();
    const write = vi.spyOn(containerManager, 'writeFleetDbService');
    expect(await pressBack()).toMatchObject({ success: true });
    expect(write).not.toHaveBeenCalled();
  });

  it('a live copy set writes no database service', async () => {
    await keptAfterStart('copy');
    copyStreams('t|streaming|t|0.5');
    const write = vi.spyOn(containerManager, 'writeFleetDbService');
    expect(await pressBack()).toMatchObject({ success: true });
    expect(write).not.toHaveBeenCalled();
  });

  it('a live copy resumed after P6 still says where the copy streams from', async () => {
    await keptAfterStart('copy');
    copyStreams('t|streaming|t|0.5');
    crashOnStep('settled');
    expect(await pressBack()).toMatchObject({ success: false, open: true });
    vi.mocked(containerManager.saveKeptOpIf).mockRestore();
    const answer = await pressBack();
    expect(answer).toEqual({
      success: true,
      text: KEPT_TEXT.pDone({ date: DATE, copyVolume: COPY_VOLUME, folder: dataDirOf('a'), asideFolder: asideDir(), copy: { streams: 'main.invalid:15432' }, orderText: orderText() }),
    });
  });

  it('a folder-only set on a live copy instance gives no copy note', async () => {
    await keptAfterStart('copy');
    const copy = stored().keptSets[0].copy;
    expect(copy).toBeTruthy();
    expect(containerManager.dropKeptPart('a', fwd().stamp, 'copy')).toBeNull();
    patchRegistry('a', { fleetDbReplica: copy });
    expect(containerManager.getBot('a')!.fleetDbReplica).toBeTruthy();
    copyStreams('t|streaming|t|0.5');
    const answer = await pressBack();
    expect(answer).toEqual({
      success: true,
      text: KEPT_TEXT.pDone({ date: DATE, folder: dataDirOf('a'), asideFolder: asideDir(), orderText: orderText() }),
    });
  });
});
