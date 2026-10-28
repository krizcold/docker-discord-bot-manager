/**
 * The watcher of a joined machine: every 5 minutes it keeps the bot's database list in line with the registry,
 * reads the main's address list once an hour, and judges whether this machine's copy needs a rebuild because the
 * main no longer keeps its place. A rebuild runs only when the two databases prove the copy holds nothing the main
 * lacks; otherwise the panel names why, and the owner gets one message per case.
 */
import * as containerManager from '../docker/containerManager';
import * as fleetBackupGuards from './fleetBackupGuards';
import * as fleetReplica from './fleetReplica';
import {
  mainCertificate, mainProbe, machineNameOf, readCopyFacts, refreshDue, refreshJoin, SlotState, storedJoin, writeEnvList,
} from './fleetJoin';
import { alertStep, dmOutcomeText, utcText } from './backupFiles';
import { notifyOwner } from './backupCheck';
import { FleetBackupAlert, InstanceConfig } from '../types';
import { lsnText } from '../config/joinCode';

export const watchTiming = { firstTickMs: 60_000, everyMs: 5 * 60_000 };
/** A failed automatic run is tried again after this long, keyed on the parked record's updatedAt. */
export const RETRY_AFTER_MS = 30 * 60_000;

export interface VerdictAdmission {
  copyCleared: boolean;
  /** When an operator turned automatic rebuilding off (cancel or dismiss); null when it is on. */
  heldAt: string | null;
  /** Something else runs on this instance or its database (a seed, an operation, a dump or restore, a shutdown). */
  busy: string | null;
  /** A stopped seed on the record. */
  parked: { auto: boolean; cancelled: boolean; updatedAt: number } | null;
  /** The main's system id recorded at the join, for a copy that is already cleared. */
  joinedSystemId: string | null;
  /** The main's address, for the texts. */
  host: string;
  port: number;
  /** When the copy's last automatic safety dumps were taken. */
  rebuildDumps?: number[];
  /** The stored error of the stopped seed on record, for the three-dump hold's text. */
  lastRunError?: string | null;
}

const DUMP_HOLD_COUNT = 3;
const DUMP_HOLD_WINDOW_MS = 24 * 3600_000;

/** The time of the first of the last three safety dumps when all three fall within 24 hours; null otherwise. */
function dumpHoldSince(dumps: number[] | undefined): number | null {
  if (!dumps || dumps.length < DUMP_HOLD_COUNT) return null;
  const last = dumps.slice(-DUMP_HOLD_COUNT);
  return last[last.length - 1] - last[0] <= DUMP_HOLD_WINDOW_MS ? last[0] : null;
}

export type VerdictCopy = { answered: false; reason: string }
  | { answered: true; inRecovery: boolean; streaming: boolean; systemId: string; timeline: number; lsn: bigint };

export type VerdictMain = { answered: false; reason: string }
  | { answered: true; inRecovery: boolean; systemId: string; timeline: number; lsn: bigint; slot: SlotState };

export type Verdict =
  | { kind: 'ok' }
  | { kind: 'unknown'; reason: string }
  | { kind: 'held'; reason: string; cleared?: true }
  | { kind: 'wait'; reason: string }
  | { kind: 'rebuild'; slot: 'absent' | 'lost' | 'kept' };

/**
 * Whether this copy is rebuilt now. `rebuild` only when every fact is safe: the copy answers and is still a copy, it
 * does not stream, the main answers, is not in recovery, has this copy's system id and timeline, is at or past the
 * copy's position, and keeps no slot for it (absent, or lost and inactive), with nothing else running and no
 * operator hold. A copy the manager already cleared holds nothing to protect, so it is rebuilt whatever its slot
 * reads, unless the slot is in use. Any unread fact is `unknown`; any unsafe one is `held` or `wait`.
 */
