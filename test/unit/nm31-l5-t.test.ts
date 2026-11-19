import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-l5-t-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, lstatHook: null as null | ((p: string) => void), readdirHook: null as null | ((p: string, o: unknown) => void) };
});

vi.mock('child_process', async (importOriginal) => (await import('./nm31-run')).childProcessMock(await importOriginal(), require('fs')));
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const base = (await import('./nm31-run')).fsMock(real) as Record<string, any>;
  const lstatSync = (p: import('fs').PathLike, o?: unknown) => {
    h.lstatHook?.(String(p));
    return base.lstatSync(p, o);
  };
  const readdirSync = (p: import('fs').PathLike, o?: unknown) => {
    h.readdirHook?.(String(p), o);
    return (real.readdirSync as any)(p, o);
  };
  const wrap = { lstatSync, readdirSync };
  return { ...base, ...wrap, default: { ...base.default, ...wrap } };
});
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
import * as dbLogin from '../../src/instance/dbLogin';
import * as fleetReplication from '../../src/instance/fleetReplication';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { KEPT_TEXT, newStartNames, startOnNewDatabase } from '../../src/instance/keptData';
import { resetDocker } from './nm2-docker';
import { clearRegistry } from './nm2-harness';
import { resetRun, run } from './nm31-run';
import { answerDatabase, app, CONTAINER, COPY_VOLUME, dataDirOf, db, patchRegistry, resetSeed, seedCopy, seedMain, stored } from './nm31-seed';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const names = () => newStartNames({ sanitizedName: 'bota' }, dataDirOf('a'), NOW);
const realSave = containerManager.saveKeptOpIf;
const press = () => startOnNewDatabase('a');

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

/** The first press stops with the data folder not yet set aside and the new folder built at inDir (record at 'swapped'). */
async function stopBeforeMoveOut(): Promise<void> {
  let done = false;
  run.beforeRename = (from) => {
    if (!done && from === dataDirOf('a')) {
      done = true;
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    }
  };
  expect(await press()).toMatchObject({ success: false, open: true });
  expect(stored().keptOp.step).toBe('swapped');
  run.beforeRename = null;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  h.lstatHook = null;
  h.readdirHook = null;
  resetDocker();
  resetRun();
  clearRegistry();
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  resetSeed();
});
afterEach(() => {
  h.lstatHook = null;
  h.readdirHook = null;
  releaseFleetBackupBusy('a');
  vi.restoreAllMocks();
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('nm31 l5 t: the folder loop', () => {
  it('a data folder read that fails in the loop opens with the read error', async () => {
    await seedMain();
    answerDatabase();
    let armed = false;
    const realSwap = containerManager.swapKeptData;
    vi.spyOn(containerManager, 'swapKeptData').mockImplementation((...args) => {
      const r = realSwap(...args);
      armed = true;
      return r;
    });
    h.lstatHook = (p) => {
      if (armed && p === dataDirOf('a')) {
        armed = false;
        throw Object.assign(new Error('EIO: i/o error, lstat'), { code: 'EIO' });
      }
    };
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.lastError).toBe('the data folders could not be read (EIO: i/o error, lstat)');
  });

  it('a read of the brought-in folder that fails opens with the read error', async () => {
    await seedMain();
    answerDatabase();
    let armed = true;
    h.readdirHook = (p, o) => {
      if (armed && p === dataDirOf('a') && (o as { withFileTypes?: boolean } | undefined)?.withFileTypes && !fs.existsSync(names().inDir) && fs.existsSync(names().outDir)) {
        armed = false;
        throw Object.assign(new Error('EIO: i/o error, scandir'), { code: 'EIO' });
      }
    };
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.lastError).toBe('the data folders could not be read (EIO: i/o error, scandir)');
  });

  it('a clean run settles the loop and ends done', async () => {
    await seedMain();
    answerDatabase();
    expect(await press()).toMatchObject({ success: true });
    expect(stored().keptOp).toBeUndefined();
  });

  it('a kept folder away for one read after the move-in: the loop stops at that read, though a later read would show done', async () => {
    await seedMain();
    answerDatabase();
    const away = `${names().outDir}.away`;
    let reads = 0;
    run.afterRename = (from) => {
      if (from === names().inDir && !fs.existsSync(away)) fs.renameSync(names().outDir, away);
    };
    h.lstatHook = (p) => {
      if (p === names().outDir && fs.existsSync(away) && ++reads === 2) fs.renameSync(away, names().outDir);
    };
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.lastError).toBe('the data folders did not reach the end state of this start');
    expect(stored().keptOp.step).toBe('swapped');
  });

  it('the data folder set aside outside and the new folder removed: the plain refusal, not a foreign-files text', async () => {
    await seedMain();
    answerDatabase();
    await stopBeforeMoveOut();
    fs.renameSync(dataDirOf('a'), names().outDir);
    fs.rmSync(names().inDir, { recursive: true, force: true });
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.lastError).toBe('no complete new folder to bring in');
  });

  it('a foreign file in the new folder names the new folder', async () => {
    await seedMain();
    answerDatabase();
    await stopBeforeMoveOut();
    fs.writeFileSync(path.join(names().inDir, 'junk'), 'x');
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.lastError).toBe(KEPT_TEXT.nNotOurs(names().inDir, ['junk']));
  });

  it('files in a new data folder beside a set-aside folder and a built new folder name the data folder', async () => {
    await seedMain();
    answerDatabase();
    await stopBeforeMoveOut();
    fs.renameSync(dataDirOf('a'), names().outDir);
    fs.mkdirSync(dataDirOf('a'));
    fs.writeFileSync(path.join(dataDirOf('a'), 'stray'), 'x');
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.lastError).toBe(KEPT_TEXT.nNotOurs(dataDirOf('a'), ['stray']));
  });
});

