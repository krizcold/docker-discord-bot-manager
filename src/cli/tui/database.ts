import { Client } from '../client';
import {
  ActionResult, BackupEntry, Bot, botName, decommissionDb, dismissRestoreNotice, FleetBackupStatus, Outcome, readConnections, readFleetBackups,
  cancelSeed, dropReplicationSlot, finishRetire, joinFleet, provisionReplica, ProvisionBody, readJoinCode, readMaintenance, readMemory, readReplica, readReplication,
  readRestorePreview, readSwitch, removeReplica, ReplicationStatus, reseedCopy, restoreBackup, saveBackupConfig, setReplication,
  laneCall, lanePath, LaneResult, rejoinCopy,
} from './api';
import {
  ActionRow, actionRows, boundOutcome, SeedCancelAnswer, boundReadFailure, DISABLE_QUESTION, disableOutcome, dropOutcome, dropQuestion, EnableForm, enableOutcome,
  SEED_CHANGED_TEXT, SEED_ROUNDS, seedCancelOutcome, addQuestion, CHECKING_REFUSAL, CHECKING_TEXT, CopyAnswer, JoinForm, joinOutcome, joinQuestion,
  NO_SEED_TEXT, PROVISION_ROUNDS, provisionOutcome, provisionQuestion, removeOutcome, removeQuestion, RESEED_QUESTION, reseedOutcome, retireOutcome,
  handOverQuestion, keepQuestion, LANE_LIMIT_MS, LANE_NOT_CONFIRMED, LaneOp, laneOutcome, rejoinOutcome, rejoinQuestion, STALE_QUESTION, STALE_RUNNING,
  STALE_TIP, staleOutcome, takeOverQuestion, workingText, MOVE_CODE_SHOWN_TEXT, MOVE_OUT_QUESTION, moveCodeReadyText, newCodeQuestion, PUSH_LIMIT_MS,
  pushQuestion, receiveQuestion, joinedFirst, cancelQuestion, stopReceiveQuestion,
} from './actions';
import { CodeField, CodeShown, JOIN_CODE_NOTES, joinCodeFailure } from './codes';
import { Dialog } from './dialog';
import { FieldKey } from './field';
import {
  connectionLineText, copyInText, DbLayout, DbLine, DECOMMISSION_LINES, decommissionOutcome, DISMISS_LINES, dismissOutcome, emptyBackupsText,
  restoreConfirmLines, restoreOutcome, restoreSharersText, RESTORE_TIP, scheduleOutcome, fleetBackupErrorLines, formatBackupSize, hostDataRoot, hostPathLines, layoutOf,
  memoryLineText, moveOutText, placeText, replicaLines, replicationLines, seedBannerLines, stateLineText, switchLines, timeIn, When,
} from './dbtext';
import { clock } from './format';
import { wrap } from './install';

export interface DatabaseOptions {
  /** How often the screen reads its routes again (the page polls its panels every 3 s). */
  everyMs?: number;
  /** The time limit of each read. */
  limitMs?: number;
  /** The env the host folder is read from (HOST_DATA_DIR, DATA_DIR); the dbm process's own by default. */
  env?: NodeJS.ProcessEnv;
  /** The zone times are shown in; the dbm process's own by default. */
  timeZone?: string;
  /** How long after the last Left or Right the hour is saved. */
  hourSaveMs?: number;
  /** How long an accepted hand-over or take-over is waited for (LANE_LIMIT_MS by default). */
  laneLimitMs?: number;
  /** How long an accepted push is waited for (PUSH_LIMIT_MS by default). */
  pushLimitMs?: number;
}

export interface DatabaseView {
  body: string[];
  highlight?: number;
  cursor?: { line: number; col: number };
  keys: string;
  notice?: string;
}

export type DatabaseExit = { quit: true } | { leave: true } | { state: true } | undefined;

export interface DatabaseKey extends FieldKey {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  return?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  escape?: boolean;
}

/** What the screen reads of the session: the bot list and when it was read. */
export interface BotSource {
  bot(id: string): Bot | undefined;
  list: { bots: unknown[]; readAt: number | null; error: string | null };
  /** The running Database screen call per bot; it outlives the screen that started it. */
  dbBusy?: Map<string, { text: string; escape: boolean }>;
  /** The code field that has focus, and the call that gives it focus; a screen without them routes the field's keys itself. */
  codeFocus?: CodeField | null;
  focusCode?(f: CodeField | null): void;
  /** The bots whose lost provision or re-seed answer is being checked, and the call that checks one (the Session's). */
  lostChecks?: Set<string>;
  followLost?(botId: string, limitMs: number, end: (started: boolean) => void): Promise<void>;
  /** The open Database screen, which may be a later one than the screen that started a check. */
  held?: { database?: DatabaseScreen };
  /** The move codes made while their code screen could not open, one per bot (the Session's). */
  moveCodes?: Map<string, CodeShown>;
}

export const READ_LIMIT_MS = 15_000;
export const DB_EVERY_MS = 5_000;

type Said = { ok: boolean | null; text: string };
type Asked = { ask: () => void; lost: Said };

type Kind = 'state' | 'memory' | 'connections' | 'replica' | 'replication' | 'switch' | 'backups';

// The panels each layout of showFleetBackups (index.html:2551) fills.
const KINDS: Record<DbLayout, Kind[]> = {
  none: ['state', 'memory'],
  copy: ['state', 'memory', 'replica', 'switch', 'backups'],
  main: ['state', 'memory', 'connections', 'replica', 'backups', 'replication', 'switch'],
};

const READERS: Record<Kind, (client: Client, botId: string, limitMs: number) => Promise<Outcome<never>>> = {
  state: readMaintenance as never,
  memory: readMemory as never,
  connections: readConnections as never,
  replica: readReplica as never,
  replication: readReplication as never,
  switch: readSwitch as never,
  backups: readFleetBackups as never,
};

const hourText = (hour: number) => `${String(hour).padStart(2, '0')}:00`;

export const LIST_CHANGED_TEXT = 'The list changed; pick the action again with Up or Down.';

// Two rows are the same action when every value the press sends (kind, label, slot, machine, seed) is the same.
const sameRow = (a: ActionRow | null, b: ActionRow | null) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b);

interface Line {
  text: string;
  row?: number;
}

