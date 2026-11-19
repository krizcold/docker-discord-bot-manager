import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm37-tick-'));
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
import * as fleetSwitch from '../../src/instance/fleetSwitch';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { deleteKept, startOnNewDatabase } from '../../src/instance/keptData';
import { docker, resetDocker } from './nm2-docker';
import { clearRegistry, registryPath } from './nm2-harness';
import { resetRun, run } from './nm31-run';
import { app, CONTAINER, dataDirOf, resetSeed, seedMain, stored } from './nm31-seed';
import { answerOrders, bot, fwd, keptAfterStart, pressBack, resetBack } from './nm31-back';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const STOP_ERROR = 'Error response from daemon: cannot stop container: bota-fleet-postgres: permission denied';
const realSave = containerManager.saveKeptOpIf;

/** Throws once from the save of `step`; every other save runs. */
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

async function fixture(): Promise<string> {
  await seedMain();
  answerOrders();
  const kept = bot().fleetDb!.volume;
  run.volumes[kept] = 'exists';
  return kept;
}

/** A forward run left open with the record at `step`. */
async function openAt(step: 'swapped' | 'folder' | 'db-in' | 'db-up' | 'login'): Promise<void> {
  await fixture();
  if (step === 'login') {
    // The app is found running once the login step is saved, so the run stops at its last read.
    vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation((id, key, patch) => {
      if (patch.step === 'login') app.a = true;
      return realSave(id, key, patch);
    });
  } else {
    crashOnStep({ swapped: 'folder', folder: 'db-in', 'db-in': 'db-up', 'db-up': 'login' }[step]);
  }
  expect(await startOnNewDatabase('a')).toMatchObject({ success: false, open: true });
  app.a = false;
  vi.mocked(containerManager.saveKeptOpIf).mockRestore();
  expect(stored().keptOp).toMatchObject({ op: 'new-start', step });
  expect(bot().fleetDb!.volume).toBe(fwd().newVolume);
  run.volumes[fwd().newVolume] = 'exists';
}

/** Put back pressed on the open record, its first stop answered by docker's error, so the reverse stays open with the container running. */
async function reverseStopped(): Promise<void> {
  docker.overrides.unshift({ match: a => a[0] === 'stop', answer: { ok: false, stderr: STOP_ERROR } });
  expect(await pressBack(fwd().stamp, { reverse: true })).toMatchObject({ success: false, open: true });
  expect(stored().keptOp).toMatchObject({ op: 'new-start', undo: true });
  expect(stored().keptOp.lastError).toContain(STOP_ERROR);
  expect(bot().fleetDb!.volume).toBe(fwd().newVolume);
}

/** One pass of the switch check with the database container running; the registry file before it. */
async function tick(): Promise<string> {
  vi.mocked(fleetSwitch.ensureMainGeneration).mockRestore();
  docker.running[CONTAINER] = true;
  run.psqlCalls.length = 0;
  docker.calls.length = 0;
  const before = fs.readFileSync(registryPath(), 'utf-8');
  await fleetSwitch.switchTick(NOW);
  expect(docker.calls.filter(a => a[0] === 'inspect' && a[2] === '{{.State.Running}}' && a[3] === CONTAINER).length).toBeGreaterThan(0);
  return before;
}

const meta = () => run.psqlCalls.filter(c => c.login === 'dbm_meta');

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  resetDocker();
  resetRun();
  clearRegistry();
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.rmSync(path.join(h.dir, 'backups'), { recursive: true, force: true });
  resetSeed();
  resetBack();
  dbLogin.resetManagerRoleCache();
  fleetSwitch.resetSwitchState();
});
afterEach(() => {
  releaseFleetBackupBusy('a');
  vi.restoreAllMocks();
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('nm37 tick: the switch check leaves an unchecked new database alone', () => {
  it.each([['swapped'], ['folder'], ['db-in']] as const)('K1: a forward record at %s with the container running: no database call, the registry unchanged', async (step) => {
    await openAt(step);
    const before = await tick();
    expect(run.psqlCalls).toEqual([]);
    expect(docker.calls.filter(a => a.includes('psql'))).toEqual([]);
    expect(fs.readFileSync(registryPath(), 'utf-8')).toBe(before);
  });

  it('K1r: a record at db-in, then Put back whose stop of the database fails: no database call', async () => {
    await openAt('db-in');
    await reverseStopped();
    await tick();
    expect(run.psqlCalls).toEqual([]);
  });

  it('K1o: a record at login, then Put back whose stop of the database fails: also skipped', async () => {
    await openAt('login');
    await reverseStopped();
    await tick();
    expect(run.psqlCalls).toEqual([]);
  });

  it.each([['db-up'], ['login']] as const)('K2 (the control): a forward record at %s: the check reads the generation row as dbm_meta', async (step) => {
    await openAt(step);
    await tick();
    expect(meta().length).toBeGreaterThan(0);
  });

  it('K2 (the control): after the run ended done: the check reads the generation row', async () => {
    await fixture();
    expect(await startOnNewDatabase('a')).toMatchObject({ success: true });
    expect(bot().keptOp).toBeUndefined();
    await tick();
    expect(meta().length).toBeGreaterThan(0);
  });

  it('K2: an open put-back record (Put back of a kept set stopped at its folder step): the check runs', async () => {
    await keptAfterStart('main');
    let done = false;
    run.beforeRename = (from) => {
      if (!done && from === dataDirOf('a')) {
        done = true;
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
    };
    expect(await pressBack()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp).toMatchObject({ op: 'put-back', step: 'swapped' });
    await tick();
    expect(meta().length).toBeGreaterThan(0);
  });

  it('K2: an open delete record: the check runs', async () => {
    await keptAfterStart('main');
    expect(await deleteKept('a', fwd().stamp)).toMatchObject({ success: false, open: true });
    expect(stored().keptOp).toMatchObject({ op: 'delete' });
    await tick();
    expect(meta().length).toBeGreaterThan(0);
  });
});
