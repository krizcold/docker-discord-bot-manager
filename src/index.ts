/**
 * Discord Bot Manager
 * Main Entry Point
 *
 * A Docker-in-Docker application for managing multiple Discord bots
 */

import { startServer } from './webui/server';
import { checkDockerConnection } from './docker/dockerClient';
import { syncContainerStates } from './docker/containerManager';
import { migrateV1toV2 } from './migration/v1ToV2';
import { seedDefaultSources } from './source/sourceManager';
import { startSourceUpdater, stopSourceUpdater } from './source/sourceUpdater';
import { startInstanceUpdater, stopInstanceUpdater } from './instance/instanceUpdater';

async function main(): Promise<void> {
  console.log('='.repeat(50));
  console.log('Discord Bot Manager - Starting up...');
  console.log('='.repeat(50));

  // Check Docker connection
  console.log('[Init] Checking Docker connection...');
  const dockerConnected = await checkDockerConnection();

  if (!dockerConnected) {
    console.error('[Init] ERROR: Cannot connect to Docker daemon!');
    console.error('[Init] Make sure Docker socket is mounted at /var/run/docker.sock');
    process.exit(1);
  }

  console.log('[Init] Docker connection OK');

  // Run V1 -> V2 migration (idempotent)
  console.log('[Init] Checking for data migration...');
  await migrateV1toV2();

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
