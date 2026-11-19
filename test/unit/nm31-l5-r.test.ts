import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-l5-r-'));
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
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import * as fleetBackup from '../../src/instance/fleetBackup';
import * as appCapabilities from '../../src/config/appCapabilities';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { KEPT_TEXT, newStartDone, startOnNewDatabase } from '../../src/instance/keptData';
import { docker, resetDocker } from './nm2-docker';
import { clearRegistry, registryPath, seedBot } from './nm2-harness';
import { resetRun, run } from './nm31-run';
import { answerDatabase, composePathOf, CONTAINER, COPY_CONTAINER, psqlAnswer, resetSeed, seedCopy, seedExternal, seedMain, SMDB, stored } from './nm31-seed';
import type { InstanceConfig } from '../../src/types';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const NO_ANSWER = 'docker did not say whether the bot runs';
const CLOSED = 'Start on a new database stopped: the record was closed while this ran; nothing more was done';
const realSave = containerManager.saveKeptOpIf;
const realGetBot = containerManager.getBot;
const press = () => startOnNewDatabase('a');
const bot = (): InstanceConfig => containerManager.getBot('a')!;
const envUrl = () => envManager.getEnvVars('a').DATA_BACKEND_URL;
const STOP_FAILS = { match: (a: string[]) => a[0] === 'stop', answer: { ok: false, stderr: 'Error response from daemon: cannot stop container: permission denied' } };

function opened(reason: string, status: number) {
  const rec = stored().keptOp;
  expect(rec.lastError).toBe(reason);
  return { success: false, status, open: true, error: KEPT_TEXT.nOpen(reason, newStartDone(rec)) };
}

function editRegistry(edit: (inst: any) => void): void {
  const reg = JSON.parse(fs.readFileSync(registryPath(), 'utf-8'));
  edit(reg.instances.a);
  fs.writeFileSync(registryPath(), JSON.stringify(reg, null, 2));
}

/** saveKeptOpIf with `pick` deciding per patch: 'throw', 'closed', or the real save. */
function saves(pick: (patch: Record<string, unknown>) => 'throw' | 'closed' | 'real') {
  return vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation((id, key, patch) => {
    const how = pick(patch as Record<string, unknown>);
    if (how === 'throw') throw new Error('disk full');
    if (how === 'closed') return containerManager.KEPT_RECORD_CLOSED;
    return realSave(id, key, patch);
  });
}
const isBegin = (p: Record<string, unknown>) => 'lastError' in p && p.lastError === undefined && 'folderGone' in p && !('step' in p);
const isStop = (p: Record<string, unknown>) => typeof p.lastError === 'string';

async function again(): Promise<void> {
  vi.restoreAllMocks();
  setUp();
  await seedMain();
}

