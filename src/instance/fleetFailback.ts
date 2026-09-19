/**
 * The failback run (PLAN_REPLICATION 20.5; B6 map B6-i, F5 RULED 2026-09-18,
 * F29, F31, F32). Two runs share one record:
 *
 * - failback, on the RETURNING master's manager. Its bot holds behind the
 *   stand-in that took the fleet's writes (posture 'covered', the stand-in
 *   still naming this node). The run waits for the stand-in's copy block to
 *   reach the bot, stops the instance, dumps the database, then PARKS with
 *   both positions and the dump's outcome named and asks (F5): the wipe never
 *   runs without the operator's Continue. It then re-seeds this machine from
 *   the block, starts the instance (the bot holds on the copy), waits for the
 *   copy to catch up, asks the bot for its promote (the zero-loss transfer
 *   through the stand-in's database, relaying the retire instruction), adopts
 *   the promoted copy with the replication credential carried across (F30)
 *   and restarts the instance.
 * - drop-back, on the STAND-IN's manager. Its bot recorded the retire
 *   instruction the failback promote relayed and its promoted copy is an ended
 *   lane. The run parks before re-seeding that copy as a standby of the new
 *   master and asks (F32 under F5).
 *
 * Every phase decides from the instance record and the bot's own facts, so a
 * parked run resumes at its phase; a manager restart parks a live run. The
 * manager reads explicit facts and sequences docker; the bot decides.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../docker/containerManager';
import * as fleetBackup from './fleetBackup';
import * as fleetReplica from './fleetReplica';
import { enableFleetReplication } from './fleetReplication';
import { ActionResult, AppFacts, deliverCopyBlock, getAppFacts, postureFromRead, StandInPosture, transfer as promoteSide, unansweredRemedy } from './appLifecycle';
import { hasAppHooks } from './appHookClient';
import { FleetDbReplicaRecord, FleetFailbackDecline, FleetFailbackMode, FleetFailbackPhase, FleetFailbackRun, FleetLineageFact, InstanceConfig } from '../types';

const POLL_MS = 3_000;
const FACTS_TIMEOUT_MS = 10_000;
/** How long the run waits for the block and the registration before parking with what is missing. */
const BLOCK_WAIT_MS = 5 * 60_000;
/** Once the block is in hand, how long a null lineage verdict is waited for before unknown is accepted. */
const LINEAGE_WAIT_MS = 90_000;
/** The copy hold waits for its own database to answer, so its boot can be long. */
const HOLD_BOOT_WAIT_MS = 10 * 60_000;
const CATCHUP_WAIT_MS = 10 * 60_000;
const PROMOTE_WAIT_MS = 10 * 60_000;
const RESTART_WAIT_MS = 5 * 60_000;
/** A reconnecting walreceiver empties pg_stat_wal_receiver, so a gap this short is not a silent primary. */
const NOT_STREAMING_GRACE_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function currentRun(botId: string): FleetFailbackRun | null {
  return containerManager.getBot(botId)?.fleetFailback ?? null;
}

function saveRun(botId: string, patch: Partial<FleetFailbackRun>): void {
  const current = currentRun(botId);
  if (!current) return;
  containerManager.updateInstanceFleetFailback(botId, { ...current, ...patch, updatedAt: Date.now() });
  containerManager.broadcastBotUpdated(botId);
}

function clearRun(botId: string): void {
  containerManager.updateInstanceFleetFailback(botId, null);
  containerManager.broadcastBotUpdated(botId);
}

/** Cancel and Dismiss remember the decline on the instance: the tick opens runs from the facts alone and must not reopen what the operator closed. */
function declineRun(botId: string, run: FleetFailbackRun): void {
  containerManager.updateInstanceFleetFailbackDeclined(botId, { mode: run.mode, at: Date.now(), standInNodeId: run.standInNodeId, episode: typeof run.episode === 'number' ? run.episode : null, phase: run.phase });
  clearRun(botId);
}

/**
 * A decline stands for one stand-in episode: the same node and the same term
 * whenever both sides know them. A key unknown on either side matches: a copy
 * hold names its stand-in only once the delivery lands, and an answer given
 * before that must not be retired by the name arriving.
 */
function declinedFor(instance: InstanceConfig, mode: FleetFailbackMode, standInNodeId: string | null, episode: number | null): boolean {
  const d = instance.fleetFailbackDeclined;
  if (!d || d.mode !== mode) return false;
  if (d.standInNodeId !== null && standInNodeId !== null && d.standInNodeId !== standInNodeId) return false;
  return typeof d.episode !== 'number' || typeof episode !== 'number' || d.episode === episode;
}

/** A decline made while a key was unknown learns it once the facts carry it, so a later episode can reopen on its own. */
function learnDecline(instance: InstanceConfig, standInNodeId: string | null, episode: number | null): void {
  const d = instance.fleetFailbackDeclined;
  if (!d) return;
  const node = d.standInNodeId === null && standInNodeId !== null;
  const term = typeof d.episode !== 'number' && typeof episode === 'number';
  if (!node && !term) return;
  containerManager.updateInstanceFleetFailbackDeclined(instance.id, { ...d, standInNodeId: node ? standInNodeId : d.standInNodeId, episode: term ? episode : d.episode });
}

/**
 * A decline is spent once the episode it answered is provably over: a node
 * back in charge with no hold (failback), a copy back in recovery (drop-back).
 * A decline made while its keys were unknown would otherwise outlive the
 * episode and suppress the next one.
 */
export function settleDecline(instance: InstanceConfig, facts: AppFacts, live: { inRecovery?: boolean | null } | null): void {
  const d = instance.fleetFailbackDeclined;
  if (!d) return;
  const spent = d.mode === 'failback'
    ? facts.running === true && facts.initialized === true && facts.role === 'master' && !facts.followerHold
    : live?.inRecovery === true;
  if (spent) containerManager.updateInstanceFleetFailbackDeclined(instance.id, null);
}

/**
 * The handover stamped from evidence the manager already holds, with or
 * without a runner: a promote record of this run's episode (whoever asked for
 * it), or an answered probe reporting the copy out of recovery (a pg_promote
 * ran on it, after the claim and the fence in the transfer lane). Read on
 * every catching-up poll, on every health tick and by Cancel itself, so a
 * handover landing while the run is parked is never called harmless. Silence
 * stamps nothing.
 */
