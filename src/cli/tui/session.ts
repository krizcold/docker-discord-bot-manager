import { Client } from '../client';
import type { CodeField, CodeShown } from './codes';
import type { ConfigEditor } from './configedit';
import type { DatabaseScreen } from './database';
import type { EnvEditor } from './envedit';
import type { InstallWizard } from './install';
import type { StateScreen } from './statescreen';
import type { VaultScreen } from './vaultscreen';
import {
  ActionKind, ActionResult, Bot, botName, buildFrameLine, buildLogPath, followStream, lifecycleAction, listBots, Outcome, readOrphanBackups, readReplica,
  StreamLines, stopBot,
} from './api';

export const LIST_EVERY_MS = 5000;

/** followLostProvisioning (index.html:3258): 20 reads of the copy's state, 3 s apart. */
export const LOST_CHECK = { reads: 20, everyMs: 3000 };
const ORPHAN_LIMIT_MS = 15_000;

export type OrphanRead = Outcome<{ folders?: Array<{ id: string; dumps: number | null; folder: string }> }>;

export interface ListState {
  bots: Bot[];
  readAt: number | null;
  error: string | null;
}

export interface ActionRun {
  kind: ActionKind;
  botId: string;
  name: string;
  result: ActionResult | null;
  progress: StreamLines | null;
}

/** What outlives one Ink instance: the bot list, its timer and the actions in flight (a hand-off remounts the frame). */
export class Session {
  list: ListState = { bots: [], readAt: null, error: null };
  runs = new Map<string, ActionRun>();
  notice: string | null = null;
  /** The open install form and editors, kept here so they outlive the remount after a hand-off. */
  held: { install?: InstallWizard; env?: EnvEditor; config?: ConfigEditor; vault?: VaultScreen; database?: DatabaseScreen; state?: StateScreen } = {};
  /** The dump folders of removed bots, read after each successful list read as the page's loadOrphanBackups does. */
  orphans: OrphanRead | null = null;
  /** The Database screen's call running per bot, so a screen opened again during a held restore waits for it. */
  dbBusy = new Map<string, { text: string; escape: boolean }>();
  /** The code field that has focus: it takes the keys first and receives a bracketed paste. */
  codeFocus: CodeField | null = null;
  /** The bots whose last provision or re-seed got no answer and are being read again (the page's provisionChecking). */
  lostChecks = new Set<string>();
  lostCheck = { ...LOST_CHECK };
  /** A move code per bot that was made while its code screen could not open; dropped when that screen opens. */
  moveCodes = new Map<string, CodeShown>();
  version = 0;
  private listeners = new Set<() => void>();
  private timer: NodeJS.Timeout | null = null;
  private reading = false;
  private aborts = new Set<AbortController>();
  private stopped = false;

  constructor(readonly client: Client, private now: () => number = Date.now) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  snapshot = (): number => this.version;

  changed(): void {
    this.version++;
    for (const fn of [...this.listeners]) fn();
  }

  start(everyMs = LIST_EVERY_MS): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), everyMs);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const a of this.aborts) a.abort();
    this.aborts.clear();
    this.held.database?.close();
    this.held.state?.close();
    this.codeFocus = null;
    this.moveCodes.clear();
  }

  /**
   * followLostProvisioning (index.html:3258): reads the copy's state until a seed run or a stopped one shows, or the
   * reads run out; `end` gets true when one showed, false when none did. One check per bot at a time.
   */
  async followLost(botId: string, limitMs: number, end: (started: boolean) => void): Promise<void> {
    if (this.lostChecks.has(botId)) return;
    this.lostChecks.add(botId);
    this.changed();
    void this.refresh();
    try {
      for (let i = 0; i < this.lostCheck.reads; i++) {
        const r = await readReplica(this.client, botId, limitMs);
        if (this.stopped) return;
        const rep = r.ok === true ? r.value.replica : null;
        if (rep && (rep.provisioning || rep.parkedSeed)) {
          void this.refresh();
          end(true);
          return;
        }
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, this.lostCheck.everyMs);
          t.unref?.();
        });
        if (this.stopped) return;
      }
      end(false);
    } finally {
      this.lostChecks.delete(botId);
      this.changed();
    }
  }

  focusCode(f: CodeField | null): void {
    this.codeFocus = f;
    this.changed();
  }

  async refresh(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      const bots = await listBots(this.client);
      this.list = { bots, readAt: this.now(), error: null };
      void this.readOrphans();
    } catch (err) {
      this.list = { ...this.list, error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.reading = false;
      this.changed();
    }
  }

  private orphanSeq = 0;

  private async readOrphans(): Promise<void> {
    const seq = ++this.orphanSeq;
    const r = await readOrphanBackups(this.client, ORPHAN_LIMIT_MS);
    if (seq !== this.orphanSeq) return;
    this.orphans = r;
    this.changed();
  }

  bot(id: string | undefined): Bot | undefined {
    return id === undefined ? undefined : this.list.bots.find((b) => b.id === id);
  }

  busy(botId: string): boolean {
    const run = this.runs.get(botId);
    return !!run && run.result === null;
  }

  async act(bot: Bot, kind: ActionKind): Promise<ActionResult | null> {
    if (this.busy(bot.id)) return null;
    const run: ActionRun = { kind, botId: bot.id, name: botName(bot), result: null, progress: null };
    this.runs.set(bot.id, run);
    this.changed();
    let result: ActionResult;
    if (kind === 'stop') {
      result = await stopBot(this.client, bot);
    } else {
      const follows = kind === 'build' || kind === 'update';
      result = await lifecycleAction(this.client, bot, kind, follows ? () => this.follow(run, bot) : undefined);
    }
    run.result = result;
    this.notice = result.text;
    this.changed();
    void this.refresh();
    return result;
  }

  private follow(run: ActionRun, bot: Bot): void {
    const progress: StreamLines = { lines: [], end: null };
    run.progress = progress;
    const abort = new AbortController();
    this.aborts.add(abort);
    void followStream(this.client, buildLogPath(bot), buildFrameLine, progress, () => this.changed(), abort.signal)
      .finally(() => this.aborts.delete(abort));
  }

  /** Follows a stream for a view; the returned function stops it. */
  watch(path: string, parse: Parameters<typeof followStream>[2], state: StreamLines): () => void {
    const abort = new AbortController();
    this.aborts.add(abort);
    void followStream(this.client, path, parse, state, () => this.changed(), abort.signal)
      .finally(() => this.aborts.delete(abort));
    return () => {
      abort.abort();
      this.aborts.delete(abort);
    };
  }
}
