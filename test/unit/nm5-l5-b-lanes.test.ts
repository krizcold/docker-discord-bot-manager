import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-l5-b-'));
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
import { cancelMove, handOverMain, resetSwitchState, switchTick, switchView, SWITCH_TIMING, takeOver } from '../../src/instance/fleetSwitch';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import * as containerManager from '../../src/docker/containerManager';
import * as maintenance from '../../src/instance/maintenance';
import * as envManager from '../../src/env/manager';
import * as appHook from '../../src/instance/appHookClient';
import * as fleetJoin from '../../src/instance/fleetJoin';
import { COPY_PEM, copyFixture, COPY, ENV, fake, freshDb, h, mainFixture, resetHarness, SETTLED, seedDbs, stored, writeRegistry } from './switch-harness';

const NOTHING = '; nothing was changed';
const S_HANDOVER = "The main database on this machine is stopped, and the live copy on copy.example holds every change it had. Open copy.example's manager and press Take over in the bot's Database window. This machine rejoins as a copy of copy.example by itself once copy.example is the main; until then its database stays stopped, unless you Cancel the hand-over.";
const FAULT = 'The instance registry (instances.json) cannot be read, so the bot list is unknown and every change is refused. Repair or replace instances.json (x).';

beforeEach(() => {
  resetHarness();
  seedDbs();
  writeRegistry({ a: mainFixture() });
  SWITCH_TIMING.catchUpMs = 60;
  SWITCH_TIMING.pollMs = 5;
  releaseFleetBackupBusy('a');
  releaseFleetBackupBusy('c');
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

const go = (slot = 'slot_c', confirm = false, admit?: () => void) => handOverMain('a', slot, confirm, admit);
const withMark = (mark: Record<string, unknown>, over: Record<string, unknown> = {}) => writeRegistry({ a: mainFixture({ ...over, fleetDb: { ...mainFixture().fleetDb as object, handover: mark } }) });
const quiet = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);

describe('mainAdmission and the hand-over entry', () => {
  it('a stream mark that is stopped refuses as a recorded move, not a hand-over to resume', async () => {
    withMark({ mode: 'stream', slot: 'slot_c', machine: 'copy.example', generation: 4, phase: 'stopped', at: 'x' });
    expect(await go()).toEqual({ success: false, status: 409, text: `A move of this database is already recorded (a hand-over to copy.example); finish it or Cancel it first${NOTHING}` });
  });
  it('a push mark in phase waiting on the same slot refuses as a recorded push', async () => {
    withMark({ mode: 'push', slot: 'slot_c', machine: 'srv', generation: 4, phase: 'waiting', at: 'x' });
    expect(await go()).toEqual({ success: false, status: 409, text: `A move of this database is already recorded (a push to srv); finish it or Cancel it first${NOTHING}` });
  });
  it('a waiting hand-over with no machine names another machine', async () => {
    withMark({ mode: 'stream', slot: 'slot_d', generation: 4, phase: 'waiting', at: 'x' });
    expect((await go()).text).toBe(`A hand-over to another machine is recorded; press Hand over with that copy, or Cancel the hand-over${NOTHING}`);
  });
  it('a registry fault refuses with its text', async () => {
    vi.spyOn(containerManager, 'registryFault').mockReturnValue(FAULT);
    expect(await go()).toEqual({ success: false, status: 409, text: FAULT });
    expect(h.events).toEqual([]);
  });
  it('an unknown bot is 404 Bot not found', async () => {
    expect(await handOverMain('zz', 'slot_c', false)).toEqual({ success: false, status: 404, text: 'Bot not found' });
  });
  it('a slot name that cannot be a slot refuses before any read', async () => {
    expect(await go('Bad-Slot')).toEqual({ success: false, status: 409, text: 'No copy uses the slot Bad-Slot any more; reload the Database window and pick a copy that is streaming' });
    expect(h.events).toEqual([]);
  });
  it('admit is called once the intent is recorded', async () => {
    const admit = vi.fn();
    quiet();
    expect(await go('slot_c', false, admit)).toEqual({ success: true, text: S_HANDOVER });
    expect(admit).toHaveBeenCalledTimes(1);
  });
});

describe('provenMaintenance', () => {
  it.each([
    ['missing', 'its build has no maintenance hook'],
    ['none', 'this app declares no maintenance hook'],
  ])('no held answer with hook %s names it', async (hook, reason) => {
    writeRegistry({ a: mainFixture({ maintenance: { ...SETTLED, hook } }) });
    h.proof = { ok: true, state: 'maintenance', enforcement: 'database', botConfirmed: true } as any;
    expect((await go()).text).toBe(`The bot did not answer the maintenance order (${reason}), so the manager can't confirm it saved the changes it holds; the hand-over was refused and nothing was changed. Choose Maintenance again while the bot runs, or choose Off.`);
  });
  it('a restore notice that appears after the lane checked it is not checked again by the fence step', async () => {
    const real = h.proof;
    vi.spyOn(maintenance, 'requireMaintenance').mockImplementation(async () => { h.memoryNotice = 'late.dump'; return real as any; });
    quiet();
    expect(await go()).toEqual({ success: true, text: S_HANDOVER });
  });
});

describe('the copies read', () => {
  it('a slot line whose active field is neither true nor false', async () => {
    fake.dbs['a-pg'].slots.slot_c.active = 'maybe' as any;
    expect((await go()).text).toBe(`The manager could not read this database's copies (the slot read answered 'maybe|streaming|0/5000000')${NOTHING}`);
  });
  it('a read that answers nothing, its table missing', async () => {
    fake.dbs['a-pg'].fail['slot-read'] = 'ERROR:  relation "smdb_manager.addresses" does not exist';
    expect((await go()).text).toBe(`The manager could not read this database's copies (the slot read answered '')${NOTHING}`);
  });
  it('an active slot with no state reads no state', async () => {
    fake.dbs['a-pg'].slots.slot_c = { active: true, state: '', replay: '0/5000000' };
    expect((await go()).text).toBe(`The copy copy.example is not streaming from this database now (no state), so it cannot prove it holds every change; start it on its machine and try again${NOTHING}`);
  });
  it('a blank line between the slot and the address lines is skipped', async () => {
    fake.dbs['a-pg'].slots.slot_c.replay = '0/5000000\n';
    quiet();
    expect(await go()).toEqual({ success: true, text: S_HANDOVER });
  });
  it('the address line is trimmed before the certificate is kept', async () => {
    fake.dbs['a-pg'].addresses[0].cert = `${COPY_PEM} `;
    quiet();
    expect((await go()).success).toBe(true);
    expect(stored('a').fleetDb.handover.cert).toBe(COPY_PEM);
  });
  it('an address line cut short by a newline in the host counts as no address', async () => {
    fake.dbs['a-pg'].addresses[0].host = 'copy.example|5434\nx';
    quiet();
    const r = await go();
    expect(r.success).toBe(true);
    expect(r.text.startsWith('The main database on this machine is stopped, and the live copy on slot_c holds every change it had.')).toBe(true);
  });
  it('a line after the slot line that is not an address line counts as no address', async () => {
    fake.dbs['a-pg'].slots.slot_c.replay = '0/5000000\nnode|copy.example|5434|copy.example|pem';
    const r = await go();
    expect(r.success).toBe(false);
    expect(r.text).toMatch(/^The copy slot_c did not reach this database's position/);
  });
  it('an address line with no host counts as no address', async () => {
    fake.dbs['a-pg'].addresses[0].host = '';
    quiet();
    const r = await go();
    expect(r.text.startsWith('The main database on this machine is stopped, and the live copy on slot_c holds every change it had.')).toBe(true);
  });
  it('a whitespace-only line after the slot line is dropped', async () => {
    fake.dbs['a-pg'].slots.slot_c.replay = '0/5000000\n ';
    quiet();
    expect(await go()).toEqual({ success: true, text: S_HANDOVER });
  });
  it('a certificate holding a pipe keeps it', async () => {
    fake.dbs['a-pg'].addresses[0].cert = 'pem|tail';
    quiet();
    expect((await go()).success).toBe(true);
    expect(stored('a').fleetDb.handover.cert).toBe('pem|tail');
  });
  it('the own generation read fails', async () => {
    fake.dbs['a-pg'].fail['gen-read'] = 'ERROR:  boom';
    expect((await go()).text).toBe(`The manager could not read this database's copies (ERROR:  boom)${NOTHING}`);
  });
  it('no receive mark removed: no stale-mark log line', async () => {
    const log = quiet();
    expect((await go()).success).toBe(true);
    expect(log.mock.calls.map(c => String(c[0])).filter(l => l.includes('removed a receive mark'))).toEqual([]);
  });
});

describe('the resume and the database start', () => {
  const WAITING = { mode: 'stream', slot: 'slot_c', machine: 'copy.example', generation: 4, phase: 'waiting', at: 'x' };
  it('a fresh hand-over does not start the database', async () => {
    h.sidecar['a-pg'] = true;
    quiet();
    expect((await go()).success).toBe(true);
    expect(h.events).not.toContain('db-start:override');
  });
  it('a resume with the database running does not start it', async () => {
    withMark(WAITING);
    quiet();
    expect((await go()).success).toBe(true);
    expect(h.events).not.toContain('db-start:override');
  });
  it('a resume whose database does not start', async () => {
    withMark(WAITING);
    h.sidecar['a-pg'] = false;
    h.dbStart = { success: false, error: 'compose failed' };
    expect(await go()).toEqual({ success: false, status: 409, text: 'The hand-over was refused and nothing was changed: the database did not start (compose failed)' });
  });
  it('the log line names the target and the resume', async () => {
    let log = quiet();
    await go();
    expect(log.mock.calls.map(c => String(c[0]))).toContain('[Switch] A: handed the main over to copy.example (generation 4 on take-over)');
    log.mockRestore();
    resetHarness();
    seedDbs();
    withMark(WAITING);
    log = quiet();
    await go();
    expect(log.mock.calls.map(c => String(c[0]))).toContain('[Switch] A: handed the main over to copy.example (generation 4 on take-over), resumed');
  });
});

describe('the row write and the undo', () => {
  it('the row answers no LSN: the undo deletes the row and clears the mark', async () => {
    fake.dbs['a-pg'].currentLsn = 'junk';
    fake.dbs['a-pg'].deleteLsn = '0/5000000';
    expect((await go()).text).toBe("The hand-over row could not be written (it answered 'junk'); the hand-over was undone and nothing else was changed");
    expect(stored('a').fleetDb.handover).toBeUndefined();
  });
  it('the delete answers no LSN either: the undo fails and says so', async () => {
    fake.dbs['a-pg'].currentLsn = 'junk';
    expect((await go()).text).toBe("The hand-over row could not be written (it answered 'junk'); the hand-over was undone and nothing else was changed Undoing it failed too (the delete answered 'junk'), so the hand-over stays recorded: press Hand over again, or Cancel the hand-over.");
    expect(stored('a').fleetDb.handover).toMatchObject({ phase: 'waiting' });
  });
});

describe('the catch-up wait texts', () => {
  const run = async (after: (d: any) => void) => {
    const d = fake.dbs['a-pg'];
    let n = 0;
    d.onSlotRead = () => {
      n++;
      if (h.events.includes('handover-delete')) { delete d.fail['slot-read']; d.slots.slot_c = { active: true, state: 'streaming', replay: '0/5000000' }; } else if (n === 2) after(d);
    };
    return (await go()).text;
  };
  const WITHIN = "The copy copy.example did not reach this database's position within 0 seconds";
  const TAIL = "; the hand-over was undone, and the database and the bot are as they were. Check the copy's link and try again.";
  it('the copy disconnects', async () => {
    expect(await run(d => { d.slots.slot_c = { active: false, state: '', replay: '0/4FFFFF0' }; })).toBe(`${WITHIN} (16 bytes behind, not connected)${TAIL}`);
  });
  it('the copy has no state', async () => {
    expect(await run(d => { d.slots.slot_c = { active: true, state: '', replay: '0/4FFFFF0' }; })).toBe(`${WITHIN} (16 bytes behind, no state)${TAIL}`);
  });
  it('the slot is never read', async () => {
    expect(await run(d => { d.fail['slot-read'] = 'ERROR:  boom'; })).toBe(`${WITHIN} (an unknown number of bytes behind, not read)${TAIL}`);
  });
  it('the deadline holds at equal time (Date.now frozen)', async () => {
    SWITCH_TIMING.catchUpMs = 0;
    fake.dbs['a-pg'].slots.slot_c.replay = '0/4FFFFF0';
    fake.dbs['a-pg'].onSlotRead = () => { if (h.events.includes('handover-delete')) fake.dbs['a-pg'].slots.slot_c.replay = '0/5000000'; };
    let first = true;
    fake.dbs['a-pg'].beforeAnswer = sql => {
      if (first && sql.includes('INSERT INTO smdb_manager.handover')) { first = false; vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000); }
    };
    expect((await go()).text).toBe(`${WITHIN} (16 bytes behind, streaming)${TAIL}`);
  }, 3000);
});

describe('the stop of the main', () => {
  it('a bot that is not running counts as stopped', async () => {
    h.stop = { success: false, error: 'Bot is not running' };
    quiet();
    expect(await go()).toEqual({ success: true, text: S_HANDOVER });
  });
  it('a stop with no reason', async () => {
    h.stop = { success: false };
    expect((await go()).text).toBe('The copy holds every change, but this database did not stop (no reason given), so the hand-over is not finished. Press Hand over again to retry the stop, or Cancel the hand-over.');
  });
  it('the bot stop fails: the database is not stopped too', async () => {
    h.stop = { success: false, error: 'compose failed' };
    h.dbStop = { success: false, error: 'db stop failed' };
    expect((await go()).text).toBe('The copy holds every change, but this database did not stop (compose failed), so the hand-over is not finished. Press Hand over again to retry the stop, or Cancel the hand-over.');
    expect(h.events).not.toContain('db-stop');
  });
  it('a database already down is not stopped again', async () => {
    h.sidecar['a-pg'] = false;
    quiet();
    expect(await go()).toEqual({ success: true, text: S_HANDOVER });
    expect(h.events).not.toContain('db-stop');
  });
  it.each([
    [{ success: false, error: 'db stop failed' }, 'db stop failed'],
    [{ success: false }, 'no reason given'],
  ])('the database stop fails (%j)', async (stop, reason) => {
    h.dbStop = stop;
    expect((await go()).text).toBe(`The copy holds every change, but this database did not stop (${reason}), so the hand-over is not finished. Press Hand over again to retry the stop, or Cancel the hand-over.`);
  });
  it.each([
    [true, 'it still runs after the stop'],
    [null, 'docker did not say whether it still runs'],
  ])('the stop answers ok but the database reads %s after it', async (after, reason) => {
    if (after === null) h.sidecar['a-pg'] = null;
    vi.spyOn(containerManager, 'stopFleetDbSidecar').mockResolvedValue({ success: true } as any);
    expect((await go()).text).toBe(`The copy holds every change, but this database did not stop (${reason}), so the hand-over is not finished. Press Hand over again to retry the stop, or Cancel the hand-over.`);
  });
});

describe('the stale-mark log memory', () => {
  it('a hand-over that removes a mark lets the tick log the same failure again', async () => {
    resetSwitchState();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    quiet();
    const ERR = 'ERROR:  canceling statement due to statement timeout';
    const FAIL = `[Switch] A: a receive mark that no receive or unfinished push on this machine stands for could not be removed (${ERR}); the manager tries again every minute`;
    const count = () => warn.mock.calls.filter(c => String(c[0]) === FAIL).length;
    fake.dbs['a-pg'].fail['mark-read'] = ERR;
    await switchTick(Date.now());
    expect(count()).toBe(1);
    delete fake.dbs['a-pg'].fail['mark-read'];
    fake.dbs['a-pg'].receiveMark = { markId: 'a1', pushIds: ['a1'], dbOid: '16384' };
    expect((await go()).success).toBe(true);
    writeRegistry({ a: mainFixture() });
    h.sidecar['a-pg'] = true;
    fake.dbs['a-pg'].fail['mark-read'] = ERR;
    await switchTick(Date.now() + 120_000);
    expect(count()).toBe(2);
  });
});

describe('O2 Cancel', () => {
  const MARK = { mode: 'stream', slot: 'slot_c', machine: 'copy.example', host: 'copy.example', port: 5434, cert: COPY_PEM, generation: 4, phase: 'stopped', at: '2026-10-28T12:00:00.000Z' };
  beforeEach(() => {
    fake.dbs['a-pg'].handover = { slot: 'slot_c', machine: 'copy.example', generation: 4 };
    withMark(MARK);
    h.sidecar['a-pg'] = false;
  });
  const inRecovery = () => ({ kind: 'in-recovery', systemId: '7001', timeline: 2, gen: null }) as any;

  it('a push mark with no machine names another machine', async () => {
    withMark({ mode: 'push', phase: 'pushing', at: 'x' });
    expect((await cancelMove('a', false)).text).toBe("The push to another machine did not finish here. Cancel only if another machine's manager does not show the database as received: cancelling keeps this machine's database as the main. Cancel the push?");
  });
  it('an unknown bot is 404', async () => {
    expect(await cancelMove('zz', false)).toEqual({ success: false, status: 404, text: 'Bot not found' });
  });
  it('a push mark asks with success false; a failed clear says so', async () => {
    withMark({ mode: 'push', machine: 'srv', phase: 'pushing', at: 'x' });
    expect(await cancelMove('a', false)).toEqual({ success: false, needsConfirm: true, status: 409, text: "The push to srv did not finish here. Cancel only if srv's manager does not show the database as received: cancelling keeps this machine's database as the main. Cancel the push?" });
    h.failSwitchWrite = 'disk full';
    expect(await cancelMove('a', true)).toEqual({ success: false, status: 500, text: 'The push could not be cancelled: disk full; try again.' });
  });
  it('a file mark with no file asks with success false; confirm clears the mark; a failed clear says so', async () => {
    withMark({ mode: 'file', phase: 'done', at: 'x' });
    expect(await cancelMove('a', false)).toEqual({ success: false, needsConfirm: true, status: 409, text: 'Cancel the move only if the backup  was not restored on another machine: if it was, two machines would each run the bot as the main. Cancel the move?' });
    h.failSwitchWrite = 'disk full';
    expect(await cancelMove('a', true)).toEqual({ success: false, status: 500, text: 'The move could not be cancelled: disk full; try again.' });
    h.failSwitchWrite = null;
    expect((await cancelMove('a', true)).success).toBe(true);
    expect(stored('a').fleetDb.handover).toBeUndefined();
  });
  it.each([
    ['a certificate but no host or port', { host: undefined, port: undefined }],
    ['a host and a certificate but no port', { port: undefined }],
  ])('a mark with %s is not probed', async (_n, over) => {
    withMark({ ...MARK, ...over });
    const r = await cancelMove('a', false);
    expect(r.text).toContain('(the copy registered no address)');
    expect(h.events).toEqual([]);
  });
  it('a writable target with a lower generation asks and names its generation', async () => {
    h.peer = () => ({ kind: 'writable', systemId: '7001', timeline: 2, gen: { generation: 3, machine: 'copy.example', since: null } }) as any;
    const r = await cancelMove('a', false);
    expect(r.needsConfirm).toBe(true);
    expect(r.text).toContain("can't confirm whether copy.example took over (it answers as a main with generation 3)");
  });
  it('a writable target at the generation with no since: an unknown time', async () => {
    h.peer = () => ({ kind: 'writable', systemId: '7001', timeline: 2, gen: { generation: 4, machine: 'copy.example', since: null } }) as any;
    expect((await cancelMove('a', false)).text).toBe('copy.example took over as the main on an unknown time, so the hand-over can no longer be cancelled; this machine rejoins it as a copy.');
  });
  it('the probe is made for the switch', async () => {
    h.peer = inRecovery;
    const spy = vi.spyOn(fleetJoin, 'peerProbe');
    await cancelMove('a', false);
    expect(spy.mock.calls[0][3]).toBe('switch');
  });

  const ASK = (behind: string, state: string) => `This database runs again and the hand-over row is deleted here, but the copy copy.example has not received that within 0 seconds (${behind} bytes behind, ${state}), so the hand-over is still recorded and the bot's login stays blocked. If copy.example's manager presses Take over before its copy receives the cancel, it takes over as if it held every change. If you cancel anyway, this database gets generation 4, the one that take-over would write, so both databases would hold it, and each manager blocks the bot's login on its side once it finds the other, until you choose one. Cancel the hand-over?`;
  it.each([
    ['not connected', { active: false, state: '', replay: '0/5000000' }, '16', 'not connected'],
    ['no state', { active: true, state: '', replay: '0/5000000' }, '16', 'no state'],
    ['not read', null, 'an unknown number of', 'not read'],
  ])('the replay proof texts: %s', async (_n, slot, behind, state) => {
    h.peer = inRecovery;
    fake.dbs['a-pg'].deleteLsn = '0/5000010';
    if (slot) fake.dbs['a-pg'].slots.slot_c = slot as any;
    else fake.dbs['a-pg'].fail['slot-read'] = 'ERROR:  boom';
    expect((await cancelMove('a', false)).text).toBe(ASK(behind as string, state as string));
  });
  it('the replay proof deadline holds at equal time (Date.now frozen)', async () => {
    h.peer = inRecovery;
    SWITCH_TIMING.catchUpMs = 0;
    fake.dbs['a-pg'].deleteLsn = '0/5000010';
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    expect((await cancelMove('a', false)).text).toBe(ASK('16', 'streaming'));
  }, 3000);
  it('a recorded not-owed notice logs nothing; a failed one logs its error', async () => {
    h.peer = inRecovery;
    fake.dbs['a-pg'].deleteLsn = '0/5000010';
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await cancelMove('a', true)).success).toBe(true);
    expect(err).not.toHaveBeenCalled();
    withMark(MARK);
    fake.dbs['a-pg'].handover = { slot: 'slot_c', machine: 'copy.example', generation: 4 };
    h.failSwitchWrite = 'disk full';
    await cancelMove('a', true);
    expect(err.mock.calls.map(c => String(c[0]))).toContain('[Switch] A: the manager could not record that this cancel owes no switch notice (disk full); the bot may post one for generation 4');
  });
});

