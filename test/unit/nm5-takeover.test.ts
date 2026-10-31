import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-takeover-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

vi.mock('child_process', async (o) => (await import('./switch-harness')).childProcessMock(await o()));
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./switch-harness')).dbLoginMock(await o()));
vi.mock('../../src/instance/maintenance', async (o) => (await import('./switch-harness')).maintenanceMock(await o()));
vi.mock('../../src/docker/containerManager', async (o) => (await import('./switch-harness')).containerManagerMock(await o()));
vi.mock('../../src/instance/fleetBackup', async (o) => (await import('./switch-harness')).fleetBackupMock(await o()));
vi.mock('../../src/instance/fleetJoin', async (o) => (await import('./switch-harness')).fleetJoinMock(await o()));
vi.mock('../../src/instance/fleetReplica', async (o) => (await import('./switch-harness')).fleetReplicaMock(await o()));
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./switch-harness')).appHookMock(await o()));
vi.mock('../../src/instance/backupCheck', async (o) => (await import('./switch-harness')).backupCheckMock(await o()));
vi.mock('../../src/env/manager', async (o) => (await import('./switch-harness')).envMock(await o()));
vi.mock('../../src/config/appCapabilities', async (o) => (await import('./switch-harness')).capsMock(await o()));

import * as fs from 'fs';
import * as path from 'path';

import { SWITCH_TIMING, takeOverMain } from '../../src/instance/fleetSwitch';
import * as fleetReplica from '../../src/instance/fleetReplica';
import * as containerManager from '../../src/docker/containerManager';
import { COPY_PEM, copyFixture, fake, freshDb, h, resetHarness, stored, writeRegistry } from './switch-harness';
import type { FakeDb } from './switch-fake';
import { fakeJoinRecord } from './join-fake';

const NOTHING = '; nothing was changed';
const peer = (kind: string, gen = 0, sys = '7001') => () => (kind === 'writable' || kind === 'in-recovery'
  ? { kind, systemId: sys, timeline: 2, gen: gen ? { generation: gen, machine: 'main.invalid', since: null } : null }
  : kind === 'fenced' ? { kind, systemId: sys, reason: 'FATAL:  pg_hba.conf rejects connection for host "1.2.3.4"' }
  : { kind, reason: 'connection refused' }) as any;

beforeEach(() => {
  resetHarness();
  fake.dbs['c-pg'] = freshDb({ recovery: true, generation: { generation: 3, machine: 'main.invalid', since: '2026-10-28T10:00:00Z' }, handover: { slot: 'slot_c', machine: 'copy.example', generation: 4 }, addresses: [
    { host: 'main.invalid', port: 15432, slot: null, machine: 'main.invalid', cert: COPY_PEM },
    { host: 'copy.example', port: 5434, slot: 'slot_c', machine: 'copy.example', cert: COPY_PEM },
    { host: 'third.example', port: 5435, slot: 'slot_t', machine: 'third.example', cert: COPY_PEM },
  ], copies: [{ slot: 'slot_c', machine: 'copy.example', client: '10.0.0.2' }, { slot: 'slot_t', machine: 'third.example', client: '10.0.0.3' }] });
  writeRegistry({ c: copyFixture() });
  SWITCH_TIMING.replayWaitMs = 50;
  SWITCH_TIMING.pollMs = 5;
});
afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

const U_FOLLOW = " This manager checks the old main every 5 minutes; if it runs again as a main, this manager adds this machine to its copy list, and the old main's manager then blocks its bot's login there and puts the bot in Off once it holds nothing it could not save. Rebuild it as a copy with Rejoin as a copy in its manager, which keeps a dump of it first.";
const P_LEAD = /^This machine is the main now \(generation 4, \d{4}-\d\d-\d\d \d\d:\d\d UTC\): the copy held every change of the old main and was promoted\./;

