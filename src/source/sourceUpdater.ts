/**
 * Source Update Scheduler
 *
 * Periodically fetches sources with autoUpdate enabled.
 * Sources are updated (git pull), but instances are NOT auto-rebuilt.
 * The UI shows "Update available" badges based on commit mismatch.
 *
 * Replaces the old per-bot autoUpdater.
 */

import * as sourceManager from './sourceManager';

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

let intervalHandle: ReturnType<typeof setInterval> | null = null;

// WebSocket broadcast function — set by wiring code
let broadcastFn: ((type: string, data: unknown) => void) | null = null;

/**
 * Set the WebSocket broadcast function (called from server wiring).
 */
export function setSourceBroadcast(fn: (type: string, data: unknown) => void): void {
  broadcastFn = fn;
}

/**
 * Run a single update cycle for all sources with autoUpdate enabled.
 */
async function runSourceUpdateCycle(): Promise<void> {
  const sources = sourceManager.getAllSources();

  for (const source of sources) {
    if (!source.autoUpdate) continue;

    // Skip sources that haven't been cloned yet — don't auto-clone default sources
    if (!source.lastChecked) continue;

    try {
      const result = await sourceManager.fetchSource(source.id);

      if (result.hasUpdates) {
        console.log(`[SourceUpdater] Source ${source.id} updated (${result.behindBy} new commits pulled)`);

        // Broadcast so UI can show "Update available" on instances
        if (broadcastFn) {
          const updatedSource = sourceManager.getSource(source.id);
          broadcastFn('source:updated', updatedSource);
        }
      }
    } catch (error) {
      console.error(`[SourceUpdater] Error fetching source ${source.id}:`, error);
      if (broadcastFn) {
        broadcastFn('source:fetch-failed', { id: source.id, error: String(error) });
      }
    }
  }
}

/**
 * Start the source update scheduler.
 */
export function startSourceUpdater(): void {
  if (intervalHandle) return;

  console.log(`[SourceUpdater] Started (interval: ${CHECK_INTERVAL_MS / 60000}min)`);

  intervalHandle = setInterval(() => {
    runSourceUpdateCycle().catch(err => {
      console.error('[SourceUpdater] Cycle error:', err);
    });
  }, CHECK_INTERVAL_MS);
}

/**
 * Stop the source update scheduler.
 */
export function stopSourceUpdater(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[SourceUpdater] Stopped');
  }
}
