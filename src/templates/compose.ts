/**
 * Docker Compose Generator
 * Generates docker-compose.yml files for bots (CasaOS compatible)
 *
 * - Uses repo's docker-compose.yml when it exists
 * - Applies variable substitution ($APP_ID, $API_HASH, etc.)
 * - Generates compose only when repo doesn't have one
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseDocument, stringify } from 'yaml';
import { BotConfig, DetectionResult, DeploymentMode } from '../types';
import { applyVariableSubstitution } from './variableSubstitution';
import { processComposeForCasaOS, extractAppName } from './pcsProcessing';
export { extractAppName } from './pcsProcessing';

export interface ComposeResult {
  content: string;
  appName: string;
}

interface VolumeMount {
  type: 'bind' | 'volume';
  source: string;
  target: string;
}

interface CasaOSVolumeDescription {
  container: string;
  description: { en_us: string };
}

interface HealthCheck {
  test: string[];
  interval?: string;
  timeout?: string;
  retries?: number;
  start_period?: string;
}

interface ComposeService {
  image?: string;
  build?: { context: string; dockerfile: string };
  container_name: string;
  restart: string;
  cpu_shares?: number;
  environment?: Record<string, string>;
  volumes?: VolumeMount[];
  depends_on?: string[];
  labels?: Record<string, string>;
  networks?: string[];
  expose?: string[];
  healthcheck?: HealthCheck;
  'x-casaos'?: { volumes?: CasaOSVolumeDescription[] };
}

interface CasaOSMetadata {
  architectures: string[];
  main: string;
  build?: string;
  author: string;
  developer: string;
  tagline: { en_us: string };
  category: string;
  description: { en_us: string };
  title: { en_us: string };
  is_uncontrolled?: boolean;
  store_app_id?: string;
}

interface ComposeFile {
  name: string;
  services: Record<string, ComposeService>;
  volumes?: Record<string, object>;
  networks?: Record<string, { name?: string; driver?: string; external?: boolean }>;
  'x-casaos'?: CasaOSMetadata;
}

/**
 * Generate docker-compose.yml for a bot
 */
export function generateCompose(
  bot: BotConfig,
  detection: DetectionResult,
  botDir: string,
  imageName: string
): string {
  const appName = `bot-${bot.id}`;

  const compose: ComposeFile = {
    name: appName,
    services: {},
    networks: {
      internal: { driver: 'bridge' },
      pcs: { name: 'pcs', external: true }
    }
  };

  // Build environment map
  const envMap: Record<string, string> = {};
  if (bot.envVars) {
    for (const [key, value] of Object.entries(bot.envVars)) {
      envMap[key] = value;
    }
  }

  // Bot service
  const botService: ComposeService = {
    container_name: `${appName}-app`,
    restart: 'unless-stopped',
    cpu_shares: 50,
    networks: ['internal', 'pcs'],
    labels: {
      'managed-by': 'discord-bot-manager',
      'bot-id': bot.id,
      'bot-name': bot.displayName
    }
  };

  // Reference the image the manager pre-builds (see buildGitInstance). Deploy is
  // `docker compose up` (no --build); a build: context here would point at an
  // unpopulated dir and fail, so we use the already-built image instead.
  botService.image = imageName;

  if (Object.keys(envMap).length > 0) {
    botService.environment = envMap;
  }

  botService.volumes = [{
    type: 'bind',
    // Relative source; processComposeForCasaOS rewrites it to
    // /DATA/AppData/<app>/data so the bot's data is browsable + CasaOS-managed.
    source: './data',
    target: '/app/data'
  }];

  botService['x-casaos'] = {
    volumes: [{
      container: '/app/data',
      description: { en_us: 'Persistent data directory for bot storage.' }
    }]
  };

  compose.services['bot'] = botService;

  // Add backing services (databases + Lavalink) detected from dependencies
  addBackingServices(compose, bot, appName, detection);

  // CasaOS metadata
  compose['x-casaos'] = {
    architectures: ['amd64', 'arm64'],
    main: 'bot',
    build: 'bot',
    author: 'discord-bot-manager',
    developer: 'discord-bot-manager',
    tagline: { en_us: `Discord Bot: ${bot.displayName}` },
    category: 'Utilities',
    description: { en_us: `Managed Discord bot: ${bot.displayName}` },
    title: { en_us: bot.displayName },
    is_uncontrolled: false,
    store_app_id: appName
  };

  return formatComposeYaml(compose);
}

