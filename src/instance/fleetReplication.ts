/**
 * Managed sidecar replication posture (PLAN_REPLICATION.md Stage 1).
 *
 * Enable turns the manager-provisioned fleet Postgres into a replication-ready
 * primary: a pinned self-signed cert + ssl=on, a scram replication role and a
 * physical slot, an authored pg_hba (non-TLS stays private-subnet only, all
 * off-host access is hostssl), and a host-published port. Everything lives in
 * PGDATA via docker exec, so it survives container recreation and needs no
 * compose changes beyond the published port (synced on every start).
 *
 * The stored database URL keeps the container-name form: the host-reachable
 * canonical form cannot hairpin from containers sharing a docker network with
 * the sidecar (F1), and that includes this instance's own bot. The canonical
 * form is what a node on another host dials. sslmode=no-verify is the
 * node-postgres spelling for "encrypt, pinned trust comes later"
 * (pg-connection-string treats bare `require` as verify-against-CAs, which a
 * self-signed cert fails); the replication DSN for libpq consumers uses
 * verify-full with the cert delivered alongside it.
 */

import { startProcess, execFileGuarded } from '../docker/processStart';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as containerManager from '../docker/containerManager';
import * as envManager from '../env/manager';
import { findAppCapabilities } from '../config/appCapabilities';
import * as crypto from 'crypto';
import { InstanceConfig, FleetDbReplication, MachineLoginStatus } from '../types';
import { QUIET_ROLE_SESSION_SQL, childFailureText, probeErrorTail, redactSecrets, scramSha256Verifier, urlPassword, verifierAccepts } from '../config/secretText';
import { feedStdin } from '../docker/childStdin';
import * as fleetBackupGuards from './fleetBackupGuards';
import * as dbLogin from './dbLogin';
import { certFingerprint, encodeJoinCode, machineText, splitBackendUrls } from '../config/joinCode';
import { AddressesOutcome, sendAddresses } from './fleetJoin';
import { hasHostParam, namesDatabaseOf, readDatabaseUrl, URL_FORM } from '../config/databaseUrl';
import {
  ADDRESS_DDL_SQL, COMMITTING_SQL, COPY_GROUP, COPY_LOGIN_RE, COPY_ROLES_READ_SQL, JOIN_LOGIN, LOGINS_READ_SQL, OWN_ADDRESS_SQL, REMOVE_BLOCK_SQL,
  DISABLE_CLOSE_SQL, ROLE_LOCK_LIMIT_SQL, ROLE_SETTINGS_RESET_SQL, SETTINGS_HOLDERS_SQL, closedCount, copyLogin, copyLoginsLoopSql, lockedRoleWriteSql, copyRolesStepSql, copySlot, parseCopyRoles, hasPsqlStopLine, parseRemoveBlock, stoppedBeforeCommit,
} from './switchSql';

/** Every fleet standby's slot begins with this; the standby's manager appends its instance id (20.19 F1/F2). */
const FLEET_SLOT_PREFIX = 'fleet_standby';
const DEFAULT_HOST_PORT = 15432;
// Bounded slot retention (PLAN_REPLICATION.md RC-1): an absent standby must
// fill the bound, not the disk. Invalidation falls back to a fresh seed by design.
const DEFAULT_SLOT_WAL_KEEP_MB = 4096;
const PGDATA = '/var/lib/postgresql/data';
const EXEC_TIMEOUT_MS = 30_000;

// Non-TLS access is limited to docker's default address pools (172.16/12);
// 10/8 and 192.168/16 are real-LAN ranges and deliberately absent - traffic
// arriving through the published port keeps its LAN source address, so listing
// them would let off-host clients skip TLS. Everything else is hostssl with
// scram. First match wins. keptPlain holds the addresses outside 172.16/12 that
// a running bot on a custom address pool may still dial its old URL from: they
// keep non-TLS access until a start finds none of them connected that way
// (narrowKeptPlainHba). The join login reaches only the postgres database, and no
// machine login reaches template1 (R2); only machine logins replicate.
export function pgHbaContent(db: string, keptPlain: string[] = []): string {
  const kept = keptPlain.map(addr => {
    const cidr = `${addr}/${addr.includes(':') ? 128 : 32}`;
    return `host    all             all             ${cidr.padEnd(24)}scram-sha-256\n`;
  }).join('');
  return `# Managed by discord-bot-manager (replication posture). Do not edit.
local   all             all                                     trust
host    template1       ${JOIN_LOGIN},+${COPY_GROUP}  all             reject
host    ${`"${db}"`.padEnd(15)} ${JOIN_LOGIN}               all             reject
host    all             all             127.0.0.1/32            trust
host    all             all             ::1/128                 trust
host    all             all             172.16.0.0/12           scram-sha-256
${kept}hostssl all             all             0.0.0.0/0               scram-sha-256
hostssl replication     +${COPY_GROUP}    0.0.0.0/0               scram-sha-256
`;
}

function admittedWithoutTls(addr: string): boolean {
  if (addr === '::1') return true;
  const m = /^(?:::ffff:)?(\d+)\.(\d+)\.\d+\.\d+$/i.exec(addr);
  if (!m) return false;
  return Number(m[1]) === 127 || (Number(m[1]) === 172 && Number(m[2]) >= 16 && Number(m[2]) <= 31);
}

/** The addresses of live TCP clients without TLS that the narrowed pg_hba would refuse on their next connection. */
async function plainClientsOutsidePool(containerName: string): Promise<{ ok: true; addrs: string[] } | { ok: false; error: string }> {
  const read = await clusterSql(containerName,
    `SELECT COALESCE(string_agg(DISTINCT host(a.client_addr), ' '), '') FROM pg_stat_activity a JOIN pg_stat_ssl s ON s.pid = a.pid WHERE a.client_addr IS NOT NULL AND NOT s.ssl;`);
  if (!read.ok) return { ok: false, error: read.stderr.trim() };
  const addrs = read.stdout.trim().split(/\s+/).filter(a => a !== '' && /^[0-9A-Fa-f:.]+$/.test(a) && !admittedWithoutTls(a));
  return { ok: true, addrs: [...new Set(addrs)].sort() };
}

/**
 * The addresses outside 172.16/12 of the project's running containers other
 * than the sidecar: on a first Enable the bot may hold no connection at that
 * moment (its pool closes idle ones) and still dial without TLS later.
 */
function ownContainersOutsidePool(projectName: string, sidecarName: string): Promise<{ ok: true; addrs: string[] } | { ok: false; error: string }> {
  return new Promise(resolve => {
    execFileGuarded('docker', ['ps', '-q', '--filter', `label=com.docker.compose.project=${projectName}`], { timeout: EXEC_TIMEOUT_MS }, (psErr, psOut, psStderr) => {
      if (psErr) return resolve({ ok: false, error: probeErrorTail(String(psStderr || psErr)) });
      const ids = String(psOut).split('\n').map(line => line.trim()).filter(Boolean);
      if (ids.length === 0) return resolve({ ok: true, addrs: [] });
      execFileGuarded('docker', ['inspect', '-f', '{{.Name}} {{range .NetworkSettings.Networks}}{{.IPAddress}} {{.GlobalIPv6Address}} {{end}}', ...ids], { timeout: EXEC_TIMEOUT_MS }, (err, stdout, stderr) => {
        if (err) return resolve({ ok: false, error: probeErrorTail(String(stderr || err)) });
        const addrs = String(stdout).split('\n').flatMap(line => {
          const [name, ...rest] = line.trim().split(/\s+/);
          if (!name || name.replace(/^\//, '') === sidecarName) return [];
          return rest.filter(a => /^[0-9A-Fa-f:.]+$/.test(a) && !admittedWithoutTls(a));
        });
        resolve({ ok: true, addrs });
      });
    });
  });
}

/** `timedOut`: the timer killed the docker CLI, so what the command did is not known; `code`: the exit code on a close. */
function dbExec(containerName: string, args: string[], stdin?: string): Promise<{ ok: boolean; stdout: string; stderr: string; code?: number | null; timedOut?: true }> {
  return new Promise(resolve => {
    const started = startProcess('docker', ['exec', ...(stdin !== undefined ? ['-i'] : []), containerName, ...args]);
    if (!started.child) return resolve({ ok: false, stdout: '', stderr: 'docker exec failed' });
    const child = started.child;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, EXEC_TIMEOUT_MS);
    child.stdout?.on('data', d => { stdout += d; });
    child.stderr?.on('data', d => { stderr += d; });
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, stdout, stderr: stderr || 'docker exec failed' }); });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, stdout, stderr, code, ...(timedOut ? { timedOut: true as const } : {}) });
    });
    if (stdin !== undefined) feedStdin(child.stdin, stdin);
  });
}

/** Roles, slots, server settings and the pg_stat views, as the superuser on the postgres database. */
function clusterSql(containerName: string, sql: string, stdin = false): Promise<dbLogin.CallResult> {
  return dbLogin.runCall(containerName, dbLogin.clusterPsql(containerName, sql, { stdin }));
}

/** smdb_manager in the bot's database, as dbm_meta. */
function metaSql(containerName: string, db: string, sql: string, stdin = false): Promise<dbLogin.CallResult> {
  return dbLogin.runCall(containerName, dbLogin.metaPsql(containerName, db, sql, { stdin }));
}

/** The bot's own data in its database, as dbm_work. */
function workSql(containerName: string, db: string, sql: string): Promise<dbLogin.CallResult> {
  return dbLogin.runCall(containerName, dbLogin.workPsql(containerName, db, sql));
}

/** Why pg_hba.conf must not be rewritten now: a lane's write fence stands in it, or that could not be read. Null when it may be. */
export async function fenceLinesRefusal(containerName: string): Promise<string | null> {
  const read = await clusterSql(containerName, fleetBackupGuards.FENCE_HBA_COUNT_SQL);
  const count = read.ok ? read.stdout.trim() : '';
  if (!/^\d+$/.test(count)) return `whether a write fence stands in pg_hba.conf could not be read (${keptLines(read.stderr).pop() || 'no answer'})`;
  if (Number(count) === 0) return null;
  const owners = await clusterSql(containerName, fleetBackupGuards.FENCE_HBA_OWNER_SQL);
  const owner = owners.ok ? fleetBackupGuards.parseFenceOwner(owners.stdout) : null;
  const holder = containerManager.getAllBots().find(b => b.fleetDb?.containerName === containerName);
  const whose = !owners.ok ? 'whose lane set it could not be read'
    : !owner ? `no lane of this manager set its lines; a restore takes them over and lifts them, or remove them by hand if nothing should hold them`
    : fleetBackupGuards.fenceOwnerLane(owner) !== 'migrate' ? `it belongs to ${fleetBackupGuards.fenceOwnerText(owner)}, and that lane lifts it when it finishes`
    : holder?.migrate?.hbaFence === owner ? `it belongs to ${fleetBackupGuards.fenceOwnerText(owner)}, which lifts it when it ends`
    : `it belongs to ${fleetBackupGuards.fenceOwnerText(owner)} that is no longer open, so no lane lifts it; a restore takes it over and lifts it, or remove the lines by hand if nothing should hold them`;
  return `a write fence stands in pg_hba.conf (lines ending in ${fleetBackupGuards.WRITE_FENCE_MARK}); ${whose}`;
}

/** running true or false as docker says it; null with docker's error when docker could not be asked. */
type ContainerState = { running: boolean; error?: undefined } | { running: null; error: string };
function containerState(containerName: string): Promise<ContainerState> {
  return new Promise(resolve => {
    execFileGuarded('docker', ['inspect', '-f', '{{.State.Running}}', containerName], { timeout: EXEC_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (!err) return resolve({ running: String(stdout).trim() === 'true' });
      const text = String(stderr || err || '');
      resolve(/no such object|no such container/i.test(text) ? { running: false } : { running: null, error: probeErrorTail(text) });
    });
  });
}

async function isContainerRunning(containerName: string): Promise<boolean> {
  return (await containerState(containerName)).running === true;
}

/** The refusal for a database that is not up: docker's own "not running", or why it could not be asked. */
function dbDownText(state: ContainerState, stopped: string): string {
  return state.running === null ? `Could not probe the database container (${state.error})` : stopped;
}

