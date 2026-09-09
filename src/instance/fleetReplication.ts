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
 * form rides the record's public-URL key instead; the master delivers both and
 * each worker picks the one it can resolve. sslmode=no-verify is the
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

const REPLICATION_ROLE = 'replicator';
/** Every fleet standby's slot begins with this; the standby's manager appends its instance id (20.19 F1/F2). */
const FLEET_SLOT_PREFIX = 'fleet_standby';
const DEFAULT_HOST_PORT = 15432;
// Bounded slot retention (PLAN_REPLICATION.md RC-1): an absent standby must
// fill the bound, not the disk - in the rescue direction the source is a
// personal computer. Invalidation falls back to a fresh seed by design.
const DEFAULT_SLOT_WAL_KEEP_MB = 4096;
const PGDATA = '/var/lib/postgresql/data';
const EXEC_TIMEOUT_MS = 30_000;

// Non-TLS access is limited to docker's default address pools (172.16/12);
// 10/8 and 192.168/16 are real-LAN ranges and deliberately absent - traffic
// arriving through the published port keeps its LAN source address, so listing
// them would let off-host clients skip TLS. Everything else is hostssl with
// scram. First match wins.
const PG_HBA_CONTENT = `# Managed by discord-bot-manager (replication posture). Do not edit.
local   all             all                                     trust
host    all             all             127.0.0.1/32            trust
host    all             all             ::1/128                 trust
host    all             all             172.16.0.0/12           scram-sha-256
hostssl all             all             0.0.0.0/0               scram-sha-256
hostssl replication     all             0.0.0.0/0               scram-sha-256
`;

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
    if (stdin !== undefined) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

function psql(containerName: string, user: string, db: string, sql: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return dbExec(containerName, ['psql', '-U', user, '-d', db, '-v', 'ON_ERROR_STOP=1', '-Atc', sql]);
}

