import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-l5-v-'));
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
import * as fleetReplica from '../../src/instance/fleetReplica';
import * as maintenance from '../../src/instance/maintenance';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { KEPT_TEXT, KEPT_TIMING, keptDate } from '../../src/instance/keptData';
import { docker, resetDocker } from './nm2-docker';
import { clearRegistry } from './nm2-harness';
import { resetRun } from './nm31-run';
import { app, COPY_CONTAINER, COPY_VOLUME, CONTAINER, dataDirOf, patchRegistry, resetSeed } from './nm31-seed';
import { asideDir, fwd, keptAfterStart, orders, pressBack, resetBack, stored } from './nm31-back';

const DATE = keptDate(fwd().stamp);
const realOrder = maintenance.runOrderInOp;
const orderText = () => (orders[orders.length - 1] as { text: string }).text;

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
});
afterEach(() => {
  releaseFleetBackupBusy('a');
  vi.restoreAllMocks();
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('nm31 l5 v: P6 brings a live copy up (copyUp)', () => {
  const timing = { ...KEPT_TIMING };
  afterEach(() => { Object.assign(KEPT_TIMING, timing); });

  /** After the forward run: the copy's service applies, and each read of the copy's container answers from `reads` (the last one repeats). */
  async function copyReads(reads: Array<boolean | null>, applied: { success: boolean; error?: string } = { success: true }) {
    await keptAfterStart('copy');
    Object.assign(KEPT_TIMING, { copyUpMs: 21, pollMs: 7 });
    let phase = false;
    const seen: string[] = [];
    vi.spyOn(containerManager, 'applyFleetDbReplicaService').mockImplementation(async () => { phase = true; return applied as any; });
    const realRunning = containerManager.containerRunningExact;
    vi.spyOn(containerManager, 'containerRunningExact').mockImplementation(async (name: string) => {
      if (!phase || name !== COPY_CONTAINER) return realRunning(name);
      seen.push(name);
      return reads[Math.min(seen.length - 1, reads.length - 1)];
    });
    const realStatus = fleetReplica.getFleetReplicaStatus;
    vi.spyOn(fleetReplica, 'getFleetReplicaStatus').mockImplementation(async (i) => { phase = false; return realStatus(i); });
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const sleeps = () => timer.mock.calls.filter(c => c[1] === 7).length;
    return { seen, sleeps };
  }

  it('a service that cannot be applied opens the record with the apply error and reads nothing', async () => {
    const r = await copyReads([true], { success: false, error: 'compose up failed: no space' });
    const answer = await pressBack();
    expect(answer).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.lastError).toBe("the live copy's service could not be written and started (compose up failed: no space)");
    expect(r.seen.length).toBe(0);
  });

  it('a copy never running is read copyUpMs / pollMs times, with a wait only between reads', async () => {
    const r = await copyReads([false]);
    const answer = await pressBack();
    expect(answer).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.lastError).toBe(`the live copy did not start (${COPY_CONTAINER} is not running)`);
    expect(r.seen.length).toBe(3);
    expect(r.sleeps()).toBe(2);
  });

  it('a copy running at the second read is read twice and the run goes on', async () => {
    const r = await copyReads([false, true]);
    const answer = await pressBack();
    expect(answer).toMatchObject({ success: true });
    expect(r.seen.length).toBe(2);
    expect(r.sleeps()).toBe(1);
  });

  it('docker never saying whether the copy runs opens the record with that reason', async () => {
    const r = await copyReads([null]);
    const answer = await pressBack();
    expect(answer).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.lastError).toBe(`the live copy did not start (docker did not say whether ${COPY_CONTAINER} runs)`);
    expect(r.seen.length).toBe(3);
  });
});

