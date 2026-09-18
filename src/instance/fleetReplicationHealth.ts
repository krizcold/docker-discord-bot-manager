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
import { getFleetReplicaStatus, seedPurposeLabel, AUTO_RESEED_MAX_ATTEMPTS } from './fleetReplica';
import { FactsRead, getAppFacts, postureFromRead, StandInPosture, unansweredRemedy } from './appLifecycle';
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
  /** Whether the primary this copy follows is the fleet's master; false is the survivor case (20.19 F5). */
  sourceIsCurrentMaster: boolean;
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
  /** The app's explicit stand-in posture (20.5, B6 map F34); absent or null when none. */
  standIn?: StandInPosture | null;
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

/** A node id as the fleet's own UI abbreviates it; the manager knows no node names. */
function shortId(id: string | null): string {
  return id ? id.slice(0, 8) : 'an unknown node';
}

/** The node a covered copy follows; the hold may not have read whose copy it holds yet. */
function standInWho(id: string | null): string {
  return id ? shortId(id) : 'the node holding the fleet';
}

function sinceText(ms: number | null): string {
  return ms ? ` since ${new Date(ms).toISOString().slice(11, 16)} UTC` : '';
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
  // The app's own word outranks every slot reading (B6 map F34, E13): while
  // this master is parked behind a stand-in that took the fleet's writes, the
  // copy going stale is THIS one, whatever its inactive slots say.
  const posture = postureFromRead(instance, await readFacts(instance));
  const standing = posture.read === 'ok' ? posture.posture : null;
  if (standing?.role === 'covered') {
    const who = standInWho(standing.standInNodeId);
    // The failback is over once the node this bot followed stops naming it (a
    // hand promote, or its lane ended): the promote route is closed then.
    if (standing.namesThisNode === false) {
      return { ...base, standIn: standing, severity: 'error', message: `This node's bot followed ${standing.standInNodeId ? `its stand-in ${who}` : 'the node that was holding the fleet'}, which no longer stands in for it (promoted by hand, or its lane ended), so there is no failback to run; ${standing.holdReason === 'copy' ? 'this database is a copy of that node\'s' : 'this database is the copy that is behind'}. Demote this node from its Fleet tab to stay a co-worker, or set BOT_NODE_ROLE=backup-master on this node and restart it to make it a designated backup`, lagSeconds: null };
    }
    if (standing.namesThisNode !== true) {
      return { ...base, standIn: standing, severity: 'error', message: `This node's bot has not registered with the node holding the fleet yet, so the failback cannot start (${standing.holdReason === 'copy' ? 'this database is a copy of that node\'s' : 'this database is the copy that is behind'}); the failback needs that node reachable${standing.holdReason === 'behind' ? '. If that node is gone for good, FLEET_CONFIRM_TAKEOVER=1 in this instance\'s env plus a restart seizes the fleet back onto this database, losing what that node accepted during the outage' : ''}`, lagSeconds: null };
    }
    if (standing.followsDelivered === false) {
      return { ...base, standIn: standing, severity: 'error', message: `This node's bot is registered with the node holding the fleet, but the database it delivered is not installed here yet (not dialable from this machine, or its identity did not verify), so the failback cannot start; the node's own Fleet tab hold notice says so (${standing.holdReason === 'copy' ? 'this database is a copy of that node\'s' : 'this database is the copy that is behind'}); or promote that node by hand${standing.holdReason === 'behind' ? '. Stop this instance, then paste that node\'s copy block (on its Database modal) under "Failed over to another machine?" to re-seed this machine as its standby. If that node is gone for good, FLEET_CONFIRM_TAKEOVER=1 in this instance\'s env plus a restart seizes the fleet back onto this database, losing what that node accepted during the outage' : ''}`, lagSeconds: null };
    }
    return { ...base, standIn: standing, severity: 'error', message: standing.holdReason === 'copy'
      ? `This node's database is a copy in recovery of ${who}'s, and its bot follows that node as a co-worker; promote this node from its Fleet tab once the copy has caught up to take the fleet back, or promote that node by hand`
      : `This node's bot follows its stand-in ${who} as a co-worker: that node took the fleet's writes${sinceText(standing.since)} while this node was down, so this database is the copy that is behind. Stop this instance, then paste that node's copy block (on its Database modal) under "Failed over to another machine?" to re-seed this machine as its standby, start it, and promote it from its Fleet tab once the copy has caught up; or promote that node by hand. If that node is gone for good, FLEET_CONFIRM_TAKEOVER=1 in this instance's env plus a restart seizes the fleet back onto this database, losing what that node accepted during the outage`, lagSeconds: null };
  }
  const verdict = primaryLinkVerdict(status, base);
  // A node that is both sides (a standby beside its own primary, 20.19 F7)
  // is sampled as a primary; its standby's posture still rides the verdict so
  // the automatic re-seed's skip can read it.
  return standing && instance.fleetDbReplica ? { ...verdict, standIn: standing } : verdict;
}

