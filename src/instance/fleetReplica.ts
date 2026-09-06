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
import { findAppCapabilities, foldedRoleValue, CompanionDbSpec } from '../config/appCapabilities';
import { capabilityRefusal, getAppFacts } from './appLifecycle';
import { hasAppHooks } from './appHookClient';
import { InstanceConfig, FleetDbReplicaRecord, FleetReplicaAutoReseedLedger, FleetReplicaSeedPhase, FleetReplicaSeedPurpose, FleetReplicaSeedRecord } from '../types';

const REPLICATION_SLOT = 'fleet_standby';
const DEFAULT_HOST_PORT = 15432;
const PGDATA = '/var/lib/postgresql/data';
const SEED_TIMEOUT_MS = 30 * 60 * 1000;
const PULL_TIMEOUT_MS = 10 * 60 * 1000;
// Generous: volExec calls run under `docker run`, and slow disks are real.
const EXEC_TIMEOUT_MS = 120_000;

/** Attempts the automatic re-seed makes before it stops and asks (20.14). */
export const AUTO_RESEED_MAX_ATTEMPTS = 3;
/** Minimum spacing between automatic attempts, so a failing re-seed never re-fires on every health tick. */
const AUTO_RESEED_SPACING_MS = 30 * 60_000;
/** A facts read on the re-seed's entry must not hang it; the hook's default timeout is sized for a promote. */
const FACTS_TIMEOUT_MS = 10_000;

/**
 * The seed in flight lives on the instance record, never in memory: a manager
 * restart mid-seed must still show the operation (parked, see
 * parkInterruptedReplicaSeeds) instead of losing it while the seed container
 * keeps running.
 */
function seedRecord(botId: string): FleetReplicaSeedRecord | null {
  return containerManager.getBot(botId)?.fleetDbReplicaSeed ?? null;
}

function saveSeed(botId: string, patch: Partial<FleetReplicaSeedRecord>): void {
  const current = seedRecord(botId);
  if (!current) return;
  containerManager.updateInstanceFleetDbReplicaSeed(botId, { ...current, ...patch, updatedAt: Date.now() });
}

/** A seed a runner owns right now; a parked one blocks nothing. */
function seedRunning(botId: string): boolean {
  const seed = seedRecord(botId);
  return seed !== null && seed.parked !== true;
}

class SeedCancelled extends Error {}
/** The record the run was started for is gone or is a different standby now. */
class SeedSuperseded extends Error {}

function throwIfCancelled(botId: string): void {
  if (seedRecord(botId)?.cancelRequested === true) throw new SeedCancelled('cancelled by the operator');
}

function dockerRmForce(name: string): Promise<{ ok: boolean; stderr: string }> {
  return new Promise(resolve => {
    execFile('docker', ['rm', '-f', name], { timeout: EXEC_TIMEOUT_MS }, (err, _stdout, stderr) => {
      resolve({ ok: !err, stderr: String(stderr || err || '') });
    });
  });
}

/** A removal docker refused only because the container is already gone (or going) counts as done. */
function rmSettled(result: { ok: boolean; stderr: string }): boolean {
  return result.ok || /no such container|already in progress/i.test(result.stderr);
}

/** true, false, or null when docker could not say; a destructive step must refuse on null. */
function containerRunning(name: string): Promise<boolean | null> {
  return new Promise(resolve => {
    execFile('docker', ['inspect', '--format', '{{.State.Running}}', name], { timeout: EXEC_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (!err) return resolve(String(stdout).trim() === 'true');
      resolve(/no such object|no such container/i.test(String(stderr || err)) ? false : null);
    });
  });
}

function seedContainerName(instance: InstanceConfig): string {
  return `${instance.sanitizedName}-fleet-replica-seed`;
}

function slotResetContainerName(instance: InstanceConfig): string {
  return `${seedContainerName(instance)}-slot`;
}

function seedHelperNames(instance: InstanceConfig): string[] {
  return [seedContainerName(instance), slotResetContainerName(instance)];
}

/** One spelling of each purpose for the manager's own text. */
export function seedPurposeLabel(purpose: FleetReplicaSeedPurpose): string {
  if (purpose === 'reseed-standby') return 'Re-seeding the standby';
  if (purpose === 'reseed-stale-primary') return 'Re-seeding this database as a standby';
  return 'Provisioning the standby';
}

function patchLedger(botId: string, fn: (current: FleetReplicaAutoReseedLedger | undefined) => FleetReplicaAutoReseedLedger | undefined): void {
  const rec = containerManager.getBot(botId)?.fleetDbReplica;
  if (!rec) return;
  const { autoReseed: _drop, ...rest } = rec;
  const next = fn(rec.autoReseed);
  containerManager.updateInstanceFleetDbReplica(botId, next ? { ...rest, autoReseed: next } : rest);
}

function ledgerAttempt(botId: string, trigger: 'automatic' | 'operator'): void {
  patchLedger(botId, current => {
    const next: FleetReplicaAutoReseedLedger = { attempts: (current?.attempts ?? 0) + 1, lastAttemptAt: Date.now(), trigger };
    if (current?.lastSuccessAt) next.lastSuccessAt = current.lastSuccessAt;
    return next;
  });
}

function ledgerFailure(botId: string, error: string): void {
  patchLedger(botId, current => (current ? { ...current, lastError: error } : undefined));
}

/** Record that this standby's copy is gone (or back), for readers that outlive the seed record. */
function setCopyCleared(botId: string, cleared: boolean): void {
  const rec = containerManager.getBot(botId)?.fleetDbReplica;
  if (!rec || rec.copyCleared === cleared) return;
  const { copyCleared: _drop, ...rest } = rec;
  containerManager.updateInstanceFleetDbReplica(botId, cleared ? { ...rest, copyCleared: true } : rest);
}

