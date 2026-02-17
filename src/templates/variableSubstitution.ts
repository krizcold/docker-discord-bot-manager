/**
 * Variable Substitution System
 *
 * Replaces placeholder variables in docker-compose.yml files with actual values.
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
 * Standard variables that can be substituted in compose files.
 * Matches the PCS/CasaOS variable set from the github compiler.
 */
export interface SubstitutionVariables {
  [key: string]: string;
}

/**
 * Builds the substitution variables object from bot config and environment.
 * Variable set matches the github compiler's replaceTemplateVars + PCS environment.
 */
export function buildSubstitutionVariables(bot: BotConfig): SubstitutionVariables {
  const env = process.env;

  const refScheme = env.REF_SCHEME || 'http';
  const refDomain = env.REF_DOMAIN || 'localhost';
  const refPort = env.REF_PORT || '3000';
  const refSeparator = env.REF_SEPARATOR || '-';
  const refNet = env.REF_NET || 'pcs';
  const dataRoot = env.DATA_ROOT || '/DATA';
  const puid = env.PUID || '1000';
  const pgid = env.PGID || '1000';

  const vars: SubstitutionVariables = {
    // Bot-specific variables
    APP_ID: `bot-${bot.id}`,
    AUTH_HASH: bot.authHash || generateHash(),
    API_HASH: bot.updateToken || generateHash(),
    BOT_MANAGER_API: `${refScheme}://${refDomain}:${refPort}`,

    // User/group
    PUID: puid,
    PGID: pgid,

    // REF variables
    REF_DOMAIN: refDomain,
    REF_SCHEME: refScheme,
    REF_PORT: refPort,
    REF_SEPARATOR: refSeparator,
    REF_NET: refNet,
    REF_DEFAULT_PORT: env.REF_DEFAULT_PORT || '80',

    // Data and system
    DATA_ROOT: dataRoot,
    TZ: env.TZ || 'UTC',
    USER: env.USER || 'root',

    // PCS variables
    PCS_DATA_ROOT: env.PCS_DATA_ROOT || dataRoot,
    PCS_DEFAULT_PASSWORD: env.PCS_DEFAULT_PASSWORD || env.default_pwd || 'casaos',
    PCS_DOMAIN: env.PCS_DOMAIN || env.domain || '',
    PCS_PUBLIC_IP: env.PCS_PUBLIC_IP || env.public_ip || '',
    PCS_PUBLIC_IPV6: env.PCS_PUBLIC_IPV6 || '',
    PCS_EMAIL: env.PCS_EMAIL || '',

    // CasaOS legacy variables
    DefaultUserName: env.DefaultUserName || 'admin',
    DefaultPassword: env.DefaultPassword || env.default_pwd || env.PCS_DEFAULT_PASSWORD || 'casaos',
    default_pwd: env.default_pwd || env.PCS_DEFAULT_PASSWORD || 'casaos',
    public_ip: env.public_ip || env.PCS_PUBLIC_IP || '',
    domain: env.domain || env.PCS_DOMAIN || '',

    // SMTP
    SMTP_HOST: env.SMTP_HOST || '',
    SMTP_PORT: env.SMTP_PORT || '',
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
