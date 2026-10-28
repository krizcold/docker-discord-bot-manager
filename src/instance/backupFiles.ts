/**
 * The backup schedule's pure parts: the dump file names, when a dump or a test restore is due, which dumps the trim
 * deletes, the table counts taken with each dump and their comparison, and the alert step. The scheduler
 * (fleetBackup) and the test restore (backupCheck) read the folder and the registry and pass the facts in.
 */
import * as path from 'path';
import { BackupFamily, FleetBackupAlert, FleetBackupTestRecord } from '../types';

export type { BackupFamily };
export type DumpKind = 'hourly' | 'daily' | 'safety' | 'other';
export type ScheduledKind = 'hourly' | 'daily';

export interface ParsedDump { file: string; family: BackupFamily; kind: DumpKind; stamp: number | null }

/** The counts file written beside every dump as <dump>.json. */
export interface DumpMeta {
  file: string;
  takenAt: number;
  family: BackupFamily;
  kind: DumpKind;
  inRecovery: boolean;
  dataAt: number | null;
  dbBytes: number;
  tables: number;
  rows: number;
  counts: Record<string, number>;
}

const HOUR_MS = 3_600_000;
export const HOURLY_KEEP_MS = 48 * HOUR_MS;
export const DAILY_KEEP_MS = 30 * 24 * HOUR_MS;
export const ALERT_AFTER_MS = 3 * HOUR_MS;
/** A stamp further ahead of the clock than this means the clock stepped back. */
export const CLOCK_SLACK_MS = 5 * 60_000;
export const DM_RETRY_MS = HOUR_MS;

export const COPY_FILE_PREFIX = 'copy-';

export function backupDir(botId: string): string {
  return path.join(process.env.DATA_DIR || '/data/data', 'backups', botId, 'fleet-postgres');
}

export function stampOf(at: number): string {
  return new Date(at).toISOString().replace(/[:.]/g, '-');
}

export function dumpFileName(family: BackupFamily, kind: ScheduledKind, at: number): string {
  return `${family === 'copy' ? COPY_FILE_PREFIX : ''}${kind}-${stampOf(at)}.dump`;
}

const SCHEDULED_RE = /^(copy-)?(hourly|daily)-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.dump$/;

export function parseDumpName(file: string): ParsedDump {
  const m = SCHEDULED_RE.exec(file);
  if (m) {
    const stamp = Date.parse(`${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`);
    if (Number.isFinite(stamp) && stampOf(stamp) === `${m[3]}T${m[4]}-${m[5]}-${m[6]}-${m[7]}Z`) {
      return { file, family: m[1] ? 'copy' : 'main', kind: m[2] as ScheduledKind, stamp };
    }
  }
  if (file.startsWith('pre-')) return { file, family: 'main', kind: 'safety', stamp: null };
  return { file, family: file.startsWith(COPY_FILE_PREFIX) ? 'copy' : 'main', kind: 'other', stamp: null };
}

/** The family's hourly and daily dumps in a folder listing. */
function scheduled(files: string[], family: BackupFamily): ParsedDump[] {
  return files.map(parseDumpName).filter(p => p.family === family && (p.kind === 'hourly' || p.kind === 'daily') && p.stamp !== null);
}