function ledgerSuccess(botId: string): void {
  patchLedger(botId, current => ({ attempts: 0, lastAttemptAt: current?.lastAttemptAt ?? Date.now(), trigger: current?.trigger ?? 'automatic', lastSuccessAt: Date.now() }));
}

/** Whether the automatic re-seed may fire for this standby: under the cap and past the spacing. */
export function autoReseedAllowed(rec: FleetDbReplicaRecord, now: number = Date.now()): boolean {
  const ledger = rec.autoReseed;
  if (!ledger) return true;
  return ledger.attempts < AUTO_RESEED_MAX_ATTEMPTS && now - ledger.lastAttemptAt >= AUTO_RESEED_SPACING_MS;
}

// 'absent' only when docker itself says "no such volume": any other failure
// (daemon down, spawn EAGAIN) is 'unknown', which the caller must refuse on -
// inferring absence from an arbitrary error skips a dump gate over real data.
function dockerVolumeState(name: string): Promise<'exists' | 'absent' | 'unknown'> {
  return new Promise(resolve => {
    execFile('docker', ['volume', 'inspect', name], (err, _stdout, stderr) => {
      if (!err) return resolve('exists');
      resolve(String(stderr || '').toLowerCase().includes('no such volume') ? 'absent' : 'unknown');
    });
  });
}

