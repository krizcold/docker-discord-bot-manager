/**
 * Container Manager
 * High-level management of bot instances (Phase 5: Source/Instance Architecture)
 *
 * - Instances are individual deployments derived from sources
 * - Source repos are shared across instances (managed by sourceManager)
 * - Each instance has its own compose file, env, and name
 */

import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';

const execAsync = promisify(exec);
import {
  InstanceConfig, InstanceRegistry, BotStatus, BotSourceType,
  CreateInstanceRequest, CreateDockerImageInstanceRequest, UpdateInstanceRequest,
  CreateBotRequest, UpdateBotRequest
} from '../types';
import * as dockerClient from './dockerClient';
import { getBotDir, getDataPath, getEnvPath } from '../git/repoManager';
import { detectBotType } from '../detection';
import { generateDockerfile } from '../templates/dockerfiles';
import {
  generateCompose,
  writeComposeFile,
  hasExistingCompose,
  generateImageCompose,
  getComposeBuildInfo,
  replaceServiceImageWithBuild,
  ComposeResult
} from '../templates/compose';
import { generateHash, applyVariableSubstitution } from '../templates/variableSubstitution';
import {
  processComposeForCasaOS,
  extractAppName,
  createVolumeDirectories,
  saveToCasaOSMetadata,
  fixPostDeployOwnership,
  executeInstallCommand
} from '../templates/pcsProcessing';
import { getDeploymentMode } from '../casaos/detector';
import * as casaosApi from '../casaos/api';
import { logCollectors, LogCollector } from '../build/logCollector';
import * as sourceManager from '../source/sourceManager';
import { sanitizeName, titleizeName, resolveNames, validateName } from '../naming';
import { substituteComposeNames } from '../compose/nameSubstitution';

const DATA_DIR = process.env.DATA_DIR || '/data/data';
const REGISTRY_FILE = path.join(DATA_DIR, 'instances.json');

// Simple write queue to prevent concurrent registry writes
let writeQueue: Promise<void> = Promise.resolve();

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
 * Load instance registry from disk
 */
function loadRegistry(): InstanceRegistry {
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      const content = fs.readFileSync(REGISTRY_FILE, 'utf-8');
      return JSON.parse(content);
    }
  } catch (error) {
    console.error('[ContainerManager] Failed to load registry:', error);
  }
  return { instances: {} };
}

function saveRegistrySync(registry: InstanceRegistry): void {
  try {
    fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
  } catch (error) {
    console.error('[ContainerManager] Failed to save registry:', error);
    throw error;
  }
}

function saveRegistry(registry: InstanceRegistry): void {
  queueRegistryWrite(() => saveRegistrySync(registry));
}

// ─── Registry Accessors ───

export function getAllBots(): InstanceConfig[] {
  const registry = loadRegistry();
  return Object.values(registry.instances);
}

export function getBot(botId: string): InstanceConfig | null {
  const registry = loadRegistry();
  return registry.instances[botId] || null;
}

// Aliases
export const getAllInstances = getAllBots;
export const getInstance = getBot;

// ─── Instance Creation ───

/**
 * Create a new bot instance from a source.
 */
