/**
 * Fleet Postgres Sidecar Backup Scheduler
 *
 * Runs on a 1-minute tick. Daily pg_dump of manager-provisioned fleet Postgres
 * sidecars ONLY: an instance is in scope when it carries a fleetDb record AND
 * its stored database URL (under the capability record's key) still points at
 * that sidecar container. External databases are never dumped.
 *
 * Dumps stream to <DATA_DIR>/backups/<botId>/fleet-postgres/<ISO>.dump with a
 * keep-newest retention trim (pre-*.dump safety files are exempt). Restore
 * order: courtesy stop of the managed instances this manager can see on the
 * URL, sidecar brought back alone (it is a service of the instance's own
 * compose project, so stopping the host takes it down too), WRITE FENCE
 * (read-only + terminate sessions - the sweep cannot see a consumer whose DSN
 * lives in the bot's own store, so the fence is the actual protection),
 * safety dump under the fence, database dropped and recreated,
 * pg_restore --exit-on-error with the restoring session exempted, fence
 * lifted, stopped instances restarted.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, execFile } from 'child_process';
import * as containerManager from '../docker/containerManager';
import * as envManager from '../env/manager';
import { findAppCapabilities } from '../config/appCapabilities';
import { ensurePrivateDir, PRIVATE_FILE_MODE } from '../config/fileModes';
import { InstanceConfig, FleetBackupConfig } from '../types';
import { probeErrorTail } from '../config/secretText';
import { readStandInPosture, StandInRead } from './appLifecycle';

const TICK_INTERVAL_MS = 60 * 1000; // 1 minute
const FACTS_TIMEOUT_MS = 10_000;
const REFIRE_GUARD_MS = 23 * 60 * 60 * 1000; // prevents double-fire within the hour window
const DUMP_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const STALE_AFTER_MS = 36 * 60 * 60 * 1000;

const DATA_DIR = process.env.DATA_DIR || '/data/data';

let intervalHandle: ReturnType<typeof setInterval> | null = null;

// Last dump attempt per instance (in-memory; persisted success lives on the record)
const lastAttempts: Map<string, number> = new Map();
// Last dump error per instance (in-memory, surfaced on the bot card)
const lastErrors: Map<string, string> = new Map();
// A standby copy that has left recovery, or stands in (read-only too), is dumped under this prefix.
const COPY_PREFIX = 'standin-';
const lastCopyAttempts: Map<string, number> = new Map();
const copyErrors: Map<string, string> = new Map();
// A stuck restore write fence, tracked apart from lastErrors: a read-only
// database still DUMPS successfully, so the nightly dump's success would wipe
// a warning parked in the shared slot while the fence still stands.
// One warning per database (the primary and a drop-back's copy are fenced apart), keyed by container name.
const fenceStuck: Map<string, Map<string, { text: string; db: RestoreFleetDb }>> = new Map();
function setStuck(botId: string, db: RestoreFleetDb, text: string): void {
  const entries = fenceStuck.get(botId) ?? new Map();
  entries.set(db.containerName, { text, db });
  fenceStuck.set(botId, entries);
}
function clearStuck(botId: string, containerName: string): void {
  const entries = fenceStuck.get(botId);
  if (!entries) return;
  entries.delete(containerName);
  if (entries.size === 0) fenceStuck.delete(botId);
}
const isStuck = (botId: string, containerName: string) => fenceStuck.get(botId)?.has(containerName) === true;
// The databases whose fence a failback or drop-back run left on: the next run there owns it and retries the lift.
// Persisted on the instance (fleetConsentFenceLeft) so a manager restart keeps it. This process's word overrides
// the disk while a save is refused: one it recorded is held here, one it cleared waits here for its clear to land.
type FenceKey = { botId: string; containerName: string };
const fenceKey = (botId: string, containerName: string) => JSON.stringify([botId, containerName]);
const stuckByFailback: Set<string> = new Set();
const clearPending: Map<string, FenceKey> = new Map();

/** Save the record; false when the save was refused. */
function recordFailbackFence(botId: string, containerName: string, left: boolean): boolean {
  const key = fenceKey(botId, containerName);
  if (left) { stuckByFailback.add(key); clearPending.delete(key); }
  else { stuckByFailback.delete(key); clearPending.set(key, { botId, containerName }); }
  try {
    containerManager.updateInstanceFleetConsentFenceLeft(botId, containerName, left);
    clearPending.delete(key);
    return true;
  } catch (err) {
    console.error(`[FleetBackup] Could not save the failback fence record for ${botId} (${containerName}):`, err);
    return false;
  }
}
// Instances with a dump or restore in flight
const busy: Set<string> = new Set();

export function getFleetBackupError(botId: string): string | null {
  return lastErrors.get(botId) || null;
}

/** The last failed restore's notice; only a successful restore or a dismiss clears it. */
export function getFleetRestoreError(botId: string): string | null {
  return restoreNotice(botId)?.text || null;
}

/** False when there was no notice to dismiss. */
export function dismissFleetRestoreError(botId: string): boolean {
  if (!restoreNotice(botId)) return false;
  if (containerManager.getBot(botId)?.fleetRestoreError) containerManager.updateInstanceFleetRestoreError(botId, null);
  unsavedRestoreErrors.delete(botId);
  return true;
}

// Notices the registry could not save; read after the record.
const unsavedRestoreErrors: Map<string, { file: string; text: string }> = new Map();

function restoreNotice(botId: string): { file: string; text: string } | null {
  return containerManager.getBot(botId)?.fleetRestoreError || unsavedRestoreErrors.get(botId) || null;
}

function setRestoreError(botId: string, file: string, reason: string, consequence: string): void {
  const text = `Restore of ${file} failed: ${reason}. ${consequence}; restore a dump again before the bot relies on it`;
  try {
    containerManager.updateInstanceFleetRestoreError(botId, { file, text });
  } catch (err) {
    console.error(`[FleetBackup] Could not save the restore notice for ${botId}: ${err}`);
    unsavedRestoreErrors.set(botId, { file, text: `${text} (this notice is not saved and a manager restart drops it)` });
  }
}

/** The write fences a restore, drop-back or failback left on, one text per database; null when none. */
export function getFleetFenceStuck(botId: string): string | null {
  return Array.from(fenceStuck.get(botId)?.values() ?? [], e => e.text).join('; ') || null;
}

/**
 * Cross-module claim of the per-instance backup-op slot, so a destructive
 * lane (decommission) and this module's own dump/restore can never
 * interleave: restore and the scheduled dump refuse while it is claimed,
 * and the claimer refuses while a dump or restore is in flight.
 */
export function claimFleetBackupBusy(botId: string): boolean {
  if (busy.has(botId)) return false;
  busy.add(botId);
  return true;
}

export function releaseFleetBackupBusy(botId: string): void {
  busy.delete(botId);
}

/**
 * Effective schedule for an instance; absent config means the defaults for
 * instances that have a fleetDb record.
 */
