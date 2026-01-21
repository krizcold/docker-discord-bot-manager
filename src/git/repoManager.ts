/**
 * Git Repository Manager
 * Handles cloning and updating bot repositories
 *
 * Directory structure per bot:
 *   /data/bots/{botId}/
 *   ├── repo/    - Working copy (cloned, updated)
 *   ├── raw/     - RAW backup (pristine copy)
 *   ├── data/    - Bot's persistent data
 *   └── env/     - Environment variables
 */

import * as fs from 'fs';
import * as path from 'path';
import simpleGit, { SimpleGit } from 'simple-git';

const DATA_DIR = process.env.DATA_DIR || '/data/data';
const BOTS_DIR = path.join(DATA_DIR, 'bots');

/**
 * Get the base directory for a bot (contains repo/, raw/, data/, env/)
 */
export function getBotDir(botId: string): string {
  return path.join(BOTS_DIR, botId);
}

/**
 * Get the working repository path for a bot
 */
export function getRepoPath(botId: string): string {
  return path.join(BOTS_DIR, botId, 'repo');
}

/**
 * Get the RAW backup path for a bot
 */
export function getRawPath(botId: string): string {
  return path.join(BOTS_DIR, botId, 'raw');
}

/**
 * Get the data directory path for a bot
 */
export function getDataPath(botId: string): string {
  return path.join(BOTS_DIR, botId, 'data');
}

/**
 * Get the env directory path for a bot
 */
export function getEnvPath(botId: string): string {
  return path.join(BOTS_DIR, botId, 'env');
}

/**
 * Get display URL (hides token for logging)
 */
function getDisplayUrl(url: string): string {
  // Hide token in URL for display: https://TOKEN@github.com/... -> https://***@github.com/...
  return url.replace(/\/\/([^@]+)@/, '//***@');
}

/**
 * Copy directory recursively (for RAW backup)
 */
function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      // Skip .git directory for RAW backup
      if (entry.name === '.git') continue;
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Create RAW backup from repo
 */
export function createRawBackup(botId: string): void {
  const repoPath = getRepoPath(botId);
  const rawPath = getRawPath(botId);

  // Remove existing RAW backup
  if (fs.existsSync(rawPath)) {
    fs.rmSync(rawPath, { recursive: true, force: true });
  }

  // Copy repo to RAW (without .git)
  console.log(`[RepoManager] Creating RAW backup for bot ${botId}`);
  copyDirSync(repoPath, rawPath);
  console.log(`[RepoManager] RAW backup created at ${rawPath}`);
}

/**
 * Initialize bot directory structure
 */
function initBotDirectories(botId: string): void {
  const botDir = getBotDir(botId);
  const dirs = [
    path.join(botDir, 'repo'),
    path.join(botDir, 'raw'),
    path.join(botDir, 'data'),
    path.join(botDir, 'env')
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Clone a repository
 * URL should include token if private: https://TOKEN@github.com/owner/repo.git
 */
export async function cloneRepository(
  botId: string,
  url: string,
  branch: string
): Promise<void> {
  // Initialize directory structure
  initBotDirectories(botId);

  const repoPath = getRepoPath(botId);
  const git: SimpleGit = simpleGit();

  console.log(`[RepoManager] Cloning ${getDisplayUrl(url)} to ${repoPath} (branch: ${branch})`);

  // Clone with full history for proper update checking
  await git.clone(url, repoPath, ['--branch', branch, '--single-branch']);

  console.log(`[RepoManager] Repository cloned successfully`);

  // Create RAW backup
  createRawBackup(botId);
}

/**
 * Pull latest changes from repository
 * Uses the URL already configured in the repo's origin remote
 */
export async function pullRepository(botId: string): Promise<void> {
  const repoPath = getRepoPath(botId);

  if (!fs.existsSync(repoPath)) {
    throw new Error(`Repository not found for bot ${botId}`);
  }

  const git: SimpleGit = simpleGit(repoPath);

  // Check if .git exists
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    throw new Error(`Not a git repository: ${repoPath}`);
  }

  console.log(`[RepoManager] Pulling latest changes for bot ${botId}`);

  await git.pull('origin');

  console.log(`[RepoManager] Repository updated successfully`);

  // Update RAW backup
  createRawBackup(botId);
}

/**
 * Get repository info (current branch, last commit, etc.)
 */
export async function getRepoInfo(botId: string): Promise<{
  branch: string;
  lastCommit: string;
  lastCommitMessage: string;
  lastCommitDate: string;
} | null> {
  const repoPath = getRepoPath(botId);

  if (!fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, '.git'))) {
    return null;
  }

  const git: SimpleGit = simpleGit(repoPath);

  try {
    const branch = await git.revparse(['--abbrev-ref', 'HEAD']);
    const log = await git.log({ maxCount: 1 });
    const lastCommit = log.latest;

    return {
      branch: branch.trim(),
      lastCommit: lastCommit?.hash.substring(0, 7) || 'unknown',
      lastCommitMessage: lastCommit?.message || 'unknown',
      lastCommitDate: lastCommit?.date || 'unknown'
    };
  } catch (error) {
    console.error(`[RepoManager] Failed to get repo info for bot ${botId}:`, error);
    return null;
  }
}

/**
 * Check if there are updates available
 * Uses the URL already configured in the repo's origin remote
 */
export async function checkForUpdates(botId: string): Promise<{
  hasUpdates: boolean;
  behindBy: number;
}> {
  const repoPath = getRepoPath(botId);

  if (!fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, '.git'))) {
    return { hasUpdates: false, behindBy: 0 };
  }

  const git: SimpleGit = simpleGit(repoPath);

  try {
    // Fetch without merging
    await git.fetch();

    // Check if we're behind
    const status = await git.status();
    const behindBy = status.behind || 0;

    return {
      hasUpdates: behindBy > 0,
      behindBy
    };
  } catch (error) {
    console.error(`[RepoManager] Failed to check for updates for bot ${botId}:`, error);
    return { hasUpdates: false, behindBy: 0 };
  }
}

/**
 * List files in repository
 */
export function listRepoFiles(botId: string): string[] {
  const repoPath = getRepoPath(botId);

  if (!fs.existsSync(repoPath)) {
    return [];
  }

  const files: string[] = [];

  function walkDir(dir: string, prefix = ''): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        walkDir(path.join(dir, entry.name), relativePath);
      } else {
        files.push(relativePath);
      }
    }
  }

  walkDir(repoPath);
  return files.slice(0, 100); // Limit to first 100 files
}