/**
 * Add backing services (databases + Lavalink) based on detection, wiring the
 * connection env vars onto the bot service. Lavalink is driven by needsLavalink;
 * databases are added per detected engine. SQLite needs no service (the existing
 * /app/data bind persists the db file).
 */
function addBackingServices(
  compose: ComposeFile,
  bot: BotConfig,
  appName: string,
  detection: DetectionResult
): void {
  const botService = compose.services['bot'];
  const pw = defaultDbPassword();

  for (const db of detection.databases) {
    switch (db) {
      case 'postgres': addPostgres(compose, botService, bot.id, appName, pw); break;
      case 'mongo': addMongo(compose, botService, bot.id, appName, pw); break;
      case 'mariadb':
      case 'mysql': addMariadb(compose, botService, bot.id, appName, pw); break;
      case 'redis': addRedis(compose, botService, bot.id, appName); break;
      case 'sqlite': break;
    }
  }

  if (detection.needsLavalink) {
    addLavalink(compose, botService, bot.id, appName);
  }
}

function defaultDbPassword(): string {
  return process.env.APP_DEFAULT_PASSWORD || 'casaos';
}

function dbLabels(botId: string, serviceType: string): Record<string, string> {
  return { 'managed-by': 'discord-bot-manager', 'bot-id': botId, 'service-type': serviceType };
}

function addDependency(botService: ComposeService, dep: string): void {
  if (!botService.depends_on) botService.depends_on = [];
  if (!botService.depends_on.includes(dep)) botService.depends_on.push(dep);
}

function setBotEnv(botService: ComposeService, vars: Record<string, string>): void {
  if (!botService.environment) botService.environment = {};
  for (const [key, value] of Object.entries(vars)) {
    if (!(key in botService.environment)) botService.environment[key] = value;
  }
}

function registerVolume(compose: ComposeFile, name: string): void {
  compose.volumes = compose.volumes || {};
  compose.volumes[name] = {};
}

function addPostgres(compose: ComposeFile, botService: ComposeService, botId: string, appName: string, pw: string): void {
  if (compose.services['postgres']) return;
  const volName = `${appName}-postgres-data`;
  compose.services['postgres'] = {
    image: 'postgres:16-alpine',
    container_name: `${appName}-postgres`,
    restart: 'unless-stopped',
    cpu_shares: 10,
    networks: ['internal'],
    environment: {
      POSTGRES_USER: 'bot',
      POSTGRES_PASSWORD: pw,
      POSTGRES_DB: 'bot_data'
    },
    volumes: [{ type: 'volume', source: volName, target: '/var/lib/postgresql/data' }],
    labels: dbLabels(botId, 'database'),
    'x-casaos': { volumes: [{ container: '/var/lib/postgresql/data', description: { en_us: 'PostgreSQL database storage.' } }] }
  };
  addDependency(botService, 'postgres');
  setBotEnv(botService, { DATABASE_URL: `postgresql://bot:${pw}@postgres:5432/bot_data` });
  registerVolume(compose, volName);
}

function addMongo(compose: ComposeFile, botService: ComposeService, botId: string, appName: string, pw: string): void {
  if (compose.services['mongo']) return;
  const volName = `${appName}-mongo-data`;
  compose.services['mongo'] = {
    image: 'mongo:7',
    container_name: `${appName}-mongo`,
    restart: 'unless-stopped',
    cpu_shares: 10,
    networks: ['internal'],
    environment: {
      MONGO_INITDB_ROOT_USERNAME: 'bot',
      MONGO_INITDB_ROOT_PASSWORD: pw
    },
    volumes: [{ type: 'volume', source: volName, target: '/data/db' }],
    labels: dbLabels(botId, 'database'),
    'x-casaos': { volumes: [{ container: '/data/db', description: { en_us: 'MongoDB database storage.' } }] }
  };
  addDependency(botService, 'mongo');
  const uri = `mongodb://bot:${pw}@mongo:27017/bot_data?authSource=admin`;
  setBotEnv(botService, { MONGO_URI: uri, MONGODB_URI: uri });
  registerVolume(compose, volName);
}

