import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import * as ink from 'ink';
import { render } from 'ink-testing-library';
import { createApp } from '../../src/cli/tui/app';
import type { DatabaseOptions } from '../../src/cli/tui/database';
import { Session } from '../../src/cli/tui/session';
import { botList, fake, Fake, ok, Reply } from './m2-fake';
import {
  backupsBody, backupStatus, connectionsBody, entry, family, mainBot, maintenanceBody, memoryBody, migrateAccepted, migrateBody, orphansBody,
  replicaBody, replicationOff, replicationOn, stateAccepted, stateInfo, switchBody, T0,
} from './m4-fake';

// Review 1's findings (out/M4/code-review1.md): each row was red on the code before fix 1.

const App = createApp(ink);
vi.setConfig({ testTimeout: 20_000 });
const ESC = '\u001B';
const ENTER = '\r';
const RIGHT = '\u001B[C';
const DOWN = '\u001B[B';

// Waits end by wall time, not by a count of ticks: a loaded machine paints later (fix 1c).
const WAIT_MS = 10_000;
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const flat = (frame: string) => frame.split('\n').map((l) => l.replace(/^\| /, '').replace(/\s*\|$/, '').trim()).join(' ').replace(/\s+/g, ' ');
const later = (ms: number, reply: Reply) => async () => {
  await tick(ms);
  return reply;
};

const B = '/api/bots/b1';
const FILE1 = 'hourly-2026-11-14T09-00-00-000Z.dump';

// /ws as client.openWs gives it, with a close the test can cause (the channel dropping).
interface WsFake extends Omit<Fake, 'on'> {
  on: (method: string, path: string, answer: Reply | ((body: unknown) => Reply | Promise<Reply>)) => WsFake;
  emit: (type: string, data: unknown) => void;
  drop: (reason: string) => void;
  failOpen: string | null;
}

