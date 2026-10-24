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
  getEnvVarsWithStatus,
  isSensitive,
  DetectedEnvVar,
} from './manager';
import { findAppCapabilities } from '../config/appCapabilities';
import { frontingGateway, frontingGatewayBindTargets } from '../templates/pcsProcessing';
import { parseDocument } from 'yaml';

/**
 * General presentation metadata an env row may carry (any bot, any var). The
 * wizard and editor renderers honor it; plain rows without it are unchanged.
 */
export interface EnvFieldMeta {
  options?: Array<{ value: string; label?: string }>;   // render as a select
  generate?: boolean;                                   // "Generate" button fills a random secret
  showWhen?: { key: string; equals: string | string[] };     // show only when another row has this value (any of)
  requiredWhen?: { key: string; equals: string | string[] }; // required only when another row has this value (any of)
  advanced?: boolean;                                   // fold under an "Advanced" disclosure
  group?: string;                                       // section heading shared by consecutive rows
  groupHelp?: string;
  placeholder?: string;
  inputType?: 'number';
  list?: boolean;                                       // dynamic list editor; value = comma-joined entries
  /**
   * What this row IS (stamped server-side from the app's capability record),
   * so the browser never matches an env key by spelling.
   */
  semantic?: 'peer-role' | 'peer-list' | 'peer-secret' | 'db-dsn' | 'backup-mode';
  /** For 'peer-role': the option values meaning "this node dials a peer"; for 'backup-mode': the one value meaning consent. */
  semanticValues?: string[];
  /**
   * For 'peer-role': the record's dialTargetOrder - the order a joining node
   * lists dialable peers, position 0 being the primary target.
   */
  semanticTargetOrder?: string[];
  /** Why this row has no effect on this deployment; the row renders read-only and is never saved. */
  inactive?: string;
}

/** Whether this deployment drops the compose's fronting gateway, and the bot's Auth mode. */
export interface GatewayDeploy {
  dropped: boolean;
  webAuth?: string;
  /** The bot has a public URL (BOT_DOMAIN_BASE set), so the bot card shows its Auth select. */
  publicUrl?: boolean;
  /** BOT_DOMAIN_BASE is set, so the bind does not keep the gateway. */
  domainBase?: boolean;
}

function gatewayDroppedNote(gateway: GatewayDeploy): string {
  const mode = gateway.webAuth || 'auto';
  const keep = gateway.publicUrl
    ? 'With Auth set to Public on the bot card, the gateway and this login stay.'
    : gateway.domainBase
      ? 'The gateway and this login stay when Auth is Public (`bots web-auth <id> public`).'
      : 'The gateway and this login stay when Auth is Public (`bots web-auth <id> public`) or when BOT_PORT_BIND is off loopback.';
  return `Not used: this deployment removes the bot's own login gateway (Auth: ${mode.charAt(0).toUpperCase()}${mode.slice(1)}). ${keep}`;
}

function gatewayFileNote(gateway: GatewayDeploy): string {
  return gatewayDroppedNote(gateway).replace('this login', 'this file');
}

export type WizardEnvVar = DetectedEnvVar & EnvFieldMeta;

function envFieldMeta(v: EnvFieldMeta): EnvFieldMeta {
  const { options, generate, showWhen, requiredWhen, advanced, group, groupHelp, placeholder, inputType, list, semantic, semanticValues, semanticTargetOrder, inactive } = v;
  return { options, generate, showWhen, requiredWhen, advanced, group, groupHelp, placeholder, inputType, list, semantic, semanticValues, semanticTargetOrder, inactive };
}

// Keys the manager authors on this app's service at deploy time, per the app's
// own capability record (PLAN_REPLICATION 20.18: never author a key absent
// there). Suppressed from the wizard's DETECTED rows only: a STORED value
// under one of these names is operator-written (the manager never stores one)
// and the editor keeps it visible - the hand-set transfer URL on a no-base rig
// is the supported case. An app with no record has no keys to suppress.
function managerInjectedFleetEnv(sourceUrl?: string | null): Set<string> {
  const env = findAppCapabilities(sourceUrl)?.controlPlane?.env;
  if (!env) return new Set();
  return new Set(
    [env.port, env.publicUrl, env.transferPort, env.transferUrl]
      .filter((k): k is string => !!k)
      .map(k => k.toUpperCase())
  );
}

// Keys the operator is expected to set on a fresh install, so they always stay
// visible up top even when prefilled - the bot identity and the web-UI access
// credentials. Sensitive vars are already kept visible by the general rule; these
// cover the non-sensitive identity fields (client/guild ids) as well.
const ALWAYS_SHOW_ENV = new Set([
  'CLIENT_ID', 'APPLICATION_ID', 'APP_ID', 'GUILD_ID', 'WEBUI_USER', 'WEBUI_PASSWORD',
]);

/**
 * Whether a row should fold into the collapsed Advanced disclosure. General rule
 * (no bot names): a row is advanced when it arrives prefilled with a non-empty
 * default the operator is unlikely to change, and is neither required, sensitive,
 * nor one of the always-show identity/credential keys. An explicit advanced flag
 * on the row (e.g. the fleet shard fields) always wins.
 */