describe('probeTarget in the rejoin, and switchView', () => {
  it('an unreachable certificate read is no fingerprint error', async () => {
    resetSwitchState();
    fake.dbs['a-pg'] = freshDb();
    h.sidecar['a-pg'] = false;
    withMark({ mode: 'stream', phase: 'stopped', slot: 'slot_c', machine: 'copy.example', host: 'copy.example', port: 5434, cert: COPY_PEM, generation: 4, at: '2026-10-30T09:00:00.000Z' });
    h.cert = { ok: false, kind: 'unreachable', reason: 'connection timed out', text: 'x' };
    await switchTick(Date.parse('2026-10-30T12:00:00Z'));
    expect(stored('a').fleetDb.handover.rejoinError).toBeUndefined();
    expect(stored('a').fleetDb.handover.lastCheck).toBe('connection timed out');
  });
  it('switchView names an unknown time for a mark time that does not parse', () => {
    const a = stored('a');
    expect(switchView({ ...a, fleetDb: { ...a.fleetDb, handover: { mode: 'stream', phase: 'stopped', machine: 'copy.example', host: 'copy.example', at: 'x' } } }).lines[0])
      .toBe('Handed over to copy.example on an unknown time. This machine rejoins as its copy once copy.example is the main; last check: not checked yet.');
  });
});