function isContainerRunning(containerName: string): Promise<boolean> {
  return new Promise(resolve => {
    execFile('docker', ['inspect', '-f', '{{.State.Running}}', containerName], (err, stdout) => {
      resolve(!err && String(stdout).trim() === 'true');
    });
  });
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

function canonicalFleetUrl(instance: InstanceConfig, repl: FleetDbReplication, dbPassword: string): string {
  const user = instance.fleetDb!.user;
  const db = instance.fleetDb!.db;
  return `postgresql://${user}:${encodeURIComponent(dbPassword)}@${repl.publicHost}:${repl.hostPort}/${db}?sslmode=no-verify`;
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
 */
async function ensureServerCert(containerName: string, publicHost: string, certHost: string | undefined): Promise<string | null> {
  if (certHost === publicHost) {
    const present = await dbExec(containerName, ['test', '-f', `${PGDATA}/server.crt`]);
    if (present.ok) return null;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-cert-'));
  try {
    const gen = await generateCertPair(dir, publicHost);
    if (!gen.ok) return `certificate generation failed: ${gen.error}`;
    for (const file of ['server.key', 'server.crt']) {
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');
      const put = await dbExec(containerName, ['sh', '-c',
        `cat > ${PGDATA}/${file} && chown postgres:postgres ${PGDATA}/${file} && chmod 600 ${PGDATA}/${file}`], content);
      if (!put.ok) return `certificate install failed (${file}): ${put.stderr.trim()}`;
    }
    return null;
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
export async function enableFleetReplication(
  instance: InstanceConfig,
  publicHost: string,
  hostPort?: number,
  slotWalKeepMb?: number,
  opts: { rotateCert?: boolean } = {},
): Promise<{ success: boolean; error?: string; restartRequired?: boolean; certRotated?: boolean }> {
  const fleetDb = instance.fleetDb;
  if (!fleetDb) return { success: false, error: 'This instance has no managed fleet database' };
  // Record check FIRST: everything past the preflight mutates the live
  // cluster (role, ssl, pg_hba), so a missing key name must refuse before
  // any of it or a failed enable leaves a live posture no record accounts for.
  const dbEnv = findAppCapabilities(instance.sourceUrl)?.companionDb?.env;
  if (!dbEnv?.publicUrl) {
    return { success: false, error: 'This app declares no public database URL key, so replication cannot publish the canonical form' };
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
    || other.recoveryChannel?.tunnelPort === port);
  if (collision) {
    return { success: false, error: `Host port ${port} is already used by "${collision.displayName}" - pick another` };
  }
  if (!await isContainerRunning(fleetDb.containerName)) {
    return { success: false, error: 'Database container is not running (start the instance first)' };
  }
  const dbPassword = storedDbPassword(instance);
  if (!dbPassword) return { success: false, error: envManager.storeBrokenDiagnosis(instance.id) || 'Could not recover the database password from the stored URL' };
  // An existing posture whose password reads empty is a key-loss scrub, not an
  // absent credential: minting a fresh one here would silently rotate the
  // fleet's replication credential and break every standby at its next
  // reconnect.
  if (fleetDb.replication && !fleetDb.replication.password) {
    return { success: false, error: 'The stored replication password no longer decrypts (the manager encryption key changed or was lost). Restore the key, or disable replication and re-enable it to mint a fresh credential (existing standbys must then be re-seeded).' };
  }

  const previousCertHost = fleetDb.replication?.certHost;
  // rotateCert: the caller knows PGDATA was replaced wholesale (the RC-4
  // rescue rsyncs the SOURCE's pair in), so the certHost shortcut would keep
  // a cert naming the other machine and the copy block could never verify.
  const certErr = await ensureServerCert(fleetDb.containerName, host, opts.rotateCert ? undefined : previousCertHost);
  if (certErr) return { success: false, error: certErr };
  const certRotated = previousCertHost !== undefined && previousCertHost !== host;

  const password = instance.fleetDb?.replication?.password || crypto.randomBytes(24).toString('base64url');
  const setup = await psql(fleetDb.containerName, fleetDb.user, fleetDb.db, `
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${REPLICATION_ROLE}') THEN
        CREATE ROLE ${REPLICATION_ROLE} WITH REPLICATION LOGIN PASSWORD '${password}';
      ELSE
        ALTER ROLE ${REPLICATION_ROLE} WITH REPLICATION LOGIN PASSWORD '${password}';
      END IF;
    END $$;`);
  if (!setup.ok) return { success: false, error: `database setup failed: ${setup.stderr.trim()}` };
  // Separate calls: ALTER SYSTEM refuses to run inside the implicit transaction
  // a multi-statement psql -c wraps around its input.
  const ssl = await psql(fleetDb.containerName, fleetDb.user, fleetDb.db, 'ALTER SYSTEM SET ssl = on;');
  if (!ssl.ok) return { success: false, error: `enabling ssl failed: ${ssl.stderr.trim()}` };
  // Restart-only setting (no re-initdb): makes pg_rewind possible on every
  // cluster that has ever run enable (reopened ruling R6).
  const hints = await psql(fleetDb.containerName, fleetDb.user, fleetDb.db, 'ALTER SYSTEM SET wal_log_hints = on;');
  if (!hints.ok) return { success: false, error: `enabling wal_log_hints failed: ${hints.stderr.trim()}` };
  const keep = await psql(fleetDb.containerName, fleetDb.user, fleetDb.db, `ALTER SYSTEM SET max_slot_wal_keep_size = '${keepMb}MB';`);
  if (!keep.ok) return { success: false, error: `setting the WAL retention bound failed: ${keep.stderr.trim()}` };

  const hba = await dbExec(fleetDb.containerName, ['sh', '-c', `cat > ${PGDATA}/pg_hba.conf && chown postgres:postgres ${PGDATA}/pg_hba.conf`], PG_HBA_CONTENT);
  if (!hba.ok) return { success: false, error: `pg_hba rewrite failed: ${hba.stderr.trim()}` };
  const reload = await psql(fleetDb.containerName, fleetDb.user, fleetDb.db, 'SELECT pg_reload_conf();');
  if (!reload.ok) return { success: false, error: `config reload failed: ${reload.stderr.trim()}` };

  const replication: FleetDbReplication = {
    role: REPLICATION_ROLE,
    password,
    hostPort: port,
    publicHost: host,
    certHost: host,
    slotWalKeepMb: keepMb,
  };
  // F1: the stored URL stays the container-name form (the public form cannot
  // hairpin from containers sharing a docker network with the sidecar, which
  // includes this instance's own bot). The public form rides a separate env
  // var; the master delivers both and each worker picks by resolvability.
  // TLS on the local form too (ssl=on just activated): the authored pg_hba
  // accepts non-TLS only from 172.16/12, and a docker daemon with custom
  // address pools allocates outside it; hostssl covers every subnet.
  const localUrl = `${sidecarUrl(instance, dbPassword)}?sslmode=no-verify`;
  const publicUrl = canonicalFleetUrl(instance, replication, dbPassword);
  // The env store alone: container env assembly derives sensitive values from
  // it at read time (the two-store strip), so no record mirror exists to sync.
  envManager.setEnvVars(instance.id, { [dbEnv.url]: localUrl, [dbEnv.publicUrl]: publicUrl });
  containerManager.updateInstanceFleetDbReplication(instance.id, replication);
  return { success: true, restartRequired: true, certRotated };
}

/**
 * Disable: refuse while any fleet standby still streams (naming its slots),
 * drop every inactive fleet slot FIRST (a leaked slot retains WAL until the
 * disk fills, so a disable that cannot drop them refuses and keeps the record),
 * revoke the replication login (the port may stay published until the next
 * restart, and a seed against a disabled primary must fail at the login), then
 * drop the record and revert the URL to the private sidecar form. Cert and
 * ssl=on stay in PGDATA. Port unpublish applies on the next restart.
 */
export async function disableFleetReplication(
  instance: InstanceConfig,
): Promise<{ success: boolean; error?: string; restartRequired?: boolean }> {
  const fleetDb = instance.fleetDb;
  if (!fleetDb?.replication) return { success: false, error: 'Replication is not enabled' };
  const dbPassword = storedDbPassword(instance);
  if (!dbPassword) return { success: false, error: envManager.storeBrokenDiagnosis(instance.id) || 'Could not recover the database password from the stored URL' };
  if (!await isContainerRunning(fleetDb.containerName)) {
    return { success: false, error: 'Database container is not running - start the instance first so the replication slot can be dropped (a leaked slot retains WAL forever)' };
  }

  const streaming = await psql(fleetDb.containerName, fleetDb.user, fleetDb.db,
    `SELECT COALESCE(string_agg(slot_name, ', ' ORDER BY slot_name), '') FROM pg_replication_slots WHERE starts_with(slot_name, '${FLEET_SLOT_PREFIX}') AND active;`);
  if (!streaming.ok) {
    return { success: false, error: `could not read the replication slots (nothing was disabled): ${streaming.stderr.trim()}` };
  }
  if (streaming.stdout.trim() !== '') {
    return { success: false, error: `Standbys are still streaming on slot(s) ${streaming.stdout.trim()}; stop or remove them first (nothing was disabled)` };
  }
  const drop = await psql(fleetDb.containerName, fleetDb.user, fleetDb.db, `
    DO $$ DECLARE s record; BEGIN
      FOR s IN SELECT slot_name FROM pg_replication_slots WHERE starts_with(slot_name, '${FLEET_SLOT_PREFIX}') AND NOT active LOOP
        PERFORM pg_drop_replication_slot(s.slot_name);
      END LOOP;
    END $$;`);
  if (!drop.ok) {
    return { success: false, error: `slot drop failed (nothing was disabled): ${drop.stderr.trim()}` };
  }
  const left = await psql(fleetDb.containerName, fleetDb.user, fleetDb.db,
    `SELECT COALESCE(string_agg(slot_name, ', ' ORDER BY slot_name), '') FROM pg_replication_slots WHERE starts_with(slot_name, '${FLEET_SLOT_PREFIX}');`);
  if (!left.ok) {
    return { success: false, error: `could not confirm the replication slots are gone (nothing else was changed): ${left.stderr.trim()}` };
  }
  if (left.stdout.trim() !== '') {
    return { success: false, error: `Slot(s) ${left.stdout.trim()} survived the drop (a standby reconnected while it ran); stop or remove the standbys, then disable again (nothing else was changed)` };
  }
  const revoke = await psql(fleetDb.containerName, fleetDb.user, fleetDb.db, `ALTER ROLE ${REPLICATION_ROLE} NOLOGIN;`);
  if (!revoke.ok) {
    return { success: false, error: `revoking the replication login failed (the slots are dropped; retry to finish disabling): ${revoke.stderr.trim()}` };
  }

  // ssl=on and the authored pg_hba survive the disable, so the local form
  // keeps TLS (see the enable-side note on custom address pools).
  const dbEnv = findAppCapabilities(instance.sourceUrl)?.companionDb?.env;
  if (!dbEnv) return { success: false, error: 'This app declares no managed database companion' };
  const revertUrl = `${sidecarUrl(instance, dbPassword)}?sslmode=no-verify`;
  envManager.setEnvVars(instance.id, { [dbEnv.url]: revertUrl });
  if (dbEnv.publicUrl) {
    envManager.deleteEnvVar(instance.id, dbEnv.publicUrl);
    containerManager.removeBotEnvVars(instance.id, [dbEnv.publicUrl]);
    containerManager.removeEnvKeyFromDeployedCompose(instance.id, dbEnv.publicUrl);
  }
  containerManager.updateInstanceFleetDbReplication(instance.id, null);
  return { success: true, restartRequired: true };
}

export interface FleetReplicationStatus {
  enabled: boolean;
  publicHost?: string;
  hostPort?: number;
  live?: {
    sslOn: boolean;
    standbys: Array<{ clientAddr: string; state: string; replayLagSeconds: number | null }>;
    /**
     * Every physical slot on this primary, joined to the link streaming on it
     * (active_pid to pg_stat_replication.pid); an invalidated one means its
     * standby must re-seed. fleet marks the standby slots this manager family
     * mints; the recovery channel's slot is not one.
     */
    slots: Array<{ slot: string; fleet: boolean; walStatus: string; active: boolean; retainedBytes: number | null; clientAddr: string | null; state: string | null; replayLagSeconds: number | null }>;
    /** Live max_slot_wal_keep_size as postgres reports it ('-1' = unbounded, pre-RC-1 clusters). */
    slotWalKeep: string;
  };
  /** Can a container on the default bridge reach the published endpoint (the
   * path a REMOTE worker's delivery hands out)? Catches firewall traps before
   * a cross-host standby is pointed at a dead port. */
  reachability?: { ok: boolean; error?: string; ageSeconds: number };
}

const PROBE_CACHE_MS = 60_000;
const PROBE_TIMEOUT_MS = 20_000;
const probeCache: Map<string, { ok: boolean; error?: string; at: number }> = new Map();

function probeEndpoint(instance: InstanceConfig): Promise<{ ok: boolean; error?: string }> {
  const repl = instance.fleetDb!.replication!;
  const dbPassword = storedDbPassword(instance);
  if (!dbPassword) return Promise.resolve({ ok: false, error: 'stored URL unreadable' });
  const url = `postgresql://${instance.fleetDb!.user}:${encodeURIComponent(dbPassword)}@${repl.publicHost}:${repl.hostPort}/${instance.fleetDb!.db}?sslmode=require&connect_timeout=8`;
  return new Promise(resolve => {
    execFile('docker', ['run', '--rm', 'postgres:16-alpine', 'psql', url, '-Atc', 'SELECT 1'],
      { timeout: PROBE_TIMEOUT_MS }, (err, stdout, stderr) => {
        if (!err && String(stdout).trim() === '1') resolve({ ok: true });
        else resolve({ ok: false, error: String(stderr || err || 'no response').trim().split('\n').pop() });
      });
  });
}

async function cachedReachability(instance: InstanceConfig): Promise<{ ok: boolean; error?: string; ageSeconds: number }> {
  const cached = probeCache.get(instance.id);
  if (cached && Date.now() - cached.at < PROBE_CACHE_MS) {
    return { ok: cached.ok, error: cached.error, ageSeconds: Math.round((Date.now() - cached.at) / 1000) };
  }
  const result = await probeEndpoint(instance);
  probeCache.set(instance.id, { ...result, at: Date.now() });
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
  const fleetDb = instance.fleetDb!;
  if (!await isContainerRunning(fleetDb.containerName)) return status;

  const probe = await psql(fleetDb.containerName, fleetDb.user, fleetDb.db,
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
        }));
      }
    } catch { /* no slots */ }
    status.live = { sslOn: sslOn === 'on', standbys, slots, slotWalKeep: (slotWalKeep || '').trim() };
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
  if (!await isContainerRunning(fleetDb.containerName)) return { success: false, error: 'Database container is not running' };
  const result = await psql(fleetDb.containerName, fleetDb.user, fleetDb.db, `
    DO $$ DECLARE s record; BEGIN
      SELECT active INTO s FROM pg_replication_slots WHERE slot_name = '${slot}';
      IF NOT FOUND THEN RAISE EXCEPTION 'no slot named ${slot}'; END IF;
      IF s.active THEN RAISE EXCEPTION 'a standby is streaming on ${slot}; stop or remove it first'; END IF;
      PERFORM pg_drop_replication_slot('${slot}');
    END $$;`);
  if (!result.ok) {
    const lines = result.stderr.trim().split('\n');
    return { success: false, error: (lines.find(l => l.startsWith('ERROR')) || lines.pop() || 'psql failed').replace(/^ERROR:\s*/, '') };
  }
  return { success: true };
}

/**
 * The copy block the OTHER machine's wizard consumes: a verify-full libpq DSN
 * for the replication role plus the pinned certificate. Secrets included by
 * design - the endpoint sits behind manager auth like the env editor.
 */
export async function getReplicaCopyBlock(
  instance: InstanceConfig,
): Promise<{ success: boolean; error?: string; dsn?: string; cert?: string }> {
  const fleetDb = instance.fleetDb;
  const repl = fleetDb?.replication;
  if (!fleetDb || !repl) return { success: false, error: 'Replication is not enabled' };
  // A key-loss-scrubbed password would mint a passwordless DSN that fails as
  // an auth error on the OTHER machine, misdirecting the operator away from
  // the key loss here.
  if (!repl.password) {
    return { success: false, error: 'The stored replication password no longer decrypts (the manager encryption key changed or was lost). Restore the key, or disable and re-enable replication to mint a fresh credential.' };
  }
  if (!await isContainerRunning(fleetDb.containerName)) {
    return { success: false, error: 'Database container is not running' };
  }
  const cert = await dbExec(fleetDb.containerName, ['cat', `${PGDATA}/server.crt`]);
  if (!cert.ok) return { success: false, error: 'Could not read the server certificate' };
  const dsn = `postgresql://${repl.role}:${encodeURIComponent(repl.password)}@${repl.publicHost}:${repl.hostPort}/${fleetDb.db}?sslmode=verify-full`;
  return { success: true, dsn, cert: cert.stdout };
}
