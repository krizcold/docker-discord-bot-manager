/**
 * The maintenance tool's SQL in a managed Postgres container: the manager's own superuser role, and the bot role's
 * login (blocked, opened, read back). The manager logs in as MANAGER_DB_ROLE over the container's local socket, so
 * a bot role with NOLOGIN never locks the manager out.
 */
import { execFile } from 'child_process';
import { REPLICATION_ROLE } from './fleetReplication';
import { FENCE_OWNER_FILE_SQL, parseFenceOwner } from './fleetBackupGuards';

export const MANAGER_DB_ROLE = 'dbm_admin';

const PSQL_TIMEOUT_MS = 30_000;

export interface DbTarget { container: string; user: string }
export interface BotLogin { inRecovery: boolean; canLogin: boolean | null; sessions: number }
export type PsqlClass = 'missing-role' | 'refused-login' | 'recovery' | 'write-fence' | 'other';
export type DbFailure = { ok: false; cls: PsqlClass; error: string };
export type DbResult = { ok: true } | DbFailure;

/** The R14 refusal for a bot role name the tool cannot use, or null. */
export function botRoleRefusal(user: string): string | null {
  if (/^[a-z_][a-z0-9_]{0,62}$/.test(user) && user !== MANAGER_DB_ROLE && user !== REPLICATION_ROLE) return null;
  return `The app's database role name ${user} cannot be used by the maintenance tool (it must be a plain lower-case name other than ${MANAGER_DB_ROLE} and ${REPLICATION_ROLE}); nothing was changed`;
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

/** The session option a lane's own write runs under while a write fence holds the read-only default. */
const FENCE_EXEMPT = ['-e', 'PGOPTIONS=-c default_transaction_read_only=off'];

function psql(container: string, role: string, sql: string, exempt = false): Promise<{ ok: true; stdout: string } | DbFailure> {
  return new Promise(resolve => {
    execFile('docker', ['exec', ...(exempt ? FENCE_EXEMPT : []), container, 'psql', '-U', role, '-d', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql], { timeout: PSQL_TIMEOUT_MS }, (err, stdout, stderr) => {
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

export function resetManagerRoleCache(): void {
  managerRoleReady.clear();
  copyFallbackLogged.clear();
}

/** Drops what the manager knows of a container's role, for a container that is removed or recreated. */
export function forgetManagerRole(container: string): void {
  managerRoleReady.delete(container);
  copyFallbackLogged.delete(container);
}

export function isMissingManagerRole(text: string): boolean {
  return psqlFailureClass(text) === 'missing-role';
}

/** The argv with the manager's role replaced by `role`. */
export function withRole(args: string[], role: string): string[] {
  return args.map(a => (a === MANAGER_DB_ROLE ? role : a));
}

const copyFallbackLogged = new Set<string>();

/**
 * Runs a login as the manager's role. When the role is missing it is created and the login runs once more; on a live
 * copy in recovery, where it cannot be created until the main's role replicates, the login runs as the bot role.
 */
export async function asManager<R>(t: DbTarget, run: (role: string) => Promise<R>, missing: (r: R) => boolean): Promise<R> {
  const first = await run(MANAGER_DB_ROLE);
  if (!missing(first)) {
    copyFallbackLogged.delete(t.container);
    return first;
  }
  managerRoleReady.delete(t.container);
  const made = await ensureManagerDbRole(t);
  if (made.ok) return run(MANAGER_DB_ROLE);
  if (made.cls !== 'recovery') return first;
  if (!copyFallbackLogged.has(t.container)) {
    copyFallbackLogged.add(t.container);
    console.warn(`[Database] ${t.container}: the role ${MANAGER_DB_ROLE} has not reached this live copy from its main yet, so the manager logs in as ${t.user} until it does`);
  }
  return run(t.user);
}

function managerPsql(t: DbTarget, sql: string, exempt = false): Promise<{ ok: true; stdout: string } | DbFailure> {
  return asManager(t, role => psql(t.container, role, sql, exempt), r => !r.ok && r.cls === 'missing-role');
}

async function checkManagerRole(container: string): Promise<DbResult> {
  const check = await psql(container, MANAGER_DB_ROLE, SUPER_CHECK_SQL);
  if (!check.ok) return check;
  if (check.stdout.trim() !== 'true') return { ok: false, cls: 'other', error: `the role ${MANAGER_DB_ROLE} exists but is not a superuser` };
  return { ok: true };
}

/** Makes sure the manager's own superuser role exists in this container; created over the bot role when missing. */
export async function ensureManagerDbRole(t: DbTarget): Promise<DbResult> {
  const bad = refused(t);
  if (bad) return bad;
  if (managerRoleReady.has(t.container)) return { ok: true };
  let check = await checkManagerRole(t.container);
  if (!check.ok && check.cls === 'missing-role') {
    const create = await psql(t.container, t.user, `CREATE ROLE "${MANAGER_DB_ROLE}" WITH SUPERUSER LOGIN`);
    if (!create.ok && !create.error.includes('already exists')) return create;
    check = await checkManagerRole(t.container);
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
  const read = await managerPsql(t, readSql(t.user));
  if (!read.ok) return read;
  const login = parseBotLogin(read.stdout);
  if (!login) return { ok: false, cls: 'other', error: `the login read answered something unexpected (${lastLine(read.stdout)})` };
  return { ok: true, login };
}

async function alterLogin(t: DbTarget, login: boolean): Promise<DbResult> {
  const bad = refused(t);
  if (bad) return bad;
  const read = await readBotLogin(t);
  if (!read.ok) return read;
  if (read.login.inRecovery) return { ok: false, cls: 'recovery', error: 'the database is in recovery' };
  const alter = await managerPsql(t, `ALTER ROLE "${t.user}" ${login ? 'LOGIN' : 'NOLOGIN'}`, !login);
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
  const read = await managerPsql(t, "SELECT current_setting('default_transaction_read_only')");
  if (!read.ok) return read;
  const value = read.stdout.trim();
  if (value !== 'on' && value !== 'off') return { ok: false, cls: 'other', error: `the read-only setting read back as ${lastLine(read.stdout)}` };
  if (value === 'off') return { ok: true, on: false };
  const who = await managerPsql(t, FENCE_OWNER_READ_SQL);
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
    const term = await managerPsql(t, sql);
    if (!term.ok) return term;
    if (pauseMs > 0) await new Promise(resolve => setTimeout(resolve, pauseMs));
    const read = await readBotLogin(t);
    if (!read.ok) return read;
    left = read.login.sessions;
    if (left === 0) return { ok: true };
  }
  return { ok: false, cls: 'other', left, error: `${left} session(s) left after three rounds` };
}

/** Whether the container runs: null when docker could not say. */
export function sidecarRunning(container: string): Promise<boolean | null> {
  return new Promise(resolve => {
    execFile('docker', ['inspect', '-f', '{{.State.Running}}', container], { timeout: PSQL_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (!err) return resolve(String(stdout).trim() === 'true');
      resolve(/no such object|no such container/i.test(String(stderr || err.message)) ? false : null);
    });
  });
}
