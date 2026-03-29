/**
 * Migration: V1 (bots.json) -> V2 (sources.json + instances.json)
 *
 * Idempotent: skips if instances.json already exists.
 * Never deletes bots.json — renames to bots.json.v1-backup.
 * Preserves instance UUIDs so env/data paths stay valid.
 * Preserves appName for running CasaOS containers.
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import simpleGit from 'simple-git';
import { SourceMeta, SourceRegistry, InstanceConfig, InstanceRegistry } from '../types';
import { sanitizeName, titleizeName } from '../naming';
import { hasExistingCompose, extractAppName } from '../templates/compose';

const DATA_DIR = process.env.DATA_DIR || '/data/data';
const BOTS_JSON = path.join(DATA_DIR, 'bots.json');
const BOTS_BACKUP = path.join(DATA_DIR, 'bots.json.v1-backup');
const INSTANCES_JSON = path.join(DATA_DIR, 'instances.json');
const SOURCES_JSON = path.join(DATA_DIR, 'sources.json');
const BOTS_DIR = path.join(DATA_DIR, 'bots');
const SOURCES_DIR = path.join(DATA_DIR, 'sources');

// V1 types (what bots.json contained)
interface V1BotConfig {
  id: string;
  name: string;
  sourceType: 'git' | 'docker-image';
  url?: string;
  branch?: string;
  imageRef?: string;
  status: string;
  containerIds: string[];
  updateToken?: string;
  authHash?: string;
  envVars?: Record<string, string>;
  port?: number;
  botType?: string;
  hasDatabase?: boolean;
  hasBeenStarted?: boolean;
  autoUpdate?: boolean;
  appName?: string;
  createdAt: string;
  updatedAt: string;
}

interface V1Registry {
  bots: Record<string, V1BotConfig>;
  deploymentMode?: string;
}

function copyDirSync(src: string, dest: string, skipGit = false): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (skipGit && entry.name === '.git') continue;
      copyDirSync(srcPath, destPath, skipGit);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

export async function migrateV1toV2(): Promise<void> {
  // Idempotent: skip if already migrated
  if (fs.existsSync(INSTANCES_JSON)) {
    console.log('[Migration] instances.json already exists, skipping V1->V2 migration');
    return;
  }

  // Nothing to migrate if no bots.json
  if (!fs.existsSync(BOTS_JSON)) {
    console.log('[Migration] No bots.json found, creating empty registries');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(INSTANCES_JSON, JSON.stringify({ instances: {} }, null, 2));
    fs.writeFileSync(SOURCES_JSON, JSON.stringify({ sources: {} }, null, 2));
    return;
  }

  console.log('[Migration] Starting V1 -> V2 migration...');

  const v1Data: V1Registry = JSON.parse(fs.readFileSync(BOTS_JSON, 'utf-8'));
  const v1Bots = Object.values(v1Data.bots || {});

  if (v1Bots.length === 0) {
    console.log('[Migration] No bots in bots.json, creating empty registries');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(INSTANCES_JSON, JSON.stringify({ instances: {}, deploymentMode: v1Data.deploymentMode }, null, 2));
    fs.writeFileSync(SOURCES_JSON, JSON.stringify({ sources: {} }, null, 2));
    fs.renameSync(BOTS_JSON, BOTS_BACKUP);
    return;
  }

  // ── Step 1: Group git bots by (url, branch) ──

  const sourceGroups = new Map<string, V1BotConfig[]>();

  for (const bot of v1Bots) {
    if (bot.sourceType === 'docker-image' || !bot.url) continue;
    const key = `${normalizeUrl(bot.url)}|${bot.branch || 'main'}`;
    if (!sourceGroups.has(key)) sourceGroups.set(key, []);
    sourceGroups.get(key)!.push(bot);
  }

  // ── Step 2: Create sources ──

  const sourceRegistry: SourceRegistry = { sources: {} };
  const botToSource = new Map<string, string>(); // botId -> sourceId
  fs.mkdirSync(SOURCES_DIR, { recursive: true });

  for (const [key, bots] of sourceGroups) {
    const sourceId = uuidv4();
    const firstBot = bots[0];
    const now = new Date().toISOString();

    // Find a bot that has a repo directory
    const botWithRepo = bots.find(b => fs.existsSync(path.join(BOTS_DIR, b.id, 'repo')));
    const sourceDir = path.join(SOURCES_DIR, sourceId);
    fs.mkdirSync(sourceDir, { recursive: true });

    if (botWithRepo) {
      const oldRepoPath = path.join(BOTS_DIR, botWithRepo.id, 'repo');
      const oldRawPath = path.join(BOTS_DIR, botWithRepo.id, 'raw');
      const newRepoPath = path.join(sourceDir, 'repo');
      const newRawPath = path.join(sourceDir, 'raw');

      // Copy repo to source (copy instead of move to be safer)
      console.log(`[Migration] Copying repo from bot ${botWithRepo.id} to source ${sourceId}`);
      copyDirSync(oldRepoPath, newRepoPath);

      // Copy raw if exists
      if (fs.existsSync(oldRawPath)) {
        copyDirSync(oldRawPath, newRawPath);
      }

      // Save original compose if exists
      const composePath = hasExistingCompose(newRepoPath);
      if (composePath) {
        const composeContent = fs.readFileSync(composePath, 'utf-8');
        fs.writeFileSync(path.join(sourceDir, 'original-compose.yml'), composeContent);
      }
    }

    // Read HEAD commit if repo exists
    let lastCommitHash: string | null = null;
    let lastCommitMessage: string | null = null;
    let lastCommitDate: string | null = null;
    const repoPath = path.join(sourceDir, 'repo');
    if (fs.existsSync(path.join(repoPath, '.git'))) {
      try {
        const git = simpleGit(repoPath);
        const log = await git.log({ maxCount: 1 });
        if (log.latest) {
          lastCommitHash = log.latest.hash;
          lastCommitMessage = log.latest.message;
          lastCommitDate = log.latest.date;
        }
      } catch { /* ignore */ }
    }

    // Extract compose name
    let composeName: string | null = null;
    const existingCompose = hasExistingCompose(repoPath);
    if (existingCompose) {
      const content = fs.readFileSync(existingCompose, 'utf-8');
      composeName = extractAppName(content);
    }

    const source: SourceMeta = {
      id: sourceId,
      url: firstBot.url!,
      branch: firstBot.branch || 'main',
      lastCommitHash,
      lastCommitMessage,
      lastCommitDate,
      lastChecked: now,
      autoUpdate: true,
      composeName,
      createdAt: now,
      updatedAt: now,
    };

    sourceRegistry.sources[sourceId] = source;

    // Map all bots in this group to this source
    for (const bot of bots) {
      botToSource.set(bot.id, sourceId);
    }

    // Remove repo/ and raw/ from all bots in this group (they now use the shared source)
    for (const bot of bots) {
      const botRepoPath = path.join(BOTS_DIR, bot.id, 'repo');
      const botRawPath = path.join(BOTS_DIR, bot.id, 'raw');
      if (fs.existsSync(botRepoPath)) {
        fs.rmSync(botRepoPath, { recursive: true, force: true });
        console.log(`[Migration] Removed repo/ from bot ${bot.id}`);
      }
      if (fs.existsSync(botRawPath)) {
        fs.rmSync(botRawPath, { recursive: true, force: true });
        console.log(`[Migration] Removed raw/ from bot ${bot.id}`);
      }
    }

    console.log(`[Migration] Source ${sourceId} created for ${normalizeUrl(firstBot.url!)} (${bots.length} bot(s))`);
  }

  // ── Step 3: Create instances ──

  const instanceRegistry: InstanceRegistry = {
    instances: {},
    deploymentMode: v1Data.deploymentMode as any,
  };

  const usedSanitizedNames = new Set<string>();

  for (const bot of v1Bots) {
    let sanitized = sanitizeName(bot.name);

    // Collision check: append short UUID if duplicate
    if (usedSanitizedNames.has(sanitized)) {
      sanitized = `${sanitized}-${bot.id.substring(0, 4)}`;
      console.log(`[Migration] Name collision for "${bot.name}", using "${sanitized}"`);
    }
    usedSanitizedNames.add(sanitized);

    const instance: InstanceConfig = {
      id: bot.id,   // Preserve UUID for env/data path continuity
      sourceId: botToSource.get(bot.id) || null,
      sourceUrl: bot.url || null,
      sourceType: bot.sourceType || 'git',
      imageRef: bot.imageRef,
      displayName: bot.name,
      sanitizedName: sanitized,
      titleName: titleizeName(bot.name),
      status: bot.status as any,
      containerIds: bot.containerIds || [],
      updateToken: bot.updateToken,
      authHash: bot.authHash,
      envVars: bot.envVars,
      port: bot.port,
      botType: bot.botType as any,
      hasDatabase: bot.hasDatabase,
      hasBeenStarted: bot.hasBeenStarted,
      lastBuiltCommit: null,   // Unknown pre-migration
      appName: bot.appName,    // Preserve for running CasaOS containers
      createdAt: bot.createdAt,
      updatedAt: bot.updatedAt,
    };

    instanceRegistry.instances[bot.id] = instance;
    console.log(`[Migration] Instance ${bot.id} ("${bot.name}" -> sanitized: "${sanitized}")`);
  }

  // ── Step 4: Write new registries ──

  fs.writeFileSync(SOURCES_JSON, JSON.stringify(sourceRegistry, null, 2));
  fs.writeFileSync(INSTANCES_JSON, JSON.stringify(instanceRegistry, null, 2));

  // ── Step 5: Backup old bots.json ──

  fs.renameSync(BOTS_JSON, BOTS_BACKUP);

  console.log(`[Migration] V1 -> V2 migration complete: ${sourceGroups.size} source(s), ${v1Bots.length} instance(s)`);
  console.log(`[Migration] bots.json backed up to ${BOTS_BACKUP}`);
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/\/([^@]+)@/, '//');
}
