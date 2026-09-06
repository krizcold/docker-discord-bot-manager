/**
 * Automatic re-seed of a standby whose slot the primary reports lost
 * (PLAN_REPLICATION 20.14, B4m-2b). The TRIGGER is the app's own fact as the
 * health sampler cached it (fresh, on the current master, not contradicted by
 * a streaming receiver), or this manager's own re-seed that stopped, which the
 * fact can no longer describe; every PERMIT is the manager's own and lives in
 * fleetReplica.reseedStandby. This module only decides WHEN to ask it.
 */
import * as containerManager from '../docker/containerManager';
import { getReplicationHealth } from './fleetReplicationHealth';
import { autoReseedAllowed, reseedStandby } from './fleetReplica';

const TICK_INTERVAL_MS = 60_000;
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let ticking = false;

async function runTick(): Promise<void> {
  for (const instance of containerManager.getAllBots()) {
    const rec = instance.fleetDbReplica;
    if (!rec) continue;
    const seed = instance.fleetDbReplicaSeed;
    if (seed && !seed.parked) continue;
    // A cancel is an instruction, not a pause: nothing restarts on the
    // operator's behalf until they dismiss the stopped run or ask again.
    if (seed?.cancelled === true) continue;
    // The ruled re-fire of a stopped re-seed cannot ride the slot fact: the
    // seed drops and re-creates the slot before it copies, and a standby
    // whose copy was cleared reports nothing at all. Its own parked record is
    // the trigger, and the ledger is what stops it.
    const parkedReseed = seed?.parked === true && seed.purpose === 'reseed-standby';
    if (!parkedReseed && getReplicationHealth(instance.id)?.slot?.lost !== true) continue;
    // The ledger is judged from live state: an operator's click during this
    // same tick is invisible to the snapshot the loop started with.
    const fresh = containerManager.getBot(instance.id)?.fleetDbReplica;
    if (!fresh || !autoReseedAllowed(fresh)) continue;
    if (containerManager.isBotBusy(instance.id)) continue;
    const why = parkedReseed ? `an earlier re-seed stopped (${seed?.lastError})` : `the primary reports slot ${rec.slot} lost`;
    console.log(`[FleetReplicaAuto] ${instance.displayName}: ${why}; re-seeding the standby`);
    const result = await reseedStandby(instance, 'automatic');
    if (!result.success) console.warn(`[FleetReplicaAuto] ${instance.displayName}: re-seed not started: ${result.error}`);
    containerManager.broadcastBotUpdated(instance.id);
  }
}

export function startFleetReplicaAuto(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    if (ticking) return;
    ticking = true;
    runTick()
      .catch(err => console.error('[FleetReplicaAuto] Tick error:', err))
      .finally(() => { ticking = false; });
  }, TICK_INTERVAL_MS);
  intervalHandle.unref();
}

export function stopFleetReplicaAuto(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}
