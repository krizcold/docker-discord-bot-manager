/**
 * State Reconciler
 *
 * Reconciles the bot registry with actual Docker container state. Catches
 * drift introduced by external events (CasaOS stop, crash, host reboot,
 * manual docker stop).
 *
 * Polls every POLL_INTERVAL_MS while a web-UI client is connected and every
 * IDLE_INTERVAL_MS otherwise, so the CLI and status-gated refusals never read
 * a record nobody reconciled. Runs one immediate reconcile when the first
 * client connects.
 */

import { syncContainerStates } from './containerManager';

const POLL_INTERVAL_MS = 5000;
const IDLE_INTERVAL_MS = 30000;

let intervalHandle: NodeJS.Timeout | null = null;
let running = false;
let getClientCount: (() => number) | null = null;
let lastRunAt = 0;

async function tick(force = false): Promise<void> {
  if (running) return;
  const idle = getClientCount ? getClientCount() === 0 : false;
  if (!force && idle && Date.now() - lastRunAt < IDLE_INTERVAL_MS - POLL_INTERVAL_MS / 2) return;
  running = true;
  lastRunAt = Date.now();
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
 * connected WebSocket clients, which sets the polling cadence.
 */
export function startStateReconciler(clientCountFn: () => number): void {
  if (intervalHandle) return;
  getClientCount = clientCountFn;
  console.log(`[Reconciler] Started (${POLL_INTERVAL_MS}ms while UI connected, ${IDLE_INTERVAL_MS}ms otherwise)`);
  intervalHandle = setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
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
  void tick(true);
}
