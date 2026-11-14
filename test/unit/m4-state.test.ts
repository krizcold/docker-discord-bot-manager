import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import * as ink from 'ink';
import { render } from 'ink-testing-library';
import { createApp } from '../../src/cli/tui/app';
import type { StateOptions } from '../../src/cli/tui/statescreen';
import { Session } from '../../src/cli/tui/session';
import { botList, fake, Fake, noAnswer, ok, refused, Reply } from './m2-fake';
import { botRow } from './m3-fake';
import {
  backupsBody, connectionsBody, mainBot, memoryBody, migrateAccepted, migrateBody, orphansBody, replicaBody, replicationOff, stateAccepted, stateBusy,
  stateInfo, switchBody, T0,
} from './m4-fake';

const App = createApp(ink);
vi.setConfig({ testTimeout: 20_000 });
const ESC = '\u001B';
const ENTER = '\r';
const TAB = '\t';
const DOWN = '\u001B[B';

// Waits end by wall time, not by a count of ticks: a loaded machine paints later (fix 1c).
const WAIT_MS = 10_000;
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const flat = (frame: string) => frame.split('\n').map((l) => l.replace(/^\| /, '').replace(/\s*\|$/, '').trim()).join(' ').replace(/\s+/g, ' ');
const bars = (frame: string) => frame.split('\n').slice(-4, -1).join(' ');
const never = () => new Promise<Reply>(() => undefined);

const B = '/api/bots/b1';
const OFF_REFUSAL = 'This bot is Off. Choose Running in its State window to start it';

// The /ws channel as client.openWs gives it: frames reach every open listener; the test sends them.
interface WsFake extends Omit<Fake, 'on'> {
  on: (method: string, path: string, answer: Reply | ((body: unknown) => Reply | Promise<Reply>)) => WsFake;
  emit: (type: string, data: unknown) => void;
  opened: number;
  closed: number;
  open: () => number;
}

function wsFake(): WsFake {
  const f = fake() as WsFake;
  const listeners = new Set<(msg: { type: string; data: unknown }) => void>();
  f.opened = 0;
  f.closed = 0;
  f.open = () => listeners.size;
  f.emit = (type, data) => {
    for (const l of [...listeners]) l({ type, data });
  };
  (f.client as unknown as { openWs: unknown }).openWs = (onMessage: (msg: { type: string; data: unknown }) => void, onOpen?: () => void) => {
    f.opened++;
    setTimeout(() => {
      listeners.add(onMessage);
      onOpen?.();
    }, 1);
    return {
      close: () => {
        if (listeners.delete(onMessage)) f.closed++;
      },
    };
  };
  return f;
}

// The bot:maintenance broadcast of bots.ts:582: the bot record plus id, opId, settled and text.
const maintenanceEvent = (opId: string | null, settled: boolean, text: string) => ({ ...botRow({ status: 'running' }), id: 'b1', opId, settled, text });
// The bot:migrate broadcast of bots.ts:120 to 123: the bot record (migrate, migrateLast) plus id, text and final.
const migrateEvent = (id: string, text: string, final: boolean, over: Record<string, unknown> = {}) => ({ ...botRow({ id }), migrate: null, migrateLast: null, id, text, final, ...over });

function routes(f: WsFake, bot: Record<string, unknown> = mainBot()): WsFake {
  f.on('GET', '/api/bots', botList([bot]))
    .on('GET', '/api/bots/fleet/orphan-backups', orphansBody())
    .on('GET', `${B}/maintenance`, stateInfo())
    .on('GET', `${B}/migrate`, migrateBody());
  return f;
}

const opened: Array<{ unmount: () => void; session: Session }> = [];
afterEach(() => {
  for (const o of opened.splice(0)) {
    o.unmount();
    o.session.stop();
  }
});

async function start(f: Fake | WsFake, opts: { state?: StateOptions; columns?: number } = {}) {
  const session = new Session(f.client, () => T0);
  await session.refresh();
  const view = render(createElement(App, {
    machine: 'box1', session, onHandOff: vi.fn(), now: () => T0,
    databaseOptions: { everyMs: 60_000, limitMs: 2000, env: { HOST_DATA_DIR: '/srv' }, timeZone: 'UTC' },
    stateOptions: { limitMs: 2000, waitMs: 1000, ...opts.state },
  }));
  (view.stdout as unknown as { rows: number }).rows = 60;
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
  return { ...view, session, frame, press, until };
}

