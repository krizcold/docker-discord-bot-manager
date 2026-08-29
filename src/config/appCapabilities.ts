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

export interface AppCapabilityManifest {
  match: SourceMatch;
  companionDb?: CompanionDbSpec;
  hooks?: AppHooksSpec;
}

/** The lifecycle actions an app implementing the hook contract must serve. */
export type AppHookAction =
  | 'facts'
  | 'promote'
  | 'promote/continue'
  | 'promote/cancel'
  | 'demote'
  | 'confirm-fresh';

const superModularDiscordBot: AppCapabilityManifest = {
  match: { urlContains: 'modular-discord-bot' },
  companionDb: {
    engine: 'postgres',
    user: 'smdb',
    database: 'smdb',
    env: {
      url: 'DATA_BACKEND_URL',
      publicUrl: 'DATA_BACKEND_PUBLIC_URL',
      mode: { key: 'DATA_BACKEND', value: 'postgres' },
    },
    // Repointed on promotion and on rescue, only where the fleet already runs a
    // separate control store; never created.
    repointedEnv: ['CONTROL_STORE_URL'],
    // The bot splices its own same-box DSN on promotion and at backend boot.
    appOwnedEnv: ['DATA_BACKEND_LOCAL_URL'],
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
