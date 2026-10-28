/**
 * The joining side of a join code: checks the main's certificate against the code's fingerprint, reads the main's
 * identity and its address list, writes the certificate files the bot reads, and keeps the bot's DATA_BACKEND_URL
 * as the list of every database address.
 */
import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as tls from 'tls';
import * as crypto from 'crypto';
import * as containerManager from '../docker/containerManager';
import * as envManager from '../env/manager';
import * as dbLogin from './dbLogin';
import { MANAGER_DB_ROLE } from './dbLogin';
import { getBotDir } from '../git/repoManager';
import { findAppCapabilities } from '../config/appCapabilities';
import { redactSecrets } from '../config/secretText';
import {
  addressList, CERT_PEM_RE, certFingerprint, decodeJoinCode, formatBackendUrlList, fp16, HOST_RE, isJoinCode,
  JoinCode, lsnToBigInt, machineText, sqlLiteral,
} from '../config/joinCode';
import { FleetJoinRecord, InstanceConfig, JoinAddress } from '../types';

const PGDATA = '/var/lib/postgresql/data';
export const CERT_TIMEOUT_MS = 10_000;
const CLIENT_TIMEOUT_MS = 60_000;
const READ_TIMEOUT_MS = 30_000;
const COPY_TIMEOUT_MS = 120_000;
const PULL_TIMEOUT_MS = 10 * 60 * 1000;
export const REFRESH_EVERY_MS = 60 * 60 * 1000;

export interface PrimaryLogin {
  user: string;
  password: string;
  host: string;
  port: number;
  db: string;
}

export function loginOf(code: JoinCode): PrimaryLogin {
  return { user: code.repl.user, password: code.repl.password, host: code.host, port: code.port, db: code.db };
}

export function seedDsnFor(dsn: PrimaryLogin): string {
  return `postgresql://${encodeURIComponent(dsn.user)}@${dsn.host}:${dsn.port}/${dsn.db}?sslmode=verify-full&sslrootcert=/primary-ca.crt`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function dockerRm(name: string): Promise<void> {
  return new Promise(resolve => execFile('docker', ['rm', '-f', name], { timeout: READ_TIMEOUT_MS }, () => resolve()));
}

/**
 * A libpq client run against the primary in a throwaway container. The password reaches it as PGPASSWORD from the
 * docker CLI's own environment (`-e NAME` with no value), so it is in no command line on either side. On timeout
 * the container is removed by name: a signal to the CLI is proxied to the client as PID 1, which drops it, and the
 * container runs daemon-side.
 */
export function runPrimaryClient(name: string, dsn: Pick<PrimaryLogin, 'password'>, mounts: string[], entrypoint: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn('docker', ['run', '--rm', '--name', name, '-e', 'PGPASSWORD',
      ...mounts.flatMap(m => ['-v', m]),
      '--entrypoint', entrypoint, 'postgres:16-alpine', ...args], { env: { ...process.env, PGPASSWORD: dsn.password } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      execFile('docker', ['rm', '-f', name], () => child.kill('SIGKILL'));
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, stdout, stderr: stderr || 'docker run failed' }); });
    child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, stdout, stderr: redactSecrets(stderr, [dsn.password]) }); });
  });
}

function pemOf(raw: Buffer): string {
  const b64 = raw.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

/**
 * The main's certificate as its TLS handshake shows it: Postgres's SSLRequest, one answer byte, then TLS on the same
 * socket. Trust is not checked here; the caller compares the fingerprint with the join code's.
 */
export function fetchMainCertificate(host: string, port: number, timeoutMs = CERT_TIMEOUT_MS): Promise<{ ok: true; pem: string; fp: string } | { ok: false; reason: string }> {
  return new Promise(resolve => {
    let done = false;
    let socket: net.Socket | null = null;
    let secure: tls.TLSSocket | null = null;
    const finish = (r: { ok: true; pem: string; fp: string } | { ok: false; reason: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      secure?.destroy();
      socket?.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: `no answer within ${Math.round(timeoutMs / 1000)} s` }), timeoutMs);
    socket = net.connect({ host, port });
    socket.once('error', err => finish({ ok: false, reason: errorText(err) }));
    socket.once('close', () => finish({ ok: false, reason: 'the connection closed before TLS started' }));
    socket.once('connect', () => socket!.write(Buffer.from('0000000804d2162f', 'hex')));
    socket.once('data', (data: Buffer) => {
      if (data[0] === 0x4e) return finish({ ok: false, reason: 'the server does not offer TLS' });
      if (data[0] !== 0x53) return finish({ ok: false, reason: 'the server did not answer as Postgres' });
      socket!.removeAllListeners('close');
      socket!.removeAllListeners('error');
      socket!.on('error', () => undefined);
      secure = tls.connect({ socket: socket!, rejectUnauthorized: false, ...(net.isIP(host) ? {} : { servername: host }) });
      secure.once('error', err => finish({ ok: false, reason: errorText(err) }));
      secure.once('close', () => finish({ ok: false, reason: 'the connection closed during the TLS handshake' }));
      secure.once('secureConnect', () => {
        const cert = secure!.getPeerCertificate(true);
        if (!cert || !cert.raw) return finish({ ok: false, reason: 'the server showed no certificate' });
        finish({ ok: true, pem: pemOf(cert.raw), fp: crypto.createHash('sha256').update(cert.raw).digest('hex') });
      });
    });
  });
}

