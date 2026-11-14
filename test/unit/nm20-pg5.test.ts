import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// NM20 part 5: the whole-bot restore against a real Postgres 16 (R9's PG5 to PG7, S2, S12, U8, X1, X6, Y5, Y8, PG17).
// Skipped on Windows and without docker; the main session runs it on Linux.
const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm20-pg5-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, urls: {} as Record<string, string> };
});

vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
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

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { CHECKSUM_SQL, COUNTS_SQL, backupDir, parseCountLines } from '../../src/instance/backupFiles';
import { metaPsql, workArgs, workPsql } from '../../src/instance/dbLogin';
import * as fleetBackup from '../../src/instance/fleetBackup';
import { checksumsOf } from '../../src/instance/fleetMove';
import { addressTableSql } from '../../src/instance/fleetReplication';
import { raiseSql, replicationRoleEnsureSql } from '../../src/instance/switchSql';
import { type Cluster, docker, dockerRuns, provisionedCluster } from './pg-cluster';
import { writeDumpMeta } from './restore-fake';

const fb = fleetBackup as any;
const ID = `nm20pg5${process.pid}`;
const U = 'app';
const PW = 'nm20-pg5-bot-password';

const ok = (r: { status: number | null; out: string; err: string }) => {
  expect(r.status, r.err).toBe(0);
  return r.out;
};

const V3 = `CREATE SCHEMA smdb_data AUTHORIZATION ${U};
CREATE TABLE smdb_data.meta (key text PRIMARY KEY, value text);
CREATE TABLE smdb_data.guild_ownership (guild_id text PRIMARY KEY, node_id text NOT NULL, shard_id integer NOT NULL, claim bigint NOT NULL, shard_count integer NOT NULL, retired_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
CREATE SEQUENCE smdb_data.claim_seq;
CREATE TABLE smdb_data.shard_claims (
  shard_count integer NOT NULL, shard_id integer NOT NULL, claim bigint NOT NULL, holder_process text NOT NULL, holder_node text NOT NULL,
  holder_name text NOT NULL, home_node text NOT NULL, released boolean NOT NULL DEFAULT false, reserved boolean NOT NULL DEFAULT false,
  taken_at timestamptz NOT NULL DEFAULT now(), renewed_at timestamptz NOT NULL DEFAULT now(), ttl_ms bigint NOT NULL, expires_up_ms bigint NOT NULL,
  extended boolean NOT NULL DEFAULT false, PRIMARY KEY (shard_count, shard_id));
CREATE TABLE smdb_data.claim_clock (id integer PRIMARY KEY CHECK (id = 1), up_ms bigint NOT NULL, ticked_at timestamptz NOT NULL, last_gap_ms bigint NOT NULL DEFAULT 0);
INSERT INTO smdb_data.claim_clock (id, up_ms, ticked_at) VALUES (1, 1000, now());
INSERT INTO smdb_data.meta (key, value) VALUES ('schema_version', '{"v":3}');
INSERT INTO smdb_data.guild_ownership (guild_id, node_id, shard_id, claim, shard_count) VALUES ('g1', 'n1', 0, 3, 1);
INSERT INTO smdb_data.shard_claims (shard_count, shard_id, claim, holder_process, holder_node, holder_name, home_node, ttl_ms, expires_up_ms) VALUES (1, 0, 3, 'p1', 'n1', 'node one', 'n1', 30000, 90000);
SELECT setval('smdb_data.claim_seq', 3);`;

