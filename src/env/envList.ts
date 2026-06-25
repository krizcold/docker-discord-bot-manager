/**
 * Shared env-var list builders for the install wizard and the post-install env
 * editor, so the two stay in parity (same labels, comment tips, required logic).
 * Detection + config-surfacing + token handling live here once.
 */

import * as fs from 'fs';
import * as path from 'path';
import { detectBotType } from '../detection';
import { DetectionResult } from '../types';
import * as configFileManager from '../config/configFileManager';
import { applyTemplateModifiers } from '../config/templateModifiers';
import { manifestDeclaredConfigFiles } from '../config/installManifests';
import {
  detectEnvVars,
  normalizeEnvLabel,
  getEnvVars,
  isSensitive,
  DetectedEnvVar,
} from './manager';

/**
 * Wizard view: every var a fresh install should offer, enriched with
 * label/description/required/sensitive plus DB/Lavalink auto-wiring and the
 * config-file-as-env surfacing. This is the single source the env wizard and the
 * editor both build on.
 */
export function buildWizardEnvList(
  repoPath: string,
  options?: { scanSource?: boolean; sourceUrl?: string }
): { vars: DetectedEnvVar[]; detection: DetectionResult } {
  const scanSource = !!options?.scanSource;
  const detection = detectBotType(repoPath);

  const autoWiredKeys = new Set<string>();
  if (!detection.hasCompose) {
    for (const db of detection.databases) {
      if (db === 'postgres' || db === 'mariadb' || db === 'mysql') autoWiredKeys.add('DATABASE_URL');
      if (db === 'mongo') { autoWiredKeys.add('MONGO_URI'); autoWiredKeys.add('MONGODB_URI'); }
      if (db === 'redis') autoWiredKeys.add('REDIS_URL');
    }
    if (detection.needsLavalink) {
      autoWiredKeys.add('LAVALINK_HOST');
      autoWiredKeys.add('LAVALINK_PORT');
      autoWiredKeys.add('LAVALINK_PASSWORD');
    }
  }

  const vars = detectEnvVars(repoPath, { scanSource }).map(v =>
    autoWiredKeys.has(v.key) ? { ...v, autoWired: true } : v
  );

  // Env-first: surface a config file's top-level scalar keys as env vars, so
  // file-based bots that also read process.env are fully configurable without
  // delivering a file. The token key is required; others show only when they
  // carry a pre-filled value (mirrors detectEnvVars).
  for (const cf of detection.configFiles || []) {
    for (const k of cf.keys) {
      if (vars.some(v => v.key === k.key)) continue;
      const required = k.key === detection.tokenVarName;
      if (!required && k.defaultValue.trim() === '') continue;
      vars.push({
        key: k.key,
        displayLabel: normalizeEnvLabel(k.key),
        description: '',
        defaultValue: k.defaultValue,
        required,
        source: 'config',
        sensitive: k.sensitive,
        autoWired: false,
      });
    }
  }

  // Surface the bot's token var as a required field, but only when it was actually
  // detected. A bot configured by a file (or via a non-env mechanism) reads no env
  // token, so a fabricated DISCORD_TOKEN field would be inert and misleading - the
  // user would set it and the bot would still start tokenless. Config-file tokens
  // are surfaced above via the configFiles loop instead.
  const tokenVar = detection.tokenVarName;
  if (tokenVar && detection.tokenVarDetected && !vars.some(v => v.key === tokenVar)) {
    vars.unshift({
      key: tokenVar,
      displayLabel: normalizeEnvLabel(tokenVar),
      description: '',
      defaultValue: '',
      required: true,
      source: 'env-example',
      sensitive: true,
      autoWired: false,
    });
  }

  // Append config files a manifest declares but detection misses (deep path, no
  // compose bind, named-volume delivery), so the wizard surfaces them as guided
  // forms. Done AFTER the env-first loop above on purpose: these are guided-form
  // config, not env-configured, so their keys must not become env-var rows.
  if (options?.sourceUrl) {
    const extra = manifestDeclaredConfigFiles(options.sourceUrl, repoPath, detection.configFiles || []);
    if (extra.length) detection.configFiles = [...(detection.configFiles || []), ...extra];
  }

  // AppShield optional login: show Web UI Username/Password as editable, empty-by-
  // default fields when the bot's gateway uses them. They can't be named USER/
  // PASSWORD directly (USER is a reserved/hidden platform var), and detection skips
  // them because their compose value is a $-substitution.
  if (composeReferencesCredentials(repoPath)) {
    for (const key of ['WEBUI_USER', 'WEBUI_PASSWORD']) {
      if (vars.some(v => v.key === key)) continue;
      vars.push({
        key,
        displayLabel: key === 'WEBUI_USER' ? 'Web UI Username' : 'Web UI Password',
        description: "Optional login for this bot's web UI (leave blank for hash-only access).",
        defaultValue: '',
        required: false,
        source: 'compose',
        sensitive: isSensitive(key),
        autoWired: false,
      });
    }
  }

  return { vars, detection };
}

/**
 * Whether the bot's source compose opts into AppShield login credentials by
 * referencing WEBUI_USER / WEBUI_PASSWORD. Keeps the credential fields general
 * (any bot using the convention) rather than tied to a specific bot.
 */
