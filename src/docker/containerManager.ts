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
import * as crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';

const execAsync = promisify(exec);
import {
  InstanceConfig, InstanceRegistry, BotStatus, BotSourceType, DeploymentMode,
  CreateInstanceRequest, CreateDockerImageInstanceRequest, UpdateInstanceRequest,
  DetectionResult, FleetDbRecord, FleetDbReplication, FleetDbReplicaRecord, RecoveryChannelRecord, RecoveryRescueRecord,
} from '../types';
import * as dockerClient from './dockerClient';
import { DockerLogFn } from './outputStream';
import { allocateHostPort } from './portAllocator';
import { getBotDir, getDataPath, getEnvPath } from '../git/repoManager';
import { findImageDataPath } from '../source/imageHints';
import { detectBotType } from '../detection';
import { generateDockerfile } from '../templates/dockerfiles';
import {
  generateCompose,
  writeComposeFile,
  hasExistingCompose,
  generateImageCompose,
  getComposeBuildInfo,
  extractBuildTarget,
  replaceServiceImageWithBuild,
  extractComposeBuildArgs,
  findBuildServices,
  replaceBuildsWithImages,
  ComposeResult
} from '../templates/compose';
import { applyVariableSubstitution } from '../templates/variableSubstitution';
import {
  processComposeForCasaOS,
  getMainServiceWebPort,
  getWebUiIndexPath,
  publishHostPort,
  attachBotToProxy,
  mainServiceSelfAuths,
  getFleetControlPort,
  fleetIsSameBox,
  fleetPublicHost,
  transferPublicHost,
  fleetAppContainerName,
  attachFleetToProxy,
  getPublishedFleetHostPort,
  publishFleetHostPort,
  addFleetPostgresService,
  addFleetPostgresReplicaService,
  removeFleetPostgresReplicaService,
  prepareDockerBotFiles,
  redeliverDockerConfigFiles,
  fixDockerBotOwnership,
  getAppServiceName,
  extractAppName,
  createVolumeDirectories,
  saveToCasaOSMetadata,
  writeStatusPage,
  writeComposeEnvFile,
  addConfigFileBinds,
  writeConfigFiles,
  applyUserConfigOverrides,
  redeliverConfigFiles,
  fixPostDeployOwnership,
  executeInstallCommand,
  removeFleetPostgresService
} from '../templates/pcsProcessing';
import { generateStatusPageHtml } from '../templates/statusPage';
import * as configFileManager from '../config/configFileManager';
import * as envManager from '../env/manager';
import { composeDeclaresFleet } from '../env/envList';
import { getDeploymentMode } from '../casaos/detector';
import * as casaosApi from '../casaos/api';
import { logCollectors, LogCollector, BuildLogEntry } from '../build/logCollector';
import * as sourceManager from '../source/sourceManager';
import { sanitizeName, titleizeName, resolveNames, makeUniqueName } from '../naming';
import { substituteComposeNames } from '../compose/nameSubstitution';
import YAML from 'yaml';

const DATA_DIR = process.env.DATA_DIR || '/data/data';
const REGISTRY_FILE = path.join(DATA_DIR, 'instances.json');

/**
 * The bot's data dir as the HOST daemon sees it (for docker-mode bind sources).
 * Must be an absolute, forward-slash path: when HOST_DATA_DIR is set (containerized
 * manager) it is used verbatim; otherwise DATA_DIR is resolved to an absolute host
 * path (native run / same-path bind). A relative path would make the daemon resolve
 * the bind against the bot's compose dir instead of the shared data root.
 */
export function hostBotDirFor(botId: string): string {
  const root = (process.env.HOST_DATA_DIR || path.resolve(DATA_DIR)).replace(/\\/g, '/').replace(/\/+$/, '');
  return `${root}/bots/${botId}`;
}

type BroadcastFn = (type: string, data: any) => void;
let broadcastFn: BroadcastFn | null = null;

export function setContainerBroadcast(fn: BroadcastFn): void {
  broadcastFn = fn;
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
    // Preserve a corrupt registry instead of letting the next save overwrite it with
    // an empty one - keeps the bots recoverable rather than silently lost.
    try {
      if (fs.existsSync(REGISTRY_FILE)) fs.copyFileSync(REGISTRY_FILE, `${REGISTRY_FILE}.corrupt`);
    } catch { /* best effort */ }
  }
  return { instances: {} };
}

