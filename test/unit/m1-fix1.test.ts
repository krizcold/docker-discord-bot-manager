import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import * as ink from 'ink';
import { render } from 'ink-testing-library';
import { Bot } from '../../src/cli/tui/api';
import { createApp, InkApi } from '../../src/cli/tui/app';
import { dataText, lastBackupText } from '../../src/cli/tui/format';
import { runTui, screenModes } from '../../src/cli/tui/run';
import { Session } from '../../src/cli/tui/session';
import { bot, fakeClient, listBody, ok, script } from './m1-fake';

// fleetBackupStatus (src/instance/fleetBackup.ts) when readFolder throws: lastAt null and listError set on each family.
const LIST_ERROR = "EACCES: permission denied, scandir '/data/backups/b1', so the last backup cannot be named";
const unreadFolder = () => ({ enabled: true, hour: 3, scoped: null, restoreError: null, restoreErrorAt: null,
  main: { family: 'main', lastFile: null, lastAt: null, dataAt: null, listError: LIST_ERROR },
  copy: null });

describe('m1 fix 1, R2: an unreadable backup folder', () => {
  it("says can't confirm instead of -", () => {
    const b = { id: 'b1', fleetDb: {}, fleetBackup: unreadFolder() } as unknown as Bot;
    expect(lastBackupText(b, 0)).toBe("can't confirm");
    expect(lastBackupText(b, 0, true)).toBe(`can't confirm: ${LIST_ERROR}`);
  });

  it('keeps - when the route sends no backup status', () => {
    expect(lastBackupText({ id: 'b1', fleetBackup: null } as Bot, 0)).toBe('-');
  });
});

describe('m1 fix 1, R3: an unreadable env store', () => {
  it("says can't confirm when the route sends dataPlace null", () => {
    const b = { id: 'b1', dataPlace: null } as Bot;
    expect(dataText(b)).toBe("can't confirm");
    expect(dataText(b, true)).toBe("can't confirm: the bot's settings could not be read");
  });

  it('keeps - when the route sends no dataPlace, and Postgres for a managed database', () => {
    expect(dataText({ id: 'b1' } as Bot)).toBe('-');
    expect(dataText({ id: 'b1', fleetDb: {}, dataPlace: null } as unknown as Bot)).toBe('Postgres');
  });
});

describe('m1 fix 1, R2 and R3 on the screens', () => {
  it('shows the short text in the list and the reason on the bot screen', async () => {
    const sc = script({ reply: () => ok(listBody([bot({ dataPlace: null, fleetDb: {}, fleetBackup: unreadFolder() }), bot({ id: 'b2', displayName: 'jsonbot', dataPlace: null })])) });
    const session = new Session(fakeClient(sc), () => 0);
    await session.refresh();
    const App = createApp(ink);
    const v = render(createElement(App, { machine: 'box1', session, onHandOff: () => {}, now: () => 0 }));
    await new Promise((r) => setTimeout(r, 30));
    expect(v.lastFrame()).toMatch(/> mybot\s+running\s+Postgres\s+-\s+can't confirm/);
    expect(v.lastFrame()).toMatch(/ {2}jsonbot\s+running\s+can't confirm/);
    v.stdin.write('\r');
    await new Promise((r) => setTimeout(r, 30));
    const field = (v.lastFrame() ?? '').split('\n').map((l) => l.slice(2, -2).trimEnd());
    const at = field.findIndex((l) => l.startsWith('Last backup  '));
    const wrapped = [field[at].slice(13), ...field.slice(at + 1).filter((l) => l.startsWith(' '.repeat(13)) && l.trim()).map((l) => l.trim())];
    expect(wrapped.join(' ')).toBe(`can't confirm: ${LIST_ERROR}`);
    v.stdin.write('\u001B');
    await new Promise((r) => setTimeout(r, 30));
    v.stdin.write('\u001B[B');
    await new Promise((r) => setTimeout(r, 30));
    v.stdin.write('\r');
    await new Promise((r) => setTimeout(r, 30));
    expect(v.lastFrame()).toContain("Data         can't confirm: the bot's settings could not be read");
    v.unmount();
  });
});

describe('m1 fix 1, R1: a screen that throws', () => {
  afterEach(() => vi.restoreAllMocks());

  it('restores the terminal before the error leaves runTui, and the error still leaves it', async () => {
    const events: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      events.push(`write:${String(chunk)}`);
      return true;
    }) as typeof process.stdout.write);
    const cleanup = vi.fn(() => events.push('cleanup'));
    const fakeInk = {
      render: () => ({ waitUntilExit: () => Promise.reject(new Error('the screen threw')), cleanup, unmount: () => {}, rerender: () => {}, clear: () => {} }),
    } as unknown as InkApi;
    const exitListeners = process.listenerCount('exit');
    const sc = script({ reply: () => ok(listBody([])) });

    await expect(runTui(fakeClient(sc), { ink: fakeInk })).rejects.toThrow('the screen threw');

    const leave = `write:\x1b[?25h${screenModes().leave}`;
    expect(events).toContain('cleanup');
    expect(events.indexOf(leave)).toBeGreaterThan(events.indexOf('cleanup'));
    expect(events.at(-1)).toBe(leave);
    expect(process.listenerCount('exit')).toBe(exitListeners);
  });
});