/** Where a remote main's certificate is read from; tests put a fixture here. */
export const certSource = { fetch: fetchMainCertificate };

/** The instance on this manager whose database is the main the code names, if any. */
export function sameManagerMain(code: Pick<JoinCode, 'host' | 'port'>): InstanceConfig | null {
  return containerManager.getAllBots().find(b => {
    const r = b.fleetDb?.replication;
    return !!r && r.publicHost?.toLowerCase() === code.host.toLowerCase() && r.hostPort === code.port;
  }) ?? null;
}

export function unreachableText(host: string, port: number, reason: string): string {
  return `Can't reach the main at ${host}:${port} (${reason}); nothing was changed. The main's machine must accept connections on that port. A machine that cannot open a port can be the main only when it runs alone.`;
}

export function fpMismatchText(host: string, port: number, seen: string, expected: string): string {
  return `The database at ${host}:${port} shows a certificate with fingerprint ${fp16(seen)}..., not the ${fp16(expected)}... in the join code, so the manager did not trust it; nothing was changed. Copy a new join code from the main's manager. If the main's certificate did not change, something else answers at that address.`;
}

export function loginRefusedText(host: string, port: number, reason: string): string {
  return `The main at ${host}:${port} refused the join code's login (${reason}); nothing was changed. Replication may have been disabled there, or its password changed: copy a new join code from the main's manager.`;
}

export function inRecoveryText(host: string, port: number): string {
  return `The database at ${host}:${port} follows another database itself, so it cannot be joined; copy the join code from the manager of the machine that holds the main database.`;
}

export type CertCheck = { ok: true; pem: string } | { ok: false; kind: 'unreachable' | 'fingerprint'; reason: string; text: string };

/** J3: the main's certificate, proven by the code's fingerprint. A main on this manager is read by docker exec. */
export async function mainCertificate(code: JoinCode): Promise<CertCheck> {
  const local = sameManagerMain(code);
  let got: { ok: true; pem: string; fp: string } | { ok: false; reason: string };
  if (local?.fleetDb) {
    got = await new Promise(resolve => {
      execFile('docker', ['exec', local.fleetDb!.containerName, 'cat', `${PGDATA}/server.crt`], { timeout: READ_TIMEOUT_MS }, (err, stdout, stderr) => {
        if (err) return resolve({ ok: false, reason: (String(stderr || err.message).trim().split('\n').pop() || 'docker exec failed') });
        try {
          const pem = String(stdout);
          resolve({ ok: true, pem, fp: certFingerprint(pem) });
        } catch {
          resolve({ ok: false, reason: 'the certificate file holds no certificate' });
        }
      });
    });
  } else {
    got = await certSource.fetch(code.host, code.port);
  }
  if (!got.ok) return { ok: false, kind: 'unreachable', reason: got.reason, text: unreachableText(code.host, code.port, got.reason) };
  if (got.fp !== code.fp) return { ok: false, kind: 'fingerprint', reason: `fingerprint ${fp16(got.fp)}...`, text: fpMismatchText(code.host, code.port, got.fp, code.fp) };
  return { ok: true, pem: got.pem };
}

/** Where the manager keeps a main's certificate for its own probes, named by fingerprint. */
function probeCertPath(botId: string, fp: string): string {
  return path.join(getBotDir(botId), 'fleet-join', `${fp16(fp)}.crt`);
}

function hostProbeCertPath(botId: string, fp: string): string {
  return `${containerManager.hostBotDirFor(botId)}/fleet-join/${fp16(fp)}.crt`;
}