export function effectiveFleetBackup(instance: InstanceConfig): FleetBackupConfig {
  return instance.fleetBackup || { enabled: true, hour: 4, keep: 7 };
}

/**
 * Scope guard: dump only what the manager provisioned. True when the instance
 * has a fleetDb record AND the stored database URL's hostname (under the
 * record-declared key) still equals the sidecar container name.
 */
export function isFleetBackupScoped(instance: InstanceConfig): boolean {
  if (!instance.fleetDb) return false;
  const urlKey = findAppCapabilities(instance.sourceUrl)?.companionDb?.env.url;
  if (!urlKey) return false;
  const url = (envManager.getEnvVars(instance.id)[urlKey] || '').trim();
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    // The replication posture's canonical URL points at the same sidecar
    // through the published port; it stays in dump scope.
    return host === instance.fleetDb.containerName
      || (!!instance.fleetDb.replication && host === instance.fleetDb.replication.publicHost);
  } catch {
    return false;
  }
}

/**
 * The dump guard cannot verify scope when the store is unreadable or the URL
 * key ITSELF no longer decrypts. An unrelated damaged ciphertext leaves the
 * scope fully verifiable and must not stop the safety net.
 */
function backupScopeUnverifiable(instance: InstanceConfig): { corrupt: boolean; urlUndecryptable: boolean } {
  const { corrupt, undecryptable } = envManager.getEnvVarsWithStatus(instance.id);
  const urlKey = findAppCapabilities(instance.sourceUrl)?.companionDb?.env.url;
  return { corrupt, urlUndecryptable: !!urlKey && undecryptable.includes(urlKey) };
}

/** Null when the stored URL cannot be read, so its scope was never checked. */
export function fleetBackupScopeState(instance: InstanceConfig): boolean | null {
  const { corrupt, urlUndecryptable } = backupScopeUnverifiable(instance);
  if (corrupt || urlUndecryptable) return null;
  return isFleetBackupScoped(instance);
}

/**
 * Stale when enabled + in scope and no successful dump within 36h. A never-
 * dumped instance is measured from its creation so a fresh install does not
 * warn before its first scheduled run.
 */
export function isFleetBackupStale(instance: InstanceConfig): boolean {
  if (!effectiveFleetBackup(instance).enabled) return false;
  if (!instance.fleetDb) return false;
  // A broken store cannot verify scope, and the dumps HAVE stopped - which is
  // exactly what this badge exists to surface; only a readable store that
  // genuinely reads out of scope suppresses it. Restart-proof, unlike the
  // tick's in-memory error entry.
  const { corrupt, urlUndecryptable } = backupScopeUnverifiable(instance);
  if (!corrupt && !urlUndecryptable && !isFleetBackupScoped(instance)) return false;
  const baseline = instance.lastFleetBackupAt || Date.parse(instance.createdAt) || 0;
  return Date.now() - baseline > STALE_AFTER_MS;
}

function backupDir(botId: string): string {
  return path.join(DATA_DIR, 'backups', botId, 'fleet-postgres');
}

/**
 * The highest control term this lane ever observed live, persisted so a retry
 * after a failed restore (the live database is gone by then) still knows the
 * pre-restore term. Ratchets upward only; .json so listFleetBackups' .dump
 * filter never shows it.
 */
function termFloorPath(botId: string): string {
  return path.join(backupDir(botId), 'term-floor.json');
}

function readTermFloor(botId: string): number | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(termFloorPath(botId), 'utf-8'));
    return Number.isInteger(parsed?.term) ? parsed.term : null;
  } catch {
    return null;
  }
}

function writeTermFloor(botId: string, term: number): void {
  try {
    ensurePrivateDir(backupDir(botId));
    fs.writeFileSync(termFloorPath(botId), JSON.stringify({ term }));
  } catch (err: any) {
    console.error(`[FleetBackup] Could not persist the term floor for ${botId}: ${err?.message || err}`);
  }
}

/**
 * A decommission ENDS the term space: a rebuilt database starts its terms
 * near zero, and a floor carried over from the destroyed generation would
 * advance the fresh space to the dead one's high-water mark - silently
 * defeating the witness fence the floor exists to serve.
 */
export function clearTermFloor(botId: string): void {
  try {
    fs.rmSync(termFloorPath(botId), { force: true });
  } catch (err: any) {
    console.error(`[FleetBackup] Could not clear the term floor for ${botId}: ${err?.message || err}`);
  }
}

/** running true or false as docker says it; null with docker's error when docker could not be asked. */
type ContainerState = { running: boolean; error?: undefined } | { running: null; error: string };
function containerState(containerName: string): Promise<ContainerState> {
  return new Promise(resolve => {
    execFile('docker', ['inspect', '-f', '{{.State.Running}}', containerName], (err, stdout, stderr) => {
      if (!err) return resolve({ running: String(stdout).trim() === 'true' });
      const text = String(stderr || err || '');
      resolve(/no such object|no such container/i.test(text) ? { running: false } : { running: null, error: probeErrorTail(text) });
    });
  });
}

async function isContainerRunning(containerName: string): Promise<boolean> {
  return (await containerState(containerName)).running === true;
}

/** The refusal for a database that is not up: docker's own "not running", or why it could not be asked. */
function dbDownText(state: ContainerState, stopped: string): string {
  return state.running === null ? `Could not probe the database container (${state.error})` : stopped;
}

