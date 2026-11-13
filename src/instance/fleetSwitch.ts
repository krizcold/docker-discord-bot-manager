/**
 * The switch of a bot's main database between machines: Hand over on the main and Take over on the copy (a planned
 * move, joined through the hand-over row the copy replays), the unplanned Take over with its warnings, the old main's
 * rejoin as a copy, Keep this machine as the main, and the tick that writes the generation row, sends the switch
 * notice and finds a main that another database replaced. Every switch raises the generation row (contract 4).
 */
import { startProcess } from '../docker/processStart';
import * as fs from 'fs';
import * as net from 'net';
import * as containerManager from '../docker/containerManager';
import * as envManager from '../env/manager';
import * as dbLogin from './dbLogin';
import { MANAGER_DB_ROLE } from './dbLogin';
import * as fleetBackup from './fleetBackup';
import * as fleetJoin from './fleetJoin';
import * as fleetReplica from './fleetReplica';
import * as maintenance from './maintenance';
import { callAppHook, capabilityRefusal } from './appHookClient';
import { notifyOwner } from './backupCheck';
import { claimFleetBackupBusy, releaseFleetBackupBusy } from './fleetBackupGuards';
import { storedDbPassword } from './fleetReplication';
import { certFingerprint, decodeJoinCode, encodeJoinCode, JoinCode, lsnToBigInt, machineText, sqlLiteral } from '../config/joinCode';
import { DM_RETRY_MS, utcText } from './backupFiles';
import {
  COPIES_READ_SQL, COPIES_SYNC_SQL, DB_OID_SQL, ensureGenerationSql, FORMER_LISTED_SQL, GEN_READ_SQL, GENERATION_SCHEMA_SQL, GenRow, generationBefore, HANDOVER_READ_SQL, machineNameOf, missingTable, moveModeText,
  parseGenRow, parseReceiveMark, parseRestoreState, raiseSql, RECEIVE_MARK_READ_SQL, RECEIVED_OF_SQL, receiveMarkClearSql, receiveMarkVerdict, RESTORE_STATE_CLEAR, RESTORE_STATE_READ, RestoreState, TAKEOVER_ROLE_RE,
  SHARD_CAP_DO_SQL, takeoverBlockScript, takeoverLiftScript,
} from './switchSql';
import { FleetDbConflict, FleetDbFormerMain, FleetDbHandover, FleetDbReplaced, FleetDbReplicaRecord, FleetDbSwitchNotice, InstanceConfig, MaintenanceHeld, MaintenanceRecord, OwnerDm } from '../types';

export const SWITCH_TIMING = {
  readMs: 30_000,
  catchUpMs: 60_000,
  pollMs: 1_000,
  replayWaitMs: 30_000,
  promoteMs: 90_000,
  noticeMs: 30_000,
  tickMs: 60_000,
  peerEveryMs: 5 * 60_000,
  rejoinRetryMs: 30 * 60_000,
  firstMs: 5_000,
  blockProbeMs: 15_000,
  blockGapMs: 250,
};

const SLOT_RE = /^[a-z0-9_]{1,63}$/;
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const lastLine = (text: string) => text.trim().split('\n').map(l => l.trim()).filter(Boolean).pop() || 'no reason given';
const errorOf = (stderr: string) => {
  const lines = stderr.split('\n').map(l => l.trim()).filter(Boolean);
  return (lines.find(l => /\b(ERROR|FATAL):/.test(l)) ?? lines[lines.length - 1] ?? 'no reason given').replace(/^psql: error: /, '');
};
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const NOTHING = '; nothing was changed';

// ─── Process starts ───

export type Guarded = { ok: boolean; code: number | null; stdout: string; stderr: string; error?: string };

/**
 * One process start, guarded for Node 24's fork faults: a synchronous throw (ENOMEM) and a child with no stdio that
 * emits 'error' on the next tick (EMFILE, ENFILE) both answer ok false. Input is a string, or a file streamed in.
 */
export function runGuarded(cmd: string, args: string[], opts: { input?: string; inputPath?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<Guarded> {
  return new Promise(resolve => {
    const started = startProcess(cmd, args, opts.env ? { env: opts.env } : {});
    if (!started.child) {
      resolve({ ok: false, code: null, stdout: '', stderr: '', error: started.error });
      return;
    }
    const child = started.child;
    let stdout = '';
    let stderr = '';
    let done = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (r: Guarded) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* gone */ }
        finish({ ok: false, code: null, stdout, stderr, error: `no answer within ${Math.round(opts.timeoutMs! / 1000)} seconds` });
      }, opts.timeoutMs);
    }
    child.stdout?.on('data', d => { if (stdout.length < 1_000_000) stdout += d; });
    child.stderr?.on('data', d => { if (stderr.length < 8000) stderr += d; });
    child.on('error', err => finish({ ok: false, code: null, stdout, stderr, error: `${cmd} failed (${errText(err)})` }));
    child.on('close', code => finish({ ok: code === 0, code, stdout, stderr, ...(code === 0 ? {} : { error: errorOf(stderr) }) }));
    child.stdin?.on('error', () => { /* EPIPE when the child ends first; close answers */ });
    if (opts.inputPath && child.stdin) {
      const input = fs.createReadStream(opts.inputPath);
      input.on('error', err => {
        try { child.kill('SIGKILL'); } catch { /* gone */ }
        finish({ ok: false, code: null, stdout, stderr, error: `the file could not be read (${errText(err)})` });
      });
      input.pipe(child.stdin);
    } else {
      child.stdin?.end(opts.input ?? '');
    }
  });
}

type Target = { container: string; user: string };

/** A psql script on stdin as the manager's role (the bot role on a copy that lacks it yet). */
export function adminSql(t: Target, db: string, sql: string, timeoutMs = SWITCH_TIMING.readMs): Promise<Guarded> {
  const args = ['exec', '-i', t.container, 'psql', '-U', MANAGER_DB_ROLE, '-d', db, '-tAq', '-v', 'ON_ERROR_STOP=1'];
  return dbLogin.asManager(t, role => runGuarded('docker', dbLogin.withRole(args, role), { input: sql, timeoutMs }), r => !r.ok && dbLogin.isMissingManagerRole(r.stderr));
}

const failText = (r: Guarded) => r.error || errorOf(r.stderr);

const HBA_REJECTS = 'pg_hba.conf rejects connection';

/** A bot-role login over TCP on the copy: whether pg_hba rejects it (a NOLOGIN refusal or a success both read false). */
async function hbaRejects(t: Target, db: string): Promise<boolean> {
  const r = await runGuarded('docker', ['exec', t.container, 'psql', '-h', '127.0.0.1', '-U', t.user, '-d', db, '-w', '-tAc', 'SELECT 1'], { timeoutMs: SWITCH_TIMING.readMs });
  return r.stderr.includes(HBA_REJECTS);
}

/** Polls the TCP login until pg_hba rejects it (want true) or no longer does (want false), within blockProbeMs. */
async function hbaProof(t: Target, db: string, want: boolean): Promise<boolean> {
  const deadline = Date.now() + SWITCH_TIMING.blockProbeMs;
  for (;;) {
    if (await hbaRejects(t, db) === want) return true;
    if (Date.now() >= deadline) return false;
    await pause(SWITCH_TIMING.blockGapMs);
  }
}

/** Runs one of the take-over pg_hba scripts as root in the copy, then reloads the configuration. */
async function hbaScript(t: Target, script: string): Promise<string | null> {
  const run = await runGuarded('docker', ['exec', '-u', 'root', t.container, 'sh', '-c', script], { timeoutMs: SWITCH_TIMING.readMs });
  if (!run.ok) return failText(run);
  const reload = await adminSql(t, 'postgres', 'SELECT pg_reload_conf();');
  return reload.ok ? null : failText(reload);
}

/** T-e2 (D35): the bot role refused over TCP on the copy, proven, and its sessions ended; null when in force. */
async function blockBotOnCopy(t: Target, db: string): Promise<string | null> {
  if (!TAKEOVER_ROLE_RE.test(t.user)) return `the bot's role name ${t.user} is not a plain identifier`;
  const file = await adminSql(t, 'postgres', "SELECT current_setting('hba_file');");
  if (!file.ok) return failText(file);
  const hbaFile = lastLine(file.stdout);
  if (hbaFile !== fleetBackup.FENCE_HBA_FILE) return `the database reads its pg_hba from ${hbaFile || 'an unnamed file'}, not ${fleetBackup.FENCE_HBA_FILE}`;
  const written = await hbaScript(t, takeoverBlockScript(t.user));
  if (written) return written;
  if (!await hbaProof(t, db, true)) return `a login over TCP was still admitted after ${Math.round(SWITCH_TIMING.blockProbeMs / 1000)} seconds`;
  const login = await dbLogin.readBotLogin(t);
  if (!login.ok) return login.error;
  if (login.login.canLogin === true) {
    // A login that began before the reload can still finish within authentication_timeout.
    const timeout = await adminSql(t, 'postgres', "SELECT setting FROM pg_settings WHERE name = 'authentication_timeout';");
    const seconds = timeout.ok ? Number(lastLine(timeout.stdout)) : NaN;
    if (!Number.isFinite(seconds)) return `authentication_timeout could not be read (${timeout.ok ? lastLine(timeout.stdout) : failText(timeout)})`;
    await pause(seconds * 1000);
  }
  const ended = await dbLogin.endBotSessions(t, 1000);
  if (ended.ok) return null;
  return 'left' in ended && typeof ended.left === 'number' ? `${ended.left} session(s) of the bot's role did not end` : ended.error;
}

/** T-g2 and T43: the take-over line removed, reloaded, and proven gone; null when done. */
async function liftBotBlock(t: Target, db: string): Promise<string | null> {
  const removed = await hbaScript(t, takeoverLiftScript());
  if (removed) return removed;
  return await hbaProof(t, db, false) ? null : `pg_hba still rejected the bot's login after ${Math.round(SWITCH_TIMING.blockProbeMs / 1000)} seconds`;
}

/** The generation row; null when absent. */
export async function readGeneration(t: Target, db: string): Promise<{ ok: true; row: GenRow | null } | { ok: false; error: string }> {
  const r = await adminSql(t, db, GEN_READ_SQL);
  if (!r.ok) return missingTable(r.stderr) ? { ok: true, row: null } : { ok: false, error: failText(r) };
  const row = parseGenRow(r.stdout);
  return row === undefined ? { ok: false, error: `the generation read answered '${lastLine(r.stdout)}'` } : { ok: true, row };
}

/** The restore record in the cluster's postgres database; null when absent. */
export async function readRestoreState(t: Target): Promise<{ ok: true; state: RestoreState | null } | { ok: false; error: string }> {
  const r = await adminSql(t, 'postgres', RESTORE_STATE_READ);
  if (!r.ok) return missingTable(r.stderr) ? { ok: true, state: null } : { ok: false, error: failText(r) };
  const state = parseRestoreState(r.stdout);
  return state === undefined ? { ok: false, error: `the restore record answered '${lastLine(r.stdout)}'` } : { ok: true, state };
}

/** The higher of the generation row and the restore record's floor. */
export async function ownGeneration(t: Target, db: string): Promise<{ ok: true; row: GenRow | null; restore: RestoreState | null } | { ok: false; error: string }> {
  const live = await readGeneration(t, db);
  if (!live.ok) return live;
  const rs = await readRestoreState(t);
  if (!rs.ok) return rs;
  return { ok: true, row: generationBefore(live.row, rs.state?.floor ?? null), restore: rs.state };
}

const ensureLogged = new Map<string, string>();

/** N-a: the generation row on a main that has none; skipped while a restore notice stands, never fence-exempt. */
export async function ensureMainGeneration(botId: string): Promise<void> {
  const inst = containerManager.getBot(botId);
  const db = inst?.fleetDb;
  if (!inst || !db || db.retiringAt) return;
  // D42: a receiving main writes nothing of its own into the database a push replaces.
  if (db.receive || db.pushBroken) return;
  if (fleetBackup.shownRestoreNoticeFile(botId)) return;
  const t = { container: db.containerName, user: db.user };
  const read = await readGeneration(t, db.db);
  if (read.ok && read.row) return;
  const r = await adminSql(t, db.db, ensureGenerationSql(machineNameOf(inst)));
  const error = r.ok ? '' : failText(r);
  if (ensureLogged.get(botId) !== error) {
    ensureLogged.set(botId, error);
    if (error) console.warn(`[Switch] ${inst.displayName}: the generation row could not be written (${error}); the manager tries again every minute`);
  }
}

// ─── Pure verdicts ───

export type Noun = 'hand-over' | 'push' | 'move';

export type HeldVerdict = { go: true } | { ask: string } | { refuse: string };

/** Contract 1's answer, as a planned move reads it. */
export function heldVerdict(held: MaintenanceHeld | undefined, confirm: boolean, noun: Noun = 'hand-over', reason = 'it did not answer'): HeldVerdict {
  const refused = `the ${noun} was refused and nothing was changed`;
  if (!held) {
    return { refuse: `The bot did not answer the maintenance order (${reason}), so the manager can't confirm it saved the changes it holds; ${refused}. Choose Maintenance again while the bot runs, or choose Off.` };
  }
  if (held.state === 'yes' || held.state === 'not-running') return { go: true };
  if (held.state === 'stopped') {
    if (confirm) return { go: true };
    const q = noun === 'hand-over' ? 'Hand over anyway?' : noun === 'push' ? 'Push anyway?' : 'Make the backup anyway?';
    return { ask: `The bot was stopped without confirming that it saved what it held. Whatever it had not saved was lost at that stop, not by this ${noun}, which loses nothing more. ${q}` };
  }
  if (held.state === 'no') {
    return { refuse: `The bot reports changes it could not save (${held.guilds} guild(s), ${held.files} file(s)), so ${refused}: a ${noun} now would leave them behind. Choose Maintenance again so the bot tries the save again; the bot's log names what it could not save.` };
  }
  return { refuse: `The bot could not confirm that it saved every change it holds, so ${refused}. Choose Maintenance again; the bot answers whether its changes are saved.` };
}

export type OldMain = 'writable' | 'in-recovery' | 'fenced' | 'unreachable' | 'login-refused' | 'other-system' | 'no-code';

export interface ModeInput {
  inRecovery: boolean;
  handover: { slot: string; generation: number; machine: string } | null;
  gen: number | null;
  intent: { generation: number; planned: boolean; inherit?: { file: string; at: string } } | null;
  oldMain: OldMain;
  slot: string;
  restore: { pending: boolean; file: string; at: string } | null;
  confirm: boolean;
}

export type ModeVerdict =
  | { mode: 'resume' | 'planned' | 'unplanned' | 'promoted'; target: number; inherit?: { file: string; at: string }; ask?: 'W-UNPLANNED' | 'W-PROMOTED' }
  | { refusal: 'TK-MAINUP' | 'TK-MAINFENCED' | 'TK-MAINCOPY' | 'TK-OTHER' | 'TK-MAINUP-P' | 'TK-MAINFENCED-P' };

