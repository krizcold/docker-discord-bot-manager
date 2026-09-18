/**
 * Manager-side wrapper over an app's own lifecycle decisions (PLAN_REPLICATION
 * 20.13/20.16/20.17, stage B4m-2a). Every DECISION here belongs to the app and
 * is reached through its hooks; this module only turns the operator's click into
 * a hook call, and performs the docker and data-directory work the app's own
 * recorded facts imply. It never decides who should be master.
 */
import * as containerManager from '../docker/containerManager';
import { getReplicaCopyBlock } from './fleetReplication';
import { callAppHook, hasAppHooks } from './appHookClient';
import { findAppCapabilities } from '../config/appCapabilities';
import { InstanceConfig } from '../types';

/** The app's stand-in lane (20.5, B6-f): the one fact a manager may read a stand-in from. */
export interface StandInFact {
  /** This boot IS the stand-in the record describes; false on a node showing why its last attempt ended. */
  live: boolean;
  phase: 'claimed' | 'serving' | 'promoting' | 'promoted' | 'disarmed';
  coveringNodeId: string;
  armedAt: number;
  inheritedTerm: number | null;
  holdUntil: number;
  writeGate: string | null;
  writeRefusal: string | null;
  promotedAt: number | null;
  disarmedAt: number | null;
  disarmReason: string | null;
  rearmAfter: number | null;
}

export interface AppFacts {
  running: boolean;
  initialized: boolean;
  role: string | null;
  nodeId: string | null;
  nodeName: string | null;
  term: number | null;
  standalone: boolean;
  backupMaster: boolean;
  /** The app's own verdict that this node is where the copy block belongs. */
  copyBlockTarget: boolean;
  superseded: { byNodeId: string; byNodeName: string; term: number; retireRequested: boolean; at: number; source: string; steppedDown: boolean } | null;
  promote: any;
  emptyStoreHold: any;
  takeoverHold: any;
  staleMasterPark: { observedTerm: number; localTerm: number; peerUrl: string; at: number } | null;
  /** The follower hold (20.5, B6 map F28): this master came back behind a stand-in that took the fleet's writes (behind), or on a database that is a copy of another node's (copy), and follows the node holding the fleet as a co-worker until the failback promotes it back. */
  followerHold: { reason: 'behind' | 'copy'; standInNodeId: string | null; standInName: string | null; observedTerm: number | null; localTerm: number | null; seenVia: string; since: number; following: string | null; followingForms?: string[]; namesThisNode: boolean | null } | null;
  /** The stand-in lane on this node (20.5): live while it holds the fleet for a dead master, its last record otherwise. */
  standIn: StandInFact | null;
  /** Co-worker: the node it registered with stands in for that master, so the fleet runs on a temporary copy (20.5). */
  masterStandingInFor?: string | null;
  copyBlock: { dsn: string; cert: string; publishedAt: number } | null;
  /** The app's own verdict that the block names the database this node follows; null when it holds none or cannot tell. */
  copyBlockCurrent?: boolean | null;
  /** The app's container carries a standby endpoint (it learned its standby); null while the bot is down. */
  dbReplica?: boolean | null;
  /** The primary's last word on this node's standby slot, as the app recorded it (20.17); null when none. */
  standbySlot: {
    slotName: string; walStatus: string; active: boolean; retainedBytes: number | null;
    observedAt: number; receivedAt: number; fromNodeId: string; fromTerm: number; sourceIsCurrentMaster: boolean | null;
    sourceAt: number;
  } | null;
  /** The app's own verdict: the fact is fresh, the slot is lost, and it is on the master this copy follows. */
  standbySlotLost: boolean;
}

export interface ActionResult {
  success: boolean;
  error?: string;
  /** The app asked for an explicit confirmation before it will act. */
  needsConfirm?: boolean;
  /** The app wants the RPO acknowledged before promoting. */
  needsLagConfirm?: boolean;
  /** The app says another designated backup received further than this copy (20.19 F14). */
  needsLineageConfirm?: boolean;
  lagMs?: number | null;
  restartRequired?: boolean;
  [key: string]: unknown;
}

/**
 * An instance hosting a companion database whose app declares no capability
 * record is a configuration hole, not a plain app: the manager would silently
 * treat it as having no companion and skip provisioning and retirement for a
 * database that really exists. Refuse loudly instead (PLAN_REPLICATION 20.16
 * carried-forward guard).
 */
export function capabilityRefusal(instance: InstanceConfig): string | null {
  const hasCompanion = !!instance.fleetDb || !!instance.fleetDbReplica;
  if (!hasCompanion) return null;
  if (findAppCapabilities(instance.sourceUrl)?.companionDb) return null;
  return 'This instance runs a managed database but its app declares no capability record, so the manager cannot tell how to provision or retire it. Add a record for this source before using the database lifecycle here.';
}

