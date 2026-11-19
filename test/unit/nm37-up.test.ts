import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm37-up-'));
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
import * as dbLogin from '../../src/instance/dbLogin';
import * as fleetReplication from '../../src/instance/fleetReplication';
import * as fleetSwitch from '../../src/instance/fleetSwitch';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { docker, resetDocker } from './nm2-docker';
import { clearRegistry } from './nm2-harness';
import { MountAnswer, resetRun, run } from './nm31-run';
import { answerDatabase, composePathOf, CONTAINER, db, resetSeed, seedMain } from './nm31-seed';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const FORMAT = '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Type}} {{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}}{{println}}{{end}}{{end}}';
const INSPECT = ['container', 'inspect', '-f', FORMAT, CONTAINER];
const DAEMON = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';
const GONE = `Error: No such container: ${CONTAINER}`;
const create = () => `docker compose -f "${composePathOf('a')}" -p "bota" up --no-start fleet-postgres`;
const start = () => `docker compose -f "${composePathOf('a')}" -p "bota" up -d fleet-postgres`;
const stopText = (volume: string) => `docker did not show the database container on the volume ${volume}`;

let W = '';
const spies = { role: 0, roles: 0, generation: 0 };

/** seedMain's fixture with its container stopped, the database calls answered, and each write counted and marked in docker.calls. */
async function fixture(): Promise<void> {
  await seedMain();
  W = containerManager.getBot('a')!.fleetDb!.volume;
  answerDatabase();
  vi.spyOn(dbLogin, 'ensureManagerDbRole').mockImplementation(async () => { spies.role++; docker.calls.push(['role']); return db.role; });
  vi.spyOn(fleetReplication, 'provisionManagedRoles').mockImplementation(async () => { spies.roles++; return db.roles; });
  vi.mocked(fleetSwitch.ensureMainGeneration).mockRestore();
  const real = fleetSwitch.ensureMainGeneration;
  vi.spyOn(fleetSwitch, 'ensureMainGeneration').mockImplementation(async (id) => { spies.generation++; return real(id); });
  docker.running[CONTAINER] = false;
  docker.calls.length = 0;
  run.execCalls.length = 0;
  run.psqlCalls.length = 0;
}

const inspects = () => docker.calls.filter(a => a[0] === 'container');
const ready = () => run.execCalls.filter(c => c.includes(' pg_isready '));
const meta = () => run.psqlCalls.filter(c => c.login === 'dbm_meta');

function expectNoWrite(): void {
  expect(spies).toEqual({ role: 0, roles: 0, generation: 0 });
  expect(ready()).toEqual([]);
  expect(meta()).toEqual([]);
}

function expectNoStart(): void {
  expect(run.execCalls.filter(c => c.includes(' up -d '))).toEqual([]);
  expect(docker.running[CONTAINER]).not.toBe(true);
}

