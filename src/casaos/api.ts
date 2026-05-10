/**
 * CasaOS API
 * Wrapper for CasaOS container management API (via docker exec)
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { verifyComposeProjectRunning } from '../docker/dockerClient';

const execAsync = promisify(exec);

interface CasaOSApp {
  name: string;
  status: string;
  containers: string[];
}

/**
 * Execute a curl command inside the CasaOS container
 */
async function casaosRequest(
  method: string,
  endpoint: string,
  body?: unknown
): Promise<unknown> {
  // -s silences progress, -f makes curl exit non-zero on HTTP >=400 so
  // execAsync rejects (instead of "successfully" returning an error body
  // that we then JSON.parse as "success"). Without -f, a 4xx/5xx response
  // would be swallowed: the curl exits 0, we parse the body, and callers
  // see what looks like a successful response.
  const curlCmd = body
    ? `curl -sf -X ${method} -H "Content-Type: application/json" -d '${JSON.stringify(body)}' "http://localhost:8080${endpoint}"`
    : `curl -sf -X ${method} "http://localhost:8080${endpoint}"`;

  const dockerCmd = `docker exec casaos sh -c '${curlCmd}'`;

  try {
    const { stdout, stderr } = await execAsync(dockerCmd, { timeout: 30000 });
    if (stderr) {
      console.error('[CasaOS API] stderr:', stderr);
    }
    // CasaOS may return 200 with an empty body on no-content endpoints;
    // treat that as "no payload" rather than parse failure.
    if (!stdout || stdout.trim() === '') return null;
    return JSON.parse(stdout);
  } catch (error) {
    console.error('[CasaOS API] Request failed:', error);
    throw error;
  }
}

/**
 * Inspect a CasaOS response object for explicit error markers. Even with
 * curl -f, CasaOS sometimes returns 200 with a body like
 * `{ status: "error", message: "..." }` for no-op or partial-failure cases.
 * Throwing here surfaces those instead of silently treating the request as
 * successful.
 */
function rejectIfErrorEnvelope(response: unknown, context: string): void {
  if (!response || typeof response !== 'object') return;
  const r = response as Record<string, unknown>;
  if (r.error) {
    throw new Error(`CasaOS ${context}: ${typeof r.error === 'string' ? r.error : JSON.stringify(r.error)}`);
  }
  if (r.status === 'error') {
    throw new Error(`CasaOS ${context}: ${typeof r.message === 'string' ? r.message : JSON.stringify(r)}`);
  }
}

/**
 * List all compose apps
 */
export async function listApps(): Promise<CasaOSApp[]> {
  try {
    const response = await casaosRequest('GET', '/v2/app_management/compose') as { data?: CasaOSApp[] };
    return response.data || [];
  } catch (error) {
    console.error('[CasaOS API] Failed to list apps:', error);
    return [];
  }
}

/**
 * Start a compose app
 */
export async function startApp(appName: string): Promise<boolean> {
  try {
    const response = await casaosRequest('POST', `/v2/app_management/compose/${appName}/start`);
    rejectIfErrorEnvelope(response, `start ${appName}`);
    console.log(`[CasaOS API] Started app: ${appName}`);
    return true;
  } catch (error) {
    console.error(`[CasaOS API] Failed to start app ${appName}:`, error);
    return false;
  }
}

/**
 * Stop a compose app
 */
export async function stopApp(appName: string): Promise<boolean> {
  try {
    const response = await casaosRequest('POST', `/v2/app_management/compose/${appName}/stop`);
    rejectIfErrorEnvelope(response, `stop ${appName}`);
    console.log(`[CasaOS API] Stopped app: ${appName}`);
    return true;
  } catch (error) {
    console.error(`[CasaOS API] Failed to stop app ${appName}:`, error);
    return false;
  }
}

/**
 * Uninstall a compose app. After the API call returns, verify the app is
 * actually gone from the CasaOS app list. CasaOS occasionally returns 200
 * for an uninstall that didn't fully complete (e.g. partial container
 * removal); without the listApps probe we'd report success with the app
 * still registered.
 */
export async function uninstallApp(appName: string): Promise<boolean> {
  try {
    const response = await casaosRequest('DELETE', `/v2/app_management/compose/${appName}`);
    rejectIfErrorEnvelope(response, `uninstall ${appName}`);

    // Verify removal by polling listApps for up to 5 seconds.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const apps = await listApps();
      if (!apps.some(a => a.name === appName)) {
        console.log(`[CasaOS API] Uninstalled app: ${appName}`);
        return true;
      }
      await new Promise(r => setTimeout(r, 250));
    }
    throw new Error(`CasaOS reported uninstall success but '${appName}' still appears in the app list after 5s`);
  } catch (error) {
    console.error(`[CasaOS API] Failed to uninstall app ${appName}:`, error);
    return false;
  }
}

