/**
 * Environment Variable Manager
 * Handles storage and retrieval of bot environment variables.
 *
 * A deployed bot's only hard requirement is its own token var (whatever the repo
 * names it), tracked per-instance as tokenVarName and passed in by callers.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { parseDocument } from 'yaml';
import { getEnvPath, getDataDir } from '../git/repoManager';
import { APP_CAPABILITIES } from '../config/appCapabilities';

/**
 * Resolve the AES key used to encrypt sensitive env/config values. It MUST be
 * stable across manager restarts, otherwise every previously-encrypted value
 * (bot tokens, stored config files) becomes undecryptable on the next boot and
 * the bot reads as "missing required token". Precedence: an explicit
 * ENV_ENCRYPTION_KEY, else a key persisted under the data volume (generated once
 * on first run). Only an in-memory fallback (lost on restart) if persistence
 * fails, with a loud warning.
 */
function loadOrCreateEncryptionKey(): string {
  if (process.env.ENV_ENCRYPTION_KEY) return process.env.ENV_ENCRYPTION_KEY;

  const keyPath = path.join(getDataDir(), 'env-encryption.key');
  try {
    if (fs.existsSync(keyPath)) {
      const existing = fs.readFileSync(keyPath, 'utf-8').trim();
      if (existing) return existing;
    }
  } catch (error) {
    console.error('[EnvManager] Failed to read persisted encryption key:', error);
  }

  const generated = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(getDataDir(), { recursive: true });
    fs.writeFileSync(keyPath, generated, { mode: 0o600 });
  } catch (error) {
    console.error('[EnvManager] Could not persist encryption key; stored tokens will NOT survive a restart:', error);
  }
  return generated;
}

const ENCRYPTION_KEY = loadOrCreateEncryptionKey();

/**
 * KDF salt persisted beside the key file. Not secret; it exists so a
 * user-supplied ENV_ENCRYPTION_KEY passphrase cannot be attacked with
 * precomputed tables, and it must be stable for the same reason the key must.
 */
function loadOrCreateKdfSalt(): string {
  const saltPath = path.join(getDataDir(), 'env-encryption.salt');
  try {
    if (fs.existsSync(saltPath)) {
      const existing = fs.readFileSync(saltPath, 'utf-8').trim();
      if (existing) return existing;
    }
  } catch (error) {
    console.error('[EnvManager] Failed to read persisted KDF salt:', error);
  }

  const generated = crypto.randomBytes(16).toString('hex');
  try {
    fs.mkdirSync(getDataDir(), { recursive: true });
    fs.writeFileSync(saltPath, generated, { mode: 0o600 });
  } catch (error) {
    console.error('[EnvManager] Could not persist KDF salt; stored secrets will NOT survive a restart:', error);
  }
  return generated;
}

// Derived once at boot: scrypt is deliberately slow, and getEnvVars decrypts on
// every container start/status pass.
const DERIVED_KEY = crypto.scryptSync(ENCRYPTION_KEY, loadOrCreateKdfSalt(), 32);

// Sensitive env vars that should be encrypted: the generic secret shapes, plus
// every companion-database key each app capability record declares (the DSNs
// and the repointed/app-owned keys carry the same credentials). Record-derived
// so a new app's keys are covered without editing this list.
const SENSITIVE_VARS = [
  'DISCORD_TOKEN', 'API_KEY', 'SECRET', 'PASSWORD', 'TOKEN',
  ...APP_CAPABILITIES.flatMap(r => r.companionDb
    ? [r.companionDb.env.url, r.companionDb.env.publicUrl, ...(r.companionDb.repointedEnv ?? []), ...(r.companionDb.appOwnedEnv ?? [])]
    : []),
].filter((k): k is string => !!k).map(k => k.toUpperCase());

interface EnvStorage {
  vars: Record<string, string>;
  encrypted: Record<string, string>;
}

/**
 * Check if a variable name is sensitive
 */