export function noteHandover(instance: InstanceConfig, facts: AppFacts | null | undefined, live: { running?: boolean; inRecovery?: boolean | null } | null | undefined): void {
  const run = currentRun(instance.id);
  if (!run || run.mode !== 'failback' || typeof run.handoverAt === 'number') return;
  if (run.phase !== 'catching-up' && run.phase !== 'promoting') return;
  // A promote still in flight is a handover whatever started it (the same rule
  // the refusal take-back reads); a done one counts only when it is this episode's.
  const rec = facts?.promote;
  const fromRecord = !!rec && (rec.phase !== 'done' || (typeof rec.startedAt === 'number' && rec.startedAt >= run.startedAt));
  const fromProbe = live?.running === true && live.inRecovery === false;
  if (fromRecord || fromProbe) saveRun(instance.id, { handoverAt: Date.now() });
}

export function declineText(decline: FleetFailbackDecline): string {
  const what = decline.mode === 'drop-back' ? 'drop-back' : 'failback';
  const rearm = decline.mode === 'drop-back' ? 'Drop back now' : 'Fail back now';
  return `The automatic ${what} was declined on ${new Date(decline.at).toISOString()} at its ${decline.phase} step, so it does not reopen for this stand-in episode and the by-hand routes are open; ${rearm} on the Database modal re-arms it.`;
}

/** The decline that still applies under this posture; null once the posture it was made under is gone. */
export function activeDecline(instance: InstanceConfig, standing: StandInPosture | null | undefined): FleetFailbackDecline | null {
  const d = instance.fleetFailbackDeclined;
  if (!d || !standing) return null;
  if (d.mode === 'failback') return standing.role === 'covered' && (d.standInNodeId === null || standing.standInNodeId === null || standing.standInNodeId === d.standInNodeId) ? d : null;
  return standing.role === 'stand-in' && !standing.live ? d : null;
}

function shortId(id: string | null): string {
  return id ? id.slice(0, 8) : 'the node holding the fleet';
}

function endpointOf(dsn: string): { host: string; port: number } | null {
  try {
    const url = new URL(dsn);
    return url.hostname ? { host: url.hostname, port: Number(url.port) || 5432 } : null;
  } catch {
    return null;
  }
}

export function failbackPhaseText(run: FleetFailbackRun): string {
  const who = shortId(run.standInNodeId);
  if (run.mode === 'drop-back') {
    return ({
      'awaiting-block': `waiting for the new master's copy block and the divergence verdict`,
      'wipe-consent': 'waiting for your consent to re-seed this copy',
      'seeding': `re-seeding this copy as a standby of ${who}'s database`,
    } as Record<string, string>)[run.phase] ?? run.phase;
  }
  return ({
    'awaiting-block': `waiting for the stand-in ${who} to relay its copy block and for the divergence verdict`,
    'dumping': 'stopping the instance and dumping this database before the wipe',
    'wipe-consent': 'waiting for your consent to wipe this database',
    'seeding': `re-seeding this machine as a standby of ${who}'s copy`,
    'applying': 'starting the instance so the bot holds on the copy',
    'catching-up': 'waiting for the copy to catch up',
    'promoting': 'the bot is promoting this node back (the zero-loss transfer)',
    'adopting': 'filing the promoted copy as this machine\'s database',
    'restarting': 'restarting the instance onto its database',
  } as Record<string, string>)[run.phase] ?? run.phase;
}

function lineageText(lineage: FleetLineageFact | null, who: string, subject: string): string {
  if (!lineage) return `Whether ${subject} holds writes the other side lacks could not be proven (the bot reported no verdict): treat the wipe as destroying anything written here after the outage began.`;
  if (lineage.verdict === 'prefix') {
    return lineage.bytesPast
      ? `${subject} wrote ${lineage.bytesPast} bytes of WAL past ${lineage.switchLsn}, the point where ${who}'s database branched from its timeline ${lineage.ownTimeline}, none of it a change to application data (its own control rows, maintenance and page images): it holds no application data that database lacks, so the wipe loses no data.`
      : `${subject} ended at ${lineage.ownLsn} on timeline ${lineage.ownTimeline}, at or before ${lineage.switchLsn}, the point where ${who}'s database branched from it: it holds nothing that database lacks, so the wipe loses nothing.`;
  }
  if (lineage.verdict === 'diverged') {
    const named = (lineage.dataChanges ?? []).map(c => `${c.schema}.${c.table} (${c.changes} row change${c.changes === 1 ? '' : 's'} in ${c.transactions} transaction${c.transactions === 1 ? '' : 's'})`).join(', ');
    return `${subject} changed application data past ${lineage.switchLsn}, the point where ${who}'s database branched from its timeline ${lineage.ownTimeline}: ${named || `${lineage.bytesPast} bytes of WAL`}; those rows exist nowhere else, and the wipe destroys them.`;
  }
  return `Whether ${subject} holds writes ${who}'s database lacks could not be proven (${lineage.reason}): treat the wipe as destroying anything written here after the outage began.`;
}

function dumpText(dump: FleetFailbackRun['dump']): string {
  if (!dump) return 'No dump was taken.';
  return dump.ok
    ? `A dump of it was taken first and is kept with the backups as ${dump.name}.`
    : `The safety dump FAILED (${dump.error}), so nothing of this database survives the wipe but what the other side already has.`;
}

/** The F5 consent surface: both positions, the verdict, the dump's outcome, and what each button does. */
export function consentText(run: FleetFailbackRun): string {
  const who = shortId(run.standInNodeId);
  if (run.mode === 'drop-back') {
    return `Re-seed this copy as a standby of ${who}'s database? ${lineageText(run.lineage, who, 'This copy')} Continue wipes this copy and rebuilds it from that database. Cancel leaves it as it is, out of recovery and holding whatever it holds, and closes the automatic drop-back for this episode (Drop back now on this modal re-arms it).`;
  }
  return `Wipe this machine's database and re-seed it from ${who}'s copy? ${lineageText(run.lineage, who, 'This database')} ${dumpText(run.dump)} Continue deletes the database and rebuilds it as a standby of that copy; the failback then promotes it back once it has caught up. Cancel starts the instance again with the database untouched and closes the automatic failback for this stand-in episode (Fail back now on this modal re-arms it).`;
}

/** What a stopped instance's badge says while a failback run owns it. */
export function stoppedText(run: FleetFailbackRun): string {
  if (run.phase === 'wipe-consent' && !run.consentAt) return `Instance is stopped by the failback run, which is ${failbackPhaseText(run)}: answer it on the Database modal`;
  return `Instance is stopped by the failback run (${failbackPhaseText(run)})${run.parked ? `; the run stopped: ${run.lastError || 'unknown reason'}` : ''}`;
}

