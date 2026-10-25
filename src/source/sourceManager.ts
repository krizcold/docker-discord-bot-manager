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
import { storeFileState, preserveCorruptCopy, corruptCopyNote, writeFileAtomic } from '../config/storeFile';
import { redactSecrets } from '../config/secretText';

const DATA_DIR = process.env.DATA_DIR || '/data/data';
const SOURCES_DIR = path.join(DATA_DIR, 'sources');
const REGISTRY_FILE = path.join(DATA_DIR, 'sources.json');

// ─── Registry Operations ───

// Registries handed out by a load that could not read sources.json: they look
// empty, so a save built on one (boot seeding included) would erase every source.
const brokenSourceLoads = new WeakSet<SourceRegistry>();
let warnedBrokenSources = false;

export function loadSourceRegistry(): SourceRegistry {
  const state = storeFileState(REGISTRY_FILE);
  if (state.kind === 'absent') return { sources: {} };
  try {
    if (state.kind === 'broken') throw new Error(state.error);
    const parsed = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.sources || typeof parsed.sources !== 'object') {
      throw new Error('sources.json is not a source registry');
    }
    warnedBrokenSources = false;
    return parsed as SourceRegistry;
  } catch (err) {
    if (!warnedBrokenSources) {
      warnedBrokenSources = true;
      console.warn('[SourceManager] sources.json is unreadable; it reads as empty and saves are refused until it reads again:', err);
    }
    preserveCorruptCopy(REGISTRY_FILE);
    const empty: SourceRegistry = { sources: {} };
    brokenSourceLoads.add(empty);
    return empty;
  }
}

/** Why sources.json cannot be read right now, or null when it reads (or is absent). */
export function sourceRegistryFault(): string | null {
  if (!brokenSourceLoads.has(loadSourceRegistry())) return null;
  return `The source registry (sources.json) cannot be read, so the source list is unknown and every change is refused. Repair or replace sources.json (${corruptCopyNote(REGISTRY_FILE)}).`;
}

/** Whether a git source's clone is on disk (image sources need none). */
export function isSourceCloned(source: SourceMeta): boolean {
  return source.sourceType === 'docker-image' || fs.existsSync(path.join(getSourceRepoPath(source.id), '.git'));
}