export function takeoverMode(p: ModeInput): ModeVerdict {
  const next = (p.gen ?? 0) + 1;
  const inherit = p.restore?.pending ? { file: p.restore.file, at: p.restore.at } : undefined;
  if (!p.inRecovery) {
    if (p.intent) return { mode: 'resume', target: p.intent.generation, ...(p.intent.inherit ? { inherit: p.intent.inherit } : {}) };
    if (p.oldMain === 'writable') return { refusal: 'TK-MAINUP-P' };
    if (p.oldMain === 'fenced') return { refusal: 'TK-MAINFENCED-P' };
    if (p.oldMain === 'in-recovery') return { refusal: 'TK-MAINCOPY' };
    return { mode: 'promoted', target: next, ...(inherit ? { inherit } : {}), ...(p.confirm ? {} : { ask: 'W-PROMOTED' as const }) };
  }
  if (p.oldMain === 'writable') return { refusal: 'TK-MAINUP' };
  if (p.oldMain === 'fenced') return { refusal: 'TK-MAINFENCED' };
  if (p.oldMain === 'in-recovery') return { refusal: 'TK-MAINCOPY' };
  if (p.handover && p.handover.slot === p.slot && p.handover.generation === next) return { mode: 'planned', target: p.handover.generation };
  if (p.handover && p.handover.slot !== p.slot) return { refusal: 'TK-OTHER' };
  return { mode: 'unplanned', target: next, ...(inherit ? { inherit } : {}), ...(p.confirm ? {} : { ask: 'W-UNPLANNED' as const }) };
}

export type PeerVerdict = 'none' | 'replaced' | 'tie' | 'unknown';

export function peerVerdict(own: number, peer: fleetJoin.PeerProbe | null, systemId: string | null): PeerVerdict {
  if (!peer || (peer.kind !== 'writable' && peer.kind !== 'in-recovery')) return 'unknown';
  if (peer.kind === 'in-recovery' || (systemId !== null && peer.systemId !== systemId)) return 'none';
  const g = peer.gen?.generation ?? 0;
  return g > own ? 'replaced' : g === own ? 'tie' : 'none';
}

export type FormerVerdict = 'replaced' | 'tie' | 'lower' | 'gone' | 'unknown';

/** N-d's read of the main this database took over from (D45): `lower` is the reach, `gone` clears the record. */
export function formerVerdict(own: number, peer: fleetJoin.PeerProbe | null, systemId: string | null): FormerVerdict {
  if (!peer || (peer.kind !== 'writable' && peer.kind !== 'in-recovery')) return 'unknown';
  if (peer.kind === 'in-recovery' || (systemId !== null && peer.systemId !== systemId)) return 'gone';
  const g = peer.gen?.generation ?? 0;
  return g > own ? 'replaced' : g === own ? 'tie' : 'lower';
}

export function noticeDue(row: GenRow | null, record: FleetDbSwitchNotice | undefined, now: number, appRunning: boolean): boolean {
  if (!row || row.generation < 2 || !appRunning) return false;
  if (!record || record.generation < row.generation) return true;
  if (record.generation > row.generation) return false;
  return (record.state === 'pending' || record.state === 'unknown' || record.state === 'refused') && now - (record.triedAt ?? 0) >= DM_RETRY_MS;
}

/** Contract 5's answer as the record keeps it (D30). */
export function noticeState(r: { ok: boolean; status?: number; unknown?: boolean; error?: string; body?: unknown }): Pick<FleetDbSwitchNotice, 'state' | 'note' | 'channel' | 'error'> {
  const body = (r.body ?? {}) as { posted?: unknown; note?: unknown; channel?: unknown };
  const note = typeof body.note === 'string' && body.note ? { note: body.note } : {};
  if (r.ok && body.posted === false) return { state: 'already', ...note };
  if (r.ok) return { state: 'sent', ...note, ...(typeof body.channel === 'string' ? { channel: body.channel } : {}) };
  if (r.status === 404) return { state: 'unsupported' };
  if (r.status === 409) return { state: 'refused', error: r.error || 'no reason given' };
  if (r.unknown) return { state: 'unknown', error: r.error || 'no reason given' };
  return { state: 'pending', error: r.error || 'no reason given' };
}

export type ReplacedPlan = 'none' | 'maintenance' | 'off' | 'wait';

/** N-g's step for a replaced main's bot (D36): Off only once it holds nothing it could not save. */
export function replacedPlan(rec: MaintenanceRecord, off: FleetDbReplaced['off'] | undefined, now: number): ReplacedPlan {
  if (rec.state === 'off' && rec.settled) return 'none';
  if (rec.state === 'running' || !rec.settled) return 'maintenance';
  const held = rec.held?.state;
  if (held === 'yes' || held === 'not-running' || rec.hook === 'missing' || rec.hook === 'none') return 'off';
  return off?.askedAt === undefined || now - off.askedAt >= SWITCH_TIMING.peerEveryMs ? 'maintenance' : 'wait';
}

/** Whether an owner message is sent (again) now (D37): never after a posted, repeated or unsupported answer. */
export function dmDue(dm: OwnerDm | undefined, now: number): boolean {
  if (!dm) return true;
  return (dm.state === 'failed' || dm.state === 'unknown') && now - dm.triedAt >= DM_RETRY_MS;
}

export function rejoinDue(mark: FleetDbHandover | undefined, probe: fleetJoin.PeerProbe | null, now: number, systemId: string | null): boolean {
  if (!mark || mark.mode !== 'stream' || mark.phase !== 'stopped' || !mark.host || !mark.port || !mark.cert) return false;
  if (!probe || probe.kind !== 'writable' || (probe.gen?.generation ?? 0) < (mark.generation ?? Infinity)) return false;
  if (systemId !== null && probe.systemId !== systemId) return false;
  if (probe.receiveMark !== false) return false;
  return !mark.rejoinTriedAt || now - mark.rejoinTriedAt >= SWITCH_TIMING.rejoinRetryMs;
}

/** A join code for another database of this bot, from its registered address and this machine's own logins. */
export function composeJoinCode(instance: InstanceConfig, target: { host: string; port: number; cert: string; machine: string }): { ok: true; text: string; code: JoinCode } | { ok: false; error: string } {
  const db = instance.fleetDb;
  const repl = db?.replication;
  if (!db || !repl || !repl.password) return { ok: false, error: "this machine's replication login is not stored" };
  const password = storedDbPassword(instance);
  if (!password) return { ok: false, error: "the bot's database password could not be read from the stored database URL" };
  let fp: string;
  try { fp = certFingerprint(target.cert); } catch { return { ok: false, error: 'the registered certificate does not read' }; }
  const code: JoinCode = { v: 1, host: target.host, port: target.port, db: db.db, fp, machine: machineText(target.machine), repl: { user: repl.role, password: repl.password }, app: { user: db.user, password } };
  return { ok: true, text: encodeJoinCode(code), code };
}

/** Whether a recorded certificate is the one a join code names (D56); one that does not read is not. */
function sameCert(pem: string, fp: string): boolean {
  try { return certFingerprint(pem).toLowerCase() === fp.toLowerCase(); } catch { return false; }
}

/**
 * The code to reach another database of this bot: the old main's own code when the target is formerMain and has no
 * recorded certificate or the one that code names (J14); else composed from the recorded certificate (D56).
 */
export function peerCode(instance: InstanceConfig, target: { host: string; port: number; cert: string; machine: string }): { ok: true; text: string; code: JoinCode } | { ok: false; error: string } {
  const fm = instance.fleetDb?.formerMain;
  if (fm && fm.host === target.host && fm.port === target.port) {
    const d = decodeJoinCode(fm.code);
    if (d.ok && (!target.cert || sameCert(target.cert, d.code.fp))) return { ok: true, text: fm.code, code: d.code };
  }
  return composeJoinCode(instance, target);
}

// ─── Lane plumbing ───

export type LaneOutcome = {
  success: boolean; text: string; status?: number; needsConfirm?: boolean; confirmFlag?: 'confirmUnchecked'; moveCode?: string; file?: string;
  /** The steps that run once the op lock is released (a Running order, a rejoin): their outcome replaces this one. */
  after?: () => Promise<LaneOutcome>;
};

const settle = async (r: LaneOutcome): Promise<LaneOutcome> => (r.after ? r.after() : r);

const refusal = (text: string, status = 409): LaneOutcome => ({ success: false, text, status });
const busyText = (op: string) => `Operation '${op}' is running on this bot; wait for it to finish${NOTHING}`;
const SLOT_BUSY = `A backup or restore operation is in progress on this database; wait for it to finish${NOTHING}`;

/**
 * Runs one lane under the bot's op lock. admit() marks the point after which the route has answered "accepted": an
 * outcome before it is the route's answer; after it, onDone gets the outcome.
 */
export async function startLane(botId: string, op: string, fn: (admit: () => void) => Promise<LaneOutcome>, onDone: (r: LaneOutcome) => void): Promise<{ accepted: true } | LaneOutcome> {
  if (containerManager.isShuttingDown()) return refusal(containerManager.SHUTDOWN_REFUSAL, 503);
  const busy = containerManager.isBotBusy(botId);
  if (busy) return refusal(busyText(busy));
  const migrating = containerManager.migrateRefusal(botId, 'db') ?? containerManager.migrationHoldRefusal(botId);
  if (migrating) return refusal(migrating.error);
  let admitted = false;
  let answer!: (r: { accepted: true } | LaneOutcome) => void;
  const answered = new Promise<{ accepted: true } | LaneOutcome>(resolve => { answer = resolve; });
  containerManager.withExternalBotOp(botId, op, () => fn(() => { if (!admitted) { admitted = true; answer({ accepted: true }); } }))
    .then(settle)
    .then(r => (admitted ? onDone(r) : answer(r)))
    .catch(err => {
      const r = { success: false, text: `The ${op} stopped on an unexpected error: ${errText(err)}`, status: 500 };
      if (admitted) onDone(r); else answer(r);
    });
  return answered;
}

/** Runs a lane without a route (tests and the tick): the outcome at its end. */
export async function runLane(botId: string, op: string, fn: (admit: () => void) => Promise<LaneOutcome>): Promise<LaneOutcome> {
  if (containerManager.isShuttingDown()) return refusal(containerManager.SHUTDOWN_REFUSAL, 503);
  const busy = containerManager.isBotBusy(botId);
  if (busy) return refusal(busyText(busy));
  const migrating = containerManager.migrateRefusal(botId, 'db') ?? containerManager.migrationHoldRefusal(botId);
  if (migrating) return refusal(migrating.error);
  try {
    return await settle(await containerManager.withExternalBotOp(botId, op, () => fn(() => undefined)));
  } catch (err) {
    return { success: false, text: `The ${op} stopped on an unexpected error: ${errText(err)}`, status: 500 };
  }
}

const ucFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * H29 to H31 and their kin: the restore notice (memory or registry) and the read-only layer, read live. `refused` is
 * the clause that names what was refused ("the hand-over was refused").
 */
export function noticeRefusal(botId: string, refused: string): string | null {
  const file = fleetBackup.shownRestoreNoticeFile(botId);
  return file ? `A restore of ${file} has not finished cleanly (its notice is on the Database window), so ${refused} and nothing was changed: the database would move in that state. Restore a dump again, or dismiss the notice, first.` : null;
}

export async function switchAdmissionNotice(botId: string, refused: string, opts: { skipNotice?: boolean } = {}): Promise<string | null> {
  if (!opts.skipNotice) {
    const notice = noticeRefusal(botId, refused);
    if (notice) return notice;
  }
  const db = containerManager.getBot(botId)?.fleetDb;
  if (!db) return null;
  const fence = await dbLogin.readWriteFence({ container: db.containerName, user: db.user });
  if (!fence.ok) return `The manager could not read whether the bot's database is READ-ONLY (${fence.error}), so ${refused} and nothing was changed`;
  if (!fence.on) return null;
  const w = maintenance.fenceWords(fence);
  const remedy = w.remedy ? `; ${w.remedy}` : '';
  return w.owned
    ? `The bot's database is READ-ONLY under ${w.state}, so ${refused} and nothing was changed${remedy}`
    : `The bot's database is READ-ONLY, and ${w.state}. ${ucFirst(refused)} and nothing was changed${remedy}`;
}

/** H-a's checks shared by the lanes that start from a main; null admits. */
export function mainAdmission(inst: InstanceConfig, need: { replication: boolean; noun: string; resume?: (h: FleetDbHandover) => boolean; allowPushBroken?: boolean }): string | null {
  const db = inst.fleetDb;
  if (!db || db.retiringAt) return `This instance holds no main database, so there is nothing to ${need.noun}${NOTHING}`;
  if (need.replication && !db.replication) return `Replication is not enabled on this database, so no copy follows it; enable it and add a live copy first${NOTHING}`;
  if (inst.fleetDbReplica) return `This instance also holds a live copy; remove it before handing over the main${NOTHING}`;
  if (inst.fleetDbReplicaSeed) return `A live copy seed is recorded on this instance; wait for it or dismiss it first${NOTHING}`;
  if (db.receive) return `This database is waiting to receive a main from another machine; Stop receiving first${NOTHING}`;
  if (db.replacedBy) return `Another database replaced this one as the main; rejoin this machine as a copy instead${NOTHING}`;
  if (db.mainConflict) return `Two databases accept writes as the main; choose one first${NOTHING}`;
  if (db.pushBroken && !need.allowPushBroken) return `A push into this database did not finish; restore the dump ${db.pushBroken.safetyDump} or receive a push again first${NOTHING}`;
  if (db.handover && !need.resume?.(db.handover)) {
    if (db.handover.mode === 'stream' && db.handover.phase === 'waiting') {
      return `A hand-over to ${db.handover.machine || 'another machine'} is recorded; press Hand over with that copy, or Cancel the hand-over${NOTHING}`;
    }
    return `A move of this database is already recorded (${moveModeText(db.handover)}); finish it or Cancel it first${NOTHING}`;
  }
  const fault = containerManager.registryFault();
  if (fault) return fault;
  return null;
}

/** What the maintenance record says about why the bot gave no held answer. */
function noAnswerReason(inst: InstanceConfig): string {
  const rec = maintenance.maintenanceOf(inst);
  if (rec.hook === 'missing') return 'its build has no maintenance hook';
  if (rec.hook === 'none') return 'this app declares no maintenance hook';
  return rec.lastError || 'it did not answer';
}

/** H-c: maintenance proven, the held answer, then the read-only layer. */
export async function provenMaintenance(botId: string, noun: Noun, confirm: boolean): Promise<LaneOutcome | null> {
  const proof = await maintenance.requireMaintenance(botId, 'database');
  if (!proof.ok) return refusal(`The ${noun} was refused and nothing was changed: ${proof.error}`);
  const inst = containerManager.getBot(botId)!;
  const held = heldVerdict(proof.held, confirm, noun, noAnswerReason(inst));
  if ('refuse' in held) return refusal(held.refuse);
  if ('ask' in held) return { success: false, text: held.ask, needsConfirm: true, status: 409 };
  const fence = await switchAdmissionNotice(botId, `the ${noun} was refused`, { skipNotice: true });
  return fence ? refusal(fence) : null;
}