function saveRegistrySync(registry: InstanceRegistry): void {
  try {
    fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });
    // Atomic write: a truncated/interrupted write (e.g. the container killed mid-save
    // during a rebuild) would otherwise corrupt the file, and the next load would
    // silently fall back to an empty registry and then persist it - losing every bot.
    const tmp = `${REGISTRY_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(registry, null, 2));
    fs.renameSync(tmp, REGISTRY_FILE);
  } catch (error) {
    console.error('[ContainerManager] Failed to save registry:', error);
    throw error;
  }
}

// Synchronous so that each mutator's load -> modify -> save is atomic on the single
// JS thread. A deferred (queued) write let a concurrent mutator load a stale snapshot
// and then revert another's field (e.g. the reconciler clobbering lastBuiltCommit).
function saveRegistry(registry: InstanceRegistry): void {
  saveRegistrySync(registry);
}

// ─── Registry Accessors ───

// Open button gating: a bot that implements the readiness ping (POST
// /webui-ready) flips webUiReady precisely at boot; any other bot is treated
// reachable once this grace period since its last start elapses, so the gate
// never sticks on bots that do not ping.
const WEBUI_READY_GRACE_MS = 90000;

export function isBotWebUiReady(inst: InstanceConfig): boolean {
  if (inst.webUiReady) return true;
  if (typeof inst.lastStartAt === 'number') return Date.now() - inst.lastStartAt > WEBUI_READY_GRACE_MS;
  return true; // never (re)started under readiness tracking: do not gate
}

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

  // Prebuilt-image source: create a docker-image instance instead of cloning.
  if (source.sourceType === 'docker-image' && source.imageRef) {
    return createDockerImageInstance({
      displayName: request.displayName || source.composeName || source.imageRef.split('/').pop()!.split(':')[0],
      imageRef: source.imageRef,
      envVars: request.envVars,
    });
  }

  // Derive names. A reserved or already-used name is auto-uniquified
  // ("Bot" -> "Bot 2") rather than rejected.
  const existing = Object.values(registry.instances);
  const defaultName = source.composeName || extractRepoName(source.url);
  const displayName = makeUniqueName(request.displayName || defaultName, existing);
  const names = resolveNames(displayName);

  const instanceId = uuidv4();
  const now = new Date().toISOString();
  const updateToken = uuidv4();

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
    envVars: request.envVars || {},
    botType: detection?.type,
    hasDatabase: detection?.hasDatabase,
    databases: detection?.databases,
    needsLavalink: detection?.needsLavalink,
    hasWebDashboard: detection?.hasWebDashboard,
    tokenVarName: detection?.tokenVarDetected ? detection.tokenVarName : undefined,
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

  // Auto-uniquify a reserved or already-used name ("Bot" -> "Bot 2").
  const existing = Object.values(registry.instances);
  const names = resolveNames(makeUniqueName(request.displayName, existing));

  const instanceId = uuidv4();
  const now = new Date().toISOString();
  const updateToken = uuidv4();

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

/**
 * Update the sidecar backup schedule (enabled / hour / keep).
 */
export function updateInstanceFleetBackup(botId: string, enabled: boolean, hour?: number, keep?: number): InstanceConfig | null {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (!instance) return null;

  const current = instance.fleetBackup || { enabled: true, hour: 4, keep: 7 };
  instance.fleetBackup = {
    enabled,
    hour: hour !== undefined ? Math.max(0, Math.min(23, hour)) : current.hour,
    keep: keep !== undefined ? Math.max(1, Math.min(365, keep)) : current.keep,
  };
  instance.updatedAt = new Date().toISOString();
  registry.instances[botId] = instance;
  saveRegistry(registry);
  return instance;
}

/**
 * Persist (or clear) the sidecar's replication posture; optionally mirrors a
 * rewritten DATA_BACKEND_URL into the instance record alongside it (the env
 * store copy is the caller's job). Applies to the compose on the next start.
 */
export function updateInstanceFleetDbReplication(
  botId: string,
  replication: FleetDbReplication | null,
  envUrl?: string,
): InstanceConfig | null {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (!instance || !instance.fleetDb) return null;
  if (replication) {
    instance.fleetDb = { ...instance.fleetDb, replication };
  } else {
    const { replication: _drop, ...rest } = instance.fleetDb;
    instance.fleetDb = rest;
  }
  if (envUrl !== undefined) instance.envVars = { ...instance.envVars, DATA_BACKEND_URL: envUrl };
  instance.updatedAt = new Date().toISOString();
  saveRegistry(registry);
  return instance;
}

/** Persist (or clear) the standby record (PLAN_REPLICATION.md Stage 2). */
export function updateInstanceFleetDbReplica(botId: string, replica: FleetDbReplicaRecord | null): InstanceConfig | null {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (!instance) return null;
  if (replica) instance.fleetDbReplica = replica;
  else delete instance.fleetDbReplica;
  instance.updatedAt = new Date().toISOString();
  saveRegistry(registry);
  return instance;
}

export function updateInstanceRecoveryChannel(botId: string, channel: RecoveryChannelRecord | null): InstanceConfig | null {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (!instance) return null;
  if (channel) instance.recoveryChannel = channel;
  else delete instance.recoveryChannel;
  instance.updatedAt = new Date().toISOString();
  saveRegistry(registry);
  return instance;
}

export function updateInstanceRecoveryRescue(botId: string, rescue: RecoveryRescueRecord | null): InstanceConfig | null {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (!instance) return null;
  if (rescue) instance.recoveryRescue = rescue;
  else delete instance.recoveryRescue;
  instance.updatedAt = new Date().toISOString();
  saveRegistry(registry);
  return instance;
}

/**
 * Write the standby service into the DEPLOYED compose and start it (targeted
 * up; the running app service is untouched). Used by the provisioning flow;
 * rebuilds re-inject via buildGitInstance.
 */
export async function applyFleetDbReplicaService(botId: string): Promise<{ success: boolean; error?: string }> {
  const instance = getBot(botId);
  if (!instance?.fleetDbReplica) return { success: false, error: 'No standby record' };
  const appName = resolveAppName(botId);
  const composePath = resolveComposePath(botId, appName);
  if (!fs.existsSync(composePath)) return { success: false, error: 'Deployed compose not found (install the instance first)' };
  const mode = await getDeploymentMode();
  const content = fs.readFileSync(composePath, 'utf-8');
  const updated = addFleetPostgresReplicaService(content, instance as any, instance.fleetDbReplica, { mode });
  fs.writeFileSync(composePath, updated);
  try {
    await execAsync(`docker compose -f "${composePath}" -p "${appName}" up -d fleet-postgres-replica`);
    return { success: true };
  } catch (err) {
    // A ghost service in the deployed compose would break every later start
    // (up runs --remove-orphans and fails on the same cause): revert the file
    // so a failed apply leaves no trace.
    try {
      fs.writeFileSync(composePath, removeFleetPostgresReplicaService(fs.readFileSync(composePath, 'utf-8')));
    } catch { /* the original content write below the error is best effort */ }
    return { success: false, error: String(err) };
  }
}

/** True when the instance has a deployed compose to attach services to. */
export function deployedComposeExists(botId: string): boolean {
  try {
    return fs.existsSync(resolveComposePath(botId, resolveAppName(botId)));
  } catch {
    return false;
  }
}

/**
 * Record a promoted standby as THIS machine's fleet database
 * (PLAN_REPLICATION.md Stage 5). After a pair promotion the bot serves its
 * local copy, but the manager still files it as somebody else's standby, so
 * the replication surface (and the copy block the old machine needs to be
 * re-seeded from) is unreachable. Record only: the container and volume are
 * the ones already running.
 */
export function adoptFleetDbReplicaAsPrimary(botId: string): { success: boolean; error?: string } {
  const registry = loadRegistry();
  const stored = registry.instances[botId];
  if (!stored) return { success: false, error: 'Bot not found' };
  const replica = stored.fleetDbReplica;
  if (!replica) return { success: false, error: 'This instance has no standby to adopt' };
  if (stored.fleetDb) return { success: false, error: 'This instance already hosts a fleet database' };
  stored.fleetDb = { containerName: replica.containerName, user: 'smdb', db: 'smdb', volume: replica.volume };
  delete stored.fleetDbReplica;
  stored.updatedAt = new Date().toISOString();
  saveRegistry(registry);
  const live = getBot(botId);
  if (live) {
    live.fleetDb = { ...stored.fleetDb };
    delete live.fleetDbReplica;
  }
  return { success: true };
}

/**
 * Bring ONLY the managed database sidecar up and wait for it to accept
 * connections. Stopping an instance takes its whole compose project down, so
 * the stale-primary re-seed (PLAN_REPLICATION.md Stage 5) has no database to
 * dump until this runs; the app service is deliberately left down.
 */
export async function startFleetDbSidecar(botId: string): Promise<{ success: boolean; error?: string }> {
  const instance = getBot(botId);
  const fleetDb = instance?.fleetDb;
  if (!instance || !fleetDb) return { success: false, error: 'This instance hosts no managed fleet database' };
  const appName = resolveAppName(botId);
  const composePath = resolveComposePath(botId, appName);
  if (!fs.existsSync(composePath)) return { success: false, error: 'Deployed compose not found' };
  // Resolve the service key by container_name: an adopted standby keeps the
  // replica service name until its next rebuild, so 'fleet-postgres' is not
  // a given (same reason syncComposeEnvVars keys on container_name).
  let service = 'fleet-postgres';
  try {
    const compose = YAML.parseDocument(fs.readFileSync(composePath, 'utf-8')).toJSON();
    for (const [key, svc] of Object.entries((compose?.services || {}) as Record<string, any>)) {
      // The key rides a shell line below; a repo-authored key never gets there.
      if (svc?.container_name === fleetDb.containerName && /^[A-Za-z0-9._-]+$/.test(key)) { service = key; break; }
    }
  } catch { /* default stands */ }
  try {
    await execAsync(`docker compose -f "${composePath}" -p "${appName}" up -d ${service}`);
  } catch (err) {
    return { success: false, error: String(err) };
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await execAsync(`docker exec "${fleetDb.containerName}" pg_isready -U "${fleetDb.user}" -d "${fleetDb.db}"`);
      return { success: true };
    } catch {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  return { success: false, error: 'database did not become ready within 30 seconds' };
}

/**
 * Retire the managed PRIMARY sidecar (PLAN_REPLICATION.md Stage 5): the stale
 * half of a failed-over pair stops hosting the fleet database and follows the
 * new primary instead. Service, container, volume and record all go, because
 * a kept volume with no record naming it is debris no UI could ever clear.
 * The caller has already dumped whatever it wanted to keep.
 */
export async function retireFleetDbSidecar(botId: string): Promise<{ success: boolean; error?: string }> {
  const instance = getBot(botId);
  const fleetDb = instance?.fleetDb;
  if (!instance || !fleetDb) return { success: false, error: 'This instance hosts no managed fleet database' };
  try {
    const appName = resolveAppName(botId);
    const composePath = resolveComposePath(botId, appName);
    if (fs.existsSync(composePath)) {
      fs.writeFileSync(composePath, removeFleetPostgresService(fs.readFileSync(composePath, 'utf-8')));
    }
    await execAsync(`docker rm -f "${fleetDb.containerName}"`).catch(() => { /* already gone */ });
    if (!dockerClient.removeVolume(fleetDb.volume)) {
      return { success: false, error: `could not remove the old database volume ${fleetDb.volume}; the container may still be running` };
    }
    const registry = loadRegistry();
    const stored = registry.instances[botId];
    if (stored) {
      delete stored.fleetDb;
      stored.updatedAt = new Date().toISOString();
      saveRegistry(registry);
    }
    delete instance.fleetDb;
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/** Remove the standby service from the deployed compose and its container; the volume stays. */
export async function removeFleetDbReplicaService(botId: string, containerName: string): Promise<{ success: boolean; error?: string }> {
  const appName = resolveAppName(botId);
  const composePath = resolveComposePath(botId, appName);
  try {
    if (fs.existsSync(composePath)) {
      fs.writeFileSync(composePath, removeFleetPostgresReplicaService(fs.readFileSync(composePath, 'utf-8')));
    }
    await execAsync(`docker rm -f "${containerName}"`).catch(() => { /* already gone */ });
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Persist the timestamp of the last successful sidecar dump (survives restarts,
 * drives the stale-backup badge).
 */
export function setLastFleetBackupAt(botId: string, at: number): void {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (!instance) return;
  instance.lastFleetBackupAt = at;
  saveRegistry(registry);
}

/**
 * Update the instance's public URL auth mode (applies on next start).
 */
export function updateInstanceWebAuth(botId: string, mode: 'auto' | 'managed' | 'public'): InstanceConfig | null {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (!instance) return null;

  instance.webAuth = mode;
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
    // sanitizedName is the compose project of the deployed containers; changing
    // it while they may exist orphans the live project (stop, start and the
    // state reconciler all key off the new name). Cosmetic display changes
    // that resolve to the same sanitizedName stay allowed.
    if (
      names.sanitizedName !== instance.sanitizedName &&
      instance.status !== 'stopped' && instance.status !== 'error'
    ) {
      throw new Error('Cannot rename a bot that is not stopped; stop it first');
    }
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
 * Remove env keys from an instance. updateBot only merges, so key removal
 * needs its own path.
 */
export function removeBotEnvVars(botId: string, keys: string[]): InstanceConfig | null {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (!instance) return null;
  if (instance.envVars) for (const key of keys) delete instance.envVars[key];
  instance.updatedAt = new Date().toISOString();
  registry.instances[botId] = instance;
  saveRegistry(registry);
  return instance;
}

/**
 * Strip a deleted env key from the DEPLOYED compose copies. syncComposeEnvVars
 * deliberately keeps keys it does not manage, so without this the baked
 * literal keeps flowing to the container until the next full rebuild.
 */
export function removeEnvKeyFromDeployedCompose(botId: string, key: string): void {
  const instance = getBot(botId);
  if (!instance) return;
  const dataRoot = process.env.DATA_ROOT || '/DATA';
  const candidates = [
    path.join(getBotDir(botId), 'docker-compose.yml'),
    path.join(dataRoot, 'AppData', 'casaos', 'apps', instance.sanitizedName, 'docker-compose.yml'),
  ];
  for (const composePath of candidates) {
    if (!fs.existsSync(composePath)) continue;
    try {
      const compose = YAML.parseDocument(fs.readFileSync(composePath, 'utf-8')).toJSON();
      const services = compose?.services;
      if (!services || typeof services !== 'object') continue;
      const appName = getAppServiceName(compose);
      const svc = appName ? services[appName] : undefined;
      if (!svc?.environment) continue;
      deleteComposeEnv(svc.environment, key);
      fs.writeFileSync(composePath, YAML.stringify(compose, { lineWidth: 0 }));
    } catch (err) {
      console.warn(`[ContainerManager] Failed to strip env key ${key} from ${composePath}: ${err}`);
    }
  }
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
 * The deployed compose body for a bot, or null when it has never been deployed.
 */
export function readDeployedCompose(botId: string): string | null {
  try {
    const composePath = resolveComposePath(botId, resolveAppName(botId));
    if (!fs.existsSync(composePath)) return null;
    return fs.readFileSync(composePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Docker image name: {sanitizedName}-{instanceId}:latest
 */
function getImageName(instance: InstanceConfig): string {
  return `${instance.sanitizedName}-${instance.id}:latest`;
}

// ─── Per-Bot Operation Lock ───

// Server-side guard: the UI's busy tracking is client-only, so two tabs or a
// user racing a scheduler could run conflicting lifecycle ops on the same bot.
// The lock is held for the whole top-level operation; composite ops (restart,
// update, start's build safety net) call the unguarded *Impl functions
// internally so an op chain never blocks itself.
const activeOps = new Map<string, string>();

export function isBotBusy(botId: string): string | null {
  return activeOps.get(botId) || null;
}

async function withBotOp<T>(botId: string, op: string, fn: () => Promise<T>): Promise<T> {
  const current = activeOps.get(botId);
  if (current) {
    throw new Error(`Operation '${current}' is already in progress for this bot`);
  }
  activeOps.set(botId, op);
  try {
    return await fn();
  } finally {
    activeOps.delete(botId);
  }
}

/** Op-lock for long-running work owned by other modules (e.g. replica seeding):
 * start/rebuild/delete refuse while it holds the lock, and vice versa. */
export function withExternalBotOp<T>(botId: string, op: string, fn: () => Promise<T>): Promise<T> {
  return withBotOp(botId, op, fn);
}

type EmitFn = (msg: string, type?: BuildLogEntry['type'], key?: string) => void;

// Logged variant for session ops (start/build/update/restart): the lock and the
// collector's beginOp both run synchronously before any await, so a client that
// connects after the trigger POST resolves always sees the running session.
async function withLoggedBotOp(
  botId: string,
  op: string,
  fn: () => Promise<{ success: boolean; error?: string }>
): Promise<{ success: boolean; error?: string }> {
  const current = activeOps.get(botId);
  if (current) {
    throw new Error(`Operation '${current}' is already in progress for this bot`);
  }
  activeOps.set(botId, op);
  const log = logCollectors.get(botId);
  log.beginOp(op);
  try {
    const result = await fn();
    if (result.success) log.endOp('done');
    else log.endOp('failed', result.error || 'unknown error');
    return result;
  } catch (err) {
    log.endOp('failed', String(err));
    throw err;
  } finally {
    activeOps.delete(botId);
  }
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

  // 2. Force-remove any remaining containers from this compose project.
  // Scope strictly to the compose-project label, which is an exact match.
  // Docker's `name` filter is a SUBSTRING match, so a generic appName like
  // "bot" would force-remove every container whose name contains it - including
  // the manager itself (discordbotmanagerapp).
  try {
    await execAsync(
      `docker ps -aq --filter "label=com.docker.compose.project=${appName}" | xargs -r docker rm -f`,
      { timeout: 30000 }
    );
    // Verify no containers linger
    const { stdout } = await execAsync(
      `docker ps -aq --filter "label=com.docker.compose.project=${appName}"`,
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

  // 3. Remove orphan networks (same project-label scoping as containers; the
  // shared external `pcs` network carries no project label and is never matched).
  try {
    await execAsync(
      `docker network ls --filter "label=com.docker.compose.project=${appName}" --format "{{.Name}}" | xargs -r docker network rm`,
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

/**
 * Tear down a docker-mode bot: `compose down` then a label-scoped force-remove of
 * any lingering containers and the project's networks. No CasaOS metadata steps.
 */
async function performDockerCleanup(appName: string, composePath: string): Promise<{ failures: string[] }> {
  const failures: string[] = [];

  if (fs.existsSync(composePath)) {
    try {
      await dockerClient.composeDown(composePath, appName);
    } catch (err) {
      failures.push(`compose down ${appName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Force-remove any lingering containers / networks for this compose project.
  // Done in JS (list, then remove) - no shell pipe / `xargs`, so it works on
  // Windows too (compose down above already handles the normal case).
  try {
    const { stdout } = await execAsync(
      `docker ps -aq --filter "label=com.docker.compose.project=${appName}"`,
      { timeout: 15000 }
    );
    const ids = stdout.split('\n').map(s => s.trim()).filter(Boolean);
    if (ids.length) await execAsync(`docker rm -f ${ids.join(' ')}`, { timeout: 30000 });
  } catch (err) {
    failures.push(`force-remove containers ${appName}: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const { stdout } = await execAsync(
      `docker network ls --filter "label=com.docker.compose.project=${appName}" --format "{{.Name}}"`,
      { timeout: 10000 }
    );
    const nets = stdout.split('\n').map(s => s.trim()).filter(Boolean);
    if (nets.length) await execAsync(`docker network rm ${nets.join(' ')}`, { timeout: 10000 });
  } catch (err) {
    failures.push(`networks ${appName}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { failures };
}

export async function deleteBot(botId: string, keepData: boolean = false): Promise<boolean> {
  return withBotOp(botId, 'delete', () => deleteBotImpl(botId, keepData));
}

/**
 * Everything a delete is responsible for removing that still exists. Empty
 * means the delete achieved its goal regardless of what individual steps
 * reported (an already-uninstalled app fails the API call but leaves nothing).
 */
async function listDeleteRemnants(
  instance: InstanceConfig,
  appName: string,
  botDir: string,
  keepData: boolean,
  deploymentMode: DeploymentMode
): Promise<string[]> {
  const remnants: string[] = [];
  try {
    const containers = await dockerClient.listBotContainers();
    for (const c of containers) {
      if (c.name.startsWith(appName) || c.name.includes(`-${instance.id}-`)) {
        remnants.push(`container ${c.name}`);
      }
    }
  } catch {
    // Cannot see containers at all: do not deregister on blind faith.
    remnants.push('unverified containers (docker unreachable)');
  }

  try {
    const imageName = getImageName(instance);
    if (await dockerClient.imageExists(imageName)) remnants.push(`image ${imageName}`);
  } catch { /* ignore */ }

  if (!keepData) {
    try {
      for (const v of dockerClient.listProjectVolumes(appName)) remnants.push(`volume ${v}`);
    } catch { /* ignore */ }
    if (fs.existsSync(botDir)) remnants.push(`directory ${botDir}`);
  } else if (fs.existsSync(path.join(botDir, 'docker-compose.yml'))) {
    remnants.push(`compose file in ${botDir}`);
  }

  if (deploymentMode === 'casaos') {
    const dataRoot = process.env.DATA_ROOT || '/DATA';
    if (fs.existsSync(path.join(dataRoot, 'AppData', 'casaos', 'apps', appName))) {
      remnants.push('CasaOS app metadata');
    }
    if (!keepData && fs.existsSync(path.join(dataRoot, 'AppData', appName))) {
      remnants.push(`AppData/${appName}`);
    }
  }
  return remnants;
}

async function deleteBotImpl(botId: string, keepData: boolean): Promise<boolean> {
  const instance = getBot(botId);
  if (!instance) return false;

  const deploymentMode = await getDeploymentMode();
  const appName = resolveAppName(botId);
  const botDir = getBotDir(botId);

  // Transient status: the reconciler only touches terminal states, so the bot
  // can't be flipped back to running/stopped while containers go down.
  updateBotStatus(botId, 'stopping');

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
      const composePath = path.join(botDir, 'docker-compose.yml');
      const cleanup = await performDockerCleanup(appName, composePath);
      failures.push(...cleanup.failures);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    failures.push(`uninstall step: ${msg}`);
  }

  // 2. Remove Docker image
  const imageName = getImageName(instance);
  try {
    if (await dockerClient.imageExists(imageName)) {
      console.log(`[ContainerManager] Removing image ${imageName}...`);
      const ok = await dockerClient.removeImage(imageName);
      if (!ok) failures.push(`image ${imageName}: docker rmi reported failure`);
      // Verify the image is actually gone - rmi can return success in some
      // edge cases (force-removed dangling tag) while another tag of the
      // same image keeps it present. Treat lingering image as a failure.
      else if (await dockerClient.imageExists(imageName)) {
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

  // 3b. Standby replica leftovers: its volume is custom-named (never project-
  // prefixed, so step 3 misses it) and a leftover would block any same-name
  // reinstall from provisioning. Deleting the standby also orphans the
  // PRIMARY's replication slot, which retains WAL over there - warn loudly.
  if (instance.fleetDbReplica) {
    await execAsync(`docker rm -f "${instance.fleetDbReplica.containerName}"`).catch(() => { /* project down got it */ });
    await execAsync(`docker rm -f "${instance.sanitizedName}-fleet-replica-seed"`).catch(() => { /* no ghost seeder */ });
    if (!keepData && !dockerClient.removeVolume(instance.fleetDbReplica.volume)) {
      failures.push(`replica volume ${instance.fleetDbReplica.volume}: docker volume rm reported failure`);
    }
    console.warn(`[ContainerManager] Instance ${botId} hosted a database standby: the PRIMARY at ${instance.fleetDbReplica.primaryHost}:${instance.fleetDbReplica.primaryPort} keeps an orphaned replication slot that retains WAL - disable replication there or provision a new replica soon`);
  }

  // 3c. Recovery-channel helpers: never compose-managed, so nothing else
  // removes them. The peer machine keeps redialing until disarmed there.
  if (instance.recoveryChannel) {
    await execAsync(`docker rm -f "${instance.recoveryChannel.containerName}"`).catch(() => { /* already gone */ });
    await execAsync(`docker rm -f "${instance.sanitizedName}-recovery-rsyncd"`).catch(() => { /* RC-3 daemon absent */ });
    await execAsync(`docker rm -f "${instance.sanitizedName}-recovery-rsync"`).catch(() => { /* RC-3 client absent */ });
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

  if (failures.length > 0) {
    // Judge by the goal, not the step results: a retry after a partial delete
    // (or an app someone already removed) hits step errors like "app not
    // found" even though nothing is left to clean, and would otherwise stay
    // stuck in error forever. Only keep the registry entry when something the
    // delete owns actually remains; then the user retains a Delete button to
    // retry against the listed remnants.
    const remnants = await listDeleteRemnants(instance, appName, botDir, keepData, deploymentMode);
    if (remnants.length > 0) {
      updateBotStatus(botId, 'error');
      const summary =
        `Bot ${botId} uninstall incomplete - still present: ${remnants.join(', ')}\n` +
        `Step errors:\n  - ${failures.join('\n  - ')}`;
      console.error(`[ContainerManager] ${summary}`);
      throw new Error(summary);
    }
    console.warn(`[ContainerManager] Uninstall steps reported errors but nothing remains for ${appName}; treating as complete: ${failures.join('; ')}`);
  }

  // Cleanup succeeded: remove the registry entry LAST. Fresh load - the
  // snapshot from function entry is stale after the status updates above.
  const registry = loadRegistry();
  delete registry.instances[botId];
  saveRegistry(registry);
  logCollectors.remove(botId);

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
    // A (re)start means the bot is booting again and its web UI is not reachable
    // until it pings back ready (or the grace period elapses); gate Open on that.
    if (status === 'starting') {
      instance.webUiReady = false;
      instance.lastStartAt = Date.now();
    }
    if (containerIds !== undefined) {
      instance.containerIds = containerIds || [];
    }
    instance.updatedAt = new Date().toISOString();
    registry.instances[botId] = instance;
    saveRegistry(registry);
    if (broadcastFn) {
      broadcastFn('bot:status', { id: botId, status, activeOp: isBotBusy(botId) });
    }
    // A bot that does not implement the readiness ping never flips webUiReady;
    // nudge the UI once the grace period elapses so its Open button un-gates.
    if (status === 'starting') {
      setTimeout(() => {
        if (broadcastFn) broadcastFn('bot:updated', getBot(botId));
      }, WEBUI_READY_GRACE_MS).unref();
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

/** Bot -> manager readiness ping: the bot's web UI is serving. Gates the Open button. */
export function setWebUiReady(botId: string, ready: boolean): void {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (instance && instance.webUiReady !== ready) {
    instance.webUiReady = ready;
    instance.updatedAt = new Date().toISOString();
    registry.instances[botId] = instance;
    saveRegistry(registry);
  }
}

// Base domain for per-bot subdomains in remote mode (e.g. the sslip.io IP host or
// your registrable domain). When set, a web bot is routed through the bundled Caddy
// at <sanitizedName>.<base> over TLS, in addition to its localhost host-port.
const BOT_DOMAIN_BASE = process.env.BOT_DOMAIN_BASE || '';

function updateInstanceWebAccess(botId: string, hostPort?: number, webContainerPort?: number, publicUrl?: string, webUiPath?: string, fleetHostPort?: number, transferHostPort?: number): void {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (instance) {
    instance.hostPort = hostPort;
    instance.webContainerPort = webContainerPort;
    instance.publicUrl = publicUrl;
    instance.webUiPath = webUiPath;
    instance.fleetHostPort = fleetHostPort;
    instance.transferHostPort = transferHostPort;
    instance.updatedAt = new Date().toISOString();
    registry.instances[botId] = instance;
    saveRegistry(registry);
  }
}

/**
 * Docker mode: publish the bot's web UI on a host port (no Caddy gateway) and
 * persist it on the instance. A bot keeps its port across rebuilds. Headless bots
 * (no detectable web port) get no host port. Returns the updated compose content.
 */
function applyDockerHostPort(composeContent: string, instance: InstanceConfig): string {
  const info = getMainServiceWebPort(composeContent);
  let content = composeContent;
  let webUiPath: string | undefined;
  let publicUrl: string | undefined;
  let hostPort: number | undefined;

  // A running bot publishes its own port; that must not block reusing it on rebuild.
  const isOwnContainer = (name: string) =>
    name.startsWith(instance.sanitizedName) || name.includes(`-${instance.id}-`);
  const portsClaimedByOthers = () => {
    const used = new Set<number>();
    for (const b of getAllBots()) {
      if (b.id === instance.id) continue;
      if (typeof b.hostPort === 'number') used.add(b.hostPort);
      const bFleet = b.fleetHostPort;
      if (typeof bFleet === 'number') used.add(bFleet);
      const bTransfer = b.transferHostPort;
      if (typeof bTransfer === 'number') used.add(bTransfer);
    }
    return used;
  };
  const portsBoundOnHost = () => {
    const hostBound = new Set<number>();
    for (const [port, names] of dockerClient.listPublishedHostPorts()) {
      if (!names.every(isOwnContainer)) hostBound.add(port);
    }
    return hostBound;
  };

  if (info) {
    // Web entry path the bot declares (x-casaos.index, hash already substituted).
    webUiPath = getWebUiIndexPath(content) || undefined;

    // Remote mode: a public base (its own sub-level, e.g. dbot.<domain>) is
    // configured -> route the bot through the bundled Caddy at <name>.<base> with
    // automatic TLS (in addition to a localhost port). The base is a dedicated
    // sub-level so per-bot names live under *.<base> and never touch the apex
    // domain, its other subdomains, or the manager/auth hosts.
    if (BOT_DOMAIN_BASE) {
      const host = `${instance.sanitizedName}.${BOT_DOMAIN_BASE}`;
      // Auth in front of the public vhost: explicit instance setting wins; in auto
      // mode a self-authenticating main service is left to protect itself, everything
      // else goes behind our managed gate (Authelia MFA on this stack).
      const forwardAuth =
        instance.webAuth === 'public' ? false :
        instance.webAuth === 'managed' ? true :
        !mainServiceSelfAuths(content);
      content = attachBotToProxy(content, host, info.containerPort, { forwardAuth });
      publicUrl = `https://${host}`;
    }

    // Localhost host-port (tunnel fallback + the Open link when not proxied).
    if (info.existingHostPort !== null) {
      hostPort = info.existingHostPort;   // compose already publishes it; keep that mapping
    } else {
      const allocated = allocateHostPort({
        botId: instance.id,
        reuse: instance.hostPort,
        used: portsClaimedByOthers(),
        hostBound: portsBoundOnHost(),
      });
      if (allocated !== null) {
        hostPort = allocated;
        content = publishHostPort(content, allocated, info.containerPort);
      }
    }
  }

  // Fleet control endpoint (marker-driven): EVERY fleet node with a public base
  // gets a wss control route on the bundled Caddy (no forward_auth -
  // CONTROL_SECRET is the auth). Master-only before the warm-standby arc
  // (PLAN_STANDBY 3.6): a promotable backup must be dialable in advance, so
  // every node's route exists before any failover. Every marker instance also
  // gets a localhost-bound control host-port for host-level tooling; same-box
  // workers dial the master's container name over dbm_internal.
  const controlPort = getFleetControlPort(content);
  let fleetHostPort: number | undefined;
  let transferHostPort: number | undefined;
  if (controlPort !== null) {
    const transferPort = controlPort + 1;
    if (BOT_DOMAIN_BASE) {
      content = attachFleetToProxy(content, `${instance.sanitizedName}-fleet.${BOT_DOMAIN_BASE}`, controlPort);
    }
    // Transfer route: EVERY fleet node advertises one (migration legs dial in
    // either direction), unlike the master-only control route.
    if (BOT_DOMAIN_BASE) {
      content = attachFleetToProxy(content, `${instance.sanitizedName}-transfer.${BOT_DOMAIN_BASE}`, transferPort, { envKey: 'TRANSFER_URL' });
    }
    const existing = getPublishedFleetHostPort(content, controlPort);
    if (existing !== null) {
      fleetHostPort = existing;   // compose already publishes it; keep that mapping
    } else {
      const used = portsClaimedByOthers();
      if (hostPort !== undefined) used.add(hostPort);
      const prevFleetPort = instance.fleetHostPort;
      const allocated = allocateHostPort({
        botId: instance.id,
        reuse: typeof prevFleetPort === 'number' ? prevFleetPort : undefined,
        used,
        hostBound: portsBoundOnHost(),
      });
      if (allocated !== null) {
        fleetHostPort = allocated;
        content = publishFleetHostPort(content, allocated, controlPort);
      }
    }
    const existingTransfer = getPublishedFleetHostPort(content, transferPort);
    if (existingTransfer !== null) {
      transferHostPort = existingTransfer;
    } else {
      const used = portsClaimedByOthers();
      if (hostPort !== undefined) used.add(hostPort);
      if (fleetHostPort !== undefined) used.add(fleetHostPort);
      const prevTransferPort = instance.transferHostPort;
      const allocated = allocateHostPort({
        botId: instance.id,
        reuse: typeof prevTransferPort === 'number' ? prevTransferPort : undefined,
        used,
        hostBound: portsBoundOnHost(),
      });
      if (allocated !== null) {
        transferHostPort = allocated;
        content = publishFleetHostPort(content, allocated, transferPort);
      }
    }
  }

  updateInstanceWebAccess(instance.id, hostPort, info ? info.containerPort : undefined, publicUrl, webUiPath, fleetHostPort, transferHostPort);
  return content;
}

/**
 * Write a .env next to the bot's compose so `${VAR}` interpolation and `env_file:`
 * services resolve in docker mode. Mirrors writeComposeEnvFile but uses plain fs
 * (no /DATA, no docker-exec-into-casaos).
 */
function writeDockerEnvFile(botDir: string, env: Record<string, string>): void {
  try {
    const lines = Object.entries(env)
      .filter(([k]) => k)
      .map(([k, v]) => {
        const s = (v == null ? '' : String(v)).replace(/[\r\n]+/g, ' ');
        const needsQuote = s === '' || /[\s#"'$=]/.test(s);
        const val = needsQuote ? '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"' : s;
        return `${k}=${val}`;
      });
    fs.writeFileSync(path.join(botDir, '.env'), lines.join('\n') + '\n');
  } catch (err) {
    console.warn(`[ContainerManager] Failed to write .env file: ${err}`);
  }
}

function updateInstanceDetection(botId: string, detection: DetectionResult): void {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (instance) {
    instance.botType = detection.type;
    instance.hasDatabase = detection.hasDatabase;
    instance.databases = detection.databases;
    instance.needsLavalink = detection.needsLavalink;
    instance.hasWebDashboard = detection.hasWebDashboard;
    instance.tokenVarName = detection.tokenVarDetected ? detection.tokenVarName : undefined;
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
function writeBotManagerMarker(instance: InstanceConfig, appName: string, isCasaOS: boolean): void {
  // CasaOS: marker lives in the platform AppData folder (folder-reuse detection).
  // Docker: no /DATA; keep the marker inside the bot's own data dir.
  const appDataPath = isCasaOS
    ? path.join(process.env.DATA_ROOT || '/DATA', 'AppData', appName)
    : getBotDir(instance.id);

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
 * The bot's effective env: user-configured vars plus the manager-injected
 * wiring. Used both for per-service compose injection and the deployed .env file.
 */
function buildEffectiveEnv(instance: InstanceConfig): Record<string, string> {
  const internalUrl = process.env.BOT_MANAGER_INTERNAL_URL || `http://discordbotmanagerapp:${process.env.PORT || '8080'}`;
  return {
    ...instance.envVars,
    ...fleetEnv(instance),
    BOT_MANAGER_UPDATE_TOKEN: instance.updateToken || '',
    BOT_ID: instance.id,
    BOT_MANAGER_INTERNAL_URL: internalUrl,
  };
}

/**
 * Fleet wiring derived from the deployed compose's marker label: CONTROL_PORT
 * whenever the marker is present; FLEET_PUBLIC_URL only for a master with a
 * public base; TRANSFER_URL for every fleet node (public wss route when a base
 * exists, else the app container name over the shared network - transfer port
 * is CONTROL_PORT + 1, the bot's default). Re-derived from the compose so
 * start-time env syncs agree with what the build exposed.
 */
function fleetEnv(instance: InstanceConfig): Record<string, string> {
  try {
    const composePath = path.join(getBotDir(instance.id), 'docker-compose.yml');
    if (!fs.existsSync(composePath)) return {};
    const composeContent = fs.readFileSync(composePath, 'utf-8');
    const controlPort = getFleetControlPort(composeContent);
    if (controlPort === null) return {};
    const env: Record<string, string> = { CONTROL_PORT: String(controlPort), TRANSFER_PORT: String(controlPort + 1) };
    const host = fleetPublicHost(instance.sanitizedName);
    // Advertise the control route only once the built compose actually
    // serves it (same rule as TRANSFER_URL below): a pre-standby worker
    // build restarted after a manager update must not advertise a route no
    // proxy label backs until its rebuild.
    if (host && composeContent.includes(host)) env.FLEET_PUBLIC_URL = `wss://${host}`;
    const transferHost = transferPublicHost(instance.sanitizedName);
    if (transferHost) {
      // Advertise the public route only once the built compose actually
      // serves it: a pre-transfer build restarted after a manager update
      // must not advertise a route no proxy label backs until its rebuild.
      if (composeContent.includes(transferHost)) env.TRANSFER_URL = `wss://${transferHost}`;
    } else if (fleetIsSameBox(instance.envVars)) {
      const cname = fleetAppContainerName(composeContent);
      if (cname) env.TRANSFER_URL = `ws://${cname}:${controlPort + 1}`;
    }
    // Local standby hand-off (PLAN_REPLICATION.md Stage 3 consumes it): the
    // bot's promote flow promotes this database first. Credentials are the
    // fleet's own (same database, byte-copied auth); the bot splices them in.
    if (instance.fleetDbReplica) {
      const replica = instance.fleetDbReplica;
      // no-verify: the byte-copied PGDATA carries the primary's authored
      // pg_hba (non-TLS only from 172.16/12) and ssl=on, so TLS keeps this
      // dialable from any docker subnet (custom address pools included).
      env.FLEET_DB_REPLICA_URL = `postgresql://${replica.containerName}:5432/smdb?sslmode=no-verify`;
      // What the FLEET dials once this pair is promoted: the same canonical
      // shape the primary publishes, so cross-host workers keep working and
      // the container-name URL above never escapes this machine.
      env.FLEET_DB_REPLICA_PUBLIC_URL = `postgresql://${replica.publicHost}:${replica.hostPort}/smdb?sslmode=no-verify`;
    }
    return env;
  } catch {
    return {};
  }
}

// Env vars that are inputs to compose $-substitution (e.g. the AppShield gateway
// login) rather than configuration for the bot's app container. They feed the
// gateway via $WEBUI_USER/$WEBUI_PASSWORD and must never reach a container as
// literal app env.
const SUBSTITUTION_ONLY_ENV = ['WEBUI_USER', 'WEBUI_PASSWORD'];

/** Update an existing env KEY's value in a compose service (array or object form); no-op if absent. */
function setComposeEnvIfPresent(env: any, key: string, value: string): void {
  if (Array.isArray(env)) {
    for (let i = 0; i < env.length; i++) {
      if (typeof env[i] === 'string' && env[i].split('=')[0] === key) env[i] = `${key}=${value}`;
    }
  } else if (env && typeof env === 'object' && Object.prototype.hasOwnProperty.call(env, key)) {
    env[key] = value;
  }
}

/** Remove an env KEY from a compose service (array or object form). */
function deleteComposeEnv(env: any, key: string): void {
  if (Array.isArray(env)) {
    for (let i = env.length - 1; i >= 0; i--) {
      if (typeof env[i] === 'string' && env[i].split('=')[0] === key) env.splice(i, 1);
    }
  } else if (env && typeof env === 'object') {
    delete env[key];
  }
}

/**
 * Sync current instance env vars into the on-disk compose file before start, so
 * edits made while the bot was stopped take effect without a rebuild. The app
 * service gets the bot's env; any service that already declares USER/PASSWORD (the
 * AppShield gateway) has them refreshed from the current WEBUI_USER/WEBUI_PASSWORD.
 */
function syncComposeEnvVars(instance: InstanceConfig, composePath: string): void {
  if (!fs.existsSync(composePath)) return;

  try {
    const raw = fs.readFileSync(composePath, 'utf-8');
    const doc = YAML.parseDocument(raw);
    const compose = doc.toJSON();

    const services = compose?.services;
    if (!services || typeof services !== 'object') return;

    // App service (x-casaos.build, else first non-infra) gets the bot's env, MINUS
    // substitution-only inputs - a repo compose whose first service is a database
    // does not receive the bot's env.
    const targetName = getAppServiceName(compose);
    if (targetName && services[targetName]) {
      const allEnv = buildEffectiveEnv(instance);
      for (const k of SUBSTITUTION_ONLY_ENV) delete allEnv[k];

      const service = services[targetName];
      const env = service.environment;

      if (Array.isArray(env)) {
        const existingKeys = new Set(Object.keys(allEnv));
        const filtered = env.filter((e: string) => {
          const key = typeof e === 'string' ? e.split('=')[0] : '';
          return !existingKeys.has(key);
        });
        for (const [key, value] of Object.entries(allEnv)) filtered.push(`${key}=${value}`);
        service.environment = filtered;
      } else if (typeof env === 'object' && env !== null) {
        Object.assign(env, allEnv);
      } else {
        service.environment = { ...allEnv };
      }
      // Role or public base may have changed since build: a FLEET_PUBLIC_URL or
      // TRANSFER_URL the build injected must not survive when no longer derivable.
      // TRANSFER_URL is a generic enough name that a non-fleet bot's compose may
      // legitimately ship one, so its cleanup is gated on the fleet marker.
      if (!('FLEET_PUBLIC_URL' in allEnv)) deleteComposeEnv(service.environment, 'FLEET_PUBLIC_URL');
      if (!('TRANSFER_URL' in allEnv) && getFleetControlPort(raw) !== null) deleteComposeEnv(service.environment, 'TRANSFER_URL');
      // Retired designation/dial keys: the role-authoritative save drops them
      // from the registry, and a stale compose copy would keep a node silently
      // designated or dialing a legacy URL through every restart.
      if (getFleetControlPort(raw) !== null) {
        for (const key of ['FLEET_BACKUP_MASTER', 'MASTER_URL', 'FLEET_DB_REPLICA_URL', 'FLEET_DB_REPLICA_PUBLIC_URL']) {
          if (!(key in allEnv)) deleteComposeEnv(service.environment, key);
        }
      }
      compose.services[targetName] = service;
    }

    // AppShield gateway login: refresh any service's EXISTING USER/PASSWORD from the
    // current credentials (so a change while stopped applies on start), and strip the
    // substitution-only inputs from every service. Structural - keyed on the env that
    // exists, never on a bot/image name. Blank credentials leave the compose's shipped
    // login untouched: blanking USER/PASSWORD would disable the gateway's auth.
    const webUser = instance.envVars?.['WEBUI_USER'] || '';
    const webPass = instance.envVars?.['WEBUI_PASSWORD'] || '';
    for (const svc of Object.values(services) as any[]) {
      if (!svc || !svc.environment) continue;
      if (webUser) setComposeEnvIfPresent(svc.environment, 'USER', webUser);
      if (webPass) setComposeEnvIfPresent(svc.environment, 'PASSWORD', webPass);
      for (const k of SUBSTITUTION_ONLY_ENV) deleteComposeEnv(svc.environment, k);
    }

    // Replication toggles between starts must not require a rebuild: keep the
    // sidecar's published port in step with the record on every start.
    // Keyed on the container the record names, not the service key: an adopted
    // standby keeps the replica service name until its next rebuild, and its
    // published port must keep tracking the record meanwhile.
    const dbSvc = instance.fleetDb
      ? (Object.values(services) as any[]).find(svc =>
        svc && typeof svc === 'object' && svc.container_name === instance.fleetDb!.containerName)
      : undefined;
    if (dbSvc && typeof dbSvc === 'object') {
      const repl = instance.fleetDb?.replication;
      const ports = Array.isArray(dbSvc.ports) ? dbSvc.ports.filter((p: unknown) =>
        !(typeof p === 'string' && p.endsWith(':5432'))) : [];
      if (repl) ports.push(`${repl.hostPort}:5432`);
      if (ports.length > 0) dbSvc.ports = ports;
      else delete dbSvc.ports;
    }
    const replicaSvc = services['fleet-postgres-replica'];
    if (replicaSvc && typeof replicaSvc === 'object' && instance.fleetDbReplica) {
      replicaSvc.ports = [`${instance.fleetDbReplica.hostPort}:5432`];
    }

    fs.writeFileSync(composePath, YAML.stringify(compose, { lineWidth: 0 }));
  } catch (err) {
    console.warn(`[ContainerManager] Failed to sync env vars into compose: ${err}`);
  }
}

// ─── Start ───

/**
 * True when the instance's APP service container is running. Sidecars (redis,
 * a fronting gateway) outlive a killed app container, so a project-wide check
 * would refuse Start in exactly the crashed case this reconcile exists for.
 * Falls back to any-project-container when the app service cannot be resolved.
 */
/**
 * Names of this instance's RUNNING compose containers other than the fleet
 * sidecar. The recovery swap's quiesce (RC-4) works from container truth,
 * not the registry status: the end-of-WAL it captures is only a fence if
 * nothing can write to the database anymore. Null = docker query failed,
 * so the caller must refuse rather than assume quiet.
 */
export async function runningNonSidecarContainers(botId: string): Promise<string[] | null> {
  const appName = resolveAppName(botId);
  // Exclusion by the record's exact container name, not by service key: an
  // adopted standby's database keeps service 'fleet-postgres-replica' until
  // its next rebuild, and misclassifying it as a leftover would stop it.
  const sidecarName = getBot(botId)?.fleetDb?.containerName;
  if (!sidecarName) return null;
  try {
    const { stdout } = await execAsync(
      `docker ps --filter "label=com.docker.compose.project=${appName}" --format "{{.Names}}"`);
    return stdout.split('\n').map(s => s.trim()).filter(Boolean)
      .filter(name => name !== sidecarName);
  } catch {
    return null;
  }
}

async function hasRunningContainer(botId: string, appName: string): Promise<boolean> {
  let filters = `--filter "label=com.docker.compose.project=${appName}"`;
  try {
    const composePath = resolveComposePath(botId, appName);
    if (fs.existsSync(composePath)) {
      const compose = YAML.parseDocument(fs.readFileSync(composePath, 'utf-8')).toJSON();
      const appService = getAppServiceName(compose);
      if (appService) filters += ` --filter "label=com.docker.compose.service=${appService}"`;
    }
  } catch { /* fall back to the project-wide check */ }
  try {
    const { stdout } = await execAsync(`docker ps -q ${filters}`);
    return stdout.trim().length > 0;
  } catch {
    return true; // docker query failed: keep the conservative refusal
  }
}

export async function startBot(botId: string): Promise<{ success: boolean; error?: string }> {
  return withLoggedBotOp(botId, 'start', () => startBotImpl(botId));
}

async function startBotImpl(botId: string): Promise<{ success: boolean; error?: string }> {
  const instance = getBot(botId);
  if (!instance) return { success: false, error: 'Bot not found' };
  if (instance.recoveryRescue) {
    return { success: false, error: 'A database rescue is rewriting this instance\'s volume; cancel the rescue (or finish the swap) before starting it' };
  }
  if (instance.status === 'running') {
    // Reconcile against live container state: an externally-stopped bot
    // (docker kill, OOM) leaves the registry claiming running, and Start
    // would refuse forever while the container sits Exited.
    if (await hasRunningContainer(botId, instance.sanitizedName)) {
      return { success: false, error: 'Bot is already running' };
    }
    console.warn(`[ContainerManager] ${botId} marked running but no container is up; correcting to stopped`);
    updateBotStatus(botId, 'stopped');
  }

  const sourceType = instance.sourceType || 'git';
  if (sourceType === 'docker-image') {
    return startDockerImageBot(instance);
  }
  return startGitBot(instance);
}

async function startGitBot(instance: InstanceConfig): Promise<{ success: boolean; error?: string }> {
  const botId = instance.id;
  const log = logCollectors.get(botId);

  const emit: EmitFn = (msg, type = 'info', key) => {
    console.log(`[Start ${botId}] ${msg}`);
    log.addLog(msg, type, key);
  };

  try {
    emit(`[Start] Starting ${instance.displayName}...`, 'system');

    const latestInstance = getBot(botId) || instance;
    const botDir = getBotDir(botId);
    const localComposePath = path.join(botDir, 'docker-compose.yml');

    // Build if compose doesn't exist
    if (!fs.existsSync(localComposePath)) {
      emit('[Build] No compose file found, running build first...', 'info');
      const buildResult = await buildBotImpl(botId);
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
      await writeComposeEnvFile(appName, buildEffectiveEnv(latestInstance), (msg) => emit(msg, 'info'));

      // Re-apply edited config files so config changes made while stopped take
      // effect on start (mirrors the env re-sync above). Binds already exist from
      // the build, so this only rewrites the bind-mounted host files.
      const cfgFiles = configFileManager.getConfigFiles(botId).filter(c => c.enabled !== false);
      if (cfgFiles.length > 0) {
        try {
          emit(`[Config] Re-applying ${cfgFiles.length} config file(s)`, 'info');
          const composeForCfg = fs.readFileSync(composePath, 'utf-8');
          await redeliverConfigFiles(composeForCfg, appName, cfgFiles, (msg) => emit(msg, 'info'));
        } catch (err) {
          emit(`[Config] Warning: could not re-apply config files: ${err}`, 'warning');
        }
      }

      emit(`[Start] Starting containers (${appName})...`, 'info');
      updateBotStatus(botId, 'starting');

      const deployResult = await casaosApi.deployApp(appName, composePath, (msg, key) => {
        emit(`[Compose] ${msg}`, 'info', key);
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
      const composePath = path.join(botDir, 'docker-compose.yml');

      // Sync env into the compose (covers post-build env edits) + a .env file for
      // ${VAR} / env_file services, then deploy the full compose (multi-service).
      syncComposeEnvVars(latestInstance, composePath);
      writeDockerEnvFile(botDir, buildEffectiveEnv(latestInstance));

      // Re-apply edited config files so changes made while stopped take effect.
      const cfgFiles = configFileManager.getConfigFiles(botId).filter(c => c.enabled !== false);
      if (cfgFiles.length > 0 && fs.existsSync(composePath)) {
        try {
          redeliverDockerConfigFiles(fs.readFileSync(composePath, 'utf-8'), botDir, hostBotDirFor(botId), cfgFiles);
        } catch (err) {
          emit(`[Config] Warning: could not re-apply config files: ${err}`, 'warning');
        }
      }

      // Re-assert ownership of manager-delivered files (written root) to the bot's
      // PUID:GID before the container starts; mirrors casaos fixPostDeployOwnership.
      fixDockerBotOwnership(botDir, (msg) => emit(msg, 'info'));

      emit(`[Start] Starting containers (${appName})...`, 'info');
      updateBotStatus(botId, 'starting');

      await dockerClient.composeUp(composePath, appName, (msg, key) => emit(`[Compose] ${msg}`, 'info', key));
      const verify = await dockerClient.verifyComposeProjectRunning(appName, 15000);
      if (!verify.allRunning) {
        throw new Error(`Containers did not reach running state: ${verify.problems.join('; ')}`);
      }

      const containerIds = await getContainerIdsForBot(botId);
      updateBotStatus(botId, 'running', containerIds);
      emit(`[Done] Bot deployed (${containerIds.length} containers)`, 'success');
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
  const log = logCollectors.get(botId);

  const emit: EmitFn = (msg, type = 'info', key) => {
    console.log(`[Start ${botId}] ${msg}`);
    log.addLog(msg, type, key);
  };

  if (!instance.imageRef) {
    return { success: false, error: 'imageRef is required for docker-image source type' };
  }

  try {
    emit(`[Start] Starting ${instance.displayName}...`, 'system');
    const botDir = getBotDir(botId);
    const localComposePath = path.join(botDir, 'docker-compose.yml');

    if (!fs.existsSync(localComposePath)) {
      emit('[Build] No compose file found, running build first...', 'info');
      const buildResult = await buildBotImpl(botId);
      if (!buildResult.success) {
        return { success: false, error: `Build failed: ${buildResult.error || 'unknown error'}` };
      }
    }

    const appName = resolveAppName(botId);
    const deploymentMode = await getDeploymentMode();

    if (deploymentMode === 'casaos') {
      const composePath = resolveComposePath(botId, appName);
      emit(`[Start] Starting containers (${appName})...`, 'info');
      updateBotStatus(botId, 'starting');

      // Re-apply edited config files so config changes take effect on start.
      const cfgFiles = configFileManager.getConfigFiles(botId).filter(c => c.enabled !== false);
      if (cfgFiles.length > 0) {
        try {
          emit(`[Config] Re-applying ${cfgFiles.length} config file(s)`, 'info');
          const composeForCfg = fs.readFileSync(composePath, 'utf-8');
          await redeliverConfigFiles(composeForCfg, appName, cfgFiles, (msg) => emit(msg, 'info'));
        } catch (err) {
          emit(`[Config] Warning: could not re-apply config files: ${err}`, 'warning');
        }
      }

      const deployResult = await casaosApi.deployApp(appName, composePath, (msg, key) => {
        emit(`[Compose] ${msg}`, 'info', key);
      });
      if (!deployResult.success) {
        throw new Error(`Failed to deploy via docker compose: ${deployResult.error || 'unknown error'}`);
      }

      await new Promise(resolve => setTimeout(resolve, 3000));
      emit('[PCS] Fixing post-deploy ownership...', 'info');
      await fixPostDeployOwnership(appName, (msg) => emit(msg, 'info'));

      const containerIds = await getContainerIdsForBot(botId);
      updateBotStatus(botId, 'running', containerIds);
      emit(`[Done] Bot deployed (${containerIds.length} containers)`, 'success');
    } else {
      const composePath = path.join(botDir, 'docker-compose.yml');
      syncComposeEnvVars(instance, composePath);
      writeDockerEnvFile(botDir, buildEffectiveEnv(instance));

      const cfgFiles = configFileManager.getConfigFiles(botId).filter(c => c.enabled !== false);
      if (cfgFiles.length > 0 && fs.existsSync(composePath)) {
        try {
          emit(`[Config] Re-applying ${cfgFiles.length} config file(s)`, 'info');
          redeliverDockerConfigFiles(fs.readFileSync(composePath, 'utf-8'), botDir, hostBotDirFor(botId), cfgFiles);
        } catch (err) {
          emit(`[Config] Warning: could not re-apply config files: ${err}`, 'warning');
        }
      }

      // Re-assert ownership of manager-delivered files (written root) to the bot's
      // PUID:GID before the container starts; mirrors casaos fixPostDeployOwnership.
      fixDockerBotOwnership(botDir, (msg) => emit(msg, 'info'));
      emit(`[Start] Starting containers (${appName})...`, 'info');
      updateBotStatus(botId, 'starting');
      await dockerClient.composeUp(composePath, appName, (msg, key) => emit(`[Compose] ${msg}`, 'info', key));
      const verify = await dockerClient.verifyComposeProjectRunning(appName, 15000);
      if (!verify.allRunning) {
        throw new Error(`Containers did not reach running state: ${verify.problems.join('; ')}`);
      }
      const containerIds = await getContainerIdsForBot(botId);
      updateBotStatus(botId, 'running', containerIds);
      emit(`[Done] Bot deployed (${containerIds.length} containers)`, 'success');
    }

    emit(`[Success] ${instance.displayName} is now running!`, 'success');
    return { success: true };
  } catch (error) {
    const msg = String(error);
    emit(`[Error] Start failed: ${msg}`, 'error');
    emit('[Fatal] Start process terminated with error', 'error');
    console.error(`[ContainerManager] Failed to start docker-image instance ${botId}:`, error);
    updateBotStatus(botId, 'error');
    return { success: false, error: msg };
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
  return withBotOp(botId, 'stop', () => stopBotImpl(botId));
}

async function stopBotImpl(botId: string, emit?: EmitFn): Promise<{ success: boolean; error?: string }> {
  const instance = getBot(botId);
  if (!instance) return { success: false, error: 'Bot not found' };
  if (instance.status !== 'running') return { success: false, error: 'Bot is not running' };

  try {
    updateBotStatus(botId, 'stopping');

    const deploymentMode = await getDeploymentMode();
    const appName = resolveAppName(botId);
    emit?.(`[Stop] Stopping containers (${appName})...`, 'info');

    if (deploymentMode === 'casaos') {
      const composePath = resolveComposePath(botId, appName);
      const downResult = await casaosApi.composeDown(
        appName,
        composePath,
        emit ? (msg, key) => emit(`[Compose] ${msg}`, 'info', key) : undefined
      );
      if (!downResult.success) {
        console.warn(`[ContainerManager] Compose down failed for ${appName}: ${downResult.error}`);
        emit?.(`[Stop] Warning: compose down failed: ${downResult.error}`, 'warning');
      }
    } else {
      const composePath = path.join(getBotDir(botId), 'docker-compose.yml');
      if (fs.existsSync(composePath)) {
        try {
          await dockerClient.composeDown(composePath, appName);
        } catch (err) {
          console.warn(`[ContainerManager] compose down failed for ${appName}:`, err);
          emit?.(`[Stop] Warning: compose down failed: ${err}`, 'warning');
        }
      } else {
        // Fallback: stop tracked containers if the compose file is gone.
        for (const containerId of instance.containerIds || []) {
          try {
            await dockerClient.stopContainer(containerId);
            await dockerClient.removeContainer(containerId);
          } catch (err) {
            console.warn(`[ContainerManager] Failed to stop container ${containerId}:`, err);
          }
        }
      }
    }

    updateBotStatus(botId, 'stopped', []);
    emit?.('[Stop] Containers stopped', 'info');
    return { success: true };
  } catch (error) {
    console.error(`[ContainerManager] Failed to stop instance ${botId}:`, error);
    updateBotStatus(botId, 'error');
    return { success: false, error: String(error) };
  }
}

// ─── Restart ───

export async function restartBot(botId: string): Promise<{ success: boolean; error?: string }> {
  return withLoggedBotOp(botId, 'restart', async () => {
    const log = logCollectors.get(botId);
    const emit: EmitFn = (msg, type = 'info', key) => {
      console.log(`[Restart ${botId}] ${msg}`);
      log.addLog(msg, type, key);
    };
    const stopResult = await stopBotImpl(botId, emit);
    if (!stopResult.success && stopResult.error !== 'Bot is not running') {
      return stopResult;
    }
    return startBotImpl(botId);
  });
}

// ─── Pull & Rebuild (Instance Update) ───

export async function pullAndRebuild(botId: string): Promise<{ success: boolean; error?: string }> {
  return withLoggedBotOp(botId, 'update', () => pullAndRebuildImpl(botId));
}

async function pullAndRebuildImpl(botId: string): Promise<{ success: boolean; error?: string }> {
  const instance = getBot(botId);
  if (!instance) return { success: false, error: 'Bot not found' };

  const wasRunning = instance.status === 'running';
  const log = logCollectors.get(botId);
  const emit: EmitFn = (msg, type = 'info', key) => {
    console.log(`[Update ${botId}] ${msg}`);
    log.addLog(msg, type, key);
  };

  try {
    emit(`[Update] Updating ${instance.displayName}...`, 'system');
    if (wasRunning) {
      await stopBotImpl(botId, emit);
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
    if (await dockerClient.imageExists(imageName)) {
      emit('[Update] Removing old image...', 'info');
      await dockerClient.removeImage(imageName);
    }

    // Rebuild
    const buildResult = await buildBotImpl(botId);
    if (!buildResult.success) {
      return { success: false, error: `Rebuild failed: ${buildResult.error || 'unknown error'}` };
    }

    if (wasRunning) {
      return startBotImpl(botId);
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

/**
 * In-container data path for a docker-image bot: a curated hint wins; else the
 * image's single declared VOLUME (Config.Volumes); else the /app/data default.
 * Curated hints work without the image present; inspection needs it pulled.
 */
function resolveImageDataTarget(imageRef: string): string {
  const curated = findImageDataPath(imageRef);
  if (curated) return curated;
  const vols = dockerClient.inspectImageVolumes(imageRef);
  if (vols && vols.length === 1) return vols[0];
  return '/app/data';
}

export async function buildBot(botId: string): Promise<{ success: boolean; error?: string }> {
  return withLoggedBotOp(botId, 'build', () => buildBotImpl(botId));
}

async function buildBotImpl(botId: string): Promise<{ success: boolean; error?: string }> {
  const instance = getBot(botId);
  if (!instance) return { success: false, error: 'Bot not found' };

  const sourceType = instance.sourceType || 'git';
  const log = logCollectors.get(botId);

  const emit: EmitFn = (msg, type = 'info', key) => {
    console.log(`[Build ${botId}] ${msg}`);
    log.addLog(msg, type, key);
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
  emit: EmitFn,
  isCasaOS: boolean,
): Promise<{ success: boolean; error?: string }> {
  const botId = instance.id;

  if (!instance.imageRef) {
    emit('[Error] imageRef is required for docker-image source type', 'error');
    updateBotStatus(botId, 'stopped');
    return { success: false, error: 'imageRef is required' };
  }

  emit(`[Pull] Pulling image ${instance.imageRef}...`, 'info');
  await dockerClient.pullImage(instance.imageRef, (msg, key) => emit(`[Docker] ${msg}`, 'info', key));

  emit('[Info] Generating compose file...', 'info');
  const botDir = getBotDir(botId);
  const dataPath = getDataPath(botId);
  fs.mkdirSync(botDir, { recursive: true });
  fs.mkdirSync(dataPath, { recursive: true });

  const internalUrl = process.env.BOT_MANAGER_INTERNAL_URL || `http://discordbotmanagerapp:${process.env.PORT || '8080'}`;
  const envWithToken = { ...instance.envVars, BOT_MANAGER_UPDATE_TOKEN: instance.updateToken || '', BOT_ID: instance.id, BOT_MANAGER_INTERNAL_URL: internalUrl };

  // Use displayName for the compose bot config (BotConfig compat)
  const botForCompose: any = { ...instance, envVars: envWithToken };
  const dataTarget = resolveImageDataTarget(instance.imageRef);
  let composeContent = generateImageCompose(botForCompose, botDir, dataTarget);
  const appName = instance.sanitizedName;
  const processed = processComposeForCasaOS(composeContent, appName, botForCompose, { mode: isCasaOS ? 'casaos' : 'docker', hostBotDir: isCasaOS ? undefined : hostBotDirFor(botId) });
  composeContent = processed.content;

  // Config files: deliver/bind user-supplied config files (mode-aware).
  const configFiles = configFileManager.getConfigFiles(botId).filter(c => c.enabled !== false);
  if (isCasaOS) {
    if (configFiles.length > 0) {
      emit(`[Config] Delivering ${configFiles.length} config file(s)`, 'info');
      composeContent = addConfigFileBinds(composeContent, appName, configFiles);
    }
  } else {
    // Docker mode: align the ./data bind + deliver/bind config files locally.
    composeContent = prepareDockerBotFiles(composeContent, getBotDir(botId), hostBotDirFor(botId), null, configFiles, (msg) => emit(msg, 'info'));
  }

  // Docker mode: publish the bot's web UI on a host port (no gateway).
  if (!isCasaOS) composeContent = applyDockerHostPort(composeContent, instance);

  // Same rule as the git lanes: a rebuilt compose missing the standby service
  // would destroy the replica on the next up --remove-orphans.
  if (instance.fleetDbReplica) {
    composeContent = addFleetPostgresReplicaService(composeContent, botForCompose, instance.fleetDbReplica, { mode: isCasaOS ? 'casaos' : 'docker' });
    emit(`[Fleet] Managed Postgres standby attached (${instance.fleetDbReplica.containerName})`, 'info');
  }

  writeComposeFile(botDir, composeContent);
  emit('[Done] Compose file written', 'success');

  // Write .botmanager marker (CasaOS AppData folder, or the bot dir in docker mode)
  writeBotManagerMarker(instance, appName, isCasaOS);

  if (isCasaOS) {
    emit('[PCS] Saving CasaOS metadata...', 'info');
    await saveToCasaOSMetadata(appName, composeContent, (msg) => emit(msg, 'info'));
    if (processed.sidecarInjected) {
      emit('[PCS] Writing status page...', 'info');
      await writeStatusPage(appName, generateStatusPageHtml(instance), (msg) => emit(msg, 'info'));
    }
    if (configFiles.length > 0) {
      emit('[PCS] Writing config files...', 'info');
      await writeConfigFiles(appName, configFiles, (msg) => emit(msg, 'info'));
    }
  }

  updateBotStatus(botId, 'stopped');
  emit(`[Success] Build completed for ${instance.displayName}`, 'success');
  return { success: true };
}

// Safe defaults for build args a Dockerfile commonly declares WITHOUT a default
// and expects to be supplied externally (compose/build script). Only applied when
// the Dockerfile declares the bare `ARG NAME` (no `=default`) and the compose did
// not already provide it, so a real author default is never overridden.
const KNOWN_BUILD_ARG_DEFAULTS: Record<string, string> = {
  USER: 'node',
  UID: '1000',
  GID: '1000',
  PUID: '1000',
  PGID: '1000',
  NODE_VERSION: '20',
};

// When a repo ships its own Dockerfile, detection.type stays 'dockerfile'; the
// real language lives in packageManager. Used to generate a fallback Dockerfile
// if the repo's own Dockerfile fails to build.
function languageTypeFromDetection(detection: DetectionResult): DetectionResult['type'] {
  switch (detection.packageManager) {
    case 'npm': case 'yarn': case 'pnpm': case 'bun': return 'nodejs';
    case 'pip': case 'poetry': case 'uv': case 'pipenv': case 'setuptools': return 'python';
    case 'go': return 'go';
    case 'cargo': return 'rust';
    case 'maven': case 'gradle': return 'java';
    case 'dotnet': return 'csharp';
    default: return 'unknown';
  }
}

function fillKnownDockerfileArgs(dockerfilePath: string, provided: Record<string, string>): Record<string, string> {
  let text: string;
  try {
    text = fs.readFileSync(dockerfilePath, 'utf-8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  const re = /^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/gm;   // bare `ARG NAME`, no '='
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    if (name in provided || name in out) continue;
    const def = KNOWN_BUILD_ARG_DEFAULTS[name.toUpperCase()];
    if (def !== undefined) out[name] = def;
  }
  return out;
}

/**
 * Managed fleet data backend (Postgres sidecar). Structural trigger, no bot
 * names: the source compose declares the fleet marker AND the stored env has
 * DATA_BACKEND=postgres. A blank DATA_BACKEND_URL is the managed lane: the
 * first match generates the credentials, writes the URL into the encrypted env
 * store and stamps instance.fleetDb; redeploys reuse the stored URL + record
 * verbatim (never regenerated). A URL pointing anywhere else is the external
 * lane (no sidecar). Flipping back to DATA_BACKEND=file stops the injection but
 * KEEPS the volume and the record (data retention). Returns what the compose
 * injection needs, or null when no sidecar applies.
 */
function ensureFleetDataBackend(instance: InstanceConfig): { containerName: string; volume: string; password: string } | null {
  const repoPath = instance.sourceId ? sourceManager.getSourceRepoPath(instance.sourceId) : null;
  if (!composeDeclaresFleet(repoPath)) return null;

  // Env store first (the wizard writes through it); registry mirror as fallback.
  const stored = { ...instance.envVars, ...envManager.getEnvVars(instance.id) };
  if ((stored['DATA_BACKEND'] || '').trim().toLowerCase() !== 'postgres') return null;

  const containerName = instance.fleetDb?.containerName || `${instance.sanitizedName}-fleet-postgres`;
  const volume = instance.fleetDb?.volume || `${instance.sanitizedName}-fleet-postgres-data`;
  const url = (stored['DATA_BACKEND_URL'] || '').trim();

  if (url === '') {
    const password = crypto.randomBytes(24).toString('base64url');
    const newUrl = `postgresql://smdb:${password}@${containerName}:5432/smdb`;
    envManager.setEnvVars(instance.id, { DATA_BACKEND_URL: newUrl });
    stampFleetDb(instance, { containerName, user: 'smdb', db: 'smdb', volume }, newUrl);
    return { containerName, volume, password };
  }

  let host: string;
  let password: string;
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    password = decodeURIComponent(parsed.password);
  } catch {
    return null;
  }
  // Managed = the sidecar's container name, OR the replication posture's public
  // host (the canonical URL rewrite points at the same sidecar through the
  // published port; treating it as external would drop the database service
  // from the next rebuild's compose).
  const replicationHost = instance.fleetDb?.replication?.publicHost;
  if (host !== containerName && !(replicationHost && host === replicationHost)) return null;   // external lane

  if (!instance.fleetDb) stampFleetDb(instance, { containerName, user: 'smdb', db: 'smdb', volume });
  if ((instance.envVars?.['DATA_BACKEND_URL'] || '') !== url) {
    instance.envVars = { ...instance.envVars, DATA_BACKEND_URL: url };
  }
  return { containerName, volume, password };
}

/** Persist the fleetDb record (and the generated URL) on the instance, in-memory and in the registry. */
function stampFleetDb(instance: InstanceConfig, record: FleetDbRecord, envUrl?: string): void {
  const registry = loadRegistry();
  const inst = registry.instances[instance.id];
  if (inst) {
    inst.fleetDb = record;
    if (envUrl !== undefined) inst.envVars = { ...inst.envVars, DATA_BACKEND_URL: envUrl };
    inst.updatedAt = new Date().toISOString();
    saveRegistry(registry);
  }
  instance.fleetDb = record;
  if (envUrl !== undefined) instance.envVars = { ...instance.envVars, DATA_BACKEND_URL: envUrl };
}

async function buildGitInstance(
  instance: InstanceConfig,
  emit: EmitFn,
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
  emit(`[Info] Detected: ${detection.type} bot (compose: ${detection.hasCompose}, databases: [${detection.databases.join(', ')}], music: ${detection.hasMusic}, lavalink: ${detection.needsLavalink}, web: ${detection.hasWebDashboard})`, 'info');
  updateInstanceDetection(botId, detection);

  // Before env assembly so a freshly provisioned DATA_BACKEND_URL rides this deploy.
  const fleetDb = ensureFleetDataBackend(instance);

  const internalUrl = process.env.BOT_MANAGER_INTERNAL_URL || `http://discordbotmanagerapp:${process.env.PORT || '8080'}`;
  const envWithToken = { ...instance.envVars, BOT_MANAGER_UPDATE_TOKEN: instance.updateToken || '', BOT_ID: instance.id, BOT_MANAGER_INTERNAL_URL: internalUrl };
  const botWithEnv: any = { ...instance, envVars: envWithToken };

  const existingComposePath = hasExistingCompose(repoPath);
  let composeContent: string;
  let appName: string;
  let buildTarget: string | null = null;
  let sidecarInjected = false;
  let composeBuildArgs: Record<string, string> = {};
  let usedGeneratedDockerfile = false;

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
      // Substitution renamed the build-target service (its key and x-casaos.build),
      // so re-derive buildTarget from the substituted compose. Otherwise the image
      // swap below matches the old service name, no-ops, and the container keeps the
      // source's original (unbuilt) image - which is exactly how a 2nd instance ended
      // up running the upstream GHCR image instead of its freshly built one.
      if (buildTarget) {
        buildTarget = extractBuildTarget(rawCompose) || buildTarget;
      }
    }

    // Apply variable substitution
    rawCompose = applyVariableSubstitution(rawCompose, botWithEnv);

    // Apply deployment processing (mode-aware: casaos vs plain docker)
    {
      const processed = processComposeForCasaOS(rawCompose, appName, botWithEnv, { mode: isCasaOS ? 'casaos' : 'docker', hostBotDir: isCasaOS ? undefined : hostBotDirFor(botId) });
      composeContent = processed.content;
      sidecarInjected = processed.sidecarInjected;
    }

    if (fleetDb) {
      composeContent = addFleetPostgresService(composeContent, botWithEnv, fleetDb, { mode: isCasaOS ? 'casaos' : 'docker' });
      emit(`[Fleet] Managed Postgres sidecar attached (${fleetDb.containerName})`, 'info');
    }

    emit(`[Info] App name: ${appName}`, 'info');

    if (buildTarget) {
      composeBuildArgs = extractComposeBuildArgs(rawCompose, buildTarget);
      if (Object.keys(composeBuildArgs).length > 0) {
        emit(`[Config] Relaying build args from compose: ${Object.keys(composeBuildArgs).join(', ')}`, 'info');
      }
      composeContent = replaceServiceImageWithBuild(composeContent, buildTarget, repoPath, imageName);
    }

    // Pre-build any service that builds from source, honoring the repo's own
    // build.context / build.dockerfile / build.args, then point each at the built
    // image. Deploy is `docker compose up` (no --build); relative contexts would
    // otherwise resolve against the metadata dir, not the repo, and fail.
    const buildSvcs = findBuildServices(composeContent, repoPath, buildTarget);
    if (buildSvcs.length > 0) {
      const imageMap: Record<string, string> = {};
      const stamp = new Date().toISOString();
      for (const bs of buildSvcs) {
        const safeSvc = bs.serviceName.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
        const tag = `${instance.sanitizedName}-${instance.id}-${safeSvc}:latest`;
        emit(`[Build] Building service '${bs.serviceName}' (dockerfile ${bs.dockerfile})...`, 'info');
        const svcArgs: Record<string, string> = {
          ...fillKnownDockerfileArgs(bs.dockerfile, bs.args),
          ...bs.args,
          BUILD_MODE: 'managed',
          BUILD_DATE: stamp,
        };
        await dockerClient.buildImage(bs.context, tag, (m, key) => emit(`[Docker] ${m}`, 'info', key), svcArgs, bs.dockerfile);
        imageMap[bs.serviceName] = tag;
      }
      composeContent = replaceBuildsWithImages(composeContent, imageMap);
      emit(`[Build] Pre-built ${buildSvcs.length} compose service image(s) from source`, 'success');
    }
  } else {
    emit(`[Info] No compose file found, generating for ${detection.type} bot`, 'info');

    if (!detection.hasDockerfile && detection.type !== 'compose') {
      emit(`[Config] Generating Dockerfile for ${detection.type} bot`, 'info');
      const dockerfile = generateDockerfile(detection);
      fs.writeFileSync(path.join(repoPath, 'Dockerfile'), dockerfile);
      usedGeneratedDockerfile = true;
    }

    composeContent = generateCompose(botWithEnv, detection, botDir, imageName);
    appName = instance.sanitizedName;
    {
      const processed = processComposeForCasaOS(composeContent, appName, botWithEnv, { mode: isCasaOS ? 'casaos' : 'docker', hostBotDir: isCasaOS ? undefined : hostBotDirFor(botId) });
      composeContent = processed.content;
      sidecarInjected = processed.sidecarInjected;
    }
    buildTarget = 'bot';
  }

  // Re-inject the standby on every rebuild, in EVERY compose lane: compose up
  // runs --remove-orphans, so a rebuilt compose missing this service would
  // destroy the replica.
  if (instance.fleetDbReplica) {
    composeContent = addFleetPostgresReplicaService(composeContent, botWithEnv, instance.fleetDbReplica, { mode: isCasaOS ? 'casaos' : 'docker' });
    emit(`[Fleet] Managed Postgres standby attached (${instance.fleetDbReplica.containerName})`, 'info');
  }

  // Deliver volume dirs + user-edited config files (mode-aware).
  const configFiles = configFileManager.getConfigFiles(botId).filter(c => c.enabled !== false);
  let bindOnlyConfigs: typeof configFiles = [];
  if (isCasaOS) {
    emit('[PCS] Creating volume directories...', 'info');
    await createVolumeDirectories(composeContent, appName, repoPath, (msg) => emit(msg, 'info'));
    // A config whose path matches a bind the compose already declares is delivered
    // over that existing bind (no second bind). The rest fall through to a fresh bind.
    const handled = await applyUserConfigOverrides(composeContent, appName, configFiles, (msg) => emit(msg, 'info'));
    bindOnlyConfigs = configFiles.filter(c => !handled.has(c.path));
    // Config files the compose does NOT already mount: bind them in. Injected AFTER
    // createVolumeDirectories so the file path is not created as a directory.
    if (bindOnlyConfigs.length > 0) {
      emit(`[Config] Delivering ${bindOnlyConfigs.length} config file(s)`, 'info');
      composeContent = addConfigFileBinds(composeContent, appName, bindOnlyConfigs);
    }
  } else if (repoPath || configFiles.length > 0) {
    // Docker mode: create bind dirs, deliver repo files, and deliver/bind config
    // files directly to the bot's local data dir (no /DATA, no casaos container).
    emit('[Docker] Preparing volumes and config files...', 'info');
    composeContent = prepareDockerBotFiles(composeContent, getBotDir(botId), hostBotDirFor(botId), repoPath, configFiles, (msg) => emit(msg, 'info'));
  }

  // Write .botmanager marker (CasaOS AppData folder, or the bot dir in docker mode)
  writeBotManagerMarker(instance, appName, isCasaOS);

  // CasaOS: execute pre-install command
  if (isCasaOS) {
    await executeInstallCommand('pre', composeContent, (msg) => emit(msg, 'info'));
  }

  // Docker mode: publish the bot's web UI on a host port (no gateway).
  if (!isCasaOS) composeContent = applyDockerHostPort(composeContent, instance);

  writeComposeFile(botDir, composeContent);
  emit('[Done] Compose file written', 'success');

  // Build Docker image BEFORE saving CasaOS metadata
  // (so a failed build doesn't leave a ghost app registered in CasaOS)
  // Commit/branch this image is built from, resolved once and shared by the
  // baked build badge (.build-meta.json) and the manager's own record so the
  // two never disagree (which is what produced a "· null" badge).
  let resolvedCommit: string | null = null;
  let resolvedBranch: string | null = null;
  if (buildTarget) {
    emit(`[Build] Building Docker image (${imageName})...`, 'info');

    // Build args: repo compose args (authoritative) + safe defaults for known
    // args the Dockerfile declares with NO default (so e.g. a parameterized
    // `COPY --chown=${USER}` does not fail with an empty USER). Our own
    // BUILD_MODE/BUILD_DATE always win.
    const dockerfileArgDefaults = fillKnownDockerfileArgs(path.join(repoPath, 'Dockerfile'), composeBuildArgs);
    const buildArgs: Record<string, string> = {
      ...dockerfileArgDefaults,
      ...composeBuildArgs,
      BUILD_MODE: 'managed',
      BUILD_DATE: new Date().toISOString()
    };
    const relayed = { ...dockerfileArgDefaults, ...composeBuildArgs };
    if (Object.keys(relayed).length > 0) {
      emit(`[Build] Build args: ${Object.entries(relayed).map(([k, v]) => `${k}=${v}`).join(' ')}`, 'info');
    }

    // Resolve commit/branch once. Order: the repo's actual HEAD (authoritative
    // after the fetch above), then the source registry, then the commit we last
    // recorded for this bot - so a transient fetch/clone gap bakes the previous
    // commit, never null.
    if (fs.existsSync(path.join(repoPath, '.git'))) {
      try {
        const simpleGit = require('simple-git').simpleGit;
        const git = simpleGit(repoPath);
        const log = await git.log({ maxCount: 1 });
        if (log.latest?.hash) resolvedCommit = log.latest.hash;
        const br = await git.revparse(['--abbrev-ref', 'HEAD']);
        resolvedBranch = (br || '').trim() || null;
      } catch {
        // fall through to the registry / prior-record fallbacks below
      }
    }
    if (instance.sourceId) {
      const source = sourceManager.getSource(instance.sourceId);
      if (!resolvedCommit) resolvedCommit = source?.lastCommitHash || null;
      if (!resolvedBranch) resolvedBranch = source?.branch || null;
    }
    if (!resolvedCommit) resolvedCommit = instance.lastBuiltCommit || null;
    try {
      fs.writeFileSync(
        path.join(repoPath, '.build-meta.json'),
        JSON.stringify({ commit: resolvedCommit, branch: resolvedBranch, builtAt: buildArgs.BUILD_DATE }, null, 2)
      );
    } catch (err: any) {
      emit(`[Build] Could not write .build-meta.json: ${err?.message || err}`, 'warning');
    }

    const onBuildLog: DockerLogFn = (msg, key) => emit(`[Docker] ${msg}`, 'info', key);
    try {
      await dockerClient.buildImage(repoPath, imageName, onBuildLog, buildArgs);
      emit('[Done] Docker image build completed', 'success');
    } catch (buildErr: any) {
      // Fallback: the repo's own Dockerfile failed (e.g. a broken multi-stage
      // ARG/ENV scope, or build steps the host can't satisfy). If we can generate
      // one for the detected language, retry with it rather than failing install.
      const lang = languageTypeFromDetection(detection);
      if (usedGeneratedDockerfile || lang === 'unknown') {
        throw buildErr;
      }
      emit(`[Build] Repo Dockerfile failed: ${buildErr?.message || buildErr}`, 'warning');
      emit(`[Build] Retrying with a generated ${lang} Dockerfile...`, 'warning');
      const genDockerfile = generateDockerfile({ ...detection, type: lang });
      const genPath = path.join(repoPath, 'Dockerfile.botmgr');
      fs.writeFileSync(genPath, genDockerfile);
      await dockerClient.buildImage(repoPath, imageName, onBuildLog, buildArgs, genPath);
      emit('[Done] Fallback build with generated Dockerfile completed', 'success');
    }
  } else {
    emit('[Skip] No build target, docker compose will pull images at start', 'info');
  }

  // CasaOS: save to metadata path (only after successful build)
  if (isCasaOS) {
    emit('[PCS] Saving CasaOS metadata...', 'info');
    await saveToCasaOSMetadata(appName, composeContent, (msg) => emit(msg, 'info'));
    await writeComposeEnvFile(appName, buildEffectiveEnv(instance), (msg) => emit(msg, 'info'));
    if (sidecarInjected) {
      emit('[PCS] Writing status page...', 'info');
      await writeStatusPage(appName, generateStatusPageHtml(instance), (msg) => emit(msg, 'info'));
    }
    if (bindOnlyConfigs.length > 0) {
      emit('[PCS] Writing config files...', 'info');
      await writeConfigFiles(appName, bindOnlyConfigs, (msg) => emit(msg, 'info'));
    }
  }

  // Record the commit this was built from so the manager's record and the bot's
  // baked badge agree. Prefer the value baked into the image; otherwise (no
  // build target) read the repo, then the source registry.
  if (instance.sourceId) {
    let recordCommit = resolvedCommit;
    if (!recordCommit) {
      try {
        const simpleGit = require('simple-git').simpleGit;
        const log = await simpleGit(repoPath).log({ maxCount: 1 });
        recordCommit = log.latest?.hash || null;
      } catch {
        recordCommit = sourceManager.getSource(instance.sourceId)?.lastCommitHash || null;
      }
    }
    if (recordCommit) updateLastBuiltCommit(botId, recordCommit);
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
 * Boot-time pass: an in-flight op dies with the manager, but its transient
 * status was persisted. Reset to error so cards are not stuck disabled;
 * syncContainerStates then corrects bots whose containers are actually up.
 */
export function resetTransientStatuses(): void {
  const registry = loadRegistry();
  for (const instance of Object.values(registry.instances)) {
    if (instance.status === 'building' || instance.status === 'starting' || instance.status === 'stopping') {
      console.log(`[Init] ${instance.id} was '${instance.status}' when the manager stopped - marking error`);
      updateBotStatus(instance.id, 'error');
    }
  }
}

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
    // Same matching as getContainerIdsForBot: generated composes (docker-image /
    // no-compose git bots) name containers bot-<id>-*, not <sanitizedName>*.
    // Standalone-capable service containers are excluded by exact name: the
    // fleet sidecar, a replica, or a recovery helper routinely runs ALONE
    // (dumps, re-seeds, rescues), and counting one as "the bot" flips the
    // registry to running - which a later stop turns into a compose down that
    // kills the very standby a rescue is streaming into.
    const standalone = new Set<string>([
      instance.fleetDb?.containerName || '',
      instance.fleetDbReplica?.containerName || '',
      `${instance.sanitizedName}-recovery-relay`,
      `${instance.sanitizedName}-recovery-rsyncd`,
      `${instance.sanitizedName}-recovery-rsync`,
    ]);
    const botContainers = containers.filter(c =>
      (c.name.startsWith(appName) || c.name.includes(`-${instance.id}-`)) && !standalone.has(c.name));
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
