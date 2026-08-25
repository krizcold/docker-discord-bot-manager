/**
 * Discord Bot Manager Types
 * Phase 5: Source/Instance Architecture
 */

// ─── Enums / Literals ───

export type BotType = 'nodejs' | 'python' | 'go' | 'java' | 'rust' | 'csharp' | 'dockerfile' | 'compose' | 'unknown';
export type DeploymentMode = 'casaos' | 'docker';
export type BotStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error' | 'building';
export type BotSourceType = 'git' | 'docker-image';

export type PackageManager =
  | 'npm' | 'yarn' | 'pnpm' | 'bun'
  | 'pip' | 'poetry' | 'uv' | 'pipenv' | 'setuptools'
  | 'go'
  | 'cargo'
  | 'maven' | 'gradle'
  | 'dotnet';

export type DatabaseKind = 'postgres' | 'mongo' | 'mariadb' | 'mysql' | 'redis' | 'sqlite';
export type SystemDep = 'ffmpeg' | 'libopus' | 'libsodium' | 'build-essential' | 'libcairo';

// ─── Source ───

export interface SourceMeta {
  id: string;
  sourceType?: BotSourceType;          // 'git' (default) | 'docker-image'
  imageRef?: string;                   // prebuilt image, for docker-image sources
  url: string;                         // Git clone URL (includes token if private)
  branch: string;                      // e.g. "main"
  lastCommitHash: string | null;       // SHA of HEAD after last fetch/clone
  lastCommitMessage: string | null;
  lastCommitDate: string | null;
  lastChecked: string | null;          // ISO timestamp of last fetch
  autoUpdate: boolean;                 // default true
  composeName: string | null;          // original "name:" from repo compose, or null
  createdAt: string;
  updatedAt: string;
}

export interface SourceRegistry {
  sources: Record<string, SourceMeta>;
}

// ─── Instance (Bot) ───

// Manager-provisioned fleet Postgres sidecar. Once created it is never dropped:
// flipping DATA_BACKEND back to file keeps the record and the volume (data retention).
export interface FleetDbRecord {
  containerName: string;
  user: string;
  db: string;
  volume: string;
  replication?: FleetDbReplication;
}

// Replication posture for the managed sidecar (PLAN_REPLICATION.md Stage 1).
// Present = the database is exposed (published port, TLS required off-host) and
// carries a replication role + physical slot for a standby on another machine.
export interface FleetDbReplication {
  role: string;                        // replication login role, e.g. 'replicator'
  password: string;                    // same trust domain as the URL mirror in this registry
  slot: string;                        // physical replication slot name
  hostPort: number;                    // published host port (container 5432)
  publicHost: string;                  // operator-provided host workers/replicas dial
  certHost: string;                    // host the pinned cert names; differing publicHost forces regeneration
  slotWalKeepMb?: number;              // max_slot_wal_keep_size bound; absent on old records = default applied on next enable
}

// Manager-provisioned streaming REPLICA of another machine's fleet database
// (PLAN_REPLICATION.md Stage 2). Lives beside a worker/backup-master instance;
// seeded with pg_basebackup, runs as a hot standby, exposed like the primary
// so it can serve the whole fleet after a promotion. The replicator password
// is deliberately NOT retained here - it lives only inside the standby's own
// postgresql.auto.conf after provisioning.
export interface FleetDbReplicaRecord {
  containerName: string;
  volume: string;
  slot: string;                        // slot name on the PRIMARY this standby consumes
  primaryHost: string;                 // primary endpoint (for display/diagnostics)
  primaryPort: number;
  publicHost: string;                  // this machine's advertised host (post-promotion serving)
  hostPort: number;                    // published host port (container 5432)
  certHost: string;                    // host THIS standby's own server cert names
}

// Recovery-channel arm state (PLAN_REPLICATION.md Section 18, RC-2). One
// helper relay container per armed side; the record is the source of truth
// the manager reconciles the container against on boot, so a manager restart
// never kills a multi-hour transfer. Key/cert/token sit in the same trust
// domain as FleetDbReplication.password (this registry file).
export interface RecoveryChannelRecord {
  mode: 'receiver' | 'source';
  containerName: string;
  token: string;
  createdAt: number;
  // receiver (the listening, reachable side)
  tunnelPort?: number;                 // published host port the source dials
  publicHost?: string;                 // host in the arm block; the cert names it
  tlsKey?: string;                     // PEM pair the listener presents
  tlsCert?: string;
  // source (the dialing, NAT'd side)
  endpointHost?: string;               // receiver's host:port from the arm block
  endpointPort?: number;
  pinCert?: string;                    // receiver's cert, pinned
}

