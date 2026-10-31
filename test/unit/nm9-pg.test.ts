import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// NM9's raise, cap and refusals against a real Postgres 16. Skipped on Windows and without docker; the main session
// runs it with linux_pg.sh.
const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm9-pg-'));
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
  return { ...real, runningInstanceContainers: async () => [], appContainerRunning: async () => false };
});

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { COUNTS_SQL, backupDir, compareCounts, parseCountLines } from '../../src/instance/backupFiles';
import * as dbLogin from '../../src/instance/dbLogin';
import * as fleetBackup from '../../src/instance/fleetBackup';
import { addressTableSql } from '../../src/instance/fleetReplication';
import * as fleetSwitch from '../../src/instance/fleetSwitch';
import * as switchSql from '../../src/instance/switchSql';

const fb = fleetBackup as any;
const CAP: string = (switchSql as any).SHARD_CAP_DO_SQL;

const dockerRuns = (() => {
  try {
    return spawnSync('docker', ['version'], { stdio: 'ignore', timeout: 10000 }).status === 0;
  } catch {
    return false;
  }
})();

// The one container this file starts, removed by exact name with its volume.
const NAME = `nm9-pg-${process.pid}`;
const USER = 'app';
const ADMIN = dbLogin.MANAGER_DB_ROLE;

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const run = (args: string[], input?: string) => {
  const r = spawnSync('docker', args, { encoding: 'utf-8', timeout: 300000, input });
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
const psql = (sql: string, db = 'postgres', user = ADMIN, flags = '-tA') => run(['exec', NAME, 'psql', '-X', '-U', user, '-d', db, flags, '-v', 'ON_ERROR_STOP=1', '-c', sql]);
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

const V2 = `CREATE SCHEMA smdb_data AUTHORIZATION ${USER};
CREATE TABLE smdb_data.meta (key text PRIMARY KEY, value text);
CREATE TABLE smdb_data.guild_ownership (guild_id text PRIMARY KEY, node_id text NOT NULL, shard_id integer NOT NULL, claim bigint NOT NULL, shard_count integer NOT NULL, retired_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
CREATE SEQUENCE smdb_data.claim_seq;
ALTER TABLE smdb_data.meta OWNER TO ${USER};
ALTER TABLE smdb_data.guild_ownership OWNER TO ${USER};
ALTER SEQUENCE smdb_data.claim_seq OWNER TO ${USER};`;
const V3 = (up: number) => `${V2}
CREATE TABLE smdb_data.shard_claims (
  shard_count integer NOT NULL, shard_id integer NOT NULL, claim bigint NOT NULL, holder_process text NOT NULL, holder_node text NOT NULL,
  holder_name text NOT NULL, home_node text NOT NULL, released boolean NOT NULL DEFAULT false, reserved boolean NOT NULL DEFAULT false,
  taken_at timestamptz NOT NULL DEFAULT now(), renewed_at timestamptz NOT NULL DEFAULT now(), ttl_ms bigint NOT NULL, expires_up_ms bigint NOT NULL,
  extended boolean NOT NULL DEFAULT false, PRIMARY KEY (shard_count, shard_id));
CREATE TABLE smdb_data.claim_clock (id integer PRIMARY KEY CHECK (id = 1), up_ms bigint NOT NULL, ticked_at timestamptz NOT NULL, last_gap_ms bigint NOT NULL DEFAULT 0);
CREATE TABLE smdb_data.shard_nodes (
  node_id text PRIMARY KEY, node_name text NOT NULL, process_id text NOT NULL, capacity integer NOT NULL, takeover_seconds integer NOT NULL, fit boolean NOT NULL,
  restartable boolean NOT NULL, returns boolean NOT NULL, started_at timestamptz NOT NULL, healthy_since timestamptz, seen_at timestamptz NOT NULL);
ALTER TABLE smdb_data.shard_claims OWNER TO ${USER};
ALTER TABLE smdb_data.claim_clock OWNER TO ${USER};
ALTER TABLE smdb_data.shard_nodes OWNER TO ${USER};
INSERT INTO smdb_data.claim_clock (id, up_ms, ticked_at) VALUES (1, ${up}, now());
INSERT INTO smdb_data.meta (key, value) VALUES ('schema_version', '{"v":3}'), ('shard_count', '{"count":4}');
INSERT INTO smdb_data.shard_nodes VALUES ('n1', 'node one', 'p1', 4, 30, true, true, true, now(), now(), now());`;
const row = (guild: string, claim: number) => `INSERT INTO smdb_data.guild_ownership (guild_id, node_id, shard_id, claim, shard_count) VALUES ('${guild}', 'n1', 0, ${claim}, 1);`;
const shard = (count: number, id: number, claim: number, expires: number, flags = 'false, false, false') =>
  `INSERT INTO smdb_data.shard_claims (shard_count, shard_id, claim, holder_process, holder_node, holder_name, home_node, released, reserved, extended, ttl_ms, expires_up_ms) VALUES (${count}, ${id}, ${claim}, 'p1', 'n1', 'node one', 'n1', ${flags}, 30000, ${expires});`;
const makeDb = (db: string, schema: string, extra = '') => {
  ok(`CREATE DATABASE ${db} OWNER ${USER}`);
  ok(`${schema}\n${extra}`, db);
};
const target = (db: string) => ({ containerName: NAME, user: USER, db, volume: `${NAME}-data` });
const OFF = { state: 'off', message: '', orderedAt: '2026-10-28T00:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: 'maintenance' };
const bot = (id: string, db: string) => ({
  id, displayName: `NM9 ${id}`, sanitizedName: id, sourceUrl: 'https://example.invalid/fake/app', status: 'stopped', createdAt: '2026-10-28T00:00:00.000Z',
  fleetDb: { ...target(db), password: 'pw', image: 'postgres:16-alpine' }, fleetBackup: { enabled: false, hour: 4, keep: 7 }, maintenance: OFF,
});
const register = (id: string, db: string) => {
  h.urls[id] = `postgres://${USER}:pw@${NAME}:5432/${db}`;
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances: { [id]: bot(id, db) } }));
  fs.mkdirSync(backupDir(id), { recursive: true });
};
const dumpTo = (db: string, file: string) => {
  expect(run(['exec', NAME, 'pg_dump', '-U', ADMIN, '-Fc', '-f', `/tmp/${db}.dump`, db]).status).toBe(0);
  expect(run(['cp', `${NAME}:/tmp/${db}.dump`, file]).status).toBe(0);
};
const ALL = { seq: true, table: true, claim: true, shards: true, clock: true };
const SHARDS = 'SELECT shard_count || \':\' || shard_id || \'=\' || claim || \'@\' || expires_up_ms FROM smdb_data.shard_claims ORDER BY shard_count, shard_id';
const OTHER_COLUMNS = 'SELECT shard_count, shard_id, holder_process, holder_node, holder_name, home_node, released, reserved, taken_at, renewed_at, ttl_ms, extended FROM smdb_data.shard_claims ORDER BY 1, 2';
const KEPT = (db: string) => [ok(OTHER_COLUMNS, db), ok('SELECT * FROM smdb_data.claim_clock', db), ok('SELECT * FROM smdb_data.shard_nodes', db), ok('SELECT * FROM smdb_data.meta ORDER BY key', db)];

