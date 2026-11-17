import { spawn, type ChildProcess } from 'child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// NM20 part 1 against a real Postgres 16. Skipped on Windows and without docker; the main session runs it on Linux.
const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm20-pg-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, saved: [] as Array<[string, string]> };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  updateInstanceFleetDbPassword: (botId: string, password: string) => {
    h.saved.push([botId, password]);
    return { id: botId } as any;
  },
}));

import * as fs from 'fs';
import {
  MANAGER_SESSION_OPTIONS, blockBotLogin, checkRolesDrift, clusterPsql, driftReadSql, endBotSessions, openBotLogin, parseDriftRead,
  provisionRoles, readBotLogin, resetManagerRoleCache, runCall, workArgs, workPsql,
} from '../../src/instance/dbLogin';
import { GENERATION_SCHEMA_SQL, SHARD_CAP_DO_SQL } from '../../src/instance/switchSql';
import { COUNTS_SQL } from '../../src/instance/backupFiles';
import { type Cluster, PG_IMAGE, docker, dockerRuns, provisionedCluster, startCluster } from './pg-cluster';

const ID = `nm20pg${process.pid}`;
const NET = `${ID}-net`;
const U = 'smdb';
const DB = 'smdb';
const PW = 'nm20-bot-password';
const PIN = `PGOPTIONS=${MANAGER_SESSION_OPTIONS}`;
const DENIED = /permission denied|must be superuser|must be able to|only roles with/i;

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const ok = (r: { status: number | null; out: string; err: string }) => {
  expect(r.status, r.err).toBe(0);
  return r.out;
};
const refused = (r: { status: number | null; err: string }, why: RegExp = DENIED) => {
  expect(r.status, 'the statement was not refused').not.toBe(0);
  expect(r.err).toMatch(why);
};
// From another container on the cluster's network, over TCP with a password.
const fromOutside = (host: string, role: string, password: string) =>
  docker(['run', '--rm', '--network', NET, '-e', `PGPASSWORD=${password}`, PG_IMAGE, 'psql', '-h', host, '-U', role, '-d', DB, '-w', '-tA', '-c', 'SELECT 1']);
// Over TCP on the container's own address, where the image asks for a password (127.0.0.1 and the socket trust).
const tcpInside = (c: Cluster, role: string, password: string) =>
  docker(['exec', '-e', `PGPASSWORD=${password}`, c.name, 'sh', '-c', `psql -X -h "$(hostname -i | cut -d' ' -f1)" -U ${role} -d ${DB} -w -tAc 'SELECT 1'`]);
