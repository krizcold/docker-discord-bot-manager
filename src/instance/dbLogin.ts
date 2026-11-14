/**
 * The manager's logins to a managed Postgres container and the bot role's login (blocked, opened, read back). The
 * manager's superuser MANAGER_DB_ROLE is the first role of the bot's managed database and has no password: it logs in
 * over the container's local socket, to the postgres database only, so a bot role with NOLOGIN never locks the
 * manager out. In the bot's database the manager logs in as two plain logins, dbm_meta for smdb_manager and dbm_work
 * for the bot's data. provisionRoles sets up the bot role, both logins and the database's own settings.
 */
import { execFileGuarded, startProcess } from '../docker/processStart';
import { feedStdin } from '../docker/childStdin';
import * as containerManager from '../docker/containerManager';
import { QUIET_ROLE_SESSION_SQL, childFailureText, redactSecrets, scramSha256Verifier, verifierAccepts } from '../config/secretText';
import { REPLICATION_ROLE } from './fleetReplication';
import { FENCE_OWNER_FILE_SQL, parseFenceOwner } from './fleetBackupGuards';

export const MANAGER_DB_ROLE = 'dbm_admin';
export const META_LOGIN = 'dbm_meta';
export const WORK_LOGIN = 'dbm_work';
export const RECEIVE_LOGINS = ['smdb_receive', 'smdb_receive_meta'] as const;
export type ReceiveLogin = (typeof RECEIVE_LOGINS)[number];
export type ManagerLogin = typeof MANAGER_DB_ROLE | typeof META_LOGIN | typeof WORK_LOGIN | ReceiveLogin;

const PSQL_TIMEOUT_MS = 30_000;

export interface DbTarget { container: string; user: string }
export interface BotLogin { inRecovery: boolean; canLogin: boolean | null; sessions: number }
export type PsqlClass = 'missing-role' | 'refused-login' | 'recovery' | 'write-fence' | 'other';
export type DbFailure = { ok: false; cls: PsqlClass; error: string };
export type DbResult = { ok: true } | DbFailure;

const PLAIN_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** The R14 refusal for a bot role name the tool cannot use, or null. */
export function botRoleRefusal(user: string): string | null {
  const taken: string[] = [MANAGER_DB_ROLE, META_LOGIN, WORK_LOGIN, REPLICATION_ROLE, ...RECEIVE_LOGINS];
  if (PLAIN_NAME.test(user) && !taken.includes(user)) return null;
  return `The app's database role name ${user} cannot be used by the maintenance tool (it must be a plain lower-case name other than ${taken.slice(0, -1).join(', ')} and ${taken[taken.length - 1]}); nothing was changed`;
}

/** Exactly `<recovery>|<canlogin or missing>|<sessions>`; anything else is null, so a garbled answer never reads as blocked. */
export function parseBotLogin(out: string): BotLogin | null {
  const m = /^(true|false)\|(true|false|missing)\|(\d+)$/.exec(out.replace(/\n$/, ''));
  if (!m) return null;
  return { inRecovery: m[1] === 'true', canLogin: m[2] === 'missing' ? null : m[2] === 'true', sessions: Number(m[3]) };
}

export function psqlFailureClass(stderr: string): PsqlClass {
  if (/role "[^"]*" does not exist/.test(stderr) && stderr.includes(`"${MANAGER_DB_ROLE}"`)) return 'missing-role';
  if (stderr.includes('is not permitted to log in')) return 'refused-login';
  if (stderr.includes('read-only transaction') || stderr.includes('cannot execute ALTER ROLE')) return 'recovery';
  return 'other';
}

function lastLine(text: string): string {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  return lines[lines.length - 1] || 'psql failed with no message';
}

/**
 * The session options of every plain login's call: a database or role setting the bot role makes cannot change what
 * a manager call reads, writes, formats or waits for. The fence's read-only default is left out on purpose.
 */
export const MANAGER_SESSION_OPTIONS = '-c search_path=pg_catalog,pg_temp -c lock_timeout=0 -c statement_timeout=0 -c idle_in_transaction_session_timeout=0 -c idle_session_timeout=0 -c tcp_keepalives_idle=0 -c tcp_keepalives_interval=0 -c tcp_keepalives_count=0 -c tcp_user_timeout=0 -c TimeZone=UTC -c DateStyle=ISO,MDY -c IntervalStyle=postgres -c extra_float_digits=1 -c bytea_output=hex -c client_encoding=UTF8 -c timezone_abbreviations=Default -c lc_numeric=C -c lc_monetary=C -c lc_time=C -c xmloption=content -c standard_conforming_strings=on -c backslash_quote=safe_encoding -c array_nulls=on -c quote_all_identifiers=off -c transform_null_equals=off -c row_security=off -c restrict_nonsystem_relation_kind= -c gin_fuzzy_search_limit=0 -c local_preload_libraries= -c client_min_messages=notice -c exit_on_error=off -c default_transaction_isolation=read\\ committed -c default_transaction_deferrable=off -c default_tablespace= -c temp_tablespaces= -c default_table_access_method=heap -c synchronous_commit=on -c stats_fetch_consistency=cache -c plpgsql.variable_conflict=error -c plpgsql.extra_errors=none -c plpgsql.extra_warnings=none -c plpgsql.check_asserts=on -c plpgsql.print_strict_params=off';

const FENCE_EXEMPT_OPTION = '-c default_transaction_read_only=off';

/** The session option a lane's own write runs under while a write fence holds the read-only default. */
const FENCE_EXEMPT = ['-e', `PGOPTIONS=${FENCE_EXEMPT_OPTION}`];

