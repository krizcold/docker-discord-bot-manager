/**
 * CasaOS Detector
 * Detects if CasaOS is available and manages deployment mode
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { DeploymentMode } from '../types';
import { storeFileState, preserveCorruptCopy, corruptCopyNote, writeFileAtomic } from '../config/storeFile';

const execAsync = promisify(exec);
const DATA_DIR = process.env.DATA_DIR || '/data/data';
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

interface ManagerConfig {
  deploymentMode: DeploymentMode;
  autoDetected: boolean;
}

let cachedMode: DeploymentMode | null = null;

const VALID_MODES: readonly DeploymentMode[] = ['casaos', 'docker'];

/**
 * Read an explicit DEPLOYMENT_MODE override from the environment (highest
 * precedence; never persisted). An invalid value warns and is ignored so a typo
 * does not break startup.
 */
function parseEnvMode(): DeploymentMode | null {
  const raw = (process.env.DEPLOYMENT_MODE || '').trim().toLowerCase();
  if (!raw) return null;
  if ((VALID_MODES as readonly string[]).includes(raw)) return raw as DeploymentMode;
  console.warn(`[CasaOS] Ignoring invalid DEPLOYMENT_MODE="${process.env.DEPLOYMENT_MODE}" (expected casaos|docker)`);
  return null;
}

const DETECT_RETRIES = 3;
const DETECT_RETRY_DELAY_MS = 2000;

/**
 * Ask docker whether a container named exactly "casaos" exists (any state):
 * true or false, or null when docker could not answer. A stopped/restarting
 * casaos container still means a CasaOS platform, so `-a` is used; this also
 * covers the reboot race where both containers start in parallel. Only actual
 * docker command failures (e.g. daemon still coming up) are retried; a clean
 * "no casaos container" result returns immediately.
 */
async function detectCasaOS(): Promise<boolean | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const { stdout } = await execAsync('docker ps -a --filter "name=^casaos$" --format "{{.Names}}"');
      return stdout.split('\n').some(line => line.trim() === 'casaos');
    } catch (error) {
      if (attempt >= DETECT_RETRIES) {
        console.log('[CasaOS] Detection failed after retries');
        return null;
      }
      console.log(`[CasaOS] Detection failed (attempt ${attempt + 1}/${DETECT_RETRIES + 1}), retrying in 2s...`);
      await new Promise(resolve => setTimeout(resolve, DETECT_RETRY_DELAY_MS));
    }
  }
}

/** Display probe: an unanswered detection reads as not available. */
export async function isCasaOSAvailable(): Promise<boolean> {
  return (await detectCasaOS()) === true;
}

type ConfigLoad =
  | { kind: 'absent' }
  | { kind: 'ok'; config: ManagerConfig }
  | { kind: 'broken'; error: string };

/**
 * Load saved configuration. Only a definitely missing file is absent; a file
 * that cannot be checked, read or parsed, or names no valid mode, is broken
 * (a timestamped copy is kept beside it) and decides nothing.
 */
function loadConfig(): ConfigLoad {
  const state = storeFileState(CONFIG_FILE);
  if (state.kind === 'absent') return { kind: 'absent' };
  try {
    if (state.kind === 'broken') throw new Error(state.error);
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || !(VALID_MODES as readonly string[]).includes(parsed.deploymentMode)) {
      throw new Error('config.json names no valid deployment mode');
    }
    return { kind: 'ok', config: parsed as ManagerConfig };
  } catch (error: any) {
    console.error('[CasaOS] Failed to load config:', error);
    preserveCorruptCopy(CONFIG_FILE);
    return { kind: 'broken', error: String(error?.message || error) };
  }
}

/** Save configuration atomically; throws when it could not be saved. */
function saveConfig(config: ManagerConfig): void {
  writeFileAtomic(CONFIG_FILE, JSON.stringify(config, null, 2));
}

/**
 * Get current deployment mode (auto-detect if not set). Throws, deciding
 * nothing, when config.json exists but could not be read or when docker could
 * not answer the detection: the mode picks where an instance's data lives, so
 * a guess could relocate a running instance onto an empty directory.
 */
