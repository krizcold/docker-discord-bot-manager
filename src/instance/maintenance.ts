/**
 * The maintenance tool: one state per bot (Running, Maintenance or Off) and the owner's message. Maintenance calls
 * the bot's `maintenance` hook, then blocks the bot's database role and ends its sessions; Off does the same and
 * stops the bot; Running reverses it (login first, then the hook). Every order is recorded as an intent before it
 * acts and settles only once its effect reads back.
 */
import * as containerManager from '../docker/containerManager';
import * as envManager from '../env/manager';
import { findAppCapabilities } from '../config/appCapabilities';
import { callAppHook, AppHookResult } from './appHookClient';
import * as dbLogin from './dbLogin';
import * as fleetBackup from './fleetBackup';
import { fenceOwnerLane, fenceOwnerText } from './fleetBackupGuards';
import { BotRunState, InstanceConfig, MaintenanceRecord } from '../types';

export type MaintenanceKind = 'database' | 'copy' | 'external' | 'json' | 'none';
export type PlanStep = 'hook' | 'db-up' | 'block' | 'end-sessions' | 'stop' | 'db-up-alone' | 'open' | 'start' | 'hook-wait';
export type OrderResult = { settled: boolean; text: string };
export type Admission = { accepted: true } | { accepted: false; status: number; error: string };
export type MaintenanceProof =
  | { ok: true; state: 'maintenance' | 'off'; enforcement: 'database' | 'hook' | 'stopped'; botConfirmed: boolean }
  | { ok: false; error: string };

export const MESSAGE_MAX = 1500;
export const MAINTENANCE_TIMING = {
  hookMs: 30_000,
  hookWaitMs: 120_000,
  hookWaitTryMs: 10_000,
  hookWaitPauseMs: 2_000,
  sessionPauseMs: 1_000,
  reconcileMs: 30_000,
};

const OP = 'maintenance';
const STATES: BotRunState[] = ['running', 'maintenance', 'off'];
const NAME: Record<BotRunState, string> = { running: 'Running', maintenance: 'Maintenance', off: 'Off' };

const R1 = 'State must be running, maintenance or off';
const R2 = `The maintenance message is longer than ${MESSAGE_MAX} characters`;
const R7 = 'This app declares no lifecycle hooks, so the manager cannot put it into maintenance; Off stops it';
const R8 = "The env store for this instance cannot be read, so the manager can't tell which database the bot uses; nothing was changed";
const R9 = 'The bot is stopped, and it enters maintenance only through its own answer. Start it, then choose Maintenance; nothing was changed';
const R10 = 'The bot did not confirm it saved maintenance before it was turned off, so starting it would run its modules until it answers. Choose Running, then Maintenance; nothing was changed';
const R11 = 'Docker did not say whether the bot is running, so nothing was changed; retry in a moment';
const R12 = (err: string) => `The state change was not recorded, so nothing was changed: ${err}`;
const R13 = (file: string) => `A restore of ${file} has not finished cleanly (its notice is on the Database window), so Running was refused and nothing was changed; restore a dump again, or dismiss the notice to choose Running anyway`;
const R13_FENCE = (f: FenceFound): string => {
  const w = fenceWords(f);
  const state = w.owned ? `The bot's database is READ-ONLY under ${w.state}, so` : `The bot's database is READ-ONLY, and ${w.state}.`;
  return `${state} Running was refused and nothing was changed${w.remedy ? `; ${w.remedy}` : ''}`;
};

/** The read-only layer as a read found it; owner and persisted are unknown when the read failed or said off. */
type FenceFound = { owner?: string | null; persisted?: boolean | null };

/** The layer as the operator reads it: whose it is, and the remedy its owner gives (null when no known step lifts it). */
function fenceWords(f: FenceFound): { owned: boolean; state: string; remedy: string | null; retry: string | null } {
  const lane = fenceOwnerLane(f.owner ?? null);
  const remedy = f.persisted === false ? "its read-only setting is not saved in the database's configuration, so restarting the instance clears it"
    : lane === 'restore' ? 'with the bot in Maintenance or Off, run a restore again to lift the fence'
    : lane === 'reseed' ? 'retrying the re-seed retries the lift'
    : lane === 'decommission' ? 'running the decommission again retries the lift'
    : null;
  const retry = f.persisted === false ? 'Restart the instance'
    : lane === 'restore' ? 'With the bot in Maintenance or Off, run a restore again to lift the fence'
    : lane === 'reseed' ? 'Retry the re-seed'
    : lane === 'decommission' ? 'Run the decommission again'
    : null;
  if (!lane) return { owned: false, state: 'this manager cannot tell which step left it so', remedy, retry };
  return { owned: true, state: `a write fence of ${fenceOwnerText(f.owner ?? null)}`, remedy, retry };
}
const busyText = (op: string) => `Operation '${op}' already in progress`;
const unexpectedText = (err: string) => `The order stopped on an unexpected error: ${err}`;

const D_LOGIN = "The bot's database login is blocked, but its state is Running, so every process of this bot answers with the maintenance message. Choose Running in State to restore the login.";
const D_OFF = 'The state is Off, but the bot runs (it was started outside the manager). Choose Off in State to stop it, or Running.';

const COPY_TAIL = " Its database login is not blocked from here: this machine holds a live copy, and only the main's manager can block it.";
const EXTERNAL_TAIL = ' Its database login is not blocked: the database is not run by this manager.';
const RECOVERY_BLOCK = "the database is a live copy in recovery, so its login cannot be blocked on this machine; block it from the main's manager";
const RECOVERY_OPEN = 'the database is a live copy in recovery';
const FENCED = 'the database is READ-ONLY under a write fence';
const NOT_RECORDED = (err: string) => ` The manager could not record this (${err}); the record still holds the order as not confirmed, so the manager runs it again within 30 seconds, except that a retry never starts the bot or its database.`;
const RETRY_DB_DOWN = 'the database is not running, and a retry does not start it';
const RETRY_DB_UNKNOWN = 'docker did not say whether the database runs, and a retry does not start it';
const RETRY_NO_START = 'the bot is stopped, and a retry does not start it';

const H_TRUE = ' It restarts itself once it has saved what it holds (a change the database refuses for its content is dropped at that restart), then loads its data again.';
const H_FALSE = ' It answered that it does not restart (it was not in maintenance by its own record, or no bot process runs). If a restore ran while it was in maintenance, restart the bot so it loads the restored data.';
const H_NULL = " Whether it restarts is not confirmed (it answered that it can't confirm, or did not say). If a restore ran while it was in maintenance, restart the bot so it loads the restored data.";

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function maintenanceOf(inst: InstanceConfig): MaintenanceRecord {
  return inst.maintenance ?? { state: 'running', message: '', orderedAt: inst.createdAt, settled: true, hook: 'none', login: 'not-managed', savedByBot: null };
}