function isAdvancedEnv(v: WizardEnvVar): boolean {
  if (v.advanced) return true;
  if (v.required) return false;
  if (v.sensitive || isSensitive(v.key)) return false;
  if (ALWAYS_SHOW_ENV.has(v.key.toUpperCase())) return false;
  return (v.defaultValue || '').trim() !== '';
}

/**
 * Wizard view: every var a fresh install should offer, enriched with
 * label/description/required/sensitive plus DB/Lavalink auto-wiring and the
 * config-file-as-env surfacing. This is the single source the env wizard and the
 * editor both build on.
 */
export function buildWizardEnvList(
  repoPath: string,
  options?: { scanSource?: boolean; sourceUrl?: string; gateway?: GatewayDeploy }
): { vars: WizardEnvVar[]; detection: DetectionResult; sourceScan?: { scanned: number; total: number } } {
  const scanSource = !!options?.scanSource;
  const detection = detectBotType(repoPath);
  const gatewayDropped = !!options?.gateway?.dropped;
  if (gatewayDropped && detection.configFiles) {
    detection.configFiles = detection.configFiles.filter(cf => !cf.gatewayService);
  }

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

  let sourceScan: { scanned: number; total: number } | undefined;
  const onSourceScan = (s: { scanned: number; total: number }) => { sourceScan = { scanned: s.scanned, total: s.total }; };
  const vars: WizardEnvVar[] = detectEnvVars(repoPath, { scanSource, onSourceScan }).map(v =>
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
  const credentialServices = composeCredentialServices(repoPath);
  if (credentialServices.services.length) {
    const loginDropped = gatewayDropped && !!credentialServices.gateway && credentialServices.services.every(s => s === credentialServices.gateway);
    for (const key of ['WEBUI_USER', 'WEBUI_PASSWORD']) {
      if (vars.some(v => v.key === key)) continue;
      vars.push({
        key,
        displayLabel: key === 'WEBUI_USER' ? 'Web UI Username' : 'Web UI Password',
        description: "Login for this bot's web UI gateway. A blank at install or rebuild leaves the login off; a blank on a later start keeps the current login.",
        defaultValue: '',
        required: false,
        source: 'compose',
        sensitive: isSensitive(key),
        autoWired: false,
        ...(loginDropped ? { inactive: gatewayDroppedNote(options!.gateway!) } : {}),
      });
    }
  }

  // Fleet section: an app whose capability record declares a control plane gets
  // its guided rows from that record (PLAN_REPLICATION 20.18: the gate and the
  // fields come from ONE declaration, so they can never disagree). Guided rows
  // replace same-key rows a raw scan may have found, so metadata always wins.
  const record = findAppCapabilities(options?.sourceUrl);
  const controlPlane = record?.controlPlane;
  if (controlPlane) {
    const semanticOf = (key: string): EnvFieldMeta => {
      if (key === controlPlane.roleEnv.key) return { semantic: 'peer-role', semanticValues: controlPlane.roleEnv.dialsOut, semanticTargetOrder: controlPlane.roleEnv.dialTargetOrder };
      if (controlPlane.modeEnv && key === controlPlane.modeEnv.key) return { semantic: 'backup-mode', semanticValues: [controlPlane.modeEnv.active] };
      if (key === controlPlane.dialEnv) return { semantic: 'peer-list' };
      if (controlPlane.groupSecretEnv && key === controlPlane.groupSecretEnv) return { semantic: 'peer-secret' };
      if (record?.companionDb && key === record.companionDb.env.url) return { semantic: 'db-dsn' };
      return {};
    };
    const fleet = controlPlane.wizardFields.map(f => ({ ...f, ...semanticOf(f.key) }));
    const fleetKeys = new Set(fleet.map(f => f.key));
    for (let i = vars.length - 1; i >= 0; i--) {
      if (fleetKeys.has(vars[i].key)) vars.splice(i, 1);
    }
    vars.push(...fleet);
  }

  // Auto-fold low-touch prefilled rows into Advanced. Only ungrouped rows: a group
  // (e.g. Fleet) curates its own advanced flags, and its primary controls must stay
  // visible. Explicit flags already set on a row are left untouched.
  const injected = managerInjectedFleetEnv(options?.sourceUrl);
  const surfaced = vars
    .filter(v => !injected.has(v.key.toUpperCase()))
    .map(v => (!v.group && v.advanced === undefined && isAdvancedEnv(v)) ? { ...v, advanced: true } : v);
  return sourceScan ? { vars: surfaced, detection, sourceScan } : { vars: surfaced, detection };
}

/**
 * The services of the bot's source compose that take WEBUI_USER / WEBUI_PASSWORD
 * in their environment, and the compose's fronting gateway when it has one. Keeps
 * the credential fields general (any bot using the convention).
 */
function composeCredentialServices(repoPath: string | null): { services: string[]; gateway?: string } {
  if (!repoPath) return { services: [] };
  for (const name of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    try {
      const p = path.join(repoPath, name);
      if (!fs.existsSync(p)) continue;
      const compose = parseDocument(fs.readFileSync(p, 'utf-8')).toJSON() as Record<string, unknown> | null;
      const services = (compose?.services || {}) as Record<string, Record<string, unknown>>;
      const using = Object.keys(services).filter(n => /WEBUI_USER|WEBUI_PASSWORD/.test(JSON.stringify(services[n]?.environment ?? '')));
      return { services: using, gateway: compose ? frontingGateway(compose)?.gateway : undefined };
    } catch {
      // ignore unreadable compose
    }
  }
  return { services: [] };
}

function composeGatewayBindTargets(repoPath: string | null): string[] {
  if (!repoPath) return [];
  for (const name of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    try {
      const p = path.join(repoPath, name);
      if (!fs.existsSync(p)) continue;
      const compose = parseDocument(fs.readFileSync(p, 'utf-8')).toJSON() as Record<string, unknown> | null;
      return compose ? frontingGatewayBindTargets(compose) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export interface EditorEnvVar extends EnvFieldMeta {
  key: string;
  displayLabel: string;
  description: string;
  required: boolean;
  sensitive: boolean;
  value: string;   // current value; blank for sensitive (a stored secret never leaves the server)
  isSet: boolean;  // whether a value is currently stored
  undecryptable?: boolean;  // stored, but the ciphertext no longer decrypts
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
  sourceUrl?: string,
  gateway?: GatewayDeploy
): EditorEnvVar[] {
  const { vars: stored, undecryptable } = getEnvVarsWithStatus(botId);
  for (const key of undecryptable) stored[key] = '';
  const unreadable = (key: string) => (undecryptable.includes(key) ? { undecryptable: true } : {});
  const result: EditorEnvVar[] = [];
  const seen = new Set<string>();

  // WEBUI_USER/WEBUI_PASSWORD are surfaced via buildWizardEnvList (below) so they
  // appear in both the wizard and the editor without duplication.
  const detected = repoPath && fs.existsSync(repoPath) ? buildWizardEnvList(repoPath, { sourceUrl, gateway }).vars : [];
  for (const d of detected) {
    if (d.autoWired) continue;   // deploy-injected, not user-editable
    seen.add(d.key);
    const isSet = stored[d.key] !== undefined;
    const sensitive = d.sensitive || isSensitive(d.key);
    // A stored value keeps an editable row: a read-only row is not saved, and
    // the save would then remove the stored key.
    const keepEditable = isSet && !!d.inactive;
    result.push({
      ...envFieldMeta(d),
      ...(keepEditable ? { inactive: undefined } : {}),
      key: d.key,
      displayLabel: d.displayLabel,
      description: keepEditable ? `${d.inactive} ${d.description}`.trim() : d.description,
      required: d.required,
      sensitive,
      value: sensitive ? '' : (isSet ? stored[d.key] : d.defaultValue),
      isSet,
      ...unreadable(d.key),
    });
  }

  // User-added vars not surfaced by detection. Keys the manager authors are
  // NOT filtered here: it computes them at deploy and never stores one, so a
  // STORED value under such a name is operator-written and must stay visible
  // (the hand-set transfer URL on a rig with no public base is the supported
  // case; hiding it made that lane write-only).
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
      ...unreadable(key),
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
  sourceUrl?: string,
  gateway?: GatewayDeploy
): Array<{ path: string; body: string; readOnly: boolean; enabled: boolean; bodyUndecryptable?: boolean; inactive?: string; fromTemplate?: boolean }> {
  const { files: stored, undecryptable } = configFileManager.getConfigFilesWithStatus(botId);
  const storedByPath = new Map(stored.map(s => [s.path, s]));
  const seen = new Set<string>();
  const result: Array<{ path: string; body: string; readOnly: boolean; enabled: boolean; bodyUndecryptable?: boolean; inactive?: string; fromTemplate?: boolean }> = [];

  const allDetected = repoPath && fs.existsSync(repoPath) ? (detectBotType(repoPath).configFiles || []) : [];
  const gatewayPaths = new Set(gateway?.dropped ? composeGatewayBindTargets(repoPath) : []);
  const detected = allDetected.filter(cf => !gatewayPaths.has(cf.inContainerPath));
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
      ...(s && undecryptable.includes(s.path) ? { bodyUndecryptable: true } : {}),
      ...(s ? {} : { fromTemplate: true }),
    });
  }

  for (const s of stored) {
    if (seen.has(s.path)) continue;
    seen.add(s.path);
    result.push({
      path: s.path, body: s.body, readOnly: s.readOnly !== false, enabled: s.enabled !== false,
      ...(undecryptable.includes(s.path) ? { bodyUndecryptable: true } : {}),
      ...(gatewayPaths.has(s.path) ? { inactive: gatewayFileNote(gateway!) } : {}),
    });
  }

  return result;
}
