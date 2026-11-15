import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import * as ink from 'ink';
import { render } from 'ink-testing-library';
import { createApp } from '../../src/cli/tui/app';
import { SEED_CHANGED_TEXT } from '../../src/cli/tui/actions';
import type { DatabaseOptions } from '../../src/cli/tui/database';
import { Session } from '../../src/cli/tui/session';
import { botList, fake, Fake, noAnswer, ok, refused, Reply } from './m2-fake';
import {
  backupsBody, backupStatus, connectionsBody, entry, failed500, mainBot, maintenanceBody, memoryBody, migrateBody, orphansBody, replicaBody,
  replicationOff, replicationOn, stateInfo, switchBody, T0,
} from './m4-fake';
import {
  ADDRESSES_APPLIED, DIFFERENT_RUN, disabledBody, droppedBody, enabledBody, INVALID_PORT, PORT_TAKEN, replRefused, seedCancelled,
  seedDismissed, seedParked, seedQuestion, seedRunning, SLOT_ROW_KEPT, SLOT_STREAMING, STILL_STREAMING, TOO_LATE, URL_KEPT_D, URL_KEPT_E,
} from './m5-fake';

const App = createApp(ink);
vi.setConfig({ testTimeout: 40_000 });
const ESC = '\u001B';
const ENTER = '\r';
const TAB = '\t';
const DOWN = '\u001B[B';
const PGDN = '\u001B[6~';
const START = '\x1b[200~';
const END = '\x1b[201~';

const WAIT_MS = 10_000;
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const flat = (frame: string) => frame.split('\n').map((l) => l.replace(/^\| /, '').replace(/\s*\|$/, '').trim()).join(' ').replace(/\s+/g, ' ');
const bars = (frame: string) => frame.split('\n').slice(-5, -1).join(' ');
const never = () => new Promise<Reply>(() => undefined);

const B = '/api/bots/b1';
const REPL = `${B}/fleet-replication`;
const SEED = `${B}/fleet-replica/seed`;
const slot = (name: string, active: boolean, machine: string | null = null) => ({
  slot: name, fleet: true, walStatus: 'reserved', active, retainedBytes: 1_048_576, clientAddr: null, state: active ? 'streaming' : null,
  replayLagSeconds: active ? 0.4 : null, behindBytes: 0, machine, address: null,
});
const replWith = (slots: unknown[], keep = '4096MB', over: Record<string, unknown> = {}) => replicationOn({
  live: { sslOn: true, standbys: [], slotWalKeep: keep, slots }, ...over,
});

// /ws as client.openWs gives it (the State screen listens on it); no row sends a frame.
function withWs(f: Fake): Fake {
  (f.client as unknown as { openWs: unknown }).openWs = (_m: unknown, onOpen?: () => void) => {
    setTimeout(() => onOpen?.(), 1);
    return { close: () => undefined };
  };
  return f;
}

function routes(over: { replication?: Reply | (() => Reply); replica?: Reply | (() => Reply); bot?: Record<string, unknown> } = {}): Fake {
  return withWs(fake())
    .on('GET', '/api/bots', botList([over.bot ?? mainBot()]))
    .on('GET', '/api/bots/fleet/orphan-backups', orphansBody())
    .on('GET', `${B}/maintenance`, stateInfo())
    .on('GET', `${B}/memory`, memoryBody())
    .on('GET', `${B}/fleet-connections`, connectionsBody())
    .on('GET', `${B}/fleet-replica`, over.replica ?? replicaBody())
    .on('GET', `${B}/fleet-backups`, backupsBody([entry('hourly-2026-11-14T09-00-00-000Z.dump')]))
    .on('GET', REPL, over.replication ?? replWith([slot('smdb_copy_a', true, 'yundera'), slot('smdb_copy_b', false, 'hetzner')]))
    .on('GET', `${B}/fleet-switch`, switchBody())
    .on('GET', `${B}/migrate`, migrateBody());
}

interface StartOpts {
  rows?: number;
  columns?: number;
  db?: DatabaseOptions;
}

const opened: Array<{ unmount: () => void; session: Session }> = [];
afterEach(() => {
  for (const o of opened.splice(0)) {
    o.unmount();
    o.session.stop();
  }
});

