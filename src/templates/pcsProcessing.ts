/**
 * PCS Processing Pipeline
 *
 * All compose modifications happen on a single parsed YAML object to avoid
 * corruption from multiple parse/stringify cycles.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { parseDocument, stringify } from 'yaml';
import { capServiceLogs, cappedLogging } from './logCaps';
import { BotConfig, DeploymentMode } from '../types';
import { buildStatusPageService } from './statusPage';
import { findConfigTemplate } from '../config/configTemplates';
import { findAppCapabilities } from '../config/appCapabilities';
import { isCasaOSAvailable } from '../casaos/detector';
import { writeFileKeepingOwner } from '../config/storeFile';

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

/**
 * The network every managed sidecar joins alongside its own compose default,
 * so container names resolve between compose projects and from the manager.
 */
export function sharedNetworkName(mode: DeploymentMode | undefined): string {
  return (mode ?? 'casaos') === 'docker' ? 'dbm_internal' : getPCSEnvironment().REF_NET;
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
export function getAppServiceName(compose: Record<string, unknown>): string | null {
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

/**
 * True when a volume binds the bare build-context root (`.` or `./`) - the dev
 * live-reload overlay pattern `.:/app`. For a locally-built service the image
 * already contains this source (`COPY . .`), and the manager deploys from AppData
 * where `.` does NOT resolve to the repo, so the mount would overlay an empty tree
 * and hide the baked-in code. Such mounts are dropped for built services.
 */
function isBuildContextOverlay(volume: unknown): boolean {
  let source: string | undefined;
  if (typeof volume === 'string') {
    const firstColon = volume.indexOf(':');
    if (firstColon <= 0) return false;
    source = volume.slice(0, firstColon);
  } else if (volume && typeof volume === 'object') {
    const vol = volume as Record<string, unknown>;
    if (vol.type === 'volume') return false;
    if (typeof vol.source === 'string') source = vol.source;
  }
  if (source === undefined) return false;
  return source.trim().replace(/\/+$/, '') === '.';
}

export function processComposeForCasaOS(
  composeContent: string,
  appName: string,
  bot: BotConfig,
  opts: { mode?: DeploymentMode; hostBotDir?: string } = {}
): { content: string; sidecarInjected: boolean; droppedGatewayBinds?: string[] } {
  if ((opts.mode ?? 'casaos') === 'docker') {
    return processComposeForDocker(composeContent, appName, bot, opts.hostBotDir);
  }
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

    // Bot Manager labels. List-form labels (labels: ["k=v"]) are normalized
    // to map form first, like the docker path does: skipping them would
    // deploy the container without the bot-id marker, and the delete
    // remnants gate would then be blind to it.
    if (!service.labels || Array.isArray(service.labels)) {
      const asMap: Record<string, string> = {};
      for (const l of (Array.isArray(service.labels) ? service.labels : []) as unknown[]) {
        if (typeof l !== 'string') continue;
        const eq = l.indexOf('=');
        if (eq > 0) asMap[l.slice(0, eq)] = l.slice(eq + 1);
      }
      service.labels = asMap;
    }
    {
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

    // Hostname + container name on main service. The container name must equal the
    // app's subdomain label: the platform routes <appName>-<APP_DOMAIN> by container
    // name, and AppShield gateways validate the caller against it too.
    if (serviceName === mainServiceName) {
      service.hostname = appName;
      service.container_name = appName;
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
      const builtService = service.build !== undefined;
      const kept = (service.volumes as unknown[]).filter(
        volume => !(builtService && isBuildContextOverlay(volume)),
      );
      if (kept.length === 0) {
        delete service.volumes;
      } else {
        service.volumes = kept.map((volume: unknown) => {
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
          if (idx >= 0) envArr[idx] = `${key}=${composeEnvValue(value)}`;
          else envArr.push(`${key}=${composeEnvValue(value)}`);
        }
      } else if (typeof targetService.environment === 'object') {
        const envObj = targetService.environment as Record<string, string>;
        for (const [key, value] of Object.entries(envVars)) {
          envObj[key] = composeEnvValue(value);
        }
      }
    }
  }

  // ── Fleet control endpoint (marker-driven) ──
  // The wss route targets the app container directly, NOT the AppShield gateway:
  // the control plane authenticates via CONTROL_SECRET and must not sit behind
  // the gateway's browser auth.
  const fleetMark = fleetMarkOfCompose(compose, FLEET_PORT_LABEL);
  if (fleetMark !== null && services[fleetMark.service]) {
    const fleetPort = fleetMark.port;
    const fleetSvc = services[fleetMark.service];
    // The transfer channel has its own marker label and its own carrying
    // service; absent means the app declares one channel and gets no transfer
    // wiring at all.
    const transferMark = fleetMarkOfCompose(compose, FLEET_TRANSFER_PORT_LABEL);
    const transferPort = transferMark !== null && services[transferMark.service] ? transferMark.port : null;
    const transferSvc = transferPort !== null ? services[transferMark!.service] : undefined;
    {
      // Env key names and URL schemes come from the app's capability record;
      // the routes themselves stay label-driven. An app with the marker but no
      // record gets the structural wiring and NO authored env: the manager
      // never guesses another app's key spelling (PLAN_REPLICATION 20.18).
      const cp = findAppCapabilities(bot.sourceUrl)?.controlPlane;
      if (cp) setServiceEnv(fleetSvc, cp.env.port, String(fleetPort));
      if (transferSvc && transferPort !== null && cp?.env.transferPort) setServiceEnv(transferSvc, cp.env.transferPort, String(transferPort));
      if (pcs.APP_DOMAIN) {
        // EVERY fleet node gets the control route (PLAN_STANDBY 3.6): a
        // promotable backup must be dialable in advance. Workers dial the app
        // domain: TLS terminates at Cloudflare with the publicly-trusted
        // wildcard cert, and the request reaches the box with the Host
        // rewritten to the nip.io form. The site therefore needs BOTH names,
        // same as the web tile's caddy_0/caddy_1 pair.
        const fleetHost = `${appName}-fleet-${pcs.APP_DOMAIN}`;
        const idx = nextCaddySiteIndex(fleetSvc.labels);
        setServiceLabel(fleetSvc, `caddy_${idx}`, fleetHost);
        setServiceLabel(fleetSvc, `caddy_${idx}.import`, 'gateway_tls');
        setServiceLabel(fleetSvc, `caddy_${idx}.reverse_proxy`, `{{upstreams ${fleetPort}}}`);
        if (pcs.APP_PUBLIC_IP_DASH) {
          const nipIdx = idx + 1;
          setServiceLabel(fleetSvc, `caddy_${nipIdx}`, `${appName}-fleet-${pcs.APP_PUBLIC_IP_DASH}.nip.io`);
          setServiceLabel(fleetSvc, `caddy_${nipIdx}.import`, 'gateway_tls');
          setServiceLabel(fleetSvc, `caddy_${nipIdx}.reverse_proxy`, `{{upstreams ${fleetPort}}}`);
        }
        if (cp) setServiceEnv(fleetSvc, cp.env.publicUrl, `${cp.urlScheme.secure}://${fleetHost}`);
      }
      if (pcs.APP_DOMAIN && transferSvc && transferPort !== null) {
        // Transfer route (container port from the transfer marker label):
        // EVERY fleet node advertises one, unlike the master-only control
        // route, because migration legs dial in either direction. Same
        // dual-name pair as the fleet site.
        const transferHost = `${appName}-transfer-${pcs.APP_DOMAIN}`;
        const tIdx = nextCaddySiteIndex(transferSvc.labels);
        setServiceLabel(transferSvc, `caddy_${tIdx}`, transferHost);
        setServiceLabel(transferSvc, `caddy_${tIdx}.import`, 'gateway_tls');
        setServiceLabel(transferSvc, `caddy_${tIdx}.reverse_proxy`, `{{upstreams ${transferPort}}}`);
        if (pcs.APP_PUBLIC_IP_DASH) {
          const tNipIdx = tIdx + 1;
          setServiceLabel(transferSvc, `caddy_${tNipIdx}`, `${appName}-transfer-${pcs.APP_PUBLIC_IP_DASH}.nip.io`);
          setServiceLabel(transferSvc, `caddy_${tNipIdx}.import`, 'gateway_tls');
          setServiceLabel(transferSvc, `caddy_${tNipIdx}.reverse_proxy`, `{{upstreams ${transferPort}}}`);
        }
        if (cp?.env.transferUrl) setServiceEnv(transferSvc, cp.env.transferUrl, `${cp.urlScheme.secure}://${transferHost}`);
      }
      // Caddy resolves {{upstreams}} over the ingress network, so every marked
      // service must join it (co-workers too: their transfer route and
      // same-box container-name dials ride it); keep the project default
      // network alongside.
      for (const svc of transferSvc && transferSvc !== fleetSvc ? [fleetSvc, transferSvc] : [fleetSvc]) {
        if (pcs.REF_NET && (!svc.network_mode || svc.network_mode === 'bridge')) {
          if (Array.isArray(svc.networks)) {
            if (!svc.networks.includes(pcs.REF_NET)) svc.networks.push(pcs.REF_NET);
          } else if (svc.networks && typeof svc.networks === 'object') {
            const nets = svc.networks as Record<string, unknown>;
            if (!(pcs.REF_NET in nets)) nets[pcs.REF_NET] = {};
          } else {
            svc.networks = ['default', pcs.REF_NET];
          }
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

  // A repo that ships its own x-casaos block may omit the title, leaving the
  // CasaOS tile with no name. Guarantee a display title and a main service.
  const xcTitle = xcasaos.title as Record<string, unknown> | undefined;
  if (!xcTitle || !xcTitle.en_us) {
    xcasaos.title = { en_us: bot.displayName || appName };
  }
  if (!xcasaos.main) {
    xcasaos.main = mainServiceName || 'bot';
  }

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

  capServiceLogs(services);

  // ── Single stringify ──
  return { content: stringify(compose, { lineWidth: 0 }), sidecarInjected };
}

// ─── Standalone (plain Docker) Compose Processing ──────────────────────────

/** The container port from a single compose `ports`/`expose` entry, or null. */
function containerPortOf(portMapping: unknown): number | null {
  if (typeof portMapping === 'string') {
    const parts = portMapping.split(':');
    const raw = (parts.length > 1 ? parts[parts.length - 1] : parts[0]).split('/')[0];
    const n = parseInt(raw, 10);
    return isNaN(n) ? null : n;
  }
  if (portMapping && typeof portMapping === 'object') {
    const obj = portMapping as Record<string, unknown>;
    if (obj.target !== undefined) {
      const n = parseInt(String(obj.target), 10);
      return isNaN(n) ? null : n;
    }
  }
  return null;
}

/** The host port from a single compose `ports` entry (`H:C`, `IP:H:C`, or
 *  long-form `{published}`), or null when the entry publishes no fixed host port. */
function hostPortOf(portMapping: unknown): number | null {
  if (typeof portMapping === 'string') {
    const parts = portMapping.split('/')[0].split(':');
    if (parts.length < 2) return null;             // "C" - no host port
    const n = parseInt(parts[parts.length - 2], 10);
    return isNaN(n) ? null : n;
  }
  if (portMapping && typeof portMapping === 'object') {
    const obj = portMapping as Record<string, unknown>;
    if (obj.published !== undefined) {
      const n = parseInt(String(obj.published), 10);
      return isNaN(n) ? null : n;
    }
  }
  return null;
}

/**
 * Rewrite a relative bind source to an absolute host path under the bot's host dir,
 * so the daemon (which resolves bind sources as HOST paths) and the manager share
 * the same directory. Named volumes and absolute paths are left untouched.
 */
function rewriteDockerBindSource(source: string, hostBotDir: string, dataRoot: string): string {
  const root = hostBotDir.replace(/\/+$/, '');
  if (source.startsWith('./') || source.startsWith('../')) {
    const rel = source.replace(/^(\.\.?\/)+/, '').replace(/\/+$/, '');
    return rel ? `${root}/${rel}` : root;
  }
  // CasaOS AppData convention (after variable substitution): a bind source under
  // <DATA_ROOT>/AppData/<app>/<rest> is that app's persistent data. In docker mode
  // the app's data dir IS hostBotDir, so drop the <DATA_ROOT>/AppData/<app> prefix
  // and re-root <rest> under hostBotDir. Done by path segment, so it works for any
  // app name and any DATA_ROOT depth (never hardcodes a bot or path).
  const appData = dataRoot.replace(/\/+$/, '') + '/AppData';
  if (source === appData || source.startsWith(appData + '/')) {
    const afterApp = source.slice(appData.length + 1).split('/').slice(1).join('/').replace(/\/+$/, '');
    return afterApp ? `${root}/${afterApp}` : root;
  }
  return source;
}

function rewriteDockerVolume(volume: unknown, hostBotDir: string, dataRoot: string): unknown {
  if (typeof volume === 'string') {
    const i = volume.indexOf(':');
    if (i <= 0) return volume;
    const src = volume.slice(0, i);
    const rewritten = rewriteDockerBindSource(src, hostBotDir, dataRoot);
    if (rewritten === src) return volume;
    return rewritten + volume.slice(i);
  }
  if (volume && typeof volume === 'object') {
    const v = volume as Record<string, unknown>;
    if (typeof v.source === 'string' && v.type !== 'volume') {
      v.source = rewriteDockerBindSource(v.source, hostBotDir, dataRoot);
    }
  }
  return volume;
}

/** Platform ingress labels (Yundera Caddy / caddy-docker-proxy): `caddy`, `caddy.*`, `caddy_N`, `caddy_N.*`. */
function isCaddyLabel(key: string): boolean {
  return key === 'caddy' || key.startsWith('caddy.') || key.startsWith('caddy_');
}

/**
 * Bind a published port to 127.0.0.1 unless the compose pins an explicit host IP.
 * Docker publishes to 0.0.0.0 by default and bypasses host firewalls (ufw), so a
 * repo-declared port must never go public on its own; public access is layered on
 * via the gateway/host-port path.
 */
function bindPortToLocalhost(port: unknown): unknown {
  if (typeof port === 'string' || typeof port === 'number') {
    const s = String(port);
    if (s.includes('[')) return s;                       // bracketed IPv6 host: explicit bind, respect it
    const parts = s.split(':');
    if (parts.length >= 3) return s;                     // IP:HOST:CONTAINER: explicit bind, respect it
    if (parts.length === 2) return `127.0.0.1:${s}`;     // HOST:CONTAINER
    return `127.0.0.1::${s}`;                            // CONTAINER only (random localhost host port)
  }
  if (port && typeof port === 'object') {
    const p = port as Record<string, unknown>;
    if (!p.host_ip) p.host_ip = '127.0.0.1';
    return p;
  }
  return port;
}

function envValueOf(env: unknown, key: string): string | null {
  if (Array.isArray(env)) {
    for (const e of env) {
      if (typeof e === 'string') {
        const i = e.indexOf('=');
        if (i > 0 && e.slice(0, i) === key) return e.slice(i + 1);
      }
    }
    return null;
  }
  if (env && typeof env === 'object') {
    const v = (env as Record<string, unknown>)[key];
    return v === null || v === undefined ? null : String(v);
  }
  return null;
}

/**
 * A fronting auth gateway: a main service whose env names another compose
 * service via BACKEND_HOST/BACKEND_PORT. Null when the shape doesn't match (no
 * gateway, or the backend lives outside this compose).
 */
export function frontingGateway(compose: Record<string, unknown>): { gateway: string; backend: string; backendPort: number } | null {
  const services = compose.services as Record<string, Record<string, unknown>> | undefined;
  if (!services) return null;
  const mainName = getMainServiceName(compose);
  if (!mainName || !services[mainName]) return null;
  const backendHost = envValueOf(services[mainName].environment, 'BACKEND_HOST');
  const backendPort = parseInt(envValueOf(services[mainName].environment, 'BACKEND_PORT') || '', 10);
  if (!backendHost || isNaN(backendPort)) return null;
  const backendName = services[backendHost]
    ? backendHost
    : Object.keys(services).find(n => services[n]?.container_name === backendHost);
  if (!backendName || backendName === mainName) return null;
  return { gateway: mainName, backend: backendName, backendPort };
}

/**
 * Whether a deploy in this mode with this webAuth drops a fronting gateway. On
 * the docker stack the boundary is the localhost bind or the bundled Authelia;
 * webAuth=public keeps the bot's own gate, and a non-loopback BOT_PORT_BIND with
 * no domain route keeps it as the only boundary. CasaOS always keeps it.
 */
export function frontingGatewayDropped(mode: DeploymentMode, webAuth: BotConfig['webAuth']): boolean {
  if (mode !== 'docker' || webAuth === 'public') return false;
  return isLoopbackBind(botPortBind()) || !!process.env.BOT_DOMAIN_BASE;
}

/**
 * Remove a fronting auth-gateway main service and repoint the compose's web entry
 * (x-casaos main + webui_port) at the backend service it proxied.
 */
function stripFrontingGateway(compose: Record<string, unknown>): void {
  const services = compose.services as Record<string, Record<string, unknown>> | undefined;
  if (!services) return;
  const found = frontingGateway(compose);
  if (!found) return;
  const { gateway: mainName, backend: backendName, backendPort } = found;

  delete services[mainName];
  for (const svc of Object.values(services)) {
    if (Array.isArray(svc.depends_on)) {
      svc.depends_on = (svc.depends_on as unknown[]).filter(d => d !== mainName);
      if ((svc.depends_on as unknown[]).length === 0) delete svc.depends_on;
    } else if (svc.depends_on && typeof svc.depends_on === 'object') {
      delete (svc.depends_on as Record<string, unknown>)[mainName];
      if (Object.keys(svc.depends_on as Record<string, unknown>).length === 0) delete svc.depends_on;
    }
  }
  if (!compose['x-casaos'] || typeof compose['x-casaos'] !== 'object') compose['x-casaos'] = {};
  const xcasaos = compose['x-casaos'] as Record<string, unknown>;
  xcasaos.main = backendName;
  xcasaos.webui_port = backendPort;
}

/**
 * Process a compose for a plain-Docker (non-CasaOS) deployment. Unlike the CasaOS
 * path it KEEPS published `ports` (host access is via host ports, not a gateway)
 * but rebinds them to 127.0.0.1 unless the compose pins an explicit host IP,
 * strips the external `pcs` network + platform Caddy labels, and never rewrites
 * paths to /DATA. When hostBotDir is given, relative bind sources are rewritten to
 * absolute host paths under it so sibling-container bind mounts align with the
 * manager. A fronting auth gateway is dropped here (see stripFrontingGateway);
 * host-port publishing is layered on separately by publishHostPort().
 */
export function processComposeForDocker(
  composeContent: string,
  appName: string,
  bot: BotConfig,
  hostBotDir?: string
): { content: string; sidecarInjected: boolean; droppedGatewayBinds?: string[] } {
  const pcs = getPCSEnvironment();
  const compose = parseDocument(composeContent).toJSON() as Record<string, unknown>;

  delete compose.version;
  if (!compose.name) compose.name = appName;

  const services = compose.services as Record<string, Record<string, unknown>> | undefined;
  if (!services) {
    return { content: stringify(compose, { lineWidth: 0 }), sidecarInjected: false };
  }

  // A fronting auth gateway (e.g. AppShield) is the YUNDERA boundary; here it
  // would only double-gate the web UI.
  let droppedGatewayBinds: string[] = [];
  if (frontingGatewayDropped('docker', bot.webAuth)) {
    droppedGatewayBinds = frontingGatewayBindTargets(compose);
    stripFrontingGateway(compose);
  }

  const infraServiceNames = new Set(['redis', 'postgres', 'db', 'mongo', 'mongodb', 'mariadb', 'mysql', 'lavalink']);

  for (const [serviceName, service] of Object.entries(services)) {
    if (service.profiles !== undefined) delete service.profiles;

    if (service.cpu_shares === undefined) {
      service.cpu_shares = infraServiceNames.has(serviceName) ? 10 : 50;
    }

    // Strip platform Caddy labels a repo compose may ship: on the remote stack
    // caddy-docker-proxy would ingest them (an undefined `import gateway_tls`
    // wedges the Caddyfile). attachBotToProxy re-adds bundled-Caddy labels later.
    if (Array.isArray(service.labels)) {
      service.labels = (service.labels as unknown[]).filter(
        l => !(typeof l === 'string' && isCaddyLabel(l.split('=')[0].trim()))
      );
    }
    if (!service.labels || Array.isArray(service.labels)) {
      // Normalize to map form so the manager markers below always apply.
      const asMap: Record<string, string> = {};
      for (const l of (Array.isArray(service.labels) ? service.labels : []) as unknown[]) {
        if (typeof l !== 'string') continue;
        const eq = l.indexOf('=');
        if (eq > 0) asMap[l.slice(0, eq)] = l.slice(eq + 1);
      }
      service.labels = asMap;
    }
    {
      const labels = service.labels as Record<string, string>;
      for (const key of Object.keys(labels)) {
        if (isCaddyLabel(key)) delete labels[key];
      }
      labels['managed-by'] = 'discord-bot-manager';
      labels['bot-id'] = bot.id;
      labels['bot-name'] = bot.displayName;
    }

    // Published ports stay usable but bind to localhost (see bindPortToLocalhost).
    if (Array.isArray(service.ports)) {
      service.ports = (service.ports as unknown[]).map(bindPortToLocalhost);
    }

    // Drop the dev build-context overlay for built services (it would hide
    // baked-in code). Rewrite relative bind sources to absolute host paths so
    // sibling-container mounts align with the manager (see docstring).
    if (service.volumes && Array.isArray(service.volumes)) {
      const builtService = service.build !== undefined;
      let kept = (service.volumes as unknown[]).filter(
        v => !(builtService && isBuildContextOverlay(v)),
      );
      if (hostBotDir) kept = kept.map(v => rewriteDockerVolume(v, hostBotDir, pcs.DATA_ROOT));
      if (kept.length === 0) delete service.volumes;
      else service.volumes = kept;
    }

    // Strip the external `pcs` network (CasaOS-only); keep project-local networks.
    if (Array.isArray(service.networks)) {
      service.networks = (service.networks as unknown[]).filter(n => n !== pcs.REF_NET);
      if ((service.networks as unknown[]).length === 0) delete service.networks;
    } else if (service.networks && typeof service.networks === 'object') {
      delete (service.networks as Record<string, unknown>)[pcs.REF_NET];
      if (Object.keys(service.networks as Record<string, unknown>).length === 0) delete service.networks;
    }

    // PUID/PGID/TZ injection (reaches containers; lost otherwise in docker mode).
    if (!service.environment) service.environment = {};
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
    if (Array.isArray(service.environment)) {
      if (!service.environment.some((e: unknown) => typeof e === 'string' && /^TZ=/i.test(e))) {
        service.environment.push(`TZ=${pcs.TZ}`);
      }
    } else if (typeof service.environment === 'object') {
      const env = service.environment as Record<string, string>;
      if (!Object.keys(env).some(k => k.toUpperCase() === 'TZ')) env.TZ = pcs.TZ;
    }
  }

  // Merge user-configured env vars into the app (build-target / first non-infra)
  // service, matching the CasaOS path.
  if (bot.envVars && Object.keys(bot.envVars).length > 0) {
    const targetServiceName = getAppServiceName(compose);
    if (targetServiceName && services[targetServiceName]) {
      const targetService = services[targetServiceName];
      if (!targetService.environment) targetService.environment = {};
      if (Array.isArray(targetService.environment)) {
        const envArr = targetService.environment as string[];
        for (const [key, value] of Object.entries(bot.envVars)) {
          const idx = envArr.findIndex((e: string) => e.startsWith(`${key}=`));
          if (idx >= 0) envArr[idx] = `${key}=${composeEnvValue(value)}`;
          else envArr.push(`${key}=${composeEnvValue(value)}`);
        }
      } else if (typeof targetService.environment === 'object') {
        const envObj = targetService.environment as Record<string, string>;
        for (const [key, value] of Object.entries(bot.envVars)) envObj[key] = composeEnvValue(value);
      }
    }
  }

  // Drop the external `pcs` network definition (CasaOS-only).
  if (compose.networks && typeof compose.networks === 'object') {
    const networks = compose.networks as Record<string, unknown>;
    delete networks[pcs.REF_NET];
    if (Object.keys(networks).length === 0) delete compose.networks;
  }

  // Attach the app service to the shared dbm_internal network so it can reach the
  // manager API (BOT_MANAGER_INTERNAL_URL) across compose projects. External here:
  // the manager's own stack owns/creates the network.
  const appServiceName = getAppServiceName(compose);
  if (appServiceName && services[appServiceName]) {
    const appSvc = services[appServiceName];
    if (Array.isArray(appSvc.networks)) {
      if (!(appSvc.networks as unknown[]).includes('dbm_internal')) {
        (appSvc.networks as unknown[]).push('dbm_internal');
      }
    } else if (appSvc.networks && typeof appSvc.networks === 'object') {
      const nets = appSvc.networks as Record<string, unknown>;
      if (!('dbm_internal' in nets)) nets['dbm_internal'] = {};
    } else {
      // No explicit networks: keep the implicit project network too, or the app
      // would leave `default` and lose its own infra services (db, lavalink).
      appSvc.networks = ['default', 'dbm_internal'];
    }
    if (!compose.networks || typeof compose.networks !== 'object') compose.networks = {};
    const topNets = compose.networks as Record<string, unknown>;
    if (!topNets['dbm_internal']) topNets['dbm_internal'] = { name: 'dbm_internal', external: true };
  }

  // The control/transfer port env each follow their own marker label and land
  // on the service CARRYING it, spelled by the app's capability record (no
  // record = no authored env); exposure (proxy route or localhost publish) is
  // layered on by applyDockerHostPort.
  const fleetMark = fleetMarkOfCompose(compose, FLEET_PORT_LABEL);
  if (fleetMark !== null) {
    const cp = findAppCapabilities(bot.sourceUrl)?.controlPlane;
    if (services[fleetMark.service] && cp) {
      setServiceEnv(services[fleetMark.service], cp.env.port, String(fleetMark.port));
      const transferMark = fleetMarkOfCompose(compose, FLEET_TRANSFER_PORT_LABEL);
      if (transferMark !== null && services[transferMark.service] && cp.env.transferPort) {
        setServiceEnv(services[transferMark.service], cp.env.transferPort, String(transferMark.port));
      }
    }
  }

  capServiceLogs(services);
  return { content: stringify(compose, { lineWidth: 0 }), sidecarInjected: false, droppedGatewayBinds };
}

/** The in-container targets of the fronting gateway's volumes; empty when there is no gateway. */
export function frontingGatewayBindTargets(compose: Record<string, unknown>): string[] {
  const found = frontingGateway(compose);
  if (!found) return [];
  const service = (compose.services as Record<string, Record<string, unknown>>)[found.gateway];
  if (!service || !Array.isArray(service.volumes)) return [];
  const out: string[] = [];
  for (const vol of service.volumes as unknown[]) {
    if (typeof vol === 'string') { const s = splitDockerVolume(vol); if (s?.dest) out.push(s.dest); }
    else if (vol && typeof vol === 'object' && typeof (vol as Record<string, unknown>).target === 'string') out.push((vol as Record<string, unknown>).target as string);
  }
  return out;
}

/**
 * The bot's web UI port for host-port publishing in docker mode. Prefers the main
 * service's first `ports` entry (reporting any host port the compose ALREADY
 * publishes, so we reuse it instead of allocating a duplicate), else
 * x-casaos.webui_port, else the first `expose` entry. Returns null for a headless
 * bot (nothing to publish).
 */
export function getMainServiceWebPort(
  composeContent: string
): { containerPort: number; existingHostPort: number | null } | null {
  let compose: Record<string, unknown>;
  try {
    compose = parseDocument(composeContent).toJSON() as Record<string, unknown>;
  } catch {
    return null;
  }
  const services = compose.services as Record<string, Record<string, unknown>> | undefined;
  if (!services) return null;

  const xcasaos = compose['x-casaos'] as Record<string, unknown> | undefined;
  const webuiPort = (): number | null => {
    if (xcasaos?.webui_port === undefined) return null;
    const p = parseInt(String(xcasaos.webui_port), 10);
    return isNaN(p) ? null : p;
  };

  const mainName = getMainServiceName(compose);
  const svc = mainName ? services[mainName] : undefined;

  if (svc && Array.isArray(svc.ports)) {
    for (const pm of svc.ports as unknown[]) {
      const cp = containerPortOf(pm);
      if (cp !== null) return { containerPort: cp, existingHostPort: hostPortOf(pm) };
    }
  }

  const wp = webuiPort();
  if (wp !== null) return { containerPort: wp, existingHostPort: null };

  if (svc && Array.isArray(svc.expose) && (svc.expose as unknown[]).length > 0) {
    const p = parseInt(String((svc.expose as unknown[])[0]).split('/')[0], 10);
    if (!isNaN(p)) return { containerPort: p, existingHostPort: null };
  }
  return null;
}

/**
 * The web UI entry path the bot declares via x-casaos.index (e.g. "/dashboard").
 * Returns null when no index is declared or it is just "/" (the caller then defaults
 * to root). Auth is the gateway's job (AppShield / Authelia), not a URL param.
 */
export function getWebUiIndexPath(composeContent: string): string | null {
  let compose: Record<string, unknown>;
  try {
    compose = parseDocument(composeContent).toJSON() as Record<string, unknown>;
  } catch {
    return null;
  }
  const xcasaos = compose['x-casaos'] as Record<string, unknown> | undefined;
  const index = xcasaos?.index;
  if (typeof index !== 'string' || index.trim() === '' || index.trim() === '/') return null;
  return index;
}

export function botPortBind(): string {
  return process.env.BOT_PORT_BIND || '127.0.0.1';
}

export function isLoopbackBind(bind: string): boolean {
  const b = bind.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return b === 'localhost' || b === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(b);
}

/**
 * True when publishing on an off-loopback BOT_PORT_BIND would put the kept gateway's
 * login on the public 'casaos' fallback: the main service carries a PASSWORD env and
 * neither the bot's WEBUI_PASSWORD nor APP_DEFAULT_PASSWORD sets it.
 */
export function gatewayOnDefaultPassword(composeContent: string, webuiPasswordSet: boolean): boolean {
  if (isLoopbackBind(botPortBind()) || webuiPasswordSet || process.env.APP_DEFAULT_PASSWORD) return false;
  let compose: Record<string, unknown>;
  try {
    compose = parseDocument(composeContent).toJSON() as Record<string, unknown>;
  } catch {
    return true;
  }
  const services = compose.services as Record<string, Record<string, unknown>> | undefined;
  const mainName = getMainServiceName(compose);
  const env = mainName && services?.[mainName]?.environment;
  if (Array.isArray(env)) return env.some(e => typeof e === 'string' && /^PASSWORD(=|$)/.test(e));
  return !!env && typeof env === 'object' && 'PASSWORD' in env;
}

/**
 * Ensure the main web service publishes containerPort on hostPort (docker mode).
 * A mapping that already targets containerPort is left untouched.
 */
export function publishHostPort(
  composeContent: string,
  hostPort: number,
  containerPort: number
): string {
  let compose: Record<string, unknown>;
  try {
    compose = parseDocument(composeContent).toJSON() as Record<string, unknown>;
  } catch {
    return composeContent;
  }
  const services = compose.services as Record<string, Record<string, unknown>> | undefined;
  if (!services) return composeContent;
  const mainName = getMainServiceName(compose);
  if (!mainName || !services[mainName]) return composeContent;

  const svc = services[mainName];
  if (!Array.isArray(svc.ports)) svc.ports = svc.ports ? [svc.ports] : [];
  const ports = svc.ports as unknown[];
  if (!ports.some(pm => containerPortOf(pm) === containerPort)) {
    // Bind to localhost by default: a published port BYPASSES host firewalls
    // (Docker writes its own nat/FORWARD rules), so 0.0.0.0 would expose the bot
    // to the internet on a VPS. Reach it via the bundled proxy or a tunnel.
    // Set BOT_PORT_BIND=0.0.0.0 to opt into all-interfaces (trusted LAN only).
    const bind = botPortBind();
    if (!isLoopbackBind(bind)) {
      console.warn(`[Docker] Publishing host port ${hostPort} on ${bind} (BOT_PORT_BIND): reachable from other hosts, not only this machine`);
    }
    const mapping = (bind && bind !== '0.0.0.0') ? `${bind}:${hostPort}:${containerPort}` : `${hostPort}:${containerPort}`;
    ports.push(mapping);
  }
  return stringify(compose, { lineWidth: 0 });
}

/**
 * Attach the bot's main web service to the shared ingress network and stamp
 * caddy-docker-proxy labels so the bundled Caddy (remote-access stack) serves it at
 * `host` over automatic TLS. Used in docker mode only when a public base domain is
 * configured. The bot keeps its localhost host-port too (tunnel fallback).
 * `forwardAuth` gates the vhost behind the stack's Authelia (same labels as the
 * manager's own vhost in docker-compose.remote.yml).
 */
export function attachBotToProxy(
  composeContent: string,
  host: string,
  containerPort: number,
  opts: { network?: string; forwardAuth?: boolean } = {}
): string {
  const network = opts.network || 'dbm_remote';
  let compose: Record<string, unknown>;
  try {
    compose = parseDocument(composeContent).toJSON() as Record<string, unknown>;
  } catch {
    return composeContent;
  }
  const services = compose.services as Record<string, Record<string, unknown>> | undefined;
  if (!services) return composeContent;
  const mainName = getMainServiceName(compose);
  if (!mainName || !services[mainName]) return composeContent;
  const svc = services[mainName];

  if (!svc.labels || Array.isArray(svc.labels) || typeof svc.labels !== 'object') svc.labels = {};
  const labels = svc.labels as Record<string, string>;
  labels['caddy'] = host;
  labels['caddy.reverse_proxy'] = `{{upstreams ${containerPort}}}`;
  if (opts.forwardAuth) {
    labels['caddy.forward_auth'] = 'authelia:9091';
    labels['caddy.forward_auth.uri'] = '/api/authz/forward-auth';
    labels['caddy.forward_auth.copy_headers'] = 'Remote-User Remote-Groups Remote-Email Remote-Name';
  }

  if (Array.isArray(svc.networks)) {
    if (!(svc.networks as unknown[]).includes(network)) (svc.networks as unknown[]).push(network);
  } else if (svc.networks && typeof svc.networks === 'object') {
    (svc.networks as Record<string, unknown>)[network] = {};
  } else {
    svc.networks = ['default', network];
  }

  if (!compose.networks || typeof compose.networks !== 'object') compose.networks = {};
  const nets = compose.networks as Record<string, unknown>;
  if (!nets[network]) nets[network] = { name: network, external: true };

  return stringify(compose, { lineWidth: 0 });
}

/**
 * True when the main web service declares an auth-gateway env key - `OIDC_REGISTRAR_URL`
 * (AppShield OIDC), `AUTH_HASH` (hash-lock), `CREDENTIAL_VALIDATE_URL` (credential
 * bridge), or the `USER`+`PASSWORD` pair (login form) - the structural marker of a
 * self-authenticating gateway/app that needs no forward_auth in front of it. Purely
 * structural, never tied to a specific bot or image.
 */
export function mainServiceSelfAuths(composeContent: string): boolean {
  let compose: Record<string, unknown>;
  try {
    compose = parseDocument(composeContent).toJSON() as Record<string, unknown>;
  } catch {
    return false;
  }
  const services = compose.services as Record<string, Record<string, unknown>> | undefined;
  if (!services) return false;
  const mainName = getMainServiceName(compose);
  const env = mainName ? services[mainName]?.environment : undefined;
  // Values must be non-empty: this runs on the substituted compose, and an empty
  // auth env (e.g. blank $WEBUI_USER/$WEBUI_PASSWORD) disables the gateway's auth
  // entirely, so it must NOT count as self-authenticating.
  const vals = new Map<string, string>();
  if (Array.isArray(env)) {
    for (const e of env) {
      if (typeof e === 'string') {
        const i = e.indexOf('=');
        vals.set(i === -1 ? e : e.slice(0, i), i === -1 ? '' : e.slice(i + 1));
      }
    }
  } else if (env && typeof env === 'object') {
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      vals.set(k, v === null || v === undefined ? '' : String(v));
    }
  }
  const set = (k: string) => (vals.get(k) || '').trim() !== '';
  const MARKERS = ['OIDC_REGISTRAR_URL', 'AUTH_HASH', 'CREDENTIAL_VALIDATE_URL'];
  return MARKERS.some(set) || (set('USER') && set('PASSWORD'));
}

// ─── Fleet Control Plane ───────────────────────────────────────────────────

// Structural marker: a service label `fleet.control-port: <port>` declares that
// the bot runs a fleet control plane (WS server) on that container port. All
// fleet wiring keys off this label, never off a bot name or image.
const FLEET_PORT_LABEL = 'fleet.control-port';
// Second channel, same rule: an absent label is how an app says "I have one
// channel" - no transfer wiring is authored for it.
const FLEET_TRANSFER_PORT_LABEL = 'fleet.transfer-port';

function labelKeysOf(labels: unknown): string[] {
  if (Array.isArray(labels)) {
    return (labels as unknown[])
      .filter((l): l is string => typeof l === 'string')
      .map(l => l.split('=')[0].trim());
  }
  if (labels && typeof labels === 'object') return Object.keys(labels as Record<string, unknown>);
  return [];
}

function labelValueOf(labels: unknown, key: string): string | null {
  if (Array.isArray(labels)) {
    for (const l of labels as unknown[]) {
      if (typeof l !== 'string') continue;
      const eq = l.indexOf('=');
      if (eq > 0 && l.slice(0, eq).trim() === key) return l.slice(eq + 1).trim();
    }
    return null;
  }
  if (labels && typeof labels === 'object') {
    const v = (labels as Record<string, unknown>)[key];
    return v === undefined || v === null ? null : String(v);
  }
  return null;
}

function setServiceLabel(service: Record<string, unknown>, key: string, value: string): void {
  if (!service.labels) service.labels = {};
  if (Array.isArray(service.labels)) (service.labels as unknown[]).push(`${key}=${value}`);
  else (service.labels as Record<string, string>)[key] = value;
}

function setServiceEnv(service: Record<string, unknown>, key: string, value: string): void {
  if (!service.environment) service.environment = {};
  if (Array.isArray(service.environment)) {
    const arr = service.environment as unknown[];
    const idx = arr.findIndex(e => typeof e === 'string' && (e as string).split('=')[0] === key);
    if (idx >= 0) arr[idx] = `${key}=${value}`;
    else arr.push(`${key}=${value}`);
  } else if (typeof service.environment === 'object') {
    (service.environment as Record<string, string>)[key] = value;
  }
}

/** Next unused caddy site index on a service (a plain `caddy` label counts as 0). */
function nextCaddySiteIndex(labels: unknown): number {
  let next = 0;
  for (const key of labelKeysOf(labels)) {
    if (key === 'caddy' || key.startsWith('caddy.')) next = Math.max(next, 1);
    const m = key.match(/^caddy_(\d+)($|\.)/);
    if (m) next = Math.max(next, parseInt(m[1], 10) + 1);
  }
  return next;
}

// Resolves a marker to the SERVICE CARRYING IT plus its port, so every fleet
// consumer wires the marked service; getAppServiceName follows a different
// rule and may disagree for an app whose marker sits on a non-main service.
function fleetMarkOfCompose(
  compose: Record<string, unknown>,
  label: string
): { service: string; port: number } | null {
  const services = compose.services as Record<string, Record<string, unknown>> | undefined;
  if (!services) return null;
  const main = getMainServiceName(compose);
  const ordered = main
    ? [main, ...Object.keys(services).filter(n => n !== main)]
    : Object.keys(services);
  for (const name of ordered) {
    const value = labelValueOf(services[name]?.labels, label);
    if (value !== null) {
      const port = parseInt(value, 10);
      return isNaN(port) ? null : { service: name, port };
    }
  }
  return null;
}

function fleetControlPortOfCompose(compose: Record<string, unknown>): number | null {
  return fleetMarkOfCompose(compose, FLEET_PORT_LABEL)?.port ?? null;
}

function fleetTransferPortOfCompose(compose: Record<string, unknown>): number | null {
  return fleetMarkOfCompose(compose, FLEET_TRANSFER_PORT_LABEL)?.port ?? null;
}

function parsedCompose(composeContent: string): Record<string, unknown> | null {
  try {
    return parseDocument(composeContent).toJSON() as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The fleet control port declared by the compose's marker label, or null. */
export function getFleetControlPort(composeContent: string): number | null {
  const compose = parsedCompose(composeContent);
  return compose ? fleetControlPortOfCompose(compose) : null;
}

/** The fleet transfer port declared by the compose's marker label, or null. */
export function getFleetTransferPort(composeContent: string): number | null {
  const compose = parsedCompose(composeContent);
  return compose ? fleetTransferPortOfCompose(compose) : null;
}

/** The service carrying the fleet control marker, with its declared port. */
export function getFleetControlService(composeContent: string): { service: string; port: number } | null {
  const compose = parsedCompose(composeContent);
  return compose ? fleetMarkOfCompose(compose, FLEET_PORT_LABEL) : null;
}

/** The service carrying the fleet transfer marker, with its declared port. */
export function getFleetTransferService(composeContent: string): { service: string; port: number } | null {
  const compose = parsedCompose(composeContent);
  return compose ? fleetMarkOfCompose(compose, FLEET_TRANSFER_PORT_LABEL) : null;
}

/**
 * Public hostname of this instance's fleet control endpoint, or null when no
 * public base exists for the mode (e.g. standalone/Windows). Mirrors the web UI
 * host construction: `<name>-fleet-<APP_DOMAIN>` on Yundera,
 * `<name>-fleet.<BOT_DOMAIN_BASE>` on the remote docker stack.
 */
export function fleetPublicHost(sanitizedName: string, mode?: DeploymentMode): string | null {
  const suffix = fleetHostSuffix(mode);
  return suffix === null ? null : `${sanitizedName}${suffix}`;
}

/**
 * Mode-resolved part of the fleet host after the instance name, or null when no
 * publicly-trusted base exists. The fleet endpoint is reached by machine clients
 * (workers), so the dialed host must present a publicly-trusted cert: the app
 * domain on Yundera (TLS terminates at Cloudflare, so clients never see the
 * custom-CA gateway cert), the ACME-issued `<base>` on the remote stack. Lets
 * clients preview a fleet URL before install.
 */
export function fleetHostSuffix(mode?: DeploymentMode): string | null {
  const appDomain = process.env.APP_DOMAIN || '';
  if (appDomain && mode !== 'docker') return `-fleet-${appDomain}`;
  const domainBase = process.env.BOT_DOMAIN_BASE || '';
  if (domainBase && mode !== 'casaos') return `-fleet.${domainBase}`;
  return null;
}

/**
 * Public hostname of this instance's transfer endpoint (shard-migration data
 * channel), or null when no public base exists. Same bases and trust rules as
 * the fleet host; the transfer port comes from the fleet.transfer-port marker.
 */
export function transferPublicHost(sanitizedName: string): string | null {
  const suffix = transferHostSuffix();
  return suffix === null ? null : `${sanitizedName}${suffix}`;
}

export function transferHostSuffix(): string | null {
  const appDomain = process.env.APP_DOMAIN || '';
  if (appDomain) return `-transfer-${appDomain}`;
  const domainBase = process.env.BOT_DOMAIN_BASE || '';
  if (domainBase) return `-transfer.${domainBase}`;
  return null;
}

/**
 * App-service container name for same-box dials: it is globally unique (Docker
 * enforces uniqueness) and embedded DNS resolves it for any container sharing
 * the network. Falls back to the service name, which Compose also registers as
 * a network alias; the manager's name substitution keeps that unique too. Null
 * when the compose cannot be parsed.
 */
export function fleetAppContainerName(composeContent: string): string | null {
  try {
    const compose = parseDocument(composeContent).toJSON() as Record<string, unknown>;
    const svcName = getAppServiceName(compose);
    if (!svcName) return null;
    const services = compose.services as Record<string, Record<string, unknown>> | undefined;
    const cname = services?.[svcName]?.container_name;
    if (typeof cname === 'string' && cname.trim()) return cname.trim();
    return svcName;
  } catch {
    return null;
  }
}

/**
 * Remote-mode fleet route: caddy-docker-proxy labels on `opts.service` (the
 * service carrying the channel's marker label) so the bundled Caddy serves the
 * fleet endpoint at `host` over automatic TLS. `envAdvertise` names the env
 * key and URL scheme the app reads the finished route through (both from the
 * capability record); it is stated per call so two routes can never silently
 * write one key, and null (no record) attaches the route without authoring any
 * env. Never forward_auth: workers are machine clients that authenticate with
 * the app's own shared secret, not Authelia.
 */
export function attachFleetToProxy(
  composeContent: string,
  host: string,
  controlPort: number,
  opts: { network?: string; envAdvertise: { key: string; scheme: string } | null; service: string }
): string {
  const network = opts.network || 'dbm_remote';
  let compose: Record<string, unknown>;
  try {
    compose = parseDocument(composeContent).toJSON() as Record<string, unknown>;
  } catch {
    return composeContent;
  }
  const services = compose.services as Record<string, Record<string, unknown>> | undefined;
  if (!services) return composeContent;
  if (!services[opts.service]) return composeContent;
  const svc = services[opts.service];

  if (!svc.labels || Array.isArray(svc.labels) || typeof svc.labels !== 'object') svc.labels = {};
  const labels = svc.labels as Record<string, string>;
  const prefix = `caddy_${nextCaddySiteIndex(labels)}`;
  labels[prefix] = host;
  labels[`${prefix}.reverse_proxy`] = `{{upstreams ${controlPort}}}`;

  if (Array.isArray(svc.networks)) {
    if (!(svc.networks as unknown[]).includes(network)) (svc.networks as unknown[]).push(network);
  } else if (svc.networks && typeof svc.networks === 'object') {
    (svc.networks as Record<string, unknown>)[network] = {};
  } else {
    svc.networks = ['default', network];
  }
  if (!compose.networks || typeof compose.networks !== 'object') compose.networks = {};
  const nets = compose.networks as Record<string, unknown>;
  if (!nets[network]) nets[network] = { name: network, external: true };

  if (opts.envAdvertise) setServiceEnv(svc, opts.envAdvertise.key, `${opts.envAdvertise.scheme}://${host}`);
  return stringify(compose, { lineWidth: 0 });
}

/** An already-published host port for a fleet channel port on its marked service, or null. */
export function getPublishedFleetHostPort(composeContent: string, containerPort: number, service: string): number | null {
  let compose: Record<string, unknown>;
  try {
    compose = parseDocument(composeContent).toJSON() as Record<string, unknown>;
  } catch {
    return null;
  }
  const services = compose.services as Record<string, Record<string, unknown>> | undefined;
  if (!services) return null;
  const svc = services[service];
  if (!svc || !Array.isArray(svc.ports)) return null;
  for (const pm of svc.ports as unknown[]) {
    if (containerPortOf(pm) === containerPort) return hostPortOf(pm);
  }
  return null;
}

/**
 * Publish the fleet control port on the host (docker mode) for host-level
 * tooling; same-box workers dial the master's container name over the shared
 * network instead. Always 127.0.0.1-bound: a published port bypasses host
 * firewalls, and the control plane must never go public this way (public
 * access is the Caddy wss route).
 */
export function publishFleetHostPort(
  composeContent: string,
  hostPort: number,
  containerPort: number,
  service: string
): string {
  let compose: Record<string, unknown>;
  try {
    compose = parseDocument(composeContent).toJSON() as Record<string, unknown>;
  } catch {
    return composeContent;
  }
  const services = compose.services as Record<string, Record<string, unknown>> | undefined;
  if (!services) return composeContent;
  if (!services[service]) return composeContent;
  const svc = services[service];
  if (!Array.isArray(svc.ports)) svc.ports = svc.ports ? [svc.ports] : [];
  const ports = svc.ports as unknown[];
  if (!ports.some(pm => containerPortOf(pm) === containerPort)) {
    ports.push(`127.0.0.1:${hostPort}:${containerPort}`);
  }
  return stringify(compose, { lineWidth: 0 });
}

/**
 * Inject the manager-provisioned fleet Postgres sidecar into a processed compose.
 * Joins the project's default network AND the shared cross-project network (pcs
 * on CasaOS, dbm_internal in docker mode) so same-host co-workers in other
 * compose projects can dial it by container name, like the control port. Data
 * lives on a NAMED volume (never a bind mount) and no host port is ever
 * published. The app service's depends_on stays condition-free: the bot
 * tolerates start-order races by design.
 */
export function addFleetPostgresService(
  composeContent: string,
  bot: BotConfig,
  db: { containerName: string; volume: string; password: string; user: string; db: string },
  opts: { mode?: DeploymentMode } = {}
): string {
  let compose: Record<string, unknown>;
  try {
    compose = parseDocument(composeContent).toJSON() as Record<string, unknown>;
  } catch {
    return composeContent;
  }
  const services = compose.services as Record<string, Record<string, unknown>> | undefined;
  if (!services) return composeContent;

  const sharedNet = sharedNetworkName(opts.mode);
  const serviceName = 'fleet-postgres';
  const volumeKey = 'fleet-postgres-data';
  const appSvcName = getAppServiceName(compose);

  services[serviceName] = {
    image: 'postgres:16-alpine',
    container_name: db.containerName,
    restart: 'unless-stopped',
    cpu_shares: 10,
    logging: cappedLogging(),
    environment: {
      POSTGRES_USER: db.user,
      POSTGRES_DB: db.db,
      POSTGRES_PASSWORD: db.password,
    },
    volumes: [{ type: 'volume', source: volumeKey, target: '/var/lib/postgresql/data' }],
    healthcheck: {
      test: ['CMD-SHELL', `pg_isready -U ${db.user} -d ${db.db}`],
      interval: '10s',
      timeout: '5s',
      retries: 5,
    },
    networks: sharedNet ? ['default', sharedNet] : ['default'],
    labels: {
      'managed-by': 'discord-bot-manager',
      'bot-id': bot.id,
      'service-type': 'fleet-database',
    },
  };

  if (!compose.volumes || typeof compose.volumes !== 'object') compose.volumes = {};
  (compose.volumes as Record<string, unknown>)[volumeKey] = { name: db.volume };

  if (sharedNet) {
    if (!compose.networks || typeof compose.networks !== 'object') compose.networks = {};
    const nets = compose.networks as Record<string, unknown>;
    if (!nets[sharedNet]) nets[sharedNet] = { name: sharedNet, external: true };
  }

  addAppDependency(services, appSvcName, serviceName);

  return stringify(compose, { lineWidth: 0 });
}

/** Make the app service depend on serviceKey (list or map form, idempotent). */
export function addAppDependsOn(composeContent: string, serviceKey: string): string {
  let compose: Record<string, unknown>;
  try {
    compose = parseDocument(composeContent).toJSON() as Record<string, unknown>;
  } catch {
    return composeContent;
  }
  const services = compose?.services as Record<string, Record<string, unknown>> | undefined;
  if (!services || !services[serviceKey]) return composeContent;
  const before = JSON.stringify(services);
  addAppDependency(services, getAppServiceName(compose), serviceKey);
  if (JSON.stringify(services) === before) return composeContent;
  return stringify(compose, { lineWidth: 0 });
}

function addAppDependency(services: Record<string, Record<string, unknown>>, appSvcName: string | null | undefined, serviceName: string): void {
  const appSvc = appSvcName && appSvcName !== serviceName ? services[appSvcName] : undefined;
  if (!appSvc) return;
  if (Array.isArray(appSvc.depends_on)) {
    if (!(appSvc.depends_on as unknown[]).includes(serviceName)) {
      (appSvc.depends_on as unknown[]).push(serviceName);
    }
  } else if (appSvc.depends_on && typeof appSvc.depends_on === 'object') {
    const deps = appSvc.depends_on as Record<string, unknown>;
    if (!(serviceName in deps)) deps[serviceName] = { condition: 'service_started' };
  } else {
    appSvc.depends_on = [serviceName];
  }
}

function dropDependency(services: Record<string, Record<string, unknown>>, serviceName: string): void {
  for (const svc of Object.values(services)) {
    if (!svc || typeof svc !== 'object') continue;
    if (Array.isArray(svc.depends_on)) {
      svc.depends_on = (svc.depends_on as unknown[]).filter(d => d !== serviceName);
      if ((svc.depends_on as unknown[]).length === 0) delete svc.depends_on;
    } else if (svc.depends_on && typeof svc.depends_on === 'object') {
      delete (svc.depends_on as Record<string, unknown>)[serviceName];
      if (Object.keys(svc.depends_on as Record<string, unknown>).length === 0) delete svc.depends_on;
    }
  }
}

/**
 * Inject the manager-provisioned STANDBY of another machine's fleet database
 * (PLAN_REPLICATION.md Stage 2). PGDATA is pre-seeded by pg_basebackup before
 * this service ever starts (standby.signal + primary_conninfo live in the
 * volume), so the service needs no POSTGRES_* init env. Exposed like a
 * replication primary: after a promotion this database serves the fleet.
 */
export function addFleetPostgresReplicaService(
  composeContent: string,
  bot: BotConfig,
  replica: { containerName: string; volume: string; hostPort: number; user?: string; db?: string },
  opts: { mode?: DeploymentMode } = {}
): string {
  let compose: Record<string, unknown>;
  try {
    compose = parseDocument(composeContent).toJSON() as Record<string, unknown>;
  } catch {
    return composeContent;
  }
  const services = compose.services as Record<string, Record<string, unknown>> | undefined;
  if (!services) return composeContent;

  const sharedNet = sharedNetworkName(opts.mode);
  const serviceName = 'fleet-postgres-replica';
  const volumeKey = 'fleet-postgres-replica-data';

  services[serviceName] = {
    image: 'postgres:16-alpine',
    container_name: replica.containerName,
    restart: 'unless-stopped',
    cpu_shares: 10,
    logging: cappedLogging(),
    ports: [`${replica.hostPort}:5432`],
    volumes: [{ type: 'volume', source: volumeKey, target: '/var/lib/postgresql/data' }],
    healthcheck: {
      // A record stamped before the identity fields checks acceptance only
      // (pg_isready never authenticates, so no role name is guessed).
      test: ['CMD-SHELL', replica.user && replica.db ? `pg_isready -U ${replica.user} -d ${replica.db}` : 'pg_isready'],
      interval: '10s',
      timeout: '5s',
      retries: 5,
    },
    networks: sharedNet ? ['default', sharedNet] : ['default'],
    labels: {
      'managed-by': 'discord-bot-manager',
      'bot-id': bot.id,
      'service-type': 'fleet-database-replica',
    },
  };

  if (!compose.volumes || typeof compose.volumes !== 'object') compose.volumes = {};
  (compose.volumes as Record<string, unknown>)[volumeKey] = { name: replica.volume };

  if (sharedNet) {
    if (!compose.networks || typeof compose.networks !== 'object') compose.networks = {};
    const nets = compose.networks as Record<string, unknown>;
    if (!nets[sharedNet]) nets[sharedNet] = { name: sharedNet, external: true };
  }

  // After an adopt this copy is the database the app writes to; compose down
  // must stop the app before it.
  addAppDependency(services, getAppServiceName(compose), serviceName);

  return stringify(compose, { lineWidth: 0 });
}

/**
 * Remove the managed PRIMARY sidecar (PLAN_REPLICATION.md Stage 5): the stale
 * half of a failed-over pair stops hosting a database and follows the new
 * primary instead. The app service's depends_on goes too, otherwise every
 * later start fails on a dependency that no longer exists.
 */
export function removeFleetPostgresService(composeContent: string): string {
  let compose: Record<string, unknown>;
  try {
    compose = parseDocument(composeContent).toJSON() as Record<string, unknown>;
  } catch {
    return composeContent;
  }
  const services = compose.services as Record<string, Record<string, unknown>> | undefined;
  if (!services || !services['fleet-postgres']) return composeContent;
  delete services['fleet-postgres'];
  const volumes = compose.volumes as Record<string, unknown> | undefined;
  if (volumes) delete volumes['fleet-postgres-data'];
  dropDependency(services, 'fleet-postgres');
  return stringify(compose, { lineWidth: 0 });
}

/** Remove the standby service (record removal); the named volume stays declared-free (data retention). */
export function removeFleetPostgresReplicaService(composeContent: string): string {
  let compose: Record<string, unknown>;
  try {
    compose = parseDocument(composeContent).toJSON() as Record<string, unknown>;
  } catch {
    return composeContent;
  }
  const services = compose.services as Record<string, Record<string, unknown>> | undefined;
  if (!services || !services['fleet-postgres-replica']) return composeContent;
  delete services['fleet-postgres-replica'];
  const volumes = compose.volumes as Record<string, unknown> | undefined;
  if (volumes) delete volumes['fleet-postgres-replica-data'];
  dropDependency(services, 'fleet-postgres-replica');
  return stringify(compose, { lineWidth: 0 });
}

// ─── Docker-mode volume + config-file delivery (Node fs) ──

function dockerEnsureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  try { fs.chmodSync(dir, 0o777); } catch { /* windows / best effort */ }
}

/**
 * Seed one repo file at its bind target. Anything already at the target is the
 * operator's or the app's (an emptied config included) and is kept; the only
 * thing replaced is an EMPTY directory, which is what Docker creates at a
 * missing file bind source. The file lands whole or not at all: it is written
 * to a temp name beside the target, synced, then linked into place, and link(2)
 * refuses a name that appeared meanwhile. Returns null when delivered, else
 * the kind of entry that was kept.
 */
function seedRepoFile(
  repoSrc: string,
  target: string,
  ensureParent: (dir: string) => void,
  grant: (fd: number) => void,
  replaceIfHash?: string,
): string | null {
  const dir = path.dirname(target);
  const base = path.basename(target);
  const tmpPrefix = `.${base}.smdb-seed.`;
  removeStaleSeedTemps(dir, tmpPrefix);

  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`could not inspect ${target}, delivered nothing: ${e}`);
  }
  if (st) {
    if (st.isSymbolicLink() && !fs.existsSync(target)) {
      throw new Error(`${target} is a symlink to a missing target; refused to seed through it, left it untouched`);
    }
    if (!st.isDirectory() && !(replaceIfHash && st.isFile() && fileHash(target) === replaceIfHash)) return entryKind(st);
    if (st.isDirectory()) {
      if (fs.readdirSync(target).length) throw new Error(`${target} is a directory that is not empty where the repo ships a file; left it untouched`);
      fs.rmdirSync(target);
    }
  }
  ensureParent(dir);
  const bytes = fs.readFileSync(repoSrc);
  const tmpPath = path.join(dir, `${tmpPrefix}${process.pid}.${randomBytes(4).toString('hex')}`);
  const fd = fs.openSync(tmpPath, 'wx', 0o644);
  let open = true;
  try {
    let off = 0;
    while (off < bytes.length) off += fs.writeSync(fd, bytes, off, bytes.length - off);
    try { fs.fchmodSync(fd, 0o644); } catch { /* windows / best effort */ }
    grant(fd);
    fs.fsyncSync(fd);
    open = false;
    fs.closeSync(fd);
  } catch (e) {
    if (open) { try { fs.closeSync(fd); } catch { /* already gone */ } }
    try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
    throw e;
  }
  if (st && st.isFile()) {
    // Replace an override the manager delivered only while it still holds exactly what was delivered.
    if (fileHash(target) !== replaceIfHash) {
      try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
      return 'file';
    }
    fs.renameSync(tmpPath, target);
    return null;
  }
  try {
    fs.linkSync(tmpPath, target);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      try { return entryKind(fs.lstatSync(target)); } catch { return 'entry'; }
    }
    throw e;
  }
  try { fs.unlinkSync(tmpPath); } catch { /* the file is in place; a stray temp file is harmless */ }
  return null;
}

export function bodyHash(body: string | Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

function fileHash(p: string): string | null {
  try { return bodyHash(fs.readFileSync(p)); } catch { return null; }
}

/**
 * What a delivery step did: the paths it could not prepare or write, and the
 * override files it wrote (local path -> body hash), so a later build can tell
 * a file it wrote from one the bot or the operator changed since.
 */
/** unbound: config files the deployed compose does not mount (only a build adds the bind). seeded: files this build copied from the repo. */
export interface DeliveryReport { failed: string[]; delivered: Record<string, string>; unbound: string[]; seeded?: string[] }

export function newDeliveryReport(): DeliveryReport {
  return { failed: [], delivered: {}, unbound: [] };
}

const CONFIG_SOURCE_DIR = '.smdb-config';

/**
 * Host sources for config files the manager binds itself, relative to the
 * bot's folder (/DATA/AppData/<app> in CasaOS mode, bots/<id> in docker mode):
 * one per in-container path, derived from the whole path.
 * A path that is not clean and absolute, that shares its source with another
 * or nests under another, or whose source overlaps a bind source the compose
 * already declares (`taken`, relative to that folder; '' is the folder itself)
 * is refused with the reason.
 */
export function configFileSources(paths: string[], taken: string[]): Map<string, { rel: string } | { refused: string }> {
  const out = new Map<string, { rel: string } | { refused: string }>();
  const rels = new Map<string, string>();
  const overlaps = (a: string, b: string) => b === '' || a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
  for (const p of paths) {
    const segs = p.split('/').slice(1);
    if (!p.startsWith('/') || segs.some(s => s === '' || s === '.' || s === '..' || s.includes('\\'))) {
      out.set(p, { refused: 'the in-container path is not a clean absolute path' });
      continue;
    }
    const rel = `${CONFIG_SOURCE_DIR}/${segs.join('/')}`;
    const bound = taken.find(t => overlaps(rel, t.replace(/\/+$/, '')));
    if (bound !== undefined) {
      out.set(p, { refused: `its host file would sit inside a directory the compose already binds (${bound || 'the whole bot folder'})` });
      continue;
    }
    rels.set(p, rel);
    out.set(p, { rel });
  }
  for (const [p, rel] of rels) {
    const other = [...rels].find(([q, r]) => q !== p && overlaps(rel, r));
    if (other) out.set(p, { refused: `it would share a host file or directory with ${other[0]}` });
  }
  return out;
}

/**
 * Why an existing entry at a manager-bound config source must be kept, or null
 * when the body may be written: nothing is there, an empty directory (what
 * Docker creates at a missing file source), the same body, or the exact body
 * the manager recorded delivering there. A kept file whose stored body is the
 * one last delivered there has nothing new to receive, so it is not a failure.
 */
function keepExistingConfig(local: string, body: string, delivered: Record<string, string>): { why: string; failed: boolean } | null {
  let st: fs.Stats;
  try { st = fs.lstatSync(local); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return { why: `could not inspect it (${e})`, failed: true };
  }
  if (st.isDirectory()) return fs.readdirSync(local).length ? { why: 'a directory with content is there', failed: true } : null;
  if (!st.isFile()) return { why: `a ${entryKind(st)} is there`, failed: true };
  const h = fileHash(local);
  if (h === bodyHash(body) || (h !== null && h === delivered[local])) return null;
  if (!delivered[local]) return { why: 'it holds content the manager has no record of delivering', failed: true };
  return { why: 'it changed since the manager delivered it', failed: delivered[local] !== bodyHash(body) };
}

// Temp files a killed earlier seed of this exact target left behind.
function removeStaleSeedTemps(dir: string, tmpPrefix: string): void {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(tmpPrefix) || !/^\d+\.[0-9a-f]{8}$/.test(name.slice(tmpPrefix.length))) continue;
    const p = path.join(dir, name);
    try { if (fs.lstatSync(p).isFile()) fs.unlinkSync(p); } catch { /* best effort */ }
  }
}

function entryKind(st: fs.Stats): string {
  if (st.isFile()) return 'file';
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isFIFO()) return 'fifo';
  if (st.isSocket()) return 'socket';
  if (st.isBlockDevice() || st.isCharacterDevice()) return 'device';
  return 'entry';
}

type SeedCounts = { delivered: number; kept: number };

function seedSummary(target: string, c: SeedCounts): string {
  if (c.delivered === 0 && c.kept === 0) return `Created empty directory ${target}`;
  if (c.delivered === 0) return `Kept existing directory ${target} (all ${c.kept} files already present)`;
  return `Delivered directory ${target} (${c.delivered} files delivered, ${c.kept} existing kept)`;
}

function dockerDeliverFile(repoSrc: string, target: string, replaceIfHash?: string): string | null {
  return seedRepoFile(repoSrc, target, dockerEnsureDir, () => {}, replaceIfHash);
}

function dockerDeliverDir(repoSrc: string, target: string, log: (msg: string) => void): SeedCounts {
  const counts: SeedCounts = { delivered: 0, kept: 0 };
  dockerEnsureDir(target);
  for (const entry of fs.readdirSync(repoSrc, { withFileTypes: true })) {
    if (SKIP_DELIVER.has(entry.name)) continue;
    const cs = path.join(repoSrc, entry.name);
    const ct = path.join(target, entry.name);
    if (entry.isDirectory()) {
      const sub = dockerDeliverDir(cs, ct, log);
      counts.delivered += sub.delivered;
      counts.kept += sub.kept;
    } else if (entry.isFile()) {
      const kept = dockerDeliverFile(cs, ct);
      if (kept) { counts.kept++; log(`[Docker] Kept existing ${kept} ${ct}`); }
      else counts.delivered++;
    }
  }
  return counts;
}

function writeDockerConfig(target: string, body: string): void {
  dockerEnsureDir(path.dirname(target));
  try { if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true }); } catch { /* best effort */ }
  fs.writeFileSync(target, body);
  try { fs.chmodSync(target, 0o644); } catch { /* best effort */ }
}

