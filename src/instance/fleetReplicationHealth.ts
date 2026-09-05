/**
 * Replication health sampling (PLAN_REPLICATION.md Stage 5).
 *
 * The live probes on both sides run through `docker exec` / `docker run` and
 * take seconds, so they can never run inline on the instance list, which the
 * UI polls constantly. A background sampler walks both sides on a slow tick
 * and caches one compact verdict per instance; the list endpoint reads that
 * cache synchronously and the Database modal keeps using the live endpoints.
 *
 * Every verdict is derived from the same status functions the modal renders,
 * so a broken link says the same thing in both places.
 */

import * as containerManager from '../docker/containerManager';
import { getFleetReplicationStatus } from './fleetReplication';
import { getFleetReplicaStatus } from './fleetReplica';
import { getAppFacts } from './appLifecycle';
import { hasAppHooks } from './appHookClient';
import { InstanceConfig } from '../types';

const TICK_INTERVAL_MS = 60_000;
/** Matches the bot's REPLICA_LAG_PROMOTE_MAX_MS (R3): past this a promotion needs a confirm. */
const LAG_WARN_SECONDS = 60;
/** A facts read on the tick must not hang it: the hook's default timeout is sized for a promote. */
const FACTS_TIMEOUT_MS = 10_000;
/** Matches the app's own freshness window for the slot fact. */
const SLOT_FACT_FRESH_MS = 5 * 60_000;

export type ReplicationSeverity = 'ok' | 'warn' | 'error';

/** The primary's word on a standby's slot, relayed through the app's facts (20.17); the copy itself cannot see it. */
export interface StandbySlotFact {
  slotName: string;
  walStatus: string;
  observedAt: number;
  /** The app's verdict: fresh, lost, and on the master this copy follows. */
  lost: boolean;
}

export interface ReplicationHealth {
  role: 'primary' | 'replica';
  severity: ReplicationSeverity;
  /** Operator-facing sentence; the card shows it as the badge tooltip. */
  message: string;
  lagSeconds: number | null;
  checkedAt: number;
  /** Replica only; null when the app reported nothing usable (stopped, unreachable, stale, or no fact yet). */
  slot?: StandbySlotFact | null;
}

const cache: Map<string, ReplicationHealth> = new Map();
/** Whether the previous tick saw the standby's receiver streaming; a contradiction needs two ticks. */
const streamingSeen: Map<string, boolean> = new Map();
let intervalHandle: ReturnType<typeof setInterval> | null = null;

/** Cached verdict for the instance list; null when this instance has no replication role. */
export function getReplicationHealth(botId: string): ReplicationHealth | null {
  return cache.get(botId) || null;
}

function round(seconds: number | null | undefined): number | null {
  return seconds === null || seconds === undefined || !Number.isFinite(seconds) ? null : Math.round(seconds * 10) / 10;
}