describe('copyAdmission', () => {
  beforeEach(() => writeRegistry({ c: copyFixture() }));
  it('an unknown bot is 404', async () => {
    expect(await takeOver('zz')).toEqual({ success: false, status: 404, text: 'Bot not found' });
  });
  it('a record with a user but no database', async () => {
    writeRegistry({ c: copyFixture({ fleetDbReplica: { ...COPY, db: undefined } }) });
    expect((await takeOver('c')).text).toBe(`This copy's record has no database identity; remove it and add it again${NOTHING}`);
  });
  it('a corrupt env store', async () => {
    vi.spyOn(envManager, 'getEnvVarsWithStatus').mockReturnValue({ vars: { ...ENV }, corrupt: true, undecryptable: [] } as any);
    expect((await takeOver('c')).text).toBe(`The env store for this instance cannot be read (a copy is kept beside it as storage.json.corrupt-<time> when it could be read); restore it before taking over${NOTHING}`);
  });
  it('a registry fault', async () => {
    vi.spyOn(containerManager, 'registryFault').mockReturnValue(FAULT);
    expect((await takeOver('c')).text).toBe(FAULT);
  });
  it('a capability refusal', async () => {
    vi.spyOn(appHook, 'capabilityRefusal').mockReturnValue('This app cannot take over');
    expect((await takeOver('c')).text).toBe(`This app cannot take over${NOTHING}`);
  });
});