/** A3's reset of the bot's database, as the superuser on postgres: step 4's database statements and grants. */
export function databaseResetSql(db: string): string {
  const d = `"${db.replace(/"/g, '""')}"`;
  return `ALTER DATABASE ${d} IS_TEMPLATE false;
ALTER DATABASE ${d} ALLOW_CONNECTIONS true;
ALTER DATABASE ${d} CONNECTION LIMIT -1;
ALTER DATABASE ${d} RESET ALL;
GRANT CONNECT, CREATE ON DATABASE ${d} TO ${META_LOGIN};
GRANT CONNECT ON DATABASE ${d} TO ${WORK_LOGIN};
`;
}

export interface CallOpts { exempt?: boolean; stdin?: boolean }
/** A docker argv (without `docker`) and, for a script, the SQL it reads on stdin. */
export interface PsqlCall { login: ManagerLogin; args: string[]; input?: string }

/**
 * The docker exec environment and the login of one manager call. The superuser connects only to the postgres
 * database; every other login carries MANAGER_SESSION_OPTIONS.
 */
export function argvFor(login: ManagerLogin, db: string, opts: { exempt?: boolean } = {}): { env: string[]; conn: string[] } {
  if (login === MANAGER_DB_ROLE) {
    if (db !== 'postgres') throw new Error(`cluster login asked for database ${db}`);
    return { env: opts.exempt ? [...FENCE_EXEMPT] : [], conn: ['-U', login, '-d', db] };
  }
  return { env: ['-e', `PGOPTIONS=${MANAGER_SESSION_OPTIONS}${opts.exempt ? ` ${FENCE_EXEMPT_OPTION}` : ''}`], conn: ['-U', login, '-d', db] };
}

function psqlCall(login: ManagerLogin, container: string, db: string, sql: string, opts: CallOpts): PsqlCall {
  const { env, conn } = argvFor(login, db, opts);
  const head = ['exec', ...env, ...(opts.stdin ? ['-i'] : []), container, 'psql', ...conn, '-tA', '-v', 'ON_ERROR_STOP=1'];
  return opts.stdin ? { login, args: head, input: sql } : { login, args: [...head, '-c', sql] };
}

/** psql as the superuser on the postgres database. */
export function clusterPsql(container: string, sql: string, opts: CallOpts = {}): PsqlCall {
  return psqlCall(MANAGER_DB_ROLE, container, 'postgres', sql, opts);
}

/** psql as dbm_meta in the bot's database, for smdb_manager. */
export function metaPsql(container: string, db: string, sql: string, opts: CallOpts = {}): PsqlCall {
  return psqlCall(META_LOGIN, container, db, sql, opts);
}

/** psql as dbm_work in the bot's database, for the bot's data. */
export function workPsql(container: string, db: string, sql: string, opts: CallOpts = {}): PsqlCall {
  return psqlCall(WORK_LOGIN, container, db, sql, opts);
}

/** psql as a receive login over the container's socket, in the bot's database: the end of a Receive. */
export function receivePsql(login: ReceiveLogin, container: string, db: string, sql: string, opts: CallOpts = {}): PsqlCall {
  return psqlCall(login, container, db, sql, opts);
}

/** A client tool as dbm_work in the bot's database; `args` follow the login. */
export function workArgs(container: string, db: string, tool: 'psql' | 'pg_dump' | 'pg_restore', args: string[], opts: CallOpts = {}): string[] {
  const { env, conn } = argvFor(WORK_LOGIN, db, opts);
  return ['exec', ...env, ...(opts.stdin ? ['-i'] : []), container, tool, ...conn, ...args];
}

export type CallResult = { ok: true; stdout: string; stderr: string } | { ok: false; stdout: string; stderr: string; error: string };

/** Runs a call; a failed call of a plain login drops the container from the confirmed set (noteLoginFault). */
export function runCall(container: string, call: PsqlCall, timeoutMs = PSQL_TIMEOUT_MS): Promise<CallResult> {
  return new Promise(resolve => {
    const done = (ok: boolean, stdout: string, stderr: string, timedOut: boolean, startError?: string) => {
      if (ok) return resolve({ ok: true, stdout, stderr });
      if (call.login === META_LOGIN || call.login === WORK_LOGIN) noteLoginFault(container);
      const text = stderr || (timedOut ? `docker did not answer within ${timeoutMs / 1000} s` : startError || 'docker exec failed');
      resolve({ ok: false, stdout, stderr: text, error: lastLine(text) });
    };
    if (call.input === undefined) {
      execFileGuarded('docker', call.args, { timeout: timeoutMs }, (err, stdout, stderr) => {
        done(!err, String(stdout ?? ''), String(stderr ?? ''), !!err?.killed, err ? childFailureText('', err) : undefined);
      });
      return;
    }
    const started = startProcess('docker', call.args);
    if (!started.child) return done(false, '', '', false, started.error);
    const child = started.child;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    const finish = (code: number | null, startError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(code === 0 && !timedOut, stdout, stderr, timedOut, startError);
    };
    child.stdout?.on('data', d => { stdout += d; });
    child.stderr?.on('data', d => { stderr += d; });
    child.on('error', err => finish(null, err.message));
    child.on('close', code => finish(code));
    feedStdin(child.stdin, call.input);
  });
}

/** psql as the superuser on the postgres database, its failure classed. */
function managerPsql(container: string, sql: string, exempt = false): Promise<{ ok: true; stdout: string } | DbFailure> {
  return new Promise(resolve => {
    execFileGuarded('docker', clusterPsql(container, sql, { exempt }).args, { timeout: PSQL_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (!err) return resolve({ ok: true, stdout: String(stdout) });
      const text = String(stderr || '') || (err.killed ? `docker did not answer within ${PSQL_TIMEOUT_MS / 1000} s` : err.message);
      const cls = psqlFailureClass(text);
      if (cls === 'missing-role') managerRoleReady.delete(container);
      resolve({ ok: false, cls, error: lastLine(text) });
    });
  });
}

