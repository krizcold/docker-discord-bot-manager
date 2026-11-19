import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-l5-ac-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, lstatFail: null as null | { path: string; code: string } };
});

vi.mock('child_process', async (importOriginal) => (await import('./nm31-run')).childProcessMock(await importOriginal(), require('fs')));
vi.mock('fs', async (importOriginal) => {
  const m = (await import('./nm31-run')).fsMock(await importOriginal()) as Record<string, any>;
  const base = m.lstatSync;
  const lstatSync = (p: any, o?: any) => {
    if (h.lstatFail && String(p) === h.lstatFail.path) throw Object.assign(new Error(`${h.lstatFail.code}: permission denied, lstat '${String(p)}'`), { code: h.lstatFail.code });
    return base(p, o);
  };
  return { ...m, lstatSync, default: { ...m.default, lstatSync } };
});
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
import * as envManager from '../../src/env/manager';
import * as fleetReplica from '../../src/instance/fleetReplica';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { KEPT_TEXT } from '../../src/instance/keptData';
import { resetDocker } from './nm2-docker';
import { clearRegistry, registryPath, seedBot } from './nm2-harness';
import { resetRun } from './nm31-run';
import { CONTAINER, dataDirOf, offOrder, patchRegistry, resetSeed, SMDB } from './nm31-seed';
import { answerOrders, asideDir, bot, fwd, keptAfterStart, LATER, LATER_STAMP, pressBack, resetBack, stored } from './nm31-back';
import type { KeptOpRecord } from '../../src/types';

const realSave = containerManager.saveKeptOpIf;
const realCreate = containerManager.createKeptOpIf;
const logs = () => vi.mocked(console.log).mock.calls.map(c => c[0]);
const refused = (status: number, error: string) => ({ success: false, status, error });

/** Leaves the put-back record open at db-stopped: the save of db-out throws once, as a manager stopping there. */
function openAtDbStopped(): void {
  let done = false;
  vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation((id, key, patch) => {
    if (!done && patch.step === 'db-out') { done = true; throw new Error('the manager stopped here'); }
    return realSave(id, key, patch);
  });
}