const background: ChildProcess[] = [];
// Each sleeper's exit code and stderr, so a wait that times out can say why a session is missing.
const sleeperState = new Map<ChildProcess, { role: string; code: number | null; err: string }>();
const sleeper = (c: Cluster, role: string, db = DB) => {
  const p = spawn('docker', ['exec', c.name, 'psql', '-X', '-U', role, '-d', db, '-c', 'SELECT pg_sleep(120)'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const state = { role, code: null as number | null, err: '' };
  sleeperState.set(p, state);
  p.stderr?.on('data', d => { state.err += d.toString(); });
  p.on('close', code => { state.code = code; });
  background.push(p);
  return p;
};
// Waits yield to the event loop, so a sleeper's 'close' and stderr are read while the row waits.
const tick = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const sleeperLines = (procs: ChildProcess[]) => procs.map((p, i) => {
  const x = sleeperState.get(p)!;
  return `sleeper ${i + 1}: exit ${x.code === null ? 'still running' : x.code}, stderr: ${x.err.trim() || '(none)'}`;
});
// What to read when a wait fails: process titles, every backend, locks not granted, prepared transactions, the log.
const probe = (c: Cluster, what: string) => {
  const read = (sql: string) => { const r = c.psql('dbm_admin', sql, 'postgres'); return r.out || r.err || '(none)'; };
  const ps = docker(['exec', c.name, 'sh', '-c', 'ps -eo pid,args 2>/dev/null || ps -o pid,args']);
  const logs = docker(['logs', '--tail', '30', c.name]);
  console.log([
    `[nm20-pg] ${what} on ${c.name}; what the cluster showed then:`,
    `ps -eo pid,args in the container:\n${ps.out || ps.err || '(none)'}`,
    `pg_stat_activity, every backend (pid|backend_type|usename|datname|state|wait_event|query):\n${read("SELECT pid || '|' || coalesce(backend_type, '-') || '|' || coalesce(usename::text, '-') || '|' || coalesce(datname::text, '-') || '|' || coalesce(state, '-') || '|' || coalesce(wait_event_type || ':' || wait_event, '-') || '|' || left(coalesce(query, '-'), 80) FROM pg_stat_activity ORDER BY pid")}`,
    `pg_locks not granted (pid|locktype|mode|database|relation|objid|blocked by|usename|backend_type|wait_event):\n${read("SELECT l.pid || '|' || l.locktype || '|' || l.mode || '|' || coalesce(l.database::text, '-') || '|' || coalesce(l.relation::text, '-') || '|' || coalesce(l.objid::text, '-') || '|' || pg_blocking_pids(l.pid)::text || '|' || coalesce(a.usename::text, '-') || '|' || coalesce(a.backend_type, '-') || '|' || coalesce(a.wait_event_type || ':' || a.wait_event, '-') FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid WHERE NOT l.granted ORDER BY l.pid")}`,
    `pg_prepared_xacts (gid|owner|database|prepared):\n${read("SELECT gid || '|' || owner || '|' || database || '|' || prepared FROM pg_prepared_xacts")}`,
    `docker logs --tail 30:\n${[logs.out, logs.err].filter(Boolean).join('\n') || '(none)'}`,
  ].join('\n'));
};
// Counts the role's pg_sleep sessions with a dbm_admin login: only for clusters with ordinary slots to spare.
const waitCount = async (c: Cluster, role: string, n: number, procs: ChildProcess[], tries = 60) => {
  let seen = '';
  for (let i = 0; i < tries; i++) {
    const r = c.psql('dbm_admin', `SELECT count(*) FROM pg_stat_activity WHERE usename = '${role}' AND backend_type = 'client backend' AND query LIKE '%pg_sleep%' AND pid <> pg_backend_pid()`, 'postgres');
    seen = r.out || r.err;
    if (r.out === String(n)) return;
    await tick(500);
  }
  probe(c, `${role} did not reach ${n} session(s)`);
  throw new Error(`${role} did not reach ${n} session(s) in ${tries / 2} s (the last count read ${seen}); ${sleeperLines(procs).join('; ')}`);
};
// Counts the role's backends by their process titles (`postgres: <role> <db> [local] SELECT` while pg_sleep runs), so no login takes a slot
// while the sleepers fill them. A sleeper that ends before the count is reached fails the row at once.
const waitTitles = async (c: Cluster, role: string, db: string, n: number, procs: ChildProcess[], tries = 60) => {
  let seen = 0;
  for (let i = 0; i < tries; i++) {
    const ended = procs.filter(p => sleeperState.get(p)!.code !== null);
    if (ended.length > 0) {
      probe(c, `a ${role} sleeper ended before ${n} session(s) were open`);
      throw new Error(`${ended.length} of the ${procs.length} ${role} sleeper(s) ended before ${n} session(s) were open: ${sleeperLines(procs).join('; ')}`);
    }
    const ps = docker(['exec', c.name, 'ps', '-o', 'args']);
    seen = ps.out.split('\n').filter(l => l.trim() === `postgres: ${role} ${db} [local] SELECT`).length;
    if (seen === n) return;
    await tick(500);
  }
  probe(c, `${role} did not reach ${n} session(s)`);
  throw new Error(`${role} did not reach ${n} session(s) in ${tries / 2} s (the last count of process titles read ${seen}); ${sleeperLines(procs).join('; ')}`);
};
const target = (c: Cluster, over: Partial<Parameters<typeof provisionRoles>[0]> = {}) =>
  ({ container: c.name, user: U, db: DB, botId: c.name, password: PW as string | null, candidates: [] as string[], ...over });

describe.skipIf(process.platform === 'win32' || !dockerRuns)('NM20 the logins and provisioning against a real Postgres 16 (Linux with docker)', () => {
  let main: Cluster;
  const others: Cluster[] = [];

  beforeAll(async () => {
    docker(['network', 'create', NET]);
    main = await provisionedCluster({ name: `${ID}-main`, user: U, db: DB, password: PW, network: NET });
    ok(main.psql('dbm_meta', GENERATION_SCHEMA_SQL));
  }, 300000);

  afterAll(() => {
    for (const p of background) p.kill();
    main?.remove();
    for (const c of others) c.remove();
    docker(['network', 'rm', NET]);
    fs.rmSync(h.dir, { recursive: true, force: true });
  }, 180000);

  it('PG1 Invariant A field by field after provisionRoles (section 9, R9, S8), and a second call writes nothing', async () => {
    const admin = (sql: string) => ok(main.psql('dbm_admin', sql, 'postgres'));
    expect(admin('SELECT rolname FROM pg_roles WHERE oid = 10')).toBe('dbm_admin');
    expect(admin("SELECT (rolpassword IS NULL)::text FROM pg_authid WHERE rolname = 'dbm_admin'")).toBe('true');
    expect(admin("SELECT string_agg(setdatabase || ':' || setconfig::text, ';') FROM pg_db_role_setting WHERE setrole = 'dbm_admin'::regrole")).toBe('0:{"search_path=pg_catalog, pg_temp"}');
    for (const login of ['dbm_meta', 'dbm_work']) {
      expect(admin(`SELECT concat_ws(',', rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolpassword IS NULL, rolvaliduntil = '-infinity') FROM pg_authid WHERE rolname = '${login}'`))
        .toBe('t,f,f,f,f,f,t,t');
      expect(admin(`SELECT string_agg(setdatabase || ':' || setconfig::text, ';') FROM pg_db_role_setting WHERE setrole = '${login}'::regrole`)).toBe('0:{"search_path=pg_catalog, pg_temp"}');
    }
    expect(admin(`SELECT concat_ws(',', rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls) FROM pg_roles WHERE rolname = '${U}'`)).toBe('t,f,f,f,f,f');
    expect(admin(`SELECT concat_ws(',', pg_get_userbyid(datdba), datistemplate, datallowconn, datconnlimit) FROM pg_database WHERE datname = '${DB}'`)).toBe(`${U},f,t,-1`);
    expect(admin(`SELECT count(*) FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase WHERE s.setrole = 0 AND d.datname = '${DB}'`)).toBe('0');
    const members = admin(`SELECT string_agg(pg_get_userbyid(member) || '>' || pg_get_userbyid(roleid), ',') FROM pg_auth_members WHERE pg_get_userbyid(member) IN ('${U}', 'dbm_admin', 'dbm_meta', 'dbm_work') OR pg_get_userbyid(roleid) IN ('${U}', 'dbm_admin', 'dbm_meta', 'dbm_work')`);
    expect(members.split(',').sort()).toEqual(['dbm_meta>pg_read_all_stats', 'dbm_meta>pg_use_reserved_connections', 'dbm_work>pg_use_reserved_connections', `dbm_work>${U}`]);
    expect(admin(`SELECT concat_ws(',', has_database_privilege('dbm_meta', '${DB}', 'CONNECT'), has_database_privilege('dbm_meta', '${DB}', 'CREATE'), has_database_privilege('dbm_work', '${DB}', 'CONNECT'))`)).toBe('t,t,t');
    expect(ok(main.psql('dbm_meta', "SELECT pg_get_userbyid(nspowner) || ',' || has_schema_privilege('dbm_work', oid, 'USAGE') FROM pg_namespace WHERE nspname = 'smdb_manager'"))).toBe('dbm_meta,true');
    expect(ok(main.psql('dbm_work', 'SELECT count(*) FROM smdb_manager.generation'))).toBe('0');
    expect(admin("SELECT current_setting('reserved_connections')")).toBe('4');
    expect(await provisionRoles(target(main))).toEqual({ ok: true, wrote: [] });
    expect(await provisionRoles(target(main), { reread: true })).toEqual({ ok: true, wrote: [], reserved: 4 });
  }, 120000);

  it('PG2 what the bot role and the plain logins cannot do (section 9, R9, S5)', async () => {
    const bot = (sql: string, db = DB) => main.psql(U, sql, db);
    ok(bot('CREATE SCHEMA smdb_data; CREATE TABLE smdb_data.t (id int);'));
    refused(bot('CREATE ROLE nm20_x'));
    refused(bot("ALTER ROLE dbm_admin PASSWORD 'x'"));
    refused(bot(`ALTER ROLE ${U} SUPERUSER`));
    refused(bot("ALTER SYSTEM SET work_mem = '8MB'"));
    refused(bot("COPY (SELECT 1) TO PROGRAM 'true'"));
    refused(bot("SELECT pg_read_file('postgresql.conf')"));
    refused(bot('CREATE TABLE smdb_manager.x ()'));
    refused(bot("UPDATE smdb_manager.generation SET machine = 'x'"));
    refused(bot(`ALTER DATABASE ${DB} OWNER TO dbm_admin`));
    refused(bot('CREATE DATABASE nm20_x'));
    refused(bot('SET ROLE dbm_admin'));
    await waitCount(main, 'dbm_admin', 1, [sleeper(main, 'dbm_admin', 'postgres')]);
    // The bot's role reads no query text of another role's session, so dbm_admin reads the pid it is given.
    const adminPid = ok(main.psql('dbm_admin', "SELECT pid FROM pg_stat_activity WHERE usename = 'dbm_admin' AND query LIKE '%pg_sleep%' AND pid <> pg_backend_pid()", 'postgres'));
    expect(adminPid).toMatch(/^\d+$/);
    refused(bot(`SELECT pg_terminate_backend(${adminPid})`));
    refused(fromOutside(main.name, 'dbm_admin', PW), /password authentication failed|no password/);
    expect(ok(fromOutside(main.name, U, PW))).toBe('1');
    for (const login of ['dbm_meta', 'dbm_work']) refused(fromOutside(main.name, login, PW), /password authentication failed|no password/);
    refused(main.psql('dbm_work', "INSERT INTO smdb_manager.generation (machine, generation) VALUES ('x', 1)"));
    refused(main.psql('dbm_work', 'CREATE ROLE nm20_y'));
    refused(main.psql('dbm_meta', 'SELECT * FROM smdb_data.t'));
    ok(main.psql('dbm_work', "ALTER ROLE dbm_work PASSWORD 'planted-pw'"));
    refused(tcpInside(main, 'dbm_work', 'planted-pw'), /password authentication failed/);
    refused(main.psql('dbm_work', "ALTER ROLE dbm_work VALID UNTIL 'infinity'"));
    ok(main.psql('dbm_work', 'ALTER ROLE dbm_work SET statement_timeout = 1'));
    expect(await checkRolesDrift({ container: main.name, db: DB })).toBe(false);
    expect(await provisionRoles(target(main))).toEqual({ ok: true, wrote: ['work', 'search_path'], reserved: 4 });
    expect(ok(main.psql('dbm_admin', "SELECT concat_ws(',', rolpassword IS NULL, (SELECT string_agg(setconfig::text, ';') FROM pg_db_role_setting WHERE setrole = 'dbm_work'::regrole)) FROM pg_authid WHERE rolname = 'dbm_work'", 'postgres')))
      .toBe('t,{"search_path=pg_catalog, pg_temp"}');
  }, 300000);

  it('PG3 an old cluster whose first role is the bot role answers PV-FIRST, and Postgres 16 keeps it a superuser', async () => {
    const old = startCluster({ name: `${ID}-old`, user: U, db: DB, password: PW, firstRole: U });
    others.push(old);
    ok(old.psql(U, 'CREATE ROLE "dbm_admin" WITH SUPERUSER LOGIN', 'postgres'));
    expect(await provisionRoles(target(old))).toEqual({
      ok: false, cls: 'other',
      error: "the bot's role smdb is this database's first role, which Postgres keeps a superuser; a database the manager creates now starts with dbm_admin as its first role, so the bot's role gets less than superuser rights only on a new install",
    });
    refused(old.psql('dbm_admin', `ALTER ROLE "${U}" NOSUPERUSER`, 'postgres'), /The bootstrap user must have the SUPERUSER attribute/);
    expect(ok(old.psql('dbm_admin', `SELECT rolsuper::text FROM pg_roles WHERE rolname = '${U}'`, 'postgres'))).toBe('true');
  }, 300000);

  it('PG9 the pinned search_path holds over a database setting, and NM1 block, open and endBotSessions work on the new cluster', async () => {
    resetManagerRoleCache();
    ok(main.psql(U, `ALTER DATABASE ${DB} SET search_path = public`));
    expect(ok(main.psql('dbm_admin', 'SHOW search_path', 'postgres'))).toBe('pg_catalog, pg_temp');
    expect(ok(main.psql('dbm_work', 'SHOW search_path'))).toBe('pg_catalog, pg_temp');
    expect(ok(main.psql('dbm_work', 'SHOW search_path', DB, [PIN]))).toBe('pg_catalog,pg_temp');
    expect(ok(main.psql(U, 'SHOW search_path'))).toBe('public');
    expect(await provisionRoles(target(main))).toEqual({ ok: true, wrote: ['database'], reserved: 4 });
    const t = { container: main.name, user: U };
    expect(await blockBotLogin(t)).toEqual({ ok: true });
    refused(main.psql(U, 'SELECT 1'), /is not permitted to log in/);
    expect(await openBotLogin(t)).toEqual({ ok: true });
    await waitCount(main, U, 1, [sleeper(main, U)]);
    expect(await endBotSessions(t, 500)).toEqual({ ok: true });
    const login: any = await readBotLogin(t);
    expect(login).toEqual({ ok: true, login: { inRecovery: false, canLogin: true, sessions: 0 } });
  }, 180000);

  it('PG13 V2, V4 and V5: a URL password the volume was made with creates the role; an outside one does not; a stop after CREATE ROLE heals', async () => {
    const made = startCluster({ name: `${ID}-v2`, user: U, db: DB, password: 'url-made-pw' });
    others.push(made);
    h.saved = [];
    const r: any = await provisionRoles(target(made, { password: null, candidates: ['outside-pw', 'url-made-pw'] }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.wrote).toEqual(expect.arrayContaining(['role', 'recorded', 'password']));
    expect(h.saved).toEqual([[made.name, 'url-made-pw']]);
    expect(ok(tcpInside(made, U, 'url-made-pw'))).toBe('1');
    expect(ok(made.psql('dbm_admin', "SELECT (rolpassword IS NULL)::text FROM pg_authid WHERE rolname = 'dbm_admin'", 'postgres'))).toBe('true');

    const outside = startCluster({ name: `${ID}-v4`, user: U, db: DB, password: 'volume-pw' });
    others.push(outside);
    h.saved = [];
    expect(await provisionRoles(target(outside, { password: null, candidates: ['outside-pw'] }))).toEqual({
      ok: false, cls: 'other',
      error: 'the role smdb does not exist, and no password is on record that this database was created with (a Database URL naming this database with its password records it), so the manager cannot create it',
    });
    expect(h.saved).toEqual([]);
    expect(ok(outside.psql('dbm_admin', `SELECT count(*) FROM pg_roles WHERE rolname = '${U}'`, 'postgres'))).toBe('0');

    ok(outside.psql('dbm_admin', `CREATE ROLE "${U}" LOGIN PASSWORD 'volume-pw'`, 'postgres'));
    const healed: any = await provisionRoles(target(outside, { password: 'volume-pw' }));
    expect(healed.ok, JSON.stringify(healed)).toBe(true);
    expect(healed.wrote).toContain('owner');
    expect(healed.wrote).not.toContain('role');
    expect(ok(outside.psql('dbm_admin', `SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '${DB}'`, 'postgres'))).toBe(U);
  }, 300000);

  it('PG15 (S8, W7) with every ordinary slot taken, dbm_work and dbm_meta still connect and the bot role does not', async () => {
    const full = startCluster({ name: `${ID}-full`, user: U, db: DB, password: PW, serverArgs: ['-c', 'max_connections=10', '-c', 'reserved_connections=4'] });
    others.push(full);
    expect(await provisionRoles(target(full))).toMatchObject({ ok: true });
    // 10 less 3 superuser places less 4 reserved places leaves 3 ordinary ones.
    // A login that counts the sessions would itself take an ordinary slot; the process titles count them without one.
    await waitTitles(full, U, DB, 3, [0, 1, 2].map(() => sleeper(full, U)));
    expect(ok(full.psql('dbm_work', 'SELECT 1'))).toBe('1');
    expect(ok(full.psql('dbm_meta', 'SELECT 1'))).toBe('1');
    refused(full.psql(U, 'SELECT 1'), /reserved/);
  }, 300000);

  it('PG16 (U2, X2, Y7) the pins hold against a database and a role setting of every pinned name; the drift read counts them', async () => {
    const pinned = startCluster({ name: `${ID}-pins`, user: U, db: DB, password: PW });
    others.push(pinned);
    expect(await provisionRoles(target(pinned))).toMatchObject({ ok: true });
    const whole = docker(workArgs(pinned.name, DB, 'psql', ['-X', '-tA', '-c', 'SELECT 1']));
    expect(whole.status, `a session with the whole MANAGER_SESSION_OPTIONS did not start: ${whole.err}`).toBe(0);

    const names = MANAGER_SESSION_OPTIONS.split(' -c ').map(p => p.replace(/^-c /, '').split('=')[0]);
    // An unknown library stops every login that loads it, and heap is the image's only table access method: both get their own check.
    const planted: Record<string, string> = {
      search_path: 'public', lock_timeout: '5s', statement_timeout: '7s', idle_in_transaction_session_timeout: '9s', idle_session_timeout: '11s',
      tcp_keepalives_idle: '30', tcp_keepalives_interval: '10', tcp_keepalives_count: '5', tcp_user_timeout: '5000', TimeZone: 'America/New_York',
      DateStyle: 'SQL, DMY', IntervalStyle: 'iso_8601', extra_float_digits: '3', bytea_output: 'escape', client_encoding: 'LATIN1',
      timezone_abbreviations: 'Australia', lc_numeric: 'POSIX', lc_monetary: 'POSIX', lc_time: 'POSIX', xmloption: 'document',
      standard_conforming_strings: 'off', backslash_quote: 'on', array_nulls: 'off', quote_all_identifiers: 'on', transform_null_equals: 'on',
      row_security: 'on', restrict_nonsystem_relation_kind: 'view', gin_fuzzy_search_limit: '100', client_min_messages: 'error', exit_on_error: 'on',
      default_transaction_isolation: 'serializable', default_transaction_deferrable: 'on', default_tablespace: 'pg_default',
      temp_tablespaces: 'pg_default', synchronous_commit: 'off', stats_fetch_consistency: 'none',
      'plpgsql.extra_errors': 'all', 'plpgsql.extra_warnings': 'all', 'plpgsql.check_asserts': 'off', 'plpgsql.print_strict_params': 'on',
    };
    const own = ['local_preload_libraries', 'default_table_access_method'];
    expect(names.filter(n => !own.includes(n)).sort()).toEqual(Object.keys(planted).sort());
    const showSql = Object.keys(planted).map(n => `SELECT '${n}=' || current_setting('${n}');`).join('\n');
    const show = (env: string[]) => {
      const r = docker(['exec', ...env.flatMap(e => ['-e', e]), '-i', pinned.name, 'psql', '-X', '-h', '127.0.0.1', '-U', 'dbm_work', '-d', DB, '-tA', '-v', 'ON_ERROR_STOP=1'], `DO $$BEGIN END $$;\n${showSql}`);
      expect(r.status, r.err).toBe(0);
      return Object.fromEntries(r.out.split('\n').map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    };
    const before = show([PIN]);
    const plant = Object.entries(planted).flatMap(([n, v]) => [`ALTER DATABASE ${DB} SET ${n} = '${v}';`, `ALTER ROLE dbm_work SET ${n} = '${v}';`]).join('\n');
    ok(pinned.psql('dbm_admin', `DO $$BEGIN END $$;\n${plant}`, 'postgres'));
    const after = show([PIN]);
    const loose = show([]);
    for (const n of Object.keys(planted)) {
      expect(after[n], n).toBe(before[n]);
      // psql sends client_encoding itself, which outranks a database or role row, as it does for the manager's own psql.
      if (n !== 'client_encoding') expect(loose[n], n).not.toBe(before[n]);
    }

    const drift = await runCall(pinned.name, clusterPsql(pinned.name, driftReadSql(DB)));
    const counts = drift.ok ? parseDriftRead(drift.stdout) : null;
    expect(counts?.settings).toBeGreaterThan(0);
    expect(counts?.loginSettings).toBeGreaterThan(0);
    expect(await checkRolesDrift({ container: pinned.name, db: DB })).toBe(false);

    ok(pinned.psql(U, `CREATE SCHEMA smdb_data;
CREATE TABLE smdb_data.shard_claims (shard int PRIMARY KEY, expires_up_ms bigint NOT NULL);
CREATE TABLE smdb_data.claim_clock (id int PRIMARY KEY, up_ms bigint NOT NULL);
INSERT INTO smdb_data.shard_claims VALUES (1, 9000), (2, 9000);
INSERT INTO smdb_data.claim_clock VALUES (1, 100);`));
    const counted = await runCall(pinned.name, workPsql(pinned.name, DB, COUNTS_SQL));
    expect(counted.ok, counted.stderr).toBe(true);
    expect(counted.stdout.trim().split('\n')).toEqual(['count|smdb_data.claim_clock|1', 'count|smdb_data.shard_claims|2']);

    ok(pinned.psql(U, `ALTER TABLE smdb_data.shard_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE smdb_data.shard_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY hide_two ON smdb_data.shard_claims USING (shard <> 2);`));
    const cap = await runCall(pinned.name, workPsql(pinned.name, DB, SHARD_CAP_DO_SQL, { stdin: true }));
    expect(cap.ok).toBe(false);
    expect(cap.stderr).toMatch(/query would be affected by row-level security policy for table "shard_claims"/);
    expect(ok(pinned.psql('dbm_admin', 'SELECT expires_up_ms FROM smdb_data.shard_claims WHERE shard = 2'))).toBe('9000');
    const countsRls = await runCall(pinned.name, workPsql(pinned.name, DB, COUNTS_SQL));
    expect(countsRls.ok).toBe(false);
    expect(countsRls.stderr).toMatch(/shard_claims/);

    ok(pinned.psql('dbm_admin', "ALTER ROLE dbm_work SET local_preload_libraries = 'nm20_no_such_library';", 'postgres'));
    expect(docker(workArgs(pinned.name, DB, 'psql', ['-X', '-tA', '-c', 'SELECT 1'])).status).toBe(0);
    expect(pinned.psql('dbm_work', 'SELECT 1').status).not.toBe(0);
    ok(pinned.psql('dbm_admin', 'ALTER DATABASE smdb SET default_table_access_method = heap;', 'postgres'));
    expect(ok(docker(workArgs(pinned.name, DB, 'psql', ['-X', '-tA', '-c', 'SHOW default_table_access_method'])))).toBe('heap');
  }, 300000);
});

// NM20 part 2: one real pg_restore -f - output of the manager's tables, read by parseMetaRows (X1, Y1, Y2, Y5).
import { spawnSync as spawnBytes } from 'child_process';
import { copyGroupEnsureSql, parseMetaRows, raiseSql } from '../../src/instance/switchSql';
import { addressTableSql } from '../../src/instance/fleetReplication';
import { parseAddressRows } from '../../src/instance/fleetJoin';
import { sqlLiteral } from '../../src/config/joinCode';
import { COPY_PEM, FIXTURE_PEM } from './join-fake';

const META_ID = `nm20meta${process.pid}`;
const metaCheck = (row: unknown) => parseAddressRows(JSON.stringify([row]))[0] ?? null;
// A whole-database dump as dbm_work, then pg_restore's text of smdb_manager's rows, as bytes.
const metaText = (c: Cluster): Buffer => {
  const r = spawnBytes('docker', ['exec', c.name, 'sh', '-c',
    `pg_dump -U dbm_work -d ${DB} -Fc -f /tmp/nm20-meta.dump && pg_restore --data-only -n smdb_manager -f - /tmp/nm20-meta.dump`], { timeout: 120000 });
  expect(r.status, String(r.stderr)).toBe(0);
  return r.stdout as Buffer;
};
const withoutKeys = (b: Buffer) => b.toString('utf-8').split('\n').filter(l => !/^\\(un)?restrict /.test(l)).join('\n');

describe.skipIf(process.platform === 'win32' || !dockerRuns)('NM20 part 2: the smdb_manager rows as pg_restore prints them (Linux with docker)', () => {
  let meta: Cluster;

  beforeAll(async () => {
    meta = await provisionedCluster({ name: `${META_ID}-main`, user: U, db: DB, password: PW });
  }, 300000);

  afterAll(() => {
    meta?.remove();
  }, 180000);

  it('the parse reads the real output, its script loads back to the same dump, and planted address rows are skipped', () => {
    ok(meta.psql('dbm_admin', copyGroupEnsureSql(), 'postgres'));
    ok(meta.psql('dbm_meta', raiseSql('main.example', 3)));
    ok(meta.psql('dbm_meta', addressTableSql('main.example', 5433, FIXTURE_PEM.trim(), 'main.example')));
    ok(meta.psql('dbm_meta', `INSERT INTO smdb_manager.handover (slot, machine, generation) VALUES ('smdb_slot_a', 'win.example', 3);
INSERT INTO smdb_manager.received (push_id, from_system_id, from_machine, generation) VALUES ('0123456789abcdef01234567', '7349081263451237', E'm\\tab\\\\x ''q'' \u00e9 \\n\\r end', 2);
INSERT INTO smdb_manager.copies (slot, machine, client) VALUES ('smdb_copy_a', 'copy.example', '172.18.0.5');
INSERT INTO smdb_manager.copies (slot) VALUES ('smdb_copy_b');
INSERT INTO smdb_manager.addresses (host, port, slot, cert, machine) VALUES ('copy.example', 5440, 'smdb_copy_a', ${sqlLiteral(COPY_PEM.trim())}, 'copy \\ ''one''');`));

    const first = metaText(meta);
    console.log(`[nm20-pg] pg_restore --data-only -n smdb_manager -f - printed:\n${first.toString('utf-8')}`);
    const r = parseMetaRows(first, metaCheck);
    expect(r).toMatchObject({ ok: true, counts: { generation: 1, handover: 1, received: 1, copies: 2, addresses: 2 }, skipped: { check: 0, cap: 0 } });
    const script = (r as { script: string }).script;
    expect(script).toContain("'m\tab\\x ''q'' \u00e9 \n\r end'");

    ok(meta.psql('dbm_meta', `BEGIN;
DELETE FROM smdb_manager.generation; DELETE FROM smdb_manager.handover; DELETE FROM smdb_manager.received;
DELETE FROM smdb_manager.copies; DELETE FROM smdb_manager.addresses;
${script}COMMIT;`));
    expect(withoutKeys(metaText(meta))).toBe(withoutKeys(first));

    ok(meta.psql('dbm_meta', `INSERT INTO smdb_manager.addresses (host, port, cert, machine) VALUES ('zero.example', 0, ${sqlLiteral(FIXTURE_PEM.trim())}, 'm');
INSERT INTO smdb_manager.addresses (host, port, cert, machine, updated_at) VALUES ('later.example', 5432, ${sqlLiteral(FIXTURE_PEM.trim())}, 'm', 'infinity');`));
    expect(parseMetaRows(metaText(meta), metaCheck)).toMatchObject({ ok: true, counts: { addresses: 2 }, skipped: { check: 2, cap: 0 } });
  }, 300000);
});

import { connectionReading } from '../../src/instance/fleetReplication';
import { metaPsql } from '../../src/instance/dbLogin';

// NM20 part 3: PG4, PG8, PG10 and PG12. Skipped on Windows and without docker; the main session runs them on Linux.
describe.skipIf(process.platform === 'win32' || !dockerRuns)('NM20 part 3: where provisioning runs, against a real Postgres 16 (Linux with docker)', () => {
  const ID3 = `nm20pg3${process.pid}`;
  const NET3 = `${ID3}-net`;
  const clusters: Cluster[] = [];
  const volumes: string[] = [];
  const work = (c: Cluster, sql: string) => runCall(c.name, workPsql(c.name, DB, sql));
  const target3 = (c: Cluster) => ({ container: c.name, user: U, db: DB, botId: c.name, password: PW as string | null, candidates: [] as string[] });

  beforeAll(() => { docker(['network', 'create', NET3]); });
  afterAll(() => {
    for (const c of clusters) c.remove();
    for (const v of volumes) docker(['volume', 'rm', '-f', v]);
    docker(['network', 'rm', NET3]);
  }, 180000);

  it('PG4 (R9, R3.3 G3) NM13\'s two statements run as dbm_work: connectionReading reads the bot\'s shard_nodes and the reserved places', async () => {
    const c = await provisionedCluster({ name: `${ID3}-pg4`, user: U, db: DB, password: PW, network: NET3 });
    clusters.push(c);
    ok(c.psql(U, `CREATE SCHEMA smdb_data;
CREATE TABLE smdb_data.shard_nodes (node text PRIMARY KEY, restartable boolean NOT NULL, reshard_overlap boolean NOT NULL, seen_at timestamptz NOT NULL);
INSERT INTO smdb_data.shard_nodes VALUES ('a', true, false, now()), ('b', false, false, now()), ('old', true, true, now() - interval '8 days');`));
    const instance = { id: c.name, fleetDb: { containerName: c.name, user: U, db: DB, volume: `${c.name}-data` } } as any;
    expect(await connectionReading(instance)).toEqual({ state: 'read', machines: 2, count: 44, overlap: false, max: 100, reserved: 7, allowed: 93 });
  }, 300000);

  it('PG8 (3.5, R3.5) a copy seeded by pg_basebackup holds dbm_admin with no password; provisionRoles answers in-recovery and writes nothing; the copy\'s manager reads as dbm_admin over the socket', async () => {
    const main = await provisionedCluster({ name: `${ID3}-pg8main`, user: U, db: DB, password: PW, network: NET3 });
    clusters.push(main);
    ok(docker(['exec', main.name, 'sh', '-c', 'echo "host replication dbm_admin samenet trust" >> "$PGDATA/pg_hba.conf"']));
    ok(main.psql('dbm_admin', 'SELECT pg_reload_conf()', 'postgres'));
    const vol = `${ID3}-pg8copy-data`;
    volumes.push(vol);
    ok(docker(['run', '--rm', '--network', NET3, '-v', `${vol}:/var/lib/postgresql/data`, '--entrypoint', 'pg_basebackup', PG_IMAGE,
      '-h', main.name, '-U', 'dbm_admin', '-D', '/var/lib/postgresql/data', '-X', 'stream', '-R', '--checkpoint=fast'], undefined, 300000));
    const copyName = `${ID3}-pg8copy`;
    ok(docker(['run', '-d', '--name', copyName, '--network', NET3, '-v', `${vol}:/var/lib/postgresql/data`, PG_IMAGE, 'postgres', '-c', 'reserved_connections=4']));
    clusters.push({ name: copyName, user: U, db: DB, password: PW, psql: () => ({ status: 1, out: '', err: '' }), remove: () => { docker(['rm', '-f', '-v', copyName]); } });
    let ready = false;
    for (let i = 0; i < 240 && !ready; i++) {
      ready = docker(['exec', copyName, 'pg_isready', '-h', '127.0.0.1', '-q']).status === 0;
      if (!ready) pause(500);
    }
    expect(ready).toBe(true);
    const read = await runCall(copyName, clusterPsql(copyName, "SELECT pg_is_in_recovery()::text || '|' || (SELECT (rolpassword IS NULL)::text FROM pg_authid WHERE rolname = 'dbm_admin')"));
    expect(read.ok, read.ok ? '' : read.error).toBe(true);
    expect(read.stdout.trim()).toBe('true|true');
    resetManagerRoleCache();
    expect(await provisionRoles({ container: copyName, user: U, db: DB, botId: copyName, password: PW, candidates: [] })).toEqual({ ok: false, cls: 'in-recovery' });
    const meta = await runCall(copyName, metaPsql(copyName, DB, "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'smdb_manager'"));
    expect(meta.ok ? meta.stdout.trim() : meta.error).toBe('dbm_meta');
  }, 600000);

  it('PG10 (L6, L7) the bot role revokes CONNECT and sets owner-made database settings; dbm_work is refused until provisionRoles resets them', async () => {
    const c = await provisionedCluster({ name: `${ID3}-pg10`, user: U, db: DB, password: PW, network: NET3 });
    clusters.push(c);
    const meta = (sql: string) => runCall(c.name, metaPsql(c.name, DB, sql));
    expect((await work(c, 'SELECT 1')).ok).toBe(true);
    // L6. has_database_privilege (R3.2 step 1's grants field) counts membership: dbm_work keeps CONNECT through the
    // bot role, which owns the database, so a revoke reaches only dbm_meta.
    ok(c.psql(U, `REVOKE CONNECT, CREATE ON DATABASE ${DB} FROM PUBLIC, dbm_meta, dbm_work;`, 'postgres'));
    const metaRefused = await meta('SELECT 1');
    expect(metaRefused.ok).toBe(false);
    expect(metaRefused.stderr).toMatch(/permission denied for database/);
    expect((await work(c, 'SELECT 1')).ok).toBe(true);
    const granted: any = await provisionRoles(target3(c), { reread: true });
    expect(granted, JSON.stringify(granted)).toEqual({ ok: true, wrote: ['grants'], reserved: 4 });
    const metaBack = await meta('SELECT 1');
    expect(metaBack.ok, metaBack.ok ? '' : metaBack.error).toBe(true);
    // L7: the owner-made settings shut dbm_work out as well.
    ok(c.psql(U, `ALTER DATABASE ${DB} SET statement_timeout = 1;
ALTER DATABASE ${DB} CONNECTION LIMIT 0;
ALTER DATABASE ${DB} ALLOW_CONNECTIONS false;`, 'postgres'));
    const refusedRead = await work(c, 'SELECT 1');
    expect(refusedRead.ok).toBe(false);
    const drift = await runCall(c.name, clusterPsql(c.name, driftReadSql(DB)));
    expect(parseDriftRead(drift.ok ? drift.stdout : '')?.settings).toBe(1);
    const r: any = await provisionRoles(target3(c), { reread: true });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.wrote).toEqual(['database']);
    const back = await work(c, 'SELECT 1');
    expect(back.ok, back.ok ? '' : back.error).toBe(true);
    expect(await checkRolesDrift({ container: c.name, db: DB })).toBe(true);
    expect(await provisionRoles(target3(c), { reread: true })).toEqual({ ok: true, wrote: [], reserved: 4 });
  }, 300000);

  it('PG12 (L1, R3.1) 20 fresh volumes through the start\'s ready loop over 127.0.0.1, then provisionRoles: each ends confirmed with Invariant A', async () => {
    for (let run = 0; run < 20; run++) {
      const name = `${ID3}-pg12-${run}`;
      const vol = `${name}-data`;
      volumes.push(vol);
      ok(docker(['run', '-d', '--name', name, '-v', `${vol}:/var/lib/postgresql/data`, '-e', 'POSTGRES_USER=dbm_admin', '-e', `POSTGRES_PASSWORD=${PW}`,
        '-e', `POSTGRES_DB=${DB}`, PG_IMAGE, 'postgres', '-c', 'reserved_connections=4']));
      try {
        let ready = false;
        for (let i = 0; i < 30 && !ready; i++) {
          ready = docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', U, '-d', DB]).status === 0;
          if (!ready) pause(1000);
        }
        expect(ready, `run ${run}`).toBe(true);
        resetManagerRoleCache();
        const first: any = await provisionRoles({ container: name, user: U, db: DB, botId: name, password: PW, candidates: [] });
        expect(first.ok, `run ${run}: ${JSON.stringify(first)}`).toBe(true);
        expect(await provisionRoles({ container: name, user: U, db: DB, botId: name, password: PW, candidates: [] }, { reread: true }), `run ${run}`).toEqual({ ok: true, wrote: [], reserved: 4 });
      } finally {
        docker(['rm', '-f', '-v', name]);
      }
    }
  }, 1200000);
});
