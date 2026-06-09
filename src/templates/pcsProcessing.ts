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
import { buildStatusPageService } from './statusPage';
import { findConfigTemplate } from '../config/configTemplates';

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

// Service names that are backing infrastructure, never the web tile.
const INFRA_SERVICE_NAMES = new Set([
  'mysql', 'mariadb', 'postgres', 'postgresql', 'db', 'database', 'redis',
  'mongo', 'mongodb', 'lavalink', 'migrate', 'migration', 'migrations',
  'adminer', 'phpmyadmin', 'meilisearch', 'rabbitmq', 'memcached', 'elasticsearch',
]);

// Ports a browser-facing web UI typically listens on.
const WEB_PORT_RE = /(^|[^0-9])(80|443|3000|3300|4000|5000|5173|8000|8080|8443)([^0-9]|$)/;

function isInfraServiceName(name: string): boolean {
  return INFRA_SERVICE_NAMES.has(name.toLowerCase());
}

function serviceHasWebPort(service: Record<string, unknown> | undefined): boolean {
  if (!service) return false;
  const flat = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => (x && typeof x === 'object') ? JSON.stringify(x) : String(x)) : [];
  const blob = [...flat(service.ports), ...flat(service.expose)].join(' ');
  return WEB_PORT_RE.test(blob);
}

/**
 * The web-facing service: x-casaos.main if set, else (for a multi-service compose)
 * the first non-infra service exposing a web port, else the first non-infra
 * service, else the first service. Used for the CasaOS tile, Caddy, hostname,
 * webui_port and the status-page decision. Kept separate from the env-injection
 * target so a reverse-proxy/dashboard service is not treated as the bot.
 */
function getMainServiceName(compose: Record<string, unknown>): string | null {
  const services = compose.services as Record<string, Record<string, unknown>> | undefined;
  const xcasaos = compose['x-casaos'] as Record<string, unknown> | undefined;
  if (xcasaos?.main && typeof xcasaos.main === 'string' && services?.[xcasaos.main]) {
    return xcasaos.main;
  }
  if (!services) return null;
  const keys = Object.keys(services);
  if (keys.length <= 1) return keys[0] || null;
  const nonInfra = keys.filter((k) => !isInfraServiceName(k));
  for (const k of nonInfra) {
    if (serviceHasWebPort(services[k])) return k;
  }
  return nonInfra[0] || keys[0];
}

/**
 * The app service that receives the bot's env vars: x-casaos.build if set, else
 * the first non-infra service, else the first service. Decoupled from the
 * web-facing main service.
 */