function saveSwitch(botId: string, patch: Parameters<typeof containerManager.updateInstanceFleetDbSwitch>[1]): string | null {
  try {
    containerManager.updateInstanceFleetDbSwitch(botId, patch);
    return null;
  } catch (err) {
    return errText(err);
  }
}

const NOTREC_TAIL = (e: string) => ` The manager could not record this (${e}); press the same button again to finish recording it.`;

// ─── O1 Hand over ───

const SLOT_READ = (slot: string) => `SELECT coalesce((SELECT s.active::text || '|' || coalesce(r.state, '') || '|' || coalesce(r.replay_lsn::text, '')
  FROM pg_replication_slots s LEFT JOIN pg_stat_replication r ON r.pid = s.active_pid WHERE s.slot_name = ${sqlLiteral(slot)}), 'absent');`;
const ADDRESS_OF_SLOT = (slot: string) => `SELECT coalesce((SELECT 'addr|' || host || '|' || port || '|' || machine || '|' || replace(cert, E'\\n', '~')
  FROM smdb_manager.addresses WHERE slot = ${sqlLiteral(slot)}), 'addr|');`;

type SlotFacts = { active: boolean; state: string; replay: bigint | null };

function parseSlot(line: string): SlotFacts | 'absent' | null {
  if (line === 'absent') return 'absent';
  const [active, state, replay] = line.split('|');
  if (active !== 'true' && active !== 'false') return null;
  return { active: active === 'true', state: state || '', replay: lsnToBigInt(replay) };
}

const DELETE_ROW_SQL = 'DELETE FROM smdb_manager.handover;\nSELECT pg_current_wal_lsn();';

type ReplayProof = { seen: true } | { seen: false; behind: string; state: string };

/** Whether the copy on this slot replayed past lsn (D43): read every pollMs, at most catchUpMs. */
async function replayProof(t: Target, db: string, slot: string | undefined, lsn: bigint): Promise<ReplayProof> {
  const deadline = Date.now() + SWITCH_TIMING.catchUpMs;
  let last: SlotFacts | null = null;
  for (;;) {
    if (slot && SLOT_RE.test(slot)) {
      const s = await adminSql(t, db, SLOT_READ(slot));
      const facts = s.ok ? parseSlot(lastLine(s.stdout)) : null;
      if (facts && facts !== 'absent') {
        last = facts;
        if (facts.replay !== null && facts.replay >= lsn) return { seen: true };
      }
    }
    if (Date.now() >= deadline) {
      return {
        seen: false,
        behind: last?.replay != null ? (lsn - last.replay).toString() : 'an unknown number of',
        state: last ? (last.active ? last.state || 'no state' : 'not connected') : 'not read',
      };
    }
    await pause(SWITCH_TIMING.pollMs);
  }
}

/** The hand-over row's delete and its WAL position; lsn null when the table is missing (nothing to replay). */
async function deleteHandoverRow(t: Target, db: string): Promise<{ ok: true; lsn: bigint | null } | { ok: false; error: string }> {
  const del = await adminSql(t, db, DELETE_ROW_SQL);
  if (!del.ok) return missingTable(del.stderr) ? { ok: true, lsn: null } : { ok: false, error: failText(del) };
  const lsn = lsnToBigInt(lastLine(del.stdout));
  return lsn === null ? { ok: false, error: `the delete answered '${lastLine(del.stdout)}'` } : { ok: true, lsn };
}

function parseAddress(line: string): { host: string; port: number; machine: string; cert: string } | null {
  const parts = line.split('|');
  if (parts[0] !== 'addr' || parts.length < 5) return null;
  const port = Number(parts[2]);
  if (!parts[1] || !Number.isInteger(port)) return null;
  return { host: parts[1], port, machine: parts[3], cert: parts.slice(4).join('|').replace(/~/g, '\n') };
}

export async function handOverMain(botId: string, slot: string, confirm: boolean, admit: () => void = () => undefined): Promise<LaneOutcome> {
  const inst = containerManager.getBot(botId);
  if (!inst) return refusal('Bot not found', 404);
  if (!SLOT_RE.test(slot)) return refusal(`No copy uses the slot ${slot} any more; reload the Database window and pick a copy that is streaming`);
  const resumeOf = (h: FleetDbHandover) => h.mode === 'stream' && h.phase === 'waiting' && h.slot === slot;
  const admission = mainAdmission(inst, { replication: true, noun: 'hand over', resume: resumeOf });
  if (admission) return refusal(admission);
  const notice = noticeRefusal(botId, 'the hand-over was refused');
  if (notice) return refusal(notice);
  if (!claimFleetBackupBusy(botId)) return refusal(containerManager.isShuttingDown() ? containerManager.SHUTDOWN_REFUSAL : SLOT_BUSY, containerManager.isShuttingDown() ? 503 : 409);
  try {
    return await handOverLocked(botId, slot, confirm, admit);
  } finally {
    releaseFleetBackupBusy(botId);
  }
}

async function handOverLocked(botId: string, slot: string, confirm: boolean, admit: () => void): Promise<LaneOutcome> {
  const inst = containerManager.getBot(botId)!;
  const db = inst.fleetDb!;
  const t = { container: db.containerName, user: db.user };
  const resuming = !!db.handover;
  if (resuming && await dbLogin.sidecarRunning(db.containerName) !== true) {
    const up = await containerManager.startFleetDbSidecar(botId, { handedOver: true });
    if (!up.success) return refusal(`The hand-over was refused and nothing was changed: the database did not start (${up.error})`);
  }
  const proven = await provenMaintenance(botId, 'hand-over', confirm);
  if (proven) return proven;

  const read = await adminSql(t, db.db, `${SLOT_READ(slot)}\n${ADDRESS_OF_SLOT(slot)}`);
  if (!read.ok && !missingTable(read.stderr)) return refusal(`The manager could not read this database's copies (${failText(read)})${NOTHING}`);
  const lines = read.stdout.trim().split('\n').map(l => l.trim()).filter(Boolean);
  const slotFacts = parseSlot(lines[0] ?? '');
  if (slotFacts === null) return refusal(`The manager could not read this database's copies (the slot read answered '${lines[0] ?? ''}')${NOTHING}`);
  if (slotFacts === 'absent') return refusal(`No copy uses the slot ${slot} any more; reload the Database window and pick a copy that is streaming${NOTHING}`);
  const address = read.ok ? parseAddress(lines[1] ?? '') : null;
  const machine = address ? machineText(address.machine) : slot;
  if (!slotFacts.active || slotFacts.state !== 'streaming') {
    return refusal(`The copy ${machine} is not streaming from this database now (${slotFacts.active ? slotFacts.state || 'no state' : 'not connected'}), so it cannot prove it holds every change; start it on its machine and try again${NOTHING}`);
  }
  await ensureMainGeneration(botId);
  const own = await ownGeneration(t, db.db);
  if (!own.ok) return refusal(`The manager could not read this database's copies (${own.error})${NOTHING}`);
  const target = (own.row?.generation ?? 0) + 1;
  // D66: H-a refused receive and pushBroken, so a row standing now is left over; H-g's proof covers its removal.
  const left = await removeStaleMark(t, () => true);
  if (!left.ok) return refusal(`A receive mark that no receive or unfinished push on this machine stands for could not be removed (${left.error}), and ${machine} would refuse to take over while it stands, so the hand-over was refused; nothing was changed`);
  if (left.removed) {
    staleMarkLogged.delete(botId);
    staleMarkRemoved(inst.displayName);
  }

  const mark: FleetDbHandover = {
    mode: 'stream', slot, machine, ...(address ? { host: address.host, port: address.port, cert: address.cert } : {}),
    generation: target, phase: 'waiting', at: new Date().toISOString(),
  };
  const noRec = saveSwitch(botId, { handover: mark });
  if (noRec) return refusal(left.removed
    ? `The hand-over could not be recorded (${noRec}); a left-over receive mark was removed before it, and nothing else was changed`
    : `The hand-over could not be recorded (${noRec}), so nothing was changed`);
  admit();

  // H32, H33: the main returns to service only once the copy replayed the row's delete.
  const undo = async (text: string, cause: string, login?: string): Promise<LaneOutcome> => {
    const del = await deleteHandoverRow(t, db.db);
    const proof: ReplayProof = del.ok && del.lsn !== null ? await replayProof(t, db.db, slot, del.lsn) : { seen: true };
    if (del.ok && !proof.seen && login) {
      return refusal(`${cause}; the hand-over row was deleted here, but the copy ${machine} has not confirmed that it dropped it (${proof.behind} bytes behind, ${proof.state}), so the hand-over stays recorded and this database must not return to service: ${machine} could take it over as if every change were there. ${login} Press Hand over again once the copy streams, or Cancel the hand-over.`);
    }
    if (del.ok && !proof.seen) {
      return refusal(`${cause}; the hand-over row was deleted here, but the copy ${machine} has not confirmed that it dropped it (${proof.behind} bytes behind, ${proof.state}), so the hand-over stays recorded and the bot's login stays blocked: back in service, this database could be taken over by ${machine} as if every change were there. Press Hand over again once the copy streams, or Cancel the hand-over.`);
    }
    const failed = del.ok ? saveSwitch(botId, { handover: null }) : del.error;
    return refusal(failed ? `${text} Undoing it failed too (${failed}), so the hand-over stays recorded: press Hand over again, or Cancel the hand-over.` : text);
  };

  const row = await adminSql(t, db.db, `BEGIN;
${GENERATION_SCHEMA_SQL}
DELETE FROM smdb_manager.handover;
INSERT INTO smdb_manager.handover (slot, machine, generation) VALUES (${sqlLiteral(slot)}, ${sqlLiteral(machine)}, ${target});
${COPIES_SYNC_SQL}
COMMIT;
SELECT pg_current_wal_lsn();`);
  const L = row.ok ? lsnToBigInt(lastLine(row.stdout)) : null;
  if (!row.ok || L === null) {
    const error = row.ok ? `it answered '${lastLine(row.stdout)}'` : failText(row);
    return undo(`The hand-over row could not be written (${error}); the hand-over was undone and nothing else was changed`, `The hand-over row could not be written (${error})`);
  }

  const deadline = Date.now() + SWITCH_TIMING.catchUpMs;
  let last: SlotFacts | null = null;
  for (;;) {
    const login = await dbLogin.readBotLogin(t);
    const AGAIN = 'so it was undone. Choose Maintenance again, then hand over.';
    if (!login.ok || login.login.canLogin === null) {
      const cause = `The manager could not read the bot's database login during the hand-over (${login.ok ? "the bot's role was not found" : login.error})`;
      return undo(`${cause}, ${AGAIN}`, cause, "The manager can't confirm whether the bot's login is blocked now.");
    }
    if (login.login.canLogin) {
      const cause = "The bot's database login read open during the hand-over";
      return undo(`${cause}, ${AGAIN}`, cause, "This lane did not block the login again; the manager's maintenance check blocks it at its next pass (every 30 seconds), since the bot's state is Maintenance or Off and cannot change while the hand-over is recorded.");
    }
    if (login.login.sessions > 0) {
      const cause = `${login.login.sessions} session(s) of the bot's database role appeared during the hand-over`;
      return undo(`${cause}, ${AGAIN}`, cause, 'The login itself read blocked; this lane did not end those sessions.');
    }
    const s = await adminSql(t, db.db, SLOT_READ(slot));
    const facts = s.ok ? parseSlot(lastLine(s.stdout)) : null;
    if (facts && facts !== 'absent') {
      last = facts;
      if (facts.replay !== null && facts.replay >= L) break;
    }
    if (Date.now() >= deadline) {
      const behind = last?.replay != null ? (L - last.replay).toString() : 'an unknown number of';
      const state = last ? (last.active ? last.state || 'no state' : 'not connected') : 'not read';
      const within = `The copy ${machine} did not reach this database's position within ${Math.round(SWITCH_TIMING.catchUpMs / 1000)} seconds`;
      return undo(`${within} (${behind} bytes behind, ${state}); the hand-over was undone, and the database and the bot are as they were. Check the copy's link and try again.`, within);
    }
    await pause(SWITCH_TIMING.pollMs);
  }

  const app = await containerManager.appContainerRunning(botId);
  let stopError: string | null = null;
  if (app === true) {
    const r = await containerManager.stopBotInOp(botId, 'handover');
    if (!r.success && r.error !== 'Bot is not running') stopError = r.error || 'no reason given';
  }
  if (!stopError && await dbLogin.sidecarRunning(db.containerName) !== false) {
    const r = await containerManager.stopFleetDbSidecar(botId);
    if (!r.success) stopError = r.error || 'no reason given';
  }
  if (!stopError) {
    const down = await dbLogin.sidecarRunning(db.containerName);
    if (down !== false) stopError = down === true ? 'it still runs after the stop' : 'docker did not say whether it still runs';
  }
  if (stopError) {
    return refusal(`The copy holds every change, but this database did not stop (${stopError}), so the hand-over is not finished. Press Hand over again to retry the stop, or Cancel the hand-over.`);
  }
  const phaseError = saveSwitch(botId, { handover: { ...mark, phase: 'stopped' } });
  let text = `The main database on this machine is stopped, and the live copy on ${machine} holds every change it had. Open ${machine}'s manager and press Take over in the bot's Database window. This machine rejoins as a copy of ${machine} by itself once ${machine} is the main; until then its database stays stopped, unless you Cancel the hand-over.`;
  if (!address) text += ` The copy on ${machine} has no address for other machines, so after it takes over it is the main only while it runs alone, and this machine cannot rejoin it as a copy; move back later with Push from that machine.`;
  if (phaseError) text += NOTREC_TAIL(phaseError);
  console.log(`[Switch] ${inst.displayName}: handed the main over to ${machine} (generation ${target} on take-over)${resuming ? ', resumed' : ''}`);
  return { success: true, text };
}

// ─── O2 Cancel ───

