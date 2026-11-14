import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import * as ink from 'ink';
import { render } from 'ink-testing-library';
import { createApp } from '../../src/cli/tui/app';
import type { DatabaseOptions } from '../../src/cli/tui/database';
import { restoreOutcome, restoreSharersText } from '../../src/cli/tui/dbtext';
import { Session } from '../../src/cli/tui/session';
import { botList, fake, Fake, noAnswer, ok, refused, Reply } from './m2-fake';
import {
  backupsBody, backupStatus, connectionsBody, entry, HOUR, mainBot, maintenanceBody, memoryBody, orphansBody, replicaBody, replicationOff, switchBody, T0,
} from './m4-fake';

const App = createApp(ink);
vi.setConfig({ testTimeout: 20_000 });
const ESC = '\u001B';
const ENTER = '\r';
const RIGHT = '\u001B[C';

// Waits end by wall time, not by a count of ticks: a loaded machine paints later (fix 1c).
const WAIT_MS = 10_000;
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const flat = (frame: string) => frame.split('\n').map((l) => l.replace(/^\| /, '').replace(/\s*\|$/, '').trim()).join(' ').replace(/\s+/g, ' ');
const bars = (frame: string) => frame.split('\n').slice(-4, -1).join(' ');

const B = '/api/bots/b1';
const FILE1 = 'hourly-2026-11-14T09-00-00-000Z.dump';
const FILE2 = 'moved-from-contabo.dump';
const AT = '2026-11-14T09:30:00.000Z';

// PUT /api/bots/:id/fleet-backup-config (bots.ts:1654 to 1693).
const configSaved = (fleetBackup: unknown) => ok({ success: true, fleetBackup });
const configConflict = (fleetBackup: unknown) => refused(409, { success: false, error: 'The backup settings were changed elsewhere. Nothing was saved; the stored settings are shown.', fleetBackup });
// GET restore-preview (bots.ts:1760 to 1771, previewFleetRestore fleetBackup.ts:1703 to 1719).
const preview = (instances: unknown[]) => ok({ success: true, instances });
// POST restore (bots.ts:1779 to 1811).
const NOTE = 'The bot stays in its state until you choose Running in its State window. Then the bot loads the restored data: a process of it that ran before the restore, on this machine or another, restarts itself first. The State window says whether the bot here confirmed its restart.';
const steps = (over: Record<string, unknown> = {}) => ({
  restored: true, preRestoreDump: 'pre-restore-2026-11-14.dump', guildsRaised: ['g1', 'g2'], claimRaisedTo: 9, claimFloor: 8, shardClaimsRaised: 3, shardClaimsExpired: 4,
  counts: { result: 'matched', tables: 12, rows: 3400 }, botState: 'maintenance', stopped: ['b2'], restarted: ['b2'], ...over,
});
const restored = (over: Record<string, unknown> = {}) => ok({ success: true, steps: steps(), note: NOTE, ...over });
const restoreFailed = (error: string, s: Record<string, unknown>) => ok({ success: false, error, steps: s });
// The restore's own failure texts. A raise that failed after the rebuild: fleetBackup.ts:2660 to 2662, with keepFenced's
// return (:2316) for a fence lifted to read-only (:2300), no instance left stopped (:2309) and a safety dump (:2312).
const SAFETY = 'pre-restore-2026-11-14.dump';
const RAISE_REASON = 'the restored claim numbers could not be raised above 8 (psql: connection lost)';
const RESTORED_BUT = `The dump was restored, but ${RAISE_REASON}. The write fence stays on and the bot stays in maintenance, so nothing writes to a database that may be missing or partial; the database is READ-ONLY and no longer refuses connections; with the bot in Maintenance or Off, restore a dump again: the pre-restore dump ${SAFETY} holds the database as it was`;
// The admission refusal (fleetBackup.ts:2164 with restoreAdmissionBlock :1724).
const MIGRATION_OPEN = 'A data migration of this bot is open; finish it before restoring a dump (nothing was changed)';
// decommissionFleetDb's refusal for a running bot (fleetReplica.ts:1681).
const STOP_FIRST = 'Stop the instance first: decommission destroys the database it is running on';
// DELETE restore-error (bots.ts:1746 to 1757, dismissShownRestoreNotice fleetBackup.ts:128 to 136).
const dismissed = (d: boolean) => ok({ success: true, dismissed: d });
// POST decommission (bots.ts:1817 to 1830; the migration gate :113, containerManager.ts:801).
const decommissioned = (body: Record<string, unknown>) => ok({ success: true, ...body });

