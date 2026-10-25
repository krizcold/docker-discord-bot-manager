/**
 * Receiver-side rescue orchestration (PLAN_REPLICATION.md Section 18, RC-3).
 *
 * Runs on the machine whose database is being REPLACED. Drives the whole
 * sequence through the armed channel: preflight (dump the stale copy) ->
 * bulk (resumable rsync of the live source PGDATA, no consistency needed) ->
 * consistent (short delta pass inside pg_backup_start/stop) -> standby
 * (backup_label + standby.signal + primary_conninfo through the tunnel's
 * postgres lane on the dedicated recovery_channel slot) -> streaming (monitor
 * until caught up).
 *
 * The RC-4 swap continues on the same record when the operator triggers it:
 * quiesce (the source bot stops; its database keeps serving the tunnel) ->
 * catchup (replay to the source's end-of-WAL) -> promote (pg_promote, the
 * timeline bumps) -> teardown (both channel helpers go, using the tunnel one
 * last time to tell the source side) -> flip (this machine files the copy as
 * its primary: credentials reconciled to the stored env, replication enabled,
 * the fleet started). Teardown runs BEFORE the flip deliberately: the control
 * call is the last thing that needs the tunnel, and enable's port-collision
 * scan must not see this instance's own armed channel.
 *
 * Every phase is persisted before it runs and idempotently re-enterable: the
 * boot resume re-enters the recorded phase, the bulk rsync is delta by
 * nature, the consistent pass just re-runs, and a died backup session
 * self-cleans on the source. Retryable failures loop with a fixed delay
 * until cancel; only structural ones (channel gone, database record gone)
 * park the rescue at its recorded phase for Continue to re-enter.
 */

import { execFile } from 'child_process';
import * as containerManager from '../docker/containerManager';
import * as envManager from '../env/manager';
import { findAppCapabilities } from '../config/appCapabilities';
import * as appLifecycle from './appLifecycle';
import { runFleetDump, claimFleetBackupBusy, releaseFleetBackupBusy, isFleetBackupBusy, raiseGuildTerms } from './fleetBackup';
import { enableFleetReplication } from './fleetReplication';
import { disarmRecoveryChannel } from './recoveryChannel';
import { readStoreId, readSystemId } from './recoveryControl';
import { hasAppHooks } from './appHookClient';
import { InstanceConfig, RecoveryRescueRecord, RescueIdentity } from '../types';
import { LOG_CAP_RUN_ARGS } from '../templates/logCaps';
import { QUIET_ROLE_SESSION_SQL, childFailureText, redactSecrets, scramSha256Verifier } from '../config/secretText';
import { feedStdin } from '../docker/childStdin';

const PGDATA = '/var/lib/postgresql/data';
const APP_HOOK_WAIT_MS = 90_000;
const RETRY_DELAY_MS = 30_000;
const MONITOR_INTERVAL_MS = 30_000;
const RSYNC_POLL_MS = 10_000;
const DOCKER_TIMEOUT_MS = 60_000;

function docker(args: string[], stdin?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = execFile('docker', args, { timeout: DOCKER_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: err ? childFailureText(stderr, err) : String(stderr || '') }));
    if (stdin !== undefined) feedStdin(child.stdin, stdin);
  });
}

