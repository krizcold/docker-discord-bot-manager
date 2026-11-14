import { expect, vi } from 'vitest';
import { createElement } from 'react';
import * as ink from 'ink';
import { render } from 'ink-testing-library';
import { createApp } from '../../src/cli/tui/app';
import type { DatabaseOptions } from '../../src/cli/tui/database';
import { Session } from '../../src/cli/tui/session';
import { botList, fake, Fake, Reply } from './m2-fake';
import {
  backupsBody, connectionsBody, copyBot, entry, mainBot, memoryBody, migrateBody, orphansBody, replicaBody, replicationOn, stateInfo, switchBody, T0,
} from './m4-fake';
import { copyOf, copyRecorded } from './m5-fake';

// The rows of part 4 share this kit: a fake client with /ws as client.openWs gives it, and the frame.

const App = createApp(ink);
export const ESC = '\u001B';
export const ENTER = '\r';
export const DOWN = '\u001B[B';
export const PGDN = '\u001B[6~';
export const START = '\x1b[200~';
export const END = '\x1b[201~';
export const WAIT_MS = 10_000;
export const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
export const flat = (frame: string) => frame.split('\n').map((l) => l.replace(/^\| /, '').replace(/\s*\|$/, '').trim()).join(' ').replace(/\s+/g, ' ');
export const bars = (frame: string) => frame.split('\n').slice(-5, -1).join(' ');
/** The frame's lines inside the side bars, trailing spaces dropped. */
export const inside = (frame: string) => frame.split('\n').slice(1, -1).map((l) => l.slice(2, -2).trimEnd());

export const B = '/api/bots/b1';
export const HANDOVER = `${B}/fleet-handover`;
export const TAKEOVER = `${B}/fleet-takeover`;
export const KEEP = `${B}/fleet-keep-main`;
export const RESEED_STALE = `${B}/fleet-reseed`;
export const SWITCH = `${B}/fleet-switch`;
export const REPLICA = `${B}/fleet-replica`;

/** A reply the row releases when it wants. */
export const held = () => {
  let release: (r: Reply | Error) => void = () => undefined;
  const answer = () => new Promise<Reply | Error>((r) => {
    release = r;
  });
  return { answer: answer as () => Promise<Reply>, release: (r: Reply | Error) => release(r) };
};

export interface WsFake extends Omit<Fake, 'on'> {
  on: (method: string, path: string, answer: Reply | ((body: unknown) => Reply | Promise<Reply>)) => WsFake;
  /** Sends a frame to every open /ws, as broadcastToClients does. */
  emit: (type: string, data: unknown) => void;
  /** Closes every open /ws from the manager's side. */
  drop: (reason: string) => void;
  /** When set, /ws fails to open with this reason. */
  failOpen: string | null;
  opens: number;
  live: () => number;
}

export function wsFake(): WsFake {
  const f = fake() as unknown as WsFake;
  const open = new Map<(msg: { type: string; data: unknown }) => void, ((reason: string) => void) | undefined>();
  f.failOpen = null;
  f.opens = 0;
  f.live = () => open.size;
  f.emit = (type, data) => {
    for (const l of [...open.keys()]) l({ type, data });
  };
  f.drop = (reason) => {
    for (const [l, c] of [...open]) {
      open.delete(l);
      c?.(reason);
    }
  };
  (f.client as unknown as { openWs: unknown }).openWs = (onMessage: (msg: { type: string; data: unknown }) => void, onOpen?: () => void, onClose?: (r: string) => void) => {
    f.opens++;
    setTimeout(() => {
      if (f.failOpen) onClose?.(f.failOpen);
      else {
        open.set(onMessage, onClose);
        onOpen?.();
      }
    }, 1);
    return { close: () => void open.delete(onMessage) };
  };
  return f;
}