/** The records createKeptOpIf was given. */
function captureCreate(): KeptOpRecord[] {
  const got: KeptOpRecord[] = [];
  vi.spyOn(containerManager, 'createKeptOpIf').mockImplementation((id, rec) => { got.push(structuredClone(rec)); return realCreate(id, rec); });
  return got;
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
  h.lstatFail = null;
});
afterEach(() => {
  h.lstatFail = null;
  releaseFleetBackupBusy('a');
  vi.restoreAllMocks();
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('nm31 l5 ac: Put back admission of an open record', () => {
  it('a first press with Off not settled is refused T-A-UNSETTLED', async () => {
    await keptAfterStart('main', { off: false });
    await offOrder('a', { blockFails: 'role dbm_admin is missing' });
    answerOrders();
    const m = bot().maintenance!;
    expect(m.settled).toBe(false);
    expect(await pressBack()).toEqual(refused(409, KEPT_TEXT.aUnsettled(m.lastError || 'the order has not finished')));
    expect(stored().keptOp).toBeUndefined();
  });

  it('a press on a record open at db-stopped goes on and logs the step', async () => {
    await keptAfterStart('main');
    openAtDbStopped();
    expect(await pressBack()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.step).toBe('db-stopped');
    vi.mocked(console.log).mockClear();
    expect(await pressBack()).toMatchObject({ success: true });
    expect(logs()).toContain('[KeptData] Bot a: Put back goes on from step db-stopped');
  });

  it('the reverse press saves undo, logs it, and a later press of the undo record logs the reverse going on', async () => {
    await keptAfterStart('main');
    openAtDbStopped();
    expect(await pressBack()).toMatchObject({ success: false, open: true });
    vi.mocked(console.log).mockClear();
    let reverseRan = false;
    vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation((id, key, patch) => {
      if (patch.undo) return realSave(id, key, patch);
      reverseRan = true;
      throw new Error('the manager stopped here');
    });
    await pressBack(fwd().stamp, { reverse: true });
    expect(reverseRan).toBe(true);
    expect(logs()).toContain(`[KeptData] Bot a: Put back reverses ${containerManager.keptOpName('put-back')} from step db-stopped`);
    expect(stored().keptOp).toMatchObject({ undo: true, step: 'recorded' });
    vi.mocked(containerManager.saveKeptOpIf).mockRestore();
    vi.mocked(console.log).mockClear();
    await pressBack();
    expect(logs()).toContain(`[KeptData] Bot a: the reverse of ${containerManager.keptOpName('put-back')} goes on from step recorded`);
  });

  it('the reverse press whose undo save throws answers 500 and leaves the record as it was', async () => {
    await keptAfterStart('main');
    openAtDbStopped();
    expect(await pressBack()).toMatchObject({ success: false, open: true });
    const rec = stored().keptOp;
    vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation(() => { throw new Error('EIO: i/o error, write'); });
    expect(await pressBack(fwd().stamp, { reverse: true })).toEqual(refused(500, 'Put back was not recorded, so nothing was changed: EIO: i/o error, write'));
    expect(stored().keptOp).toEqual(rec);
  });

  it('the reverse press whose undo save is refused answers 409 with the reason', async () => {
    await keptAfterStart('main');
    openAtDbStopped();
    expect(await pressBack()).toMatchObject({ success: false, open: true });
    vi.spyOn(containerManager, 'saveKeptOpIf').mockReturnValue('the record changed');
    expect(await pressBack(fwd().stamp, { reverse: true })).toEqual(refused(409, 'Put back was not recorded: the record changed; nothing was changed'));
    expect(stored().keptOp.undo).toBeUndefined();
  });
});

describe('nm31 l5 ac: Put back admission of a kept set', () => {
  it('a live copy set on an instance that is a main is refused T-P-CROSS copy', async () => {
    await keptAfterStart('copy');
    patchRegistry('a', { fleetDbReplica: undefined, fleetDb: { containerName: CONTAINER, volume: 'bota-fleet-postgres-data', user: 'smdb', db: 'smdb', password: '' } });
    expect(bot().fleetDb).toBeTruthy();
    expect(bot().fleetDbReplica).toBeUndefined();
    expect(await pressBack()).toEqual(refused(409, KEPT_TEXT.pCross('copy')));
  });

  it('a database set while the stored Database URL has no host is refused T-P-URL', async () => {
    await keptAfterStart('main');
    envManager.setEnvVars('a', { DATA_BACKEND_URL: 'smdb' });
    expect(await pressBack()).toEqual(refused(409, KEPT_TEXT.pUrl(CONTAINER)));
  });

  it('a folder set is not refused because docker did not list another bot\'s containers', async () => {
    await keptAfterStart('folder');
    seedBot({ sourceUrl: SMDB }, 'b');
    envManager.setEnvVars('b', { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: 'postgresql://smdb:pw@other.example:5432/smdb' });
    vi.spyOn(containerManager, 'liveContainersNow').mockResolvedValue(null);
    expect(await pressBack()).toMatchObject({ success: true });
  });

  it('a data folder not named data is refused', async () => {
    await keptAfterStart('main');
    const other = path.join(path.dirname(dataDirOf('a')), 'other');
    vi.mocked(fleetReplica.instanceDataDir).mockResolvedValue(other);
    expect(await pressBack()).toEqual(refused(409, KEPT_TEXT.aFolder(other, 'its name is not data')));
  });

  it('a folder already at the aside name is refused', async () => {
    await keptAfterStart('main');
    fs.mkdirSync(asideDir());
    expect(await pressBack()).toEqual(refused(409, KEPT_TEXT.aNamesFolder(asideDir())));
  });

  it('an aside name that cannot be read is refused with the read error', async () => {
    await keptAfterStart('main');
    h.lstatFail = { path: asideDir(), code: 'EACCES' };
    expect(await pressBack()).toEqual(refused(409, KEPT_TEXT.aFolder(asideDir(), `EACCES: permission denied, lstat '${asideDir()}'`)));
    expect(stored().keptOp).toBeUndefined();
  });

  it('a kept set already named by the new stamp is refused, with another set beside it', async () => {
    await keptAfterStart('main');
    const reg = JSON.parse(fs.readFileSync(registryPath(), 'utf-8'));
    reg.instances.a.keptSets.push({ id: LATER_STAMP, keptAt: new Date(LATER).toISOString(), by: 'put-back', folder: null });
    fs.writeFileSync(registryPath(), JSON.stringify(reg, null, 2));
    expect(await pressBack()).toEqual(refused(409, KEPT_TEXT.pNamesSet(LATER_STAMP)));
  });

  it('the record names the other bots on the database, not this one, and the log names the sets', async () => {
    await keptAfterStart('main');
    seedBot({ sourceUrl: SMDB }, 'b');
    envManager.setEnvVars('b', { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: envManager.getEnvVars('a').DATA_BACKEND_URL });
    vi.spyOn(containerManager, 'liveContainerNames').mockResolvedValue([]);
    const got = captureCreate();
    vi.mocked(console.log).mockClear();
    await pressBack();
    expect(got).toHaveLength(1);
    expect(got[0].sharers).toEqual(['b']);
    expect(got[0].inDir).toBe(fwd().outDir);
    expect(logs()).toContain(`[KeptData] Bot a: Put back recorded (set ${fwd().stamp}, what is in use becomes ${LATER_STAMP})`);
  });

  it('a folder set records no sharers', async () => {
    await keptAfterStart('folder');
    const got = captureCreate();
    expect(await pressBack()).toMatchObject({ success: true });
    expect(got.map(r => r.sharers)).toEqual([[]]);
  });

  it('a set whose folder is null records an empty inDir', async () => {
    await keptAfterStart('main');
    const reg = JSON.parse(fs.readFileSync(registryPath(), 'utf-8'));
    reg.instances.a.keptSets[0].folder = null;
    fs.writeFileSync(registryPath(), JSON.stringify(reg, null, 2));
    const got = captureCreate();
    await pressBack();
    expect(got.map(r => r.inDir)).toEqual(['']);
  });

  it('a record save that throws answers 500 and opens nothing', async () => {
    await keptAfterStart('main');
    vi.spyOn(containerManager, 'createKeptOpIf').mockImplementation(() => { throw new Error('EIO: i/o error, write'); });
    expect(await pressBack()).toEqual(refused(500, 'Put back was not recorded, so nothing was changed: EIO: i/o error, write'));
    expect(stored().keptOp).toBeUndefined();
  });
});