// PG5 (RS3, S12, Y8): code the bot's role plants, each piece logging who ran it. planted_log is UNLOGGED, so COUNTS_SQL
// (permanent tables only) leaves out the rows the planted code writes during the restore, as in nm20-pg6 (fix 5b).
const PLANTED = `CREATE UNLOGGED TABLE smdb_data.planted_log (object text NOT NULL, su text NOT NULL, cu text NOT NULL);
CREATE FUNCTION smdb_data.plant(obj text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN INSERT INTO smdb_data.planted_log VALUES (obj, session_user, current_user); RETURN true; END $$;
CREATE FUNCTION smdb_data.pkey(k int) RETURNS int LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN PERFORM smdb_data.plant('partition'); RETURN k; END $$;
CREATE FUNCTION smdb_data.escalate() RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  RESET ROLE;
  INSERT INTO smdb_data.planted_log VALUES ('reset', session_user, current_user);
  BEGIN
    EXECUTE 'ALTER ROLE ${U} SUPERUSER';
    INSERT INTO smdb_data.planted_log VALUES ('alter-done', session_user, current_user);
  EXCEPTION WHEN others THEN
    INSERT INTO smdb_data.planted_log VALUES ('alter-failed', session_user, current_user);
  END;
  RETURN true;
END $$;
CREATE FUNCTION smdb_data.on_shard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM smdb_data.plant('trigger'); RETURN NEW; END $$;
CREATE TABLE smdb_data.checked (x int CHECK (smdb_data.plant('check')));
-- C3: the bot role owns the row type, so it may cast it; CHECKSUM_SQL's t::text calls this ahead of the I/O conversion.
CREATE FUNCTION smdb_data.checked_text(c smdb_data.checked) RETURNS text LANGUAGE plpgsql AS $$
BEGIN PERFORM smdb_data.plant('cast'); RETURN c.x::text; END $$;
CREATE CAST (smdb_data.checked AS text) WITH FUNCTION smdb_data.checked_text(smdb_data.checked);
-- Named to sort last: pg_dump writes the data blocks by name, and its RESET ROLE lasts for the rest of the session.
CREATE TABLE smdb_data.zz_escalated (x int CHECK (smdb_data.escalate()));
CREATE TABLE smdb_data.parted (k int) PARTITION BY RANGE (smdb_data.pkey(k));
CREATE TABLE smdb_data.parted_low PARTITION OF smdb_data.parted FOR VALUES FROM (0) TO (100);
CREATE TRIGGER planted AFTER UPDATE ON smdb_data.shard_claims FOR EACH ROW EXECUTE FUNCTION smdb_data.on_shard();
INSERT INTO smdb_data.checked VALUES (1);
INSERT INTO smdb_data.parted VALUES (5);
INSERT INTO smdb_data.zz_escalated VALUES (1);
DELETE FROM smdb_data.planted_log;`;