async function openState(f: Fake | WsFake, opts: Parameters<typeof start>[1] = {}) {
  const v = await start(f, opts);
  await v.press(ENTER);
  await v.until('Name mybot');
  await v.press('t');
  await v.until('State: mybot');
  return v;
}

const puts = (f: Fake | WsFake) => f.calls.filter((c) => c.method === 'PUT' && c.path === `${B}/maintenance`).map((c) => c.body);
const posts = (f: Fake | WsFake, path: string) => f.calls.filter((c) => c.method === 'POST' && c.path === path);

describe('m4 the State screen: reading', () => {
  it('T opens it from the bot screen with the summary, held line, states, kind note, message and Migrate', async () => {
    const f = routes(wsFake()).on('GET', `${B}/maintenance`, stateInfo({
      state: 'maintenance', message: 'Back at noon', summary: "State: Maintenance. The bot's database login is blocked and none of its sessions is open.",
      held: { state: 'no', guilds: 2, files: 1, note: 'guild 7 failed' }, lastError: 'the hook timed out once',
    }));
    const v = await start(f);
    await v.press(ENTER);
    await v.until('State Running');
    expect(bars(v.frame())).toContain('T State');
    await v.press('t');
    await v.until("State: Maintenance. The bot's database login is blocked and none of its sessions is open.");
    await v.until('Last error: the hook timed out once');
    await v.until("The bot reports changes it could not save: 2 guild(s), 1 file(s). Its log names them. The bot's note: guild 7 failed");
    await v.until('( ) Running The bot runs normally.');
    await v.until('> (*) Maintenance The bot stays online and answers every command with the message below');
    await v.until("( ) Off The bot is stopped. Its database keeps running for backups and copies, with the bot's login blocked.");
    await v.until("The manager blocks the bot's database login and closes its open connections");
    await v.until('Maintenance message [Back at noon');
    await v.until('12 / 1500');
    await v.until("M Migrate to Postgres: copy this bot's data to Postgres and switch to it.");
    expect(bars(v.frame())).toContain('M Migrate');
    expect(f.opened).toBe(1);
  });

  it('a refused, unanswered and late read shows the page\'s text and keeps the screen', async () => {
    let answer: 'refuse' | 'none' | 'late' = 'refuse';
    const f = routes(wsFake()).on('GET', `${B}/maintenance`, () => (answer === 'refuse' ? refused(404, { success: false, error: 'Bot not found' }) : answer === 'none' ? noAnswer() : never()));
    const v = await openState(f, { state: { limitMs: 200 } });
    await v.until('State: mybot Bot not found');
    expect(bars(v.frame())).toContain('Esc Back');
    await v.press(ESC);
    answer = 'none';
    await v.press('t');
    await v.until("No answer from the manager, so the bot's state can't be shown (connect ECONNREFUSED 127.0.0.1:8080).");
    await v.press(ESC);
    answer = 'late';
    await v.press('t');
    await v.until("No answer from the manager, so the bot's state can't be shown (the manager did not answer within 200 ms).");
    expect(puts(f)).toEqual([]);
  });

  it('kind none offers no Maintenance; the migrate read failing says so; a hidden migrate shows nothing', async () => {
    const f = routes(wsFake()).on('GET', `${B}/maintenance`, stateInfo({ kind: 'none' })).on('GET', `${B}/migrate`, noAnswer());
    const v = await openState(f);
    await v.until('Maintenance (not available)');
    await v.until("can't read the migration state: the manager did not answer (connect ECONNREFUSED 127.0.0.1:8080).");
    await v.press(DOWN);
    await v.until('> (*) Off');
    await v.press(DOWN);
    await v.until('> (*) Running');
    const g = routes(wsFake()).on('GET', `${B}/migrate`, migrateBody({ hidden: true, to: null }));
    const w = await openState(g);
    await w.until('Maintenance message');
    expect(flat(w.frame())).not.toContain('Migrate to');
  });

  it('T on the Database screen opens it, and Esc goes back to the Database screen', async () => {
    const f = routes(wsFake())
      .on('GET', `${B}/memory`, memoryBody()).on('GET', `${B}/fleet-connections`, connectionsBody()).on('GET', `${B}/fleet-replica`, replicaBody())
      .on('GET', `${B}/fleet-backups`, backupsBody([])).on('GET', `${B}/fleet-replication`, replicationOff()).on('GET', `${B}/fleet-switch`, switchBody());
    const v = await start(f);
    await v.press(ENTER);
    await v.until('Name mybot');
    await v.press('d');
    await v.until('Database: mybot');
    expect(bars(v.frame())).toContain('T State');
    await v.press('t');
    await v.until('Maintenance message');
    await v.press(ESC);
    await v.until('Database: mybot');
    expect(f.closed).toBe(1);
  });
});

