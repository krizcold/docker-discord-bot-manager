/**
 * Discord Bot Manager Types
 * Phase 5: Source/Instance Architecture
 */

// ─── Enums / Literals ───

export type BotType = 'nodejs' | 'python' | 'go' | 'java' | 'dockerfile' | 'compose' | 'unknown';
export type DeploymentMode = 'casaos' | 'docker';
export type BotStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error' | 'building';
export type BotSourceType = 'git' | 'docker-image';

// ─── Source ───

export interface SourceMeta {
  id: string;
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
  sourceId: string | null;             // FK to SourceMeta.id (null for docker-image or orphaned)
  sourceUrl: string | null;            // Stored for re-association after source deletion

  sourceType: BotSourceType;           // 'git' | 'docker-image'
  imageRef?: string;                   // For docker-image source only

  // Three name layers
  displayName: string;                 // "My Custom Bot!" — user's raw input
  sanitizedName: string;               // "mycustombot" — compose name, folders, Caddy labels
  titleName: string;                   // "My Custom Bot" — x-casaos.title

  /** @deprecated Use displayName. Kept for backward compat with compose/pcsProcessing templates. */
  name?: string;

  status: BotStatus;
  containerIds: string[];

  // Authentication tokens
  updateToken?: string;
  authHash?: string;

  // Runtime
  envVars?: Record<string, string>;
  port?: number;

  // Detection (for git source)
  botType?: BotType;
  hasDatabase?: boolean;

  // Lifecycle
  hasBeenStarted?: boolean;

  // Commit tracking
  lastBuiltCommit: string | null;      // SHA at time of last buildBot()

  // Instance auto-update (independent from source auto-update)
  autoUpdate?: boolean;                // default false — auto-rebuild when source has new commits
  autoUpdateInterval?: number;         // milliseconds between checks, default 86400000 (24 hours)
  autoUpdateHour?: number;             // 0-23, preferred hour for daily checks, default 4 (4am)

  // CasaOS app name (== sanitizedName for new instances, preserved for migrated)
  appName?: string;

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
  'homeassistant', 'pcs',
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
  reuseFromInstanceId?: string;       // Previous instance ID to copy credentials from
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

/** @deprecated Use CreateInstanceRequest or CreateDockerImageInstanceRequest */
export interface CreateBotRequest {
  name: string;
  sourceType?: BotSourceType;
  url?: string;
  branch?: string;
  imageRef?: string;
  envVars?: Record<string, string>;
}

/** @deprecated Use UpdateInstanceRequest */
export interface UpdateBotRequest {
  name?: string;
  branch?: string;
  envVars?: Record<string, string>;
  autoUpdate?: boolean;
}

// ─── Detection ───

export interface DetectionResult {
  type: BotType;
  hasDockerfile: boolean;
  hasCompose: boolean;
  hasDatabase: boolean;
  entryPoint?: string;
  packageManager?: 'npm' | 'yarn' | 'pnpm' | 'pip' | 'poetry' | 'go' | 'maven' | 'gradle';
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
