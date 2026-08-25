/**
 * Standby side of managed fleet database replication (PLAN_REPLICATION.md
 * Stage 2). Consumes the primary's copy block (replication DSN + pinned cert),
 * seeds a volume with pg_basebackup, hardens the seeded PGDATA (own server
 * cert for THIS machine's endpoint, verify-full primary_conninfo pointing at
 * an in-volume copy of the primary's cert), then injects and starts the
 * standby service in the instance's compose project.
 *
 * The replicator password is used during provisioning only; after that it
 * lives solely inside the standby's postgresql.auto.conf. The manager record
 * keeps endpoints, never credentials.
 */

import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as containerManager from '../docker/containerManager';
import * as envManager from '../env/manager';
import * as fleetBackup from './fleetBackup';
import { getBotDir, getDataPath } from '../git/repoManager';
import { generateCertPair, enableFleetReplication } from './fleetReplication';
import { InstanceConfig, FleetDbReplicaRecord } from '../types';

const REPLICATION_SLOT = 'fleet_standby';
const DEFAULT_HOST_PORT = 15432;
const PGDATA = '/var/lib/postgresql/data';
const SEED_TIMEOUT_MS = 30 * 60 * 1000;
const PULL_TIMEOUT_MS = 10 * 60 * 1000;
// Generous: volExec calls run under `docker run`, and slow disks are real.
const EXEC_TIMEOUT_MS = 120_000;

type Phase = 'preparing' | 'seeding' | 'configuring' | 'starting';
const provisioning: Map<string, { phase: Phase; startedAt: number }> = new Map();
const lastErrors: Map<string, string> = new Map();

function seedContainerName(instance: InstanceConfig): string {
  return `${instance.sanitizedName}-fleet-replica-seed`;
}

function volExec(volume: string, script: string, stdin?: string, extraMounts: string[] = []): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const args = ['run', '--rm', ...(stdin !== undefined ? ['-i'] : []),
    '-v', `${volume}:${PGDATA}`, ...extraMounts.flatMap(m => ['-v', m]),
    '--entrypoint', 'sh', 'postgres:16-alpine', '-c', script];
  return new Promise(resolve => {
    const child = spawn('docker', args);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), EXEC_TIMEOUT_MS);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, stdout, stderr: stderr || 'docker run failed' }); });
    child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, stdout, stderr }); });
    if (stdin !== undefined) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

function replicaExec(containerName: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile('docker', ['exec', containerName, ...args], { timeout: EXEC_TIMEOUT_MS }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr || err || '') });
    });
  });
}

interface ParsedDsn {
  user: string;
  password: string;
  host: string;
  port: number;
  db: string;
}

/** Strict parse of the copy-block DSN; conninfo re-emission needs a tame charset. */
function parsePrimaryDsn(dsn: string): { ok: true; parsed: ParsedDsn } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(dsn.trim());
  } catch {
    return { ok: false, error: 'DSN is not a valid URL' };
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    return { ok: false, error: 'DSN must be a postgresql:// URL' };
  }
  const parsed: ParsedDsn = {
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    host: url.hostname,
    port: Number(url.port) || 5432,
    db: (url.pathname || '/smdb').replace(/^\//, '') || 'smdb',
  };
  if (!parsed.user || !parsed.password) return { ok: false, error: 'DSN must carry the replication user and password' };
  for (const [name, value] of [['user', parsed.user], ['password', parsed.password], ['host', parsed.host], ['database', parsed.db]] as const) {
    if (!/^[A-Za-z0-9._~-]+$/.test(value)) return { ok: false, error: `DSN ${name} contains unsupported characters` };
  }
  return { ok: true, parsed };
}

function certFilePath(botId: string): string {
  return path.join(getBotDir(botId), 'fleet-replica', 'primary-ca.crt');
}