function writeOnce(file: string, content: string): void {
  try {
    if (fs.readFileSync(file, 'utf-8') === content) return;
  } catch { /* absent */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

export function ensureProbeCert(botId: string, fp: string, pem: string): string {
  writeOnce(probeCertPath(botId, fp), pem.endsWith('\n') ? pem : `${pem}\n`);
  return hostProbeCertPath(botId, fp);
}

/** J4: the client image, pulled when missing. */
export async function ensureClientImage(): Promise<string | null> {
  const present = await new Promise<boolean>(resolve => {
    execFile('docker', ['image', 'inspect', 'postgres:16-alpine'], { timeout: READ_TIMEOUT_MS }, err => resolve(!err));
  });
  if (present) return null;
  return new Promise(resolve => {
    execFile('docker', ['pull', 'postgres:16-alpine'], { timeout: PULL_TIMEOUT_MS }, (err, _o, stderr) => {
      resolve(err ? `could not pull postgres:16-alpine: ${String(stderr || err).trim().split('\n').pop()}` : null);
    });
  });
}

export type SlotState = 'absent' | 'lost' | 'kept' | 'active';

export interface MainFacts {
  systemId: string;
  timeline: number;
  lsn: bigint;
  inRecovery: boolean;
  slot: SlotState;
}

export type MainProbe = { ok: true; facts: MainFacts } | { ok: false; kind: 'login' | 'unreachable' | 'garbled'; reason: string };

function firstReason(stderr: string): string {
  const lines = stderr.trim().split('\n').map(l => l.trim()).filter(Boolean);
  return (lines.find(l => /\b(FATAL|ERROR):/.test(l)) || lines[0] || 'psql failed').replace(/^psql: error: /, '');
}

function isLoginRefusal(text: string): boolean {
  return /password authentication failed|no pg_hba\.conf entry|is not permitted to log in|role "[^"]*" does not exist/i.test(text);
}

const SLOT_NAME_RE = /^[a-z0-9_]{1,63}$/;

/**
 * J5 and the watcher's main read, as the replication login over verify-full: IDENTIFY_SYSTEM, whether the main is
 * in recovery, and the state of one slot.
 */
export async function mainProbe(instance: InstanceConfig, code: JoinCode, pem: string, slot = ''): Promise<MainProbe> {
  const login = loginOf(code);
  const mount = `${ensureProbeCert(instance.id, code.fp, pem)}:/primary-ca.crt:ro`;
  const name = `${instance.sanitizedName}-fleet-join-probe`;
  await dockerRm(name);
  const dsn = seedDsnFor(login);
  const slotSql = SLOT_NAME_RE.test(slot)
    ? `COALESCE((SELECT CASE WHEN active THEN 'active' WHEN wal_status = 'lost' THEN 'lost' ELSE 'kept' END FROM pg_replication_slots WHERE slot_name = '${slot}'), 'absent')`
    : `'absent'`;
  const script = 'psql "$1&replication=true" -Atc IDENTIFY_SYSTEM && psql "$1" -v ON_ERROR_STOP=1 -Atc "$2"';
  const r = await runPrimaryClient(name, login, [mount], 'sh', ['-c', script, 'sh', dsn, `SELECT pg_is_in_recovery()::text || '|' || ${slotSql}`], CLIENT_TIMEOUT_MS);
  if (!r.ok) {
    const reason = firstReason(r.stderr).split(login.password).join('***');
    return { ok: false, kind: isLoginRefusal(r.stderr) ? 'login' : 'unreachable', reason };
  }
  const [ident, rest] = r.stdout.trim().split('\n').map(l => l.trim());
  const [systemId, timeline, xlogpos] = (ident || '').split('|');
  const [rec, slotState] = (rest || '').split('|');
  const lsn = lsnToBigInt(xlogpos);
  if (!/^\d+$/.test(systemId || '') || !/^\d+$/.test(timeline || '') || lsn === null || (rec !== 'true' && rec !== 'false')
    || !['absent', 'lost', 'kept', 'active'].includes(slotState)) {
    return { ok: false, kind: 'garbled', reason: 'the main gave an answer the manager does not read' };
  }
  return { ok: true, facts: { systemId, timeline: Number(timeline), lsn, inRecovery: rec === 'true', slot: slotState as SlotState } };
}

export function probeFailureText(code: JoinCode, p: Extract<MainProbe, { ok: false }>): string {
  return p.kind === 'login' ? loginRefusedText(code.host, code.port, p.reason) : unreachableText(code.host, code.port, p.reason);
}

const ADDRESS_READ_SQL = `SELECT COALESCE(json_agg(json_build_object('host', a.host, 'port', a.port, 'slot', a.slot, 'cert', a.cert,
  'machine', a.machine) ORDER BY a.host, a.port), '[]')
FROM smdb_manager.addresses a
WHERE a.slot IS NULL OR EXISTS (SELECT 1 FROM pg_replication_slots s WHERE s.slot_name = a.slot);`;

function primarySql(instance: InstanceConfig, code: JoinCode, pem: string, suffix: string, sql: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const login = loginOf(code);
  const mount = `${ensureProbeCert(instance.id, code.fp, pem)}:/primary-ca.crt:ro`;
  const name = `${instance.sanitizedName}-fleet-join-${suffix}`;
  return dockerRm(name).then(() => runPrimaryClient(name, login, [mount], 'psql', [seedDsnFor(login), '-v', 'ON_ERROR_STOP=1', '-Atc', sql], CLIENT_TIMEOUT_MS));
}

function validAddress(row: unknown): JoinAddress | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (typeof r.host !== 'string' || !HOST_RE.test(r.host)) return null;
  if (typeof r.port !== 'number' || !Number.isInteger(r.port) || r.port < 1 || r.port > 65535) return null;
  if (r.slot !== null && (typeof r.slot !== 'string' || !SLOT_NAME_RE.test(r.slot))) return null;
  if (typeof r.cert !== 'string' || !CERT_PEM_RE.test(r.cert.trim())) return null;
  try { certFingerprint(r.cert); } catch { return null; }
  return { host: r.host, port: r.port, slot: (r.slot as string | null) ?? null, cert: r.cert.trim(), machine: machineText(typeof r.machine === 'string' ? r.machine : '') };
}