/** Postgres size-GUC string ('4GB', '4096MB', '-1') to bytes; null = unbounded or unparsable. */
function sizeSettingBytes(setting: string): number | null {
  const match = /^(-?\d+)\s*(kB|MB|GB|TB)?$/.exec((setting || '').trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (value < 0) return null;
  const unit = match[2] || 'MB';
  const factor = unit === 'kB' ? 1024 : unit === 'MB' ? 1024 ** 2 : unit === 'GB' ? 1024 ** 3 : 1024 ** 4;
  return value * factor;
}

function mb(bytes: number): number {
  return Math.round(bytes / (1024 ** 2));
}

async function samplePrimary(instance: InstanceConfig): Promise<ReplicationHealth> {
  const status = await getFleetReplicationStatus(instance, { probeEndpoint: false });
  const base = { role: 'primary' as const, checkedAt: Date.now() };
  if (!status.live) {
    return { ...base, severity: 'warn', message: 'Database container is not running, so nothing is being replicated', lagSeconds: null };
  }
  if (!status.live.sslOn) {
    return { ...base, severity: 'warn', message: 'TLS is not active on the database yet; restart the instance to finish enabling replication', lagSeconds: null };
  }
  // An invalidated slot outranks everything below: its standby can never
  // resume from it, so the streaming picture is already lost (RC-1).
  const lost = (status.live.slots || []).find(s => s.walStatus === 'lost');
  if (lost) {
    return { ...base, severity: 'error', message: `Replication slot ${lost.slot} was invalidated (retained WAL passed the bound); its standby cannot resume and must be re-seeded from the copy block`, lagSeconds: null };
  }
  // 'unreserved' = past the bound but not yet dropped; the standby can still
  // make it if it reconnects before the next checkpoint takes the WAL.
  const unreserved = (status.live.slots || []).find(s => s.walStatus === 'unreserved');
  if (unreserved) {
    return { ...base, severity: 'error', message: `Replication slot ${unreserved.slot} is past the WAL retention bound and about to be invalidated; reconnect its standby now or plan a re-seed`, lagSeconds: null };
  }
  const bound = sizeSettingBytes(status.live.slotWalKeep);
  const fattest = (status.live.slots || []).reduce<{ slot: string; retainedBytes: number } | null>((max, s) =>
    s.retainedBytes !== null && (max === null || s.retainedBytes > max.retainedBytes) ? { slot: s.slot, retainedBytes: s.retainedBytes } : max, null);
  const retentionWarn = bound !== null && fattest !== null && fattest.retainedBytes > bound / 2
    ? `Replication slot ${fattest.slot} retains ${mb(fattest.retainedBytes)} MB of WAL (bound ${mb(bound)} MB); past the bound the slot invalidates and its standby must be re-seeded`
    : null;
  const standbys = status.live.standbys;
  if (standbys.length === 0) {
    // Indistinguishable from "never set up": the primary keeps no memory of a
    // standby beyond the slot, and the slot exists from the moment replication
    // is enabled. Warn either way, because both states mean unprotected.
    return {
      ...base,
      severity: 'warn',
      message: retentionWarn ?? (status.live.slotActive
        ? 'A standby holds the replication slot but is not streaming; the copy is stale'
        : 'No standby is attached: this machine dying would take the fleet database with it'),
      lagSeconds: null,
    };
  }
  const broken = standbys.find(s => s.state !== 'streaming');
  if (broken) {
    return { ...base, severity: 'error', message: `Standby ${broken.clientAddr || 'link'} is ${broken.state || 'not streaming'} rather than streaming`, lagSeconds: null };
  }
  if (retentionWarn) {
    return { ...base, severity: 'warn', message: retentionWarn, lagSeconds: null };
  }
  const worst = standbys.reduce<number | null>((max, s) =>
    s.replayLagSeconds !== null && (max === null || s.replayLagSeconds > max) ? s.replayLagSeconds : max, null);
  if (worst !== null && worst > LAG_WARN_SECONDS) {
    return { ...base, severity: 'warn', message: `Standby is ${Math.round(worst)}s behind; a failover now would lose that much`, lagSeconds: round(worst) };
  }
  return { ...base, severity: 'ok', message: `Streaming to ${standbys.length} standby${standbys.length === 1 ? '' : 's'}`, lagSeconds: round(worst) };
}

/**
 * The slot fact the app recorded, or null for every way it can be unknown: a
 * stopped or hookless app, an unreachable hook, no record yet, a stale record,
 * or a record about a master this copy does not follow. Unknown never widens a
 * verdict (the 2a lesson): the caller treats null exactly like "no fact".
 */
async function readSlotFact(instance: InstanceConfig): Promise<StandbySlotFact | null> {
  if (instance.status !== 'running' || !hasAppHooks(instance)) return null;
  const result = await getAppFacts(instance, FACTS_TIMEOUT_MS);
  const fact = result.success ? result.facts?.standbySlot : null;
  if (!fact || typeof fact.slotName !== 'string' || fact.slotName === '' || typeof fact.walStatus !== 'string' || fact.walStatus === '') return null;
  if (fact.sourceIsCurrentMaster !== true) return null;
  if (!Number.isFinite(fact.receivedAt) || Date.now() - Number(fact.receivedAt) > SLOT_FACT_FRESH_MS) return null;
  return { slotName: fact.slotName, walStatus: fact.walStatus, observedAt: Number(fact.observedAt) || 0, lost: result.facts?.standbySlotLost === true };
}

async function sampleReplica(instance: InstanceConfig): Promise<ReplicationHealth> {
  const status = await getFleetReplicaStatus(instance);
  const relayed = await readSlotFact(instance);
  // A receiver that streams contradicts "lost" or "absent" (a walsender refuses
  // both), which marks a record from before a re-seed: it reads as unknown,
  // never as a verdict on the copy that replaced it. One reading is not enough:
  // against a lost slot the walreceiver shows "streaming" for the length of a
  // handshake on every 5 s retry, so two ticks a minute apart must agree.
  const streamingNow = status.live?.receiverStatus === 'streaming';
  const streamingTwice = streamingNow && streamingSeen.get(instance.id) === true;
  streamingSeen.set(instance.id, streamingNow);
  const contradicted = relayed !== null && streamingTwice
    && (relayed.walStatus === 'lost' || relayed.walStatus === 'absent');
  const slot = contradicted ? null : relayed;
  const base = { role: 'replica' as const, checkedAt: Date.now(), slot };
  if (status.provisioning) {
    return { ...base, severity: 'ok', message: `Provisioning (${status.provisioning.phase})`, lagSeconds: null };
  }
  const live = status.live;
  // live ABSENT means the status could not even be probed (e.g. a record
  // stamped before the identity fields), which is a different claim than a
  // stopped container; say the real reason.
  if (!live) {
    return { ...base, severity: 'error', message: status.lastError || 'Standby state could not be read', lagSeconds: null };
  }
  if (!live.running) {
    return { ...base, severity: 'error', message: 'Standby container is not running, so it is no longer receiving changes', lagSeconds: null };
  }
  if (live.inRecovery === false) {
    return { ...base, severity: 'error', message: 'This copy has been promoted and no longer follows the primary; adopt it as the database of this machine, or re-provision it', lagSeconds: null };
  }
  // The primary's own word outranks the receiver's silence (20.17): a lost
  // slot can never be resumed, whereas "not streaming" alone cannot tell a
  // lost slot from a primary that is merely offline.
  if (slot?.lost) {
    return { ...base, severity: 'error', message: `The primary reports replication slot ${slot.slotName} as lost (its retained WAL passed the bound); this copy can never catch up and must be re-seeded`, lagSeconds: null };
  }
  if (slot && slot.walStatus === 'absent') {
    return { ...base, severity: 'error', message: `The primary has no replication slot named ${slot.slotName} any more; this copy cannot resume streaming and must be re-seeded`, lagSeconds: null };
  }
  if (slot && slot.walStatus === 'unreserved') {
    return { ...base, severity: 'error', message: `The primary reports replication slot ${slot.slotName} past the WAL retention bound and about to be invalidated; reconnect this standby now or plan a re-seed`, lagSeconds: round(live.replayLagSeconds) };
  }
  if (live.receiverStatus !== 'streaming') {
    return { ...base, severity: 'error', message: `Not streaming from the primary (${live.receiverStatus || 'no connection'}); the copy is falling behind`, lagSeconds: round(live.replayLagSeconds) };
  }
  const lag = live.replayLagSeconds;
  if (live.caughtUp !== true && lag !== null && lag > LAG_WARN_SECONDS) {
    return { ...base, severity: 'warn', message: `${Math.round(lag)}s behind the primary`, lagSeconds: round(lag) };
  }
  return { ...base, severity: 'ok', message: live.caughtUp === true ? 'Streaming, caught up' : 'Streaming', lagSeconds: round(lag) };
}

async function runTick(): Promise<void> {
  const instances = containerManager.getAllBots();
  const live = new Set<string>();
  for (const instance of instances) {
    const isPrimary = !!instance.fleetDb?.replication;
    const isReplica = !!instance.fleetDbReplica;
    if (!isPrimary && !isReplica) continue;
    live.add(instance.id);
    // A stopped PRIMARY instance is an operator decision, not a broken link
    // (compose down takes its sidecar with it): report the role without a
    // warning rather than crying wolf. A REPLICA outlives its instance (it is
    // provisioned before the first start and only compose down removes it), so
    // its standby is sampled regardless - a dead standby must never hide
    // behind a stopped instance (drill R-5, finding F2).
    if (isPrimary && instance.status !== 'running') {
      cache.set(instance.id, {
        role: 'primary',
        severity: 'ok',
        message: 'Instance is stopped',
        lagSeconds: null,
        checkedAt: Date.now(),
      });
      continue;
    }
    try {
      cache.set(instance.id, isPrimary ? await samplePrimary(instance) : await sampleReplica(instance));
    } catch (error) {
      cache.set(instance.id, {
        role: isPrimary ? 'primary' : 'replica',
        severity: 'warn',
        message: `Could not read replication status: ${error instanceof Error ? error.message : String(error)}`,
        lagSeconds: null,
        checkedAt: Date.now(),
      });
    }
  }
  for (const id of [...cache.keys()]) {
    if (!live.has(id)) cache.delete(id);
  }
  for (const id of [...streamingSeen.keys()]) {
    if (!live.has(id)) streamingSeen.delete(id);
  }
}

export function startFleetReplicationHealth(): void {
  if (intervalHandle) return;
  console.log(`[FleetReplication] Health sampler started (tick: ${TICK_INTERVAL_MS / 1000}s)`);
  void runTick().catch(err => console.error('[FleetReplication] Health tick error:', err));
  intervalHandle = setInterval(() => {
    runTick().catch(err => console.error('[FleetReplication] Health tick error:', err));
  }, TICK_INTERVAL_MS);
}

export function stopFleetReplicationHealth(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[FleetReplication] Health sampler stopped');
  }
}
