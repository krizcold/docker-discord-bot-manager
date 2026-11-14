import { Client } from '../client';
import {
  ActionResult, BackupEntry, Bot, botName, decommissionDb, dismissRestoreNotice, FleetBackupStatus, Outcome, readConnections, readFleetBackups,
  readMaintenance, readMemory, readReplica, readReplication, readRestorePreview, readSwitch, restoreBackup, saveBackupConfig,
} from './api';
import {
  connectionLineText, copyInText, DbLayout, DbLine, DECOMMISSION_LINES, decommissionOutcome, DISMISS_LINES, dismissOutcome, emptyBackupsText,
  restoreConfirmLines, restoreOutcome, restoreSharersText, RESTORE_TIP, scheduleOutcome, fleetBackupErrorLines, formatBackupSize, hostDataRoot, hostPathLines, layoutOf,
  memoryLineText, placeText, replicaLines, replicationLines, seedBannerLines, stateLineText, switchLines, timeIn, When,
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
}

export interface DatabaseView {
  body: string[];
  highlight?: number;
  keys: string;
  notice?: string;
}

export type DatabaseExit = { quit: true } | { leave: true } | { state: true } | undefined;

export interface DatabaseKey {
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
}

export const READ_LIMIT_MS = 15_000;
export const DB_EVERY_MS = 5_000;

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
  /** The schedule as last stored (the page's fleetBackupStored); null until the bot list carried it. */
  stored: { enabled: boolean; hour: number } | null = null;
  /** The hour moved with Left and Right and not saved yet. */
  hourDraft: number | null = null;
  private hourTimer: NodeJS.Timeout | null = null;
  // The list read the stored schedule came from; after a save it stays the answer's until a newer list read.
  private syncedBots: unknown[] | null = null;
  confirm: { lines: string[]; yes: string; run: () => void } | null = null;
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
  ) {
    this.hourSaveMs = opts.hourSaveMs ?? 1000;
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
    this.inFlight[kind] = Date.now();
    let r: Outcome<unknown>;
    try {
      r = await READERS[kind](this.client, this.botId, this.limitMs);
    } finally {
      delete this.inFlight[kind];
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

  private ask(lines: string[], yes: string, run: () => void): void {
    this.notice = null;
    this.confirm = { lines, yes, run };
    this.changed();
  }

  /** Runs one call with the keys waiting; the outcome goes to the notice and the bot list is read again. */
  private async act(text: string, escape: boolean, call: () => Promise<{ ok: boolean | null; text: string }>): Promise<void> {
    if (this.busy) return;
    const mine = { text, escape };
    this.busy = mine;
    this.notice = null;
    this.changed();
    const result = await call();
    if (this.busy === mine) this.busy = null;
    this.report(result);
    if (this.closed) return;
    this.say(result.text);
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

  key(input: string, key: DatabaseKey): DatabaseExit {
    if (this.confirm) {
      const c = this.confirm;
      this.confirm = null;
      if (input.toLowerCase() === 'y') c.run();
      else this.say('Cancelled: nothing was sent.');
      return undefined;
    }
    if (this.busy) return key.escape && this.busy.escape ? { leave: true } : undefined;
    if (key.escape) return { leave: true };
    const k = input.toLowerCase();
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
    if (this.confirm) {
      return { body: [`Database: ${botName(bot)}`, '', ...this.confirm.lines.flatMap((l) => ['', ...wrap(l, inner)]).slice(1)], keys: `${this.confirm.yes}  any other key Cancel`, notice };
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