const OFF = { state: 'off', message: '', orderedAt: '2026-10-28T00:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: 'maintenance' };

describe.skipIf(process.platform === 'win32' || !dockerRuns)('NM20 part 5: the whole-bot restore against a real Postgres 16 (Linux with docker)', () => {
  let main: Cluster;
  const target = (db: string) => ({ containerName: main.name, user: U, db, volume: `${main.name}-data` });
  const bot = (id: string, db: string) => ({
    id, displayName: `NM20 ${id}`, sanitizedName: id, sourceUrl: 'https://example.invalid/fake/app', status: 'stopped', createdAt: '2026-11-13T00:00:00.000Z',
    fleetDb: { ...target(db), password: PW, image: 'postgres:16-alpine' }, fleetBackup: { enabled: false, hour: 4, keep: 7 }, maintenance: OFF,
  });
  const admin = (sql: string, db = 'postgres') => ok(main.psql('dbm_admin', sql, db));
  const asBot = (sql: string, db: string) => {
    admin(`ALTER ROLE ${U} LOGIN`);
    try { return ok(main.psql(U, sql, db)); } finally { admin(`ALTER ROLE ${U} NOLOGIN`); }
  };
  // R3.2 step 4: provisioning grants the bot's database to dbm_meta (CONNECT, CREATE) and dbm_work (CONNECT); fix 5b.
  const makeDb = (db: string, sql: string) => {
    admin(`CREATE DATABASE ${db} OWNER ${U}`);
    admin(`GRANT CONNECT, CREATE ON DATABASE ${db} TO dbm_meta; GRANT CONNECT ON DATABASE ${db} TO dbm_work;`);
    asBot(sql, db);
  };
  const register = (id: string, db: string) => {
    h.urls[id] = `postgres://${U}:${PW}@${main.name}:5432/${db}`;
    fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances: { [id]: bot(id, db) } }));
    return bot(id, db);
  };
  const managerSums = (db: string, tables: string[]) => ok(docker(['exec', '-i', main.name, 'psql', '-X', '-U', 'dbm_work', '-d', db, '-tA', '-v', 'ON_ERROR_STOP=1'], `${CHECKSUM_SQL};`))
    .split('\n').filter(l => tables.some(t => l.startsWith(`checksum|smdb_manager.${t}|`))).sort();

  beforeAll(async () => {
    main = await provisionedCluster({ name: `${ID}-main`, user: U, db: U, password: PW });
    admin(replicationRoleEnsureSql('replicator'));
    admin(`ALTER ROLE ${U} NOLOGIN`);
  }, 300000);

  afterAll(() => {
    main?.remove();
    fs.rmSync(h.dir, { recursive: true, force: true });
  }, 180000);

  it('PG7 (S2, X1): the other list leaves smdb_manager to dbm_meta; with -N alone pg_restore still creates the schema', async () => {
    makeDb('pg7src', V3);
    ok(main.psql('dbm_meta', `CREATE SCHEMA smdb_manager; GRANT USAGE ON SCHEMA smdb_manager TO PUBLIC, dbm_work;
ALTER DEFAULT PRIVILEGES IN SCHEMA smdb_manager GRANT SELECT ON TABLES TO dbm_work;
COMMENT ON SCHEMA smdb_manager IS 'the manager''s own';
${raiseSql('main.example', 2)}
${addressTableSql('main.example', 5433, 'cert', 'main.example', null)}`, 'pg7src'));
    ok(docker(['exec', main.name, 'sh', '-c', `pg_dump -U dbm_work -Fc -d pg7src > /tmp/pg7.dump`]));
    const toc = ok(docker(['exec', main.name, 'pg_restore', '-l', '/tmp/pg7.dump']));
    console.log(`[nm20-pg5] pg_restore -l of the PG7 dump:\n${toc}`);
    const managerToc = ok(docker(['exec', main.name, 'pg_restore', '-l', '-n', 'smdb_manager', '/tmp/pg7.dump']));
    const other = fb.restoreLists(`${toc}\n`, `${managerToc}\n`).other as string;
    expect(other).not.toMatch(/ smdb_manager /);
    expect(other).toMatch(/TABLE DATA smdb_data guild_ownership /);
    ok(docker(['exec', '-i', main.name, 'sh', '-c', 'cat > /tmp/pg7.list'], other));

    const plainN = docker(['exec', main.name, 'pg_restore', '-N', 'smdb_manager', '-f', '-', '/tmp/pg7.dump']);
    expect(plainN.out).toContain('CREATE SCHEMA smdb_manager;');

    admin(`CREATE DATABASE pg7dst OWNER ${U}`);
    admin('GRANT CONNECT, CREATE ON DATABASE pg7dst TO dbm_meta; GRANT CONNECT ON DATABASE pg7dst TO dbm_work;');
    ok(main.psql('dbm_meta', 'CREATE SCHEMA smdb_manager;', 'pg7dst'));
    ok(docker(['exec', main.name, 'pg_restore', '-U', 'dbm_work', '-d', 'pg7dst', `--role=${U}`, '--no-owner', '--no-privileges', '--exit-on-error', '-L', '/tmp/pg7.list', '/tmp/pg7.dump']));
    expect(admin("SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'smdb_manager'", 'pg7dst')).toBe('dbm_meta');
    expect(admin("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'smdb_manager'", 'pg7dst')).toBe('0');
    expect(admin("SELECT count(*) FROM pg_description d JOIN pg_namespace n ON n.oid = d.objoid WHERE n.nspname = 'smdb_manager'", 'pg7dst')).toBe('0');
    expect(admin('SELECT count(*) FROM smdb_data.guild_ownership', 'pg7dst')).toBe('1');
  }, 300000);

  it('PG17 (X1): a dump of a provisioned database restores with the same counts and smdb_manager checksums', async () => {
    const id = `${ID}a`;
    makeDb('pg17', V3);
    ok(main.psql('dbm_meta', `CREATE SCHEMA smdb_manager; GRANT USAGE ON SCHEMA smdb_manager TO PUBLIC, dbm_work;
ALTER DEFAULT PRIVILEGES IN SCHEMA smdb_manager GRANT SELECT ON TABLES TO dbm_work;
${raiseSql('main.example', 4)}
INSERT INTO smdb_manager.received VALUES ('0123456789abcdef01234567', '7349081263451237', E'm\\tab\\\\x ''q'' \\u00e9 \\n end', 2, now());
INSERT INTO smdb_manager.copies (slot, machine, client) VALUES ('smdb_copy_a', 'copy.example', '172.18.0.5'), ('smdb_copy_b', NULL, NULL);`, 'pg17'));
    const instance = register(id, 'pg17');
    const before = managerSums('pg17', ['received', 'copies']);
    const dump = await fleetBackup.runFleetDump(instance as any, 'nm20-');
    expect(dump.success, dump.error).toBe(true);
    asBot("INSERT INTO smdb_data.meta (key, value) VALUES ('after', 'dump')", 'pg17');
    const r = await fleetBackup.restoreFleetBackup(id, dump.file!);
    expect(r.success, r.error).toBe(true);
    expect(r.steps.counts?.result).toBe('matched');
    expect(managerSums('pg17', ['received', 'copies'])).toEqual(before);
    expect(admin('SELECT generation FROM smdb_manager.generation', 'pg17')).toBe('5');
    expect(admin("SELECT count(*) FROM smdb_data.meta WHERE key = 'after'", 'pg17')).toBe('0');
    expect(admin("SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'smdb_manager'", 'pg17')).toBe('dbm_meta');
    expect(admin("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'smdb_manager' AND c.relkind = 'r' AND pg_get_userbyid(c.relowner) <> 'dbm_meta'", 'pg17')).toBe('0');
    expect(admin(`SELECT rolsuper FROM pg_roles WHERE rolname = '${U}'`)).toBe('f');
  }, 300000);

  it('PG17 (Y5): an archive whose smdb_manager entry is not a COPY block is refused with RS-META, and none of its text runs', async () => {
    const id = `${ID}b`;
    makeDb('pg17b', V3);
    const planted = `x'); ALTER TABLE smdb_manager.generation ALTER COLUMN since SET DEFAULT smdb_data.f(); --`;
    ok(main.psql('dbm_meta', `CREATE SCHEMA smdb_manager; GRANT USAGE ON SCHEMA smdb_manager TO PUBLIC, dbm_work;
${raiseSql(planted, 4)}`, 'pg17b'));
    register(id, 'pg17b');
    // pg_dump --inserts writes the entry's data as INSERT statements, not as a COPY block.
    const file = `nm20-inserts-${process.pid}.dump`;
    ok(docker(['exec', main.name, 'sh', '-c', `pg_dump -U dbm_work -Fc --inserts -d pg17b > /tmp/${file}`]));
    fs.mkdirSync(backupDir(id), { recursive: true });
    ok(docker(['cp', `${main.name}:/tmp/${file}`, path.join(backupDir(id), file)]));
    // The counts file a dump has, written as nm9-pg's rows write it: COUNTS_SQL as dbm_work, read when the archive was taken.
    const counts = parseCountLines(`${ok(docker(workPsql(main.name, 'pg17b', `${COUNTS_SQL};`).args))}\n`);
    if (!counts.ok) throw new Error(counts.error);
    writeDumpMeta(backupDir(id), file, counts.counts);
    const r = await fleetBackup.restoreFleetBackup(id, file);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(new RegExp(`^The dump ${file.replace(/\./g, '\\.')} holds smdb_manager rows the manager could not read, so the restore was refused, and nothing was changed: `));
    expect(admin("SELECT count(*) FROM pg_attrdef d JOIN pg_class c ON c.oid = d.adrelid WHERE c.relname = 'generation' AND pg_get_expr(d.adbin, d.adrelid) LIKE '%smdb_data.f%'", 'pg17b')).toBe('0');
    expect(admin("SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%smdb_data.f()%' AND pid <> pg_backend_pid()")).toBe('0');
    expect(admin('SELECT generation FROM smdb_manager.generation', 'pg17b')).toBe('4');
  }, 300000);

  it('PG5 (RS3, S12, U8, X6, Y8, C3): planted code runs as dbm_work with the bot role\'s rights, and the bot role stays plain', async () => {
    // U8, X6, Y8: a view in place of guild_ownership, its base one row, read by probeClaims' own argv.
    makeDb('pg5v', `CREATE SCHEMA smdb_data AUTHORIZATION ${U};
CREATE SEQUENCE smdb_data.claim_seq;
CREATE TABLE smdb_data.base (guild_id text PRIMARY KEY, claim bigint NOT NULL);
INSERT INTO smdb_data.base VALUES ('g1', 2);
CREATE FUNCTION smdb_data.warn(c bigint) RETURNS bigint LANGUAGE plpgsql AS $$
BEGIN RAISE WARNING 'planted|%|%|%', 'view', session_user, current_user; RETURN c; END $$;
CREATE VIEW smdb_data.guild_ownership AS SELECT guild_id, smdb_data.warn(claim) AS claim FROM smdb_data.base;`);
    const tables = fb.parseClaimTables(ok(docker(workPsql(main.name, 'pg5v', "SELECT to_regclass('smdb_data.claim_seq') IS NOT NULL, to_regclass('smdb_data.guild_ownership') IS NOT NULL, EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('smdb_data.guild_ownership') AND attname = 'claim' AND NOT attisdropped), to_regclass('smdb_data.shard_claims') IS NOT NULL, to_regclass('smdb_data.claim_clock') IS NOT NULL").args)));
    const probe = docker(workPsql(main.name, 'pg5v', fb.claimFloorSql(tables).sql).args);
    console.log(`[nm20-pg5] probeClaims' stderr:\n${probe.err}`);
    expect(probe.status, probe.err).toBe(0);
    expect(probe.err.split('\n').filter(l => l.includes('planted|'))).toEqual([expect.stringContaining('planted|view|dbm_work|dbm_work')]);
    expect(await fb.probeClaims(target('pg5v'))).toEqual({ ok: true, shape: 'claims', claim: 2 });

    const id = `${ID}c`;
    makeDb('pg5', `${V3}\n${PLANTED}`);
    const instance = register(id, 'pg5');
    const dump = await fleetBackup.runFleetDump(instance as any, 'nm20-');
    expect(dump.success, dump.error).toBe(true);
    const r = await fleetBackup.restoreFleetBackup(id, dump.file!);
    console.log(`[nm20-pg5] the restore of the planted dump answered: ${JSON.stringify({ success: r.success, error: r.error })}`);
    expect(r.success, r.error).toBe(true);
    const log = admin("SELECT object || '|' || su || '|' || cu FROM smdb_data.planted_log ORDER BY 1", 'pg5').split('\n');
    console.log(`[nm20-pg5] planted_log after the restore:\n${log.join('\n')}`);
    expect(log).toContain('check|dbm_work|app');
    expect(log).toContain('partition|dbm_work|app');
    expect(log).toContain('trigger|dbm_work|dbm_work');
    expect(log).toContain('reset|dbm_work|dbm_work');
    expect(log).toContain('alter-failed|dbm_work|dbm_work');
    expect(log).not.toContain('alter-done|dbm_work|dbm_work');
    // C3: the cast through the sender's checksumsOf (dbm_work, no SET ROLE, as decision 11 found for probeClaims).
    const casts = admin("SELECT count(*) FROM pg_cast WHERE castsource = 'smdb_data.checked'::regtype AND casttarget = 'text'::regtype", 'pg5');
    console.log(`[nm20-pg5] casts from smdb_data.checked to text after the restore: ${casts}`);
    expect(casts).toBe('1');
    const sums = await checksumsOf({ container: main.name, user: U }, 'pg5');
    expect(sums.ok, JSON.stringify(sums)).toBe(true);
    const cast = admin("SELECT DISTINCT object || '|' || su || '|' || cu FROM smdb_data.planted_log WHERE object = 'cast'", 'pg5');
    console.log(`[nm20-pg5] the cast rows of planted_log after checksumsOf:\n${cast}`);
    expect(cast).toBe('cast|dbm_work|dbm_work');
    expect(admin(`SELECT rolsuper::text || rolcreatedb::text || rolcreaterole::text || rolreplication::text || rolbypassrls::text FROM pg_roles WHERE rolname = '${U}'`)).toBe('falsefalsefalsefalsefalse');
    expect(admin("SELECT rolname FROM pg_roles WHERE oid = 10")).toBe('dbm_admin');
  }, 300000);

  it('fix 5b: with BEGIN in the meta script, a stdin that ends before COMMIT leaves nothing committed (printed beside --single-transaction)', async () => {
    const script = fb.metaTransactionSql('') as string;
    const cut = script.slice(0, script.indexOf('GRANT SELECT ON ALL TABLES'));
    for (const db of ['pgtx', 'pgtx1']) makeDb(db, 'SELECT 1;');
    const schemas = (db: string) => admin("SELECT count(*) FROM pg_namespace WHERE nspname = 'smdb_manager'", db);
    const own = metaPsql(main.name, 'pgtx', `BEGIN;\n${cut}`, { stdin: true, exempt: true });
    const fed = docker(own.args, own.input);
    console.log(`[nm20-pg5] BEGIN in the script, stdin ended before COMMIT: exit ${fed.status}, stderr: ${fed.err || '(none)'}; smdb_manager schemas after: ${schemas('pgtx')}`);
    expect(schemas('pgtx')).toBe('0');
    const single = metaPsql(main.name, 'pgtx1', cut, { stdin: true, exempt: true });
    const fed1 = docker([...single.args, '--single-transaction'], single.input);
    console.log(`[nm20-pg5] --single-transaction, stdin ended at the same point: exit ${fed1.status}, stderr: ${fed1.err || '(none)'}; smdb_manager schemas after: ${schemas('pgtx1')}`);
  }, 300000);

  // Fix 5c, C2-1: the table's schema comes from the holder's CONTEXT line or pg_dump's Command was line; both names quoted.
  it.each([
    ['smdb_data.meta', 'pgrls', 'r', '', 'smdb_data.meta', '"smdb_data"."meta"'],
    ['a mixed-case table in public', 'pgrls2', 'r2', 'CREATE TABLE public."Odd T" (x int); INSERT INTO public."Odd T" VALUES (1);', 'public."Odd T"', '"public"."Odd T"'],
  ])('fix 5b, C2: forced row security on %s: the refusal gives the statement that lifts it, the statement runs as given, and the restore runs after it', async (_n, db, suffix, extra, table, named) => {
    const id = `${ID}${suffix}`;
    makeDb(db, `${V3}\n${extra}`);
    const instance = register(id, db);
    const dump = await fleetBackup.runFleetDump(instance as any, 'nm20-');
    expect(dump.success, dump.error).toBe(true);
    asBot(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`, db);
    const counts = docker(workPsql(main.name, db, `${COUNTS_SQL};`).args);
    const dumped = docker(workArgs(main.name, db, 'pg_dump', ['-Fc', '-f', '/dev/null']));
    console.log(`[nm20-pg5] COUNTS_SQL as dbm_work, its stderr:\n${counts.err}\n[nm20-pg5] pg_dump as dbm_work, its stderr:\n${dumped.err}`);
    const r = await fleetBackup.restoreFleetBackup(id, dump.file!);
    console.log(`[nm20-pg5] the restore with forced row security answered: ${r.error}\n[nm20-pg5] the backup's last error: ${JSON.stringify(fleetBackup.fleetBackupStatus(instance as any).main?.lastError)}`);
    expect(r.success).toBe(false);
    expect(r.error).toBe(`Pre-restore dump failed, restore refused; only the database's own settings and its grants to dbm_meta and dbm_work were reset (its connection limit, its template and connection flags, its database-level settings and those grants): row-level security is forced on ${named}, so the database cannot be dumped before the restore replaces it. The manager has no SQL console; on this machine, run docker exec -it ${main.name} psql -U dbm_work -d ${db} -c 'SET ROLE "${U}"; ALTER TABLE ${named} NO FORCE ROW LEVEL SECURITY', then restore again`);
    // The operator's step: the command exactly as the text gives it, through a shell, without the terminal flags.
    const command = r.error!.slice(r.error!.indexOf('run docker exec -it ') + 'run '.length, r.error!.lastIndexOf(', then restore again')).replace('docker exec -it ', 'docker exec ');
    const ran = spawnSync('sh', ['-c', command], { encoding: 'utf-8', timeout: 60000 });
    console.log(`[nm20-pg5] the operator's command exited ${ran.status}: ${(ran.stderr || '').trim() || '(no stderr)'}`);
    expect(ran.status, ran.stderr).toBe(0);
    const again = await fleetBackup.restoreFleetBackup(id, dump.file!);
    expect(again.success, again.error).toBe(true);
  }, 300000);

  // Last: a failed restore keeps the read-only fence on the whole cluster.
  it('PG6 (RS4): an event trigger made by a superuser fails the restore as dbm_work with pg_restore\'s message; nothing outside the database changes', async () => {
    const id = `${ID}d`;
    makeDb('pg6', V3);
    admin(`CREATE FUNCTION public.et_fn() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN END $$;
CREATE EVENT TRIGGER pg6_et ON ddl_command_start EXECUTE FUNCTION public.et_fn();`, 'pg6');
    const instance = register(id, 'pg6');
    const roles = admin('SELECT count(*) FROM pg_roles');
    const dbs = admin('SELECT count(*) FROM pg_database');
    const dump = await fleetBackup.runFleetDump(instance as any, 'nm20-');
    expect(dump.success, dump.error).toBe(true);
    const r = await fleetBackup.restoreFleetBackup(id, dump.file!);
    console.log(`[nm20-pg5] the restore of the event trigger dump answered: ${r.error}`);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^Restore failed: pg_restore exited with code 1: [\s\S]*(must be superuser|permission denied)[\s\S]*event trigger/i);
    expect(admin('SELECT count(*) FROM pg_roles')).toBe(roles);
    expect(admin('SELECT count(*) FROM pg_database')).toBe(dbs);
    expect(admin(`SELECT rolsuper FROM pg_roles WHERE rolname = '${U}'`)).toBe('f');
    expect(admin("SELECT count(*) FROM pg_event_trigger", 'postgres')).toBe('0');
  }, 300000);
});
