/**
 * State Reconciler
 *
 * Reconciles the bot registry with actual Docker container state when the
 * bot manager's web-UI has active clients. Catches drift introduced by
 * external events (CasaOS stop, crash, host reboot, manual docker stop).
 *
 * Only polls while at least one WebSocket client is connected. Runs one
 * immediate reconcile when the first client connects to close any gap
 * that accumulated while nobody was watching.
 */

import { syncContainerStates } from './containerManager';

const POLL_INTERVAL_MS = 5000;

let intervalHandle: NodeJS.Timeout | null = null;
let running = false;
let getClientCount: (() => number) | null = null;

async function tick(): Promise<void> {
  if (running) return;
  if (getClientCount && getClientCount() === 0) return;
  running = true;
  try {
    await syncContainerStates();
  } catch (err: any) {
    console.error(`[Reconciler] Tick failed: ${err?.message || err}`);
  } finally {
    running = false;
  }
}

/**
 * Start the reconciler. Requires a callback that returns the number of
 * connected WebSocket clients so polling stops when nobody is watching.
 */
export function startStateReconciler(clientCountFn: () => number): void {
  if (intervalHandle) return;
  getClientCount = clientCountFn;
  console.log(`[Reconciler] Started (${POLL_INTERVAL_MS}ms while UI connected)`);
  intervalHandle = setInterval(tick, POLL_INTERVAL_MS);
}

export function stopStateReconciler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

/**
 * Run one immediate reconcile (called when the first WS client connects
 * to catch any drift that accumulated while the UI was closed).
 */
export function reconcileNow(): void {
  tick();
}
