import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-l5-s-'));
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
import * as dbLogin from '../../src/instance/dbLogin';
import * as fleetBackup from '../../src/instance/fleetBackup';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { KEPT_TEXT, newStartDone, newStartNames, startOnNewDatabase } from '../../src/instance/keptData';
import { docker, resetDocker } from './nm2-docker';
import { clearRegistry, seedBot } from './nm2-harness';
import { resetRun, run } from './nm31-run';
import { answerDatabase, composePathOf, CONTAINER, COPY_CONTAINER, dataDirOf, db, patchRegistry, resetSeed, seedCopy, seedExternal, seedMain, SMDB, stored } from './nm31-seed';
import type { InstanceConfig } from '../../src/types';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const ISO = new Date(NOW).toISOString();
const names = () => newStartNames({ sanitizedName: 'bota' }, dataDirOf('a'), NOW);
const realSave = containerManager.saveKeptOpIf;
const realGetBot = containerManager.getBot;
const realStatus = envManager.getEnvVarsWithStatus;
const realOut = containerManager.takeFleetDbServicesOut;
const CLOSED = `Start on a new database stopped: ${containerManager.KEPT_RECORD_CLOSED}; nothing more was done`;
const STOP_DENIED = 'Error response from daemon: cannot stop container: permission denied';

const bot = (): InstanceConfig => containerManager.getBot('a')!;
const envUrl = () => envManager.getEnvVars('a').DATA_BACKEND_URL;
const press = () => startOnNewDatabase('a');

function opened(reason: string, status = 409) {
  const rec = stored().keptOp;
  expect(rec).toBeTruthy();
  expect(rec.lastError).toBe(reason);
  return { success: false, status, open: true, error: KEPT_TEXT.nOpen(reason, newStartDone(rec)) };
}

/** A press whose N1 stop is refused, so the record stays at 'recorded'. */
async function openAtRecorded(): Promise<void> {
  docker.overrides.unshift({ match: a => a[0] === 'stop', answer: { ok: false, stderr: STOP_DENIED } });
  expect(await press()).toMatchObject({ success: false, open: true });
  expect(stored().keptOp.step).toBe('recorded');
  docker.overrides.shift();
}

/** Bot b, stopped, on a's database, seeded after a's record opened. */
function stoppedSharerB(): void {
  seedBot({ sourceUrl: SMDB, status: 'stopped' }, 'b');
  envManager.setEnvVars('b', { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: envUrl() });
  vi.spyOn(fleetBackup, 'runningDatabaseSharers').mockImplementation(async () => ({ bots: [bot(), containerManager.getBot('b')!], unchecked: [] }));
  vi.spyOn(containerManager, 'liveContainerNames').mockImplementation(async () => []);
}

/** True once N2 took the database's service out. */
function afterN2(): () => boolean {
  let out = false;
  vi.spyOn(containerManager, 'takeFleetDbServicesOut').mockImplementation((id) => {
    const r = realOut(id);
    out = true;
    return r;
  });
  return () => out;
}

/** The env store as read after `when`, with the Database URL replaced by `url` or the read throwing. */
function envAfter(when: () => boolean, url: string | Error): void {
  vi.spyOn(envManager, 'getEnvVarsWithStatus').mockImplementation((id) => {
    const s = realStatus(id);
    if (!when() || id !== 'a') return s;
    if (url instanceof Error) throw url;
    return { ...s, vars: { ...s.vars, DATA_BACKEND_URL: url } };
  });
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

describe('nm31 l5 s: the re-check before N1 adds a sharer found since the record', () => {
  it('the sharer is saved in the record', async () => {
    await seedMain();
    answerDatabase();
    await openAtRecorded();
    expect(stored().keptOp.sharers).toEqual([]);
    stoppedSharerB();
    db.open = { ok: false, cls: 'other', error: 'the server closed the connection' };
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp).toMatchObject({ step: 'db-up', sharers: ['b'] });
  });

  it('the done text names the sharer found by the re-check', async () => {
    await seedMain();
    answerDatabase();
    const oldDb = bot().fleetDb!;
    await openAtRecorded();
    stoppedSharerB();
    const n = names();
    const answer = await press();
    expect(answer).toEqual({
      success: true,
      text: KEPT_TEXT.nDoneMain({ old: oldDb.volume, outDir: n.outDir, newVolume: n.newVolume, certs: false, replication: false, sharers: containerManager.getBot('b')!.displayName }),
    });
  });

  it('the sharers save throws: open with the 500 text, nothing stopped', async () => {
    await seedMain();
    answerDatabase();
    await openAtRecorded();
    stoppedSharerB();
    vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation((id, key, patch) => {
      if (patch.sharers) throw new Error('EIO: i/o error');
      return realSave(id, key, patch);
    });
    docker.calls.length = 0;
    const answer = await press();
    expect(answer).toEqual(opened('the record could not be saved (EIO: i/o error)', 500));
    expect(docker.calls.filter(a => a[0] === 'stop')).toEqual([]);
  });

  it('the sharers save finds the record closed: the closed answer, nothing stopped', async () => {
    await seedMain();
    answerDatabase();
    await openAtRecorded();
    stoppedSharerB();
    vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation((id, key, patch) => (patch.sharers ? containerManager.KEPT_RECORD_CLOSED : realSave(id, key, patch)));
    docker.calls.length = 0;
    expect(await press()).toEqual({ success: false, status: 409, error: CLOSED });
    expect(docker.calls.filter(a => a[0] === 'stop')).toEqual([]);
  });
});

