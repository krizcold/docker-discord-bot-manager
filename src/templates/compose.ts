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
import { BotConfig, DetectionResult } from '../types';
import { applyVariableSubstitution } from './variableSubstitution';
import { processComposeForCasaOS, extractAppName } from './pcsProcessing';

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
  botDir: string
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
      'bot-name': bot.name
    }
  };

  if (detection.hasDockerfile || detection.type !== 'compose') {
    botService.build = {
      context: path.join(botDir, 'repo'),
      dockerfile: 'Dockerfile'
    };
  }

  if (Object.keys(envMap).length > 0) {
    botService.environment = envMap;
  }

  botService.volumes = [{
    type: 'bind',
    source: path.join(botDir, 'data'),
    target: '/app/data'
  }];

  botService['x-casaos'] = {
    volumes: [{
      container: '/app/data',
      description: { en_us: 'Persistent data directory for bot storage.' }
    }]
  };

  compose.services['bot'] = botService;

  // Add database if detected
  if (detection.hasDatabase && !detection.hasCompose) {
    addDatabaseService(compose, bot.id, appName);
  }

  // CasaOS metadata
  compose['x-casaos'] = {
    architectures: ['amd64', 'arm64'],
    main: 'bot',
    build: 'bot',
    author: 'discord-bot-manager',
    developer: 'discord-bot-manager',
    tagline: { en_us: `Discord Bot: ${bot.name}` },
    category: 'Utilities',
    description: { en_us: `Managed Discord bot: ${bot.name}` },
    title: { en_us: bot.name },
    is_uncontrolled: false,
    store_app_id: appName
  };

  return formatComposeYaml(compose);
}

/**
 * Add database service (PostgreSQL)
 */
function addDatabaseService(compose: ComposeFile, botId: string, appName: string): void {
  const dbVolumeName = `${appName}-db-data`;

  compose.services['db'] = {
    image: 'postgres:15-alpine',
    container_name: `${appName}-db`,
    restart: 'unless-stopped',
    cpu_shares: 10,
    networks: ['internal'],
    environment: {
      POSTGRES_USER: 'bot',
      POSTGRES_PASSWORD: 'bot_password',
      POSTGRES_DB: 'bot_data'
    },
    volumes: [{
      type: 'volume',
      source: dbVolumeName,
      target: '/var/lib/postgresql/data'
    }],
    labels: {
      'managed-by': 'discord-bot-manager',
      'bot-id': botId,
      'service-type': 'database'
    },
    'x-casaos': {
      volumes: [{
        container: '/var/lib/postgresql/data',
        description: { en_us: 'PostgreSQL database storage.' }
      }]
    }
  };

  compose.services['bot'].depends_on = ['db'];

  if (!compose.services['bot'].environment) {
    compose.services['bot'].environment = {};
  }
  compose.services['bot'].environment['DATABASE_URL'] = 'postgresql://bot:bot_password@db:5432/bot_data';

  compose.volumes = compose.volumes || {};
  compose.volumes[dbVolumeName] = {};
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
  const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

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
  bot: BotConfig
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

  // 2. Single-pass CasaOS processing: parse YAML once, apply all modifications, stringify once.
  //    Handles: version removal, name field, labels, x-casaos metadata, ports→expose,
  //    hostname, icon label, is_uncontrolled, volume paths, networks, PUID/PGID
  content = processComposeForCasaOS(content, appName, bot);

  return { content, appName };
}

/**
 * Generate docker-compose.yml for docker-image source type
 * Used when deploying pre-built images (no git clone)
 */
export function generateImageCompose(bot: BotConfig, botDir: string): string {
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
          'bot-name': bot.name
        },
        volumes: [{
          type: 'bind',
          source: path.join(botDir, 'data'),
          target: '/app/data'
        }],
        'x-casaos': {
          volumes: [{
            container: '/app/data',
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
      tagline: { en_us: `Discord Bot: ${bot.name}` },
      category: 'Utilities',
      description: { en_us: `Managed Discord bot: ${bot.name}` },
      title: { en_us: bot.name },
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
  bot: BotConfig
): ComposeResult {
  const composePath = hasExistingCompose(repoPath);
  if (!composePath) {
    throw new Error('No compose file found in repository');
  }

  console.log(`[Compose] Using existing compose file: ${composePath}`);
  return adaptExistingCompose(repoPath, botDir, bot);
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
