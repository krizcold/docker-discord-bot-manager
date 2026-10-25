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
 * (read-only, pg_hba refusing every outside connection, sessions ended - the
 * sweep cannot see a consumer whose DSN lives in the bot's own store, so the
 * fence is the actual protection),
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
import { probeErrorTail, redactSecrets } from '../config/secretText';
import { readStandInPosture, StandInRead } from './appLifecycle';
import * as fleetFailback from './fleetFailback';
import * as fleetReplica from './fleetReplica';
import * as fleetTransfer from './fleetTransfer';
import * as recoveryRescue from './recoveryRescue';
import { REPLICATION_ROLE } from './fleetReplication';
import { busy, externalClaims, FENCE_HBA_COUNT_SQL, FENCE_HBA_OWNER_SQL, FENCE_OWNER_FILE, FENCE_OWNER_FILE_SQL, FENCE_OWNER_TAG, FenceLane, fenceOwnerLane, fenceOwnerText, parseFenceOwner, WRITE_FENCE_MARK } from './fleetBackupGuards';

const TICK_INTERVAL_MS = 60 * 1000; // 1 minute
const FACTS_TIMEOUT_MS = 10_000;
const REFIRE_GUARD_MS = 23 * 60 * 60 * 1000; // prevents double-fire within the hour window
const DUMP_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
/** A docker read (inspect, a SELECT or SHOW): a hung CLI must not hold its lane; a timed-out read is unknown. */
const READ_TIMEOUT_MS = 30_000;
const STALE_AFTER_MS = 36 * 60 * 60 * 1000;

const DATA_DIR = process.env.DATA_DIR || '/data/data';

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let tickRunning = false;

// Last dump attempt per instance (in-memory; persisted success lives on the record)
const lastAttempts: Map<string, number> = new Map();
// Last dump error per instance (in-memory, surfaced on the bot card)
const lastErrors: Map<string, string> = new Map();
// A standby copy that has left recovery, or stands in (read-only too), is dumped under this prefix.
const COPY_PREFIX = 'standin-';
const lastCopyAttempts: Map<string, number> = new Map();
const copyErrors: Map<string, string> = new Map();
/** docker's stderr can quote a DSN or a password, so a stored error text carries the instance's secrets as ***. */
function scrubbed(botId: string, text: string): string {
  const instance = containerManager.getBot(botId);
  return instance ? redactSecrets(text, containerManager.recordSecrets(instance)) : text;
}
// A stuck restore write fence, tracked apart from lastErrors: a read-only
// database still DUMPS successfully, so the nightly dump's success would wipe
// a warning parked in the shared slot while the fence still stands.
// One warning per database (the primary and a drop-back's copy are fenced apart), keyed by container name.
const fenceStuck: Map<string, Map<string, { text: string; db: RestoreFleetDb }>> = new Map();
function setStuck(botId: string, db: RestoreFleetDb, text: string): void {
  const entries = fenceStuck.get(botId) ?? new Map();
  entries.set(db.containerName, { text: scrubbed(botId, text), db });
  fenceStuck.set(botId, entries);
}
function clearStuck(botId: string, containerName: string): void {
  const entries = fenceStuck.get(botId);
  if (!entries) return;
  entries.delete(containerName);
  if (entries.size === 0) fenceStuck.delete(botId);
}
const isStuck = (botId: string, containerName: string) => fenceStuck.get(botId)?.has(containerName) === true;
// The databases whose fence a failback or drop-back run left on, with the owner its layers name. It only points at
// the fence: the layers' owners decide who lifts it. Persisted on the instance (fleetConsentFenceLeft) so a manager
// restart keeps it. This process's word overrides the disk while a save is refused: one it recorded is held here,
// one it cleared waits here for its clear to land.
type FenceKey = { botId: string; containerName: string };
const fenceKey = (botId: string, containerName: string) => JSON.stringify([botId, containerName]);
const stuckByFailback: Map<string, string> = new Map();
const clearPending: Map<string, FenceKey> = new Map();

/** Save the record (owner null clears it); false when the save was refused. */
function recordFailbackFence(botId: string, containerName: string, owner: string | null): boolean {
  const key = fenceKey(botId, containerName);
  if (owner) { stuckByFailback.set(key, owner); clearPending.delete(key); }
  else { stuckByFailback.delete(key); clearPending.set(key, { botId, containerName }); }
  try {
    containerManager.updateInstanceFleetConsentFenceLeft(botId, containerName, owner);
    clearPending.delete(key);
    return true;
  } catch (err) {
    console.error(`[FleetBackup] Could not save the failback fence record for ${botId} (${containerName}):`, err);
    return false;
  }
}
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
  const text = scrubbed(botId, `Restore of ${file} failed: ${reason}. ${consequence}; restore a dump again before the bot relies on it`);
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
 * A slot a recovery source's quiesce left held: the source is swapped away and nothing runs on it under its op
 * lock. The slot only waits for the receiver's teardown, so a shutdown waiting on it would wait out its whole bound.
 */
function quiescedSourceSlot(botId: string): boolean {
  const instance = containerManager.getBot(botId);
  return !!instance?.recoverySwappedAway && instance.recoveryChannel?.mode === 'source' && externalClaims.has(botId)
    && !containerManager.activeBotOps().some(([id]) => id === botId);
}

/**
 * A held backup slot or op lock, named; null when neither is held. A shutdown waits on these, bounded, and passes
 * over a quiesced source's slot (passQuiesced); a self-update does not, since the recreate would drop that slot.
 */
export function inFlightLaneBlocker(opts: { passQuiesced?: boolean } = {}): string | null {
  const name = (id: string) => containerManager.getBot(id)?.displayName || id;
  const slot = Array.from(busy).find(id => !opts.passQuiesced || !quiescedSourceSlot(id));
  if (slot) return `a database dump, restore or replication change is running on ${name(slot)}`;
  const op = containerManager.activeBotOps()[0];
  if (op) return `operation '${op[1]}' is running on ${name(op[0])}`;
  return null;
}

/** Waits, bounded, until inFlightLaneBlocker answers null; the lane still running at the bound, or null. */
export async function waitForInFlightLanes(boundMs: number, pollMs = 1_000): Promise<string | null> {
  const deadline = Date.now() + boundMs;
  for (const id of busy) {
    if (quiescedSourceSlot(id)) console.log(`[Shutdown] Not waiting on ${containerManager.getBot(id)?.displayName || id}: the backup slot is held for the swap's quiesce, which nothing runs under now; the receiver's teardown or a disarm releases it`);
  }
  let lane = inFlightLaneBlocker({ passQuiesced: true });
  if (lane) console.log(`[Shutdown] Waiting up to ${Math.round(boundMs / 1000)} s: ${lane}`);
  while (lane && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, pollMs));
    lane = inFlightLaneBlocker({ passQuiesced: true });
  }
  return lane;
}

/**
 * The lane a manager self-update would cut short, named; null when none runs. Parked runs are left out: they
 * wait for the operator and resume after a restart by design. A run is read as its card reads it, so one whose
 * park or clear the registry refused, or that no runner of this process drives, counts as parked.
 */
export function databaseLaneBlocker(): string | null {
  const inFlight = inFlightLaneBlocker();
  if (inFlight) return inFlight;
  for (const b of containerManager.getAllBots()) {
    const rescue = recoveryRescue.getRescueStatus(b);
    if (rescue && !rescue.parked) return `a database rescue is running on ${b.displayName} (${rescue.phase})`;
    const failback = fleetFailback.failbackView(b);
    if (failback && !failback.parked) return `a ${failback.mode} run is running on ${b.displayName} (${failback.phase})`;
    const transfer = fleetTransfer.transferView(b);
    if (transfer && !transfer.parked) return `a database transfer is running on ${b.displayName} (${transfer.phase})`;
    const seed = fleetReplica.seedView(b);
    if (seed && !seed.parked) return `a standby seed is running on ${b.displayName}`;
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
    execFile('docker', ['inspect', '-f', '{{.State.Running}}', containerName], { timeout: READ_TIMEOUT_MS }, (err, stdout, stderr) => {
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

function execDocker(args: string[], timeout?: number): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile('docker', args, { maxBuffer: 4 * 1024 * 1024, ...(timeout ? { timeout } : {}) }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr || (err?.killed ? `docker did not answer within ${(timeout ?? 0) / 1000} s` : '')) });
    });
  });
}

