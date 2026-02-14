/**
 * Container Manager
 * High-level management of bot containers
 *
 * Follows Yundera GitHub Compiler pattern:
 * - Use repo's docker-compose.yml when it exists
 * - Apply variable substitution ($APP_ID, $API_HASH, etc.)
 * - Generate compose only when repo doesn't have one
 * - Support pre-built Docker images (docker-image source type)
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { BotConfig, BotRegistry, BotStatus, BotSourceType, CreateBotRequest, UpdateBotRequest } from '../types';
import * as dockerClient from './dockerClient';
import { cloneRepository, pullRepository, getRepoPath, getBotDir, getDataPath } from '../git/repoManager';
import { detectBotType } from '../detection';
import { generateDockerfile } from '../templates/dockerfiles';
import {
  generateCompose,
  writeComposeFile,
  hasExistingCompose,
  processExistingCompose,
  generateImageCompose,
  getComposeBuildInfo,
  replaceServiceImageWithBuild
} from '../templates/compose';
import { generateHash } from '../templates/variableSubstitution';
import { getDeploymentMode } from '../casaos/detector';
import * as casaosApi from '../casaos/api';

const DATA_DIR = process.env.DATA_DIR || '/data/data';
const REGISTRY_FILE = path.join(DATA_DIR, 'bots.json');

// Simple write queue to prevent concurrent registry writes
let writeQueue: Promise<void> = Promise.resolve();

/**
 * Queue a registry write operation to prevent concurrent writes
 */
