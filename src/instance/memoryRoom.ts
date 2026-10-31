/**
 * The memory reading for resharding beside the running shards: the machine's
 * available memory from /proc/meminfo against the bot's app container's use.
 */
import * as fs from 'fs';

export const RESHARD_RESERVE_MB = 256;

export const MEMORY_FILES = {
  meminfo: '/proc/meminfo',
  mountinfo: '/proc/self/mountinfo',
  cgroupMax: '/sys/fs/cgroup/memory.max',
  cgroupV1: '/sys/fs/cgroup/memory/memory.limit_in_bytes',
};

const OWN_LIMIT = "this container sees its own memory limit, not the machine's";
const NO_USE = "docker reported no memory use for the bot's container";

export type HostMemory = { ok: true; availableMb: number } | { ok: false; error: string };

export type AppMemory = { running: false } | { running: true; useMb: number; limitMb: number } | { running: null; error: string };

export type MemoryReading = { running: false } | { running: true | null; room: boolean | null; useMb: number | null; freeMb: number | null; error?: string; at: string };

export function readHostMemory(files = MEMORY_FILES): HostMemory {
  let text: string;
  try {
    text = fs.readFileSync(files.meminfo, 'utf8');
  } catch (err) {
    return { ok: false, error: `/proc/meminfo could not be read (${(err as NodeJS.ErrnoException).code || String(err)})` };
  }
  const kb = (key: string): number | null => {
    const m = new RegExp(`^${key}:\\s+(\\d+) kB\\s*$`, 'm').exec(text);
    return m ? Number(m[1]) : null;
  };
  const available = kb('MemAvailable');
  if (available === null) return { ok: false, error: '/proc/meminfo has no MemAvailable line' };
  const total = kb('MemTotal');
  if (total === null) return { ok: false, error: '/proc/meminfo has no MemTotal line' };
  let mounts: string;
  try {
    mounts = fs.readFileSync(files.mountinfo, 'utf8');
  } catch (err) {
    return { ok: false, error: `/proc/self/mountinfo could not be read (${(err as NodeJS.ErrnoException).code || String(err)})` };
  }
  if (mounts.split('\n').some(line => line.split(' ')[4] === '/proc/meminfo')) return { ok: false, error: OWN_LIMIT };
  for (const file of [files.cgroupMax, files.cgroupV1]) {
    let limit = '';
    try { limit = fs.readFileSync(file, 'utf8').trim(); } catch { /* this cgroup version's file is absent */ }
    if (/^\d+$/.test(limit) && Number(limit) === total * 1024) return { ok: false, error: OWN_LIMIT };
  }
  return { ok: true, availableMb: Math.floor(available / 1024) };
}

export function memoryRoom(useMb: number, freeMb: number): boolean {
  return freeMb - RESHARD_RESERVE_MB >= useMb;
}

export function memoryReading(app: AppMemory, host: () => HostMemory, at = new Date()): MemoryReading {
  if (app.running === false) return { running: false };
  const when = at.toISOString();
  if (app.running === null) return { running: null, room: null, useMb: null, freeMb: null, error: app.error, at: when };
  if (!(app.useMb > 0)) return { running: true, room: null, useMb: null, freeMb: null, error: NO_USE, at: when };
  const useMb = Math.round(app.useMb);
  const h = host();
  if (!h.ok) return { running: true, room: null, useMb, freeMb: null, error: h.error, at: when };
  const freeMb = app.limitMb > 0 ? Math.min(h.availableMb, Math.floor(app.limitMb - app.useMb)) : h.availableMb;
  return { running: true, room: memoryRoom(useMb, freeMb), useMb, freeMb, at: when };
}
