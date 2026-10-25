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

// Notices the registry could not save; read before the record, which then holds an older notice or none.
const unsavedRestoreErrors: Map<string, { file: string; text: string }> = new Map();

function restoreNotice(botId: string): { file: string; text: string } | null {
  return unsavedRestoreErrors.get(botId) || containerManager.getBot(botId)?.fleetRestoreError || null;
}

function setRestoreError(botId: string, file: string, reason: string, consequence: string): void {
  const text = `Restore of ${file} failed: ${reason}. ${consequence}; restore a dump again before the bot relies on it`;
  try {
    containerManager.updateInstanceFleetRestoreError(botId, { file, text });
    unsavedRestoreErrors.delete(botId);
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
  if (busy.has(botId) || containerManager.isShuttingDown()) return false;
  busy.add(botId);
  return true;
}

export function releaseFleetBackupBusy(botId: string): void {
  busy.delete(botId);
}

export function isFleetBackupBusy(botId: string): boolean {
  return busy.has(botId);
}

/** A held backup slot or op lock, named; null when neither is held. A shutdown waits on these, bounded. */
export function inFlightLaneBlocker(): string | null {
  const name = (id: string) => containerManager.getBot(id)?.displayName || id;
  const slot = Array.from(busy)[0];
  if (slot) return `a database dump, restore or replication change is running on ${name(slot)}`;
  const op = containerManager.activeBotOps()[0];
  if (op) return `operation '${op[1]}' is running on ${name(op[0])}`;
  return null;
}

/** Waits, bounded, until inFlightLaneBlocker answers null; the lane still running at the bound, or null. */
export async function waitForInFlightLanes(boundMs: number, pollMs = 1_000): Promise<string | null> {
  const deadline = Date.now() + boundMs;
  let lane = inFlightLaneBlocker();
  if (lane) console.log(`[Shutdown] Waiting up to ${Math.round(boundMs / 1000)} s: ${lane}`);
  while (lane && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, pollMs));
    lane = inFlightLaneBlocker();
  }
  return lane;
}

/**
 * The lane a manager self-update would cut short, named; null when none runs. Parked runs are left out: they
 * wait for the operator and resume after a restart by design.
 */
export function databaseLaneBlocker(): string | null {
  const inFlight = inFlightLaneBlocker();
  if (inFlight) return inFlight;
  for (const b of containerManager.getAllBots()) {
    if (b.recoveryRescue && !b.recoveryRescue.parked) return `a database rescue is running on ${b.displayName} (${b.recoveryRescue.phase})`;
    if (b.fleetFailback && !b.fleetFailback.parked) return `a ${b.fleetFailback.mode} run is running on ${b.displayName} (${b.fleetFailback.phase})`;
    if (b.fleetTransfer && !b.fleetTransfer.parked) return `a database transfer is running on ${b.displayName} (${b.fleetTransfer.phase})`;
    if (b.fleetDbReplicaSeed && !b.fleetDbReplicaSeed.parked) return `a standby seed is running on ${b.displayName}`;
  }
  return null;
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

// A floor this process observed but could not write to disk; a retry in the same process still uses it.
const heldFloors: Map<string, number> = new Map();

/** The floor kept on disk or held in memory, whichever is higher (term), and the disk value alone (disk); null when none was kept; an error when the file cannot be read. */
function readTermFloor(botId: string): { ok: true; term: number | null; disk: number | null } | { ok: false; error: string } {
  let term: number | null = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(termFloorPath(botId), 'utf-8'));
    if (!Number.isSafeInteger(parsed?.term)) return { ok: false, error: 'it holds no whole-number term' };
    term = parsed.term;
  } catch (err: any) {
    if (err?.code !== 'ENOENT') return { ok: false, error: err?.message || String(err) };
  }
  const disk = term;
  const held = heldFloors.get(botId);
  if (held !== undefined && (term === null || held > term)) term = held;
  return { ok: true, term, disk };
}