export function rebuildVerdict(admission: VerdictAdmission, copy: VerdictCopy | null, main: VerdictMain | null, now: number): Verdict {
  const where = `${admission.host}:${admission.port}`;
  const held = (reason: string): Verdict => admission.copyCleared ? { kind: 'held', reason, cleared: true } : { kind: 'held', reason };
  if (!admission.copyCleared) {
    if (!copy || !copy.answered) return { kind: 'unknown', reason: copy?.reason ?? "the copy's database did not answer" };
    if (!copy.inRecovery || copy.streaming) return { kind: 'ok' };
  }
  if (!main || !main.answered) return { kind: 'unknown', reason: main?.reason ?? 'the main was not read' };
  if (main.slot === 'active') return admission.copyCleared ? { kind: 'wait', reason: "the main shows this copy's slot in use" } : { kind: 'ok' };
  if (main.slot === 'kept' && !admission.copyCleared) return { kind: 'ok' };
  if (main.inRecovery) return held(`the database at ${where} follows another database itself`);
  const ownId = admission.copyCleared ? admission.joinedSystemId : (copy as Extract<VerdictCopy, { answered: true }>).systemId;
  if (!ownId) return { kind: 'unknown', reason: 'the system id the copy was made from is not on record' };
  if (main.systemId !== ownId) {
    return held(`the database at ${where} (system id ${main.systemId}) is not the one this copy was made from (system id ${ownId})`);
  }
  if (!admission.copyCleared) {
    const c = copy as Extract<VerdictCopy, { answered: true }>;
    if (main.timeline !== c.timeline) {
      return held(`the main is on timeline ${main.timeline} and this copy on timeline ${c.timeline}, so the main changed since this copy was made`);
    }
    if (main.lsn < c.lsn) {
      return held(`the main is at position ${lsnText(main.lsn)}, behind this copy's ${lsnText(c.lsn)}, so this copy may hold changes the main lacks`);
    }
  }
  if (admission.heldAt) {
    return held(`automatic rebuilding is off for this copy since a rebuild was cancelled or dismissed on ${admission.heldAt.slice(0, 10)}`);
  }
  const since = admission.copyCleared ? null : dumpHoldSince(admission.rebuildDumps);
  if (since !== null) {
    const last = admission.lastRunError ? `; the last one stopped: ${admission.lastRunError}` : '';
    return held(`${DUMP_HOLD_COUNT} automatic rebuilds took a safety dump of this copy since ${new Date(since).toISOString().slice(0, 10)}, and no more start until a Re-seed in its manager${last}`);
  }
  if (admission.parked) {
    if (!admission.parked.auto || admission.parked.cancelled) return { kind: 'wait', reason: 'a stopped re-seed is on record; the operator decides it' };
    if (now - admission.parked.updatedAt < RETRY_AFTER_MS) return { kind: 'wait', reason: 'the last automatic rebuild stopped less than 30 minutes ago' };
  }
  if (admission.busy) return { kind: 'wait', reason: admission.busy };
  return { kind: 'rebuild', slot: main.slot === 'lost' || main.slot === 'kept' ? main.slot : 'absent' };
}

/**
 * T-33. A whole copy is held only while its slot reads gone (absent) or invalidated (lost); a copy the manager cleared
 * is held whatever its slot reads, so its line names the deletion instead.
 */
export function heldText(reason: string, cleared = false): string {
  if (cleared) return `This copy was deleted by a rebuild or Re-seed that stopped, and it was not rebuilt automatically: ${reason}. The manager waits for a Re-seed here: press Re-seed to rebuild it.`;
  return `The main no longer keeps this copy's place (its slot is gone or was invalidated), so the copy cannot catch up. It was not rebuilt automatically: ${reason}. Press Re-seed to rebuild it.`;
}

export function unknownText(reason: string): string {
  return `Can't confirm whether the main still keeps this copy's place: ${reason}.`;
}

/** The panel line of a verdict; null for one that shows nothing. */
export function verdictText(v: Verdict): string | null {
  if (v.kind === 'held') return heldText(v.reason, v.cleared === true);
  if (v.kind === 'unknown') return unknownText(v.reason);
  return null;
}

function busyReason(instance: InstanceConfig): string | null {
  const seed = fleetReplica.seedView(instance);
  if (seed && seed.parked !== true) return 'a seed is running';
  const op = containerManager.isBotBusy(instance.id);
  if (op) return `operation '${op}' is running`;
  if (fleetBackupGuards.isFleetBackupBusy(instance.id)) return 'a backup or restore is running on this database';
  if (containerManager.isShuttingDown()) return 'the manager is shutting down';
  return containerManager.registryFault();
}

