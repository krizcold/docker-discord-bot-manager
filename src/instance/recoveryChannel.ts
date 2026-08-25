/**
 * Recovery-channel lifecycle (PLAN_REPLICATION.md Section 18, RC-2).
 *
 * Arms one side of the cross-host recovery channel by spawning a relay helper
 * container (the manager's own image running dist/recovery/relay.js) and
 * persisting a RecoveryChannelRecord the manager reconciles against on boot.
 * The helper, not the manager, holds the tunnel: manager restarts (self-update
 * is routine) must never kill a multi-hour transfer.
 *
 * RECEIVER (reachable machine): TLS listener on a published host port; hands
 * back an arm block {host, port, cert, token} the operator carries to the
 * other machine, exactly like the replica copy block.
 * SOURCE (NAT'd machine): dialer pinned to that block. Its lane targets are
 * fixed at arm time to this machine's own containers; the peer can never
 * name an address.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import * as containerManager from '../docker/containerManager';
import { generateCertPair } from './fleetReplication';
import { getDeploymentMode } from '../casaos/detector';
import { sharedNetworkName } from '../templates/pcsProcessing';
import { ensureRsyncDaemon, RECOVERY_CONTROL_PORT } from './recoveryControl';
import { InstanceConfig, RecoveryChannelRecord } from '../types';

const DEFAULT_TUNNEL_PORT = 15433;
const TUNNEL_CONTAINER_PORT = 9450;
const LANE_POSTGRES_PORT = 5432;
const LANE_RSYNC_PORT = 873;
const DOCKER_TIMEOUT_MS = 30_000;

function relayContainerName(instance: InstanceConfig): string {
  return `${instance.sanitizedName}-recovery-relay`;
}

function rsyncContainerName(instance: InstanceConfig): string {
  return `${instance.sanitizedName}-recovery-rsyncd`;
}

function docker(args: string[], stdin?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = execFile('docker', args, { timeout: DOCKER_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err || '') }));
    if (stdin !== undefined && child.stdin) { child.stdin.write(stdin); child.stdin.end(); }
  });
}

/** The image this manager runs, resolved from its own container: the helper reuses it so the relay code always matches the deployed manager. */
async function selfImage(): Promise<{ ok: boolean; image?: string; error?: string }> {
  const override = (process.env.RECOVERY_RELAY_IMAGE || '').trim();
  if (override) return { ok: true, image: override };
  const inspect = await docker(['inspect', '--format', '{{.Config.Image}}', os.hostname()]);
  if (!inspect.ok || !inspect.stdout.trim()) {
    return { ok: false, error: 'Could not resolve the manager image from its own container (set RECOVERY_RELAY_IMAGE when running the manager outside docker)' };
  }
  return { ok: true, image: inspect.stdout.trim() };
}

