/**
 * How the manager reads a stored Database URL: the addresses it names, and the forms in which the bot's Postgres
 * driver (pg-connection-string) would read another host, port or database than `new URL` does (D88).
 */
import { isJoinCode, splitBackendUrls } from './joinCode';
import type { InstanceConfig } from '../types';

export type DatabaseAddress = { host: string; port: number; db: string };
export type DatabaseUrlForm = 'hosts' | 'scheme' | 'unparsed' | 'param' | 'encodedHost' | 'noHost' | 'noDatabase' | 'databaseName' | 'pgport';

const WRITE_URL = 'write it as postgresql://user:password@host:port/database';

export const URL_FORM: Record<DatabaseUrlForm, { what: string; instead: string }> = {
  hosts: { what: 'lists several hosts in one address, separated by commas', instead: 'write one host in each postgresql:// address' },
  scheme: { what: 'holds an address that does not start with postgresql:// or postgres://', instead: WRITE_URL },
  unparsed: { what: 'holds a postgresql:// address the manager cannot parse', instead: WRITE_URL },
  param: { what: 'has a host, hostaddr or port parameter after the ?, which the driver uses in place of the host and port before it', instead: 'write the host and port before the database name and remove that parameter' },
  encodedHost: { what: 'has % codes in its host, which the driver decodes', instead: 'write the host without % codes' },
  noHost: { what: 'names no host', instead: 'write the host after the @' },
  noDatabase: { what: 'names no database, so the driver takes the database name from its PGDATABASE setting or the user name', instead: 'end the address with /database' },
  databaseName: { what: 'has a % or a / in the database name', instead: 'write the database name without them' },
  pgport: { what: "names no port while the bot's PGPORT setting is set, which the driver uses in its place", instead: 'write the port after the host, as in host:5432' },
};

const SCHEME = /^postgres(ql)?:\/\//i;
const PARAMS = new Set(['host', 'hostaddr', 'port']);
const bare = (host: string) => host.replace(/^\[|\]$/g, '').toLowerCase();

function parse(entry: string): URL | null {
  try { return new URL(entry); } catch { return null; }
}

const hasParam = (u: URL | null) => !!u && Array.from(u.searchParams.keys()).some(k => PARAMS.has(k.toLowerCase()));

/** The addresses a Database URL names, and the first form of D88 it is in (null when the driver reads it as the manager does). */
export function readDatabaseUrl(value: string, env: Record<string, string | undefined> = {}): { addresses: DatabaseAddress[]; form: DatabaseUrlForm | null } {
  const v = String(value ?? '').trim();
  if (!v || isJoinCode(v)) return { addresses: [], form: null };
  const entries = splitBackendUrls(v);
  const urls = entries.map(e => (SCHEME.test(e) ? parse(e) : null));
  const addresses: DatabaseAddress[] = [];
  for (const u of urls) {
    if (!u || !bare(u.hostname)) continue;
    addresses.push({ host: bare(u.hostname), port: u.port ? Number(u.port) : 5432, db: u.pathname.replace(/^\//, '') });
  }
  const read = (form: DatabaseUrlForm | null) => ({ addresses, form });
  if (v.includes(',') && entries.some(e => !SCHEME.test(e))) return read('hosts');
  if (entries.some(e => !SCHEME.test(e))) return read('scheme');
  if (urls.some(u => !u)) return read('unparsed');
  const parsed = urls as URL[];
  if (parsed.some(hasParam) || hasParam(parse(v))) return read('param');
  if (parsed.some(u => u.hostname.includes('%'))) return read('encodedHost');
  if (parsed.some(u => !bare(u.hostname))) return read('noHost');
  if (parsed.some(u => u.pathname === '' || u.pathname === '/')) return read('noDatabase');
  if (parsed.some(u => /[%/]/.test(u.pathname.slice(1)))) return read('databaseName');
  if (parsed.some(u => !u.port) && String(env.PGPORT ?? '').trim() !== '') return read('pgport');
  return read(null);
}

const HOST_PARAMS = new Set(['host', 'hostaddr']);

/** O44: a host or hostaddr parameter after the ?, which makes the driver dial another host. */
export function hasHostParam(value: string): boolean {
  const v = String(value ?? '').trim();
  return [v, ...splitBackendUrls(v)].some(e => {
    const u = parse(e);
    return !!u && Array.from(u.searchParams.keys()).some(k => HOST_PARAMS.has(k.toLowerCase()));
  });
}

/** D63: an address names a managed database by its container name at any port, or by its replication address at its hostPort. */
export function namesDatabaseOf(a: DatabaseAddress, db: { containerName: string; replication?: { publicHost?: string; hostPort?: number } | null }): boolean {
  if (a.host === db.containerName.toLowerCase()) return true;
  const r = db.replication;
  return !!r?.publicHost && bare(r.publicHost) === a.host && r.hostPort === a.port;
}

/** The first bot whose managed database a URL or a `host:port/db` text names; null when none does. */
export function databaseHostIn(address: string, bots: InstanceConfig[]): InstanceConfig | null {
  const text = String(address ?? '').trim();
  let a: DatabaseAddress | null;
  if (SCHEME.test(text)) {
    a = readDatabaseUrl(text).addresses[0] ?? null;
  } else {
    const m = /^(\[[^\]]+\]|[^:/]+)(?::(\d*))?(?:\/|$)/.exec(text);
    a = m && bare(m[1]) ? { host: bare(m[1]), port: m[2] ? Number(m[2]) : 5432, db: text.slice(m[0].length) } : null;
  }
  if (!a) return null;
  const found = a;
  return bots.find(b => b.fleetDb && namesDatabaseOf(found, b.fleetDb)) ?? null;
}