/** Reads the facts and judges. `inLock` is the re-check inside the run's own op lock, where the run itself is the busy one. */
export async function computeVerdict(instance: InstanceConfig, now: number, opts: { inLock?: boolean } = {}): Promise<Verdict> {
  const rec = instance.fleetDbReplica;
  if (!rec) return { kind: 'ok' };
  const join = storedJoin(instance);
  if (!join) return { kind: 'wait', reason: 'the stored join code cannot be read' };
  const seed = fleetReplica.seedView(instance);
  const admission: VerdictAdmission = {
    copyCleared: rec.copyCleared === true,
    heldAt: rec.autoRebuildHeldAt ?? null,
    busy: opts.inLock ? null : busyReason(instance),
    parked: !opts.inLock && seed?.parked ? { auto: seed.auto === true, cancelled: seed.cancelled === true, updatedAt: seed.updatedAt } : null,
    joinedSystemId: instance.fleetJoin?.systemId ?? null,
    host: join.host,
    port: join.port,
    rebuildDumps: rec.rebuildDumps,
    lastRunError: !opts.inLock && seed?.parked ? seed.lastError ?? null : null,
  };
  let copy: VerdictCopy | null = null;
  if (!admission.copyCleared) {
    const read = await readCopyFacts(rec);
    copy = read.ok ? { answered: true, ...read.facts } : { answered: false, reason: read.reason };
    if (!read.ok || !read.facts.inRecovery || read.facts.streaming) return rebuildVerdict(admission, copy, null, now);
  }
  const cert = await mainCertificate(join);
  let main: VerdictMain;
  if (!cert.ok) {
    main = { answered: false, reason: cert.reason };
  } else {
    const probe = await mainProbe(instance, join, cert.pem, rec.slot);
    main = probe.ok ? { answered: true, ...probe.facts } : { answered: false, reason: probe.reason };
  }
  return rebuildVerdict(admission, copy, main, now);
}

const verdicts = new Map<string, { verdict: Verdict; text: string | null }>();

/** The watcher's last verdict for the panel (memory and display only). */
export function lastVerdict(botId: string): { verdict: Verdict; text: string | null } | null {
  return verdicts.get(botId) ?? null;
}

function sameVerdict(a: Verdict | undefined, b: Verdict): boolean {
  return !!a && JSON.stringify(a) === JSON.stringify(b);
}

function noteVerdict(instance: InstanceConfig, v: Verdict): void {
  const prev = verdicts.get(instance.id)?.verdict;
  const text = verdictText(v);
  verdicts.set(instance.id, { verdict: v, text });
  if (sameVerdict(prev, v)) return;
  if (v.kind === 'held') console.warn(`[FleetCopy] ${instance.displayName}: the copy needs a rebuild but was not rebuilt automatically: ${v.reason}`);
  else if (v.kind === 'unknown') console.warn(`[FleetCopy] ${instance.displayName}: ${text}`);
}

export function heldMessage(instance: InstanceConfig, reason: string, cleared = false): string {
  if (cleared) return `The live database copy on ${machineNameOf(instance)} was deleted by a rebuild or Re-seed that stopped, and it was not rebuilt automatically: ${reason}. Its manager waits for a Re-seed: open that machine's manager to press Re-seed.`;
  return `The live database copy on ${machineNameOf(instance)} needs a rebuild from the main, and it was not rebuilt automatically: ${reason}. Open that machine's manager to press Re-seed.`;
}

export function stoppedMessage(instance: InstanceConfig, why: string, safetyDump?: string): string {
  const kept = safetyDump ? ` A backup of the old copy is kept on that machine as ${safetyDump}.` : '';
  return `The automatic rebuild of the live database copy on ${machineNameOf(instance)} stopped after the old copy was deleted: ${why}. That machine holds no copy of the database until a rebuild finishes; its manager tries again every 30 minutes, and Re-seed in that machine's manager starts one now.${kept}`;
}

export function reseedStoppedMessage(instance: InstanceConfig, why: string, safetyDump?: string): string {
  const kept = safetyDump ? ` A backup of the old copy is kept on that machine as ${safetyDump}.` : '';
  return `A Re-seed of the live database copy on ${machineNameOf(instance)} stopped after the old copy was deleted: ${why}. That machine holds no copy of the database until a Re-seed in its manager finishes.${kept}`;
}

/** One case's state for the step: on, off, or left as it is (a fact that could not be read moves nothing). */
type CaseState = { on: true; text: string } | { on: false } | null;

function heldCase(v: Verdict | null, hasRecord: boolean, instance: InstanceConfig): CaseState {
  if (!hasRecord) return { on: false };
  if (!v) return null;
  if (v.kind === 'held') return { on: true, text: heldMessage(instance, v.reason, v.cleared === true) };
  if (v.kind === 'ok' || v.kind === 'rebuild') return { on: false };
  return null;
}