function laneOverError(standInNodeId: string | null, past: 'none' | 'wipe' | 'handover' = 'none'): Error {
  const lane = `the node ${shortId(standInNodeId)} no longer stands in for this node (it was promoted by hand, or its lane ended)`;
  // After a landed claim of this node a demote would leave the fleet's term row naming a co-worker.
  if (past === 'handover') return new Error(`${lane}, but a promote of this node is on record and may have taken the fleet already; Continue finishes the failback from the bot's word, or Dismiss this run and read the bot's Fleet tab before doing anything else`);
  // After the wipe there is nothing for Cancel to put back.
  if (past === 'wipe') return new Error(`${lane}, and this machine's database was already replaced by the re-seed, so Cancel cannot put it back; Dismiss this run and follow the Fleet tab's hold notice (demote this node to stay a co-worker on this copy, or set BOT_NODE_ROLE=backup-master and restart it to make it a designated backup)`);
  return new Error(`${lane}, so there is no failback to run; Cancel this run, then demote this node from its Fleet tab to stay a co-worker, or set BOT_NODE_ROLE=backup-master and restart it to make it a designated backup`);
}

/**
 * Opened by the health tick for a covered instance whose stand-in still names
 * it (20.5: the failback is automatic; F5: it parks before the wipe). A hold
 * on a copy (already re-seeded) starts past the wipe.
 */
export function maybeOpenFailback(instance: InstanceConfig, facts: AppFacts, standing: StandInPosture): void {
  if (instance.fleetFailback || !hasAppHooks(instance)) return;
  if (standing.role !== 'covered' || standing.namesThisNode !== true) return;
  const onCopy = standing.holdReason === 'copy';
  // Only over databases this manager manages: the returning master's own
  // primary (to dump, wipe and re-seed it) or its re-seeded standby (to catch
  // up, promote and adopt). A hand-deployed database keeps the by-hand route.
  if (onCopy ? !instance.fleetDbReplica : !instance.fleetDb) return;
  const episode = typeof facts.followerHold?.observedTerm === 'number' ? facts.followerHold.observedTerm : null;
  if (declinedFor(instance, 'failback', standing.standInNodeId, episode)) { learnDecline(instance, standing.standInNodeId, episode); return; }
  if (instance.fleetFailbackDeclined) containerManager.updateInstanceFleetFailbackDeclined(instance.id, null);
  const phase: FleetFailbackPhase = onCopy ? 'catching-up' : 'awaiting-block';
  const repl = instance.fleetDb?.replication;
  const now = Date.now();
  const run: FleetFailbackRun = {
    mode: 'failback', phase, startedAt: now, updatedAt: now,
    standInNodeId: standing.standInNodeId,
    episode,
    lineage: facts.followerHold?.lineage ?? null,
    dump: null, consentAt: null,
    block: null,
    serve: repl ? { publicHost: repl.publicHost, hostPort: repl.hostPort } : instance.fleetDbReplica ? { publicHost: instance.fleetDbReplica.publicHost, hostPort: instance.fleetDbReplica.hostPort } : null,
    stoppedByRun: false,
  };
  containerManager.updateInstanceFleetFailback(instance.id, run);
  containerManager.broadcastBotUpdated(instance.id);
  console.log(`[FleetFailback] ${instance.displayName}: the returning master holds behind ${shortId(standing.standInNodeId)}; opening the failback run (${phase})`);
  void runFailback(instance.id, now);
}

/**
 * Opened by the health tick on a stand-in whose bot recorded the retire
 * instruction and whose promoted copy is an ended lane still out of recovery
 * (F32). Parks before its wipe like the failback (F5).
 */
export function maybeOpenDropBack(instance: InstanceConfig, facts: AppFacts, standing: StandInPosture, live: { inRecovery?: boolean | null } | null | undefined): void {
  if (instance.fleetFailback || !hasAppHooks(instance) || !instance.fleetDbReplica) return;
  if (facts.superseded?.retireRequested !== true) return;
  if (standing.role !== 'stand-in' || standing.live || standing.holdsWrites !== true) return;
  if (live?.inRecovery !== false) return;
  const episode = typeof facts.superseded.term === 'number' ? facts.superseded.term : null;
  if (declinedFor(instance, 'drop-back', facts.superseded.byNodeId, episode)) { learnDecline(instance, facts.superseded.byNodeId, episode); return; }
  if (instance.fleetFailbackDeclined) containerManager.updateInstanceFleetFailbackDeclined(instance.id, null);
  const now = Date.now();
  const run: FleetFailbackRun = {
    mode: 'drop-back', phase: 'awaiting-block', startedAt: now, updatedAt: now,
    standInNodeId: facts.superseded.byNodeId,
    episode,
    lineage: facts.ownCopyLineage ?? null,
    dump: null, consentAt: null, block: null,
    serve: { publicHost: instance.fleetDbReplica.publicHost, hostPort: instance.fleetDbReplica.hostPort },
    stoppedByRun: false,
  };
  containerManager.updateInstanceFleetFailback(instance.id, run);
  containerManager.broadcastBotUpdated(instance.id);
  console.log(`[FleetFailback] ${instance.displayName}: the failback to ${shortId(facts.superseded.byNodeId)} asked this side to drop back; opening the drop-back run`);
  void runFailback(instance.id, now);
}

