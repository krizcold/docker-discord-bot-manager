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

/**
 * Check if CasaOS container is running
 */
export async function isCasaOSAvailable(): Promise<boolean> {
  try {
    const { stdout } = await execAsync('docker ps --filter "name=casaos" --format "{{.Names}}"');
    return stdout.trim().includes('casaos');
  } catch (error) {
    console.log('[CasaOS] Detection failed, assuming not available');
    return false;
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
}> {
  const config = loadConfig();
  const casaosAvailable = await isCasaOSAvailable();
  const mode = await getDeploymentMode();

  return {
    mode,
    casaosAvailable,
    autoDetected: config?.autoDetected ?? true
  };
}