async function start(f: Fake, opts: StartOpts = {}) {
  const session = new Session(f.client, () => T0);
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
  return { ...view, session, frame, press, until, untilFn };
}

type V = Awaited<ReturnType<typeof start>>;

async function toBot(f: Fake, opts: StartOpts = {}) {
  const v = await start(f, opts);
  await v.press(ENTER);
  await v.until('Name mybot');
  return v;
}

async function toDb(f: Fake, opts: StartOpts = {}) {
  const v = await toBot(f, opts);
  for (const end = Date.now() + WAIT_MS; Date.now() < end && !flat(v.frame()).includes('Database: mybot');) {
    await v.press('d');
    await tick(50);
  }
  await v.until('Database: mybot');
  return v;
}

// Opens the Actions list and takes the row whose label is given.
async function take(v: V, label: string) {
  await v.untilFn(() => bars(v.frame()).includes('A Actions'));
  await v.press('a');
  await v.until('Actions: mybot');
  await v.until(label);
  for (let i = 0; i < 10 && !(v.frame().split('\n').find((l) => l.includes(`> ${label}`))); i++) await v.press(DOWN);
  expect(v.frame()).toContain(`> ${label}`);
  await v.press(ENTER);
}

const calls = (f: Fake, method: string, path: string) => f.calls.filter((c) => c.method === method && c.path === path);

describe('m5 the Actions list on the Database screen', () => {
  it('A lists the rows of the newest reads; Up and Down move, Esc goes back; A is absent with nothing to offer', async () => {
    const v = await toDb(routes({ replication: replWith([slot('smdb_copy_a', true, 'yundera'), slot('smdb_copy_b', false, 'hetzner')], '-1'), replica: replicaBody(seedRunning()) }));
    await v.untilFn(() => bars(v.frame()).includes('A Actions'));
    await v.press('a');
    await v.until('Actions: mybot');
    const body = flat(v.frame());
    expect(body).toContain('> Cancel the seed Apply the 4096 MB WAL bound Drop slot smdb_copy_b (the copy on hetzner) New join code Disable replication');
    expect(bars(v.frame())).toContain('Up/Down Choose  Enter Take  Esc Back');
    await v.press(DOWN, DOWN);
    expect(v.frame()).toContain('> Drop slot smdb_copy_b');
    await v.press(ESC);
    await v.until('Replication');
    expect(flat(v.frame())).toContain('Database: mybot');

    // With the switch read failing too, no Move row is offered (part 5's Receive and Push come from it).
    const w = await toDb(routes({ replication: failed500('the database container is not running') }).on('GET', `${B}/fleet-switch`, failed500('the switch records could not be read')));
    await w.until('Failed to load replication status');
    await tick(100);
    expect(bars(w.frame())).not.toContain('A Actions');
    await w.press('a');
    await tick(100);
    expect(flat(w.frame())).not.toContain('Actions: mybot');
  });
});