// Synchronous atomic write: each mutator's load -> mutate -> save runs to completion
// on the single JS thread (a deferred/queued write let a stale snapshot revert another
// writer's change), and temp+rename means a crash mid-write cannot truncate the file.
function saveSourceRegistry(registry: SourceRegistry): void {
  if (brokenSourceLoads.has(registry) || storeFileState(REGISTRY_FILE).kind === 'broken') {
    throw new Error(`The source registry (sources.json) cannot be read, so nothing was saved: a save would erase every source it lists. Repair or replace sources.json (${corruptCopyNote(REGISTRY_FILE)}).`);
  }
  writeFileAtomic(REGISTRY_FILE, JSON.stringify(registry, null, 2));
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

/**
 * A credentialed http(s) URL split for git: the URL without its userinfo,
 * and the environment that hands git the credential as an Authorization
 * header scoped to that origin (config read from GIT_CONFIG_COUNT), so it is
 * in no command line and never written into the clone's .git/config.
 */
export function gitCredentialEnv(url: string): { url: string; env: Record<string, string> | null } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { url, env: null };
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || (!u.username && !u.password)) return { url, env: null };
  const user = decodeURIComponent(u.username);
  const pass = decodeURIComponent(u.password);
  u.username = '';
  u.password = '';
  return {
    url: u.toString(),
    env: {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `http.${u.origin}/.extraHeader`,
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`,
    },
  };
}

// A clone with no output for this long is killed, so a stalled first clone fails and frees its URL.
const CLONE_SILENCE_LIMIT_MS = 5 * 60 * 1000;

/** A git client for this URL's repo, carrying its credential (if any) by environment. */
function gitFor(url: string, repoPath?: string): SimpleGit {
  const { env } = gitCredentialEnv(url);
  const git = repoPath ? simpleGit(repoPath) : simpleGit({ timeout: { block: CLONE_SILENCE_LIMIT_MS } });
  return env ? git.env({ ...process.env, ...env }) : git;
}

/** An error text with the URL's credential, raw or encoded, replaced by ***. */
export function withoutCredential(text: string, url: string): string {
  let user = '';
  let pass = '';
  try {
    const u = new URL(url);
    user = decodeURIComponent(u.username);
    pass = decodeURIComponent(u.password);
  } catch { /* not a URL: nothing to redact beyond the userinfo form */ }
  // A token-only URL carries its secret as the user name.
  return redactSecrets(getDisplayUrl(text), [pass || user]);
}

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(srcPath), destPath);
    } else if (entry.isDirectory()) {
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
function withoutProgress(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  const kept = message.split(/[\r\n]+/)
    .filter((line) => line.trim() && !line.startsWith('remote: ') && !/\d+% \(\d+\/\d+\)/.test(line));
  const cleaned = new Error(kept.join('\n') || 'git clone failed');
  return cleaned;
}

async function cloneRepo(url: string, repoPath: string, branch?: string | null): Promise<string> {
  // Clean any leftover dir from a previous failed clone so git won't refuse a non-empty target
  if (fs.existsSync(repoPath)) fs.rmSync(repoPath, { recursive: true, force: true });
  const git: SimpleGit = gitFor(url);
  const cloneUrl = gitCredentialEnv(url).url;
  if (branch) {
    try {
      await git.clone(cloneUrl, repoPath, ['--progress', '--branch', branch, '--single-branch']);
      return branch;
    } catch (err) {
      if (!/Remote branch .* not found/i.test(String(err))) throw withoutProgress(err);
      console.warn(`[SourceManager] Branch '${branch}' not found for ${getDisplayUrl(url)}; falling back to the default branch`);
      if (fs.existsSync(repoPath)) fs.rmSync(repoPath, { recursive: true, force: true });
    }
  }
  try {
    await git.clone(cloneUrl, repoPath, ['--progress', '--single-branch']);
  } catch (err) {
    throw withoutProgress(err);
  }
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

// URLs whose first clone is running: the source is registered only after it,
// so a second add of the same URL during the clone must be refused here.
const cloningUrls = new Set<string>();

function normalizeSourceUrl(u: string): string {
  return u.replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/\/([^@]+)@/, '//');
}

export function isSourceCloning(url: string): boolean {
  return cloningUrls.has(normalizeSourceUrl(url));
}

export async function createSource(request: CreateSourceRequest): Promise<SourceMeta> {
  const key = normalizeSourceUrl(request.url);
  if (cloningUrls.has(key)) throw new Error('A source with this URL is being cloned');
  cloningUrls.add(key);
  try {
    return await createSourceCloned(request);
  } finally {
    cloningUrls.delete(key);
  }
}

async function createSourceCloned(request: CreateSourceRequest): Promise<SourceMeta> {
  const sourceId = uuidv4();
  const now = new Date().toISOString();

  // Create directory structure
  const sourceDir = getSourceDir(sourceId);
  const repoPath = getSourceRepoPath(sourceId);
  fs.mkdirSync(sourceDir, { recursive: true });

  let source: SourceMeta;
  try {
    // Clone repository (auto-detects the default branch when none is given)
    console.log(`[SourceManager] Cloning ${getDisplayUrl(request.url)} (branch: ${request.branch || 'auto'})`);
    const branch = await cloneRepo(request.url, repoPath, request.branch);
    console.log(`[SourceManager] Repository cloned to ${repoPath} (branch: ${branch})`);

    try {
      createSourceRawBackup(sourceId);
    } catch (err: any) {
      throw new Error(`The source was not added: the raw copy of the clone failed (${err?.message || err})`);
    }
    try {
      const composePath = hasExistingCompose(repoPath);
      if (composePath) fs.writeFileSync(getOriginalComposePath(sourceId), fs.readFileSync(composePath, 'utf-8'));
    } catch (err: any) {
      throw new Error(`The source was not added: the compose copy of the clone failed (${err?.message || err})`);
    }

    const headCommit = await readHeadCommit(repoPath);
    const composeName = extractComposeName(repoPath);

    source = {
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

    // Loaded after the last await, so a registry write made during the clone is kept.
    const registry = loadSourceRegistry();
    const key = normalizeSourceUrl(request.url);
    if (Object.values(registry.sources).some(s => !!s.url && normalizeSourceUrl(s.url) === key)) {
      throw new Error('A source with this URL already exists');
    }
    registry.sources[sourceId] = source;
    saveSourceRegistry(registry);
  } catch (err) {
    // No registry entry names this new folder, so a failed add removes all of it.
    try {
      fs.rmSync(sourceDir, { recursive: true, force: true });
    } catch (rmErr: any) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${message}; its unregistered folder ${sourceDir} could not be removed (${rmErr?.message || rmErr})`);
    }
    throw err;
  }

  console.log(`[SourceManager] Source ${sourceId} created (composeName: ${source.composeName || 'none'})`);

  // Re-associate orphaned instances
  await reAssociateInstances(sourceId, request.url);

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

  const urlChanged = update.url !== undefined && update.url !== source.url;
  const branchChanged = update.branch !== undefined && update.branch !== source.branch;

  if (update.url !== undefined) source.url = update.url;
  if (update.autoUpdate !== undefined) source.autoUpdate = update.autoUpdate;
  if (update.branch !== undefined) source.branch = update.branch;
  source.updatedAt = new Date().toISOString();

  if (urlChanged || branchChanged) {
    // The clone is pinned to the old url/branch (--single-branch fetch refspec),
    // so wipe it; the next fetch re-clones with the new settings and refreshes commit info.
    fs.rmSync(getSourceDir(sourceId), { recursive: true, force: true });
    source.lastCommitHash = null;
    source.lastCommitMessage = null;
    source.lastCommitDate = null;
    source.cloneError = null;
    source.cloneFailedAt = null;
    console.log(`[SourceManager] Source ${sourceId} url/branch changed, clone wiped for re-clone`);
  }

  registry.sources[sourceId] = source;
  saveSourceRegistry(registry);

  return source;
}

