import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-gates-'));
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
    listComposeContainers: async () => [],
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
import * as dbLogin from '../../src/instance/dbLogin';
import * as fleetBackup from '../../src/instance/fleetBackup';
import * as fleetReplica from '../../src/instance/fleetReplica';
import * as fleetSwitch from '../../src/instance/fleetSwitch';
import * as maintenance from '../../src/instance/maintenance';
import * as fleetJoin from '../../src/instance/fleetJoin';
import * as repoManager from '../../src/git/repoManager';
import * as terminal from '../../src/webui/terminal';
import { runFleetCopyTick } from '../../src/instance/fleetCopyWatch';
import { fixDockerBotOwnership, grantToApp } from '../../src/templates/pcsProcessing';
import { enableFleetReplication } from '../../src/instance/fleetReplication';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { backupDir, stampOf } from '../../src/instance/backupFiles';
import { newStartNames, startOnNewDatabase } from '../../src/instance/keptData';
import { createBotRoutes } from '../../src/webui/routes/bots';
import { docker, resetDocker } from './nm2-docker';
import { clearRegistry, registryPath, seedBot } from './nm2-harness';
import { resetRun, run } from './nm31-run';
import { app, answerDatabase, COPY_VOLUME, dataDirOf, db, OFF_MESSAGE, offOrder, patchRegistry, resetSeed, seedCopy, seedExternal, seedMain, SMDB, stored, treeOf } from './nm31-seed';
import { answerOrders, bot, keptAfterStart, NOW, resetBack } from './nm31-back';
import { COPY_PEM, FIXTURE_PEM, fakeJoinRecord } from './join-fake';
import type { KeptOpRecord } from '../../src/types';

const names = () => newStartNames({ sanitizedName: 'bota' }, dataDirOf('a'), NOW);
const gate = (what: string) => `Start on a new database did not finish on this bot, so ${what} is refused until it does; open the Database window to run it again; nothing was changed`;
const sharerGate = (action: string) => `Bot a's Start on a new database did not finish, and this bot uses the same database, so ${action} is refused until it does; nothing was changed`;
const envGate = (keys: string) => `Start on a new database did not finish on this bot, so ${keys} cannot change until it does; nothing was changed`;
const KEPT_BY = "it is kept by Bot a's Kept data";
const regText = () => fs.readFileSync(registryPath(), 'utf-8');

let held: Array<Promise<unknown>> = [];
let release: () => void = () => {};
/** Holds the bot's op lock under `op` until release(). */
function hold(id: string, op: string): void {
  const gateP = new Promise<void>(r => { release = r; });
  held.push(containerManager.withExternalBotOp(id, op, () => gateP));
}

/** A main whose Start on a new database stopped at N9 (the login did not open): the record stays open at 'db-up'. */
async function openNewStart(): Promise<void> {
  await seedMain();
  answerDatabase();
  db.open = { ok: false, cls: 'other', error: 'the server closed the connection' };
  expect(await startOnNewDatabase('a')).toMatchObject({ success: false, open: true });
  expect(stored().keptOp).toMatchObject({ op: 'new-start', step: 'db-up' });
}

/** As openNewStart, with bot b on the same database, stopped: A19 records it in the record's sharers. */
async function openWithSharer(): Promise<void> {
  await seedMain();
  seedBot({ sourceUrl: SMDB, status: 'stopped' }, 'b');
  envManager.setEnvVars('b', { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: envManager.getEnvVars('a').DATA_BACKEND_URL });
  vi.spyOn(fleetBackup, 'runningDatabaseSharers').mockImplementation(async () => ({ bots: [containerManager.getBot('a')!, containerManager.getBot('b')!], unchecked: [] }));
  vi.spyOn(containerManager, 'liveContainerNames').mockImplementation(async () => []);
  answerDatabase();
  db.open = { ok: false, cls: 'other', error: 'the server closed the connection' };
  expect(await startOnNewDatabase('a')).toMatchObject({ success: false, open: true });
  expect(stored().keptOp).toMatchObject({ op: 'new-start', sharers: ['b'] });
}