describe('m5 Enable replication', () => {
  it('the form: a bad number and an empty host send nothing; then one POST with the fields filled and the page text', async () => {
    const f = routes({ replication: replicationOff() }).on('POST', REPL, enabledBody({ certRotated: true, addressesText: ADDRESSES_APPLIED }));
    const v = await toDb(f);
    await take(v, 'Enable replication');
    await v.until('Enable replication');
    await v.until('Public host');
    expect(bars(v.frame())).toContain('Enter Enable');
    await v.press(TAB, '15x', TAB, 'abc', ENTER);
    await v.until('Not a number: port, WAL bound. Fix it, then try again. Nothing was sent.');
    await v.press('\x7f', '\x7f', '\x7f', '\u001B[A', '\x7f', '432', ENTER);
    await v.until('Enter the public host or IP other machines will dial');
    expect(calls(f, 'POST', REPL)).toEqual([]);
    await v.press('\u001B[A', 'db.example.net', ENTER);
    await v.until('Replication enabled. Restart the instance to publish the port and apply the new database URL. A new server certificate was installed: every other machine needs the new join code. The running bot took the new database list.');
    expect(calls(f, 'POST', REPL).map((c) => c.body)).toEqual([{ enabled: true, publicHost: 'db.example.net', hostPort: 15432 }]);
    await v.until('Database: mybot');
    expect(flat(v.frame())).not.toContain('Public host');
  });

  it('a refusal keeps the form and its fields; no answer says so; the URL kept and plain clients notes', async () => {
    let next: Reply = replRefused(INVALID_PORT);
    const f = routes({ replication: replicationOff() }).on('POST', REPL, () => next);
    const v = await toDb(f);
    await take(v, 'Enable replication');
    await v.until('Public host');
    await v.press('h1', TAB, '99999', TAB, '64', ENTER);
    await v.until(`${INVALID_PORT}`);
    expect(flat(v.frame())).toContain('Public host');
    next = replRefused(PORT_TAKEN);
    await v.press(ENTER);
    await v.until(PORT_TAKEN);
    next = noAnswer();
    await v.press(ENTER);
    await v.until('No answer from the manager (connect ECONNREFUSED 127.0.0.1:8080); the replication change may still be running. Check its state before trying again.');
    next = refused(502, 'Bad Gateway');
    await v.press(ENTER);
    await v.until('No answer from the manager (the reply was not JSON, HTTP 502)');
    next = enabledBody({ urlKept: URL_KEPT_E, plainClientsKept: 2 });
    await v.press(ENTER);
    await v.until(`Replication enabled. Restart the instance to publish the port. The database keeps admitting connections without TLS from 2 address(es) outside 172.16.0.0/12 that the bot may still use on its old URL, until a start finds none of them connected that way. ${URL_KEPT_E}`);
    expect(calls(f, 'POST', REPL).map((c) => c.body)).toEqual(Array(5).fill({ enabled: true, publicHost: 'h1', hostPort: 99999, slotWalKeepMb: 64 }));
  });
});

describe('m5 Apply the WAL bound', () => {
  it('reads the settings, then posts with the host and port just read', async () => {
    let reads = 0;
    const f = routes({ replication: () => (++reads === 1 ? replWith([], '-1') : replWith([], '-1', { publicHost: 'new.example.net', hostPort: 16000 })) })
      .on('POST', REPL, enabledBody());
    const v = await toDb(f);
    await take(v, 'Apply the 4096 MB WAL bound');
    await v.until('WAL retention bound applied (4096 MB). It takes effect immediately; wal_log_hints applies on the next restart.');
    expect(calls(f, 'POST', REPL).map((c) => c.body)).toEqual([{ enabled: true, publicHost: 'new.example.net', hostPort: 16000, slotWalKeepMb: 4096 }]);
    const i = f.paths().lastIndexOf(`POST ${REPL}`);
    expect(f.paths().slice(0, i).filter((p) => p === `GET ${REPL}`).length).toBeGreaterThanOrEqual(2);
  });

  it('a refused or unanswered settings read sends no POST; a refused POST and a lost one say so', async () => {
    // The action's own read takes the next queued answer; the screen's reads answer normally.
    const fails: Reply[] = [];
    let post: Reply = replRefused(INVALID_PORT);
    const f = routes({ replication: () => fails.shift() ?? replWith([], '-1') }).on('POST', REPL, () => post);
    const v = await toDb(f);
    await v.untilFn(() => bars(v.frame()).includes('A Actions'));
    fails.push(failed500('Error: spawn docker ENOENT'));
    await take(v, 'Apply the 4096 MB WAL bound');
    await v.until('Could not read the replication settings (Error: spawn docker ENOENT), so the bound was not applied; nothing was sent.');
    await v.untilFn(() => bars(v.frame()).includes('A Actions'));
    fails.push(noAnswer() as never);
    await take(v, 'Apply the 4096 MB WAL bound');
    await v.until('Could not read the replication settings (no answer: connect ECONNREFUSED 127.0.0.1:8080), so the bound was not applied; nothing was sent.');
    expect(calls(f, 'POST', REPL)).toEqual([]);
    await take(v, 'Apply the 4096 MB WAL bound');
    await v.until(`${INVALID_PORT}`);
    post = noAnswer() as never;
    await take(v, 'Apply the 4096 MB WAL bound');
    await v.until('the WAL bound change may still be running');
    expect(calls(f, 'POST', REPL)).toHaveLength(2);
  });
});