// ─── Git Operations ───

const sourceLocks = new Map<string, Promise<unknown>>();

/**
 * Run fn while no other holder can fetch, reset or build from this source's checkout.
 */
export function withSourceLock<T>(sourceId: string, fn: () => Promise<T>): Promise<T> {
  const prev = sourceLocks.get(sourceId) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  sourceLocks.set(sourceId, tail);
  tail.then(() => { if (sourceLocks.get(sourceId) === tail) sourceLocks.delete(sourceId); });
  return run;
}

/** The checkout's HEAD commit, or null when it cannot be read. */
export async function readSourceHead(sourceId: string): Promise<string | null> {
  const repoPath = getSourceRepoPath(sourceId);
  if (!fs.existsSync(path.join(repoPath, '.git'))) return null;
  try {
    const hash = String(await simpleGit(repoPath).revparse(['HEAD'])).trim();
    return /^[0-9a-f]{7,64}$/i.test(hash) ? hash : null;
  } catch {
    return null;
  }
}

export interface FetchResult {
  hasUpdates: boolean;
  behindBy: number;
  /** Set when the checkout moved but its raw or compose copy failed. */
  copyError?: string;
}

function refreshSourceCopies(sourceId: string, repoPath: string, headHash: string | null): string | undefined {
  const at = headHash ? headHash.substring(0, 7) : 'an unread commit';
  const faults: string[] = [];
  try {
    createSourceRawBackup(sourceId);
  } catch (err: any) {
    faults.push(`the raw copy of the source at ${at} failed: ${err?.message || err}`);
  }
  try {
    const composePath = hasExistingCompose(repoPath);
    if (composePath) fs.writeFileSync(getOriginalComposePath(sourceId), fs.readFileSync(composePath, 'utf-8'));
  } catch (err: any) {
    faults.push(`the compose copy of the source at ${at} failed: ${err?.message || err}`);
  }
  if (faults.length === 0) return undefined;
  const copyError = `The source moved to ${at}, but ${faults.join('; ')}`;
  console.error(`[SourceManager] Source ${sourceId}: ${copyError}`);
  return copyError;
}