// Receiver-side rescue state (PLAN_REPLICATION.md Section 18, RC-3). The
// persisted phase model: a manager death mid-seed resumes the phase, every
// phase is idempotently re-enterable. Lives beside the receiver channel
// record and is cleared by cancel or the RC-4 swap.
export interface RecoveryRescueRecord {
  phase: 'preflight' | 'bulk' | 'consistent' | 'standby' | 'streaming'
    | 'quiesce' | 'catchup' | 'promote' | 'teardown' | 'flip';
  startedAt: number;
  updatedAt: number;
  /** Structural halt (channel/database record gone): the phase is KEPT so Continue re-enters it, never restarts from scratch. */
  parked?: boolean;
  lastError?: string;
  /** OUTDATED receivers only: the stale copy was dumped before the overwrite. */
  dumpDone?: boolean;
  /** Streaming phase telemetry, refreshed by the monitor loop. */
  caughtUp?: boolean;
  lagBytes?: number;
  /** Swap (RC-4): the source's end-of-WAL captured at quiesce; catchup replays to it. */
  swapTargetLsn?: string;
  /** Swap (RC-4): this machine's public host captured while the channel record still existed; flip enables replication with it when no prior replication record has one. */
  swapPublicHost?: string;
}

// Daily pg_dump schedule for the managed sidecar. Absent means the defaults
// (enabled, 04:00, keep 7) for instances that have a fleetDb record.
export interface FleetBackupConfig {
  enabled: boolean;
  hour: number;
  keep: number;
}

export interface InstanceConfig {
  id: string;
  sourceId: string | null;             // FK to SourceMeta.id (null for docker-image)
  sourceUrl: string | null;            // Stored for re-association after source deletion

  sourceType: BotSourceType;           // 'git' | 'docker-image'
  imageRef?: string;                   // For docker-image source only

  // Three name layers
  displayName: string;                 // "My Custom Bot!", user's raw input
  sanitizedName: string;               // "mycustombot", compose name, folders, Caddy labels
  titleName: string;                   // "My Custom Bot", x-casaos.title

  status: BotStatus;
  containerIds: string[];

  // Authentication tokens
  updateToken?: string;

  // Runtime
  envVars?: Record<string, string>;
  port?: number;
  hostPort?: number;                   // docker mode: published host port for the bot's web UI
  fleetHostPort?: number;              // docker mode: published 127.0.0.1 host port for the fleet control plane
  transferHostPort?: number;           // docker mode: published 127.0.0.1 host port for the transfer channel (control + 1)
  webContainerPort?: number;           // docker mode: the container port hostPort maps to
  publicUrl?: string;                  // docker remote mode: https URL when routed through the bundled Caddy
  webUiPath?: string;                  // docker mode: web entry path from x-casaos.index, e.g. "/dashboard"
  webAuth?: 'auto' | 'managed' | 'public';   // web-UI auth mode, applies on next start; 'auto' detects self-authenticating bots
  fleetDb?: FleetDbRecord;             // manager-provisioned fleet Postgres sidecar
  fleetDbReplica?: FleetDbReplicaRecord; // manager-provisioned standby of another machine's fleet DB
  recoveryChannel?: RecoveryChannelRecord; // armed recovery-channel side (RC-2); reconciled against its helper container
  recoveryRescue?: RecoveryRescueRecord;   // receiver-side rescue phase state (RC-3); resumed across manager restarts
  fleetBackup?: FleetBackupConfig;     // sidecar pg_dump schedule; absent = defaults
  lastFleetBackupAt?: number;          // epoch ms of the last successful sidecar dump

  // Detection (for git source)
  botType?: BotType;
  hasDatabase?: boolean;
  databases?: DatabaseKind[];
  needsLavalink?: boolean;
  hasWebDashboard?: boolean;
  tokenVarName?: string;

  // Lifecycle
  hasBeenStarted?: boolean;
  webUiReady?: boolean;                // true once the bot's web UI pinged back reachable after its last (re)start
  lastStartAt?: number;                // epoch ms of the last (re)start; drives the Open-button grace fallback