beforeEach(async () => {
  release();
  await Promise.all(held);
  held = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  resetDocker();
  resetRun();
  clearRegistry();
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  resetSeed();
  resetBack();
  maintenance.resetMaintenanceState();
});
afterEach(() => {
  releaseFleetBackupBusy('a');
  vi.restoreAllMocks();
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('nm31 gates: keptOpRefusal at each chained site', () => {
  it('start: Start is refused T-G-start while the record is open', async () => {
    await openNewStart();
    expect(containerManager.startPreflightRefusal('a')).toEqual({ success: false, error: gate('Start') });
  });

  it('build: Build is refused T-G-build', async () => {
    await openNewStart();
    expect(containerManager.buildPreflightRefusal('a')).toEqual({ success: false, error: gate('Update and Build') });
  });

  it('update: Update is refused T-G-build', async () => {
    await openNewStart();
    expect(containerManager.updatePreflightRefusal('a')).toEqual({ success: false, error: gate('Update and Build') });
  });

  it('setup (1 of 2): a rename that changes the project name is refused T-G-setup, the registry unchanged', async () => {
    await openNewStart();
    const before = regText();
    await expect(containerManager.updateBot('a', { displayName: 'Other Name' })).rejects.toThrow(gate('a change of its source or name'));
    expect(regText()).toBe(before);
  });

  it('setup (2 of 2): a source change is refused T-G-setup', async () => {
    await openNewStart();
    const before = regText();
    expect(() => containerManager.reassignSource('a', 'src-1')).toThrow(gate('a change of its source or name'));
    expect(regText()).toBe(before);
  });

  it('order: a state order is refused T-G-order and records no intent', async () => {
    await openNewStart();
    const before = stored().maintenance;
    expect(await maintenance.runMaintenanceOrder('a', 'running', '')).toEqual({ settled: false, text: gate('a state change') });
    expect(stored().maintenance).toEqual(before);
  });

  it('guard: requireMaintenance refuses T-G-guard whatever the caller\'s op', async () => {
    await openNewStart();
    hold('a', 'restore');
    expect(await maintenance.requireMaintenance('a', 'database')).toEqual({ ok: false, error: gate('this') });
  });

  it('db routes (1 of 4): a restore is refused before it stops anything', async () => {
    await openNewStart();
    const dir = backupDir('a');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'daily-x.dump'), 'x');
    const before = regText();
    const r = await fleetBackup.restoreFleetBackup('a', 'daily-x.dump');
    expect(r.error).toBe(`${gate('a change of its database setup').replace(/; nothing was changed$/, '')} (nothing was changed)`);
    expect(r.steps.stopped).toEqual([]);
    expect(regText()).toBe(before);
  });

  it('db routes (2 of 4): replication\'s Enable is refused T-G-db', async () => {
    await openNewStart();
    const before = regText();
    expect(await enableFleetReplication(bot(), 'pub.example')).toEqual({ success: false, error: gate('a change of its database setup') });
    expect(regText()).toBe(before);
  });

  it('db routes (3 of 4): a switch lane is refused T-G-db and its body never runs', async () => {
    await openNewStart();
    const body = vi.fn(async () => ({ success: true, text: 'ran' }));
    expect(await fleetSwitch.runLane('a', 'keep', body)).toEqual({ success: false, text: gate('a change of its database setup'), status: 409 });
    expect(body).not.toHaveBeenCalled();
  });

  it('db routes (4 of 4): decommission is refused T-G-db, the database record kept', async () => {
    await openNewStart();
    const before = regText();
    expect(await fleetReplica.decommissionFleetDb('a')).toEqual({ success: false, error: gate('a change of its database setup') });
    expect(regText()).toBe(before);
  });

  it('Migrate: the Migrate route is refused T-G-db, no migration record opened and the registry unchanged', async () => {
    await openNewStart();
    const before = regText();
    const router = createBotRoutes({ clients: new Set() } as any);
    const layer = (router as any).stack.find((l: any) => l.route?.path === '/:id/migrate' && l.route.methods.post);
    const res: any = { statusCode: 200 };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    await layer.route.stack[layer.route.stack.length - 1].handle({ params: { id: 'a' }, query: {}, body: { to: 'file' } }, res);
    expect({ status: res.statusCode, body: res.body }).toEqual({ status: 409, body: { success: false, error: gate('a change of its database setup') } });
    expect(regText()).toBe(before);
    expect(stored().migrate).toBeUndefined();
  });
});