/** Map a host bind source under hostBotDir back to the manager's local path. */
function hostSrcToLocal(src: string, prefix: string, containerBotDir: string): string {
  return path.join(containerBotDir, src.slice(prefix.length));
}

/**
 * Split a compose volume string into source + dest. Tolerates a Windows
 * drive-letter source (`C:\path` / `C:/path`) whose drive colon is NOT the
 * source:dest separator - critical in docker mode on Windows, where bind sources
 * are absolute host paths.
 */
export function splitDockerVolume(vol: string): { source: string; dest: string } | null {
  const drive = vol.match(/^([A-Za-z]:[\\/][^:]*):(.*)$/);
  if (drive) return { source: drive[1], dest: drive[2].split(':')[0] };
  const i = vol.indexOf(':');
  if (i <= 0) return null;
  return { source: vol.slice(0, i), dest: vol.slice(i + 1).split(':')[0] };
}

const STATUS_PAGE_SERVICE = 'status-page';

/**
 * Author the mode of every bind mounted at `target`: read_only on the object
 * form, a ro option on the string form. Returns the services it changed.
 */
export function setBindMode(services: Record<string, Record<string, unknown>>, target: string, readOnly: boolean): string[] {
  const touched: string[] = [];
  for (const [name, service] of Object.entries(services)) {
    if (!service || !Array.isArray(service.volumes)) continue;
    const vols = service.volumes as unknown[];
    for (let i = 0; i < vols.length; i++) {
      const vol = vols[i];
      if (typeof vol === 'string') {
        const s = splitDockerVolume(vol);
        if (!s || s.dest !== target) continue;
        const head = `${s.source}:${s.dest}`;
        if (!vol.startsWith(head)) continue;
        const opts = vol.slice(head.length).replace(/^:/, '').split(',').filter(o => o && o !== 'ro' && o !== 'rw');
        if (readOnly) opts.push('ro');
        vols[i] = opts.length ? `${head}:${opts.join(',')}` : head;
        touched.push(name);
      } else if (vol && typeof vol === 'object') {
        const v = vol as Record<string, unknown>;
        if (v.type === 'volume' || v.target !== target) continue;
        v.read_only = readOnly;
        touched.push(name);
      }
    }
  }
  return touched;
}

