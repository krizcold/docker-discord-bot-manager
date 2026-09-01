/**
 * Data-driven per-SOURCE APP CAPABILITIES (PLAN_REPLICATION 20.11/20.16), keyed
 * by repo URL exactly like TEMPLATE_MODIFIERS and INSTALL_MANIFESTS. A record
 * declares what an app supports so the manager's database lifecycle stays a
 * generic "managed Postgres companion" capability with no per-bot branch: the
 * manager knows how to copy, stand by, promote and tunnel, and the record says
 * what this app calls its database and where to reach its lifecycle hooks.
 *
 * INSTALL_MANIFESTS is per config FILE (match + target basename); this registry
 * is per SOURCE, so it sits beside it rather than as a field on it.
 *
 * The manager never learns what a master or a backup is. Those are the app's
 * own concepts: it decides, records what it concluded, and the manager acts on
 * the facts through the hook contract below.
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
     * Canonical DSN a cross-host node dials instead. Authored and retired by
     * the REPLICATION POSTURE on the hosting instance, not by hosting alone, so
     * its absence on a live host means replication is off, not a gap to fill.
     */
    publicUrl?: string;
    /**
     * Backend selector the app reads, e.g. DATA_BACKEND=postgres. Operator-set:
     * the install wizard owns the field, and the companion lifecycle never
     * authors it. It reads it as the provisioning gate (against the merged env
     * view) and re-asserts it in the ENV STORE ONLY when adopting a promoted
     * copy, so on an adopted node it reaches the container through the app's own
     * store rather than the compose; the deployed compose carries it only where
     * the operator's own save put it in the instance record. Retired from all
     * three stores with the rest of the block on an instance that stops hosting:
     * left behind, the next rebuild reads it with no URL beside it and mints a
     * fresh sidecar for a node that just stopped owning a database.
     */
    mode?: { key: string; value: string };
  };
  /**
   * Keys the manager REWRITES only where they are already set, and retires with
   * the block above. It never authors one: an absent key means this app is not
   * using that lane, and creating it would opt the instance into a lane its
   * owner never chose.
   */
  repointedEnv?: string[];
  /**
   * Keys the APP writes about this database, in the app's own store. The manager
   * must never author one: a value for these in the INSTANCE RECORD or the
   * deployed compose is pinned into the container, where it outranks the app's
   * own store, so finding one there is an anomaly to retire rather than
   * app-owned state to preserve.
   */
  appOwnedEnv?: string[];
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

/**
 * The peer control plane this app runs between its OWN instances. The manager
 * wires it structurally - it discovers the ports from the compose marker
 * labels, mints the hostnames, attaches the proxy routes and publishes the
 * loopback ports - and knows nothing about what the peers are to each other.
 * Only the NAMES live here: what this app calls the wiring it is handed, and
 * how it spells which way a node faces.
 *
 * Declared ahead of most of its consumers (the B4m-1 interface-first order):
 * wizardFields and roleEnv drive the env surface now; the authoring sites for
 * `env` and `urlScheme` migrate in the drill-gated B4m-3 steps and read their
 * own literals until then.
 */
export interface ControlPlaneSpec {
  /**
   * Env keys the manager AUTHORS on the app service: suppressed from the
   * wizard's detected rows and retired from a stale compose when no longer
   * derivable. Never author a key absent here. The manager computes these at
   * deploy and never STORES one, so a stored value under one of these names is
   * operator-written and the editor keeps it visible; transferUrl in
   * particular is hand-set on rigs with no public base, where the manager
   * cannot judge container-name reachability.
   */
  env: {
    port: string;
    publicUrl: string;
    transferPort?: string;
    transferUrl?: string;
  };
  /**
   * Scheme pair for the URLs the manager mints. Two, not one: a public route
   * is TLS-terminated at the proxy; the same-box container-name dial never is.
   */
  urlScheme: { secure: string; plain: string };
  /**
   * How this app spells which way a node faces, and nothing more. `dialsOut`
   * values mean "this node dials a peer"; every other value means peers dial
   * this node; an absent or empty value reads as `default`. No hierarchy is
   * expressed and the manager infers none. `dialTargetOrder` is the order a
   * joining node should list dialable peers.
   */
  roleEnv: {
    key: string;
    default: string;
    dialsOut: string[];
    dialTargetOrder: string[];
  };
  /** Key holding the ordered list of peer control URLs this node dials. */
  dialEnv: string;
  /** Key whose shared value marks a set of peers as one deployment. */
  groupSecretEnv?: string;
  /**
   * The guided install/edit rows for this control plane, rendered verbatim.
   * Opaque: the manager never reads a key out of here that the fields above
   * and the companion declaration do not also name.
   */
  wizardFields: WizardEnvVar[];
}

