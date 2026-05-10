/**
 * Docker Client Wrapper
 * Uses Docker CLI for cross-platform compatibility
 */

import { execFileSync, execSync, spawn } from 'child_process';
import { ContainerInfo, LogEntry } from '../types';

/**
 * Execute a docker command and return stdout
 * Uses execFileSync to avoid shell escaping issues on Windows
 */
function execDocker(args: string[], options: { timeout?: number } = {}): string {
  try {
    return execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: options.timeout || 30000
    }).trim();
  } catch (error: any) {
    if (error.stderr) {
      throw new Error(`Docker command failed: ${error.stderr.toString()}`);
    }
    throw error;
  }
}

/**
 * Execute a docker command, return true if successful
 */
function execDockerSafe(args: string[], options: { timeout?: number } = {}): boolean {
  try {
    execDocker(args, options);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if Docker daemon is accessible
 */
export async function checkDockerConnection(): Promise<boolean> {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch (error) {
    console.error('[Docker] Connection failed:', error);
    return false;
  }
}

/**
 * Check if Docker buildx is available for BuildKit support
 */
export function isBuildxAvailable(): boolean {
  try {
    execSync('docker buildx version', { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * List all bot containers managed by this application
 */
export async function listBotContainers(): Promise<ContainerInfo[]> {
  try {
    const output = execDocker([
      'ps', '-a',
      '--filter', 'label=managed-by=discord-bot-manager',
      '--format', '{{.ID}}|{{.Names}}|{{.State}}|{{.Status}}'
    ]);

    if (!output) return [];

    return output.split('\n').filter(line => line.trim()).map(line => {
      const [id, name, state, status] = line.split('|');
      return {
        id,
        name,
        state,
        status,
        ports: []
      };
    });
  } catch (error) {
    console.error('[Docker] Failed to list containers:', error);
    return [];
  }
}

/**
 * List containers for a specific bot by bot-id label
 */
export async function listContainersByBotId(botId: string): Promise<ContainerInfo[]> {
  try {
    const output = execDocker([
      'ps', '-a',
      '--filter', 'label=managed-by=discord-bot-manager',
      '--filter', `label=bot-id=${botId}`,
      '--format', '{{.ID}}|{{.Names}}|{{.State}}|{{.Status}}'
    ]);

    if (!output) return [];

    return output.split('\n').filter(line => line.trim()).map(line => {
      const [id, name, state, status] = line.split('|');
      return {
        id,
        name,
        state,
        status,
        ports: []
      };
    });
  } catch (error) {
    console.error(`[Docker] Failed to list containers for bot ${botId}:`, error);
    return [];
  }
}

/**
 * Create a new container for a bot
 */
export async function createBotContainer(
  botId: string,
  imageName: string,
  envVars: Record<string, string> = {},
  dataPath?: string,
  botName?: string
): Promise<string> {
  const args = [
    'create',
    '--name', `bot-${botId}`,
    '--restart', 'unless-stopped',
    '--memory', '512m',
    '--cpus', '0.5',
    '--label', 'managed-by=discord-bot-manager',
    '--label', `bot-id=${botId}`,
    '--label', `bot-name=${botName || ''}`
  ];

  // Add environment variables
  for (const [key, value] of Object.entries(envVars)) {
    args.push('-e', `${key}=${value}`);
  }

  // Add volume binding
  if (dataPath) {
    args.push('-v', `${dataPath}:/app/data`);
  }

  args.push(imageName);

  const containerId = execDocker(args);
  return containerId;
}

/**
 * Start a container and verify it's actually running. Just running
 * `docker start` and exiting on success is a false-positive: containers
 * frequently exit immediately after start (bad command, missing env, port
 * collision) and `docker start` still returns 0 because it succeeded in
 * issuing the start command.
 */
export async function startContainer(containerId: string, verifyTimeoutMs = 5000): Promise<void> {
  execDocker(['start', containerId]);
  const ok = await waitForContainerRunning(containerId, verifyTimeoutMs);
  if (!ok) {
    // Pull the latest state so the error message tells the operator what
    // happened (exited with code N, dead, etc.) rather than just "didn't
    // run". Fall through to the throw if inspect fails too.
    let stateInfo = 'unknown';
    try {
      stateInfo = execDocker(['inspect', '--format', '{{.State.Status}} (exit={{.State.ExitCode}})', containerId]).trim();
    } catch { /* ignore */ }
    throw new Error(`Container ${containerId} did not reach 'running' state within ${verifyTimeoutMs}ms; current state: ${stateInfo}`);
  }
}

/**
 * Poll `docker inspect` until the container state is 'running', or the
 * timeout elapses. Returns true on success, false if the container is in
 * any non-running state (exited, dead, created, etc.) when time runs out.
 *
 * Used after start / compose up to confirm the container actually came
 * up and stayed up rather than crash-looping out of the gate.
 */
export async function waitForContainerRunning(containerId: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = execDocker(['inspect', '--format', '{{.State.Status}}', containerId]).trim();
      if (state === 'running') return true;
      // 'exited', 'dead', 'restarting' etc. are terminal-ish; keep polling
      // briefly in case of restart loops, but most failures stay failed.
    } catch { /* container not yet visible to inspect; retry */ }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

/**
 * Verify every container in a compose project reaches 'running' state
 * within the timeout. Returns { allRunning: boolean, problems: string[] }
 * where problems is a per-container list like
 * `["myapp-worker: exited (Exited (1) 2 seconds ago)"]`.
 *
 * Compose-up reports exit code 0 the moment the API call succeeds, even
 * if a container immediately crashes on init. This is the post-condition
 * check that closes that gap.
 */
export async function verifyComposeProjectRunning(
  appName: string,
  timeoutMs = 5000,
): Promise<{ allRunning: boolean; problems: string[] }> {
  const deadline = Date.now() + timeoutMs;
  let lastProblems: string[] = ['no containers found yet'];
  while (Date.now() < deadline) {
    try {
      const output = execDocker([
        'ps', '-a',
        '--filter', `label=com.docker.compose.project=${appName}`,
        '--format', '{{.Names}}|{{.State}}|{{.Status}}',
      ]);
      const lines = (output || '').split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length === 0) {
        lastProblems = ['no containers found in compose project'];
      } else {
        const problems = lines
          .map(l => l.split('|'))
          .filter(parts => parts[1] !== 'running')
          .map(([name, state, status]) => `${name}: ${state} (${status})`);
        if (problems.length === 0) return { allRunning: true, problems: [] };
        lastProblems = problems;
      }
    } catch { /* docker call hiccup; retry */ }
    await new Promise(r => setTimeout(r, 200));
  }
  return { allRunning: false, problems: lastProblems };
}

/**
 * Stop a container
 */
export async function stopContainer(containerId: string, timeout = 10): Promise<void> {
  execDocker(['stop', '-t', String(timeout), containerId], { timeout: (timeout + 5) * 1000 });
}

/**
 * Remove a container
 */
export async function removeContainer(containerId: string, force = false): Promise<void> {
  const args = ['rm', '-v'];
  if (force) args.push('-f');
  args.push(containerId);
  execDocker(args);
}

/**
 * Get container logs
 */
export async function getContainerLogs(
  containerId: string,
  tail = 100
): Promise<LogEntry[]> {
  try {
    const output = execDocker(['logs', '--tail', String(tail), '--timestamps', containerId]);

    if (!output) return [];

    return output.split('\n').filter(line => line.trim()).map(line => {
      const timestampMatch = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s(.*)$/);

      if (timestampMatch) {
        return {
          timestamp: timestampMatch[1],
          message: timestampMatch[2],
          stream: 'stdout' as const
        };
      }

      return {
        timestamp: new Date().toISOString(),
        message: line,
        stream: 'stdout' as const
      };
    });
  } catch {
    return [];
  }
}

/**
 * Stream container logs via callback
 */
export async function streamContainerLogs(
  containerId: string,
  onLog: (entry: LogEntry) => void,
  onError?: (error: Error) => void
): Promise<() => void> {
  const child = spawn('docker', ['logs', '-f', '--timestamps', containerId]);

  const processLog = (data: Buffer, stream: 'stdout' | 'stderr') => {
    const lines = data.toString('utf-8').split('\n').filter(l => l.trim());
    for (const line of lines) {
      const timestampMatch = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s(.*)$/);
      onLog({
        timestamp: timestampMatch?.[1] || new Date().toISOString(),
        message: timestampMatch?.[2] || line,
        stream
      });
    }
  };

  child.stdout.on('data', (data) => processLog(data, 'stdout'));
  child.stderr.on('data', (data) => processLog(data, 'stderr'));

  if (onError) {
    child.on('error', onError);
  }

  return () => {
    child.kill();
  };
}

/**
 * Check if a Docker image exists locally
 */
export function imageExists(imageName: string): boolean {
  return execDockerSafe(['image', 'inspect', imageName]);
}

/**
 * Remove a Docker image
 */
export function removeImage(imageName: string): boolean {
  return execDockerSafe(['rmi', imageName]);
}

/**
 * Build a Docker image from a Dockerfile
 */
export async function buildImage(
  contextPath: string,
  imageName: string,
  onProgress?: (message: string) => void,
  buildArgs?: Record<string, string>
): Promise<void> {
  const args = ['build', '-t', imageName];
  if (buildArgs) {
    for (const [key, value] of Object.entries(buildArgs)) {
      args.push('--build-arg', `${key}=${value}`);
    }
  }
  args.push(contextPath);

  console.log(`[Docker] Building image: docker ${args.join(' ')}`);

  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (isBuildxAvailable()) {
      env.DOCKER_BUILDKIT = '1';
      console.log('[Docker] BuildKit enabled');
    }

    const child = spawn('docker', args, { env });

    const processLog = (data: Buffer) => {
      const lines = data.toString().split(/[\r\n]+/);
      lines.forEach(line => {
        if (!line.trim()) return;
        if (onProgress) {
          onProgress(line);
        }
      });
    };

    child.stdout.on('data', processLog);
    child.stderr.on('data', processLog);

    child.on('close', (code) => {
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();

      if (code === 0) {
        console.log(`[Docker] Build completed: ${imageName}`);
        resolve();
      } else {
        reject(new Error(`Docker build failed with exit code ${code}`));
      }
    });

    child.on('error', (err) => {
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();
      reject(err);
    });
  });
}

/**
 * Pull an image from Docker Hub or other registry
 */
export async function pullImage(
  imageName: string,
  onProgress?: (message: string) => void
): Promise<void> {
  const args = ['pull', imageName];

  console.log(`[Docker] Pulling image: ${imageName}`);

  return new Promise((resolve, reject) => {
    const child = spawn('docker', args);

    const processLog = (data: Buffer) => {
      const lines = data.toString().split(/[\r\n]+/);
      lines.forEach(line => {
        if (!line.trim()) return;
        if (onProgress) {
          onProgress(line);
        }
      });
    };

    child.stdout.on('data', processLog);
    child.stderr.on('data', processLog);

    child.on('close', (code) => {
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();

      if (code === 0) {
        console.log(`[Docker] Pull completed: ${imageName}`);
        resolve();
      } else {
        reject(new Error(`Docker pull failed with exit code ${code}`));
      }
    });

    child.on('error', (err) => {
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();
      reject(err);
    });
  });
}

/**
 * Get container stats (CPU, memory usage)
 */
export async function getContainerStats(containerId: string): Promise<{
  cpuPercent: number;
  memoryUsageMB: number;
  memoryLimitMB: number;
}> {
  try {
    const output = execDocker([
      'stats', '--no-stream',
      '--format', '{{.CPUPerc}}|{{.MemUsage}}',
      containerId
    ]);

    const [cpuStr, memStr] = output.split('|');

    // Parse CPU percentage (e.g., "0.50%")
    const cpuPercent = parseFloat(cpuStr.replace('%', '')) || 0;

    // Parse memory (e.g., "50MiB / 512MiB")
    const memMatch = memStr.match(/([\d.]+)(\w+)\s*\/\s*([\d.]+)(\w+)/);
    let memoryUsageMB = 0;
    let memoryLimitMB = 0;

    if (memMatch) {
      const usage = parseFloat(memMatch[1]);
      const usageUnit = memMatch[2];
      const limit = parseFloat(memMatch[3]);
      const limitUnit = memMatch[4];

      memoryUsageMB = usageUnit.includes('G') ? usage * 1024 : usage;
      memoryLimitMB = limitUnit.includes('G') ? limit * 1024 : limit;
    }

    return {
      cpuPercent: Math.round(cpuPercent * 100) / 100,
      memoryUsageMB: Math.round(memoryUsageMB * 100) / 100,
      memoryLimitMB: Math.round(memoryLimitMB * 100) / 100
    };
  } catch {
    return { cpuPercent: 0, memoryUsageMB: 0, memoryLimitMB: 0 };
  }
}

/**
 * Remove a Docker volume by name
 */
export function removeVolume(name: string): boolean {
  return execDockerSafe(['volume', 'rm', name]);
}

/**
 * List volumes belonging to a compose project
 * Docker compose names volumes as {projectName}_{volumeName}
 */
export function listProjectVolumes(projectName: string): string[] {
  try {
    const output = execDocker([
      'volume', 'ls',
      '--filter', `name=${projectName}_`,
      '--format', '{{.Name}}'
    ]);
    if (!output) return [];
    return output.split('\n').filter(line => line.trim());
  } catch {
    return [];
  }
}

/**
 * Run docker compose up
 */
export async function composeUp(
  composePath: string,
  projectName: string,
  onProgress?: (message: string) => void
): Promise<void> {
  const args = ['compose', '-f', composePath, '-p', projectName, 'up', '-d', '--build'];

  console.log(`[Docker] Running: docker ${args.join(' ')}`);

  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (isBuildxAvailable()) {
      env.DOCKER_BUILDKIT = '1';
    }

    const child = spawn('docker', args, { env });

    const processLog = (data: Buffer) => {
      const lines = data.toString().split(/[\r\n]+/);
      lines.forEach(line => {
        if (!line.trim()) return;
        console.log(`[Compose] ${line}`);
        if (onProgress) {
          onProgress(line);
        }
      });
    };

    child.stdout.on('data', processLog);
    child.stderr.on('data', processLog);

    child.on('close', (code) => {
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();

      if (code === 0) {
        console.log(`[Docker] Compose up completed: ${projectName}`);
        resolve();
      } else {
        reject(new Error(`Docker compose up failed with exit code ${code}`));
      }
    });

    child.on('error', (err) => {
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();
      reject(err);
    });
  });
}

/**
 * Run docker compose down
 */
export async function composeDown(
  composePath: string,
  projectName: string
): Promise<void> {
  const args = ['compose', '-f', composePath, '-p', projectName, 'down'];
  execDocker(args, { timeout: 60000 });
}
