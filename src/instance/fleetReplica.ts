/**
 * Standby side of managed fleet database replication (PLAN_REPLICATION.md
 * Stage 2). Consumes the primary's copy block (replication DSN + pinned cert),
 * seeds a volume with pg_basebackup, hardens the seeded PGDATA (own server
 * cert for THIS machine's endpoint, verify-full primary_conninfo pointing at
 * an in-volume copy of the primary's cert), then injects and starts the
 * standby service in the instance's compose project.
 *
 * The replicator password is used during provisioning only; after that it
 * lives solely inside the standby's postgresql.auto.conf. The manager record
 * keeps endpoints, never credentials.
 */

import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as containerManager from '../docker/containerManager';
import * as dockerClient from '../docker/dockerClient';
import * as envManager from '../env/manager';
import * as fleetBackup from './fleetBackup';
import * as fleetFailback from './fleetFailback';
import { getBotDir, getDataPath } from '../git/repoManager';
import { getDeploymentMode } from '../casaos/detector';
import { generateCertPair, enableFleetReplication, REPLICATION_ROLE } from './fleetReplication';
import { findAppCapabilities, foldedRoleValue, CompanionDbSpec } from '../config/appCapabilities';
import { AppFacts, capabilityRefusal, getAppFacts, postureFromRead, publishCopyBlock, readStandInPosture, unansweredRemedy } from './appLifecycle';
import { hasAppHooks } from './appHookClient';
import { rescueRunnerLive } from './recoveryRescue';
import { probeErrorTail, redactSecrets } from '../config/secretText';
import { InstanceConfig, FleetDbReplicaRecord, FleetFailbackPhase, FleetFailbackRun, FleetReplicaAutoReseedLedger, FleetReplicaSeedPhase, FleetReplicaSeedPurpose, FleetReplicaSeedRecord } from '../types';
import { feedStdin } from '../docker/childStdin';

/** Every fleet standby's slot begins with this; the rest is the standby instance's id, so N standbys of one primary never collide (20.19 F1/F2). */
const FLEET_SLOT_PREFIX = 'fleet_standby';
/** The instance id is a lowercase uuid, so the name is always slot-legal (a-z, 0-9, _; 46 of 63 characters) and survives a rename. */
function slotNameFor(instance: InstanceConfig): string {
  return `${FLEET_SLOT_PREFIX}_${instance.id.replace(/-/g, '')}`;
}
const DEFAULT_HOST_PORT = 15432;
/** The app's own freshness window for the slot fact. */
const SLOT_FACT_FRESH_MS = 5 * 60_000;
/** Past this the standby's clock runs behind the primary's so far that a time-based lag is not shown. */
const CLOCK_SKEW_BOUND_SECONDS = 5;

/** A slot fact is fresh inside the app's window; one received in the future comes from a skewed clock and is not. */
export function slotFactFresh(receivedAt: unknown, now = Date.now()): boolean {
  const at = Number(receivedAt);
  return typeof receivedAt === 'number' && Number.isFinite(at) && at <= now && now - at <= SLOT_FACT_FRESH_MS;
}
const PGDATA = '/var/lib/postgresql/data';
const DATA_ROOT = process.env.DATA_ROOT || '/DATA';
const SEED_TIMEOUT_MS = 30 * 60 * 1000;
const PULL_TIMEOUT_MS = 10 * 60 * 1000;
/** Matches the slot reset below it: the same connection, so the same patience. */
const PROBE_TIMEOUT_MS = 60_000;
// Generous: volExec calls run under `docker run`, and slow disks are real.
const EXEC_TIMEOUT_MS = 120_000;
/** A docker read (inspect, ps): a hung CLI must not hold its caller; a timed-out read is unknown. */
const READ_TIMEOUT_MS = 30_000;

/** Attempts the automatic re-seed makes before it stops and asks (20.14). */
export const AUTO_RESEED_MAX_ATTEMPTS = 3;
/** Minimum spacing between automatic attempts, so a failing re-seed never re-fires on every health tick. */
const AUTO_RESEED_SPACING_MS = 30 * 60_000;
/** A facts read on the re-seed's entry must not hang it; the hook's default timeout is sized for a promote. */
const FACTS_TIMEOUT_MS = 10_000;

/** A node id as the fleet's own UI abbreviates it; the manager knows no node names. */
function shortId(id: string | null): string {
  return id ? id.slice(0, 8) : 'an unknown node';
}

/**
 * The seed in flight lives on the instance record, never in memory: a manager
 * restart mid-seed must still show the operation (parked, see
 * parkInterruptedReplicaSeeds) instead of losing it while the seed container
 * keeps running.
 */
function seedRecord(botId: string): FleetReplicaSeedRecord | null {
  return containerManager.getBot(botId)?.fleetDbReplicaSeed ?? null;
}

function saveSeed(botId: string, patch: Partial<FleetReplicaSeedRecord>): void {
  const current = seedRecord(botId);
  if (!current) return;
  const held = heldSeeds.get(botId);
  const kept = held && held.startedAt === current.startedAt && !held.done ? held.patch : {};
  containerManager.updateInstanceFleetDbReplicaSeed(botId, { ...current, ...kept, ...patch, updatedAt: Date.now() });
  heldSeeds.delete(botId);
}