export interface FleetReplicaStatus {
  present: boolean;
  provisioning?: { phase: Phase; forSeconds: number };
  lastError?: string;
  record?: Pick<FleetDbReplicaRecord, 'containerName' | 'publicHost' | 'hostPort' | 'primaryHost' | 'primaryPort'>;
  live?: {
    running: boolean;
    inRecovery: boolean | null;
    receiverStatus: string | null;
    /** Everything received has been replayed. On an idle primary the
     * time-based lag below inflates; this is the honest signal. */
    caughtUp: boolean | null;
    replayLagSeconds: number | null;
  };
}

export async function getFleetReplicaStatus(instance: InstanceConfig): Promise<FleetReplicaStatus> {
  const busy = provisioning.get(instance.id);
  const status: FleetReplicaStatus = {
    present: !!instance.fleetDbReplica || !!busy,
    lastError: lastErrors.get(instance.id) || undefined,
  };
  if (busy) status.provisioning = { phase: busy.phase, forSeconds: Math.round((Date.now() - busy.startedAt) / 1000) };
  const rec = instance.fleetDbReplica;
  if (!rec) return status;
  status.record = {
    containerName: rec.containerName,
    publicHost: rec.publicHost,
    hostPort: rec.hostPort,
    primaryHost: rec.primaryHost,
    primaryPort: rec.primaryPort,
  };
  const probe = await replicaExec(rec.containerName, ['psql', '-U', 'smdb', '-d', 'smdb', '-Atc',
    `SELECT pg_is_in_recovery(),
            (SELECT status FROM pg_stat_wal_receiver LIMIT 1),
            (pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn()),
            COALESCE(EXTRACT(EPOCH FROM now() - pg_last_xact_replay_timestamp())::text, '');`]);
  if (probe.ok) {
    const [inRec, recv, caught, lag] = probe.stdout.trim().split('|');
    status.live = {
      running: true,
      inRecovery: inRec === 't',
      receiverStatus: recv || null,
      caughtUp: caught === '' ? null : caught === 't',
      replayLagSeconds: lag ? Number(lag) : null,
    };
  } else {
    status.live = { running: false, inRecovery: null, receiverStatus: null, caughtUp: null, replayLagSeconds: null };
  }
  return status;
}

interface ValidatedIntake {
  dsn: ParsedDsn;
  cert: string;
  host: string;
  port: number;
}

/** Shape checks shared by both intake paths, so the two cannot drift apart. */
function validateIntake(
  primaryDsn: string,
  certPem: string,
  publicHost: string,
  hostPort: number | undefined,
): { ok: true; intake: ValidatedIntake } | { ok: false; error: string } {
  const dsn = parsePrimaryDsn(primaryDsn);
  if (!dsn.ok) return { ok: false, error: dsn.error };
  const cert = certPem.trim();
  if (!/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$/.test(cert)) {
    return { ok: false, error: 'Certificate must be a PEM certificate block' };
  }
  const host = publicHost.trim();
  if (!host || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host)) {
    return { ok: false, error: 'Public host must be a bare hostname or IPv4 address' };
  }
  const port = hostPort ?? DEFAULT_HOST_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'Invalid port' };
  return { ok: true, intake: { dsn: dsn.parsed, cert, host, port } };
}

function replicaRecordFor(instance: InstanceConfig, intake: ValidatedIntake): FleetDbReplicaRecord {
  return {
    containerName: `${instance.sanitizedName}-fleet-postgres-replica`,
    volume: `${instance.sanitizedName}-fleet-postgres-replica-data`,
    slot: REPLICATION_SLOT,
    primaryHost: intake.dsn.host,
    primaryPort: intake.dsn.port,
    publicHost: intake.host,
    hostPort: intake.port,
    certHost: intake.host,
  };
}

/**
 * Hand the seed to the op lock and return; callers poll status. `preflight`
 * runs inside the lock before the seed, which is what lets a re-seed retire
 * the stale primary without racing a start or a rebuild.
 */