/** Author each config file's read-only choice on the binds the compose declares for it. */
export function setDeclaredBindModes(composeContent: string, files: Array<{ path: string; readOnly?: boolean }>): string {
  const compose = parseDocument(composeContent).toJSON() as Record<string, unknown>;
  const services = compose.services as Record<string, Record<string, unknown>> | undefined;
  if (!services) return composeContent;
  for (const f of files) setBindMode(services, f.path, f.readOnly !== false);
  return stringify(compose, { lineWidth: 0 });
}

/** Collect declared bind {target -> hostSource} pairs whose source is under prefix. */
function dockerDeclaredBinds(services: Record<string, Record<string, unknown>>, prefix: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const service of Object.values(services)) {
    if (!Array.isArray(service.volumes)) continue;
    for (const vol of service.volumes as unknown[]) {
      let src: string | null = null;
      let dest: string | null = null;
      if (typeof vol === 'string') {
        const s = splitDockerVolume(vol);
        if (s) { src = s.source; dest = s.dest; }
      } else if (vol && typeof vol === 'object') {
        const v = vol as Record<string, unknown>;
        if (typeof v.source === 'string' && typeof v.target === 'string' && v.type !== 'volume') { src = v.source; dest = v.target; }
      }
      if (src && dest && src.startsWith(prefix)) map.set(dest, src);
    }
  }
  return map;
}