function hasHooks(inst: InstanceConfig): boolean {
  return !!findAppCapabilities(inst.sourceUrl)?.hooks;
}

function postgresBackend(inst: InstanceConfig, env: Record<string, string>): boolean {
  const companion = findAppCapabilities(inst.sourceUrl)?.companionDb;
  if (!companion) return false;
  const mode = companion.env.mode;
  return mode ? (env[mode.key] || '').trim().toLowerCase() === mode.value : true;
}

/** ensureFleetDataBackend's managed test, without its side effects. */
function managedMain(inst: InstanceConfig, url: string): boolean {
  const db = inst.fleetDb;
  if (!db || db.retiringAt) return false;
  if (url.trim() === '') return true;
  let host: string;
  try { host = new URL(url.trim()).hostname; } catch { return false; }
  const publicHost = db.replication?.publicHost;
  return host === db.containerName || (!!publicHost && host === publicHost);
}

export function maintenanceKind(inst: InstanceConfig, env: Record<string, string>): MaintenanceKind {
  const caps = findAppCapabilities(inst.sourceUrl);
  const postgres = postgresBackend(inst, env);
  if (postgres && caps?.companionDb && managedMain(inst, env[caps.companionDb.env.url] || '')) return 'database';
  if (!caps?.hooks) return 'none';
  if (!postgres) return 'json';
  return inst.fleetDbReplica ? 'copy' : 'external';
}

/** The kind from the merged env (record under the store), or R8 when the store or its URL key cannot be read. */
export function readKind(inst: InstanceConfig): { kind: MaintenanceKind } | { error: string } {
  const urlKey = findAppCapabilities(inst.sourceUrl)?.companionDb?.env.url;
  let status: ReturnType<typeof envManager.getEnvVarsWithStatus>;
  try { status = envManager.getEnvVarsWithStatus(inst.id); } catch { return { error: R8 }; }
  if (status.corrupt || (urlKey && status.undecryptable.includes(urlKey))) return { error: R8 };
  const env: Record<string, string> = { ...(inst.envVars || {}), ...status.vars };
  for (const key of status.undecryptable) env[key] = '';
  return { kind: maintenanceKind(inst, env) };
}

export function orderPlan(p: { kind: MaintenanceKind; to: BotRunState; fromOff: boolean; app: boolean; savedByBot: 'running' | 'maintenance' | null; hooks: boolean }):
  { steps: PlanStep[] } | { refusal: 'R7' | 'R9' | 'R10' } {
  const { kind, to, app } = p;
  const fromOff = p.fromOff && !app;
  if (kind === 'database') {
    let steps: PlanStep[];
    if (to === 'maintenance') {
      steps = app ? ['hook', 'db-up', 'block', 'end-sessions']
        : fromOff ? ['db-up', 'block', 'end-sessions', 'start', 'hook-wait'] : ['db-up', 'block', 'end-sessions'];
    } else if (to === 'off') {
      steps = [...(app ? ['hook' as const] : []), 'db-up', 'block', 'end-sessions', ...(app ? ['stop' as const] : []), 'db-up-alone'];
    } else {
      steps = ['db-up', 'open', ...(app ? ['hook'] as PlanStep[] : fromOff ? ['start', 'hook-wait'] as PlanStep[] : [])];
    }
    return { steps: p.hooks ? steps : steps.filter(s => s !== 'hook' && s !== 'hook-wait') };
  }
  if (kind === 'none') {
    if (to === 'maintenance') return { refusal: 'R7' };
    if (to === 'off') return { steps: app ? ['stop'] : [] };
    return { steps: fromOff ? ['start'] : [] };
  }
  if (to === 'maintenance') {
    if (app) return { steps: ['hook'] };
    if (fromOff) return p.savedByBot === 'maintenance' ? { steps: ['start', 'hook-wait'] } : { refusal: 'R10' };
    return { refusal: 'R9' };
  }
  if (to === 'off') return { steps: app ? ['hook', 'stop'] : [] };
  return { steps: app ? ['hook'] : fromOff ? ['start', 'hook-wait'] : [] };
}

/** Whether every step the order needs is confirmed. An app docker could not answer for is never the safe value. */
export function settledVerdict(p: { kind: MaintenanceKind; to: BotRunState; hook: MaintenanceRecord['hook']; login: MaintenanceRecord['login']; app: boolean | null; startOwed: boolean; hooks: boolean }): boolean {
  const runs = p.app === true;
  const stopped = p.app === false;
  const hookOk = !p.hooks || p.hook === 'confirmed' || p.hook === 'missing';
  if (p.kind === 'none') {
    if (p.to === 'maintenance') return false;
    if (p.to === 'off') return stopped;
    return !p.startOwed || runs;
  }
  if (p.to === 'off') return (p.kind !== 'database' || p.login === 'blocked') && stopped;
  if (p.to === 'maintenance') {
    if (p.kind !== 'database') return p.hook === 'confirmed';
    return p.login === 'blocked' && (!p.startOwed || runs);
  }
  if (p.kind === 'database' && p.login !== 'open') return false;
  return p.startOwed ? runs && hookOk : stopped || hookOk;
}

type HookOutcome =
  | { hook: 'confirmed'; restarting?: boolean | null }
  | { hook: 'missing' }
  | { hook: 'unconfirmed'; why: 'unknown' | 'unreachable' | 'refused'; reason: string; detail: string };

/** The bot's answer to 'running' says whether it restarts its process (contract 1); anything but a boolean reads as null. */
function hookOutcome(r: AppHookResult, state?: 'running' | 'maintenance'): HookOutcome {
  if (r.ok) {
    if (state !== 'running') return { hook: 'confirmed' };
    const restarting = r.body?.restarting;
    return { hook: 'confirmed', restarting: typeof restarting === 'boolean' ? restarting : null };
  }
  if (r.status === 404) return { hook: 'missing' };
  const detail = r.error || 'no reason given';
  if (r.unknown) return { hook: 'unconfirmed', why: 'unknown', reason: 'no answer within 30 seconds', detail };
  if (r.status !== undefined) return { hook: 'unconfirmed', why: 'refused', reason: `the bot answered: ${detail}`, detail };
  return { hook: 'unconfirmed', why: 'unreachable', reason: `the bot could not be reached: ${detail}`, detail };
}

