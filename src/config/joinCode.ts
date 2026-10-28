/**
 * The join code a main's manager hands out and another machine's manager pastes: the main's address, its
 * certificate fingerprint, the replication login and the bot's database login, as one string. Pure: no I/O.
 */
import * as crypto from 'crypto';

export const JOIN_CODE_PREFIX = 'smdbjoin1.';
export const JOIN_CODE_MAX = 4096;

export interface JoinLogin { user: string; password: string }

export interface JoinCode {
  v: 1;
  host: string;
  port: number;
  db: string;
  fp: string;
  machine: string;
  repl: JoinLogin;
  app: JoinLogin;
}

export const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
/** Names and the replication password reach libpq conninfo unquoted, so they keep to URL-safe characters. */
const TAME_RE = /^[A-Za-z0-9._~-]{1,128}$/;
export const MACHINE_RE = /^[\x20-\x7e]{1,64}$/;
const FP_RE = /^[0-9a-f]{64}$/;

function base64url(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64url');
}

export function encodeJoinCode(code: JoinCode): string {
  const body = {
    v: 1, host: code.host, port: code.port, db: code.db, fp: code.fp, machine: code.machine,
    repl: { user: code.repl.user, password: code.repl.password },
    app: { user: code.app.user, password: code.app.password },
  };
  return `${JOIN_CODE_PREFIX}${base64url(JSON.stringify(body))}`;
}

export type DecodedJoin = { ok: true; code: JoinCode } | { ok: false; why: string };

const bad = (why: string): DecodedJoin => ({ ok: false, why });
const field = (name: string): DecodedJoin => bad(`it names no valid ${name}`);

function login(value: unknown, name: string, tamePassword: boolean): JoinLogin | string {
  if (!value || typeof value !== 'object') return name;
  const { user, password } = value as Record<string, unknown>;
  if (typeof user !== 'string' || !TAME_RE.test(user)) return `${name} user`;
  if (typeof password !== 'string' || password === '' || password.length > 256 || password.includes('\0')) return `${name} password`;
  if (tamePassword && !TAME_RE.test(password)) return `${name} password`;
  return { user, password };
}

/** Whitespace and line breaks anywhere are ignored, so a code wrapped by a chat window still decodes. */
export function decodeJoinCode(text: string): DecodedJoin {
  const raw = String(text ?? '').replace(/\s+/g, '');
  if (raw.length > JOIN_CODE_MAX) return bad(`it is longer than ${JOIN_CODE_MAX} characters`);
  if (!raw.startsWith(JOIN_CODE_PREFIX)) return bad(`it does not start with ${JOIN_CODE_PREFIX}`);
  const body = raw.slice(JOIN_CODE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) return bad('it is damaged (it does not decode)');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8'));
  } catch {
    return bad('it is damaged (it does not decode)');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return bad('it is damaged (it does not decode)');
  const o = parsed as Record<string, unknown>;
  if (o.v !== 1) return field('version');
  if (typeof o.host !== 'string' || o.host.length > 253 || !HOST_RE.test(o.host)) return field('host');
  if (typeof o.port !== 'number' || !Number.isInteger(o.port) || o.port < 1 || o.port > 65535) return field('port');
  if (typeof o.db !== 'string' || !TAME_RE.test(o.db)) return field('database');
  if (typeof o.fp !== 'string' || !FP_RE.test(o.fp)) return field('fingerprint');
  if (typeof o.machine !== 'string' || !MACHINE_RE.test(o.machine)) return field('machine');
  const repl = login(o.repl, 'replication', true);
  if (typeof repl === 'string') return field(repl);
  const app = login(o.app, 'database', false);
  if (typeof app === 'string') return field(app);
  return { ok: true, code: { v: 1, host: o.host, port: o.port, db: o.db, fp: o.fp, machine: o.machine, repl, app } };
}

export function isJoinCode(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().startsWith(JOIN_CODE_PREFIX);
}

