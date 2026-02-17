/**
 * PCS Processing Pipeline
 *
 * Replicates the compiler's compose-processor.ts logic for CasaOS integration.
 * Handles: user rights injection, volume path processing, network configuration,
 * PUID/PGID env vars, ports→expose conversion, hostname, metadata placement,
 * volume directory creation, and pre/post install commands.
 */

import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { Document, parseDocument, stringify } from 'yaml';

const execAsync = promisify(exec);

// ─── Environment Helpers ───────────────────────────────────────────────────

interface PCSEnvironment {
  PUID: string;
  PGID: string;
  DATA_ROOT: string;
  REF_NET: string;
  REF_DOMAIN: string;
  REF_SCHEME: string;
  REF_PORT: string;
  REF_SEPARATOR: string;
}

function getPCSEnvironment(): PCSEnvironment {
  const env = process.env;
  return {
    PUID: env.PUID || '1000',
    PGID: env.PGID || '1000',
    DATA_ROOT: env.DATA_ROOT || '/DATA',
    REF_NET: env.REF_NET || 'pcs',
    REF_DOMAIN: env.REF_DOMAIN || 'localhost',
    REF_SCHEME: env.REF_SCHEME || 'http',
    REF_PORT: env.REF_PORT || '80',
    REF_SEPARATOR: env.REF_SEPARATOR || '-',
  };
}

// ─── Internal Helpers ──────────────────────────────────────────────────────

/**
 * Determine if PUID:PGID user injection should be applied to a service.
 * Returns true only if user is undefined or empty — never overrides explicit users.
 */
function shouldAddUserToService(service: Record<string, unknown>): boolean {
  const hasUser = service.user !== undefined && service.user !== '';
  return !hasUser;
}

/**
 * Get the main service name from x-casaos.main or default to first service.
 */
function getMainServiceName(compose: Record<string, unknown>): string | null {
  const xcasaos = compose['x-casaos'] as Record<string, unknown> | undefined;
  if (xcasaos?.main && typeof xcasaos.main === 'string') {
    return xcasaos.main;
  }
  const services = compose.services as Record<string, unknown> | undefined;
  if (services) {
    const keys = Object.keys(services);
    if (keys.length > 0) return keys[0];
  }
  return null;
}

/**
 * Check if PUID is already present in an environment section (array or object).
 */
function hasPUIDInEnv(env: unknown): boolean {
  if (Array.isArray(env)) {
    return env.some(
      (entry: unknown) => typeof entry === 'string' && /^PUID=/i.test(entry)
    );
  }
  if (env && typeof env === 'object') {
    return Object.keys(env as Record<string, unknown>).some(
      (key) => key.toUpperCase() === 'PUID'
    );
  }
  return false;
}

/**
 * Extract the compose name field from YAML content.
 */
export function extractAppName(composeContent: string): string | null {
  try {
    const doc = parseDocument(composeContent);
    const compose = doc.toJSON() as Record<string, unknown>;
    if (compose.name && typeof compose.name === 'string') {
      return compose.name;
    }
  } catch {
    // Fall through
  }
  return null;
}

// ─── PCS Processing ────────────────────────────────────────────────────────

/**
 * Apply PCS processing to compose content.
 * For each service:
 *   1. Replace /DATA prefix in volumes with actual DATA_ROOT
 *   2. Add REF_NET network to main service (external: true)
 *   3. Inject PUID/PGID env vars if not already present
 *
 * NOTE: Does NOT inject user: PUID:PGID on services. The compiler does this
 * for CasaOS App Store apps designed for it, but the Bot Manager deploys
 * arbitrary repos with standard images (redis, postgres, node) that break
 * when their default user is overridden.
 */