export async function cancelMove(botId: string, confirm: boolean): Promise<LaneOutcome> {
  const inst = containerManager.getBot(botId);
  if (!inst) return refusal('Bot not found', 404);
  const h = inst.fleetDb?.handover;
  if (!h) return refusal('No hand-over or move is recorded on this instance');
  const machine = h.machine || 'another machine';
  if (h.mode === 'push') {
    if (h.phase === 'done') return refusal(`The push finished: ${machine} is the main. Rejoin this machine as a copy instead.`);
    if (!confirm) return { success: false, needsConfirm: true, status: 409, text: `The push to ${machine} did not finish here. Cancel only if ${machine}'s manager does not show the database as received: cancelling keeps this machine's database as the main. Cancel the push?` };
    const e = saveSwitch(botId, { handover: null });
    if (e) return refusal(`The push could not be cancelled: ${e}; try again.`, 500);
    return { success: true, text: `The push is cancelled; this database was never changed by it. Choose Running in the State window to start the bot here, and Stop receiving on ${machine}.` };
  }
  if (h.mode === 'file') {
    if (!confirm) return { success: false, needsConfirm: true, status: 409, text: `Cancel the move only if the backup ${h.file || ''} was not restored on another machine: if it was, two machines would each run the bot as the main. Cancel the move?` };
    const e = saveSwitch(botId, { handover: null });
    if (e) return refusal(`The move could not be cancelled: ${e}; try again.`, 500);
    return { success: true, text: 'The move is cancelled; choose Running in the State window to start the bot here.' };
  }
  const probe = h.host && h.port && h.cert ? await probeTarget(inst, h) : { verdict: null as fleetJoin.PeerProbe | null, reason: 'the copy registered no address' };
  const p = probe.verdict;
  if (p && p.kind === 'writable' && (p.gen?.generation ?? 0) >= (h.generation ?? Infinity)) {
    const when = p.gen?.since ? utcText(Date.parse(p.gen.since)) : 'an unknown time';
    return refusal(`${machine} took over as the main on ${when}, so the hand-over can no longer be cancelled; this machine rejoins it as a copy.`);
  }
  if (!(p && p.kind === 'in-recovery') && !confirm) {
    const reason = !p ? probe.reason : p.kind === 'writable' ? `it answers as a main with generation ${p.gen?.generation ?? 0}` : 'reason' in p ? p.reason : p.kind;
    return { success: false, needsConfirm: true, status: 409, text: `The manager can't confirm whether ${machine} took over (${reason}). Cancel only if ${machine}'s manager shows its copy still following this database. If ${machine} does not receive the cancel, this database gets generation ${h.generation ?? 0}, the one a take-over there writes; if ${machine} took over or takes over later, both databases then hold that generation, and each manager blocks the bot's login on its side once it finds the other, until you choose one. Cancel the hand-over?` };
  }
  const db = inst.fleetDb!;
  const t = { container: db.containerName, user: db.user };
  if (await dbLogin.sidecarRunning(db.containerName) !== true) {
    const up = await containerManager.startFleetDbSidecar(botId, { handedOver: true });
    if (!up.success) return refusal(`The database did not start (${up.error}), so the hand-over is still recorded; try again.`);
  }
  const del = await deleteHandoverRow(t, db.db);
  if (!del.ok) return refusal(`The database runs, but the hand-over row could not be deleted (${del.error}), so the hand-over is still recorded; try again.`);
  const proof: ReplayProof = del.lsn !== null ? await replayProof(t, db.db, h.slot, del.lsn) : { seen: true };
  let raisedTail = '';
  if (!proof.seen) {
    const g = h.generation ?? 0;
    if (!confirm) {
      return { success: false, needsConfirm: true, status: 409, text: `This database runs again and the hand-over row is deleted here, but the copy ${machine} has not received that within ${Math.round(SWITCH_TIMING.catchUpMs / 1000)} seconds (${proof.behind} bytes behind, ${proof.state}), so the hand-over is still recorded and the bot's login stays blocked. If ${machine}'s manager presses Take over before its copy receives the cancel, it takes over as if it held every change. If you cancel anyway, this database gets generation ${g}, the one that take-over would write, so both databases would hold it, and each manager blocks the bot's login on its side once it finds the other, until you choose one. Cancel the hand-over?` };
    }
    // X16: a take-over from the row the copy kept writes this generation, so it ties with this database instead of beating it.
    const recorded = saveSwitch(botId, { switchNotice: { generation: g, machine: machineNameOf(inst), since: null, state: 'not-owed' } });
    if (recorded) console.error(`[Switch] ${inst.displayName}: the manager could not record that this cancel owes no switch notice (${recorded}); the bot may post one for generation ${g}`);
    const raised = await adminSql(t, db.db, raiseSql(machineNameOf(inst), g));
    if (!raised.ok) return refusal(`This database runs and the hand-over row is deleted here, but its generation could not be raised (${failText(raised)}), so the hand-over is still recorded and the bot's login stays blocked; try again.`);
    raisedTail = ` The copy ${machine} had not received the cancel, so this database now holds generation ${g}, the one a take-over there would write: if ${machine} takes over, each manager blocks the bot's login on its side once it finds the other, until you choose one.`;
  }
  const clear = saveSwitch(botId, { handover: null });
  return { success: true, text: `The hand-over is cancelled: this database runs again as the main, with the bot's login still blocked. Choose Running in the State window to start the bot here.${raisedTail}${clear ? NOTREC_TAIL(clear) : ''}` };
}

/** The hand-over target read with a code composed from its registered address. */
async function probeTarget(inst: InstanceConfig, h: { host?: string; port?: number; cert?: string; machine?: string }): Promise<{ verdict: fleetJoin.PeerProbe | null; reason: string; fpError?: string }> {
  const composed = peerCode(inst, { host: h.host!, port: h.port!, cert: h.cert!, machine: h.machine || h.host! });
  if (!composed.ok) return { verdict: null, reason: composed.error };
  const cert = await fleetJoin.mainCertificate(composed.code);
  if (!cert.ok) return { verdict: null, reason: cert.reason, ...(cert.kind === 'fingerprint' ? { fpError: cert.reason } : {}) };
  const pulled = await fleetJoin.ensureClientImage();
  if (pulled) return { verdict: null, reason: pulled };
  const verdict = await fleetJoin.peerProbe(inst, composed.code, cert.pem, 'switch');
  return { verdict, reason: 'reason' in verdict ? verdict.reason : verdict.kind };
}

// ─── O3 Take over ───

const TAKEOVER_FACTS_SQL = `SELECT coalesce(to_char(pg_last_xact_replay_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '') || '|'
  || coalesce(pg_last_wal_receive_lsn()::text, '') || '|' || coalesce(pg_last_wal_replay_lsn()::text, '');`;

function copyAdmission(inst: InstanceConfig): string | null {
  const rec = inst.fleetDbReplica;
  if (!rec) return `This instance holds no live copy to take over with${NOTHING}`;
  if (inst.fleetDb) return `This instance already holds a main database${NOTHING}`;
  if (inst.fleetDbReplicaSeed) return `A seed of this copy is running or stopped; wait for it, or dismiss it first${NOTHING}`;
  if (rec.copyCleared === true) return `This copy was cleared for a re-seed and holds nothing; re-seed it first${NOTHING}`;
  if (typeof rec.seededAt !== 'number') return `This copy has not finished its first seed${NOTHING}`;
  if (!rec.user || !rec.db) return `This copy's record has no database identity; remove it and add it again${NOTHING}`;
  if (envManager.getEnvVarsWithStatus(inst.id).corrupt) {
    return `The env store for this instance cannot be read (a copy is kept beside it as storage.json.corrupt-<time> when it could be read); restore it before taking over${NOTHING}`;
  }
  const fault = containerManager.registryFault();
  if (fault) return fault;
  const cap = capabilityRefusal(inst);
  if (cap) return `${cap}${NOTHING}`;
  return null;
}

const whenText = (iso: string | null | undefined) => (iso && Number.isFinite(Date.parse(iso)) ? utcText(Date.parse(iso)) : 'an unknown time');

export async function takeOver(botId: string, opts: { confirm?: boolean; confirmUnchecked?: boolean; start?: boolean } = {}, admit: () => void = () => undefined): Promise<LaneOutcome> {
  const inst = containerManager.getBot(botId);
  if (!inst) return refusal('Bot not found', 404);
  const admission = copyAdmission(inst);
  if (admission) return refusal(admission);
  if (!claimFleetBackupBusy(botId)) return refusal(containerManager.isShuttingDown() ? containerManager.SHUTDOWN_REFUSAL : SLOT_BUSY, containerManager.isShuttingDown() ? 503 : 409);
  let tail: TakeoverTail | LaneOutcome;
  try {
    tail = await takeOverLocked(botId, opts.confirm === true, opts.confirmUnchecked === true, admit);
  } finally {
    releaseFleetBackupBusy(botId);
  }
  if ('text' in tail) return tail;
  const done = tail;
  return { success: true, text: '', after: () => finishTakeover(botId, done, opts.start !== false) };
}

/** The lanes as one call each, under the op lock (the routes use startLane for the same functions). */
export const handOver = (botId: string, slot: string, confirm = false) => runLane(botId, 'handover', admit => handOverMain(botId, slot, confirm, admit));
export const cancelHandOver = (botId: string, confirm = false) => runLane(botId, 'handover', () => cancelMove(botId, confirm));
export const takeOverMain = (botId: string, opts: { confirm?: boolean; confirmUnchecked?: boolean; start?: boolean } = {}) => runLane(botId, 'takeover', admit => takeOver(botId, opts, admit));
export const keepThisMain = (botId: string) => runLane(botId, 'keep-main', () => keepMain(botId));

const TK_PUSHED = "When this copy last received a change, the main still held the mark of a Receive, and its database had been replaced since that Receive (by a push or a restore) with no record that a push finished, so a take-over could run the bot on data no one checked; nothing was changed. If the main's machine still runs, its Database window says what stands there: let the push finish, or restore the dump it names with the bot in Maintenance or Off. If that window names no unfinished push and no receive, the mark was left over: start that database if it is stopped, and its manager removes the mark within a minute; then hand over from there. If that machine is gone, the machine that pushed keeps its own database until its push finishes or is cancelled: Cancel the push in its manager to keep that database as the main, then remove this copy and join that main. If no machine pushed, keep this copy, which may hold the bot's only database: when the manager cannot check the old main, Take over asks whether to take over anyway.";
const W_UNCHECKED_Q = " The manager could not check the old main (the warning above says why), so it cannot tell whether a push into it finished; you can take over anyway. Do so only if you know that no machine was pushing into the old main, or that the machine that pushed holds no newer database than this copy. If that is wrong, this copy becomes the main with a database a push may have emptied or only partly filled; the machine that pushed keeps its own database and the pre-push- dump it made, and the data is recovered from there by a restore. Take over anyway?";
const W_RECEIVING = " The main was waiting to receive a push from another machine when this copy last received a change, and no push had replaced its database yet, so this copy holds the main's database as it was when Receive was pressed. Receive needs the bot Off, so the bot's later changes, if it made any, are on the machine that was to push: if that machine still runs, keep it as the main (Cancel the push in its manager) instead of taking over here.";

/** W-PROMOTED's or W-UNPLANNED's text without its closing question, W-RESTORE included where a restore had not finished. */
function switchWarning(ask: 'W-PROMOTED' | 'W-UNPLANNED', where: string, reason: string, lastAt: string | null, inherit?: { file: string; at: string }): string {
  const restoreWarn = inherit ? ` The main was restoring the dump ${inherit.file} (started ${whenText(inherit.at)}) and had not finished it when this copy last received a change, so this copy may hold a missing or partial database. If you take over, the Database window here shows a restore notice and the bot is not started.` : '';
  return ask === 'W-PROMOTED'
    ? `This copy no longer follows a main: it was promoted outside the manager. The main at ${where} did not answer (${reason}). Taking over raises this copy's generation so bots use it as the main, and files it as this machine's database; changes the old main took after this copy stopped following it are not here. If you take over, power the old main's machine off in its provider's panel if you can, so it cannot run as a second main.${restoreWarn}`
    : `The main at ${where} did not answer (${reason}). Taking over now makes this copy the main without the main's last changes: the last change this copy received is from ${whenText(lastAt)}. If the main can come back, waiting for it loses nothing; then hand over from its manager. If you take over, power the old main's machine off in its provider's panel if you can, so it cannot run as a second main.${restoreWarn}`;
}

