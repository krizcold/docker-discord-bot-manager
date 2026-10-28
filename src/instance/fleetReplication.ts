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

import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as containerManager from '../docker/containerManager';
import * as envManager from '../env/manager';
import { findAppCapabilities } from '../config/appCapabilities';
import * as crypto from 'crypto';
import { InstanceConfig, FleetDbReplication } from '../types';
import { QUIET_ROLE_SESSION_SQL, childFailureText, probeErrorTail, redactSecrets, scramSha256Verifier } from '../config/secretText';
import { feedStdin } from '../docker/childStdin';
import * as fleetBackupGuards from './fleetBackupGuards';
import * as dbLogin from './dbLogin';
import { MANAGER_DB_ROLE } from './dbLogin';
import { certFingerprint, encodeJoinCode, machineText, sqlLiteral } from '../config/joinCode';

export const REPLICATION_ROLE = 'replicator';
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
// (narrowKeptPlainHba).
export function pgHbaContent(keptPlain: string[] = []): string {
  const kept = keptPlain.map(addr => {
    const cidr = `${addr}/${addr.includes(':') ? 128 : 32}`;
    return `host    all             all             ${cidr.padEnd(24)}scram-sha-256\n`;
  }).join('');
  return `# Managed by discord-bot-manager (replication posture). Do not edit.
local   all             all                                     trust
host    all             all             127.0.0.1/32            trust
host    all             all             ::1/128                 trust
host    all             all             172.16.0.0/12           scram-sha-256
${kept}hostssl all             all             0.0.0.0/0               scram-sha-256
hostssl replication     all             0.0.0.0/0               scram-sha-256
`;
}

function admittedWithoutTls(addr: string): boolean {
  if (addr === '::1') return true;
  const m = /^(?:::ffff:)?(\d+)\.(\d+)\.\d+\.\d+$/i.exec(addr);
  if (!m) return false;
  return Number(m[1]) === 127 || (Number(m[1]) === 172 && Number(m[2]) >= 16 && Number(m[2]) <= 31);
}

/** The addresses of live TCP clients without TLS that the narrowed pg_hba would refuse on their next connection. */
async function plainClientsOutsidePool(containerName: string, db: string): Promise<{ ok: true; addrs: string[] } | { ok: false; error: string }> {
  const read = await psql(containerName, db,
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
    execFile('docker', ['ps', '-q', '--filter', `label=com.docker.compose.project=${projectName}`], { timeout: EXEC_TIMEOUT_MS }, (psErr, psOut, psStderr) => {
      if (psErr) return resolve({ ok: false, error: probeErrorTail(String(psStderr || psErr)) });
      const ids = String(psOut).split('\n').map(line => line.trim()).filter(Boolean);
      if (ids.length === 0) return resolve({ ok: true, addrs: [] });
      execFile('docker', ['inspect', '-f', '{{.Name}} {{range .NetworkSettings.Networks}}{{.IPAddress}} {{.GlobalIPv6Address}} {{end}}', ...ids], { timeout: EXEC_TIMEOUT_MS }, (err, stdout, stderr) => {
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

function dbExec(containerName: string, args: string[], stdin?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn('docker', ['exec', ...(stdin !== undefined ? ['-i'] : []), containerName, ...args]);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), EXEC_TIMEOUT_MS);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, stdout, stderr: stderr || 'docker exec failed' }); });
    child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, stdout, stderr }); });
    if (stdin !== undefined) feedStdin(child.stdin, stdin);
  });
}

/** The bot role of the managed database in this container, from the registry; '' when none names it. */
function botRoleOf(containerName: string): string {
  try {
    return containerManager.getAllBots().find(b => b.fleetDb?.containerName === containerName)?.fleetDb?.user ?? '';
  } catch {
    return '';
  }
}

/** dbExec for args that log in as MANAGER_DB_ROLE: a missing role is made and the call runs once more. */
function managerDbExec(containerName: string, args: string[], stdin?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return dbLogin.asManager({ container: containerName, user: botRoleOf(containerName) },
    role => dbExec(containerName, dbLogin.withRole(args, role), stdin), r => !r.ok && dbLogin.isMissingManagerRole(r.stderr));
}

