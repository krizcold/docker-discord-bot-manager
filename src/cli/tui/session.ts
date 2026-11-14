import { Client } from '../client';
import type { ConfigEditor } from './configedit';
import type { EnvEditor } from './envedit';
import type { InstallWizard } from './install';
import type { VaultScreen } from './vaultscreen';
import {
  ActionKind, ActionResult, Bot, botName, buildFrameLine, buildLogPath, followStream, lifecycleAction, listBots, StreamLines, stopBot,
} from './api';

export const LIST_EVERY_MS = 5000;

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
  held: { install?: InstallWizard; env?: EnvEditor; config?: ConfigEditor; vault?: VaultScreen } = {};
  version = 0;
  private listeners = new Set<() => void>();
  private timer: NodeJS.Timeout | null = null;
  private reading = false;
  private aborts = new Set<AbortController>();

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
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const a of this.aborts) a.abort();
    this.aborts.clear();
  }

  async refresh(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      const bots = await listBots(this.client);
      this.list = { bots, readAt: this.now(), error: null };
    } catch (err) {
      this.list = { ...this.list, error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.reading = false;
      this.changed();
    }
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