function getAppServiceName(compose: Record<string, unknown>): string | null {
  const services = compose.services as Record<string, Record<string, unknown>> | undefined;
  const xcasaos = compose['x-casaos'] as Record<string, unknown> | undefined;
  if (xcasaos?.build && typeof xcasaos.build === 'string' && services?.[xcasaos.build]) {
    return xcasaos.build;
  }
  if (!services) return null;
  const keys = Object.keys(services);
  const nonInfra = keys.filter((k) => !isInfraServiceName(k));
  return nonInfra[0] || keys[0] || null;
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
/**
 * Map a bind-mount host path to the platform's per-app data dir. `/DATA` prefixes
 * become DATA_ROOT; relative paths (`./x`, `../x`) become
 * <DATA_ROOT>/AppData/<app>/x. Named volumes and other absolute paths are left
 * untouched.
 */
function rewriteBindSource(source: string, appData: string, dataRoot: string): string {
  if (source === '/DATA' || source.startsWith('/DATA/')) return dataRoot + source.slice(5);
  if (source.startsWith('./') || source.startsWith('../')) {
    const rel = source.replace(/^(\.\.?\/)+/, '').replace(/\/+$/, '');
    return rel ? `${appData}/${rel}` : appData;
  }
  return source;
}

/**
 * Rewrite the host-path field of a short-form volume string `SRC:DEST[:MODE]`.
 * Only the source (first field) is a host path; named volumes (no `/` or `.`
 * prefix) are left untouched.
 */
function rewriteVolumeString(volume: string, appData: string, dataRoot: string): string {
  const firstColon = volume.indexOf(':');
  if (firstColon <= 0) return volume;
  const source = volume.slice(0, firstColon);
  if (!source.startsWith('/') && !source.startsWith('.')) return volume;
  return rewriteBindSource(source, appData, dataRoot) + volume.slice(firstColon);
}

export function processComposeForCasaOS(
  composeContent: string,
  appName: string,
  bot: BotConfig
): { content: string; sidecarInjected: boolean } {
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
    return { content: stringify(compose, { lineWidth: 0 }), sidecarInjected: false };
  }

  let mainServiceName = getMainServiceName(compose);

  // ── Status-page sidecar ──
  // Bots with no web port get an nginx tile so CasaOS has something to "Open".
  // Injected before the per-service pass so it inherits Caddy labels, webui_port,
  // network, and PUID/TZ handling as the new main service.
  let sidecarInjected = false;
  const mainSvcForPort = mainServiceName ? services[mainServiceName] : undefined;
  const xcEarly = compose['x-casaos'] as Record<string, unknown> | undefined;
  const mainHasPort =
    (Array.isArray(mainSvcForPort?.ports) && (mainSvcForPort!.ports as unknown[]).length > 0) ||
    (Array.isArray(mainSvcForPort?.expose) && (mainSvcForPort!.expose as unknown[]).length > 0);
  if (!(xcEarly?.webui_port !== undefined || mainHasPort)) {
    services['status-page'] = buildStatusPageService(appName, bot.id);
    if (!compose['x-casaos']) compose['x-casaos'] = {};
    (compose['x-casaos'] as Record<string, unknown>).main = 'status-page';
    mainServiceName = 'status-page';
    sidecarInjected = true;
  }

  // Known infrastructure service names that get low cpu_shares (10)
  const infraServiceNames = new Set(['redis', 'postgres', 'db', 'mongo', 'mongodb', 'mariadb', 'mysql', 'lavalink']);

  // ── Per-service modifications ──
  for (const [serviceName, service] of Object.entries(services)) {

    // Activate all compose profiles: strip the key so every service runs
    // unconditionally (survives CasaOS re-deploys, unlike a --profile flag)
    if (service.profiles !== undefined) {
      delete service.profiles;
    }

    // cpu_shares: mandatory on all services (50 default, 10 for infra)
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
            // sslip.io direct access (Let's Encrypt, no gateway_tls)
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

    // Volume path processing: map /DATA and relative bind sources to the app's
    // AppData dir, so third-party composes that use `./foo` persist under the
    // platform's data location (named volumes and other absolute paths untouched).
    if (service.volumes && Array.isArray(service.volumes)) {
      const appData = `${pcs.DATA_ROOT}/AppData/${appName}`;
      service.volumes = service.volumes.map((volume: unknown) => {
        if (typeof volume === 'string') {
          return rewriteVolumeString(volume, appData, pcs.DATA_ROOT);
        }
        if (volume && typeof volume === 'object') {
          const vol = volume as Record<string, unknown>;
          if (typeof vol.source === 'string' && vol.type !== 'volume') {
            vol.source = rewriteBindSource(vol.source, appData, pcs.DATA_ROOT);
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

  // ── Merge bot.envVars into the app service ──
  // User-configured env vars (from wizard/editor) go to the app service (the
  // build target, or the first non-infra service), NOT the web-facing main
  // service, which may be a reverse proxy. A .env file written next to the
  // compose covers services that read env via env_file.
  if (bot.envVars && Object.keys(bot.envVars).length > 0) {
    const targetServiceName = getAppServiceName(compose);

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

  // webui_port and index: set when main service has a web port
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
  return { content: stringify(compose, { lineWidth: 0 }), sidecarInjected };
}

// ─── Volume Directory Creation ─────────────────────────────────────────────

/**
 * Ensure a volume directory exists under AppData with platform ownership.
 * Non-recursive (contents are never re-chowned). `preserveExisting` (default)
 * skips an already-present dir, so a service that took ownership of its bind mount
 * (e.g. Postgres chowning its data dir to uid 999, mode 0700) is never clobbered
 * on redeploy. `mode` lets a delivered dir a container must write to be made
 * world-writable (e.g. a Lavalink plugins dir it downloads into at startup).
 */
async function ensureVolumeDir(
  dirPath: string,
  log: (msg: string) => void,
  mode = '755',
  preserveExisting = true,
): Promise<void> {
  if (preserveExisting && fs.existsSync(dirPath)) return;
  try {
    await execAsync(`docker exec --user ubuntu casaos mkdir -p "${dirPath}"`, { timeout: 10000 });
    await execAsync(`docker exec casaos chown ubuntu:ubuntu "${dirPath}"`, { timeout: 10000 });
    await execAsync(`docker exec casaos chmod ${mode} "${dirPath}"`, { timeout: 10000 });
  } catch {
    fs.mkdirSync(dirPath, { recursive: true });
    try {
      await execAsync(`chown 1000:1000 "${dirPath}"`, { timeout: 5000 });
      await execAsync(`chmod ${mode} "${dirPath}"`, { timeout: 5000 });
    } catch { /* best effort */ }
  }
}

// Repo entries never delivered into a bind mount (heavy / irrelevant).
const SKIP_DELIVER = new Set(['node_modules', '.git']);

/**
 * Copy a repo file to its AppData bind target (parent dir created first), so a
 * compose that bind-mounts a config file from the repo (e.g. application.yml)
 * actually delivers it instead of Docker auto-creating an empty directory.
 * Seed semantics: an already-present target is left untouched, so a redeploy
 * never reverts a file the running app has since modified.
 */
async function deliverRepoFile(repoSrc: string, target: string, log: (msg: string) => void): Promise<void> {
  if (fs.existsSync(target)) {
    const st = fs.statSync(target);
    if (st.isFile() && st.size > 0) return;   // seed: keep an already-delivered/mutated (non-empty) file
    // Re-deliver over an EMPTY file (e.g. a config blanked by accident) or a
    // wrong-type target (an empty dir Docker created where a file belongs).
    try { await execAsync(`docker exec casaos rm -rf "${target}"`, { timeout: 10000 }); }
    catch { try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
  await ensureVolumeDir(path.dirname(target), log);
  fs.writeFileSync(target, fs.readFileSync(repoSrc));
  try {
    await execAsync(`docker exec casaos chown ubuntu:ubuntu "${target}"`, { timeout: 10000 });
    await execAsync(`docker exec casaos chmod 644 "${target}"`, { timeout: 10000 });
  } catch {
    try {
      await execAsync(`chown 1000:1000 "${target}"`, { timeout: 5000 });
      await execAsync(`chmod 644 "${target}"`, { timeout: 5000 });
    } catch { /* best effort */ }
  }
}

/**
 * Recursively copy a repo directory to its AppData bind target.
 */
async function deliverRepoDir(repoSrc: string, target: string, log: (msg: string) => void): Promise<void> {
  // A repo-provided bind dir is app-managed and a foreign-uid container may need
  // to write into it (e.g. Lavalink downloading plugin jars), so make it writable.
  await ensureVolumeDir(target, log, '777', false);
  for (const entry of fs.readdirSync(repoSrc, { withFileTypes: true })) {
    if (SKIP_DELIVER.has(entry.name)) continue;
    const childRepo = path.join(repoSrc, entry.name);
    const childTarget = `${target}/${entry.name}`;
    if (entry.isDirectory()) {
      await deliverRepoDir(childRepo, childTarget, log);
    } else if (entry.isFile()) {
      await deliverRepoFile(childRepo, childTarget, log);
    }
  }
}

/**
 * Prepare every AppData bind-mount path a compose declares. A path that maps from
 * a file/dir present in the cloned repo is delivered (copied) so repo-provided
 * config is not lost and a file mount is not mkdir'd as a directory; a path with
 * no repo counterpart (e.g. a database data dir) is created empty.
 */
export async function createVolumeDirectories(
  composeContent: string,
  appName: string,
  repoPath: string | null,
  logFn?: (msg: string) => void
): Promise<void> {
  const log = logFn || ((msg: string) => console.log(`[PCS] ${msg}`));
  const pcs = getPCSEnvironment();

  let compose: Record<string, unknown>;
  try {
    compose = parseDocument(composeContent).toJSON() as Record<string, unknown>;
  } catch {
    log('[PCS] Failed to parse compose for volume directory creation');
    return;
  }

  const services = compose.services as Record<string, Record<string, unknown>> | undefined;
  if (!services) return;

  const appDataPrefix = `${pcs.DATA_ROOT}/AppData`;
  const appDir = `${appDataPrefix}/${appName}`;
  const sources = new Set<string>();

  for (const service of Object.values(services)) {
    if (!Array.isArray(service.volumes)) continue;
    for (const volume of service.volumes) {
      let source: string | null = null;
      if (typeof volume === 'string') {
        const idx = volume.indexOf(':');
        if (idx > 0) source = volume.slice(0, idx);
      } else if (volume && typeof volume === 'object') {
        const vol = volume as Record<string, unknown>;
        if (typeof vol.source === 'string' && vol.type !== 'volume') source = vol.source;
      }
      if (source && source.startsWith(appDataPrefix)) sources.add(source);
    }
  }

  for (const target of sources) {
    try {
      // If this bind maps from content inside the cloned repo, deliver it.
      // Containment: path.resolve normalizes any `..`, and we require the result
      // to stay within the repo so a crafted source cannot read outside it.
      let repoSrc: string | null = null;
      if (repoPath && target.startsWith(`${appDir}/`)) {
        const repoRoot = path.resolve(repoPath);
        const candidate = path.resolve(repoPath, target.slice(appDir.length + 1));
        if (candidate.startsWith(repoRoot + path.sep)) {
          if (fs.existsSync(candidate)) repoSrc = candidate;
          else repoSrc = findConfigTemplate(candidate);   // gitignored config shipped as a template
        }
      }

      if (repoSrc && fs.statSync(repoSrc).isFile()) {
        await deliverRepoFile(repoSrc, target, log);
        log(`[PCS] Delivered file to volume path: ${target}`);
      } else if (repoSrc && fs.statSync(repoSrc).isDirectory()) {
        await deliverRepoDir(repoSrc, target, log);
        log(`[PCS] Delivered directory to volume path: ${target}`);
      } else {
        await ensureVolumeDir(target, log);
        log(`[PCS] Created volume directory: ${target}`);
      }
    } catch (err) {
      log(`[PCS] Warning: could not prepare volume path ${target}: ${err}`);
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
 * Write the status-page index.html into the sidecar's bind-mounted dir.
 * Mirrors saveToCasaOSMetadata's docker-exec-into-casaos write pattern.
 */
export async function writeStatusPage(
  appName: string,
  html: string,
  logFn?: (msg: string) => void
): Promise<string> {
  const log = logFn || ((msg: string) => console.log(`[PCS] ${msg}`));
  const pcs = getPCSEnvironment();

  const dir = path.join(pcs.DATA_ROOT, 'AppData', appName, 'status-page');
  const filePath = path.join(dir, 'index.html');

  try {
    await execAsync(`docker exec --user ubuntu casaos mkdir -p "${dir}"`, { timeout: 10000 });
    await execAsync(`docker exec casaos chown -R ubuntu:ubuntu "${dir}"`, { timeout: 10000 });
  } catch {
    try {
      fs.mkdirSync(dir, { recursive: true });
      await execAsync(`chown -R 1000:1000 "${dir}"`, { timeout: 5000 });
    } catch (fallbackErr) {
      log(`[PCS] Warning: Could not set ownership on ${dir}: ${fallbackErr}`);
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  fs.writeFileSync(filePath, html);

  try {
    await execAsync(`docker exec casaos chown ubuntu:ubuntu "${filePath}"`, { timeout: 10000 });
    await execAsync(`docker exec casaos chmod 644 "${filePath}"`, { timeout: 10000 });
  } catch {
    try {
      await execAsync(`chown 1000:1000 "${filePath}"`, { timeout: 5000 });
      await execAsync(`chmod 644 "${filePath}"`, { timeout: 5000 });
    } catch {
      // Best effort
    }
  }

  log(`[PCS] Wrote status page to ${filePath}`);
  return filePath;
}

/**
 * Add bind mounts for user-supplied config files onto the build-target (or main)
 * service. Source is the host file written by writeConfigFiles under
 * /DATA/AppData/<app>/config; mounted read-only at the in-container path.
 * Must run AFTER createVolumeDirectories so the file path is not mkdir'd as a dir.
 */
export function addConfigFileBinds(
  composeContent: string,
  appName: string,
  files: Array<{ path: string; readOnly?: boolean }>
): string {
  if (!files.length) return composeContent;
  const pcs = getPCSEnvironment();

  let compose: Record<string, unknown>;
  try {
    compose = parseDocument(composeContent).toJSON() as Record<string, unknown>;
  } catch {
    return composeContent;
  }

  const services = compose.services as Record<string, Record<string, unknown>> | undefined;
  if (!services) return composeContent;

  const xcBuild = (compose['x-casaos'] as Record<string, unknown> | undefined)?.build;
  const targetName = (typeof xcBuild === 'string' && services[xcBuild])
    ? xcBuild
    : getMainServiceName(compose);
  if (!targetName || !services[targetName]) return composeContent;

  const service = services[targetName];
  if (!Array.isArray(service.volumes)) {
    service.volumes = service.volumes ? [service.volumes] : [];
  }
  const volumes = service.volumes as unknown[];

  for (const f of files) {
    const base = path.basename(f.path);
    const source = `${pcs.DATA_ROOT}/AppData/${appName}/config/${base}`;
    const exists = volumes.some(
      (v) => v && typeof v === 'object' && (v as Record<string, unknown>).target === f.path
    );
    if (exists) continue;
    volumes.push({ type: 'bind', source, target: f.path, read_only: f.readOnly !== false });
  }

  return stringify(compose, { lineWidth: 0 });
}

/**
 * Write user-supplied config files into the bind-mounted config dir.
 * Mirrors writeStatusPage's docker-exec-into-casaos write pattern.
 */
export async function writeConfigFiles(
  appName: string,
  files: Array<{ path: string; body: string }>,
  logFn?: (msg: string) => void
): Promise<void> {
  if (!files.length) return;
  const log = logFn || ((msg: string) => console.log(`[PCS] ${msg}`));
  const pcs = getPCSEnvironment();
  const dir = path.join(pcs.DATA_ROOT, 'AppData', appName, 'config');

  try {
    await execAsync(`docker exec --user ubuntu casaos mkdir -p "${dir}"`, { timeout: 10000 });
    await execAsync(`docker exec casaos chown -R ubuntu:ubuntu "${dir}"`, { timeout: 10000 });
  } catch {
    try {
      fs.mkdirSync(dir, { recursive: true });
      await execAsync(`chown -R 1000:1000 "${dir}"`, { timeout: 5000 });
    } catch (fallbackErr) {
      log(`[PCS] Warning: Could not set ownership on ${dir}: ${fallbackErr}`);
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  for (const f of files) {
    const filePath = path.join(dir, path.basename(f.path));
    fs.writeFileSync(filePath, f.body);
    try {
      await execAsync(`docker exec casaos chown ubuntu:ubuntu "${filePath}"`, { timeout: 10000 });
      await execAsync(`docker exec casaos chmod 644 "${filePath}"`, { timeout: 10000 });
    } catch {
      try {
        await execAsync(`chown 1000:1000 "${filePath}"`, { timeout: 5000 });
        await execAsync(`chmod 644 "${filePath}"`, { timeout: 5000 });
      } catch {
        // Best effort
      }
    }
    log(`[PCS] Wrote config file to ${filePath}`);
  }
}

/**
 * Deliver user-edited config files (from the wizard / post-install editor) by
 * writing them over the HOST source of the bind the repo compose ALREADY declares,
 * so the user's content overrides the repo template on that existing bind - no
 * second bind. Returns the set of container paths it handled, so the caller skips
 * addConfigFileBinds for those (which would otherwise double-bind the same target).
 */
export async function applyUserConfigOverrides(
  composeContent: string,
  appName: string,
  configFiles: Array<{ path: string; body: string }>,
  logFn?: (msg: string) => void,
): Promise<Set<string>> {
  const handled = new Set<string>();
  if (!configFiles.length) return handled;
  const log = logFn || ((msg: string) => console.log(`[PCS] ${msg}`));
  const pcs = getPCSEnvironment();
  const appDataPrefix = `${pcs.DATA_ROOT}/AppData`;

  let compose: Record<string, unknown>;
  try {
    compose = parseDocument(composeContent).toJSON() as Record<string, unknown>;
  } catch {
    return handled;
  }
  const services = compose.services as Record<string, Record<string, unknown>> | undefined;
  if (!services) return handled;

  // Map each container DEST to its AppData host source, for binds under AppData.
  const destToSource = new Map<string, string>();
  for (const service of Object.values(services)) {
    if (!Array.isArray(service.volumes)) continue;
    for (const vol of service.volumes) {
      let src: string | null = null;
      let dest: string | null = null;
      if (typeof vol === 'string') {
        const idx = vol.indexOf(':');
        if (idx > 0) { src = vol.slice(0, idx); dest = vol.slice(idx + 1).split(':')[0]; }
      } else if (vol && typeof vol === 'object') {
        const v = vol as Record<string, unknown>;
        if (typeof v.source === 'string' && typeof v.target === 'string' && v.type !== 'volume') { src = v.source; dest = v.target; }
      }
      if (src && dest && src.startsWith(appDataPrefix)) destToSource.set(dest, src);
    }
  }

  for (const cf of configFiles) {
    const source = destToSource.get(cf.path);
    if (!source) continue;   // not a compose-declared bind -> caller adds a bind instead
    handled.add(cf.path);
    try {
      await ensureVolumeDir(path.dirname(source), log);
      // The user's stored config is authoritative for this bind: replace whatever
      // createVolumeDirectories delivered (the repo template) with the user's body.
      try { await execAsync(`docker exec casaos rm -rf "${source}"`, { timeout: 10000 }); }
      catch { try { fs.rmSync(source, { recursive: true, force: true }); } catch { /* best effort */ } }
      fs.writeFileSync(source, cf.body);
      try {
        await execAsync(`docker exec casaos chown ubuntu:ubuntu "${source}"`, { timeout: 10000 });
        await execAsync(`docker exec casaos chmod 644 "${source}"`, { timeout: 10000 });
      } catch {
        try {
          await execAsync(`chown 1000:1000 "${source}"`, { timeout: 5000 });
          await execAsync(`chmod 644 "${source}"`, { timeout: 5000 });
        } catch { /* best effort */ }
      }
      log(`[PCS] Delivered user config to ${source} (bind ${cf.path})`);
    } catch (err) {
      log(`[PCS] Warning: could not deliver user config for ${cf.path}: ${err}`);
    }
  }
  return handled;
}

function formatDotenvValue(value: string): string {
  const s = (value == null ? '' : String(value)).replace(/[\r\n]+/g, ' ');
  if (s === '' || /[\s#"'$=]/.test(s)) {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return s;
}

/**
 * Write a .env file next to the deployed compose with the bot's effective env
 * vars. General mechanism: services using `env_file:` and any `${VAR}`
 * interpolation in the compose resolve from it. Harmless for composes that use
 * neither (docker compose simply ignores an unreferenced .env).
 */
export async function writeComposeEnvFile(
  appName: string,
  env: Record<string, string>,
  logFn?: (msg: string) => void
): Promise<string> {
  const log = logFn || ((msg: string) => console.log(`[PCS] ${msg}`));
  const pcs = getPCSEnvironment();

  const dir = path.join(pcs.DATA_ROOT, 'AppData', 'casaos', 'apps', appName);
  const filePath = path.join(dir, '.env');
  const lines = Object.entries(env)
    .filter(([key]) => key)
    .map(([key, value]) => `${key}=${formatDotenvValue(value)}`);

  try {
    await execAsync(`docker exec --user ubuntu casaos mkdir -p "${dir}"`, { timeout: 10000 });
  } catch {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
  }

  fs.writeFileSync(filePath, lines.join('\n') + '\n');

  try {
    await execAsync(`docker exec casaos chown ubuntu:ubuntu "${filePath}"`, { timeout: 10000 });
    await execAsync(`docker exec casaos chmod 600 "${filePath}"`, { timeout: 10000 });
  } catch {
    try { await execAsync(`chmod 600 "${filePath}"`, { timeout: 5000 }); } catch { /* best effort */ }
  }

  log(`[PCS] Wrote ${lines.length} env var(s) to ${filePath}`);
  return filePath;
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
 * Only ROOT-owned paths are reassigned (`--from=root`): a service that chowned
 * its own bind mount to its runtime user (e.g. Postgres setting its data dir to
 * uid 999, mode 0700) is left alone, otherwise this would steal it back to 1000
 * and break the container with a permission error.
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
      await execAsync(`docker exec casaos chown -R --from=root ubuntu:ubuntu "${dirPath}"`, {
        timeout: 10000,
      });
    } catch {
      try {
        await execAsync(`chown -R --from=root 1000:1000 "${dirPath}"`, { timeout: 5000 });
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