export function applyPCSProcessing(composeContent: string): string {
  const pcs = getPCSEnvironment();
  const doc = parseDocument(composeContent);
  const compose = doc.toJSON() as Record<string, unknown>;

  const services = compose.services as Record<string, Record<string, unknown>> | undefined;
  if (!services) return composeContent;

  const mainServiceName = getMainServiceName(compose);

  for (const [serviceName, service] of Object.entries(services)) {
    // 1. Volume path processing — replace /DATA with DATA_ROOT
    if (service.volumes && Array.isArray(service.volumes)) {
      service.volumes = service.volumes.map((volume: unknown) => {
        if (typeof volume === 'string') {
          return volume.replace(/^\/DATA/, pcs.DATA_ROOT);
        }
        if (volume && typeof volume === 'object') {
          const vol = volume as Record<string, unknown>;
          if (typeof vol.source === 'string' && vol.source.startsWith('/DATA')) {
            vol.source = vol.source.replace(/^\/DATA/, pcs.DATA_ROOT);
          }
        }
        return volume;
      });
    }

    // 2. Network injection (main service only)
    if (serviceName === mainServiceName && pcs.REF_NET) {
      // Skip if service has explicit network_mode (not bridge)
      if (!service.network_mode || service.network_mode === 'bridge') {
        if (!service.networks) {
          service.networks = [];
        }
        if (Array.isArray(service.networks)) {
          if (!service.networks.includes(pcs.REF_NET)) {
            service.networks.push(pcs.REF_NET);
          }
        } else if (typeof service.networks === 'object') {
          const nets = service.networks as Record<string, unknown>;
          if (!(pcs.REF_NET in nets)) {
            nets[pcs.REF_NET] = {};
          }
        }
      }
    }

    // 3. PUID/PGID environment variable injection
    if (!service.environment) {
      service.environment = {};
    }
    if (!hasPUIDInEnv(service.environment)) {
      if (Array.isArray(service.environment)) {
        service.environment.push(`PUID=${pcs.PUID}`);
        service.environment.push(`PGID=${pcs.PGID}`);
      } else if (typeof service.environment === 'object') {
        const env = service.environment as Record<string, string>;
        env.PUID = pcs.PUID;
        env.PGID = pcs.PGID;
      }
    }
  }

  // Ensure REF_NET network definition exists at compose level
  if (pcs.REF_NET) {
    if (!compose.networks) {
      compose.networks = {};
    }
    const networks = compose.networks as Record<string, unknown>;
    if (!networks[pcs.REF_NET]) {
      networks[pcs.REF_NET] = { external: true };
    }
  }

  return stringify(compose, { lineWidth: 0 });
}

// ─── CasaOS Metadata Processing ───────────────────────────────────────────

/**
 * Apply CasaOS metadata processing to compose content.
 *   1. Convert ports → expose on all services
 *   2. Set hostname on main service
 *   3. Copy x-casaos.icon to main service labels
 *   4. Set is_uncontrolled: false and store_app_id
 *   5. Generate x-casaos.hostname from REF_DOMAIN
 */