async function takeOverLocked(botId: string, confirm: boolean, confirmUnchecked: boolean, admit: () => void) {
  const inst = containerManager.getBot(botId)!;
  const rec = inst.fleetDbReplica as FleetDbReplicaRecord & { user: string; db: string };
  const t = { container: rec.containerName, user: rec.user };

  const rs = await readRestoreState(t);
  const restore = rs.ok ? rs.state : null;
  const restoreClause = restore?.pending ? `: the main was restoring the dump ${restore.file} (started ${whenText(restore.at)}) when this copy last received a change` : '';
  const exists = await adminSql(t, 'postgres', `SELECT count(*) FROM pg_database WHERE datname = ${sqlLiteral(rec.db)};`);
  if (!exists.ok) return refusal(`The copy's database did not answer (${failText(exists)}); start the instance and try again${NOTHING}`);
  if (lastLine(exists.stdout) === '0') return refusal(`The bot's database is missing on this copy (it replayed the drop of a restore), so there is nothing to take over${restoreClause}${NOTHING}`);
  const facts = await fleetJoin.readCopyFacts(rec);
  if (!facts.ok) return refusal(`The copy's database did not answer (${facts.reason}); start the instance and try again${NOTHING}`);
  if (!rs.ok) return refusal(`The copy's database did not answer (${rs.error}); start the instance and try again${NOTHING}`);
  const inRecovery = facts.facts.inRecovery;
  let lastAt: string | null = null;
  if (inRecovery) {
    const deadline = Date.now() + SWITCH_TIMING.replayWaitMs;
    for (;;) {
      const r = await adminSql(t, rec.db, TAKEOVER_FACTS_SQL);
      const [at, recv, replay] = r.ok ? lastLine(r.stdout).split('|') : ['', '', ''];
      lastAt = at || null;
      const a = lsnToBigInt(recv);
      const b = lsnToBigInt(replay);
      if (r.ok && (a === null || (b !== null && b >= a))) break;
      if (Date.now() >= deadline) return refusal(`The copy received changes it has not applied yet after ${Math.round(SWITCH_TIMING.replayWaitMs / 1000)} seconds; try again in a moment${NOTHING}`);
      await pause(SWITCH_TIMING.pollMs);
    }
  }
  const gen = await readGeneration(t, rec.db);
  if (!gen.ok) return refusal(`The copy's database did not answer (${gen.error}); start the instance and try again${NOTHING}`);
  const copyGen = generationBefore(gen.row, restore?.floor ?? null);
  const code = fleetJoin.storedJoin(inst);
  const intent = rec.takeover ?? null;
  // T43: the intent and the line exist only for a promotion that did not happen.
  const withdraw = async (text: string): Promise<LaneOutcome> => {
    if (!inRecovery || !rec.takeover) return refusal(text);
    const lifted = await liftBotBlock(t, rec.db);
    if (lifted) return refusal(`${text} The unfinished take-over stays recorded, and this copy still refuses the bot's login (${lifted}); press Take over again to retry the withdrawal.`);
    try {
      containerManager.updateInstanceFleetDbReplicaTakeover(botId, null);
    } catch (err) {
      return refusal(`${text} The unfinished take-over stays recorded, and this copy still refuses the bot's login (${errText(err)}); press Take over again to retry the withdrawal.`);
    }
    return refusal(`${text} The unfinished take-over recorded here was withdrawn: this copy was never promoted.`);
  };
  // D63: a push into the main the copy replayed, which the main had not finished checking.
  let markWarn = false;
  let unchecked = false;
  if (inRecovery || !intent) {
    const copyDown = (error: string) => refusal(`The copy's database did not answer (${error}); start the instance and try again${NOTHING}`);
    const read = await adminSql(t, 'postgres', RECEIVE_MARK_READ_SQL);
    if (!read.ok && !missingTable(read.stderr)) return copyDown(failText(read));
    const mark = read.ok ? parseReceiveMark(read.stdout) : null;
    if (mark === undefined) return copyDown(`the receive mark answered '${lastLine(read.stdout)}'`);
    let oidNow = '';
    let received = false;
    if (mark) {
      const oid = await adminSql(t, 'postgres', DB_OID_SQL(rec.db));
      if (!oid.ok) return copyDown(failText(oid));
      oidNow = oid.stdout.trim();
      if (oidNow !== mark.dbOid || mark.dbOid === '') {
        const got = await adminSql(t, rec.db, RECEIVED_OF_SQL(mark.pushIds));
        if (!got.ok && !missingTable(got.stderr)) return copyDown(failText(got));
        received = got.ok && got.stdout.trim() !== '';
      }
    }
    const v = receiveMarkVerdict(mark, oidNow, received);
    unchecked = v === 'unchecked';
    markWarn = v === 'untouched';
  }
  const ho = await adminSql(t, rec.db, HANDOVER_READ_SQL);
  if (!ho.ok && !missingTable(ho.stderr)) return refusal(`The copy's database did not answer (${failText(ho)}); start the instance and try again${NOTHING}`);
  const [hSlot, hGen, hMachine] = ho.ok ? lastLine(ho.stdout).split('|') : [];
  const handover = hSlot && /^\d+$/.test(hGen || '') ? { slot: hSlot, generation: Number(hGen), machine: hMachine || hSlot } : null;

  let oldMain: OldMain = 'no-code';
  let reason = 'the join code stored here cannot be read, so the main was not checked';
  const where = code ? `${code.host}:${code.port}` : `${rec.primaryHost}:${rec.primaryPort}`;
  // T-c: a promoted copy without an intent probes the old main too (D47); a resume does not.
  if (code && (inRecovery || !intent)) {
    const cert = await fleetJoin.mainCertificate(code);
    if (!cert.ok) { oldMain = 'unreachable'; reason = cert.reason; }
    else {
      const pulled = await fleetJoin.ensureClientImage();
      if (pulled) { oldMain = 'unreachable'; reason = pulled; }
      else {
        const p = await fleetJoin.peerProbe(inst, code, cert.pem, 'takeover');
        if (p.kind === 'writable' || p.kind === 'in-recovery') {
          oldMain = p.systemId !== facts.facts.systemId ? 'other-system' : p.kind;
          reason = oldMain === 'other-system' ? `another database answers there (system id ${p.systemId})` : p.kind;
        } else if (p.kind === 'fenced') {
          oldMain = p.systemId !== facts.facts.systemId ? 'other-system' : 'fenced';
          reason = p.reason;
        } else {
          oldMain = p.kind as OldMain;
          reason = 'reason' in p ? p.reason : p.kind;
        }
      }
    }
  }
  const verdict = takeoverMode({ inRecovery, handover, gen: copyGen?.generation ?? null, intent, oldMain, slot: rec.slot, restore, confirm: confirm || confirmUnchecked });
  if ('refusal' in verdict) {
    const text = verdict.refusal === 'TK-MAINUP' ? `The main at ${where} still answers as the main, so this copy was not promoted. Hand it over from its own manager (that loses nothing), or stop it first${NOTHING}`
      : verdict.refusal === 'TK-MAINFENCED' ? `The main at ${where} answers, but refuses every session except replication (${reason}): a lane on its machine, such as a restore, holds a write fence on it. Let that lane finish there, then hand over from its manager${NOTHING}`
      : verdict.refusal === 'TK-MAINCOPY' ? `The database at ${where} now follows another database, so the main moved somewhere else; Join with the current main's code${NOTHING}`
      : verdict.refusal === 'TK-MAINUP-P' ? `The main at ${where} still answers as the main, so this copy, which was promoted outside the manager, was not made the main; nothing was changed. Both databases accept writes now. Stop the old main's bot and database in its manager, then press Take over again; or remove this copy and add it again, which deletes every change made to it since it was promoted.`
      : verdict.refusal === 'TK-MAINFENCED-P' ? `The main at ${where} answers, but refuses every session except replication (${reason}): a lane on its machine, such as a restore, holds a write fence on it. This copy, which was promoted outside the manager, was not made the main; nothing was changed. Let that lane finish, then stop the old main and press Take over again; or remove this copy and add it again.`
      : `The main was handed over to ${handover?.machine ?? 'another machine'}, not to this copy; take over on ${handover?.machine ?? 'that machine'}'s manager${NOTHING}`;
    return withdraw(unchecked ? `${/[.?!]$/.test(text) ? text : `${text}.`} ${TK_PUSHED}` : text);
  }
  if (unchecked && verdict.mode === 'planned') return withdraw(TK_PUSHED);
  if (verdict.ask || (unchecked && !confirmUnchecked)) {
    const body = switchWarning(verdict.mode === 'promoted' ? 'W-PROMOTED' : 'W-UNPLANNED', where, reason, lastAt, verdict.inherit);
    if (unchecked) return { success: false, needsConfirm: true, status: 409, confirmFlag: 'confirmUnchecked' as const, text: `${TK_PUSHED} ${body}${W_UNCHECKED_Q}` };
    return { success: false, needsConfirm: true, status: 409, text: `${body}${markWarn ? W_RECEIVING : ''} Take over now?` };
  }
  if (unchecked) console.warn(`[Switch] ${inst.displayName}: taking over a copy whose main had not finished checking a push that replaced its database; the operator confirmed that no machine was pushing into the old main, or that the machine that pushed holds no newer database`);
  const planned = verdict.mode === 'planned' || (verdict.mode === 'resume' && intent?.planned === true);
  if (verdict.mode !== 'resume') {
    try {
      containerManager.updateInstanceFleetDbReplicaTakeover(botId, { startedAt: new Date().toISOString(), planned, generation: verdict.target, ...(verdict.inherit ? { inherit: verdict.inherit } : {}), ...(unchecked ? { unchecked: true } : {}) });
    } catch (err) {
      return refusal(`The take-over could not be recorded (${errText(err)})${NOTHING}`);
    }
  }
  admit();

  const blocked = await blockBotOnCopy(t, rec.db);
  if (blocked) return refusal(`The copy was not promoted: the bot's login to it could not be blocked first (${blocked}), and a copy promoted with that login open could be taken for the main before its generation is raised. The copy still follows the main; press Take over again.`);

  if (inRecovery) {
    const pr = await adminSql(t, rec.db, 'SELECT pg_promote(true, 60);', SWITCH_TIMING.promoteMs);
    if (!pr.ok || lastLine(pr.stdout) !== 't') {
      const again = await fleetJoin.readCopyFacts(rec);
      if (!again.ok || again.facts.inRecovery) {
        return refusal(`The copy was not promoted (${pr.ok ? 'it answered that the promotion did not finish within 60 seconds' : failText(pr)}); nothing else was changed. Press Take over again.`);
      }
    }
  }

  const othersRead = await adminSql(t, rec.db, COPIES_READ_SQL(rec.slot));
  const others: TakeoverTail['others'] = othersRead.ok ? { ok: true, names: copyNames(lastLineOrEmpty(othersRead.stdout)) } : { ok: false, error: failText(othersRead) };
  const oldRow = code ? `
DO $$ BEGIN
IF to_regclass('smdb_manager.addresses') IS NOT NULL THEN
  EXECUTE format('DELETE FROM smdb_manager.addresses WHERE slot IS NULL AND host = %L AND port = ${Number(code.port)}', ${sqlLiteral(code.host)});
  DELETE FROM smdb_manager.addresses WHERE slot IS NOT NULL;
END IF;
END $$;
` : `
DO $$ BEGIN
IF to_regclass('smdb_manager.addresses') IS NOT NULL THEN
  DELETE FROM smdb_manager.addresses WHERE slot IS NOT NULL;
END IF;
END $$;
`;
  // D18, D19: over an unchecked mark the rows hold the pushing machine's live claims; a resume caps as the press that saved its intent did.
  const capShards = unchecked || (verdict.mode === 'resume' && intent?.unchecked === true);
  const raised = await adminSql(t, rec.db, raiseSql(machineNameOf(inst), verdict.target, `${oldRow}${capShards ? SHARD_CAP_DO_SQL : ''}`));
  if (!raised.ok) return refusal(`The copy is promoted, but its generation could not be raised (${failText(raised)}), so bots may not choose it over the old main. Press Take over again to finish.`);
  const lifted = await liftBotBlock(t, rec.db);
  if (lifted) return refusal(`This machine's database is the main now (generation ${verdict.target}), but the bot's login to it is still blocked (${lifted}): the line the take-over put in its pg_hba.conf could not be removed. Press Take over again to finish.`);

  const intentNow = containerManager.getBot(botId)?.fleetDbReplica?.takeover;
  const inherit = intentNow?.inherit ?? verdict.inherit;
  const restoreNotice = inherit ? {
    file: inherit.file,
    text: `The main this copy took over from was restoring the dump ${inherit.file} (started ${whenText(inherit.at)}) and had not finished it when this copy last received a change, so this database may be missing data or hold a partial restore. Restore a dump before choosing Running (upload one from the old main if this machine has none), or dismiss this notice if the old main's manager showed that restore finished.`,
    at: new Date().toISOString(),
    doubt: true,
  } : undefined;
  const fresh = containerManager.getBot(botId)!;
  const formerMain = code ? { machine: code.machine, generation: copyGen?.generation ?? 0 } : undefined;
  const adopted = await fleetReplica.adoptPromotedReplica(fresh, { op: 'takeover', alone: !rec.publicHost, ...(restoreNotice ? { restoreNotice } : {}), ...(formerMain ? { formerMain } : {}) });
  if (!adopted.success && !adopted.flipped) {
    return refusal(`The copy is promoted and its generation raised, but it could not be filed as this machine's database (${adopted.error}). Press Take over again to finish.`);
  }
  console.log(`[Switch] ${inst.displayName}: took over as the main (generation ${verdict.target}, ${planned ? 'planned' : 'unplanned'})`);
  return {
    planned, target: verdict.target, others, noticeHere: !!restoreNotice, alone: adopted.alone === true, lastAt,
    former: (!code ? 'nocode' : adopted.alone === true ? 'alone' : containerManager.getBot(botId)?.fleetDb?.replication ? 'follow' : 'norepl') as TakeoverTail['former'],
    ...(adopted.success ? {} : { enable: adopted.error || 'no reason given' }), ...(adopted.addresses ? { addresses: adopted.addresses } : {}),
  };
}

type TakeoverTail = {
  planned: boolean; target: number; others: { ok: true; names: string[] } | { ok: false; error: string }; noticeHere: boolean; enable?: string; alone: boolean;
  lastAt: string | null; addresses?: fleetJoin.AddressesOutcome; former: 'follow' | 'alone' | 'nocode' | 'norepl';
};

const lastLineOrEmpty = (text: string) => text.trim().split('\n').map(l => l.trim()).filter(Boolean).pop() ?? '';

/** T-OTHERS' entries from COPIES_READ_SQL's `<machine>|<client>` list (D50). */
function copyNames(line: string): string[] {
  if (!line) return [];
  return line.split(',').map(entry => {
    const [machine, client] = entry.split('|');
    if (machine) return machineText(machine);
    return client ? `a machine without an address (last connected from ${client})` : 'a machine without an address';
  });
}

const FORMER_TAIL: Record<TakeoverTail['former'], string> = {
  follow: " This manager checks the old main every 5 minutes; if it runs again as a main, this manager adds this machine to its copy list, and the old main's manager then blocks its bot's login there and puts the bot in Off once it holds nothing it could not save. Rebuild it as a copy with Rejoin as a copy in its manager, which keeps a dump of it first.",
  alone: " This machine has no address for other machines, so the old main's manager cannot learn of this switch: if the old main runs again, choose Off for the bot in its manager.",
  norepl: ' Replication is not enabled here, so this manager checks the old main every 5 minutes but cannot add this machine to its copy list, and the old main\'s manager does not learn of this switch: if the old main runs again, choose Off for the bot in its manager.',
  nocode: ' The join code stored here could not be read, so this manager cannot check the old main: if it runs again, choose Off for the bot in its manager, then rejoin it there as a copy of this machine.',
};

async function finishTakeover(botId: string, r: TakeoverTail, start: boolean): Promise<LaneOutcome> {
  const date = utcText(Date.now());
  let text = r.planned
    ? `This machine is the main now (generation ${r.target}, ${date}): the copy held every change of the old main and was promoted.`
    : `This machine is the main now (generation ${r.target}, ${date}). The old main's changes after ${whenText(r.lastAt)} are not here.${FORMER_TAIL[r.former]}`;
  if (r.enable) text += ` Replication could not be enabled here (${r.enable}); enable it in the Replication section so other machines can use this database.`;
  if (r.alone) text += " This copy has no address for other machines, so it is the main only while it runs alone; other machines' bots cannot reach it.";
  text += fleetJoin.addressesText(r.addresses);
  if (r.others.ok && r.others.names.length > 0) text += ` The copies on ${r.others.names.join(', ')} followed the old main: on each of those machines, Join with this machine's join code, then Re-seed the copy.`;
  if (!r.others.ok) text += ` The manager could not read which other machines held copies of the old main (${r.others.error}); on each machine that did, Join with this machine's join code, then Re-seed the copy.`;
  const inst = containerManager.getBot(botId);
  if (!inst) return { success: true, text };
  if (r.noticeHere || fleetBackup.shownRestoreNoticeFile(botId)) {
    text += " The bot was not started: the old main's restore had not finished, and its notice is on the Database window.";
  } else if (!start) {
    text += ' The bot was not started; choose Running in the State window when ready.';
  } else if (maintenance.maintenanceOf(inst).state === 'off') {
    text += " The bot's state is Off; choose Running in the State window to start it here.";
  } else {
    const order = await maintenance.runMaintenanceOrder(botId, 'running', maintenance.maintenanceOf(inst).message);
    text += ` ${order.text}`;
    if (order.settled && await containerManager.appContainerRunning(botId) === false) {
      const started = await containerManager.startBot(botId).catch(err => ({ success: false, error: errText(err) }));
      if (!started.success) text += ` The bot did not start (${started.error || 'no reason given'}); press Start.`;
    }
  }
  const notice = await stepNotice(botId);
  const noticeText = notice ? noticeLine(notice) : '';
  if (noticeText) text += ` ${noticeText}`;
  const host = containerManager.getBot(botId)?.fleetDb?.replication?.publicHost;
  if (notice?.state === 'unsupported' && host && net.isIP(host)) {
    text += ` Other machines reach this database at the IP address ${host}; a bot build that cannot check a certificate by IP address cannot connect to it (this bot's build has no switch-notice hook, so it is such a build). Update the bots, or give this machine a DNS name and enable replication with it.`;
  }
  return { success: true, text };
}