function setUp(): void {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  resetDocker();
  resetRun();
  clearRegistry();
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  resetSeed();
}
beforeEach(setUp);
afterEach(() => {
  releaseFleetBackupBusy('a');
  vi.restoreAllMocks();
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('nm31 l5 r: runNewStart before N1', () => {
  it('the bot gone when the run reads it answers 404 Bot not found', async () => {
    await seedMain();
    answerDatabase();
    let calls = 0;
    let atBegin = -1;
    const spy = vi.spyOn(containerManager, 'getBot').mockImplementation((id: string) => { calls++; return realGetBot(id); });
    saves(p => { if (isBegin(p) && atBegin < 0) atBegin = calls; return 'real'; });
    docker.overrides.unshift(STOP_FAILS);
    await press();
    expect(atBegin).toBeGreaterThan(0);
    spy.mockRestore();
    await again();
    answerDatabase();
    let n = 0;
    vi.spyOn(containerManager, 'getBot').mockImplementation((id: string) => (++n === atBegin ? null : realGetBot(id)));
    expect(await press()).toEqual({ success: false, status: 404, error: 'Bot not found' });
  });

  it('a failed begin save opens the record with the save text, logs the stop, and the stop save failing logs that too', async () => {
    await seedMain();
    answerDatabase();
    saves(p => (isBegin(p) ? 'throw' : 'real'));
    const answer = await press();
    expect(answer).toEqual(opened('the record could not be saved (disk full)', 500));
    expect(console.warn).toHaveBeenCalledWith(`[KeptData] ${bot().displayName}: Start on a new database stopped at step recorded: the record could not be saved (disk full)`);
    await again();
    answerDatabase();
    saves(p => (isBegin(p) || isStop(p) ? 'throw' : 'real'));
    expect(await press()).toMatchObject({ success: false, status: 500, open: true });
    expect(console.error).toHaveBeenCalledWith(`[KeptData] ${bot().displayName}: the stop of Start on a new database could not be recorded: disk full`);
  });

  it('a begin save that finds the record closed answers the closed text and runs no step', async () => {
    await seedMain();
    answerDatabase();
    saves(p => (isBegin(p) ? 'closed' : 'real'));
    docker.calls.length = 0;
    expect(await press()).toEqual({ success: false, status: 409, error: CLOSED });
    expect(docker.calls.some(a => a[0] === 'stop')).toBe(false);
  });

  it('a step save that throws opens with the save text; one that finds the record closed answers the closed text', async () => {
    await seedMain();
    answerDatabase();
    saves(p => (p.step === 'db-stopped' ? 'throw' : 'real'));
    expect(await press()).toEqual(opened('the record could not be saved (disk full)', 500));
    expect(stored().keptOp.step).toBe('recorded');
    await again();
    answerDatabase();
    saves(p => (p.step === 'db-stopped' ? 'closed' : 'real'));
    expect(await press()).toEqual({ success: false, status: 409, error: CLOSED });
  });

  it('the app no longer declaring its state file opens the record with that reason', async () => {
    await seedExternal('a', { certs: true });
    answerDatabase();
    let begun = false;
    saves(p => { if (isBegin(p)) begun = true; return 'real'; });
    const real = appCapabilities.findAppCapabilities;
    vi.spyOn(appCapabilities, 'findAppCapabilities').mockImplementation((url: string | null | undefined) => (begun ? null : real(url)));
    expect(await press()).toEqual(opened('this app no longer declares the file its maintenance state is saved in', 409));
  });

  it('a main start resumed at db-stopped whose database left the instance opens with the database text', async () => {
    await seedMain();
    answerDatabase();
    fs.rmSync(composePathOf('a'));
    fs.mkdirSync(composePathOf('a'));
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.step).toBe('db-stopped');
    editRegistry(i => { delete i.fleetDb; });
    docker.calls.length = 0;
    expect(await press()).toEqual(opened('the instance no longer holds the database the record names', 409));
    expect(docker.calls.filter(a => a[0] === 'stop' || a[0] === 'sh')).toEqual([]);
  });

  it('a main start resumed at db-stopped whose database left the instance opens with the database text though an older set keeps a database', async () => {
    await seedMain();
    answerDatabase();
    fs.rmSync(composePathOf('a'));
    fs.mkdirSync(composePathOf('a'));
    expect(await press()).toMatchObject({ success: false, open: true });
    editRegistry(i => {
      i.keptSets = [{ id: '20261001-000000', keptAt: '2026-10-01T00:00:00.000Z', by: 'new-start', folder: path.join(h.dir, 'older'), db: { ...i.fleetDb, volume: 'bota_older' } }];
      delete i.fleetDb;
    });
    docker.calls.length = 0;
    expect(await press()).toEqual(opened('the instance no longer holds the database the record names', 409));
    expect(docker.calls.filter(a => a[0] === 'stop' || a[0] === 'sh')).toEqual([]);
  });

  it('a copy start resumed at recorded whose live copy left the instance opens with the live copy text', async () => {
    await seedCopy();
    answerDatabase();
    docker.overrides.unshift(STOP_FAILS);
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.step).toBe('recorded');
    docker.overrides.shift();
    editRegistry(i => { delete i.fleetDbReplica; });
    docker.calls.length = 0;
    expect(await press()).toEqual(opened('the instance no longer holds the live copy the record names', 409));
    expect(docker.calls.filter(a => a[0] === 'stop' || a[0] === 'sh')).toEqual([]);
  });

  it('docker not saying whether the app runs at the stopped read opens with the no-answer text', async () => {
    await seedExternal('a', { certs: true });
    answerDatabase();
    vi.mocked(containerManager.appContainerRunning).mockReset().mockResolvedValueOnce(false).mockResolvedValue(null);
    expect(await press()).toEqual(opened(NO_ANSWER, 409));
    expect(stored().keptOp.step).toBe('recorded');
    expect(stored().keptSets).toBeUndefined();
  });

  it('docker not saying whether the copy container runs at the stopped read opens with the no-answer text', async () => {
    await seedCopy();
    answerDatabase();
    const real = containerManager.containerRunningExact;
    let begun = false;
    saves(p => { if (p.step === 'db-out') begun = true; return 'real'; });
    vi.spyOn(containerManager, 'containerRunningExact').mockImplementation(async (name: string) => (begun && name === COPY_CONTAINER ? null : real(name)));
    expect(await press()).toEqual(opened(NO_ANSWER, 409));
    expect(stored().keptOp.step).toBe('db-out');
  });

  it('the database gone from the instance between the run\'s two reads opens with the database text at the re-check', async () => {
    await seedMain();
    answerDatabase();
    let begun = false;
    saves(p => { if (isBegin(p)) begun = true; return 'real'; });
    const real = appCapabilities.findAppCapabilities;
    vi.spyOn(appCapabilities, 'findAppCapabilities').mockImplementation((url: string | null | undefined) => {
      if (begun) editRegistry(i => { delete i.fleetDb; });
      return real(url);
    });
    docker.calls.length = 0;
    expect(await press()).toEqual(opened('the instance no longer holds the database the record names', 409));
    expect(docker.calls.some(a => a[0] === 'stop')).toBe(false);
  });
});

