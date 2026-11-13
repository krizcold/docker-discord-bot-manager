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
  cloneError?: string | null;          // why the last clone failed, cleared by a successful clone
  cloneFailedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SourceRegistry {
  sources: Record<string, SourceMeta>;
}

// ─── Instance (Bot) ───

// Manager-provisioned fleet Postgres sidecar. Once created it is never dropped:
// flipping the backend mode away keeps the record and the volume (data retention).
export interface FleetDbRecord {
  containerName: string;
  user: string;
  db: string;
  volume: string;
  password?: string;                   // the bot role's password in this database; encrypted at rest
  replication?: FleetDbReplication;
  retiringAt?: string;                 // ISO time a retire first began removing this database; leaves with the record once a retire finishes
  keptPlain?: string[];                // FleetDbReplication.keptPlain a Disable carried over; the next start narrows them
  handover?: FleetDbHandover;          // this main was handed over, pushed or moved out by file; cleared by Cancel or with the record at the rejoin
  receive?: FleetDbReceive;            // this database waits for a push from another machine
  replacedBy?: FleetDbReplaced;        // another database of this bot took over as the main with a higher generation
  mainConflict?: FleetDbConflict;      // another database accepts writes as the main with the same generation
  switchNotice?: FleetDbSwitchNotice;  // the switch-notice sent to the bot for the generation this main holds
  pushBroken?: { at: string; safetyDump: string; copies?: JoinAddress[] }; // a push replaced this database and did not finish; cleared by a finished push or a restore
  formerMain?: FleetDbFormerMain;      // the main this database took over from, with its join code (encrypted at rest)
}

export interface FleetDbFormerMain {
  code: string;
  slot: string;
  machine: string;
  host: string;
  port: number;
  generation: number;
  at: string;
  /** Why N-d cannot check the old main: its certificate or its join code (D56). */
  checkError?: { kind: 'cert' | 'code'; reason: string };
}

export interface FleetDbHandover {
  mode: 'stream' | 'push' | 'file';
  phase: 'waiting' | 'stopped' | 'pushing' | 'done';
  at: string;
  slot?: string;
  machine?: string;
  host?: string;
  port?: number;
  cert?: string;
  generation?: number;
  file?: string;
  lastError?: string;
  rejoinError?: string;
  rejoinTriedAt?: number;
  lastCheck?: string;
}

export interface FleetDbReceive {
  startedAt: string;
  expiresAt: string;
  safetyDump: string;
  /** The id the move code carries and the push's received row names; a new one at every Receive. */
  pushId: string;
  /** The push ids of the earlier codes of this mark (Receive again); a push made with one of them still counts (D53). */
  priorIds?: string[];
  /** The bot database's oid when receiving began: a push that dropped it changes it. */
  dbOid: string;
  /** This machine's copy rows, written back once a push finishes. */
  copies?: JoinAddress[];
}

export interface FleetDbReplaced {
  machine: string;
  host: string;
  port: number;
  generation: number;
  own: number;
  since: string | null;
  at: string;
  cert?: string;
  blockError?: string;
  /** N-g: the replaced main's bot put in Off once it holds nothing it could not save. */
  off?: { state: 'off' | 'held' | 'failed'; held?: MaintenanceHeld; askedAt?: number; at: string; error?: string };
  dm?: OwnerDm;
}

/** The outcome of an owner message (contract 7), kept so a posted one is never sent again. */
export interface OwnerDm {
  key: string;
  state: 'posted' | 'repeat' | 'failed' | 'unknown' | 'unsupported';
  place?: 'channel' | 'dm';
  note?: string;
  error?: string;
  triedAt: number;
}

export interface FleetDbConflict {
  machine: string;
  host: string;
  port: number;
  generation: number;
  at: string;
  cert?: string;
  blockError?: string;
  dm?: OwnerDm;
}

export interface FleetDbSwitchNotice {
  generation: number;
  machine: string;
  since: string | null;
  state: 'pending' | 'sent' | 'already' | 'refused' | 'unknown' | 'unsupported' | 'not-owed';
  triedAt?: number;
  /** The bot's own note and where its copy went (contract 5's answer). */
  note?: string;
  channel?: string;
  /** The bot was not running, so nothing was sent yet. */
  waiting?: boolean;
  error?: string;
}

export interface FleetDbTakeover {
  startedAt: string;
  planned: boolean;
  generation: number;
  inherit?: { file: string; at: string };
  /** Confirmed over an unchecked receive mark, so the raise expires the copy's shard claims (D18). */
  unchecked?: boolean;
}