function execDocker(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile('docker', args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// stopBot/startBot THROW on an op-lock conflict; inside the restore lane a
// throw would skip the restart obligations and turn a finished restore into
// a 500, so any rejection from these container ops becomes an ordinary
// failure here.
function asResult(op: Promise<{ success: boolean; error?: string }>): Promise<{ success: boolean; error?: string }> {
  return op.catch(err => ({ success: false, error: String((err as Error)?.message || err) }));
}

type RestoreFleetDb = { containerName: string; user: string; db: string; volume: string };

/**
 * Lift the restore write fence. ALTER SYSTEM persists in the volume's
 * auto.conf, so when the live lift fails the file is stripped instead (the
 * recovery channel's fallback): the LIVE state then stays read-only until the
 * container restarts, which is why 'stripped' is not 'lifted'.
 */
async function liftRestoreFence(fleetDb: RestoreFleetDb): Promise<'lifted' | 'stripped' | 'failed'> {
  // The maintenance db, not the target db: the fence is cluster-level, and
  // the lift must work while the target db is dropped mid-restore.
  const unfence = await execDocker(['exec', fleetDb.containerName, 'psql', '-U', fleetDb.user, '-d', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1',
    '-c', 'SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE',
    '-c', 'ALTER SYSTEM RESET default_transaction_read_only',
    '-c', 'SELECT pg_reload_conf()']);
  if (unfence.ok) return 'lifted';
  const strip = await execDocker(['run', '--rm', '-v', `${fleetDb.volume}:/pgdata`, '--entrypoint', 'sh', 'postgres:16-alpine',
    '-c', "sed -i '/^default_transaction_read_only/d' /pgdata/postgresql.auto.conf"]);
  return strip.ok ? 'stripped' : 'failed';
}

/** Lift and keep the per-bot stuck-fence warning truthful. A restart only
 * clears a STRIPPED fence; a 'failed' one survives in auto.conf and would be
 * re-applied by the restart, so its remedy is a retried lift instead. */
async function liftAndTrack(botId: string, fleetDb: RestoreFleetDb, lane = 'a restore', failedRemedy = 'running the restore again retries the lift'): Promise<'lifted' | 'stripped' | 'failed'> {
  const failback = lane === 'a failback';
  const result = await liftRestoreFence(fleetDb);
  if (result === 'lifted') {
    clearStuck(botId, fleetDb.containerName);
    recordFailbackFence(botId, fleetDb.containerName, false);
    return result;
  }
  // A run stopped mid-lift is covered by its own run record (fence.owned), so this is saved only once the lift did not land.
  const unsaved = !recordFailbackFence(botId, fleetDb.containerName, failback) && failback;
  const unsavedNote = unsaved ? '; this manager could not save that the failback owns this fence, so after a manager restart the next run there leaves it on' : '';
  setStuck(botId, fleetDb, (result === 'stripped'
    ? `The database is READ-ONLY (${lane} write fence could not be lifted live); restart the instance to clear it`
    : `The database is READ-ONLY (${lane} write fence could not be lifted or stripped); ${failedRemedy}`) + unsavedNote);
  return result;
}

/**
 * The write fence the restore and the recovery quiesce use: writes off
 * cluster-wide and every other session ended, so a consumer the caller cannot
 * see cannot write under it. ON_ERROR_STOP so a failed ALTER SYSTEM under a
 * succeeding terminate cannot read as a fence.
 */
function applyWriteFence(fleetDb: RestoreFleetDb): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return execDocker(['exec', fleetDb.containerName, 'psql', '-U', fleetDb.user, '-d', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1',
      '-c', 'SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE',
      '-c', 'ALTER SYSTEM SET default_transaction_read_only = on',
      '-c', 'SELECT pg_reload_conf()',
      '-c', "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND backend_type = 'client backend'"]);
}

/** The database a failback or drop-back run parks on for the operator's consent. */
export type ConsentFenceTarget = RestoreFleetDb;

/**
 * Fence the database a failback or drop-back run parks on for consent
 * (B7-O19): a client bypassing the bot cannot land rows the dump and the
 * verdict never saw, which the wipe would then destroy.
 */
export async function fenceForConsent(target: ConsentFenceTarget): Promise<{ ok: true } | { ok: false; error: string }> {
  const fence = await applyWriteFence(target);
  return fence.ok ? { ok: true } : { ok: false, error: fence.stderr.trim().split('\n').pop() || 'unknown reason' };
}

/** Lift a consent fence; one that sticks is named on the instance, on the database it sits on, as the restore's is. */
export function liftConsentFence(botId: string, target: ConsentFenceTarget, failedRemedy: string): Promise<'lifted' | 'stripped' | 'failed'> {
  return liftAndTrack(botId, target, 'a failback', failedRemedy);
}

function liftNote(result: 'lifted' | 'stripped' | 'failed', remedy = 'running a restore again retries the lift'): string {
  return result === 'lifted' ? ''
    : result === 'stripped' ? '; the write fence could not be lifted live, so the database is READ-ONLY until its container restarts'
    : `; the write fence could not be lifted, so the database stays READ-ONLY (${remedy})`;
}

/**
 * The safety dump a lane that destroys the database takes first (the B7-O19 order): the write fence, then the dump
 * under it, so the dump holds every write the destroy removes. A failed fence or dump lifts the fence and refuses.
 * The caller has stopped the writers it can see and brought the database up alone.
 */
export async function fencedSafetyDump(instance: InstanceConfig, prefix: string, lane: string, remedy: string): Promise<{ success: true; file: string } | { success: false; error: string }> {
  const fleetDb = instance.fleetDb;
  if (!fleetDb) return { success: false, error: 'No fleet database record' };
  const fence = await applyWriteFence(fleetDb);
  foreignFenceSet(instance.id, fleetDb.containerName);
  if (!fence.ok) {
    const lifted = await liftAndTrack(instance.id, fleetDb, lane, remedy);
    return { success: false, error: `the write fence could not be applied (${fence.stderr.trim().split('\n').pop() || 'unknown reason'}), so no dump was taken${liftNote(lifted, remedy)}` };
  }
  const dump = await runFleetDump(instance, prefix);
  if (dump.success && dump.file) return { success: true, file: dump.file };
  const lifted = await liftAndTrack(instance.id, fleetDb, lane, remedy);
  return { success: false, error: `${dump.error || 'unknown reason'}${liftNote(lifted, remedy)}` };
}

/** Lift a lane's fence from a database its destroy left standing; the text names a fence left on. */
export async function liftLaneFence(botId: string, fleetDb: RestoreFleetDb, lane: string, remedy: string): Promise<string> {
  return liftNote(await liftAndTrack(botId, fleetDb, lane, remedy), remedy);
}

/** Whether a failback or drop-back run on this instance left its fence on this database (the persisted record, or this process's when its save was refused). */
export function failbackFenceLeft(botId: string, containerName: string): boolean {
  const key = fenceKey(botId, containerName);
  if (stuckByFailback.has(key)) return true;
  if (clearPending.has(key)) return false;
  return (containerManager.getBot(botId)?.fleetConsentFenceLeft ?? []).includes(containerName);
}

/**
 * Another lane set its write fence on this database. The fence is one setting, so a failback's stuck one under it
 * is now that lane's to lift: the record goes, and a refused save is held here until its clear lands.
 */
export function foreignFenceSet(botId: string, containerName: string): void {
  if (failbackFenceLeft(botId, containerName)) recordFailbackFence(botId, containerName, false);
}

/** Whether the database holds the write fence now; null when it cannot be asked. */
export async function writeFenced(target: ConsentFenceTarget): Promise<boolean | null> {
  const probe = await execDocker(['exec', target.containerName, 'psql', '-U', target.user, '-d', 'postgres', '-tA', '-c', 'SHOW default_transaction_read_only']);
  return probe.ok ? probe.stdout.trim() === 'on' : null;
}

/**
 * Seed the stuck-fence warnings from OBSERVED live state at scheduler start,
 * so a manager restart does not silently forget a database a failed lift left
 * read-only. One probe per fleet-database host, once.
 */
async function seedStuckFences(): Promise<void> {
  for (const instance of containerManager.getAllBots()) {
    // A failback record whose database is gone or reads unfenced is stale, and must not claim a later lane's fence.
    for (const containerName of instance.fleetConsentFenceLeft ?? []) await checkFailbackRecord(instance.id, containerName);
    // A parked failback's fence is the run's own, named by its consent; it sits on the run's database only.
    const parked = instance.fleetFailback?.fence?.ok === true ? instance.fleetFailback.mode : null;
    // A copy carries no fence of its own (its seed strips the setting), so one
    // reading 'on' is a drop-back's that was never lifted.
    const copy = instance.fleetDbReplica;
    if (parked !== 'drop-back' && copy?.user && !isStuck(instance.id, copy.containerName) && await isContainerRunning(copy.containerName)) {
      const onCopy = await execDocker(['exec', copy.containerName, 'psql', '-U', copy.user, '-d', 'postgres', '-tA', '-c', 'SHOW default_transaction_read_only']);
      if (onCopy.ok && onCopy.stdout.trim() === 'on') {
        setStuck(instance.id, { containerName: copy.containerName, user: copy.user, db: copy.db ?? 'postgres', volume: copy.volume },
          'The copy is READ-ONLY: a write fence (a drop-back\'s, a promote\'s or a swap\'s) is on; re-seeding this copy on its Database modal clears it');
      }
    }
    const db = instance.fleetDb;
    if (parked === 'failback' || !db || isStuck(instance.id, db.containerName)) continue;
    if (!await isContainerRunning(db.containerName)) continue;
    const probe = await execDocker(['exec', db.containerName, 'psql', '-U', db.user, '-d', 'postgres', '-tA', '-c', 'SHOW default_transaction_read_only']);
    if (probe.ok && probe.stdout.trim() === 'on') {
      setStuck(instance.id, db, 'The database is READ-ONLY (a write fence was not lifted); restart the instance to clear it, or run a restore again to retry the lift');
    }
  }
}

/** Clear a failback record whose database is gone or reads unfenced; one that cannot be asked is kept for the next check. */
async function checkFailbackRecord(botId: string, containerName: string): Promise<void> {
  const instance = containerManager.getBot(botId);
  const db = instance ? [instance.fleetDb, instance.fleetDbReplica].find(d => d?.containerName === containerName) : undefined;
  if (!db?.user) { recordFailbackFence(botId, containerName, false); return; }
  const probe = await isContainerRunning(containerName)
    ? await execDocker(['exec', containerName, 'psql', '-U', db.user, '-d', 'postgres', '-tA', '-c', 'SHOW default_transaction_read_only'])
    : null;
  if (probe?.ok && probe.stdout.trim() === 'off') recordFailbackFence(botId, containerName, false);
}

/**
 * Self-heal the stuck-fence warning: once the operator restarts the container
 * (the stripped auto.conf comes up clean) the live state is writable again and
 * the warning must go. Cheap - runs only while an entry exists.
 */
async function reprobeStuckFences(): Promise<void> {
  for (const { botId, containerName } of Array.from(clearPending.values())) recordFailbackFence(botId, containerName, false);
  // Every record, not only the database the instance's one warning names: a stale one must not claim a later lane's fence.
  const records = new Set(stuckByFailback);
  for (const instance of containerManager.getAllBots()) {
    for (const containerName of instance.fleetConsentFenceLeft ?? []) {
      const key = fenceKey(instance.id, containerName);
      if (!clearPending.has(key)) records.add(key);
    }
  }
  for (const key of records) {
    const [botId, containerName] = JSON.parse(key) as [string, string];
    await checkFailbackRecord(botId, containerName);
  }
  for (const [id, entries] of Array.from(fenceStuck.entries())) {
    const instance = containerManager.getBot(id);
    if (!instance) { fenceStuck.delete(id); continue; }
    for (const { db } of Array.from(entries.values())) {
      // A database the instance no longer records is gone, and its warning with it.
      if (instance.fleetDb?.containerName !== db.containerName && instance.fleetDbReplica?.containerName !== db.containerName) { clearStuck(id, db.containerName); continue; }
      if (!await isContainerRunning(db.containerName)) continue;
      const probe = await execDocker(['exec', db.containerName, 'psql', '-U', db.user, '-d', 'postgres', '-tA', '-c', 'SHOW default_transaction_read_only']);
      if (probe.ok && probe.stdout.trim() === 'off') { clearStuck(id, db.containerName); recordFailbackFence(id, db.containerName, false); }
    }
  }
}

/**
 * List dump files for an instance, newest first.
 */
export function listFleetBackups(botId: string): Array<{ file: string; size: number; mtime: number }> {
  const dir = backupDir(botId);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return [];
    throw new Error(`The backup folder for ${botId} could not be read: ${err?.message || err}`);
  }
  const out: Array<{ file: string; size: number; mtime: number }> = [];
  for (const name of names) {
    if (!name.endsWith('.dump')) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      out.push({ file: name, size: st.size, mtime: st.mtimeMs });
    } catch { /* raced deletion */ }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export function isValidFleetBackupKeep(keep: unknown): keep is number {
  return typeof keep === 'number' && Number.isInteger(keep) && keep >= 1 && keep <= 365;
}

/**
 * Keep the newest `keep` dumps; every pre-*.dump safety file is exempt
 * (pre-restore-, pre-reseed-, pre-rescue-, pre-decommission-): each one is
 * some destructive lane's recovery copy and must never age out under it.
 * So is the dump a failed restore targeted, while its notice stands, and the
 * dump just written. When any dump is dated in the future (a clock step
 * back), every dump is kept. The keep
 * is the larger of the tick's and the one stored now, so a Keep raised during
 * the dump holds. The primary's dumps and the copy's standin- dumps are
 * trimmed apart, each to the newest `keep` of its own.
 */
function trimFleetBackups(botId: string, tickKeep: number, justWritten: string, family: '' | typeof COPY_PREFIX = ''): void {
  const dir = backupDir(botId);
  let trimmable: Array<{ file: string }>;
  let keep: number;
  try {
    const stored = containerManager.getBot(botId);
    const storedKeep = stored ? effectiveFleetBackup(stored).keep : undefined;
    if (!isValidFleetBackupKeep(tickKeep) || !isValidFleetBackupKeep(storedKeep)) {
      console.warn(`[FleetBackup] Kept every dump for ${botId}: Keep (${tickKeep} at the tick, ${storedKeep} stored now) is not a whole number from 1 to 365`);
      return;
    }
    keep = Math.max(tickKeep, storedKeep);
    if (storedKeep !== tickKeep) console.log(`[FleetBackup] Keep for ${botId} changed during the dump (${tickKeep} to ${storedKeep}); kept the newest ${keep}`);
    const target = restoreNotice(botId)?.file;
    const all = listFleetBackups(botId);
    if (all.some(f => f.mtime > Date.now() + 5 * 60000)) {
      console.warn(`[FleetBackup] Kept every dump for ${botId}: a dump is dated in the future, so the clock may have stepped back`);
      return;
    }
    trimmable = all.filter(f => !f.file.startsWith('pre-') && f.file.startsWith(COPY_PREFIX) === (family === COPY_PREFIX)
      && f.file !== target && f.file !== justWritten);
  } catch (err) {
    console.warn(`[FleetBackup] Kept every dump for ${botId}: ${err}`);
    return;
  }
  for (const f of trimmable.slice(keep - 1)) {
    try {
      fs.unlinkSync(path.join(dir, f.file));
    } catch (err) {
      console.warn(`[FleetBackup] Failed to trim ${f.file} for ${botId}:`, err);
    }
  }
}

// A file opens 'r+': Windows refuses to flush a handle opened read-only.
function syncPath(target: string, flags: 'r' | 'r+'): void {
  const fd = fs.openSync(target, flags);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * One pg_dump of the instance's sidecar, streamed to a .tmp, synced to disk, then renamed.
 * `prefix` names safety dumps (pre-restore-). Skips when the container is not
 * running (scheduler) / fails hard for callers that need the dump.
 */
export async function runFleetDump(
  instance: InstanceConfig,
  prefix = ''
): Promise<{ success: boolean; file?: string; error?: string }> {
  const fleetDb = instance.fleetDb;
  if (!fleetDb) return { success: false, error: 'No fleet database record' };
  return dumpDatabase(instance.id, fleetDb, prefix);
}

async function dumpDatabase(
  botId: string,
  fleetDb: { containerName: string; user: string; db: string },
  prefix: string
): Promise<{ success: boolean; file?: string; error?: string }> {
  const dbState = await containerState(fleetDb.containerName);
  if (dbState.running !== true) {
    return { success: false, error: dbDownText(dbState, 'Database container is not running') };
  }

  const dir = backupDir(botId);
  ensurePrivateDir(dir);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `${prefix}${stamp}.dump`;
  const finalPath = path.join(dir, fileName);
  const tmpPath = `${finalPath}.tmp`;

  return new Promise(resolve => {
    const child = spawn('docker', ['exec', fleetDb.containerName, 'pg_dump', '-U', fleetDb.user, '-Fc', fleetDb.db]);
    const out = fs.createWriteStream(tmpPath, { mode: PRIVATE_FILE_MODE });
    let stderr = '';
    let killed = false;
    let settled = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, DUMP_TIMEOUT_MS);

    const fail = (error: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      out.destroy();
      try { fs.unlinkSync(tmpPath); } catch { /* already gone */ }
      resolve({ success: false, error });
    };

    child.stdout.pipe(out);
    child.stderr.on('data', d => { if (stderr.length < 4000) stderr += d.toString(); });
    child.on('error', err => fail(`Failed to run docker exec: ${err.message}`));
    out.on('error', err => {
      child.kill('SIGKILL');
      fail(`Failed to write dump file: ${err.message}`);
    });

    child.on('close', code => {
      if (settled) return;
      if (killed) return fail(`Dump timed out after ${DUMP_TIMEOUT_MS / 60000} minutes`);
      if (code !== 0) return fail(`pg_dump exited with code ${code}: ${stderr.trim().slice(0, 500)}`);
      out.end(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          syncPath(tmpPath, 'r+');
          fs.renameSync(tmpPath, finalPath);
        } catch (err) {
          try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
          resolve({ success: false, error: `Failed to finalize dump file: ${err}` });
          return;
        }
        try {
          syncPath(dir, 'r');
        } catch (err) {
          // Windows cannot open a folder to sync it; NTFS journals the rename itself.
          if (process.platform !== 'win32') {
            resolve({ success: false, error: `The dump ${fileName} was written, but its folder could not be synced to disk, so a crash could still lose it: ${err}` });
            return;
          }
        }
        resolve({ success: true, file: fileName });
      });
    });
  });
}

