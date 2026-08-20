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
 * The stored DATA_BACKEND_URL is rewritten to the host-reachable canonical form
 * so the same URL works for cross-host workers and after a failover. sslmode=
 * no-verify is the node-postgres spelling for "encrypt, pinned trust comes
 * later" (pg-connection-string treats bare `require` as verify-against-CAs,
 * which a self-signed cert fails); the replication DSN for libpq consumers uses
 * verify-full with the cert delivered alongside it.
 */

import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as containerManager from '../docker/containerManager';
import * as envManager from '../env/manager';
import * as crypto from 'crypto';
import { InstanceConfig, FleetDbReplication } from '../types';

const REPLICATION_ROLE = 'replicator';
const REPLICATION_SLOT = 'fleet_standby';
const DEFAULT_HOST_PORT = 15432;
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
  const url = (envManager.getEnvVars(instance.id)['DATA_BACKEND_URL'] || '').trim();
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
 * replication password and slot survive re-enables; only the operator-provided
 * host/port move. The published port and the rewritten URL apply on the next
 * instance restart.
 */
export async function enableFleetReplication(
  instance: InstanceConfig,
  publicHost: string,
  hostPort?: number,
): Promise<{ success: boolean; error?: string; restartRequired?: boolean; certRotated?: boolean }> {
  const fleetDb = instance.fleetDb;
  if (!fleetDb) return { success: false, error: 'This instance has no managed fleet database' };
  const host = publicHost.trim();
  if (!host || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host)) {
    return { success: false, error: 'Public host must be a bare hostname or IPv4 address' };
  }
  const port = hostPort ?? fleetDb.replication?.hostPort ?? DEFAULT_HOST_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { success: false, error: 'Invalid port' };
  const collision = containerManager.getAllBots().find(other =>
    other.id !== instance.id && other.fleetDb?.replication?.hostPort === port);
  if (collision) {
    return { success: false, error: `Host port ${port} is already used by "${collision.displayName}" - pick another` };
  }
  if (!await isContainerRunning(fleetDb.containerName)) {
    return { success: false, error: 'Database container is not running (start the instance first)' };
  }
  const dbPassword = storedDbPassword(instance);
  if (!dbPassword) return { success: false, error: 'Could not recover the database password from the stored URL' };

  const previousCertHost = fleetDb.replication?.certHost;
  const certErr = await ensureServerCert(fleetDb.containerName, host, previousCertHost);
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
      IF NOT EXISTS (SELECT FROM pg_replication_slots WHERE slot_name = '${REPLICATION_SLOT}') THEN
        PERFORM pg_create_physical_replication_slot('${REPLICATION_SLOT}');
      END IF;
    END $$;`);
  if (!setup.ok) return { success: false, error: `database setup failed: ${setup.stderr.trim()}` };
  // Separate call: ALTER SYSTEM refuses to run inside the implicit transaction
  // a multi-statement psql -c wraps around its input.
  const ssl = await psql(fleetDb.containerName, fleetDb.user, fleetDb.db, 'ALTER SYSTEM SET ssl = on;');
  if (!ssl.ok) return { success: false, error: `enabling ssl failed: ${ssl.stderr.trim()}` };

  const hba = await dbExec(fleetDb.containerName, ['sh', '-c', `cat > ${PGDATA}/pg_hba.conf && chown postgres:postgres ${PGDATA}/pg_hba.conf`], PG_HBA_CONTENT);
  if (!hba.ok) return { success: false, error: `pg_hba rewrite failed: ${hba.stderr.trim()}` };
  const reload = await psql(fleetDb.containerName, fleetDb.user, fleetDb.db, 'SELECT pg_reload_conf();');
  if (!reload.ok) return { success: false, error: `config reload failed: ${reload.stderr.trim()}` };

  const replication: FleetDbReplication = {
    role: REPLICATION_ROLE,
    password,
    slot: REPLICATION_SLOT,
    hostPort: port,
    publicHost: host,
    certHost: host,
  };
  const newUrl = canonicalFleetUrl(instance, replication, dbPassword);
  envManager.setEnvVars(instance.id, { DATA_BACKEND_URL: newUrl });
  containerManager.updateInstanceFleetDbReplication(instance.id, replication, newUrl);
  return { success: true, restartRequired: true, certRotated };
}

/**
 * Disable: drop the slot FIRST (a leaked slot retains WAL until the disk
 * fills, so a disable that cannot drop it refuses and keeps the record), then
 * drop the record and revert the URL to the private sidecar form. A streaming
 * standby's walsender is terminated so the drop cannot be blocked by an active
 * slot. Cert, ssl=on and the role stay in PGDATA (harmless without the
 * published port). Port unpublish applies on the next restart.
 */
export async function disableFleetReplication(
  instance: InstanceConfig,
): Promise<{ success: boolean; error?: string; restartRequired?: boolean }> {
  const fleetDb = instance.fleetDb;
  if (!fleetDb?.replication) return { success: false, error: 'Replication is not enabled' };
  const dbPassword = storedDbPassword(instance);
  if (!dbPassword) return { success: false, error: 'Could not recover the database password from the stored URL' };
  if (!await isContainerRunning(fleetDb.containerName)) {
    return { success: false, error: 'Database container is not running - start the instance first so the replication slot can be dropped (a leaked slot retains WAL forever)' };
  }

  const drop = await psql(fleetDb.containerName, fleetDb.user, fleetDb.db, `
    DO $$ DECLARE pid int; BEGIN
      SELECT active_pid INTO pid FROM pg_replication_slots WHERE slot_name = '${REPLICATION_SLOT}';
      IF pid IS NOT NULL THEN
        PERFORM pg_terminate_backend(pid);
        PERFORM pg_sleep(0.5);
      END IF;
      IF EXISTS (SELECT FROM pg_replication_slots WHERE slot_name = '${REPLICATION_SLOT}') THEN
        PERFORM pg_drop_replication_slot('${REPLICATION_SLOT}');
      END IF;
    END $$;`);
  if (!drop.ok) {
    return { success: false, error: `slot drop failed (nothing was disabled; retry after stopping the standby): ${drop.stderr.trim()}` };
  }

  const revertUrl = sidecarUrl(instance, dbPassword);
  envManager.setEnvVars(instance.id, { DATA_BACKEND_URL: revertUrl });
  containerManager.updateInstanceFleetDbReplication(instance.id, null, revertUrl);
  return { success: true, restartRequired: true };
}

export interface FleetReplicationStatus {
  enabled: boolean;
  publicHost?: string;
  hostPort?: number;
  slot?: string;
  live?: {
    sslOn: boolean;
    slotActive: boolean;
    standbys: Array<{ clientAddr: string; state: string; replayLagSeconds: number | null }>;
  };
  /** Can a container on the default bridge reach the published endpoint (the
   * same hairpin path the bot itself uses after the URL rewrite)? Catches
   * firewall/hairpin traps BEFORE the operator restarts into them. */
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

export async function getFleetReplicationStatus(instance: InstanceConfig): Promise<FleetReplicationStatus> {
  const repl = instance.fleetDb?.replication;
  if (!repl) return { enabled: false };
  const status: FleetReplicationStatus = {
    enabled: true,
    publicHost: repl.publicHost,
    hostPort: repl.hostPort,
    slot: repl.slot,
  };
  const fleetDb = instance.fleetDb!;
  if (!await isContainerRunning(fleetDb.containerName)) return status;

  const probe = await psql(fleetDb.containerName, fleetDb.user, fleetDb.db,
    `SELECT current_setting('ssl'),
            (SELECT active FROM pg_replication_slots WHERE slot_name = '${repl.slot}'),
            (SELECT json_agg(json_build_object(
               'clientAddr', client_addr::text,
               'state', state,
               'replayLagSeconds', EXTRACT(EPOCH FROM replay_lag)))
             FROM pg_stat_replication);`);
  if (probe.ok) {
    const [sslOn, slotActive, standbysJson] = probe.stdout.trim().split('|');
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
    status.live = { sslOn: sslOn === 'on', slotActive: slotActive === 't', standbys };
  }
  status.reachability = await cachedReachability(instance);
  return status;
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
  if (!await isContainerRunning(fleetDb.containerName)) {
    return { success: false, error: 'Database container is not running' };
  }
  const cert = await dbExec(fleetDb.containerName, ['cat', `${PGDATA}/server.crt`]);
  if (!cert.ok) return { success: false, error: 'Could not read the server certificate' };
  const dsn = `postgresql://${repl.role}:${encodeURIComponent(repl.password)}@${repl.publicHost}:${repl.hostPort}/${fleetDb.db}?sslmode=verify-full`;
  return { success: true, dsn, cert: cert.stdout };
}