function sendHook(inst: InstanceConfig, state: 'running' | 'maintenance', message: string, timeoutMs = MAINTENANCE_TIMING.hookMs): Promise<AppHookResult> {
  return callAppHook(inst, 'maintenance', 'POST', { state, message }, timeoutMs);
}

const hookState = (to: BotRunState): 'running' | 'maintenance' => (to === 'running' ? 'running' : 'maintenance');
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitForHook(inst: InstanceConfig, to: BotRunState, message: string): Promise<HookOutcome> {
  const deadline = Date.now() + MAINTENANCE_TIMING.hookWaitMs;
  for (;;) {
    const outcome = hookOutcome(await sendHook(inst, hookState(to), message, MAINTENANCE_TIMING.hookWaitTryMs), hookState(to));
    if (outcome.hook !== 'unconfirmed') return outcome;
    if (Date.now() >= deadline) {
      const seconds = Math.round(MAINTENANCE_TIMING.hookWaitMs / 1000);
      return outcome.why === 'unknown' ? { ...outcome, reason: `no answer within ${seconds} seconds of the start` } : outcome;
    }
    await pause(MAINTENANCE_TIMING.hookWaitPauseMs);
  }
}

interface Outcome {
  kind: MaintenanceKind;
  to: BotRunState;
  hooks: boolean;
  hook?: HookOutcome;
  started: boolean;
  blockLanded: boolean;
  startOwed?: boolean;
  planRefused?: 'R7' | 'R9' | 'R10';
  dbDownAfterStop?: boolean;
  dbFail?: string;
  fence?: FenceFound;
  startFail?: string;
  stopFail?: string;
  dbUpAloneFail?: string;
  app: boolean | null;
  settled: boolean;
  savedByBot: MaintenanceRecord['savedByBot'];
}

function hookClause(h: HookOutcome | undefined): string {
  if (!h) return '';
  if (h.hook === 'confirmed') return 'The bot took the message. ';
  if (h.hook === 'missing') return 'The bot did not take the message (its build has no maintenance hook). ';
  return `The bot did not take the message (${h.reason}). `;
}

