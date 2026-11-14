import { Client } from '../client';
import { ActionResult, Bot, botName, MaintenanceInfo, MigrateView, orderState, Outcome, readMaintenance, readMigrate, startMigration, STATE_WAIT_MS } from './api';
import type { BotSource } from './database';
import {
  heldLineText, heldWarningText, KIND_NOTES, migrateAcceptedText, migrateConfirmText, migrateName, migrateRecordLines, stateLineFor, stateName, timeIn,
  When,
} from './dbtext';
import { editField, Field, field, FieldKey, showField } from './field';
import { wrap } from './install';

export interface StateOptions {
  /** The time limit of each read. */
  limitMs?: number;
  /** How long a state change's outcome event is waited for. */
  waitMs?: number;
  timeZone?: string;
}

export interface StateView {
  body: string[];
  highlight?: number;
  cursor?: { line: number; col: number };
  keys: string;
  notice?: string;
}

export type StateExit = { quit: true } | { leave: true } | undefined;

const STATES = ['running', 'maintenance', 'off'] as const;
type State = (typeof STATES)[number];
const MESSAGE_MAX = 1500;
const READ_LIMIT_MS = 15_000;

interface Line {
  text: string;
  focus?: boolean;
  col?: number;
}

/** The page's State window (stateWindowHtml to applyState) and its Migrate control; the frame passes it every key. */
export class StateScreen {
  info: Outcome<MaintenanceInfo> | null = null;
  mview: MigrateView | null = null;
  migrateError: string | null = null;
  choice: State = 'running';
  focus: 'choice' | 'message' = 'choice';
  message: Field = field();
  busy: string | null = null;
  pending = false;
  confirm: { lines: string[]; yes: string; run: () => void } | null = null;
  notice: string | null = null;
  progress: string[] = [];
  wsError: string | null = null;
  private loaded = false;
  private loads = 0;
  private closed = false;
  private ws: { close: () => void } | null = null;
  private readonly limitMs: number;
  private readonly waitMs: number;
  private readonly when: When;

  constructor(
    private client: Client,
    private changed: () => void,
    readonly botId: string,
    private source: BotSource,
    /** Takes each outcome, so it reaches the bot screen when this screen is closed. */
    private report: (result: ActionResult) => void,
    readonly from: 'bot' | 'database',
    opts: StateOptions = {},
  ) {
    this.limitMs = opts.limitMs ?? READ_LIMIT_MS;
    this.waitMs = opts.waitMs ?? STATE_WAIT_MS;
    this.when = timeIn(opts.timeZone);
  }

  private bot(): Bot {
    return this.source.bot(this.botId) ?? { id: this.botId };
  }

  private say(text: string | null): void {
    this.notice = text;
    this.changed();
  }

  open(): void {
    void this.load();
    this.listen();
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }

  // The route's opId is in no bot:migrate event, so every event for this bot is shown while the screen is open.
  private listen(): void {
    this.ws = this.client.openWs(
      (msg) => {
        if (this.closed || msg.type !== 'bot:migrate') return;
        const d = msg.data as { id?: unknown; text?: unknown; final?: unknown; migrate?: unknown; migrateLast?: { outcome?: unknown } | null } | null;
        if (!d || d.id !== this.botId) return;
        const text = typeof d.text === 'string' ? d.text : '';
        if (d.final) {
          // onBotMigrate (:3753): done only with no open record and a last outcome of done.
          const done = !d.migrate && d.migrateLast?.outcome === 'done';
          this.progress = [];
          this.report({ ok: done, text });
          this.say(done ? `Migration finished: ${text}` : `Migration did not finish: ${text}`);
        } else if (text) {
          this.progress = [...this.progress, text].slice(-5);
          this.changed();
        }
        void this.load();
      },
      undefined,
      (reason) => {
        if (this.closed) return;
        this.wsError = `can't follow the migration's progress here: the event channel closed (${reason}).`;
        this.changed();
      },
    );
  }