describe('nm31 gates: the runCore exemption', () => {
  it('runCore: an order under a held \'put-back\' lock passes the gate; under another op it is refused', async () => {
    await openNewStart();
    answerOrders();
    const other = await containerManager.withExternalBotOp('a', 'restore', () => maintenance.runOrderInOp('a', 'off', OFF_MESSAGE, 'restore'));
    expect(other).toEqual({ refused: true, error: gate('a state change') });
    const own = await containerManager.withExternalBotOp('a', 'put-back', () => maintenance.runOrderInOp('a', 'off', OFF_MESSAGE, 'put-back'));
    expect(own).not.toHaveProperty('refused');
    expect(own).toMatchObject({ settled: true });
  });
});

describe('nm31 gates: migrateEnvRefusal', () => {
  it('env (1 of 3): a Database URL change is refused T-G-ENV', async () => {
    await openNewStart();
    expect(containerManager.migrateEnvRefusal('a', { vars: { DATA_BACKEND_URL: 'postgresql://smdb:pw@db.example:5432/smdb' } })).toEqual({ success: false, error: envGate('DATA_BACKEND_URL') });
  });

  it('env (2 of 3): a backend change is refused T-G-ENV', async () => {
    await openNewStart();
    expect(containerManager.migrateEnvRefusal('a', { vars: { DATA_BACKEND: 'file' } })).toEqual({ success: false, error: envGate('DATA_BACKEND') });
  });

  it('env (3 of 3): a PGPORT change and a removal are refused T-G-ENV naming each key', async () => {
    await openNewStart();
    expect(containerManager.migrateEnvRefusal('a', { vars: { PGPORT: '5433' } })).toEqual({ success: false, error: envGate('PGPORT') });
    expect(containerManager.migrateEnvRefusal('a', { vars: { PGPORT: '5433' }, removed: ['DATA_BACKEND'] })).toEqual({ success: false, error: envGate('DATA_BACKEND and PGPORT') });
    expect(containerManager.migrateEnvRefusal('a', { vars: { OTHER: 'x' } })).toBeNull();
  });

  it('env, no migrate record: updateBot refuses the URL change and the store keeps the URL', async () => {
    await openNewStart();
    expect(stored().migrate).toBeUndefined();
    const url = envManager.getEnvVars('a').DATA_BACKEND_URL;
    await expect(containerManager.updateBot('a', { envVars: { DATA_BACKEND_URL: 'postgresql://smdb:pw@db.example:5432/smdb' } })).rejects.toThrow(envGate('DATA_BACKEND_URL'));
    expect(envManager.getEnvVars('a').DATA_BACKEND_URL).toBe(url);
  });
});

describe('nm31 gates: keptSharerRefusal', () => {
  it('sharer (1 of 4): the sharer\'s Start is refused T-G-SHARER', async () => {
    await openWithSharer();
    expect(containerManager.startPreflightRefusal('b')).toEqual({ success: false, error: sharerGate('Start') });
  });

  it('sharer (2 of 4): the sharer\'s Update is refused T-G-SHARER', async () => {
    await openWithSharer();
    expect(containerManager.updatePreflightRefusal('b')).toEqual({ success: false, error: sharerGate('Update') });
  });

  it('sharer (3 of 4): the sharer\'s Build preflight is refused T-G-SHARER', async () => {
    await openWithSharer();
    expect(containerManager.buildPreflightRefusal('b')).toEqual({ success: false, error: sharerGate('Build') });
  });

  it('sharer (4 of 4): a state order on the sharer is refused T-G-SHARER and records no intent', async () => {
    await openWithSharer();
    expect(await maintenance.runMaintenanceOrder('b', 'maintenance', 'Back soon')).toEqual({ settled: false, text: sharerGate('a state change') });
    expect(stored('b').maintenance).toBeUndefined();
  });
});

