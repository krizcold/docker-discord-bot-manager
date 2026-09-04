/**
 * Instance Auto-Update Scheduler
 *
 * Runs on a 1-minute tick. For each instance with autoUpdate enabled:
 * - For daily (24h) intervals: checks at the preferred hour (default 4am)
 * - For shorter intervals: checks based on elapsed time
 *
 * Force-fetches the source, compares commits, and triggers pullAndRebuild
 * if a mismatch is detected.
 *
 * Independent from sourceUpdater (which only fetches sources, never rebuilds).
 */

import * as containerManager from '../docker/containerManager';
import * as sourceManager from '../source/sourceManager';

const TICK_INTERVAL_MS = 60 * 1000; // 1 minute
const DEFAULT_CHECK_INTERVAL_MS = 86400000; // 24 hours
const DEFAULT_CHECK_HOUR = 4; // 4am
const DAILY_THRESHOLD_MS = 24 * 60 * 60 * 1000; // intervals >= this use hour-based scheduling

let intervalHandle: ReturnType<typeof setInterval> | null = null;

// Track last check time per instance (in-memory)
const lastCheckTimes: Map<string, number> = new Map();

// WebSocket broadcast function, set by wiring code
let broadcastFn: ((type: string, data: unknown) => void) | null = null;

// Guard against concurrent rebuild of the same instance
const rebuildingInstances: Set<string> = new Set();

/**
 * Set the WebSocket broadcast function (called from server wiring).
 */
export function setInstanceBroadcast(fn: (type: string, data: unknown) => void): void {
  broadcastFn = fn;
}

/**
 * Check if an instance is due for an update check.
 * - For daily intervals (>= 24h): fires when current hour matches autoUpdateHour
 *   and at least 23h have passed since last check (prevents double-fire).
 * - For shorter intervals: fires based on elapsed time.
 */
function isDueForCheck(bot: { id: string; autoUpdateInterval?: number; autoUpdateHour?: number }): boolean {
  const checkInterval = bot.autoUpdateInterval || DEFAULT_CHECK_INTERVAL_MS;
  const lastCheck = lastCheckTimes.get(bot.id) || 0;
  const now = Date.now();
  const elapsed = now - lastCheck;

  if (checkInterval >= DAILY_THRESHOLD_MS) {
    // Hour-based scheduling for daily+ intervals
    const preferredHour = bot.autoUpdateHour ?? DEFAULT_CHECK_HOUR;
    const currentHour = new Date().getHours();
    // Must be the right hour AND enough time since last check (23h guard)
    return currentHour === preferredHour && elapsed >= checkInterval - 3600000;
  }

  // Elapsed-time scheduling for shorter intervals
  return elapsed >= checkInterval;
}

/**
 * Run a single tick: check all instances with autoUpdate enabled.
 */
async function runInstanceUpdateTick(): Promise<void> {
  const bots = containerManager.getAllBots();

  for (const bot of bots) {
    if (!bot.autoUpdate) continue;
    if (bot.sourceType !== 'git' || !bot.sourceId) continue;
    if (rebuildingInstances.has(bot.id)) continue;

    if (!isDueForCheck(bot)) continue;

    lastCheckTimes.set(bot.id, Date.now());

    try {
      // Force-fetch the source to get latest remote state
      const fetchResult = await sourceManager.fetchSource(bot.sourceId);
      const source = sourceManager.getSource(bot.sourceId);

      if (!source || !source.lastCommitHash) continue;
      if (!bot.lastBuiltCommit) continue;
      if (bot.lastBuiltCommit === source.lastCommitHash) continue;

      // Mismatch detected: auto-rebuild
      console.log(`[InstanceUpdater] Instance ${bot.displayName} (${bot.id}) is behind source; triggering auto-rebuild`);
      rebuildingInstances.add(bot.id);

      if (broadcastFn) {
        broadcastFn('bot:pulling', { id: bot.id });
      }

      const result = await containerManager.pullAndRebuild(bot.id);
      rebuildingInstances.delete(bot.id);

      if (result.success) {
        console.log(`[InstanceUpdater] Instance ${bot.displayName} rebuilt successfully`);
        if (broadcastFn) {
          broadcastFn('bot:rebuilt', containerManager.withoutRecordSecrets(containerManager.getBot(bot.id)));
        }
      } else {
        console.error(`[InstanceUpdater] Failed to rebuild ${bot.displayName}: ${result.error}`);
        if (broadcastFn) {
          broadcastFn('bot:pull-failed', { id: bot.id, error: result.error });
        }
      }
    } catch (error) {
      rebuildingInstances.delete(bot.id);
      console.error(`[InstanceUpdater] Error checking instance ${bot.id}:`, error);
    }
  }
}

/**
 * Start the instance auto-update scheduler.
 */
export function startInstanceUpdater(): void {
  if (intervalHandle) return;

  console.log(`[InstanceUpdater] Started (tick: ${TICK_INTERVAL_MS / 1000}s)`);

  intervalHandle = setInterval(() => {
    runInstanceUpdateTick().catch(err => {
      console.error('[InstanceUpdater] Tick error:', err);
    });
  }, TICK_INTERVAL_MS);
}

/**
 * Stop the instance auto-update scheduler.
 */
export function stopInstanceUpdater(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[InstanceUpdater] Stopped');
  }
}
