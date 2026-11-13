import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm18-pg-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, urls: {} as Record<string, string> };
});

vi.mock('../../src/config/appCapabilities', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/config/appCapabilities')>();
  return { ...real, findAppCapabilities: () => ({ companionDb: { env: { url: 'DATABASE_URL' } } }) };
});
vi.mock('../../src/env/manager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/env/manager')>();
  return {
    ...real,
    getEnvVarsWithStatus: (id: string) => ({ vars: { DATABASE_URL: h.urls[id] ?? '' }, corrupt: false, undecryptable: [], encrypted: [] }),
    getEnvVars: (id: string) => ({ DATABASE_URL: h.urls[id] ?? '' }),
  };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return { ...real, runningInstanceContainers: async () => [] };
});

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { COUNTS_SQL, backupDir, compareCounts, metaTocGaps, parseCountLines } from '../../src/instance/backupFiles';
import * as dbLogin from '../../src/instance/dbLogin';
import * as fleetBackup from '../../src/instance/fleetBackup';

const dockerRuns = process.platform !== 'win32' && (() => {
  try {
    return spawnSync('docker', ['version'], { stdio: 'ignore', timeout: 10000 }).status === 0;
  } catch {
    return false;
  }
})();

// The one container this file starts, removed by exact name.
const NAME = `nm18-pg-${process.pid}`;
const USER = 'app';
const ADMIN = dbLogin.MANAGER_DB_ROLE;
const MOVED = 'moved-2026-11-12T10-00-00-000Z.dump';

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const run = (args: string[], input?: string) => {
  const r = spawnSync('docker', args, { encoding: 'utf-8', timeout: 300000, input });
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
const psql = (sql: string, db = 'postgres', user = ADMIN) => run(['exec', NAME, 'psql', '-X', '-U', user, '-d', db, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
const ok = (sql: string, db = 'postgres') => {
  const r = psql(sql, db);
  expect(r.status, r.err).toBe(0);
  return r.out;
};
const waitTcp = () => {
  for (let i = 0; i < 180; i++) {
    if (run(['exec', NAME, 'pg_isready', '-h', '127.0.0.1', '-q']).status === 0) return;
    pause(500);
  }
  throw new Error(`${NAME} did not become ready`);
};
const countsOf = (db: string) => {
  const parsed = parseCountLines(`${ok(COUNTS_SQL, db)}\n`);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.counts;
};
// The restore compares smdb_data before it writes its own smdb_manager rows (the generation row and its tables).
const dataOnly = (counts: Record<string, number>) => Object.fromEntries(Object.entries(counts).filter(([k]) => k.startsWith('smdb_data.')));
const fenceLines = () => run(['exec', NAME, 'grep', '-c', 'smdb-write-fence', '/var/lib/postgresql/data/pg_hba.conf']).out;

const SCHEMA = `CREATE SCHEMA smdb_data AUTHORIZATION ${USER};
CREATE TABLE smdb_data.meta (key text PRIMARY KEY, value text);
CREATE TABLE smdb_data.guild_ownership (guild_id text PRIMARY KEY, node_id text NOT NULL, shard_id integer NOT NULL, claim bigint NOT NULL, shard_count integer NOT NULL, retired_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
CREATE SEQUENCE smdb_data.claim_seq;
CREATE TABLE smdb_data.docs (part text NOT NULL, body text) PARTITION BY LIST (part);
CREATE TABLE smdb_data.docs_a PARTITION OF smdb_data.docs FOR VALUES IN ('a');
CREATE TABLE smdb_data.docs_b PARTITION OF smdb_data.docs FOR VALUES IN ('b');
CREATE TABLE smdb_data."we""ird.x a" (x int);
CREATE TABLE smdb_data.empty_t (x int);
CREATE UNLOGGED TABLE smdb_data.scratch (x int);
ALTER TABLE smdb_data.meta OWNER TO ${USER};
ALTER TABLE smdb_data.guild_ownership OWNER TO ${USER};
ALTER SEQUENCE smdb_data.claim_seq OWNER TO ${USER};
ALTER TABLE smdb_data.docs OWNER TO ${USER};
ALTER TABLE smdb_data.docs_a OWNER TO ${USER};
ALTER TABLE smdb_data.docs_b OWNER TO ${USER};
ALTER TABLE smdb_data."we""ird.x a" OWNER TO ${USER};
ALTER TABLE smdb_data.empty_t OWNER TO ${USER};
ALTER TABLE smdb_data.scratch OWNER TO ${USER};
SELECT setval('smdb_data.claim_seq', 5);
INSERT INTO smdb_data.guild_ownership (guild_id, node_id, shard_id, claim, shard_count) VALUES ('g3', 'n1', 0, 3, 1), ('g5', 'n1', 0, 5, 1);
INSERT INTO smdb_data.meta VALUES ('k1', 'v1'), ('k2', 'v2');
INSERT INTO smdb_data.docs VALUES ('a', 'x'), ('b', 'y'), ('b', 'z');
INSERT INTO smdb_data."we""ird.x a" VALUES (1), (2);
INSERT INTO smdb_data.scratch VALUES (1), (2), (3);`;

const OFF = { state: 'off', message: '', orderedAt: '2026-10-28T00:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: 'maintenance' };
const bot = (id: string, db: string) => ({
  id, displayName: `NM18 ${id}`, sanitizedName: id, sourceUrl: 'https://example.invalid/fake/app', status: 'stopped', createdAt: '2026-10-28T00:00:00.000Z',
  fleetDb: { containerName: NAME, user: USER, db, volume: `${NAME}-data`, password: 'pw', image: 'postgres:16-alpine' }, fleetBackup: { enabled: false, hour: 4, keep: 7 }, maintenance: OFF,
});
/** A database on the schema, its bot record and a dump the backup takes; answers the bot id and the dump's name. */
const arrange = async (db: string): Promise<{ id: string; file: string }> => {
  const id = `${db}${process.pid}`;
  ok(`CREATE DATABASE ${db} OWNER ${USER}`);
  ok(SCHEMA, db);
  h.urls[id] = `postgres://${USER}:pw@${NAME}:5432/${db}`;
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances: { [id]: bot(id, db) } }));
  const dump = await fleetBackup.runFleetDump(bot(id, db) as any, 'nm18-');
  expect(dump.success, dump.error).toBe(true);
  return { id, file: dump.file! };
};
const metaOf = (id: string, file: string) => JSON.parse(fs.readFileSync(path.join(backupDir(id), `${file}.json`), 'utf-8'));

describe.skipIf(!dockerRuns)('NM18 the whole-bot restore compares counts against a real Postgres 16 (Linux with docker)', () => {
  beforeAll(async () => {
    const started = run(['run', '-d', '--name', NAME, '-e', `POSTGRES_USER=${USER}`, '-e', 'POSTGRES_PASSWORD=pw', '-e', `POSTGRES_DB=${USER}`, 'postgres:16-alpine']);
    expect(started.status, started.err).toBe(0);
    waitTcp();
    expect(await dbLogin.ensureManagerDbRole({ container: NAME, user: USER })).toEqual({ ok: true });
    ok(`ALTER ROLE ${USER} NOLOGIN`);
  }, 300000);

  afterAll(() => {
    run(['rm', '-f', '-v', NAME]);
    fs.rmSync(h.dir, { recursive: true, force: true });
  }, 120000);

  it('PG1 a dump\'s counts file fits its table of contents', async () => {
    const { id, file } = await arrange('nm18pg1');
    const meta = metaOf(id, file);
    const toc = await fleetBackup.readDumpToc(NAME, path.join(backupDir(id), file));
    expect(toc.ok).toBe(true);
    if (!toc.ok) return;
    expect(metaTocGaps(meta.counts, toc.toc)).toEqual([]);
    expect(meta.counts['smdb_data."we""ird.x a"']).toBe(2);
    expect(meta.counts['smdb_data.empty_t']).toBe(0);
    expect(meta.counts['smdb_data.docs_a']).toBe(1);
    expect(meta.counts['smdb_data.docs_b']).toBe(2);
    expect(Object.keys(meta.counts)).not.toContain('smdb_data.scratch');
    expect(toc.toc).toMatch(/^\d+; \d+ \d+ TABLE DATA smdb_data scratch /m);
  }, 300000);

  it('PG2 a restore of a dump with its counts file matches and clears the notice', async () => {
    const { id, file } = await arrange('nm18pg2');
    const meta = metaOf(id, file);
    const r = await fleetBackup.restoreFleetBackup(id, file);
    expect(r.success, r.error).toBe(true);
    expect(r.steps.counts).toEqual({ result: 'matched', tables: meta.tables, rows: meta.rows, text: null });
    expect(fleetBackup.getFleetRestoreError(id)).toBeNull();
    expect(ok('SHOW default_transaction_read_only')).toBe('off');
    expect(compareCounts(dataOnly(meta.counts), dataOnly(countsOf('nm18pg2')))).toEqual({ ok: true, text: '' });
  }, 300000);

  it('PG3 an archive that does not match its counts file is restored with a notice, and the pre-restore dump undoes it', async () => {
    const { id, file: d1 } = await arrange('nm18pg3');
    const n = metaOf(id, d1).counts['smdb_data.meta'];
    ok("INSERT INTO smdb_data.meta SELECT 'n' || i, 'v' FROM generate_series(1, 5) i", 'nm18pg3');
    const d2 = await fleetBackup.runFleetDump(bot(id, 'nm18pg3') as any, 'nm18b-');
    expect(d2.success, d2.error).toBe(true);
    fs.copyFileSync(path.join(backupDir(id), d2.file!), path.join(backupDir(id), d1));
    const live = countsOf('nm18pg3');
    const r = await fleetBackup.restoreFleetBackup(id, d1);
    expect(r.success).toBe(false);
    expect(r.error).toContain(`smdb_data.meta: ${n} recorded, ${n + 5} restored`);
    expect(r.error).toMatch(/^The dump .* was restored, but 1 table\(s\) differ/);
    expect(r.steps.counts?.result).toBe('differ');
    expect(r.steps.claimRaisedTo).not.toBeNull();
    expect(ok('SHOW default_transaction_read_only')).toBe('off');
    expect(fenceLines()).toBe('0');
    expect(ok(`SELECT rolcanlogin FROM pg_roles WHERE rolname = '${USER}'`)).toBe('f');
    const registry = JSON.parse(fs.readFileSync(path.join(h.dir, 'instances.json'), 'utf-8')).instances[id];
    expect(registry.fleetRestoreError.text).toMatch(new RegExp(`^Restore of ${d1.replace(/\./g, '\\.')} ran, but 1 table\\(s\\) differ`));
    expect(registry.fleetRestoreError.doubt).toBe(true);
    const pre = r.steps.preRestoreDump!;
    const undo = await fleetBackup.restoreFleetBackup(id, pre);
    expect(undo.success, undo.error).toBe(true);
    expect(undo.steps.counts?.result).toBe('matched');
    expect(fleetBackup.getFleetRestoreError(id)).toBeNull();
    expect(compareCounts(dataOnly(live), dataOnly(countsOf('nm18pg3')))).toEqual({ ok: true, text: '' });
  }, 600000);

  it('PG4 an archive without the data its counts file records is refused before anything changes', async () => {
    const { id, file: d1 } = await arrange('nm18pg4');
    const n = metaOf(id, d1).counts['smdb_data.meta'];
    expect(run(['exec', NAME, 'pg_dump', '-U', ADMIN, '-Fc', '--exclude-table-data=smdb_data.meta', '-f', '/tmp/nm18pg4.dump', 'nm18pg4']).status).toBe(0);
    expect(run(['cp', `${NAME}:/tmp/nm18pg4.dump`, path.join(backupDir(id), d1)]).status).toBe(0);
    const before = countsOf('nm18pg4');
    const r = await fleetBackup.restoreFleetBackup(id, d1);
    expect(r.success).toBe(false);
    expect(r.error).toBe(`The counts file of the dump ${d1} records tables the dump does not hold, so the restore was refused, and nothing was changed: 1 table(s) do not fit its table of contents: smdb_data.meta: ${n} row(s) recorded, no data in the dump`);
    expect(fs.readdirSync(backupDir(id)).filter(f => f.startsWith('pre-restore-'))).toEqual([]);
    expect(compareCounts(before, countsOf('nm18pg4')).ok).toBe(true);
    expect(fenceLines()).toBe('0');
  }, 300000);

  it('PG5 an uploaded backup without a counts file is restored and its totals shown', async () => {
    const { id, file } = await arrange('nm18pg5');
    const meta = metaOf(id, file);
    fs.copyFileSync(path.join(backupDir(id), file), path.join(backupDir(id), MOVED));
    const r = await fleetBackup.restoreFleetBackup(id, MOVED);
    expect(r.success, r.error).toBe(true);
    expect(r.steps.counts).toEqual({ result: 'unrecorded', tables: meta.tables, rows: meta.rows, text: null });
  }, 300000);
});