async function runScheduledDump(instance: InstanceConfig): Promise<void> {
  busy.add(instance.id);
  try {
    const result = await runFleetDump(instance);
    if (result.success) {
      lastErrors.delete(instance.id);
      containerManager.setLastFleetBackupAt(instance.id, Date.now());
      trimFleetBackups(instance.id, effectiveFleetBackup(instance).keep, result.file!);
      console.log(`[FleetBackup] Dumped ${instance.displayName} (${instance.id}) -> ${result.file}`);
    } else {
      lastErrors.set(instance.id, result.error || 'unknown error');
      console.error(`[FleetBackup] Dump failed for ${instance.displayName} (${instance.id}): ${result.error}`);
    }
  } finally {
    busy.delete(instance.id);
  }
}

/** When the newest standin- dump was written; null when there is none. Throws when the folder cannot be read. */
function lastCopyDump(botId: string): { file: string; mtime: number } | null {
  return listFleetBackups(botId).find(f => f.file.startsWith(COPY_PREFIX)) ?? null;
}

/** The copy's scheduled-dump state for its banner; null for an instance without a standby copy. */
export function copyBackupInfo(instance: InstanceConfig): {
  enabled: boolean; hour: number; keep: number; lastAt: number | null; lastFile: string | null; stale: boolean; lastError: string | null; listError: string | null;
} | null {
  if (!instance.fleetDbReplica) return null;
  const config = effectiveFleetBackup(instance);
  let last: { file: string; mtime: number } | null = null;
  let listError: string | null = null;
  try {
    last = lastCopyDump(instance.id);
  } catch (err: any) {
    listError = `${err?.message || err}, so the last dump of this copy cannot be named`;
  }
  return {
    enabled: config.enabled,
    hour: config.hour,
    keep: config.keep,
    lastAt: last ? last.mtime : null,
    lastFile: last ? last.file : null,
    stale: !!last && Date.now() - last.mtime > STALE_AFTER_MS,
    lastError: copyErrors.get(instance.id) ?? null,
    listError,
  };
}

