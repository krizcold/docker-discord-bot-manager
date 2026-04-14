/**
 * PCS Processing Pipeline
 *
 * All compose modifications happen on a single parsed YAML object to avoid
 * corruption from multiple parse/stringify cycles.
 */

import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { parseDocument, stringify } from 'yaml';
import { BotConfig } from '../types';

const execAsync = promisify(exec);

// ─── Environment Helpers ───────────────────────────────────────────────────

interface PCSEnvironment {
  PUID: string;
  PGID: string;
  TZ: string;
  DATA_ROOT: string;
  REF_NET: string;
  REF_DOMAIN: string;
  REF_SCHEME: string;
  REF_PORT: string;
  REF_SEPARATOR: string;
  APP_DOMAIN: string;
  APP_PUBLIC_IP_DASH: string;
}

export function getPCSEnvironment(): PCSEnvironment {
  const env = process.env;
  return {
    PUID: env.PUID || '1000',
    PGID: env.PGID || '1000',
    TZ: env.TZ || 'UTC',
    DATA_ROOT: env.DATA_ROOT || '/DATA',
    REF_NET: env.REF_NET || 'pcs',
    REF_DOMAIN: env.REF_DOMAIN || 'localhost',
    REF_SCHEME: env.REF_SCHEME || 'http',
    REF_PORT: env.REF_PORT || '80',
    REF_SEPARATOR: env.REF_SEPARATOR || '-',
    APP_DOMAIN: env.APP_DOMAIN || '',
    APP_PUBLIC_IP_DASH: env.APP_PUBLIC_IP_DASH || '',
  };
}

// ─── Internal Helpers ──────────────────────────────────────────────────────

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
 * Extract the compose name field from YAML content string.
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

// ─── Single-Pass Compose Processing ────────────────────────────────────────

/**
 * Process a compose file for CasaOS deployment in a SINGLE parse/stringify cycle.
 * Single-pass approach: parse once, modify object, stringify once.
 *
 * Input: compose content string with variables ALREADY substituted.
 * Applies all modifications on the parsed YAML object:
 *   - Ensure name: field
 *   - Remove version: field
 *   - cpu_shares injection (50 default, 10 for infra services)
 *   - Add Bot Manager labels to all services
 *   - Add x-casaos metadata if missing
 *   - Ports → expose conversion
 *   - Hostname on main service
 *   - Caddy reverse proxy labels on main service (when web port detected)
 *   - Icon label on main service
 *   - is_uncontrolled: false, store_app_id
 *   - Volume /DATA path substitution
 *   - REF_NET network on main service (with name: pcs)
 *   - PUID/PGID/TZ env var injection
 *   - webui_port and index in x-casaos (when web port detected)
 */