describe('nm31 l5 t: N7 to N9', () => {
  it('a fleetDb on another volume at the resume opens and writes no service', async () => {
    await seedMain();
    answerDatabase();
    crashOnStep('db-in');
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.step).toBe('folder');
    patchRegistry('a', { fleetDb: { ...stored().fleetDb, volume: 'bota-fleet-postgres-data-other' } });
    const write = vi.spyOn(containerManager, 'writeFleetDbService');
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.lastError).toBe('the instance no longer holds the new database the record names');
    expect(write).not.toHaveBeenCalled();
  });

  it('a resume at db-in does not write the service again', async () => {
    await seedMain();
    answerDatabase();
    crashOnStep('db-up');
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.step).toBe('db-in');
    const write = vi.spyOn(containerManager, 'writeFleetDbService');
    expect(await press()).toMatchObject({ success: true });
    expect(write).not.toHaveBeenCalled();
  });

  it('a resume at db-up does not start the database or set up roles again', async () => {
    await seedMain();
    answerDatabase();
    crashOnStep('login');
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.step).toBe('db-up');
    const up = vi.spyOn(containerManager, 'startFleetDbSidecar');
    vi.mocked(fleetReplication.provisionManagedRoles).mockClear();
    expect(await press()).toMatchObject({ success: true });
    expect(up).not.toHaveBeenCalled();
    expect(fleetReplication.provisionManagedRoles).not.toHaveBeenCalled();
  });

  it('docker not saying whether the new volume exists opens with the volume named', async () => {
    await seedMain();
    answerDatabase();
    const realWrite = containerManager.writeFleetDbService;
    vi.spyOn(containerManager, 'writeFleetDbService').mockImplementation(async (...args) => {
      run.volumes[names().newVolume] = 'unknown';
      return realWrite(...args);
    });
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.lastError).toBe(`docker did not say whether the volume ${names().newVolume} exists`);
  });

  it('the manager role is forgotten before the new database starts', async () => {
    await seedMain();
    answerDatabase();
    crashOnStep('db-up');
    expect(await press()).toMatchObject({ success: false, open: true });
    const forget = vi.spyOn(dbLogin, 'forgetManagerRole');
    expect(await press()).toMatchObject({ success: true });
    expect(forget.mock.calls).toEqual([[CONTAINER]]);
  });

  it('the bot gone once the new database started answers Bot not found', async () => {
    await seedMain();
    answerDatabase();
    const realGet = containerManager.getBot;
    let gone = false;
    vi.spyOn(containerManager, 'startFleetDbSidecar').mockImplementation(async () => { gone = true; return { success: true } as any; });
    vi.spyOn(containerManager, 'getBot').mockImplementation((id: string) => (gone ? null : realGet(id)));
    expect(await press()).toEqual({ success: false, status: 404, error: 'Bot not found' });
  });

  it('roles failing on a live copy in recovery name it', async () => {
    await seedMain();
    answerDatabase();
    db.roles = { ok: false, cls: 'in-recovery', error: 'cannot execute CREATE ROLE in a read-only transaction' } as any;
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.lastError).toBe('its roles could not be set up (the database is a live copy in recovery)');
  });

  it('a checksum read that fails opens with the manager unable to confirm', async () => {
    await seedMain();
    answerDatabase();
    db.checksums = { ok: false, stderr: 'psql: error: connection refused' };
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.lastError).toMatch(/^the manager can't confirm the new database has data checksums on \(.*connection refused.*\)$/);
  });

  it('a resume at login does not open the login again', async () => {
    await seedMain();
    answerDatabase();
    vi.mocked(dbLogin.openBotLogin).mockImplementation(async () => { app.a = true; return { ok: true }; });
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.step).toBe('login');
    app.a = false;
    vi.mocked(dbLogin.openBotLogin).mockClear();
    expect(await press()).toMatchObject({ success: true });
    expect(dbLogin.openBotLogin).not.toHaveBeenCalled();
  });

  it('a login read back in recovery opens with that reason', async () => {
    await seedMain();
    answerDatabase();
    db.login = { ok: true, login: { inRecovery: true, canLogin: true, sessions: 0 } };
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.lastError).toBe("the bot's login on the new database could not be opened (the database read back as a live copy in recovery)");
  });

  it('a login read back blocked opens with that reason', async () => {
    await seedMain();
    answerDatabase();
    db.login = { ok: true, login: { inRecovery: false, canLogin: false, sessions: 0 } };
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.lastError).toBe("the bot's login on the new database could not be opened (the login read back as blocked)");
  });
});

