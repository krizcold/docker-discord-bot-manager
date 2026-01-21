/**
 * Discord Bot Manager
 * Main Entry Point
 *
 * A Docker-in-Docker application for managing multiple Discord bots
 */

import { startServer } from './webui/server';
import { checkDockerConnection } from './docker/dockerClient';
import { syncContainerStates } from './docker/containerManager';

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

  // Sync container states on startup
  console.log('[Init] Syncing container states...');
  await syncContainerStates();

  // Start web server
  console.log('[Init] Starting web server...');
  startServer();
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Shutdown] Received SIGTERM, shutting down...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[Shutdown] Received SIGINT, shutting down...');
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