describe('nm31 gates: sharedVolumeReason', () => {
  it('volume (1 of 4): the instance\'s own kept volume is refused to itself', async () => {
    const before = await keptAfterStart('main', { off: false });
    expect(containerManager.sharedVolumeReason(before.inst.fleetDb!.volume, 'a')).toBe(KEPT_BY);
  });

  it('volume (2 of 4): another instance\'s kept volume is refused', async () => {
    const before = await keptAfterStart('main', { off: false });
    seedBot({ sourceUrl: SMDB }, 'b');
    expect(containerManager.sharedVolumeReason(before.inst.fleetDb!.volume, 'b')).toBe(KEPT_BY);
  });

  it('volume (3 of 4): an open record\'s new volume is refused before the swap names it', async () => {
    await seedMain();
    answerDatabase();
    let stopped = false;
    vi.spyOn(containerManager, 'stopContainerExact').mockImplementation(async () => {
      stopped = true;
      return { ok: false, error: 'Cannot connect to the Docker daemon' };
    });
    expect(await startOnNewDatabase('a')).toMatchObject({ success: false, open: true });
    expect(stopped).toBe(true);
    expect(stored().keptOp).toMatchObject({ step: 'recorded', newVolume: names().newVolume });
    expect(stored().fleetDb.volume).not.toBe(names().newVolume);
    expect(containerManager.sharedVolumeReason(names().newVolume, 'b')).toBe(KEPT_BY);
  });

  it('volume (4 of 4): exceptSet leaves out only that set of the calling instance', async () => {
    const before = await keptAfterStart('main', { off: false });
    const set = names().stamp;
    seedBot({ sourceUrl: SMDB }, 'b');
    expect(containerManager.sharedVolumeReason(before.inst.fleetDb!.volume, 'a', { exceptSet: set })).toBeNull();
    expect(containerManager.sharedVolumeReason(before.inst.fleetDb!.volume, 'b', { exceptSet: set })).toBe(KEPT_BY);
    expect(containerManager.sharedVolumeReason(before.inst.fleetDb!.volume, 'a', { exceptSet: 'another' })).toBe(KEPT_BY);
  });
});

describe('nm31 gates: instance delete', () => {
  it.each([true, false])('delete with keepData %s is refused T-G-DELETE while a set is kept', async (keepData) => {
    await keptAfterStart('folder', { off: false });
    expect(await fleetReplica.instanceRemovalRefusal(bot(), keepData, true)).toEqual({
      error: 'This bot keeps earlier data (1 under Kept data in its Database window); put back or delete each first; nothing was changed',
    });
  });
});

describe('nm31 gates: replicaRecordFor', () => {
  it('replicaRecordFor (1 of 2): with the default copy volume kept, a new copy takes a stamped volume name', async () => {
    await keptAfterStart('copy', { off: false });
    expect(bot().keptSets?.[0].copy?.volume).toBe(COPY_VOLUME);
    const stamped = `${COPY_VOLUME}-${stampOf(Date.now())}`;
    run.volumes[stamped] = 'exists';
    const r = fleetReplica.provisionFleetReplica(bot(), undefined);
    expect(r).toMatchObject({ success: false, needsConfirm: true, confirmVolume: stamped });
    expect(bot().fleetDbReplica).toBeUndefined();
  });

  it('replicaRecordFor (2 of 2): with nothing kept, a new copy takes the default volume name', async () => {
    await seedExternal();
    patchRegistry('a', { fleetJoin: fakeJoinRecord() });
    run.volumes[COPY_VOLUME] = 'exists';
    const r = fleetReplica.provisionFleetReplica(bot(), undefined);
    expect(r).toMatchObject({ success: false, needsConfirm: true, confirmVolume: COPY_VOLUME });
  });
});