/** J7 and F2: the main's address list, rows with a malformed field left out. */
export async function readAddresses(instance: InstanceConfig, code: JoinCode, pem: string): Promise<{ ok: true; addresses: JoinAddress[] } | { ok: false; reason: string }> {
  const r = await primarySql(instance, code, pem, 'list', ADDRESS_READ_SQL);
  if (!r.ok) return { ok: false, reason: firstReason(r.stderr) };
  try {
    const parsed = JSON.parse(r.stdout.trim() || '[]');
    if (!Array.isArray(parsed)) return { ok: false, reason: 'the list is not a list' };
    return { ok: true, addresses: parsed.map(validAddress).filter((a): a is JoinAddress => a !== null) };
  } catch {
    return { ok: false, reason: 'the list could not be read' };
  }
}

/** The upsert of one address row; slot null is the main's own row. */
export function addressUpsertSql(row: JoinAddress): string {
  if (!HOST_RE.test(row.host)) throw new Error(`the host ${row.host} is not a bare hostname or IPv4 address`);
  if (!Number.isInteger(row.port) || row.port < 1 || row.port > 65535) throw new Error('the port is not a port number');
  if (!CERT_PEM_RE.test(row.cert.trim())) throw new Error('the certificate is not a PEM certificate block');
  const slot = row.slot === null ? 'NULL' : sqlLiteral(row.slot);
  return `INSERT INTO smdb_manager.addresses (host, port, slot, cert, machine) VALUES (${sqlLiteral(row.host)}, ${row.port}, ${slot}, ${sqlLiteral(row.cert.trim())}, ${sqlLiteral(machineText(row.machine))})
  ON CONFLICT (host, port) DO UPDATE SET slot = EXCLUDED.slot, cert = EXCLUDED.cert, machine = EXCLUDED.machine, updated_at = now();`;
}

export async function registerAddress(instance: InstanceConfig, code: JoinCode, pem: string, row: JoinAddress): Promise<string | null> {
  let sql: string;
  try { sql = addressUpsertSql(row); } catch (err) { return errorText(err); }
  const r = await primarySql(instance, code, pem, 'register', sql);
  return r.ok ? null : firstReason(r.stderr);
}

export async function deleteAddress(instance: InstanceConfig, code: JoinCode, pem: string, host: string, port: number): Promise<string | null> {
  if (!HOST_RE.test(host)) return `the host ${host} is not a bare hostname or IPv4 address`;
  const r = await primarySql(instance, code, pem, 'unregister', `DELETE FROM smdb_manager.addresses WHERE host = ${sqlLiteral(host)} AND port = ${Number(port)};`);
  return r.ok ? null : firstReason(r.stderr);
}

/** The folder the bot reads certificate files from, in this process's path space. */
export async function certDirOf(instance: InstanceConfig): Promise<string> {
  const dataDir = await (await import('./fleetReplica')).instanceDataDir(instance);
  return path.join(dataDir, 'db-certs');
}

