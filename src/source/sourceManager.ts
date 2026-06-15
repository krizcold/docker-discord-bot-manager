/**
 * Source Manager
 *
 * Manages git source repositories shared across bot instances.
 * Sources live at /data/data/sources/{sourceId}/ with repo/, raw/, original-compose.yml.
 * Registry stored at /data/data/sources.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import simpleGit, { SimpleGit } from 'simple-git';
import { SourceMeta, SourceRegistry, CreateSourceRequest, UpdateSourceRequest } from '../types';
import { hasExistingCompose, extractAppName } from '../templates/compose';

const DATA_DIR = process.env.DATA_DIR || '/data/data';
const SOURCES_DIR = path.join(DATA_DIR, 'sources');
const REGISTRY_FILE = path.join(DATA_DIR, 'sources.json');

// ─── Write Queue (same pattern as containerManager) ───

let writeInProgress = false;
const writeQueue: Array<() => void> = [];

function queueRegistryWrite(fn: () => void): void {
  writeQueue.push(fn);
  if (!writeInProgress) {
    processWriteQueue();
  }
}

function processWriteQueue(): void {
  if (writeQueue.length === 0) {
    writeInProgress = false;
    return;
  }
  writeInProgress = true;
  const fn = writeQueue.shift()!;
  try {
    fn();
  } catch (err) {
    console.error('[SourceManager] Registry write error:', err);
  }
  processWriteQueue();
}

// ─── Registry Operations ───

export function loadSourceRegistry(): SourceRegistry {
  if (!fs.existsSync(REGISTRY_FILE)) {
    return { sources: {} };
  }
  const data = fs.readFileSync(REGISTRY_FILE, 'utf-8');
  return JSON.parse(data) as SourceRegistry;
}

function saveRegistrySync(registry: SourceRegistry): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
}

function saveSourceRegistry(registry: SourceRegistry): void {
  queueRegistryWrite(() => saveRegistrySync(registry));
}

// ─── Path Helpers ───

export function getSourceDir(sourceId: string): string {
  return path.join(SOURCES_DIR, sourceId);
}

export function getSourceRepoPath(sourceId: string): string {
  return path.join(SOURCES_DIR, sourceId, 'repo');
}

export function getSourceRawPath(sourceId: string): string {
  return path.join(SOURCES_DIR, sourceId, 'raw');
}

export function getOriginalComposePath(sourceId: string): string {
  return path.join(SOURCES_DIR, sourceId, 'original-compose.yml');
}

// ─── Internal Helpers ───

function getDisplayUrl(url: string): string {
  return url.replace(/\/\/([^@]+)@/, '//***@');
}

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git') continue;
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function createSourceRawBackup(sourceId: string): void {
  const repoPath = getSourceRepoPath(sourceId);
  const rawPath = getSourceRawPath(sourceId);
  if (fs.existsSync(rawPath)) {
    fs.rmSync(rawPath, { recursive: true, force: true });
  }
  copyDirSync(repoPath, rawPath);
}

async function readHeadCommit(repoPath: string): Promise<{ hash: string; message: string; date: string } | null> {
  if (!fs.existsSync(path.join(repoPath, '.git'))) return null;
  const git: SimpleGit = simpleGit(repoPath);
  try {
    const log = await git.log({ maxCount: 1 });
    if (!log.latest) return null;
    return {
      hash: log.latest.hash,
      message: log.latest.message,
      date: log.latest.date,
    };
  } catch {
    return null;
  }
}

/**
 * Clone a repo, returning the actual branch cloned. When no branch is given
 * (or the requested branch does not exist), clone the remote's default branch
 * and report its real name so the registry stores the correct branch.
 */
async function cloneRepo(url: string, repoPath: string, branch?: string | null): Promise<string> {
  // Clean any leftover dir from a previous failed clone so git won't refuse a non-empty target
  if (fs.existsSync(repoPath)) fs.rmSync(repoPath, { recursive: true, force: true });
  const git: SimpleGit = simpleGit();
  if (branch) {
    try {
      await git.clone(url, repoPath, ['--branch', branch, '--single-branch']);
      return branch;
    } catch (err) {
      if (!/Remote branch .* not found/i.test(String(err))) throw err;
      console.warn(`[SourceManager] Branch '${branch}' not found for ${getDisplayUrl(url)}; falling back to the default branch`);
      if (fs.existsSync(repoPath)) fs.rmSync(repoPath, { recursive: true, force: true });
    }
  }
  await git.clone(url, repoPath, ['--single-branch']);
  try {
    const actual = (await simpleGit(repoPath).revparse(['--abbrev-ref', 'HEAD'])).trim();
    return actual || 'main';
  } catch {
    return 'main';
  }
}

