/**
 * Environment Variable Manager
 * Handles storage and retrieval of bot environment variables
 *
 * Required Discord env vars:
 * - DISCORD_TOKEN: Bot token from Discord Developer Portal
 * - CLIENT_ID: Application ID for slash command registration
 * - GUILD_ID: Server ID for command registration
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { parseDocument } from 'yaml';
import { getEnvPath } from '../git/repoManager';

// Encryption key from environment or generate one
const ENCRYPTION_KEY = process.env.ENV_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

// Required env vars for all Discord bots
export const REQUIRED_DISCORD_ENVS = ['DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID'] as const;
export type RequiredDiscordEnv = typeof REQUIRED_DISCORD_ENVS[number];

// Sensitive env vars that should be encrypted
const SENSITIVE_VARS = ['DISCORD_TOKEN', 'API_KEY', 'SECRET', 'PASSWORD', 'TOKEN'];

interface EnvStorage {
  vars: Record<string, string>;
  encrypted: Record<string, string>;
}

/**
 * Check if a variable name is sensitive
 */
function isSensitive(key: string): boolean {
  const upperKey = key.toUpperCase();
  return SENSITIVE_VARS.some(s => upperKey.includes(s));
}

/**
 * Encrypt a value
 */
function encrypt(text: string): string {
  const key = Buffer.from(ENCRYPTION_KEY.slice(0, 32).padEnd(32, '0'));
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt a value
 */
function decrypt(encrypted: string): string {
  try {
    const key = Buffer.from(ENCRYPTION_KEY.slice(0, 32).padEnd(32, '0'));
    const [ivHex, encryptedText] = encrypted.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    console.error('[EnvManager] Decryption failed:', error);
    return '';
  }
}

/**
 * Load env storage for a bot
 */
function loadEnvStorage(botId: string): EnvStorage {
  const envPath = getEnvPath(botId);
  const storagePath = path.join(envPath, 'storage.json');

  try {
    if (fs.existsSync(storagePath)) {
      const content = fs.readFileSync(storagePath, 'utf-8');
      return JSON.parse(content);
    }
  } catch (error) {
    console.error(`[EnvManager] Failed to load env storage for bot ${botId}:`, error);
  }

  return { vars: {}, encrypted: {} };
}

/**
 * Save env storage for a bot
 */
function saveEnvStorage(botId: string, storage: EnvStorage): void {
  const envPath = getEnvPath(botId);
  fs.mkdirSync(envPath, { recursive: true });

  const storagePath = path.join(envPath, 'storage.json');
  fs.writeFileSync(storagePath, JSON.stringify(storage, null, 2));
}

/**
 * Get all environment variables for a bot (decrypted)
 */
export function getEnvVars(botId: string): Record<string, string> {
  const storage = loadEnvStorage(botId);
  const result: Record<string, string> = { ...storage.vars };

  // Decrypt sensitive vars
  for (const [key, encrypted] of Object.entries(storage.encrypted)) {
    result[key] = decrypt(encrypted);
  }

  return result;
}

/**
 * Set environment variables for a bot
 */
export function setEnvVars(botId: string, vars: Record<string, string>): void {
  const storage = loadEnvStorage(botId);

  for (const [key, value] of Object.entries(vars)) {
    if (isSensitive(key)) {
      storage.encrypted[key] = encrypt(value);
      delete storage.vars[key];
    } else {
      storage.vars[key] = value;
      delete storage.encrypted[key];
    }
  }

  saveEnvStorage(botId, storage);
  console.log(`[EnvManager] Saved ${Object.keys(vars).length} env vars for bot ${botId}`);
}

/**
 * Delete an environment variable
 */
export function deleteEnvVar(botId: string, key: string): void {
  const storage = loadEnvStorage(botId);
  delete storage.vars[key];
  delete storage.encrypted[key];
  saveEnvStorage(botId, storage);
}

/**
 * Check if all required Discord env vars are set
 */
export function hasRequiredEnvVars(botId: string): {
  valid: boolean;
  missing: RequiredDiscordEnv[];
} {
  const vars = getEnvVars(botId);
  const missing: RequiredDiscordEnv[] = [];

  for (const required of REQUIRED_DISCORD_ENVS) {
    if (!vars[required] || vars[required].trim() === '') {
      missing.push(required);
    }
  }

  return {
    valid: missing.length === 0,
    missing
  };
}

/**
 * Get env var info (masked values for sensitive vars)
 */
export function getEnvVarsInfo(botId: string): Array<{
  key: string;
  value: string;
  sensitive: boolean;
  required: boolean;
}> {
  const vars = getEnvVars(botId);
  const result = [];

  for (const [key, value] of Object.entries(vars)) {
    const sensitive = isSensitive(key);
    result.push({
      key,
      value: sensitive ? maskValue(value) : value,
      sensitive,
      required: REQUIRED_DISCORD_ENVS.includes(key as RequiredDiscordEnv)
    });
  }

  // Add missing required vars. Use result.some() rather than !vars[required]
  // so an empty-but-present value (e.g., after a failed decrypt) does not
  // cause a second entry for the same key.
  for (const required of REQUIRED_DISCORD_ENVS) {
    if (result.some(e => e.key === required)) continue;
    result.push({
      key: required,
      value: '',
      sensitive: isSensitive(required),
      required: true
    });
  }

  return result;
}

/**
 * Mask a sensitive value for display
 */
function maskValue(value: string): string {
  if (!value || value.length < 8) return '****';
  return value.substring(0, 4) + '****' + value.substring(value.length - 4);
}

/**
 * Write .env file for a bot (used when starting container)
 */
export function writeEnvFile(botId: string): string {
  const vars = getEnvVars(botId);
  const envPath = getEnvPath(botId);
  const envFilePath = path.join(envPath, '.env');

  const lines = Object.entries(vars).map(([key, value]) => `${key}=${value}`);
  fs.writeFileSync(envFilePath, lines.join('\n'));

  return envFilePath;
}

/**
 * Parse .env.example from a repository
 */
export function parseEnvExample(repoPath: string): Array<{
  key: string;
  description: string;
  defaultValue: string;
}> {
  const examplePath = path.join(repoPath, '.env.example');
  const result: Array<{ key: string; description: string; defaultValue: string }> = [];

  if (!fs.existsSync(examplePath)) {
    return result;
  }

  try {
    const content = fs.readFileSync(examplePath, 'utf-8');
    const lines = content.split('\n');

    let currentDescription = '';
    for (const line of lines) {
      const trimmed = line.trim();

      // Comment line - potential description
      if (trimmed.startsWith('#')) {
        currentDescription = trimmed.substring(1).trim();
        continue;
      }

      // Key=value line
      const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/i);
      if (match) {
        result.push({
          key: match[1],
          description: currentDescription,
          defaultValue: match[2]
        });
        currentDescription = '';
      }
    }
  } catch (error) {
    console.error('[EnvManager] Failed to parse .env.example:', error);
  }

  return result;
}