// ─── Switch notice ───

/** The V-NOTICE line; '' when no notice is owed. */
export function noticeLine(n: FleetDbSwitchNotice): string {
  const date = n.triedAt ? utcText(n.triedAt) : 'an unknown date';
  if (n.state === 'not-owed') return '';
  if (n.waiting) return 'The switch notice waits until the bot runs.';
  if (n.state === 'sent') return `The owner was sent a switch notice for generation ${n.generation} on ${date}.${n.channel === 'posted' ? ' A copy is in the owner messages channel.' : ''}${n.note ? ` ${n.note}` : ''}`;
  if (n.state === 'already') return `The bot posted no new switch notice for generation ${n.generation} on ${date}: ${n.note || 'no reason given'}`;
  if (n.state === 'refused') return `The bot did not post the switch notice for generation ${n.generation} (${n.error || 'no reason given'}). The manager asks again every hour while this database holds that generation.`;
  if (n.state === 'unsupported') return "This bot's build has no switch-notice hook, so the owner got no message about this switch.";
  if (n.state === 'unknown') return `Whether the switch notice for generation ${n.generation} was posted can't be confirmed (${n.error || 'no reason given'}); the manager asks again within an hour, and the bot posts it only if it finds no notice of that generation.`;
  return `The switch notice for generation ${n.generation} is not sent yet (${n.error || 'not tried yet'}); the manager tries again every hour.`;
}

/** N-b: the notice for the generation this main holds, sent at least once; null when none is owed. */
export async function stepNotice(botId: string, now = Date.now()): Promise<FleetDbSwitchNotice | null> {
  const inst = containerManager.getBot(botId);
  const db = inst?.fleetDb;
  if (!inst || !db) return null;
  if (db.replacedBy || db.mainConflict) return db.switchNotice ?? null;
  const read = await readGeneration({ container: db.containerName, user: db.user }, db.db);
  if (!read.ok || !read.row || read.row.generation < 2) return db.switchNotice ?? null;
  const row = read.row;
  const record = db.switchNotice?.generation === row.generation ? db.switchNotice : undefined;
  const app = await containerManager.appContainerRunning(botId);
  if (app !== true) {
    if (record && !record.waiting) return record;
    const waiting: FleetDbSwitchNotice = { generation: row.generation, machine: row.machine, since: row.since, state: 'pending', waiting: true };
    if (!record) saveSwitch(botId, { switchNotice: waiting });
    return record ?? waiting;
  }
  if (!noticeDue(row, record?.waiting ? undefined : record, now, true)) return record ?? db.switchNotice ?? null;
  const pending: FleetDbSwitchNotice = { generation: row.generation, machine: row.machine, since: row.since, state: 'pending', triedAt: now };
  const pre = saveSwitch(botId, { switchNotice: pending });
  if (pre) {
    console.error(`[Switch] ${inst.displayName}: the switch notice was not sent, because the manager could not record it first (${pre})`);
    return record ?? null;
  }
  const r = await callAppHook(inst, 'switch-notice', 'POST', { machine: row.machine, generation: row.generation, date: row.since ?? new Date(now).toISOString() }, SWITCH_TIMING.noticeMs);
  const next: FleetDbSwitchNotice = { ...pending, ...noticeState(r) };
  const after = saveSwitch(botId, { switchNotice: next });
  if (after) console.error(`[Switch] ${inst.displayName}: the switch notice outcome could not be recorded (${after})`);
  console.log(`[Switch] ${inst.displayName}: switch notice for generation ${row.generation}: ${next.state}${next.error ? ` (${next.error})` : ''}`);
  return next;
}

// ─── O11 Keep this machine as the main ───

export async function keepMain(botId: string): Promise<LaneOutcome> {
  const inst = containerManager.getBot(botId);
  if (!inst) return refusal('Bot not found', 404);
  const db = inst.fleetDb;
  const c = db?.mainConflict;
  if (!db || !c) return refusal('No second main is recorded');
  const notice = fleetBackup.shownRestoreNoticeFile(botId);
  if (notice) return refusal(`A restore of ${notice} has not finished cleanly here (its notice is on the Database window), so this machine was not kept as the main and nothing was changed. Restore a dump again or dismiss the notice first, or rejoin this machine as a copy of ${c.machine}.`);
  const fence = await switchAdmissionNotice(botId, 'this machine was not kept as the main', { skipNotice: true });
  if (fence) return refusal(fence);
  const t = { container: db.containerName, user: db.user };
  const own = await ownGeneration(t, db.db);
  if (!own.ok) return refusal(`The generation could not be raised (${own.error}); nothing was changed`);
  const mine = own.row?.generation ?? 0;
  let peerGen = c.generation;
  if (c.cert) {
    const probe = await probeTarget(inst, { host: c.host, port: c.port, cert: c.cert, machine: c.machine });
    const p = probe.verdict;
    if (p && p.kind === 'writable') {
      const g = p.gen?.generation ?? 0;
      if (g > mine) {
        await markReplaced(inst, { machine: c.machine, host: c.host, port: c.port, generation: g, own: mine, since: p.gen?.since ?? null, cert: c.cert });
        const blockError = containerManager.getBot(botId)?.fleetDb?.replacedBy?.blockError;
        return refusal(blockError
          ? `${c.machine} has a higher generation now, so it is the main; this database's login could not be blocked (${blockError}), and the manager tries again every 5 minutes. Rejoin this machine as a copy.`
          : `${c.machine} has a higher generation now, so it is the main; this database's login is blocked. Rejoin this machine as a copy.`);
      }
      peerGen = Math.max(peerGen, g);
    }
  }
  // K10: a Keep pressed again after a failed open finds this database above the conflict and skips the raise.
  let target = mine;
  if (mine <= peerGen) {
    target = peerGen + 1;
    const raised = await adminSql(t, db.db, raiseSql(machineNameOf(inst), target));
    if (!raised.ok) return refusal(`The generation could not be raised (${failText(raised)}); nothing was changed`);
  }
  const rec = maintenance.maintenanceOf(containerManager.getBot(botId) ?? inst);
  const running = rec.state === 'running' && rec.settled;
  if (running) {
    const opened = await dbLogin.openBotLogin(t);
    if (!opened.ok) return refusal(`This machine is the main now (generation ${target}), but the bot's login here could not be opened (${opened.error}), so two mains are still recorded here; press Keep this machine as the main again to open it.`);
  }
  const clear = saveSwitch(botId, { mainConflict: null });
  const login = running ? ", and the bot's login is open here again" : `; the bot's state here is ${STATE_NAME[rec.state]}, so its login stays blocked until you choose Running`;
  const text = db.replication
    ? `This machine is the main now (generation ${target})${login}. The manager can't confirm when ${c.machine}'s manager reads this generation: it checks every 5 minutes while it can reach this machine, then blocks its bot's login there and puts the bot in Off once it holds nothing it could not save. Rejoin ${c.machine} as a copy in its manager afterwards; that keeps a dump of its database first.`
    : `This machine is the main now (generation ${target})${login}. This machine has no address for other machines, so ${c.machine}'s manager cannot learn of this choice: choose Off for the bot in that machine's manager.`;
  return { success: true, text: `${text}${clear ? NOTREC_TAIL(clear) : ''}` };
}

const STATE_NAME: Record<string, string> = { running: 'Running', maintenance: 'Maintenance', off: 'Off' };

// ─── The tick ───

const peerCheckedAt = new Map<string, number>();
const rejoinCheckedAt = new Map<string, number>();
const syncLogged = new Map<string, string>();
const formerLogged = new Map<string, string>();
let tickTimer: NodeJS.Timeout | null = null;
let firstTimer: NodeJS.Timeout | null = null;
let tickRunning = false;

/** This main's own copies, as its address list holds them, for the peer check. */
async function ownPeers(inst: InstanceConfig): Promise<Array<{ host: string; port: number; machine: string; cert: string }>> {
  const db = inst.fleetDb!;
  const r = await adminSql({ container: db.containerName, user: db.user }, db.db,
    `SELECT 'addr|' || host || '|' || port || '|' || machine || '|' || replace(cert, E'\\n', '~') FROM smdb_manager.addresses WHERE slot IS NOT NULL ORDER BY host, port;`);
  if (!r.ok) return [];
  return r.stdout.split('\n').map(l => parseAddress(l.trim())).filter((a): a is NonNullable<ReturnType<typeof parseAddress>> => a !== null);
}

const replacedDm = (inst: InstanceConfig, r: FleetDbReplaced) => ({
  key: `${inst.id}:replaced:${r.generation}`,
  text: r.blockError
    ? `The main database of ${inst.displayName} moved to ${r.machine} on ${r.since ? utcText(Date.parse(r.since)) : utcText(Date.parse(r.at) || Date.now())}, and the old main on ${machineNameOf(inst)} is running again. Its manager could not block the bot's login there (${r.blockError}) and tries again every 5 minutes; it stops the bot there once it holds no change it could not save. Rejoin it as a copy in that machine's manager.`
    : `The main database of ${inst.displayName} moved to ${r.machine} on ${r.since ? utcText(Date.parse(r.since)) : utcText(Date.parse(r.at) || Date.now())}, and the old main on ${machineNameOf(inst)} is running again. Its manager blocked the bot's login there and stops the bot there once it holds no change it could not save; rejoin it as a copy in that machine's manager.`,
});
const conflictDm = (inst: InstanceConfig, c: FleetDbConflict) => ({
  key: `${inst.id}:two-mains:${c.generation}`,
  text: c.blockError
    ? `Two databases of ${inst.displayName} are mains with the same generation: ${machineNameOf(inst)} and ${c.machine}. The manager on ${machineNameOf(inst)} could not block the bot's database login there (${c.blockError}) and tries again every 5 minutes; choose which one stays the main in either machine's manager (the bot's Database window).`
    : `Two databases of ${inst.displayName} are mains with the same generation: ${machineNameOf(inst)} and ${c.machine}. The manager on ${machineNameOf(inst)} blocked the bot's database login there; choose which one stays the main in either machine's manager (the bot's Database window).`,
});

/** Sends the owner message of a standing replacedBy or mainConflict when dmDue says so, and keeps its outcome there. */
async function ownerMessage(botId: string, field: 'replacedBy' | 'mainConflict', now: number): Promise<void> {
  const inst = containerManager.getBot(botId);
  const mark = inst?.fleetDb?.[field];
  if (!inst || !mark || !dmDue(mark.dm, now)) return;
  const { key, text } = field === 'replacedBy' ? replacedDm(inst, mark as FleetDbReplaced) : conflictDm(inst, mark as FleetDbConflict);
  const r: Awaited<ReturnType<typeof notifyOwner>> = await notifyOwner(inst, text, key).catch(err => ({ dm: 'failed' as const, dmError: errText(err) }));
  const dm: OwnerDm = r.dm === 'sent'
    ? { key, state: r.posted === false ? 'repeat' : 'posted', ...(r.posted !== false && r.place ? { place: r.place } : {}), ...(r.note ? { note: r.note } : {}), triedAt: now }
    : r.dm === 'unsupported' || r.notFound ? { key, state: 'unsupported', triedAt: now }
    : { key, state: r.dm === 'unknown' ? 'unknown' : 'failed', error: r.dmError || 'no reason given', triedAt: now };
  const fresh = containerManager.getBot(botId)?.fleetDb?.[field];
  if (!fresh || fresh.generation !== mark.generation) return;
  const e = saveSwitch(botId, { [field]: { ...fresh, dm } });
  if (e) console.error(`[Switch] ${inst.displayName}: the outcome of the message to the owner could not be recorded (${e})`);
}

async function markReplaced(inst: InstanceConfig, r: { machine: string; host: string; port: number; generation: number; own: number; since: string | null; cert?: string }, now = Date.now()): Promise<void> {
  const db = inst.fleetDb!;
  const t = { container: db.containerName, user: db.user };
  const blocked = await dbLogin.blockBotLogin(t);
  const ended = blocked.ok ? await dbLogin.endBotSessions(t, 0) : blocked;
  const blockError = ended.ok ? undefined : ended.error;
  const prior = containerManager.getBot(inst.id)?.fleetDb?.replacedBy;
  const kept = prior && prior.generation === r.generation ? { ...(prior.off ? { off: prior.off } : {}), ...(prior.dm ? { dm: prior.dm } : {}) } : {};
  saveSwitch(inst.id, { replacedBy: { ...kept, ...r, at: prior?.at ?? new Date().toISOString(), ...(blockError ? { blockError } : {}) }, mainConflict: null });
  if (!prior || prior.generation !== r.generation) {
    console.warn(`[Switch] ${inst.displayName}: replaced as the main by ${r.machine} (generation ${r.generation}); the bot's database login is ${blockError ? `not blocked (${blockError})` : 'blocked'}`);
  }
  await ownerMessage(inst.id, 'replacedBy', now);
}

const offLogged = new Map<string, string>();

/** N-g (D36): Maintenance first, which asks the bot what it holds, then Off once it holds nothing it could not save. */
async function replacedStep(botId: string, now: number): Promise<void> {
  const inst = containerManager.getBot(botId);
  const replaced = inst?.fleetDb?.replacedBy;
  if (!inst || !replaced) return;
  const message = maintenance.maintenanceOf(inst).message;
  let plan = replacedPlan(maintenance.maintenanceOf(inst), replaced.off, now);
  if (plan === 'none' || plan === 'wait') return;
  let off: NonNullable<FleetDbReplaced['off']> | null = null;
  let askedAt = replaced.off?.askedAt;
  if (plan === 'maintenance') {
    askedAt = now;
    const order = await maintenance.runMaintenanceOrder(botId, 'maintenance', message);
    if (!order.settled) off = { state: 'failed', askedAt, at: new Date(now).toISOString(), error: order.text };
    else {
      const rec = maintenance.maintenanceOf(containerManager.getBot(botId) ?? inst);
      plan = replacedPlan(rec, { state: 'held', askedAt, at: '' }, now);
      if (plan !== 'off') off = { state: 'held', ...(rec.held ? { held: rec.held } : {}), askedAt, at: new Date(now).toISOString() };
    }
  }
  if (!off) {
    const order = await maintenance.runMaintenanceOrder(botId, 'off', message);
    const rec = maintenance.maintenanceOf(containerManager.getBot(botId) ?? inst);
    off = order.settled
      ? { state: 'off', ...(rec.held && rec.hook === 'confirmed' ? { held: rec.held } : {}), ...(askedAt !== undefined ? { askedAt } : {}), at: new Date(now).toISOString() }
      : { state: 'failed', ...(askedAt !== undefined ? { askedAt } : {}), at: new Date(now).toISOString(), error: order.text };
  }
  const fresh = containerManager.getBot(botId)?.fleetDb?.replacedBy;
  if (!fresh) return;
  const e = saveSwitch(botId, { replacedBy: { ...fresh, off } });
  if (e) console.error(`[Switch] ${inst.displayName}: the replaced main's state could not be recorded (${e})`);
  const logLine = off.state === 'off' ? `[Switch] ${inst.displayName}: the replaced main's bot is Off`
    : off.state === 'held' ? `[Switch] ${inst.displayName}: the replaced main's bot stays in Maintenance: it holds changes it could not save`
    : `[Switch] ${inst.displayName}: the replaced main's bot could not be put in Off: ${off.error}`;
  if (offLogged.get(botId) !== off.state) {
    offLogged.set(botId, off.state);
    (off.state === 'failed' ? console.warn : console.log)(logLine);
  }
}

