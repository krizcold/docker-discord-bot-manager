import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import * as ink from 'ink';
import { render } from 'ink-testing-library';
import { createApp } from '../../src/cli/tui/app';
import type { DatabaseOptions } from '../../src/cli/tui/database';
import { Session } from '../../src/cli/tui/session';
import { botList, fake, Fake, noAnswer, ok, Reply } from './m2-fake';
import { botRow } from './m3-fake';
import {
  backupsBody, backupStatus, connectionsBody, copyBot, entry, failed500, family, HOUR, hooksBot, mainBot, maintenanceBody, memoryBody, orphansBody,
  registryBroken, replicaBody, replicationOff, replicationOn, switchBody, T0,
} from './m4-fake';

const App = createApp(ink);
vi.setConfig({ testTimeout: 20_000 });
const ESC = '\u001B';
const ENTER = '\r';
const DOWN = '\u001B[B';

// Waits end by wall time, not by a count of ticks: a loaded machine paints later (fix 1c).
const WAIT_MS = 10_000;
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const flat = (frame: string) => frame.split('\n').map((l) => l.replace(/^\| /, '').replace(/\s*\|$/, '').trim()).join(' ').replace(/\s+/g, ' ');
const keyBar = (frame: string) => frame.split('\n').at(-2) ?? '';

const B = '/api/bots/b1';
const ROOT = '/srv/smdb/data';
const FILE1 = 'hourly-2026-11-14T09-00-00-000Z.dump';
const FILE2 = 'daily-2026-11-14T04-00-00-000Z.dump';
const never = () => new Promise<Reply>(() => undefined);

function mainRoutes(f: Fake, bot = mainBot()): Fake {
  return f
    .on('GET', '/api/bots', botList([bot]))
    .on('GET', '/api/bots/fleet/orphan-backups', orphansBody())
    .on('GET', `${B}/maintenance`, maintenanceBody())
    .on('GET', `${B}/memory`, memoryBody())
    .on('GET', `${B}/fleet-connections`, connectionsBody())
    .on('GET', `${B}/fleet-replica`, replicaBody())
    .on('GET', `${B}/fleet-backups`, backupsBody([entry(FILE1), entry(FILE2, { mtime: T0 - 6 * HOUR, size: 900, tables: null, rows: null })]))
    .on('GET', `${B}/fleet-replication`, replicationOn())
    .on('GET', `${B}/fleet-switch`, switchBody());
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
    o.session.held.database?.close();
  }
});

async function start(f: Fake, opts: StartOpts = {}) {
  const session = new Session(f.client, () => T0);
  await session.refresh();
  const view = render(createElement(App, {
    machine: 'box1', session, onHandOff: vi.fn(), now: () => T0,
    databaseOptions: { everyMs: 60_000, limitMs: 2000, env: { HOST_DATA_DIR: ROOT }, timeZone: 'UTC', ...opts.db },
  }));
  const stdout = view.stdout as unknown as { rows: number };
  stdout.rows = opts.rows ?? 80;
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
  const gone = async (text: string) => {
    for (const end = Date.now() + WAIT_MS; Date.now() < end && flat(frame()).includes(text);) await tick(20);
    expect(flat(frame())).not.toContain(text);
  };
  return { ...view, session, frame, press, until, gone };
}

async function openDb(f: Fake, opts: StartOpts = {}) {
  const v = await start(f, opts);
  await v.press(ENTER);
  await v.until('Name mybot');
  await pressD(v);
  return v;
}

// A key sent between a render and Ink's new input handler reaches the old screen's handler; D is sent again until the
// screen opens (on the bot screen D only opens it).
async function pressD(v: Awaited<ReturnType<typeof start>>) {
  for (const end = Date.now() + WAIT_MS; Date.now() < end && !flat(v.frame()).includes('Database: mybot');) {
    await v.press('d');
    await tick(50);
  }
  await v.until('Database: mybot');
}

const gets = (f: Fake) => f.paths().filter((p) => p.startsWith(`GET ${B}/`)).map((p) => p.slice(`GET ${B}/`.length));