export function applyCasaOSMetadata(composeContent: string, appName: string): string {
  const pcs = getPCSEnvironment();
  const doc = parseDocument(composeContent);
  const compose = doc.toJSON() as Record<string, unknown>;

  const services = compose.services as Record<string, Record<string, unknown>> | undefined;
  if (!services) return composeContent;

  const mainServiceName = getMainServiceName(compose);

  for (const [serviceName, service] of Object.entries(services)) {
    // 1. Ports → expose conversion
    if (service.ports && Array.isArray(service.ports)) {
      const exposedPorts: string[] = [];

      for (const portMapping of service.ports) {
        if (typeof portMapping === 'string') {
          // "8080:8080" or "8080" or "8080:8080/tcp"
          const parts = portMapping.split(':');
          let containerPort = parts.length > 1 ? parts[parts.length - 1] : parts[0];
          // Strip protocol suffix
          containerPort = containerPort.split('/')[0];
          if (containerPort && !exposedPorts.includes(containerPort)) {
            exposedPorts.push(containerPort);
          }
        } else if (typeof portMapping === 'object' && portMapping !== null) {
          const obj = portMapping as Record<string, unknown>;
          if (obj.target !== undefined) {
            const containerPort = String(obj.target);
            if (!exposedPorts.includes(containerPort)) {
              exposedPorts.push(containerPort);
            }
          }
        }
      }

      if (exposedPorts.length > 0) {
        service.expose = exposedPorts;
      }
      delete service.ports;
    }

    // 2. Hostname on main service
    if (serviceName === mainServiceName) {
      service.hostname = appName;
    }

    // 3. Copy x-casaos.icon to main service labels
    if (serviceName === mainServiceName) {
      const xcasaos = compose['x-casaos'] as Record<string, unknown> | undefined;
      if (xcasaos?.icon && typeof xcasaos.icon === 'string') {
        if (!service.labels) {
          service.labels = {};
        }
        if (typeof service.labels === 'object' && !Array.isArray(service.labels)) {
          (service.labels as Record<string, string>).icon = xcasaos.icon;
        }
      }
    }
  }

  // 4. Set required x-casaos fields
  if (!compose['x-casaos']) {
    compose['x-casaos'] = {};
  }
  const xcasaos = compose['x-casaos'] as Record<string, unknown>;
  xcasaos.is_uncontrolled = false;
  xcasaos.store_app_id = appName;

  // 5. Generate hostname from REF_DOMAIN
  if (pcs.REF_DOMAIN && pcs.REF_DOMAIN !== 'localhost') {
    xcasaos.hostname = `${appName}${pcs.REF_SEPARATOR}${pcs.REF_DOMAIN}`;
  }

  return stringify(compose, { lineWidth: 0 });
}

// ─── Volume Directory Creation ─────────────────────────────────────────────

/**
 * Create volume directories that exist in the compose file.
 * Parses compose for volume sources starting with /DATA/AppData/.
 * Creates directories with proper ownership (1000:1000).
 */
export async function createVolumeDirectories(
  composeContent: string,
  logFn?: (msg: string) => void
): Promise<void> {
  const log = logFn || ((msg: string) => console.log(`[PCS] ${msg}`));
  const pcs = getPCSEnvironment();

  let compose: Record<string, unknown>;
  try {
    const doc = parseDocument(composeContent);
    compose = doc.toJSON() as Record<string, unknown>;
  } catch {
    log('[PCS] Failed to parse compose for volume directory creation');
    return;
  }

  const services = compose.services as Record<string, Record<string, unknown>> | undefined;
  if (!services) return;

  const dirsToCreate = new Set<string>();

  for (const service of Object.values(services)) {
    if (!service.volumes || !Array.isArray(service.volumes)) continue;

    for (const volume of service.volumes) {
      let source: string | null = null;

      if (typeof volume === 'string') {
        // "host:container" format
        const parts = volume.split(':');
        if (parts.length >= 2) source = parts[0];
      } else if (volume && typeof volume === 'object') {
        const vol = volume as Record<string, unknown>;
        if (typeof vol.source === 'string' && vol.type !== 'volume') {
          source = vol.source;
        }
      }

      if (source && source.startsWith(`${pcs.DATA_ROOT}/AppData`)) {
        dirsToCreate.add(source);
      }
    }
  }

  for (const dirPath of dirsToCreate) {
    try {
      // Try via docker exec into casaos container (host filesystem access)
      await execAsync(`docker exec --user ubuntu casaos mkdir -p "${dirPath}"`, {
        timeout: 10000,
      });
      await execAsync(`docker exec casaos chown -R ubuntu:ubuntu "${dirPath}"`, {
        timeout: 10000,
      });
      await execAsync(`docker exec casaos chmod -R 755 "${dirPath}"`, {
        timeout: 10000,
      });
      log(`[PCS] Created volume directory: ${dirPath}`);
    } catch {
      // Fallback: direct filesystem access
      try {
        fs.mkdirSync(dirPath, { recursive: true });
        await execAsync(`chown -R 1000:1000 "${dirPath}"`, { timeout: 5000 });
        await execAsync(`chmod -R 755 "${dirPath}"`, { timeout: 5000 });
        log(`[PCS] Created volume directory (fallback): ${dirPath}`);
      } catch (fallbackErr) {
        log(`[PCS] Warning: Failed to create volume directory ${dirPath}: ${fallbackErr}`);
      }
    }
  }
}