/** J8: one file per certificate, named by fingerprint; a name's content never changes and old files stay. */
export async function writeCertFiles(instance: InstanceConfig, pems: string[]): Promise<string | null> {
  let dir = '';
  try {
    dir = await certDirOf(instance);
    for (const pem of pems) writeOnce(path.join(dir, `${fp16(certFingerprint(pem))}.crt`), pem.endsWith('\n') ? pem : `${pem}\n`);
    return null;
  } catch (err) {
    return `The certificate files could not be written to ${dir || 'the data folder'} (${errorText(err)}); nothing else was changed.`;
  }
}

/** The bot's database login and the folder it reads certificates from, for the address list. */
function appDataPath(instance: InstanceConfig): string {
  return findAppCapabilities(instance.sourceUrl)?.companionDb?.appDataPath || '/data';
}

/** The stored join code, decoded; null when there is none or it no longer decrypts or decodes. */
export function storedJoin(instance: InstanceConfig): JoinCode | null {
  const text = instance.fleetJoin?.code;
  if (!text) return null;
  const d = decodeJoinCode(text);
  return d.ok ? d.code : null;
}

/** The list the bot gets, from the registry alone; null when the stored code cannot be read or the instance holds the main itself. */
export function computeEnvList(instance: InstanceConfig): string[] | null {
  if (instance.fleetDb) return null;
  const join = instance.fleetJoin;
  const code = storedJoin(instance);
  if (!join || !code) return null;
  const rec = instance.fleetDbReplica;
  const local = rec && rec.copyCleared !== true && typeof rec.seededAt === 'number'
    ? { container: rec.containerName, ...(rec.publicHost && rec.hostPort ? { host: rec.publicHost, port: rec.hostPort } : {}) }
    : undefined;
  const sameMain = sameManagerMain(code);
  const others = (join.addresses ?? []).flatMap(a => {
    try { return [{ host: a.host, port: a.port, fp: certFingerprint(a.cert) }]; } catch { return []; }
  });
  return addressList({
    app: code.app,
    db: code.db,
    certDir: `${appDataPath(instance)}/db-certs`,
    local,
    main: { host: code.host, port: code.port, fp: code.fp, ...(sameMain?.fleetDb ? { container: sameMain.fleetDb.containerName } : {}) },
    others,
  });
}

/**
 * F1: the companion URL key holds the computed list. Written and the running bot marked for an Apply only when the
 * value differs. Throws when the env store refuses the write. The instance is read here, in the same synchronous step as
 * the env write, so a join or copy record saved while the caller awaited is never overwritten by an older one.
 */
export async function writeEnvList(botId: string, opts: { mark?: boolean } = {}): Promise<{ changed: boolean; markError?: string }> {
  const instance = containerManager.getBot(botId);
  if (!instance) return { changed: false };
  const key = findAppCapabilities(instance.sourceUrl)?.companionDb?.env.url;
  const list = computeEnvList(instance);
  if (!key || !list || list.length === 0) return { changed: false };
  const value = formatBackendUrlList(list);
  if ((envManager.getEnvVars(instance.id)[key] || '').trim() === value) return { changed: false };
  envManager.setEnvVars(instance.id, { [key]: value });
  if (opts.mark === false) return { changed: true };
  try {
    await containerManager.markPendingApplyIfRunning(instance.id);
    return { changed: true };
  } catch (err) {
    return { changed: true, markError: errorText(err) };
  }
}

/** The copy's own facts, read over docker exec: in recovery, system id, timeline, position, and whether it streams. */
export interface CopyFacts {
  inRecovery: boolean;
  streaming: boolean;
  systemId: string;
  timeline: number;
  lsn: bigint;
}

export async function readCopyFacts(rec: { containerName: string; user?: string; db?: string }): Promise<{ ok: true; facts: CopyFacts } | { ok: false; reason: string }> {
  if (!rec.user || !rec.db) return { ok: false, reason: 'its record has no database identity to read it with' };
  const sql = `SELECT pg_is_in_recovery()::text, COALESCE((SELECT status FROM pg_stat_wal_receiver LIMIT 1), ''),
    (SELECT system_identifier FROM pg_control_system()), (SELECT timeline_id FROM pg_control_checkpoint()),
    COALESCE(GREATEST(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn())::text, pg_current_wal_lsn()::text)`;
  const args = ['exec', rec.containerName, 'psql', '-U', MANAGER_DB_ROLE, '-d', rec.db, '-Atc', sql];
  const r = await dbLogin.asManager({ container: rec.containerName, user: rec.user }, role => new Promise<{ ok: boolean; out: string }>(resolve => {
    execFile('docker', dbLogin.withRole(args, role), { timeout: COPY_TIMEOUT_MS }, (err, stdout, stderr) => resolve({ ok: !err, out: err ? String(stderr || err.message) : String(stdout) }));
  }), x => !x.ok && dbLogin.isMissingManagerRole(x.out));
  if (!r.ok) return { ok: false, reason: "the copy's database did not answer" };
  const [rec_, status, systemId, timeline, lsnText] = r.out.trim().split('|');
  const lsn = lsnToBigInt(lsnText);
  if ((rec_ !== 'true' && rec_ !== 'false') || !/^\d+$/.test(systemId || '') || !/^\d+$/.test(timeline || '') || lsn === null) {
    return { ok: false, reason: "the copy's database did not answer" };
  }
  return { ok: true, facts: { inRecovery: rec_ === 'true', streaming: status === 'streaming', systemId, timeline: Number(timeline), lsn } };
}