function addMariadb(compose: ComposeFile, botService: ComposeService, botId: string, appName: string, pw: string): void {
  if (compose.services['mariadb']) return;
  const volName = `${appName}-mariadb-data`;
  compose.services['mariadb'] = {
    image: 'mariadb:11',
    container_name: `${appName}-mariadb`,
    restart: 'unless-stopped',
    cpu_shares: 10,
    networks: ['internal'],
    environment: {
      MARIADB_USER: 'bot',
      MARIADB_PASSWORD: pw,
      MARIADB_DATABASE: 'bot_data',
      MARIADB_ROOT_PASSWORD: pw
    },
    volumes: [{ type: 'volume', source: volName, target: '/var/lib/mysql' }],
    labels: dbLabels(botId, 'database'),
    'x-casaos': { volumes: [{ container: '/var/lib/mysql', description: { en_us: 'MariaDB database storage.' } }] }
  };
  addDependency(botService, 'mariadb');
  setBotEnv(botService, { DATABASE_URL: `mysql://bot:${pw}@mariadb:3306/bot_data` });
  registerVolume(compose, volName);
}

function addRedis(compose: ComposeFile, botService: ComposeService, botId: string, appName: string): void {
  if (compose.services['redis']) return;
  const volName = `${appName}-redis-data`;
  compose.services['redis'] = {
    image: 'redis:7-alpine',
    container_name: `${appName}-redis`,
    restart: 'unless-stopped',
    cpu_shares: 10,
    networks: ['internal'],
    volumes: [{ type: 'volume', source: volName, target: '/data' }],
    labels: dbLabels(botId, 'cache'),
    'x-casaos': { volumes: [{ container: '/data', description: { en_us: 'Redis data storage.' } }] }
  };
  addDependency(botService, 'redis');
  setBotEnv(botService, { REDIS_URL: 'redis://redis:6379' });
  registerVolume(compose, volName);
}

function addLavalink(compose: ComposeFile, botService: ComposeService, botId: string, appName: string): void {
  if (compose.services['lavalink']) return;
  compose.services['lavalink'] = {
    image: 'ghcr.io/lavalink-devs/lavalink:4',
    container_name: `${appName}-lavalink`,
    restart: 'unless-stopped',
    cpu_shares: 20,
    networks: ['internal'],
    environment: {
      _JAVA_OPTIONS: '-Xmx1G',
      SERVER_PORT: '2333',
      LAVALINK_SERVER_PASSWORD: 'youshallnotpass'
    },
    expose: ['2333'],
    healthcheck: {
      test: ['CMD-SHELL', "curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: youshallnotpass' http://localhost:2333/version | grep -q 200"],
      interval: '30s',
      timeout: '10s',
      retries: 5,
      start_period: '30s'
    },
    labels: dbLabels(botId, 'lavalink')
  };
  addDependency(botService, 'lavalink');
  setBotEnv(botService, {
    LAVALINK_HOST: 'lavalink',
    LAVALINK_PORT: '2333',
    LAVALINK_PASSWORD: 'youshallnotpass'
  });
}

/**
 * Format compose object to YAML
 */