/** The operator text of a finished order, and the reason it stores as lastError (undefined = none). */
function orderText(o: Outcome): { text: string; reason?: string } {
  const db = o.kind === 'database';
  const h = o.hook;
  const hookReason = h?.hook === 'unconfirmed' ? h.reason : h?.hook === 'missing' ? "its build has no maintenance hook" : undefined;
  if (o.to === 'maintenance') {
    if (db) {
      if (o.dbFail) return { text: `Maintenance is not confirmed: ${o.dbFail}. ${hookClause(h)}Choose Maintenance again to retry.`, reason: o.dbFail };
      if (o.startOwed) {
        return { text: `Maintenance is not confirmed: ${RETRY_NO_START}.${o.blockLanded ? ' Its database login is blocked, so it cannot write.' : ''} Choose Maintenance again to start it.`, reason: RETRY_NO_START };
      }
      if (o.startFail || !o.settled) {
        const e = o.startFail ?? 'it was not running after the start';
        return { text: `Maintenance is not confirmed: the bot did not start (${e}). Its database login is blocked, so it cannot write. Choose Maintenance again to retry.`, reason: `the bot did not start (${e})` };
      }
      if (!o.hooks) return { text: "Maintenance is on: the bot's database login is blocked with no session open." };
      if (!h) {
        return { text: o.app === true ? "Maintenance is on: the bot's database login is blocked with no session open." : "Maintenance is on: the bot's database login is blocked. The bot is stopped; it takes the message when it next runs." };
      }
      if (h.hook === 'confirmed') {
        return { text: o.started ? 'Maintenance is on: the bot started and took the message, and its database login is blocked with no session open.' : 'Maintenance is on: the bot took the message, and its database login is blocked with no session open.' };
      }
      if (h.hook === 'missing') return { text: "Maintenance is on: the bot's database login is blocked with no session open. This bot's build has no maintenance hook (it answered 404), so it cannot show the message; update the bot to a build that has one.", reason: `the bot did not take the message (${hookReason})` };
      return { text: `Maintenance is on: the bot's database login is blocked with no session open. The bot did not take the message (${h.reason}), so it answers with the last message it saved or its default text; the manager sends the message again every 30 seconds while the bot runs.`, reason: `the bot did not take the message (${h.reason})` };
    }
    if (h?.hook === 'missing') {
      const noBlock = o.kind === 'json' ? 'the bot keeps its data in files' : 'its database login cannot be blocked from this manager';
      return { text: `Maintenance is not on: this bot's build has no maintenance hook (it answered 404), and ${noBlock}, so nothing can hold it in maintenance, and the manager does not send the order again. Choose Running or Off.`, reason: 'its build has no maintenance hook' };
    }
    if (o.startOwed) return { text: `Maintenance is not confirmed: ${RETRY_NO_START}. Choose Maintenance again to start it.`, reason: RETRY_NO_START };
    if (o.planRefused === 'R7') {
      return { text: "Maintenance is not on: the bot's setup changed, and it now has no maintenance hook and no database login this manager can block, so nothing can hold it in maintenance. Choose Off to stop it, or Running.", reason: 'the bot\'s setup no longer allows maintenance' };
    }
    if (o.planRefused) return { text: 'Maintenance is not on: the bot is stopped, so it did not get the order. Start it, then choose Maintenance again.', reason: 'the bot is stopped, so it did not get the order' };
    if (o.startFail) return { text: `Maintenance is not confirmed: the bot did not start (${o.startFail}). Choose Maintenance again to retry.`, reason: `the bot did not start (${o.startFail})` };
    const tail = o.kind === 'copy' ? COPY_TAIL : o.kind === 'external' ? EXTERNAL_TAIL : '';
    if (h?.hook === 'confirmed' || !h && o.settled) return { text: `${o.started ? 'Maintenance is on: the bot started and took the message.' : 'Maintenance is on: the bot took the message.'}${tail}` };
    if (h?.hook === 'unconfirmed' && h.why === 'unknown') {
      return { text: "Maintenance can't be confirmed: the order reached the bot's address, but no answer came within 30 seconds, so the bot may or may not be in maintenance. The manager sends it again every 30 seconds.", reason: h.reason };
    }
    if (h?.hook === 'unconfirmed' && h.why === 'refused') {
      return { text: `Maintenance is not on yet: the bot refused the order (${h.detail}). The manager sends the order again every 30 seconds while the bot runs.`, reason: `the bot refused the order (${h.detail})` };
    }
    const detail = h?.hook === 'unconfirmed' ? h.detail : 'it did not answer';
    return { text: `Maintenance is not on yet: the bot could not be reached (${detail}). The manager sends the order again every 30 seconds while the bot runs.`, reason: `the bot could not be reached (${detail})` };
  }
  if (o.to === 'off') {
    if (o.stopFail || !o.settled && !o.dbFail) {
      const e = o.stopFail ?? 'the bot still runs after the stop';
      const blocked = db && o.blockLanded ? " The bot's database login is blocked, so it cannot write." : '';
      return { text: `Off is not confirmed: the stop failed (${e}).${blocked} Choose Off again to retry.`, reason: `the stop failed (${e})` };
    }
    if (db) {
      if (o.dbFail) return { text: `The bot is stopped, but Off is not confirmed: ${o.dbFail}, so any other process of this bot can still log in to the database. Choose Off again to retry.`, reason: o.dbFail };
      if (o.dbDownAfterStop) {
        return { text: 'The bot is off: it is stopped, and its database login is blocked. Its database is not running, so backups and copies wait until it runs; choose Off again to start it.', reason: 'the database is not running after the stop' };
      }
      if (o.dbUpAloneFail) {
        return { text: `The bot is off: it is stopped, and its database login is blocked. The database did not start again after the stop (${o.dbUpAloneFail}), so backups and copies wait until it runs; choose Off again to retry.`, reason: `the database did not start again after the stop (${o.dbUpAloneFail})` };
      }
      return { text: "The bot is off: it is stopped, and its database keeps running for backups and copies with the bot's login blocked." };
    }
    if (h && h.hook !== 'confirmed' && o.savedByBot !== 'maintenance') {
      return { text: `The bot is off: it is stopped. It did not confirm it saved maintenance before it stopped (${hookReason}), so Maintenance from Off is refused for it until it runs again.`, reason: `the bot did not confirm it saved maintenance (${hookReason})` };
    }
    return { text: 'The bot is off: it is stopped.' };
  }
  if (db && o.dbFail === FENCED) {
    const w = fenceWords(o.fence ?? {});
    const state = w.owned ? `the bot's database is READ-ONLY under ${w.state}, so its login could not be restored` : `the bot's login could not be restored, because its database is READ-ONLY and ${w.state}`;
    const next = w.retry ? `${w.retry}, then choose Running.` : 'Choose Running again once the database is writable.';
    return { text: `Running is not confirmed: ${state}. ${next}`, reason: FENCED };
  }
  if (db && o.dbFail) {
    return { text: `Running is not confirmed: the bot's database login could not be restored (${o.dbFail}). The bot answers with the maintenance message until it is. Choose Running again to retry.`, reason: `the bot's database login could not be restored (${o.dbFail})` };
  }
  if (o.startOwed) return { text: `Running is not confirmed: ${RETRY_NO_START}.${db ? ' Its database login is restored.' : ''} Choose Running again to start it.`, reason: RETRY_NO_START };
  if (o.startFail || !o.settled && o.app !== true) {
    const e = o.startFail ?? 'it was not running after the start';
    return { text: `Running is not confirmed: the bot did not start (${e}).${db ? ' Its database login is restored.' : ''} Start it, or choose Running again.`, reason: `the bot did not start (${e})` };
  }
  if (!o.settled) {
    const reason = hookReason ?? 'it did not answer';
    return { text: `Running is not confirmed:${db ? ' its database login is restored, but' : ''} the bot did not confirm it left maintenance (${reason}); it keeps answering with the maintenance message until it does. The manager sends the order again every 30 seconds while the bot runs.`, reason: `the bot did not confirm it left maintenance (${reason})` };
  }
  if (o.app !== true && !o.started) {
    if (!o.hooks) return { text: `The state is Running${db ? ", and the bot's database login is restored" : ''}. The bot is stopped.` };
    return { text: `The state is Running${db ? ", and the bot's database login is restored" : ''}. The bot is stopped, so it takes the order when it next runs.` };
  }
  if (h?.hook === 'missing') return { text: `The bot is running normally${db ? ': its database login is restored' : ''}. Its build has no maintenance hook, so it was never in maintenance.` };
  if (h?.hook === 'confirmed') {
    const restart = h.restarting === true ? H_TRUE : h.restarting === false ? H_FALSE : H_NULL;
    if (o.started) return { text: `The bot is running normally: it started${db ? ', its database login is restored,' : ''} and it took the order to leave maintenance.${restart}` };
    return { text: `${db ? 'The bot is running normally: its database login is restored, and it took the order to leave maintenance.' : 'The bot is running normally: it took the order to leave maintenance.'}${restart}` };
  }
  if (o.started) return { text: db ? 'The bot is running normally: it started, and its database login is restored.' : 'The bot is running normally: it started.' };
  return { text: db ? 'The bot is running normally: its database login is restored.' : 'The bot is running normally.' };
}

type CoreResult = { refused: true; status: number; error: string } | { refused: false; result: OrderResult; notify: boolean };
type Mode = 'order' | 'resumed' | 'retry';

const refuse = (status: number, error: string): CoreResult => ({ refused: true, status, error });

/**
 * One order under the op lock. 'order' records the intent first; 'resumed' (the first reconciler pass) runs a cut
 * order again in full; 'retry' (later passes) runs its remaining steps but never a start of the bot or its database.
 * Both take the order from the record read under the lock, and do nothing once it is settled.
 */
