/**
 * Container Manager
 * High-level management of bot containers
 *
 * - Uses repo's docker-compose.yml when it exists
 * - Applies variable substitution ($APP_ID, $API_HASH, etc.)
 * - Generates compose only when repo doesn't have one
 * - Supports pre-built Docker images (docker-image source type)
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
  replaceServiceImageWithBuild,
  ComposeResult
} from '../templates/compose';
import { generateHash } from '../templates/variableSubstitution';
import {
  createVolumeDirectories,
  saveToCasaOSMetadata,
  removeCasaOSMetadata,
  removeAppData,
  fixPostDeployOwnership,
  executeInstallCommand
} from '../templates/pcsProcessing';
import { getDeploymentMode } from '../casaos/detector';
import * as casaosApi from '../casaos/api';
import { logCollectors, LogCollector } from '../build/logCollector';

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
 * - 'git': Clone repo and use its docker-compose.yml
 * - 'docker-image': Use pre-built image from registry
 */
export async function createBot(request: CreateBotRequest): Promise<BotConfig> {
  const registry = loadRegistry();

  const botId = uuidv4();
  const now = new Date().toISOString();
  const sourceType: BotSourceType = request.sourceType || 'git';

  // Generate authentication tokens
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

    // Authentication tokens
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
  const appName = bot.appName || `bot-${botId}`;
  const botDir = getBotDir(botId);

  // 1. Compose down — stop and remove all containers/networks
  try {
    if (deploymentMode === 'casaos') {
      const pcsDataRoot = process.env.DATA_ROOT || '/DATA';
      const metadataComposePath = path.join(pcsDataRoot, 'AppData', 'casaos', 'apps', appName, 'docker-compose.yml');
      const localComposePath = path.join(botDir, 'docker-compose.yml');
      const composePath = fs.existsSync(metadataComposePath) ? metadataComposePath : localComposePath;

      if (fs.existsSync(composePath)) {
        console.log(`[ContainerManager] Running compose down for ${appName}...`);
        await casaosApi.composeDown(appName, composePath);
      }

      // Also uninstall via CasaOS API for clean state
      await casaosApi.uninstallApp(appName);
    } else {
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

  // 2. Remove Docker image
  try {
    const imageName = `bot-${botId}:latest`;
    if (dockerClient.imageExists(imageName)) {
      console.log(`[ContainerManager] Removing image ${imageName}...`);
      dockerClient.removeImage(imageName);
    }
  } catch (error) {
    console.warn(`[ContainerManager] Failed to remove image for bot ${botId}:`, error);
  }

  // 3. Remove named volumes belonging to this project
  try {
    const volumes = dockerClient.listProjectVolumes(appName);
    for (const volumeName of volumes) {
      console.log(`[ContainerManager] Removing volume ${volumeName}...`);
      dockerClient.removeVolume(volumeName);
    }
  } catch (error) {
    console.warn(`[ContainerManager] Failed to remove volumes for bot ${botId}:`, error);
  }

  // 4. Remove CasaOS metadata directory
  try {
    await removeCasaOSMetadata(appName);
  } catch (error) {
    console.warn(`[ContainerManager] Failed to remove CasaOS metadata for bot ${botId}:`, error);
  }

  // 5. Remove app data directory (/DATA/AppData/{appName}/)
  try {
    await removeAppData(appName);
  } catch (error) {
    console.warn(`[ContainerManager] Failed to remove app data for bot ${botId}:`, error);
  }

  // 6. Remove entire bot directory (repo/, raw/, data/, env/)
  if (fs.existsSync(botDir)) {
    fs.rmSync(botDir, { recursive: true, force: true });
  }

  delete registry.bots[botId];
  saveRegistry(registry);

  // Clean up log collector
  logCollectors.remove(botId);

  console.log(`[ContainerManager] Bot ${botId} fully deleted (containers, image, volumes, metadata, app data)`);
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
 * Update bot's appName in registry
 */
function updateBotAppName(botId: string, appName: string): void {
  const registry = loadRegistry();
  const bot = registry.bots[botId];
  if (bot) {
    bot.appName = appName;
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
 * Start a bot from git repository
 * - Uses repo's docker-compose.yml when it exists
 * - Checks x-casaos.build for which service to build locally
 * - Applies variable substitution
 * - Falls back to generation if no compose file
 */
async function startGitBot(bot: BotConfig): Promise<{ success: boolean; error?: string }> {
  const botId = bot.id;
  const log = logCollectors.get(botId);
  log.clear();

  const emit = (msg: string, type: 'system' | 'info' | 'warning' | 'error' | 'success' = 'info') => {
    console.log(`[Start ${botId}] ${msg}`);
    log.addLog(msg, type);
  };

  try {
    emit(`[Start] Starting ${bot.name}...`, 'system');

    // Re-read bot from registry to get latest appName (may have been set by buildBot)
    const latestBot = getBot(botId) || bot;
    const botDir = getBotDir(botId);
    const appName = latestBot.appName || `bot-${botId}`;
    const localComposePath = path.join(botDir, 'docker-compose.yml');

    // If compose file doesn't exist, run buildBot first (safety net)
    if (!fs.existsSync(localComposePath)) {
      emit('[Build] No compose file found, running build first...', 'info');
      const buildResult = await buildBot(botId);
      if (!buildResult.success) {
        throw new Error(`Build failed: ${buildResult.error || 'unknown error'}`);
      }
    }

    // Start containers using the existing compose file
    const deploymentMode = await getDeploymentMode();

    if (deploymentMode === 'casaos') {
      // Prefer metadata compose path (CasaOS recognizes this location)
      const pcsDataRoot = process.env.DATA_ROOT || '/DATA';
      const metadataComposePath = path.join(pcsDataRoot, 'AppData', 'casaos', 'apps', appName, 'docker-compose.yml');
      const composePath = fs.existsSync(metadataComposePath) ? metadataComposePath : localComposePath;

      emit(`[Start] Starting containers (${appName})...`, 'info');
      updateBotStatus(botId, 'starting');

      const deployResult = await casaosApi.deployApp(appName, composePath, (msg) => {
        emit(`[Compose] ${msg}`, 'info');
      });
      if (!deployResult.success) {
        throw new Error(`Failed to deploy via docker compose: ${deployResult.error || 'unknown error'}`);
      }

      // Brief delay for CasaOS recognition
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Fix post-deploy ownership
      emit('[PCS] Fixing post-deploy ownership...', 'info');
      await fixPostDeployOwnership(appName, (msg) => emit(msg, 'info'));

      // Execute post-install command on first start
      if (!latestBot.hasBeenStarted) {
        const composeContent = fs.readFileSync(composePath, 'utf-8');
        await executeInstallCommand('post', composeContent, (msg) => emit(msg, 'info'));
      }

      const containerIds = await getContainerIdsForBot(botId);
      updateBotStatus(botId, 'running', containerIds);
      emit(`[Done] Bot deployed (${containerIds.length} containers)`, 'success');
    } else {
      const imageName = `bot-${botId}:latest`;
      const dataPath = getDataPath(botId);
      const envWithToken = {
        ...bot.envVars,
        BOT_MANAGER_UPDATE_TOKEN: bot.updateToken || ''
      };

      emit('[Start] Creating container...', 'info');
      updateBotStatus(botId, 'starting');

      const containerId = await dockerClient.createBotContainer(
        botId,
        imageName,
        envWithToken,
        dataPath
      );

      emit('[Start] Starting container...', 'info');
      await dockerClient.startContainer(containerId);

      updateBotStatus(botId, 'running', [containerId]);
      emit('[Done] Bot started successfully', 'success');
    }

    emit(`[Success] ${bot.name} is now running!`, 'success');
    return { success: true };
  } catch (error) {
    const msg = String(error);
    emit(`[Error] Start failed: ${msg}`, 'error');
    emit('[Fatal] Start process terminated with error', 'error');
    console.error(`[ContainerManager] Failed to start git bot ${botId}:`, error);
    updateBotStatus(botId, 'error');
    return { success: false, error: msg };
  }
}

/**
 * Start a bot from pre-built Docker image
 * Compose file should already exist from buildBot(). If not, builds first as safety net.
 */
async function startDockerImageBot(bot: BotConfig): Promise<{ success: boolean; error?: string }> {
  const botId = bot.id;

  if (!bot.imageRef) {
    return { success: false, error: 'imageRef is required for docker-image source type' };
  }

  try {
    // Re-read bot from registry to get latest appName
    const latestBot = getBot(botId) || bot;
    const botDir = getBotDir(botId);
    const appName = latestBot.appName || `bot-${botId}`;
    const localComposePath = path.join(botDir, 'docker-compose.yml');

    // If compose file doesn't exist, run buildBot first (safety net)
    if (!fs.existsSync(localComposePath)) {
      console.log(`[ContainerManager] No compose file for docker-image bot ${botId}, running build first...`);
      const buildResult = await buildBot(botId);
      if (!buildResult.success) {
        return { success: false, error: `Build failed: ${buildResult.error || 'unknown error'}` };
      }
    }

    // Start containers using the existing compose file
    const deploymentMode = await getDeploymentMode();

    if (deploymentMode === 'casaos') {
      // Prefer metadata compose path
      const pcsDataRoot = process.env.DATA_ROOT || '/DATA';
      const metadataComposePath = path.join(pcsDataRoot, 'AppData', 'casaos', 'apps', appName, 'docker-compose.yml');
      const composePath = fs.existsSync(metadataComposePath) ? metadataComposePath : localComposePath;

      console.log(`[ContainerManager] Starting docker-image bot ${botId} via CasaOS (${appName})`);
      updateBotStatus(botId, 'starting');

      const deployResult = await casaosApi.deployApp(appName, composePath);
      if (!deployResult.success) {
        throw new Error(`Failed to deploy via docker compose: ${deployResult.error || 'unknown error'}`);
      }

      // Brief delay for CasaOS recognition
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Fix post-deploy ownership
      await fixPostDeployOwnership(appName);

      const containerIds = await getContainerIdsForBot(botId);
      updateBotStatus(botId, 'running', containerIds);
      console.log(`[ContainerManager] Docker-image bot ${botId} started via CasaOS`);
    } else {
      const dataPath = getDataPath(botId);
      const envWithToken = {
        ...bot.envVars,
        BOT_MANAGER_UPDATE_TOKEN: bot.updateToken || ''
      };

      console.log(`[ContainerManager] Starting docker-image bot ${botId} via Docker API`);
      updateBotStatus(botId, 'starting');

      const containerId = await dockerClient.createBotContainer(
        botId,
        bot.imageRef,
        envWithToken,
        dataPath
      );

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
  const bot = getBot(botId);
  const appName = bot?.appName || `bot-${botId}`;

  // Match containers by bot-id label or name pattern (compose uses appName as prefix)
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
    const appName = bot.appName || `bot-${botId}`;

    if (deploymentMode === 'casaos') {
      // CasaOS mode: use compose down to properly stop AND remove containers
      const botDir = getBotDir(botId);
      const pcsDataRoot = process.env.DATA_ROOT || '/DATA';
      const metadataComposePath = path.join(pcsDataRoot, 'AppData', 'casaos', 'apps', appName, 'docker-compose.yml');
      const localComposePath = path.join(botDir, 'docker-compose.yml');
      const composePath = fs.existsSync(metadataComposePath) ? metadataComposePath : localComposePath;

      console.log(`[ContainerManager] Stopping bot ${botId} via compose down (${appName})`);
      const downResult = await casaosApi.composeDown(appName, composePath);
      if (!downResult.success) {
        console.warn(`[ContainerManager] Compose down failed for ${appName}: ${downResult.error}`);
      }
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
 * Pull latest code, rebuild image, and optionally restart
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

    // Remove old image so buildBot builds fresh
    const imageName = `bot-${botId}:latest`;
    if (dockerClient.imageExists(imageName)) {
      console.log(`[ContainerManager] Removing old image ${imageName}...`);
      dockerClient.removeImage(imageName);
    }

    // Rebuild image and compose file
    const buildResult = await buildBot(botId);
    if (!buildResult.success) {
      return { success: false, error: `Rebuild failed: ${buildResult.error || 'unknown error'}` };
    }

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
 * Get the log collector for a bot (for SSE streaming)
 */
export function getBotLogCollector(botId: string): LogCollector {
  return logCollectors.get(botId);
}

/**
 * Build a bot's Docker image without starting it
 * For git source: detect, compose, build image
 * For docker-image source: pull the image
 *
 * All steps stream to a LogCollector for real-time UI display.
 */
export async function buildBot(botId: string): Promise<{ success: boolean; error?: string }> {
  const bot = getBot(botId);
  if (!bot) {
    return { success: false, error: 'Bot not found' };
  }

  const sourceType = bot.sourceType || 'git';
  const log = logCollectors.get(botId);
  log.clear(); // Prevent log accumulation: always start fresh

  const emit = (msg: string, type: 'system' | 'info' | 'warning' | 'error' | 'success' = 'info') => {
    console.log(`[Build ${botId}] ${msg}`);
    log.addLog(msg, type);
  };

  try {
    emit(`[Build] Build process started for ${bot.name}`, 'system');
    updateBotStatus(botId, 'building');

    const deploymentMode = await getDeploymentMode();
    const isCasaOS = deploymentMode === 'casaos';

    if (sourceType === 'docker-image') {
      if (!bot.imageRef) {
        emit('[Error] imageRef is required for docker-image source type', 'error');
        updateBotStatus(botId, 'stopped');
        return { success: false, error: 'imageRef is required for docker-image source type' };
      }

      emit(`[Pull] Pulling image ${bot.imageRef}...`, 'info');
      await dockerClient.pullImage(bot.imageRef, (msg) => emit(`[Docker] ${msg}`, 'info'));

      emit('[Info] Generating compose file...', 'info');
      const botDir = getBotDir(botId);
      const dataPath = getDataPath(botId);
      fs.mkdirSync(botDir, { recursive: true });
      fs.mkdirSync(dataPath, { recursive: true });

      const envWithToken = { ...bot.envVars, BOT_MANAGER_UPDATE_TOKEN: bot.updateToken || '' };
      const botWithEnv: BotConfig = { ...bot, envVars: envWithToken };
      const composeContent = generateImageCompose(botWithEnv, botDir);
      const appName = `bot-${botId}`;

      writeComposeFile(botDir, composeContent);
      emit('[Done] Compose file written', 'success');

      // CasaOS: save compose to metadata path
      if (isCasaOS) {
        emit('[PCS] Saving CasaOS metadata...', 'info');
        await saveToCasaOSMetadata(appName, composeContent, (msg) => emit(msg, 'info'));
      }

      // Store appName in registry
      updateBotAppName(botId, appName);
    } else {
      const repoPath = getRepoPath(botId);
      const botDir = getBotDir(botId);
      const dataPath = getDataPath(botId);
      const imageName = `bot-${botId}:latest`;

      fs.mkdirSync(dataPath, { recursive: true });

      emit('[Detect] Detecting bot type...', 'info');
      const detection = detectBotType(repoPath);
      emit(`[Info] Detected: ${detection.type} bot (hasCompose: ${detection.hasCompose}, hasDatabase: ${detection.hasDatabase})`, 'info');

      const envWithToken = { ...bot.envVars, BOT_MANAGER_UPDATE_TOKEN: bot.updateToken || '' };
      const botWithEnv: BotConfig = { ...bot, envVars: envWithToken };

      const existingComposePath = hasExistingCompose(repoPath);
      let composeContent: string;
      let appName: string;
      let buildTarget: string | null = null;

      if (existingComposePath) {
        emit(`[Info] Using existing compose file: ${existingComposePath}`, 'info');

        const buildInfo = getComposeBuildInfo(repoPath);
        buildTarget = buildInfo.buildTarget;

        if (buildTarget) {
          emit(`[Config] Found build target: ${buildTarget}`, 'info');
        }

        // processExistingCompose now returns { content, appName } with PCS processing applied
        const result: ComposeResult = processExistingCompose(repoPath, botDir, botWithEnv);
        composeContent = result.content;
        appName = result.appName;

        emit(`[Info] App name: ${appName}`, 'info');

        if (buildTarget) {
          composeContent = replaceServiceImageWithBuild(composeContent, buildTarget, repoPath, imageName);
        }
      } else {
        emit(`[Info] No compose file found, generating for ${detection.type} bot`, 'info');

        if (!detection.hasDockerfile && detection.type !== 'compose') {
          emit(`[Config] Generating Dockerfile for ${detection.type} bot`, 'info');
          const dockerfile = generateDockerfile(detection);
          fs.writeFileSync(path.join(repoPath, 'Dockerfile'), dockerfile);
        }

        composeContent = generateCompose(botWithEnv, detection, botDir);
        appName = `bot-${botId}`;
        buildTarget = 'bot';
      }

      // CasaOS: create volume directories before writing compose
      if (isCasaOS) {
        emit('[PCS] Creating volume directories...', 'info');
        await createVolumeDirectories(composeContent, (msg) => emit(msg, 'info'));
      }

      // CasaOS: execute pre-install command
      if (isCasaOS) {
        await executeInstallCommand('pre', composeContent, (msg) => emit(msg, 'info'));
      }

      writeComposeFile(botDir, composeContent);
      emit('[Done] Compose file written', 'success');

      // CasaOS: save compose to metadata path
      if (isCasaOS) {
        emit('[PCS] Saving CasaOS metadata...', 'info');
        await saveToCasaOSMetadata(appName, composeContent, (msg) => emit(msg, 'info'));
      }

      // Build Docker image
      if (buildTarget) {
        emit(`[Build] Building Docker image (${imageName})...`, 'info');
        await dockerClient.buildImage(repoPath, imageName, (msg) => {
          emit(`[Docker] ${msg}`, 'info');
        }, { BUILD_MODE: 'managed' });
        emit('[Done] Docker image build completed', 'success');
      } else {
        emit('[Skip] No build target — docker compose will pull images at start', 'info');
      }

      // Store appName in registry
      updateBotAppName(botId, appName);
    }

    updateBotStatus(botId, 'stopped');
    emit(`[Success] Build completed successfully for ${bot.name}`, 'success');
    return { success: true };
  } catch (error) {
    const msg = String(error);
    emit(`[Error] Build failed: ${msg}`, 'error');
    emit('[Fatal] Build process terminated with error', 'error');
    console.error(`[ContainerManager] Failed to build bot ${botId}:`, error);
    updateBotStatus(botId, 'error');
    return { success: false, error: msg };
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
    const appName = bot.appName || `bot-${bot.id}`;

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