function routes(f: Fake, bot = mainBot()): Fake {
  return f
    .on('GET', '/api/bots', botList([bot]))
    .on('GET', '/api/bots/fleet/orphan-backups', orphansBody())
    .on('GET', `${B}/maintenance`, maintenanceBody())
    .on('GET', `${B}/memory`, memoryBody())
    .on('GET', `${B}/fleet-connections`, connectionsBody())
    .on('GET', `${B}/fleet-replica`, replicaBody())
    .on('GET', `${B}/fleet-backups`, backupsBody([entry(FILE1), entry(FILE2, { mtime: T0 - 2 * HOUR, tables: null })]))
    .on('GET', `${B}/fleet-replication`, replicationOff())
    .on('GET', `${B}/fleet-switch`, switchBody())
    .on('GET', `${B}/fleet-backups/restore-preview`, preview([{ id: 'b1', displayName: 'mybot', running: false }, { id: 'b2', displayName: 'otherbot', running: true }]));
}

const opened: Array<{ unmount: () => void; session: Session }> = [];
afterEach(() => {
  for (const o of opened.splice(0)) {
    o.unmount();
    o.session.stop();
  }
});

async function openDb(f: Fake, db: DatabaseOptions = {}) {
  const session = new Session(f.client, () => T0);
  await session.refresh();
  const view = render(createElement(App, {
    machine: 'box1', session, onHandOff: vi.fn(), now: () => T0,
    databaseOptions: { everyMs: 60_000, limitMs: 2000, env: { HOST_DATA_DIR: '/srv/smdb/data' }, timeZone: 'UTC', hourSaveMs: 200, ...db },
  }));
  (view.stdout as unknown as { rows: number }).rows = 120;
  Object.defineProperty(view.stdout, 'columns', { value: 140, configurable: true });
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
  await press('d');
  await until('Database: mybot');
  await until(`> ${FILE1}`);
  return { ...view, session, frame, press, until };
}

const sent = (f: Fake, method: string, path: string) => f.calls.filter((c) => c.method === method && c.path === path);
const listReads = (f: Fake) => sent(f, 'GET', '/api/bots').length;

describe('m4 the backup schedule', () => {
  it('Space turns backups off with only that field and its stored value, then reads the bot list again', async () => {
    const f = routes(fake()).on('PUT', `${B}/fleet-backup-config`, configSaved({ enabled: false, hour: 4 }));
    const v = await openDb(f);
    await v.until('[x] Backups Daily backup and test restore at 04:00');
    expect(bars(v.frame())).toContain('Space Backups');
    const reads = listReads(f);
    await v.press(' ');
    await v.until('Backup settings saved: backups off, daily backup and test restore at 04:00.');
    expect(sent(f, 'PUT', `${B}/fleet-backup-config`).map((c) => c.body)).toEqual([{ enabled: false, expected: { enabled: true } }]);
    for (const end = Date.now() + WAIT_MS; Date.now() < end && listReads(f) === reads;) await tick(10);
    expect(listReads(f)).toBeGreaterThan(reads);
  });

  it('Left and Right move the hour, a re-read keeps it, and it is saved once after the last press', async () => {
    const f = routes(fake()).on('PUT', `${B}/fleet-backup-config`, configSaved({ enabled: true, hour: 6 }));
    const v = await openDb(f, { everyMs: 50, hourSaveMs: 1000 });
    await v.press(RIGHT, RIGHT);
    await v.until('Daily backup and test restore at 06:00 (not saved yet)');
    await v.session.refresh();
    await tick(100);
    expect(flat(v.frame())).toContain('at 06:00 (not saved yet)');
    await v.until('Backup settings saved: backups on, daily backup and test restore at 06:00.');
    expect(sent(f, 'PUT', `${B}/fleet-backup-config`).map((c) => c.body)).toEqual([{ hour: 6, expected: { hour: 4 } }]);
  });

  it('a 409 shows the route\'s error and puts back the settings it returned', async () => {
    let stored = backupStatus();
    const f = routes(fake());
    f.on('GET', '/api/bots', () => botList([mainBot({ fleetBackup: stored })]))
      .on('PUT', `${B}/fleet-backup-config`, () => {
        stored = backupStatus({ enabled: true, hour: 7 });
        return configConflict({ enabled: true, hour: 7 });
      });
    const v = await openDb(f);
    await v.press(' ');
    await v.until('The backup settings were changed elsewhere. Nothing was saved; the stored settings are shown.');
    await v.until('[x] Backups Daily backup and test restore at 07:00');
  });

  it('success without settings, a refusal and no answer', async () => {
    let answer: () => Reply = () => ok({ success: true });
    const f = routes(fake()).on('PUT', `${B}/fleet-backup-config`, () => answer());
    const v = await openDb(f);
    await v.press(' ');
    await v.until("Can't confirm the backup settings: the manager did not return them. Reopen this screen to see what is stored.");
    answer = () => refused(400, { success: false, error: 'enabled must be true or false. Nothing was saved.' });
    await v.press(' ');
    await v.until('enabled must be true or false. Nothing was saved.');
    answer = noAnswer;
    await v.press(' ');
    await v.until("No answer from the manager, so the backup settings change can't be confirmed. Check whether it took effect before trying again.");
  });
});