function refused(t: DbTarget): DbFailure | null {
  const why = botRoleRefusal(t.user);
  return why ? { ok: false, cls: 'other', error: why } : null;
}

const SUPER_CHECK_SQL = 'SELECT rolsuper::text FROM pg_roles WHERE rolname = current_user';
const managerRoleReady = new Set<string>();
/** Containers whose roles provisionRoles confirmed in this process. */
const rolesConfirmed = new Set<string>();

export function resetManagerRoleCache(): void {
  managerRoleReady.clear();
  rolesConfirmed.clear();
}

/** Drops what the manager knows of a container's role, for a container that is removed or recreated. */
export function forgetManagerRole(container: string): void {
  managerRoleReady.delete(container);
  rolesConfirmed.delete(container);
}

/** A failed dbm_meta or dbm_work call, or a database a push replaced: the next start or maintenance pass provisions the container again. */
export function noteLoginFault(container: string): void {
  rolesConfirmed.delete(container);
}

export function isRolesConfirmed(container: string): boolean {
  return rolesConfirmed.has(container);
}

export function isMissingManagerRole(text: string): boolean {
  return psqlFailureClass(text) === 'missing-role';
}

async function checkManagerRole(container: string): Promise<DbResult> {
  const check = await managerPsql(container, SUPER_CHECK_SQL);
  if (!check.ok) return check;
  if (check.stdout.trim() !== 'true') return { ok: false, cls: 'other', error: `the role ${MANAGER_DB_ROLE} exists but is not a superuser` };
  return { ok: true };
}

/** Confirms the manager's own superuser role exists in this container. */
export async function ensureManagerDbRole(t: DbTarget): Promise<DbResult> {
  const bad = refused(t);
  if (bad) return bad;
  if (managerRoleReady.has(t.container)) return { ok: true };
  const check = await checkManagerRole(t.container);
  if (!check.ok && check.cls === 'missing-role') {
    return { ok: false, cls: 'missing-role', error: `the role ${MANAGER_DB_ROLE} does not exist in this database's cluster; the manager creates it only as the first role of a database it creates` };
  }
  if (check.ok) managerRoleReady.add(t.container);
  return check;
}

function readSql(user: string): string {
  return `SELECT pg_is_in_recovery()::text || '|' || coalesce((SELECT rolcanlogin::text FROM pg_roles WHERE rolname = '${user}'), 'missing') || '|' || (SELECT count(*) FROM pg_stat_activity WHERE usename = '${user}' AND backend_type = 'client backend')::text`;
}

export async function readBotLogin(t: DbTarget): Promise<{ ok: true; login: BotLogin } | DbFailure> {
  const bad = refused(t);
  if (bad) return bad;
  const read = await managerPsql(t.container, readSql(t.user));
  if (!read.ok) return read;
  const login = parseBotLogin(read.stdout);
  if (!login) return { ok: false, cls: 'other', error: `the login read answered something unexpected (${lastLine(read.stdout)})` };
  return { ok: true, login };
}

function verifierSql(user: string): string {
  return `SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM pg_authid WHERE rolname = '${user}') THEN 'missing' ELSE 'v|' || coalesce((SELECT rolpassword FROM pg_authid WHERE rolname = '${user}'), '') END`;
}

function parseVerifier(user: string, stdout: string): { ok: true; verifier: string } | { ok: false; why: string } {
  const out = stdout.trim();
  if (out === 'missing') return { ok: false, why: `the role ${user} does not exist in the database` };
  if (out.startsWith('v|SCRAM-SHA-256$')) return { ok: true, verifier: out.slice(2) };
  return { ok: false, why: `the database keeps no SCRAM-SHA-256 password for ${user}` };
}

/** The SCRAM verifier the database keeps for the bot role, read as the manager's role; never logged or shown. */
export async function readRoleVerifier(t: DbTarget): Promise<{ ok: true; verifier: string } | { ok: false; why: string }> {
  const bad = botRoleRefusal(t.user);
  if (bad) return { ok: false, why: bad };
  const read = await managerPsql(t.container, verifierSql(t.user));
  if (!read.ok) return { ok: false, why: read.error };
  return parseVerifier(t.user, read.stdout);
}

/** The verifier of the manager's own role, which initdb set from the compose's POSTGRES_PASSWORD; never logged or shown. */
export async function readAdminVerifier(container: string): Promise<{ ok: true; verifier: string } | { ok: false; why: string }> {
  const read = await runCall(container, clusterPsql(container, verifierSql(MANAGER_DB_ROLE)));
  if (!read.ok) return { ok: false, why: read.error };
  return parseVerifier(MANAGER_DB_ROLE, read.stdout);
}

async function alterLogin(t: DbTarget, login: boolean): Promise<DbResult> {
  const bad = refused(t);
  if (bad) return bad;
  const read = await readBotLogin(t);
  if (!read.ok) return read;
  if (read.login.inRecovery) return { ok: false, cls: 'recovery', error: 'the database is in recovery' };
  const alter = await managerPsql(t.container, `ALTER ROLE "${t.user}" ${login ? 'LOGIN' : 'NOLOGIN'}`, !login);
  if (alter.ok) return { ok: true };
  return alter.cls === 'recovery' ? { ...alter, cls: 'write-fence' } : alter;
}

/** The block passes a write fence, so a fenced database can still be put into maintenance; the open does not. */
export function blockBotLogin(t: DbTarget): Promise<DbResult> {
  return alterLogin(t, false);
}

