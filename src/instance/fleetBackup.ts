/**
 * Fleet Postgres Sidecar Backup Scheduler
 *
 * Runs on a 1-minute tick. Hourly pg_dump of every database the manager holds
 * for a bot: the main's sidecar (in scope while its stored database URL, under
 * the capability record's key, still points at that sidecar) and the live copy.
 * External databases are never dumped. Each dump runs in a snapshot whose table
 * counts are written beside it as <dump>.json; hourly dumps are kept 48 hours
 * and daily ones 30 days, and the newest dump is test-restored daily
 * (backupCheck). Dumps live in <DATA_DIR>/backups/<botId>/fleet-postgres/;
 * pre-*.dump safety files are never trimmed. The restore's order is on
 * restoreFleetBackup.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, execFile } from 'child_process';
import * as containerManager from '../docker/containerManager';
import * as envManager from '../env/manager';
import { findAppCapabilities } from '../config/appCapabilities';
import { ensurePrivateDir, PRIVATE_FILE_MODE } from '../config/fileModes';
import { InstanceConfig, FleetBackupConfig, BackupFamily, FleetBackupAlert, FleetBackupTestRecord } from '../types';
import {
  ALERT_AFTER_MS, backupDir, COPY_FILE_PREFIX, DumpKind, errorLine, isRecoveryConflict, STDERR_KEEP, DumpMeta, dumpDue, dumpFileName, hourSlot, holderStdin, newestScheduled, parseCountLines, parseDumpName,
  ScheduledKind, stampOf, testDue, trimVictims, utcText, validateDumpMeta,
} from './backupFiles';
import * as backupCheck from './backupCheck';
import { probeErrorTail, redactSecrets } from '../config/secretText';
import * as fleetReplica from './fleetReplica';
import * as dbLogin from './dbLogin';
import { MANAGER_DB_ROLE } from './dbLogin';
import { REPLICATION_ROLE } from './fleetReplication';
import { splitBackendUrls } from '../config/joinCode';
import * as maintenance from './maintenance';
import { busy, FENCE_HBA_COUNT_SQL, FENCE_HBA_OWNER_SQL, FENCE_OWNER_FILE, FENCE_OWNER_FILE_SQL, FENCE_OWNER_TAG, FenceLane, fenceOwnerLane, fenceOwnerText, parseFenceOwner, WRITE_FENCE_MARK } from './fleetBackupGuards';

const TICK_INTERVAL_MS = 60 * 1000; // 1 minute
const DUMP_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
/** A docker read (inspect, a SELECT or SHOW): a hung CLI must not hold its lane; a timed-out read is unknown. */
const READ_TIMEOUT_MS = 30_000;
/**
 * The dump's bounds: its snapshot and counts, pg_dump itself, the snapshot session's exit after COMMIT, and the time
 * after which a recovery conflict starts no new attempt.
 */
export const dumpTiming = { snapshotTimeoutMs: 5 * 60_000, dumpTimeoutMs: DUMP_TIMEOUT_MS, holderExitMs: 10_000, conflictBudgetMs: 10 * 60_000 };
const CONFLICT_ATTEMPTS = 3;
const MIN_FREE_BYTES = 512 * 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

const DATA_DIR = process.env.DATA_DIR || '/data/data';

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let tickRunning = false;
let schedulerStartedAt = 0;
// Each tick's dump loop starts one bot further on, so a slow bot does not cost the same later bots their slot.
let dumpRotation = 0;
// Orphan throwaways from before a restart; the first test waits for their removal.
let orphansRemoved: Promise<void> = Promise.resolve();
// The one test restore running, outside the tick; dbBytes sizes the disk it holds.
let runningTest: { botId: string; family: BackupFamily; file: string; dbBytes: number } | null = null;

export function isTickRunning(): boolean {
  return tickRunning;
}

export function isTestRunning(): boolean {
  return runningTest !== null;
}

const familyKey = (botId: string, family: BackupFamily) => `${botId}:${family}`;
// The last dump error of each family (in memory; the dumps alert is the record that survives a restart).
const lastErrors: Map<string, string> = new Map();
// The hour slot each family's scheduled dump was last attempted in.
const attemptedSlots: Map<string, number> = new Map();
// When a tick last found the family's database stopped.
const pausedAt: Map<string, number> = new Map();
const pausedNow: Set<string> = new Set();
// Family starts the registry refused, and the hour slot their refusal was last logged in.
const unsavedStarts: Map<string, number | null> = new Map();
const startLoggedSlots: Map<string, number> = new Map();
// dataAt of copy dumps, by file name, read once from their counts files.
const dataAtCache: Map<string, number | null> = new Map();
/** docker's stderr can quote a DSN or a password, so a stored error text carries the instance's secrets as ***. */
function scrubbed(botId: string, text: string): string {
  const instance = containerManager.getBot(botId);
  return instance ? redactSecrets(text, containerManager.recordSecrets(instance)) : text;
}
// A stuck restore write fence, tracked apart from lastErrors: a read-only
// database still DUMPS successfully, so the nightly dump's success would wipe
// a warning parked in the shared slot while the fence still stands.
// One warning per database (the primary and its copy are fenced apart), keyed by container name.
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

type RestoreNotice = { file: string; text: string; at: string; doubt: boolean };

/** The restore notice's text: a restore that has not finished, or did not end with its fence lifted. */
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

/** The page's Dismiss: refused while an operation holds the bot, and clears only the notice written at `at` (any notice that has no time). */
export function dismissShownRestoreNotice(botId: string, at: string): { dismissed: boolean; error?: string } {
  const op = containerManager.isBotBusy(botId);
  if (op === 'restore') return { dismissed: false, error: 'A restore of this bot is running; dismiss its notice when it ends' };
  if (op) return { dismissed: false, error: `Operation '${op}' is running on this bot; dismiss the restore notice when it ends` };
  const notice = restoreNotice(botId);
  if (!notice) return { dismissed: false };
  if (notice.at && notice.at !== at) return { dismissed: false, error: 'A newer restore notice replaced the one shown, so it was kept; read it, then dismiss it again' };
  return { dismissed: dismissFleetRestoreError(botId) };
}

/** Drops a notice the registry could not save, for a bot whose database record is gone. */
export function forgetRestoreNotice(botId: string): void {
  unsavedRestoreErrors.delete(botId);
}

/** The file of the notice the Database window shows; null when none stands. */
export function shownRestoreNoticeFile(botId: string): string | null {
  return restoreNotice(botId)?.file ?? null;
}

// Notices the registry could not save; read before the record, which then holds an older notice or none.
const unsavedRestoreErrors: Map<string, RestoreNotice> = new Map();

function restoreNotice(botId: string): RestoreNotice | null {
  const instance = containerManager.getBot(botId);
  if (!instance?.fleetDb) {
    unsavedRestoreErrors.delete(botId);
    return null;
  }
  return unsavedRestoreErrors.get(botId) || instance.fleetRestoreError || null;
}