describe('m4 restore', () => {
  it('Enter reads the preview and asks; another key sends nothing; a double Y sends one POST; no outcome before the answer', async () => {
    const f = routes(fake()).on('POST', `${B}/fleet-backups/restore`, async () => {
      await tick(1000);
      return restored();
    });
    const v = await openDb(f);
    expect(bars(v.frame())).toContain('Enter Restore');
    await v.press(ENTER);
    await v.until(`Restore "${FILE1}"? The bot must be in Maintenance or Off (its State screen)`);
    await v.until('Other instances on this manager share it: otherbot (running now). Each one docker shows running when the restore starts is stopped, and a fresh safety dump');
    expect(flat(v.frame())).not.toContain('State window');
    expect(bars(v.frame())).toContain('Y Restore');
    await v.press('n');
    await v.until('Cancelled: nothing was sent.');
    expect(sent(f, 'POST', `${B}/fleet-backups/restore`)).toEqual([]);
    await v.press(ENTER);
    await v.until('Y Restore');
    const before = v.frames.length;
    await v.press('y', 'y');
    await v.until('Waiting for the manager');
    await v.until('Restore complete: safety dump taken, 12 tables and 3400 rows matched the dump\'s counts, 2 guild(s) raised to claim 9, 3 shard claim(s) raised above 8, 4 restored shard claim(s) expired, the bot stays in maintenance, stopped 1, restarted 1.');
    const during = v.frames.slice(before);
    const firstDone = during.findIndex((fr) => flat(fr).includes('Restore complete'));
    expect(during.slice(0, firstDone).some((fr) => flat(fr).includes('Waiting for the manager'))).toBe(true);
    expect(sent(f, 'POST', `${B}/fleet-backups/restore`).map((c) => c.body)).toEqual([{ file: FILE1 }]);
  });

  it('a moved- dump says it becomes the main; preview refused and unanswered are worded', async () => {
    let p: () => Reply = () => ok({ success: false, error: 'Instance has no stored database URL' });
    const f = routes(fake()).on('GET', `${B}/fleet-backups/restore-preview`, () => p());
    const v = await openDb(f);
    await v.press('\u001B[B', ENTER);
    await v.until(`Restore "${FILE2}"? This backup was made for a move: restoring it makes this machine's database the main`);
    await v.until('The manager could not list the other instances that share it (Instance has no stored database URL); the ones docker shows running when the restore starts are stopped');
    await v.press('n');
    p = noAnswer;
    await v.press(ENTER);
    await v.until('The manager did not answer the list of other instances that share it; the ones docker shows running when the restore starts are stopped');
  });

  it('failure texts: the route\'s error, the restored-with-problems line, a 400, no answer', async () => {
    let answer: () => Reply = () => restoreFailed(RESTORED_BUT, { restored: true, preRestoreDump: SAFETY, stopped: [], botState: 'maintenance' });
    const f = routes(fake()).on('POST', `${B}/fleet-backups/restore`, () => answer());
    const v = await openDb(f);
    const run = async (text: string) => {
      await v.press(ENTER);
      await v.until('Y Restore');
      await v.press('y');
      await v.until(text);
    };
    await run(`${RESTORED_BUT} The data was restored, but the lane finished WITH PROBLEMS: ${RESTORED_BUT}`);
    answer = () => restoreFailed(MIGRATION_OPEN, { restored: false });
    await run(MIGRATION_OPEN);
    expect(flat(v.frame())).not.toContain('WITH PROBLEMS: A data migration');
    answer = () => refused(400, { success: false, error: 'file must be a bare file name' });
    await run('file must be a bare file name');
    answer = noAnswer;
    await run('No answer from the manager; the restore may still be running. Check its state before trying again.');
    expect(sent(f, 'POST', `${B}/fleet-backups/restore`)).toHaveLength(4);
  });

  it('Esc during a held restore leaves; the outcome lands on the bot screen', async () => {
    let finish: (r: Reply) => void = () => undefined;
    const f = routes(fake()).on('POST', `${B}/fleet-backups/restore`, () => new Promise<Reply>((r) => { finish = r; }));
    const v = await openDb(f);
    await v.press(ENTER);
    await v.until('Y Restore');
    await v.press('y');
    await v.until('Waiting for the manager Esc Back');
    await v.press('k');
    expect(flat(v.frame())).not.toContain('Decommission this database?');
    await v.press(ESC);
    await v.until('Name mybot');
    expect(flat(v.frame())).not.toContain('Restore complete');
    finish(restored({ warning: 'The bot did not confirm its restart.' }));
    await v.until('Restore complete: safety dump taken');
    await v.until('Restore finished WITH A WARNING: The bot did not confirm its restart.');
  });

  it('the success texts of restoreFleetBackupFile', () => {
    const t = (s: Record<string, unknown>, file = FILE1) => restoreOutcome(file, { ok: true, value: { success: true, steps: steps(s), note: 'N' } }).text;
    expect(t({ preRestoreDump: null, counts: { result: 'skipped', tables: 3, rows: 9 }, shardClaimsRaised: undefined, shardClaimsExpired: 2, botState: 'off', generation: 5 }, FILE2)).toBe(
      'Restore complete: no safety dump (the database was missing), 3 tables and 9 rows restored, not compared (an uploaded backup has no counts file), no claim number raised (none was used before), 2 restored shard claim(s) expired, the bot stays off, stopped 1, restarted 1. This machine is the main now (generation 5); the Database screen shows whether the owner was sent a switch notice. N');
    expect(t({ counts: { result: 'skipped', text: 'psql failed' }, shardClaimsRaised: undefined, shardClaimsExpired: undefined, generation: 6 })).toContain(
      ', not compared (an uploaded backup has no counts file), and the restored tables could not be counted (psql failed), 2 guild(s) raised to claim 9');
    expect(t({ generation: 6 })).toContain(". The database's main generation is 6 now, above the dump's and the one it had before the restore");
    expect(restoreSharersText({ ok: true, value: { success: true, instances: [{ id: 'b1', displayName: 'mybot', running: true }] } }, 'b1')).toBe('No other instance on this manager shares it');
    expect(restoreSharersText({ ok: true, value: { success: true, instances: [{ id: 'b3', displayName: 'x', running: null }] } }, 'b1')).toContain('x (docker did not answer)');
  });
});