// ─── Universal env var detection (install wizard) ───

export type DetectedEnvSource = 'env-example' | 'compose' | 'config' | 'source' | 'readme';

export interface DetectedEnvVar {
  key: string;
  displayLabel: string;
  description: string;
  defaultValue: string;
  required: boolean;
  source: DetectedEnvSource;
  sensitive: boolean;
  autoWired: boolean;
}

const ENV_LABELS: Array<{ match: RegExp; label: string }> = [
  { match: /^(DISCORD_)?(BOT_|CLIENT_)?TOKEN$/i, label: 'Discord Bot Token' },
  { match: /^(DISCORD_)?CLIENT_ID$/i, label: 'Discord Client ID' },
  { match: /^(DISCORD_)?GUILD_ID$/i, label: 'Discord Server (Guild) ID' },
  { match: /^(MONGO_?URI|MONGODB_?URI|DATABASE_URL)$/i, label: 'Database URL' },
  { match: /^LAVALINK_HOST$/i, label: 'Lavalink Host' },
  { match: /^LAVALINK_PORT$/i, label: 'Lavalink Port' },
  { match: /^LAVALINK_PASSWORD$/i, label: 'Lavalink Password' },
];

export function normalizeEnvLabel(key: string): string {
  for (const { match, label } of ENV_LABELS) {
    if (match.test(key)) return label;
  }
  return key;
}

const SOURCE_SCAN_EXTS = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.py', '.java', '.kt', '.go', '.rs', '.cs']);
const SOURCE_SCAN_SKIP = new Set(['node_modules', 'dist', 'build', 'target', 'venv', '.venv', '__pycache__', 'bin', 'obj', 'vendor']);
const SOURCE_SCAN_FILE_CAP = 400;

// Common process-level vars that are not bot configuration; excluded from scan results.
const ENV_SCAN_DENYLIST = new Set(['NODE_ENV', 'PATH', 'PWD', 'HOME', 'PORT', 'HOSTNAME', 'TERM', 'LANG', 'TZ', 'PUID', 'PGID']);

function walkSourceFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0 && out.length < SOURCE_SCAN_FILE_CAP) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= SOURCE_SCAN_FILE_CAP) break;
      if (entry.isDirectory()) {
        if (!SOURCE_SCAN_SKIP.has(entry.name) && !entry.name.startsWith('.')) {
          stack.push(path.join(dir, entry.name));
        }
      } else if (SOURCE_SCAN_EXTS.has(path.extname(entry.name))) {
        out.push(path.join(dir, entry.name));
      }
    }
  }
  return out;
}