/**
 * The read-only layer on: the lane its owner file names (null: none), and whether its setting is saved in the
 * configuration (false: a restart clears it; null: either could not be read).
 */
export type WriteFenceOn = { ok: true; on: true; owner: string | null; persisted: boolean | null };

const FENCE_OWNER_READ_SQL = `SELECT ${FENCE_OWNER_FILE_SQL} || '|' || (SELECT count(*) FROM pg_file_settings WHERE name = 'default_transaction_read_only')`;

/** Whether the read-only default is on, read in a session that is not exempt from it, and when on, whose it is. */
export async function readWriteFence(t: DbTarget): Promise<{ ok: true; on: false } | WriteFenceOn | DbFailure> {
  const bad = refused(t);
  if (bad) return bad;
  const read = await managerPsql(t.container, "SELECT current_setting('default_transaction_read_only')");
  if (!read.ok) return read;
  const value = read.stdout.trim();
  if (value !== 'on' && value !== 'off') return { ok: false, cls: 'other', error: `the read-only setting read back as ${lastLine(read.stdout)}` };
  if (value === 'off') return { ok: true, on: false };
  const who = await managerPsql(t.container, FENCE_OWNER_READ_SQL);
  const m = who.ok ? /^([^|\n]*)\|(\d+)$/.exec(who.stdout.trim()) : null;
  return { ok: true, on: true, owner: m ? parseFenceOwner(m[1]) : null, persisted: m ? Number(m[2]) > 0 : null };
}

export function openBotLogin(t: DbTarget): Promise<DbResult> {
  return alterLogin(t, true);
}

/** Ends the bot role's sessions, never the manager's own: three rounds with a recount after each. */
export async function endBotSessions(t: DbTarget, pauseMs = 1000): Promise<{ ok: true } | (DbFailure & { left?: number })> {
  const bad = refused(t);
  if (bad) return bad;
  const sql = `SELECT count(*) FROM (SELECT pg_terminate_backend(pid, 5000) FROM pg_stat_activity WHERE usename = '${t.user}' AND backend_type = 'client backend' AND pid <> pg_backend_pid()) t`;
  let left = 0;
  for (let round = 0; round < 3; round++) {
    const term = await managerPsql(t.container, sql);
    if (!term.ok) return term;
    if (pauseMs > 0) await new Promise(resolve => setTimeout(resolve, pauseMs));
    const read = await readBotLogin(t);
    if (!read.ok) return read;
    left = read.login.sessions;
    if (left === 0) return { ok: true };
  }
  return { ok: false, cls: 'other', left, error: `${left} session(s) left after three rounds` };
}

/** One line of the cluster read; a missing role owns nothing, so `owner` is `other` only then. */
export interface RolesRead {
  recovery: boolean;
  /** Whether the bot role has any of the five attributes; null when the role does not exist. */
  botRights: boolean | null;
  botFirst: boolean;
  owner: 'true' | 'false' | 'other' | 'nodb';
  adminPassword: boolean;
  adminPath: boolean;
  meta: 'missing' | 'ok' | 'bad';
  work: 'missing' | 'ok' | 'bad';
  /** `<member>><role>` rows R2 does not allow. */
  members: string[];
  /** `<member>><role>` rows R2 needs that are missing. */
  needs: string[];
  dbSettings: string[];
  dbGrants: string[];
  reserved: number;
}

const PLAIN_ATTRS = 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';
const PINNED_PATH = 'search_path=pg_catalog, pg_temp';
const DB_SETTING_KEYS = ['template', 'noconn', 'limit', 'settings'];
const DB_GRANT_KEYS = ['meta-connect', 'meta-create', 'work-connect'];
const SCHEMA_GRANT_KEYS = ['public-usage', 'work-usage', 'work-select'];

function allowedMembers(user: string): string[] {
  return [`${META_LOGIN}>pg_read_all_stats`, `${META_LOGIN}>pg_use_reserved_connections`, `${WORK_LOGIN}>${user}`, `${WORK_LOGIN}>pg_use_reserved_connections`,
    `smdb_receive>${WORK_LOGIN}`, `smdb_receive_meta>${META_LOGIN}`, `smdb_receive_meta>${user}`];
}

function neededMembers(user: string): string[] {
  return [`${META_LOGIN}>pg_read_all_stats`, `${META_LOGIN}>pg_use_reserved_connections`, `${WORK_LOGIN}>${user}`, `${WORK_LOGIN}>pg_use_reserved_connections`];
}

const quoteList = (xs: string[]) => xs.map(x => `'${x}'`).join(', ');

function loginStateSql(login: string): string {
  return `coalesce((SELECT CASE WHEN a.rolsuper OR a.rolcreatedb OR a.rolcreaterole OR a.rolreplication OR a.rolbypassrls OR NOT a.rolcanlogin
    OR a.rolpassword IS NOT NULL OR a.rolvaliduntil IS DISTINCT FROM '-infinity'::timestamptz
    OR (SELECT count(*) FROM pg_catalog.pg_db_role_setting s WHERE s.setrole = a.oid) <> 1
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s WHERE s.setrole = a.oid AND s.setdatabase = 0 AND s.setconfig = ARRAY['${PINNED_PATH}']::text[])
    THEN 'bad' ELSE 'ok' END FROM pg_catalog.pg_authid a WHERE a.rolname = '${login}'), 'missing')`;
}

const PAIR_SQL = "pg_catalog.pg_get_userbyid(m.member)::text || '>' || pg_catalog.pg_get_userbyid(m.roleid)::text";

function grantedSql(login: string, privilege: string, db: string): string {
  return `coalesce((SELECT pg_catalog.has_database_privilege('${login}', '${db}', '${privilege}') WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${login}') AND EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = '${db}')), false)`;
}

