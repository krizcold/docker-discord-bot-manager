/**
 * Auto-Update Scheduler
 *
 * Periodically checks for updates on bots with autoUpdate enabled.
 * When updates are found, pulls and rebuilds automatically.
 */

import * as containerManager from './docker/containerManager';
import * as repoManager from './git/repoManager';

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Run a single auto-update cycle for all bots with autoUpdate enabled.
 */
async function runAutoUpdateCycle(): Promise<void> {
  const bots = containerManager.getAllBots();

  for (const bot of bots) {
    if (!bot.autoUpdate) continue;
    if (bot.sourceType === 'docker-image') continue;

    try {
      const updates = await repoManager.checkForUpdates(bot.id);

      if (updates.hasUpdates) {
        console.log(`[AutoUpdater] Bot ${bot.name} (${bot.id}) has ${updates.behindBy} new commits, updating...`);
        const result = await containerManager.pullAndRebuild(bot.id);

        if (result.success) {
          console.log(`[AutoUpdater] Bot ${bot.name} updated successfully`);
        } else {
          console.error(`[AutoUpdater] Failed to update bot ${bot.name}: ${result.error}`);
        }
      }
    } catch (error) {
      console.error(`[AutoUpdater] Error checking bot ${bot.name}:`, error);
    }
  }
}

/**
 * Start the auto-update scheduler.
 */
export function startAutoUpdater(): void {
  if (intervalHandle) return;

  console.log(`[AutoUpdater] Started (interval: ${CHECK_INTERVAL_MS / 60000}min)`);

  intervalHandle = setInterval(() => {
    runAutoUpdateCycle().catch(err => {
      console.error('[AutoUpdater] Cycle error:', err);
    });
  }, CHECK_INTERVAL_MS);
}

/**
 * Stop the auto-update scheduler.
 */
export function stopAutoUpdater(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[AutoUpdater] Stopped');
  }
}
