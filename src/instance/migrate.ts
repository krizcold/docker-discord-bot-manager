/**
 * The Migrate control: moves a bot's guild data between JSON files and Postgres by driving its `migrate` hook
 * (contract 9). The record on the instance is written before every effect, so a manager restart resumes the job.
 */
import { randomUUID } from 'crypto';
import { isIPv6 } from 'net';
import * as containerManager from '../docker/containerManager';
import * as envManager from '../env/manager';
import { findAppCapabilities } from '../config/appCapabilities';
import { isBackendUrlList, isJoinCode } from '../config/joinCode';
import { namesDatabaseOf, readDatabaseUrl, DatabaseUrlForm, URL_FORM } from '../config/databaseUrl';
import { callAppHook, AppHookResult } from './appHookClient';
import * as dbLogin from './dbLogin';
import * as fleetBackup from './fleetBackup';
import * as fleetReplica from './fleetReplica';
import * as maintenance from './maintenance';
import { moveModeText, switchStartRefusal } from './switchSql';
import { switchTickOn } from './fleetSwitch';
import { InstanceConfig, MigrateLast, MigratePhase, MigrateRecord, MigrateTo } from '../types';

export const MIGRATE_TIMING = {
  getMs: 10_000,
  postMs: 30_000,
  hookMs: 30_000,
  saveTries: 6,
  savePauseMs: 10_000,
  readyMs: 180_000,
  readyPauseMs: 2_000,
  pollMs: 5_000,
  againMs: 5_000,
  unknownTries: 3,
  unknownPauseMs: 10_000,
  windowMs: 60_000,
  retryPauseMs: 2_000,
  sessionMs: 300_000,
  sessionPauseMs: 15_000,
  silentCheckMs: 120_000,
  silentParkMs: 600_000,
  keepDelaysMs: [30_000, 60_000, 120_000, 240_000, 480_000],
};

const OP = 'migrate';
const CAP = 3;
const KEEP = 5;

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const X = (to: MigrateTo) => (to === 'postgres' ? 'Postgres' : 'JSON files');
/** Q8: replication on the bot's own managed database, or a replication lane (Enable, Disable, adopt) holding its op. */
const replicationOn = (b: InstanceConfig) => !!b.fleetDb?.replication || containerManager.isBotBusy(b.id) === 'replication';
const otherTo = (to: MigrateTo): MigrateTo => (to === 'postgres' ? 'file' : 'postgres');
const seconds = (ms: number) => Math.round(ms / 1000);
const spanText = (ms: number) => (ms >= 600_000 ? '10 minutes' : seconds(ms) === 1 ? '1 second' : `${seconds(ms)} seconds`);

// ─── Pure parts ───

export function mintJobId(): string {
  return `mgr-${randomUUID()}`;
}

export function backendOf(env: Record<string, string | undefined>): MigrateTo {
  return (env.DATA_BACKEND || '').trim().toLowerCase() === 'postgres' ? 'postgres' : 'file';
}

const BEFORE = ['checking', 'draining', 'reading', 'copying', 'verifying', 'rereading', 'committing', 'placing'];
const PAST = ['retire-source', 'switching', 'env'];

/** Where a stage sits against the switch: an unknown stage is read as past it. */
export function stageSide(stage: string | null | undefined): 'before' | 'past' | 'unknown' {
  if (stage && BEFORE.includes(stage)) return 'before';
  if (stage && PAST.includes(stage)) return 'past';
  return 'unknown';
}

type Destination = string | { host?: unknown; port?: unknown; database?: unknown } | null | undefined;

