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
}

export type WizardEnvVar = DetectedEnvVar & EnvFieldMeta;

function envFieldMeta(v: EnvFieldMeta): EnvFieldMeta {
  const { options, generate, showWhen, requiredWhen, advanced, group, groupHelp, placeholder, inputType, list } = v;
  return { options, generate, showWhen, requiredWhen, advanced, group, groupHelp, placeholder, inputType, list };
}

// Fleet vars the manager injects at deploy time (the fleet contract's plumbing);
// never user-editable, so they must not surface in the wizard or the editor.
const MANAGER_INJECTED_FLEET_ENV = new Set(['CONTROL_PORT', 'TRANSFER_PORT', 'FLEET_PUBLIC_URL', 'TRANSFER_URL']);

function isManagerInjectedFleetEnv(key: string): boolean {
  return MANAGER_INJECTED_FLEET_ENV.has(key.toUpperCase());
}

/**
 * Fleet keys the guided schema retired: the designation now lives in
 * BOT_NODE_ROLE=backup-master and the dial list in MASTER_URLS. An instance
 * saved under the old schema is DISPLAYED in the new shape (below) and these
 * raw rows are suppressed, so the operator never edits two sources of truth;
 * setEnvVars drops the stored keys on the next save that carries a role.
 */
const LEGACY_FLEET_ENV = new Set(['MASTER_URL', 'FLEET_BACKUP_MASTER']);

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
  options?: { scanSource?: boolean; sourceUrl?: string }
): { vars: WizardEnvVar[]; detection: DetectionResult } {
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

  const vars: WizardEnvVar[] = detectEnvVars(repoPath, { scanSource }).map(v =>
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
        description: "Login for this bot's web UI gateway (blank disables the login form).",
        defaultValue: '',
        required: false,
        source: 'compose',
        sensitive: isSensitive(key),
        autoWired: false,
      });
    }
  }

  // Fleet section: any bot whose compose declares the fleet.control-port label
  // (the fleet contract marker) gets the guided fleet fields. Guided rows replace
  // same-key rows a raw scan may have found, so metadata always wins.
  if (composeDeclaresFleet(repoPath)) {
    const fleet = fleetEnvFields();
    const fleetKeys = new Set(fleet.map(f => f.key));
    for (let i = vars.length - 1; i >= 0; i--) {
      if (fleetKeys.has(vars[i].key)) vars.splice(i, 1);
    }
    vars.push(...fleet);
  }

  // Auto-fold low-touch prefilled rows into Advanced. Only ungrouped rows: a group
  // (e.g. Fleet) curates its own advanced flags, and its primary controls must stay
  // visible. Explicit flags already set on a row are left untouched.
  const surfaced = vars
    .filter(v => !isManagerInjectedFleetEnv(v.key))
    .map(v => (!v.group && v.advanced === undefined && isAdvancedEnv(v)) ? { ...v, advanced: true } : v);
  return { vars: surfaced, detection };
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

/**
 * Whether the bot's source compose declares the `fleet.control-port` label, the
 * general marker a fleet-capable bot uses to opt into fleet plumbing. Any bot
 * declaring it gets the guided Fleet env section; no bot is named in code.
 */
export function composeDeclaresFleet(repoPath: string | null): boolean {
  if (!repoPath) return false;
  for (const name of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    try {
      const p = path.join(repoPath, name);
      if (fs.existsSync(p) && /fleet\.control-port/.test(fs.readFileSync(p, 'utf-8'))) return true;
    } catch {
      // ignore unreadable compose
    }
  }
  return false;
}

/**
 * Guided env fields for the bot fleet contract (BOT_NODE_ROLE and friends, read
 * by the bot instance). CONTROL_PORT / FLEET_PUBLIC_URL are deliberately absent:
 * the manager injects those itself.
 */
