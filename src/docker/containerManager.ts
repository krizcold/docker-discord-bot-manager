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
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';

const execAsync = promisify(exec);
import {
  InstanceConfig, InstanceRegistry, BotStatus, BotSourceType, DeploymentMode,
  CreateInstanceRequest, CreateDockerImageInstanceRequest, UpdateInstanceRequest,
  DetectionResult, FleetDbRecord, FleetDbReplication, FleetDbReplicaRecord, FleetReplicaSeedRecord, RecoveryChannelRecord, RecoveryRescueRecord, RecoveryRescueLeft,
  ContainerInfo, FleetFailbackDecline, FleetFailbackRun, FleetTransferRun, FleetBackupConfig, InstanceLane,
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
  generatedBackingSecrets,
  BackingSecret,
  ComposeResult
} from '../templates/compose';
import { applyVariableSubstitution } from '../templates/variableSubstitution';
import {
  processComposeForCasaOS,
  getMainServiceWebPort,
  getWebUiIndexPath,
  publishHostPort,
  gatewayOnDefaultPassword,
  botPortBind,
  attachBotToProxy,
  mainServiceSelfAuths,
  getFleetControlPort,
  getFleetTransferPort,
  getFleetControlService,
  getFleetTransferService,
  fleetPublicHost,
  transferPublicHost,
  attachFleetToProxy,
  getPublishedFleetHostPort,
  publishFleetHostPort,
  addFleetPostgresService,
  addFleetPostgresReplicaService,
  removeFleetPostgresReplicaService,
  addAppDependsOn,
  prepareDockerBotFiles,
  redeliverDockerConfigFiles,
  composeEnvValue,
  composeEnvLiteral,
  formatDotenvValue,
  newDeliveryReport,
  DeliveryReport,
  setDeclaredBindModes,
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
  removeFleetPostgresService,
  takeServiceOut,
  putServiceBack,
  platformNetworkNames,
  splitDockerVolume
} from '../templates/pcsProcessing';
import { generateStatusPageHtml } from '../templates/statusPage';
import * as configFileManager from '../config/configFileManager';
import * as envManager from '../env/manager';
import { findAppCapabilities } from '../config/appCapabilities';
import { writePrivateFile } from '../config/fileModes';
import { redactSecrets, urlPassword } from '../config/secretText';
import { getDeploymentMode, isModeExplicit } from '../casaos/detector';
import * as casaosApi from '../casaos/api';
import { logCollectors, LogCollector, BuildLogEntry } from '../build/logCollector';
import * as sourceManager from '../source/sourceManager';
import { sanitizeName, titleizeName, resolveNames, makeUniqueName, validateName, sameSource, describeSource } from '../naming';
import { substituteComposeNames } from '../compose/nameSubstitution';
import YAML from 'yaml';
import { capServiceLogs } from '../templates/logCaps';
import { storeFileState, preserveCorruptCopy, corruptCopyNote, listCorruptCopies, writeFileAtomic, writeFileKeepingOwner } from '../config/storeFile';

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

// Registries handed out by a load that could not read instances.json: they
// look empty, so a save built on one would erase every bot.
const brokenRegistryLoads = new WeakSet<InstanceRegistry>();
let warnedBrokenRegistry = false;

/**
 * Load instance registry from disk. Only a definitely missing file is an
 * empty registry; a file that cannot be checked, read or parsed loads empty
 * for the readers but every save refuses until it reads again.
 */
function loadRegistry(): InstanceRegistry {
  const state = storeFileState(REGISTRY_FILE);
  if (state.kind === 'absent') return { instances: {} };
  try {
    if (state.kind === 'broken') throw new Error(state.error);
    const content = fs.readFileSync(REGISTRY_FILE, 'utf-8');
    const registry: InstanceRegistry = JSON.parse(content);
    if (!registry || typeof registry !== 'object' || Array.isArray(registry)) throw new Error('instances.json is not a registry');
    for (const inst of Object.values(registry.instances || {})) decryptRecordSecrets(inst);
    warnedBrokenRegistry = false;
    return registry;
  } catch (error) {
    if (!warnedBrokenRegistry) {
      warnedBrokenRegistry = true;
      console.error('[ContainerManager] Failed to load registry; saves are refused until instances.json reads again:', error);
    }
    preserveCorruptCopy(REGISTRY_FILE);
    const empty: InstanceRegistry = { instances: {} };
    brokenRegistryLoads.add(empty);
    return empty;
  }
}

/**
 * The registry never persists sensitive env values: they live only in the
 * encrypted env store, and container env assembly derives them from there at
 * read time (the PLAN_REPLICATION two-store ruling). Enforced at the
 * persistence boundary so every mutation path is covered and a record that
 * still carries old plaintext self-scrubs on its next save.
 */
function withoutSensitiveKeys(envVars: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(envVars || {})) {
    if (envManager.isSensitive(key)) continue;
    // Same scalar coercion as the store's write side, so one dual write can
    // never author two different values (a raw JSON null in the record would
    // bake a literal "null" into the compose while the store reads '').
    const given = raw as unknown;
    out[key] = given === null || given === undefined ? '' : String(given);
  }
  return out;
}

// The four registry-held structured secrets (updateToken, the replication
// password, the recovery channel's token and TLS key) persist encrypted, the
// sibling of the env two-store strip for values that are not env vars and so
// have no env-store home. In-memory records always carry plaintext; these
// helpers run only at the load/save boundary. A pre-encryption plaintext value
// passes through load untouched and self-scrubs to ciphertext on the next
// save. On key loss the in-memory value reads '' (loud, warn-once) so
// consumers refuse, while the original ciphertext is stashed and written back
// verbatim by every save: the registry never loses it, and a restored key
// heals everything in place on the next load.
const warnedRecordSecrets = new Set<string>();
const lostRecordBlobs = new Map<string, string>();

function decryptRecordSecret(instId: string, field: string, value: string | undefined): string | undefined {
  if (!value || !value.startsWith('v2:')) return value;
  const key = `${instId}:${field}`;
  // The derived key is fixed for the process lifetime, so a blob that failed
  // once cannot heal without a restart: skip re-decrypting it (the decrypt
  // helper logs per failure, and loads run on every registry accessor).
  if (lostRecordBlobs.get(key) === value) return '';
  const plain = envManager.decryptOrNull(value);
  if (plain !== null) {
    lostRecordBlobs.delete(key);
    warnedRecordSecrets.delete(key);
    return plain;
  }
  lostRecordBlobs.set(key, value);
  if (!warnedRecordSecrets.has(key)) {
    warnedRecordSecrets.add(key);
    console.error(`[ContainerManager] ${field} for instance ${instId} no longer decrypts (encryption key changed or lost); its ciphertext stays preserved in the registry - restore the key, or re-provision the value`);
  }
  return '';
}

function decryptRecordSecrets(inst: InstanceConfig): void {
  inst.updateToken = decryptRecordSecret(inst.id, 'updateToken', inst.updateToken);
  if (inst.fleetDb?.replication) {
    inst.fleetDb.replication.password = decryptRecordSecret(inst.id, 'fleetDb.replication.password', inst.fleetDb.replication.password) ?? '';
  }
  if (inst.recoveryChannel) {
    inst.recoveryChannel.token = decryptRecordSecret(inst.id, 'recoveryChannel.token', inst.recoveryChannel.token) ?? '';
    inst.recoveryChannel.tlsKey = decryptRecordSecret(inst.id, 'recoveryChannel.tlsKey', inst.recoveryChannel.tlsKey);
  }
}

function encryptedOrStashed(instId: string, field: string, plain: string | undefined): string | undefined {
  if (plain) return envManager.encrypt(plain);
  // Only the '' scrub marker consults the stash: an ABSENT field means the
  // operator re-provisioned the structure away (e.g. a receiver re-armed as
  // source), and resurrecting the stale blob into it would mint a phantom
  // key-loss forever.
  if (plain === undefined) return undefined;
  // '' with a stashed blob is a key-loss read: write the original ciphertext
  // back so no save can destroy it.
  return lostRecordBlobs.get(`${instId}:${field}`) ?? plain;
}

/** The record's own credentials and the env store's sensitive values (passwords inside URLs included). */
function recordSecrets(inst: InstanceConfig): string[] {
  const secrets = [inst.updateToken, inst.fleetDb?.replication?.password, inst.recoveryChannel?.token, inst.recoveryChannel?.tlsKey];
  try {
    for (const [key, value] of Object.entries(envManager.getEnvVars(inst.id))) {
      if (!value) continue;
      if (envManager.isSensitive(key)) secrets.push(value);
      const pw = urlPassword(value);
      if (pw) secrets.push(pw);
    }
  } catch {
    // An unreadable env store leaves its values unknown here; the record's own still go.
  }
  return secrets.filter((s): s is string => !!s);
}

/**
 * A stored error can quote a command or a statement that carried a
 * credential, so every lastError is written with the record's secrets
 * replaced by ***.
 */
function withStoredErrorsScrubbed(inst: InstanceConfig): InstanceConfig {
  const has = [inst.fleetDbReplicaSeed, inst.fleetDbReplica?.autoReseed, inst.fleetTransfer, inst.fleetFailback, inst.recoveryRescue]
    .some(r => typeof r?.lastError === 'string' && r.lastError !== '');
  if (!has) return inst;
  const secrets = recordSecrets(inst);
  const scrub = <T extends { lastError?: string }>(r: T | undefined): T | undefined =>
    r && typeof r.lastError === 'string' ? { ...r, lastError: redactSecrets(r.lastError, secrets) } : r;
  const out: InstanceConfig = { ...inst };
  if (out.fleetDbReplicaSeed) out.fleetDbReplicaSeed = scrub(out.fleetDbReplicaSeed);
  if (out.fleetDbReplica?.autoReseed) out.fleetDbReplica = { ...out.fleetDbReplica, autoReseed: scrub(out.fleetDbReplica.autoReseed) };
  if (out.fleetTransfer) out.fleetTransfer = scrub(out.fleetTransfer);
  if (out.fleetFailback) out.fleetFailback = scrub(out.fleetFailback);
  if (out.recoveryRescue) out.recoveryRescue = scrub(out.recoveryRescue);
  return out;
}

function withRecordSecretsEncrypted(inst: InstanceConfig): InstanceConfig {
  const out: InstanceConfig = inst.envVars ? { ...inst, envVars: withoutSensitiveKeys(inst.envVars) } : { ...inst };
  out.updateToken = encryptedOrStashed(inst.id, 'updateToken', out.updateToken);
  if (out.fleetDb?.replication) {
    out.fleetDb = { ...out.fleetDb, replication: { ...out.fleetDb.replication, password: encryptedOrStashed(inst.id, 'fleetDb.replication.password', out.fleetDb.replication.password) ?? '' } };
  }
  if (out.recoveryChannel) {
    const rc = { ...out.recoveryChannel };
    rc.token = encryptedOrStashed(inst.id, 'recoveryChannel.token', rc.token) ?? '';
    rc.tlsKey = encryptedOrStashed(inst.id, 'recoveryChannel.tlsKey', rc.tlsKey);
    out.recoveryChannel = rc;
  }
  return out;
}

/**
 * Response-boundary copy of a record with the four registry-held secrets
 * removed: the browser has no use for them. (The recovery arm block carries
 * its own copy-paste credential through its dedicated surface.)
 */
export function withoutRecordSecrets(inst: InstanceConfig | null): InstanceConfig | null {
  if (!inst) return inst;
  const out: InstanceConfig = { ...inst };
  delete out.updateToken;
  // Explicit either way: the browser merges pushed records over what it holds,
  // and an absent key cannot clear a flag it already shows.
  out.pendingApply = inst.pendingApply === true;
  out.lane = inst.lane ?? null;
  if (out.fleetDb?.replication) {
    out.fleetDb = { ...out.fleetDb, replication: { ...out.fleetDb.replication, password: '' } };
  }
  if (out.recoveryChannel) {
    out.recoveryChannel = { ...out.recoveryChannel, token: '' };
    delete out.recoveryChannel.tlsKey;
  }
  return out;
}

/** Why instances.json cannot be read right now, or null when it reads (or is absent). */
export function registryFault(): string | null {
  if (!brokenRegistryLoads.has(loadRegistry())) return null;
  return `The instance registry (instances.json) cannot be read, so the bot list is unknown and every change is refused. Repair or replace instances.json (${corruptCopyNote(REGISTRY_FILE)}).`;
}

function refuseBrokenRegistry(registry: InstanceRegistry): void {
  if (brokenRegistryLoads.has(registry)) throw new Error(registryFault() || `The instance registry (instances.json) cannot be read, so nothing was saved. Repair or replace instances.json (${corruptCopyNote(REGISTRY_FILE)}).`);
}