function primaryLinkVerdict(status: Awaited<ReturnType<typeof getFleetReplicationStatus>>, base: { role: 'primary'; checkedAt: number }): ReplicationHealth {
  if (!status.live) {
    return { ...base, severity: 'warn', message: 'Database container is not running, so nothing is being replicated', lagSeconds: null };
  }
  if (!status.live.sslOn) {
    return { ...base, severity: 'warn', message: 'TLS is not active on the database yet; restart the instance to finish enabling replication', lagSeconds: null };
  }
  // An invalidated slot outranks everything below: its standby can never
  // resume from it, so the streaming picture is already lost (RC-1).
  const fleetSlots = (status.live.slots || []).filter(s => s.fleet);
  // Retention is a property of the SLOT, not of what follows it: a slot this
  // manager did not mint fills the same bound, so all of them are weighed and
  // only the remedy differs.
  const allSlots = status.live.slots || [];
  const lost = allSlots.find(s => s.walStatus === 'lost');
  if (lost) {
    const remedy = lost.fleet ? 'its standby cannot resume and must be re-seeded from the copy block' : 'whatever was following it must start over';
    return { ...base, severity: 'error', message: `Replication slot ${lost.slot} was invalidated (retained WAL passed the bound); ${remedy}`, lagSeconds: null };
  }
  // 'unreserved' = past the bound but not yet dropped; the standby can still
  // make it if it reconnects before the next checkpoint takes the WAL.
  const unreserved = allSlots.find(s => s.walStatus === 'unreserved');
  if (unreserved) {
    const remedy = unreserved.fleet ? 'reconnect its standby now or plan a re-seed' : 'finish or stop whatever is following it now';
    return { ...base, severity: 'error', message: `Replication slot ${unreserved.slot} is past the WAL retention bound and about to be invalidated; ${remedy}`, lagSeconds: null };
  }
  const bound = sizeSettingBytes(status.live.slotWalKeep);
  const fattest = allSlots.reduce<{ slot: string; fleet: boolean; retainedBytes: number } | null>((max, s) =>
    s.retainedBytes !== null && (max === null || s.retainedBytes > max.retainedBytes) ? { slot: s.slot, fleet: s.fleet, retainedBytes: s.retainedBytes } : max, null);
  const retentionWarn = bound !== null && fattest !== null && fattest.retainedBytes > bound / 2
    ? `Replication slot ${fattest.slot} retains ${mb(fattest.retainedBytes)} MB of WAL (bound ${mb(bound)} MB); past the bound the slot invalidates${fattest.fleet ? ' and its standby must be re-seeded' : ''}`
    : null;
  // Every standby that ever seeded left its slot, so the slots ARE the
  // standbys: none means unprotected, an inactive one means a standby that
  // stopped streaming (the copy behind it goes stale), and a streaming link
  // is read off the slot it holds.
  if (fleetSlots.length === 0) {
    return { ...base, severity: 'warn', message: retentionWarn ?? 'No standby is attached: this machine dying would take the fleet database with it', lagSeconds: null };
  }
  const silent = fleetSlots.find(s => !s.active || s.state !== 'streaming');
  if (silent) {
    const streaming = fleetSlots.filter(s => s.active && s.state === 'streaming').length;
    const how = !silent.active ? 'not connected' : `${silent.state || 'not streaming'} rather than streaming`;
    return { ...base, severity: 'error', message: `Standby on slot ${silent.slot} is ${how} (${streaming} of ${fleetSlots.length} streaming); its copy is going stale`, lagSeconds: null };
  }
  if (retentionWarn) {
    return { ...base, severity: 'warn', message: retentionWarn, lagSeconds: null };
  }
  const worst = fleetSlots.reduce<number | null>((max, s) =>
    s.replayLagSeconds !== null && (max === null || s.replayLagSeconds > max) ? s.replayLagSeconds : max, null);
  if (worst !== null && worst > LAG_WARN_SECONDS) {
    return { ...base, severity: 'warn', message: `A standby is ${Math.round(worst)}s behind; a failover to it now would lose that much`, lagSeconds: round(worst) };
  }
  return { ...base, severity: 'ok', message: `Streaming to ${fleetSlots.length} standby${fleetSlots.length === 1 ? '' : 's'}`, lagSeconds: round(worst) };
}

