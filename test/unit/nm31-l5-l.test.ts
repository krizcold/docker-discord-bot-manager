import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-l5-l-'));
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
import * as maintenance from '../../src/instance/maintenance';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { KEPT_TEXT, newStartVariantOf, startOnNewDatabase } from '../../src/instance/keptData';
import { resetDocker } from './nm2-docker';
import { clearRegistry } from './nm2-harness';
import { resetRun } from './nm31-run';
import { answerDatabase, CONTAINER, patchRegistry, resetSeed, seedMain, stored } from './nm31-seed';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const realSave = containerManager.saveKeptOpIf;

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

describe('nm31 l5 l: Delete texts', () => {
  it('xKept with no file made says only that the data was kept', () => {
    expect(KEPT_TEXT.xKept({ date: 'D' })).toBe('Kept: the kept data of D was not deleted.');
  });
  it('xKept with only an archive names it once with stays', () => {
    expect(KEPT_TEXT.xKept({ date: 'D', archive: 'a.tar' })).toBe('Kept: the kept data of D was not deleted. The archive a.tar made so far stays in the backups folder.');
  });
  it('xKept with only a dump names it once with stays', () => {
    expect(KEPT_TEXT.xKept({ date: 'D', dump: 'd.dump' })).toBe('Kept: the kept data of D was not deleted. The dump d.dump made so far stays in the backups folder.');
  });
  it('xKept with a dump and an archive says stay', () => {
    expect(KEPT_TEXT.xKept({ date: 'D', dump: 'd.dump', archive: 'a.tar' })).toBe('Kept: the kept data of D was not deleted. The dump d.dump and the archive a.tar made so far stay in the backups folder.');
  });
  it('the fixed Delete texts', () => {
    expect(KEPT_TEXT.xRunning).toBe('Delete is running on this kept data; wait for it to end, then read the outcome here');
    expect(KEPT_TEXT.xNoRec).toBe('This bot has no open Delete to run again: it was stopped with Keep it or finished; nothing was changed');
    expect(KEPT_TEXT.xNoAbandon).toBe('Delete already began removing the kept data, so it can only be run again to finish');
    expect(KEPT_TEXT.xNoKeep).toBe('This bot has no open Delete to stop; nothing was changed');
    expect(KEPT_TEXT.xPsUnknown('v1', 'e1')).toBe('Docker did not say which containers mount the kept volume v1 (e1); nothing was deleted; try again');
    expect(KEPT_TEXT.xDoneEmpty('D')).toBe('Deleted the kept data of D: it held no volume and no folder to remove.');
  });
  it('xStays for none, a dump alone, an archive alone and both', () => {
    expect(KEPT_TEXT.xStays({})).toBe('; nothing was deleted');
    expect(KEPT_TEXT.xStays({ dump: 'd.dump' })).toBe('; nothing was deleted, and the dump d.dump stays in the backups folder');
    expect(KEPT_TEXT.xStays({ archive: 'a.tar' })).toBe('; nothing was deleted, and the archive a.tar stays in the backups folder');
    expect(KEPT_TEXT.xStays({ dump: 'd.dump', archive: 'a.tar' })).toBe('; nothing was deleted, and the dump d.dump and the archive a.tar stay in the backups folder');
  });
});

describe('nm31 l5 l: the stored env', () => {
  const status = (vars: Record<string, string>, undecryptable: string[] = []) =>
    vi.spyOn(envManager, 'getEnvVarsWithStatus').mockReturnValue({ vars, undecryptable, encrypted: [], corrupt: false });

  it('an unreadable Database URL key gives no variant', async () => {
    await seedMain();
    status({ DATA_BACKEND: 'postgres' }, ['DATA_BACKEND_URL']);
    expect(newStartVariantOf(containerManager.getBot('a')!)).toBeNull();
  });
  it('the record env lies under the store, and an unreadable key reads empty', async () => {
    await seedMain();
    patchRegistry('a', { envVars: { FROM_RECORD: 'r' } });
    status({ DATA_BACKEND: 'postgres' }, ['OTHER_KEY']);
    let seen: Record<string, string> = {};
    vi.spyOn(maintenance, 'maintenanceKind').mockImplementation((_i, env) => { seen = { ...env }; return 'database'; });
    expect(newStartVariantOf(containerManager.getBot('a')!)).toBe('main');
    expect(seen).toEqual({ FROM_RECORD: 'r', DATA_BACKEND: 'postgres', OTHER_KEY: '' });
  });
  it('kind none gives no variant, kind copy gives copy', async () => {
    await seedMain();
    const kind = vi.spyOn(maintenance, 'maintenanceKind').mockReturnValue('none');
    expect(newStartVariantOf(containerManager.getBot('a')!)).toBeNull();
    kind.mockReturnValue('copy');
    expect(newStartVariantOf(containerManager.getBot('a')!)).toBe('copy');
  });
  it('a Database URL of only spaces is refused as empty', async () => {
    await seedMain();
    envManager.setEnvVars('a', { DATA_BACKEND_URL: '   ' });
    expect(await startOnNewDatabase('a')).toEqual({ success: false, status: 409, error: KEPT_TEXT.aUrlEmpty });
  });
  it('a store with no Database URL key is refused as empty', async () => {
    await seedMain();
    patchRegistry('a', { envVars: {} });
    expect(Object.keys(envManager.getEnvVarsWithStatus('a').vars)).toContain('DATA_BACKEND_URL');
    status({ DATA_BACKEND: 'postgres' });
    expect(await startOnNewDatabase('a')).toEqual({ success: false, status: 409, error: KEPT_TEXT.aUrlEmpty });
  });
});

describe('nm31 l5 l: admission and the frame', () => {
  it('a push hand-over refuses with the push word', async () => {
    await seedMain();
    patchRegistry('a', { fleetDb: { ...stored().fleetDb, handover: { mode: 'push', phase: 'waiting', at: '2026-11-17T08:00:00.000Z', machine: 'm2' } } });
    expect(await startOnNewDatabase('a')).toEqual({ success: false, status: 409, error: KEPT_TEXT.aSwitch('push') });
    expect(KEPT_TEXT.aSwitch('push')).toContain(' a push that');
  });
  it('a stop whose reason cannot be saved is logged', async () => {
    await seedMain();
    answerDatabase();
    vi.spyOn(containerManager, 'takeFleetDbServicesOut').mockImplementation(() => { throw new Error('boom'); });
    vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation((id, key, patch) => {
      if (typeof patch.lastError === 'string') throw new Error('disk gone');
      return realSave(id, key, patch);
    });
    expect(await startOnNewDatabase('a')).toEqual({ success: false, status: 500, error: 'Start on a new database stopped on an unexpected error: boom' });
    const lines = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(c => String(c[0]));
    expect(lines).toContain('[KeptData] a: the stop of Start on a new database could not be recorded: disk gone');
    expect(CONTAINER).toBe('bota-fleet-postgres');
  });
});