// Replication posture for the managed sidecar (PLAN_REPLICATION.md Stage 1).
// Present = the database is exposed (published port, TLS required off-host) and
// carries a replication role; every standby mints its own physical slot on it
// (PLAN_REPLICATION 20.19 F1), so no slot is recorded here.
export interface FleetDbReplication {
  role: string;                        // replication login role, e.g. 'replicator'
  password: string;                    // same trust domain as the URL mirror in this registry
  hostPort: number;                    // published host port (container 5432)
  publicHost: string;                  // operator-provided host workers/replicas dial
  certHost: string;                    // host the pinned cert names; differing publicHost forces regeneration
  slotWalKeepMb?: number;              // max_slot_wal_keep_size bound; absent on old records = default applied on next enable
  disablingSince?: string;             // ISO time a Disable began changing the database; leaves with the record once Disable finishes
  keptPlain?: string[];                // addresses Enable left non-TLS access for (a running bot on its old URL); the next start narrows them
}

// Manager-provisioned streaming REPLICA of another machine's fleet database
// (PLAN_REPLICATION.md Stage 2). Lives beside an instance that does not host the database;
// seeded with pg_basebackup, runs as a hot standby, exposed like the primary
// so it can serve the whole fleet after a promotion. The replicator password
// is deliberately NOT retained here - it lives only inside the standby's own
// postgresql.auto.conf after provisioning.
export interface FleetDbReplicaRecord {
  containerName: string;
  volume: string;
  /** App database identity, stamped from the capability record at provisioning.
   * Absent on records stamped before 2026-09-01: readers author/probe nothing
   * for those; retire + re-provision the standby. */
  user?: string;
  db?: string;
  slot: string;                        // slot name on the PRIMARY this standby consumes
  primaryHost: string;                 // primary endpoint (for display/diagnostics)
  primaryPort: number;
  publicHost?: string;                 // this machine's address for other machines; absent when it opens no port
  hostPort?: number;                   // published host port (container 5432); absent with publicHost
  certHost: string;                    // host THIS standby's own server cert names (its container name without an address)
  /** An operator cancelled or dismissed an automatic rebuild: none starts again until the next Re-seed or Provision. */
  autoRebuildHeldAt?: string;
  /** When the copy's last automatic safety dumps were taken (the newest 3): three within 24 hours hold the next rebuild until a Re-seed. */
  rebuildDumps?: number[];
  /** The manager cleared this copy for a re-seed that has not finished: there is nothing to serve, protect or start. */
  copyCleared?: boolean;
  /** When this copy was last built whole. Absent on records stamped before 2026-09-09. */
  seededAt?: number;
  /** The seed that last built this copy whole (its startedAt): the run that asked for that seed reads it back as identity. */
  seededBy?: number;
  /** A Take over that started and has not finished. */
  takeover?: FleetDbTakeover;
}

export type FleetReplicaSeedPurpose = 'provision' | 'reseed-standby' | 'reseed-stale-primary';
export type FleetReplicaSeedPhase = 'preparing' | 'seeding' | 'configuring' | 'starting';

// The standby seed in flight (PLAN_REPLICATION 20.14, B4m-2b). Persisted so a
// manager restart shows the operation instead of losing it; endpoints only,
// never the replication credential, which the seed takes from its intake.
export interface FleetReplicaSeedRecord {
  purpose: FleetReplicaSeedPurpose;
  phase: FleetReplicaSeedPhase;
  startedAt: number;
  updatedAt: number;
  publicHost?: string;
  hostPort?: number;
  primaryHost: string;
  primaryPort: number;
  slot: string;
  /** Past the first irreversible step (the copy cleared, or the stale database retired), so cancelling can no longer restore what was there. */
  committed?: boolean;
  /** No runner owns it any more (it failed, or the manager restarted mid-seed): kept for display until Retry or Dismiss. */
  parked?: boolean;
  /** An operator stopped this run, so nothing may restart it on their behalf. */
  cancelled?: boolean;
  lastError?: string;
  cancelRequested?: boolean;
  /** The stale-primary re-seed's safety dump, taken under the write fence and kept with the backups. */
  safetyDump?: string;
  /** The database env pins a re-seed could not retire after it retired the stale database: Finish retire removes them. */
  pinsUnretired?: string[];
  /** The copy's manager started this rebuild itself. */
  auto?: boolean;
  /** Why an automatic rebuild started: the main no longer kept the copy's place, or the copy was found cleared. */
  rebuildCause?: 'slot' | 'cleared';
}

/** One row of the main's address list (smdb_manager.addresses). slot null is the main's own row. */
export interface JoinAddress {
  host: string;
  port: number;
  slot: string | null;
  cert: string;
  machine: string;
}