/** Saves a notice, stamped now unless at is given; the registry's error when it could not. */
function saveNotice(botId: string, file: string, text: string, doubt: boolean, at = new Date().toISOString()): string | null {
  try {
    containerManager.updateInstanceFleetRestoreError(botId, { file, text, at, doubt });
    unsavedRestoreErrors.delete(botId);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Saves a notice, or holds it in memory, marked as such, when the registry cannot save it. */
function keepNotice(botId: string, file: string, text: string, doubt: boolean, at = new Date().toISOString()): void {
  const scrubbedText = scrubbed(botId, text);
  const failed = saveNotice(botId, file, scrubbedText, doubt, at);
  if (!failed) return;
  console.error(`[FleetBackup] Could not save the restore notice for ${botId}: ${failed}`);
  unsavedRestoreErrors.set(botId, { file, text: `${scrubbedText}${UNSAVED_MARK}`, at, doubt });
}

const UNSAVED_MARK = ' (this notice is not saved and a manager restart drops it)';

function setRestoreError(botId: string, file: string, reason: string, consequence: string): void {
  keepNotice(botId, file, `Restore of ${file} failed: ${reason}. ${consequence}; restore a dump again before the bot relies on it`, true);
}

/** The write fences a lane left on, one text per database; null when none. */
export function getFleetFenceStuck(botId: string): string | null {
  return Array.from(fenceStuck.get(botId)?.values() ?? [], e => e.text).join('; ') || null;
}

/** A held backup slot or op lock, named; null when neither is held. A shutdown and a self-update wait on these, bounded. */
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
 * wait for the operator and resume after a restart by design. A run is read as its card reads it, so one whose
 * park or clear the registry refused, or that no runner of this process drives, counts as parked.
 */
export function databaseLaneBlocker(): string | null {
  const inFlight = inFlightLaneBlocker();
  if (inFlight) return inFlight;
  for (const b of containerManager.getAllBots()) {
    const seed = fleetReplica.seedView(b);
    if (seed && !seed.parked) return `a standby seed is running on ${b.displayName}`;
  }
  return null;
}

/** Effective schedule for an instance; absent config means the defaults. */
export function effectiveFleetBackup(instance: InstanceConfig): FleetBackupConfig {
  return { enabled: instance.fleetBackup?.enabled ?? true, hour: instance.fleetBackup?.hour ?? 4 };
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
 * The highest claim number the bot's database had handed out before a restore, kept so a retry after a failed
 * restore (the live database is gone or partial by then) still raises the restored claims above it. Ratchets upward
 * only; .json so listFleetBackups' .dump filter never shows it.
 */
export function claimFloorPath(botId: string): string {
  return path.join(backupDir(botId), 'claim-floor.json');
}

// A floor this process observed but could not write to disk; a retry in the same process still uses it.
const heldClaimFloors: Map<string, number> = new Map();

function readClaimFloorDisk(botId: string): { ok: true; claim: number | null } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(fs.readFileSync(claimFloorPath(botId), 'utf-8'));
    if (!Number.isSafeInteger(parsed?.claim)) return { ok: false, error: 'it holds no whole-number claim' };
    return { ok: true, claim: parsed.claim };
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { ok: true, claim: null };
    return { ok: false, error: err?.message || String(err) };
  }
}

/** The floor kept on disk or held in memory, whichever is higher (claim), and the disk value alone (disk); null when none was kept; an error when the file cannot be read. */
export function readClaimFloor(botId: string): { ok: true; claim: number | null; disk: number | null } | { ok: false; error: string } {
  const disk = readClaimFloorDisk(botId);
  if (!disk.ok) return disk;
  let claim = disk.claim;
  const held = heldClaimFloors.get(botId);
  if (held !== undefined && (claim === null || held > claim)) claim = held;
  return { ok: true, claim, disk: disk.claim };
}

/** Write the floor through a synced temp file and a rename, never below the value on disk; the error text when it was not kept on disk. */
export function writeClaimFloor(botId: string, claim: number): string | null {
  const held = heldClaimFloors.get(botId);
  if (held === undefined || claim > held) heldClaimFloors.set(botId, claim);
  const disk = readClaimFloorDisk(botId);
  if (disk.ok && disk.claim !== null && disk.claim >= claim) return null;
  const target = claimFloorPath(botId);
  const tmp = `${target}.tmp`;
  try {
    ensurePrivateDir(backupDir(botId));
    fs.writeFileSync(tmp, JSON.stringify({ claim }), { mode: PRIVATE_FILE_MODE });
    syncPath(tmp, 'r+');
    fs.renameSync(tmp, target);
  } catch (err: any) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    const text = err?.message || String(err);
    console.error(`[FleetBackup] Could not keep the claim floor for ${botId} on disk: ${text}`);
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
 * A decommission ends the claim space: a rebuilt database numbers its claims from 1 again, and a floor carried over
 * from the destroyed database would raise a later restore's claims to the dead one's numbers.
 */
export function clearClaimFloor(botId: string): void {
  heldClaimFloors.delete(botId);
  try {
    fs.rmSync(claimFloorPath(botId), { force: true });
  } catch (err: any) {
    console.error(`[FleetBackup] Could not clear the claim floor for ${botId}: ${err?.message || err}`);
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

type DockerOut = { ok: boolean; stdout: string; stderr: string };
const missingRole = (r: DockerOut) => !r.ok && dbLogin.isMissingManagerRole(r.stderr);

/** A docker call whose args log in as MANAGER_DB_ROLE: a missing role is made and the call runs once more. */
function managerExec(db: { containerName: string; user: string }, args: string[], timeout?: number): Promise<DockerOut> {
  return dbLogin.asManager({ container: db.containerName, user: db.user }, role => execDocker(dbLogin.withRole(args, role), timeout), missingRole);
}

function managerRead(db: { containerName: string; user: string }, args: string[]): Promise<DockerOut> {
  return managerExec(db, args, READ_TIMEOUT_MS);
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
 * (restore, re-seed, decommission), 'lane' for a fence that takes over only a layer its own lane left.
 */
export type FenceTakeOver = 'any' | 'lane';

/**
 * The layers a lift left on because another lane, or no lane, owns them; holder is that owner (null: no lane).
 * fromFiles: the volume strip removed a layer of this lane's from the files. detail: docker's last line when the strip failed.
 */
export type FenceHeld = { readOnly: boolean; hba: boolean; holder: string | null; fromFiles?: boolean; detail?: string };

/** owner is lane:<ms>; '<lane>:*' stands for any run of that lane. */
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

const psqlArgs = (db: RestoreFleetDb, ...commands: string[]) => ['exec', db.containerName, 'psql', '-U', MANAGER_DB_ROLE, '-d', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1', ...commands.flatMap(c => ['-c', c])];
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
  const reload = await managerExec(fleetDb, psqlArgs(fleetDb, RELOAD_SQL));
  let reset: DockerAnswer = reload;
  if (layers.readOnly) {
    const read = await managerRead(fleetDb, psqlArgs(fleetDb, `SELECT current_setting('default_transaction_read_only') || '|' || ${FENCE_OWNER_FILE_SQL}`));
    const m = read.ok ? /^(on|off)\|([^|\n]*)$/.exec(read.stdout.trim()) : null;
    if (!m) {
      reset = { ok: false, stdout: '', stderr: read.ok ? `the read-only layer and its owner read back as ${read.stdout.trim().slice(0, 100) || 'nothing'}` : read.stderr };
    } else if (ownerMatches(m[2], owner)) {
      reset = await managerExec(fleetDb, psqlArgs(fleetDb, READ_WRITE_SQL, 'ALTER SYSTEM RESET default_transaction_read_only', RELOAD_SQL));
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
  if (live && (await managerExec(fleetDb, psqlArgs(fleetDb, RELOAD_SQL))).ok) return settled();
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
  const result = await liftOwnedFence(fleetDb, owner, layers, held);
  if (result === 'lifted' || result === 'gone') {
    clearStuck(botId, fleetDb.containerName);
    return result;
  }
  if (result === 'held') {
    setStuck(botId, fleetDb, capitalized(heldText(held, lane)));
    return result;
  }
  const heldNote = held.readOnly || held.hba ? `; and ${heldText(held, lane)}` : '';
  setStuck(botId, fleetDb, stuckLiftText(result, lane, fleetDb.volume, failedRemedy) + heldNote);
  return result;
}

const fenceSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Polls a TCP login from inside the container until the reloaded pg_hba refuses it; false when it never does by the deadline. */
async function rejectInForce(db: RestoreFleetDb): Promise<boolean> {
  const until = Date.now() + fenceTiming.probeDeadlineMs;
  for (;;) {
    const probe = await readDocker(['exec', db.containerName, 'psql', '-h', '127.0.0.1', '-U', MANAGER_DB_ROLE, '-d', 'postgres', '-w', '-tAc', 'SELECT 1']);
    if (!probe.ok && probe.stderr.includes('pg_hba.conf rejects connection')) return true;
    if (Date.now() >= until) return false;
    await fenceSleep(fenceTiming.probeGapMs);
  }
}

/** Ends every client session and every walsender but the managed role's physical ones; the reason when one did not end, else null. */
async function sweepSessions(db: RestoreFleetDb): Promise<string | null> {
  const sweep = await managerExec(db, psqlArgs(db, `SELECT pid, pg_terminate_backend(pid, 5000) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND (backend_type = 'client backend' OR (backend_type = 'walsender' AND NOT (usename IS NOT DISTINCT FROM '${REPLICATION_ROLE}' AND datname IS NULL)))`));
  if (!sweep.ok) return `the open sessions could not be ended (${lastLine(sweep.stderr)})`;
  const kept = sweep.stdout.split('\n').map(l => l.trim().split('|')).filter(([pid, ended]) => /^\d+$/.test(pid) && ended !== 't').map(([pid]) => pid);
  if (kept.length === 0) return null;
  // A session that ended between the listing and its terminate also answers false.
  const left = await managerRead(db, psqlArgs(db, `SELECT count(*) FROM pg_stat_activity WHERE pid IN (${kept.join(', ')})`));
  if (left.ok && left.stdout.trim() === '0') return null;
  return `${kept.length} open session(s) did not end within 5 s of being terminated${left.ok ? '' : ' and whether they ended since could not be read'}`;
}

/**
 * The write fence every lane that dumps before a destroy uses: the
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
  const read = await managerRead(fleetDb, psqlArgs(fleetDb,
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
    || (found !== null && (found === owner || fenceOwnerLane(found) === fenceOwnerLane(owner)));
  const setReadOnly = readOnlyNow === 'off' || mayTake(parseFenceOwner(fileOwner));
  const setHba = hbaCount === '0' || mayTake(parseFenceOwner(hbaOwners));
  if (setReadOnly) {
    // Before the setting: a read-only layer is never on with this lane's work under it and no owner named.
    owned.readOnly = true;
    const file = await execDocker(['exec', '-u', 'root', fleetDb.containerName, 'sh', '-c', fenceOwnerFileScript(owner)]);
    if (!file.ok) return refused(`the fence's owner file could not be written (${lastLine(file.stderr)})`);
    // ON_ERROR_STOP so a failed ALTER SYSTEM cannot read as a fence.
    const readOnly = await managerExec(fleetDb, psqlArgs(fleetDb, READ_WRITE_SQL, 'ALTER SYSTEM SET default_transaction_read_only = on', RELOAD_SQL));
    if (!readOnly.ok) return { ...readOnly, changed: true, owned };
  }
  if (setHba) {
    owned.hba = true;
    const hba = await execDocker(['exec', '-u', 'root', fleetDb.containerName, 'sh', '-c', fenceHbaScript(ssl === 'on', owner)]);
    if (!hba.ok) return refused(`pg_hba.conf could not be rewritten (${lastLine(hba.stderr)})`);
  }
  const reload = await managerExec(fleetDb, psqlArgs(fleetDb, RELOAD_SQL));
  if (!reload.ok) return refused(`the rewritten pg_hba.conf could not be reloaded (${lastLine(reload.stderr)})`);
  if (!await rejectInForce(fleetDb)) return refused(`the database still did not refuse a TCP connection ${fenceTiming.probeDeadlineMs / 1000} s after the reload of its rewritten pg_hba.conf`);
  const first = await sweepSessions(fleetDb);
  if (first) return refused(first);
  await fenceSleep(Number(authTimeout) * 1000);
  const second = await sweepSessions(fleetDb);
  if (second) return refused(second);
  return { ok: true, stdout: '', stderr: '', changed: true, owned };
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

/** Which layers of the write fence the database holds now and whose they are; null when it cannot be asked. */
export async function fenceLayers(target: RestoreFleetDb): Promise<FenceState | null> {
  const probe = await managerRead(target, ['exec', target.containerName, 'psql', '-U', MANAGER_DB_ROLE, '-d', 'postgres', '-tA', '-c',
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

/** The Start warning while the fence's pg_hba lines stand on the instance's database, or when they cannot be read; null when they do not. */
export async function fenceStartWarning(botId: string): Promise<string | null> {
  const db = containerManager.getBot(botId)?.fleetDb;
  if (!db) return null;
  const layers = await fenceLayers(db);
  if (!layers) return "The manager can't confirm the database has no write fence on it: its fence settings could not be read, and a fence left on refuses the bot's connections";
  if (!layers.hba) return null;
  return `${fencedState(layers, 'The database')}: the pg_hba lines of a write fence (ending in ${WRITE_FENCE_MARK}) are still on it, and a restart keeps them; ${ownersText(layers)}, and ${holderRemedy(layers.hbaOwner)}`;
}

/**
 * Seed the stuck-fence warnings from OBSERVED live state at scheduler start,
 * so a manager restart does not silently forget a database a failed lift left
 * read-only. One probe per fleet-database host, once.
 */
async function seedStuckFences(): Promise<void> {
  for (const instance of containerManager.getAllBots()) {
    // A copy carries no fence of its own (its seed strips the setting), so one
    // reading 'on' is a promote's that was never lifted.
    const copy = instance.fleetDbReplica;
    if (copy?.user && !isStuck(instance.id, copy.containerName) && await isContainerRunning(copy.containerName)) {
      const copyDb = { containerName: copy.containerName, user: copy.user, db: copy.db ?? 'postgres', volume: copy.volume };
      const onCopy = await fenceLayers(copyDb);
      await dropStaleOwner(instance.id, copyDb, onCopy);
      if (anyLayer(onCopy)) {
        const recovery = await managerRead(copyDb, ['exec', copy.containerName, 'psql', '-U', MANAGER_DB_ROLE, '-d', 'postgres', '-tA', '-c', 'SELECT pg_is_in_recovery()']);
        const inRecovery = recovery.ok ? recovery.stdout.trim() : '';
        const remedy = inRecovery === 't' ? 're-seeding this copy on its Database modal clears it'
          : inRecovery === 'f' ? `this copy is promoted and the Database modal does not re-seed a promoted copy, so lift it by hand (remove the lines ending in ${WRITE_FENCE_MARK} from pg_hba.conf, ALTER SYSTEM RESET default_transaction_read_only, then SELECT pg_reload_conf(), and remove the file ${FENCE_OWNER_FILE} from the data directory)`
            : 'whether this copy is still a standby could not be read: re-seeding on its Database modal clears a standby, and a promoted copy is lifted only by hand';
        setStuck(instance.id, copyDb, `${fencedState(onCopy, 'The copy')}: a write fence is on (${ownersText(onCopy)}); ${remedy}`);
      }
    }
    const db = instance.fleetDb;
    if (!db || isStuck(instance.id, db.containerName)) continue;
    if (!await isContainerRunning(db.containerName)) continue;
    const layers = await fenceLayers(db);
    await dropStaleOwner(instance.id, db, layers);
    if (anyLayer(layers)) setStuck(instance.id, db, `${fencedState(layers, 'The database')} (a write fence was not lifted); ${await seededFenceRemedy(instance, db, layers)}`);
  }
}

/** Whether the fence setting is saved in postgresql.auto.conf, so a restart re-applies it; null when that cannot be read. */
async function fencePersisted(db: RestoreFleetDb): Promise<boolean | null> {
  const read = await managerRead(db, ['exec', db.containerName, 'psql', '-U', MANAGER_DB_ROLE, '-d', 'postgres', '-tA', '-c', "SELECT count(*) FROM pg_file_settings WHERE name = 'default_transaction_read_only'"]);
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
  return busy.has(botId) || containerManager.isBotBusy(botId) !== null;
}

/** An owner file over a database that reads not read-only is stale: it goes, unless a lane may be fencing right now. */
async function dropStaleOwner(botId: string, db: RestoreFleetDb, layers: FenceState | null): Promise<void> {
  if (!layers || layers.readOnly || laneMayBeFencing(botId)) return;
  const owner = parseFenceOwner(layers.ownerFile);
  if (owner) await dropOwnerFile(db, owner);
  else if (!layers.ownerFile) staleOwnerFiles.delete(db.containerName);
}

/**
 * Self-heal the stuck-fence warning: once the operator restarts the container
 * (the stripped auto.conf comes up clean) the live state is writable again and
 * the warning must go. Cheap - runs only while an entry exists.
 */
async function reprobeStuckFences(): Promise<void> {
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
      if (noLayer(layers)) clearStuck(id, db.containerName);
    }
  }
}

export type BackupEntry = {
  file: string; size: number; mtime: number; kind: DumpKind; family: BackupFamily; takenAt: number;
  tables: number | null; rows: number | null; dataAt: number | null; test: 'passed' | 'failed' | null;
};

/** The names in an instance's backup folder; none when it does not exist. Throws when it cannot be read. */
function readFolder(botId: string): string[] {
  try {
    return fs.readdirSync(backupDir(botId));
  } catch (err: any) {
    if (err?.code === 'ENOENT') return [];
    throw new Error(`The backup folder for ${botId} could not be read: ${err?.message || err}`);
  }
}

function readMeta(botId: string, file: string): DumpMeta | null {
  try {
    const checked = validateDumpMeta(JSON.parse(fs.readFileSync(path.join(backupDir(botId), `${file}.json`), 'utf-8')));
    return checked.ok && checked.meta.file === file ? checked.meta : null;
  } catch {
    return null;
  }
}

/**
 * List dump files for an instance, newest first, with what each one's counts file records and its test verdict.
 */
export function listFleetBackups(botId: string): BackupEntry[] {
  const names = readFolder(botId);
  const instance = containerManager.getBot(botId);
  const out: BackupEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.dump')) continue;
    let st: fs.Stats;
    try {
      st = fs.statSync(path.join(backupDir(botId), name));
    } catch { continue; /* raced deletion */ }
    const parsed = parseDumpName(name);
    const meta = readMeta(botId, name);
    const last = instance ? backupCheck.currentTests(instance, parsed.family).last : undefined;
    const test = last?.file === name && (last.result === 'passed' || last.result === 'failed') ? last.result : null;
    out.push({
      file: name, size: st.size, mtime: st.mtimeMs, kind: parsed.kind, family: parsed.family, takenAt: meta?.takenAt ?? parsed.stamp ?? st.mtimeMs,
      tables: meta?.tables ?? null, rows: meta?.rows ?? null, dataAt: meta?.dataAt ?? null, test,
    });
  }
  return out.sort((a, b) => b.takenAt - a.takenAt);
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

/**
 * Deletes the family's dumps past their keep, each .dump before its .json. Kept: the family's newest, the last dump
 * that passed a test restore, the dump just written, the dump a failed restore names (backupFiles.trimVictims) and
 * the dump a running test restore reads.
 */
function trimFamily(instance: InstanceConfig, family: BackupFamily, justWritten: string | null): void {
  const label = backupCheck.familyText(instance, family);
  let names: string[];
  try {
    names = readFolder(instance.id);
  } catch (err) {
    console.warn(`[FleetBackup] Kept every backup of ${label}: ${err instanceof Error ? err.message : err}`);
    return;
  }
  const testing = runningTest?.botId === instance.id ? runningTest.file : null;
  const protect = [backupCheck.currentTests(instance, family).lastGood, justWritten, restoreNotice(instance.id)?.file, testing];
  const { victims, clockAhead } = trimVictims(names, family, Date.now(), protect);
  if (clockAhead) {
    console.warn(`[FleetBackup] Kept every backup of ${label}: a backup is dated ahead of the clock, so the clock may have stepped back`);
    return;
  }
  const dir = backupDir(instance.id);
  for (const file of victims) {
    try {
      fs.unlinkSync(path.join(dir, file));
      fs.rmSync(path.join(dir, `${file}.json`), { force: true });
    } catch (err) {
      console.warn(`[FleetBackup] Failed to trim ${file} of ${label}:`, err);
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

type DumpTarget = { containerName: string; user: string; db: string };
type DumpResult = { success: boolean; file?: string; error?: string; meta?: DumpMeta; conflict?: boolean };

/**
 * One pg_dump of the instance's sidecar into a safety dump named `prefix` and the time (pre-restore-, pre-reseed-,
 * pre-decommission-), with its counts file. Fails when the container is not running.
 */
export async function runFleetDump(
  instance: InstanceConfig,
  prefix = ''
): Promise<{ success: boolean; file?: string; error?: string }> {
  const fleetDb = instance.fleetDb;
  if (!fleetDb) return { success: false, error: 'No fleet database record' };
  const at = Date.now();
  const kind: DumpKind = prefix.startsWith('pre-') ? 'safety' : 'other';
  const result = await dumpDatabase(instance, fleetDb, `${prefix}${stampOf(at)}.dump`, 'main', kind, at);
  return { success: result.success, ...(result.file ? { file: result.file } : {}), ...(result.error !== undefined ? { error: result.error } : {}) };
}

/**
 * The safety dump of this machine's live copy before a re-seed or an automatic rebuild deletes it: the copy family,
 * its counts file, renamed and synced. Claims nothing; the caller holds the backup slot.
 */
export async function dumpCopyForRebuild(instance: InstanceConfig, prefix: string): Promise<{ success: true; file: string } | { success: false; error: string }> {
  const rec = instance.fleetDbReplica;
  if (!rec?.user || !rec.db) return { success: false, error: 'the standby record has no database identity, so the copy could not be dumped' };
  const at = Date.now();
  const result = await dumpDatabase(instance, { containerName: rec.containerName, user: rec.user, db: rec.db }, `${COPY_FILE_PREFIX}${prefix}${stampOf(at)}.dump`, 'copy', 'safety', at);
  if (result.success && result.file) return { success: true, file: result.file };
  return { success: false, error: scrubbed(instance.id, result.error || 'unknown error') };
}

const MIB = 1024 * 1024;

/**
 * D-DISK when the folder's disk has less free than max(512 MiB, twice the family's newest dump), plus what a running
 * test restore holds (twice its database's size and 1 GiB); a statfs error lets the dump go ahead.
 */
function diskRefusal(botId: string, family: BackupFamily, dir: string): string | null {
  let free: number;
  try {
    const st = fs.statfsSync(dir);
    free = Number(st.bavail) * Number(st.bsize);
  } catch (err) {
    console.warn(`[FleetBackup] The free space under ${dir} could not be read (${err}); the dump goes ahead`);
    return null;
  }
  let newest = 0;
  try {
    const last = newestScheduled(readFolder(botId), family);
    if (last) newest = fs.statSync(path.join(dir, last.file)).size;
  } catch { /* no size known: the floor applies */ }
  const held = runningTest ? 2 * runningTest.dbBytes + GIB : 0;
  const need = Math.max(MIN_FREE_BYTES, 2 * newest) + held;
  if (free >= need) return null;
  const testing = held ? `, of which ${Math.ceil(held / MIB)} MB is held for the test restore that is running` : '';
  return `only ${Math.floor(free / MIB)} MB is free under ${DATA_DIR}, and a dump needs about ${Math.ceil(need / MIB)} MB${testing}; free space there (backups past their 48-hour or 30-day keep are deleted after each hourly run)`;
}

/**
 * Dumps one database with its counts. A live copy whose replay cancels the dump is tried again at once, up to three
 * attempts in all, and no new attempt starts once the run has taken 10 minutes.
 */
async function dumpDatabase(instance: InstanceConfig, target: DumpTarget, fileName: string, family: BackupFamily, kind: DumpKind, at: number): Promise<DumpResult> {
  const dbState = await containerState(target.containerName);
  if (dbState.running !== true) {
    return { success: false, error: dbDownText(dbState, 'Database container is not running') };
  }
  const dir = backupDir(instance.id);
  ensurePrivateDir(dir);
  const disk = diskRefusal(instance.id, family, dir);
  if (disk) return { success: false, error: disk };
  const label = backupCheck.familyText(instance, family);
  const runStart = Date.now();
  for (let attempt = 1; ; attempt++) {
    const last = await dbLogin.asManager({ container: target.containerName, user: target.user },
      role => dumpOnce(target, role, dir, fileName, { family, kind, at, label }), r => !r.success && dbLogin.isMissingManagerRole(r.error ?? ''));
    if (last.success || !last.conflict) return last;
    if (attempt >= CONFLICT_ATTEMPTS) {
      return { success: false, error: "the live copy's replay cancelled the dump 3 times in a row (conflict with recovery); the next hourly run tries again" };
    }
    if (Date.now() - runStart >= dumpTiming.conflictBudgetMs) {
      const times = attempt === 1 ? 'once' : `${attempt} times in a row`;
      return { success: false, error: `the live copy's replay cancelled the dump ${times} (conflict with recovery), and no new attempt starts once a run has taken 10 minutes; the next hourly run tries again` };
    }
  }
}

/**
 * The holder (a psql session) exports a snapshot in a read-only repeatable-read transaction and prints the table
 * counts it sees; pg_dump then dumps that same snapshot, so the counts describe the dump. The dump and its counts
 * file go through synced temp files and renames, the counts file first; the holder commits once the dump is written.
 */
function dumpOnce(target: DumpTarget, role: string, dir: string, fileName: string, about: { family: BackupFamily; kind: DumpKind; at: number; label: string }): Promise<DumpResult> {
  const finalPath = path.join(dir, fileName);
  const tmpPath = `${finalPath}.tmp`;
  const metaPath = `${finalPath}.json`;
  const metaTmp = `${metaPath}.tmp`;
  return new Promise<DumpResult>(resolve => {
    let settled = false;
    let holderOut = '';
    let holderErr = '';
    let dumpErr = '';
    let holderClosed = false;
    let onHolderClose: (() => void) | null = null;
    let snapshot: { id: string; inRecovery: boolean; dbBytes: number; dataAt: number | null; counts: Record<string, number> } | null = null;
    let dump: ReturnType<typeof spawn> | null = null;
    let out: fs.WriteStream | null = null;
    let dumpTimer: ReturnType<typeof setTimeout> | null = null;

    let holder: ReturnType<typeof spawn>;
    try {
      holder = spawn('docker', dbLogin.withRole(['exec', '-i', target.containerName, 'psql', '-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-U', MANAGER_DB_ROLE, '-d', target.db], role));
    } catch (err: any) {
      return resolve({ success: false, error: `Failed to run docker exec: ${err?.message || err}` });
    }
    const fail = (error: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(snapTimer);
      if (dumpTimer) clearTimeout(dumpTimer);
      holder.kill('SIGKILL');
      dump?.kill('SIGKILL');
      for (const f of [tmpPath, metaTmp]) {
        try { fs.unlinkSync(f); } catch { /* already gone */ }
      }
      const conflict = isRecoveryConflict(holderErr) || isRecoveryConflict(dumpErr);
      const result: DumpResult = { success: false, error, ...(conflict ? { conflict } : {}) };
      // A stream still open can create its file after the unlink above, and the next attempt reuses the name.
      if (!out || out.closed) return resolve(result);
      out.once('close', () => {
        try { fs.unlinkSync(tmpPath); } catch { /* already gone */ }
        resolve(result);
      });
      out.destroy();
    };
    const snapTimer = setTimeout(() => fail('the database did not return its table counts within 5 minutes, so no dump was taken'), dumpTiming.snapshotTimeoutMs);
    const snapFailed = (detail: string) => fail(`the dump's snapshot and table counts could not be taken (${detail})`);

    const finish = () => {
      if (settled) return;
      if (dumpTimer) clearTimeout(dumpTimer);
      holder.stdin?.end('COMMIT;\n');
      const snap = snapshot!;
      const rows = Object.values(snap.counts).reduce((a, b) => a + b, 0);
      const meta: DumpMeta = {
        file: fileName, takenAt: about.at, family: about.family, kind: about.kind, inRecovery: snap.inRecovery, dataAt: snap.dataAt,
        dbBytes: snap.dbBytes, tables: Object.keys(snap.counts).length, rows, counts: snap.counts,
      };
      try {
        syncPath(tmpPath, 'r+');
      } catch (err) {
        return fail(`Failed to finalize dump file: ${err}`);
      }
      try {
        fs.writeFileSync(metaTmp, JSON.stringify(meta), { mode: PRIVATE_FILE_MODE });
        syncPath(metaTmp, 'r+');
        fs.renameSync(metaTmp, metaPath);
      } catch (err: any) {
        return fail(`the dump finished, but its counts file could not be written (${err?.message || err}), so the dump was not kept`);
      }
      try {
        fs.renameSync(tmpPath, finalPath);
      } catch (err) {
        try { fs.unlinkSync(metaPath); } catch { /* best effort */ }
        return fail(`Failed to finalize dump file: ${err}`);
      }
      settled = true;
      let result: DumpResult = { success: true, file: fileName, meta };
      try {
        syncPath(dir, 'r');
      } catch (err) {
        // Windows cannot open a folder to sync it; NTFS journals the rename itself.
        if (process.platform !== 'win32') result = { success: false, error: `The dump ${fileName} was written, but its folder could not be synced to disk, so a crash could still lose it: ${err}` };
      }
      if (holderClosed) return resolve(result);
      // A late holder does not fail a complete dump; its session also ends on the idle timeout it set.
      const late = setTimeout(() => {
        holder.kill('SIGKILL');
        console.warn(`[FleetBackup] The snapshot session of ${about.label} did not end 10 s after the dump; it was stopped, and the dump ${fileName} is complete`);
        resolve(result);
      }, dumpTiming.holderExitMs);
      onHolderClose = () => { clearTimeout(late); resolve(result); };
    };

    const startDump = () => {
      const snap = snapshot!;
      try {
        dump = spawn('docker', dbLogin.withRole(['exec', target.containerName, 'pg_dump', '-U', MANAGER_DB_ROLE, '-Fc', `--snapshot=${snap.id}`, target.db], role));
      } catch (err: any) {
        return fail(`Failed to run docker exec: ${err?.message || err}`);
      }
      out = fs.createWriteStream(tmpPath, { mode: PRIVATE_FILE_MODE });
      let killed = false;
      dumpTimer = setTimeout(() => { killed = true; dump?.kill('SIGKILL'); }, dumpTiming.dumpTimeoutMs);
      // A spawn that fails early (EMFILE) has no stdio, and its 'error' follows.
      dump.stdout?.pipe(out);
      dump.stderr?.on('data', d => { if (dumpErr.length < STDERR_KEEP) dumpErr += d.toString(); });
      dump.on('error', err => fail(`Failed to run docker exec: ${err.message}`));
      out.on('error', err => fail(`Failed to write dump file: ${err.message}`));
      dump.on('close', code => {
        if (settled) return;
        if (killed) return fail(`Dump timed out after ${DUMP_TIMEOUT_MS / 60000} minutes`);
        if (code !== 0) return fail(`pg_dump exited with code ${code}: ${dumpErr.trim().slice(0, 500)}`);
        out!.end(finish);
      });
    };

    const onCounts = () => {
      const line = holderOut.split('\n').map(l => l.trim()).find(l => l.startsWith('snap|')) ?? '';
      const m = /^snap\|([^|]+)\|([tf])\|(\d+)\|(-?\d+)$/.exec(line);
      if (!m) return snapFailed(`the snapshot line read back as ${line.slice(0, 200) || 'nothing'}`);
      const parsed = parseCountLines(holderOut);
      if (!parsed.ok) return snapFailed(parsed.error);
      clearTimeout(snapTimer);
      snapshot = { id: m[1], inRecovery: m[2] === 't', dbBytes: Number(m[3]), dataAt: Number(m[4]) < 0 ? null : Number(m[4]), counts: parsed.counts };
      startDump();
    };

    holder.on('error', err => fail(`Failed to run docker exec: ${err.message}`));
    holder.stdin?.on('error', () => { /* EPIPE when the session ended first; close answers */ });
    holder.stderr?.on('data', d => { if (holderErr.length < STDERR_KEEP) holderErr += d.toString(); });
    holder.stdout?.on('data', d => {
      holderOut += d.toString();
      if (snapshot === null && !settled && /(^|\n)end\|/.test(holderOut)) onCounts();
    });
    holder.on('close', () => {
      holderClosed = true;
      onHolderClose?.();
      if (snapshot === null && !settled) snapFailed(errorLine(holderErr) || 'the session ended before its counts');
    });
    holder.stdin?.write(holderStdin(DUMP_TIMEOUT_MS / 1000 + 120));
  });
}

const FAMILIES: BackupFamily[] = ['main', 'copy'];

/** What the scheduler does with a family: nothing held, held and skipped, held and failing before a dump, or dumped. */
type FamilyPlan = { skip: 'scope' | 'seed' } | { error: string } | { target: DumpTarget };

function familyPlan(instance: InstanceConfig, family: BackupFamily): FamilyPlan | null {
  if (family === 'main') {
    if (!instance.fleetDb) return null;
    // A broken store cannot verify scope, and the dumps HAVE stopped: that counts as failing.
    const scope = backupScopeUnverifiable(instance);
    if (scope.corrupt) return { error: 'the env store cannot be read (a copy is kept beside it as storage.json.corrupt-<time> when it could be read), so the scheduled dump cannot verify its scope' };
    if (scope.urlUndecryptable) return { error: 'the stored database URL no longer decrypts (the encryption key changed?), so the scheduled dump cannot verify its scope' };
    if (!isFleetBackupScoped(instance)) return { skip: 'scope' };
    return { target: instance.fleetDb };
  }
  const rec = instance.fleetDbReplica;
  if (!rec || rec.copyCleared) return null;
  const seed = fleetReplica.seedView(instance);
  if (seed && seed.parked !== true) return { skip: 'seed' };
  if (!rec.user || !rec.db) return { error: 'the standby record has no database identity, so no scheduled dump of this copy ran' };
  return { target: { containerName: rec.containerName, user: rec.user, db: rec.db } };
}

/** The scheduled dump of one family when one is due; the seed check, the due check and the slot claim share one synchronous segment. */
async function scheduledDump(instance: InstanceConfig, family: BackupFamily): Promise<void> {
  if (!effectiveFleetBackup(instance).enabled) return;
  const plan = familyPlan(instance, family);
  if (!plan || 'skip' in plan) return;
  const key = familyKey(instance.id, family);
  const now = Date.now();
  let names: string[];
  try {
    names = readFolder(instance.id);
  } catch (err) {
    lastErrors.set(key, err instanceof Error ? err.message : String(err));
    return;
  }
  const due = dumpDue(names, family, now, effectiveFleetBackup(instance).hour, attemptedSlots.get(key));
  if (!due) return;
  if ('error' in plan) {
    attemptedSlots.set(key, hourSlot(now));
    lastErrors.set(key, plan.error);
    console.error(`[FleetBackup] No scheduled dump of ${backupCheck.familyText(instance, family)}: ${plan.error}`);
    return;
  }
  if (busy.has(instance.id) || containerManager.isShuttingDown()) return;
  busy.add(instance.id);
  try {
    await runFamilyDump(instance, family, plan.target, due, now);
  } finally {
    busy.delete(instance.id);
  }
}

async function runFamilyDump(instance: InstanceConfig, family: BackupFamily, target: DumpTarget, due: ScheduledKind, now: number): Promise<void> {
  const key = familyKey(instance.id, family);
  const label = backupCheck.familyText(instance, family);
  const state = await containerState(target.containerName);
  if (state.running === false) {
    pausedAt.set(key, now);
    pausedNow.add(key);
    return;
  }
  pausedNow.delete(key);
  attemptedSlots.set(key, hourSlot(now));
  let written: string | null = null;
  const result = state.running === null
    ? { success: false, error: dbDownText(state, '') }
    : await dumpDatabase(instance, target, dumpFileName(family, due, now), family, due, now);
  if (result.success && result.file) {
    written = result.file;
    lastErrors.delete(key);
    if ('meta' in result && result.meta) dataAtCache.set(result.file, result.meta.dataAt);
    console.log(`[FleetBackup] Dumped ${label} -> ${result.file}`);
  } else {
    const error = scrubbed(instance.id, result.error || 'unknown error');
    lastErrors.set(key, error);
    console.error(`[FleetBackup] Dump of ${label} failed: ${error}`);
  }
  // The trim runs after a failed attempt too, so a disk filled by aging dumps frees itself; it waits while backups are off.
  const fresh = containerManager.getBot(instance.id);
  if (fresh && effectiveFleetBackup(fresh).enabled) trimFamily(fresh, family, written);
}

/** The newest scheduled dump of the family when its daily test restore is due; null when none is. */
function dueTestFile(instance: InstanceConfig, family: BackupFamily): string | null {
  const config = effectiveFleetBackup(instance);
  if (!config.enabled) return null;
  const plan = familyPlan(instance, family);
  if (!plan || !('target' in plan)) return null;
  const now = Date.now();
  if (backupCheck.testSkippedThisSlot(instance.id, family, now)) return null;
  if (!testDue(backupCheck.currentTests(instance, family).last, now, config.hour)) return null;
  let names: string[];
  try { names = readFolder(instance.id); } catch { return null; }
  return newestScheduled(names, family)?.file ?? null;
}

/** Starts the first due test restore, not awaited, unless one is running: the test lane runs one at a time. */
function startOneTest(ids: string[]): void {
  if (runningTest || containerManager.isShuttingDown()) return;
  for (const id of ids) {
    for (const family of FAMILIES) {
      const instance = containerManager.getBot(id);
      const file = instance ? dueTestFile(instance, family) : null;
      if (!instance || !file) continue;
      runningTest = { botId: id, family, file, dbBytes: readMeta(id, file)?.dbBytes ?? 0 };
      backupCheck.runTestRestore(instance, family, file)
        .catch(err => console.error(`[FleetBackup] The test restore of ${backupCheck.familyText(instance, family)} stopped on an error:`, err))
        .finally(() => { runningTest = null; });
      return;
    }
  }
}

function familyStart(instance: InstanceConfig, family: BackupFamily): number | null {
  const key = familyKey(instance.id, family);
  return unsavedStarts.has(key) ? unsavedStarts.get(key)! : instance.fleetBackupStarts?.[family] ?? null;
}

/**
 * Saves when the scheduler first found the family to back up (a plan neither null nor skipped), and clears it when the
 * family's plan goes null or its backups are off (the caller passes null then); the start it now holds.
 */
function trackStart(instance: InstanceConfig, family: BackupFamily, plan: FamilyPlan | null, now: number): number | null {
  const key = familyKey(instance.id, family);
  const held = familyStart(instance, family);
  const want = !plan ? null : 'skip' in plan ? held : held ?? now;
  if (want === (instance.fleetBackupStarts?.[family] ?? null)) {
    unsavedStarts.delete(key);
    return want;
  }
  try {
    containerManager.updateInstanceFleetBackupStart(instance.id, family, want);
    unsavedStarts.delete(key);
  } catch (err) {
    unsavedStarts.set(key, want);
    if (startLoggedSlots.get(key) !== hourSlot(now)) {
      startLoggedSlots.set(key, hourSlot(now));
      const what = instance.fleetBackupStarts?.[family] == null
        ? `No start of the backups of ${backupCheck.familyText(instance, family)} is stored yet`
        : `The registry still holds the old start of the backups of ${backupCheck.familyText(instance, family)}`;
      console.error(`[FleetBackup] ${what}: ${want === null ? 'clearing it' : `saving ${utcText(want)}`} failed, and the manager tries again on every tick (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return want;
}

/** Since when the family has had no scheduled dump: its newest, its start, or the last tick that found its database stopped. */
function failingBaseline(instance: InstanceConfig, family: BackupFamily, names: string[], start = familyStart(instance, family)): number {
  return Math.max(newestScheduled(names, family)?.stamp ?? 0, start ?? 0, pausedAt.get(familyKey(instance.id, family)) ?? 0);
}

function dumpsAlertText(instance: InstanceConfig, family: BackupFamily, since: number): string {
  const error = lastErrors.get(familyKey(instance.id, family));
  return `No backup of ${backupCheck.familyText(instance, family)}${backupCheck.whereText(instance, family)} has succeeded since ${utcText(since)}.${error ? ` Last error: ${error}.` : ''} The manager tries again every hour; its Database window has the details.`;
}

function testAlertText(instance: InstanceConfig, family: BackupFamily, last: FleetBackupTestRecord): string {
  const hour = String(effectiveFleetBackup(instance).hour).padStart(2, '0');
  return `The daily test restore of ${last.file}, a backup of ${backupCheck.familyText(instance, family)}${backupCheck.whereText(instance, family)}, failed: ${last.text ?? 'no reason was recorded'}. The manager tests the newest backup again after the daily backup at ${hour}:00.`;
}

/**
 * The dumps and test alerts of every family the instance holds; a family it does not back up now loses its last test.
 * A standing dumps alert stays while its condition holds; a new one also needs a dump attempt by this process, or
 * this process running for 3 hours, so a manager that was down does not alert before it tried.
 */
function alertConditions(instance: InstanceConfig, now: number): backupCheck.AlertCondition[] {
  const conditions: backupCheck.AlertCondition[] = [];
  const config = effectiveFleetBackup(instance);
  const standing = backupCheck.currentAlerts(instance.id);
  let names: string[] = [];
  try { names = readFolder(instance.id); } catch { /* the error stands; the baseline goes without stamps */ }
  for (const family of FAMILIES) {
    const plan = familyPlan(instance, family);
    const start = trackStart(instance, family, config.enabled ? plan : null, now);
    if (!plan) {
      backupCheck.clearLastTest(instance, family, now);
      continue;
    }
    const key = familyKey(instance.id, family);
    const since = failingBaseline(instance, family, names, start);
    const failing = config.enabled && !('skip' in plan) && !pausedNow.has(key) && now - since > ALERT_AFTER_MS;
    const tried = attemptedSlots.has(key) || now - schedulerStartedAt >= ALERT_AFTER_MS;
    const dumpsOn = failing && (!!standing[`${family}:dumps`] || tried);
    conditions.push({ family, kind: 'dumps', on: dumpsOn, text: dumpsAlertText(instance, family, since) });
    const last = backupCheck.currentTests(instance, family).last;
    const held = standing[`${family}:test`];
    if (last?.result === 'running' || last?.result === 'interrupted') conditions.push({ family, kind: 'test', on: !!held, text: held?.text ?? '' });
    else conditions.push({ family, kind: 'test', on: last?.result === 'failed', text: last ? testAlertText(instance, family, last) : '' });
  }
  return conditions;
}

async function runFleetBackupTick(): Promise<void> {
  const fault = containerManager.registryFault();
  if (fault) { console.warn(`[FleetBackup] Tick skipped: ${fault}`); return; }
  await reprobeStuckFences();
  const ids = containerManager.getAllBots().map(b => b.id);
  const first = ids.length > 0 ? dumpRotation++ % ids.length : 0;
  for (const id of [...ids.slice(first), ...ids.slice(0, first)]) {
    for (const family of FAMILIES) {
      const instance = containerManager.getBot(id);
      if (instance) await scheduledDump(instance, family);
    }
  }
  if (containerManager.isShuttingDown()) return;
  for (const id of ids) {
    const instance = containerManager.getBot(id);
    if (instance) await backupCheck.stepAlerts(instance, alertConditions(instance, Date.now()), Date.now());
  }
  await orphansRemoved;
  startOneTest(ids);
}

export type FamilyStatus = {
  family: BackupFamily; role: string; enabled: boolean; hour: number; paused: boolean;
  lastFile: string | null; lastAt: number | null; dataAt: number | null; lastError: string | null; failingSince: number | null; listError: string | null;
  /** Why the scheduler takes no dump of this family now: out of scope, or its seed runs. */
  skip: 'scope' | 'seed' | null;
  test: FleetBackupTestRecord | null; alerts: { dumps: FleetBackupAlert | null; test: FleetBackupAlert | null };
};

function copyDataAt(botId: string, file: string): number | null {
  if (!dataAtCache.has(file)) dataAtCache.set(file, readMeta(botId, file)?.dataAt ?? null);
  return dataAtCache.get(file) ?? null;
}

/** What the Database window and the card show about the instance's backups; null for an instance that holds no database. */
export function fleetBackupStatus(instance: InstanceConfig): {
  enabled: boolean; hour: number; scoped: boolean | null; restoreError: string | null; restoreErrorAt: string | null; main: FamilyStatus | null; copy: FamilyStatus | null;
} {
  const config = effectiveFleetBackup(instance);
  let names: string[] = [];
  let listError: string | null = null;
  try {
    names = readFolder(instance.id);
  } catch (err) {
    listError = `${err instanceof Error ? err.message : err}, so the last backup cannot be named`;
  }
  const alerts = backupCheck.currentAlerts(instance.id);
  const family = (f: BackupFamily): FamilyStatus | null => {
    const plan = familyPlan(instance, f);
    if (!plan) return null;
    const key = familyKey(instance.id, f);
    const newest = newestScheduled(names, f);
    const dumps = alerts[`${f}:dumps`] ?? null;
    return {
      family: f, role: backupCheck.roleText(f), enabled: config.enabled, hour: config.hour, paused: pausedNow.has(key),
      lastFile: newest?.file ?? null, lastAt: newest?.stamp ?? null, dataAt: f === 'copy' && newest ? copyDataAt(instance.id, newest.file) : null,
      lastError: lastErrors.get(key) ?? null, failingSince: dumps ? failingBaseline(instance, f, names) : null, listError,
      skip: 'skip' in plan ? plan.skip : null,
      test: backupCheck.currentTests(instance, f).last ?? null, alerts: { dumps, test: alerts[`${f}:test`] ?? null },
    };
  };
  return {
    enabled: config.enabled, hour: config.hour,
    scoped: instance.fleetDb ? fleetBackupScopeState(instance) : null,
    restoreError: getFleetRestoreError(instance.id),
    restoreErrorAt: restoreNotice(instance.id)?.at ?? null,
    main: family('main'), copy: family('copy'),
  };
}

/** At start: the temp files and orphan counts files a stopped manager left, in every folder whose bot holds no backup slot. */
function sweepUnfinished(): void {
  let ids: string[];
  try {
    ids = fs.readdirSync(path.join(DATA_DIR, 'backups'));
  } catch (err: any) {
    if (err?.code !== 'ENOENT') console.error(`[FleetBackup] The backups folder could not be read: ${err?.message || err}`);
    return;
  }
  for (const id of ids) {
    if (busy.has(id)) continue;
    const dir = backupDir(id);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') console.error(`[FleetBackup] The backup folder ${dir} could not be read: ${err?.message || err}`);
      continue;
    }
    const present = new Set(names);
    let deleted = 0;
    for (const name of names.filter(n => n.endsWith('.tmp') || (n.endsWith('.dump.json') && !present.has(n.slice(0, -'.json'.length))))) {
      try {
        fs.unlinkSync(path.join(dir, name));
        deleted++;
      } catch (err) {
        console.warn(`[FleetBackup] Could not delete the unfinished backup file ${name} in ${dir}: ${err}`);
      }
    }
    if (deleted > 0) console.log(`[FleetBackup] Deleted ${deleted} unfinished backup file(s) a stopped manager left in ${dir}`);
  }
}

type RestoreSteps = { stopped: string[]; preRestoreDump: string | null; restored: boolean; claimFloor: number | null; guildsRaised: string[] | null; claimRaisedTo: number | null; botState: 'maintenance' | 'off' | null; restarted: string[] };

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
    const entries = key ? splitBackendUrls(envManager.getEnvVars(b.id)[key]) : [];
    return entries.some(entry => {
      const identity = databaseIdentity(entry);
      return identity !== null && aliases.has(identity);
    });
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
  return block ? `${block.step}, then run a restore again with the bot in Maintenance or Off to retry the lift` : RESTORE_RETRY_LIFT;
}

const RESTORE_RETRY_LIFT = 'running a restore again with the bot in Maintenance or Off retries the lift';

/** What a restore's lift that did not end lifted left on the database, with its remedy. */
function restoreLiftClause(lift: FenceLift, held: FenceHeld, volume: string, restored: boolean): string {
  return lift === 'held' ? heldText(held, 'the restore')
    : lift === 'gone' ? `the database volume ${volume} is gone now, so this manager can't confirm that the ${restored ? 'restored ' : ''}data exists`
    : lift === 'unknown' ? `the write fence could not be lifted live, and docker did not answer whether the database volume ${volume} exists, so this manager can't confirm whether the database is still READ-ONLY or refusing the bot's connections; ${RESTORE_RETRY_LIFT}`
    : lift === 'stripped' ? 'the write fence could not be lifted live: the database is READ-ONLY, and may still refuse the bot\'s connections, until its container restarts'
    : lift === 'locked' ? `the pg_hba lines of the write fence could not be removed: the database refuses every connection but the manager's, so the bot cannot reach it, a restart does not clear it, and ${RESTORE_RETRY_LIFT}`
    : lift === 'unreloaded' ? `the write fence could not be lifted or stripped: the database stays READ-ONLY, a restart does not clear it, and ${RESTORE_RETRY_LIFT}; it may also refuse the bot's connections until it reloads or restarts`
    : `the write fence could not be lifted or stripped: the database stays READ-ONLY, a restart does not clear it, and ${RESTORE_RETRY_LIFT}`;
}

/** The restore notice for a lift that did not end lifted: what happened, the clause, then what clears the notice. A
 * notice added to an earlier one, which is added only when that one left the data in doubt, gives no dismissal step. */
function restoreLiftNotice(start: string, lift: FenceLift, held: FenceHeld, volume: string, restored: boolean, merged = false): string {
  const then = merged ? 'restore a dump again' : 'dismiss this notice';
  const tail = lift === 'stripped' ? `; restart the instance, then ${then}`
    : lift === 'held' ? `; once the fence is lifted, ${then}`
    : lift === 'gone' ? '; with the bot in Maintenance or Off, restore a dump again'
    : '';
  return `${start}, but ${restoreLiftClause(lift, held, volume, restored)}${tail}`;
}

/** Whether the bot's database has contract 8's claim sequence, the guild ownership table, and that table's claim column. */
export type ClaimTables = { seq: boolean; table: boolean; claim: boolean };

const CLAIM_TABLES_SQL = "SELECT to_regclass('smdb_data.claim_seq') IS NOT NULL, to_regclass('smdb_data.guild_ownership') IS NOT NULL, EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('smdb_data.guild_ownership') AND attname = 'claim' AND NOT attisdropped)";

/** Exactly `<seq>|<table>|<claim column>`, each t or f; anything else is null. */
export function parseClaimTables(stdout: string): ClaimTables | null {
  const m = /^([tf])\|([tf])\|([tf])$/.exec(stdout.replace(/\n$/, ''));
  return m ? { seq: m[1] === 't', table: m[2] === 't', claim: m[3] === 't' } : null;
}

/** The statement that reads the highest claim number the database handed out; old for the term schema, none when neither source exists. */
export function claimFloorSql(t: ClaimTables): { sql: string } | { old: true } | { none: true } {
  if (t.table && !t.claim) return { old: true };
  if (!t.seq && !t.table) return { none: true };
  const sources = [
    ...(t.seq ? ['(SELECT last_value FROM smdb_data.claim_seq)'] : []),
    ...(t.table ? ['(SELECT max(claim) FROM smdb_data.guild_ownership)'] : []),
  ];
  return { sql: `SELECT coalesce(GREATEST(${sources.join(', ')}), -1)` };
}

/**
 * One statement, so the rows and the sequence move together or not at all: every restored claim at or below the floor
 * goes to floor+1 and the sequence to at least floor+1, never back. It answers `seq|<value>` and one `guild|<id>` per row raised.
 */
export function claimRaiseSql(floor: number, t: ClaimTables): string | { error: string } {
  if (!t.seq) return { error: 'the restored database has no smdb_data.claim_seq' };
  if (t.table && !t.claim) return { error: 'the restored smdb_data.guild_ownership has no claim column' };
  const next = floor + 1;
  if (!Number.isSafeInteger(floor) || !Number.isSafeInteger(next)) return { error: `the claim floor ${floor} has no next whole number` };
  const seq = `setval('smdb_data.claim_seq', GREATEST(last_value, ${next}))`;
  if (!t.table) return `SELECT 'seq|' || ${seq} FROM smdb_data.claim_seq`;
  return `WITH u AS (UPDATE smdb_data.guild_ownership SET claim = ${next}, updated_at = now() WHERE claim <= ${floor} RETURNING guild_id), s AS (SELECT ${seq} AS v FROM smdb_data.claim_seq) SELECT 'seq|' || v FROM s UNION ALL SELECT 'guild|' || guild_id FROM u`;
}

/** The raise's answer: exactly one sequence value above the floor, every other line a raised guild. */
export function parseClaimRaise(stdout: string, floor: number): { ok: true; seq: number; guilds: string[] } | { ok: false; error: string } {
  let seq: number | null = null;
  const guilds: string[] = [];
  for (const line of stdout.split('\n').map(l => l.trim()).filter(Boolean)) {
    if (line.startsWith('seq|')) {
      if (seq !== null) return { ok: false, error: 'the raise answered two sequence values' };
      const value = line.slice('seq|'.length);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return { ok: false, error: `the raise answered '${line}'` };
      seq = Number(value);
    } else if (line.startsWith('guild|') && line.length > 'guild|'.length) {
      guilds.push(line.slice('guild|'.length));
    } else {
      return { ok: false, error: `the raise answered '${line}'` };
    }
  }
  if (seq === null) return { ok: false, error: 'the raise answered no sequence value' };
  if (seq < floor + 1) return { ok: false, error: `the sequence answered ${seq}, which is not above ${floor}` };
  return { ok: true, seq, guilds };
}

/** What a dump's `pg_restore -l` lists: the claim sequence, the term schema's ownership table without it, or neither; null when it is no table of contents. */
export function dumpClaimShape(toc: string): 'claims' | 'terms' | 'none' | null {
  if (!/^\d+; /m.test(toc)) return null;
  if (/^\d+; \d+ \d+ SEQUENCE smdb_data claim_seq /m.test(toc)) return 'claims';
  if (/^\d+; \d+ \d+ TABLE smdb_data guild_ownership /m.test(toc)) return 'terms';
  return 'none';
}

const claimPsql = (fleetDb: RestoreFleetDb, sql: string, exempt: boolean) => ['exec', ...(exempt ? ['-e', 'PGOPTIONS=-c default_transaction_read_only=off'] : []), fleetDb.containerName,
  'psql', '-U', MANAGER_DB_ROLE, '-d', fleetDb.db, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql];

async function readClaimTables(fleetDb: RestoreFleetDb): Promise<{ ok: true; tables: ClaimTables } | { ok: false; error: string }> {
  const read = await managerRead(fleetDb, claimPsql(fleetDb, CLAIM_TABLES_SQL, false));
  if (!read.ok) return { ok: false, error: lastLine(read.stderr) };
  const tables = parseClaimTables(read.stdout);
  return tables ? { ok: true, tables } : { ok: false, error: `the claim probe answered '${read.stdout.trim()}'` };
}

/**
 * The highest claim number the live database handed out (the sequence's last value or the highest guild claim): every
 * process of the bot holds a claim at or below it. Shape old for the term schema; claim null when neither exists.
 */
export async function probeClaims(fleetDb: RestoreFleetDb): Promise<{ ok: true; shape: 'claims' | 'old' | 'none'; claim: number | null } | { ok: false; error: string }> {
  const read = await readClaimTables(fleetDb);
  if (!read.ok) return read;
  const plan = claimFloorSql(read.tables);
  if ('old' in plan) return { ok: true, shape: 'old', claim: null };
  if ('none' in plan) return { ok: true, shape: 'none', claim: null };
  const probe = await managerRead(fleetDb, claimPsql(fleetDb, plan.sql, false));
  if (!probe.ok) return { ok: false, error: lastLine(probe.stderr) };
  const out = probe.stdout.trim();
  const claim = /^-?\d+$/.test(out) ? Number(out) : NaN;
  if (!Number.isSafeInteger(claim)) return { ok: false, error: `the claim probe answered '${out}'` };
  return { ok: true, shape: 'claims', claim: claim < 0 ? null : claim };
}

/**
 * Raises every restored claim and the claim sequence above the floor in the fence-exempt session, so no process that
 * took its claim before the restore (claim at most floor) can save over a restored row (contract 8). The guilds raised.
 */
export async function raiseClaims(fleetDb: RestoreFleetDb, floor: number): Promise<{ ok: true; seq: number; guilds: string[] } | { ok: false; error: string }> {
  const read = await readClaimTables(fleetDb);
  if (!read.ok) return read;
  const sql = claimRaiseSql(floor, read.tables);
  if (typeof sql !== 'string') return { ok: false, error: sql.error };
  const raise = await managerExec(fleetDb, claimPsql(fleetDb, sql, true));
  if (!raise.ok) return { ok: false, error: lastLine(raise.stderr) };
  return parseClaimRaise(raise.stdout, floor);
}

export const tocTiming = { inContainerSec: 60, backstopMs: 90_000 };
const TOC_MAX_CHARS = 8 * 1024 * 1024;

/** A dump's table of contents: `pg_restore -l` in the sidecar, the file on stdin. pg_restore -l connects to no database. */
export function readDumpToc(containerName: string, dumpPath: string): Promise<{ ok: true; toc: string } | { ok: false; error: string }> {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const slow = `reading it took more than ${tocTiming.inContainerSec} seconds`;
    let settled = false;
    let input: fs.ReadStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: { ok: true; toc: string } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      input?.destroy();
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('docker', ['exec', '-i', containerName, 'timeout', '-s', 'KILL', String(tocTiming.inContainerSec), 'pg_restore', '-l']);
    } catch (err: any) {
      finish({ ok: false, error: `Failed to run docker exec: ${err?.message || err}` });
      return;
    }
    let stdout = '';
    let stderr = '';
    let killed = false;
    timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
      finish({ ok: false, error: slow });
    }, tocTiming.backstopMs);
    child.stdout?.on('data', d => { if (stdout.length < TOC_MAX_CHARS) stdout += d.toString(); });
    child.stderr?.on('data', d => { if (stderr.length < 4000) stderr += d.toString(); });
    child.stdin?.on('error', () => { /* EPIPE: pg_restore -l stops reading once it has the table of contents */ });
    child.on('error', err => finish({ ok: false, error: `Failed to run docker exec: ${err.message}` }));
    child.on('close', code => {
      if (killed || (code === 137 && Date.now() - startedAt >= tocTiming.inContainerSec * 1000)) return finish({ ok: false, error: slow });
      if (code !== 0) return finish({ ok: false, error: `pg_restore exited with code ${code}: ${stderr.trim().slice(0, 500)}` });
      finish({ ok: true, toc: stdout });
    });
    if (child.stdin) {
      input = fs.createReadStream(dumpPath);
      input.on('error', err => {
        child.kill('SIGKILL');
        finish({ ok: false, error: `Failed to read dump file: ${err.message}` });
      });
      input.pipe(child.stdin);
    }
  });
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

const RESTORE_OP = 'restore';

/**
 * Restore a dump of the whole bot into its sidecar, under the bot's op lock 'restore'. Refused while another lane
 * holds the database (a seed run, an op lock on an instance that shares it). In order: the instances that share the
 * database are held (Start, Restart, Update and Build refuse); the bot must be in a settled Maintenance or Off with
 * its database login blocked and none of its sessions open; the dump's table of contents is read (a dump on the term
 * schema is refused); the sharers docker shows running are stopped (the bot itself only when its state is Off and it
 * runs) and the sidecar is brought back alone; the restore notice is written; write fence; pre-restore safety dump
 * under the fence (refusing the restore if it fails); the highest claim number the database handed out kept on disk
 * (refusing when it cannot be); the notice rewritten with the safety dump's name; drop and recreate of the database
 * (pg_restore --clean cannot restore this schema: the partition PK drops it emits are refused as inherited
 * constraints and the run exits 1 even when everything applied; a fresh database makes any restore error a real
 * failure); pg_restore --exit-on-error of the chosen file with the restoring session exempted; every restored claim
 * and the claim sequence raised above the kept number; fence lifted; the notice cleared only when the lift ended
 * lifted; the other stopped instances started. The bot keeps its state and its process; it loads the restored data
 * when the operator chooses Running. A failure past the drop keeps the fence on and the instances stopped. docker's
 * stderr can quote the database URL, so the answer passes the secret filter, as do the notices and logs built from
 * stderr.
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

type RestoreResult = { success: boolean; error?: string; warning?: string; steps: RestoreSteps };

async function runFleetRestore(botId: string, file: string): Promise<RestoreResult> {
  const steps: RestoreSteps = {
    stopped: [], preRestoreDump: null, restored: false, claimFloor: null, guildsRaised: null, claimRaisedTo: null, botState: null, restarted: [],
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

  const floorRead = readClaimFloor(botId);
  if (!floorRead.ok) {
    return { success: false, error: `The claim floor file ${claimFloorPath(botId)} could not be read (${floorRead.error}), so the highest claim number the bot used before is unknown and the restore was refused (nothing was changed); repair the file, then retry`, steps };
  }

  // No await between this check and the lock, so no other op can take the bot in between.
  const op = containerManager.isBotBusy(botId);
  if (op) return { success: false, error: `Operation '${op}' is running on this bot; wait for it before restoring a dump (nothing was changed)`, steps };
  return containerManager.withExternalBotOp(botId, RESTORE_OP, () => restoreLocked(instance, fleetDb, file, dumpPath, url, floorRead, steps));
}

async function restoreLocked(
  instance: InstanceConfig,
  fleetDb: RestoreFleetDb,
  file: string,
  dumpPath: string,
  url: string,
  floorRead: { claim: number | null; disk: number | null },
  steps: RestoreSteps
): Promise<RestoreResult> {
  const botId = instance.id;
  const sharing = restoreSharers(instance, url);
  const others = sharing.filter(b => b.id !== botId);
  for (const b of others) {
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
  // The notice that stood before this lane, put back by an exit before the drop whose lift ended lifted.
  const priorNotice = containerManager.getBot(botId)?.fleetRestoreError ?? null;
  const priorUnsaved = unsavedRestoreErrors.get(botId) ?? null;
  // From this lane's first notice until the drop starts, an exit owes the notice back.
  let noticeOwed = false;
  // The answer names the state after the second attempt, so the finally has no lift left to change it.
  const finalLift = async (): Promise<FenceLift> => {
    let result = await liftAndTrack(botId, fleetDb, owner, 'a restore', RESTORE_RETRY_LIFT, BOTH_LAYERS, layersHeld);
    if (result !== 'lifted' && result !== 'held') {
      const retry = await liftAndTrack(botId, fleetDb, owner, 'a restore', RESTORE_RETRY_LIFT, BOTH_LAYERS, layersHeld);
      // A strip that landed stays in the file, so a failed second strip does not undo it.
      const keeps: FenceLift[] = result === 'stripped' ? ['failed', 'unreloaded', 'locked', 'unknown']
        : result === 'unreloaded' ? ['failed', 'locked', 'unknown'] : [];
      if (keeps.includes(retry)) setStuck(botId, fleetDb, stuckLiftText(result, 'a restore', fleetDb.volume, RESTORE_RETRY_LIFT));
      else result = retry;
    }
    fenced = false;
    return result;
  };

  // Before the drop nothing was restored: bring back the other instances that were stopped (the bot itself keeps the
  // state it is in), and stop a sidecar this lane started alone.
  const undo = async (): Promise<string> => {
    release();
    const unstarted: string[] = [];
    for (const id of steps.stopped) {
      if (id === botId) continue;
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

  // An exit before the drop: the notice that stood before this lane comes back when no layer of the fence stays on.
  // Otherwise the layer left on is added, under a new time, to a notice that left the data in doubt, or is the notice
  // in place of one that did not, or when none stood.
  // A warning for the answer when the notice could not be put back.
  const settleNotice = (cleared: FenceLift | null): string => {
    if (!noticeOwed) return '';
    noticeOwed = false;
    if (cleared !== null && cleared !== 'lifted') {
      const prior = priorUnsaved ?? priorNotice;
      if (prior && prior.doubt !== false) {
        const earlier = prior.text.replace(UNSAVED_MARK, '').replace(/\.$/, '');
        keepNotice(botId, prior.file, restoreLiftNotice(`${earlier}. Then a restore of ${file} was refused before the database was dropped`, cleared, layersHeld, fleetDb.volume, false, true), true);
      } else {
        const unchanged = cleared === 'gone' ? '' : ', so its data is unchanged';
        keepNotice(botId, file, restoreLiftNotice(`Restore of ${file} was refused before the database was dropped${unchanged}`, cleared, layersHeld, fleetDb.volume, false), cleared === 'gone');
      }
      return '';
    }
    try {
      containerManager.updateInstanceFleetRestoreError(botId, priorNotice);
    } catch (err) {
      console.error(`[FleetBackup] Could not put back the restore notice for ${botId}: ${err}`);
      const prior = priorUnsaved ?? priorNotice;
      if (prior) {
        unsavedRestoreErrors.set(botId, prior.text.endsWith(UNSAVED_MARK) ? prior : { ...prior, text: `${prior.text}${UNSAVED_MARK}` });
        return `; the earlier restore notice is shown, but only this manager's memory holds it: after a manager restart, the notice that this restore of ${file} had not finished stands instead`;
      }
      return '; the notice that this restore had not finished could not be removed (dismiss it on the Database window)';
    }
    if (priorUnsaved) unsavedRestoreErrors.set(botId, priorUnsaved);
    else unsavedRestoreErrors.delete(botId);
    return '';
  };

  // A refusal before the fence: nothing but stopped instances and a sidecar started alone to bring back.
  const refuseBeforeFence = async (refused: string, detail: string): Promise<RestoreResult> => {
    const note = await undo();
    return { success: false, error: `${refused}${note ? '' : ', and nothing was changed'}: ${detail}${note}`, steps };
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
    const stillStopped = steps.stopped.filter(id => id !== botId && !runningNow.includes(id));
    const runs = runningNow.length > 0 ? `${runningNow.map(nameOf).join(', ')} runs now. ` : '';
    const self = steps.botState === 'off' ? 'the bot stays off' : 'the bot stays in maintenance';
    const kept = stillStopped.length > 0
      ? `, ${self}, and the other stopped instances stay stopped (${stillStopped.map(nameOf).join(', ')})`
      : ` and ${self}`;
    const back = steps.preRestoreDump
      ? `the pre-restore dump ${steps.preRestoreDump} holds the database as it was`
      : 'no pre-restore dump was taken, because the database was missing';
    setStuck(botId, fleetDb, `The database is READ-ONLY: a restore of ${file} failed (${reason}), so its write fence stays on${access}; with the bot in Maintenance or Off, restore a dump again (${back})`);
    return `${reason}. ${runs}The write fence stays on${kept}, so nothing writes to ${guards}${access}; with the bot in Maintenance or Off, restore a dump again: ${back}`;
  };

  try {
    // 0. A restore must work on a DOWN fleet - that is exactly when it is
    // needed, and starting the whole instance first would boot the bot
    // against the bad data. Bring the database up alone when it is not up;
    // the maintenance check below reads the bot's login in it.
    if (!await isContainerRunning(fleetDb.containerName)) {
      const started = await asResult(containerManager.startFleetDbSidecar(botId));
      if (!started.success) {
        release();
        return { success: false, error: `Could not start the database for the restore: ${started.error}`, steps };
      }
      sidecarStartedAlone = true;
    }

    // 1. The bot is in maintenance, read under this lane's op lock, so no state change runs until the restore ends.
    const proof = await maintenance.requireMaintenance(botId, 'database');
    if (!proof.ok) return await refuseBeforeFence('A restore runs only in maintenance, so it was refused', proof.error);
    steps.botState = proof.state;

    // 2. The dump is read before anything stops: one the bot cannot run on is refused while nothing has changed.
    const toc = await readDumpToc(fleetDb.containerName, dumpPath);
    const shape = toc.ok ? dumpClaimShape(toc.toc) : null;
    if (!toc.ok || shape === null) {
      return await refuseBeforeFence(`The dump ${file} could not be read, so the restore was refused`, toc.ok ? 'it is not a pg_dump archive' : scrubbed(botId, toc.error));
    }
    if (shape === 'terms') {
      return await refuseBeforeFence(`The dump ${file} was taken before the bot numbered its saves by claim, so the restore was refused`,
        'it has smdb_data.guild_ownership but no smdb_data.claim_seq, and the bot does not run on that schema');
    }

    // 3. Courtesy stop of every sharing instance docker shows running: the
    // status record can be stale either way (a crashed bot, a hand-started one).
    // The bot itself stays up in Maintenance (it answers with its message and
    // cannot write); in Off it should not run, so it is stopped under this lock.
    for (const b of sharing) {
      const live = await containerManager.runningInstanceContainers(b.id);
      if (live === null) {
        const note = await undo();
        return { success: false, error: `Docker could not say whether instance ${b.displayName} is running, so the restore was refused${note ? '' : ' and nothing was changed'}${note}`, steps };
      }
      if (live.length === 0) continue;
      const self = b.id === botId;
      if (self && steps.botState === 'maintenance') continue;
      const stop = await asResult(self ? containerManager.stopBotInOp(botId, RESTORE_OP) : containerManager.stopBot(b.id));
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

    // 4. Stopping the host took its sidecar down with the compose project;
    // bring the database back alone.
    if (!await isContainerRunning(fleetDb.containerName)) {
      const started = await asResult(containerManager.startFleetDbSidecar(botId));
      if (!started.success) {
        const note = await undo();
        return { success: false, error: `Could not start the database for the restore: ${started.error}${note}`, steps };
      }
      sidecarStartedAlone = true;
    }

    // Before the fence, so a manager restart at any later point leaves a notice that refuses Running.
    const pending = (back: string) => `Restore of ${file} has not finished: if it is no longer running (the manager restarted), the database may be missing or hold a partial restore, and its write fence may still be on; restore a dump again before choosing Running${back}`;
    const unrecorded = saveNotice(botId, file, pending(''), true);
    if (unrecorded) return await refuseBeforeFence('The restore could not be recorded before the database was fenced, so the restore was refused', unrecorded);
    noticeOwed = true;

    // 5. Write fence: writes off
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
      return { success: false, error: `Could not fence the database for the restore: ${lastLine(fence.stderr)}${note}${settleNotice(null)}`, steps };
    }
    if (!fence.ok) {
      // A half-applied fence must not survive the refusal. Only a LIVE lift
      // clears it; 'stripped' cleans the persisted copy alone, so the operator
      // must hear about the read-only risk.
      const cleared = await finalLift();
      const note = await undo();
      const fenceWarning = cleared === 'lifted' ? ''
        : cleared === 'gone' || cleared === 'unknown' || cleared === 'held' ? liftNote(cleared, fleetDb.volume, RESTORE_RETRY_LIFT, layersHeld, 'the restore')
        : cleared === 'stripped' ? '; the database may be READ-ONLY, and may still refuse the bot\'s connections, until its container restarts'
        : cleared === 'locked' ? `; the database may refuse every connection but the manager's, so the bot cannot reach it (pg_hba lines that could not be removed survive a restart; ${RESTORE_RETRY_LIFT})`
        : cleared === 'unreloaded' ? `; the database may stay READ-ONLY (a fence that could not be lifted or stripped survives a restart; ${RESTORE_RETRY_LIFT}), and it may refuse the bot's connections until it reloads or restarts`
          : `; the database may stay READ-ONLY (a fence that could not be lifted or stripped survives a restart; ${RESTORE_RETRY_LIFT})`;
      return { success: false, error: `Could not fence the database for the restore: ${lastLine(fence.stderr)}${fenceWarning}${note}${settleNotice(cleared)}`, steps };
    }

    // A refusal past the fence lifts it and brings back what was stopped; only then has it changed nothing.
    const refuse = async (refused: string, detail: string) => {
      const cleared = await finalLift();
      const note = await undo();
      const noticeNote = settleNotice(cleared);
      return { success: false, error: `${refused}${note || noticeNote ? '' : ', and nothing was changed'}: ${detail}${liftNote(cleared, fleetDb.volume, RESTORE_RETRY_LIFT, layersHeld, 'the restore')}${note}${noticeNote}`, steps };
    };

    // 6. Pre-restore safety dump UNDER the fence, so it holds every write the
    // drop below removes. A MISSING database (a prior recreate failure) has
    // no data to protect and dumping it would refuse every retry, so
    // existence is probed first; an unanswerable probe still refuses.
    const exists = await managerRead(fleetDb, ['exec', fleetDb.containerName, 'psql', '-U', MANAGER_DB_ROLE, '-d', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1',
      '-c', `SELECT count(*) FROM pg_database WHERE datname = '${fleetDb.db.replace(/'/g, "''")}'`]);
    if (!exists.ok) {
      return await refuse('Could not check the database before the restore, so the restore was refused', lastLine(exists.stderr));
    }
    // The claim floor: the highest claim number the live database handed out,
    // kept on disk before the drop (a retry after a failed restore probes a
    // missing or partial database), and raised over in the restored copy, so
    // a process that took its claim before the restore cannot save over it.
    let floor: number | null = floorRead.claim;
    if (exists.stdout.trim() !== '0') {
      const safety = await runFleetDump(instance, 'pre-restore-');
      if (!safety.success) {
        const why = scrubbed(botId, safety.error || 'unknown reason');
        lastErrors.set(familyKey(botId, 'main'), `Pre-restore dump failed: ${why}`);
        return await refuse('Pre-restore dump failed, restore refused', why);
      }
      steps.preRestoreDump = safety.file || null;

      const live = await probeClaims(fleetDb);
      if (!live.ok) return await refuse('Could not read the claim numbers before the restore, so the restore was refused', scrubbed(botId, live.error));
      if (live.shape === 'old') {
        return await refuse("The bot's database numbers its saves by term, which this manager no longer reads, so the restore was refused", 'smdb_data.guild_ownership has no claim column');
      }
      if (live.claim !== null && (floor === null || live.claim > floor)) floor = live.claim;
    }
    if (shape === 'none' && floor !== null) {
      return await refuse(`The dump ${file} holds no claim numbers, so the restore was refused`,
        `the bot has used claim numbers up to ${floor}, and without smdb_data.claim_seq in the dump a process that ran before the restore could save over the restored data`);
    }
    // A floor held only in memory (an earlier attempt could not write it) is written now too: past the drop, the
    // probe of a missing or partial database cannot recover it after a manager restart.
    if (floor !== null && (floorRead.disk === null || floor > floorRead.disk)) {
      const kept = writeClaimFloor(botId, floor);
      if (kept) {
        return await refuse(`The claim floor ${floor} could not be kept on disk, so the restore was refused`,
          `${kept}; free space under ${DATA_DIR} and retry (this manager holds the number in memory until it restarts)`);
      }
    }

    const outside = await sharersRunning(others);
    if (outside === null) {
      return await refuse('Docker could not say whether an instance sharing the database was started during the restore, so the restore was refused', 'retry in a moment');
    }
    if (outside.names.length > 0) {
      return await refuse('An instance sharing the database was started outside the manager during the restore, so the restore was refused',
        `${outside.names.join(', ')} runs now; stop it and keep it stopped (also from CasaOS) until the restore ends, then retry`);
    }

    // The notice gains the safety dump's name; when it cannot, the first notice stands and still refuses Running.
    const back = steps.preRestoreDump ? `the pre-restore dump is ${steps.preRestoreDump}` : 'no pre-restore dump was taken, because the database was missing';
    const unnamed = saveNotice(botId, file, pending(` (${back})`), true);
    if (unnamed) console.error(`[FleetBackup] Could not add the safety dump's name to the restore notice for ${botId}: ${unnamed}`);
    noticeOwed = false;

    // 7. Drop and recreate the database under the fence. pg_restore --clean
    // cannot restore this schema (the partition PK drops it emits are refused
    // as inherited constraints and the run exits 1 even when everything
    // applied), and a fresh database makes any restore error a real failure.
    // WITH (FORCE) also kills sessions the terminate sweep raced against.
    // Physical walsenders are not connected to any database, so a streaming
    // standby just replays the swap.
    const dbIdent = `"${fleetDb.db.replace(/"/g, '""')}"`;
    const recreate = await managerExec(fleetDb, ['exec', '-e', 'PGOPTIONS=-c default_transaction_read_only=off', fleetDb.containerName,
      'psql', '-U', MANAGER_DB_ROLE, '-d', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1',
      '-c', `DROP DATABASE IF EXISTS ${dbIdent} WITH (FORCE)`,
      '-c', `CREATE DATABASE ${dbIdent} OWNER "${fleetDb.user.replace(/"/g, '""')}"`]);
    if (!recreate.ok) {
      const reason = scrubbed(botId, `could not recreate the database: ${lastLine(recreate.stderr)}`);
      setRestoreError(botId, file, reason, `The database may be missing, or unchanged if the drop itself failed; its write fence stays on (${back})`);
      return { success: false, error: `Restore failed: ${await keepFenced(reason)}`, steps };
    }

    // 8. pg_restore with the dump streamed to stdin. PGOPTIONS exempts this
    // one session from the fence; everyone else stays read-only. The
    // IN-CONTAINER timeout is load-bearing: killing the docker exec CLIENT
    // leaves the server-side pg_restore alive and fence-exempt, still writing
    // into the database after the lift below - the timeout kills the actual
    // process, and the Node timer is only the backstop behind it.
    const inContainerTimeoutSec = Math.floor(DUMP_TIMEOUT_MS / 1000);
    const restoreAs = (role: string) => new Promise<{ success: boolean; error?: string }>(resolve => {
      const restoreStartedAt = Date.now();
      const child = spawn('docker', dbLogin.withRole(['exec', '-e', 'PGOPTIONS=-c default_transaction_read_only=off', '-i', fleetDb.containerName,
        'timeout', '-s', 'KILL', String(inContainerTimeoutSec),
        'pg_restore', '-U', MANAGER_DB_ROLE, '--exit-on-error', '-d', fleetDb.db], role));
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
    const restore = await dbLogin.asManager({ container: fleetDb.containerName, user: fleetDb.user }, restoreAs, r => !r.success && dbLogin.isMissingManagerRole(r.error ?? ''));

    if (!restore.success) {
      // 9. Terminate any surviving session before returning: a timed-out
      // pg_restore's server-side process is fence-exempt, and left alive it
      // would keep writing into the database.
      await managerExec(fleetDb, ['exec', fleetDb.containerName, 'psql', '-U', MANAGER_DB_ROLE, '-d', 'postgres', '-tA',
        '-c', "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND backend_type = 'client backend'"]);
      const reason = scrubbed(botId, restore.error || 'unknown error');
      setRestoreError(botId, file, reason, `The database may hold a partial restore; its write fence stays on (${back})`);
      return { success: false, error: `Restore failed: ${await keepFenced(reason)}`, steps };
    }
    steps.restored = true;

    // 10. Every restored claim and the sequence go above the floor, in one statement.
    if (floor !== null) {
      const raised = await raiseClaims(fleetDb, floor);
      if (!raised.ok) {
        const reason = scrubbed(botId, `the restored claim numbers could not be raised above ${floor} (${raised.error})`);
        setRestoreError(botId, file, reason, `A process of the bot that ran before the restore could save over the restored rows, so the write fence stays on (${back})`);
        return { success: false, error: `The dump was restored, but ${await keepFenced(reason)}`, steps };
      }
      steps.claimFloor = floor;
      steps.guildsRaised = raised.guilds;
      steps.claimRaisedTo = floor + 1;
      console.log(`[FleetBackup] Raised the claim numbers on ${fleetDb.containerName} above ${floor}: ${raised.guilds.length} guild(s) to ${floor + 1}, claim_seq to ${raised.seq}`);
    }

    // An instance started meanwhile (a CasaOS tile click) read the database while it was dropped and rebuilt.
    const startedMeanwhile = await sharersRunning(others);
    if (startedMeanwhile === null || startedMeanwhile.names.length > 0) {
      const reason = startedMeanwhile === null
        ? "docker could not say whether an instance sharing the database was started during the restore, so the manager can't confirm that none read it while it was rebuilt"
        : `${startedMeanwhile.names.join(', ')} was started outside the manager during the restore and may act on what it read while the database was rebuilt; stop it`;
      setRestoreError(botId, file, reason, `The dump was restored, but the write fence stays on so nothing writes from what was read mid-restore (${back})`);
      return { success: false, error: `The dump was restored, but ${await keepFenced(reason, 'the restored database from what was read mid-restore', startedMeanwhile?.ids)}`, steps };
    }

    // 11. Lift the fence BEFORE the notice clear and the starts: the notice
    // stands until the database is writable again, and the instances come
    // back to a writable database. 'stripped' cleans only the persisted copy:
    // the LIVE cluster stays read-only until its container restarts.
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
    release();

    lastErrors.delete(familyKey(botId, 'main'));
    let noticeWarning = '';
    if (lift === 'lifted') {
      unsavedRestoreErrors.delete(botId);
      try {
        containerManager.updateInstanceFleetRestoreError(botId, null);
      } catch (err) {
        console.error(`[FleetBackup] Could not clear the restore notice for ${botId}: ${err}`);
        noticeWarning = '; the notice that this restore had not finished could not be cleared (dismiss it on the Database modal)';
      }
    } else {
      keepNotice(botId, file, restoreLiftNotice(`Restore of ${file} ran`, lift, layersHeld, fleetDb.volume, true), lift === 'gone');
    }

    // 12. Start the other instances stopped in step 3; the bot itself keeps its state.
    const unstarted: string[] = [];
    for (const id of steps.stopped) {
      if (id === botId) continue;
      const start = await asResult(containerManager.startBot(id));
      if (start.success) steps.restarted.push(id);
      else {
        unstarted.push(nameOf(id));
        console.error(`[FleetBackup] Failed to restart ${id} after restore: ${scrubbed(botId, start.error || 'unknown error')}`);
      }
    }
    const startWarning = unstarted.length > 0 ? `; these instances were stopped and could not be restarted: ${unstarted.join(', ')} (start them by hand)` : '';

    if (lift !== 'lifted') return { success: false, error: `${lift === 'gone' ? 'The restore ran' : 'Restored'}, but ${restoreLiftClause(lift, layersHeld, fleetDb.volume, true)} (see manager logs)${startWarning}`, steps };
    const warning = `${noticeWarning}${startWarning}`;
    return { success: true, ...(warning ? { warning: warning.slice(2) } : {}), steps };
  } finally {
    // The leftover-lift attempt must finish before the busy gate opens, or a
    // retry's fresh fence could be dissolved by this stale lift mid-restore.
    const leftover = fenced ? await liftAndTrack(botId, fleetDb, owner, 'a restore', RESTORE_RETRY_LIFT, BOTH_LAYERS, layersHeld) : null;
    settleNotice(leftover);
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
  schedulerStartedAt = Date.now();
  sweepUnfinished();
  try {
    backupCheck.recoverInterruptedTests();
  } catch (err) {
    console.error('[FleetBackup] The test restores a restart cut short could not be read:', err);
  }
  orphansRemoved = backupCheck.removeOrphanThrowaways().catch(err => {
    console.error('[FleetBackup] Test-restore leftover removal error:', err);
  });

  seedStuckFences().catch(err => {
    console.error('[FleetBackup] Stuck-fence seed error:', err);
  });

  intervalHandle = setInterval(() => {
    if (!containerManager.registryFault()) {
      try { fleetReplica.retryHeldSeedRecords(); } catch (err) { console.error('[FleetBackup] Held seed record retry error:', err); }
    }
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