/**
 * The slot fact the app recorded, or null for every way it can be unknown: a
 * stopped or hookless app, an unreachable hook, no record yet, a stale record,
 * or a record about a master this copy does not follow. Unknown never widens a
 * verdict (the 2a lesson): the caller treats null exactly like "no fact".
 */
/** One facts read per sample: the slot fact and the stand-in posture come from the SAME answer, so they cannot disagree. */
async function readFacts(instance: InstanceConfig): Promise<FactsRead | null> {
  if (instance.status !== 'running' || !hasAppHooks(instance)) return null;
  return getAppFacts(instance, FACTS_TIMEOUT_MS);
}

function readSlotFact(instance: InstanceConfig, result: FactsRead | null): StandbySlotFact | null {
  if (!result || !result.success) return null;
  const facts = result.facts;
  const fact = facts?.standbySlot;
  if (!fact || typeof fact.slotName !== 'string' || fact.slotName === '' || typeof fact.walStatus !== 'string' || fact.walStatus === '') return null;
  // A fact about another slot (a record re-provisioned under a new name, an
  // older record) is unknown, never a verdict on this copy.
  if (instance.fleetDbReplica && fact.slotName !== instance.fleetDbReplica.slot) return null;
  // Unknown stays unknown; only a decided verdict is carried, and a fact from a
  // master this copy no longer follows is news about the FLEET (20.19 F5), not
  // a verdict on the slot, so the lost verdict is forced false there.
  if (fact.sourceIsCurrentMaster !== true && fact.sourceIsCurrentMaster !== false) return null;
  if (!Number.isFinite(fact.receivedAt) || Date.now() - Number(fact.receivedAt) > SLOT_FACT_FRESH_MS) return null;
  // The survivor verdict is only as fresh as the copy's own last READING of
  // its source, which a rebuilt copy does not repeat at once: a fact whose
  // source was read before this copy was built names the primary the REPLACED
  // copy followed, and would call the new one a former master. Scoped to that
  // verdict: a stale source cannot manufacture a 'current' one, and the lost
  // verdict is the primary's own word rather than a reading of the source.
  const seededAt = instance.fleetDbReplica?.seededAt ?? 0;
  if (fact.sourceIsCurrentMaster === false && Number(fact.sourceAt) <= seededAt) return null;
  const current = fact.sourceIsCurrentMaster === true;
  return {
    slotName: fact.slotName,
    walStatus: fact.walStatus,
    observedAt: Number(fact.observedAt) || 0,
    lost: current && facts?.standbySlotLost === true,
    sourceIsCurrentMaster: current,
  };
}

