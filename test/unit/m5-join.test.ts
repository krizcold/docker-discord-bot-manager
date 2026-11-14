import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import * as ink from 'ink';
import { render } from 'ink-testing-library';
import { createApp, InkApi } from '../../src/cli/tui/app';
import { CodeField, codeLines, PASTE_OFF, PASTE_ON } from '../../src/cli/tui/codes';
import type { DatabaseOptions } from '../../src/cli/tui/database';
import { editHandOff, runTui } from '../../src/cli/tui/run';
import { Session } from '../../src/cli/tui/session';
import { botList, fake, Fake, noAnswer, ok, Reply } from './m2-fake';
import {
  backupsBody, connectionsBody, entry, failed500, mainBot, maintenanceBody, memoryBody, orphansBody, replicaBody, replicationOff, replicationOn,
  switchBody, T0,
} from './m4-fake';
import { JOIN_CODE, joinCodeBody, joinFailed500, joinNotFound, joinNotJson, JOIN_REFUSALS, joinRefused } from './m5-fake';

const App = createApp(ink);
vi.setConfig({ testTimeout: 30_000 });
const ESC = '\u001B';
const ENTER = '\r';
const DOWN = '\u001B[B';
const START = '\x1b[200~';
const END = '\x1b[201~';

// Waits end by wall time, not by a count of ticks (M4 fix 1c).
const WAIT_MS = 10_000;
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const flat = (frame: string) => frame.split('\n').map((l) => l.replace(/^\| /, '').replace(/\s*\|$/, '').trim()).join(' ').replace(/\s+/g, ' ');

const JOIN_PATH = (id: string) => `/api/bots/${id}/fleet-replication/join-code`;
// Pieces of the code no other text holds: any of them in a frame or a store means the code leaked.
const PIECES = [JOIN_CODE.slice(10, 40), JOIN_CODE.slice(200, 230), JOIN_CODE.slice(-30)];
const holdsCode = (text: string) => text.includes(JOIN_CODE) || PIECES.some((p) => text.includes(p));

function dbRoutes(f: Fake, id: string, replication: Reply = replicationOn()): Fake {
  const B = `/api/bots/${id}`;
  return f
    .on('GET', `${B}/maintenance`, maintenanceBody())
    .on('GET', `${B}/memory`, memoryBody())
    .on('GET', `${B}/fleet-connections`, connectionsBody())
    .on('GET', `${B}/fleet-replica`, replicaBody())
    .on('GET', `${B}/fleet-backups`, backupsBody([entry('hourly-2026-11-14T09-00-00-000Z.dump')]))
    .on('GET', `${B}/fleet-replication`, replication)
    .on('GET', `${B}/fleet-switch`, switchBody());
}

function routes(join: Reply | (() => Reply | Promise<Reply>) = joinCodeBody(), replication: Reply = replicationOn()): Fake {
  const f = fake()
    .on('GET', '/api/bots', botList([mainBot(), mainBot({ id: 'b2', displayName: 'otherbot' })]))
    .on('GET', '/api/bots/fleet/orphan-backups', orphansBody());
  dbRoutes(f, 'b1', replication);
  dbRoutes(f, 'b2');
  return f.on('GET', JOIN_PATH('b1'), join).on('GET', JOIN_PATH('b2'), joinCodeBody());
}

interface StartOpts {
  rows?: number;
  columns?: number;
  db?: DatabaseOptions;
  canHandOff?: boolean;
}

const opened: Array<{ unmount: () => void; session: Session }> = [];

afterEach(() => {
  for (const o of opened.splice(0)) {
    o.unmount();
    o.session.held.database?.close();
  }
  vi.restoreAllMocks();
});