describe.skipIf(process.platform === 'win32' || !dockerRuns)('NM9 the shard claims against a real Postgres 16 (Linux with docker)', () => {
  beforeAll(async () => {
    const started = run(['run', '-d', '--name', NAME, '-v', `${NAME}-data:/var/lib/postgresql/data`, '-e', `POSTGRES_USER=${USER}`, '-e', 'POSTGRES_PASSWORD=pw', '-e', `POSTGRES_DB=${USER}`, 'postgres:16-alpine']);
    expect(started.status, started.err).toBe(0);
    waitTcp();
    expect(await dbLogin.ensureManagerDbRole({ container: NAME, user: USER })).toEqual({ ok: true });
    ok(`ALTER ROLE ${USER} NOLOGIN`);
    ok(switchSql.replicationRoleEnsureSql('replicator'));
  }, 300000);

  afterAll(() => {
    run(['rm', '-f', '-v', NAME]);
    run(['volume', 'rm', '-f', `${NAME}-data`]);
    fs.rmSync(h.dir, { recursive: true, force: true });
  }, 120000);

  it('PG1 probeClaims reads the shard claims on v3, and v2 still answers claims', async () => {
    makeDb('pg1', V3(1000), `SELECT setval('smdb_data.claim_seq', 12); ${row('g3', 3)} ${row('g15', 15)} ${shard(4, 0, 18, 100)} ${shard(4, 1, 4, 100)}`);
    expect(await fb.probeClaims(target('pg1'))).toEqual({ ok: true, shape: 'shards', claim: 18 });
    ok("SELECT setval('smdb_data.claim_seq', 30)", 'pg1');
    expect(await fb.probeClaims(target('pg1'))).toEqual({ ok: true, shape: 'shards', claim: 30 });
    makeDb('pg1e', V3(1000), `SELECT setval('smdb_data.claim_seq', 12); ${row('g15', 15)}`);
    expect(await fb.probeClaims(target('pg1e'))).toEqual({ ok: true, shape: 'shards', claim: 15 });
    makeDb('pg1v2', V2, row('g3', 3));
    expect(await fb.probeClaims(target('pg1v2'))).toEqual({ ok: true, shape: 'claims', claim: 3 });
  }, 120000);

  it('PG2 raiseClaims under the read-only setting: renumbers at or below F by count then id, caps every row, keeps every other column', async () => {
    makeDb('pg2', V3(1000), `SELECT setval('smdb_data.claim_seq', 4); ${row('g3', 3)} ${row('g9', 9)} ${row('g11', 11)} ${shard(2, 1, 9, 5000, 'true, true, true')} ${shard(2, 0, 2, 100)} ${shard(4, 2, 12, 9000)}`);
    const before = KEPT('pg2');
    ok('ALTER SYSTEM SET default_transaction_read_only = on');
    ok('SELECT pg_reload_conf()');
    try {
      const plain = psql(fb.claimRaiseSql(9, ALL), 'pg2');
      expect(plain.status).not.toBe(0);
      expect(plain.err).toMatch(/cannot execute/);
      const raised = await fb.raiseClaims(target('pg2'), 9);
      expect(raised).toMatchObject({ ok: true, seq: 12, shards: { raised: 2, expired: 3, clock: 1000 } });
      expect([...raised.guilds].sort()).toEqual(['g3', 'g9']);
    } finally {
      ok('ALTER SYSTEM RESET default_transaction_read_only');
      ok('SELECT pg_reload_conf()');
    }
    expect(ok(SHARDS, 'pg2').split('\n')).toEqual(['2:0=10@100', '2:1=11@1000', '4:2=12@1000']);
    expect(ok("SELECT guild_id || '=' || claim FROM smdb_data.guild_ownership ORDER BY guild_id", 'pg2').split('\n')).toEqual(['g11=11', 'g3=10', 'g9=10']);
    expect(ok('SELECT last_value FROM smdb_data.claim_seq', 'pg2')).toBe('12');
    expect(KEPT('pg2')).toEqual(before);
    const again = await fb.raiseClaims(target('pg2'), 9);
    expect(again).toMatchObject({ ok: true, shards: { raised: 0, expired: 3, clock: 1000 } });
    expect(ok('SELECT last_value FROM smdb_data.claim_seq', 'pg2')).toBe('12');
  }, 120000);

  it('PG3 the clock row deleted: the raise and the cap answer E2 and change nothing', async () => {
    makeDb('pg3', V3(1000), `SELECT setval('smdb_data.claim_seq', 4); ${row('g3', 3)} ${shard(2, 0, 2, 5000)} DELETE FROM smdb_data.claim_clock;`);
    const rows = () => [ok(SHARDS, 'pg3'), ok("SELECT guild_id || '=' || claim FROM smdb_data.guild_ownership", 'pg3'), ok('SELECT last_value FROM smdb_data.claim_seq', 'pg3')];
    const before = rows();
    expect(await fb.raiseClaims(target('pg3'), 9)).toEqual({ ok: false, error: 'the restored smdb_data.claim_clock has no row, so no claim number was raised' });
    expect(await fb.capClaims(target('pg3'))).toEqual({ ok: false, error: 'the restored smdb_data.claim_clock has no row, so no shard claim was expired' });
    expect(rows()).toEqual(before);
  }, 120000);

  it('PG4 pg_restore -l of a v3 and a v2 dump (the texts are printed for the fixtures)', async () => {
    makeDb('pg4v3', V3(1000), shard(2, 0, 2, 5000));
    makeDb('pg4v2', V2, row('g1', 1));
    const seen: Record<string, unknown> = {};
    for (const db of ['pg4v3', 'pg4v2']) {
      const file = path.join(h.dir, `${db}.dump`);
      dumpTo(db, file);
      const toc = await fb.readDumpToc(NAME, file);
      expect(toc.ok, toc.error).toBe(true);
      console.log(`[NM9 PG4] pg_restore -l of ${db}:\n${toc.toc}`);
      seen[db] = { ...fb.dumpShardTables(toc.toc), shape: fb.dumpClaimShape(toc.toc) };
    }
    expect(seen).toEqual({ pg4v3: { shards: true, clock: true, shape: 'claims' }, pg4v2: { shards: false, clock: false, shape: 'claims' } });
  }, 180000);

  it('PG5 a whole-bot restore of a v3 bot renumbers above the live floor and expires every restored claim', async () => {
    const id = `nm9pg5${process.pid}`;
    makeDb('pg5', V3(10000), `SELECT setval('smdb_data.claim_seq', 5); ${row('g3', 3)} ${row('g5', 5)} ${shard(1, 0, 3, 50000)} ${shard(1, 1, 5, 50000)}`);
    register(id, 'pg5');
    const dump = await fleetBackup.runFleetDump(bot(id, 'pg5') as any, 'nm9-');
    expect(dump.success, dump.error).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(backupDir(id), `${dump.file}.json`), 'utf-8'));
    const dumped = ok(OTHER_COLUMNS, 'pg5');
    ok(`SELECT setval('smdb_data.claim_seq', 20); UPDATE smdb_data.shard_claims SET claim = 20, holder_process = 'p2' WHERE shard_id = 0; UPDATE smdb_data.claim_clock SET up_ms = 70000;`, 'pg5');
    const r = await fleetBackup.restoreFleetBackup(id, dump.file!);
    expect(r.success, r.error).toBe(true);
    expect(r.steps).toMatchObject({ botState: 'off', claimFloor: 20, claimRaisedTo: 21, shardClaimsRaised: 2, shardClaimsExpired: 2 });
    expect(ok(SHARDS, 'pg5').split('\n')).toEqual(['1:0=21@10000', '1:1=22@10000']);
    expect(ok('SELECT DISTINCT claim FROM smdb_data.guild_ownership', 'pg5')).toBe('21');
    expect(ok('SELECT up_ms FROM smdb_data.claim_clock', 'pg5')).toBe('10000');
    expect(ok(OTHER_COLUMNS, 'pg5')).toBe(dumped);
    expect(ok('SELECT count(*) FROM smdb_data.shard_claims WHERE claim <= 20', 'pg5')).toBe('0');
    expect(ok('SELECT count(*) FROM smdb_data.shard_claims t, smdb_data.claim_clock k WHERE t.expires_up_ms > k.up_ms', 'pg5')).toBe('0');
    expect(ok("SELECT nextval('smdb_data.claim_seq')", 'pg5')).toBe('23');
    expect(JSON.parse(fs.readFileSync(path.join(backupDir(id), 'claim-floor.json'), 'utf-8'))).toEqual({ claim: 20 });
    expect(ok('SHOW default_transaction_read_only')).toBe('off');
    expect(run(['exec', NAME, 'grep', '-c', 'smdb-write-fence', '/var/lib/postgresql/data/pg_hba.conf']).out).toBe('0');
    const after = countsOf('pg5');
    const data = (counts: Record<string, number>) => Object.fromEntries(Object.entries(counts).filter(([name]) => name.startsWith('smdb_data.')));
    expect(compareCounts(data(meta.counts), data(after)).text).toBe('');
    expect(Object.keys(after).filter(name => !name.startsWith('smdb_data.'))).toEqual(['smdb_manager.copies', 'smdb_manager.generation', 'smdb_manager.handover', 'smdb_manager.received']);
    expect(after['smdb_manager.generation']).toBe(1);
  }, 300000);

  it('PG6 a live v3 database and a v2 dump: T11, nothing dropped or changed, the fence lifted', async () => {
    const id = `nm9pg6${process.pid}`;
    makeDb('pg6', V3(1000), `SELECT setval('smdb_data.claim_seq', 3); ${shard(1, 0, 3, 5000)}`);
    makeDb('pg6src', V2, row('g1', 2));
    register(id, 'pg6');
    dumpTo('pg6src', path.join(backupDir(id), 'v2.dump'));
    const oid = ok("SELECT oid FROM pg_database WHERE datname = 'pg6'");
    const before = countsOf('pg6');
    const shardBefore = ok(SHARDS, 'pg6');
    const r = await fleetBackup.restoreFleetBackup(id, 'v2.dump');
    expect(r.success).toBe(false);
    expect(r.error).toBe('The dump v2.dump has no shard claims, but the database has them, so the restore was refused, and nothing was changed: the database has smdb_data.shard_claims and the dump does not, and a bot that keeps its shard claims in the database does not start on data without them; a pre-restore dump is never refused for this, so a restore can be undone with the one it took');
    expect(ok("SELECT oid FROM pg_database WHERE datname = 'pg6'")).toBe(oid);
    expect(compareCounts(before, countsOf('pg6')).ok).toBe(true);
    expect(ok(SHARDS, 'pg6')).toBe(shardBefore);
    expect(ok('SHOW default_transaction_read_only')).toBe('off');
    expect(run(['exec', NAME, 'grep', '-c', 'smdb-write-fence', '/var/lib/postgresql/data/pg_hba.conf']).out).toBe('0');
  }, 300000);

  it('PG7 no floor: the restore caps every restored claim and raises nothing', async () => {
    const id = `nm9pg7${process.pid}`;
    ok(`CREATE DATABASE pg7 OWNER ${USER}`);
    makeDb('pg7src', V3(10000), `SELECT setval('smdb_data.claim_seq', 5); ${shard(1, 0, 3, 50000)} ${shard(1, 1, 5, 50000)}`);
    register(id, 'pg7');
    dumpTo('pg7src', path.join(backupDir(id), 'v3.dump'));
    const r = await fleetBackup.restoreFleetBackup(id, 'v3.dump');
    expect(r.success, r.error).toBe(true);
    expect(r.steps).toMatchObject({ claimFloor: null, shardClaimsRaised: null, shardClaimsExpired: 2 });
    expect(ok(SHARDS, 'pg7').split('\n')).toEqual(['1:0=3@10000', '1:1=5@10000']);
    expect(ok('SELECT last_value FROM smdb_data.claim_seq', 'pg7')).toBe('5');
    expect(fs.existsSync(path.join(backupDir(id), 'claim-floor.json'))).toBe(false);
  }, 300000);

  it('PG10 a v3 dump restored over a v2 database, then that restore\'s own pre-restore dump restored over the v3 copy', async () => {
    const id = `nm9pg10${process.pid}`;
    makeDb('pg10', V2, `SELECT setval('smdb_data.claim_seq', 4); ${row('g1', 4)}`);
    makeDb('pg10src', V3(10000), `SELECT setval('smdb_data.claim_seq', 6); ${row('g2', 6)} ${shard(1, 0, 6, 50000)}`);
    register(id, 'pg10');
    dumpTo('pg10src', path.join(backupDir(id), 'v3.dump'));
    const r1 = await fleetBackup.restoreFleetBackup(id, 'v3.dump');
    expect(r1.success, r1.error).toBe(true);
    const pre = r1.steps.preRestoreDump;
    expect(pre).toMatch(/^pre-restore-.+\.dump$/);
    const r2 = await fleetBackup.restoreFleetBackup(id, pre!);
    expect(r2.success, r2.error).toBe(true);
    expect(ok("SELECT coalesce(to_regclass('smdb_data.shard_claims')::text, 'null')", 'pg10')).toBe('null');
    expect(ok("SELECT guild_id || '=' || claim FROM smdb_data.guild_ownership ORDER BY guild_id", 'pg10')).toBe('g1=7');
    expect(ok('SELECT last_value FROM smdb_data.claim_seq', 'pg10')).toBe('7');
    expect(JSON.parse(fs.readFileSync(path.join(backupDir(id), 'claim-floor.json'), 'utf-8'))).toEqual({ claim: 6 });
    expect(ok('SHOW default_transaction_read_only')).toBe('off');
    expect(run(['exec', NAME, 'grep', '-c', 'smdb-write-fence', '/var/lib/postgresql/data/pg_hba.conf']).out).toBe('0');
    const toc = await fb.readDumpToc(NAME, path.join(backupDir(id), pre!));
    expect(toc.ok, toc.error).toBe(true);
    expect(fb.dumpShardTables(toc.toc)).toEqual({ shards: false, clock: false });
  }, 300000);

  it('PG11 under pushBroken the pre-receive- dump of a database with no claim numbers restores without a floor', async () => {
    const id = `nm9pg11${process.pid}`;
    ok(`CREATE DATABASE pg11 OWNER ${USER}`);
    register(id, 'pg11');
    const P11 = await fleetBackup.runFleetDump(bot(id, 'pg11') as any, 'pre-receive-');
    expect(P11.success, P11.error).toBe(true);
    const toc = await fb.readDumpToc(NAME, path.join(backupDir(id), P11.file!));
    expect(toc.ok, toc.error).toBe(true);
    expect(fb.dumpClaimShape(toc.toc)).toBe('none');
    ok(`${V3(10000)}\nSELECT setval('smdb_data.claim_seq', 20); ${row('g9', 20)} ${shard(1, 0, 20, 50000)}`, 'pg11');
    const broken = bot(id, 'pg11');
    fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances: { [id]: { ...broken, fleetDb: { ...broken.fleetDb, pushBroken: { at: '2026-10-30T09:00:00.000Z', safetyDump: P11.file } } } } }));
    const r = await fleetBackup.restoreFleetBackup(id, P11.file!);
    expect(r.success, r.error).toBe(true);
    expect(r.steps.claimFloor).toBeNull();
    expect(fs.existsSync(path.join(backupDir(id), 'claim-floor.json'))).toBe(false);
    expect(ok("SELECT count(*) FROM pg_namespace WHERE nspname = 'smdb_data'", 'pg11')).toBe('0');
    expect(JSON.parse(fs.readFileSync(path.join(h.dir, 'instances.json'), 'utf-8')).instances[id].fleetDb.pushBroken).toBeUndefined();
  }, 300000);

  it('PG11b as PG11 for a never-run receiver: its database holds the generation row and the address list', async () => {
    const id = `nm9pg11b${process.pid}`;
    ok(`CREATE DATABASE pg11b OWNER ${USER}`);
    register(id, 'pg11b');
    await fleetSwitch.ensureMainGeneration(id);
    expect(ok('SELECT generation FROM smdb_manager.generation', 'pg11b')).toBe('1');
    const enabled = run(['exec', '-i', NAME, 'psql', '-X', '-U', ADMIN, '-d', 'pg11b', '-v', 'ON_ERROR_STOP=1', '-At'], addressTableSql('recv.example', 5432, 'PEM', 'recv.example', null));
    expect(enabled.status, enabled.err).toBe(0);
    const P11 = await fleetBackup.runFleetDump(bot(id, 'pg11b') as any, 'pre-receive-');
    expect(P11.success, P11.error).toBe(true);
    const toc = await fb.readDumpToc(NAME, path.join(backupDir(id), P11.file!));
    expect(toc.ok, toc.error).toBe(true);
    expect(toc.toc).toMatch(/^\d+; \d+ \d+ TABLE smdb_manager addresses /m);
    expect(fb.dumpClaimShape(toc.toc)).toBe('none');
    expect(fb.dumpShardTables(toc.toc)).toEqual({ shards: false, clock: false });
    ok(`${V3(10000)}\nSELECT setval('smdb_data.claim_seq', 20); ${row('g9', 20)} ${shard(1, 0, 20, 50000)}`, 'pg11b');
    const broken = bot(id, 'pg11b');
    fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances: { [id]: { ...broken, fleetDb: { ...broken.fleetDb, pushBroken: { at: '2026-10-30T09:00:00.000Z', safetyDump: P11.file } } } } }));
    const r = await fleetBackup.restoreFleetBackup(id, P11.file!);
    expect(r.success, r.error).toBe(true);
    expect(r.steps.claimFloor).toBeNull();
    expect(fs.existsSync(path.join(backupDir(id), 'claim-floor.json'))).toBe(false);
    expect(ok("SELECT count(*) FROM pg_namespace WHERE nspname = 'smdb_data'", 'pg11b')).toBe('0');
    expect(Number(ok('SELECT generation FROM smdb_manager.generation', 'pg11b'))).toBeGreaterThan(1);
    expect(JSON.parse(fs.readFileSync(path.join(h.dir, 'instances.json'), 'utf-8')).instances[id].fleetDb.pushBroken).toBeUndefined();
  }, 300000);

  const P ='0123456789abcdef01234567';
  const received = (id: string, g: number, conflict = true) => `INSERT INTO smdb_manager.received (push_id, from_system_id, from_machine, generation) VALUES ('${id}', '1', 'main', ${g})${conflict ? ' ON CONFLICT (push_id) DO NOTHING' : ''};\n`;
  const commitOf = (g: number, after = '') => `SET ROLE ${ADMIN};\n${switchSql.raiseSql('recv', g, `${addressTableSql('recv.example', 5432, 'PEM', 'recv', null)}