describe('m4 the State screen: changing the state', () => {
  it('accepted, the event for another opId ignored, then settled', async () => {
    const f = routes(wsFake()).on('PUT', `${B}/maintenance`, () => {
      setTimeout(() => f.emit('bot:maintenance', maintenanceEvent('other-op', false, 'Another order failed')), 40);
      setTimeout(() => f.emit('bot:maintenance', maintenanceEvent(null, false, 'A reconcile note')), 60);
      setTimeout(() => f.emit('bot:maintenance', maintenanceEvent('op-7', true, 'mybot is in Maintenance.')), 600);
      return stateAccepted('op-7');
    });
    const v = await openState(f, { state: { waitMs: 5000 } });
    await v.until('> (*) Running');
    await v.press(DOWN);
    await v.press(ENTER);
    await v.until('Changing the state of mybot; the result shows here when it finishes');
    await tick(150);
    expect(flat(v.frame())).not.toContain('Another order failed');
    expect(flat(v.frame())).not.toContain('A reconcile note');
    await v.until('mybot is in Maintenance.');
    expect(puts(f)).toEqual([{ state: 'maintenance', message: '' }]);
    await v.press(ESC);
    await v.until('mybot is in Maintenance.');
  });

  it('not settled shows the event text as a failure; the typed message is sent', async () => {
    const f = routes(wsFake()).on('PUT', `${B}/maintenance`, () => {
      setTimeout(() => f.emit('bot:maintenance', maintenanceEvent('op-8', false, 'State: Maintenance, not confirmed: the hook did not answer')), 50);
      return stateAccepted('op-8');
    });
    const v = await openState(f);
    await v.press(DOWN, TAB);
    await v.until('Enter Apply Tab States');
    for (const ch of 'Back soon') await v.press(ch);
    await v.until('[Back soon');
    await v.press(ENTER);
    await v.until('State: Maintenance, not confirmed: the hook did not answer');
    expect(puts(f)).toEqual([{ state: 'maintenance', message: 'Back soon' }]);
  });

  it('no event within the limit is "can\'t confirm"; a second Enter while it runs sends nothing', async () => {
    const f = routes(wsFake()).on('PUT', `${B}/maintenance`, stateAccepted('op-9'));
    const v = await openState(f, { state: { waitMs: 1000 } });
    await v.press(DOWN, ENTER);
    await v.until('Changing the state of mybot');
    await v.press(ENTER);
    await v.until('A state change of mybot is running; its result shows here when it finishes.');
    await v.until("can't confirm the state change of mybot: no completion event within 1 s; it may still be running.");
    expect(puts(f)).toHaveLength(1);
  });

  it('refused keeps the screen with the route\'s error; no answer shows the page\'s text', async () => {
    let answer: 'busy' | 'none' = 'busy';
    const f = routes(wsFake()).on('PUT', `${B}/maintenance`, () => (answer === 'busy' ? stateBusy() : noAnswer()));
    const v = await openState(f);
    await v.press(DOWN, ENTER);
    await v.until("Operation 'update' already in progress");
    expect(flat(v.frame())).toContain('Maintenance message');
    answer = 'none';
    await v.press(ENTER);
    await v.until('No answer from the manager; the state change may still be running. Check its state before trying again.');
    expect(puts(f)).toHaveLength(2);
  });

  it('Off with a held warning asks first: another key sends nothing, Y sends once; without one it sends at once', async () => {
    const held = mainBot({ maintenance: { state: 'maintenance', settled: true, held: { state: 'unknown' } } });
    const f = routes(wsFake(), held).on('PUT', `${B}/maintenance`, () => {
      setTimeout(() => f.emit('bot:maintenance', maintenanceEvent('op-10', true, 'mybot is Off.')), 30);
      return stateAccepted('op-10');
    }).on('GET', `${B}/maintenance`, stateInfo({ state: 'maintenance', held: { state: 'unknown' } }));
    const v = await openState(f);
    await v.until('> (*) Maintenance');
    await v.press(DOWN, ENTER);
    await v.until("The manager can't confirm the bot saved the changes it holds. Off stops the bot and drops any it still holds. Choose Off anyway?");
    expect(bars(v.frame())).toContain('Y Off  any other key Cancel');
    await v.press('n');
    await v.until('Cancelled: nothing was sent.');
    expect(puts(f)).toEqual([]);
    await v.press(ENTER);
    await v.until('Choose Off anyway?');
    await v.press('y');
    await v.until('mybot is Off.');
    expect(puts(f)).toEqual([{ state: 'off', message: '' }]);

    const g = routes(wsFake(), mainBot({ maintenance: { state: 'maintenance', settled: true, held: { state: 'yes' } } })).on('PUT', `${B}/maintenance`, stateAccepted('op-11'))
      .on('GET', `${B}/maintenance`, stateInfo({ state: 'maintenance', held: { state: 'yes' } }));
    const w = await openState(g);
    await w.until("The bot's last answer: it saved every change it held.");
    await w.press(DOWN, ENTER);
    await w.until('Changing the state of mybot');
    expect(puts(g)).toEqual([{ state: 'off', message: '' }]);
  });
});

