/**
 * CasaOS Detector
 * Detects if CasaOS is available and manages deployment mode
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { DeploymentMode } from '../types';

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
 * Check if a container named exactly "casaos" exists (any state).
 * A stopped/restarting casaos container still means a CasaOS platform, so
 * `-a` is used; this also covers the reboot race where both containers start
 * in parallel. Only actual docker command failures (e.g. daemon still coming
 * up) are retried; a clean "no casaos container" result returns immediately.
 */
export async function isCasaOSAvailable(): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      const { stdout } = await execAsync('docker ps -a --filter "name=^casaos$" --format "{{.Names}}"');
      return stdout.split('\n').some(line => line.trim() === 'casaos');
    } catch (error) {
      if (attempt >= DETECT_RETRIES) {
        console.log('[CasaOS] Detection failed after retries, assuming not available');
        return false;
      }
      console.log(`[CasaOS] Detection failed (attempt ${attempt + 1}/${DETECT_RETRIES + 1}), retrying in 2s...`);
      await new Promise(resolve => setTimeout(resolve, DETECT_RETRY_DELAY_MS));
    }
  }
}

/**
 * Load saved configuration
 */
function loadConfig(): ManagerConfig | null {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
      return JSON.parse(content);
    }
  } catch (error) {
    console.error('[CasaOS] Failed to load config:', error);
  }
  return null;
}

/**
 * Save configuration
 */
function saveConfig(config: ManagerConfig): void {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (error) {
    console.error('[CasaOS] Failed to save config:', error);
  }
}

/**
 * Get current deployment mode (auto-detect if not set)
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

  const config = loadConfig();

  if (config && !config.autoDetected) {
    // User manually set the mode
    cachedMode = config.deploymentMode;
    return cachedMode;
  }

  // Auto-detect
  const casaosAvailable = await isCasaOSAvailable();
  cachedMode = casaosAvailable ? 'casaos' : 'docker';

  // Save auto-detected mode
  saveConfig({
    deploymentMode: cachedMode,
    autoDetected: true
  });

  console.log(`[CasaOS] Deployment mode: ${cachedMode} (auto-detected)`);
  return cachedMode;
}

/**
 * Manually set deployment mode
 */
export function setDeploymentMode(mode: DeploymentMode): void {
  cachedMode = mode;
  saveConfig({
    deploymentMode: mode,
    autoDetected: false
  });
  console.log(`[CasaOS] Deployment mode set to: ${mode}`);
}

/**
 * Clear cached mode (forces re-detection on next call)
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
  const config = loadConfig();
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