describe('nm31 l5 r: the re-check\'s refusal and the sharers it adds', () => {
  function sharerB(): void {
    seedBot({ sourceUrl: SMDB, status: 'stopped' }, 'b');
    envManager.setEnvVars('b', { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: envUrl() });
    let started = false;
    vi.spyOn(fleetBackup, 'runningDatabaseSharers').mockImplementation(async () => ({ bots: [bot(), containerManager.getBot('b')!], unchecked: [] }));
    vi.spyOn(containerManager, 'liveContainerNames').mockImplementation(async (id: string) => (id === 'b' && started ? ['botb-app-1'] : []));
    run.psql = (c) => {
      if (c.login === 'dbm_meta') started = true;
      return psqlAnswer(c);
    };
  }
  const refusal = () => KEPT_TEXT.aSharers(['Bot b']);

  it('a close that throws opens the record with the refusal and the close text, at 500', async () => {
    await seedMain();
    sharerB();
    answerDatabase();
    vi.spyOn(containerManager, 'closeKeptOp').mockImplementation(() => { throw new Error('disk full'); });
    const text = refusal();
    expect(text.endsWith('; nothing was changed')).toBe(true);
    expect(await press()).toEqual(opened(`${text.slice(0, -'; nothing was changed'.length)}; the record could not be closed (disk full)`, 500));
  });

  it('a close that finds the record closed answers the closed text', async () => {
    await seedMain();
    sharerB();
    answerDatabase();
    vi.spyOn(containerManager, 'closeKeptOp').mockReturnValue(containerManager.KEPT_RECORD_CLOSED);
    expect(await press()).toEqual({ success: false, status: 409, error: CLOSED });
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('refused before N1'));
  });

  it('a close that succeeds logs the refusal', async () => {
    await seedMain();
    sharerB();
    answerDatabase();
    expect(await press()).toEqual({ success: false, status: 409, error: refusal() });
    expect(console.warn).toHaveBeenCalledWith(`[KeptData] ${bot().displayName}: Start on a new database refused before N1, record closed: ${refusal()}`);
  });

  it('a sharer found only at the re-check is added to the record; none found saves no sharers', async () => {
    await seedMain();
    answerDatabase();
    const real = fleetBackup.databaseSharers;
    let calls = 0;
    vi.spyOn(fleetBackup, 'databaseSharers').mockImplementation((inst: InstanceConfig, url: string) => {
      const found = real(inst, url);
      return ++calls > 1 ? [...found, { id: 'b' } as InstanceConfig] : found;
    });
    docker.overrides.unshift(STOP_FAILS);
    const spy = saves(() => 'real');
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(calls).toBe(2);
    expect(stored().keptOp.sharers).toEqual(['b']);
    expect(spy.mock.calls.filter(c => 'sharers' in c[2])).toHaveLength(1);
  });

  it('no new sharer at the re-check: no save of sharers', async () => {
    await seedMain();
    answerDatabase();
    docker.overrides.unshift(STOP_FAILS);
    const spy = saves(() => 'real');
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(spy.mock.calls.filter(c => 'sharers' in c[2])).toHaveLength(0);
    expect(stored().keptOp.sharers).toEqual([]);
  });
});
