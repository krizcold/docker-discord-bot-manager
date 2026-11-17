import { afterAll, describe, expect, it, vi } from 'vitest';

// NM31 against a real Postgres 16. Skipped on Windows and without docker; the main session runs it on Linux.
const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-pg-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { clusterPsql, forgetManagerRole, missingLogin, runCall } from '../../src/instance/dbLogin';
import { runOrderInOp } from '../../src/instance/maintenance';
import { readGeneration, readGenerationAsAdmin } from '../../src/instance/fleetSwitch';
import { provisionManagedRoles } from '../../src/instance/fleetReplication';
import { ensureGenerationSql, restoreStateUpsertSql } from '../../src/instance/switchSql';
import { backupDir, CHECKSUM_SQL } from '../../src/instance/backupFiles';
import { checkDumpInThrowaway } from '../../src/instance/backupCheck';
import { deleteKept, generationRefusal, KEPT_TEXT, keptScratchNames } from '../../src/instance/keptData';
import { addFleetPostgresService } from '../../src/templates/pcsProcessing';
import { type Cluster, docker, dockerRuns, PG_IMAGE, provisionedCluster, startCluster } from './pg-cluster';
import { seedBot } from './nm2-harness';

const ID = `nm31pg${process.pid}`;
const U = 'app';
const DB = 'app';
const PW = 'nm31-pg-bot-password';

const ok = (r: { status: number | null; out: string; err: string }) => {
  expect(r.status, r.err).toBe(0);
  return r.out;
};

const record = (c: Cluster) => ({ containerName: c.name, user: c.user, db: c.db, volume: `${c.name}-data` });

/** A cluster as the pre-redesign manager made it: POSTGRES_USER is the bot role, no dbm_meta, no dbm_work; dbm_admin created over it as NX2 13.1 proposes. */
function oldCluster(name: string): Cluster {
  const c = startCluster({ name, user: U, db: DB, password: PW, firstRole: U });
  ok(c.psql(U, 'CREATE ROLE "dbm_admin" WITH SUPERUSER LOGIN;', 'postgres'));
  return c;
}

/**
 * The generation schema and raise as a manager built at 7985478 (before NM20) wrote them, from
 * `git show 7985478:src/instance/switchSql.ts` (TABLES and raiseSql, machine 'main.example'). It grants only to PUBLIC,
 * so it runs on a cluster without dbm_work or dbm_meta.
 */
const RAISE_7985478 = (target: number) => `BEGIN;
CREATE SCHEMA IF NOT EXISTS smdb_manager;
CREATE TABLE IF NOT EXISTS smdb_manager.generation (
  one_row boolean PRIMARY KEY DEFAULT true CHECK (one_row), machine text NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 1), since timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS smdb_manager.handover (
  one_row boolean PRIMARY KEY DEFAULT true CHECK (one_row), slot text NOT NULL, machine text NOT NULL,
  generation bigint NOT NULL, at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS smdb_manager.received (
  push_id text PRIMARY KEY, from_system_id text NOT NULL, from_machine text NOT NULL, generation bigint NOT NULL,
  at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS smdb_manager.copies (
  slot text PRIMARY KEY, machine text, client text, seen_at timestamptz NOT NULL DEFAULT now());
GRANT USAGE ON SCHEMA smdb_manager TO PUBLIC;
GRANT SELECT ON smdb_manager.generation TO PUBLIC;
INSERT INTO smdb_manager.generation AS g (one_row, machine, generation, since) VALUES (true, 'main.example', ${target}, now())
  ON CONFLICT (one_row) DO UPDATE SET machine = EXCLUDED.machine, generation = EXCLUDED.generation, since = now()
  WHERE g.generation < EXCLUDED.generation;
DELETE FROM smdb_manager.handover;
SELECT generation || '|' || machine || '|' || to_char(since AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') FROM smdb_manager.generation;
COMMIT;`;