describe('nm31 l5 v: the copy note of a Put back (copyNote)', () => {
  async function backWithStatus(row: string) {
    await keptAfterStart('copy');
    docker.overrides.unshift({ match: a => a[0] === 'exec' && a.join(' ').includes('pg_is_in_recovery'), answer: { ok: true, stdout: `${row}\n` } });
    return pressBack();
  }
  const expectNote = (answer: unknown, copy: { down: string }) => expect(answer).toEqual({
    success: true,
    text: KEPT_TEXT.pDone({ date: DATE, copyVolume: COPY_VOLUME, folder: dataDirOf('a'), asideFolder: asideDir(), copy, orderText: orderText() }),
  });

  it('a copy that runs out of recovery says it does not follow the main', async () => {
    expectNote(await backWithStatus('f||t|'), { down: 'it is not in recovery, so it does not follow the main' });
  });

  it('a copy in recovery with no WAL receiver says the receiver reads nothing', async () => {
    expectNote(await backWithStatus('t||f|'), { down: 'its WAL receiver reads nothing' });
  });
});

describe('nm31 l5 v: P7 forgets the manager role only for a database set (settleOff)', () => {
  it('a database set forgets the role of the database put back after P6 writes its service and before the Off order runs', async () => {
    await keptAfterStart('main');
    const forget = vi.spyOn(dbLogin, 'forgetManagerRole');
    const written = vi.spyOn(containerManager, 'writeFleetDbService');
    const order = vi.mocked(maintenance.runOrderInOp);
    order.mockClear();
    expect(await pressBack()).toMatchObject({ success: true });
    expect(order).toHaveBeenCalledTimes(1);
    expect(written).toHaveBeenCalledTimes(1);
    const from = written.mock.invocationCallOrder[0];
    const at = order.mock.invocationCallOrder[0];
    const before = forget.mock.calls.filter((c, i) => c[0] === CONTAINER && forget.mock.invocationCallOrder[i] > from && forget.mock.invocationCallOrder[i] < at);
    expect(before.length).toBeGreaterThan(0);
  });

  it('a folder set on a database instance forgets no role', async () => {
    await keptAfterStart('main');
    expect(containerManager.dropKeptPart('a', fwd().stamp, 'db')).toBeNull();
    const forget = vi.spyOn(dbLogin, 'forgetManagerRole');
    expect(await pressBack()).toMatchObject({ success: true });
    expect(forget).not.toHaveBeenCalled();
  });
});

describe('nm31 l5 v: a resume past P7 answers Off as recorded (offAsRecorded)', () => {
  /** A Put back of the main's set stopped at P8 because the app ran after P7, then pressed again with the app stopped. */
  async function resumeAfterP8(between: () => void = () => {}, setup: () => void = () => {}) {
    const before = await keptAfterStart('main');
    setup();
    vi.mocked(maintenance.runOrderInOp).mockImplementationOnce(async (...args) => {
      const r = await realOrder(...args);
      orders.push(r);
      app.a = true;
      return r;
    });
    expect(await pressBack()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.step).toBe('settled');
    app.a = false;
    between();
    const answer = await pressBack();
    const n = fwd();
    const text = (off: string) => KEPT_TEXT.pDone({ date: DATE, volume: before.inst.fleetDb!.volume, folder: dataDirOf('a'), asideVolume: n.newVolume, asideFolder: asideDir(), orderText: off });
    return { answer, text };
  }

  it('Off settled: the close says Off is confirmed, with no warning', async () => {
    const { answer, text } = await resumeAfterP8();
    expect(answer).toEqual({ success: true, text: text('Off is confirmed.') });
  });

  it('Off not settled with a reason: the close names the reason and warns', async () => {
    let reason = '';
    const { answer, text } = await resumeAfterP8(() => {
      expect(stored().maintenance).toMatchObject({ state: 'off', settled: false });
      reason = stored().maintenance.lastError;
      expect(reason).toBeTruthy();
    }, () => { vi.mocked(dbLogin.blockBotLogin).mockResolvedValue({ ok: false, cls: 'other', error: 'permission denied to alter role' } as any); });
    const off = `Off is not confirmed (${reason}).`;
    expect(answer).toEqual({ success: true, text: text(off), warning: off });
  }, 30_000);

  it('Off not settled without a reason (the order\'s closing save was lost): the close says so and warns', async () => {
    const { answer, text } = await resumeAfterP8(() => {
      const m = { ...stored().maintenance, settled: false };
      delete m.lastError;
      patchRegistry('a', { maintenance: m });
    });
    expect(answer).toEqual({ success: true, text: text('Off is not confirmed.'), warning: 'Off is not confirmed.' });
  });
});
