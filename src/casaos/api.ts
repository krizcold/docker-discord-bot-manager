/**
 * Compose lifecycle for CasaOS-mode apps.
 *
 * Both calls drive `docker compose` against the app's own compose file on the
 * host daemon, so this mode needs no platform service to start, stop or tear an
 * app down. Its remaining platform coupling is in how the compose is AUTHORED
 * (see templates/pcsProcessing), not in how it is run.
 */

import { spawn } from 'child_process';
import { verifyComposeProjectRunning } from '../docker/dockerClient';
import { createLineHandler, DockerLogFn } from '../docker/outputStream';

/**
 * Deploy a compose app using docker compose up -d
 * Uses spawn for reliable execution and log streaming.
 */
export async function deployApp(
  appName: string,
  composePath: string,
  onLog?: DockerLogFn,
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

    const onLine: DockerLogFn = (line, key) => {
      outputLines.push(line);
      console.log(`[Compose ${appName}] ${line}`);
      onLog?.(line, key);
    };
    const out = createLineHandler(onLine);
    const err = createLineHandler(onLine);
    child.stdout.on('data', out.data);
    child.stderr.on('data', err.data);

    child.on('close', async (code) => {
      clearTimeout(timeout);
      out.flush();
      err.flush();
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
  onLog?: DockerLogFn,
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

    const onLine: DockerLogFn = (line, key) => {
      outputLines.push(line);
      console.log(`[Compose down ${appName}] ${line}`);
      onLog?.(line, key);
    };
    const out = createLineHandler(onLine);
    const err = createLineHandler(onLine);
    child.stdout.on('data', out.data);
    child.stderr.on('data', err.data);

    child.on('close', (code) => {
      clearTimeout(timeout);
      out.flush();
      err.flush();
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