// A path longer than the line is broken after a slash, so each part is whole folder names.
function wrapPath(text: string, width: number, indent: string): string[] {
  const room = Math.max(width - indent.length, 10);
  const out: string[] = [];
  let rest = text;
  while (rest.length > room) {
    const space = rest.lastIndexOf(' ', room);
    const slash = rest.lastIndexOf('/', room - 1);
    const at = space > 0 ? space : slash > 0 ? slash + 1 : room;
    out.push(indent + rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  out.push(indent + rest);
  return out;
}

/** The page's Database window, read-only: the frame shows its view and passes it every key. */
export class DatabaseScreen {
  got: Partial<Record<Kind, Outcome<unknown>>> = {};
  pick = 0;
  top = 0;
  private follow = true;
  private room = 10;
  private seq: Record<Kind, number> = { state: 0, memory: 0, connections: 0, replica: 0, replication: 0, switch: 0, backups: 0 };
  private inFlight: Partial<Record<Kind, number>> = {};
  private readAt: Partial<Record<Kind, number>> = {};
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly everyMs: number;
  private readonly limitMs: number;
  private readonly root: string | null;
  private readonly when: When;
  private readonly zone: string;
  private readonly hourSaveMs: number;
  private readonly laneLimitMs: number;
  private readonly pushLimitMs: number;
  /** The schedule as last stored (the page's fleetBackupStored); null until the bot list carried it. */
  stored: { enabled: boolean; hour: number } | null = null;
  /** The hour moved with Left and Right and not saved yet. */
  hourDraft: number | null = null;
  private hourTimer: NodeJS.Timeout | null = null;
  // The list read the stored schedule came from; after a save it stays the answer's until a newer list read.
  private syncedBots: unknown[] | null = null;
  confirm: Dialog | null = null;
  private cancelText = 'Cancelled: nothing was sent.';
  /** The Actions list while it is open: the cursor, and the row it was put on (what Enter may send; none after a refused Enter). */
  actions: { pick: number; row: ActionRow | null } | null = null;
  enableForm: EnableForm | null = null;
  /** The Join or Add a live copy form while it is open. */
  joinForm: JoinForm | null = null;
  private ownBusy: { text: string; escape: boolean } | null = null;

  /** The call that runs for this bot, from this screen or one closed before it; keys wait, Esc too except for a restore. */
  get busy(): { text: string; escape: boolean } | null {
    return this.source.dbBusy ? this.source.dbBusy.get(this.botId) ?? null : this.ownBusy;
  }

  set busy(v: { text: string; escape: boolean } | null) {
    if (!this.source.dbBusy) this.ownBusy = v;
    else if (v) this.source.dbBusy.set(this.botId, v);
    else this.source.dbBusy.delete(this.botId);
  }
  notice: string | null = null;

  constructor(
    private client: Client,
    private changed: () => void,
    readonly botId: string,
    private source: BotSource,
    opts: DatabaseOptions = {},
    /** Takes each action's outcome, so it reaches the bot screen when this screen is closed, and reads the bot list again. */
    private report: (result: ActionResult) => void = () => undefined,
    /** Opens the code screen; the frame opens it only while this screen is the one shown, and then answers true. */
    private showCode: (shown: CodeShown) => boolean | void = () => undefined,
  ) {
    this.hourSaveMs = opts.hourSaveMs ?? 1000;
    this.laneLimitMs = opts.laneLimitMs ?? LANE_LIMIT_MS;
    this.pushLimitMs = opts.pushLimitMs ?? PUSH_LIMIT_MS;
    this.everyMs = opts.everyMs ?? DB_EVERY_MS;
    this.limitMs = opts.limitMs ?? READ_LIMIT_MS;
    this.root = hostDataRoot(opts.env ?? process.env);
    this.zone = opts.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
    this.when = timeIn(this.zone);
  }

  open(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.everyMs);
    this.timer.unref?.();
  }

  close(): void {
    if (!this.closed && this.hourDraft !== null) this.report({ ok: false, text: `The backup hour ${hourText(this.hourDraft)} was not saved.` });
    this.closed = true;
    if (this.joinForm) this.dropForm(this.joinForm);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.hourTimer) clearTimeout(this.hourTimer);
    this.hourTimer = null;
  }

  private tick(): void {
    const bot = this.source.bot(this.botId);
    if (!bot || this.closed) return;
    for (const kind of KINDS[layoutOf(bot)]) void this.read(kind);
  }

  // One read of a kind at a time, so a panel slower than the re-read still paints; the sequence number drops an answer
  // that a newer read replaced.
  private async read(kind: Kind): Promise<void> {
    if (this.inFlight[kind] !== undefined) return;
    const seq = ++this.seq[kind];
    const sentAt = Date.now();
    this.inFlight[kind] = sentAt;
    let r: Outcome<unknown>;
    try {
      r = await READERS[kind](this.client, this.botId, this.limitMs);
    } finally {
      delete this.inFlight[kind];
    }
    // A move code stops working once this machine no longer receives; a read sent before the code was made does not count.
    const held = this.source.moveCodes?.get(this.botId);
    if (kind === 'switch' && held && r.ok === true && !(r.value as { receive?: unknown }).receive && (held.heldAt === undefined || sentAt > held.heldAt)) {
      this.source.moveCodes!.delete(this.botId);
    }
    if (this.closed || seq !== this.seq[kind]) return;
    this.got[kind] = r;
    this.readAt[kind] = Date.now();
    this.changed();
  }

  /** A line saying a panel's lines are old: its read has been waiting longer than two re-reads. */
  private overdue(kind: Kind): string {
    const sent = this.inFlight[kind];
    const at = this.readAt[kind];
    if (sent === undefined || at === undefined || Date.now() - sent < 2 * this.everyMs) return '';
    return `The manager has not answered the newest read of the lines below for ${Math.round((Date.now() - sent) / 1000)} s; they were read at ${clock(at)}.`;
  }

  private backups(): BackupEntry[] {
    const r = this.got.backups;
    if (!r || r.ok !== true) return [];
    const list = (r.value as { backups?: unknown }).backups;
    return Array.isArray(list) ? (list as BackupEntry[]) : [];
  }

  private say(text: string | null): void {
    this.notice = text;
    this.changed();
  }

  private ask(
    lines: string[] | (() => string[]), yes: string, run: () => void, cancelText = 'Cancelled: nothing was sent.', space?: { label: string; press: () => void },
  ): void {
    this.notice = null;
    const bot = this.bot();
    const text = typeof lines === 'function' ? lines : () => lines;
    this.confirm = new Dialog([`Database: ${bot ? botName(bot) : this.botId}`, ''], (inner) => text().flatMap((l) => ['', ...wrap(l, inner)]).slice(1), yes, run, space);
    this.cancelText = cancelText;
    this.changed();
  }

  /** Runs one call with the keys waiting; the outcome goes to the notice and the bot list is read again. */
  private async act(text: string, escape: boolean, call: (busy: { text: string; escape: boolean }) => Promise<Said | Asked>): Promise<void> {
    if (this.busy) return;
    const mine = { text, escape };
    this.busy = mine;
    this.notice = null;
    this.changed();
    const got = await call(mine);
    if (this.busy === mine) this.busy = null;
    // A route's question opens a further dialog once the call is over; a closed screen cannot ask it.
    if ('ask' in got && !this.closed) {
      got.ask();
      this.syncFocus();
      return;
    }
    const result = 'ask' in got ? got.lost : got;
    this.report(result);
    if (this.closed) return;
    this.say(result.text);
    this.syncFocus();
    this.tick();
  }

  private bot(): Bot | undefined {
    return this.source.bot(this.botId);
  }

  // saveFleetBackupConfig (:3910): only the changed fields, each with the stored value it replaces.
  private async saveSchedule(next: { enabled: boolean; hour: number }): Promise<void> {
    const stored = this.stored;
    if (!stored) return;
    const body: Record<string, unknown> = { expected: {} };
    for (const k of ['enabled', 'hour'] as const) {
      if (next[k] !== stored[k]) {
        body[k] = next[k];
        (body.expected as Record<string, unknown>)[k] = stored[k];
      }
    }
    if (Object.keys(body.expected as object).length === 0) {
      this.hourDraft = null;
      this.changed();
      return;
    }
    await this.act('Saving the backup settings.', false, async () => {
      const out = scheduleOutcome(await saveBackupConfig(this.client, this.botId, body));
      this.hourDraft = null;
      if (out.stored) this.stored = out.stored;
      this.syncedBots = this.source.list.bots;
      return out;
    });
  }

  private moveHour(step: number): void {
    const stored = this.stored;
    if (!stored) return;
    this.hourDraft = ((this.hourDraft ?? stored.hour) + step + 24) % 24;
    this.armHour();
    this.changed();
  }

  // The moved hour is saved once no action runs and no question is open; until then the timer waits again.
  private armHour(): void {
    if (this.hourTimer) clearTimeout(this.hourTimer);
    this.hourTimer = setTimeout(() => {
      this.hourTimer = null;
      if (this.closed || this.hourDraft === null || !this.stored) return;
      if (this.busy || this.confirm) {
        this.armHour();
        return;
      }
      void this.saveSchedule({ enabled: this.stored.enabled, hour: this.hourDraft });
    }, this.hourSaveMs);
    this.hourTimer.unref?.();
  }

  // restoreFleetBackupFile (:3959): the preview, the question, then one POST held until the restore ends.
  private async restore(file: string): Promise<void> {
    if (this.busy) return;
    const mine = { text: 'Reading the instances that share this database.', escape: false };
    this.busy = mine;
    this.notice = null;
    this.changed();
    const preview = await readRestorePreview(this.client, this.botId, this.limitMs);
    if (this.busy === mine) this.busy = null;
    if (this.closed) return;
    this.ask(restoreConfirmLines(file, restoreSharersText(preview, this.botId)), 'Y Restore', () => {
      void this.act(`Restoring ${file}; this takes minutes. Esc leaves this screen; the outcome then shows on the bot screen.`, true,
        async () => restoreOutcome(file, await restoreBackup(this.client, this.botId, file)));
    });
  }

  // The page offers the join code buttons while replication is on (index.html:2910 to :2917).
  private replicationOn(): boolean {
    const r = this.got.replication;
    return !!r && r.ok === true && !!(r.value as { replication?: ReplicationStatus }).replication?.enabled;
  }

  // fetchJoinCode (:3049): one read per press; the code goes only to the code screen, never to a notice or a report.
  private async joinCode(): Promise<void> {
    if (this.busy) return;
    const mine = { text: 'Reading the join code.', escape: true };
    this.busy = mine;
    this.notice = null;
    this.changed();
    const r = await readJoinCode(this.client, this.botId, this.limitMs);
    if (this.busy === mine) this.busy = null;
    if (this.closed) {
      this.changed();
      return;
    }
    if (r.ok === true && r.value.joinCode) {
      const bot = this.bot();
      this.changed();
      this.showCode({ title: `Join code of ${bot ? botName(bot) : this.botId}`, code: r.value.joinCode, notes: JOIN_CODE_NOTES });
      return;
    }
    this.say(joinCodeFailure(r.ok === true ? { ok: false, text: '' } : r));
  }

  /** The rows of the Actions list, built from the bot and this screen's newest reads. */
  actionRows(): ActionRow[] {
    const bot = this.bot();
    if (!bot) return [];
    return actionRows(layoutOf(bot), {
      replication: this.got.replication as never, replica: this.got.replica as never, switch: this.got.switch as never, moveCodeHeld: !!this.source.moveCodes?.has(this.botId),
    }, bot);
  }

  // The code field has focus only while its form shows it and no dialog or call holds the keys.
  private syncFocus(): void {
    const set = this.source.focusCode;
    if (!set) return;
    const f = this.joinForm;
    const want = f && f.focus === 0 && !this.confirm && !this.busy && !this.closed && !this.actions ? f.code : null;
    const now = this.source.codeFocus ?? null;
    if (now === want || (!want && (!f || now !== f.code))) return;
    set.call(this.source, want);
  }

  // Success, leaving the form and closing the screen drop the code from the field and the Session.
  private dropForm(form: JoinForm): void {
    form.code.clear();
    if (this.joinForm === form) this.joinForm = null;
    if (this.source.focusCode && this.source.codeFocus === form.code) this.source.focusCode(null);
  }

  private leaveForm(): void {
    if (this.joinForm) this.dropForm(this.joinForm);
    this.changed();
  }

  // refuseWhileChecking (:3253): the Session holds the check, so a reopened screen refuses too.
  private refuseWhileChecking(): boolean {
    if (!this.source.lostChecks?.has(this.botId)) return false;
    this.say(CHECKING_REFUSAL);
    return true;
  }

  // followLostProvisioning (:3258), after a provision or re-seed whose answer was lost. The end reaches the bot's open
  // Database screen, this one or one opened after it.
  private followLost(): void {
    void this.source.followLost?.(this.botId, this.limitMs, (started) => {
      const open = this.closed ? this.source.held?.database : this;
      const shown = open && open.botId === this.botId && !open.closed ? open : null;
      if (started) {
        shown?.tick();
        return;
      }
      this.report({ ok: false, text: NO_SEED_TEXT });
      shown?.say(NO_SEED_TEXT);
    });
  }

  // Enter in the form opens the action's dialog; it never sends. The dialog names the action and the bot, never the code.
  private formEnter(): void {
    const form = this.joinForm;
    if (!form || this.busy || this.confirm) return;
    const body = form.body();
    if ('refusal' in body) {
      this.say(body.refusal);
      return;
    }
    if (this.refuseWhileChecking()) return;
    const bot = this.bot();
    const name = bot ? botName(bot) : this.botId;
    if (form.kind === 'rejoin') {
      const machine = form.opts.machine || 'the main';
      const joinCode = body.joinCode ?? '';
      this.ask(rejoinQuestion(machine, true), 'Y Rejoin', () => {
        if (!this.refuseWhileChecking()) this.rejoin({ joinCode }, form);
      }, 'Cancelled: nothing was started.');
      return;
    }
    if (form.kind === 'push') {
      const moveCode = body.joinCode ?? '';
      this.ask(pushQuestion(name), 'Y Push', () => this.push(form, moveCode), 'Cancelled: nothing was pushed.');
      return;
    }
    if (form.kind === 'stale') {
      this.ask(STALE_QUESTION, 'Y Rejoin', () => {
        if (!this.refuseWhileChecking()) this.stale(form, body, 0);
      }, 'Cancelled: nothing was started.');
      return;
    }
    const join = form.kind === 'join';
    this.ask(join ? joinQuestion(name) : addQuestion(name, !!body.joinCode), join ? 'Y Join' : 'Y Add the copy', () => {
      if (this.refuseWhileChecking()) return;
      if (join) this.join(form, body.joinCode ?? '');
      else this.provision(form, body, 0);
    });
  }

  // joinFleetFromPanel (:3319): a refusal or no answer keeps the form.
  private join(form: JoinForm, joinCode: string): void {
    void this.act(CHECKING_TEXT, true, async () => {
      const said = joinOutcome(await joinFleet(this.client, this.botId, joinCode) as Outcome<CopyAnswer>);
      if (said.ok === true) this.dropForm(form);
      return said;
    });
  }

  // provisionFleetReplica (:3335) through postProvision (:3277): each question is a further dialog, its flag kept in the
  // body; after three the answer is shown as it is. A refusal keeps the form (:3347).
  private provision(form: JoinForm, body: ProvisionBody, round: number): void {
    void this.act(body.joinCode ? CHECKING_TEXT : 'Starting the copy.', true, async () => {
      const r = await provisionReplica(this.client, this.botId, body);
      const v = r.ok === true ? (r.value as CopyAnswer) : null;
      if (v && v.success !== true && v.needsConfirm === true && round < PROVISION_ROUNDS) {
        const q = provisionQuestion(v.error || '', v.confirmVolume, body);
        // The join of a pasted code ran before the question (bots.ts:1987 to :1998), so every text after it says so first.
        const joined = v.joinMessage;
        const late = `the manager asked to confirm after the Database screen was closed (${v.error || ''}).`;
        return {
          ask: () => this.ask(joined ? [joined, ...q.lines] : q.lines, q.yes, () => {
            if (!this.refuseWhileChecking()) this.provision(form, q.body, round + 1);
          }, joined ? `${joined} Cancelled: the copy was not started.` : 'Cancelled: nothing was started.'),
          lost: { ok: false, text: joined ? joinedFirst(joined, late) : `Nothing was started: ${late}` },
        };
      }
      if (r.ok === null) this.followLost();
      const said = provisionOutcome(r as Outcome<CopyAnswer>);
      if (said.ok === true) this.dropForm(form);
      return said;
    });
  }

  // removeFleetReplica (:3387): a promoted copy asks once more and is sent with confirmPromoted.
  private removeCopy(confirmPromoted: boolean): void {
    void this.act('Removing the copy.', true, async () => {
      const r = await removeReplica(this.client, this.botId, confirmPromoted ? { confirmPromoted: true } : undefined);
      const v = r.ok === true ? (r.value as CopyAnswer) : null;
      if (v && v.success !== true && v.needsConfirm === true && !confirmPromoted) {
        const q = v.error || '';
        return {
          ask: () => this.ask([q, 'Remove it anyway?'], 'Y Remove', () => this.removeCopy(true), 'Cancelled: the copy was not removed.'),
          lost: { ok: false, text: `The copy was not removed: the manager asked to confirm after the Database screen was closed (${q}).` },
        };
      }
      return removeOutcome(r as Outcome<CopyAnswer>);
    });
  }

  // reseedStandbyNow (:3434): the route's question is a further dialog, then sent with confirm.
  private reseed(confirm: boolean): void {
    if (this.refuseWhileChecking()) return;
    void this.act('Starting the re-seed.', true, async () => {
      const r = await reseedCopy(this.client, this.botId, confirm ? { confirm: true } : {});
      const v = r.ok === true ? (r.value as CopyAnswer) : null;
      if (v && v.success !== true && v.needsConfirm === true && !confirm) {
        const q = v.error || '';
        return {
          ask: () => this.ask([q], 'Y Re-seed', () => this.reseed(true), 'Cancelled: the re-seed was not started.'),
          lost: { ok: false, text: `The re-seed was not started: the manager asked to confirm after the Database screen was closed (${q}).` },
        };
      }
      if (r.ok === null) this.followLost();
      return reseedOutcome(r as Outcome<CopyAnswer>);
    });
  }

  /**
   * switchRequest (:3553): one lane route through laneCall. A route question is a further dialog, sent again once with
   * confirm and its confirmFlag (DELETE with ?confirm=1); an accepted lane waits for its bot:switch frame, keys held.
   */
  private lane(
    op: LaneOp, method: 'POST' | 'DELETE', route: string, body: Record<string, unknown> | undefined, confirmed: boolean, waitText: string,
    finish: (r: LaneResult) => Said = (r) => laneOutcome(op, r),
  ): void {
    const bot = this.bot();
    const name = bot ? botName(bot) : this.botId;
    void this.act(waitText, true, async (busy) => {
      const r = await laneCall(this.client, this.botId, method, lanePath(this.botId, route), body, {
        op,
        limitMs: op === 'push' ? this.pushLimitMs : this.laneLimitMs,
        onAccepted: () => {
          busy.text = workingText(name);
          this.report({ ok: null, text: busy.text });
          this.changed();
        },
      });
      if (r.kind === 'question' && !confirmed) {
        const again = method === 'DELETE'
          ? { route: `${route}${route.includes('?') ? '&' : '?'}confirm=1`, body: undefined }
          : { route, body: { ...(body ?? {}), confirm: true, ...(r.confirmFlag ? { [r.confirmFlag]: true } : {}) } };
        return {
          ask: () => this.ask([r.text], 'Y Confirm', () => this.lane(op, method, again.route, again.body, true, waitText, finish), LANE_NOT_CONFIRMED[op]),
          lost: { ok: false, text: `Nothing was sent again: the manager asked to confirm after the Database screen was closed (${r.text}).` },
        };
      }
      return finish(r);
    });
  }

  // receiveFleet (:3652): the answer's move code opens the code screen while this screen is the one shown; otherwise it
  // is held in the Session for this bot only, and the notice names where to show it, never the code.
  private receive(waitText: string): void {
    this.lane('receive', 'POST', 'fleet-receive', undefined, false, waitText, (r) => {
      const codes = this.source.moveCodes;
      // A done answer changed the receive login's password, so a code held before it no longer works.
      if (r.kind === 'done') codes?.delete(this.botId);
      if (r.kind !== 'done' || !r.moveCode) return laneOutcome('receive', r);
      const bot = this.bot();
      const name = bot ? botName(bot) : this.botId;
      const shown: CodeShown = { title: `Move code of ${name}`, code: r.moveCode, notes: r.text ? [r.text] : [], heldAt: Date.now() };
      if (!codes) {
        if (!this.closed && this.showCode(shown) === true) return { ok: true, text: MOVE_CODE_SHOWN_TEXT };
        return { ok: null, text: `A move code for ${name} was made, but this screen cannot keep it; make a new one with Make a new move code.` };
      }
      codes.set(this.botId, shown);
      if (!this.closed && this.showCode(this.untilWhole(codes, shown)) === true) return { ok: true, text: MOVE_CODE_SHOWN_TEXT };
      return { ok: true, text: moveCodeReadyText(name) };
    });
  }

  // The held code stays in the Session, and Show the move code stays offered, until a code screen has drawn it whole.
  private untilWhole(codes: Map<string, CodeShown>, shown: CodeShown): CodeShown {
    return {
      ...shown,
      onWhole: () => {
        if (codes.get(this.botId) === shown) codes.delete(this.botId);
      },
    };
  }

  // pushFleet (:3667): the pasted code, sent once per Y; a success drops it from the field.
  private push(form: JoinForm, moveCode: string): void {
    this.lane('push', 'POST', 'fleet-push', { moveCode }, false, 'Pushing: this database is dumped first, which can take minutes.', (r) => {
      const said = laneOutcome('push', r);
      if (said.ok === true) this.dropForm(form);
      return said;
    });
  }

  // The held move code leaves the Session once its screen has drawn it whole, so it is gone when that screen closes.
  private showHeldCode(): void {
    const codes = this.source.moveCodes;
    const shown = codes?.get(this.botId);
    if (!codes || !shown) {
      this.say('No move code is held for this bot.');
      return;
    }
    this.changed();
    this.showCode(this.untilWhole(codes, shown));
  }

  // rejoinFleet (:3683): one POST, recorded or with a pasted code. A lost answer is checked as a lost re-seed is: the
  // route starts the same seed run (rejoinComposed, fleetSwitch.ts:1507).
  private rejoin(body: { replaced: true } | { joinCode: string }, form: JoinForm | null): void {
    void this.act('Starting the rejoin.', true, async () => {
      const r = await rejoinCopy(this.client, this.botId, body);
      if (r.ok === null) this.followLost();
      const said = rejoinOutcome(r as Outcome<CopyAnswer>);
      if (said.ok === true && form) this.dropForm(form);
      return said;
    });
  }

  // reseedStalePrimary (:3361) through postProvision with its verb 're-seed' (:3374): a refusal keeps the form.
  private stale(form: JoinForm, body: ProvisionBody, round: number): void {
    void this.act(CHECKING_TEXT, true, async () => {
      const r = await rejoinCopy(this.client, this.botId, body);
      const v = r.ok === true ? (r.value as CopyAnswer) : null;
      if (v && v.success !== true && v.needsConfirm === true && round < PROVISION_ROUNDS) {
        const q = provisionQuestion(v.error || '', v.confirmVolume, body, 're-seed');
        return {
          ask: () => this.ask(q.lines, q.yes, () => {
            if (!this.refuseWhileChecking()) this.stale(form, q.body, round + 1);
          }, 'Cancelled: nothing was started.'),
          lost: { ok: false, text: `Nothing was started: the manager asked to confirm after the Database screen was closed (${v.error || ''}).` },
        };
      }
      if (r.ok === null) this.followLost();
      const said = staleOutcome(r as Outcome<CopyAnswer>);
      if (said.ok === true) this.dropForm(form);
      return said;
    });
  }

  private openForm(kind: 'join' | 'add' | 'rejoin' | 'stale' | 'push', opts: { machine?: string; host?: string; port?: string } = {}): void {
    this.notice = null;
    this.joinForm = new JoinForm(kind, {
      onEnter: () => {
        this.formEnter();
        this.syncFocus();
      },
      onEscape: () => this.leaveForm(),
    }, opts);
    this.changed();
  }

  // The press sends what the row was built from: the slot, the seed's startedAt and parked.
  private take(row: ActionRow): void {
    this.actions = null;
    if (row.kind === 'enable') {
      this.enableForm = new EnableForm();
      this.notice = null;
      this.changed();
      return;
    }
    if (row.kind === 'bound') {
      void this.act('Applying the WAL bound.', true, async () => {
        const g = await readReplication(this.client, this.botId, this.limitMs);
        if (g.ok !== true) return boundReadFailure(g);
        const r = g.value.replication;
        if (!r || !r.enabled) return { ok: false, text: 'Replication is not enabled' };
        return boundOutcome(await setReplication(this.client, this.botId, { enabled: true, publicHost: r.publicHost ?? '', hostPort: r.hostPort, slotWalKeepMb: 4096 }));
      });
      return;
    }
    if (row.kind === 'drop') {
      const slot = row.slot;
      this.ask(dropQuestion(slot), 'Y Drop', () => {
        void this.act(`Dropping slot ${slot}.`, true, async () => dropOutcome(slot, await dropReplicationSlot(this.client, this.botId, slot)));
      });
      return;
    }
    if (row.kind === 'disable') {
      this.ask(DISABLE_QUESTION, 'Y Disable', () => {
        void this.act('Disabling replication.', true, async () => disableOutcome(await setReplication(this.client, this.botId, { enabled: false })));
      });
      return;
    }
    if (row.kind === 'join' || row.kind === 'add') {
      if (this.refuseWhileChecking()) return;
      this.openForm(row.kind);
      return;
    }
    if (row.kind === 'handover') {
      const { slot, machine } = row;
      this.ask(handOverQuestion(machine), 'Y Hand over', () => this.lane('hand-over', 'POST', 'fleet-handover', { slot }, false, 'Handing over the main.'));
      return;
    }
    if (row.kind === 'cancel') {
      const q = cancelQuestion(row.mode, row.machine, row.file, row.phase);
      this.ask(q.lines, q.yes, () => this.lane('cancel', 'DELETE', 'fleet-handover', undefined, false, row.label === 'Cancel the move' ? 'Cancelling the move.' : 'Cancelling the hand-over.'));
      return;
    }
    if (row.kind === 'takeover') {
      let start = true;
      this.ask(() => takeOverQuestion(start), 'Y Take over', () => this.lane('take-over', 'POST', 'fleet-takeover', { start }, false, 'Taking over.'),
        'Cancelled: nothing was sent.', { label: 'Space Start on/off', press: () => { start = !start; } });
      return;
    }
    if (row.kind === 'keep') {
      this.ask(keepQuestion(row.machine), 'Y Keep', () => this.lane('keep', 'POST', 'fleet-keep-main', undefined, false, 'Keeping this machine as the main.'));
      return;
    }
    if (row.kind === 'rejoin') {
      if (this.refuseWhileChecking()) return;
      if (!row.recorded) {
        this.openForm('rejoin', { machine: row.machine });
        return;
      }
      this.ask(rejoinQuestion(row.machine, false), 'Y Rejoin', () => {
        if (!this.refuseWhileChecking()) this.rejoin({ replaced: true }, null);
      }, 'Cancelled: nothing was started.');
      return;
    }
    if (row.kind === 'stale') {
      if (row.running) {
        this.say(`${STALE_TIP} ${STALE_RUNNING}`);
        return;
      }
      if (this.refuseWhileChecking()) return;
      this.openForm('stale', { host: row.host, port: row.port });
      return;
    }
    if (row.kind === 'showcode') {
      this.showHeldCode();
      return;
    }
    if (row.kind === 'receive') {
      const broken = row.safetyDump !== null;
      this.ask(receiveQuestion(row.safetyDump), 'Y Receive', () => this.receive(broken ? 'Making the move code.' : 'Dumping this database, then making the move code; the dump can take minutes.'),
        LANE_NOT_CONFIRMED.receive);
      return;
    }
    if (row.kind === 'newcode') {
      const bot = this.bot();
      this.ask(newCodeQuestion(bot ? botName(bot) : this.botId), 'Y Make a new code', () => this.receive('Making a new move code.'), 'Cancelled: no new move code was made.');
      return;
    }
    if (row.kind === 'stopreceive') {
      const bot = this.bot();
      // A held move code no longer works once receiving stopped, so it is dropped.
      this.ask(stopReceiveQuestion(bot ? botName(bot) : this.botId, row.safetyDump), 'Y Stop receiving', () => this.lane('stop', 'DELETE', 'fleet-receive', undefined, false, 'Stopping receiving.', (r) => {
        const said = laneOutcome('stop', r);
        if (said.ok === true) this.source.moveCodes?.delete(this.botId);
        return said;
      }));
      return;
    }
    if (row.kind === 'push') {
      this.openForm('push');
      return;
    }
    if (row.kind === 'moveout') {
      this.ask(MOVE_OUT_QUESTION, 'Y Make the backup', () => this.lane('move', 'POST', 'fleet-move-out', {}, false, 'Making the backup for a move; the dump can take minutes.', (r) => {
        if (r.kind !== 'done') return laneOutcome('move', r);
        return { ok: true, text: r.file ? moveOutText(this.root, this.botId, r.file, r.text || '') : r.text || 'Done' };
      }), LANE_NOT_CONFIRMED.move);
      return;
    }
    if (row.kind === 'remove') {
      this.ask(removeQuestion(row.slot), 'Y Remove', () => this.removeCopy(false), 'Cancelled: the copy was not removed.');
      return;
    }
    if (row.kind === 'reseed') {
      if (this.refuseWhileChecking()) return;
      this.ask(RESEED_QUESTION, 'Y Re-seed', () => this.reseed(false), 'Cancelled: the re-seed was not started.');
      return;
    }
    if (row.kind === 'retire') {
      void this.act('Removing the env pins.', true, async () => retireOutcome(await finishRetire(this.client, this.botId) as Outcome<CopyAnswer>));
      return;
    }
    this.seedCancel({ startedAt: row.startedAt, parked: row.parked }, 0);
  }

  // cancelReplicaSeed (:3410): each question the route asks is a further dialog, sent again with the seed it names; a
  // third question means the seed changed at every round, and nothing is asked or sent after it.
  private seedCancel(body: { startedAt: number; parked: boolean; committed?: boolean; confirm?: boolean }, round: number): void {
    void this.act(body.parked ? 'Dismissing the stopped seed.' : 'Cancelling the seed.', true, async () => {
      const r = await cancelSeed(this.client, this.botId, body);
      const v = r.ok === true ? (r.value as SeedCancelAnswer) : null;
      if (v && v.needsConfirm === true && v.seed) {
        if (round + 1 >= SEED_ROUNDS) return { ok: false, text: SEED_CHANGED_TEXT };
        const seed = v.seed;
        const question = v.error || 'Cancel the seed?';
        return {
          ask: () => this.ask([question], 'Y Confirm', () => this.seedCancel({ startedAt: seed.startedAt, parked: seed.parked, committed: seed.committed, confirm: true }, round + 1),
            'Cancelled: the seed was not cancelled or dismissed.'),
          lost: { ok: false, text: `Nothing was cancelled or dismissed: the manager asked to confirm after the Database screen was closed (${question}).` },
        };
      }
      return seedCancelOutcome(r as Outcome<SeedCancelAnswer>);
    });
  }

  key(input: string, key: DatabaseKey, forwardDelete = false): DatabaseExit {
    const out = this.keyIn(input, key, forwardDelete);
    this.syncFocus();
    return out;
  }

  private keyIn(input: string, key: DatabaseKey, forwardDelete: boolean): DatabaseExit {
    if (this.confirm) {
      const c = this.confirm;
      const out = c.key(input, key);
      if (out === 'yes') {
        this.confirm = null;
        c.run();
      } else if (out === 'cancel') {
        this.confirm = null;
        this.say(this.cancelText);
      } else this.changed();
      return undefined;
    }
    if (this.busy) return key.escape && this.busy.escape ? { leave: true } : undefined;
    if (this.enableForm) {
      const form = this.enableForm;
      const out = form.key(input, key, forwardDelete);
      if (out === 'leave') this.enableForm = null;
      if (out === 'send') {
        const body = form.body();
        if ('refusal' in body) this.say(body.refusal);
        else {
          void this.act('Enabling replication.', true, async () => {
            const said = enableOutcome(await setReplication(this.client, this.botId, body));
            if (said.ok === true && this.enableForm === form) this.enableForm = null;
            return said;
          });
        }
        return undefined;
      }
      this.changed();
      return undefined;
    }
    if (this.joinForm) {
      const out = this.joinForm.key(input, key, forwardDelete);
      if (out === 'leave') this.leaveForm();
      else if (out === 'enter') this.formEnter();
      else this.changed();
      return undefined;
    }
    if (this.actions) {
      const rows = this.actionRows();
      if (key.escape) this.actions = null;
      else if (rows.length > 0 && (key.upArrow || key.downArrow)) {
        this.actions.pick = Math.min(Math.max(this.actions.pick + (key.upArrow ? -1 : 1), 0), rows.length - 1);
        this.actions.row = rows[this.actions.pick];
        this.notice = null;
      } else if (key.return && rows.length > 0) {
        // A read can change the rows after the cursor was put on one; Enter then sends nothing until Up or Down picks a row.
        const row = rows[Math.min(this.actions.pick, rows.length - 1)];
        if (!sameRow(row, this.actions.row)) {
          this.actions.row = null;
          this.say(LIST_CHANGED_TEXT);
          return undefined;
        }
        this.take(row);
        return undefined;
      }
      this.changed();
      return undefined;
    }
    if (key.escape) return { leave: true };
    const k = input.toLowerCase();
    if (k === 'a' && this.actionRows().length > 0) {
      this.actions = { pick: 0, row: this.actionRows()[0] };
      this.notice = null;
      this.changed();
      return undefined;
    }
    if (k === 'q') return { quit: true };
    if (k === 't') return { state: true };
    const bot = this.bot();
    const main = !!bot && layoutOf(bot) === 'main';
    if (main && this.stored) {
      if (input === ' ') {
        if (this.hourTimer) clearTimeout(this.hourTimer);
        this.hourTimer = null;
        void this.saveSchedule({ enabled: !this.stored.enabled, hour: this.hourDraft ?? this.stored.hour });
        return undefined;
      }
      if (key.leftArrow || key.rightArrow) {
        this.moveHour(key.leftArrow ? -1 : 1);
        return undefined;
      }
    }
    if (main && k === 'j' && this.replicationOn()) {
      void this.joinCode();
      return undefined;
    }
    const actionKey = (key.return && this.backups().length > 0) || k === 'k' || (k === 'x' && !!bot?.fleetBackup?.restoreError);
    if (main && actionKey && this.hourDraft !== null) {
      this.say(`The backup hour ${hourText(this.hourDraft)} is not saved yet; it is saved a second after the last arrow key.`);
      return undefined;
    }
    if (main && key.return && this.backups().length > 0) {
      void this.restore(this.backups()[Math.min(this.pick, this.backups().length - 1)].file);
      return undefined;
    }
    if (main && k === 'x' && bot?.fleetBackup?.restoreError) {
      const at = bot.fleetBackup.restoreErrorAt ?? '';
      this.ask(DISMISS_LINES, 'Y Dismiss', () => {
        void this.act('Dismissing the restore notice.', false, async () => dismissOutcome(await dismissRestoreNotice(this.client, this.botId, at)));
      });
      return undefined;
    }
    if (main && k === 'k') {
      this.ask(DECOMMISSION_LINES, 'Y Decommission', () => {
        void this.act('Decommissioning the database.', false, async () => decommissionOutcome(await decommissionDb(this.client, this.botId)));
      });
      return undefined;
    }
    const rows = this.backups().length;
    if (key.pageUp || key.pageDown) {
      this.follow = false;
      this.top = Math.max(0, this.top + (key.pageUp ? -1 : 1) * Math.max(this.room - 1, 1));
    } else if (key.upArrow || key.downArrow) {
      const step = key.upArrow ? -1 : 1;
      if (rows > 0) {
        this.follow = true;
        this.pick = Math.min(Math.max(this.pick + step, 0), rows - 1);
      } else {
        this.top = Math.max(0, this.top + step);
      }
    } else {
      return undefined;
    }
    this.changed();
    return undefined;
  }

  private backupLines(inner: number, out: Line[], bot: Bot, list: BackupEntry[]): void {
    const fileWidth = Math.max(...list.map((b) => b.file.length), 4);
    const pick = Math.min(this.pick, list.length - 1);
    out.push({ text: `  ${'File'.padEnd(fileWidth)}  ${'Size'.padStart(9)}  Time (${this.zone})`.slice(0, inner) });
    list.forEach((b, i) => {
      const at = this.when(b.mtime).slice(0, 16);
      out.push({ text: `${i === pick ? '>' : ' '} ${b.file.padEnd(fileWidth)}  ${formatBackupSize(b.size).padStart(9)}  ${at}`.slice(0, inner), row: i });
      if (i !== pick) return;
      for (const l of hostPathLines(this.root, bot.id, b.file, typeof b.tables === 'number')) for (const w of wrapPath(l, inner, '    ')) out.push({ text: w });
    });
  }

  private lines(bot: Bot, inner: number): Line[] {
    const out: Line[] = [];
    const say = (text: string) => {
      if (text) for (const w of wrap(text, inner)) out.push({ text: w });
    };
    const sayAll = (lines: DbLine[]) => lines.forEach((l) => say(l.text));
    const layout = layoutOf(bot);
    out.push({ text: `Database: ${botName(bot)}` });
    const list = this.source.list;
    if (list.error) say(`can't read the bot list: ${list.error}. The bot's records below were read at ${clock(list.readAt ?? Date.now())}.`);
    say(this.overdue('state'));
    say(stateLineText((this.got.state as never) ?? null));
    say(this.overdue('memory'));
    say(memoryLineText((this.got.memory as never) ?? null));
    if (layout === 'none') {
      say(placeText(bot));
      return out;
    }
    if (layout === 'copy') {
      out.push({ text: '' });
      say(this.overdue('replica'));
      sayAll(replicaLines((this.got.replica as never) ?? null, this.when));
      out.push({ text: '' }, { text: 'Move' });
      say(this.overdue('switch'));
      sayAll(switchLines(bot, (this.got.switch as never) ?? null));
      say(this.overdue('backups'));
      const r = this.got.backups;
      if (r && r.ok !== true) {
        out.push({ text: '' });
        say(`Could not list the earlier database backups: ${r.ok === null ? `the manager could not be reached (${r.text})` : r.text || 'unknown error'}; retrying.`);
      } else if (this.backups().length > 0) {
        out.push({ text: '' }, { text: 'Earlier database backups' });
        say('Backups kept on this machine: dumps of the live copy (copy-) and dumps taken while this machine held the main database. Restoring one needs a machine that holds the main database.');
        this.backupLines(inner, out, bot, this.backups());
      }
      return out;
    }
    say(this.overdue('connections'));
    say(connectionLineText((this.got.connections as never) ?? null));
    say(this.overdue('replica'));
    sayAll(seedBannerLines((this.got.replica as never) ?? null));
    const fb: FleetBackupStatus = bot.fleetBackup || { enabled: true, hour: 4 };
    if (this.hourDraft === null && !this.busy && this.source.list.bots !== this.syncedBots) this.stored = { enabled: fb.enabled !== false, hour: typeof fb.hour === 'number' ? fb.hour : 4 };
    const shown = this.stored ?? { enabled: true, hour: 4 };
    const errLines = fleetBackupErrorLines(fb, this.when);
    if (fb.restoreError) errLines.splice(1, 0, { text: 'X dismisses the restore notice.' });
    sayAll(errLines);
    out.push({ text: '' });
    const hour = this.hourDraft ?? shown.hour;
    say(`[${shown.enabled ? 'x' : ' '}] Backups    Daily backup and test restore at ${String(hour).padStart(2, '0')}:00${this.hourDraft !== null ? ' (not saved yet)' : ''}`);
    say(this.overdue('backups'));
    const r = this.got.backups;
    if (!r) say('Loading...');
    else if (r.ok === null) say(`Could not list the backups: the manager could not be reached (${r.text}); retrying.`);
    else if (r.ok === false) say(`Could not list the backups: ${r.text || 'unknown error'}; retrying.`);
    else if (this.backups().length === 0) say(emptyBackupsText(fb));
    else this.backupLines(inner, out, bot, this.backups());
    say(RESTORE_TIP);
    out.push({ text: '' });
    say(copyInText(this.root, bot.id));
    out.push({ text: '' }, { text: 'Replication' });
    say(this.overdue('replication'));
    sayAll(replicationLines((this.got.replication as never) ?? null, this.when));
    out.push({ text: '' }, { text: 'Move' });
    say(this.overdue('switch'));
    sayAll(switchLines(bot, (this.got.switch as never) ?? null));
    return out;
  }

  view(inner: number, room: number, outer?: string): DatabaseView {
    const notice = this.notice ?? (this.busy || this.confirm ? undefined : outer);
    const long = notice && notice.length > inner ? wrap(notice, inner) : null;
    if (!long) return this.screen(inner, room, notice ?? undefined);
    const space = Math.max(room - long.length - 1, 3);
    const v = this.screen(inner, space, undefined);
    const body = v.body.slice(0, space);
    while (body.length < space) body.push('');
    return { ...v, body: [...body, '', ...long] };
  }

  private screen(inner: number, room: number, notice: string | undefined): DatabaseView {
    this.room = room;
    const bot = this.source.bot(this.botId);
    if (!bot) return { body: ['This bot is no longer in the bot list.'], keys: 'Esc Back  Q Quit', notice };
    if (this.confirm) return { ...this.confirm.view(inner, room), notice };
    const waiting = this.busy ? (this.busy.escape ? 'Waiting for the manager  Esc Back' : 'Waiting for the manager') : null;
    if (this.enableForm) {
      const f = this.enableForm.lines(inner);
      const head = [`Database: ${botName(bot)}`, ''];
      return {
        body: [...head, ...f.lines].slice(0, room),
        ...(waiting ? {} : { cursor: { line: head.length + f.cursor.line, col: f.cursor.col } }),
        keys: waiting ?? 'Up/Down/Tab Field  Enter Enable  Esc Back',
        notice: notice ?? this.busy?.text,
      };
    }
    if (this.joinForm) {
      const form = this.joinForm;
      const f = form.lines(inner);
      const head = [`Database: ${botName(bot)}`, ''];
      return {
        body: [...head, ...f.lines].slice(0, room),
        ...(waiting || !f.cursor ? {} : { cursor: { line: head.length + f.cursor.line, col: f.cursor.col } }),
        keys: waiting ?? `${form.kind === 'add' || form.kind === 'stale' ? 'Up/Down/Tab Field  ' : ''}Enter ${form.kind === 'add' ? 'Add' : form.kind === 'join' ? 'Join' : form.kind === 'push' ? 'Push' : 'Rejoin'}  Esc Back`,
        notice: notice ?? this.busy?.text,
      };
    }
    if (this.actions) {
      const rows = this.actionRows();
      const pick = Math.min(this.actions.pick, Math.max(rows.length - 1, 0));
      const head = [`Actions: ${botName(bot)}`, ''];
      if (rows.length === 0) return { body: [...head, 'No action is offered for this bot in its current state.'], keys: 'Esc Back', notice };
      // A label longer than the line (a long machine name) wraps under itself; the window keeps the picked row whole.
      const space = Math.max(room - head.length, 1);
      const all: Array<{ text: string; row: number }> = [];
      rows.forEach((r, i) => wrap(r.label, Math.max(inner - 2, 10)).forEach((l, j) => all.push({ text: `${j === 0 ? (i === pick ? '>' : ' ') : ' '} ${l}`, row: i })));
      const at = all.findIndex((l) => l.row === pick);
      let end = at;
      while (end + 1 < all.length && all[end + 1].row === pick) end++;
      const first = Math.max(0, Math.min(at, Math.max(end - space + 1, 0), Math.max(all.length - space, 0)));
      const shown = all.slice(first, first + space).map((l) => l.text);
      return { body: [...head, ...shown], highlight: head.length + at - first, keys: 'Up/Down Choose  Enter Take  Esc Back', notice };
    }
    const all = this.lines(bot, inner);
    const rows = this.backups().length;
    if (rows > 0) this.pick = Math.min(this.pick, rows - 1);
    const at = all.findIndex((l) => l.row === this.pick);
    if (this.follow && at >= 0) {
      let end = at;
      while (end + 1 < all.length && all[end + 1].row === undefined && all[end + 1].text.startsWith('    ')) end++;
      if (end >= this.top + room) this.top = end - room + 1;
      if (at < this.top) this.top = at;
    }
    this.top = Math.max(0, Math.min(this.top, all.length - room));
    const shown = all.slice(this.top, this.top + room);
    const longer = all.length > room;
    const main = layoutOf(bot) === 'main';
    const keys = this.busy
      ? (this.busy.escape ? 'Waiting for the manager  Esc Back' : 'Waiting for the manager')
      : [
        ...(rows > 0 ? ['Up/Down Backup'] : longer ? ['Up/Down Scroll'] : []),
        ...(main && rows > 0 ? ['Enter Restore'] : []),
        ...(main ? ['Space Backups', 'Left/Right Hour'] : []),
        ...(main && bot.fleetBackup?.restoreError ? ['X Dismiss'] : []),
        ...(main ? ['K Decommission'] : []),
        ...(main && this.replicationOn() ? ['J Join code'] : []),
        ...(this.actionRows().length > 0 ? ['A Actions'] : []),
        ...(longer ? ['PgUp/PgDn Scroll'] : []),
        'T State',
        'Esc Back',
        'Q Quit',
      ].join('  ');
    const mark = at - this.top;
    return {
      body: shown.map((l) => l.text), ...(at >= 0 && mark >= 0 && mark < room ? { highlight: mark } : {}), keys, notice: notice ?? this.busy?.text,
    };
  }
}