/** The manager's own container name: the dialer's control lane targets it over the shared network, so the receiver can drive the source-side sequencing (RC-3). */
async function selfContainerName(): Promise<string | null> {
  const inspect = await docker(['inspect', '--format', '{{.Name}}', os.hostname()]);
  const name = inspect.ok ? inspect.stdout.trim().replace(/^\//, '') : '';
  return name || null;
}

/**
 * The network the helper joins so sidecar and helper dial each other by name.
 * Prefers the persistent shared network (the sidecar is attached to it):
 * joining the compose project network instead would make compose down fail
 * with an external container still attached.
 */
async function sidecarNetwork(containerName: string): Promise<{ ok: boolean; network?: string; error?: string }> {
  const inspect = await docker(['inspect', '--format', '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}\n{{end}}', containerName]);
  const networks = inspect.ok ? inspect.stdout.split('\n').map(s => s.trim()).filter(Boolean) : [];
  if (networks.length === 0) return { ok: false, error: `Could not read the database container's network (${containerName}); install/build the instance first` };
  const shared = sharedNetworkName(await getDeploymentMode());
  return { ok: true, network: networks.includes(shared) ? shared : networks[0] };
}

/** Best-effort database identity for the handshake + FRESH/OUTDATED prompts; {} when the sidecar is down. */
async function databaseIdentity(instance: InstanceConfig): Promise<Record<string, unknown>> {
  const fleetDb = instance.fleetDb;
  if (!fleetDb) return {};
  const probe = await docker(['exec', fleetDb.containerName, 'psql', '-U', fleetDb.user, '-d', fleetDb.db, '-tA', '-c',
    "SELECT (SELECT system_identifier FROM pg_control_system()), (SELECT timeline_id FROM pg_control_checkpoint()), (SELECT checkpoint_lsn FROM pg_control_checkpoint());"]);
  if (!probe.ok) return {};
  const [systemId, timeline, checkpointLsn] = probe.stdout.trim().split('|');
  return systemId ? { systemId, timeline: Number(timeline), checkpointLsn } : {};
}

async function spawnRelay(instance: InstanceConfig, record: RecoveryChannelRecord): Promise<{ ok: boolean; error?: string }> {
  const fleetDb = instance.fleetDb;
  if (!fleetDb) return { ok: false, error: 'instance no longer has a managed fleet database; disarm the recovery channel' };
  const image = await selfImage();
  if (!image.ok) return { ok: false, error: image.error };
  const network = await sidecarNetwork(fleetDb.containerName);
  if (!network.ok) return { ok: false, error: network.error };
  const identity = JSON.stringify(await databaseIdentity(instance));

  const args = ['run', '-d', '--name', record.containerName, '--restart', 'unless-stopped',
    '--network', network.network!,
    '-e', `RELAY_TOKEN=${record.token}`,
    '-e', `RELAY_SELF_IDENTITY=${identity}`];
  if (record.mode === 'receiver') {
    args.push(
      '-p', `${record.tunnelPort}:${TUNNEL_CONTAINER_PORT}`,
      '-e', 'RELAY_MODE=listen',
      '-e', 'RELAY_SELF_ROLE=receiver',
      '-e', `RELAY_TUNNEL_PORT=${TUNNEL_CONTAINER_PORT}`,
      '-e', `RELAY_TLS_KEY=${record.tlsKey}`,
      '-e', `RELAY_TLS_CERT=${record.tlsCert}`,
      '-e', `RELAY_LANES=postgres:${LANE_POSTGRES_PORT},rsync:${LANE_RSYNC_PORT},control:${RECOVERY_CONTROL_PORT}`);
  } else {
    const managerName = await selfContainerName();
    if (!managerName) return { ok: false, error: 'Could not resolve the manager container name for the control lane' };
    args.push(
      '-e', 'RELAY_MODE=dial',
      '-e', 'RELAY_SELF_ROLE=source',
      '-e', `RELAY_ENDPOINT=${record.endpointHost}:${record.endpointPort}`,
      '-e', `RELAY_TLS_SERVERNAME=${record.endpointHost}`,
      '-e', `RELAY_PIN_CERT=${record.pinCert}`,
      '-e', `RELAY_LANES=postgres:${fleetDb.containerName}:5432,rsync:${rsyncContainerName(instance)}:${LANE_RSYNC_PORT},control:${managerName}:${RECOVERY_CONTROL_PORT}`);
  }
  args.push(image.image!, 'node', '/app/dist/recovery/relay.js');

  await docker(['rm', '-f', record.containerName]);
  const run = await docker(args);
  if (!run.ok) return { ok: false, error: `could not start the relay container: ${run.stderr.trim().split('\n').pop()}` };
  if (record.mode === 'source') {
    // The seed daemon belongs to the armed state: arm = fully ready to serve
    // the rescue, disarm/delete already remove it by name.
    const daemon = await ensureRsyncDaemon(instance, image.image!, network.network!);
    if (!daemon.ok) {
      await docker(['rm', '-f', record.containerName]);
      await docker(['rm', '-f', rsyncContainerName(instance)]);
      return { ok: false, error: daemon.error };
    }
  }
  return { ok: true };
}

// Synchronous re-entrancy gate: the arm paths await openssl + several docker
// calls, and two concurrent arms would both pass the record guard and fight
// over the container name.
const arming = new Set<string>();

/**
 * Arm the RECEIVER side: this machine's database will be overwritten by the
 * channel, so arming it is the manual consent Section 15 requires. Returns
 * the arm block the operator carries to the source machine (also re-served
 * by getRecoveryChannelStatus while armed).
 */
export async function armReceiver(
  instance: InstanceConfig,
  publicHost: string,
  tunnelPort?: number,
): Promise<{ success: boolean; error?: string; block?: { host: string; port: number; cert: string; token: string } }> {
  if (!instance.fleetDb) return { success: false, error: 'This instance has no managed fleet database to receive into' };
  if (instance.recoveryChannel) return { success: false, error: `A recovery channel is already armed (${instance.recoveryChannel.mode}); disarm it first` };
  if (arming.has(instance.id)) return { success: false, error: 'An arm request is already running for this instance' };
  arming.add(instance.id);
  try {
    return await armReceiverImpl(instance, publicHost, tunnelPort);
  } finally {
    arming.delete(instance.id);
  }
}

async function armReceiverImpl(
  instance: InstanceConfig,
  publicHost: string,
  tunnelPort?: number,
): Promise<{ success: boolean; error?: string; block?: { host: string; port: number; cert: string; token: string } }> {
  const host = publicHost.trim();
  if (!host || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host)) {
    return { success: false, error: 'Public host must be a bare hostname or IPv4 address' };
  }
  const port = tunnelPort ?? DEFAULT_TUNNEL_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { success: false, error: 'Invalid port' };
  const collision = containerManager.getAllBots().find(other =>
    other.fleetDb?.replication?.hostPort === port
    || other.fleetDbReplica?.hostPort === port
    || (other.id !== instance.id && other.recoveryChannel?.tunnelPort === port));
  if (collision) return { success: false, error: `Host port ${port} is already used by "${collision.displayName}" - pick another` };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-cert-'));
  let tlsKey: string;
  let tlsCert: string;
  try {
    const gen = await generateCertPair(dir, host);
    if (!gen.ok) return { success: false, error: `certificate generation failed: ${gen.error}` };
    tlsKey = fs.readFileSync(path.join(dir, 'server.key'), 'utf-8');
    tlsCert = fs.readFileSync(path.join(dir, 'server.crt'), 'utf-8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const record: RecoveryChannelRecord = {
    mode: 'receiver',
    containerName: relayContainerName(instance),
    token: crypto.randomBytes(24).toString('base64url'),
    createdAt: Date.now(),
    tunnelPort: port,
    publicHost: host,
    tlsKey,
    tlsCert,
  };
  // Record first, spawn second: a crash between the two leaves a record the
  // boot reconciler respawns, where the other order leaves an invisible
  // port-holding container no collision scan knows about.
  if (!containerManager.updateInstanceRecoveryChannel(instance.id, record)) {
    return { success: false, error: 'Instance disappeared while arming' };
  }
  const spawned = await spawnRelay(instance, record);
  if (!spawned.ok) {
    await docker(['rm', '-f', record.containerName]);
    containerManager.updateInstanceRecoveryChannel(instance.id, null);
    return { success: false, error: spawned.error };
  }
  return { success: true, block: { host, port, cert: tlsCert, token: record.token } };
}

/**
 * Arm the SOURCE side with the receiver's arm block: this machine's database
 * is the good copy and will be sent. The dialer redials forever until
 * disarmed, so arming survives link loss and reboots on either end.
 */
export async function armSource(
  instance: InstanceConfig,
  block: { host?: string; port?: number; cert?: string; token?: string },
): Promise<{ success: boolean; error?: string }> {
  if (!instance.fleetDb) return { success: false, error: 'This instance has no managed fleet database to send (a promoted standby must be adopted first)' };
  if (instance.recoveryChannel) return { success: false, error: `A recovery channel is already armed (${instance.recoveryChannel.mode}); disarm it first` };
  if (arming.has(instance.id)) return { success: false, error: 'An arm request is already running for this instance' };
  arming.add(instance.id);
  try {
    return await armSourceImpl(instance, block);
  } finally {
    arming.delete(instance.id);
  }
}

async function armSourceImpl(
  instance: InstanceConfig,
  block: { host?: string; port?: number; cert?: string; token?: string },
): Promise<{ success: boolean; error?: string }> {
  const host = String(block.host || '').trim();
  const port = Number(block.port);
  const cert = String(block.cert || '').trim();
  const token = String(block.token || '').trim();
  if (!host || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host)) return { success: false, error: 'Receiver host is missing or malformed' };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { success: false, error: 'Receiver port is missing or malformed' };
  if (!cert.includes('BEGIN CERTIFICATE')) return { success: false, error: 'Receiver certificate (PEM) is missing' };
  if (!token) return { success: false, error: 'Channel token is missing' };
  // Directional guard, manager side: sending TO your own published receiver
  // would loop the channel onto this machine.
  const samehost = containerManager.getAllBots().find(other =>
    other.recoveryChannel?.mode === 'receiver' && other.recoveryChannel.publicHost === host && other.recoveryChannel.tunnelPort === port);
  if (samehost) {
    return { success: false, error: `That receiver ("${samehost.displayName}") is on THIS machine; the channel sends a database between machines, not onto itself` };
  }

  const record: RecoveryChannelRecord = {
    mode: 'source',
    containerName: relayContainerName(instance),
    token,
    createdAt: Date.now(),
    endpointHost: host,
    endpointPort: port,
    pinCert: cert.endsWith('\n') ? cert : cert + '\n',
  };
  if (!containerManager.updateInstanceRecoveryChannel(instance.id, record)) {
    return { success: false, error: 'Instance disappeared while arming' };
  }
  const spawned = await spawnRelay(instance, record);
  if (!spawned.ok) {
    await docker(['rm', '-f', record.containerName]);
    containerManager.updateInstanceRecoveryChannel(instance.id, null);
    return { success: false, error: spawned.error };
  }
  return { success: true };
}