/**
 * Docker-mode equivalent of createVolumeDirectories + applyUserConfigOverrides +
 * addConfigFileBinds + writeConfigFiles, using Node fs against the bot's own data
 * dir (no /DATA). Expects a compose whose relative binds were
 * already rewritten to absolute host paths under hostBotDir (processComposeForDocker).
 * Returns the (possibly modified) compose content with config-file binds added.
 * `restore` maps local paths of overrides an earlier build delivered to their
 * body hash: such a file still holding that body gets the repo template again.
 */
export function prepareDockerBotFiles(
  composeContent: string,
  containerBotDir: string,
  hostBotDir: string,
  repoPath: string | null,
  configFiles: Array<{ path: string; body: string; readOnly?: boolean }>,
  logFn?: (msg: string) => void,
  report: DeliveryReport = newDeliveryReport(),
  restore: Record<string, string> = {},
  droppedGatewayBinds: string[] = [],
): string {
  const log = logFn || ((msg: string) => console.log(`[Docker] ${msg}`));
  let compose: Record<string, unknown>;
  try {
    compose = parseDocument(composeContent).toJSON() as Record<string, unknown>;
  } catch (err) {
    log(`[Docker] Warning: could not parse the compose to prepare its files: ${err}`);
    report.failed.push('the compose file (unparseable)');
    return composeContent;
  }
  const services = compose.services as Record<string, Record<string, unknown>> | undefined;
  if (!services) return composeContent;

  const prefix = hostBotDir.replace(/\/+$/, '') + '/';

  // 1. Create (and deliver repo content for) every bind source under hostBotDir.
  const seen = new Set<string>();
  for (const service of Object.values(services)) {
    if (!Array.isArray(service.volumes)) continue;
    for (const vol of service.volumes as unknown[]) {
      let src: string | null = null;
      if (typeof vol === 'string') { const s = splitDockerVolume(vol); if (s) src = s.source; }
      else if (vol && typeof vol === 'object') { const v = vol as Record<string, unknown>; if (typeof v.source === 'string' && v.type !== 'volume') src = v.source; }
      if (!src || !src.startsWith(prefix) || seen.has(src)) continue;
      seen.add(src);
      const target = hostSrcToLocal(src, prefix, containerBotDir);
      try {
        const rel = src.slice(prefix.length);
        let repoSrc: string | null = null;
        if (repoPath && rel) {
          const cand = path.join(repoPath, rel);
          if (fs.existsSync(cand)) repoSrc = cand;
          else repoSrc = findConfigTemplate(cand);
        }
        if (repoSrc && fs.statSync(repoSrc).isFile()) {
          const kept = dockerDeliverFile(repoSrc, target, restore[target]);
          if (kept) log(`[Docker] Kept existing ${kept} ${target}`);
          else log(restore[target] ? `[Docker] Restored the repo template at ${target}` : `[Docker] Delivered file ${target}`);
        }
        else if (repoSrc && fs.statSync(repoSrc).isDirectory()) log(`[Docker] ${seedSummary(target, dockerDeliverDir(repoSrc, target, log))}`);
        else dockerEnsureDir(target);
      } catch (err) {
        log(`[Docker] Warning: could not prepare ${target}: ${err}`);
        report.failed.push(target);
      }
    }
  }

  // 2. Config files: overwrite an existing declared bind, else add a new bind.
  if (configFiles.length) {
    const declared = dockerDeclaredBinds(services, prefix);
    const targetName = getAppServiceName(compose);
    const targetSvc = targetName && targetName !== STATUS_PAGE_SERVICE ? services[targetName] : undefined;
    const sources = configFileSources(
      configFiles.filter(cf => !declared.has(cf.path) && !droppedGatewayBinds.includes(cf.path)).map(cf => cf.path),
      [...declared.values()].map(s => s.slice(prefix.length)),
    );
    for (const cf of configFiles) {
      if (droppedGatewayBinds.includes(cf.path)) {
        log(`[Docker] Skipped config ${cf.path}: its gateway service is not deployed`);
        continue;
      }
      const existing = declared.get(cf.path);
      if (existing) {
        const local = hostSrcToLocal(existing, prefix, containerBotDir);
        try {
          writeDockerConfig(local, cf.body);
          report.delivered[local] = bodyHash(cf.body);
          setBindMode(services, cf.path, cf.readOnly !== false);
          log(`[Docker] Applied config ${cf.path}`);
        } catch (err) {
          log(`[Docker] Warning: could not write config ${cf.path}: ${err}`);
          report.failed.push(cf.path);
        }
      } else if (targetSvc) {
        const src = sources.get(cf.path);
        if (!src || 'refused' in src) {
          log(`[Docker] Warning: config ${cf.path} not bound: ${src && 'refused' in src ? src.refused : 'no host file for it'}`);
          report.failed.push(cf.path);
          continue;
        }
        const hostSrc = `${prefix}${src.rel}`;
        const local = path.join(containerBotDir, src.rel);
        try {
          const keep = keepExistingConfig(local, cf.body, restore);
          if (keep?.failed) {
            log(`[Docker] Kept existing ${local} for config ${cf.path}: ${keep.why}. Move it away or copy it into the config editor, then build again`);
            report.failed.push(cf.path);
            continue;
          }
          if (keep) {
            log(`[Docker] Kept existing ${local} for config ${cf.path}: ${keep.why}`);
            report.delivered[local] = restore[local];
          } else {
            writeDockerConfig(local, cf.body);
            report.delivered[local] = bodyHash(cf.body);
          }
        } catch (err) {
          log(`[Docker] Warning: could not write config ${cf.path}: ${err}`);
          report.failed.push(cf.path);
          continue;
        }
        if (!Array.isArray(targetSvc.volumes)) targetSvc.volumes = targetSvc.volumes ? [targetSvc.volumes] : [];
        (targetSvc.volumes as unknown[]).push({ type: 'bind', source: hostSrc, target: cf.path, read_only: cf.readOnly !== false });
        log(`[Docker] Bound config ${cf.path} on service ${targetName}`);
      } else {
        log(`[Docker] Warning: config ${cf.path} not bound: the compose has no app service to mount it on`);
        report.failed.push(cf.path);
      }
    }
  }

  fixDockerBotOwnership(containerBotDir, log);
  return stringify(compose, { lineWidth: 0 });
}