function clearSeed(botId: string): void {
  containerManager.updateInstanceFleetDbReplicaSeed(botId, null);
  heldSeeds.delete(botId);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A seed write the registry refused, by seed: a patch the record still lacks
 * (a commit mark, a park), or the clear of a finished seed. Read into every
 * view of the seed and written again on the next health tick.
 */
type HeldSeed = { startedAt: number; patch: Partial<FleetReplicaSeedRecord>; done: boolean; writeError: string };
const heldSeeds = new Map<string, HeldSeed>();
/** What a finished seed left for the operator to do, by seed: shown on the standby panel until dismissed or a new seed starts. */
const seedNotes = new Map<string, { startedAt: number; text: string }>();
/** The standby record a failed first provision built and could not clear, by seed: cleared on the next health tick or the seed's Dismiss. */
const heldReplicaClears = new Map<string, { startedAt: number; containerName: string; writeError: string }>();

function replicaClearHeld(botId: string, startedAt: number): boolean {
  return heldReplicaClears.get(botId)?.startedAt === startedAt;
}

/** Clears the held standby record while it is still the one that seed built; throws when the registry refuses. */
function clearHeldReplica(botId: string): void {
  const held = heldReplicaClears.get(botId);
  if (!held) return;
  const bot = containerManager.getBot(botId);
  const rec = bot?.fleetDbReplica;
  if (!bot || bot.fleetDbReplicaSeed?.startedAt !== held.startedAt || !seedBuiltRecord(rec, held) || rec?.containerName !== held.containerName) {
    heldReplicaClears.delete(botId);
    return;
  }
  try {
    containerManager.updateInstanceFleetDbReplica(botId, null);
  } catch (err) {
    held.writeError = errorText(err);
    throw err;
  }
  heldReplicaClears.delete(botId);
}

function holdSeed(botId: string, startedAt: number, patch: Partial<FleetReplicaSeedRecord>, err: unknown, done = false): void {
  const prior = heldSeeds.get(botId);
  const merged = prior && prior.startedAt === startedAt && !prior.done ? { ...prior.patch, ...patch } : patch;
  heldSeeds.set(botId, { startedAt, patch: merged, done, writeError: errorText(err) });
  console.warn(`[FleetReplica] ${botId}: the seed record could not be written (${errorText(err)}); ${done ? 'the seed finished, and its record is cleared on the next health tick' : 'the change is held in memory and written again on the next health tick'}`);
}

/** saveSeed for a mark that must not be lost: a refusal is held, never thrown. */
function saveSeedOrHold(botId: string, patch: Partial<FleetReplicaSeedRecord>): void {
  const current = seedRecord(botId);
  if (!current) return;
  try {
    saveSeed(botId, patch);
  } catch (err) {
    holdSeed(botId, current.startedAt, patch, err);
  }
}

/** A finished seed whose record clear the registry refused. */
export function seedDone(instance: InstanceConfig): boolean {
  const seed = instance.fleetDbReplicaSeed;
  const held = heldSeeds.get(instance.id);
  return !!seed && !!held && held.done && held.startedAt === seed.startedAt;
}

/** The seed as every lane must read it: a finished one whose clear was refused is no seed, and a refused park or mark is merged in. */
export function seedView(instance: InstanceConfig): FleetReplicaSeedRecord | null {
  const seed = instance.fleetDbReplicaSeed ?? null;
  if (!seed || seedDone(instance)) return null;
  const held = heldSeeds.get(instance.id);
  const clear = heldReplicaClears.get(instance.id);
  const cleared = !!clear && clear.startedAt === seed.startedAt;
  if ((!held || held.startedAt !== seed.startedAt) && !cleared) return seed;
  const view = held && held.startedAt === seed.startedAt ? { ...seed, ...held.patch } : { ...seed };
  if (held && held.startedAt === seed.startedAt && held.patch.parked) view.lastError = `${held.patch.lastError || 'the seed stopped'}; its record could not be written (${held.writeError})`;
  if (view.parked && clear && cleared) {
    view.lastError = `${view.lastError || 'the seed stopped'}; the standby record could not be cleared (${clear.writeError}), so the manager clears it on its next health tick, and Dismiss clears it now`;
  }
  return view;
}

/** Health tick: write again what a seed could not. */
export function retryHeldSeedRecords(): void {
  for (const [botId, held] of [...heldSeeds]) {
    const seed = seedRecord(botId);
    if (!seed || seed.startedAt !== held.startedAt) { heldSeeds.delete(botId); continue; }
    try {
      if (held.done) clearSeed(botId);
      else saveSeed(botId, {});
    } catch (err) {
      held.writeError = errorText(err);
    }
  }
  for (const botId of [...heldReplicaClears.keys()]) {
    try {
      clearHeldReplica(botId);
    } catch {
      // Still held, under the new error; the next tick tries again.
    }
  }
}

/** The run on record now: a caller's snapshot can predate a Cancel or a Dismiss. */
function liveFailback(instance: InstanceConfig): FleetFailbackRun | null {
  const now = containerManager.getBot(instance.id);
  return (now ? now.fleetFailback : instance.fleetFailback) ?? null;
}

/** A seed a runner owns right now; a parked one blocks nothing. */
/**
 * A failback or drop-back run owns this instance's database lanes while it is
 * on record (20.5, B6-i): the by-hand routes would race the very steps it
 * sequences. Only the run itself (its startedAt token) passes.
 */
function runHold(instance: InstanceConfig, run?: number): string | null {
  const active = fleetFailback.failbackView(containerManager.getBot(instance.id) ?? instance);
  if (typeof run === 'number') {
    if (!active) return 'The failback run that asked is no longer on record (it was cancelled or dismissed); nothing was changed';
    if (active.startedAt === run) {
      return active.parked ? `The failback run that asked was stopped (${active.lastError || 'parked'}); nothing was changed` : null;
    }
  }
  if (!active) return null;
  const phase = fleetFailback.failbackPhaseText(active);
  if (active.finished) return `A ${active.mode} run finished on this instance, but its record is not cleared yet; Dismiss it on the Database modal first`;
  if (!active.parked) return `A ${active.mode} run is on this instance (${phase}); wait for it to park or finish (its card on the Database modal then shows its exits)`;
  if (active.phase === 'wipe-consent' && !active.consentAt) {
    return `A ${active.mode} run is on this instance (${phase}); answer it on the Database modal first (${active.mode === 'drop-back' ? 'Re-seed this copy' : 'Wipe and re-seed'}, or Cancel)`;
  }
  const exits = fleetFailback.cancelableFailback(instance) ? 'Continue, Cancel or Dismiss it' : 'Continue or Dismiss it';
  return `A ${active.mode} run is on this instance, stopped (${phase}); ${exits} on the Database modal first`;
}

function seedRunning(botId: string): boolean {
  const bot = containerManager.getBot(botId);
  const seed = bot ? seedView(bot) : null;
  return seed !== null && seed.parked !== true;
}

/** The standby record is the whole copy this seed built: refiled at 'starting', and nothing cleared it since. */
export function seedBuiltRecord(rec: FleetDbReplicaRecord | null | undefined, seed: Pick<FleetReplicaSeedRecord, 'startedAt'> | null | undefined): boolean {
  return !!rec && !!seed && rec.copyCleared !== true && typeof rec.seededBy === 'number' && rec.seededBy === seed.startedAt;
}

/**
 * Transfers asking the app to promote this instance's copy right now. The
 * request leaves no record while it waits, and removing the copy mid-promote
 * takes the fleet's next database away.
 */
const promotesInFlight = new Map<string, number>();

export async function whilePromoting<T>(botId: string, fn: () => Promise<T>): Promise<T> {
  promotesInFlight.set(botId, (promotesInFlight.get(botId) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    const left = (promotesInFlight.get(botId) ?? 1) - 1;
    if (left > 0) promotesInFlight.set(botId, left);
    else promotesInFlight.delete(botId);
  }
}

/** Why a Remove replica must not run now, from the live record; null when nothing is in flight. */
function removalHold(botId: string, containerName: string): string | null {
  const now = containerManager.getBot(botId);
  if (!now?.fleetDbReplica || now.fleetDbReplica.containerName !== containerName) {
    return 'The standby record changed while the removal was being checked; look again';
  }
  const held = runHold(now);
  if (held) return held;
  if (seedRunning(botId)) return 'A seed is running on this standby; wait for it to finish';
  const busyOp = containerManager.isBotBusy(botId);
  if (busyOp) return `Operation '${busyOp}' is running on this instance; wait for it to finish`;
  return promoteHold(now);
}

/** A transfer that is promoting, or may be promoting, this instance's copy. */
function promoteHold(instance: InstanceConfig): string | null {
  const run = instance.fleetTransfer;
  if (run && !run.parked) return `A transfer is running on this instance (${run.phase}); wait for it to finish`;
  if (run?.phase === 'promoting') {
    return 'A transfer stopped while the app was promoting this copy, and the app may still be promoting it; check its Fleet view, then Continue or Dismiss the transfer first';
  }
  if (promotesInFlight.has(instance.id)) return 'A Transfer is asking the app to promote this copy right now; wait for its answer';
  return null;
}

class SeedCancelled extends Error {}
/** The record the run was started for is gone or is a different standby now. */
class SeedSuperseded extends Error {}

function throwIfCancelled(botId: string): void {
  if (seedRecord(botId)?.cancelRequested === true) throw new SeedCancelled('cancelled by the operator');
}

function dockerRmForce(name: string): Promise<{ ok: boolean; stderr: string }> {
  return new Promise(resolve => {
    execFile('docker', ['rm', '-f', name], { timeout: EXEC_TIMEOUT_MS }, (err, _stdout, stderr) => {
      resolve({ ok: !err, stderr: String(stderr || err || '') });
    });
  });
}

/** A removal docker refused only because the container is already gone (or going) counts as done. */
function rmSettled(result: { ok: boolean; stderr: string }): boolean {
  return result.ok || /no such container|already in progress/i.test(result.stderr);
}

/** true, false, or null when docker could not say; a destructive step must refuse on null. */
function containerRunning(name: string): Promise<boolean | null> {
  return new Promise(resolve => {
    execFile('docker', ['inspect', '--format', '{{.State.Running}}', name], { timeout: EXEC_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (!err) return resolve(String(stdout).trim() === 'true');
      resolve(/no such object|no such container/i.test(String(stderr || err)) ? false : null);
    });
  });
}

/** Why the standby is not up, for a park reason: docker's own "not running", or what stopped the read. */
export function standbyDownText(status: Pick<FleetReplicaStatus, 'live' | 'probeError'>): string {
  return status.live ? 'the standby container is not running' : `the standby could not be probed (${status.probeError || 'no output'})`;
}

function seedContainerName(instance: InstanceConfig): string {
  return `${instance.sanitizedName}-fleet-replica-seed`;
}

function slotResetContainerName(instance: InstanceConfig): string {
  return `${seedContainerName(instance)}-slot`;
}

function primaryProbeContainerName(instance: InstanceConfig): string {
  return `${seedContainerName(instance)}-probe`;
}

function seedHelperNames(instance: InstanceConfig): string[] {
  return [seedContainerName(instance), slotResetContainerName(instance), `${slotResetContainerName(instance)}-drop`, primaryProbeContainerName(instance)];
}

/** One spelling of each purpose for the manager's own text. */
export function seedPurposeLabel(purpose: FleetReplicaSeedPurpose): string {
  if (purpose === 'reseed-standby') return 'Re-seeding the standby';
  if (purpose === 'reseed-stale-primary') return 'Re-seeding this database as a standby';
  return 'Provisioning the standby';
}

function patchLedger(botId: string, fn: (current: FleetReplicaAutoReseedLedger | undefined) => FleetReplicaAutoReseedLedger | undefined): void {
  const rec = containerManager.getBot(botId)?.fleetDbReplica;
  if (!rec) return;
  const { autoReseed: _drop, ...rest } = rec;
  const next = fn(rec.autoReseed);
  containerManager.updateInstanceFleetDbReplica(botId, next ? { ...rest, autoReseed: next } : rest);
}

function ledgerAttempt(botId: string, trigger: 'automatic' | 'operator'): void {
  patchLedger(botId, current => {
    const next: FleetReplicaAutoReseedLedger = { attempts: (current?.attempts ?? 0) + 1, lastAttemptAt: Date.now(), trigger };
    if (current?.lastSuccessAt) next.lastSuccessAt = current.lastSuccessAt;
    return next;
  });
}

function ledgerFailure(botId: string, error: string): void {
  patchLedger(botId, current => (current ? { ...current, lastError: error } : undefined));
}

/** Record that a re-seed retired this machine's own database; a refused save leaves Provision's role gate in force. */
function markOwnDbRetired(botId: string): void {
  try {
    containerManager.updateInstanceFleetOwnDbRetired(botId, new Date().toISOString());
  } catch (error) {
    console.warn(`[FleetReplica] ${botId}: could not record that its own database was retired: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Retire this node's stale database for a re-seed; a removed volume opens Provision's role gate even when the retire then failed. */
export async function retireStaleOwnDb(botId: string): Promise<Awaited<ReturnType<typeof containerManager.retireFleetDbSidecar>>> {
  const retired = await containerManager.retireFleetDbSidecar(botId);
  if (retired.success || retired.volumeRemoved) markOwnDbRetired(botId);
  return retired;
}

/** Record that this standby's copy is gone (or back), for readers that outlive the seed record. */
function setCopyCleared(botId: string, cleared: boolean): void {
  const rec = containerManager.getBot(botId)?.fleetDbReplica;
  if (!rec || rec.copyCleared === cleared) return;
  const { copyCleared: _drop, ...rest } = rec;
  containerManager.updateInstanceFleetDbReplica(botId, cleared ? { ...rest, copyCleared: true } : rest);
}

/** The ledger is a count for the automatic re-seed, never the seed's outcome: a refused write is logged. */
function ledgerOrWarn(botId: string, write: () => void): void {
  try {
    write();
  } catch (err) {
    console.warn(`[FleetReplica] ${botId}: the re-seed ledger could not be written: ${errorText(err)}`);
  }
}

function ledgerSuccess(botId: string): void {
  patchLedger(botId, current => ({ attempts: 0, lastAttemptAt: current?.lastAttemptAt ?? Date.now(), trigger: current?.trigger ?? 'automatic', lastSuccessAt: Date.now() }));
}

/** Record a run that ended while a cancel stood, wherever it ended. */
function settleCancelledSeed(botId: string, purpose: FleetReplicaSeedPurpose, committed: boolean): void {
  // Before the first irreversible step the cancel restores what was there,
  // so the record goes; after it the operator must be told what is gone.
  const stranded = committed && purpose !== 'provision';
  const what = !stranded
    ? 'cancelled by the operator'
    : purpose === 'reseed-standby'
      ? 'cancelled after the old copy was cleared, so this standby holds no usable copy until it is re-seeded or removed'
      : 'cancelled after the stale database was retired, so this node is now an ordinary worker without a standby (its pre-reseed dump is in the backups list if it succeeded)';
  // The attempt is already counted, so the ledger must carry its reason or
  // the modal keeps reporting an attempt that is no longer running.
  if (purpose === 'reseed-standby') ledgerOrWarn(botId, () => ledgerFailure(botId, what));
  if (!stranded) {
    clearSeed(botId);
    return;
  }
  saveSeed(botId, { parked: true, cancelRequested: false, cancelled: true, lastError: what });
}

/** What the automatic re-seed will still do for this standby: the attempts left and when the next may fire, or why none will. */
export function autoReseedOutlook(instance: InstanceConfig, now: number = Date.now()): FleetReplicaAutoReseedOutlook {
  const ledger = instance.fleetDbReplica?.autoReseed;
  const attempts = ledger?.attempts ?? 0;
  if (attempts >= AUTO_RESEED_MAX_ATTEMPTS) return { remaining: 0, nextAt: null, none: `it stopped after ${attempts} attempts; fix the cause, then use Re-seed now` };
  if (instance.fleetDbReplicaSeed?.cancelled === true) return { remaining: 0, nextAt: null, none: 'the last re-seed was cancelled, so nothing retries it; use Re-seed now when you want it' };
  if (instance.fleetFailback) return { remaining: 0, nextAt: null, none: `a ${instance.fleetFailback.mode} run holds this copy, so the automatic re-seed does not run until that run ends` };
  return { remaining: AUTO_RESEED_MAX_ATTEMPTS - attempts, nextAt: ledger ? Math.max(now, ledger.lastAttemptAt + AUTO_RESEED_SPACING_MS) : now, none: null };
}

export interface FleetReplicaAutoReseedOutlook {
  remaining: number;
  nextAt: number | null;
  /** Why no automatic attempt will fire; null while one may. */
  none: string | null;
}

/** Whether the automatic re-seed may fire for this standby: under the cap and past the spacing. */
export function autoReseedAllowed(rec: FleetDbReplicaRecord, now: number = Date.now()): boolean {
  const ledger = rec.autoReseed;
  if (!ledger) return true;
  return ledger.attempts < AUTO_RESEED_MAX_ATTEMPTS && now - ledger.lastAttemptAt >= AUTO_RESEED_SPACING_MS;
}

// 'absent' only when docker itself says "no such volume": any other failure
// (daemon down, spawn EAGAIN) is 'unknown', which the caller must refuse on -
// inferring absence from an arbitrary error skips a dump gate over real data.
export function dockerVolumeState(name: string): Promise<'exists' | 'absent' | 'unknown'> {
  return new Promise(resolve => {
    execFile('docker', ['volume', 'inspect', name], { timeout: READ_TIMEOUT_MS }, (err, _stdout, stderr) => {
      if (!err) return resolve('exists');
      resolve(String(stderr || '').toLowerCase().includes('no such volume') ? 'absent' : 'unknown');
    });
  });
}

/**
 * Why an existing volume must not be dumped as this record's database: a
 * retire that began earlier may have removed the original, and a volume made
 * after that (a compose up minting it again) is not the database the earlier
 * attempt dumped. Null when the volume predates the retire, or none began.
 */
function remintedVolumeRefusal(fleetDb: NonNullable<InstanceConfig['fleetDb']>): Promise<string | null> {
  if (!fleetDb.retiringAt) return Promise.resolve(null);
  const began = Date.parse(fleetDb.retiringAt);
  return new Promise(resolve => {
    execFile('docker', ['volume', 'inspect', '--format', '{{.CreatedAt}}', fleetDb.volume], { timeout: READ_TIMEOUT_MS }, (err, stdout) => {
      const created = err ? NaN : Date.parse(String(stdout).trim());
      if (Number.isNaN(created) || Number.isNaN(began)) {
        return resolve(`a removal of this database began at ${fleetDb.retiringAt}, and docker did not say when the volume ${fleetDb.volume} was created, so it cannot be told apart from one made after the removal; try again`);
      }
      resolve(created > began
        ? `the volume ${fleetDb.volume} was created after a removal of this database began at ${fleetDb.retiringAt}, so it is not the database that removal was meant for. Check what the volume holds, and remove it by hand if it holds nothing to keep`
        : null);
    });
  });
}

async function volExec(volume: string, script: string, stdin?: string, extraMounts: string[] = []): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  // Named for the same reason the seed is: killing the CLI leaves the
  // container running daemon-side, still writing inside the volume the next
  // seed is about to copy into.
  const helper = `${volume}-helper`;
  await dockerRmForce(helper);
  const args = ['run', '--rm', '--name', helper, ...(stdin !== undefined ? ['-i'] : []),
    '-v', `${volume}:${PGDATA}`, ...extraMounts.flatMap(m => ['-v', m]),
    '--entrypoint', 'sh', 'postgres:16-alpine', '-c', script];
  return new Promise(resolve => {
    const child = spawn('docker', args);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { void dockerRmForce(helper).then(() => child.kill('SIGKILL')); }, EXEC_TIMEOUT_MS);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, stdout, stderr: stderr || 'docker run failed' }); });
    child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, stdout, stderr }); });
    if (stdin !== undefined) feedStdin(child.stdin, stdin);
  });
}

function replicaExec(containerName: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile('docker', ['exec', containerName, ...args], { timeout: EXEC_TIMEOUT_MS }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr || err || '') });
    });
  });
}

interface ParsedDsn {
  user: string;
  password: string;
  host: string;
  port: number;
  db: string;
}

/** Strict parse of the copy-block DSN; conninfo re-emission needs a tame charset. */
function parsePrimaryDsn(dsn: string): { ok: true; parsed: ParsedDsn } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(dsn.trim());
  } catch {
    return { ok: false, error: 'DSN is not a valid URL' };
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    return { ok: false, error: 'DSN must be a postgresql:// URL' };
  }
  const parsed: ParsedDsn = {
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    host: url.hostname,
    port: Number(url.port) || 5432,
    db: (url.pathname || '').replace(/^\//, ''),
  };
  if (!parsed.user || !parsed.password) return { ok: false, error: 'DSN must carry the replication user and password' };
  if (!parsed.db) return { ok: false, error: 'DSN must name the database' };
  for (const [name, value] of [['user', parsed.user], ['password', parsed.password], ['host', parsed.host], ['database', parsed.db]] as const) {
    if (!/^[A-Za-z0-9._~-]+$/.test(value)) return { ok: false, error: `DSN ${name} contains unsupported characters` };
  }
  return { ok: true, parsed };
}

function certFilePath(botId: string): string {
  return path.join(getBotDir(botId), 'fleet-replica', 'primary-ca.crt');
}

/** The same file as certFilePath, spelled for the daemon that mounts it. */
function hostCertPathFor(botId: string): string {
  return `${containerManager.hostBotDirFor(botId)}/fleet-replica/primary-ca.crt`;
}

export interface FleetReplicaStatus {
  present: boolean;
  provisioning?: { startedAt: number; phase: FleetReplicaSeedPhase; purpose: FleetReplicaSeedPurpose; forSeconds: number; cancelable: boolean; cancelRequested: boolean; committed: boolean; safetyDump?: string };
  /** A seed no runner owns any more (it failed, or a manager restart interrupted it): Retry or Dismiss. */
  parkedSeed?: { startedAt: number; purpose: FleetReplicaSeedPurpose; phase: FleetReplicaSeedPhase; lastError: string; at: number; committed: boolean; cancelled: boolean; copyWhole: boolean; safetyDump?: string; pinsUnretired?: string[] };
  /** A retire of the database env pins left them in a compose it could not edit, and a compose still sets one the store does not hold. */
  pinsWarning?: string;
  /** What a finished seed left undone (its record clear, or the Apply mark), and the seed it belongs to, for Dismiss. */
  seedNote?: string;
  seedNoteStartedAt?: number;
  /** The automatic re-seed's attempt ledger, from the standby record. */
  autoReseed?: FleetReplicaAutoReseedLedger;
  /** The ledger hit the attempt cap: nothing re-fires until an operator asks. */
  autoReseedStopped?: boolean;
  /** The automatic attempts left and the next one's time, or why none will fire. */
  autoReseedOutlook?: FleetReplicaAutoReseedOutlook;
  lastError?: string;
  /** The standby could not be read (live stays absent): the last line docker or psql gave. */
  probeError?: string;
  record?: Pick<FleetDbReplicaRecord, 'containerName' | 'publicHost' | 'hostPort' | 'primaryHost' | 'primaryPort'>;
  live?: {
    running: boolean;
    inRecovery: boolean | null;
    receiverStatus: string | null;
    /** Everything received has been replayed. On an idle primary the
     * time-based lag below inflates; this is the honest signal. */
    caughtUp: boolean | null;
    /** now() minus the primary's last commit time: two clocks, so never negative, and null when they disagree past the bound. */
    replayLagSeconds: number | null;
    /** How far the standby's clock runs behind the primary's, when that is past the bound. */
    clockSkewSeconds?: number;
  };
}

export async function getFleetReplicaStatus(instance: InstanceConfig): Promise<FleetReplicaStatus> {
  const seed = seedView(instance);
  const status: FleetReplicaStatus = {
    present: !!instance.fleetDbReplica || (!!seed && !seed.parked),
    lastError: seed?.parked ? seed.lastError : undefined,
  };
  const held = heldSeeds.get(instance.id);
  const note = seedNotes.get(instance.id);
  if (seedDone(instance) && held) {
    status.seedNote = `The standby was provisioned; its seed record could not be cleared (${held.writeError}). The manager clears it on its next health tick, and Dismiss clears it now`;
    status.seedNoteStartedAt = held.startedAt;
  } else if (note && !seed) {
    status.seedNote = note.text;
    status.seedNoteStartedAt = note.startedAt;
  }
  if (seed && !seed.parked) {
    status.provisioning = {
      startedAt: seed.startedAt,
      phase: seed.phase,
      purpose: seed.purpose,
      forSeconds: Math.round((Date.now() - seed.startedAt) / 1000),
      cancelable: seed.phase === 'preparing' || seed.phase === 'seeding',
      cancelRequested: seed.cancelRequested === true,
      committed: seed.committed === true,
      ...(seed.safetyDump ? { safetyDump: seed.safetyDump } : {}),
    };
  } else if (seed) {
    status.parkedSeed = {
      startedAt: seed.startedAt,
      purpose: seed.purpose,
      phase: seed.phase,
      lastError: seed.lastError || 'stopped',
      at: seed.updatedAt,
      committed: seed.committed === true,
      cancelled: seed.cancelled === true,
      // A seed that stopped after its refile left the copy whole; at most its service is down.
      copyWhole: seedBuiltRecord(instance.fleetDbReplica, seed),
      ...(seed.safetyDump ? { safetyDump: seed.safetyDump } : {}),
      ...(seed.pinsUnretired?.length ? { pinsUnretired: seed.pinsUnretired } : {}),
    };
  }
  const pinsWarning = livePinsWarning(instance);
  if (pinsWarning) status.pinsWarning = pinsWarning;
  const rec = instance.fleetDbReplica;
  if (!rec) return status;
  if (rec.autoReseed) {
    status.autoReseed = rec.autoReseed;
    status.autoReseedStopped = rec.autoReseed.attempts >= AUTO_RESEED_MAX_ATTEMPTS;
  }
  status.autoReseedOutlook = autoReseedOutlook(instance);
  status.record = {
    containerName: rec.containerName,
    publicHost: rec.publicHost,
    hostPort: rec.hostPort,
    primaryHost: rec.primaryHost,
    primaryPort: rec.primaryPort,
  };
  // Identity from the STAMP, like every sibling; a record stamped before the
  // identity fields cannot be probed and says so instead of guessing a role.
  // status.live stays ABSENT (unknown), never a fabricated running:false -
  // consumers would read that as "container down", which is a different claim.
  if (!rec.user || !rec.db) {
    status.lastError = status.lastError || 'standby record predates identity stamping; retire and re-provision the standby';
    return status;
  }
  const probe = await replicaExec(rec.containerName, ['psql', '-U', rec.user, '-d', rec.db, '-Atc',
    `SELECT pg_is_in_recovery(),
            (SELECT status FROM pg_stat_wal_receiver LIMIT 1),
            (pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn()),
            COALESCE(EXTRACT(EPOCH FROM now() - pg_last_xact_replay_timestamp())::text, '');`]);
  if (probe.ok) {
    const [inRec, recv, caught, lag] = probe.stdout.trim().split('|');
    const rawLag = lag ? Number(lag) : null;
    const skewed = rawLag !== null && rawLag < -CLOCK_SKEW_BOUND_SECONDS;
    status.live = {
      running: true,
      inRecovery: inRec === 't',
      receiverStatus: recv || null,
      caughtUp: caught === '' ? null : caught === 't',
      replayLagSeconds: rawLag === null || !Number.isFinite(rawLag) || skewed ? null : Math.max(0, rawLag),
      ...(skewed ? { clockSkewSeconds: Math.round(-rawLag) } : {}),
    };
  } else {
    const running = await containerRunning(rec.containerName);
    if (running === false) {
      status.live = { running: false, inRecovery: null, receiverStatus: null, caughtUp: null, replayLagSeconds: null };
    } else {
      status.probeError = probeErrorTail(probe.stderr);
    }
  }
  return status;
}

interface ValidatedIntake {
  dsn: ParsedDsn;
  cert: string;
  host: string;
  port: number;
}

/** A port collision cannot be ruled out while the registry, the only list of ports in use here, cannot be read. */
function portUnconfirmed(port: number): string | null {
  const fault = containerManager.registryFault();
  return fault ? `Host port ${port} cannot be confirmed free, so nothing was changed: ${fault}` : null;
}

/** Shape checks shared by both intake paths, so the two cannot drift apart. */
function validateIntake(
  primaryDsn: string,
  certPem: string,
  publicHost: string,
  hostPort: number | undefined,
): { ok: true; intake: ValidatedIntake } | { ok: false; error: string } {
  const dsn = parsePrimaryDsn(primaryDsn);
  if (!dsn.ok) return { ok: false, error: dsn.error };
  const cert = certPem.trim();
  if (!/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$/.test(cert)) {
    return { ok: false, error: 'Certificate must be a PEM certificate block' };
  }
  const host = publicHost.trim();
  if (!host || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host)) {
    return { ok: false, error: 'Public host must be a bare hostname or IPv4 address' };
  }
  const port = hostPort ?? DEFAULT_HOST_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'Invalid port' };
  return { ok: true, intake: { dsn: dsn.parsed, cert, host, port } };
}

function replicaRecordFor(instance: InstanceConfig, intake: ValidatedIntake): FleetDbReplicaRecord {
  // Identity stamped from the capability record at provisioning time (the
  // standby is a byte copy of that app's database); the DSN's own user is the
  // replication login, not the app identity.
  const spec = findAppCapabilities(instance.sourceUrl)?.companionDb;
  return {
    containerName: `${instance.sanitizedName}-fleet-postgres-replica`,
    volume: `${instance.sanitizedName}-fleet-postgres-replica-data`,
    slot: slotNameFor(instance),
    primaryHost: intake.dsn.host,
    primaryPort: intake.dsn.port,
    publicHost: intake.host,
    hostPort: intake.port,
    certHost: intake.host,
    ...(spec ? { user: spec.user, db: spec.database } : {}),
  };
}

/**
 * Hand the seed to the op lock and return; callers poll status. `preflight`
 * runs inside the lock before the seed, which is what lets a re-seed retire
 * the stale primary without racing a start or a rebuild.
 */
function startProvisioning(
  instance: InstanceConfig,
  record: FleetDbReplicaRecord,
  intake: ValidatedIntake,
  purpose: FleetReplicaSeedPurpose,
  preflight?: () => Promise<void>,
  onSettled?: () => void,
  confirmVolume?: string,
): { success: boolean; error?: string } {
  // The busy check, the record write and the lock claim share one synchronous
  // segment: a second entrant that wrote the record and only then lost the
  // lock would park the record the winner is running under.
  const busyOp = containerManager.isBotBusy(instance.id);
  if (busyOp) return { success: false, error: `Operation '${busyOp}' is running on this instance; wait for it to finish` };
  const now = Date.now();
  // committed describes the VOLUME, not this run: a re-seed starting over a
  // stopped one whose wipe already ran inherits it, so the cancel warning does
  // not lapse while the copy is still gone. A stopped run that refiled the
  // standby whole leaves nothing gone, so it passes nothing on.
  const prior = seedRecord(instance.id);
  const priorRecord = containerManager.getBot(instance.id)?.fleetDbReplica;
  const inherited = priorRecord?.copyCleared === true
    || (prior?.committed === true && !seedBuiltRecord(priorRecord, prior));
  try {
    containerManager.updateInstanceFleetDbReplicaSeed(instance.id, {
      purpose,
      phase: 'preparing',
      startedAt: now,
      updatedAt: now,
      ...(inherited ? { committed: true } : {}),
      publicHost: record.publicHost,
      hostPort: record.hostPort,
      primaryHost: record.primaryHost,
      primaryPort: record.primaryPort,
      slot: record.slot,
    });
  } catch (err) {
    return { success: false, error: `The seed did not start: its record could not be saved (${errorText(err)}); nothing was cleared or stopped` };
  }
  heldSeeds.delete(instance.id);
  heldReplicaClears.delete(instance.id);
  seedNotes.delete(instance.id);
  const ownsRecord = (): boolean => seedRecord(instance.id)?.startedAt === now;
  void containerManager.withExternalBotOp(instance.id, 'replica-seed', async () => {
    throwIfCancelled(instance.id);
    // Ahead of the preflight, which is where every lane destroys: a refusal
    // here has changed nothing and stays retryable.
    await assertSeedableSource(instance, intake.dsn, intake.cert);
    // The probe can take a minute, and the preflight past it destroys; a cancel
    // filed while it ran is honoured here, with everything still in place.
    throwIfCancelled(instance.id);
    assertVolumeOwnedHere(instance.id, record.volume);
    if (preflight) await preflight();
    try {
      await runProvisioning(instance, record, intake.dsn, intake.cert, purpose, confirmVolume);
    } catch (err) {
      // A record still naming this slot means the standby's own copy survived
      // and may yet stream on it; anything else leaves it retaining WAL for a
      // copy that does not exist.
      if (containerManager.getBot(instance.id)?.fleetDbReplica?.slot !== record.slot || replicaClearHeld(instance.id, now)) {
        await dropInactiveSlot(instance, intake.dsn, hostCertPathFor(instance.id), record.slot);
      }
      throw err;
    }
  }).then(() => {
    if (!ownsRecord()) return;
    try {
      clearSeed(instance.id);
    } catch (err) {
      holdSeed(instance.id, now, {}, err, true);
    }
    if (purpose === 'reseed-standby') ledgerOrWarn(instance.id, () => ledgerSuccess(instance.id));
  }, err => {
    if (!ownsRecord()) return;
    const message = String(err instanceof Error ? err.message : err);
    try {
      // Nothing of this instance's is left to retry or dismiss.
      if (err instanceof SeedSuperseded) {
        clearSeed(instance.id);
        return;
      }
      const viewed = containerManager.getBot(instance.id);
      const seed = viewed ? seedView(viewed) : null;
      if (err instanceof SeedCancelled || seed?.cancelRequested === true) {
        settleCancelledSeed(instance.id, purpose, seed?.committed === true);
        return;
      }
      if (purpose === 'reseed-standby') ledgerOrWarn(instance.id, () => ledgerFailure(instance.id, message));
      saveSeed(instance.id, { parked: true, lastError: message });
    } catch (writeErr) {
      holdSeed(instance.id, now, { parked: true, lastError: err instanceof SeedSuperseded ? `${message}; nothing is left to retry, so Dismiss this` : message }, writeErr);
    }
  }).finally(() => {
    onSettled?.();
    containerManager.broadcastBotUpdated(instance.id);
  });
  return { success: true };
}

/**
 * Kick off provisioning (async; poll status). Refuses when a record already
 * exists (remove first) or when the host port collides with any other managed
 * database on this manager, and asks before clearing a replica volume that
 * already exists.
 */
const FAILBACK_PAST_WIPE: ReadonlySet<FleetFailbackPhase> = new Set(['seeding', 'applying', 'catching-up', 'promoting', 'adopting', 'restarting']);

export function provisionFleetReplica(
  instance: InstanceConfig,
  primaryDsn: string,
  certPem: string,
  publicHost: string,
  hostPort?: number,
  confirm?: boolean,
  opts: { run?: number; confirmVolume?: string } = {},
): { success: boolean; error?: string; started?: boolean; needsConfirm?: boolean; confirmVolume?: string } {
  const held = runHold(instance, opts.run);
  if (held) return { success: false, error: held };
  if (instance.fleetDbReplica) return { success: false, error: 'A replica already exists on this instance - remove it first' };
  if (seedRunning(instance.id)) return { success: false, error: 'Provisioning is already running' };
  const busyOp = containerManager.isBotBusy(instance.id);
  if (busyOp) return { success: false, error: `Operation '${busyOp}' is running on this instance; wait for it to finish` };
  // Null record routes through refusal, never a silent degrade: the standby
  // record's identity is stamped from the capability record, so without one
  // the minted record could never be probed or adopted.
  if (!findAppCapabilities(instance.sourceUrl)?.companionDb) {
    return { success: false, error: 'This app declares no managed database companion' };
  }
  // A standby lives beside a fleet WORKER (R7): an instance with its own
  // managed database is the primary side, and a non-fleet bot has no use for
  // a fleet replica.
  if (instance.fleetDb) return { success: false, error: 'This instance hosts the fleet database itself - replication is managed from its Database modal' };
  const controlPlane = findAppCapabilities(instance.sourceUrl)?.controlPlane;
  if (!controlPlane) {
    return { success: false, error: 'This app declares no fleet control plane - a standby belongs beside a fleet worker' };
  }
  const folded = foldedRoleValue(controlPlane.roleEnv, instance.envVars?.[controlPlane.roleEnv.key]);
  // The failback run's own seed is exempt: a returning master keeps its master
  // role by design and mid-failback follows another node's database by
  // posture, which is what this gate asserts. Keyed on the record, not the
  // bare token, so only the run on this instance holds it.
  const inRun = typeof opts.run === 'number' && liveFailback(instance)?.startedAt === opts.run;
  // So is the state a dismissed failback leaves once its seed retired this
  // machine's own database (a decline recorded at seeding or later): the node
  // still follows another node's database by posture, and this lane is the
  // by-hand exit the run's park text names. The settle clears the decline.
  // A re-seed as a stale primary that retired this machine's own database leaves the same posture, run or no run.
  const afterRetire = (instance.fleetFailbackDeclined?.mode === 'failback' && FAILBACK_PAST_WIPE.has(instance.fleetFailbackDeclined.phase))
    || (!!instance.fleetOwnDbRetiredAt && !instance.fleetDb);
  if (!inRun && !afterRetire && !controlPlane.roleEnv.dialsOut.includes(folded)) {
    return { success: false, error: `A replica belongs beside a fleet worker (set ${controlPlane.roleEnv.key} to ${controlPlane.roleEnv.dialsOut.join(' or ')} first)` };
  }
  if (!containerManager.deployedComposeExists(instance.id)) {
    return { success: false, error: 'Install/build the instance first - the standby joins its compose project' };
  }

  const validated = validateIntake(primaryDsn, certPem, publicHost, hostPort);
  if (!validated.ok) return { success: false, error: validated.error };
  const { dsn: parsedDsn, port } = validated.intake;
  const registryUnread = portUnconfirmed(port);
  if (registryUnread) return { success: false, error: registryUnread };
  const collision = containerManager.getAllBots().find(other =>
    other.fleetDb?.replication?.hostPort === port
    || (other.id !== instance.id && other.fleetDbReplica?.hostPort === port)
    || other.recoveryChannel?.tunnelPort === port);
  if (collision) {
    return { success: false, error: `Host port ${port} is already used by "${collision.displayName}" - pick another` };
  }
  // R2, downgraded to a warning by 20.19 F7: the DSN pointing at a replication
  // endpoint THIS manager provisioned means the primary lives here, which is a
  // weaker standby but a shape 20.9 lists, so the operator owns the trade.
  const samehost = containerManager.getAllBots().find(other => {
    const repl = other.fleetDb?.replication;
    return repl && repl.publicHost === parsedDsn.host && repl.hostPort === parsedDsn.port;
  });
  if (samehost && !confirm) {
    return { success: false, needsConfirm: true, error: `That primary ("${samehost.displayName}") lives on THIS machine, so a standby here survives that database's container dying but not this machine dying. That shape is allowed. Check the standby reports streaming once it finishes: a container that shares a docker network with the primary's sidecar cannot always reach its published port, and the copy can seed over a path the running standby does not have` };
  }

  const record = replicaRecordFor(instance, validated.intake);
  // The failback's wipe consent covers this volume: its stale-primary seed
  // clears the same volume unasked, and a retry after that seed parked
  // finds the volume it made.
  const confirmVolume = inRun && typeof liveFailback(instance)?.consentAt === 'number' ? record.volume : opts.confirmVolume;
  const volumeRefusal = provisionVolumeRefusal(instance, record.volume, confirmVolume);
  if (volumeRefusal) return { success: false, ...volumeRefusal };

  // The op lock keeps start/rebuild/delete away from the minutes-long seed
  // (and vice versa: the busy check above refuses while one of those runs).
  const started = startProvisioning(instance, record, validated.intake, 'provision', undefined, undefined, confirmVolume);
  if (!started.success) return started;
  return { success: true, started: true };
}

/**
 * Provision the first standby from the copy block the bot itself holds (a
 * designated backup receives it on register, 20.14), so a joined machine
 * needs no paste. Every guard is provisionFleetReplica's; only where the
 * intake comes from differs.
 */
export async function provisionFleetReplicaFromFacts(
  instance: InstanceConfig,
  publicHost: string,
  hostPort?: number,
  confirm?: boolean,
  confirmVolume?: string,
): Promise<{ success: boolean; error?: string; started?: boolean; needsConfirm?: boolean; confirmVolume?: string }> {
  const held = runHold(instance);
  if (held) return { success: false, error: held };
  if (instance.fleetDbReplica) return { success: false, error: 'A replica already exists on this instance - remove it first' };
  if (!hasAppHooks(instance)) return { success: false, error: 'This app declares no lifecycle hooks, so the manager cannot read the copy block from it; paste the block instead' };
  const facts = await getAppFacts(instance, FACTS_TIMEOUT_MS);
  if (!facts.success) return { success: false, error: `Could not read the copy block from the app: ${facts.error}` };
  const block = facts.facts?.copyBlock;
  if (!block?.dsn || !block.cert) {
    return { success: false, error: 'The bot holds no copy block (only a designated backup receives one from the master); paste the block from the primary machine instead' };
  }
  // The app's own verdict: a block inherited from a former master names a
  // fenced database, and a standby seeded from it would follow the wrong side.
  if (facts.facts?.copyBlockCurrent === false) {
    return { success: false, error: 'The block this node holds names a database that is not the one the fleet follows now (it came from a former master). The current primary\'s block reaches this node only at its next registration with that primary, once that primary\'s manager has published it (opening its Replication section does): restart this bot after that, or paste that block instead' };
  }
  if (facts.facts?.copyBlockCurrent !== true) {
    return { success: false, error: 'The app did not say whether its block is current; paste the block from the primary machine instead' };
  }
  return provisionFleetReplica(instance, block.dsn, block.cert, publicHost, hostPort, confirm, { confirmVolume });
}

/**
 * pg_basebackup ends a failed run with its cleanup notice ("removing contents
 * of data directory"), so the cause is its error line, never its last line.
 */
function seedFailureLine(stderr: string, password: string): string {
  const lines = stderr.trim().split('\n').map(l => l.trim()).filter(Boolean);
  const line = lines.find(l => /error/i.test(l)) || lines[0] || 'no output (killed or timed out)';
  return line.split(password).join('***');
}

function seedDsnFor(dsn: ParsedDsn): string {
  return `postgresql://${encodeURIComponent(dsn.user)}@${dsn.host}:${dsn.port}/${dsn.db}?sslmode=verify-full&sslrootcert=/primary-ca.crt`;
}

/**
 * A libpq client run against the primary in a throwaway container. The
 * password reaches it as PGPASSWORD from the docker CLI's own environment
 * (`-e NAME` with no value), so it is in no command line on either side.
 * On timeout the container is removed by name: a signal to the CLI is
 * proxied to the client as PID 1, which drops it, and the container runs
 * daemon-side.
 */
function runPrimaryClient(name: string, dsn: ParsedDsn, mounts: string[], entrypoint: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string }> {
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

/**
 * Prove the source can be seeded from BEFORE any lane destroys anything. Every
 * preflight is destructive (the stale-primary one retires the sidecar and its
 * volume, the standby one strips the standby service out of the compose), and
 * both run ahead of the seed, so a re-seed aimed at a database that is gone
 * would otherwise consume the surviving copy and discover that second. Runs
 * the connection the seed itself uses, so a source this rejects could not have
 * been seeded from anyway.
 *
 * The cert write and the image pull belong here for the same reason: the probe
 * needs both, and doing the pull first keeps the later short-timeout runs from
 * absorbing a multi-minute pull.
 */
async function assertSeedableSource(instance: InstanceConfig, dsn: ParsedDsn, certPem: string): Promise<void> {
  // The primary's pinned cert: kept on disk for re-provisioning and mounted
  // into the seeding container; the standby's runtime copy lives in PGDATA.
  const certPath = certFilePath(instance.id);
  fs.mkdirSync(path.dirname(certPath), { recursive: true });
  fs.writeFileSync(certPath, certPem.endsWith('\n') ? certPem : certPem + '\n');
  const hostCertPath = hostCertPathFor(instance.id);

  const pulled = await new Promise<{ ok: boolean; stderr: string }>(resolve => {
    execFile('docker', ['pull', 'postgres:16-alpine'], { timeout: PULL_TIMEOUT_MS }, (err, _o, stderr) => {
      resolve({ ok: !err, stderr: String(stderr || err || '') });
    });
  });
  if (!pulled.ok) throw new Error(`could not pull postgres:16-alpine: ${pulled.stderr.trim().split('\n').pop()}`);
  throwIfCancelled(instance.id);

  const probeName = primaryProbeContainerName(instance);
  await dockerRmForce(probeName);
  const probe = await runPrimaryClient(probeName, dsn, [`${hostCertPath}:/primary-ca.crt:ro`], 'psql',
    [seedDsnFor(dsn), '-v', 'ON_ERROR_STOP=1', '-Atc', 'SELECT pg_is_in_recovery()'], PROBE_TIMEOUT_MS);
  // committed describes the VOLUME, so a retry over an attempt that already
  // wiped inherits it: the reassurance below would be a lie on exactly the
  // record that most needs the truth.
  const intact = seedRecord(instance.id)?.committed !== true ? ', so nothing has been changed' : '';

  if (!probe.ok) {
    // FIRST line, not last: a refused or timed-out connection puts the reason
    // there ("... failed: Connection refused") and a generic hint after it,
    // and this lane exists for exactly that failure.
    const lines = probe.stderr.trim().split('\n').map(l => l.trim()).filter(Boolean);
    const reason = (lines.find(l => l.startsWith('ERROR')) || lines[0] || 'psql failed').split(dsn.password).join('***');
    throw new Error(`could not verify the primary at ${dsn.host}:${dsn.port}${intact}: ${reason}`);
  }
  // A source in recovery is a standby: seeding from it would copy a follower,
  // and the slot this seed needs cannot be minted there.
  if (probe.stdout.trim() !== 'f') {
    throw new Error(`the source at ${dsn.host}:${dsn.port} is itself following a primary${intact}; seed from the machine that now serves the fleet`);
  }
}

/** What the first provision would clear, worded for its confirm; names what Remove replica recorded about the volume. */
function keptVolumeQuestion(instance: InstanceConfig, volume: string): string {
  const kept = instance.fleetDbReplicaKept?.volume === volume ? instance.fleetDbReplicaKept : null;
  const held = !kept ? 'Nothing on record says what it holds; a volume left by Remove replica can be a promoted copy with writes no other database has'
    : kept.held === 'promoted' ? `Remove replica left it on ${kept.removedAt.slice(0, 10)}, and the copy in it had been promoted, so it may hold writes no other database has`
      : kept.held === 'standby' ? `Remove replica left it on ${kept.removedAt.slice(0, 10)}, when it held a standby copy that was still following its primary`
        : `Remove replica left it on ${kept.removedAt.slice(0, 10)}, while its container was not running, so what it held then is unknown`;
  return `The replica volume ${volume} already exists, and provisioning clears everything in it for good. ${held}`;
}

/** The volume a first provision may clear: used by no other instance, and proven absent or the one the operator's confirm named. */
function provisionVolumeRefusal(instance: InstanceConfig, volume: string, confirmVolume: string | undefined): { error: string; needsConfirm?: true; confirmVolume?: string } | null {
  const shared = containerManager.sharedVolumeReason(volume, instance.id);
  if (shared) return { error: `Provisioning would clear the replica volume ${volume}, and ${shared}; nothing was started` };
  const state = dockerClient.volumeState(volume);
  if (state === 'absent') return null;
  if (state === 'unknown') return { error: `Docker did not say whether the replica volume ${volume} exists, so the manager can't confirm provisioning would clear nothing; nothing was started, try again` };
  if (confirmVolume === volume) return null;
  return { error: keptVolumeQuestion(instance, volume), needsConfirm: true, confirmVolume: volume };
}

/** The seed clears the volume whole, so a volume another instance uses or declares is refused, and so is one that cannot be checked. */
function assertVolumeOwnedHere(botId: string, volume: string): void {
  const shared = containerManager.sharedVolumeReason(volume, botId);
  if (shared) throw new Error(`the seed stopped before clearing the replica volume ${volume}: ${shared}`);
}

async function runProvisioning(instance: InstanceConfig, record: FleetDbReplicaRecord, dsn: ParsedDsn, certPem: string, purpose: FleetReplicaSeedPurpose, confirmVolume?: string): Promise<void> {
  const hostCertPath = hostCertPathFor(instance.id);
  const seedName = seedContainerName(instance);

  // A ghost seeder from a previous timeout or a manager restart mid-seed still
  // holds the volume: kill it before touching anything.
  await dockerRmForce(seedName);

  const seedDsn = seedDsnFor(dsn);
  const certMount = `${hostCertPath}:/primary-ca.crt:ro`;

  // Whatever the volume holds is superseded here: manager debris on a first
  // provision, and on a re-seed the verified-stale copy 20.14 rules wipeable.
  // Past this point cancelling cannot put it back.
  throwIfCancelled(instance.id);
  assertVolumeOwnedHere(instance.id, record.volume);
  if (purpose !== 'reseed-standby') {
    // Asked again here: the request's check was minutes ago, and a volume made
    // since then was never part of what the operator confirmed.
    const stopped = purpose === 'provision' ? 'the seed stopped before clearing anything'
      : 'the seed stopped before clearing the replica volume (this machine\'s stale database was already retired)';
    const state = await dockerVolumeState(record.volume);
    if (state === 'unknown') throw new Error(`${stopped}: docker did not say whether the replica volume ${record.volume} exists`);
    if (state === 'exists' && confirmVolume !== record.volume) {
      const remedy = purpose === 'provision' ? 'Provision again and confirm to clear it' : 'Provisioning the standby asks again before it clears the volume';
      throw new Error(`${stopped}: ${keptVolumeQuestion(containerManager.getBot(instance.id) ?? instance, record.volume)}. ${remedy}`);
    }
  }
  saveSeed(instance.id, { committed: true });
  setCopyCleared(instance.id, true);
  const wipe = await volExec(record.volume, `find ${PGDATA} -mindepth 1 -maxdepth 1 -exec rm -rf {} +`);
  if (!wipe.ok) throw new Error(`could not clear the replica volume: ${wipe.stderr.trim()}`);
  throwIfCancelled(instance.id);

  // The slot is this standby's own (20.19 F1) and is minted here when missing:
  // the replicator role may create slots, and enable mints none. A slot the
  // WAL bound invalidated stays invalidated for good (a seed on it streams but
  // retains nothing and loses it again at the first blip), so an inactive lost
  // or unreserved one is re-created. A live one is left alone: pg_basebackup
  // then fails on the active slot, which is the truth about it. A primary whose
  // replication was disabled refuses earlier, at the login disable revoked.
  const resetName = slotResetContainerName(instance);
  await dockerRmForce(resetName);
  const slotReset = await runPrimaryClient(resetName, dsn, [certMount], 'psql', [seedDsn, '-v', 'ON_ERROR_STOP=1', '-Atc', `
      DO $$ DECLARE s record; BEGIN
        SELECT active, wal_status INTO s FROM pg_replication_slots WHERE slot_name = '${record.slot}';
        IF NOT FOUND THEN
          PERFORM pg_create_physical_replication_slot('${record.slot}');
        ELSIF NOT s.active AND s.wal_status IN ('lost', 'unreserved') THEN
          PERFORM pg_drop_replication_slot('${record.slot}');
          PERFORM pg_create_physical_replication_slot('${record.slot}');
        END IF;
      END $$;`], 60_000);
  if (!slotReset.ok) {
    // psql prints ERROR, DETAIL and CONTEXT lines; the ERROR line is the one
    // to show, never with the DSN's password should it ever be echoed.
    const lines = slotReset.stderr.trim().split('\n');
    const reason = (lines.find(l => l.startsWith('ERROR')) || lines.pop() || 'psql failed').split(dsn.password).join('***');
    throw new Error(`could not prepare the replication slot on the primary: ${reason}`);
  }

  throwIfCancelled(instance.id);
  saveSeed(instance.id, { phase: 'seeding' });
  // A timeout removes the container by name, which also frees the volume and
  // the primary's walsender it holds.
  const seed = await runPrimaryClient(seedName, dsn, [`${record.volume}:${PGDATA}`, certMount], 'pg_basebackup',
    ['-d', seedDsn, '-D', PGDATA, '-X', 'stream', '-R', '-S', record.slot, '--checkpoint=fast'], SEED_TIMEOUT_MS);
  if (!seed.ok) {
    // The slot minted above would retain WAL on the primary for a copy that
    // does not exist; dropped while inactive, and the next attempt mints again.
    await dropInactiveSlot(instance, dsn, hostCertPath, record.slot);
    throw new Error(`pg_basebackup failed: ${seedFailureLine(seed.stderr, dsn.password)}`);
  }

  throwIfCancelled(instance.id);
  saveSeed(instance.id, { phase: 'configuring' });

  // Runtime trust: the primary's cert moves INTO the volume and a keyword-form
  // primary_conninfo (last one wins in auto.conf) repoints verify-full at it -
  // the seed-time /primary-ca.crt mount does not exist once the service runs.
  const put = await volExec(record.volume, `cat > ${PGDATA}/primary-ca.crt && chown postgres:postgres ${PGDATA}/primary-ca.crt`, certPem);
  if (!put.ok) throw new Error(`cert install failed: ${put.stderr.trim()}`);
  // Two settings are inherited from the primary's auto.conf and are actively
  // wrong on a copy (B6 map F18, E3): an armed synchronous_standby_names names
  // standbys this cluster does not have, so its first write after any promotion
  // hangs with the database reporting healthy; and a promote fence leaves the
  // copy read-only at its own next promotion; a primary fenced during the copy
  // passes on the pg_hba lines that refuse every outside connection. Stripped,
  // never reset, because the copy is not running yet.
  const strip = await volExec(record.volume, `sed -i '/^synchronous_standby_names/d;/^default_transaction_read_only/d' ${PGDATA}/postgresql.auto.conf && ${fleetBackup.stripFenceHbaScript(PGDATA)}`);
  if (!strip.ok) throw new Error(`could not strip the primary's own settings from the copy: ${strip.stderr.trim()}`);
  // application_name is the slot name, so the primary's own status ties a
  // streaming link to its slot without reading process ids.
  const conninfo = `user=${dsn.user} password=${dsn.password} host=${dsn.host} port=${dsn.port} sslmode=verify-full sslrootcert=${PGDATA}/primary-ca.crt application_name=${record.slot}`;
  const conf = await volExec(record.volume, `cat >> ${PGDATA}/postgresql.auto.conf`, `primary_conninfo = '${conninfo}'\n`);
  if (!conf.ok) throw new Error(`primary_conninfo write failed: ${conf.stderr.trim()}`);

  // The byte-copied PGDATA carries the PRIMARY's server cert (naming the
  // primary's host); replace it with one naming THIS machine's endpoint.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-replica-cert-'));
  try {
    const gen = await generateCertPair(dir, record.publicHost);
    if (!gen.ok) throw new Error(`standby cert generation failed: ${gen.error}`);
    for (const file of ['server.key', 'server.crt']) {
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');
      const res = await volExec(record.volume, `cat > ${PGDATA}/${file} && chown postgres:postgres ${PGDATA}/${file} && chmod 600 ${PGDATA}/${file}`, content);
      if (!res.ok) throw new Error(`standby cert install failed (${file}): ${res.stderr.trim()}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  saveSeed(instance.id, { phase: 'starting' });
  // The record can be removed at any point during the minutes this takes, and
  // writing the snapshot back here would silently undo that removal.
  const current = containerManager.getBot(instance.id)?.fleetDbReplica;
  if (purpose === 'reseed-standby' && (!current || current.containerName !== record.containerName || current.volume !== record.volume)) {
    throw new SeedSuperseded('the standby record was removed while the re-seed ran');
  }
  const ledger = current?.autoReseed;
  // The copy is byte-complete here, so it goes back whole. Stripped explicitly:
  // a retry was handed the record an earlier attempt had already marked.
  const { copyCleared: _whole, ...restored } = record;
  // The seed that built it, by identity: the run that asked reads it back.
  const builtBy = seedRecord(instance.id)?.startedAt;
  const rebuilt = { ...restored, seededAt: Date.now(), ...(typeof builtBy === 'number' ? { seededBy: builtBy } : {}) };
  containerManager.updateInstanceFleetDbReplica(instance.id, ledger ? { ...rebuilt, autoReseed: ledger } : rebuilt);
  if (containerManager.getBot(instance.id)?.fleetDbReplicaKept?.volume === record.volume) containerManager.updateInstanceFleetDbReplicaKept(instance.id, null);
  const apply = await containerManager.applyFleetDbReplicaService(instance.id);
  if (!apply.success) {
    // A first provision leaves no half record behind; either re-seed keeps the
    // standby's record, because the copy is complete and only its service is
    // down, and the record is what makes a rebuild re-inject that service.
    if (purpose === 'provision') {
      try {
        containerManager.updateInstanceFleetDbReplica(instance.id, null);
      } catch (err) {
        if (typeof builtBy !== 'number') throw new Error(`standby service start failed: ${apply.error}; the standby record could not be cleared (${errorText(err)}), so Remove replica clears it`);
        heldReplicaClears.set(instance.id, { startedAt: builtBy, containerName: record.containerName, writeError: errorText(err) });
        console.warn(`[FleetReplica] ${instance.id}: the standby record could not be cleared after its service failed to start (${errorText(err)}); it is cleared on the next health tick`);
      }
    }
    throw new Error(`standby service start failed: ${apply.error}`);
  }
  // The app learns its standby from its container environment, which only
  // a recreate rewrites; the running project is marked so Start applies it.
  // The standby already runs, so a refused mark settles the seed and names the restart instead.
  if (purpose === 'provision') {
    try {
      await containerManager.markPendingApplyIfRunning(instance.id);
    } catch (err) {
      const startedAt = seedRecord(instance.id)?.startedAt;
      if (typeof startedAt === 'number') {
        seedNotes.set(instance.id, { startedAt, text: `The standby was provisioned and runs, but the manager could not record that the running bot must be recreated to learn it (${errorText(err)}). Restart the instance so the bot picks up its standby` });
      }
      console.warn(`[FleetReplica] ${instance.id}: the standby runs, but the Apply mark could not be saved: ${errorText(err)}`);
    }
  }
}

/** Best effort: an inactive slot of this name on the primary is dropped; a failure is logged, never thrown. */
async function dropInactiveSlot(instance: InstanceConfig, dsn: ParsedDsn, hostCertPath: string, slot: string): Promise<void> {
  const name = `${slotResetContainerName(instance)}-drop`;
  await dockerRmForce(name);
  const result = await runPrimaryClient(name, dsn, [`${hostCertPath}:/primary-ca.crt:ro`], 'psql', [seedDsnFor(dsn), '-v', 'ON_ERROR_STOP=1', '-Atc',
    `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = '${slot}' AND NOT active;`], 60_000);
  if (!result.ok) console.warn(`[FleetReplica] Could not drop slot ${slot} on the primary after the failed seed: ${result.stderr.trim().split('\n').pop()}`);
}

/**
 * What the copy holds now, read from its running database: a standby still in
 * recovery, a promoted copy, or unknown when its container is not running.
 * A running copy that cannot be read is 'unanswered' after a failed probe and
 * 'no-identity' when its record names no user and database to probe with.
 */
async function copyHeld(rec: FleetDbReplicaRecord): Promise<'standby' | 'promoted' | 'unknown' | 'unanswered' | 'no-identity'> {
  if (rec.user && rec.db) {
    const probe = await replicaExec(rec.containerName, ['psql', '-U', rec.user, '-d', rec.db, '-Atc', 'SELECT pg_is_in_recovery();']);
    const answer = probe.ok ? probe.stdout.trim().split('|')[0] : '';
    if (answer === 't') return 'standby';
    if (answer === 'f') return 'promoted';
  }
  if ((await containerRunning(rec.containerName)) === false) return 'unknown';
  return rec.user && rec.db ? 'unanswered' : 'no-identity';
}

/** Why a running copy that cannot be read refuses, and the stop that works for the instance's status. */
function unreadCopyRefusal(instance: InstanceConfig, rec: FleetDbReplicaRecord, state: 'unanswered' | 'no-identity', subject: string, after: string): string {
  const why = state === 'no-identity'
    ? `${subject} is running, but its record has no database identity to read it with`
    : `${subject} is running but its database did not answer`;
  const stop = instance.status === 'running'
    ? "stop the instance (its copy's container stops with it)"
    : `stop the copy's container with docker stop ${rec.containerName} (Stop refuses an instance that is not running), or Start the instance and then Stop it`;
  const lead = state === 'no-identity' ? `To remove it, ${stop}` : `If it keeps not answering, ${stop}`;
  return `${why}, so the manager can't confirm whether it was promoted and now holds the fleet's writes; nothing was removed. ${lead}, then ${after}`;
}

/**
 * Remove the standby service + record. The volume and the stored primary cert
 * stay (data retention / re-provision), and what the volume held is recorded
 * for the next Provision to name. The PRIMARY's replication slot is now
 * orphaned and retains WAL: the caller must surface that loudly.
 */
export async function removeFleetReplica(instance: InstanceConfig, opts: { confirmPromoted?: boolean } = {}): Promise<{ success: boolean; error?: string; needsConfirm?: boolean }> {
  const held = runHold(instance);
  if (held) return { success: false, error: held };
  const rec = instance.fleetDbReplica;
  if (!rec) return { success: false, error: 'No replica on this instance' };
  if (seedRunning(instance.id)) return { success: false, error: 'Provisioning is running; wait for it to finish' };
  const hold = removalHold(instance.id, rec.containerName);
  if (hold) return { success: false, error: hold };
  // A stand-in's copy IS the fleet's database (20.5): removing it takes the
  // fleet down. Judged from the app's fact alone (B6 map F34); a silent app
  // or an ended lane is not refused here. The copy's own database is read
  // next, and a running copy that does not answer refuses: the exit then is
  // stopping its container, after which this removal keeps the volume and
  // records what it held as unknown.
  const posture = await readStandInPosture(instance, FACTS_TIMEOUT_MS);
  const standing = posture.read === 'ok' ? posture.posture : null;
  if (standing?.role === 'stand-in' && standing.live) {
    return { success: false, error: `This copy is standing in for ${shortId(standing.coveringNodeId)}${standing.holdsWrites ? ' and holds the fleet\'s writes' : ''}; removing it would take the fleet's database down. It returns to standby duty through the failback, or by hand after a manual promote or demote` };
  }
  // A copy promoted by hand reads no posture at all, and the app may be
  // serving the fleet from it until it is adopted.
  const copyState = await copyHeld(rec);
  if (copyState === 'unanswered' || copyState === 'no-identity') {
    const after = `Remove replica keeps the volume and records what it held as unknown${copyState === 'no-identity' ? '; a Provision after that stamps the identity' : ''}`;
    return { success: false, error: unreadCopyRefusal(instance, rec, copyState, "The copy's container", after) };
  }
  if (copyState === 'promoted' && !opts.confirmPromoted) {
    return { success: false, needsConfirm: true, error: "This copy no longer follows a primary: it was promoted, so the fleet may be serving from it now, and it may hold writes no other database has. Adopt it below to keep it as this machine's database. Removing it takes its container down at once; the volume is kept, and a later Provision here asks before clearing it" };
  }
  // The posture read can take seconds; a seed, a build or a transfer that
  // started meanwhile would write back or wipe what this removal leaves.
  const holdAfterRead = removalHold(instance.id, rec.containerName);
  if (holdAfterRead) return { success: false, error: holdAfterRead };
  // Claimed in the same synchronous segment as the check above: a seed, build
  // or adopt entering during the docker rm then refuses on isBotBusy.
  return containerManager.withExternalBotOp(instance.id, 'replica-remove', async () => {
    const removed = await containerManager.removeFleetDbReplicaService(instance.id, rec.containerName);
    if (!removed.success) return { success: false, error: `${removed.error}; the standby record was kept, so Remove can be retried` };
    let recordCleared = false;
    try {
      containerManager.updateInstanceFleetDbReplicaKept(instance.id, { volume: rec.volume, removedAt: new Date().toISOString(), held: copyState });
      containerManager.updateInstanceFleetDbReplica(instance.id, null);
      recordCleared = true;
      if (containerManager.getBot(instance.id)?.fleetDbReplicaSeed) clearSeed(instance.id);
    } catch (err) {
      const why = errorText(err);
      return { success: false, error: recordCleared
        ? `The standby service, container and record were removed, but the seed record could not be cleared (${why}); Dismiss it on this panel`
        : `The standby service and container were removed, but its record could not be cleared (${why}); the record is kept, so Remove replica again clears it` };
    }
    return { success: true };
  });
}

/**
 * A rescue keeps the app file's database service in the bot folder while it copies into the volume. After a Cancel,
 * the mark on the record is what keeps a kept volume holding a partial copy or a standby from being started.
 */
function rescueRemovalRefusal(instance: InstanceConfig, keepData: boolean): string | null {
  const rescue = instance.recoveryRescue;
  if (rescue) {
    if (['promote', 'teardown', 'flip'].includes(rescue.phase)) {
      if (!rescue.parked) {
        return `A database rescue on this instance is finishing the swap (phase ${rescue.phase}); wait for it to end, then try Remove again. Nothing was removed`;
      }
      return `A database rescue on this instance is past promotion (phase ${rescue.phase}) and has to finish the swap, which needs the bot folder. Finish it with Continue on the rescue block. Nothing was removed`;
    }
    const doing = rescue.parked ? `is parked at phase ${rescue.phase}` : `is running (phase ${rescue.phase}) and may be copying into the database volume`;
    return `A database rescue on this instance ${doing}. Removing the instance would delete its bot folder, which holds the copy of the app file the rescue puts the database back from. Cancel the rescue on its rescue block first. Nothing was removed`;
  }
  if (rescueRunnerLive(instance.id)) {
    return 'The rescue cancelled on this instance is still stopping its last step; try again in a moment. Nothing was removed';
  }
  const left = instance.recoveryRescueLeft;
  if (left && keepData) {
    const day = new Date(left.at).toISOString().slice(0, 10);
    const what = left.state === 'partial' ? "a partial copy of the sender's database" : "this instance's database as a standby of the sender";
    const volume = instance.fleetDb ? ` ${instance.fleetDb.volume}` : '';
    return `A rescue cancelled on ${day} left ${what} on the database volume${volume}. Removing the instance and keeping its data would drop the record of that, and the kept volume could later be started as if it held a whole database. Start a rescue again to finish the copy, or decommission this database on its Database modal first. Nothing was removed`;
  }
  return null;
}

/**
 * Why Remove must not run on this instance now; null when it may. A delete
 * that also deletes data reaches the fleet database only through decommission
 * (its safety dump is the ruled permit), a standby copy only through Remove
 * replica, and a fleet node's data folder only on the operator's confirm.
 */
export async function instanceRemovalRefusal(
  instance: InstanceConfig,
  keepData: boolean,
  confirmFleetData: boolean,
  confirmPromoted = false,
): Promise<{ error: string; needsConfirm?: true; confirmFlag?: 'confirmFleetData' | 'confirmPromoted' } | null> {
  const held = runHold(instance);
  if (held) return { error: held };
  const rescue = rescueRemovalRefusal(instance, keepData);
  if (rescue) return { error: rescue };
  if (instance.fleetDbReplica) {
    const promoting = promoteHold(instance);
    if (promoting) return { error: `${promoting}. Nothing was removed` };
    const posture = await readStandInPosture(instance, FACTS_TIMEOUT_MS);
    const standing = posture.read === 'ok' ? posture.posture : null;
    if (standing?.role === 'stand-in' && standing.live) {
      return { error: `This instance's database copy is standing in for ${shortId(standing.coveringNodeId)}${standing.holdsWrites ? ' and holds the fleet\'s writes' : ''}; removing the instance would take the fleet's database down. Nothing was removed` };
    }
    // Remove takes the copy's container down whether or not it keeps the data.
    const copyState = await copyHeld(instance.fleetDbReplica);
    if (copyState === 'unanswered' || copyState === 'no-identity') {
      return { error: unreadCopyRefusal(instance, instance.fleetDbReplica, copyState, "The container of this instance's database copy", 'Remove') };
    }
    if (copyState === 'promoted' && !confirmPromoted) {
      return { needsConfirm: true, confirmFlag: 'confirmPromoted', error: "This instance's database copy no longer follows a primary: it was promoted, so the fleet may be serving from it now, and it may hold writes no other database has. Removing the instance takes that copy's container down at once" };
    }
  }
  if (keepData) return null;
  if (instance.fleetDb) {
    const state = await dockerVolumeState(instance.fleetDb.volume);
    if (state === 'unknown') return { error: `Docker did not say whether the fleet database volume ${instance.fleetDb.volume} exists, so the manager can't confirm deleting the data would not destroy it; nothing was removed, try again` };
    if (state === 'exists') return { error: `This instance hosts the fleet database in volume ${instance.fleetDb.volume}. Decommission it on the Database modal first, which takes a safety dump before destroying it, or remove the instance and keep its data. Nothing was removed` };
  }
  if (instance.fleetDbReplica) {
    const state = await dockerVolumeState(instance.fleetDbReplica.volume);
    if (state === 'unknown') return { error: `Docker did not say whether the replica volume ${instance.fleetDbReplica.volume} exists, so the manager can't confirm deleting the data would not destroy it; nothing was removed, try again` };
    if (state === 'exists') return { error: `This instance holds a copy of the fleet database in volume ${instance.fleetDbReplica.volume}, and a copy can be promoted and hold writes no other database has. Remove the replica on the Database modal first (that keeps the volume), or remove the instance and keep its data. Nothing was removed` };
  }
  if (findAppCapabilities(instance.sourceUrl)?.controlPlane && !confirmFleetData) {
    const dir = await instanceDataDir(instance);
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        return { error: `The data folder ${dir} could not be read (${err instanceof Error ? err.message : String(err)}), so the manager can't confirm what deleting it would lose; nothing was removed` };
      }
    }
    if (entries.length > 0) {
      return { needsConfirm: true, confirmFlag: 'confirmFleetData', error: `This instance runs an app that can be a fleet node, and its data folder ${dir} holds ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}. On a fleet node they can include guilds no other node holds, the fleet's control records, or the backup copy of a master's data, and deleting them cannot be undone` };
    }
  }
  return null;
}

/**
 * Stop pinning the fleet database on a node that no longer hosts it. A worker
 * is not told its database by the manager at all: the master delivers it on
 * register and the bot persists it in its own env file. Leaving the old values
 * in the manager env would pin them into the container, where they outrank the
 * app's own store, so the master's delivery could never take effect and this
 * node could never pair-promote later (its own promote refuses on exactly that
 * pin). The mode key goes too, otherwise the next rebuild reads it with no URL
 * beside it and mints a fresh sidecar for a node that just stopped having one.
 */
function retireFleetDbEnvPins(botId: string): { unedited: string[]; unretired: { key: string; error: string }[] } {
  const unedited = new Set<string>();
  const unretired: { key: string; error: string }[] = [];
  // Every key is tried: one refused write must not leave the others pinned.
  for (const key of companionEnvKeys(botId)) {
    try {
      envManager.deleteEnvVar(botId, key);
      containerManager.removeBotEnvVars(botId, [key]);
      for (const file of containerManager.removeEnvKeyFromDeployedCompose(botId, key)) unedited.add(file);
    } catch (err) {
      unretired.push({ key, error: errorText(err) });
    }
  }
  // On the instance, not on a seed record: a Dismiss must not clear it while
  // the pins remain.
  try {
    containerManager.updateInstanceFleetDbPinsWarning(botId, unedited.size > 0 ? uneditedPinsWarning([...unedited]) : null);
  } catch (err) {
    console.warn(`[FleetReplica] ${botId}: the env pins warning could not be saved: ${errorText(err)}`);
  }
  return { unedited: [...unedited], unretired };
}

function unretiredPinsText(unretired: { key: string; error: string }[]): string {
  return `the stale database was retired, but the env pins ${unretired.map(p => p.key).join(', ')} could not be removed (${unretired[0].error}), so this node stays pinned to the retired database and the standby was not seeded; Finish retire removes the pins, then Dismiss this and provision the standby from the block`;
}

/** Finish retire: remove the env pins a stale-primary re-seed could not, and say what the node is now. */
export async function finishPinsRetire(instance: InstanceConfig): Promise<{ success: boolean; error?: string; warning?: string }> {
  const bot = containerManager.getBot(instance.id);
  const seed = bot ? seedView(bot) : null;
  if (!seed?.parked || !seed.pinsUnretired?.length) return { success: false, error: 'No re-seed on this instance is waiting for its env pins to be removed (nothing was changed)' };
  const busyOp = containerManager.isBotBusy(instance.id);
  if (busyOp) return { success: false, error: `Operation '${busyOp}' is running on this instance; wait for it to finish (nothing was changed)` };
  const pins = retireFleetDbEnvPins(instance.id);
  const warning = pins.unedited.length > 0 ? uneditedPinsWarning(pins.unedited) : undefined;
  if (pins.unretired.length > 0) {
    const left = pins.unretired.map(p => p.key);
    saveSeedOrHold(instance.id, { pinsUnretired: left, lastError: unretiredPinsText(pins.unretired) });
    return { success: false, error: `${left.join(', ')} could still not be removed (${pins.unretired[0].error}); the others are removed. Finish retire again once the store can be written` };
  }
  const done = 'the stale database was retired and its env pins are removed now; the seed did not run, so this node is an ordinary worker without a standby: Dismiss this, then provision the standby from the block';
  try {
    containerManager.updateInstanceFleetDbReplicaSeed(instance.id, { ...seed, pinsUnretired: undefined, lastError: done, updatedAt: Date.now() });
    heldSeeds.delete(instance.id);
  } catch (err) {
    return { success: true, warning: `The env pins are removed, but the re-seed record still names them: it could not be written (${errorText(err)})${warning ? `. ${warning}` : ''}` };
  }
  return warning ? { success: true, warning } : { success: true };
}

/**
 * The recorded pins warning while it still holds: a compose that could not be
 * read keeps it, and once every value a deployed compose sets for a pin is the
 * value the store holds (the file was fixed or rewritten), it is no longer shown.
 */
function livePinsWarning(instance: InstanceConfig): string | null {
  if (!instance.fleetDbPinsWarning) return null;
  const set = containerManager.deployedComposeEnvValues(instance.id, companionEnvKeys(instance.id));
  if (set === undefined) return instance.fleetDbPinsWarning;
  const stored = envManager.getEnvVars(instance.id);
  const stale = (set ?? []).some(({ key, value }) => !Object.prototype.hasOwnProperty.call(stored, key) || stored[key] !== value);
  return stale ? instance.fleetDbPinsWarning : null;
}

function uneditedPinsWarning(files: string[]): string {
  return `The database env pins could not be removed from ${files.join(', ')}, which still set them: every start passes them to the bot, pointing it at the retired database, until those files are edited or rewritten`;
}

/**
 * Every key the manager must stop pinning for this app's companion database.
 * Driven entirely by the app's capability record: an app that declares none
 * has no keys the manager could have pinned, so nothing is deleted from its
 * stores (the manager never invents another app's spelling).
 * appOwnedEnv is included deliberately: the manager never authors those, so a
 * value in ITS stores is an anomaly that would outrank the app's own store.
 */
function companionEnvKeys(botId: string): string[] {
  const db = findAppCapabilities(containerManager.getBot(botId)?.sourceUrl)?.companionDb;
  if (!db) return [];
  const keys = [db.env.url, db.env.publicUrl, db.env.mode?.key, ...(db.repointedEnv ?? []), ...(db.appOwnedEnv ?? [])];
  return Array.from(new Set(keys.filter((k): k is string => !!k)));
}

/**
 * Heal a stale primary (PLAN_REPLICATION.md Stage 5): the machine that used to
 * serve the fleet database comes back after the pair failed over to the other
 * one, and its copy is a fork nobody may ever read again. This turns it into an
 * ordinary standby of the new primary, so the whole fleet is back to one
 * database with one copy and failback is the normal planned handover.
 *
 * Re-seed rather than pg_rewind: enable turns wal_log_hints on, so a rewind
 * is possible on any cluster that has run enable, but no code calls pg_rewind
 * and a re-seed needs no such precondition. Both paths discard the diverged tail anyway
 * (R6 calls the whole re-seed a convenience over the bot-side fence).
 *
 * The instance must be STOPPED: this deletes the database it is running on.
 */
export function reseedStalePrimary(
  instance: InstanceConfig,
  primaryDsn: string,
  certPem: string,
  publicHost: string,
  hostPort?: number,
  confirm?: boolean,
  opts: { dumpDone?: boolean; run?: number; confirmVolume?: string } = {},
): { success: boolean; error?: string; started?: boolean; needsConfirm?: boolean; confirmVolume?: string } {
  const held = runHold(instance, opts.run);
  if (held) return { success: false, error: held };
  if (!instance.fleetDb) {
    return { success: false, error: 'This instance hosts no managed fleet database, so there is no stale primary to heal - use Provision instead' };
  }
  if (instance.fleetDbReplica) return { success: false, error: 'A replica already exists on this instance - remove it first' };
  if (instance.recoveryChannel) return { success: false, error: 'A recovery channel is armed on this database - disarm it first' };
  if (instance.recoveryRescue) return { success: false, error: 'A database rescue is in progress on this instance - finish or cancel it first' };
  if (seedRunning(instance.id)) return { success: false, error: 'Provisioning is already running' };
  const busyOp = containerManager.isBotBusy(instance.id);
  if (busyOp) return { success: false, error: `Operation '${busyOp}' is running on this instance; wait for it to finish` };
  // Same null-record refusal as provisionFleetReplica: the re-seeded standby's
  // record is stamped from the capability record.
  if (!findAppCapabilities(instance.sourceUrl)?.companionDb) {
    return { success: false, error: 'This app declares no managed database companion' };
  }
  if (instance.status === 'running') {
    return { success: false, error: 'Stop the instance first: re-seeding deletes the database it is currently running on' };
  }
  if (!containerManager.deployedComposeExists(instance.id)) {
    return { success: false, error: 'Install/build the instance first - the standby joins its compose project' };
  }
  // BEFORE anything destructive: a corrupt store would make the pins retire
  // throw AFTER the stale database is destroyed, leaving the node pinned to a
  // database that no longer exists and the lane not re-runnable.
  if (envManager.getEnvVarsWithStatus(instance.id).corrupt) {
    return { success: false, error: 'The env store for this instance cannot be read (a copy is kept beside it as storage.json.corrupt-<time> when it could be read); restore it before re-seeding' };
  }

  const validated = validateIntake(primaryDsn, certPem, publicHost, hostPort);
  if (!validated.ok) return { success: false, error: validated.error };
  const { dsn: parsedDsn, port } = validated.intake;
  const registryUnread = portUnconfirmed(port);
  if (registryUnread) return { success: false, error: registryUnread };
  // This instance's own primary record is exempt: its port frees up the moment
  // the retire below runs, and reusing it is the normal outcome.
  const collision = containerManager.getAllBots().find(other =>
    (other.id !== instance.id
      && (other.fleetDb?.replication?.hostPort === port || other.fleetDbReplica?.hostPort === port))
    || other.recoveryChannel?.tunnelPort === port);
  if (collision) {
    return { success: false, error: `Host port ${port} is already used by "${collision.displayName}" - pick another` };
  }
  // Includes this instance deliberately: pasting its OWN block would seed a
  // standby from the very database that is about to be deleted.
  const samehost = containerManager.getAllBots().find(other => {
    const repl = other.fleetDb?.replication;
    return repl && repl.publicHost === parsedDsn.host && repl.hostPort === parsedDsn.port;
  });
  if (samehost?.id === instance.id) {
    return { success: false, error: 'That block is this instance\'s OWN database, which is the stale one. Paste the block from the machine that now serves the fleet' };
  }
  if (samehost && !confirm) {
    return { success: false, needsConfirm: true, error: `That primary ("${samehost.displayName}") lives on THIS machine, so a standby here survives that database's container dying but not this machine dying. That shape is allowed. Check the standby reports streaming once it finishes: a container that shares a docker network with the primary's sidecar cannot always reach its published port, and the copy can seed over a path the running standby does not have` };
  }

  const record = replicaRecordFor(instance, validated.intake);
  // The same rule as provisionFleetReplica: the failback run's wipe consent
  // covers the replica volume, and every other caller confirms it by name.
  const inRun = typeof opts.run === 'number' && liveFailback(instance)?.startedAt === opts.run;
  const confirmVolume = inRun && typeof liveFailback(instance)?.consentAt === 'number' ? record.volume : opts.confirmVolume;
  const volumeRefusal = provisionVolumeRefusal(instance, record.volume, confirmVolume);
  if (volumeRefusal) return { success: false, ...volumeRefusal };

  const preflight = async () => {
    throwIfCancelled(instance.id);
    const fleetDb = instance.fleetDb!;
    // The status record can say stopped while docker runs the bot on this database.
    const live = await containerManager.runningNonSidecarContainers(instance.id);
    if (live === null) throw new Error("docker did not say which containers of this instance run, so the manager can't confirm the bot is stopped; nothing was destroyed, retry");
    if (live.length > 0) throw new Error(`containers of this instance still run (${live.join(', ')}); stop them, then re-seed again; nothing was destroyed`);
    // Asked again ahead of the dump and the retire: a volume made since the
    // request was never part of what the operator confirmed.
    const replicaState = await dockerVolumeState(record.volume);
    if (replicaState === 'unknown') throw new Error(`docker did not say whether the replica volume ${record.volume} exists, so nothing was destroyed; retry`);
    if (replicaState === 'exists' && confirmVolume !== record.volume) {
      throw new Error(`nothing was destroyed: ${keptVolumeQuestion(containerManager.getBot(instance.id) ?? instance, record.volume)}. Re-seed again and confirm to clear it`);
    }
    // The dump is the permit, as for decommission: the database is destroyed
    // only after a dump taken under the write fence succeeded. Stopping the
    // instance took its whole compose project down, so the database comes
    // back up alone to be dumped. A volume PROVEN absent has nothing to
    // protect, and starting the sidecar would mint an empty database whose
    // dump would pose as the safety copy. The failback run dumps under its
    // own fence before it parks for consent (F5), and that consent names the
    // dump's outcome, so it arrives here with the dump done.
    let fenced = false;
    try {
      if (!opts.dumpDone) {
        const volState = await dockerVolumeState(fleetDb.volume);
        if (volState === 'unknown') throw new Error('could not verify the database volume (docker did not answer), so nothing was destroyed; retry');
        if (volState === 'exists') {
          const reminted = await remintedVolumeRefusal(fleetDb);
          if (reminted) throw new Error(`nothing was destroyed: ${reminted}`);
          const started = await containerManager.startFleetDbSidecar(instance.id, { retireRetry: true });
          if (!started.success) throw new Error(`the database did not come up for the safety dump, so nothing was destroyed: ${started.error}`);
          const dump = await fleetBackup.fencedSafetyDump(instance, 'pre-reseed-', 'a re-seed', RESEED_LIFT_REMEDY);
          if (!dump.success) throw new Error(`the safety dump failed, so nothing was destroyed: ${dump.error}`);
          fenced = true;
          saveSeedOrHold(instance.id, { safetyDump: dump.file });
        }
      }
      if (!opts.dumpDone && fenced) {
        const foreign = await reseedIdentityRefusal(instance, fleetDb, validated.intake.dsn);
        if (foreign) throw new Error(`${foreign}; nothing was destroyed`);
      }
      // Re-check just before the destructive step: the dump above can take
      // minutes, and a store that corrupted meanwhile would make the pins
      // retire below throw AFTER the database was destroyed.
      if (envManager.getEnvVarsWithStatus(instance.id).corrupt) {
        throw new Error('the env store corrupted while the safety dump ran (a copy is kept beside it as storage.json.corrupt-<time> when it could be read); nothing was destroyed - restore it and retry');
      }
      // The dump above takes minutes, so a cancel filed during it is honoured
      // here, with the sidecar running and the record intact.
      throwIfCancelled(instance.id);
      const retired = await retireStaleOwnDb(instance.id);
      if (!retired.success) {
        if (retired.volumeRemoved) {
          fenced = false;
          saveSeedOrHold(instance.id, { committed: true });
        }
        throw new Error(`could not retire the stale database: ${retired.error}`);
      }
    } catch (err) {
      if (fenced) {
        const note = await liftFenceLeftStanding(instance.id, fleetDb, 'a re-seed', RESEED_LIFT_REMEDY);
        if (note && err instanceof Error && !(err instanceof SeedCancelled)) err.message += note;
      }
      throw err;
    }
    // Committed once the retire reports the volume gone: a retire that refuses
    // before it touches the volume leaves everything in place, and a cancel
    // filed there must not claim the database is gone.
    saveSeedOrHold(instance.id, { committed: true });
    // BEFORE the seed: if the seed then fails, this node is an ordinary worker
    // that will take the live fleet database from the master's next delivery
    // and merely lacks a standby, which beats staying pinned to a database
    // that was just deleted.
    const pins = retireFleetDbEnvPins(instance.id);
    if (pins.unedited.length > 0) console.error(`[FleetReplica] ${instance.id}: ${uneditedPinsWarning(pins.unedited)}`);
    if (pins.unretired.length > 0) {
      saveSeedOrHold(instance.id, { pinsUnretired: pins.unretired.map(p => p.key) });
      throw new Error(unretiredPinsText(pins.unretired));
    }
  };
  // Held across the whole run, the way decommission holds it: the dump, the
  // retire and the seed take minutes, and a restore or the scheduled dump
  // interleaving with the wipe is what the slot exists to prevent. The lane's
  // own pre-reseed dump does not claim it. The slot is released whenever the
  // start does not hand the run to the op lock.
  if (!fleetBackup.claimFleetBackupBusy(instance.id)) {
    return { success: false, error: containerManager.isShuttingDown() ? containerManager.SHUTDOWN_REFUSAL : 'A backup or restore operation is in progress on this database - wait for it to finish' };
  }
  let started: { success: boolean; error?: string };
  try {
    started = startProvisioning(instance, record, validated.intake, 'reseed-stale-primary', preflight, () => fleetBackup.releaseFleetBackupBusy(instance.id), confirmVolume);
  } catch (err) {
    fleetBackup.releaseFleetBackupBusy(instance.id);
    throw err;
  }
  if (!started.success) {
    fleetBackup.releaseFleetBackupBusy(instance.id);
    return started;
  }
  return { success: true, started: true };
}

/**
 * Why the pasted primary must not replace this stale copy: a primary that took over from this machine is a physical
 * copy of it (the same system id) on a later timeline. A different cluster or a lower timeline is refused, and so is
 * an identity that could not be read on either side. Null when the two match.
 */
async function reseedIdentityRefusal(instance: InstanceConfig, fleetDb: NonNullable<InstanceConfig['fleetDb']>, dsn: ParsedDsn): Promise<string | null> {
  const local = await new Promise<{ ok: boolean; out: string }>(resolve => {
    execFile('docker', ['exec', fleetDb.containerName, 'psql', '-U', fleetDb.user, '-d', fleetDb.db, '-tA', '-c',
      'SELECT (SELECT system_identifier FROM pg_control_system()), (SELECT timeline_id FROM pg_control_checkpoint())'],
    { timeout: PROBE_TIMEOUT_MS }, (err, stdout, stderr) => resolve({ ok: !err, out: err ? String(stderr || err.message) : String(stdout) }));
  });
  const [localId, localTl] = local.ok ? local.out.trim().split('|') : ['', ''];
  if (!/^\d+$/.test(localId) || !/^\d+$/.test(localTl)) {
    return `this database's identity could not be read (${local.out.trim().split('\n').pop() || 'no answer'}), so it cannot be compared with the pasted primary's`;
  }
  const probeName = primaryProbeContainerName(instance);
  await dockerRmForce(probeName);
  const ident = await runPrimaryClient(probeName, dsn, [`${hostCertPathFor(instance.id)}:/primary-ca.crt:ro`], 'psql',
    [`${seedDsnFor(dsn)}&replication=true`, '-Atc', 'IDENTIFY_SYSTEM'], PROBE_TIMEOUT_MS);
  const [primaryId, primaryTl] = ident.ok ? ident.stdout.trim().split('|') : ['', ''];
  if (!/^\d+$/.test(primaryId) || !/^\d+$/.test(primaryTl)) {
    const reason = (ident.stderr.trim().split('\n').map(l => l.trim()).filter(Boolean)[0] || 'no answer').split(dsn.password).join('***');
    return `the pasted primary's identity could not be read (${reason}), so it cannot be compared with this database's`;
  }
  if (primaryId !== localId) {
    return `the pasted primary's database (system id ${primaryId}) is not a copy of this one (system id ${localId}), so it did not take over from this machine. Paste the block of the machine that took over, or decommission this database and provision a standby instead`;
  }
  if (Number(primaryTl) < Number(localTl)) {
    return `the pasted primary is on timeline ${primaryTl}, below this database's timeline ${localTl}: this copy was promoted after the two parted and may hold the newer writes`;
  }
  return null;
}

const RESEED_LIFT_REMEDY = 'retrying the re-seed retries the lift';
const DECOMMISSION_LIFT_REMEDY = 'running the decommission again retries the lift';

/**
 * Lift a lane's write fence after its destroy was refused. The volume is asked
 * first: the lift's fallback mounts the volume, which would mint one that the
 * refused destroy had already removed.
 */
async function liftFenceLeftStanding(botId: string, fleetDb: NonNullable<InstanceConfig['fleetDb']>, lane: string, remedy: string): Promise<string> {
  const volState = await dockerVolumeState(fleetDb.volume);
  if (volState === 'absent') return '';
  if (volState === 'unknown') return '; whether the database is still fenced (read-only or refusing the bot\'s connections) could not be confirmed (docker did not answer)';
  return fleetBackup.liftLaneFence(botId, fleetDb, lane, remedy);
}

/**
 * Destroy this instance's managed fleet database (PLAN_REPLICATION 20.13
 * [Decommission]; design ruled 2026-09-01: DUMP-GATED DESTROY). "Is it still
 * in use?" proved unanswerable by enumerating consumers five review rounds
 * running (the B4m-2a record), so no app fact gates anything here. The ONLY
 * permit is a fresh pre-decommission dump, taken under the write fence, that
 * SUCCEEDS: a wrong click then costs downtime, not data, because the dump
 * restores through the restore lane into a re-provisioned sidecar. The refusals below are the manager's
 * OWN records exclusively.
 */
export async function decommissionFleetDb(
  botId: string
): Promise<{ success: boolean; error?: string; dumpFile?: string; warning?: string }> {
  try {
    // The bot op lock is held for the whole lane so a concurrent Start cannot
    // boot the instance onto the database mid-destroy; the guards re-read a
    // fresh snapshot INSIDE the lock, since callers hold a stale one.
    return await containerManager.withExternalBotOp(botId, 'decommission', async () => {
      const instance = containerManager.getBot(botId);
      if (!instance?.fleetDb) return { success: false, error: 'This instance hosts no managed fleet database' };
      const held = runHold(instance);
      if (held) return { success: false, error: held };
      const refusal = capabilityRefusal(instance);
      if (refusal) return { success: false, error: refusal };
      if (instance.fleetDbReplica) return { success: false, error: 'This instance also holds a standby copy - remove or adopt it before decommissioning the primary database' };
      if (instance.recoveryChannel) return { success: false, error: 'A recovery channel is armed on this database - disarm it first' };
      if (instance.recoveryRescue) return { success: false, error: 'A database rescue is in progress on this instance - finish or cancel it first' };
      if (seedRunning(instance.id)) return { success: false, error: 'Provisioning is already running on this instance' };
      if (instance.status === 'running') {
        return { success: false, error: 'Stop the instance first: decommission destroys the database it is running on' };
      }
      // The status record can lie after a compose down that failed but still
      // reported success, so ask docker itself. The probe excludes the
      // sidecar by exact record name, so a retry with the database running
      // alone still passes.
      const liveContainers = await containerManager.runningNonSidecarContainers(instance.id);
      if (liveContainers === null) {
        return { success: false, error: 'Could not verify that this instance is fully stopped (docker did not answer) - try again' };
      }
      if (liveContainers.length > 0) {
        return { success: false, error: `Containers of this instance are still running (${liveContainers.join(', ')}) - stop it fully first` };
      }
      if (!fleetBackup.claimFleetBackupBusy(instance.id)) {
        return { success: false, error: containerManager.isShuttingDown() ? containerManager.SHUTDOWN_REFUSAL : 'A backup or restore operation is in progress on this database - wait for it to finish' };
      }
      try {
        // A volume PROVEN absent has nothing to protect, and starting the
        // sidecar would MINT a fresh empty database whose dump would then
        // pose as the safety copy (a partial earlier attempt destroys the
        // volume before the compose strip). Only then is the dump skipped;
        // that earlier attempt's real dump is already in the backups list.
        // An unanswerable probe refuses: skipping the gate on a guess is the
        // destroy-without-dump hole this whole design exists to close.
        let dumpFile: string | undefined;
        const volState = await dockerVolumeState(instance.fleetDb.volume);
        if (volState === 'unknown') {
          return { success: false, error: 'Refused, nothing was destroyed: could not verify the database volume (docker did not answer) - try again' };
        }
        if (volState === 'exists') {
          const reminted = await remintedVolumeRefusal(instance.fleetDb);
          if (reminted) return { success: false, error: `Refused, nothing was destroyed: ${reminted}` };
          // The permit. Stopping the instance took the sidecar down with its
          // compose project, so it comes back up alone to be dumped at all.
          const started = await containerManager.startFleetDbSidecar(instance.id, { retireRetry: true });
          if (!started.success) {
            return { success: false, error: `Refused, nothing was destroyed: the database did not come up for the pre-decommission dump: ${started.error}. If its container started, it was left running alone for inspection` };
          }
          // Under the write fence, so a writer this manager cannot see (another
          // machine's worker) cannot land a row the dump misses.
          const dump = await fleetBackup.fencedSafetyDump(instance, 'pre-decommission-', 'a decommission', DECOMMISSION_LIFT_REMEDY);
          if (!dump.success) {
            return { success: false, error: `Refused, nothing was destroyed: the pre-decommission dump failed: ${dump.error}. The database was left running alone for inspection` };
          }
          dumpFile = dump.file;
        }

        const retired = await containerManager.retireFleetDbSidecar(instance.id);
        if (!retired.success) {
          const note = dumpFile && !retired.volumeRemoved ? await liftFenceLeftStanding(instance.id, instance.fleetDb, 'a decommission', DECOMMISSION_LIFT_REMEDY) : '';
          return { success: false, error: `${dumpFile ? `The safety dump succeeded (${dumpFile}) but the teardown failed` : 'The teardown failed'}: ${retired.error}${note}`, dumpFile };
        }
        let warning: string | undefined;
        try {
          const pins = retireFleetDbEnvPins(instance.id);
          const parts = [
            ...(pins.unedited.length > 0 ? [uneditedPinsWarning(pins.unedited)] : []),
            ...(pins.unretired.length > 0 ? [`The database env pins ${pins.unretired.map(p => p.key).join(', ')} could not be removed (${pins.unretired[0].error}); delete them in the Env editor`] : []),
          ];
          if (parts.length > 0) warning = parts.join('. ');
        } catch (err) {
          // The database is already destroyed and the dump kept: a pins
          // failure must not read as a refusal. Leftover pins only mean a
          // later rebuild re-mints a recorded empty sidecar.
          console.error(`[FleetReplica] Decommissioned ${instance.id} but failed to retire its env pins:`, err);
          warning = `The database env pins could not be removed: ${String((err as Error)?.message || err)}`;
        }
        if (warning) console.error(`[FleetReplica] ${instance.id}: ${warning}`);
        fleetBackup.clearTermFloor(instance.id);
        return warning ? { success: true, dumpFile, warning } : { success: true, dumpFile };
      } finally {
        fleetBackup.releaseFleetBackupBusy(instance.id);
      }
    });
  } catch (err) {
    return { success: false, error: String((err as Error)?.message || err) };
  }
}

/**
 * Bind sources of every container this instance owns, as the HOST daemon sees
 * them, forward-slashed. The bot-id label is stamped on every service the
 * manager authors, so this still finds them after a rename that the container
 * names have not caught up with.
 */
function instanceBindSources(botId: string): Promise<string[]> {
  return new Promise(resolve => {
    execFile('docker', ['ps', '-a', '--filter', `label=bot-id=${botId}`, '--format', '{{.Names}}'], { timeout: EXEC_TIMEOUT_MS }, (listErr, listOut) => {
      const names = listErr ? [] : String(listOut).split('\n').map(line => line.trim()).filter(Boolean);
      if (!names.length) return resolve([]);
      const format = '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}{{println}}{{end}}{{end}}';
      // The error is deliberately ignored: a name that vanished between the two
      // calls exits non-zero while docker still prints every container it did
      // resolve, and a container that is gone mounts nothing, so that output is
      // complete. A daemon that cannot answer at all prints nothing and the
      // caller falls back on an empty list either way.
      execFile('docker', ['inspect', '--format', format, ...names], { timeout: EXEC_TIMEOUT_MS }, (_inspectErr, inspectOut) => {
        resolve(String(inspectOut)
          .split('\n')
          .map(line => line.trim().replace(/\\/g, '/').replace(/\/+$/, ''))
          .filter(Boolean));
      });
    });
  });
}

/**
 * This instance's data directory, in the path space THIS process reads from.
 * The deployed containers are the only witness that survives a rename or a
 * deployment-mode flip, so their binds decide; the per-mode convention answers
 * only when no container exists to ask. Docker reports HOST paths, which reach
 * the manager at its own mount points, so a source that cannot be translated
 * back is discarded rather than guessed at, and so is an ambiguous one.
 */
export async function instanceDataDir(instance: InstanceConfig): Promise<string> {
  const ownDataBind = `${containerManager.hostBotDirFor(instance.id)}/data`;
  const appData = `${DATA_ROOT}/AppData/`;
  const resolved = new Set<string>();
  for (const source of await instanceBindSources(instance.id)) {
    // The app's data dir is the one bind whose source ends in `data`: the
    // container side cannot tell them apart, since a shipped gateway mounts
    // its own config at /data too.
    if (path.posix.basename(source) !== 'data') continue;
    if (source === ownDataBind) resolved.add(getDataPath(instance.id));
    else if (source.startsWith(appData)) resolved.add(source);
  }
  if (resolved.size === 1) return resolved.values().next().value as string;
  return (await getDeploymentMode()) === 'casaos'
    ? path.posix.join(appData, instance.sanitizedName, 'data')
    : getDataPath(instance.id);
}

/**
 * The fleet database password, for an instance whose manager env store has
 * none. A worker is never told the URL by the manager: the master delivers it
 * on register and the bot persists it in its OWN env file (declared as
 * companionDb.appEnvFile, ruling F1: the file read serves exactly the flows
 * where the app is stopped and no hook can answer), so that file is the only
 * place this machine's copy of the fleet credentials exists. An unparseable
 * value refuses (returns null) rather than guessing.
 */
function fleetPasswordFromBotEnv(dataDir: string, db: CompanionDbSpec): string | null {
  if (!db.appEnvFile) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dataDir, db.appEnvFile), 'utf-8');
  } catch {
    return null;
  }
  const keyLine = new RegExp(`^\\s*${db.env.url}\\s*=\\s*(.*)$`);
  for (const line of raw.split('\n')) {
    const match = keyLine.exec(line);
    if (!match) continue;
    const value = match[1].trim().replace(/^["']|["']$/g, '');
    try {
      const password = decodeURIComponent(new URL(value).password);
      if (password) return password;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Adopt a promoted standby as this machine's fleet database
 * (PLAN_REPLICATION.md Stage 5). This is the other half of the stale-primary
 * re-seed: after a pair promotion the bot serves its local copy, but the
 * manager still files it as somebody else's standby, so the machine that just
 * became the primary offers no replication surface and cannot hand out the
 * copy block the old machine needs. Without this, the re-seed has no source.
 *
 * Enabling replication straight away is not an extra: it mints the slot a
 * pg_basebackup needs, files this machine's endpoint as the public form
 * (the bot already repointed itself through /data/.env, so the manager's copy
 * was the stale one), and is what keeps a rebuild recognising the sidecar as
 * managed rather than external.
 */
export async function adoptPromotedReplica(
  instance: InstanceConfig,
  opts: { run?: number } = {},
): Promise<{ success: boolean; error?: string; restartRequired?: boolean }> {
  const held = runHold(instance, opts.run);
  if (held) return { success: false, error: held };
  const rec = instance.fleetDbReplica;
  if (!rec) return { success: false, error: 'This instance has no standby to adopt' };
  if (instance.fleetDb) return { success: false, error: 'This instance already hosts a fleet database' };
  if (seedRunning(instance.id)) return { success: false, error: 'Provisioning is running; wait for it to finish' };
  const busyOp = containerManager.isBotBusy(instance.id);
  if (busyOp) return { success: false, error: `Operation '${busyOp}' is running on this instance; wait for it to finish` };

  // The pre-field gate first, with the real remedy: the status probe cannot
  // even run for such a record, and "start the instance" would be a lie.
  if (!rec.user || !rec.db) {
    return { success: false, error: 'This standby record predates identity stamping; retire and re-provision the standby before adopting' };
  }
  const status = await getFleetReplicaStatus(instance);
  if (!status.live) {
    return { success: false, error: `Could not read the standby container (${status.probeError || 'no output'}), so it cannot be verified for adoption; try again` };
  }
  if (!status.live.running) {
    return { success: false, error: 'The standby container is not running, so it cannot be adopted; start the instance first' };
  }
  // Adopting a copy that still follows somebody would file a standby as a
  // primary and invite a second Enable to fork the pair.
  if (status.live.inRecovery !== false) {
    return { success: false, error: 'This copy is still following a primary, so it is not this machine\'s database yet. Promote this node first (its own web UI), then adopt' };
  }
  // Out of recovery says nothing about WHY (B6 map F34): a stand-in's copy is
  // promoted too, and filing it would make a temporary copy this machine's
  // own for good. Only the app's fact tells the two apart, so no fact, no adopt.
  const posture = await readStandInPosture(instance, FACTS_TIMEOUT_MS);
  if (posture.read === 'unanswered') {
    return { success: false, error: `The app on this instance is not answering (${posture.error}), so the manager cannot tell whether this copy stands in for a dead master or was promoted for good; ${unansweredRemedy(posture.error)} before adopting` };
  }
  const standing = posture.read === 'ok' ? posture.posture : null;
  if (standing?.role === 'stand-in' && standing.live) {
    return { success: false, error: `This copy is standing in for ${shortId(standing.coveringNodeId)} (20.5): it is the fleet's database only until the failback, and adopting it would file a temporary copy as this machine's own. Promote this node by hand first if it should become the true master, then adopt` };
  }
  if (standing?.role === 'stand-in') {
    return { success: false, error: `This copy took the fleet's writes as a stand-in for ${shortId(standing.coveringNodeId)} and the lane ended (${standing.disarmReason ?? 'no reason recorded'}) with those writes still only here; adopting would file them under a node that no longer serves the fleet. Promote this node by hand first (its own web UI), then adopt` };
  }

  const db = findAppCapabilities(instance.sourceUrl)?.companionDb;
  if (!db) return { success: false, error: 'This app declares no managed database companion' };

  // BEFORE the record flip: a corrupt store would make the env write below
  // throw after the standby record is already consumed, leaving a half-done
  // adopt no lane can finish. Refusing here keeps the adopt retryable.
  if (envManager.getEnvVarsWithStatus(instance.id).corrupt) {
    return { success: false, error: 'The env store for this instance cannot be read (a copy is kept beside it as storage.json.corrupt-<time> when it could be read); restore it before adopting' };
  }

  // A worker's manager env store carries no database URL, so the managed-lane
  // checks (and the password enableFleetReplication needs) have nothing to read
  // until this instance is filed like any other database host.
  const dataDir = await instanceDataDir(instance);
  const password = (() => {
    const current = (envManager.getEnvVars(instance.id)[db.env.url] || '').trim();
    if (current !== '') {
      try { return decodeURIComponent(new URL(current).password) || null; } catch { return null; }
    }
    return fleetPasswordFromBotEnv(dataDir, db);
  })();
  if (!password) {
    // Naming the file keeps a wrong data dir apart from a genuinely absent
    // credential: the two read identically from the outside.
    const appEnvFile = db.appEnvFile ? path.posix.join(dataDir, db.appEnvFile) : 'no app env file is declared';
    return { success: false, error: `Could not recover the fleet database credentials from this instance (neither the manager env nor ${appEnvFile} carries a usable database URL), so the database cannot be adopted` };
  }

  // A copy can carry the write fence's pg_hba lines (copied before the copy
  // sites stripped them, or a fence stood on the source); enable refuses on
  // them and they shut out every outside client. The reload before the enable
  // applies the stripped file.
  const fence = await new Promise<{ ok: boolean; stderr: string }>(resolve => {
    execFile('docker', ['exec', '-u', 'root', rec.containerName, 'sh', '-c', fleetBackup.stripFenceHbaScript(PGDATA)], { timeout: EXEC_TIMEOUT_MS }, (err, _stdout, stderr) => {
      resolve({ ok: !err, stderr: String(stderr || err || '') });
    });
  });
  if (!fence.ok) {
    return { success: false, error: `The write fence's lines could not be removed from this copy's pg_hba.conf (${probeErrorTail(fence.stderr)}), so the standby was not adopted; nothing was changed` };
  }

  // The copy's catalog still holds the replication role its seed used, and
  // every standby of this lineage pins that credential and the certificate the
  // seed minted for this endpoint (B6 map F30). Filing them makes enable keep
  // both instead of minting, so a handover does not invalidate the fleet's
  // trust. Unreadable means enable mints, as before.
  const credential = await readCopyCredential(rec);
  const replication = credential && credential.user === REPLICATION_ROLE
    ? { role: credential.user, password: credential.password, hostPort: rec.hostPort, publicHost: rec.publicHost, certHost: rec.certHost }
    : undefined;
  // The container-name form, written before the record flip so a refused env
  // write leaves nothing changed: with the record flipped it is what marks the
  // sidecar MANAGED, so a rebuild landing before the enable below still keeps
  // the database in the compose. The enable keeps it and adds the public form
  // beside it (F1: same-host consumers cannot dial the public form).
  // Identity from the STAMP (rec.user/rec.db): adoption files an EXISTING
  // byte-copied cluster, whose role and database are whatever provisioning
  // stamped, not whatever the mutable per-source record says today.
  const envKeys = [db.env.url, ...(db.env.mode ? [db.env.mode.key] : [])];
  let envBefore: envManager.StoredKeys;
  try {
    envBefore = envManager.snapshotStoredKeys(instance.id, envKeys);
    envManager.setEnvVars(instance.id, {
      ...(db.env.mode ? { [db.env.mode.key]: db.env.mode.value } : {}),
      [db.env.url]: `postgresql://${rec.user}:${encodeURIComponent(password)}@${rec.containerName}:5432/${rec.db}?sslmode=no-verify`,
    });
  } catch (err) {
    return { success: false, error: `The database URL could not be written to the env store (${errorText(err)}), so the standby was not adopted; nothing was changed` };
  }
  // The record flip did not happen: the env store gets its keys back; null, or what was left behind.
  const putEnvBack = (): string | null => {
    try {
      envManager.restoreStoredKeys(instance.id, envBefore);
      return null;
    } catch (err) {
      return `${envKeys.join(' and ')} written for the adopt could not be put back in the env store (${errorText(err)}): set ${envKeys.length === 1 ? 'it' : 'them'} back in the Env editor before the instance next starts`;
    }
  };
  let adopted: { success: boolean; error?: string };
  try {
    adopted = containerManager.adoptFleetDbReplicaAsPrimary(instance.id, replication);
  } catch (err) {
    const left = putEnvBack();
    return { success: false, error: `The instance record could not be written (${errorText(err)}), so the standby was not adopted; ${left ?? 'nothing was changed'}` };
  }
  if (!adopted.success) {
    const left = putEnvBack();
    return left ? { success: false, error: `${adopted.error}; ${left}` } : adopted;
  }
  const live = containerManager.getBot(instance.id);
  if (!live) return { success: false, error: 'Bot not found after adopting the record' };

  // BEFORE the enable, deliberately (B6 map F18/B13): the promoted copy still
  // carries what its seed and its old primary wrote. primary_conninfo and
  // primary_slot_name are merely inert here, but an inherited armed
  // synchronous_standby_names names standbys that do not exist on THIS cluster,
  // and enable's first catalog write would hang forever behind it with docker
  // still reporting the database healthy. A read-only fence inherited the same
  // way would refuse that write outright. ALTER SYSTEM itself writes no WAL, so
  // it can always run, and the reload is what actually lifts a live wedge.
  for (const setting of ['primary_conninfo', 'primary_slot_name', 'synchronous_standby_names', 'default_transaction_read_only']) {
    const reset = await replicaExec(rec.containerName, ['psql', '-U', rec.user, '-d', rec.db, '-Atc', `ALTER SYSTEM RESET ${setting};`]);
    if (!reset.ok) console.warn(`[FleetReplica] Could not reset ${setting} on the adopted primary: ${reset.stderr.trim().split('\n').pop()}`);
  }
  const reload = await replicaExec(rec.containerName, ['psql', '-U', rec.user, '-d', rec.db, '-Atc', 'SELECT pg_reload_conf();']);
  if (!reload.ok) console.warn(`[FleetReplica] Could not reload the adopted primary's config: ${reload.stderr.trim().split('\n').pop()}`);

  const enabled = await enableFleetReplication(live, rec.publicHost, rec.hostPort, undefined, { dbPassword: password });
  if (!enabled.success) {
    // Leave the adopted record in place: the database IS this machine's now,
    // and the operator can retry Enable from the replication section. Rolling
    // the record back would hide a live primary behind a standby surface again.
    return { success: false, error: `The database was adopted, but enabling replication on it failed (retry from the Replication section): ${enabled.error}` };
  }
  // enableFleetReplication repoints the database URL; a repointed key (e.g. a
  // split control store's URL) only exists when set, and then it moves too.
  // The env store alone: container env assembly derives sensitive values from
  // it at read time (the two-store strip).
  const stored = envManager.getEnvVars(instance.id);
  const repointUrl = (stored[db.env.url] || '').trim();
  const repoints: Record<string, string> = {};
  for (const key of db.repointedEnv ?? []) {
    if ((stored[key] || '').trim() !== '') repoints[key] = repointUrl;
  }
  if (Object.keys(repoints).length) {
    try {
      envManager.setEnvVars(instance.id, repoints);
    } catch (err) {
      return { success: false, restartRequired: true, error: `The database was adopted and replication is enabled on it, but ${Object.keys(repoints).join(', ')} could not be repointed (${errorText(err)}) and still hold the old database URL: set ${Object.keys(repoints).length === 1 ? 'it' : 'them'} to the value of ${db.env.url} in the Env editor, then restart the instance` };
    }
  }
  return { success: true, restartRequired: true };
}

/** The fleet database password for an instance whose manager env holds no database URL: the bot's own env file carries it. */
export async function fleetDbPasswordFallback(instance: InstanceConfig): Promise<string | undefined> {
  const db = findAppCapabilities(instance.sourceUrl)?.companionDb;
  if (!db || (envManager.getEnvVars(instance.id)[db.env.url] || '').trim() !== '') return undefined;
  return fleetPasswordFromBotEnv(await instanceDataDir(instance), db) ?? undefined;
}

/**
 * The copy block for a stand-in's PROMOTED copy (20.5, B6 map F33): the
 * temporary source the returning master re-seeds from. Nothing is filed and
 * nothing is delivered to the bot, so peers still receive no seed source
 * (F35). The credential is the one the seed wrote into this copy's own
 * primary_conninfo: the byte-copied catalog still holds that role, the
 * byte-copied pg_hba still admits it over TLS, and the certificate is the one
 * the seed minted for this machine's endpoint.
 */
export async function getStandInCopyBlock(
  instance: InstanceConfig,
): Promise<{ success: boolean; error?: string; dsn?: string; cert?: string }> {
  const rec = instance.fleetDbReplica;
  if (!rec) return { success: false, error: 'This instance has no standby' };
  if (!rec.user || !rec.db) return { success: false, error: 'This standby record predates identity stamping; the copy cannot be read' };
  const recovery = await replicaExec(rec.containerName, ['psql', '-U', rec.user, '-d', rec.db, '-Atc', 'SELECT pg_is_in_recovery();']);
  if (!recovery.ok) return { success: false, error: 'The copy could not be probed (is the standby container running?)' };
  if (recovery.stdout.trim() !== 'f') return { success: false, error: 'This copy is still in recovery, so it is not a source yet' };
  const credential = await readCopyCredential(rec);
  if (!credential) return { success: false, error: 'The replication credential could not be recovered from the copy\'s own connection settings' };
  const cert = await replicaExec(rec.containerName, ['cat', `${PGDATA}/server.crt`]);
  if (!cert.ok) return { success: false, error: 'Could not read the copy\'s server certificate' };
  const dsn = `postgresql://${credential.user}:${encodeURIComponent(credential.password)}@${rec.publicHost}:${rec.hostPort}/${rec.db}?sslmode=verify-full`;
  return { success: true, dsn, cert: cert.stdout };
}

/** The replication credential the seed wrote into this copy's own primary_conninfo; null when unreadable. */
async function readCopyCredential(rec: FleetDbReplicaRecord): Promise<{ user: string; password: string } | null> {
  const conf = await replicaExec(rec.containerName, ['sh', '-c', `grep '^primary_conninfo' ${PGDATA}/postgresql.auto.conf | tail -n 1`]);
  const line = conf.ok ? conf.stdout.trim() : '';
  // The value is quoted, so the first keyword follows a quote, not a space.
  const user = /(?:^|[\s'])user=([^\s']+)/.exec(line)?.[1];
  const password = /(?:^|[\s'])password=([^\s']+)/.exec(line)?.[1];
  return user && password ? { user, password } : null;
}

/**
 * The stand-in's manager gives its bot the block for the PROMOTED copy it
 * serves from, so the bot relays it to the node it stands in for on register
 * (B6 map F32): the source the failback re-seeds the returning master from.
 * Only when the bot says it is the block's target, and only until it holds a
 * block naming this copy. Nothing is filed (F33).
 */
export async function publishStandInCopyBlock(instance: InstanceConfig, facts: AppFacts): Promise<void> {
  const rec = instance.fleetDbReplica;
  if (!rec || facts.copyBlockTarget !== true || containerManager.isBotBusy(instance.id)) return;
  const held = facts.copyBlock?.dsn ? (() => { try { return new URL(facts.copyBlock!.dsn); } catch { return null; } })() : null;
  if (held && held.hostname === rec.publicHost && (Number(held.port) || 5432) === rec.hostPort) return;
  const block = await getStandInCopyBlock(instance);
  if (!block.success || !block.dsn || !block.cert) {
    console.warn(`[FleetReplica] ${instance.displayName}: the stand-in's copy block could not be produced for its bot: ${block.error}`);
    return;
  }
  const published = await publishCopyBlock(instance, { dsn: block.dsn, cert: block.cert });
  if (!published.success) console.warn(`[FleetReplica] ${instance.displayName}: the stand-in's copy block was not published to its bot: ${published.error}`);
}

/**
 * Cancel the seed a runner owns (preparing or seeding: the seed container is
 * removed by name, which ends pg_basebackup and releases the op lock, and the
 * runner clears the record at its next boundary check), or dismiss a parked
 * one. Past the copy (configuring, starting) the standby is seconds from
 * serving, so the answer is "remove it afterwards", never a half-built one.
 *
 * The caller names the run it showed (startedAt, parked) and, once asked,
 * confirms the committed state the question was worded from; any difference
 * is refused or asked again, because a view can be minutes old.
 */
export interface SeedCancelRequest {
  startedAt?: number;
  parked?: boolean;
  committed?: boolean;
  confirm?: boolean;
}

export interface SeedCancelResult {
  success: boolean;
  error?: string;
  dismissed?: boolean;
  needsConfirm?: boolean;
  seed?: { startedAt: number; purpose: FleetReplicaSeedPurpose; parked: boolean; committed: boolean };
}

export async function cancelReplicaSeed(instance: InstanceConfig, request: SeedCancelRequest = {}): Promise<SeedCancelResult> {
  const bot = containerManager.getBot(instance.id);
  // A finished seed's leftovers: its record whose clear was refused, or a note. Dismiss clears them and nothing else.
  const note = seedNotes.get(instance.id);
  if (bot && request.startedAt !== undefined && seedDone(bot) && bot.fleetDbReplicaSeed?.startedAt === request.startedAt) {
    try {
      clearSeed(instance.id);
    } catch (err) {
      return { success: false, error: `The standby was provisioned, but its seed record still could not be cleared (${errorText(err)}); the manager retries on its next health tick` };
    }
    // A note the same seed left (the Restart note) shows next, with its own Dismiss.
    return { success: true, dismissed: true };
  }
  if (bot && !bot.fleetDbReplicaSeed && note && note.startedAt === request.startedAt) {
    seedNotes.delete(instance.id);
    return { success: true, dismissed: true };
  }
  const seed = bot ? seedView(bot) : null;
  if (!seed) {
    return { success: false, error: request.startedAt === undefined ? 'No seed is running on this instance' : 'The seed this view showed is no longer on record (it finished, or was dismissed elsewhere); look again' };
  }
  const parked = seed.parked === true;
  const committed = seed.committed === true;
  const shown = { startedAt: seed.startedAt, purpose: seed.purpose, parked, committed };
  if (request.startedAt !== undefined && request.startedAt !== seed.startedAt) {
    return { success: false, error: 'A different seed run is on this instance since this view loaded; look again before cancelling or dismissing it', seed: shown };
  }
  if (request.parked !== undefined && request.parked !== parked) {
    return { success: false, error: parked ? 'The seed this view showed as running has stopped since; look again' : 'The stopped seed this view showed is running again; look again', seed: shown };
  }
  if (!parked && (seed.phase === 'configuring' || seed.phase === 'starting')) {
    return { success: false, error: 'Too late to cancel: the copy is complete and the standby is starting; remove the replica afterwards instead' };
  }
  const asks = !parked || committed;
  if (request.startedAt === undefined || (asks && (request.confirm !== true || request.committed !== committed))) {
    return { success: false, needsConfirm: true, error: await seedCancelQuestion(instance.id, seed), seed: shown };
  }
  const sweep = async (): Promise<string | null> => {
    let refused: string | null = null;
    for (const name of seedHelperNames(instance)) {
      const result = await dockerRmForce(name);
      if (!rmSettled(result)) refused = result.stderr.trim().split('\n').pop() || 'docker rm failed';
    }
    return refused;
  };
  if (parked) {
    // Best effort, unlike the live branch below: a seed container that outlived
    // its runner can only be writing into a volume the wipe already emptied and
    // no service is on, so a wedged daemon must not block clearing the record.
    // A run started during the sweep owns the record and these names.
    const stillThisRun = (): boolean => {
      const now = containerManager.getBot(instance.id);
      const viewed = now ? seedView(now) : null;
      return !!viewed && viewed.startedAt === seed.startedAt && viewed.parked === true;
    };
    for (const name of seedHelperNames(instance)) {
      if (!stillThisRun()) break;
      await dockerRmForce(name);
    }
    if (!stillThisRun()) {
      return { success: false, error: 'A new seed run started on this instance while the stopped one was being dismissed, so the new run was left as it is; look again' };
    }
    if (replicaClearHeld(instance.id, seed.startedAt)) {
      try {
        clearHeldReplica(instance.id);
      } catch (err) {
        return { success: false, error: `The standby record this seed built still could not be cleared (${errorText(err)}), so the stopped seed was not dismissed; the manager retries on its next health tick` };
      }
    }
    try {
      clearSeed(instance.id);
    } catch (err) {
      return { success: false, error: `The stopped seed record could not be cleared (${errorText(err)}), so it was not dismissed` };
    }
    return { success: true, dismissed: true };
  }
  try {
    saveSeed(instance.id, { cancelRequested: true });
  } catch (err) {
    return { success: false, error: `The cancel could not be recorded (${errorText(err)}), so the seed runs on; nothing was changed` };
  }
  const refused = await sweep();
  // The runner may create the seed container between its boundary check and
  // the spawn; sweep once more for that window, but only while THIS run is
  // still the one on the instance: a re-seed started meanwhile owns the name.
  const cancelledRun = seed.startedAt;
  setTimeout(() => {
    const current = seedRecord(instance.id);
    if (!current || current.startedAt === cancelledRun) void sweep();
  }, 15_000).unref();
  if (refused) return { success: false, error: `Cancel is recorded and the run stops at its next step, but the seed container could not be removed: ${refused}` };
  return { success: true };
}

/** A failback run past its wipe consent, or a decline at seeding or later, retired this machine's own database earlier. */
function seedAfterRetire(instance: InstanceConfig): boolean {
  const run = instance.fleetFailback;
  if (run) return run.mode === 'failback' && run.consentAt !== null;
  const declined = instance.fleetFailbackDeclined;
  return declined?.mode === 'failback' && FAILBACK_PAST_WIPE.has(declined.phase);
}

/** The question a Cancel or Dismiss asks, worded from the record and, for a whole copy, from its container's state now. */
async function seedCancelQuestion(botId: string, seed: FleetReplicaSeedRecord): Promise<string> {
  const instance = containerManager.getBot(botId);
  const rec = instance?.fleetDbReplica;
  const parked = seed.parked === true;
  const afterRetire = !!instance && seedAfterRetire(instance);
  const clearHeld = parked && replicaClearHeld(botId, seed.startedAt);
  const whole = parked && seedBuiltRecord(rec, seed) && !clearHeld;
  let tail = '';
  if (whole && rec) {
    const next = instance?.fleetFailback ? 'Continue on the run card starts its container' : 'pressing Build on its card, then Apply (or Start if the instance is stopped), starts its container';
    const running = await containerRunning(rec.containerName);
    tail = running === true
      ? 'Its standby container is running. Dismissing this note keeps the copy.'
      : running === false
        ? `Its standby container is not running. Dismissing this note keeps the copy, and ${next}.`
        : `The manager can't confirm whether its standby container is running (docker did not answer). Dismissing this note keeps the copy; if the container is not running, ${next}.`;
  }
  const gone = clearHeld
    ? `${afterRetire ? "This machine's own database was already retired earlier in the failback run. " : ''}The standby service did not start. Dismissing this note clears the standby record that start left; the replica volume stays.`
    : seed.purpose === 'reseed-stale-primary'
      ? (whole
        ? `This instance's own database has already been retired. The copy from the stand-in is complete. ${tail}`
        : 'This instance\'s own database has already been retired, so this node is an ordinary worker without a standby until it is re-seeded.')
      : seed.purpose === 'reseed-standby'
        ? (whole
          ? `The copy is complete. ${tail}`
          : 'The old copy has already been cleared, so this standby holds nothing usable until it is re-seeded or removed.')
        : whole
          ? `${afterRetire ? 'This machine\'s own database was already retired earlier in the failback run. ' : ''}The copy is complete and kept on record. ${tail}`
          : afterRetire
            ? 'The partial copy is discarded. This machine\'s own database was already retired earlier in the failback run, so this node is an ordinary worker without a standby until it is re-seeded.'
            : 'The partial copy is discarded; nothing else on this instance is affected.';
  const committed = seed.committed === true;
  if (parked) return `Dismiss this stopped seed?${committed ? `\n\n${gone}` : ''}`;
  return `Cancel this seed?\n\nThe copy stops at its next step.\n\n${committed ? gone : 'Nothing has been deleted by this run yet.'}`;
}

/**
 * Boot: a seed the previous manager process owned has no runner any more and
 * its pg_basebackup cannot be re-attached, so it is parked (kept for display,
 * Retry or Dismiss) and its helper containers are removed by name; a seed
 * nobody will finish only holds the volume and the primary's walsender.
 */
export async function parkInterruptedReplicaSeeds(): Promise<void> {
  for (const instance of containerManager.getAllBots()) {
    const seed = instance.fleetDbReplicaSeed;
    if (!seed || seed.parked) continue;
    const withdrawn = seed.cancelRequested === true;
    // Caught after the refile: the copy is whole and on record, and only the
    // service start the run was awaiting is left, so that is what runs now.
    const rebuilt = !withdrawn && seed.phase === 'starting' && seedBuiltRecord(instance.fleetDbReplica, seed);
    console.log(`[FleetReplica] ${instance.displayName} was seeding (${seed.phase}) when the manager stopped - ${withdrawn ? 'settling the cancel the operator had filed' : rebuilt ? 'its copy is complete and on record, so its standby is started again' : 'parking it'}`);
    for (const name of seedHelperNames(instance)) {
      const result = await dockerRmForce(name);
      // Best effort by design: the record must be parked even with the daemon
      // wedged, and every later path re-runs this removal by name.
      if (!rmSettled(result)) console.warn(`[FleetReplica] Could not remove ${name}: ${result.stderr.trim().split('\n').pop()}`);
    }
    // The runner that would have answered the operator's cancel is gone, and
    // an unanswered instruction is still theirs: this is the other end of a
    // run, so it settles the same way rather than reading as an interruption
    // that anything may resume.
    if (withdrawn) {
      settleCancelledSeed(instance.id, seed.purpose, seed.committed === true);
      continue;
    }
    if (rebuilt) {
      const apply = await containerManager.applyFleetDbReplicaService(instance.id)
        .catch((err: unknown) => ({ success: false, error: err instanceof Error ? err.message : String(err) }));
      if (apply.success) {
        if (seed.purpose === 'provision') await containerManager.markPendingApplyIfRunning(instance.id);
        if (seedRecord(instance.id)?.startedAt === seed.startedAt) containerManager.updateInstanceFleetDbReplicaSeed(instance.id, null);
        if (seed.purpose === 'reseed-standby') ledgerSuccess(instance.id);
        continue;
      }
      const failed = `the manager restarted while the standby was starting, and starting it again failed: ${apply.error}`;
      saveSeed(instance.id, { parked: true, lastError: failed });
      if (seed.purpose === 'reseed-standby') ledgerFailure(instance.id, failed);
      continue;
    }
    const message = `the manager restarted during the seed (phase ${seed.phase})`;
    saveSeed(instance.id, { parked: true, lastError: message });
    if (seed.purpose === 'reseed-standby') ledgerFailure(instance.id, message);
  }
}

/** The remedy for a copy held by a failback that is over, worded from whether the demoted node can receive the current primary's copy block. */
export function coveredOverRefusal(facts: Pick<AppFacts, 'backupMaster' | 'copyBlockCurrent'> | null): string {
  const head = "This copy is the returning master's, and its bot is still in the follower hold of a failback that is over (the node it follows no longer stands in for it)";
  if (facts?.copyBlockCurrent === true) return `${head}; demote the node from its Fleet tab to release the copy, then Re-seed now`;
  if (facts?.backupMaster === true) return `${head}; demote the node from its Fleet tab to release the copy, then Re-seed now once the current primary's copy block reaches this node`;
  return `${head}. Demoted, this node is a co-worker, and a co-worker is not sent the current primary's copy block, so Re-seed now would have nothing to follow. Remove the replica and provision it again from the copy block on the current primary's Database modal, or set BOT_NODE_ROLE=backup-master on this node and restart it first, then demote it from its Fleet tab and Re-seed now once the block reaches it`;
}

/**
 * Re-seed an existing standby whose slot the primary reports lost (20.14). The
 * orchestrator's entry: it keys on the manager's OWN standby record and never
 * passes through provisionFleetReplica's intake guards. The fact that fired it
 * is the TRIGGER; everything here is the manager's PERMIT: an unpromoted copy,
 * no other operation, and a copy block the bot itself holds (relayed by the
 * master to designated backups) that names the primary this standby follows.
 * Every refusal after the attempt is counted is written to the ledger, so
 * "it stopped and asks" shows its reason. A copy the probe reports out of
 * recovery is refused whoever asks; the copy must also be up, unless the
 * manager itself already cleared it, when there is nothing left to protect.
 */
export async function reseedStandby(instance: InstanceConfig, trigger: 'automatic' | 'operator', opts: { consentedRun?: number } = {}): Promise<{ success: boolean; error?: string; started?: boolean }> {
  const held = runHold(instance, opts.consentedRun);
  if (held) return { success: false, error: held };
  // The drop-back run's consent (F32 under F5) is what re-seeds a promoted copy
  // that took the fleet's writes as a stand-in: the operator saw the verdict.
  const consenting = liveFailback(instance);
  const consented = opts.consentedRun !== undefined && consenting?.startedAt === opts.consentedRun && consenting.consentAt !== null;
  const rec = instance.fleetDbReplica;
  if (!rec) return { success: false, error: 'This instance has no standby to re-seed' };
  if (seedRunning(instance.id)) return { success: false, error: 'A seed is already running on this instance' };
  const busyOp = containerManager.isBotBusy(instance.id);
  if (busyOp) return { success: false, error: `Operation '${busyOp}' is running on this instance; wait for it to finish` };
  if (!rec.user || !rec.db) return { success: false, error: 'This standby record predates identity stamping; retire and re-provision the standby' };
  const capability = capabilityRefusal(instance);
  if (capability) return { success: false, error: capability };
  const status = await getFleetReplicaStatus(instance);
  // The app's explicit stand-in posture outranks the recovery reading (20.5,
  // B6 map F34/F35): a serving copy IS the fleet's database, and a peer's copy
  // keeps its place for the failback. Judged BEFORE the ledger: a freeze can
  // last hours, and counting it as attempts would latch the automatic re-seed
  // off for good. One facts read serves this and the copy block below.
  const factsRead = hasAppHooks(instance) ? await getAppFacts(instance, FACTS_TIMEOUT_MS) : null;
  const posture = postureFromRead(instance, factsRead);
  const standing = posture.read === 'ok' ? posture.posture : null;
  const promotedCopy = status.live?.running === true && status.live.inRecovery === false;
  if (standing?.role === 'stand-in' && standing.live) {
    return { success: false, error: `This copy is standing in for ${shortId(standing.coveringNodeId)}${standing.holdsWrites ? ' and holds the fleet\'s writes' : ''}; re-seeding it would destroy the database the fleet is on. It returns to standby duty through the failback, or by hand after a manual promote` };
  }
  if (standing?.role === 'stand-in' && promotedCopy && !consented) {
    return { success: false, error: `This copy took the fleet's writes as a stand-in for ${shortId(standing.coveringNodeId)} and the lane ended (${standing.disarmReason ?? 'no reason recorded'}); re-seeding would discard writes that may exist only here. Promote this node by hand to keep them, or remove the replica and provision it again to discard them` };
  }
  if (standing?.role === 'peer') {
    return { success: false, error: `The fleet is being served by a stand-in for ${shortId(standing.coveringNodeId)}, whose database this copy follows; it keeps its place for the failback and is not re-seeded until that settles` };
  }
  if (standing?.role === 'covered') {
    return { success: false, error: standing.namesThisNode === false
      ? coveredOverRefusal(factsRead?.facts ?? null)
      : `This copy is the returning master's, held for the failback from ${standing.standInNodeId ? `its stand-in ${shortId(standing.standInNodeId)}` : 'the node holding the fleet'}; it is the copy the failback promotes, so it is not re-seeded from here` };
  }
  if (trigger === 'operator') patchLedger(instance.id, () => undefined);
  ledgerAttempt(instance.id, trigger);
  const refuse = (error: string): { success: false; error: string } => {
    ledgerOrWarn(instance.id, () => ledgerFailure(instance.id, error));
    return { success: false, error };
  };

  // An unanswered app is a failure the ledger exists to latch (the attempt
  // cap stops the automatic retry), unlike the freezes above.
  if (posture.read === 'unanswered') {
    return refuse(`The app on this instance is not answering (${posture.error}), so the manager cannot tell whether this copy is standing in for a dead master; ${unansweredRemedy(posture.error)} before re-seeding it`);
  }
  // Never re-seeded over, whoever asks and whatever a stopped run left behind:
  // a promoted copy is the database its fleet now serves.
  if (status.live?.running && status.live.inRecovery !== true && !consented) {
    return refuse('This copy has been promoted and no longer follows a primary; adopt it or remove it instead of re-seeding');
  }
  // The copy must be up to be proven unpromoted, unless the manager itself
  // already cleared it: there is then nothing left that a promotion could have
  // turned into a primary, and refusing would strand the standby for good.
  if (rec.copyCleared !== true && !status.live?.running) {
    // Both remedies, because a re-seed that stopped before it cleared anything
    // took the standby service out of the compose, where a start cannot bring
    // it back, and the record that would tell them apart is deleted by a
    // cancel filed in that same window.
    if (!status.live) return refuse(`Could not read the standby container (${status.probeError || 'no output'}), so it cannot be verified as an unpromoted copy; try again`);
    return refuse('The standby container is not running, so it cannot be verified as an unpromoted copy; start the instance if it is stopped, and press Build on its card, then Apply (or Start if the instance is stopped), if a stopped re-seed took the standby service out of its compose');
  }
  if (!hasAppHooks(instance)) return refuse('This app declares no lifecycle hooks, so the manager cannot obtain the copy block; remove the replica and provision it again by hand');
  const facts = factsRead ?? await getAppFacts(instance, FACTS_TIMEOUT_MS);
  if (!facts.success) return refuse(`Could not read the copy block from the app: ${facts.error}`);
  const block = facts.facts?.copyBlock;
  if (!block?.dsn || !block.cert) {
    return refuse('The bot holds no copy block for the primary (only a designated backup receives one); remove the replica and provision it again from the block on the primary machine');
  }
  // The app's own verdict. The source check below cannot stand in for it: a
  // block inherited from a former master names the very primary this standby
  // still follows, so it passes that check while naming a fenced database.
  if (facts.facts?.copyBlockCurrent === false) {
    return refuse('The block this node holds names a database that is not the one the fleet follows now (it came from a former master). The current primary\'s block reaches this node only at its next registration with that primary, once that primary\'s manager has published it (opening its Replication section does): restart this bot after that, then re-seed');
  }
  const validated = validateIntake(block.dsn, block.cert, rec.publicHost, rec.hostPort);
  if (!validated.ok) return refuse(`The copy block the bot holds is unusable: ${validated.error}`);
  const { dsn } = validated.intake;
  // 20.19 F5: a re-seed may REPOINT a survivor of a failover. A block naming a
  // different endpoint is the new master's, but only the app's own fact that
  // this copy's source is no longer the fleet's master moves the record; the
  // new source is proven by assertSeedableSource before anything destructive
  // runs, and the copy is rebuilt whole either way (the credential rotated).
  let target = rec;
  if (dsn.host !== rec.primaryHost || dsn.port !== rec.primaryPort) {
    // A stopped run of THIS repoint is the operator's own decision, still
    // standing: the record only takes the new endpoint when a run finishes, so
    // a repoint that died mid-way still reads as a mismatch, and its copy is
    // already gone. A plain re-seed that a later failover overtook parked
    // against the OLD endpoint, so it never matches here.
    const stopped = seedRecord(instance.id);
    // A cancel filed before the runner reached a boundary and then lost to a
    // manager restart parks the record with the request standing and cancelled
    // never set, and a withdrawn decision authorises nothing.
    const authorised = stopped?.purpose === 'reseed-standby'
      && stopped.cancelled !== true && stopped.cancelRequested !== true
      && stopped.primaryHost === dsn.host && stopped.primaryPort === dsn.port;
    if (!authorised) {
      const fact = facts.facts?.standbySlot;
      const leftBehind = fact?.sourceIsCurrentMaster === false
        && slotFactFresh(fact.receivedAt);
      if (!leftBehind) {
        return refuse(`The copy block names ${dsn.host}:${dsn.port} but this standby follows ${rec.primaryHost}:${rec.primaryPort}, and the bot does not report its source as a former master; remove the replica and provision it from the new primary instead`);
      }
      // F5 rules out an automatic repoint: moving a standby to a different
      // primary is the operator's decision, never a lane that runs on its own.
      if (trigger !== 'operator') {
        return refuse(`This standby follows ${rec.primaryHost}:${rec.primaryPort}, which is no longer the fleet's master; repointing it at ${dsn.host}:${dsn.port} is an operator decision, so the automatic re-seed stops here`);
      }
    }
    target = { ...rec, primaryHost: dsn.host, primaryPort: dsn.port };
  }
  const started = startProvisioning(instance, target, validated.intake, 'reseed-standby', async () => {
    // The permits were read before the lock: a Remove replica that landed
    // meanwhile must not be undone by this run writing its record back.
    const fresh = containerManager.getBot(instance.id)?.fleetDbReplica;
    if (!fresh || fresh.containerName !== rec.containerName || fresh.volume !== rec.volume) {
      throw new SeedSuperseded('the standby record changed while the re-seed was starting');
    }
    const removed = await containerManager.removeFleetDbReplicaService(instance.id, rec.containerName);
    if (!removed.success) throw new Error(`could not stop the stale standby: ${removed.error}`);
    // The wipe below runs inside the same volume, so the standby postgres
    // must be PROVEN gone, unknown included.
    if (await containerRunning(rec.containerName) !== false) {
      throw new Error('the standby database container is still present after the stop, so its copy cannot be cleared safely');
    }
  });
  if (!started.success) return refuse(started.error || 'the seed could not be started');
  return { success: true, started: true };
}