/** The copy's own server certificate, read from its running container. */
export function readCopyCert(containerName: string): Promise<string | null> {
  return new Promise(resolve => {
    execFile('docker', ['exec', containerName, 'cat', `${PGDATA}/server.crt`], { timeout: READ_TIMEOUT_MS }, (err, stdout) => {
      const pem = err ? '' : String(stdout).trim();
      resolve(CERT_PEM_RE.test(pem) ? pem : null);
    });
  });
}

/** The name other machines see for this machine: its address when it has one, else the instance's name. */
export function machineNameOf(instance: InstanceConfig): string {
  return machineText(instance.fleetDbReplica?.publicHost || instance.fleetDb?.replication?.publicHost || instance.displayName || '');
}

export type JoinResult = { success: true; message: string; addressCount: number } | { success: false; error: string };

export interface JoinOpts {
  inBuild?: boolean;
  emit?: (msg: string) => void;
}

const COMPANION_REFUSAL = 'This app declares no managed database companion';

/** J2's checks that need no network; null admits. */
function joinAdmission(instance: InstanceConfig, code: JoinCode): string | null {
  const spec = findAppCapabilities(instance.sourceUrl)?.companionDb;
  if (!spec) return COMPANION_REFUSAL;
  const own = instance.fleetDb?.replication;
  if (own && own.publicHost?.toLowerCase() === code.host.toLowerCase() && own.hostPort === code.port) return "That join code is this instance's own database.";
  if (instance.fleetDb) return 'This instance holds the main database itself, so it cannot join another one.';
  const store = envManager.getEnvVarsWithStatus(instance.id);
  if (store.corrupt) return 'The env store for this instance cannot be read (a copy is kept beside it as storage.json.corrupt-<time> when it could be read); restore it before joining';
  if (spec.env.mode) {
    const merged = { ...(instance.envVars ?? {}), ...store.vars };
    if ((merged[spec.env.mode.key] || '').trim().toLowerCase() !== spec.env.mode.value) {
      return 'This bot keeps its data in JSON files (Data Backend is file). Set Data Backend to postgres in the env editor first; a bot that already holds data in JSON files moves it with the JSON-to-Postgres migration instead.';
    }
  }
  const fault = containerManager.registryFault();
  if (fault) return fault;
  return null;
}