export function isSensitive(key: string): boolean {
  const upperKey = key.toUpperCase();
  return SENSITIVE_VARS.some(s => upperKey.includes(s));
}

/**
 * Encrypt a value: AES-256-GCM under the scrypt-derived key,
 * "v2:<iv>:<authTag>:<ciphertext>" hex fields.
 */
export function encrypt(text: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', DERIVED_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `v2:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt a value, or null when the ciphertext cannot be decrypted (key/salt
 * changed, or the retired pre-v2 format). Null is distinct from a legitimately
 * empty value, which decrypts to ''.
 */
export function decryptOrNull(encrypted: string): string | null {
  if (!encrypted.startsWith('v2:')) {
    console.error('[EnvManager] Value is stored in the retired pre-v2 format and cannot be decrypted; re-enter it in the env editor');
    return null;
  }
  try {
    const [, ivHex, tagHex, dataHex] = encrypted.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', DERIVED_KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  } catch (error) {
    console.error('[EnvManager] Decryption failed:', error);
    return null;
  }
}

/**
 * Decrypt a value. Returns '' on failure (never throws) so the env editor can
 * still render and let the user re-enter the value.
 */
export function decrypt(encrypted: string): string {
  return decryptOrNull(encrypted) ?? '';
}

/**
 * Load env storage for a bot. A missing file is a legitimately empty store; a
 * file that EXISTS but cannot be read or parsed is reported corrupt (and
 * preserved as .corrupt before any later save can overwrite the only copy of
 * the secrets) so container env assembly can refuse instead of silently
 * starting secretless.
 */
function loadEnvStorage(botId: string): { storage: EnvStorage; corrupt: boolean } {
  const envPath = getEnvPath(botId);
  const storagePath = path.join(envPath, 'storage.json');

  try {
    if (fs.existsSync(storagePath)) {
      const content = fs.readFileSync(storagePath, 'utf-8');
      const parsed = JSON.parse(content);
      // Shape check: valid JSON that is not an EnvStorage (null, an array,
      // garbage vars/encrypted, or a non-string ciphertext) is corruption
      // too, not a crash further down. A scalar plain value coerces instead
      // of condemning the whole store: setEnvVars refuses structured values
      // at write time, so only scalars can legitimately appear here.
      const isMapOf = (v: unknown, ok: (x: unknown) => boolean): boolean =>
        v === undefined || (!!v && typeof v === 'object' && !Array.isArray(v)
          && Object.values(v as Record<string, unknown>).every(ok));
      // null tolerated like the writer tolerates it (coerced to ''), so a
      // legacy null value cannot condemn the whole store.
      const scalar = (x: unknown): boolean => x === null || typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean';
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || !isMapOf(parsed.vars, scalar) || !isMapOf(parsed.encrypted, x => typeof x === 'string')) {
        throw new Error('storage.json is not an env store');
      }
      const vars: Record<string, string> = {};
      for (const [k, v] of Object.entries((parsed.vars ?? {}) as Record<string, unknown>)) vars[k] = v === null ? '' : String(v);
      // The store reads healthy again: clear a preserved copy left by an
      // earlier incident, so a LATER corruption preserves its own bytes
      // instead of being shadowed by stale secrets the refusal messages
      // would then misdirect the operator to restore.
      try { fs.rmSync(`${storagePath}.corrupt`, { force: true }); } catch { /* best effort */ }
      return { storage: { vars, encrypted: parsed.encrypted ?? {} }, corrupt: false };
    }
  } catch (error) {
    console.error(`[EnvManager] Failed to load env storage for bot ${botId}:`, error);
    // Preserve once: loads run continuously, and re-copying on every failed
    // load could clobber the preserved copy with a half-restored snapshot
    // while the operator performs the documented live restore.
    try {
      if (!fs.existsSync(`${storagePath}.corrupt`)) fs.copyFileSync(storagePath, `${storagePath}.corrupt`);
    } catch { /* best effort */ }
    return { storage: { vars: {}, encrypted: {} }, corrupt: true };
  }

  return { storage: { vars: {}, encrypted: {} }, corrupt: false };
}