export async function createInstance(request: CreateInstanceRequest): Promise<InstanceConfig> {
  const registry = loadRegistry();

  const source = sourceManager.getSource(request.sourceId);
  if (!source) {
    throw new Error(`Source ${request.sourceId} not found`);
  }

  // Derive names
  const defaultName = source.composeName || extractRepoName(source.url);
  const displayName = request.displayName || defaultName;
  const names = resolveNames(displayName);

  // Validate name
  const existing = Object.values(registry.instances);
  const validation = validateName(displayName, existing);
  if (!validation.valid) {
    throw new Error(`Invalid name: ${validation.errors.join(', ')}`);
  }

  const instanceId = uuidv4();
  const now = new Date().toISOString();
  const updateToken = uuidv4();
  const authHash = generateHash();

  // Create instance directory
  const botDir = getBotDir(instanceId);
  const envPath = getEnvPath(instanceId);
  fs.mkdirSync(botDir, { recursive: true });
  fs.mkdirSync(envPath, { recursive: true });

  // Reuse credentials from a previous instance if requested
  if (request.reuseFromInstanceId) {
    const prevEnvPath = path.join(DATA_DIR, 'bots', request.reuseFromInstanceId, 'env');
    const prevStoragePath = path.join(prevEnvPath, 'storage.json');
    if (fs.existsSync(prevStoragePath)) {
      fs.copyFileSync(prevStoragePath, path.join(envPath, 'storage.json'));
      console.log(`[ContainerManager] Reused credentials from previous instance ${request.reuseFromInstanceId}`);
    }
  }

  // Detect bot type from source repo
  const repoPath = sourceManager.getSourceRepoPath(request.sourceId);
  let detection = null;
  if (fs.existsSync(repoPath)) {
    detection = detectBotType(repoPath);
    console.log(`[ContainerManager] Instance ${instanceId} detected: type=${detection.type}, hasCompose=${detection.hasCompose}`);
  }

  const instance: InstanceConfig = {
    id: instanceId,
    sourceId: request.sourceId,
    sourceUrl: source.url,
    sourceType: 'git',
    displayName: names.displayName,
    sanitizedName: names.sanitizedName,
    titleName: names.titleName,
    status: 'stopped',
    containerIds: [],
    updateToken,
    authHash,
    envVars: request.envVars || {},
    botType: detection?.type,
    hasDatabase: detection?.hasDatabase,
    lastBuiltCommit: null,
    appName: names.sanitizedName,
    createdAt: now,
    updatedAt: now,
  };

  registry.instances[instanceId] = instance;
  saveRegistry(registry);

  console.log(`[ContainerManager] Instance ${instanceId} created ("${displayName}" -> ${names.sanitizedName})`);
  return instance;
}

/**
 * Create a new bot instance from a Docker image (no source needed).
 */
export async function createDockerImageInstance(request: CreateDockerImageInstanceRequest): Promise<InstanceConfig> {
  const registry = loadRegistry();

  const names = resolveNames(request.displayName);

  // Validate name
  const existing = Object.values(registry.instances);
  const validation = validateName(request.displayName, existing);
  if (!validation.valid) {
    throw new Error(`Invalid name: ${validation.errors.join(', ')}`);
  }

  const instanceId = uuidv4();
  const now = new Date().toISOString();
  const updateToken = uuidv4();
  const authHash = generateHash();

  // Create instance directory
  const botDir = getBotDir(instanceId);
  const dataPath = getDataPath(instanceId);
  fs.mkdirSync(botDir, { recursive: true });
  fs.mkdirSync(dataPath, { recursive: true });

  const instance: InstanceConfig = {
    id: instanceId,
    sourceId: null,
    sourceUrl: null,
    sourceType: 'docker-image',
    imageRef: request.imageRef,
    displayName: names.displayName,
    sanitizedName: names.sanitizedName,
    titleName: names.titleName,
    status: 'stopped',
    containerIds: [],
    updateToken,
    authHash,
    envVars: request.envVars || {},
    lastBuiltCommit: null,
    appName: names.sanitizedName,
    createdAt: now,
    updatedAt: now,
  };

  registry.instances[instanceId] = instance;
  saveRegistry(registry);

  console.log(`[ContainerManager] Docker-image instance ${instanceId} created (${request.imageRef})`);
  return instance;
}

/**
 * Legacy createBot wrapper for backward compatibility.
 */
export async function createBot(request: CreateBotRequest): Promise<InstanceConfig> {
  if (request.sourceType === 'docker-image') {
    return createDockerImageInstance({
      displayName: request.name,
      imageRef: request.imageRef!,
      envVars: request.envVars,
    });
  }

  // For git source, we need to find or create the source first
  if (!request.url) {
    throw new Error('url is required for git source type');
  }

  let source = sourceManager.findSourceByUrl(request.url);
  if (!source) {
    source = await sourceManager.createSource({
      url: request.url,
      branch: request.branch,
    });
  }

  return createInstance({
    sourceId: source.id,
    displayName: request.name,
    envVars: request.envVars,
  });
}

// ─── Instance Update ───

export async function updateBot(botId: string, update: UpdateBotRequest | UpdateInstanceRequest): Promise<InstanceConfig | null> {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (!instance) return null;

  // Handle both old and new update formats
  const displayName = (update as UpdateInstanceRequest).displayName || (update as UpdateBotRequest).name;
  if (displayName) {
    const names = resolveNames(displayName);
    instance.displayName = names.displayName;
    instance.sanitizedName = names.sanitizedName;
    instance.titleName = names.titleName;
  }
  if (update.envVars) instance.envVars = { ...instance.envVars, ...update.envVars };
  instance.updatedAt = new Date().toISOString();

  registry.instances[botId] = instance;
  saveRegistry(registry);

  return instance;
}