async function runCore(botId: string, ordered: BotRunState, orderedMessage: string, mode: Mode, onAdmit: () => void = () => {}): Promise<CoreResult> {
  const inst = containerManager.getBot(botId);
  if (!inst) return refuse(404, 'Bot not found');
  const before = inst.maintenance ?? null;
  const current = maintenanceOf(inst);
  if (mode !== 'order' && current.settled) {
    return { refused: false, result: { settled: true, text: `${NAME[current.state]} is already confirmed; nothing ran again.` }, notify: false };
  }
  const to = mode === 'order' ? ordered : current.state;
  const message = mode === 'order' ? orderedMessage : current.message;
  if (containerManager.isShuttingDown()) return refuse(503, containerManager.SHUTDOWN_REFUSAL);
  const hold = containerManager.databaseHoldRefusal(botId, 'the state change');
  if (hold) return refuse(409, hold.error);
  const deleting = containerManager.deleteLaneRefusal(botId, 'a state change');
  if (deleting) return refuse(409, deleting.error);
  if (mode === 'order' && to === 'running' && inst.fleetDb && inst.fleetRestoreError) return refuse(409, R13(fleetBackup.shownRestoreNoticeFile(botId) ?? inst.fleetRestoreError.file));
  const kindRead = readKind(inst);
  if ('error' in kindRead) return refuse(409, kindRead.error);
  const kind = kindRead.kind;
  const hooks = hasHooks(inst);
  let target: dbLogin.DbTarget | null = null;
  if (kind === 'database') {
    const roleRefusal = dbLogin.botRoleRefusal(inst.fleetDb!.user);
    if (roleRefusal) return refuse(409, roleRefusal);
    target = { container: inst.fleetDb!.containerName, user: inst.fleetDb!.user };
    if (mode === 'order' && to === 'running') {
      const fence = await dbLogin.readWriteFence(target);
      if (fence.ok && fence.on) return refuse(409, R13_FENCE(fence));
    }
  }
  const app = await containerManager.appContainerRunning(botId);
  if (app === null) return refuse(409, R11);

  const fromOff = current.state === 'off' || (!current.settled && current.prior?.state === 'off');
  const planned = orderPlan({ kind, to, fromOff, app, savedByBot: current.savedByBot, hooks });
  if ('refusal' in planned && mode === 'order') return refuse(409, planned.refusal === 'R7' ? R7 : planned.refusal === 'R9' ? R9 : R10);
  const fullPlan = 'steps' in planned ? planned.steps : [];
  const startOwed = fullPlan.includes('start');
  let steps = fullPlan;
  let retryDbFail: string | undefined;
  if (mode === 'retry') {
    const sidecar = target ? await dbLogin.sidecarRunning(target.container) : null;
    const dbSteps = (s: PlanStep) => s === 'block' || s === 'end-sessions' || s === 'open';
    if (target && sidecar !== true && fullPlan.some(dbSteps)) retryDbFail = sidecar === false ? RETRY_DB_DOWN : RETRY_DB_UNKNOWN;
    steps = fullPlan.filter(s => (s === 'hook' ? current.hook === 'unconfirmed' : s === 'stop' || dbSteps(s) && sidecar === true));
  } else if (mode === 'resumed' && current.hook === 'missing') {
    steps = fullPlan.filter(s => s !== 'hook' && s !== 'hook-wait');
  }

  let rec: MaintenanceRecord;
  if (mode === 'order') {
    const prior = before ? (current.settled ? { state: current.state, message: current.message } : current.prior) : undefined;
    rec = {
      state: to, message, orderedAt: new Date().toISOString(), settled: false,
      hook: hooks ? 'unconfirmed' : 'none', login: kind === 'database' ? 'unconfirmed' : 'not-managed',
      savedByBot: current.savedByBot, ...(prior ? { prior } : {}),
    };
    try {
      containerManager.updateInstanceMaintenance(botId, rec);
    } catch (err) {
      return refuse(500, R12(errText(err)));
    }
  } else {
    rec = { ...current, settled: false };
    if (kind === 'database' && mode === 'resumed') rec.login = 'unconfirmed';
  }
  onAdmit();

  let notRecorded: string | undefined;
  const save = (r: MaintenanceRecord | null): boolean => {
    try {
      containerManager.updateInstanceMaintenance(botId, r);
      return true;
    } catch (err) {
      notRecorded = errText(err);
      return false;
    }
  };

  const o: Outcome = { kind, to, hooks, started: false, blockLanded: false, app, settled: false, savedByBot: rec.savedByBot, dbFail: retryDbFail };
  if (mode === 'retry') {
    o.startOwed = startOwed;
    if ('refusal' in planned) o.planRefused = planned.refusal;
  }
  if (mode !== 'order' && current.hook === 'missing') o.hook = { hook: 'missing' };
  let roleReady = false;
  const ensureRole = async (): Promise<boolean> => {
    if (roleReady) return true;
    const role = await dbLogin.ensureManagerDbRole(target!);
    if (!role.ok) { o.dbFail = `the manager's database role ${dbLogin.MANAGER_DB_ROLE} could not be created (${role.error})`; return false; }
    roleReady = true;
    return true;
  };
  const recordHook = (h: HookOutcome) => {
    o.hook = h;
    rec.hook = h.hook;
    if (h.hook === 'confirmed') rec.savedByBot = hookState(to);
    o.savedByBot = rec.savedByBot;
  };
  let dbTouched = false;
  let opened = false;
  let stopped = false;

  for (const step of steps) {
    if (step === 'hook') {
      if (to === 'running' && kind === 'database' && !opened) continue;
      recordHook(hookOutcome(await sendHook(inst, hookState(to), message), hookState(to)));
      if (!save(rec)) break;
    } else if (step === 'hook-wait') {
      if (o.dbFail || !o.started) continue;
      recordHook(await waitForHook(inst, to, message));
      if (!save(rec)) break;
    } else if (step === 'db-up') {
      dbTouched = true;
      if (await dbLogin.sidecarRunning(target!.container) !== true) {
        const up = await containerManager.startFleetDbSidecar(botId);
        if (!up.success) { o.dbFail = `the database did not start (${up.error})`; continue; }
      }
      await ensureRole();
    } else if (step === 'block' || step === 'end-sessions' || step === 'open') {
      dbTouched = true;
      if (o.dbFail || !await ensureRole()) continue;
      if (step === 'block') {
        const r = await dbLogin.blockBotLogin(target!);
        if (r.ok) o.blockLanded = true;
        else o.dbFail = r.cls === 'recovery' ? RECOVERY_BLOCK : r.cls === 'write-fence' ? FENCED : `the database login could not be blocked (${r.error})`;
      } else if (step === 'end-sessions') {
        const r = await dbLogin.endBotSessions(target!, MAINTENANCE_TIMING.sessionPauseMs);
        if (!r.ok) o.dbFail = 'left' in r && r.left !== undefined
          ? `${r.left} session(s) of the bot's database role were still open after three attempts to end them`
          : `the manager can't confirm the login is blocked: ${r.error}`;
      } else {
        const r = await dbLogin.openBotLogin(target!);
        if (r.ok) opened = true;
        else o.dbFail = r.cls === 'recovery' ? RECOVERY_OPEN : r.cls === 'write-fence' ? FENCED : r.error;
        if (!r.ok && r.cls === 'write-fence') {
          const fence = await dbLogin.readWriteFence(target!);
          o.fence = fence.ok && fence.on ? fence : {};
        }
      }
    } else if (step === 'stop') {
      stopped = true;
      const r = await containerManager.stopBotInOp(botId, OP);
      if (!r.success && r.error !== 'Bot is not running') o.stopFail = r.error || 'no reason given';
    } else if (step === 'db-up-alone') {
      if (await dbLogin.sidecarRunning(target!.container) === true) continue;
      const r = await containerManager.startFleetDbSidecar(botId);
      if (!r.success) o.dbUpAloneFail = r.error || 'no reason given';
    } else if (step === 'start') {
      if (o.dbFail) continue;
      const r = await containerManager.startBotInOp(botId, OP);
      if (r.success || r.error === 'Bot is already running') o.started = true;
      else o.startFail = r.error || 'no reason given';
    }
  }
  if (mode === 'retry' && stopped && fullPlan.includes('db-up-alone') && await dbLogin.sidecarRunning(target!.container) !== true) o.dbDownAfterStop = true;

  const notify = (r: MaintenanceRecord) => mode !== 'retry' || r.settled || (r.lastError ?? null) !== (current.lastError ?? null);
  const unsaved = (text: string): CoreResult => {
    const changed = mode !== 'retry' || unsavedText.get(botId) !== text;
    unsavedText.set(botId, text);
    return { refused: false, result: { settled: false, text }, notify: changed };
  };
  if (!notRecorded) {
    if (kind === 'database' && (dbTouched || retryDbFail)) {
      if (o.dbFail) rec.login = 'unconfirmed';
      else {
        const read = await dbLogin.readBotLogin(target!);
        if (!read.ok) {
          o.dbFail = to === 'running' ? `the manager can't confirm the login is open: ${read.error}` : `the manager can't confirm the login is blocked: ${read.error}`;
          rec.login = 'unconfirmed';
        } else if (to === 'running') {
          if (read.login.canLogin === true) rec.login = 'open';
          else { o.dbFail = 'the login read back as blocked after it was restored'; rec.login = 'unconfirmed'; }
        } else if (read.login.canLogin === false && !read.login.inRecovery) rec.login = 'blocked';
        else { o.dbFail = 'the login read back as open after it was blocked'; rec.login = 'unconfirmed'; }
      }
    }
    o.app = await containerManager.appContainerRunning(botId);
    o.settled = settledVerdict({ kind, to, hook: rec.hook, login: rec.login, app: o.app, startOwed, hooks });
    const { text, reason } = orderText(o);
    rec.settled = o.settled;
    if (reason) rec.lastError = reason;
    else delete rec.lastError;
    if (save(rec)) {
      drift.delete(botId);
      unsavedText.delete(botId);
      return { refused: false, result: { settled: o.settled, text }, notify: notify(rec) };
    }
    return unsaved(text + NOT_RECORDED(notRecorded!));
  }
  return unsaved(`${NAME[to]} is not confirmed.${NOT_RECORDED(notRecorded)}`);
}

