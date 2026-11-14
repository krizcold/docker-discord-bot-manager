import path from 'path';
import { describe, expect, it } from 'vitest';
import type { BackupFamilyStatus, Bot, Outcome } from '../../src/cli/tui/api';
import {
  backupAlertLines, backupStatusLines, connectionLineText, formatBackupSize, hasDatabaseScreen, hostDataRoot, hostPathLines, layoutOf, memoryLineText,
  replicationLines, seedBannerLines, seedPurposeText, stateLineText, switchLines, timeIn,
} from '../../src/cli/tui/dbtext';
import { family, HOUR, T0 } from './m4-fake';

const when = timeIn('UTC');
const fam = (over: Record<string, unknown> = {}) => family(over) as BackupFamilyStatus;
const texts = (lines: Array<{ text: string }>) => lines.map((l) => l.text);
const good = <T>(value: T): Outcome<T> => ({ ok: true, value });

describe('m4 dbtext: times, sizes and the layout rule', () => {
  it('writes times as YYYY-MM-DD HH:MM and the zone name', () => {
    expect(timeIn('UTC')(T0)).toBe('2026-11-14 10:00 UTC');
    expect(timeIn('Europe/Madrid')(T0)).toBe('2026-11-14 11:00 Europe/Madrid');
    expect(timeIn('America/New_York')(Date.UTC(2026, 10, 14, 3, 5))).toBe('2026-11-13 22:05 America/New_York');
    expect(timeIn('UTC')(NaN)).toBe('an unknown time');
  });

  it('formatBackupSize and seedPurposeText use the page\'s words', () => {
    expect([formatBackupSize(900), formatBackupSize(2048), formatBackupSize(5_400_000)]).toEqual(['900 B', '2.0 KB', '5.1 MB']);
    expect(seedPurposeText('reseed-standby', true, 'cleared')).toBe('Rebuilding the copy (it had been emptied by a Re-seed or rebuild that stopped)');
    expect(seedPurposeText('reseed-standby', true, undefined)).toBe('Rebuilding the copy');
    expect(seedPurposeText('reseed-standby', false, undefined)).toBe('Re-seeding the standby');
    expect(seedPurposeText('provision', false, undefined)).toBe('Provisioning the standby');
  });

  it('picks the layout and the D key as the page does', () => {
    const b = (over: Partial<Bot>): Bot => ({ id: 'b1', ...over });
    expect(layoutOf(b({}))).toBe('none');
    expect(layoutOf(b({ fleetDb: {} }))).toBe('main');
    expect(layoutOf(b({ fleetDbReplica: {} }))).toBe('copy');
    expect(layoutOf(b({ hasDbBackups: true }))).toBe('copy');
    expect(hasDatabaseScreen(b({}))).toBe(false);
    expect(hasDatabaseScreen(b({ fleetDb: {} }))).toBe(false);
    expect(hasDatabaseScreen(b({ appHooks: true }))).toBe(true);
    expect(hasDatabaseScreen(b({ fleetBackup: {} }))).toBe(true);
  });

  it('takes the host folder by hostBotDirFor\'s rule', () => {
    expect(hostDataRoot({ HOST_DATA_DIR: '/srv/data//', DATA_DIR: '/data/data' })).toBe('/srv/data');
    expect(hostDataRoot({ HOST_DATA_DIR: 'D:\\smdb\\data' })).toBe('D:/smdb/data');
    expect(hostDataRoot({ DATA_DIR: 'rel/data' })).toBe(path.resolve('rel/data').replace(/\\/g, '/'));
    expect(hostDataRoot({})).toBeNull();
    expect(hostPathLines('/srv/data', 'b1', 'x.dump', true)).toEqual([
      'Folder on the host: /srv/data/backups/b1/fleet-postgres', 'Dump: x.dump', 'Counts file: x.dump.json', 'Copy both files to keep the counts check.',
    ]);
    expect(hostPathLines(null, 'b1', 'x.dump', false)).toEqual([
      "In the manager's data folder: backups/b1/fleet-postgres", 'Dump: x.dump', 'Counts file: x.dump.json could not be read.',
    ]);
  });
});