describe('m4 the D key on the bot screen', () => {
  it('is offered by databaseButtonHtml\'s rule and opens nothing on a bot without it', async () => {
    const plain = fake().on('GET', '/api/bots', botList([botRow()])).on('GET', '/api/bots/fleet/orphan-backups', orphansBody());
    const v = await start(plain);
    await v.press(ENTER);
    await v.until('Name mybot');
    expect(keyBar(v.frame())).not.toContain('D Database');
    await v.press('d');
    await tick(100);
    expect(flat(v.frame())).not.toContain('Database: mybot');
    expect(gets(plain)).toEqual([]);

    for (const bot of [mainBot(), copyBot(), hooksBot(), botRow({ hasDbBackups: true }), botRow({ fleetWorker: true }), botRow({ fleetDbReplicaSeed: { phase: 'seeding' } })]) {
      const f = mainRoutes(fake(), bot);
      const w = await start(f);
      await w.press(ENTER);
      await w.until('Name mybot');
      expect(w.frame().split('\n').slice(-3).join(' ')).toContain('D Database');
      w.unmount();
    }
  });

  it('Esc goes back to the bot screen and the reads stop; Q quits', async () => {
    const f = mainRoutes(fake());
    const v = await openDb(f, { db: { everyMs: 100 } });
    await v.until('State: Running.');
    await v.press(ESC);
    await v.until('Name mybot');
    await tick(150);
    const count = gets(f).length;
    await tick(400);
    expect(gets(f).length).toBe(count);
    await pressD(v);
    await v.press('q');
    await tick(100);
    const after = gets(f).length;
    await tick(400);
    expect(gets(f).length).toBe(after);
  });
});