async function joinRun(instance: InstanceConfig, code: JoinCode, text: string, opts: JoinOpts): Promise<JoinResult> {
  const refusal = joinAdmission(instance, code);
  if (refusal) return { success: false, error: refusal };
  const cert = await mainCertificate(code);
  if (!cert.ok) return { success: false, error: cert.text };
  const pulled = await ensureClientImage();
  if (pulled) return { success: false, error: pulled };
  const probe = await mainProbe(instance, code, cert.pem);
  if (!probe.ok) return { success: false, error: probeFailureText(code, probe) };
  if (probe.facts.inRecovery) return { success: false, error: inRecoveryText(code.host, code.port) };
  const rec = instance.fleetDbReplica;
  if (rec && rec.copyCleared !== true) {
    const copy = await readCopyFacts(rec);
    if (!copy.ok) return { success: false, error: "The copy on this machine did not answer, so the manager can't confirm it belongs to the database in this join code; nothing was changed. Start the instance and try again." };
    if (copy.facts.systemId !== probe.facts.systemId) {
      return { success: false, error: `This join code is for a different database (system id ${probe.facts.systemId}) from the copy on this machine (system id ${copy.facts.systemId}); nothing was changed. Remove the copy first to follow that database.` };
    }
  }
  const listed = await readAddresses(instance, code, cert.pem);
  const prior = instance.fleetJoin;
  const same = !!prior && prior.code === text;
  // A failed read keeps what was known about the same main; another main starts from itself alone and is read again at the next check.
  const sameMain = same || (!!prior && prior.host === code.host && prior.port === code.port && !!prior.systemId && prior.systemId === probe.facts.systemId);
  const kept = !listed.ok && sameMain ? prior : undefined;
  const addresses = listed.ok ? listed.addresses : (kept?.addresses ?? []);
  const readAt = listed.ok ? Date.now() : kept?.addressesReadAt;
  const certError = await writeCertFiles(instance, [cert.pem, ...addresses.map(a => a.cert)]);
  if (certError) return { success: false, error: certError };
  const record: FleetJoinRecord = {
    code: text,
    host: code.host,
    port: code.port,
    db: code.db,
    fp: code.fp,
    machine: code.machine,
    joinedAt: new Date().toISOString(),
    systemId: probe.facts.systemId,
    addresses,
    ...(typeof readAt === 'number' ? { addressesReadAt: readAt } : {}),
    ...(listed.ok ? {} : { addressesError: `The list of the other databases could not be read from the main (${listed.reason}); the manager tries again every hour.` }),
  };
  try {
    containerManager.updateInstanceFleetJoin(instance.id, same && prior ? { ...record, joinedAt: prior.joinedAt } : record);
  } catch (err) {
    return { success: false, error: `The join code could not be saved (${errorText(err)}); the database addresses were not changed.` };
  }
  const saved = containerManager.getBot(instance.id);
  const copy = saved?.fleetDbReplica;
  if (saved && copy && copy.copyCleared !== true && typeof copy.seededAt === 'number' && copy.publicHost) {
    const registered = await registerOwnCopy(saved, cert.pem);
    if (registered) console.warn(`[FleetCopy] ${instance.displayName}: the copy's address could not be added to the main's list: ${registered}`);
  }
  const count = computeEnvList(containerManager.getBot(instance.id) ?? instance)?.length ?? 1;
  let written: { changed: boolean; markError?: string };
  try {
    written = await writeEnvList(instance.id, { mark: !opts.inBuild });
  } catch (err) {
    return { success: false, error: `The join code is saved, but the Database URL could not be written (${errorText(err)}). The manager writes it again within 5 minutes; press Join again to try now.` };
  }
  let message = `Joined the main at ${code.host}:${code.port}. The bot uses the ${count} database address(es) from its next start (Apply on the card, or Restart).`;
  if (rec && (rec.primaryHost !== code.host || rec.primaryPort !== code.port)) {
    message += ` The copy on this machine still follows ${rec.primaryHost}:${rec.primaryPort}; press Re-seed to rebuild it from ${code.host}:${code.port}.`;
  }
  if (!listed.ok) message += ` ${record.addressesError}`;
  if (written.markError) message += ` The manager could not record that the bot must be recreated (${written.markError}); Restart the instance so the bot uses them.`;
  return { success: true, message, addressCount: count };
}

/** O3 and O4: join the main a code names. Outside a build it takes the instance's op lock. */
export async function joinFleet(instance: InstanceConfig, codeText: string, opts: JoinOpts = {}): Promise<JoinResult> {
  const text = String(codeText ?? '').replace(/\s+/g, '');
  const decoded = decodeJoinCode(text);
  if (!decoded.ok) return { success: false, error: `This is not a join code: ${decoded.why}` };
  if (opts.inBuild) return joinRun(instance, decoded.code, text, opts);
  if (!findAppCapabilities(instance.sourceUrl)?.companionDb) return { success: false, error: COMPANION_REFUSAL };
  const busy = containerManager.isBotBusy(instance.id);
  if (busy) return { success: false, error: `Operation '${busy}' is running on this instance; wait for it to finish` };
  try {
    return await containerManager.withExternalBotOp(instance.id, 'fleet-join', async () => {
      const fresh = containerManager.getBot(instance.id);
      if (!fresh) return { success: false as const, error: 'Bot not found' };
      return joinRun(fresh, decoded.code, text, opts);
    });
  } catch (err) {
    return { success: false, error: errorText(err) };
  }
}

/**
 * O4: a join code pasted into the Database URL field is joined by the build that finds it. Returns the refusal the
 * build ends with, or null.
 */
