import { beforeEach, describe, expect, it, vi } from 'vitest';

// NM20 part 1: the three logins' argv, provisionRoles over a psql fake that keeps a model of the cluster, and the compose.
type Call = { args: string[]; input?: string; opts?: any };
type Answer = { err?: boolean; killed?: boolean; stdout?: string; stderr?: string };
const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm20-roles-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    calls: [] as Array<{ args: string[]; input?: string; opts?: any }>,
    answer: (_c: { args: string[]; input?: string }): { err?: boolean; killed?: boolean; stdout?: string; stderr?: string } => ({ stdout: '' }),
    saved: [] as Array<[string, string]>,
    save: 'ok' as 'ok' | 'throw' | 'null',
  };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/docker/processStart', () => {
  const { EventEmitter } = require('events') as typeof import('events');
  const { PassThrough } = require('stream') as typeof import('stream');
  return {
    execFileGuarded: (cmd: string, args: string[], opts: any, cb: (e: any, out: string, err: string) => void) => {
      const call = { args: [cmd, ...args], opts };
      h.calls.push(call);
      const a = h.answer(call);
      setImmediate(() => cb(a.err || a.killed ? Object.assign(new Error('exit 1'), { killed: !!a.killed, code: 1 }) : null, a.stdout ?? '', a.stderr ?? ''));
    },
    startProcess: (cmd: string, args: string[]) => {
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      const stdin = new PassThrough();
      let input = '';
      stdin.on('data', (d: Buffer) => { input += d.toString(); });
      stdin.on('finish', () => {
        const call = { args: [cmd, ...args], input };
        h.calls.push(call);
        const a = h.answer(call);
        setImmediate(() => {
          if (a.stdout) child.stdout.emit('data', a.stdout);
          if (a.stderr) child.stderr.emit('data', a.stderr);
          child.emit('close', a.err ? 1 : 0);
        });
      });
      child.stdin = stdin;
      return { child };
    },
  };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  updateInstanceFleetDbPassword: (botId: string, password: string) => {
    h.saved.push([botId, password]);
    if (h.save === 'throw') throw new Error('the registry could not be saved (disk full)');
    return h.save === 'null' ? null : ({ id: botId } as any);
  },
}));

import * as dbLogin from '../../src/instance/dbLogin';
import {
  MANAGER_DB_ROLE, MANAGER_SESSION_OPTIONS, argvFor, botRoleRefusal, checkRolesDrift, clusterPsql, ensureManagerDbRole, metaPsql,
  noteLoginFault, parseDriftRead, parseRolesRead, provisionRoles, readAdminVerifier, resetManagerRoleCache, runCall, workArgs, workPsql,
} from '../../src/instance/dbLogin';
import { scramSha256Verifier, verifierAccepts } from '../../src/config/secretText';
import { addFleetPostgresReplicaService, addFleetPostgresService } from '../../src/templates/pcsProcessing';
import { parseDocument } from 'yaml';

const C = 'b1-fleet-postgres';
const U = 'smdb';
const DB = 'smdb';
const PW = 'record-pw-1234';
const QUIET = "SET log_min_error_statement = panic;\nSET log_statement = 'none';\nSET log_min_duration_statement = -1;\n";
const ALL_NEEDS = ['dbm_meta>pg_read_all_stats', 'dbm_meta>pg_use_reserved_connections', `dbm_work>${U}`, 'dbm_work>pg_use_reserved_connections'];

// The cluster the fake answers for, changed by the statements the scripts send.
type Cluster = {
  recovery: boolean; bot: 'missing' | 'plain' | 'rights'; botFirst: boolean; dbExists: boolean; ownedByBot: boolean;
  adminPw: boolean; adminPath: boolean; meta: 'missing' | 'ok' | 'bad'; work: 'missing' | 'ok' | 'bad';
  members: string[]; needs: string[]; dbset: string[]; grants: string[]; reserved: number;
  schemaOwner: string; schemaGrants: string[]; adminVerifier: string | null; botVerifier: string | null;
};
const newVolume = (): Cluster => ({
  recovery: false, bot: 'missing', botFirst: false, dbExists: true, ownedByBot: false, adminPw: true, adminPath: false,
  meta: 'missing', work: 'missing', members: [], needs: [...ALL_NEEDS], dbset: [], grants: ['meta-connect', 'meta-create', 'work-connect'],
  reserved: 4, schemaOwner: '', schemaGrants: [], adminVerifier: scramSha256Verifier(PW), botVerifier: null,
});
const setUp = (): Cluster => ({
  ...newVolume(), bot: 'plain', ownedByBot: true, adminPw: false, adminPath: true, meta: 'ok', work: 'ok', needs: [], grants: [],
  schemaOwner: 'dbm_meta', adminVerifier: null,
});

const list = (xs: string[]) => (xs.length ? xs.join(',') : 'ok');
const readLine = (s: Cluster) => [
  String(s.recovery), s.bot === 'missing' ? 'missing' : String(s.bot === 'rights'), String(s.botFirst),
  !s.dbExists ? 'nodb' : s.bot === 'missing' ? 'other' : String(s.ownedByBot), String(s.adminPw), String(s.adminPath),
  s.meta, s.work, list(s.members), list(s.needs), list(s.dbset), list(s.grants), String(s.reserved),
].join('|');

const sqlOf = (c: Call) => c.input ?? c.args[c.args.length - 1];
const loginOf = (c: Call) => c.args[c.args.indexOf('-U') + 1];
const isRead = (c: Call) => sqlOf(c).includes('pg_is_in_recovery()');
const isSchemaRead = (c: Call) => sqlOf(c).includes("'owner|'");
const isVerifierRead = (c: Call) => sqlOf(c).includes("'v|'");
const isDriftRead = (c: Call) => sqlOf(c).includes("'drift|'");

let cl: Cluster;
let fail: (c: Call) => string | undefined;
let reply: (c: Call) => string | undefined;

