import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm4-pg-'));
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
import { COUNTS_SQL, backupDir, compareCounts, parseCountLines } from '../../src/instance/backupFiles';
import * as dbLogin from '../../src/instance/dbLogin';
import * as fleetBackup from '../../src/instance/fleetBackup';

const fb = fleetBackup as any;

const dockerRuns = (() => {
  try {
    return spawnSync('docker', ['version'], { stdio: 'ignore', timeout: 10000 }).status === 0;
  } catch {
    return false;
  }
})();

// The one container this file starts, removed by exact name.
const NAME = `nm4-pg-${process.pid}`;
const USER = 'app';
const ADMIN = dbLogin.MANAGER_DB_ROLE;

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

const V2 = `CREATE SCHEMA smdb_data AUTHORIZATION ${USER};
CREATE TABLE smdb_data.meta (key text PRIMARY KEY, value text);
CREATE TABLE smdb_data.guild_ownership (guild_id text PRIMARY KEY, node_id text NOT NULL, shard_id integer NOT NULL, claim bigint NOT NULL, shard_count integer NOT NULL, retired_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
CREATE SEQUENCE smdb_data.claim_seq;
ALTER TABLE smdb_data.meta OWNER TO ${USER};
ALTER TABLE smdb_data.guild_ownership OWNER TO ${USER};
ALTER SEQUENCE smdb_data.claim_seq OWNER TO ${USER};`;
const V1 = `CREATE SCHEMA smdb_data AUTHORIZATION ${USER};
CREATE TABLE smdb_data.meta (key text PRIMARY KEY, value text);
CREATE TABLE smdb_data.guild_ownership (guild_id text PRIMARY KEY, node_id text NOT NULL, shard_id integer NOT NULL, term bigint NOT NULL, epoch bigint NOT NULL, shard_count integer NOT NULL, retired_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE smdb_data.meta OWNER TO ${USER};
ALTER TABLE smdb_data.guild_ownership OWNER TO ${USER};`;
const row = (guild: string, claim: number) => `INSERT INTO smdb_data.guild_ownership (guild_id, node_id, shard_id, claim, shard_count) VALUES ('${guild}', 'n1', 0, ${claim}, 1);`;
const makeDb = (db: string, schema: string, extra = '') => {
  ok(`CREATE DATABASE ${db} OWNER ${USER}`);
  ok(`${schema}\n${extra}`, db);
};
const target = (db: string) => ({ containerName: NAME, user: USER, db, volume: `${NAME}-data` });
const OFF = { state: 'off', message: '', orderedAt: '2026-10-28T00:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: 'maintenance' };
const bot = (id: string, db: string) => ({
  id, displayName: `NM4 ${id}`, sanitizedName: id, sourceUrl: 'https://example.invalid/fake/app', status: 'stopped', createdAt: '2026-10-28T00:00:00.000Z',
  fleetDb: { ...target(db), password: 'pw', image: 'postgres:16-alpine' }, fleetBackup: { enabled: false, hour: 4, keep: 7 }, maintenance: OFF,
});

describe.skipIf(process.platform === 'win32' || !dockerRuns)('NM4 the claim floor against a real Postgres 16 (Linux with docker)', () => {
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

  it('PG1 probeClaims answers the higher of the sequence and the rows', async () => {
    makeDb('pg1', V2, `SELECT setval('smdb_data.claim_seq', 12); ${row('g3', 3)} ${row('g15', 15)}`);
    expect(await fb.probeClaims(target('pg1'))).toEqual({ ok: true, shape: 'claims', claim: 15 });
    ok("SELECT setval('smdb_data.claim_seq', 20)", 'pg1');
    expect(await fb.probeClaims(target('pg1'))).toEqual({ ok: true, shape: 'claims', claim: 20 });
    makeDb('pg1e', V2);
    expect(await fb.probeClaims(target('pg1e'))).toEqual({ ok: true, shape: 'claims', claim: 1 });
  }, 120000);

  it('PG2 probeClaims answers old on the term schema and none on neither', async () => {
    makeDb('pg2v1', V1);
    expect(await fb.probeClaims(target('pg2v1'))).toEqual({ ok: true, shape: 'old', claim: null });
    ok(`CREATE DATABASE pg2n OWNER ${USER}`);
    expect(await fb.probeClaims(target('pg2n'))).toEqual({ ok: true, shape: 'none', claim: null });
  }, 120000);

  it('PG3 raiseClaims under the read-only setting, through the fence-exempt session only', async () => {
    makeDb('pg3', V2, `SELECT setval('smdb_data.claim_seq', 4); ${row('g3', 3)} ${row('g9', 9)} ${row('g11', 11)}`);
    ok('ALTER SYSTEM SET default_transaction_read_only = on');
    ok('SELECT pg_reload_conf()');
    try {
      const sql = fb.claimRaiseSql(9, { seq: true, table: true, claim: true });
      const plain = psql(sql, 'pg3');
      expect(plain.status).not.toBe(0);
      expect(plain.err).toMatch(/cannot execute/);
      const raised = await fb.raiseClaims(target('pg3'), 9);
      expect(raised.ok).toBe(true);
      expect(raised.seq).toBe(10);
      expect([...raised.guilds].sort()).toEqual(['g3', 'g9']);
      expect(ok('SELECT guild_id || \'=\' || claim FROM smdb_data.guild_ownership ORDER BY guild_id', 'pg3').split('\n')).toEqual(['g11=11', 'g3=10', 'g9=10']);
    } finally {
      ok('ALTER SYSTEM RESET default_transaction_read_only');
      ok('SELECT pg_reload_conf()');
    }
    expect(ok("SELECT nextval('smdb_data.claim_seq')", 'pg3')).toBe('11');
    ok("SELECT setval('smdb_data.claim_seq', 50)", 'pg3');
    const again = await fb.raiseClaims(target('pg3'), 9);
    expect(again).toEqual({ ok: true, seq: 50, guilds: [] });
    expect(ok('SELECT last_value FROM smdb_data.claim_seq', 'pg3')).toBe('50');
  }, 120000);

  it('PG4 pg_restore -l of real dumps: claims, terms, none (the texts are printed for the fixtures)', async () => {
    makeDb('pg4v2', V2, row('g1', 1));
    makeDb('pg4v1', V1);
    ok(`CREATE DATABASE pg4n OWNER ${USER}`);
    ok('CREATE TABLE public.t (x int)', 'pg4n');
    const shapes: Record<string, string> = {};
    for (const db of ['pg4v2', 'pg4v1', 'pg4n']) {
      expect(run(['exec', NAME, 'pg_dump', '-U', ADMIN, '-Fc', '-f', `/tmp/${db}.dump`, db]).status).toBe(0);
      const file = path.join(h.dir, `${db}.dump`);
      expect(run(['cp', `${NAME}:/tmp/${db}.dump`, file]).status).toBe(0);
      const toc = await fb.readDumpToc(NAME, file);
      expect(toc.ok, toc.error).toBe(true);
      console.log(`[NM4 PG4] pg_restore -l of ${db}:\n${toc.toc}`);
      shapes[db] = fb.dumpClaimShape(toc.toc);
    }
    expect(shapes).toEqual({ pg4v2: 'claims', pg4v1: 'terms', pg4n: 'none' });
  }, 180000);

  it('PG5 a whole-bot restore of an Off bot raises every restored claim above the live floor', async () => {
    const id = `nm4pg5${process.pid}`;
    makeDb('pg5', V2, `SELECT setval('smdb_data.claim_seq', 5); ${row('g3', 3)} ${row('g5', 5)}`);
    h.urls[id] = `postgres://${USER}:pw@${NAME}:5432/pg5`;
    fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances: { [id]: bot(id, 'pg5') } }));
    const dump = await fleetBackup.runFleetDump(bot(id, 'pg5') as any, 'nm4-');
    expect(dump.success, dump.error).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(backupDir(id), `${dump.file}.json`), 'utf-8'));
    ok(`SELECT setval('smdb_data.claim_seq', 20); ${row('g20', 20)}`, 'pg5');
    const r = await fleetBackup.restoreFleetBackup(id, dump.file!);
    expect(r.success, r.error).toBe(true);
    expect(r.steps).toMatchObject({ botState: 'off', claimFloor: 20, claimRaisedTo: 21 });
    expect(ok('SELECT DISTINCT claim FROM smdb_data.guild_ownership', 'pg5')).toBe('21');
    expect(ok("SELECT nextval('smdb_data.claim_seq')", 'pg5')).toBe('22');
    expect(JSON.parse(fs.readFileSync(path.join(backupDir(id), 'claim-floor.json'), 'utf-8'))).toEqual({ claim: 20 });
    expect(ok('SHOW default_transaction_read_only')).toBe('off');
    expect(run(['exec', NAME, 'grep', '-c', 'smdb-write-fence', '/var/lib/postgresql/data/pg_hba.conf']).out).toBe('0');
    expect(ok(`SELECT rolcanlogin FROM pg_roles WHERE rolname = '${USER}'`)).toBe('f');
    expect(compareCounts(meta.counts, countsOf('pg5')).ok).toBe(true);
  }, 300000);

  it('PG6 a live database on the term schema refuses with T6 and changes nothing', async () => {
    const id = `nm4pg6${process.pid}`;
    makeDb('pg6', V1, "INSERT INTO smdb_data.guild_ownership (guild_id, node_id, shard_id, term, epoch, shard_count) VALUES ('g1', 'n1', 0, 4, 1, 1);");
    makeDb('pg6src', V2, row('g1', 2));
    h.urls[id] = `postgres://${USER}:pw@${NAME}:5432/pg6`;
    fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances: { [id]: bot(id, 'pg6') } }));
    fs.mkdirSync(backupDir(id), { recursive: true });
    expect(run(['exec', NAME, 'pg_dump', '-U', ADMIN, '-Fc', '-f', '/tmp/pg6src.dump', 'pg6src']).status).toBe(0);
    expect(run(['cp', `${NAME}:/tmp/pg6src.dump`, path.join(backupDir(id), 'v2.dump')]).status).toBe(0);
    const oid = ok("SELECT oid FROM pg_database WHERE datname = 'pg6'");
    const before = countsOf('pg6');
    const r = await fleetBackup.restoreFleetBackup(id, 'v2.dump');
    expect(r.success).toBe(false);
    expect(r.error).toBe("The bot's database numbers its saves by term, which this manager no longer reads, so the restore was refused, and nothing was changed: smdb_data.guild_ownership has no claim column");
    expect(ok("SELECT oid FROM pg_database WHERE datname = 'pg6'")).toBe(oid);
    expect(compareCounts(before, countsOf('pg6')).ok).toBe(true);
    expect(ok('SHOW default_transaction_read_only')).toBe('off');
    expect(run(['exec', NAME, 'grep', '-c', 'smdb-write-fence', '/var/lib/postgresql/data/pg_hba.conf']).out).toBe('0');
  }, 300000);

  it('PG7 with the bot role refused login, the count and the end of sessions read 0 past the launcher restart', async () => {
    const t = { container: NAME, user: USER };
    ok(`ALTER ROLE ${USER} NOLOGIN`);
    pause(6000);
    const first = await dbLogin.readBotLogin(t);
    expect(first.ok && first.login.sessions).toBe(0);
    expect(await dbLogin.endBotSessions(t)).toEqual({ ok: true });
    pause(6000);
    const after = await dbLogin.readBotLogin(t);
    expect(after.ok && after.login.sessions).toBe(0);
  }, 120000);

  it("PG8 under the restore's read-only layer, the block lands, a plain LOGIN fails, and the fence read follows the lift", async () => {
    const t = { container: NAME, user: USER };
    const owner = fb.newFenceOwner('restore');
    ok(`ALTER ROLE ${USER} LOGIN`);
    expect(run(['exec', '-u', 'root', NAME, 'sh', '-c', fb.fenceOwnerFileScript(owner)]).status).toBe(0);
    ok('ALTER SYSTEM SET default_transaction_read_only = on');
    ok('SELECT pg_reload_conf()');
    try {
      expect(ok('SHOW default_transaction_read_only')).toBe('on');
      expect(await dbLogin.blockBotLogin(t)).toEqual({ ok: true });
      expect(ok(`SELECT rolcanlogin FROM pg_roles WHERE rolname = '${USER}'`)).toBe('f');
      const plain = psql(`ALTER ROLE ${USER} LOGIN`);
      expect(plain.status).not.toBe(0);
      expect(plain.err).toMatch(/cannot execute ALTER ROLE in a read-only transaction/);
      expect(await dbLogin.openBotLogin(t)).toMatchObject({ ok: false, cls: 'write-fence' });
      expect(ok(`SELECT rolcanlogin FROM pg_roles WHERE rolname = '${USER}'`)).toBe('f');
      expect(await dbLogin.readWriteFence(t)).toEqual({ ok: true, on: true, owner, persisted: true });
    } finally {
      expect(await fb.liftOwnedFence(target('postgres'), owner)).toBe('lifted');
    }
    expect(await dbLogin.readWriteFence(t)).toEqual({ ok: true, on: false });
    expect(ok('SHOW default_transaction_read_only')).toBe('off');
    ok(`ALTER ROLE ${USER} NOLOGIN`);
  }, 120000);
});