function stoppedCase(instance: InstanceConfig): CaseState {
  const seed = fleetReplica.seedView(instance);
  if (!seed || seed.committed !== true || seed.cancelled === true) return { on: false };
  const auto = seed.auto === true;
  if (!auto && instance.fleetDbReplica?.copyCleared !== true) return { on: false };
  if (fleetReplica.seedBuiltRecord(instance.fleetDbReplica, seed)) return { on: false };
  if (seed.parked !== true) return null;
  const why = seed.lastError || 'it stopped';
  return { on: true, text: auto ? stoppedMessage(instance, why, seed.safetyDump) : reseedStoppedMessage(instance, why, seed.safetyDump) };
}

const unsavedCopyAlerts = new Map<string, FleetBackupAlert | null>();

function currentCopyAlerts(instance: InstanceConfig): Record<string, FleetBackupAlert> {
  const out: Record<string, FleetBackupAlert> = { ...(containerManager.getBot(instance.id)?.fleetCopyAlerts ?? {}) };
  for (const [k, alert] of unsavedCopyAlerts) {
    const [id, key] = k.split('|');
    if (id !== instance.id) continue;
    if (alert) out[key] = alert;
    else delete out[key];
  }
  return out;
}

function saveCopyAlert(instance: InstanceConfig, key: string, alert: FleetBackupAlert | null): void {
  try {
    containerManager.updateInstanceFleetCopyAlert(instance.id, key, alert);
    unsavedCopyAlerts.delete(`${instance.id}|${key}`);
  } catch (err) {
    unsavedCopyAlerts.set(`${instance.id}|${key}`, alert);
    console.error(`[FleetCopy] The owner message state ${key} of ${instance.displayName} could not be saved, so a manager restart may send it again (${err instanceof Error ? err.message : String(err)})`);
  }
}

/** Once per case: a message when a case starts, tried again hourly while it fails, and again only after the case ends and comes back. */
export async function stepCopyAlerts(instance: InstanceConfig, cases: Record<'held' | 'stopped', CaseState>, now: number): Promise<void> {
  const current = currentCopyAlerts(instance);
  for (const key of ['held', 'stopped'] as const) {
    const state = cases[key];
    if (state === null) continue;
    if (containerManager.getBot(instance.id)?.fleetDb) return;
    const prev = current[key];
    const { next, send } = alertStep(prev, state.on, key, state.on ? state.text : '', now);
    if (!next) {
      if (prev) saveCopyAlert(instance, key, null);
      continue;
    }
    if (!prev || prev.text !== next.text) saveCopyAlert(instance, key, next);
    if (!send) continue;
    const result = await notifyOwner(instance, next.text);
    console.log(`[FleetCopy] Message to the owner of ${instance.displayName} about the copy (${key}): ${result.dm}${result.dmError ? ` (${result.dmError})` : ''}`);
    // The send can take 30 s without a lock: an adopt or a newer case in that time must not get this outcome written back.
    const live = containerManager.getBot(instance.id);
    if (!live || live.fleetDb || currentCopyAlerts(live)[key]?.since !== next.since) continue;
    const { dmError: _old, ...rest } = next;
    saveCopyAlert(instance, key, { ...rest, dm: result.dm, dmAt: now, ...(result.dmError ? { dmError: result.dmError } : {}) });
  }
}

export { dmOutcomeText };

/** The instance as the registry holds it now, when the watcher still looks after it: joined, not the main itself, and free. */
function watched(id: string): InstanceConfig | null {
  const instance = containerManager.getBot(id);
  if (!instance?.fleetJoin || instance.fleetDb || containerManager.isBotBusy(id)) return null;
  return instance;
}