function apply(c: Call): void {
  for (const raw of sqlOf(c).split(/;\n/)) {
    const s = raw.trim();
    let m: RegExpExecArray | null;
    if (/^CREATE ROLE dbm_(meta|work) /.test(s) || /^ALTER ROLE dbm_(meta|work) LOGIN /.test(s)) {
      const which = /dbm_(meta|work)/.exec(s)![1] as 'meta' | 'work';
      cl[which] = 'ok';
      if (s.endsWith(' IN ROLE pg_read_all_stats')) cl.needs = cl.needs.filter(x => x !== 'dbm_meta>pg_read_all_stats');
    } else if (s === 'ALTER ROLE dbm_admin SET search_path = pg_catalog, pg_temp') cl.adminPath = true;
    else if (s === `ALTER DATABASE "${DB}" IS_TEMPLATE false`) cl.dbset = cl.dbset.filter(x => x !== 'template');
    else if (s === `ALTER DATABASE "${DB}" ALLOW_CONNECTIONS true`) cl.dbset = cl.dbset.filter(x => x !== 'noconn');
    else if (s === `ALTER DATABASE "${DB}" CONNECTION LIMIT -1`) cl.dbset = cl.dbset.filter(x => x !== 'limit');
    else if (s === `ALTER DATABASE "${DB}" RESET ALL`) cl.dbset = cl.dbset.filter(x => x !== 'settings');
    else if (s === `GRANT CONNECT, CREATE ON DATABASE "${DB}" TO dbm_meta`) cl.grants = cl.grants.filter(x => !x.startsWith('meta-'));
    else if (s === `GRANT CONNECT ON DATABASE "${DB}" TO dbm_work`) cl.grants = cl.grants.filter(x => x !== 'work-connect');
    else if (s.startsWith('CREATE SCHEMA IF NOT EXISTS smdb_manager')) { if (!cl.schemaOwner) cl.schemaOwner = 'dbm_meta'; cl.schemaGrants = []; }
    else if ((m = /^CREATE ROLE "([a-z_]+)" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '([^']+)'$/.exec(s))) { cl.bot = 'plain'; cl.botVerifier = m[2]; }
    else if (s === `ALTER ROLE "${U}" NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`) cl.bot = 'plain';
    else if ((m = /^REVOKE "([a-z_]+)" FROM "([a-z_]+)"$/.exec(s))) { const pair = `${m[2]}>${m[1]}`; cl.members = cl.members.filter(x => x !== pair); }
    else if ((m = /^GRANT "([a-z_]+)" TO "([a-z_]+)"$/.exec(s))) { const pair = `${m[2]}>${m[1]}`; cl.needs = cl.needs.filter(x => x !== pair); }
    else if (s === `ALTER DATABASE "${DB}" OWNER TO "${U}"`) cl.ownedByBot = true;
    else if (s === 'ALTER ROLE dbm_admin PASSWORD NULL') { cl.adminPw = false; cl.adminVerifier = null; }
  }
}

function answer(c: Call): Answer {
  const f = fail(c);
  if (f !== undefined) return { err: true, stderr: f };
  const r = reply(c);
  if (r !== undefined) return { stdout: r };
  if (isRead(c)) return { stdout: `${readLine(cl)}\n` };
  if (isSchemaRead(c)) return { stdout: `owner|${cl.schemaOwner}|${list(cl.schemaGrants)}\n` };
  if (isVerifierRead(c)) return { stdout: cl.adminVerifier === null ? 'v|\n' : `v|${cl.adminVerifier}\n` };
  if (isDriftRead(c)) return { stdout: 'drift|0|0|0\n' };
  apply(c);
  return { stdout: '' };
}

const writes = () => h.calls.filter(c => !isRead(c) && !isSchemaRead(c) && !isVerifierRead(c) && !isDriftRead(c));
const target = (over: Partial<Parameters<typeof provisionRoles>[0]> = {}) => ({ container: C, user: U, db: DB, botId: 'b1', password: PW as string | null, candidates: [] as string[], ...over });

beforeEach(() => {
  h.calls = [];
  h.saved = [];
  h.save = 'ok';
  cl = newVolume();
  fail = () => undefined;
  reply = () => undefined;
  h.answer = answer;
  resetManagerRoleCache();
});