function fleetEnvFields(): WizardEnvVar[] {
  const base = { defaultValue: '', required: false, source: 'compose' as const, sensitive: false, autoWired: false, group: 'Fleet' };
  // backup-master is a designated co-worker: it dials a master like any worker
  // and additionally gets the Promote surface. Every worker-role conditional
  // must match both values.
  const whenWorkerRole = { key: 'BOT_NODE_ROLE', equals: ['co-worker', 'backup-master'] };
  return [
    {
      ...base,
      key: 'BOT_NODE_ROLE',
      displayLabel: 'Fleet Role',
      description: 'Master runs the control plane and assigns shards. Co-worker dials into a master. Backup Master is a co-worker that can take over when the master dies (postgres data backend only). A single standalone bot is a master.',
      defaultValue: 'master',
      options: [
        { value: 'master', label: 'Master' },
        { value: 'co-worker', label: 'Co-worker' },
        { value: 'backup-master', label: 'Backup Master' },
      ],
      groupHelp: 'Run one bot identity across several machines. A single standalone bot needs no changes here.',
    },
    {
      ...base,
      key: 'MASTER_URLS',
      displayLabel: 'Master Candidates',
      description: 'Ordered list of every master-capable control URL: the master first, then the backup master. Workers cycle through it on reconnect, so a failover needs no reconfiguration. A master lists the OTHER master-capable nodes: it checks them before claiming the fleet at startup, so a master that comes back after a failover parks itself instead of splitting the fleet in two, and can then be demoted from its web UI. Optional for a master, required for a worker. Same-server installs fill this automatically.',
      placeholder: 'wss://mybot-fleet.dbot.example.com',
      list: true,
      requiredWhen: whenWorkerRole,
    },
    {
      ...base,
      key: 'CONTROL_SECRET',
      displayLabel: 'Control Secret',
      description: 'Shared secret for the whole fleet: every node, the backup master included, must carry the SAME value. Generated on the master; same-server installs fill it automatically, workers on other machines paste it from the master.',
      sensitive: true,
      generate: true,
      requiredWhen: whenWorkerRole,
    },
    {
      ...base,
      key: 'FLEET_SHARD_COUNT',
      displayLabel: 'Fleet Shard Count',
      description: 'Advanced: total shards across the fleet. Blank = Discord decides the count (right for almost every fleet). Set it (e.g. 8) only to spread a few test guilds across instances.',
      inputType: 'number',
      advanced: true,
    },
    {
      ...base,
      key: 'FLEET_SHARD_CAPACITY',
      displayLabel: 'Fleet Shard Capacity',
      description: 'Advanced: max shards THIS instance holds. Default 1. The master only hands out unassigned shards; a worker with no free shard waits on hold.',
      inputType: 'number',
      advanced: true,
    },
    {
      ...base,
      key: 'PIN_TEST_GUILD_SHARD',
      displayLabel: 'Pin Test Guild Shard',
      description: "Master only: keep the shard containing this bot's GUILD_ID on the master. Useful when testing.",
      defaultValue: 'false',
      options: [{ value: 'false' }, { value: 'true' }],
    },
    {
      ...base,
      key: 'NODE_NAME',
      displayLabel: 'Node Name',
      description: "A friendly name for this instance in the Fleet view (e.g. 'yundera', 'home-pc').",
    },
    {
      ...base,
      key: 'DATA_BACKEND',
      displayLabel: 'Data Backend',
      description: 'file keeps data in simple per-instance JSON files (the default). postgres uses a central database, for multi-machine fleets and big bots.',
      defaultValue: 'file',
      options: [{ value: 'file' }, { value: 'postgres' }],
      showWhen: { key: 'BOT_NODE_ROLE', equals: 'master' },
      advanced: true,
    },
    {
      ...base,
      key: 'DATA_BACKEND_URL',
      displayLabel: 'Database URL',
      description: 'Blank provisions a managed Postgres on this server. Paste a postgresql:// URL to use an external database instead.',
      sensitive: true,
      showWhen: { key: 'DATA_BACKEND', equals: 'postgres' },
      placeholder: 'blank = managed Postgres on this server',
      advanced: true,
    },
  ];
}

export interface EditorEnvVar extends EnvFieldMeta {
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
  tokenVarName?: string
): EditorEnvVar[] {
  const stored = getEnvVars(botId);
  const result: EditorEnvVar[] = [];
  const seen = new Set<string>();

  // WEBUI_USER/WEBUI_PASSWORD are surfaced via buildWizardEnvList (below) so they
  // appear in both the wizard and the editor without duplication.
  const detected = repoPath && fs.existsSync(repoPath) ? buildWizardEnvList(repoPath).vars : [];
  for (const d of detected) {
    if (d.autoWired) continue;   // deploy-injected, not user-editable
    seen.add(d.key);
    const isSet = stored[d.key] !== undefined;
    const sensitive = d.sensitive || isSensitive(d.key);
    result.push({
      ...envFieldMeta(d),
      key: d.key,
      displayLabel: d.displayLabel,
      description: d.description,
      required: d.required,
      sensitive,
      value: sensitive ? '' : (isSet ? stored[d.key] : d.defaultValue),
      isSet,
    });
  }

  // Legacy fleet env, shown in the new shape: a stored FLEET_BACKUP_MASTER=1
  // displays as the backup-master role, and a stored MASTER_URL fills the
  // candidates list. Role also mirrors the bot's own resolution (a dial URL
  // with no explicit role IS a co-worker), so confirming the form can never
  // silently turn a worker into a master.
  const guidedFleet = result.some(r => r.key === 'BOT_NODE_ROLE');
  if (guidedFleet) {
    const storedRole = (stored['BOT_NODE_ROLE'] || '').trim().toLowerCase();
    const legacyUrl = (stored['MASTER_URL'] || '').trim();
    const roleRow = result.find(r => r.key === 'BOT_NODE_ROLE');
    const urlsRow = result.find(r => r.key === 'MASTER_URLS');
    if (urlsRow && urlsRow.value.trim() === '' && legacyUrl !== '') {
      urlsRow.value = legacyUrl;
      urlsRow.isSet = true;
    }
    if (roleRow && storedRole !== 'master') {
      // Only the LEGACY single MASTER_URL implies a role. Every node carries
      // MASTER_URLS, the master included, so folding it in here rendered a
      // blank-role master as a co-worker and any save then demoted it.
      const dials = legacyUrl !== '';
      if ((stored['FLEET_BACKUP_MASTER'] || '').trim() === '1') {
        roleRow.value = 'backup-master';
        roleRow.isSet = true;
      } else if (storedRole === '' && dials) {
        roleRow.value = 'co-worker';
        roleRow.isSet = true;
      }
    }
  }

  // User-added vars not surfaced by detection.
  for (const [key, value] of Object.entries(stored)) {
    if (seen.has(key) || isManagerInjectedFleetEnv(key)) continue;
    if (guidedFleet && LEGACY_FLEET_ENV.has(key)) continue;   // folded into the guided rows above
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