async function sampleReplica(instance: InstanceConfig): Promise<ReplicationHealth> {
  const status = await getFleetReplicaStatus(instance);
  const read = await readFacts(instance);
  const relayed = readSlotFact(instance, read);
  // A receiver that streams contradicts "lost" or "absent" (a walsender refuses
  // both), which marks a record from before a re-seed: it reads as unknown,
  // never as a verdict on the copy that replaced it. One reading is not enough:
  // against a lost slot the walreceiver shows "streaming" for the length of a
  // handshake on every 5 s retry, so two ticks a minute apart must agree.
  const streamingNow = status.live?.receiverStatus === 'streaming';
  const streamingTwice = streamingNow && streamingSeen.get(instance.id) === true;
  streamingSeen.set(instance.id, streamingNow);
  // Only a fact from the primary this copy actually follows can be
  // contradicted by its receiver: a walsender refuses both verdicts. A
  // survivor's fact comes from a DIFFERENT machine, and 'absent' is its
  // signature there (the new master has no slot of that name), not a
  // contradiction, so it must reach the survivor verdict below (20.19 F5).
  const contradicted = relayed !== null && relayed.sourceIsCurrentMaster && streamingTwice
    && (relayed.walStatus === 'lost' || relayed.walStatus === 'absent');
  const slot = contradicted ? null : relayed;
  const base = { role: 'replica' as const, checkedAt: Date.now(), slot };
  // A stand-in whose container is down or whose app has gone silent keeps its
  // last word on the badge, and the automatic re-seed keeps skipping it: the
  // fact is not gone, it is unreadable, and that is not the same claim.
  const last = cache.get(instance.id)?.standIn;
  const remembered = last?.role === 'stand-in' ? last : null;
  if (status.provisioning) {
    return { ...base, severity: 'ok', message: `Provisioning (${status.provisioning.phase})`, lagSeconds: null };
  }
  if (status.parkedSeed) {
    return { ...base, severity: 'error', message: `${seedPurposeLabel(status.parkedSeed.purpose)} stopped during ${status.parkedSeed.phase}: ${status.parkedSeed.lastError}`, lagSeconds: null };
  }
  const live = status.live;
  // live ABSENT means the status could not even be probed (e.g. a record
  // stamped before the identity fields), which is a different claim than a
  // stopped container; say the real reason.
  const lastSeen = remembered ? `; it was standing in for ${shortId(remembered.coveringNodeId)} when last seen` : '';
  if (!live) {
    return { ...base, ...(remembered ? { standIn: remembered } : {}), severity: 'error', message: `${status.lastError || 'Standby state could not be read'}${lastSeen}`, lagSeconds: null };
  }
  if (!live.running) {
    return { ...base, ...(remembered ? { standIn: remembered } : {}), severity: 'error', message: `Standby container is not running, so it is no longer receiving changes${lastSeen}`, lagSeconds: null };
  }
  // The app's explicit posture (B6 map F34): a copy standing in for a dead
  // master is read from that fact alone, never from its recovery state, which
  // cannot tell a stand-in from a promotion.
  const posture = postureFromRead(instance, read);
  const standing = posture.read === 'ok' ? posture.posture : null;
  // An ended lane counts only while its promoted copy is still here.
  if (standing?.role === 'stand-in' && (standing.live || live.inRecovery === false)) {
    const who = shortId(standing.coveringNodeId);
    if (!standing.live) {
      return { ...base, standIn: standing, severity: 'error', message: `This copy took the fleet's writes as a stand-in for ${who} and the lane ended (${standing.disarmReason ?? 'no reason recorded'}); those writes may exist only here. Promote this node by hand to keep them (its own web UI), then adopt; to discard them, remove the replica and provision it again`, lagSeconds: null };
    }
    if (standing.holdsWrites) {
      return { ...base, standIn: standing, severity: 'warn', message: `Standing in for ${who} and holding the fleet's writes${sinceText(standing.since)} (a partial takeover): this copy is the fleet database until the failback or a manual promote, and is neither adopted nor re-seeded while it stands in`, lagSeconds: null };
    }
    if (live.inRecovery === false) {
      return { ...base, standIn: standing, severity: 'warn', message: `Standing in for ${who}: taking the fleet's writes now (the copy has been promoted and the bot is restarting onto it)`, lagSeconds: null };
    }
    const dark = live.receiverStatus === 'streaming' ? '' : '; its primary is gone, so this copy is not streaming';
    return { ...base, standIn: standing, severity: 'warn', message: `Standing in for ${who} read-only (a partial takeover)${dark}; writes are taken automatically once the hold expires, if this copy was provably in sync`, lagSeconds: round(live.replayLagSeconds) };
  }
  // The returning master's own copy, re-seeded for the failback (B6 map F28):
  // its bot follows the stand-in as a co-worker, and this copy is the one the
  // failback promotes, so it is neither adopted nor re-seeded from here.
  if (standing?.role === 'covered' && live.inRecovery !== false) {
    const dark = live.receiverStatus === 'streaming' ? '' : ' (not streaming right now)';
    // A slot fact from a master this copy does not follow is news about the
    // fleet (20.19 F5), not a verdict on the slot: the copy protects a
    // database the fleet has left, and no remedy that names "that node's copy
    // block" applies to it.
    const foreign = slot !== null && !slot.sourceIsCurrentMaster;
    const broken = slot !== null && slot.sourceIsCurrentMaster && (slot.lost || slot.walStatus === 'absent');
    const unreserved = slot !== null && slot.sourceIsCurrentMaster && slot.walStatus === 'unreserved';
    const holderDb = standing.standInNodeId ? `its stand-in ${shortId(standing.standInNodeId)}'s` : 'the node holding the fleet\'s';
    return { ...base, standIn: standing, severity: 'warn', message: standing.namesThisNode === false
      ? `This is the returning master's copy of ${standInWho(standing.standInNodeId)}'s database${dark}, but that node no longer stands in for it (promoted by hand, or its lane ended), so there is no failback to run${foreign ? '; it follows a database that is no longer the fleet\'s' : broken ? `; the primary reports its slot as ${slot?.lost ? 'lost' : 'absent'}, so remove the replica and provision it again from that node's copy block` : unreserved ? '; the primary reports its slot past the WAL retention bound and about to be invalidated, so get this copy streaming again now' : ''}${foreign ? '; demote the node from its Fleet tab to stay a co-worker, then Re-seed now repoints this copy at the current primary; to make it a designated backup instead, re-seed it first, then set BOT_NODE_ROLE=backup-master on this node and restart it' : '; demote the node from its Fleet tab to stay a co-worker, or set BOT_NODE_ROLE=backup-master on this node and restart it to make it a designated backup'}`
      : standing.namesThisNode !== true
      ? `This is the returning master's copy, re-seeded for the failback, but its bot is not registered with the node holding the fleet yet${dark}; the failback needs that node reachable, and this copy is neither adopted nor re-seeded meanwhile`
      : standing.followsDelivered === false
      ? `This is the returning master's copy, re-seeded for the failback${dark}; its bot is registered with the node holding the fleet, but the database it delivered is not installed here yet (not dialable from this machine, or its identity did not verify), so the failback cannot start; the node's own Fleet tab hold notice says so`
      : foreign
      ? `This is the returning master's copy, but it follows a database other than ${holderDb} (the node holding the fleet reports no slot of its own for it), so the failback cannot promote it; remove the replica and provision it again from the copy block on that node's Database modal`
      : unreserved
      ? `This is the returning master's copy of ${holderDb} database, but the primary reports its slot past the WAL retention bound and about to be invalidated; get this copy streaming again now, because a lost slot means removing and re-provisioning it`
      : broken
      ? `This is the returning master's copy of ${holderDb} database, but the primary reports its slot as ${slot?.lost ? 'lost' : 'absent'}, so the failback's catch-up cannot finish; remove the replica and provision it again from the copy block on that node's Database modal (Re-seed now stays unavailable while this node holds)`
      : `This is the returning master's copy of ${holderDb} database${dark}; promote this node from its Fleet tab once it has caught up to take the fleet back`, lagSeconds: round(live.replayLagSeconds) };
  }
  if (live.inRecovery === false) {
    if (posture.read === 'unanswered') {
      return { ...base, ...(remembered ? { standIn: remembered } : {}), severity: 'error', message: `This copy has left recovery and its app is not answering (${posture.error}), so the manager cannot tell a stand-in from a promotion${remembered ? ` (it was standing in for ${shortId(remembered.coveringNodeId)} when last seen)` : ''}; ${unansweredRemedy(posture.error)} before adopting or re-seeding it`, lagSeconds: null };
    }
    return { ...base, severity: 'error', message: 'This copy has been promoted and no longer follows the primary; adopt it as the database of this machine, or re-provision it', lagSeconds: null };
  }
  // F35: a peer's wording is driven by the stand-in fact, not by the survivor
  // verdict below, which would invite a re-seed off a temporary primary.
  if (standing?.role === 'peer') {
    const dark = live.receiverStatus === 'streaming' ? '' : ' (its primary is down, so it is not streaming meanwhile)';
    return { ...base, standIn: standing, severity: 'warn', message: `The fleet is being served by a stand-in for ${shortId(standing.coveringNodeId)}, whose database this copy follows; this copy keeps its place for the failback and is not re-seeded until that settles${dark}`, lagSeconds: round(live.replayLagSeconds) };
  }
  // 20.19 F5: the fleet moved on and this copy still follows the machine it was
  // seeded from. Nothing about it is broken, but it protects a database the
  // fleet has left, and no verdict below is about the database it follows: only
  // the current master pushes the slot table, and it reads its OWN database,
  // where this copy has no slot at all.
  if (slot && !slot.sourceIsCurrentMaster) {
    const from = instance.fleetDbReplica ? `${instance.fleetDbReplica.primaryHost}:${instance.fleetDbReplica.primaryPort}` : 'its source';
    return { ...base, severity: 'warn', message: `This copy follows ${from}, which is no longer the fleet's master, so it protects a database the fleet has left; Re-seed now repoints it at the current primary`, lagSeconds: round(live.replayLagSeconds) };
  }
  // The primary's own word outranks the receiver's silence (20.17): a lost
  // slot can never be resumed, whereas "not streaming" alone cannot tell a
  // lost slot from a primary that is merely offline.
  if (slot?.lost) {
    const ledger = status.autoReseed;
    const who = ledger?.trigger === 'operator' ? 'the last manual re-seed' : 'the automatic re-seed';
    const auto = ledger?.lastError
      ? `; ${who} ${ledger.attempts >= AUTO_RESEED_MAX_ATTEMPTS ? `stopped after ${ledger.attempts} attempts` : `failed (attempt ${ledger.attempts})`}: ${ledger.lastError}`
      : '; the manager re-seeds it automatically from the copy block the bot holds';
    return { ...base, severity: 'error', message: `The primary reports replication slot ${slot.slotName} as lost (its retained WAL passed the bound); this copy can never catch up${auto}`, lagSeconds: null };
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
    // A seed has no standby record for two of its three purposes, so it would
    // fall through the role gate unreported. A LIVE primary still outranks it;
    // a stopped one is not making a live claim, and only the replica sample
    // can report the seed at all.
    const seeding = !!instance.fleetDbReplicaSeed;
    const isPrimary = !!instance.fleetDb?.replication && !(seeding && instance.status !== 'running');
    const isReplica = !!instance.fleetDbReplica || seeding;
    if (!isPrimary && !isReplica) continue;
    live.add(instance.id);
    // A stopped PRIMARY instance is an operator decision, not a broken link
    // (compose down takes its sidecar with it): report the role without a
    // warning rather than crying wolf. A REPLICA outlives its instance (it is
    // provisioned before the first start and only compose down removes it), so
    // its standby is sampled regardless - a dead standby must never hide
    // behind a stopped instance (drill R-5, finding F2).
    if (isPrimary && instance.status !== 'running') {
      // A primary stopped while parked behind a stand-in (20.5) keeps that
      // word: stopping is the first step of the re-seed its verdict asks for,
      // and the form for that re-seed only renders on a stopped instance.
      const covered = cache.get(instance.id)?.standIn;
      cache.set(instance.id, covered?.role === 'covered'
        ? { role: 'primary', severity: 'warn', message: covered.namesThisNode === false
          ? `Instance is stopped; its bot followed ${covered.standInNodeId ? `its stand-in ${shortId(covered.standInNodeId)}` : 'the node that was holding the fleet'}, which no longer stands in for it, so there is no failback to run and this database is the copy that is behind: re-seed it as a standby of that node from the block on its Database modal, then start it and demote it from its Fleet tab to stay a co-worker`
          : covered.namesThisNode === true && covered.followsDelivered === false
          ? `Instance is stopped; its bot was registered with the node holding the fleet, but the database it delivered was not installed here, so this database is the copy that is behind: re-seed it as a standby of that node from the block on its Database modal`
          : covered.namesThisNode === null
          ? `Instance is stopped; its bot had not registered with the node holding the fleet yet, so this database is the copy that is behind: re-seed it as a standby of that node from the block on its Database modal, then start it and promote it from its Fleet tab once the copy has caught up`
          : `Instance is stopped; its bot was following ${covered.standInNodeId ? `its stand-in ${shortId(covered.standInNodeId)}` : 'the node holding the fleet'}, so this database is the copy that is behind: re-seed it as a standby of that node from the block on its Database modal, then start it and promote it from its Fleet tab once the copy has caught up`, lagSeconds: null, checkedAt: Date.now(), standIn: covered }
        : { role: 'primary', severity: 'ok', message: 'Instance is stopped', lagSeconds: null, checkedAt: Date.now() });
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

let ticking = false;
/** A tick that outlives the interval (facts reads are bounded, but many add up) must not overlap itself: the two-tick streaming rule reads consecutive samples. */
async function guardedTick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try { await runTick(); } finally { ticking = false; }
}

export function startFleetReplicationHealth(): void {
  if (intervalHandle) return;
  console.log(`[FleetReplication] Health sampler started (tick: ${TICK_INTERVAL_MS / 1000}s)`);
  void guardedTick().catch(err => console.error('[FleetReplication] Health tick error:', err));
  intervalHandle = setInterval(() => {
    guardedTick().catch(err => console.error('[FleetReplication] Health tick error:', err));
  }, TICK_INTERVAL_MS);
}

export function stopFleetReplicationHealth(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[FleetReplication] Health sampler stopped');
  }
}
