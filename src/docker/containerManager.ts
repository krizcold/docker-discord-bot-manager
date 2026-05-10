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
import YAML from 'yaml';

const DATA_DIR = process.env.DATA_DIR || '/data/data';
const REGISTRY_FILE = path.join(DATA_DIR, 'instances.json');

type BroadcastFn = (type: string, data: any) => void;
let broadcastFn: BroadcastFn | null = null;

export function setContainerBroadcast(fn: BroadcastFn): void {
  broadcastFn = fn;
}

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

// Env keys written by the bot manager itself, filtered out when restoring
const BOT_MANAGER_ENV_KEYS = new Set(['BOT_ID', 'BOT_MANAGER_UPDATE_TOKEN', 'BOT_MANAGER_INTERNAL_URL']);

/**
 * Read env vars from a docker-compose.yml. Picks the build-target service (or first).
 * Handles both array ("KEY=value") and object ({ KEY: value }) environment formats.
 * Returns null if the file is missing or unparseable.
 */
export function readEnvsFromComposeFile(composePath: string): Record<string, string> | null {
  try {
    if (!fs.existsSync(composePath)) return null;
    const raw = fs.readFileSync(composePath, 'utf-8');
    const compose = YAML.parseDocument(raw).toJSON();
    const services = compose?.services;
    if (!services || typeof services !== 'object') return null;

    const xcBuild = (compose['x-casaos'] as Record<string, unknown> | undefined)?.build;
    const serviceNames = Object.keys(services);
    const targetName = (typeof xcBuild === 'string' && services[xcBuild]) ? xcBuild : serviceNames[0];
    if (!targetName) return null;

    const env = services[targetName]?.environment;
    const out: Record<string, string> = {};

    if (Array.isArray(env)) {
      for (const entry of env) {
        if (typeof entry !== 'string') continue;
        const eq = entry.indexOf('=');
        if (eq < 0) continue;
        const key = entry.slice(0, eq);
        const value = entry.slice(eq + 1);
        if (key && !BOT_MANAGER_ENV_KEYS.has(key)) out[key] = value;
      }
    } else if (env && typeof env === 'object') {
      for (const [key, value] of Object.entries(env)) {
        if (!BOT_MANAGER_ENV_KEYS.has(key)) out[key] = String(value ?? '');
      }
    }

    return Object.keys(out).length > 0 ? out : null;
  } catch (err) {
    console.warn(`[ContainerManager] Failed to parse compose for env restore (${composePath}):`, err);
    return null;
  }
}

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
    createdAt: now,
    updatedAt: now,
  };

  registry.instances[instanceId] = instance;
  saveRegistry(registry);

  console.log(`[ContainerManager] Docker-image instance ${instanceId} created (${request.imageRef})`);
  return instance;
}

/**
 * Update instance auto-update settings.
 */
export function updateInstanceAutoUpdate(botId: string, autoUpdate: boolean, autoUpdateInterval?: number, autoUpdateHour?: number): InstanceConfig | null {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (!instance) return null;

  instance.autoUpdate = autoUpdate;
  if (autoUpdateInterval !== undefined) {
    instance.autoUpdateInterval = autoUpdateInterval;
  }
  if (autoUpdateHour !== undefined) {
    instance.autoUpdateHour = Math.max(0, Math.min(23, autoUpdateHour));
  }
  instance.updatedAt = new Date().toISOString();
  registry.instances[botId] = instance;
  saveRegistry(registry);
  return instance;
}

// ─── Instance Update ───