/**
 * A write against a corrupt store would atomically replace it with a valid
 * store holding only the keys just written - disarming the corrupt-store
 * refusal and losing every other secret as a side effect of any save (an
 * editor save, a key delete, a fleet lane's repoint). Refuse instead; the
 * remedy is deliberate: restore storage.json from storage.json.corrupt, or
 * delete storage.json to start over empty on purpose.
 */
function refuseCorrupt(botId: string, corrupt: boolean): void {
  if (!corrupt) return;
  throw new Error(`The env store for bot ${botId} exists but cannot be read; refusing to overwrite it. Repair or replace storage.json (the damaged original is preserved as storage.json.corrupt), or delete storage.json to deliberately start with an empty store and re-enter the values.`);
}

/**
 * Save env storage for a bot. Atomic: post the two-store strip this file is
 * the only source of secrets, so a kill mid-save must not leave it truncated
 * (the same hazard the registry save guards against).
 */
function saveEnvStorage(botId: string, storage: EnvStorage): void {
  const envPath = getEnvPath(botId);
  fs.mkdirSync(envPath, { recursive: true });

  const storagePath = path.join(envPath, 'storage.json');
  const tmp = `${storagePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(storage, null, 2));
  fs.renameSync(tmp, storagePath);
}

/**
 * Get all environment variables for a bot, with the keys whose stored
 * ciphertext no longer decrypts reported separately instead of silently
 * reading as ''. Container env assembly refuses on those: starting a bot
 * without its secrets is worse than refusing to start it.
 */
export function getEnvVarsWithStatus(botId: string): { vars: Record<string, string>; undecryptable: string[]; corrupt: boolean } {
  const { storage, corrupt } = loadEnvStorage(botId);
  const vars: Record<string, string> = { ...storage.vars };
  const undecryptable: string[] = [];

  for (const [key, encrypted] of Object.entries(storage.encrypted)) {
    const value = decryptOrNull(encrypted);
    if (value === null) undecryptable.push(key);
    else vars[key] = value;
  }

  return { vars, undecryptable, corrupt };
}

/**
 * Get all environment variables for a bot (decrypted; an undecryptable value
 * reads as '' so the env editor can render and offer re-entry)
 */
export function getEnvVars(botId: string): Record<string, string> {
  const { vars, undecryptable } = getEnvVarsWithStatus(botId);
  for (const key of undecryptable) vars[key] = '';
  return vars;
}

/**
 * Set environment variables for a bot
 */
export function setEnvVars(botId: string, vars: Record<string, string>): void {
  const { storage, corrupt } = loadEnvStorage(botId);
  refuseCorrupt(botId, corrupt);

  for (const [key, raw] of Object.entries(vars)) {
    // The API is a first-class surface and JSON bodies carry types: a scalar
    // coerces, a structured value refuses loudly - the writer must never
    // author a store the loader would classify corrupt.
    const given = raw as unknown;
    if (given !== null && given !== undefined && typeof given === 'object') {
      throw new Error(`The env value for ${key} is not a scalar; refusing to store it`);
    }
    const value = given === null || given === undefined ? '' : String(given);
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
 * A one-line diagnosis when a stored secret read came back unusable, so
 * refusal messages name the real problem instead of the value the operator
 * would otherwise chase. Null when the store is healthy.
 */
export function storeBrokenDiagnosis(botId: string): string | null {
  const { corrupt, undecryptable } = getEnvVarsWithStatus(botId);
  if (corrupt) return 'the env store cannot be read (preserved as storage.json.corrupt); restore it first';
  if (undecryptable.length > 0) return `the env store holds values that no longer decrypt (${undecryptable.join(', ')}); re-enter them or restore the encryption key first`;
  return null;
}

/**
 * Delete an environment variable
 */
export function deleteEnvVar(botId: string, key: string): void {
  const { storage, corrupt } = loadEnvStorage(botId);
  refuseCorrupt(botId, corrupt);
  delete storage.vars[key];
  delete storage.encrypted[key];
  saveEnvStorage(botId, storage);
}

/**
 * Check whether the bot's required env (its token var) is set. The token var name
 * is detected per-bot (tokenVarName); when unknown (e.g. a prebuilt-image bot) we
 * require nothing, since we cannot know what the image expects.
 */
export function hasRequiredEnvVars(botId: string, tokenVarName?: string): {
  valid: boolean;
  missing: string[];
} {
  const vars = getEnvVars(botId);
  const missing: string[] = [];

  if (tokenVarName && (!vars[tokenVarName] || vars[tokenVarName].trim() === '')) {
    missing.push(tokenVarName);
  }

  return {
    valid: missing.length === 0,
    missing
  };
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
 * Split the right-hand side of a KEY=... line into its value and any trailing
 * inline comment, dotenv-style: surrounding matching quotes are stripped, and a
 * `#` only starts a comment when it is outside quotes and preceded by whitespace
 * (so `http://x#frag` and `#ff0000` stay in the value, and inline JSON like
 * `[{"a":1}]` is kept whole).
 */
function splitEnvValueAndComment(rest: string): { value: string; comment: string } {
  // Empty value followed by an inline comment: `KEY=   # comment`. Requires
  // whitespace before the `#`, so `KEY=#literal` stays a value (dotenv-style).
  const emptyComment = rest.match(/^\s+#(.*)$/);
  if (emptyComment) return { value: '', comment: emptyComment[1].trim() };

  const s = rest.replace(/^\s+/, '');
  if (s === '') return { value: '', comment: '' };

  const quote = s[0];
  if (quote === '"' || quote === "'") {
    let i = 1;
    let value = '';
    while (i < s.length) {
      const c = s[i];
      if (c === '\\' && quote === '"' && i + 1 < s.length) { value += s[i + 1]; i += 2; continue; }
      if (c === quote) { i++; break; }
      value += c;
      i++;
    }
    const after = s.slice(i);
    const hashAt = after.indexOf('#');
    return { value, comment: hashAt >= 0 ? after.slice(hashAt + 1).trim() : '' };
  }

  const m = s.match(/\s#/);
  if (m && m.index !== undefined) {
    return { value: s.slice(0, m.index).replace(/\s+$/, ''), comment: s.slice(m.index + m[0].length).trim() };
  }
  return { value: s.replace(/\s+$/, ''), comment: '' };
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
        const { value, comment } = splitEnvValueAndComment(match[2]);
        result.push({
          key: match[1],
          description: comment || currentDescription,
          defaultValue: value
        });
        currentDescription = '';
      }
    }
  } catch (error) {
    console.error('[EnvManager] Failed to parse .env.example:', error);
  }

  return result;
}