async function volExec(volume: string, script: string, stdin?: string, extraMounts: string[] = []): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  // Named for the same reason the seed is: killing the CLI leaves the
  // container running daemon-side, still writing inside the volume the next
  // seed is about to copy into.
  const helper = `${volume}-helper`;
  await dockerRmForce(helper);
  const args = ['run', '--rm', '--name', helper, ...(stdin !== undefined ? ['-i'] : []),
    '-v', `${volume}:${PGDATA}`, ...extraMounts.flatMap(m => ['-v', m]),
    '--entrypoint', 'sh', 'postgres:16-alpine', '-c', script];
  return new Promise(resolve => {
    const child = spawn('docker', args);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { void dockerRmForce(helper).then(() => child.kill('SIGKILL')); }, EXEC_TIMEOUT_MS);
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
    db: (url.pathname || '').replace(/^\//, ''),
  };
  if (!parsed.user || !parsed.password) return { ok: false, error: 'DSN must carry the replication user and password' };
  if (!parsed.db) return { ok: false, error: 'DSN must name the database' };
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
  provisioning?: { phase: FleetReplicaSeedPhase; purpose: FleetReplicaSeedPurpose; forSeconds: number; cancelable: boolean; cancelRequested: boolean; committed: boolean };
  /** A seed no runner owns any more (it failed, or a manager restart interrupted it): Retry or Dismiss. */
  parkedSeed?: { purpose: FleetReplicaSeedPurpose; phase: FleetReplicaSeedPhase; lastError: string; at: number; committed: boolean; cancelled: boolean };
  /** The automatic re-seed's attempt ledger, from the standby record. */
  autoReseed?: FleetReplicaAutoReseedLedger;
  /** The ledger hit the attempt cap: nothing re-fires until an operator asks. */
  autoReseedStopped?: boolean;
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
  const seed = instance.fleetDbReplicaSeed ?? null;
  const status: FleetReplicaStatus = {
    present: !!instance.fleetDbReplica || (!!seed && !seed.parked),
    lastError: seed?.parked ? seed.lastError : undefined,
  };
  if (seed && !seed.parked) {
    status.provisioning = {
      phase: seed.phase,
      purpose: seed.purpose,
      forSeconds: Math.round((Date.now() - seed.startedAt) / 1000),
      cancelable: seed.phase === 'preparing' || seed.phase === 'seeding',
      cancelRequested: seed.cancelRequested === true,
      committed: seed.committed === true,
    };
  } else if (seed) {
    status.parkedSeed = {
      purpose: seed.purpose,
      phase: seed.phase,
      lastError: seed.lastError || 'stopped',
      at: seed.updatedAt,
      committed: seed.committed === true,
      cancelled: seed.cancelled === true,
    };
  }
  const rec = instance.fleetDbReplica;
  if (!rec) return status;
  if (rec.autoReseed) {
    status.autoReseed = rec.autoReseed;
    status.autoReseedStopped = rec.autoReseed.attempts >= AUTO_RESEED_MAX_ATTEMPTS;
  }
  status.record = {
    containerName: rec.containerName,
    publicHost: rec.publicHost,
    hostPort: rec.hostPort,
    primaryHost: rec.primaryHost,
    primaryPort: rec.primaryPort,
  };
  // Identity from the STAMP, like every sibling; a record stamped before the
  // identity fields cannot be probed and says so instead of guessing a role.
  // status.live stays ABSENT (unknown), never a fabricated running:false -
  // consumers would read that as "container down", which is a different claim.
  if (!rec.user || !rec.db) {
    status.lastError = status.lastError || 'standby record predates identity stamping; retire and re-provision the standby';
    return status;
  }
  const probe = await replicaExec(rec.containerName, ['psql', '-U', rec.user, '-d', rec.db, '-Atc',
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
  // Identity stamped from the capability record at provisioning time (the
  // standby is a byte copy of that app's database); the DSN's own user is the
  // replication login, not the app identity.
  const spec = findAppCapabilities(instance.sourceUrl)?.companionDb;
  return {
    containerName: `${instance.sanitizedName}-fleet-postgres-replica`,
    volume: `${instance.sanitizedName}-fleet-postgres-replica-data`,
    slot: REPLICATION_SLOT,
    primaryHost: intake.dsn.host,
    primaryPort: intake.dsn.port,
    publicHost: intake.host,
    hostPort: intake.port,
    certHost: intake.host,
    ...(spec ? { user: spec.user, db: spec.database } : {}),
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
  purpose: FleetReplicaSeedPurpose,
  preflight?: () => Promise<void>,
): { success: boolean; error?: string } {
  // The busy check, the record write and the lock claim share one synchronous
  // segment: a second entrant that wrote the record and only then lost the
  // lock would park the record the winner is running under.
  const busyOp = containerManager.isBotBusy(instance.id);
  if (busyOp) return { success: false, error: `Operation '${busyOp}' is running on this instance; wait for it to finish` };
  const now = Date.now();
  // committed describes the VOLUME, not this run: a re-seed starting over a
  // stopped one whose wipe already ran inherits it, so the cancel warning does
  // not lapse while the copy is still gone.
  const inherited = seedRecord(instance.id)?.committed === true
    || containerManager.getBot(instance.id)?.fleetDbReplica?.copyCleared === true;
  containerManager.updateInstanceFleetDbReplicaSeed(instance.id, {
    purpose,
    phase: 'preparing',
    startedAt: now,
    updatedAt: now,
    ...(inherited ? { committed: true } : {}),
    publicHost: record.publicHost,
    hostPort: record.hostPort,
    primaryHost: record.primaryHost,
    primaryPort: record.primaryPort,
    slot: record.slot,
  });
  const ownsRecord = (): boolean => seedRecord(instance.id)?.startedAt === now;
  void containerManager.withExternalBotOp(instance.id, 'replica-seed', async () => {
    throwIfCancelled(instance.id);
    if (preflight) await preflight();
    await runProvisioning(instance, record, intake.dsn, intake.cert, purpose);
  }).then(() => {
    if (!ownsRecord()) return;
    containerManager.updateInstanceFleetDbReplicaSeed(instance.id, null);
    if (purpose === 'reseed-standby') ledgerSuccess(instance.id);
  }, err => {
    if (!ownsRecord()) return;
    const message = String(err instanceof Error ? err.message : err);
    // Nothing of this instance's is left to retry or dismiss.
    if (err instanceof SeedSuperseded) {
      containerManager.updateInstanceFleetDbReplicaSeed(instance.id, null);
      return;
    }
    if (err instanceof SeedCancelled || seedRecord(instance.id)?.cancelRequested === true) {
      // Before the first irreversible step the cancel restores what was there,
      // so the record goes; after it the operator must be told what is gone.
      const stranded = seedRecord(instance.id)?.committed === true && purpose !== 'provision';
      const what = !stranded
        ? 'cancelled by the operator'
        : purpose === 'reseed-standby'
          ? 'cancelled after the old copy was cleared, so this standby holds no usable copy until it is re-seeded or removed'
          : 'cancelled after the stale database was retired, so this node is now an ordinary worker without a standby (its pre-reseed dump is in the backups list if it succeeded)';
      // The attempt is already counted, so the ledger must carry its reason or
      // the modal keeps reporting an attempt that is no longer running.
      if (purpose === 'reseed-standby') ledgerFailure(instance.id, what);
      if (!stranded) {
        containerManager.updateInstanceFleetDbReplicaSeed(instance.id, null);
        return;
      }
      saveSeed(instance.id, { parked: true, cancelRequested: false, cancelled: true, lastError: what });
      return;
    }
    saveSeed(instance.id, { parked: true, lastError: message });
    if (purpose === 'reseed-standby') ledgerFailure(instance.id, message);
  }).finally(() => containerManager.broadcastBotUpdated(instance.id));
  return { success: true };
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
  if (seedRunning(instance.id)) return { success: false, error: 'Provisioning is already running' };
  const busyOp = containerManager.isBotBusy(instance.id);
  if (busyOp) return { success: false, error: `Operation '${busyOp}' is running on this instance; wait for it to finish` };
  // Null record routes through refusal, never a silent degrade: the standby
  // record's identity is stamped from the capability record, so without one
  // the minted record could never be probed or adopted.
  if (!findAppCapabilities(instance.sourceUrl)?.companionDb) {
    return { success: false, error: 'This app declares no managed database companion' };
  }
  // A standby lives beside a fleet WORKER (R7): an instance with its own
  // managed database is the primary side, and a non-fleet bot has no use for
  // a fleet replica.
  if (instance.fleetDb) return { success: false, error: 'This instance hosts the fleet database itself - replication is managed from its Database modal' };
  const controlPlane = findAppCapabilities(instance.sourceUrl)?.controlPlane;
  if (!controlPlane) {
    return { success: false, error: 'This app declares no fleet control plane - a standby belongs beside a fleet worker' };
  }
  const folded = foldedRoleValue(controlPlane.roleEnv, instance.envVars?.[controlPlane.roleEnv.key]);
  if (!controlPlane.roleEnv.dialsOut.includes(folded)) {
    return { success: false, error: `A replica belongs beside a fleet worker (set ${controlPlane.roleEnv.key} to ${controlPlane.roleEnv.dialsOut.join(' or ')} first)` };
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
  const started = startProvisioning(instance, replicaRecordFor(instance, validated.intake), validated.intake, 'provision');
  if (!started.success) return started;
  return { success: true, started: true };
}

async function runProvisioning(instance: InstanceConfig, record: FleetDbReplicaRecord, dsn: ParsedDsn, certPem: string, purpose: FleetReplicaSeedPurpose): Promise<void> {
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
  throwIfCancelled(instance.id);

  // A ghost seeder from a previous timeout or a manager restart mid-seed still
  // holds the volume: kill it before touching anything.
  await dockerRmForce(seedName);

  // Whatever the volume holds is superseded here: manager debris on a first
  // provision, and on a re-seed the verified-stale copy 20.14 rules wipeable.
  // Past this point cancelling cannot put it back.
  throwIfCancelled(instance.id);
  saveSeed(instance.id, { committed: true });
  setCopyCleared(instance.id, true);
  const wipe = await volExec(record.volume, `find ${PGDATA} -mindepth 1 -maxdepth 1 -exec rm -rf {} +`);
  if (!wipe.ok) throw new Error(`could not clear the replica volume: ${wipe.stderr.trim()}`);
  throwIfCancelled(instance.id);

  const seedDsn = `postgresql://${encodeURIComponent(dsn.user)}:${encodeURIComponent(dsn.password)}@${dsn.host}:${dsn.port}/${dsn.db}?sslmode=verify-full&sslrootcert=/primary-ca.crt`;

  // A slot the WAL bound invalidated stays invalidated for good: a seed on it
  // streams but retains nothing (the primary reports it unreserved while
  // attached and loses it again at the first blip), so the re-seed the lost
  // verdict prescribes would loop. The replicator role may drop and re-create
  // slots, so an inactive invalidated slot is re-created here. A live one is
  // left alone, and a MISSING one stays missing: a primary whose replication
  // was disabled must keep refusing the seed exactly as before.
  const resetName = slotResetContainerName(instance);
  await dockerRmForce(resetName);
  const slotReset = await new Promise<{ ok: boolean; stderr: string }>(resolve => {
    const child = spawn('docker', ['run', '--rm', '--name', resetName,
      '-v', `${hostCertPath}:/primary-ca.crt:ro`,
      '--entrypoint', 'psql', 'postgres:16-alpine',
      seedDsn, '-v', 'ON_ERROR_STOP=1', '-Atc', `
      DO $$ DECLARE s record; BEGIN
        SELECT active, wal_status INTO s FROM pg_replication_slots WHERE slot_name = '${record.slot}';
        IF FOUND AND NOT s.active AND s.wal_status IN ('lost', 'unreserved') THEN
          PERFORM pg_drop_replication_slot('${record.slot}');
          PERFORM pg_create_physical_replication_slot('${record.slot}');
        END IF;
      END $$;`]);
    let stderr = '';
    // Same rule as the seed below: a signal to the CLI is proxied to psql as
    // PID 1, which drops it, so the container is removed by name instead.
    const timer = setTimeout(() => {
      execFile('docker', ['rm', '-f', resetName], () => child.kill('SIGKILL'));
    }, 60_000);
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, stderr: stderr || 'docker run failed' }); });
    child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, stderr }); });
  });
  if (!slotReset.ok) {
    // psql prints ERROR, DETAIL and CONTEXT lines; the ERROR line is the one
    // to show, never with the DSN's password should it ever be echoed.
    const lines = slotReset.stderr.trim().split('\n');
    const reason = (lines.find(l => l.startsWith('ERROR')) || lines.pop() || 'psql failed').split(dsn.password).join('***');
    throw new Error(`could not reset the replication slot on the primary: ${reason}`);
  }

  throwIfCancelled(instance.id);
  saveSeed(instance.id, { phase: 'seeding' });
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

  throwIfCancelled(instance.id);
  saveSeed(instance.id, { phase: 'configuring' });

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

  saveSeed(instance.id, { phase: 'starting' });
  // The record can be removed at any point during the minutes this takes, and
  // writing the snapshot back here would silently undo that removal.
  const current = containerManager.getBot(instance.id)?.fleetDbReplica;
  if (purpose === 'reseed-standby' && (!current || current.containerName !== record.containerName || current.volume !== record.volume)) {
    throw new SeedSuperseded('the standby record was removed while the re-seed ran');
  }
  const ledger = current?.autoReseed;
  // The copy is byte-complete here, so it goes back whole. Stripped explicitly:
  // a retry was handed the record an earlier attempt had already marked.
  const { copyCleared: _whole, ...restored } = record;
  containerManager.updateInstanceFleetDbReplica(instance.id, ledger ? { ...restored, autoReseed: ledger } : restored);
  const apply = await containerManager.applyFleetDbReplicaService(instance.id);
  if (!apply.success) {
    // A first provision leaves no half record behind; either re-seed keeps the
    // standby's record, because the copy is complete and only its service is
    // down, and the record is what makes a rebuild re-inject that service.
    if (purpose === 'provision') containerManager.updateInstanceFleetDbReplica(instance.id, null);
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
  if (seedRunning(instance.id)) return { success: false, error: 'Provisioning is running; wait for it to finish' };
  const removed = await containerManager.removeFleetDbReplicaService(instance.id, rec.containerName);
  if (!removed.success) return removed;
  containerManager.updateInstanceFleetDbReplica(instance.id, null);
  containerManager.updateInstanceFleetDbReplicaSeed(instance.id, null);
  return { success: true };
}
/**
 * Stop pinning the fleet database on a node that no longer hosts it. A worker
 * is not told its database by the manager at all: the master delivers it on
 * register and the bot persists it in its own env file. Leaving the old values
 * in the manager env would pin them into the container, where they outrank the
 * app's own store, so the master's delivery could never take effect and this
 * node could never pair-promote later (its own promote refuses on exactly that
 * pin). The mode key goes too, otherwise the next rebuild reads it with no URL
 * beside it and mints a fresh sidecar for a node that just stopped having one.
 */
