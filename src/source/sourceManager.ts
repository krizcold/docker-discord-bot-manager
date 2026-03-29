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
  const branch = request.branch || 'main';
  const now = new Date().toISOString();

  // Create directory structure
  const sourceDir = getSourceDir(sourceId);
  const repoPath = getSourceRepoPath(sourceId);
  fs.mkdirSync(sourceDir, { recursive: true });

  // Clone repository
  console.log(`[SourceManager] Cloning ${getDisplayUrl(request.url)} (branch: ${branch})`);
  const git: SimpleGit = simpleGit();
  await git.clone(request.url, repoPath, ['--branch', branch, '--single-branch']);
  console.log(`[SourceManager] Repository cloned to ${repoPath}`);

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
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    throw new Error(`No git repository at ${repoPath}`);
  }

  const git: SimpleGit = simpleGit(repoPath);

  // Fetch
  await git.fetch();
  const status = await git.status();
  const behindBy = status.behind || 0;

  if (behindBy > 0) {
    // Pull
    console.log(`[SourceManager] Source ${sourceId} is ${behindBy} commits behind, pulling...`);
    await git.pull('origin');

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