export const mainLaneBot = (fleetDb: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => mainBot({
  status: 'stopped', fleetDb: { containerName: 'smdb-db-b1', replication: { publicHost: 'db.example.net', hostPort: 15432 }, ...fleetDb }, ...over,
});

export function mainRoutes(over: { bot?: unknown; switch?: Reply | (() => Reply) } = {}): WsFake {
  return wsFake()
    .on('GET', '/api/bots', botList([over.bot ?? mainLaneBot()]))
    .on('GET', '/api/bots/fleet/orphan-backups', orphansBody())
    .on('GET', `${B}/maintenance`, stateInfo())
    .on('GET', `${B}/memory`, memoryBody())
    .on('GET', `${B}/fleet-connections`, connectionsBody())
    .on('GET', REPLICA, replicaBody())
    .on('GET', `${B}/fleet-backups`, backupsBody([entry('hourly-2026-11-14T09-00-00-000Z.dump')]))
    .on('GET', `${B}/fleet-replication`, replicationOn())
    .on('GET', SWITCH, over.switch ?? switchBody({ copies: [copyOf('yundera')] }))
    .on('GET', `${B}/migrate`, migrateBody());
}

export function copyRoutes(over: { bot?: unknown; replica?: Reply; switch?: Reply } = {}): WsFake {
  return wsFake()
    .on('GET', '/api/bots', botList([over.bot ?? copyBot({ fleetDbReplica: { containerName: 'smdb-replica-b1', slot: 'smdb_copy_b1' } })]))
    .on('GET', '/api/bots/fleet/orphan-backups', orphansBody())
    .on('GET', `${B}/maintenance`, stateInfo())
    .on('GET', `${B}/memory`, memoryBody())
    .on('GET', REPLICA, over.replica ?? replicaBody(copyRecorded()))
    .on('GET', `${B}/fleet-backups`, backupsBody([]))
    .on('GET', SWITCH, over.switch ?? switchBody())
    .on('GET', `${B}/migrate`, migrateBody());
}

export interface StartOpts {
  rows?: number;
  columns?: number;
  db?: DatabaseOptions;
  check?: { reads: number; everyMs: number };
}

export const opened: Array<{ unmount: () => void; session: Session }> = [];

export function closeAll(): void {
  for (const o of opened.splice(0)) {
    o.unmount();
    o.session.stop();
  }
}

export interface V {
  stdin: { write: (data: string) => void };
  session: Session;
  frame: () => string;
  frames: string[];
  press: (...keys: string[]) => Promise<void>;
  until: (text: string) => Promise<void>;
  untilFn: (test: () => boolean) => Promise<void>;
  /** Gives the terminal a new size, as a window resize does. */
  resize: (columns: number, rows: number) => Promise<void>;
}

export async function start(f: Fake | WsFake, opts: StartOpts = {}): Promise<V> {
  const session = new Session(f.client, () => T0);
  session.lostCheck = opts.check ?? { reads: 4, everyMs: 30 };
  await session.refresh();
  const view = render(createElement(App, {
    machine: 'box1', session, onHandOff: vi.fn(), now: () => T0, writeMode: () => undefined,
    databaseOptions: { everyMs: 60_000, limitMs: 2000, env: { HOST_DATA_DIR: '/srv/smdb/data' }, timeZone: 'UTC', ...opts.db },
    stateOptions: { limitMs: 2000, waitMs: 1000 },
  }));
  (view.stdout as unknown as { rows: number }).rows = opts.rows ?? 50;
  Object.defineProperty(view.stdout, 'columns', { value: opts.columns ?? 120, configurable: true });
  view.stdout.emit('resize');
  opened.push({ unmount: () => view.unmount(), session });
  await tick();
  const frames: string[] = [];
  const frame = () => {
    const now = view.lastFrame() ?? '';
    frames.push(now);
    return now;
  };
  const press = async (...keys: string[]) => {
    for (const k of keys) {
      view.stdin.write(k);
      await tick();
    }
  };
  const until = async (text: string) => {
    for (const end = Date.now() + WAIT_MS; Date.now() < end && !flat(frame()).includes(text);) await tick(20);
    expect(flat(frame())).toContain(text);
  };
  const untilFn = async (test: () => boolean) => {
    for (const end = Date.now() + WAIT_MS; Date.now() < end && !test();) await tick(20);
    expect(test()).toBe(true);
  };
  const resize = async (columns: number, rows: number) => {
    (view.stdout as unknown as { rows: number }).rows = rows;
    Object.defineProperty(view.stdout, 'columns', { value: columns, configurable: true });
    view.stdout.emit('resize');
    await tick();
  };
  return { stdin: view.stdin, session, frame, frames, press, until, untilFn, resize };
}

export async function openDb(v: V) {
  for (const end = Date.now() + WAIT_MS; Date.now() < end && !flat(v.frame()).includes('Database: mybot');) {
    await v.press('d');
    await tick(50);
  }
  await v.until('Database: mybot');
}

export async function toDb(f: Fake | WsFake, opts: StartOpts = {}) {
  const v = await start(f, opts);
  await v.press(ENTER);
  await v.until('Name mybot');
  await openDb(v);
  return v;
}

/** Opens the Actions list and takes the row whose label starts with `label`. */
export async function take(v: V, label: string) {
  await v.untilFn(() => bars(v.frame()).includes('A Actions'));
  await v.press('a');
  await v.until('Actions: mybot');
  await v.untilFn(() => (v.session.held.database?.actionRows() ?? []).some((r) => r.label.startsWith(label)));
  for (let i = 0; i < 12 && !(v.frame().split('\n').find((l) => l.includes(`> ${label}`))); i++) await v.press(DOWN);
  expect(v.frame()).toContain(`> ${label}`);
  await v.press(ENTER);
}

export const calls = (f: Fake | WsFake, method: string, path: string) => f.calls.filter((c) => c.method === method && c.path === path);
export const db = (v: V) => v.session.held.database!;

/** Pages a dialog with Down until `yes` is offered, keeping every line the dialog showed; Y must do nothing before. */
export async function readWhole(v: V, yes: string, columns: number): Promise<string[]> {
  const seen = new Set<string>();
  for (const end = Date.now() + WAIT_MS; Date.now() < end;) {
    const fr = v.frame();
    for (const l of fr.split('\n')) expect(l.length).toBeLessThanOrEqual(columns - 1);
    for (const l of inside(fr)) seen.add(l);
    if (bars(fr).includes(yes)) break;
    await v.press(DOWN);
  }
  expect(bars(v.frame())).toContain(yes);
  return [...seen];
}