async function runLockedCore(botId: string, to: BotRunState, message: string, mode: Mode, onAdmit?: () => void): Promise<CoreResult> {
  try {
    return await runCore(botId, to, message, mode, onAdmit);
  } catch (err) {
    const text = unexpectedText(errText(err));
    try {
      const inst = containerManager.getBot(botId);
      if (inst?.maintenance) containerManager.updateInstanceMaintenance(botId, { ...inst.maintenance, settled: false, lastError: text });
    } catch (writeErr) {
      console.error(`[Maintenance] ${botId}: the unexpected error could not be recorded: ${errText(writeErr)}`);
    }
    throw err;
  }
}

/** Runs an order under the bot's op lock and answers its result; a refusal answers its text, unsettled. */
export async function runMaintenanceOrder(botId: string, to: BotRunState, message: string, opts: { resumed?: boolean; retry?: boolean } = {}): Promise<OrderResult> {
  const busy = containerManager.isBotBusy(botId);
  if (busy) return { settled: false, text: busyText(busy) };
  const mode: Mode = opts.retry ? 'retry' : opts.resumed ? 'resumed' : 'order';
  const core = await containerManager.withExternalBotOp(botId, OP, () => runLockedCore(botId, to, message, mode));
  return core.refused ? { settled: false, text: core.error } : core.result;
}

/** The route entry: answers once the order is refused or recorded; onDone gets the result of an accepted order. */
export async function orderMaintenance(botId: string, to: BotRunState, message: string, onDone: (result: OrderResult) => void): Promise<Admission> {
  if (!STATES.includes(to)) return { accepted: false, status: 400, error: R1 };
  if (message.length > MESSAGE_MAX) return { accepted: false, status: 400, error: R2 };
  if (!containerManager.getBot(botId)) return { accepted: false, status: 404, error: 'Bot not found' };
  const busy = containerManager.isBotBusy(botId);
  if (busy) return { accepted: false, status: 409, error: busyText(busy) };
  let admit!: (a: Admission) => void;
  const admitted = new Promise<Admission>(resolve => { admit = resolve; });
  let accepted = false;
  containerManager.withExternalBotOp(botId, OP, () => runLockedCore(botId, to, message, 'order', () => { accepted = true; admit({ accepted: true }); }))
    .then(core => {
      if (core.refused) admit({ accepted: false, status: core.status, error: core.error });
      else onDone(core.result);
    })
    .catch(err => {
      if (!accepted) {
        const op = containerManager.isBotBusy(botId);
        admit(op && op !== OP ? { accepted: false, status: 409, error: busyText(op) } : { accepted: false, status: 500, error: unexpectedText(errText(err)) });
      } else {
        onDone({ settled: false, text: unexpectedText(errText(err)) });
      }
    });
  return admitted;
}

/**
 * The durable answer to "is this bot in maintenance" for a lane that holds the bot's op lock under its own op name
 * from this call to its last step.
 */