function saveRegistrySync(registry: InstanceRegistry): void {
  const state = storeFileState(REGISTRY_FILE);
  if (brokenRegistryLoads.has(registry) || state.kind === 'broken') {
    throw new Error(`The instance registry (instances.json) cannot be read, so nothing was saved: a save would erase every bot it lists. Repair or replace instances.json (${corruptCopyNote(REGISTRY_FILE)}).`);
  }
  try {
    const instances: InstanceRegistry['instances'] = {};
    for (const [id, inst] of Object.entries(registry.instances)) {
      instances[id] = withRecordSecretsEncrypted(withStoredErrorsScrubbed(inst));
    }
    // Atomic write: a truncated/interrupted write (e.g. the container killed mid-save
    // during a rebuild) would otherwise corrupt the file, and the next load would
    // silently fall back to an empty registry and then persist it - losing every bot.
    writeFileAtomic(REGISTRY_FILE, JSON.stringify({ ...registry, instances }, null, 2));
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

/** Point the orphaned instances whose source URL matches at a newly added source. */
export function reassociateWithSource(sourceId: string, matchesUrl: (instanceSourceUrl: string) => boolean): void {
  const registry = loadRegistry();
  if (brokenRegistryLoads.has(registry)) {
    console.warn(`[ContainerManager] No bot was re-associated with source ${sourceId}: ${registryFault() || 'the instance registry (instances.json) cannot be read'}`);
    return;
  }
  const matched = Object.values(registry.instances).filter(inst => inst.sourceId === null && !!inst.sourceUrl && matchesUrl(inst.sourceUrl));
  if (matched.length === 0) return;
  const now = new Date().toISOString();
  for (const inst of matched) {
    inst.sourceId = sourceId;
    inst.updatedAt = now;
  }
  saveRegistry(registry);
  for (const inst of matched) console.log(`[ContainerManager] Re-associated instance ${inst.id} (${inst.displayName}) with source ${sourceId}`);
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

export type LaneResult = { success: boolean; error?: string; warning?: string; notApplied?: string[] };

// A transient status with no live op was left by an op whose closing write was
// refused, or one that died with the manager while the boot reset could not
// write: served as error so the card's controls stay live.
function servedStatus(inst: InstanceConfig): InstanceConfig {
  const transient = inst.status === 'building' || inst.status === 'starting' || inst.status === 'stopping';
  return transient && !activeOps.has(inst.id) ? { ...inst, status: 'error' } : inst;
}

/** The status as stored, before a transient with no live op is served as error. */
export function storedStatus(inst: InstanceConfig): InstanceConfig['status'] {
  return loadRegistry().instances[inst.id]?.status ?? inst.status;
}

export function getAllBots(): InstanceConfig[] {
  const registry = loadRegistry();
  return Object.values(registry.instances).map(servedStatus);
}

export function getBot(botId: string): InstanceConfig | null {
  const registry = loadRegistry();
  const inst = registry.instances[botId];
  return inst ? servedStatus(inst) : null;
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
        const value = composeEnvLiteral(entry.slice(eq + 1));
        if (key && !BOT_MANAGER_ENV_KEYS.has(key)) out[key] = value;
      }
    } else if (env && typeof env === 'object') {
      for (const [key, value] of Object.entries(env)) {
        if (!BOT_MANAGER_ENV_KEYS.has(key)) out[key] = composeEnvLiteral(String(value ?? ''));
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
  refuseBrokenRegistry(loadRegistry());
  const sourceFault = sourceManager.sourceRegistryFault();
  if (sourceFault) throw new Error(sourceFault);

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
  // ("Bot" -> "Bot 2") rather than rejected. The docker listing runs before the
  // load, so nothing awaits between the load and the save.
  const defaultName = source.composeName || extractRepoName(source.url);
  const foreignProjects = await foreignDockerProjects(Object.keys(loadRegistry().instances));
  const registry = loadRegistry();
  refuseBrokenRegistry(registry);
  const existing = Object.values(registry.instances);
  const displayName = makeUniqueName(request.displayName || defaultName, existing, undefined, {
    foreignProjects,
    source: { sourceUrl: source.url, sourceType: 'git' },
  });
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

  // Create-time env goes through the store so sensitive values land encrypted;
  // the record keeps only the non-sensitive keys.
  if (request.envVars && Object.keys(request.envVars).length > 0) {
    envManager.setEnvVars(instanceId, request.envVars);
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
    envVars: withoutSensitiveKeys(request.envVars),
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
  refuseBrokenRegistry(loadRegistry());
  const foreignProjects = await foreignDockerProjects(Object.keys(loadRegistry().instances));
  const registry = loadRegistry();
  refuseBrokenRegistry(registry);

  // Auto-uniquify a reserved or already-used name ("Bot" -> "Bot 2").
  const existing = Object.values(registry.instances);
  const names = resolveNames(makeUniqueName(request.displayName, existing, undefined, {
    foreignProjects,
    source: { sourceUrl: null, sourceType: 'docker-image', imageRef: request.imageRef },
  }));

  const instanceId = uuidv4();
  const now = new Date().toISOString();
  const updateToken = uuidv4();

  // Create instance directory
  const botDir = getBotDir(instanceId);
  const dataPath = getDataPath(instanceId);
  fs.mkdirSync(botDir, { recursive: true });
  fs.mkdirSync(dataPath, { recursive: true });

  // Same create-time routing as the git lane: store first, filtered record.
  if (request.envVars && Object.keys(request.envVars).length > 0) {
    envManager.setEnvVars(instanceId, request.envVars);
  }

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
    envVars: withoutSensitiveKeys(request.envVars),
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
export function updateInstanceFleetBackup(
  botId: string,
  changes: Partial<FleetBackupConfig>,
  expected?: Partial<FleetBackupConfig>
): { instance: InstanceConfig | null; conflict?: FleetBackupConfig } {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (!instance) return { instance: null };

  const current = instance.fleetBackup || { enabled: true, hour: 4, keep: 7 };
  if (expected) {
    for (const k of Object.keys(expected) as Array<keyof FleetBackupConfig>) {
      if (expected[k] !== undefined && expected[k] !== current[k]) return { instance, conflict: { ...current } };
    }
  }
  instance.fleetBackup = {
    enabled: changes.enabled !== undefined ? changes.enabled : current.enabled,
    hour: changes.hour !== undefined ? changes.hour : current.hour,
    keep: changes.keep !== undefined ? changes.keep : current.keep,
  };
  instance.updatedAt = new Date().toISOString();
  registry.instances[botId] = instance;
  saveRegistry(registry);
  return { instance };
}

/**
 * Persist (or clear) the sidecar's replication posture (the rewritten database
 * URL lives only in the encrypted env store). Applies to the compose on the
 * next start.
 */
export function updateInstanceFleetDbReplication(
  botId: string,
  replication: FleetDbReplication | null,
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

export function updateInstanceFleetDbReplicaKept(botId: string, kept: InstanceConfig['fleetDbReplicaKept'] | null): void {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (!instance) return;
  if (kept) instance.fleetDbReplicaKept = kept;
  else delete instance.fleetDbReplicaKept;
  instance.updatedAt = new Date().toISOString();
  saveRegistry(registry);
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

/** What an earlier cancelled rescue left stays marked while a new one runs; a cancel's left replaces it, and a finished swap clears it. */
export function updateInstanceRecoveryRescue(botId: string, rescue: RecoveryRescueRecord | null, lastSwap?: { startedAt: number; completedAt: number }, left?: RecoveryRescueLeft): InstanceConfig | null {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (!instance) return null;
  if (rescue) {
    instance.recoveryRescue = rescue;
  } else {
    delete instance.recoveryRescue;
    if (left) instance.recoveryRescueLeft = left;
  }
  if (lastSwap) {
    instance.recoveryLastSwap = lastSwap;
    delete instance.recoveryRescueLeft;
  }
  instance.updatedAt = new Date().toISOString();
  saveRegistry(registry);
  return instance;
}

/** Throws when the registry cannot be saved. */
export function updateInstanceRecoverySwappedAway(botId: string, record: { at: number } | null): void {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (!instance) return;
  if (!record && !instance.recoverySwappedAway) return;
  if (record) instance.recoverySwappedAway = record;
  else delete instance.recoverySwappedAway;
  instance.updatedAt = new Date().toISOString();
  saveRegistry(registry);
}

export function updateInstanceFleetDbReplicaSeed(botId: string, seed: FleetReplicaSeedRecord | null): InstanceConfig | null {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (!instance) return null;
  if (seed) instance.fleetDbReplicaSeed = seed;
  else delete instance.fleetDbReplicaSeed;
  instance.updatedAt = new Date().toISOString();
  saveRegistry(registry);
  return instance;
}

export function updateInstanceFleetDbPinsWarning(botId: string, warning: string | null): void {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (!instance) return;
  if (warning) instance.fleetDbPinsWarning = warning;
  else delete instance.fleetDbPinsWarning;
  instance.updatedAt = new Date().toISOString();
  saveRegistry(registry);
}

/**
 * Every value a deployed compose copy's app service sets for the given keys
 * (one entry per copy that sets it), or null when a copy could not be read.
 * With activeOnly, only the copy a start deploys from is read.
 */
export function deployedComposeEnvValues(botId: string, keys: string[], activeOnly = false): Array<{ key: string; value: string }> | null {
  const instance = getBot(botId);
  if (!instance) return [];
  const dataRoot = process.env.DATA_ROOT || '/DATA';
  const found: Array<{ key: string; value: string }> = [];
  const paths = activeOnly ? [resolveComposePath(botId, instance.sanitizedName)] : [
    path.join(getBotDir(botId), 'docker-compose.yml'),
    path.join(dataRoot, 'AppData', 'casaos', 'apps', instance.sanitizedName, 'docker-compose.yml'),
  ];
  for (const composePath of paths) {
    if (!fs.existsSync(composePath)) continue;
    try {
      const compose = YAML.parseDocument(fs.readFileSync(composePath, 'utf-8')).toJSON();
      const appName = compose?.services && typeof compose.services === 'object' ? getAppServiceName(compose) : null;
      const env = appName ? compose.services[appName]?.environment : undefined;
      for (const key of keys) {
        if (Array.isArray(env)) {
          for (const e of env) {
            if (typeof e !== 'string') continue;
            const eq = e.indexOf('=');
            if ((eq < 0 ? e : e.slice(0, eq)) === key) found.push({ key, value: eq < 0 ? '' : composeEnvLiteral(e.slice(eq + 1)) });
          }
        } else if (env && typeof env === 'object' && Object.prototype.hasOwnProperty.call(env, key)) {
          found.push({ key, value: env[key] == null ? '' : composeEnvLiteral(String(env[key])) });
        }
      }
    } catch {
      return null;
    }
  }
  return found;
}

export function updateInstanceFleetTransfer(botId: string, run: FleetTransferRun | null): void {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (!instance) return;
  if (run) instance.fleetTransfer = run;
  else delete instance.fleetTransfer;
  instance.updatedAt = new Date().toISOString();
  saveRegistry(registry);
}

export function updateInstanceFleetFailback(botId: string, run: FleetFailbackRun | null): void {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (!instance) return;
  if (run) instance.fleetFailback = run;
  else delete instance.fleetFailback;
  instance.updatedAt = new Date().toISOString();
  saveRegistry(registry);
}

/** Set or clear the copy-block retraction a bot has not confirmed yet. Throws when the registry cannot be saved. */
export function updateInstanceCopyBlockRetract(botId: string, pending: InstanceConfig['copyBlockRetract'] | null): void {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (!instance) return;
  if (pending) instance.copyBlockRetract = pending;
  else delete instance.copyBlockRetract;
  instance.updatedAt = new Date().toISOString();
  saveRegistry(registry);
}

export function updateInstanceFleetFailbackDeclined(botId: string, decline: FleetFailbackDecline | null): void {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (!instance) return;
  if (decline) instance.fleetFailbackDeclined = decline;
  else delete instance.fleetFailbackDeclined;
  instance.updatedAt = new Date().toISOString();
  saveRegistry(registry);
}

/** Set or clear a failed restore's notice. Throws when the registry cannot be saved. */
export function updateInstanceFleetRestoreError(botId: string, notice: { file: string; text: string } | null): void {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (!instance) return;
  if (!notice && !instance.fleetRestoreError) return;
  if (notice) instance.fleetRestoreError = notice;
  else delete instance.fleetRestoreError;
  instance.updatedAt = new Date().toISOString();
  saveRegistry(registry);
}

export function updateInstanceFleetOwnDbRetired(botId: string, at: string): void {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (!instance) return;
  instance.fleetOwnDbRetiredAt = at;
  instance.updatedAt = new Date().toISOString();
  saveRegistry(registry);
}

export function updateInstanceFleetLastPosture(botId: string, record: InstanceConfig['fleetLastPosture'] | null): void {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (!instance) return;
  if (record) instance.fleetLastPosture = record;
  else delete instance.fleetLastPosture;
  instance.updatedAt = new Date().toISOString();
  saveRegistry(registry);
}

/** Record or clear that a failback or drop-back run owns the write fence on this database. Throws when the registry cannot be saved. */
export function updateInstanceFleetConsentFenceLeft(botId: string, containerName: string, left: boolean): void {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (!instance) return;
  const now = instance.fleetConsentFenceLeft ?? [];
  if (now.includes(containerName) === left) return;
  const next = left ? [...now, containerName] : now.filter(c => c !== containerName);
  if (next.length) instance.fleetConsentFenceLeft = next;
  else delete instance.fleetConsentFenceLeft;
  instance.updatedAt = new Date().toISOString();
  saveRegistry(registry);
}

/** For modules that change an instance outside a route (the routes broadcast themselves). */
export function broadcastBotUpdated(botId: string): void {
  if (broadcastFn) broadcastFn('bot:updated', withoutRecordSecrets(getBot(botId)));
}

/**
 * Write the standby service into the DEPLOYED compose and start it (targeted
 * up; the running app service is untouched). Used by the provisioning flow;
 * rebuilds re-inject via buildGitInstance.
 */
export async function applyFleetDbReplicaService(botId: string): Promise<LaneResult> {
  const instance = getBot(botId);
  if (!instance?.fleetDbReplica) return { success: false, error: 'No standby record' };
  if (instance.fleetDb?.retiringAt) return { success: false, error: unfinishedRetireRefusal(instance.fleetDb.retiringAt) };
  const appName = resolveAppName(botId);
  const composePath = resolveComposePath(botId, appName);
  if (!fs.existsSync(composePath)) return { success: false, error: 'Deployed compose not found (install the instance first)' };
  const mode = await getDeploymentMode();
  let content: string;
  try {
    content = fs.readFileSync(composePath, 'utf-8');
    rewriteComposeFile(composePath, addFleetPostgresReplicaService(content, instance as any, instance.fleetDbReplica, { mode }));
  } catch (err) {
    return { success: false, error: `The standby service could not be written into the deployed compose, so nothing was started: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    await execAsync(`docker compose -f "${composePath}" -p "${appName}" up -d fleet-postgres-replica`);
    return { success: true };
  } catch (err) {
    // A ghost service in the deployed compose would break every later start
    // (up runs --remove-orphans and fails on the same cause): revert the file
    // so a failed apply leaves no trace.
    try {
      rewriteComposeFile(composePath, content);
    } catch (revertErr) {
      return { success: false, error: `${String(err)}; the deployed compose still names the standby service, because restoring it failed: ${revertErr instanceof Error ? revertErr.message : String(revertErr)}` };
    }
    return { success: false, error: String(err) };
  }
}

/**
 * The standby record as it stands now, not as the build's snapshot had it: a
 * Remove replica that landed during the build must not be written back. The
 * snapshot is kept only when the instance cannot be read at all.
 */
function standbyRecordNow(botId: string, snapshot: InstanceConfig): FleetDbReplicaRecord | undefined {
  const fresh = getBot(botId);
  return fresh ? fresh.fleetDbReplica : snapshot.fleetDbReplica;
}

/**
 * Replace a deployed compose whole (tmp plus rename), so a manager killed
 * mid-write never leaves a torn file; the old file's mode and owner carry over.
 */
function rewriteComposeFile(composePath: string, content: string): void {
  writeFileKeepingOwner(composePath, content);
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
export function adoptFleetDbReplicaAsPrimary(botId: string, replication?: FleetDbReplication): { success: boolean; error?: string } {
  const registry = loadRegistry();
  const stored = registry.instances[botId];
  if (!stored) return { success: false, error: 'Bot not found' };
  const replica = stored.fleetDbReplica;
  if (!replica) return { success: false, error: 'This instance has no standby to adopt' };
  if (stored.fleetDb) return { success: false, error: 'This instance already hosts a fleet database' };
  // Identity from the STAMP: adoption files an EXISTING byte-copied cluster,
  // whose role and database are whatever provisioning stamped, not whatever
  // the mutable per-source record says today.
  if (!replica.user || !replica.db) {
    return { success: false, error: 'This standby record predates identity stamping; retire and re-provision the standby before adopting' };
  }
  // The replication posture, when the caller recovered the credential the copy
  // already carries (B6 map F30): enable then keeps it instead of minting.
  stored.fleetDb = { containerName: replica.containerName, user: replica.user, db: replica.db, volume: replica.volume, ...(replication ? { replication } : {}) };
  delete stored.fleetDbReplica;
  // The seed record and any transfer run are about the standby this adopt just consumed.
  delete stored.fleetDbReplicaSeed;
  delete stored.fleetTransfer;
  delete stored.fleetOwnDbRetiredAt;
  stored.updatedAt = new Date().toISOString();
  saveRegistry(registry);
  const live = getBot(botId);
  if (live) {
    live.fleetDb = { ...stored.fleetDb };
    delete live.fleetDbReplica;
    delete live.fleetDbReplicaSeed;
    delete live.fleetTransfer;
    delete live.fleetOwnDbRetiredAt;
  }
  // A standby deployed before the app depended on it: order compose down now,
  // so the restart this adopt asks for stops the app before its database.
  try {
    const composePath = resolveComposePath(botId, resolveAppName(botId));
    if (fs.existsSync(composePath)) {
      const content = fs.readFileSync(composePath, 'utf-8');
      const compose = YAML.parseDocument(content).toJSON();
      const key = Object.entries((compose?.services || {}) as Record<string, any>)
        .find(([, svc]) => svc?.container_name === replica.containerName)?.[0];
      if (key) {
        const updated = addAppDependsOn(content, key);
        if (updated !== content) rewriteComposeFile(composePath, updated);
      }
    }
  } catch (err) {
    console.error(`[ContainerManager] Adopt could not order the deployed compose for ${botId}: ${err}`);
  }
  return { success: true };
}

export function unfinishedRetireRefusal(retiringAt: string): string {
  return `The fleet database of this instance was being removed (since ${retiringAt}) and the removal did not finish, so its volume may already be gone and a start would create an empty database in its place. Run the decommission or the re-seed again to finish it`;
}

/**
 * Bring ONLY the managed database sidecar up and wait for it to accept
 * connections. Stopping an instance takes its whole compose project down, so
 * the stale-primary re-seed (PLAN_REPLICATION.md Stage 5) has no database to
 * dump until this runs; the app service is deliberately left down.
 * retireRetry: the caller proved the volume predates the retiring mark.
 */
export async function startFleetDbSidecar(botId: string, opts: { forRescue?: boolean; retireRetry?: boolean } = {}): Promise<LaneResult> {
  const instance = getBot(botId);
  const fleetDb = instance?.fleetDb;
  if (!instance || !fleetDb) return { success: false, error: 'This instance hosts no managed fleet database' };
  if (fleetDb.retiringAt && !opts.retireRetry) return { success: false, error: unfinishedRetireRefusal(fleetDb.retiringAt) };
  if (instance.recoveryRescue && !opts.forRescue) {
    return { success: false, error: 'A database rescue is recorded on this instance and rewrites its volume; the database was not started' };
  }
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
 * The caller has already dumped whatever it wanted to keep. volumeRemoved is
 * set once the volume is gone, also on a failure after that point.
 */
export async function retireFleetDbSidecar(botId: string): Promise<LaneResult & { volumeRemoved?: boolean }> {
  const instance = getBot(botId);
  const fleetDb = instance?.fleetDb;
  if (!instance || !fleetDb) return { success: false, error: 'This instance hosts no managed fleet database' };
  const shared = sharedVolumeReason(fleetDb.volume, botId);
  if (shared) return { success: false, error: `database volume ${fleetDb.volume} kept: ${shared}; nothing was removed` };
  const composePath = resolveComposePath(botId, resolveAppName(botId));
  // Read before anything is removed, so a compose that cannot be stripped
  // refuses with the database whole.
  const unread = strippedDeployedCompose(composePath, removeFleetDbServices).error;
  if (unread) return { success: false, error: `the deployed compose could not be read (${unread}); nothing was removed` };
  // The mark goes on the record BEFORE the container and the volume: a
  // failure after the volume removal leaves a record that Start, a failback
  // Cancel and the next decommission read as a database being destroyed.
  const markedHere = !fleetDb.retiringAt;
  const retiringAt = fleetDb.retiringAt ?? new Date().toISOString();
  try {
    setFleetDbRetiringAt(botId, retiringAt);
  } catch (err) {
    return { success: false, error: `the retire could not be recorded (${errorText(err)}); nothing was removed` };
  }
  instance.fleetDb = { ...fleetDb, retiringAt };
  // A failure before the volume removal leaves the database whole, so the
  // mark this call set comes off again.
  const keptWhole = (reason: string): LaneResult => {
    if (!markedHere) return { success: false, error: reason };
    try {
      setFleetDbRetiringAt(botId, null);
      instance.fleetDb = fleetDb;
      return { success: false, error: reason };
    } catch (err) {
      return { success: false, error: `${reason}; the record still marks the database as being removed (${errorText(err)}), so Start refuses until a retry finishes` };
    }
  };
  // Container and volume go FIRST: if either fails, the compose service is
  // still declared and the record kept, so a retry can start the sidecar and
  // dump again. Both strippers run because an adopted standby's database
  // rides the 'fleet-postgres-replica' service key until its next rebuild;
  // callers guard that no real standby record exists, so any replica-keyed
  // service here IS this database (or recordless debris).
  try {
    await execAsync(`docker rm -f "${fleetDb.containerName}"`);
  } catch (err) {
    if (!/no such container/i.test(errorText(err))) {
      return keptWhole(`could not remove the database container ${fleetDb.containerName} (${errorText(err)}); its volume and record were kept`);
    }
  }
  if (!dockerClient.removeVolume(fleetDb.volume)) {
    if (dockerClient.volumeState(fleetDb.volume) === 'exists') {
      return keptWhole(`could not remove the old database volume ${fleetDb.volume}; the container may still be running`);
    }
    return { success: false, error: `can't confirm whether the old database volume ${fleetDb.volume} was removed (docker did not answer); the record keeps it marked as being removed` };
  }
  try {
    const stripped = strippedDeployedCompose(composePath, removeFleetDbServices);
    if (stripped.error) throw new Error(`the deployed compose could not be read: ${stripped.error}`);
    if (stripped.content !== null) rewriteComposeFile(composePath, stripped.content);
    const registry = loadRegistry();
    const stored = registry.instances[botId];
    // With the old copy gone, a swap that handed it away can no longer leave a second primary behind.
    if (stored) {
      delete stored.fleetDb;
      delete stored.recoverySwappedAway;
      delete stored.recoveryRescueLeft;
      stored.updatedAt = new Date().toISOString();
      saveRegistry(registry);
    }
  } catch (err) {
    return { success: false, volumeRemoved: true, error: `the database volume ${fleetDb.volume} was removed, but its compose or record could not be updated: ${errorText(err)}` };
  }
  delete instance.fleetDb;
  delete instance.recoverySwappedAway;
  delete instance.recoveryRescueLeft;
  return { success: true, volumeRemoved: true };
}

function removeFleetDbServices(content: string): string {
  return removeFleetPostgresReplicaService(removeFleetPostgresService(content));
}

function errorText(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown } | null;
  const text = String(e?.stderr || e?.message || err).trim();
  return text.split('\n').pop() || text;
}

/** The deployed compose passed through strip; content null when none is deployed, error on any other read failure. */
function strippedDeployedCompose(composePath: string, strip: (content: string) => string): { content: string | null; error?: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(composePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { content: null };
    return { content: null, error: errorText(err) };
  }
  try {
    return { content: strip(raw) };
  } catch (err) {
    return { content: null, error: errorText(err) };
  }
}

function setFleetDbRetiringAt(botId: string, at: string | null): void {
  const registry = loadRegistry();
  const stored = registry.instances[botId]?.fleetDb;
  if (!stored) throw new Error('the instance record no longer names this database');
  if (at) stored.retiringAt = at;
  else delete stored.retiringAt;
  registry.instances[botId].updatedAt = new Date().toISOString();
  saveRegistry(registry);
}

/** Remove the standby service from the deployed compose and its container; the volume stays. */
export async function removeFleetDbReplicaService(botId: string, containerName: string): Promise<LaneResult> {
  const composePath = resolveComposePath(botId, resolveAppName(botId));
  const stripped = strippedDeployedCompose(composePath, removeFleetPostgresReplicaService);
  if (stripped.error) return { success: false, error: `the deployed compose could not be read (${stripped.error}); the standby was left as it is` };
  try {
    if (stripped.content !== null) rewriteComposeFile(composePath, stripped.content);
  } catch (err) {
    return { success: false, error: `the standby service could not be removed from the deployed compose (${errorText(err)}); the standby was left as it is` };
  }
  try {
    await execAsync(`docker rm -f "${containerName}"`);
  } catch (err) {
    if (!/no such container/i.test(errorText(err))) {
      return { success: false, error: `the standby service was removed from the deployed compose, but its container ${containerName} could not be removed: ${errorText(err)}` };
    }
  }
  return { success: true };
}

function laneHeldComposePath(botId: string): string {
  return path.join(getBotDir(botId), 'docker-compose.lane-held.json');
}

export function fleetDbHeldForLane(botId: string): boolean {
  return fs.existsSync(laneHeldComposePath(botId));
}

/**
 * Take the fleet database service out of the deployed compose (on CasaOS, the app file a tile click or a CasaOS
 * restart starts from) while a lane rewrites its volume. The compose as it was is kept beside the bot first, so
 * releaseFleetDbFromLane can put the service back. A repeated hold finds no service and keeps the first kept copy;
 * a kept copy left by an earlier lane is replaced by the compose as it is now.
 */
export function holdFleetDbForLane(botId: string): LaneResult {
  const fleetDb = getBot(botId)?.fleetDb;
  if (!fleetDb) return { success: false, error: 'This instance hosts no managed fleet database' };
  const heldPath = laneHeldComposePath(botId);
  try {
    const held = fs.existsSync(heldPath) ? JSON.parse(fs.readFileSync(heldPath, 'utf-8')) as { path: string } : null;
    const composePath = held?.path ?? resolveComposePath(botId, resolveAppName(botId));
    if (!fs.existsSync(composePath)) return { success: true };
    const content = fs.readFileSync(composePath, 'utf-8');
    const out = takeServiceOut(content, fleetDb.containerName);
    if (!out.key) return { success: true };
    writePrivateFile(heldPath, JSON.stringify({ path: composePath, key: out.key, content }));
    rewriteComposeFile(composePath, out.content);
    return { success: true };
  } catch (err) {
    return { success: false, error: `the database service could not be taken out of the deployed compose: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Put back the database service holdFleetDbForLane took out; success with nothing to do when no hold is kept. */
export function releaseFleetDbFromLane(botId: string): LaneResult {
  const heldPath = laneHeldComposePath(botId);
  try {
    if (!fs.existsSync(heldPath)) return { success: true };
    const held = JSON.parse(fs.readFileSync(heldPath, 'utf-8')) as { path: string; key: string; content: string };
    if (typeof held?.path !== 'string' || typeof held.key !== 'string' || typeof held.content !== 'string') {
      throw new Error(`${heldPath} does not hold a kept compose`);
    }
    if (!fs.existsSync(held.path)) throw new Error(`the deployed compose ${held.path} is missing`);
    const current = fs.readFileSync(held.path, 'utf-8');
    const restored = putServiceBack(current, held.content, held.key);
    if (restored !== current) rewriteComposeFile(held.path, restored);
    fs.unlinkSync(heldPath);
    return { success: true };
  } catch (err) {
    return { success: false, error: `the database service could not be put back into the deployed compose (the compose as it was is kept at ${heldPath}): ${err instanceof Error ? err.message : String(err)}` };
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
 * Update the instance's public URL auth mode (applies on the next Update or Build).
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

/**
 * What a deployed instance left under its compose name: a compose file, CasaOS
 * metadata, a data folder or recorded volumes. A path that cannot be checked
 * counts as present.
 */
function deployedTraces(instance: InstanceConfig): string[] {
  const dataRoot = process.env.DATA_ROOT || '/DATA';
  const traces: string[] = [];
  const candidates = [
    path.join(getBotDir(instance.id), 'docker-compose.yml'),
    path.join(dataRoot, 'AppData', 'casaos', 'apps', instance.sanitizedName),
    path.join(dataRoot, 'AppData', instance.sanitizedName),
  ];
  for (const p of candidates) {
    try {
      fs.statSync(p);
      traces.push(`${p} exists`);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') traces.push(`${p} cannot be checked (${err?.code || err?.message || err})`);
    }
  }
  if (instance.projectVolumes?.length) traces.push(`volumes ${instance.projectVolumes.join(', ')}`);
  return traces;
}

export async function updateBot(botId: string, update: UpdateInstanceRequest): Promise<InstanceConfig | null> {
  const before = loadRegistry();
  if (!before.instances[botId]) return null;
  const foreignProjects = update.displayName && resolveNames(update.displayName).sanitizedName !== before.instances[botId].sanitizedName
    ? await foreignDockerProjects(Object.keys(before.instances))
    : null;
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (!instance) return null;

  if (update.displayName) {
    const names = resolveNames(update.displayName);
    // Same constraints as create: without this, renaming B to A's name gives
    // two instances one sanitizedName, colliding the compose project, the
    // AppData folder and the primary vhost. Excluding this instance keeps
    // cosmetic self-renames allowed.
    const renamesProject = names.sanitizedName !== instance.sanitizedName;
    if (renamesProject) {
      const deployed = deployedTraces(instance);
      if (deployed.length > 0) {
        throw new Error(`Cannot rename: the new name changes the compose name from ${instance.sanitizedName} to ${names.sanitizedName}, and the old name still has a deployment or data on this host (${deployed.join('; ')}). Only a display name with the same compose name can be set`);
      }
    }
    if (renamesProject && !foreignProjects) {
      throw new Error('Cannot rename: the bot changed while the name was being checked; try again');
    }
    const check = validateName(update.displayName, Object.values(registry.instances), botId, renamesProject && foreignProjects
      ? { foreignProjects }
      : {});
    if (!check.valid) {
      throw new Error(`Cannot rename: ${check.errors.join('; ')}`);
    }
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
  let storeBefore: envManager.StoredKeys | null = null;
  if (update.envVars) {
    // The single env dual-write funnel, AFTER the rename validation so a
    // refused update persists nothing anywhere: the store takes everything
    // (sensitive values encrypted; throws on a corrupt store before any state
    // changes), the record keeps only the non-sensitive keys.
    storeBefore = envManager.snapshotStoredKeys(botId, Object.keys(update.envVars));
    envManager.setEnvVars(botId, update.envVars);
    instance.envVars = withoutSensitiveKeys({ ...instance.envVars, ...update.envVars });
  }
  instance.updatedAt = new Date().toISOString();

  registry.instances[botId] = instance;
  try {
    saveRegistry(registry);
  } catch (err) {
    if (!storeBefore) throw err;
    const why = err instanceof Error ? err.message : String(err);
    try {
      envManager.restoreStoredKeys(botId, storeBefore);
    } catch (restoreErr) {
      throw new Error(`The env save is incomplete: the env store took the new values, but the instance record could not be written (${why}), and putting the store back failed too (${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}). The next start may use the new values; save again once the disk can be written`);
    }
    throw new Error(`The instance record could not be written (${why}), so nothing was saved; the env store was put back as it was`);
  }

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
 * Returns the compose files that could not be edited.
 */
export function removeEnvKeyFromDeployedCompose(botId: string, key: string): string[] {
  const instance = getBot(botId);
  if (!instance) return [];
  const failed: string[] = [];
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
      if (!deleteComposeEnv(svc.environment, key)) continue;
      rewriteComposeFile(composePath, YAML.stringify(compose, { lineWidth: 0 }));
    } catch (err) {
      console.warn(`[ContainerManager] Failed to strip env key ${key} from ${composePath}: ${err}`);
      failed.push(composePath);
    }
  }
  return failed;
}

/**
 * Remove one key from the deployed compose copies first, then from the env
 * store and the record. A compose that could not be edited leaves the key
 * stored, so a retry repeats the whole removal. Returns the unedited files.
 */
export function removeEnvKeyEverywhere(botId: string, key: string): string[] {
  const unedited = removeEnvKeyFromDeployedCompose(botId, key);
  if (unedited.length > 0) return unedited;
  const storeBefore = envManager.snapshotStoredKeys(botId, [key]);
  envManager.deleteEnvVar(botId, key);
  try {
    removeBotEnvVars(botId, [key]);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    try {
      envManager.restoreStoredKeys(botId, storeBefore);
    } catch (restoreErr) {
      throw new Error(`${key} is half removed: it is gone from the env store, but the instance record could not be written (${why}) and still lists it, and putting the store back failed too (${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}); retry the removal`);
    }
    throw new Error(`The instance record could not be written (${why}), so ${key} was not removed; retry the removal`);
  }
  if (Object.prototype.hasOwnProperty.call(envManager.getEnvVars(botId), key)) {
    throw new Error(`The env store still holds ${key} after the removal`);
  }
  return [];
}

/**
 * removeEnvKeyEverywhere for each given key that is actually stored (the env
 * store or the record). Answers the keys removed, the keys still stored
 * because a compose could not be edited, and those files.
 */
export function removeStoredEnvKeys(botId: string, keys: string[]): { removed: string[]; stillStored: string[]; composeFailures: string[] } {
  const stored = envManager.getEnvVars(botId);
  const record = getBot(botId)?.envVars || {};
  const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
  const removed: string[] = [];
  const stillStored: string[] = [];
  const composeFailures = new Set<string>();
  for (const key of new Set(keys)) {
    if (!has(stored, key) && !has(record, key)) continue;
    const unedited = removeEnvKeyEverywhere(botId, key);
    if (unedited.length === 0) removed.push(key);
    else { stillStored.push(key); for (const file of unedited) composeFailures.add(file); }
  }
  return { removed, stillStored, composeFailures: [...composeFailures] };
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

/** True when an image the manager built for this compose is gone; pulled images and an unreadable compose answer false. */
async function builtImageMissing(instance: InstanceConfig, composePath: string): Promise<boolean> {
  let services: Record<string, any> = {};
  try {
    services = YAML.parse(fs.readFileSync(composePath, 'utf-8'))?.services ?? {};
  } catch {
    return false;
  }
  const prefix = `${instance.sanitizedName}-${instance.id}`;
  for (const svc of Object.values(services)) {
    const image = svc?.image;
    if (typeof image !== 'string' || !(image.startsWith(`${prefix}:`) || image.startsWith(`${prefix}-`))) continue;
    if ((await dockerClient.imageState(image)) === 'absent') return true;
  }
  return false;
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

// Set by SIGTERM: the lanes still running get the bounded wait, and no new one is admitted.
let shuttingDown = false;
export const SHUTDOWN_REFUSAL = 'The manager is shutting down, so this was refused and nothing was changed; retry once it is back up';

export function beginShutdown(): void {
  shuttingDown = true;
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

/** Every op lock held now, as [botId, op]. */
export function activeBotOps(): Array<[string, string]> {
  return Array.from(activeOps.entries());
}

// Instances a database lane (a fleet restore) holds stopped: Start, Restart, Update and Build refuse on them.
const databaseHolds = new Map<string, string>();

export function holdForDatabaseLane(botIds: string[], lane: string): void {
  for (const id of botIds) databaseHolds.set(id, lane);
}

export function releaseDatabaseLane(botIds: string[]): void {
  for (const id of botIds) databaseHolds.delete(id);
}

function swappedAwayRefusal(botId: string, action: string): { success: false; error: string } | null {
  const swapped = getBot(botId)?.recoverySwappedAway;
  if (!swapped) return null;
  const day = new Date(swapped.at).toISOString().slice(0, 10);
  return { success: false, error: `A recovery swap on ${day} handed this instance's database to another machine, so ${action} would run a second primary on the old copy; re-seed it as a standby of the new primary, or, if that swap never promoted the copy there, clear the swap record on its Database modal first` };
}

function databaseHoldRefusal(botId: string, action: string): { success: false; error: string } | null {
  const lane = databaseHolds.get(botId);
  return lane ? { success: false, error: `${lane} is running on this instance's database; ${action} is refused until it ends` } : null;
}

/** The recorded database runs a build or update must not run under; null when none is recorded. */
function databaseRunRefusal(botId: string, action: string): { success: false; error: string } | null {
  const inst = getBot(botId);
  if (!inst) return null;
  if (inst.recoveryRescue) return { success: false, error: `A database rescue is recorded on this instance; finish or cancel it before ${action} (nothing was changed)` };
  if (inst.fleetFailback) return { success: false, error: `A ${inst.fleetFailback.mode} run is recorded on this instance (${inst.fleetFailback.phase}); Continue, Cancel or Dismiss it on the Database modal before ${action} (nothing was changed)` };
  if (inst.fleetTransfer) return { success: false, error: `A database transfer is recorded on this instance (${inst.fleetTransfer.phase}); let it finish or cancel it before ${action} (nothing was changed)` };
  return null;
}

// Status pushes sent inside an op carry its activeOp; once the lock is gone
// every tab is told, whatever path the op ended on.
function broadcastOpReleased(botId: string): void {
  if (!broadcastFn) return;
  const registry = loadRegistry();
  if (brokenRegistryLoads.has(registry)) {
    broadcastFn('bot:status', { id: botId, activeOp: null });
    return;
  }
  const inst = registry.instances[botId];
  if (inst) broadcastFn('bot:status', { id: botId, status: servedStatus(inst).status, activeOp: null });
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
    broadcastOpReleased(botId);
  }
}

/** Throws when the registry cannot be written; the lane must then not start. */
function writeLane(botId: string, lane: InstanceLane | undefined): void {
  const registry = loadRegistry();
  const inst = registry.instances[botId];
  if (!inst) return;
  if (lane) inst.lane = lane;
  else if (!inst.lane) return;
  else delete inst.lane;
  inst.updatedAt = new Date().toISOString();
  saveRegistry(registry);
}

function newLane(op: InstanceLane['op'], wasRunning: boolean, keepData?: boolean): InstanceLane {
  return { op, wasRunning, ...(keepData === undefined ? {} : { keepData }), startedAt: new Date().toISOString() };
}

/** Clears an update, restart or build record once its obligation is met; a delete record stands. */
function clearFinishedLane(botId: string): string | null {
  if (getBot(botId)?.lane?.op === 'delete') return null;
  try {
    writeLane(botId, undefined);
    return null;
  } catch (err) {
    const msg = `the record of the earlier lane could not be cleared: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[ContainerManager] ${botId}: ${msg}`);
    return msg;
  }
}

function deleteLaneRefusal(botId: string, action: string): { success: false; error: string } | null {
  const lane = getBot(botId)?.lane;
  if (lane?.op !== 'delete') return null;
  return { success: false, error: `A Delete of this instance${lane.keepData ? ' (keeping its data)' : ''} did not finish, so its containers, image or compose may already be gone; ${action} is refused until Delete is run again` };
}

function laneRecordRefusal(op: string, err: unknown): { success: false; error: string } {
  return { success: false, error: `The ${op} did not start: the manager could not record it before changing anything (${err instanceof Error ? err.message : String(err)})` };
}

function withWarning(result: LaneResult, extra: string | null): LaneResult {
  if (!extra || !result.success) return result;
  return { ...result, warning: result.warning ? `${result.warning}; ${extra}` : extra };
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
  fn: () => Promise<LaneResult>
): Promise<LaneResult> {
  const current = activeOps.get(botId);
  if (current) {
    throw new Error(`Operation '${current}' is already in progress for this bot`);
  }
  activeOps.set(botId, op);
  const log = logCollectors.get(botId);
  log.beginOp(op);
  const endStatus = () => { try { return getBot(botId)?.status; } catch { return undefined; } };
  try {
    const result = await fn();
    if (result.success) log.endOp('done', undefined, endStatus());
    else log.endOp('failed', result.error || 'unknown error', endStatus());
    return result;
  } catch (err) {
    log.endOp('failed', String(err), endStatus());
    throw err;
  } finally {
    activeOps.delete(botId);
    broadcastOpReleased(botId);
  }
}

// ─── Delete ───

/** A path is absent only when stat says ENOENT or ENOTDIR; any other stat
 * error means its fate cannot be known. */
function pathState(p: string): 'exists' | 'absent' | 'unknown' {
  try {
    fs.lstatSync(p);
    return 'exists';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unknown';
  }
}

function removePathTracked(p: string, label: string, failures: string[]): void {
  const before = pathState(p);
  if (before === 'absent') return;
  if (before === 'unknown') {
    failures.push(`${label}: cannot be stat-ed, removal unverifiable`);
    return;
  }
  try { fs.rmSync(p, { recursive: true, force: true }); }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${label}: ${msg}`);
    return;
  }
  const after = pathState(p);
  if (after === 'exists') failures.push(`${label}: still present after removal`);
  else if (after === 'unknown') failures.push(`${label}: cannot be stat-ed, removal unverifiable`);
}

function pushPathRemnant(p: string, label: string, remnants: string[]): void {
  const state = pathState(p);
  if (state === 'exists') remnants.push(label);
  else if (state === 'unknown') remnants.push(`${label} (unverifiable, cannot be stat-ed)`);
}

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
        { timeout: dockerClient.DOCKER_STOP_CLI_MS }
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
  removePathTracked(metadataDir, `metadata dir ${metadataDir}`, failures);

  // 5. Remove app data directory if requested
  if (removeData) {
    const appDataDir = path.join(pcsDataRoot, 'AppData', appName);
    removePathTracked(appDataDir, `app data ${appDataDir}`, failures);
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

export async function deleteBot(botId: string, keepData: boolean = false, keepEnv: boolean = true, confirmFleetData = false, confirmPromoted = false): Promise<boolean> {
  return withBotOp(botId, 'delete', () => deleteBotImpl(botId, keepData, keepEnv, confirmFleetData, confirmPromoted));
}

/**
 * The manager's env copies inside the bot dir: the store with its write and
 * corruption siblings, and both .env files. The env folder also holds the
 * config file store, which is not one of them.
 */
export function botEnvCopies(botId: string): string[] {
  const store = path.join(getEnvPath(botId), 'storage.json');
  const copies = listCorruptCopies(store).map(n => path.join(getEnvPath(botId), n));
  return [store, `${store}.tmp`, ...copies, path.join(getEnvPath(botId), '.env'), path.join(getBotDir(botId), '.env')];
}

/**
 * Everything a delete is responsible for removing that still exists. Empty
 * means the delete achieved its goal regardless of what individual steps
 * reported (a step can error, such as a failed docker rm or a retry after a
 * partial delete, while nothing it owns actually remains).
 */
async function listDeleteRemnants(
  instance: InstanceConfig,
  appName: string,
  botDir: string,
  keepData: boolean,
  keepEnv: boolean,
  deploymentMode: DeploymentMode,
  ownVolumes: string[],
  volumesVerified: boolean
): Promise<string[]> {
  const remnants: string[] = [];
  // One reachability verdict up front; each probe below still tells "none"
  // from "docker did not answer", since the daemon can stop answering later.
  if (!await dockerClient.checkDockerConnection()) {
    return ['docker unreachable (nothing could be verified)'];
  }
  try {
    // The bot-id label is the exact ownership key (every processed compose
    // service carries it, injected sidecars included): name matching either
    // claimed a sibling's containers (startsWith(appName) vs fmdbworker2app)
    // or missed own containers with imported no-separator names.
    for (const c of await dockerClient.listContainersByBotId(instance.id)) {
      remnants.push(`container ${c.name}`);
    }
  } catch {
    // Cannot see containers at all: do not deregister on blind faith.
    remnants.push('unverified containers (docker unreachable)');
  }
  // The recovery and seed helpers are docker-run without labels, so the label
  // scan cannot see them; their names are exactly enumerable, probed one by one.
  for (const name of [
    instance.recoveryChannel?.containerName,
    `${instance.sanitizedName}-recovery-rsyncd`,
    `${instance.sanitizedName}-recovery-rsync`,
    `${instance.sanitizedName}-fleet-replica-seed`,
    `${instance.sanitizedName}-fleet-replica-seed-slot`,
    `${instance.sanitizedName}-fleet-replica-seed-slot-drop`,
    `${instance.sanitizedName}-fleet-replica-seed-probe`,
    `${instance.sanitizedName}-fleet-postgres-replica-data-helper`,
  ]) {
    if (!name) continue;
    const state = await execAsync(`docker inspect "${name}"`).then(() => 'exists' as const).catch((err) =>
      String(err instanceof Error ? err.message : err).toLowerCase().includes('no such object') ? 'absent' as const : 'unknown' as const);
    if (state === 'exists') remnants.push(`container ${name}`);
    else if (state === 'unknown') remnants.push(`container ${name} (unverifiable, docker did not answer)`);
  }

  const imageName = getImageName(instance);
  const image = await dockerClient.imageState(imageName);
  if (image === 'exists') remnants.push(`image ${imageName}`);
  else if (image === 'unknown') remnants.push(`image ${imageName} (unverifiable, docker did not answer)`);

  if (!keepData) {
    if (!volumesVerified) remnants.push(`unverified volumes of ${appName} (a compose file of this instance could not be read)`);
    // Companion volumes carry explicit names without the {project}_ prefix;
    // probe each directly and treat an unanswerable probe as a remnant.
    for (const vol of [...ownVolumes, instance.fleetDb?.volume, instance.fleetDbReplica?.volume]) {
      if (!vol) continue;
      const state = dockerClient.volumeState(vol);
      if (state === 'exists') remnants.push(`volume ${vol}`);
      else if (state === 'unknown') remnants.push(`volume ${vol} (unverifiable, docker did not answer)`);
    }
    pushPathRemnant(botDir, `directory ${botDir}`, remnants);
  } else {
    pushPathRemnant(path.join(botDir, 'docker-compose.yml'), `compose file in ${botDir}`, remnants);
    if (!keepEnv) {
      for (const p of botEnvCopies(instance.id)) pushPathRemnant(p, `env ${p}`, remnants);
    }
  }

  if (deploymentMode === 'casaos') {
    const dataRoot = process.env.DATA_ROOT || '/DATA';
    pushPathRemnant(path.join(dataRoot, 'AppData', 'casaos', 'apps', appName), 'CasaOS app metadata', remnants);
    if (!keepData) pushPathRemnant(path.join(dataRoot, 'AppData', appName), `AppData/${appName}`, remnants);
  }
  return remnants;
}

/** rm -f that tolerates only PROVEN absence: an "is already gone" error is
 * the normal case, but any other failure (daemon down, removal in progress)
 * must land in the failure list, or the remnants gate is never consulted and
 * a surviving helper container is orphaned with the registry entry gone. */
async function rmContainerTolerant(name: string, failures: string[]): Promise<void> {
  try {
    await execAsync(`docker rm -f "${name}"`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.toLowerCase().includes('no such container')) failures.push(`container ${name}: ${msg}`);
  }
}

/**
 * The project-prefixed volumes this instance's deployed compose declares, or
 * null when that compose exists but cannot be read. A kept volume of an
 * earlier install under the same name shares the {project}_ prefix, so the
 * prefix alone never proves a volume belongs to this instance.
 */
function ownProjectVolumes(botId: string, appName: string): string[] | null {
  const composePath = resolveComposePath(botId, appName);
  let compose: any;
  try {
    compose = YAML.parse(fs.readFileSync(composePath, 'utf-8'));
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? [] : null;
  }
  if (compose === null || compose === undefined) return [];
  if (typeof compose !== 'object') return null;
  const volumes = compose.volumes;
  if (volumes === undefined || volumes === null) return [];
  if (typeof volumes !== 'object' || Array.isArray(volumes)) return null;
  return Object.entries(volumes)
    .filter(([, v]) => !(v && typeof v === 'object' && ((v as any).external || (v as any).name)))
    .map(([key]) => `${appName}_${key}`);
}

/** Every volume name a deployed compose declares; [] when there is none, null when it cannot be read. */
function composeVolumeNames(botId: string, appName: string): string[] | null {
  let compose: any;
  try {
    compose = YAML.parse(fs.readFileSync(resolveComposePath(botId, appName), 'utf-8'));
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? [] : null;
  }
  if (compose === null || compose === undefined) return [];
  if (typeof compose !== 'object') return null;
  const volumes = compose.volumes;
  if (volumes === undefined || volumes === null) return [];
  if (typeof volumes !== 'object' || Array.isArray(volumes)) return null;
  return Object.entries(volumes).map(([key, v]: [string, any]) => {
    if (v && typeof v === 'object') {
      if (typeof v.name === 'string') return v.name;
      if (v.external) return typeof v.external?.name === 'string' ? v.external.name : key;
    }
    return `${appName}_${key}`;
  });
}

/**
 * Why a custom-named volume of `botId` must be kept, or null when no other
 * instance declares it. The names are derived, so two records can name one
 * volume (a keep-data delete and a reinstall under the same name, a restored
 * record); removing it then destroys the other bot's data.
 */
export function sharedVolumeReason(volume: string, botId: string): string | null {
  const registry = loadRegistry();
  if (brokenRegistryLoads.has(registry)) return `the manager can't confirm no other bot uses it (the instance registry cannot be read)`;
  const others = Object.entries(registry.instances).filter(([id, other]) => id !== botId && other.id !== botId);
  for (const [id, other] of others) {
    if (other.fleetDb?.volume === volume || other.fleetDbReplica?.volume === volume || (other.projectVolumes ?? []).includes(volume)) {
      return `instance ${other.displayName || id} (${id}) uses it`;
    }
  }
  for (const [id, other] of others) {
    const declared = composeVolumeNames(id, other.sanitizedName);
    if (declared === null) return `the manager can't confirm no other bot uses it (the compose of instance ${id} cannot be read)`;
    if (declared.includes(volume)) return `instance ${other.displayName || id} (${id}) declares it in its compose`;
  }
  return null;
}

function recordProjectVolumes(instance: InstanceConfig, declared: string[] | null): void {
  if (declared === null) instance.projectVolumesUnverified = true;
  else instance.projectVolumes = [...new Set([...(instance.projectVolumes ?? []), ...declared])];
}

async function deleteBotImpl(botId: string, keepData: boolean, keepEnv: boolean, confirmFleetData: boolean, confirmPromoted: boolean): Promise<boolean> {
  const instance = getBot(botId);
  if (!instance) return false;
  const refusal = await (await import('../instance/fleetReplica')).instanceRemovalRefusal(instance, keepData, confirmFleetData, confirmPromoted);
  if (refusal) throw new Error(refusal.error);

  const deploymentMode = await getDeploymentMode();
  const appName = resolveAppName(botId);
  const botDir = getBotDir(botId);
  // Resolved and stored before step 1, which can remove the compose file, so a
  // retry after a partial Remove still knows every volume this instance made.
  let ownVolumes: string[] = [];
  let volumesVerified = true;
  if (!keepData) {
    const registry = loadRegistry();
    const record = registry.instances[botId];
    if (record) {
      recordProjectVolumes(record, ownProjectVolumes(botId, appName));
      saveRegistry(registry);
      const claimed = (v: string): boolean => Object.values(registry.instances).some(other =>
        other.id !== botId && ((other.projectVolumes ?? []).includes(v) || v.startsWith(`${other.sanitizedName}_`)));
      ownVolumes = (record.projectVolumes ?? []).filter(v => {
        if (!claimed(v)) return true;
        console.log(`[ContainerManager] Left volume ${v}: another instance uses it`);
        return false;
      });
      volumesVerified = !record.projectVolumesUnverified;
    }
  }

  try {
    writeLane(botId, newLane('delete', instance.status === 'running', keepData));
  } catch (err) {
    throw new Error(laneRecordRefusal('delete', err).error);
  }

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
      const cleanup = await performManualCleanup(appName, !keepData);
      failures.push(...cleanup.failures);
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
    const image = await dockerClient.imageState(imageName);
    if (image === 'unknown') failures.push(`image ${imageName}: docker did not answer, presence unverifiable`);
    if (image === 'exists') {
      console.log(`[ContainerManager] Removing image ${imageName}...`);
      const ok = await dockerClient.removeImage(imageName);
      if (!ok) failures.push(`image ${imageName}: docker rmi reported failure`);
      // Verify the image is actually gone - rmi can return success in some
      // edge cases (force-removed dangling tag) while another tag of the
      // same image keeps it present. Treat lingering image as a failure.
      else if ((await dockerClient.imageState(imageName)) !== 'absent') {
        failures.push(`image ${imageName}: still present or unverifiable after rmi`);
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    failures.push(`image ${imageName}: ${msg}`);
  }

  // 3. Remove named volumes
  if (!keepData) {
    if (!volumesVerified) {
      failures.push(`volumes for ${botId}: a compose file of this instance was unreadable, so its volume list could not be confirmed complete`);
    }
    for (const volumeName of ownVolumes) {
      if (dockerClient.volumeState(volumeName) === 'absent') continue;
      console.log(`[ContainerManager] Removing volume ${volumeName}...`);
      if (!dockerClient.removeVolume(volumeName)) failures.push(`volume ${volumeName}: docker volume rm reported failure`);
    }
    try {
      const others = dockerClient.listProjectVolumes(appName).filter(v => !ownVolumes.includes(v));
      if (others.length) console.log(`[ContainerManager] Left volumes ${others.join(', ')}: they carry the ${appName}_ prefix but are not among this instance's known volumes`);
    } catch { /* informational only */ }
  }

  // 3a. The managed fleet database volume is custom-named too (never project-
  // prefixed, so step 3 misses it - live-proven leak 2026-09-01); the sidecar
  // container is compose-managed and went down with the project in step 1.
  if (instance.fleetDb) {
    await rmContainerTolerant(instance.fleetDb.containerName, failures);
    if (!keepData) {
      const shared = sharedVolumeReason(instance.fleetDb.volume, botId);
      if (shared) failures.push(`database volume ${instance.fleetDb.volume} kept: ${shared}`);
      else if (!dockerClient.removeVolume(instance.fleetDb.volume)) failures.push(`database volume ${instance.fleetDb.volume}: docker volume rm reported failure`);
    }
  }

  // 3b. Standby replica leftovers: its volume is custom-named (never project-
  // prefixed, so step 3 misses it) and a leftover would block any same-name
  // reinstall from provisioning. Deleting the standby also orphans the
  // PRIMARY's replication slot, which retains WAL over there - warn loudly.
  if (instance.fleetDbReplica) {
    await rmContainerTolerant(instance.fleetDbReplica.containerName, failures);
    if (!keepData) {
      const shared = sharedVolumeReason(instance.fleetDbReplica.volume, botId);
      if (shared) failures.push(`replica volume ${instance.fleetDbReplica.volume} kept: ${shared}`);
      else if (!dockerClient.removeVolume(instance.fleetDbReplica.volume)) failures.push(`replica volume ${instance.fleetDbReplica.volume}: docker volume rm reported failure`);
    }
    console.warn(`[ContainerManager] Instance ${botId} hosted a database standby: the PRIMARY at ${instance.fleetDbReplica.primaryHost}:${instance.fleetDbReplica.primaryPort} keeps replication slot ${instance.fleetDbReplica.slot}, which retains WAL until it is dropped there (its Database modal lists the slot with a Drop action once nothing streams on it)`);
  }

  // 3c. Recovery-channel relay: never compose-managed, so nothing else
  // removes it. The peer machine keeps redialing until disarmed there.
  if (instance.recoveryChannel) {
    await rmContainerTolerant(instance.recoveryChannel.containerName, failures);
  }

  // 3d. Derived-name helpers run UNCONDITIONALLY: a helper can outlive its
  // record (a disarm whose rm failed after the record cleared, a seed whose
  // --rm was defeated by a daemon crash), and the remnants gate probes these
  // same names unconditionally - a remnant the delete never retries removing
  // would wedge the delete in error forever.
  await rmContainerTolerant(`${instance.sanitizedName}-fleet-replica-seed`, failures);
  await rmContainerTolerant(`${instance.sanitizedName}-fleet-replica-seed-slot`, failures);
  await rmContainerTolerant(`${instance.sanitizedName}-fleet-replica-seed-slot-drop`, failures);
  await rmContainerTolerant(`${instance.sanitizedName}-fleet-replica-seed-probe`, failures);
  await rmContainerTolerant(`${instance.sanitizedName}-fleet-postgres-replica-data-helper`, failures);
  await rmContainerTolerant(`${instance.sanitizedName}-recovery-rsyncd`, failures);
  await rmContainerTolerant(`${instance.sanitizedName}-recovery-rsync`, failures);

  // 4. Remove instance directory
  if (!keepData) {
    removePathTracked(botDir, `bot directory ${botDir}`, failures);
  } else {
    // Keep the data but remove compose (recreated on reinstall), and the env
    // copies too unless they are kept.
    const doomed = [path.join(botDir, 'docker-compose.yml'), ...(keepEnv ? [] : botEnvCopies(botId))];
    for (const p of doomed) removePathTracked(p, p, failures);
  }

  if (failures.length > 0) {
    // Judge by the goal, not the step results: a retry after a partial delete
    // (or an app someone already removed) hits step errors like "app not
    // found" even though nothing is left to clean, and would otherwise stay
    // stuck in error forever. Only keep the registry entry when something the
    // delete owns actually remains; then the user retains a Delete button to
    // retry against the listed remnants.
    const remnants = await listDeleteRemnants(instance, appName, botDir, keepData, keepEnv, deploymentMode, ownVolumes, volumesVerified);
    if (remnants.length > 0) {
      await stampFailureFromDocker(botId, instance.status);
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
  try {
    const registry = loadRegistry();
    delete registry.instances[botId];
    saveRegistry(registry);
  } catch (err) {
    stampErrorBestEffort(botId);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ContainerManager] Instance ${botId} uninstalled but its record could not be cleared: ${msg}`);
    const removed = keepData
      ? `The containers, image and compose file${keepEnv ? '' : ' and env copies'} were removed (the data and volumes were kept${keepEnv ? ', env values kept' : ''})`
      : 'The containers, image, volumes, bot directory and data were removed';
    throw new Error(`${removed}, but its record could not be cleared: ${msg} Delete it again once the registry can be written.`);
  }
  logCollectors.remove(botId);

  console.log(`[ContainerManager] Instance ${botId} uninstalled cleanly (keepData: ${keepData}, keepEnv: ${keepEnv})`);
  return true;
}

// Alias
export const deleteInstance = deleteBot;

// ─── Status Updates ───

function updateBotStatus(botId: string, status: BotStatus, containerIds?: string[] | null, started = false): void {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (instance) {
    instance.status = status;
    if (started) instance.hasBeenStarted = true;
    // A (re)start means the bot is booting again and its web UI is not reachable
    // until it pings back ready (or the grace period elapses); gate Open on that.
    if (status === 'starting') {
      instance.webUiReady = false;
      instance.lastStartAt = Date.now();
      recordProjectVolumes(instance, ownProjectVolumes(botId, resolveAppName(botId)));
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
        if (broadcastFn) broadcastFn('bot:updated', withoutRecordSecrets(getBot(botId)));
      }, WEBUI_READY_GRACE_MS).unref();
    }
  }
}

/**
 * A status written after a docker step took effect. A refused write never
 * replaces the lane's own answer: the card is told the docker-read status and
 * the refusal comes back for the lane to word.
 */
function recordStatusAfterDockerStep(botId: string, status: BotStatus, containerIds?: string[] | null, started = false): string | null {
  try {
    updateBotStatus(botId, status, containerIds, started);
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ContainerManager] ${botId}: status '${status}' could not be recorded: ${msg}`);
    if (broadcastFn) broadcastFn('bot:status', { id: botId, status, activeOp: isBotBusy(botId) });
    return msg;
  }
}

/**
 * The status a failed lane leaves, read from docker: 'running' while the app
 * container runs, 'error' once it is down, and the status from before the lane
 * when docker does not answer.
 */
async function stampFailureFromDocker(botId: string, statusBefore: BotStatus): Promise<void> {
  let appId: string | null | undefined;
  try {
    appId = await runningAppContainerId(botId, resolveAppName(botId));
  } catch {
    appId = undefined;
  }
  const kept = statusBefore === 'running' || statusBefore === 'stopped' || statusBefore === 'error' ? statusBefore : 'error';
  const status: BotStatus = typeof appId === 'string' ? 'running' : appId === null ? 'error' : kept;
  const ids = typeof appId === 'string' ? (await getContainerIdsForBot(botId).catch(() => null)) ?? undefined : undefined;
  try {
    updateBotStatus(botId, status, ids);
  } catch (err) {
    console.error(`[ContainerManager] ${botId}: status '${status}' could not be recorded: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function stampErrorBestEffort(botId: string): void {
  try {
    updateBotStatus(botId, 'error');
  } catch (err) {
    console.error(`[ContainerManager] ${botId}: status 'error' could not be recorded: ${err instanceof Error ? err.message : String(err)}`);
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

function startedResult(emit: EmitFn, unrecorded: string | null, notApplied: string[]): LaneResult {
  const warnings: string[] = [];
  const retry = notApplied.some(n => !n.includes('press Build')) ? '. Apply or Restart to retry' : '';
  if (notApplied.length > 0) warnings.push(`The bot is running, but these changes were not applied: ${notApplied.join('; ')}${retry}`);
  if (unrecorded) warnings.push(`The bot is running, but its status could not be recorded: ${unrecorded}`);
  for (const w of warnings) emit(`[Warning] ${w}`, 'warning');
  return warnings.length > 0
    ? { success: true, warning: warnings.join('; '), ...(notApplied.length > 0 ? { notApplied } : {}) }
    : { success: true };
}

/**
 * Store which override files a delivery wrote. A build replaces the record with
 * `carry` (the record it started from) plus what it wrote, so a file the build
 * did not rewrite keeps its entry; a start adds to it. Returns why it failed, or null.
 */
function recordDeliveredOverrides(botId: string, report: DeliveryReport, replace: boolean, emit: EmitFn, carry: Record<string, string> = {}): string | null {
  try {
    const record = replace ? carry : configFileManager.getDeliveredOverrides(botId);
    configFileManager.setDeliveredOverrides(botId, { ...record, ...report.delivered });
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit(`[Config] Warning: could not record which config files were delivered (${msg}); a later build keeps them instead of restoring the repo template`, 'warning');
    return msg;
  }
}

/** A build refuses to finish when a bind or config file it authored was not delivered. */
function refuseUndelivered(report: DeliveryReport): void {
  if (report.failed.length === 0) return;
  throw new Error(`${report.failed.length} file(s) not delivered: ${report.failed.join(', ')}. The build stopped there; fix the cause shown in the log above and build again`);
}

function setPendingApply(botId: string, pending: boolean): void {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (!instance || (instance.pendingApply === true) === pending) return;
  if (pending) instance.pendingApply = true;
  else delete instance.pendingApply;
  instance.updatedAt = new Date().toISOString();
  saveRegistry(registry);
}

/**
 * A change to the deployed project made while it runs (a standby attached,
 * whose endpoint the app only learns from a recreated container) is applied
 * the same way a build is: Start on the running instance, or Restart.
 */
export async function markPendingApplyIfRunning(botId: string): Promise<void> {
  const appId = await runningAppContainerId(botId, resolveAppName(botId));
  // An unanswered probe marks too: the apply itself refuses on one, and a
  // mark on an instance that turns out stopped clears at its next start.
  if (appId !== null) setPendingApply(botId, true);
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
export function applyDockerHostPort(composeContent: string, instance: InstanceConfig): string {
  const info = getMainServiceWebPort(composeContent);
  let content = composeContent;
  let webUiPath: string | undefined;
  let publicUrl: string | undefined;
  let hostPort: number | undefined;

  // A running bot publishes its own port; that must not block reusing it on
  // rebuild. Boundary-exact on purpose (no labels reach this sync listing):
  // bare startsWith would claim a sibling whose name this one prefixes.
  const isOwnContainer = (name: string) =>
    name === instance.sanitizedName
    || name === `${instance.sanitizedName}app`
    || name.startsWith(`${instance.sanitizedName}-`)
    || name === `bot-${instance.id}`
    || name.includes(`-${instance.id}-`);
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
      if (allocated !== null && gatewayOnDefaultPassword(content, !!mergedEnvVars(instance)['WEBUI_PASSWORD'])) {
        console.warn(`[Docker] ${instance.sanitizedName}: web UI not published on ${botPortBind()}: its gateway would use the default password; set WEBUI_PASSWORD or APP_DEFAULT_PASSWORD, then rebuild the bot`);
      } else if (allocated !== null) {
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
  const control = getFleetControlService(content);
  const transfer = getFleetTransferService(content);
  let fleetHostPort: number | undefined;
  let transferHostPort: number | undefined;
  if (control !== null) {
    const cp = findAppCapabilities(instance.sourceUrl)?.controlPlane;
    if (BOT_DOMAIN_BASE) {
      content = attachFleetToProxy(content, `${instance.sanitizedName}-fleet.${BOT_DOMAIN_BASE}`, control.port,
        { envAdvertise: cp ? { key: cp.env.publicUrl, scheme: cp.urlScheme.secure } : null, service: control.service });
    }
    // Transfer route: EVERY fleet node advertises one (migration legs dial in
    // either direction), unlike the master-only control route. Only for an app
    // whose compose declares the transfer marker label.
    if (BOT_DOMAIN_BASE && transfer !== null) {
      content = attachFleetToProxy(content, `${instance.sanitizedName}-transfer.${BOT_DOMAIN_BASE}`, transfer.port,
        { envAdvertise: cp?.env.transferUrl ? { key: cp.env.transferUrl, scheme: cp.urlScheme.secure } : null, service: transfer.service });
    }
    const existing = getPublishedFleetHostPort(content, control.port, control.service);
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
        content = publishFleetHostPort(content, allocated, control.port, control.service);
      }
    }
    if (transfer !== null) {
      const existingTransfer = getPublishedFleetHostPort(content, transfer.port, transfer.service);
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
          content = publishFleetHostPort(content, allocated, transfer.port, transfer.service);
        }
      }
    }
  }

  updateInstanceWebAccess(instance.id, hostPort, info ? info.containerPort : undefined, publicUrl, webUiPath, fleetHostPort, transferHostPort);
  return content;
}

/**
 * Write a .env next to the bot's compose so `${VAR}` interpolation and `env_file:`
 * services resolve in docker mode. Mirrors writeComposeEnvFile, but under the
 * manager data dir rather than /DATA. Returns why the write failed, or null.
 */
export function writeDockerEnvFile(botDir: string, env: Record<string, string>): string | null {
  try {
    const lines = Object.entries(env)
      .filter(([k]) => k)
      .map(([k, v]) => `${k}=${formatDotenvValue(v)}`);
    writePrivateFile(path.join(botDir, '.env'), lines.join('\n') + '\n');
    return null;
  } catch (err) {
    console.warn(`[ContainerManager] Failed to write .env file: ${err}`);
    return err instanceof Error ? err.message : String(err);
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
export function writeBotManagerMarker(instance: InstanceConfig, appName: string, isCasaOS: boolean): void {
  // CasaOS: marker lives in the platform AppData folder (folder-reuse detection).
  // Docker: no /DATA; keep the marker inside the bot's own data dir.
  const appDataPath = isCasaOS
    ? path.join(process.env.DATA_ROOT || '/DATA', 'AppData', appName)
    : getBotDir(instance.id);

  // A folder adopted from an earlier instance keeps the record of whose data
  // it held (refuseUnownedStorage admitted only the same source).
  let lineage: BotManagerMarkerLineage[] = [];
  if (isCasaOS) {
    const prior = readBotManagerMarker(appName);
    if (prior.state === 'unreadable') {
      throw new Error(`The .botmanager marker in ${appDataPath} cannot be read (${prior.error}), so it was not replaced`);
    }
    if (prior.state === 'ok') {
      lineage = Array.isArray(prior.marker.lineage) ? prior.marker.lineage : [];
      if (prior.marker.instanceId !== instance.id) {
        lineage = [...lineage, {
          instanceId: prior.marker.instanceId,
          displayName: prior.marker.displayName,
          sourceUrl: prior.marker.sourceUrl ?? null,
          sourceType: prior.marker.sourceType,
          imageRef: prior.marker.imageRef ?? null,
          lastBuildAt: prior.marker.lastBuildAt,
        }];
      }
    }
  }

  const marker: BotManagerMarker = {
      managedBy: 'docker-discord-bot-manager',
      instanceId: instance.id,
      displayName: instance.displayName,
      sanitizedName: instance.sanitizedName,
      sourceUrl: instance.sourceUrl || null,
      sourceType: instance.sourceType || 'git',
      imageRef: instance.imageRef || null,
      createdAt: instance.createdAt,
      lastBuildAt: new Date().toISOString(),
      ...(lineage.length ? { lineage } : {}),
  };
  try {
    writeFileAtomic(path.join(appDataPath, '.botmanager'), JSON.stringify(marker, null, 2));
  } catch (err: any) {
    throw new Error(`Could not write the .botmanager marker in ${appDataPath}: ${err?.message || err}`);
  }
}

export interface BotManagerMarker {
  managedBy: string;
  instanceId: string;
  displayName: string;
  sanitizedName: string;
  sourceUrl: string | null;
  sourceType: string;
  imageRef?: string | null;
  createdAt: string;
  lastBuildAt: string;
  lineage?: BotManagerMarkerLineage[];
}

/** An earlier instance whose data folder this instance adopted. */
export interface BotManagerMarkerLineage {
  instanceId: string;
  displayName: string;
  sourceUrl: string | null;
  sourceType: string;
  imageRef: string | null;
  lastBuildAt: string;
}

export type BotManagerMarkerRead =
  | { state: 'absent' }
  | { state: 'unreadable'; error: string }
  | { state: 'ok'; marker: BotManagerMarker };

/** Read the .botmanager marker from an AppData folder. */
export function readBotManagerMarker(appName: string): BotManagerMarkerRead {
  const dataRoot = process.env.DATA_ROOT || '/DATA';
  const markerPath = path.join(dataRoot, 'AppData', appName, '.botmanager');
  const state = storeFileState(markerPath);
  if (state.kind === 'absent') return { state: 'absent' };
  if (state.kind === 'broken') return { state: 'unreadable', error: state.error };
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.instanceId !== 'string' || !parsed.instanceId) {
      return { state: 'unreadable', error: '.botmanager names no instance' };
    }
    return { state: 'ok', marker: parsed as BotManagerMarker };
  } catch (err: any) {
    return { state: 'unreadable', error: `.botmanager cannot be read (${err?.code || err?.message || err})` };
  }
}

/**
 * Who owns an existing compose project: another instance (a ghost to tear
 * down), this one, nobody (no containers), or unknown (the build refuses).
 */
export async function composeProjectOwner(appName: string, botId: string): Promise<{ kind: 'other'; evidence: string } | { kind: 'self' | 'none' } | { kind: 'unknown'; reason: string }> {
  const read = readBotManagerMarker(appName);
  if (read.state === 'ok') {
    return read.marker.instanceId === botId ? { kind: 'self' } : { kind: 'other', evidence: `marker instanceId=${read.marker.instanceId}` };
  }
  const markerReason = read.state === 'absent' ? 'no .botmanager marker' : read.error;
  let ids: string[];
  try {
    ids = await dockerClient.listProjectBotIds(appName);
  } catch (err: any) {
    return { kind: 'unknown', reason: `${markerReason}, and docker did not list the project's containers (${err?.message || err})` };
  }
  if (ids.length === 0) return { kind: 'none' };
  const other = ids.find(id => id && id !== botId);
  if (other) return { kind: 'other', evidence: `container bot-id=${other}` };
  if (ids.every(id => id === botId)) return { kind: 'self' };
  return { kind: 'unknown', reason: `${markerReason}, and a container of the project carries no bot-id label` };
}

/**
 * Compose projects on this docker host that hold a container of no registered
 * bot, with those containers' names. Throws when docker does not answer, so a
 * name check never reads silence as "no such project".
 */
export async function foreignDockerProjects(registeredIds: Iterable<string>): Promise<Map<string, string[]>> {
  const known = new Set(registeredIds);
  let rows: Array<{ project: string; botId: string; name: string }>;
  try {
    rows = await dockerClient.listComposeContainers();
  } catch (err: any) {
    throw new Error(`docker did not list its compose projects (${err?.message || err}), so the name could not be checked against them`);
  }
  const foreign = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.project || (row.botId && known.has(row.botId))) continue;
    foreign.set(row.project, [...(foreign.get(row.project) ?? []), row.name]);
  }
  return foreign;
}

/**
 * A repo compose that binds $AppID paths: earlier builds resolved $AppID to
 * bot-<id>, so their data is in AppData/bot-<id>, which this build no longer mounts.
 */
export function appIdFolderRefusal(instance: InstanceConfig, rawCompose: string): string | null {
  if (!/\$\{?AppID(?![A-Za-z0-9_])/.test(rawCompose)) return null;
  const dataRoot = process.env.DATA_ROOT || '/DATA';
  const oldDir = path.join(dataRoot, 'AppData', `bot-${instance.id}`);
  if (!fs.existsSync(oldDir)) return null;
  return `This compose binds $AppID paths, which now resolve to ${path.join(dataRoot, 'AppData', instance.sanitizedName)}; the data of earlier builds is in ${oldDir}. Move it there by hand, then build again`;
}

/**
 * Refuses a build that would mount storage this instance does not own: a CasaOS
 * data folder kept from another source, or a volume or data folder that another
 * instance's deployed compose declares. Also refuses an external network that
 * another instance's deployed compose declares.
 */
export function refuseUnownedStorage(instance: InstanceConfig, appName: string, composeContent: string, isCasaOS: boolean): void {
  if (isCasaOS) {
    const refusal = keptFolderRefusal(instance, appName);
    if (refusal) throw new Error(refusal);
  }
  const conflicts = sharedStorageConflicts(instance.id, composeContent);
  if (conflicts.length > 0) throw new Error(`Storage shared with another bot: ${conflicts.join('; ')}`);
  const shared = sharedNetworkConflicts(instance.id, composeContent);
  if (shared.length > 0) throw new Error(`Network shared with another bot: ${shared.join('; ')}`);
}

/**
 * The docker names of the networks a compose joins outside its own project:
 * external ones, and ones with an explicit name. The manager's own shared
 * networks are left out. Null when the compose cannot be parsed.
 */
function namedNetworks(composeContent: string): { external: string[]; named: string[] } | null {
  const parsed = YAML.parseDocument(composeContent);
  if (parsed.errors.length > 0) return null;
  const doc: any = parsed.toJSON();
  const out = { external: [] as string[], named: [] as string[] };
  const nets = doc && typeof doc === 'object' ? doc.networks : null;
  if (!nets || typeof nets !== 'object') return out;
  const platform = platformNetworkNames();
  for (const [key, v] of Object.entries(nets) as Array<[string, any]>) {
    const external = !!(v && typeof v === 'object' && v.external);
    const name = v && typeof v === 'object' && typeof v.name === 'string' ? v.name
      : (external && typeof v.external === 'object' && typeof v.external.name === 'string') ? v.external.name
      : external ? key : null;
    if (name === null || platform.includes(name)) continue;
    (external ? out.external : out.named).push(name);
  }
  return out;
}

/**
 * The external networks this compose would share with another instance's
 * deployed compose: on a shared network a service name such as db or redis
 * answers with both instances' containers. An unreadable compose of another
 * instance is a conflict too, since its networks cannot be checked.
 */
export function sharedNetworkConflicts(botId: string, composeContent: string): string[] {
  const own = namedNetworks(composeContent);
  if (own === null) return ['the compose about to be written cannot be parsed, so its networks could not be checked against other bots'];
  if (own.external.length === 0) return [];
  const conflicts: string[] = [];
  for (const other of Object.values(loadRegistry().instances)) {
    if (other.id === botId) continue;
    const composePath = resolveComposePath(other.id, other.sanitizedName);
    let body: string;
    try {
      body = fs.readFileSync(composePath, 'utf-8');
    } catch (err: any) {
      if (err?.code === 'ENOENT') continue;
      conflicts.push(`${other.displayName}'s compose (${composePath}) cannot be read (${err?.code || err?.message || err}), so its networks could not be checked`);
      continue;
    }
    const theirs = namedNetworks(body);
    if (theirs === null) {
      conflicts.push(`${other.displayName}'s compose (${composePath}) cannot be parsed, so its networks could not be checked`);
      continue;
    }
    for (const n of own.external) {
      if (theirs.external.includes(n) || theirs.named.includes(n)) {
        conflicts.push(`network ${n} is also used by ${other.displayName}; services named db or redis would answer for both bots`);
      }
    }
  }
  return conflicts;
}

/**
 * Where a generated database's password was set when its volume was first
 * initialized: the deployed compose service that mounts that volume. Null when
 * no deployed compose mounts it. Throws when the value cannot be confirmed.
 */
function deployedInitPassword(instance: InstanceConfig, secret: BackingSecret): string | null {
  const dataRoot = process.env.DATA_ROOT || '/DATA';
  const candidates = [
    path.join(getBotDir(instance.id), 'docker-compose.yml'),
    path.join(dataRoot, 'AppData', 'casaos', 'apps', instance.sanitizedName, 'docker-compose.yml'),
  ];
  const cannot = (why: string) => new Error(`Could not confirm the password the ${secret.service} database was created with (${why}); a different password would lock the bot out of it, so the build stopped`);
  for (const file of candidates) {
    let body: string;
    try {
      body = fs.readFileSync(file, 'utf-8');
    } catch (err: any) {
      if (err?.code === 'ENOENT') continue;
      throw cannot(`${file} cannot be read: ${err?.code || err?.message || err}`);
    }
    // failsafe: every scalar stays the text compose read.
    const parsed = YAML.parseDocument(body, { schema: 'failsafe' });
    if (parsed.errors.length > 0) throw cannot(`${file} cannot be parsed`);
    const doc: any = parsed.toJSON();
    const services = doc && typeof doc === 'object' && doc.services && typeof doc.services === 'object' ? doc.services : {};
    for (const svc of Object.values(services) as any[]) {
      const mounts = Array.isArray(svc?.volumes) ? svc.volumes : [];
      const mountsVolume = mounts.some((v: any) => typeof v === 'string'
        ? v.split(':')[0] === secret.volume
        : v && typeof v === 'object' && v.source === secret.volume);
      if (!mountsVolume) continue;
      const env = svc.environment;
      let value: unknown;
      if (Array.isArray(env)) {
        const entry = env.find((e: unknown) => typeof e === 'string' && e.startsWith(`${secret.initEnv}=`));
        value = entry === undefined ? undefined : entry.slice(secret.initEnv!.length + 1);
      } else if (env && typeof env === 'object') {
        value = env[secret.initEnv!];
      }
      if (typeof value !== 'string' || value === '') throw cannot(`${file} sets no ${secret.initEnv}`);
      if (value.replace(/\$\$/g, '').includes('$')) throw cannot(`${file} sets ${secret.initEnv} through a variable`);
      return composeEnvLiteral(value);
    }
  }
  return null;
}

/**
 * The passwords of the generated backing services, on record before the
 * compose is written. A database volume initialized earlier keeps the password
 * its deployed compose set; anything new gets a random password. Throws when
 * an existing volume's password cannot be confirmed.
 */
export function generatedBackingPasswords(instance: InstanceConfig, detection: DetectionResult): { passwords: Record<string, string>; notes: string[] } {
  const needed = generatedBackingSecrets(instance.id, detection);
  if (needed.length === 0) return { passwords: {}, notes: [] };
  const stored = envManager.getBackingPasswords(instance.id);
  const add: Record<string, string> = {};
  const notes: string[] = [];
  for (const secret of needed) {
    if (stored[secret.key]) continue;
    if (secret.initEnv) {
      const existing = deployedInitPassword(instance, secret);
      if (existing !== null) {
        add[secret.key] = existing;
        notes.push(`[Compose] Recorded the password the ${secret.service} database was created with (${secret.initEnv})`);
        continue;
      }
      const volume = `${instance.sanitizedName}_${secret.volume}`;
      const state = dockerClient.volumeState(volume);
      if (state === 'exists') {
        throw new Error(`Volume ${volume} already holds the ${secret.service} database, but the password it was created with is not on record, and a new password would lock the bot out of it. Restore the deployed compose that created it, then build again`);
      }
      if (state === 'unknown') {
        throw new Error(`Could not confirm whether volume ${volume} already holds the ${secret.service} database (docker did not answer), so no new password was set; build again once docker answers`);
      }
    }
    add[secret.key] = crypto.randomBytes(24).toString('base64url');
    notes.push(`[Compose] Generated a password for the ${secret.service} service (${secret.key})`);
  }
  if (Object.keys(add).length > 0) envManager.addBackingPasswords(instance.id, add);
  return { passwords: { ...stored, ...add }, notes };
}

export function keptFolderRefusal(instance: InstanceConfig, appName: string): string | null {
  const folder = path.join(process.env.DATA_ROOT || '/DATA', 'AppData', appName);
  const read = readBotManagerMarker(appName);
  if (read.state === 'absent') return null;
  if (read.state === 'unreadable') {
    return `${folder} holds a .botmanager marker that cannot be read (${read.error}), so whose data the folder holds cannot be checked; repair or remove the marker, then build again`;
  }
  if (read.marker.instanceId === instance.id) return null;
  const source = { sourceUrl: instance.sourceUrl || null, sourceType: instance.sourceType || 'git', imageRef: instance.imageRef || null };
  if (sameSource(read.marker, source)) return null;
  return `${folder} holds data kept from ${describeSource(read.marker)}; this bot is built from ${describeSource(source)}, so it would mount that data and its Remove could delete it`;
}

interface StorageClaims {
  volumes: string[];
  binds: string[];
}

function normalizeHostPath(p: string): string {
  return path.posix.normalize(p.replace(/\\/g, '/')).replace(/\/+$/, '');
}

/** Folders that hold bot data: a bind under one of them is never shared. */
function dataFolderRoots(): string[] {
  const hostRoot = hostBotDirFor('x').replace(/\/x$/, '');
  return [`${normalizeHostPath(process.env.DATA_ROOT || '/DATA')}/AppData/`, `${normalizeHostPath(hostRoot)}/`];
}

/**
 * The storage a compose names outside its own project: explicitly named or
 * external volumes, and bind sources under the data roots. Null when the
 * compose cannot be parsed.
 */
function storageClaims(composeContent: string): StorageClaims | null {
  const parsed = YAML.parseDocument(composeContent);
  if (parsed.errors.length > 0) return null;
  const doc: any = parsed.toJSON();
  const claims: StorageClaims = { volumes: [], binds: [] };
  if (!doc || typeof doc !== 'object') return claims;
  if (doc.volumes && typeof doc.volumes === 'object') {
    for (const [key, v] of Object.entries(doc.volumes) as Array<[string, any]>) {
      if (v && typeof v === 'object' && v.external) {
        claims.volumes.push(typeof v.name === 'string' ? v.name
          : (typeof v.external === 'object' && typeof v.external.name === 'string') ? v.external.name : key);
      } else if (v && typeof v === 'object' && typeof v.name === 'string') {
        claims.volumes.push(v.name);
      }
    }
  }
  const roots = dataFolderRoots();
  for (const service of Object.values(doc.services && typeof doc.services === 'object' ? doc.services : {}) as any[]) {
    for (const vol of Array.isArray(service?.volumes) ? service.volumes : []) {
      let source: string | null = null;
      if (typeof vol === 'string') {
        const parts = vol.split(':');
        if (parts.length > 1) source = parts[0];
      } else if (vol && typeof vol === 'object' && typeof vol.source === 'string' && vol.type !== 'volume') {
        source = vol.source;
      }
      if (!source || !source.startsWith('/')) continue;
      const normalized = normalizeHostPath(source);
      if (roots.some(root => `${normalized}/`.startsWith(root) && `${normalized}/` !== root)) claims.binds.push(normalized);
    }
  }
  return claims;
}

function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * What this compose would share with another instance's deployed compose:
 * a named or external volume, or a bind source under the data roots. An
 * unreadable compose of another instance is a conflict too, since its
 * storage cannot be checked.
 */
export function sharedStorageConflicts(botId: string, composeContent: string): string[] {
  const own = storageClaims(composeContent);
  if (own === null) return ['the compose about to be written cannot be parsed, so its storage could not be checked against other bots'];
  if (own.volumes.length === 0 && own.binds.length === 0) return [];
  const conflicts: string[] = [];
  for (const other of Object.values(loadRegistry().instances)) {
    if (other.id === botId) continue;
    const composePath = resolveComposePath(other.id, other.sanitizedName);
    let body: string;
    try {
      body = fs.readFileSync(composePath, 'utf-8');
    } catch (err: any) {
      if (err?.code === 'ENOENT') continue;
      conflicts.push(`${other.displayName}'s compose (${composePath}) cannot be read (${err?.code || err?.message || err}), so its storage could not be checked`);
      continue;
    }
    const theirs = storageClaims(body);
    if (theirs === null) {
      conflicts.push(`${other.displayName}'s compose (${composePath}) cannot be parsed, so its storage could not be checked`);
      continue;
    }
    for (const v of own.volumes) {
      if (theirs.volumes.includes(v)) conflicts.push(`volume ${v} is already used by ${other.displayName}`);
    }
    for (const b of own.binds) {
      const hit = theirs.binds.find(t => pathsOverlap(b, t));
      if (hit) conflicts.push(`folder ${b} is already used by ${other.displayName} (${hit})`);
    }
  }
  return conflicts;
}

/**
 * The instance's user-configured env: the record's non-sensitive keys plus the
 * env store's SENSITIVE values (post the two-store strip the record never
 * carries a sensitive value, so the store is the only source of secrets at
 * injection time). Only the sensitive store keys merge: a non-sensitive key
 * the store holds alone is a deliberate store-only value (the adopt lane's
 * mode key, per the appCapabilities env.mode contract) that must NOT be baked
 * into the compose. Throws when the store is unreadable or a stored
 * ciphertext no longer decrypts: silently starting a bot without its secrets
 * (and letting the compose sync strip keys a working deploy still carries)
 * would be far worse than refusing with the cause named.
 */
export function mergedEnvVars(instance: InstanceConfig): Record<string, string> {
  const { vars, undecryptable, corrupt } = envManager.getEnvVarsWithStatus(instance.id);
  if (corrupt) {
    throw new Error(`The env store for ${instance.displayName} exists but cannot be read. Repair or replace storage.json (a copy of the damaged file is kept beside it as storage.json.corrupt-<time> when it could be read), or delete storage.json to deliberately start with an empty store and re-enter the values.`);
  }
  if (undecryptable.length > 0) {
    throw new Error(`The encrypted env store for ${instance.displayName} holds values that no longer decrypt (${undecryptable.join(', ')}). The encryption key or salt changed; re-enter them in the env editor.`);
  }
  const sensitive: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    if (envManager.isSensitive(key)) sensitive[key] = value;
  }
  return { ...instance.envVars, ...sensitive };
}

/**
 * The bot's effective env: user-configured vars plus the manager-injected
 * wiring. Used both for per-service compose injection and the deployed .env file.
 */
function buildEffectiveEnv(instance: InstanceConfig): Record<string, string> {
  const internalUrl = process.env.BOT_MANAGER_INTERNAL_URL || `http://discordbotmanagerapp:${process.env.PORT || '8080'}`;
  return {
    ...mergedEnvVars(instance),
    ...fleetEnv(instance),
    BOT_MANAGER_UPDATE_TOKEN: instance.updateToken || '',
    BOT_ID: instance.id,
    BOT_MANAGER_INTERNAL_URL: internalUrl,
  };
}

/**
 * Fleet wiring derived from the deployed compose's marker labels, spelled by
 * the app's capability record: the control-port key whenever the control
 * marker is present; the public-URL key only for a node with a public base;
 * the transfer pair only when the compose also declares the transfer marker
 * (an absent label means the app has one channel). No record = no authored
 * env. Re-derived from the compose so start-time env syncs agree with what
 * the build exposed.
 */
function fleetEnv(instance: InstanceConfig): Record<string, string> {
  try {
    const composePath = path.join(getBotDir(instance.id), 'docker-compose.yml');
    if (!fs.existsSync(composePath)) return {};
    const composeContent = fs.readFileSync(composePath, 'utf-8');
    const controlPort = getFleetControlPort(composeContent);
    if (controlPort === null) return {};
    const env: Record<string, string> = {};
    const cp = findAppCapabilities(instance.sourceUrl)?.controlPlane;
    if (cp) {
      env[cp.env.port] = String(controlPort);
      const transferPort = getFleetTransferPort(composeContent);
      if (transferPort !== null && cp.env.transferPort) env[cp.env.transferPort] = String(transferPort);
      const host = fleetPublicHost(instance.sanitizedName);
      // Advertise the control route only once the built compose actually
      // serves it (same rule as the transfer URL below): a pre-standby worker
      // build restarted after a manager update must not advertise a route no
      // proxy label backs until its rebuild.
      if (host && composeContent.includes(host)) env[cp.env.publicUrl] = `${cp.urlScheme.secure}://${host}`;
      if (transferPort !== null && cp.env.transferUrl) {
        const transferHost = transferPublicHost(instance.sanitizedName);
        // Advertise the public route only once the built compose actually
        // serves it: a pre-transfer build restarted after a manager update
        // must not advertise a route no proxy label backs until its rebuild.
        // No same-box container-name fallback: whether a peer can reach a
        // container name is app topology the manager cannot judge (the old
        // guess read the dial list and diverged from the app's own role
        // resolution). A no-base rig sets the transfer URL by hand; without
        // one the app refuses a migration loudly and names the fix.
        if (transferHost && composeContent.includes(transferHost)) env[cp.env.transferUrl] = `${cp.urlScheme.secure}://${transferHost}`;
      }
    }
    // Local standby hand-off (PLAN_REPLICATION.md Stage 3 consumes it): the
    // bot's promote flow promotes this database first. Credentials are the
    // fleet's own (same database, byte-copied auth); the bot splices them in.
    if (instance.fleetDbReplica) {
      const replica = instance.fleetDbReplica;
      const dbSpec = findAppCapabilities(instance.sourceUrl)?.companionDb;
      // replica.db absent = a record stamped before the identity fields:
      // author nothing rather than guess; the standby needs a re-provision.
      if (dbSpec && replica.db) {
        // no-verify: the byte-copied PGDATA carries the primary's authored
        // pg_hba (non-TLS only from 172.16/12) and ssl=on, so TLS keeps this
        // dialable from any docker subnet (custom address pools included).
        if (dbSpec.env.replicaUrl) env[dbSpec.env.replicaUrl] = `postgresql://${replica.containerName}:5432/${replica.db}?sslmode=no-verify`;
        // What the FLEET dials once this pair is promoted: the same canonical
        // shape the primary publishes, so cross-host workers keep working and
        // the container-name URL above never escapes this machine.
        if (dbSpec.env.replicaPublicUrl) env[dbSpec.env.replicaPublicUrl] = `postgresql://${replica.publicHost}:${replica.hostPort}/${replica.db}?sslmode=no-verify`;
      }
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
function deleteComposeEnv(env: any, key: string): boolean {
  let changed = false;
  if (Array.isArray(env)) {
    for (let i = env.length - 1; i >= 0; i--) {
      if (typeof env[i] === 'string' && env[i].split('=')[0] === key) { env.splice(i, 1); changed = true; }
    }
  } else if (env && typeof env === 'object' && Object.prototype.hasOwnProperty.call(env, key)) {
    delete env[key];
    changed = true;
  }
  return changed;
}

/**
 * Sync current instance env vars into the on-disk compose file before start, so
 * edits made while the bot was stopped take effect without a rebuild. The app
 * service gets the bot's env; any service that already declares USER/PASSWORD (the
 * AppShield gateway) has them refreshed from the current WEBUI_USER/WEBUI_PASSWORD.
 * `privateFile` is for the manager's own bot-dir copy; the CasaOS metadata copy
 * keeps the platform's mode. Returns why the sync failed, or null.
 */
export function syncComposeEnvVars(instance: InstanceConfig, composePath: string, privateFile = false): string | null {
  if (!fs.existsSync(composePath)) return null;

  // Outside the catch-all: an undecryptable store must refuse the start before
  // this rewrites the compose, not degrade into a sync warning.
  const merged = mergedEnvVars(instance);

  try {
    const raw = fs.readFileSync(composePath, 'utf-8');
    const doc = YAML.parseDocument(raw);
    const compose = doc.toJSON();

    const services = compose?.services;
    if (!services || typeof services !== 'object') return null;

    // App service (x-casaos.build, else first non-infra) gets the bot's env, MINUS
    // substitution-only inputs - a repo compose whose first service is a database
    // does not receive the bot's env.
    const targetName = getAppServiceName(compose);
    if (targetName && services[targetName]) {
      const allEnv = buildEffectiveEnv(instance);
      for (const k of SUBSTITUTION_ONLY_ENV) delete allEnv[k];
      for (const k of Object.keys(allEnv)) allEnv[k] = composeEnvValue(allEnv[k]);

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
      // Role or public base may have changed since build: a public-URL or
      // transfer-URL value the build injected must not survive when no longer
      // derivable. Cleanup only reaches keys the RECORD declares (the manager
      // never authors any other app's spelling), and the transfer key only
      // where the transfer marker exists; a pre-label compose keeps its built
      // pins (they still match the routes its own build created) until its
      // rebuild.
      const cpDel = findAppCapabilities(instance.sourceUrl)?.controlPlane;
      if (cpDel) {
        if (!(cpDel.env.publicUrl in allEnv)) deleteComposeEnv(service.environment, cpDel.env.publicUrl);
        if (cpDel.env.transferUrl && !(cpDel.env.transferUrl in allEnv) && getFleetTransferPort(raw) !== null) deleteComposeEnv(service.environment, cpDel.env.transferUrl);
      }
      // The local-replica keys must not survive in a compose once the standby
      // they described is gone: a stale copy would keep pointing the app at a
      // database this machine no longer hosts. Only keys the record declares
      // are ever deleted (the manager authors no other spelling), and a
      // PRE-FIELD standby record (no stamped identity) keeps its built pins:
      // fleetEnv cannot re-author what it cannot derive, and the pins still
      // match the live standby (the transfer-URL precedent from step 3).
      const dbDel = findAppCapabilities(instance.sourceUrl)?.companionDb;
      const preFieldReplica = !!instance.fleetDbReplica && !instance.fleetDbReplica.db;
      if (!preFieldReplica) {
        for (const key of [dbDel?.env.replicaUrl, dbDel?.env.replicaPublicUrl]) {
          if (key && !(key in allEnv)) deleteComposeEnv(service.environment, key);
        }
      }
      compose.services[targetName] = service;
    }

    // AppShield gateway login: refresh any service's EXISTING USER/PASSWORD from the
    // current credentials (so a change while stopped applies on start), and strip the
    // substitution-only inputs from every service. Structural - keyed on the env that
    // exists, never on a bot/image name. Blank credentials leave the compose's shipped
    // login untouched: blanking USER/PASSWORD would disable the gateway's auth.
    const webUser = merged['WEBUI_USER'] || '';
    const webPass = merged['WEBUI_PASSWORD'] || '';
    for (const svc of Object.values(services) as any[]) {
      if (!svc || !svc.environment) continue;
      if (webUser) setComposeEnvIfPresent(svc.environment, 'USER', composeEnvValue(webUser));
      if (webPass) setComposeEnvIfPresent(svc.environment, 'PASSWORD', composeEnvValue(webPass));
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
    // A standby removed while a build wrote its snapshot back must not return
    // on this start; an adopted copy keeps the service key under fleetDb.
    const unrecordedReplica = !!replicaSvc && typeof replicaSvc === 'object' && !instance.fleetDbReplica
      && !(instance.fleetDb && replicaSvc.container_name === instance.fleetDb.containerName);

    capServiceLogs(services);
    let yaml = YAML.stringify(compose, { lineWidth: 0 });
    if (unrecordedReplica) {
      yaml = removeFleetPostgresReplicaService(yaml);
      console.warn(`[ContainerManager] ${instance.id}: the compose named a standby service that no record holds, so it was taken out of the compose; its data volume is kept`);
    }
    if (privateFile) writePrivateFile(composePath, yaml);
    else rewriteComposeFile(composePath, yaml);
    return null;
  } catch (err) {
    console.warn(`[ContainerManager] Failed to sync env vars into compose: ${err}`);
    return String(err);
  }
}

// ─── Start ───

/**
 * True when the instance's APP service container is running. Sidecars (redis,
 * a fronting gateway) outlive a killed app container, so a project-wide check
 * would refuse Start in exactly the crashed case this reconcile exists for.
 * Falls back to any-project-container when the app service cannot be resolved.
 */
/** The instance's running compose containers other than its own fleet sidecar, for an instance with or without one; null when docker did not answer. */
export async function runningInstanceContainers(botId: string): Promise<string[] | null> {
  if (getBot(botId)?.fleetDb) return runningNonSidecarContainers(botId);
  try {
    const { stdout } = await execAsync(
      `docker ps --filter "label=com.docker.compose.project=${resolveAppName(botId)}" --format "{{.Names}}"`);
    return stdout.split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

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

/**
 * The running app container's id: null when none runs, undefined when docker
 * could not answer, which is evidence of nothing.
 */
async function runningAppContainerId(botId: string, appName: string): Promise<string | null | undefined> {
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
    const id = stdout.trim().split('\n')[0]?.trim();
    return id ? id : null;
  } catch {
    return undefined;
  }
}

function containerCountText(ids: string[] | null): string {
  return ids ? `${ids.length} containers` : 'container count unknown: docker did not answer';
}

/** The record as the health and posture readers see it: a 'building' or 'starting' record whose app docker says runs reads as running; unanswered when docker could not say. */
export async function withServingStatus(instance: InstanceConfig): Promise<{ instance: InstanceConfig; unanswered?: true }> {
  const stored = storedStatus(instance);
  if (stored !== 'building' && stored !== 'starting') return { instance };
  const appId = await runningAppContainerId(instance.id, instance.sanitizedName);
  if (appId === undefined) return { instance, unanswered: true };
  return { instance: typeof appId === 'string' ? { ...instance, status: 'running' } : instance };
}

async function hasRunningContainer(botId: string, appName: string): Promise<boolean> {
  // A docker query that failed keeps the conservative refusal.
  return await runningAppContainerId(botId, appName) !== null;
}

/** Every running container of the project, sorted; undefined when docker could not answer. */
async function runningProjectContainerIds(appName: string): Promise<string[] | undefined> {
  try {
    const { stdout } = await execAsync(`docker ps -q --filter "label=com.docker.compose.project=${appName}"`);
    return stdout.trim().split('\n').map(line => line.trim()).filter(Boolean).sort();
  } catch {
    return undefined;
  }
}

/** The Open-button readiness an in-place apply must not reset when it recreated nothing. */
function restoreWebUiReadiness(botId: string, snapshot: { webUiReady?: boolean; lastStartAt?: number }): void {
  const registry = loadRegistry();
  const instance = registry.instances[botId];
  if (!instance) return;
  instance.webUiReady = snapshot.webUiReady;
  instance.lastStartAt = snapshot.lastStartAt;
  instance.updatedAt = new Date().toISOString();
  try {
    saveRegistry(registry);
  } catch (err) {
    console.error(`[ContainerManager] ${botId}: web UI readiness could not be restored: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (broadcastFn) broadcastFn('bot:updated', withoutRecordSecrets(getBot(botId)));
}

export async function startBot(botId: string): Promise<LaneResult> {
  return withLoggedBotOp(botId, 'start', () => startBotImpl(botId));
}

/** The synchronous refusal a start or restart answers before touching anything; null when it may proceed. */
export function startPreflightRefusal(botId: string): { success: false; error: string } | null {
  const rescue = getBot(botId)?.recoveryRescue;
  // The flip's sub-steps run after the copy is filed as the primary: the volume is no longer being rewritten.
  if (rescue && !(rescue.phase === 'flip' && rescue.flipStep)) {
    return { success: false, error: 'A database rescue is rewriting this instance\'s volume; cancel the rescue (or finish the swap) before starting it' };
  }
  const retiringAt = getBot(botId)?.fleetDb?.retiringAt;
  if (retiringAt) return { success: false, error: unfinishedRetireRefusal(retiringAt) };
  return swappedAwayRefusal(botId, 'a start') ?? databaseHoldRefusal(botId, 'Start') ?? deleteLaneRefusal(botId, 'Start');
}

/**
 * A cancelled rescue that left a partial copy or a standby of the sender refuses a start: Postgres would run on files
 * that are not a consistent database, or as a read-only follower of a channel that may be gone. The volume is asked
 * each time, so a volume put right by hand (or by a finished rescue) starts again and the mark is cleared.
 */
export async function rescueLeftoverRefusal(botId: string): Promise<{ success: false; error: string } | null> {
  const instance = getBot(botId);
  const left = instance?.recoveryRescueLeft;
  if (!instance || !left) return null;
  const volume = instance.fleetDb?.volume;
  const day = new Date(left.at).toISOString().slice(0, 10);
  // The probe's docker run would mint an absent volume and read it as clean.
  const volState = volume ? await (await import('../instance/fleetReplica')).dockerVolumeState(volume) : 'exists';
  if (volState === 'absent') {
    return { success: false, error: `A rescue cancelled on ${day} left a mark on this instance, and its database volume ${volume} is gone, so it was not started and the mark is kept: a start would create an empty volume under that name. Decommission this database on its Database modal and provision a new one` };
  }
  if (volState === 'unknown') {
    return { success: false, error: `A rescue cancelled on ${day} left a mark on this instance, and this manager can't confirm whether its database volume ${volume} exists (docker did not answer), so the instance was not started; retry in a moment` };
  }
  const probe = !volume ? { ok: true, out: 'clean' } : await new Promise<{ ok: boolean; out: string }>(resolve => {
    execFile('docker', ['run', '--rm', '-v', `${volume}:/pgdata`, '--entrypoint', 'sh', 'postgres:16-alpine', '-c',
      'if test -f /pgdata/rescue.inprogress; then echo partial; elif test -f /pgdata/standby.signal; then echo standby; else echo clean; fi'],
      { timeout: 60_000 }, (err, stdout, stderr) => resolve({ ok: !err, out: err ? String(stderr || err.message).trim().split('\n').pop() || 'no answer' : String(stdout).trim() }));
  });
  if (probe.ok && probe.out === 'clean') {
    try {
      const registry = loadRegistry();
      const stored = registry.instances[botId];
      if (stored) {
        delete stored.recoveryRescueLeft;
        saveRegistry(registry);
      }
      delete instance.recoveryRescueLeft;
    } catch (err) {
      return { success: false, error: `The volume a rescue cancelled on ${day} left behind is clean again, but that could not be recorded (${errorText(err)}), so the instance was not started; retry` };
    }
    return null;
  }
  const remedy = 'Start a rescue again to finish the copy, or decommission this database on its Database modal and provision a new one';
  if (probe.ok && probe.out === 'partial') {
    return { success: false, error: `A rescue cancelled on ${day} left a partial copy of the sender's database on this instance's volume, so it was not started: Postgres would run on files that are not a consistent database. ${remedy}` };
  }
  if (probe.ok && probe.out === 'standby') {
    return { success: false, error: `A rescue cancelled on ${day} left this instance's database as a standby of the sender (read-only, following a channel that may be gone), so it was not started. ${remedy}` };
  }
  return { success: false, error: `A rescue cancelled on ${day} may have left a partial copy on this instance's volume, and docker could not check it (${probe.ok ? `it answered '${probe.out}'` : probe.out}), so the instance was not started; retry in a moment` };
}

const COPY_BLOCK_RETRACT_LOCK_WAIT_MS = 30 * 60_000;

/** A recorded copy-block retraction reaches the app once its hooks answer after a start; a miss stays recorded. */
async function sendCopyBlockRetract(botId: string): Promise<void> {
  try {
    // Imported here: appLifecycle imports this module.
    const lifecycle = await import('../instance/appLifecycle');
    const instance = getBot(botId);
    if (!instance) return;
    const up = await lifecycle.waitForAppHook(instance, 90_000);
    if (!up.success) return;
    // The lane that started the bot, or one that took the lock after it, may still hold it.
    const until = Date.now() + COPY_BLOCK_RETRACT_LOCK_WAIT_MS;
    while (isBotBusy(botId) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 1000).unref());
    const settled = await lifecycle.settleCopyBlockRetract(botId);
    if (settled.pending) console.warn(`[Start] ${instance.displayName}: the copy-block retraction is still pending (${settled.reason}); the next start or opening its Database modal sends it again`);
  } catch (err) {
    console.warn(`[Start] the copy-block retraction for ${botId} could not be sent: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function startBotImpl(botId: string): Promise<LaneResult> {
  const instance = getBot(botId);
  if (!instance) return { success: false, error: 'Bot not found' };
  const rescueRefusal = startPreflightRefusal(botId) ?? await rescueLeftoverRefusal(botId);
  if (rescueRefusal) return rescueRefusal;
  let statusBefore = instance.status;
  let applyInPlace: { projectIds: string[] | undefined; webUiReady?: boolean; lastStartAt?: number } | null = null;
  if (instance.status === 'running') {
    // Reconcile against live container state: an externally-stopped bot
    // (docker kill, OOM) leaves the registry claiming running, and Start
    // would refuse forever while the container sits Exited.
    const appId = await runningAppContainerId(botId, instance.sanitizedName);
    if (appId !== null) {
      // A build that finished while the project ran left its compose and
      // image unapplied; compose up on the live project applies them and
      // recreates only what changed, so this is the one start that proceeds
      // on a running instance. Only on a concrete answer: an unanswered
      // probe is evidence of nothing, and compose could not act on it either.
      if (appId === undefined) return { success: false, error: 'Docker could not confirm whether the bot is running; retry in a moment' };
      if (instance.pendingApply !== true) return { success: false, error: 'Bot is already running' };
      applyInPlace = {
        projectIds: await runningProjectContainerIds(instance.sanitizedName),
        webUiReady: instance.webUiReady,
        lastStartAt: instance.lastStartAt,
      };
      logCollectors.get(botId).addLog('[Start] Applying the last build to the running project; only containers whose definition changed are recreated', 'info');
    } else {
      console.warn(`[ContainerManager] ${botId} marked running but no container is up; correcting to stopped`);
      recordStatusAfterDockerStep(botId, 'stopped');
      statusBefore = 'stopped';
    }
  }

  const sourceType = instance.sourceType || 'git';
  const result = sourceType === 'docker-image' ? await startDockerImageBot(instance, statusBefore) : await startGitBot(instance, statusBefore);
  // Any successful start deploys the current compose and image, whichever way
  // the project was reached (Restart, Stop then Start, Update).
  if (result.success) {
    try {
      setPendingApply(botId, !!result.notApplied);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      const msg = result.notApplied
        ? `The changes listed as not applied could not be recorded as pending, so this instance may not offer to apply them: ${why}`
        : `The deployed build is applied, but that could not be recorded: ${why}`;
      logCollectors.get(botId).addLog(`[Start] ${msg}`, 'warning');
      result.warning = result.warning ? `${result.warning}; ${msg}` : msg;
    }
    const laneUncleared = clearFinishedLane(botId);
    if (laneUncleared) result.warning = result.warning ? `${result.warning}; ${laneUncleared}` : laneUncleared;
    if (getBot(botId)?.fleetDb?.replication?.keptPlain?.length) {
      // Imported here: fleetReplication imports this module.
      const narrowed = await (await import('../instance/fleetReplication')).narrowKeptPlainHba(botId).catch(err => `pg_hba could not be narrowed: ${err instanceof Error ? err.message : String(err)}`);
      if (narrowed) {
        logCollectors.get(botId).addLog(`[Start] ${narrowed}`, 'warning');
        result.warning = result.warning ? `${result.warning}; ${narrowed}` : narrowed;
      }
    }
    if (getBot(botId)?.fleetDb) {
      // Imported here: fleetBackup imports this module.
      const fenced = await (await import('../instance/fleetBackup')).fenceStartWarning(botId).catch(() => null);
      if (fenced) {
        logCollectors.get(botId).addLog(`[Start] ${fenced}`, 'warning');
        result.warning = result.warning ? `${result.warning}; ${fenced}` : fenced;
      }
    }
    if (getBot(botId)?.copyBlockRetract) void sendCopyBlockRetract(botId);
  }
  if (!applyInPlace) return result;

  // The lane stamps 'starting' before compose up, which gates the Open button
  // until the app pings back; a project compose left whole never pings again,
  // so its readiness is put back. Keyed on every container of the project, not
  // the app service alone: the web-facing service may be a different one.
  const projectAfter = async (): Promise<'same' | 'changed' | 'unknown'> => {
    const after = await runningProjectContainerIds(instance.sanitizedName);
    if (!applyInPlace?.projectIds || !after) return 'unknown';
    return after.join(',') === applyInPlace.projectIds.join(',') ? 'same' : 'changed';
  };
  if (result.success) {
    if (await projectAfter() === 'same') restoreWebUiReadiness(botId, applyInPlace);
    return result;
  }
  const appId = await runningAppContainerId(botId, instance.sanitizedName);
  if (typeof appId === 'string') {
    recordStatusAfterDockerStep(botId, 'running', (await getContainerIdsForBot(botId)) ?? undefined);
    const project = await projectAfter();
    logCollectors.get(botId).addLog(project === 'same'
      ? '[Start] The apply failed; the previous build keeps running and the new one stays unapplied'
      : project === 'changed'
        ? '[Start] The apply failed after recreating some of the project; it keeps running, and Start applies whatever is still pending'
        : '[Start] The apply failed; the project keeps running, and docker could not say whether any of its containers were recreated first', 'warning');
    if (project === 'same') restoreWebUiReadiness(botId, applyInPlace);
  } else if (appId === undefined) {
    logCollectors.get(botId).addLog('[Start] The apply failed, and docker could not say whether the previous build still runs', 'warning');
  }
  return result;
}

async function startGitBot(instance: InstanceConfig, statusBefore: BotStatus): Promise<LaneResult> {
  const botId = instance.id;
  const log = logCollectors.get(botId);

  const emit: EmitFn = (msg, type = 'info', key) => {
    console.log(`[Start ${botId}] ${msg}`);
    log.addLog(msg, type, key);
  };
  let unrecorded: string | null = null;
  const notApplied: string[] = [];

  try {
    emit(`[Start] Starting ${instance.displayName}...`, 'system');

    const latestInstance = getBot(botId) || instance;
    const botDir = getBotDir(botId);
    const localComposePath = path.join(botDir, 'docker-compose.yml');

    const imageMissing = fs.existsSync(localComposePath) && (await builtImageMissing(latestInstance, localComposePath));
    if (!fs.existsSync(localComposePath) || imageMissing) {
      emit(imageMissing ? '[Build] The bot image is missing, running build first...' : '[Build] No compose file found, running build first...', 'info');
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
      const envErr = syncComposeEnvVars(latestInstance, composePath);
      if (envErr) notApplied.push(`environment variables (${envErr})`);
      try {
        await writeComposeEnvFile(appName, buildEffectiveEnv(latestInstance), (msg) => emit(msg, 'info'));
      } catch (err) {
        notApplied.push(`the .env file (${err instanceof Error ? err.message : String(err)})`);
      }

      // Re-apply edited config files so config changes made while stopped take
      // effect on start (mirrors the env re-sync above). Binds already exist from
      // the build, so this only rewrites the bind-mounted host files.
      await reapplyConfigFilesCasaOS(botId, appName, composePath, emit, notApplied);

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

      let postInstallFailed = false;
      // The registry's hasBeenStarted rides the running stamp; this file keeps the fact when that stamp is refused.
      const postInstallMark = path.join(botDir, 'post-install.done');
      if (!latestInstance.hasBeenStarted && !fs.existsSync(postInstallMark)) {
        const composeContent = fs.readFileSync(composePath, 'utf-8');
        postInstallFailed = !(await executeInstallCommand('post', composeContent, (msg) => emit(msg, 'info')));
        if (!postInstallFailed) {
          try {
            fs.writeFileSync(postInstallMark, new Date().toISOString());
          } catch (err) {
            emit(`[Start] Could not write ${postInstallMark} (${err instanceof Error ? err.message : String(err)}); if the status below is not recorded either, the post-install command runs again at the next start`, 'warning');
          }
        }
      }

      const containerIds = await getContainerIdsForBot(botId);
      unrecorded = recordStatusAfterDockerStep(botId, 'running', containerIds ?? undefined, !postInstallFailed);
      if (postInstallFailed) notApplied.push('the post-install command (it runs again at the next start)');
      emit(`[Done] Bot deployed (${containerCountText(containerIds)})`, 'success');
    } else {
      const composePath = path.join(botDir, 'docker-compose.yml');

      // Sync env into the compose (covers post-build env edits) + a .env file for
      // ${VAR} / env_file services, then deploy the full compose (multi-service).
      const envErr = syncComposeEnvVars(latestInstance, composePath, true);
      if (envErr) notApplied.push(`environment variables (${envErr})`);
      const dotenvErr = writeDockerEnvFile(botDir, buildEffectiveEnv(latestInstance));
      if (dotenvErr) notApplied.push(`the .env file (could not be written: ${dotenvErr}; compose read the .env already there, if any)`);

      // Re-apply edited config files so changes made while stopped take effect.
      reapplyConfigFilesDocker(botId, botDir, composePath, emit, notApplied);

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
      unrecorded = recordStatusAfterDockerStep(botId, 'running', containerIds ?? undefined, true);
      emit(`[Done] Bot deployed (${containerCountText(containerIds)})`, 'success');
    }

    emit(`[Success] ${instance.displayName} is now running!`, 'success');
    return startedResult(emit, unrecorded, notApplied);
  } catch (error) {
    const msg = String(error);
    emit(`[Error] Start failed: ${msg}`, 'error');
    emit('[Fatal] Start process terminated with error', 'error');
    console.error(`[ContainerManager] Failed to start instance ${botId}:`, error);
    await stampFailureFromDocker(botId, statusBefore);
    return { success: false, error: msg };
  }
}

/**
 * Config files for the start-path re-apply. A broken store skips the rewrite
 * loudly instead of rewriting real host configs to '': the previously
 * delivered files stay in place as the last-known-good config, so the start
 * can proceed. The build lanes, which author the host files fresh, refuse
 * instead (getConfigFilesStrict).
 */
function reapplyableConfigFiles(botId: string, emit: EmitFn, notApplied: string[]): configFileManager.BotConfigFile[] {
  const { files, undecryptable, corrupt } = configFileManager.getConfigFilesWithStatus(botId);
  if (corrupt) {
    emit('[Config] The config-file store cannot be read (a copy of the damaged file is kept beside it as configFiles.json.corrupt-<time> when it could be read); keeping the previously delivered config files', 'warning');
    notApplied.push('config files (the config-file store cannot be read)');
    return [];
  }
  const enabled = files.filter(c => c.enabled !== false);
  const blocking = enabled.filter(f => undecryptable.includes(f.path));
  if (blocking.length > 0) {
    emit(`[Config] Stored config file bodies no longer decrypt (${blocking.map(f => f.path).join(', ')}); keeping the previously delivered config files`, 'warning');
    notApplied.push(`config files (${blocking.map(f => f.path).join(', ')} no longer decrypt)`);
    return [];
  }
  return enabled;
}

function noteUndelivered(report: DeliveryReport, emit: EmitFn, notApplied: string[]): void {
  if (report.unbound.length > 0) notApplied.push(`config files not mounted yet (press Build, then Restart, to mount): ${report.unbound.join(', ')}`);
  if (report.failed.length === 0) return;
  emit(`[Config] Warning: ${report.failed.length} config file(s) not re-applied: ${report.failed.join(', ')}`, 'warning');
  notApplied.push(`config files (${report.failed.length} not delivered: ${report.failed.join(', ')})`);
}

/** A start never edits the compose: a mount added, removed or flipped since the last build waits for Update. */
function noteMountsChanged(botId: string, notApplied: string[]): void {
  const { files, corrupt } = configFileManager.getConfigFilesWithStatus(botId);
  if (corrupt) return;
  let built: string[] | null;
  try { built = configFileManager.getBuiltMounts(botId); } catch (err) {
    notApplied.push(`config file mounts (can't confirm they match the last build: ${err instanceof Error ? err.message : String(err)}; press Build, then Restart)`);
    return;
  }
  if (built === null) {
    if (!configFileManager.hasConfigStore(botId)) return;
    notApplied.push('config file mounts (no record of the mounts the last build authored; press Build, then Restart, to be sure)');
    return;
  }
  const now = files.filter(f => f.enabled !== false).map(configFileManager.mountKey).sort();
  if (now.join('\n') !== [...built].sort().join('\n')) notApplied.push('config file mounts changed since the last build (press Build, then Restart)');
}

/** A build in progress or failed leaves no record, so the next start reads "no record" until a build finishes. */
function forgetBuiltMounts(botId: string): void {
  configFileManager.clearBuiltMounts(botId);
}

/** Store the config file mounts a build authored, for noteMountsChanged at the next start. */
function recordBuiltMounts(botId: string, configFiles: configFileManager.BotConfigFile[], emit: EmitFn): void {
  try { configFileManager.setBuiltMounts(botId, configFiles.map(configFileManager.mountKey)); }
  catch (err) { emit(`[Config] Warning: could not record the config file mounts of this build (${err}); the next start can't confirm they are current`, 'warning'); }
}

async function reapplyConfigFilesCasaOS(botId: string, appName: string, composePath: string, emit: EmitFn, notApplied: string[]): Promise<void> {
  noteMountsChanged(botId, notApplied);
  const cfgFiles = reapplyableConfigFiles(botId, emit, notApplied);
  if (cfgFiles.length === 0) return;
  const report = newDeliveryReport();
  try {
    emit(`[Config] Re-applying ${cfgFiles.length} config file(s)`, 'info');
    await redeliverConfigFiles(fs.readFileSync(composePath, 'utf-8'), appName, cfgFiles, (msg) => emit(msg, 'info'), report, configFileManager.getDeliveredOverrides(botId));
  } catch (err) {
    emit(`[Config] Warning: could not re-apply config files: ${err}`, 'warning');
    notApplied.push(`config files (${err})`);
  }
  noteUndelivered(report, emit, notApplied);
  recordDeliveredOverrides(botId, report, false, emit);
}

function reapplyConfigFilesDocker(botId: string, botDir: string, composePath: string, emit: EmitFn, notApplied: string[]): void {
  noteMountsChanged(botId, notApplied);
  const cfgFiles = reapplyableConfigFiles(botId, emit, notApplied);
  if (cfgFiles.length === 0 || !fs.existsSync(composePath)) return;
  const report = newDeliveryReport();
  try {
    emit(`[Config] Re-applying ${cfgFiles.length} config file(s)`, 'info');
    redeliverDockerConfigFiles(fs.readFileSync(composePath, 'utf-8'), botDir, hostBotDirFor(botId), cfgFiles, report, configFileManager.getDeliveredOverrides(botId), (msg) => emit(msg, 'info'));
  } catch (err) {
    emit(`[Config] Warning: could not re-apply config files: ${err}`, 'warning');
    notApplied.push(`config files (${err})`);
  }
  noteUndelivered(report, emit, notApplied);
  recordDeliveredOverrides(botId, report, false, emit);
}

// A compose written before the log caps existed gets them on its next start; the file is rewritten only when a cap
// was added, and keeps the mode it has.
function capComposeFileLogs(composePath: string): void {
  if (!fs.existsSync(composePath)) return;
  try {
    const compose = YAML.parseDocument(fs.readFileSync(composePath, 'utf-8')).toJSON();
    const services = compose?.services;
    if (!services || typeof services !== 'object') return;
    const before = JSON.stringify(services);
    capServiceLogs(services);
    if (JSON.stringify(services) !== before) rewriteComposeFile(composePath, YAML.stringify(compose, { lineWidth: 0 }));
  } catch (err) {
    console.warn(`[ContainerManager] Failed to cap container logs in compose: ${err}`);
  }
}

async function startDockerImageBot(instance: InstanceConfig, statusBefore: BotStatus): Promise<LaneResult> {
  const botId = instance.id;
  const log = logCollectors.get(botId);

  const emit: EmitFn = (msg, type = 'info', key) => {
    console.log(`[Start ${botId}] ${msg}`);
    log.addLog(msg, type, key);
  };

  if (!instance.imageRef) {
    return { success: false, error: 'imageRef is required for docker-image source type' };
  }
  let unrecorded: string | null = null;
  const notApplied: string[] = [];

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
      capComposeFileLogs(composePath);

      const latestInstance = getBot(botId) || instance;
      const envErr = syncComposeEnvVars(latestInstance, composePath);
      if (envErr) notApplied.push(`environment variables (${envErr})`);
      try {
        await writeComposeEnvFile(appName, buildEffectiveEnv(latestInstance), (msg) => emit(msg, 'info'));
      } catch (err) {
        notApplied.push(`the .env file (${err instanceof Error ? err.message : String(err)})`);
      }

      emit(`[Start] Starting containers (${appName})...`, 'info');
      updateBotStatus(botId, 'starting');

      // Re-apply edited config files so config changes take effect on start.
      await reapplyConfigFilesCasaOS(botId, appName, composePath, emit, notApplied);

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
      unrecorded = recordStatusAfterDockerStep(botId, 'running', containerIds ?? undefined, true);
      emit(`[Done] Bot deployed (${containerCountText(containerIds)})`, 'success');
    } else {
      const composePath = path.join(botDir, 'docker-compose.yml');
      const envErr = syncComposeEnvVars(instance, composePath, true);
      if (envErr) notApplied.push(`environment variables (${envErr})`);
      const dotenvErr = writeDockerEnvFile(botDir, buildEffectiveEnv(instance));
      if (dotenvErr) notApplied.push(`the .env file (could not be written: ${dotenvErr}; compose read the .env already there, if any)`);

      reapplyConfigFilesDocker(botId, botDir, composePath, emit, notApplied);

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
      unrecorded = recordStatusAfterDockerStep(botId, 'running', containerIds ?? undefined, true);
      emit(`[Done] Bot deployed (${containerCountText(containerIds)})`, 'success');
    }

    emit(`[Success] ${instance.displayName} is now running!`, 'success');
    return startedResult(emit, unrecorded, notApplied);
  } catch (error) {
    const msg = String(error);
    emit(`[Error] Start failed: ${msg}`, 'error');
    emit('[Fatal] Start process terminated with error', 'error');
    console.error(`[ContainerManager] Failed to start docker-image instance ${botId}:`, error);
    await stampFailureFromDocker(botId, statusBefore);
    return { success: false, error: msg };
  }
}

// ─── Container ID Resolution ───

/**
 * Ownership by label first, name shapes last: name.startsWith(appName) is
 * substring matching, so "fmdbworker" would claim "fmdbworker2app". A bot-id
 * or compose-project label is authoritative either way it points; the name
 * arms remain only for containers from before either label was stamped.
 */
function ownedBotContainers(containers: ContainerInfo[], botId: string, appName: string): ContainerInfo[] {
  return containers.filter(c => {
    if (c.botId) return c.botId === botId;
    if (c.project) return c.project === appName || c.project === `bot-${botId}`;
    return c.name.startsWith(appName) || c.name.includes(`-${botId}-`);
  });
}

/** The bot's container ids; null when docker did not answer the listing. */
async function getContainerIdsForBot(botId: string): Promise<string[] | null> {
  const containers = await dockerClient.listBotContainers();
  if (!containers) return null;
  const appName = resolveAppName(botId);
  return ownedBotContainers(containers, botId, appName).map(c => c.id);
}

// ─── Stop ───

export async function stopBot(botId: string): Promise<LaneResult> {
  return withBotOp(botId, 'stop', async () => {
    const result = await stopBotImpl(botId);
    return result.success ? withWarning(result, clearFinishedLane(botId)) : result;
  });
}

/** Stop for a caller that already holds this instance's op lock under op (withExternalBotOp); refuses when it does not. */
export async function stopBotInOp(botId: string, op: string): Promise<LaneResult> {
  if (activeOps.get(botId) !== op) return { success: false, error: `the stop must run under the '${op}' operation, which is not held` };
  const result = await stopBotImpl(botId);
  return result.success ? withWarning(result, clearFinishedLane(botId)) : result;
}

async function stopBotImpl(botId: string, emit?: EmitFn): Promise<LaneResult> {
  const instance = getBot(botId);
  if (!instance) return { success: false, error: 'Bot not found' };
  if (instance.status !== 'running') return { success: false, error: 'Bot is not running' };

  try {
    updateBotStatus(botId, 'stopping');

    const deploymentMode = await getDeploymentMode();
    const appName = resolveAppName(botId);
    emit?.(`[Stop] Stopping containers (${appName})...`, 'info');
    let downError: string | null = null;

    if (deploymentMode === 'casaos') {
      const composePath = resolveComposePath(botId, appName);
      const downResult = await casaosApi.composeDown(
        appName,
        composePath,
        emit ? (msg, key) => emit(`[Compose] ${msg}`, 'info', key) : undefined
      );
      if (!downResult.success) {
        downError = String(downResult.error);
        console.warn(`[ContainerManager] Compose down failed for ${appName}: ${downResult.error}`);
        emit?.(`[Stop] Warning: compose down failed: ${downResult.error}`, 'warning');
      }
    } else {
      const composePath = path.join(getBotDir(botId), 'docker-compose.yml');
      if (fs.existsSync(composePath)) {
        try {
          await dockerClient.composeDown(composePath, appName);
        } catch (err) {
          downError = err instanceof Error ? err.message : String(err);
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
            downError = err instanceof Error ? err.message : String(err);
            console.warn(`[ContainerManager] Failed to stop container ${containerId}:`, err);
          }
        }
      }
    }

    const survivors = await runningProjectContainerIds(appName);
    if (survivors === undefined && downError !== null) {
      const unrecorded = recordStatusAfterDockerStep(botId, 'running');
      const error = `The stop failed (${downError}) and docker could not confirm whether the containers still run${unrecorded ? `; the status could not be recorded: ${unrecorded}` : ''}`;
      emit?.(`[Stop] ${error}`, 'error');
      return { success: false, error };
    }
    if (survivors && survivors.length > 0) {
      const unrecorded = recordStatusAfterDockerStep(botId, 'running', (await getContainerIdsForBot(botId)) ?? undefined);
      const error = `The stop failed: ${survivors.length} container${survivors.length === 1 ? '' : 's'} of the project still run${downError ? ` (${downError})` : ''}${unrecorded ? `; the status could not be recorded: ${unrecorded}` : ''}`;
      emit?.(`[Stop] ${error}`, 'error');
      return { success: false, error };
    }
    const unrecorded = recordStatusAfterDockerStep(botId, 'stopped', []);
    if (survivors === undefined) {
      const warning = `The stop finished, but docker could not confirm that no container still runs${unrecorded ? `; the status could not be recorded: ${unrecorded}` : ''}`;
      emit?.(`[Stop] Warning: ${warning}`, 'warning');
      return { success: true, warning };
    }
    emit?.('[Stop] Containers stopped', 'info');
    if (unrecorded) {
      const warning = `The containers were stopped, but the status could not be recorded: ${unrecorded}`;
      emit?.(`[Stop] Warning: ${warning}`, 'warning');
      return { success: true, warning };
    }
    return { success: true };
  } catch (error) {
    console.error(`[ContainerManager] Failed to stop instance ${botId}:`, error);
    await stampFailureFromDocker(botId, 'running');
    return { success: false, error: String(error) };
  }
}

// ─── Restart ───

export async function restartBot(botId: string): Promise<LaneResult> {
  return withLoggedBotOp(botId, 'restart', async () => {
    const rescueRefusal = startPreflightRefusal(botId) ?? await rescueLeftoverRefusal(botId);
    if (rescueRefusal) return rescueRefusal;
    try {
      writeLane(botId, newLane('restart', true));
    } catch (err) {
      return laneRecordRefusal('restart', err);
    }
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

export async function pullAndRebuild(botId: string): Promise<LaneResult> {
  return withLoggedBotOp(botId, 'update', () => pullAndRebuildImpl(botId));
}

async function pullAndRebuildImpl(botId: string): Promise<LaneResult> {
  const instance = getBot(botId);
  if (!instance) return { success: false, error: 'Bot not found' };
  const storeRefusal = updatePreflightRefusal(botId);
  if (storeRefusal) return storeRefusal;
  // Same preflight for a deployment-mode change: the build refuses on it, and
  // this lane must not stop the bot and delete its image on the way there.
  const modeRefusal = await modeMismatchRefusal(instance);
  if (modeRefusal) {
    return { success: false, error: modeRefusal };
  }
  return pullAndRebuildAfterPreflight(botId, instance);
}

/** The synchronous store checks an update refuses on, before anything destructive; null when it may proceed. */
export function updatePreflightRefusal(botId: string): { success: false; error: string } | null {
  // Preflight before anything destructive: the rebuild's env assembly refuses
  // on a broken store, and by then this lane has already stopped the bot and
  // deleted its image - turning a working deployment into an unstartable one.
  const envStatus = envManager.getEnvVarsWithStatus(botId);
  if (envStatus.corrupt) {
    return { success: false, error: 'The env store for this instance cannot be read (a copy is kept beside it as storage.json.corrupt-<time> when it could be read); restore it before updating' };
  }
  if (envStatus.undecryptable.length > 0) {
    return { success: false, error: `The env store holds values that no longer decrypt (${envStatus.undecryptable.join(', ')}); re-enter them or restore the encryption key before updating` };
  }
  // Same preflight for the config-file store: the rebuild's delivery refuses
  // on it (getConfigFilesStrict), and a running bot must not be stopped and
  // stripped of its image on the way to that refusal.
  const cfgStatus = configFileManager.getConfigFilesWithStatus(botId);
  if (cfgStatus.corrupt) {
    return { success: false, error: 'The config-file store for this instance cannot be read (a copy is kept beside it as configFiles.json.corrupt-<time> when it could be read); repair or replace it before updating' };
  }
  const cfgBroken = cfgStatus.files.filter(f => f.enabled !== false && cfgStatus.undecryptable.includes(f.path)).map(f => f.path);
  if (cfgBroken.length > 0) {
    return { success: false, error: `Stored config file bodies no longer decrypt (${cfgBroken.join(', ')}); re-enter them in the config editor or restore the encryption key before updating` };
  }
  return swappedAwayRefusal(botId, 'an update') ?? databaseHoldRefusal(botId, 'Update') ?? databaseRunRefusal(botId, 'updating') ?? deleteLaneRefusal(botId, 'Update');
}

/** Fetches a git instance's source and checks its clone before an update stops anything; the refusal text, or null. */
async function sourceClonePreflight(instance: InstanceConfig): Promise<string | null> {
  const kept = 'the bot was not stopped and its image was kept';
  if (!instance.sourceId) return `Update refused: this instance has no source; ${kept}`;
  const source = sourceManager.getSource(instance.sourceId);
  if (!source) return `Update refused: the source of this instance was not found; ${kept}`;
  try {
    await sourceManager.fetchSource(instance.sourceId);
  } catch (err: any) {
    const why = sourceManager.withoutCredential(String(err?.message || err), source.url);
    return `Update refused: the source could not be fetched (${why}); ${kept}`;
  }
  if (!fs.existsSync(path.join(sourceManager.getSourceRepoPath(instance.sourceId), '.git'))) {
    return `Update refused: the source has no usable clone; ${kept}`;
  }
  return null;
}

async function pullAndRebuildAfterPreflight(botId: string, instance: InstanceConfig): Promise<LaneResult> {
  // An update or restart that a manager restart cut short owed a start.
  const prior = instance.lane;
  const owedStart = (prior?.op === 'update' || prior?.op === 'restart') && prior.wasRunning;
  const wasRunning = instance.status === 'running' || owedStart;
  const retiringAt = (getBot(botId) ?? instance).fleetDb?.retiringAt;
  if (wasRunning && retiringAt) return { success: false, error: `${unfinishedRetireRefusal(retiringAt)}. The update was refused before the bot was stopped` };
  const log = logCollectors.get(botId);
  const emit: EmitFn = (msg, type = 'info', key) => {
    console.log(`[Update ${botId}] ${msg}`);
    log.addLog(msg, type, key);
  };

  try {
    emit(`[Update] Updating ${instance.displayName}...`, 'system');
    if (instance.sourceType !== 'docker-image') {
      const cloneRefusal = await sourceClonePreflight(instance);
      if (cloneRefusal) {
        emit(`[Error] ${cloneRefusal}`, 'error');
        return { success: false, error: cloneRefusal };
      }
    }
    try {
      writeLane(botId, newLane('update', wasRunning));
    } catch (err) {
      return laneRecordRefusal('update', err);
    }
    if (owedStart) emit('[Update] An earlier update or restart of this running bot did not finish; it is started again after this build', 'warning');
    if (instance.status === 'running') {
      const stopResult = await stopBotImpl(botId, emit);
      if (!stopResult.success) return { success: false, error: `Update stopped before rebuilding: ${stopResult.error}` };
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

    return withWarning(buildResult.warning ? { success: true, warning: buildResult.warning } : { success: true }, clearFinishedLane(botId));
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

/**
 * The deployment mode an instance's DEPLOYED compose was authored under, read
 * back from where its binds point: docker mode roots them at the manager's own
 * host bot dir, CasaOS mode at the platform's AppData folder. Null when there is
 * no compose yet, or no bind that identifies either shape.
 *
 * The docker test must run FIRST: on a CasaOS-style host the manager's own data
 * dir lives under AppData too, so a docker-mode bind matches both prefixes and
 * only the more specific one tells the truth.
 */
function deployedBindMode(instance: InstanceConfig): DeploymentMode | null {
  const composePath = path.join(getBotDir(instance.id), 'docker-compose.yml');
  let doc: any;
  try {
    if (!fs.existsSync(composePath)) return null;
    doc = YAML.parse(fs.readFileSync(composePath, 'utf-8'));
  } catch {
    return null;
  }

  const sources: string[] = [];
  for (const service of Object.values<any>(doc?.services || {})) {
    if (!Array.isArray(service?.volumes)) continue;
    for (const vol of service.volumes) {
      if (typeof vol === 'string') {
        const split = splitDockerVolume(vol);
        if (split) sources.push(split.source);
      } else if (vol && vol.type !== 'volume' && typeof vol.source === 'string') {
        sources.push(vol.source);
      }
    }
  }

  const norm = sources.map(s => s.replace(/\\/g, '/').replace(/\/+$/, ''));
  const under = (root: string) => norm.some(s => s === root || s.startsWith(`${root}/`));

  const hostBotDir = hostBotDirFor(instance.id).replace(/\/+$/, '');
  if (under(hostBotDir)) return 'docker';

  const appData = `${(process.env.DATA_ROOT || '/DATA').replace(/\\/g, '/').replace(/\/+$/, '')}/AppData`;
  if (under(appData)) return 'casaos';

  return null;
}

/**
 * Refusal text when a build would re-author this instance under a different
 * deployment mode than the one it was deployed with, else null. That moves its
 * data bind, so it would come back on an empty directory with its real data left
 * at the old path.
 *
 * Only the ACCIDENTAL move is refused. Once an operator has declared the mode,
 * the move is their intent, and refusing it would trap the instance: a build is
 * the only thing that re-authors a compose, so the guard would block its own
 * recovery path.
 */
async function modeMismatchRefusal(instance: InstanceConfig, emit?: EmitFn): Promise<string | null> {
  const current = await getDeploymentMode();
  const deployed = deployedBindMode(instance);
  if (!deployed || deployed === current) return null;

  if (isModeExplicit()) {
    // Declared, so it proceeds. Still say it out loud in the build log: the
    // declaration is manager-wide while this consequence is per-instance, so
    // this may not be the instance the operator had in mind.
    if (emit) emit(`[Warning] ${instance.displayName} was deployed under ${deployed} mode and is being re-authored under ${current}. It will start on the ${current} path, and whatever it holds under the ${deployed} path stays there.`, 'warning');
    return null;
  }

  return `This instance was deployed under ${deployed} mode, but the manager auto-detected ${current} mode. Building would re-author its data bind, so it would start on the ${current} path while its current data stays under the ${deployed} one. Declare the mode and build again: PUT /api/system/deployment {"mode":"${deployed}"} keeps this instance where its data already is, and {"mode":"${current}"} accepts the detected mode for the whole manager, after which this instance moves on its next build.`;
}

/** The synchronous refusal a Build answers before touching anything; null when it may proceed. */
export function buildPreflightRefusal(botId: string): { success: false; error: string } | null {
  return databaseHoldRefusal(botId, 'Build') ?? databaseRunRefusal(botId, 'building') ?? deleteLaneRefusal(botId, 'Build');
}

export async function buildBot(botId: string): Promise<LaneResult> {
  return withLoggedBotOp(botId, 'build', async () => {
    const refusal = buildPreflightRefusal(botId);
    if (refusal) return refusal;
    const instance = getBot(botId);
    if (!instance) return { success: false, error: 'Bot not found' };
    // A Build does not start the bot, so the start an earlier update or restart owes stays recorded.
    const owesStart = instance.lane && instance.lane.op !== 'build';
    if (!owesStart) {
      try {
        writeLane(botId, newLane('build', false));
      } catch (err) {
        return laneRecordRefusal('build', err);
      }
    }
    const result = await buildBotImpl(botId);
    return result.success && !owesStart ? withWarning(result, clearFinishedLane(botId)) : result;
  });
}

/**
 * A build re-authors the deployed compose and rebuilds the image, but it
 * never recreates a RUNNING project: compose up belongs to the start lane.
 * Stamping such an instance 'stopped' made every lane trip over it: Stop
 * refused it, the reconciler flipped it back, Start refused it as already
 * running, and only an Update issued after the flip applied anything.
 */
async function stampBuildOutcome(botId: string, emit: EmitFn, statusBefore: BotStatus): Promise<string | null> {
  const appId = await runningAppContainerId(botId, resolveAppName(botId));
  // Docker not answering is evidence of nothing: what was known before the
  // build stands.
  if (appId === undefined) {
    emit('[Build] Could not check whether the project is running; keeping what was known before the build', 'warning');
    const kept: BotStatus = statusBefore === 'running' || statusBefore === 'stopped' || statusBefore === 'error' ? statusBefore : 'error';
    return recordStatusAfterDockerStep(botId, kept);
  }
  const running = appId !== null;
  // Ids are refreshed only from an answer; an unanswered listing keeps them.
  const ids = running ? (await getContainerIdsForBot(botId)) ?? undefined : undefined;
  if (running) emit('[Build] The running project was not recreated; Start (applies in place) or Restart applies this build', 'warning');
  // Nothing runs that the next Start would not deploy whole.
  try {
    setPendingApply(botId, running);
  } catch (err) {
    recordStatusAfterDockerStep(botId, running ? 'running' : 'stopped', ids);
    return err instanceof Error ? err.message : String(err);
  }
  return recordStatusAfterDockerStep(botId, running ? 'running' : 'stopped', ids);
}

async function finishBuild(botId: string, emit: EmitFn, statusBefore: BotStatus, displayName: string, commitUnrecorded: string | null): Promise<LaneResult> {
  const unrecorded = [commitUnrecorded, await stampBuildOutcome(botId, emit, statusBefore)].filter((m): m is string => !!m);
  emit(`[Success] Build completed for ${displayName}`, 'success');
  if (unrecorded.length === 0) return { success: true };
  const warning = `The build completed, but its outcome could not be recorded: ${unrecorded.join('; ')}`;
  emit(`[Warning] ${warning}`, 'warning');
  return { success: true, warning };
}

async function buildBotImpl(botId: string): Promise<LaneResult> {
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

    const deploymentMode = await getDeploymentMode();
    const isCasaOS = deploymentMode === 'casaos';

    const modeRefusal = await modeMismatchRefusal(instance, emit);
    if (modeRefusal) {
      emit(`[Error] ${modeRefusal}`, 'error');
      return { success: false, error: modeRefusal };
    }

    updateBotStatus(botId, 'building');

    if (sourceType === 'docker-image') {
      return await buildDockerImageInstance(instance, emit, isCasaOS);
    }

    return await buildGitInstance(instance, emit, isCasaOS);
  } catch (error) {
    const msg = String(error);
    emit(`[Error] Build failed: ${msg}`, 'error');
    emit('[Fatal] Build process terminated with error', 'error');
    console.error(`[ContainerManager] Failed to build instance ${botId}:`, error);
    await stampFailureFromDocker(botId, instance.status);
    return { success: false, error: msg };
  }
}

async function buildDockerImageInstance(
  instance: InstanceConfig,
  emit: EmitFn,
  isCasaOS: boolean,
): Promise<LaneResult> {
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
  const envWithToken = { ...mergedEnvVars(instance), BOT_MANAGER_UPDATE_TOKEN: instance.updateToken || '', BOT_ID: instance.id, BOT_MANAGER_INTERNAL_URL: internalUrl };

  // Use displayName for the compose bot config (BotConfig compat)
  const botForCompose: any = { ...instance, envVars: envWithToken };
  const dataTarget = resolveImageDataTarget(instance.imageRef);
  let composeContent = generateImageCompose(botForCompose, botDir, dataTarget);
  const appName = instance.sanitizedName;
  const processed = processComposeForCasaOS(composeContent, appName, botForCompose, { mode: isCasaOS ? 'casaos' : 'docker', hostBotDir: isCasaOS ? undefined : hostBotDirFor(botId) });
  composeContent = processed.content;

  // Config files: deliver/bind user-supplied config files (mode-aware).
  const configFiles = configFileManager.getConfigFilesStrict(botId).filter(c => c.enabled !== false);
  forgetBuiltMounts(botId);
  const delivery = newDeliveryReport();
  if (isCasaOS) {
    if (configFiles.length > 0) {
      emit(`[Config] Delivering ${configFiles.length} config file(s)`, 'info');
      composeContent = addConfigFileBinds(composeContent, appName, configFiles, (msg) => emit(msg, 'info'), delivery);
    }
  } else {
    // Docker mode: align the ./data bind + deliver/bind config files locally.
    const restore = configFileManager.getDeliveredOverrides(botId);
    composeContent = prepareDockerBotFiles(composeContent, getBotDir(botId), hostBotDirFor(botId), null, configFiles, (msg) => emit(msg, 'info'), delivery, restore);
    recordDeliveredOverrides(botId, delivery, true, emit, restore);
  }
  refuseUndelivered(delivery);

  // Docker mode: publish the bot's web UI on a host port (no gateway).
  if (!isCasaOS) composeContent = applyDockerHostPort(composeContent, instance);

  // Same rule as the git lanes: a rebuilt compose missing the standby service
  // would destroy the replica on the next up --remove-orphans.
  const standby = standbyRecordNow(botId, instance);
  if (standby && !standby.copyCleared) {
    composeContent = addFleetPostgresReplicaService(composeContent, botForCompose, standby, { mode: isCasaOS ? 'casaos' : 'docker' });
    emit(`[Fleet] Managed Postgres standby attached (${standby.containerName})`, 'info');
  } else if (standby) {
    emit('[Fleet] Managed Postgres standby left out: its copy was cleared for a re-seed that has not finished', 'info');
  }

  refuseUnownedStorage(instance, appName, composeContent, isCasaOS);

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
      const restore = configFileManager.getDeliveredOverrides(botId);
      const written = await writeConfigFiles(appName, configFiles, (msg) => emit(msg, 'info'), newDeliveryReport(), restore);
      recordDeliveredOverrides(botId, written, true, emit, restore);
      refuseUndelivered(written);
    }
  }

  recordBuiltMounts(botId, configFiles, emit);
  return finishBuild(botId, emit, instance.status, instance.displayName, null);
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
 * names: the app's capability record declares a companion database AND the
 * stored env carries the record's opt-in mode value. A blank stored URL is the
 * managed lane: the first match generates the credentials, writes the URL into
 * the encrypted env store and stamps instance.fleetDb; redeploys reuse the
 * stored URL + record verbatim (never regenerated). A URL pointing anywhere
 * else is the external lane (no sidecar). Flipping the mode back stops the
 * injection but KEEPS the volume and the record (data retention). Returns what
 * the compose injection needs, or null when no sidecar applies.
 */
export function ensureFleetDataBackend(instance: InstanceConfig): { containerName: string; volume: string; password: string; user: string; db: string } | null {
  const spec = findAppCapabilities(instance.sourceUrl)?.companionDb;
  if (!spec) return null;

  // Decision logic reads the FULL store over the record (the adopt lane writes
  // the mode key store-only); mergedEnvVars first so a broken store refuses
  // here instead of reading as opted-out and dropping the sidecar service.
  const stored = { ...mergedEnvVars(instance), ...envManager.getEnvVars(instance.id) };
  // An app declaring no mode key has no operator opt-in gate: the URL semantics
  // below decide alone.
  if (spec.env.mode && (stored[spec.env.mode.key] || '').trim().toLowerCase() !== spec.env.mode.value) return null;

  const containerName = instance.fleetDb?.containerName || `${instance.sanitizedName}-fleet-postgres`;
  const volume = instance.fleetDb?.volume || `${instance.sanitizedName}-fleet-postgres-data`;
  const url = (stored[spec.env.url] || '').trim();

  if (url === '') {
    // Postgres keeps the password a volume was initialized with, so a new one
    // minted over a kept volume (a Remove that kept data, then a same-name
    // install) locks the app out of that database.
    const state = dockerClient.volumeState(volume);
    if (state === 'exists') {
      throw new Error(`The database volume ${volume} already exists (an earlier install under this name kept it), and a new password would not open it. Put that install's database URL back into ${spec.env.url}, or remove the volume by hand if it holds nothing to keep`);
    }
    if (state === 'unknown') {
      throw new Error(`Docker did not say whether the database volume ${volume} exists, so the manager can't confirm a new database password is safe to mint; try again`);
    }
    const password = crypto.randomBytes(24).toString('base64url');
    const newUrl = `postgresql://${spec.user}:${password}@${containerName}:5432/${spec.database}`;
    envManager.setEnvVars(instance.id, { [spec.env.url]: newUrl });
    stampFleetDb(instance, { containerName, user: spec.user, db: spec.database, volume });
    return { containerName, volume, password, user: spec.user, db: spec.database };
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

  if (!instance.fleetDb) stampFleetDb(instance, { containerName, user: spec.user, db: spec.database, volume });
  return { containerName, volume, password, user: instance.fleetDb!.user, db: instance.fleetDb!.db };
}

/** Persist the fleetDb record on the instance, in-memory and in the registry (the URL lives only in the encrypted env store). */
function stampFleetDb(instance: InstanceConfig, record: FleetDbRecord): void {
  const registry = loadRegistry();
  const inst = registry.instances[instance.id];
  if (inst) {
    inst.fleetDb = record;
    delete inst.fleetOwnDbRetiredAt;
    inst.updatedAt = new Date().toISOString();
    saveRegistry(registry);
  }
  instance.fleetDb = record;
  delete instance.fleetOwnDbRetiredAt;
}

function buildGitInstance(instance: InstanceConfig, emit: EmitFn, isCasaOS: boolean): Promise<LaneResult> {
  if (!instance.sourceId) return buildGitInstanceHeld(instance, emit, isCasaOS);
  return sourceManager.withSourceLock(instance.sourceId, () => buildGitInstanceHeld(instance, emit, isCasaOS));
}

async function buildGitInstanceHeld(
  instance: InstanceConfig,
  emit: EmitFn,
  isCasaOS: boolean,
): Promise<LaneResult> {
  const botId = instance.id;
  let commitUnrecorded: string | null = null;
  let envFileNotWritten: string | null = null;
  let pinnedCommit: string | null = null;

  // Resolve source repo path: fetch from origin first so build uses latest commits
  let repoPath: string;
  if (instance.sourceId) {
    repoPath = sourceManager.getSourceRepoPath(instance.sourceId);
    emit('[Fetch] Pulling latest commits from origin...', 'info');
    try {
      const fetchResult = await sourceManager.fetchSourceHeld(instance.sourceId);
      if (fetchResult.hasUpdates) {
        emit(`[Fetch] Source updated with ${fetchResult.behindBy} new commit(s)`, 'success');
      } else {
        emit('[Fetch] Source already up to date', 'info');
      }
      if (fetchResult.copyError) emit(`[Fetch] Warning: ${fetchResult.copyError}`, 'warning');
    } catch (err: any) {
      emit(`[Fetch] Warning: could not fetch from origin (${err?.message || err}); building from local repo`, 'warning');
    }
    pinnedCommit = await sourceManager.readSourceHead(instance.sourceId);
    if (!fs.existsSync(repoPath)) {
      emit('[Error] Source repository not found', 'error');
      await stampFailureFromDocker(botId, instance.status);
      return { success: false, error: 'Source repository not found' };
    }
  } else {
    emit('[Error] Git instance has no sourceId', 'error');
    await stampFailureFromDocker(botId, instance.status);
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
      const owner = await composeProjectOwner(earlyAppName, botId);
      if (owner.kind === 'unknown') {
        const refusal = `cannot tell who owns ${earlyAppName}: ${owner.reason}`;
        emit(`[Error] ${refusal}`, 'error');
        await stampFailureFromDocker(botId, instance.status);
        return { success: false, error: refusal };
      }
      if (owner.kind === 'other') {
        emit(`[Cleanup] Stale compose found at ${metadataComposePath} (${owner.evidence}, current=${botId}), tearing down ghost containers`, 'warning');
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

  // Before env assembly so a freshly provisioned database URL rides this deploy.
  const fleetDb = ensureFleetDataBackend(instance);

  const internalUrl = process.env.BOT_MANAGER_INTERNAL_URL || `http://discordbotmanagerapp:${process.env.PORT || '8080'}`;
  const envWithToken = { ...mergedEnvVars(instance), BOT_MANAGER_UPDATE_TOKEN: instance.updateToken || '', BOT_ID: instance.id, BOT_MANAGER_INTERNAL_URL: internalUrl };
  const botWithEnv: any = { ...instance, envVars: envWithToken };

  const existingComposePath = hasExistingCompose(repoPath);
  let composeContent: string;
  let appName: string;
  let buildTarget: string | null = null;
  let sidecarInjected = false;
  let droppedGatewayBinds: string[] = [];
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
      let substituted;
      try {
        substituted = substituteComposeNames(rawCompose, originalComposeName, appName, instance.titleName);
      } catch (err: any) {
        throw new Error(`Name substitution refused: ${err?.message || err}`);
      }
      rawCompose = substituted.content;
      emit(`[Info] Substituted compose name: ${originalComposeName} -> ${appName}`, 'info');
      for (const note of substituted.notes) emit(note, 'info');
      // Substitution renamed the build-target service (its key and x-casaos.build),
      // so re-derive buildTarget from the substituted compose. Otherwise the image
      // swap below matches the old service name, no-ops, and the container keeps the
      // source's original (unbuilt) image - which is exactly how a 2nd instance ended
      // up running the upstream GHCR image instead of its freshly built one.
      if (buildTarget) {
        buildTarget = extractBuildTarget(rawCompose) || buildTarget;
      }
    }

    if (isCasaOS) {
      const refusal = appIdFolderRefusal(instance, rawCompose);
      if (refusal) throw new Error(refusal);
    }

    // Apply variable substitution
    rawCompose = applyVariableSubstitution(rawCompose, botWithEnv);

    // Apply deployment processing (mode-aware: casaos vs plain docker)
    {
      const processed = processComposeForCasaOS(rawCompose, appName, botWithEnv, { mode: isCasaOS ? 'casaos' : 'docker', hostBotDir: isCasaOS ? undefined : hostBotDirFor(botId) });
      composeContent = processed.content;
      sidecarInjected = processed.sidecarInjected;
      droppedGatewayBinds = processed.droppedGatewayBinds || [];
      for (const note of processed.networkNotes || []) emit(note, 'info');
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

    const backing = generatedBackingPasswords(instance, detection);
    for (const note of backing.notes) emit(note, 'info');
    composeContent = generateCompose(botWithEnv, detection, botDir, imageName, backing.passwords);
    appName = instance.sanitizedName;
    {
      const processed = processComposeForCasaOS(composeContent, appName, botWithEnv, { mode: isCasaOS ? 'casaos' : 'docker', hostBotDir: isCasaOS ? undefined : hostBotDirFor(botId) });
      composeContent = processed.content;
      sidecarInjected = processed.sidecarInjected;
      for (const note of processed.networkNotes || []) emit(note, 'info');
    }
    buildTarget = 'bot';
  }

  // Re-inject the standby on every rebuild, in EVERY compose lane: compose up
  // runs --remove-orphans, so a rebuilt compose missing this service would
  // destroy the replica.
  const standby = standbyRecordNow(botId, instance);
  if (standby && !standby.copyCleared) {
    composeContent = addFleetPostgresReplicaService(composeContent, botWithEnv, standby, { mode: isCasaOS ? 'casaos' : 'docker' });
    emit(`[Fleet] Managed Postgres standby attached (${standby.containerName})`, 'info');
  } else if (standby) {
    emit('[Fleet] Managed Postgres standby left out: its copy was cleared for a re-seed that has not finished', 'info');
  }

  refuseUnownedStorage(instance, appName, composeContent, isCasaOS);

  // Deliver volume dirs + user-edited config files (mode-aware).
  const configFiles = configFileManager.getConfigFilesStrict(botId).filter(c => c.enabled !== false);
  forgetBuiltMounts(botId);
  let bindOnlyConfigs: typeof configFiles = [];
  const delivery = newDeliveryReport();
  // Overrides an earlier build wrote: one disabled or removed since gets the repo template back.
  const restore = configFileManager.getDeliveredOverrides(botId);
  if (isCasaOS) {
    emit('[PCS] Creating volume directories...', 'info');
    await createVolumeDirectories(composeContent, appName, repoPath, (msg) => emit(msg, 'info'), delivery, restore);
    // A config whose path matches a bind the compose already declares is delivered
    // over that existing bind (no second bind). The rest fall through to a fresh bind.
    const handled = await applyUserConfigOverrides(composeContent, appName, configFiles, (msg) => emit(msg, 'info'), delivery, restore);
    bindOnlyConfigs = configFiles.filter(c => !handled.has(c.path));
    const declared = configFiles.filter(c => handled.has(c.path));
    if (declared.length > 0) composeContent = setDeclaredBindModes(composeContent, declared);
    // Config files the compose does NOT already mount: bind them in. Injected AFTER
    // createVolumeDirectories so the file path is not created as a directory.
    if (bindOnlyConfigs.length > 0) {
      emit(`[Config] Delivering ${bindOnlyConfigs.length} config file(s)`, 'info');
      composeContent = addConfigFileBinds(composeContent, appName, bindOnlyConfigs, (msg) => emit(msg, 'info'), delivery);
    }
  } else if (repoPath || configFiles.length > 0) {
    // Docker mode: create bind dirs, deliver repo files, and deliver/bind config
    // files directly to the bot's local data dir (no /DATA, no casaos container).
    emit('[Docker] Preparing volumes and config files...', 'info');
    composeContent = prepareDockerBotFiles(composeContent, getBotDir(botId), hostBotDirFor(botId), repoPath, configFiles, (msg) => emit(msg, 'info'), delivery, restore, droppedGatewayBinds);
  }
  recordDeliveredOverrides(botId, delivery, true, emit, restore);
  refuseUndelivered(delivery);

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
      emit(`[Build] Build args: ${Object.keys(relayed).join(', ')}`, 'info');
    }

    // Resolve commit/branch once. Order: the repo's actual HEAD (authoritative
    // after the fetch above), then the source registry, then the commit we last
    // recorded for this bot - so a transient fetch/clone gap bakes the previous
    // commit, never null.
    if (fs.existsSync(path.join(repoPath, '.git'))) {
      try {
        const simpleGit = require('simple-git').simpleGit;
        const git = simpleGit(repoPath);
        resolvedCommit = pinnedCommit;
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
    try {
      await writeComposeEnvFile(appName, buildEffectiveEnv(instance), (msg) => emit(msg, 'info'));
    } catch (err) {
      envFileNotWritten = `the .env file (${err instanceof Error ? err.message : String(err)}; the next start writes it again)`;
    }
    if (sidecarInjected) {
      emit('[PCS] Writing status page...', 'info');
      await writeStatusPage(appName, generateStatusPageHtml(instance), (msg) => emit(msg, 'info'));
    }
    if (bindOnlyConfigs.length > 0) {
      emit('[PCS] Writing config files...', 'info');
      const written = await writeConfigFiles(appName, bindOnlyConfigs, (msg) => emit(msg, 'info'), newDeliveryReport(), restore);
      recordDeliveredOverrides(botId, written, false, emit);
      refuseUndelivered(written);
    }
  }

  // Record the commit this was built from so the manager's record and the bot's
  // baked badge agree. Prefer the value baked into the image; otherwise (no
  // build target) read the repo, then the source registry.
  if (instance.sourceId) {
    let recordCommit = pinnedCommit;
    const headNow = await sourceManager.readSourceHead(instance.sourceId);
    if (!pinnedCommit) {
      commitUnrecorded = 'the built commit: the commit of the source checkout could not be read';
    } else if (headNow !== pinnedCommit) {
      commitUnrecorded = `the built commit: the source moved from ${pinnedCommit.substring(0, 7)} to ${headNow ? headNow.substring(0, 7) : 'an unreadable commit'} during the build; build again`;
      recordCommit = null;
    }
    if (recordCommit) {
      try {
        updateLastBuiltCommit(botId, recordCommit);
      } catch (err) {
        commitUnrecorded = `the built commit: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }

  recordBuiltMounts(botId, configFiles, emit);
  const built = await finishBuild(botId, emit, instance.status, instance.displayName, commitUnrecorded);
  if (!envFileNotWritten) return built;
  const notWritten = `The build completed, but these changes were not applied: ${envFileNotWritten}`;
  emit(`[Warning] ${notWritten}`, 'warning');
  return { ...built, warning: [notWritten, built.warning].filter(Boolean).join('; '), notApplied: [envFileNotWritten] };
}

// ─── Logs & Stats ───

export async function getBotLogs(botId: string, tail = 100): Promise<{ success: boolean; logs?: string[]; error?: string; unanswered?: true }> {
  const instance = getBot(botId);
  if (!instance) return { success: false, error: 'Bot not found' };

  // The recorded ids keep a stopped container's logs; docker adds the ones an
  // in-place apply or an external recreate started since.
  const live = await runningProjectContainerIds(instance.sanitizedName);
  if (live === undefined) return { success: false, unanswered: true, error: 'could not read logs from docker: docker did not answer' };
  const containerIds = [...new Set([...(instance.containerIds || []), ...live])];
  if (containerIds.length === 0) return { success: false, error: 'Bot has no containers' };

  try {
    const allLogs: string[] = [];
    const unread: string[] = [];
    let read = 0;
    for (const containerId of containerIds) {
      try {
        const logEntries = await dockerClient.getContainerLogs(containerId, Math.ceil(tail / containerIds.length));
        const containerName = containerId.substring(0, 12);
        if ('gone' in logEntries) continue;
        if ('error' in logEntries) { unread.push(`${containerName}: ${logEntries.error}`); continue; }
        read++;
        for (const e of logEntries) {
          allLogs.push(`[${e.timestamp}] [${containerName}] ${e.message}`);
        }
      } catch (err) {
        console.warn(`[ContainerManager] Failed to get logs from container ${containerId}:`, err);
      }
    }
    if (unread.length > 0) {
      return { success: false, unanswered: true, error: `could not read logs from docker: ${unread.join('; ')}` };
    }
    if (read === 0) return { success: false, error: 'the recorded containers no longer exist and docker runs none for this bot' };
    allLogs.sort();
    return { success: true, logs: allLogs.slice(-tail) };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export async function getBotStats(botId: string): Promise<{ success: boolean; stats?: { cpuPercent: number; memoryUsageMB: number; memoryLimitMB: number }; error?: string; unanswered?: true }> {
  const instance = getBot(botId);
  if (!instance) return { success: false, error: 'Bot not found' };

  // Docker, not the record, says whether the app runs: a 'building' record
  // may be serving, and a 'running' one may have crashed.
  const appId = await runningAppContainerId(botId, instance.sanitizedName);
  if (appId === undefined) return { success: false, unanswered: true, error: 'could not read stats from docker: docker did not answer' };
  if (appId === null) return { success: false, error: 'Bot is not running' };
  const containerIds = await runningProjectContainerIds(instance.sanitizedName);
  if (containerIds === undefined) return { success: false, unanswered: true, error: 'could not read stats from docker: docker did not answer' };
  if (containerIds.length === 0) return { success: false, error: 'Bot is not running' };

  try {
    let totalCpuPercent = 0;
    let totalMemoryUsageMB = 0;
    let totalMemoryLimitMB = 0;

    for (const containerId of containerIds) {
      try {
        const stats = await dockerClient.getContainerStats(containerId);
        if ('gone' in stats) continue;
        if ('error' in stats) {
          return { success: false, unanswered: true, error: `could not read stats from docker: ${stats.error}` };
        }
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
  const fault = registryFault();
  if (fault) { console.warn(`[Init] Transient statuses not reset: ${fault}`); return; }
  const registry = loadRegistry();
  const cut = Object.values(registry.instances).filter(i => i.lane && !i.lane.interrupted);
  if (cut.length > 0) {
    for (const instance of cut) {
      instance.lane!.interrupted = true;
      console.warn(`[Init] ${instance.id}: its ${instance.lane!.op} (started ${instance.lane!.startedAt}${instance.lane!.wasRunning ? ', the bot was running' : ''}) did not finish before the manager stopped`);
    }
    try {
      saveRegistry(registry);
    } catch (err) {
      console.error(`[Init] The interrupted lanes could not be marked: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const instance of Object.values(registry.instances)) {
    if (instance.status === 'building' || instance.status === 'starting' || instance.status === 'stopping') {
      console.log(`[Init] ${instance.id} was '${instance.status}' when the manager stopped - marking error`);
      stampErrorBestEffort(instance.id);
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
  const fault = registryFault();
  if (fault) { console.warn(`[Reconciler] Skipped: ${fault}`); return; }
  const registry = loadRegistry();
  const containers = await dockerClient.listBotContainers();
  if (!containers) { console.warn('[Reconciler] Skipped: docker did not answer the container listing'); return; }

  const checked: Record<string, { statusCheckedAt: string; servicesUp: string[] }> = {};
  for (const instance of Object.values(registry.instances)) {
    const status = servedStatus(instance).status;
    if (status !== 'running' && status !== 'stopped' && status !== 'error') {
      continue;
    }

    const appName = resolveAppName(instance.id);
    // Same matching as getContainerIdsForBot (ownedBotContainers).
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
    const botContainers = ownedBotContainers(containers, instance.id, appName)
      .filter(c => !standalone.has(c.name));
    const runningContainers = botContainers.filter(c => c.state === 'running');
    const runningIds = runningContainers.map(c => c.id);
    // The bot runs when its app service runs; a redis or status-page sibling
    // up beside a crash-looping app is not the bot running.
    const appService = reconcileAppService(instance.id, appName);
    const appRunning = appService && botContainers.some(c => c.service)
      ? runningContainers.some(c => c.service === appService)
      : runningContainers.length > 0;
    checked[instance.id] = { statusCheckedAt: new Date().toISOString(), servicesUp: runningContainers.map(c => c.service || c.name) };
    reconcileReads.set(instance.id, checked[instance.id]);

    if (status === 'running' && runningContainers.length === 0) {
      console.log(`[Reconciler] ${instance.id} registry=running but no running containers - marking stopped`);
      recordStatusAfterDockerStep(instance.id, 'stopped', []);
    } else if (status === 'running' && !appRunning) {
      const up = runningContainers.map(c => c.service || c.name).join(', ');
      console.log(`[Reconciler] ${instance.id} registry=running but its app service is down (still up: ${up}) - marking error`);
      recordStatusAfterDockerStep(instance.id, 'error', runningIds);
    } else if (status !== 'running' && appRunning) {
      console.log(`[Reconciler] ${instance.id} registry=${instance.status} but containers are running - marking running`);
      recordStatusAfterDockerStep(instance.id, 'running', runningIds);
    } else if (status === 'running') {
      const currentIds = (instance.containerIds || []).slice().sort().join(',');
      const newIds = runningIds.slice().sort().join(',');
      if (currentIds !== newIds) {
        recordStatusAfterDockerStep(instance.id, 'running', runningIds);
      }
    }
  }
  if (broadcastFn && Object.keys(checked).length > 0) broadcastFn('bots:checked', checked);
}

const reconcileReads = new Map<string, { statusCheckedAt: string; servicesUp: string[] }>();

/** When the reconciler last read this bot's containers from docker and which services were up; null before its first read. */
export function getReconcileRead(botId: string): { statusCheckedAt: string; servicesUp: string[] } | null {
  return reconcileReads.get(botId) ?? null;
}

/** The app service the reconciler keys on; null when the compose cannot say. */
function reconcileAppService(botId: string, appName: string): string | null {
  try {
    const composePath = resolveComposePath(botId, appName);
    if (!fs.existsSync(composePath)) return null;
    return getAppServiceName(YAML.parseDocument(fs.readFileSync(composePath, 'utf-8')).toJSON());
  } catch {
    return null;
  }
}

// ─── Helpers ───

function extractRepoName(url: string): string {
  // https://github.com/owner/my-bot.git -> my-bot
  const match = url.match(/\/([^\/]+?)(?:\.git)?$/);
  return match ? match[1] : 'unnamed-bot';
}