/**
 * Reassign an instance to a different source.
 */
export function reassignSource(botId: string, newSourceId: string): InstanceConfig | null {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (!instance) return null;

  const source = sourceManager.getSource(newSourceId);
  if (!source) return null;

  instance.sourceId = newSourceId;
  instance.sourceUrl = source.url;
  instance.lastBuiltCommit = null; // needs rebuild
  instance.updatedAt = new Date().toISOString();

  registry.instances[botId] = instance;
  saveRegistry(registry);

  console.log(`[ContainerManager] Instance ${botId} reassigned to source ${newSourceId}`);
  return instance;
}

// ─── Name Resolution ───

/**
 * Resolve appName for an instance.
 * Precedence: instance.appName -> instance.sanitizedName -> fallback bot-{uuid}
 */
function resolveAppName(botId: string): string {
  const instance = getBot(botId);
  if (instance?.appName) return instance.appName;
  if (instance?.sanitizedName) return instance.sanitizedName;

  // Fallback: read from compose file
  const botDir = getBotDir(botId);
  const localComposePath = path.join(botDir, 'docker-compose.yml');
  if (fs.existsSync(localComposePath)) {
    const name = extractAppName(fs.readFileSync(localComposePath, 'utf-8'));
    if (name) {
      updateBotAppName(botId, name);
      return name;
    }
  }

  return `bot-${botId}`;
}

/**
 * Resolve compose file path for deployment.
 * Prefers CasaOS metadata path when it exists.
 */
function resolveComposePath(botId: string, appName: string): string {
  const pcsDataRoot = process.env.DATA_ROOT || '/DATA';
  const metadataPath = path.join(pcsDataRoot, 'AppData', 'casaos', 'apps', appName, 'docker-compose.yml');
  if (fs.existsSync(metadataPath)) return metadataPath;

  return path.join(getBotDir(botId), 'docker-compose.yml');
}

/**
 * Get the Docker image name for an instance.
 * New: {sanitizedName}-{instanceId}:latest
 * Legacy: bot-{instanceId}:latest
 */
function getImageName(instance: InstanceConfig): string {
  if (instance.sanitizedName) {
    return `${instance.sanitizedName}-${instance.id}:latest`;
  }
  return `bot-${instance.id}:latest`;
}

/**
 * Get the legacy image name (for cleanup of migrated instances).
 */
function getLegacyImageName(instanceId: string): string {
  return `bot-${instanceId}:latest`;
}

// ─── Delete ───

async function performManualCleanup(appName: string, removeData: boolean): Promise<void> {
  console.log(`[ContainerManager] Manual cleanup for ${appName} (removeData: ${removeData})`);

  try {
    await execAsync(
      `docker ps -aq --filter "name=${appName}" | xargs -r docker rm -f 2>/dev/null; ` +
      `docker ps -aq --filter "label=com.docker.compose.project=${appName}" | xargs -r docker rm -f 2>/dev/null`,
      { timeout: 30000 }
    );
  } catch { /* best effort */ }

  try {
    await execAsync(
      `docker network ls --filter "name=${appName}" --format "{{.Name}}" | xargs -r docker network rm 2>/dev/null`,
      { timeout: 10000 }
    );
  } catch { /* best effort */ }

  const pcsDataRoot = process.env.DATA_ROOT || '/DATA';
  const metadataDir = path.join(pcsDataRoot, 'AppData', 'casaos', 'apps', appName);
  if (fs.existsSync(metadataDir)) {
    fs.rmSync(metadataDir, { recursive: true, force: true });
  }

  if (removeData) {
    const appDataDir = path.join(pcsDataRoot, 'AppData', appName);
    if (fs.existsSync(appDataDir)) {
      fs.rmSync(appDataDir, { recursive: true, force: true });
      console.log(`[ContainerManager] Removed app data: ${appDataDir}`);
    }
  }
}