describe('the argv builders (R3.3, U2 part 1, X2, Y7)', () => {
  it('MANAGER_SESSION_OPTIONS is X2 string with row_security off (Y7)', () => {
    expect(MANAGER_SESSION_OPTIONS).toBe('-c search_path=pg_catalog,pg_temp -c lock_timeout=0 -c statement_timeout=0 -c idle_in_transaction_session_timeout=0 -c idle_session_timeout=0 -c tcp_keepalives_idle=0 -c tcp_keepalives_interval=0 -c tcp_keepalives_count=0 -c tcp_user_timeout=0 -c TimeZone=UTC -c DateStyle=ISO,MDY -c IntervalStyle=postgres -c extra_float_digits=1 -c bytea_output=hex -c client_encoding=UTF8 -c timezone_abbreviations=Default -c lc_numeric=C -c lc_monetary=C -c lc_time=C -c xmloption=content -c standard_conforming_strings=on -c backslash_quote=safe_encoding -c array_nulls=on -c quote_all_identifiers=off -c transform_null_equals=off -c row_security=off -c restrict_nonsystem_relation_kind= -c gin_fuzzy_search_limit=0 -c local_preload_libraries= -c client_min_messages=notice -c exit_on_error=off -c default_transaction_isolation=read\\ committed -c default_transaction_deferrable=off -c default_tablespace= -c temp_tablespaces= -c default_table_access_method=heap -c synchronous_commit=on -c stats_fetch_consistency=cache -c plpgsql.extra_errors=none -c plpgsql.extra_warnings=none -c plpgsql.check_asserts=on -c plpgsql.print_strict_params=off');
  });

  const PIN = `PGOPTIONS=${MANAGER_SESSION_OPTIONS}`;
  const PIN_EXEMPT = `PGOPTIONS=${MANAGER_SESSION_OPTIONS} -c default_transaction_read_only=off`;

  it('clusterPsql: dbm_admin on postgres with no pins; the fence exemption only when asked', () => {
    expect(clusterPsql(C, 'SELECT 1').args).toEqual(['exec', C, 'psql', '-X', '-U', 'dbm_admin', '-d', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT 1']);
    expect(clusterPsql(C, 'SELECT 1', { exempt: true }).args).toEqual(['exec', '-e', 'PGOPTIONS=-c default_transaction_read_only=off', C, 'psql', '-X', '-U', 'dbm_admin', '-d', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT 1']);
    const script = clusterPsql(C, 'ALTER ROLE x LOGIN;', { stdin: true });
    expect(script.args).toEqual(['exec', '-i', C, 'psql', '-X', '-U', 'dbm_admin', '-d', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1']);
    expect(script.input).toBe('ALTER ROLE x LOGIN;');
  });

  it('metaPsql and workPsql carry the pins in one argv element; the exemption only when asked', () => {
    expect(metaPsql(C, DB, 'SELECT 1').args).toEqual(['exec', '-e', PIN, C, 'psql', '-X', '-U', 'dbm_meta', '-d', DB, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT 1']);
    expect(workPsql(C, DB, 'SELECT 1').args).toEqual(['exec', '-e', PIN, C, 'psql', '-X', '-U', 'dbm_work', '-d', DB, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT 1']);
    expect(metaPsql(C, DB, 'SELECT 1', { exempt: true }).args[2]).toBe(PIN_EXEMPT);
    expect(workPsql(C, DB, 'X', { exempt: true, stdin: true })).toMatchObject({ args: ['exec', '-e', PIN_EXEMPT, '-i', C, 'psql', '-X', '-U', 'dbm_work', '-d', DB, '-tA', '-v', 'ON_ERROR_STOP=1'], input: 'X' });
  });

  it('workArgs for psql, pg_dump and pg_restore', () => {
    expect(workArgs(C, DB, 'pg_dump', ['-Fc'])).toEqual(['exec', '-e', PIN, C, 'pg_dump', '-U', 'dbm_work', '-d', DB, '-Fc']);
    expect(workArgs(C, DB, 'pg_restore', ['--no-owner'], { exempt: true, stdin: true })).toEqual(['exec', '-e', PIN_EXEMPT, '-i', C, 'pg_restore', '-U', 'dbm_work', '-d', DB, '--no-owner']);
    expect(workArgs(C, DB, 'psql', ['-c', 'SELECT 1'])).toEqual(['exec', '-e', PIN, C, 'psql', '-X', '-U', 'dbm_work', '-d', DB, '-c', 'SELECT 1']);
  });

  it('argvFor pins the receive logins too, and dbm_admin never', () => {
    for (const login of ['dbm_meta', 'dbm_work', 'smdb_receive', 'smdb_receive_meta'] as const) {
      expect(argvFor(login, DB)).toEqual({ env: ['-e', PIN], conn: ['-U', login, '-d', DB] });
      expect(argvFor(login, DB, { exempt: true }).env).toEqual(['-e', PIN_EXEMPT]);
    }
    expect(argvFor('dbm_admin', 'postgres')).toEqual({ env: [], conn: ['-U', 'dbm_admin', '-d', 'postgres'] });
  });

  it('NM26: no non-superuser login is given plpgsql.variable_conflict, which only a superuser may set', () => {
    for (const login of ['dbm_meta', 'dbm_work', 'smdb_receive', 'smdb_receive_meta'] as const) {
      expect(argvFor(login, DB).env.join(' ')).not.toContain('variable_conflict');
      expect(argvFor(login, DB, { exempt: true }).env.join(' ')).not.toContain('variable_conflict');
    }
  });

  it('G1: a dbm_admin argv for any database but postgres throws, so no docker call is made', () => {
    expect(() => argvFor('dbm_admin', DB)).toThrow('cluster login asked for database smdb');
    expect(() => argvFor('dbm_admin', 'template1', { exempt: true })).toThrow('cluster login asked for database template1');
    expect(h.calls).toEqual([]);
  });
});

describe('ensureManagerDbRole checks only (3.3)', () => {
  const MISSING = 'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  role "dbm_admin" does not exist';
  it('a missing dbm_admin runs no CREATE and answers ROLE-MISSING', async () => {
    h.answer = () => ({ err: true, stderr: MISSING });
    expect(await ensureManagerDbRole({ container: C, user: U })).toEqual({
      ok: false, cls: 'missing-role',
      error: "the role dbm_admin does not exist in this database's cluster; the manager creates it only as the first role of a database it creates",
    });
    expect(h.calls.map(c => [loginOf(c), sqlOf(c)])).toEqual([['dbm_admin', 'SELECT rolsuper::text FROM pg_roles WHERE rolname = current_user']]);
  });
  // Part 6 removed asManager (R3.3): the row drives the same check-only answer through readBotLogin.
  it('a read on a missing role runs once, never as the bot role, and logs nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.answer = () => ({ err: true, stderr: MISSING });
    const r = await dbLogin.readBotLogin({ container: C, user: U });
    expect(r).toMatchObject({ ok: false, cls: 'missing-role' });
    expect(h.calls.map(c => loginOf(c))).toEqual(['dbm_admin']);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('S11: botRoleRefusal refuses the manager role names', () => {
  it.each(['dbm_admin', 'dbm_meta', 'dbm_work', 'smdb_join', 'smdb_copies', 'smdb_minter', 'smdb_receive', 'smdb_receive_meta'])('%s', name => {
    expect(botRoleRefusal(name)).toBe(`The app's database role name ${name} cannot be used by the maintenance tool (it must be a plain lower-case name other than dbm_admin, dbm_meta, dbm_work, smdb_join, smdb_copies, smdb_minter, smdb_receive and smdb_receive_meta, and must not start with smdb_copy_); nothing was changed`);
  });
  it('a plain name passes', () => {
    expect(botRoleRefusal('smdb')).toBeNull();
    expect(botRoleRefusal('smdb_receive_x')).toBeNull();
  });
});

describe('parseRolesRead (section 9 property)', () => {
  const valid = 'false|false|false|true|false|true|ok|ok|ok|ok|ok|ok|4';
  it('reads every field of a valid line', () => {
    expect(parseRolesRead(`${valid}\n`)).toEqual({
      recovery: false, botRights: false, botFirst: false, owner: 'true', adminPassword: false, adminPath: true,
      meta: 'ok', work: 'ok', members: [], needs: [], dbSettings: [], dbGrants: [], reserved: 4,
    });
    expect(parseRolesRead('true|missing|false|other|true|false|missing|bad|smdb>dbm_admin,x>dbm_meta|dbm_work>smdb|template,settings|meta-create,work-connect|0')).toEqual({
      recovery: true, botRights: null, botFirst: false, owner: 'other', adminPassword: true, adminPath: false,
      meta: 'missing', work: 'bad', members: ['smdb>dbm_admin', 'x>dbm_meta'], needs: ['dbm_work>smdb'],
      dbSettings: ['template', 'settings'], dbGrants: ['meta-create', 'work-connect'], reserved: 0,
    });
  });

  it('owner other only with the role missing, and a missing role owns nothing', () => {
    expect(parseRolesRead('false|false|false|other|false|true|ok|ok|ok|ok|ok|ok|4')).toBeNull();
    expect(parseRolesRead('false|missing|false|true|false|true|ok|ok|ok|ok|ok|ok|4')).toBeNull();
    expect(parseRolesRead('false|missing|false|nodb|false|true|ok|ok|ok|ok|ok|ok|4')).not.toBeNull();
  });

  // A seeded generator in place of fast-check, which this repo's test folder does not install.
  const seed = Number(process.env.SMDB_TEST_SEED) || 20261113;
  function rng(s: number) {
    return () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  it(`any change of a valid line's shape reads null (seed ${seed})`, () => {
    const r = rng(seed);
    const alphabet = 'truefalsmigokbd|,>_0123456789 \n-';
    const fields = valid.split('|');
    let checked = 0;
    for (let i = 0; i < 3000; i++) {
      const parts = [...fields];
      const k = Math.floor(r() * parts.length);
      const mode = Math.floor(r() * 4);
      if (mode === 0) parts.splice(k, 1);
      else if (mode === 1) parts.splice(k, 0, parts[k]);
      else {
        let junk = '';
        const n = 1 + Math.floor(r() * 6);
        for (let j = 0; j < n; j++) junk += alphabet[Math.floor(r() * alphabet.length)];
        parts[k] = mode === 2 ? junk : parts[k] + junk;
      }
      const line = parts.join('|');
      const parsed = parseRolesRead(line);
      if (parsed === null) continue;
      // A changed line that still parses must be a valid line in its own right: re-serialise it and compare.
      const back = [
        parsed.recovery, parsed.botRights === null ? 'missing' : parsed.botRights, parsed.botFirst, parsed.owner, parsed.adminPassword,
        parsed.adminPath, parsed.meta, parsed.work, list(parsed.members), list(parsed.needs), list(parsed.dbSettings), list(parsed.dbGrants), parsed.reserved,
      ].join('|');
      expect(back, line).toBe(line.replace(/\n$/, ''));
      checked++;
    }
    expect(checked).toBeLessThan(3000);
  });

  it.each([
    ['', 'empty'],
    ['false|false|false|true|false|true|ok|ok|ok|ok|ok|ok', 'twelve fields'],
    ['false|false|false|true|false|true|ok|ok|ok|ok|ok|ok|4|x', 'fourteen fields'],
    ['False|false|false|true|false|true|ok|ok|ok|ok|ok|ok|4', 'a capital'],
    ['false|false|false|true|false|true|ok|ok|smdb>dbm admin|ok|ok|ok|4', 'a pair with a space'],
    ['false|false|false|true|false|true|ok|ok|smdb>"x"|ok|ok|ok|4', 'a quoted name'],
    ['false|false|false|true|false|true|ok|ok|ok|ok|template,template|ok|4', 'a repeated item'],
    ['false|false|false|true|false|true|ok|ok|ok|ok|other|ok|4', 'an unknown setting'],
    ['false|false|false|true|false|true|ok|ok|ok|ok|ok|work-create|4', 'an unknown grant'],
    ['false|false|false|true|false|true|ok|ok|ok|ok|ok|ok|-1', 'a negative count'],
    ['false|false|false|true|false|true|ok|maybe|ok|ok|ok|ok|4', 'a login state'],
  ])('%s reads null (%s)', line => expect(parseRolesRead(line)).toBeNull());
});

describe('provisionRoles O1 (C1 to C19)', () => {
  it('C1: a name the manager cannot use runs nothing', async () => {
    expect(await provisionRoles(target({ db: 'Smdb' }))).toEqual({ ok: false, cls: 'other', error: 'the database name Smdb cannot be used by the manager (it must be a plain lower-case name)' });
    expect(await provisionRoles(target({ user: 'dbm_work' }))).toEqual({ ok: false, cls: 'other', error: botRoleRefusal('dbm_work') });
    expect(h.calls).toEqual([]);
  });

  it('C17: a new volume: every step runs in order, wrote lists exactly what ran, the container is confirmed', async () => {
    const r = await provisionRoles(target());
    expect(r).toEqual({ ok: true, wrote: ['meta', 'work', 'search_path', 'grants', 'schema', 'role', 'members', 'owner', 'password'], reserved: 4 });
    const seq = h.calls.map(c => [loginOf(c), isRead(c) ? 'read' : isSchemaRead(c) ? 'schema-read' : c.input !== undefined ? 'script' : sqlOf(c)]);
    expect(seq).toEqual([
      ['dbm_admin', 'read'], ['dbm_admin', 'script'], ['dbm_meta', 'schema-read'], ['dbm_meta', 'script'], ['dbm_admin', 'script'],
      ['dbm_admin', 'script'], ['dbm_admin', 'ALTER ROLE dbm_admin PASSWORD NULL'], ['dbm_admin', 'read'], ['dbm_meta', 'schema-read'],
    ]);
    const scripts = h.calls.filter(c => c.input !== undefined).map(c => c.input);
    expect(scripts[0]).toBe(`${QUIET}CREATE ROLE dbm_meta LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS VALID UNTIL '-infinity' IN ROLE pg_read_all_stats;
ALTER ROLE dbm_meta SET search_path = pg_catalog, pg_temp;
CREATE ROLE dbm_work LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS VALID UNTIL '-infinity';
ALTER ROLE dbm_work SET search_path = pg_catalog, pg_temp;
ALTER ROLE dbm_admin SET search_path = pg_catalog, pg_temp;
GRANT CONNECT, CREATE ON DATABASE "smdb" TO dbm_meta;
GRANT CONNECT ON DATABASE "smdb" TO dbm_work;
`);
    expect(scripts[1]).toBe(`CREATE SCHEMA IF NOT EXISTS smdb_manager;
GRANT USAGE ON SCHEMA smdb_manager TO PUBLIC, dbm_work;
GRANT SELECT ON ALL TABLES IN SCHEMA smdb_manager TO dbm_work;
ALTER DEFAULT PRIVILEGES IN SCHEMA smdb_manager GRANT SELECT ON TABLES TO dbm_work;
`);
    expect(scripts[2]).toMatch(new RegExp(`^${QUIET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}CREATE ROLE "smdb" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'SCRAM-SHA-256\\$4096:[^']+';\\n$`));
    expect(scripts[3]).toBe(`GRANT "pg_use_reserved_connections" TO "dbm_meta";
GRANT "smdb" TO "dbm_work";
GRANT "pg_use_reserved_connections" TO "dbm_work";
ALTER DATABASE "smdb" OWNER TO "smdb";
`);
    expect(await verifierAccepts(cl.botVerifier!, PW, U)).toBe(true);
    expect(h.calls.filter(c => c.input === undefined).some(c => c.args.join(' ').includes('SCRAM') || c.args.join(' ').includes(PW))).toBe(false);
    expect(h.saved).toEqual([]);
    h.calls = [];
    expect(await provisionRoles(target())).toEqual({ ok: true, wrote: [] });
    expect(h.calls).toEqual([]);
  });

  it('C2 and C3: the confirmed set answers with no call until a manager restart empties it', async () => {
    cl = setUp();
    await provisionRoles(target());
    h.calls = [];
    expect(await provisionRoles(target())).toEqual({ ok: true, wrote: [] });
    expect(h.calls).toEqual([]);
    resetManagerRoleCache();
    expect(await provisionRoles(target())).toEqual({ ok: true, wrote: [], reserved: 4 });
    expect(h.calls.length).toBeGreaterThan(0);
  });

  it('C19: a call that rereads a set-up cluster writes nothing', async () => {
    cl = setUp();
    expect(await provisionRoles(target())).toEqual({ ok: true, wrote: [], reserved: 4 });
    h.calls = [];
    expect(await provisionRoles(target(), { reread: true })).toEqual({ ok: true, wrote: [], reserved: 4 });
    expect(writes()).toEqual([]);
    expect(h.calls.map(c => isRead(c) ? 'read' : isSchemaRead(c) ? 'schema-read' : 'other')).toEqual(['read', 'schema-read', 'read', 'schema-read']);
  });

  it('C4: the read fails: PV-STEP for reading the roles', async () => {
    fail = c => (isRead(c) ? 'psql: error: some failure\nFATAL:  the database system is starting up' : undefined);
    expect(await provisionRoles(target())).toEqual({ ok: false, cls: 'other', error: 'reading the roles failed (FATAL:  the database system is starting up)' });
  });

  it('C4: a read killed by the timeout says docker did not answer', async () => {
    h.answer = () => ({ killed: true });
    expect(await provisionRoles(target())).toEqual({ ok: false, cls: 'other', error: 'reading the roles failed (docker did not answer within 30 s)' });
  });

  it('C5: an unparsable read answers PV-READ with its first 200 characters', async () => {
    const junk = `x${'y'.repeat(300)}`;
    reply = c => (isRead(c) ? `${junk}\n` : undefined);
    expect(await provisionRoles(target())).toEqual({ ok: false, cls: 'other', error: `the database's roles read back as ${junk.slice(0, 200)}` });
    expect(writes()).toEqual([]);
  });

  it('C6: a database in recovery answers in-recovery, writes nothing and confirms nothing', async () => {
    cl.recovery = true;
    expect(await provisionRoles(target())).toEqual({ ok: false, cls: 'in-recovery' });
    expect(writes()).toEqual([]);
    h.calls = [];
    await provisionRoles(target());
    expect(h.calls.length).toBe(1);
  });

  it('C7: the bot role as the first role answers PV-FIRST and writes nothing', async () => {
    cl = { ...setUp(), botFirst: true, bot: 'rights' };
    expect(await provisionRoles(target())).toEqual({
      ok: false, cls: 'other',
      error: "the bot's role smdb is this database's first role, which Postgres keeps a superuser; a database the manager creates now starts with dbm_admin as its first role, so the bot's role gets less than superuser rights only on a new install",
    });
    expect(writes()).toEqual([]);
  });

  it('C8: no database answers PV-DB', async () => {
    cl.dbExists = false;
    expect(await provisionRoles(target())).toEqual({ ok: false, cls: 'other', error: 'the database smdb does not exist in this container' });
    expect(writes()).toEqual([]);
  });

  it('C9: the schema step fails: PV-STEP with its name, and nothing past it runs', async () => {
    fail = c => (loginOf(c) === 'dbm_meta' && c.input !== undefined ? 'ERROR:  permission denied for database smdb' : undefined);
    expect(await provisionRoles(target())).toEqual({ ok: false, cls: 'other', error: 'creating the schema smdb_manager as dbm_meta failed (ERROR:  permission denied for database smdb)' });
    expect(writes().map(loginOf)).toEqual(['dbm_admin', 'dbm_meta']);
  });

  it('C10: a schema of another owner answers PV-SCHEMA (gatekeeper ruling 1) and runs no schema script', async () => {
    cl.schemaOwner = 'smdb';
    expect(await provisionRoles(target())).toEqual({ ok: false, cls: 'other', error: 'the schema smdb_manager in smdb belongs to smdb, not dbm_meta' });
    expect(writes().filter(c => loginOf(c) === 'dbm_meta')).toEqual([]);
  });

  it('C11: a schema made before a crash is found; the schema script runs only for missing grants', async () => {
    cl = { ...setUp(), schemaOwner: 'dbm_meta' };
    expect(await provisionRoles(target())).toEqual({ ok: true, wrote: [], reserved: 4 });
    resetManagerRoleCache();
    cl.schemaGrants = ['work-select'];
    expect(await provisionRoles(target())).toEqual({ ok: true, wrote: ['schema'], reserved: 4 });
  });

  it('C12 and V4: no password on record and no URL candidate: PV-NOPASS, no role, nothing recorded', async () => {
    const NOPASS = "the role smdb does not exist, and no password is on record that this database was created with (a Database URL naming this database with its password records it), so the manager cannot create it";
    expect(await provisionRoles(target({ password: null }))).toEqual({ ok: false, cls: 'other', error: NOPASS });
    expect(await provisionRoles(target({ password: '' }))).toEqual({ ok: false, cls: 'other', error: NOPASS });
    expect(await provisionRoles(target({ password: null, candidates: ['outside-url-pw'] }))).toEqual({ ok: false, cls: 'other', error: NOPASS });
    cl.adminPw = false;
    cl.adminVerifier = null;
    h.calls = [];
    expect(await provisionRoles(target({ password: null, candidates: [PW] }))).toEqual({ ok: false, cls: 'other', error: NOPASS });
    expect(h.calls.some(isVerifierRead)).toBe(false);
    expect(cl.bot).toBe('missing');
    expect(h.saved).toEqual([]);
    expect(h.calls.some(c => sqlOf(c).includes('CREATE ROLE "smdb"'))).toBe(false);
  });

  it('C13: the CREATE ROLE fails: PV-STEP with the password and the verifier redacted', async () => {
    fail = c => {
      const m = /PASSWORD '([^']+)'/.exec(sqlOf(c));
      return m ? `ERROR:  could not set ${m[1]} for ${PW}` : undefined;
    };
    const r: any = await provisionRoles(target());
    expect(r).toEqual({ ok: false, cls: 'other', error: 'creating the role smdb failed (ERROR:  could not set *** for ***)' });
  });

  it('C13: a password outside ASCII answers the verifier error as PV-STEP, with no CREATE sent', async () => {
    const r = await provisionRoles(target({ password: 'pässwort-1' }));
    expect(r).toEqual({ ok: false, cls: 'other', error: 'creating the role smdb failed (the password has characters outside ASCII, which the manager cannot set as a SCRAM verifier)' });
    expect(h.calls.some(c => sqlOf(c).includes('CREATE ROLE "smdb"'))).toBe(false);
  });

  it('C14 and V5: a role made before a crash: the next call gives the database to it and creates nothing', async () => {
    cl = { ...newVolume(), bot: 'plain', meta: 'ok', work: 'ok', adminPath: true, grants: [], schemaOwner: 'dbm_meta', needs: [`dbm_work>${U}`, 'dbm_work>pg_use_reserved_connections', 'dbm_meta>pg_use_reserved_connections'] };
    const r: any = await provisionRoles(target());
    expect(r).toEqual({ ok: true, wrote: ['members', 'owner', 'password'], reserved: 4 });
    expect(h.calls.some(c => sqlOf(c).includes('CREATE ROLE'))).toBe(false);
  });

  it.each([
    ['script 1', (c: Call) => c.input?.includes('CREATE ROLE dbm_meta'), 'setting up dbm_meta, dbm_work and the settings of smdb failed (ERROR:  boom)'],
    ['script 2', (c: Call) => c.input?.includes('OWNER TO'), 'setting the role memberships and giving smdb to smdb failed (ERROR:  boom)'],
    ['the password', (c: Call) => sqlOf(c) === 'ALTER ROLE dbm_admin PASSWORD NULL', "removing dbm_admin's password failed (ERROR:  boom)"],
  ])('C15: %s fails: PV-STEP with its name', async (_n, which, error) => {
    fail = c => (which(c) ? 'ERROR:  boom' : undefined);
    expect(await provisionRoles(target())).toEqual({ ok: false, cls: 'other', error });
  });

  it('C15: the attributes ALTER fails: PV-STEP removing superuser rights', async () => {
    cl = { ...setUp(), bot: 'rights' };
    fail = c => (sqlOf(c).startsWith(`ALTER ROLE "${U}" NOSUPERUSER`) ? 'ERROR:  boom' : undefined);
    expect(await provisionRoles(target())).toEqual({ ok: false, cls: 'other', error: 'removing superuser rights from smdb failed (ERROR:  boom)' });
  });

  it('C16: a part applied: the next call asks only for the rest', async () => {
    fail = c => (c.input?.includes('OWNER TO') ? 'ERROR:  lost' : undefined);
    expect((await provisionRoles(target())).ok).toBe(false);
    fail = () => undefined;
    h.calls = [];
    expect(await provisionRoles(target())).toEqual({ ok: true, wrote: ['members', 'owner', 'password'], reserved: 4 });
    expect(h.calls.filter(c => c.input !== undefined).map(loginOf)).toEqual(['dbm_admin']);
  });

  it('C16: a set-up cluster with only an owner-made database setting runs only the reset', async () => {
    cl = { ...setUp(), dbset: ['noconn', 'settings'] };
    expect(await provisionRoles(target())).toEqual({ ok: true, wrote: ['database'], reserved: 4 });
    expect(h.calls.filter(c => c.input !== undefined).map(c => c.input)).toEqual([`${QUIET}ALTER DATABASE "smdb" ALLOW_CONNECTIONS true;\nALTER DATABASE "smdb" RESET ALL;\n`]);
  });

  it('C16: the bot role with rights is altered, never with LOGIN or NOLOGIN', async () => {
    cl = { ...setUp(), bot: 'rights' };
    expect(await provisionRoles(target())).toEqual({ ok: true, wrote: ['attributes'], reserved: 4 });
    expect(writes().map(sqlOf)).toEqual([`ALTER ROLE "${U}" NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`]);
  });

  const confirmFields: Array<[string, (s: Cluster) => void, string]> = [
    ['rights', s => { s.bot = 'rights'; }, 'the role smdb still has rights beyond its database'],
    ['missing role', s => { s.bot = 'missing'; }, 'the role smdb does not exist'],
    ['owner', s => { s.ownedByBot = false; }, 'smdb does not belong to smdb'],
    ['admin password', s => { s.adminPw = true; }, 'dbm_admin still has a password'],
    ['admin path', s => { s.adminPath = false; }, "dbm_admin's search_path is not set"],
    ['meta', s => { s.meta = 'bad'; }, 'dbm_meta is not a plain login'],
    ['work', s => { s.work = 'missing'; }, 'dbm_work is not a plain login'],
    ['members', s => { s.members = ['smdb>dbm_admin', 'x>dbm_work']; }, 'a role membership the manager does not allow remains (smdb>dbm_admin, x>dbm_work)'],
    ['needs', s => { s.needs = [`dbm_work>${U}`]; }, 'a role membership the manager needs is missing (dbm_work>smdb)'],
    ['settings', s => { s.dbset = ['limit']; }, 'smdb still has an owner-made setting (limit)'],
    ['grants', s => { s.grants = ['work-connect']; }, 'smdb does not grant work-connect'],
    ['schema grants', s => { s.schemaGrants = ['work-usage']; }, 'smdb does not grant work-usage'],
  ];
  it.each(confirmFields)('C18: the confirm read finds %s not as wanted: PV-CONFIRM names it, nothing confirmed', async (_n, spoil, field) => {
    cl = setUp();
    let reads = 0;
    reply = c => {
      if (!isRead(c) && !isSchemaRead(c)) return undefined;
      if (isRead(c)) reads++;
      if (reads < 2) return undefined;
      const s = { ...cl };
      spoil(s);
      return isRead(c) ? `${readLine(s)}\n` : `owner|${s.schemaOwner}|${list(s.schemaGrants)}\n`;
    };
    expect(await provisionRoles(target(), { reread: true })).toEqual({ ok: false, cls: 'other', error: `the roles did not read back as set (${field})` });
    reply = () => undefined;
    h.calls = [];
    await provisionRoles(target());
    expect(h.calls.length).toBeGreaterThan(0);
  });

  it('C18: a schema owner changed before the confirm answers PV-SCHEMA', async () => {
    cl = setUp();
    let n = 0;
    reply = c => (isSchemaRead(c) && n++ > 0 ? 'owner|smdb|ok\n' : undefined);
    expect(await provisionRoles(target())).toEqual({ ok: false, cls: 'other', error: 'the schema smdb_manager in smdb belongs to smdb, not dbm_meta' });
  });
});

describe('V1 to V5: where a new role takes its password (R3.2 step 6, S7, S10)', () => {
  it('V1: the record password: created with it, nothing recorded', async () => {
    expect((await provisionRoles(target())).ok).toBe(true);
    expect(await verifierAccepts(cl.botVerifier!, PW, U)).toBe(true);
    expect(h.saved).toEqual([]);
    expect(h.calls.some(isVerifierRead)).toBe(false);
  });

  it('V2 and S7: no record password, the URL candidate dbm_admin accepts: created, recorded, then dbm_admin password removed', async () => {
    const r = await provisionRoles(target({ password: null, candidates: ['outside-pw', PW] }));
    expect(r).toEqual({ ok: true, wrote: ['meta', 'work', 'search_path', 'grants', 'schema', 'role', 'recorded', 'members', 'owner', 'password'], reserved: 4 });
    expect(h.saved).toEqual([['b1', PW]]);
    expect(await verifierAccepts(cl.botVerifier!, PW, U)).toBe(true);
    const verifierRead = h.calls.find(isVerifierRead)!;
    expect(verifierRead.args).toEqual(['docker', 'exec', C, 'psql', '-X', '-U', 'dbm_admin', '-d', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1', '-c',
      "SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM pg_authid WHERE rolname = 'dbm_admin') THEN 'missing' ELSE 'v|' || coalesce((SELECT rolpassword FROM pg_authid WHERE rolname = 'dbm_admin'), '') END"]);
  });

  it('S7: readAdminVerifier reads dbm_admin without the bot role check', async () => {
    expect(await readAdminVerifier(C)).toEqual({ ok: true, verifier: cl.adminVerifier });
    cl.adminVerifier = null;
    expect(await readAdminVerifier(C)).toEqual({ ok: false, why: 'the database keeps no SCRAM-SHA-256 password for dbm_admin' });
  });

  it.each([
    ['throw', 'the registry could not be saved (disk full)'],
    ['null', "the bot's record is no longer in the registry"],
  ] as const)('V3: the record save fails (%s): PV-UNSAVED, the role exists, dbm_admin keeps its password', async (mode, why) => {
    h.save = mode;
    const r = await provisionRoles(target({ password: null, candidates: [PW] }));
    expect(r).toEqual({ ok: false, cls: 'other', error: `the role smdb was created, but its password could not be recorded (${why}); it is recorded at the next check` });
    expect(cl.bot).toBe('plain');
    expect(cl.adminPw).toBe(true);
    expect(h.calls.some(c => sqlOf(c) === 'ALTER ROLE dbm_admin PASSWORD NULL')).toBe(false);
  });

  const removesAdminPassword = () => h.calls.some(c => sqlOf(c) === 'ALTER ROLE dbm_admin PASSWORD NULL');

  it('A2, V3: the next pass after PV-UNSAVED, the record still without the password, leaves dbm_admin its password and confirms nothing', async () => {
    h.save = 'throw';
    expect((await provisionRoles(target({ password: null, candidates: [PW] }))).ok).toBe(false);
    h.save = 'ok';
    h.calls = [];
    expect(await provisionRoles(target({ password: null, candidates: [PW] }))).toEqual({ ok: true, wrote: ['members', 'owner'], reserved: 4 });
    expect(removesAdminPassword()).toBe(false);
    expect(cl.adminPw).toBe(true);
    expect(dbLogin.isRolesConfirmed(C)).toBe(false);
  });

  it('A2, V3: once the record holds the password, the next call runs step 8 and confirms', async () => {
    h.save = 'null';
    await provisionRoles(target({ password: null, candidates: [PW] }));
    h.save = 'ok';
    await provisionRoles(target({ password: null, candidates: [PW] }));
    h.calls = [];
    expect(await provisionRoles(target())).toEqual({ ok: true, wrote: ['password'], reserved: 4 });
    expect(removesAdminPassword()).toBe(true);
    expect(cl.adminPw).toBe(false);
    expect(dbLogin.isRolesConfirmed(C)).toBe(true);
  });

  it('A4-1: the record changed while the role was created: nothing recorded, dbm_admin keeps its password', async () => {
    let asked = 0;
    const r = await provisionRoles(target({ password: null, candidates: [PW], recordUnchanged: () => { asked++; return false; } }));
    expect(r).toEqual({ ok: false, cls: 'other', error: `the role ${U} was created, but the bot's database record changed while it was set up, so its password was not recorded; the next check reads the new record` });
    expect(asked).toBe(1);
    expect(h.saved).toEqual([]);
    expect(cl.bot).toBe('plain');
    expect(cl.adminPw).toBe(true);
  });

  it('A4-1: a record that did not change is written as before', async () => {
    const r = await provisionRoles(target({ password: null, candidates: [PW], recordUnchanged: () => true }));
    expect(r.ok).toBe(true);
    expect(h.saved).toEqual([['b1', PW]]);
  });

  it('a verifier with more iterations than the manager checks refuses with its reason', async () => {
    cl.adminVerifier = scramSha256Verifier(PW, undefined, 200000);
    expect(await provisionRoles(target({ password: null, candidates: [PW] }))).toEqual({
      ok: false, cls: 'other',
      error: "reading dbm_admin's password verifier failed (the database's SCRAM-SHA-256 password for dbm_admin uses 200000 iterations, more than the 100000 the manager checks)",
    });
  });
});

describe('L8 to L10: memberships the manager does not allow are revoked (S9)', () => {
  it.each([
    ['L8 the bot role in dbm_admin', ['smdb>dbm_admin'], 'REVOKE "dbm_admin" FROM "smdb";\n'],
    ['L9 a member of dbm_admin and a stray member of dbm_meta', ['other>dbm_admin', 'other>dbm_meta'], 'REVOKE "dbm_admin" FROM "other";\nREVOKE "dbm_meta" FROM "other";\n'],
    ['L10 the bot role in pg_execute_server_program and smdb_receive_x in dbm_admin', ['smdb>pg_execute_server_program', 'smdb_receive_x>dbm_admin'], 'REVOKE "pg_execute_server_program" FROM "smdb";\nREVOKE "dbm_admin" FROM "smdb_receive_x";\n'],
  ])('%s', async (_n, members, script) => {
    cl = { ...setUp(), members: [...members] };
    expect(await provisionRoles(target())).toEqual({ ok: true, wrote: ['members'], reserved: 4 });
    expect(h.calls.filter(c => c.input !== undefined).map(c => c.input)).toEqual([script]);
    expect(cl.members).toEqual([]);
  });
});

describe('U5: a failed step is PV-STEP whatever psql class', () => {
  it('a read-only transaction under a kept write fence is PV-STEP, not in-recovery', async () => {
    cl = { ...setUp(), dbset: ['settings'] };
    fail = c => (c.input !== undefined ? 'ERROR:  cannot execute ALTER ROLE in a read-only transaction' : undefined);
    expect(await provisionRoles(target())).toEqual({ ok: false, cls: 'other', error: 'setting up dbm_meta, dbm_work and the settings of smdb failed (ERROR:  cannot execute ALTER ROLE in a read-only transaction)' });
  });
});

describe('U2: the drift read and the failure rule', () => {
  it('parseDriftRead reads each count and nothing else', () => {
    expect(parseDriftRead('drift|0|0|0\n')).toEqual({ settings: 0, loginSettings: 0, logins: 0 });
    expect(parseDriftRead('drift|1|2|3')).toEqual({ settings: 1, loginSettings: 2, logins: 3 });
    for (const bad of ['', 'drift|0|0', 'drift|0|0|0|0', 'drift|a|0|0', '0|0|0', 'drift|-1|0|0', 'drift|0|0|0\nx']) expect(parseDriftRead(bad)).toBeNull();
  });

  it('the drift read runs as dbm_admin on postgres and names the bot database', async () => {
    await checkRolesDrift({ container: C, db: DB });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].args.slice(0, 9)).toEqual(['docker', 'exec', C, 'psql', '-X', '-U', 'dbm_admin', '-d', 'postgres']);
    expect(sqlOf(h.calls[0])).toContain("d.datname = 'smdb'");
  });

  it.each([
    ['W2 dbm_work set statement_timeout for itself', 'drift|0|1|0\n', { err: false }],
    ['W1 dbm_work set its own password', 'drift|0|0|1\n', { err: false }],
    ['W9 the bot role set a database default', 'drift|1|0|0\n', { err: false }],
    ['an unparsable answer', 'garbled\n', { err: false }],
    ['a failed call', '', { err: true }],
  ])('%s: the container leaves the confirmed set', async (_n, out, how) => {
    cl = setUp();
    await provisionRoles(target());
    expect(dbLogin.isRolesConfirmed(C)).toBe(true);
    reply = c => (isDriftRead(c) && !how.err ? out : undefined);
    fail = c => (isDriftRead(c) && how.err ? 'FATAL:  the database system is shutting down' : undefined);
    expect(await checkRolesDrift({ container: C, db: DB })).toBe(false);
    expect(dbLogin.isRolesConfirmed(C)).toBe(false);
  });

  it('a clean drift read keeps the container confirmed', async () => {
    cl = setUp();
    await provisionRoles(target());
    expect(await checkRolesDrift({ container: C, db: DB })).toBe(true);
    expect(dbLogin.isRolesConfirmed(C)).toBe(true);
  });

  it('W1 (U3): the planted password reads bad, and the provisioning the drift starts removes it', async () => {
    cl = { ...setUp(), work: 'bad' };
    expect(await provisionRoles(target())).toEqual({ ok: true, wrote: ['work', 'search_path'], reserved: 4 });
    expect(h.calls.filter(c => c.input !== undefined).map(c => c.input)).toEqual([`${QUIET}ALTER ROLE dbm_work LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD NULL VALID UNTIL '-infinity';
DO $$DECLARE d text; BEGIN FOR d IN SELECT db.datname FROM pg_catalog.pg_db_role_setting s JOIN pg_catalog.pg_database db ON db.oid = s.setdatabase WHERE s.setrole = 'dbm_work'::regrole LOOP EXECUTE pg_catalog.format('ALTER ROLE dbm_work IN DATABASE %I RESET ALL', d); END LOOP; END $$;
ALTER ROLE dbm_work RESET ALL;
ALTER ROLE dbm_work SET search_path = pg_catalog, pg_temp;
`]);
  });

  it('noteLoginFault on a failure with any message drops the container, so the next provisioning reads', async () => {
    cl = setUp();
    await provisionRoles(target());
    reply = c => undefined;
    fail = c => (loginOf(c) === 'dbm_work' ? 'ERROR:  some message no list names' : undefined);
    const r = await runCall(C, workPsql(C, DB, 'SELECT 1'));
    expect(r).toMatchObject({ ok: false, error: 'ERROR:  some message no list names' });
    expect(dbLogin.isRolesConfirmed(C)).toBe(false);
    cl = setUp();
    await provisionRoles(target());
    noteLoginFault(C);
    h.calls = [];
    await provisionRoles(target());
    expect(h.calls.length).toBeGreaterThan(0);
  });

  it('a failed dbm_admin call leaves the confirmed set alone', async () => {
    cl = setUp();
    await provisionRoles(target());
    fail = () => 'ERROR:  boom';
    expect((await runCall(C, clusterPsql(C, 'SELECT 1'))).ok).toBe(false);
    expect(dbLogin.isRolesConfirmed(C)).toBe(true);
  });

  it('forgetManagerRole clears the confirmed set for a container', async () => {
    cl = setUp();
    await provisionRoles(target());
    dbLogin.forgetManagerRole(C);
    expect(dbLogin.isRolesConfirmed(C)).toBe(false);
  });
});

describe('the compose (3.1, S8)', () => {
  const bot = { id: 'b1', displayName: 'Bot One', sanitizedName: 'bot1' } as any;
  const base = 'services:\n  app:\n    image: example/app:1\n';
  const services = (content: string) => (parseDocument(content).toJSON() as any).services;
  it('the database starts with dbm_admin as its first role, the bot password, and reserved_connections=4', () => {
    const svc = services(addFleetPostgresService(base, bot, { containerName: 'pg', volume: 'v', password: 'p', user: 'u', db: 'd' }))['fleet-postgres'];
    expect(svc.environment).toEqual({ POSTGRES_USER: 'dbm_admin', POSTGRES_DB: 'd', POSTGRES_PASSWORD: 'p', POSTGRES_INITDB_ARGS: '--data-checksums' });
    expect(svc.environment.POSTGRES_USER).toBe(MANAGER_DB_ROLE);
    expect(svc.command).toEqual(['postgres', '-c', 'reserved_connections=4']);
    expect(svc.healthcheck.test).toEqual(['CMD-SHELL', 'pg_isready -U u -d d']);
  });
  it('the live copy service has no POSTGRES_ key and the same command', () => {
    const svc = services(addFleetPostgresReplicaService(base, bot, { containerName: 'pgr', volume: 'vr', hostPort: 15432 }))['fleet-postgres-replica'];
    expect(svc.environment).toBeUndefined();
    expect(svc.command).toEqual(['postgres', '-c', 'reserved_connections=4']);
  });
});