/** true when the copy takes writes (out of recovery), false while it follows a primary; an error when it cannot be read. */
async function copyTakesWrites(rec: { containerName: string; user: string; db: string }): Promise<{ writes: boolean } | { error: string }> {
  const probe = await execDocker(['exec', rec.containerName, 'psql', '-U', rec.user, '-d', rec.db, '-Atc', 'SELECT pg_is_in_recovery()']);
  const answer = probe.stdout.trim();
  if (probe.ok && (answer === 't' || answer === 'f')) return { writes: answer === 'f' };
  return { error: probe.ok ? 'unexpected answer from the copy' : probeErrorTail(probe.stderr) || 'no answer from the copy' };
}

/**
 * A copy still in recovery is dumped while it stands in live (its primary is gone, so it may be the only copy left)
 * and while the app does not answer, since a stand-in cannot then be ruled out.
 */
function copyMayBeAlone(read: StandInRead): boolean {
  if (read.read === 'unanswered') return true;
  return read.read === 'ok' && read.posture?.role === 'stand-in' && read.posture.live === true;
}

async function runScheduledCopyDump(instance: InstanceConfig): Promise<void> {
  const rec = instance.fleetDbReplica;
  if (!rec || rec.copyCleared) return;
  if (instance.fleetDbReplicaSeed && !instance.fleetDbReplicaSeed.parked) return;
  let last = 0;
  try { last = lastCopyDump(instance.id)?.mtime ?? 0; } catch { /* an unreadable folder fails the dump below, which reports it */ }
  if (Date.now() - Math.max(lastCopyAttempts.get(instance.id) || 0, last) < REFIRE_GUARD_MS) return;
  lastCopyAttempts.set(instance.id, Date.now());
  if (!rec.user || !rec.db) {
    copyErrors.set(instance.id, 'the standby record has no database identity, so whether this copy takes writes could not be read and no scheduled dump of it ran');
    return;
  }
  const target = { containerName: rec.containerName, user: rec.user, db: rec.db };
  busy.add(instance.id);
  try {
    const role = await copyTakesWrites(target);
    if ('error' in role) {
      copyErrors.set(instance.id, `could not read whether this copy takes writes (${role.error}), so no scheduled dump of it ran`);
      console.error(`[FleetBackup] Could not read the role of the copy for ${instance.displayName} (${instance.id}): ${role.error}`);
      return;
    }
    if (!role.writes && !copyMayBeAlone(await readStandInPosture(instance, FACTS_TIMEOUT_MS))) {
      copyErrors.delete(instance.id);
      lastCopyAttempts.delete(instance.id);
      return;
    }
    const result = await dumpDatabase(instance.id, target, COPY_PREFIX);
    if (result.success) {
      copyErrors.delete(instance.id);
      trimFleetBackups(instance.id, effectiveFleetBackup(instance).keep, result.file!, COPY_PREFIX);
      console.log(`[FleetBackup] Dumped the copy of ${instance.displayName} (${instance.id}) -> ${result.file}`);
    } else {
      copyErrors.set(instance.id, result.error || 'unknown error');
      console.error(`[FleetBackup] Dump of the copy failed for ${instance.displayName} (${instance.id}): ${result.error}`);
    }
  } finally {
    busy.delete(instance.id);
  }
}