function queueRegistryWrite(operation: () => void): Promise<void> {
  writeQueue = writeQueue.then(() => {
    return new Promise<void>((resolve, reject) => {
      try {
        operation();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }).catch((error) => {
    console.error('[ContainerManager] Queued write failed:', error);
    throw error;
  });
  return writeQueue;
}

/**
 * Load bot registry from disk
 */
function loadRegistry(): BotRegistry {
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      const content = fs.readFileSync(REGISTRY_FILE, 'utf-8');
      return JSON.parse(content);
    }
  } catch (error) {
    console.error('[ContainerManager] Failed to load registry:', error);
  }
  return { bots: {} };
}

/**
 * Save bot registry to disk (internal - use saveRegistryQueued for safety)
 */
function saveRegistrySync(registry: BotRegistry): void {
  try {
    fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
  } catch (error) {
    console.error('[ContainerManager] Failed to save registry:', error);
    throw error;
  }
}

/**
 * Save bot registry to disk with queue to prevent concurrent writes
 */
function saveRegistry(registry: BotRegistry): void {
  // Queue the write but don't await - maintains sync API compatibility
  queueRegistryWrite(() => saveRegistrySync(registry));
}

/**
 * Get all registered bots
 */
export function getAllBots(): BotConfig[] {
  const registry = loadRegistry();
  return Object.values(registry.bots);
}

/**
 * Get a specific bot by ID
 */
export function getBot(botId: string): BotConfig | null {
  const registry = loadRegistry();
  return registry.bots[botId] || null;
}

/**
 * Create a new bot from a GitHub repository or Docker image
 * Supports two source types:
 * - 'git': Clone repo and use its docker-compose.yml (Yundera pattern)
 * - 'docker-image': Use pre-built image from registry
 */
export async function createBot(request: CreateBotRequest): Promise<BotConfig> {
  const registry = loadRegistry();

  const botId = uuidv4();
  const now = new Date().toISOString();
  const sourceType: BotSourceType = request.sourceType || 'git';

  // Generate tokens (Yundera-style)
  const updateToken = uuidv4();
  const authHash = generateHash();

  let detection = null;

  if (sourceType === 'git') {
    // Validate git source requirements
    if (!request.url) {
      throw new Error('url is required for git source type');
    }

    // Clone the repository (URL includes token if private)
    console.log(`[ContainerManager] Cloning repository for bot ${botId}...`);
    await cloneRepository(botId, request.url, request.branch || 'main');

    // Detect bot type
    const repoPath = getRepoPath(botId);
    detection = detectBotType(repoPath);

    console.log(`[ContainerManager] Bot ${botId} detected: type=${detection.type}, hasCompose=${detection.hasCompose}, hasDatabase=${detection.hasDatabase}`);
  } else if (sourceType === 'docker-image') {
    // Validate docker-image source requirements
    if (!request.imageRef) {
      throw new Error('imageRef is required for docker-image source type');
    }

    // Create bot directory structure (no repo cloning)
    const botDir = getBotDir(botId);
    const dataPath = getDataPath(botId);
    fs.mkdirSync(botDir, { recursive: true });
    fs.mkdirSync(dataPath, { recursive: true });

    console.log(`[ContainerManager] Bot ${botId} created for docker-image: ${request.imageRef}`);
  }

  const bot: BotConfig = {
    id: botId,
    name: request.name,
    sourceType,

    // Git source fields (URL includes token if private)
    url: request.url,
    branch: request.branch || 'main',

    // Docker image source field
    imageRef: request.imageRef,

    // Common
    status: 'stopped',
    containerIds: [],

    // Tokens (Yundera-style)
    updateToken,
    authHash,

    // Runtime
    envVars: request.envVars || {},

    // Detection (for git source)
    botType: detection?.type,
    hasDatabase: detection?.hasDatabase,

    // Metadata
    createdAt: now,
    updatedAt: now,
  };

  registry.bots[botId] = bot;
  saveRegistry(registry);

  const logExtra = sourceType === 'git'
    ? `type: ${detection?.type}, hasCompose: ${detection?.hasCompose}, hasDatabase: ${detection?.hasDatabase}`
    : `image: ${request.imageRef}`;
  console.log(`[ContainerManager] Bot ${botId} created (sourceType: ${sourceType}, ${logExtra})`);

  return bot;
}

/**
 * Update bot configuration
 */
export async function updateBot(botId: string, update: UpdateBotRequest): Promise<BotConfig | null> {
  const registry = loadRegistry();
  const bot = registry.bots[botId];

  if (!bot) {
    return null;
  }

  if (update.name) bot.name = update.name;
  if (update.branch) bot.branch = update.branch;
  if (update.envVars) bot.envVars = { ...bot.envVars, ...update.envVars };
  bot.updatedAt = new Date().toISOString();

  registry.bots[botId] = bot;
  saveRegistry(registry);

  return bot;
}

/**
 * Delete a bot and its containers
 */
export async function deleteBot(botId: string): Promise<boolean> {
  const registry = loadRegistry();
  const bot = registry.bots[botId];

  if (!bot) {
    return false;
  }

  const deploymentMode = await getDeploymentMode();
  const appName = `bot-${botId}`;

  // Stop and remove containers if running
  try {
    if (deploymentMode === 'casaos') {
      // CasaOS mode: uninstall the app
      await casaosApi.uninstallApp(appName);
    } else {
      // Standalone Docker mode - stop all tracked containers
      const containerIds = bot.containerIds || [];
      for (const containerId of containerIds) {
        try {
          await dockerClient.stopContainer(containerId);
          await dockerClient.removeContainer(containerId);
        } catch (err) {
          console.warn(`[ContainerManager] Failed to remove container ${containerId}:`, err);
        }
      }
    }
  } catch (error) {
    console.warn(`[ContainerManager] Failed to cleanup containers for bot ${botId}:`, error);
  }

  // Remove entire bot directory (repo/, raw/, data/, env/)
  const botDir = getBotDir(botId);
  if (fs.existsSync(botDir)) {
    fs.rmSync(botDir, { recursive: true, force: true });
  }

  delete registry.bots[botId];
  saveRegistry(registry);

  console.log(`[ContainerManager] Bot ${botId} deleted`);
  return true;
}

/**
 * Update bot status in registry
 */
function updateBotStatus(botId: string, status: BotStatus, containerIds?: string[] | null): void {
  const registry = loadRegistry();
  const bot = registry.bots[botId];

  if (bot) {
    bot.status = status;
    if (status === 'running') {
      bot.hasBeenStarted = true;
    }
    if (containerIds !== undefined) {
      bot.containerIds = containerIds || [];
    }
    bot.updatedAt = new Date().toISOString();
    registry.bots[botId] = bot;
    saveRegistry(registry);
  }
}

/**
 * Start a bot container - dispatcher based on source type
 */
export async function startBot(botId: string): Promise<{ success: boolean; error?: string }> {
  const bot = getBot(botId);
  if (!bot) {
    return { success: false, error: 'Bot not found' };
  }

  if (bot.status === 'running') {
    return { success: false, error: 'Bot is already running' };
  }

  // Dispatch based on source type
  const sourceType = bot.sourceType || 'git';
  if (sourceType === 'docker-image') {
    return startDockerImageBot(bot);
  } else {
    return startGitBot(bot);
  }
}

/**
 * Start a bot from git repository (Yundera pattern)
 * - Uses repo's docker-compose.yml when it exists
 * - Checks x-casaos.build for which service to build locally
 * - Applies variable substitution
 * - Falls back to generation if no compose file
 */
async function startGitBot(bot: BotConfig): Promise<{ success: boolean; error?: string }> {
  const botId = bot.id;

  try {
    updateBotStatus(botId, 'building');

    const repoPath = getRepoPath(botId);
    const botDir = getBotDir(botId);
    const dataPath = getDataPath(botId);
    const imageName = `bot-${botId}:latest`;
    const appName = `bot-${botId}`;

    // Ensure data directory exists
    fs.mkdirSync(dataPath, { recursive: true });

    // Detect bot type
    const detection = detectBotType(repoPath);

    // Prepare env vars with Bot Manager token
    const envWithToken = {
      ...bot.envVars,
      BOT_MANAGER_UPDATE_TOKEN: bot.updateToken || ''
    };
    const botWithEnv: BotConfig = { ...bot, envVars: envWithToken };

    // Check for existing compose file in repo (Yundera pattern)
    const existingComposePath = hasExistingCompose(repoPath);
    let composeContent: string;
    let buildTarget: string | null = null;

    if (existingComposePath) {
      // USE REPO'S COMPOSE FILE (Yundera pattern)
      console.log(`[ContainerManager] Using existing compose file: ${existingComposePath}`);

      // Check for x-casaos.build target
      const buildInfo = getComposeBuildInfo(repoPath);
      buildTarget = buildInfo.buildTarget;

      if (buildTarget) {
        console.log(`[ContainerManager] Found x-casaos.build target: ${buildTarget}`);
      }

      composeContent = processExistingCompose(repoPath, botDir, botWithEnv);

      // If there's a build target, replace its image with local build config
      if (buildTarget) {
        composeContent = replaceServiceImageWithBuild(composeContent, buildTarget, repoPath, imageName);
      }
    } else {
      // NO COMPOSE - detect and generate (fallback)
      console.log(`[ContainerManager] No compose file found, generating for ${detection.type} bot`);

      // Generate Dockerfile if needed
      if (!detection.hasDockerfile && detection.type !== 'compose') {
        console.log(`[ContainerManager] Generating Dockerfile for ${detection.type} bot`);
        const dockerfile = generateDockerfile(detection);
        fs.writeFileSync(path.join(repoPath, 'Dockerfile'), dockerfile);
      }

      composeContent = generateCompose(botWithEnv, detection, botDir);
      // When we generate compose, we always build
      buildTarget = 'bot';
    }

    // Write processed compose to bot directory
    writeComposeFile(botDir, composeContent);

    // Check deployment mode
    const deploymentMode = await getDeploymentMode();
    const composePath = path.join(botDir, 'docker-compose.yml');

    if (deploymentMode === 'casaos') {
      // CasaOS mode: use docker compose up -d
      console.log(`[ContainerManager] Deploying bot ${botId} via CasaOS (docker compose)`);

      // Build image only if there's a build target (x-casaos.build or generated compose)
      if (buildTarget) {
        console.log(`[ContainerManager] Building image for service '${buildTarget}'...`);
        await dockerClient.buildImage(repoPath, imageName, (msg) => {
          console.log(`[Build ${botId}] ${msg}`);
        });
      } else {
        console.log(`[ContainerManager] No build target - docker compose will pull images`);
      }

      updateBotStatus(botId, 'starting');

      // Deploy via docker compose (will pull pre-built images as needed)
      const deployed = await casaosApi.deployApp(appName, composePath);
      if (!deployed) {
        throw new Error('Failed to deploy via docker compose');
      }

      // Get all container IDs for this bot (multi-container support)
      const containerIds = await getContainerIdsForBot(botId);
      updateBotStatus(botId, 'running', containerIds);
      console.log(`[ContainerManager] Bot ${botId} deployed via CasaOS (${containerIds.length} containers)`);
    } else {
      // Standalone Docker mode: use Docker API
      console.log(`[ContainerManager] Deploying bot ${botId} via Docker API`);

      // Build Docker image only if there's a build target
      if (buildTarget) {
        console.log(`[ContainerManager] Building image for service '${buildTarget}'...`);
        await dockerClient.buildImage(repoPath, imageName, (msg) => {
          console.log(`[Build ${botId}] ${msg}`);
        });
      }

      updateBotStatus(botId, 'starting');

      // Create and start container with data volume
      console.log(`[ContainerManager] Creating container for bot ${botId}...`);
      const containerId = await dockerClient.createBotContainer(
        botId,
        imageName,
        envWithToken,
        dataPath
      );

      console.log(`[ContainerManager] Starting container ${containerId}...`);
      await dockerClient.startContainer(containerId);

      updateBotStatus(botId, 'running', [containerId]);
      console.log(`[ContainerManager] Bot ${botId} started successfully`);
    }

    return { success: true };
  } catch (error) {
    console.error(`[ContainerManager] Failed to start git bot ${botId}:`, error);
    updateBotStatus(botId, 'error');
    return { success: false, error: String(error) };
  }
}

/**
 * Start a bot from pre-built Docker image
 * - No git cloning
 * - Generates minimal compose with image reference
 * - Pulls image from registry
 */
async function startDockerImageBot(bot: BotConfig): Promise<{ success: boolean; error?: string }> {
  const botId = bot.id;

  if (!bot.imageRef) {
    return { success: false, error: 'imageRef is required for docker-image source type' };
  }

  try {
    updateBotStatus(botId, 'building');

    const botDir = getBotDir(botId);
    const dataPath = getDataPath(botId);
    const appName = `bot-${botId}`;

    // Ensure directories exist
    fs.mkdirSync(botDir, { recursive: true });
    fs.mkdirSync(dataPath, { recursive: true });

    // Prepare env vars with Bot Manager token
    const envWithToken = {
      ...bot.envVars,
      BOT_MANAGER_UPDATE_TOKEN: bot.updateToken || ''
    };
    const botWithEnv: BotConfig = { ...bot, envVars: envWithToken };

    // Generate compose for docker-image source
    console.log(`[ContainerManager] Generating compose for docker-image: ${bot.imageRef}`);
    const composeContent = generateImageCompose(botWithEnv, botDir);
    writeComposeFile(botDir, composeContent);

    // Check deployment mode
    const deploymentMode = await getDeploymentMode();
    const composePath = path.join(botDir, 'docker-compose.yml');

    if (deploymentMode === 'casaos') {
      // CasaOS mode: use docker compose up -d (will pull image)
      console.log(`[ContainerManager] Deploying docker-image bot ${botId} via CasaOS`);

      updateBotStatus(botId, 'starting');

      // Deploy via docker compose (docker compose will pull the image)
      const deployed = await casaosApi.deployApp(appName, composePath);
      if (!deployed) {
        throw new Error('Failed to deploy via docker compose');
      }

      // Get all container IDs for this bot
      const containerIds = await getContainerIdsForBot(botId);
      updateBotStatus(botId, 'running', containerIds);
      console.log(`[ContainerManager] Docker-image bot ${botId} deployed via CasaOS`);
    } else {
      // Standalone Docker mode: pull image and create container
      console.log(`[ContainerManager] Deploying docker-image bot ${botId} via Docker API`);

      // Pull the image
      console.log(`[ContainerManager] Pulling image ${bot.imageRef}...`);
      await dockerClient.pullImage(bot.imageRef);

      updateBotStatus(botId, 'starting');

      // Create and start container
      console.log(`[ContainerManager] Creating container for bot ${botId}...`);
      const containerId = await dockerClient.createBotContainer(
        botId,
        bot.imageRef,
        envWithToken,
        dataPath
      );

      console.log(`[ContainerManager] Starting container ${containerId}...`);
      await dockerClient.startContainer(containerId);

      updateBotStatus(botId, 'running', [containerId]);
      console.log(`[ContainerManager] Docker-image bot ${botId} started successfully`);
    }

    return { success: true };
  } catch (error) {
    console.error(`[ContainerManager] Failed to start docker-image bot ${botId}:`, error);
    updateBotStatus(botId, 'error');
    return { success: false, error: String(error) };
  }
}

/**
 * Get all container IDs for a bot (multi-container support)
 */
async function getContainerIdsForBot(botId: string): Promise<string[]> {
  const containers = await dockerClient.listBotContainers();
  const appName = `bot-${botId}`;

  // Match containers by bot-id label or name pattern
  const botContainers = containers.filter(c =>
    c.name.startsWith(appName) ||
    c.name.includes(`-${botId}-`)
  );

  return botContainers.map(c => c.id);
}

/**
 * Stop a bot's containers
 */
export async function stopBot(botId: string): Promise<{ success: boolean; error?: string }> {
  const bot = getBot(botId);
  if (!bot) {
    return { success: false, error: 'Bot not found' };
  }

  if (bot.status !== 'running') {
    return { success: false, error: 'Bot is not running' };
  }

  try {
    updateBotStatus(botId, 'stopping');

    const deploymentMode = await getDeploymentMode();
    const appName = `bot-${botId}`;

    if (deploymentMode === 'casaos') {
      // CasaOS mode: use docker compose down or CasaOS API
      console.log(`[ContainerManager] Stopping bot ${botId} via CasaOS`);
      await casaosApi.stopApp(appName);
    } else {
      // Standalone Docker mode - stop all tracked containers
      const containerIds = bot.containerIds || [];
      for (const containerId of containerIds) {
        try {
          await dockerClient.stopContainer(containerId);
          await dockerClient.removeContainer(containerId);
        } catch (err) {
          console.warn(`[ContainerManager] Failed to stop container ${containerId}:`, err);
        }
      }
    }

    updateBotStatus(botId, 'stopped', []);
    console.log(`[ContainerManager] Bot ${botId} stopped`);

    return { success: true };
  } catch (error) {
    console.error(`[ContainerManager] Failed to stop bot ${botId}:`, error);
    updateBotStatus(botId, 'error');
    return { success: false, error: String(error) };
  }
}

/**
 * Restart a bot container
 */
export async function restartBot(botId: string): Promise<{ success: boolean; error?: string }> {
  const stopResult = await stopBot(botId);
  if (!stopResult.success && stopResult.error !== 'Bot is not running') {
    return stopResult;
  }

  return startBot(botId);
}

/**
 * Pull latest code and rebuild
 */
export async function pullAndRebuild(botId: string): Promise<{ success: boolean; error?: string }> {
  const bot = getBot(botId);
  if (!bot) {
    return { success: false, error: 'Bot not found' };
  }

  const wasRunning = bot.status === 'running';

  try {
    // Stop if running
    if (wasRunning) {
      await stopBot(botId);
    }

    // Pull latest code (uses URL from repo's origin remote)
    console.log(`[ContainerManager] Pulling latest code for bot ${botId}...`);
    await pullRepository(botId);

    // Restart if it was running
    if (wasRunning) {
      return startBot(botId);
    }

    return { success: true };
  } catch (error) {
    console.error(`[ContainerManager] Failed to pull and rebuild bot ${botId}:`, error);
    return { success: false, error: String(error) };
  }
}

/**
 * Get logs for a bot (from primary container or all containers)
 */
export async function getBotLogs(botId: string, tail = 100): Promise<{ success: boolean; logs?: string[]; error?: string }> {
  const bot = getBot(botId);
  if (!bot) {
    return { success: false, error: 'Bot not found' };
  }

  const containerIds = bot.containerIds || [];
  if (containerIds.length === 0) {
    return { success: false, error: 'Bot has no containers' };
  }

  try {
    // Get logs from all containers and merge
    const allLogs: string[] = [];
    for (const containerId of containerIds) {
      try {
        const logEntries = await dockerClient.getContainerLogs(containerId, Math.ceil(tail / containerIds.length));
        const containerName = containerId.substring(0, 12);
        for (const e of logEntries) {
          allLogs.push(`[${e.timestamp}] [${containerName}] ${e.message}`);
        }
      } catch (err) {
        // Container might not exist anymore
        console.warn(`[ContainerManager] Failed to get logs from container ${containerId}:`, err);
      }
    }

    // Sort by timestamp and limit to tail
    allLogs.sort();
    const logs = allLogs.slice(-tail);

    return { success: true, logs };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

/**
 * Get stats for a running bot (aggregated from all containers)
 */
export async function getBotStats(botId: string): Promise<{ success: boolean; stats?: { cpuPercent: number; memoryUsageMB: number; memoryLimitMB: number }; error?: string }> {
  const bot = getBot(botId);
  if (!bot) {
    return { success: false, error: 'Bot not found' };
  }

  const containerIds = bot.containerIds || [];
  if (containerIds.length === 0 || bot.status !== 'running') {
    return { success: false, error: 'Bot is not running' };
  }

  try {
    // Aggregate stats from all containers
    let totalCpuPercent = 0;
    let totalMemoryUsageMB = 0;
    let totalMemoryLimitMB = 0;

    for (const containerId of containerIds) {
      try {
        const stats = await dockerClient.getContainerStats(containerId);
        totalCpuPercent += stats.cpuPercent;
        totalMemoryUsageMB += stats.memoryUsageMB;
        totalMemoryLimitMB += stats.memoryLimitMB;
      } catch (err) {
        // Container might not be running
        console.warn(`[ContainerManager] Failed to get stats from container ${containerId}:`, err);
      }
    }

    return {
      success: true,
      stats: {
        cpuPercent: totalCpuPercent,
        memoryUsageMB: totalMemoryUsageMB,
        memoryLimitMB: totalMemoryLimitMB
      }
    };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

/**
 * Sync container states with registry
 * Useful on startup to detect containers that crashed or were stopped externally
 */
export async function syncContainerStates(): Promise<void> {
  const registry = loadRegistry();
  const containers = await dockerClient.listBotContainers();

  // Build a map of container name -> container info
  const containerMap = new Map(containers.map(c => [c.name, c]));

  for (const bot of Object.values(registry.bots)) {
    const appName = `bot-${bot.id}`;

    if (bot.status === 'running') {
      // Check if any tracked containers are still running
      const containerIds = bot.containerIds || [];
      const runningContainers = containers.filter(c =>
        c.name.startsWith(appName) && c.state === 'running'
      );

      if (runningContainers.length === 0) {
        // No containers running
        console.log(`[ContainerManager] Bot ${bot.id} has no running containers, updating status`);
        updateBotStatus(bot.id, 'stopped', []);
      } else if (runningContainers.length !== containerIds.length) {
        // Update container IDs to match actual running containers
        const newContainerIds = runningContainers.map(c => c.id);
        console.log(`[ContainerManager] Bot ${bot.id} container count changed: ${containerIds.length} -> ${newContainerIds.length}`);
        updateBotStatus(bot.id, 'running', newContainerIds);
      }
    }
  }

  console.log('[ContainerManager] Container state sync complete');
}