export async function requireMaintenance(botId: string, need: 'database' | 'any'): Promise<MaintenanceProof> {
  const op = containerManager.isBotBusy(botId);
  if (!op || op === OP) return { ok: false, error: 'The maintenance check ran outside an operation on this bot, so its answer could not hold; nothing was changed' };
  const inst = containerManager.getBot(botId);
  if (!inst) return { ok: false, error: 'Bot not found' };
  const rec = maintenanceOf(inst);
  if (rec.state === 'running') return { ok: false, error: 'This bot is not in maintenance; put it into Maintenance or Off first' };
  if (!rec.settled) return { ok: false, error: `The bot's change to ${NAME[rec.state]} is not confirmed yet (${rec.lastError || 'the order has not finished'}), so it does not count as maintenance` };
  const kindRead = readKind(inst);
  if ('error' in kindRead) return { ok: false, error: kindRead.error };
  const kind = kindRead.kind;
  const state = rec.state;
  if (kind === 'database') {
    const target = { container: inst.fleetDb!.containerName, user: inst.fleetDb!.user };
    const read = await dbLogin.readBotLogin(target);
    if (!read.ok) return { ok: false, error: `The manager can't confirm the bot's database login is blocked: ${read.error}` };
    if (read.login.inRecovery) return { ok: false, error: "The database is a live copy in recovery, so it is not this bot's main database" };
    if (read.login.canLogin === null) return { ok: false, error: `The manager can't confirm the bot's database login is blocked: the role ${target.user} does not exist` };
    if (read.login.canLogin) return { ok: false, error: `The bot's database login is open although the state is ${NAME[state]}; the manager blocks it again within 30 seconds, then retry` };
    if (read.login.sessions > 0) return { ok: false, error: `${read.login.sessions} session(s) of the bot's database role are open although its login is blocked; retry in a moment` };
    return { ok: true, state, enforcement: 'database', botConfirmed: rec.hook === 'confirmed' };
  }
  if (need === 'database') {
    if (kind === 'copy') return { ok: false, error: "This machine holds a live copy, so this manager cannot confirm the bot's database login is blocked" };
    if (kind === 'external' || kind === 'none' && postgresBackendOf(inst)) return { ok: false, error: "The bot's database is not run by this manager, so this manager cannot confirm its login is blocked" };
    return { ok: false, error: 'This bot keeps its data in files, so the manager cannot hold its database in maintenance' };
  }
  if (kind === 'none') return { ok: false, error: 'This bot has no database this manager blocks, so maintenance is not enforced on its data and the operation cannot run; nothing was changed' };
  if (kind !== 'json') return { ok: false, error: "This manager does not block this bot's database login, so its database does not enforce maintenance and the operation cannot run; nothing was changed" };
  if (state === 'off') {
    const app = await containerManager.appContainerRunning(botId);
    if (app === null) return { ok: false, error: "Docker did not say whether the bot runs, so the manager can't confirm it is off" };
    if (app) return { ok: false, error: 'The state is Off, but the bot runs; choose Off again' };
    return { ok: true, state, enforcement: 'stopped', botConfirmed: rec.hook === 'confirmed' };
  }
  const h = hookOutcome(await sendHook(inst, 'maintenance', rec.message));
  if (h.hook !== 'confirmed') return { ok: false, error: `The bot did not confirm it is in maintenance (${h.hook === 'missing' ? 'its build has no maintenance hook' : h.reason})` };
  return { ok: true, state, enforcement: 'hook', botConfirmed: true };
}

function postgresBackendOf(inst: InstanceConfig): boolean {
  try {
    const { vars } = envManager.getEnvVarsWithStatus(inst.id);
    return postgresBackend(inst, { ...(inst.envVars || {}), ...vars });
  } catch {
    return false;
  }
}

// ─── The Database window's state line ───

type LiveLogin = { down: true } | { ok: false; error: string } | { ok: true; login: dbLogin.BotLogin };

export function maintenanceView(rec: MaintenanceRecord, kind: MaintenanceKind | null, driftText: string | null, live?: LiveLogin): string {
  const name = NAME[rec.state];
  if (driftText) return driftText;
  if (!rec.settled) return `State: ${name}, not confirmed: ${rec.lastError || 'the order has not finished'}`;
  if (rec.state === 'running') return 'State: Running.';
  if (kind === 'database') {
    if (!live || 'down' in live) return `State: ${name}. The database is not running, so its login cannot be read now; the block is stored in the database and holds when it starts.`;
    if (!live.ok) return `State: ${name}. The manager can't confirm the database login is blocked: ${live.error}.`;
    if (live.login.inRecovery) return `State: ${name}. The manager can't confirm the database login is blocked: the database is a live copy in recovery.`;
    if (live.login.canLogin === true) return `State: ${name}, but the bot's database login is open; the manager blocks it again within 30 seconds.`;
    if (live.login.canLogin === null) return `State: ${name}. The manager can't confirm the database login is blocked: the bot's database role does not exist.`;
    if (live.login.sessions > 0) return `State: ${name}. The manager can't confirm the database login is blocked: ${live.login.sessions} session(s) of the bot's role are still open.`;
    return rec.state === 'off'
      ? "State: Off. The bot is stopped, and its database login is blocked with none of its sessions open."
      : "State: Maintenance. The bot's database login is blocked and none of its sessions is open.";
  }
  if (rec.state === 'off') return 'State: Off. The bot is stopped.';
  return `State: Maintenance, through the bot's own answer.${kind === 'copy' ? COPY_TAIL : kind === 'external' ? EXTERNAL_TAIL : ''}`;
}

/** The GET answer: the record, the kind and the state line, with a live login read for a database bot. */
export async function maintenanceStatus(inst: InstanceConfig, driftText: string | null): Promise<{ state: BotRunState; message: string; settled: boolean; kind: MaintenanceKind | null; orderedAt: string; lastError: string | null; summary: string }> {
  const rec = maintenanceOf(inst);
  const kindRead = readKind(inst);
  const kind = 'kind' in kindRead ? kindRead.kind : null;
  let live: LiveLogin | undefined;
  if (kind === 'database' && rec.settled && rec.state !== 'running' && !driftText) {
    const target = { container: inst.fleetDb!.containerName, user: inst.fleetDb!.user };
    const up = await dbLogin.sidecarRunning(target.container);
    if (up === true) live = await dbLogin.readBotLogin(target);
    else if (up === false) live = { down: true };
    else live = { ok: false, error: 'docker did not say whether the database runs' };
  }
  return {
    state: rec.state, message: rec.message, settled: rec.settled, kind, orderedAt: rec.orderedAt,
    lastError: rec.lastError ?? null, summary: maintenanceView(rec, kind, driftText, live),
  };
}

// ─── The reconciler ───

const drift = new Map<string, string>();
const unsavedText = new Map<string, string>();
const loggedDrift = new Map<string, string>();
let reconcilerTimer: NodeJS.Timeout | null = null;
let passRunning = false;
let firstPassDone = false;
let listener: ((botId: string, result: OrderResult, notify: boolean) => void) | null = null;

export function getMaintenanceDrift(botId: string): string | null {
  return drift.get(botId) ?? null;
}

/**
 * Receives the result of each order the reconciler runs again; `notify` is false for a retry that did not settle and
 * whose error text did not change, so the routes update the bot without a new message.
 */
export function setMaintenanceListener(fn: ((botId: string, result: OrderResult, notify: boolean) => void) | null): void {
  listener = fn;
}