function psql(containerName: string, db: string, sql: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return managerDbExec(containerName, ['psql', '-U', MANAGER_DB_ROLE, '-d', db, '-v', 'ON_ERROR_STOP=1', '-Atc', sql]);
}

/** Why pg_hba.conf must not be rewritten now: a lane's write fence stands in it, or that could not be read. Null when it may be. */
export async function fenceLinesRefusal(containerName: string, db: string): Promise<string | null> {
  const read = await psql(containerName, db, fleetBackupGuards.FENCE_HBA_COUNT_SQL);
  const count = read.ok ? read.stdout.trim() : '';
  if (!/^\d+$/.test(count)) return `whether a write fence stands in pg_hba.conf could not be read (${read.stderr.trim().split('\n').pop() || 'no answer'})`;
  if (Number(count) === 0) return null;
  const owners = await psql(containerName, db, fleetBackupGuards.FENCE_HBA_OWNER_SQL);
  const owner = owners.ok ? fleetBackupGuards.parseFenceOwner(owners.stdout) : null;
  const whose = !owners.ok ? 'whose lane set it could not be read'
    : owner ? `it belongs to ${fleetBackupGuards.fenceOwnerText(owner)}, and that lane lifts it when it finishes`
    : `no lane of this manager set its lines; a restore takes them over and lifts them, or remove them by hand if nothing should hold them`;
  return `a write fence stands in pg_hba.conf (lines ending in ${fleetBackupGuards.WRITE_FENCE_MARK}); ${whose}`;
}

/** SQL on stdin, for a statement that must stay out of every command line. */
function psqlScript(containerName: string, db: string, sql: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return managerDbExec(containerName, ['psql', '-U', MANAGER_DB_ROLE, '-d', db, '-v', 'ON_ERROR_STOP=1', '-At'], sql);
}