export interface RecoveryChannelStatus {
  armed: boolean;
  mode?: 'receiver' | 'source';
  publicHost?: string;
  tunnelPort?: number;
  endpoint?: string;
  /** Receiver only: the arm block re-served from the record, so losing the arm-time copy never forces a re-arm. Secrets by design - this endpoint sits behind manager auth like the replica copy block. */
  block?: { host: string; port: number; cert: string; token: string };
  containerRunning?: boolean;
  live?: {
    tunnelUp: boolean;
    peerIdentity: Record<string, unknown> | null;
    streams: number;
    bytesIn: number;
    bytesOut: number;
    lastError: string | null;
    connectedAt: number | null;
  } | null;
}

export async function getRecoveryChannelStatus(instance: InstanceConfig): Promise<RecoveryChannelStatus> {
  const record = instance.recoveryChannel;
  if (!record) return { armed: false };
  const status: RecoveryChannelStatus = {
    armed: true,
    mode: record.mode,
    publicHost: record.publicHost,
    tunnelPort: record.tunnelPort,
    endpoint: record.mode === 'source' ? `${record.endpointHost}:${record.endpointPort}` : undefined,
    block: record.mode === 'receiver' && record.publicHost && record.tunnelPort && record.tlsCert
      ? { host: record.publicHost, port: record.tunnelPort, cert: record.tlsCert, token: record.token }
      : undefined,
  };
  const state = await docker(['inspect', '--format', '{{.State.Running}}', record.containerName]);
  status.containerRunning = state.ok && state.stdout.trim() === 'true';
  if (status.containerRunning) {
    const raw = await docker(['exec', record.containerName, 'cat', '/tmp/relay-status.json']);
    if (raw.ok) {
      try {
        const parsed = JSON.parse(raw.stdout);
        status.live = {
          tunnelUp: parsed.tunnelUp === true,
          peerIdentity: parsed.peerIdentity && typeof parsed.peerIdentity === 'object' ? parsed.peerIdentity : null,
          streams: Number(parsed.streams) || 0,
          bytesIn: Number(parsed.bytesIn) || 0,
          bytesOut: Number(parsed.bytesOut) || 0,
          lastError: parsed.lastError === null || parsed.lastError === undefined ? null : String(parsed.lastError),
          connectedAt: parsed.connectedAt === null || parsed.connectedAt === undefined ? null : Number(parsed.connectedAt),
        };
      } catch { status.live = null; }
    } else {
      status.live = null;
    }
  }
  return status;
}