function startProvisioning(
  instance: InstanceConfig,
  record: FleetDbReplicaRecord,
  intake: ValidatedIntake,
  preflight?: () => Promise<void>,
): void {
  provisioning.set(instance.id, { phase: 'preparing', startedAt: Date.now() });
  lastErrors.delete(instance.id);
  void containerManager.withExternalBotOp(instance.id, 'replica-seed', async () => {
    if (preflight) await preflight();
    await runProvisioning(instance, record, intake.dsn, intake.cert);
  }).catch(err => {
    lastErrors.set(instance.id, String(err instanceof Error ? err.message : err));
  }).finally(() => {
    provisioning.delete(instance.id);
  });
}

/**
 * Kick off provisioning (async; poll status). Refuses when a record already
 * exists (remove first), when the target volume holds data, or when the host
 * port collides with any other managed database on this manager.
 */
export function provisionFleetReplica(
  instance: InstanceConfig,
  primaryDsn: string,
  certPem: string,
  publicHost: string,
  hostPort?: number,
): { success: boolean; error?: string; started?: boolean } {
  if (instance.fleetDbReplica) return { success: false, error: 'A replica already exists on this instance - remove it first' };
  if (provisioning.has(instance.id)) return { success: false, error: 'Provisioning is already running' };
  const busyOp = containerManager.isBotBusy(instance.id);
  if (busyOp) return { success: false, error: `Operation '${busyOp}' is running on this instance; wait for it to finish` };
  // A standby lives beside a fleet WORKER (R7): an instance with its own
  // managed database is the primary side, and a non-fleet bot has no use for
  // a fleet replica.
  if (instance.fleetDb) return { success: false, error: 'This instance hosts the fleet database itself - replication is managed from its Database modal' };
  const role = (instance.envVars?.['BOT_NODE_ROLE'] || '').trim().toLowerCase();
  if (role !== 'co-worker' && role !== 'backup-master') {
    return { success: false, error: 'A replica belongs beside a fleet worker (set BOT_NODE_ROLE to co-worker or backup-master first)' };
  }
  if (!containerManager.deployedComposeExists(instance.id)) {
    return { success: false, error: 'Install/build the instance first - the standby joins its compose project' };
  }

  const validated = validateIntake(primaryDsn, certPem, publicHost, hostPort);
  if (!validated.ok) return { success: false, error: validated.error };
  const { dsn: parsedDsn, port } = validated.intake;
  const collision = containerManager.getAllBots().find(other =>
    other.fleetDb?.replication?.hostPort === port
    || (other.id !== instance.id && other.fleetDbReplica?.hostPort === port)
    || other.recoveryChannel?.tunnelPort === port);
  if (collision) {
    return { success: false, error: `Host port ${port} is already used by "${collision.displayName}" - pick another` };
  }
  // R2: a replica on the primary's own machine protects nothing. The DSN
  // pointing at a replication endpoint THIS manager provisioned means the
  // primary lives here.
  const samehost = containerManager.getAllBots().find(other => {
    const repl = other.fleetDb?.replication;
    return repl && repl.publicHost === parsedDsn.host && repl.hostPort === parsedDsn.port;
  });
  if (samehost) {
    return { success: false, error: `That primary ("${samehost.displayName}") lives on THIS machine - a replica here would die with it. Provision the replica on another machine's manager` };
  }

  // The op lock keeps start/rebuild/delete away from the minutes-long seed
  // (and vice versa: the busy check above refuses while one of those runs).
  startProvisioning(instance, replicaRecordFor(instance, validated.intake), validated.intake);
  return { success: true, started: true };
}