/** The cluster read of provisionRoles, as the superuser on postgres; `user` and `db` are plain names. */
export function rolesReadSql(user: string, db: string): string {
  const four = quoteList([user, MANAGER_DB_ROLE, META_LOGIN, WORK_LOGIN]);
  return `SELECT pg_catalog.concat_ws('|',
  pg_catalog.pg_is_in_recovery()::text,
  coalesce((SELECT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)::text FROM pg_catalog.pg_roles WHERE rolname = '${user}'), 'missing'),
  coalesce((SELECT (oid = 10)::text FROM pg_catalog.pg_roles WHERE rolname = '${user}'), 'false'),
  coalesce((SELECT (d.datdba = r.oid)::text FROM pg_catalog.pg_database d, pg_catalog.pg_roles r WHERE d.datname = '${db}' AND r.rolname = '${user}'), (SELECT 'other' FROM pg_catalog.pg_database WHERE datname = '${db}'), 'nodb'),
  (SELECT (rolpassword IS NOT NULL)::text FROM pg_catalog.pg_authid WHERE rolname = '${MANAGER_DB_ROLE}'),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s WHERE s.setrole = '${MANAGER_DB_ROLE}'::regrole AND s.setdatabase = 0 AND '${PINNED_PATH}' = ANY (s.setconfig)))::text,
  ${loginStateSql(META_LOGIN)},
  ${loginStateSql(WORK_LOGIN)},
  coalesce((SELECT pg_catalog.string_agg(DISTINCT p, ',' ORDER BY p) FROM (SELECT ${PAIR_SQL} AS p FROM pg_catalog.pg_auth_members m
    WHERE pg_catalog.pg_get_userbyid(m.member) IN (${four}) OR pg_catalog.pg_get_userbyid(m.roleid) IN (${four})) q
    WHERE p NOT IN (${quoteList(allowedMembers(user))})), 'ok'),
  coalesce((SELECT pg_catalog.string_agg(v.p, ',' ORDER BY v.n) FROM (VALUES ${neededMembers(user).map((p, i) => `(${i}, '${p}')`).join(', ')}) v(n, p)
    WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE ${PAIR_SQL} = v.p)), 'ok'),
  coalesce((SELECT nullif(pg_catalog.concat_ws(',',
    CASE WHEN d.datistemplate THEN 'template' END,
    CASE WHEN NOT d.datallowconn THEN 'noconn' END,
    CASE WHEN d.datconnlimit <> -1 THEN 'limit' END,
    CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s WHERE s.setrole = 0 AND s.setdatabase = d.oid) THEN 'settings' END), '')
    FROM pg_catalog.pg_database d WHERE d.datname = '${db}'), 'ok'),
  coalesce(nullif(pg_catalog.concat_ws(',',
    CASE WHEN NOT ${grantedSql(META_LOGIN, 'CONNECT', db)} THEN 'meta-connect' END,
    CASE WHEN NOT ${grantedSql(META_LOGIN, 'CREATE', db)} THEN 'meta-create' END,
    CASE WHEN NOT ${grantedSql(WORK_LOGIN, 'CONNECT', db)} THEN 'work-connect' END), ''), 'ok'),
  pg_catalog.current_setting('reserved_connections'))`;
}

const PAIR = /^[a-z_][a-z0-9_]*>[a-z_][a-z0-9_]*$/;

function itemList(field: string, ok: (item: string) => boolean): string[] | null {
  if (field === 'ok') return [];
  const items = field.split(',');
  if (items.some(i => !ok(i)) || new Set(items).size !== items.length) return null;
  return items;
}

/** Exactly the thirteen fields of rolesReadSql; anything else is null, so a garbled answer never reads as set up. */
export function parseRolesRead(out: string): RolesRead | null {
  const f = out.replace(/\n$/, '').split('|');
  if (f.length !== 13) return null;
  const bool = (s: string) => (s === 'true' ? true : s === 'false' ? false : null);
  const recovery = bool(f[0]);
  const botRights = f[1] === 'missing' ? null : bool(f[1]);
  const botFirst = bool(f[2]);
  const adminPassword = bool(f[4]);
  const adminPath = bool(f[5]);
  if (recovery === null || (botRights === null && f[1] !== 'missing') || botFirst === null || adminPassword === null || adminPath === null) return null;
  const owner = f[3];
  if (owner !== 'true' && owner !== 'false' && owner !== 'other' && owner !== 'nodb') return null;
  if ((owner === 'other') !== (botRights === null && owner !== 'nodb')) return null;
  if (botRights === null && botFirst) return null;
  const state = (s: string) => (s === 'missing' || s === 'ok' || s === 'bad' ? s : null);
  const meta = state(f[6]);
  const work = state(f[7]);
  const members = itemList(f[8], i => PAIR.test(i));
  const needs = itemList(f[9], i => PAIR.test(i));
  const dbSettings = itemList(f[10], i => DB_SETTING_KEYS.includes(i));
  const dbGrants = itemList(f[11], i => DB_GRANT_KEYS.includes(i));
  if (!meta || !work || !members || !needs || !dbSettings || !dbGrants || !/^(0|[1-9]\d{0,8})$/.test(f[12])) return null;
  return { recovery, botRights, botFirst, owner, adminPassword, adminPath, meta, work, members, needs, dbSettings, dbGrants, reserved: Number(f[12]) };
}