describe('m4 dbtext: backup lines', () => {
  it('backupStatusHtml: off, scope, seed, paused, failing, last error, list error, copy and none yet', () => {
    expect(texts(backupStatusLines(fam({ enabled: false }), when))[0]).toBe('Backups are off for this bot: no backup is taken and none is deleted.');
    expect(backupStatusLines(fam({ skip: 'scope' }), when)).toEqual([]);
    expect(texts(backupStatusLines(fam({ skip: 'seed' }), when))).toEqual(['Backups of this copy start after its seed finishes.']);
    expect(texts(backupStatusLines(fam({ paused: true }), when))[0]).toBe(
      'The database container is not running, so no backup is taken; nothing can change in it while it is stopped. Newest backup: hourly-2026-11-14T09-00-00-000Z.dump.');
    const failing = backupStatusLines(fam({ failingSince: T0 - 4 * HOUR, lastError: 'pg_dump exited 1', alerts: { dumps: { text: 'x', since: T0, dm: 'failed', dmError: 'the bot is stopped' }, test: null } }), when);
    expect(texts(failing)).toContain('No backup has succeeded since 2026-11-14 06:00 UTC. Last error: pg_dump exited 1.');
    expect(texts(failing)).toContain('The message to the owner could not be sent: the bot is stopped. The manager tries again every hour.');
    expect(failing[0].error).toBe(true);
    expect(texts(backupStatusLines(fam({ lastError: 'disk full' }), when))[0]).toBe('The last backup attempt failed: disk full. The next attempt starts at the next hour.');
    expect(texts(backupStatusLines(fam({ listError: 'The backup folder could not be read' }), when))[0]).toBe('The backup folder could not be read.');
    expect(texts(backupStatusLines(fam({ family: 'copy', dataAt: null }), when))[0]).toBe(
      'Last backup of this copy: hourly-2026-11-14T09-00-00-000Z.dump at 2026-11-14 09:00 UTC, holding no replayed change yet.');
    expect(texts(backupStatusLines(fam({ lastFile: null, lastAt: null, test: null }), when))).toEqual([
      'No backup yet; the first one starts within a minute.', 'No test restore yet; the first runs after the daily backup at 04:00.',
    ]);
  });

  it('backupTestHtml: running, interrupted and failed', () => {
    const t = (test: Record<string, unknown>) => texts(backupStatusLines(fam({ lastFile: null, test: { file: 'd.dump', startedAt: T0, finishedAt: T0, ...test } }), when))[1];
    expect(t({ result: 'running' })).toBe('Test restore of d.dump running since 2026-11-14 10:00 UTC.');
    expect(t({ result: 'interrupted' })).toBe('Test restore of d.dump was cut short by a manager restart; it runs again within a minute.');
    expect(t({ result: 'failed', text: 'counts differ' })).toBe('Test restore of d.dump failed at 2026-11-14 10:00 UTC: counts differ.');
  });

  it('backupAlertHtml: every message outcome', () => {
    const a = (over: Record<string, unknown>) => texts(backupAlertLines({ text: 'x', since: T0, dmAt: T0, ...over }, when))[0];
    expect(a({ dm: 'sent', dmRepeat: true })).toBe('At 2026-11-14 10:00 UTC the bot answered that it had already posted this message, so it posted nothing new.');
    expect(a({ dm: 'sent', dmPlace: 'channel', dmNote: 'posted in #owner' })).toBe("The owner was sent a message in the owner messages channel at 2026-11-14 10:00 UTC. The bot's note: posted in #owner");
    expect(a({ dm: 'sent', dmPlace: 'dm' })).toBe('The owner was sent a DM at 2026-11-14 10:00 UTC.');
    expect(a({ dm: 'sent' })).toBe('The owner was sent a Discord message at 2026-11-14 10:00 UTC.');
    expect(a({ dm: 'pending' })).toBe('The message to the owner is being sent.');
    expect(a({ dm: 'unknown' })).toBe("The bot did not answer within 30 s, so the manager can't confirm the owner got the message.");
    expect(a({ dm: 'unknown', dmError: 'timeout' })).toBe("The manager can't confirm the owner got the message: timeout.");
    expect(a({ dm: 'unsupported' })).toBe('This app has no notify-owner hook, so this failure shows only here.');
  });
});

