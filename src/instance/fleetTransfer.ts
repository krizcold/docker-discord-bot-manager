/**
 * Seed-first transfer (PLAN_REPLICATION 20.14 and 20.19 F15/F21, the last
 * B4m-2b deliverable). A designated backup that holds no standby yet is
 * promoted in one action: its standby is provisioned from the copy block the
 * bot itself holds, the app is recreated so it learns the copy, the copy is
 * watched until it streams and is caught up, and only then is the app's own
 * promote asked for. The primary is alive by construction (the copy has just
 * come from it), so this is the zero-loss path; a primary that dies meanwhile
 * parks the run with the app's own words, and the operator continues from the
 * standby that now exists.
 *
 * Every step decides from the instance record and the app's own facts, so a
 * parked run is resumed by pressing Transfer again: an existing standby is not
 * re-seeded, an app that already reports its standby is not restarted, a
 * caught-up copy is promoted straight away.
 */
import * as containerManager from '../docker/containerManager';
import * as fleetReplica from './fleetReplica';
import { ActionResult, getAppFacts, transfer as promoteSide } from './appLifecycle';
import { hasAppHooks } from './appHookClient';
import { FleetTransferRun, InstanceConfig } from '../types';

const POLL_MS = 3_000;
const BOOT_WAIT_MS = 3 * 60_000;
const CATCHUP_WAIT_MS = 10 * 60_000;
/** A reconnecting walreceiver empties pg_stat_wal_receiver, so a gap this short is not a silent primary. */
const NOT_STREAMING_GRACE_MS = 30_000;
const FACTS_TIMEOUT_MS = 10_000;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function currentRun(botId: string): FleetTransferRun | null {
  return containerManager.getBot(botId)?.fleetTransfer ?? null;
}

function saveRun(botId: string, patch: Partial<FleetTransferRun>): void {
  const current = currentRun(botId);
  if (!current) return;
  containerManager.updateInstanceFleetTransfer(botId, { ...current, ...patch, updatedAt: Date.now() });
  containerManager.broadcastBotUpdated(botId);
}

function openRun(botId: string, phase: FleetTransferRun['phase'], retireOldMaster: boolean): number {
  const now = Date.now();
  containerManager.updateInstanceFleetTransfer(botId, { phase, startedAt: now, updatedAt: now, retireOldMaster });
  containerManager.broadcastBotUpdated(botId);
  return now;
}

export interface TransferOptions {
  confirmLag?: boolean;
  retireOldMaster?: boolean;
  /** This machine's endpoint for the copy it will serve; needed only when a standby has to be seeded first. */
  publicHost?: string;
  hostPort?: number;
}

/**
 * The operator's Transfer. With a standby in place and no parked run this is
 * the app's own promote; with a parked run it resumes the pipeline from the
 * state on record; without a standby it is the seed-first run, answered at
 * once and followed through the instance record.
 */