/** The owner of smdb_manager in the bot's database ('' when it does not exist) and the grants dbm_work's reads need. */
function schemaReadSql(): string {
  return `SELECT 'owner|' || coalesce((SELECT pg_catalog.pg_get_userbyid(nspowner)::text FROM pg_catalog.pg_namespace WHERE nspname = 'smdb_manager'), '') || '|' ||
  coalesce((SELECT nullif(pg_catalog.concat_ws(',',
    CASE WHEN NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'USAGE') THEN 'public-usage' END,
    CASE WHEN NOT pg_catalog.has_schema_privilege('${WORK_LOGIN}', n.oid, 'USAGE') THEN 'work-usage' END,
    CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('r', 'p') AND NOT pg_catalog.has_table_privilege('${WORK_LOGIN}', c.oid, 'SELECT')) THEN 'work-select' END), '')
    FROM pg_catalog.pg_namespace n WHERE n.nspname = 'smdb_manager'), 'ok')`;
}

function parseSchemaRead(out: string): { owner: string; grants: string[] } | null {
  const m = /^owner\|([a-z_][a-z0-9_]*|)\|([a-z,-]+)$/.exec(out.replace(/\n$/, ''));
  if (!m) return null;
  const grants = itemList(m[2], i => SCHEMA_GRANT_KEYS.includes(i));
  return grants ? { owner: m[1], grants } : null;
}

const SCHEMA_SQL = `CREATE SCHEMA IF NOT EXISTS smdb_manager;
GRANT USAGE ON SCHEMA smdb_manager TO PUBLIC, ${WORK_LOGIN};
GRANT SELECT ON ALL TABLES IN SCHEMA smdb_manager TO ${WORK_LOGIN};
ALTER DEFAULT PRIVILEGES IN SCHEMA smdb_manager GRANT SELECT ON TABLES TO ${WORK_LOGIN};
`;

/** The drift read of a confirmed container (U2): the bot database's own settings, the logins' extra settings, and logins with a password or an expiry. */
export function driftReadSql(db: string): string {
  return `SELECT 'drift|' || (SELECT count(*) FROM pg_catalog.pg_db_role_setting s JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase WHERE s.setrole = 0 AND d.datname = '${db}')
  || '|' || (SELECT count(*) FROM pg_catalog.pg_db_role_setting s JOIN pg_catalog.pg_roles r ON r.oid = s.setrole WHERE r.rolname IN ('${META_LOGIN}', '${WORK_LOGIN}')
    AND NOT (s.setdatabase = 0 AND s.setconfig = ARRAY['${PINNED_PATH}']::text[]))
  || '|' || (SELECT count(*) FROM (VALUES ('${META_LOGIN}'), ('${WORK_LOGIN}')) v(n)
    WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_authid a WHERE a.rolname = v.n AND a.rolpassword IS NULL AND a.rolvaliduntil = '-infinity'::timestamptz))`;
}

export function parseDriftRead(out: string): { settings: number; loginSettings: number; logins: number } | null {
  const m = /^drift\|(\d+)\|(\d+)\|(\d+)$/.exec(out.replace(/\n$/, ''));
  return m ? { settings: Number(m[1]), loginSettings: Number(m[2]), logins: Number(m[3]) } : null;
}

/**
 * The drift read of a container's roles: true when nothing changed. Any count above 0, an unparsable answer or a
 * failed call drops the container from the confirmed set, so the next provisioning reads and repairs it.
 */
export async function checkRolesDrift(t: { container: string; db: string }): Promise<boolean> {
  if (!PLAIN_NAME.test(t.db)) {
    noteLoginFault(t.container);
    return false;
  }
  const read = await runCall(t.container, clusterPsql(t.container, driftReadSql(t.db)));
  const counts = read.ok ? parseDriftRead(read.stdout) : null;
  if (counts && counts.settings === 0 && counts.loginSettings === 0 && counts.logins === 0) return true;
  noteLoginFault(t.container);
  return false;
}

/** `recordUnchanged`: whether the bot's record still has the shape the target was built from and no password. */
export interface ProvisionTarget {
  container: string; user: string; db: string; botId: string; password: string | null; candidates: string[];
  recordUnchanged?: () => boolean;
}
/** `rolesSet`: every role and grant is set up, and only dbm_admin keeps its password (the start goes on with it). */
export type ProvisionResult = { ok: true; wrote: string[]; reserved?: number } | { ok: false; cls: 'in-recovery' } | { ok: false; cls: 'other'; error: string; rolesSet?: true };

/**
 * Sets up the bot's managed database (R3.2): dbm_meta and dbm_work, the database's settings and grants, smdb_manager
 * owned by dbm_meta, the bot role as a plain login that owns the database, and dbm_admin with no password. Each step
 * runs only what the read before it asks for, so a second run writes nothing. With `reread`, a container confirmed
 * earlier in this process is read again.
 */
