/**
 * Variable Substitution System (Yundera Compiler Pattern)
 *
 * Replaces placeholder variables in docker-compose.yml files with actual values.
 * This follows the same pattern as the Yundera GitHub Compiler.
 */

import crypto from 'crypto';
import { BotConfig } from '../types';

/**
 * Generates a random hash for tokens
 */
export function generateHash(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Standard variables that can be substituted in compose files
 */
export interface SubstitutionVariables {
  APP_ID: string;
  AUTH_HASH: string;
  API_HASH: string;
  PUID: string;
  PGID: string;
  REF_DOMAIN: string;
  REF_SCHEME: string;
  REF_PORT: string;
  [key: string]: string;
}

/**
 * Builds the substitution variables object from bot config and environment
 */
export function buildSubstitutionVariables(bot: BotConfig): SubstitutionVariables {
  const vars: SubstitutionVariables = {
    APP_ID: `bot-${bot.id}`,
    AUTH_HASH: bot.authHash || generateHash(),
    API_HASH: bot.updateToken || generateHash(),
    PUID: process.env.PUID || '1000',
    PGID: process.env.PGID || '1000',
    REF_DOMAIN: process.env.REF_DOMAIN || 'localhost',
    REF_SCHEME: process.env.REF_SCHEME || 'http',
    REF_PORT: process.env.REF_PORT || '3000',
  };

  // Add bot's env vars as substitution variables
  if (bot.envVars) {
    for (const [key, value] of Object.entries(bot.envVars)) {
      vars[key] = value;
    }
  }

  return vars;
}

/**
 * Applies variable substitution to a compose file content.
 *
 * Replaces variables in these formats:
 * - $VARIABLE_NAME
 * - ${VARIABLE_NAME}
 *
 * @param compose - Raw docker-compose.yml content
 * @param bot - Bot configuration
 * @returns Processed compose content with variables replaced
 */
export function applyVariableSubstitution(compose: string, bot: BotConfig): string {
  const vars = buildSubstitutionVariables(bot);

  let result = compose;

  // Replace both $VAR and ${VAR} formats
  for (const [key, value] of Object.entries(vars)) {
    // Replace ${VAR} format first (more specific)
    result = result.split(`\${${key}}`).join(value);
    // Replace $VAR format (at word boundary to avoid partial matches)
    // Use regex for word boundary matching
    const dollarPattern = new RegExp(`\\$${key}(?![A-Za-z0-9_])`, 'g');
    result = result.replace(dollarPattern, value);
  }

  return result;
}

/**
 * Validates that all required variables are present in the bot config.
 * Returns list of missing required variables.
 */
export function validateRequiredVariables(compose: string, bot: BotConfig): string[] {
  const missing: string[] = [];

  // Check for common required variables that might be in compose
  const requiredPatterns = [
    { pattern: /\$\{?DISCORD_TOKEN\}?/, envKey: 'DISCORD_TOKEN' },
    { pattern: /\$\{?CLIENT_ID\}?/, envKey: 'CLIENT_ID' },
  ];

  for (const { pattern, envKey } of requiredPatterns) {
    if (pattern.test(compose)) {
      if (!bot.envVars?.[envKey]) {
        missing.push(envKey);
      }
    }
  }

  return missing;
}

/**
 * Extracts all variable placeholders from a compose file.
 * Useful for debugging and showing users what variables are expected.
 */
export function extractVariables(compose: string): string[] {
  const variables = new Set<string>();

  // Match ${VAR} format
  const bracketMatches = compose.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g);
  for (const match of bracketMatches) {
    variables.add(match[1]);
  }

  // Match $VAR format (word boundary)
  const dollarMatches = compose.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)(?![A-Za-z0-9_])/g);
  for (const match of dollarMatches) {
    variables.add(match[1]);
  }

  return Array.from(variables).sort();
}
