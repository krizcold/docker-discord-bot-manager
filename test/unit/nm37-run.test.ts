import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm37-run-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    /** How docker stop answers once `skip` stops have passed: docker's error, no answer, ok while the container keeps running, or ok with no answer to the read after it. */
    s0: null as null | { mode: 'error' | 'hang' | 'stays' | 'unread'; skip: number },
  };
});

const STOP_ERROR = 'Error response from daemon: cannot stop container: bota-fleet-postgres: permission denied';

vi.mock('child_process', async (importOriginal) => {
  const m = await (await import('./nm36-tls')).childProcessMock(await importOriginal(), require('fs')) as any;
  const { docker } = await import('./nm2-docker');
  const execFile = (cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown): unknown => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (err: Error | null, stdout: string, stderr: string) => void;
    if (cmd !== 'docker' || args[0] !== 'stop' || !h.s0 || h.s0.skip-- > 0) return m.execFile(cmd, args, optsOrCb, maybeCb);
    docker.calls.push(args);
    const ms = (optsOrCb as { timeout?: number } | undefined)?.timeout ?? 0;
    // No answer: execFile's own timeout kills the CLI and answers killed, as Node does.
    if (h.s0.mode === 'hang') setTimeout(() => cb(Object.assign(new Error('Command failed'), { killed: true, code: null, signal: 'SIGTERM' }), '', ''), ms);
    else if (h.s0.mode === 'error') setTimeout(() => cb(Object.assign(new Error(`Command failed: docker ${args.join(' ')}\n${STOP_ERROR}\n`), { code: 1 }), '', `${STOP_ERROR}\n`), 1);
    else {
      docker.running[args[args.length - 1]] = h.s0.mode === 'stays' ? true : null;
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
import * as fleetReplication from '../../src/instance/fleetReplication';
import * as fleetSwitch from '../../src/instance/fleetSwitch';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { KEPT_TEXT, newStartDone, startOnNewDatabase } from '../../src/instance/keptData';
import { createBotRoutes } from '../../src/webui/routes/bots';
import { docker, resetDocker } from './nm2-docker';
import { clearRegistry } from './nm2-harness';
import { MountAnswer, resetRun, run } from './nm31-run';
import { CONTAINER, composePathOf, dataDirOf, db, pageOpenLine, resetSeed, seedMain, stored, treeOf } from './nm31-seed';
import { answerOrders, Before, bot, fwd, LATER, pressBack, resetBack } from './nm31-back';
import { resetTls, tlsFake } from './nm36-tls';
import type { KeptOpRecord } from '../../src/types';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const LATER_ISO = new Date(LATER).toISOString();
const DAEMON = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';
const TIMEOUT = 'spawnSync docker ETIMEDOUT';
const GONE: MountAnswer = { stderr: `Error: No such container: ${CONTAINER}` };
const ROLES = 'the bot role smdb owns objects in another database';
const skew = { ms: 0 };
const V = () => fwd().newVolume;

// The texts of the design sheet's section 9, word for word.
const REMOVE = (c: string) => `; remove it in a shell with docker rm ${c}, then run it again, so that compose makes the container anew from the deployed compose`;
const T = {
  mount: (mounts: string[], volume: string) => `docker shows ${mounts.length ? mounts.join(', ') : 'no mount'} at the database's data folder, not the new volume ${volume}, so the manager wrote nothing into that database`,
  unknown: (volume: string, err: string) => `docker did not say whether the database container runs on the new volume ${volume} (${err}), so the manager wrote nothing more into its database`,
  gone: (volume: string) => `the database container is gone (docker says no such container), so the manager could not check it against the new volume ${volume} and wrote nothing more`,
  idle: (c: string, remove: boolean) => `, and did not start the container ${c}${remove ? REMOVE(c) : ''}`,
  stopped: (c: string, started: boolean, remove: boolean) => `; ${started ? `compose started the container ${c}, and it is stopped again` : `the container ${c} is stopped now`}${remove ? REMOVE(c) : ''}`,
  notStopped: (c: string, err: string, how: 'started' | 'found' | 'unread', remove: boolean) => `; ${how === 'started' ? `compose started the container ${c}, and it did not stop` : how === 'found' ? `the container ${c} did not stop` : `the manager can't confirm whether the container ${c} runs or stopped`} (${err}); stop it in a shell with docker stop ${c}${remove ? `, remove it with docker rm ${c} and run it again, so that compose makes the container anew from the deployed compose` : ''}`,
};

const router = createBotRoutes({ clients: new Set() } as any);
const call = async (routePath: string, params: Record<string, string>, body: unknown = {}): Promise<{ status: number; body: any }> => {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath && l.route.methods.post);
  expect(layer, `POST ${routePath}`).toBeTruthy();
  const res: any = { statusCode: 200 };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  await layer.route.stack[layer.route.stack.length - 1].handle({ params, query: {}, body }, res);
  return { status: res.statusCode, body: res.body };
};

/** The main fixture, the kept database answering `ssl`, and each write of N8 marked in docker.calls. */
async function fixture(ssl = 'off'): Promise<Before> {
  await seedMain();
  answerOrders();
  db.ssl = { ok: true, stdout: `${ssl}\n` };
  mark();
  vi.spyOn(containerManager, 'startFleetDbSidecar');
  return { inst: bot(), folder: treeOf(dataDirOf('a')), compose: fs.readFileSync(composePathOf('a'), 'utf-8') };
}

function mark(): void {
  const role = vi.mocked(dbLogin.ensureManagerDbRole).getMockImplementation()!;
  vi.spyOn(dbLogin, 'ensureManagerDbRole').mockImplementation(async (t) => { docker.calls.push(['role']); return role(t); });
  vi.spyOn(fleetReplication, 'provisionManagedRoles').mockImplementation(async () => { docker.calls.push(['roles']); return db.roles; });
  vi.mocked(fleetSwitch.ensureMainGeneration).mockRestore();
  const real = fleetSwitch.ensureMainGeneration;
  vi.spyOn(fleetSwitch, 'ensureMainGeneration').mockImplementation(async (id) => { docker.calls.push(['generation']); return real(id); });
}

/** A press with the calls of earlier presses cleared, so every count is this press's. */
async function press() {
  docker.calls.length = 0;
  run.execCalls.length = 0;
  run.psqlCalls.length = 0;
  tlsFake.calls.length = 0;
  return startOnNewDatabase('a');
}

const isCreate = (a: string[]) => a[0] === 'sh' && a[1].endsWith(' up --no-start fleet-postgres');
const isStart = (a: string[]) => a[0] === 'sh' && a[1].endsWith(' up -d fleet-postgres');
const isInspect = (a: string[]) => a[0] === 'container' && a[1] === 'inspect';
const isStop = (a: string[]) => a[0] === 'stop' && a[a.length - 1] === CONTAINER;
const count = (pred: (a: string[]) => boolean) => docker.calls.filter(pred).length;
const WRITES = ['role', 'roles', 'generation'];
/** N8's calls of this press: everything from the create on. */
const fromCreate = () => docker.calls.slice(Math.max(0, docker.calls.findIndex(isCreate)));
/** The dbm_meta calls after the create; admission reads the kept database's generation row as dbm_meta before N1. */
const metaFromCreate = () => run.psqlCalls.filter(c => c.login === 'dbm_meta' && docker.calls.indexOf(c.args) > docker.calls.findIndex(isCreate));

function expectNoWrite(): void {
  expect(fromCreate().filter(a => WRITES.includes(a[0]))).toEqual([]);
  expect(run.execCalls.filter(c => c.includes(' pg_isready '))).toEqual([]);
  expect(metaFromCreate()).toEqual([]);
  expect(count(a => a.join(' ').includes('SHOW data_checksums'))).toBe(0);
}

function expectNoStart(): void {
  expect(count(isStart)).toBe(0);
  expect(docker.running[CONTAINER]).not.toBe(true);
}

const doneText = (before: Before) => KEPT_TEXT.nDoneMain({
  old: before.inst.fleetDb!.volume, outDir: fwd().outDir, newVolume: V(), certs: false, replication: false, sharers: null,
});

/** R1's end: NM31's done text, S1's order within N8, every write detector fired, and no stop but N1's. */
function expectDone(before: Before, answer: unknown, n1Stops: number): void {
  expect(answer).toEqual({ success: true, text: doneText(before) });
  expect(bot().keptOp).toBeUndefined();
  expect(bot().fleetDb!.volume).toBe(V());
  expect(vi.mocked(containerManager.startFleetDbSidecar).mock.lastCall).toEqual(['a', { dataVolume: V() }]);
  const at = (pred: (a: string[]) => boolean, from = 0) => docker.calls.findIndex((a, i) => i >= from && pred(a));
  const made = at(isCreate);
  const first = at(isInspect);
  const up = at(isStart);
  const second = at(isInspect, up);
  const ready = at(a => a[0] === 'sh' && a[1].includes(' pg_isready '));
  const role = at(a => a[0] === 'role', made);
  expect(made).toBeGreaterThanOrEqual(0);
  expect(first).toBeGreaterThan(made);
  expect(up).toBeGreaterThan(first);
  expect(second).toBeGreaterThan(up);
  expect(ready).toBeGreaterThan(second);
  expect(role).toBeGreaterThan(ready);
  expect(count(isInspect)).toBe(2);
  expect(fromCreate().filter(a => a[0] === 'roles').length).toBeGreaterThan(0);
  expect(fromCreate().filter(a => a[0] === 'generation').length).toBe(1);
  expect(metaFromCreate().length).toBeGreaterThan(0);
  expect(count(a => a.join(' ').includes('SHOW data_checksums'))).toBe(1);
  expect(count(isStop)).toBe(n1Stops);
  expect(tlsFake.calls).toEqual([]);
}

/** The open answer for `reason` at 'db-in'. */
function expectOpen(answer: unknown, reason: string): string {
  const rec = stored().keptOp as KeptOpRecord;
  expect(rec).toMatchObject({ step: 'db-in', lastError: reason });
  const error = KEPT_TEXT.nOpen(reason, newStartDone(rec));
  expect(answer).toEqual({ success: false, status: 409, open: true, error });
  return error;
}

/** A stop after an inspect, and no more than one. */
function expectOneStopAfterInspect(): void {
  expect(count(isStop)).toBe(1);
  expect(docker.calls.findIndex(isStop)).toBeGreaterThan(docker.calls.findIndex(isInspect));
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  skew.ms = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => NOW + skew.ms);
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
  tlsFake.newVolume = V();
});
afterEach(() => {
  releaseFleetBackupBusy('a');
  vi.restoreAllMocks();
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('nm37 run: the start of the new database reads its data mount', () => {
  it('R1 (M1, the control): a clean run names the new volume to the start, creates, reads, starts, reads again, then writes', async () => {
    const before = await fixture();
    expectDone(before, await press(), 1);
  });

  const shown: Array<[string, (kept: string) => string, (kept: string) => string[]]> = [
    ['the kept volume', kept => `volume ${kept}\n`, kept => [`volume ${kept}`]],
    ['a folder of the host', () => 'bind /srv/pgdata\n', () => ['bind /srv/pgdata']],
    ['no mount', () => '', () => []],
    ['two mounts', kept => `volume ${fwd().newVolume}\nvolume ${kept}\n`, kept => [`volume ${fwd().newVolume}`, `volume ${kept}`]],
  ];
  it.each(shown)('R2 (M2): the created container shows %s: open at db-in, nothing started, nothing written, no stop; cleared, Run it again ends as R1', async (_n, out, mounts) => {
    const before = await fixture();
    const kept = before.inst.fleetDb!.volume;
    run.mounts[CONTAINER] = { out: out(kept) };
    const answer = await press();
    expectOpen(answer, T.mount(mounts(kept), V()) + T.idle(CONTAINER, true));
    expect(count(isInspect)).toBe(1);
    expectNoStart();
    expectNoWrite();
    expect(count(isStop)).toBe(1);
    expect(docker.calls.findIndex(isStop)).toBeLessThan(docker.calls.findIndex(isCreate));
    delete run.mounts[CONTAINER];
    expectDone(before, await press(), 0);
  });

  it('R3 (M3, M8): the created container is gone at the first read: open, no start, no stop; cleared, Run it again ends as R1', async () => {
    const before = await fixture();
    run.mounts[CONTAINER] = GONE;
    expectOpen(await press(), T.gone(V()));
    expectNoStart();
    expectNoWrite();
    expect(count(isStop)).toBe(1);
    expect(count(a => a[0] === 'inspect' && docker.calls.indexOf(a) > docker.calls.findIndex(isCreate) && a[a.length - 1] === CONTAINER)).toBe(0);
    delete run.mounts[CONTAINER];
    expectDone(before, await press(), 0);
  });

  const unread: Array<[string, MountAnswer, string]> = [
    ['M4: docker answers an error', { stderr: DAEMON }, DAEMON],
    ['M5: docker does not answer in 30 s', { timeout: true }, TIMEOUT],
  ];
  it.each(unread)('R4 (%s): open with the error and no removal advice, no start, no stop; cleared, Run it again ends as R1', async (_n, answer, err) => {
    const before = await fixture();
    run.mounts[CONTAINER] = answer;
    expectOpen(await press(), T.unknown(V(), err) + T.idle(CONTAINER, false));
    expectNoStart();
    expectNoWrite();
    expect(count(isStop)).toBe(1);
    delete run.mounts[CONTAINER];
    expectDone(before, await press(), 0);
  });
});

describe('nm37 run: a container found running (M2r, M9)', () => {
  /** A first press that passes both reads, writes, and stops at the roles, with the container running. */
  async function wrote(): Promise<Before> {
    const before = await fixture();
    db.roles = { ok: false, cls: 'other', error: ROLES };
    expectOpen(await press(), `its roles could not be set up (${ROLES})`);
    expect(count(isInspect)).toBe(2);
    expect(fromCreate().filter(a => a[0] === 'role').length).toBe(1);
    expect(fromCreate().filter(a => a[0] === 'roles').length).toBe(2);
    expect(docker.running[CONTAINER]).toBe(true);
    db.roles = { ok: true, wrote: [] };
    return before;
  }

  const found: Array<[string, (kept: string) => MountAnswer, (kept: string) => string]> = [
    ['the kept volume', kept => ({ out: `volume ${kept}\n` }), kept => T.mount([`volume ${kept}`], V()) + T.stopped(CONTAINER, false, true)],
    ['a docker error', () => ({ stderr: DAEMON }), () => T.unknown(V(), DAEMON) + T.stopped(CONTAINER, false, false)],
    ['no answer in 30 s', () => ({ timeout: true }), () => T.unknown(V(), TIMEOUT) + T.stopped(CONTAINER, false, false)],
  ];
  it.each(found)('R5: after a press that wrote, the first read answers %s: no start, no write in this press, the running container stopped', async (_n, answerOf, reasonOf) => {
    const before = await wrote();
    const kept = before.inst.fleetDb!.volume;
    run.mounts[CONTAINER] = answerOf(kept);
    expectOpen(await press(), reasonOf(kept));
    expect(count(isInspect)).toBe(1);
    expect(count(isStart)).toBe(0);
    expectNoWrite();
    expectOneStopAfterInspect();
    expect(docker.running[CONTAINER]).toBe(false);
  });

  it('R5: gone at the first read on a second press: no stop', async () => {
    await wrote();
    docker.running[CONTAINER] = false;
    run.mounts[CONTAINER] = GONE;
    expectOpen(await press(), T.gone(V()));
    expect(count(isInspect)).toBe(1);
    expect(count(isStart)).toBe(0);
    expectNoWrite();
    expect(count(isStop)).toBe(0);
  });

  const notStopped: Array<[string, (kept: string) => MountAnswer, (kept: string) => string]> = [
    ['the kept volume', kept => ({ out: `volume ${kept}\n` }), kept => T.mount([`volume ${kept}`], V()) + T.notStopped(CONTAINER, STOP_ERROR, 'found', true)],
    ['a docker error', () => ({ stderr: DAEMON }), () => T.unknown(V(), DAEMON) + T.notStopped(CONTAINER, STOP_ERROR, 'found', false)],
  ];
  it.each(notStopped)('R5f: the same with %s and the stop answered by a docker error: the container did not stop, with the commands', async (_n, answerOf, reasonOf) => {
    const before = await wrote();
    const kept = before.inst.fleetDb!.volume;
    run.mounts[CONTAINER] = answerOf(kept);
    h.s0 = { mode: 'error', skip: 0 };
    expectOpen(await press(), reasonOf(kept));
    expect(count(isStart)).toBe(0);
    expectNoWrite();
    expectOneStopAfterInspect();
  });

  it('R5f: the kept volume on a container found running, the stop exits 0 and the read after it gets no answer: can\'t confirm', async () => {
    const before = await wrote();
    const kept = before.inst.fleetDb!.volume;
    run.mounts[CONTAINER] = { out: `volume ${kept}\n` };
    h.s0 = { mode: 'unread', skip: 0 };
    expectOpen(await press(), T.mount([`volume ${kept}`], V()) + T.notStopped(CONTAINER, `docker did not say whether ${CONTAINER} stopped`, 'unread', true));
    expectOneStopAfterInspect();
  });

  const unreadStops: Array<[string, null | 'error' | 'stays' | 'unread', (c: string) => string, boolean | null]> = [
    ['the stop works', null, c => T.stopped(c, false, true), false],
    ['docker refuses the stop', 'error', c => T.notStopped(c, STOP_ERROR, 'unread', true), true],
    ['the stop exits 0 and the read after it says the container runs', 'stays', c => T.notStopped(c, `${c} still runs`, 'found', true), true],
    ['the stop exits 0 and the read after it gets no answer', 'unread', c => T.notStopped(c, `docker did not say whether ${c} stopped`, 'unread', true), null],
  ];
  it.each(unreadStops)('R6: after a press that wrote, the first read shows the kept volume and docker does not say whether the container runs, %s: the stop runs and its own answer picks the words', async (_n, mode, tail, running) => {
    const before = await wrote();
    const kept = before.inst.fleetDb!.volume;
    run.mounts[CONTAINER] = { out: `volume ${kept}\n` };
    vi.spyOn(containerManager, 'containerRunningExact').mockResolvedValue(null);
    if (mode) h.s0 = { mode, skip: 0 };
    const answer = await press();
    expectOpen(answer, T.mount([`volume ${kept}`], V()) + tail(CONTAINER));
    expect(vi.mocked(containerManager.containerRunningExact)).toHaveBeenCalledWith(CONTAINER);
    expect(count(isStart)).toBe(0);
    expectNoWrite();
    expectOneStopAfterInspect();
    expect(docker.running[CONTAINER]).toBe(running);
  });

  const afterWrote: Array<[string, (kept: string) => MountAnswer, (kept: string) => string, boolean | null]> = [
    ['the kept volume', kept => ({ out: `volume ${kept}\n` }), kept => T.mount([`volume ${kept}`], V()) + T.stopped(CONTAINER, false, true), true],
    ['a docker error', () => ({ stderr: DAEMON }), () => T.unknown(V(), DAEMON) + T.stopped(CONTAINER, false, false), true],
    ['the kept volume, with no answer to the running read before the start', kept => ({ out: `volume ${kept}\n` }), kept => T.mount([`volume ${kept}`], V()) + T.stopped(CONTAINER, false, true), null],
  ];
  it.each(afterWrote)('R7 (M9, then Mb): after a press that wrote, the read after the start answers %s: the container is stopped, and the text does not say compose started it', async (_n, answerOf, reasonOf, running) => {
    const before = await wrote();
    const kept = before.inst.fleetDb!.volume;
    docker.running[CONTAINER] = running;
    run.mounts[CONTAINER] = [null, answerOf(kept)];
    const error = expectOpen(await press(), reasonOf(kept));
    expect(error).not.toContain('compose started');
    expect(error).not.toContain('again;');
    expect(error).not.toContain('stopped again');
    expect(count(isStart)).toBe(1);
    expect(count(isInspect)).toBe(2);
    expectNoWrite();
    expect(count(isStop)).toBe(1);
    expect(docker.calls.findIndex(isStop)).toBeGreaterThan(docker.calls.map(isInspect).lastIndexOf(true));
    expect(docker.running[CONTAINER]).toBe(false);
  });

  const ranBefore: Array<[string, boolean | null]> = [
    ['shows the container running', true],
    ['gets no answer', null],
  ];
  it.each(ranBefore)('R8 (S0-2): after a press that wrote, the running read before the start %s, the read after the start shows the kept volume and docker refuses the stop: did not stop, and the text does not say compose started it', async (_n, running) => {
    const before = await wrote();
    const kept = before.inst.fleetDb!.volume;
    docker.running[CONTAINER] = running;
    run.mounts[CONTAINER] = [null, { out: `volume ${kept}\n` }];
    h.s0 = { mode: 'error', skip: 0 };
    expectOpen(await press(), T.mount([`volume ${kept}`], V()) + T.notStopped(CONTAINER, STOP_ERROR, 'found', true));
    expect(count(isStart)).toBe(1);
    expectNoWrite();
    expect(count(isStop)).toBe(1);
  });
});

describe('nm37 run: the read after the start (Mb, S0)', () => {
  const second: Array<[string, (kept: string) => MountAnswer, (kept: string) => string]> = [
    ['the kept volume', kept => ({ out: `volume ${kept}\n` }), kept => T.mount([`volume ${kept}`], V()) + T.stopped(CONTAINER, true, true)],
    ['a docker error', () => ({ stderr: DAEMON }), () => T.unknown(V(), DAEMON) + T.stopped(CONTAINER, true, false)],
  ];
  it.each(second)('R7: the read after the start answers %s: the start ran, no pg_isready, no write, the container stopped again', async (_n, answerOf, reasonOf) => {
    const before = await fixture();
    const kept = before.inst.fleetDb!.volume;
    run.mounts[CONTAINER] = [null, answerOf(kept)];
    expectOpen(await press(), reasonOf(kept));
    expect(count(isStart)).toBe(1);
    expect(count(isInspect)).toBe(2);
    expectNoWrite();
    expect(count(isStop)).toBe(2);
    expect(docker.calls.map(isStop).lastIndexOf(true)).toBeGreaterThan(docker.calls.map(isInspect).lastIndexOf(true));
    expect(docker.running[CONTAINER]).toBe(false);
  });

  const stops: Array<[string, 'error' | 'hang' | 'stays' | 'unread', string, 'started' | 'unread']> = [
    ['docker answers an error', 'error', STOP_ERROR, 'started'],
    ['docker does not answer in 90 s', 'hang', 'docker did not answer within 90 s', 'unread'],
    ['docker answers ok and the container still runs', 'stays', `${CONTAINER} still runs`, 'started'],
    ['docker answers ok and the read after it gets no answer', 'unread', `docker did not say whether ${CONTAINER} stopped`, 'unread'],
  ];
  it.each(stops)('R8 (S0-2): after R7\'s kept volume, the stop fails (%s): did not stop when docker said so, can\'t confirm when it did not answer, with the commands', async (_n, mode, err, how) => {
    const before = await fixture();
    const kept = before.inst.fleetDb!.volume;
    run.mounts[CONTAINER] = [null, { out: `volume ${kept}\n` }];
    h.s0 = { mode, skip: 1 };
    let answer: unknown;
    if (mode === 'hang') {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const p = press();
        let done = false;
        p.then(() => { done = true; }, () => { done = true; });
        for (let i = 0; i < 800 && !done; i++) await vi.advanceTimersByTimeAsync(250);
        answer = await p;
      } finally {
        vi.useRealTimers();
      }
    } else {
      answer = await press();
    }
    expectOpen(answer, T.mount([`volume ${kept}`], V()) + T.notStopped(CONTAINER, err, how, true));
    expect(count(isStart)).toBe(1);
    expectNoWrite();
    expect(count(isStop)).toBe(2);
  });
});

describe('nm37 run: what the operator does next', () => {
  async function m2(ssl = 'off'): Promise<{ before: Before; kept: string; answer: unknown; reason: string }> {
    const before = await fixture(ssl);
    const kept = before.inst.fleetDb!.volume;
    run.volumes[kept] = 'exists';
    run.mounts[CONTAINER] = { out: `volume ${kept}\n` };
    return { before, kept, answer: await press(), reason: T.mount([`volume ${kept}`], V()) + T.idle(CONTAINER, true) };
  }

  it('R9 (M6, M7): Run it again with nothing changed gives the same answer and starts nothing; once compose makes the container anew, a third press ends as R1', async () => {
    const { before, answer, reason } = await m2();
    expectOpen(answer, reason);
    const again = await press();
    expect(again).toEqual(answer);
    expect(count(isCreate)).toBe(1);
    expect(count(isInspect)).toBe(1);
    expectNoStart();
    expectNoWrite();
    expect(count(isStop)).toBe(0);
    delete run.mounts[CONTAINER];
    expectDone(before, await press(), 0);
  });

  it('R10: the same stop with the kept database on TLS: no TLS call', async () => {
    const { answer, reason } = await m2('on');
    expect(stored().keptOp).toMatchObject({ keptSsl: true });
    expectOpen(answer, reason);
    expect(tlsFake.calls).toEqual([]);
    expect(tlsFake.opensslArgs).toEqual([]);
    expectNoStart();
  });

  it('R11 (O2): Put back after the stop: its done answer, the kept volume in use again, the -new set holds the new volume', async () => {
    const { before, kept, answer, reason } = await m2();
    expectOpen(answer, reason);
    run.volumes[V()] = 'exists';
    skew.ms = LATER - NOW;
    const back = await pressBack(fwd().stamp, { reverse: true });
    expect(back).toMatchObject({ success: true });
    expect((back as { text: string }).text.startsWith('Put back.')).toBe(true);
    expect(bot().fleetDb).toEqual(before.inst.fleetDb);
    expect(bot().fleetDb!.volume).toBe(kept);
    expect(bot().keptOp).toBeUndefined();
    expect(bot().keptSets).toEqual([{
      id: `${fwd().stamp}-new`, keptAt: LATER_ISO, by: 'put-back', folder: fwd().inDir,
      db: { containerName: CONTAINER, user: before.inst.fleetDb!.user, db: before.inst.fleetDb!.db, volume: V(), password: before.inst.fleetDb!.password },
    }]);
  });

  it('R12: the page\'s open line equals the answer\'s error', async () => {
    const { answer, reason } = await m2();
    const error = expectOpen(answer, reason);
    expect(pageOpenLine(bot().keptOp)).toBe(error);
    expect(error).toContain(`docker shows volume bota-fleet-postgres-data at the database's data folder, not the new volume ${V()}, so the manager wrote nothing into that database, and did not start the container bota-fleet-postgres; remove it in a shell with docker rm bota-fleet-postgres, then run it again, so that compose makes the container anew from the deployed compose. Done so far: `);
  });

  it('R13: through the route POST /:id/fleet-db/new-start: 409, open, with the same text', async () => {
    const before = await fixture();
    const kept = before.inst.fleetDb!.volume;
    run.mounts[CONTAINER] = { out: `volume ${kept}\n` };
    const answer = await call('/:id/fleet-db/new-start', { id: 'a' });
    const rec = stored().keptOp as KeptOpRecord;
    const reason = T.mount([`volume ${kept}`], V()) + T.idle(CONTAINER, true);
    expect(rec).toMatchObject({ step: 'db-in', lastError: reason });
    expect(answer).toEqual({ status: 409, body: { success: false, open: true, error: KEPT_TEXT.nOpen(reason, newStartDone(rec)) } });
  });

  it('R14 (M3 at the second read, through the route): the container is gone after the start: 409, the start ran, no stop, no write', async () => {
    await fixture();
    run.mounts[CONTAINER] = [null, GONE];
    docker.calls.length = 0;
    run.execCalls.length = 0;
    run.psqlCalls.length = 0;
    const answer = await call('/:id/fleet-db/new-start', { id: 'a' });
    const rec = stored().keptOp as KeptOpRecord;
    expect(rec).toMatchObject({ step: 'db-in', lastError: T.gone(V()) });
    expect(answer).toEqual({ status: 409, body: { success: false, open: true, error: KEPT_TEXT.nOpen(T.gone(V()), newStartDone(rec)) } });
    expect(count(isStart)).toBe(1);
    expect(count(isInspect)).toBe(2);
    expect(count(isStop)).toBe(1);
    expect(docker.calls.findIndex(isStop)).toBeLessThan(docker.calls.findIndex(isCreate));
    expectNoWrite();
  });
});
