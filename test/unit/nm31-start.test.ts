import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-start-'));
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
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import * as dbLogin from '../../src/instance/dbLogin';
import * as fleetBackup from '../../src/instance/fleetBackup';
import * as maintenance from '../../src/instance/maintenance';
import { claimFleetBackupBusy, releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { KEPT_TEXT, keptRunningOp, newStartDone, newStartNames, putBack, startOnNewDatabase } from '../../src/instance/keptData';
import { docker, resetDocker } from './nm2-docker';
import { clearRegistry, registryPath, seedBot } from './nm2-harness';
import { resetRun, run } from './nm31-run';
import {
  app, answerDatabase, composePathOf, COPY_CONTAINER, COPY_VOLUME, CONTAINER, dataDirOf, db, OFF_MESSAGE, offOrder, psqlAnswer, resetSeed,
  pageOpenLine, seedCopy, seedExternal, seedMain, SMDB, stored, treeOf,
} from './nm31-seed';
import { writeCertFiles } from '../../src/instance/fleetJoin';
import { COPY_PEM, FIXTURE_PEM } from './join-fake';
import type { InstanceConfig } from '../../src/types';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const ISO = new Date(NOW).toISOString();
const names = () => newStartNames({ sanitizedName: 'bota' }, dataDirOf('a'), NOW);
const RUNS = KEPT_TEXT.nRuns('f00dcafe1234');
const NO_ANSWER = 'docker did not say whether the bot runs';
const realSave = containerManager.saveKeptOpIf;
const realSwap = containerManager.swapKeptData;
const realClose = containerManager.closeKeptOp;

const bot = (): InstanceConfig => containerManager.getBot('a')!;
const urlPassword = () => decodeURIComponent(new URL(envUrl()).password);
function envUrl(): string {
  return envManager.getEnvVars('a').DATA_BACKEND_URL;
}

type Snapshot = { inst: InstanceConfig; folder: Record<string, string>; compose: string };
const snapshot = (): Snapshot => ({ inst: bot(), folder: treeOf(dataDirOf('a')), compose: fs.existsSync(composePathOf('a')) ? fs.readFileSync(composePathOf('a'), 'utf-8') : '' });

async function press() {
  return startOnNewDatabase('a');
}

/** The open answer for `reason`, with the steps the stored record reached and the folder steps `onDisk` the disk shows. */
function opened(reason: string | RegExp, onDisk: string[] = []) {
  const rec = stored().keptOp;
  expect(rec).toBeTruthy();
  expect(rec.lastError).toEqual(typeof reason === 'string' ? reason : expect.stringMatching(reason));
  const text = KEPT_TEXT.nOpen(rec.lastError, [...newStartDone(rec), ...onDisk]);
  return { success: false, status: expect.any(Number), open: true, error: text };
}

function composeOf(): any {
  return YAML.parse(fs.readFileSync(composePathOf('a'), 'utf-8'));
}

const changing = () => docker.calls.filter(a => a[0] === 'stop' || (a[0] === 'sh' && !/ pg_isready /.test(a[1])));

function maintenanceJson(): unknown {
  return JSON.stringify({ state: 'maintenance', message: OFF_MESSAGE, since: ISO }, null, 2);
}

/** The end state of a clean run of the main variant, from the snapshot taken before it. */
function expectMainDone(before: Snapshot, answer: unknown): void {
  const n = names();
  const oldDb = before.inst.fleetDb!;
  expect(answer).toEqual({
    success: true,
    text: KEPT_TEXT.nDoneMain({ old: oldDb.volume, outDir: n.outDir, newVolume: n.newVolume, certs: false, replication: false, sharers: null }),
  });
  const after = bot();
  expect(after.maintenance).toEqual({
    state: 'running', message: '', orderedAt: ISO, settled: true, hook: 'not-sent', login: 'open', savedByBot: null,
    prior: { state: 'off', message: OFF_MESSAGE },
  });
  expect(after.keptSets).toEqual([{ id: n.stamp, keptAt: n.startedAt, by: 'new-start', folder: n.outDir, db: oldDb }]);
  expect(after.fleetDb).toEqual({ containerName: CONTAINER, user: oldDb.user, db: oldDb.db, volume: n.newVolume, password: urlPassword() });
  expect(after.keptOp).toBeUndefined();
  expect(after.keptLast).toEqual({ op: 'new-start', set: n.stamp, outcome: 'done', text: (answer as { text: string }).text, at: ISO });
  expect(treeOf(n.outDir)).toEqual(before.folder);
  expect(treeOf(dataDirOf('a'))).toEqual({ 'maintenance.json': maintenanceJson() });
  expect(fs.existsSync(n.inDir)).toBe(false);
  const svc = composeOf().services['fleet-postgres'];
  expect(svc.container_name).toBe(CONTAINER);
  expect(svc.environment.POSTGRES_PASSWORD).toBe(urlPassword());
  expect(composeOf().volumes['fleet-postgres-data']).toEqual({ name: n.newVolume });
  expect(svc.ports).toBeUndefined();
  expect(keptRunningOp('a')).toBeNull();
  expect(containerManager.isBotBusy('a')).toBeNull();
}

function expectCopyDone(before: Snapshot, answer: unknown): void {
  const n = names();
  expect(answer).toEqual({ success: true, text: KEPT_TEXT.nDoneCopy({ volume: COPY_VOLUME, outDir: n.outDir, certs: true }) });
  const after = bot();
  expect(after.maintenance).toMatchObject({ state: 'running', settled: true, hook: 'not-sent', login: 'not-managed', savedByBot: null, prior: { state: 'off', message: OFF_MESSAGE } });
  expect(after.keptSets).toEqual([{ id: n.stamp, keptAt: n.startedAt, by: 'new-start', folder: n.outDir, copy: before.inst.fleetDbReplica, join: before.inst.fleetJoin }]);
  expect(after.fleetDbReplica).toBeUndefined();
  expect(after.fleetJoin).toEqual(before.inst.fleetJoin);
  expect(after.keptOp).toBeUndefined();
  expect(treeOf(n.outDir)).toEqual(before.folder);
  const certs = Object.fromEntries(Object.entries(before.folder).filter(([k]) => k.startsWith('db-certs')));
  expect(Object.keys(certs)).toHaveLength(3);
  expect(treeOf(dataDirOf('a'))).toEqual({ 'maintenance.json': maintenanceJson(), ...certs });
  expect(composeOf().services['fleet-postgres-replica']).toBeUndefined();
}

function expectFolderDone(before: Snapshot, answer: unknown, certs: boolean): void {
  const n = names();
  expect(answer).toEqual({ success: true, text: KEPT_TEXT.nDoneFolder({ outDir: n.outDir, certs }) });
  const after = bot();
  expect(after.maintenance).toMatchObject({ state: 'running', settled: true, hook: 'not-sent', login: 'not-managed' });
  expect(after.keptSets).toEqual([{ id: n.stamp, keptAt: n.startedAt, by: 'new-start', folder: n.outDir }]);
  expect(after.keptOp).toBeUndefined();
  expect(treeOf(n.outDir)).toEqual(before.folder);
  const certFiles = Object.fromEntries(Object.entries(before.folder).filter(([k]) => k.startsWith('db-certs')));
  expect(treeOf(dataDirOf('a'))).toEqual({ 'maintenance.json': maintenanceJson(), ...certFiles });
  expect(fs.readFileSync(composePathOf('a'), 'utf-8')).toBe(before.compose);
}

/** Throws once from saveKeptOpIf after nothing is saved for the patch that saves `step`; every other save runs. */
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

/** Throws once from the rename `match` picks, before it runs. */
function failRename(match: (from: string, to: string) => boolean, message: string): void {
  let done = false;
  run.beforeRename = (from, to) => {
    if (!done && match(from, to)) {
      done = true;
      throw Object.assign(new Error(message), { code: message.split(':')[0] });
    }
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  resetDocker();
  resetRun();
  clearRegistry();
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  resetSeed();
});
afterEach(() => {
  releaseFleetBackupBusy('a');
  vi.restoreAllMocks();
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('nm31 start: end states', () => {
  it('end state (1 of 3): main: the old volume and folder kept, a new database on a new volume, maintenance.json, State Running not sent', async () => {
    await seedMain();
    answerDatabase();
    const before = snapshot();
    docker.calls.length = 0;
    const answer = await press();
    expectMainDone(before, answer);
    expect(changing()).toEqual([
      ['stop', '--time', '60', CONTAINER],
      ['sh', `docker compose -f "${composePathOf('a')}" -p "bota" up --no-start fleet-postgres`],
      ['sh', `docker compose -f "${composePathOf('a')}" -p "bota" up -d fleet-postgres`],
    ]);
    expect(docker.calls.some(a => a.join(' ').includes('SHOW data_checksums'))).toBe(true);
    expect(claimFleetBackupBusy('a')).toBe(true);
  });

  it('end state (2 of 3): copy: the copy volume, its join and the folder kept, db-certs carried, no live copy left', async () => {
    await seedCopy();
    answerDatabase();
    const before = snapshot();
    docker.calls.length = 0;
    const answer = await press();
    expectCopyDone(before, answer);
    expect(changing()).toEqual([
      ['stop', '--time', '60', COPY_CONTAINER],
      ['sh', `docker rm -f "${COPY_CONTAINER}"`],
    ]);
  });

  it('end state (3 of 3): folder: the folder alone kept, db-certs carried, the compose and database untouched', async () => {
    await seedExternal('a', { certs: true });
    answerDatabase();
    const before = snapshot();
    docker.calls.length = 0;
    const answer = await press();
    expectFolderDone(before, answer, true);
    expect(changing()).toEqual([]);
  });
});

describe('nm31 start: each step\'s failure opens the record at the step before', () => {
  it('N1: the database does not stop', async () => {
    await seedMain();
    answerDatabase();
    docker.overrides.unshift({ match: a => a[0] === 'stop', answer: { ok: false, stderr: 'Error response from daemon: cannot stop container: permission denied' } });
    const answer = await press();
    expect(answer).toEqual(opened('the database did not stop (Error response from daemon: cannot stop container: permission denied)'));
    expect(stored().keptOp.step).toBe('recorded');
    expect(stored().keptSets).toBeUndefined();
  });

  it('N1c: the live copy does not stop', async () => {
    await seedCopy();
    answerDatabase();
    docker.overrides.unshift({ match: a => a[0] === 'stop', answer: { ok: false, stderr: 'Error response from daemon: cannot stop container: permission denied' } });
    const answer = await press();
    expect(answer).toEqual(opened('the live copy did not stop (Error response from daemon: cannot stop container: permission denied)'));
    expect(stored().keptOp.step).toBe('recorded');
  });

  it('N2: the deployed compose cannot be changed', async () => {
    await seedMain();
    answerDatabase();
    fs.rmSync(composePathOf('a'));
    fs.mkdirSync(composePathOf('a'));
    const answer = await press();
    expect(answer).toEqual(opened(/^the deployed compose could not be changed \(.*EISDIR.*\)$/));
    expect(stored().keptOp.step).toBe('db-stopped');
  });

  it('N2c: the copy\'s container cannot be removed', async () => {
    await seedCopy();
    answerDatabase();
    run.execOverrides.push({ match: c => c.startsWith('docker rm -f'), answer: { ok: false, stderr: 'Error response from daemon: permission denied' } });
    const answer = await press();
    expect(answer).toEqual(opened(`the standby service was removed from the deployed compose, but its container ${COPY_CONTAINER} could not be removed: Error response from daemon: permission denied`));
    expect(stored().keptOp.step).toBe('db-stopped');
  });

  it('N3: the swap\'s save throws: open at db-out, the registry unchanged', async () => {
    await seedMain();
    answerDatabase();
    const fleetDb = bot().fleetDb;
    vi.spyOn(containerManager, 'swapKeptData').mockImplementation(() => { throw new Error('ENOSPC: no space left on device'); });
    const answer = await press();
    expect(answer).toEqual(opened('the record could not be saved (ENOSPC: no space left on device)'));
    expect(stored().keptOp.step).toBe('db-out');
    expect(bot().keptSets).toBeUndefined();
    expect(bot().fleetDb).toEqual(fleetDb);
    expect(fs.existsSync(names().inDir)).toBe(false);
  });

  it('N4: the new folder cannot be made', async () => {
    await seedMain();
    answerDatabase();
    failRename((from) => from.endsWith('maintenance.json.tmp'), 'EACCES: permission denied');
    const answer = await press();
    expect(answer).toEqual(opened('the new data folder could not be made (EACCES: permission denied)'));
    expect(stored().keptOp.step).toBe('swapped');
    expect(fs.existsSync(dataDirOf('a'))).toBe(true);
    expect(fs.existsSync(names().outDir)).toBe(false);
  });

  it('N5: the data folder cannot be renamed', async () => {
    await seedMain();
    answerDatabase();
    const before = snapshot();
    failRename((from) => from === dataDirOf('a'), 'EBUSY: resource busy or locked');
    const answer = await press();
    // A4 (code review 1): the open text names the new folder N4 made, read from the disk
    expect(stored().keptOp.lastError).toBe('the data folder could not be renamed (EBUSY: resource busy or locked)');
    expect((answer as { error: string }).error).toBe(`Start on a new database stopped before it finished: the data folder could not be renamed (EBUSY: resource busy or locked). Done so far: the database was stopped, its service was taken out of the compose, the earlier data was recorded as kept, the new data folder was made. Run it again to go on, or Put back to return to the earlier database and data folder; until one of them finishes, the bot stays stopped and Start is refused.`);
    expect(stored().keptOp.step).toBe('swapped');
    expect(treeOf(dataDirOf('a'))).toEqual(before.folder);
  });

  it('N6: the new folder cannot be brought in', async () => {
    await seedMain();
    answerDatabase();
    failRename((from) => from === names().inDir, 'EPERM: operation not permitted');
    const answer = await press();
    // A4 (code review 1): the open text names the new folder made and the data folder set aside, read from the disk
    expect(answer).toEqual({ success: false, status: 409, open: true, error: `Start on a new database stopped before it finished: the new data folder could not be renamed (EPERM: operation not permitted). Done so far: the database was stopped, its service was taken out of the compose, the earlier data was recorded as kept, the new data folder was made, the data folder was set aside. Run it again to go on, or Put back to return to the earlier database and data folder; until one of them finishes, the bot stays stopped and Start is refused.` });
    expect(stored().keptOp.step).toBe('swapped');
    expect(fs.existsSync(dataDirOf('a'))).toBe(false);
    expect(fs.existsSync(names().outDir)).toBe(true);
  });

  it('N7: the new database\'s service cannot be written', async () => {
    await seedMain();
    answerDatabase();
    let writes = 0;
    run.beforeRename = (_from, to) => {
      if (to === composePathOf('a') && ++writes === 2) throw new Error('EROFS: read-only file system');
    };
    const answer = await press();
    expect(answer).toEqual(opened(/^the new database's service could not be written into the deployed compose \(.*EROFS: read-only file system.*\)$/));
    expect(stored().keptOp.step).toBe('folder');
    expect(composeOf().services['fleet-postgres']).toBeUndefined();
  });

  it('N8 (1 of 3): the new database does not start', async () => {
    await seedMain();
    answerDatabase();
    run.execOverrides.push({ match: c => c.endsWith('up -d fleet-postgres'), answer: { ok: false, stderr: 'Error response from daemon: no space left on device' } });
    const answer = await press();
    expect(answer).toEqual(opened(/^the new database did not start \(.*no space left on device\)$/));
    expect(stored().keptOp.step).toBe('db-in');
  });

  it('N8 (2 of 3): its roles cannot be set up', async () => {
    await seedMain();
    answerDatabase();
    db.roles = { ok: false, cls: 'other', error: 'the bot role smdb owns objects in another database' };
    const answer = await press();
    expect(answer).toEqual(opened('its roles could not be set up (the bot role smdb owns objects in another database)'));
    expect(stored().keptOp.step).toBe('db-in');
  });

  it('N8 (3 of 3): data checksums read off', async () => {
    await seedMain();
    answerDatabase();
    db.checksums = { ok: true, stdout: 'off\n' };
    const answer = await press();
    expect(answer).toEqual(opened(KEPT_TEXT.nChecksums));
    expect(stored().keptOp.step).toBe('db-in');
  });

  it('N9: the bot\'s login cannot be opened', async () => {
    await seedMain();
    answerDatabase();
    db.open = { ok: false, cls: 'other', error: 'permission denied to alter role' };
    const answer = await press();
    expect(answer).toEqual(opened("the bot's login on the new database could not be opened (permission denied to alter role)"));
    expect(stored().keptOp.step).toBe('db-up');
  });

  it('N10 (1 of 3): the app runs at the close', async () => {
    await seedMain();
    answerDatabase();
    vi.mocked(dbLogin.openBotLogin).mockImplementation(async () => { app.a = true; return { ok: true }; });
    const answer = await press();
    expect(answer).toEqual(opened(RUNS));
    expect(stored().keptOp.step).toBe('login');
    expect(stored().maintenance.state).toBe('off');
  });

  it('N10 (2 of 3): docker does not say whether the app runs at the close', async () => {
    await seedMain();
    answerDatabase();
    vi.mocked(dbLogin.openBotLogin).mockImplementation(async () => { app.a = null; return { ok: true }; });
    const answer = await press();
    expect(answer).toEqual(opened(NO_ANSWER));
    expect(stored().keptOp.step).toBe('login');
  });

  it('N10 (3 of 3): the close\'s save throws', async () => {
    await seedMain();
    answerDatabase();
    vi.spyOn(containerManager, 'closeKeptOp').mockImplementation(() => { throw new Error('ENOSPC: no space left on device'); });
    const answer = await press();
    expect(answer).toEqual(opened('the end could not be recorded (ENOSPC: no space left on device); run it again'));
    expect(stored().keptOp.step).toBe('login');
    expect(stored().maintenance.state).toBe('off');
  });
});

describe('nm31 start: the stopped reads before N3 and N5', () => {
  it('stopped read (1 of 4): the app runs before N3', async () => {
    await seedMain();
    answerDatabase();
    vi.mocked(containerManager.appContainerRunning).mockReset().mockResolvedValueOnce(false).mockResolvedValue(true);
    const answer = await press();
    expect(answer).toEqual(opened(RUNS));
    expect(stored().keptOp.step).toBe('db-out');
    expect(stored().keptSets).toBeUndefined();
  });

  it('stopped read (2 of 4): the database container runs before N3', async () => {
    await seedMain();
    answerDatabase();
    let reads = 0;
    docker.overrides.unshift({ match: a => a[0] === 'inspect' && a[a.length - 1] === CONTAINER && docker.running[CONTAINER] === false && ++reads === 2, answer: { ok: true, stdout: 'true\n' } });
    const answer = await press();
    expect(answer).toEqual(opened(KEPT_TEXT.nRuns(CONTAINER)));
    expect(stored().keptOp.step).toBe('db-out');
    expect(stored().keptSets).toBeUndefined();
  });

  it('stopped read (3 of 4): the app runs before N5', async () => {
    await seedMain();
    answerDatabase();
    const before = snapshot();
    vi.mocked(containerManager.appContainerRunning).mockReset().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
    const answer = await press();
    expect(answer).toEqual(opened(RUNS, ['the new data folder was made'])); // A4 (code review 1): read from the disk
    expect(stored().keptOp.step).toBe('swapped');
    expect(treeOf(dataDirOf('a'))).toEqual(before.folder);
    expect(fs.existsSync(names().outDir)).toBe(false);
  });

  it('stopped read (4 of 4): the copy container runs before N5', async () => {
    await seedCopy();
    answerDatabase();
    const before = snapshot();
    let reads = 0;
    docker.overrides.unshift({ match: a => a[0] === 'inspect' && a[a.length - 1] === COPY_CONTAINER && docker.running[COPY_CONTAINER] === false && ++reads === 3, answer: { ok: true, stdout: 'true\n' } });
    const answer = await press();
    expect(answer).toEqual(opened(KEPT_TEXT.nRuns(COPY_CONTAINER), ['the new data folder was made'])); // A4 (code review 1): read from the disk
    expect(stored().keptOp.step).toBe('swapped');
    expect(treeOf(dataDirOf('a'))).toEqual(before.folder);
  });
});

describe('nm31 start: a crash after each step, then a press that ends as a clean run', () => {
  const mainSteps: Array<[string, string]> = [
    ['crash (1 of 13): after N1', 'db-stopped'],
    ['crash (3 of 13): after N2', 'db-out'],
    ['crash (8 of 13): after N6', 'folder'],
    ['crash (9 of 13): after N7', 'db-in'],
    ['crash (10 of 13): after N8', 'db-up'],
    ['crash (11 of 13): after N9', 'login'],
  ];
  it.each(mainSteps)('%s', async (_n, step) => {
    await seedMain();
    answerDatabase();
    const before = snapshot();
    crashOnStep(step);
    const first = await press();
    expect(first).toMatchObject({ success: false, open: true });
    expect(stored().keptOp).toBeTruthy();
    expectMainDone(before, await press());
  });

  const copySteps: Array<[string, string]> = [
    ['crash (2 of 13): after N1c', 'db-stopped'],
    ['crash (4 of 13): after N2c', 'db-out'],
  ];
  it.each(copySteps)('%s', async (_n, step) => {
    await seedCopy();
    answerDatabase();
    const before = snapshot();
    crashOnStep(step);
    expect(await press()).toMatchObject({ success: false, open: true });
    expectCopyDone(before, await press());
  });

  it('crash (5 of 13): after N3\'s save: the resume finds the set and does not swap again', async () => {
    await seedMain();
    answerDatabase();
    const before = snapshot();
    let swaps = 0;
    vi.spyOn(containerManager, 'swapKeptData').mockImplementation((...args) => {
      swaps++;
      const r = realSwap(...args);
      if (swaps === 1) throw new Error('the manager stopped here');
      return r;
    });
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(bot().keptSets).toHaveLength(1);
    expectMainDone(before, await press());
    expect(swaps).toBe(1);
  });

  it('crash (6 of 13): after N4 built the new folder: the resume moves it in', async () => {
    await seedMain();
    answerDatabase();
    const before = snapshot();
    failRename((from) => from === dataDirOf('a'), 'the manager stopped here');
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(fs.existsSync(path.join(names().inDir, 'maintenance.json'))).toBe(true);
    expectMainDone(before, await press());
  });

  it('crash (7 of 13): after N5\'s rename: the resume moves the new folder in', async () => {
    await seedMain();
    answerDatabase();
    const before = snapshot();
    failRename((from) => from === names().inDir, 'the manager stopped here');
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(fs.existsSync(dataDirOf('a'))).toBe(false);
    expectMainDone(before, await press());
  });

  it('crash (12 of 13): after N10\'s save: done, and a press is refused T-A-OFF', async () => {
    await seedMain();
    answerDatabase();
    const before = snapshot();
    let answer: unknown;
    vi.spyOn(containerManager, 'closeKeptOp').mockImplementation((...args) => {
      realClose(...args);
      throw new Error('the manager stopped here');
    });
    answer = await press();
    expect(answer).toMatchObject({ success: false });
    vi.mocked(containerManager.closeKeptOp).mockRestore();
    expect(bot().keptOp).toBeUndefined();
    expect(bot().maintenance).toMatchObject({ state: 'running', hook: 'not-sent' });
    expect(treeOf(names().outDir)).toEqual(before.folder);
    answer = await press();
    expect(answer).toEqual({ success: false, status: 409, error: KEPT_TEXT.aOff });
  });

  it('crash (13 of 13): N4 stopped with only maintenance.json.tmp written: the resume builds over the partial folder', async () => {
    await seedExternal('a', { certs: true });
    answerDatabase();
    const before = snapshot();
    failRename((from) => from.endsWith('maintenance.json.tmp'), 'the manager stopped here');
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(fs.readdirSync(names().inDir).sort()).toEqual(['db-certs', 'maintenance.json.tmp']);
    expectFolderDone(before, await press(), true);
  });
});

describe('nm31 start: the other exits', () => {
  it('N11: a press with the record open goes on from its step', async () => {
    await seedMain();
    answerDatabase();
    const before = snapshot();
    db.checksums = { ok: true, stdout: 'off\n' };
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.step).toBe('db-in');
    db.checksums = { ok: true, stdout: 'on\n' };
    docker.calls.length = 0;
    expectMainDone(before, await press());
    expect(docker.calls.filter(a => a[0] === 'stop')).toEqual([]);
  });

  it('N12: while the run holds new-database, a second press and the put-back lock are refused with the busy text', async () => {
    await seedMain();
    answerDatabase();
    const before = snapshot();
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    let reached!: () => void;
    const atUp = new Promise<void>(r => { reached = r; });
    run.execOverrides.push({ match: c => c.endsWith('up -d fleet-postgres'), answer: async () => { reached(); await held; docker.running[CONTAINER] = true; return { ok: true }; } });
    const running = press();
    await atUp;
    expect(await press()).toEqual({ success: false, status: 409, error: "Operation 'new-database' already in progress" });
    await expect(containerManager.withExternalBotOp('a', 'put-back', async () => 'ran')).rejects.toThrow("Operation 'new-database' is already in progress for this bot");
    expect(stored().keptOp.undo).toBeUndefined();
    release();
    expectMainDone(before, await running);
  });

  it('N13: after a run stops, the lock, the slot and the claim are free and the record stays with its step', async () => {
    await seedMain();
    answerDatabase();
    db.open = { ok: false, cls: 'other', error: 'the server closed the connection' };
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(keptRunningOp('a')).toBeNull();
    expect(containerManager.isBotBusy('a')).toBeNull();
    expect(claimFleetBackupBusy('a')).toBe(true);
    releaseFleetBackupBusy('a');
    expect(stored().keptOp).toMatchObject({ op: 'new-start', step: 'db-up', lastError: "the bot's login on the new database could not be opened (the server closed the connection)" });
  });

  it('N14: the app started outside after the swap: the old folder is not renamed under it', async () => {
    await seedExternal();
    answerDatabase();
    const before = snapshot();
    vi.mocked(containerManager.appContainerRunning).mockReset().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
    expect(await press()).toEqual(opened(RUNS, ['the new data folder was made'])); // A4 (code review 1): read from the disk
    expect(treeOf(dataDirOf('a'))).toEqual(before.folder);
    expect(fs.existsSync(names().outDir)).toBe(false);
  });

  it('N15: an empty data folder made between the renames is removed, the app read running at the close, and a later press ends', async () => {
    await seedMain();
    answerDatabase();
    const before = snapshot();
    run.afterRename = (from, to) => {
      if (from === dataDirOf('a') && to === names().outDir) {
        fs.mkdirSync(dataDirOf('a'));
        app.a = true;
      }
    };
    expect(await press()).toEqual(opened(RUNS));
    expect(stored().keptOp.step).toBe('login');
    expect(treeOf(dataDirOf('a'))).toEqual({ 'maintenance.json': maintenanceJson() });
    run.afterRename = null;
    app.a = false;
    expectMainDone(before, await press());
  });

  it('N16: the app started after N6 boots in maintenance; the close opens T-N-RUNS, and a press after the stop ends', async () => {
    await seedMain();
    answerDatabase();
    const before = snapshot();
    run.afterRename = (from) => { if (from === names().inDir) app.a = true; };
    expect(await press()).toEqual(opened(RUNS));
    expect(treeOf(dataDirOf('a'))).toEqual({ 'maintenance.json': maintenanceJson() });
    run.afterRename = null;
    app.a = false;
    expectMainDone(before, await press());
  });

  it('N17: docker does not answer at N1: no later step runs', async () => {
    await seedMain();
    answerDatabase();
    const before = snapshot();
    docker.overrides.unshift({ match: a => a[0] === 'stop', answer: { ok: false, stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' } });
    expect(await press()).toEqual(opened('the database did not stop (Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?)'));
    expect(fs.readFileSync(composePathOf('a'), 'utf-8')).toBe(before.compose);
    expect(treeOf(dataDirOf('a'))).toEqual(before.folder);
    expect(run.execCalls).toEqual([]);
  });

  it('N18: a sharer started from its card while the record is open is refused T-G-SHARER, and nothing starts', async () => {
    await seedMain();
    seedBot({ sourceUrl: SMDB, status: 'stopped' }, 'b');
    envManager.setEnvVars('b', { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: envUrl() });
    vi.spyOn(fleetBackup, 'runningDatabaseSharers').mockImplementation(async () => ({ bots: [bot(), containerManager.getBot('b')!], unchecked: [] }));
    vi.spyOn(containerManager, 'liveContainerNames').mockImplementation(async () => []);
    answerDatabase();
    db.open = { ok: false, cls: 'other', error: 'the server closed the connection' };
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.sharers).toEqual(['b']);
    docker.calls.length = 0;
    run.execCalls.length = 0;
    expect(await containerManager.startBot('b')).toEqual({
      success: false,
      error: "Bot a's Start on a new database did not finish, and this bot uses the same database, so Start is refused until it does; nothing was changed",
    });
    expect(docker.calls).toEqual([]);
    expect(run.execCalls).toEqual([]);
  });

  it('N19: a repeat after done is refused T-A-OFF', async () => {
    await seedMain();
    answerDatabase();
    expect(await press()).toMatchObject({ success: true });
    const reg = fs.readFileSync(registryPath(), 'utf-8');
    expect(await press()).toEqual({ success: false, status: 409, error: KEPT_TEXT.aOff });
    expect(fs.readFileSync(registryPath(), 'utf-8')).toBe(reg);
  });

  it('N20: the reverse after done is Put back of the set: the old database and folder in use again, the new ones kept', async () => {
    await seedMain();
    answerDatabase();
    const before = snapshot();
    expect(await press()).toMatchObject({ success: true });
    run.volumes[before.inst.fleetDb!.volume] = 'exists';
    run.volumes[names().newVolume] = 'exists';
    vi.mocked(Date.now).mockReturnValue(NOW + 3_600_000);
    await offOrder('a');
    answerDatabase();
    db.login = { ok: true, login: { inRecovery: false, canLogin: false, sessions: 0 } };
    vi.spyOn(dbLogin, 'blockBotLogin').mockResolvedValue({ ok: true });
    vi.spyOn(dbLogin, 'endBotSessions').mockResolvedValue({ ok: true });
    const answer = await putBack('a', names().stamp);
    expect(answer).toMatchObject({ success: true });
    expect((answer as { warning?: string }).warning).toBeUndefined();
    expect(bot().fleetDb).toEqual(before.inst.fleetDb);
    expect(treeOf(dataDirOf('a'))).toEqual(before.folder);
    expect(bot().keptSets).toEqual([expect.objectContaining({ by: 'put-back', folder: `${dataDirOf('a')}.kept-2026-11-17T13-00-00-000Z`, db: expect.objectContaining({ volume: names().newVolume }) })]);
    expect(bot().keptOp).toBeUndefined();
    expect(bot().maintenance).toMatchObject({ state: 'off', settled: true, login: 'blocked' });
  });
  it('N21: Running or another state ordered during the record is refused by the gate in runCore', async () => {
    await seedMain();
    answerDatabase();
    db.open = { ok: false, cls: 'other', error: 'the server closed the connection' };
    expect(await press()).toMatchObject({ success: false, open: true });
    const before = stored().maintenance;
    const refused = 'Start on a new database did not finish on this bot, so a state change is refused until it does; open the Database window to run it again; nothing was changed';
    for (const to of ['running', 'maintenance', 'off'] as const) {
      expect(await maintenance.runMaintenanceOrder('a', to, 'Back soon')).toEqual({ settled: false, text: refused });
    }
    expect(stored().maintenance).toEqual(before);
    expect(stored().keptOp).toMatchObject({ op: 'new-start', step: 'db-up' });
  });

  it('N22: the Database URL, DATA_BACKEND or PGPORT edited during the record is refused T-G-ENV, the store unchanged', async () => {
    await seedMain();
    answerDatabase();
    db.open = { ok: false, cls: 'other', error: 'the server closed the connection' };
    expect(await press()).toMatchObject({ success: false, open: true });
    const env = envManager.getEnvVars('a');
    const edits: Array<[Record<string, string>, string]> = [
      [{ DATA_BACKEND_URL: 'postgresql://smdb:pw@db.example:5432/smdb' }, 'DATA_BACKEND_URL'],
      [{ DATA_BACKEND: 'file' }, 'DATA_BACKEND'],
      [{ PGPORT: '5433' }, 'PGPORT'],
    ];
    for (const [vars, keys] of edits) {
      await expect(containerManager.updateBot('a', { envVars: vars })).rejects.toThrow(`Start on a new database did not finish on this bot, so ${keys} cannot change until it does; nothing was changed`);
    }
    expect(envManager.getEnvVars('a')).toEqual(env);
  });
  it('N23: writeCertFiles writes nothing during the record and answers T-G-CERTS; after the close it writes into the new folder', async () => {
    await seedExternal('a', { certs: true });
    answerDatabase();
    run.afterRename = (from) => { if (from === names().inDir) app.a = true; };
    expect(await press()).toEqual(opened(RUNS));
    run.afterRename = null;
    const inUse = treeOf(dataDirOf('a'));
    const kept = treeOf(names().outDir);
    expect(Object.keys(inUse).filter(k => k.startsWith('db-certs/'))).toHaveLength(1);
    expect(await writeCertFiles(bot(), [FIXTURE_PEM, COPY_PEM])).toBe('the certificate files were not written: Start on a new database or Put back is open on this bot, and the next refresh after it writes them');
    expect(treeOf(dataDirOf('a'))).toEqual(inUse);
    expect(treeOf(names().outDir)).toEqual(kept);
    app.a = false;
    expect(await press()).toMatchObject({ success: true });
    expect(await writeCertFiles(bot(), [FIXTURE_PEM, COPY_PEM])).toBeNull();
    const after = treeOf(dataDirOf('a'));
    expect(Object.keys(after).filter(k => k.startsWith('db-certs/'))).toHaveLength(2);
    expect(after).toMatchObject(inUse);
    expect(treeOf(names().outDir)).toEqual(kept);
  });
});

describe('nm31 start: code review 1, fix 1', () => {
  /** A7 (code review 2): the re-check before N1 closed the record and answered the admission refusal; nothing changed. */
  function closedWith(answer: unknown, reason: string, before: Snapshot): void {
    expect(answer).toEqual({ success: false, status: 409, error: reason });
    expect(stored().keptOp).toBeUndefined();
    expect(stored().keptLast).toEqual({ op: 'new-start', set: names().stamp, outcome: 'failed', text: reason, at: ISO });
    expect(stored().keptSets).toBeUndefined();
    expect(changing()).toEqual([]);
    expect(bot().fleetDb).toEqual(before.inst.fleetDb);
    expect(treeOf(dataDirOf('a'))).toEqual(before.folder);
    expect(keptRunningOp('a')).toBeNull();
    expect(containerManager.isBotBusy('a')).toBeNull();
  }

  /** Bot b on a's database, read running once A20's reads ran (`started`), or from the start. */
  function sharerB(startedNow = false): { started: () => boolean } {
    seedBot({ sourceUrl: SMDB, status: 'stopped' }, 'b');
    envManager.setEnvVars('b', { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: envUrl() });
    let started = startedNow;
    vi.spyOn(fleetBackup, 'runningDatabaseSharers').mockImplementation(async () => ({ bots: [bot(), containerManager.getBot('b')!], unchecked: [] }));
    vi.spyOn(containerManager, 'liveContainerNames').mockImplementation(async (id: string) => (id === 'b' && started ? ['botb-app-1'] : []));
    run.psql = (c) => {
      if (c.login === 'dbm_meta') started = true;
      return psqlAnswer(c);
    };
    return { started: () => started };
  }

  it('A1 (code review 1), A7 (code review 2): a sharer started during A20\'s reads leaves no record, the database is not stopped, and b\'s Off order then passes', async () => {
    await seedMain();
    sharerB();
    answerDatabase();
    const before = snapshot();
    docker.calls.length = 0;
    const answer = await press();
    closedWith(answer, KEPT_TEXT.aSharers(['Bot b']), before);
    expect(containerManager.keptSharerRefusal('b', 'a state change')).toBeNull();
    const off = await maintenance.runMaintenanceOrder('b', 'off', OFF_MESSAGE);
    expect(off.text).not.toContain('Start on a new database');
  });

  it('A1 (code review 1), A7 and A8 (code review 2): a Database URL moved to another host during A20\'s reads leaves no record and names the host as not the managed database', async () => {
    await seedMain();
    const moved = envUrl().replace(`@${CONTAINER}:`, '@db.other.example:');
    run.psql = (c) => {
      if (c.login === 'dbm_meta') envManager.setEnvVars('a', { DATA_BACKEND_URL: moved });
      return psqlAnswer(c);
    };
    answerDatabase();
    const before = snapshot();
    docker.calls.length = 0;
    const answer = await press();
    closedWith(answer, `The Database URL names db.other.example, not this bot's managed database ${CONTAINER}; set the URL to the container name ${CONTAINER} in the Env editor first; nothing was changed`, before);
  });

  it('A7 and A8 (code review 2): a Database URL moved to the public address during A20\'s reads leaves no record and answers T-A-URLHOST', async () => {
    await seedMain('a', { replication: true });
    const moved = envUrl().replace(`@${CONTAINER}:`, '@pub.example:');
    run.psql = (c) => {
      if (c.login === 'dbm_meta') envManager.setEnvVars('a', { DATA_BACKEND_URL: moved });
      return psqlAnswer(c);
    };
    answerDatabase();
    const before = snapshot();
    docker.calls.length = 0;
    const answer = await press();
    closedWith(answer, KEPT_TEXT.aUrlHost('pub.example', CONTAINER), before);
  });

  it('A7 (code review 2): a resume at \'recorded\' (the database did not stop) whose re-check finds a running sharer leaves no record', async () => {
    await seedMain();
    answerDatabase();
    docker.overrides.unshift({ match: a => a[0] === 'stop', answer: { ok: false, stderr: 'Error response from daemon: cannot stop container: permission denied' } });
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.step).toBe('recorded');
    docker.overrides.shift();
    sharerB(true);
    const before = snapshot();
    docker.calls.length = 0;
    const answer = await press();
    closedWith(answer, KEPT_TEXT.aSharers(['Bot b']), before);
  });

  it('A2 (code review 1): a replication password and a former-main code whose key was lost keep their ciphertext through N3, and it decrypts with the key back', async () => {
    await seedMain();
    const replBlob = envManager.encrypt('Repl-Pw-0123456789');
    const codeBlob = envManager.encrypt('former-main-join-code');
    const reg = JSON.parse(fs.readFileSync(registryPath(), 'utf-8'));
    reg.instances.a.fleetDb.replication = { role: 'smdb_join', password: replBlob, hostPort: 15432, publicHost: 'pub.example', certHost: 'pub.example' };
    reg.instances.a.fleetDb.formerMain = { code: codeBlob, slot: 's0', machine: 'old.example', host: 'old.example', port: 15432 };
    fs.writeFileSync(registryPath(), JSON.stringify(reg, null, 2));
    const realDecrypt = envManager.decryptOrNull;
    const lost = vi.spyOn(envManager, 'decryptOrNull').mockImplementation((v: string) => (v === replBlob || v === codeBlob ? null : realDecrypt(v)));
    answerDatabase();
    expect(bot().fleetDb!.replication!.password).toBe('');
    expect(await press()).toMatchObject({ success: true });
    const set = JSON.parse(fs.readFileSync(registryPath(), 'utf-8')).instances.a.keptSets[0];
    expect(set.db.replication.password).toBe(replBlob);
    expect(set.db.formerMain.code).toBe(codeBlob);
    lost.mockRestore();
    expect(envManager.decryptOrNull(set.db.replication.password)).toBe('Repl-Pw-0123456789');
    expect(envManager.decryptOrNull(set.db.formerMain.code)).toBe('former-main-join-code');
    const healed = JSON.parse(fs.readFileSync(registryPath(), 'utf-8'));
    healed.instances.a.keptSets[0].db.replication.password = envManager.encrypt('Repl-Pw-0123456789');
    healed.instances.a.keptSets[0].db.formerMain.code = envManager.encrypt('former-main-join-code');
    fs.writeFileSync(registryPath(), JSON.stringify(healed, null, 2));
    expect(bot().keptSets![0].db!.replication!.password).toBe('Repl-Pw-0123456789');
  });

  it('A2 (code review 1): a join code whose key was lost keeps its ciphertext both in use and in the set N3 keeps', async () => {
    await seedCopy();
    const codeBlob = envManager.encrypt('copy-join-code');
    const reg = JSON.parse(fs.readFileSync(registryPath(), 'utf-8'));
    reg.instances.a.fleetJoin.code = codeBlob;
    fs.writeFileSync(registryPath(), JSON.stringify(reg, null, 2));
    const realDecrypt = envManager.decryptOrNull;
    const lost = vi.spyOn(envManager, 'decryptOrNull').mockImplementation((v: string) => (v === codeBlob ? null : realDecrypt(v)));
    answerDatabase();
    expect(bot().fleetJoin!.code).toBe('');
    expect(await press()).toMatchObject({ success: true });
    const raw = JSON.parse(fs.readFileSync(registryPath(), 'utf-8')).instances.a;
    expect(raw.fleetJoin.code).toBe(codeBlob);
    expect(raw.keptSets[0].join.code).toBe(codeBlob);
    lost.mockRestore();
    expect(envManager.decryptOrNull(raw.keptSets[0].join.code)).toBe('copy-join-code');
    raw.fleetJoin.code = envManager.encrypt('copy-join-code');
    raw.keptSets[0].join.code = envManager.encrypt('copy-join-code');
    const healed = JSON.parse(fs.readFileSync(registryPath(), 'utf-8'));
    healed.instances.a = raw;
    fs.writeFileSync(registryPath(), JSON.stringify(healed, null, 2));
    expect(bot().keptSets![0].join!.code).toBe('copy-join-code');
    expect(bot().fleetJoin!.code).toBe('copy-join-code');
  });

  it('A3 (code review 1): the data folder removed outside after N4: the run opens, nothing is set aside or brought in', async () => {
    await seedExternal('a', { certs: true });
    answerDatabase();
    failRename((from) => from === dataDirOf('a'), 'the manager stopped here');
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.step).toBe('swapped');
    fs.rmSync(dataDirOf('a'), { recursive: true });
    const built = treeOf(names().inDir);
    const answer = await press();
    expect(answer).toEqual(openedGone(true, ['the new data folder was made'])); // A4 (code review 1): read from the disk; C10 (code review 2): T-N-GONE; A10 (code review 3)
    expect(stored().keptOp.step).toBe('swapped');
    expect(fs.existsSync(dataDirOf('a'))).toBe(false);
    expect(fs.existsSync(names().outDir)).toBe(false);
    expect(treeOf(names().inDir)).toEqual(built);
  });

  it('A3 (code review 1): after the move-in, a kept folder moved away outside: the loop takes no step but done, and no second new folder is made', async () => {
    await seedExternal('a', { certs: true });
    answerDatabase();
    failRename((from) => from === names().inDir, 'the manager stopped here');
    expect(await press()).toMatchObject({ success: false, open: true });
    const away = `${names().outDir}.away`;
    run.afterRename = (from) => {
      if (from !== names().inDir) return;
      fs.cpSync(names().outDir, away, { recursive: true });
      fs.rmSync(names().outDir, { recursive: true });
    };
    const answer = await press();
    run.afterRename = null;
    expect(answer).toEqual(opened('the data folders did not reach the end state of this start'));
    expect(stored().keptOp.step).toBe('swapped');
    expect(fs.existsSync(names().inDir)).toBe(false);
    expect(fs.existsSync(names().outDir)).toBe(false);
    expect(treeOf(dataDirOf('a'))).toHaveProperty(['maintenance.json']);
    expect(treeOf(dataDirOf('a'))).not.toHaveProperty(['state.json']);
    expect(treeOf(away)).toMatchObject({ '.env': 'DISCORD_TOKEN=x\n', 'state.json': '{}' });
  });
});

describe('nm31 start: code review 1, fix 2', () => {
  it('C6 (code review 1): the app runs at the close and docker names no container: T-N-RUNS gives no command and names the project', async () => {
    await seedMain();
    answerDatabase();
    vi.spyOn(containerManager, 'runningAppContainer').mockImplementation(async () => null);
    vi.mocked(dbLogin.openBotLogin).mockImplementation(async () => { app.a = true; return { ok: true }; });
    const answer = await press();
    expect(answer).toEqual(opened("the bot's container (or its database or copy container) runs although this has not finished, and the manager could not name it; stop the app container of bota in a shell, then run it again"));
    expect((answer as { error: string }).error).not.toContain('docker stop');
    expect(stored().keptOp.step).toBe('login');
  });
});

const GONE = () => `the data folder ${dataDirOf('a')} is missing, so nothing was set aside; put the folder back there and run it again`; // A10 (code review 3)

/** A10 (code review 3): the gone answer's tail, by whether the start has a database part. */
const GONE_TAIL = (folderOnly: boolean) => `Run it again to go on, or Put back to ${folderOnly ? 'close this' : 'return to the earlier database'}; the data folder stays missing. Until one of them finishes, the bot stays stopped and Start is refused.`;

/** The open answer for the gone case, built from the literal texts. */
function openedGone(folderOnly: boolean, onDisk: string[]) {
  const rec = stored().keptOp;
  expect(rec.lastError).toBe(GONE());
  return { success: false, status: expect.any(Number), open: true, error: `Start on a new database stopped before it finished: ${GONE()}. Done so far: ${[...newStartDone(rec), ...onDisk].join(', ')}. ${GONE_TAIL(folderOnly)}` };
}

describe('nm31 start: code review 2', () => {
  const siblings = () => fs.readdirSync(path.dirname(dataDirOf('a'))).sort();

  /** A 'swapped' record whose data folder was removed outside after N4 built the new folder. */
  async function swappedWithDataGone(): Promise<Record<string, string>> {
    failRename((from) => from === dataDirOf('a'), 'the manager stopped here');
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.step).toBe('swapped');
    fs.rmSync(dataDirOf('a'), { recursive: true });
    return treeOf(names().inDir);
  }

  /** Put back of the open record ended done with the data folder still missing, nothing created and the new folder in place. */
  function expectMissingBack(answer: unknown, built: Record<string, string>, before: string[]): string {
    expect((answer as { error?: string }).error).toBeUndefined();
    expect(answer).toMatchObject({ success: true });
    const text = (answer as { text: string }).text;
    expect(text).toContain(`the data folder ${dataDirOf('a')} was already missing and still is`);
    expect(text).toContain(`The folder ${names().inDir} was not brought in and stays where it was, under Kept data.`);
    expect(stored().keptOp).toBeUndefined();
    expect(stored().keptLast).toMatchObject({ op: 'put-back', outcome: 'done', text });
    expect(fs.existsSync(dataDirOf('a'))).toBe(false);
    expect(fs.existsSync(names().outDir)).toBe(false);
    expect(treeOf(names().inDir)).toEqual(built);
    expect(siblings()).toEqual(before);
    return text;
  }

  it('C10 (code review 2): a folder start at \'swapped\' with the data folder removed: Run it again answers T-N-GONE; Put back ends done and closes the record, creating nothing', async () => {
    await seedExternal('a', { certs: true });
    answerDatabase();
    const built = await swappedWithDataGone();
    expect(await press()).toEqual(openedGone(true, ['the new data folder was made'])); // A10 (code review 3)
    const before = siblings();
    const text = expectMissingBack(await putBack('a', names().stamp, {}), built, before);
    expect(text.startsWith(`Put back: the data folder ${dataDirOf('a')} was already missing and still is.`)).toBe(true);
    expect(stored().keptSets).toEqual([expect.objectContaining({ id: `${names().stamp}-new`, folder: names().inDir })]);
  });

  it('C10 (code review 2): a main start at \'swapped\' with the data folder removed: Put back undoes the database part and leaves the data folder missing', async () => {
    await seedMain();
    answerDatabase();
    const oldDb = bot().fleetDb!;
    run.volumes[oldDb.volume] = 'exists';
    const built = await swappedWithDataGone();
    const before = siblings();
    const text = expectMissingBack(await putBack('a', names().stamp, {}), built, before);
    expect(text).toContain(`is in use again: the volume ${oldDb.volume}; the data folder ${dataDirOf('a')} was already missing and still is.`);
    expect(bot().fleetDb).toEqual(oldDb);
    expect(composeOf().volumes['fleet-postgres-data']).toEqual({ name: oldDb.volume });
  });
});

describe('nm31 start: code review 3', () => {
  async function swappedWithDataGone(): Promise<void> {
    failRename((from) => from === dataDirOf('a'), 'the manager stopped here');
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.step).toBe('swapped');
    fs.rmSync(dataDirOf('a'), { recursive: true });
  }

  it('A10 (code review 3): a main start whose data folder is gone gives each remedy once: the reason puts the folder back, the tail returns the earlier database only', async () => {
    await seedMain();
    answerDatabase();
    await swappedWithDataGone();
    const answer = await press();
    expect(answer).toEqual(openedGone(false, ['the new data folder was made']));
    expect(stored().keptOp.folderGone).toBe(true); // A10 page line (code review 3): the page reads the gone case from the record
    expect((answer as { error: string }).error).not.toContain('and data folder');
  });

  it('A10 (code review 3): a folder start whose data folder is gone names no database change: Put back closes it', async () => {
    await seedExternal('a', { certs: true });
    answerDatabase();
    await swappedWithDataGone();
    const answer = await press();
    expect(answer).toEqual(openedGone(true, ['the new data folder was made']));
    expect((answer as { error: string }).error).not.toContain('database without it');
    expect(stored().keptOp.folderGone).toBe(true); // A10 page line (code review 3)
  });

  it('C12 (code review 3): a reverse that stops after a missing-folder step keeps saying so after the folder is put back outside', async () => {
    await seedExternal('a', { certs: true });
    answerDatabase();
    await swappedWithDataGone();
    const real = containerManager.saveKeptOpIf;
    vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation((id, key, patch) => {
      const r = real(id, key, patch);
      if (patch.step === 'folder') app.a = true;
      return r;
    });
    const first = await putBack('a', names().stamp, {});
    expect(first).toMatchObject({ success: false, open: true });
    expect((first as { error: string }).error).toContain('the data folder was found missing and left so');
    fs.mkdirSync(dataDirOf('a'));
    const again = await putBack('a', names().stamp, {});
    expect(again).toMatchObject({ success: false, open: true });
    expect((again as { error: string }).error).toContain('the data folder was found missing and left so');
    expect((again as { error: string }).error).not.toContain('the data folders were exchanged');
  });
});

describe('nm31 start: code review 4', () => {
  async function swappedWithDataGone(): Promise<void> {
    failRename((from) => from === dataDirOf('a'), 'the manager stopped here');
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.step).toBe('swapped');
    fs.rmSync(dataDirOf('a'), { recursive: true });
  }

  /** The page's keptOpenLineText, run on a record as the page holds it. */
  function pageOpenLine(rec: unknown): string {
    const vm = require('vm') as typeof import('vm');
    const html = (require('fs') as typeof import('fs')).readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
    const fn = (name: string): string => {
      const start = html.indexOf(`function ${name}(`);
      let i = html.indexOf('{', html.indexOf(')', start));
      for (let depth = 0; ; i++) {
        if (html[i] === '{') depth++;
        else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
      }
    };
    const ctx = vm.createContext({});
    vm.runInContext(`${fn('keptStepWords')}\n${fn('keptOpenLineText')}\nthis.line = keptOpenLineText;`, ctx);
    return (ctx as { line: (r: unknown) => string }).line(rec);
  }

  it('B10 (code review 4): a reverse that found the data folder missing ends done saying so when a folder has appeared there since', async () => {
    await seedExternal('a', { certs: true });
    answerDatabase();
    await swappedWithDataGone();
    const real = containerManager.saveKeptOpIf;
    vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation((id, key, patch) => {
      const r = real(id, key, patch);
      if (patch.step === 'folder') app.a = true;
      return r;
    });
    expect(await putBack('a', names().stamp, {})).toMatchObject({ success: false, open: true });
    fs.mkdirSync(dataDirOf('a'));
    fs.writeFileSync(path.join(dataDirOf('a'), 'state.json'), '{}');
    app.a = false;
    const done = await putBack('a', names().stamp, {});
    expect((done as { error?: string }).error).toBeUndefined();
    expect(done).toMatchObject({ success: true });
    const text = (done as { text: string }).text;
    expect(text.startsWith(`Put back: the data folder ${dataDirOf('a')} was missing when this ran; the folder there now was not put there by this Put back.`), text).toBe(true);
    expect(text).not.toContain('still is');
    expect(text).not.toContain('What was in use');
    expect(text).toContain(`The folder ${names().inDir} was not brought in and stays where it was, under Kept data.`);
    expect(stored().keptOp).toBeUndefined();
    expect(stored().keptLast).toMatchObject({ op: 'put-back', outcome: 'done', text });
    expect(treeOf(dataDirOf('a'))).toEqual({ 'state.json': '{}' });
  });

  it('C16 (code review 4): a start resumed after T-N-GONE clears folderGone and the old reason with its first save, so the page shows the general tail', async () => {
    await seedExternal('a', { certs: true });
    answerDatabase();
    failRename((from) => from === dataDirOf('a'), 'the manager stopped here');
    expect(await press()).toMatchObject({ success: false, open: true });
    const away = `${dataDirOf('a')}.away`;
    fs.renameSync(dataDirOf('a'), away);
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.folderGone).toBe(true);
    fs.renameSync(away, dataDirOf('a'));
    const real = containerManager.saveKeptOpIf;
    const seen: Array<Record<string, unknown>> = [];
    vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation((id, key, patch) => {
      const r = real(id, key, patch);
      if (patch.step === 'folder') seen.push({ ...stored().keptOp });
      return r;
    });
    const resumed = await press();
    expect(seen, JSON.stringify(resumed)).toHaveLength(1);
    const mid = seen[0];
    expect(mid.step).toBe('folder');
    expect(mid.folderGone).toBeUndefined();
    expect(mid.lastError).toBeUndefined();
    const line = pageOpenLine(mid);
    expect(line.startsWith('Start on a new database has not finished: it runs now, or the manager restarted while it ran.')).toBe(true);
    expect(line.endsWith('Run it again to go on, or Put back to return to the earlier database and data folder; until one of them finishes, the bot stays stopped and Start is refused.')).toBe(true);
    expect(line).not.toContain('stays missing');
  });
});