export async function deleteBot(botId: string, keepData: boolean = false): Promise<boolean> {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (!instance) return false;

  const deploymentMode = await getDeploymentMode();
  const appName = resolveAppName(botId);
  const botDir = getBotDir(botId);

  // 1. Uninstall containers
  try {
    if (deploymentMode === 'casaos') {
      if (keepData) {
        console.log(`[ContainerManager] Preserving data — manual cleanup only for ${appName}`);
        await performManualCleanup(appName, false);
      } else {
        let apiSuccess = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          console.log(`[ContainerManager] CasaOS API uninstall attempt ${attempt}/3 for ${appName}...`);
          const result = await casaosApi.uninstallApp(appName);
          if (result) {
            apiSuccess = true;
            break;
          }
          if (attempt < 3) await new Promise(r => setTimeout(r, 5000));
        }
        await performManualCleanup(appName, true);
        if (!apiSuccess) {
          console.warn(`[ContainerManager] CasaOS API uninstall failed for ${appName}, manual cleanup performed`);
        }
      }
    } else {
      const containerIds = instance.containerIds || [];
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
    console.warn(`[ContainerManager] Uninstall error for instance ${botId}:`, error);
  }

  // 2. Remove Docker images (try both new and legacy naming)
  for (const imageName of [getImageName(instance), getLegacyImageName(botId)]) {
    try {
      if (dockerClient.imageExists(imageName)) {
        console.log(`[ContainerManager] Removing image ${imageName}...`);
        dockerClient.removeImage(imageName);
      }
    } catch (error) {
      console.warn(`[ContainerManager] Failed to remove image ${imageName}:`, error);
    }
  }

  // 3. Remove named volumes
  if (!keepData) {
    try {
      const volumes = dockerClient.listProjectVolumes(appName);
      for (const volumeName of volumes) {
        console.log(`[ContainerManager] Removing volume ${volumeName}...`);
        dockerClient.removeVolume(volumeName);
      }
    } catch (error) {
      console.warn(`[ContainerManager] Failed to remove volumes for instance ${botId}:`, error);
    }
  }

  // 4. Remove instance directory
  if (!keepData) {
    if (fs.existsSync(botDir)) {
      fs.rmSync(botDir, { recursive: true, force: true });
    }
  } else {
    // Keep env/ but remove compose (recreated on reinstall)
    const composePath = path.join(botDir, 'docker-compose.yml');
    if (fs.existsSync(composePath)) fs.rmSync(composePath, { force: true });
  }

  delete registry.instances[botId];
  saveRegistry(registry);
  logCollectors.remove(botId);

  console.log(`[ContainerManager] Instance ${botId} uninstalled (keepData: ${keepData})`);
  return true;
}

// Alias
export const deleteInstance = deleteBot;

// ─── Status Updates ───

function updateBotStatus(botId: string, status: BotStatus, containerIds?: string[] | null): void {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (instance) {
    instance.status = status;
    if (status === 'running') {
      instance.hasBeenStarted = true;
    }
    if (containerIds !== undefined) {
      instance.containerIds = containerIds || [];
    }
    instance.updatedAt = new Date().toISOString();
    registry.instances[botId] = instance;
    saveRegistry(registry);
  }
}

function updateBotAppName(botId: string, appName: string): void {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (instance) {
    instance.appName = appName;
    instance.updatedAt = new Date().toISOString();
    registry.instances[botId] = instance;
    saveRegistry(registry);
  }
}

function updateLastBuiltCommit(botId: string, commitHash: string | null): void {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (instance) {
    instance.lastBuiltCommit = commitHash;
    instance.updatedAt = new Date().toISOString();
    registry.instances[botId] = instance;
    saveRegistry(registry);
  }
}

// ─── Start ───

export async function startBot(botId: string): Promise<{ success: boolean; error?: string }> {
  const instance = getBot(botId);
  if (!instance) return { success: false, error: 'Bot not found' };
  if (instance.status === 'running') return { success: false, error: 'Bot is already running' };

  const sourceType = instance.sourceType || 'git';
  if (sourceType === 'docker-image') {
    return startDockerImageBot(instance);
  }
  return startGitBot(instance);
}