async function runProvisioning(instance: InstanceConfig, record: FleetDbReplicaRecord, dsn: ParsedDsn, certPem: string): Promise<void> {
  // The primary's pinned cert: kept on disk for re-provisioning and mounted
  // into the seeding container; the standby's runtime copy lives in PGDATA.
  const certPath = certFilePath(instance.id);
  fs.mkdirSync(path.dirname(certPath), { recursive: true });
  fs.writeFileSync(certPath, certPem.endsWith('\n') ? certPem : certPem + '\n');
  const hostCertPath = `${containerManager.hostBotDirFor(instance.id)}/fleet-replica/primary-ca.crt`;
  const seedName = seedContainerName(instance);

  // First contact on a worker machine pulls the image; done explicitly so the
  // later short-timeout docker runs never absorb a multi-minute pull.
  const pulled = await new Promise<{ ok: boolean; stderr: string }>(resolve => {
    execFile('docker', ['pull', 'postgres:16-alpine'], { timeout: PULL_TIMEOUT_MS }, (err, _o, stderr) => {
      resolve({ ok: !err, stderr: String(stderr || err || '') });
    });
  });
  if (!pulled.ok) throw new Error(`could not pull postgres:16-alpine: ${pulled.stderr.trim().split('\n').pop()}`);

  // A ghost seeder from a previous timeout or a manager restart mid-seed still
  // holds the volume: kill it before touching anything.
  await new Promise<void>(resolve => execFile('docker', ['rm', '-f', seedName], () => resolve()));

  // With no record on the instance, whatever the volume holds is manager
  // debris (an aborted seed, or a removed replica's stale copy of a primary
  // that is authoritative elsewhere): wipe and reseed rather than dead-ending
  // the flow on a state only the docker CLI could clear.
  const wipe = await volExec(record.volume, `find ${PGDATA} -mindepth 1 -maxdepth 1 -exec rm -rf {} +`);
  if (!wipe.ok) throw new Error(`could not clear the replica volume: ${wipe.stderr.trim()}`);

  provisioning.set(instance.id, { phase: 'seeding', startedAt: Date.now() });
  const seedDsn = `postgresql://${encodeURIComponent(dsn.user)}:${encodeURIComponent(dsn.password)}@${dsn.host}:${dsn.port}/${dsn.db}?sslmode=verify-full&sslrootcert=/primary-ca.crt`;
  const seed = await new Promise<{ ok: boolean; stderr: string }>(resolve => {
    const child = spawn('docker', ['run', '--rm', '--name', seedName,
      '-v', `${record.volume}:${PGDATA}`,
      '-v', `${hostCertPath}:/primary-ca.crt:ro`,
      '--entrypoint', 'pg_basebackup', 'postgres:16-alpine',
      '-d', seedDsn, '-D', PGDATA, '-X', 'stream', '-R', '-S', record.slot, '--checkpoint=fast']);
    let stderr = '';
    // Killing the CLI would NOT stop the container (it runs daemon-side and
    // would keep holding the volume and the primary's walsender): kill the
    // container by name, which also ends the CLI attachment.
    const timer = setTimeout(() => {
      execFile('docker', ['rm', '-f', seedName], () => child.kill('SIGKILL'));
    }, SEED_TIMEOUT_MS);
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, stderr: stderr || 'docker run failed' }); });
    child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, stderr }); });
  });
  if (!seed.ok) throw new Error(`pg_basebackup failed: ${seed.stderr.trim().split('\n').pop()}`);

  provisioning.set(instance.id, { phase: 'configuring', startedAt: Date.now() });

  // Runtime trust: the primary's cert moves INTO the volume and a keyword-form
  // primary_conninfo (last one wins in auto.conf) repoints verify-full at it -
  // the seed-time /primary-ca.crt mount does not exist once the service runs.
  const put = await volExec(record.volume, `cat > ${PGDATA}/primary-ca.crt && chown postgres:postgres ${PGDATA}/primary-ca.crt`, certPem);
  if (!put.ok) throw new Error(`cert install failed: ${put.stderr.trim()}`);
  const conninfo = `user=${dsn.user} password=${dsn.password} host=${dsn.host} port=${dsn.port} sslmode=verify-full sslrootcert=${PGDATA}/primary-ca.crt application_name=${instance.sanitizedName}`;
  const conf = await volExec(record.volume, `cat >> ${PGDATA}/postgresql.auto.conf`, `primary_conninfo = '${conninfo}'\n`);
  if (!conf.ok) throw new Error(`primary_conninfo write failed: ${conf.stderr.trim()}`);

  // The byte-copied PGDATA carries the PRIMARY's server cert (naming the
  // primary's host); replace it with one naming THIS machine's endpoint.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-replica-cert-'));
  try {
    const gen = await generateCertPair(dir, record.publicHost);
    if (!gen.ok) throw new Error(`standby cert generation failed: ${gen.error}`);
    for (const file of ['server.key', 'server.crt']) {
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');
      const res = await volExec(record.volume, `cat > ${PGDATA}/${file} && chown postgres:postgres ${PGDATA}/${file} && chmod 600 ${PGDATA}/${file}`, content);
      if (!res.ok) throw new Error(`standby cert install failed (${file}): ${res.stderr.trim()}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  provisioning.set(instance.id, { phase: 'starting', startedAt: Date.now() });
  containerManager.updateInstanceFleetDbReplica(instance.id, record);
  const apply = await containerManager.applyFleetDbReplicaService(instance.id);
  if (!apply.success) {
    containerManager.updateInstanceFleetDbReplica(instance.id, null);
    throw new Error(`standby service start failed: ${apply.error}`);
  }
}

/**
 * Remove the standby service + record. The volume and the stored primary cert
 * stay (data retention / re-provision). The PRIMARY's replication slot is now
 * orphaned and retains WAL: the caller must surface that loudly.
 */
export async function removeFleetReplica(instance: InstanceConfig): Promise<{ success: boolean; error?: string }> {
  const rec = instance.fleetDbReplica;
  if (!rec) return { success: false, error: 'No replica on this instance' };
  if (provisioning.has(instance.id)) return { success: false, error: 'Provisioning is running; wait for it to finish' };
  const removed = await containerManager.removeFleetDbReplicaService(instance.id, rec.containerName);
  if (!removed.success) return removed;
  containerManager.updateInstanceFleetDbReplica(instance.id, null);
  lastErrors.delete(instance.id);
  return { success: true };
}
/**
 * Stop pinning the fleet database on a node that no longer hosts it. A worker
 * is not told its database by the manager at all: the master delivers it on
 * register and the bot persists it in data/.env. Leaving the old values in the
 * manager env would pin them into the container, where they outrank data/.env,
 * so the master's delivery could never take effect and this node could never
 * pair-promote later (its own promote refuses on exactly that pin). DATA_BACKEND
 * goes too, otherwise the next rebuild reads it with no URL beside it and mints
 * a fresh sidecar for a node that just stopped having one.
 */
function retireFleetDbEnvPins(botId: string): void {
  for (const key of ['DATA_BACKEND', 'DATA_BACKEND_URL', 'DATA_BACKEND_PUBLIC_URL', 'CONTROL_STORE_URL']) {
    envManager.deleteEnvVar(botId, key);
    containerManager.removeBotEnvVars(botId, [key]);
    containerManager.removeEnvKeyFromDeployedCompose(botId, key);
  }
}

/**
 * Heal a stale primary (PLAN_REPLICATION.md Stage 5): the machine that used to
 * serve the fleet database comes back after the pair failed over to the other
 * one, and its copy is a fork nobody may ever read again. This turns it into an
 * ordinary standby of the new primary, so the whole fleet is back to one
 * database with one copy and failback is the normal planned handover.
 *
 * Re-seed rather than pg_rewind: a rewind needs data checksums or
 * wal_log_hints on the target, and a managed sidecar is initdb'd with neither,
 * so the lane would be dead code. Both paths discard the diverged tail anyway
 * (R6 calls the whole re-seed a convenience over the bot-side fence).
 *
 * The instance must be STOPPED: this deletes the database it is running on.
 */
export function reseedStalePrimary(
  instance: InstanceConfig,
  primaryDsn: string,
  certPem: string,
  publicHost: string,
  hostPort?: number,
): { success: boolean; error?: string; started?: boolean } {
  if (!instance.fleetDb) {
    return { success: false, error: 'This instance hosts no managed fleet database, so there is no stale primary to heal - use Provision instead' };
  }
  if (instance.fleetDbReplica) return { success: false, error: 'A replica already exists on this instance - remove it first' };
  if (provisioning.has(instance.id)) return { success: false, error: 'Provisioning is already running' };
  const busyOp = containerManager.isBotBusy(instance.id);
  if (busyOp) return { success: false, error: `Operation '${busyOp}' is running on this instance; wait for it to finish` };
  if (instance.status === 'running') {
    return { success: false, error: 'Stop the instance first: re-seeding deletes the database it is currently running on' };
  }
  if (!containerManager.deployedComposeExists(instance.id)) {
    return { success: false, error: 'Install/build the instance first - the standby joins its compose project' };
  }

  const validated = validateIntake(primaryDsn, certPem, publicHost, hostPort);
  if (!validated.ok) return { success: false, error: validated.error };
  const { dsn: parsedDsn, port } = validated.intake;
  // This instance's own primary record is exempt: its port frees up the moment
  // the retire below runs, and reusing it is the normal outcome.
  const collision = containerManager.getAllBots().find(other =>
    (other.id !== instance.id
      && (other.fleetDb?.replication?.hostPort === port || other.fleetDbReplica?.hostPort === port))
    || other.recoveryChannel?.tunnelPort === port);
  if (collision) {
    return { success: false, error: `Host port ${port} is already used by "${collision.displayName}" - pick another` };
  }
  // Includes this instance deliberately: pasting its OWN block would seed a
  // standby from the very database that is about to be deleted.
  const samehost = containerManager.getAllBots().find(other => {
    const repl = other.fleetDb?.replication;
    return repl && repl.publicHost === parsedDsn.host && repl.hostPort === parsedDsn.port;
  });
  if (samehost) {
    return {
      success: false,
      error: samehost.id === instance.id
        ? 'That block is this instance\'s OWN database, which is the stale one. Paste the block from the machine that now serves the fleet'
        : `That primary ("${samehost.displayName}") lives on THIS machine - a replica here would die with it. Re-seed from the machine that now serves the fleet`,
    };
  }

  startProvisioning(instance, replicaRecordFor(instance, validated.intake), validated.intake, async () => {
    // Stopping the instance took its whole compose project down, so the
    // database has to come back up alone to be dumped at all. Best effort, and
    // deliberately not fatal: a database that will not start cannot be dumped,
    // and the operator has already accepted losing the diverged tail. The dump
    // is a safety net, not a precondition.
    const started = await containerManager.startFleetDbSidecar(instance.id);
    const dump = started.success
      ? await fleetBackup.runFleetDump(instance, 'pre-reseed-')
      : { success: false, error: started.error };
    if (!dump.success) {
      console.warn(`[FleetReplica] Could not dump the stale primary before re-seeding ${instance.id}: ${dump.error}`);
    }
    const retired = await containerManager.retireFleetDbSidecar(instance.id);
    if (!retired.success) throw new Error(`could not retire the stale database: ${retired.error}`);
    // BEFORE the seed: if the seed then fails, this node is an ordinary worker
    // that will take the live fleet database from the master's next delivery
    // and merely lacks a standby, which beats staying pinned to a database
    // that was just deleted.
    retireFleetDbEnvPins(instance.id);
  });
  return { success: true, started: true };
}

/**
 * The fleet database password, for an instance whose manager env store has
 * none. A worker is never told the URL by the manager: the master delivers it
 * on register and the bot persists it in its own data/.env, so that file is
 * the only place this machine's copy of the fleet credentials exists.
 */
function fleetPasswordFromBotEnv(botId: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(getDataPath(botId), '.env'), 'utf-8');
  } catch {
    return null;
  }
  for (const line of raw.split('\n')) {
    const match = /^\s*DATA_BACKEND_URL\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[1].trim().replace(/^["']|["']$/g, '');
    try {
      const password = decodeURIComponent(new URL(value).password);
      if (password) return password;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Adopt a promoted standby as this machine's fleet database
 * (PLAN_REPLICATION.md Stage 5). This is the other half of the stale-primary
 * re-seed: after a pair promotion the bot serves its local copy, but the
 * manager still files it as somebody else's standby, so the machine that just
 * became the primary offers no replication surface and cannot hand out the
 * copy block the old machine needs. Without this, the re-seed has no source.
 *
 * Enabling replication straight away is not an extra: it mints the slot a
 * pg_basebackup needs, files this machine's endpoint as the public form
 * (the bot already repointed itself through /data/.env, so the manager's copy
 * was the stale one), and is what keeps a rebuild recognising the sidecar as
 * managed rather than external.
 */
export async function adoptPromotedReplica(
  instance: InstanceConfig,
): Promise<{ success: boolean; error?: string; restartRequired?: boolean }> {
  const rec = instance.fleetDbReplica;
  if (!rec) return { success: false, error: 'This instance has no standby to adopt' };
  if (instance.fleetDb) return { success: false, error: 'This instance already hosts a fleet database' };
  if (provisioning.has(instance.id)) return { success: false, error: 'Provisioning is running; wait for it to finish' };
  const busyOp = containerManager.isBotBusy(instance.id);
  if (busyOp) return { success: false, error: `Operation '${busyOp}' is running on this instance; wait for it to finish` };

  const status = await getFleetReplicaStatus(instance);
  if (!status.live?.running) {
    return { success: false, error: 'The standby container is not running, so it cannot be adopted; start the instance first' };
  }
  // Adopting a copy that still follows somebody would file a standby as a
  // primary and invite a second Enable to fork the pair.
  if (status.live.inRecovery !== false) {
    return { success: false, error: 'This copy is still following a primary, so it is not this machine\'s database yet. Promote this node first (its own web UI), then adopt' };
  }

  // A worker's manager env store carries no database URL, so the managed-lane
  // checks (and the password enableFleetReplication needs) have nothing to read
  // until this instance is filed like any other database host.
  const password = (() => {
    const current = (envManager.getEnvVars(instance.id)['DATA_BACKEND_URL'] || '').trim();
    if (current !== '') {
      try { return decodeURIComponent(new URL(current).password) || null; } catch { return null; }
    }
    return fleetPasswordFromBotEnv(instance.id);
  })();
  if (!password) {
    return { success: false, error: 'Could not recover the fleet database credentials from this instance (neither the manager env nor the bot data/.env carries a usable DATA_BACKEND_URL), so the database cannot be adopted' };
  }

  const adopted = containerManager.adoptFleetDbReplicaAsPrimary(instance.id);
  if (!adopted.success) return adopted;
  const live = containerManager.getBot(instance.id);
  if (!live) return { success: false, error: 'Bot not found after adopting the record' };

  // The container-name form first, deliberately: it is what marks the sidecar
  // MANAGED, so a rebuild landing between here and the enable below still keeps
  // the database in the compose. The enable keeps it and adds the public form
  // beside it (F1: same-host consumers cannot dial the public form).
  envManager.setEnvVars(instance.id, {
    DATA_BACKEND: 'postgres',
    DATA_BACKEND_URL: `postgresql://smdb:${encodeURIComponent(password)}@${rec.containerName}:5432/smdb`,
  });

  const enabled = await enableFleetReplication(live, rec.publicHost, rec.hostPort);
  if (!enabled.success) {
    // Leave the adopted record in place: the database IS this machine's now,
    // and the operator can retry Enable from the replication section. Rolling
    // the record back would hide a live primary behind a standby surface again.
    return { success: false, error: `The database was adopted, but enabling replication on it failed (retry from the Replication section): ${enabled.error}` };
  }
  // enableFleetReplication repoints DATA_BACKEND_URL; the control store URL
  // only exists when the topology splits them, and then it moves too. Both
  // stores: the deployed compose env is built from the instance record, so
  // an env-store-only move would bake the stale pin back in on next start.
  const stored = envManager.getEnvVars(instance.id);
  if ((stored['CONTROL_STORE_URL'] || '').trim() !== '') {
    const controlUrl = (stored['DATA_BACKEND_URL'] || '').trim();
    envManager.setEnvVars(instance.id, { CONTROL_STORE_URL: controlUrl });
    await containerManager.updateBot(instance.id, { envVars: { CONTROL_STORE_URL: controlUrl } });
  }
  return { success: true, restartRequired: true };
}
