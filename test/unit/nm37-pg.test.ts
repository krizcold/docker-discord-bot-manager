import { afterAll, describe, expect, it, vi } from 'vitest';

// NM37 against real docker, the compose plugin and Postgres 16. Skipped on Windows and without docker; the main session runs it on Linux.
const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm37-pg-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import { containerMounts } from '../../src/docker/dockerClient';
import * as envManager from '../../src/env/manager';
import { addFleetPostgresService } from '../../src/templates/pcsProcessing';
import { docker, dockerRuns, PG_IMAGE } from './pg-cluster';
import { seedBot } from './nm2-harness';

const U = 'app';
const DB = 'app';
const PW = 'nm37-pg-bot-password';
const P = '/var/lib/postgresql/data';
const id = `nm37pg${process.pid}`;
const name = `${id}-fleet-postgres`;
const K = `${name}-data`;
const V = `${K}-2026-11-17T12-00-00-000Z`;
const composePath = path.join(h.dir, 'bots', id, 'docker-compose.yml');
const FIELDS = ['Database cluster state', 'Database system identifier', 'Latest checkpoint location'];

const ok = (r: { status: number | null; out: string; err: string }) => {
  expect(r.status, r.err).toBe(0);
  return r.out;
};

const composeRuns = dockerRuns && docker(['compose', 'version']).status === 0;
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function waitReady(container: string): void {
  for (let i = 0; i < 240; i++) {
    if (docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-q']).status === 0) return;
    pause(500);
  }
  throw new Error(`${container} did not become ready`);
}

/** pg_controldata of a stopped cluster's volume, read through a read-only mount. */
function controlData(volume: string): Record<string, string> {
  const out = ok(docker(['run', '--rm', '--network', 'none', '-u', 'postgres', '-v', `${volume}:${P}:ro`, '--entrypoint', 'pg_controldata', PG_IMAGE, P]));
  return Object.fromEntries(out.split('\n').map(l => l.split(/:\s+/)).filter(p => p.length >= 2).map(([k, ...v]) => [k.trim(), v.join(': ').trim()]));
}

const three = (c: Record<string, string>) => FIELDS.map(f => c[f]);
const inspect = (format: string) => ok(docker(['container', 'inspect', '-f', format, name])).trim();

let net: string | null = null;
let onNewVolume = false;
afterAll(() => {
  if (dockerRuns) {
    docker(['rm', '-f', name]);
    docker(['network', 'rm', `${id}_default`]);
    docker(['volume', 'rm', '-f', K]);
    docker(['volume', 'rm', '-f', V]);
    if (net) docker(['network', 'rm', net]);
  }
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32' || !dockerRuns)('NM37: the create without a start and the two mount reads against real docker and Postgres 16 (Linux with docker)', () => {
  it('PG1 (F1, F2, M1, M9): compose makes a new container for the new volume without starting it, a created container shows its mount and takes a stop, the start passes both reads, the kept volume is never started, and a second start leaves the running container alone', async () => {
    expect(composeRuns, 'this row needs the docker compose plugin in the runner').toBe(true);
    net = docker(['network', 'inspect', 'dbm_internal']).status === 0 ? null : 'dbm_internal';
    if (net) ok(docker(['network', 'create', net]));
    process.env.DEPLOYMENT_MODE = 'docker';
    const keptDb = { containerName: name, user: U, db: DB, volume: K, password: PW };
    seedBot({ sourceUrl: 'https://github.com/x/fully-modular-discord-bot', sanitizedName: id, fleetDb: keptDb }, id);
    envManager.setEnvVars(id, { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: `postgresql://${U}:${PW}@${name}:5432/${DB}` });
    fs.mkdirSync(path.dirname(composePath), { recursive: true });
    fs.writeFileSync(composePath, addFleetPostgresService('services:\n  app:\n    image: app\n', containerManager.getBot(id) as any, keptDb, { mode: 'docker' }));
    ok(docker(['compose', '-f', composePath, '-p', id, 'up', '-d', 'fleet-postgres']));
    waitReady(name);
    ok(docker(['exec', '-i', name, 'psql', '-X', '-U', 'dbm_admin', '-d', DB, '-tA', '-v', 'ON_ERROR_STOP=1'],
      'CREATE TABLE kept_rows (id int PRIMARY KEY, body text); INSERT INTO kept_rows SELECT g, md5(g::text) FROM generate_series(1, 500) g;'));

    // N1, then N2, N3's field and N7.
    expect(await containerManager.stopContainerExact(name, 60)).toEqual({ ok: true });
    const first = controlData(K);
    expect(first['Database cluster state']).toBe('shut down');
    expect(containerManager.takeFleetDbServicesOut(id)).toEqual({ success: true });
    const newDb = { ...keptDb, volume: V };
    const registry = path.join(h.dir, 'instances.json');
    const reg = JSON.parse(fs.readFileSync(registry, 'utf-8'));
    reg.instances[id].fleetDb = newDb;
    fs.writeFileSync(registry, JSON.stringify(reg, null, 2));
    expect(await containerManager.writeFleetDbService(id, newDb)).toEqual({ success: true });

    // The create by hand, with the file and the project name startFleetDbSidecar uses.
    ok(docker(['compose', '-f', composePath, '-p', id, 'up', '--no-start', 'fleet-postgres']));
    expect(inspect('{{.State.Status}}')).toBe('created');
    expect(containerMounts(name, P)).toEqual({ ok: true, mounts: [`volume ${V}`] });
    expect(await containerManager.stopContainerExact(name, 60)).toEqual({ ok: true });
    expect(inspect('{{.State.Status}}')).toBe('created');

    expect(await containerManager.startFleetDbSidecar(id, { dataVolume: V })).toEqual({ success: true });
    expect(inspect('{{.State.Running}}')).toBe('true');
    expect(containerMounts(name, P)).toEqual({ ok: true, mounts: [`volume ${V}`] });
    expect(three(controlData(K))).toEqual(three(first));

    const containerId = inspect('{{.Id}}');
    const startedAt = inspect('{{.State.StartedAt}}');
    expect(await containerManager.startFleetDbSidecar(id, { dataVolume: V })).toEqual({ success: true });
    expect(inspect('{{.Id}}')).toBe(containerId);
    expect(inspect('{{.State.StartedAt}}')).toBe(startedAt);
    onNewVolume = true;
  }, 480_000);

  it('PG2 (M2): a container that shows another volume than the one named is not started and its volume is not written; naming its volume starts it', async () => {
    expect(onNewVolume, 'this row starts from the cluster PG1 leaves on the new volume').toBe(true);
    expect(await containerManager.stopContainerExact(name, 60)).toEqual({ ok: true });
    const before = controlData(V);
    expect(before['Database cluster state']).toBe('shut down');

    expect(await containerManager.startFleetDbSidecar(id, { dataVolume: `${V}-other` })).toEqual({
      success: false, error: `docker did not show the database container on the volume ${V}-other`, mount: { mounts: [`volume ${V}`] }, started: false,
    });
    expect(inspect('{{.State.Running}}')).toBe('false');
    expect(three(controlData(V))).toEqual(three(before));

    expect(await containerManager.startFleetDbSidecar(id, { dataVolume: V })).toEqual({ success: true });
    expect(inspect('{{.State.Running}}')).toBe('true');
  }, 480_000);
});