describe('nm31 l5 s: N1 to N3', () => {
  it('N1 forgets the manager role of the stopped database', async () => {
    await seedMain();
    answerDatabase();
    fs.rmSync(composePathOf('a'));
    fs.mkdirSync(composePathOf('a'));
    const forget = vi.spyOn(dbLogin, 'forgetManagerRole');
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.step).toBe('db-stopped');
    expect(forget.mock.calls).toEqual([[CONTAINER]]);
  });

  it('N2c: a removal that fails with no error text opens with the fallback reason', async () => {
    await seedCopy();
    answerDatabase();
    vi.spyOn(containerManager, 'removeFleetDbReplicaService').mockResolvedValue({ success: false } as any);
    const answer = await press();
    expect(answer).toEqual(opened('the live copy\'s service could not be removed'));
    expect(stored().keptOp.step).toBe('db-stopped');
    expect(docker.running[COPY_CONTAINER]).toBe(false);
  });

  it('a resume after N7 saves only the later steps: N3 and the folder loop are not run again', async () => {
    await seedMain();
    answerDatabase();
    let crashed = false;
    vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation((id, key, patch) => {
      if (!crashed && patch.step === 'db-up') {
        crashed = true;
        throw new Error('the manager stopped here');
      }
      return realSave(id, key, patch);
    });
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.step).toBe('db-in');
    const steps: unknown[] = [];
    vi.mocked(containerManager.saveKeptOpIf).mockImplementation((id, key, patch) => {
      if (patch.step) steps.push(patch.step);
      return realSave(id, key, patch);
    });
    const swap = vi.spyOn(containerManager, 'swapKeptData');
    expect(await press()).toMatchObject({ success: true });
    expect(steps).toEqual(['db-up', 'login']);
    expect(swap).not.toHaveBeenCalled();
  });

  it('N3: the bot gone from the registry answers Bot not found', async () => {
    await seedMain();
    answerDatabase();
    const out = afterN2();
    vi.spyOn(containerManager, 'getBot').mockImplementation((id) => (out() ? null : realGetBot(id)));
    expect(await press()).toEqual({ success: false, status: 404, error: 'Bot not found' });
    expect(stored().keptOp.step).toBe('db-out');
  });

  it('N3: another kept set on the bot does not stand for this run\'s set', async () => {
    await seedMain();
    patchRegistry('a', { keptSets: [{ id: '20261101-000000', keptAt: '2026-11-01T00:00:00.000Z', by: 'new-start', folder: path.join(h.dir, 'elsewhere') }] });
    answerDatabase();
    const answer = await press();
    expect(answer).toMatchObject({ success: true });
    expect(bot().fleetDb!.volume).toBe(names().newVolume);
    expect(bot().keptSets!.map(s => s.id)).toEqual(['20261101-000000', names().stamp]);
  });

  it('N3: a folder start does not read the Database URL', async () => {
    await seedExternal('a', { certs: true });
    answerDatabase();
    envAfter(() => !!stored().keptOp, new Error('EACCES: permission denied'));
    expect(await press()).toMatchObject({ success: true });
    expect(bot().keptSets!.map(s => s.id)).toEqual([names().stamp]);
  });

  it('N3: the env store unreadable opens with the unknown-password reason', async () => {
    await seedMain();
    answerDatabase();
    envAfter(afterN2(), new Error('EACCES: permission denied'));
    expect(await press()).toEqual(opened('the env store could not be read, so the Database URL\'s password is unknown'));
    expect(stored().keptOp.step).toBe('db-out');
    expect(bot().keptSets).toBeUndefined();
  });

  it('N3: a Database URL with no password opens, the swap not run', async () => {
    await seedMain();
    answerDatabase();
    const fleetDb = bot().fleetDb;
    envAfter(afterN2(), `postgresql://smdb@${CONTAINER}:5432/smdb`);
    expect(await press()).toEqual(opened('the Database URL holds no password for the bot\'s login'));
    expect(bot().fleetDb).toEqual(fleetDb);
    expect(bot().keptSets).toBeUndefined();
  });

  it('N3: a password that does not decode opens, the swap not run', async () => {
    await seedMain();
    answerDatabase();
    envAfter(afterN2(), `postgresql://smdb:%E0@${CONTAINER}:5432/smdb`);
    expect(await press()).toEqual(opened('the Database URL holds no password for the bot\'s login'));
    expect(bot().keptSets).toBeUndefined();
  });

  it('N3: the swap finds the record closed: the closed answer, no folder made', async () => {
    await seedMain();
    answerDatabase();
    vi.spyOn(containerManager, 'swapKeptData').mockReturnValue(containerManager.KEPT_RECORD_CLOSED);
    expect(await press()).toEqual({ success: false, status: 409, error: CLOSED });
    expect(fs.existsSync(names().inDir)).toBe(false);
  });
});

describe('nm31 l5 s: the folder loop', () => {
  it('a new folder left partial after each build is built four times, then the run opens', async () => {
    await seedMain();
    answerDatabase();
    let builds = 0;
    run.afterRename = (from, to) => {
      if (from.endsWith('maintenance.json.tmp') && ++builds <= 6) fs.writeFileSync(to, '{}');
    };
    const answer = await press();
    expect(stored().keptOp.lastError).toBe('the data folders did not reach the end state of this start');
    expect(answer).toMatchObject({ success: false, open: true });
    expect(builds).toBe(4);
    expect(stored().keptOp.step).toBe('swapped');
  });
});