describe('m4 dismiss the restore notice', () => {
  const noticeBot = () => mainBot({ fleetBackup: backupStatus({ restoreError: 'The restore of x.dump failed: pg_restore exited 1', restoreErrorAt: AT }) });
  const PATH = `${B}/fleet-backups/restore-error?at=${encodeURIComponent(AT)}`;

  it('asks what dismissing means; another key sends nothing; Y sends the shown time once', async () => {
    let answer: () => Reply = () => dismissed(true);
    const f = routes(fake(), noticeBot()).on('DELETE', PATH, () => answer());
    const v = await openDb(f);
    await v.until('The restore of x.dump failed: pg_restore exited 1. X dismisses the restore notice.');
    expect(bars(v.frame())).toContain('X Dismiss');
    await v.press('x');
    await v.until("Dismiss the restore notice? Running is refused until a restore succeeds or this notice is dismissed. Dismissing keeps the data the restore left in the database as the bot's data.");
    await v.press('n');
    await v.until('Cancelled: nothing was sent.');
    expect(sent(f, 'DELETE', PATH)).toEqual([]);
    const run = async (text: string) => {
      await v.press('x');
      await v.until('Y Dismiss');
      await v.press('y');
      await v.until(text);
    };
    await run('Restore notice dismissed.');
    answer = () => dismissed(false);
    await run('No restore notice stood, so nothing was dismissed.');
    answer = () => refused(409, { success: false, error: 'A restore of this bot is running; dismiss its notice when it ends' });
    await run('A restore of this bot is running; dismiss its notice when it ends');
    answer = () => refused(409, { success: false, error: 'A newer restore notice replaced the one shown, so it was kept; read it, then dismiss it again' });
    await run('A newer restore notice replaced the one shown, so it was kept; read it, then dismiss it again');
    answer = noAnswer;
    await run("No answer from the manager, so the dismiss can't be confirmed. Check whether it took effect before trying again.");
    expect(sent(f, 'DELETE', PATH)).toHaveLength(5);
  });

  it('offers no X without a notice', async () => {
    const v = await openDb(routes(fake()));
    expect(bars(v.frame())).not.toContain('X Dismiss');
    await v.press('x');
    expect(flat(v.frame())).not.toContain('Dismiss the restore notice?');
  });
});