  // Commit tracking
  lastBuiltCommit: string | null;      // SHA at time of last buildBot()

  // Instance auto-update (independent from source auto-update)
  autoUpdate?: boolean;                // default false; auto-rebuild when source has new commits
  autoUpdateInterval?: number;         // milliseconds between checks, default 86400000 (24 hours)
  autoUpdateHour?: number;             // 0-23, preferred hour for daily checks, default 4 (4am)

  // Metadata
  createdAt: string;
  updatedAt: string;
}

export interface InstanceRegistry {
  instances: Record<string, InstanceConfig>;
  deploymentMode?: DeploymentMode;
}

// ─── Backward Compat Aliases ───

export type BotConfig = InstanceConfig;
export type BotRegistry = InstanceRegistry;

// ─── Name Resolution ───

export interface ResolvedNames {
  displayName: string;
  sanitizedName: string;
  titleName: string;
}

// ─── Reserved Names ───

export const RESERVED_NAMES: readonly string[] = [
  'casaos', 'portainer', 'caddy', 'discordbotmanager',
  'discordbotmanagerapp', 'nginx', 'redis', 'postgres',
  'mongodb', 'mariadb', 'traefik', 'watchtower',
  // 'manager' and 'auth' are the manager/portal labels under the dbot. sub-level;
  // a bot must not take those names or it would shadow manager.dbot / auth.dbot.
  'homeassistant', 'pcs', 'bot', 'auth', 'manager',
] as const;

// ─── API DTOs ───

export interface CreateSourceRequest {
  url: string;
  branch?: string;
}

export interface CreateInstanceRequest {
  sourceId: string;
  displayName?: string;
  envVars?: Record<string, string>;
}

export interface CreateDockerImageInstanceRequest {
  displayName: string;
  imageRef: string;
  envVars?: Record<string, string>;
}

export interface UpdateInstanceRequest {
  displayName?: string;
  envVars?: Record<string, string>;
}

export interface UpdateSourceRequest {
  url?: string;
  autoUpdate?: boolean;
  branch?: string;
}

// ─── Detection ───

export interface DetectionResult {
  type: BotType;
  hasDockerfile: boolean;
  hasCompose: boolean;
  hasDatabase: boolean;
  entryPoint?: string;
  packageManager?: PackageManager;

  databases: DatabaseKind[];
  needsLavalink: boolean;
  hasMusic: boolean;
  hasWebDashboard: boolean;
  systemDeps: SystemDep[];
  tokenVarName: string;
  tokenVarDetected: boolean;    // true when a real token var was found; false when tokenVarName is just the fallback guess
  isTypeScript: boolean;
  packageName?: string;         // Rust binary name / C# assembly name
  webPort?: number;             // detected web dashboard port, if any
  jarPattern?: string;          // Java jar glob to COPY (shade/shadow aware)
  prebuiltJar?: boolean;        // Java repo ships a .jar with no build files
  configFiles: DetectedConfigFile[];
  interactiveSetup?: InteractiveSetupHint;  // bot needs an interactive first-run step we cannot automate
}

// Guidance shown when a bot requires an interactive setup the manager cannot run
// unattended (e.g. redbot-setup, a first-run stdin prompt).
export interface InteractiveSetupHint {
  reason: string;
  advice: string;
}

// A config file the repo expects (copied from a *.example / *.sample template).
// Used by the wizard to surface its keys as env vars (env-first) and to offer
// raw file delivery for bots that are configured by a file rather than env.
export interface DetectedConfigFile {
  exampleName: string;          // template file as found, e.g. "config.json.example"
  targetName: string;           // resolved real name, e.g. "config.json"
  format: 'json' | 'yaml' | 'raw';
  inContainerPath: string;      // best-effort mount path, e.g. "/app/config.json"
  keys: Array<{ key: string; defaultValue: string; sensitive: boolean }>;
  rawBody: string;              // verbatim template contents (prefills the wizard)
}

// ─── Docker ───

export interface ContainerInfo {
  id: string;
  name: string;
  state: string;
  status: string;
  ports: PortBinding[];
}

export interface PortBinding {
  containerPort: number;
  hostPort: number;
  protocol: string;
}

export interface LogEntry {
  timestamp: string;
  message: string;
  stream: 'stdout' | 'stderr';
}

// ─── API ───

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