function rsyncClientName(instance: InstanceConfig): string {
  return `${instance.sanitizedName}-recovery-rsync`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Control lane client (the receiver drives the source through the tunnel) ───

/** answered: an HTTP reply came back from the source (a refusal carries its reason); false when the call failed or timed out before any reply. */
async function control(instance: InstanceConfig, action: string, method: 'GET' | 'POST' = 'POST'): Promise<{ ok: boolean; answered: boolean; body?: any; error?: string }> {
  const record = instance.recoveryChannel;
  if (!record || record.mode !== 'receiver') return { ok: false, answered: false, error: 'no armed receiver channel' };
  // The listener helper's control lane; both this manager and the helper sit
  // on the shared docker network. The shared channel token authenticates the
  // request AND selects the armed source on the far side (this machine's
  // instance ids mean nothing over there).
  const url = `http://${record.containerName}:8946/control/${action}`;
  try {
    const res = await fetch(url, {
      method,
      headers: { 'x-recovery-token': record.token },
      signal: AbortSignal.timeout(150_000),
    });
    const body: any = await res.json().catch(() => null);
    if (!res.ok || !body || body.success !== true) {
      return { ok: false, answered: true, body, error: String(body?.error || `control ${action} returned ${res.status}`) };
    }
    return { ok: true, answered: true, body };
  } catch (err) {
    return { ok: false, answered: false, error: `control ${action} unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function controlFailure(result: { answered: boolean; error?: string }): string {
  return result.answered
    ? `The source refused: ${result.error}`
    : `The source did not answer through the tunnel: ${result.error}`;
}

/**
 * One streaming-monitor reading. Caught up needs the source to report its
 * recovery slot active (a walsender attached): replay matching a source LSN
 * says nothing about whether anything is still being received.
 */
export function streamingVerdict(
  status: { ok: boolean; answered: boolean; body?: any; error?: string },
  probe: { ok: boolean; stdout: string; stderr: string } | null,
): { caughtUp: boolean; senderAttached: boolean | null; lagBytes?: number; lastError?: string } {
  if (!status.ok) {
    return { caughtUp: false, senderAttached: null, lastError: status.answered ? `the source answered the status read with an error: ${status.error}` : `the source did not answer the status read: ${status.error}` };
  }
  const senderAttached = status.body.slotActive === true;
  if (!probe) return { caughtUp: false, senderAttached, lastError: 'the source reported no end-of-WAL position' };
  if (!probe.ok) return { caughtUp: false, senderAttached, lastError: `standby unreachable: ${probe.stderr.trim().split('\n').pop()}` };
  const [inRecovery, lag] = probe.stdout.trim().split('|');
  const lagBytes = Number(lag) || 0;
  if (inRecovery === 'f') return { caughtUp: false, senderAttached, lagBytes, lastError: 'the rescued copy left recovery unexpectedly' };
  if (!senderAttached) return { caughtUp: false, senderAttached, lagBytes, lastError: 'Standby is up but not receiving from the sender' };
  return { caughtUp: inRecovery === 't' && Number(lag) === 0, senderAttached, lagBytes, lastError: undefined };
}

// ─── Volume plumbing ───

function volExec(volume: string, script: string, stdin?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return docker(['run', '--rm', ...(stdin !== undefined ? ['-i'] : []),
    '-v', `${volume}:${PGDATA}`, '--entrypoint', 'sh', 'postgres:16-alpine', '-c', script], stdin);
}

const MARKER = `${PGDATA}/rescue.inprogress`;

/** partial: an rsync pass of a rescue has started on the volume (the marker), so it holds no consistent database to dump. */
type VolumeState = 'empty' | 'database' | 'partial';

async function volumeState(volume: string): Promise<{ ok: true; state: VolumeState } | { ok: false; error: string }> {
  const probe = await volExec(volume, `if test -f ${MARKER}; then echo partial; elif test -f ${PGDATA}/PG_VERSION; then echo database; else echo empty; fi`);
  const answer = probe.ok ? probe.stdout.trim() : '';
  if (answer === 'empty' || answer === 'database' || answer === 'partial') return { ok: true, state: answer };
  return { ok: false, error: probe.ok ? `the volume check answered '${answer}'` : probe.stderr.trim().split('\n').pop() || 'no answer' };
}

/** This machine's database identity read from pg_control on the volume, so the database need not run. */
async function localControlIdentity(volume: string): Promise<{ ok: true; identity: RescueIdentity } | { ok: false; error: string }> {
  const probe = await volExec(volume, `pg_controldata ${PGDATA}`);
  if (!probe.ok) return { ok: false, error: probe.stderr.trim().split('\n').pop() || 'pg_controldata failed' };
  const field = (label: string) => {
    const line = probe.stdout.split('\n').find(l => l.startsWith(`${label}:`));
    return line ? line.slice(label.length + 1).trim() : '';
  };
  const systemId = field('Database system identifier');
  const timeline = Number(field("Latest checkpoint's TimeLineID"));
  if (!/^\d+$/.test(systemId) || !Number.isInteger(timeline)) return { ok: false, error: 'pg_controldata gave no system id or timeline' };
  return { ok: true, identity: { systemId, timeline, checkpointLsn: field('Latest checkpoint location') || undefined } };
}

export interface IdentityCheck {
  refusal?: string;
  /** Warnings the operator must acknowledge, each by key, before the overwrite. */
  acks: { key: string; text: string }[];
}

/**
 * The sender's database against this machine's before an overwrite. A different fleet store is refused; a different
 * cluster, a sender on a lower timeline, or an identity that could not be read here each need an explicit
 * acknowledgement. local null: this machine's volume holds no database worth comparing (empty, or a partial copy).
 */
export function compareIdentities(
  source: Partial<RescueIdentity> | undefined,
  sourceError: string | undefined,
  local: { identity: RescueIdentity } | { error: string } | null,
): IdentityCheck {
  if (sourceError || !source?.systemId) return { refusal: `The sender did not report its database identity (${sourceError || 'no system id'}), so it cannot be compared with this machine's`, acks: [] };
  if (source.storeId === undefined) return { refusal: 'The sender did not report its store id, so it cannot be compared with this machine\'s', acks: [] };
  if (!local) return { acks: [] };
  if ('error' in local) {
    return { acks: [{ key: 'local-unreadable', text: `This machine's database identity could not be read (${local.error}), so whether the sender holds a copy of the same database can't be confirmed` }] };
  }
  const here = local.identity;
  if (typeof here.storeId === 'string' && source.storeId !== here.storeId) {
    return {
      refusal: source.storeId === null
        ? `The sender's database holds no fleet store, and this machine's holds store ${here.storeId}`
        : `The sender holds a different fleet store (store id ${source.storeId}) from this machine's (store id ${here.storeId})`,
      acks: [],
    };
  }
  const acks: IdentityCheck['acks'] = [];
  if (source.systemId !== here.systemId) {
    acks.push({ key: 'system-id', text: `The sender's database is a different cluster (system id ${source.systemId}) from this machine's (system id ${here.systemId}), so neither is a copy that branched from the other` });
  } else if (typeof source.timeline === 'number' && source.timeline < here.timeline) {
    acks.push({ key: 'timeline', text: `The sender's database is on timeline ${source.timeline}, below this machine's timeline ${here.timeline}: this machine's copy was promoted after the two parted, so it may hold the newer writes` });
  }
  return { acks };
}

/** Parks the rescue back at the bulk pass: what was copied so far cannot be trusted. */
class CopyDiscarded extends Error {}

/** Throws when a running container other than the rescue's own rsync client mounts the database volume. */
async function refuseForeignMounts(instance: InstanceConfig): Promise<void> {
  const ps = await docker(['ps', '--filter', `volume=${instance.fleetDb!.volume}`, '--format', '{{.Names}}']);
  if (!ps.ok) throw new Error(`docker could not say whether a container mounts the database volume: ${ps.stderr.trim().split('\n').pop()}`);
  const names = ps.stdout.split('\n').map(n => n.trim()).filter(n => n && n !== rsyncClientName(instance));
  if (names.length > 0) {
    throw new CopyDiscarded(`the database container was started outside the manager during the copy (${names.join(', ')} mounts the database volume); the copy is discarded: stop that container, then Continue, and the rescue copies again from the bulk pass`);
  }
}

// ─── Phase record plumbing ───

// Probe telemetry belongs to the phase and the driver run that measured it: a phase change, a park or a Continue drops it.
const PROBE_TELEMETRY = ['caughtUp', 'lagBytes', 'senderAttached', 'probedAt'] as const;

function saveRescue(botId: string, patch: Partial<RecoveryRescueRecord>): RecoveryRescueRecord | null {
  const instance = containerManager.getBot(botId);
  const current = instance?.recoveryRescue;
  if (!instance || !current) return null;
  const next: RecoveryRescueRecord = { ...current, ...patch, updatedAt: Date.now() };
  const phaseChanged = patch.phase !== undefined && patch.phase !== current.phase;
  if (phaseChanged || patch.parked !== undefined) {
    for (const key of PROBE_TELEMETRY) if (!(key in patch)) delete next[key];
  }
  containerManager.updateInstanceRecoveryRescue(botId, next);
  return next;
}

/** Structural preconditions; failing any parks the rescue rather than retrying. Teardown and flip run after promote and tolerate a half-gone (or gone) channel - teardown is what removes it. */
function structurallySound(instance: InstanceConfig | null): instance is InstanceConfig {
  if (!instance || !instance.fleetDb || !instance.recoveryRescue) return false;
  const phase = instance.recoveryRescue.phase;
  if (phase === 'teardown' || phase === 'flip') return true;
  return instance.recoveryChannel?.mode === 'receiver';
}

// ─── The driver ───

const running = new Set<string>();
const runStartedAt = new Map<string, number>();
const SLOT_PHASES: string[] = ['preflight', 'bulk', 'consistent', 'standby'];
// From phaseStandby on, the copy may run as a standby of the sender.
const STANDBY_PHASES: string[] = ['standby', 'streaming', 'quiesce', 'catchup'];

function rescueAlive(botId: string): boolean {
  return !!containerManager.getBot(botId)?.recoveryRescue;
}

function throwIfCancelled(botId: string): void {
  if (!rescueAlive(botId)) throw new Error('rescue cancelled');
}

type StartAnswer = {
  success: boolean;
  error?: string;
  needsConfirm?: boolean;
  state?: 'fresh' | 'outdated' | 'partial';
  sourceIdentity?: Record<string, unknown>;
  localIdentity?: RescueIdentity;
  acks?: { key: string; text: string }[];
};

/**
 * Start or Continue. acknowledge: the warning keys the operator confirmed on a fresh start (compareIdentities).
 * withoutDump: Continue a rescue parked on a failed safety dump by overwriting with no dump, which the operator chose.
 */
export async function startRescue(
  instance: InstanceConfig,
  confirm: boolean,
  opts: { acknowledge?: string[]; withoutDump?: boolean } = {},
): Promise<StartAnswer> {
  if (containerManager.isShuttingDown()) return { success: false, error: containerManager.SHUTDOWN_REFUSAL };
  if (!instance.fleetDb) return { success: false, error: 'This instance has no managed fleet database to receive into' };
  // Teardown removes the channel, and the flip starts the fleet: Continue past them needs neither check.
  const pastChannel = instance.recoveryRescue?.phase === 'teardown' || instance.recoveryRescue?.phase === 'flip';
  if (!pastChannel && instance.recoveryChannel?.mode !== 'receiver') return { success: false, error: 'Arm the recovery channel receiver first' };
  if (opts.withoutDump) {
    const r = instance.recoveryRescue;
    if (!r || r.phase !== 'preflight' || r.dumpOk !== false || !r.parked) {
      return { success: false, error: 'Overwriting without a dump applies only to a rescue parked on a failed safety dump; nothing was changed' };
    }
  }
  if (instance.recoveryRescue) {
    // Re-entry ALWAYS continues the recorded phase (Continue after a manager
    // outage or a parked halt); restarting from preflight would boot postgres
    // over a half-seeded volume to "dump" garbage.
    if (!pastChannel) {
      const live = await containerManager.runningNonSidecarContainers(instance.id);
      if (live === null) return { success: false, error: 'Docker could not say whether the instance is running, so the rescue was not continued; retry in a moment' };
      if (live.length > 0) return { success: false, error: 'Stop the instance first: the rescue replaces the database it runs on' };
    }
    if (opts.withoutDump) saveRescue(instance.id, { dumpSkipped: 'waived', parked: false, lastError: undefined });
    else if (containerManager.getBot(instance.id)?.recoveryRescue?.parked) saveRescue(instance.id, { parked: false, lastError: undefined });
    if (!running.has(instance.id)) void runRescue(instance.id);
    return { success: true };
  }

  const busyOp = containerManager.isBotBusy(instance.id);
  if (busyOp) return { success: false, error: `Operation '${busyOp}' is in progress on this instance; wait for it before starting a rescue (nothing was changed)` };
  try {
    return await containerManager.withExternalBotOp(instance.id, 'rescue', () => startFreshRescue(instance.id, confirm, opts.acknowledge ?? []));
  } catch (err) {
    return { success: false, error: `${err instanceof Error ? err.message : String(err)}; the rescue was not started` };
  }
}

/** Why a fresh rescue must not start now; null when no other lane holds the database. */
function freshRescueRefusal(instance: InstanceConfig): string | null {
  if (instance.fleetFailback) return `A ${instance.fleetFailback.mode} run is on this instance (${instance.fleetFailback.phase}); Continue, Cancel or Dismiss it on the Database modal first`;
  if (instance.fleetTransfer) return `A database transfer is recorded on this instance (${instance.fleetTransfer.phase}); let it finish or cancel it first`;
  if (instance.fleetDbReplicaSeed && instance.fleetDbReplicaSeed.parked !== true) return 'Provisioning of a standby is running on this instance; wait for it to finish';
  if (isFleetBackupBusy(instance.id)) return 'A database dump, restore or replication change is running on this instance; wait for it to finish';
  return null;
}

async function startFreshRescue(botId: string, confirm: boolean, acknowledged: string[]): Promise<StartAnswer> {
  const instance = containerManager.getBot(botId);
  if (!instance?.fleetDb) return { success: false, error: 'This instance has no managed fleet database to receive into' };
  if (instance.recoveryRescue) return { success: false, error: 'A rescue was recorded on this instance meanwhile; open it again to continue it' };
  if (instance.recoveryChannel?.mode !== 'receiver') return { success: false, error: 'Arm the recovery channel receiver first' };
  const refusal = freshRescueRefusal(instance);
  if (refusal) return { success: false, error: `${refusal} (nothing was changed)` };
  const live = await containerManager.runningNonSidecarContainers(instance.id);
  if (live === null) return { success: false, error: 'Docker could not say whether the instance is running, so the rescue was not started; retry in a moment' };
  if (live.length > 0) return { success: false, error: 'Stop the instance first: the rescue replaces the database it runs on' };
  if (instance.fleetDb.retiringAt) return { success: false, error: containerManager.unfinishedRetireRefusal(instance.fleetDb.retiringAt) };
  const prepared = await control(instance, 'prepare');
  if (!prepared.ok) return { success: false, error: controlFailure(prepared) };
  const vol = await volumeState(instance.fleetDb.volume);
  if (!vol.ok) return { success: false, error: `Docker could not say whether this machine's database volume holds a database (${vol.error}), so the rescue was not started; retry in a moment` };
  const local = vol.state === 'database' ? await localControlIdentity(instance.fleetDb.volume) : null;
  const source = prepared.body.identity as Partial<RescueIdentity> | undefined;
  const check = compareIdentities(source, prepared.body.identityError, local && (local.ok ? { identity: local.identity } : { error: local.error }));
  if (check.refusal) return { success: false, error: `${check.refusal}; the rescue was refused and nothing was changed` };
  const confirmed = confirm && check.acks.every(a => acknowledged.includes(a.key));
  if (!confirmed) {
    // FRESH vs OUTDATED is a prompt difference by design (Section 15): the
    // mechanism is identical, the operator confirms a different sentence.
    return {
      success: false,
      needsConfirm: true,
      state: vol.state === 'database' ? 'outdated' : vol.state === 'partial' ? 'partial' : 'fresh',
      sourceIdentity: prepared.body.identity,
      ...(local?.ok ? { localIdentity: local.identity } : {}),
      acks: check.acks,
    };
  }
  const record: RecoveryRescueRecord = {
    phase: 'preflight', startedAt: Date.now(), updatedAt: Date.now(),
    identity: { source: { systemId: source!.systemId!, timeline: Number(source!.timeline), checkpointLsn: source!.checkpointLsn, storeId: source!.storeId }, acked: check.acks.map(a => a.key) },
  };
  containerManager.updateInstanceRecoveryRescue(instance.id, record);
  void runRescue(instance.id);
  return { success: true };
}

/**
 * Operator-triggered swap (RC-4): only from a caught-up streaming rescue.
 * Sets the phase to quiesce; the driver takes it from there (the monitor
 * loop notices the phase change on its next tick and hands over).
 */
export function startSwap(
  instance: InstanceConfig,
  confirm: boolean,
): { success: boolean; error?: string; needsConfirm?: boolean } {
  const rescue = instance.recoveryRescue;
  if (!rescue) return { success: false, error: 'No rescue is running on this instance' };
  if (rescue.parked) return { success: false, error: 'The rescue is parked; fix the cause and Continue it first' };
  if (rescue.phase !== 'streaming') return { success: false, error: `The rescue is at phase ${rescue.phase}; the swap starts from a caught-up streaming standby` };
  const runStart = runStartedAt.get(instance.id);
  if (runStart === undefined || rescue.probedAt === undefined || rescue.probedAt < runStart) {
    return { success: false, error: 'The copy has not been probed since the rescue last started or continued; wait for the next status read' };
  }
  if (!rescue.caughtUp) return { success: false, error: 'The copy has not caught up yet; the swap starts from a caught-up standby to keep the downtime window short' };
  if (rescue.senderAttached !== true) return { success: false, error: 'The source does not report this standby attached to its recovery slot; the swap starts only while the copy is receiving' };
  if (!structurallySound(instance)) return { success: false, error: 'The channel or the database record is gone; the rescue will park' };
  if (!confirm) return { success: false, needsConfirm: true };
  saveRescue(instance.id, {
    phase: 'quiesce',
    swapPublicHost: instance.recoveryChannel!.publicHost,
    swapTargetLsn: undefined,
    lastError: undefined,
  });
  if (!running.has(instance.id)) void runRescue(instance.id);
  return { success: true };
}

export async function cancelRescue(instance: InstanceConfig): Promise<{ success: boolean; error?: string; warning?: string; note?: string }> {
  if (!instance.recoveryRescue) return { success: false, error: 'No rescue is running on this instance' };
  // Past promote there is no standby to fall back to: this copy IS the
  // primary now, and the only way out is forward (Continue re-enters the
  // recorded phase). Quiesce and catchup are still reversible - the copy is
  // a standby and the source bot merely needs a manual start.
  if (['promote', 'teardown', 'flip'].includes(instance.recoveryRescue.phase)) {
    return { success: false, error: 'The swap is past promotion; finish it (Continue) instead of cancelling' };
  }
  // The client must be PROVEN gone before the record clears: the start-guard
  // keys on the record, and an orphan rsync rewriting the volume under a
  // freshly started postgres is the corruption this ordering prevents.
  const rm = await docker(['rm', '-f', rsyncClientName(instance)]);
  if (!rm.ok && !/no such container/i.test(rm.stderr)) {
    return { success: false, error: `could not remove the rsync client: ${rm.stderr.trim().split('\n').pop()}` };
  }
  // Re-read AFTER the await: the driver can cross catchup -> promote during
  // the docker round-trip, and clearing the record then would leave a
  // promoted primary with no record, no guard and no teardown ever running.
  // No await between this read and the clear, so the driver cannot interleave.
  const fresh = containerManager.getBot(instance.id);
  if (!fresh?.recoveryRescue) return { success: true };
  if (['promote', 'teardown', 'flip'].includes(fresh.recoveryRescue.phase)) {
    return { success: false, error: 'The swap advanced past promotion while cancelling; finish it (Continue) instead' };
  }
  const phase = fresh.recoveryRescue.phase;
  const left = STANDBY_PHASES.includes(phase) ? 'standby' as const : fresh.recoveryRescue.passStartedAt ? 'partial' as const : null;
  const earlier = fresh.recoveryRescueLeft?.state ?? (fresh.recoveryRescue.dumpSkipped === 'partial' ? 'partial' as const : null);
  const mark = left ?? (earlier && !fresh.recoveryRescueLeft ? earlier : null);
  containerManager.updateInstanceRecoveryRescue(instance.id, null, undefined, mark ? { at: Date.now(), state: mark } : undefined);
  // A driver mid-rsyncPass may recreate the client in a narrow window; its
  // next poll sees the cleared record and removes it again. Sweep once more
  // for the window where the driver died between create and poll.
  setTimeout(() => { void docker(['rm', '-f', rsyncClientName(instance)]); }, 15_000).unref();
  // The seeded/partial volume stays as-is: the operator decides what happens
  // next (re-run, disarm, or normal re-provision paths).
  const warnings: string[] = [];
  const container = fresh.fleetDb?.containerName;
  if (left === 'standby' && container) {
    // The copy runs as a standby of the sender once phaseStandby started it; stopped so it no longer follows the channel.
    const stop = await docker(['stop', container]);
    if (!stop.ok && !/no such container/i.test(stop.stderr)) {
      warnings.push(`the database container could not be stopped (${stop.stderr.trim().split('\n').pop()}), so the copy keeps following the sender until it is stopped`);
    }
  }
  const released = containerManager.releaseFleetDbFromLane(instance.id);
  if (!released.success) warnings.push(`${released.error}; the database does not start from the app until it is back`);
  const note = left === 'partial'
    ? 'Rescue cancelled. This machine\'s volume holds a partial copy of the sender\'s database, so Start is refused until a rescue finishes the copy or the database is decommissioned.'
    : left === 'standby'
      ? 'Rescue cancelled. This machine\'s database is a standby copy of the sender, so Start is refused until a rescue finishes the swap or the database is decommissioned.'
      : earlier === 'partial'
        ? 'Rescue cancelled before it copied anything. This machine\'s volume still holds the partial copy of the sender\'s database that an earlier rescue left, so Start is refused until a rescue finishes the copy or the database is decommissioned.'
        : earlier === 'standby'
          ? 'Rescue cancelled before it copied anything. This machine\'s volume still holds the standby copy of the sender that an earlier cancelled rescue left, so Start is refused until a rescue finishes the swap or the database is decommissioned.'
          : 'Rescue cancelled before any copy began; this machine\'s database was not changed.';
  if (warnings.length) return { success: true, note, warning: `The rescue was cancelled, but ${warnings.join('; and ')}` };
  return { success: true, note };
}

/** A runner can outlive its record by one docker call after a Cancel. */
export function rescueRunnerLive(botId: string): boolean {
  return running.has(botId);
}

export function getRescueStatus(instance: InstanceConfig): RecoveryRescueRecord | null {
  return instance.recoveryRescue ?? null;
}

/** Boot resume: re-enter every recorded phase that is not parked. */
export function resumeRecoveryRescues(): void {
  for (const instance of containerManager.getAllBots()) {
    const rescue = instance.recoveryRescue;
    if (!rescue || rescue.parked) continue;
    console.log(`[RecoveryRescue] Resuming rescue for ${instance.displayName} at phase ${rescue.phase}`);
    saveRescue(instance.id, Object.fromEntries(PROBE_TELEMETRY.map(key => [key, undefined])));
    void runRescue(instance.id);
  }
}

async function runRescue(botId: string): Promise<void> {
  if (running.has(botId)) return;
  running.add(botId);
  runStartedAt.set(botId, Date.now());
  // The phases that rewrite the volume hold the backup slot, so no dump, restore or replication change runs under them.
  let slotHeld = false;
  try {
    for (;;) {
      const instance = containerManager.getBot(botId);
      if (!structurallySound(instance)) {
        if (containerManager.getBot(botId)?.recoveryRescue) {
          saveRescue(botId, { parked: true, lastError: 'the channel or the database record disappeared mid-rescue' });
        }
        return;
      }
      if (instance.recoveryRescue!.parked) return;
      const phase = instance.recoveryRescue!.phase;
      const rewritesVolume = SLOT_PHASES.includes(phase);
      if (rewritesVolume && !slotHeld) {
        // The record stays, so the rescue resumes from this phase at the next boot.
        if (containerManager.isShuttingDown()) return;
        if (!claimFleetBackupBusy(botId)) {
          if (!saveRescue(botId, { lastError: 'a database dump, restore or replication change is running on this instance; the rescue waits for it' })) return;
          await sleep(RETRY_DELAY_MS);
          if (!containerManager.getBot(botId)?.recoveryRescue) return;
          continue;
        }
        slotHeld = true;
      } else if (!rewritesVolume && slotHeld) {
        releaseFleetBackupBusy(botId);
        slotHeld = false;
      }
      try {
        if (phase === 'preflight') await phasePreflight(instance);
        else if (phase === 'bulk') await phaseBulk(instance);
        else if (phase === 'consistent') await phaseConsistent(instance);
        else if (phase === 'standby') await phaseStandby(instance);
        // continue, not return: the monitor also exits when startSwap moves
        // the phase to quiesce, and the next iteration must dispatch it.
        else if (phase === 'streaming') { await phaseMonitor(instance); continue; }
        else if (phase === 'quiesce') await phaseQuiesce(instance);
        else if (phase === 'catchup') await phaseCatchup(instance);
        else if (phase === 'promote') await phasePromote(instance);
        else if (phase === 'teardown') await phaseTeardown(instance);
        else if (phase === 'flip') { await phaseFlip(instance); return; }
        else return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof CopyDiscarded) {
          console.warn(`[RecoveryRescue] ${instance.displayName}: ${message}`);
          saveRescue(botId, { phase: 'bulk', parked: true, lastError: message });
          return;
        }
        if (!saveRescue(botId, { caughtUp: undefined, lagBytes: undefined, lastError: message })) {
          console.warn(`[RecoveryRescue] ${instance.displayName} phase ${phase} failed: ${message}; the rescue record is gone, so nothing retries`);
          return;
        }
        console.warn(`[RecoveryRescue] ${instance.displayName} phase ${phase} failed: ${message}; retrying in ${RETRY_DELAY_MS / 1000}s`);
        await sleep(RETRY_DELAY_MS);
        // The rescue record may have been cancelled during the sleep.
        if (!containerManager.getBot(botId)?.recoveryRescue) return;
      }
    }
  } finally {
    if (slotHeld) releaseFleetBackupBusy(botId);
    running.delete(botId);
    runStartedAt.delete(botId);
  }
}

// ─── Phases ───

/** Remove the sidecar container and PROVE it gone: a stopped one is a start away (a CasaOS tile click or restart), and rsync under a running postgres is the corruption this phase exists to prevent. The volume stays. */
async function removeSidecarHard(containerName: string): Promise<void> {
  const rm = await docker(['rm', '-f', containerName]);
  if (!rm.ok && !/no such container/i.test(rm.stderr)) {
    throw new Error(`could not remove the database container: ${rm.stderr.trim().split('\n').pop()}`);
  }
  const state = await docker(['inspect', '--format', '{{.State.Running}}', containerName]);
  if (state.ok) throw new Error('the database container is still present after its removal');
  if (!/no such (container|object)/i.test(state.stderr)) {
    throw new Error(`docker could not confirm the database container is gone: ${state.stderr.trim().split('\n').pop()}`);
  }
}

/**
 * The safety dump is a precondition of the overwrite: a dump that fails parks the rescue here with the volume
 * untouched, and only the operator's explicit choice (Continue retries it, Overwrite without a dump waives it) moves
 * on. A partial copy from an earlier rescue's pass is not a database to dump. The sender's identity is compared with
 * this machine's again right before the container is removed.
 */
async function phasePreflight(instance: InstanceConfig): Promise<void> {
  const fleetDb = instance.fleetDb!;
  const rescue = instance.recoveryRescue!;
  const vol = await volumeState(fleetDb.volume);
  if (!vol.ok) throw new Error(`docker could not say what the database volume holds (${vol.error}); nothing was changed`);
  if (vol.state !== 'database') {
    if (rescue.dumpSkipped !== vol.state) saveRescue(instance.id, { dumpSkipped: vol.state });
  } else if (rescue.dumpOk !== true && rescue.dumpSkipped !== 'waived') {
    // A retried preflight finds the service taken out by the earlier attempt; the volume is not rewritten yet.
    const back = containerManager.releaseFleetDbFromLane(instance.id);
    if (!back.success) throw new Error(back.error);
    const started = await containerManager.startFleetDbSidecar(instance.id, { forRescue: true });
    throwIfCancelled(instance.id);
    if (started.success) {
      const store = await readStoreId(fleetDb);
      if (!store.ok) throw new Error(`this machine's store id could not be read for the comparison with the sender's (${store.error}); nothing was changed`);
      const identity = containerManager.getBot(instance.id)?.recoveryRescue?.identity;
      if (identity) saveRescue(instance.id, { identity: { ...identity, localStoreId: store.storeId } });
    }
    const dump = started.success
      ? await runFleetDump(instance, 'pre-rescue-')
      : { success: false, file: undefined, error: `the database did not start for it: ${started.error}` };
    throwIfCancelled(instance.id);
    if (!dump.success) {
      console.warn(`[RecoveryRescue] ${instance.displayName}: the safety dump before the rescue failed: ${dump.error}; the rescue waits for the operator`);
      saveRescue(instance.id, {
        parked: true, dumpOk: false, dumpError: dump.error,
        lastError: `The safety dump of this machine's database failed (${dump.error}), so nothing was overwritten. Continue retries the dump; Overwrite without a dump replaces the database with no copy kept`,
      });
      return;
    }
    saveRescue(instance.id, { dumpOk: true, dumpFile: dump.file, dumpError: undefined });
  }
  if (vol.state === 'database') {
    const mismatch = await overwriteIdentityRefusal(instance);
    if (mismatch) {
      saveRescue(instance.id, { parked: true, lastError: `${mismatch}; nothing was overwritten. Cancel the rescue, and start it again to confirm what the two databases report now` });
      return;
    }
  }
  const live = await containerManager.runningNonSidecarContainers(instance.id);
  if (live === null) throw new Error('docker could not say whether the instance is running, so its database was not stopped');
  if (live.length > 0) throw new Error(`the instance is running (${live.join(', ')}); stop it, and the rescue retries`);
  // A cancel during the dump released nothing; no await between this check and the hold, so a later cancel undoes it.
  throwIfCancelled(instance.id);
  // Out of the compose first, then the container: nothing the app file lists can bring it back during the copy.
  const held = containerManager.holdFleetDbForLane(instance.id);
  if (!held.success) throw new Error(held.error);
  await removeSidecarHard(fleetDb.containerName);
  saveRescue(instance.id, { phase: 'bulk', lastError: undefined });
}

/** Why the overwrite must not go ahead: the sender or this machine reports an identity that was not confirmed at the start. */
async function overwriteIdentityRefusal(instance: InstanceConfig): Promise<string | null> {
  const confirmed = containerManager.getBot(instance.id)?.recoveryRescue?.identity;
  if (!confirmed) return 'The rescue record holds no confirmed identity of the sender';
  const prepared = await control(instance, 'prepare');
  if (!prepared.ok) throw new Error(controlFailure(prepared));
  const source = prepared.body.identity as Partial<RescueIdentity> | undefined;
  if (!prepared.body.identityError && source?.systemId && (source.systemId !== confirmed.source.systemId || source.storeId !== confirmed.source.storeId)) {
    return `The sender now reports a different database (system id ${source.systemId}, store id ${source.storeId ?? 'none'}) from the one confirmed at the start (system id ${confirmed.source.systemId}, store id ${confirmed.source.storeId ?? 'none'})`;
  }
  const local = await localControlIdentity(instance.fleetDb!.volume);
  const check = compareIdentities(source, prepared.body.identityError,
    local.ok ? { identity: { ...local.identity, ...(confirmed.localStoreId !== undefined ? { storeId: confirmed.localStoreId } : {}) } } : { error: local.error });
  if (check.refusal) return check.refusal;
  const unconfirmed = check.acks.filter(a => !confirmed.acked.includes(a.key));
  if (unconfirmed.length) return `${unconfirmed.map(a => a.text).join('; ')}, which was not confirmed at the start`;
  return null;
}

/**
 * One rsync pass as a detached container, polled to completion; throws on a
 * failing exit so the driver retries. Delta by nature, so retry = resume.
 * The pass kind is stamped as a label: a consistent-phase re-entry must never
 * adopt a still-running BULK container from before a crash (its files predate
 * the backup window). The consistent pass adds --checksum, because the
 * quick-check (size+mtime) misses an 8k page rewritten in the same second the
 * bulk pass copied it - postgres files never change size.
 */
async function rsyncPass(instance: InstanceConfig, pass: 'bulk' | 'consistent'): Promise<void> {
  const fleetDb = instance.fleetDb!;
  const channel = instance.recoveryChannel!;
  const name = rsyncClientName(instance);
  await refuseForeignMounts(instance);
  const state = await docker(['inspect', '--format', '{{.State.Running}} {{index .Config.Labels "rescue-pass"}}', name]);
  // Only a BULK pass may be adopted: a running consistent-pass container from
  // before a manager crash predates the CURRENT backup window (backup-start
  // re-runs on every consistent entry), and pages it copied in the gap would
  // never be revisited nor repaired by replay.
  const adoptable = pass === 'bulk' && state.ok && state.stdout.trim() === `true ${pass}`;
  if (!adoptable) {
    if (!containerManager.getBot(instance.id)?.recoveryRescue) throw new Error('rescue cancelled');
    await docker(['rm', '-f', name]);
    const image = await docker(['inspect', '--format', '{{.Config.Image}}', channel.containerName]);
    if (!image.ok || !image.stdout.trim()) throw new Error('could not resolve the relay image for the rsync client');
    const network = await docker(['inspect', '--format', '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}\n{{end}}', channel.containerName]);
    const net = network.ok ? network.stdout.split('\n').map(s => s.trim()).filter(Boolean)[0] : '';
    if (!net) throw new Error('could not resolve the relay network for the rsync client');
    if (!containerManager.getBot(instance.id)?.recoveryRescue) throw new Error('rescue cancelled');
    const run = await docker(['run', '-d', '--name', name, ...LOG_CAP_RUN_ARGS,
      '--label', `rescue-pass=${pass}`,
      '--network', net,
      '-v', `${fleetDb.volume}:/pgdata`,
      '--entrypoint', 'sh', image.stdout.trim(), '-c',
      `exec rsync -a --delete --partial ${pass === 'consistent' ? '--checksum ' : ''}--exclude=rescue.inprogress --exclude=postmaster.pid --exclude=postmaster.opts --exclude=pg_replslot/** --exclude=pg_dynshmem/** --exclude=pg_notify/** --exclude=pg_serial/** --exclude=pg_snapshots/** --exclude=pg_stat_tmp/** --exclude=pg_subtrans/** rsync://${channel.containerName}:873/pgdata/ /pgdata/`]);
    if (!run.ok) throw new Error(`could not start the rsync pass: ${run.stderr.trim().split('\n').pop()}`);
  }
  for (;;) {
    await sleep(RSYNC_POLL_MS);
    if (!containerManager.getBot(instance.id)?.recoveryRescue) {
      // The cancel path must not leave a detached rsync rewriting the volume
      // after the start-guard (which keys on the record) is gone.
      await docker(['rm', '-f', name]);
      throw new Error('rescue cancelled');
    }
    const poll = await docker(['inspect', '--format', '{{.State.Running}} {{.State.ExitCode}}', name]);
    if (!poll.ok) throw new Error('the rsync container disappeared');
    const [runningNow, exitCode] = poll.stdout.trim().split(' ');
    if (runningNow === 'true') continue;
    await docker(['rm', '-f', name]);
    // 24 = source files vanished mid-transfer: the expected outcome of
    // copying a LIVE data directory, not a failure.
    if (exitCode !== '0' && exitCode !== '24') throw new Error(`rsync exited with code ${exitCode}`);
    return;
  }
}

async function phaseBulk(instance: InstanceConfig): Promise<void> {
  // Stamp, then mark, then copy: a marked volume always has a stamped pass, so a cancel that finds no stamp leaves a
  // volume no pass has touched, and a later preflight that finds the marker knows a pass did start.
  if (!instance.recoveryRescue!.passStartedAt && !saveRescue(instance.id, { passStartedAt: Date.now() })) throw new Error('rescue cancelled');
  const mark = await volExec(instance.fleetDb!.volume, `touch ${MARKER}`);
  if (!mark.ok) throw new Error(`could not mark the volume: ${mark.stderr.trim()}`);
  await rsyncPass(instance, 'bulk');
  saveRescue(instance.id, { phase: 'consistent', lastError: undefined });
}

async function phaseConsistent(instance: InstanceConfig): Promise<void> {
  const fleetDb = instance.fleetDb!;
  const started = await control(instance, 'backup-start');
  if (!started.ok) throw new Error(started.error);
  if (!containerManager.getBot(instance.id)?.recoveryRescue) {
    await control(instance, 'backup-stop');
    throw new Error('rescue cancelled');
  }
  let stopResult: any;
  try {
    await rsyncPass(instance, 'consistent');
  } finally {
    const stopped = await control(instance, 'backup-stop');
    if (stopped.ok) stopResult = stopped.body.result;
  }
  throwIfCancelled(instance.id);
  if (!stopResult?.labelfile) throw new Error('pg_backup_stop returned no backup label; re-running the consistent pass');
  const label = String(stopResult.labelfile);
  await refuseForeignMounts(instance);
  throwIfCancelled(instance.id);
  // The transfer excludes the ephemeral dirs' CONTENTS, so an OUTDATED
  // receiver's stale leftovers (foreign replication slots above all) survive
  // rsync --delete and must go explicitly.
  const write = await volExec(fleetDb.volume,
    `cat > ${PGDATA}/backup_label && rm -f ${PGDATA}/postmaster.pid ${PGDATA}/postmaster.opts && rm -rf ${PGDATA}/pg_replslot/* ${PGDATA}/pg_dynshmem/* ${PGDATA}/pg_notify/* ${PGDATA}/pg_serial/* ${PGDATA}/pg_snapshots/* ${PGDATA}/pg_stat_tmp/* ${PGDATA}/pg_subtrans/* && chown postgres:postgres ${PGDATA}/backup_label && chmod 600 ${PGDATA}/backup_label`,
    label.endsWith('\n') ? label : label + '\n');
  if (!write.ok) throw new Error(`could not write backup_label: ${write.stderr.trim()}`);
  saveRescue(instance.id, { phase: 'standby', lastError: undefined });
}

async function phaseStandby(instance: InstanceConfig): Promise<void> {
  const fleetDb = instance.fleetDb!;
  const channel = instance.recoveryChannel!;
  const prepared = await control(instance, 'prepare');
  if (!prepared.ok) throw new Error(controlFailure(prepared));
  throwIfCancelled(instance.id);
  const replicator = prepared.body.replicator;
  // sslmode=disable is safe here: the wire is plaintext only between local
  // containers on each machine; the cross-host leg is the tunnel's TLS.
  // sslmode=require, not disable: the source's authored pg_hba accepts
  // replication over hostssl ONLY, and the relay lanes are raw byte pipes so
  // the SSLRequest handshake rides the tunnel end-to-end (require does not
  // verify the cert, so the source's self-signed pair passes).
  const conninfo = `host=${channel.containerName} port=5432 user=${replicator.user} password=${replicator.password} application_name=recovery_rescue sslmode=require`;
  const config = `primary_conninfo = '${conninfo}'\nprimary_slot_name = '${prepared.body.slot}'\n`;
  // Once released, the database container running is this phase's own start of a retried attempt.
  if (containerManager.fleetDbHeldForLane(instance.id)) await refuseForeignMounts(instance);
  throwIfCancelled(instance.id);
  const write = await volExec(fleetDb.volume,
    `touch ${PGDATA}/standby.signal && rm -f ${MARKER} && sed -i '/^primary_conninfo/d;/^primary_slot_name/d;/^default_transaction_read_only/d' ${PGDATA}/postgresql.auto.conf && cat >> ${PGDATA}/postgresql.auto.conf && chown postgres:postgres ${PGDATA}/standby.signal ${PGDATA}/postgresql.auto.conf`,
    config);
  if (!write.ok) throw new Error(`could not author the standby config: ${write.stderr.trim()}`);
  // A cancel during the write has already put the database back in the compose and must not find a standby started after it.
  throwIfCancelled(instance.id);
  // Back in the compose only now: from here on a start from the app file starts the copy as a standby.
  const released = containerManager.releaseFleetDbFromLane(instance.id);
  if (!released.success) throw new Error(released.error);
  const started = await containerManager.startFleetDbSidecar(instance.id, { forRescue: true });
  if (!rescueAlive(instance.id)) {
    // Cancelled during the start: the cancel's stop may have run before the container came up.
    await docker(['stop', fleetDb.containerName]);
    throw new Error('rescue cancelled');
  }
  if (!started.success) {
    // Early recovery legitimately refuses connections past the ready wait;
    // the container being up is the phase's actual requirement.
    const state = await docker(['inspect', '--format', '{{.State.Running}}', fleetDb.containerName]);
    if (!(state.ok && state.stdout.trim() === 'true')) throw new Error(started.error || 'the standby container did not start');
  }
  saveRescue(instance.id, { phase: 'streaming', lastError: undefined });
}

async function phaseMonitor(instance: InstanceConfig): Promise<void> {
  const fleetDb = instance.fleetDb!;
  for (;;) {
    const fresh = containerManager.getBot(instance.id);
    if (!structurallySound(fresh)) {
      // A surviving record with a vanished channel/database must park loudly,
      // not leave a stale "catching up" with no driver behind it.
      if (containerManager.getBot(instance.id)?.recoveryRescue) {
        saveRescue(instance.id, { parked: true, lastError: 'the channel or the database record disappeared mid-streaming' });
      }
      return;
    }
    if (fresh.recoveryRescue!.phase !== 'streaming' || fresh.recoveryRescue!.parked) return;
    const status = await control(fresh, 'status', 'GET');
    if (status.ok && status.body.slotWalStatus === 'lost') {
      // The slot invalidated (retained WAL passed the source's bound): the
      // standby can never resume from it. Loud park beats an eternal
      // "catching up" - the fallback is a fresh seed (cancel + re-run).
      saveRescue(instance.id, { parked: true, caughtUp: false, lastError: 'the recovery slot on the source was invalidated (WAL bound exceeded); cancel and re-run the rescue to seed fresh' });
      return;
    }
    const sourceLsn = status.ok ? String(status.body.sourceLsn || '') : '';
    const probe = sourceLsn && /^[0-9A-F]+\/[0-9A-F]+$/i.test(sourceLsn)
      ? await docker(['exec', fleetDb.containerName, 'psql', '-U', fleetDb.user, '-d', fleetDb.db, '-tA', '-c',
        `SELECT pg_is_in_recovery(), GREATEST(pg_wal_lsn_diff('${sourceLsn}', pg_last_wal_replay_lsn()), 0)`])
      : null;
    const verdict = streamingVerdict(status, probe);
    saveRescue(instance.id, {
      caughtUp: verdict.caughtUp,
      senderAttached: verdict.senderAttached,
      lagBytes: verdict.lagBytes,
      probedAt: Date.now(),
      lastError: verdict.lastError,
    });
    await sleep(MONITOR_INTERVAL_MS);
  }
}

// ─── Swap phases (RC-4) ───

const CATCHUP_POLL_MS = 5_000;
const CATCHUP_NO_SENDER_PARK_MS = 10 * 60_000;

/** The source bot stops (its database keeps serving the tunnel) and hands back its end-of-WAL: everything before that LSN is the database, everything after quiesce is nothing. Idempotent, so a re-entry just re-captures the LSN. */
async function phaseQuiesce(instance: InstanceConfig): Promise<void> {
  // The sender checks this against its own before it stops anything.
  const systemId = await readSystemId(instance.fleetDb!);
  if (!systemId) throw new Error('could not read the system id of this machine\'s copy, so the sender was not asked to stop');
  const quiesced = await control(instance, `quiesce?systemId=${systemId}`);
  if (!quiesced.ok && quiesced.body?.identityMismatch === true) {
    saveRescue(instance.id, { parked: true, lastError: `The sender refused the swap: ${quiesced.error}. Cancel the rescue and check which machine the channel is armed against` });
    return;
  }
  if (!quiesced.ok) throw new Error(quiesced.error);
  const target = String(quiesced.body.sourceLsn || '');
  if (!/^[0-9A-F]+\/[0-9A-F]+$/i.test(target)) throw new Error(`quiesce returned no end-of-WAL (${target || 'empty'})`);
  const term = quiesced.body.sourceTerm;
  if (term !== null && !Number.isSafeInteger(term)) {
    throw new Error(`the source did not report its control term at quiesce (${JSON.stringify(term ?? null)}), so the copy could not be floored above it`);
  }
  saveRescue(instance.id, { phase: 'catchup', swapTargetLsn: target, swapSourceTerm: term, lastError: undefined });
}

async function phaseCatchup(instance: InstanceConfig): Promise<void> {
  const fleetDb = instance.fleetDb!;
  const target = instance.recoveryRescue!.swapTargetLsn;
  if (!target) { saveRescue(instance.id, { phase: 'quiesce', lastError: undefined }); return; }
  for (;;) {
    const fresh = containerManager.getBot(instance.id);
    if (!structurallySound(fresh) || fresh.recoveryRescue!.phase !== 'catchup' || fresh.recoveryRescue!.parked) return;
    const probe = await docker(['exec', fleetDb.containerName, 'psql', '-U', fleetDb.user, '-d', fleetDb.db, '-tA', '-c',
      `SELECT pg_is_in_recovery(), GREATEST(pg_wal_lsn_diff('${target}', pg_last_wal_replay_lsn()), 0)`]);
    if (!probe.ok) throw new Error(`standby unreachable during catchup: ${probe.stderr.trim().split('\n').pop()}`);
    const [inRecovery, lag] = probe.stdout.trim().split('|');
    if (inRecovery === 'f' || Number(lag) === 0) {
      // Already out of recovery = a previous run promoted before the record
      // advanced; the promote phase is idempotent about that.
      saveRescue(instance.id, { phase: 'promote', lagBytes: 0, lastError: undefined });
      return;
    }
    // Replay is short of the target: prove it still CAN get there. A lost
    // slot parks (the WAL is gone, only a fresh seed recovers - and the
    // source fleet is down, so a silent wait here is downtime forever); an
    // unreachable source stays loud in lastError while replay retries.
    const status = await control(fresh, 'status', 'GET');
    if (status.ok && status.body.slotWalStatus === 'lost') {
      saveRescue(instance.id, { parked: true, lastError: 'the recovery slot on the source was invalidated during catchup; cancel and re-run the rescue to seed fresh' });
      return;
    }
    if (status.ok && status.body.slotActive !== true) {
      // Proven absence only: an unanswered status read never starts this clock.
      const since = fresh.recoveryRescue!.noSenderSince ?? Date.now();
      if (Date.now() - since >= CATCHUP_NO_SENDER_PARK_MS) {
        saveRescue(instance.id, { parked: true, noSenderSince: undefined, lagBytes: Number(lag) || 0, lastError: `no walsender has been attached to the recovery slot for ${CATCHUP_NO_SENDER_PARK_MS / 60_000} minutes during catchup; check the standby's connection to the sender, then Continue` });
        return;
      }
      saveRescue(instance.id, { noSenderSince: since, lagBytes: Number(lag) || 0, lastError: 'Standby is up but not receiving from the sender' });
    } else {
      saveRescue(instance.id, {
        ...(status.ok ? { noSenderSince: undefined } : {}),
        lagBytes: Number(lag) || 0,
        lastError: status.ok ? undefined : `${status.answered ? 'the source answered the status read with an error' : 'the source did not answer the status read'}: ${status.error}`,
      });
    }
    await sleep(CATCHUP_POLL_MS);
  }
}

async function phasePromote(instance: InstanceConfig): Promise<void> {
  const fleetDb = instance.fleetDb!;
  const state = await docker(['exec', fleetDb.containerName, 'psql', '-U', fleetDb.user, '-d', fleetDb.db, '-tA', '-c', 'SELECT pg_is_in_recovery()']);
  if (!state.ok) throw new Error(`standby unreachable at promote: ${state.stderr.trim().split('\n').pop()}`);
  if (state.stdout.trim() === 't') {
    const promoted = await docker(['exec', fleetDb.containerName, 'psql', '-U', fleetDb.user, '-d', fleetDb.db, '-tA', '-c', 'SELECT pg_promote(true, 60)']);
    if (!promoted.ok || promoted.stdout.trim() !== 't') {
      throw new Error(`pg_promote failed: ${(promoted.stderr || promoted.stdout).trim().split('\n').pop() || 'timed out'}`);
    }
  }
  saveRescue(instance.id, { phase: 'teardown', lastError: undefined });
}

/** Both channel helpers go. The control call is best effort (the source operator disarms manually during the handback visit if it never lands); the LOCAL disarm must succeed - a promoted primary with a listener still armed would accept a second rescue over it. */
async function phaseTeardown(instance: InstanceConfig): Promise<void> {
  if (instance.recoveryChannel) {
    const bye = await control(instance, 'teardown');
    if (!bye.ok) console.warn(`[RecoveryRescue] Source side unreachable for teardown (${instance.displayName}): ${bye.error}; disarm it manually on the source machine`);
    const disarmed = await disarmRecoveryChannel(instance);
    if (!disarmed.success && !/No recovery channel/i.test(disarmed.error || '')) {
      throw new Error(`could not disarm the channel: ${disarmed.error}`);
    }
  }
  saveRescue(instance.id, { phase: 'flip', lastError: undefined });
}

/**
 * File the promoted copy as this machine's primary. The copied database
 * carries the SOURCE's credentials; the app role's password is reconciled to
 * this machine's stored env first (over the trust socket), so the fleet and
 * the manager keep reading the URL they always had. Then the standby remnants
 * go, replication is enabled (slot + copy block ready for the handback
 * re-seed), the fleet starts, and the app returns to its configured role.
 * The record keeps a flipStep through the start and the role reset, so a
 * failed start retries and a manager restart resumes the remaining sub-steps;
 * it clears only once the role reset answered.
 */
async function phaseFlip(instance: InstanceConfig): Promise<void> {
  const released = containerManager.releaseFleetDbFromLane(instance.id);
  if (!released.success) throw new Error(released.error);
  const step = instance.recoveryRescue!.flipStep;
  if (!step) {
    await fileCopyAsPrimary(instance);
    saveRescue(instance.id, { flipStep: 'start', lastError: undefined });
  }
  if (step !== 'role') {
    await startFlippedFleet(instance);
    if (!hasAppHooks(containerManager.getBot(instance.id) || instance)) {
      finishFlip(instance);
      return;
    }
    saveRescue(instance.id, { flipStep: 'role', lastError: undefined });
  }
  await returnAppToRole(instance);
}

function finishFlip(instance: InstanceConfig): void {
  containerManager.updateInstanceRecoveryRescue(instance.id, null, { startedAt: instance.recoveryRescue!.startedAt, completedAt: Date.now() });
}

function parkFlip(instance: InstanceConfig, reason: string): void {
  console.warn(`[RecoveryRescue] ${instance.displayName}: ${reason}`);
  saveRescue(instance.id, { parked: true, lastError: reason });
}

async function fileCopyAsPrimary(instance: InstanceConfig): Promise<void> {
  const fleetDb = instance.fleetDb!;
  const rescue = instance.recoveryRescue!;
  const dbSpec = findAppCapabilities(instance.sourceUrl)?.companionDb;
  if (!dbSpec) throw new Error('this app declares no managed database companion');
  const storedUrl = (envManager.getEnvVars(instance.id)[dbSpec.env.url] || '').trim();
  let password = '';
  try { password = decodeURIComponent(new URL(storedUrl).password); } catch { /* refused below */ }
  if (!password) throw new Error(envManager.storeBrokenDiagnosis(instance.id) || 'could not recover the database password from the stored database URL');
  // The leading RESET lifts a quiesce write fence the copy may have inherited
  // (a re-rescue rsyncs a fenced source's auto.conf in): ALTER ROLE is a real
  // catalog write and read-only refuses it, which would wedge the flip. The
  // script goes on stdin and sets the verifier, so neither the password nor
  // its verifier is in a command line or the server log.
  const verifier = scramSha256Verifier(password);
  const alter = await docker(['exec', '-i', fleetDb.containerName, 'psql', '-U', fleetDb.user, '-d', fleetDb.db, '-tA', '-v', 'ON_ERROR_STOP=1'],
    'SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE;\n'
    + 'ALTER SYSTEM RESET default_transaction_read_only;\n'
    + 'ALTER SYSTEM RESET synchronous_standby_names;\n'
    + 'SELECT pg_reload_conf();\n'
    + QUIET_ROLE_SESSION_SQL
    + `ALTER ROLE "${fleetDb.user}" WITH LOGIN PASSWORD '${verifier}';\n`);
  if (!alter.ok) throw new Error(`could not reconcile the database credentials: ${redactSecrets(alter.stderr.trim(), [password, verifier]).split('\n').pop()}`);
  const clean = await docker(['exec', fleetDb.containerName, 'sh', '-c',
    `sed -i '/^primary_conninfo/d;/^primary_slot_name/d' ${PGDATA}/postgresql.auto.conf`]);
  if (!clean.ok) throw new Error(`could not clean the standby settings: ${clean.stderr.trim().split('\n').pop()}`);
  await floorCopyTerms(instance);

  const fresh = containerManager.getBot(instance.id);
  if (!fresh) throw new Error('instance disappeared mid-flip');
  const host = fresh.fleetDb?.replication?.publicHost || rescue.swapPublicHost;
  if (!host) throw new Error('no public host to enable replication with (no prior replication record and none captured at swap start)');
  // rotateCert: the rsync passes delivered the SOURCE's server.crt/key, and a
  // surviving certHost record would make enable keep them - then the copy
  // block's verify-full DSN could never match and the handback re-seed dies.
  const enabled = await enableFleetReplication(fresh, host, fresh.fleetDb?.replication?.hostPort, undefined, { rotateCert: true, fromRescue: true });
  if (!enabled.success) throw new Error(`the copy is primary but enabling replication failed: ${enabled.error}`);
  const stored = envManager.getEnvVars(instance.id);
  const repointUrl = (stored[dbSpec.env.url] || '').trim();
  const repoints: Record<string, string> = {};
  for (const key of dbSpec.repointedEnv ?? []) {
    if ((stored[key] || '').trim() !== '') repoints[key] = repointUrl;
  }
  // The env store alone: container env assembly derives sensitive values from
  // it at read time (the two-store strip).
  if (Object.keys(repoints).length) envManager.setEnvVars(instance.id, repoints);
}

/**
 * Raise the promoted copy's control term and every guild lease above the term the source held at quiesce, in a
 * read-write session: a lease token the source's fleet still holds (term at most that, any epoch) can then no
 * longer write, and the master here claims a term above any the source posted. Idempotent, so a retried flip
 * repeats it harmlessly.
 */
async function floorCopyTerms(instance: InstanceConfig): Promise<void> {
  const fleetDb = instance.fleetDb!;
  const sourceTerm = instance.recoveryRescue!.swapSourceTerm;
  if (sourceTerm === null) return;
  if (sourceTerm === undefined) throw new Error('no source control term was captured at quiesce, so the copy cannot be floored above it');
  const psql = (sql: string) => docker(['exec', '-e', 'PGOPTIONS=-c default_transaction_read_only=off', fleetDb.containerName,
    'psql', '-U', fleetDb.user, '-d', fleetDb.db, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
  const table = await psql("SELECT to_regclass('smdb_control.term') IS NOT NULL");
  if (!table.ok) throw new Error(`could not read the copy's control term table: ${table.stderr.trim().split('\n').pop()}`);
  if (!/^[tf]$/.test(table.stdout.trim())) throw new Error(`the copy's control term table probe answered '${table.stdout.trim()}'`);
  if (table.stdout.trim() === 't') {
    const control = await psql(`WITH u AS (UPDATE smdb_control.term SET term = GREATEST(term, ${sourceTerm + 1}) RETURNING 1) SELECT count(*) FROM u`);
    if (!control.ok) throw new Error(`could not raise the copy's control term above ${sourceTerm}: ${control.stderr.trim().split('\n').pop()}`);
  }
  const leases = await raiseGuildTerms(fleetDb, sourceTerm);
  if (!leases.ok) throw new Error(`could not raise the copy's guild leases above term ${sourceTerm}: ${leases.error}`);
}

/** Throws on a failed start so the driver retries with the record kept; a fleet the operator already started counts as started. */
async function startFlippedFleet(instance: InstanceConfig): Promise<void> {
  if (containerManager.getBot(instance.id)?.status === 'running') return;
  let started: { success: boolean; error?: string };
  try {
    started = await containerManager.startBot(instance.id);
  } catch (err) {
    started = { success: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!started.success) {
    throw new Error(`The swap finished but the fleet did not start: ${started.error}; the manager retries every ${RETRY_DELAY_MS / 1000} s, or start it from the bot list`);
  }
}

async function returnAppToRole(instance: InstanceConfig): Promise<void> {
  const current = () => containerManager.getBot(instance.id) || instance;
  // The certificate rotated, so the copy block is pushed once the app answers
  // and before the role reset restarts it: backups receive a block only when
  // they register, and they re-register with the restarted bot. Its hooks
  // answer when its web server listens, not when the start returns.
  const answering = await appLifecycle.waitForAppHook(current(), APP_HOOK_WAIT_MS);
  if (!answering.success) {
    parkFlip(instance, `The fleet started, but ${answering.error}; check the app, then Continue to publish the copy block and return it to its configured role`);
    return;
  }
  const republished = await appLifecycle.deliverCopyBlock(current());
  if (!republished.success) {
    console.warn(`[RecoveryRescue] Copy block not republished after the cert rotation: ${republished.error}; once the role reset below has restarted the bot as the fleet's master, opening the Replication section on this instance publishes it, and each designated backup receives it only at its next registration (a restart of either bot)`);
  }
  // The app booted in whatever role and store its own files last recorded
  // (a demote's co-worker override, the forms it followed as a co-worker);
  // the swap made this machine the primary by infrastructure means, so the
  // app is told to return to its configured role and store, and restarts.
  const reset = await appLifecycle.resetRole(current(), true);
  if (!reset.success) {
    parkFlip(instance, reset.unknown
      ? `The fleet started, but can't confirm the app returned to its configured role: ${reset.error}; Continue sends the role reset again`
      : `The fleet started, but the app did not return to its configured role: ${reset.error}; fix the cause, then Continue`);
    return;
  }
  finishFlip(instance);
}