const clusters: Cluster[] = [];
afterAll(() => {
  for (const c of clusters) c.remove();
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32' || !dockerRuns)('NM31 part 2: the generation read of A20 against a real Postgres 16 (Linux with docker)', () => {
  it('PG5 (the read half): an old cluster gives missingLogin dbm_meta, and readGenerationAsAdmin reads no table', async () => {
    const c = oldCluster(`${ID}-pg5`);
    clusters.push(c);
    const t = { container: c.name, user: U };
    const meta = await readGeneration(t, DB);
    expect(meta.ok).toBe(false);
    expect(missingLogin((meta as { stderr?: string }).stderr ?? '')).toBe('dbm_meta');
    expect(await readGenerationAsAdmin(t, DB)).toEqual({ ok: true, row: null });
    expect(await generationRefusal(record(c))).toBeNull();
  }, 240_000);

  it('PG8: the same cluster with generation 2 written as the bot role: the admin read gives 2 and A20 refuses', async () => {
    const c = oldCluster(`${ID}-pg8`);
    clusters.push(c);
    ok(c.psql(U, RAISE_7985478(2)));
    const read = await readGenerationAsAdmin({ container: c.name, user: U }, DB);
    expect(read).toMatchObject({ ok: true, row: { generation: 2, machine: 'main.example' } });
    expect(await generationRefusal(record(c))).toBe(KEPT_TEXT.aGen(2));
  }, 240_000);

  it('PG9: the generation table created and written as dbm_admin: the admin read gives 2 and A20 refuses', async () => {
    const c = oldCluster(`${ID}-pg9`);
    clusters.push(c);
    ok(c.psql('dbm_admin', RAISE_7985478(2), DB));
    const read = await readGenerationAsAdmin({ container: c.name, user: U }, DB);
    expect(read).toMatchObject({ ok: true, row: { generation: 2 } });
    expect(await generationRefusal(record(c))).toBe(KEPT_TEXT.aGen(2));
  }, 240_000);

  it('PG7: a provisioned cluster with row 1 and a restore floor of 2 answers 2 as A20 reads it', async () => {
    const c = await provisionedCluster({ name: `${ID}-pg7`, user: U, db: DB, password: PW });
    clusters.push(c);
    ok(c.psql('dbm_meta', ensureGenerationSql('main.example')));
    ok(c.psql('dbm_admin', restoreStateUpsertSql('daily-2026-11-01T00-00-00-000Z.dump', { generation: 2, machine: 'main.example', since: null }), 'postgres'));
    const meta = await readGeneration({ container: c.name, user: U }, DB);
    expect(meta).toMatchObject({ ok: true, row: { generation: 1 } });
    expect(await generationRefusal(record(c))).toBe(KEPT_TEXT.aGen(2));
  }, 240_000);
});