/** The control's detectors: each write ran and shows. */
function expectWrote(): void {
  expect(spies.role).toBe(1);
  expect(spies.roles).toBe(1);
  expect(spies.generation).toBe(1);
  expect(ready().length).toBeGreaterThan(0);
  expect(meta().length).toBeGreaterThan(0);
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
  dbLogin.resetManagerRoleCache();
  fleetSwitch.resetSwitchState();
  Object.assign(spies, { role: 0, roles: 0, generation: 0 });
});
afterEach(() => {
  releaseFleetBackupBusy('a');
  vi.restoreAllMocks();
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('nm37 up: startFleetDbSidecar with the volume the caller expects', () => {
  it('S1: the volume shown at both reads: created, read, started, read again, then pg_isready and the writes', async () => {
    await fixture();
    expect(await containerManager.startFleetDbSidecar('a', { dataVolume: W })).toEqual({ success: true });
    const at = (pred: (a: string[]) => boolean, from = 0) => docker.calls.findIndex((a, i) => i >= from && pred(a));
    const made = at(a => a[0] === 'sh' && a[1] === create());
    const first = at(a => a[0] === 'container');
    const up = at(a => a[0] === 'sh' && a[1] === start());
    const second = at(a => a[0] === 'container', up);
    const isReady = at(a => a[0] === 'sh' && a[1].includes(' pg_isready '));
    const role = at(a => a[0] === 'role');
    expect(made).toBeGreaterThanOrEqual(0);
    expect(first).toBeGreaterThan(made);
    expect(up).toBeGreaterThan(first);
    expect(second).toBeGreaterThan(up);
    expect(isReady).toBeGreaterThan(second);
    expect(role).toBeGreaterThan(isReady);
    expect(inspects()).toEqual([INSPECT, INSPECT]);
    expect(docker.running[CONTAINER]).toBe(true);
    expectWrote();
  });

  const shown: Array<[string, () => string, () => string[]]> = [
    ['another volume', () => 'volume other\n', () => ['volume other']],
    ['a volume whose name starts with the expected one', () => `volume ${W}-x\n`, () => [`volume ${W}-x`]],
    ['a folder of the host', () => 'bind /srv/pgdata\n', () => ['bind /srv/pgdata']],
    ['no mount', () => '', () => []],
    ['two mounts', () => `volume ${W}\nvolume other\n`, () => [`volume ${W}`, 'volume other']],
  ];
  it.each(shown)('S2: the first read shows %s: the stop with what docker showed, nothing started, nothing written', async (_n, out, mounts) => {
    await fixture();
    run.mounts[CONTAINER] = { out: out() };
    expect(await containerManager.startFleetDbSidecar('a', { dataVolume: W })).toEqual({ success: false, error: stopText(W), mount: { mounts: mounts() }, started: false });
    expect(run.execCalls).toEqual([create()]);
    expect(inspects()).toEqual([INSPECT]);
    expectNoStart();
    expectNoWrite();
  });

  it('S3: the first read answers no such container: gone, nothing started', async () => {
    await fixture();
    run.mounts[CONTAINER] = { stderr: GONE };
    expect(await containerManager.startFleetDbSidecar('a', { dataVolume: W })).toEqual({ success: false, error: stopText(W), mount: { gone: true }, started: false });
    expect(inspects()).toEqual([INSPECT]);
    expectNoStart();
    expectNoWrite();
  });

  const unread: Array<[string, MountAnswer, string]> = [
    ['docker\'s error', { stderr: DAEMON }, DAEMON],
    ['no answer in 30 s', { timeout: true }, 'spawnSync docker ETIMEDOUT'],
  ];
  it.each(unread)('S4: the first read gets %s: the error as docker gave it, nothing started', async (_n, answer, text) => {
    await fixture();
    run.mounts[CONTAINER] = answer;
    expect(await containerManager.startFleetDbSidecar('a', { dataVolume: W })).toEqual({ success: false, error: stopText(W), mount: { error: text }, started: false });
    expect(inspects()).toEqual([INSPECT]);
    expectNoStart();
    expectNoWrite();
  });

  const second: Array<[string, MountAnswer, unknown]> = [
    ['another volume', { out: 'volume other\n' }, { mounts: ['volume other'] }],
    ['no such container', { stderr: GONE }, { gone: true }],
    ['docker\'s error', { stderr: DAEMON }, { error: DAEMON }],
  ];
  it.each(second)('S5: the read after the start shows %s: started true, the up -d ran, no pg_isready, nothing written', async (_n, answer, mount) => {
    await fixture();
    run.mounts[CONTAINER] = [null, answer];
    expect(await containerManager.startFleetDbSidecar('a', { dataVolume: W })).toEqual({ success: false, error: stopText(W), mount, started: true, ran: false });
    expect(run.execCalls).toEqual([create(), start()]);
    expect(inspects()).toEqual([INSPECT, INSPECT]);
    const runningRead = docker.calls.findIndex(a => a[0] === 'inspect' && a[2] === '{{.State.Running}}' && a[3] === CONTAINER);
    expect(runningRead).toBeGreaterThan(docker.calls.findIndex(a => a[0] === 'container'));
    expect(runningRead).toBeLessThan(docker.calls.findIndex(a => a[0] === 'sh' && a[1] === start()));
    expectNoWrite();
  });

  it.each([['ran already', true], ['had no running read answered', null]] as const)('S5b: the read after the start shows another volume on a container that %s: started false, with what the running read said', async (_n, running) => {
    await fixture();
    docker.running[CONTAINER] = running;
    run.mounts[CONTAINER] = [null, { out: 'volume other\n' }];
    expect(await containerManager.startFleetDbSidecar('a', { dataVolume: W })).toEqual({ success: false, error: stopText(W), mount: { mounts: ['volume other'] }, started: false, ran: running });
    expect(run.execCalls).toEqual([create(), start()]);
    expectNoWrite();
  });

  it('S6 (X1, the control): no volume named: no create, no read, the start and the writes as before', async () => {
    await fixture();
    run.mounts[CONTAINER] = { out: 'volume other\n' };
    expect(await containerManager.startFleetDbSidecar('a')).toEqual({ success: true });
    expect(run.execCalls.filter(c => c.includes('--no-start'))).toEqual([]);
    expect(run.execCalls[0]).toBe(start());
    expect(inspects()).toEqual([]);
    expect(docker.calls.some(a => a[0] === 'role')).toBe(true);
    expectWrote();
  });

  it('S7: the create fails: its error, no read, no start', async () => {
    await fixture();
    run.execOverrides.push({ match: c => c.endsWith('up --no-start fleet-postgres'), answer: { ok: false, stderr: 'unknown flag: --no-start' } });
    expect(await containerManager.startFleetDbSidecar('a', { dataVolume: W })).toEqual({ success: false, error: 'Error: unknown flag: --no-start' });
    expect(run.execCalls).toEqual([create()]);
    expect(inspects()).toEqual([]);
    expectNoStart();
    expectNoWrite();
  });

  it('S8: the start fails after the first read passed: its error as before, one read', async () => {
    await fixture();
    run.execOverrides.push({ match: c => c.endsWith('up -d fleet-postgres'), answer: { ok: false, stderr: 'Error response from daemon: no space left on device' } });
    expect(await containerManager.startFleetDbSidecar('a', { dataVolume: W })).toEqual({ success: false, error: 'Error: Error response from daemon: no space left on device' });
    expect(run.execCalls).toEqual([create(), start()]);
    expect(inspects()).toEqual([INSPECT]);
    expectNoWrite();
  });
});