function wsFake(): WsFake {
  const f = fake() as unknown as WsFake;
  const open = new Map<(msg: { type: string; data: unknown }) => void, ((reason: string) => void) | undefined>();
  f.failOpen = null;
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

function routes<T extends Fake | WsFake>(f: T, bot = mainBot()): T {
  (f as Fake)
    .on('GET', '/api/bots', botList([bot]))
    .on('GET', '/api/bots/fleet/orphan-backups', orphansBody())
    .on('GET', `${B}/maintenance`, maintenanceBody())
    .on('GET', `${B}/memory`, memoryBody())
    .on('GET', `${B}/fleet-connections`, connectionsBody())
    .on('GET', `${B}/fleet-replica`, replicaBody())
    .on('GET', `${B}/fleet-backups`, backupsBody([entry(FILE1)]))
    .on('GET', `${B}/fleet-replication`, replicationOff())
    .on('GET', `${B}/fleet-switch`, switchBody())
    .on('GET', `${B}/fleet-backups/restore-preview`, ok({ success: true, instances: [] }))
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

async function start(f: Fake | WsFake, opts: { db?: DatabaseOptions; columns?: number; rows?: number } = {}) {
  const session = new Session((f as Fake).client, () => T0);
  await session.refresh();
  const view = render(createElement(App, {
    machine: 'box1', session, onHandOff: vi.fn(), now: () => T0,
    databaseOptions: { everyMs: 60_000, limitMs: 2000, env: { HOST_DATA_DIR: '/srv' }, timeZone: 'UTC', hourSaveMs: 200, ...opts.db },
    stateOptions: { limitMs: 2000, waitMs: 2000 },
  }));
  (view.stdout as unknown as { rows: number }).rows = opts.rows ?? 120;
  Object.defineProperty(view.stdout, 'columns', { value: opts.columns ?? 140, configurable: true });
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
  await press(ENTER);
  await until('Name mybot');
  return { ...view, session, frame, press, until };
}

async function openDb(f: Fake | WsFake, opts: Parameters<typeof start>[1] = {}) {
  const v = await start(f, opts);
  await v.press('d');
  await v.until('Database: mybot');
  return v;
}

const sent = (f: Fake | WsFake, method: string, path: string) => (f as Fake).calls.filter((c) => c.method === method && c.path === path);

describe('m4 fix 1: one action at a time on the Database screen (A3, C3, C4)', () => {
  it('no hour moves and no second action starts while a restore runs', async () => {
    let finish: (r: Reply) => void = () => undefined;
    const f = routes(fake())
      .on('PUT', `${B}/fleet-backup-config`, ok({ success: true, fleetBackup: { enabled: true, hour: 5 } }))
      .on('POST', `${B}/fleet-backups/restore`, () => new Promise<Reply>((r) => { finish = r; }))
      .on('POST', `${B}/fleet-db/decommission`, ok({ success: true, dumpFile: 'x.dump' }));
    const v = await openDb(f);
    await v.until(`> ${FILE1}`);
    await v.press(ENTER);
    await v.until('Y Restore');
    await v.press('y');
    await v.until('Waiting for the manager');
    await v.press(RIGHT, 'k', 'y', ENTER, 'y', ' ');
    await tick(400);
    expect(sent(f, 'PUT', `${B}/fleet-backup-config`)).toEqual([]);
    expect(sent(f, 'POST', `${B}/fleet-db/decommission`)).toEqual([]);
    expect(sent(f, 'POST', `${B}/fleet-backups/restore`)).toHaveLength(1);
    finish(ok({ success: false, error: 'x', steps: {} }));
    await v.until('mybot');
    await tick(400);
    expect(sent(f, 'PUT', `${B}/fleet-backup-config`)).toEqual([]);
    expect(flat(v.frame())).not.toContain('not saved yet');
  });

  it('Space saves the moved hour with the toggle, once', async () => {
    const f = routes(fake()).on('PUT', `${B}/fleet-backup-config`, ok({ success: true, fleetBackup: { enabled: false, hour: 6 } }));
    const v = await openDb(f, { db: { hourSaveMs: 300 } });
    await v.until(`> ${FILE1}`);
    await v.press(RIGHT, RIGHT, ' ');
    await v.until('Backup settings saved');
    await tick(500);
    expect(sent(f, 'PUT', `${B}/fleet-backup-config`).map((c) => c.body)).toEqual([{ enabled: false, hour: 6, expected: { enabled: true, hour: 4 } }]);
  });
});

describe('m4 fix 1: slow panels (C1)', () => {
  it('every panel answering slower than the re-read still paints', async () => {
    const f = routes(fake())
      .on('GET', `${B}/maintenance`, later(300, maintenanceBody('State: Maintenance, slow.')))
      .on('GET', `${B}/memory`, later(300, memoryBody()))
      .on('GET', `${B}/fleet-connections`, later(300, connectionsBody({ state: 'unread', error: 'slow psql' })))
      .on('GET', `${B}/fleet-replica`, later(300, replicaBody()))
      .on('GET', `${B}/fleet-backups`, later(300, backupsBody([entry(FILE1)])))
      .on('GET', `${B}/fleet-replication`, later(300, replicationOn()))
      .on('GET', `${B}/fleet-switch`, later(300, switchBody({ lines: ['Slow move line.'] })));
    const v = await openDb(f, { db: { everyMs: 100, limitMs: 5000 } });
    for (const t of ['State: Maintenance, slow.', 'yes, 2048 MB free', 'slow psql', `> ${FILE1}`, 'Replication endpoint db.example.net:15432', 'Slow move line.']) await v.until(t);
  });

  it('a panel whose newest read is overdue says when its lines were read', async () => {
    let n = 0;
    const f = routes(fake()).on('GET', `${B}/fleet-switch`, () => (++n === 1 ? switchBody({ lines: ['First move line.'] }) : new Promise<Reply>(() => undefined)));
    const v = await openDb(f, { db: { everyMs: 100, limitMs: 5000 } });
    await v.until('First move line.');
    await v.until('The manager has not answered the newest read of the lines below for');
  });
});

describe('m4 fix 1: the notice (C2, A1, A2)', () => {
  it('a held restore\'s outcome shows on the bot screen at 80x24 under long badge titles, naming its bot', async () => {
    const long = 'A very long badge title that wraps over several lines of the bot screen at eighty columns, '.repeat(3);
    const bot = mainBot({
      fleetBackup: backupStatus({ main: family({ alerts: { dumps: { text: long, since: T0, dm: 'pending' }, test: { text: long, since: T0, dm: 'pending' } } }) }),
      fenceStuck: long,
    });
    let finish: (r: Reply) => void = () => undefined;
    const f = routes(fake(), bot).on('POST', `${B}/fleet-backups/restore`, () => new Promise<Reply>((r) => { finish = r; }));
    const v = await start(f, { columns: 80, rows: 24 });
    await v.press('d');
    await v.until(`> ${FILE1}`);
    await v.press(ENTER);
    await v.until('Y Restore');
    await v.press('y', ESC);
    await v.until('Name mybot');
    finish(ok({ success: false, error: 'The dump x has no counts file (x.json), so the manager cannot check what it restores and the restore was refused (nothing was changed); restore another dump', steps: {} }));
    await v.until('mybot: The dump x has no counts file');
  });

  it('a State screen outcome on the bot screen names its bot', async () => {
    const f = routes(wsFake()).on('PUT', `${B}/maintenance`, () => {
      setTimeout(() => f.emit('bot:maintenance', { id: 'b1', opId: 'op-1', settled: true, text: 'The bot is in Maintenance.' }), 30);
      return stateAccepted('op-1');
    });
    const v = await start(f);
    await v.press('t');
    await v.until('Maintenance message');
    await v.press(DOWN, ENTER);
    await v.until('The bot is in Maintenance.');
    await v.press(ESC);
    await v.until('mybot: The bot is in Maintenance.');
  });

  it('a running action never shows an earlier outcome as its own', async () => {
    let finish: (r: Reply) => void = () => undefined;
    const bot = mainBot({ fleetBackup: backupStatus({ restoreError: 'The restore failed', restoreErrorAt: '2026-11-14T09:30:00.000Z' }) });
    const f = routes(fake(), bot)
      .on('DELETE', `${B}/fleet-backups/restore-error?at=${encodeURIComponent('2026-11-14T09:30:00.000Z')}`, ok({ success: true, dismissed: true }))
      .on('POST', `${B}/fleet-db/decommission`, () => new Promise<Reply>((r) => { finish = r; }));
    const v = await openDb(f);
    await v.press('x', 'y');
    await v.until('Restore notice dismissed.');
    await v.press('k');
    await v.until('Y Decommission');
    expect(flat(v.frame())).not.toContain('Restore notice dismissed.');
    await v.press('y');
    await v.until('Waiting for the manager');
    await tick(100);
    expect(flat(v.frame())).not.toContain('Restore notice dismissed.');
    finish(ok({ success: true, dumpFile: 'x.dump' }));
    await v.until('Database decommissioned; safety dump kept: x.dump.');
  });
});

describe('m4 fix 1: the State screen (B1, B2, B3, B4)', () => {
  it('a PUT accepted after the wait ended leaves no state change running (B1)', async () => {
    let n = 0;
    const f = routes(wsFake()).on('PUT', `${B}/maintenance`, async () => {
      n += 1;
      if (n === 1) {
        await tick(50);
        f.drop('closed (code 1006)');
        await tick(100);
      }
      return stateAccepted(`op-${n}`);
    });
    const v = await start(f);
    await v.press('t');
    await v.until('Maintenance message');
    await v.press(DOWN, ENTER);
    await v.until('No answer from the manager; the state change may still be running.');
    await tick(200);
    await v.press(ENTER);
    await tick(100);
    expect(flat(v.frame())).not.toContain('A state change of mybot is running');
    expect(sent(f, 'PUT', `${B}/maintenance`)).toHaveLength(2);
  });

  it('a PUT reply that is not JSON is no answer (B2)', async () => {
    const f = routes(wsFake()).on('PUT', `${B}/maintenance`, { status: 502, ok: false, body: 'Bad Gateway' });
    const v = await start(f);
    await v.press('t');
    await v.until('Maintenance message');
    await v.press(DOWN, ENTER);
    await v.until('No answer from the manager; the state change may still be running. Check its state before trying again.');
  });

  it('an older state read that answers last is dropped (B3)', async () => {
    let n = 0;
    const f = routes(wsFake()).on('GET', `${B}/maintenance`, async () => {
      n += 1;
      if (n === 1) {
        await tick(400);
        return stateInfo({ summary: 'State: Running (old read).' });
      }
      return stateInfo({ state: 'maintenance', summary: 'State: Maintenance (new read).' });
    });
    const v = await start(f);
    await v.press('t');
    await tick(50);
    f.emit('bot:migrate', { id: 'b1', text: 'Copying.', final: false });
    await v.until('State: Maintenance (new read).');
    await tick(500);
    expect(flat(v.frame())).toContain('State: Maintenance (new read).');
    expect(flat(v.frame())).not.toContain('old read');
  });

  it('an accepted migrate with the channel closed says how to follow it (B4)', async () => {
    const f = routes(wsFake()).on('POST', `${B}/migrate`, migrateAccepted());
    f.failOpen = 'connect ECONNREFUSED 127.0.0.1:8080';
    const v = await start(f);
    await v.press('t');
    await v.until('M Migrate to Postgres');
    await v.press('m', 'y');
    await v.until('The manager accepted the migration to Postgres; the event channel is closed, so this screen does not show its progress: press Esc, then T, to follow it.');
    expect(flat(v.frame())).not.toContain('the State screen shows its progress');
  });
});


// Fix 1b (code-review1.md, Round 2): each row was red on fix 1's code.
describe('m4 fix 1b: a moved hour and a held restore (C5 = A6, A7)', () => {
  it('Enter, K and X are refused while a moved hour waits, and nothing is sent', async () => {
    const bot = mainBot({ fleetBackup: backupStatus({ restoreError: 'The restore failed', restoreErrorAt: '2026-11-14T09:30:00.000Z' }) });
    const f = routes(fake(), bot).on('PUT', `${B}/fleet-backup-config`, ok({ success: true, fleetBackup: { enabled: true, hour: 5 } }));
    const v = await openDb(f, { db: { hourSaveMs: 1500 } });
    await v.until(`> ${FILE1}`);
    await v.press(RIGHT);
    await v.until('at 05:00 (not saved yet)');
    for (const k of [ENTER, 'k', 'x']) {
      await v.press(k);
      await v.until('The backup hour 05:00 is not saved yet; it is saved a second after the last arrow key.');
      expect(flat(v.frame())).not.toMatch(/Y Restore|Y Decommission|Y Dismiss/);
    }
    expect(sent(f, 'GET', `${B}/fleet-backups/restore-preview`)).toEqual([]);
    await v.until('Backup settings saved');
    expect(sent(f, 'PUT', `${B}/fleet-backup-config`)).toHaveLength(1);
  });

  it('leaving with a moved hour unsaved says so on the bot screen and sends nothing', async () => {
    const f = routes(fake()).on('PUT', `${B}/fleet-backup-config`, ok({ success: true, fleetBackup: { enabled: true, hour: 5 } }));
    const v = await openDb(f, { db: { hourSaveMs: 1500 } });
    await v.until(`> ${FILE1}`);
    await v.press(RIGHT, ESC);
    await v.until('mybot: The backup hour 05:00 was not saved.');
    await tick(1700);
    expect(sent(f, 'PUT', `${B}/fleet-backup-config`)).toEqual([]);
  });

  it('a Database screen opened again during a held restore waits for it and sends no second restore', async () => {
    let finish: (r: Reply) => void = () => undefined;
    const f = routes(fake()).on('POST', `${B}/fleet-backups/restore`, () => new Promise<Reply>((r) => { finish = r; }));
    const v = await openDb(f);
    await v.until(`> ${FILE1}`);
    await v.press(ENTER);
    await v.until('Y Restore');
    await v.press('y', ESC);
    await v.until('Name mybot');
    await v.press('d');
    await v.until('Waiting for the manager');
    await v.press(ENTER, 'y', 'k', 'y');
    expect(sent(f, 'POST', `${B}/fleet-backups/restore`)).toHaveLength(1);
    expect(sent(f, 'GET', `${B}/fleet-backups/restore-preview`)).toHaveLength(1);
    finish(ok({ success: false, error: 'The dump x has no counts file (x.json), so the manager cannot check what it restores and the restore was refused (nothing was changed); restore another dump', steps: {} }));
    await v.until('mybot: The dump x has no counts file');
    expect(flat(v.frame())).not.toContain('Waiting for the manager');
  });
});