export function resetMaintenanceState(): void {
  drift.clear();
  unsavedText.clear();
  loggedDrift.clear();
  passRunning = false;
  firstPassDone = false;
  dbLogin.resetManagerRoleCache();
}

function setDrift(inst: InstanceConfig, text: string, log?: string): void {
  drift.set(inst.id, text);
  if (log && loggedDrift.get(inst.id) !== text) {
    loggedDrift.set(inst.id, text);
    console.warn(log);
  }
}

function clearDrift(botId: string): void {
  drift.delete(botId);
  loggedDrift.delete(botId);
}

function rerun(inst: InstanceConfig, rec: MaintenanceRecord, mode: 'resumed' | 'retry'): Promise<void> {
  return containerManager.withExternalBotOp(inst.id, OP, () => runLockedCore(inst.id, rec.state, rec.message, mode))
    .then(core => { if (!core.refused) listener?.(inst.id, core.result, core.notify); })
    .catch(err => console.error(`[Maintenance] ${inst.displayName}: running the order ${NAME[rec.state]} again failed: ${errText(err)}`));
}

async function reconcileBot(listed: InstanceConfig, first: boolean): Promise<void> {
  const inst = containerManager.getBot(listed.id);
  if (!inst) return;
  if (containerManager.isBotBusy(inst.id) || containerManager.databaseHoldRefusal(inst.id, 'the maintenance check')) return;
  const kindRead = readKind(inst);
  if ('error' in kindRead) return;
  const kind = kindRead.kind;
  const rec = maintenanceOf(inst);
  if (rec.state !== 'off' && drift.get(inst.id) === D_OFF) clearDrift(inst.id);
  let target: dbLogin.DbTarget | null = null;
  if (kind === 'database' && !dbLogin.botRoleRefusal(inst.fleetDb!.user)) target = { container: inst.fleetDb!.containerName, user: inst.fleetDb!.user };
  const sidecar = target ? await dbLogin.sidecarRunning(target.container) : null;
  if (first && target && sidecar === true) await dbLogin.ensureManagerDbRole(target);

  if (!rec.settled) {
    if (first) {
      console.log(`[Maintenance] ${inst.displayName}: the manager restarted before the order ${NAME[rec.state]} of ${rec.orderedAt} was confirmed; running it again`);
      void rerun(inst, rec, 'resumed');
    } else {
      await rerun(inst, rec, 'retry');
    }
    return;
  }

  const app = await containerManager.appContainerRunning(inst.id);
  if (rec.state === 'off') {
    if (app === true) {
      const now = containerManager.getBot(inst.id);
      const stored = now ? maintenanceOf(now) : null;
      if (stored?.state === 'off' && stored.settled) setDrift(inst, D_OFF);
    } else if (app === false) clearDrift(inst.id);
  }
  if (rec.hook === 'unconfirmed' && app === true && rec.state !== 'off' && hasHooks(inst)) {
    await containerManager.withExternalBotOp(inst.id, OP, async () => {
      const now = containerManager.getBot(inst.id);
      const stored = now ? maintenanceOf(now) : null;
      if (!stored || !stored.settled || stored.state !== rec.state || stored.hook !== 'unconfirmed') return;
      const h = hookOutcome(await sendHook(inst, hookState(stored.state), stored.message));
      if (h.hook === 'unconfirmed') return;
      const next: MaintenanceRecord = { ...stored, hook: h.hook, ...(h.hook === 'confirmed' ? { savedByBot: hookState(stored.state) } : {}) };
      if (h.hook === 'confirmed' && next.lastError?.startsWith('the bot did not take the message')) delete next.lastError;
      containerManager.updateInstanceMaintenance(inst.id, next);
      if (h.hook === 'confirmed') console.log(`[Maintenance] ${inst.displayName}: the bot took the ${NAME[stored.state]} order on a retry`);
    }).catch(err => console.error(`[Maintenance] ${inst.displayName}: the hook retry failed: ${errText(err)}`));
  }
  if (!target || sidecar !== true) return;
  const read = await dbLogin.readBotLogin(target);
  if (!read.ok || read.login.inRecovery) return;
  const latest = containerManager.getBot(inst.id);
  const current = latest ? maintenanceOf(latest) : null;
  if (!current?.settled) return;
  if (current.state === 'running') {
    if (read.login.canLogin === false) setDrift(inst, D_LOGIN, `[Maintenance] ${inst.displayName}: the bot's database login is blocked while its state is Running`);
    else if (read.login.canLogin === true) clearDrift(inst.id);
    return;
  }
  if (read.login.canLogin !== true) return;
  await containerManager.withExternalBotOp(inst.id, OP, async () => {
    const t = target!;
    const now = containerManager.getBot(inst.id);
    const stored = now ? maintenanceOf(now) : null;
    if (!stored || !stored.settled || stored.state === 'running') return;
    const role = await dbLogin.ensureManagerDbRole(t);
    if (!role.ok) return;
    const blocked = await dbLogin.blockBotLogin(t);
    if (!blocked.ok) return;
    await dbLogin.endBotSessions(t, MAINTENANCE_TIMING.sessionPauseMs);
    console.warn(`[Maintenance] ${inst.displayName}: the database login was open while the state is ${NAME[stored.state]}; blocked it again`);
  }).catch(err => console.error(`[Maintenance] ${inst.displayName}: blocking the login again failed: ${errText(err)}`));
}

/** One pass over every bot; a pass that finds the previous one still running does nothing. */
export async function reconcileMaintenance(): Promise<void> {
  if (passRunning) return;
  passRunning = true;
  try {
    if (containerManager.registryFault() || containerManager.isShuttingDown()) return;
    const first = !firstPassDone;
    firstPassDone = true;
    for (const inst of containerManager.getAllBots()) {
      if (containerManager.isShuttingDown()) return;
      try {
        await reconcileBot(inst, first);
      } catch (err) {
        console.error(`[Maintenance] ${inst.displayName}: the state check failed: ${errText(err)}`);
      }
    }
  } finally {
    passRunning = false;
  }
}

export function startMaintenanceReconciler(): void {
  if (reconcilerTimer) return;
  void reconcileMaintenance();
  reconcilerTimer = setInterval(() => { void reconcileMaintenance(); }, MAINTENANCE_TIMING.reconcileMs);
  reconcilerTimer.unref?.();
}

export function stopMaintenanceReconciler(): void {
  if (reconcilerTimer) clearInterval(reconcilerTimer);
  reconcilerTimer = null;
}