async function start(f: Fake, opts: StartOpts = {}) {
  const session = new Session(f.client, () => T0);
  await session.refresh();
  const modes: string[] = [];
  const onHandOff = vi.fn();
  const view = render(createElement(App, {
    machine: 'box1', session, onHandOff, now: () => T0, canHandOff: opts.canHandOff ?? false, writeMode: (s: string) => modes.push(s),
    databaseOptions: { everyMs: 60_000, limitMs: 2000, env: { HOST_DATA_DIR: '/srv/smdb/data' }, timeZone: 'UTC', ...opts.db },
  }));
  const stdout = view.stdout as unknown as { rows: number };
  stdout.rows = opts.rows ?? 40;
  Object.defineProperty(view.stdout, 'columns', { value: opts.columns ?? 80, configurable: true });
  view.stdout.emit('resize');
  opened.push({ unmount: () => view.unmount(), session });
  await tick();
  const frame = () => view.lastFrame() ?? '';
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
  return { ...view, session, frame, press, until, untilFn, modes, onHandOff };
}

type V = Awaited<ReturnType<typeof start>>;

// A key sent between a render and Ink's new input handler can reach the old screen's handler (M4 decision 9).
async function openDb(v: V, name = 'mybot') {
  for (const end = Date.now() + WAIT_MS; Date.now() < end && !flat(v.frame()).includes(`Database: ${name}`);) {
    await v.press('d');
    await tick(50);
  }
  await v.until(`Database: ${name}`);
}

async function toDb(f: Fake, opts: StartOpts = {}) {
  const v = await start(f, opts);
  await v.press(ENTER);
  await v.until('Name mybot');
  await openDb(v);
  return v;
}

const joins = (f: Fake, id = 'b1') => f.paths().filter((p) => p === `GET ${JOIN_PATH(id)}`).length;
const onCodeScreen = (v: V) => v.frame().split('\n')[0].startsWith('+ Join code of mybot');

// Every string reachable from `root`, so a row can check the code is kept nowhere.
function stringsIn(root: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const walk = (x: unknown) => {
    if (typeof x === 'string') out.push(x);
    if (!x || typeof x !== 'object' || seen.has(x)) return;
    seen.add(x);
    if (x instanceof Map) for (const [k, val] of x) {
      walk(k);
      walk(val);
    }
    else if (x instanceof Set) for (const val of x) walk(val);
    else for (const k of Object.keys(x)) walk((x as Record<string, unknown>)[k]);
  };
  walk(root);
  return out;
}