describe('m4 dbtext: the top lines, seed, replication and move', () => {
  it('state, memory and connection lines for each answer', () => {
    expect(stateLineText(null)).toBe('Reading the state.');
    expect(stateLineText({ ok: false, text: 'Bot not found' })).toBe('Bot not found');
    expect(memoryLineText(good({ memory: { running: true, room: null, error: 'docker reported no memory use' }, sent: { kind: 'no-hook' } }))).toBe(
      "Room to reshard beside the running shards: can't confirm: docker reported no memory use; this bot's build does not take the reading");
    expect(memoryLineText(good({ memory: { running: true, room: false, useMb: 900, freeMb: 100 }, sent: { kind: 'failed', unknown: true, error: 'timeout' } }))).toBe(
      "Room to reshard beside the running shards: no, 100 MB free for 900 MB; can't confirm the bot got it: timeout");
    expect(memoryLineText({ ok: false, text: '' })).toBe("Room to reshard beside the running shards: can't confirm: the manager refused the reading");
    expect(connectionLineText(good({ connections: { state: 'none' } }))).toBe('');
    expect(connectionLineText(good({ connections: { state: 'read', machines: 1, count: 10, allowed: 97 } }))).toBe('');
    expect(connectionLineText(good({ connections: { state: 'unread', error: 'psql failed' } }))).toBe(
      "Connections: can't confirm that this database accepts every connection the bot can open: psql failed");
  });

  it('the seed banner: parked, cancelling and the pins warning', () => {
    expect(texts(seedBannerLines(good({ replica: { pinsWarning: 'A compose still sets DATABASE_URL.', parkedSeed: { purpose: 'reseed-stale-primary', phase: 'restoring', lastError: 'pg_restore failed', safetyDump: 's.dump' } } })))).toEqual([
      'A compose still sets DATABASE_URL.', 'Re-seeding this database as a standby stopped during restoring: pg_restore failed',
      'A safety dump of this database, taken under a write fence, is kept with the backups as s.dump.',
    ]);
    expect(texts(seedBannerLines(good({ replica: { provisioning: { purpose: 'reseed-stale-primary', phase: 'seeding', forSeconds: 3, cancelRequested: true } } })))).toContain('Cancelling at the next step...');
    expect(seedBannerLines(good({ replica: { present: false } }))).toEqual([]);
  });

  it('replication: database states, reachability, every slot kind and the unfinished disable', () => {
    const r = (over: Record<string, unknown>, live: Record<string, unknown> | null = { sslOn: true, slotWalKeep: '4096MB', slots: [] }) =>
      texts(replicationLines(good({ replication: { enabled: true, publicHost: 'db.example.net', hostPort: 15432, ...(live ? { live } : {}), ...over } }), when));
    expect(r({}, { sslOn: false, slotWalKeep: '-1', slots: [] })[0]).toBe(
      'Replication endpoint db.example.net:15432 (TLS required off this machine) - ssl not active yet, restart the instance - WAL retention UNBOUNDED');
    expect(r({ probeError: 'psql: timeout' }, null)[0]).toBe('Replication endpoint db.example.net:15432 (TLS required off this machine) - could not read the database (psql: timeout)');
    expect(r({}, null)[0]).toBe('Replication endpoint db.example.net:15432 (TLS required off this machine) - database not running');
    expect(r({ disablingSince: '2026-11-14T09:00:00.000Z' })[1]).toContain('A Disable of replication started on 2026-11-14 09:00 UTC did not finish');
    expect(r({ reachability: { ok: false, unchecked: true, error: 'no password', ageSeconds: 0 } })).toContain('Endpoint not checked: no password');
    expect(r({ reachability: { ok: false, error: 'timeout', ageSeconds: 30 } })).toContain(
      'Endpoint NOT reachable from containers yet (restart pending, or blocked by a firewall / hairpin routing): timeout (checked 30s ago)');
    expect(r({})).toContain("No copy attached: this machine dying would take this bot's database with it. Paste the join code into another machine's manager to add one.");
    const slot = (s: Record<string, unknown>) => r({}, { sslOn: true, slotWalKeep: '1024MB', slots: [{ slot: 'smdb_copy_a', fleet: true, machine: null, clientAddr: '10.0.0.5', active: true, state: 'streaming', ...s }] })[1];
    expect(slot({ walStatus: 'lost' })).toContain('The copy on slot smdb_copy_a (10.0.0.5) was invalidated');
    expect(slot({ walStatus: 'unreserved' })).toContain('is past the WAL bound and about to be invalidated');
    expect(slot({ walStatus: 'reserved', active: false, retainedBytes: 3 * 1048576 })).toContain('is not connected: its copy, if it still exists, is falling behind, and the slot keeps 3 MB of WAL');
    expect(slot({ walStatus: 'reserved', state: 'catchup' })).toContain('is catchup, not streaming: the copy is going stale.');
    expect(slot({ walStatus: 'reserved', replayLagSeconds: 90, behindBytes: 5 * 1048576, retainedBytes: 600 * 1048576 })).toBe(
      'The copy on slot smdb_copy_a (10.0.0.5): streaming, 5 MB behind, replay lag 90.0s - a take-over by it now would lose that much - retains 600 MB of WAL (bound 1024 MB)');
    expect(r({}, { sslOn: true, slotWalKeep: '4096MB', slots: [{ slot: 'other_slot', fleet: false, walStatus: 'reserved', active: true }] })).toContain('Slot other_slot (not a fleet copy): reserved, active');
  });

  it('move: the generation line, its error, its absence under a switch record, and the copy layout', () => {
    const main: Bot = { id: 'b1', fleetDb: {} };
    expect(texts(switchLines(main, good({ lines: ['x'], generation: { error: 'docker did not answer' } })))).toEqual(["Can't confirm this database's generation: docker did not answer", 'x']);
    expect(texts(switchLines(main, good({ lines: [], generation: { machine: '', generation: 2, since: null } })))).toEqual(['This database is the main, generation 2.']);
    expect(texts(switchLines({ id: 'b1', fleetDb: { receive: { expiresAt: '2026-11-14T12:00:00.000Z' } } }, good({ lines: ['Waiting for a push.'], generation: { machine: 'a', generation: 1 } })))).toEqual(['Waiting for a push.']);
    expect(texts(switchLines({ id: 'b1' }, good({ lines: ['Take over is open.'], generation: { machine: 'a', generation: 1 } })))).toEqual(['Take over is open.']);
  });
});
