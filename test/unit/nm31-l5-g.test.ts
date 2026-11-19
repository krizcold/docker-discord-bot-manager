import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-l5-g-'));
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
const posix = (p: string) => p.replace(/\\/g, '/');
const botDir = () => path.dirname(dataDirOf('a'));
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
import { fenceOwners } from './fence-fake';

const RETRY = ', then run a restore again with the bot in Maintenance or Off to retry the lift';

/** a's Start on a new database stopped at its login, with b (a fleet bot whose Database URL names a's database) in its sharers. */
async function openWithFleetSharer(): Promise<void> {
  await seedMain('a');
  await seedMain('b');
  envManager.setEnvVars('b', { DATA_BACKEND_URL: envManager.getEnvVars('a').DATA_BACKEND_URL });
  vi.spyOn(fleetBackup, 'runningDatabaseSharers').mockImplementation(async () => ({ bots: [containerManager.getBot('a')!, containerManager.getBot('b')!], unchecked: [] }));
  vi.spyOn(containerManager, 'liveContainerNames').mockImplementation(async () => []);
  answerDatabase();
  db.open = { ok: false, cls: 'other', error: 'the server closed the connection' };
  expect(await startOnNewDatabase('a')).toMatchObject({ success: false, open: true });
  expect(stored().keptOp).toMatchObject({ op: 'new-start', sharers: ['b'] });
}

/** A copy bot whose Start on a new database stopped at its first step (the copy did not stop): the copy record is still held. */
async function openCopyAtStop(): Promise<void> {
  await seedCopy();
  answerDatabase();
  docker.overrides.unshift({ match: a => a[0] === 'stop', answer: { ok: false, stderr: 'Error response from daemon: cannot stop container' } });
  expect(await startOnNewDatabase('a')).toMatchObject({ success: false, open: true });
  docker.overrides.shift();
  expect(stored().keptOp).toMatchObject({ op: 'new-start', step: 'recorded' });
  expect(bot().fleetDbReplica).toBeTruthy();
}

describe('nm31 l5 g: the copy family and the rebuild while a record holds the copy', () => {
  it('the copy family is skipped while the record is open', async () => {
    await openCopyAtStop();
    expect(fleetBackup.fleetBackupStatus(bot()).copy).toMatchObject({ skip: 'kept' });
  });

  it('the automatic rebuild does not start while the record is open', async () => {
    await openCopyAtStop();
    expect(fleetReplica.startAutoRebuild(bot(), 'lost', async () => true)).toEqual({ started: false, reason: gate('a change of its database setup') });
  });
});

describe('nm31 l5 g: the ownership walk', () => {
  it('a folder whose name only contains data.kept- is still walked', async () => {
    await seedMain();
    const other = path.join(botDir(), 'olddata.kept-1');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'notes.txt'), 'x');
    const chowned: string[] = [];
    run.rootOwned = chowned;
    asLinux(() => fixDockerBotOwnership(botDir()));
    run.rootOwned = null;
    const seen = chowned.map(posix);
    expect(seen).toContain(posix(other));
    expect(seen).toContain(posix(path.join(other, 'notes.txt')));
  });
});

describe('nm31 l5 g: a restore on a bot that shares an open record', () => {
  afterEach(() => fenceOwners.clear());
  it('the sharer\'s restore is refused naming a restore of a dump', async () => {
    await openWithFleetSharer();
    const dir = backupDir('b');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'daily-x.dump'), 'x');
    const r = await fleetBackup.restoreFleetBackup('b', 'daily-x.dump');
    expect(r.error).toBe("Bot a's Start on a new database did not finish, and this bot uses the same database, so a restore of a dump is refused until it does (nothing was changed)");
    expect(r.steps.stopped).toEqual([]);
  });

  it('a restore fence found at start names the step that clears each lane', async () => {
    await openWithFleetSharer();
    const ca = containerManager.getBot('a')!.fleetDb!.containerName;
    const cb = containerManager.getBot('b')!.fleetDb!.containerName;
    expect(ca).not.toBe(cb);
    fenceOwners.set(ca, 'restore:1700000000000');
    fenceOwners.set(cb, 'restore:1700000000000');
    docker.overrides.push({ match: a => a.join(' ').includes('SHOW default_transaction_read_only'), answer: { ok: true, stdout: 'on\n' } });
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation((() => 0) as unknown as typeof setInterval);
    fleetBackup.startFleetBackupScheduler();
    spy.mockRestore();
    fleetBackup.stopFleetBackupScheduler();
    await vi.waitFor(() => {
      expect(fleetBackup.getFleetFenceStuck('a')).not.toBeNull();
      expect(fleetBackup.getFleetFenceStuck('b')).not.toBeNull();
    });
    const head = 'The database is READ-ONLY (a write fence was not lifted); whether a restart clears it could not be confirmed (its saved configuration could not be read); it belongs to a restore (started 2023-11-14 22:13 UTC), and ';
    expect(fleetBackup.getFleetFenceStuck('a')).toBe(`${head}finish Start on a new database in the Database window${RETRY}`);
    expect(fleetBackup.getFleetFenceStuck('b')).toBe(`${head}finish the other bot's operation in its Database window${RETRY}`);
  });
});
