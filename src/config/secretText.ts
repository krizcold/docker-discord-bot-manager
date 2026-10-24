/**
 * Keeping credentials out of command lines and out of the texts the manager
 * shows or stores: redaction, safe failure texts for child processes, and the
 * SCRAM-SHA-256 verifier a role password is set with.
 */

import * as crypto from 'crypto';

/** Shorter values would match ordinary words in an error text. */
const MIN_SECRET_LENGTH = 4;

/** Every occurrence of each secret, raw or URI-encoded, becomes ***. */
export function redactSecrets(text: string, secrets: Array<string | null | undefined>): string {
  let out = text;
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (!secret || secret.length < MIN_SECRET_LENGTH) continue;
    forms.add(secret);
    forms.add(encodeURIComponent(secret));
    try { forms.add(decodeURIComponent(secret)); } catch { /* not URI-encoded */ }
  }
  for (const form of [...forms].sort((a, b) => b.length - a.length)) {
    if (form.length >= MIN_SECRET_LENGTH) out = out.split(form).join('***');
  }
  return out;
}

/** The password a URL carries in its userinfo or its password parameter, or null. */
export function urlPassword(value: string): string | null {
  try {
    const url = new URL(value.trim());
    const pw = url.password ? decodeURIComponent(url.password) : url.searchParams.get('password');
    return pw || null;
  } catch {
    return null;
  }
}

/**
 * The text of a failed child process without the command line: a Node exec
 * error's message starts with "Command failed: <argv>", which can carry a
 * credential, so only stderr or the bare failure kind is ever returned.
 */
export function childFailureText(stderr: unknown, err: unknown): string {
  const text = String(stderr ?? '').trim();
  if (text) return text;
  const e = err as { killed?: boolean; signal?: string | null; code?: unknown } | null | undefined;
  if (!e) return '';
  if (e.killed || e.signal) return `the command was stopped (${e.signal || 'timeout'})`;
  if (typeof e.code === 'number') return `the command exited with code ${e.code}`;
  if (typeof e.code === 'string') return `the command could not run (${e.code})`;
  return 'the command failed';
}

/**
 * The SCRAM-SHA-256 verifier Postgres stores for a password (RFC 5802/7677),
 * so a role statement carries this instead of the password itself. Postgres
 * runs SASLprep on a password that is not pure ASCII, which this does not
 * reproduce, so such a password throws instead of setting one that never
 * verifies.
 */
export function scramSha256Verifier(password: string, salt: Buffer = crypto.randomBytes(16), iterations = 4096): string {
  if (!/^[\x00-\x7f]*$/.test(password)) throw new Error('the password has characters outside ASCII, which the manager cannot set as a SCRAM verifier');
  const salted = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = crypto.createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = crypto.createHash('sha256').update(clientKey).digest();
  const serverKey = crypto.createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/**
 * The session settings that keep a role statement out of the server log: a
 * failing statement is logged with its text at the default
 * log_min_error_statement, and log_statement can log it on success.
 */
export const QUIET_ROLE_SESSION_SQL = "SET log_min_error_statement = panic;\nSET log_statement = 'none';\nSET log_min_duration_statement = -1;\n";
