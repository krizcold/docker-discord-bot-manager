import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import * as ink from 'ink';
import { render } from 'ink-testing-library';
import { createApp } from '../../src/cli/tui/app';
import { Session } from '../../src/cli/tui/session';
import { botList, ok } from './m2-fake';
import {
  backupsBody, connectionsBody, mainBot, memoryBody, migrateBody, orphansBody, replicaBody, replicationOff, stateInfo, switchBody, T0,
} from './m4-fake';
import { held, wsFake, WsFake } from './m5-lanekit';

// While a bot's DELETE runs, nothing else may be sent on it: a state change or a Database screen write could take the
// op lock first (containerManager.ts:2357) and fail the delete.

const App = createApp(ink);
vi.setConfig({ testTimeout: 30_000 });
const ESC = '\u001B';
const ENTER = '\r';
const DOWN = '\u001B[B';
const WAIT_MS = 10_000;
const B = '/api/bots/b1';
const DEL = `${B}?keepData=true&keepEnv=true`;
const BLOCK = 'The delete of mybot is running, so nothing was sent.';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const flat = (frame: string) => frame.split('\n').map((l) => l.replace(/^\| /, '').replace(/\s*\|$/, '').trim()).join(' ').replace(/\s+/g, ' ');

const opened: Array<{ unmount: () => void; session: Session }> = [];
afterEach(() => {
  for (const o of opened.splice(0)) {
    o.unmount();
    o.session.stop();
  }
});

const enc = encodeURIComponent;
const FS_LIST = `${B}/fs/list?target=host&path=${enc('')}`;
const DATA = '/data/data/bots/b1/data';

// A stopped bot that hosts the fleet database (m4-fake.ts mainBot) and has a public URL, so X, T, D, F and W are all
// offered.
function routes(): WsFake {
  return wsFake()
    .on('GET', '/api/bots', botList([mainBot({ status: 'stopped', hasBeenStarted: true, publicUrl: 'https://mybot.example.org', webAuth: 'managed' })]))
    // fsList success (terminal.ts:668) and the containers read (bots.ts:942).
    .on('GET', FS_LIST, ok({ success: true, path: DATA, entries: [{ name: 'logs', isDir: true }, { name: 'config.json', isDir: false }] }))
    .on('GET', `${B}/containers`, ok({ success: true, containers: [], appName: 'mybot' }))
    .on('GET', '/api/bots/fleet/orphan-backups', orphansBody())
    .on('GET', `${B}/maintenance`, stateInfo())
    .on('GET', `${B}/migrate`, migrateBody())
    .on('GET', `${B}/memory`, memoryBody())
    .on('GET', `${B}/fleet-connections`, connectionsBody())
    .on('GET', `${B}/fleet-replica`, replicaBody())
    .on('GET', `${B}/fleet-backups`, backupsBody([]))
    .on('GET', `${B}/fleet-replication`, replicationOff())
    .on('GET', `${B}/fleet-switch`, switchBody());
}

async function deleting(f: WsFake) {
  const slow = held();
  f.on('DELETE', DEL, () => slow.answer());
  const session = new Session(f.client, () => T0);
  await session.refresh();
  const view = render(createElement(App, {
    machine: 'box1', session, onHandOff: vi.fn(), now: () => T0,
    databaseOptions: { everyMs: 60_000, limitMs: 2000, env: { HOST_DATA_DIR: '/srv' }, timeZone: 'UTC' },
    stateOptions: { limitMs: 2000, waitMs: 1000 },
  }));
  (view.stdout as unknown as { rows: number }).rows = 60;
  Object.defineProperty(view.stdout, 'columns', { value: 120, configurable: true });
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
  // A key sent before Ink's new input handler reaches the old screen; it is sent again until the screen opens.
  const pressUntil = async (k: string, text: string) => {
    for (const end = Date.now() + WAIT_MS; Date.now() < end && !flat(frame()).includes(text);) {
      await press(k);
      await tick(50);
    }
    await until(text);
  };
  await press(ENTER);
  await until('Name mybot');
  await press('x');
  await until('Are you sure you want to remove mybot?');
  await press('y');
  await until('Asked the manager to remove mybot');
  await press(ESC);
  await until('Name mybot');
  const writes = () => f.calls.filter((c) => c.method !== 'GET' && c.method !== 'DELETE');
  return { frame, press, until, pressUntil, writes, session };
}

describe('m6 delete guard: nothing else is sent on a bot while its DELETE runs', () => {
  it('the State screen opens but a state change sends nothing', async () => {
    const f = routes().on('PUT', `${B}/maintenance`, ok({ success: true, opId: 'op-1' }));
    const v = await deleting(f);
    await v.pressUntil('t', 'State: mybot');
    await v.until('> (*) Running');
    await v.press(DOWN, ENTER);
    await v.until(BLOCK);
    await tick(200);
    expect(v.writes()).toEqual([]);
  });

  it('the Database screen opens but a backup settings change sends nothing', async () => {
    const f = routes().on('PUT', `${B}/fleet-backup-config`, ok({ success: true, enabled: false, hour: 4 }));
    const v = await deleting(f);
    await v.pressUntil('d', 'Database: mybot');
    await v.until('[x] Backups');
    await v.press(' ');
    await v.until(BLOCK);
    await tick(200);
    expect(v.writes()).toEqual([]);
  });

  it('the Files screen opens but New folder and Delete send nothing', async () => {
    const f = routes()
      .on('POST', `${B}/fs/mkdir`, ok({ success: true, path: `${DATA}/cache` }))
      .on('POST', `${B}/fs/delete`, ok({ success: true, path: `${DATA}/logs`, removed: true }));
    const v = await deleting(f);
    await v.pressUntil('f', 'config.json');
    await v.press('k');
    await v.until('New folder name in');
    await v.press('c', 'a', 'c', 'h', 'e', ENTER);
    await v.until(BLOCK);
    await v.press('x');
    await v.until(`Delete the folder ${DATA}/logs and everything in it`);
    await v.press('y');
    await v.until(BLOCK);
    await tick(200);
    expect(v.writes()).toEqual([]);
  });

  it('a web login change after Y sends nothing, closes the screen and says why on the bot screen', async () => {
    const f = routes().on('PUT', `${B}/web-auth`, ok({ success: true }));
    const v = await deleting(f);
    await v.pressUntil('w', 'Web login of mybot');
    await v.press(DOWN, ENTER);
    await v.until('from Managed to Public?');
    await v.press('y');
    await v.until(BLOCK);
    await v.until('Name mybot');
    expect(flat(v.frame())).not.toContain('Web login of mybot');
    expect(v.session.held.webAuth).toBeUndefined();
    expect(v.session.notice).toBe(BLOCK);
    await tick(200);
    expect(v.writes()).toEqual([]);
  });
});
