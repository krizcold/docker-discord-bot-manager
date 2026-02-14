/**
 * Discord Bot Manager Types
 */

export type BotType = 'nodejs' | 'python' | 'go' | 'java' | 'dockerfile' | 'compose' | 'unknown';
export type DeploymentMode = 'casaos' | 'docker';
export type BotStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error' | 'building';
export type BotSourceType = 'git' | 'docker-image';

export interface BotConfig {
  id: string;
  name: string;
  sourceType: BotSourceType;

  // For git source (URL includes token if private: https://TOKEN@github.com/...)
  url?: string;
  branch?: string;

  // For docker-image source
  imageRef?: string;

  // Common
  status: BotStatus;
  containerIds: string[];

  // Tokens (Yundera-style)
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

  // Metadata
  createdAt: string;
  updatedAt: string;
}

export interface BotRegistry {
  bots: Record<string, BotConfig>;
  deploymentMode?: DeploymentMode;
}

export interface DetectionResult {
  type: BotType;
  hasDockerfile: boolean;
  hasCompose: boolean;
  hasDatabase: boolean;
  entryPoint?: string;
  packageManager?: 'npm' | 'yarn' | 'pnpm' | 'pip' | 'poetry' | 'go' | 'maven' | 'gradle';
}

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

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface CreateBotRequest {
  name: string;
  sourceType?: BotSourceType;

  // For git source (URL includes token if private: https://TOKEN@github.com/...)
  url?: string;
  branch?: string;

  // For docker-image source
  imageRef?: string;

  // Common
  envVars?: Record<string, string>;
}

export interface UpdateBotRequest {
  name?: string;
  branch?: string;
  envVars?: Record<string, string>;
}
