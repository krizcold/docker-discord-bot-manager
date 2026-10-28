/**
 * Discord Bot Manager
 * Main Entry Point
 *
 * A Docker-in-Docker application for managing multiple Discord bots
 */

import { execSync } from 'child_process';
import { startServer } from './webui/server';
import { checkDockerConnection } from './docker/dockerClient';
import { syncContainerStates, resetTransientStatuses, beginShutdown, loadOpRecords } from './docker/containerManager';
import { seedDefaultSources } from './source/sourceManager';
import { startSourceUpdater, stopSourceUpdater } from './source/sourceUpdater';
import { startInstanceUpdater, stopInstanceUpdater } from './instance/instanceUpdater';
import { startFleetBackupScheduler, stopFleetBackupScheduler, waitForInFlightLanes } from './instance/fleetBackup';
import { parkInterruptedReplicaSeeds } from './instance/fleetReplica';
import { startFleetCopyWatch, stopFleetCopyWatch } from './instance/fleetCopyWatch';
import { startMaintenanceReconciler, stopMaintenanceReconciler } from './instance/maintenance';
import { startStateReconciler, stopStateReconciler } from './docker/stateReconciler';
import { getDeploymentMode } from './casaos/detector';
import { warnOnOpenDataRoot } from './config/fileModes';

/**
 * Tell git to trust repositories under the bot manager's bind-mounted data dirs.
 * Source repos cloned inside the container sit on a host volume; their files may
 * end up owned by a UID that doesn't match the container user (PUID/PGID remap,
 * post-deploy chown by CasaOS, etc.), tripping Git 2.35+'s "dubious ownership"
 * check. Writing to /root/.gitconfig inside the container, not the host.
 */
function configureGitSafeDirectories(): void {
  try {
    execSync(`git config --global --add safe.directory '*'`, { stdio: 'pipe' });
    console.log('[Init] Git safe.directory configured');
  } catch (err: any) {
    console.warn(`[Init] Failed to configure git safe.directory: ${err?.message || err}`);
  }
}

/**
 * Docker mode: bots run in their own compose projects, so manager<->bot API traffic
 * (BOT_MANAGER_INTERNAL_URL) goes over the shared dbm_internal network, which bot
 * composes join as external. The manager's compose declares it too, but ensure it
 * here as well so a manager still running from an older compose gets connected
 * without a recreate. Never runs in casaos mode.
 */
async function ensureInternalNetwork(): Promise<void> {
  if (await getDeploymentMode() !== 'docker') return;
  const self = process.env.HOSTNAME || 'discordbotmanagerapp';
  try {
    try {
      execSync('docker network create dbm_internal', { stdio: 'pipe' });
    } catch (err: any) {
      const msg = String(err?.stderr || err?.message || err);
      if (!/already exists/i.test(msg)) throw err;
    }
    try {
      execSync(`docker network connect dbm_internal ${self}`, { stdio: 'pipe' });
    } catch (err: any) {
      const msg = String(err?.stderr || err?.message || err);
      if (!/already exists|already connected/i.test(msg)) throw err;
    }
    console.log('[Init] dbm_internal network ready (manager connected)');
  } catch (err: any) {
    console.warn(`[Init] Could not ensure dbm_internal network: ${String(err?.stderr || err?.message || err).trim()}`);
  }
}

async function main(): Promise<void> {
  console.log('='.repeat(50));
  console.log('Discord Bot Manager - Starting up...');
  console.log('='.repeat(50));

  // Git ownership workaround for bind-mounted source repos
  configureGitSafeDirectories();

  // Check Docker connection
  console.log('[Init] Checking Docker connection...');
  const dockerConnected = await checkDockerConnection();

  if (!dockerConnected) {
    console.error('[Init] ERROR: Cannot connect to Docker daemon!');
    console.error('[Init] Mount the Docker socket: -v /var/run/docker.sock:/var/run/docker.sock');
    console.error('[Init] (Docker Desktop exposes the daemon at that path on Windows too).');
    process.exit(1);
  }

  console.log('[Init] Docker connection OK');

  // A store that cannot be read (config.json, sources.json) refuses these
  // steps; the manager still starts so the web UI can name the problem.
  try { await warnOnOpenDataRoot(); } catch (err: any) { console.warn(`[Init] ${err?.message || err}`); }

  // Shared manager<->bot network (docker mode only; no-op on CasaOS/Yundera)
  try { await ensureInternalNetwork(); } catch (err: any) { console.warn(`[Init] ${err?.message || err}`); }

  // Seed default sources on first run
  try { seedDefaultSources(); } catch (err: any) { console.warn(`[Init] Default sources not seeded: ${err?.message || err}`); }

  // Sync container states on startup (ops interrupted by a restart first)
  console.log('[Init] Syncing container states...');
  // Each pass is best effort: a DATA_DIR that refuses writes must not keep the
  // manager (and the web UI that names the problem) from starting.
  const bootPass = async (name: string, pass: () => unknown): Promise<void> => {
    try { await pass(); } catch (err: any) { console.warn(`[Init] ${name} did not complete: ${err?.message || err}`); }
  };
  await bootPass('Operation record read', loadOpRecords);
  await bootPass('Transient status reset', resetTransientStatuses);
  await bootPass('Container state sync', syncContainerStates);
  await bootPass('Replica seed park', parkInterruptedReplicaSeeds);

  // Start web server
  console.log('[Init] Starting web server...');
  const { wss } = startServer();

  // Resumes the state orders a restart cut, then keeps the database logins in line with each bot's state.
  startMaintenanceReconciler();

  // Start source auto-update scheduler
  startSourceUpdater();

  // Start instance auto-update scheduler
  startInstanceUpdater();

  // Start fleet Postgres sidecar backup scheduler
  startFleetBackupScheduler();
  startFleetCopyWatch();

  // Start Docker<->registry state reconciler (polls only while UI clients are connected)
  startStateReconciler(() => wss.clients.size);
}

// Below the compose files' stop_grace_period, so the exit is the manager's and not docker's kill.
const SHUTDOWN_LANE_WAIT_MS = 120_000;

// Handle graceful shutdown
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  beginShutdown();
  console.log(`[Shutdown] Received ${signal}, shutting down...`);
  stopSourceUpdater();
  stopInstanceUpdater();
  stopFleetBackupScheduler();
  stopFleetCopyWatch();
  stopMaintenanceReconciler();
  void waitForInFlightLanes(SHUTDOWN_LANE_WAIT_MS).then(lane => {
    if (lane) console.error(`[Shutdown] Exiting with a lane still running, which is cut short: ${lane}`);
    stopStateReconciler();
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('[Error] Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Error] Unhandled rejection:', reason);
});

// Start the application
main().catch((error) => {
  console.error('[Fatal] Failed to start:', error);
  process.exit(1);
});
