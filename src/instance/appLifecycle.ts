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
import { FleetLineageFact, InstanceConfig } from '../types';

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
  /** The running bot's consent to active backup mode, as it booted; the saved env may differ until the container is recreated. */
  activeCapable?: boolean;
  /** The app's own verdict that this node is where the copy block belongs. */
  copyBlockTarget: boolean;
  superseded: { byNodeId: string; byNodeName: string; term: number; retireRequested: boolean; at: number; source: string; steppedDown: boolean } | null;
  promote: any;
  emptyStoreHold: any;
  takeoverHold: any;
  staleMasterPark: { observedTerm: number; localTerm: number; peerUrl: string; at: number } | null;
  /** The follower hold (20.5, B6 map F28): this master came back behind a stand-in that took the fleet's writes (behind), or on a database that is a copy of another node's (copy), and follows the node holding the fleet as a co-worker until the failback promotes it back. */
  followerHold: { reason: 'behind' | 'copy'; standInNodeId: string | null; standInName: string | null; observedTerm: number | null; localTerm: number | null; seenVia: string; since: number; following: string | null; followingForms?: string[]; namesThisNode: boolean | null; lineage?: FleetLineageFact | null } | null;
  /** The stand-in lane on this node (20.5): live while it holds the fleet for a dead master, its last record otherwise. */
  standIn: StandInFact | null;
  /** Co-worker: the node it registered with stands in for that master, so the fleet runs on a temporary copy (20.5). */
  masterStandingInFor?: string | null;
  copyBlock: { dsn: string; cert: string; publishedAt: number } | null;
  /** The app's own verdict that the block names the database this node follows; null when it holds none or cannot tell. */
  copyBlockCurrent?: boolean | null;
  /** The app's own verdict that the block names the database it FOLLOWS while holding or after a step-down (B6 map F32): the source the failback re-seeds from. */
  copyBlockFollowed?: boolean | null;
  /** A stand-in whose lane ended keeps a promoted copy of its own beside the database it follows; the bot's verdict on that copy (F31). */
  ownCopyLineage?: FleetLineageFact | null;
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
  /** role-reset: whether the app also dropped the store forms it had persisted (false where its environment pins none). */
  formsCleared?: boolean;
  /** The request went out and no answer came back in time: the app may have acted. */
  unknown?: boolean;
  /** The app wants the RPO acknowledged before promoting. */
  needsLagConfirm?: boolean;
  /** The app says another designated backup received further than this copy (20.19 F14). */
  needsLineageConfirm?: boolean;
  /** The app wants it acknowledged that other instances cannot reach this one once it is the primary side. */
  needsReachabilityConfirm?: boolean;
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
function fromHook(result: { ok: boolean; body?: any; error?: string; unknown?: boolean }): ActionResult {
  if (result.ok) return { success: true, ...(result.body ?? {}) };
  if (result.unknown) return { success: false, unknown: true, error: result.error };
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
  /** Role 'stand-in' serving read-only: the app's write-step verdict in its words (the hold's countdown, or why writes were not taken); null otherwise. */
  gate: string | null;
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
    const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
    // The bot's own Fleet tab reads the same two fields in this order.
    const gate = promoted ? null : text(own.writeGate) ?? (text(own.writeRefusal) ? `taking writes was refused: ${own.writeRefusal}` : null);
    return { role: 'stand-in', live: true, standInNodeId: facts.nodeId ?? null, coveringNodeId: own.coveringNodeId, holdsWrites: promoted, since: promoted ? own.promotedAt : own.armedAt, gate, disarmReason: null, holdReason: null, namesThisNode: null, followsDelivered: null };
  }
  // A lane that ended AFTER taking the writes (a demote, a step-down) leaves a
  // promoted copy that may hold writes nothing else has; only the manual
  // promote makes them the fleet's for good. That exit is recognised by the
  // reason the bot's promote engine writes (its one site), because the boot
  // that follows reports role master with initialized false for as long as
  // it holds, and a mid-boot master cannot be told from a demoted co-worker.
  const promotedByHand = own?.disarmReason === 'promoted by hand into the true master';
  if (own && covers && own.phase === 'disarmed' && own.promotedAt !== null && !promotedByHand && !(facts.role === 'master' && facts.initialized === true)) {
    return { role: 'stand-in', live: false, standInNodeId: facts.nodeId ?? null, coveringNodeId: own.coveringNodeId, holdsWrites: true, since: own.promotedAt, gate: null, disarmReason: own.disarmReason, holdReason: null, namesThisNode: null, followsDelivered: null };
  }
  const hold = facts.followerHold;
  if (hold && (hold.reason === 'behind' || hold.reason === 'copy')) {
    // Both entries put the other copy ahead of this database: a stand-in that
    // took writes at a higher term (a serve-only one never holds the master,
    // B6-f2), or the copy this database was re-seeded from. Read before the
    // peer fact below: the node it follows names THIS node, which on any
    // other machine would read as a peer.
    const named = typeof hold.standInNodeId === 'string' && hold.standInNodeId !== '' ? hold.standInNodeId : null;
    return { role: 'covered', live: true, standInNodeId: named, coveringNodeId: facts.nodeId || null, holdsWrites: true, since: Number.isFinite(hold.since) ? hold.since : null, gate: null, disarmReason: null, holdReason: hold.reason, namesThisNode: typeof hold.namesThisNode === 'boolean' ? hold.namesThisNode : null, followsDelivered: typeof hold.following === 'string' && hold.following !== '' };
  }
  const served = facts.masterStandingInFor;
  if (typeof served === 'string' && served !== '') {
    return { role: 'peer', live: true, standInNodeId: null, coveringNodeId: served, holdsWrites: null, since: null, gate: null, disarmReason: null, holdReason: null, namesThisNode: null, followsDelivered: null };
  }
  return null;
}