/** Disarm THIS side only: removes the helper (and the seed daemon if RC-3 left one) and clears the record. The other machine disarms itself. */
export async function disarmRecoveryChannel(instance: InstanceConfig): Promise<{ success: boolean; error?: string }> {
  const record = instance.recoveryChannel;
  if (!record) return { success: false, error: 'No recovery channel is armed on this instance' };
  if (instance.recoveryRescue) return { success: false, error: 'A rescue is using this channel; cancel it first' };
  // Same gate as arming: a reconciler tick mid-flight would otherwise respawn
  // the helper right after the rm, leaving a live tunnel with no record.
  if (arming.has(instance.id)) return { success: false, error: 'An arm request is running for this instance; retry in a moment' };
  arming.add(instance.id);
  try {
    // The record only clears once the containers are PROVEN gone: disarm is
    // consent revocation, and clearing over a failed rm would leave a live
    // tunnel no record points at.
    for (const name of [record.containerName, rsyncContainerName(instance)]) {
      const rm = await docker(['rm', '-f', name]);
      if (!rm.ok && !/no such container/i.test(rm.stderr)) {
        return { success: false, error: `could not remove ${name}: ${rm.stderr.trim().split('\n').pop()}` };
      }
    }
    // Source side: the rescue's reserved slot must not keep retaining WAL
    // after consent is revoked. The walsender may outlive the relay rm by a
    // moment, so terminate it first and retry the drop once - nothing ever
    // drops this slot again after the record clears below.
    if (record.mode === 'source' && instance.fleetDb) {
      const fleetDb = instance.fleetDb;
      for (let attempt = 0; attempt < 2; attempt++) {
        await docker(['exec', fleetDb.containerName, 'psql', '-U', fleetDb.user, '-d', fleetDb.db, '-tA', '-c',
          "SELECT pg_terminate_backend(active_pid) FROM pg_replication_slots WHERE slot_name = 'recovery_channel' AND active_pid IS NOT NULL"]);
        const drop = await docker(['exec', fleetDb.containerName, 'psql', '-U', fleetDb.user, '-d', fleetDb.db, '-tA', '-c',
          "SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = 'recovery_channel'"]);
        if (drop.ok) break;
        await new Promise(resolve => setTimeout(resolve, 2_000));
      }
    }
    containerManager.updateInstanceRecoveryChannel(instance.id, null);
    return { success: true };
  } finally {
    arming.delete(instance.id);
  }
}