/** Re-blocks the bot's login when it reads open (N17, N48). */
async function keepBlocked(inst: InstanceConfig, what: string): Promise<void> {
  const db = inst.fleetDb!;
  const t = { container: db.containerName, user: db.user };
  const login = await dbLogin.readBotLogin(t);
  if (!login.ok || login.login.canLogin !== true) return;
  const again = await dbLogin.blockBotLogin(t);
  if (again.ok) await dbLogin.endBotSessions(t, 0);
  console.warn(`[Switch] ${inst.displayName}: the bot's database login was open ${what}; ${again.ok ? 'blocked it again' : `it could not be blocked (${again.error})`}`);
}

/** N12 (D44): this database's login blocked and its sessions ended before the conflict is recorded, then the owner message. */
async function markTie(inst: InstanceConfig, peer: { machine: string; host: string; port: number; cert?: string }, mine: number, now: number): Promise<void> {
  const db = inst.fleetDb!;
  const t = { container: db.containerName, user: db.user };
  const blocked = await dbLogin.blockBotLogin(t);
  const ended = blocked.ok ? await dbLogin.endBotSessions(t, 0) : blocked;
  const blockError = ended.ok ? undefined : ended.error;
  const prior = containerManager.getBot(inst.id)?.fleetDb?.mainConflict;
  const same = prior && prior.generation === mine && prior.host === peer.host && prior.port === peer.port;
  saveSwitch(inst.id, { mainConflict: {
    machine: peer.machine, host: peer.host, port: peer.port, generation: mine, at: same ? prior.at : new Date(now).toISOString(),
    ...(peer.cert ? { cert: peer.cert } : {}), ...(blockError ? { blockError } : {}), ...(same && prior.dm ? { dm: prior.dm } : {}),
  } });
  if (!same) console.warn(`[Switch] ${inst.displayName}: ${peer.machine} also accepts writes as the main with generation ${mine}; the bot's database login is ${blockError ? `not blocked (${blockError})` : 'blocked'}`);
  await ownerMessage(inst.id, 'mainConflict', now);
}

/** N49: the conflict with this peer ends; the login opens again when the state is a settled Running. */
async function endTie(inst: InstanceConfig, host: string, port: number): Promise<void> {
  const fresh = containerManager.getBot(inst.id) ?? inst;
  const c = fresh.fleetDb?.mainConflict;
  if (!c || c.host !== host || c.port !== port) return;
  const rec = maintenance.maintenanceOf(fresh);
  if (rec.state === 'running' && rec.settled) {
    const db = fresh.fleetDb!;
    const opened = await dbLogin.openBotLogin({ container: db.containerName, user: db.user });
    if (!opened.ok) {
      console.warn(`[Switch] ${inst.displayName}: ${c.machine} no longer accepts writes as a main, but the bot's database login could not be opened (${opened.error}); the manager tries again every 5 minutes`);
      return;
    }
  }
  saveSwitch(inst.id, { mainConflict: null });
  console.log(`[Switch] ${inst.displayName}: ${c.machine} no longer accepts writes as a main; this database is the only main`);
}

/** N-d: whether another database of this bot took over from this one, or ties with it. */
async function peerCheck(inst: InstanceConfig, now: number): Promise<void> {
  const db = inst.fleetDb!;
  if (now - (peerCheckedAt.get(inst.id) ?? 0) < SWITCH_TIMING.peerEveryMs) return;
  peerCheckedAt.set(inst.id, now);
  const t = { container: db.containerName, user: db.user };
  const own = await ownGeneration(t, db.db);
  if (!own.ok) return;
  const mine = own.row?.generation ?? 0;
  const sys = await adminSql(t, db.db, 'SELECT system_identifier FROM pg_control_system();');
  const systemId = sys.ok ? lastLine(sys.stdout) : null;
  if (db.replacedBy) {
    await keepBlocked(inst, 'on a replaced main');
    return;
  }
  if (db.mainConflict) await keepBlocked(inst, 'while two mains stand');
  if (db.replication) {
    // D50: the copies list a take-over on any copy reads; not while a push may replace this database (D42).
    if (!db.receive && !db.pushBroken) {
      const sync = await adminSql(t, db.db, COPIES_SYNC_SQL);
      const error = sync.ok ? '' : failText(sync);
      if (syncLogged.get(inst.id) !== error) {
        syncLogged.set(inst.id, error);
        if (error) console.warn(`[Switch] ${inst.displayName}: the list of this database's copies could not be written (${error}); the manager tries again every 5 minutes`);
      }
    }
    for (const peer of await ownPeers(inst)) {
      const probe = await probeTarget(inst, peer);
      const verdict = peerVerdict(mine, probe.verdict, systemId);
      const p = probe.verdict;
      if (verdict === 'replaced' && p && 'gen' in p) {
        await markReplaced(inst, { machine: peer.machine, host: peer.host, port: peer.port, generation: p.gen?.generation ?? 0, own: mine, since: p.gen?.since ?? null, cert: peer.cert }, now);
        return;
      }
      if (verdict === 'tie') {
        await markTie(inst, peer, mine, now);
        return;
      }
      if (verdict === 'none') await endTie(inst, peer.host, peer.port);
    }
  }
  await formerCheck(inst, mine, systemId, now);
}

/** N50 to N54 (D45): the main this database took over from, probed with its own join code. */
async function formerCheck(inst: InstanceConfig, mine: number, systemId: string | null, now: number): Promise<void> {
  const fm = containerManager.getBot(inst.id)?.fleetDb?.formerMain;
  if (!fm) return;
  const db = inst.fleetDb!;
  if (db.replication) {
    const listed = await adminSql({ container: db.containerName, user: db.user }, db.db, FORMER_LISTED_SQL(fm.host, fm.port));
    if (listed.ok && Number(lastLine(listed.stdout)) > 0) {
      if (!saveSwitch(inst.id, { formerMain: null })) console.log(`[Switch] ${inst.displayName}: the old main ${fm.machine} is a copy of this database now; the manager no longer checks it as a former main`);
      return;
    }
  }
  const decoded = decodeJoinCode(fm.code);
  if (!decoded.ok) {
    formerError(inst, fm, { kind: 'code', reason: decoded.why });
    return;
  }
  const cert = await fleetJoin.mainCertificate(decoded.code);
  if (!cert.ok) {
    if (cert.kind === 'fingerprint') formerError(inst, fm, { kind: 'cert', reason: cert.reason });
    return;
  }
  if (fm.checkError) {
    const { checkError: _cleared, ...kept } = fm;
    saveSwitch(inst.id, { formerMain: kept });
  }
  if (await fleetJoin.ensureClientImage()) return;
  const p = await fleetJoin.peerProbe(inst, decoded.code, cert.pem, 'former');
  const verdict = formerVerdict(mine, p, systemId);
  const target = { machine: fm.machine, host: fm.host, port: fm.port, cert: cert.pem };
  if (verdict === 'replaced' && 'gen' in p) {
    await markReplaced(inst, { ...target, generation: p.gen?.generation ?? 0, own: mine, since: p.gen?.since ?? null }, now);
    return;
  }
  if (verdict === 'tie') {
    await markTie(inst, target, mine, now);
    return;
  }
  if (verdict === 'gone') {
    saveSwitch(inst.id, { formerMain: null });
    await endTie(inst, fm.host, fm.port);
    return;
  }
  if (verdict !== 'lower') return;
  await endTie(inst, fm.host, fm.port);
  const repl = inst.fleetDb?.replication;
  if (!repl) return;
  // The reach: the old main's own check then finds this machine and blocks its bot there.
  const own = await fleetJoin.readCopyCert(inst.fleetDb!.containerName);
  const error = own
    ? await fleetJoin.registerAddress(inst, decoded.code, cert.pem, { host: repl.publicHost, port: repl.hostPort, slot: fm.slot, cert: own, machine: machineNameOf(inst) })
    : "this database's certificate could not be read";
  const outcome = error ?? '';
  if (formerLogged.get(inst.id) !== outcome) {
    formerLogged.set(inst.id, outcome);
    if (error) console.warn(`[Switch] ${inst.displayName}: the old main ${fm.machine} runs again as a main; this machine's address could not be added to its copy list (${error})`);
    else console.log(`[Switch] ${inst.displayName}: the old main ${fm.machine} runs again as a main; this machine's address was added to its copy list`);
  }
}

/** N59, N60: why the old main cannot be checked, saved and logged only when it changes. */
function formerError(inst: InstanceConfig, fm: FleetDbFormerMain, checkError: NonNullable<FleetDbFormerMain['checkError']>): void {
  if (fm.checkError?.kind === checkError.kind && fm.checkError.reason === checkError.reason) return;
  if (saveSwitch(inst.id, { formerMain: { ...fm, checkError } })) return;
  console.warn(checkError.kind === 'cert'
    ? `[Switch] ${inst.displayName}: the old main ${fm.machine} shows another certificate than the join code kept here (${checkError.reason}); the manager can't check it`
    : `[Switch] ${inst.displayName}: the join code kept from the old main ${fm.machine} does not read (${checkError.reason}); the manager can't check it`);
}

/** N-e: the old main of a planned move rejoins as a copy once its target is the main. */
async function rejoinCheck(inst: InstanceConfig, now: number): Promise<void> {
  const h = inst.fleetDb?.handover;
  if (!h || h.mode !== 'stream' || h.phase !== 'stopped' || !h.host || !h.port || !h.cert) return;
  if (now - (rejoinCheckedAt.get(inst.id) ?? 0) < SWITCH_TIMING.peerEveryMs) return;
  rejoinCheckedAt.set(inst.id, now);
  const machine = h.machine || h.host;
  const probe = await probeTarget(inst, h);
  if (probe.fpError) {
    saveSwitch(inst.id, { handover: { ...h, rejoinError: `${machine} shows another certificate than the one it registered (${probe.fpError}), so this machine did not rejoin it. Copy ${machine}'s join code and paste it into Rejoin as a copy.` } });
    return;
  }
  const p = probe.verdict;
  if (p?.kind === 'login-refused') {
    saveSwitch(inst.id, { handover: { ...h, rejoinError: `${machine} refused this machine's replication login (${p.reason}). Copy ${machine}'s join code and paste it into Rejoin as a copy.` } });
    return;
  }
  if (!rejoinDue(h, p, now, null)) {
    const marked = p?.kind === 'writable' && (p.gen?.generation ?? 0) >= (h.generation ?? Infinity) ? p.receiveMark : false;
    const reason = !p ? probe.reason : p.kind === 'in-recovery' ? `${machine} still follows another database`
      : marked === true ? `${machine} is receiving a push from another machine, or holds one that did not finish`
      : marked === null ? `the manager can't confirm whether ${machine} is receiving a push (its receive mark did not read)`
      : p.kind === 'writable' ? `${machine} has generation ${p.gen?.generation ?? 0}` : 'reason' in p ? p.reason : p.kind;
    if (h.lastCheck !== reason) saveSwitch(inst.id, { handover: { ...h, lastCheck: reason } });
    return;
  }
  await rejoinNow(inst, h, now);
}

async function rejoinNow(inst: InstanceConfig, h: FleetDbHandover, now: number): Promise<{ success: boolean; error?: string }> {
  const machine = h.machine || h.host || 'the main';
  const composed = composeJoinCode(inst, { host: h.host!, port: h.port!, cert: h.cert!, machine });
  if (!composed.ok) return { success: false, error: composed.error };
  console.log(`[Switch] ${inst.displayName}: ${machine} is the main now (generation ${h.generation}); rebuilding this machine's database as its copy after a dump of it`);
  const repl = inst.fleetDb?.replication;
  const r = fleetReplica.reseedStalePrimary(inst, composed.text, repl?.publicHost, repl?.hostPort, false);
  if (!r.success) {
    saveSwitch(inst.id, { handover: { ...h, rejoinTriedAt: now, rejoinError: `Rejoining ${machine} as a copy did not start: ${r.error}. The manager tries again in 30 minutes, or press Rejoin as a copy.` } });
  }
  return r;
}

/** The operator's Rejoin of a replaced main or a handed-over one: the code composed from the recorded target. */
export function rejoinComposed(botId: string): { success: boolean; error?: string; started?: boolean } {
  const inst = containerManager.getBot(botId);
  if (!inst?.fleetDb) return { success: false, error: 'This instance holds no main database to rebuild' };
  const t = inst.fleetDb.replacedBy ?? inst.fleetDb.mainConflict ?? (inst.fleetDb.handover?.mode === 'stream' ? inst.fleetDb.handover : null);
  if (!t || !t.host || !t.port || !t.cert) return { success: false, error: 'No main is recorded to rejoin; paste its join code instead' };
  const composed = peerCode(inst, { host: t.host, port: t.port, cert: t.cert, machine: t.machine || t.host });
  if (!composed.ok) return { success: false, error: `The join code could not be composed (${composed.error}); paste the main's join code instead` };
  const repl = inst.fleetDb.replication;
  return fleetReplica.reseedStalePrimary(inst, composed.text, repl?.publicHost, repl?.hostPort, false);
}

/** N-f: the restore record's pending flag cleared on a main that holds no notice and no read-only layer. */
async function clearRestorePending(inst: InstanceConfig): Promise<void> {
  const db = inst.fleetDb!;
  if (fleetBackup.shownRestoreNoticeFile(inst.id)) return;
  const t = { container: db.containerName, user: db.user };
  const rs = await readRestoreState(t);
  if (!rs.ok || !rs.state?.pending) return;
  const fence = await dbLogin.readWriteFence(t);
  if (!fence.ok || fence.on) return;
  const login = await dbLogin.readBotLogin(t);
  if (!login.ok || login.login.inRecovery) return;
  const r = await adminSql(t, 'postgres', RESTORE_STATE_CLEAR);
  if (!r.ok) console.warn(`[Switch] ${inst.displayName}: the restore record could not be marked finished (${failText(r)})`);
}

/** The RV-LOG-STALEFAIL error last logged per bot; deleted when a stale mark is removed. */
const staleMarkLogged = new Map<string, string>();