describe('nm31 start: code review 5', () => {
  /** The stored record right after each 'swapped' save made by swapKeptData. */
  function recordAtSwap(): Array<Record<string, unknown>> {
    const seen: Array<Record<string, unknown>> = [];
    vi.spyOn(containerManager, 'swapKeptData').mockImplementation((id, key, build, step) => {
      const r = realSwap(id, key, build, step);
      if (step === 'swapped') seen.push({ ...stored().keptOp });
      return r;
    });
    return seen;
  }

  it('A11 (code review 5): a main start resumed at \'db-out\' after T-N-RUNS drops the reason in the swap\'s own save', async () => {
    await seedMain();
    answerDatabase();
    vi.mocked(containerManager.appContainerRunning).mockReset().mockResolvedValueOnce(false).mockResolvedValue(true);
    expect(await press()).toEqual(opened(RUNS));
    expect(stored().keptOp.step).toBe('db-out');
    vi.mocked(containerManager.appContainerRunning).mockReset().mockResolvedValue(false);
    const seen = recordAtSwap();
    const resumed = await press();
    expect(seen, JSON.stringify(resumed)).toHaveLength(1);
    expect(seen[0].step).toBe('swapped');
    expect(seen[0].lastError).toBeUndefined();
    expect(seen[0].folderGone).toBeUndefined();
    expect(resumed).toMatchObject({ success: true });
  });

  it('A11 (code review 5): a folder start resumed at \'recorded\' after T-N-RUNS drops the reason in the swap\'s own save', async () => {
    await seedExternal('a', { certs: true });
    answerDatabase();
    vi.mocked(containerManager.appContainerRunning).mockReset().mockResolvedValueOnce(false).mockResolvedValue(true);
    expect(await press()).toEqual(opened(RUNS));
    expect(stored().keptOp.step).toBe('recorded');
    vi.mocked(containerManager.appContainerRunning).mockReset().mockResolvedValue(false);
    const seen = recordAtSwap();
    const resumed = await press();
    expect(seen, JSON.stringify(resumed)).toHaveLength(1);
    expect(seen[0].step).toBe('swapped');
    expect(seen[0].lastError).toBeUndefined();
    expect(seen[0].folderGone).toBeUndefined();
    expect(resumed).toMatchObject({ success: true });
  });
});

describe('nm31 start: code review 6', () => {
  it('C19 (code review 6): a step that throws after the record is open answers the 500 text and saves the reason the page line names', async () => {
    await seedMain();
    answerDatabase();
    vi.spyOn(containerManager, 'takeFleetDbServicesOut').mockImplementation(() => { throw new Error('boom'); });
    expect(await press()).toEqual({ success: false, status: 500, error: 'Start on a new database stopped on an unexpected error: boom' });
    const rec = stored().keptOp;
    expect(rec.step).toBe('db-stopped');
    expect(rec.lastError).toBe('an unexpected error (boom)');
    expect(pageOpenLine(rec).startsWith('Start on a new database stopped before it finished: an unexpected error (boom). Done so far: the database was stopped.')).toBe(true);
    expect(keptRunningOp('a')).toBeNull();
  });
});