export async function updateBot(botId: string, update: UpdateInstanceRequest): Promise<InstanceConfig | null> {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (!instance) return null;

  if (update.displayName) {
    const names = resolveNames(update.displayName);
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
 * Resolve appName for an instance. Equivalent to `getBot(botId)?.sanitizedName`.
 * Throws if the instance doesn't exist, since callers always follow up with
 * operations that require a real app name.
 */
function resolveAppName(botId: string): string {
  const instance = getBot(botId);
  if (!instance) throw new Error(`Instance ${botId} not found`);
  return instance.sanitizedName;
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
 * Docker image name: {sanitizedName}-{instanceId}:latest
 */
function getImageName(instance: InstanceConfig): string {
  return `${instance.sanitizedName}-${instance.id}:latest`;
}

// ─── Delete ───

async function performManualCleanup(appName: string, removeData: boolean): Promise<{ failures: string[] }> {
  console.log(`[ContainerManager] Manual cleanup for ${appName} (removeData: ${removeData})`);

  const pcsDataRoot = process.env.DATA_ROOT || '/DATA';
  const failures: string[] = [];

  // 1. Try compose down first: this properly tears down the compose project
  //    so CasaOS detects the removal and deregisters the app from its UI.
  //    Failure here is recoverable (next steps force-remove anyway), but
  //    track it so deleteBot can surface partial issues.
  const composePath = path.join(pcsDataRoot, 'AppData', 'casaos', 'apps', appName, 'docker-compose.yml');
  if (fs.existsSync(composePath)) {
    try {
      await execAsync(
        `docker compose -p ${appName} -f "${composePath}" down --remove-orphans`,
        { timeout: 60000 }
      );
      console.log(`[ContainerManager] Compose down succeeded for ${appName}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`compose down ${appName}: ${msg}`);
    }
  }

  // 2. Force-remove any remaining containers (belt and suspenders).
  // Verify after with `docker ps` so we know they're actually gone.
  try {
    await execAsync(
      `docker ps -aq --filter "name=${appName}" | xargs -r docker rm -f; ` +
      `docker ps -aq --filter "label=com.docker.compose.project=${appName}" | xargs -r docker rm -f`,
      { timeout: 30000 }
    );
    // Verify no containers linger
    const { stdout } = await execAsync(
      `docker ps -aq --filter "name=${appName}" --filter "label=com.docker.compose.project=${appName}"`,
      { timeout: 10000 }
    );
    const remaining = stdout.trim().split('\n').filter(Boolean);
    if (remaining.length > 0) {
      failures.push(`containers still present after force-remove: ${remaining.join(', ')}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`force-remove containers ${appName}: ${msg}`);
  }

  // 3. Remove orphan networks
  try {
    await execAsync(
      `docker network ls --filter "name=${appName}" --format "{{.Name}}" | xargs -r docker network rm`,
      { timeout: 10000 }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`networks ${appName}: ${msg}`);
  }

  // 4. Remove CasaOS metadata directory
  const metadataDir = path.join(pcsDataRoot, 'AppData', 'casaos', 'apps', appName);
  if (fs.existsSync(metadataDir)) {
    try { fs.rmSync(metadataDir, { recursive: true, force: true }); }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`metadata dir ${metadataDir}: ${msg}`);
    }
  }

  // 5. Remove app data directory if requested
  if (removeData) {
    const appDataDir = path.join(pcsDataRoot, 'AppData', appName);
    if (fs.existsSync(appDataDir)) {
      try {
        fs.rmSync(appDataDir, { recursive: true, force: true });
        console.log(`[ContainerManager] Removed app data: ${appDataDir}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`app data ${appDataDir}: ${msg}`);
      }
    }
  }

  return { failures };
}

export async function deleteBot(botId: string, keepData: boolean = false): Promise<boolean> {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (!instance) return false;

  const deploymentMode = await getDeploymentMode();
  const appName = resolveAppName(botId);
  const botDir = getBotDir(botId);

  // Track per-step failures so the function reports an honest result. We
  // still attempt every cleanup step (a stuck container shouldn't prevent
  // image removal etc.) but the aggregate failure list propagates upstream
  // - silently returning true while orphaned containers/images linger is
  // exactly the false-positive pattern we're banning project-wide.
  const failures: string[] = [];

  // 1. Uninstall containers
  try {
    if (deploymentMode === 'casaos') {
      if (keepData) {
        console.log(`[ContainerManager] Preserving data; manual cleanup only for ${appName}`);
        const cleanup = await performManualCleanup(appName, false);
        failures.push(...cleanup.failures);
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
        const cleanup = await performManualCleanup(appName, true);
        failures.push(...cleanup.failures);
        if (!apiSuccess) {
          failures.push(`CasaOS API uninstall failed after 3 attempts for ${appName} (manual cleanup attempted)`);
        }
      }
    } else {
      const containerIds = instance.containerIds || [];
      for (const containerId of containerIds) {
        try {
          await dockerClient.stopContainer(containerId);
          await dockerClient.removeContainer(containerId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          failures.push(`container ${containerId}: ${msg}`);
        }
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    failures.push(`uninstall step: ${msg}`);
  }

  // 2. Remove Docker image
  const imageName = getImageName(instance);
  try {
    if (dockerClient.imageExists(imageName)) {
      console.log(`[ContainerManager] Removing image ${imageName}...`);
      const ok = dockerClient.removeImage(imageName);
      if (!ok) failures.push(`image ${imageName}: docker rmi reported failure`);
      // Verify the image is actually gone - rmi can return success in some
      // edge cases (force-removed dangling tag) while another tag of the
      // same image keeps it present. Treat lingering image as a failure.
      else if (dockerClient.imageExists(imageName)) {
        failures.push(`image ${imageName}: still present after rmi`);
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    failures.push(`image ${imageName}: ${msg}`);
  }

  // 3. Remove named volumes
  if (!keepData) {
    try {
      const volumes = dockerClient.listProjectVolumes(appName);
      for (const volumeName of volumes) {
        console.log(`[ContainerManager] Removing volume ${volumeName}...`);
        const ok = dockerClient.removeVolume(volumeName);
        if (!ok) failures.push(`volume ${volumeName}: docker volume rm reported failure`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      failures.push(`volumes for ${botId}: ${msg}`);
    }
  }

  // 4. Remove instance directory
  if (!keepData) {
    if (fs.existsSync(botDir)) {
      try { fs.rmSync(botDir, { recursive: true, force: true }); }
      catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`bot directory ${botDir}: ${msg}`);
      }
    }
  } else {
    // Keep env/ but remove compose (recreated on reinstall)
    const composePath = path.join(botDir, 'docker-compose.yml');
    if (fs.existsSync(composePath)) {
      try { fs.rmSync(composePath, { force: true }); }
      catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`compose file ${composePath}: ${msg}`);
      }
    }
  }

  delete registry.instances[botId];
  saveRegistry(registry);
  logCollectors.remove(botId);

  if (failures.length > 0) {
    // Throw rather than return false: callers (API routes) translate
    // exceptions into HTTP errors with the full message, so the user sees
    // exactly which step(s) didn't complete. Returning false would hide
    // the detail.
    const summary = `Bot ${botId} uninstall completed with ${failures.length} failure(s):\n  - ${failures.join('\n  - ')}`;
    console.error(`[ContainerManager] ${summary}`);
    throw new Error(summary);
  }

  console.log(`[ContainerManager] Instance ${botId} uninstalled cleanly (keepData: ${keepData})`);
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
    if (broadcastFn) {
      broadcastFn('bot:status', { id: botId, status });
    }
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

/**
 * Write a .botmanager marker file inside the AppData folder.
 * This identifies the folder as Bot Manager-managed, surviving even if
 * the Bot Manager itself is wiped. Used by name validation and folder reuse.
 *
 * Location: /DATA/AppData/{appName}/.botmanager
 */
function writeBotManagerMarker(instance: InstanceConfig, appName: string): void {
  const dataRoot = process.env.DATA_ROOT || '/DATA';
  const appDataPath = path.join(dataRoot, 'AppData', appName);

  try {
    fs.mkdirSync(appDataPath, { recursive: true });
    const marker = {
      managedBy: 'docker-discord-bot-manager',
      instanceId: instance.id,
      displayName: instance.displayName,
      sanitizedName: instance.sanitizedName,
      sourceUrl: instance.sourceUrl || null,
      sourceType: instance.sourceType || 'git',
      createdAt: instance.createdAt,
      lastBuildAt: new Date().toISOString()
    };
    fs.writeFileSync(
      path.join(appDataPath, '.botmanager'),
      JSON.stringify(marker, null, 2)
    );
  } catch (err) {
    console.warn(`[ContainerManager] Failed to write .botmanager marker: ${err}`);
  }
}

/**
 * Read the .botmanager marker from an AppData folder.
 * Returns the parsed marker or null if not found/invalid.
 */
export function readBotManagerMarker(appName: string): {
  managedBy: string;
  instanceId: string;
  displayName: string;
  sanitizedName: string;
  sourceUrl: string | null;
  sourceType: string;
  createdAt: string;
  lastBuildAt: string;
} | null {
  const dataRoot = process.env.DATA_ROOT || '/DATA';
  const markerPath = path.join(dataRoot, 'AppData', appName, '.botmanager');

  try {
    if (!fs.existsSync(markerPath)) return null;
    return JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Sync current instance env vars into the on-disk compose file.
 * CasaOS deploys from the compose file, so env changes after build
 * must be written back before start.
 */
function syncComposeEnvVars(instance: InstanceConfig, composePath: string): void {
  if (!fs.existsSync(composePath)) return;

  try {
    const raw = fs.readFileSync(composePath, 'utf-8');
    const doc = YAML.parseDocument(raw);
    const compose = doc.toJSON();

    const services = compose?.services;
    if (!services || typeof services !== 'object') return;

    // Determine target service (x-casaos.build target or first service)
    const xcBuild = (compose['x-casaos'] as Record<string, unknown> | undefined)?.build;
    const serviceNames = Object.keys(services);
    const targetName = (typeof xcBuild === 'string' && services[xcBuild])
      ? xcBuild
      : serviceNames[0];
    if (!targetName) return;

    const internalUrl = process.env.BOT_MANAGER_INTERNAL_URL || `http://discordbotmanagerapp:${process.env.PORT || '8080'}`;
    const allEnv: Record<string, string> = {
      ...instance.envVars,
      BOT_MANAGER_UPDATE_TOKEN: instance.updateToken || '',
      BOT_ID: instance.id,
      BOT_MANAGER_INTERNAL_URL: internalUrl
    };

    const service = services[targetName];
    const env = service.environment;

    if (Array.isArray(env)) {
      // Array format: ["KEY=value", ...]
      // Remove existing keys we're about to set, then add all
      const existingKeys = new Set(Object.keys(allEnv));
      const filtered = env.filter((e: string) => {
        const key = typeof e === 'string' ? e.split('=')[0] : '';
        return !existingKeys.has(key);
      });
      for (const [key, value] of Object.entries(allEnv)) {
        filtered.push(`${key}=${value}`);
      }
      service.environment = filtered;
    } else if (typeof env === 'object' && env !== null) {
      // Object format: { KEY: "value", ... }
      Object.assign(env, allEnv);
    } else {
      // No environment section, create one
      service.environment = { ...allEnv };
    }

    compose.services[targetName] = service;
    fs.writeFileSync(composePath, YAML.stringify(compose, { lineWidth: 0 }));
  } catch (err) {
    console.warn(`[ContainerManager] Failed to sync env vars into compose: ${err}`);
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

      // Sync env vars into compose before deploy (env changes after build)
      syncComposeEnvVars(latestInstance, composePath);

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
        return { success: false, error: 'Source not found, cannot rebuild' };
      }
    }

    // Remove old image
    const imageName = getImageName(instance);
    if (dockerClient.imageExists(imageName)) {
      dockerClient.removeImage(imageName);
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
  const botForCompose: any = { ...instance, envVars: envWithToken };
  let composeContent = generateImageCompose(botForCompose, botDir);
  const appName = instance.sanitizedName;
  composeContent = processComposeForCasaOS(composeContent, appName, botForCompose);

  writeComposeFile(botDir, composeContent);
  emit('[Done] Compose file written', 'success');

  // Write .botmanager marker inside AppData (identifies folder as ours)
  writeBotManagerMarker(instance, appName);

  if (isCasaOS) {
    emit('[PCS] Saving CasaOS metadata...', 'info');
    await saveToCasaOSMetadata(appName, composeContent, (msg) => emit(msg, 'info'));
  }

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

  // Resolve source repo path: fetch from origin first so build uses latest commits
  let repoPath: string;
  if (instance.sourceId) {
    repoPath = sourceManager.getSourceRepoPath(instance.sourceId);
    emit('[Fetch] Pulling latest commits from origin...', 'info');
    try {
      const fetchResult = await sourceManager.fetchSource(instance.sourceId);
      if (fetchResult.hasUpdates) {
        emit(`[Fetch] Source updated with ${fetchResult.behindBy} new commit(s)`, 'success');
      } else {
        emit('[Fetch] Source already up to date', 'info');
      }
    } catch (err: any) {
      emit(`[Fetch] Warning: could not fetch from origin (${err?.message || err}); building from local repo`, 'warning');
    }
    if (!fs.existsSync(repoPath)) {
      emit('[Error] Source repository not found', 'error');
      updateBotStatus(botId, 'error');
      return { success: false, error: 'Source repository not found' };
    }
  } else {
    emit('[Error] Git instance has no sourceId', 'error');
    updateBotStatus(botId, 'error');
    return { success: false, error: 'Git instance has no sourceId' };
  }

  const botDir = getBotDir(botId);
  const dataPath = getDataPath(botId);
  const imageName = getImageName(instance);
  fs.mkdirSync(dataPath, { recursive: true });

  // Tear down any ghost compose project from a previous bot manager install
  // (compose file at the CasaOS metadata path would otherwise be overwritten
  // while old containers keep running under the old project label)
  if (isCasaOS) {
    const earlyAppName = instance.sanitizedName;
    const pcsDataRoot = process.env.DATA_ROOT || '/DATA';
    const metadataComposePath = path.join(pcsDataRoot, 'AppData', 'casaos', 'apps', earlyAppName, 'docker-compose.yml');
    if (fs.existsSync(metadataComposePath)) {
      const marker = readBotManagerMarker(earlyAppName);
      if (!marker || marker.instanceId !== botId) {
        emit(`[Cleanup] Stale compose found at ${metadataComposePath} (instanceId=${marker?.instanceId || 'none'}, current=${botId}), tearing down ghost containers`, 'warning');
        try {
          const downResult = await casaosApi.composeDown(earlyAppName, metadataComposePath, (msg) => emit(`[Compose down] ${msg}`, 'info'));
          if (!downResult.success) {
            emit(`[Cleanup] composeDown reported: ${downResult.error || 'failed'}; continuing`, 'warning');
          }
        } catch (err: any) {
          emit(`[Cleanup] composeDown threw: ${err?.message || err}; continuing`, 'warning');
        }
      }
    }
  }

  emit('[Detect] Detecting bot type...', 'info');
  const detection = detectBotType(repoPath);
  emit(`[Info] Detected: ${detection.type} bot (hasCompose: ${detection.hasCompose}, hasDatabase: ${detection.hasDatabase})`, 'info');

  const internalUrl = process.env.BOT_MANAGER_INTERNAL_URL || `http://discordbotmanagerapp:${process.env.PORT || '8080'}`;
  const envWithToken = { ...instance.envVars, BOT_MANAGER_UPDATE_TOKEN: instance.updateToken || '', BOT_ID: instance.id, BOT_MANAGER_INTERNAL_URL: internalUrl };
  const botWithEnv: any = { ...instance, envVars: envWithToken };

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
    appName = instance.sanitizedName;

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
    appName = instance.sanitizedName;
    composeContent = processComposeForCasaOS(composeContent, appName, botWithEnv);
    buildTarget = 'bot';
  }

  // CasaOS: create volume directories
  if (isCasaOS) {
    emit('[PCS] Creating volume directories...', 'info');
    await createVolumeDirectories(composeContent, (msg) => emit(msg, 'info'));
  }

  // Write .botmanager marker inside AppData (identifies folder as ours)
  writeBotManagerMarker(instance, appName);

  // CasaOS: execute pre-install command
  if (isCasaOS) {
    await executeInstallCommand('pre', composeContent, (msg) => emit(msg, 'info'));
  }

  writeComposeFile(botDir, composeContent);
  emit('[Done] Compose file written', 'success');

  // Build Docker image BEFORE saving CasaOS metadata
  // (so a failed build doesn't leave a ghost app registered in CasaOS)
  if (buildTarget) {
    emit(`[Build] Building Docker image (${imageName})...`, 'info');

    const buildArgs: Record<string, string> = {
      BUILD_MODE: 'managed',
      BUILD_DATE: new Date().toISOString()
    };

    let metaCommit: string | null = null;
    let metaBranch: string | null = null;
    if (instance.sourceId) {
      const source = sourceManager.getSource(instance.sourceId);
      metaCommit = source?.lastCommitHash || null;
      metaBranch = source?.branch || null;
    }
    if (!metaCommit && fs.existsSync(path.join(repoPath, '.git'))) {
      try {
        const simpleGit = require('simple-git').simpleGit;
        const git = simpleGit(repoPath);
        const log = await git.log({ maxCount: 1 });
        if (log.latest?.hash) metaCommit = log.latest.hash;
        if (!metaBranch) {
          const br = await git.revparse(['--abbrev-ref', 'HEAD']);
          metaBranch = (br || '').trim() || null;
        }
      } catch {
        // leave nulls; bot will fall back to BUILD_DATE for buildId
      }
    }
    try {
      fs.writeFileSync(
        path.join(repoPath, '.build-meta.json'),
        JSON.stringify({ commit: metaCommit, branch: metaBranch, builtAt: buildArgs.BUILD_DATE }, null, 2)
      );
    } catch (err: any) {
      emit(`[Build] Could not write .build-meta.json: ${err?.message || err}`, 'warning');
    }

    await dockerClient.buildImage(repoPath, imageName, (msg) => {
      emit(`[Docker] ${msg}`, 'info');
    }, buildArgs);
    emit('[Done] Docker image build completed', 'success');
  } else {
    emit('[Skip] No build target, docker compose will pull images at start', 'info');
  }

  // CasaOS: save to metadata path (only after successful build)
  if (isCasaOS) {
    emit('[PCS] Saving CasaOS metadata...', 'info');
    await saveToCasaOSMetadata(appName, composeContent, (msg) => emit(msg, 'info'));
  }

  // Record the commit this was built from, read directly from the repo
  // (source registry may not be up-to-date if clone just happened)
  if (instance.sourceId) {
    try {
      const simpleGit = require('simple-git').simpleGit;
      const git = simpleGit(repoPath);
      const log = await git.log({ maxCount: 1 });
      if (log.latest?.hash) {
        updateLastBuiltCommit(botId, log.latest.hash);
      }
    } catch (err) {
      // Fallback to source registry
      const source = sourceManager.getSource(instance.sourceId);
      if (source?.lastCommitHash) {
        updateLastBuiltCommit(botId, source.lastCommitHash);
      }
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

/**
 * Reconcile registry state with actual Docker container state.
 *
 * Detects drift from external events:
 *   - CasaOS stop/start of a managed bot
 *   - Container crash (exit, OOM, etc.)
 *   - Host reboot with restart: unless-stopped bringing containers back up
 *   - Manual docker stop/start on the host
 *
 * Only reconciles bots in terminal states (running/stopped/error). Transient
 * states (stopping/starting/building) are skipped to avoid interfering with
 * in-flight operations the manager is driving itself.
 */
export async function syncContainerStates(): Promise<void> {
  const registry = loadRegistry();
  const containers = await dockerClient.listBotContainers();

  for (const instance of Object.values(registry.instances)) {
    if (instance.status !== 'running' && instance.status !== 'stopped' && instance.status !== 'error') {
      continue;
    }

    const appName = resolveAppName(instance.id);
    const botContainers = containers.filter(c => c.name.startsWith(appName));
    const runningContainers = botContainers.filter(c => c.state === 'running');
    const runningIds = runningContainers.map(c => c.id);

    if (instance.status === 'running' && runningContainers.length === 0) {
      console.log(`[Reconciler] ${instance.id} registry=running but no running containers - marking stopped`);
      updateBotStatus(instance.id, 'stopped', []);
    } else if (instance.status !== 'running' && runningContainers.length > 0) {
      console.log(`[Reconciler] ${instance.id} registry=${instance.status} but containers are running - marking running`);
      updateBotStatus(instance.id, 'running', runningIds);
    } else if (instance.status === 'running') {
      const currentIds = (instance.containerIds || []).slice().sort().join(',');
      const newIds = runningIds.slice().sort().join(',');
      if (currentIds !== newIds) {
        updateBotStatus(instance.id, 'running', runningIds);
      }
    }
  }
}

// ─── Helpers ───

function extractRepoName(url: string): string {
  // https://github.com/owner/my-bot.git -> my-bot
  const match = url.match(/\/([^\/]+?)(?:\.git)?$/);
  return match ? match[1] : 'unnamed-bot';
}