describe('m4 the three layouts', () => {
  it('no database: the state, memory and place lines from two reads', async () => {
    const f = mainRoutes(fake(), hooksBot());
    const v = await openDb(f);
    await v.until('State: Running.');
    await v.until('Room to reshard beside the running shards: yes, 2048 MB free for 300 MB');
    await v.until('This bot keeps its data in JSON files.');
    expect(new Set(gets(f))).toEqual(new Set(['maintenance', 'memory']));
    expect(keyBar(v.frame())).toContain('Esc Back');
    expect(keyBar(v.frame())).not.toContain('Up/Down');

    for (const [place, text] of [['outside', 'This bot keeps its data in a database this manager does not run.'], [null, "Can't confirm where this bot keeps its data: its env store cannot be read."]] as const) {
      const w = await openDb(mainRoutes(fake(), hooksBot({ dataPlace: place })));
      await w.until(text);
      w.unmount();
    }
  });

  it('main: state, memory, connections, seed, backup status, schedule, rows with the host path, replication and move', async () => {
    const f = mainRoutes(fake(), mainBot())
      .on('GET', `${B}/fleet-connections`, connectionsBody({ state: 'read', machines: 2, count: 120, overlap: true, max: 100, reserved: 3, allowed: 97 }))
      .on('GET', `${B}/fleet-replica`, replicaBody({ present: false, provisioning: { startedAt: T0, phase: 'seeding', purpose: 'reseed-stale-primary', auto: false, forSeconds: 42, cancelable: true, cancelRequested: false, committed: false, safetyDump: 'pre-reseed.dump' } }));
    const v = await openDb(f);
    await v.until('State: Running.');
    await v.until("Connections: this bot's 2 machines seen in the last 7 days can open up to 120 connections to this database at once (during a reshard beside the running shards), more than the 97 it accepts (max_connections 100, less 3 that Postgres reserves");
    await v.until('Re-seeding this database as a standby: seeding (42s). Seeding copies the whole database; large fleets take a while.');
    await v.until('A safety dump of this database, taken under a write fence, is kept with the backups as pre-reseed.dump.');
    await v.until(`Last backup: ${FILE1} at 2026-11-14 09:00 UTC. Hourly backups are kept for 48 hours and daily ones for 30 days; the daily backup and its test restore run at 04:00.`);
    await v.until(`Test restore of ${FILE2} passed at 2026-11-14 04:01 UTC: 12 tables and 3400 rows matched the counts recorded when it was taken.`);
    await v.until('[x] Backups Daily backup and test restore at 04:00');
    await v.until('File Size Time (UTC)');
    await v.until(`> ${FILE1} 5.1 MB 2026-11-14 09:00`);
    await v.until(`${FILE2} 900 B 2026-11-14 04:00`);
    await v.until(`Folder on the host: ${ROOT}/backups/b1/fleet-postgres Dump: ${FILE1} Counts file: ${FILE1}.json Copy both files to keep the counts check.`);
    await v.until('Replication Replication endpoint db.example.net:15432 (TLS required off this machine) - WAL bound 4096MB');
    await v.until('Endpoint reachable from containers (checked 12s ago)');
    await v.until('The copy on yundera (slot smdb_copy_a): streaming, caught up, replay lag 0.4s');
    await v.until('Move This database is the main: contabo, generation 3 since 2026-11-01 12:30 UTC.');
    expect(new Set(gets(f))).toEqual(new Set(['maintenance', 'memory', 'fleet-connections', 'fleet-replica', 'fleet-backups', 'fleet-replication', 'fleet-switch']));
    expect(keyBar(v.frame())).toContain('Up/Down Backup');
    expect(flat(v.frame())).not.toMatch(/Cancel|X Dismiss|Enable|Disable replication|Join code|Hand over/);
  });

  it('Down moves the host path to the next row; a dump without a counts file says so', async () => {
    const v = await openDb(mainRoutes(fake()));
    await v.until(`Dump: ${FILE1}`);
    await v.press(DOWN);
    await v.until(`Dump: ${FILE2} Counts file: ${FILE2}.json could not be read.`);
    expect(flat(v.frame())).not.toContain(`Dump: ${FILE1}`);
    await v.press(DOWN);
    await v.until(`> ${FILE2}`);
    await v.press('\u001B[A');
    await v.until(`> ${FILE1}`);
  });

  it('main: the empty texts, the restore notice, backups off and replication off', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{}, 'No backup yet; the first one starts within a minute.'],
      [{ enabled: false, main: family({ enabled: false }) }, '[ ] Backups'],
      [{ scoped: false }, 'No backups. Scheduled dumps are skipped: the stored database URL does not point at the database this manager provisioned.'],
      [{ scoped: null }, 'No backups. Scheduled dumps are paused: the stored database URL could not be read, so its scope cannot be checked.'],
    ];
    for (const [over, text] of cases) {
      const f = mainRoutes(fake(), mainBot({ fleetBackup: backupStatus(over) })).on('GET', `${B}/fleet-backups`, backupsBody([])).on('GET', `${B}/fleet-replication`, replicationOff());
      const v = await openDb(f);
      await v.until(text);
      await v.until('A copy of this database on another machine. Without one, this machine dying takes the database with it');
      v.unmount();
    }
    const off = await openDb(mainRoutes(fake(), mainBot({ fleetBackup: backupStatus({ enabled: false, main: family({ enabled: false }) }) })).on('GET', `${B}/fleet-backups`, backupsBody([])));
    await off.until('Backups are off for this bot: no backup is taken and none is deleted.');
    const notice = await openDb(mainRoutes(fake(), mainBot({ fleetBackup: backupStatus({ restoreError: 'The restore of x.dump failed: pg_restore exited 1', restoreErrorAt: '2026-11-14T09:30:00.000Z' }) })));
    await notice.until('The restore of x.dump failed: pg_restore exited 1.');
  });

  it('copy: the copy lines, its backup lines, the move lines and the earlier backups with the host path', async () => {
    const f = fake()
      .on('GET', '/api/bots', botList([copyBot()]))
      .on('GET', '/api/bots/fleet/orphan-backups', orphansBody())
      .on('GET', `${B}/maintenance`, maintenanceBody())
      .on('GET', `${B}/memory`, memoryBody({ running: false }))
      .on('GET', `${B}/fleet-replica`, replicaBody(
        { present: true, record: { containerName: 'smdb-replica-b1', publicHost: 'copy.example.net', hostPort: 15433, primaryHost: 'db.example.net', primaryPort: 15432 }, live: { running: true, inRecovery: true, receiverStatus: 'streaming', caughtUp: false, replayLagSeconds: 75.2 } },
        {
          copyBackup: family({ family: 'copy', lastFile: 'copy-hourly-2026-11-14T09-00-00-000Z.dump', dataAt: T0 - HOUR - 60_000 }),
          join: { host: 'db.example.net', port: 15432, machine: 'contabo', joinedAt: T0, addressCount: 1, addressesReadAt: null, addressesError: null, codeUnreadable: false },
          rebuild: { kind: null, text: null, heldAt: null, alerts: {}, rebuilt: null },
        },
      ))
      .on('GET', `${B}/fleet-switch`, switchBody({ lines: ['A move is recorded: a push to contabo, not finished.'], generation: undefined }))
      .on('GET', `${B}/fleet-backups`, backupsBody([entry('copy-hourly-2026-11-14T09-00-00-000Z.dump', { family: 'copy' })]));
    const v = await openDb(f);
    await v.until('Room to reshard beside the running shards: the bot is not running');
    await v.until('Follows db.example.net:15432; this copy serves at copy.example.net:15433 once you promote it.');
    await v.until('Joined the main at db.example.net:15432 (contabo).');
    await v.until('This copy follows the main and never takes over by itself.');
    await v.until('Receiver: streaming, replay lag 75.2s - a take-over now would lose that much');
    await v.until('Last backup of this copy: copy-hourly-2026-11-14T09-00-00-000Z.dump at 2026-11-14 09:00 UTC, holding changes up to 2026-11-14 08:59 UTC.');
    await v.until('The bot on this instance learns its copy when its container is next recreated: Apply on the card (in place) or Restart.');
    await v.until('Move A move is recorded: a push to contabo, not finished.');
    await v.until('Earlier database backups Backups kept on this machine: dumps of the live copy (copy-) and dumps taken while this machine held the main database.');
    await v.until(`Folder on the host: ${ROOT}/backups/b1/fleet-postgres Dump: copy-hourly-2026-11-14T09-00-00-000Z.dump`);
    expect(new Set(gets(f))).toEqual(new Set(['maintenance', 'memory', 'fleet-replica', 'fleet-switch', 'fleet-backups']));
    expect(flat(v.frame())).not.toMatch(/Remove replica|Re-seed now|Take over|Join code from/);
  });

  it('copy: a seed running, a parked seed, a copy with no record, a promoted copy', async () => {
    const run = async (replica: Record<string, unknown>, over: Record<string, unknown>, texts: string[]) => {
      const f = fake()
        .on('GET', '/api/bots', botList([copyBot()]))
        .on('GET', '/api/bots/fleet/orphan-backups', orphansBody())
        .on('GET', `${B}/maintenance`, maintenanceBody())
        .on('GET', `${B}/memory`, memoryBody())
        .on('GET', `${B}/fleet-replica`, replicaBody(replica, over))
        .on('GET', `${B}/fleet-switch`, switchBody({ generation: undefined }))
        .on('GET', `${B}/fleet-backups`, backupsBody([]));
      const v = await openDb(f);
      for (const t of texts) await v.until(t);
      expect(flat(v.frame())).not.toContain('Earlier database backups');
      v.unmount();
    };
    await run({ present: true, provisioning: { phase: 'restoring', purpose: 'reseed-standby', auto: true, cause: 'slot', forSeconds: 9, cancelable: false, cancelRequested: false } }, {},
      ['Rebuilding the copy (the main no longer kept its place): restoring (9s).', 'Past the point of cancelling: the copy is complete and its database is starting.']);
    await run({ present: false, lastError: 'pg_basebackup failed', parkedSeed: { phase: 'seeding', purpose: 'provision', auto: false, lastError: 'pg_basebackup failed' } }, { rebuild: { alerts: { stopped: { outcome: 'The owner was sent a DM.' } } } },
      ['Provisioning the standby stopped during seeding: pg_basebackup failed', 'The owner was sent a DM.']);
    await run({ present: false }, { join: { host: 'db.example.net', port: 15432, machine: 'contabo', codeUnreadable: true, addressesError: 'The address list could not be read.' } },
      ['Joined the main at db.example.net:15432 (contabo).', 'The stored join code no longer decrypts', 'The address list could not be read.']);
    await run({ present: true, record: { primaryHost: 'db.example.net', primaryPort: 15432 }, live: { running: true, inRecovery: false } }, {},
      ['This copy has been PROMOTED outside the manager and no longer follows a main.']);
  });
});