function retireFleetDbEnvPins(botId: string): void {
  for (const key of companionEnvKeys(botId)) {
    envManager.deleteEnvVar(botId, key);
    containerManager.removeBotEnvVars(botId, [key]);
    containerManager.removeEnvKeyFromDeployedCompose(botId, key);
  }
}

/**
 * Every key the manager must stop pinning for this app's companion database.
 * Driven entirely by the app's capability record: an app that declares none
 * has no keys the manager could have pinned, so nothing is deleted from its
 * stores (the manager never invents another app's spelling).
 * appOwnedEnv is included deliberately: the manager never authors those, so a
 * value in ITS stores is an anomaly that would outrank the app's own store.
 */
function companionEnvKeys(botId: string): string[] {
  const db = findAppCapabilities(containerManager.getBot(botId)?.sourceUrl)?.companionDb;
  if (!db) return [];
  const keys = [db.env.url, db.env.publicUrl, db.env.mode?.key, ...(db.repointedEnv ?? []), ...(db.appOwnedEnv ?? [])];
  return Array.from(new Set(keys.filter((k): k is string => !!k)));
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
  if (seedRunning(instance.id)) return { success: false, error: 'Provisioning is already running' };
  const busyOp = containerManager.isBotBusy(instance.id);
  if (busyOp) return { success: false, error: `Operation '${busyOp}' is running on this instance; wait for it to finish` };
  // Same null-record refusal as provisionFleetReplica: the re-seeded standby's
  // record is stamped from the capability record.
  if (!findAppCapabilities(instance.sourceUrl)?.companionDb) {
    return { success: false, error: 'This app declares no managed database companion' };
  }
  if (instance.status === 'running') {
    return { success: false, error: 'Stop the instance first: re-seeding deletes the database it is currently running on' };
  }
  if (!containerManager.deployedComposeExists(instance.id)) {
    return { success: false, error: 'Install/build the instance first - the standby joins its compose project' };
  }
  // BEFORE anything destructive: a corrupt store would make the pins retire
  // throw AFTER the stale database is destroyed, leaving the node pinned to a
  // database that no longer exists and the lane not re-runnable.
  if (envManager.getEnvVarsWithStatus(instance.id).corrupt) {
    return { success: false, error: 'The env store for this instance cannot be read (preserved as storage.json.corrupt); restore it before re-seeding' };
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

  const started = startProvisioning(instance, replicaRecordFor(instance, validated.intake), validated.intake, 'reseed-stale-primary', async () => {
    throwIfCancelled(instance.id);
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
    // Re-check just before the destructive step: the dump above can take
    // minutes, and a store that corrupted meanwhile would make the pins
    // retire below throw AFTER the database was destroyed.
    if (envManager.getEnvVarsWithStatus(instance.id).corrupt) {
      throw new Error('the env store corrupted while the safety dump ran (preserved as storage.json.corrupt); nothing was destroyed - restore it and retry');
    }
    // The dump above takes minutes, so a cancel filed during it is honoured
    // here, with the sidecar running and the record intact.
    throwIfCancelled(instance.id);
    const retired = await containerManager.retireFleetDbSidecar(instance.id);
    if (!retired.success) throw new Error(`could not retire the stale database: ${retired.error}`);
    // Committed once the retire reports success: a retire that refuses before
    // it touches the volume leaves everything in place, and a cancel filed
    // there must not claim the database is gone.
    saveSeed(instance.id, { committed: true });
    // BEFORE the seed: if the seed then fails, this node is an ordinary worker
    // that will take the live fleet database from the master's next delivery
    // and merely lacks a standby, which beats staying pinned to a database
    // that was just deleted.
    retireFleetDbEnvPins(instance.id);
  });
  if (!started.success) return started;
  return { success: true, started: true };
}

/**
 * Destroy this instance's managed fleet database (PLAN_REPLICATION 20.13
 * [Decommission]; design ruled 2026-09-01: DUMP-GATED DESTROY). "Is it still
 * in use?" proved unanswerable by enumerating consumers five review rounds
 * running (the B4m-2a record), so no app fact gates anything here. The ONLY
 * permit is a fresh pre-decommission dump that SUCCEEDS: a wrong click then
 * costs downtime, not data, because the dump restores through the restore
 * lane into a re-provisioned sidecar. The refusals below are the manager's
 * OWN records exclusively.
 */
export async function decommissionFleetDb(
  botId: string
): Promise<{ success: boolean; error?: string; dumpFile?: string }> {
  try {
    // The bot op lock is held for the whole lane so a concurrent Start cannot
    // boot the instance onto the database mid-destroy; the guards re-read a
    // fresh snapshot INSIDE the lock, since callers hold a stale one.
    return await containerManager.withExternalBotOp(botId, 'decommission', async () => {
      const instance = containerManager.getBot(botId);
      if (!instance?.fleetDb) return { success: false, error: 'This instance hosts no managed fleet database' };
      const refusal = capabilityRefusal(instance);
      if (refusal) return { success: false, error: refusal };
      if (instance.fleetDbReplica) return { success: false, error: 'This instance also holds a standby copy - remove or adopt it before decommissioning the primary database' };
      if (instance.recoveryChannel) return { success: false, error: 'A recovery channel is armed on this database - disarm it first' };
      if (instance.recoveryRescue) return { success: false, error: 'A database rescue is in progress on this instance - finish or cancel it first' };
      if (seedRunning(instance.id)) return { success: false, error: 'Provisioning is already running on this instance' };
      if (instance.status === 'running') {
        return { success: false, error: 'Stop the instance first: decommission destroys the database it is running on' };
      }
      // The status record can lie after a compose down that failed but still
      // reported success, so ask docker itself. The probe excludes the
      // sidecar by exact record name, so a retry with the database running
      // alone still passes.
      const liveContainers = await containerManager.runningNonSidecarContainers(instance.id);
      if (liveContainers === null) {
        return { success: false, error: 'Could not verify that this instance is fully stopped (docker did not answer) - try again' };
      }
      if (liveContainers.length > 0) {
        return { success: false, error: `Containers of this instance are still running (${liveContainers.join(', ')}) - stop it fully first` };
      }
      if (!fleetBackup.claimFleetBackupBusy(instance.id)) {
        return { success: false, error: 'A backup or restore operation is in progress on this database - wait for it to finish' };
      }
      try {
        // A volume PROVEN absent has nothing to protect, and starting the
        // sidecar would MINT a fresh empty database whose dump would then
        // pose as the safety copy (a partial earlier attempt destroys the
        // volume before the compose strip). Only then is the dump skipped;
        // that earlier attempt's real dump is already in the backups list.
        // An unanswerable probe refuses: skipping the gate on a guess is the
        // destroy-without-dump hole this whole design exists to close.
        let dumpFile: string | undefined;
        const volState = await dockerVolumeState(instance.fleetDb.volume);
        if (volState === 'unknown') {
          return { success: false, error: 'Refused, nothing was destroyed: could not verify the database volume (docker did not answer) - try again' };
        }
        if (volState === 'exists') {
          // The permit. Stopping the instance took the sidecar down with its
          // compose project, so it comes back up alone to be dumped at all.
          const started = await containerManager.startFleetDbSidecar(instance.id);
          if (!started.success) {
            return { success: false, error: `Refused, nothing was destroyed: the database did not come up for the pre-decommission dump: ${started.error}. If its container started, it was left running alone for inspection` };
          }
          const dump = await fleetBackup.runFleetDump(instance, 'pre-decommission-');
          if (!dump.success) {
            return { success: false, error: `Refused, nothing was destroyed: the pre-decommission dump failed: ${dump.error}. The database was left running alone for inspection` };
          }
          dumpFile = dump.file;
        }

        const retired = await containerManager.retireFleetDbSidecar(instance.id);
        if (!retired.success) {
          return { success: false, error: `${dumpFile ? `The safety dump succeeded (${dumpFile}) but the teardown failed` : 'The teardown failed'}: ${retired.error}`, dumpFile };
        }
        try {
          retireFleetDbEnvPins(instance.id);
        } catch (err) {
          // The database is already destroyed and the dump kept: a pins
          // failure must not read as a refusal. Leftover pins only mean a
          // later rebuild re-mints a recorded empty sidecar.
          console.error(`[FleetReplica] Decommissioned ${instance.id} but failed to retire its env pins:`, err);
        }
        fleetBackup.clearTermFloor(instance.id);
        return { success: true, dumpFile };
      } finally {
        fleetBackup.releaseFleetBackupBusy(instance.id);
      }
    });
  } catch (err) {
    return { success: false, error: String((err as Error)?.message || err) };
  }
}

/**
 * The fleet database password, for an instance whose manager env store has
 * none. A worker is never told the URL by the manager: the master delivers it
 * on register and the bot persists it in its OWN env file (declared as
 * companionDb.appEnvFile, ruling F1: the file read serves exactly the flows
 * where the app is stopped and no hook can answer), so that file is the only
 * place this machine's copy of the fleet credentials exists. An unparseable
 * value refuses (returns null) rather than guessing.
 */
function fleetPasswordFromBotEnv(botId: string, db: CompanionDbSpec): string | null {
  if (!db.appEnvFile) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(getDataPath(botId), db.appEnvFile), 'utf-8');
  } catch {
    return null;
  }
  const keyLine = new RegExp(`^\\s*${db.env.url}\\s*=\\s*(.*)$`);
  for (const line of raw.split('\n')) {
    const match = keyLine.exec(line);
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
  if (seedRunning(instance.id)) return { success: false, error: 'Provisioning is running; wait for it to finish' };
  const busyOp = containerManager.isBotBusy(instance.id);
  if (busyOp) return { success: false, error: `Operation '${busyOp}' is running on this instance; wait for it to finish` };

  // The pre-field gate first, with the real remedy: the status probe cannot
  // even run for such a record, and "start the instance" would be a lie.
  if (!rec.user || !rec.db) {
    return { success: false, error: 'This standby record predates identity stamping; retire and re-provision the standby before adopting' };
  }
  const status = await getFleetReplicaStatus(instance);
  if (!status.live?.running) {
    return { success: false, error: 'The standby container is not running, so it cannot be adopted; start the instance first' };
  }
  // Adopting a copy that still follows somebody would file a standby as a
  // primary and invite a second Enable to fork the pair.
  if (status.live.inRecovery !== false) {
    return { success: false, error: 'This copy is still following a primary, so it is not this machine\'s database yet. Promote this node first (its own web UI), then adopt' };
  }

  const db = findAppCapabilities(instance.sourceUrl)?.companionDb;
  if (!db) return { success: false, error: 'This app declares no managed database companion' };

  // BEFORE the record flip: a corrupt store would make the env write below
  // throw after the standby record is already consumed, leaving a half-done
  // adopt no lane can finish. Refusing here keeps the adopt retryable.
  if (envManager.getEnvVarsWithStatus(instance.id).corrupt) {
    return { success: false, error: 'The env store for this instance cannot be read (preserved as storage.json.corrupt); restore it before adopting' };
  }

  // A worker's manager env store carries no database URL, so the managed-lane
  // checks (and the password enableFleetReplication needs) have nothing to read
  // until this instance is filed like any other database host.
  const password = (() => {
    const current = (envManager.getEnvVars(instance.id)[db.env.url] || '').trim();
    if (current !== '') {
      try { return decodeURIComponent(new URL(current).password) || null; } catch { return null; }
    }
    return fleetPasswordFromBotEnv(instance.id, db);
  })();
  if (!password) {
    return { success: false, error: 'Could not recover the fleet database credentials from this instance (neither the manager env nor the app\'s own env file carries a usable database URL), so the database cannot be adopted' };
  }

  const adopted = containerManager.adoptFleetDbReplicaAsPrimary(instance.id);
  if (!adopted.success) return adopted;
  const live = containerManager.getBot(instance.id);
  if (!live) return { success: false, error: 'Bot not found after adopting the record' };

  // The container-name form first, deliberately: it is what marks the sidecar
  // MANAGED, so a rebuild landing between here and the enable below still keeps
  // the database in the compose. The enable keeps it and adds the public form
  // beside it (F1: same-host consumers cannot dial the public form).
  // Identity from the STAMP (rec.user/rec.db): adoption files an EXISTING
  // byte-copied cluster, whose role and database are whatever provisioning
  // stamped, not whatever the mutable per-source record says today.
  envManager.setEnvVars(instance.id, {
    ...(db.env.mode ? { [db.env.mode.key]: db.env.mode.value } : {}),
    [db.env.url]: `postgresql://${rec.user}:${encodeURIComponent(password)}@${rec.containerName}:5432/${rec.db}?sslmode=no-verify`,
  });

  const enabled = await enableFleetReplication(live, rec.publicHost, rec.hostPort);
  if (!enabled.success) {
    // Leave the adopted record in place: the database IS this machine's now,
    // and the operator can retry Enable from the replication section. Rolling
    // the record back would hide a live primary behind a standby surface again.
    return { success: false, error: `The database was adopted, but enabling replication on it failed (retry from the Replication section): ${enabled.error}` };
  }
  // enableFleetReplication repoints the database URL; a repointed key (e.g. a
  // split control store's URL) only exists when set, and then it moves too.
  // The env store alone: container env assembly derives sensitive values from
  // it at read time (the two-store strip).
  const stored = envManager.getEnvVars(instance.id);
  const repointUrl = (stored[db.env.url] || '').trim();
  const repoints: Record<string, string> = {};
  for (const key of db.repointedEnv ?? []) {
    if ((stored[key] || '').trim() !== '') repoints[key] = repointUrl;
  }
  if (Object.keys(repoints).length) envManager.setEnvVars(instance.id, repoints);
  return { success: true, restartRequired: true };
}

