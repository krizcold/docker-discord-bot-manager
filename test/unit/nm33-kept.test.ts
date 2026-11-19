// NM33's save order through the kept-data lanes (NX5.md, NM31 3.3 and 3.4): Off, then Start on a new database, and
// Off, then Put back, on an app that declares companionDb.saveOrder, with the record's fleet and each database's
// save_order row pinned after each step, and whether a later Hand over goes (fleetSwitch.saveVerdict on a fresh read).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm33-kept-'));
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
import * as containerManager from '../../src/docker/containerManager';
import * as maintenance from '../../src/instance/maintenance';
import { saveVerdict } from '../../src/instance/fleetSwitch';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { startOnNewDatabase } from '../../src/instance/keptData';
import { resetDocker } from './nm2-docker';
import { clearRegistry } from './nm2-harness';
import { resetRun, run } from './nm31-run';
import { app, CONTAINER, OFF_MESSAGE, resetSeed, seedMain } from './nm31-seed';
import { so, soDbOf } from './nm31-save';
import { answerOrders, bot, fwd, keptAfterStart, login, pressBack, resetBack } from './nm31-back';

const T = maintenance.SAVE_TEXTS;
const CONFIRMED = { kind: 'confirmed', text: T.covered(1, 'main') };
const ASKED_BLOCKED = { kind: 'askedBlocked', text: T.askedBlocked(maintenance.againText(null)) };

const fleet = () => bot().maintenance?.fleet;
const rowOf = (key: string) => soDbOf(key).order;

/** The Hand over's save check as provenMaintenance runs it: a fresh read of the rows, judged against the record. */
async function handOverVerdict() {
  const db = bot().fleetDb!;
  const read = await maintenance.readSaveRows({ container: db.containerName, user: db.user }, db.db);
  expect(read.ok).toBe(true);
  return saveVerdict((read as { rows: any }).rows, maintenance.maintenanceOf(bot()), 'hand-over', null);
}