/** Translate a hook result into the flat shape the routes and UI expect. */
function fromHook(result: { ok: boolean; body?: any; error?: string }): ActionResult {
  if (result.ok) return { success: true, ...(result.body ?? {}) };
  // A refusal carries the app's own named reason plus any confirm flags; a
  // transport failure has no body and only the error survives.
  const body = result.body ?? {};
  return { ...body, success: false, error: result.error || body.error || 'the app refused' };
}

/** The app's recorded facts, or a named reason they could not be read. */
export async function getAppFacts(instance: InstanceConfig, timeoutMs?: number): Promise<{ success: boolean; facts?: AppFacts; error?: string }> {
  if (!hasAppHooks(instance)) return { success: false, error: 'this app declares no lifecycle hooks' };
  const result = await callAppHook<AppFacts & { success: boolean }>(instance, 'facts', 'GET', undefined, timeoutMs);
  if (!result.ok) return { success: false, error: result.error };
  return { success: true, facts: result.body as AppFacts };
}

/**
 * What a stand-in means for THIS machine's database (20.5, B6 map F33-F35):
 * its own copy is the temporary database, its primary is parked behind one,
 * or the fleet it belongs to is served by one. Read from the app's explicit
 * facts alone; a copy's recovery state cannot tell a stand-in from a promotion
 * (F34), so an unreadable app is 'unanswered', never "no stand-in".
 */
export interface StandInPosture {
  role: 'stand-in' | 'covered' | 'peer';
  /**
   * The lane is live. False only for role 'stand-in': the lane ENDED (a demote,
   * a step-down) after the copy took the fleet's writes, so the copy may hold
   * writes no other database has. Consumers apply that only while the copy is
   * still out of recovery; a standby seeded afterwards is a plain copy again.
   */
  live: boolean;
  /** The node holding the fleet; null when a peer's reply did not name it. */
  standInNodeId: string | null;
  /** The master it stands in for. */
  coveringNodeId: string | null;
  /** The stand-in's copy has been promoted and takes the fleet's writes; null when this side cannot tell. */
  holdsWrites: boolean | null;
  since: number | null;
  /** Why an ended lane ended, in the app's words. */
  disarmReason: string | null;
  /** Role 'covered' only: this database is behind the stand-in's copy, or is a copy of it. */
  holdReason: 'behind' | 'copy' | null;
  /** Role 'covered' only: the node this bot registered with still says it stands in for it (null until registered; false once a hand promote or an ended lane stopped it). */
  namesThisNode: boolean | null;
  /** Role 'covered' only: the database the node it follows delivered is installed and serving here; false while it could not be dialed or verified. */
  followsDelivered: boolean | null;
}

export type StandInRead =
  | { read: 'ok'; posture: StandInPosture | null }
  | { read: 'unanswered'; error: string }
  /** The app declares no hooks, so no stand-in can exist on it. */
  | { read: 'none' };

export function postureFromFacts(facts: AppFacts): StandInPosture | null {
  const own = facts.standIn;
  const covers = !!own && typeof own.coveringNodeId === 'string' && own.coveringNodeId !== '';
  if (own && covers && own.live === true) {
    const promoted = own.phase === 'promoted';
    return { role: 'stand-in', live: true, standInNodeId: facts.nodeId ?? null, coveringNodeId: own.coveringNodeId, holdsWrites: promoted, since: promoted ? own.promotedAt : own.armedAt, disarmReason: null, holdReason: null, namesThisNode: null, followsDelivered: null };
  }
  // A lane that ended AFTER taking the writes (a demote, a step-down) leaves a
  // promoted copy that may hold writes nothing else has; only the manual
  // promote makes them the fleet's for good. That exit is recognised by the
  // reason the bot's promote engine writes (its one site), because the boot
  // that follows reports role master with initialized false for as long as
  // it holds, and a mid-boot master cannot be told from a demoted co-worker.
  const promotedByHand = own?.disarmReason === 'promoted by hand into the true master';
  if (own && covers && own.phase === 'disarmed' && own.promotedAt !== null && !promotedByHand && !(facts.role === 'master' && facts.initialized === true)) {
    return { role: 'stand-in', live: false, standInNodeId: facts.nodeId ?? null, coveringNodeId: own.coveringNodeId, holdsWrites: true, since: own.promotedAt, disarmReason: own.disarmReason, holdReason: null, namesThisNode: null, followsDelivered: null };
  }
  const hold = facts.followerHold;
  if (hold && (hold.reason === 'behind' || hold.reason === 'copy')) {
    // Both entries put the other copy ahead of this database: a stand-in that
    // took writes at a higher term (a serve-only one never holds the master,
    // B6-f2), or the copy this database was re-seeded from. Read before the
    // peer fact below: the node it follows names THIS node, which on any
    // other machine would read as a peer.
    const named = typeof hold.standInNodeId === 'string' && hold.standInNodeId !== '' ? hold.standInNodeId : null;
    return { role: 'covered', live: true, standInNodeId: named, coveringNodeId: facts.nodeId || null, holdsWrites: true, since: Number.isFinite(hold.since) ? hold.since : null, disarmReason: null, holdReason: hold.reason, namesThisNode: typeof hold.namesThisNode === 'boolean' ? hold.namesThisNode : null, followsDelivered: typeof hold.following === 'string' && hold.following !== '' };
  }
  const served = facts.masterStandingInFor;
  if (typeof served === 'string' && served !== '') {
    return { role: 'peer', live: true, standInNodeId: null, coveringNodeId: served, holdsWrites: null, since: null, disarmReason: null, holdReason: null, namesThisNode: null, followsDelivered: null };
  }
  return null;
}