/**
 * Cancel the seed a runner owns (preparing or seeding: the seed container is
 * removed by name, which ends pg_basebackup and releases the op lock, and the
 * runner clears the record at its next boundary check), or dismiss a parked
 * one. Past the copy (configuring, starting) the standby is seconds from
 * serving, so the answer is "remove it afterwards", never a half-built one.
 */
export async function cancelReplicaSeed(instance: InstanceConfig): Promise<{ success: boolean; error?: string; dismissed?: boolean }> {
  const seed = seedRecord(instance.id);
  if (!seed) return { success: false, error: 'No seed is running on this instance' };
  const sweep = async (): Promise<string | null> => {
    let refused: string | null = null;
    for (const name of seedHelperNames(instance)) {
      const result = await dockerRmForce(name);
      if (!rmSettled(result)) refused = result.stderr.trim().split('\n').pop() || 'docker rm failed';
    }
    return refused;
  };
  if (seed.parked) {
    // Best effort, unlike the live branch below: a seed container that outlived
    // its runner can only be writing into a volume the wipe already emptied and
    // no service is on, so a wedged daemon must not block clearing the record.
    await sweep();
    containerManager.updateInstanceFleetDbReplicaSeed(instance.id, null);
    return { success: true, dismissed: true };
  }
  if (seed.phase === 'configuring' || seed.phase === 'starting') {
    return { success: false, error: 'Too late to cancel: the copy is complete and the standby is starting; remove the replica afterwards instead' };
  }
  saveSeed(instance.id, { cancelRequested: true });
  const refused = await sweep();
  // The runner may create the seed container between its boundary check and
  // the spawn; sweep once more for that window, but only while THIS run is
  // still the one on the instance: a re-seed started meanwhile owns the name.
  const cancelledRun = seed.startedAt;
  setTimeout(() => {
    const current = seedRecord(instance.id);
    if (!current || current.startedAt === cancelledRun) void sweep();
  }, 15_000).unref();
  if (refused) return { success: false, error: `Cancel is recorded and the run stops at its next step, but the seed container could not be removed: ${refused}` };
  return { success: true };
}

