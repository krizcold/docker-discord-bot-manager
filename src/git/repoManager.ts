/**
 * Bot Instance Path Helpers
 * Resolves per-instance directories under /data/bots/{botId}/.
 *
 * Source repositories live elsewhere (see source/sourceManager.ts) and are
 * shared across instances; this module only handles per-bot storage.
 */

import * as path from 'path';

const DATA_DIR = process.env.DATA_DIR || '/data/data';
const BOTS_DIR = path.join(DATA_DIR, 'bots');

export function getBotDir(botId: string): string {
  return path.join(BOTS_DIR, botId);
}

export function getDataPath(botId: string): string {
  return path.join(BOTS_DIR, botId, 'data');
}

export function getEnvPath(botId: string): string {
  return path.join(BOTS_DIR, botId, 'env');
}