describe('nm31 gates: the skips', () => {
  it('reconcileBot skips a bot with an open record: the open login of the new database is not blocked', async () => {
    await seedMain();
    answerDatabase();
    run.afterRename = (from) => { if (from === names().inDir) app.a = true; };
    expect(await startOnNewDatabase('a')).toMatchObject({ success: false, open: true });
    expect(stored().keptOp).toMatchObject({ step: 'login' });
    vi.spyOn(dbLogin, 'sidecarRunning').mockResolvedValue(true);
    const block = vi.spyOn(dbLogin, 'blockBotLogin').mockResolvedValue({ ok: true });
    await maintenance.reconcileMaintenance();
    await maintenance.reconcileMaintenance();
    expect(block).not.toHaveBeenCalled();
  });

  it('familyPlan skips a family while the record is open: no scheduled dump of a database set aside', async () => {
    await openNewStart();
    expect(fleetBackup.fleetBackupStatus(bot()).main).toMatchObject({ skip: 'kept' });
  });
});

describe('nm31 gates: a delete record', () => {
  it('a delete record does not gate Start, Stop or an order', async () => {
    await keptAfterStart('main', { off: false });
    const set = names().stamp;
    const del: KeptOpRecord = {
      op: 'delete', set, stamp: '2026-11-17T12-30-00-000Z', startedAt: '2026-11-17T12:30:00.000Z', parts: ['db', 'folder'],
      dataDir: dataDirOf('a'), outDir: '', inDir: '', offMessage: '', sharers: [], step: 'recorded',
    };
    expect(containerManager.createKeptOpIf('a', del)).toBeNull();
    for (const key of ['start', 'build', 'order', 'setup', 'db', 'files', 'guard'] as const) expect(containerManager.keptOpRefusal('a', key)).toBeNull();
    expect(containerManager.startPreflightRefusal('a')).toBeNull();
    expect(containerManager.migrateEnvRefusal('a', { vars: { DATA_BACKEND: 'file' } })).toBeNull();
    answerOrders();
    await offOrder('a');
    expect(stored().maintenance).toMatchObject({ state: 'off', settled: true });
    expect(stored().keptOp).toEqual(del);
  });
});

const CERTS_TEXT = 'the certificate files were not written: Start on a new database or Put back is open on this bot, and the next refresh after it writes them';
const filesGate = (p: string) => `${p} is kept data of this bot (Kept data in its Database window), and the Files panel does not change it; nothing was changed`;
const posix = (p: string) => p.replace(/\\/g, '/');
const botDir = () => path.dirname(dataDirOf('a'));

/** A file symlink, where this session may make one (Windows needs a privilege this session can lack). */
const FILE_LINKS = (() => {
  const d = fs.mkdtempSync(path.join(h.dir, 'link-probe-'));
  try {
    fs.writeFileSync(path.join(d, 'f'), 'x');
    fs.symlinkSync('f', path.join(d, 'l'));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
})();

/** A folder link: a symlink, or on Windows without the privilege a junction, which realpath resolves the same way. */
function linkFolder(target: string, at: string): void {
  try {
    fs.symlinkSync(target, at, 'dir');
  } catch (err) {
    if (process.platform !== 'win32') throw err;
    fs.symlinkSync(target, at, 'junction');
  }
}

/** Runs fn as on the Linux manager: the ownership walks return at once on win32. */
function asLinux<T>(fn: () => T): T {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...real, value: 'linux' });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
}

/** A Start on a new database whose N10 read the app running after the move-in: the record stays open at 'folder'. */
async function openAtFolder(seed: () => Promise<void>): Promise<void> {
  await seed();
  answerDatabase();
  run.afterRename = (from) => { if (from === names().inDir) app.a = true; };
  expect(await startOnNewDatabase('a')).toMatchObject({ success: false, open: true });
  run.afterRename = null;
  expect(stored().keptOp).toMatchObject({ op: 'new-start', step: 'folder' });
}

/** A kept folder made by a forward run of the folder variant, under a Files base that holds the data folder beside it (the CasaOS layout: the app folder). */
async function keptUnderFilesBase(): Promise<string> {
  await keptAfterStart('folder', { off: false });
  vi.spyOn(repoManager, 'getDataPath').mockReturnValue(botDir());
  const kept = path.basename(names().outDir);
  expect(fs.existsSync(path.join(botDir(), kept, 'state.json'))).toBe(true);
  return kept;
}