// The main this instance joined with a join code. The code itself is a record secret (encrypted at rest); the
// decoded address fields stay readable for display when the key is lost.
export interface FleetJoinRecord {
  code: string;
  host: string;
  port: number;
  db: string;
  fp: string;
  machine: string;
  joinedAt: string;
  /** The main's IDENTIFY_SYSTEM system id, read at the join. */
  systemId?: string;
  /** The other databases the main lists, from its last good read. */
  addresses?: JoinAddress[];
  addressesReadAt?: number;
  addressesError?: string;
}

// Backups of each database the manager holds for the instance. Absent means the defaults (enabled, 04:00):
// hourly dumps, and the daily dump and its test restore at the hour.
export interface FleetBackupConfig {
  enabled: boolean;
  hour: number;
}

/** main: the database this machine holds as the main; copy: its live copy of another machine's main. */
export type BackupFamily = 'main' | 'copy';

export interface FleetBackupTestRecord {
  file: string;
  startedAt: number;
  finishedAt?: number;
  result: 'running' | 'passed' | 'failed' | 'interrupted';
  /** How many manager restarts cut this test short; a second one fails it. */
  cutShort?: number;
  /** The failure reason, plus a cleanup or not-saved note. */
  text?: string;
  tables?: number;
  rows?: number;
}

export interface FleetBackupTests {
  last?: FleetBackupTestRecord;
  /** The newest dump that passed a test restore; the trim never deletes it. */
  lastGood?: string;
}