/** The operator's own open: a covered instance whose tick has not fired yet, and the re-arm after a decline (both modes). */
export async function openFailbackByHand(instance: InstanceConfig): Promise<ActionResult> {
  if (instance.fleetFailback) return { success: false, error: `A ${instance.fleetFailback.mode} run is already on this instance (${failbackPhaseText(instance.fleetFailback)})` };
  if (!hasAppHooks(instance)) return { success: false, error: 'this app declares no lifecycle hooks' };
  const read = await getAppFacts(instance, FACTS_TIMEOUT_MS);
  const posture = postureFromRead(instance, read);
  if (posture.read === 'unanswered') return { success: false, error: `the app is not answering (${posture.error}); ${unansweredRemedy(posture.error)} before opening it` };
  const standing = posture.read === 'ok' ? posture.posture : null;
  if (standing?.role === 'stand-in' && !standing.live) {
    if (read.facts!.superseded?.retireRequested !== true) return { success: false, error: 'this copy\'s stand-in lane ended, but no failback asked this side to drop back, so there is no drop-back to run; the by-hand routes on this modal apply' };
    const live = (await fleetReplica.getFleetReplicaStatus(instance)).live;
    if (!live?.running) return { success: false, error: 'this copy\'s container is not running, or could not be probed, so it cannot be verified as the promoted copy; start the instance, and rebuild it if a stopped re-seed took the standby service out of its compose' };
    if (live.inRecovery !== false) return { success: false, error: live.inRecovery === true ? 'this copy is in recovery again (a standby), so there is nothing to drop back' : 'this copy did not say whether it is in recovery; retry in a moment' };
    containerManager.updateInstanceFleetFailbackDeclined(instance.id, null);
    maybeOpenDropBack(containerManager.getBot(instance.id) ?? instance, read.facts!, standing, live);
    return containerManager.getBot(instance.id)?.fleetFailback
      ? { success: true, started: true }
      : { success: false, error: 'the drop-back did not open: this manager manages no standby record on this instance' };
  }
  if (!standing || standing.role !== 'covered') return { success: false, error: 'this node is not a returning master behind a stand-in, so there is no failback to run' };
  if (standing.namesThisNode !== true) {
    return { success: false, error: standing.namesThisNode === false
      ? 'the node this bot followed no longer stands in for it, so there is no failback to run'
      : 'the bot has not registered with the node holding the fleet yet; the failback opens once it has' };
  }
  containerManager.updateInstanceFleetFailbackDeclined(instance.id, null);
  maybeOpenFailback(containerManager.getBot(instance.id) ?? instance, read.facts!, standing);
  return containerManager.getBot(instance.id)?.fleetFailback
    ? { success: true, started: true }
    : { success: false, error: 'the failback did not open: this manager manages no database on this instance to fail back (a hand-deployed database keeps the by-hand route)' };
}

/** The copy block the bot holds, read from its own file: the instance is stopped when the seed needs it, so no hook can answer. */
async function readBlockFile(instance: InstanceConfig, expected: { host: string; port: number } | null): Promise<{ dsn: string; cert: string }> {
  const dir = await fleetReplica.instanceDataDir(instance);
  const file = path.join(dir, 'global', 'fleet', 'copy-block.json');
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    throw new Error(`the copy block the bot recorded could not be read (${file}: ${err instanceof Error ? err.message : String(err)}); Dismiss this run (the instance stays stopped) and re-seed by hand from the block on the stand-in's Database modal`);
  }
  if (typeof parsed?.dsn !== 'string' || parsed.dsn === '' || typeof parsed?.cert !== 'string' || parsed.cert === '') {
    throw new Error('the copy block the bot recorded is incomplete; Dismiss this run (the instance stays stopped) and re-seed by hand from the block on the stand-in\'s Database modal');
  }
  const found = endpointOf(parsed.dsn);
  if (expected && (!found || found.host !== expected.host || found.port !== expected.port)) {
    throw new Error(`the block the bot holds names ${found ? `${found.host}:${found.port}` : 'an unparseable endpoint'}, not the stand-in's copy at ${expected.host}:${expected.port} this run was decided on; Cancel this run (nothing here was destroyed: the instance starts again, and Fail back now re-arms the run), or Dismiss it and re-seed by hand from that node's block`);
  }
  return { dsn: parsed.dsn, cert: parsed.cert };
}