describe('m5 J on the Database screen', () => {
  it('is offered while replication is on and absent while it is off or unread; there J sends nothing', async () => {
    const v = await toDb(routes());
    await v.until('J Join code');
    v.unmount();

    for (const replication of [replicationOff(), failed500('the database container is not running')]) {
      const f = routes(joinCodeBody(), replication);
      const w = await toDb(f);
      // The replication read has landed (its heading can be below the 40 rows).
      await w.untilFn(() => w.session.held.database?.got.replication !== undefined);
      await tick(100);
      expect(flat(w.frame())).not.toContain('J Join code');
      await w.press('j');
      await tick(100);
      expect(joins(f)).toBe(0);
      expect(flat(w.frame())).toContain('Database: mybot');
      w.unmount();
    }
  });

  it('opens the code screen: the code alone in lines of 64 from column 0, no side bars, the notes and Esc Close', async () => {
    const f = routes();
    const v = await toDb(f, { columns: 80, rows: 40 });
    await v.until('J Join code');
    await v.press('j');
    await v.untilFn(() => onCodeScreen(v));
    const lines = v.frame().split('\n');
    const code = codeLines(JOIN_CODE);
    expect(lines.slice(1, 1 + code.length)).toEqual(code);
    for (const l of lines.slice(1)) {
      expect(l.startsWith('|')).toBe(false);
      expect(l.endsWith('|')).toBe(false);
      expect(l.length).toBeLessThanOrEqual(79);
    }
    const text = lines.join(' ').replace(/\s+/g, ' ');
    expect(text).toContain('It holds database passwords: paste it only into your own managers.');
    expect(text).toContain('Select and copy every line of the code. The line breaks, and any spaces a terminal adds at the line ends, do no harm');
    expect(text).toContain(`The code is ${JOIN_CODE.length} characters long, in ${code.length} lines.`);
    expect(lines.at(-1)).toBe('Esc Close');
    expect(joins(f)).toBe(1);
  });

  for (const columns of [70, 100]) {
    it(`shows the whole code at ${columns} columns inside the width`, async () => {
      const v = await toDb(routes(), { columns, rows: 40 });
      await v.until('J Join code');
      await v.press('j');
      await v.untilFn(() => onCodeScreen(v));
      const lines = v.frame().split('\n');
      expect(lines.slice(1, 1 + codeLines(JOIN_CODE).length).join('')).toBe(JOIN_CODE);
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(columns - 1);
    });
  }

  it('shows no code at 64 columns or in too few rows, and says how to see it', async () => {
    for (const size of [{ columns: 64, rows: 40 }, { columns: 80, rows: 16 }]) {
      const v = await toDb(routes(), { columns: size.columns, rows: 40 });
      await v.until('J Join code');
      (v.stdout as unknown as { rows: number }).rows = size.rows;
      v.stdout.emit('resize');
      await tick(50);
      await v.press('j');
      await v.untilFn(() => onCodeScreen(v));
      expect(flat(v.frame())).toContain('Widen the window to show the code');
      expect(v.frames.some((fr) => holdsCode(String(fr)))).toBe(false);
      for (const l of v.frame().split('\n')) expect(l.length).toBeLessThanOrEqual(size.columns - 1);
      v.unmount();
    }
  });

  it('Esc closes it: no later frame and nothing in the Session holds the code; Q and H do nothing there', async () => {
    const f = routes();
    const v = await toDb(f, { canHandOff: true });
    await v.until('J Join code');
    expect(v.frames.some((fr) => holdsCode(String(fr)))).toBe(false);
    await v.press('j');
    await v.untilFn(() => onCodeScreen(v));
    await v.press('q', 'h', 'Q', 'H', 'x', ENTER);
    await tick(100);
    expect(onCodeScreen(v)).toBe(true);
    expect(v.onHandOff).not.toHaveBeenCalled();
    const at = v.frames.length;
    await v.press(ESC);
    await v.until('Database: mybot');
    await v.session.refresh();
    await tick(100);
    expect(v.frames.slice(at).some((fr) => holdsCode(String(fr)))).toBe(false);
    expect(stringsIn(v.session).some(holdsCode)).toBe(false);
    expect(flat(v.frame())).toContain('J Join code');
    expect(v.session.notice ?? '').not.toContain('smdbjoin1');
    expect(v.modes).toEqual([]);
    await v.press(ESC);
    await v.until('Name mybot');
    expect(stringsIn(v.session).some(holdsCode)).toBe(false);
    expect(v.frames.slice(at).some((fr) => holdsCode(String(fr)))).toBe(false);
  });

  it('a second J while the read runs sends one GET, and the answer opens the screen once', async () => {
    let release: (r: Reply) => void = () => undefined;
    const f = routes(() => new Promise<Reply>((r) => {
      release = r;
    }));
    const v = await toDb(f);
    await v.until('J Join code');
    await v.press('j');
    await v.until('Reading the join code.');
    await v.press('j', 'J', 'j');
    await tick(100);
    expect(joins(f)).toBe(1);
    release(joinCodeBody());
    await v.untilFn(() => onCodeScreen(v));
    await v.press(ESC);
    await v.until('Database: mybot');
    expect(joins(f)).toBe(1);
  });

  it('an answer landing after Esc opens nothing, on the bot screen or on another bot', async () => {
    let release: (r: Reply) => void = () => undefined;
    const f = routes(() => new Promise<Reply>((r) => {
      release = r;
    }));
    const v = await toDb(f);
    await v.until('J Join code');
    await v.press('j');
    await v.until('Reading the join code.');
    await v.press(ESC);
    await v.until('Name mybot');
    await v.press(ESC);
    await v.until('otherbot');
    await v.press(DOWN, ENTER);
    await v.until('Name otherbot');
    await openDb(v, 'otherbot');
    release(joinCodeBody());
    await tick(300);
    expect(flat(v.frame())).toContain('Database: otherbot');
    expect(v.frames.some((fr) => holdsCode(String(fr)))).toBe(false);
    expect(stringsIn(v.session).some(holdsCode)).toBe(false);
  });

  it('each refusal shows the route text and opens no code screen', async () => {
    let next: Reply = joinRefused(JOIN_REFUSALS.off);
    const f = routes(() => next);
    const v = await toDb(f);
    await v.until('J Join code');
    const cases: Array<[Reply, string]> = [
      ...Object.values(JOIN_REFUSALS).map((t): [Reply, string] => [joinRefused(t), t]),
      [joinFailed500(), 'Error: connect ENOENT /var/run/docker.sock'],
      [joinNotFound(), 'Bot not found'],
      [ok({ success: true }), 'No join code was made'],
      [ok({ success: false }), 'No join code was made'],
    ];
    for (const [reply, text] of cases) {
      next = reply;
      const sent = joins(f);
      await v.press('j');
      await v.until(text);
      expect(joins(f)).toBe(sent + 1);
      expect(onCodeScreen(v)).toBe(false);
      expect(flat(v.frame())).toContain('Database: mybot');
    }
    expect(v.session.notice).toBeNull();
  });

  it('no answer, a reply that is not JSON and the time limit show the page text with the reason, and no code screen', async () => {
    let next: () => Reply | Promise<Reply> = () => noAnswer();
    const f = routes(() => next());
    const v = await toDb(f, { db: { limitMs: 300 } });
    await v.until('J Join code');
    await v.press('j');
    await v.until('No answer from the manager (connect ECONNREFUSED 127.0.0.1:8080); the join code may still be running. Check its state before trying again.');
    next = () => joinNotJson();
    await v.press('j');
    await v.until('No answer from the manager (the reply was not JSON, HTTP 502); the join code may still be running.');
    next = () => new Promise<Reply>(() => undefined);
    await v.press('j');
    await v.until('Reading the join code.');
    await v.until('No answer from the manager (the manager did not answer within 300 ms); the join code may still be running.');
    expect(onCodeScreen(v)).toBe(false);
    expect(joins(f)).toBe(3);
    await v.press('j');
    await v.until('Reading the join code.');
    expect(joins(f)).toBe(4);
  });
});