/** Write the floor through a synced temp file and a rename; the error text when it was not kept on disk. */
function writeTermFloor(botId: string, term: number): string | null {
  const held = heldFloors.get(botId);
  if (held === undefined || term > held) heldFloors.set(botId, term);
  const target = termFloorPath(botId);
  const tmp = `${target}.tmp`;
  try {
    ensurePrivateDir(backupDir(botId));
    fs.writeFileSync(tmp, JSON.stringify({ term }), { mode: PRIVATE_FILE_MODE });
    syncPath(tmp, 'r+');
    fs.renameSync(tmp, target);
  } catch (err: any) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    const text = err?.message || String(err);
    console.error(`[FleetBackup] Could not persist the term floor for ${botId}: ${text}`);
    return text;
  }
  try {
    syncPath(backupDir(botId), 'r');
  } catch (err: any) {
    // Windows cannot open a folder to sync it; NTFS journals the rename itself.
    if (process.platform !== 'win32') return `the floor was written, but its folder could not be synced to disk: ${err?.message || err}`;
  }
  return null;
}

/**
 * A decommission ENDS the term space: a rebuilt database starts its terms
 * near zero, and a floor carried over from the destroyed generation would
 * advance the fresh space to the dead one's high-water mark - silently
 * defeating the witness fence the floor exists to serve.
 */