describe('m5 Drop slot', () => {
  it('the dialog; another key sends nothing; Y sends once for the slot the dialog names, though a newer read dropped the row', async () => {
    let live = [slot('smdb_copy_a', true, 'yundera'), slot('smdb_copy_b', false, 'hetzner')];
    let release: (r: Reply) => void = () => undefined;
    const f = routes({ replication: () => replWith(live) }).on('DELETE', `${REPL}/slots/smdb_copy_b`, () => new Promise<Reply>((r) => {
      release = r;
    }));
    const v = await toDb(f, { db: { everyMs: 200 } });
    await take(v, 'Drop slot smdb_copy_b');
    await v.until('Drop replication slot smdb_copy_b on this main? The WAL it retains is released. A copy that used it can no longer resume and must be re-seeded to attach again.');
    expect(bars(v.frame())).toContain('Y Drop  any other key Cancel');
    await v.press('n');
    await v.until('Cancelled: nothing was sent.');
    expect(calls(f, 'DELETE', `${REPL}/slots/smdb_copy_b`)).toEqual([]);
    await take(v, 'Drop slot smdb_copy_b');
    await v.until('Drop replication slot smdb_copy_b');
    live = [slot('smdb_copy_a', true, 'yundera')];
    await tick(600);
    v.stdin.write(`${START}y${END}`);
    await tick(100);
    expect(calls(f, 'DELETE', `${REPL}/slots/smdb_copy_b`)).toEqual([]);
    await v.press('y', 'y', 'Y');
    await v.until('Dropping slot smdb_copy_b.');
    await tick(100);
    expect(calls(f, 'DELETE', `${REPL}/slots/smdb_copy_b`)).toHaveLength(1);
    expect(flat(v.frame())).not.toContain('Slot smdb_copy_b dropped');
    release(droppedBody());
    await v.until('Slot smdb_copy_b dropped');
    expect(calls(f, 'DELETE', `${REPL}/slots/smdb_copy_b`)).toHaveLength(1);
  });

  it('a refusal, the NM20 partial text, the page fallback and no answer', async () => {
    let next: Reply = replRefused(SLOT_STREAMING);
    const f = routes().on('DELETE', `${REPL}/slots/smdb_copy_b`, () => next);
    const v = await toDb(f);
    const drop = async (text: string) => {
      await take(v, 'Drop slot smdb_copy_b');
      await v.until('Y Drop');
      await v.press('y');
      await v.until(text);
    };
    await drop(`${SLOT_STREAMING}`);
    next = replRefused(SLOT_ROW_KEPT);
    await drop(SLOT_ROW_KEPT);
    next = ok({ success: false });
    await drop('Failed to drop the slot');
    next = noAnswer();
    await drop('No answer from the manager (connect ECONNREFUSED 127.0.0.1:8080); the slot drop may still be running. Check its state before trying again.');
    expect(calls(f, 'DELETE', `${REPL}/slots/smdb_copy_b`)).toHaveLength(4);
  });
});

describe('m5 Disable replication', () => {
  it('the dialog, then success with each optional field, a refusal and no answer', async () => {
    let next: Reply = disabledBody({ addressesText: ADDRESSES_APPLIED });
    const f = routes().on('POST', REPL, () => next);
    const v = await toDb(f);
    const disable = async (text: string) => {
      await take(v, 'Disable replication');
      await v.until('Disable replication? Refused while a copy streams or a seed copies this database, or while a backup or restore runs.');
      await v.until('Y Disable');
      await v.press('y');
      await v.until(text);
    };
    await disable('Replication disabled. Restart the instance to apply. The running bot took the new database list.');
    next = disabledBody({ urlKept: URL_KEPT_D, plainClientsKept: 1 });
    await disable(`Replication disabled. Restart the instance to apply. ${URL_KEPT_D} The database keeps admitting connections without TLS from 1 address(es)`);
    next = replRefused(STILL_STREAMING);
    await disable(`${STILL_STREAMING}`);
    next = noAnswer();
    await disable('the replication change may still be running');
    expect(calls(f, 'POST', REPL).map((c) => c.body)).toEqual(Array(4).fill({ enabled: false }));
    await take(v, 'Disable replication');
    await v.until('Y Disable');
    await v.press('x');
    await v.until('Cancelled: nothing was sent.');
    expect(calls(f, 'POST', REPL)).toHaveLength(4);
  });

  it('Esc while the call runs leaves the screen; the outcome lands on the bot screen and the list is read again', async () => {
    let release: (r: Reply) => void = () => undefined;
    const f = routes().on('POST', REPL, () => new Promise<Reply>((r) => {
      release = r;
    }));
    const v = await toDb(f);
    await take(v, 'Disable replication');
    await v.until('Y Disable');
    await v.press('y');
    await v.until('Disabling replication.');
    expect(bars(v.frame())).toContain('Waiting for the manager  Esc Back');
    await v.press('a', 'j', ESC);
    await v.until('Name mybot');
    const lists = calls(f, 'GET', '/api/bots').length;
    release(disabledBody());
    await v.until('mybot: Replication disabled. Restart the instance to apply.');
    await v.untilFn(() => calls(f, 'GET', '/api/bots').length > lists);
    expect(calls(f, 'POST', REPL)).toHaveLength(1);
  });
});