describe('m4 reads: refusal, no answer and the time limit', () => {
  // The page's text for each panel, refused with the route's error and unanswered.
  const PANELS: Array<{ route: string; refused: string; unanswered: string; good: string }> = [
    { route: 'maintenance', refused: 'Bot not found', unanswered: "No answer from the manager, so the bot's state can't be shown", good: 'State: Running.' },
    { route: 'memory', refused: "Room to reshard beside the running shards: can't confirm: Bot not found", unanswered: "Room to reshard beside the running shards: can't confirm: no answer from the manager", good: 'yes, 2048 MB free for 300 MB' },
    { route: 'fleet-connections', refused: "Connections: can't confirm that this database accepts every connection the bot can open: Bot not found", unanswered: "Connections: can't confirm that this database accepts every connection the bot can open: no answer from the manager", good: 'Database: mybot' },
    { route: 'fleet-replica', refused: 'Could not read the seed state (Bot not found); retrying.', unanswered: 'Could not read the seed state (no answer:', good: 'Database: mybot' },
    { route: 'fleet-backups', refused: 'Could not list the backups: Bot not found; retrying.', unanswered: 'Could not list the backups: the manager could not be reached (', good: `> ${FILE1}` },
    { route: 'fleet-replication', refused: 'Failed to load replication status (Bot not found); retrying.', unanswered: 'Failed to load replication status (no answer:', good: 'Replication endpoint db.example.net:15432' },
    { route: 'fleet-switch', refused: 'Could not read the move state (Bot not found); retrying.', unanswered: 'No answer from the manager (', good: 'This database is the main: contabo' },
  ];

  for (const p of PANELS) {
    it(`${p.route}: refused, unanswered, past the limit, then answered`, async () => {
      const good = mainRoutes(fake()).routes.get(`GET ${B}/${p.route}`)!;
      let answer: 'refuse' | 'none' | 'late' | 'good' = 'refuse';
      const f = mainRoutes(fake()).on('GET', `${B}/${p.route}`, (body) => {
        if (answer === 'refuse') return refusedNotFound();
        if (answer === 'none') return noAnswer();
        if (answer === 'late') return never();
        return good(body);
      });
      const v = await openDb(f, { db: { everyMs: 300, limitMs: 200 } });
      await v.until(p.refused);
      expect(flat(v.frame())).toContain('Database: mybot');
      answer = 'none';
      await v.until(p.unanswered);
      await v.until('ECONNREFUSED');
      answer = 'late';
      await v.until('did not answer within 200 ms');
      answer = 'good';
      await v.until(p.good);
      await v.gone('did not answer within 200 ms');
      await v.gone(p.refused);
    });
  }

  it('a read that fails after a good one shows the retrying text, never the old values', async () => {
    let fail = false;
    const f = mainRoutes(fake()).on('GET', `${B}/fleet-replication`, () => (fail ? failed500('psql: could not connect') : replicationOn()));
    const v = await openDb(f, { db: { everyMs: 150 } });
    await v.until('The copy on yundera (slot smdb_copy_a): streaming');
    fail = true;
    await v.until('Failed to load replication status (psql: could not connect); retrying.');
    expect(flat(v.frame())).not.toContain('The copy on yundera');
    expect(flat(v.frame())).not.toContain('Replication endpoint');
  });

  it('a copy layout read refused and unanswered', async () => {
    const f = fake()
      .on('GET', '/api/bots', botList([copyBot()]))
      .on('GET', '/api/bots/fleet/orphan-backups', orphansBody())
      .on('GET', `${B}/maintenance`, maintenanceBody())
      .on('GET', `${B}/memory`, memoryBody())
      .on('GET', `${B}/fleet-replica`, failed500('docker did not answer'))
      .on('GET', `${B}/fleet-switch`, switchBody({ generation: undefined }))
      .on('GET', `${B}/fleet-backups`, noAnswer());
    const v = await openDb(f);
    await v.until("Failed to load the copy's status (docker did not answer); retrying.");
    await v.until('Could not list the earlier database backups: the manager could not be reached (connect ECONNREFUSED 127.0.0.1:8080); retrying.');
  });

  // Fix 1 (C1): a read of a panel is not sent while one is in flight, so answers land in the order they were asked for.
  it('sends no second read of a panel while one is in flight, and paints each answer in order', async () => {
    let n = 0;
    const held: Array<(r: Reply) => void> = [];
    const f = mainRoutes(fake()).on('GET', `${B}/fleet-replication`, () => {
      n += 1;
      if (n <= 2) return new Promise<Reply>((r) => held.push(r));
      return replicationOn({ publicHost: 'new.example.net' });
    });
    const waitFor = async (check: () => boolean) => {
      for (const end = Date.now() + WAIT_MS; Date.now() < end && !check();) await tick(20);
      expect(check()).toBe(true);
    };
    const v = await openDb(f, { db: { everyMs: 100 } });
    await tick(500);
    expect(n).toBe(1);
    held[0](replicationOn({ publicHost: 'old.example.net' }));
    await v.until('Replication endpoint old.example.net:15432');
    await waitFor(() => n === 2);
    await tick(300);
    expect(n).toBe(2);
    expect(flat(v.frame())).toContain('Replication endpoint old.example.net:15432');
    held[1](replicationOn({ publicHost: 'new.example.net' }));
    await v.until('Replication endpoint new.example.net:15432');
    const seen = v.frames.length;
    await waitFor(() => n > 3);
    await tick(300);
    expect(v.frames.slice(seen).map(flat).join(' ')).not.toContain('old.example.net');
  });

  it('the bot list read failing says when the bot records were read', async () => {
    let down = false;
    const f = mainRoutes(fake()).on('GET', '/api/bots', () => (down ? noAnswer() : botList([mainBot()])));
    const v = await openDb(f);
    down = true;
    await v.session.refresh();
    await v.until("can't read the bot list: connect ECONNREFUSED 127.0.0.1:8080. The bot's records below were read at");
  });
});