// ─── Config-file parsing (config.json / config.yml templates) ───

export type ConfigFileFormat = 'json' | 'yaml' | 'raw';

/**
 * Pick a parse strategy from a config file's name. Only json/yaml are parsed for
 * keys; everything else (toml, .js, .py, HOCON, .txt) is treated as raw text.
 */
export function configFileFormat(fileName: string): ConfigFileFormat {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.json') || lower.endsWith('.jsonc') || lower.endsWith('.json5')) return 'json';
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'yaml';
  return 'raw';
}

/**
 * Extract top-level scalar keys from a config-file body. Nested objects/arrays
 * are skipped (they cannot be expressed as a single env var). Used to surface a
 * config-file bot's settings as env vars (env-first), e.g. a TOKEN/LOCALE pair.
 */
export function extractConfigKeys(
  body: string,
  format: ConfigFileFormat
): Array<{ key: string; defaultValue: string; sensitive: boolean }> {
  if (format === 'raw') return [];

  let obj: unknown;
  try {
    obj = format === 'json' ? JSON.parse(body) : parseDocument(body).toJSON();
  } catch {
    return [];
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];

  const out: Array<{ key: string; defaultValue: string; sensitive: boolean }> = [];
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (value === null) {
      out.push({ key, defaultValue: '', sensitive: isSensitive(key) });
      continue;
    }
    const t = typeof value;
    if (t === 'string' || t === 'number' || t === 'boolean') {
      out.push({ key, defaultValue: String(value), sensitive: isSensitive(key) });
    }
  }
  return out;
}

