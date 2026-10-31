import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-handover-'));
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
import { handOver, SWITCH_TIMING, takeOverMain } from '../../src/instance/fleetSwitch';
import { claimFleetBackupBusy, releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import * as containerManager from '../../src/docker/containerManager';
import { copyFixture, fake, freshDb, h, mainFixture, resetHarness, scripts, seedDbs, stored, writeRegistry } from './switch-harness';

const NOTHING = '; nothing was changed';
const S_HANDOVER = "The main database on this machine is stopped, and the live copy on copy.example holds every change it had. Open copy.example's manager and press Take over in the bot's Database window. This machine rejoins as a copy of copy.example by itself once copy.example is the main; until then its database stays stopped, unless you Cancel the hand-over.";

beforeEach(() => {
  resetHarness();
  seedDbs();
  writeRegistry({ a: mainFixture() });
  SWITCH_TIMING.catchUpMs = 60;
  SWITCH_TIMING.pollMs = 5;
  releaseFleetBackupBusy('a');
});
afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

const go = (slot = 'slot_c', confirm = false) => handOver('a', slot, confirm);
const destructive = () => h.events.filter(e => e.startsWith('stop-bot') || e === 'db-stop');

describe('O1 Hand over', () => {
  it('H1: every step ok with the app running: mark stopped, project down, row on the main', async () => {
    const r = await go();
    expect(r).toEqual({ success: true, text: S_HANDOVER });
    expect(stored('a').fleetDb.handover).toMatchObject({ mode: 'stream', slot: 'slot_c', machine: 'copy.example', host: 'copy.example', port: 5434, generation: 4, phase: 'stopped' });
    expect(fake.dbs['a-pg'].handover).toEqual({ slot: 'slot_c', machine: 'copy.example', generation: 4 });
    expect(h.events).toContain('stop-bot:handover');
    const order = ['require-maintenance', 'fence-read', 'stop-bot:handover'].map(e => h.events.indexOf(e));
    expect(order).toEqual([...order].sort((x, y) => x - y));
  });

  const admit = (name: string, over: Record<string, unknown>, text: string) => [name, over, text] as const;
  it.each([
    admit('no managed main', { fleetDb: undefined }, `This instance holds no main database, so there is nothing to hand over${NOTHING}`),
    admit('replication off', { fleetDb: { containerName: 'a-pg', user: 'app', db: 'app', volume: 'v' } }, `Replication is not enabled on this database, so no copy follows it; enable it and add a live copy first${NOTHING}`),
    admit('copy here', { fleetDbReplica: { containerName: 'x', volume: 'y', slot: 's', primaryHost: 'p', primaryPort: 1, certHost: 'x' } }, `This instance also holds a live copy; remove it before handing over the main${NOTHING}`),
    admit('seed record', { fleetDbReplicaSeed: { purpose: 'provision', phase: 'seeding', startedAt: 1, updatedAt: 1, primaryHost: 'p', primaryPort: 1, slot: 's' } }, `A live copy seed is recorded on this instance; wait for it or dismiss it first${NOTHING}`),
    admit('receive', { receive: { startedAt: 'x', expiresAt: 'y', safetyDump: 'z' } }, `This database is waiting to receive a main from another machine; Stop receiving first${NOTHING}`),
    admit('replaced', { replacedBy: { machine: 'b', host: 'b', port: 1, generation: 5, own: 3, since: null, at: 'x' } }, `Another database replaced this one as the main; rejoin this machine as a copy instead${NOTHING}`),
    admit('conflict', { mainConflict: { machine: 'b', host: 'b', port: 1, generation: 3, at: 'x' } }, `Two databases accept writes as the main; choose one first${NOTHING}`),
    admit('a push mark', { handover: { mode: 'push', machine: 'srv', phase: 'pushing', at: 'x' } }, `A move of this database is already recorded (a push to srv); finish it or Cancel it first${NOTHING}`),
    admit('a file mark', { handover: { mode: 'file', phase: 'done', at: 'x', file: 'f.dump' } }, `A move of this database is already recorded (a backup made for a move); finish it or Cancel it first${NOTHING}`),
    admit('an unfinished push (G20)', { pushBroken: { at: '2026-10-30T10:00:00.000Z', safetyDump: 'pre-receive-x.dump' } }, `A push into this database did not finish; restore the dump pre-receive-x.dump or receive a push again first${NOTHING}`),
  ])('H2: %s', async (_n, over, text) => {
    const { fleetDb: db, ...rest } = over as any;
    const MARKS = ['receive', 'replacedBy', 'mainConflict', 'handover', 'pushBroken'];
    const fleetDb = 'fleetDb' in over ? db : { ...mainFixture().fleetDb as object, ...Object.fromEntries(Object.entries(rest).filter(([k]) => MARKS.includes(k))) };
    const inst = Object.fromEntries(Object.entries(rest).filter(([k]) => !MARKS.includes(k)));
    writeRegistry({ a: mainFixture({ ...inst, fleetDb }) });
    const before = fs.readFileSync(`${tmp.dir}/instances.json`, 'utf-8');
    expect(await go()).toEqual({ success: false, text, status: 409 });
    expect(fs.readFileSync(`${tmp.dir}/instances.json`, 'utf-8')).toBe(before);
    expect(destructive()).toEqual([]);
  });

  it('H2: the backup slot taken, and shutting down', async () => {
    claimFleetBackupBusy('a');
    expect((await go()).text).toBe(`A backup or restore operation is in progress on this database; wait for it to finish${NOTHING}`);
    releaseFleetBackupBusy('a');
  });

  it('H3: each maintenance guard text', async () => {
    h.proof = { ok: false, error: 'This bot is not in maintenance; put it into Maintenance or Off first' };
    expect(await go()).toEqual({ success: false, status: 409, text: 'The hand-over was refused and nothing was changed: This bot is not in maintenance; put it into Maintenance or Off first' });
    expect(stored('a').fleetDb.handover).toBeUndefined();
  });

  it.each([
    ['H4', { state: 'no', guilds: 1, files: 0 }, /^The bot reports changes it could not save \(1 guild\(s\), 0 file\(s\)\)/],
    ['H5', { state: 'unknown' }, /^The bot could not confirm that it saved every change it holds/],
    ['H6', undefined, /^The bot did not answer the maintenance order \(it did not answer\)/],
  ])('%s: held %j refuses', async (_id, held, text) => {
    h.proof = { ok: true, state: 'maintenance', enforcement: 'database', botConfirmed: true, ...(held ? { held } : {}) } as any;
    const r = await go();
    expect(r.success).toBe(false);
    expect(r.text).toMatch(text);
    expect(stored('a').fleetDb.handover).toBeUndefined();
  });

  it('H7 and H8: held stopped asks, and goes with confirm', async () => {
    h.proof = { ok: true, state: 'off', enforcement: 'database', botConfirmed: false, held: { state: 'stopped' } };
    const asked = await go();
    expect(asked).toMatchObject({ success: false, needsConfirm: true });
    expect(asked.text).toMatch(/Hand over anyway\?$/);
    expect(stored('a').fleetDb.handover).toBeUndefined();
    expect(await go('slot_c', true)).toEqual({ success: true, text: S_HANDOVER });
  });

  it('H9: held not-running with no app stops the database alone', async () => {
    h.proof = { ok: true, state: 'off', enforcement: 'database', botConfirmed: false, held: { state: 'not-running' } };
    h.app = false;
    expect((await go()).success).toBe(true);
    expect(h.events).toContain('db-stop');
    expect(h.events).not.toContain('stop-bot:handover');
  });

  it('H10: the slot is absent', async () => {
    expect((await go('slot_x')).text).toBe(`No copy uses the slot slot_x any more; reload the Database window and pick a copy that is streaming${NOTHING}`);
  });

  it('H11: the slot inactive, or not streaming', async () => {
    fake.dbs['a-pg'].slots.slot_c = { active: false, state: '', replay: '0/1' };
    expect((await go()).text).toBe(`The copy copy.example is not streaming from this database now (not connected), so it cannot prove it holds every change; start it on its machine and try again${NOTHING}`);
    fake.dbs['a-pg'].slots.slot_c = { active: true, state: 'catchup', replay: '0/1' };
    expect((await go()).text).toMatch(/\(catchup\)/);
  });

  it('H12: a copy with no address row hands over with T-ALONE-A', async () => {
    fake.dbs['a-pg'].addresses = [];
    const r = await go();
    expect(r.success).toBe(true);
    expect(r.text).toContain("The copy on slot_c has no address for other machines, so after it takes over it is the main only while it runs alone, and this machine cannot rejoin it as a copy; move back later with Push from that machine.");
  });

  it('H13: the target read fails', async () => {
    fake.dbs['a-pg'].fail['slot-read'] = 'psql: error: connection refused';
    expect((await go()).text).toBe(`The manager could not read this database's copies (connection refused)${NOTHING}`);
  });

  it('H14: the intent write throws', async () => {
    h.failSwitchWrite = 'disk full';
    expect(await go()).toEqual({ success: false, status: 409, text: 'The hand-over could not be recorded (disk full), so nothing was changed' });
    expect(fake.dbs['a-pg'].handover).toBeNull();
  });

  it('H15: the row write fails: undone, mark cleared', async () => {
    fake.dbs['a-pg'].fail['handover-row'] = 'ERROR:  disk full';
    expect((await go()).text).toBe('The hand-over row could not be written (ERROR:  disk full); the hand-over was undone and nothing else was changed');
    expect(stored('a').fleetDb.handover).toBeUndefined();
    expect(destructive()).toEqual([]);
  });

  it('H16 and H17: the copy reaches L, or not within the bound', async () => {
    let n = 0;
    SWITCH_TIMING.catchUpMs = 2000;
    fake.dbs['a-pg'].slots.slot_c.replay = '0/4000000';
    fake.dbs['a-pg'].onSlotRead = () => { if (++n > 3) fake.dbs['a-pg'].slots.slot_c.replay = '0/5000000'; };
    expect((await go()).success).toBe(true);
    resetHarness();
    seedDbs();
    writeRegistry({ a: mainFixture() });
    SWITCH_TIMING.catchUpMs = 60;
    fake.dbs['a-pg'].slots.slot_c.replay = '0/4FFFFF0';
    fake.dbs['a-pg'].onSlotRead = () => { if (h.events.includes('handover-delete')) fake.dbs['a-pg'].slots.slot_c.replay = '0/5000000'; };
    const r = await go();
    expect(r.text).toMatch(/^The copy copy\.example did not reach this database's position within 0 seconds \(16 bytes behind, streaming\); the hand-over was undone/);
    expect(stored('a').fleetDb.handover).toBeUndefined();
    expect(fake.dbs['a-pg'].handover).toBeNull();
    expect(destructive()).toEqual([]);
  });

  it('H18: the login opens during the wait', async () => {
    h.login = [{ inRecovery: false, canLogin: true, sessions: 0 }];
    expect((await go()).text).toBe("The bot's database login read open during the hand-over, so it was undone. Choose Maintenance again, then hand over.");
    expect(stored('a').fleetDb.handover).toBeUndefined();
  });
  it('H18: sessions of the bot role appear during the wait', async () => {
    h.login = [{ inRecovery: false, canLogin: false, sessions: 2 }];
    expect((await go()).text).toBe("2 session(s) of the bot's database role appeared during the hand-over, so it was undone. Choose Maintenance again, then hand over.");
    expect(stored('a').fleetDb.handover).toBeUndefined();
  });

  it('H32: the undo deletes the row with its WAL position, and returns to service only after the copy replays it', async () => {
    h.login = [{ inRecovery: false, canLogin: true, sessions: 0 }];
    fake.dbs['a-pg'].deleteLsn = '0/5000010';
    let reads = 0;
    fake.dbs['a-pg'].onSlotRead = () => { if (h.events.includes('handover-delete') && ++reads === 3) fake.dbs['a-pg'].slots.slot_c.replay = '0/5000010'; };
    SWITCH_TIMING.catchUpMs = 2000;
    const r = await go();
    expect(r.text).toBe("The bot's database login read open during the hand-over, so it was undone. Choose Maintenance again, then hand over.");
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(stored('a').fleetDb.handover).toBeUndefined();
    expect(fake.dbs['a-pg'].handover).toBeNull();
    const del = scripts('a-pg').find(s => s.startsWith('DELETE FROM smdb_manager.handover;'));
    expect(del).toContain('SELECT pg_current_wal_lsn();');
  });

  const UNSEEN = (cause: string, behind: string) => `${cause}; the hand-over row was deleted here, but the copy copy.example has not confirmed that it dropped it (${behind} bytes behind, streaming), so the hand-over stays recorded and the bot's login stays blocked: back in service, this database could be taken over by copy.example as if every change were there. Press Hand over again once the copy streams, or Cancel the hand-over.`;
  it.each([
    ['H15', () => { fake.dbs['a-pg'].fail['handover-row'] = 'ERROR:  disk full'; fake.dbs['a-pg'].handover = { slot: 'slot_c', machine: 'copy.example', generation: 3 }; }, 'The hand-over row could not be written (ERROR:  disk full)'],
    ['H17', () => { fake.dbs['a-pg'].slots.slot_c.replay = '0/4FFFFF0'; fake.dbs['a-pg'].deleteLsn = '0/5000000'; }, "The copy copy.example did not reach this database's position within 0 seconds"],
  ])('H33: %s, and the copy does not replay the delete: the mark stays waiting and nothing returns to service', async (_id, set, cause) => {
    fake.dbs['a-pg'].deleteLsn = '0/5000010';
    set();
    const r = await go();
    expect(r).toEqual({ success: false, status: 409, text: UNSEEN(cause, '16') });
    expect(stored('a').fleetDb.handover).toMatchObject({ mode: 'stream', slot: 'slot_c', phase: 'waiting', generation: 4 });
    expect(fake.dbs['a-pg'].handover).toBeNull();
    expect(h.events).not.toContain('open');
    expect(destructive()).toEqual([]);
  });

  const UNSEEN_LOGIN = (cause: string, sentence: string) => `${cause}; the hand-over row was deleted here, but the copy copy.example has not confirmed that it dropped it (16 bytes behind, streaming), so the hand-over stays recorded and this database must not return to service: copy.example could take it over as if every change were there. ${sentence} Press Hand over again once the copy streams, or Cancel the hand-over.`;
  const OPEN_SENTENCE = "This lane did not block the login again; the manager's maintenance check blocks it at its next pass (every 30 seconds), since the bot's state is Maintenance or Off and cannot change while the hand-over is recorded.";
  const UNREAD_SENTENCE = "The manager can't confirm whether the bot's login is blocked now.";
  it.each([
    ['open', { inRecovery: false, canLogin: true, sessions: 0 }, "The bot's database login read open during the hand-over", OPEN_SENTENCE],
    ['sessions', { inRecovery: false, canLogin: false, sessions: 1 }, "1 session(s) of the bot's database role appeared during the hand-over", "The login itself read blocked; this lane did not end those sessions."],
  ])('H34 (D55): the login reads %s and the copy does not replay the delete: UNDO-UNSEEN-LOGIN, the mark stays waiting', async (_n, login, cause, sentence) => {
    fake.dbs['a-pg'].deleteLsn = '0/5000010';
    h.login = [login as any];
    const r = await go();
    expect(r).toEqual({ success: false, status: 409, text: UNSEEN_LOGIN(cause as string, sentence as string) });
    expect(r.text).not.toContain('stays blocked');
    expect(stored('a').fleetDb.handover).toMatchObject({ mode: 'stream', slot: 'slot_c', phase: 'waiting', generation: 4 });
    expect(fake.dbs['a-pg'].handover).toBeNull();
    expect(destructive()).toEqual([]);
  });
  it.each([
    ['the read fails', { fail: 'connection refused' }, 'connection refused'],
    ['the role is missing', { inRecovery: false, canLogin: null, sessions: 0 }, "the bot's role was not found"],
  ])('H35 (D55): %s during the wait: replayed -> HV-LOGINREAD and the mark cleared; not replayed -> UNDO-UNSEEN-LOGIN', async (_n, login, error) => {
    h.login = login as any;
    expect((await go()).text).toBe(`The manager could not read the bot's database login during the hand-over (${error}), so it was undone. Choose Maintenance again, then hand over.`);
    expect(stored('a').fleetDb.handover).toBeUndefined();
    resetHarness();
    seedDbs();
    writeRegistry({ a: mainFixture() });
    releaseFleetBackupBusy('a');
    h.login = login as any;
    fake.dbs['a-pg'].deleteLsn = '0/5000010';
    const r = await go();
    expect(r.text).toBe(UNSEEN_LOGIN(`The manager could not read the bot's database login during the hand-over (${error})`, UNREAD_SENTENCE));
    expect(stored('a').fleetDb.handover).toMatchObject({ phase: 'waiting' });
  });

  it('H19: the undo fails too', async () => {
    h.login = [{ inRecovery: false, canLogin: false, sessions: 1 }];
    fake.dbs['a-pg'].fail['handover-delete'] = 'ERROR:  read-only';
    const r = await go();
    expect(r.text).toMatch(/ Undoing it failed too \(ERROR: {2}read-only\), so the hand-over stays recorded: press Hand over again, or Cancel the hand-over\.$/);
    expect(stored('a').fleetDb.handover).toMatchObject({ phase: 'waiting' });
  });

  it('H20: the stop fails, or the database still runs', async () => {
    h.stop = { success: false, error: 'compose failed' };
    expect((await go()).text).toBe('The copy holds every change, but this database did not stop (compose failed), so the hand-over is not finished. Press Hand over again to retry the stop, or Cancel the hand-over.');
    expect(stored('a').fleetDb.handover).toMatchObject({ phase: 'waiting' });
    expect(fake.dbs['a-pg'].handover).not.toBeNull();
  });

  it('H21: the phase write throws after the stop', async () => {
    let writes = 0;
    const real = containerManager.updateInstanceFleetDbSwitch;
    const spy = vi.spyOn(containerManager, 'updateInstanceFleetDbSwitch').mockImplementation((id, p) => { if (++writes === 2) throw new Error('disk full'); return real(id, p); });
    const r = await go();
    spy.mockRestore();
    expect(r.text).toBe(`${S_HANDOVER} The manager could not record this (disk full); press the same button again to finish recording it.`);
    expect(stored('a').fleetDb.handover).toMatchObject({ phase: 'waiting' });
  });

  it('H22 to H25 and H23: a waiting mark with the same slot resumes, restarting a stopped database first', async () => {
    writeRegistry({ a: mainFixture({ fleetDb: { ...mainFixture().fleetDb as object, handover: { mode: 'stream', slot: 'slot_c', machine: 'copy.example', generation: 4, phase: 'waiting', at: 'x' } } }) });
    h.sidecar['a-pg'] = false;
    const r = await go();
    expect(r.success).toBe(true);
    expect(h.events[0]).toBe('db-start:override');
    expect(stored('a').fleetDb.handover.phase).toBe('stopped');
  });

  it('H27: resume naming another slot', async () => {
    writeRegistry({ a: mainFixture({ fleetDb: { ...mainFixture().fleetDb as object, handover: { mode: 'stream', slot: 'slot_c', machine: 'copy.example', generation: 4, phase: 'waiting', at: 'x' } } }) });
    fake.dbs['a-pg'].slots.slot_d = { active: true, state: 'streaming', replay: '0/5000000' };
    expect((await go('slot_d')).text).toBe(`A hand-over to copy.example is recorded; press Hand over with that copy, or Cancel the hand-over${NOTHING}`);
  });

  it('H26: Hand over while one runs', async () => {
    const first = go();
    const second = await go();
    expect(second.text).toBe(`Operation 'handover' is running on this bot; wait for it to finish${NOTHING}`);
    await first;
  });

  it.each([
    ['the registry', 'reg'], ['memory only', 'mem'], ['both, memory named', 'both'],
  ])('H29: a restore notice in %s refuses', async (_n, where) => {
    for (const doubt of [true, false, undefined]) {
      const notice = { file: 'reg.dump', text: 'x', at: '2026-10-28T00:00:00.000Z', ...(doubt === undefined ? {} : { doubt }) };
      writeRegistry({ a: mainFixture(where === 'mem' ? {} : { fleetRestoreError: notice }) });
      h.memoryNotice = where === 'reg' ? null : 'mem.dump';
      const file = where === 'reg' ? 'reg.dump' : 'mem.dump';
      expect((await go()).text).toBe(`A restore of ${file} has not finished cleanly (its notice is on the Database window), so the hand-over was refused and nothing was changed: the database would move in that state. Restore a dump again, or dismiss the notice, first.`);
      expect(h.events).toEqual([]);
    }
  });

  it('H30: the read-only layer on, owned or not', async () => {
    h.fence = { ok: true, on: true, owner: 'restore:1', persisted: true };
    expect((await go()).text).toBe("The bot's database is READ-ONLY under a write fence of a restore (started 1970-01-01 00:00 UTC), so the hand-over was refused and nothing was changed; with the bot in Maintenance or Off, run a restore again to lift the fence");
    h.fence = { ok: true, on: true, owner: null, persisted: true };
    expect((await go()).text).toBe("The bot's database is READ-ONLY, and this manager cannot tell which step left it so. The hand-over was refused and nothing was changed");
    expect(stored('a').fleetDb.handover).toBeUndefined();
  });

  it('H31: the read-only read fails', async () => {
    h.fence = { ok: false, cls: 'other', error: 'connection refused' };
    expect((await go()).text).toBe("The manager could not read whether the bot's database is READ-ONLY (connection refused), so the hand-over was refused and nothing was changed");
  });

  it('the generation row is ensured and the target is ownGeneration + 1, the restore floor counted', async () => {
    fake.dbs['a-pg'].restoreState = { pending: false, file: 'x.dump', at: 'x', generation: 6, machine: 'm', since: null };
    expect((await go()).success).toBe(true);
    expect(fake.dbs['a-pg'].handover?.generation).toBe(7);
    expect(scripts('a-pg').some(s => s.includes('IF NOT pg_is_in_recovery()'))).toBe(false);
  });
});

describe('H28: shutdown during the lane', () => {
  it('the shutdown wait names the hand-over while it runs and ends when the lane does, inside its bound', async () => {
    const { waitForInFlightLanes, inFlightLaneBlocker } = await import('../../src/instance/fleetBackup');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    // The lane is held at its first catch-up read until the row has read the blocker.
    fake.dbs['a-pg'].beforeAnswer = sql => {
      if (!sql.includes('pg_replication_slots') || sql.includes("'addr|'")) return;
      held = true;
      return gate;
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const lane = go();
    await vi.waitFor(() => expect(held).toBe(true));
    expect(inFlightLaneBlocker()).toBe('a database dump, restore or replication change is running on A');
    const t0 = Date.now();
    const waiting = waitForInFlightLanes(10_000, 5);
    release();
    const left = await waiting;
    log.mockRestore();
    expect(left).toBeNull();
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(await lane).toEqual({ success: true, text: S_HANDOVER });
    expect(stored('a').fleetDb.handover.phase).toBe('stopped');
  });
});

describe('H36 to H39 (D66): Hand over removes a receive mark no record stands for before its intent', () => {
  const HV_MARK = (e: string) => `A receive mark that no receive or unfinished push on this machine stands for could not be removed (${e}), and copy.example would refuse to take over while it stands, so the hand-over was refused; nothing was changed`;
  const STALE = '[Switch] A: removed a receive mark that no receive or unfinished push on this machine stands for';
  const leftOver = () => { fake.dbs['a-pg'].receiveMark = { markId: 'a1', pushIds: ['a1'], dbOid: '16384' }; };
  /** Each registry save as 'save', and the hand-over row's write as 'handover-row', in h.events. */
  const trackWrites = () => {
    const real = containerManager.updateInstanceFleetDbSwitch;
    const spy = vi.spyOn(containerManager, 'updateInstanceFleetDbSwitch').mockImplementation(((id: string, patch: any) => {
      h.events.push(patch?.handover ? `save:${patch.handover.phase}` : 'save');
      return real(id, patch);
    }) as any);
    fake.dbs['a-pg'].beforeAnswer = sql => { if (sql.includes('INSERT INTO smdb_manager.handover')) h.events.push('handover-row'); };
    return () => spy.mockRestore();
  };

  it('H39b: the left-over mark is removed and the intent write then fails: the reply says the mark was removed', async () => {
    leftOver();
    h.failSwitchWrite = 'disk full';
    expect(await go()).toEqual({ success: false, status: 409, text: 'The hand-over could not be recorded (disk full); a left-over receive mark was removed before it, and nothing else was changed' });
    expect(fake.dbs['a-pg'].receiveMark).toBeNull();
    expect(fake.dbs['a-pg'].handover).toBeNull();
  });

  it('H36 (F4-1): the row is read and removed by its id before the intent and the row; the copy given that state takes over', async () => {
    leftOver();
    const done = trackWrites();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const r = await go();
    done();
    const logged = log.mock.calls.map(c => String(c[0]));
    log.mockRestore();
    expect(r).toEqual({ success: true, text: S_HANDOVER });
    expect(fake.dbs['a-pg'].receiveMark).toBeNull();
    const clear = fake.calls.find(c => c.input.includes('DELETE FROM smdb_manager.receive_mark'));
    expect(clear?.input).toContain("mark_id = 'a1'");
    expect(clear?.args[clear.args.indexOf('-d') + 1]).toBe('postgres');
    const at = (e: string) => h.events.indexOf(e);
    expect(at('mark-read')).toBeGreaterThan(-1);
    expect(at('mark-read')).toBeLessThan(at('mark-clear'));
    expect(at('mark-clear')).toBeLessThan(at('save:waiting'));
    expect(at('mark-clear')).toBeLessThan(at('handover-row'));
    expect(logged).toContain(STALE);

    const main = fake.dbs['a-pg'];
    fake.dbs['c-pg'] = freshDb({ recovery: true, generation: { ...main.generation! }, handover: main.handover && { ...main.handover }, receiveMark: main.receiveMark, dbOid: '20000' });
    writeRegistry({ a: stored('a'), c: copyFixture() });
    const t = await takeOverMain('c', { start: false });
    expect(t.success).toBe(true);
    expect(fake.dbs['c-pg'].recovery).toBe(false);
    expect(fake.dbs['c-pg'].generation).toMatchObject({ generation: 4, machine: 'copy.example' });
  });

  it.each([
    ['the mark read fails', () => { leftOver(); fake.dbs['a-pg'].fail['mark-read'] = 'ERROR:  canceling statement due to statement timeout'; }, 'ERROR:  canceling statement due to statement timeout'],
    ['the mark does not parse', () => { fake.dbs['a-pg'].receiveMark = { markId: 'zz', pushIds: ['zz'], dbOid: '1' }; }, "the receive mark answered 'zz|zz|1'"],
    ['the removal fails', () => { leftOver(); fake.dbs['a-pg'].fail['mark-clear'] = 'ERROR:  permission denied for table receive_mark'; }, 'ERROR:  permission denied for table receive_mark'],
  ])('H37: %s: HV-MARK, nothing changed', async (_n, set, error) => {
    set();
    const done = trackWrites();
    const r = await go();
    done();
    expect(r).toEqual({ success: false, status: 409, text: HV_MARK(error) });
    expect(stored('a').fleetDb.handover).toBeUndefined();
    expect(h.events.some(e => e.startsWith('save'))).toBe(false);
    expect(h.events).not.toContain('handover-row');
    expect(fake.dbs['a-pg'].handover).toBeNull();
    expect(destructive()).toEqual([]);
  });

  it.each([
    ['no receive_mark table', () => { fake.dbs['a-pg'].markTable = false; }],
    ['no row', () => undefined],
  ])('H38: %s: nothing removed, as H1', async (_n, set) => {
    set();
    const r = await go();
    expect(r).toEqual({ success: true, text: S_HANDOVER });
    expect(h.events).toContain('mark-read');
    expect(h.events).not.toContain('mark-clear');
    expect(fake.dbs['a-pg'].handover).toEqual({ slot: 'slot_c', machine: 'copy.example', generation: 4 });
  });

  it('H39: a waiting resume with the database stopped and a row standing: the start, then the read and the removal, then as H1', async () => {
    writeRegistry({ a: mainFixture({ fleetDb: { ...mainFixture().fleetDb as object, handover: { mode: 'stream', slot: 'slot_c', machine: 'copy.example', generation: 4, phase: 'waiting', at: 'x' } } }) });
    h.sidecar['a-pg'] = false;
    leftOver();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const r = await go();
    log.mockRestore();
    expect(r).toEqual({ success: true, text: S_HANDOVER });
    const at = (e: string) => h.events.indexOf(e);
    expect(h.events[0]).toBe('db-start:override');
    expect(at('mark-read')).toBeGreaterThan(0);
    expect(at('mark-read')).toBeLessThan(at('mark-clear'));
    expect(at('mark-clear')).toBeLessThan(at('stop-bot:handover'));
    expect(fake.dbs['a-pg'].receiveMark).toBeNull();
    expect(stored('a').fleetDb.handover.phase).toBe('stopped');
  });
});