describe('m4 Migrate', () => {
  it('a refusal shows instead of the action and nothing is sent', async () => {
    const refusal = 'Migrate runs with the bot in Maintenance; choose Maintenance in State first; nothing was changed';
    const f = routes(wsFake()).on('GET', `${B}/migrate`, migrateBody({ refusal }));
    const v = await openState(f);
    await v.until(`Migrate to Postgres: ${refusal}`);
    await v.press('m');
    await v.until(refusal);
    expect(posts(f, `${B}/migrate`)).toEqual([]);
  });

  it('no record: the dialog, another key, then Y posts once and says it was accepted', async () => {
    const f = routes(wsFake()).on('POST', `${B}/migrate`, migrateAccepted());
    const v = await openState(f);
    await v.until('M Migrate to Postgres');
    await v.press('m');
    await v.until("Migrate mybot's data to the managed Postgres on this server? The bot restarts once into maintenance");
    expect(bars(v.frame())).toContain('Y Migrate');
    await v.press('x');
    await v.until('Cancelled: nothing was sent.');
    expect(posts(f, `${B}/migrate`)).toEqual([]);
    await v.press('m');
    await v.until('Y Migrate');
    await v.press('y');
    await v.until('The manager accepted the migration to Postgres; the State screen shows its progress and its outcome');
    expect(posts(f, `${B}/migrate`).map((c) => c.body)).toEqual([{ to: 'postgres' }]);
  });

  it('an open record goes on without a dialog; the record and last lines show', async () => {
    const f = routes(wsFake()).on('GET', `${B}/migrate`, migrateBody({
      to: 'file', record: { to: 'file', phase: 'waiting', text: 'The copy stopped; press Migrate to go on.', openedAt: '2026-11-14T09:00:00.000Z' },
      last: { to: 'postgres', outcome: 'done', text: 'Moved to Postgres.', at: '2026-11-10T09:00:00.000Z', jobId: null },
    })).on('POST', `${B}/migrate`, migrateAccepted());
    const v = await openState(f);
    await v.until('Migration to JSON files, opened 2026-11-14 09:00 UTC: The copy stopped; press Migrate to go on.');
    await v.until('Last migration (2026-11-10 09:00 UTC): Moved to Postgres.');
    await v.press('m');
    await v.until('The manager goes on with the open migration to JSON files; the State screen shows its progress and its outcome');
    expect(posts(f, `${B}/migrate`).map((c) => c.body)).toEqual([{ to: 'file' }]);
  });

  it('the POST refused and unanswered, and the GET unanswered, use the page\'s texts', async () => {
    let post: 'refuse' | 'none' = 'refuse';
    let get: 'ok' | 'none' = 'ok';
    const f = routes(wsFake())
      .on('GET', `${B}/migrate`, () => (get === 'ok' ? migrateBody({ record: { to: 'postgres', phase: 'waiting', text: 'x', openedAt: T0 } }) : noAnswer()))
      .on('POST', `${B}/migrate`, () => (post === 'refuse' ? refused(409, { success: false, error: "Operation 'update' already in progress" }) : noAnswer()));
    const v = await openState(f);
    await v.until('M Migrate to Postgres');
    await v.press('m');
    await v.until("Operation 'update' already in progress");
    post = 'none';
    await v.press('m');
    await v.until("No answer from the manager, so it can't confirm the migration started (connect ECONNREFUSED 127.0.0.1:8080).");
    get = 'none';
    await v.press('m');
    await v.until("No answer from the manager, so the migration can't start (connect ECONNREFUSED 127.0.0.1:8080).");
    expect(posts(f, `${B}/migrate`)).toHaveLength(2);
  });

  it('shows this bot\'s bot:migrate texts, ignores another bot\'s, judges final, and closes the listener on Esc', async () => {
    const f = routes(wsFake());
    const v = await openState(f);
    await v.until('Maintenance message');
    for (const end = Date.now() + WAIT_MS; Date.now() < end && f.open() === 0;) await tick(10);
    f.emit('bot:migrate', migrateEvent('b1', 'Copying guild 1 of 3.', false));
    f.emit('bot:migrate', migrateEvent('b2', 'Other bot copying.', false));
    await v.until('Copying guild 1 of 3.');
    expect(flat(v.frame())).not.toContain('Other bot copying.');
    f.emit('bot:migrate', migrateEvent('b1', 'The migration to Postgres finished.', true, { migrateLast: { to: 'postgres', outcome: 'done', text: 'x', at: '2026-11-14T10:00:00.000Z' } }));
    await v.until('Migration finished: The migration to Postgres finished.');
    f.emit('bot:migrate', migrateEvent('b1', 'The copy failed: disk full.', true, { migrate: { to: 'postgres', phase: 'waiting' } }));
    await v.until('Migration did not finish: The copy failed: disk full.');
    f.emit('bot:migrate', migrateEvent('b1', 'It failed.', true, { migrateLast: { to: 'postgres', outcome: 'failed', text: 'x', at: '2026-11-14T10:00:00.000Z' } }));
    await v.until('Migration did not finish: It failed.');
    await v.press(ESC);
    await v.until('Name mybot');
    expect(f.closed).toBe(1);
    expect(f.open()).toBe(0);
  });
});

