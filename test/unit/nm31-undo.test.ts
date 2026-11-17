import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-undo-'));
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
import YAML from 'yaml';
import * as containerManager from '../../src/docker/containerManager';
import * as dbLogin from '../../src/instance/dbLogin';
import * as maintenance from '../../src/instance/maintenance';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { KEPT_TEXT, keptRunningOp, startOnNewDatabase } from '../../src/instance/keptData';
import { docker, resetDocker } from './nm2-docker';
import { clearRegistry } from './nm2-harness';
import { resetRun, run } from './nm31-run';
import { app, composePathOf, COPY_CONTAINER, COPY_VOLUME, CONTAINER, dataDirOf, db, resetSeed, treeOf } from './nm31-seed';
import { answerOrders, Before, bot, fwd, keptAfterStart, LATER, LATER_STAMP, login, orders, pressBack, resetBack, stored } from './nm31-back';
import * as seed from './nm31-seed';

const LATER_ISO = new Date(LATER).toISOString();
const NEW_ID = `${fwd().stamp}-new`;
const realSave = containerManager.saveKeptOpIf;
const realSwap = containerManager.swapKeptData;
const realOrder = maintenance.runOrderInOp;

const composeOf = (): any => YAML.parse(fs.readFileSync(composePathOf('a'), 'utf-8'));
const orderText = () => (orders[orders.length - 1] as { text: string }).text;

/** A forward run of `variant` stopped after the step `stop` arranges, with the record left open; the clock then moves on. */
async function forwardStopped(variant: 'main' | 'copy', stop: () => void, opts: { volume?: boolean } = {}): Promise<Before> {
  if (variant === 'main') await seed.seedMain();
  else await seed.seedCopy();
  answerOrders();
  const before: Before = { inst: bot(), folder: treeOf(dataDirOf('a')), compose: fs.readFileSync(composePathOf('a'), 'utf-8') };
  if (variant === 'main') run.volumes[before.inst.fleetDb!.volume] = 'exists';
  if (variant === 'copy') run.volumes[COPY_VOLUME] = 'exists';
  stop();
  expect(await startOnNewDatabase('a')).toMatchObject({ success: false });
  if (opts.volume) run.volumes[fwd().newVolume] = 'exists';
  expect(stored().keptOp).toMatchObject({ op: 'new-start' });
  vi.mocked(Date.now).mockReturnValue(LATER);
  restoreForward();
  return before;
}

/** The fakes a stop arranged are undone before the reverse, so only the record and the effects stay. */
let undoStop: Array<() => void> = [];
function restoreForward(): void {
  undoStop.forEach(f => f());
  undoStop = [];
  run.beforeRename = null;
  run.afterRename = null;
  app.a = false;
}