/**
 * Re-write the bot's bind-mounted config files from current stored bodies on start
 * (docker mode), WITHOUT touching the compose - mirrors redeliverConfigFiles. The
 * binds already exist from the build; this only refreshes the host source files.
 */
export function redeliverDockerConfigFiles(
  composeContent: string,
  containerBotDir: string,
  hostBotDir: string,
  configFiles: Array<{ path: string; body: string }>,
  report: DeliveryReport = newDeliveryReport(),
): DeliveryReport {
  if (!configFiles.length) return report;
  let compose: Record<string, unknown>;
  try { compose = parseDocument(composeContent).toJSON() as Record<string, unknown>; } catch {
    report.failed.push(...configFiles.map(c => c.path));
    return report;
  }
  const services = (compose.services || {}) as Record<string, Record<string, unknown>>;
  const prefix = hostBotDir.replace(/\/+$/, '') + '/';
  const declared = dockerDeclaredBinds(services, prefix);
  for (const cf of configFiles) {
    const src = declared.get(cf.path);
    if (!src) { report.unbound.push(cf.path); continue; }
    const local = hostSrcToLocal(src, prefix, containerBotDir);
    try { writeDockerConfig(local, cf.body); report.delivered[local] = bodyHash(cf.body); } catch { report.failed.push(cf.path); }
  }
  return report;
}