// ─── Universal env var detection (install wizard) ───

export type DetectedEnvSource = 'env-example' | 'compose' | 'config' | 'source' | 'image';

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

// Platform / runtime / bot-manager-internal vars that are auto-provided (or
// resolved via $-substitution) and must never be shown as user input. Only
// truly auto-managed vars belong here; app/proxy config with real literal
// values (e.g. BACKEND_HOST) is intentionally NOT hidden.
const PLATFORM_ENV_DENYLIST = new Set([
  'TZ', 'PUID', 'PGID', 'PORT', 'NODE_ENV', 'HOSTNAME', 'LANG', 'TERM', 'HOME', 'PATH', 'PWD', 'SHELL', 'USER',
  'APP_ID', 'APP_DOMAIN', 'APP_PUBLIC_IP_DASH', 'APP_DEFAULT_PASSWORD',
  'DATA_ROOT', 'BOT_ID', 'UPDATE_TOKEN', 'DOCKER_IMAGE_NAME', 'BUILD_MODE', 'BUILD_DATE',
]);

function isPlatformEnv(key: string): boolean {
  return PLATFORM_ENV_DENYLIST.has(key.toUpperCase()) || /^(BOT_MANAGER_|REF_|CADDY_)/i.test(key);
}

// Language/runtime env keys baked into base images that are never bot config.
const IMAGE_NOISE_RE = /^(PYTHON_|PYTHONUNBUFFERED$|PYTHONDONTWRITEBYTECODE$|PIP_|NODE_VERSION$|NPM_|YARN_|GPG_KEY$|LC_|LANGUAGE$|DEBIAN_FRONTEND$|VIRTUAL_ENV$)/i;

/**
 * Map a prebuilt image's declared Config.Env ("KEY=value" lines) to detected env
 * vars, dropping platform-managed and base-image runtime noise. Declared vars carry
 * baked-in defaults, so they surface as optional (the user can override).
 */
export function envVarsFromImageConfig(envLines: string[]): DetectedEnvVar[] {
  const out: DetectedEnvVar[] = [];
  for (const line of envLines) {
    const eq = line.indexOf('=');
    const key = (eq >= 0 ? line.slice(0, eq) : line).trim();
    if (!key || isPlatformEnv(key) || IMAGE_NOISE_RE.test(key)) continue;
    out.push({
      key,
      displayLabel: normalizeEnvLabel(key),
      description: '',
      defaultValue: eq >= 0 ? line.slice(eq + 1) : '',
      required: false,
      source: 'image',
      sensitive: isSensitive(key),
      autoWired: false,
    });
  }
  return out;
}

const REQUIRED_TOKEN_RE = /^(DISCORD_)?(BOT_|CLIENT_)?TOKEN$/i;

// A var is required only when it positively signals so: it is the bot token, or
// its comment explicitly says required/mandatory (and not "optional"). We never
// infer required from a blank value, so optional features are never mislabeled.
// (`# MANDATORY`/`# required` compose markers are honored separately via
// findMandatoryComposeKeys.)
const OPTIONAL_COMMENT_RE = /\b(optional|not required)\b/i;
const REQUIRED_COMMENT_RE = /\b(required|mandatory|must be set)\b/i;