describe('m5 the seed banner: Cancel and Dismiss', () => {
  it('the press sends the read it was built from; each question is a dialog sent with the new seed; Cancel requested', async () => {
    const asked = 'Cancel the seed of this standby? The copy so far is thrown away.';
    let round = 0;
    const f = routes({ replica: replicaBody(seedRunning()) }).on('DELETE', SEED, () => (++round === 1
      ? seedQuestion(asked, { startedAt: 1_700_000_000_000, parked: false, committed: false })
      : seedCancelled()));
    const v = await toDb(f);
    await take(v, 'Cancel the seed');
    await v.until(asked);
    expect(bars(v.frame())).toContain('Y Confirm');
    await v.press('y');
    await v.until('Cancel requested');
    expect(calls(f, 'DELETE', SEED).map((c) => c.body)).toEqual([
      { startedAt: 1_700_000_000_000, parked: false },
      { startedAt: 1_700_000_000_000, parked: false, committed: false, confirm: true },
    ]);
  });

  it('a seed that changes at each round ends after three sends with the page text; another key ends it with nothing more sent', async () => {
    let round = 0;
    const f = routes({ replica: replicaBody(seedParked()) }).on('DELETE', SEED, () => {
      round++;
      return seedQuestion(`Dismiss round ${round}?`, { startedAt: 1_700_000_100_000 + round, parked: true, committed: round % 2 === 0 });
    });
    const v = await toDb(f);
    await take(v, 'Dismiss the stopped seed');
    await v.until('Dismiss round 1?');
    await v.press('y');
    await v.until('Dismiss round 2?');
    await v.press('y');
    await v.until(`${SEED_CHANGED_TEXT}`);
    expect(calls(f, 'DELETE', SEED).map((c) => c.body)).toEqual([
      { startedAt: 1_700_000_100_000, parked: true },
      { startedAt: 1_700_000_100_001, parked: true, committed: false, confirm: true },
      { startedAt: 1_700_000_100_002, parked: true, committed: true, confirm: true },
    ]);
    round = 0;
    await take(v, 'Dismiss the stopped seed');
    await v.until('Dismiss round 1?');
    await v.press('n');
    await v.until('Cancelled: the seed was not cancelled or dismissed.');
    expect(calls(f, 'DELETE', SEED)).toHaveLength(4);
  });

  it('dismissed, the route refusals, a refusal carrying a seed without a question, and no answer', async () => {
    let next: Reply = seedDismissed();
    const f = routes({ replica: replicaBody(seedParked()) }).on('DELETE', SEED, () => next);
    const v = await toDb(f);
    const press = async (text: string) => {
      await take(v, 'Dismiss the stopped seed');
      await v.until(text);
    };
    await press('Dismissed');
    next = replRefused(TOO_LATE);
    await press(`${TOO_LATE}`);
    next = ok({ success: false, error: DIFFERENT_RUN, seed: { startedAt: 5, parked: true, committed: false, purpose: 'provision' } });
    await press(`${DIFFERENT_RUN}`);
    next = noAnswer();
    await press('the seed cancel may still be running');
    expect(calls(f, 'DELETE', SEED)).toHaveLength(4);
  });

  it('Esc during a round that asks: nothing is asked on a closed screen, and the bot screen says nothing was cancelled', async () => {
    let release: (r: Reply) => void = () => undefined;
    const f = routes({ replica: replicaBody(seedRunning()) }).on('DELETE', SEED, () => new Promise<Reply>((r) => {
      release = r;
    }));
    const v = await toDb(f);
    await take(v, 'Cancel the seed');
    await v.until('Cancelling the seed.');
    await v.press(ESC);
    await v.until('Name mybot');
    release(seedQuestion('Cancel it?', { startedAt: 1_700_000_000_000, parked: false, committed: false }));
    await v.until('mybot: Nothing was cancelled or dismissed: the manager asked to confirm after the Database screen was closed (Cancel it?).');
    expect(calls(f, 'DELETE', SEED)).toHaveLength(1);
  });
});