async function startGitBot(instance: InstanceConfig): Promise<{ success: boolean; error?: string }> {
  const botId = instance.id;
  const log = logCollectors.get(botId);
  log.clear();

  const emit = (msg: string, type: 'system' | 'info' | 'warning' | 'error' | 'success' = 'info') => {
    console.log(`[Start ${botId}] ${msg}`);
    log.addLog(msg, type);
  };

  try {
    emit(`[Start] Starting ${instance.displayName}...`, 'system');

    const latestInstance = getBot(botId) || instance;
    const botDir = getBotDir(botId);
    const localComposePath = path.join(botDir, 'docker-compose.yml');

    // Build if compose doesn't exist
    if (!fs.existsSync(localComposePath)) {
      emit('[Build] No compose file found, running build first...', 'info');
      const buildResult = await buildBot(botId);
      if (!buildResult.success) {
        throw new Error(`Build failed: ${buildResult.error || 'unknown error'}`);
      }
    }

    const appName = resolveAppName(botId);
    const deploymentMode = await getDeploymentMode();

    if (deploymentMode === 'casaos') {
      const composePath = resolveComposePath(botId, appName);
      emit(`[Start] Starting containers (${appName})...`, 'info');
      updateBotStatus(botId, 'starting');

      const deployResult = await casaosApi.deployApp(appName, composePath, (msg) => {
        emit(`[Compose] ${msg}`, 'info');
      });
      if (!deployResult.success) {
        throw new Error(`Failed to deploy via docker compose: ${deployResult.error || 'unknown error'}`);
      }

      await new Promise(resolve => setTimeout(resolve, 3000));

      emit('[PCS] Fixing post-deploy ownership...', 'info');
      await fixPostDeployOwnership(appName, (msg) => emit(msg, 'info'));

      if (!latestInstance.hasBeenStarted) {
        const composeContent = fs.readFileSync(composePath, 'utf-8');
        await executeInstallCommand('post', composeContent, (msg) => emit(msg, 'info'));
      }

      const containerIds = await getContainerIdsForBot(botId);
      updateBotStatus(botId, 'running', containerIds);
      emit(`[Done] Bot deployed (${containerIds.length} containers)`, 'success');
    } else {
      const imageName = getImageName(instance);
      const dataPath = getDataPath(botId);
      const internalUrl = process.env.BOT_MANAGER_INTERNAL_URL || `http://discordbotmanagerapp:${process.env.PORT || '8080'}`;
      const envWithToken = {
        ...instance.envVars,
        BOT_MANAGER_UPDATE_TOKEN: instance.updateToken || '',
        BOT_ID: instance.id,
        BOT_MANAGER_INTERNAL_URL: internalUrl
      };

      emit('[Start] Creating container...', 'info');
      updateBotStatus(botId, 'starting');

      const containerId = await dockerClient.createBotContainer(botId, imageName, envWithToken, dataPath);
      emit('[Start] Starting container...', 'info');
      await dockerClient.startContainer(containerId);

      updateBotStatus(botId, 'running', [containerId]);
      emit('[Done] Bot started successfully', 'success');
    }

    emit(`[Success] ${instance.displayName} is now running!`, 'success');
    return { success: true };
  } catch (error) {
    const msg = String(error);
    emit(`[Error] Start failed: ${msg}`, 'error');
    emit('[Fatal] Start process terminated with error', 'error');
    console.error(`[ContainerManager] Failed to start instance ${botId}:`, error);
    updateBotStatus(botId, 'error');
    return { success: false, error: msg };
  }
}

async function startDockerImageBot(instance: InstanceConfig): Promise<{ success: boolean; error?: string }> {
  const botId = instance.id;

  if (!instance.imageRef) {
    return { success: false, error: 'imageRef is required for docker-image source type' };
  }

  try {
    const botDir = getBotDir(botId);
    const localComposePath = path.join(botDir, 'docker-compose.yml');

    if (!fs.existsSync(localComposePath)) {
      const buildResult = await buildBot(botId);
      if (!buildResult.success) {
        return { success: false, error: `Build failed: ${buildResult.error || 'unknown error'}` };
      }
    }

    const appName = resolveAppName(botId);
    const deploymentMode = await getDeploymentMode();

    if (deploymentMode === 'casaos') {
      const composePath = resolveComposePath(botId, appName);
      updateBotStatus(botId, 'starting');

      const deployResult = await casaosApi.deployApp(appName, composePath);
      if (!deployResult.success) {
        throw new Error(`Failed to deploy via docker compose: ${deployResult.error || 'unknown error'}`);
      }

      await new Promise(resolve => setTimeout(resolve, 3000));
      await fixPostDeployOwnership(appName);

      const containerIds = await getContainerIdsForBot(botId);
      updateBotStatus(botId, 'running', containerIds);
    } else {
      const dataPath = getDataPath(botId);
      const internalUrl = process.env.BOT_MANAGER_INTERNAL_URL || `http://discordbotmanagerapp:${process.env.PORT || '8080'}`;
      const envWithToken = {
        ...instance.envVars,
        BOT_MANAGER_UPDATE_TOKEN: instance.updateToken || '',
        BOT_ID: instance.id,
        BOT_MANAGER_INTERNAL_URL: internalUrl
      };

      updateBotStatus(botId, 'starting');
      const containerId = await dockerClient.createBotContainer(botId, instance.imageRef, envWithToken, dataPath);
      await dockerClient.startContainer(containerId);
      updateBotStatus(botId, 'running', [containerId]);
    }

    return { success: true };
  } catch (error) {
    console.error(`[ContainerManager] Failed to start docker-image instance ${botId}:`, error);
    updateBotStatus(botId, 'error');
    return { success: false, error: String(error) };
  }
}

