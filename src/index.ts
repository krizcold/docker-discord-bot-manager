/**
 * Discord Bot Manager
 * Main Entry Point
 *
 * A Docker-in-Docker application for managing multiple Discord bots
 */

import { execSync } from 'child_process';
import { startServer } from './webui/server';
import { checkDockerConnection } from './docker/dockerClient';
import { syncContainerStates, resetTransientStatuses } from './docker/containerManager';
import { seedDefaultSources } from './source/sourceManager';
import { startSourceUpdater, stopSourceUpdater } from './source/sourceUpdater';
import { startInstanceUpdater, stopInstanceUpdater } from './instance/instanceUpdater';
import { startFleetBackupScheduler, stopFleetBackupScheduler } from './instance/fleetBackup';
import { startStateReconciler, stopStateReconciler } from './docker/stateReconciler';
import { getDeploymentMode } from './casaos/detector';

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

  // Shared manager<->bot network (docker mode only; no-op on CasaOS/Yundera)
  await ensureInternalNetwork();

  // Seed default sources on first run
  seedDefaultSources();

  // Sync container states on startup (ops interrupted by a restart first)
  console.log('[Init] Syncing container states...');
  resetTransientStatuses();
  await syncContainerStates();

  // Start web server
  console.log('[Init] Starting web server...');
  const { wss } = startServer();

  // Start source auto-update scheduler
  startSourceUpdater();

  // Start instance auto-update scheduler
  startInstanceUpdater();

  // Start fleet Postgres sidecar backup scheduler
  startFleetBackupScheduler();

  // Start Docker<->registry state reconciler (polls only while UI clients are connected)
  startStateReconciler(() => wss.clients.size);
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Shutdown] Received SIGTERM, shutting down...');
  stopSourceUpdater();
  stopInstanceUpdater();
  stopFleetBackupScheduler();
  stopStateReconciler();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[Shutdown] Received SIGINT, shutting down...');
  stopSourceUpdater();
  stopInstanceUpdater();
  stopFleetBackupScheduler();
  stopStateReconciler();
  process.exit(0);
});

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