export type FactsRead = Awaited<ReturnType<typeof getAppFacts>>;

/** The posture from an answer already in hand, so one facts read serves every verdict taken from it. */
export function postureFromRead(instance: InstanceConfig, read: FactsRead | null): StandInRead {
  if (!hasAppHooks(instance)) return { read: 'none' };
  if (instance.status !== 'running') return { read: 'unanswered', error: 'the instance is not running' };
  if (!read || !read.success || !read.facts) return { read: 'unanswered', error: read?.error || 'no facts' };
  // The stand-in fact lives in the bot process; the parent answers the hook
  // while that process is down, and a null there is silence, not a verdict.
  if (read.facts.running !== true) return { read: 'unanswered', error: 'the bot process is not running' };
  return { read: 'ok', posture: postureFromFacts(read.facts) };
}

export async function readStandInPosture(instance: InstanceConfig, timeoutMs?: number): Promise<StandInRead> {
  if (!hasAppHooks(instance)) return { read: 'none' };
  if (instance.status !== 'running') return { read: 'unanswered', error: 'the instance is not running' };
  return postureFromRead(instance, await getAppFacts(instance, timeoutMs));
}

/** What an operator can do about an unanswered facts read, as a clause that precedes "before <the lane>". */
export function unansweredRemedy(error: string): string {
  if (/bot process/.test(error)) return 'wait for the bot process to come back, or read its logs,';
  if (/instance is not running/.test(error)) return 'start the instance';
  return 'wait for the app to answer, or restart the instance,';
}

/**
 * Deliver when what the app holds is missing or no longer names this machine's
 * endpoint. A promoted node inherits the OLD master's block, so "already has
 * one" is not "has the right one", and keying on the endpoint keeps a steady
 * fleet from paying a docker exec on every poll.
 *
 * It does NOT detect a rotated certificate behind an unchanged host and port:
 * the sites that rotate in place call deliverCopyBlock directly instead.
 */
export async function ensureCopyBlockCurrent(
  instance: InstanceConfig,
  held: { dsn: string } | null,
): Promise<ActionResult & { delivered: boolean }> {
  const replication = instance.fleetDb?.replication;
  if (!replication) return { success: true, delivered: false };
  if (held?.dsn) {
    try {
      const url = new URL(held.dsn);
      const port = url.port || '5432';
      if (url.hostname === replication.publicHost && port === String(replication.hostPort)) {
        return { success: true, delivered: false };
      }
    } catch { /* unparseable means stale by definition */ }
  }
  const published = await deliverCopyBlock(instance);
  return { ...published, delivered: published.success };
}

/**
 * Give this node's app the copy block for the database it hosts, so it can relay
 * it to designated backups on register (20.14). Only the manager can produce it:
 * the replicator password and the server certificate live in the sidecar it owns.
 * Safe to call repeatedly - the app just overwrites its copy.
 */
export async function deliverCopyBlock(instance: InstanceConfig): Promise<ActionResult> {
  if (!instance.fleetDb?.replication) return { success: false, error: 'replication is not enabled on this instance' };
  if (!hasAppHooks(instance)) return { success: false, error: 'this app declares no lifecycle hooks' };
  const block = await getReplicaCopyBlock(instance);
  if (!block.success || !block.dsn || !block.cert) {
    return { success: false, error: block.error || 'could not assemble the copy block' };
  }
  return fromHook(await callAppHook(instance, 'copy-block', 'POST', { dsn: block.dsn, cert: block.cert }));
}

/**
 * Promote this whole side. With the old master alive the app takes its zero-loss
 * transfer path; with it gone, the RPO-confirmed failover path. retireOldMaster
 * is [Transfer and retire]: the instruction is relayed to the old master's bot
 * for ITS manager to act on, never executed from here.
 */
export async function transfer(
  instance: InstanceConfig,
  opts: { confirmLag?: boolean; confirmLineage?: boolean; retireOldMaster?: boolean } = {},
): Promise<ActionResult> {
  const refusal = capabilityRefusal(instance);
  if (refusal) return { success: false, error: refusal };
  return fromHook(await callAppHook(instance, 'promote', 'POST', {
    confirmLag: opts.confirmLag === true,
    confirmLineage: opts.confirmLineage === true,
    retireOldMaster: opts.retireOldMaster === true,
  }));
}

/** Demote this master (the 20.12a freeze warning rides needsConfirm). */
export async function demote(instance: InstanceConfig, confirm: boolean): Promise<ActionResult> {
  return fromHook(await callAppHook(instance, 'demote', 'POST', { confirm }));
}