export interface AppCapabilityManifest {
  match: SourceMatch;
  companionDb?: CompanionDbSpec;
  controlPlane?: ControlPlaneSpec;
  hooks?: AppHooksSpec;
}

/** The lifecycle actions an app implementing the hook contract must serve. */
export type AppHookAction =
  | 'facts'
  | 'promote'
  | 'promote/continue'
  | 'promote/cancel'
  | 'demote'
  | 'confirm-fresh'
  /** Hand the app the copy block for the database it hosts, so it can relay it. */
  | 'copy-block';

// Shared by the companion declaration and the guided rows below, so a wizard
// row can never drift from the declared key it edits.
const smdbDbEnv = {
  url: 'DATA_BACKEND_URL',
  publicUrl: 'DATA_BACKEND_PUBLIC_URL',
  mode: { key: 'DATA_BACKEND', value: 'postgres' },
};
const smdbRoleEnv = {
  key: 'BOT_NODE_ROLE',
  default: 'master',
  dialsOut: ['co-worker', 'backup-master'],
  dialTargetOrder: ['master', 'backup-master'],
};
const smdbDialEnv = 'MASTER_URLS';
const smdbGroupSecretEnv = 'CONTROL_SECRET';

function smdbWizardFields(): WizardEnvVar[] {
  const base = { defaultValue: '', required: false, source: 'compose' as const, sensitive: false, autoWired: false, group: 'Fleet' };
  // backup-master is a designated co-worker: it dials a master like any worker
  // and additionally gets the Promote surface. Every worker-role conditional
  // must match both values.
  const whenWorkerRole = { key: smdbRoleEnv.key, equals: smdbRoleEnv.dialsOut };
  return [
    {
      ...base,
      key: smdbRoleEnv.key,
      displayLabel: 'Fleet Role',
      description: 'Master runs the control plane and assigns shards. Co-worker dials into a master. Backup Master is a co-worker that can take over when the master dies (postgres data backend only). A single standalone bot is a master.',
      defaultValue: smdbRoleEnv.default,
      options: [
        { value: 'master', label: 'Master' },
        { value: 'co-worker', label: 'Co-worker' },
        { value: 'backup-master', label: 'Backup Master' },
      ],
      groupHelp: 'Run one bot identity across several machines. A single standalone bot needs no changes here.',
    },
    {
      ...base,
      key: smdbDialEnv,
      displayLabel: 'Master Candidates',
      description: 'Ordered list of every master-capable control URL: the master first, then the backup master. Workers cycle through it on reconnect, so a failover needs no reconfiguration. A master lists the OTHER master-capable nodes: it checks them before claiming the fleet at startup, so a master that comes back after a failover parks itself instead of splitting the fleet in two, and can then be demoted from its web UI. Optional for a master, required for a worker. Same-server installs fill this automatically.',
      placeholder: 'wss://mybot-fleet.dbot.example.com',
      list: true,
      requiredWhen: whenWorkerRole,
    },
    {
      ...base,
      key: smdbGroupSecretEnv,
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
      inputType: 'number' as const,
      advanced: true,
    },
    {
      ...base,
      key: 'FLEET_SHARD_CAPACITY',
      displayLabel: 'Fleet Shard Capacity',
      description: 'Advanced: max shards THIS instance holds. Default 1. The master only hands out unassigned shards; a worker with no free shard waits on hold.',
      inputType: 'number' as const,
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
      key: smdbDbEnv.mode.key,
      displayLabel: 'Data Backend',
      description: 'file keeps data in simple per-instance JSON files (the default). postgres uses a central database, for multi-machine fleets and big bots.',
      defaultValue: 'file',
      options: [{ value: 'file' }, { value: smdbDbEnv.mode.value }],
      showWhen: { key: smdbRoleEnv.key, equals: smdbRoleEnv.default },
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
    // Repointed on promotion and on rescue, only where the fleet already runs a
    // separate control store; never created.
    repointedEnv: ['CONTROL_STORE_URL'],
    // The bot splices its own same-box DSN on promotion and at backend boot.
    appOwnedEnv: ['DATA_BACKEND_LOCAL_URL'],
  },
  controlPlane: {
    env: {
      port: 'CONTROL_PORT',
      publicUrl: 'FLEET_PUBLIC_URL',
      transferPort: 'TRANSFER_PORT',
      transferUrl: 'TRANSFER_URL',
    },
    urlScheme: { secure: 'wss', plain: 'ws' },
    roleEnv: smdbRoleEnv,
    dialEnv: smdbDialEnv,
    groupSecretEnv: smdbGroupSecretEnv,
    wizardFields: smdbWizardFields(),
  },
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
