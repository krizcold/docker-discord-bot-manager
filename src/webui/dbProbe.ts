/**
 * The one-shot psql connection test behind validate-db. The URL reaches psql
 * without its password, which rides the docker CLI's own environment as
 * PGPASSWORD (`-e NAME` with no value), so the credential is in no command
 * line on either side. Errors come back password-redacted.
 */

import { spawn } from 'child_process';
import { redactSecrets, urlPassword } from '../config/secretText';

const PROBE_TIMEOUT_MS = 10_000;

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

export function probeDatabaseUrl(target: string, network: string | null): Promise<{ ok: boolean; error?: string }> {
  const split = splitDbUrl(target);
  // A text that does not parse as a URL cannot be split from its password, so it never reaches a command line.
  if (!split) return Promise.resolve({ ok: false, error: 'The database URL could not be read as a URL (expected postgresql://user:password@host:port/database)' });
  const secrets = [split.password, target];
  return new Promise(resolve => {
    const child = spawn('docker', ['run', '--rm', ...(network ? ['--network', network] : []),
      ...(split.password ? ['-e', 'PGPASSWORD'] : []),
      'postgres:16-alpine', 'psql', split.url, '-c', 'SELECT 1'],
      { env: split.password ? { ...process.env, PGPASSWORD: split.password } : process.env });
    let stderr = '';
    let killed = false;
    let settled = false;
    const finish = (r: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, PROBE_TIMEOUT_MS);
    child.stderr.on('data', d => { if (stderr.length < 4000) stderr += d.toString(); });
    child.on('error', err => finish({ ok: false, error: `Failed to run docker: ${err.message}` }));
    child.on('close', code => {
      if (killed) return finish({ ok: false, error: 'Connection test timed out after 10 seconds' });
      if (code === 0) return finish({ ok: true });
      const text = (stderr.trim() || `psql exited with code ${code}`).split(target).join(redactDbUrl(target));
      finish({ ok: false, error: redactSecrets(text, secrets) });
    });
  });
}
