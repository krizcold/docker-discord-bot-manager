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
  webContainerPort?: number;           // docker mode: the container port hostPort maps to
  publicUrl?: string;                  // docker remote mode: https URL when routed through the bundled Caddy
  webUiPath?: string;                  // docker mode: web entry path from x-casaos.index, e.g. "/dashboard"
  webAuth?: 'auto' | 'managed' | 'public';   // web-UI auth mode, applies on next start; 'auto' detects self-authenticating bots

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