function refusedNotFound(): Reply {
  return { status: 404, ok: false, body: { success: false, error: 'Bot not found' } };
}

describe('m4 the host path', () => {
  it('without HOST_DATA_DIR uses the resolved DATA_DIR, and with neither names the manager\'s data folder', async () => {
    const v = await openDb(mainRoutes(fake()), { db: { env: { DATA_DIR: '/data/data/' } } });
    await v.until(`Folder on the host: ${path.resolve('/data/data').replace(/\\/g, '/')}/backups/b1/fleet-postgres`);
    v.unmount();
    const w = await openDb(mainRoutes(fake()), { db: { env: {} } });
    await w.until(`In the manager's data folder: backups/b1/fleet-postgres Dump: ${FILE1}`);
    w.unmount();
    const x = await openDb(mainRoutes(fake()), { db: { env: { HOST_DATA_DIR: 'C:\\smdb\\data\\', DATA_DIR: '/data/data' } } });
    await x.until('Folder on the host: C:/smdb/data/backups/b1/fleet-postgres');
  });
});

describe('m4 orphan lines under the bot list', () => {
  it('names each removed bot\'s folder on the host and its dump count', async () => {
    const folders = [{ id: 'gone1', dumps: 2, folder: 'backups/gone1/fleet-postgres' }, { id: 'gone2', dumps: 1, folder: 'backups/gone2/fleet-postgres' }, { id: 'gone3', dumps: null, folder: 'backups/gone3/fleet-postgres' }];
    const v = await start(mainRoutes(fake()).on('GET', '/api/bots/fleet/orphan-backups', orphansBody(folders)));
    await v.until("Database dumps of removed instances are kept in the manager's data folder:");
    await v.until(`${ROOT}/backups/gone1/fleet-postgres: 2 dumps`);
    await v.until(`${ROOT}/backups/gone2/fleet-postgres: 1 dump`);
    await v.until(`${ROOT}/backups/gone3/fleet-postgres: the folder could not be read`);
    v.unmount();
    const w = await start(mainRoutes(fake()).on('GET', '/api/bots/fleet/orphan-backups', orphansBody(folders)), { db: { env: {} } });
    await w.until('backups/gone1/fleet-postgres: 2 dumps');
    expect(flat(w.frame())).not.toContain(ROOT);
  });

  it('none, a broken registry, and no answer', async () => {
    const none = await start(mainRoutes(fake()));
    await tick(100);
    expect(flat(none.frame())).not.toContain('removed instances');
    none.unmount();
    const broken = await start(mainRoutes(fake()).on('GET', '/api/bots/fleet/orphan-backups', registryBroken()));
    await broken.until('The manager could not list database dumps of removed instances: instances.json cannot be read');
    broken.unmount();
    const lost = await start(mainRoutes(fake()).on('GET', '/api/bots/fleet/orphan-backups', noAnswer()));
    await lost.until('The manager could not list database dumps of removed instances: no answer (connect ECONNREFUSED 127.0.0.1:8080)');
  });
});

