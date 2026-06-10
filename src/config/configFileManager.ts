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
import { encrypt, decrypt } from '../env/manager';

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

function load(botId: string): ConfigFileStorage {
  try {
    const p = storageFile(botId);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (error) {
    console.error(`[ConfigFiles] Failed to load for bot ${botId}:`, error);
  }
  return { files: [] };
}

/**
 * Get a bot's config files with decrypted bodies.
 */
export function getConfigFiles(botId: string): BotConfigFile[] {
  return load(botId).files.map(f => ({ path: f.path, body: decrypt(f.body), readOnly: f.readOnly !== false, enabled: f.enabled !== false }));
}

/**
 * Replace a bot's config files. Empty paths or non-string bodies are dropped.
 */
export function setConfigFiles(botId: string, files: BotConfigFile[]): void {
  const envPath = getEnvPath(botId);
  fs.mkdirSync(envPath, { recursive: true });

  const storage: ConfigFileStorage = {
    files: (files || [])
      .filter(f => f && typeof f.path === 'string' && f.path.trim() && typeof f.body === 'string')
      .map(f => ({ path: f.path.trim(), body: encrypt(f.body), readOnly: f.readOnly !== false, enabled: f.enabled !== false })),
  };

  fs.writeFileSync(storageFile(botId), JSON.stringify(storage, null, 2));
  console.log(`[ConfigFiles] Saved ${storage.files.length} config file(s) for bot ${botId}`);
}