export async function transferSide(instance: InstanceConfig, opts: TransferOptions): Promise<ActionResult> {
  const active = instance.fleetTransfer;
  if (active && !active.parked) {
    return { success: false, error: `a transfer is already running on this instance (${active.phase}); wait for it to finish` };
  }
  if (instance.fleetDbReplica) {
    // A run parked at the promote itself (the app asked for the lag to be
    // acknowledged, or refused) is answered by the app's promote directly, so
    // the operator's confirmLag reaches it and a dead primary is the failover
    // the app names, never a catch-up wait it can never satisfy.
    if (!active || active.phase === 'promoting' || opts.confirmLag === true) {
      const result = await promoteSide(instance, { confirmLag: opts.confirmLag, retireOldMaster: opts.retireOldMaster });
      if (result.success && active) {
        containerManager.updateInstanceFleetTransfer(instance.id, null);
        containerManager.broadcastBotUpdated(instance.id);
      }
      return result;
    }
    // Parked earlier: the standby exists, so the seed is behind us; the
    // pipeline re-checks the apply and the catch-up from the app's own facts.
    if (!hasAppHooks(instance)) return { success: false, error: 'this app declares no lifecycle hooks' };
    const startedAt = openRun(instance.id, 'applying', opts.retireOldMaster === true);
    void runSeedFirst(instance.id, startedAt);
    return { success: true, started: true, resumed: true };
  }
  if (!hasAppHooks(instance)) return { success: false, error: 'this app declares no lifecycle hooks' };
  // Continuing a run whose seed never reached a standby record: the endpoint
  // that run served is on the seed's own record, so it is not asked for twice.
  const seed = active ? instance.fleetDbReplicaSeed : undefined;
  const given = (opts.publicHost || '').trim();
  const publicHost = given || seed?.publicHost || '';
  const hostPort = given ? opts.hostPort : seed?.hostPort;
  if (!publicHost) {
    return { success: false, error: 'this node holds no standby yet, so the transfer seeds one first and needs this machine\'s public host (and port) for the copy it will serve' };
  }
  const started = await fleetReplica.provisionFleetReplicaFromFacts(instance, publicHost, hostPort);
  if (!started.success) return { success: false, error: started.error };
  const startedAt = openRun(instance.id, 'seeding', opts.retireOldMaster === true);
  void runSeedFirst(instance.id, startedAt);
  return { success: true, started: true, seedFirst: true };
}

async function runSeedFirst(botId: string, startedAt: number): Promise<void> {
  const owns = (): boolean => {
    const run = currentRun(botId);
    return !!run && run.startedAt === startedAt && run.parked !== true;
  };
  try {
    // The seed reports through its own record and its own timeouts (every
    // step of it is bounded), so this waits on that record alone.
    for (;;) {
      if (!owns()) return;
      const bot = containerManager.getBot(botId);
      if (!bot) return;
      const seed = bot.fleetDbReplicaSeed;
      // Only a LIVE seed is waited on: with a standby on record, an old parked
      // seed is history, not this run's outcome.
      if (!seed || seed.parked) {
        if (bot.fleetDbReplica) break;
        throw new Error(seed?.parked ? `the seed stopped: ${seed.lastError || 'unknown reason'}` : 'the seed ended without leaving a standby (it was cancelled or dismissed)');
      }
      await sleep(POLL_MS);
    }

    // The app learns its standby from its container environment, which only a
    // recreate rewrites. Whether that happened is the app's own fact, not the
    // record's: a stale 'running' or an unmarked project are both answered by
    // Start, which reconciles the record and applies in place or starts cold.
    saveRun(botId, { phase: 'applying' });
    const before = containerManager.getBot(botId);
    if (!before) return;
    const knows = await getAppFacts(before, FACTS_TIMEOUT_MS);
    const appReady = knows.success && knows.facts?.running === true && knows.facts.initialized === true && knows.facts.dbReplica === true;
    if (!appReady) {
      if (before.status === 'running' && before.pendingApply !== true) await containerManager.markPendingApplyIfRunning(botId);
      const started = await containerManager.startBot(botId);
      if (!started.success) throw new Error(`the app could not be started with its standby: ${started.error}`);
    }
    const bootDeadline = Date.now() + BOOT_WAIT_MS;
    for (;;) {
      if (!owns()) return;
      const bot = containerManager.getBot(botId);
      if (!bot) return;
      const facts = await getAppFacts(bot, FACTS_TIMEOUT_MS);
      if (facts.success && facts.facts?.running && facts.facts.initialized && facts.facts.dbReplica === true) break;
      if (Date.now() > bootDeadline) {
        const why = !facts.success ? facts.error : facts.facts?.dbReplica === false ? 'it runs without its standby endpoint' : 'it is still initializing';
        throw new Error(`the app did not come up with its standby within 3 minutes (${why})`);
      }
      await sleep(POLL_MS);
    }

    saveRun(botId, { phase: 'catching-up' });
    const catchDeadline = Date.now() + CATCHUP_WAIT_MS;
    let notStreamingSince: number | null = null;
    for (;;) {
      if (!owns()) return;
      const bot = containerManager.getBot(botId);
      if (!bot) return;
      if (!bot.fleetDbReplica) throw new Error('the standby was removed while the transfer waited for it');
      const live = (await fleetReplica.getFleetReplicaStatus(bot)).live;
      if (live?.running && live.inRecovery === false) {
        throw new Error('the copy left recovery before the promote ran; adopt it if this machine now serves the fleet, or remove it');
      }
      const streaming = !!(live?.running && live.inRecovery && live.receiverStatus === 'streaming');
      if (streaming && live?.caughtUp === true) break;
      // A copy that is up but not receiving has a primary that is not
      // answering: the app's promote names that case (the lag confirm, or a
      // refusal), so it is asked without waiting the deadline out. A blip that
      // ends within the grace is a reconnect, and the wait goes on.
      if (streaming) {
        notStreamingSince = null;
      } else if (live?.running && live.inRecovery) {
        if (notStreamingSince === null) notStreamingSince = Date.now();
        else if (Date.now() - notStreamingSince >= NOT_STREAMING_GRACE_MS) break;
      } else {
        notStreamingSince = null;
      }
      if (Date.now() > catchDeadline) {
        const why = !live?.running ? 'the standby container is not running' : `receiver ${live.receiverStatus || 'not connected'}`;
        throw new Error(`the standby did not catch up within 10 minutes (${why})`);
      }
      await sleep(POLL_MS);
    }

    saveRun(botId, { phase: 'promoting' });
    const bot = containerManager.getBot(botId);
    if (!bot) return;
    const result = await promoteSide(bot, { confirmLag: false, retireOldMaster: currentRun(botId)?.retireOldMaster === true });
    if (!result.success) {
      // The primary died between the copy and the promote: the app wants the
      // lag acknowledged, which is the operator's answer, given by pressing
      // Transfer again on the standby that now exists.
      throw new Error(result.needsLagConfirm
        ? `${result.error || 'the app wants the replication lag acknowledged'}; the standby now exists, so Continue transfer on the standby panel answers it`
        : (result.error || 'the app refused the promote'));
    }
    if (owns()) {
      containerManager.updateInstanceFleetTransfer(botId, null);
      containerManager.broadcastBotUpdated(botId);
    }
  } catch (err) {
    if (owns()) saveRun(botId, { parked: true, lastError: String(err instanceof Error ? err.message : err) });
  }
}

