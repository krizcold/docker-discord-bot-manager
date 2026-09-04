/**
 * Config File Manager
 * Stores per-bot config files (e.g. config.json, config.yml) the user supplies
 * in the install wizard for bots that are configured by a file rather than env.
 * Bodies are encrypted at rest (they may contain tokens) and delivered at deploy
 * time as bind-mounted files under /DATA/AppData/<app>/config.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getEnvPath } from '../git/repoManager';
import { encrypt, decryptOrNull } from '../env/manager';

export interface BotConfigFile {
  path: string;       // in-container mount path, e.g. /app/config.json
  body: string;       // verbatim file contents
  readOnly?: boolean; // default true; false lets the bot write back to the file
  enabled?: boolean;  // default true; false = keep the user's choice but do not deliver/override (bot uses its baked-in copy)
}

interface ConfigFileStorage {
  files: Array<{ path: string; body: string; readOnly?: boolean; enabled?: boolean }>;   // body encrypted
}

function storageFile(botId: string): string {
  return path.join(getEnvPath(botId), 'configFiles.json');
}

/**
 * Load the store. A missing file is legitimately empty; a file that EXISTS but
 * cannot be read, parsed, or does not have the store's shape is reported
 * corrupt (and preserved as .corrupt before any later save can overwrite the
 * only copy of the ciphertext) so delivery can refuse instead of silently
 * writing nothing over the bot's real configs.
 */
function load(botId: string): { storage: ConfigFileStorage; corrupt: boolean } {
  const p = storageFile(botId);
  try {
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || !Array.isArray(parsed.files)
        || !parsed.files.every((f: unknown) => !!f && typeof f === 'object'
          && typeof (f as { path?: unknown }).path === 'string'
          && typeof (f as { body?: unknown }).body === 'string')) {
        throw new Error('configFiles.json is not a config-file store');
      }
      // Healthy again: clear a preserved copy left by an earlier incident so a
      // LATER corruption preserves its own bytes instead of being shadowed.
      try { fs.rmSync(`${p}.corrupt`, { force: true }); } catch { /* best effort */ }
      return { storage: { files: parsed.files }, corrupt: false };
    }
  } catch (error) {
    console.error(`[ConfigFiles] Failed to load for bot ${botId}:`, error);
    // Preserve once: re-copying on every failed load could clobber the
    // preserved copy while the operator performs the documented restore.
    try {
      if (!fs.existsSync(`${p}.corrupt`)) fs.copyFileSync(p, `${p}.corrupt`);
    } catch { /* best effort */ }
    return { storage: { files: [] }, corrupt: true };
  }
  return { storage: { files: [] }, corrupt: false };
}

/**
 * Get a bot's config files with per-file health: bodies whose stored ciphertext
 * no longer decrypts are reported by mount path instead of silently reading as
 * ''. Delivery refuses on those; the editor renders '' and offers re-entry.
 */
export function getConfigFilesWithStatus(botId: string): { files: BotConfigFile[]; undecryptable: string[]; corrupt: boolean } {
  const { storage, corrupt } = load(botId);
  const undecryptable: string[] = [];
  const files = storage.files.map(f => {
    const body = decryptOrNull(f.body);
    if (body === null) undecryptable.push(f.path);
    return { path: f.path, body: body ?? '', readOnly: f.readOnly !== false, enabled: f.enabled !== false };
  });
  return { files, undecryptable, corrupt };
}

/**
 * Get a bot's config files with decrypted bodies (tolerant: an undecryptable
 * body reads as '' so the editor can render and offer re-entry).
 */
export function getConfigFiles(botId: string): BotConfigFile[] {
  return getConfigFilesWithStatus(botId).files;
}

/**
 * Get a bot's config files for DELIVERY (writing real files to disk / binding
 * them over the bot's configs). Throws on a corrupt store or an undecryptable
 * ENABLED body: delivering an empty file over the bot's real config is worse
 * than refusing the operation.
 */
export function getConfigFilesStrict(botId: string): BotConfigFile[] {
  const { files, undecryptable, corrupt } = getConfigFilesWithStatus(botId);
  if (corrupt) {
    throw new Error(`The config-file store for bot ${botId} cannot be read (the damaged original is preserved as configFiles.json.corrupt), so its files cannot be delivered. Repair or replace configFiles.json, or delete it to deliberately start with an empty store and re-enter the files.`);
  }
  const blocking = files.filter(f => f.enabled !== false && undecryptable.includes(f.path)).map(f => f.path);
  if (blocking.length > 0) {
    throw new Error(`Stored config file bodies no longer decrypt (${blocking.join(', ')}), so they cannot be delivered. Re-enter them in the config editor, or restore the original encryption key.`);
  }
  return files;
}

/**
 * Replace a bot's config files. Empty paths or non-string bodies are dropped.
 * Refuses on a corrupt store: a save would atomically replace it with a valid
 * store, disarming the corrupt refusal and destroying the preserved ciphertext's
 * only healthy sibling. The remedy is deliberate: repair/replace the file, or
 * delete it to start empty on purpose.
 */
export function setConfigFiles(botId: string, files: BotConfigFile[]): void {
  const { storage: current, corrupt } = load(botId);
  if (corrupt) {
    throw new Error(`The config-file store for bot ${botId} exists but cannot be read; refusing to overwrite it. Repair or replace configFiles.json (the damaged original is preserved as configFiles.json.corrupt), or delete configFiles.json to deliberately start with an empty store and re-enter the files.`);
  }

  const envPath = getEnvPath(botId);
  fs.mkdirSync(envPath, { recursive: true });

  // An undecryptable stored body must survive saves that do not deliberately
  // replace it: the editor renders it as '' (and drops emptied rows), so a
  // zero-edit save would otherwise destroy the ciphertext's only home while a
  // restored key could still recover it. A non-empty incoming body is a real
  // re-entry and wins; removing such an entry entirely is a deliberate
  // operator file action (delete configFiles.json).
  const broken = new Map(current.files.filter(f => decryptOrNull(f.body) === null).map(f => [f.path, f]));

  const nextFiles = (files || [])
    .filter(f => f && typeof f.path === 'string' && f.path.trim() && typeof f.body === 'string')
    .map(f => {
      const p = f.path.trim();
      const keep = f.body === '' ? broken.get(p) : undefined;
      return { path: p, body: keep ? keep.body : encrypt(f.body), readOnly: f.readOnly !== false, enabled: f.enabled !== false };
    });
  const present = new Set(nextFiles.map(f => f.path));
  for (const [p, old] of broken) {
    if (!present.has(p)) nextFiles.push({ path: p, body: old.body, readOnly: old.readOnly !== false, enabled: old.enabled !== false });
  }
  const storage: ConfigFileStorage = { files: nextFiles };

  // Atomic: this file is the only home of the bodies, so a kill mid-save must
  // not leave it truncated.
  const p = storageFile(botId);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(storage, null, 2));
  fs.renameSync(tmp, p);
  console.log(`[ConfigFiles] Saved ${storage.files.length} config file(s) for bot ${botId}`);
}