/** The start of the local hour holding now. */
export function hourSlot(now: number): number {
  const d = new Date(now);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

/** Today at hour:00 local time, or yesterday's when today's is still ahead. */
export function dailyBoundary(now: number, hour: number): number {
  const d = new Date(now);
  d.setHours(hour, 0, 0, 0);
  if (d.getTime() <= now) return d.getTime();
  d.setDate(d.getDate() - 1);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

/** Which dump of the family is due now; null when none, or when this hour slot was already attempted. */
export function dumpDue(files: string[], family: BackupFamily, now: number, hour: number, attemptedSlot?: number): ScheduledKind | null {
  const slot = hourSlot(now);
  if (attemptedSlot === slot) return null;
  const valid = scheduled(files, family).filter(p => p.stamp! <= now + CLOCK_SLACK_MS);
  const boundary = dailyBoundary(now, hour);
  if (!valid.some(p => p.kind === 'daily' && p.stamp! >= boundary)) return 'daily';
  if (!valid.some(p => p.stamp! >= slot)) return 'hourly';
  return null;
}

/** The newest hourly or daily dump of the family, by its stamp; null when none. */
export function newestScheduled(files: string[], family: BackupFamily): ParsedDump | null {
  return scheduled(files, family).reduce<ParsedDump | null>((a, p) => (!a || p.stamp! > a.stamp! ? p : a), null);
}

/**
 * The family's dumps past their keep, oldest kept rules applied: never the family's newest, never a protected name
 * (the last tested good dump, the dump just written, the dump a failed restore names), never a safety or other file.
 * Nothing when a stamp of the family is ahead of the clock.
 */
export function trimVictims(files: string[], family: BackupFamily, now: number, protect: Array<string | null | undefined>): { victims: string[]; clockAhead: boolean } {
  const mine = scheduled(files, family);
  if (mine.some(p => p.stamp! > now + CLOCK_SLACK_MS)) return { victims: [], clockAhead: true };
  const newest = newestScheduled(files, family)?.file;
  const kept = new Set(protect.filter((f): f is string => typeof f === 'string'));
  const victims = mine.filter(p => p.file !== newest && !kept.has(p.file)
    && now - p.stamp! > (p.kind === 'hourly' ? HOURLY_KEEP_MS : DAILY_KEEP_MS)).map(p => p.file).sort();
  return { victims, clockAhead: false };
}

export function testDue(last: FleetBackupTestRecord | undefined, now: number, hour: number): boolean {
  if (!last) return true;
  if (last.result === 'interrupted') return true;
  return last.startedAt < dailyBoundary(now, hour);
}

/** One `count|"schema"."table"|<n>` line per permanent table, ordered by name; extension members and unlogged tables are left out. */
export const COUNTS_SQL = "SELECT 'count|' || format('%I.%I', n.nspname, c.relname) || '|' || "
  + "(xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text "
  + 'FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace '
  + "WHERE c.relkind = 'r' AND c.relpersistence = 'p' AND n.nspname NOT IN ('pg_catalog', 'information_schema') "
  + "AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%' "
  + "AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e') "
  + 'ORDER BY n.nspname, c.relname';

/** `snap|<snapshot id>|<t|f>|<database bytes>|<dataAt ms or -1>` from the transaction that holds the snapshot. */
export const SNAP_SQL = "SELECT 'snap|' || pg_export_snapshot() || '|' || (CASE WHEN pg_is_in_recovery() THEN 't' ELSE 'f' END) || '|' || "
  + 'pg_database_size(current_database()) || \'|\' || '
  + "coalesce((extract(epoch FROM (CASE WHEN pg_is_in_recovery() THEN pg_last_xact_replay_timestamp() ELSE now() END)) * 1000)::bigint::text, '-1')";

/** What the dump's snapshot holder reads on stdin before the dump runs; COMMIT follows once the dump is written. */
export function holderStdin(idleTimeoutSec: number): string {
  return `SET idle_in_transaction_session_timeout = '${idleTimeoutSec}s';\nBEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n${SNAP_SQL};\n${COUNTS_SQL};\nSELECT 'end|';\n`;
}

/** The counts in psql output; a `count|` line whose count is not a whole number refuses the lot. */
export function parseCountLines(text: string): { ok: true; counts: Record<string, number> } | { ok: false; error: string } {
  const counts: Record<string, number> = {};
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.startsWith('count|')) continue;
    const cut = line.lastIndexOf('|');
    const name = line.slice('count|'.length, cut);
    const n = line.slice(cut + 1);
    if (!name || !/^\d+$/.test(n) || !Number.isSafeInteger(Number(n))) return { ok: false, error: `a table count read back as ${line.slice(0, 200)}` };
    counts[name] = Number(n);
  }
  return { ok: true, counts };
}

/** Free KB from `df -Pk <dir>`: field 4 of line 2; null when it does not read that way. */
export function parseDfFreeKb(text: string): number | null {
  const line = text.trim().split('\n')[1];
  const field = line?.trim().split(/\s+/)[3];
  return field && /^\d+$/.test(field) ? Number(field) : null;
}