/** Each env write reads the instance in the same synchronous step, so a join saved while the tick ran is never overwritten. */
async function tickOne(id: string, now: number): Promise<void> {
  const instance = watched(id);
  if (!instance) return;
  try {
    await writeEnvList(id);
  } catch (err) {
    console.warn(`[FleetCopy] ${instance.displayName}: the Database URL could not be written: ${err instanceof Error ? err.message : String(err)}`);
  }
  const before = watched(id);
  if (before?.fleetJoin && refreshDue(before.fleetJoin, now)) {
    try {
      await refreshJoin(before);
      if (watched(id)) await writeEnvList(id);
    } catch (err) {
      console.warn(`[FleetCopy] ${instance.displayName}: the address list could not be refreshed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const fresh = containerManager.getBot(id);
  if (!fresh?.fleetJoin || fresh.fleetDb) return;
  if (!fresh.fleetDbReplica) {
    verdicts.delete(fresh.id);
    await stepCopyAlerts(fresh, { held: { on: false }, stopped: stoppedCase(fresh) }, now);
    await fleetReplica.sendRebuiltAlert(fresh.id, now);
    return;
  }
  const verdict = await computeVerdict(fresh, now);
  noteVerdict(fresh, verdict);
  if (verdict.kind === 'rebuild') {
    const started = fleetReplica.startAutoRebuild(fresh, verdict.slot, async () => {
      const inLock = containerManager.getBot(fresh.id);
      return !!inLock && (await computeVerdict(inLock, Date.now(), { inLock: true })).kind === 'rebuild';
    });
    if (!started.started) console.warn(`[FleetCopy] ${fresh.displayName}: the rebuild did not start: ${started.reason}`);
  }
  const after = containerManager.getBot(fresh.id) ?? fresh;
  await stepCopyAlerts(after, { held: heldCase(verdict, true, after), stopped: stoppedCase(after) }, now);
  await fleetReplica.sendRebuiltAlert(fresh.id, now);
}

let ticking = false;

/** One pass over every joined instance, in sequence; a pass that is still running is not started twice. */
export async function runFleetCopyTick(now = Date.now()): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    for (const instance of containerManager.getAllBots()) {
      try {
        await tickOne(instance.id, now);
      } catch (err) {
        console.error(`[FleetCopy] ${instance.displayName}: the check failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    ticking = false;
  }
}

let firstTimer: ReturnType<typeof setTimeout> | null = null;
let interval: ReturnType<typeof setInterval> | null = null;

export function startFleetCopyWatch(): void {
  if (firstTimer || interval) return;
  firstTimer = setTimeout(() => {
    firstTimer = null;
    void runFleetCopyTick();
    interval = setInterval(() => { void runFleetCopyTick(); }, watchTiming.everyMs);
  }, watchTiming.firstTickMs);
}

export function stopFleetCopyWatch(): void {
  if (firstTimer) clearTimeout(firstTimer);
  if (interval) clearInterval(interval);
  firstTimer = null;
  interval = null;
}

/** The Database window's data about the join. */
export function joinView(instance: InstanceConfig): Record<string, unknown> | null {
  const j = instance.fleetJoin;
  if (!j) return null;
  return {
    host: j.host,
    port: j.port,
    machine: j.machine,
    joinedAt: j.joinedAt,
    addressCount: (j.addresses ?? []).length,
    addressesReadAt: j.addressesReadAt ?? null,
    addressesError: j.addressesError ?? null,
    codeUnreadable: storedJoin(instance) === null,
  };
}

/** The stored rebuild message's outcome as the window shows it, from the record, so it outlives a restart; null while it waits for its first send. */
function rebuiltLine(instance: InstanceConfig): string | null {
  const a = currentCopyAlerts(instance).rebuilt;
  const outcome = a ? dmOutcomeText(a) : null;
  if (!a || !outcome) return null;
  const retry = a.dm === 'failed' && instance.fleetJoin ? ' The manager tries again every hour.' : '';
  return `The copy was rebuilt automatically (the run started ${utcText(a.since)}). ${outcome}${retry}`;
}

/** The Database window's data about the rebuild: the last verdict's line, the hold, and each owner message's outcome. */
export function rebuildView(instance: InstanceConfig): Record<string, unknown> | null {
  const rec = instance.fleetDbReplica;
  if (!rec && !instance.fleetCopyAlerts) return null;
  const last = lastVerdict(instance.id);
  const alerts: Record<string, { text: string; dm: FleetBackupAlert['dm']; outcome: string | null }> = {};
  for (const [key, a] of Object.entries(currentCopyAlerts(instance))) alerts[key] = { text: a.text, dm: a.dm, outcome: dmOutcomeText(a) };
  return {
    kind: last?.verdict.kind ?? null,
    text: last?.text ?? null,
    heldAt: rec?.autoRebuildHeldAt ?? null,
    alerts,
    rebuilt: rebuiltLine(instance),
  };
}