/** Throws once from the save of `step`, after nothing is saved; every other save runs. */
function crashOnStep(step: string): void {
  let done = false;
  const spy = vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation((id, key, patch) => {
    if (!done && patch.step === step) {
      done = true;
      throw new Error('the manager stopped here');
    }
    return realSave(id, key, patch);
  });
  undoStop.push(() => spy.mockImplementation(realSave));
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

/** The steps a run saved, from saveKeptOpIf and swapKeptData, in order. */
function stepsSaved(): string[] {
  const steps: string[] = [];
  const save = vi.mocked(containerManager.saveKeptOpIf);
  const impl = vi.isMockFunction(save) ? save.getMockImplementation() ?? realSave : realSave;
  vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation((id, key, patch) => {
    if (patch.step) steps.push(patch.step);
    return impl(id, key, patch);
  });
  vi.spyOn(containerManager, 'swapKeptData').mockImplementation((id, key, build, step) => {
    steps.push(step);
    return realSwap(id, key, build, step);
  });
  return steps;
}

/** The end of a reverse that found nothing swapped (U-a): the earlier data in use, Off settled again. */
function expectNothingSwapped(before: Before, answer: unknown, set = fwd().stamp, keptSets: unknown = undefined): void {
  expect(answer).toEqual({ success: true, text: KEPT_TEXT.uNothing(orderText()) });
  const after = bot();
  expect(after.keptOp).toBeUndefined();
  expect(after.keptSets).toEqual(keptSets);
  expect(after.keptLast).toEqual({ op: 'put-back', set, outcome: 'done', text: (answer as { text: string }).text, at: LATER_ISO });
  expect(after.maintenance).toMatchObject({ state: 'off', settled: true });
  expect(keptRunningOp('a')).toBeNull();
  expect(containerManager.isBotBusy('a')).toBeNull();
}

/** The end of a reverse of a new-start main after its swap (U-b): the old database and folder in use, the new ones as the -new set. */
function expectMainUndone(before: Before, answer: unknown, newSet: unknown): void {
  expect(answer).toMatchObject({ success: true });
  expect((answer as { warning?: string }).warning).toBeUndefined();
  const after = bot();
  expect(after.fleetDb).toEqual(before.inst.fleetDb);
  expect(after.keptOp).toBeUndefined();
  expect(after.keptSets).toEqual(newSet);
  expect(after.keptLast).toMatchObject({ op: 'put-back', set: fwd().stamp, outcome: 'done', at: LATER_ISO });
  expect(treeOf(dataDirOf('a'))).toEqual(before.folder);
  expect(fs.existsSync(fwd().outDir)).toBe(false);
  expect(composeOf().volumes['fleet-postgres-data']).toEqual({ name: before.inst.fleetDb!.volume });
  expect(after.maintenance).toMatchObject({ state: 'off', settled: true, login: 'blocked' });
  expect(login.canLogin).toBe(false);
  expect(keptRunningOp('a')).toBeNull();
}

const newDbOf = (before: Before) => ({ containerName: CONTAINER, user: before.inst.fleetDb!.user, db: before.inst.fleetDb!.db, volume: fwd().newVolume, password: before.inst.fleetDb!.password });
const newSet = (folder: string | null, dbPart?: unknown) => [{ id: NEW_ID, keptAt: LATER_ISO, by: 'put-back', folder, ...(dbPart ? { db: dbPart } : {}) }];

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
  undoStop = [];
});
afterEach(() => {
  releaseFleetBackupBusy('a');
  vi.restoreAllMocks();
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

/** Each forward state the reverse starts from, and the end state its clean reverse leaves. */
type Case = { name: string; arrange: () => Promise<Before>; expectEnd: (before: Before, answer: unknown) => void; ub: boolean; firstStep?: string };

const stopSidecar = () => docker.overrides.unshift({ match: a => a[0] === 'stop', answer: { ok: false, stderr: 'Error response from daemon: cannot stop container: permission denied' } });

const cases: Case[] = [
  {
    name: 'U1: reversed before N1: the service written again unchanged, Off settles as before',
    arrange: () => forwardStopped('main', () => {
      stopSidecar();
      undoStop.push(() => docker.overrides.shift());
    }),
    expectEnd: (before, answer) => {
      expectNothingSwapped(before, answer);
      expect(bot().fleetDb).toEqual(before.inst.fleetDb);
      expect(composeOf()).toEqual(YAML.parse(before.compose));
      expect(treeOf(dataDirOf('a'))).toEqual(before.folder);
    },
    ub: false,
  },
  {
    name: 'U2: reversed after N2, before N3: the service back with the old volume, the old database started alone with its login blocked',
    arrange: () => forwardStopped('main', () => {
      vi.mocked(containerManager.appContainerRunning).mockReset().mockResolvedValueOnce(false).mockResolvedValue(true);
      undoStop.push(() => vi.mocked(containerManager.appContainerRunning).mockReset().mockImplementation(async (id: string) => (id in app ? app[id] : false)));
    }),
    expectEnd: (before, answer) => {
      expectNothingSwapped(before, answer);
      expect(bot().fleetDb).toEqual(before.inst.fleetDb);
      expect(composeOf().services['fleet-postgres'].container_name).toBe(CONTAINER);
      expect(composeOf().volumes['fleet-postgres-data']).toEqual({ name: before.inst.fleetDb!.volume });
      expect(docker.running[CONTAINER]).toBe(true);
      expect(login.canLogin).toBe(false);
      expect(stored().maintenance).toMatchObject({ login: 'blocked' });
    },
    ub: false,
  },
  {
    name: 'U3: reversed after N3, before N4: the swap back; the -new set\'s volume (never made) and folder (never made) pruned',
    arrange: () => forwardStopped('main', () => {
      let swaps = 0;
      const spy = vi.spyOn(containerManager, 'swapKeptData').mockImplementation((...args) => {
        const r = realSwap(...args);
        if (++swaps === 1) throw new Error('the manager stopped here');
        return r;
      });
      undoStop.push(() => spy.mockImplementation(realSwap));
    }),
    expectEnd: (before, answer) => {
      expectMainUndone(before, answer, undefined);
      expect(fs.existsSync(fwd().inDir)).toBe(false);
    },
    ub: true,
  },
  {
    name: 'U4: reversed after N4: the folder step answers done, and the -new set keeps the built folder',
    arrange: () => forwardStopped('main', () => {
      vi.mocked(containerManager.appContainerRunning).mockReset().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
      undoStop.push(() => vi.mocked(containerManager.appContainerRunning).mockReset().mockImplementation(async (id: string) => (id in app ? app[id] : false)));
    }),
    expectEnd: (before, answer) => {
      expectMainUndone(before, answer, newSet(fwd().inDir));
      expect(Object.keys(treeOf(fwd().inDir))).toEqual(['maintenance.json']);
    },
    ub: true,
  },
  {
    name: 'U5: reversed after N5: the kept folder moved back in',
    arrange: () => forwardStopped('main', () => failRename((from) => from === fwd().inDir, 'EPERM: operation not permitted')),
    expectEnd: (before, answer) => {
      expectMainUndone(before, answer, newSet(fwd().inDir));
      expect(Object.keys(treeOf(fwd().inDir))).toEqual(['maintenance.json']);
    },
    ub: true,
  },
  {
    name: 'U6: reversed after N6: the new folder moved out to its build name, then the kept folder moved in',
    arrange: () => forwardStopped('main', () => {
      let writes = 0;
      run.beforeRename = (_from, to) => {
        if (to === composePathOf('a') && ++writes === 2) throw new Error('EROFS: read-only file system');
      };
    }),
    expectEnd: (before, answer) => {
      expectMainUndone(before, answer, newSet(fwd().inDir));
      expect(Object.keys(treeOf(fwd().inDir))).toEqual(['maintenance.json']);
    },
    ub: true,
  },
  {
    name: 'U7: reversed after N8: the new database stopped, its volume kept in the -new set',
    arrange: () => forwardStopped('main', () => {
      db.open = { ok: false, cls: 'other', error: 'the server closed the connection' };
      undoStop.push(() => { db.open = { ok: true }; });
    }, { volume: true }),
    expectEnd: (before, answer) => {
      expectMainUndone(before, answer, newSet(fwd().inDir, newDbOf(before)));
    },
    ub: true,
  },
  {
    name: 'R1: put-back reversed before P3: nothing swapped, the records as they stand',
    arrange: async () => {
      await keptAfterStart('main');
      const after = { inst: bot(), folder: treeOf(dataDirOf('a')), compose: fs.readFileSync(composePathOf('a'), 'utf-8') };
      const spy = vi.spyOn(containerManager, 'takeFleetDbServicesOut').mockReturnValueOnce({ success: false, error: 'EIO: i/o error' });
      expect(await pressBack()).toMatchObject({ success: false, open: true });
      expect(stored().keptOp.step).toBe('db-stopped');
      spy.mockRestore();
      return after;
    },
    expectEnd: (afterStart, answer) => {
      expectNothingSwapped(afterStart, answer, fwd().stamp, afterStart.inst.keptSets);
      expect(bot().fleetDb).toEqual(afterStart.inst.fleetDb);
      expect(treeOf(dataDirOf('a'))).toEqual(afterStart.folder);
      expect(composeOf().volumes['fleet-postgres-data']).toEqual({ name: fwd().newVolume });
    },
    ub: false,
  },
  {
    name: 'R2: put-back reversed after P3, before P4: the swap back; the set returns under its own id and the folder step answers done',
    arrange: putBackStopped(() => failRename((from) => from === dataDirOf('a'), 'EBUSY: resource busy or locked')),
    expectEnd: expectPutBackUndone,
    ub: true,
  },
  {
    name: 'R3: put-back reversed after P5: both renames reversed',
    arrange: putBackStopped(() => {
      let writes = 0;
      run.beforeRename = (_from, to) => {
        if (to === composePathOf('a') && ++writes === 2) throw new Error('EROFS: read-only file system');
      };
    }),
    expectEnd: expectPutBackUndone,
    ub: true,
  },
  {
    name: 'R4: a live copy put-back reversed after P6: the copy brought in stopped and its service removed before the swap back',
    arrange: async () => {
      await keptAfterStart('copy');
      const after = { inst: bot(), folder: treeOf(dataDirOf('a')), compose: fs.readFileSync(composePathOf('a'), 'utf-8') };
      crashOnStep('db-in');
      expect(await pressBack()).toMatchObject({ success: false, open: true });
      expect(docker.running[COPY_CONTAINER]).toBe(true);
      restoreForward();
      return after;
    },
    expectEnd: (afterStart, answer) => {
      expect(answer).toMatchObject({ success: true });
      const now = bot();
      expect(now.fleetDbReplica).toBeUndefined();
      expect(now.fleetJoin).toEqual(afterStart.inst.fleetJoin);
      expect(now.keptSets).toEqual([expect.objectContaining({ id: fwd().stamp, copy: afterStart.inst.keptSets![0].copy, folder: fwd().outDir, join: afterStart.inst.fleetJoin })]);
      expect(treeOf(dataDirOf('a'))).toEqual(afterStart.folder);
      expect(docker.running[COPY_CONTAINER]).toBe(false);
      expect(composeOf().services['fleet-postgres-replica']).toBeUndefined();
      expect(now.keptOp).toBeUndefined();
    },
    ub: true,
  },
];

/** A Put back of the main's kept set stopped by `stop`, its record left open. */
function putBackStopped(stop: () => void): () => Promise<Before> {
  return async () => {
    await keptAfterStart('main');
    const after = { inst: bot(), folder: treeOf(dataDirOf('a')), compose: fs.readFileSync(composePathOf('a'), 'utf-8') };
    stop();
    expect(await pressBack()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp).toMatchObject({ op: 'put-back', asideSet: LATER_STAMP });
    restoreForward();
    return after;
  };
}

/** The end of a reversed put-back of the main's set: the state the forward new-start left, the set back under its own id. */
function expectPutBackUndone(afterStart: Before, answer: unknown): void {
  expect(answer).toMatchObject({ success: true });
  const now = bot();
  expect(now.fleetDb).toEqual(afterStart.inst.fleetDb);
  expect(now.keptOp).toBeUndefined();
  expect(now.keptSets).toEqual([expect.objectContaining({ id: fwd().stamp, db: afterStart.inst.keptSets![0].db, folder: fwd().outDir })]);
  expect(treeOf(dataDirOf('a'))).toEqual(afterStart.folder);
  expect(fs.existsSync(`${dataDirOf('a')}.kept-${LATER_STAMP}`)).toBe(false);
  expect(composeOf().volumes['fleet-postgres-data']).toEqual({ name: fwd().newVolume });
  expect(now.maintenance).toMatchObject({ state: 'off', settled: true });
}

describe('nm31 undo: the reverse from each forward step', () => {
  it.each(cases.map(c => [c.name, c] as const))('%s', async (_n, c) => {
    const before = await c.arrange();
    const answer = await pressBack(fwd().stamp, { reverse: true });
    c.expectEnd(before, answer);
  });

  it('U8: a crash during the reverse leaves undo set; a press goes on from its step to the clean end', async () => {
    const c = cases.find(x => x.name.startsWith('U6'))!;
    const before = await c.arrange();
    crashOnStep('folder');
    expect(await pressBack(fwd().stamp, { reverse: true })).toMatchObject({ success: false, open: true });
    expect(stored().keptOp).toMatchObject({ undo: true, step: 'swapped' });
    expect(bot().keptSets!.map(s => s.id)).toEqual([NEW_ID]);
    restoreForward();
    c.expectEnd(before, await pressBack());
  });
});

describe('nm31 undo: a crash after the undo save, before the first step\'s save, then a press to the clean end', () => {
  it.each(cases.map(c => [c.name.split(':')[0], c] as const))('%s crashed after the undo save', async (_n, c) => {
    const before = await c.arrange();
    if (c.ub) {
      crashOnStep('db-stopped');
    } else {
      vi.mocked(maintenance.runOrderInOp).mockImplementationOnce(async () => { throw new Error('the manager stopped here'); });
    }
    expect(await pressBack(fwd().stamp, { reverse: true })).toMatchObject({ success: false });
    expect(stored().keptOp).toMatchObject({ undo: true, step: 'recorded' });
    restoreForward();
    const steps = stepsSaved();
    const answer = await pressBack();
    c.expectEnd(before, answer);
    if (c.ub) expect(steps).toEqual(['db-stopped', 'db-out', 'swapped', 'folder', 'db-in', 'settled']);
    else expect(steps).toEqual([]);
  });
});

describe('nm31 undo: the reverse skips A7 and waits for the forward lock', () => {
  it('a U-a reverse that crashed during its Off order, leaving Off unsettled, goes on when pressed again', async () => {
    const c = cases.find(x => x.name.startsWith('U2'))!;
    const before = await c.arrange();
    vi.mocked(dbLogin.blockBotLogin).mockResolvedValueOnce({ ok: false, cls: 'other', error: 'permission denied to alter role' });
    vi.mocked(maintenance.runOrderInOp).mockImplementationOnce(async (...args) => {
      await realOrder(...args);
      throw new Error('the manager stopped here');
    });
    expect(await pressBack(fwd().stamp, { reverse: true })).toMatchObject({ success: false });
    expect(stored().maintenance).toMatchObject({ state: 'off', settled: false });
    expect(stored().keptOp).toMatchObject({ undo: true, step: 'recorded' });
    c.expectEnd(before, await pressBack());
  });

  it('a first reverse press on a put-back whose Off order did not settle and whose close failed is not refused T-A-UNSETTLED', async () => {
    await keptAfterStart('main');
    const afterStart = { inst: bot(), folder: treeOf(dataDirOf('a')), compose: fs.readFileSync(composePathOf('a'), 'utf-8') };
    vi.mocked(dbLogin.blockBotLogin).mockResolvedValueOnce({ ok: false, cls: 'other', error: 'permission denied to alter role' });
    vi.mocked(maintenance.runOrderInOp).mockImplementationOnce(async (...args) => {
      const r = await realOrder(...args);
      orders.push(r);
      app.a = true;
      return r;
    });
    expect(await pressBack()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.step).toBe('settled');
    expect(stored().maintenance).toMatchObject({ state: 'off', settled: false });
    app.a = false;
    const answer = await pressBack(fwd().stamp, { reverse: true });
    expectPutBackUndone(afterStart, answer);
  });

  it('the reverse is refused with the busy text while the forward run holds new-database', async () => {
    await seed.seedMain();
    answerOrders();
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    let reached!: () => void;
    const atUp = new Promise<void>(r => { reached = r; });
    run.execOverrides.push({ match: c => c.endsWith('up -d fleet-postgres'), answer: async () => { reached(); await held; docker.running[CONTAINER] = true; return { ok: true }; } });
    const running = startOnNewDatabase('a');
    await atUp;
    expect(await pressBack(fwd().stamp, { reverse: true })).toEqual({ success: false, status: 409, error: "Operation 'new-database' already in progress" });
    expect(stored().keptOp.undo).toBeUndefined();
    release();
    expect(await running).toMatchObject({ success: true });
  });
});

describe('nm31 undo: code review 1, fix 2', () => {
  it('B4 (code review 1): a reverse that stops answers with its own ending, with no Put back to press', async () => {
    const c = cases.find(x => x.name.startsWith('U6'))!;
    await c.arrange();
    crashOnStep('folder');
    const answer = await pressBack(fwd().stamp, { reverse: true });
    expect(answer).toMatchObject({ success: false, open: true });
    expect(stored().keptOp).toMatchObject({ undo: true, step: 'swapped' });
    const error = (answer as { error: string }).error;
    expect(error.endsWith('Run it again to finish going back to the earlier data; until it finishes, the bot stays stopped and Start is refused.')).toBe(true);
    expect(error).not.toContain('Put back again');
  });
});