describe('O3 Take over', () => {
  it('T1: planned: promoted, raised, adopted, Running, the notice with its exact body (contract 5 stand-in)', async () => {
    const r = await takeOverMain('c');
    expect(r.success).toBe(true);
    expect(r.text).toMatch(P_LEAD);
    expect(r.text).toContain(" The copies on third.example followed the old main: on each of those machines, Join with this machine's join code, then Re-seed the copy.");
    expect(fake.dbs['c-pg'].recovery).toBe(false);
    expect(fake.dbs['c-pg'].generation).toMatchObject({ generation: 4, machine: 'copy.example' });
    expect(fake.dbs['c-pg'].handover).toBeNull();
    expect(fake.dbs['c-pg'].addresses.map(a => a.host)).toEqual([]);
    expect(stored('c').fleetDb).toMatchObject({ containerName: 'c-pg' });
    expect(stored('c').fleetDbReplica).toBeUndefined();
    expect(h.adoptCalls[0].opts).toEqual({ op: 'takeover', alone: false, formerMain: { machine: 'main.invalid', generation: 3 } });
    expect(h.events.indexOf('adopt')).toBeLessThan(h.events.indexOf('order:running'));
    expect(h.hookCalls).toEqual([{ action: 'switch-notice', body: { machine: 'copy.example', generation: 4, date: '2026-10-28T13:00:00Z' } }]);
    expect(stored('c').fleetDb.switchNotice).toMatchObject({ generation: 4, state: 'sent' });
  });

  it.each([
    ['no copy', { fleetDbReplica: undefined }, `This instance holds no live copy to take over with${NOTHING}`],
    ['a main here', { fleetDb: { containerName: 'x', user: 'u', db: 'd', volume: 'v' } }, `This instance already holds a main database${NOTHING}`],
    ['a seed', { fleetDbReplicaSeed: { purpose: 'provision', phase: 'seeding', startedAt: 1, updatedAt: 1, primaryHost: 'p', primaryPort: 1, slot: 's' } }, `A seed of this copy is running or stopped; wait for it, or dismiss it first${NOTHING}`],
    ['cleared', { fleetDbReplica: { containerName: 'c-pg', volume: 'v', slot: 'slot_c', primaryHost: 'p', primaryPort: 1, certHost: 'c', user: 'app', db: 'app', seededAt: 1, copyCleared: true } }, `This copy was cleared for a re-seed and holds nothing; re-seed it first${NOTHING}`],
    ['never seeded', { fleetDbReplica: { containerName: 'c-pg', volume: 'v', slot: 'slot_c', primaryHost: 'p', primaryPort: 1, certHost: 'c', user: 'app', db: 'app' } }, `This copy has not finished its first seed${NOTHING}`],
    ['no identity', { fleetDbReplica: { containerName: 'c-pg', volume: 'v', slot: 'slot_c', primaryHost: 'p', primaryPort: 1, certHost: 'c', seededAt: 1 } }, `This copy's record has no database identity; remove it and add it again${NOTHING}`],
  ])('T2: %s', async (_n, over, text) => {
    writeRegistry({ c: copyFixture(over) });
    expect(await takeOverMain('c')).toEqual({ success: false, status: 409, text });
    expect(h.events).toEqual([]);
  });

  it('T3: the copy does not answer', async () => {
    h.copyFacts = { ok: false, reason: "the copy's database did not answer" };
    expect((await takeOverMain('c')).text).toBe(`The copy's database did not answer (the copy's database did not answer); start the instance and try again${NOTHING}`);
  });

  it('T4: replay behind receive after the wait', async () => {
    fake.dbs['c-pg'].receiveLsn = '0/6000000';
    expect((await takeOverMain('c')).text).toBe(`The copy received changes it has not applied yet after 0 seconds; try again in a moment${NOTHING}`);
    expect(fake.dbs['c-pg'].recovery).toBe(true);
  });

  it.each([
    ['T5', peer('writable', 3), `The main at main.invalid:15432 still answers as the main, so this copy was not promoted. Hand it over from its own manager (that loses nothing), or stop it first${NOTHING}`],
    ['T6', peer('in-recovery'), `The database at main.invalid:15432 now follows another database, so the main moved somewhere else; Join with the current main's code${NOTHING}`],
    ['T31', peer('fenced'), `The main at main.invalid:15432 answers, but refuses every session except replication (FATAL:  pg_hba.conf rejects connection for host "1.2.3.4"): a lane on its machine, such as a restore, holds a write fence on it. Let that lane finish there, then hand over from its manager${NOTHING}`],
  ])('%s: the old main answers', async (_id, p, text) => {
    h.peer = p;
    expect((await takeOverMain('c')).text).toBe(text);
    expect(fake.dbs['c-pg'].recovery).toBe(true);
    expect(stored('c').fleetDbReplica.takeover).toBeUndefined();
  });

  it('T7: the handover row names another slot', async () => {
    fake.dbs['c-pg'].handover = { slot: 'slot_t', machine: 'third.example', generation: 4 };
    expect((await takeOverMain('c')).text).toBe(`The main was handed over to third.example, not to this copy; take over on third.example's manager${NOTHING}`);
  });

  it('T8 and T9: no handover row asks W-UNPLANNED, and confirm takes over with the copy\'s own generation + 1', async () => {
    fake.dbs['c-pg'].handover = null;
    const asked = await takeOverMain('c');
    expect(asked).toMatchObject({ success: false, needsConfirm: true });
    expect(asked.text).toBe("The main at main.invalid:15432 did not answer (connection refused). Taking over now makes this copy the main without the main's last changes: the last change this copy received is from 2026-10-28 11:00 UTC. If the main can come back, waiting for it loses nothing; then hand over from its manager. If you take over, power the old main's machine off in its provider's panel if you can, so it cannot run as a second main. Take over now?");
    expect(fake.dbs['c-pg'].recovery).toBe(true);
    const r = await takeOverMain('c', { confirm: true });
    expect(r.text).toMatch(/^This machine is the main now \(generation 4, .*\)\. The old main's changes after 2026-10-28 11:00 UTC are not here\. /);
    expect(r.text).toContain(U_FOLLOW);
  });

  it('T10: no stored join code: the old main is not checked; the planned proof still counts', async () => {
    writeRegistry({ c: copyFixture({ fleetJoin: undefined }) });
    expect((await takeOverMain('c')).text).toMatch(P_LEAD);
    expect(h.events.some(e => e.startsWith('probe:'))).toBe(false);
    fake.dbs['c-pg'] = freshDb({ recovery: true, generation: { generation: 3, machine: 'main.invalid', since: '2026-10-28T10:00:00Z' } });
    writeRegistry({ c: copyFixture({ fleetJoin: undefined }) });
    expect((await takeOverMain('c')).text).toContain('did not answer (the join code stored here cannot be read, so the main was not checked)');
  });

  it('T11: the intent write throws', async () => {
    h.failTakeoverWrite = 'disk full';
    expect((await takeOverMain('c')).text).toBe(`The take-over could not be recorded (disk full)${NOTHING}`);
    expect(fake.dbs['c-pg'].recovery).toBe(true);
  });

  it('T12 and T13: promote answers f with the copy still in recovery, or fails with the copy promoted', async () => {
    fake.dbs['c-pg'].promote = 'f';
    expect((await takeOverMain('c')).text).toBe('The copy was not promoted (it answered that the promotion did not finish within 60 seconds); nothing else was changed. Press Take over again.');
    expect(stored('c').fleetDbReplica.takeover).toMatchObject({ planned: true, generation: 4 });
    fake.dbs['c-pg'].promote = 'error';
    h.copyFacts = { ok: true, facts: { inRecovery: false, streaming: false, systemId: '7001', timeline: 2, lsn: 1n } };
    h.copyFacts = [{ ok: true, facts: { inRecovery: true, streaming: true, systemId: '7001', timeline: 1, lsn: 1n } }, { ok: true, facts: { inRecovery: false, streaming: false, systemId: '7001', timeline: 2, lsn: 1n } }];
    expect((await takeOverMain('c')).success).toBe(true);
  });

  it('T14: the raise fails; T20 resume finishes it', async () => {
    fake.dbs['c-pg'].fail.raise = 'ERROR:  disk full';
    expect((await takeOverMain('c')).text).toBe('The copy is promoted, but its generation could not be raised (ERROR:  disk full), so bots may not choose it over the old main. Press Take over again to finish.');
    expect(fake.dbs['c-pg'].recovery).toBe(false);
    delete fake.dbs['c-pg'].fail.raise;
    h.copyFacts = { ok: true, facts: { inRecovery: false, streaming: false, systemId: '7001', timeline: 2, lsn: 1n } };
    const r = await takeOverMain('c');
    expect(r.text).toMatch(P_LEAD);
    expect(fake.dbs['c-pg'].generation?.generation).toBe(4);
  });

  it('T15 and T16: adopt refuses before its flip; Enable fails after it', async () => {
    h.adopt = { success: false, error: 'the env store refused' };
    expect((await takeOverMain('c')).text).toBe('The copy is promoted and its generation raised, but it could not be filed as this machine\'s database (the env store refused). Press Take over again to finish.');
    expect(stored('c').fleetDbReplica.takeover).toBeDefined();
    h.adopt = { success: false, flipped: true, error: 'Enable failed' };
    h.copyFacts = { ok: true, facts: { inRecovery: false, streaming: false, systemId: '7001', timeline: 2, lsn: 1n } };
    expect((await takeOverMain('c')).text).toContain(' Replication could not be enabled here (Enable failed); enable it in the Replication section so other machines can use this database.');
  });

  it('T17: a copy with no address adopts without Enable', async () => {
    writeRegistry({ c: copyFixture({ fleetDbReplica: { ...copyFixture().fleetDbReplica as object, publicHost: undefined, hostPort: undefined } }) });
    const r = await takeOverMain('c');
    expect(h.adoptCalls[0].opts).toEqual({ op: 'takeover', alone: true, formerMain: { machine: 'main.invalid', generation: 3 } });
    expect(r.text).toContain(" This copy has no address for other machines, so it is the main only while it runs alone; other machines' bots cannot reach it.");
  });

  it('T22 and T23: promoted outside the manager: the old main probed first, W-PROMOTED with its reason, then block, raise, lift, adopt', async () => {
    h.copyFacts = { ok: true, facts: { inRecovery: false, streaming: false, systemId: '7001', timeline: 2, lsn: 1n } };
    fake.dbs['c-pg'].recovery = false;
    const asked = await takeOverMain('c');
    expect(asked.text).toBe("This copy no longer follows a main: it was promoted outside the manager. The main at main.invalid:15432 did not answer (connection refused). Taking over raises this copy's generation so bots use it as the main, and files it as this machine's database; changes the old main took after this copy stopped following it are not here. If you take over, power the old main's machine off in its provider's panel if you can, so it cannot run as a second main. Take over now?");
    expect(h.events).toContain('probe:main.invalid');
    expect(stored('c').fleetDbReplica.takeover).toBeUndefined();
    h.events.length = 0;
    const r = await takeOverMain('c', { confirm: true });
    expect(r.text).toMatch(/^This machine is the main now \(generation 4/);
    expect(h.events.filter(e => ['probe:main.invalid', 'hba-block', 'promote', 'raise', 'hba-lift', 'adopt'].includes(e))).toEqual(['probe:main.invalid', 'hba-block', 'raise', 'hba-lift', 'adopt']);
  });

  it('T24 to T27: the Running order, Off, start false and a failed start', async () => {
    h.order = { settled: false, text: 'Running is not confirmed: x.' };
    expect((await takeOverMain('c')).text).toContain(' Running is not confirmed: x.');
    expect(h.events).not.toContain('start-bot');

    resetTo();
    writeRegistry({ c: copyFixture({ maintenance: { state: 'off', message: '', orderedAt: 'x', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: 'maintenance' } }) });
    expect((await takeOverMain('c')).text).toContain(" The bot's state is Off; choose Running in the State window to start it here.");
    expect(h.events).not.toContain('order:running');

    resetTo();
    expect((await takeOverMain('c', { start: false })).text).toContain(' The bot was not started; choose Running in the State window when ready.');

    resetTo();
    h.app = false;
    h.start = { success: false, error: 'image missing' };
    expect((await takeOverMain('c')).text).toContain(' The bot did not start (image missing); press Start.');
  });

  it('T30: the notice outcomes', async () => {
    h.hook = () => ({ ok: false, status: 404, error: 'no route' });
    expect((await takeOverMain('c')).text).toContain(" This bot's build has no switch-notice hook, so the owner got no message about this switch.");
    resetTo();
    h.hook = () => ({ ok: false, unknown: true, error: 'timeout' });
    expect((await takeOverMain('c')).text).toContain(" Whether the switch notice for generation 4 was posted can't be confirmed (timeout); the manager asks again within an hour");
    resetTo();
    h.hook = () => ({ ok: false, status: 409, error: 'a higher generation answers' });
    expect((await takeOverMain('c')).text).toContain(' The bot did not post the switch notice for generation 4 (a higher generation answers).');
    resetTo();
    h.hook = () => ({ ok: true, status: 200, body: { success: true, posted: false, note: 'already posted' } });
    expect((await takeOverMain('c')).text).toContain(' The bot posted no new switch notice for generation 4 on ');
    resetTo();
    h.app = false;
    h.start = { success: false, error: 'x' };
    expect((await takeOverMain('c')).text).toContain(' The switch notice waits until the bot runs.');
  });

  it('T32: unplanned with the restore record pending: the notice lands in the flip\'s save, no Running, no start', async () => {
    fake.dbs['c-pg'].handover = null;
    fake.dbs['c-pg'].restoreState = { pending: true, file: 'old.dump', at: '2026-10-28T09:00:00Z', generation: 3, machine: 'main.invalid', since: null };
    const asked = await takeOverMain('c');
    expect(asked.text).toContain(' The main was restoring the dump old.dump (started 2026-10-28 09:00 UTC) and had not finished it when this copy last received a change, so this copy may hold a missing or partial database. If you take over, the Database window here shows a restore notice and the bot is not started. Take over now?');
    const saves: any[] = [];
    const spy = vi.spyOn(containerManager, 'adoptFleetDbReplicaAsPrimary');
    const r = await takeOverMain('c', { confirm: true });
    saves.push(stored('c'));
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect(saves[0].fleetDb).toBeDefined();
    expect(saves[0].fleetRestoreError).toMatchObject({ file: 'old.dump', doubt: true });
    expect(saves[0].fleetRestoreError.text).toMatch(/^The main this copy took over from was restoring the dump old\.dump \(started 2026-10-28 09:00 UTC\)/);
    expect(r.text).toContain(" The bot was not started: the old main's restore had not finished, and its notice is on the Database window.");
    expect(h.events).not.toContain('order:running');
    expect(h.events).not.toContain('start-bot');
  });

  it('T33: the bot database missing on the copy, with the restore clause', async () => {
    fake.dbs['c-pg'].botDbMissing = true;
    fake.dbs['c-pg'].restoreState = { pending: true, file: 'old.dump', at: '2026-10-28T09:00:00Z', generation: 3, machine: 'm', since: null };
    expect((await takeOverMain('c')).text).toBe(`The bot's database is missing on this copy (it replayed the drop of a restore), so there is nothing to take over: the main was restoring the dump old.dump (started 2026-10-28 09:00 UTC) when this copy last received a change${NOTHING}`);
  });

  it('T34: planned with the record pending takes over without a notice', async () => {
    fake.dbs['c-pg'].restoreState = { pending: true, file: 'old.dump', at: '2026-10-28T09:00:00Z', generation: 2, machine: 'm', since: null };
    const r = await takeOverMain('c');
    expect(r.text).toMatch(P_LEAD);
    expect(stored('c').fleetRestoreError).toBeUndefined();
    expect(h.events).toContain('order:running');
  });

  it('T35: a crash after the intent with inherit: Take over again gives the notice before any Running', async () => {
    fake.dbs['c-pg'].recovery = false;
    h.copyFacts = { ok: true, facts: { inRecovery: false, streaming: false, systemId: '7001', timeline: 2, lsn: 1n } };
    writeRegistry({ c: copyFixture({ fleetDbReplica: { ...copyFixture().fleetDbReplica as object, takeover: { startedAt: 'x', planned: false, generation: 4, inherit: { file: 'old.dump', at: '2026-10-28T09:00:00Z' } } } }) });
    const r = await takeOverMain('c');
    expect(stored('c').fleetRestoreError).toMatchObject({ file: 'old.dump', doubt: true });
    expect(r.text).toContain('its notice is on the Database window');
    expect(h.events).not.toContain('order:running');
  });

  it('T28: Take over while one runs', async () => {
    const first = takeOverMain('c');
    expect((await takeOverMain('c')).text).toBe(`Operation 'takeover' is running on this bot; wait for it to finish${NOTHING}`);
    await first;
  });
});

describe('T36 to T45: the bot login blocked on the copy until the raise (D35), and the database list after the flip', () => {
  const BLOCK = ['hba-block', 'reload', 'hba-probe'];
  const LIFT = ['hba-lift', 'reload', 'hba-probe'];
  const unplanned = () => { fake.dbs['c-pg'].handover = null; };
  const stepsOf = () => h.events.filter(e => ['hba-block', 'hba-lift', 'reload', 'hba-probe', 'end-sessions', 'promote', 'raise', 'adopt', 'auth-wait'].includes(e));
  it('T36: unplanned with the bot login open: block, reload, proof, the wait, sessions ended, then promote, raise, lift, adopt', async () => {
    unplanned();
    h.login = { inRecovery: true, canLogin: true, sessions: 1 };
    fake.dbs['c-pg'].authTimeout = '1';
    const t0 = Date.now();
    const r = await takeOverMain('c', { confirm: true });
    expect(r.success).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
    expect(stepsOf()).toEqual([...BLOCK, 'end-sessions', 'promote', 'raise', ...LIFT, 'adopt']);
    const block = fake.calls.find(c => c.args[0] === 'exec' && c.args[1] === '-u')!;
    expect(block.args.slice(0, 6)).toEqual(['exec', '-u', 'root', 'c-pg', 'sh', '-c']);
    expect(block.args[6]).toContain(`printf '%s\\n' 'host all "app" all reject # smdb-takeover-block'`);
    expect(fake.dbs['c-pg'].hbaFileBlock).toBe(false);
    expect(fake.dbs['c-pg'].hbaLive).toBe(false);
  });
  it('T44: planned with the bot role NOLOGIN: the block without the wait, then promote', async () => {
    fake.dbs['c-pg'].authTimeout = '5';
    const t0 = Date.now();
    expect((await takeOverMain('c')).success).toBe(true);
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(stepsOf()).toEqual([...BLOCK, 'end-sessions', 'promote', 'raise', ...LIFT, 'adopt']);
  });
  it.each([
    ['another hba file', (d: any) => { d.hbaFile = '/etc/postgresql/pg_hba.conf'; }, "the database reads its pg_hba from /etc/postgresql/pg_hba.conf, not /var/lib/postgresql/data/pg_hba.conf"],
    ['the script fails', (d: any) => { d.fail['block-script'] = 'sh: cannot create /var/lib/postgresql/data/pg_hba.conf.tk: Read-only file system'; }, 'sh: cannot create /var/lib/postgresql/data/pg_hba.conf.tk: Read-only file system'],
    ['the reload fails', (d: any) => { d.fail.reload = 'ERROR:  permission denied for function pg_reload_conf'; }, 'ERROR:  permission denied for function pg_reload_conf'],
  ])('T37: %s: no promote, the intent kept, TK-BLOCK', async (_n, set, error) => {
    unplanned();
    set(fake.dbs['c-pg']);
    const r = await takeOverMain('c', { confirm: true });
    expect(r.text).toBe(`The copy was not promoted: the bot's login to it could not be blocked first (${error}), and a copy promoted with that login open could be taken for the main before its generation is raised. The copy still follows the main; press Take over again.`);
    expect(h.events).not.toContain('promote');
    expect(fake.dbs['c-pg'].recovery).toBe(true);
    expect(stored('c').fleetDbReplica.takeover).toMatchObject({ planned: false, generation: 4 });
  });
  it('T37: a bot role name that does not match refuses before any script', async () => {
    unplanned();
    writeRegistry({ c: copyFixture({ fleetDbReplica: { ...copyFixture().fleetDbReplica as object, user: 'app"; drop' } }) });
    const r = await takeOverMain('c', { confirm: true });
    expect(r.text).toContain('the bot\'s login to it could not be blocked first (the bot\'s role name app"; drop is not a plain identifier)');
    expect(h.events).not.toContain('hba-block');
    expect(h.events).not.toContain('promote');
  });
  it('T37: the proof never sees the rejection within 15 s', async () => {
    unplanned();
    SWITCH_TIMING.blockProbeMs = 60;
    SWITCH_TIMING.blockGapMs = 10;
    fake.dbs['c-pg'].fail.reload = undefined as any;
    delete fake.dbs['c-pg'].fail.reload;
    const d = fake.dbs['c-pg'];
    Object.defineProperty(d, 'hbaLive', { get: () => false, set: () => undefined, configurable: true });
    const r = await takeOverMain('c', { confirm: true });
    expect(r.text).toContain("could not be blocked first (a login over TCP was still admitted after 0 seconds)");
    expect(h.events).not.toContain('promote');
  });
  it('T38: sessions of the bot role left after the three rounds', async () => {
    unplanned();
    h.endSessions = { ok: false, cls: 'other', error: 'sessions left', left: 2 };
    const r = await takeOverMain('c', { confirm: true });
    expect(r.text).toContain("could not be blocked first (2 session(s) of the bot's role did not end)");
    expect(h.events).not.toContain('promote');
  });
  it('T39: a crash after the block, before the promote: Take over again blocks again (rerun-safe), then promotes', async () => {
    unplanned();
    fake.dbs['c-pg'].hbaFileBlock = true;
    fake.dbs['c-pg'].hbaLive = true;
    writeRegistry({ c: copyFixture({ fleetDbReplica: { ...copyFixture().fleetDbReplica as object, takeover: { startedAt: 'x', planned: false, generation: 4 } } }) });
    expect((await takeOverMain('c', { confirm: true })).success).toBe(true);
    expect(stepsOf()).toEqual([...BLOCK, 'end-sessions', 'promote', 'raise', ...LIFT, 'adopt']);
  });
  it('T40: a crash after the promote, before the raise: resume blocks again, raises, lifts, adopts', async () => {
    fake.dbs['c-pg'].recovery = false;
    fake.dbs['c-pg'].hbaFileBlock = true;
    fake.dbs['c-pg'].hbaLive = true;
    h.copyFacts = { ok: true, facts: { inRecovery: false, streaming: false, systemId: '7001', timeline: 2, lsn: 1n } };
    writeRegistry({ c: copyFixture({ fleetDbReplica: { ...copyFixture().fleetDbReplica as object, takeover: { startedAt: 'x', planned: true, generation: 4 } } }) });
    const r = await takeOverMain('c');
    expect(r.text).toMatch(P_LEAD);
    expect(stepsOf()).toEqual([...BLOCK, 'end-sessions', 'raise', ...LIFT, 'adopt']);
  });
  it('T41: a crash after the raise, before the lift: resume answers the same row, lifts, adopts', async () => {
    fake.dbs['c-pg'].recovery = false;
    fake.dbs['c-pg'].generation = { generation: 4, machine: 'copy.example', since: '2026-10-28T13:00:00Z' };
    fake.dbs['c-pg'].hbaFileBlock = true;
    fake.dbs['c-pg'].hbaLive = true;
    h.copyFacts = { ok: true, facts: { inRecovery: false, streaming: false, systemId: '7001', timeline: 2, lsn: 1n } };
    writeRegistry({ c: copyFixture({ fleetDbReplica: { ...copyFixture().fleetDbReplica as object, takeover: { startedAt: 'x', planned: true, generation: 4 } } }) });
    expect((await takeOverMain('c')).success).toBe(true);
    expect(fake.dbs['c-pg'].generation?.generation).toBe(4);
    expect(fake.dbs['c-pg'].hbaLive).toBe(false);
  });
  it('T42: the lift fails: raised, the line stays, the intent kept, no adopt, TK-LIFT', async () => {
    fake.dbs['c-pg'].fail['lift-script'] = 'sed: cannot rename /var/lib/postgresql/data/sedX: Permission denied';
    const r = await takeOverMain('c');
    expect(r.text).toBe("This machine's database is the main now (generation 4), but the bot's login to it is still blocked (sed: cannot rename /var/lib/postgresql/data/sedX: Permission denied): the line the take-over put in its pg_hba.conf could not be removed. Press Take over again to finish.");
    expect(fake.dbs['c-pg'].generation?.generation).toBe(4);
    expect(fake.dbs['c-pg'].hbaLive).toBe(true);
    expect(h.events).not.toContain('adopt');
    expect(stored('c').fleetDbReplica.takeover).toBeDefined();
  });
  it.each([
    ['TK-MAINUP', peer('writable', 3), 'still answers as the main'],
    ['TK-MAINFENCED', peer('fenced'), 'refuses every session except replication'],
    ['TK-MAINCOPY', peer('in-recovery'), 'now follows another database'],
  ])('T43: Take over again refused by %s while still in recovery withdraws the take-over', async (_n, p, part) => {
    unplanned();
    h.peer = p;
    fake.dbs['c-pg'].hbaFileBlock = true;
    fake.dbs['c-pg'].hbaLive = true;
    writeRegistry({ c: copyFixture({ fleetDbReplica: { ...copyFixture().fleetDbReplica as object, takeover: { startedAt: 'x', planned: false, generation: 4 } } }) });
    const r = await takeOverMain('c');
    expect(r.text).toContain(part);
    expect(r.text.endsWith(`${NOTHING} The unfinished take-over recorded here was withdrawn: this copy was never promoted.`)).toBe(true);
    expect(fake.dbs['c-pg'].hbaLive).toBe(false);
    expect(stored('c').fleetDbReplica.takeover).toBeUndefined();
  });
  it('T43: the withdrawal fails: the intent kept, TK-WITHDRAWFAIL', async () => {
    unplanned();
    h.peer = peer('writable', 3);
    fake.dbs['c-pg'].fail['lift-script'] = 'sed: Permission denied';
    writeRegistry({ c: copyFixture({ fleetDbReplica: { ...copyFixture().fleetDbReplica as object, takeover: { startedAt: 'x', planned: false, generation: 4 } } }) });
    const r = await takeOverMain('c');
    expect(r.text.endsWith(`${NOTHING} The unfinished take-over stays recorded, and this copy still refuses the bot's login (sed: Permission denied); press Take over again to retry the withdrawal.`)).toBe(true);
    expect(stored('c').fleetDbReplica.takeover).toBeDefined();
  });
  it('T43: a refusal with no intent recorded runs no lift', async () => {
    h.peer = peer('writable', 3);
    await takeOverMain('c');
    expect(h.events).not.toContain('hba-lift');
  });
  it.each([
    [{ state: 'applied' }, ' The running bot took the new database list.'],
    [{ state: 'applied', note: 'no bot process runs' }, ' The bot took the new database list (no bot process runs).'],
    [{ state: 'refused', error: 'the list names no writable database' }, ' The bot refused the new database list (the list names no writable database), so it uses the list only from its next start (Apply on the card, or Restart).'],
    [{ state: 'unsupported' }, " This bot's build does not take a new database list while it runs, so it uses the list from its next start (Apply on the card, or Restart)."],
    [{ state: 'pending', error: 'addresses sent, no answer within 10 s' }, " The manager can't confirm that the running bot took the new database list (addresses sent, no answer within 10 s); it sends the list again every minute until the bot answers."],
    [{ state: 'not-running' }, ''],
  ])('T45: adopt answers the list offer %j: its tail before the Running order', async (addresses, tail) => {
    h.adopt = { success: true, flipped: true, addresses } as any;
    const r = await takeOverMain('c', { start: false });
    expect(r.text).toMatch(P_LEAD);
    const lead = r.text.match(P_LEAD)![0];
    expect(r.text.slice(lead.length).startsWith(`${tail} The copies on third.example`)).toBe(true);
  });
});

function resetTo(): void {
  resetHarness();
  fake.dbs['c-pg'] = freshDb({ recovery: true, generation: { generation: 3, machine: 'main.invalid', since: '2026-10-28T10:00:00Z' }, handover: { slot: 'slot_c', machine: 'copy.example', generation: 4 } });
  writeRegistry({ c: copyFixture() });
}


describe('T18 to T21: a take-over cut by a manager crash, then Take over again', () => {
  const REG = path.join(tmp.dir, 'instances.json');
  /** Runs a take-over, and keeps the registry and the copy's database as they were when `at` was reached. */
  const crashAt = async (at: (e: string, seen: string[]) => boolean) => {
    let kept: { reg: Buffer; db: FakeDb } | null = null;
    const push = h.events.push.bind(h.events);
    h.events.push = (...e: string[]) => {
      if (!kept && at(e[0], h.events)) kept = { reg: fs.readFileSync(REG), db: structuredClone(fake.dbs['c-pg']) };
      return push(...e);
    };
    await takeOverMain('c');
    h.events.push = push;
    expect(kept).not.toBeNull();
    fs.writeFileSync(REG, kept!.reg);
    fake.dbs['c-pg'] = kept!.db;
    h.events.length = 0;
    h.hookCalls.length = 0;
    h.adoptCalls.length = 0;
  };
  const promoted = () => { h.copyFacts = { ok: true, facts: { inRecovery: false, streaming: false, systemId: '7001', timeline: 2, lsn: 1n } }; };

  it('T18: after the intent, before the promote: Take over again runs the checks again, planned as before', async () => {
    await crashAt(e => e === 'promote');
    expect(stored('c').fleetDbReplica.takeover).toMatchObject({ planned: true, generation: 4 });
    expect(fake.dbs['c-pg'].recovery).toBe(true);
    const r = await takeOverMain('c');
    expect(r.text).toMatch(P_LEAD);
    expect(h.events.filter(e => e.startsWith('probe:') || e === 'promote' || e === 'raise' || e === 'adopt')).toEqual(['probe:main.invalid', 'promote', 'raise', 'adopt']);
  });
  it('T19: after the promote, before the raise: resume skips the promote, raises, adopts', async () => {
    await crashAt(e => e === 'raise');
    expect(fake.dbs['c-pg'].recovery).toBe(false);
    expect(fake.dbs['c-pg'].generation?.generation).toBe(3);
    promoted();
    const r = await takeOverMain('c');
    expect(r.text).toMatch(P_LEAD);
    expect(h.events).not.toContain('promote');
    expect(h.events.filter(e => e === 'raise' || e === 'adopt')).toEqual(['raise', 'adopt']);
    expect(fake.dbs['c-pg'].generation?.generation).toBe(4);
  });
  it('T20: after the raise, before the adopt: resume raises again (the same row) and adopts', async () => {
    await crashAt(e => e === 'adopt');
    expect(fake.dbs['c-pg'].generation).toMatchObject({ generation: 4, machine: 'copy.example' });
    const since = fake.dbs['c-pg'].generation!.since;
    expect(stored('c').fleetDbReplica.takeover).toBeTruthy();
    promoted();
    const r = await takeOverMain('c');
    expect(r.text).toMatch(P_LEAD);
    expect(h.events).not.toContain('promote');
    expect(fake.dbs['c-pg'].generation).toEqual({ generation: 4, machine: 'copy.example', since });
    expect(stored('c').fleetDbReplica).toBeUndefined();
  });
  it('T21: after the adopt: the intent went with the copy record, the tick sends the notice, no Running is ordered', async () => {
    await crashAt((_e, seen) => seen.includes('adopt'));
    expect(stored('c').fleetDbReplica).toBeUndefined();
    expect(stored('c').fleetDb.switchNotice).toBeUndefined();
    const { switchTick, resetSwitchState } = await import('../../src/instance/fleetSwitch');
    resetSwitchState();
    await switchTick(Date.parse('2026-10-28T15:00:00Z'));
    expect(h.hookCalls.filter(c => c.action === 'switch-notice')).toEqual([{ action: 'switch-notice', body: { machine: 'copy.example', generation: 4, date: fake.dbs['c-pg'].generation!.since } }]);
    expect(h.events.filter(e => e.startsWith('order:'))).toEqual([]);
    expect(stored('c').maintenance.state).toBe('maintenance');
  });
});

describe('T29, T46 to T54: the promoted path, the copies list and the old main kept (round 1)', () => {
  const promoted = () => { h.copyFacts = { ok: true, facts: { inRecovery: false, streaming: false, systemId: '7001', timeline: 2, lsn: 1n } }; fake.dbs['c-pg'].recovery = false; };
  const OTHERS = (list: string) => ` The copies on ${list} followed the old main: on each of those machines, Join with this machine's join code, then Re-seed the copy.`;
  it('T29 and T53: the list comes from smdb_manager.copies, read before the raise; a copy without an address row is named by its last client address', async () => {
    fake.dbs['c-pg'].addresses = fake.dbs['c-pg'].addresses.filter(a => a.slot !== 'slot_t');
    fake.dbs['c-pg'].copies = [
      { slot: 'slot_c', machine: 'copy.example', client: '10.0.0.2' }, { slot: 'slot_t', machine: 'third.example', client: null },
      { slot: 'slot_u', machine: null, client: '10.0.0.9' }, { slot: 'slot_v', machine: null, client: null },
    ];
    const r = await takeOverMain('c', { start: false });
    expect(r.text).toContain(OTHERS('third.example, a machine without an address (last connected from 10.0.0.9), a machine without an address'));
    const all = fake.calls.filter(c => c.args[0] === 'exec' && c.args.includes('c-pg')).map(c => c.input);
    const read = all.findIndex(x => x.includes('FROM smdb_manager.copies WHERE slot <>'));
    const raise = all.findIndex(x => x.includes('INSERT INTO smdb_manager.generation AS g'));
    expect(read).toBeGreaterThanOrEqual(0);
    expect(read).toBeLessThan(raise);
    expect(fake.dbs['c-pg'].addresses.filter(a => a.slot !== null)).toEqual([]);
  });
  it.each([
    ['the table is missing', (d: FakeDb) => { d.copies = null; }, 'ERROR:  relation "smdb_manager.copies" does not exist'],
    ['the read fails', (d: FakeDb) => { d.fail['copies-read'] = 'ERROR:  canceling statement due to statement timeout'; }, 'ERROR:  canceling statement due to statement timeout'],
  ])('T54: %s: T-OTHERS-UNREAD, the address rows deleted as before', async (_n, set, error) => {
    set(fake.dbs['c-pg']);
    const r = await takeOverMain('c', { start: false });
    expect(r.success).toBe(true);
    expect(r.text).toContain(` The manager could not read which other machines held copies of the old main (${error}); on each machine that did, Join with this machine's join code, then Re-seed the copy.`);
    expect(r.text).not.toContain('followed the old main');
    expect(fake.dbs['c-pg'].addresses.filter(a => a.slot !== null)).toEqual([]);
  });
  it('T46: planned from a row the copy kept after a Cancel with confirm: the copy raises to that same generation', async () => {
    const r = await takeOverMain('c');
    expect(r.text).toMatch(P_LEAD);
    expect(fake.dbs['c-pg'].generation).toMatchObject({ generation: 4 });
  });
  it('T47: the flip keeps the old main: formerMain in the same save that drops fleetJoin, the code encrypted at rest and blanked for the browser', async () => {
    const code = (copyFixture().fleetJoin as { code: string }).code;
    const spy = vi.spyOn(containerManager, 'adoptFleetDbReplicaAsPrimary');
    const r = await takeOverMain('c', { start: false });
    expect(r.success).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    const saved = stored('c');
    expect(saved.fleetJoin).toBeUndefined();
    expect(saved.fleetDb.formerMain).toMatchObject({ slot: 'slot_c', machine: 'main.invalid', host: 'main.invalid', port: 15432, generation: 3 });
    expect(saved.fleetDb.formerMain.code).toMatch(/^v2:/);
    expect(containerManager.getBot('c')!.fleetDb!.formerMain!.code).toBe(code);
    expect(containerManager.withoutRecordSecrets(containerManager.getBot('c'))!.fleetDb!.formerMain!.code).toBe('');
  });
  it('T48: the stored join code cannot be read: no formerMain, S-TAKEOVER-U + U-NOCODE', async () => {
    fake.dbs['c-pg'].handover = null;
    writeRegistry({ c: copyFixture({ fleetJoin: undefined }) });
    const r = await takeOverMain('c', { confirm: true, start: false });
    expect(r.text).toMatch(/^This machine is the main now \(generation 4, .*\)\. The old main's changes after 2026-10-28 11:00 UTC are not here\. The join code stored here could not be read, so this manager cannot check the old main: if it runs again, choose Off for the bot in its manager, then rejoin it there as a copy of this machine\./);
    expect(stored('c').fleetDb.formerMain).toBeUndefined();
  });
  it('U-ALONE: the old main kept, this machine without an address', async () => {
    fake.dbs['c-pg'].handover = null;
    writeRegistry({ c: copyFixture({ fleetDbReplica: { ...copyFixture().fleetDbReplica as object, publicHost: undefined, hostPort: undefined } }) });
    const r = await takeOverMain('c', { confirm: true, start: false });
    expect(r.text).toMatch(/are not here\. This machine has no address for other machines, so the old main's manager cannot learn of this switch: if the old main runs again, choose Off for the bot in its manager\./);
  });
  it.each([
    ['T49', 'writable', "The main at main.invalid:15432 still answers as the main, so this copy, which was promoted outside the manager, was not made the main; nothing was changed. Both databases accept writes now. Stop the old main's bot and database in its manager, then press Take over again; or remove this copy and add it again, which deletes every change made to it since it was promoted."],
    ['T50', 'fenced', 'The main at main.invalid:15432 answers, but refuses every session except replication (FATAL:  pg_hba.conf rejects connection for host "1.2.3.4"): a lane on its machine, such as a restore, holds a write fence on it. This copy, which was promoted outside the manager, was not made the main; nothing was changed. Let that lane finish, then stop the old main and press Take over again; or remove this copy and add it again.'],
    ['T51', 'in-recovery', `The database at main.invalid:15432 now follows another database, so the main moved somewhere else; Join with the current main's code${NOTHING}`],
  ])('%s: promoted outside the manager, the old main %s: refused, no intent, no block', async (_id, kind, text) => {
    promoted();
    h.peer = peer(kind, 3);
    for (const confirm of [false, true]) {
      expect(await takeOverMain('c', { confirm })).toEqual({ success: false, status: 409, text });
      expect(stored('c').fleetDbReplica.takeover).toBeUndefined();
      expect(h.events).not.toContain('hba-block');
      expect(fake.dbs['c-pg'].generation?.generation).toBe(3);
    }
  });
  it('T52: not in recovery with an intent (a resume): no probe of the old main', async () => {
    promoted();
    h.peer = peer('writable', 3);
    writeRegistry({ c: copyFixture({ fleetDbReplica: { ...copyFixture().fleetDbReplica as object, takeover: { startedAt: 'x', planned: true, generation: 4 } } }) });
    const r = await takeOverMain('c', { start: false });
    expect(r.text).toMatch(P_LEAD);
    expect(h.events.some(e => e.startsWith('probe:'))).toBe(false);
  });
  const TK_PUSHED = "When this copy last received a change, the main still held the mark of a Receive, and its database had been replaced since that Receive (by a push or a restore) with no record that a push finished, so a take-over could run the bot on data no one checked; nothing was changed. If the main's machine still runs, its Database window says what stands there: let the push finish, or restore the dump it names with the bot in Maintenance or Off. If that window names no unfinished push and no receive, the mark was left over: start that database if it is stopped, and its manager removes the mark within a minute; then hand over from there. If that machine is gone, the machine that pushed keeps its own database until its push finishes or is cancelled: Cancel the push in its manager to keep that database as the main, then remove this copy and join that main. If no machine pushed, keep this copy, which may hold the bot's only database: when the manager cannot check the old main, Take over asks whether to take over anyway.";
  const W_UNCHECKED_Q = " The manager could not check the old main (the warning above says why), so it cannot tell whether a push into it finished; you can take over anyway. Do so only if you know that no machine was pushing into the old main, or that the machine that pushed holds no newer database than this copy. If that is wrong, this copy becomes the main with a database a push may have emptied or only partly filled; the machine that pushed keeps its own database and the pre-push- dump it made, and the data is recovered from there by a restore. Take over anyway?";
  const W_UNPLANNED_BODY = "The main at main.invalid:15432 did not answer (connection refused). Taking over now makes this copy the main without the main's last changes: the last change this copy received is from 2026-10-28 11:00 UTC. If the main can come back, waiting for it loses nothing; then hand over from its manager. If you take over, power the old main's machine off in its provider's panel if you can, so it cannot run as a second main.";
  const W_PROMOTED_BODY = "This copy no longer follows a main: it was promoted outside the manager. The main at main.invalid:15432 did not answer (connection refused). Taking over raises this copy's generation so bots use it as the main, and files it as this machine's database; changes the old main took after this copy stopped following it are not here. If you take over, power the old main's machine off in its provider's panel if you can, so it cannot run as a second main.";
  const TK_LOG_UNCHECKED = '[Switch] C: taking over a copy whose main had not finished checking a push that replaced its database; the operator confirmed that no machine was pushing into the old main, or that the machine that pushed holds no newer database';
  const refusedWithPushed = async (r: Promise<any>, first: string | null) => {
    const got = await r;
    expect(got).toMatchObject({ success: false, status: 409 });
    if (first === null) expect(got.text).toBe(TK_PUSHED);
    else { expect(got.text.startsWith(first)).toBe(true); expect(got.text.endsWith(`. ${TK_PUSHED}`)).toBe(true); }
  };
  const ASK_UNCHECKED = (body: string) => ({ success: false, status: 409, needsConfirm: true, confirmFlag: 'confirmUnchecked', text: `${TK_PUSHED} ${body}${W_UNCHECKED_Q}` });
  const W_RECEIVING = " The main was waiting to receive a push from another machine when this copy last received a change, and no push had replaced its database yet, so this copy holds the main's database as it was when Receive was pressed. Receive needs the bot Off, so the bot's later changes, if it made any, are on the machine that was to push: if that machine still runs, keep it as the main (Cancel the push in its manager) instead of taking over here.";
  const COPYDOWN = (e: string) => `The copy's database did not answer (${e}); start the instance and try again${NOTHING}`;
  const nothingRan = () => {
    expect(stored('c').fleetDbReplica.takeover).toBeUndefined();
    expect(h.events).not.toContain('hba-block');
    expect(h.events).not.toContain('promote');
    expect(fake.dbs['c-pg'].recovery).toBe(true);
  };
  const markRow = (dbOid: string, pushIds = ['a1']) => { fake.dbs['c-pg'].receiveMark = { markId: pushIds[0], pushIds, dbOid }; };
  it.each([
    ['T55 (D63): a mark row, another oid, no received row', () => markRow('11111')],
    ['T62 (D63): a mark row with an empty oid (Receive under pushBroken), no received row', () => markRow('')],
  ])('%s: refused, nothing changed, where the take-over is planned or the old main answers', async (_n, set) => {
    set();
    for (const confirm of [false, true]) expect(await takeOverMain('c', { confirm })).toEqual({ success: false, status: 409, text: TK_PUSHED });
    nothingRan();
    fake.dbs['c-pg'].handover = null;
    h.peer = peer('writable', 3);
    for (const confirm of [false, true]) await refusedWithPushed(takeOverMain('c', { confirm }), 'The main at main.invalid:15432 still answers as the main, so this copy was not promoted.');
    nothingRan();
  });
  it.each(['11111', ''])('T55 and T62: a planned press that finds an intent in recovery withdraws it (mark oid %j): the lift runs and the intent clears', async (oid) => {
    markRow(oid);
    fake.dbs['c-pg'].hbaFileBlock = true;
    fake.dbs['c-pg'].hbaLive = true;
    writeRegistry({ c: copyFixture({ fleetDbReplica: { ...copyFixture().fleetDbReplica as object, takeover: { startedAt: 'x', planned: false, generation: 4 } } }) });
    const r = await takeOverMain('c', { confirm: true });
    expect(r.text).toBe(`${TK_PUSHED} The unfinished take-over recorded here was withdrawn: this copy was never promoted.`);
    expect(fake.dbs['c-pg'].hbaLive).toBe(false);
    expect(stored('c').fleetDbReplica.takeover).toBeUndefined();
    expect(h.events).not.toContain('promote');
  });
  it('T57 (D63): no generation row, no mark, no pending restore: planned, promoted and raised to the handover row\'s 1', async () => {
    fake.dbs['c-pg'].generation = null;
    fake.dbs['c-pg'].handover = { slot: 'slot_c', machine: 'copy.example', generation: 1 };
    const r = await takeOverMain('c', { start: false });
    expect(r.success).toBe(true);
    expect(fake.dbs['c-pg'].recovery).toBe(false);
    expect(fake.dbs['c-pg'].generation).toMatchObject({ generation: 1, machine: 'copy.example' });
  });
  it('T57: no row with the restore record pending is not refused by the check', async () => {
    fake.dbs['c-pg'].handover = null;
    fake.dbs['c-pg'].generation = null;
    fake.dbs['c-pg'].restoreState = { pending: true, file: 'old.dump', at: '2026-10-28T09:00:00Z', generation: 3, machine: 'main.invalid', since: null };
    expect((await takeOverMain('c')).needsConfirm).toBe(true);
  });
  it('T57: the receive_mark table missing reads as no mark', async () => {
    fake.dbs['c-pg'].markTable = false;
    const r = await takeOverMain('c', { start: false });
    expect(r.success).toBe(true);
    expect(h.events).toContain('mark-read');
  });
  it('T58 (D61, round 3): a resume reads no mark, no oid and no received row', async () => {
    h.copyFacts = { ok: true, facts: { inRecovery: false, streaming: false, systemId: '7001', timeline: 2, lsn: 1n } };
    fake.dbs['c-pg'].recovery = false;
    fake.dbs['c-pg'].generation = { generation: 4, machine: 'copy.example', since: '2026-10-28T13:00:00Z' };
    markRow('11111');
    writeRegistry({ c: copyFixture({ fleetDbReplica: { ...copyFixture().fleetDbReplica as object, takeover: { startedAt: 'x', planned: true, generation: 4 } } }) });
    const r = await takeOverMain('c', { start: false });
    expect(r.text).toMatch(P_LEAD);
    expect(h.events).not.toContain('mark-read');
    expect(h.events).not.toContain('oid-read');
  });
  const realRow = async () => {
    const { ensureMainGeneration } = await import('../../src/instance/fleetSwitch');
    fake.dbs['a-pg'] = freshDb({ generation: null, tables: false });
    writeRegistry({ a: { fleetDb: { containerName: 'a-pg', user: 'app', db: 'app', volume: 'a-pgdata' }, displayName: 'My Bot' } });
    await ensureMainGeneration('a');
    const row = fake.dbs['a-pg'].generation;
    expect(row).toMatchObject({ generation: 1 });
    fake.dbs['c-pg'].generation = { ...row! };
    return row!;
  };
  const mainCode = () => copyFixture({ fleetJoin: fakeJoinRecord({}, { machine: 'main.example' }) });
  it('T60 (F2-1, planned): the row written by the real ensure as the display name, a join code naming main.example, Hand over: promoted, raised, adopted', async () => {
    const row = await realRow();
    expect(row.machine).not.toBe('main.example');
    writeRegistry({ c: mainCode() });
    fake.dbs['c-pg'].handover = { slot: 'slot_c', machine: 'copy.example', generation: 2 };
    const r = await takeOverMain('c', { start: false });
    expect(r.success).toBe(true);
    expect(fake.dbs['c-pg'].recovery).toBe(false);
    expect(fake.dbs['c-pg'].generation).toMatchObject({ generation: 2, machine: 'copy.example' });
    expect(stored('c').fleetDb).toMatchObject({ containerName: 'c-pg' });
  });
  it('T61 (F2-1, unplanned): as T60 without the hand-over, the old main unreachable, with confirm', async () => {
    await realRow();
    writeRegistry({ c: mainCode() });
    fake.dbs['c-pg'].handover = null;
    const asked = await takeOverMain('c');
    expect(asked).toMatchObject({ success: false, needsConfirm: true });
    expect(asked.text).not.toContain(W_RECEIVING);
    const r = await takeOverMain('c', { confirm: true, start: false });
    expect(r.success).toBe(true);
    expect(fake.dbs['c-pg'].generation).toMatchObject({ generation: 2, machine: 'copy.example' });
  });
  it('T63 (D63): a mark row, another oid, and a received row of one of its ids: the take-over runs', async () => {
    markRow('11111', ['a1', 'b2']);
    fake.dbs['c-pg'].received.push({ pushId: 'b2', from: '9', machine: 'win.local', generation: 3 });
    const r = await takeOverMain('c', { start: false });
    expect(r.success).toBe(true);
    expect(fake.dbs['c-pg'].generation).toMatchObject({ generation: 4, machine: 'copy.example' });
    const read = fake.calls.find(c => c.input.includes('FROM smdb_manager.received WHERE push_id IN ('));
    expect(read?.input).toContain("push_id IN ('a1', 'b2')");
  });
  it('T64 (D63, D64): unplanned, the mark row\'s oid is the copy\'s: W-UNPLANNED + W-RECEIVING, then with confirm promoted', async () => {
    fake.dbs['c-pg'].handover = null;
    markRow('16384');
    const asked = await takeOverMain('c');
    expect(asked).toMatchObject({ success: false, needsConfirm: true, status: 409 });
    expect(asked.text).toBe(`The main at main.invalid:15432 did not answer (connection refused). Taking over now makes this copy the main without the main's last changes: the last change this copy received is from 2026-10-28 11:00 UTC. If the main can come back, waiting for it loses nothing; then hand over from its manager. If you take over, power the old main's machine off in its provider's panel if you can, so it cannot run as a second main.${W_RECEIVING} Take over now?`);
    expect(h.events).not.toContain('received-read');
    nothingRan();
    const r = await takeOverMain('c', { confirm: true, start: false });
    expect(r.success).toBe(true);
    expect(fake.dbs['c-pg'].recovery).toBe(false);
  });
  it.each([
    ['the mark read fails', (d: FakeDb) => { d.fail['mark-read'] = 'ERROR:  canceling statement due to statement timeout'; }, 'ERROR:  canceling statement due to statement timeout'],
    ['the mark does not parse', (d: FakeDb) => { d.receiveMark = { markId: 'zz', pushIds: ['zz'], dbOid: '1' }; }, "the receive mark answered 'zz|zz|1'"],
    ['the oid read fails', (d: FakeDb) => { d.receiveMark = { markId: 'a1', pushIds: ['a1'], dbOid: '11111' }; d.fail['oid-read'] = 'ERROR:  canceling statement due to statement timeout'; }, 'ERROR:  canceling statement due to statement timeout'],
    ['the received read fails', (d: FakeDb) => { d.receiveMark = { markId: 'a1', pushIds: ['a1'], dbOid: '11111' }; d.fail['received-read'] = 'ERROR:  canceling statement due to statement timeout'; }, 'ERROR:  canceling statement due to statement timeout'],
  ])('T65 (D63): %s: TK-COPYDOWN with the error, nothing changed', async (_n, set, error) => {
    fake.dbs['c-pg'].handover = null;
    set(fake.dbs['c-pg']);
    expect(await takeOverMain('c', { confirm: true })).toEqual({ success: false, status: 409, text: COPYDOWN(error) });
    nothingRan();
  });
  const promotedCopy = () => {
    h.copyFacts = { ok: true, facts: { inRecovery: false, streaming: false, systemId: '7001', timeline: 2, lsn: 1n } };
    fake.dbs['c-pg'].recovery = false;
    fake.dbs['c-pg'].handover = null;
  };
  it('T66 (D63): promoted outside the manager, the mark\'s oid unchanged: W-PROMOTED + W-RECEIVING; changed with the old main answering: TK-PUSHED', async () => {
    promotedCopy();
    markRow('16384');
    const asked = await takeOverMain('c');
    expect(asked).toMatchObject({ success: false, needsConfirm: true });
    expect(asked.text).toMatch(/^This copy no longer follows a main: it was promoted outside the manager./);
    expect(asked.text.endsWith(`${W_RECEIVING} Take over now?`)).toBe(true);
    markRow('11111');
    h.peer = peer('writable', 3);
    await refusedWithPushed(takeOverMain('c', { confirm: true }), 'The main at main.invalid:15432 still answers as the main, so this copy, which was promoted outside the manager, was not made the main; nothing was changed. Both databases accept writes now.');
    expect(stored('c').fleetDbReplica.takeover).toBeUndefined();
  });
  /** The registry's take-over intent saves and the console.warn lines, in h.events. */
  const trackIntent = () => {
    const real = containerManager.updateInstanceFleetDbReplicaTakeover;
    const spy = vi.spyOn(containerManager, 'updateInstanceFleetDbReplicaTakeover').mockImplementation(((id: string, t: any) => {
      h.events.push(t ? 'intent-save' : 'intent-clear');
      return real(id, t);
    }) as any);
    const warned: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { warned.push(String(m)); h.events.push(`warn:${String(m)}`); });
    return { warned, restore: () => { spy.mockRestore(); warn.mockRestore(); } };
  };
  it('T67 (D67): unplanned with an unchecked mark: TK-PUSHED-Q with W-UNPLANNED\'s body, with and without confirm; nothing changed, an earlier intent kept', async () => {
    fake.dbs['c-pg'].handover = null;
    markRow('11111');
    for (const confirm of [false, true]) expect(await takeOverMain('c', { confirm })).toEqual(ASK_UNCHECKED(W_UNPLANNED_BODY));
    nothingRan();
    const intent = { startedAt: 'x', planned: false, generation: 4 };
    writeRegistry({ c: copyFixture({ fleetDbReplica: { ...copyFixture().fleetDbReplica as object, takeover: intent } }) });
    expect(await takeOverMain('c', { confirm: true })).toEqual(ASK_UNCHECKED(W_UNPLANNED_BODY));
    expect(stored('c').fleetDbReplica.takeover).toEqual(intent);
    expect(h.events).not.toContain('promote');
  });
  it('T68 (D67): with confirmUnchecked: promoted at g + 1, TK-LOG-UNCHECKED before the intent\'s save; the new main\'s N-j then removes the row', async () => {
    fake.dbs['c-pg'].handover = null;
    markRow('11111');
    const seen = trackIntent();
    const r = await takeOverMain('c', { confirmUnchecked: true, start: false });
    seen.restore();
    expect(r.success).toBe(true);
    expect(fake.dbs['c-pg'].recovery).toBe(false);
    expect(fake.dbs['c-pg'].generation).toMatchObject({ generation: 4, machine: 'copy.example' });
    expect(stored('c').fleetDb).toMatchObject({ containerName: 'c-pg' });
    expect(stored('c').fleetDb.receive).toBeUndefined();
    expect(stored('c').fleetDb.pushBroken).toBeUndefined();
    expect(seen.warned).toContain(TK_LOG_UNCHECKED);
    expect(h.events.indexOf(`warn:${TK_LOG_UNCHECKED}`)).toBeLessThan(h.events.indexOf('intent-save'));
    expect(fake.dbs['c-pg'].receiveMark).not.toBeNull();
    const { switchTick, resetSwitchState } = await import('../../src/instance/fleetSwitch');
    resetSwitchState();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await switchTick(Date.parse('2026-10-28T15:00:00Z'));
    log.mockRestore();
    warn.mockRestore();
    expect(fake.dbs['c-pg'].receiveMark).toBeNull();
    const clear = fake.calls.find(c => c.input.includes('DELETE FROM smdb_manager.receive_mark'));
    expect(clear?.input).toContain("mark_id = 'a1'");
  });
  it('T69 (D67): promoted outside the manager, the mark unchecked, the old main not answering: TK-PUSHED-Q with W-PROMOTED\'s body; with the flag as T23', async () => {
    promotedCopy();
    markRow('11111');
    for (const confirm of [false, true]) expect(await takeOverMain('c', { confirm })).toEqual(ASK_UNCHECKED(W_PROMOTED_BODY));
    expect(stored('c').fleetDbReplica.takeover).toBeUndefined();
    expect(h.events).not.toContain('raise');
    const seen = trackIntent();
    const r = await takeOverMain('c', { confirmUnchecked: true, start: false });
    seen.restore();
    expect(r.text).toMatch(/^This machine is the main now \(generation 4/);
    expect(fake.dbs['c-pg'].generation).toMatchObject({ generation: 4, machine: 'copy.example' });
    expect(stored('c').fleetDb).toMatchObject({ containerName: 'c-pg' });
    expect(seen.warned).toContain(TK_LOG_UNCHECKED);
    expect(h.events.indexOf(`warn:${TK_LOG_UNCHECKED}`)).toBeLessThan(h.events.indexOf('intent-save'));
  });
  it.each([
    ['planned (a hand-over row for this slot)', () => undefined, null],
    ['TK-MAINUP', () => { fake.dbs['c-pg'].handover = null; h.peer = peer('writable', 3); }, 'The main at main.invalid:15432 still answers as the main, so this copy was not promoted.'],
    ['TK-MAINFENCED', () => { fake.dbs['c-pg'].handover = null; h.peer = peer('fenced'); }, 'The main at main.invalid:15432 answers, but refuses every session except replication ('],
    ['TK-MAINCOPY', () => { fake.dbs['c-pg'].handover = null; h.peer = peer('in-recovery'); }, 'The database at main.invalid:15432 now follows another database, so the main moved somewhere else;'],
    ['TK-OTHER', () => { fake.dbs['c-pg'].handover = { slot: 'slot_t', machine: 'third.example', generation: 4 }; }, 'The main was handed over to third.example, not to this copy;'],
    ['TK-MAINUP-P', () => { promotedCopy(); h.peer = peer('writable', 3); }, 'The main at main.invalid:15432 still answers as the main, so this copy, which was promoted outside the manager, was not made the main; nothing was changed. Both databases accept writes now.'],
    ['TK-MAINFENCED-P', () => { promotedCopy(); h.peer = peer('fenced'); }, 'The main at main.invalid:15432 answers, but refuses every session except replication ('],
  ] as [string, () => void, string | null][])('T70 (D67): confirmUnchecked changes nothing where the take-over is %s: the refusal\'s text, then TK-PUSHED', async (_n, set, first) => {
    set();
    markRow('11111');
    const r = takeOverMain('c', { confirm: true, confirmUnchecked: true });
    if (_n === 'TK-MAINUP') expect((await r).text).toBe(`The main at main.invalid:15432 still answers as the main, so this copy was not promoted. Hand it over from its own manager (that loses nothing), or stop it first; nothing was changed. ${TK_PUSHED}`);
    else if (_n === 'TK-MAINUP-P') expect((await r).text).toBe(`The main at main.invalid:15432 still answers as the main, so this copy, which was promoted outside the manager, was not made the main; nothing was changed. Both databases accept writes now. Stop the old main's bot and database in its manager, then press Take over again; or remove this copy and add it again, which deletes every change made to it since it was promoted. ${TK_PUSHED}`);
    else await refusedWithPushed(r, first);
    expect(stored('c').fleetDbReplica.takeover).toBeUndefined();
    expect(h.events).not.toContain('hba-block');
    expect(h.events).not.toContain('promote');
    expect(h.events).not.toContain('raise');
  });
  it('T70 (D67): the flag on a planned take-over with an intent in recovery: the lift and the withdrawal', async () => {
    markRow('11111');
    fake.dbs['c-pg'].hbaFileBlock = true;
    fake.dbs['c-pg'].hbaLive = true;
    writeRegistry({ c: copyFixture({ fleetDbReplica: { ...copyFixture().fleetDbReplica as object, takeover: { startedAt: 'x', planned: true, generation: 4 } } }) });
    const r = await takeOverMain('c', { confirm: true, confirmUnchecked: true });
    expect(r.text).toBe(`${TK_PUSHED} The unfinished take-over recorded here was withdrawn: this copy was never promoted.`);
    expect(fake.dbs['c-pg'].hbaLive).toBe(false);
    expect(stored('c').fleetDbReplica.takeover).toBeUndefined();
    expect(h.events).not.toContain('promote');
  });
  it('T59 (D61): the generation read fails: TK-COPYDOWN, nothing changed', async () => {
    fake.dbs['c-pg'].fail['gen-read'] = 'psql: error: connection refused';
    const r = await takeOverMain('c');
    expect(r).toMatchObject({ success: false, status: 409 });
    expect(r.text).toMatch(/^The copy's database did not answer \(.*connection refused\); start the instance and try again; nothing was changed$/);
    nothingRan();
  });
  it('T56 (D58): unplanned, adopt returns with Enable failed: U-NOREPL in place of U-FOLLOW', async () => {
    fake.dbs['c-pg'].handover = null;
    const spy = vi.spyOn(fleetReplica, 'adoptPromotedReplica').mockImplementation((async (inst: { id: string }, opts: any) => {
      const r = containerManager.adoptFleetDbReplicaAsPrimary(inst.id, undefined, opts.restoreNotice, opts.formerMain);
      return r.success ? { success: false, flipped: true, error: 'Enable failed' } : r;
    }) as any);
    const r = await takeOverMain('c', { confirm: true, start: false });
    spy.mockRestore();
    expect(r.text).toContain(" Replication is not enabled here, so this manager checks the old main every 5 minutes but cannot add this machine to its copy list, and the old main's manager does not learn of this switch: if the old main runs again, choose Off for the bot in its manager.");
    expect(r.text).not.toContain(U_FOLLOW);
    expect(stored('c').fleetDb.formerMain).toBeDefined();
  });
});
