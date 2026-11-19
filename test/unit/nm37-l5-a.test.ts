import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm37-l5-a-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    /** How docker stop answers: docker's error, ok while the container keeps running, or ok with no answer to the read after it. */
    s0: null as null | 'error' | 'stays' | 'unread',
  };
});

const STOP_ERROR = 'Error response from daemon: cannot stop container: bota-fleet-postgres: permission denied';

vi.mock('child_process', async (importOriginal) => {
  const m = await (await import('./nm36-tls')).childProcessMock(await importOriginal(), require('fs')) as any;
  const { docker } = await import('./nm2-docker');
  const execFile = (cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown): unknown => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (err: Error | null, stdout: string, stderr: string) => void;
    if (cmd !== 'docker' || args[0] !== 'stop' || !h.s0) return m.execFile(cmd, args, optsOrCb, maybeCb);
    docker.calls.push(args);
    if (h.s0 === 'error') setTimeout(() => cb(Object.assign(new Error(`Command failed: docker ${args.join(' ')}\n${STOP_ERROR}\n`), { code: 1 }), '', `${STOP_ERROR}\n`), 1);
    else {
      docker.running[args[args.length - 1]] = h.s0 === 'stays' ? true : null;
      setTimeout(() => cb(null, `${args[args.length - 1]}\n`, ''), 1);
    }
    return undefined;
  };
  return { ...m, execFile, default: { ...m.default, execFile } };
});
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
import { KEPT_TEXT, newStartDone, startOnNewDatabase } from '../../src/instance/keptData';
import { docker, resetDocker } from './nm2-docker';
import { clearRegistry } from './nm2-harness';
import { resetRun, run, stopsStop } from './nm31-run';
import { CONTAINER, db, resetSeed, seedMain, stored } from './nm31-seed';
import { answerOrders, bot, fwd, resetBack } from './nm31-back';
import { resetTls, tlsFake } from './nm36-tls';
import type { KeptOpRecord } from '../../src/types';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const REMOVE = (c: string) => `; remove it in a shell with docker rm ${c}, then run it again, so that compose makes the container anew from the deployed compose`;
const MOUNT = (mount: string, volume: string) => `docker shows ${mount} at the database's data folder, not the new volume ${volume}, so the manager wrote nothing into that database`;

const isStart = (a: string[]) => a[0] === 'sh' && a[1].endsWith(' up -d fleet-postgres');
const isRunningRead = (a: string[]) => a[0] === 'inspect' && a[a.length - 1] === CONTAINER;
const isStop = (a: string[]) => a[0] === 'stop' && a[a.length - 1] === CONTAINER;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  h.s0 = null;
  resetDocker();
  resetRun();
  resetTls();
  clearRegistry();
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
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

describe('nm37 l5 a: stopContainerOutcome answers the whole outcome', () => {
  it('K1: the stop works and the read after it shows the container stopped: ok', async () => {
    stopsStop();
    expect(await containerManager.stopContainerOutcome(CONTAINER, 60)).toEqual({ ok: true });
    expect(docker.calls).toEqual([['stop', '--time', '60', CONTAINER], ['inspect', '-f', '{{.State.Running}}', CONTAINER]]);
  });

  it('K2: docker refuses the stop: its error, confirmed, not read as still running, and no read after it', async () => {
    h.s0 = 'error';
    expect(await containerManager.stopContainerOutcome(CONTAINER, 60)).toEqual({ ok: false, error: STOP_ERROR, unconfirmed: false, stillRuns: false });
    expect(docker.calls.filter(isRunningRead)).toEqual([]);
  });

  it('K3: the stop exits 0 and the read after it gets no answer: unconfirmed, and not reported as still running', async () => {
    h.s0 = 'unread';
    expect(await containerManager.stopContainerOutcome(CONTAINER, 60)).toEqual({
      ok: false, error: `docker did not say whether ${CONTAINER} stopped`, unconfirmed: true, stillRuns: false,
    });
  });

  it('K4: the stop exits 0 and the read after it shows the container running: still runs', async () => {
    h.s0 = 'stays';
    expect(await containerManager.stopContainerOutcome(CONTAINER, 60)).toEqual({ ok: false, error: `${CONTAINER} still runs`, unconfirmed: false, stillRuns: true });
  });
});

describe('nm37 l5 a: a stop at the read after the start takes the container as started', () => {
  it('K5: the started container exits by itself before the stop: one stop, no running read between the start and it, and the text says compose started it', async () => {
    await seedMain();
    answerOrders();
    db.ssl = { ok: true, stdout: 'off\n' };
    tlsFake.newVolume = fwd().newVolume;
    const kept = bot().fleetDb!.volume;
    const V = fwd().newVolume;
    // The container that compose started exits by itself (a database that could not start on its data folder).
    run.execOverrides.push({ match: c => c.endsWith(' up -d fleet-postgres'), answer: () => { docker.running[CONTAINER] = false; return { ok: true }; } });
    run.mounts[CONTAINER] = [null, { out: `volume ${kept}\n` }];
    docker.calls.length = 0;
    const answer = await startOnNewDatabase('a');
    const reason = MOUNT(`volume ${kept}`, V) + `; compose started the container ${CONTAINER}, and it is stopped again` + REMOVE(CONTAINER);
    const rec = stored().keptOp as KeptOpRecord;
    expect(rec).toMatchObject({ step: 'db-in', lastError: reason });
    expect(answer).toEqual({ success: false, status: 409, open: true, error: KEPT_TEXT.nOpen(reason, newStartDone(rec)) });
    const up = docker.calls.findIndex(isStart);
    expect(up).toBeGreaterThanOrEqual(0);
    const after = docker.calls.slice(up + 1);
    expect(after.filter(isStop).length).toBe(1);
    // The one running read after the start is the stop's own.
    expect(after.filter(isRunningRead).length).toBe(1);
    expect(after.findIndex(isRunningRead)).toBeGreaterThan(after.findIndex(isStop));
  });
});