export type FactsRead = Awaited<ReturnType<typeof getAppFacts>>;

/** The posture from an answer already in hand, so one facts read serves every verdict taken from it. */
export function postureFromRead(instance: InstanceConfig, read: FactsRead | null): StandInRead {
  if (!hasAppHooks(instance)) return { read: 'none' };
  // A facts answer in hand came from a running app, which a build or start lane may be driving.
  const stored = instance.status === 'error' ? containerManager.storedStatus(instance) : instance.status;
  if (stored !== 'running' && stored !== 'building' && stored !== 'starting') return { read: 'unanswered', error: 'the instance is not running' };
  if (!read || !read.success || !read.facts) return { read: 'unanswered', error: read?.error || 'no facts' };
  // The stand-in fact lives in the bot process; the parent answers the hook
  // while that process is down, and a null there is silence, not a verdict.
  if (read.facts.running !== true) return { read: 'unanswered', error: 'the bot process is not running' };
  return { read: 'ok', posture: postureFromFacts(read.facts) };
}

export async function readStandInPosture(record: InstanceConfig, timeoutMs?: number): Promise<StandInRead> {
  if (!hasAppHooks(record)) return { read: 'none' };
  const { instance, unanswered } = await containerManager.withServingStatus(record);
  if (unanswered) return { read: 'unanswered', error: 'could not confirm whether the instance runs: docker did not answer' };
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
 * Deliver when what the app holds is not the whole current block: a promoted
 * node inherits the OLD master's block, and a re-enable or a rescue can change
 * the credential or the certificate behind an unchanged host and port.
 */
export async function ensureCopyBlockCurrent(
  instance: InstanceConfig,
  held: { dsn: string; cert: string } | null,
): Promise<ActionResult & { delivered: boolean }> {
  if (!instance.fleetDb?.replication) return { success: true, delivered: false };
  const block = await getReplicaCopyBlock(instance);
  if (!block.success || !block.dsn || !block.cert) {
    return { success: false, delivered: false, error: block.error || 'could not assemble the copy block' };
  }
  if (held && held.dsn === block.dsn && String(held.cert ?? '').trim() === block.cert.trim()) {
    return { success: true, delivered: false };
  }
  const published = await publishCopyBlock(instance, { dsn: block.dsn, cert: block.cert });
  return { ...published, delivered: published.success };
}

const COPY_BLOCK_FACTS_TIMEOUT_MS = 10_000;
const REGISTRATION_NOTE = 'a designated backup that is already registered receives it only at its next registration (a restart of either bot)';
const PANEL_RETRY = 'opening the Replication section publishes it once the bot answers as the fleet\'s master';

/**
 * Hand the block to this node's app only when the app says it is the node that
 * relays it: a block published onto any other node would overwrite the one its
 * master relayed. The note says what happened, for the operator's reply.
 */
export async function deliverCopyBlockToTarget(instance: InstanceConfig): Promise<{ delivered: boolean; note: string; error?: string }> {
  if (!instance.fleetDb?.replication) return { delivered: false, note: 'Replication is not enabled on this instance, so no copy block was handed to the bot.' };
  if (!hasAppHooks(instance)) return { delivered: false, note: 'This app declares no lifecycle hooks, so its bot relays no copy block; set standbys up from the block in the Replication section.' };
  if (instance.status !== 'running') return { delivered: false, note: `The copy block was not handed to the bot because the instance is not running; ${PANEL_RETRY}.` };
  const read = await getAppFacts(instance, COPY_BLOCK_FACTS_TIMEOUT_MS);
  if (!read.success) return { delivered: false, note: `Can't confirm the bot is the fleet's master (${read.error}), so the copy block was not handed to it; ${PANEL_RETRY}.` };
  if (read.facts?.copyBlockTarget !== true) return { delivered: false, note: `The bot is not the fleet's master, so the copy block was not handed to it (only the master relays one); ${PANEL_RETRY}.` };
  const delivered = await deliverCopyBlock(instance);
  if (!delivered.success) return { delivered: false, note: '', error: delivered.error || 'the app refused' };
  return { delivered: true, note: `The bot holds the current copy block; ${REGISTRATION_NOTE}.` };
}

/**
 * Enable and Disable by the operator: a node behind a stand-in follows the
 * fleet's database on another node, so its own database is not the fleet's and
 * a failback run owns its replication posture.
 */
export async function followerHoldRefusal(instance: InstanceConfig, action: string): Promise<string | null> {
  if (instance.fleetFailback) return `A failback run is recorded on this instance; ${action} is refused until it finishes or is cancelled (nothing was changed)`;
  if (!hasAppHooks(instance)) return null;
  const read = await getAppFacts(instance, COPY_BLOCK_FACTS_TIMEOUT_MS);
  const unread = !read.success ? read.error || 'no answer' : read.facts?.running !== true ? 'the bot process is not running' : null;
  if (unread) return `Can't confirm this node's bot holds no follower hold (${unread}), so ${action} is refused; ${unansweredRemedy(unread)} then try again (nothing was changed)`;
  if (read.facts?.followerHold) return `This node's bot is in a follower hold behind the node holding the fleet, so this database is not the fleet's; ${action} is refused until the failback promotes this node back (nothing was changed)`;
  return null;
}

function blockEndpoint(dsn: string): { host: string; port: number } | null {
  try {
    const url = new URL(dsn);
    return url.hostname ? { host: url.hostname, port: Number(url.port) || 5432 } : null;
  } catch {
    return null;
  }
}

/**
 * Send a recorded retraction once the bot answers. Only a held block naming the
 * recorded endpoint is cleared; any other block was relayed by another master.
 * A replication posture on that endpoint again owns the block, so the record is
 * dropped unsent. Returns whether the retraction is still pending, and why.
 */
export async function settleCopyBlockRetract(botId: string): Promise<{ pending: boolean; reason?: string }> {
  const instance = containerManager.getBot(botId);
  const pending = instance?.copyBlockRetract;
  if (!instance || !pending) return { pending: false };
  const same = (): boolean => JSON.stringify(containerManager.getBot(botId)?.copyBlockRetract) === JSON.stringify(pending);
  const drop = (): { pending: boolean; reason?: string } => {
    try {
      if (same()) containerManager.updateInstanceCopyBlockRetract(botId, null);
      return { pending: false };
    } catch (err) {
      return { pending: true, reason: `the record could not be saved: ${err instanceof Error ? err.message : String(err)}` };
    }
  };
  const ownsEndpoint = (inst: InstanceConfig | null | undefined): boolean => {
    const repl = inst?.fleetDb?.replication;
    return !!repl && repl.publicHost === pending.host && repl.hostPort === pending.port;
  };
  if (ownsEndpoint(instance)) return drop();
  if (!hasAppHooks(instance)) return drop();
  if (containerManager.isBotBusy(botId)) return { pending: true, reason: 'a lifecycle operation is running on this instance' };
  const read = await getAppFacts(instance, COPY_BLOCK_FACTS_TIMEOUT_MS);
  if (!read.success) return { pending: true, reason: read.error };
  const now = containerManager.getBot(botId);
  if (!same()) return { pending: !!now?.copyBlockRetract };
  if (ownsEndpoint(now)) return drop();
  const held = read.facts?.copyBlock;
  const at = held?.dsn ? blockEndpoint(held.dsn) : null;
  if (!at || at.host !== pending.host || at.port !== pending.port) return drop();
  const cleared = fromHook(await callAppHook(instance, 'copy-block', 'POST', { clear: true }));
  if (!cleared.success) return { pending: true, reason: cleared.unknown ? `can't confirm the bot dropped it: ${cleared.error}` : cleared.error };
  return drop();
}

/**
 * After a Disable or a decommission: record the retraction first, so a bot
 * that does not answer now still receives it, then try to send it. Returns the
 * operator's note.
 */
export async function retractCopyBlockOf(botId: string, endpoint: { host: string; port: number }): Promise<string> {
  try {
    containerManager.updateInstanceCopyBlockRetract(botId, { host: endpoint.host, port: endpoint.port, since: new Date().toISOString() });
  } catch (err) {
    return `Can't confirm the bot dropped this database's copy block: the retraction could not be recorded (${err instanceof Error ? err.message : String(err)}).`;
  }
  const settled = await settleCopyBlockRetract(botId).catch(err => ({ pending: true, reason: err instanceof Error ? err.message : String(err) }));
  const backups = 'Backups that received the block earlier keep their copy.';
  if (!settled.pending) return `The bot no longer holds a copy block for this database. ${backups}`;
  return `The bot may still hold this database's copy block (${settled.reason}); the manager sends it the retraction once the bot answers, at its next start or when its Database modal is opened. ${backups}`;
}

/**
 * Give this node's app the copy block for the database it hosts, so it can relay
 * it to designated backups on register (20.14). Only the manager can produce it:
 * the replicator password and the server certificate live in the sidecar it owns.
 * Safe to call repeatedly - the app just overwrites its copy.
 */
export async function deliverCopyBlock(instance: InstanceConfig): Promise<ActionResult> {
  if (!instance.fleetDb?.replication) return { success: false, error: 'replication is not enabled on this instance' };
  const block = await getReplicaCopyBlock(instance);
  if (!block.success || !block.dsn || !block.cert) {
    return { success: false, error: block.error || 'could not assemble the copy block' };
  }
  return publishCopyBlock(instance, { dsn: block.dsn, cert: block.cert });
}

/** Hand this node's app a copy block to relay; the app overwrites what it held. */
export async function publishCopyBlock(instance: InstanceConfig, block: { dsn: string; cert: string }): Promise<ActionResult> {
  if (!hasAppHooks(instance)) return { success: false, error: 'this app declares no lifecycle hooks' };
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
  opts: { confirmLag?: boolean; confirmLineage?: boolean; confirmReachability?: boolean; retireOldMaster?: boolean } = {},
): Promise<ActionResult> {
  const refusal = capabilityRefusal(instance);
  if (refusal) return { success: false, error: refusal };
  return fromHook(await callAppHook(instance, 'promote', 'POST', {
    confirmLag: opts.confirmLag === true,
    confirmLineage: opts.confirmLineage === true,
    confirmReachability: opts.confirmReachability === true,
    retireOldMaster: opts.retireOldMaster === true,
  }));
}

/** Demote this master (the 20.12a freeze warning rides needsConfirm). */
export async function demote(instance: InstanceConfig, confirm: boolean): Promise<ActionResult> {
  return fromHook(await callAppHook(instance, 'demote', 'POST', { confirm }));
}

/**
 * Return the app to its configured role and store: the recovery channel's swap
 * moves the primary by infrastructure means, so the role override and the
 * store forms the app's own files last recorded would otherwise boot it as
 * what it was before (a demoted co-worker on the receiver, a master on the
 * source). restart false leaves the child alone for a caller about to stop it.
 */
export async function resetRole(instance: InstanceConfig, restart: boolean): Promise<ActionResult> {
  return fromHook(await callAppHook(instance, 'role-reset', 'POST', { restart }));
}

/**
 * A container that just started serves its hooks only once its web server
 * listens; callers that start it and then need it wait here, bounded.
 */
export async function waitForAppHook(instance: InstanceConfig, deadlineMs: number): Promise<ActionResult> {
  const deadline = Date.now() + deadlineMs;
  let last = 'no answer yet';
  for (;;) {
    const facts = await getAppFacts(instance, 5_000);
    if (facts.success) return { success: true };
    last = facts.error || last;
    if (Date.now() >= deadline) {
      return { success: false, error: `the app did not answer its hooks within ${Math.round(deadlineMs / 1000)} s (${last})` };
    }
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
}
