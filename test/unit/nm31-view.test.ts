import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-view-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, hookBodies: [] as Array<{ action: string; body: any }>, hook: { ok: true, body: {} } as any };
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
  callAppHook: async (_i: unknown, action: string, _method: string, body: unknown) => { h.hookBodies.push({ action, body }); return h.hook; },
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as dbLogin from '../../src/instance/dbLogin';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { startOnNewDatabase } from '../../src/instance/keptData';
import { maintenanceStatus, reconcileMaintenance, resetMaintenanceState, runMaintenanceOrder } from '../../src/instance/maintenance';
import { resetDocker } from './nm2-docker';
import { clearRegistry } from './nm2-harness';
import { resetRun } from './nm31-run';
import { app, answerDatabase, db, resetSeed, seedMain, stored } from './nm31-seed';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const NOT_SENT = 'State: Running. The bot was stopped when this was set, so nothing was sent to it; its data folder says maintenance, so it boots in maintenance and leaves it when you choose Running again while it runs.';

/** A main through a forward run on the fakes: the record N10 leaves, with hook 'not-sent'. */
async function notSent(): Promise<void> {
  await seedMain();
  answerDatabase();
  expect(await startOnNewDatabase('a')).toMatchObject({ success: true });
  expect(stored().maintenance).toMatchObject({ state: 'running', settled: true, hook: 'not-sent' });
  h.hookBodies.length = 0;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  resetDocker();
  resetRun();
  clearRegistry();
  resetMaintenanceState();
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  resetSeed();
  h.hookBodies.length = 0;
  h.hook = { ok: true, body: {} };
});
afterEach(() => {
  releaseFleetBackupBusy('a');
  vi.restoreAllMocks();
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('nm31 view: the record a forward run leaves', () => {
  it('view (1 of 4): reconcileBot sends no hook to a running app on a not-sent record', async () => {
    await notSent();
    app.a = true;
    const before = stored().maintenance;
    await reconcileMaintenance();
    await reconcileMaintenance();
    expect(h.hookBodies).toEqual([]);
    expect(stored().maintenance).toEqual(before);
  });

  it("view (2 of 4): the state line says nothing was sent and the folder says maintenance", async () => {
    await notSent();
    const status = await maintenanceStatus(containerManager.getBot('a')!, null);
    expect(status.summary).toBe(NOT_SENT);
  });

  it('view (3 of 4): Maintenance ordered with the app running sends the hook and records confirmed', async () => {
    await notSent();
    app.a = true;
    vi.spyOn(dbLogin, 'blockBotLogin').mockResolvedValue({ ok: true });
    vi.spyOn(dbLogin, 'endBotSessions').mockResolvedValue({ ok: true });
    db.login = { ok: true, login: { inRecovery: false, canLogin: false, sessions: 0 } };
    h.hook = { ok: true, body: { saved: true } };
    const r = await runMaintenanceOrder('a', 'maintenance', 'Checking the new database');
    expect(r.settled).toBe(true);
    expect(h.hookBodies).toEqual([{ action: 'maintenance', body: { state: 'maintenance', message: 'Checking the new database' } }]);
    expect(stored().maintenance).toMatchObject({ state: 'maintenance', settled: true, hook: 'confirmed', savedByBot: 'maintenance' });
  });

  it("view (4 of 4): Running ordered with the app running sends 'running'", async () => {
    await notSent();
    app.a = true;
    h.hook = { ok: true, body: { restarting: false } };
    const r = await runMaintenanceOrder('a', 'running', '');
    expect(r.settled).toBe(true);
    expect(h.hookBodies).toEqual([{ action: 'maintenance', body: { state: 'running', message: '' } }]);
    expect(stored().maintenance).toMatchObject({ state: 'running', settled: true, hook: 'confirmed', savedByBot: 'running' });
  });
});