/** A docker call that only reads; one that changes data runs through execDocker with no bound, since killing it mid-write is worse than the wait. */
function readDocker(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return execDocker(args, READ_TIMEOUT_MS);
}

// stopBot/startBot THROW on an op-lock conflict; inside the restore lane a
// throw would skip the restart obligations and turn a finished restore into
// a 500, so any rejection from these container ops becomes an ordinary
// failure here.
function asResult(op: Promise<{ success: boolean; error?: string }>): Promise<{ success: boolean; error?: string }> {
  return op.catch(err => ({ success: false, error: String((err as Error)?.message || err) }));
}

type RestoreFleetDb = { containerName: string; user: string; db: string; volume: string };
type DockerAnswer = { ok: boolean; stdout: string; stderr: string };

/**
 * lifted: no layer is left. stripped: the live lift failed and the volume's files no longer hold the fence, so a
 * restart clears it. failed: the read-only setting could not be lifted or stripped. unreloaded: as failed, and the
 * fence's pg_hba lines are out of pg_hba.conf but every reload sent failed, so the database may refuse the bot
 * until it reloads or restarts. locked: the fence's pg_hba lines could not be removed, so the database refuses every
 * connection but the manager's through a restart too. gone: the volume is gone. unknown: docker did not say whether
 * the volume exists, so nothing was mounted.
 */
export type FenceLift = 'lifted' | 'stripped' | 'failed' | 'unreloaded' | 'locked' | 'gone' | 'unknown' | 'held';

/** The two layers of the write fence: the read-only default, and the pg_hba lines that refuse every outside connection. */
export type FenceLayers = { readOnly: boolean; hba: boolean };
const BOTH_LAYERS: FenceLayers = { readOnly: true, hba: true };
const NO_LAYERS: FenceLayers = { readOnly: false, hba: false };

/** The layers on a database and the owner each names (null: off, or it names no lane); ownerFile is the owner file's raw content, '' when missing. */
export type FenceState = FenceLayers & { readOnlyOwner: string | null; hbaOwner: string | null; ownerFile: string };

/**
 * Which layer an earlier fence left on a fence may take over: 'any' for the lanes that replace or destroy the data
 * (restore, re-seed, decommission), 'lane' for the consent park, which takes over only a layer its own lane left, and
 * 'run' for the recovery quiesce, which takes over a layer a failback, drop-back or swap run left (the swap moves the
 * primary away, so that run must not lift the layer under it), never a restore's, re-seed's, decommission's or no lane's.
 */
export type FenceTakeOver = 'any' | 'lane' | 'run';
const RUN_LANES: ReadonlyArray<FenceLane | null> = ['failback', 'dropback', 'swap'];

/**
 * The layers a lift left on because another lane, or no lane, owns them; holder is that owner (null: no lane).
 * fromFiles: the volume strip removed a layer of this lane's from the files. detail: docker's last line when the strip failed.
 */
export type FenceHeld = { readOnly: boolean; hba: boolean; holder: string | null; fromFiles?: boolean; detail?: string };

/** owner is lane:<ms>; 'swap:*' stands for any swap, as the disarm lifts the layers of whichever swap set them. */
export function newFenceOwner(lane: FenceLane, at: number = Date.now()): string {
  return `${lane}:${at}`;
}

/** The owner as a grep pattern (BRE) for the shell scripts. */
function ownerPattern(owner: string): string {
  return owner.endsWith(':*') ? `${owner.slice(0, -1)}[0-9][0-9]*` : owner;
}

function ownerMatches(found: string, owner: string): boolean {
  const named = parseFenceOwner(found);
  if (!named) return false;
  return owner.endsWith(':*') ? fenceOwnerLane(named) === owner.slice(0, -2) : named === owner;
}

/** Writes the read-only layer's owner file through a temp file, postgres-owned and 600. Run as root. */
export function fenceOwnerFileScript(owner: string, dir = FENCE_PGDATA): string {
  return `f=${dir}/${FENCE_OWNER_FILE}; printf '%s' '${owner}' > "$f.new" && chown postgres:postgres "$f.new" && chmod 600 "$f.new" && mv -f "$f.new" "$f"`;
}

/** Removes the owner file only while it still names owner. Run as root. */
function dropOwnerFileScript(owner: string, dir = FENCE_PGDATA): string {
  return `f=${dir}/${FENCE_OWNER_FILE}; [ -e "$f" ] || exit 0; grep -qx '${ownerPattern(owner)}' "$f" || exit 0; rm -f "$f"`;
}

/** The sidecar's pg_hba.conf (its volume sits at the image's PGDATA); the fence refuses a database that reads another file. */
export const FENCE_HBA_FILE = '/var/lib/postgresql/data/pg_hba.conf';
export const FENCE_PGDATA = path.posix.dirname(FENCE_HBA_FILE);
/** How long the fence waits for the reloaded pg_hba to refuse a TCP connection, and the gap between probes. */
export const fenceTiming = { probeDeadlineMs: 15_000, probeGapMs: 250 };

/** The fence's pg_hba lines: the managed replication role over TLS (only when ssl is on), then a reject for every other TCP client. */
function fenceHbaLines(ssl: boolean, owner: string): string[] {
  const tail = `${FENCE_OWNER_TAG}${owner} ${WRITE_FENCE_MARK}`;
  return [
    ...(ssl ? [`hostssl replication ${REPLICATION_ROLE} all scram-sha-256 ${tail}`] : []),
    `host replication all all reject ${tail}`,
    `host all all all reject ${tail}`,
  ];
}

/** Rewrites pg_hba.conf through a temp file with the fence's lines, naming owner, first and every older fence line dropped. Run as root. */
export function fenceHbaScript(ssl: boolean, owner: string, file = FENCE_HBA_FILE): string {
  const lines = fenceHbaLines(ssl, owner).map(l => `'${l}'`).join(' ');
  return `f=${file}; { printf '%s\\n' ${lines} && { grep -v '${WRITE_FENCE_MARK}$' "$f" || [ $? -eq 1 ]; }; } > "$f.fence" && chown postgres:postgres "$f.fence" && chmod 600 "$f.fence" && mv -f "$f.fence" "$f"`;
}

/** Removes the fence's lines from <dir>/pg_hba.conf, keeping the file postgres-owned and 600; a file with none is left as it is. Run as root. */
export function stripFenceHbaScript(dir: string): string {
  return `(f=${dir}/pg_hba.conf; [ -e "$f" ] || exit 0; grep -q '${WRITE_FENCE_MARK}$' "$f"; r=$?; [ $r -eq 1 ] && exit 0; [ $r -eq 0 ] || exit $r; sed -i '/${WRITE_FENCE_MARK}$/d' "$f" && chown postgres:postgres "$f" && chmod 600 "$f")`;
}

/** For a copy, an adopt or a flip, which reset what the data inherited: the fence's lines and the owner file both go. Run as root. */
export function stripCopiedFenceScript(dir: string): string {
  return `${stripFenceHbaScript(dir)} && rm -f ${dir}/${FENCE_OWNER_FILE}`;
}

/**
 * Removes the fence's lines from <dir>/pg_hba.conf only when every one names owner; prints "held-hba <owner>" and
 * changes nothing when a line names another lane or none. Run as root.
 */
function liftHbaScript(dir: string, owner: string): string {
  return `(f=${dir}/pg_hba.conf; [ -e "$f" ] || exit 0; grep -q '${WRITE_FENCE_MARK}$' "$f"; r=$?; [ $r -eq 1 ] && exit 0; [ $r -eq 0 ] || exit $r; if grep -v '${FENCE_OWNER_TAG}${ownerPattern(owner)} ${WRITE_FENCE_MARK}$' "$f" | grep -q '${WRITE_FENCE_MARK}$'; then echo "held-hba $(grep -o 'smdb-fence-owner=[a-z]*:[0-9]*' "$f" | head -n 1 | cut -d= -f2)"; exit 0; fi; sed -i '/${WRITE_FENCE_MARK}$/d' "$f" && chown postgres:postgres "$f" && chmod 600 "$f" && echo stripped-hba)`;
}

/** What a lift's scripts printed about a layer they left on. */
function heldFrom(stdout: string, held: FenceHeld): void {
  for (const m of stdout.matchAll(/held-(ro|hba) ?([^\s]*)/g)) {
    if (m[1] === 'ro') held.readOnly = true; else held.hba = true;
    held.holder = held.holder ?? parseFenceOwner(m[2]);
  }
}