function composeReferencesCredentials(repoPath: string | null): boolean {
  if (!repoPath) return false;
  for (const name of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    try {
      const p = path.join(repoPath, name);
      if (fs.existsSync(p) && /WEBUI_USER|WEBUI_PASSWORD/.test(fs.readFileSync(p, 'utf-8'))) return true;
    } catch {
      // ignore unreadable compose
    }
  }
  return false;
}

export interface EditorEnvVar {
  key: string;
  displayLabel: string;
  description: string;
  required: boolean;
  sensitive: boolean;
  value: string;   // current value; blank for sensitive (a stored secret never leaves the server)
  isSet: boolean;  // whether a value is currently stored
}

/**
 * Editor view: the same detected vars the wizard offers, pre-filled with the
 * bot's saved values, plus any user-added vars not surfaced by detection.
 * Auto-wired (deploy-injected) vars are omitted since they are not user-editable.
 * Sensitive values are masked to '' so a stored secret is never sent to the UI.
 */
export function buildBotEnvList(
  repoPath: string | null,
  botId: string,
  tokenVarName?: string,
  authHash?: string
): EditorEnvVar[] {
  const stored = getEnvVars(botId);
  const result: EditorEnvVar[] = [];
  const seen = new Set<string>();

  // AUTH_HASH lives on the instance (single source of truth) and its compose value
  // is a $-substitution, so detection never surfaces it. Surface it explicitly,
  // visible (not masked), so the user can read/copy/regenerate it.
  if (authHash !== undefined) {
    seen.add('AUTH_HASH');
    result.push({
      key: 'AUTH_HASH',
      displayLabel: 'Auth Hash',
      description: 'Web UI access hash, used by the Open link and the ?hash= login. Regenerate to revoke existing links.',
      required: false,
      sensitive: false,
      value: authHash,
      isSet: true,
    });
  }

  // WEBUI_USER/WEBUI_PASSWORD are surfaced via buildWizardEnvList (below) so they
  // appear in both the wizard and the editor without duplication.
  const detected = repoPath && fs.existsSync(repoPath) ? buildWizardEnvList(repoPath).vars : [];
  for (const d of detected) {
    if (d.autoWired) continue;   // deploy-injected, not user-editable
    seen.add(d.key);
    const isSet = stored[d.key] !== undefined;
    const sensitive = d.sensitive || isSensitive(d.key);
    result.push({
      key: d.key,
      displayLabel: d.displayLabel,
      description: d.description,
      required: d.required,
      sensitive,
      value: sensitive ? '' : (isSet ? stored[d.key] : d.defaultValue),
      isSet,
    });
  }

  // User-added vars not surfaced by detection.
  for (const [key, value] of Object.entries(stored)) {
    if (seen.has(key)) continue;
    seen.add(key);
    const sensitive = isSensitive(key);
    result.push({
      key,
      displayLabel: '',
      description: '',
      required: !!tokenVarName && key === tokenVarName,
      sensitive,
      value: sensitive ? '' : value,
      isSet: true,
    });
  }

  // Always surface the token field so it can be set.
  if (tokenVarName && !seen.has(tokenVarName)) {
    result.unshift({
      key: tokenVarName,
      displayLabel: normalizeEnvLabel(tokenVarName),
      description: '',
      required: true,
      sensitive: isSensitive(tokenVarName),
      value: '',
      isSet: false,
    });
  }

  return result;
}

/**
 * Config-editor view: the detected config files a fresh install would offer
 * (default body run through any per-source template modifier), overlaid with the
 * bot's saved bodies so the post-install editor surfaces baked-in configs even
 * when nothing was saved yet (parity with the env editor). Stored body wins; any
 * stored config not surfaced by detection is appended.
 */
export function buildBotConfigList(
  repoPath: string | null,
  botId: string,
  sourceUrl?: string
): Array<{ path: string; body: string; readOnly: boolean; enabled: boolean }> {
  const stored = configFileManager.getConfigFiles(botId);
  const storedByPath = new Map(stored.map(s => [s.path, s]));
  const seen = new Set<string>();
  const result: Array<{ path: string; body: string; readOnly: boolean; enabled: boolean }> = [];

  const detected = repoPath && fs.existsSync(repoPath) ? (detectBotType(repoPath).configFiles || []) : [];
  const declared = (repoPath && fs.existsSync(repoPath) && sourceUrl)
    ? manifestDeclaredConfigFiles(sourceUrl, repoPath, detected) : [];
  for (const cf of [...detected, ...declared]) {
    seen.add(cf.inContainerPath);
    const s = storedByPath.get(cf.inContainerPath);
    result.push({
      path: cf.inContainerPath,
      body: s ? s.body : applyTemplateModifiers(sourceUrl || '', cf.targetName, cf.format, cf.rawBody),
      readOnly: s ? s.readOnly !== false : true,
      enabled: s ? s.enabled !== false : true,
    });
  }

  for (const s of stored) {
    if (seen.has(s.path)) continue;
    seen.add(s.path);
    result.push({ path: s.path, body: s.body, readOnly: s.readOnly !== false, enabled: s.enabled !== false });
  }

  return result;
}