describe('m5 the code field in the frame', () => {
  async function focused(opts: StartOpts = {}) {
    const f = routes();
    const v = await start(f, opts);
    const onEnter = vi.fn();
    const onEscape = vi.fn();
    const field = new CodeField({ onEnter, onEscape });
    v.session.focusCode(field);
    await v.untilFn(() => v.modes.length === 1);
    return { v, f, field, onEnter, onEscape };
  }

  it('a paste with its markers split across chunks, holding a carriage return, y and q, goes to the field and no key acts', async () => {
    const { v, field, onEnter } = await focused();
    v.stdin.write('\x1b[20');
    await tick(50);
    v.stdin.write('0~smdbjoin1.ab');
    await tick(50);
    v.stdin.write('\r');
    await tick(50);
    v.stdin.write('y q\n|cd');
    await tick(50);
    v.stdin.write('\x1b[2');
    await tick(50);
    v.stdin.write('01~');
    await v.untilFn(() => field.text === 'smdbjoin1.abyqcd');
    expect(onEnter).not.toHaveBeenCalled();
    v.session.focusCode(null);
    await v.press(ENTER);
    await v.until('Name mybot');
  });

  it('a whole code pasted in one chunk with line breaks arrives whole', async () => {
    const { v, field, onEnter } = await focused();
    v.stdin.write(`${START}${codeLines(JOIN_CODE).join('\r\n')}\r\n${END}`);
    await v.untilFn(() => field.text === JOIN_CODE);
    expect(onEnter).not.toHaveBeenCalled();
  });

  it('a lone carriage return outside a paste is Enter: the owner hears it and the text stays', async () => {
    const { v, field, onEnter } = await focused();
    await v.press('ab');
    await v.press(ENTER);
    await v.untilFn(() => onEnter.mock.calls.length === 1);
    expect(field.text).toBe('ab');
    expect(flat(v.frame())).not.toContain('Name mybot');
  });

  it('Esc clears the field and reaches its owner, not the screen; q is text there', async () => {
    const { v, field, onEscape } = await focused();
    await v.press(ENTER);
    v.session.focusCode(null);
    await v.press(ENTER);
    await v.until('Name mybot');
    v.session.focusCode(field);
    await v.press('q', 'x');
    expect(field.text).toBe('qx');
    await v.press(ESC);
    await v.untilFn(() => onEscape.mock.calls.length === 1);
    expect(field.text).toBe('');
    expect(flat(v.frame())).toContain('Name mybot');
  });

  it('a paste with no code field focused acts as no keys and is dropped', async () => {
    const f = routes();
    const v = await start(f);
    await v.press(ENTER);
    await v.until('Name mybot');
    v.stdin.write(`${START}d${END}`);
    await tick(50);
    v.stdin.write(`${START}`);
    await tick(30);
    v.stdin.write(`${ESC}`);
    await tick(30);
    v.stdin.write(`q${END}`);
    await tick(150);
    expect(flat(v.frame())).toContain('Name mybot');
    expect(flat(v.frame())).not.toContain('Database:');
    expect(v.modes).toEqual([]);
    await v.press(ESC);
    await v.until('otherbot');
    expect(flat(v.frame())).not.toContain('Name mybot');
  });
});