/**
 * Docker-mode ownership fix. The root manager delivers bot files root-owned, but the
 * bot service runs as the injected PUID:PGID, so without this it hits EACCES on the
 * first in-place write to a delivered file. Reassigns ONLY root-owned paths (the Node
 * equivalent of `chown -R --from=root`), so a service that took its own bind dir
 * (e.g. Postgres -> uid 999) is left alone. The CasaOS equivalent is
 * fixPostDeployOwnership, which sweeps the app dir and the metadata dir after a
 * deploy; both reach the files directly, because the manager bind-mounts them.
 */
export function fixDockerBotOwnership(containerBotDir: string, logFn?: (msg: string) => void): void {
  if (process.platform === 'win32') return;   // bind-mount ownership is virtualized on Docker Desktop
  const log = logFn || ((msg: string) => console.log(`[Docker] ${msg}`));
  const pcs = getPCSEnvironment();
  const uid = parseInt(pcs.PUID, 10);
  const gid = parseInt(pcs.PGID, 10);
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) return;
  if (!fs.existsSync(containerBotDir)) return;

  let fixed = 0;
  const walk = (p: string): void => {
    let st: fs.Stats;
    try { st = fs.lstatSync(p); } catch { return; }
    if (st.uid === 0) {
      try { (st.isSymbolicLink() ? fs.lchownSync : fs.chownSync)(p, uid, gid); fixed++; }
      catch { /* best effort */ }
    }
    if (st.isDirectory()) {
      let entries: string[] = [];
      try { entries = fs.readdirSync(p); } catch { return; }
      for (const e of entries) walk(path.join(p, e));
    }
  };
  walk(containerBotDir);
  if (fixed) log(`[Docker] Fixed ownership of ${fixed} root-owned path(s) -> ${uid}:${gid}`);
}