/** Starts of the bot by an order succeed with the app then running (Maintenance or Running from Off). */
function startsStart(): void {
  vi.spyOn(containerManager, 'startBotInOp').mockImplementation(async () => { app.a = true; return { success: true } as any; });
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

describe('nm33 kept: Off, then Start on a new database, on a save-order app', () => {
  it('K1: Off asks the bot under an open login, records its own row with the block mark, and settles confirmed', async () => {
    await seedMain();
    const old = bot().fleetDb!.volume;
    const row = rowOf(old);
    expect(row).toEqual({ id: expect.any(String), state: 'maintenance', message: OFF_MESSAGE, generation: 0, reason: 'order', upMs: 100_000 });
    expect(soDbOf(old).writes).toEqual(['order']);
    expect(soDbOf(old).acks).toEqual([{ process: 'p1', order: row!.id, saved: true }]);
    expect(bot().maintenance).toMatchObject({ state: 'off', settled: true, login: 'blocked' });
    expect(bot().maintenance!.lastError).toBeUndefined();
    expect(fleet()).toEqual({
      orderId: row!.id, generation: 0, upMs: 100_000, orderFor: bot().maintenance!.orderedAt, askedBlocked: false,
      blockedAt: expect.any(String), verdict: CONFIRMED,
    });
  });

  it('K2: Start on a new database leaves the record Running with no save-order state, the new database with no row, and the kept one with its Off row', async () => {
    await seedMain();
    const old = bot().fleetDb!.volume;
    const offRow = { ...rowOf(old)! };
    answerOrders();
    expect(await startOnNewDatabase('a')).toMatchObject({ success: true });
    expect(bot().fleetDb!.volume).toBe(fwd().newVolume);
    expect(bot().maintenance).toMatchObject({ state: 'running', settled: true, login: 'open' });
    expect(fleet()).toBeUndefined();
    expect(rowOf(fwd().newVolume)).toBeNull();
    expect(soDbOf(fwd().newVolume).writes).toEqual([]);
    expect(rowOf(old)).toEqual(offRow);
    expect(login.canLogin).toBe(true);
  });

  it('K3: a Maintenance on the new database writes its own row there under the open login, settles confirmed, and a Hand over goes', async () => {
    await seedMain();
    answerOrders();
    expect(await startOnNewDatabase('a')).toMatchObject({ success: true });
    const r = await maintenance.runMaintenanceOrder('a', 'maintenance', 'Handing over');
    expect(r.settled).toBe(true);
    const row = rowOf(fwd().newVolume);
    expect(row).toEqual({ id: expect.any(String), state: 'maintenance', message: 'Handing over', generation: 0, reason: 'order', upMs: 100_000 });
    expect(fleet()).toMatchObject({ orderId: row!.id, askedBlocked: false, blockedAt: expect.any(String), verdict: CONFIRMED });
    expect(await handOverVerdict()).toEqual({ go: true });
  });

  it('K4: a Maintenance on the new database whose bot does not answer settles uncovered, and a Hand over is refused', async () => {
    await seedMain();
    answerOrders();
    expect(await startOnNewDatabase('a')).toMatchObject({ success: true });
    so.answers = {};
    const wait = maintenance.MAINTENANCE_TIMING.ackWaitMs;
    maintenance.MAINTENANCE_TIMING.ackWaitMs = 0;
    let r: maintenance.OrderResult;
    try {
      r = await maintenance.runMaintenanceOrder('a', 'maintenance', 'Handing over');
    } finally {
      maintenance.MAINTENANCE_TIMING.ackWaitMs = wait;
    }
    expect(r.settled).toBe(true);
    expect(fleet()!.verdict!.kind).toBe('uncovered');
    expect(await handOverVerdict()).toEqual({ refuse: expect.stringContaining('the bot on main did not confirm that it saved what it holds') });
  });
});

describe('nm33 kept: Off, then Put back, on a save-order app', () => {
  it('K5: the Off on the new database records that database\'s row; Put back\'s Off on the kept database writes a new row under the blocked login and settles asked-blocked', async () => {
    const before = await keptAfterStart('main');
    const old = before.inst.fleetDb!.volume;
    const keptRow = { ...rowOf(old)! };
    const newRow = rowOf(fwd().newVolume)!;
    expect(newRow).toMatchObject({ state: 'maintenance', message: OFF_MESSAGE, reason: 'order' });
    expect(fleet()).toMatchObject({ orderId: newRow.id, askedBlocked: false, blockedAt: expect.any(String), verdict: CONFIRMED });
    expect(newRow.id).not.toBe(keptRow.id);
    const answer = await pressBack();
    expect(answer).toMatchObject({ success: true });
    expect((answer as { warning?: string }).warning).toBeUndefined();
    expect(bot().fleetDb!.volume).toBe(old);
    const row = rowOf(old)!;
    expect(row).toEqual({ id: expect.any(String), state: 'maintenance', message: OFF_MESSAGE, generation: 0, reason: 'order', upMs: 100_000 });
    expect(row.id).not.toBe(keptRow.id);
    expect(row.id).not.toBe(newRow.id);
    expect(soDbOf(old).writes).toEqual(['order', 'order']);
    expect(rowOf(fwd().newVolume)).toEqual(newRow);
    expect(bot().maintenance).toMatchObject({ state: 'off', settled: true, login: 'blocked', lastError: ASKED_BLOCKED.text });
    expect(fleet()).toEqual({
      orderId: row.id, generation: 0, upMs: 100_000, orderFor: bot().maintenance!.orderedAt, askedBlocked: true,
      blockedAt: expect.any(String), verdict: ASKED_BLOCKED,
    });
    expect(login.canLogin).toBe(false);
  });

  it('K6: after Put back, Maintenance from Off keeps that row under the block and a Hand over is refused asked-blocked; Running, then Maintenance, lets it go', async () => {
    await keptAfterStart('main');
    expect(await pressBack()).toMatchObject({ success: true });
    const old = bot().fleetDb!.volume;
    const putBackRow = rowOf(old)!.id;
    startsStart();
    const m1 = await maintenance.runMaintenanceOrder('a', 'maintenance', 'Handing over');
    expect(m1.settled).toBe(true);
    expect(rowOf(old)).toMatchObject({ id: putBackRow, state: 'maintenance', message: 'Handing over' });
    expect(fleet()).toMatchObject({ orderId: putBackRow, askedBlocked: true, verdict: ASKED_BLOCKED });
    expect(await handOverVerdict()).toEqual({ refuse: T.askedBlocked(maintenance.againText(null)) });

    const running = await maintenance.runMaintenanceOrder('a', 'running', '');
    expect(running.settled).toBe(true);
    expect(rowOf(old)).toMatchObject({ id: putBackRow, state: 'running' });
    expect(soDbOf(old).acks).toEqual([]);
    expect(fleet()).toEqual({ orderId: putBackRow });
    expect(login.canLogin).toBe(true);

    const m2 = await maintenance.runMaintenanceOrder('a', 'maintenance', 'Handing over');
    expect(m2.settled).toBe(true);
    const row = rowOf(old)!;
    expect(row).toMatchObject({ state: 'maintenance', message: 'Handing over', reason: 'order' });
    expect(row.id).not.toBe(putBackRow);
    expect(fleet()).toMatchObject({ orderId: row.id, askedBlocked: false, blockedAt: expect.any(String), verdict: CONFIRMED });
    expect(await handOverVerdict()).toEqual({ go: true });
    expect(run.psqlCalls.some(c => c.args.includes(CONTAINER))).toBe(true);
  });
});