const composeRuns = dockerRuns && docker(['compose', 'version']).status === 0;

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function waitReady(name: string): void {
  for (let i = 0; i < 240; i++) {
    if (docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-q']).status === 0) return;
    pause(500);
  }
  throw new Error(`${name} did not become ready`);
}

/** pg_controldata of a stopped cluster's volume, read through a read-only mount. */
function controlData(volume: string): Record<string, string> {
  const out = ok(docker(['run', '--rm', '--network', 'none', '-u', 'postgres', '-v', `${volume}:/var/lib/postgresql/data:ro`, '--entrypoint', 'pg_controldata', PG_IMAGE, '/var/lib/postgresql/data']));
  return Object.fromEntries(out.split('\n').map(l => l.split(/:\s+/)).filter(p => p.length >= 2).map(([k, ...v]) => [k.trim(), v.join(': ').trim()]));
}

describe.skipIf(process.platform === 'win32' || !dockerRuns)('NM31 part 3: the new database and the stopped old one against a real Postgres 16 (Linux with docker)', () => {
  it('PG1 (N8, N9): a volume started from the service addFleetPostgresService writes has checksums on and dbm_admin as oid 10; after provisionManagedRoles the bot role logs in with the URL password, is no superuser and owns the database', async () => {
    const name = `${ID}-pg1`;
    const volume = `${name}-data`;
    clusters.push({ name, user: U, db: DB, password: PW, psql: () => ({ status: 0, out: '', err: '' }), remove: () => { docker(['rm', '-f', '-v', name]); docker(['volume', 'rm', '-f', volume]); } });
    const yaml = addFleetPostgresService('services:\n  app:\n    image: app\n', { id: name } as any, { containerName: name, volume, password: PW, user: U, db: DB }, { mode: 'docker' });
    const svc = YAML.parse(yaml).services['fleet-postgres'];
    const env = Object.entries(svc.environment as Record<string, string>).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    ok(docker(['run', '-d', '--name', name, '-v', `${volume}:${svc.volumes[0].target}`, ...env, svc.image, ...svc.command]));
    waitReady(name);
    const sums = await runCall(name, clusterPsql(name, 'SHOW data_checksums'));
    expect(sums).toMatchObject({ ok: true, stdout: 'on\n' });
    const oid = await runCall(name, clusterPsql(name, "SELECT oid FROM pg_roles WHERE rolname = 'dbm_admin'"));
    expect(oid).toMatchObject({ ok: true, stdout: '10\n' });
    seedBot({ sourceUrl: 'https://github.com/x/fully-modular-discord-bot', sanitizedName: 'pg1', fleetDb: { containerName: name, user: U, db: DB, volume, password: PW } }, 'pg1');
    envManager.setEnvVars('pg1', { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: `postgresql://${U}:${PW}@${name}:5432/${DB}` });
    expect(await provisionManagedRoles(containerManager.getBot('pg1')!)).toMatchObject({ ok: true });
    const asBot = (sql: string) => ok(docker(['exec', '-e', `PGPASSWORD=${PW}`, name, 'psql', '-X', '-h', '127.0.0.1', '-U', U, '-d', DB, '-tA', '-c', sql]));
    expect(asBot('SELECT rolsuper::text FROM pg_roles WHERE rolname = current_user')).toBe('false');
    expect(asBot(`SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '${DB}'`)).toBe(U);
  }, 240_000);

  it('PG2 (A6 code review 1: N1, N2, N7, N8, Invariant K): a cluster with rows stopped as N1 stops it reads shut down; after N2, N7 and N8 start a new database on a new volume under the same container name, the old volume keeps its identity, checkpoint and rows', async () => {
    expect(composeRuns, 'this row needs the docker compose plugin in the runner').toBe(true);
    const id = `${ID}pg2`;
    const name = `${id}-fleet-postgres`;
    const oldVolume = `${name}-data`;
    const newVolume = `${oldVolume}-2026-11-17T12-00-00-000Z`;
    const check = `${id}-check`;
    const composePath = path.join(process.env.DATA_DIR as string, 'bots', id, 'docker-compose.yml');
    const net = docker(['network', 'inspect', 'dbm_internal']).status === 0 ? null : 'dbm_internal';
    if (net) ok(docker(['network', 'create', net]));
    clusters.push({
      name, user: U, db: DB, password: PW, psql: () => ({ status: 0, out: '', err: '' }),
      remove: () => {
        docker(['rm', '-f', name]);
        docker(['rm', '-f', check]);
        docker(['network', 'rm', `${id}_default`]);
        docker(['volume', 'rm', '-f', oldVolume]);
        docker(['volume', 'rm', '-f', newVolume]);
        if (net) docker(['network', 'rm', net]);
      },
    });
    process.env.DEPLOYMENT_MODE = 'docker';
    const oldDb = { containerName: name, user: U, db: DB, volume: oldVolume, password: PW };
    seedBot({ sourceUrl: 'https://github.com/x/fully-modular-discord-bot', sanitizedName: id, fleetDb: oldDb }, id);
    envManager.setEnvVars(id, { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: `postgresql://${U}:${PW}@${name}:5432/${DB}` });
    fs.mkdirSync(path.dirname(composePath), { recursive: true });
    fs.writeFileSync(composePath, addFleetPostgresService('services:\n  app:\n    image: app\n', containerManager.getBot(id) as any, oldDb, { mode: 'docker' }));
    ok(docker(['compose', '-f', composePath, '-p', id, 'up', '-d', 'fleet-postgres']));
    waitReady(name);
    const asAdmin = (container: string, sql: string) => ok(docker(['exec', '-i', container, 'psql', '-X', '-U', 'dbm_admin', '-d', DB, '-tA', '-v', 'ON_ERROR_STOP=1'], sql));
    asAdmin(name, 'CREATE TABLE kept_rows (id int PRIMARY KEY, body text); INSERT INTO kept_rows SELECT g, md5(g::text) FROM generate_series(1, 500) g;');
    const sumsBefore = asAdmin(name, `${CHECKSUM_SQL};`);
    expect(sumsBefore).toContain('kept_rows');

    expect(await containerManager.stopContainerExact(name, 60)).toEqual({ ok: true });
    const first = controlData(oldVolume);
    expect(first['Database cluster state']).toBe('shut down');

    expect(containerManager.takeFleetDbServicesOut(id)).toEqual({ success: true });
    const newDb = { ...oldDb, volume: newVolume };
    const registry = path.join(process.env.DATA_DIR as string, 'instances.json');
    const reg = JSON.parse(fs.readFileSync(registry, 'utf-8'));
    reg.instances[id].fleetDb = newDb;
    fs.writeFileSync(registry, JSON.stringify(reg, null, 2));
    expect(await containerManager.writeFleetDbService(id, newDb)).toEqual({ success: true });
    expect(await containerManager.startFleetDbSidecar(id)).toEqual({ success: true });
    const mounts = ok(docker(['inspect', '-f', '{{range .Mounts}}{{.Name}} {{end}}', name])).split(' ').filter(Boolean);
    expect(mounts).toEqual([newVolume]);

    const second = controlData(oldVolume);
    expect(second['Database cluster state']).toBe('shut down');
    expect(second['Database system identifier']).toBe(first['Database system identifier']);
    expect(second['Latest checkpoint location']).toBe(first['Latest checkpoint location']);
    expect(controlData(newVolume)['Database system identifier']).not.toBe(first['Database system identifier']);
    ok(docker(['run', '-d', '--name', check, '--network', 'none', '-v', `${oldVolume}:/var/lib/postgresql/data`, PG_IMAGE]));
    waitReady(check);
    expect(asAdmin(check, `${CHECKSUM_SQL};`)).toBe(sumsBefore);
  }, 240_000);
});

describe.skipIf(process.platform === 'win32' || !dockerRuns)('NM31 part 4: the Off order of Put back against a real Postgres 16 (Linux with docker)', () => {
  it('PG3 (P7): the Off order Put back runs under its lock leaves the database put back running with the bot login blocked', async () => {
    const c = await provisionedCluster({ name: `${ID}-pg3`, user: U, db: DB, password: PW });
    clusters.push(c);
    expect(ok(c.psql('dbm_admin', `SELECT rolcanlogin FROM pg_roles WHERE rolname = '${U}'`, 'postgres')).trim()).toBe('t');
    seedBot({
      sourceUrl: 'https://github.com/x/fully-modular-discord-bot', sanitizedName: 'pg3',
      fleetDb: { containerName: c.name, user: U, db: DB, volume: `${c.name}-data`, password: PW },
      maintenance: { state: 'off', message: 'Putting the kept data back', orderedAt: '2026-11-17T12:00:00.000Z', settled: true, hook: 'none', login: 'blocked', savedByBot: null },
    }, 'pg3');
    envManager.setEnvVars('pg3', { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: `postgresql://${U}:${PW}@${c.name}:5432/${DB}` });
    forgetManagerRole(c.name);
    const r = await containerManager.withExternalBotOp('pg3', 'put-back', () => runOrderInOp('pg3', 'off', 'Putting the kept data back', 'put-back'));
    expect(r).toMatchObject({ settled: true });
    expect(ok(docker(['inspect', '-f', '{{.State.Running}}', c.name])).trim()).toBe('true');
    expect(ok(c.psql('dbm_admin', `SELECT rolcanlogin FROM pg_roles WHERE rolname = '${U}'`, 'postgres')).trim()).toBe('f');
    expect(containerManager.getBot('pg3')!.maintenance).toMatchObject({ state: 'off', settled: true, login: 'blocked' });
  }, 240_000);
});

const KEPT_SET = '2026-11-17T12-00-00-000Z';

/** A cluster's volume as N8 leaves a kept one: the cluster stopped as N1 stops it and its container gone, the volume kept. */
async function keptVolumeOf(c: Cluster): Promise<string> {
  expect(await containerManager.stopContainerExact(c.name, 60)).toEqual({ ok: true });
  ok(docker(['rm', c.name]));
  return `${c.name}-data`;
}

/** Every path of a volume, and the sha256 of every file's content, read through a read-only mount. */
function volumeFiles(volume: string): string {
  return ok(docker(['run', '--rm', '--network', 'none', '-v', `${volume}:/v:ro`, '--entrypoint', 'sh', PG_IMAGE, '-c',
    'cd /v && find . | sort && find . -type f -exec sha256sum {} + | sort -k 2']));
}

/** Delete driven through its real steps on real docker, stopped at the save of 'removing', so nothing is removed. */
async function deleteUpToRemoving(botId: string): Promise<{ answer: unknown; rec: any }> {
  const realSave = containerManager.saveKeptOpIf;
  const spy = vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation((id, key, patch) => {
    if (patch.step === 'removing') throw new Error('stopped here by the row');
    return realSave(id, key, patch);
  });
  try {
    const answer = await deleteKept(botId, KEPT_SET);
    return { answer, rec: containerManager.getBot(botId)!.keptOp };
  } finally {
    spy.mockRestore();
  }
}

function removeScratchOf(botId: string): void {
  const n = keptScratchNames(botId);
  for (const name of [n.helper, n.scratch, n.check]) docker(['rm', '-f', name]);
  for (const name of [n.scratch, n.check]) docker(['volume', 'rm', '-f', name]);
}

const keptSetOf = (store: Record<string, unknown>) => [{ id: KEPT_SET, keptAt: '2026-11-17T12:00:00.000Z', by: 'new-start', folder: null, ...store }];

describe.skipIf(process.platform === 'win32' || !dockerRuns)('NM31 part 5: the scratch copy and dump of Delete against a real Postgres 16 (Linux with docker)', () => {
  it('PG4 (X1 to X4, Invariant K): the scratch copy of a kept volume dumps and checks; the kept volume reads the same after; a dump cut short fails the check', async () => {
    const botId = `${ID}x4`;
    const c = await provisionedCluster({ name: `${ID}-pg4`, user: U, db: DB, password: PW });
    clusters.push({ ...c, remove: () => { c.remove(); removeScratchOf(botId); } });
    ok(c.psql(U, 'CREATE TABLE kept_rows (id int PRIMARY KEY, body text); INSERT INTO kept_rows SELECT g, md5(g::text) FROM generate_series(1, 500) g;'));
    const volume = await keptVolumeOf(c);
    const control = controlData(volume);
    expect(control['Database cluster state']).toBe('shut down');
    const files = volumeFiles(volume);
    seedBot({ sourceUrl: 'https://github.com/x/fully-modular-discord-bot', sanitizedName: botId, keptSets: keptSetOf({ db: { containerName: c.name, user: U, db: DB, volume, password: PW } }) }, botId);

    const { answer, rec } = await deleteUpToRemoving(botId);
    expect(answer).toMatchObject({ success: false, open: true });
    expect(rec).toMatchObject({ op: 'delete', step: 'checked' });
    const dumpPath = path.join(backupDir(botId), rec.dump);
    const meta = JSON.parse(fs.readFileSync(`${dumpPath}.json`, 'utf-8'));
    expect(meta.counts['public.kept_rows']).toBe(500);
    const after = controlData(volume);
    expect(after['Database cluster state']).toBe('shut down');
    expect(after['Database system identifier']).toBe(control['Database system identifier']);
    expect(after['Latest checkpoint location']).toBe(control['Latest checkpoint location']);
    expect(volumeFiles(volume)).toBe(files);
    const n = keptScratchNames(botId);
    expect(docker(['volume', 'inspect', n.scratch]).status).not.toBe(0);
    expect(docker(['inspect', n.check]).status).not.toBe(0);

    const cut = `${dumpPath}.cut`;
    const whole = fs.readFileSync(dumpPath);
    fs.writeFileSync(cut, whole.subarray(0, Math.floor(whole.length / 2)));
    const verdict = await checkDumpInThrowaway(n.check, botId, cut, meta.dbBytes, meta.counts);
    docker(['rm', '-f', n.check]);
    docker(['volume', 'rm', '-f', n.check]);
    expect(verdict.passed).toBe(false);
    expect(docker(['volume', 'inspect', volume]).status).toBe(0);
    expect(volumeFiles(volume)).toBe(files);
  }, 600_000);

  it('PG5 (the dump half, X2): the kept volume of an old cluster without dbm_work answers T-X-DUMP with T-X-NOWORK, missingLogin reads dbm_work, and nothing is removed', async () => {
    const botId = `${ID}x5`;
    const c = oldCluster(`${ID}-pg5d`);
    clusters.push({ ...c, remove: () => { c.remove(); removeScratchOf(botId); } });
    const volume = await keptVolumeOf(c);
    const files = volumeFiles(volume);
    seedBot({ sourceUrl: 'https://github.com/x/fully-modular-discord-bot', sanitizedName: botId, keptSets: keptSetOf({ db: { containerName: c.name, user: U, db: DB, volume, password: PW } }) }, botId);
    const answer = await deleteKept(botId, KEPT_SET) as { success: boolean; error: string };
    expect(answer).toMatchObject({ success: false, open: true });
    expect(answer.error.startsWith('The dump of the kept database failed (')).toBe(true);
    expect(answer.error.endsWith(KEPT_TEXT.xNoWork)).toBe(true);
    expect(missingLogin(answer.error)).toBe('dbm_work');
    expect(containerManager.getBot(botId)!.keptOp).toMatchObject({ op: 'delete', step: 'copy-made' });
    expect(containerManager.getBot(botId)!.keptSets).toHaveLength(1);
    expect(docker(['volume', 'inspect', volume]).status).toBe(0);
    expect(volumeFiles(volume)).toBe(files);
    expect(docker(['volume', 'inspect', keptScratchNames(botId).scratch]).status).not.toBe(0);
  }, 600_000);

  it('PG6 (copy): the scratch copy of a pg_basebackup copy volume, with no network, answers the dump\'s snapshot and counts', async () => {
    const botId = `${ID}x6`;
    const net = `${ID}-net6`;
    docker(['network', 'create', net]);
    const main = await provisionedCluster({ name: `${ID}-pg6main`, user: U, db: DB, password: PW, network: net });
    const copyName = `${ID}-pg6copy`;
    const copyVolume = `${copyName}-data`;
    clusters.push(main, {
      name: copyName, user: U, db: DB, password: PW, psql: () => ({ status: 1, out: '', err: '' }),
      remove: () => { docker(['rm', '-f', copyName]); docker(['volume', 'rm', '-f', copyVolume]); removeScratchOf(botId); docker(['network', 'rm', net]); },
    });
    ok(main.psql(U, 'CREATE TABLE kept_rows (id int PRIMARY KEY, body text); INSERT INTO kept_rows SELECT g, md5(g::text) FROM generate_series(1, 300) g;'));
    ok(docker(['exec', main.name, 'sh', '-c', 'echo "host replication dbm_admin samenet trust" >> "$PGDATA/pg_hba.conf"']));
    ok(main.psql('dbm_admin', 'SELECT pg_reload_conf()', 'postgres'));
    ok(docker(['run', '--rm', '--network', net, '-v', `${copyVolume}:/var/lib/postgresql/data`, '--entrypoint', 'pg_basebackup', PG_IMAGE,
      '-h', main.name, '-U', 'dbm_admin', '-D', '/var/lib/postgresql/data', '-X', 'stream', '-R', '--checkpoint=fast'], undefined, 300000));
    ok(docker(['run', '-d', '--name', copyName, '--network', net, '-v', `${copyVolume}:/var/lib/postgresql/data`, PG_IMAGE, 'postgres', '-c', 'reserved_connections=4']));
    waitReady(copyName);
    expect(await containerManager.stopContainerExact(copyName, 60)).toEqual({ ok: true });
    ok(docker(['rm', copyName]));
    const files = volumeFiles(copyVolume);
    seedBot({
      sourceUrl: 'https://github.com/x/fully-modular-discord-bot', sanitizedName: botId,
      keptSets: keptSetOf({ copy: { containerName: copyName, volume: copyVolume, user: U, db: DB, slot: 's6', primaryHost: main.name, primaryPort: 5432, certHost: copyName } }),
    }, botId);
    const { answer, rec } = await deleteUpToRemoving(botId);
    expect(answer).toMatchObject({ success: false, open: true });
    expect(rec).toMatchObject({ op: 'delete', step: 'checked' });
    expect(rec.dump.startsWith('copy-pre-delete-')).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(backupDir(botId), `${rec.dump}.json`), 'utf-8'));
    expect(meta).toMatchObject({ family: 'copy', inRecovery: true });
    expect(meta.counts['public.kept_rows']).toBe(300);
    expect(volumeFiles(copyVolume)).toBe(files);
  }, 600_000);
});