export interface FleetBackupAlert {
  kind: 'dumps' | 'test' | 'held' | 'stopped' | 'rebuilt';
  text: string;
  since: number;
  dm: 'pending' | 'sent' | 'failed' | 'unknown' | 'unsupported';
  dmAt?: number;
  dmError?: string;
  dmPlace?: 'channel' | 'dm';         // where the bot said it posted (contract 7)
  dmNote?: string;
  dmRepeat?: true;                    // the bot had already posted this key
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
  webContainerPort?: number;           // docker mode: the container port hostPort maps to
  publicUrl?: string;                  // docker remote mode: https URL when routed through the bundled Caddy
  webUiPath?: string;                  // docker mode: web entry path from x-casaos.index, e.g. "/dashboard"
  webAuth?: 'auto' | 'managed' | 'public';   // web-UI auth mode, applies on the next Update or Build; 'auto' detects self-authenticating bots
  fleetDb?: FleetDbRecord;             // manager-provisioned fleet Postgres sidecar
  fleetDbReplica?: FleetDbReplicaRecord; // manager-provisioned standby of another machine's fleet DB
  fleetDbReplicaSeed?: FleetReplicaSeedRecord; // standby seed in flight or parked (B4m-2b); cleared on success, cancel or dismiss
  addressesPush?: { digest: string; state: 'pending' | 'refused' | 'unsupported'; error?: string; at: string }; // a database list offered to the running bot (contract 3), never the value
  fleetDbReplicaKept?: { volume: string; removedAt: string; held: 'standby' | 'promoted' | 'unknown' }; // what the volume Remove replica kept held then; cleared when a seed refiles a standby on it
  fleetDbPinsWarning?: string;         // the last retire of the database env pins could not edit a deployed compose; cleared by a clean retire
  projectVolumes?: string[];          // every {project}_ volume this instance's deployed composes have declared (union over deploys)
  projectVolumesUnverified?: boolean; // a deploy or Remove found its compose unreadable, so projectVolumes may be incomplete
  fleetRestoreError?: { file: string; text: string; at: string; doubt: boolean }; // a restore's notice, the time it was written, and whether it leaves the data in doubt; Running is refused while it stands
  fleetBackup?: FleetBackupConfig;     // backup schedule; absent = defaults
  fleetBackupTests?: Partial<Record<BackupFamily, FleetBackupTests>>; // the daily test restore of each family
  fleetBackupAlerts?: Record<string, FleetBackupAlert>; // standing backup alerts by <family>:<dumps|test>
  fleetBackupStarts?: Partial<Record<BackupFamily, number>>; // when the scheduler first found each family to back up
  fleetJoin?: FleetJoinRecord;         // the main this instance joined with a join code
  fleetCopyAlerts?: Record<string, FleetBackupAlert>; // the owner's messages about this machine's copy, by held|stopped|rebuilt

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
  pendingApply?: boolean;              // a build finished while the project ran; Start (in place) or Restart applies it
  lane?: InstanceLane | null;          // a destructive lane in flight or cut short; null in a browser copy once cleared
  maintenance?: MaintenanceRecord | null; // the operator's state order; absent = Running, settled; null in a browser copy
  migrate?: MigrateRecord | null;      // an open data migration; absent = none; null in a browser copy
  migrateLast?: MigrateLast | null;    // the last migration's outcome

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

export type BotRunState = 'running' | 'maintenance' | 'off';

export type MaintenanceHeld =
  | { state: 'yes' | 'unknown' | 'stopped' | 'not-running'; note?: string }
  | { state: 'no'; guilds: number; files: number; note?: string };

export interface MaintenanceRecord {
  state: BotRunState;
  message: string;                    // '' = the bot's default text
  orderedAt: string;
  settled: boolean;                   // every step the order needs is confirmed
  hook: 'confirmed' | 'unconfirmed' | 'missing' | 'none';
  login: 'blocked' | 'open' | 'unconfirmed' | 'not-managed';
  savedByBot: 'running' | 'maintenance' | null; // the last state the bot confirmed saving, across orders
  held?: MaintenanceHeld;             // what the bot answered about the changes it holds in memory (contract 1's saved)
  prior?: { state: BotRunState; message: string };
  lastError?: string;                 // why the order is not settled, or the warning a settled order carries
}

export type MigrateTo = 'postgres' | 'file';
export type MigratePhase = 'preparing' | 'posting' | 'following' | 'finishing' | 'closing' | 'waiting';

export interface MigrateRecord {
  to: MigrateTo;
  from: MigrateTo;                    // the stored DATA_BACKEND when the record opened
  destination: string | null;         // to postgres: host:port/db of the database the copy goes to (no credentials)
  companion: boolean;                 // to postgres onto this bot's managed database
  jobId: string;                      // the job the manager posts or follows
  jobIds: string[];                   // every jobId this record POSTed or followed
  posted: boolean;                    // a POST may have reached the bot, or the record follows a job; never cleared
  started: number;                    // POSTs answered 'started' since the operator's last press (cap 3)
  kept: number;                       // POSTs sent by the keep rule since the last press (bound 5)
  phase: MigratePhase;
  resumeAt?: Exclude<MigratePhase, 'waiting'>; // where a 'waiting' record goes on at the operator's press
  awaiting?: 'destination';           // the Database URL may change until the next press
  finishing?: 'stored' | 'applied' | 'confirmed';
  stage?: string;                     // the bot's last stage
  loginOpened: boolean;               // the manager opened a blocked login for this record
  hbaFence?: string;                  // the owner (migrate:<ms>) of the pg_hba lines the step of M5 and B35 (isolate) set on the bot's own managed database; lifted at F, G and a Delete that keeps the data
  hbaFenceSet?: true;                 // the full write of those lines stood once; until then each write is a full one
  fenceLift?: 'stripped' | 'unconfirmed'; // G21's lift left the file clean without a confirmed reload; read by the done text
  isolated?: true;                    // M5 and B35 ran to their end on this record; no POST of a move to file from Postgres goes out without it
  adoptedJob?: string;                // the job a press adopted (A29), written in the record's first write and never dropped; copyOpenOf reads it to set copyOpen, which the done text reads (G24)
  copyOpen?: 'open' | 'unsure';       // G24, G25: the copy that finished was started by the bot itself, with no line of this record (open) or after its step began without finishing (unsure); written in done()'s finishing write
  sharers: string[];                  // other instances on the source database; their Start, Build and Update refuse while the record is open
  sharersStopped: string[];           // the sharers M5 itself stopped, each id written before its stop; F5 starts only these
  openedAt: string;
  text?: string;                      // the progress line, or the reason it waits
}

export interface MigrateLast { to: MigrateTo; outcome: 'done' | 'failed'; jobId: string | null; text: string; at: string }

/**
 * Written before a lane's first destructive step. An update, restart or build
 * clears it when it succeeds, as does a successful Start or Stop; a delete's
 * stands until the record itself is removed. Boot marks a standing one interrupted.
 */
export interface InstanceLane {
  op: 'update' | 'restart' | 'build' | 'delete';
  wasRunning: boolean;
  keepData?: boolean;
  startedAt: string;
  interrupted?: boolean;
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
  tokenVarUnchecked?: { scanned: number; total: number };   // the fallback guess came from a source scan that stopped at its file cap
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
  service?: string;             // the compose service that binds it, when found from a compose bind
  gatewayService?: string;      // set when that service is a fronting gateway a deploy may drop
}

// ─── Docker ───

export interface ContainerInfo {
  id: string;
  name: string;
  state: string;
  status: string;
  ports: PortBinding[];
  /** com.docker.compose.project label; absent on plain docker-run containers. */
  project?: string;
  /** bot-id ownership label; absent on containers from before it was stamped. */
  botId?: string;
  /** com.docker.compose.service label. */
  service?: string;
}

export interface PortBinding {
  containerPort: number;
  hostPort: number;
  protocol: string;
}

export interface LogEntry {
  timestamp: string | null;
  message: string;
  stream: 'stdout' | 'stderr';
}

// ─── API ───

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