const psqlArgs = (db: RestoreFleetDb, ...commands: string[]) => ['exec', db.containerName, 'psql', '-U', db.user, '-d', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1', ...commands.flatMap(c => ['-c', c])];
const READ_WRITE_SQL = 'SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE';
const RELOAD_SQL = 'SELECT pg_reload_conf()';

/**
 * Lift the write fence, only the layers named and only those that name owner: a layer another lane, or no lane, owns
 * stays on and is reported in held ('held' when nothing else went wrong). The pg_hba lines go first, so a lift that
 * stops after them leaves the read-only default alone and not a lockout; the read-only reset goes before its owner
 * file, so a half lift leaves an owner file over an unfenced database (the reprobe removes it), never a layer with no
 * owner. ALTER SYSTEM persists in the volume's auto.conf and the lines in its pg_hba.conf, so when the live lift fails
 * both files are stripped instead: a running database then keeps what it loaded until it restarts, which is why
 * 'stripped' is not 'lifted'.
 */
export async function liftOwnedFence(fleetDb: RestoreFleetDb, owner: string, layers: FenceLayers = BOTH_LAYERS, held: FenceHeld = noneHeld()): Promise<FenceLift> {
  // The maintenance db, not the target db: the fence is cluster-level, and
  // the lift must work while the target db is dropped mid-restore.
  const hba = layers.hba ? await execDocker(['exec', '-u', 'root', fleetDb.containerName, 'sh', '-c', liftHbaScript(FENCE_PGDATA, owner)]) : null;
  if (hba?.ok) heldFrom(hba.stdout, held);
  const reload = await execDocker(psqlArgs(fleetDb, RELOAD_SQL));
  let reset: DockerAnswer = reload;
  if (layers.readOnly) {
    const read = await readDocker(psqlArgs(fleetDb, `SELECT current_setting('default_transaction_read_only') || '|' || ${FENCE_OWNER_FILE_SQL}`));
    const m = read.ok ? /^(on|off)\|([^|\n]*)$/.exec(read.stdout.trim()) : null;
    if (!m) {
      reset = { ok: false, stdout: '', stderr: read.ok ? `the read-only layer and its owner read back as ${read.stdout.trim().slice(0, 100) || 'nothing'}` : read.stderr };
    } else if (ownerMatches(m[2], owner)) {
      reset = await execDocker(psqlArgs(fleetDb, READ_WRITE_SQL, 'ALTER SYSTEM RESET default_transaction_read_only', RELOAD_SQL));
      if (reset.ok) await dropOwnerFile(fleetDb, m[2]);
    } else {
      reset = { ok: true, stdout: '', stderr: '' };
      if (m[1] === 'on') { held.readOnly = true; held.holder = held.holder ?? parseFenceOwner(m[2]); }
    }
  }
  const settled = (): FenceLift => held.readOnly || held.hba ? 'held' : 'lifted';
  // The reset's own reload also applies the stripped pg_hba file.
  const live = reset.ok;
  const reloaded = reload.ok || reset.ok;
  if (hba?.ok !== false && live) return settled();
  // The lines are out of the file and only the reload failed, which a restart also does.
  if (hba?.ok === true && !layers.readOnly) return held.hba ? 'held' : 'stripped';
  // The strip's docker run would mint an absent volume.
  const volState = await (await import('./fleetReplica')).dockerVolumeState(fleetDb.volume);
  if (volState !== 'exists') return volState === 'absent' ? 'gone' : 'unknown';
  const file = `/pgdata/${FENCE_OWNER_FILE}`;
  const script = [
    ...(layers.readOnly ? [`if grep -qx '${ownerPattern(owner)}' ${file} 2>/dev/null; then sed -i '/^default_transaction_read_only/d' /pgdata/postgresql.auto.conf && rm -f ${file} && echo stripped-ro; elif grep -q '^default_transaction_read_only' /pgdata/postgresql.auto.conf 2>/dev/null; then echo "held-ro $(cat ${file} 2>/dev/null)"; fi`] : []),
    ...(layers.hba ? [liftHbaScript('/pgdata', owner)] : []),
  ].join(' && ');
  const strip = await execDocker(['run', '--rm', '-v', `${fleetDb.volume}:/pgdata`, '--entrypoint', 'sh', 'postgres:16-alpine', '-c', script]);
  if (!strip.ok) {
    held.detail = lastLine(strip.stderr) || 'docker did not answer';
    return hba?.ok === false ? 'locked' : hba && !reloaded ? 'unreloaded' : 'failed';
  }
  heldFrom(strip.stdout, held);
  held.fromFiles = strip.stdout.includes('stripped-');
  // Nothing of this lane's was in the files: the layers left are another lane's.
  if ((held.readOnly || held.hba) && !strip.stdout.includes('stripped-') && !live) return 'held';
  // The database answered, so a reload applies the stripped pg_hba file live.
  if (live && (await execDocker(psqlArgs(fleetDb, RELOAD_SQL))).ok) return settled();
  return 'stripped';
}

const noneHeld = (): FenceHeld => ({ readOnly: false, hba: false, holder: null });

// Owner files whose read-only layer was lifted but whose removal failed, by container: the reprobe removes them.
const staleOwnerFiles: Map<string, { db: RestoreFleetDb; owner: string }> = new Map();

/** Removes the owner file while it still names owner; one that stays is left for the reprobe. */
async function dropOwnerFile(db: RestoreFleetDb, owner: string): Promise<boolean> {
  const drop = await execDocker(['exec', '-u', 'root', db.containerName, 'sh', '-c', dropOwnerFileScript(owner)]);
  if (drop.ok) staleOwnerFiles.delete(db.containerName);
  else staleOwnerFiles.set(db.containerName, { db, owner });
  return drop.ok;
}

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** What a lane does about a layer this owner holds. */
function holderRemedy(owner: string | null): string {
  const lane = fenceOwnerLane(owner);
  if (!lane) return `if nothing should hold it, lift it by hand (ALTER SYSTEM RESET default_transaction_read_only, then SELECT pg_reload_conf(); remove the lines ending in ${WRITE_FENCE_MARK} from pg_hba.conf)`;
  if (lane === 'swap') return 'disarming the recovery channel on its Database modal lifts it';
  if (lane === 'failback' || lane === 'dropback') return 'that run\'s exits on its Database modal lift it, and a new run of that lane takes it over';
  return 'running that lane again lifts it';
}

/** The layers a lift left on for their owner, as a clause: what the database is, whose they are, and who lifts them. */
export function heldText(held: FenceHeld, lane: string): string {
  const both = held.readOnly && held.hba;
  const what = both ? 'both layers' : held.readOnly ? 'the read-only layer' : 'the pg_hba lines';
  return `${fencedState(held, 'the database')}: ${what} of the write fence ${both || held.hba && !held.readOnly ? 'belong' : 'belongs'} to ${fenceOwnerText(held.holder)}, so ${lane} left ${both || !held.readOnly ? 'them' : 'it'} on; ${holderRemedy(held.holder)}`;
}

/** What a database is under the fence layers found on it. */
function fencedState(layers: FenceLayers, subject: string): string {
  return layers.hba
    ? `${subject} refuses every connection but the manager's${layers.readOnly ? ' and is READ-ONLY' : ''}, so the bot cannot reach it`
    : `${subject} is READ-ONLY`;
}

/** The stuck-fence warning for a lift that did not land. */
function stuckLiftText(result: FenceLift, lane: string, volume: string, failedRemedy: string): string {
  return result === 'stripped'
    ? `The database is READ-ONLY, and may still refuse the bot's connections, until it restarts (${lane} write fence could not be lifted live); restart the instance to clear it`
    : result === 'unknown'
    ? `This manager can't confirm whether the database is still READ-ONLY or refusing the bot's connections (${lane} write fence could not be lifted live, and docker did not answer whether the volume ${volume} exists); ${failedRemedy}`
    : result === 'locked'
    ? `The database refuses every connection but the manager's, so the bot cannot reach it (the pg_hba lines of ${lane} write fence could not be removed, and a restart keeps them); ${failedRemedy}`
    : result === 'unreloaded'
    ? `The database is READ-ONLY (${lane} write fence could not be lifted or stripped), and it may still refuse the bot's connections until it reloads or restarts (the fence's pg_hba lines are out of pg_hba.conf, but the reload failed); ${failedRemedy}`
    : `The database is READ-ONLY (${lane} write fence could not be lifted or stripped); ${failedRemedy}`;
}

/** Lift and keep the per-bot stuck-fence warning truthful. A restart only
 * clears a STRIPPED fence; a 'failed', 'unreloaded' or 'locked' one survives in the volume's
 * files and would be re-applied by the restart, so its remedy is a retried lift instead. */
async function liftAndTrack(botId: string, fleetDb: RestoreFleetDb, owner: string, lane = 'a restore', failedRemedy = 'running the restore again retries the lift', layers: FenceLayers = BOTH_LAYERS, held: FenceHeld = noneHeld()): Promise<FenceLift> {
  const failback = lane === 'a failback';
  const result = await liftOwnedFence(fleetDb, owner, layers, held);
  if (result === 'lifted' || result === 'gone') {
    clearStuck(botId, fleetDb.containerName);
    recordFailbackFence(botId, fleetDb.containerName, null);
    return result;
  }
  if (result === 'held') {
    recordFailbackFence(botId, fleetDb.containerName, null);
    setStuck(botId, fleetDb, capitalized(heldText(held, lane)));
    return result;
  }
  // A run stopped mid-lift is covered by its own run record (fence.owned), so this is saved only once the lift did not land.
  recordFailbackFence(botId, fleetDb.containerName, failback ? owner : null);
  const heldNote = held.readOnly || held.hba ? `; and ${heldText(held, lane)}` : '';
  setStuck(botId, fleetDb, stuckLiftText(result, lane, fleetDb.volume, failedRemedy) + heldNote);
  return result;
}

const fenceSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Polls a TCP login from inside the container until the reloaded pg_hba refuses it; false when it never does by the deadline. */
async function rejectInForce(db: RestoreFleetDb): Promise<boolean> {
  const until = Date.now() + fenceTiming.probeDeadlineMs;
  for (;;) {
    const probe = await readDocker(['exec', db.containerName, 'psql', '-h', '127.0.0.1', '-U', db.user, '-d', 'postgres', '-w', '-tAc', 'SELECT 1']);
    if (!probe.ok && probe.stderr.includes('pg_hba.conf rejects connection')) return true;
    if (Date.now() >= until) return false;
    await fenceSleep(fenceTiming.probeGapMs);
  }
}

/** Ends every client session and every walsender but the managed role's physical ones; the reason when one did not end, else null. */
async function sweepSessions(db: RestoreFleetDb): Promise<string | null> {
  const sweep = await execDocker(psqlArgs(db, `SELECT pid, pg_terminate_backend(pid, 5000) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND (backend_type = 'client backend' OR (backend_type = 'walsender' AND NOT (usename IS NOT DISTINCT FROM '${REPLICATION_ROLE}' AND datname IS NULL)))`));
  if (!sweep.ok) return `the open sessions could not be ended (${lastLine(sweep.stderr)})`;
  const kept = sweep.stdout.split('\n').map(l => l.trim().split('|')).filter(([pid, ended]) => /^\d+$/.test(pid) && ended !== 't').map(([pid]) => pid);
  if (kept.length === 0) return null;
  // A session that ended between the listing and its terminate also answers false.
  const left = await readDocker(psqlArgs(db, `SELECT count(*) FROM pg_stat_activity WHERE pid IN (${kept.join(', ')})`));
  if (left.ok && left.stdout.trim() === '0') return null;
  return `${kept.length} open session(s) did not end within 5 s of being terminated${left.ok ? '' : ' and whether they ended since could not be read'}`;
}

/**
 * The write fence every lane that dumps before a destroy uses, the consent park and the recovery quiesce too: the
 * read-only default, then pg_hba lines that refuse every TCP connection but the managed role's replication, then
 * every other session ended, and once more after authentication_timeout (a login accepted before the reload can
 * finish under the old rules). A session that sets READ WRITE itself passes the default; it cannot pass the lines.
 * Each layer the fence sets names owner (the owner file before the read-only default, the line comments); a layer
 * already on is taken over only as takeOver allows, and one it does not take stays as it is, its owner's to lift.
 * changed: false when it refused before it changed the database; the caller says what it changed before the fence.
 * owned: the layers this fence named its own.
 */
export async function applyWriteFence(fleetDb: RestoreFleetDb, owner: string, takeOver: FenceTakeOver): Promise<DockerAnswer & { changed: boolean; owned: FenceLayers }> {
  const owned: FenceLayers = { ...NO_LAYERS };
  const refusedBefore = (reason: string) => ({ ok: false, stdout: '', stderr: reason, changed: false, owned });
  const refused = (reason: string) => ({ ok: false, stdout: '', stderr: reason, changed: true, owned });
  const read = await readDocker(psqlArgs(fleetDb,
    `SELECT current_setting('hba_file') || '|' || current_setting('ssl') || '|' || (SELECT setting FROM pg_settings WHERE name = 'authentication_timeout') || '|' || (SELECT count(*) FROM pg_subscription WHERE subenabled) || '|' || current_setting('default_transaction_read_only') || '|' || ${FENCE_OWNER_FILE_SQL} || '|' || (${FENCE_HBA_COUNT_SQL}) || '|' || (${FENCE_HBA_OWNER_SQL})`));
  if (!read.ok) return refusedBefore(`the database's settings could not be read before the fence (${lastLine(read.stderr)})`);
  const fields = read.stdout.trim().split('|');
  const [hbaFile, ssl, authTimeout, subscriptions, readOnlyNow, fileOwner, hbaCount, hbaOwners] = fields;
  if (fields.length !== 8 || !/^\d+$/.test(authTimeout ?? '') || !/^\d+$/.test(subscriptions ?? '') || !/^(on|off)$/.test(ssl ?? '')
    || !/^(on|off)$/.test(readOnlyNow ?? '') || !/^\d+$/.test(hbaCount ?? '')) {
    return refusedBefore(`the database's settings read back in an unknown form (${read.stdout.trim().slice(0, 200) || 'empty'})`);
  }
  if (hbaFile !== FENCE_HBA_FILE) return refusedBefore(`the database reads its pg_hba from ${hbaFile || 'an unnamed file'}, not ${FENCE_HBA_FILE}, so the fence could not refuse outside connections`);
  if (Number(subscriptions) > 0) return refusedBefore(`the database has ${subscriptions} enabled subscription(s), whose workers write past the fence; disable them (ALTER SUBSCRIPTION ... DISABLE) and retry`);
  const mayTake = (found: string | null): boolean => takeOver === 'any'
    || (found !== null && (found === owner || fenceOwnerLane(found) === fenceOwnerLane(owner)
      || (takeOver === 'run' && RUN_LANES.includes(fenceOwnerLane(found)))));
  const setReadOnly = readOnlyNow === 'off' || mayTake(parseFenceOwner(fileOwner));
  const setHba = hbaCount === '0' || mayTake(parseFenceOwner(hbaOwners));
  if (setReadOnly) {
    // Before the setting: a read-only layer is never on with this lane's work under it and no owner named.
    owned.readOnly = true;
    const file = await execDocker(['exec', '-u', 'root', fleetDb.containerName, 'sh', '-c', fenceOwnerFileScript(owner)]);
    if (!file.ok) return refused(`the fence's owner file could not be written (${lastLine(file.stderr)})`);
    // ON_ERROR_STOP so a failed ALTER SYSTEM cannot read as a fence.
    const readOnly = await execDocker(psqlArgs(fleetDb, READ_WRITE_SQL, 'ALTER SYSTEM SET default_transaction_read_only = on', RELOAD_SQL));
    if (!readOnly.ok) return { ...readOnly, changed: true, owned };
  }
  if (setHba) {
    owned.hba = true;
    const hba = await execDocker(['exec', '-u', 'root', fleetDb.containerName, 'sh', '-c', fenceHbaScript(ssl === 'on', owner)]);
    if (!hba.ok) return refused(`pg_hba.conf could not be rewritten (${lastLine(hba.stderr)})`);
  }
  const reload = await execDocker(psqlArgs(fleetDb, RELOAD_SQL));
  if (!reload.ok) return refused(`the rewritten pg_hba.conf could not be reloaded (${lastLine(reload.stderr)})`);
  if (!await rejectInForce(fleetDb)) return refused(`the database still did not refuse a TCP connection ${fenceTiming.probeDeadlineMs / 1000} s after the reload of its rewritten pg_hba.conf`);
  const first = await sweepSessions(fleetDb);
  if (first) return refused(first);
  await fenceSleep(Number(authTimeout) * 1000);
  const second = await sweepSessions(fleetDb);
  if (second) return refused(second);
  return { ok: true, stdout: '', stderr: '', changed: true, owned };
}

/** The database a failback or drop-back run parks on for the operator's consent. */
export type ConsentFenceTarget = RestoreFleetDb;

/**
 * Fence the database a failback or drop-back run parks on for consent
 * (B7-O19): a client bypassing the bot cannot land rows the dump and the
 * verdict never saw, which the wipe would then destroy. The park takes over
 * only a layer an earlier run of its own lane left.
 */
export async function fenceForConsent(target: ConsentFenceTarget, owner: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const fence = await applyWriteFence(target, owner, 'lane');
  return fence.ok ? { ok: true } : { ok: false, error: fence.stderr.trim().split('\n').pop() || 'unknown reason' };
}

/** Lift the layers of a consent fence the run owns; one that sticks is named on the instance, on the database it sits on, as the restore's is. */
export function liftConsentFence(botId: string, target: ConsentFenceTarget, owner: string, failedRemedy: string, layers: FenceLayers = BOTH_LAYERS, held: FenceHeld = noneHeld()): Promise<FenceLift> {
  return liftAndTrack(botId, target, owner, 'a failback', failedRemedy, layers, held);
}

function liftNote(result: FenceLift, volume: string, remedy = 'running a restore again retries the lift', held: FenceHeld = noneHeld(), lane = 'this lane'): string {
  const heldNote = held.readOnly || held.hba ? `; ${heldText(held, lane)}` : '';
  return result === 'lifted' ? ''
    : result === 'held' ? heldNote
    : result === 'gone' ? `; the database volume ${volume} is gone, so no write fence remains on it`
    : `${result === 'unknown' ? `; the write fence could not be lifted live, and docker did not answer whether the database volume ${volume} exists, so this manager can't confirm whether the database is still READ-ONLY or refusing the bot's connections (${remedy})`
    : result === 'stripped' ? '; the write fence could not be lifted live, so the database is READ-ONLY, and may still refuse the bot\'s connections, until its container restarts'
    : result === 'locked' ? `; the pg_hba lines of the write fence could not be removed, so the database refuses every connection but the manager's and the bot cannot reach it, through a restart too (${remedy})`
    : result === 'unreloaded' ? `; the write fence could not be lifted, so the database stays READ-ONLY, and it may still refuse the bot's connections until it reloads or restarts (${remedy})`
    : `; the write fence could not be lifted, so the database stays READ-ONLY (${remedy})`}${heldNote}`;
}

/**
 * The safety dump a lane that destroys the database takes first (the B7-O19 order): the write fence, then the dump
 * under it, so the dump holds every write the destroy removes. A failed fence or dump lifts the fence and refuses.
 * The caller has stopped the writers it can see and brought the database up alone. The fence takes over any layer
 * (the lane destroys the data), named owner, which the caller passes to liftLaneFence.
 */
export async function fencedSafetyDump(instance: InstanceConfig, prefix: string, lane: string, remedy: string, owner: string): Promise<{ success: true; file: string } | { success: false; error: string }> {
  const fleetDb = instance.fleetDb;
  if (!fleetDb) return { success: false, error: 'No fleet database record' };
  const fence = await applyWriteFence(fleetDb, owner, 'any');
  if (!fence.changed) return { success: false, error: `the write fence could not be applied (${lastLine(fence.stderr)}), so no dump was taken` };
  foreignFenceSet(instance.id, fleetDb.containerName);
  if (!fence.ok) {
    const held = noneHeld();
    const lifted = await liftAndTrack(instance.id, fleetDb, owner, lane, remedy, BOTH_LAYERS, held);
    return { success: false, error: `the write fence could not be applied (${lastLine(fence.stderr)}), so no dump was taken${liftNote(lifted, fleetDb.volume, remedy, held, lane)}` };
  }
  const dump = await runFleetDump(instance, prefix);
  if (dump.success && dump.file) return { success: true, file: dump.file };
  const held = noneHeld();
  const lifted = await liftAndTrack(instance.id, fleetDb, owner, lane, remedy, BOTH_LAYERS, held);
  return { success: false, error: `${dump.error || 'unknown reason'}${liftNote(lifted, fleetDb.volume, remedy, held, lane)}` };
}

/** Lift a lane's fence, the layers that name owner, from a database its destroy left standing; the text names a fence left on. */
export async function liftLaneFence(botId: string, fleetDb: RestoreFleetDb, owner: string, lane: string, remedy: string): Promise<string> {
  const held = noneHeld();
  return liftNote(await liftAndTrack(botId, fleetDb, owner, lane, remedy, BOTH_LAYERS, held), fleetDb.volume, remedy, held, lane);
}

/** The owner a failback or drop-back run on this instance left its fence under on this database (the persisted record, or this process's when its save was refused); null when none. */
export function failbackFenceOwner(botId: string, containerName: string): string | null {
  const key = fenceKey(botId, containerName);
  const held = stuckByFailback.get(key);
  if (held) return held;
  if (clearPending.has(key)) return null;
  return (containerManager.getBot(botId)?.fleetConsentFenceLeft ?? []).find(e => e.containerName === containerName)?.owner ?? null;
}

export function failbackFenceLeft(botId: string, containerName: string): boolean {
  return failbackFenceOwner(botId, containerName) !== null;
}

/**
 * A lane that takes over any layer set its write fence on this database, so a failback's stuck one under it is now
 * that lane's to lift: the record goes, and a refused save is held here until its clear lands.
 */
export function foreignFenceSet(botId: string, containerName: string): void {
  if (failbackFenceLeft(botId, containerName)) recordFailbackFence(botId, containerName, null);
}

/** Which layers of the write fence the database holds now and whose they are; null when it cannot be asked. */
export async function fenceLayers(target: ConsentFenceTarget): Promise<FenceState | null> {
  const probe = await readDocker(['exec', target.containerName, 'psql', '-U', target.user, '-d', 'postgres', '-tA', '-c',
    `SELECT current_setting('default_transaction_read_only') || '|' || (${FENCE_HBA_COUNT_SQL}) || '|' || ${FENCE_OWNER_FILE_SQL} || '|' || (${FENCE_HBA_OWNER_SQL})`]);
  const m = probe.ok ? /^(on|off)\|(\d+)\|([^|\n]*)\|([^|\n]*)$/.exec(probe.stdout.trim()) : null;
  if (!m) return null;
  const readOnly = m[1] === 'on';
  const hba = Number(m[2]) > 0;
  return { readOnly, hba, readOnlyOwner: readOnly ? parseFenceOwner(m[3]) : null, hbaOwner: hba ? parseFenceOwner(m[4]) : null, ownerFile: m[3] };
}

const anyLayer = (layers: FenceState | null): layers is FenceState => layers !== null && (layers.readOnly || layers.hba);
const noLayer = (layers: FenceLayers | null): boolean => layers !== null && !layers.readOnly && !layers.hba;

/** Who owns the layers on: one owner, or each layer's when they differ. */
function ownersText(layers: FenceState): string {
  if (layers.readOnly && layers.hba && layers.readOnlyOwner !== layers.hbaOwner) {
    return `the read-only layer belongs to ${fenceOwnerText(layers.readOnlyOwner)} and the pg_hba lines to ${fenceOwnerText(layers.hbaOwner)}`;
  }
  return `it belongs to ${fenceOwnerText(layers.readOnly ? layers.readOnlyOwner : layers.hbaOwner)}`;
}

/** The Start warning while the fence's pg_hba lines stand on the instance's database; null when they do not or cannot be read. */
export async function fenceStartWarning(botId: string): Promise<string | null> {
  const db = containerManager.getBot(botId)?.fleetDb;
  const layers = db ? await fenceLayers(db) : null;
  if (!layers?.hba) return null;
  return `${fencedState(layers, 'The database')}: the pg_hba lines of a write fence (ending in ${WRITE_FENCE_MARK}) are still on it, and a restart keeps them; ${ownersText(layers)}, and ${holderRemedy(layers.hbaOwner)}`;
}

/**
 * Seed the stuck-fence warnings from OBSERVED live state at scheduler start,
 * so a manager restart does not silently forget a database a failed lift left
 * read-only. One probe per fleet-database host, once.
 */
async function seedStuckFences(): Promise<void> {
  for (const instance of containerManager.getAllBots()) {
    // A failback record whose fence no layer names any more is stale, and must not claim a later lane's fence.
    for (const { containerName } of instance.fleetConsentFenceLeft ?? []) await checkFailbackRecord(instance.id, containerName);
    // A parked failback's fence is the run's own, named by its consent; it sits on the run's database only.
    const parked = instance.fleetFailback?.fence?.ok === true ? instance.fleetFailback.mode : null;
    // A copy carries no fence of its own (its seed strips the setting), so one
    // reading 'on' is a drop-back's, a promote's or a swap's that was never lifted.
    const copy = instance.fleetDbReplica;
    if (parked !== 'drop-back' && copy?.user && !isStuck(instance.id, copy.containerName) && await isContainerRunning(copy.containerName)) {
      const copyDb = { containerName: copy.containerName, user: copy.user, db: copy.db ?? 'postgres', volume: copy.volume };
      const onCopy = await fenceLayers(copyDb);
      await dropStaleOwner(instance.id, copyDb, onCopy);
      if (anyLayer(onCopy)) {
        const recovery = await readDocker(['exec', copy.containerName, 'psql', '-U', copy.user, '-d', 'postgres', '-tA', '-c', 'SELECT pg_is_in_recovery()']);
        const inRecovery = recovery.ok ? recovery.stdout.trim() : '';
        const remedy = inRecovery === 't' ? 're-seeding this copy on its Database modal clears it'
          : inRecovery === 'f' ? `this copy is promoted and the Database modal does not re-seed a promoted copy, so lift it by hand (remove the lines ending in ${WRITE_FENCE_MARK} from pg_hba.conf, ALTER SYSTEM RESET default_transaction_read_only, then SELECT pg_reload_conf(), and remove the file ${FENCE_OWNER_FILE} from the data directory) or let a drop-back run re-seed it`
            : 'whether this copy is still a standby could not be read: re-seeding on its Database modal clears a standby, and a promoted copy is lifted only by hand';
        setStuck(instance.id, copyDb, `${fencedState(onCopy, 'The copy')}: a write fence is on (${ownersText(onCopy)}); ${remedy}`);
      }
    }
    const db = instance.fleetDb;
    if (parked === 'failback' || !db || isStuck(instance.id, db.containerName)) continue;
    if (!await isContainerRunning(db.containerName)) continue;
    const layers = await fenceLayers(db);
    await dropStaleOwner(instance.id, db, layers);
    if (anyLayer(layers)) setStuck(instance.id, db, `${fencedState(layers, 'The database')} (a write fence was not lifted); ${await seededFenceRemedy(instance, db, layers)}`);
  }
}

/** Whether the fence setting is saved in postgresql.auto.conf, so a restart re-applies it; null when that cannot be read. */
async function fencePersisted(db: RestoreFleetDb): Promise<boolean | null> {
  const read = await readDocker(['exec', db.containerName, 'psql', '-U', db.user, '-d', 'postgres', '-tA', '-c', "SELECT count(*) FROM pg_file_settings WHERE name = 'default_transaction_read_only'"]);
  const text = read.ok ? read.stdout.trim() : '';
  return /^\d+$/.test(text) ? Number(text) > 0 : null;
}

/** The remedy for a fence found on at start, from the owners its layers name and whether a restart clears it. */
async function seededFenceRemedy(instance: InstanceConfig, db: RestoreFleetDb, layers: FenceState): Promise<string> {
  const owners = [layers.readOnly ? layers.readOnlyOwner : undefined, layers.hba ? layers.hbaOwner : undefined].filter((o): o is string | null => o !== undefined);
  const remedies = Array.from(new Set(owners.map(owner => {
    const lane = fenceOwnerLane(owner);
    // A restore takes over any layer, so it also lifts one no lane owns.
    if (lane === 'restore' || !lane) return restoreRetryRemedy(instance);
    if ((lane === 'failback' || lane === 'dropback') && instance.fleetFailback && newFenceOwner(lane, instance.fleetFailback.startedAt) === owner) {
      return `the ${instance.fleetFailback.mode} run on this instance owns it, and the run's exits on its Database modal lift it`;
    }
    return holderRemedy(owner);
  })));
  const lane = `${ownersText(layers)}, and ${remedies.join('; ')}`;
  if (layers.hba) return `its pg_hba lines are saved in pg_hba.conf, so a restart keeps it on; ${lane}`;
  const persisted = await fencePersisted(db);
  if (persisted === false) return `the setting is not saved in its configuration, so restarting the instance clears it; ${lane}`;
  if (persisted === true) return `the setting is saved in its configuration, so a restart keeps it on; ${lane}`;
  return `whether a restart clears it could not be confirmed (its saved configuration could not be read); ${lane}`;
}