function extractComposeName(repoPath: string): string | null {
  const composePath = hasExistingCompose(repoPath);
  if (!composePath) return null;
  const content = fs.readFileSync(composePath, 'utf-8');
  return extractAppName(content);
}

// ─── CRUD ───

export function getAllSources(): SourceMeta[] {
  const registry = loadSourceRegistry();
  return Object.values(registry.sources);
}

export function getSource(sourceId: string): SourceMeta | null {
  const registry = loadSourceRegistry();
  return registry.sources[sourceId] || null;
}

export async function createSource(request: CreateSourceRequest): Promise<SourceMeta> {
  const registry = loadSourceRegistry();
  const sourceId = uuidv4();
  const now = new Date().toISOString();

  // Create directory structure
  const sourceDir = getSourceDir(sourceId);
  const repoPath = getSourceRepoPath(sourceId);
  fs.mkdirSync(sourceDir, { recursive: true });

  // Clone repository (auto-detects the default branch when none is given)
  console.log(`[SourceManager] Cloning ${getDisplayUrl(request.url)} (branch: ${request.branch || 'auto'})`);
  const branch = await cloneRepo(request.url, repoPath, request.branch);
  console.log(`[SourceManager] Repository cloned to ${repoPath} (branch: ${branch})`);

  // Raw backup
  createSourceRawBackup(sourceId);

  // Save original compose if exists
  const composePath = hasExistingCompose(repoPath);
  if (composePath) {
    const composeContent = fs.readFileSync(composePath, 'utf-8');
    fs.writeFileSync(getOriginalComposePath(sourceId), composeContent);
  }

  // Read HEAD commit
  const headCommit = await readHeadCommit(repoPath);

  // Extract compose name
  const composeName = extractComposeName(repoPath);

  const source: SourceMeta = {
    id: sourceId,
    url: request.url,
    branch,
    lastCommitHash: headCommit?.hash || null,
    lastCommitMessage: headCommit?.message || null,
    lastCommitDate: headCommit?.date || null,
    lastChecked: now,
    autoUpdate: true,
    composeName,
    createdAt: now,
    updatedAt: now,
  };

  registry.sources[sourceId] = source;
  saveSourceRegistry(registry);

  console.log(`[SourceManager] Source ${sourceId} created (composeName: ${composeName || 'none'})`);

  // Re-associate orphaned instances
  reAssociateInstances(sourceId, request.url);

  return source;
}

export async function deleteSource(sourceId: string): Promise<boolean> {
  const registry = loadSourceRegistry();
  if (!registry.sources[sourceId]) return false;

  // Remove source directory
  const sourceDir = getSourceDir(sourceId);
  if (fs.existsSync(sourceDir)) {
    fs.rmSync(sourceDir, { recursive: true, force: true });
  }

  delete registry.sources[sourceId];
  saveSourceRegistry(registry);

  console.log(`[SourceManager] Source ${sourceId} deleted`);
  return true;
}

export function updateSource(sourceId: string, update: UpdateSourceRequest): SourceMeta | null {
  const registry = loadSourceRegistry();
  const source = registry.sources[sourceId];
  if (!source) return null;

  if (update.url !== undefined) source.url = update.url;
  if (update.autoUpdate !== undefined) source.autoUpdate = update.autoUpdate;
  if (update.branch !== undefined) source.branch = update.branch;
  source.updatedAt = new Date().toISOString();

  registry.sources[sourceId] = source;
  saveSourceRegistry(registry);

  return source;
}

// ─── Git Operations ───

/**
 * Fetch source repo and pull if behind. Returns whether updates were found.
 */