/**
 * Reconciliation: the record is the source of truth. A missing helper is
 * respawned, a stopped one restarted - an armed channel outliving manager
 * restarts is the Section 15 persistence requirement. Runs periodically, not
 * just at boot: a respawn that fails once (docker daemon still waking) must
 * retry rather than leave an armed channel down forever.
 */
export async function reconcileRecoveryChannels(): Promise<void> {
  for (const snapshot of containerManager.getAllBots()) {
    if (!snapshot.recoveryChannel) continue;
    if (arming.has(snapshot.id)) continue;
    const state = await docker(['inspect', '--format', '{{.State.Running}}', snapshot.recoveryChannel.containerName]);
    if (state.ok && state.stdout.trim() === 'true') continue;
    if (state.ok) {
      const started = await docker(['start', snapshot.recoveryChannel.containerName]);
      if (started.ok) { console.log(`[RecoveryChannel] Restarted relay ${snapshot.recoveryChannel.containerName}`); continue; }
    }
    // Respawn under the same gate the arm/disarm paths hold, against a FRESH
    // read: the awaits above are long enough for a disarm or an arm rollback
    // to have cleared the record, and spawning from the stale snapshot would
    // resurrect a channel the operator just revoked.
    if (arming.has(snapshot.id)) continue;
    arming.add(snapshot.id);
    try {
      const fresh = containerManager.getBot(snapshot.id);
      const record = fresh?.recoveryChannel;
      if (!fresh || !record) continue;
      const spawned = await spawnRelay(fresh, record);
      console.log(spawned.ok
        ? `[RecoveryChannel] Respawned relay ${record.containerName}`
        : `[RecoveryChannel] Could not respawn relay ${record.containerName}: ${spawned.error}`);
    } finally {
      arming.delete(snapshot.id);
    }
  }
}

const RECONCILE_INTERVAL_MS = 60_000;
let reconcileTimer: ReturnType<typeof setInterval> | null = null;
let reconciling = false;

export function startRecoveryChannelReconciler(): void {
  if (reconcileTimer) return;
  const tick = async (): Promise<void> => {
    if (reconciling) return;
    reconciling = true;
    try { await reconcileRecoveryChannels(); }
    catch (err) { console.warn(`[RecoveryChannel] Reconcile tick failed: ${err instanceof Error ? err.message : String(err)}`); }
    finally { reconciling = false; }
  };
  void tick();
  reconcileTimer = setInterval(() => void tick(), RECONCILE_INTERVAL_MS);
  reconcileTimer.unref();
}

export function stopRecoveryChannelReconciler(): void {
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = null;
}