/** Dismiss a parked run; a live one is followed through, never dismissed. */
export function dismissTransfer(instance: InstanceConfig): { success: boolean; error?: string } {
  const run = instance.fleetTransfer;
  if (!run) return { success: false, error: 'No transfer is recorded on this instance' };
  if (!run.parked) return { success: false, error: `The transfer is running (${run.phase}); wait for it to finish` };
  containerManager.updateInstanceFleetTransfer(instance.id, null);
  return { success: true };
}

/**
 * Boot: a run the previous manager process owned has no runner any more. It is
 * parked for display; pressing Transfer again resumes from the state on record
 * (the seed it waited on is parked by parkInterruptedReplicaSeeds).
 */
export function parkInterruptedTransfers(): void {
  for (const instance of containerManager.getAllBots()) {
    const run = instance.fleetTransfer;
    if (!run || run.parked) continue;
    console.log(`[FleetTransfer] ${instance.displayName} was transferring (${run.phase}) when the manager stopped - parking it`);
    const hint = run.phase === 'promoting'
      ? 'the app may be promoting on its own; check its Fleet view before continuing'
      : 'use Continue transfer on the standby panel';
    containerManager.updateInstanceFleetTransfer(instance.id, {
      ...run,
      parked: true,
      lastError: `the manager restarted during the transfer (phase ${run.phase}); ${hint}`,
      updatedAt: Date.now(),
    });
  }
}