/**
 * Boot: a seed the previous manager process owned has no runner any more and
 * its pg_basebackup cannot be re-attached, so it is parked (kept for display,
 * Retry or Dismiss) and its helper containers are removed by name; a seed
 * nobody will finish only holds the volume and the primary's walsender.
 */
export async function parkInterruptedReplicaSeeds(): Promise<void> {
  for (const instance of containerManager.getAllBots()) {
    const seed = instance.fleetDbReplicaSeed;
    if (!seed || seed.parked) continue;
    console.log(`[FleetReplica] ${instance.displayName} was seeding (${seed.phase}) when the manager stopped - parking it`);
    for (const name of seedHelperNames(instance)) {
      const result = await dockerRmForce(name);
      // Best effort by design: the record must be parked even with the daemon
      // wedged, and every later path re-runs this removal by name.
      if (!rmSettled(result)) console.warn(`[FleetReplica] Could not remove ${name}: ${result.stderr.trim().split('\n').pop()}`);
    }
    const message = `the manager restarted during the seed (phase ${seed.phase})`;
    saveSeed(instance.id, { parked: true, lastError: message });
    if (seed.purpose === 'reseed-standby') ledgerFailure(instance.id, message);
  }
}

/**
 * Re-seed an existing standby whose slot the primary reports lost (20.14). The
 * orchestrator's entry: it keys on the manager's OWN standby record and never
 * passes through provisionFleetReplica's intake guards. The fact that fired it
 * is the TRIGGER; everything here is the manager's PERMIT: an unpromoted copy,
 * no other operation, and a copy block the bot itself holds (relayed by the
 * master to designated backups) that names the primary this standby follows.
 * Every refusal after the attempt is counted is written to the ledger, so
 * "it stopped and asks" shows its reason. A copy the probe reports out of
 * recovery is refused whoever asks; the copy must also be up, unless the
 * manager itself already cleared it, when there is nothing left to protect.
 */