/** A lane may be between writing an owner file and setting its layer on this instance's databases. */
function laneMayBeFencing(botId: string): boolean {
  return busy.has(botId) || containerManager.isBotBusy(botId) !== null || !!containerManager.getBot(botId)?.fleetFailback;
}

/** An owner file over a database that reads not read-only is stale: it goes, unless a lane may be fencing right now. */
async function dropStaleOwner(botId: string, db: RestoreFleetDb, layers: FenceState | null): Promise<void> {
  if (!layers || layers.readOnly || laneMayBeFencing(botId)) return;
  const owner = parseFenceOwner(layers.ownerFile);
  if (owner) await dropOwnerFile(db, owner);
  else if (!layers.ownerFile) staleOwnerFiles.delete(db.containerName);
}

/** Clear a failback record whose database is gone, or whose layers no longer name its owner; one that cannot be asked is kept for the next check. */
async function checkFailbackRecord(botId: string, containerName: string): Promise<void> {
  const instance = containerManager.getBot(botId);
  const db = instance ? [instance.fleetDb, instance.fleetDbReplica].find(d => d?.containerName === containerName) : undefined;
  if (!db?.user) { recordFailbackFence(botId, containerName, null); return; }
  const target = { containerName, user: db.user, db: db.db ?? 'postgres', volume: db.volume };
  const layers = await isContainerRunning(containerName) ? await fenceLayers(target) : null;
  if (!layers) return;
  const owner = failbackFenceOwner(botId, containerName);
  if (layers.readOnlyOwner !== owner && layers.hbaOwner !== owner) recordFailbackFence(botId, containerName, null);
}

