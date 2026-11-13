import * as containerManager from '../docker/containerManager';
import * as dockerClient from '../docker/dockerClient';
import { callAppHook, hasAppHooks } from './appHookClient';
import { memoryReading, readHostMemory } from './memoryRoom';
import { InstanceConfig } from '../types';

export const MEMORY_SEND_TIMING = { firstTickMs: 30_000, tickMs: 30_000, everyMs: 300_000, freshMs: 180_000, hookMs: 10_000 };

export type MemorySendOutcome = { kind: 'taken'; at: number } | { kind: 'no-hook'; at: number } | { kind: 'failed'; at: number; error: string; unknown?: true };

type Entry = { containerKey: string | null; firstSeenAt: number; triedAt?: number; outcome?: MemorySendOutcome };

const entries = new Map<string, Entry>();

export function memorySendState(botId: string): MemorySendOutcome | null {
  return entries.get(botId)?.outcome ?? null;
}

function due(e: Entry, now: number): boolean {
  if (e.triedAt === undefined) return true;
  const since = now - e.triedAt;
  if (since >= MEMORY_SEND_TIMING.everyMs) return true;
  // A container that just started serves its hooks only once its web server listens.
  return e.outcome?.kind === 'failed' && since >= MEMORY_SEND_TIMING.tickMs && now - e.firstSeenAt < MEMORY_SEND_TIMING.freshMs;
}

async function sendOne(instance: InstanceConfig, now: number): Promise<void> {
  if (!hasAppHooks(instance)) return;
  const containerId = await containerManager.runningAppContainer(instance);
  if (containerId === null) { entries.delete(instance.id); return; }
  if (containerId === undefined) return;
  const startedAt = await dockerClient.containerStartedAt(containerId);
  // An unread start time counts as a restart: the bot may have lost its reading.
  const containerKey = startedAt === null ? null : `${containerId}@${startedAt}`;
  let e = entries.get(instance.id);
  if (!e || containerKey === null || e.containerKey !== containerKey) {
    e = { containerKey, firstSeenAt: now, outcome: e?.outcome };
    entries.set(instance.id, e);
  }
  if (!due(e, now)) return;
  const m = memoryReading(await containerManager.getAppMemory(instance), () => readHostMemory());
  if (m.running === false) return;
  // An app container over its own limit reads a negative free figure, which the bot refuses.
  const body: Record<string, unknown> = { room: m.room, useMb: m.useMb, freeMb: m.freeMb === null ? null : Math.max(0, m.freeMb), at: m.at };
  if (m.room === null && typeof m.error === 'string') body.error = m.error;
  const result = await callAppHook(instance, 'memory', 'POST', body, MEMORY_SEND_TIMING.hookMs);
  const outcome: MemorySendOutcome = result.ok ? { kind: 'taken', at: now }
    : result.status === 404 ? { kind: 'no-hook', at: now }
    : result.unknown ? { kind: 'failed', at: now, unknown: true, error: `no answer within ${Math.round(MEMORY_SEND_TIMING.hookMs / 1000)} s` }
    : { kind: 'failed', at: now, error: result.error ?? 'no answer' };
  const label = (o?: MemorySendOutcome) => o && (o.kind === 'failed' && o.unknown ? 'unknown' : o.kind);
  const last = label(e.outcome);
  e.triedAt = now;
  e.outcome = outcome;
  if (label(outcome) === last) return;
  if (outcome.kind === 'failed' && outcome.unknown) console.warn(`[Memory] ${instance.displayName}: can't confirm the bot got the memory reading: ${outcome.error}`);
  else if (outcome.kind === 'no-hook') console.warn(`[Memory] ${instance.displayName}: this bot's build does not take the memory reading (it answered 404)`);
  else if (outcome.kind === 'failed') console.warn(`[Memory] ${instance.displayName}: the memory reading was not delivered: ${outcome.error}`);
  else if (last) console.log(`[Memory] ${instance.displayName}: the bot took the memory reading`);
}

let ticking = false;

/** One pass over every instance, in sequence; a pass that is still running is not started twice. */
export async function runMemorySendTick(now = Date.now()): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    for (const instance of containerManager.getAllBots()) {
      try {
        await sendOne(instance, now);
      } catch (err) {
        console.error(`[Memory] ${instance.displayName}: the send failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    ticking = false;
  }
}

let firstTimer: ReturnType<typeof setTimeout> | null = null;
let interval: ReturnType<typeof setInterval> | null = null;

export function startMemorySend(): void {
  if (firstTimer || interval) return;
  firstTimer = setTimeout(() => {
    firstTimer = null;
    void runMemorySendTick();
    interval = setInterval(() => { void runMemorySendTick(); }, MEMORY_SEND_TIMING.tickMs);
  }, MEMORY_SEND_TIMING.firstTickMs);
}

export function stopMemorySend(): void {
  if (firstTimer) clearTimeout(firstTimer);
  if (interval) clearInterval(interval);
  firstTimer = null;
  interval = null;
}