// ─── Container ID Resolution ───

async function getContainerIdsForBot(botId: string): Promise<string[]> {
  const containers = await dockerClient.listBotContainers();
  const appName = resolveAppName(botId);
  const botContainers = containers.filter(c =>
    c.name.startsWith(appName) || c.name.includes(`-${botId}-`)
  );
  return botContainers.map(c => c.id);
}

// ─── Stop ───

export async function stopBot(botId: string): Promise<{ success: boolean; error?: string }> {
  const instance = getBot(botId);
  if (!instance) return { success: false, error: 'Bot not found' };
  if (instance.status !== 'running') return { success: false, error: 'Bot is not running' };

  try {
    updateBotStatus(botId, 'stopping');

    const deploymentMode = await getDeploymentMode();
    const appName = resolveAppName(botId);

    if (deploymentMode === 'casaos') {
      const composePath = resolveComposePath(botId, appName);
      const downResult = await casaosApi.composeDown(appName, composePath);
      if (!downResult.success) {
        console.warn(`[ContainerManager] Compose down failed for ${appName}: ${downResult.error}`);
      }
    } else {
      const containerIds = instance.containerIds || [];
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
    return { success: true };
  } catch (error) {
    console.error(`[ContainerManager] Failed to stop instance ${botId}:`, error);
    updateBotStatus(botId, 'error');
    return { success: false, error: String(error) };
  }
}

// ─── Restart ───

export async function restartBot(botId: string): Promise<{ success: boolean; error?: string }> {
  const stopResult = await stopBot(botId);
  if (!stopResult.success && stopResult.error !== 'Bot is not running') {
    return stopResult;
  }
  return startBot(botId);
}

// ─── Pull & Rebuild (Instance Update) ───

export async function pullAndRebuild(botId: string): Promise<{ success: boolean; error?: string }> {
  const instance = getBot(botId);
  if (!instance) return { success: false, error: 'Bot not found' };

  const wasRunning = instance.status === 'running';

  try {
    if (wasRunning) {
      await stopBot(botId);
    }

    // For source-backed instances, the source repo is already up to date
    // (updated by sourceUpdater or manual fetch). Just rebuild.
    if (instance.sourceId) {
      const source = sourceManager.getSource(instance.sourceId);
      if (!source) {
        return { success: false, error: 'Source not found — cannot rebuild' };
      }
    }

    // Remove old images
    const imageName = getImageName(instance);
    if (dockerClient.imageExists(imageName)) {
      dockerClient.removeImage(imageName);
    }
    const legacyName = getLegacyImageName(botId);
    if (dockerClient.imageExists(legacyName)) {
      dockerClient.removeImage(legacyName);
    }

    // Rebuild
    const buildResult = await buildBot(botId);
    if (!buildResult.success) {
      return { success: false, error: `Rebuild failed: ${buildResult.error || 'unknown error'}` };
    }

    if (wasRunning) {
      return startBot(botId);
    }

    return { success: true };
  } catch (error) {
    console.error(`[ContainerManager] Failed to rebuild instance ${botId}:`, error);
    return { success: false, error: String(error) };
  }
}

// ─── Build ───

export function getBotLogCollector(botId: string): LogCollector {
  return logCollectors.get(botId);
}

export async function buildBot(botId: string): Promise<{ success: boolean; error?: string }> {
  const instance = getBot(botId);
  if (!instance) return { success: false, error: 'Bot not found' };

  const sourceType = instance.sourceType || 'git';
  const log = logCollectors.get(botId);
  log.clear();

  const emit = (msg: string, type: 'system' | 'info' | 'warning' | 'error' | 'success' = 'info') => {
    console.log(`[Build ${botId}] ${msg}`);
    log.addLog(msg, type);
  };

  try {
    emit(`[Build] Build process started for ${instance.displayName}`, 'system');
    updateBotStatus(botId, 'building');

    const deploymentMode = await getDeploymentMode();
    const isCasaOS = deploymentMode === 'casaos';

    if (sourceType === 'docker-image') {
      return await buildDockerImageInstance(instance, emit, isCasaOS);
    }

    return await buildGitInstance(instance, emit, isCasaOS);
  } catch (error) {
    const msg = String(error);
    emit(`[Error] Build failed: ${msg}`, 'error');
    emit('[Fatal] Build process terminated with error', 'error');
    console.error(`[ContainerManager] Failed to build instance ${botId}:`, error);
    updateBotStatus(botId, 'error');
    return { success: false, error: msg };
  }
}

async function buildDockerImageInstance(
  instance: InstanceConfig,
  emit: (msg: string, type: 'system' | 'info' | 'warning' | 'error' | 'success') => void,
  isCasaOS: boolean,
): Promise<{ success: boolean; error?: string }> {
  const botId = instance.id;

  if (!instance.imageRef) {
    emit('[Error] imageRef is required for docker-image source type', 'error');
    updateBotStatus(botId, 'stopped');
    return { success: false, error: 'imageRef is required' };
  }

  emit(`[Pull] Pulling image ${instance.imageRef}...`, 'info');
  await dockerClient.pullImage(instance.imageRef, (msg) => emit(`[Docker] ${msg}`, 'info'));

  emit('[Info] Generating compose file...', 'info');
  const botDir = getBotDir(botId);
  const dataPath = getDataPath(botId);
  fs.mkdirSync(botDir, { recursive: true });
  fs.mkdirSync(dataPath, { recursive: true });

  const internalUrl = process.env.BOT_MANAGER_INTERNAL_URL || `http://discordbotmanagerapp:${process.env.PORT || '8080'}`;
  const envWithToken = { ...instance.envVars, BOT_MANAGER_UPDATE_TOKEN: instance.updateToken || '', BOT_ID: instance.id, BOT_MANAGER_INTERNAL_URL: internalUrl };

  // Use displayName for the compose bot config (BotConfig compat)
  const botForCompose: any = { ...instance, name: instance.displayName, envVars: envWithToken };
  let composeContent = generateImageCompose(botForCompose, botDir);
  const appName = instance.sanitizedName || `bot-${botId}`;
  composeContent = processComposeForCasaOS(composeContent, appName, botForCompose);

  writeComposeFile(botDir, composeContent);
  emit('[Done] Compose file written', 'success');

  if (isCasaOS) {
    emit('[PCS] Saving CasaOS metadata...', 'info');
    await saveToCasaOSMetadata(appName, composeContent, (msg) => emit(msg, 'info'));
  }

  updateBotAppName(botId, appName);
  updateBotStatus(botId, 'stopped');
  emit(`[Success] Build completed for ${instance.displayName}`, 'success');
  return { success: true };
}

async function buildGitInstance(
  instance: InstanceConfig,
  emit: (msg: string, type: 'system' | 'info' | 'warning' | 'error' | 'success') => void,
  isCasaOS: boolean,
): Promise<{ success: boolean; error?: string }> {
  const botId = instance.id;

  // Resolve source repo path
  let repoPath: string;
  if (instance.sourceId) {
    repoPath = sourceManager.getSourceRepoPath(instance.sourceId);
    if (!fs.existsSync(repoPath)) {
      emit('[Error] Source repository not found', 'error');
      updateBotStatus(botId, 'error');
      return { success: false, error: 'Source repository not found' };
    }
  } else {
    // Orphaned instance — try legacy path
    const legacyRepoPath = path.join(getBotDir(botId), 'repo');
    if (fs.existsSync(legacyRepoPath)) {
      repoPath = legacyRepoPath;
    } else {
      emit('[Error] No source or legacy repo available', 'error');
      updateBotStatus(botId, 'error');
      return { success: false, error: 'No source or legacy repo available' };
    }
  }

  const botDir = getBotDir(botId);
  const dataPath = getDataPath(botId);
  const imageName = getImageName(instance);
  fs.mkdirSync(dataPath, { recursive: true });

  emit('[Detect] Detecting bot type...', 'info');
  const detection = detectBotType(repoPath);
  emit(`[Info] Detected: ${detection.type} bot (hasCompose: ${detection.hasCompose}, hasDatabase: ${detection.hasDatabase})`, 'info');

  const internalUrl = process.env.BOT_MANAGER_INTERNAL_URL || `http://discordbotmanagerapp:${process.env.PORT || '8080'}`;
  const envWithToken = { ...instance.envVars, BOT_MANAGER_UPDATE_TOKEN: instance.updateToken || '', BOT_ID: instance.id, BOT_MANAGER_INTERNAL_URL: internalUrl };
  const botWithEnv: any = { ...instance, name: instance.displayName, envVars: envWithToken };

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

    // Read original compose
    let rawCompose = fs.readFileSync(existingComposePath, 'utf-8');
    const originalComposeName = extractAppName(rawCompose);
    appName = instance.sanitizedName || originalComposeName || `bot-${botId}`;

    // Apply name substitution if we have an original compose name to replace
    if (originalComposeName && originalComposeName !== appName) {
      emit(`[Info] Substituting compose name: ${originalComposeName} -> ${appName}`, 'info');
      rawCompose = substituteComposeNames(rawCompose, originalComposeName, appName, instance.titleName);
    }

    // Apply variable substitution
    rawCompose = applyVariableSubstitution(rawCompose, botWithEnv);

    // Apply CasaOS processing
    composeContent = processComposeForCasaOS(rawCompose, appName, botWithEnv);

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
    appName = instance.sanitizedName || `bot-${botId}`;
    composeContent = processComposeForCasaOS(composeContent, appName, botWithEnv);
    buildTarget = 'bot';
  }

  // CasaOS: create volume directories
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

  // CasaOS: save to metadata path
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

  // Store appName and lastBuiltCommit
  updateBotAppName(botId, appName);

  // Record the commit this was built from
  if (instance.sourceId) {
    const source = sourceManager.getSource(instance.sourceId);
    if (source?.lastCommitHash) {
      updateLastBuiltCommit(botId, source.lastCommitHash);
    }
  }

  updateBotStatus(botId, 'stopped');
  emit(`[Success] Build completed successfully for ${instance.displayName}`, 'success');
  return { success: true };
}