function formatComposeYaml(compose: ComposeFile): string {
  const lines: string[] = [];

  lines.push(`name: ${compose.name}`);
  lines.push('');
  lines.push('services:');

  for (const [serviceName, service] of Object.entries(compose.services)) {
    lines.push(`  ${serviceName}:`);

    if (service.image) {
      lines.push(`    image: ${service.image}`);
    }

    if (service.build) {
      lines.push('    build:');
      lines.push(`      context: ${service.build.context}`);
      lines.push(`      dockerfile: ${service.build.dockerfile}`);
    }

    lines.push(`    container_name: ${service.container_name}`);
    lines.push(`    restart: ${service.restart}`);

    if (service.cpu_shares !== undefined) {
      lines.push(`    cpu_shares: ${service.cpu_shares}`);
    }

    if (service.depends_on?.length) {
      lines.push('    depends_on:');
      for (const dep of service.depends_on) {
        lines.push(`      - ${dep}`);
      }
    }

    if (service.environment && Object.keys(service.environment).length > 0) {
      lines.push('    environment:');
      for (const [key, value] of Object.entries(service.environment)) {
        const needsQuotes = /[:\s#{}[\],&*!|>'"%@`]/.test(value) || value === '';
        const formatted = needsQuotes ? `"${value.replace(/"/g, '\\"')}"` : value;
        lines.push(`      ${key}: ${formatted}`);
      }
    }

    if (service.expose?.length) {
      lines.push('    expose:');
      for (const port of service.expose) {
        lines.push(`      - "${port}"`);
      }
    }

    if (service.healthcheck) {
      const hc = service.healthcheck;
      lines.push('    healthcheck:');
      lines.push(`      test: [${hc.test.map(t => JSON.stringify(t)).join(', ')}]`);
      if (hc.interval) lines.push(`      interval: ${hc.interval}`);
      if (hc.timeout) lines.push(`      timeout: ${hc.timeout}`);
      if (hc.retries !== undefined) lines.push(`      retries: ${hc.retries}`);
      if (hc.start_period) lines.push(`      start_period: ${hc.start_period}`);
    }

    if (service.volumes?.length) {
      lines.push('    volumes:');
      for (const vol of service.volumes) {
        lines.push(`      - type: ${vol.type}`);
        lines.push(`        source: ${vol.source}`);
        lines.push(`        target: ${vol.target}`);
      }
    }

    if (service.networks?.length) {
      lines.push('    networks:');
      for (const net of service.networks) {
        lines.push(`      - ${net}`);
      }
    }

    if (service.labels) {
      lines.push('    labels:');
      for (const [key, value] of Object.entries(service.labels)) {
        lines.push(`      ${key}: "${value}"`);
      }
    }

    if (service['x-casaos']) {
      lines.push('    x-casaos:');
      if (service['x-casaos'].volumes) {
        lines.push('      volumes:');
        for (const vol of service['x-casaos'].volumes) {
          lines.push(`        - container: ${vol.container}`);
          lines.push('          description:');
          lines.push(`            en_us: ${vol.description.en_us}`);
        }
      }
    }

    lines.push('');
  }

  if (compose.networks && Object.keys(compose.networks).length > 0) {
    lines.push('networks:');
    for (const [netName, netConfig] of Object.entries(compose.networks)) {
      lines.push(`  ${netName}:`);
      if (netConfig.driver) {
        lines.push(`    driver: ${netConfig.driver}`);
      }
      if (netConfig.name) {
        lines.push(`    name: ${netConfig.name}`);
      }
      if (netConfig.external) {
        lines.push('    external: true');
      }
    }
    lines.push('');
  }

  if (compose.volumes && Object.keys(compose.volumes).length > 0) {
    lines.push('volumes:');
    for (const volName of Object.keys(compose.volumes)) {
      lines.push(`  ${volName}:`);
    }
    lines.push('');
  }

  if (compose['x-casaos']) {
    const casaos = compose['x-casaos'];
    lines.push('x-casaos:');
    lines.push('  architectures:');
    for (const arch of casaos.architectures) {
      lines.push(`    - ${arch}`);
    }
    lines.push(`  main: ${casaos.main}`);
    if (casaos.build) {
      lines.push(`  build: ${casaos.build}`);
    }
    lines.push(`  author: ${casaos.author}`);
    lines.push(`  developer: ${casaos.developer}`);
    lines.push('  tagline:');
    lines.push(`    en_us: "${casaos.tagline.en_us}"`);
    lines.push(`  category: ${casaos.category}`);
    lines.push('  description:');
    lines.push(`    en_us: "${casaos.description.en_us}"`);
    lines.push('  title:');
    lines.push(`    en_us: "${casaos.title.en_us}"`);
    if (casaos.is_uncontrolled !== undefined) {
      lines.push(`  is_uncontrolled: ${casaos.is_uncontrolled}`);
    }
    if (casaos.store_app_id) {
      lines.push(`  store_app_id: ${casaos.store_app_id}`);
    }
  }

  return lines.join('\n');
}

/**
 * Write docker-compose.yml to bot directory
 */
export function writeComposeFile(botDir: string, content: string): void {
  const composePath = path.join(botDir, 'docker-compose.yml');
  fs.writeFileSync(composePath, content);
  console.log(`[Compose] Wrote docker-compose.yml to ${composePath}`);
}

/**
 * Check if bot has existing docker-compose.yml in repo
 */
export function hasExistingCompose(repoPath: string): string | null {
  // Standard names take precedence (unchanged behavior); deploy-intent variants
  // (prod / production / standalone) are a fallback for repos that ship only a
  // named compose. Dev/test/example/override variants are intentionally NOT
  // matched so we never grab a development-only compose.
  const composeFiles = [
    'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml',
    'docker-compose.prod.yml', 'docker-compose.prod.yaml',
    'docker-compose.production.yml', 'docker-compose.production.yaml',
    'docker-compose.standalone.yml', 'docker-compose.standalone.yaml',
    'compose.prod.yml', 'compose.prod.yaml',
    'compose.production.yml', 'compose.production.yaml',
    'compose.standalone.yml', 'compose.standalone.yaml',
  ];

  for (const file of composeFiles) {
    const filePath = path.join(repoPath, file);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }

  return null;
}

/**
 * Adapt existing compose file for CasaOS
 * - Applies variable substitution (string-level, before YAML parse)
 * - Processes all CasaOS modifications in a single YAML parse/stringify cycle
 */
export function adaptExistingCompose(
  repoPath: string,
  botDir: string,
  bot: BotConfig,
  mode: DeploymentMode = 'casaos'
): ComposeResult {
  const existingPath = hasExistingCompose(repoPath);
  if (!existingPath) {
    throw new Error('No existing compose file found');
  }

  let content = fs.readFileSync(existingPath, 'utf-8');
  const fallbackName = `bot-${bot.id}`;

  // Extract original compose name BEFORE any modifications
  const originalName = extractAppName(content);
  const appName = originalName || fallbackName;

  // 1. Apply variable substitution (string-level $VAR replacement, must happen before YAML parse)
  content = applyVariableSubstitution(content, bot);

  // 2. Single-pass processing: parse YAML once, apply all modifications, stringify once.
  //    casaos mode handles ports->expose, Caddy/x-casaos, /DATA paths, networks, PUID/PGID;
  //    docker mode keeps published ports, strips pcs/Caddy, injects PUID/PGID/TZ.
  content = processComposeForCasaOS(content, appName, bot, { mode }).content;

  return { content, appName };
}

/**
 * Generate docker-compose.yml for docker-image source type
 * Used when deploying pre-built images (no git clone)
 */
export function generateImageCompose(bot: BotConfig, botDir: string, dataTarget: string = '/app/data'): string {
  if (!bot.imageRef) {
    throw new Error('imageRef is required for docker-image source type');
  }

  const appName = `bot-${bot.id}`;

  // Build environment map
  const envMap: Record<string, string> = {};
  if (bot.envVars) {
    for (const [key, value] of Object.entries(bot.envVars)) {
      envMap[key] = value;
    }
  }
  // Add Bot Manager update token
  if (bot.updateToken) {
    envMap['BOT_MANAGER_UPDATE_TOKEN'] = bot.updateToken;
  }

  const compose: ComposeFile = {
    name: appName,
    services: {
      bot: {
        image: bot.imageRef,
        container_name: `${appName}-app`,
        restart: 'unless-stopped',
        cpu_shares: 50,
        networks: ['internal', 'pcs'],
        labels: {
          'managed-by': 'discord-bot-manager',
          'bot-id': bot.id,
          'bot-name': bot.displayName
        },
        volumes: [{
          type: 'bind',
          // Relative source; processComposeForCasaOS rewrites it to
          // /DATA/AppData/<app>/data so the bot's data is browsable + CasaOS-managed.
          source: './data',
          target: dataTarget
        }],
        'x-casaos': {
          volumes: [{
            container: dataTarget,
            description: { en_us: 'Persistent data directory for bot storage.' }
          }]
        }
      }
    },
    networks: {
      internal: { driver: 'bridge' },
      pcs: { name: 'pcs', external: true }
    },
    'x-casaos': {
      architectures: ['amd64', 'arm64'],
      main: 'bot',
      author: 'discord-bot-manager',
      developer: 'discord-bot-manager',
      tagline: { en_us: `Discord Bot: ${bot.displayName}` },
      category: 'Utilities',
      description: { en_us: `Managed Discord bot: ${bot.displayName}` },
      title: { en_us: bot.displayName },
      is_uncontrolled: false,
      store_app_id: appName
    }
  };

  if (Object.keys(envMap).length > 0) {
    compose.services['bot'].environment = envMap;
  }

  // Apply variable substitution to the generated compose
  let content = formatComposeYaml(compose);
  content = applyVariableSubstitution(content, bot);

  return content;
}

/**
 * Read and process an existing compose file from repo
 * Returns the processed content ready for deployment
 */
export function processExistingCompose(
  repoPath: string,
  botDir: string,
  bot: BotConfig,
  mode: DeploymentMode = 'casaos'
): ComposeResult {
  const composePath = hasExistingCompose(repoPath);
  if (!composePath) {
    throw new Error('No compose file found in repository');
  }

  console.log(`[Compose] Using existing compose file: ${composePath}`);
  return adaptExistingCompose(repoPath, botDir, bot, mode);
}

/**
 * Resolve a compose build-arg value. Plain literals pass through; `${VAR:-default}`
 * / `${VAR-default}` yield the default; an unresolved `${VAR}` / `$VAR` returns null
 * (we must not pass an empty arg, which would override a Dockerfile's own default).
 */
function resolveBuildArgValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (s === '') return null;
  if (s.startsWith('$')) {
    const m = s.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-|-)?([^}]*)\}$/);
    if (m && m[2]) return m[2];
    return null;
  }
  return s;
}