// ─── CasaOS Metadata File Management ───────────────────────────────────────

/**
 * Save processed compose to CasaOS metadata path.
 * Creates /DATA/AppData/casaos/apps/{appName}/ and writes docker-compose.yml.
 * Returns the path to the metadata compose file.
 */
export async function saveToCasaOSMetadata(
  appName: string,
  composeContent: string,
  logFn?: (msg: string) => void
): Promise<string> {
  const log = logFn || ((msg: string) => console.log(`[PCS] ${msg}`));
  const pcs = getPCSEnvironment();

  const metadataDir = path.join(pcs.DATA_ROOT, 'AppData', 'casaos', 'apps', appName);
  const composePath = path.join(metadataDir, 'docker-compose.yml');

  // Create metadata directory
  try {
    await execAsync(`docker exec --user ubuntu casaos mkdir -p "${metadataDir}"`, {
      timeout: 10000,
    });
    await execAsync(`docker exec casaos chown -R ubuntu:ubuntu "${metadataDir}"`, {
      timeout: 10000,
    });
  } catch {
    // Fallback: direct creation
    try {
      fs.mkdirSync(metadataDir, { recursive: true });
      await execAsync(`chown -R 1000:1000 "${metadataDir}"`, { timeout: 5000 });
    } catch (fallbackErr) {
      log(`[PCS] Warning: Could not set ownership on ${metadataDir}: ${fallbackErr}`);
      fs.mkdirSync(metadataDir, { recursive: true });
    }
  }

  // Write compose file
  fs.writeFileSync(composePath, composeContent);

  // Fix ownership on compose file
  try {
    await execAsync(`docker exec casaos chown ubuntu:ubuntu "${composePath}"`, {
      timeout: 10000,
    });
    await execAsync(`docker exec casaos chmod 644 "${composePath}"`, {
      timeout: 10000,
    });
  } catch {
    try {
      await execAsync(`chown 1000:1000 "${composePath}"`, { timeout: 5000 });
      await execAsync(`chmod 644 "${composePath}"`, { timeout: 5000 });
    } catch {
      // Best effort
    }
  }

  log(`[PCS] Saved CasaOS metadata compose to ${composePath}`);
  return composePath;
}

/**
 * Remove CasaOS metadata for an app.
 * Deletes /DATA/AppData/casaos/apps/{appName}/ directory.
 */
export async function removeCasaOSMetadata(
  appName: string,
  logFn?: (msg: string) => void
): Promise<void> {
  const log = logFn || ((msg: string) => console.log(`[PCS] ${msg}`));
  const pcs = getPCSEnvironment();

  const metadataDir = path.join(pcs.DATA_ROOT, 'AppData', 'casaos', 'apps', appName);

  if (fs.existsSync(metadataDir)) {
    try {
      fs.rmSync(metadataDir, { recursive: true, force: true });
      log(`[PCS] Removed CasaOS metadata: ${metadataDir}`);
    } catch (err) {
      log(`[PCS] Warning: Failed to remove metadata ${metadataDir}: ${err}`);
    }
  }
}

/**
 * Remove app data directory.
 * Deletes /DATA/AppData/{appName}/ if it exists.
 */