describe('m4 badge lines on the bot screen', () => {
  it('shows each badge and its title under it, times in the dbm zone and switch times in UTC', async () => {
    const bot = mainBot({
      fleetBackup: backupStatus({
        restoreError: 'The restore failed', main: family({ alerts: { dumps: { kind: 'dumps', text: 'No backup for 3 hours.', since: T0, dm: 'pending' }, test: { kind: 'test', text: 'The test restore failed.', since: T0, dm: 'pending' } } }),
      }),
      fenceStuck: 'The fence on smdb-db-b1 could not be lifted.',
      maintenance: { state: 'off', message: '', settled: true, orderedAt: '2026-11-14T08:00:00.000Z' },
      maintenanceDrift: 'The state is Off, but the bot is running.',
      migrate: { to: 'postgres', phase: 'waiting', text: 'The migration waits for you.' },
      fleetDb: { containerName: 'smdb-db-b1', replacedBy: { machine: 'yundera', generation: 4 }, pushBroken: { at: '2026-11-13T22:15:00.000Z', safetyDump: 'pre-push.dump' } },
    });
    const v = await start(mainRoutes(fake(), bot), { db: { timeZone: 'Europe/Madrid' } });
    await v.press(ENTER);
    await v.until('Name mybot');
    for (const t of [
      'DB backup failed No backup for 3 hours.', 'DB test restore failed The test restore failed.', '! DB restore failed The restore failed',
      '! Database fenced The fence on smdb-db-b1 could not be lifted.', '! Replaced by yundera yundera replaced this database as the main (generation 4). Rejoin this machine as a copy.',
      '! Push not finished A push replaced this database on or before 2026-11-13 22:15 UTC and did not finish',
      'Off Off since 2026-11-14 09:00 Europe/Madrid. Choose Running in State to start it.',
      '! Off, but running The state is Off, but the bot is running.', '! Migration waiting The migration waits for you.',
    ]) await v.until(t);
  });

  it('a bot with no badge shows none, and a maintenance order in flight shows no state badge', async () => {
    const v = await start(mainRoutes(fake(), mainBot({ activeOp: 'maintenance', maintenance: { state: 'maintenance', settled: false, lastError: 'x' } })));
    await v.press(ENTER);
    await v.until('Name mybot');
    expect(flat(v.frame())).not.toContain('not confirmed');
    v.unmount();
    const w = await start(mainRoutes(fake(), mainBot({ maintenance: { state: 'maintenance', settled: false, lastError: 'The hook did not answer.', orderedAt: '2026-11-14T08:00:00.000Z' } })));
    await w.press(ENTER);
    await w.until('! Maintenance not confirmed The hook did not answer.');
  });
});