export function processComposeForCasaOS(
  composeContent: string,
  appName: string,
  bot: BotConfig
): string {
  const pcs = getPCSEnvironment();
  const doc = parseDocument(composeContent);
  const compose = doc.toJSON() as Record<string, unknown>;

  // ── Ensure name field ──
  delete compose.version;
  if (!compose.name) {
    compose.name = appName;
  }

  const services = compose.services as Record<string, Record<string, unknown>> | undefined;
  if (!services) {
    return stringify(compose, { lineWidth: 0 });
  }

  const mainServiceName = getMainServiceName(compose);

  // Known infrastructure service names that get low cpu_shares (10)
  const infraServiceNames = new Set(['redis', 'postgres', 'db', 'mongo', 'mongodb', 'mariadb', 'mysql', 'lavalink']);

  // ── Per-service modifications ──
  for (const [serviceName, service] of Object.entries(services)) {

    // cpu_shares — mandatory on all services (50 default, 10 for infra)
    if (service.cpu_shares === undefined) {
      service.cpu_shares = infraServiceNames.has(serviceName) ? 10 : 50;
    }

    // Bot Manager labels
    if (!service.labels) {
      service.labels = {};
    }
    if (typeof service.labels === 'object' && !Array.isArray(service.labels)) {
      const labels = service.labels as Record<string, string>;
      labels['managed-by'] = 'discord-bot-manager';
      labels['bot-id'] = bot.id;
      labels['bot-name'] = bot.displayName;
    }

    // Ports → expose conversion
    if (service.ports && Array.isArray(service.ports)) {
      const exposedPorts: string[] = [];
      for (const portMapping of service.ports) {
        if (typeof portMapping === 'string') {
          const parts = portMapping.split(':');
          let containerPort = parts.length > 1 ? parts[parts.length - 1] : parts[0];
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

    // Hostname on main service
    if (serviceName === mainServiceName) {
      service.hostname = appName;
    }

    // Caddy reverse proxy labels on main service (only when web port detected)
    if (serviceName === mainServiceName) {
      const xcMeta = compose['x-casaos'] as Record<string, unknown> | undefined;
      let webPort: string | null = null;

      // Priority: x-casaos.webui_port > first expose entry > skip
      if (xcMeta?.webui_port !== undefined) {
        webPort = String(xcMeta.webui_port);
      } else if (service.expose && Array.isArray(service.expose) && service.expose.length > 0) {
        webPort = String(service.expose[0]);
      }

      if (webPort && pcs.APP_DOMAIN) {
        if (typeof service.labels === 'object' && !Array.isArray(service.labels)) {
          const labels = service.labels as Record<string, string>;
          // Gateway-routed domain (custom CA)
          labels['caddy_0'] = `${appName}-${pcs.APP_DOMAIN}`;
          labels['caddy_0.import'] = 'gateway_tls';
          labels['caddy_0.reverse_proxy'] = `{{upstreams ${webPort}}}`;
          // nip.io direct access (custom CA)
          if (pcs.APP_PUBLIC_IP_DASH) {
            labels['caddy_1'] = `${appName}-${pcs.APP_PUBLIC_IP_DASH}.nip.io`;
            labels['caddy_1.import'] = 'gateway_tls';
            labels['caddy_1.reverse_proxy'] = `{{upstreams ${webPort}}}`;
            // sslip.io direct access (Let's Encrypt — no gateway_tls)
            labels['caddy_2'] = `${appName}-${pcs.APP_PUBLIC_IP_DASH}.sslip.io`;
            labels['caddy_2.reverse_proxy'] = `{{upstreams ${webPort}}}`;
          }
        }
      }
    }

    // Icon label on main service
    if (serviceName === mainServiceName) {
      const xcasaos = compose['x-casaos'] as Record<string, unknown> | undefined;
      if (xcasaos?.icon && typeof xcasaos.icon === 'string') {
        if (typeof service.labels === 'object' && !Array.isArray(service.labels)) {
          (service.labels as Record<string, string>).icon = xcasaos.icon;
        }
      }
    }

    // Volume path processing — replace /DATA with actual DATA_ROOT
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

    // Network injection (main service only)
    if (serviceName === mainServiceName && pcs.REF_NET) {
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

    // PUID/PGID/TZ environment variable injection
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
    // TZ injection (if not already set)
    if (Array.isArray(service.environment)) {
      if (!service.environment.some((e: unknown) => typeof e === 'string' && /^TZ=/i.test(e))) {
        service.environment.push(`TZ=${pcs.TZ}`);
      }
    } else if (typeof service.environment === 'object') {
      const env = service.environment as Record<string, string>;
      if (!Object.keys(env).some((k) => k.toUpperCase() === 'TZ')) {
        env.TZ = pcs.TZ;
      }
    }
  }

  // ── Merge bot.envVars into the target service ──
  // User-configured env vars (from wizard/editor) must be injected into the
  // build target service (x-casaos.build) or the main service's environment.
  if (bot.envVars && Object.keys(bot.envVars).length > 0) {
    const xcBuild = (compose['x-casaos'] as Record<string, unknown> | undefined)?.build;
    const targetServiceName = (typeof xcBuild === 'string' && services[xcBuild])
      ? xcBuild
      : mainServiceName;

    if (targetServiceName && services[targetServiceName]) {
      const targetService = services[targetServiceName];
      if (!targetService.environment) {
        targetService.environment = {};
      }

      const envVars = bot.envVars;
      if (Array.isArray(targetService.environment)) {
        const envArr = targetService.environment as string[];
        for (const [key, value] of Object.entries(envVars)) {
          const idx = envArr.findIndex((e: string) => e.startsWith(`${key}=`));
          if (idx >= 0) envArr[idx] = `${key}=${value}`;
          else envArr.push(`${key}=${value}`);
        }
      } else if (typeof targetService.environment === 'object') {
        const envObj = targetService.environment as Record<string, string>;
        for (const [key, value] of Object.entries(envVars)) {
          envObj[key] = value;
        }
      }
    }
  }

  // ── Compose-level network definition ──
  if (pcs.REF_NET) {
    if (!compose.networks) {
      compose.networks = {};
    }
    const networks = compose.networks as Record<string, unknown>;
    if (!networks[pcs.REF_NET]) {
      networks[pcs.REF_NET] = { name: pcs.REF_NET, external: true };
    } else if (networks[pcs.REF_NET] && typeof networks[pcs.REF_NET] === 'object') {
      const net = networks[pcs.REF_NET] as Record<string, unknown>;
      if (!net.name) {
        net.name = pcs.REF_NET;
      }
    }
  }

  // ── x-casaos metadata ──
  if (!compose['x-casaos']) {
    compose['x-casaos'] = {
      architectures: ['amd64', 'arm64'],
      main: mainServiceName || 'bot',
      author: 'discord-bot-manager',
      developer: 'discord-bot-manager',
      tagline: { en_us: `Discord Bot: ${bot.displayName}` },
      category: 'Utilities',
      description: { en_us: `Managed Discord bot: ${bot.displayName}` },
      title: { en_us: bot.displayName },
    };
  }

  const xcasaos = compose['x-casaos'] as Record<string, unknown>;
  xcasaos.is_uncontrolled = false;
  xcasaos.store_app_id = appName;

  if (pcs.APP_DOMAIN) {
    xcasaos.hostname = `${appName}${pcs.REF_SEPARATOR}${pcs.APP_DOMAIN}`;
  }

  // scheme and port_map for CasaOS web UI routing
  if (pcs.REF_SCHEME && pcs.REF_SCHEME !== 'http') {
    xcasaos.scheme = pcs.REF_SCHEME;
  }
  if (pcs.REF_PORT && pcs.REF_PORT !== '80') {
    xcasaos.port_map = pcs.REF_PORT;
  }

  // webui_port and index — set when main service has a web port
  if (mainServiceName && services[mainServiceName]) {
    const mainSvc = services[mainServiceName];
    let webPort: string | null = null;

    if (xcasaos.webui_port !== undefined) {
      webPort = String(xcasaos.webui_port);
    } else if (mainSvc.expose && Array.isArray(mainSvc.expose) && mainSvc.expose.length > 0) {
      webPort = String(mainSvc.expose[0]);
    }

    if (webPort) {
      xcasaos.webui_port = parseInt(webPort, 10);
      if (!xcasaos.index) {
        xcasaos.index = '/';
      }
    }
  }

  // ── Single stringify ──
  return stringify(compose, { lineWidth: 0 });
}

// ─── Volume Directory Creation ─────────────────────────────────────────────

/**
 * Create volume directories from a compose file.
 * Parses compose for volume sources under DATA_ROOT/AppData/.
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
