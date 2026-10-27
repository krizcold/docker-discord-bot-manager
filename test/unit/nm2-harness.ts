// The NM2 rows' registry, backup folder and scheduler tick, under the DATA_DIR the test file set in vi.hoisted.
import * as fs from 'fs';
import * as path from 'path';
import { expect, vi } from 'vitest';

export const dataDir = (): string => process.env.DATA_DIR as string;
export const registryPath = (): string => path.join(dataDir(), 'instances.json');
export const dumpsDir = (id = 'a'): string => path.join(dataDir(), 'backups', id, 'fleet-postgres');

export const PRIMARY = { containerName: 'bot-a-postgres', user: 'app', db: 'app', volume: 'bot-a-pgdata', password: 'pw', image: 'postgres:16-alpine' };
export const REPLICA = {
  containerName: 'bot-a-replica', volume: 'bot-a-replica-data', user: 'app', db: 'app', slot: 's1',
  primaryHost: 'primary.example', primaryPort: 5432, publicHost: 'copy.example', hostPort: 15432, certHost: 'copy.example', seededAt: 0,
};

export function seedBot(record: Record<string, unknown>, id = 'a'): void {
  let current: { instances: Record<string, unknown> } = { instances: {} };
  try { current = JSON.parse(fs.readFileSync(registryPath(), 'utf-8')); } catch { /* none yet */ }
  current.instances[id] = { id, displayName: `Bot ${id}`, sanitizedName: `bot${id}`, sourceUrl: 'x', status: 'running', createdAt: new Date(Date.now() - 86400000).toISOString(), ...record };
  fs.writeFileSync(registryPath(), JSON.stringify(current, null, 2));
}

export function clearRegistry(): void {
  fs.writeFileSync(registryPath(), JSON.stringify({ instances: {} }));
}

export const stored = (id = 'a'): any => JSON.parse(fs.readFileSync(registryPath(), 'utf-8')).instances[id];

export const files = (id = 'a'): string[] => (fs.existsSync(dumpsDir(id)) ? fs.readdirSync(dumpsDir(id)).sort() : []);
export const dumps = (id = 'a'): string[] => files(id).filter(f => f.endsWith('.dump'));

/** Writes a dump and its counts file as a finished dump leaves them. */
export function putDump(name: string, opts: { id?: string; meta?: Record<string, unknown> | null; counts?: Record<string, number>; takenAt?: number; mtime?: number } = {}): void {
  const dir = dumpsDir(opts.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), 'dump-bytes');
  const counts = opts.counts ?? { '"public"."t"': 3 };
  if (opts.meta !== null) {
    const family = name.startsWith('copy-') ? 'copy' : 'main';
    const kind = /^(copy-)?hourly-/.test(name) ? 'hourly' : /^(copy-)?daily-/.test(name) ? 'daily' : name.startsWith('pre-') ? 'safety' : 'other';
    const meta = { file: name, takenAt: opts.takenAt ?? Date.now(), family, kind, inRecovery: family === 'copy', dataAt: null, dbBytes: 1000, tables: Object.keys(counts).length, rows: Object.values(counts).reduce((a, b) => a + b, 0), counts, ...(opts.meta ?? {}) };
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(meta));
  }
  if (opts.mtime) fs.utimesSync(path.join(dir, name), opts.mtime / 1000, opts.mtime / 1000);
}

export const stampText = (at: number): string => new Date(at).toISOString().replace(/[:.]/g, '-');

export async function restartedManager(): Promise<typeof import('../../src/instance/fleetBackup')> {
  vi.resetModules();
  return import('../../src/instance/fleetBackup');
}

/** Starts the scheduler with its interval captured, so a test runs each tick by hand. */
export function startedWithTick(fb: typeof import('../../src/instance/fleetBackup')): () => void {
  let tick: () => void = () => {};
  const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void) => { tick = fn; return 0; }) as unknown as typeof setInterval);
  fb.startFleetBackupScheduler();
  spy.mockRestore();
  fb.stopFleetBackupScheduler();
  return tick;
}

/** Runs one tick and answers its log lines once the tick and the test restore it started end. */
export async function tickOnce(fb: typeof import('../../src/instance/fleetBackup'), tick: () => void): Promise<string[]> {
  const lines: string[] = [];
  const spies = (['log', 'warn', 'error'] as const).map(k => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); }));
  try {
    tick();
    await vi.waitFor(() => expect(fb.isTickRunning() || fb.isTestRunning()).toBe(false), { timeout: 4000, interval: 5 });
  } finally { spies.forEach(s => s.mockRestore()); }
  return lines;
}

/** Captures the log lines a call writes. */
export async function logged<T>(run: () => Promise<T> | T): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const spies = (['log', 'warn', 'error'] as const).map(k => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); }));
  try {
    const value = await run();
    return { value, lines };
  } finally { spies.forEach(s => s.mockRestore()); }
}

/** A local time today (or another day) as epoch ms. */
export const localAt = (hour: number, minute = 0, dayOffset = 0): number => {
  const d = new Date(2026, 9, 27 + dayOffset, hour, minute, 0, 0);
  return d.getTime();
};

let nowSpy: { mockReturnValue: (v: number) => unknown; mockRestore: () => void } | null = null;

/** Fixes Date.now at ms until realNow(); timers keep running. */
export function setNow(ms: number): void {
  if (!nowSpy) nowSpy = vi.spyOn(Date, 'now') as unknown as typeof nowSpy;
  nowSpy!.mockReturnValue(ms);
}

export function realNow(): void {
  nowSpy?.mockRestore();
  nowSpy = null;
}