/**
 * Hand a path the manager just wrote to the app's uid, optionally setting its
 * mode. The manager runs as root with the AppData root mounted, so this reaches
 * every app's files directly and needs no platform service.
 *
 * Only ROOT-owned entries are reassigned: a service that chowned its own bind
 * mount to its runtime user (Postgres and its uid-999 0700 data dir) must be
 * left alone, or it comes back to a permission error.
 */
let warnedNonNumericIds = false;

export function grantToApp(
  target: string,
  opts: { recursive?: boolean; mode?: string; log?: (msg: string) => void } = {},
): void {
  if (process.platform === 'win32') return;   // bind-mount ownership is virtualized on Docker Desktop
  const pcs = getPCSEnvironment();
  const uid = parseInt(pcs.PUID, 10);
  const gid = parseInt(pcs.PGID, 10);
  const warn = opts.log || ((msg: string) => console.warn(msg));

  // A silent ownership failure surfaces much later as the bot hitting EACCES on
  // its own files, so say it here instead. The PUID/PGID complaint is about the
  // environment, not the path, so it is said once per process rather than once
  // per delivered file.
  let failure: string | null = null;
  const ownable = Number.isInteger(uid) && Number.isInteger(gid);
  if (!ownable && !warnedNonNumericIds) {
    warnedNonNumericIds = true;
    warn(`[PCS] Warning: PUID/PGID are not numeric (${pcs.PUID}:${pcs.PGID}), delivered files are left owned by root`);
  }

  const chownRootOwned = (p: string): void => {
    let st: fs.Stats;
    try { st = fs.lstatSync(p); } catch { return; }
    if (st.uid === 0) {
      try { (st.isSymbolicLink() ? fs.lchownSync : fs.chownSync)(p, uid, gid); }
      catch (e) { if (!failure) failure = `${p}: ${e}`; }
    }
    if (opts.recursive && st.isDirectory()) {
      let entries: string[] = [];
      try { entries = fs.readdirSync(p); } catch { return; }
      for (const e of entries) chownRootOwned(path.join(p, e));
    }
  };
  if (ownable) chownRootOwned(target);

  // Only the named target: a recursive chown carries no single right mode
  // (directories need the execute bit that files must not have). chmod follows
  // a symlink where lchown above does not, so a planted link is left alone
  // rather than having its target's mode changed.
  if (opts.mode !== undefined) {
    try {
      if (!fs.lstatSync(target).isSymbolicLink()) fs.chmodSync(target, parseInt(opts.mode, 8));
    } catch (e) { if (!failure) failure = `${target} mode ${opts.mode}: ${e}`; }
  }

  if (failure) warn(`[PCS] Warning: could not set ownership or mode (${failure})`);
}

/**
 * Hand an OPEN file to the app's uid. Chowning the fd rather than the path is
 * what makes this safe against a component being swapped after the path was
 * checked: the inode is already pinned, so the change cannot be redirected.
 */
export function grantFd(fd: number, log?: (msg: string) => void): void {
  if (process.platform === 'win32') return;   // bind-mount ownership is virtualized on Docker Desktop
  const pcs = getPCSEnvironment();
  const uid = parseInt(pcs.PUID, 10);
  const gid = parseInt(pcs.PGID, 10);
  const warn = log || ((msg: string) => console.warn(msg));

  if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
    if (!warnedNonNumericIds) {
      warnedNonNumericIds = true;
      warn(`[PCS] Warning: PUID/PGID are not numeric (${pcs.PUID}:${pcs.PGID}), delivered files are left owned by root`);
    }
    return;
  }
  try {
    if (fs.fstatSync(fd).uid === 0) fs.fchownSync(fd, uid, gid);
  } catch (e) {
    warn(`[PCS] Warning: could not set ownership on the written file (${e})`);
  }
}

/**
 * mkdir -p that hands every level it actually had to create to the app. Node
 * reports the FIRST directory created, so the recursive grant starts there and
 * never touches pre-existing parents.
 */
function mkdirForApp(dirPath: string, log?: (msg: string) => void): void {
  const created = fs.mkdirSync(dirPath, { recursive: true });
  if (created) grantToApp(created, { recursive: true, log });
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
function ensureVolumeDir(
  dirPath: string,
  mode = '755',
  preserveExisting = true,
  log?: (msg: string) => void,
): void {
  if (preserveExisting && fs.existsSync(dirPath)) return;
  mkdirForApp(dirPath, log);
  grantToApp(dirPath, { mode, log });
}

// Repo entries never delivered into a bind mount (heavy / irrelevant).
const SKIP_DELIVER = new Set(['node_modules', '.git']);

/**
 * Copy a repo file to its AppData bind target (parent dir created first), so a
 * compose that bind-mounts a config file from the repo (e.g. application.yml)
 * actually delivers it instead of Docker auto-creating an empty directory.
 * Seed semantics (seedRepoFile): an already-present target is left untouched, so
 * a redeploy never reverts a file the running app or the operator has changed.
 */
async function deliverRepoFile(repoSrc: string, target: string, log: (msg: string) => void, replaceIfHash?: string): Promise<string | null> {
  return seedRepoFile(repoSrc, target, (dir) => ensureVolumeDir(dir, '755', true, log), (fd) => grantFd(fd, log), replaceIfHash);
}

/**
 * Recursively copy a repo directory to its AppData bind target.
 */
async function deliverRepoDir(repoSrc: string, target: string, log: (msg: string) => void): Promise<SeedCounts> {
  const counts: SeedCounts = { delivered: 0, kept: 0 };
  // A repo-provided bind dir is app-managed and a foreign-uid container may need
  // to write into it (e.g. Lavalink downloading plugin jars), so make it writable.
  ensureVolumeDir(target, '777', false, log);
  for (const entry of fs.readdirSync(repoSrc, { withFileTypes: true })) {
    if (SKIP_DELIVER.has(entry.name)) continue;
    const childRepo = path.join(repoSrc, entry.name);
    const childTarget = `${target}/${entry.name}`;
    if (entry.isDirectory()) {
      const sub = await deliverRepoDir(childRepo, childTarget, log);
      counts.delivered += sub.delivered;
      counts.kept += sub.kept;
    } else if (entry.isFile()) {
      const kept = await deliverRepoFile(childRepo, childTarget, log);
      if (kept) { counts.kept++; log(`[PCS] Kept existing ${kept} ${childTarget}`); }
      else counts.delivered++;
    }
  }
  return counts;
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
  logFn?: (msg: string) => void,
  report: DeliveryReport = newDeliveryReport(),
  restore: Record<string, string> = {},
): Promise<DeliveryReport> {
  const log = logFn || ((msg: string) => console.log(`[PCS] ${msg}`));
  const pcs = getPCSEnvironment();

  let compose: Record<string, unknown>;
  try {
    compose = parseDocument(composeContent).toJSON() as Record<string, unknown>;
  } catch {
    log('[PCS] Failed to parse compose for volume directory creation');
    report.failed.push('the compose file (unparseable)');
    return report;
  }

  const services = compose.services as Record<string, Record<string, unknown>> | undefined;
  if (!services) return report;

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
        const kept = await deliverRepoFile(repoSrc, target, log, restore[target]);
        if (kept) {
          log(`[PCS] Kept existing ${kept} at volume path: ${target}`);
          const h = fileHash(target);
          if (h && h === fileHash(repoSrc)) report.delivered[target] = h;
        } else {
          (report.seeded ??= []).push(target);
          const h = fileHash(target);
          if (h) report.delivered[target] = h;
          log(restore[target] ? `[PCS] Restored the repo template at volume path: ${target}` : `[PCS] Delivered file to volume path: ${target}`);
        }
      } else if (repoSrc && fs.statSync(repoSrc).isDirectory()) {
        log(`[PCS] ${seedSummary(target, await deliverRepoDir(repoSrc, target, log))}`);
      } else {
        ensureVolumeDir(target, '755', true, log);
        log(`[PCS] Created volume directory: ${target}`);
      }
    } catch (err) {
      log(`[PCS] Warning: could not prepare volume path ${target}: ${err}`);
      report.failed.push(target);
    }
  }
  return report;
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
  mkdirForApp(metadataDir, log);
  grantToApp(metadataDir, { recursive: true, log });

  // Write compose file whole, so an interrupted write never leaves it torn
  const existed = fs.existsSync(composePath);
  writeFileKeepingOwner(composePath, composeContent);
  if (!existed) grantToApp(composePath, { mode: '644', log });

  log(`[PCS] Saved CasaOS metadata compose to ${composePath}`);
  return composePath;
}