async function runFleetBackupTick(): Promise<void> {
  const fault = containerManager.registryFault();
  if (fault) { console.warn(`[FleetBackup] Tick skipped: ${fault}`); return; }
  await reprobeStuckFences();
  const currentHour = new Date().getHours();
  for (const instance of containerManager.getAllBots()) {
    const config = effectiveFleetBackup(instance);
    if (!config.enabled || currentHour !== config.hour) continue;
    if (instance.fleetDb && !busy.has(instance.id)) await runScheduledPrimaryDump(instance);
    if (instance.fleetDbReplica && !busy.has(instance.id)) {
      const fresh = containerManager.getBot(instance.id);
      if (fresh) await runScheduledCopyDump(fresh);
    }
  }
}

async function runScheduledPrimaryDump(instance: InstanceConfig): Promise<void> {
  // A broken store would silently unscope the dump guard and stop the
  // nightly safety net with no surfaced signal; record the stoppage loudly.
  const scopeCheck = backupScopeUnverifiable(instance);
  if (scopeCheck.corrupt || scopeCheck.urlUndecryptable) {
    lastErrors.set(instance.id, scopeCheck.corrupt
      ? 'the env store cannot be read (a copy is kept beside it as storage.json.corrupt-<time> when it could be read), so the scheduled dump cannot verify its scope'
      : 'the stored database URL no longer decrypts (the encryption key changed?), so the scheduled dump cannot verify its scope');
    console.error(`[FleetBackup] Skipping the scheduled dump for ${instance.displayName} (${instance.id}): env store unreadable or the database URL undecryptable`);
    return;
  }
  if (!isFleetBackupScoped(instance)) return;

  const last = Math.max(lastAttempts.get(instance.id) || 0, instance.lastFleetBackupAt || 0);
  if (Date.now() - last < REFIRE_GUARD_MS) return;

  lastAttempts.set(instance.id, Date.now());
  await runScheduledDump(instance);
}

/**
 * Restore a dump into the instance's sidecar. In order: courtesy stop of the
 * managed instances this manager can see on the URL, sidecar brought back
 * alone, write fence, pre-restore safety dump under the fence (refusing the
 * restore if it fails), drop and recreate of the database (pg_restore --clean cannot
 * restore this schema: the partition PK drops it emits are refused as
 * inherited constraints and the run exits 1 even when everything applied; a
 * fresh database makes any restore error a real failure), pg_restore
 * --exit-on-error of the chosen file with the restoring session exempted,
 * fence lifted, stopped instances restarted.
 */
