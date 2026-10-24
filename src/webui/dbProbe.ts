/**
 * The one-shot psql connection test behind validate-db. The URL reaches psql
 * without its password, which rides the docker CLI's own environment as
 * PGPASSWORD (`-e NAME` with no value), so the credential is in no command
 * line on either side. Errors come back password-redacted.
 */

import { spawn } from 'child_process';
import { redactSecrets, urlPassword } from '../config/secretText';

const PROBE_TIMEOUT_MS = 10_000;
const PULL_TIMEOUT_MS = 300_000;
const PROBE_IMAGE = 'postgres:16-alpine';

type RunResult = { code: number | null; stderr: string; killed: boolean; spawnError?: string };

function runDocker(args: string[], timeoutMs: number, env: NodeJS.ProcessEnv = process.env): Promise<RunResult> {
  return new Promise(resolve => {
    const child = spawn('docker', args, { env });
    let stderr = '';
    let killed = false;
    let settled = false;
    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stderr?.on('data', d => { if (stderr.length < 4000) stderr += d.toString(); });
    child.on('error', err => finish({ code: null, stderr, killed, spawnError: err.message }));
    child.on('close', code => finish({ code, stderr, killed }));
  });
}

/** The test image present locally, pulled under its own timeout when missing; an error text when it is not there. */
async function ensureProbeImage(): Promise<string | null> {
  const inspect = await runDocker(['image', 'inspect', PROBE_IMAGE], PROBE_TIMEOUT_MS);
  if (inspect.spawnError) return `Failed to run docker: ${inspect.spawnError}`;
  if (inspect.code === 0) return null;
  const pull = await runDocker(['pull', PROBE_IMAGE], PULL_TIMEOUT_MS);
  if (pull.spawnError) return `Failed to run docker: ${pull.spawnError}`;
  if (pull.code === 0) return null;
  const why = pull.killed ? `did not finish within ${PULL_TIMEOUT_MS / 60_000} minutes` : (pull.stderr.trim().split('\n').pop() || `docker pull exited with code ${pull.code}`);
  return `The test image ${PROBE_IMAGE} could not be downloaded (${why}); the database was not tested`;
}

/**
 * node-postgres accepts sslmode=no-verify for "encrypt, trust is pinned
 * elsewhere"; libpq has no such value and refuses the whole URL. require is
 * its equivalent (encrypt, no certificate verification).
 */
function libpqSslMode(u: URL): void {
  if (u.searchParams.get('sslmode') === 'no-verify') u.searchParams.set('sslmode', 'require');
}

/** Redact the password portion of a database URL. */
export function redactDbUrl(url: string): string {
  return url.replace(/(:\/\/[^:@/]*):[^@]*@/, '$1:***@');
}

/** The URL split into a password-free URL and its password; null when it is not a URL. */
export function splitDbUrl(url: string): { url: string; password: string | null } | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const password = urlPassword(url);
  u.password = '';
  u.searchParams.delete('password');
  libpqSslMode(u);
  return { url: u.toString(), password };
}

export async function probeDatabaseUrl(target: string, network: string | null): Promise<{ ok: boolean; error?: string; notTested?: boolean }> {
  const split = splitDbUrl(target);
  // A text that does not parse as a URL cannot be split from its password, so it never reaches a command line.
  if (!split) return { ok: false, error: 'The database URL could not be read as a URL (expected postgresql://user:password@host:port/database)' };
  const secrets = [split.password, target];
  const imageError = await ensureProbeImage();
  if (imageError) return { ok: false, error: imageError, notTested: true };
  const r = await runDocker(['run', '--rm', '--pull', 'never', ...(network ? ['--network', network] : []),
    ...(split.password ? ['-e', 'PGPASSWORD'] : []),
    PROBE_IMAGE, 'psql', split.url, '-c', 'SELECT 1'],
    PROBE_TIMEOUT_MS, split.password ? { ...process.env, PGPASSWORD: split.password } : process.env);
  if (r.spawnError) return { ok: false, error: `Failed to run docker: ${r.spawnError}` };
  if (r.killed) return { ok: false, error: 'Connection test timed out after 10 seconds' };
  if (r.code === 0) return { ok: true };
  const text = (r.stderr.trim() || `psql exited with code ${r.code}`).split(target).join(redactDbUrl(target));
  return { ok: false, error: redactSecrets(text, secrets) };
}