/**
 * Write the status-page index.html into the sidecar's bind-mounted dir.
 * Mirrors saveToCasaOSMetadata's write pattern.
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

  mkdirForApp(dir, log);
  grantToApp(dir, { recursive: true, log });

  fs.writeFileSync(filePath, html);
  grantToApp(filePath, { mode: '644', log });

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
  files: Array<{ path: string; readOnly?: boolean }>,
  logFn?: (msg: string) => void,
  report: DeliveryReport = newDeliveryReport(),
): string {
  if (!files.length) return composeContent;
  const log = logFn || ((msg: string) => console.log(`[PCS] ${msg}`));
  const pcs = getPCSEnvironment();
  const refuse = (why: string): string => {
    log(`[PCS] Warning: config files not bound (${files.map(f => f.path).join(', ')}): ${why}`);
    report.failed.push(...files.map(f => f.path));
    return composeContent;
  };

  let compose: Record<string, unknown>;
  try {
    compose = parseDocument(composeContent).toJSON() as Record<string, unknown>;
  } catch {
    return refuse('the compose could not be parsed');
  }

  const services = compose.services as Record<string, Record<string, unknown>> | undefined;
  if (!services) return refuse('the compose has no services');

  const targetName = getAppServiceName(compose);
  if (!targetName || !services[targetName]) return refuse('the compose has no app service');
  if (targetName === STATUS_PAGE_SERVICE) return refuse('the only app service is the status page');

  const service = services[targetName];
  if (!Array.isArray(service.volumes)) {
    service.volumes = service.volumes ? [service.volumes] : [];
  }
  const volumes = service.volumes as unknown[];

  const appDir = `${pcs.DATA_ROOT}/AppData/${appName}`;
  const taken: string[] = [];
  for (const svc of Object.values(services)) {
    if (!Array.isArray(svc.volumes)) continue;
    for (const v of svc.volumes as unknown[]) {
      let src: string | null = null;
      if (typeof v === 'string') { const s = splitDockerVolume(v); if (s) src = s.source; }
      else if (v && typeof v === 'object') { const o = v as Record<string, unknown>; if (typeof o.source === 'string' && o.type !== 'volume') src = o.source; }
      if (src === null) continue;
      const clean = src.replace(/\/+$/, '');
      if (clean === appDir || appDir.startsWith(clean + '/')) taken.push('');
      else if (clean.startsWith(appDir + '/')) taken.push(clean.slice(appDir.length + 1));
    }
  }
  const sources = configFileSources(files.map(f => f.path), taken);

  for (const f of files) {
    const exists = volumes.some(
      (v) => v && typeof v === 'object' && (v as Record<string, unknown>).target === f.path
    );
    if (exists) continue;
    const src = sources.get(f.path);
    if (!src || 'refused' in src) {
      log(`[PCS] Warning: config ${f.path} not bound: ${src && 'refused' in src ? src.refused : 'no host file for it'}`);
      report.failed.push(f.path);
      continue;
    }
    const source = `${appDir}/${src.rel}`;
    volumes.push({ type: 'bind', source, target: f.path, read_only: f.readOnly !== false });
    log(`[PCS] Bound config ${f.path} on service ${targetName}`);
  }

  return stringify(compose, { lineWidth: 0 });
}

/**
 * Write user-supplied config files into the bind-mounted config dir.
 * Mirrors writeStatusPage's write pattern.
 */
export async function writeConfigFiles(
  appName: string,
  files: Array<{ path: string; body: string }>,
  logFn?: (msg: string) => void,
  report: DeliveryReport = newDeliveryReport(),
  delivered: Record<string, string> = {},
): Promise<DeliveryReport> {
  if (!files.length) return report;
  const log = logFn || ((msg: string) => console.log(`[PCS] ${msg}`));
  const pcs = getPCSEnvironment();
  const appDir = `${pcs.DATA_ROOT}/AppData/${appName}`;
  const sources = configFileSources(files.map(f => f.path), []);

  for (const f of files) {
    const src = sources.get(f.path);
    if (!src || 'refused' in src) {
      log(`[PCS] Warning: config ${f.path} not written: ${src && 'refused' in src ? src.refused : 'no host file for it'}`);
      report.failed.push(f.path);
      continue;
    }
    const filePath = `${appDir}/${src.rel}`;
    try {
      const keep = keepExistingConfig(filePath, f.body, delivered);
      if (keep) {
        log(`[PCS] Kept existing ${filePath} for config ${f.path}: ${keep.why}${keep.failed ? '. Move it away or copy it into the config editor, then build again' : ''}`);
        if (keep.failed) report.failed.push(f.path);
        else report.delivered[filePath] = delivered[filePath];
        continue;
      }
      mkdirForApp(path.dirname(filePath), log);
      if (fs.lstatSync(filePath, { throwIfNoEntry: false })?.isDirectory()) fs.rmdirSync(filePath);
      fs.writeFileSync(filePath, f.body);
      report.delivered[filePath] = bodyHash(f.body);
      grantToApp(filePath, { mode: '644', log });
      log(`[PCS] Wrote config file to ${filePath}`);
    } catch (err) {
      log(`[PCS] Warning: could not write config file ${filePath}: ${err}`);
      report.failed.push(f.path);
    }
  }
  return report;
}

/**
 * Re-write the bind-mounted host config files from the current stored bodies,
 * WITHOUT touching the compose (its binds already exist from the build). Called on
 * start so config edits made while the bot is stopped take effect on the next run,
 * mirroring how env vars are re-synced into the compose on start. Idempotent: the
 * same overrides + bind-only writes the build performs, minus the compose mutation.
 */
export async function redeliverConfigFiles(
  composeContent: string,
  appName: string,
  configFiles: Array<{ path: string; body: string }>,
  logFn?: (msg: string) => void,
  report: DeliveryReport = newDeliveryReport(),
  delivered: Record<string, string> = {},
): Promise<DeliveryReport> {
  if (!configFiles.length) return report;
  const handled = await applyUserConfigOverrides(composeContent, appName, configFiles, logFn, report, delivered);
  // A file with no bind in the deployed compose was added after the build: only Update mounts it.
  const unbound = configFiles.filter(c => !handled.has(c.path));
  if (unbound.length) {
    (logFn || console.log)(`[PCS] Warning: ${unbound.map(c => c.path).join(', ')} not mounted yet; press Build, then Start or Restart, to mount`);
    report.unbound.push(...unbound.map(c => c.path));
  }
  return report;
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
  report: DeliveryReport = newDeliveryReport(),
  delivered: Record<string, string> = {},
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
    log('[PCS] Warning: could not parse the compose to deliver config files');
    report.failed.push('the compose file (unparseable)');
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

  const known = { ...delivered, ...report.delivered };
  for (const cf of configFiles) {
    const source = destToSource.get(cf.path);
    if (!source) continue;   // not a compose-declared bind -> caller adds a bind instead
    handled.add(cf.path);
    try {
      const keep = report.seeded?.includes(source) ? null : keepExistingConfig(source, cf.body, known);
      if (keep) {
        log(`[PCS] Kept existing ${source} for config ${cf.path}: ${keep.why}${keep.failed ? '. Move it away or copy it into the config editor, then build again' : ''}`);
        if (keep.failed) report.failed.push(cf.path);
        else report.delivered[source] = known[source];
        continue;
      }
      ensureVolumeDir(path.dirname(source), '755', true, log);
      if (fs.lstatSync(source, { throwIfNoEntry: false })?.isDirectory()) fs.rmdirSync(source);
      fs.writeFileSync(source, cf.body);
      report.delivered[source] = bodyHash(cf.body);
      grantToApp(source, { mode: '644', log });
      log(`[PCS] Delivered user config to ${source} (bind ${cf.path})`);
    } catch (err) {
      log(`[PCS] Warning: could not deliver user config for ${cf.path}: ${err}`);
      report.failed.push(cf.path);
    }
  }
  return handled;
}

/**
 * A value as compose must hold it to deliver it literally: compose interpolates
 * every '$' in an environment value, and '$$' is its escape for one '$'.
 */
export function composeEnvValue(value: string): string {
  return (value == null ? '' : String(value)).replace(/\$/g, '$$$$');
}

/** The value docker compose delivers for an environment value the compose holds. */
export function composeEnvLiteral(value: string): string {
  return (value == null ? '' : String(value)).replace(/\$\$/g, '$');
}

/**
 * A .env value that compose reads literally. Single quotes turn off
 * interpolation; a value holding a single quote is double-quoted with '\', '"'
 * and '$' escaped.
 */
export function formatDotenvValue(value: string): string {
  const s = (value == null ? '' : String(value)).replace(/[\r\n]+/g, ' ');
  if (s !== '' && !/[\s#"'$=\\]/.test(s)) return s;
  if (!s.includes("'")) return `'${s}'`;
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$') + '"';
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

  try { mkdirForApp(dir, log); } catch { /* best effort */ }

  fs.writeFileSync(filePath, lines.join('\n') + '\n');
  grantToApp(filePath, { mode: '600', log });

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
 * Only ROOT-owned paths are reassigned: a service that chowned its own bind
 * mount to its runtime user (e.g. Postgres setting its data dir to uid 999,
 * mode 0700) is left alone, otherwise this would steal it back to 1000 and
 * break the container with a permission error.
 */
export async function fixPostDeployOwnership(
  appName: string,
  logFn?: (msg: string) => void
): Promise<void> {
  const log = logFn || ((msg: string) => console.log(`[PCS] ${msg}`));
  const pcs = getPCSEnvironment();

  const appDataDir = path.join(pcs.DATA_ROOT, 'AppData', appName);
  const metadataDir = path.join(pcs.DATA_ROOT, 'AppData', 'casaos', 'apps', appName);

  const fixDir = (dirPath: string) => {
    if (!fs.existsSync(dirPath)) return;
    grantToApp(dirPath, { recursive: true, log });
  };

  fixDir(appDataDir);
  fixDir(metadataDir);
  log(`[PCS] Fixed post-deploy ownership for ${appName}`);
}

// ─── Pre/Post Install Command Execution ────────────────────────────────────

/**
 * Execute pre-install or post-install command from x-casaos metadata.
 * Pre-install throws on failure; post-install warns but continues. Returns
 * false when a declared command did not run to success.
 */
export async function executeInstallCommand(
  type: 'pre' | 'post',
  composeContent: string,
  logFn?: (msg: string) => void
): Promise<boolean> {
  const log = logFn || ((msg: string) => console.log(`[PCS] ${msg}`));

  let compose: Record<string, unknown>;
  try {
    const doc = parseDocument(composeContent);
    compose = doc.toJSON() as Record<string, unknown>;
  } catch {
    return false;
  }

  const xcasaos = compose['x-casaos'] as Record<string, unknown> | undefined;
  if (!xcasaos) return true;

  const cmdKey = type === 'pre' ? 'pre-install-cmd' : 'post-install-cmd';
  const cmd = xcasaos[cmdKey];
  if (!cmd || typeof cmd !== 'string') return true;

  // This is the APP's own shell, so it runs in the platform's container and
  // never in the manager, which holds the docker socket. A host without that
  // container has nowhere safe to run it, and saying so beats a bare
  // "No such container" from the exec.
  if (!(await isCasaOSAvailable())) {
    const need = `needs the platform's casaos container, which this host does not run`;
    if (type === 'pre') throw new Error(`The ${type}-install command ${need}`);
    log(`[PCS] Warning: skipped the ${type}-install command because it ${need}`);
    return false;
  }

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
    return true;
  } catch (error) {
    if (type === 'pre') {
      throw new Error(`Pre-install command failed: ${error}`);
    } else {
      log(`[PCS] Warning: Post-install command failed (non-fatal): ${error}`);
      return false;
    }
  }
}