/**
 * Self-heal the stuck-fence warning: once the operator restarts the container
 * (the stripped auto.conf comes up clean) the live state is writable again and
 * the warning must go. Cheap - runs only while an entry exists.
 */
async function reprobeStuckFences(): Promise<void> {
  for (const { botId, containerName } of Array.from(clearPending.values())) recordFailbackFence(botId, containerName, null);
  // Every record, not only the database the instance's one warning names: a stale one must not claim a later lane's fence.
  const records = new Set(stuckByFailback.keys());
  for (const instance of containerManager.getAllBots()) {
    for (const { containerName } of instance.fleetConsentFenceLeft ?? []) {
      const key = fenceKey(instance.id, containerName);
      if (!clearPending.has(key)) records.add(key);
    }
  }
  for (const key of records) {
    const [botId, containerName] = JSON.parse(key) as [string, string];
    await checkFailbackRecord(botId, containerName);
  }
  for (const [containerName, { db }] of Array.from(staleOwnerFiles.entries())) {
    const instance = containerManager.getAllBots().find(b => b.fleetDb?.containerName === containerName || b.fleetDbReplica?.containerName === containerName);
    if (!instance) { staleOwnerFiles.delete(containerName); continue; }
    if (!await isContainerRunning(containerName)) continue;
    const layers = await fenceLayers(db);
    // Read-only again: a lane fenced since, and the file is its owner now.
    if (layers?.readOnly) staleOwnerFiles.delete(containerName);
    else await dropStaleOwner(instance.id, db, layers);
  }
  for (const [id, entries] of Array.from(fenceStuck.entries())) {
    const instance = containerManager.getBot(id);
    if (!instance) { fenceStuck.delete(id); continue; }
    for (const { db } of Array.from(entries.values())) {
      // A database the instance no longer records is gone, and its warning with it.
      if (instance.fleetDb?.containerName !== db.containerName && instance.fleetDbReplica?.containerName !== db.containerName) { clearStuck(id, db.containerName); continue; }
      if (!await isContainerRunning(db.containerName)) continue;
      const layers = await fenceLayers(db);
      await dropStaleOwner(id, db, layers);
      if (noLayer(layers)) { clearStuck(id, db.containerName); recordFailbackFence(id, db.containerName, null); }
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
      const error = scrubbed(instance.id, result.error || 'unknown error');
      lastErrors.set(instance.id, error);
      console.error(`[FleetBackup] Dump failed for ${instance.displayName} (${instance.id}): ${error}`);
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
  const probe = await readDocker(['exec', rec.containerName, 'psql', '-U', rec.user, '-d', rec.db, '-Atc', 'SELECT pg_is_in_recovery()']);
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
      const why = scrubbed(instance.id, role.error);
      copyErrors.set(instance.id, `could not read whether this copy takes writes (${why}), so no scheduled dump of it ran`);
      console.error(`[FleetBackup] Could not read the role of the copy for ${instance.displayName} (${instance.id}): ${why}`);
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
      const error = scrubbed(instance.id, result.error || 'unknown error');
      copyErrors.set(instance.id, error);
      console.error(`[FleetBackup] Dump of the copy failed for ${instance.displayName} (${instance.id}): ${error}`);
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

/** The lane that holds this instance's database against a restore: the refusal, and the step that clears it; null when none does. */
function restoreAdmissionBlock(instance: InstanceConfig): { refusal: string; step: string } | null {
  if (instance.recoveryRescue) return { refusal: 'A database rescue is recorded on this instance; finish or cancel it before restoring a dump', step: 'finish or cancel the database rescue' };
  if (instance.recoveryChannel) return { refusal: `The recovery channel is armed on this instance (${instance.recoveryChannel.mode}); disarm it before restoring a dump`, step: `disarm the recovery channel (${instance.recoveryChannel.mode})` };
  if (instance.fleetFailback) return { refusal: `A ${instance.fleetFailback.mode} run is recorded on this instance (${instance.fleetFailback.phase}); Continue, Cancel or Dismiss it on the Database modal before restoring a dump`, step: `Continue, Cancel or Dismiss the ${instance.fleetFailback.mode} run on the Database modal` };
  if (instance.fleetTransfer) return { refusal: `A database transfer is recorded on this instance (${instance.fleetTransfer.phase}); let it finish or cancel it before restoring a dump`, step: 'let the database transfer finish or cancel it' };
  const seed = fleetReplica.seedView(instance);
  if (seed && seed.parked !== true) return { refusal: 'A standby seed is running on this instance; wait for it before restoring a dump', step: 'wait for the standby seed to finish' };
  return null;
}

/** Why a restore must not start while another lane holds this instance's database; null when none does. */
function restoreAdmissionRefusal(instance: InstanceConfig): string | null {
  return restoreAdmissionBlock(instance)?.refusal ?? null;
}

/** A restore retry as a fence remedy, after the step a restore would first refuse on. */
function restoreRetryRemedy(instance: InstanceConfig): string {
  const block = restoreAdmissionBlock(instance);
  return block ? `${block.step}, then run a restore again to retry the lift` : 'running a restore again retries the lift';
}

/**
 * The highest term the live database holds, from its control row and its guild leases: every lease token in
 * circulation carries a term at or below it. Null when neither table exists; an error when the probe failed.
 */
export async function probeLiveTerm(fleetDb: RestoreFleetDb): Promise<{ ok: true; term: number | null } | { ok: false; error: string }> {
  const psql = (sql: string) => readDocker(['exec', fleetDb.containerName, 'psql', '-U', fleetDb.user, '-d', fleetDb.db, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
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

/** Stops the named containers of an instance and asks docker again: null when none runs, else what is left or unknown. */
async function stopListedContainers(botId: string, names: string[]): Promise<string | null> {
  for (const name of names) {
    const stop = await execDocker(['stop', name]);
    if (!stop.ok) console.warn(`[FleetBackup] Could not stop ${name}: ${scrubbed(botId, lastLine(stop.stderr))}`);
  }
  const after = await containerManager.runningInstanceContainers(botId);
  if (after === null) return "docker did not answer after the stop, so the manager can't confirm they stopped";
  return after.length > 0 ? `docker still runs ${after.join(', ')} after the stop` : null;
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
 * stopped instances restarted. A failure past the drop keeps the fence on and the instances stopped. docker's stderr
 * can quote the database URL, so the answer passes the secret filter, as do the notices and logs built from stderr.
 */
export async function restoreFleetBackup(
  botId: string,
  file: string
): Promise<{ success: boolean; error?: string; warning?: string; steps: RestoreSteps }> {
  const result = await runFleetRestore(botId, file);
  return {
    ...result,
    ...(result.error !== undefined ? { error: scrubbed(botId, result.error) } : {}),
    ...(result.warning !== undefined ? { warning: scrubbed(botId, result.warning) } : {}),
  };
}

async function runFleetRestore(
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
  // The restore takes over any layer on the database (it replaces the data) and names itself on each.
  const owner = newFenceOwner('restore');
  // A layer another lane set after this fence, which the lifts leave on.
  const layersHeld = noneHeld();
  // The answer names the state after the second attempt, so the finally has no lift left to change it.
  const finalLift = async (): Promise<FenceLift> => {
    let result = await liftAndTrack(botId, fleetDb, owner, 'a restore', 'running the restore again retries the lift', BOTH_LAYERS, layersHeld);
    if (result !== 'lifted' && result !== 'held') {
      const retry = await liftAndTrack(botId, fleetDb, owner, 'a restore', 'running the restore again retries the lift', BOTH_LAYERS, layersHeld);
      // A strip that landed stays in the file, so a failed second strip does not undo it.
      const keeps: FenceLift[] = result === 'stripped' ? ['failed', 'unreloaded', 'locked', 'unknown']
        : result === 'unreloaded' ? ['failed', 'locked', 'unknown'] : [];
      if (keeps.includes(retry)) setStuck(botId, fleetDb, stuckLiftText(result, 'a restore', fleetDb.volume, 'running the restore again retries the lift'));
      else result = retry;
    }
    fenced = false;
    return result;
  };

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
      if (!stop.ok) console.error(`[FleetBackup] Could not stop the database the refused restore started for ${botId}: ${scrubbed(botId, lastLine(stop.stderr))}`);
    }
    return unstarted.length > 0
      ? `; these instances were stopped and could not be restarted: ${unstarted.join(', ')} (start them by hand)`
      : '';
  };

  // Past the drop the database may be missing or partial: the read-only layer stays on and the stopped instances stay
  // down. The pg_hba layer goes, so the database is not left refusing every connection for as long as nobody restores.
  const keepFenced = async (reason: string, guards = 'a database that may be missing or partial', runningNow: string[] = []) => {
    fenced = false;
    release();
    const opened = await liftOwnedFence(fleetDb, owner, { readOnly: false, hba: true }, layersHeld);
    const access = opened === 'lifted' ? '; the database is READ-ONLY and no longer refuses connections'
      : opened === 'held' ? `; the database is READ-ONLY, and ${heldText(layersHeld, 'the restore')}`
      : opened === 'stripped' || opened === 'failed' ? '; the database is READ-ONLY, and its pg_hba lines are removed from pg_hba.conf, but the running database may still refuse the bot\'s connections until it restarts'
      : opened === 'locked' ? '; the database is READ-ONLY, and its pg_hba lines could not be removed, so it also refuses every connection but the manager\'s, through a restart too'
      : opened === 'gone' ? `; the database volume ${fleetDb.volume} is gone`
      : `; the database is READ-ONLY, and docker did not answer whether the database volume ${fleetDb.volume} exists, so this manager can't confirm whether it still refuses the bot's connections`;
    const stillStopped = steps.stopped.filter(id => !runningNow.includes(id));
    const runs = runningNow.length > 0 ? `${runningNow.map(nameOf).join(', ')} runs now. ` : '';
    const kept = stillStopped.length > 0
      ? ` and the stopped instances stay stopped (${stillStopped.map(nameOf).join(', ')})`
      : steps.stopped.length > 0 ? '' : ' and the stopped instances stay stopped (none were running)';
    const back = steps.preRestoreDump
      ? `the pre-restore dump ${steps.preRestoreDump} holds the database as it was`
      : 'no pre-restore dump was taken, because the database was missing';
    setStuck(botId, fleetDb, `The database is READ-ONLY: a restore of ${file} failed (${reason}), so its write fence stays on${access}; restore a dump again (${back})`);
    return `${reason}. ${runs}The write fence stays on${kept}, so nothing writes to ${guards}${access}; restore a dump again: ${back}`;
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
      if (!stop.success && stop.error === 'Bot is not running') {
        // The record says stopped while docker runs it: the containers docker named are stopped by name.
        const left = await stopListedContainers(b.id, live);
        steps.stopped.push(b.id);
        if (left !== null) {
          const note = await undo();
          return { success: false, error: `Could not stop instance ${b.displayName}: its record says stopped while docker ran ${live.join(', ')}, and ${left}; the restore was refused${note}`, steps };
        }
        continue;
      }
      if (!stop.success) {
        const note = await undo();
        return { success: false, error: `Could not stop instance ${b.displayName}: ${stop.error}${note}`, steps };
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
    const fence = await applyWriteFence(fleetDb, owner, 'any');
    if (!fence.changed) {
      fenced = false;
      const note = await undo();
      return { success: false, error: `Could not fence the database for the restore: ${lastLine(fence.stderr)}${note}`, steps };
    }
    foreignFenceSet(botId, fleetDb.containerName);
    if (!fence.ok) {
      // A half-applied fence must not survive the refusal. Only a LIVE lift
      // clears it; 'stripped' cleans the persisted copy alone, so the operator
      // must hear about the read-only risk.
      const cleared = await finalLift();
      const note = await undo();
      const fenceWarning = cleared === 'lifted' ? ''
        : cleared === 'gone' || cleared === 'unknown' || cleared === 'held' ? liftNote(cleared, fleetDb.volume, undefined, layersHeld, 'the restore')
        : cleared === 'stripped' ? '; the database may be READ-ONLY, and may still refuse the bot\'s connections, until its container restarts'
        : cleared === 'locked' ? '; the database may refuse every connection but the manager\'s, so the bot cannot reach it (pg_hba lines that could not be removed survive a restart; running a restore again retries the lift)'
        : cleared === 'unreloaded' ? '; the database may stay READ-ONLY (a fence that could not be lifted or stripped survives a restart; running a restore again retries the lift), and it may refuse the bot\'s connections until it reloads or restarts'
          : '; the database may stay READ-ONLY (a fence that could not be lifted or stripped survives a restart; running a restore again retries the lift)';
      return { success: false, error: `Could not fence the database for the restore: ${lastLine(fence.stderr)}${fenceWarning}${note}`, steps };
    }

    // A refusal past the fence lifts it and brings back what was stopped; only then has it changed nothing.
    const refuse = async (refused: string, detail: string) => {
      const cleared = await finalLift();
      const note = await undo();
      return { success: false, error: `${refused}${note ? '' : ', and nothing was changed'}: ${detail}${liftNote(cleared, fleetDb.volume, undefined, layersHeld, 'the restore')}${note}`, steps };
    };

    // 4. Pre-restore safety dump UNDER the fence, so it holds every write the
    // drop below removes. A MISSING database (a prior recreate failure) has
    // no data to protect and dumping it would refuse every retry, so
    // existence is probed first; an unanswerable probe still refuses.
    const exists = await readDocker(['exec', fleetDb.containerName, 'psql', '-U', fleetDb.user, '-d', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1',
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
        const why = scrubbed(botId, safety.error || 'unknown reason');
        lastErrors.set(botId, `Pre-restore dump failed: ${why}`);
        return await refuse('Pre-restore dump failed, restore refused', why);
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
      const reason = scrubbed(botId, `could not recreate the database: ${lastLine(recreate.stderr)}`);
      setRestoreError(botId, file, reason, `The database may be missing, or unchanged if the drop itself failed; its write fence stays on (${back})`);
      return { success: false, error: `Restore failed: ${await keepFenced(reason)}`, steps };
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
      const reason = scrubbed(botId, restore.error || 'unknown error');
      setRestoreError(botId, file, reason, `The database may hold a partial restore; its write fence stays on (${back})`);
      return { success: false, error: `Restore failed: ${await keepFenced(reason)}`, steps };
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
        console.error(`[FleetBackup] Term reconcile failed on ${fleetDb.containerName}: ${bump.ok ? 'no term row to advance' : scrubbed(botId, lastLine(bump.stderr))}`);
      }
      const raised = await raiseGuildTerms(fleetDb, floor);
      if (!raised.ok) {
        const reason = scrubbed(botId, `the restored guild leases could not be raised above the pre-restore term ${floor} (${raised.error})`);
        setRestoreError(botId, file, reason, `A node still holding a pre-restore lease could write over the restored rows, so the write fence stays on (${back})`);
        return { success: false, error: `The dump was restored, but ${await keepFenced(reason)}`, steps };
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
      return { success: false, error: `The dump was restored, but ${await keepFenced(reason, 'the restored database from what was read mid-restore', startedMeanwhile?.ids)}`, steps };
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
    const lift = await finalLift();
    if (lift !== 'lifted') {
      console.error(`[FleetBackup] Restore fence on ${fleetDb.containerName}: ${lift === 'stripped'
        ? 'live lift failed; auto.conf and pg_hba.conf stripped, the database stays fenced until its container restarts'
        : lift === 'gone' ? `live lift failed and the volume ${fleetDb.volume} is gone`
        : lift === 'unknown' ? `live lift failed and docker did not answer whether the volume ${fleetDb.volume} exists`
        : lift === 'locked' ? 'the pg_hba lines could not be removed live or from the volume'
        : lift === 'unreloaded' ? 'the read-only setting could not be lifted or stripped; the pg_hba lines are out of pg_hba.conf but the reload failed'
        : lift === 'held' ? 'a layer another lane owns was left on'
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
        console.error(`[FleetBackup] Failed to restart ${id} after restore: ${scrubbed(botId, start.error || 'unknown error')}`);
      }
    }
    const startWarning = unstarted.length > 0 ? `; these instances were stopped and could not be restarted: ${unstarted.join(', ')} (start them by hand)` : '';

    if (lift !== 'lifted') return { success: false, error: `${lift === 'held' ? `Restored, but ${heldText(layersHeld, 'the restore')}` : lift === 'gone' ? `The restore ran, but the database volume ${fleetDb.volume} is gone now, so this manager can't confirm that the restored data exists` : lift === 'unknown' ? `Restored, but the write fence could not be lifted live, and docker did not answer whether the database volume ${fleetDb.volume} exists, so this manager can't confirm whether the database is still READ-ONLY or refusing the bot's connections; running a restore again retries the lift` : `Restored, but ${lift === 'stripped' ? 'the write fence could not be lifted live: the database is READ-ONLY, and may still refuse the bot\'s connections, until its container restarts' : lift === 'locked' ? 'the pg_hba lines of the write fence could not be removed: the database refuses every connection but the manager\'s, so the bot cannot reach it, a restart does not clear it, and running a restore again retries the lift' : lift === 'unreloaded' ? 'the write fence could not be lifted or stripped: the database stays READ-ONLY, a restart does not clear it, and running a restore again retries the lift; it may also refuse the bot\'s connections until it reloads or restarts' : 'the write fence could not be lifted or stripped: the database stays READ-ONLY, a restart does not clear it, and running a restore again retries the lift'}`} (see manager logs)${termWarning}${noticeWarning}${startWarning}`, steps };
    const warning = `${termWarning}${noticeWarning}${startWarning}`;
    return { success: true, ...(warning ? { warning: warning.slice(2) } : {}), steps };
  } finally {
    // The leftover-lift attempt must finish before the busy gate opens, or a
    // retry's fresh fence could be dissolved by this stale lift mid-restore.
    if (fenced) await liftAndTrack(botId, fleetDb, owner, 'a restore', 'running the restore again retries the lift', BOTH_LAYERS, layersHeld);
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
    if (tickRunning) return;
    tickRunning = true;
    runFleetBackupTick().catch(err => {
      console.error('[FleetBackup] Tick error:', err);
    }).finally(() => { tickRunning = false; });
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