async function runFailback(botId: string, startedAt: number): Promise<void> {
  const owns = (): boolean => {
    const run = currentRun(botId);
    return !!run && run.startedAt === startedAt && run.parked !== true;
  };
  const facts = async (): Promise<{ bot: InstanceConfig; read: Awaited<ReturnType<typeof getAppFacts>> } | null> => {
    const bot = containerManager.getBot(botId);
    if (!bot) return null;
    return { bot, read: await getAppFacts(bot, FACTS_TIMEOUT_MS) };
  };
  try {
    while (owns()) {
      const run = currentRun(botId)!;
      const bot = containerManager.getBot(botId);
      if (!bot) return;
      if (run.mode === 'drop-back') {
        if (run.phase === 'awaiting-block') {
          const deadline = Date.now() + BLOCK_WAIT_MS;
          let blockSeenAt: number | null = null;
          for (;;) {
            if (!owns()) return;
            const got = await facts();
            if (!got) return;
            const f = got.read.success ? got.read.facts : undefined;
            if (f?.running === true) {
              const posture = postureFromRead(got.bot, got.read);
              const standing = posture.read === 'ok' ? posture.posture : null;
              if (!standing || standing.role !== 'stand-in' || standing.live) {
                throw new Error('the bot no longer reports this copy as an ended stand-in lane; nothing has been changed');
              }
              if (f.copyBlockFollowed === true && f.copyBlock?.dsn) {
                if (blockSeenAt === null) blockSeenAt = Date.now();
                const lineage = f.ownCopyLineage ?? null;
                if (lineage || Date.now() - blockSeenAt >= LINEAGE_WAIT_MS) {
                  saveRun(botId, { phase: 'wipe-consent', parked: true, lineage, block: endpointOf(f.copyBlock.dsn) });
                  return;
                }
              }
            }
            if (Date.now() > deadline) {
              throw new Error(!got.read.success ? `the bot is not answering (${got.read.error})`
                : f?.running !== true ? 'the bot process is not running'
                : f.copyBlockFollowed !== true ? 'the new master has not relayed its copy block to this node yet (its manager publishes it when its Database modal is opened, and a block reaches an already-registered node only on that node\'s next registration, a restart of either bot); Continue once it has'
                : 'the copy block is in hand but the verdict never arrived');
            }
            await sleep(POLL_MS);
          }
        }
        if (run.phase === 'wipe-consent') {
          if (!run.consentAt) { saveRun(botId, { parked: true }); return; }
          saveRun(botId, { phase: 'seeding' });
          continue;
        }
        if (run.phase === 'seeding') {
          const liveSeed = !!bot.fleetDbReplicaSeed && !bot.fleetDbReplicaSeed.parked;
          // This run's own seed can complete the copy and fail only its service
          // start, which keeps the record (filed at or after the consent, the
          // copy whole): a re-seed over it would refuse on the container that
          // never came up, so the service is re-applied from the record instead.
          if (!liveSeed && !bot.fleetDbReplicaSeed && !copyBuiltByRun(bot.fleetDbReplica, run)) {
            const started = await fleetReplica.reseedStandby(bot, 'operator', { consentedRun: startedAt });
            if (!started.success) throw new Error(started.error || 'the re-seed could not be started');
          }
          // The run remembers the seed it waits on, by identity: the copy that
          // seed files names it back. A live seed found on entry is this run's
          // own (the run hold keeps every other lane out).
          const seed = containerManager.getBot(botId)?.fleetDbReplicaSeed;
          if (seed && !seed.parked && currentRun(botId)?.seedStartedAt !== seed.startedAt) saveRun(botId, { seedStartedAt: seed.startedAt });
          await waitForSeed(botId, owns);
          if (!owns()) return;
          // On this side the record pre-exists, so the wait ending is not the
          // copy rebuilt. A seed that stopped after its wipe (the seed record
          // dismissed under the wait) left the copy cleared; one cancelled or
          // superseded before it left the copy as it was, its container
          // possibly taken out by the seed's own preflight, and that container
          // goes back. Either way the run parks with the truth.
          const after = containerManager.getBot(botId)?.fleetDbReplica;
          const owner = currentRun(botId);
          if (!owner) return;
          if (!copyBuiltByRun(after, owner)) {
            if (after?.copyCleared === true) throw new Error('the seed stopped after clearing this copy and before rebuilding it, so it cannot be put back; Continue seeds it again');
            const back = await containerManager.applyFleetDbReplicaService(botId);
            throw new Error(`the re-seed ended without rebuilding this copy (cancelled or superseded before it changed anything); Continue starts it again, Cancel closes the drop-back for this episode${back.success ? '' : `; the copy's container could not be put back: ${back.error || 'unknown reason'}`}`);
          }
          const applied = await containerManager.applyFleetDbReplicaService(botId);
          if (!applied.success) throw new Error(`the standby's service could not be started from its record: ${applied.error || 'unknown reason'}; Continue retries it`);
          clearRun(botId);
          console.log(`[FleetFailback] ${bot.displayName}: the drop-back finished; this copy is a standby of ${shortId(run.standInNodeId)}'s database again`);
          return;
        }
        throw new Error(`a drop-back run has no phase ${run.phase}`);
      }

      switch (run.phase) {
        case 'awaiting-block': {
          const deadline = Date.now() + BLOCK_WAIT_MS;
          let blockSeenAt: number | null = null;
          for (;;) {
            if (!owns()) return;
            const got = await facts();
            if (!got) return;
            const f = got.read.success ? got.read.facts : undefined;
            if (f?.running === true && f.initialized) {
              const hold = f.followerHold;
              if (!hold) throw new Error('the bot no longer reports the follower hold (it was demoted, or restarted as something else); nothing has been changed');
              if (hold.namesThisNode === false) throw laneOverError(hold.standInNodeId ?? run.standInNodeId);
              if (hold.reason === 'copy') {
                saveRun(botId, { phase: got.bot.fleetDbReplica ? 'catching-up' : 'promoting', standInNodeId: hold.standInNodeId ?? run.standInNodeId });
                break;
              }
              if (hold.namesThisNode === true && f.copyBlockFollowed === true && f.copyBlock?.dsn) {
                if (blockSeenAt === null) blockSeenAt = Date.now();
                const lineage = hold.lineage ?? null;
                if (lineage || Date.now() - blockSeenAt >= LINEAGE_WAIT_MS) {
                  saveRun(botId, { phase: 'dumping', standInNodeId: hold.standInNodeId ?? run.standInNodeId, lineage, block: endpointOf(f.copyBlock.dsn) });
                  break;
                }
              }
            }
            if (Date.now() > deadline) {
              const hold = f?.followerHold;
              throw new Error(!got.read.success ? `the bot is not answering (${got.read.error})`
                : f?.running !== true ? 'the bot process is not running'
                : !hold ? 'the bot reports no follower hold'
                : hold.namesThisNode !== true ? 'the bot has not registered with the node holding the fleet yet; the failback needs that node reachable'
                : f.copyBlockFollowed !== true ? `the stand-in ${shortId(hold.standInNodeId)} has not relayed its copy block to this node yet (its manager publishes it when the Database modal there is opened or on its next health tick); Continue once it has, or Cancel this run and follow the by-hand route on this modal`
                : 'the copy block is in hand but the divergence verdict never arrived');
            }
            await sleep(POLL_MS);
          }
          continue;
        }
        case 'dumping': {
          if (bot.status === 'running') {
            const stopped = await containerManager.stopBot(botId);
            if (!stopped.success) throw new Error(`the instance could not be stopped for the dump: ${stopped.error}`);
            saveRun(botId, { stoppedByRun: true });
          }
          // Stopping took the whole compose project down: the database comes
          // back alone to be dumped. Best effort, and the outcome is what the
          // consent names (F5); a database that will not start cannot be dumped.
          const up = await containerManager.startFleetDbSidecar(botId);
          const fresh = containerManager.getBot(botId);
          if (!fresh) return;
          const dump = up.success ? await fleetBackup.runFleetDump(fresh, 'pre-failback-') : { success: false as const, error: up.error };
          if (!dump.success) console.warn(`[FleetFailback] ${fresh.displayName}: the pre-failback dump failed: ${dump.error}`);
          saveRun(botId, { phase: 'wipe-consent', parked: true, dump: { ok: dump.success, name: dump.success ? dump.file ?? null : null, error: dump.success ? null : (dump.error ?? 'unknown reason'), at: Date.now() } });
          return;
        }
        case 'wipe-consent': {
          if (!run.consentAt) { saveRun(botId, { parked: true }); return; }
          saveRun(botId, { phase: 'seeding' });
          continue;
        }
        case 'seeding': {
          const liveSeed = !!bot.fleetDbReplicaSeed && !bot.fleetDbReplicaSeed.parked;
          if (!liveSeed && !bot.fleetDbReplica) {
            if (bot.fleetDbReplicaSeed?.parked) {
              throw new Error(`the seed stopped (${bot.fleetDbReplicaSeed.lastError || 'unknown reason'}); dismiss it on this modal, then Continue to seed again from the block`);
            }
            if (!run.serve) throw new Error('this machine\'s endpoint for the copy is not known (no replication record); Dismiss this run (the instance stays stopped) and re-seed by hand from the block on the stand-in\'s Database modal');
            const block = await readBlockFile(bot, run.block);
            const started = bot.fleetDb
              ? fleetReplica.reseedStalePrimary(bot, block.dsn, block.cert, run.serve.publicHost, run.serve.hostPort, false, { dumpDone: true, run: startedAt })
              : fleetReplica.provisionFleetReplica(bot, block.dsn, block.cert, run.serve.publicHost, run.serve.hostPort, false, { run: startedAt });
            if (!started.success) {
              throw new Error(started.needsConfirm
                ? `${started.error}. The failback run does not answer that confirmation: Dismiss this run (the instance stays stopped) and re-seed by hand from the block on the stand-in's Database modal`
                : (started.error || 'the re-seed could not be started'));
            }
          }
          await waitForSeed(botId, owns);
          if (!owns()) return;
          // The record can outlive a failed service start: the standby service
          // is re-applied from it (idempotent) before the instance boots onto it.
          if (containerManager.getBot(botId)?.fleetDbReplica) {
            const applied = await containerManager.applyFleetDbReplicaService(botId);
            if (!applied.success) throw new Error(`the standby's service could not be started from its record: ${applied.error || 'unknown reason'}; Continue retries it`);
          }
          saveRun(botId, { phase: 'applying' });
          continue;
        }
        case 'applying': {
          // A running instance whose container predates the standby record
          // carries the change unapplied; the start lane applies it in place.
          if (bot.status !== 'running' || bot.pendingApply === true) {
            const started = await containerManager.startBot(botId);
            if (!started.success) throw new Error(`the instance could not be started onto its copy: ${started.error}`);
            if (bot.status !== 'running') saveRun(botId, { stoppedByRun: false });
          }
          const deadline = Date.now() + HOLD_BOOT_WAIT_MS;
          for (;;) {
            if (!owns()) return;
            const got = await facts();
            if (!got) return;
            const f = got.read.success ? got.read.facts : undefined;
            const hold = f?.followerHold;
            if (hold?.namesThisNode === false) throw laneOverError(hold.standInNodeId ?? run.standInNodeId, 'wipe');
            if (f?.running === true && hold?.reason === 'copy' && hold.namesThisNode === true && typeof hold.following === 'string' && hold.following !== '') break;
            if (f?.running === true && f.initialized && f.role === 'master' && !hold) {
              throw new Error('the bot came back as a master on its own instead of holding on the copy; check its Fleet tab before continuing');
            }
            if (Date.now() > deadline) {
              throw new Error(`the bot did not come up holding on its copy within 10 minutes (${!got.read.success ? got.read.error : f?.running !== true ? 'the bot process is not running' : !hold ? 'no follower hold reported' : hold.namesThisNode !== true ? 'not registered with the node holding the fleet yet' : 'the delivered database is not installed here yet; the Fleet tab hold notice says why'})`);
            }
            await sleep(POLL_MS);
          }
          saveRun(botId, { phase: 'catching-up' });
          continue;
        }
        case 'catching-up': {
          if (!bot.fleetDbReplica) { saveRun(botId, { phase: 'promoting' }); continue; }
          const deadline = Date.now() + CATCHUP_WAIT_MS;
          let notStreamingSince: number | null = null;
          for (;;) {
            if (!owns()) return;
            const fresh = containerManager.getBot(botId);
            if (!fresh) return;
            if (!fresh.fleetDbReplica) throw new Error('the standby was removed while the failback waited for it');
            const live = (await fleetReplica.getFleetReplicaStatus(fresh)).live;
            // The handover's evidence is read every poll, beside the probe: a
            // claim that landed with the copy still in recovery, or the copy out
            // of recovery, must not leave a park or a restart here cancelable.
            const got = await facts();
            const f = got?.read.success ? got.read.facts : undefined;
            noteHandover(fresh, f ?? null, live);
            if (live?.running && live.inRecovery === false) {
              if (f?.running === true && f.initialized && f.role === 'master' && !f.followerHold) { saveRun(botId, { phase: 'adopting', handoverAt: currentRun(botId)?.handoverAt ?? Date.now() }); break; }
              throw new Error('the copy left recovery before this run asked for the promote, and the bot does not report itself as master; check its Fleet tab (a promote may be parked there), then Continue');
            }
            const streaming = !!(live?.running && live.inRecovery && live.receiverStatus === 'streaming');
            if (streaming && live?.caughtUp === true) { saveRun(botId, { phase: 'promoting' }); break; }
            if (streaming) notStreamingSince = null;
            else if (live?.running && live.inRecovery) {
              if (notStreamingSince === null) notStreamingSince = Date.now();
              else if (Date.now() - notStreamingSince >= NOT_STREAMING_GRACE_MS) throw new Error(`the copy is not receiving from the stand-in's database (receiver ${live.receiverStatus || 'not connected'}); the failback needs it streaming`);
            } else notStreamingSince = null;
            if (Date.now() > deadline) throw new Error(`the copy did not catch up within 10 minutes (${!live?.running ? 'the standby container is not running' : `receiver ${live.receiverStatus || 'not connected'}`})`);
            await sleep(POLL_MS);
          }
          continue;
        }
        case 'promoting': {
          const got = await facts();
          if (!got) return;
          const f = got.read.success ? got.read.facts : undefined;
          const promote = f?.promote;
          const ours = promote && typeof promote.startedAt === 'number' && promote.startedAt >= run.startedAt;
          // The handover's evidence, read here too so a Continue re-entering at
          // promoting stamps from a record whoever asked for it.
          noteHandover(got.bot, f ?? null, null);
          if (f?.running === true && f.initialized && f.role === 'master' && !f.followerHold && (!ours || promote.phase === 'done')) {
            saveRun(botId, { phase: 'adopting', handoverAt: currentRun(botId)?.handoverAt ?? Date.now() });
            continue;
          }
          if (!ours) {
            if (f?.followerHold?.namesThisNode === false) throw laneOverError(f.followerHold.standInNodeId ?? run.standInNodeId, typeof currentRun(botId)?.handoverAt === 'number' ? 'handover' : run.consentAt !== null ? 'wipe' : 'none');
            // retireOldMaster: the stand-in is told to drop back through the
            // new master's register reply (F32); its own manager runs that.
            // Stamped before the ask: the promote's claim on the stand-in's database
            // follows the reply, and a run parked between the two must not read as
            // cancelable. A refusal takes the stamp back only when it provably
            // started nothing: no record of this episode afterwards (a lost reply
            // leaves one), and never a stamp an earlier ask of this run wrote.
            const hadHandover = typeof run.handoverAt === 'number';
            saveRun(botId, { handoverAt: run.handoverAt ?? Date.now() });
            const result = await promoteSide(got.bot, { confirmLag: false, retireOldMaster: true });
            if (!result.success) {
              if (!hadHandover) {
                // Only an ANSWERED re-read showing nothing that could be this
                // handover takes it back: an unreachable bot is the lost-reply
                // case itself, and a promote still in flight (whatever started
                // it) is a handover this run must not call harmless.
                const after = await facts();
                const answered = after?.read.success === true;
                const rec = answered ? after!.read.facts?.promote : undefined;
                const couldBeHandover = !!rec && (rec.phase !== 'done' || (typeof rec.startedAt === 'number' && rec.startedAt >= run.startedAt));
                if (answered && !couldBeHandover) saveRun(botId, { handoverAt: undefined });
              }
              throw new Error(result.error || 'the bot refused the promote');
            }
          }
          const deadline = Date.now() + PROMOTE_WAIT_MS;
          for (;;) {
            if (!owns()) return;
            const again = await facts();
            if (!again) return;
            const g = again.read.success ? again.read.facts : undefined;
            const record = g?.promote;
            if (record && typeof record.startedAt === 'number' && record.startedAt >= run.startedAt && record.parked === true) {
              throw new Error(`the bot's promote stopped at its ${record.phase} phase: ${record.lastError || 'unknown reason'}; Continue or Cancel it on the bot's Fleet tab, then Continue this run`);
            }
            if (g?.running === true && g.initialized && g.role === 'master' && !g.followerHold) break;
            if (Date.now() > deadline) throw new Error('the bot did not come back as master within 10 minutes; check its Fleet tab');
            await sleep(POLL_MS);
          }
          saveRun(botId, { phase: 'adopting', handoverAt: currentRun(botId)?.handoverAt ?? Date.now() });
          continue;
        }
        case 'adopting': {
          if (bot.fleetDbReplica) {
            const adopted = await fleetReplica.adoptPromotedReplica(bot, { run: startedAt });
            if (!adopted.success) throw new Error(adopted.error || 'the promoted copy could not be adopted');
            saveRun(botId, { adoptedAt: Date.now() });
          } else if (!bot.fleetDb) {
            throw new Error('no database record is left to adopt on this instance');
          } else if (typeof run.adoptedAt !== 'number') {
            // The adopt files the record before it enables replication on it, so
            // a record without this run's stamp is an adopt that stopped at its
            // last step: the standby record is consumed, but the enable can run
            // again (it keeps an existing credential and a matching cert).
            const host = bot.fleetDb.replication?.publicHost ?? run.serve?.publicHost;
            const port = bot.fleetDb.replication?.hostPort ?? run.serve?.hostPort;
            if (!host) throw new Error('the adopt stopped before enabling replication on this database and this machine\'s endpoint for it is not known; enable replication from the Replication section, then Continue');
            const enabled = await enableFleetReplication(bot, host, port);
            if (!enabled.success) throw new Error(`the adopt stopped before enabling replication on this database, and enabling it again failed: ${enabled.error || 'unknown reason'}; Continue retries it (the Replication section shows Enable only while this database carries no replication posture)`);
            saveRun(botId, { adoptedAt: Date.now() });
          }
          // This machine mints its own block now, and a block reaches another
          // node only in a register reply: published here, before the restart
          // below drops the stand-in's control connection, its re-register
          // reads this node's block and its drop-back can proceed (F32).
          const filed = containerManager.getBot(botId);
          if (filed?.fleetDb?.replication) {
            const delivered = await deliverCopyBlock(filed);
            if (!delivered.success) console.warn(`[FleetFailback] ${filed.displayName}: this node's copy block was not republished after the adopt (${delivered.error}); the stand-in receives it on its next registration once it is`);
          } else {
            console.warn(`[FleetFailback] ${bot.displayName}: the adopted record carries no replication, so this node's copy block was not republished; enable replication from the Replication section`);
          }
          saveRun(botId, { phase: 'restarting' });
          continue;
        }
        case 'restarting': {
          const restarted = await containerManager.restartBot(botId);
          if (!restarted.success) throw new Error(`the instance could not be restarted onto its database: ${restarted.error}`);
          const deadline = Date.now() + RESTART_WAIT_MS;
          for (;;) {
            if (!owns()) return;
            const got = await facts();
            if (!got) return;
            const f = got.read.success ? got.read.facts : undefined;
            if (f?.running === true && f.initialized && f.role === 'master') break;
            if (Date.now() > deadline) throw new Error('the bot did not come back as master after the restart within 5 minutes; check its Fleet tab');
            await sleep(POLL_MS);
          }
          if (owns()) {
            clearRun(botId);
            console.log(`[FleetFailback] ${bot.displayName}: the failback finished; this node is the master again on its own database`);
          }
          return;
        }
        default:
          throw new Error(`a failback run has no phase ${run.phase}`);
      }
    }
  } catch (err) {
    if (owns()) saveRun(botId, { parked: true, lastError: String(err instanceof Error ? err.message : err) });
  }
}

/** The seed reports through its own record and its own timeouts, so this waits on that record alone. */
async function waitForSeed(botId: string, owns: () => boolean): Promise<void> {
  for (;;) {
    if (!owns()) return;
    const bot = containerManager.getBot(botId);
    if (!bot) return;
    const seed = bot.fleetDbReplicaSeed;
    if (!seed || seed.parked) {
      if (bot.fleetDbReplica && !seed) break;
      throw new Error(seed?.parked
        ? `the seed stopped: ${seed.lastError || 'unknown reason'}; dismiss it on this modal, then Continue`
        : 'the seed ended without leaving a standby (it was cancelled or dismissed)');
    }
    await sleep(POLL_MS);
  }
}

/** Continue a parked run; at the consent park, the operator's consent is what lets the wipe run (F5). */
export async function continueFailback(instance: InstanceConfig, opts: { consent?: boolean } = {}): Promise<ActionResult> {
  const run = instance.fleetFailback;
  if (!run) return { success: false, error: 'No failback run is recorded on this instance' };
  if (!run.parked) return { success: false, error: `The run is live (${failbackPhaseText(run)}); wait for it` };
  if (run.phase === 'wipe-consent' && !run.consentAt) {
    if (opts.consent !== true) return { success: false, needsConfirm: true, error: consentText(run) };
    saveRun(instance.id, { consentAt: Date.now(), phase: 'seeding', parked: false, lastError: undefined });
  } else {
    saveRun(instance.id, { parked: false, lastError: undefined });
  }
  void runFailback(instance.id, run.startedAt);
  return { success: true, started: true, resumed: true };
}

/**
 * Whether the run's wipe began, from the records the lanes stamp rather than
 * from the phase: the wipe never runs without consent, the primary record is
 * deleted only after its volume is retired, the seed's committed flag describes
 * the volume and the copy-clear flag the standby's. A run parked at seeding by
 * a refusal before the lane touched anything is still cancelable.
 */
function destroyedBy(instance: InstanceConfig, run: FleetFailbackRun): boolean {
  // The copy-hold lane never consents (its wipe was done by hand), so its
  // handover is the run's own stamp, read before the consent gate.
  if (typeof run.handoverAt === 'number') return true;
  if (run.consentAt === null) return false;
  // Every failback phase after seeding is reached only once the seed finished,
  // and the adopt then refiles the primary record and clears the seed record,
  // so past the seed the phase is the evidence.
  if (run.mode === 'failback' && PAST_SEED.has(run.phase)) return true;
  const committed = instance.fleetDbReplicaSeed?.committed === true;
  // The drop-back's seed record is the only trace of its wipe once the copy is
  // whole again (the rebuilt record carries no copyCleared), and the park text
  // has the operator dismiss that record: the copy's own filing is the evidence.
  return run.mode === 'drop-back'
    ? committed || !instance.fleetDbReplica || instance.fleetDbReplica.copyCleared === true || copyBuiltByRun(instance.fleetDbReplica, run)
    : committed || !instance.fleetDb;
}

/** The copy names the seed that built it, and the run names the seed it started: the same seed wiped before it copied. */
function copyBuiltByRun(rec: FleetDbReplicaRecord | undefined, run: FleetFailbackRun): boolean {
  return !!rec && rec.copyCleared !== true && typeof rec.seededBy === 'number' && rec.seededBy === run.seedStartedAt;
}

const PAST_SEED = new Set<FleetFailbackPhase>(['applying', 'catching-up', 'promoting', 'adopting', 'restarting']);

/** Cancel is possible while nothing was destroyed and no runner is mid-step. */
export function cancelableFailback(instance: InstanceConfig): boolean {
  const run = instance.fleetFailback;
  if (!run) return false;
  if (!run.parked && run.phase !== 'awaiting-block') return false;
  return !destroyedBy(instance, run);
}

/** Cancel puts the instance back the way the run found it and remembers the decline for this stand-in episode. */
export async function cancelFailback(instance: InstanceConfig): Promise<ActionResult> {
  let run = instance.fleetFailback;
  if (!run) return { success: false, error: 'No failback run is recorded on this instance' };
  if (!run.parked && run.phase !== 'awaiting-block') {
    return { success: false, error: run.phase === 'dumping'
      ? 'The dump is running; Cancel once the run parks for your consent'
      : `The run is live (${failbackPhaseText(run)}); Cancel once it parks` };
  }
  // The button reads the record; the action reads the world first, because the
  // handover can land while the run is parked and before the next tick.
  if (run.mode === 'failback' && (run.phase === 'catching-up' || run.phase === 'promoting') && typeof run.handoverAt !== 'number') {
    const read = await getAppFacts(instance, FACTS_TIMEOUT_MS);
    const live = instance.fleetDbReplica ? (await fleetReplica.getFleetReplicaStatus(instance)).live : null;
    noteHandover(instance, read.success ? read.facts ?? null : null, live);
    run = currentRun(instance.id) ?? run;
  }
  if (destroyedBy(instance, run)) {
    return { success: false, error: run.consentAt !== null
      ? `The run is past the point of cancellation (${failbackPhaseText(run)}): the database was already replaced. Continue it, or Dismiss it and use the by-hand routes on this modal`
      : run.phase === 'catching-up'
        ? `The run is past the point of cancellation (${failbackPhaseText(run)}): a promote has already run on this copy, or one of this episode is on record, so nothing here can be put back. Continue finishes the failback, or Dismiss it and use the by-hand routes on this modal`
        : `The run is past the point of cancellation (${failbackPhaseText(run)}): the fleet was already handed back to this node by its promote. Continue finishes the failback (adopt and restart), or Dismiss it and use the by-hand routes on this modal` };
  }
  // Claim the record first so a live awaiting-block runner stops at its next check.
  containerManager.updateInstanceFleetFailback(instance.id, { ...run, parked: true, lastError: 'cancelled by the operator', updatedAt: Date.now() });
  if (run.stoppedByRun) {
    const fresh = containerManager.getBot(instance.id);
    if (fresh && fresh.status !== 'running') {
      const started = await containerManager.startBot(instance.id);
      if (!started.success) {
        declineRun(instance.id, run);
        return { success: true, error: `The run is cancelled with nothing destroyed, but the instance could not be started again: ${started.error}` };
      }
    }
  }
  declineRun(instance.id, run);
  return { success: true };
}

/** Dismiss a parked run without touching anything, remembering the decline; the by-hand routes reopen with it gone. */
export function dismissFailback(instance: InstanceConfig): ActionResult {
  const run = instance.fleetFailback;
  if (!run) return { success: false, error: 'No failback run is recorded on this instance' };
  if (!run.parked) return { success: false, error: `The run is live (${failbackPhaseText(run)}); wait for it` };
  if (run.phase === 'wipe-consent' && !run.consentAt) return { success: false, error: 'This run is waiting for your answer: Continue consents to the wipe, Cancel restores the instance' };
  declineRun(instance.id, run);
  const fresh = containerManager.getBot(instance.id);
  if (run.stoppedByRun && fresh && fresh.status !== 'running') {
    return { success: true, error: 'The run is dismissed and stays closed for this stand-in episode. The instance stays stopped, as the run left it: the by-hand re-seed on this modal needs it stopped, and its card starts it again when you are done' };
  }
  return { success: true };
}

/** Boot: a run the previous manager process owned has no runner any more; a consent park is not an interruption. */
export function parkInterruptedFailbacks(): void {
  for (const instance of containerManager.getAllBots()) {
    const run = instance.fleetFailback;
    if (!run || run.parked) continue;
    console.log(`[FleetFailback] ${instance.displayName} had a ${run.mode} run live (${run.phase}) when the manager stopped - parking it`);
    containerManager.updateInstanceFleetFailback(instance.id, {
      ...run,
      parked: true,
      lastError: `the manager restarted during the run (${failbackPhaseText(run)}); Continue picks up from where it stopped`,
      updatedAt: Date.now(),
    });
  }
}