export async function provisionRoles(t: ProvisionTarget, opts: { reread?: boolean } = {}): Promise<ProvisionResult> {
  const nameRefusal = botRoleRefusal(t.user);
  if (nameRefusal) return { ok: false, cls: 'other', error: nameRefusal };
  if (!PLAIN_NAME.test(t.db)) return { ok: false, cls: 'other', error: `the database name ${t.db} cannot be used by the manager (it must be a plain lower-case name)` };
  if (!opts.reread && rolesConfirmed.has(t.container)) return { ok: true, wrote: [] };

  const { container, user, db } = t;
  const secrets: Array<string | null> = [t.password, ...t.candidates];
  const fail = (step: string, why: string) => ({ ok: false as const, cls: 'other' as const, error: `${step} failed (${redactSecrets(why, secrets)})` });
  const say = (error: string) => ({ ok: false as const, cls: 'other' as const, error });
  const STEP_READ = 'reading the roles';
  const STEP_SCHEMA = 'creating the schema smdb_manager as dbm_meta';
  const FIRST = `the bot's role ${user} is this database's first role, which Postgres keeps a superuser; a database the manager creates now starts with ${MANAGER_DB_ROLE} as its first role, so the bot's role gets less than superuser rights only on a new install`;
  const NODB = `the database ${db} does not exist in this container`;
  const schemaOwnerText = (owner: string) => `the schema smdb_manager in ${db} belongs to ${owner}, not ${META_LOGIN}`;

  const readRoles = async (): Promise<RolesRead | { ok: false; cls: 'other'; error: string }> => {
    const read = await runCall(container, clusterPsql(container, rolesReadSql(user, db)));
    if (!read.ok) return fail(STEP_READ, read.error);
    return parseRolesRead(read.stdout) ?? say(`the database's roles read back as ${read.stdout.trim().slice(0, 200)}`);
  };
  const readSchema = async (): Promise<{ owner: string; grants: string[] } | { ok: false; cls: 'other'; error: string }> => {
    const read = await runCall(container, metaPsql(container, db, schemaReadSql()));
    if (!read.ok) return fail(STEP_SCHEMA, read.error);
    return parseSchemaRead(read.stdout) ?? fail(STEP_SCHEMA, `the schema read answered ${read.stdout.trim().slice(0, 200)}`);
  };
  const isFailure = (r: object): r is { ok: false; cls: 'other'; error: string } => 'ok' in r;

  const read = await readRoles();
  if (isFailure(read)) return read;
  if (read.recovery) return { ok: false, cls: 'in-recovery' };
  if (read.botFirst) return say(FIRST);
  if (read.owner === 'nodb') return say(NODB);

  const wrote: string[] = [];
  let needs = [...read.needs];
  let script1 = '';
  let pathSet = false;
  for (const [login, state, key] of [[META_LOGIN, read.meta, 'meta'], [WORK_LOGIN, read.work, 'work']] as const) {
    if (state === 'ok') continue;
    if (state === 'missing') {
      script1 += `CREATE ROLE ${login} LOGIN ${PLAIN_ATTRS} VALID UNTIL '-infinity'${login === META_LOGIN ? ' IN ROLE pg_read_all_stats' : ''};\n`;
      if (login === META_LOGIN) needs = needs.filter(p => p !== `${META_LOGIN}>pg_read_all_stats`);
    } else {
      script1 += `ALTER ROLE ${login} LOGIN ${PLAIN_ATTRS} PASSWORD NULL VALID UNTIL '-infinity';\n`;
      script1 += `DO $$DECLARE d text; BEGIN FOR d IN SELECT db.datname FROM pg_catalog.pg_db_role_setting s JOIN pg_catalog.pg_database db ON db.oid = s.setdatabase WHERE s.setrole = '${login}'::regrole LOOP EXECUTE pg_catalog.format('ALTER ROLE ${login} IN DATABASE %I RESET ALL', d); END LOOP; END $$;\n`;
      script1 += `ALTER ROLE ${login} RESET ALL;\n`;
    }
    script1 += `ALTER ROLE ${login} SET search_path = pg_catalog, pg_temp;\n`;
    wrote.push(key);
    pathSet = true;
  }
  if (!read.adminPath) {
    script1 += `ALTER ROLE ${MANAGER_DB_ROLE} SET search_path = pg_catalog, pg_temp;\n`;
    pathSet = true;
  }
  if (pathSet) wrote.push('search_path');
  const dbStatements: Record<string, string> = { template: 'IS_TEMPLATE false', noconn: 'ALLOW_CONNECTIONS true', limit: 'CONNECTION LIMIT -1', settings: 'RESET ALL' };
  for (const key of read.dbSettings) script1 += `ALTER DATABASE "${db}" ${dbStatements[key]};\n`;
  if (read.dbSettings.length) wrote.push('database');
  if (read.dbGrants.includes('meta-connect') || read.dbGrants.includes('meta-create')) script1 += `GRANT CONNECT, CREATE ON DATABASE "${db}" TO ${META_LOGIN};\n`;
  if (read.dbGrants.includes('work-connect')) script1 += `GRANT CONNECT ON DATABASE "${db}" TO ${WORK_LOGIN};\n`;
  if (read.dbGrants.length) wrote.push('grants');
  if (script1) {
    const run = await runCall(container, clusterPsql(container, `${QUIET_ROLE_SESSION_SQL}${script1}`, { stdin: true }));
    if (!run.ok) return fail(`setting up ${META_LOGIN}, ${WORK_LOGIN} and the settings of ${db}`, run.error);
  }

  const schema = await readSchema();
  if (isFailure(schema)) return schema;
  if (schema.owner && schema.owner !== META_LOGIN) return say(schemaOwnerText(schema.owner));
  if (!schema.owner || schema.grants.length) {
    const run = await runCall(container, metaPsql(container, db, SCHEMA_SQL, { stdin: true }));
    if (!run.ok) return fail(STEP_SCHEMA, run.error);
    wrote.push('schema');
  }

  if (read.botRights === null) {
    let password = t.password || '';
    let fromCandidate = false;
    if (!password && read.adminPassword && t.candidates.length) {
      const step = `reading ${MANAGER_DB_ROLE}'s password verifier`;
      const verifier = await readAdminVerifier(container);
      if (!verifier.ok) return fail(step, verifier.why);
      for (const c of t.candidates) {
        const verdict = await verifierAccepts(verifier.verifier, c, MANAGER_DB_ROLE);
        if (typeof verdict === 'object') return fail(step, verdict.why);
        if (verdict) { password = c; fromCandidate = true; break; }
      }
    }
    if (!password) return say(`the role ${user} does not exist, and no password is on record that this database was created with (a Database URL naming this database with its password records it), so the manager cannot create it`);
    const step = `creating the role ${user}`;
    let verifier: string;
    try {
      verifier = scramSha256Verifier(password);
    } catch (err) {
      return fail(step, err instanceof Error ? err.message : String(err));
    }
    secrets.push(password, verifier);
    const create = await runCall(container, clusterPsql(container, `${QUIET_ROLE_SESSION_SQL}CREATE ROLE "${user}" LOGIN ${PLAIN_ATTRS} PASSWORD '${verifier}';\n`, { stdin: true }));
    if (!create.ok) return fail(step, create.error);
    wrote.push('role');
    if (fromCandidate) {
      if (t.recordUnchanged && !t.recordUnchanged()) {
        return say(`the role ${user} was created, but the bot's database record changed while it was set up, so its password was not recorded; the next check reads the new record`);
      }
      let why: string | null = null;
      try {
        if (!containerManager.updateInstanceFleetDbPassword(t.botId, password)) why = "the bot's record is no longer in the registry";
      } catch (err) {
        why = err instanceof Error ? err.message : String(err);
      }
      if (why !== null) return say(`the role ${user} was created, but its password could not be recorded (${redactSecrets(why, secrets)}); it is recorded at the next check`);
      wrote.push('recorded');
    }
  } else if (read.botRights) {
    const run = await runCall(container, clusterPsql(container, `ALTER ROLE "${user}" ${PLAIN_ATTRS}`));
    if (!run.ok) return fail(`removing superuser rights from ${user}`, run.error);
    wrote.push('attributes');
  }

  let script2 = '';
  for (const pair of read.members) {
    const [member, role] = pair.split('>');
    script2 += `REVOKE "${role}" FROM "${member}";\n`;
  }
  for (const pair of needs) {
    const [member, role] = pair.split('>');
    script2 += `GRANT "${role}" TO "${member}";\n`;
  }
  if (script2) wrote.push('members');
  if (read.owner !== 'true') {
    script2 += `ALTER DATABASE "${db}" OWNER TO "${user}";\n`;
    wrote.push('owner');
  }
  if (script2) {
    const run = await runCall(container, clusterPsql(container, script2, { stdin: true }));
    if (!run.ok) return fail(`setting the role memberships and giving ${db} to ${user}`, run.error);
  }

  // S10, V3: dbm_admin keeps its password until the record holds the bot's password.
  const keepAdminPassword = read.adminPassword && !t.password && !wrote.includes('recorded');
  if (read.adminPassword && !keepAdminPassword) {
    const run = await runCall(container, clusterPsql(container, `ALTER ROLE ${MANAGER_DB_ROLE} PASSWORD NULL`));
    if (!run.ok) return fail(`removing ${MANAGER_DB_ROLE}'s password`, run.error);
    wrote.push('password');
  }

  const after = await readRoles();
  if (isFailure(after)) return after;
  if (after.recovery) return { ok: false, cls: 'in-recovery' };
  if (after.botFirst) return say(FIRST);
  if (after.owner === 'nodb') return say(NODB);
  const afterSchema = await readSchema();
  if (isFailure(afterSchema)) return afterSchema;
  if (afterSchema.owner && afterSchema.owner !== META_LOGIN) return say(schemaOwnerText(afterSchema.owner));
  const grantsMissing = [...after.dbGrants, ...afterSchema.grants];
  const field = !afterSchema.owner ? `the schema smdb_manager in ${db} does not exist`
    : after.botRights === null ? `the role ${user} does not exist`
    : after.botRights ? `the role ${user} still has rights beyond its database`
    : after.owner !== 'true' ? `${db} does not belong to ${user}`
    : after.adminPassword && !keepAdminPassword ? `${MANAGER_DB_ROLE} still has a password`
    : !after.adminPath ? `${MANAGER_DB_ROLE}'s search_path is not set`
    : after.meta !== 'ok' ? `${META_LOGIN} is not a plain login`
    : after.work !== 'ok' ? `${WORK_LOGIN} is not a plain login`
    : after.members.length ? `a role membership the manager does not allow remains (${after.members.join(', ')})`
    : after.needs.length ? `a role membership the manager needs is missing (${after.needs.join(', ')})`
    : after.dbSettings.length ? `${db} still has an owner-made setting (${after.dbSettings.join(', ')})`
    : grantsMissing.length ? `${db} does not grant ${grantsMissing.join(', ')}`
    : null;
  if (field) return say(`the roles did not read back as set (${field})`);
  // Left out of the confirmed set while dbm_admin keeps its password, so a later pass runs step 8 once it is recorded.
  if (!keepAdminPassword) rolesConfirmed.add(container);
  return { ok: true, wrote, reserved: after.reserved };
}

/** Whether the container runs: null when docker could not say. */
export function sidecarRunning(container: string): Promise<boolean | null> {
  return new Promise(resolve => {
    execFileGuarded('docker', ['inspect', '-f', '{{.State.Running}}', container], { timeout: PSQL_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (!err) return resolve(String(stdout).trim() === 'true');
      resolve(/no such object|no such container/i.test(String(stderr || err.message)) ? false : null);
    });
  });
}

/** Docker's state of the container: restarting while its restart policy loops (Running stays true then); null when docker could not say. */
export function sidecarState(container: string): Promise<'running' | 'restarting' | 'stopped' | null> {
  return new Promise(resolve => {
    execFileGuarded('docker', ['inspect', '-f', '{{.State.Running}} {{.State.Restarting}}', container], { timeout: PSQL_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) return resolve(/no such object|no such container/i.test(String(stderr || err.message)) ? 'stopped' : null);
      const [running, restarting] = String(stdout).trim().split(/\s+/);
      if (running === 'false' && (restarting === 'true' || restarting === 'false')) return resolve('stopped');
      if (running === 'true' && restarting === 'false') return resolve('running');
      if (running === 'true' && restarting === 'true') return resolve('restarting');
      resolve(null);
    });
  });
}
