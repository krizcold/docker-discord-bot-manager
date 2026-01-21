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

  // Add missing required vars
  for (const required of REQUIRED_DISCORD_ENVS) {
    if (!vars[required]) {
      result.push({
        key: required,
        value: '',
        sensitive: isSensitive(required),
        required: true
      });
    }
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