  // showStateWindow (:3847): the state, then the migrate view; a failed migrate read shows no Migrate control.
  async load(): Promise<void> {
    const n = ++this.loads;
    const r = await readMaintenance(this.client, this.botId, this.limitMs);
    if (this.closed || n !== this.loads) return;
    this.info = r;
    if (r.ok === true && !this.loaded) {
      this.loaded = true;
      this.choice = (STATES as readonly string[]).includes(r.value.state ?? '') ? (r.value.state as State) : 'running';
      this.message = field((r.value.message ?? '').slice(0, MESSAGE_MAX));
    }
    this.changed();
    if (r.ok !== true) return;
    const m = await readMigrate(this.client, this.botId, this.limitMs);
    if (this.closed || n !== this.loads) return;
    if (m.ok === true) {
      this.mview = m.value;
      this.migrateError = null;
    } else {
      this.mview = null;
      this.migrateError = m.ok === null ? `can't read the migration state: the manager did not answer (${m.text}).` : `can't read the migration state: ${m.text || 'the manager gave no reason'}.`;
    }
    this.changed();
  }

  private disabled(s: State): boolean {
    return s === 'maintenance' && this.info?.ok === true && this.info.value.kind === 'none';
  }

  private canMigrate(): boolean {
    return !!this.mview && !this.mview.hidden && !!this.mview.to;
  }

  key(input: string, key: FieldKey & { escape?: boolean }, forwardDelete = false): StateExit {
    if (this.confirm) {
      const c = this.confirm;
      this.confirm = null;
      if (input.toLowerCase() === 'y') c.run();
      else this.say('Cancelled: nothing was sent.');
      return undefined;
    }
    if (this.busy) return undefined;
    if (key.escape) return { leave: true };
    if (this.info?.ok !== true) {
      if (input.toLowerCase() === 'q') return { quit: true };
      return undefined;
    }
    if (key.tab) {
      this.focus = this.focus === 'choice' ? 'message' : 'choice';
      this.changed();
      return undefined;
    }
    if (key.return) {
      this.apply();
      return undefined;
    }
    if (this.focus === 'message') {
      const next = editField(this.message, input, key, forwardDelete);
      if (next) {
        this.message = next.text.length > MESSAGE_MAX ? { text: next.text.slice(0, MESSAGE_MAX), cursor: Math.min(next.cursor, MESSAGE_MAX) } : next;
        this.changed();
      }
      return undefined;
    }
    const k = input.toLowerCase();
    if (k === 'q') return { quit: true };
    if (k === 'm' && this.canMigrate()) {
      void this.migrate();
      return undefined;
    }
    if (key.upArrow || key.downArrow) {
      const order = STATES.filter((s) => !this.disabled(s));
      const at = Math.max(order.indexOf(this.choice), 0);
      this.choice = order[(at + (key.upArrow ? order.length - 1 : 1)) % order.length];
      this.changed();
    }
    return undefined;
  }

  // applyState (:3874): Off asks first when the bot holds changes it could not save.
  private apply(): void {
    const bot = this.bot();
    if (this.pending) {
      this.say(`A state change of ${botName(bot)} is running; its result shows here when it finishes.`);
      return;
    }
    const warning = this.choice === 'off' ? heldWarningText(bot, 'off') : '';
    if (warning) {
      this.confirm = { lines: [warning], yes: 'Y Off', run: () => this.send() };
      this.changed();
      return;
    }
    this.send();
  }

  private send(): void {
    const bot = this.bot();
    const name = botName(bot);
    this.busy = `Asked the manager to set ${name} to ${stateName(this.choice)}.`;
    this.notice = null;
    this.changed();
    void orderState(this.client, bot, this.choice, this.message.text, this.waitMs, () => {
      this.busy = null;
      this.pending = true;
      this.say(`Changing the state of ${name}; the result shows here when it finishes`);
    }).then((result) => {
      this.busy = null;
      this.pending = false;
      this.report(result);
      if (this.closed) return;
      this.say(result.text);
      void this.load();
    });
  }

  // startMigrate (:3798).
  private async migrate(): Promise<void> {
    const bot = this.bot();
    this.busy = 'Reading the migration.';
    this.notice = null;
    this.changed();
    const r = await readMigrate(this.client, this.botId, this.limitMs);
    this.busy = null;
    if (this.closed) return;
    if (r.ok !== true) {
      this.say(r.ok === null ? `No answer from the manager, so the migration can't start (${r.text}).` : r.text || "The manager refused the migration's state.");
      return;
    }
    const view = r.value;
    this.mview = view;
    if (view.hidden || !view.to) {
      this.say('This bot offers no migration.');
      return;
    }
    if (view.refusal) {
      this.say(view.refusal);
      return;
    }
    if (!view.record) {
      this.confirm = { lines: [migrateConfirmText(bot, view)], yes: 'Y Migrate', run: () => void this.post(view) };
      this.changed();
      return;
    }
    await this.post(view);
  }