export async function fetchSource(sourceId: string): Promise<{ hasUpdates: boolean; behindBy: number }> {
  const source = getSource(sourceId);
  if (!source) throw new Error(`Source ${sourceId} not found`);

  const repoPath = getSourceRepoPath(sourceId);

  // If repo hasn't been cloned yet (default source), clone it now
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    console.log(`[SourceManager] Source ${sourceId} not cloned yet, cloning...`);
    const sourceDir = getSourceDir(sourceId);
    fs.mkdirSync(sourceDir, { recursive: true });
    const actualBranch = await cloneRepo(source.url, repoPath, source.branch);
    createSourceRawBackup(sourceId);

    // Save original compose if exists
    const composePath = hasExistingCompose(repoPath);
    if (composePath) {
      fs.writeFileSync(getOriginalComposePath(sourceId), fs.readFileSync(composePath, 'utf-8'));
    }

    // Update registry with initial commit info
    const headCommit = await readHeadCommit(repoPath);
    const registry = loadSourceRegistry();
    const s = registry.sources[sourceId];
    if (s) {
      s.branch = actualBranch;
      s.lastCommitHash = headCommit?.hash || null;
      s.lastCommitMessage = headCommit?.message || null;
      s.lastCommitDate = headCommit?.date || null;
      s.lastChecked = new Date().toISOString();
      s.composeName = extractComposeName(repoPath);
      s.updatedAt = new Date().toISOString();
      saveSourceRegistry(registry);
    }

    return { hasUpdates: false, behindBy: 0 };
  }

  const git: SimpleGit = simpleGit(repoPath);

  // Fetch
  await git.fetch();
  const status = await git.status();
  const behindBy = status.behind || 0;
  const aheadOrDirty = (status.ahead || 0) > 0 || status.files.length > 0;

  if (behindBy > 0 || aheadOrDirty) {
    // Source repos are read-only mirrors of origin. Any local divergence
    // (commits, modified files, untracked files) is wiped via hard reset
    // so we never hit merge conflicts during fetch.
    console.log(`[SourceManager] Source ${sourceId} diverged (behind=${behindBy}, ahead=${status.ahead || 0}, dirty=${status.files.length}), hard-resetting to origin/${source.branch}`);
    await git.raw(['reset', '--hard', `origin/${source.branch}`]);
    await git.raw(['clean', '-fd']);

    // Update raw backup
    createSourceRawBackup(sourceId);

    // Update original compose if exists
    const composePath = hasExistingCompose(repoPath);
    if (composePath) {
      const composeContent = fs.readFileSync(composePath, 'utf-8');
      fs.writeFileSync(getOriginalComposePath(sourceId), composeContent);
    }

    // Update registry
    const headCommit = await readHeadCommit(repoPath);
    const registry = loadSourceRegistry();
    const s = registry.sources[sourceId];
    if (s) {
      s.lastCommitHash = headCommit?.hash || s.lastCommitHash;
      s.lastCommitMessage = headCommit?.message || s.lastCommitMessage;
      s.lastCommitDate = headCommit?.date || s.lastCommitDate;
      s.lastChecked = new Date().toISOString();
      s.composeName = extractComposeName(repoPath);
      s.updatedAt = new Date().toISOString();
      saveSourceRegistry(registry);
    }

    console.log(`[SourceManager] Source ${sourceId} updated to ${headCommit?.hash?.substring(0, 7) || 'unknown'}`);
  } else {
    // Just update lastChecked
    const registry = loadSourceRegistry();
    const s = registry.sources[sourceId];
    if (s) {
      s.lastChecked = new Date().toISOString();
      saveSourceRegistry(registry);
    }
  }

  return { hasUpdates: behindBy > 0, behindBy };
}

/**
 * Count commits between `fromCommit` and the source repo's HEAD.
 * Returns 0 if the commit is unreachable, missing, or the repo isn't cloned.
 */
export async function getCommitsBehind(sourceId: string, fromCommit: string): Promise<number> {
  const repoPath = getSourceRepoPath(sourceId);
  if (!fromCommit || !fs.existsSync(path.join(repoPath, '.git'))) return 0;

  try {
    const git: SimpleGit = simpleGit(repoPath);
    const result = await git.raw(['rev-list', '--count', `${fromCommit}..HEAD`]);
    return parseInt(result.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Get repo info for a source.
 */
export async function getSourceRepoInfo(sourceId: string): Promise<{
  branch: string;
  lastCommit: string;
  lastCommitMessage: string;
  lastCommitDate: string;
} | null> {
  const repoPath = getSourceRepoPath(sourceId);
  if (!fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, '.git'))) {
    return null;
  }

  const git: SimpleGit = simpleGit(repoPath);
  try {
    const branch = await git.revparse(['--abbrev-ref', 'HEAD']);
    const log = await git.log({ maxCount: 1 });
    const latest = log.latest;
    return {
      branch: branch.trim(),
      lastCommit: latest?.hash.substring(0, 7) || 'unknown',
      lastCommitMessage: latest?.message || 'unknown',
      lastCommitDate: latest?.date || 'unknown',
    };
  } catch {
    return null;
  }
}

// ─── Re-association ───

/**
 * Re-associate orphaned instances when a source is added with a matching URL.
 * Reads instances.json directly to avoid circular dependency with containerManager.
 */
function reAssociateInstances(sourceId: string, sourceUrl: string): void {
  const instancesFile = path.join(DATA_DIR, 'instances.json');
  if (!fs.existsSync(instancesFile)) return;

  try {
    const data = JSON.parse(fs.readFileSync(instancesFile, 'utf-8'));
    let changed = false;

    for (const inst of Object.values(data.instances || {}) as any[]) {
      if (inst.sourceId === null && inst.sourceUrl) {
        // Normalize URLs for comparison (strip trailing .git and trailing slash)
        const normalize = (u: string) => u.replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/\/([^@]+)@/, '//');
        if (normalize(inst.sourceUrl) === normalize(sourceUrl)) {
          inst.sourceId = sourceId;
          inst.updatedAt = new Date().toISOString();
          changed = true;
          console.log(`[SourceManager] Re-associated instance ${inst.id} (${inst.displayName}) with source ${sourceId}`);
        }
      }
    }

    if (changed) {
      fs.writeFileSync(instancesFile, JSON.stringify(data, null, 2));
    }
  } catch (err) {
    console.warn('[SourceManager] Failed to re-associate instances:', err);
  }
}