const ENV_REF_PATTERNS: RegExp[] = [
  /process\.env\.([A-Z_][A-Z0-9_]*)/g,
  /process\.env\[['"]([A-Z_][A-Z0-9_]*)['"]\]/g,
  /os\.getenv\(['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /os\.environ(?:\.get)?\(?\[?['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /System\.getenv\(['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /os\.Getenv\(['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /env::var\(['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /Environment\.GetEnvironmentVariable\(['"]([A-Z_][A-Z0-9_]*)['"]/g,
];

/**
 * Scan source files for env var references. Used by the wizard's Tier 2 detection
 * and by token-variable detection.
 */
export function scanSourceForEnvVars(repoPath: string): string[] {
  const found = new Set<string>();
  for (const file of walkSourceFiles(repoPath)) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    for (const pattern of ENV_REF_PATTERNS) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(content)) !== null) {
        if (!ENV_SCAN_DENYLIST.has(m[1])) found.add(m[1]);
      }
    }
  }
  return [...found];
}

function stripEnvRef(value: string): string {
  const withDefault = value.match(/^\$\{[^:}]+:-(.*)\}$/);
  if (withDefault) return withDefault[1];
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(value)) return '';
  return value;
}

function findComposeFile(repoPath: string): string | null {
  for (const f of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    const p = path.join(repoPath, f);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function parseComposeEnv(repoPath: string): Array<{ key: string; defaultValue: string }> {
  const result: Array<{ key: string; defaultValue: string }> = [];
  const composePath = findComposeFile(repoPath);
  if (!composePath) return result;

  try {
    const compose = parseDocument(fs.readFileSync(composePath, 'utf-8')).toJSON() as Record<string, any>;
    const services = compose?.services as Record<string, any> | undefined;
    if (!services) return result;

    const seen = new Set<string>();
    for (const service of Object.values(services)) {
      const env = service?.environment;
      if (Array.isArray(env)) {
        for (const entry of env) {
          if (typeof entry !== 'string') continue;
          const eq = entry.indexOf('=');
          const key = eq >= 0 ? entry.slice(0, eq) : entry;
          const val = eq >= 0 ? entry.slice(eq + 1) : '';
          if (key && !seen.has(key)) { seen.add(key); result.push({ key, defaultValue: stripEnvRef(val) }); }
        }
      } else if (env && typeof env === 'object') {
        for (const [key, val] of Object.entries(env)) {
          if (!seen.has(key)) { seen.add(key); result.push({ key, defaultValue: stripEnvRef(val == null ? '' : String(val)) }); }
        }
      }
    }
  } catch {
    // ignore malformed compose
  }
  return result;
}

function parseConfigExample(repoPath: string): Array<{ key: string; defaultValue: string }> {
  const result: Array<{ key: string; defaultValue: string }> = [];
  for (const f of ['config.example.json', 'config.json.example', 'config.sample.json']) {
    const p = path.join(repoPath, f);
    if (!fs.existsSync(p)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (parsed && typeof parsed === 'object') {
        for (const [key, val] of Object.entries(parsed)) {
          if (val === null || typeof val !== 'object') {
            result.push({ key, defaultValue: val == null ? '' : String(val) });
          }
        }
      }
    } catch {
      // ignore malformed config
    }
    break;
  }
  return result;
}

function scanReadmeForEnvVars(repoPath: string): string[] {
  for (const name of ['README.md', 'readme.md', 'README.MD', 'Readme.md']) {
    const p = path.join(repoPath, name);
    if (!fs.existsSync(p)) continue;
    try {
      const content = fs.readFileSync(p, 'utf-8');
      const found = new Set<string>();
      const re = /\b([A-Z][A-Z0-9]*_[A-Z0-9_]+)\b/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        if (!ENV_SCAN_DENYLIST.has(m[1])) found.add(m[1]);
      }
      return [...found];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Detect all environment variables a repo expects, for the install wizard.
 * Tier 1 (.env.example, compose, config) always runs. Tier 2 (source + README scan)
 * runs when there is no .env.example or when scanSource is forced.
 */
export function detectEnvVars(
  repoPath: string,
  options?: { scanSource?: boolean }
): DetectedEnvVar[] {
  const byKey = new Map<string, DetectedEnvVar>();

  const add = (key: string, defaultValue: string, source: DetectedEnvSource, description = '') => {
    if (!key || byKey.has(key)) return;   // first source wins (precedence by call order)
    byKey.set(key, {
      key,
      displayLabel: normalizeEnvLabel(key),
      description,
      defaultValue,
      required: defaultValue.trim() === '',
      source,
      sensitive: isSensitive(key),
      autoWired: false,
    });
  };

  // Tier 1
  const fromExample = parseEnvExample(repoPath);
  for (const e of fromExample) add(e.key, e.defaultValue, 'env-example', e.description);
  for (const e of parseComposeEnv(repoPath)) add(e.key, e.defaultValue, 'compose');
  for (const e of parseConfigExample(repoPath)) add(e.key, e.defaultValue, 'config');

  // Tier 2
  if (options?.scanSource || fromExample.length === 0) {
    for (const key of scanSourceForEnvVars(repoPath)) add(key, '', 'source');
    for (const key of scanReadmeForEnvVars(repoPath)) add(key, '', 'readme');
  }

  return [...byKey.values()];
}