  private async post(view: MigrateView): Promise<void> {
    this.busy = 'Starting the migration.';
    this.changed();
    const r = await startMigration(this.client, this.botId, view.to ?? '');
    this.busy = null;
    if (this.closed) return;
    if (r.ok === null) this.say(`No answer from the manager, so it can't confirm the migration started (${r.text}).`);
    else if (r.ok === false) this.say(r.text || 'The manager refused the migration.');
    else this.say(migrateAcceptedText(view, this.wsError !== null));
    void this.load();
  }

  private lines(inner: number): Line[] {
    const out: Line[] = [];
    const say = (text: string, indent = '') => {
      if (text) for (const w of wrap(text, inner, indent)) out.push({ text: w });
    };
    const bot = this.bot();
    out.push({ text: `State: ${botName(bot)}` });
    const r = this.info;
    if (!r) {
      say('Reading the state.');
      return out;
    }
    if (r.ok !== true) {
      say(r.ok === null ? `No answer from the manager, so the bot's state can't be shown (${r.text}).` : r.text || 'The manager refused to show the state.');
      return out;
    }
    const info = r.value;
    say(info.summary || '');
    if (info.lastError) say(`Last error: ${info.lastError}`);
    say(heldLineText(info.held));
    out.push({ text: '' });
    for (const s of STATES) {
      const mark = this.focus === 'choice' && this.choice === s ? '>' : ' ';
      out.push({ text: `${mark} (${this.choice === s ? '*' : ' '}) ${stateName(s)}${this.disabled(s) ? ' (not available)' : ''}`, focus: this.focus === 'choice' && this.choice === s });
      say(stateLineFor(s, info.kind), '      ');
    }
    say(KIND_NOTES[info.kind ?? ''] || '');
    out.push({ text: '' }, { text: 'Maintenance message' });
    const f = showField(this.message, inner);
    out.push({ text: f.text, ...(this.focus === 'message' ? { focus: true, col: f.col } : {}) });
    say(`Blank uses the bot's default maintenance text. Up to ${MESSAGE_MAX} characters. ${this.message.text.length} / ${MESSAGE_MAX}`);
    const v = this.mview;
    if (v && !v.hidden && v.to) {
      out.push({ text: '' });
      say(v.refusal ? `Migrate to ${migrateName(v.to)}: ${v.refusal}` : `M Migrate to ${migrateName(v.to)}: copy this bot's data to ${migrateName(v.to)} and switch to it.`);
      for (const l of migrateRecordLines(v, this.when)) say(l);
    }
    if (this.migrateError) say(this.migrateError);
    for (const p of this.progress) say(p);
    if (this.wsError) say(this.wsError);
    return out;
  }

  view(inner: number, room: number, outer?: string): StateView {
    const notice = this.notice ?? outer;
    const long = notice && notice.length > inner ? wrap(notice, inner) : null;
    const space = long ? Math.max(room - long.length - 1, 3) : room;
    const v = this.screen(inner, space, long ? undefined : notice ?? undefined);
    if (!long) return v;
    const body = v.body.slice(0, space);
    while (body.length < space) body.push('');
    return { ...v, body: [...body, '', ...long] };
  }

  private screen(inner: number, room: number, notice: string | undefined): StateView {
    if (this.confirm) {
      return { body: [`State: ${botName(this.bot())}`, '', ...this.confirm.lines.flatMap((l) => wrap(l, inner))], keys: `${this.confirm.yes}  any other key Cancel`, notice };
    }
    const all = this.lines(inner);
    const at = Math.max(all.findIndex((l) => l.focus), 0);
    const first = Math.max(0, Math.min(at - Math.floor(room / 2), all.length - room));
    const shown = all.slice(first, first + room);
    const body = shown.map((l) => l.text);
    if (this.busy) return { body, keys: 'Waiting for the manager', notice: notice ?? this.busy };
    if (this.info?.ok !== true) return { body, keys: 'Esc Back  Q Quit', notice };
    const focused = all[at];
    const mark = focused && focused.focus ? (focused.col !== undefined ? { cursor: { line: at - first, col: focused.col } } : { highlight: at - first }) : {};
    const keys = this.focus === 'message'
      ? 'Enter Apply  Tab States  Esc Back'
      : ['Up/Down Choose', 'Enter Apply', 'Tab Message', ...(this.canMigrate() ? ['M Migrate'] : []), 'Esc Back', 'Q Quit'].join('  ');
    return { body, ...mark, keys, notice };
  }
}