describe('nm31 gates: part 7, the gates in the other files', () => {
  it('writeCertFiles writes nothing during the record: it answers T-G-CERTS and logs it', async () => {
    await openNewStart();
    const dataBefore = treeOf(dataDirOf('a'));
    const keptBefore = treeOf(names().outDir);
    expect(await fleetJoin.writeCertFiles(bot(), [FIXTURE_PEM, COPY_PEM])).toBe(CERTS_TEXT);
    expect(treeOf(dataDirOf('a'))).toEqual(dataBefore);
    expect(treeOf(names().outDir)).toEqual(keptBefore);
    expect(fs.existsSync(path.join(dataDirOf('a'), 'db-certs'))).toBe(false);
    expect(console.warn).toHaveBeenCalledWith(`[FleetCopy] ${bot().displayName}: ${CERTS_TEXT}`);
  });

  it('watched: the copy watch leaves a joined bot alone while the record is open, and looks after it again after the close', async () => {
    await openAtFolder(() => seedCopy());
    const envList = vi.spyOn(fleetJoin, 'writeEnvList').mockResolvedValue({ changed: false });
    const refresh = vi.spyOn(fleetJoin, 'refreshJoin').mockResolvedValue(undefined);
    const before = regText();
    const env = envManager.getEnvVars('a');
    docker.calls.length = 0;
    await runFleetCopyTick(NOW + 2 * 3_600_000);
    expect(envList).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(docker.calls).toEqual([]);
    expect(regText()).toBe(before);
    expect(envManager.getEnvVars('a')).toEqual(env);
    app.a = false;
    expect(await startOnNewDatabase('a')).toMatchObject({ success: true });
    await runFleetCopyTick(NOW + 2 * 3_600_000);
    expect(envList).toHaveBeenCalledWith('a');
    expect(refresh).toHaveBeenCalled();
  });

  it('ownership (1 of 2): fixDockerBotOwnership hands root-owned files to the app and skips the kept folder', async () => {
    await keptAfterStart('folder', { off: false });
    const kept = names().outDir;
    expect(fs.existsSync(path.join(kept, 'state.json'))).toBe(true);
    const chowned: string[] = [];
    run.rootOwned = chowned;
    asLinux(() => fixDockerBotOwnership(botDir()));
    run.rootOwned = null;
    const seen = chowned.map(posix);
    expect(seen).toContain(posix(path.join(dataDirOf('a'), 'maintenance.json')));
    expect(seen).toContain(posix(botDir()));
    expect(seen.filter(p => p.startsWith(posix(kept)))).toEqual([]);
  });

  it('ownership (2 of 2): grantToApp recursive skips a new data folder an open record built', async () => {
    await seedExternal('a', { certs: true });
    answerDatabase();
    run.beforeRename = (from) => { if (from === dataDirOf('a')) throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' }); };
    expect(await startOnNewDatabase('a')).toMatchObject({ success: false, open: true });
    run.beforeRename = null;
    const inDir = names().inDir;
    expect(fs.existsSync(path.join(inDir, 'maintenance.json'))).toBe(true);
    const chowned: string[] = [];
    run.rootOwned = chowned;
    asLinux(() => grantToApp(botDir(), { recursive: true }));
    run.rootOwned = null;
    const seen = chowned.map(posix);
    expect(seen).toContain(posix(path.join(dataDirOf('a'), 'state.json')));
    expect(seen.filter(p => p.startsWith(posix(inDir)))).toEqual([]);
  });

  it('files (1 of 6): a write into a kept folder is refused T-G-FILES, the file unchanged', async () => {
    const kept = await keptUnderFilesBase();
    const before = treeOf(names().outDir);
    expect(await terminal.fsWrite('a', 'host', `${kept}/state.json`, '{"changed":true}')).toEqual({ success: false, error: filesGate(posix(path.join(botDir(), kept, 'state.json'))) });
    expect(treeOf(names().outDir)).toEqual(before);
  });

  it('files (2 of 6): a create in a kept folder is refused T-G-FILES', async () => {
    const kept = await keptUnderFilesBase();
    const before = treeOf(names().outDir);
    expect(await terminal.fsCreate('a', 'host', `${kept}/new.txt`)).toEqual({ success: false, error: filesGate(posix(path.join(botDir(), kept, 'new.txt'))) });
    expect(treeOf(names().outDir)).toEqual(before);
  });

  it('files (3 of 6): a mkdir in a kept folder is refused T-G-FILES', async () => {
    const kept = await keptUnderFilesBase();
    const before = treeOf(names().outDir);
    expect(await terminal.fsMkdir('a', 'host', `${kept}/sub/deeper`)).toEqual({ success: false, error: filesGate(posix(path.join(botDir(), kept, 'sub', 'deeper'))) });
    expect(treeOf(names().outDir)).toEqual(before);
  });

  it('files (4 of 6): a delete of a kept file or of the kept folder itself is refused T-G-FILES', async () => {
    const kept = await keptUnderFilesBase();
    const before = treeOf(names().outDir);
    expect(await terminal.fsDelete('a', 'host', `${kept}/state.json`)).toEqual({ success: false, error: filesGate(posix(path.join(botDir(), kept, 'state.json'))) });
    expect(await terminal.fsDelete('a', 'host', kept)).toEqual({ success: false, error: filesGate(posix(path.join(botDir(), kept))) });
    expect(treeOf(names().outDir)).toEqual(before);
  });

  it('files (5 of 6): a rename out of a kept folder is refused T-G-FILES, both places unchanged', async () => {
    const kept = await keptUnderFilesBase();
    const before = treeOf(names().outDir);
    const data = treeOf(dataDirOf('a'));
    expect(await terminal.fsRename('a', 'host', `${kept}/state.json`, 'data/state.json')).toEqual({ success: false, error: filesGate(posix(path.join(botDir(), kept, 'state.json'))) });
    expect(treeOf(names().outDir)).toEqual(before);
    expect(treeOf(dataDirOf('a'))).toEqual(data);
  });

  it('files (6 of 6): a rename into a kept folder is refused T-G-FILES, both places unchanged', async () => {
    const kept = await keptUnderFilesBase();
    const before = treeOf(names().outDir);
    const data = treeOf(dataDirOf('a'));
    expect(await terminal.fsRename('a', 'host', 'data/maintenance.json', `${kept}/maintenance.json`)).toEqual({ success: false, error: filesGate(posix(path.join(botDir(), kept, 'maintenance.json'))) });
    expect(treeOf(names().outDir)).toEqual(before);
    expect(treeOf(dataDirOf('a'))).toEqual(data);
  });

  it('files, a link in data/: a write through a folder link into the kept folder is refused, the kept file unchanged', async () => {
    const kept = await keptUnderFilesBase();
    linkFolder(path.join(botDir(), kept), path.join(dataDirOf('a'), 'old'));
    const before = treeOf(names().outDir);
    const real = posix(path.join(fs.realpathSync(path.join(botDir(), kept)), 'state.json'));
    expect(await terminal.fsWrite('a', 'host', 'data/old/state.json', '{"changed":true}')).toEqual({ success: false, error: filesGate(real) });
    expect(await terminal.fsMkdir('a', 'host', 'data/old/sub')).toMatchObject({ success: false, error: expect.stringContaining('is kept data of this bot') });
    expect(treeOf(names().outDir)).toEqual(before);
  });

  it.skipIf(!FILE_LINKS)('files, a link as the final name (skipped where this session cannot make a file symlink, as on Windows without the privilege; the Linux suite runs it): a save to data/notes.json pointing at a kept file is refused, the kept file unchanged', async () => {
    const kept = await keptUnderFilesBase();
    fs.symlinkSync(path.join('..', kept, 'state.json'), path.join(dataDirOf('a'), 'notes.json'));
    const before = treeOf(names().outDir);
    const real = posix(fs.realpathSync(path.join(botDir(), kept, 'state.json')));
    expect(await terminal.fsWrite('a', 'host', 'data/notes.json', '{"changed":true}')).toEqual({ success: false, error: filesGate(real) });
    expect(treeOf(names().outDir)).toEqual(before);
  });
});