describe('m4 decommission', () => {
  it('asks with the page\'s text; another key sends nothing; each answer is worded', async () => {
    let answer: () => Reply = () => ok({ success: false, error: STOP_FIRST });
    const f = routes(fake()).on('POST', `${B}/fleet-db/decommission`, () => answer());
    const v = await openDb(f);
    expect(bars(v.frame())).toContain('K Decommission');
    await v.press('k');
    await v.until('Decommission this database? The database container and its volume on this machine are DESTROYED.');
    await v.until('The instance must be stopped first.');
    await v.press('n');
    await v.until('Cancelled: nothing was sent.');
    expect(sent(f, 'POST', `${B}/fleet-db/decommission`)).toEqual([]);
    const run = async (text: string) => {
      await v.press('k');
      await v.until('Y Decommission');
      await v.press('y');
      await v.until(text);
    };
    await run(STOP_FIRST);
    answer = () => refused(409, { success: false, error: 'A data migration to Postgres is open on this bot, so its database setup cannot change until it ends; nothing was changed' });
    await run('A data migration to Postgres is open on this bot, so its database setup cannot change until it ends; nothing was changed');
    answer = () => decommissioned({ dumpFile: 'pre-decommission.dump', warning: 'The env pins could not be removed.' });
    await run('Database decommissioned; safety dump kept: pre-decommission.dump. The env pins could not be removed.');
    answer = () => decommissioned({ dumpFile: 'pre-decommission.dump' });
    await run('Database decommissioned; safety dump kept: pre-decommission.dump.');
    answer = () => decommissioned({});
    await run("Database decommissioned; no dump was taken (its volume no longer existed - an earlier attempt's dump, if any, is in the backups list).");
    answer = noAnswer;
    await run('No answer from the manager; the decommission may still be running. Check its state before trying again.');
    expect(sent(f, 'POST', `${B}/fleet-db/decommission`)).toHaveLength(6);
  });
});

describe('m4 bringing a dump in', () => {
  it('shows the copy-in rule once, with the host folder', async () => {
    const v = await openDb(routes(fake()));
    const text = flat(v.frame());
    expect(text.split('A dump from elsewhere').length - 1).toBe(1);
    expect(text).toContain('A dump from elsewhere: copy it into /srv/smdb/data/backups/b1/fleet-postgres on the host. It restores when its counts file <name>.dump.json is copied beside it, or when it is named moved-<anything>.dump, which restores it as a move: this machine becomes the bot\'s main.');
    expect(text).toContain('Copy it under a name that does not end in .dump (for example <name>.part) and rename it once the copy is complete');
    expect(text).toContain('older than 48 hours (hourly) or 30 days (daily) is deleted at the next trim.');
  });
});