/**
 * Fetch source repo and pull if behind. Returns whether updates were found.
 */
export function fetchSource(sourceId: string): Promise<FetchResult> {
  return withSourceLock(sourceId, () => fetchSourceHeld(sourceId));
}

/** fetchSource for a caller that already holds withSourceLock for this source. */
export async function fetchSourceHeld(sourceId: string): Promise<FetchResult> {
  const source = getSource(sourceId);
  if (!source) throw new Error(`Source ${sourceId} not found`);

  const repoPath = getSourceRepoPath(sourceId);

  // If repo hasn't been cloned yet (default source), clone it now
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    console.log(`[SourceManager] Source ${sourceId} not cloned yet, cloning...`);
    const sourceDir = getSourceDir(sourceId);
    fs.mkdirSync(sourceDir, { recursive: true });
    let actualBranch: string;
    try {
      actualBranch = await cloneRepo(source.url, repoPath, source.branch);
    } catch (err: any) {
      recordCloneFailure(sourceId, withoutCredential(String(err?.message || err), source.url));
      throw err;
    }

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
      s.cloneError = null;
      s.cloneFailedAt = null;
      s.updatedAt = new Date().toISOString();
      saveSourceRegistry(registry);
    }

    const copyError = refreshSourceCopies(sourceId, repoPath, headCommit?.hash || null);
    return copyError ? { hasUpdates: false, behindBy: 0, copyError } : { hasUpdates: false, behindBy: 0 };
  }

  const git: SimpleGit = gitFor(source.url, repoPath);

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

    // Recorded before the copies, which can throw, so the registry never names a commit the checkout left.
    const headCommit = await readHeadCommit(repoPath);
    const registry = loadSourceRegistry();
    const s = registry.sources[sourceId];
    if (s) {
      s.lastCommitHash = headCommit?.hash || null;
      s.lastCommitMessage = headCommit?.message || null;
      s.lastCommitDate = headCommit?.date || null;
      s.lastChecked = new Date().toISOString();
      s.composeName = extractComposeName(repoPath);
      s.updatedAt = new Date().toISOString();
      saveSourceRegistry(registry);
    }

    console.log(`[SourceManager] Source ${sourceId} updated to ${headCommit?.hash?.substring(0, 7) || 'unknown'}`);
    const copyError = refreshSourceCopies(sourceId, repoPath, headCommit?.hash || null);
    if (copyError) return { hasUpdates: behindBy > 0, behindBy, copyError };
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

function recordCloneFailure(sourceId: string, reason: string): void {
  try {
    const registry = loadSourceRegistry();
    const s = registry.sources[sourceId];
    if (!s) return;
    s.cloneError = reason.trim() || 'the clone failed';
    s.cloneFailedAt = new Date().toISOString();
    saveSourceRegistry(registry);
  } catch (err) {
    console.warn(`[SourceManager] Could not record the clone failure of ${sourceId}:`, err);
  }
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
 * Re-associate orphaned instances when a source is added with a matching URL,
 * through containerManager's registry save (imported at call time: it imports
 * this module).
 */
async function reAssociateInstances(sourceId: string, sourceUrl: string): Promise<void> {
  const key = normalizeSourceUrl(sourceUrl);
  try {
    const { reassociateWithSource } = await import('../docker/containerManager');
    reassociateWithSource(sourceId, u => normalizeSourceUrl(u) === key);
  } catch (err) {
    console.warn('[SourceManager] Failed to re-associate instances:', err);
  }
}

/**
 * Find a source by URL (normalized comparison).
 */
export function findSourceByUrl(url: string): SourceMeta | null {
  const normalizedUrl = normalizeSourceUrl(url);
  const sources = getAllSources();
  return sources.find(s => normalizeSourceUrl(s.url) === normalizedUrl) || null;
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
  const fault = sourceRegistryFault();
  if (fault) throw new Error(fault);
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