/** Same tables, same numbers, both ways; text is the X-MISMATCH reason when they differ. */
export function compareCounts(recorded: Record<string, number>, restored: Record<string, number>): { ok: boolean; text: string } {
  const diffs: string[] = [];
  for (const name of Object.keys(recorded).sort()) {
    if (!(name in restored)) diffs.push(`${name}: missing after the restore`);
    else if (restored[name] !== recorded[name]) diffs.push(`${name}: ${recorded[name]} recorded, ${restored[name]} restored`);
  }
  for (const name of Object.keys(restored).sort()) {
    if (!(name in recorded)) diffs.push(`${name}: not in the recorded counts`);
  }
  if (diffs.length === 0) return { ok: true, text: '' };
  const more = diffs.length > 5 ? `, and ${diffs.length - 5} more` : '';
  return { ok: false, text: `${diffs.length} table(s) differ from the counts recorded when the backup was taken: ${diffs.slice(0, 5).join('; ')}${more}` };
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/** Every reader of a counts file goes through this. */
export function validateDumpMeta(value: unknown): { ok: true; meta: DumpMeta } | { ok: false; error: string } {
  const m = value as DumpMeta | null;
  if (!m || typeof m !== 'object') return { ok: false, error: 'the counts file holds no object' };
  if (typeof m.file !== 'string' || !m.file.endsWith('.dump')) return { ok: false, error: 'the counts file names no dump' };
  if (!Number.isFinite(m.takenAt)) return { ok: false, error: 'the counts file has no time it was taken' };
  if (m.family !== 'main' && m.family !== 'copy') return { ok: false, error: 'the counts file names no family' };
  if (!['hourly', 'daily', 'safety', 'other'].includes(m.kind)) return { ok: false, error: 'the counts file names no kind' };
  if (typeof m.inRecovery !== 'boolean' || (m.dataAt !== null && !Number.isFinite(m.dataAt)) || !isCount(m.dbBytes)) {
    return { ok: false, error: 'the counts file has no database state' };
  }
  if (!m.counts || typeof m.counts !== 'object' || Array.isArray(m.counts)) return { ok: false, error: 'the counts file has no counts' };
  const values = Object.values(m.counts);
  if (!values.every(isCount)) return { ok: false, error: 'a count in the counts file is not a whole number of 0 or more' };
  if (m.tables !== values.length || m.rows !== values.reduce((a, b) => a + b, 0)) return { ok: false, error: 'the totals in the counts file do not match its counts' };
  return { ok: true, meta: m };
}

/** How much of a dump process's stderr is kept for the conflict check and the error text. */
export const STDERR_KEEP = 4000;

/** A live copy's replay cancelled a statement or ended the session. */
export function isRecoveryConflict(stderr: string): boolean {
  return /conflict with recovery/i.test(stderr.slice(0, STDERR_KEEP));
}

/** psql's first ERROR or FATAL line, which names the failure (its DETAIL, HINT and later lines do not), else the last line; '' for none. */
export function errorLine(stderr: string): string {
  const lines = stderr.split('\n').map(l => l.trim()).filter(Boolean);
  return lines.find(l => /\b(ERROR|FATAL):/.test(l)) ?? lines[lines.length - 1] ?? '';
}

/** One tick of an alert: what to keep, and whether to send the owner the DM now. */
export function alertStep(prev: FleetBackupAlert | undefined, on: boolean, kind: FleetBackupAlert['kind'], text: string, now: number): { next: FleetBackupAlert | null; send: boolean } {
  if (!on) return { next: null, send: false };
  if (!prev) return { next: { kind, text, since: now, dm: 'pending' }, send: true };
  const next = { ...prev, text };
  const send = (prev.dm === 'pending' || prev.dm === 'failed') && now - (prev.dmAt ?? 0) >= DM_RETRY_MS;
  return { next, send };
}

/** What a message's outcome reads as on the panel: T-40, T-41 or T-42; null while it waits for its first send. */
export function dmOutcomeText(alert: Pick<FleetBackupAlert, 'dm' | 'dmError'>): string | null {
  if (alert.dm === 'sent') return 'The owner was sent a Discord message.';
  if (alert.dm === 'unknown') return "Whether the owner was messaged can't be confirmed: the bot took the message but did not answer in time.";
  if (alert.dm === 'unsupported') return 'The owner could not be messaged: this app has no notify-owner hook.';
  if (alert.dm === 'failed') return `The owner could not be messaged: ${alert.dmError || 'notify-owner failed'}.`;
  return null;
}

/** A time as DMs and logs write it: YYYY-MM-DD HH:MM UTC. */
export function utcText(at: number): string {
  return `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