/**
 * Deploy a compose app using docker compose up -d
 * Uses spawn for reliable execution and log streaming.
 */
export async function deployApp(
  appName: string,
  composePath: string,
  onLog?: (message: string) => void,
  timeoutMs: number = 300000
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    console.log(`[CasaOS API] Deploying ${appName} from ${composePath}`);

    const args = ['compose', '-p', appName, '-f', composePath, 'up', '-d', '--remove-orphans'];
    const child = spawn('docker', args);
    const outputLines: string[] = [];

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 5000);
      resolve({ success: false, error: `Deploy timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);

    const processLog = (data: Buffer) => {
      const lines = data.toString().split(/[\r\n]+/);
      lines.forEach(line => {
        if (!line.trim()) return;
        outputLines.push(line);
        console.log(`[Compose ${appName}] ${line}`);
        if (onLog) onLog(line);
      });
    };

    child.stdout.on('data', processLog);
    child.stderr.on('data', processLog);

    child.on('close', async (code) => {
      clearTimeout(timeout);
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();

      if (code !== 0) {
        const lastLines = outputLines.slice(-5).join('\n');
        const msg = lastLines
          ? `docker compose up failed (exit code ${code}):\n${lastLines}`
          : `docker compose up failed (exit code ${code})`;
        console.error(`[CasaOS API] ${msg}`);
        resolve({ success: false, error: msg });
        return;
      }

      // compose up exits 0 the moment the API call succeeds. Containers
      // can immediately exit on init (bad command, missing env, port clash)
      // and we'd still report success without this check.
      const verification = await verifyComposeProjectRunning(appName, 5000);
      if (!verification.allRunning) {
        const msg = `docker compose up exited 0 but containers aren't running: ${verification.problems.join('; ')}`;
        console.error(`[CasaOS API] ${msg}`);
        resolve({ success: false, error: msg });
        return;
      }
      console.log(`[CasaOS API] Deployed app: ${appName}`);
      resolve({ success: true });
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();

      console.error(`[CasaOS API] Failed to spawn docker compose for ${appName}:`, err);
      resolve({ success: false, error: `Failed to start deploy: ${err.message}` });
    });
  });
}

/**
 * Tear down a compose app using docker compose down
 * Stops AND removes containers, networks, and orphans.
 * Uses spawn for reliable execution (same pattern as deployApp).
 */
export async function composeDown(
  appName: string,
  composePath: string,
  onLog?: (message: string) => void,
  timeoutMs: number = 120000
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    console.log(`[CasaOS API] Tearing down ${appName} from ${composePath}`);

    const args = ['compose', '-p', appName, '-f', composePath, 'down', '--remove-orphans'];
    const child = spawn('docker', args);
    const outputLines: string[] = [];

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 5000);
      resolve({ success: false, error: `Compose down timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);

    const processLog = (data: Buffer) => {
      const lines = data.toString().split(/[\r\n]+/);
      lines.forEach(line => {
        if (!line.trim()) return;
        outputLines.push(line);
        console.log(`[Compose down ${appName}] ${line}`);
        if (onLog) onLog(line);
      });
    };

    child.stdout.on('data', processLog);
    child.stderr.on('data', processLog);

    child.on('close', (code) => {
      clearTimeout(timeout);
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();

      if (code === 0) {
        console.log(`[CasaOS API] Torn down app: ${appName}`);
        resolve({ success: true });
      } else {
        const lastLines = outputLines.slice(-5).join('\n');
        const msg = lastLines
          ? `docker compose down failed (exit code ${code}):\n${lastLines}`
          : `docker compose down failed (exit code ${code})`;
        console.error(`[CasaOS API] ${msg}`);
        resolve({ success: false, error: msg });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();

      console.error(`[CasaOS API] Failed to spawn docker compose down for ${appName}:`, err);
      resolve({ success: false, error: `Failed to start compose down: ${err.message}` });
    });
  });
}

/**
 * Get app status
 */
export async function getAppStatus(appName: string): Promise<string | null> {
  try {
    const apps = await listApps();
    const app = apps.find(a => a.name === appName);
    return app?.status || null;
  } catch (error) {
    return null;
  }
}
