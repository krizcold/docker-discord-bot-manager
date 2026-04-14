/**
 * Discord Bot Manager
 * Main Entry Point
 *
 * A Docker-in-Docker application for managing multiple Discord bots
 */

import { execSync } from 'child_process';
import { startServer } from './webui/server';
import { checkDockerConnection } from './docker/dockerClient';
import { syncContainerStates } from './docker/containerManager';
import { seedDefaultSources } from './source/sourceManager';
import { startSourceUpdater, stopSourceUpdater } from './source/sourceUpdater';
import { startInstanceUpdater, stopInstanceUpdater } from './instance/instanceUpdater';

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
    console.error('[Init] Make sure Docker socket is mounted at /var/run/docker.sock');
    process.exit(1);
  }

  console.log('[Init] Docker connection OK');

  // Seed default sources on first run
  seedDefaultSources();

  // Sync container states on startup
  console.log('[Init] Syncing container states...');
  await syncContainerStates();

  // Start web server
  console.log('[Init] Starting web server...');
  startServer();

  // Start source auto-update scheduler
  startSourceUpdater();

  // Start instance auto-update scheduler
  startInstanceUpdater();
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Shutdown] Received SIGTERM, shutting down...');
  stopSourceUpdater();
  stopInstanceUpdater();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[Shutdown] Received SIGINT, shutting down...');
  stopSourceUpdater();
  stopInstanceUpdater();
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