export async function removeAppData(
  appName: string,
  logFn?: (msg: string) => void
): Promise<void> {
  const log = logFn || ((msg: string) => console.log(`[PCS] ${msg}`));
  const pcs = getPCSEnvironment();

  const appDataDir = path.join(pcs.DATA_ROOT, 'AppData', appName);

  if (fs.existsSync(appDataDir)) {
    try {
      fs.rmSync(appDataDir, { recursive: true, force: true });
      log(`[PCS] Removed app data: ${appDataDir}`);
    } catch (err) {
      log(`[PCS] Warning: Failed to remove app data ${appDataDir}: ${err}`);
    }
  }
}

// ─── Post-Deploy Ownership Fix ─────────────────────────────────────────────

/**
 * Fix ownership of directories Docker may have created as root after deploy.
 * Targets app data paths and metadata paths.
 */
export async function fixPostDeployOwnership(
  appName: string,
  logFn?: (msg: string) => void
): Promise<void> {
  const log = logFn || ((msg: string) => console.log(`[PCS] ${msg}`));
  const pcs = getPCSEnvironment();

  const appDataDir = path.join(pcs.DATA_ROOT, 'AppData', appName);
  const metadataDir = path.join(pcs.DATA_ROOT, 'AppData', 'casaos', 'apps', appName);

  const fixDir = async (dirPath: string) => {
    if (!fs.existsSync(dirPath)) return;
    try {
      await execAsync(`docker exec casaos chown -R ubuntu:ubuntu "${dirPath}"`, {
        timeout: 10000,
      });
    } catch {
      try {
        await execAsync(`chown -R 1000:1000 "${dirPath}"`, { timeout: 5000 });
      } catch {
        // Best effort
      }
    }
  };

  await fixDir(appDataDir);
  await fixDir(metadataDir);
  log(`[PCS] Fixed post-deploy ownership for ${appName}`);
}

// ─── Pre/Post Install Command Execution ────────────────────────────────────

/**
 * Execute pre-install or post-install command from x-casaos metadata.
 * Pre-install throws on failure; post-install warns but continues.
 */
export async function executeInstallCommand(
  type: 'pre' | 'post',
  composeContent: string,
  logFn?: (msg: string) => void
): Promise<void> {
  const log = logFn || ((msg: string) => console.log(`[PCS] ${msg}`));

  let compose: Record<string, unknown>;
  try {
    const doc = parseDocument(composeContent);
    compose = doc.toJSON() as Record<string, unknown>;
  } catch {
    return;
  }

  const xcasaos = compose['x-casaos'] as Record<string, unknown> | undefined;
  if (!xcasaos) return;

  const cmdKey = type === 'pre' ? 'pre-install-cmd' : 'post-install-cmd';
  const cmd = xcasaos[cmdKey];
  if (!cmd || typeof cmd !== 'string') return;

  const pcs = getPCSEnvironment();
  const scriptId = Date.now().toString(36);
  const tempScript = `/tmp/botmgr-${type}install-${scriptId}.sh`;

  const scriptContent = `#!/bin/bash\nset -e\n\n${cmd}\n`;
  const scriptBase64 = Buffer.from(scriptContent).toString('base64');

  const dockerCommand = `docker exec --user ubuntu casaos bash -c 'umask 022 && echo "${scriptBase64}" | base64 -d > ${tempScript} && chmod 755 ${tempScript} && bash ${tempScript}'`;

  log(`[PCS] Executing ${type}-install command...`);

  try {
    const { stdout, stderr } = await execAsync(dockerCommand, {
      timeout: 300000,
      maxBuffer: 1024 * 1024 * 10,
    });
    if (stdout) log(`[PCS] ${type}-install stdout: ${stdout.trim()}`);
    if (stderr) log(`[PCS] ${type}-install stderr: ${stderr.trim()}`);
    log(`[PCS] ${type}-install command completed`);
  } catch (error) {
    if (type === 'pre') {
      throw new Error(`Pre-install command failed: ${error}`);
    } else {
      log(`[PCS] Warning: Post-install command failed (non-fatal): ${error}`);
    }
  }
}