// ─── Logs & Stats ───

export async function getBotLogs(botId: string, tail = 100): Promise<{ success: boolean; logs?: string[]; error?: string }> {
  const instance = getBot(botId);
  if (!instance) return { success: false, error: 'Bot not found' };

  const containerIds = instance.containerIds || [];
  if (containerIds.length === 0) return { success: false, error: 'Bot has no containers' };

  try {
    const allLogs: string[] = [];
    for (const containerId of containerIds) {
      try {
        const logEntries = await dockerClient.getContainerLogs(containerId, Math.ceil(tail / containerIds.length));
        const containerName = containerId.substring(0, 12);
        for (const e of logEntries) {
          allLogs.push(`[${e.timestamp}] [${containerName}] ${e.message}`);
        }
      } catch (err) {
        console.warn(`[ContainerManager] Failed to get logs from container ${containerId}:`, err);
      }
    }
    allLogs.sort();
    return { success: true, logs: allLogs.slice(-tail) };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export async function getBotStats(botId: string): Promise<{ success: boolean; stats?: { cpuPercent: number; memoryUsageMB: number; memoryLimitMB: number }; error?: string }> {
  const instance = getBot(botId);
  if (!instance) return { success: false, error: 'Bot not found' };

  const containerIds = instance.containerIds || [];
  if (containerIds.length === 0 || instance.status !== 'running') {
    return { success: false, error: 'Bot is not running' };
  }

  try {
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
        console.warn(`[ContainerManager] Failed to get stats from container ${containerId}:`, err);
      }
    }

    return {
      success: true,
      stats: { cpuPercent: totalCpuPercent, memoryUsageMB: totalMemoryUsageMB, memoryLimitMB: totalMemoryLimitMB }
    };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

// ─── Container State Sync ───

export async function syncContainerStates(): Promise<void> {
  const registry = loadRegistry();
  const containers = await dockerClient.listBotContainers();

  for (const instance of Object.values(registry.instances)) {
    const appName = resolveAppName(instance.id);

    if (instance.status === 'running') {
      const containerIds = instance.containerIds || [];
      const runningContainers = containers.filter(c =>
        c.name.startsWith(appName) && c.state === 'running'
      );

      if (runningContainers.length === 0) {
        console.log(`[ContainerManager] Instance ${instance.id} has no running containers, updating status`);
        updateBotStatus(instance.id, 'stopped', []);
      } else if (runningContainers.length !== containerIds.length) {
        const newContainerIds = runningContainers.map(c => c.id);
        updateBotStatus(instance.id, 'running', newContainerIds);
      }
    }
  }

  console.log('[ContainerManager] Container state sync complete');
}

// ─── Helpers ───

function extractRepoName(url: string): string {
  // https://github.com/owner/my-bot.git -> my-bot
  const match = url.match(/\/([^\/]+?)(?:\.git)?$/);
  return match ? match[1] : 'unnamed-bot';
}
