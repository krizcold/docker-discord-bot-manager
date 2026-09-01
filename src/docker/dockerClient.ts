/**
 * Docker Client Wrapper
 * Uses Docker CLI for cross-platform compatibility
 */

import { execFile, execFileSync, execSync, spawn } from 'child_process';
import { promisify } from 'util';
import { ContainerInfo, LogEntry } from '../types';
import { createLineHandler, DockerLogFn } from './outputStream';

const execFileAsync = promisify(execFile);

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
 * Async variant of execDocker; keeps op paths from blocking the event loop.
 */
async function execDockerAsync(args: string[], options: { timeout?: number } = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync('docker', args, {
      encoding: 'utf8',
      timeout: options.timeout || 30000
    });
    return stdout.trim();
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
 * Check if the docker CLI buildx plugin is available (required to drive BuildKit
 * for Dockerfiles using `RUN --mount=...`). The plugin is bundled in the manager
 * image; this guards hosts/images where it is somehow absent.
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
 * Host ports currently published by any container (`0.0.0.0:18080->...`,
 * `127.0.0.1:18080->...`, `:::18080->...`), keyed to the publishing container
 * names. Used to avoid colliding when auto-assigning a bot's host port in
 * docker mode; the names let a bot's own published ports be excluded.
 */
export function listPublishedHostPorts(): Map<number, string[]> {
  const ports = new Map<number, string[]>();
  try {
    const output = execDocker(['ps', '-a', '--format', '{{.Names}}|{{.Ports}}'], { timeout: 10000 });
    for (const line of output.split('\n')) {
      const sep = line.indexOf('|');
      if (sep < 0) continue;
      const name = line.slice(0, sep);
      for (const m of line.slice(sep + 1).matchAll(/:(\d+)->/g)) {
        const n = parseInt(m[1], 10);
        if (isNaN(n)) continue;
        const names = ports.get(n);
        if (names) names.push(name);
        else ports.set(n, [name]);
      }
    }
  } catch {
    // Best effort; an empty map just means no collision avoidance this round.
  }
  return ports;
}

/**
 * Create a new container for a bot
 */
export async function createBotContainer(
  botId: string,
  imageName: string,
  envVars: Record<string, string> = {},
  dataPath?: string,
  dataTarget: string = '/app/data',
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

  // Add volume binding (target defaults to /app/data; docker-image bots use the
  // image's real data path, e.g. /data for Red-DiscordBot).
  if (dataPath) {
    args.push('-v', `${dataPath}:${dataTarget}`);
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
export async function imageExists(imageName: string): Promise<boolean> {
  try {
    await execDockerAsync(['image', 'inspect', imageName]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read an image's declared environment variables (Config.Env) without running it.
 * Returns the raw "KEY=value" lines, or null if the image is absent or inspect fails.
 */
export function inspectImageEnv(imageName: string): string[] | null {
  try {
    const out = execDocker(['inspect', '--format', '{{json .Config.Env}}', imageName]);
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed.filter((x: unknown): x is string => typeof x === 'string') : null;
  } catch {
    return null;
  }
}

/**
 * Read an image's declared VOLUME mount points (Config.Volumes). Returns the
 * volume paths (e.g. ['/data']), [] when none are declared, or null when the
 * image is absent or inspect fails.
 */
export function inspectImageVolumes(imageName: string): string[] | null {
  try {
    const out = execDocker(['inspect', '--format', '{{json .Config.Volumes}}', imageName]);
    const parsed = JSON.parse(out);
    return parsed && typeof parsed === 'object' ? Object.keys(parsed) : [];
  } catch {
    return null;
  }
}

/**
 * Remove a Docker image
 */
export async function removeImage(imageName: string): Promise<boolean> {
  try {
    await execDockerAsync(['rmi', imageName]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a Docker image from a Dockerfile
 */
export async function buildImage(
  contextPath: string,
  imageName: string,
  onProgress?: DockerLogFn,
  buildArgs?: Record<string, string>,
  dockerfilePath?: string
): Promise<void> {
  const args = ['build', '-t', imageName];
  if (dockerfilePath) {
    args.push('-f', dockerfilePath);
  }
  if (buildArgs) {
    for (const [key, value] of Object.entries(buildArgs)) {
      args.push('--build-arg', `${key}=${value}`);
    }
  }
  args.push(contextPath);

  console.log(`[Docker] Building image: docker ${args.join(' ')}`);

  return new Promise((resolve, reject) => {
    // BuildKit is required for Dockerfiles using `RUN --mount=...`, and needs the
    // buildx CLI plugin (bundled in the manager image). When it's absent, fall
    // back to the legacy builder so plain Dockerfiles still build.
    const env = { ...process.env };
    if (isBuildxAvailable()) {
      env.DOCKER_BUILDKIT = '1';
    }

    const child = spawn('docker', args, { env });

    const out = createLineHandler((line, key) => onProgress?.(line, key));
    const err = createLineHandler((line, key) => onProgress?.(line, key));
    child.stdout.on('data', out.data);
    child.stderr.on('data', err.data);

    child.on('close', (code) => {
      out.flush();
      err.flush();
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

    child.on('error', (err2) => {
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();
      reject(err2);
    });
  });
}

/**
 * Pull an image from Docker Hub or other registry
 */
export async function pullImage(
  imageName: string,
  onProgress?: DockerLogFn
): Promise<void> {
  const args = ['pull', imageName];

  console.log(`[Docker] Pulling image: ${imageName}`);

  return new Promise((resolve, reject) => {
    const child = spawn('docker', args);

    const out = createLineHandler((line, key) => onProgress?.(line, key));
    const err = createLineHandler((line, key) => onProgress?.(line, key));
    child.stdout.on('data', out.data);
    child.stderr.on('data', err.data);

    child.on('close', (code) => {
      out.flush();
      err.flush();
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

    child.on('error', (err2) => {
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();
      reject(err2);
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
 * Remove a Docker volume by name. A volume PROVEN absent counts as removed
 * (a retry after a partial teardown must not fail on the step a previous
 * attempt completed), but absence must come from docker saying "no such
 * volume": a daemon that cannot answer reads as failure, or a teardown
 * would report success over a surviving volume.
 */
export function removeVolume(name: string): boolean {
  if (execDockerSafe(['volume', 'rm', name])) return true;
  try {
    execDocker(['volume', 'inspect', name]);
    return false;
  } catch (err) {
    return String((err as Error)?.message || err).toLowerCase().includes('no such volume');
  }
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
 * Run docker compose up. Defaults to deploying pre-built images (no --build); the
 * manager pre-builds images and rewrites build: -> image: before deploy, and a
 * --build here would mis-resolve relative build contexts against the compose dir.
 */
export async function composeUp(
  composePath: string,
  projectName: string,
  onProgress?: DockerLogFn,
  opts: { build?: boolean } = {}
): Promise<void> {
  const args = ['compose', '-f', composePath, '-p', projectName, 'up', '-d', '--remove-orphans'];
  if (opts.build) args.push('--build');

  console.log(`[Docker] Running: docker ${args.join(' ')}`);

  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (opts.build && isBuildxAvailable()) {
      env.DOCKER_BUILDKIT = '1';
    }

    const child = spawn('docker', args, { env });

    const onLine: DockerLogFn = (line, key) => {
      console.log(`[Compose] ${line}`);
      onProgress?.(line, key);
    };
    const out = createLineHandler(onLine);
    const err = createLineHandler(onLine);
    child.stdout.on('data', out.data);
    child.stderr.on('data', err.data);

    child.on('close', (code) => {
      out.flush();
      err.flush();
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

    child.on('error', (err2) => {
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();
      reject(err2);
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
  await execDockerAsync(args, { timeout: 60000 });
}

/**
 * List all containers of a compose project without blocking the event loop.
 * The label filter is authoritative; the name substring fallback runs only when
 * the label query itself fails (docker's name= filter matches substrings, so an
 * empty label result must NOT trigger it or stopped bots would list foreign
 * containers).
 */
export async function listProjectContainers(
  projectName: string
): Promise<Array<{ name: string; state: string; status: string }>> {
  const format = '{{.Names}}\t{{.State}}\t{{.Status}}';
  let output = '';
  try {
    output = await execDockerAsync(
      ['ps', '-a', '--filter', `label=com.docker.compose.project=${projectName}`, '--format', format],
      { timeout: 10000 }
    );
  } catch {
    try {
      output = await execDockerAsync(
        ['ps', '-a', '--filter', `name=${projectName}`, '--format', format],
        { timeout: 10000 }
      );
    } catch {
      output = '';
    }
  }
  return output
    .split('\n')
    .filter(line => line.trim())
    .map(line => {
      const [name, state, status] = line.split('\t');
      return { name, state: state || 'unknown', status: status || '' };
    });
}