describe('nm31 l5 t: N10', () => {
  it('the done text names the volume of this start\'s set, not an earlier set', async () => {
    await seedMain();
    answerDatabase();
    const oldVolume = stored().fleetDb.volume;
    vi.spyOn(containerManager, 'appContainerRunning').mockImplementation(async () => {
      const sets = stored().keptSets;
      if (sets?.length === 1) patchRegistry('a', { keptSets: [{ id: '20200101T000000Z', keptAt: '2020-01-01T00:00:00.000Z', by: 'new-start', folder: '/elsewhere', db: { ...sets[0].db, volume: 'other-volume' } }, ...sets] });
      return false;
    });
    const answer = await press() as { success: boolean; text: string };
    expect(answer.success).toBe(true);
    expect(answer.text).toBe(KEPT_TEXT.nDoneMain({ old: oldVolume, outDir: names().outDir, newVolume: names().newVolume, certs: false, replication: false, sharers: null }));
  });

  it('a main set gone at the close names no old volume', async () => {
    await seedMain();
    answerDatabase();
    let reads = 0;
    vi.spyOn(containerManager, 'appContainerRunning').mockImplementation(async () => {
      if (stored().keptSets?.length && ++reads >= 1 && stored().keptOp?.step === 'login') patchRegistry('a', { keptSets: [] });
      return false;
    });
    const answer = await press() as { success: boolean; text: string };
    expect(answer.text).toBe(KEPT_TEXT.nDoneMain({ old: '', outDir: names().outDir, newVolume: names().newVolume, certs: false, replication: false, sharers: null }));
  });

  it('a copy set gone at the close names no copy volume', async () => {
    await seedCopy();
    answerDatabase();
    vi.spyOn(containerManager, 'appContainerRunning').mockImplementation(async () => {
      if (stored().keptOp?.step === 'folder') patchRegistry('a', { keptSets: [] });
      return false;
    });
    const answer = await press() as { success: boolean; text: string };
    expect(answer.text).toBe(KEPT_TEXT.nDoneCopy({ volume: '', outDir: names().outDir, certs: true }));
    expect(answer.text).not.toContain(COPY_VOLUME);
  });

  it('a close that finds the record gone answers closed and logs no done line', async () => {
    await seedMain();
    answerDatabase();
    vi.spyOn(containerManager, 'closeKeptOp').mockReturnValue('the record was closed');
    const answer = await press();
    expect(answer).toEqual({ success: false, status: 409, error: `Start on a new database stopped: ${containerManager.KEPT_RECORD_CLOSED}; nothing more was done` });
    expect(vi.mocked(console.log).mock.calls.some(c => String(c[0]).includes('done (set'))).toBe(false);
  });

  it('a clean run logs the done line with the set', async () => {
    await seedMain();
    answerDatabase();
    expect(await press()).toMatchObject({ success: true });
    expect(console.log).toHaveBeenCalledWith(`[KeptData] ${containerManager.getBot('a')!.displayName}: Start on a new database done (set ${names().stamp})`);
  });
});