describe('m5 bracketed paste on and off', () => {
  it('on while a code field has focus, off when it loses focus and when the frame unmounts', async () => {
    const v = await start(routes());
    expect(v.modes).toEqual([]);
    const field = new CodeField();
    v.session.focusCode(field);
    await v.untilFn(() => v.modes.length === 1);
    expect(v.modes).toEqual([PASTE_ON]);
    v.session.focusCode(new CodeField());
    await tick(50);
    expect(v.modes).toEqual([PASTE_ON]);
    v.session.focusCode(null);
    await v.untilFn(() => v.modes.length === 2);
    expect(v.modes).toEqual([PASTE_ON, PASTE_OFF]);
    v.session.focusCode(field);
    await v.untilFn(() => v.modes.length === 3);
    v.unmount();
    expect(v.modes).toEqual([PASTE_ON, PASTE_OFF, PASTE_ON, PASTE_OFF]);
  });

  it('the hand-off turns it off before the terminal goes to the child', async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const result = await new Promise((resolve) => {
      void editHandOff({ name: '/app/config.json', body: '{}\n', done: resolve }, { enter: 'ENTER', leave: 'LEAVE' },
        { DBM_TUI_CHECK_EDITOR: JSON.stringify([process.execPath, '-e', '']) });
    });
    expect(result).toEqual({ ok: true, changed: false, body: '{}\n' });
    const off = writes.indexOf(PASTE_OFF);
    expect(off).toBeGreaterThanOrEqual(0);
    expect(off).toBeLessThan(writes.findIndex((w) => w.startsWith('LEAVE')));
  });

  it('quit turns it off before the screen is left', async () => {
    const events: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      events.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const fakeInk = {
      render: () => ({ waitUntilExit: () => Promise.resolve(), cleanup: () => {}, unmount: () => {}, rerender: () => {}, clear: () => {} }),
    } as unknown as InkApi;
    await runTui(fake().on('GET', '/api/bots', botList([])).client, { ink: fakeInk });
    const off = events.lastIndexOf(PASTE_OFF);
    expect(off).toBeGreaterThanOrEqual(0);
    expect(off).toBe(events.length - 2);
  });
});