/** N-j (D62): a receive mark row on a main whose record holds neither receive nor pushBroken, removed by its own id. */
async function clearStaleReceiveMark(inst: InstanceConfig): Promise<void> {
  const idle = () => {
    const db = containerManager.getBot(inst.id)?.fleetDb;
    return !!db && !db.receive && !db.pushBroken && !containerManager.isBotBusy(inst.id);
  };
  if (!idle()) return;
  const db = inst.fleetDb!;
  const left = await removeStaleMark({ container: db.containerName, user: db.user }, idle);
  if (!left.ok) {
    if (staleMarkLogged.get(inst.id) === left.error) return;
    staleMarkLogged.set(inst.id, left.error);
    console.warn(`[Switch] ${inst.displayName}: a receive mark that no receive or unfinished push on this machine stands for could not be removed (${left.error}); the manager tries again every minute`);
    return;
  }
  if (!left.removed) return;
  staleMarkLogged.delete(inst.id);
  staleMarkRemoved(inst.displayName);
}

const staleMarkRemoved = (name: string) => console.log(`[Switch] ${name}: removed a receive mark that no receive or unfinished push on this machine stands for`);

/** Reads the cluster's receive mark and removes its row by its own mark id while `stale()` holds after the read. */
async function removeStaleMark(t: Target, stale: () => boolean): Promise<{ ok: true; removed: boolean } | { ok: false; error: string }> {
  const read = await adminSql(t, 'postgres', RECEIVE_MARK_READ_SQL);
  if (!read.ok) return missingTable(read.stderr) ? { ok: true, removed: false } : { ok: false, error: failText(read) };
  const mark = parseReceiveMark(read.stdout);
  if (mark === undefined) return { ok: false, error: `the receive mark answered '${lastLine(read.stdout)}'` };
  if (!mark || !stale()) return { ok: true, removed: false };
  const r = await adminSql(t, 'postgres', receiveMarkClearSql(mark.markId));
  if (!r.ok) return { ok: false, error: failText(r) };
  return { ok: true, removed: true };
}

/** N-c is in fleetMove; it is passed in to keep the import one way. */
let receiveStep: ((inst: InstanceConfig, now: number) => Promise<void>) | null = null;
export function setReceiveStep(fn: ((inst: InstanceConfig, now: number) => Promise<void>) | null): void {
  receiveStep = fn;
}

async function tickBot(listed: InstanceConfig, now: number): Promise<void> {
  if (containerManager.isBotBusy(listed.id) || containerManager.getBot(listed.id)?.migrate || containerManager.migrationHolds(listed.id).length > 0) return;
  await fleetJoin.retryAddresses(listed.id);
  const inst = containerManager.getBot(listed.id);
  const db = inst?.fleetDb;
  if (!inst || !db || db.retiringAt) return;
  await rejoinCheck(inst, now);
  if (await dbLogin.sidecarRunning(db.containerName) !== true) return;
  const fresh = containerManager.getBot(inst.id);
  if (!fresh?.fleetDb || containerManager.isBotBusy(inst.id)) return;
  await ensureMainGeneration(inst.id);
  await stepNotice(inst.id, now);
  if (receiveStep) await receiveStep(fresh, now);
  await clearStaleReceiveMark(fresh);
  if (fresh.fleetDb.replication || fresh.fleetDb.formerMain) await peerCheck(fresh, now);
  await clearRestorePending(fresh);
  if (containerManager.getBot(inst.id)?.fleetDb?.replacedBy) {
    await replacedStep(inst.id, now);
    await ownerMessage(inst.id, 'replacedBy', now);
  }
  if (containerManager.getBot(inst.id)?.fleetDb?.mainConflict) await ownerMessage(inst.id, 'mainConflict', now);
}

/** One pass over every bot; a pass that finds the previous one still running does nothing. */
let tickOn: string | null = null;

export async function switchTick(now = Date.now()): Promise<void> {
  if (tickRunning) return;
  tickRunning = true;
  try {
    if (containerManager.registryFault() || containerManager.isShuttingDown()) return;
    for (const inst of containerManager.getAllBots()) {
      if (containerManager.isShuttingDown()) return;
      try {
        tickOn = inst.id;
        await tickBot(inst, now);
      } catch (err) {
        console.error(`[Switch] ${inst.displayName}: the switch check failed: ${errText(err)}`);
      } finally {
        tickOn = null;
      }
    }
  } finally {
    tickRunning = false;
    tickOn = null;
  }
}

/** Whether the switch tick's pass is on this bot now (Migrate refuses a new record meanwhile, A34). */
export function switchTickOn(botId: string): boolean {
  return tickOn === botId;
}

export function startFleetSwitchTick(): void {
  if (tickTimer || firstTimer) return;
  firstTimer = setTimeout(() => {
    firstTimer = null;
    void switchTick();
    tickTimer = setInterval(() => { void switchTick(); }, SWITCH_TIMING.tickMs);
    tickTimer.unref?.();
  }, SWITCH_TIMING.firstMs);
  firstTimer.unref?.();
}

export function stopFleetSwitchTick(): void {
  if (firstTimer) clearTimeout(firstTimer);
  if (tickTimer) clearInterval(tickTimer);
  firstTimer = null;
  tickTimer = null;
}

export function resetSwitchState(): void {
  tickOn = null;
  peerCheckedAt.clear();
  rejoinCheckedAt.clear();
  ensureLogged.clear();
  offLogged.clear();
  syncLogged.clear();
  formerLogged.clear();
  staleMarkLogged.clear();
  tickRunning = false;
}

// ─── The view ───

export interface SwitchView {
  lines: string[];
  badges: Array<{ text: string; title: string; danger: boolean }>;
  handover: FleetDbHandover | null;
  receive: { startedAt: string; expiresAt: string; safetyDump: string } | null;
  replacedBy: { machine: string; generation: number } | null;
  mainConflict: { machine: string; host: string; port: number; generation: number } | null;
  takeover: { planned: boolean; generation: number } | null;
}

/** The N-g line after the replaced line (D36). */
function offClause(r: FleetDbReplaced): string {
  const off = r.off;
  if (!off) return '';
  if (off.state === 'off') {
    return off.held
      ? ` The bot is Off here: the manager stopped it on ${whenText(off.at)}, after it answered that it holds no change it could not save.`
      : ` The bot is Off here: the manager stopped it on ${whenText(off.at)}. Its build has no maintenance hook, so the manager can't confirm whether it held changes it could not save; any it held were dropped at the stop.`;
  }
  if (off.state === 'held') {
    return off.held?.state === 'no'
      ? ` The bot runs in Maintenance here with its login blocked: it reports ${off.held.guilds ?? 0} guild(s) and ${off.held.files ?? 0} file(s) of changes it could not save, and Off would drop them. It saves them on ${r.machine} once it reaches that database; the manager asks it again every 5 minutes and puts it in Off once nothing is left. Choose Off to stop it now and drop them.`
      : " The bot runs in Maintenance here with its login blocked: it could not confirm that it saved every change it holds, and Off would drop what it holds. The manager asks it again every 5 minutes and puts it in Off once it confirms; choose Off to stop it now and drop what it holds.";
  }
  return ` The manager could not put the bot in Off yet (${off.error || 'no reason given'}); it tries again every minute, and the bot's database login stays blocked.`;
}

/** The owner message clause after the replaced or tie line (D37). */
function dmClause(dm: OwnerDm | undefined): string {
  if (!dm) return '';
  if (dm.state === 'posted') return ` The owner was told on ${utcText(dm.triedAt)} (${dm.place === 'channel' ? 'in the owner messages channel' : "in the owner's DMs"}).${dm.note ? ` ${dm.note}` : ''}`;
  if (dm.state === 'repeat') return ` The bot had already posted this message: ${dm.note || 'no reason given'}`;
  if (dm.state === 'failed') return ` The message to the owner was not posted (${dm.error || 'no reason given'}); the manager tries again every hour.`;
  if (dm.state === 'unknown') return ` Whether the message to the owner was posted can't be confirmed (${dm.error || 'no reason given'}); the manager sends it again within an hour, and the bot drops a repeat.`;
  return " This bot's build cannot message the owner, so the owner was not told.";
}

/** GET /fleet-switch and the card: what the records say, as the operator reads it. */
export function switchView(inst: InstanceConfig): SwitchView {
  const db = inst.fleetDb;
  const lines: string[] = [];
  const badges: SwitchView['badges'] = [];
  const h = db?.handover ?? null;
  if (h) {
    const machine = h.machine || 'another machine';
    if (h.mode === 'stream' && h.phase === 'waiting') {
      lines.push('The hand-over did not finish. Press Hand over again, or Cancel the hand-over.');
      badges.push({ text: 'Hand-over not finished', title: 'Press Hand over again, or Cancel the hand-over', danger: true });
    } else if (h.mode === 'stream') {
      const title = !h.host
        ? `Handed over to ${machine}, which has no address for other machines, so this machine cannot rejoin it as a copy. Its database stays stopped; decommission it, or move the main back here with Push from ${machine}.`
        : `Handed over to ${machine} on ${whenText(h.at)}. This machine rejoins as its copy once ${machine} is the main; last check: ${h.lastCheck || 'not checked yet'}.`;
      lines.push(title);
      if (h.rejoinError) lines.push(h.rejoinError);
      badges.push({ text: 'Handed over', title, danger: false });
    } else {
      lines.push(`A move is recorded: ${moveModeText(h)}${h.phase === 'done' ? '' : ', not finished'}.`);
      if (h.lastError) lines.push(h.lastError);
      badges.push({ text: h.phase === 'done' ? 'Handed over' : 'Hand-over not finished', title: moveModeText(h), danger: h.phase !== 'done' });
    }
  }
  if (db?.receive) {
    lines.push(`Waiting for a push until ${whenText(db.receive.expiresAt)}.`);
    badges.push({ text: 'Receiving', title: `Waiting for a push until ${whenText(db.receive.expiresAt)}`, danger: false });
  }
  if (db?.replacedBy) {
    const r = db.replacedBy;
    lines.push(`${r.machine} replaced this database as the main on ${whenText(r.since ?? r.at)} (generation ${r.generation}, this one ${r.own}). The manager blocked the bot's database login here so nothing writes to it. Rejoin this machine as a copy.${r.blockError ? ` The login could not be blocked (${r.blockError}); the manager tries again every 5 minutes.` : ''}${offClause(r)}${dmClause(r.dm)}`);
    badges.push({ text: `Replaced by ${r.machine}`, title: lines[lines.length - 1], danger: true });
  }
  if (db?.mainConflict) {
    const c = db.mainConflict;
    const blocked = c.blockError
      ? `The manager could not block the bot's database login here (${c.blockError}) and tries again every 5 minutes, so bots may still write to this database.`
      : `The manager blocked the bot's database login here, so no bot writes to this database until you choose; ${c.machine}'s manager does the same when it finds this one (it checks every 5 minutes while it can reach it).`;
    lines.push(`Two databases of ${inst.displayName} are mains with the same generation ${c.generation}: this one and ${c.machine} (${c.host}:${c.port}). ${blocked} Keep this machine as the main raises this one's generation and opens the login here; or rejoin this machine as a copy of ${c.machine}, which replaces this database after a dump of it.${dmClause(c.dm)}`);
    badges.push({ text: 'Two mains', title: lines[lines.length - 1], danger: true });
  }
  const fmError = db?.formerMain?.checkError;
  if (fmError) {
    const m = db!.formerMain!.machine;
    lines.push(fmError.kind === 'cert'
      ? `The manager can't check the old main ${m} any more: it shows another certificate than the join code kept here (${fmError.reason}), as it does after it was rebuilt as a copy or its certificate was replaced. If ${m} runs again as a main, choose Off for the bot in its manager.`
      : `The manager can't check the old main ${m}: the join code kept from it does not read (it no longer decrypts or decodes). If ${m} runs again as a main, choose Off for the bot in its manager.`);
  }
  if (db?.pushBroken) {
    const text = `A push replaced this database on or before ${whenText(db.pushBroken.at)} and did not finish, so the bot cannot run on it. Restore the dump ${db.pushBroken.safetyDump} (taken before receiving) with the bot in Maintenance or Off, or press Receive again so the other machine can push again.`;
    lines.push(text);
    badges.push({ text: 'Push not finished', title: text, danger: true });
  }
  const noticeText = db?.switchNotice ? noticeLine(db.switchNotice) : '';
  if (noticeText) lines.push(noticeText);
  const offer = inst.addressesPush;
  if (offer?.state === 'pending') lines.push(`The manager can't confirm that the running bot took its new database list (${offer.error || 'no reason given'}); it sends the list again every minute until the bot answers.`);
  if (offer?.state === 'refused') lines.push(`The bot refused its new database list (${offer.error || 'no reason given'}); it uses the list from its next start (Apply on the card, or Restart).`);
  const tk = inst.fleetDbReplica?.takeover ?? null;
  if (tk) {
    lines.push('A take-over did not finish. Press Take over again.');
    badges.push({ text: 'Take-over not finished', title: 'Press Take over again', danger: true });
  }
  return {
    lines, badges, handover: h ? { ...h, cert: undefined } as FleetDbHandover : null,
    receive: db?.receive ?? null,
    replacedBy: db?.replacedBy ? { machine: db.replacedBy.machine, generation: db.replacedBy.generation } : null,
    mainConflict: db?.mainConflict ? { machine: db.mainConflict.machine, host: db.mainConflict.host, port: db.mainConflict.port, generation: db.mainConflict.generation } : null,
    takeover: tk ? { planned: tk.planned, generation: tk.generation } : null,
  };
}

/** The main's own generation for the Database window: undefined when this bot holds no main or its database is not running. */
export async function generationView(inst: InstanceConfig): Promise<{ machine: string; generation: number; since: string | null } | null | { error: string } | undefined> {
  const db = inst.fleetDb;
  if (!db) return undefined;
  const running = await dbLogin.sidecarRunning(db.containerName);
  if (running === null) return { error: 'docker did not answer' };
  if (!running) return undefined;
  const own = await ownGeneration({ container: db.containerName, user: db.user }, db.db);
  if (!own.ok) return { error: own.error };
  return own.row ? { machine: own.row.machine, generation: own.row.generation, since: own.row.since } : null;
}

/** The streaming copies of this main, for the Hand over buttons; empty when the database does not answer. */
export async function streamingCopies(inst: InstanceConfig): Promise<Array<{ slot: string; machine: string; streaming: boolean }>> {
  const db = inst.fleetDb;
  if (!db?.replication || await dbLogin.sidecarRunning(db.containerName) !== true) return [];
  const r = await adminSql({ container: db.containerName, user: db.user }, db.db,
    `SELECT s.slot_name || '|' || (s.active AND coalesce(r.state, '') = 'streaming')::text || '|' || coalesce((SELECT a.machine FROM smdb_manager.addresses a WHERE a.slot = s.slot_name), s.slot_name)
     FROM pg_replication_slots s LEFT JOIN pg_stat_replication r ON r.pid = s.active_pid WHERE s.slot_type = 'physical' ORDER BY s.slot_name;`);
  if (!r.ok) return [];
  return r.stdout.split('\n').map(l => l.trim().split('|')).filter(p => p.length === 3 && SLOT_RE.test(p[0]))
    .map(([slot, streaming, machine]) => ({ slot, streaming: streaming === 'true', machine: machineText(machine) }));
}