/**
 * Find a source by URL (normalized comparison).
 */
export function findSourceByUrl(url: string): SourceMeta | null {
  const normalize = (u: string) => u.replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/\/([^@]+)@/, '//');
  const normalizedUrl = normalize(url);
  const sources = getAllSources();
  return sources.find(s => normalize(s.url) === normalizedUrl) || null;
}

// ─── Default Sources (seeded on first run) ───

// branch '' means auto-detect the remote's default branch at clone time
// (repos vary between main / master / develop).
const DEFAULT_SOURCES: Array<{ url?: string; branch?: string; imageRef?: string; displayName?: string }> = [
  // Our bot
  { url: 'https://github.com/krizcold/fully-modular-discord-bot', branch: '' },
  // Tier 1: Have Docker + compose
  { url: 'https://github.com/modmail-dev/Modmail', branch: '' },
  { url: 'https://github.com/bongodevs/lavamusic', branch: '' },
  { url: 'https://github.com/Zero6992/chatGPT-discord-bot', branch: '' },
  { url: 'https://github.com/open-discord-bots/open-ticket', branch: '' },
  { url: 'https://github.com/ZeppelinBot/Zeppelin', branch: '' },
  // Tier 2: Have Dockerfile, no compose
  { url: 'https://github.com/Androz2091/AtlantaBot', branch: '' },
  { url: 'https://github.com/nadeko-bot/nadekobot', branch: '' },
  { url: 'https://github.com/discord-tickets/bot', branch: '' },
  // Tier 3: No Docker (build/generate from source)
  { url: 'https://github.com/jagrosh/MusicBot', branch: '' },
  { url: 'https://github.com/Just-Some-Bots/MusicBot', branch: '' },
  { url: 'https://github.com/kkrypt0nn/Python-Discord-Bot-Template', branch: '' },
  // Prebuilt-image sources: bots whose only unattended path is a published image
  // (e.g. an interactive first-run setup that cannot be automated from source).
  { imageRef: 'phasecorex/red-discordbot', displayName: 'Red-DiscordBot' },
];

/**
 * Seed default sources on first run (empty registry only).
 * Sources are added as metadata-only entries, NOT cloned.
 * The repo is cloned on-demand when the user clicks Install or Fetch.
 */
export function seedDefaultSources(): void {
  const registry = loadSourceRegistry();
  if (Object.keys(registry.sources).length > 0) return; // Already has sources

  const now = new Date().toISOString();

  for (const entry of DEFAULT_SOURCES) {
    const sourceId = uuidv4();

    if (entry.imageRef) {
      // Prebuilt-image source: ready to install immediately (no clone step).
      registry.sources[sourceId] = {
        id: sourceId,
        sourceType: 'docker-image',
        imageRef: entry.imageRef,
        url: '',
        branch: '',
        lastCommitHash: null,
        lastCommitMessage: null,
        lastCommitDate: null,
        lastChecked: now,
        autoUpdate: false,
        composeName: entry.displayName || null,
        createdAt: now,
        updatedAt: now,
      };
      continue;
    }

    registry.sources[sourceId] = {
      id: sourceId,
      sourceType: 'git',
      url: entry.url || '',
      branch: entry.branch || '',
      lastCommitHash: null,
      lastCommitMessage: null,
      lastCommitDate: null,
      lastChecked: null,
      autoUpdate: true,   // Enabled: locked in UI until cloned, active once cloned
      composeName: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  saveSourceRegistry(registry);
  console.log(`[SourceManager] Seeded ${DEFAULT_SOURCES.length} default sources`);
}