export async function reseedStandby(instance: InstanceConfig, trigger: 'automatic' | 'operator'): Promise<{ success: boolean; error?: string; started?: boolean }> {
  const rec = instance.fleetDbReplica;
  if (!rec) return { success: false, error: 'This instance has no standby to re-seed' };
  if (seedRunning(instance.id)) return { success: false, error: 'A seed is already running on this instance' };
  const busyOp = containerManager.isBotBusy(instance.id);
  if (busyOp) return { success: false, error: `Operation '${busyOp}' is running on this instance; wait for it to finish` };
  if (!rec.user || !rec.db) return { success: false, error: 'This standby record predates identity stamping; retire and re-provision the standby' };
  const capability = capabilityRefusal(instance);
  if (capability) return { success: false, error: capability };
  if (trigger === 'operator') patchLedger(instance.id, () => undefined);
  ledgerAttempt(instance.id, trigger);
  const refuse = (error: string): { success: false; error: string } => {
    ledgerFailure(instance.id, error);
    return { success: false, error };
  };

  const status = await getFleetReplicaStatus(instance);
  // Never re-seeded over, whoever asks and whatever a stopped run left behind:
  // a promoted copy is the database its fleet now serves.
  if (status.live?.running && status.live.inRecovery !== true) {
    return refuse('This copy has been promoted and no longer follows a primary; adopt it or remove it instead of re-seeding');
  }
  // The copy must be up to be proven unpromoted, unless the manager itself
  // already cleared it: there is then nothing left that a promotion could have
  // turned into a primary, and refusing would strand the standby for good.
  if (rec.copyCleared !== true && !status.live?.running) {
    // Both remedies, because a re-seed that stopped before it cleared anything
    // took the standby service out of the compose, where a start cannot bring
    // it back, and the record that would tell them apart is deleted by a
    // cancel filed in that same window.
    return refuse('The standby container is not running, or could not be probed, so it cannot be verified as an unpromoted copy; start the instance if it is stopped, and rebuild it if a stopped re-seed took the standby service out of its compose');
  }
  if (!hasAppHooks(instance)) return refuse('This app declares no lifecycle hooks, so the manager cannot obtain the copy block; remove the replica and provision it again by hand');
  const facts = await getAppFacts(instance, FACTS_TIMEOUT_MS);
  if (!facts.success) return refuse(`Could not read the copy block from the app: ${facts.error}`);
  const block = facts.facts?.copyBlock;
  if (!block?.dsn || !block.cert) {
    return refuse('The bot holds no copy block for the primary (only a designated backup receives one); remove the replica and provision it again from the block on the primary machine');
  }
  const validated = validateIntake(block.dsn, block.cert, rec.publicHost, rec.hostPort);
  if (!validated.ok) return refuse(`The copy block the bot holds is unusable: ${validated.error}`);
  const { dsn } = validated.intake;
  if (dsn.host !== rec.primaryHost || dsn.port !== rec.primaryPort) {
    return refuse(`The copy block names ${dsn.host}:${dsn.port} but this standby follows ${rec.primaryHost}:${rec.primaryPort}; remove the replica and provision it from the new primary instead`);
  }
  const started = startProvisioning(instance, rec, validated.intake, 'reseed-standby', async () => {
    // The permits were read before the lock: a Remove replica that landed
    // meanwhile must not be undone by this run writing its record back.
    const fresh = containerManager.getBot(instance.id)?.fleetDbReplica;
    if (!fresh || fresh.containerName !== rec.containerName || fresh.volume !== rec.volume) {
      throw new SeedSuperseded('the standby record changed while the re-seed was starting');
    }
    const removed = await containerManager.removeFleetDbReplicaService(instance.id, rec.containerName);
    if (!removed.success) throw new Error(`could not stop the stale standby: ${removed.error}`);
    // That removal tolerates a failed rm; the wipe below runs inside the same
    // volume, so the standby postgres must be PROVEN gone, unknown included.
    if (await containerRunning(rec.containerName) !== false) {
      throw new Error('the standby database container is still present after the stop, so its copy cannot be cleared safely');
    }
  });
  if (!started.success) return refuse(started.error || 'the seed could not be started');
  return { success: true, started: true };
}