/** Lowercase hex SHA-256 of the certificate's DER bytes; throws on a PEM that holds no certificate. */
export function certFingerprint(pem: string): string {
  return new crypto.X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase();
}

export function fp16(fp: string): string {
  return fp.slice(0, 16);
}

/** The machine name a code or an address row carries: printable ASCII, at most 64 characters. */
export function machineText(name: string): string {
  if (MACHINE_RE.test(name)) return name;
  const kept = name.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 64);
  return kept || 'unnamed';
}

export function splitBackendUrls(value: string | null | undefined): string[] {
  return String(value ?? '').split(',').map(s => s.trim()).filter(Boolean);
}

export function formatBackendUrlList(urls: string[]): string {
  return urls.join(',');
}

export function isBackendUrlList(value: string | null | undefined): boolean {
  return splitBackendUrls(value).length > 1;
}

export interface ListAddress { host: string; port: number; fp: string }

export interface AddressListInput {
  app: JoinLogin;
  db: string;
  /** The folder the bot sees the certificate files in, e.g. /data/db-certs. */
  certDir: string;
  /** A database on this machine (this machine's copy): its container name, and the address other machines know it by. */
  local?: { container: string; host?: string; port?: number };
  main: ListAddress & { container?: string };
  others: ListAddress[];
}

function localUrl(app: JoinLogin, container: string, db: string): string {
  return `postgresql://${encodeURIComponent(app.user)}:${encodeURIComponent(app.password)}@${container}:5432/${db}?sslmode=no-verify`;
}

function remoteUrl(app: JoinLogin, a: ListAddress, db: string, certDir: string): string {
  return `postgresql://${encodeURIComponent(app.user)}:${encodeURIComponent(app.password)}@${a.host}:${a.port}/${db}?sslmode=verify-full&sslrootcert=${certDir}/${fp16(a.fp)}.crt`;
}

/** Every database address the bot gets, as URLs: the local one first, the main second, the rest by host then port. */
export function addressList(input: AddressListInput): string[] {
  const seen = new Set<string>();
  const key = (host: string, port: number) => `${host.toLowerCase()}:${port}`;
  const out: string[] = [];
  if (input.local) {
    seen.add(key(input.local.container, 5432));
    if (input.local.host && input.local.port) seen.add(key(input.local.host, input.local.port));
    out.push(localUrl(input.app, input.local.container, input.db));
  }
  const m = input.main;
  if (!seen.has(key(m.host, m.port))) {
    seen.add(key(m.host, m.port));
    if (m.container) {
      seen.add(key(m.container, 5432));
      out.push(localUrl(input.app, m.container, input.db));
    } else {
      out.push(remoteUrl(input.app, m, input.db, input.certDir));
    }
  }
  const rest = [...input.others].sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : a.port - b.port));
  for (const a of rest) {
    if (seen.has(key(a.host, a.port))) continue;
    seen.add(key(a.host, a.port));
    out.push(remoteUrl(input.app, a, input.db, input.certDir));
  }
  return out;
}

/** A Postgres LSN (`16/B374D848`) as a number that orders like the LSN; null for anything else. */
export function lsnToBigInt(lsn: string | null | undefined): bigint | null {
  const m = /^([0-9A-Fa-f]{1,8})\/([0-9A-Fa-f]{1,8})$/.exec(String(lsn ?? '').trim());
  if (!m) return null;
  return (BigInt(`0x${m[1]}`) << 32n) + BigInt(`0x${m[2]}`);
}

/** An LSN number as Postgres writes it. */
export function lsnText(lsn: bigint): string {
  return `${(lsn >> 32n).toString(16).toUpperCase()}/${(lsn & 0xffffffffn).toString(16).toUpperCase()}`;
}

/** A string for a SQL literal: quotes doubled; a NUL refuses. */
export function sqlLiteral(value: string): string {
  if (value.includes('\0')) throw new Error('a value holds a NUL character');
  return `'${value.replace(/'/g, "''")}'`;
}

export const CERT_PEM_RE = /^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$/;