function isIpAddress(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

export type PasswordRead = { ok: true; password: string } | { ok: false; why: 'lost' } | { ok: false; why: 'absent'; detail?: string };

/** The bot role's password the manager recorded for its managed database: absent when never recorded, lost when it no longer decrypts. */
export function managedDbPassword(instance: InstanceConfig): { ok: true; password: string } | { ok: false; why: 'absent' | 'lost' } {
  const password = instance.fleetDb?.password;
  if (password === undefined) return { ok: false, why: 'absent' };
  if (password === '') return { ok: false, why: 'lost' };
  return { ok: true, password };
}

/** The record without its password: a password recorded while a lane runs is not a change of the record. */
export function fleetDbShape(fleetDb: InstanceConfig['fleetDb'] | null | undefined): string | undefined {
  if (!fleetDb) return JSON.stringify(undefined);
  const { password: _p, ...rest } = fleetDb;
  return JSON.stringify(rest);
}

/** The distinct passwords of the stored Database URL's addresses, those naming the managed database first. */
function urlPasswords(instance: InstanceConfig, urlKey: string | undefined): string[] {
  const fleetDb = instance.fleetDb;
  const value = fleetDb && urlKey ? (envManager.getEnvVars(instance.id)[urlKey] || '').trim() : '';
  const named: string[] = [];
  const others: string[] = [];
  for (const entry of value === '' ? [] : splitBackendUrls(value)) {
    const pw = urlPassword(entry);
    if (!pw) continue;
    const first = readDatabaseUrl(entry).addresses[0];
    (first && namesDatabaseOf(first, fleetDb!) ? named : others).push(pw);
  }
  return [...new Set([...named, ...others])];
}

/**
 * What provisionRoles needs for the managed database: the recorded password, and when none is recorded, the Database
 * URL's passwords (none when the env store does not read).
 */
export function provisionTarget(instance: InstanceConfig): dbLogin.ProvisionTarget | null {
  const fleetDb = instance.fleetDb;
  if (!fleetDb) return null;
  const read = managedDbPassword(instance);
  let candidates: string[] = [];
  if (!read.ok) {
    const urlKey = findAppCapabilities(instance.sourceUrl)?.companionDb?.env.url;
    try {
      if (urlKey && !urlStoreRefusal(instance.id, urlKey)) candidates = urlPasswords(instance, urlKey);
    } catch {
      candidates = [];
    }
  }
  const shape = fleetDbShape(fleetDb);
  const recordUnchanged = () => {
    const now = containerManager.getBot(instance.id)?.fleetDb;
    return !!now && fleetDbShape(now) === shape && !now.password;
  };
  return { container: fleetDb.containerName, user: fleetDb.user, db: fleetDb.db, botId: instance.id, password: read.ok ? read.password : null, candidates, recordUnchanged };
}

/** A4-2: why dbm_admin keeps its password when the fill found none for the bot's role. */
export function adminKeptText(user: string, read: Exclude<PasswordRead, { ok: true }>): string {
  if (read.why === 'lost') return `${dbLogin.MANAGER_DB_ROLE} keeps its password because the bot's database password on record no longer decrypts`;
  return `${dbLogin.MANAGER_DB_ROLE} keeps its password because no password is on record for the role ${user}${read.detail ? ` (${read.detail})` : ''}`;
}

const reservedLogged = new Set<string>();

/** provisionRoles for the bot's managed database; a container that reserves too few connections is logged once. */
export async function provisionManagedRoles(instance: InstanceConfig, opts: { reread?: boolean; extra?: string } = {}): Promise<dbLogin.ProvisionResult> {
  const t = provisionTarget(instance);
  if (!t) return { ok: false, cls: 'other', error: 'This instance hosts no managed fleet database' };
  let r = await dbLogin.provisionRoles(t, { reread: opts.reread });
  // dbm_admin kept its password while the record lacks the bot's (V3): record it from the Database URL, then step 8.
  if (r.ok && t.password === null && !dbLogin.isRolesConfirmed(t.container)) {
    const filled = await managedDbPasswordFilled(instance, { extra: opts.extra, record: false });
    if (!filled.ok) return { ok: false, cls: 'other', error: adminKeptText(t.user, filled), rolesSet: true };
    if (!t.recordUnchanged!()) {
      return { ok: false, cls: 'other', error: `the bot's database record changed while its roles were set up, so the password the role ${t.user} accepts was not recorded; the next check reads the new record`, rolesSet: true };
    }
    let why: string | null = null;
    try {
      if (!containerManager.updateInstanceFleetDbPassword(instance.id, filled.password)) why = "the bot's record is no longer in the registry";
    } catch (err) {
      why = err instanceof Error ? err.message : String(err);
    }
    if (why !== null) {
      return { ok: false, cls: 'other', error: `the role ${t.user} was created, but its password could not be recorded (${redactSecrets(why, [filled.password])}); it is recorded at the next check`, rolesSet: true };
    }
    r = await dbLogin.provisionRoles({ ...t, password: filled.password, candidates: [] }, { reread: true });
  }
  if (r.ok && r.reserved !== undefined && r.reserved < 4 && !reservedLogged.has(t.container)) {
    reservedLogged.add(t.container);
    console.warn(`[Database] ${t.container}: reserved_connections is ${r.reserved}, below the 4 the manager's logins need; the next start after a build recreates the database container with it`);
  }
  return r;
}

const adminPasswordLeft = () => `the roles did not read back as set (${dbLogin.MANAGER_DB_ROLE} still has a password)`;

/**
 * Invariant A after NM14's fill: a container left out of the confirmed set (dbm_admin kept its password while the
 * record lacked the bot's) is provisioned again from the record the fill wrote, and must confirm before a code or an
 * Enable goes on.
 */
async function confirmedAfterFill(instance: InstanceConfig): Promise<dbLogin.ProvisionResult> {
  const container = instance.fleetDb!.containerName;
  if (dbLogin.isRolesConfirmed(container)) return { ok: true, wrote: [] };
  const again = await provisionManagedRoles(containerManager.getBot(instance.id) ?? instance, { reread: true });
  if (again.ok && !dbLogin.isRolesConfirmed(container)) return { ok: false, cls: 'other', error: adminPasswordLeft() };
  return again;
}

/** Receive's code while a push is pending: a read only (provisioning would race the push), refused while dbm_admin has a password. */
async function adminPasswordRefusal(instance: InstanceConfig): Promise<dbLogin.ProvisionResult> {
  const { containerName, user, db } = instance.fleetDb!;
  const read = await dbLogin.runCall(containerName, dbLogin.clusterPsql(containerName, dbLogin.rolesReadSql(user, db)));
  if (!read.ok) return { ok: false, cls: 'other', error: `reading the roles failed (${read.error})` };
  const roles = dbLogin.parseRolesRead(read.stdout);
  if (!roles) return { ok: false, cls: 'other', error: `the database's roles read back as ${read.stdout.trim().slice(0, 200)}` };
  if (roles.recovery) return { ok: false, cls: 'in-recovery' };
  return roles.adminPassword ? { ok: false, cls: 'other', error: adminPasswordLeft() } : { ok: true, wrote: [] };
}

const FILL_NOURL = 'the Database URL holds no password to check';
const fillUnread = (why: string) => `the password in the Database URL could not be checked against the database: ${why}`;

/**
 * managedDbPassword, and when none is recorded, the first password of the Database URL (then `extra`) that the bot
 * role's verifier in the database accepts. With `record`, an accepted password is written into the record.
 */
export async function managedDbPasswordFilled(instance: InstanceConfig, opts: { extra?: string; record: boolean }): Promise<PasswordRead> {
  const read = managedDbPassword(instance);
  if (read.ok || read.why === 'lost') return read;
  const fleetDb = instance.fleetDb;
  if (!fleetDb) return { ok: false, why: 'absent', detail: FILL_NOURL };
  const urlKey = findAppCapabilities(instance.sourceUrl)?.companionDb?.env.url;
  const unreadStore = urlKey ? urlStoreRefusal(instance.id, urlKey) : null;
  if (unreadStore) return { ok: false, why: 'absent', detail: fillUnread(unreadStore) };
  const fromUrl = urlPasswords(instance, urlKey);
  const extra = opts.extra || '';
  const candidates = [...new Set([...fromUrl, ...(extra ? [extra] : [])])];
  if (candidates.length === 0) return { ok: false, why: 'absent', detail: FILL_NOURL };
  const state = await containerState(fleetDb.containerName);
  if (state.running !== true) return { ok: false, why: 'absent', detail: fillUnread(dbDownText(state, 'the database is not running')) };
  const verifier = await dbLogin.readRoleVerifier({ container: fleetDb.containerName, user: fleetDb.user });
  if (!verifier.ok) return { ok: false, why: 'absent', detail: fillUnread(verifier.why) };
  let accepted: string | undefined;
  for (const c of candidates) {
    const verdict = await verifierAccepts(verifier.verifier, c, fleetDb.user);
    if (typeof verdict === 'object') return { ok: false, why: 'absent', detail: fillUnread(verdict.why) };
    if (verdict) { accepted = c; break; }
  }
  if (accepted === undefined) {
    const where = fromUrl.length > 0 && extra ? "in the Database URL or in the bot's env file" : fromUrl.length > 0 ? 'in the Database URL' : "in the bot's env file";
    return { ok: false, why: 'absent', detail: `the database does not accept the password ${where} for ${fleetDb.user}` };
  }
  if (opts.record) {
    try {
      // Only over the record the caller read: a lane whose record changed meanwhile refuses on its own check.
      if (fleetDbShape(containerManager.getBot(instance.id)?.fleetDb) === fleetDbShape(fleetDb)) {
        containerManager.updateInstanceFleetDbPassword(instance.id, accepted);
      }
    } catch (err) {
      console.warn(`[FleetReplication] ${instance.id}: the database accepted the password in the Database URL, but it could not be recorded (${err instanceof Error ? err.message : String(err)}); the next use checks it again`);
    }
  }
  return { ok: true, password: accepted };
}

/**
 * D103: what a stored Database URL names when Enable and Disable must keep it: null when it is blank or one address
 * that names the bot's own managed database (they write it then), else what it names, for the kept text. O44: a
 * first address on the managed container's name with no host or hostaddr parameter is that database in every form.
 */
function keptUrlWhat(instance: InstanceConfig, urlKey: string): string | null {
  const env = envManager.getEnvVars(instance.id);
  const value = (env[urlKey] || '').trim();
  if (!value) return null;
  const read = readDatabaseUrl(value, env);
  const first = read.addresses[0];
  if (first && instance.fleetDb && first.host === instance.fleetDb.containerName.toLowerCase() && !hasHostParam(value)) return null;
  if (read.form) return `an address the manager reads differently from the bot's Postgres driver (it ${URL_FORM[read.form].what})`;
  if (!first) return 'no single database address';
  if (instance.fleetDb && namesDatabaseOf(first, instance.fleetDb)) return null;
  return `${first.host.includes(':') ? `[${first.host}]` : first.host}:${first.port}/${first.db}`;
}

/** Why the Database URL cannot be written over now: the env store does not read, or its URL value no longer decrypts. */
function urlStoreRefusal(botId: string, urlKey: string): string | null {
  const store = envManager.getEnvVarsWithStatus(botId);
  if (store.corrupt) return envManager.storeBrokenDiagnosis(botId);
  if (store.undecryptable.includes(urlKey)) return `the env store's value of ${urlKey} no longer decrypts; re-enter it or restore the encryption key first`;
  return null;
}

const urlKeptEnable = (what: string) => `The Database URL was kept as it is: it names ${what}, not this bot's managed database, so the bot goes on using it; Enable writes the managed database's address only when the Database URL is blank or names that database.`;
const urlKeptDisable = (what: string) => `The Database URL was kept as it is: it names ${what}, not this bot's managed database, and Disable sets it back only when it names that database.`;
const URL_KEPT_CHANGED_E = "The Database URL was kept as it is: it changed while Enable ran, and Enable writes the managed database's address only over the value it read when it started.";
const URL_KEPT_CHANGED_D = 'The Database URL was kept as it is: it changed while Disable ran, and Disable sets back only the value it read when it started.';

function sidecarUrl(instance: InstanceConfig, dbPassword: string): string {
  const { containerName, user, db } = instance.fleetDb!;
  return `postgresql://${user}:${encodeURIComponent(dbPassword)}@${containerName}:5432/${db}`;
}

export function generateCertPair(dir: string, publicHost: string): Promise<{ ok: boolean; error?: string }> {
  const san = isIpAddress(publicHost) ? `IP:${publicHost}` : `DNS:${publicHost}`;
  return new Promise(resolve => {
    execFileGuarded('openssl', [
      'req', '-new', '-x509', '-days', '3650', '-nodes', '-newkey', 'rsa:2048',
      '-subj', `/CN=${publicHost}`, '-addext', `subjectAltName=${san}`,
      '-keyout', path.join(dir, 'server.key'), '-out', path.join(dir, 'server.crt'),
    ], { timeout: EXEC_TIMEOUT_MS }, (err, _stdout, stderr) => {
      resolve(err ? { ok: false, error: String(stderr || err).trim() } : { ok: true });
    });
  });
}

/**
 * Generate (manager-side; the sidecar image has no openssl) and install the
 * pinned cert pair into PGDATA when absent or when the host it names changed.
 * The caller's pg_reload_conf picks the new pair up (ssl files reload on
 * sighup). `certHost` is the record's memory of what the cert names.
 * Both files are written under .new names and renamed into place only once
 * both are written, so a failed write leaves the installed pair as it was; a
 * .new file left behind marks an install that stopped between the renames and
 * forces a fresh pair. rotated: a pair was installed over an existing cert.
 */
async function ensureServerCert(containerName: string, publicHost: string, certHost: string | undefined, again = 'press Enable again'): Promise<{ error: string | null; rotated: boolean }> {
  const crt = `${PGDATA}/server.crt`;
  const key = `${PGDATA}/server.key`;
  if (certHost === publicHost) {
    const present = await dbExec(containerName, ['sh', '-c', `test -f ${crt} && test -f ${key} && test ! -e ${crt}.new && test ! -e ${key}.new`]);
    if (present.ok) return { error: null, rotated: false };
  }
  // A probe docker could not run counts as a cert present: telling the
  // operator standbys may need the new block is the safe side.
  const had = await dbExec(containerName, ['test', '-f', crt]);
  const hadCert = had.ok || had.stderr.trim() !== '';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-cert-'));
  try {
    const gen = await generateCertPair(dir, publicHost);
    if (!gen.ok) return { error: `certificate generation failed: ${gen.error}`, rotated: false };
    const keyPem = fs.readFileSync(path.join(dir, 'server.key'), 'utf-8');
    const crtPem = fs.readFileSync(path.join(dir, 'server.crt'), 'utf-8');
    try {
      if (!new crypto.X509Certificate(crtPem).checkPrivateKey(crypto.createPrivateKey(keyPem))) {
        return { error: 'the generated key does not match the generated certificate (nothing was installed)', rotated: false };
      }
    } catch (err) {
      return { error: `the generated certificate pair could not be read (nothing was installed): ${err instanceof Error ? err.message : String(err)}`, rotated: false };
    }
    for (const [file, content] of [[key, keyPem], [crt, crtPem]]) {
      const put = await dbExec(containerName, ['sh', '-c',
        `cat > ${file}.new && chown postgres:postgres ${file}.new && chmod 600 ${file}.new`], content);
      if (!put.ok) return { error: `certificate install failed (${path.posix.basename(file)}; the installed pair was not changed): ${put.stderr.trim()}`, rotated: false };
    }
    const swap = await dbExec(containerName, ['sh', '-c', `mv -f ${key}.new ${key} && mv -f ${crt}.new ${crt}`]);
    if (!swap.ok) return { error: `certificate install failed while moving the new pair into place, so the key and certificate on disk may not match (the configuration was not reloaded; ${again} to install a fresh pair): ${swap.stderr.trim()}`, rotated: false };
    return { error: null, rotated: hadCert };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export const LOCAL_TLS_TIMING = { tryMs: 10_000, gapMs: 500, deadlineMs: 10_000 };
export const LOCAL_TLS_READ_SQL = "SELECT pg_catalog.current_setting('ssl') || '|' || coalesce((SELECT s.ssl::text FROM pg_catalog.pg_stat_ssl s WHERE s.pid = pg_catalog.pg_backend_pid()), 'none');";
export const LOCAL_PAIR_TEST = `test -f ${PGDATA}/server.crt && test -f ${PGDATA}/server.key && test ! -e ${PGDATA}/server.crt.new && test ! -e ${PGDATA}/server.key.new`;

/** E1: 'complete', 'absent' only on exit 1 with nothing on stderr, else why docker did not say. */
function localPairState(containerName: string): Promise<'complete' | 'absent' | { why: string }> {
  return new Promise(resolve => {
    execFileGuarded('docker', ['exec', containerName, 'sh', '-c', LOCAL_PAIR_TEST], { timeout: EXEC_TIMEOUT_MS }, (err, _stdout, stderr) => {
      if (!err) return resolve('complete');
      const text = String(stderr ?? '');
      if (err.code === 1 && !err.killed && text === '') return resolve('absent');
      const lead = 'docker did not say whether the certificate pair is in place: ';
      resolve({ why: err.killed ? `${lead}no answer within ${EXEC_TIMEOUT_MS / 1000} s` : `${lead}${probeErrorTail(text || err.message)}` });
    });
  });
}

/** E7: new sessions over TLS on the container's loopback until one reads ssl on and its own session encrypted. */
async function readLocalTls(containerName: string): Promise<{ why: string; off: boolean } | null> {
  const { tryMs, gapMs, deadlineMs } = LOCAL_TLS_TIMING;
  const call: dbLogin.PsqlCall = {
    login: dbLogin.MANAGER_DB_ROLE,
    args: ['exec', containerName, 'psql', '-X', '-w', '-d', `host=127.0.0.1 port=5432 dbname=postgres user=${dbLogin.MANAGER_DB_ROLE} sslmode=require connect_timeout=10`,
      '-tA', '-v', 'ON_ERROR_STOP=1', '-c', LOCAL_TLS_READ_SQL],
  };
  const first = Date.now();
  for (;;) {
    const r = await dbLogin.runCall(containerName, call, tryMs);
    if (r.ok && r.stdout.trim() === 'on|true') return null;
    if (Date.now() - first > deadlineMs) {
      if (!r.ok && /server does not support SSL/i.test(r.error)) return { why: `the server still refused TLS ${deadlineMs / 1000} s after the reload: ${r.error}`, off: true };
      return { why: `no session over TLS opened within ${deadlineMs / 1000} s of the reload: ${r.ok ? `the session read '${r.stdout.trim()}'` : r.error}`, off: false };
    }
    await new Promise(res => setTimeout(res, gapMs));
  }
}

/** The undo after the server refused TLS: 'done', or the stage that failed and why; `timedOut`: its outcome is not known. */
export type TlsUndo = { stage: 'done' } | { stage: 'reset' | 'aside' | 'reload'; why: string; timedOut?: true };

/**
 * U1 to U3: ssl reset first, so a start never meets ssl saved beside a pair it cannot load; then the pair under its
 * .new names, which the pair test reads as absent and the next install overwrites; then a reload.
 */
async function undoLocalTls(containerName: string): Promise<TlsUndo> {
  const limit = `${dbLogin.PSQL_TIMEOUT_MS / 1000} s`;
  let stage: 'reset' | 'aside' | 'reload' = 'reset';
  try {
    const reset = await clusterSql(containerName, 'ALTER SYSTEM RESET ssl;');
    if (!reset.ok) return { stage, why: reset.timedOut ? `the database did not answer ALTER SYSTEM RESET ssl within ${limit}` : `ALTER SYSTEM RESET ssl failed: ${reset.error}` };
    stage = 'aside';
    const aside = await dbExec(containerName, ['sh', '-c', `mv -f ${PGDATA}/server.key ${PGDATA}/server.key.new && mv -f ${PGDATA}/server.crt ${PGDATA}/server.crt.new`]);
    if (aside.timedOut) {
      return { stage, why: `docker did not answer within ${EXEC_TIMEOUT_MS / 1000} s, so the manager can't confirm the certificate files were renamed`, timedOut: true };
    }
    if (!aside.ok) {
      const said = aside.stderr.trim();
      return { stage, why: said ? `the certificate files could not be renamed: ${said}` : `the certificate files could not be renamed (docker exec ${typeof aside.code === 'number' ? `exited ${aside.code}` : 'ended with no exit code'} with no message)` };
    }
    stage = 'reload';
    const reload = await clusterSql(containerName, 'SELECT pg_reload_conf();');
    if (!reload.ok) {
      return reload.timedOut ? { stage, why: `the database did not answer pg_reload_conf() within ${limit}`, timedOut: true } : { stage, why: reload.error };
    }
    if (reload.stdout.trim() !== 't') return { stage, why: `pg_reload_conf answered '${reload.stdout.trim()}'` };
    return { stage: 'done' };
  } catch (err) {
    return { stage, why: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Start on a new database (NM36): TLS on for a new database whose kept one had it, with an interim pair for localhost
 * that Enable replaces. A complete pair is never replaced unless the server refused it (the undo). `off`: TLS is known
 * not to be on.
 */
export async function ensureLocalTls(containerName: string): Promise<{ why: string; off: boolean; undo?: TlsUndo } | null> {
  let mayBeOn = false;
  try {
    const pair = await localPairState(containerName);
    if (typeof pair === 'object') return { why: pair.why, off: false };
    if (pair === 'complete') {
      mayBeOn = true;
    } else {
      const cert = await ensureServerCert(containerName, 'localhost', undefined, 'run it again');
      if (cert.error) return { why: cert.error, off: true };
    }
    const limit = `${dbLogin.PSQL_TIMEOUT_MS / 1000} s`;
    const alter = await clusterSql(containerName, 'ALTER SYSTEM SET ssl = on;');
    if (!alter.ok) {
      if (alter.timedOut) return { why: `the database did not answer ALTER SYSTEM SET ssl = on within ${limit}`, off: false };
      return { why: `ssl = on could not be saved: ${alter.error}`, off: !mayBeOn };
    }
    mayBeOn = true;
    const reload = await clusterSql(containerName, 'SELECT pg_reload_conf();');
    if (!reload.ok) return { why: reload.timedOut ? `the database did not answer pg_reload_conf() within ${limit}` : `the configuration could not be reloaded: ${reload.error}`, off: false };
    if (reload.stdout.trim() !== 't') return { why: `pg_reload_conf answered '${reload.stdout.trim()}'`, off: false };
    const read = await readLocalTls(containerName);
    return read?.off ? { ...read, undo: await undoLocalTls(containerName) } : read;
  } catch (err) {
    return { why: err instanceof Error ? err.message : String(err), off: !mayBeOn };
  }
}

/**
 * Enable (or update host/port of) the replication posture. Idempotent: the
 * replication password survives re-enables and only the operator-provided
 * host/port move. Slots belong to the standbys that mint them (20.19 F1); a
 * freshly enabled primary has none until a standby seeds. The published port and the public-URL env apply on the next
 * instance restart.
 */
export function enableFleetReplication(
  instance: InstanceConfig,
  publicHost: string,
  hostPort?: number,
  slotWalKeepMb?: number,
  opts: { admit?: Admission; dbPassword?: string; offerAddresses?: boolean } = {},
): Promise<EnableResult> {
  return inReplicationLane<EnableResult>(instance.id, 'Enable', async () => {
    const fresh = containerManager.getBot(instance.id);
    if (!fresh) return { success: false, error: 'Bot not found (nothing was changed)' };
    const refused = opts.admit ? await opts.admit(fresh) : null;
    if (refused) return { success: false, error: refused };
    return enableInLane(fresh, publicHost, hostPort, slotWalKeepMb, opts);
  });
}

/** A caller's own refusal, read inside the lane before anything runs; null admits. */
type Admission = (instance: InstanceConfig) => Promise<string | null>;

type EnableResult = { success: boolean; error?: string; restartRequired?: boolean; certRotated?: boolean; plainClientsKept?: number; addresses?: AddressesOutcome; urlKept?: string };

/**
 * One replication lane per instance: Enable, Disable and the adopt take the
 * instance's op lock, so a start, rebuild, seed or decommission and a second Enable or Disable
 * refuse while one runs, and the backup slot, so no dump or restore runs
 * beside it.
 */
async function inReplicationLane<T extends { success: boolean; error?: string }>(botId: string, action: string, fn: () => Promise<T>): Promise<T | { success: false; error: string }> {
  if (!fleetBackupGuards.claimFleetBackupBusy(botId)) {
    return { success: false, error: containerManager.isShuttingDown() ? containerManager.SHUTDOWN_REFUSAL : `A backup, restore or standby re-seed is running on this instance; ${action} is refused until it finishes (nothing was changed)` };
  }
  let entered = false;
  try {
    return await containerManager.withExternalBotOp(botId, 'replication', async () => {
      entered = true;
      const held = containerManager.migrateRefusal(botId, 'db') ?? containerManager.keptOpRefusal(botId, 'db') ?? containerManager.migrationHoldRefusal(botId);
      return held ?? fn();
    });
  } catch (err) {
    if (entered) throw err;
    return { success: false, error: `${err instanceof Error ? err.message : String(err)}; ${action} is refused until it finishes (nothing was changed)` };
  } finally {
    fleetBackupGuards.releaseFleetBackupBusy(botId);
  }
}

async function enableInLane(
  instance: InstanceConfig,
  publicHost: string,
  hostPort: number | undefined,
  slotWalKeepMb: number | undefined,
  opts: { dbPassword?: string; offerAddresses?: boolean },
): Promise<EnableResult> {
  const fleetDb = instance.fleetDb;
  if (!fleetDb) return { success: false, error: 'This instance has no managed fleet database' };
  // Record check FIRST: everything past the preflight mutates the live
  // cluster (role, ssl, pg_hba), so a missing key name must refuse before
  // any of it or a failed enable leaves a live posture no record accounts for.
  const dbEnv = findAppCapabilities(instance.sourceUrl)?.companionDb?.env;
  if (!dbEnv) {
    return { success: false, error: 'This app declares no companion database, so replication cannot write its database URL' };
  }
  const host = publicHost.trim();
  if (!host || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host)) {
    return { success: false, error: 'Public host must be a bare hostname or IPv4 address' };
  }
  const port = hostPort ?? fleetDb.replication?.hostPort ?? DEFAULT_HOST_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { success: false, error: 'Invalid port' };
  const keepMb = slotWalKeepMb ?? fleetDb.replication?.slotWalKeepMb ?? DEFAULT_SLOT_WAL_KEEP_MB;
  if (!Number.isInteger(keepMb) || keepMb < 64 || keepMb > 1048576) {
    return { success: false, error: 'WAL retention bound must be between 64 MB and 1 TB' };
  }
  const collision = containerManager.getAllBots().find(other =>
    (other.id !== instance.id && other.fleetDb?.replication?.hostPort === port)
    || other.fleetDbReplica?.hostPort === port);
  if (collision) {
    return { success: false, error: `Host port ${port} is already used by "${collision.displayName}" - pick another` };
  }
  const ownLogin = copyLogin(instance.id);
  let ownPassword = instance.fleetLogin?.password || '';
  if (!ownPassword) {
    ownPassword = crypto.randomBytes(24).toString('base64url');
    try {
      containerManager.updateInstanceFleetLogin(instance.id, { password: ownPassword });
    } catch (err) {
      return { success: false, error: `The password of this machine's own login could not be saved (${err instanceof Error ? err.message : String(err)}); replication was not set up` };
    }
  }
  const dbState = await containerState(fleetDb.containerName);
  if (dbState.running !== true) {
    return { success: false, error: dbDownText(dbState, 'Database container is not running (start the instance first)') };
  }
  const rolesRefusal = (r: dbLogin.ProvisionResult) => (r.ok ? null : {
    success: false as const,
    error: `Enable was refused: the database's roles could not be set up (${r.cls === 'in-recovery' ? 'the database is a live copy in recovery, which takes its roles from its main' : r.error}); replication was not set up`,
  });
  const refusedRoles = rolesRefusal(await provisionManagedRoles(instance, { extra: opts.dbPassword }));
  if (refusedRoles) return refusedRoles;
  const fenced = await fenceLinesRefusal(fleetDb.containerName);
  if (fenced) return { success: false, error: `Enable rewrites pg_hba.conf, but ${fenced}; replication was not set up, so retry Enable after that` };
  const kept = keptUrlWhat(instance, dbEnv.url);
  let dbPassword: string | null = null;
  if (!kept) {
    const broken = urlStoreRefusal(instance.id, dbEnv.url);
    if (broken) return { success: false, error: broken };
    // The caller's password is checked too: the bot's env file, for a manager env that holds no database URL.
    const read = await managedDbPasswordFilled(instance, { extra: opts.dbPassword, record: true });
    if (!read.ok) {
      return { success: false, error: read.why === 'lost'
        ? "The managed database's password on record no longer decrypts (the manager's encryption key changed or was lost), so Enable cannot write its address into the Database URL; replication was not set up"
        : `The managed database's password is not on record (${read.detail}), so Enable cannot write its address into the Database URL; replication was not set up` };
    }
    dbPassword = read.password;
  }
  const refusedAgain = rolesRefusal(await confirmedAfterFill(instance));
  if (refusedAgain) return refusedAgain;
  if (fleetDb.replication && !fleetDb.replication.password) {
    return { success: false, error: 'The stored join password no longer decrypts (the manager encryption key changed or was lost). Restore the key, or press New join code to make a new one (machines that joined keep their own logins), then press Enable replication again.' };
  }
  const recordAtStart = fleetDbShape(fleetDb);

  const live = await plainClientsOutsidePool(fleetDb.containerName);
  if (!live.ok) return { success: false, error: `could not read which clients connect without TLS (replication was not set up): ${live.error}` };
  // With a record, the bot already got the TLS URL at a start since, or its
  // addresses are in keptPlain; only a start may drop a kept line.
  let own: string[] = [];
  if (!fleetDb.replication) {
    const containers = await ownContainersOutsidePool(instance.sanitizedName, fleetDb.containerName);
    if (!containers.ok) return { success: false, error: `could not read the addresses of this instance's containers (replication was not set up): ${containers.error}` };
    own = containers.addrs;
  }
  const plain = { addrs: [...new Set([...live.addrs, ...(fleetDb.replication?.keptPlain ?? fleetDb.keptPlain ?? []), ...own])].sort() };

  const previousCertHost = fleetDb.replication?.certHost;
  const cert = await ensureServerCert(fleetDb.containerName, host, previousCertHost);
  if (cert.error) return { success: false, error: cert.error };
  const certRotated = cert.rotated;
  const failed = (error: string): EnableResult => ({
    success: false,
    certRotated,
    error: certRotated ? `${error} (a new server certificate is already installed and the database loads it at its next reload or restart; every other machine then needs the new join code)` : error,
  });

  const password = instance.fleetDb?.replication?.password || crypto.randomBytes(24).toString('base64url');
  const rolesFailed = (reason: string) => failed(`setting up the machine logins failed: ${reason}`);
  const roleExists = async (name: string): Promise<boolean | string> => {
    const read = await clusterSql(fleetDb.containerName, `SELECT count(*) FROM pg_roles WHERE rolname = '${name}';`);
    return read.ok ? read.stdout.trim() !== '0' : sqlReason(read.stderr);
  };
  const joinExists = await roleExists(JOIN_LOGIN);
  if (typeof joinExists === 'string') return rolesFailed(joinExists);
  const ownExists = await roleExists(ownLogin);
  if (typeof ownExists === 'string') return rolesFailed(ownExists);
  // Verifiers, never passwords, and outside a DO block: a failing statement
  // inside one is echoed whole in the CONTEXT line, which the quiet session
  // settings do not hold back.
  const verifier = scramSha256Verifier(password);
  const ownVerifier = scramSha256Verifier(ownPassword);
  const secrets = [password, verifier, ownPassword, ownVerifier];
  let roleStep: string;
  try {
    roleStep = enableRoleStepSql({ joinExists, joinVerifier: verifier, ownLogin, ownExists, ownVerifier });
  } catch (err) {
    return rolesFailed(err instanceof Error ? err.message : String(err));
  }
  const setup = await clusterSql(fleetDb.containerName, roleStep, true);
  if (!setup.ok && setup.timedOut) {
    return failed(`the manager can't confirm whether the machine logins were set up: the database did not answer within ${dbLogin.PSQL_TIMEOUT_MS / 1000} s, and the change may still be applied there; press Enable replication again`);
  }
  if (!setup.ok) return rolesFailed(redactSecrets(sqlReason(setup.stderr), secrets));
  // Separate calls: ALTER SYSTEM refuses to run inside the implicit transaction
  // a multi-statement psql -c wraps around its input.
  const ssl = await clusterSql(fleetDb.containerName, 'ALTER SYSTEM SET ssl = on;');
  if (!ssl.ok) return failed(`enabling ssl failed: ${ssl.stderr.trim()}`);
  // Restart-only setting (no re-initdb): makes pg_rewind possible on every
  // cluster that has ever run enable (reopened ruling R6).
  const hints = await clusterSql(fleetDb.containerName, 'ALTER SYSTEM SET wal_log_hints = on;');
  if (!hints.ok) return failed(`enabling wal_log_hints failed: ${hints.stderr.trim()}`);
  const keep = await clusterSql(fleetDb.containerName, `ALTER SYSTEM SET max_slot_wal_keep_size = '${keepMb}MB';`);
  if (!keep.ok) return failed(`setting the WAL retention bound failed: ${keep.stderr.trim()}`);
  const asyncOnly = await clusterSql(fleetDb.containerName, 'ALTER SYSTEM RESET synchronous_standby_names;');
  if (!asyncOnly.ok) return failed(`resetting synchronous replication failed: ${asyncOnly.stderr.trim()}`);

  const hbaFile = `${PGDATA}/pg_hba.conf`;
  const hba = await dbExec(fleetDb.containerName, ['sh', '-c',
    `cat > ${hbaFile}.new && chown postgres:postgres ${hbaFile}.new && chmod 600 ${hbaFile}.new && mv -f ${hbaFile}.new ${hbaFile}`], pgHbaContent(fleetDb.db, plain.addrs));
  if (!hba.ok) return failed(`pg_hba rewrite failed: ${hba.stderr.trim()}`);
  const reload = await clusterSql(fleetDb.containerName, 'SELECT pg_reload_conf();');
  if (!reload.ok) return failed(`config reload failed: ${reload.stderr.trim()}`);

  const ownCert = await dbExec(fleetDb.containerName, ['cat', `${PGDATA}/server.crt`]);
  if (!ownCert.ok) return failed(`setting up the address list failed: the server certificate could not be read (${probeErrorTail(ownCert.stderr)})`);
  const addresses = await metaSql(fleetDb.containerName, fleetDb.db, `BEGIN;\n${addressTableSql(host, port, ownCert.stdout.trim(), machineText(host))}COMMIT;\n`, true);
  if (!addresses.ok) return failed(`setting up the address list failed: ${redactSecrets(addresses.stderr.trim(), [password])}`);

  const replication: FleetDbReplication = {
    role: JOIN_LOGIN,
    password,
    hostPort: port,
    publicHost: host,
    certHost: host,
    slotWalKeepMb: keepMb,
    ...(plain.addrs.length > 0 ? { keptPlain: plain.addrs } : {}),
  };
  let keptAtWrite: string | null = null;
  // The stored URL stays the container-name form (the public form cannot
  // hairpin from containers sharing a docker network with the sidecar, which
  // includes this instance's own bot). TLS on it too (ssl=on just activated): the authored pg_hba
  // accepts non-TLS only from 172.16/12, and a docker daemon with custom
  // address pools allocates outside it; hostssl covers every subnet.
  const changed = `the database already has the join login, this machine's own login, ssl, the WAL settings, the server certificate${certRotated ? ' (a new one)' : ''} and the managed pg_hba`;
  if (fleetDbShape(containerManager.getBot(instance.id)?.fleetDb) !== recordAtStart) {
    return { success: false, certRotated, error: `The instance's database record changed while this Enable ran, so the record and the database URL were not written; ${changed}. Check the Replication section, then press Enable again` };
  }
  try {
    // The env store alone: container env assembly derives sensitive values from
    // it at read time (the two-store strip), so no record mirror exists to sync.
    const now = keptUrlWhat(instance, dbEnv.url);
    if (!kept && !now) envManager.setEnvVars(instance.id, { [dbEnv.url]: `${sidecarUrl(instance, dbPassword!)}?sslmode=no-verify` });
    containerManager.updateInstanceFleetDbReplication(instance.id, replication);
    keptAtWrite = now ? urlKeptEnable(now) : kept ? URL_KEPT_CHANGED_E : null;
  } catch (err) {
    return { success: false, certRotated, error: `The database URL or the replication record could not be saved (${err instanceof Error ? err.message : String(err)}); ${changed}. Press Enable again once the store can be written` };
  }
  forgetProbes(instance.id);
  const offered = opts.offerAddresses === false ? undefined : await sendAddresses(instance.id);
  return { success: true, restartRequired: true, certRotated, ...(plain.addrs.length > 0 ? { plainClientsKept: plain.addrs.length } : {}), ...(offered ? { addresses: offered } : {}), ...(keptAtWrite ? { urlKept: keptAtWrite } : {}) };
}

/**
 * Disable: refuse while any fleet standby still streams (naming its slots),
 * drop every inactive fleet slot FIRST (a leaked slot retains WAL until the
 * disk fills, so a disable that cannot drop them refuses and keeps the record),
 * close the join login and every machine login (the port may stay published until the next
 * restart, and a seed against a disabled primary must fail at the login), then
 * drop the record and revert the URL to the private sidecar form. Cert, ssl=on
 * and pg_hba stay in PGDATA; the non-TLS lines an Enable kept move to the
 * database record, and the next start narrows them. Port unpublish applies on
 * the next restart.
 */
export function disableFleetReplication(
  instance: InstanceConfig,
  opts: { admit?: Admission } = {},
): Promise<DisableResult> {
  return inReplicationLane<DisableResult>(instance.id, 'Disable', async () => {
    const fresh = containerManager.getBot(instance.id);
    if (!fresh) return { success: false, error: 'Bot not found (nothing was changed)' };
    const refused = opts.admit ? await opts.admit(fresh) : null;
    if (refused) return { success: false, error: refused };
    return disableInLane(fresh);
  });
}

type DisableResult = { success: boolean; error?: string; restartRequired?: boolean; warning?: string; plainClientsKept?: number; addresses?: AddressesOutcome; urlKept?: string };

async function disableInLane(
  instance: InstanceConfig,
): Promise<DisableResult> {
  const fleetDb = instance.fleetDb;
  if (!fleetDb?.replication) return { success: false, error: 'Replication is not enabled' };
  const disableRecordAtStart = fleetDbShape(fleetDb);
  const dbEnv = findAppCapabilities(instance.sourceUrl)?.companionDb?.env;
  if (!dbEnv) return { success: false, error: 'This app declares no managed database companion (nothing was disabled)' };
  const kept = keptUrlWhat(instance, dbEnv.url);
  let dbPassword: string | null = null;
  if (!kept) {
    const broken = urlStoreRefusal(instance.id, dbEnv.url);
    if (broken) return { success: false, error: broken };
    const read = await managedDbPasswordFilled(instance, { record: true });
    if (!read.ok) {
      return { success: false, error: read.why === 'lost'
        ? "The managed database's password on record no longer decrypts (the manager's encryption key changed or was lost), so Disable cannot set the Database URL back; nothing was disabled"
        : `The managed database's password is not on record (${read.detail}), so Disable cannot set the Database URL back; nothing was disabled` };
    }
    dbPassword = read.password;
  }
  const dbState = await containerState(fleetDb.containerName);
  if (dbState.running !== true) {
    return { success: false, error: dbDownText(dbState, 'Database container is not running - start the instance first so the replication slot can be dropped (a leaked slot retains WAL forever)') };
  }

  const streaming = await clusterSql(fleetDb.containerName,
    `SELECT COALESCE(string_agg(slot_name, ', ' ORDER BY slot_name), '') FROM pg_replication_slots WHERE starts_with(slot_name, '${FLEET_SLOT_PREFIX}') AND active;`);
  if (!streaming.ok) {
    return { success: false, error: `could not read the replication slots (nothing was disabled): ${streaming.stderr.trim()}` };
  }
  if (streaming.stdout.trim() !== '') {
    return { success: false, error: `Standbys are still streaming on slot(s) ${streaming.stdout.trim()}; stop or remove them first (nothing was disabled)` };
  }
  // A seed's base backup and a stream without a slot hold no active slot,
  // and closing the logins would cut them off mid-copy. A blocked login's
  // stream counts too: it is outside the group but still open (R4).
  const senders = await clusterSql(fleetDb.containerName,
    `SELECT COALESCE(string_agg(COALESCE(host(r.client_addr), 'a local socket'), ', ' ORDER BY r.client_addr), '') FROM pg_stat_replication r WHERE r.usename ~ '^smdb_copy_[0-9a-f]{32}$' OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.usesysid AND m.roleid = pg_catalog.to_regrole('${COPY_GROUP}'));`);
  if (!senders.ok) {
    return { success: false, error: `could not read the replication connections (nothing was disabled): ${senders.stderr.trim()}` };
  }
  if (senders.stdout.trim() !== '') {
    return { success: false, error: `Machine logins have replication connections open from ${senders.stdout.trim()} (a standby streaming without a slot, or a seed copying the database); stop or remove them first (nothing was disabled)` };
  }
  // Every refusal above changed nothing. From here on each step changes the
  // database, so the record says a Disable is under way until it finishes:
  // an interrupted one is then shown, and pressing Disable again finishes it.
  const before = containerManager.getBot(instance.id);
  if (fleetDbShape(before?.fleetDb) !== disableRecordAtStart) {
    return { success: false, error: "The instance's database record changed while this Disable ran its checks (nothing was disabled); check the Replication section, then press Disable replication again" };
  }
  let markedRecord: string;
  try {
    const marked = containerManager.updateInstanceFleetDbReplication(instance.id, { ...fleetDb.replication, disablingSince: fleetDb.replication.disablingSince ?? new Date().toISOString() });
    if (!marked?.fleetDb?.replication) return { success: false, error: 'The instance record is gone (nothing was disabled)' };
    markedRecord = fleetDbShape(containerManager.getBot(instance.id)?.fleetDb)!;
  } catch (err) {
    return { success: false, error: `could not record that a Disable is under way (nothing was disabled): ${String(err)}` };
  }
  // Clears a synchronous setting a bot or an arm left in auto.conf, which
  // would wedge this database's next write (B6 map F18). Separate
  // calls, for the reason the enable above records: ALTER SYSTEM refuses to run
  // inside the implicit transaction a multi-statement psql -c wraps its input in.
  const relax = await clusterSql(fleetDb.containerName, 'ALTER SYSTEM RESET synchronous_standby_names;');
  if (!relax.ok) {
    return { success: false, error: `could not relax the synchronous posture, so the Disable did not finish; press Disable replication again to finish it: ${relax.stderr.trim()}` };
  }
  const relaxed = await clusterSql(fleetDb.containerName, 'SELECT pg_reload_conf();');
  if (!relaxed.ok) {
    return { success: false, error: `could not reload after relaxing the synchronous posture, so the Disable did not finish; press Disable replication again to finish it: ${relaxed.stderr.trim()}` };
  }
  const drop = await clusterSql(fleetDb.containerName, `
    DO $$ DECLARE s record; BEGIN
      FOR s IN SELECT slot_name FROM pg_replication_slots WHERE starts_with(slot_name, '${FLEET_SLOT_PREFIX}') AND NOT active LOOP
        PERFORM pg_drop_replication_slot(s.slot_name);
      END LOOP;
    END $$;`);
  if (!drop.ok) {
    return { success: false, error: `slot drop failed, so the Disable did not finish; press Disable replication again to finish it: ${drop.stderr.trim()}` };
  }
  const left = await clusterSql(fleetDb.containerName,
    `SELECT COALESCE(string_agg(slot_name, ', ' ORDER BY slot_name), '') FROM pg_replication_slots WHERE starts_with(slot_name, '${FLEET_SLOT_PREFIX}');`);
  if (!left.ok) {
    return { success: false, error: `could not confirm the replication slots are gone, so the Disable did not finish; press Disable replication again to finish it: ${left.stderr.trim()}` };
  }
  if (left.stdout.trim() !== '') {
    return { success: false, error: `Slot(s) ${left.stdout.trim()} survived the drop (a standby reconnected while it ran); stop or remove the standbys, then press Disable replication again to finish it` };
  }
  const revoke = await clusterSql(fleetDb.containerName, DISABLE_CLOSE_SQL, true);
  const joinEnded = (n: number) => (n === 0 ? '' : n === 1 ? `; ${JOIN_LOGIN}'s open session was ended` : `; ${JOIN_LOGIN}'s ${n} open sessions were ended`);
  if (!revoke.ok && revoke.timedOut) {
    return { success: false, error: `the manager can't confirm whether the join login and the machine logins were closed: the database did not answer within ${dbLogin.PSQL_TIMEOUT_MS / 1000} s, and the change may still be applied there (the slots are dropped); press Disable replication again to finish it` };
  }
  if (!revoke.ok) {
    return { success: false, error: `revoking the join login and the machine logins failed (the slots are dropped; retry to finish disabling): ${sqlReason(revoke.stderr)}${joinEnded(closedCount(revoke.stdout))}` };
  }

  if (fleetDbShape(containerManager.getBot(instance.id)?.fleetDb) !== markedRecord) {
    return { success: false, error: "The instance's database record changed while this Disable ran, so the record and the database URL were not written; the slots are dropped and the join login and the machines' logins are closed. Check the Replication section, then press Disable replication again to finish it" };
  }
  // ssl=on and the authored pg_hba survive the disable, so the local form
  // keeps TLS (see the enable-side note on custom address pools).
  // The bot may still dial its old non-TLS URL until it restarts, so the lines stay until a start narrows them.
  const keptPlain = fleetDb.replication.keptPlain ?? [];
  const plainKept = keptPlain.length > 0 ? { plainClientsKept: keptPlain.length } : {};
  let keptAtWrite: string | null = null;
  try {
    const now = keptUrlWhat(instance, dbEnv.url);
    if (!kept && !now) envManager.setEnvVars(instance.id, { [dbEnv.url]: `${sidecarUrl(instance, dbPassword!)}?sslmode=no-verify` });
    containerManager.updateInstanceFleetDbReplication(instance.id, null, keptPlain);
    keptAtWrite = now ? urlKeptDisable(now) : kept ? URL_KEPT_CHANGED_D : null;
  } catch (err) {
    // The disabling mark stays on the record, so the card shows the Disable as unfinished.
    forgetProbes(instance.id);
    return { success: false, error: `Replication is off on the database (the slots are dropped and the join login and the machines' logins are closed), but the database URL or the replication record could not be saved (${err instanceof Error ? err.message : String(err)}); press Disable replication again to finish it` };
  }
  forgetProbes(instance.id);
  return { success: true, restartRequired: true, ...plainKept, addresses: await sendAddresses(instance.id), ...(keptAtWrite ? { urlKept: keptAtWrite } : {}) };
}

/**
 * Run by the start lane once the containers are up: drops the non-TLS lines an
 * Enable kept for clients that were still on the old URL, once none of those
 * clients connects without TLS any more. Returns a warning, or null.
 */
export async function narrowKeptPlainHba(botId: string): Promise<string | null> {
  const instance = containerManager.getBot(botId);
  const fleetDb = instance?.fleetDb;
  const repl = fleetDb?.replication;
  const keptPlain = repl ? repl.keptPlain : fleetDb?.keptPlain;
  if (!fleetDb || !keptPlain?.length) return null;
  const notNarrowed = 'the database still admits non-TLS connections from the addresses Enable kept, and the next start tries again';
  const fenced = await fenceLinesRefusal(fleetDb.containerName);
  if (fenced) return `pg_hba was not narrowed: ${fenced}; ${notNarrowed}`;
  const live = await plainClientsOutsidePool(fleetDb.containerName);
  if (!live.ok) return `Could not read which clients connect to the database without TLS (${live.error}), so ${notNarrowed}`;
  const plain = { addrs: live.addrs.filter(a => keptPlain.includes(a)) };
  const hbaFile = `${PGDATA}/pg_hba.conf`;
  const hba = await dbExec(fleetDb.containerName, ['sh', '-c',
    `cat > ${hbaFile}.new && chown postgres:postgres ${hbaFile}.new && chmod 600 ${hbaFile}.new && mv -f ${hbaFile}.new ${hbaFile}`], pgHbaContent(fleetDb.db, plain.addrs));
  if (!hba.ok) return `Could not rewrite pg_hba (${hba.stderr.trim()}), so ${notNarrowed}`;
  const reload = await clusterSql(fleetDb.containerName, 'SELECT pg_reload_conf();');
  if (!reload.ok) return `pg_hba was rewritten but the reload failed (${reload.stderr.trim()}); the database applies it at its next reload or restart`;
  try {
    if (repl) {
      const { keptPlain: _kept, ...rest } = repl;
      containerManager.updateInstanceFleetDbReplication(botId, plain.addrs.length > 0 ? { ...rest, keptPlain: plain.addrs } : rest);
    } else {
      containerManager.updateInstanceFleetDbReplication(botId, null, plain.addrs);
    }
  } catch (err) {
    console.warn(`[FleetReplication] ${botId}: pg_hba is narrowed, but the record could not be updated: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (plain.addrs.length > 0) {
    return `${plain.addrs.length} client(s) still connect to the database without TLS from outside 172.16.0.0/12, so the database keeps admitting them that way; the next start checks again`;
  }
  return null;
}

export interface FleetReplicationStatus {
  enabled: boolean;
  /** Set while a Disable that began changing the database has not finished; pressing Disable again finishes it. */
  disablingSince?: string;
  publicHost?: string;
  hostPort?: number;
  live?: {
    sslOn: boolean;
    standbys: Array<{ clientAddr: string; state: string; replayLagSeconds: number | null }>;
    /**
     * Every physical slot on this primary, joined to the link streaming on it
     * (active_pid to pg_stat_replication.pid); an invalidated one means its
     * standby must re-seed. fleet marks the standby slots this manager family
     * mints.
     */
    slots: Array<{ slot: string; fleet: boolean; walStatus: string; active: boolean; retainedBytes: number | null; clientAddr: string | null; state: string | null; replayLagSeconds: number | null; behindBytes: number | null; machine: string | null; address: string | null }>;
    /** Live max_slot_wal_keep_size as postgres reports it ('-1' = unbounded, pre-RC-1 clusters). */
    slotWalKeep: string;
    /** Every machine login on this main (LOGINS_READ_SQL); absent when the read failed. */
    logins?: MachineLoginStatus[];
  };
  /** Can a container on the default bridge reach the published endpoint (the
   * path a node on another host dials)? Catches firewall traps before
   * a cross-host standby is pointed at a dead port. */
  reachability?: { ok: boolean; unchecked?: true; error?: string; ageSeconds: number };
  /** The database could not be read (live stays absent): docker's or psql's last line. Absent with no live means docker said it is stopped. */
  probeError?: string;
}

const PROBE_CACHE_MS = 60_000;
const PROBE_TIMEOUT_MS = 20_000;
type Reachability = { ok: boolean; unchecked?: true; error?: string };
const probeCache: Map<string, Reachability & { at: number }> = new Map();

function forgetProbes(botId: string): void {
  for (const key of [...probeCache.keys()]) if (key.startsWith(`${botId}|`)) probeCache.delete(key);
}

async function probeEndpoint(instance: InstanceConfig): Promise<Reachability> {
  const repl = instance.fleetDb!.replication!;
  const read = await managedDbPasswordFilled(instance, { record: false });
  if (!read.ok) {
    return { ok: false, unchecked: true, error: read.why === 'lost' ? "the bot's database password on record no longer decrypts" : `the bot's database password is not on record (${read.detail})` };
  }
  const dbPassword = read.password;
  const url = `postgresql://${instance.fleetDb!.user}@${repl.publicHost}:${repl.hostPort}/${instance.fleetDb!.db}?sslmode=require&connect_timeout=8`;
  // The password rides the docker CLI's environment (`-e NAME` with no value), never its argv.
  return new Promise(resolve => {
    execFileGuarded('docker', ['run', '--rm', '-e', 'PGPASSWORD', 'postgres:16-alpine', 'psql', '-X', url, '-Atc', 'SELECT 1'],
      { timeout: PROBE_TIMEOUT_MS, env: { ...process.env, PGPASSWORD: dbPassword } }, (err, stdout, stderr) => {
        if (!err && String(stdout).trim() === '1') resolve({ ok: true });
        else resolve({ ok: false, error: redactSecrets(childFailureText(keptLines(String(stderr ?? '')).join('\n'), err) || 'no response', [dbPassword]).split('\n').pop() });
      });
  });
}

async function cachedReachability(instance: InstanceConfig): Promise<Reachability & { ageSeconds: number }> {
  const repl = instance.fleetDb!.replication!;
  const key = `${instance.id}|${repl.publicHost}:${repl.hostPort}`;
  const cached = probeCache.get(key);
  if (cached && Date.now() - cached.at < PROBE_CACHE_MS) {
    return { ok: cached.ok, ...(cached.unchecked ? { unchecked: true as const } : {}), error: cached.error, ageSeconds: Math.round((Date.now() - cached.at) / 1000) };
  }
  const result = await probeEndpoint(instance);
  probeCache.set(key, { ...result, at: Date.now() });
  return { ...result, ageSeconds: 0 };
}

/**
 * opts.probeEndpoint false skips the reachability run: the background health
 * sampler wants the database probe only and must not spawn a container per tick.
 */
export async function getFleetReplicationStatus(
  instance: InstanceConfig,
  opts: { probeEndpoint?: boolean } = {},
): Promise<FleetReplicationStatus> {
  const repl = instance.fleetDb?.replication;
  if (!repl) return { enabled: false };
  const status: FleetReplicationStatus = {
    enabled: true,
    publicHost: repl.publicHost,
    hostPort: repl.hostPort,
  };
  if (repl.disablingSince) status.disablingSince = repl.disablingSince;
  const fleetDb = instance.fleetDb!;
  const dbState = await containerState(fleetDb.containerName);
  if (dbState.running === null) status.probeError = dbState.error;
  if (dbState.running !== true) return status;

  const probe = await clusterSql(fleetDb.containerName,
    `SELECT current_setting('ssl'),
            (SELECT json_agg(json_build_object(
               'clientAddr', client_addr::text,
               'state', state,
               'replayLagSeconds', EXTRACT(EPOCH FROM replay_lag)))
             FROM pg_stat_replication),
            (SELECT json_agg(json_build_object(
               'slot', s.slot_name,
               'walStatus', s.wal_status,
               'active', s.active,
               'retainedBytes', GREATEST(pg_wal_lsn_diff(pg_current_wal_lsn(), s.restart_lsn), 0),
               'clientAddr', r.client_addr::text,
               'state', r.state,
               'replayLagSeconds', EXTRACT(EPOCH FROM r.replay_lag),
               'behindBytes', CASE WHEN r.replay_lsn IS NULL THEN NULL ELSE GREATEST(pg_wal_lsn_diff(pg_current_wal_lsn(), r.replay_lsn), 0) END))
             FROM pg_replication_slots s LEFT JOIN pg_stat_replication r ON r.pid = s.active_pid
             WHERE s.slot_type = 'physical'),
            current_setting('max_slot_wal_keep_size');`);
  if (probe.ok) {
    const [sslOn, standbysJson, slotsJson, slotWalKeep] = probe.stdout.trim().split('|');
    let standbys: Array<{ clientAddr: string; state: string; replayLagSeconds: number | null }> = [];
    try {
      const parsed = JSON.parse(standbysJson || 'null');
      if (Array.isArray(parsed)) {
        standbys = parsed.map((s: any) => ({
          clientAddr: String(s.clientAddr || ''),
          state: String(s.state || ''),
          replayLagSeconds: s.replayLagSeconds === null || s.replayLagSeconds === undefined ? null : Number(s.replayLagSeconds),
        }));
      }
    } catch { /* no standbys */ }
    let slots: NonNullable<FleetReplicationStatus['live']>['slots'] = [];
    try {
      const parsed = JSON.parse(slotsJson || 'null');
      if (Array.isArray(parsed)) {
        slots = parsed.map((s: any) => ({
          slot: String(s.slot || ''),
          fleet: String(s.slot || '').startsWith(FLEET_SLOT_PREFIX),
          walStatus: String(s.walStatus || ''),
          active: s.active === true,
          retainedBytes: s.retainedBytes === null || s.retainedBytes === undefined ? null : Number(s.retainedBytes),
          clientAddr: s.clientAddr ? String(s.clientAddr) : null,
          state: s.state ? String(s.state) : null,
          replayLagSeconds: s.replayLagSeconds === null || s.replayLagSeconds === undefined ? null : Number(s.replayLagSeconds),
          behindBytes: s.behindBytes === null || s.behindBytes === undefined ? null : Number(s.behindBytes),
          machine: null,
          address: null,
        }));
      }
    } catch { /* no slots */ }
    const listed = await metaSql(fleetDb.containerName, fleetDb.db, ADDRESS_BY_SLOT_SQL);
    let rows: unknown[] = [];
    if (listed.ok) {
      try {
        const parsed = JSON.parse(listed.stdout.trim() || '[]');
        if (Array.isArray(parsed)) rows = parsed;
      } catch { /* no machine names */ }
    }
    const rowOf = (slot: string): any => rows.find((r: any) => r && r.slot === slot) ?? null;
    for (const slot of slots) {
      const row = rowOf(slot.slot);
      if (row) {
        slot.machine = String(row.machine || '');
        slot.address = `${row.host}:${row.port}`;
      }
    }
    status.live = { sslOn: sslOn === 'on', standbys, slots, slotWalKeep: (slotWalKeep || '').trim() };
    const logins = await clusterSql(fleetDb.containerName, LOGINS_READ_SQL);
    const parsedLogins = logins.ok ? parseLogins(logins.stdout, copyLogin(instance.id), rowOf) : null;
    if (parsedLogins) status.live.logins = parsedLogins;
  } else {
    status.probeError = probeErrorTail(probe.stderr);
  }
  if (opts.probeEndpoint !== false) status.reachability = await cachedReachability(instance);
  return status;
}

/**
 * Drop one INACTIVE fleet slot on this primary: the orphan a removed or
 * decommissioned standby leaves behind, which retains WAL until dropped. An
 * active slot has a standby on it and is never dropped from here.
 */
export async function dropFleetSlot(instance: InstanceConfig, slot: string): Promise<{ success: boolean; error?: string }> {
  const fleetDb = instance.fleetDb;
  if (!fleetDb?.replication) return { success: false, error: 'Replication is not enabled' };
  if (!/^[a-z0-9_]{1,63}$/.test(slot) || !slot.startsWith(FLEET_SLOT_PREFIX)) {
    return { success: false, error: 'Only a fleet standby slot can be dropped here' };
  }
  const dbState = await containerState(fleetDb.containerName);
  if (dbState.running !== true) return { success: false, error: dbDownText(dbState, 'Database container is not running') };
  const result = await clusterSql(fleetDb.containerName, `
    DO $$ DECLARE s record; BEGIN
      SELECT active INTO s FROM pg_replication_slots WHERE slot_name = '${slot}';
      IF NOT FOUND THEN RAISE EXCEPTION 'no slot named ${slot}'; END IF;
      IF s.active THEN RAISE EXCEPTION 'a standby is streaming on ${slot}; stop or remove it first'; END IF;
      PERFORM pg_drop_replication_slot('${slot}');
    END $$;`);
  const errorOf = (stderr: string) => {
    const lines = stderr.trim().split('\n').filter(l => l && !/(^|: )(WARNING|NOTICE): /.test(l));
    return (lines.find(l => l.startsWith('ERROR')) || lines.pop() || 'psql failed').replace(/^ERROR:\s*/, '');
  };
  if (!result.ok) return { success: false, error: errorOf(result.stderr) };
  const row = await metaSql(fleetDb.containerName, fleetDb.db, `DO $$ BEGIN
      IF to_regclass('smdb_manager.addresses') IS NOT NULL THEN
        EXECUTE format('DELETE FROM smdb_manager.addresses WHERE slot = %L', '${slot}');
      END IF;
    END $$;`);
  if (!row.ok) return { success: false, error: `the slot ${slot} was dropped, but its row in the address list could not be removed (${errorOf(row.stderr)})` };
  return { success: true };
}

const ADDRESS_BY_SLOT_SQL = `SELECT CASE WHEN to_regclass('smdb_manager.addresses') IS NULL THEN '[]'::json ELSE
  (SELECT COALESCE(json_agg(json_build_object('slot', slot, 'machine', machine, 'host', host, 'port', port)), '[]'::json)
   FROM smdb_manager.addresses WHERE slot IS NOT NULL) END;`;

/** The address list as dbm_meta inside the caller's transaction: the table, the two functions machine logins write through, and this main's own row. */
export function addressTableSql(host: string, port: number, certPem: string, machine: string): string {
  return `${ADDRESS_DDL_SQL}${OWN_ADDRESS_SQL(host, port, certPem, machine)}`;
}

/**
 * The join code another machine's manager pastes: this database's address, its certificate fingerprint, the
 * replication login and the bot's database login. The code holds passwords; the route sits behind manager auth.
 * While the database waits for a push or a push left it unfinished, nothing is provisioned (a push makes
 * smdb_manager itself): Receive's own code is made without it, and any other caller is refused.
 */
export async function getJoinCode(instance: InstanceConfig, opts: { forReceive?: boolean } = {}): Promise<{ success: boolean; error?: string; joinCode?: string; note?: string }> {
  const fleetDb = instance.fleetDb;
  const repl = fleetDb?.replication;
  const refused = joinCodeRefusal(fleetDb, { renew: false, forReceive: opts.forReceive });
  if (refused || !fleetDb || !repl) return { success: false, error: refused ?? 'Replication is not enabled, so there is no join code.' };
  const pushPending = !!(fleetDb.receive || fleetDb.pushBroken);
  const dbState = await containerState(fleetDb.containerName);
  if (dbState.running !== true) {
    return { success: false, error: dbDownText(dbState, 'The database container is not running, so its certificate cannot be read for the join code') };
  }
  const rolesRefusal = (r: dbLogin.ProvisionResult) => (r.ok ? null : { success: false, error: r.cls === 'in-recovery'
    ? "This database is a live copy, so it makes no join code; copy the code from the main's manager"
    : `The bot's database login could not be confirmed as limited to its own database (${r.error}), so no join code was made` });
  const roles = pushPending ? await adminPasswordRefusal(instance) : await provisionManagedRoles(instance, { reread: true });
  const refusedRoles = rolesRefusal(roles);
  if (refusedRoles) return refusedRoles;
  const copyRoles = await clusterSql(fleetDb.containerName, COPY_ROLES_READ_SQL);
  if (!copyRoles.ok) return { success: false, error: `The logins that machines get with the join code could not be checked (${sqlReason(copyRoles.stderr)}), so no join code was made` };
  const keys = parseCopyRoles(copyRoles.stdout);
  if (!keys || keys.some(k => k !== 'role-settings')) {
    const found = keys ? keys.join(', ') : copyRoles.stdout.trim().slice(0, 200);
    return { success: false, error: `The logins that machines get with the join code are not set up as the manager needs (${found}), so no join code was made; press Enable replication to set them up again` };
  }
  let note: string | undefined;
  if (keys.includes('role-settings')) {
    const holders = await clusterSql(fleetDb.containerName, SETTINGS_HOLDERS_SQL);
    note = settingsNote(instance, holders.ok ? holders.stdout.trim() : null);
  }
  const cert = await dbExec(fleetDb.containerName, ['cat', `${PGDATA}/server.crt`]);
  if (!cert.ok) return { success: false, error: `The database's certificate could not be read, so no join code was made: ${probeErrorTail(cert.stderr)}` };
  let fp: string;
  try {
    fp = certFingerprint(cert.stdout);
  } catch (err) {
    return { success: false, error: `The database's certificate could not be read, so no join code was made: ${err instanceof Error ? err.message : String(err)}` };
  }
  const app = await managedDbPasswordFilled(instance, { record: true });
  if (!app.ok) {
    return { success: false, error: app.why === 'lost'
      ? "The managed database's password on record no longer decrypts (the manager's encryption key changed or was lost), so no join code was made; restore the key"
      : `The managed database's password is not on record (${app.detail}), so no join code was made` };
  }
  if (!pushPending) {
    const refusedAgain = rolesRefusal(await confirmedAfterFill(instance));
    if (refusedAgain) return refusedAgain;
  }
  const appPassword = app.password;
  const joinCode = encodeJoinCode({
    v: 1,
    host: repl.publicHost,
    port: repl.hostPort,
    db: fleetDb.db,
    fp,
    machine: machineText(repl.publicHost),
    repl: { user: JOIN_LOGIN, password: repl.password },
    app: { user: fleetDb.user, password: appPassword },
  });
  return { success: true, joinCode, ...(note ? { note } : {}) };
}

/** getJoinCode's and New join code's refusals from the record; the lost join password refuses a code but not its renewal (R23). */
export function joinCodeRefusal(fleetDb: InstanceConfig['fleetDb'], opts: { renew: boolean; forReceive?: boolean }): string | null {
  const repl = fleetDb?.replication;
  if (!fleetDb || !repl) return 'Replication is not enabled, so there is no join code.';
  if ((fleetDb.receive || fleetDb.pushBroken) && !opts.forReceive) {
    return fleetDb.receive
      ? 'This machine is receiving a bot; make the join code after the push ends (nothing was changed)'
      : `A push into this database did not finish; restore the dump ${fleetDb.pushBroken!.safetyDump} or receive a push again, then make the join code (nothing was changed)`;
  }
  if (repl.disablingSince) return "A Disable of replication did not finish, so the join login and the machines' logins may already be closed: press Disable replication to finish it";
  if (!opts.renew && !repl.password) {
    return 'The stored join password no longer decrypts (the manager encryption key changed or was lost). Restore the key, or press New join code to make a new one; machines that joined keep their own logins.';
  }
  return null;
}

/** Enable's role step as one transaction under the 5 s lock limit; it ends no session, since it writes every machine's login. */
export function enableRoleStepSql(o: Parameters<typeof copyRolesStepSql>[0]): string {
  return `BEGIN;\n${ROLE_LOCK_LIMIT_SQL}${QUIET_ROLE_SESSION_SQL}${copyRolesStepSql(o)}COMMIT;\n`;
}

/** A database of this machine's lineage that still holds this machine's own login's password: New join code keeps it then (R25). */
function ownPasswordHolder(instance: InstanceConfig): string | null {
  const fleetDb = instance.fleetDb;
  const handover = fleetDb?.handover?.mode === 'stream' ? fleetDb.handover.machine : undefined;
  return fleetDb?.replacedBy?.machine ?? fleetDb?.mainConflict?.machine ?? fleetDb?.formerMain?.machine ?? handover ?? null;
}

/** Whether the main's tick runs its machine-login steps on this database, the blocked logins' sessions among them (3.8). */
export function machineLoginsTickRuns(fleetDb: InstanceConfig['fleetDb']): boolean {
  return !!fleetDb?.replication && !fleetDb.receive && !fleetDb.pushBroken && !fleetDb.replacedBy;
}

/** JC-SETTINGS (R41): each login with session settings, with the step that clears them. */
function settingsNote(instance: InstanceConfig, holders: string | null): string {
  const names = holders === null ? [] : holders.split(',').filter(Boolean);
  if (names.length === 0) return "Some logins carry session settings of their own, which the manager's sessions override; Enable replication clears them.";
  const own = copyLogin(instance.id);
  const stepOf = (name: string): string => {
    if (name === JOIN_LOGIN) return 'press New join code';
    if (name === own) return ownPasswordHolder(instance) === null ? 'press New join code' : 'press Enable replication';
    if (COPY_LOGIN_RE.test(name)) return 'remove it in the Machine logins list';
    return 'press Enable replication';
  };
  return `Some logins carry session settings of their own, which the manager's sessions override: ${names.map(n => `${n} (${stepOf(n)})`).join('; ')}.`;
}

const keptLines = (text: string) => text.trim().split('\n').map(l => l.trim()).filter(l => l && !/(^|: )(WARNING|NOTICE): /.test(l));

/** The first error line of a psql run, without psql's prefix; WARNING and NOTICE lines are never the reason. */
function sqlReason(stderr: string): string {
  const lines = keptLines(stderr);
  const line = lines.find(l => /\b(FATAL|ERROR):/.test(l)) || lines[lines.length - 1] || 'psql failed';
  return line.replace(/^psql:[^ ]*: /, '').replace(/^(ERROR|FATAL):\s+/, '').replace(/^psql: error: /, '').replace(/^error: /, '');
}

/** LOGINS_READ_SQL's list with this machine's own login and each login's address row; null for an answer of another shape. */
function parseLogins(out: string, own: string, rowOf: (slot: string) => any): MachineLoginStatus[] | null {
  let parsed: unknown;
  try { parsed = JSON.parse(out.trim()); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  const logins: MachineLoginStatus[] = [];
  for (const e of parsed as any[]) {
    if (!e || typeof e.login !== 'string' || !COPY_LOGIN_RE.test(e.login) || typeof e.member !== 'boolean' || typeof e.canLogin !== 'boolean') return null;
    const slot = typeof e.slot === 'string' ? e.slot : null;
    const row = rowOf(`fleet_standby_${e.login.slice('smdb_copy_'.length)}`);
    logins.push({
      login: e.login,
      own: e.login === own,
      member: e.member,
      canLogin: e.canLogin,
      slot,
      slotState: slot === null ? 'absent' : e.active === true ? 'active' : e.walStatus === 'lost' ? 'lost' : 'kept',
      machine: row ? String(row.machine || '') : null,
      address: row ? `${row.host}:${row.port}` : null,
      client: typeof e.client === 'string' && e.client !== '' ? e.client : null,
    });
  }
  return logins;
}

type RenewResult = { success: boolean; error?: string; text?: string };

/**
 * New join code (3.6.5 as R1, R18 and R25 give it): a new join password, and a new password for this machine's own
 * login unless another database still holds the current one. The own password is saved before the database changes
 * and written back when the transaction did not commit.
 */
export function renewJoinCode(instance: InstanceConfig): Promise<RenewResult> {
  return inReplicationLane<RenewResult>(instance.id, 'New join code', async () => {
    const fresh = containerManager.getBot(instance.id);
    if (!fresh) return { success: false, error: 'Bot not found (nothing was changed)' };
    return renewInLane(fresh);
  });
}

async function renewInLane(instance: InstanceConfig): Promise<RenewResult> {
  const fleetDb = instance.fleetDb;
  const refused = joinCodeRefusal(fleetDb, { renew: true });
  if (refused || !fleetDb?.replication) return { success: false, error: refused ?? 'Replication is not enabled, so there is no join code.' };
  const repl = fleetDb.replication;
  const dbState = await containerState(fleetDb.containerName);
  if (dbState.running !== true) {
    return { success: false, error: dbDownText(dbState, 'The database container is not running, so the join code was not renewed') };
  }
  const failText = (reason: string) => `The join code was not renewed (${reason}); the current code still works, and nothing was changed.`;
  const holder = ownPasswordHolder(instance);
  const ownLogin = copyLogin(instance.id);
  const joinPassword = crypto.randomBytes(24).toString('base64url');
  const ownPassword = holder === null ? crypto.randomBytes(24).toString('base64url') : null;
  const earlier = instance.fleetLogin?.password;
  if (ownPassword !== null) {
    if (!COPY_LOGIN_RE.test(ownLogin)) return { success: false, error: failText(`${ownLogin} is not a machine login name`) };
    try {
      containerManager.updateInstanceFleetLogin(instance.id, { password: ownPassword });
    } catch (err) {
      return { success: false, error: failText(err instanceof Error ? err.message : String(err)) };
    }
  }
  const joinVerifier = scramSha256Verifier(joinPassword);
  const ownVerifier = ownPassword === null ? null : scramSha256Verifier(ownPassword);
  const secrets = [joinPassword, joinVerifier, ...(ownPassword === null ? [] : [ownPassword, ownVerifier!])];
  const own = ownPassword !== null;
  const sql = `${QUIET_ROLE_SESSION_SQL}BEGIN;
${lockedRoleWriteSql(own ? [JOIN_LOGIN, ownLogin] : [JOIN_LOGIN])}ALTER ROLE ${JOIN_LOGIN} LOGIN PASSWORD '${joinVerifier}';
${own ? `ALTER ROLE "${ownLogin}" LOGIN PASSWORD '${ownVerifier}';\n` : ''}${ROLE_SETTINGS_RESET_SQL(JOIN_LOGIN)}${own ? ROLE_SETTINGS_RESET_SQL(ownLogin) : ''}${COMMITTING_SQL}COMMIT;
SELECT 'renewed';
SELECT 'ended|' || pg_catalog.count(pg_catalog.pg_terminate_backend(a.pid, 5000)) FROM pg_catalog.pg_stat_activity a WHERE a.usename IN ('${JOIN_LOGIN}'${own ? `, '${ownLogin}'` : ''}) AND a.pid <> pg_catalog.pg_backend_pid();
SELECT 'unlinked|' || pg_catalog.count(pg_catalog.lo_unlink(l.oid)) FROM pg_catalog.pg_largeobject_metadata l;
${own ? `DO $$ BEGIN
  PERFORM pg_catalog.pg_drop_replication_slot(slot_name) FROM pg_catalog.pg_replication_slots WHERE slot_name = '${copySlot(instance.id)}' AND NOT active;
EXCEPTION WHEN object_in_use THEN NULL;
END $$;
` : ''}`;
  const run = await clusterSql(fleetDb.containerName, sql, true);
  const lines = run.stdout.split('\n').map(l => l.trim());
  const reason = () => redactSecrets(sqlReason(run.stderr), secrets);
  if (!lines.includes('renewed') && !run.ok && run.timedOut) {
    return { success: false, error: `The manager can't confirm whether the join code was renewed: the database did not answer within ${dbLogin.PSQL_TIMEOUT_MS / 1000} s, and the change may still be applied there. Press New join code again.` };
  }
  if (!lines.includes('renewed') && !stoppedBeforeCommit(run.stdout, run)) {
    return { success: false, error: `The manager can't confirm whether the join code was renewed: the manager did not read the result (${run.ok ? "the database's answer held no result line" : hasPsqlStopLine(run.stderr) ? reason() : 'the call ended without an answer from psql'}), and the change may be applied there. Press New join code again.` };
  }
  if (!lines.includes('renewed')) {
    const closed = closedCount(run.stdout);
    const names = (joiner: string) => (own ? `${JOIN_LOGIN} ${joiner} ${ownLogin}` : JOIN_LOGIN);
    const ranFail = (why: string) => (closed === 0 ? failText(why)
      : `The join code was not renewed (${why}); the current code still works. ${closed === 1 ? `One open session of ${names('or')} was` : `The ${closed} open sessions of ${names('and')} were`} ended; nothing else was changed.`);
    if (ownPassword === null) return { success: false, error: ranFail(reason()) };
    try {
      containerManager.updateInstanceFleetLogin(instance.id, earlier ? { password: earlier } : null);
    } catch (err) {
      return { success: false, error: `The join code was not renewed (${reason()}), and the manager could not put back this machine's own password on record (${err instanceof Error ? err.message : String(err)}), so this machine's own login does not open with it now; press New join code again.` };
    }
    return { success: false, error: ranFail(reason()) };
  }
  let notes = '';
  const note = (step: string, why: string) => { notes += ` The renewal stands, but ${step} failed (${why}).`; };
  if (!run.ok) {
    const step = !lines.some(l => l.startsWith('ended|')) ? 'ending the old sessions'
      : !lines.some(l => l.startsWith('unlinked|')) ? 'removing large objects from the postgres database'
        : "removing a slot or address of this machine's own login";
    note(step, reason());
  }
  if (own) {
    const row = await metaSql(fleetDb.containerName, fleetDb.db, `DELETE FROM smdb_manager.addresses WHERE slot = '${copySlot(instance.id)}';`);
    if (!row.ok) note("removing a slot or address of this machine's own login", sqlReason(row.stderr));
  }
  const done = own
    ? "Made a new join code and gave this machine's own login a new password. The old code no longer adds machines; machines that joined before keep their logins."
    : `Made a new join code. The old code no longer adds machines; machines that joined before keep their logins. This machine's own login kept its password, because the database on ${holder} still holds it for this machine.`;
  let saveError: string | null = null;
  try {
    if (!containerManager.updateInstanceFleetDbReplication(instance.id, { ...repl, password: joinPassword })) saveError = "the bot's record is no longer in the registry";
  } catch (err) {
    saveError = err instanceof Error ? err.message : String(err);
  }
  if (saveError !== null) {
    return { success: false, error: `The old join code no longer adds machines, but the new password could not be saved (${redactSecrets(saveError, secrets)}), so no code can be shown for it; press New join code again.${notes}` };
  }
  forgetProbes(instance.id);
  return { success: true, text: `${done}${notes}` };
}

type RemoveResult = { success: boolean; error?: string; text?: string; needsConfirm?: true };

const REMOVE_WAIT_MS = 10_000;
const REMOVE_POLL_MS = 250;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Remove a machine's login (3.7 as R4, R18 and R31 give it): blocked first in one transaction, then its sessions
 * ended, its slot dropped, its address row deleted, what it owns dropped, and the role dropped. Each step is
 * rerun-safe, and a Remove that stops leaves the login blocked.
 */
export function removeCopyLogin(instance: InstanceConfig, login: string, confirm: boolean): Promise<RemoveResult> {
  return inReplicationLane<RemoveResult>(instance.id, 'Remove', async () => {
    const fresh = containerManager.getBot(instance.id);
    if (!fresh) return { success: false, error: 'Bot not found (nothing was changed)' };
    return removeInLane(fresh, login, confirm);
  });
}

async function removeInLane(instance: InstanceConfig, login: string, confirm: boolean): Promise<RemoveResult> {
  const fleetDb = instance.fleetDb;
  if (!fleetDb) return { success: false, error: 'This instance hosts no managed fleet database' };
  const unknown = { success: false, error: `No machine login named ${String(login).slice(0, 80)} exists on this database; reload the Database window.` };
  if (typeof login !== 'string' || !COPY_LOGIN_RE.test(login)) return unknown;
  if (login === copyLogin(instance.id)) {
    return { success: false, error: `${login} is this machine's own login, which it uses to rejoin another machine as a copy; it is not removed here.` };
  }
  const container = fleetDb.containerName;
  const dbState = await containerState(container);
  if (dbState.running !== true) return { success: false, error: dbDownText(dbState, 'Database container is not running') };
  const fenced = await fenceLinesRefusal(container);
  if (fenced) return { success: false, error: `The login ${login} was not removed: ${fenced}; nothing was changed.` };
  const slot = `fleet_standby_${login.slice('smdb_copy_'.length)}`;
  const slotStateSql = `SELECT coalesce((SELECT active::text FROM pg_catalog.pg_replication_slots WHERE slot_name = '${slot}'), 'absent')`;
  const admission = await clusterSql(container, `SELECT 'login|' || (EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${login}'))::text
  || '|' || coalesce((SELECT s.active::text FROM pg_catalog.pg_replication_slots s WHERE s.slot_name = '${slot}'), 'absent')
  || '|' || coalesce((SELECT pg_catalog.host(st.client_addr) FROM pg_catalog.pg_replication_slots s JOIN pg_catalog.pg_stat_replication st ON st.pid = s.active_pid WHERE s.slot_name = '${slot}'), '');`);
  if (!admission.ok) return { success: false, error: `The login ${login} was not removed: reading it failed (${sqlReason(admission.stderr)}); nothing was changed.` };
  const read = /^login\|(true|false)\|(true|false|absent)\|(.*)$/.exec(admission.stdout.trim().split('\n').pop() ?? '');
  if (!read) return { success: false, error: `The login ${login} was not removed: the database answered in a form the manager does not read; nothing was changed.` };
  if (read[1] !== 'true') return unknown;
  if (read[2] === 'true' && confirm !== true) {
    const listed = await metaSql(container, fleetDb.db, ADDRESS_BY_SLOT_SQL);
    let machine: string | null = null;
    if (listed.ok) {
      try {
        const rows = JSON.parse(listed.stdout.trim() || '[]');
        const row = Array.isArray(rows) ? rows.find((r: any) => r && r.slot === slot) : null;
        if (row && row.machine) machine = String(row.machine);
      } catch { /* the client address names it */ }
    }
    const where = machine ?? (read[3] || 'a local socket');
    return { success: false, needsConfirm: true, error: `The machine with the login ${login} streams from this database now (${where}). Removing its login ends that stream, drops its slot and takes its address off the list: its copy stops following this database, and other machines stop listing it within an hour. Its manager can join again while it holds this join code; make a new join code too if that machine should stay out. Remove it?` };
  }

  const blockedTail = !fleetDb.replication ? 'It is blocked: it cannot log in. Press Remove again to finish.'
    : machineLoginsTickRuns(fleetDb)
      ? 'It is blocked: it cannot log in, other machines stop listing it within an hour, and this database ends its open sessions within 5 minutes. Press Remove again to finish.'
      : 'It is blocked: it cannot log in, and other machines stop listing it within an hour. Press Remove again to finish.';
  const stepFailed = (step: string, reason: string): RemoveResult => ({ success: false, error: `The login ${login} was not removed completely: ${step} failed (${reason}). ${blockedTail}` });

  const block = await clusterSql(container, REMOVE_BLOCK_SQL(login), true);
  const blocked = parseRemoveBlock(block.stdout, block);
  if ((blocked.state === 'none' || blocked.state === 'unconfirmed') && !block.ok && block.timedOut) {
    return { success: false, error: `The manager can't confirm whether the login ${login} was blocked: the database did not answer within ${dbLogin.PSQL_TIMEOUT_MS / 1000} s, and the block may still be applied there. Press Remove again to finish.` };
  }
  if (blocked.state === 'unconfirmed') {
    return { success: false, error: `The manager can't confirm whether the login ${login} was blocked: the manager did not read the result (${block.ok ? "the database's answer held no result line" : hasPsqlStopLine(block.stderr) ? sqlReason(block.stderr) : 'the call ended without an answer from psql'}), and the block may be applied there. Press Remove again to finish.` };
  }
  if (blocked.state === 'none') {
    const closed = closedCount(block.stdout);
    const changed = closed === 0 ? 'nothing was changed' : `${closed === 1 ? 'its open session was' : `its ${closed} open sessions were`} ended; nothing else was changed`;
    return { success: false, error: `The login ${login} was not removed: blocking it failed (${sqlReason(block.stderr)}); ${changed}.` };
  }
  if (blocked.state === 'again') {
    const fields = blocked.line.split('|');
    const what = fields[1] !== 'true' && fields[2] !== 'true' ? 'its membership in smdb_copies and its right to log in'
      : fields[1] !== 'true' ? 'its membership in smdb_copies' : 'its right to log in';
    return { success: false, error: `The login ${login} was blocked, but the check that followed found ${what} back; something with rights over roles changed it. Press Remove again to block it again and finish.` };
  }

  const ended = await clusterSql(container, `SELECT pg_catalog.count(pg_catalog.pg_terminate_backend(pid, 5000)) FROM pg_catalog.pg_stat_activity WHERE usename = '${login}' AND pid <> pg_catalog.pg_backend_pid();`);
  if (!ended.ok) return stepFailed('ending its sessions', sqlReason(ended.stderr));
  for (let waited = 0; ; waited += REMOVE_POLL_MS) {
    const left = await clusterSql(container, `SELECT pg_catalog.count(*) FROM pg_catalog.pg_stat_activity WHERE usename = '${login}'`);
    if (!left.ok) return stepFailed('ending its sessions', sqlReason(left.stderr));
    const n = left.stdout.trim();
    if (n === '0') break;
    if (waited >= REMOVE_WAIT_MS) return stepFailed('ending its sessions', /^\d+$/.test(n) ? `${n} of its sessions were still open after 10 seconds` : 'the count of its sessions could not be read');
    await pause(REMOVE_POLL_MS);
  }

  const slotStep = `dropping its slot ${slot}`;
  const slotState = async (): Promise<string> => {
    const r = await clusterSql(container, slotStateSql);
    if (!r.ok) throw new Error(sqlReason(r.stderr));
    return r.stdout.trim();
  };
  try {
    let state = await slotState();
    if (state !== 'absent') {
      if (state === 'true') {
        const end = await clusterSql(container, `SELECT pg_catalog.pg_terminate_backend(active_pid) FROM pg_catalog.pg_replication_slots WHERE slot_name = '${slot}' AND active_pid IS NOT NULL;`);
        if (!end.ok) return stepFailed(slotStep, sqlReason(end.stderr));
        for (let waited = 0; state === 'true'; waited += REMOVE_POLL_MS) {
          if (waited >= REMOVE_WAIT_MS) return stepFailed(slotStep, 'a stream still held it after 10 seconds');
          await pause(REMOVE_POLL_MS);
          state = await slotState();
        }
      }
      if (state !== 'absent') {
        const drop = await clusterSql(container, `SELECT pg_catalog.pg_drop_replication_slot(slot_name) FROM pg_catalog.pg_replication_slots WHERE slot_name = '${slot}' AND NOT active;`);
        if (!drop.ok) return stepFailed(slotStep, sqlReason(drop.stderr));
        state = await slotState();
        if (state !== 'absent') return stepFailed(slotStep, state === 'true' ? 'a stream took it again' : 'it was still there after the drop');
      }
    }
  } catch (err) {
    return stepFailed(slotStep, err instanceof Error ? err.message : String(err));
  }

  const row = await metaSql(container, fleetDb.db, `DO $$ BEGIN
  IF to_regclass('smdb_manager.addresses') IS NOT NULL THEN
    DELETE FROM smdb_manager.addresses WHERE slot = '${slot}';
  END IF;
END $$;`);
  if (!row.ok) return stepFailed('taking its address off the list', sqlReason(row.stderr));

  const ownedHere = await clusterSql(container, `DROP OWNED BY "${login}";`);
  if (!ownedHere.ok) return stepFailed('dropping what it owns in the postgres database', sqlReason(ownedHere.stderr));

  const opened = await clusterSql(container, `${ROLE_SETTINGS_RESET_SQL(login)}ALTER ROLE "${login}" LOGIN PASSWORD NULL;\n`, true);
  const ownedThere = opened.ok ? await dbLogin.runCall(container, dbLogin.loginPsql(login, container, fleetDb.db, 'DROP OWNED BY CURRENT_USER')) : null;
  const closed = await clusterSql(container, `ALTER ROLE "${login}" NOLOGIN PASSWORD NULL;`);
  if (!closed.ok) {
    return { success: false, error: `The login ${login} was not removed completely: closing it again after dropping what it owned failed (${sqlReason(closed.stderr)}). It has no password, and other machines stop listing it within an hour, so no machine can log in with it from outside this database's container. Press Remove again to finish.` };
  }
  if (!opened.ok) return stepFailed("dropping what it owns in the bot's database", sqlReason(opened.stderr));
  if (ownedThere && !ownedThere.ok) return stepFailed("dropping what it owns in the bot's database", sqlReason(ownedThere.stderr));

  const dropped = await clusterSql(container, `DROP ROLE IF EXISTS "${login}";`);
  if (!dropped.ok) {
    if (dropped.stderr.includes('cannot be dropped because some objects depend on it')) {
      const detail = dropped.stderr.split('\n').map(l => l.trim()).find(l => l.startsWith('DETAIL:'))?.replace(/^DETAIL:\s+/, '') ?? sqlReason(dropped.stderr);
      return { success: false, error: `The login ${login} is blocked (it cannot log in, and other machines stop listing it within an hour), but it was not dropped: Postgres still records ${detail}. That is a right the bot's own login granted it in the bot's database, as a grant or a default privilege, which only the bot's login can take back. Press Remove again once it is revoked.` };
    }
    return stepFailed('dropping the login', sqlReason(dropped.stderr));
  }
  return { success: true, text: `Removed the login ${login}: its sessions were ended, its slot dropped, its address taken off the list and what it owned dropped. A machine that holds this database's join code can join again; New join code stops that.` };
}

/** Connections one bot process opens to the main at most: data 10, claims 3, sweep 3, two listeners, one short session. */
export const BOT_PROCESS_CONNECTIONS = 19;
/** Connections the web UI beside it opens to the main at most: reader 2, requests 2, one listener, one short session. */
export const WEB_UI_CONNECTIONS = 6;

export function fleetConnectionCount(nodes: Array<{ restartable: boolean; overlap: boolean }>): { count: number; overlap: boolean } {
  const overlap = nodes.length > 0 && nodes.every(n => n.restartable && n.overlap);
  const count = nodes.reduce((sum, n) => sum + BOT_PROCESS_CONNECTIONS + (n.restartable ? WEB_UI_CONNECTIONS : 0) + (overlap ? BOT_PROCESS_CONNECTIONS : 0), 0);
  return { count, overlap };
}

export type ConnectionReading =
  | { state: 'none' }
  | { state: 'unread'; error: string }
  | { state: 'read'; machines: number; count: number; overlap: boolean; max: number; reserved: number; allowed: number };

const CONNECTION_SETTINGS_SQL = "SELECT current_setting('max_connections') || '|' || current_setting('superuser_reserved_connections') || '|' || coalesce(current_setting('reserved_connections', true), '0') || '|' || (to_regclass('smdb_data.shard_nodes') IS NOT NULL)::text;";
const SHARD_NODES_SQL = "SELECT coalesce(json_agg(json_build_object('restartable', restartable, 'overlap', reshard_overlap)), '[]') FROM smdb_data.shard_nodes WHERE seen_at > now() - interval '7 days';";

export async function connectionReading(instance: InstanceConfig): Promise<ConnectionReading> {
  const fleetDb = instance.fleetDb;
  if (!fleetDb) return { state: 'none' };
  if ((await containerState(fleetDb.containerName)).running !== true) return { state: 'none' };
  const unanswered = (r: { stderr: string }): ConnectionReading =>
    ({ state: 'unread', error: `the database did not answer (${keptLines(r.stderr).pop() || 'no answer'})` });
  const unparsed: ConnectionReading = { state: 'unread', error: 'the database answered in a form the manager does not read' };
  const settings = await workSql(fleetDb.containerName, fleetDb.db, CONNECTION_SETTINGS_SQL);
  if (!settings.ok) return unanswered(settings);
  const m = /^(\d+)\|(\d+)\|(\d+)\|(true|false)$/.exec(settings.stdout.trim());
  if (!m) return unparsed;
  if (m[4] === 'false') return { state: 'none' };
  const rows = await workSql(fleetDb.containerName, fleetDb.db, SHARD_NODES_SQL);
  if (!rows.ok) return unanswered(rows);
  let nodes: unknown;
  try { nodes = JSON.parse(rows.stdout.trim()); } catch { return unparsed; }
  if (!Array.isArray(nodes) || !nodes.every(n => n && typeof n.restartable === 'boolean' && typeof n.overlap === 'boolean')) return unparsed;
  if (nodes.length === 0) return { state: 'none' };
  const max = Number(m[1]);
  const reserved = Number(m[2]) + Number(m[3]);
  const { count, overlap } = fleetConnectionCount(nodes);
  return { state: 'read', machines: nodes.length, count, overlap, max, reserved, allowed: max - reserved };
}