function extractArgsFromBuild(build: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (!build || typeof build !== 'object') return out;
  const rawArgs = build.args;
  if (!rawArgs) return out;
  const put = (key: string, value: unknown) => {
    if (!key) return;
    const resolved = resolveBuildArgValue(value);
    if (resolved !== null) out[key] = resolved;
  };
  if (Array.isArray(rawArgs)) {
    for (const entry of rawArgs) {
      if (typeof entry !== 'string') continue;
      const eq = entry.indexOf('=');
      if (eq < 0) continue;   // "KEY" (pull from environment) - we cannot resolve it
      put(entry.slice(0, eq), entry.slice(eq + 1));
    }
  } else if (typeof rawArgs === 'object') {
    for (const [key, value] of Object.entries(rawArgs)) put(key, value);
  }
  return out;
}

/**
 * Extract the build-target service's `build.args` from a repo compose so they can
 * be relayed to `docker build` (the manager builds with plain docker build, which
 * otherwise drops the args the repo author defined).
 */
export function extractComposeBuildArgs(composeContent: string, serviceName: string | null): Record<string, string> {
  if (!serviceName) return {};
  let compose: any;
  try {
    compose = parseDocument(composeContent).toJSON();
  } catch {
    return {};
  }
  const build = compose?.services?.[serviceName]?.build;
  if (!build || typeof build === 'string') return {};
  return extractArgsFromBuild(build);
}