export async function getDeploymentMode(): Promise<DeploymentMode> {
  const envMode = parseEnvMode();
  if (envMode) {
    if (cachedMode !== envMode) {
      console.log(`[CasaOS] Deployment mode: ${envMode} (forced via DEPLOYMENT_MODE)`);
    }
    cachedMode = envMode;
    return cachedMode;
  }

  if (cachedMode) {
    return cachedMode;
  }

  const loaded = loadConfig();
  if (loaded.kind === 'broken') {
    throw new Error(`The deployment mode is undecided: config.json could not be read (${loaded.error}; ${corruptCopyNote(CONFIG_FILE)}). Repair it, or replace it by setting the mode: PUT /api/system/deployment {"mode":"casaos"|"docker"}.`);
  }

  // A persisted mode wins whether an operator pinned it or a first detection
  // wrote it. Re-detecting on every start let a platform change silently
  // re-decide the mode, and the mode picks where an instance's data lives, so a
  // flip relocates a running instance onto an empty directory at its next build.
  if (loaded.kind === 'ok') {
    cachedMode = loaded.config.deploymentMode;
    console.log(`[CasaOS] Deployment mode: ${cachedMode} (${loaded.config.autoDetected === false ? 'set by operator' : 'persisted from an earlier detection'})`);
    return cachedMode;
  }

  const casaos = await detectCasaOS();
  if (casaos === null) {
    throw new Error('The deployment mode could not be detected: docker did not answer. Nothing was decided or saved; it is retried on the next use.');
  }
  const detected: DeploymentMode = casaos ? 'casaos' : 'docker';
  try {
    saveConfig({ deploymentMode: detected, autoDetected: true });
  } catch (error) {
    console.error('[CasaOS] Could not save the detected deployment mode; it is detected again on the next start:', error);
  }
  cachedMode = detected;
  console.log(`[CasaOS] Deployment mode: ${cachedMode} (auto-detected)`);
  return cachedMode;
}

/**
 * Manually set deployment mode. Throws when DEPLOYMENT_MODE forces another
 * mode or the choice could not be saved; the running mode changes only once
 * it is saved.
 */
export function setDeploymentMode(mode: DeploymentMode): void {
  const envMode = parseEnvMode();
  if (envMode && envMode !== mode) {
    throw new DeploymentModeForcedError(envMode);
  }
  saveConfig({ deploymentMode: mode, autoDetected: false });
  cachedMode = mode;
  console.log(`[CasaOS] Deployment mode set to: ${mode}`);
}

export class DeploymentModeForcedError extends Error {
  constructor(forced: DeploymentMode) {
    super(`DEPLOYMENT_MODE forces the ${forced} mode on this manager, so the mode was not changed. Change DEPLOYMENT_MODE in the manager's environment instead.`);
    this.name = 'DeploymentModeForcedError';
  }
}

/**
 * True when the running mode was DECLARED rather than guessed: an explicit
 * DEPLOYMENT_MODE, or a persisted mode an operator set. Callers that refuse a
 * mode-driven change use this to refuse only the accidental case, so a
 * deliberate switch is never blocked.
 */
export function isModeExplicit(): boolean {
  if (parseEnvMode()) return true;
  const loaded = loadConfig();
  return loaded.kind === 'ok' && loaded.config.autoDetected === false;
}

/**
 * Drop the in-process cache so the next call re-reads config.json. It does NOT
 * force re-detection: a persisted mode still wins, and detection only runs when
 * there is no config to honour.
 */
export function clearCache(): void {
  cachedMode = null;
}

/**
 * Get deployment mode info for API response
 */
export async function getDeploymentInfo(): Promise<{
  mode: DeploymentMode;
  casaosAvailable: boolean;
  autoDetected: boolean;
  forcedByEnv: boolean;
}> {
  const loaded = loadConfig();
  const config = loaded.kind === 'ok' ? loaded.config : null;
  const casaosAvailable = await isCasaOSAvailable();
  const mode = await getDeploymentMode();
  const forcedByEnv = parseEnvMode() !== null;

  return {
    mode,
    casaosAvailable,
    autoDetected: forcedByEnv ? false : (config?.autoDetected ?? true),
    forcedByEnv,
  };
}
