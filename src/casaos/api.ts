/**
 * CasaOS API
 * Wrapper for CasaOS container management API (via docker exec)
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';

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
  const curlCmd = body
    ? `curl -s -X ${method} -H "Content-Type: application/json" -d '${JSON.stringify(body)}' "http://localhost:80${endpoint}"`
    : `curl -s -X ${method} "http://localhost:80${endpoint}"`;

  const dockerCmd = `docker exec casaos sh -c '${curlCmd}'`;

  try {
    const { stdout, stderr } = await execAsync(dockerCmd, { timeout: 30000 });
    if (stderr) {
      console.error('[CasaOS API] stderr:', stderr);
    }
    return JSON.parse(stdout);
  } catch (error) {
    console.error('[CasaOS API] Request failed:', error);
    throw error;
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
    await casaosRequest('POST', `/v2/app_management/compose/${appName}/start`);
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
    await casaosRequest('POST', `/v2/app_management/compose/${appName}/stop`);
    console.log(`[CasaOS API] Stopped app: ${appName}`);
    return true;
  } catch (error) {
    console.error(`[CasaOS API] Failed to stop app ${appName}:`, error);
    return false;
  }
}

/**
 * Uninstall a compose app
 */
export async function uninstallApp(appName: string): Promise<boolean> {
  try {
    await casaosRequest('DELETE', `/v2/app_management/compose/${appName}`);
    console.log(`[CasaOS API] Uninstalled app: ${appName}`);
    return true;
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

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 5000);
      resolve({ success: false, error: `Deploy timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);

    const processLog = (data: Buffer) => {
      const lines = data.toString().split(/[\r\n]+/);
      lines.forEach(line => {
        if (!line.trim()) return;
        console.log(`[Compose ${appName}] ${line}`);
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
        console.log(`[CasaOS API] Deployed app: ${appName}`);
        resolve({ success: true });
      } else {
        const msg = `docker compose up failed (exit code ${code})`;
        console.error(`[CasaOS API] ${msg}`);
        resolve({ success: false, error: msg });
      }
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
