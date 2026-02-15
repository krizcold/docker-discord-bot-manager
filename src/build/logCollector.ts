/**
 * Build Log Collector
 * EventEmitter-based log collector for real-time build log streaming.
 * Adapted from Yundera GitHub Compiler's build-queue.ts pattern.
 *
 * Fixes the Yundera log accumulation bug: logs are always cleared
 * when a new build starts, so old logs never leak into new sessions.
 */

import { EventEmitter } from 'events';

export interface BuildLogEntry {
  message: string;
  type: 'system' | 'info' | 'warning' | 'error' | 'success';
  timestamp: number;
}

export class LogCollector extends EventEmitter {
  private logs: BuildLogEntry[] = [];
  private maxLogs = 2000;
  public botId: string;

  constructor(botId: string) {
    super();
    this.botId = botId;
    this.setMaxListeners(10);
  }

  addLog(message: string, type: BuildLogEntry['type'] = 'info'): void {
    const entry: BuildLogEntry = {
      message,
      type,
      timestamp: Date.now()
    };

    this.logs.push(entry);

    if (this.logs.length > this.maxLogs) {
      this.logs.splice(0, this.logs.length - this.maxLogs);
    }

    this.emit('log', entry);
  }

  getLogs(): BuildLogEntry[] {
    return [...this.logs];
  }

  clear(): void {
    this.logs = [];
  }

  destroy(): void {
    this.removeAllListeners();
    this.logs = [];
  }
}

/**
 * Global registry of per-bot log collectors.
 * One collector per bot — always cleared on new build start.
 */
class LogCollectorRegistry {
  private collectors = new Map<string, LogCollector>();

  /**
   * Get or create a log collector for a bot.
   * Does NOT clear — call clear() explicitly when starting a new build.
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
   * Get collector only if it exists (for SSE endpoint — don't create empty ones)
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