describe('m4 the held warning in M1\'s dialogs, and S on an Off bot', () => {
  const heldBot = (state: string) => mainBot({ maintenance: { state: 'maintenance', settled: true, held: { state, guilds: 1, files: 0 } } });

  it('stop and restart name the held changes; a bot with none gets the plain dialog', async () => {
    const v = await start(routes(wsFake(), heldBot('no')));
    await v.press(ENTER);
    await v.until('Name mybot');
    await v.press('s');
    await v.until('Stop mybot? The bot goes offline until it is started again. The bot reports changes it could not save: 1 guild(s), 0 file(s). Stopping the bot drops those changes. Stop anyway?');
    await v.press('n');
    await v.until('Cancelled: mybot was not stopped.');
    await v.press('r');
    await v.until('A restart stops the bot and drops those changes. Restart anyway?');
    await v.press('n');
    const w = await start(routes(wsFake(), heldBot('yes')));
    await w.press(ENTER);
    await w.until('Name mybot');
    await w.press('s');
    await w.until('Stop mybot?');
    expect(flat(w.frame())).not.toContain('anyway');
  });

  it('update asks only when there is a warning; another key sends nothing; without one it sends at once', async () => {
    const f = routes(wsFake(), heldBot('unknown')).on('POST', `${B}/update`, ok({ success: true, opId: 'u1' }));
    const v = await start(f);
    await v.press(ENTER);
    await v.until('Name mybot');
    await v.press('u');
    await v.until("Update mybot? The bot is recreated from its source. The manager can't confirm the bot saved the changes it holds. An update recreates the bot and drops any it still holds. Update anyway?");
    expect(bars(v.frame())).toContain('Y Update');
    await v.press('n');
    await v.until('Cancelled: mybot was not updated.');
    expect(posts(f, `${B}/update`)).toEqual([]);
    await v.press('u');
    await v.until('Update anyway?');
    await v.press('y');
    for (const end = Date.now() + WAIT_MS; Date.now() < end && posts(f, `${B}/update`).length === 0;) await tick(10);
    expect(posts(f, `${B}/update`)).toHaveLength(1);

    const g = routes(wsFake(), mainBot()).on('POST', `${B}/update`, ok({ success: true, opId: 'u2' }));
    const w = await start(g);
    await w.press(ENTER);
    await w.until('Name mybot');
    await w.press('u');
    for (const end = Date.now() + WAIT_MS; Date.now() < end && posts(g, `${B}/update`).length === 0;) await tick(10);
    expect(posts(g, `${B}/update`)).toHaveLength(1);
    expect(flat(w.frame())).not.toContain('Update anyway?');
  });

  it('S on an Off bot shows the route\'s refusal and sends nothing', async () => {
    const f = routes(wsFake(), mainBot({ status: 'stopped', maintenance: { state: 'off', settled: true } }));
    const v = await start(f);
    await v.press(ENTER);
    await v.until('State Off');
    await v.press('s');
    await v.until(OFF_REFUSAL);
    await tick(100);
    expect(posts(f, `${B}/start`)).toEqual([]);
  });
});
