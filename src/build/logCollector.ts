/**
 * Build Log Collector
 * EventEmitter-based log collector for real-time build log streaming.
 *
 * Holds one operation session per bot: beginOp() clears the buffer and marks
 * the session running; endOp() records the outcome so late-connecting SSE
 * clients can replay history and still receive the terminal frame.
 * Progress entries (keyed) are coalesced in place so redraw-style docker
 * output occupies one entry instead of flooding the ring buffer.
 */

import { EventEmitter } from 'events';

export interface BuildLogEntry {
  message: string;
  type: 'system' | 'info' | 'warning' | 'error' | 'success' | 'progress';
  timestamp: number;
  key?: string;
}

export type OpState = 'idle' | 'running' | 'done' | 'failed';

export class LogCollector extends EventEmitter {
  private logs: BuildLogEntry[] = [];
  private maxLogs = 2000;
  private progressIndex = new Map<string, BuildLogEntry>();
  public botId: string;

  public opState: OpState = 'idle';
  public opName: string | null = null;
  public opStartedAt = 0;
  public opEndedAt = 0;
  public opError: string | null = null;
  public lastActivityAt = 0;

  constructor(botId: string) {
    super();
    this.botId = botId;
    this.setMaxListeners(50);
  }

  beginOp(op: string): void {
    this.logs = [];
    this.progressIndex.clear();
    this.opState = 'running';
    this.opName = op;
    this.opStartedAt = Date.now();
    this.opEndedAt = 0;
    this.opError = null;
    this.lastActivityAt = this.opStartedAt;
    this.emit('op');
  }

  endOp(outcome: 'done' | 'failed', error?: string): void {
    this.opState = outcome;
    this.opEndedAt = Date.now();
    this.opError = error || null;
    this.emit('op');
  }

  addLog(message: string, type: BuildLogEntry['type'] = 'info', key?: string): void {
    const timestamp = Date.now();
    this.lastActivityAt = timestamp;

    if (key) {
      const existing = this.progressIndex.get(key);
      if (existing) {
        existing.message = message;
        existing.timestamp = timestamp;
        this.emit('log', existing);
        return;
      }
      const entry: BuildLogEntry = { message, type: 'progress', timestamp, key };
      this.progressIndex.set(key, entry);
      this.pushEntry(entry);
      return;
    }

    this.pushEntry({ message, type, timestamp });
  }

  private pushEntry(entry: BuildLogEntry): void {
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      const evicted = this.logs.splice(0, this.logs.length - this.maxLogs);
      for (const old of evicted) {
        if (old.key && this.progressIndex.get(old.key) === old) {
          this.progressIndex.delete(old.key);
        }
      }
    }
    this.emit('log', entry);
  }

  getLogs(): BuildLogEntry[] {
    return [...this.logs];
  }

  clear(): void {
    this.logs = [];
    this.progressIndex.clear();
  }

  destroy(): void {
    this.removeAllListeners();
    this.logs = [];
    this.progressIndex.clear();
  }
}

/**
 * Global registry of per-bot log collectors.
 */
class LogCollectorRegistry {
  private collectors = new Map<string, LogCollector>();

  /**
   * Get or create a log collector for a bot.
   */
  get(botId: string): LogCollector {
    let collector = this.collectors.get(botId);
    if (!collector) {
      collector = new LogCollector(botId);
      this.collectors.set(botId, collector);
    }
    return collector;
  }

  /**
   * Get collector only if it exists (for SSE endpoint; don't create empty ones)
   */
  getIfExists(botId: string): LogCollector | undefined {
    return this.collectors.get(botId);
  }

  /**
   * Remove a collector (on bot deletion)
   */
  remove(botId: string): void {
    const collector = this.collectors.get(botId);
    if (collector) {
      collector.destroy();
      this.collectors.delete(botId);
    }
  }
}

/** Singleton registry */
export const logCollectors = new LogCollectorRegistry();