export interface ComposeBuildService {
  serviceName: string;
  context: string;       // absolute build context
  dockerfile: string;    // absolute Dockerfile path
  args: Record<string, string>;
}

/**
 * Find every service in a compose that builds from source, resolving each one's
 * build context + dockerfile to absolute paths under the repo. The manager
 * pre-builds these (with the right context/dockerfile/args) because deploy is a
 * plain `docker compose up` whose relative build contexts would otherwise resolve
 * against the metadata dir, not the repo.
 */
export function findBuildServices(composeContent: string, repoPath: string, exclude?: string | null): ComposeBuildService[] {
  let compose: any;
  try {
    compose = parseDocument(composeContent).toJSON();
  } catch {
    return [];
  }
  const services = compose?.services;
  if (!services || typeof services !== 'object') return [];

  const out: ComposeBuildService[] = [];
  for (const [name, svc] of Object.entries<any>(services)) {
    if (exclude && name === exclude) continue;
    const build = svc?.build;
    if (!build) continue;

    let ctx = '.';
    let df = 'Dockerfile';
    if (typeof build === 'string') {
      ctx = build;
    } else if (typeof build === 'object') {
      if (typeof build.context === 'string') ctx = build.context;
      if (typeof build.dockerfile === 'string') df = build.dockerfile;
    }
    const absContext = path.resolve(repoPath, ctx);
    const absDockerfile = path.isAbsolute(df) ? df : path.resolve(absContext, df);
    out.push({ serviceName: name, context: absContext, dockerfile: absDockerfile, args: extractArgsFromBuild(build) });
  }
  return out;
}