describe('m4 the layout at 80 and 100 columns', () => {
  for (const columns of [80, 100]) {
    it(`keeps every line inside ${columns} columns on the main and copy layouts`, async () => {
      const longId = mainBot({ id: '0f8fad5b-d9cb-469f-a165-70867728950e' });
      const id = '/api/bots/0f8fad5b-d9cb-469f-a165-70867728950e';
      const f = fake()
        .on('GET', '/api/bots', botList([longId]))
        .on('GET', '/api/bots/fleet/orphan-backups', orphansBody())
        .on('GET', `${id}/maintenance`, maintenanceBody("State: Maintenance. The bot's database login is blocked and none of its sessions is open."))
        .on('GET', `${id}/memory`, memoryBody())
        .on('GET', `${id}/fleet-connections`, connectionsBody({ state: 'unread', error: 'psql: the database answered in a form the manager does not read' }))
        .on('GET', `${id}/fleet-replica`, replicaBody())
        .on('GET', `${id}/fleet-backups`, backupsBody([entry(FILE1), entry('safety-before-restore-2026-11-14T09-30-00-000Z.dump')]))
        .on('GET', `${id}/fleet-replication`, replicationOn())
        .on('GET', `${id}/fleet-switch`, switchBody());
      const v = await start(f, { columns, rows: 30, db: { env: { HOST_DATA_DIR: '/var/lib/casaos/AppData/discordbotmanager/data' } } });
      await v.press(ENTER);
      await v.until('Name mybot');
      await pressD(v);
      await v.until('Folder on the host:');
      const lines = v.frame().split('\n');
      expect(lines.length).toBe(29);
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(columns - 1);
      expect(flat(v.frame())).toContain('/var/lib/casaos/AppData/discordbotmanager/data/');
      expect(flat(v.frame())).toContain('0f8fad5b-d9cb-469f-a165-70867728950e/');
      expect(keyBar(v.frame())).toContain('Esc Back');
      expect(v.frame().split('\n').slice(-4, -1).join(' ')).toContain('PgUp/PgDn Scroll');
      await v.press('\u001B[6~');
      await v.until('Replication');
      for (const l of v.frame().split('\n')) expect(l.length).toBeLessThanOrEqual(columns - 1);
    });
  }

  it('wraps the copy layout inside 80 columns', async () => {
    const f = fake()
      .on('GET', '/api/bots', botList([copyBot()]))
      .on('GET', '/api/bots/fleet/orphan-backups', orphansBody())
      .on('GET', `${B}/maintenance`, maintenanceBody())
      .on('GET', `${B}/memory`, memoryBody())
      .on('GET', `${B}/fleet-replica`, replicaBody({ present: true, record: { primaryHost: 'db.example.net', primaryPort: 15432 }, live: { running: false } }))
      .on('GET', `${B}/fleet-switch`, switchBody({ lines: ['Handed over to contabo on 2026-11-14 09:00 UTC. This machine rejoins as its copy once contabo is the main; last check: not checked yet.'] }))
      .on('GET', `${B}/fleet-backups`, backupsBody([]));
    const v = await openDb(f, { columns: 80, rows: 40 });
    await v.until("The copy's database container is not running: it is receiving nothing and falls further behind every minute.");
    await v.until('Handed over to contabo on 2026-11-14 09:00 UTC.');
    for (const l of v.frame().split('\n')) expect(l.length).toBeLessThanOrEqual(79);
  });
});