function isEnvRequired(key: string, comment: string): boolean {
  if (REQUIRED_TOKEN_RE.test(key)) return true;
  const c = comment || '';
  if (OPTIONAL_COMMENT_RE.test(c)) return false;
  return REQUIRED_COMMENT_RE.test(c);
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

function findComposeFile(repoPath: string): string | null {
  for (const f of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    const p = path.join(repoPath, f);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function isSubstitutionValue(value: string): boolean {
  return value.includes('$');
}

/**
 * Read compose `environment:` keys, skipping $-substituted entries (those are
 * auto-filled by the platform / variable substitution and are never user input).
 */
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
          if (key && !seen.has(key) && !isSubstitutionValue(val)) { seen.add(key); result.push({ key, defaultValue: val }); }
        }
      } else if (env && typeof env === 'object') {
        for (const [key, raw] of Object.entries(env)) {
          const val = raw == null ? '' : String(raw);
          if (!seen.has(key) && !isSubstitutionValue(val)) { seen.add(key); result.push({ key, defaultValue: val }); }
        }
      }
    }
  } catch {
    // ignore malformed compose
  }
  return result;
}

/**
 * Find compose env keys explicitly marked mandatory via a trailing
 * `# MANDATORY` / `# required` comment.
 */
function findMandatoryComposeKeys(repoPath: string): Set<string> {
  const keys = new Set<string>();
  const composePath = findComposeFile(repoPath);
  if (!composePath) return keys;
  try {
    const content = fs.readFileSync(composePath, 'utf-8');
    for (const line of content.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:[^#]*#\s*(?:mandatory|required)\b/i);
      if (m) keys.add(m[1]);
    }
  } catch {
    // ignore
  }
  return keys;
}

/**
 * Detect environment variables a repo expects, for the install wizard.
 *
 * Returns every author-curated var (.env.example entries + compose `environment:`
 * keys), excluding platform / $-substituted / bot-manager-internal vars. Each is
 * flagged required per isEnvRequired (the bot token, or a comment that explicitly
 * says required/mandatory); everything else is optional, so opt-in features are
 * not mislabeled required. The `required` flag governs the wizard label only, not
 * visibility, all returned vars are shown.
 *
 * scanSource=true additionally appends vars discovered by a source-code
 * `process.env` scan (always optional).
 */
export function detectEnvVars(
  repoPath: string,
  options?: { scanSource?: boolean }
): DetectedEnvVar[] {
  const byKey = new Map<string, DetectedEnvVar>();

  const add = (key: string, defaultValue: string, source: DetectedEnvSource, required: boolean, description = '') => {
    if (!key || isPlatformEnv(key) || byKey.has(key)) return;   // first source wins
    byKey.set(key, {
      key,
      displayLabel: normalizeEnvLabel(key),
      description,
      defaultValue,
      required,
      source,
      sensitive: isSensitive(key),
      autoWired: false,
    });
  };

  // .env.example: required only when it is the token or the comment says so
  for (const e of parseEnvExample(repoPath)) {
    add(e.key, e.defaultValue, 'env-example', isEnvRequired(e.key, e.description), e.description);
  }

  // compose: required when marked `# MANDATORY`/`# required`, or it is the token.
  // A concrete compose `environment:` literal is the author's working in-network
  // value (e.g. CONNECTION_URI=mongodb://mongo), so when the same key already came
  // from .env.example it overrides that default, since .env.example commonly ships
  // a non-working placeholder (e.g. mongodb+srv://mongodburi) the user would
  // otherwise unknowingly keep. parseComposeEnv already drops $-substituted values.
  const mandatory = findMandatoryComposeKeys(repoPath);
  for (const e of parseComposeEnv(repoPath)) {
    const existing = byKey.get(e.key);
    if (existing) {
      if (existing.source === 'env-example' && e.defaultValue) existing.defaultValue = e.defaultValue;
      continue;
    }
    add(e.key, e.defaultValue, 'compose', mandatory.has(e.key) || isEnvRequired(e.key, ''));
  }

  // Tier 2 source scan: explicit opt-in only, always optional
  if (options?.scanSource) {
    for (const key of scanSourceForEnvVars(repoPath)) add(key, '', 'source', false);
  }

  // Author-curated vars (.env.example + compose) always show, required-flagged or
  // not, each with its tip. The opt-in source scan only adds extra discovered vars.
  return [...byKey.values()];
}