// Pages through a dialog until Y is offered, checking every frame's width; returns the frame at the end.
async function readDialog(v: V, yes: string, columns: number): Promise<string> {
  for (const end = Date.now() + WAIT_MS; Date.now() < end && !bars(v.frame()).includes(yes);) {
    for (const l of v.frame().split('\n')) expect(l.length).toBeLessThanOrEqual(columns - 1);
    await v.press(PGDN);
  }
  expect(bars(v.frame())).toContain(yes);
  for (const l of v.frame().split('\n')) expect(l.length).toBeLessThanOrEqual(columns - 1);
  return flat(v.frame());
}

describe('m5 every dialog on the scrolling component at 80 and 100 columns and 24 rows', () => {
  for (const columns of [80, 100]) {
    it(`M1's stop, restart and update and M4's restore, dismiss, decommission, Off and Migrate at ${columns}x24`, async () => {
      const held = { state: 'maintenance', settled: true, held: { state: 'no', guilds: 1, files: 0 } };
      const bot = mainBot({ maintenance: held, fleetBackup: backupStatus({ restoreError: 'The restore of x.dump failed: the counts differ', restoreErrorAt: '2026-11-14T09:00:00.000Z' }) });
      const f = routes({ bot })
        .on('GET', `${B}/fleet-backups/restore-preview`, ok({ success: true, instances: [{ id: 'b1', displayName: 'mybot', running: false }] }))
        .on('GET', `${B}/maintenance`, stateInfo({ state: 'maintenance', held: { state: 'no', guilds: 1, files: 0 } }))
        .on('GET', `${B}/migrate`, migrateBody());
      const v = await toBot(f, { columns, rows: 24 });
      for (const [key, yes, last] of [['s', 'Y Stop', 'Stop anyway?'], ['r', 'Y Restart', 'Restart anyway?'], ['u', 'Y Update', 'Update anyway?']]) {
        await v.press(key);
        expect(await readDialog(v, yes, columns)).toContain(last);
        await v.press('n');
        await v.until('Cancelled: mybot was not');
      }
      for (const end = Date.now() + WAIT_MS; Date.now() < end && !flat(v.frame()).includes('Database: mybot');) await v.press('d');
      await v.until('> hourly-2026-11-14T09-00-00-000Z.dump');
      const db: Array<[string, string, string]> = [
        [ENTER, 'Y Restore', 'until a restore runs with it stopped.'],
        ['x', 'Y Dismiss', "keeps the data the restore left in the database as the bot's data."],
        ['k', 'Y Decommission', 'The instance must be stopped first.'],
      ];
      for (const [key, yes, last] of db) {
        await v.press(key);
        await v.until('Database: mybot');
        expect(await readDialog(v, yes, columns)).toContain(last);
        await v.press('n');
        await v.until('Cancelled: nothing was sent.');
      }
      await v.press('t');
      await v.until('State: mybot');
      await v.until('(*) Maintenance');
      await v.press(DOWN, ENTER);
      expect(await readDialog(v, 'Y Off', columns)).toContain('Choose Off anyway?');
      await v.press('n');
      await v.until('Cancelled: nothing was sent.');
      await v.until('M Migrate');
      await v.press('m');
      expect(await readDialog(v, 'Y Migrate', columns)).toContain('follows that move instead: the bot does not restart.');
      await v.press('n');
      await v.until('Cancelled: nothing was sent.');
      expect(f.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    });
  }
});