DELETE FROM smdb_manager.addresses WHERE NOT (host = 'recv.example' AND port = 5432);
${received(P, g)}${CAP}${after}`)}`;
  const asReceive = (db: string, sql: string) => run(['exec', NAME, 'psql', '-X', '-U', 'smdb_receive', '-d', db, '-v', 'ON_ERROR_STOP=1', '-tAq', '-c', sql]);

  it('PG8 the push commit caps the receiver\'s rows with the generation raise, or rolls back with it', async () => {
    ok("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'smdb_receive') THEN CREATE ROLE smdb_receive LOGIN SUPERUSER; END IF; END $$;");
    makeDb('pg8', V3(10000), `${shard(1, 0, 3, 50000)} ${shard(1, 1, 5, 50000)}`);
    const holders = ok(OTHER_COLUMNS, 'pg8');
    const c = asReceive('pg8', commitOf(4));
    expect(c.status, c.err).toBe(0);
    expect(c.out).toMatch(/^4\|recv\|[^\n]+$/);
    expect(ok(SHARDS, 'pg8').split('\n')).toEqual(['1:0=3@10000', '1:1=5@10000']);
    expect(ok(OTHER_COLUMNS, 'pg8')).toBe(holders);
    expect(ok('SELECT generation FROM smdb_manager.generation', 'pg8')).toBe('4');
    expect(ok(`SELECT count(*) FROM smdb_manager.received WHERE push_id = '${P}'`, 'pg8')).toBe('1');
    expect(ok("SELECT count(*) FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname = 'smdb_receive'", 'pg8')).toBe('0');

    ok('UPDATE smdb_data.shard_claims SET expires_up_ms = 50000', 'pg8');
    const failed = asReceive('pg8', commitOf(5, received(P, 5, false)));
    expect(failed.status).not.toBe(0);
    expect(ok(SHARDS, 'pg8').split('\n')).toEqual(['1:0=3@50000', '1:1=5@50000']);
    expect(ok('SELECT generation FROM smdb_manager.generation', 'pg8')).toBe('4');
    expect(ok('SELECT count(*) FROM smdb_manager.received', 'pg8')).toBe('1');

    makeDb('pg8v2', V2, row('g1', 1));
    const v2 = asReceive('pg8v2', commitOf(4));
    expect(v2.status, v2.err).toBe(0);

    makeDb('pg8n', V3(10000), `${shard(1, 0, 3, 50000)} DELETE FROM smdb_data.claim_clock;`);
    const noRow = asReceive('pg8n', commitOf(4));
    expect(noRow.status, noRow.err).toBe(0);
    expect(ok(SHARDS, 'pg8n')).toBe('1:0=3@50000');
  }, 180000);

  const takeoverRaise = (g: number) => switchSql.raiseSql('copy', g, `
DO $$ BEGIN
IF to_regclass('smdb_manager.addresses') IS NOT NULL THEN
  EXECUTE format('DELETE FROM smdb_manager.addresses WHERE slot IS NULL AND host = %L AND port = 5432', 'main.example');
  DELETE FROM smdb_manager.addresses WHERE slot IS NOT NULL;
END IF;
END $$;
${CAP}`);

  it('PG9 the take-over raise over an unchecked mark caps the copy\'s rows', async () => {
    makeDb('pg9', V3(10000), `${shard(1, 0, 3, 50000)} ${shard(1, 1, 5, 50000)}`);
    const holders = ok(OTHER_COLUMNS, 'pg9');
    const clock = ok('SELECT * FROM smdb_data.claim_clock', 'pg9');
    const r = psql(takeoverRaise(5), 'pg9', ADMIN, '-tAq');
    expect(r.status, r.err).toBe(0);
    expect(ok(SHARDS, 'pg9').split('\n')).toEqual(['1:0=3@10000', '1:1=5@10000']);
    expect(ok(OTHER_COLUMNS, 'pg9')).toBe(holders);
    expect(ok('SELECT * FROM smdb_data.claim_clock', 'pg9')).toBe(clock);
    expect(ok('SELECT generation FROM smdb_manager.generation', 'pg9')).toBe('5');

    makeDb('pg9n', V3(10000), `${shard(1, 0, 3, 50000)} DELETE FROM smdb_data.claim_clock;`);
    expect(psql(takeoverRaise(5), 'pg9n', ADMIN, '-tAq').status).toBe(0);
    expect(ok(SHARDS, 'pg9n')).toBe('1:0=3@50000');

    makeDb('pg9v2', V2, row('g1', 1));
    const v2 = psql(takeoverRaise(5), 'pg9v2', ADMIN, '-tAq');
    expect(v2.status, v2.err).toBe(0);
  }, 180000);
});
