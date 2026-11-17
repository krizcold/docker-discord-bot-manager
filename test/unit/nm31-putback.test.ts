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
import YAML from 'yaml';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import * as fleetBackup from '../../src/instance/fleetBackup';
import * as dbLogin from '../../src/instance/dbLogin';
import * as maintenance from '../../src/instance/maintenance';
import { claimFleetBackupBusy, releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { KEPT_TEXT, KEPT_TIMING, keptDate, keptRunningOp, putBackDone } from '../../src/instance/keptData';
import { fakeJoinRecord } from './join-fake';
import { addFleetPostgresService } from '../../src/templates/pcsProcessing';
import { docker, resetDocker } from './nm2-docker';
import { clearRegistry, registryPath, seedBot } from './nm2-harness';
import { resetRun, run } from './nm31-run';
import { app, composePathOf, COPY_CONTAINER, COPY_VOLUME, CONTAINER, dataDirOf, OFF_MESSAGE, pageOpenLine, patchRegistry, resetSeed, SMDB, treeOf } from './nm31-seed';
import {
  asideDir, Before, bot, fwd, keptAfterStart, LATER, LATER_STAMP, login, orders, pressBack, resetBack, stored,
} from './nm31-back';
import type { KeptOpRecord } from '../../src/types';

const LATER_ISO = new Date(LATER).toISOString();
const DATE = keptDate(fwd().stamp);
const RUNS = KEPT_TEXT.nRuns('f00dcafe1234');
const realSave = containerManager.saveKeptOpIf;
const realSwap = containerManager.swapKeptData;
const realClose = containerManager.closeKeptOp;
const realOrder = maintenance.runOrderInOp;

const composeOf = (): any => YAML.parse(fs.readFileSync(composePathOf('a'), 'utf-8'));
const orderText = (i = orders.length - 1) => (orders[i] as { text: string }).text;
const regText = () => fs.readFileSync(registryPath(), 'utf-8');

/** The open answer for `reason`, with the steps the stored record reached. */
function opened(reason: string | RegExp) {
  const rec = stored().keptOp;
  expect(rec).toBeTruthy();
  expect(rec.lastError).toEqual(typeof reason === 'string' ? reason : expect.stringMatching(reason));
  return { success: false, status: expect.any(Number), open: true, error: KEPT_TEXT.pOpen(rec.lastError, putBackDone(rec)) };
}

/** The end state of a clean Put back of the main's set, against the bot before the forward run. */
function expectMainBack(before: Before, answer: unknown, warning?: string): void {
  const n = fwd();
  expect(answer).toEqual({
    success: true,
    text: KEPT_TEXT.pDone({ date: DATE, volume: before.inst.fleetDb!.volume, folder: dataDirOf('a'), asideVolume: n.newVolume, asideFolder: asideDir(), orderText: orderText() }),
    ...(warning ? { warning } : {}),
  });
  const after = bot();
  expect(after.fleetDb).toEqual(before.inst.fleetDb);
  expect(after.keptSets).toEqual([{
    id: LATER_STAMP, keptAt: LATER_ISO, by: 'put-back', folder: asideDir(),
    db: { containerName: CONTAINER, user: before.inst.fleetDb!.user, db: before.inst.fleetDb!.db, volume: n.newVolume, password: before.inst.fleetDb!.password },
  }]);
  expect(after.keptOp).toBeUndefined();
  expect(after.keptLast).toEqual({ op: 'put-back', set: n.stamp, outcome: 'done', text: (answer as { text: string }).text, at: LATER_ISO });
  expect(treeOf(dataDirOf('a'))).toEqual(before.folder);
  expect(Object.keys(treeOf(asideDir()))).toEqual(['maintenance.json']);
  expect(fs.existsSync(n.outDir)).toBe(false);
  expect(composeOf().volumes['fleet-postgres-data']).toEqual({ name: before.inst.fleetDb!.volume });
  expect(composeOf().services['fleet-postgres'].container_name).toBe(CONTAINER);
  if (!warning) expect(after.maintenance).toMatchObject({ state: 'off', settled: true, login: 'blocked' });
  expect(login.canLogin).toBe(false);
  expect(keptRunningOp('a')).toBeNull();
  expect(containerManager.isBotBusy('a')).toBeNull();
}

function expectCopyBack(before: Before, answer: unknown, copy: { streams: string } | { down: string }): void {
  const n = fwd();
  expect(answer).toEqual({
    success: true,
    text: KEPT_TEXT.pDone({ date: DATE, copyVolume: COPY_VOLUME, folder: dataDirOf('a'), asideFolder: asideDir(), copy, orderText: orderText() }),
  });
  const after = bot();
  expect(after.fleetDbReplica).toEqual(before.inst.fleetDbReplica);
  expect(after.fleetJoin).toEqual(before.inst.fleetJoin);
  expect(after.keptSets).toEqual([{ id: LATER_STAMP, keptAt: LATER_ISO, by: 'put-back', folder: asideDir(), join: before.inst.fleetJoin }]);
  expect(after.keptOp).toBeUndefined();
  expect(treeOf(dataDirOf('a'))).toEqual(before.folder);
  expect(composeOf().services['fleet-postgres-replica'].container_name).toBe(COPY_CONTAINER);
  expect(docker.running[COPY_CONTAINER]).toBe(true);
}

function expectFolderBack(before: Before, answer: unknown): void {
  const n = fwd();
  expect(answer).toEqual({ success: true, text: KEPT_TEXT.pDone({ date: DATE, folder: dataDirOf('a'), asideFolder: asideDir(), orderText: orderText() }) });
  const after = bot();
  expect(after.keptSets).toEqual([{ id: LATER_STAMP, keptAt: LATER_ISO, by: 'put-back', folder: asideDir() }]);
  expect(after.keptOp).toBeUndefined();
  expect(treeOf(dataDirOf('a'))).toEqual(before.folder);
  expect(fs.readFileSync(composePathOf('a'), 'utf-8')).toBe(before.compose);
}

/** The streaming answer of the copy's status read. */
function copyStreams(row: string): void {
  docker.overrides.unshift({ match: a => a[0] === 'exec' && a.join(' ').includes('pg_is_in_recovery'), answer: { ok: true, stdout: `${row}\n` } });
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

describe('nm31 put back: a clean run', () => {
  it('continue (1 of 4): a database set: the kept volume and folder in use again, the new ones kept, Off settled on the database put back', async () => {
    const before = await keptAfterStart('main');
    docker.calls.length = 0;
    const answer = await pressBack();
    expectMainBack(before, answer);
    expect(docker.calls.filter(a => a[0] === 'stop')).toEqual([['stop', '--time', '60', CONTAINER]]);
    expect(run.execCalls).toContain(`docker compose -f "${composePathOf('a')}" -p "bota" up -d fleet-postgres`);
    expect(claimFleetBackupBusy('a')).toBe(true);
  });

  it('continue (2 of 4): a live copy set that streams: the copy runs again with its join, and the answer says where it streams from', async () => {
    const before = await keptAfterStart('copy');
    copyStreams('t|streaming|t|0.5');
    const answer = await pressBack();
    expectCopyBack(before, answer, { streams: 'main.invalid:15432' });
  });

  it('continue (3 of 4): a live copy set that runs but does not stream: the answer says why', async () => {
    const before = await keptAfterStart('copy');
    copyStreams('t|starting|f|');
    const answer = await pressBack();
    expectCopyBack(before, answer, { down: 'its WAL receiver reads starting' });
  });

  it('continue (4 of 4): a folder set: the kept folder in use again, the compose untouched', async () => {
    const before = await keptAfterStart('folder');
    docker.calls.length = 0;
    const answer = await pressBack();
    expectFolderBack(before, answer);
    expect(docker.calls.filter(a => a[0] === 'stop')).toEqual([]);
  });
});

/** A refusal: the answer, and nothing changed in the registry, the folders or the compose, and no docker call that changes state. */
async function refusedWith(error: string, set?: string) {
  const reg = regText();
  const data = treeOf(dataDirOf('a'));
  const kept = treeOf(fwd().outDir);
  const compose = fs.readFileSync(composePathOf('a'), 'utf-8');
  docker.calls.length = 0;
  run.execCalls.length = 0;
  const answer = await pressBack(set);
  expect(answer).toEqual({ success: false, status: 409, error });
  expect(regText()).toBe(reg);
  expect(treeOf(dataDirOf('a'))).toEqual(data);
  expect(treeOf(fwd().outDir)).toEqual(kept);
  expect(fs.readFileSync(composePathOf('a'), 'utf-8')).toBe(compose);
  expect(docker.calls.filter(a => a[0] === 'stop' || a[0] === 'rm' || a[0] === 'start')).toEqual([]);
  expect(run.execCalls).toEqual([]);
  expect(keptRunningOp('a')).toBeNull();
  expect(claimFleetBackupBusy('a')).toBe(true);
  releaseFleetBackupBusy('a');
}

describe('nm31 put back: admission (P0) refuses and changes nothing', () => {
  it('P0 (1 of 10): no such kept set: T-P-NOSET', async () => {
    await keptAfterStart('main');
    await refusedWith(KEPT_TEXT.pNoSet('2026-01-01T00-00-00-000Z'), '2026-01-01T00-00-00-000Z');
  });

  it('P0 (2 of 10): the bot is not Off (Running as the forward run left it)', async () => {
    await keptAfterStart('main', { off: false });
    await refusedWith(KEPT_TEXT.pOff);
  });

  it('P0 (3 of 10): the app runs although Off: T-A-RUNS', async () => {
    await keptAfterStart('main');
    app.a = true;
    await refusedWith(KEPT_TEXT.aRuns);
  });

  it('P0 (4 of 10): a Delete record is open: A5', async () => {
    await keptAfterStart('main');
    const del: KeptOpRecord = { op: 'delete', set: fwd().stamp, stamp: LATER_STAMP, startedAt: LATER_ISO, parts: ['db', 'folder'], dataDir: dataDirOf('a'), outDir: '', inDir: '', offMessage: '', sharers: [], step: 'recorded' };
    expect(containerManager.createKeptOpIf('a', del)).toBeNull();
    await refusedWith('Delete did not finish on this bot; finish it in the Database window first; nothing was changed');
  });

  it('P0 (5 of 10): a database set while the instance holds a live copy: T-P-CROSS', async () => {
    await keptAfterStart('main');
    const reg = JSON.parse(regText());
    reg.instances.a.fleetDbReplica = { containerName: COPY_CONTAINER, volume: COPY_VOLUME, user: 'smdb', db: 'smdb', slot: 's1', primaryHost: 'main.invalid', primaryPort: 15432, publicHost: 'copy.example', hostPort: 25432, certHost: COPY_CONTAINER, seededAt: 1 };
    delete reg.instances.a.fleetDb;
    fs.writeFileSync(registryPath(), JSON.stringify(reg, null, 2));
    await refusedWith(KEPT_TEXT.pCross('db'));
  });

  it('P0 (6 of 10): the Database URL no longer names the kept database: T-P-URL', async () => {
    await keptAfterStart('main');
    const url = new URL(envManager.getEnvVars('a').DATA_BACKEND_URL);
    url.hostname = 'db.example';
    envManager.setEnvVars('a', { DATA_BACKEND_URL: url.toString() });
    await refusedWith(KEPT_TEXT.pUrl(CONTAINER));
  });

  it('P0 (7 of 10): the kept volume is gone: T-P-GONE', async () => {
    const before = await keptAfterStart('main');
    run.volumes[before.inst.fleetDb!.volume] = 'absent';
    await refusedWith(KEPT_TEXT.pGoneVolume(before.inst.fleetDb!.volume));
  });

  it('P0 (8 of 10): docker does not say whether the kept volume exists: T-A-DOCKER', async () => {
    const before = await keptAfterStart('main');
    run.volumes[before.inst.fleetDb!.volume] = 'unknown';
    await refusedWith(KEPT_TEXT.aDocker(before.inst.fleetDb!.volume));
  });

  it('P0 (9 of 10): another bot on the database runs: T-A-SHARERS', async () => {
    await keptAfterStart('main');
    seedBot({ sourceUrl: SMDB }, 'b');
    vi.spyOn(fleetBackup, 'runningDatabaseSharers').mockImplementation(async () => ({ bots: [containerManager.getBot('a')!, containerManager.getBot('b')!], unchecked: [] }));
    vi.spyOn(containerManager, 'liveContainerNames').mockImplementation(async (id: string) => (id === 'b' ? ['botb-app-1'] : []));
    await refusedWith(KEPT_TEXT.aSharers(['Bot b']));
  });

  it('P0 (10 of 10): the kept folder is gone: T-P-GONE', async () => {
    await keptAfterStart('folder');
    fs.renameSync(fwd().outDir, `${fwd().outDir}-moved`);
    await refusedWith(KEPT_TEXT.pGoneFolder(fwd().outDir));
  });

  it('P0 folder null: a set whose folder is null leaves the folder in use and runs no folder step', async () => {
    const before = await keptAfterStart('main');
    const reg = JSON.parse(regText());
    reg.instances.a.keptSets[0].folder = null;
    fs.writeFileSync(registryPath(), JSON.stringify(reg, null, 2));
    const inUse = treeOf(dataDirOf('a'));
    const renames: string[] = [];
    run.afterRename = (from) => { if (from.startsWith(dataDirOf('a'))) renames.push(from); };
    const answer = await pressBack();
    expect(answer).toEqual({
      success: true,
      text: KEPT_TEXT.pDone({ date: DATE, volume: before.inst.fleetDb!.volume, asideVolume: fwd().newVolume, orderText: orderText() }),
    });
    expect(renames).toEqual([]);
    expect(treeOf(dataDirOf('a'))).toEqual(inUse);
    expect(bot().fleetDb).toEqual(before.inst.fleetDb);
    expect(bot().keptSets).toEqual([expect.objectContaining({ id: LATER_STAMP, folder: null, db: expect.objectContaining({ volume: fwd().newVolume }) })]);
    expect(fs.existsSync(asideDir())).toBe(false);
  });
});

describe('nm31 put back: each step\'s failure opens the record at the step before', () => {
  it('P1: the database in use does not stop', async () => {
    await keptAfterStart('main');
    docker.overrides.unshift({ match: a => a[0] === 'stop', answer: { ok: false, stderr: 'Error response from daemon: cannot stop container: permission denied' } });
    expect(await pressBack()).toEqual(opened('the database in use did not stop (Error response from daemon: cannot stop container: permission denied)'));
    expect(stored().keptOp).toMatchObject({ op: 'put-back', set: fwd().stamp, asideSet: LATER_STAMP, step: 'recorded' });
  });

  it('P2: the deployed compose cannot be changed', async () => {
    await keptAfterStart('main');
    fs.rmSync(composePathOf('a'));
    fs.mkdirSync(composePathOf('a'));
    expect(await pressBack()).toEqual(opened(/^the deployed compose could not be changed \(.*EISDIR.*\)$/));
    expect(stored().keptOp.step).toBe('db-stopped');
  });

  it('P3: the swap\'s save throws: open at db-out, the registry\'s sets and database unchanged', async () => {
    await keptAfterStart('main');
    const sets = bot().keptSets;
    const fleetDb = bot().fleetDb;
    vi.spyOn(containerManager, 'swapKeptData').mockImplementation(() => { throw new Error('ENOSPC: no space left on device'); });
    expect(await pressBack()).toEqual(opened('the record could not be saved (ENOSPC: no space left on device)'));
    expect(stored().keptOp.step).toBe('db-out');
    expect(bot().keptSets).toEqual(sets);
    expect(bot().fleetDb).toEqual(fleetDb);
  });

  it('P4: the folder in use cannot be renamed', async () => {
    await keptAfterStart('main');
    const inUse = treeOf(dataDirOf('a'));
    failRename((from) => from === dataDirOf('a'), 'EBUSY: resource busy or locked');
    expect(await pressBack()).toEqual(opened('the data folder could not be renamed (EBUSY: resource busy or locked)'));
    expect(stored().keptOp.step).toBe('swapped');
    expect(treeOf(dataDirOf('a'))).toEqual(inUse);
    expect(fs.existsSync(fwd().outDir)).toBe(true);
  });

  it('P5: the kept folder cannot be brought in', async () => {
    await keptAfterStart('main');
    failRename((from) => from === fwd().outDir, 'EPERM: operation not permitted');
    expect(await pressBack()).toEqual(opened('the kept data folder could not be renamed (EPERM: operation not permitted)'));
    expect(stored().keptOp.step).toBe('swapped');
    expect(fs.existsSync(dataDirOf('a'))).toBe(false);
    expect(fs.existsSync(asideDir())).toBe(true);
    expect(fs.existsSync(fwd().outDir)).toBe(true);
  });

  it('P6 (1 of 2): the database\'s service cannot be written', async () => {
    await keptAfterStart('main');
    let writes = 0;
    run.beforeRename = (_from, to) => {
      if (to === composePathOf('a') && ++writes === 2) throw new Error('EROFS: read-only file system');
    };
    expect(await pressBack()).toEqual(opened(/^the database's service could not be written into the deployed compose \(.*EROFS: read-only file system.*\)$/));
    expect(stored().keptOp.step).toBe('folder');
    expect(composeOf().services['fleet-postgres']).toBeUndefined();
  });

  it('P6 (2 of 2): the live copy put back does not run', async () => {
    const timing = { ...KEPT_TIMING };
    Object.assign(KEPT_TIMING, { copyUpMs: 50, pollMs: 10 });
    try {
      await keptAfterStart('copy');
      run.execOverrides.push({ match: c => c.endsWith('up -d fleet-postgres-replica'), answer: { ok: true } });
      expect(await pressBack()).toEqual(opened(`the live copy did not start (${COPY_CONTAINER} is not running)`));
      expect(stored().keptOp.step).toBe('folder');
    } finally {
      Object.assign(KEPT_TIMING, timing);
    }
  });

  it('P8: the app runs at the close', async () => {
    await keptAfterStart('main');
    vi.mocked(maintenance.runOrderInOp).mockImplementationOnce(async (...args) => {
      const r = await realOrder(...args);
      orders.push(r);
      app.a = true;
      return r;
    });
    expect(await pressBack()).toEqual(opened(RUNS));
    expect(stored().keptOp.step).toBe('settled');
    expect(stored().keptLast.op).toBe('new-start');
  });

  it('P7: an Off order that does not settle is the close\'s warning, and the run ends', async () => {
    const before = await keptAfterStart('main');
    vi.mocked(dbLogin.blockBotLogin).mockResolvedValue({ ok: false, cls: 'other', error: 'permission denied to alter role' });
    const answer = await pressBack();
    const text = orderText();
    expect(text).toMatch(/permission denied to alter role/);
    expectMainBack(before, answer, text);
    expect(stored().maintenance).toMatchObject({ state: 'off', settled: false });
  });
});

describe('nm31 put back: a crash after each step, then a press that ends as a clean run', () => {
  const steps: Array<[string, string]> = [
    ['crash (1 of 8): after P1', 'db-stopped'],
    ['crash (2 of 8): after P2', 'db-out'],
    ['crash (5 of 8): after P5', 'folder'],
    ['crash (6 of 8): after P6', 'db-in'],
    ['crash (7 of 8): after P7', 'settled'],
  ];
  it.each(steps)('%s', async (_n, step) => {
    const before = await keptAfterStart('main');
    crashOnStep(step);
    expect(await pressBack()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp).toBeTruthy();
    expectMainBack(before, await pressBack());
  });

  it('crash (3 of 8): after P3\'s save: the resume finds the swap and does not swap again', async () => {
    const before = await keptAfterStart('main');
    let swaps = 0;
    vi.spyOn(containerManager, 'swapKeptData').mockImplementation((...args) => {
      swaps++;
      const r = realSwap(...args);
      if (swaps === 1) throw new Error('the manager stopped here');
      return r;
    });
    expect(await pressBack()).toMatchObject({ success: false, open: true });
    expect(bot().fleetDb).toEqual(before.inst.fleetDb);
    expectMainBack(before, await pressBack());
    expect(swaps).toBe(1);
  });

  it('crash (4 of 8): after P4\'s rename, before P5\'s: the resume brings the kept folder in', async () => {
    const before = await keptAfterStart('main');
    failRename((from) => from === fwd().outDir, 'the manager stopped here');
    expect(await pressBack()).toMatchObject({ success: false, open: true });
    expect(fs.existsSync(dataDirOf('a'))).toBe(false);
    expectMainBack(before, await pressBack());
  });

  it('crash (8 of 8): after P8\'s save: done, and a press is refused T-P-NOSET', async () => {
    const before = await keptAfterStart('main');
    vi.spyOn(containerManager, 'closeKeptOp').mockImplementation((...args) => {
      realClose(...args);
      throw new Error('the manager stopped here');
    });
    expect(await pressBack()).toMatchObject({ success: false });
    vi.mocked(containerManager.closeKeptOp).mockRestore();
    expect(bot().keptOp).toBeUndefined();
    expect(bot().fleetDb).toEqual(before.inst.fleetDb);
    expect(treeOf(dataDirOf('a'))).toEqual(before.folder);
    expect(await pressBack()).toEqual({ success: false, status: 409, error: KEPT_TEXT.pNoSet(fwd().stamp) });
  });
});

describe('nm31 put back: the other exits', () => {
  it('P9: the bot started outside before P4: the stopped read opens T-N-RUNS and the folder is not moved', async () => {
    await keptAfterStart('main');
    const inUse = treeOf(dataDirOf('a'));
    vi.mocked(containerManager.appContainerRunning).mockReset().mockResolvedValueOnce(false).mockResolvedValue(true);
    expect(await pressBack()).toEqual(opened(RUNS));
    expect(stored().keptOp.step).toBe('swapped');
    expect(treeOf(dataDirOf('a'))).toEqual(inUse);
    expect(fs.existsSync(fwd().outDir)).toBe(true);
  });

  it('P10: the bot started outside after P6: P7\'s Off order sends the hook and stops it under the put-back lock', async () => {
    const before = await keptAfterStart('main');
    const realWrite = containerManager.writeFleetDbService;
    vi.spyOn(containerManager, 'writeFleetDbService').mockImplementation(async (...args) => {
      const r = await realWrite(...args);
      app.a = true;
      return r;
    });
    const stops: string[] = [];
    vi.spyOn(containerManager, 'stopBotInOp').mockImplementation(async (id: string, op: string) => {
      stops.push(op);
      if (containerManager.isBotBusy(id) !== op) return { success: false, error: `the stop must run under the '${op}' operation, which is not held` };
      app[id] = false;
      return { success: true };
    });
    const answer = await pressBack();
    expect(stops).toEqual(['put-back']);
    expect(h.hookBodies).toEqual([{ action: 'maintenance', body: { state: 'maintenance', message: OFF_MESSAGE } }]);
    expectMainBack(before, answer);
  });

  it('P11: a repeat after done is refused T-P-NOSET', async () => {
    await keptAfterStart('main');
    expect(await pressBack()).toMatchObject({ success: true });
    await refusedWith(KEPT_TEXT.pNoSet(fwd().stamp));
  });

  it('P12: the reverse after done is Put back of the set it put aside', async () => {
    const before = await keptAfterStart('main');
    expect(await pressBack()).toMatchObject({ success: true });
    const newDb = bot().keptSets![0].db;
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-11-17T14:00:00.000Z'));
    const answer = await pressBack(LATER_STAMP);
    expect(answer).toMatchObject({ success: true });
    expect(bot().fleetDb).toEqual(newDb);
    expect(treeOf(dataDirOf('a'))).toEqual({ 'maintenance.json': expect.any(String) });
    expect(bot().keptSets).toEqual([expect.objectContaining({ id: '2026-11-17T14-00-00-000Z', by: 'put-back', db: before.inst.fleetDb, folder: `${dataDirOf('a')}.kept-2026-11-17T14-00-00-000Z` })]);
    expect(treeOf(`${dataDirOf('a')}.kept-2026-11-17T14-00-00-000Z`)).toEqual(before.folder);
  });

  it('P13: a database put back without dbm_admin: the block fails with the missing-role text, and the close answers success with that warning', async () => {
    const before = await keptAfterStart('main');
    const missing = { ok: false, cls: 'missing-role', error: `the role ${dbLogin.MANAGER_DB_ROLE} does not exist in this database's cluster; the manager creates it only as the first role of a database it creates` } as const;
    vi.mocked(dbLogin.ensureManagerDbRole).mockResolvedValue(missing);
    login.canLogin = true;
    const answer = await pressBack();
    const text = orderText();
    expect(text).toContain(missing.error);
    expect(answer).toMatchObject({ success: true, warning: text });
    expect(bot().fleetDb).toEqual(before.inst.fleetDb);
    expect(stored().maintenance).toMatchObject({ state: 'off', settled: false, login: 'unconfirmed' });
    expect(bot().keptOp).toBeUndefined();
  });
});

describe('nm31 put back: the join swap', () => {
  it('join (1 of 3): a live copy set with a join restores it, and the aside set keeps the join in use', async () => {
    const before = await keptAfterStart('copy');
    const newer = fakeJoinRecord({ joinedAt: '2026-11-17T12:30:00.000Z' }, { machine: 'other.example' });
    patchRegistry('a', { fleetJoin: newer });
    copyStreams('t|streaming|t|0.5');
    expect(await pressBack()).toMatchObject({ success: true });
    expect(bot().fleetJoin).toEqual(before.inst.fleetJoin);
    expect(bot().keptSets).toEqual([expect.objectContaining({ id: LATER_STAMP, join: newer })]);
  });

  it('join (2 of 3): a database set without a join deletes the join in use, and the aside set keeps it', async () => {
    await keptAfterStart('main');
    const newer = fakeJoinRecord();
    patchRegistry('a', { fleetJoin: newer });
    expect(await pressBack()).toMatchObject({ success: true });
    expect(bot().fleetJoin).toBeUndefined();
    expect(bot().keptSets).toEqual([expect.objectContaining({ id: LATER_STAMP, join: newer })]);
  });

  it('join (3 of 3): a folder set leaves the join in use as it is and keeps its own only as a record', async () => {
    await keptAfterStart('folder', { join: true });
    expect(bot().keptSets![0].join).toBeTruthy();
    const newer = fakeJoinRecord({ joinedAt: '2026-11-17T12:30:00.000Z' }, { machine: 'other.example' });
    patchRegistry('a', { fleetJoin: newer });
    expect(await pressBack()).toMatchObject({ success: true });
    expect(bot().fleetJoin).toEqual(newer);
    expect(bot().keptSets).toEqual([expect.objectContaining({ id: LATER_STAMP, join: newer })]);
  });
});

describe('nm31 put back: a resume from db-in on skips A7', () => {
  it('a put-back stopped after P7 left Off unsettled goes on, not refused T-A-UNSETTLED', async () => {
    const before = await keptAfterStart('main');
    vi.mocked(dbLogin.blockBotLogin).mockResolvedValue({ ok: false, cls: 'other', error: 'permission denied to alter role' });
    crashOnStep('settled');
    expect(await pressBack()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.step).toBe('db-in');
    expect(stored().maintenance).toMatchObject({ state: 'off', settled: false });
    vi.mocked(dbLogin.blockBotLogin).mockImplementation(async () => { login.canLogin = false; return { ok: true } as any; });
    expectMainBack(before, await pressBack());
  });
});

describe('nm31 put back: code review 1, fix 1', () => {
  it('B1 (code review 1): a folder-only Put back on a database instance, stopped during P7: Run it again is not refused T-A-UNSETTLED and ends done', async () => {
    const before = await keptAfterStart('main');
    expect(containerManager.dropKeptPart('a', fwd().stamp, 'db')).toBeNull();
    vi.mocked(dbLogin.blockBotLogin).mockResolvedValue({ ok: false, cls: 'other', error: 'permission denied to alter role' });
    crashOnStep('settled');
    expect(await pressBack()).toMatchObject({ success: false, open: true });
    expect(stored().maintenance).toMatchObject({ state: 'off', settled: false });
    vi.mocked(dbLogin.blockBotLogin).mockImplementation(async () => { login.canLogin = false; return { ok: true } as any; });
    const answer = await pressBack();
    expect((answer as { error?: string }).error).toBeUndefined();
    expect(answer).toMatchObject({ success: true });
    expect(stored().keptOp).toBeUndefined();
    expect(treeOf(dataDirOf('a'))).toEqual(before.folder);
    expect(stored().maintenance).toMatchObject({ state: 'off', settled: true });
  });

  it('A2 (code review 1): a kept replication password and former-main code whose key was lost keep their ciphertext through P3, and it decrypts with the key back', async () => {
    await keptAfterStart('main');
    const replBlob = envManager.encrypt('Repl-Pw-0123456789');
    const codeBlob = envManager.encrypt('former-main-join-code');
    const reg = JSON.parse(regText());
    reg.instances.a.keptSets[0].db.replication = { role: 'smdb_join', password: replBlob, hostPort: 15432, publicHost: 'pub.example', certHost: 'pub.example' };
    reg.instances.a.keptSets[0].db.formerMain = { code: codeBlob, slot: 's0', machine: 'old.example', host: 'old.example', port: 15432 };
    fs.writeFileSync(registryPath(), JSON.stringify(reg, null, 2));
    const realDecrypt = envManager.decryptOrNull;
    const lost = vi.spyOn(envManager, 'decryptOrNull').mockImplementation((v: string) => (v === replBlob || v === codeBlob ? null : realDecrypt(v)));
    expect(bot().keptSets![0].db!.replication!.password).toBe('');
    expect(await pressBack()).toMatchObject({ success: true });
    const fleetDb = JSON.parse(regText()).instances.a.fleetDb;
    expect(fleetDb.replication.password).toBe(replBlob);
    expect(fleetDb.formerMain.code).toBe(codeBlob);
    lost.mockRestore();
    expect(envManager.decryptOrNull(fleetDb.replication.password)).toBe('Repl-Pw-0123456789');
    expect(envManager.decryptOrNull(fleetDb.formerMain.code)).toBe('former-main-join-code');
    const healed = JSON.parse(regText());
    healed.instances.a.fleetDb.replication.password = envManager.encrypt('Repl-Pw-0123456789');
    healed.instances.a.fleetDb.formerMain.code = envManager.encrypt('former-main-join-code');
    fs.writeFileSync(registryPath(), JSON.stringify(healed, null, 2));
    expect(bot().fleetDb!.replication!.password).toBe('Repl-Pw-0123456789');
  });

  it('B7 (code review 1): after the reverse of a Put back onto an instance with no fleetDb, the compose a Build writes mounts a stamped volume, never the kept one', async () => {
    await keptAfterStart('main');
    patchRegistry('a', { fleetDb: undefined });
    docker.running[CONTAINER] = false;
    const keptVolume = stored().keptSets[0].db.volume;
    expect(keptVolume).toBe('bota-fleet-postgres-data');
    crashOnStep('folder');
    const cut = await pressBack();
    expect((cut as { error?: string }).error).toContain('the record could not be saved (the manager stopped here)');
    const reversed = await pressBack(fwd().stamp, { reverse: true });
    expect((reversed as { error?: string }).error).toBeUndefined();
    expect(reversed).toMatchObject({ success: true });
    expect(bot().fleetDb).toBeUndefined();
    expect(bot().keptSets!.map(s => s.db?.volume)).toContain(keptVolume);
    const spec = containerManager.ensureFleetDataBackend(bot());
    expect(spec?.volume).toBe(`${keptVolume}-${LATER_STAMP}`);
    const compose = YAML.parse(addFleetPostgresService(fs.readFileSync(composePathOf('a'), 'utf-8'), bot() as any, spec!, { mode: 'docker' }));
    expect(Object.values(compose.volumes as Record<string, { name: string }>).map(v => v.name)).toEqual([spec!.volume]);
    expect(bot().fleetDb?.volume).toBe(spec!.volume);
  });
});

describe('nm31 put back: code review 1, fix 2', () => {
  it('B3 (code review 1): a live copy that stops right after it started: the answer says it does not run, not that it runs', async () => {
    await keptAfterStart('copy');
    docker.overrides.unshift({
      match: a => a[0] === 'exec' && a.join(' ').includes('pg_is_in_recovery'),
      answer: () => {
        docker.running[COPY_CONTAINER] = false;
        return { ok: false, stderr: `Error response from daemon: container ${COPY_CONTAINER} is not running` };
      },
    });
    const answer = await pressBack();
    expect(answer).toMatchObject({ success: true });
    const text = (answer as { text: string }).text;
    expect(text).toContain(' The live copy does not run: the standby container is not running. ');
    expect(text).not.toContain('runs but does not stream');
  });
});

describe('nm31 put back: code review 2', () => {
  const PW = 'In-Use-Pw-0123456789';
  const REPL = 'In-Use-Repl-9876543210';

  /** The fleetDb in use with its password and replication password as ciphertexts whose key is lost. */
  function loseInUseSecrets(): { pwBlob: string; replBlob: string; restore: () => void } {
    const pwBlob = envManager.encrypt(PW);
    const replBlob = envManager.encrypt(REPL);
    const reg = JSON.parse(regText());
    reg.instances.a.fleetDb.password = pwBlob;
    reg.instances.a.fleetDb.replication = { role: 'smdb_join', password: replBlob, hostPort: 15432, publicHost: 'pub.example', certHost: 'pub.example' };
    fs.writeFileSync(registryPath(), JSON.stringify(reg, null, 2));
    const realDecrypt = envManager.decryptOrNull;
    const lost = vi.spyOn(envManager, 'decryptOrNull').mockImplementation((v: string) => (v === pwBlob || v === replBlob ? null : realDecrypt(v)));
    expect(bot().fleetDb!.password).toBe('');
    expect(bot().fleetDb!.replication!.password).toBe('');
    return { pwBlob, replBlob, restore: () => lost.mockRestore() };
  }

  /** The ciphertexts on disk in the kept set `id`, and what they decrypt to once the key is back. */
  function expectKeptBlobs(id: string, lost: ReturnType<typeof loseInUseSecrets>): void {
    const set = JSON.parse(regText()).instances.a.keptSets.find((x: { id: string }) => x.id === id);
    expect(set.db.password).toBe(lost.pwBlob);
    expect(set.db.replication.password).toBe(lost.replBlob);
    lost.restore();
    expect(envManager.decryptOrNull(set.db.password)).toBe(PW);
    expect(envManager.decryptOrNull(set.db.replication.password)).toBe(REPL);
  }

  it('B8 (code review 2): the in-use password and replication password whose key was lost keep their ciphertext in the set P8 keeps aside', async () => {
    await keptAfterStart('main');
    const lost = loseInUseSecrets();
    const answer = await pressBack();
    expect((answer as { error?: string }).error).toBeUndefined();
    expect(answer).toMatchObject({ success: true });
    expect(stored().keptOp).toBeUndefined();
    expectKeptBlobs(LATER_STAMP, lost);
  });

  it('B8 (code review 2): the same through the reverse\'s close: the ciphertexts stay in the set the reverse keeps aside', async () => {
    await keptAfterStart('main');
    crashOnStep('folder');
    const cut = await pressBack();
    expect((cut as { error?: string }).error).toContain('the record could not be saved (the manager stopped here)');
    const lost = loseInUseSecrets();
    const reversed = await pressBack(fwd().stamp, { reverse: true });
    expect((reversed as { error?: string }).error).toBeUndefined();
    expect(reversed).toMatchObject({ success: true });
    expect(stored().keptOp).toBeUndefined();
    expectKeptBlobs(fwd().stamp, lost);
  });
});

describe('nm31 put back: code review 6', () => {
  /** The stored record each time the app is read, as the window shows it then; the app reads stopped. */
  function recordAtAppReads(): Array<Record<string, unknown>> {
    const seen: Array<Record<string, unknown>> = [];
    vi.mocked(containerManager.appContainerRunning).mockReset().mockImplementation(async () => {
      seen.push({ ...stored().keptOp });
      return false;
    });
    return seen;
  }

  /** The next Off order a run makes leaves the app running, so P8 opens T-N-RUNS. */
  function appStartsAtP7(): void {
    vi.mocked(maintenance.runOrderInOp).mockImplementationOnce(async (...args) => {
      const r = await realOrder(...args);
      orders.push(r);
      app.a = true;
      return r;
    });
  }

  it('B11 (code review 6): a Put back stopped at P8 with T-N-RUNS, then Run it again: while P8 reads the app the record has no reason and the page says it has not finished', async () => {
    await keptAfterStart('main');
    appStartsAtP7();
    expect(await pressBack()).toEqual(opened(RUNS));
    expect(stored().keptOp.step).toBe('settled');
    app.a = false;
    const seen = recordAtAppReads();
    const again = await pressBack();
    expect(again).toMatchObject({ success: true });
    const atP8 = seen[seen.length - 1];
    expect(atP8.step).toBe('settled');
    expect(atP8.lastError).toBeUndefined();
    expect(pageOpenLine(atP8).startsWith('Put back has not finished: it runs now, or the manager restarted while it ran.')).toBe(true);
  });

  it('B11 (code review 6): a reverse stopped at P8 with T-N-RUNS, then Run it again: while P8 reads the app the record has no reason', async () => {
    await keptAfterStart('main');
    crashOnStep('folder');
    expect(await pressBack()).toMatchObject({ success: false, open: true });
    vi.mocked(containerManager.saveKeptOpIf).mockRestore();
    appStartsAtP7();
    expect(await pressBack(fwd().stamp, { reverse: true })).toMatchObject({ success: false, open: true });
    expect(stored().keptOp).toMatchObject({ undo: true, step: 'settled', lastError: RUNS });
    app.a = false;
    const seen = recordAtAppReads();
    const again = await pressBack();
    expect(again).toMatchObject({ success: true });
    const atP8 = seen[seen.length - 1];
    expect(atP8.step).toBe('settled');
    expect(atP8.lastError).toBeUndefined();
    expect(pageOpenLine(atP8).startsWith('Put back has not finished: it runs now, or the manager restarted while it ran.')).toBe(true);
  });

  it('B11 (code review 6): a Put back stopped before P4 with T-N-RUNS, then Run it again: the record at the \'settled\' save has no reason', async () => {
    await keptAfterStart('main');
    vi.mocked(containerManager.appContainerRunning).mockReset().mockResolvedValueOnce(false).mockResolvedValue(true);
    expect(await pressBack()).toEqual(opened(RUNS));
    expect(stored().keptOp.step).toBe('swapped');
    vi.mocked(containerManager.appContainerRunning).mockReset().mockResolvedValue(false);
    const seen: Array<Record<string, unknown>> = [];
    vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation((id, key, patch) => {
      const r = realSave(id, key, patch);
      if (patch.step === 'settled') seen.push({ ...stored().keptOp });
      return r;
    });
    const again = await pressBack();
    expect(seen, JSON.stringify(again)).toHaveLength(1);
    expect(seen[0].lastError).toBeUndefined();
    expect(pageOpenLine(seen[0]).startsWith('Put back has not finished: it runs now, or the manager restarted while it ran.')).toBe(true);
    expect(again).toMatchObject({ success: true });
  });

  it('C19 (code review 6): a step after the swap that throws answers the 500 text and saves the reason the page line names', async () => {
    await keptAfterStart('main');
    vi.spyOn(containerManager, 'writeFleetDbService').mockImplementation(async () => { throw new Error('boom'); });
    expect(await pressBack()).toEqual({ success: false, status: 500, error: 'Put back stopped on an unexpected error: boom' });
    const rec = stored().keptOp;
    expect(rec.step).toBe('folder');
    expect(rec.lastError).toBe('an unexpected error (boom)');
    expect(pageOpenLine(rec).startsWith('Put back stopped before it finished: an unexpected error (boom). Done so far: ')).toBe(true);
    expect(keptRunningOp('a')).toBeNull();
  });
});