export async function resolveStoredJoinCode(instance: InstanceConfig, emit: (msg: string, type?: 'info' | 'error' | 'warning' | 'system') => void): Promise<string | null> {
  const key = findAppCapabilities(instance.sourceUrl)?.companionDb?.env.url;
  if (!key) return null;
  let stored = '';
  try {
    stored = (envManager.getEnvVars(instance.id)[key] || '').trim();
  } catch {
    return null;
  }
  if (!isJoinCode(stored)) return null;
  const text = stored.replace(/\s+/g, '');
  if (instance.fleetJoin?.code === text) {
    try {
      await writeEnvList(instance.id, { mark: false });
      return null;
    } catch (err) {
      return `The join code in the Database URL could not be used: The join code is saved, but the Database URL could not be written (${errorText(err)}).`;
    }
  }
  emit('[Fleet] Checking the join code in the Database URL...');
  const result = await joinFleet(instance, text, { inBuild: true });
  if (!result.success) {
    const error = `The join code in the Database URL could not be used: ${result.error}`;
    emit(`[Error] ${error}`, 'error');
    return error;
  }
  const decoded = decodeJoinCode(text);
  const where = decoded.ok ? `${decoded.code.host}:${decoded.code.port}` : 'the main';
  emit(`[Fleet] Joined the main at ${where}; the Database URL now lists ${result.addressCount} database address(es)`);
  return null;
}

/** The copy's own address row, when this machine holds a seeded copy with an address. */
async function ownRow(instance: InstanceConfig): Promise<JoinAddress | null> {
  const rec = instance.fleetDbReplica;
  if (!rec || rec.copyCleared === true || typeof rec.seededAt !== 'number' || !rec.publicHost || !rec.hostPort) return null;
  const cert = await readCopyCert(rec.containerName);
  if (!cert) return null;
  return { host: rec.publicHost, port: rec.hostPort, slot: rec.slot, cert, machine: machineNameOf(instance) };
}

/** Registers this machine's copy on the main's list; null when done or nothing to register, else the reason. */
export async function registerOwnCopy(instance: InstanceConfig, pem?: string): Promise<string | null> {
  const code = storedJoin(instance);
  if (!code) return 'the stored join code cannot be read';
  const row = await ownRow(instance);
  if (!row) return instance.fleetDbReplica?.publicHost ? "the copy's certificate could not be read" : null;
  let mainPem = pem;
  if (!mainPem) {
    const cert = await mainCertificate(code);
    if (!cert.ok) return cert.reason;
    mainPem = cert.pem;
  }
  return registerAddress(instance, code, mainPem, row);
}

/** F2 and F3: the hourly read of the main. Records the error and keeps the list on any failure. */
export async function refreshJoin(instance: InstanceConfig): Promise<void> {
  const join = instance.fleetJoin;
  if (!join) return;
  const code = storedJoin(instance);
  if (!code) return;
  const startedCode = join.code;
  const keep = (error: string) => {
    const now = containerManager.getBot(instance.id);
    if (!now?.fleetJoin || now.fleetJoin.code !== startedCode) return;
    containerManager.updateInstanceFleetJoin(instance.id, { ...now.fleetJoin, addressesError: error });
  };
  const cert = await mainCertificate(code);
  if (!cert.ok) return keep(cert.text);
  const probe = await mainProbe(instance, code, cert.pem);
  if (!probe.ok) return keep(probeFailureText(code, probe));
  if (probe.facts.inRecovery) return keep(inRecoveryText(code.host, code.port));
  if (join.systemId && probe.facts.systemId !== join.systemId) {
    return keep(`The database at ${code.host}:${code.port} is not the one this machine joined (its system id changed), so the address list was not updated; copy a new join code from the main's manager.`);
  }
  const listed = await readAddresses(instance, code, cert.pem);
  if (!listed.ok) return keep(`The list of the other databases could not be read from the main (${listed.reason}); the manager tries again every hour.`);
  const live = containerManager.getBot(instance.id);
  const registered = live && !containerManager.isBotBusy(instance.id) ? await registerOwnCopy(live, cert.pem) : null;
  if (registered) console.warn(`[FleetCopy] ${instance.displayName}: the copy's address could not be added to the main's list: ${registered}`);
  const certError = await writeCertFiles(instance, [cert.pem, ...listed.addresses.map(a => a.cert)]);
  if (certError) return keep(certError);
  const now = containerManager.getBot(instance.id);
  if (!now?.fleetJoin || now.fleetJoin.code !== startedCode) return;
  const { addressesError: _gone, ...rest } = now.fleetJoin;
  containerManager.updateInstanceFleetJoin(instance.id, { ...rest, systemId: rest.systemId ?? probe.facts.systemId, addresses: listed.addresses, addressesReadAt: Date.now() });
}

/** Whether the hourly read is due, from the durable time of the last good read. */
export function refreshDue(join: FleetJoinRecord, now = Date.now()): boolean {
  return !join.addressesReadAt || now - join.addressesReadAt >= REFRESH_EVERY_MS;
}