export function clearTermFloor(botId: string): void {
  heldFloors.delete(botId);
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

/**
 * Backup folders holding dumps for ids the registry no longer has: a
 * decommission's safety dump outlives a Remove of its instance. A folder that
 * cannot be read is listed with dumps null.
 */
export function orphanedFleetBackups(knownIds: ReadonlySet<string>): Array<{ id: string; dumps: number | null; folder: string }> {
  let ids: string[];
  try {
    ids = fs.readdirSync(path.join(DATA_DIR, 'backups'));
  } catch (err: any) {
    if (err?.code === 'ENOENT') return [];
    throw new Error(`The backups folder could not be read: ${err?.message || err}`);
  }
  const out: Array<{ id: string; dumps: number | null; folder: string }> = [];
  for (const id of ids.sort()) {
    if (knownIds.has(id)) continue;
    try { if (!fs.statSync(path.join(DATA_DIR, 'backups', id)).isDirectory()) continue; } catch { /* listed below as unreadable */ }
    let dumps: number | null;
    try { dumps = listFleetBackups(id).length; } catch { dumps = null; }
    if (dumps !== 0) out.push({ id, dumps, folder: `backups/${id}/fleet-postgres` });
  }
  return out;
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

type RestoreSteps = { stopped: string[]; preRestoreDump: string | null; restored: boolean; termReconciledTo: number | null; guildsRaised: string[] | null; leaseTerm: number | null; restarted: string[] };

const lastLine = (text: string) => text.trim().split('\n').pop() || 'unknown reason';

/** host:port/database of a postgres URL, which two instances share a database by; null when it does not parse. */
function databaseIdentity(url: string): string | null {
  try {
    const u = new URL(url);
    const db = decodeURIComponent(u.pathname.replace(/^\//, ''));
    if (!u.hostname || !db) return null;
    return `${u.hostname.toLowerCase()}:${u.port || '5432'}/${db}`;
  } catch {
    return null;
  }
}

/**
 * The instances on this manager that share the database: this one always, and every other whose stored URL names
 * the same host, port and database (a query-string difference such as ?sslmode does not hide one). The key is
 * resolved PER CANDIDATE: another app spells its DSN differently. It cannot see them all (a worker's DSN lives in
 * the bot's own env file, and other machines' instances are out of reach entirely), which is why the restore's
 * fence is the actual protection.
 */
function restoreSharers(instance: InstanceConfig, url: string): InstanceConfig[] {
  const fleetDb = instance.fleetDb!;
  const aliases = new Set<string>([`${fleetDb.containerName.toLowerCase()}:5432/${fleetDb.db}`]);
  const ownIdentity = databaseIdentity(url);
  if (ownIdentity) aliases.add(ownIdentity);
  if (fleetDb.replication) aliases.add(`${fleetDb.replication.publicHost.toLowerCase()}:${fleetDb.replication.hostPort}/${fleetDb.db}`);
  return containerManager.getAllBots().filter(b => {
    if (b.id === instance.id) return true;
    const key = findAppCapabilities(b.sourceUrl)?.companionDb?.env.url;
    const identity = key ? databaseIdentity((envManager.getEnvVars(b.id)[key] || '').trim()) : null;
    return identity !== null && aliases.has(identity);
  });
}

/**
 * The instances a restore of this instance's database would stop, for its confirm: each sharer with whether docker
 * shows it running now (null when docker did not answer). An error when the stored URL cannot be read.
 */
export async function previewFleetRestore(botId: string): Promise<{ success: true; instances: Array<{ id: string; displayName: string; running: boolean | null }> } | { success: false; error: string }> {
  const instance = containerManager.getBot(botId);
  if (!instance?.fleetDb) return { success: false, error: 'No fleet database record' };
  const store = envManager.getEnvVarsWithStatus(botId);
  const urlKey = findAppCapabilities(instance.sourceUrl)?.companionDb?.env.url;
  if (store.corrupt || (urlKey && store.undecryptable.includes(urlKey))) return { success: false, error: 'The stored database URL cannot be read' };
  const url = urlKey ? (store.vars[urlKey] || '').trim() : '';
  if (!url) return { success: false, error: 'Instance has no stored database URL' };
  const instances: Array<{ id: string; displayName: string; running: boolean | null }> = [];
  for (const b of restoreSharers(instance, url)) {
    const live = await containerManager.runningInstanceContainers(b.id);
    instances.push({ id: b.id, displayName: b.displayName, running: live === null ? null : live.length > 0 });
  }
  return { success: true, instances };
}

/** Why a restore must not start while another lane holds this instance's database; null when none does. */
function restoreAdmissionRefusal(instance: InstanceConfig): string | null {
  if (instance.recoveryRescue) return 'A database rescue is recorded on this instance; finish or cancel it before restoring a dump';
  if (instance.recoveryChannel) return `The recovery channel is armed on this instance (${instance.recoveryChannel.mode}); disarm it before restoring a dump`;
  if (instance.fleetFailback) return `A ${instance.fleetFailback.mode} run is recorded on this instance (${instance.fleetFailback.phase}); Continue, Cancel or Dismiss it on the Database modal before restoring a dump`;
  if (instance.fleetTransfer) return `A database transfer is recorded on this instance (${instance.fleetTransfer.phase}); let it finish or cancel it before restoring a dump`;
  if (instance.fleetDbReplicaSeed && instance.fleetDbReplicaSeed.parked !== true) return 'A standby seed is running on this instance; wait for it before restoring a dump';
  return null;
}

/**
 * The highest term the live database holds, from its control row and its guild leases: every lease token in
 * circulation carries a term at or below it. Null when neither table exists; an error when the probe failed.
 */
export async function probeLiveTerm(fleetDb: RestoreFleetDb): Promise<{ ok: true; term: number | null } | { ok: false; error: string }> {
  const psql = (sql: string) => execDocker(['exec', fleetDb.containerName, 'psql', '-U', fleetDb.user, '-d', fleetDb.db, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
  const tables = await psql("SELECT to_regclass('smdb_control.term') IS NOT NULL, to_regclass('smdb_data.guild_ownership') IS NOT NULL");
  if (!tables.ok) return { ok: false, error: lastLine(tables.stderr) };
  const [control, guilds] = tables.stdout.trim().split('|');
  if (!/^[tf]$/.test(control ?? '') || !/^[tf]$/.test(guilds ?? '')) return { ok: false, error: `the table probe answered '${tables.stdout.trim()}'` };
  const sources = [
    control === 't' ? '(SELECT max(term) FROM smdb_control.term)' : null,
    guilds === 't' ? '(SELECT max(term) FROM smdb_data.guild_ownership)' : null,
  ].filter((s): s is string => s !== null);
  if (sources.length === 0) return { ok: true, term: null };
  const probe = await psql(`SELECT coalesce(GREATEST(${sources.join(', ')}), -1)`);
  if (!probe.ok) return { ok: false, error: lastLine(probe.stderr) };
  const term = Number(probe.stdout.trim());
  if (!Number.isSafeInteger(term)) return { ok: false, error: `the term probe answered '${probe.stdout.trim()}'` };
  return { ok: true, term: term < 0 ? null : term };
}

/**
 * Lift every restored guild lease to term floor+1 in the fence-exempt session, so no lease token minted before the
 * restore (term at most floor, any epoch) can write over a restored row; the next grant mints above it and hydrates
 * from the restored rows. The guilds raised, empty when the dump has no lease table.
 */
export async function raiseGuildTerms(fleetDb: RestoreFleetDb, floor: number): Promise<{ ok: true; guilds: string[] } | { ok: false; error: string }> {
  const psql = (sql: string) => execDocker(['exec', '-e', 'PGOPTIONS=-c default_transaction_read_only=off', fleetDb.containerName,
    'psql', '-U', fleetDb.user, '-d', fleetDb.db, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
  const table = await psql("SELECT to_regclass('smdb_data.guild_ownership') IS NOT NULL");
  if (!table.ok) return { ok: false, error: lastLine(table.stderr) };
  if (table.stdout.trim() === 'f') return { ok: true, guilds: [] };
  if (table.stdout.trim() !== 't') return { ok: false, error: `the table probe answered '${table.stdout.trim()}'` };
  const raise = await psql(`WITH u AS (UPDATE smdb_data.guild_ownership SET term = ${floor + 1}, updated_at = now() WHERE term <= ${floor} RETURNING guild_id) SELECT guild_id FROM u`);
  if (!raise.ok) return { ok: false, error: lastLine(raise.stderr) };
  return { ok: true, guilds: raise.stdout.split('\n').map(s => s.trim()).filter(Boolean) };
}

/** The sharers docker runs now and their containers, each one's own database sidecar aside; null when docker did not answer for one. */
async function sharersRunning(sharing: InstanceConfig[]): Promise<{ ids: string[]; names: string[] } | null> {
  const ids: string[] = [];
  const names: string[] = [];
  for (const b of sharing) {
    const live = await containerManager.runningInstanceContainers(b.id);
    if (live === null) return null;
    if (live.length > 0) ids.push(b.id);
    names.push(...live);
  }
  return { ids, names };
}

/**
 * Restore a dump into the instance's sidecar. Refused while another lane holds the database (a rescue, an armed
 * recovery channel, a failback, transfer or seed run, an op lock on an instance that shares it). In order: the
 * instances that share the database are held (Start, Restart, Update and Build refuse) and the ones docker shows
 * running are stopped, the sidecar is brought back alone, write fence, pre-restore safety dump under the fence
 * (refusing the restore if it fails), the live term kept on disk (refusing when it cannot be), the restore
 * recorded, drop and recreate of the database (pg_restore --clean cannot restore this schema: the partition PK
 * drops it emits are refused as inherited constraints and the run exits 1 even when everything applied; a fresh
 * database makes any restore error a real failure), pg_restore --exit-on-error of the chosen file with the
 * restoring session exempted, the control term and every guild lease raised to the kept term, fence lifted,
 * stopped instances restarted. A failure past the drop keeps the fence on and the instances stopped.
 */
export async function restoreFleetBackup(
  botId: string,
  file: string
): Promise<{ success: boolean; error?: string; warning?: string; steps: RestoreSteps }> {
  const steps: RestoreSteps = {
    stopped: [], preRestoreDump: null, restored: false, termReconciledTo: null, guildsRaised: null, leaseTerm: null, restarted: [],
  };

  if (containerManager.isShuttingDown()) return { success: false, error: containerManager.SHUTDOWN_REFUSAL, steps };
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

  const admission = restoreAdmissionRefusal(instance);
  if (admission) return { success: false, error: `${admission} (nothing was changed)`, steps };

  const floorRead = readTermFloor(botId);
  if (!floorRead.ok) {
    return { success: false, error: `The term floor file ${termFloorPath(botId)} could not be read (${floorRead.error}), so the pre-restore control term is unknown and the restore was refused (nothing was changed); repair the file, then retry`, steps };
  }

  const sharing = restoreSharers(instance, url);
  for (const b of sharing) {
    const op = containerManager.isBotBusy(b.id);
    if (op) return { success: false, error: `Operation '${op}' is running on ${b.displayName}, which shares this database; wait for it before restoring a dump (nothing was changed)`, steps };
  }

  if (busy.has(botId)) return { success: false, error: 'A backup operation is already in progress', steps };
  busy.add(botId);
  const sharerIds = sharing.map(b => b.id);
  containerManager.holdForDatabaseLane(sharerIds, 'A database restore');
  let held = true;
  const release = () => {
    if (held) containerManager.releaseDatabaseLane(sharerIds);
    held = false;
  };
  const nameOf = (id: string) => containerManager.getBot(id)?.displayName || id;
  let fenced = false;
  let sidecarStartedAlone = false;

  // Before the drop nothing was restored: bring back what was stopped, and stop a sidecar this lane started alone.
  const undo = async (): Promise<string> => {
    release();
    const unstarted: string[] = [];
    for (const id of steps.stopped) {
      const start = await asResult(containerManager.startBot(id));
      if (start.success) steps.restarted.push(id);
      else unstarted.push(nameOf(id));
    }
    if (sidecarStartedAlone && !steps.stopped.includes(botId)) {
      const stop = await execDocker(['stop', fleetDb.containerName]);
      if (!stop.ok) console.error(`[FleetBackup] Could not stop the database the refused restore started for ${botId}: ${lastLine(stop.stderr)}`);
    }
    return unstarted.length > 0
      ? `; these instances were stopped and could not be restarted: ${unstarted.join(', ')} (start them by hand)`
      : '';
  };

  // Past the drop the database may be missing or partial: the fence stays on and the stopped instances stay down.
  const keepFenced = (reason: string, guards = 'a database that may be missing or partial', runningNow: string[] = []) => {
    fenced = false;
    release();
    const stillStopped = steps.stopped.filter(id => !runningNow.includes(id));
    const runs = runningNow.length > 0 ? `${runningNow.map(nameOf).join(', ')} runs now. ` : '';
    const kept = stillStopped.length > 0
      ? ` and the stopped instances stay stopped (${stillStopped.map(nameOf).join(', ')})`
      : steps.stopped.length > 0 ? '' : ' and the stopped instances stay stopped (none were running)';
    const back = steps.preRestoreDump
      ? `the pre-restore dump ${steps.preRestoreDump} holds the database as it was`
      : 'no pre-restore dump was taken, because the database was missing';
    setStuck(botId, fleetDb, `The database is READ-ONLY: a restore of ${file} failed (${reason}), so its write fence stays on; restore a dump again (${back})`);
    return `${reason}. ${runs}The write fence stays on${kept}, so nothing writes to ${guards}; restore a dump again: ${back}`;
  };

  try {
    // 0. A restore must work on a DOWN fleet - that is exactly when it is
    // needed, and starting the whole instance first would boot the bot
    // against the bad data. Bring the database up alone when it is not up.
    if (!await isContainerRunning(fleetDb.containerName)) {
      const started = await asResult(containerManager.startFleetDbSidecar(botId));
      if (!started.success) {
        release();
        return { success: false, error: `Could not start the database for the restore: ${started.error}`, steps };
      }
      sidecarStartedAlone = true;
    }

    // 1. Courtesy stop of every sharing instance docker shows running: the
    // status record can be stale either way (a crashed bot, a hand-started one).
    for (const b of sharing) {
      const live = await containerManager.runningInstanceContainers(b.id);
      if (live === null) {
        const note = await undo();
        return { success: false, error: `Docker could not say whether instance ${b.displayName} is running, so the restore was refused${note ? '' : ' and nothing was changed'}${note}`, steps };
      }
      if (live.length === 0) continue;
      const stop = await asResult(containerManager.stopBot(b.id));
      if (!stop.success) {
        const why = stop.error === 'Bot is not running'
          ? `its record says stopped while docker runs ${live.join(', ')}; stop those containers, then retry`
          : stop.error;
        const note = await undo();
        return { success: false, error: `Could not stop instance ${b.displayName}: ${why}${note}`, steps };
      }
      steps.stopped.push(b.id);
    }

    // 2. Stopping the host took its sidecar down with the compose project;
    // bring the database back alone.
    if (!await isContainerRunning(fleetDb.containerName)) {
      const started = await asResult(containerManager.startFleetDbSidecar(botId));
      if (!started.success) {
        const note = await undo();
        return { success: false, error: `Could not start the database for the restore: ${started.error}${note}`, steps };
      }
      sidecarStartedAlone = true;
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
      const note = await undo();
      const fenceWarning = cleared === 'lifted' ? '' : '; the database may be READ-ONLY until its container restarts';
      return { success: false, error: `Could not fence the database for the restore: ${lastLine(fence.stderr)}${fenceWarning}${note}`, steps };
    }

    // A refusal past the fence lifts it and brings back what was stopped; only then has it changed nothing.
    const refuse = async (refused: string, detail: string) => {
      const cleared = await liftAndTrack(botId, fleetDb);
      fenced = cleared !== 'lifted';
      const note = await undo();
      return { success: false, error: `${refused}${note ? '' : ', and nothing was changed'}: ${detail}${liftNote(cleared)}${note}`, steps };
    };

    // 4. Pre-restore safety dump UNDER the fence, so it holds every write the
    // drop below removes. A MISSING database (a prior recreate failure) has
    // no data to protect and dumping it would refuse every retry, so
    // existence is probed first; an unanswerable probe still refuses.
    const exists = await execDocker(['exec', fleetDb.containerName, 'psql', '-U', fleetDb.user, '-d', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1',
      '-c', `SELECT count(*) FROM pg_database WHERE datname = '${fleetDb.db.replace(/'/g, "''")}'`]);
    if (!exists.ok) {
      return await refuse('Could not check the database before the restore, so the restore was refused', lastLine(exists.stderr));
    }
    // The app's control term must never move backwards: the witness fence
    // parks a master whose store term sits below a claim any node ever
    // posted, and only this lane knows the rewind is a deliberate restore
    // rather than a stale fork (F-R5-1). The live term is kept on disk before
    // the drop (a retry after a failed restore probes a missing or partial
    // database), and the restored copy is advanced to it after pg_restore.
    let floor: number | null = floorRead.term;
    if (exists.stdout.trim() !== '0') {
      const safety = await runFleetDump(instance, 'pre-restore-');
      if (!safety.success) {
        lastErrors.set(botId, `Pre-restore dump failed: ${safety.error}`);
        return await refuse('Pre-restore dump failed, restore refused', safety.error || 'unknown reason');
      }
      steps.preRestoreDump = safety.file || null;

      const live = await probeLiveTerm(fleetDb);
      if (!live.ok) return await refuse('Could not read the control term before the restore, so the restore was refused', live.error);
      if (live.term !== null && (floor === null || live.term > floor)) floor = live.term;
    }
    // A floor held only in memory (an earlier attempt could not write it) is written now too: past the drop, the
    // probe of a missing or partial database cannot recover it after a manager restart.
    if (floor !== null && (floorRead.disk === null || floor > floorRead.disk)) {
      const kept = writeTermFloor(botId, floor);
      if (kept) {
        return await refuse(`The pre-restore control term ${floor} could not be kept on disk, so the restore was refused`,
          `${kept}; free space under ${DATA_DIR} and retry (this manager holds the term in memory until it restarts)`);
      }
    }

    const outside = await sharersRunning(sharing);
    if (outside === null) {
      return await refuse('Docker could not say whether an instance sharing the database was started during the restore, so the restore was refused', 'retry in a moment');
    }
    if (outside.names.length > 0) {
      return await refuse('An instance sharing the database was started outside the manager during the restore, so the restore was refused',
        `${outside.names.join(', ')} runs now; stop it and keep it stopped (also from CasaOS) until the restore ends, then retry`);
    }

    // The notice a manager restart mid-restore leaves standing; a finished restore replaces or clears it.
    const back = steps.preRestoreDump ? `the pre-restore dump is ${steps.preRestoreDump}` : 'no pre-restore dump was taken, because the database was missing';
    try {
      containerManager.updateInstanceFleetRestoreError(botId, {
        file,
        text: `Restore of ${file} has not finished: if it is no longer running (the manager restarted), the database may be missing or hold a partial restore and its write fence is still on; restore a dump again before the bot relies on it (${back})`,
      });
      unsavedRestoreErrors.delete(botId);
    } catch (err) {
      return await refuse('The restore could not be recorded before the database was dropped, so the restore was refused', err instanceof Error ? err.message : String(err));
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
      const reason = `could not recreate the database: ${lastLine(recreate.stderr)}`;
      setRestoreError(botId, file, reason, `The database may be missing, or unchanged if the drop itself failed; its write fence stays on (${back})`);
      return { success: false, error: `Restore failed: ${keepFenced(reason)}`, steps };
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

    if (!restore.success) {
      // 7. Terminate any surviving session before returning: a timed-out
      // pg_restore's server-side process is fence-exempt, and left alive it
      // would keep writing into the database.
      await execDocker(['exec', fleetDb.containerName, 'psql', '-U', fleetDb.user, '-d', 'postgres', '-tA',
        '-c', "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND backend_type = 'client backend'"]);
      const reason = restore.error || 'unknown error';
      setRestoreError(botId, file, reason, `The database may hold a partial restore; its write fence stays on (${back})`);
      return { success: false, error: `Restore failed: ${keepFenced(reason)}`, steps };
    }
    steps.restored = true;

    let termWarning = '';
    if (floor !== null) {
      // RETURNING-counted: a psql exit 0 with zero rows updated (a dump
      // whose term table exists but is empty) must warn, not report success.
      const bump = await execDocker(['exec', '-e', 'PGOPTIONS=-c default_transaction_read_only=off', fleetDb.containerName,
        'psql', '-U', fleetDb.user, '-d', fleetDb.db, '-tA', '-v', 'ON_ERROR_STOP=1',
        '-c', `WITH u AS (UPDATE smdb_control.term SET term = GREATEST(term, ${floor}) RETURNING 1) SELECT count(*) FROM u`]);
      if (bump.ok && Number.parseInt(bump.stdout.trim(), 10) >= 1) {
        steps.termReconciledTo = floor;
      } else {
        termWarning = `; the restored control term could not be advanced to the pre-restore value (${floor})${bump.ok ? ' - the restored dump has no control term row' : ''} - if the master parks on the witness fence, advance smdb_control.term by hand and restart it`;
        console.error(`[FleetBackup] Term reconcile failed on ${fleetDb.containerName}: ${bump.ok ? 'no term row to advance' : lastLine(bump.stderr)}`);
      }
      const raised = await raiseGuildTerms(fleetDb, floor);
      if (!raised.ok) {
        const reason = `the restored guild leases could not be raised above the pre-restore term ${floor} (${raised.error})`;
        setRestoreError(botId, file, reason, `A node still holding a pre-restore lease could write over the restored rows, so the write fence stays on (${back})`);
        return { success: false, error: `The dump was restored, but ${keepFenced(reason)}`, steps };
      }
      steps.guildsRaised = raised.guilds;
      steps.leaseTerm = floor + 1;
    }

    // An instance started meanwhile (a CasaOS tile click) read the database while it was dropped and rebuilt.
    const startedMeanwhile = await sharersRunning(sharing);
    if (startedMeanwhile === null || startedMeanwhile.names.length > 0) {
      const reason = startedMeanwhile === null
        ? "docker could not say whether an instance sharing the database was started during the restore, so the manager can't confirm that none read it while it was rebuilt"
        : `${startedMeanwhile.names.join(', ')} was started outside the manager during the restore and may act on what it read while the database was rebuilt; stop it`;
      setRestoreError(botId, file, reason, `The dump was restored, but the write fence stays on so nothing writes from what was read mid-restore (${back})`);
      return { success: false, error: `The dump was restored, but ${keepFenced(reason, 'the restored database from what was read mid-restore', startedMeanwhile?.ids)}`, steps };
    }

    lastErrors.delete(botId);
    unsavedRestoreErrors.delete(botId);
    let noticeWarning = '';
    try {
      containerManager.updateInstanceFleetRestoreError(botId, null);
    } catch (err) {
      console.error(`[FleetBackup] Could not clear the restore notice for ${botId}: ${err}`);
      noticeWarning = '; the notice that this restore had not finished could not be cleared (dismiss it on the Database modal)';
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

    // 9. Restart the instances stopped in step 1
    release();
    const unstarted: string[] = [];
    for (const id of steps.stopped) {
      const start = await asResult(containerManager.startBot(id));
      if (start.success) steps.restarted.push(id);
      else {
        unstarted.push(nameOf(id));
        console.error(`[FleetBackup] Failed to restart ${id} after restore: ${start.error}`);
      }
    }
    const startWarning = unstarted.length > 0 ? `; these instances were stopped and could not be restarted: ${unstarted.join(', ')} (start them by hand)` : '';

    if (lift !== 'lifted') return { success: false, error: `Restored, but the write fence could not be lifted live: the database is READ-ONLY until its container restarts (see manager logs)${termWarning}${noticeWarning}${startWarning}`, steps };
    const warning = `${termWarning}${noticeWarning}${startWarning}`;
    return { success: true, ...(warning ? { warning: warning.slice(2) } : {}), steps };
  } finally {
    // The leftover-lift attempt must finish before the busy gate opens, or a
    // retry's fresh fence could be dissolved by this stale lift mid-restore.
    if (fenced) await liftAndTrack(botId, fleetDb);
    release();
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