/** running true or false as docker says it; null with docker's error when docker could not be asked. */
type ContainerState = { running: boolean; error?: undefined } | { running: null; error: string };
function containerState(containerName: string): Promise<ContainerState> {
  return new Promise(resolve => {
    execFile('docker', ['inspect', '-f', '{{.State.Running}}', containerName], { timeout: EXEC_TIMEOUT_MS }, (err, stdout, stderr) => {
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

/** The database password, recovered from the stored URL like the managed-lane redeploy does. */
function storedDbPassword(instance: InstanceConfig): string | null {
  const urlKey = findAppCapabilities(instance.sourceUrl)?.companionDb?.env.url;
  if (!urlKey) return null;
  const url = (envManager.getEnvVars(instance.id)[urlKey] || '').trim();
  try {
    return decodeURIComponent(new URL(url).password) || null;
  } catch {
    return null;
  }
}

function sidecarUrl(instance: InstanceConfig, dbPassword: string): string {
  const { containerName, user, db } = instance.fleetDb!;
  return `postgresql://${user}:${encodeURIComponent(dbPassword)}@${containerName}:5432/${db}`;
}

export function generateCertPair(dir: string, publicHost: string): Promise<{ ok: boolean; error?: string }> {
  const san = isIpAddress(publicHost) ? `IP:${publicHost}` : `DNS:${publicHost}`;
  return new Promise(resolve => {
    execFile('openssl', [
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
async function ensureServerCert(containerName: string, publicHost: string, certHost: string | undefined): Promise<{ error: string | null; rotated: boolean }> {
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
    if (!swap.ok) return { error: `certificate install failed while moving the new pair into place, so the key and certificate on disk may not match (the configuration was not reloaded; press Enable again to install a fresh pair): ${swap.stderr.trim()}`, rotated: false };
    return { error: null, rotated: hadCert };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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
  opts: { admit?: Admission; dbPassword?: string } = {},
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

type EnableResult = { success: boolean; error?: string; restartRequired?: boolean; certRotated?: boolean; plainClientsKept?: number };

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
    return await containerManager.withExternalBotOp(botId, 'replication', () => { entered = true; return fn(); });
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
  opts: { dbPassword?: string },
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
  const dbState = await containerState(fleetDb.containerName);
  if (dbState.running !== true) {
    return { success: false, error: dbDownText(dbState, 'Database container is not running (start the instance first)') };
  }
  const fenced = await fenceLinesRefusal(fleetDb.containerName, fleetDb.db);
  if (fenced) return { success: false, error: `Enable rewrites pg_hba.conf, but ${fenced}; nothing was changed, so retry Enable after that` };
  // The caller's password is a fallback for a manager env that holds no database URL (an adopt whose env write was refused).
  const dbPassword = storedDbPassword(instance) || opts.dbPassword || null;
  if (!dbPassword) return { success: false, error: envManager.storeBrokenDiagnosis(instance.id) || 'Could not recover the database password from the stored URL' };
  // An existing posture whose password reads empty is a key-loss scrub, not an
  // absent credential: minting a fresh one here would silently rotate the
  // fleet's replication credential and break every standby at its next
  // reconnect.
  if (fleetDb.replication && !fleetDb.replication.password) {
    return { success: false, error: 'The stored replication password no longer decrypts (the manager encryption key changed or was lost). Restore the key, or disable replication and re-enable it to mint a fresh credential (existing standbys must then be re-seeded).' };
  }
  const recordAtStart = JSON.stringify(fleetDb);

  const live = await plainClientsOutsidePool(fleetDb.containerName, fleetDb.db);
  if (!live.ok) return { success: false, error: `could not read which clients connect without TLS (nothing was changed): ${live.error}` };
  // With a record, the bot already got the TLS URL at a start since, or its
  // addresses are in keptPlain; only a start may drop a kept line.
  let own: string[] = [];
  if (!fleetDb.replication) {
    const containers = await ownContainersOutsidePool(instance.sanitizedName, fleetDb.containerName);
    if (!containers.ok) return { success: false, error: `could not read the addresses of this instance's containers (nothing was changed): ${containers.error}` };
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
  const exists = await psql(fleetDb.containerName, fleetDb.db, `SELECT count(*) FROM pg_roles WHERE rolname = '${REPLICATION_ROLE}';`);
  if (!exists.ok) return failed(`database setup failed: ${exists.stderr.trim()}`);
  // The verifier, never the password, and outside a DO block: a failing
  // statement inside one is echoed whole in the CONTEXT line, which the
  // quiet session settings do not hold back.
  const verifier = scramSha256Verifier(password);
  const verb = exists.stdout.trim() === '0' ? 'CREATE' : 'ALTER';
  const setup = await psqlScript(fleetDb.containerName, fleetDb.db,
    `${QUIET_ROLE_SESSION_SQL}${verb} ROLE ${REPLICATION_ROLE} WITH REPLICATION LOGIN PASSWORD '${verifier}';\n`);
  if (!setup.ok) return failed(`database setup failed: ${redactSecrets(setup.stderr.trim(), [password, verifier])}`);
  // Separate calls: ALTER SYSTEM refuses to run inside the implicit transaction
  // a multi-statement psql -c wraps around its input.
  const ssl = await psql(fleetDb.containerName, fleetDb.db, 'ALTER SYSTEM SET ssl = on;');
  if (!ssl.ok) return failed(`enabling ssl failed: ${ssl.stderr.trim()}`);
  // Restart-only setting (no re-initdb): makes pg_rewind possible on every
  // cluster that has ever run enable (reopened ruling R6).
  const hints = await psql(fleetDb.containerName, fleetDb.db, 'ALTER SYSTEM SET wal_log_hints = on;');
  if (!hints.ok) return failed(`enabling wal_log_hints failed: ${hints.stderr.trim()}`);
  const keep = await psql(fleetDb.containerName, fleetDb.db, `ALTER SYSTEM SET max_slot_wal_keep_size = '${keepMb}MB';`);
  if (!keep.ok) return failed(`setting the WAL retention bound failed: ${keep.stderr.trim()}`);
  const asyncOnly = await psql(fleetDb.containerName, fleetDb.db, 'ALTER SYSTEM RESET synchronous_standby_names;');
  if (!asyncOnly.ok) return failed(`resetting synchronous replication failed: ${asyncOnly.stderr.trim()}`);

  const hbaFile = `${PGDATA}/pg_hba.conf`;
  const hba = await dbExec(fleetDb.containerName, ['sh', '-c',
    `cat > ${hbaFile}.new && chown postgres:postgres ${hbaFile}.new && chmod 600 ${hbaFile}.new && mv -f ${hbaFile}.new ${hbaFile}`], pgHbaContent(plain.addrs));
  if (!hba.ok) return failed(`pg_hba rewrite failed: ${hba.stderr.trim()}`);
  const reload = await psql(fleetDb.containerName, fleetDb.db, 'SELECT pg_reload_conf();');
  if (!reload.ok) return failed(`config reload failed: ${reload.stderr.trim()}`);

  const ownCert = await dbExec(fleetDb.containerName, ['cat', `${PGDATA}/server.crt`]);
  if (!ownCert.ok) return failed(`setting up the address list failed: the server certificate could not be read (${probeErrorTail(ownCert.stderr)})`);
  const previous = fleetDb.replication;
  const moved = previous && (previous.publicHost !== host || previous.hostPort !== port) ? { host: previous.publicHost, port: previous.hostPort } : null;
  const addresses = await psqlScript(fleetDb.containerName, fleetDb.db, addressTableSql(host, port, ownCert.stdout.trim(), machineText(host), moved));
  if (!addresses.ok) return failed(`setting up the address list failed: ${redactSecrets(addresses.stderr.trim(), [password])}`);

  const replication: FleetDbReplication = {
    role: REPLICATION_ROLE,
    password,
    hostPort: port,
    publicHost: host,
    certHost: host,
    slotWalKeepMb: keepMb,
    ...(plain.addrs.length > 0 ? { keptPlain: plain.addrs } : {}),
  };
  // The stored URL stays the container-name form (the public form cannot
  // hairpin from containers sharing a docker network with the sidecar, which
  // includes this instance's own bot). TLS on it too (ssl=on just activated): the authored pg_hba
  // accepts non-TLS only from 172.16/12, and a docker daemon with custom
  // address pools allocates outside it; hostssl covers every subnet.
  const localUrl = `${sidecarUrl(instance, dbPassword)}?sslmode=no-verify`;
  const changed = `the database already has the replication role, ssl, the WAL settings, the server certificate${certRotated ? ' (a new one)' : ''} and the managed pg_hba`;
  if (JSON.stringify(containerManager.getBot(instance.id)?.fleetDb) !== recordAtStart) {
    return { success: false, certRotated, error: `The instance's database record changed while this Enable ran, so the record and the database URL were not written; ${changed}. Check the Replication section, then press Enable again` };
  }
  try {
    // The env store alone: container env assembly derives sensitive values from
    // it at read time (the two-store strip), so no record mirror exists to sync.
    envManager.setEnvVars(instance.id, { [dbEnv.url]: localUrl });
    containerManager.updateInstanceFleetDbReplication(instance.id, replication);
  } catch (err) {
    return { success: false, certRotated, error: `The database URL or the replication record could not be saved (${err instanceof Error ? err.message : String(err)}); ${changed}. Press Enable again once the store can be written` };
  }
  forgetProbes(instance.id);
  return { success: true, restartRequired: true, certRotated, ...(plain.addrs.length > 0 ? { plainClientsKept: plain.addrs.length } : {}) };
}

/**
 * Disable: refuse while any fleet standby still streams (naming its slots),
 * drop every inactive fleet slot FIRST (a leaked slot retains WAL until the
 * disk fills, so a disable that cannot drop them refuses and keeps the record),
 * revoke the replication login (the port may stay published until the next
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

type DisableResult = { success: boolean; error?: string; restartRequired?: boolean; warning?: string; plainClientsKept?: number };

async function disableInLane(
  instance: InstanceConfig,
): Promise<DisableResult> {
  const fleetDb = instance.fleetDb;
  if (!fleetDb?.replication) return { success: false, error: 'Replication is not enabled' };
  const disableRecordAtStart = JSON.stringify(fleetDb);
  const dbPassword = storedDbPassword(instance);
  if (!dbPassword) return { success: false, error: envManager.storeBrokenDiagnosis(instance.id) || 'Could not recover the database password from the stored URL' };
  const dbEnv = findAppCapabilities(instance.sourceUrl)?.companionDb?.env;
  if (!dbEnv) return { success: false, error: 'This app declares no managed database companion (nothing was disabled)' };
  const dbState = await containerState(fleetDb.containerName);
  if (dbState.running !== true) {
    return { success: false, error: dbDownText(dbState, 'Database container is not running - start the instance first so the replication slot can be dropped (a leaked slot retains WAL forever)') };
  }

  const streaming = await psql(fleetDb.containerName, fleetDb.db,
    `SELECT COALESCE(string_agg(slot_name, ', ' ORDER BY slot_name), '') FROM pg_replication_slots WHERE starts_with(slot_name, '${FLEET_SLOT_PREFIX}') AND active;`);
  if (!streaming.ok) {
    return { success: false, error: `could not read the replication slots (nothing was disabled): ${streaming.stderr.trim()}` };
  }
  if (streaming.stdout.trim() !== '') {
    return { success: false, error: `Standbys are still streaming on slot(s) ${streaming.stdout.trim()}; stop or remove them first (nothing was disabled)` };
  }
  // A seed's base backup and a stream without a slot hold no active slot,
  // and revoking the login would cut them off mid-copy.
  const senders = await psql(fleetDb.containerName, fleetDb.db,
    `SELECT COALESCE(string_agg(COALESCE(host(client_addr), 'a local socket'), ', ' ORDER BY client_addr), '') FROM pg_stat_replication WHERE usename = '${REPLICATION_ROLE}';`);
  if (!senders.ok) {
    return { success: false, error: `could not read the replication connections (nothing was disabled): ${senders.stderr.trim()}` };
  }
  if (senders.stdout.trim() !== '') {
    return { success: false, error: `Replication connections of the ${REPLICATION_ROLE} role are open from ${senders.stdout.trim()} (a standby streaming without a slot, or a seed copying the database); stop or remove them first (nothing was disabled)` };
  }
  // Every refusal above changed nothing. From here on each step changes the
  // database, so the record says a Disable is under way until it finishes:
  // an interrupted one is then shown, and pressing Disable again finishes it.
  const before = containerManager.getBot(instance.id);
  if (JSON.stringify(before?.fleetDb) !== disableRecordAtStart) {
    return { success: false, error: "The instance's database record changed while this Disable ran its checks (nothing was disabled); check the Replication section, then press Disable replication again" };
  }
  let markedRecord: string;
  try {
    const marked = containerManager.updateInstanceFleetDbReplication(instance.id, { ...fleetDb.replication, disablingSince: fleetDb.replication.disablingSince ?? new Date().toISOString() });
    if (!marked?.fleetDb?.replication) return { success: false, error: 'The instance record is gone (nothing was disabled)' };
    markedRecord = JSON.stringify(containerManager.getBot(instance.id)?.fleetDb);
  } catch (err) {
    return { success: false, error: `could not record that a Disable is under way (nothing was disabled): ${String(err)}` };
  }
  // Clears a synchronous setting a bot or an arm left in auto.conf, which
  // would wedge this database's next write (B6 map F18). Separate
  // calls, for the reason the enable above records: ALTER SYSTEM refuses to run
  // inside the implicit transaction a multi-statement psql -c wraps its input in.
  const relax = await psql(fleetDb.containerName, fleetDb.db, 'ALTER SYSTEM RESET synchronous_standby_names;');
  if (!relax.ok) {
    return { success: false, error: `could not relax the synchronous posture, so the Disable did not finish; press Disable replication again to finish it: ${relax.stderr.trim()}` };
  }
  const relaxed = await psql(fleetDb.containerName, fleetDb.db, 'SELECT pg_reload_conf();');
  if (!relaxed.ok) {
    return { success: false, error: `could not reload after relaxing the synchronous posture, so the Disable did not finish; press Disable replication again to finish it: ${relaxed.stderr.trim()}` };
  }
  const drop = await psql(fleetDb.containerName, fleetDb.db, `
    DO $$ DECLARE s record; BEGIN
      FOR s IN SELECT slot_name FROM pg_replication_slots WHERE starts_with(slot_name, '${FLEET_SLOT_PREFIX}') AND NOT active LOOP
        PERFORM pg_drop_replication_slot(s.slot_name);
      END LOOP;
    END $$;`);
  if (!drop.ok) {
    return { success: false, error: `slot drop failed, so the Disable did not finish; press Disable replication again to finish it: ${drop.stderr.trim()}` };
  }
  const left = await psql(fleetDb.containerName, fleetDb.db,
    `SELECT COALESCE(string_agg(slot_name, ', ' ORDER BY slot_name), '') FROM pg_replication_slots WHERE starts_with(slot_name, '${FLEET_SLOT_PREFIX}');`);
  if (!left.ok) {
    return { success: false, error: `could not confirm the replication slots are gone, so the Disable did not finish; press Disable replication again to finish it: ${left.stderr.trim()}` };
  }
  if (left.stdout.trim() !== '') {
    return { success: false, error: `Slot(s) ${left.stdout.trim()} survived the drop (a standby reconnected while it ran); stop or remove the standbys, then press Disable replication again to finish it` };
  }
  const revoke = await psql(fleetDb.containerName, fleetDb.db, `ALTER ROLE ${REPLICATION_ROLE} NOLOGIN;`);
  if (!revoke.ok) {
    return { success: false, error: `revoking the replication login failed (the slots are dropped; retry to finish disabling): ${revoke.stderr.trim()}` };
  }

  if (JSON.stringify(containerManager.getBot(instance.id)?.fleetDb) !== markedRecord) {
    return { success: false, error: "The instance's database record changed while this Disable ran, so the record and the database URL were not written; the slots are dropped and the replication login is revoked. Check the Replication section, then press Disable replication again to finish it" };
  }
  // ssl=on and the authored pg_hba survive the disable, so the local form
  // keeps TLS (see the enable-side note on custom address pools).
  const revertUrl = `${sidecarUrl(instance, dbPassword)}?sslmode=no-verify`;
  // The bot may still dial its old non-TLS URL until it restarts, so the lines stay until a start narrows them.
  const keptPlain = fleetDb.replication.keptPlain ?? [];
  const kept = keptPlain.length > 0 ? { plainClientsKept: keptPlain.length } : {};
  try {
    envManager.setEnvVars(instance.id, { [dbEnv.url]: revertUrl });
    containerManager.updateInstanceFleetDbReplication(instance.id, null, keptPlain);
  } catch (err) {
    // The disabling mark stays on the record, so the card shows the Disable as unfinished.
    forgetProbes(instance.id);
    return { success: false, error: `Replication is off on the database (the slots are dropped and the replication login is revoked), but the database URL or the replication record could not be saved (${err instanceof Error ? err.message : String(err)}); press Disable replication again to finish it` };
  }
  forgetProbes(instance.id);
  return { success: true, restartRequired: true, ...kept };
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
  const fenced = await fenceLinesRefusal(fleetDb.containerName, fleetDb.db);
  if (fenced) return `pg_hba was not narrowed: ${fenced}; ${notNarrowed}`;
  const live = await plainClientsOutsidePool(fleetDb.containerName, fleetDb.db);
  if (!live.ok) return `Could not read which clients connect to the database without TLS (${live.error}), so ${notNarrowed}`;
  const plain = { addrs: live.addrs.filter(a => keptPlain.includes(a)) };
  const hbaFile = `${PGDATA}/pg_hba.conf`;
  const hba = await dbExec(fleetDb.containerName, ['sh', '-c',
    `cat > ${hbaFile}.new && chown postgres:postgres ${hbaFile}.new && chmod 600 ${hbaFile}.new && mv -f ${hbaFile}.new ${hbaFile}`], pgHbaContent(plain.addrs));
  if (!hba.ok) return `Could not rewrite pg_hba (${hba.stderr.trim()}), so ${notNarrowed}`;
  const reload = await psql(fleetDb.containerName, fleetDb.db, 'SELECT pg_reload_conf();');
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
    slots: Array<{ slot: string; fleet: boolean; walStatus: string; active: boolean; retainedBytes: number | null; clientAddr: string | null; state: string | null; replayLagSeconds: number | null; machine: string | null; address: string | null }>;
    /** Live max_slot_wal_keep_size as postgres reports it ('-1' = unbounded, pre-RC-1 clusters). */
    slotWalKeep: string;
  };
  /** Can a container on the default bridge reach the published endpoint (the
   * path a node on another host dials)? Catches firewall traps before
   * a cross-host standby is pointed at a dead port. */
  reachability?: { ok: boolean; error?: string; ageSeconds: number };
  /** The database could not be read (live stays absent): docker's or psql's last line. Absent with no live means docker said it is stopped. */
  probeError?: string;
}

const PROBE_CACHE_MS = 60_000;
const PROBE_TIMEOUT_MS = 20_000;
const probeCache: Map<string, { ok: boolean; error?: string; at: number }> = new Map();

function forgetProbes(botId: string): void {
  for (const key of [...probeCache.keys()]) if (key.startsWith(`${botId}|`)) probeCache.delete(key);
}

function probeEndpoint(instance: InstanceConfig): Promise<{ ok: boolean; error?: string }> {
  const repl = instance.fleetDb!.replication!;
  const dbPassword = storedDbPassword(instance);
  if (!dbPassword) return Promise.resolve({ ok: false, error: 'stored URL unreadable' });
  const url = `postgresql://${instance.fleetDb!.user}@${repl.publicHost}:${repl.hostPort}/${instance.fleetDb!.db}?sslmode=require&connect_timeout=8`;
  // The password rides the docker CLI's environment (`-e NAME` with no value), never its argv.
  return new Promise(resolve => {
    execFile('docker', ['run', '--rm', '-e', 'PGPASSWORD', 'postgres:16-alpine', 'psql', url, '-Atc', 'SELECT 1'],
      { timeout: PROBE_TIMEOUT_MS, env: { ...process.env, PGPASSWORD: dbPassword } }, (err, stdout, stderr) => {
        if (!err && String(stdout).trim() === '1') resolve({ ok: true });
        else resolve({ ok: false, error: redactSecrets(childFailureText(stderr, err) || 'no response', [dbPassword]).split('\n').pop() });
      });
  });
}

async function cachedReachability(instance: InstanceConfig): Promise<{ ok: boolean; error?: string; ageSeconds: number }> {
  const repl = instance.fleetDb!.replication!;
  const key = `${instance.id}|${repl.publicHost}:${repl.hostPort}`;
  const cached = probeCache.get(key);
  if (cached && Date.now() - cached.at < PROBE_CACHE_MS) {
    return { ok: cached.ok, error: cached.error, ageSeconds: Math.round((Date.now() - cached.at) / 1000) };
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

  const probe = await psql(fleetDb.containerName, fleetDb.db,
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
               'replayLagSeconds', EXTRACT(EPOCH FROM r.replay_lag)))
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
          machine: null,
          address: null,
        }));
      }
    } catch { /* no slots */ }
    const listed = await psql(fleetDb.containerName, fleetDb.db, ADDRESS_BY_SLOT_SQL);
    if (listed.ok) {
      try {
        const rows = JSON.parse(listed.stdout.trim() || '[]');
        for (const slot of slots) {
          const row = Array.isArray(rows) ? rows.find((r: any) => r && r.slot === slot.slot) : null;
          if (row) {
            slot.machine = String(row.machine || '');
            slot.address = `${row.host}:${row.port}`;
          }
        }
      } catch { /* no machine names */ }
    }
    status.live = { sslOn: sslOn === 'on', standbys, slots, slotWalKeep: (slotWalKeep || '').trim() };
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
  const result = await psql(fleetDb.containerName, fleetDb.db, `
    DO $$ DECLARE s record; BEGIN
      SELECT active INTO s FROM pg_replication_slots WHERE slot_name = '${slot}';
      IF NOT FOUND THEN RAISE EXCEPTION 'no slot named ${slot}'; END IF;
      IF s.active THEN RAISE EXCEPTION 'a standby is streaming on ${slot}; stop or remove it first'; END IF;
      PERFORM pg_drop_replication_slot('${slot}');
      IF to_regclass('smdb_manager.addresses') IS NOT NULL THEN
        EXECUTE format('DELETE FROM smdb_manager.addresses WHERE slot = %L', '${slot}');
      END IF;
    END $$;`);
  if (!result.ok) {
    const lines = result.stderr.trim().split('\n');
    return { success: false, error: (lines.find(l => l.startsWith('ERROR')) || lines.pop() || 'psql failed').replace(/^ERROR:\s*/, '') };
  }
  return { success: true };
}

const ADDRESS_BY_SLOT_SQL = `SELECT CASE WHEN to_regclass('smdb_manager.addresses') IS NULL THEN '[]'::json ELSE
  (SELECT COALESCE(json_agg(json_build_object('slot', slot, 'machine', machine, 'host', host, 'port', port)), '[]'::json)
   FROM smdb_manager.addresses WHERE slot IS NOT NULL) END;`;

/** Enable's address list script, run as the superuser on stdin: the table, the replication login's grants, and this main's own row. */
export function addressTableSql(host: string, port: number, certPem: string, machine: string, moved: { host: string; port: number } | null): string {
  const drop = moved ? `DELETE FROM smdb_manager.addresses WHERE slot IS NULL AND host = ${sqlLiteral(moved.host)} AND port = ${Number(moved.port)};\n` : '';
  return `CREATE SCHEMA IF NOT EXISTS smdb_manager;
CREATE TABLE IF NOT EXISTS smdb_manager.addresses (
  host text NOT NULL, port integer NOT NULL, slot text, cert text NOT NULL, machine text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (host, port));
GRANT USAGE ON SCHEMA smdb_manager TO ${REPLICATION_ROLE};
GRANT SELECT, INSERT, UPDATE, DELETE ON smdb_manager.addresses TO ${REPLICATION_ROLE};
${drop}INSERT INTO smdb_manager.addresses (host, port, slot, cert, machine) VALUES (${sqlLiteral(host)}, ${Number(port)}, NULL, ${sqlLiteral(certPem)}, ${sqlLiteral(machine)})
  ON CONFLICT (host, port) DO UPDATE SET slot = NULL, cert = EXCLUDED.cert, machine = EXCLUDED.machine, updated_at = now();
`;
}

/**
 * The join code another machine's manager pastes: this database's address, its certificate fingerprint, the
 * replication login and the bot's database login. The code holds passwords; the route sits behind manager auth.
 */
export async function getJoinCode(instance: InstanceConfig): Promise<{ success: boolean; error?: string; joinCode?: string }> {
  const fleetDb = instance.fleetDb;
  const repl = fleetDb?.replication;
  if (!fleetDb || !repl) return { success: false, error: 'Replication is not enabled, so there is no join code.' };
  if (repl.disablingSince) return { success: false, error: 'A Disable of replication did not finish, so the replication login may already be revoked: press Disable replication to finish it' };
  if (!repl.password) {
    return { success: false, error: 'The stored replication password no longer decrypts (the manager encryption key changed or was lost). Restore the key, or disable and re-enable replication to make a new one; every other machine then needs the new join code.' };
  }
  const dbState = await containerState(fleetDb.containerName);
  if (dbState.running !== true) {
    return { success: false, error: dbDownText(dbState, 'The database container is not running, so its certificate cannot be read for the join code') };
  }
  const cert = await dbExec(fleetDb.containerName, ['cat', `${PGDATA}/server.crt`]);
  if (!cert.ok) return { success: false, error: `The database's certificate could not be read, so no join code was made: ${probeErrorTail(cert.stderr)}` };
  let fp: string;
  try {
    fp = certFingerprint(cert.stdout);
  } catch (err) {
    return { success: false, error: `The database's certificate could not be read, so no join code was made: ${err instanceof Error ? err.message : String(err)}` };
  }
  const appPassword = storedDbPassword(instance);
  if (!appPassword) return { success: false, error: "The bot's database password could not be read from the stored database URL, so no join code was made" };
  const joinCode = encodeJoinCode({
    v: 1,
    host: repl.publicHost,
    port: repl.hostPort,
    db: fleetDb.db,
    fp,
    machine: machineText(repl.publicHost),
    repl: { user: repl.role, password: repl.password },
    app: { user: fleetDb.user, password: appPassword },
  });
  return { success: true, joinCode };
}
