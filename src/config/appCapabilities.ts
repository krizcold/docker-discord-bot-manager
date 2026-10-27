/**
 * Data-driven per-SOURCE APP CAPABILITIES (PLAN_REPLICATION 20.11/20.16), keyed
 * by repo URL exactly like TEMPLATE_MODIFIERS and INSTALL_MANIFESTS. A record
 * declares what an app supports so the manager's database lifecycle stays a
 * generic "managed Postgres companion" capability with no per-bot branch: the
 * record says what this app calls its database, which guided env rows it
 * offers and where to reach its lifecycle hooks.
 *
 * INSTALL_MANIFESTS is per config FILE (match + target basename); this registry
 * is per SOURCE, so it sits beside it rather than as a field on it.
 */
import { matchesSource, SourceMatch } from './sourceMatch';
import type { WizardEnvVar } from '../env/envList';

/**
 * The companion database the manager provisions for this app. Identity lives
 * here because the sidecar's role and user are the app's choice, and the env
 * keys because only the app knows where it reads its own DSN.
 */
export interface CompanionDbSpec {
  engine: 'postgres';
  user: string;
  database: string;
  /**
   * The env keys this companion's DSN reaches the app through. Each has its own
   * lifecycle, stated per key: do not assume one rule covers the block.
   */
  env: {
    /**
     * Container-name DSN, the form that resolves on the shared network.
     * Authored by the manager in its env store, the instance record and the
     * deployed compose, on the instance that HOSTS the companion, and retired
     * on every instance that does not: a node that does not own the database
     * must not carry a pin to it.
     */
    url: string;
    /**
     * Backend selector the app reads, e.g. DATA_BACKEND=postgres. Operator-set:
     * the install wizard owns the field, and the companion lifecycle never
     * authors it. It reads it as the provisioning gate (against the merged env
     * view) and re-asserts it in the ENV STORE ONLY when the operator's switch
     * adopts a copy they promoted, so on an adopted node it reaches the
     * container through the app's own store rather than the compose; the deployed compose carries it only where
     * the operator's own save put it in the instance record. Retired from all
     * three stores with the rest of the block on an instance that stops hosting:
     * left behind, the next rebuild reads it with no URL beside it and mints a
     * fresh sidecar for a node that just stopped owning a database.
     */
    mode?: { key: string; value: string };
  };
  /**
   * Path (relative to the app's data dir) of the app's OWN env file. The
   * manager reads it ONLY to recover this app's companion credentials in flows
   * where the app is stopped and no hook can answer (ruling F1 2026-09-01); a
   * present-but-unparseable value refuses loudly rather than guessing. The DSN
   * query spelling the manager authors (sslmode=no-verify, the node-postgres
   * form) is a manager constant, not a per-app field (ruling F2 2026-09-01).
   */
  appEnvFile?: string;
}

/**
 * Where this app serves the manager-facing lifecycle surface. The ACTIONS are
 * the capability contract and are the same for every app that implements it
 * (see AppHookAction); only the location and port are per-app. Auth is always
 * the per-instance token the manager already mints, sent as X-Bot-Token.
 */
export interface AppHooksSpec {
  /** Path the actions hang off, e.g. "/api/managed". */
  basePath: string;
  /** Container port the app serves on when no env overrides it. */
  port: number;
  /** Env var that overrides the port for this instance. */
  portEnvKey?: string;
}

export interface AppCapabilityManifest {
  match: SourceMatch;
  companionDb?: CompanionDbSpec;
  /** The guided install and edit rows for this app's fleet settings, rendered verbatim. */
  wizardFields?: WizardEnvVar[];
  hooks?: AppHooksSpec;
}

/** The lifecycle actions an app implementing the hook contract must serve. */
export type AppHookAction =
  | 'facts'
  | 'confirm-fresh'
  | 'maintenance';

// Shared by the companion declaration and the guided rows below, so a wizard
// row can never drift from the declared key it edits.
const smdbDbEnv = {
  url: 'DATA_BACKEND_URL',
  mode: { key: 'DATA_BACKEND', value: 'postgres' },
};

function smdbWizardFields(): WizardEnvVar[] {
  const base = { defaultValue: '', required: false, source: 'compose' as const, sensitive: false, autoWired: false, group: 'Fleet' };
  return [
    {
      ...base,
      key: 'FLEET_SHARD_COUNT',
      displayLabel: 'Fleet Shard Count',
      description: 'Advanced: total shards across the fleet. Blank = Discord decides the count (right for almost every fleet). Set it (e.g. 8) only to spread a few test guilds across instances.',
      inputType: 'number' as const,
      advanced: true,
    },
    {
      ...base,
      key: 'FLEET_SHARD_CAPACITY',
      displayLabel: 'Fleet Shard Capacity',
      description: 'Advanced: max shards THIS instance holds. Default 1.',
      inputType: 'number' as const,
      advanced: true,
    },
    {
      ...base,
      key: 'PIN_TEST_GUILD_SHARD',
      displayLabel: 'Pin Test Guild Shard',
      description: "Keep the shard containing this bot's GUILD_ID on this machine. Useful when testing.",
      defaultValue: 'false',
      options: [{ value: 'false' }, { value: 'true' }],
    },
    {
      ...base,
      key: 'NODE_NAME',
      displayLabel: 'Node Name',
      description: "A friendly name for this instance in the Fleet view (e.g. 'yundera', 'home-pc').",
      groupHelp: 'Run one bot identity across several machines. A single standalone bot needs no changes here.',
    },
    {
      ...base,
      key: smdbDbEnv.mode.key,
      displayLabel: 'Data Backend',
      description: 'file keeps data in simple per-instance JSON files (the default). postgres uses a central database, for multi-machine fleets and big bots.',
      defaultValue: 'file',
      options: [{ value: 'file' }, { value: smdbDbEnv.mode.value }],
      advanced: true,
    },
    {
      ...base,
      key: smdbDbEnv.url,
      displayLabel: 'Database URL',
      description: 'Blank provisions a managed Postgres on this server. Paste a postgresql:// URL to use an external database instead.',
      sensitive: true,
      showWhen: { key: smdbDbEnv.mode.key, equals: smdbDbEnv.mode.value },
      placeholder: 'blank = managed Postgres on this server',
      advanced: true,
    },
  ];
}

const superModularDiscordBot: AppCapabilityManifest = {
  match: { urlContains: 'modular-discord-bot' },
  companionDb: {
    engine: 'postgres',
    user: 'smdb',
    database: 'smdb',
    env: smdbDbEnv,
    appEnvFile: '.env',
  },
  wizardFields: smdbWizardFields(),
  hooks: {
    basePath: '/api/managed',
    port: 8080,
    portEnvKey: 'WEBUI_PORT',
  },
};

export const APP_CAPABILITIES: AppCapabilityManifest[] = [
  superModularDiscordBot,
];

/** The capability record for a source URL, or null when the app declares none. */
export function findAppCapabilities(sourceUrl: string | null | undefined): AppCapabilityManifest | null {
  if (!sourceUrl) return null;
  return APP_CAPABILITIES.find(record => matchesSource(record.match, sourceUrl)) || null;
}