export async function restoreFleetBackup(
  botId: string,
  file: string
): Promise<{ success: boolean; error?: string; warning?: string; steps: { stopped: string[]; preRestoreDump: string | null; restored: boolean; termReconciledTo: number | null; restarted: string[] } }> {
  const steps: { stopped: string[]; preRestoreDump: string | null; restored: boolean; termReconciledTo: number | null; restarted: string[] } = {
    stopped: [], preRestoreDump: null, restored: false, termReconciledTo: null, restarted: [],
  };

  if (file.includes('/') || file.includes('\\') || file.includes('..') || !file.endsWith('.dump')) {
    return { success: false, error: 'Invalid dump file name', steps };
  }

  const instance = containerManager.getBot(botId);
  const fleetDb = instance?.fleetDb;
  if (!instance || !fleetDb) return { success: false, error: 'No fleet database record', steps };

  const dumpPath = path.join(backupDir(botId), file);
  if (!fs.existsSync(dumpPath)) return { success: false, error: 'Dump file not found', steps };

  // Name the real problem when the store is broken: 'no stored database URL'
  // would steer the operator toward re-provisioning instead of the repair.
  const store = envManager.getEnvVarsWithStatus(botId);
  if (store.corrupt) {
    return { success: false, error: 'The env store for this instance cannot be read (a copy is kept beside it as storage.json.corrupt-<time> when it could be read); restore it before restoring a dump', steps };
  }
  const urlKey = findAppCapabilities(instance.sourceUrl)?.companionDb?.env.url;
  if (urlKey && store.undecryptable.includes(urlKey)) {
    return { success: false, error: 'The stored database URL no longer decrypts (the encryption key changed?); re-enter it or restore the key before restoring a dump', steps };
  }
  const url = urlKey ? (store.vars[urlKey] || '').trim() : '';
  if (!url) return { success: false, error: 'Instance has no stored database URL', steps };

  if (busy.has(botId)) return { success: false, error: 'A backup operation is already in progress', steps };
  busy.add(botId);
  let fenced = false;
  try {
    // 0. A restore must work on a DOWN fleet - that is exactly when it is
    // needed, and starting the whole instance first would boot the bot
    // against the bad data. Bring the database up alone when it is not up.
    if (!await isContainerRunning(fleetDb.containerName)) {
      const started = await asResult(containerManager.startFleetDbSidecar(botId));
      if (!started.success) {
        return { success: false, error: `Could not start the database for the restore: ${started.error}`, steps };
      }
    }

    // 1. Courtesy stop of every running managed instance this manager can see
    // on this exact URL. It cannot see them all (a worker's DSN lives in the
    // bot's own env file, and other machines' instances are out of reach
    // entirely), which is why the fence below is the actual protection. The
    // key is resolved PER CANDIDATE: another app spells its DSN differently.
    const sharing = containerManager.getAllBots().filter(b => {
      const key = findAppCapabilities(b.sourceUrl)?.companionDb?.env.url;
      return !!key && (envManager.getEnvVars(b.id)[key] || '').trim() === url;
    });
    for (const b of sharing) {
      if (b.status !== 'running') continue;
      const stop = await asResult(containerManager.stopBot(b.id));
      if (!stop.success) {
        // Nothing was restored yet: bring back what we already stopped and refuse.
        for (const id of steps.stopped) {
          const start = await asResult(containerManager.startBot(id));
          if (start.success) steps.restarted.push(id);
        }
        return { success: false, error: `Could not stop instance ${b.displayName}: ${stop.error}`, steps };
      }
      steps.stopped.push(b.id);
    }

    // 2. Stopping the host took its sidecar down with the compose project;
    // bring the database back alone.
    if (!await isContainerRunning(fleetDb.containerName)) {
      const started = await asResult(containerManager.startFleetDbSidecar(botId));
      if (!started.success) {
        for (const id of steps.stopped) {
          const start = await asResult(containerManager.startBot(id));
          if (start.success) steps.restarted.push(id);
        }
        return { success: false, error: `Could not start the database for the restore: ${started.error}`, steps };
      }
    }

    // 3. Write fence, the same one the recovery quiesce uses: writes off
    // cluster-wide and every other session terminated, so a consumer the
    // sweep could not see cannot write under the restore.
    // ON_ERROR_STOP so a failed ALTER SYSTEM under a succeeding terminate
    // cannot read as a successful fence. fenced is set BEFORE the attempt so
    // a throw mid-fence still reaches the finally lift.
    fenced = true;
    const fence = await applyWriteFence(fleetDb);
    foreignFenceSet(botId, fleetDb.containerName);
    if (!fence.ok) {
      // A half-applied fence must not survive the refusal. Only a LIVE lift
      // clears it; 'stripped' cleans the persisted copy alone, so the finally
      // must keep retrying and the operator must hear about the read-only risk.
      const cleared = await liftAndTrack(botId, fleetDb);
      if (cleared === 'lifted') fenced = false;
      for (const id of steps.stopped) {
        const start = await asResult(containerManager.startBot(id));
        if (start.success) steps.restarted.push(id);
      }
      const fenceWarning = cleared === 'lifted' ? '' : '; the database may be READ-ONLY until its container restarts';
      return { success: false, error: `Could not fence the database for the restore: ${fence.stderr.trim().split('\n').pop()}${fenceWarning}`, steps };
    }

    // A refusal past the fence lifts it and brings back what was stopped; only then has it changed nothing.
    const refuse = async (refused: string, detail: string) => {
      const cleared = await liftAndTrack(botId, fleetDb);
      fenced = cleared !== 'lifted';
      const unstarted: string[] = [];
      for (const id of steps.stopped) {
        const start = await asResult(containerManager.startBot(id));
        if (start.success) steps.restarted.push(id);
        else unstarted.push(containerManager.getBot(id)?.displayName || id);
      }
      const stoppedNote = unstarted.length > 0
        ? `; these instances were stopped and could not be restarted: ${unstarted.join(', ')} (start them by hand)`
        : '';
      return { success: false, error: `${refused}${unstarted.length > 0 ? '' : ', and nothing was changed'}: ${detail}${liftNote(cleared)}${stoppedNote}`, steps };
    };

    // 4. Pre-restore safety dump UNDER the fence, so it holds every write the
    // drop below removes. A MISSING database (a prior recreate failure) has
    // no data to protect and dumping it would refuse every retry, so
    // existence is probed first; an unanswerable probe still refuses.
    const exists = await execDocker(['exec', fleetDb.containerName, 'psql', '-U', fleetDb.user, '-d', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1',
      '-c', `SELECT count(*) FROM pg_database WHERE datname = '${fleetDb.db.replace(/'/g, "''")}'`]);
    if (!exists.ok) {
      return await refuse('Could not check the database before the restore, so the restore was refused', exists.stderr.trim().split('\n').pop() || 'unknown reason');
    }
    // The app's control term must never move backwards: the witness fence
    // parks a master whose store term sits below a claim any node ever
    // posted, and only this lane knows the rewind is a deliberate restore
    // rather than a stale fork (F-R5-1). Capture the live term, keep the
    // highest value ever seen in the persisted floor (a retry after a failed
    // restore probes a partial or missing database), and advance the restored
    // copy to it after pg_restore. Tolerant on purpose: a database without
    // the table simply skips the reconcile.
    let liveTerm: number | null = readTermFloor(botId);
    if (exists.stdout.trim() !== '0') {
      const safety = await runFleetDump(instance, 'pre-restore-');
      if (!safety.success) {
        lastErrors.set(botId, `Pre-restore dump failed: ${safety.error}`);
        return await refuse('Pre-restore dump failed, restore refused', safety.error || 'unknown reason');
      }
      steps.preRestoreDump = safety.file || null;

      const termProbe = await execDocker(['exec', fleetDb.containerName, 'psql', '-U', fleetDb.user, '-d', fleetDb.db, '-tA',
        '-c', 'SELECT max(term) FROM smdb_control.term']);
      const parsed = Number.parseInt(termProbe.stdout.trim(), 10);
      if (termProbe.ok && Number.isInteger(parsed) && (liveTerm === null || parsed > liveTerm)) {
        liveTerm = parsed;
        writeTermFloor(botId, parsed);
      }
    }

    // 5. Drop and recreate the database under the fence. pg_restore --clean
    // cannot restore this schema (the partition PK drops it emits are refused
    // as inherited constraints and the run exits 1 even when everything
    // applied), and a fresh database makes any restore error a real failure.
    // WITH (FORCE) also kills sessions the terminate sweep raced against.
    // Physical walsenders are not connected to any database, so a streaming
    // standby just replays the swap.
    const dbIdent = `"${fleetDb.db.replace(/"/g, '""')}"`;
    const recreate = await execDocker(['exec', '-e', 'PGOPTIONS=-c default_transaction_read_only=off', fleetDb.containerName,
      'psql', '-U', fleetDb.user, '-d', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1',
      '-c', `DROP DATABASE IF EXISTS ${dbIdent} WITH (FORCE)`,
      '-c', `CREATE DATABASE ${dbIdent} OWNER "${fleetDb.user.replace(/"/g, '""')}"`]);
    if (!recreate.ok) {
      setRestoreError(botId, file, `could not recreate the database: ${recreate.stderr.trim().split('\n').pop()}`, 'The database may be missing, or unchanged if the drop itself failed');
      const cleared = await liftAndTrack(botId, fleetDb);
      fenced = cleared !== 'lifted';
      for (const id of steps.stopped) {
        const start = await asResult(containerManager.startBot(id));
        if (start.success) steps.restarted.push(id);
      }
      const clearWarning = cleared === 'lifted' ? '' : '; additionally the write fence could not be lifted live, so the cluster is READ-ONLY until its container restarts';
      return { success: false, error: `Could not recreate the database for the restore: ${recreate.stderr.trim().split('\n').pop()}${clearWarning}`, steps };
    }

    // 6. pg_restore with the dump streamed to stdin. PGOPTIONS exempts this
    // one session from the fence; everyone else stays read-only. The
    // IN-CONTAINER timeout is load-bearing: killing the docker exec CLIENT
    // leaves the server-side pg_restore alive and fence-exempt, still writing
    // into the database after the lift below - the timeout kills the actual
    // process, and the Node timer is only the backstop behind it.
    const inContainerTimeoutSec = Math.floor(DUMP_TIMEOUT_MS / 1000);
    const restoreStartedAt = Date.now();
    const restore = await new Promise<{ success: boolean; error?: string }>(resolve => {
      const child = spawn('docker', ['exec', '-e', 'PGOPTIONS=-c default_transaction_read_only=off', '-i', fleetDb.containerName,
        'timeout', '-s', 'KILL', String(inContainerTimeoutSec),
        'pg_restore', '-U', fleetDb.user, '--exit-on-error', '-d', fleetDb.db]);
      const input = fs.createReadStream(dumpPath);
      let stderr = '';
      let killed = false;
      let settled = false;

      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, DUMP_TIMEOUT_MS + 30_000);

      const finish = (result: { success: boolean; error?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.destroy();
        resolve(result);
      };

      input.pipe(child.stdin);
      input.on('error', err => {
        child.kill('SIGKILL');
        finish({ success: false, error: `Failed to read dump file: ${err.message}` });
      });
      child.stdin.on('error', () => { /* EPIPE when the child dies first; close handles it */ });
      child.stderr.on('data', d => { if (stderr.length < 4000) stderr += d.toString(); });
      child.on('error', err => finish({ success: false, error: `Failed to run docker exec: ${err.message}` }));
      child.on('close', code => {
        // 137 = the in-container timeout's KILL; the elapsed guard keeps a
        // genuine externally-killed pg_restore distinguishable.
        if (killed || (code === 137 && Date.now() - restoreStartedAt >= DUMP_TIMEOUT_MS)) {
          return finish({ success: false, error: `Restore timed out after ${DUMP_TIMEOUT_MS / 60000} minutes` });
        }
        if (code !== 0) return finish({ success: false, error: `pg_restore exited with code ${code}: ${stderr.trim().slice(0, 500)}` });
        finish({ success: true });
      });
    });

    let termWarning = '';
    if (restore.success) {
      steps.restored = true;
      lastErrors.delete(botId);
      unsavedRestoreErrors.delete(botId);
      try {
        containerManager.updateInstanceFleetRestoreError(botId, null);
      } catch (err) {
        console.error(`[FleetBackup] Could not clear the restore notice for ${botId}: ${err}`);
      }
      if (liveTerm !== null) {
        // RETURNING-counted: a psql exit 0 with zero rows updated (a dump
        // whose term table exists but is empty) must warn, not report success.
        const bump = await execDocker(['exec', '-e', 'PGOPTIONS=-c default_transaction_read_only=off', fleetDb.containerName,
          'psql', '-U', fleetDb.user, '-d', fleetDb.db, '-tA', '-v', 'ON_ERROR_STOP=1',
          '-c', `WITH u AS (UPDATE smdb_control.term SET term = GREATEST(term, ${liveTerm}) RETURNING 1) SELECT count(*) FROM u`]);
        if (bump.ok && Number.parseInt(bump.stdout.trim(), 10) >= 1) {
          steps.termReconciledTo = liveTerm;
        } else {
          termWarning = `; the restored control term could not be advanced to the pre-restore value (${liveTerm})${bump.ok ? ' - the restored dump has no control term row' : ''} - if the master parks on the witness fence, advance smdb_control.term by hand and restart it`;
          console.error(`[FleetBackup] Term reconcile failed on ${fleetDb.containerName}: ${bump.ok ? 'no term row to advance' : bump.stderr.trim().split('\n').pop()}`);
        }
      }
    } else {
      setRestoreError(botId, file, restore.error || 'unknown error', 'The database may hold a partial restore');
    }

    // 7. On a failed restore, terminate any surviving session BEFORE lifting:
    // a timed-out pg_restore's server-side process is fence-exempt, and left
    // alive it would keep writing into the unfenced database.
    if (!restore.success) {
      await execDocker(['exec', fleetDb.containerName, 'psql', '-U', fleetDb.user, '-d', 'postgres', '-tA',
        '-c', "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND backend_type = 'client backend'"]);
    }

    // 8. Lift the fence BEFORE the restarts, so instances come back to a
    // writable database. 'stripped' cleans only the persisted copy: the LIVE
    // cluster stays read-only until its container restarts.
    const lift = await liftAndTrack(botId, fleetDb);
    fenced = lift !== 'lifted';
    if (lift !== 'lifted') {
      console.error(`[FleetBackup] Restore fence on ${fleetDb.containerName}: ${lift === 'stripped'
        ? 'live lift failed; auto.conf stripped, the database stays read-only until its container restarts'
        : 'could not be lifted or stripped'}`);
    }
    const liftWarning = lift === 'lifted' ? '' : '; additionally the write fence could not be lifted live, so the database is READ-ONLY until its container restarts';

    // 9. Restart the instances stopped in step 2
    for (const id of steps.stopped) {
      const start = await asResult(containerManager.startBot(id));
      if (start.success) steps.restarted.push(id);
      else console.error(`[FleetBackup] Failed to restart ${id} after restore: ${start.error}`);
    }

    if (!restore.success) return { success: false, error: `${restore.error}${liftWarning}`, steps };
    if (lift !== 'lifted') return { success: false, error: `Restored, but the write fence could not be lifted live: the database is READ-ONLY until its container restarts (see manager logs)${termWarning}`, steps };
    return { success: true, ...(termWarning ? { warning: termWarning.slice(2) } : {}), steps };
  } finally {
    // The leftover-lift attempt must finish before the busy gate opens, or a
    // retry's fresh fence could be dissolved by this stale lift mid-restore.
    if (fenced) await liftAndTrack(botId, fleetDb);
    busy.delete(botId);
  }
}

/**
 * Start the fleet backup scheduler.
 */
export function startFleetBackupScheduler(): void {
  if (intervalHandle) return;

  console.log(`[FleetBackup] Started (tick: ${TICK_INTERVAL_MS / 1000}s)`);

  seedStuckFences().catch(err => {
    console.error('[FleetBackup] Stuck-fence seed error:', err);
  });

  intervalHandle = setInterval(() => {
    runFleetBackupTick().catch(err => {
      console.error('[FleetBackup] Tick error:', err);
    });
  }, TICK_INTERVAL_MS);
}

/**
 * Stop the fleet backup scheduler.
 */
export function stopFleetBackupScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[FleetBackup] Stopped');
  }
}