/** host:port/database, lower-case host without IPv6 brackets, default port 5432, no trailing slash; null when unreadable. */
export function identityOf(d: Destination): string | null {
  if (!d) return null;
  let host: string;
  let port: string;
  let db: string;
  if (typeof d === 'string') {
    const s = d.trim();
    if (/^postgres(ql)?:\/\//i.test(s)) {
      try {
        const u = new URL(s);
        host = u.hostname;
        port = u.port;
        db = decodeURIComponent(u.pathname.replace(/^\//, ''));
      } catch {
        return null;
      }
    } else {
      const v6 = /^([^/\[\]]*:[^/\[\]]*):(\d+)\/(.+)$/.exec(s);
      const m = /^(\[[^\]]+\]|[^:/]+)(?::(\d*))?\/(.+)$/.exec(s) || (v6 && isIPv6(v6[1]) ? v6 : null);
      if (!m) return null;
      host = m[1];
      port = m[2] || '';
      db = m[3];
    }
  } else {
    if (typeof d.host !== 'string' || typeof d.database !== 'string') return null;
    host = d.host;
    port = d.port === undefined || d.port === null ? '' : String(d.port);
    db = d.database;
  }
  host = host.replace(/^\[|\]$/g, '').toLowerCase();
  db = db.replace(/\/+$/, '');
  if (!host || !db) return null;
  return `${host}:${port || '5432'}/${db}`;
}

export function sameDatabase(a: Destination, b: Destination): boolean {
  const x = identityOf(a);
  return x !== null && x === identityOf(b);
}

const DISPLAY = (identity: string | null) => {
  if (!identity) return 'no database';
  const [hostPort, db] = [identity.slice(0, identity.indexOf('/')), identity.slice(identity.indexOf('/') + 1)];
  const i = hostPort.lastIndexOf(':');
  const host = hostPort.slice(0, i);
  return `${host.includes(':') ? `[${host}]` : host}${hostPort.slice(i)}/${db}`;
};

export type HookAnswer =
  | { kind: 'answer'; status: number; body: any }
  | { kind: 'nohook' }
  | { kind: 'auth'; status: number; error: string }
  | { kind: 'refusal'; status: number; error: string }
  | { kind: 'cantconfirm'; status: number; error: string }
  | { kind: 'unusable'; status: number; error: string }
  | { kind: 'noanswer'; error: string; unknown: boolean };

const STATES = ['running', 'done', 'failed', 'interrupted'];
const CANT_CONFIRM = /can.t confirm which store holds the data/i;

function readableJob(job: unknown): boolean {
  if (job === null) return true;
  if (!job || typeof job !== 'object') return false;
  const j = job as Record<string, unknown>;
  return typeof j.jobId === 'string' && typeof j.state === 'string' && STATES.includes(j.state) && (j.to === 'postgres' || j.to === 'file');
}

/** Every hook answer by its status and its parsed body; only a timeout or a transport failure is no answer. */
export function hookAnswer(r: AppHookResult, method: 'GET' | 'POST'): HookAnswer {
  if (r.status === undefined || r.unknown) return { kind: 'noanswer', error: r.error || 'no answer', unknown: r.unknown === true };
  const status = r.status;
  const body = r.body && typeof r.body === 'object' ? (r.body as Record<string, any>) : null;
  const bodyError = body && typeof body.error === 'string' ? body.error : null;
  if (status === 404) return { kind: 'nohook' };
  if (status === 401 || status === 403) return { kind: 'auth', status, error: bodyError ?? `the bot answered HTTP ${status}` };
  const ok2xx = status >= 200 && status < 300;
  if (method === 'POST') {
    if (ok2xx && body?.success === true) return { kind: 'answer', status, body };
    if (body && body.success === false && bodyError !== null) return { kind: 'refusal', status, error: bodyError };
    return { kind: 'refusal', status, error: `the bot answered HTTP ${status}` };
  }
  if (body && body.success === false && bodyError !== null && CANT_CONFIRM.test(bodyError)) return { kind: 'cantconfirm', status, error: bodyError };
  if (ok2xx && body?.success === true && readableJob(body.job)) return { kind: 'answer', status, body };
  return { kind: 'unusable', status, error: bodyError ?? (ok2xx ? 'the answer holds no readable job' : `the bot answered HTTP ${status}`) };
}

/** NB3-RS-2 and NB3-RS-4 retry in the readiness window; the open session refusal (S0's on the POST, S2's at checking) retries for 5 minutes. */
export function transientRefusal(error: string, allowed: readonly string[] = []): 'transient' | 'session' | null {
  if (error.startsWith('The bot process is still starting') || error.startsWith('A start or restart of the bot is in progress')) return 'transient';
  if (error.startsWith("can't confirm; migration ") && error.includes('session is still open')) return 'session';
  const parts = sessionParts(error);
  return parts && parts.every(p => p.last || allowed.includes(p.jobId)) ? 'session' : null;
}

const SESSION_LAST = /^Migration (.+?)'s database session is still open; the database ends it once it notices the connection is gone; run the migration again once it no longer shows$/;
const SESSION_OTHER = /^Migration (.+?), which is not this bot's last one, holds a session on this database; run this migration once it no longer shows$/;

/** S2's text as its migration-session parts (bot:929 joins them with ". "); null when any part is another text. */
function sessionParts(error: string): Array<{ jobId: string; last: boolean }> | null {
  const out: Array<{ jobId: string; last: boolean }> = [];
  for (const part of error.split('. ')) {
    const a = SESSION_LAST.exec(part);
    const b = a ? null : SESSION_OTHER.exec(part);
    if (!a && !b) return null;
    out.push({ jobId: (a ?? b)![1], last: !!a });
  }
  return out;
}

function sessionJobIds(error: string): string[] {
  return (sessionParts(error) ?? []).map(p => p.jobId);
}

export type Job = { jobId: string; state: string; to: MigrateTo; stage?: string; error?: string; destination?: unknown; leftOut?: unknown };

type RecView = Pick<MigrateRecord, 'to' | 'jobId' | 'jobIds' | 'started' | 'kept' | 'posted'>;

/** A job of this record (jobIds), of its `to`, with no done or failed result, whose stage is past the switch or unknown. */
export function pastSwitch(job: Job | null, rec: RecView): boolean {
  if (!job) return false;
  if (!rec.jobIds.includes(job.jobId) || job.to !== rec.to) return false;
  if (job.state === 'done' || job.state === 'failed') return false;
  return stageSide(job.stage) !== 'before';
}

export type Keep =
  | { kind: 'stage'; stage: string; error: string }
  | { kind: 'cantconfirm'; error: string }
  | { kind: 'noanswer'; error: string }
  | { kind: 'unusable'; status: number; error: string };

export type PostVerdict =
  | { act: 'follow'; jobId: string; started: boolean }
  | { act: 'done'; jobId: string }
  | { act: 'interrupted'; job: Job }
  | { act: 'failed'; job: Job }
  | { act: 'park'; why: 'otherjob' | 'nohook' | 'auth'; job?: Job; status?: number; error?: string }
  | { act: 'close'; why: 'nohook' | 'auth'; status?: number; error?: string }
  | { act: 'retry'; why: 'unknown' | 'unreachable' | 'session'; error: string }
  | { act: 'refusal'; error: string };

const jobOf = (b: any): Job => ({
  jobId: String(b.jobId), state: String(b.state), to: b.to, stage: typeof b.stage === 'string' ? b.stage : undefined,
  error: typeof b.error === 'string' ? b.error : undefined, destination: b.destination, leftOut: b.leftOut,
});

/** C: the answer to M7; `posted` is the record's before this POST. */
export function postVerdict(a: HookAnswer, rec: RecView): PostVerdict {
  if (a.kind === 'noanswer') return { act: 'retry', why: a.unknown ? 'unknown' : 'unreachable', error: a.error };
  if (a.kind === 'nohook') return rec.posted ? { act: 'park', why: 'nohook' } : { act: 'close', why: 'nohook' };
  if (a.kind === 'auth') return rec.posted ? { act: 'park', why: 'auth', status: a.status, error: a.error } : { act: 'close', why: 'auth', status: a.status, error: a.error };
  if (a.kind !== 'answer') {
    return transientRefusal(a.error) === 'session' ? { act: 'retry', why: 'session', error: a.error } : { act: 'refusal', error: a.error };
  }
  const b = a.body;
  if (typeof b.jobId !== 'string' || !['started', ...STATES].includes(b.state) || (b.to !== 'postgres' && b.to !== 'file')) {
    return { act: 'refusal', error: `the bot answered without a job it names (state ${String(b.state)})` };
  }
  if (b.to !== rec.to) return { act: 'park', why: 'otherjob', job: jobOf(b) };
  if (b.state === 'started') return { act: 'follow', jobId: b.jobId, started: true };
  if (b.state === 'running') return { act: 'follow', jobId: b.jobId, started: false };
  if (b.state === 'done') return { act: 'done', jobId: b.jobId };
  if (b.state === 'failed') return { act: 'failed', job: jobOf(b) };
  return { act: 'interrupted', job: jobOf(b) };
}

export type InterruptVerdict = { act: 'again' } | { act: 'spent' } | { act: 'keep'; keep: Keep };

/** D4 to D7: an interrupted job of this record. */
export function interruptVerdict(job: Job, rec: RecView): InterruptVerdict {
  if (stageSide(job.stage) === 'before') return rec.started < CAP ? { act: 'again' } : { act: 'spent' };
  return { act: 'keep', keep: { kind: 'stage', stage: job.stage ?? '', error: job.error || 'the bot gave no error' } };
}

export type GetVerdict =
  | { act: 'poll'; job: Job }
  | { act: 'follow'; jobId: string }
  | { act: 'done'; job: Job }
  | { act: 'failed'; job: Job }
  | { act: 'transient'; why: 'transient' | 'session'; job: Job }
  | { act: 'again'; job: Job }
  | { act: 'spent'; job: Job }
  | { act: 'keep'; keep: Keep }
  | { act: 'repost'; why: 'other' | 'null'; job?: Job }
  | { act: 'park'; why: 'otherrun' | 'nohook' | 'auth'; job?: Job; status?: number; error?: string }
  | { act: 'silent'; unusable: { status: number; error: string } | null; error: string };

/** D: a GET while following the record's job. */
export function getVerdict(a: HookAnswer, rec: RecView, sessionJobs: readonly string[] = []): GetVerdict {
  if (a.kind === 'nohook') return { act: 'park', why: 'nohook' };
  if (a.kind === 'auth') return { act: 'park', why: 'auth', status: a.status, error: a.error };
  if (a.kind === 'cantconfirm') return { act: 'keep', keep: { kind: 'cantconfirm', error: a.error } };
  if (a.kind === 'noanswer') return { act: 'silent', unusable: null, error: a.error };
  if (a.kind === 'unusable' || a.kind === 'refusal') return { act: 'silent', unusable: { status: a.status, error: a.error }, error: a.error };
  if (a.body.job === null) return { act: 'repost', why: 'null' };
  const job = jobOf(a.body.job);
  if (job.jobId === rec.jobId && job.to === rec.to) {
    if (job.state === 'running') return { act: 'poll', job };
    if (job.state === 'done') return { act: 'done', job };
    if (job.state === 'failed') {
      const why = job.stage === 'checking' && job.error ? transientRefusal(job.error, [...rec.jobIds, ...sessionJobs]) : null;
      return why ? { act: 'transient', why, job } : { act: 'failed', job };
    }
    const v = interruptVerdict(job, rec);
    return v.act === 'keep' ? v : { act: v.act, job };
  }
  if (job.to === rec.to) {
    if (job.state === 'done') return { act: 'done', job };
    if (job.state === 'running') return { act: 'follow', jobId: job.jobId };
    if (pastSwitch(job, rec)) return { act: 'keep', keep: { kind: 'stage', stage: job.stage ?? '', error: job.error || 'the bot gave no error' } };
    return { act: 'repost', why: 'other', job };
  }
  if (job.state === 'running') return { act: 'park', why: 'otherrun', job };
  return { act: 'repost', why: 'other', job };
}

export type RefusalVerdict =
  | { act: 'done'; job: Job }
  | { act: 'follow'; jobId: string }
  | { act: 'keep'; keep: Keep }
  | { act: 'close' }
  | { act: 'park'; why: 'auth' | 'nohook'; status?: number; error?: string };

/** E: the GET read before acting on a refusal. */
export function refusalVerdict(a: HookAnswer, rec: RecView): RefusalVerdict {
  if (a.kind === 'auth') return { act: 'park', why: 'auth', status: a.status, error: a.error };
  if (a.kind === 'nohook') return { act: 'park', why: 'nohook' };
  if (a.kind === 'cantconfirm') return { act: 'keep', keep: { kind: 'cantconfirm', error: a.error } };
  if (a.kind === 'noanswer') return { act: 'keep', keep: { kind: 'noanswer', error: a.error } };
  if (a.kind === 'unusable' || a.kind === 'refusal') return { act: 'keep', keep: { kind: 'unusable', status: a.status, error: a.error } };
  if (a.body.job === null) return { act: 'close' };
  const job = jobOf(a.body.job);
  if (job.to === rec.to && job.state === 'done') return { act: 'done', job };
  if (job.to === rec.to && job.state === 'running') return { act: 'follow', jobId: job.jobId };
  if (pastSwitch(job, rec)) return { act: 'keep', keep: { kind: 'stage', stage: job.stage ?? '', error: job.error || 'the bot gave no error' } };
  return { act: 'close' };
}

export function keepDelay(kept: number): number {
  const d = MIGRATE_TIMING.keepDelaysMs;
  return d[Math.min(Math.max(kept, 0), d.length - 1)];
}

/** MG-KEPT's clause for what the bot left, by direction and stage. */
export function keptClause(keep: Keep, to: MigrateTo): string {
  if (keep.kind === 'cantconfirm') return "the bot can't confirm which store holds the data, and its boot refuses until that is settled";
  if (keep.kind === 'noanswer') return "the bot did not answer, so the manager can't confirm which store holds the data";
  if (keep.kind === 'unusable') return `the bot gave an answer the manager cannot use (HTTP ${keep.status}: ${keep.error}), so the manager can't confirm which store holds the data`;
  const stage = keep.stage;
  if (to === 'file' && stage === 'retire-source') return "the manager can't confirm whether the old database store was renamed aside, and until the migration finishes the bot refuses to boot on either store";
  if (to === 'file' && stage === 'switching') return 'the old database store is renamed aside and the switch to JSON files is not written, so until the migration finishes the bot refuses to boot on either store';
  if (to === 'postgres' && stage === 'switching') return 'the copy in Postgres is committed and the switch to it is not written; the JSON files still hold the data, and a boot loads them';
  if (stage === 'env' || (stage === 'retire-source' && to === 'postgres')) return `the bot reports stage ${stage}, which a managed bot moving to ${X(to)} does not reach, so the manager can't confirm which store holds the data`;
  return `the bot reports stage ${stage || 'none'}, which this manager does not know, so it can't confirm which store holds the data`;
}

export type DestinationPlan =
  | { ok: true; companion: boolean; destination: string | null; url: string }
  | { ok: false; refusal: 'list' | 'join' | 'badurl' }
  | { ok: false; refusal: 'form'; form: DatabaseUrlForm };

/** Where a move goes (to postgres) or what it reads (to file): A12 to A14 and A42. */
export function destinationPlan(inst: Pick<InstanceConfig, 'sanitizedName' | 'fleetDb'>, url: string, to: MigrateTo, database = 'smdb', env: Record<string, string> = {}): DestinationPlan {
  const u = url.trim();
  const read = readDatabaseUrl(u, env);
  if (read.form && read.form !== 'scheme' && read.form !== 'unparsed') return { ok: false, refusal: 'form', form: read.form };
  if (isBackendUrlList(u)) return { ok: false, refusal: 'list' };
  if (isJoinCode(u)) return { ok: false, refusal: 'join' };
  const db = inst.fleetDb && !inst.fleetDb.retiringAt ? inst.fleetDb : inst.fleetDb ?? null;
  const containerName = db?.containerName || `${inst.sanitizedName}-fleet-postgres`;
  if (u === '') {
    if (to === 'file') return { ok: true, companion: false, destination: null, url: '' };
    return { ok: true, companion: true, destination: identityOf(`${containerName}:5432/${db?.db || database}`), url: '' };
  }
  if (read.form || !read.addresses[0]) return { ok: false, refusal: 'badurl' };
  const companion = !!db && namesDatabaseOf(read.addresses[0], db);
  return { ok: true, companion: to === 'postgres' && companion, destination: to === 'postgres' ? identityOf(u) : null, url: u };
}

// ─── Texts ───

const T = {
  badTo: 'The migration target must be postgres or file',
  noApp: 'This app has no Data Backend setting, so the manager cannot migrate its data; nothing was changed',
  noHooks: 'This app declares no lifecycle hooks, so the manager cannot ask it to migrate its data; nothing was changed',
  otherTo: (x: string) => `A migration to ${x} is open on this bot; press Migrate to ${x} to go on with it; nothing was changed`,
  same: (x: string) => `The bot's Data Backend is already ${x}, so there is nothing to migrate; nothing was changed`,
  list: 'The Database URL lists several database addresses (live copies on other machines); a migration needs one database address, so remove the live copies first; nothing was changed',
  join: 'The Database URL holds a join code the manager has not checked yet; a migration needs one database address; nothing was changed',
  badUrl: 'The Database URL is not a postgresql:// address the manager can read; nothing was changed',
  running: 'Migrate runs with the bot in Maintenance; choose Maintenance in State first; nothing was changed',
  off: 'The bot is Off, and Migrate needs it running in Maintenance; choose Maintenance in State first; nothing was changed',
  unsettled: (state: string, err: string) => `The bot's change to ${state} is not confirmed yet (${err}), and Migrate waits for a confirmed Maintenance; nothing was changed`,
  stopped: 'The bot is stopped, and Migrate needs it running in Maintenance; start it, then press Migrate again; nothing was changed',
  notice: (file: string) => `A restore of ${file} has not finished cleanly (its notice is on the Database window), so the migration was refused; restore a dump again, or dismiss the notice first; nothing was changed`,
  fence: (state: string, remedy: string | null) => `The bot's database is READ-ONLY (${state}), so the migration was refused; nothing was changed${remedy ? `; ${remedy}` : ''}`,
  fenceRead: (err: string) => `The manager can't confirm whether the bot's database is READ-ONLY (${err}), so the migration was refused; nothing was changed`,
  switchH: (mode: string) => `A move of this database is recorded (${mode}); finish it or cancel it in the Database window before migrating; nothing was changed`,
  switchV: 'This database is waiting to receive a main from another machine; stop receiving before migrating; nothing was changed',
  switchR: (machine: string) => `${machine} replaced this database as the main; rejoin this machine as a copy before migrating; nothing was changed`,
  switchC: 'Two main databases with the same generation are recorded; settle which one stays the main before migrating; nothing was changed',
  switchP: (dump: string) => `A push into this database did not finish, so it may hold no data or data no one checked; restore the dump ${dump} or receive a push again before migrating; nothing was changed`,
  tick: "The manager's check of this bot's main database is running right now; press Migrate again in a minute; nothing was changed",
  seed: 'A live copy seed is running on this instance; wait for it before migrating; nothing was changed',
  noHookA: "This bot's build has no migrate hook (it answered 404); update the bot to a build that has one; nothing was changed",
  noAnswerA: (err: string) => `The bot did not answer (${err}), so the migration was refused; nothing was changed`,
  unusableA: (status: number, err: string) => `The bot gave an answer the manager cannot use (HTTP ${status}: ${err}), so the migration was refused; nothing was changed`,
  cantReadA: (err: string) => `The bot can't confirm which store holds its data (${err}), so the migration was refused; nothing was changed`,
  otherRun: (jobId: string, x: string, ours: string) => `The bot is running migration ${jobId} to ${x}, so a migration to ${ours} was refused; nothing was changed`,
  notRec: (err: string) => `The migration could not be recorded (${err}), so nothing was changed`,
  fleetJoin: "This bot joined another machine's database with a join code, so its data lives in that fleet's main database; a migration needs a database of its own, so leave the fleet first; nothing was changed",
  fleetRepl: 'This database has replication on, so a migration to JSON files would retire the store on every live copy and for every machine of the fleet; turn replication off first; nothing was changed',
  authA: (status: number, err: string) => `The bot refused the manager's token (HTTP ${status}: ${err}), so the migration was refused; nothing was changed`,
  heldMigrate: (other: string, x: string) => `${other}'s data migration to ${x} is open on the database this bot uses, so this bot cannot migrate until that migration ends; nothing was changed`,
  changed: "The bot's Data Backend or its Database URL changed while the migration was being admitted; press Migrate again; nothing was changed",
  ownerHosted: (owner: string) => `The Database URL names a database in ${owner}'s managed database container, so the migration was refused: Migrate moves data only to or from this bot's own managed database or a database outside this manager's containers, and Migrate on ${owner} moves ${owner}'s own data; nothing was changed`,
  fleetReplOn: "This bot's managed database has replication on, and the manager's check of it as the fleet's main database pauses while a migration of this bot is open, so the migration was refused; turn replication off first; nothing was changed",
  urlForm: (form: DatabaseUrlForm) => `The Database URL ${URL_FORM[form].what}, so the manager can't tell which database the bot's Postgres driver connects to, and the migration was refused; ${URL_FORM[form].instead}; nothing was changed`,

  dbSetup: (err: string) => `The migration did not start: the managed database could not be set up (${err}). Nothing was copied, and the bot stays in Maintenance.`,
  dbStart: (err: string) => `The migration did not start: the managed database did not start (${err}). Nothing was copied, and the bot stays in Maintenance.`,
  login: (reason: string) => `The migration did not start: the bot's database login could not be opened (${reason}). Nothing was copied, and the bot stays in Maintenance.`,
  unsaved: (g: number, f: number) => `The migration did not start: the bot reports changes it could not save (${g} guild(s), ${f} file(s)), and a migration now would leave them behind. Nothing was copied, and the bot stays in Maintenance; its log names what it could not save. Press Migrate again once they are saved.`,
  unsavedUnknown: (reason: string) => `The migration did not start: the bot did not confirm that it saved every change it holds (${reason}). Nothing was copied, and the bot stays in Maintenance; press Migrate to try again.`,
  cSharerBusy: (name: string, op: string) => `${name} uses the same database and is running '${op}'`,
  cSharer: (name: string, err: string) => `${name} uses the same database and could not be stopped (${err})`,
  cSharerStill: (name: string) => `${name} uses the same database, and docker still shows its container running after the manager stopped it`,
  cSharerOpen: (name: string, x: string) => `${name} uses the same database and has its own data migration to ${x} open, so it was not stopped`,
  cSharerShared: (name: string, other: string, x: string) => `${name} uses the same database, and ${other}'s open migration to ${x} already holds it, so it was not stopped`,
  cSharerRepl: (name: string) => `${name} uses the same database, and ${name}'s own managed database has replication on; the manager's check of that database as its fleet's main pauses while this migration holds ${name}, so ${name} was not stopped`,
  cFence: (why: string) => `the manager could not close the bot's database to other connections (${why}), which a move to JSON files from that database needs before the bot renames its data aside`,
  retryStill: 'press Migrate to stop it again',
  retryOpen: (name: string) => `press Migrate again once ${name}'s migration ends`,
  retryShared: 'press Migrate again once that migration ends',
  retryRepl: (name: string) => `turn replication off on ${name}, then press Migrate again`,
  notStarted: (r: SharerRefusal) => `The migration did not start: ${r.clause}. Nothing was copied, and the bot stays in Maintenance${r.retry ? `; ${r.retry}` : ''}.`,
  notReposted: (r: SharerRefusal) => `The manager did not ask the bot to start the migration again: ${r.clause}. The bot stays in Maintenance with the migration open; ${r.retry ?? 'press Migrate to try again'}.`,
  restart: (err: string, tail: string) => `The migration did not start: the restart into maintenance failed (${err}). Nothing was copied, and the bot's state stays Maintenance.${tail}`,
  restartStopped: ' The bot is stopped; start it before pressing Migrate again.',
  restartUnknown: ' Docker did not say whether the bot runs.',
  notReady: (err: string) => `The migration did not start: the bot did not answer within 180 seconds of its restart (${err}). Nothing was copied, and the bot stays in Maintenance; press Migrate again once it runs.`,
  noHook: "The migration did not start: this bot's build has no migrate hook (it answered 404). Nothing was copied; update the bot to a build that has one.",
  authF: (status: number, err: string) => `The migration did not start: the bot refused the manager's token (HTTP ${status}: ${err}). Nothing was copied, and the bot stays in Maintenance.`,
  auth: (status: number, err: string, jobId: string) => `The bot refused the manager's token (HTTP ${status}: ${err}), so the manager can't confirm how migration ${jobId} stands. The bot stays in Maintenance with the migration open; press Migrate to ask again.`,
  switchLate: (refusal: string) => `The migration did not start: ${refusal}, so the manager did not restart the bot into maintenance. Nothing was copied, and the bot stays in Maintenance.`,
  prepStopped: 'The migration did not start: the bot is stopped, and it has to run in its maintenance boot to save what it holds. Nothing was copied, and the bot stays in Maintenance; start it, then press Migrate again.',
  fenceF: (why: string, again = false) => `The migration closed before its copy: ${again ? "after the bot's restart into maintenance, the manager could not close the bot's database to other connections again" : "the manager could not close the bot's database to other connections"} (${why}), and a move to JSON files renames that database's data aside, which a bot or program the manager cannot see may be using. Nothing was copied, and the bot stays in Maintenance.`,

  failed: (jobId: string, stage: string, err: string, source: string) => `Migration ${jobId} failed at ${stage}: ${err}. Nothing was switched: the bot stays in Maintenance and keeps its data in ${source}.`,
  refused: (err: string, source: string) => `The bot refused the migration: ${err}. Nothing was switched: the bot stays in Maintenance and keeps its data in ${source}.`,
  spent: (jobId: string, stage: string, err: string, source: string) => `Migration ${jobId} was interrupted at ${stage} (${err}), and the manager has started it three times. Nothing was switched: the bot stays in Maintenance and keeps its data in ${source}. Press Migrate to try again.`,
  envBack: (x: string, err: string) => ` The stored Data Backend could not be set back to ${x} (${err}), so the migration stays open; press Migrate to set it again.`,
  loginBack: (err: string) => ` The bot's database login, which the migration opened, could not be blocked again (${err}), so the migration stays open with the login open; press Migrate to block it again.`,
  loginDownFile: (err: string, state: 'stopped' | 'restarting') => ` The manager can't confirm that the bot's database login, which the migration opened, is blocked again: ${state === 'restarting' ? 'docker shows the managed database restarting, and it did not accept connections' : 'the managed database is stopped and did not start'} (${err}). Once the database runs, the manager's maintenance check blocks the login while the bot's state is not Running.`,
  loginDownPg: (err: string, state: 'stopped' | 'restarting') => ` The manager can't confirm that the login of the bot's managed database, which the migration opened, is blocked again: ${state === 'restarting' ? 'docker shows that database restarting, and it did not accept connections' : 'that database is stopped and did not start'} (${err}). The bot keeps its data in its JSON files, which do not use that login; a later migration to Postgres uses the login as it is.`,
  fenceBack: (why: string) => ` The lines the migration added to the database's pg_hba.conf, which refuse every connection but this bot's and the manager's, could not be removed (${why}), so the migration stays open; press Migrate to remove them again.`,
  fenceStripped: " The lines the migration added to the database's pg_hba.conf are removed from the file, but the database has not reloaded it, so until it reloads its configuration or its container restarts it may go on refusing every connection but the bot container's as it was during the migration: other bots' connections, and the bot's own after a start that gives its container another address.",
  fenceUnconfirmed: " The manager can't confirm that the database admits other connections again: its pg_hba.conf holds none of the lines the migration adds, but no reload of the file reached the database, which may still apply lines an earlier attempt removed from the file until it reloads its configuration or its container restarts.",
  fenceSome: " The manager can't confirm whether the database admits other connections meanwhile: any lines written to its pg_hba.conf before the failure stay there, refusing every connection but this bot's and the manager's, until the migration ends or a press of Migrate writes them again.",
  whyLiftLocked: (detail: string) => `docker could not change the file in the database container or in its volume (${detail})`,
  whyLiftVolume: (volume: string) => `docker did not answer whether the database volume ${volume} exists`,
  wSharer: (name: string, err: string) => ` ${name} did not start again (${err}); start it by hand.`,
  wSharerBusy: (name: string, op: string) => ` ${name} was not started again: it is running '${op}'; start it by hand once that ends.`,

  kept: (jobId: string, clause: string, err: string, retry: string) => `Migration ${jobId} is not finished: ${clause} (${err}). The bot stays in Maintenance; ${retry}.`,
  retryIn: (n: number) => `the manager asks again in ${n} seconds`,
  retryCap: 'the manager has started it three times and does not ask again; press Migrate to go on',
  retryKeep: 'the manager asked five times and does not ask again; press Migrate to go on',
  noHookKept: (jobId: string) => `Migration ${jobId} is not finished, and the bot now answers that it has no migrate hook (404), so the manager can't confirm which store holds the data. The bot stays in Maintenance with the migration open, since closing it now could leave the bot set to a store the migration already retired; press Migrate to ask again.`,
  unknownPost: (jobId: string) => `The manager can't confirm whether migration ${jobId} started: the bot did not answer within 30 seconds, three times. The bot stays in Maintenance; press Migrate to ask again.`,
  noAnswer: (jobId: string, span: string, err: string) => `The manager can't confirm how migration ${jobId} ends: the bot has not answered for ${span} (${err}). The bot stays in Maintenance with the migration open; press Migrate to ask again once the bot runs.`,
  unusable: (jobId: string, span: string, status: number, err: string) => `The manager can't confirm how migration ${jobId} ends: for ${span} the manager got no answer it could use (last: HTTP ${status}: ${err}). The bot stays in Maintenance with the migration open; press Migrate to ask again.`,
  otherJob: (jobId: string, other: string, x: string, state: string) => `The manager can't confirm the outcome of migration ${jobId}: the bot reports migration ${other} to ${x} (${state}). The bot stays in Maintenance; press Migrate to ask again.`,
  nullJob: (jobId: string) => `The manager can't confirm the outcome of migration ${jobId}: the bot reports no migration. The bot stays in Maintenance; press Migrate to ask again.`,
  destHosted: (jobId: string, dest: string, owner: string) => `Migration ${jobId} is done, and the bot names ${dest} as the database the copy went to, which is in ${owner}'s managed database container. Migrate does not move a bot onto another bot's managed database, so the migration was closed with the Data Backend unchanged, and the bot stays in Maintenance. The JSON files keep the data as it was before the copy, but after this migration the bot refuses to boot on them; it boots on the copy once its Data Backend is postgres and its Database URL names ${dest}.`,
  destOwn: (jobId: string, dest: string, why: string, retiring = false) => `Migration ${jobId} is done, and the bot names ${dest}, this bot's own managed database, as the database the copy went to, but ${why}, so Migrate does not move the bot onto it: the migration was closed with the Data Backend unchanged, and the bot stays in Maintenance.${retiring ? ' The JSON files keep the data as it was before the copy, but after this migration the bot refuses to boot on them, and no bot starts on a database whose removal did not finish; running the decommission or the re-seed again finishes the removal and deletes the copy.' : ` The JSON files keep the data as it was before the copy, but after this migration the bot refuses to boot on them; it boots on the copy once its Data Backend is postgres and its Database URL names ${dest}.`}`,
  destFenceRead: (jobId: string, dest: string, err: string) => `Migration ${jobId} is done, and the bot names ${dest}, this bot's own managed database, as the database the copy went to, but the manager can't confirm whether that database is READ-ONLY (${err}). The bot stays in Maintenance with the migration open; press Migrate to check again.`,
  whyRetiring: (at: string) => `that database is being removed (since ${at})`,
  whyNotice: (file: string) => `a restore of ${file} into that database has not finished cleanly`,
  whyFence: (state: string) => `that database is READ-ONLY (${state})`,
  whyRepl: "that database has replication on, and the manager's check of it as the fleet's main database pauses while a migration is open",
  whyRestarting: "docker shows that database restarting, so the manager can't confirm whether it is READ-ONLY",
  whyDbDown: (state: 'restarting' | 'stopped' | 'running' | null) => (state === 'restarting' ? "docker shows the bot's managed database restarting after its start"
    : state === 'stopped' ? "docker shows the bot's managed database stopped after its start" : "docker did not say whether the bot's managed database runs after its start"),
  dest: (jobId: string, named: string, passed: string) => `Migration ${jobId} is done, but the manager can't confirm which database the copy went to: the bot names ${named}, and the manager passed ${passed}. The bot stays in Maintenance and its Data Backend is unchanged. Set the Database URL to the database the copy went to, then press Migrate.`,
  destUrlRead: (jobId: string, named: string) => `Migration ${jobId} is done, and the bot names ${named} as the database the copy went to, but the env store for this bot cannot be read, so the manager can't tell which database the Database URL names. The bot stays in Maintenance and its Data Backend is unchanged. Set the Database URL to ${named}, then press Migrate.`,
  destUrl: (jobId: string, named: string, url: string) => `Migration ${jobId} is done, and the bot names ${named} as the database the copy went to, but the Database URL names ${url}. The bot stays in Maintenance and its Data Backend is unchanged. Set the Database URL to ${named}, then press Migrate.`,
  envStore: (jobId: string, dest: string, err: string) => `Migration ${jobId} moved the data to ${dest}, but the new Data Backend could not be stored (${err}). The bot stays in Maintenance; press Migrate to store it again.`,
  formerKept: (jobId: string, dest: string, err: string) => `Migration ${jobId} moved the data to ${dest} and stored the new Data Backend, but the old main's join code kept on this bot could not be deleted (${err}). The bot stays in Maintenance; press Migrate to finish.`,
  apply: (jobId: string, dest: string, err: string) => `Migration ${jobId} moved the data to ${dest}, and the new Data Backend is stored, but the restart that applies it failed (${err}). The bot stays in Maintenance; press Migrate to apply it again.`,
  env: (jobId: string, dest: string, value: string, url: string | null, notApplied: string) => `Migration ${jobId} moved the data to ${dest}, but after the restart the bot's container reads DATA_BACKEND=${value}${url !== null ? `, and its Database URL names ${url}` : ''} (${notApplied}). The bot stays in Maintenance; press Migrate to apply it again.`,
  envDocker: (jobId: string, dest: string, err: string) => `Migration ${jobId} moved the data to ${dest}, but docker did not say what the bot's container reads after the restart (${err}). The bot stays in Maintenance; press Migrate to check it again.`,
  needsBuildWait: (jobId: string) => `Migration ${jobId} is not finished, and the bot could not be started: its image or compose is missing. The bot stays in Maintenance with the migration open; press Build, then press Migrate.`,
  startWait: (jobId: string, err: string) => `Migration ${jobId} is not finished, and the bot could not be started (${err}). The bot stays in Maintenance with the migration open; press Migrate to try again.`,
  dbWait: (jobId: string, err: string) => `Migration ${jobId} is not finished, and the bot's database did not accept connections within 30 seconds of the start (${err}). The bot stays in Maintenance with the migration open; press Migrate to try again.`,
  dbStartWait: (jobId: string, err: string) => `Migration ${jobId} is not finished, and the bot's database could not be started (${err}). The bot stays in Maintenance with the migration open; press Migrate to try again.`,
  envDb: (jobId: string, dest: string, state: 'stopped' | 'restarting' | null) => `Migration ${jobId} moved the data to Postgres at ${dest}, but the managed database is not running after the restart${state === null ? ', and docker did not say whether it runs' : state === 'restarting' ? ': docker shows it restarting' : ''}. The bot stays in Maintenance; press Migrate to start it and apply again.`,
  fenceWait: (jobId: string | null, why: string) => {
    const so = jobId === null ? 'so it did not ask the bot to start the migration again' : `so it did not go on following migration ${jobId}`;
    return `The manager could not renew the lines that close the bot's database to every connection but this bot's and the manager's (${why}), ${so}. The bot stays in Maintenance with the migration open; press Migrate to try again.`;
  },
  fenceBackDone: (jobId: string, dest: string, why: string) => `Migration ${jobId} moved the data to ${dest}, but the lines it added to the database's pg_hba.conf, which refuse every connection but this bot's and the manager's, could not be removed (${why}). The bot stays in Maintenance; press Migrate to remove them and go on.`,
  notRecLane: (err: string) => `The manager could not record the migration's progress (${err}), so it stopped here with the migration open. Press Migrate to go on.`,

  done: (dest: string, jobId: string, x: string) => `The data moved to ${dest} (migration ${jobId}), and the bot's Data Backend is now ${x}.`,
  keptPg: 'The JSON files stay in the bot\'s data folder.',
  keptFile: 'The database keeps the old data, renamed aside.',
  left: (n: number) => ` The copy left out ${n} item(s) it could not place; they stay in the old store, and the bot's migration status lists them.`,
  sharersStay: (names: string, n: number) => n === 1 ? ` ${names} uses the old database and stays stopped: its data is renamed aside, so that bot cannot load it.` : ` ${names} use the old database and stay stopped: its data is renamed aside, so they cannot load it.`,
  sharersRun: (names: string, n: number) => n === 1 ? ` ${names} uses the old database and runs: its data is renamed aside, so that bot cannot load it, and that bot's writes to it fail.` : ` ${names} use the old database and run: its data is renamed aside, so they cannot load it, and their writes to it fail.`,
  sharersUnsure: (names: string, n: number) => n === 1 ? ` ${names} uses the old database, and docker did not say whether it runs: its data is renamed aside, so that bot cannot load it.` : ` ${names} use the old database, and docker did not say whether they run: its data is renamed aside, so they cannot load it.`,
  doneOpen: " The bot started this copy itself, and the database stayed open to other connections while it copied; the manager can't confirm that no other bot or program wrote to the database during the copy.",
  doneUnsure: " The bot started this copy itself, and the manager's step that stops the other bots on the database and closes it to other connections had begun on this migration without finishing; the manager can't confirm whether the database was closed during the copy, or that no other bot or program wrote to it.",
  wRunning: (refusal: string) => ` The bot stays in Maintenance: ${refusal}. Choose Running in State.`,
  wRunningOpen: (refusal: string) => ` The bot stays in Maintenance: ${refusal}.`,
  loginBackDone: (err: string) => ` The bot's database login, which the migration opened, could not be blocked again (${err}), so the migration stays open with the login open; press Migrate: it asks for Running again, and blocks the login again if Running is still refused.`,

  pDb: 'Starting the managed database',
  pLogin: "Opening the bot's database login",
  pFence: "Closing the bot's database to every connection but this bot's and the manager's",
  pSave: 'Asking the bot to save what it holds',
  pSharers: (names: string) => `Stopping the other bots on this database (${names})`,
  pOpen: (names: string[], repl: string[] = []) => (names.length ? `Following the move the bot was already running, with its database open to other connections; ${names.join(', ')} ${names.length === 1 ? 'uses it, and the manager does not stop it' : 'use it, and the manager does not stop them'}${repl.map(n => `; ${n}'s own managed database has replication on, so this migration does not hold ${n}, and the manager can still start, update or build it`).join('')}` : 'Following the move the bot was already running, with its database open to other connections'),
  pRestart: 'Restarting the bot into maintenance',
  pPost: (jobId: string) => `Starting migration ${jobId}`,
  pRun: (jobId: string) => `Migration ${jobId} is running`,
  pStage: (jobId: string, stage: string) => `Migration ${jobId}: ${stage}`,
  pAgain: (jobId: string, stage: string) => `Migration ${jobId} was interrupted at ${stage}; starting it again`,
  pNoAnswer: (jobId: string, n: number) => `Migration ${jobId}: the bot has not answered for ${n} seconds`,
  pUnusable: (jobId: string, n: number, status: number, err: string) => `Migration ${jobId}: for ${n} seconds the manager got no answer it could use (last: HTTP ${status}: ${err})`,
  pSession: (jobId: string, n: number) => `Migration ${jobId}: the bot waits for an earlier migration's database session to end (${n} seconds so far)`,
  pFinish: (x: string) => `Storing the new Data Backend and restarting the bot on ${x}`,
  pBack: 'Taking the bot out of maintenance',
  pClose: (source: string) => `Setting the bot back on ${source}`,
};

export const MIGRATE_TEXT = T;

const sourceText = (from: MigrateTo) => (from === 'file' ? 'its JSON files' : 'its database');
const destText = (rec: Pick<MigrateRecord, 'to' | 'destination'>) => (rec.to === 'postgres' ? `Postgres at ${DISPLAY(rec.destination)}` : 'JSON files');
const fenceLeftTail = (left: '' | 'stripped' | 'unconfirmed') => (left === 'stripped' ? T.fenceStripped : left === 'unconfirmed' ? T.fenceUnconfirmed : '');
const ENV_BACK_TAIL = / The stored Data Backend could not be set back to .*$| The bot's database login, which the migration opened, could not be blocked again .*$| The lines the migration added to the database's pg_hba.conf, which refuse every connection .*$/;

// ─── Listener and view ───

export type MigrateEvent = { text: string; final: boolean };
let listener: ((botId: string, ev: MigrateEvent) => void) | null = null;

export function setMigrateListener(fn: ((botId: string, ev: MigrateEvent) => void) | null): void {
  listener = fn;
}

const lanes = new Map<string, Promise<void>>();

/** The running lane of a bot, resolved when it ends (tests and shutdown). */
export function laneDone(botId: string): Promise<void> {
  return lanes.get(botId) ?? Promise.resolve();
}

function emit(botId: string, text: string, final = false): void {
  try {
    listener?.(botId, { text, final });
  } catch (err) {
    console.error(`[Migrate] ${botId}: the progress broadcast failed: ${errText(err)}`);
  }
}

// ─── Admission ───

export type Admission = { accepted: true } | { accepted: false; status: number; error: string };
const refuse = (status: number, error: string): Admission => ({ accepted: false, status, error });

type EnvRead = { env: Record<string, string>; urlKey: string } | { error: string };

function readEnv(inst: InstanceConfig): EnvRead {
  const urlKey = findAppCapabilities(inst.sourceUrl)?.companionDb?.env.url ?? 'DATA_BACKEND_URL';
  let status: ReturnType<typeof envManager.getEnvVarsWithStatus>;
  try { status = envManager.getEnvVarsWithStatus(inst.id); } catch { return { error: R8 }; }
  if (status.corrupt || status.undecryptable.includes(urlKey)) return { error: R8 };
  const env: Record<string, string> = { ...(inst.envVars || {}), ...status.vars };
  for (const key of status.undecryptable) env[key] = '';
  return { env, urlKey };
}

const R8 = "The env store for this instance cannot be read, so the manager can't tell which database the bot uses; nothing was changed";
const R11 = 'Docker did not say whether the bot is running, so nothing was changed; retry in a moment';
const STATE_NAME = { running: 'Running', maintenance: 'Maintenance', off: 'Off' } as const;

type Facts = { inst: InstanceConfig; env: Record<string, string>; urlKey: string; from: MigrateTo; plan: Extract<DestinationPlan, { ok: true }>; sourceManaged: boolean };

/** A1 to A24 and A32 that read no docker and no hook; `open` is the record a press goes on with (A9). */
function admitSync(botId: string, toRaw: unknown, held: boolean): Admission | { open: MigrateRecord; inst: InstanceConfig } | { facts: Facts } {
  if (containerManager.isShuttingDown()) return refuse(503, containerManager.SHUTDOWN_REFUSAL);
  const inst = containerManager.getBot(botId);
  if (!inst) return refuse(404, 'Bot not found');
  if (toRaw !== 'postgres' && toRaw !== 'file') return refuse(400, T.badTo);
  const to = toRaw as MigrateTo;
  const caps = findAppCapabilities(inst.sourceUrl);
  if (!caps?.companionDb) return refuse(409, T.noApp);
  if (!caps.hooks) return refuse(409, T.noHooks);
  const busy = containerManager.isBotBusy(botId);
  if (busy && !(held && busy === OP)) return refuse(409, `Operation '${busy}' already in progress`);
  const hold = containerManager.databaseHoldRefusal(botId, 'Migrate');
  if (hold) return refuse(409, hold.error);
  const deleting = containerManager.deleteLaneRefusal(botId, 'Migrate');
  if (deleting) return refuse(409, deleting.error);
  const holder = containerManager.migrationHolds(botId)[0];
  if (holder) return refuse(409, T.heldMigrate(holder.other.displayName, X(holder.rec.to)));
  const open = inst.migrate ?? null;
  if (open && open.to !== to) return refuse(409, T.otherTo(X(open.to)));
  const read = readEnv(inst);
  if ('error' in read) return refuse(409, read.error);
  if (open) return { open, inst };
  const from = backendOf(read.env);
  if (to === from) return refuse(409, T.same(X(to)));
  const url = (read.env[read.urlKey] || '').trim();
  const plan = destinationPlan(inst, url, to, caps.companionDb.database, read.env);
  if (!plan.ok) return refuse(409, plan.refusal === 'form' ? T.urlForm(plan.form) : plan.refusal === 'list' ? T.list : plan.refusal === 'join' ? T.join : T.badUrl);
  const host = url ? containerManager.databaseHostOf(url) : null;
  if (host && host.id !== botId) return refuse(409, T.ownerHosted(host.displayName));
  const kind = maintenance.maintenanceKind(inst, read.env);
  const sourceManaged = from === 'postgres' && kind === 'database';
  const managedInvolved = sourceManaged || plan.companion;
  if (managedInvolved && inst.fleetDb?.retiringAt) return refuse(409, containerManager.unfinishedRetireRefusal(inst.fleetDb.retiringAt));
  const m = maintenance.maintenanceOf(inst);
  if (m.state === 'running') return refuse(409, T.running);
  if (m.state === 'off') return refuse(409, T.off);
  if (!m.settled) return refuse(409, T.unsettled(STATE_NAME[m.state], m.lastError || 'the order has not finished'));
  if (managedInvolved && inst.fleetDb) {
    const file = fleetBackup.shownRestoreNoticeFile(botId);
    if (file) return refuse(409, T.notice(file));
  }
  const db = inst.fleetDb;
  if (db?.handover) return refuse(409, T.switchH(moveModeText(db.handover)));
  if (db?.receive) return refuse(409, T.switchV);
  if (db?.replacedBy) return refuse(409, T.switchR(db.replacedBy.machine));
  if (db?.mainConflict) return refuse(409, T.switchC);
  if (db?.pushBroken) return refuse(409, T.switchP(db.pushBroken.safetyDump));
  const seed = fleetReplica.seedView(inst);
  if (seed && seed.parked !== true) return refuse(409, T.seed);
  if (inst.fleetJoin) return refuse(409, T.fleetJoin);
  if (db?.replication) return refuse(409, to === 'file' && sourceManaged ? T.fleetRepl : T.fleetReplOn);
  return { facts: { inst, env: read.env, urlKey: read.urlKey, from, plan, sourceManaged } };
}

/** A19 to A22 and the GET of A25 to A29 and A33, inside the lock. */
async function admitLive(f: Facts): Promise<Admission | { adopt: Job | null }> {
  const { inst } = f;
  const app = await containerManager.appContainerRunning(inst.id);
  if (app === null) return refuse(409, R11);
  if (app === false) return refuse(409, T.stopped);
  const fenced = (f.sourceManaged || f.plan.companion) ? inst.fleetDb : undefined;
  if (fenced && await dbLogin.sidecarRunning(fenced.containerName) === true) {
    const fence = await dbLogin.readWriteFence({ container: fenced.containerName, user: fenced.user });
    if (!fence.ok) return refuse(409, T.fenceRead(fence.error));
    if (fence.on) {
      const w = maintenance.fenceWords(fence);
      return refuse(409, T.fence(w.state, w.remedy));
    }
  }
  const a = hookAnswer(await callAppHook(inst, 'migrate', 'GET', undefined, MIGRATE_TIMING.getMs), 'GET');
  if (a.kind === 'nohook') return refuse(409, T.noHookA);
  if (a.kind === 'noanswer') return refuse(409, T.noAnswerA(a.error));
  if (a.kind === 'auth') return refuse(409, T.authA(a.status, a.error));
  if (a.kind === 'cantconfirm') return refuse(409, T.cantReadA(a.error));
  if (a.kind !== 'answer') return refuse(409, T.unusableA(a.status, a.error));
  const job = a.body.job ? jobOf(a.body.job) : null;
  const to = otherTo(f.from);
  if (job?.state === 'running' && job.to !== to) return refuse(409, T.otherRun(job.jobId, X(job.to), X(to)));
  return { adopt: job?.state === 'running' ? job : null };
}

/**
 * The route entry and the boot resume: admits under the `migrate` op lock and answers at admission; the lane goes on
 * in the background (laneDone).
 */
export function runMigration(botId: string, toRaw: unknown, mode: 'press' | 'resume'): Promise<Admission> {
  if (mode === 'press') {
    const pre = admitSync(botId, toRaw, false);
    if ('accepted' in pre) return Promise.resolve(pre);
  } else if (containerManager.isBotBusy(botId)) {
    return Promise.resolve(refuse(409, `Operation '${containerManager.isBotBusy(botId)}' already in progress`));
  }
  let answer!: (a: Admission) => void;
  const answered = new Promise<Admission>(resolve => { answer = resolve; });
  let admitted = false;
  const admit = () => { if (!admitted) { admitted = true; answer({ accepted: true }); } };
  const lane = containerManager.withExternalBotOp(botId, OP, async () => {
    if (mode === 'resume') {
      const inst = containerManager.getBot(botId);
      const rec = inst?.migrate;
      if (!inst || !rec || rec.phase === 'waiting' || containerManager.isShuttingDown()) { answer(refuse(409, 'No migration to resume')); return; }
      console.log(`[Migrate] ${inst.displayName}: the manager restarted during the migration to ${rec.to} (${rec.phase}); going on`);
      admit();
      await new Lane(inst, rec).drive(null);
      return;
    }
    const sync = admitSync(botId, toRaw, true);
    if ('accepted' in sync) { answer(sync); return; }
    if ('open' in sync) {
      const rec = pressed(sync.open);
      try {
        containerManager.updateInstanceMigrate(botId, rec);
      } catch (err) {
        answer(refuse(500, T.notRec(errText(err))));
        return;
      }
      admit();
      await new Lane(sync.inst, rec).drive(null);
      return;
    }
    const live = await admitLive(sync.facts);
    if ('accepted' in live) { answer(live); return; }
    const f = sync.facts;
    const to = toRaw as MigrateTo;
    const jobId = live.adopt ? live.adopt.jobId : mintJobId();
    const rec: MigrateRecord = {
      to, from: f.from, destination: f.plan.destination, companion: f.plan.companion,
      jobId, jobIds: live.adopt ? [jobId] : [], posted: !!live.adopt, started: 0, kept: 0,
      phase: live.adopt ? 'following' : 'preparing', loginOpened: false, sharers: [], sharersStopped: [], openedAt: new Date().toISOString(),
      text: live.adopt ? T.pRun(jobId) : T.pDb,
      ...(live.adopt ? { adoptedJob: jobId } : {}),
    };
    if (containerManager.isShuttingDown()) { answer(refuse(503, containerManager.SHUTDOWN_REFUSAL)); return; }
    const again = admitSync(botId, toRaw, true);
    if ('accepted' in again) { answer(again); return; }
    const g = 'facts' in again ? again.facts : null;
    if (!g || g.from !== f.from || g.plan.destination !== f.plan.destination
      || g.plan.companion !== f.plan.companion || g.sourceManaged !== f.sourceManaged) { answer(refuse(409, T.changed)); return; }
    if (switchTickOn(botId)) { answer(refuse(409, T.tick)); return; }
    if (live.adopt && to === 'file' && g.from === 'postgres') {
      const url = (g.env[g.urlKey] || '').trim();
      try {
        rec.sharers = url ? fleetBackup.databaseSharers(g.inst, url).filter(b => b.id !== botId && !b.migrate && !replicationOn(b)).map(b => b.id) : [];
      } catch {
        rec.sharers = [];
      }
    }
    try {
      containerManager.updateInstanceMigrate(botId, rec);
    } catch (err) {
      answer(refuse(500, T.notRec(errText(err))));
      return;
    }
    console.log(`[Migrate] ${f.inst.displayName}: migration to ${to} opened`);
    admit();
    await new Lane(containerManager.getBot(botId) ?? f.inst, rec).drive(live.adopt);
  }).catch(err => {
    if (!admitted) {
      const op = containerManager.isBotBusy(botId);
      answer(op && op !== OP ? refuse(409, `Operation '${op}' already in progress`) : refuse(500, `The migration stopped on an unexpected error: ${errText(err)}`));
    } else {
      console.error(`[Migrate] ${botId}: the migration stopped on an unexpected error: ${errText(err)}`);
      emit(botId, T.notRecLane(errText(err)), true);
    }
  });
  const tracked: Promise<void> = lane.then(() => undefined).finally(() => { if (lanes.get(botId) === tracked) lanes.delete(botId); });
  lanes.set(botId, tracked);
  return answered;
}

/** M1 on an open record: the cap and the keep bound reset; a record parked at `posting` gets a new jobId. */
function pressed(open: MigrateRecord): MigrateRecord {
  const rec: MigrateRecord = { ...open, started: 0, kept: 0 };
  delete rec.awaiting;
  if (open.phase === 'waiting') {
    rec.phase = open.resumeAt ?? 'preparing';
    if (open.resumeAt === 'posting') rec.jobId = mintJobId();
  }
  delete rec.resumeAt;
  return rec;
}

/** Starts every cut lane once after the maintenance reconciler; a parked record waits for the operator. */
export function resumeMigrations(): void {
  for (const inst of containerManager.getAllBots()) {
    const rec = inst.migrate;
    if (!rec || rec.phase === 'waiting') continue;
    void runMigration(inst.id, rec.to, 'resume');
  }
}

/** The State window's control: the direction, the confirm's destination and sharers, and why it is hidden or refused. */
export function migrateView(inst: InstanceConfig): {
  hidden: boolean; to: MigrateTo | null; refusal: string | null; destination: string | null; companion: boolean; sharers: string[];
  record: MigrateRecord | null; last: MigrateLast | null; fenced: boolean;
} {
  const caps = findAppCapabilities(inst.sourceUrl);
  const record = inst.migrate ?? null;
  const last = inst.migrateLast ?? null;
  const base = { record, last, destination: null as string | null, companion: false, sharers: [] as string[], fenced: false };
  if (!caps?.companionDb || !caps.hooks) return { ...base, hidden: true, to: null, refusal: null };
  const read = readEnv(inst);
  if ('error' in read) return { ...base, hidden: false, to: record?.to ?? null, refusal: read.error };
  const to: MigrateTo = record?.to ?? otherTo(backendOf(read.env));
  const m = maintenance.maintenanceOf(inst);
  const refusal = record ? null : m.state === 'running' ? T.running : m.state === 'off' ? T.off : !m.settled ? T.unsettled(STATE_NAME[m.state], m.lastError || 'the order has not finished') : null;
  const url = (read.env[read.urlKey] || '').trim();
  const plan = destinationPlan(inst, url, to, caps.companionDb.database, read.env);
  let sharers: string[] = [];
  if (to === 'file' && url && plan.ok) {
    try {
      sharers = fleetBackup.databaseSharers(inst, url).filter(b => b.id !== inst.id).map(b => b.displayName);
    } catch { /* the confirm names none */ }
  }
  const fenced = to === 'file' && backendOf(read.env) === 'postgres' && maintenance.maintenanceKind(inst, read.env) === 'database';
  return {
    hidden: false, to, refusal, record, last, sharers, fenced,
    destination: record?.destination ?? (plan.ok ? plan.destination : null), companion: record?.companion ?? (plan.ok && plan.companion),
  };
}

// ─── The lane ───

type SharerRefusal = { clause: string; retry?: string };

/** sessionJobs: the jobs this episode's session refusals named; counted: the job the last POST added to `started`. */
type Carry = { windowEnd: number; sessionEnd: number; sessionJobs: string[]; counted?: string };

type Next =
  | { go: 'prepare' }
  | { go: 'post'; carry?: Carry }
  | { go: 'follow'; carry?: Carry }
  | { go: 'refusal'; error: string; spent?: Job }
  | { go: 'keep'; keep: Keep }
  | { go: 'done'; job: Job | null }
  | { go: 'finish' }
  | { go: 'close'; text: string }
  | { go: 'park'; resumeAt: Exclude<MigratePhase, 'waiting'>; text: string; awaiting?: 'destination' }
  | { go: 'stop'; error: string }
  | { go: 'end' };

class Lane {
  private rec: MigrateRecord;
  private readonly botId: string;
  private readonly name: string;
  private windowEnd = 0;
  private notApplied: string[] = [];
  private job: Job | null = null;
  private writeError = '';

  constructor(private inst: InstanceConfig, rec: MigrateRecord) {
    this.rec = { ...rec, jobIds: [...rec.jobIds], sharers: [...rec.sharers], sharersStopped: [...rec.sharersStopped] };
    this.botId = inst.id;
    this.name = inst.displayName;
  }

  private fresh(): InstanceConfig {
    return containerManager.getBot(this.botId) ?? this.inst;
  }

  /** One save of the record; false (with writeError) when it could not be written. */
  private save(patch: Partial<MigrateRecord>, drop: Array<keyof MigrateRecord> = []): boolean {
    const next: MigrateRecord = { ...this.rec, ...patch };
    for (const k of drop) delete next[k];
    try {
      containerManager.updateInstanceMigrate(this.botId, next);
    } catch (err) {
      this.writeError = errText(err);
      return false;
    }
    this.rec = next;
    return true;
  }

  private progress(text: string): void {
    if (!this.save({ text })) console.warn(`[Migrate] ${this.name}: the progress line could not be recorded: ${this.writeError}`);
    emit(this.botId, text);
  }

  private stop(): Next {
    return { go: 'stop', error: this.writeError };
  }

  private env(): Record<string, string> {
    const read = readEnv(this.fresh());
    return 'error' in read ? {} : read.env;
  }

  private urlKey(): string {
    return findAppCapabilities(this.inst.sourceUrl)?.companionDb?.env.url ?? 'DATA_BACKEND_URL';
  }

  private target(): dbLogin.DbTarget | null {
    const db = this.fresh().fleetDb;
    return db ? { container: db.containerName, user: db.user } : null;
  }

  /** A managed Postgres source of kind database (read before G5, while the stored value is the source). */
  private sourceManaged(): boolean {
    if (this.rec.from !== 'postgres') return false;
    const inst = this.fresh();
    const env = { ...this.env(), DATA_BACKEND: 'postgres' };
    return maintenance.maintenanceKind(inst, env) === 'database';
  }

  /** The managed databases M6b waits for, by phase (D30, D34). */
  private databases(finishing: boolean): Array<{ containerName: string; user: string; db: string }> {
    const out: Array<{ containerName: string; user: string; db: string }> = [];
    const own = this.fresh().fleetDb;
    if (finishing) {
      if (this.rec.to === 'postgres' && this.rec.companion && own) out.push(own);
      return out;
    }
    if (own && (this.rec.companion || this.sourceManaged())) out.push(own);
    return out;
  }

  private async databasesReady(finishing: boolean): Promise<string | null> {
    for (const db of this.databases(finishing)) {
      if (!await containerManager.databaseReady(db)) return `${db.containerName}: it did not accept connections within 30 seconds of the restart`;
    }
    return null;
  }

  /** D71 and B34: why M5 may not stop this sharer (its own open record, replication on its own database, or another record that lists it); null when none. */
  private sharerHeld(s: InstanceConfig): SharerRefusal | null {
    if (s.migrate) return { clause: T.cSharerOpen(s.displayName, X(s.migrate.to)), retry: T.retryOpen(s.displayName) };
    if (s.fleetDb?.replication) return { clause: T.cSharerRepl(s.displayName), retry: T.retryRepl(s.displayName) };
    const held = containerManager.migrationHolds(s.id).find(h => h.other.id !== this.botId);
    return held ? { clause: T.cSharerShared(s.displayName, held.other.displayName, X(held.rec.to)), retry: T.retryShared } : null;
  }

  private names(ids: string[]): string {
    return ids.map(id => containerManager.getBot(id)?.displayName ?? id).join(', ');
  }

  /** X33 (D137): at posting, a refusal of the step on a bot this record holds and did not stop releases that bot, so another record's wait does not depend on this one. */
  private released(id: string, mode: 'close' | 'park', r: Next): Next {
    if (mode !== 'park' || !this.rec.sharers.includes(id) || this.rec.sharersStopped.includes(id)) return r;
    return this.save({ sharers: this.rec.sharers.filter(x => x !== id) }) ? r : this.stop();
  }

  /** M5 and B35 (D117): the sharers searched, held and stopped, then the lines written in full; the refusal (a close from prepare, a park at posting from post), else null with isolated saved. */
  private async isolate(mode: 'close' | 'park'): Promise<Next | null> {
    const no = (r: SharerRefusal): Next => (mode === 'close' ? { go: 'close', text: T.notStarted(r) } : { go: 'park', resumeAt: 'posting', text: T.notReposted(r) });
    const url = (this.env()[this.urlKey()] || '').trim();
    const found = url ? (await fleetBackup.runningDatabaseSharers(this.fresh(), url)).filter(b => b.id !== this.botId) : [];
    const ids = Array.from(new Set([...this.rec.sharers, ...found.map(b => b.id)]));
    if (ids.length > 0) {
      for (const id of ids) {
        const s = containerManager.getBot(id);
        const t = s ? this.sharerHeld(s) : null;
        if (t) return this.released(id, mode, no(t));
      }
      if (ids.join() !== this.rec.sharers.join() && !this.save({ sharers: ids })) return this.stop();
      this.progress(T.pSharers(this.names(ids)));
      for (const id of ids) {
        const s = containerManager.getBot(id);
        if (!s) continue;
        const op = containerManager.isBotBusy(id);
        if (op) return no({ clause: T.cSharerBusy(s.displayName, op) });
        const app = await containerManager.appContainerRunning(id);
        if (app === null) return no({ clause: T.cSharer(s.displayName, 'docker did not say whether it runs') });
        if (app) {
          const nowOp = containerManager.isBotBusy(id);
          if (nowOp) return no({ clause: T.cSharerBusy(s.displayName, nowOp) });
          const held = this.sharerHeld(containerManager.getBot(id) ?? s);
          if (held) return this.released(id, mode, no(held));
          if (!this.rec.sharersStopped.includes(id) && !this.save({ sharersStopped: [...this.rec.sharersStopped, id] })) return this.stop();
          let stopped: { success: boolean; error?: string };
          try {
            stopped = await containerManager.stopBot(id, { seen: true });
          } catch (err) {
            return no({ clause: T.cSharer(s.displayName, errText(err)) });
          }
          if (!stopped.success && stopped.error !== 'Bot is not running') return no({ clause: T.cSharer(s.displayName, stopped.error || 'no reason given') });
          const after = await containerManager.appContainerRunning(id);
          if (after === null) return no({ clause: T.cSharer(s.displayName, 'docker did not say whether it runs') });
          if (after) return no({ clause: T.cSharerStill(s.displayName), retry: T.retryStill });
        }
      }
    }
    if (this.sourceManaged()) {
      const owner = this.rec.hbaFence ?? fleetBackup.newFenceOwner('migrate');
      if (!this.rec.hbaFence && !this.save({ hbaFence: owner })) return this.stop();
      this.progress(T.pFence);
      const why = await fleetBackup.fenceMigrateSource(this.fresh(), owner);
      if (why) return mode === 'close' ? { go: 'close', text: T.fenceF(why) } : { go: 'park', resumeAt: 'posting', text: T.notReposted({ clause: T.cFence(why) }) + T.fenceSome };
      if (!this.rec.hbaFenceSet && !this.save({ hbaFenceSet: true })) return this.stop();
    }
    if (!this.save({ isolated: true })) return this.stop();
    return null;
  }

  private get(): Promise<AppHookResult> {
    return callAppHook(this.fresh(), 'migrate', 'GET', undefined, MIGRATE_TIMING.getMs);
  }

  /** M6's readiness: any HTTP answer to GET migrate. */
  private async waitReady(): Promise<string | null> {
    const deadline = Date.now() + MIGRATE_TIMING.readyMs;
    this.windowEnd = deadline;
    for (;;) {
      const r = await this.get();
      if (r.status !== undefined) return null;
      if (Date.now() >= deadline) return r.error || 'no answer';
      await sleep(MIGRATE_TIMING.readyPauseMs);
    }
  }

  async drive(adopted: Job | null): Promise<void> {
    let next: Next = this.entry(adopted);
    if (next.go !== 'prepare' && next.go !== 'end') next = await this.restartIfStopped(next);
    for (;;) {
      if (containerManager.isShuttingDown() && next.go !== 'end') return;
      switch (next.go) {
        case 'prepare': next = await this.prepare(); break;
        case 'post': next = await this.post(next.carry); break;
        case 'follow': next = await this.follow(next.carry); break;
        case 'refusal': next = await this.refusal(next.error, next.spent); break;
        case 'keep': next = await this.keep(next.keep); break;
        case 'done': next = await this.done(next.job); break;
        case 'finish': next = await this.finish(); break;
        case 'close': next = await this.close(next.text); break;
        case 'park': this.park(next); return;
        case 'stop':
          console.error(`[Migrate] ${this.name}: the migration's progress could not be recorded: ${next.error}`);
          emit(this.botId, T.notRecLane(next.error), true);
          return;
        case 'end': return;
      }
    }
  }

  private entry(adopted: Job | null): Next {
    if (adopted) return { go: 'follow' };
    switch (this.rec.phase) {
      case 'preparing': return { go: 'prepare' };
      case 'posting': return { go: 'post' };
      case 'following': return { go: 'follow' };
      case 'finishing': return { go: 'finish' };
      case 'closing': return { go: 'close', text: (this.rec.text || '').replace(ENV_BACK_TAIL, '') };
      default: return { go: 'end' };
    }
  }

  /**
   * M1b: the bot and the companion (or a managed source) started again after a Stop, before the lane goes on. At
   * posting and following the bot starts first and is asked about the job (X22); at closing F9 starts what F4 needs.
   */
  private async restartIfStopped(next: Next): Promise<Next> {
    const phase = this.rec.phase as Exclude<MigratePhase, 'waiting'>;
    if (phase === 'closing') return next;
    const early = phase === 'posting' || phase === 'following';
    const shown = phase === 'posting' ? (this.rec.jobIds[this.rec.jobIds.length - 1] ?? this.rec.jobId) : this.rec.jobId;
    let started = false;
    const startBot = async (): Promise<Next | null> => {
      if (await containerManager.appContainerRunning(this.botId) !== false) return null;
      const r = await containerManager.startBotInOp(this.botId, OP);
      if (!r.success) return { go: 'park', resumeAt: phase, text: r.error === containerManager.MIGRATE_GATE.needsBuild ? T.needsBuildWait(shown) : T.startWait(shown, r.error || 'no reason given') };
      await this.waitReady();
      started = true;
      return null;
    };
    if (early) {
      const p = await startBot();
      if (p) return p;
    }
    const own = this.fresh().fleetDb;
    const dbNeeded = this.rec.companion || (phase !== 'finishing' && this.sourceManaged());
    const state = dbNeeded && own ? await dbLogin.sidecarState(own.containerName) : null;
    const down = !!(dbNeeded && own) && state !== 'running';
    if (down) {
      if (early) {
        const v = getVerdict(hookAnswer(await this.get(), 'GET'), this.rec);
        if (v.act === 'done') return { go: 'done', job: v.job };
        if (v.act === 'failed') return { go: 'close', text: T.failed(v.job.jobId, v.job.stage || 'an unnamed stage', v.job.error || 'the bot gave no error', sourceText(this.rec.from)) };
      }
      const attached = this.rec.companion ? await containerManager.attachFleetDbService(this.botId) : { success: true };
      const up = attached.success ? await containerManager.startFleetDbSidecar(this.botId) : attached;
      if (!up.success) return { go: 'park', resumeAt: phase, text: T.dbStartWait(shown, up.error || 'no reason given') };
    }
    if (!early) {
      const p = await startBot();
      if (p) return p;
    }
    if (started) {
      const db = await this.databasesReady(phase === 'finishing');
      if (db) return { go: 'park', resumeAt: phase, text: T.dbWait(shown, db) };
    }
    if (early) {
      const p = await this.fenceAtFollow(phase, state === 'running' ? state : null);
      if (p) return p;
    }
    return next;
  }

  private park(p: Extract<Next, { go: 'park' }>): void {
    const ok = this.save({ phase: 'waiting', resumeAt: p.resumeAt, text: p.text, ...(p.awaiting ? { awaiting: p.awaiting } : {}) });
    if (!ok) {
      console.error(`[Migrate] ${this.name}: the wait could not be recorded: ${this.writeError}`);
      emit(this.botId, `${p.text} ${T.notRecLane(this.writeError)}`, true);
      return;
    }
    console.log(containerManager.scrubbedRecordText(this.botId, `[Migrate] ${this.name}: migration ${this.rec.jobId} to ${this.rec.to} waits for the operator: ${p.text}`));
    emit(this.botId, p.text, true);
  }

  // M2 to M6
  private async prepare(): Promise<Next> {
    const rec = this.rec;
    const own = () => this.fresh().fleetDb;
    if (rec.to === 'postgres' && rec.companion) {
      this.progress(T.pDb);
      try {
        const spec = containerManager.ensureFleetDataBackend(this.fresh(), { forMigrate: true });
        if (!spec) return { go: 'close', text: T.dbSetup('no managed database applies to this bot') };
      } catch (err) {
        return { go: 'close', text: T.dbSetup(errText(err)) };
      }
      const attached = await containerManager.attachFleetDbService(this.botId);
      if (!attached.success) return { go: 'close', text: T.dbSetup(attached.error || 'no reason given') };
      const up = await containerManager.startFleetDbSidecar(this.botId);
      if (!up.success) return { go: 'close', text: T.dbStart(up.error || 'no reason given') };
      const destination = identityOf(this.env()[this.urlKey()] || '');
      if (destination !== null && destination !== rec.destination && !this.save({ destination })) return this.stop();
    } else if (this.sourceManaged()) {
      const db = own();
      if (db && await dbLogin.sidecarRunning(db.containerName) !== true) {
        this.progress(T.pDb);
        const up = await containerManager.startFleetDbSidecar(this.botId);
        if (!up.success) return { go: 'close', text: T.dbStart(up.error || 'no reason given') };
      }
    }
    if (containerManager.isShuttingDown()) return { go: 'end' };

    // M3
    if ((rec.to === 'postgres' && rec.companion) || this.sourceManaged()) {
      const t = this.target();
      if (t) {
        this.progress(T.pLogin);
        const read = await dbLogin.readBotLogin(t);
        if (!read.ok) return { go: 'close', text: T.login(read.error) };
        if (read.login.inRecovery) return { go: 'close', text: T.login(MIGRATE_RECOVERY) };
        if (read.login.canLogin === null) return { go: 'close', text: T.login(`the role ${t.user} does not exist`) };
        if (read.login.canLogin === false) {
          if (!this.save({ loginOpened: true })) return this.stop();
          const opened = await dbLogin.openBotLogin(t);
          if (!opened.ok) return { go: 'close', text: T.login(opened.cls === 'recovery' ? MIGRATE_RECOVERY : opened.cls === 'write-fence' ? MIGRATE_FENCED : opened.error) };
          const back = await dbLogin.readBotLogin(t);
          if (!back.ok) return { go: 'close', text: T.login(back.error) };
          if (back.login.canLogin !== true) return { go: 'close', text: T.login('the login read back as blocked after it was opened') };
        }
      }
    }
    if (containerManager.isShuttingDown()) return { go: 'end' };

    // M4
    if (await containerManager.appContainerRunning(this.botId) === false) return { go: 'close', text: T.prepStopped };
    this.progress(T.pSave);
    const message = maintenance.maintenanceOf(this.fresh()).message;
    let lastReason = 'no answer';
    let lastNo: { guilds: number; files: number } | null = null;
    let lastUnknown = false;
    let saved = false;
    for (let attempt = 0; attempt < MIGRATE_TIMING.saveTries; attempt++) {
      if (attempt > 0) await sleep(MIGRATE_TIMING.savePauseMs);
      if (containerManager.isShuttingDown()) return { go: 'end' };
      const r = await callAppHook(this.fresh(), 'maintenance', 'POST', { state: 'maintenance', message }, MIGRATE_TIMING.hookMs);
      if (r.ok) {
        const held = maintenance.heldOf(r.body);
        maintenance.recordHeld(this.botId, held);
        if (held.state === 'yes') { saved = true; break; }
        if (held.state === 'no') { lastNo = { guilds: held.guilds, files: held.files }; lastUnknown = false; }
        else { lastNo = null; lastUnknown = true; }
        continue;
      }
      if (r.status === 404) return { go: 'close', text: T.unsavedUnknown('its build has no maintenance hook') };
      lastNo = null;
      lastUnknown = false;
      const detail = r.error || 'no reason given';
      lastReason = r.unknown ? 'no answer within 30 seconds' : r.status !== undefined ? `the bot answered: ${detail}` : `the bot could not be reached: ${detail}`;
    }
    if (!saved) {
      if (await containerManager.appContainerRunning(this.botId) === false) return { go: 'close', text: T.prepStopped };
      if (lastNo) return { go: 'close', text: T.unsaved(lastNo.guilds, lastNo.files) };
      return { go: 'close', text: T.unsavedUnknown(lastUnknown ? "it answered that it can't confirm" : lastReason) };
    }
    if (containerManager.isShuttingDown()) return { go: 'end' };

    // M5 and B35
    if (rec.to === 'file' && rec.from === 'postgres') {
      const held = await this.isolate('close');
      if (held) return held;
    }
    if (containerManager.isShuttingDown()) return { go: 'end' };

    // M6
    const late = switchStartRefusal(this.fresh());
    if (late) return { go: 'close', text: T.switchLate(late) };
    this.progress(T.pRestart);
    const stopped = await containerManager.stopBotInOp(this.botId, OP);
    if (!stopped.success && stopped.error !== 'Bot is not running') return { go: 'close', text: T.restart(stopped.error || 'no reason given', await this.stoppedTail()) };
    const started = await containerManager.startBotInOp(this.botId, OP);
    if (!started.success) return { go: 'close', text: T.restart(started.error || 'no reason given', await this.stoppedTail()) };
    const db = await this.databasesReady(false);
    if (db) return { go: 'close', text: T.dbStart(db) };
    const fenced = await this.renewFence();
    if (fenced) return { go: 'close', text: T.fenceF(fenced, true) };
    const notReady = await this.waitReady();
    if (notReady) return { go: 'close', text: T.notReady(notReady) };
    return { go: 'post' };
  }

  private async stoppedTail(): Promise<string> {
    const app = await containerManager.appContainerRunning(this.botId);
    return app === false ? T.restartStopped : app === null ? T.restartUnknown : '';
  }

  /** G14: the bots in sharers by docker's answer at the close: stopped, running, unanswered. */
  private async sharersText(ids: string[]): Promise<string> {
    const stay: string[] = [];
    const run: string[] = [];
    const unsure: string[] = [];
    for (const id of ids) {
      const app = await containerManager.appContainerRunning(id);
      (app === false ? stay : app ? run : unsure).push(id);
    }
    return `${stay.length ? T.sharersStay(this.names(stay), stay.length) : ''}${run.length ? T.sharersRun(this.names(run), run.length) : ''}${unsure.length ? T.sharersUnsure(this.names(unsure), unsure.length) : ''}`;
  }

  private addJob(jobId: string): Partial<MigrateRecord> {
    return { jobId, jobIds: this.rec.jobIds.includes(jobId) ? this.rec.jobIds : [...this.rec.jobIds, jobId] };
  }

  /** G24, G25 (D134): the copy that finished was started by the bot itself with no line of this record (open), or after its step began without finishing (unsure); null when the manager started it behind the step, or for any other move. */
  private copyOpenOf(jobId: string): 'open' | 'unsure' | null {
    if (this.rec.to !== 'file' || this.rec.from !== 'postgres') return null;
    if (jobId === this.rec.adoptedJob) return 'open';
    if (this.rec.isolated) return null;
    return this.rec.hbaFence || this.rec.sharersStopped.length > 0 ? 'unsure' : 'open';
  }

  // M7
  private async post(carry?: Carry): Promise<Next> {
    if (this.rec.to === 'file' && this.rec.from === 'postgres' && !this.rec.isolated) {
      const held = await this.isolate('park');
      if (held) return held;
    }
    let sentBefore = this.rec.posted;
    if (!this.save({ phase: 'posting', posted: true, ...this.addJob(this.rec.jobId), text: T.pPost(this.rec.jobId) })) return this.stop();
    emit(this.botId, T.pPost(this.rec.jobId));
    const windowEnd = carry ? carry.windowEnd : this.windowEnd > Date.now() ? this.windowEnd : Date.now() + MIGRATE_TIMING.windowMs;
    let unknown = 0;
    let sessionEnd = carry?.sessionEnd ?? 0;
    let unreachableSince = 0;
    for (;;) {
      if (containerManager.isShuttingDown()) return { go: 'end' };
      const url = this.rec.to === 'postgres' ? (this.env()[this.urlKey()] || '').trim() : '';
      const body = { jobId: this.rec.jobId, to: this.rec.to, ...(this.rec.to === 'postgres' && url ? { url } : {}) };
      const a = hookAnswer(await callAppHook(this.fresh(), 'migrate', 'POST', body, MIGRATE_TIMING.postMs), 'POST');
      const v = postVerdict(a, { ...this.rec, posted: sentBefore });
      sentBefore = true;
      console.log(containerManager.scrubbedRecordText(this.botId, `[Migrate] ${this.name}: migration ${this.rec.jobId} to ${this.rec.to}: the bot answered ${a.kind === 'answer' ? String(a.body.state) : `refused: ${'error' in a ? a.error : 'no hook'}`}`));
      switch (v.act) {
        case 'follow':
          if (!this.save({ ...this.addJob(v.jobId), ...(v.started ? { started: this.rec.started + 1 } : {}) })) return this.stop();
          this.progress(T.pRun(v.jobId));
          return { go: 'follow', carry: { windowEnd, sessionEnd, sessionJobs: carry?.sessionJobs ?? [], ...(v.started ? { counted: v.jobId } : {}) } };
        case 'done':
          if (!this.save(this.addJob(v.jobId))) return this.stop();
          return { go: 'follow' };
        case 'interrupted': {
          if (!this.save(this.addJob(v.job.jobId))) return this.stop();
          return this.interrupted(v.job);
        }
        case 'failed':
          if (!this.save(this.addJob(v.job.jobId))) return this.stop();
          return { go: 'close', text: T.failed(v.job.jobId, v.job.stage || 'an unnamed stage', v.job.error || 'the bot gave no error', sourceText(this.rec.from)) };
        case 'park':
          if (v.why === 'otherjob') return { go: 'park', resumeAt: 'following', text: T.otherJob(this.rec.jobId, v.job!.jobId, X(v.job!.to), v.job!.state) };
          if (v.why === 'nohook') return { go: 'park', resumeAt: 'following', text: T.noHookKept(this.rec.jobId) };
          return { go: 'park', resumeAt: 'following', text: T.auth(v.status!, v.error!, this.rec.jobId) };
        case 'close':
          return { go: 'close', text: v.why === 'nohook' ? T.noHook : T.authF(v.status!, v.error!) };
        case 'retry':
          if (v.why === 'unknown') {
            unknown++;
            if (unknown >= MIGRATE_TIMING.unknownTries) return { go: 'park', resumeAt: 'following', text: T.unknownPost(this.rec.jobId) };
            await sleep(MIGRATE_TIMING.unknownPauseMs);
          } else if (v.why === 'unreachable') {
            if (!unreachableSince) unreachableSince = Date.now();
            if (Date.now() >= windowEnd) return { go: 'park', resumeAt: 'following', text: T.noAnswer(this.rec.jobId, spanText(Date.now() - unreachableSince), v.error) };
            await sleep(MIGRATE_TIMING.retryPauseMs);
          } else {
            unreachableSince = 0;
            const now = Date.now();
            if (!sessionEnd) sessionEnd = now + MIGRATE_TIMING.sessionMs;
            if (now >= sessionEnd) return { go: 'refusal', error: v.error };
            this.progress(T.pSession(this.rec.jobId, seconds(now - (sessionEnd - MIGRATE_TIMING.sessionMs))));
            await sleep(MIGRATE_TIMING.sessionPauseMs);
          }
          break;
        case 'refusal':
          return { go: 'refusal', error: v.error };
      }
    }
  }

  private async interrupted(job: Job): Promise<Next> {
    const v = interruptVerdict(job, this.rec);
    if (v.act === 'keep') return { go: 'keep', keep: v.keep };
    if (v.act === 'spent') return { go: 'refusal', error: job.error || 'the bot gave no error', spent: job };
    this.progress(T.pAgain(job.jobId, job.stage || 'an unnamed stage'));
    await sleep(MIGRATE_TIMING.againMs);
    if (!this.save({ jobId: mintJobId() })) return this.stop();
    return { go: 'post' };
  }

  // M8
  private async follow(carry?: Carry): Promise<Next> {
    if (this.rec.phase !== 'following' && !this.save({ phase: 'following' })) return this.stop();
    let silentSince = 0;
    let startedOnce = false;
    let lastUnusable: { status: number; error: string } | null = null;
    for (;;) {
      if (containerManager.isShuttingDown()) return { go: 'end' };
      const a = hookAnswer(await this.get(), 'GET');
      const v = getVerdict(a, this.rec, carry?.sessionJobs ?? []);
      if (v.act !== 'silent') { silentSince = 0; lastUnusable = null; }
      switch (v.act) {
        case 'poll':
          if (v.job.stage && v.job.stage !== this.rec.stage) {
            if (!this.save({ stage: v.job.stage, text: T.pStage(this.rec.jobId, v.job.stage) })) console.warn(`[Migrate] ${this.name}: the stage could not be recorded: ${this.writeError}`);
            emit(this.botId, T.pStage(this.rec.jobId, v.job.stage));
          }
          break;
        case 'follow':
          if (!this.save(this.addJob(v.jobId))) return this.stop();
          this.progress(T.pRun(v.jobId));
          break;
        case 'done':
          return { go: 'done', job: v.job };
        case 'failed':
          return { go: 'close', text: T.failed(v.job.jobId, v.job.stage || 'an unnamed stage', v.job.error || 'the bot gave no error', sourceText(this.rec.from)) };
        case 'transient': {
          const now = Date.now();
          const w: Carry = carry ? { ...carry, sessionJobs: [...carry.sessionJobs] } : { windowEnd: this.windowEnd > now ? this.windowEnd : now + MIGRATE_TIMING.windowMs, sessionEnd: 0, sessionJobs: [] };
          const takeBack = carry?.counted === v.job.jobId ? 1 : 0;
          delete w.counted;
          if (v.why === 'session') {
            for (const id of sessionJobIds(v.job.error ?? '')) if (!w.sessionJobs.includes(id)) w.sessionJobs.push(id);
            w.sessionEnd = w.sessionEnd || now + MIGRATE_TIMING.sessionMs;
            if (now >= w.sessionEnd) return { go: 'refusal', error: v.job.error || 'the bot gave no error' };
            this.progress(T.pSession(v.job.jobId, seconds(now - (w.sessionEnd - MIGRATE_TIMING.sessionMs))));
            await sleep(MIGRATE_TIMING.sessionPauseMs);
          } else {
            if (now >= w.windowEnd) return { go: 'refusal', error: v.job.error || 'the bot gave no error' };
            await sleep(MIGRATE_TIMING.retryPauseMs);
          }
          if (!this.save({ jobId: mintJobId(), started: Math.max(0, this.rec.started - takeBack) })) return this.stop();
          return { go: 'post', carry: w };
        }
        case 'again':
          return this.interrupted(v.job);
        case 'spent':
          return { go: 'refusal', error: v.job.error || 'the bot gave no error', spent: v.job };
        case 'keep':
          return { go: 'keep', keep: v.keep };
        case 'repost':
          if (this.rec.kept >= KEEP) {
            return { go: 'park', resumeAt: 'following', text: v.why === 'null' ? T.nullJob(this.rec.jobId) : T.otherJob(this.rec.jobId, v.job!.jobId, X(v.job!.to), v.job!.state) };
          }
          if (!this.save({ kept: this.rec.kept + 1 })) return this.stop();
          await sleep(MIGRATE_TIMING.againMs);
          return { go: 'post' };
        case 'park':
          if (v.why === 'otherrun') return { go: 'park', resumeAt: 'following', text: T.otherJob(this.rec.jobId, v.job!.jobId, X(v.job!.to), v.job!.state) };
          if (v.why === 'nohook') return { go: 'park', resumeAt: 'following', text: T.noHookKept(this.rec.jobId) };
          return { go: 'park', resumeAt: 'following', text: T.auth(v.status!, v.error!, this.rec.jobId) };
        case 'silent': {
          const now = Date.now();
          if (!silentSince) silentSince = now;
          lastUnusable = v.unusable;
          const quiet = now - silentSince;
          if (quiet >= MIGRATE_TIMING.silentParkMs) {
            return { go: 'park', resumeAt: 'following', text: lastUnusable ? T.unusable(this.rec.jobId, spanText(quiet), lastUnusable.status, lastUnusable.error) : T.noAnswer(this.rec.jobId, spanText(quiet), v.error) };
          }
          if (quiet >= MIGRATE_TIMING.silentCheckMs) {
            emit(this.botId, lastUnusable ? T.pUnusable(this.rec.jobId, seconds(quiet), lastUnusable.status, lastUnusable.error) : T.pNoAnswer(this.rec.jobId, seconds(quiet)));
            if (!startedOnce && await containerManager.appContainerRunning(this.botId) === false) {
              startedOnce = true;
              const r = await containerManager.startBotInOp(this.botId, OP);
              if (r.success) {
                const db = await this.databasesReady(false);
                if (db) return { go: 'park', resumeAt: 'following', text: T.dbWait(this.rec.jobId, db) };
                const why = await this.renewFence();
                if (why) return { go: 'park', resumeAt: 'following', text: T.fenceWait(this.rec.jobId, why) };
              }
            }
          }
          break;
        }
      }
      await sleep(MIGRATE_TIMING.pollMs);
    }
  }

  // E
  private async refusal(error: string, spent?: Job): Promise<Next> {
    if (containerManager.isShuttingDown()) return { go: 'end' };
    const a = hookAnswer(await this.get(), 'GET');
    const v = refusalVerdict(a, this.rec);
    switch (v.act) {
      case 'done': return { go: 'done', job: v.job };
      case 'follow':
        if (!this.save(this.addJob(v.jobId))) return this.stop();
        return { go: 'follow' };
      case 'keep': return { go: 'keep', keep: v.keep };
      case 'park':
        return v.why === 'auth' ? { go: 'park', resumeAt: 'following', text: T.auth(v.status!, v.error!, this.rec.jobId) } : { go: 'park', resumeAt: 'following', text: T.noHookKept(this.rec.jobId) };
      case 'close':
        return { go: 'close', text: spent ? T.spent(spent.jobId, spent.stage || 'an unnamed stage', spent.error || 'the bot gave no error', sourceText(this.rec.from)) : T.refused(error, sourceText(this.rec.from)) };
    }
  }

  // E3
  private async keep(keep: Keep): Promise<Next> {
    const err = keep.error;
    const clause = keptClause(keep, this.rec.to);
    if (this.rec.started >= CAP || this.rec.kept >= KEEP) {
      return { go: 'park', resumeAt: 'posting', text: T.kept(this.rec.jobId, clause, err, this.rec.started >= CAP ? T.retryCap : T.retryKeep) };
    }
    const delay = keepDelay(this.rec.kept);
    if (!this.save({ kept: this.rec.kept + 1 })) return this.stop();
    this.progress(T.kept(this.rec.jobId, clause, err, T.retryIn(seconds(delay))));
    await sleep(delay);
    if (containerManager.isShuttingDown()) return { go: 'end' };
    if (!this.save({ jobId: mintJobId() })) return this.stop();
    return { go: 'post' };
  }

  // G1 to G4
  private async done(job: Job | null): Promise<Next> {
    if (job) this.job = job;
    let destination = this.rec.destination;
    let host: InstanceConfig | null = null;
    if (this.rec.to === 'postgres') {
      const named = job ? identityOf(job.destination as Destination) : null;
      host = named ? containerManager.databaseHostOf(DISPLAY(named)) : null;
      if (host && host.id !== this.botId) return { go: 'close', text: T.destHosted(job?.jobId ?? this.rec.jobId, DISPLAY(named), host.displayName) };
      if (host && host.id === this.botId && !this.rec.companion) {
        const own = this.fresh().fleetDb!;
        const jobId = job?.jobId ?? this.rec.jobId;
        const dest = DISPLAY(named);
        let why: string | null = own.retiringAt ? T.whyRetiring(own.retiringAt) : null;
        const retiring = !!own.retiringAt;
        const file = why ? null : fleetBackup.shownRestoreNoticeFile(this.botId);
        if (file) why = T.whyNotice(file);
        if (!why) {
          const state = await dbLogin.sidecarState(own.containerName);
          if (state === 'restarting') why = T.whyRestarting;
          else if (state === 'running') {
            const fence = await dbLogin.readWriteFence({ container: own.containerName, user: own.user });
            if (!fence.ok) return { go: 'park', resumeAt: 'following', text: T.destFenceRead(jobId, dest, fence.error) };
            if (fence.on) why = T.whyFence(maintenance.fenceWords(fence).state);
          }
        }
        if (!why && own.replication) why = T.whyRepl;
        if (why) return { go: 'close', text: T.destOwn(jobId, dest, why, retiring) };
      }
      const read = readEnv(this.fresh());
      const storedUrl = 'error' in read ? '' : (read.env[read.urlKey] || '').trim();
      if (named && sameDatabase(named, this.rec.destination)) {
        if ('error' in read) return { go: 'park', resumeAt: 'following', awaiting: 'destination', text: T.destUrlRead(job?.jobId ?? this.rec.jobId, DISPLAY(named)) };
        if (!sameDatabase(named, storedUrl)) return { go: 'park', resumeAt: 'following', awaiting: 'destination', text: T.destUrl(job?.jobId ?? this.rec.jobId, DISPLAY(named), DISPLAY(identityOf(storedUrl))) };
        destination = named;
      }
      else if (named && sameDatabase(named, storedUrl)) destination = named;
      else {
        return { go: 'park', resumeAt: 'following', awaiting: 'destination', text: T.dest(job?.jobId ?? this.rec.jobId, named ? DISPLAY(named) : 'no database', DISPLAY(this.rec.destination)) };
      }
    }
    const jobId = job?.jobId ?? this.rec.jobId;
    const companion = host?.id === this.botId && !this.rec.companion ? { companion: true } : {};
    const open = this.copyOpenOf(jobId);
    if (!this.save({ phase: 'finishing', ...this.addJob(jobId), destination, ...companion, ...(open ? { copyOpen: open } : {}), text: T.pFinish(X(this.rec.to)) }, open ? ['finishing'] : ['finishing', 'copyOpen'])) return this.stop();
    emit(this.botId, T.pFinish(X(this.rec.to)));
    return { go: 'finish' };
  }

  // G5 to G14
  private async finish(): Promise<Next> {
    const rec = () => this.rec;
    const dest = () => destText(this.rec);
    if (this.rec.hbaFence) {
      const lift = await this.liftFence();
      if ('standing' in lift) return { go: 'park', resumeAt: 'finishing', text: T.fenceBackDone(this.rec.jobId, destText(this.rec), lift.standing) };
      if (!this.save(lift.left ? { fenceLift: lift.left } : {}, ['hbaFence', 'hbaFenceSet'])) return this.stop();
    }
    if (!rec().finishing) {
      try {
        await containerManager.updateBotInOp(this.botId, { envVars: { DATA_BACKEND: rec().to } }, OP);
      } catch (err) {
        return { go: 'park', resumeAt: 'finishing', text: T.envStore(rec().jobId, dest(), errText(err)) };
      }
      const former = rec().to === 'file' ? this.fresh().fleetDb?.formerMain : undefined;
      if (former) {
        try {
          containerManager.updateInstanceFleetDbSwitch(this.botId, { formerMain: null });
        } catch (err) {
          return { go: 'park', resumeAt: 'finishing', text: T.formerKept(rec().jobId, dest(), errText(err)) };
        }
        console.log(`[Migrate] ${this.name}: this bot keeps its data in JSON files now, so the manager no longer checks the old main ${former.machine}`);
      }
      if (!this.save({ finishing: 'stored' })) return this.stop();
    }
    if (containerManager.isShuttingDown()) return { go: 'end' };
    if (rec().finishing === 'stored') {
      if (rec().to === 'postgres' && rec().companion) {
        const attached = await containerManager.attachFleetDbService(this.botId);
        const up = attached.success ? await containerManager.startFleetDbSidecar(this.botId) : attached;
        if (!up.success) return { go: 'park', resumeAt: 'finishing', text: T.apply(rec().jobId, dest(), up.error || 'no reason given') };
      }
      const stopped = await containerManager.stopBotInOp(this.botId, OP);
      if (!stopped.success && stopped.error !== 'Bot is not running') return { go: 'park', resumeAt: 'finishing', text: T.apply(rec().jobId, dest(), stopped.error || 'no reason given') };
      if (stopped.success && rec().fenceLift && !this.save({}, ['fenceLift'])) return this.stop();
      const started = await containerManager.startBotInOp(this.botId, OP);
      if (!started.success) return { go: 'park', resumeAt: 'finishing', text: T.apply(rec().jobId, dest(), started.error || 'no reason given') };
      this.notApplied = started.notApplied ?? [];
      const db = await this.databasesReady(true);
      if (db) return { go: 'park', resumeAt: 'finishing', text: T.apply(rec().jobId, dest(), db) };
      if (!this.save({ finishing: 'applied' })) return this.stop();
    }
    if (containerManager.isShuttingDown()) return { go: 'end' };
    if (rec().finishing === 'applied') {
      const urlKey = this.urlKey();
      const read = await containerManager.appContainerEnv(this.botId, ['DATA_BACKEND', urlKey]);
      const back = (text: string): Next => (this.save({ finishing: 'stored' }) ? { go: 'park', resumeAt: 'finishing', text } : this.stop());
      if (!read.ok) return back(T.envDocker(rec().jobId, dest(), read.error));
      const value = read.env.DATA_BACKEND;
      const valueOk = (value ?? '').trim().toLowerCase() === rec().to;
      const urlId = rec().to === 'postgres' ? identityOf(read.env[urlKey] ?? '') : null;
      const urlOk = rec().to !== 'postgres' || (urlId !== null && urlId === identityOf(rec().destination));
      if (!valueOk || !urlOk) {
        const named = rec().to === 'postgres' ? (urlId ? DISPLAY(urlId) : 'no database') : null;
        return back(T.env(rec().jobId, dest(), value === undefined ? 'nothing' : value, named, this.notApplied.length ? this.notApplied.join('; ') : 'the start reported no error'));
      }
      if (rec().to === 'postgres' && rec().companion) {
        const own = this.fresh().fleetDb;
        const state = own ? await dbLogin.sidecarState(own.containerName) : null;
        if (state !== 'running') return back(T.envDb(rec().jobId, DISPLAY(rec().destination), state));
      }
      if (!this.save({ finishing: 'confirmed' })) return this.stop();
    }
    if (containerManager.isShuttingDown()) return { go: 'end' };
    this.progress(T.pBack);
    const order = await maintenance.runOrderInOp(this.botId, 'running', '', OP);
    const kept = rec().to === 'postgres' ? T.keptPg : T.keptFile;
    const leftOut = Array.isArray(this.job?.leftOut) ? (this.job!.leftOut as unknown[]).length : 0;
    const sharerText = rec().to === 'file' ? await this.sharersText(rec().sharers) : '';
    const open = rec().copyOpen === 'open' ? T.doneOpen : rec().copyOpen === 'unsure' ? T.doneUnsure : '';
    const head = `${T.done(dest(), rec().jobId, X(rec().to))} ${kept}${leftOut > 0 ? T.left(leftOut) : ''}${sharerText}${open}${fenceLeftTail(rec().fenceLift ?? '')}`;
    const text = 'refused' in order ? `${head}${T.wRunning(order.error)}` : `${head} ${order.text}`;
    if ('refused' in order && rec().loginOpened) {
      const why = await this.blockOpenedLogin();
      if (why) return { go: 'park', resumeAt: 'finishing', text: head + T.wRunningOpen(order.error) + T.loginBackDone(why) };
    }
    const last: MigrateLast = { to: rec().to, outcome: 'done', jobId: rec().jobId, text, at: new Date().toISOString() };
    try {
      containerManager.updateInstanceMigrate(this.botId, null, last);
    } catch (err) {
      this.writeError = errText(err);
      return this.stop();
    }
    console.log(`[Migrate] ${this.name}: migration ${rec().jobId} to ${rec().to} is done; the Data Backend is now ${rec().to}`);
    emit(this.botId, text, true);
    return { go: 'end' };
  }

  // F
  private async close(text: string): Promise<Next> {
    if (this.rec.finishing) return { go: 'park', resumeAt: 'finishing', text };
    if (!this.save({ phase: 'closing', text })) return this.stop();
    emit(this.botId, T.pClose(sourceText(this.rec.from)));
    const env = readEnv(this.fresh());
    const storedFrom = 'error' in env ? null : backendOf(env.env);
    if (storedFrom !== this.rec.from) {
      try {
        if ('error' in env) throw new Error(env.error);
        await containerManager.updateBotInOp(this.botId, { envVars: { DATA_BACKEND: this.rec.from } }, OP);
      } catch (err) {
        return { go: 'park', resumeAt: 'closing', text: text + T.envBack(X(this.rec.from), errText(err)) };
      }
    }
    let downTail = '';
    if (this.rec.loginOpened) {
      const down = await this.loginDatabaseDown();
      if (down) downTail = this.rec.to === 'file' ? T.loginDownFile(down.err, down.state) : T.loginDownPg(down.err, down.state);
      else {
        const why = await this.blockOpenedLogin();
        if (why) return { go: 'park', resumeAt: 'closing', text: text + T.loginBack(why) };
      }
    }
    let fenceTail = '';
    if (this.rec.hbaFence) {
      const lift = await this.liftFence();
      if ('standing' in lift) return { go: 'park', resumeAt: 'closing', text: text + T.fenceBack(lift.standing) };
      fenceTail = fenceLeftTail(lift.left);
    }
    let warnings = '';
    for (const id of this.rec.sharersStopped) {
      const s = containerManager.getBot(id);
      if (!s || s.maintenance?.state === 'off') continue;
      const op = containerManager.isBotBusy(id);
      if (op) { warnings += T.wSharerBusy(s.displayName, op); continue; }
      const app = await containerManager.appContainerRunning(id);
      if (app === null) { warnings += T.wSharer(s.displayName, 'docker did not say whether it runs'); continue; }
      if (app) continue;
      try {
        const r = await containerManager.startBot(id);
        if (!r.success && r.error !== 'Bot is already running') warnings += T.wSharer(s.displayName, r.error || 'no reason given');
      } catch (err) {
        warnings += T.wSharer(s.displayName, errText(err));
      }
    }
    const final = text + downTail + fenceTail + warnings;
    const last: MigrateLast = { to: this.rec.to, outcome: 'failed', jobId: this.rec.posted ? this.rec.jobId : null, text: final, at: new Date().toISOString() };
    try {
      containerManager.updateInstanceMigrate(this.botId, null, last);
    } catch (err) {
      this.writeError = errText(err);
      return this.stop();
    }
    console.log(containerManager.scrubbedRecordText(this.botId, `[Migrate] ${this.name}: migration to ${this.rec.to} closed: ${final}`));
    emit(this.botId, final, true);
    return { go: 'end' };
  }

  /** F4 and G12: blocks the login this record opened, ends its sessions and reads it back; null once it reads blocked. */
  private async blockOpenedLogin(): Promise<string | null> {
    const t = this.target();
    if (!t) return null;
    const blocked = await dbLogin.blockBotLogin(t);
    const ended = blocked.ok ? await dbLogin.endBotSessions(t, maintenance.MAINTENANCE_TIMING.sessionPauseMs) : blocked;
    const read = ended.ok ? await dbLogin.readBotLogin(t) : ended;
    return !read.ok ? read.error
      : read.login.canLogin !== false ? 'the login read back as open after it was blocked'
      : read.login.sessions > 0 ? `${read.login.sessions} session(s) of the bot's role are still open`
      : null;
  }

  /** F9: the start's error when docker shows the login's database stopped or restarting and it does not start; null when it runs, starts, or docker did not say. */
  private async loginDatabaseDown(): Promise<{ err: string; state: 'stopped' | 'restarting' } | null> {
    const t = this.target();
    const state = t ? await dbLogin.sidecarState(t.container) : null;
    if (state !== 'stopped' && state !== 'restarting') return null;
    const attached = this.rec.companion ? await containerManager.attachFleetDbService(this.botId) : { success: true };
    const up = attached.success ? await containerManager.startFleetDbSidecar(this.botId) : attached;
    return up.success ? null : { err: up.error || 'no reason given', state };
  }

  /** F10, F11 and G21: the migration's pg_hba lines lifted; what the lift left for the tail, or why they stand. */
  private async liftFence(): Promise<{ left: '' | 'stripped' | 'unconfirmed' } | { standing: string }> {
    const db = this.fresh().fleetDb;
    if (!this.rec.hbaFence || !db) return { left: '' };
    const lift = await fleetBackup.liftMigrateFence(db, this.rec.hbaFence);
    if (lift.result === 'lifted' || lift.result === 'gone') return { left: '' };
    if (lift.result === 'stripped' || lift.result === 'unconfirmed') return { left: lift.result };
    if (lift.result === 'unknown') return { standing: T.whyLiftVolume(db.volume) };
    return { standing: T.whyLiftLocked(lift.detail || 'no reason given') };
  }

  /** B38, X23, X24: the lines renewed for the container's current addresses, only on a record with isolated; null when they stand. */
  private renewFence(): Promise<string | null> {
    return this.rec.hbaFence && this.rec.isolated ? fleetBackup.fenceMigrateSource(this.fresh(), this.rec.hbaFence, { refresh: true }) : Promise.resolve(null);
  }

  /** X27 (D136): the search at an adoption; every bot found is saved as held (sharers) right after it, except one with a migration of its own open (D135) or with replication on its own managed database (Q8); none is read from docker or stopped. ids: the found bots still in the registry; repl: the found ones left out for replication. */
  private async adoptSharers(): Promise<{ ids: string[]; repl: string[] } | Next> {
    const url = (this.env()[this.urlKey()] || '').trim();
    const found = url ? (await fleetBackup.runningDatabaseSharers(this.fresh(), url)).filter(b => b.id !== this.botId) : [];
    const ids = Array.from(new Set([...this.rec.sharers, ...found.map(b => b.id)]));
    const sharers = ids.filter(id => {
      const s = containerManager.getBot(id);
      return !s || (!s.migrate && !replicationOn(s));
    });
    if (sharers.join() !== this.rec.sharers.join() && !this.save({ sharers })) return this.stop();
    const known = ids.flatMap(id => containerManager.getBot(id) ?? []);
    return { ids: known.map(s => s.id), repl: known.filter(replicationOn).map(s => s.id) };
  }

  /** X23, X26, X27, X31, X32: before the follow, on a record without isolated only the search and its hold (no line, no renewal); else, while docker shows the database running, the lines renewed. The park or stop when they could not be, else null. */
  private async fenceAtFollow(phase: Exclude<MigratePhase, 'waiting'>, known: 'running' | null): Promise<Next | null> {
    if (this.rec.to === 'file' && this.rec.from === 'postgres' && !this.rec.isolated) {
      if (phase === 'posting') return null;
      const found = await this.adoptSharers();
      if ('go' in found) return found;
      if (!this.rec.hbaFence && this.rec.sharersStopped.length === 0) this.progress(T.pOpen(found.ids.map(id => this.names([id])), found.repl.map(id => this.names([id]))));
      return null;
    }
    if (!this.rec.hbaFence) return null;
    const own = this.fresh().fleetDb;
    if (!own) return null;
    const jobShown = phase === 'posting' ? null : this.rec.jobId;
    const now = known ?? await dbLogin.sidecarState(own.containerName);
    if (now !== 'running') return { go: 'park', resumeAt: phase, text: T.fenceWait(jobShown, T.whyDbDown(now)) };
    const why = await this.renewFence();
    return why ? { go: 'park', resumeAt: phase, text: T.fenceWait(jobShown, why) } : null;
  }
}

const MIGRATE_RECOVERY = 'the database is a live copy in recovery';
const MIGRATE_FENCED = 'the database is READ-ONLY under a write fence';