/**
 * Rewrite a compose so the given services use a pre-built image instead of a
 * build section.
 */
export function replaceBuildsWithImages(composeContent: string, mapping: Record<string, string>): string {
  let compose: any;
  try {
    compose = parseDocument(composeContent).toJSON();
  } catch {
    return composeContent;
  }
  const services = compose?.services;
  if (!services) return composeContent;
  for (const [name, tag] of Object.entries(mapping)) {
    if (services[name]) {
      services[name].image = tag;
      delete services[name].build;
    }
  }
  return stringify(compose, { lineWidth: 0 });
}

/**
 * Extract x-casaos.build target from compose content
 * Returns the service name that should be built locally, or null if not specified
 */
export function extractBuildTarget(composeContent: string): string | null {
  // Match x-casaos: section and find build: field
  const xcasaosMatch = composeContent.match(/^x-casaos:\s*\n((?:[ \t]+.*\n)*)/m);
  if (!xcasaosMatch) {
    return null;
  }

  const xcasaosSection = xcasaosMatch[1];
  const buildMatch = xcasaosSection.match(/^\s+build:\s*(\S+)/m);

  if (buildMatch) {
    return buildMatch[1].trim();
  }

  return null;
}

/**
 * Replace the image reference for a service with a local build configuration
 * Used when x-casaos.build specifies a service to build locally
 */
export function replaceServiceImageWithBuild(
  composeContent: string,
  serviceName: string,
  repoPath: string,
  imageName: string
): string {
  const lines = composeContent.split('\n');
  const result: string[] = [];

  let inServices = false;
  let inTargetService = false;
  let serviceIndent = 0;
  let foundImage = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Detect services section
    if (trimmed === 'services:') {
      inServices = true;
      result.push(line);
      continue;
    }

    // Detect service by name
    if (inServices && trimmed === `${serviceName}:`) {
      const indent = line.length - line.trimStart().length;
      if (indent === 2) {
        inTargetService = true;
        serviceIndent = indent;
        foundImage = false;
      }
      result.push(line);
      continue;
    }

    // If we're in the target service
    if (inTargetService) {
      const currentIndent = line.length - line.trimStart().length;

      // Check if we've exited the service (back to service-level indent or less)
      if (trimmed && currentIndent <= serviceIndent && !trimmed.startsWith('-')) {
        inTargetService = false;
      } else if (trimmed.startsWith('image:')) {
        // Replace image with the pre-built local image
        foundImage = true;
        result.push(`    image: ${imageName}`);
        continue;
      }
    }

    // Detect end of services section
    if (inServices && trimmed.endsWith(':') && !trimmed.includes(' ')) {
      const indent = line.length - line.trimStart().length;
      if (indent === 0 && trimmed !== 'services:') {
        inServices = false;
        inTargetService = false;
      }
    }

    result.push(line);
  }

  return result.join('\n');
}

/**
 * Get build info from compose - returns service name and whether it needs building
 */
export interface ComposeBuildInfo {
  buildTarget: string | null;
  hasBuildTarget: boolean;
}

export function getComposeBuildInfo(repoPath: string): ComposeBuildInfo {
  const composePath = hasExistingCompose(repoPath);
  if (!composePath) {
    return { buildTarget: null, hasBuildTarget: false };
  }

  const content = fs.readFileSync(composePath, 'utf-8');
  const buildTarget = extractBuildTarget(content);

  return {
    buildTarget,
    hasBuildTarget: buildTarget !== null
  };
}
