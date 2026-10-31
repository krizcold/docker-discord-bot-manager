import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-tick-'));
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
vi.mock('../../src/instance/fleetReplication', async (o) => ({
  ...(await o<typeof import('../../src/instance/fleetReplication')>()),
  getJoinCode: async () => ({ success: true, joinCode: (await import('./join-fake')).fakeJoinCode({ host: 'main.example', port: 5433 }) }),
}));

import * as fs from 'fs';

import { resetSwitchState, startFleetSwitchTick, stepNotice, stopFleetSwitchTick, switchTick, switchView, SWITCH_TIMING } from '../../src/instance/fleetSwitch';
import { utcText } from '../../src/instance/backupFiles';
import { receive } from '../../src/instance/fleetMove';
import { claimFleetBackupBusy, releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import * as containerManager from '../../src/docker/containerManager';
import { COPY_PEM, fake, freshDb, h, mainFixture, resetHarness, stored, writeRegistry } from './switch-harness';
import { COPY_FP, FIXTURE_FP, fakeJoinCode } from './join-fake';
import * as fleetJoin from '../../src/instance/fleetJoin';

const PEER = { host: 'copy.example', port: 5434, slot: 'slot_c', machine: 'copy.example', cert: COPY_PEM };
const withDb = (extra: Record<string, unknown> = {}, inst: Record<string, unknown> = {}) => writeRegistry({ a: mainFixture({ fleetDb: { ...mainFixture().fleetDb as object, ...extra }, ...inst }) });
const writable = (g: number, sys = '7001') => () => ({ kind: 'writable', systemId: sys, timeline: 2, gen: { generation: g, machine: 'copy.example', since: '2026-10-28T14:00:00Z' }, receiveMark: false }) as any;
let now = Date.parse('2026-10-28T15:00:00Z');
const RECV = { startedAt: '2026-10-28T10:00:00.000Z', expiresAt: '2026-10-28T11:00:00.000Z', safetyDump: 'pre-receive-x.dump', pushId: '0123456789abcdef01234567', dbOid: '16384' };

beforeEach(() => {
  resetHarness();
  resetSwitchState();
  releaseFleetBackupBusy('a');
  fake.dbs['a-pg'] = freshDb({ addresses: [PEER] });
  withDb();
  now += 6 * 60_000;
});
afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

describe('O10 the switch tick', () => {
  it('N1: a main without a row gets generation 1 with its machine', async () => {
    fake.dbs['a-pg'].generation = null;
    fake.dbs['a-pg'].tables = false;
    await switchTick(now);
    expect(fake.dbs['a-pg'].generation).toMatchObject({ generation: 1, machine: 'main.example' });
  });
  it('N2: a database in recovery is left alone by the DO block', async () => {
    fake.dbs['a-pg'].generation = null;
    fake.dbs['a-pg'].tables = false;
    fake.dbs['a-pg'].recovery = true;
    await switchTick(now);
    expect(fake.dbs['a-pg'].generation).toBeNull();
  });
  it('N3, N9 and N10: generation 2 or more is sent once, pending before the send; generation 1 is not', async () => {
    fake.dbs['a-pg'].generation = { generation: 1, machine: 'main.example', since: 'x' };
    await switchTick(now);
    expect(h.hookCalls).toEqual([]);
    fake.dbs['a-pg'].generation = { generation: 5, machine: 'main.example', since: '2026-10-28T14:30:00Z' };
    const pendingSeen: string[] = [];
    h.hook = () => { pendingSeen.push(stored('a').fleetDb.switchNotice.state); return { ok: true, status: 200 }; };
    await switchTick(now);
    expect(pendingSeen).toEqual(['pending']);
    expect(stored('a').fleetDb.switchNotice).toMatchObject({ generation: 5, state: 'sent' });
    await switchTick(now + 10);
    expect(h.hookCalls).toHaveLength(1);
    fake.dbs['a-pg'].generation = { generation: 6, machine: 'main.example', since: 'y' };
    await switchTick(now + 20);
    expect(h.hookCalls).toHaveLength(2);
    expect(stored('a').fleetDb.switchNotice.generation).toBe(6);
  });
  it('N4: a 404 is unsupported and never sent again for that generation', async () => {
    h.hook = () => ({ ok: false, status: 404, error: 'x' });
    await switchTick(now);
    await switchTick(now + 2 * 3600_000);
    expect(h.hookCalls).toHaveLength(1);
    expect(stored('a').fleetDb.switchNotice.state).toBe('unsupported');
  });
  it('N5 and N6: refused stays pending, no answer is unknown; both again after an hour', async () => {
    h.hook = () => ({ ok: false, status: 500, error: 'boom' });
    await stepNotice('a', now);
    expect(stored('a').fleetDb.switchNotice).toMatchObject({ state: 'pending', error: 'boom' });
    await stepNotice('a', now + 60_000);
    expect(h.hookCalls).toHaveLength(1);
    h.hook = () => ({ ok: false, unknown: true });
    await stepNotice('a', now + 3600_000);
    expect(stored('a').fleetDb.switchNotice.state).toBe('unknown');
    await stepNotice('a', now + 2 * 3600_000 + 1);
    expect(h.hookCalls).toHaveLength(3);
  });
  it('N7: the app not running: pending, waiting, no send', async () => {
    h.app = false;
    expect(await stepNotice('a', now)).toMatchObject({ state: 'pending', waiting: true });
    expect(h.hookCalls).toEqual([]);
  });
  it('N8: the pending write throws: no send', async () => {
    h.failSwitchWrite = 'disk full';
    await stepNotice('a', now);
    expect(h.hookCalls).toEqual([]);
  });
  it('N11: a peer writable with the same system id and a higher generation: blocked, ended, replacedBy, DM once with its key', async () => {
    h.peer = writable(4);
    await switchTick(now);
    expect(h.events).toEqual(expect.arrayContaining(['block', 'end-sessions']));
    expect(stored('a').fleetDb.replacedBy).toMatchObject({ machine: 'copy.example', generation: 4, own: 3 });
    expect(h.notified).toEqual([{ key: 'a:replaced:4', text: 'The main database of A moved to copy.example on 2026-10-28 14:00 UTC, and the old main on main.example is running again. Its manager blocked the bot\'s login there and stops the bot there once it holds no change it could not save; rejoin it as a copy in that machine\'s manager.' }]);
    await switchTick(now + 6 * 60_000);
    expect(h.notified).toHaveLength(1);
  });
  it('N12 and N15: a tie blocks the login and ends its sessions before the conflict is recorded, DMs once; a lower peer clears it', async () => {
    h.peer = writable(3);
    const atBlock: unknown[] = [];
    const push = h.events.push.bind(h.events);
    h.events.push = (...e: string[]) => { if (e[0] === 'block' || e[0] === 'end-sessions') atBlock.push(stored('a').fleetDb.mainConflict); return push(...e); };
    await switchTick(now);
    h.events.push = push;
    expect(atBlock).toEqual([undefined, undefined]);
    expect(stored('a').fleetDb.mainConflict).toMatchObject({ machine: 'copy.example', generation: 3 });
    expect(stored('a').fleetDb.mainConflict.blockError).toBeUndefined();
    expect(h.notified[0]).toEqual({ key: 'a:two-mains:3', text: "Two databases of A are mains with the same generation: main.example and copy.example. The manager on main.example blocked the bot's database login there; choose which one stays the main in either machine's manager (the bot's Database window)." });
    expect(switchView(stored('a')).lines[0]).toMatch(/^Two databases of A are mains with the same generation 3: this one and copy\.example \(copy\.example:5434\)\. The manager blocked the bot's database login here, so no bot writes to this database until you choose; copy\.example's manager does the same when it finds this one \(it checks every 5 minutes while it can reach it\)\. Keep this machine as the main raises this one's generation and opens the login here; or rejoin this machine as a copy of copy\.example, which replaces this database after a dump of it\./);
    h.peer = () => ({ kind: 'in-recovery', systemId: '7001', timeline: 2, gen: null }) as any;
    await switchTick(now + 6 * 60_000);
    expect(stored('a').fleetDb.mainConflict).toBeUndefined();
  });
  it('N13, N14: unreachable, refused or another system changes nothing', async () => {
    for (const p of [() => ({ kind: 'unreachable', reason: 'x' }), () => ({ kind: 'login-refused', reason: 'x' }), writable(9, '8000')]) {
      h.peer = p as any;
      await switchTick(now += 6 * 60_000);
    }
    expect(stored('a').fleetDb.replacedBy).toBeUndefined();
    expect(h.events).not.toContain('block');
  });
  it('N17: a replaced main whose login reads open is blocked again', async () => {
    withDb({ replacedBy: { machine: 'b', host: 'b', port: 1, generation: 5, own: 3, since: null, at: 'x' } });
    h.login = { inRecovery: false, canLogin: true, sessions: 0 };
    await switchTick(now);
    expect(h.events).toContain('block');
  });
  it('N18: a busy bot, a broken registry or a shutdown is skipped', async () => {
    fake.dbs['a-pg'].generation = { generation: 5, machine: 'm', since: null };
    await containerManager.withExternalBotOp('a', 'restore', async () => { await switchTick(now); });
    expect(h.hookCalls).toEqual([]);
  });
  it('N20 and N21: no row is written while a notice stands, or under the read-only layer', async () => {
    fake.dbs['a-pg'].generation = null;
    withDb({}, { fleetRestoreError: { file: 'r.dump', text: 'x', at: 'y', doubt: true } });
    await switchTick(now);
    expect(fake.dbs['a-pg'].generation).toBeNull();
    withDb();
    fake.dbs['a-pg'].readOnly = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await switchTick(now + 10);
    await switchTick(now + 20);
    expect(fake.dbs['a-pg'].generation).toBeNull();
    expect(warn.mock.calls.filter(c => String(c[0]).includes('the generation row could not be written'))).toHaveLength(1);
    warn.mockRestore();
  });
  it('N22 and N23: pending cleared with no notice and the layer off; kept otherwise', async () => {
    fake.dbs['a-pg'].restoreState = { pending: true, file: 'r.dump', at: 'x', generation: 3, machine: 'm', since: null };
    h.fence = { ok: true, on: true, owner: null, persisted: true };
    await switchTick(now);
    expect(fake.dbs['a-pg'].restoreState?.pending).toBe(true);
    h.fence = { ok: true, on: false };
    await switchTick(now + 10);
    expect(fake.dbs['a-pg'].restoreState?.pending).toBe(false);
  });
  it('N24: a live row below its floor compares with ownGeneration, so a peer at the true generation is a tie', async () => {
    fake.dbs['a-pg'].generation = { generation: 1, machine: 'm', since: null };
    fake.dbs['a-pg'].restoreState = { pending: false, file: 'r.dump', at: 'x', generation: 4, machine: 'm', since: null };
    h.peer = writable(4);
    await switchTick(now);
    expect(stored('a').fleetDb.replacedBy).toBeUndefined();
    expect(stored('a').fleetDb.mainConflict).toMatchObject({ generation: 4 });
  });
  it('V11 and V13 (N-c): a push received ends receiving; an expired code too', async () => {
    withDb({ receive: { ...RECV, expiresAt: '2026-10-29T10:00:00.000Z' } });
    fake.dbs['a-pg'].roles.smdb_receive = { password: 'p', until: 'x' };
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    fake.dbs['a-pg'].received.push({ pushId: 'ffffffffffffffffffffffff', from: '7001', machine: 'old.local', generation: 5 });
    await switchTick(now);
    expect(stored('a').fleetDb.receive).toBeDefined();
    fake.dbs['a-pg'].received.push({ pushId: RECV.pushId, from: '9', machine: 'win.local', generation: 6 });
    await switchTick(now + 10);
    expect(stored('a').fleetDb.receive).toBeUndefined();
    expect(fake.dbs['a-pg'].roles.smdb_receive).toBeUndefined();
    expect(log.mock.calls.map(c => c[0])).toContain('[Switch] A: received the main from win.local (generation 6); the receive login is removed');
    withDb({ receive: { ...RECV } });
    fake.dbs['a-pg'].received = [];
    await switchTick(now + 20);
    expect(stored('a').fleetDb.receive).toBeUndefined();
    expect(log.mock.calls.map(c => c[0])).toContain('[Switch] A: the move code expired unused; the receive login is removed');
    log.mockRestore();
  });
  it('V12: the drop fails: retried next tick', async () => {
    withDb({ receive: { ...RECV } });
    fake.dbs['a-pg'].fail.role = 'ERROR:  role is in use';
    await switchTick(now);
    expect(stored('a').fleetDb.receive).toBeDefined();
    delete fake.dbs['a-pg'].fail.role;
    await switchTick(now + 10);
    expect(stored('a').fleetDb.receive).toBeUndefined();
  });
  it('N25: posted and pinned: sent, the channel kept, never sent again; the line adds V-COPY', async () => {
    fake.dbs['a-pg'].generation = { generation: 5, machine: 'main.example', since: '2026-10-28T14:30:00Z' };
    h.hook = () => ({ ok: true, status: 200, body: { success: true, posted: true, pinned: true, channel: 'posted' } });
    await stepNotice('a', now);
    expect(stored('a').fleetDb.switchNotice).toMatchObject({ generation: 5, state: 'sent', channel: 'posted' });
    await stepNotice('a', now + 5 * 3600_000);
    expect(h.hookCalls).toHaveLength(1);
    expect(h.hookCalls[0].body).toEqual({ machine: 'main.example', generation: 5, date: '2026-10-28T14:30:00Z' });
    expect(switchView(stored('a')).lines).toContain(`The owner was sent a switch notice for generation 5 on ${utcText(now)}. A copy is in the owner messages channel.`);
  });
  it("N26: posted with a note (not pinned, or the channel copy failed): sent with the bot's note as it is", async () => {
    fake.dbs['a-pg'].generation = { generation: 5, machine: 'main.example', since: null };
    h.hook = () => ({ ok: true, status: 200, body: { success: true, posted: true, pinned: false, channel: 'failed', note: 'The copy in the owner channel failed: Missing Access' } });
    await stepNotice('a', now);
    expect(stored('a').fleetDb.switchNotice).toMatchObject({ state: 'sent', channel: 'failed', note: 'The copy in the owner channel failed: Missing Access' });
    await stepNotice('a', now + 5 * 3600_000);
    expect(h.hookCalls).toHaveLength(1);
    expect(switchView(stored('a')).lines).toContain(`The owner was sent a switch notice for generation 5 on ${utcText(now)}. The copy in the owner channel failed: Missing Access`);
  });
  it('N27: posted false: already, with the note, never sent again and never shown as sent', async () => {
    fake.dbs['a-pg'].generation = { generation: 5, machine: 'main.example', since: null };
    h.hook = () => ({ ok: true, status: 200, body: { success: true, posted: false, note: 'A notice for generation 5 was posted on 2026-10-28.', channel: 'none' } });
    await stepNotice('a', now);
    expect(stored('a').fleetDb.switchNotice).toMatchObject({ state: 'already', note: 'A notice for generation 5 was posted on 2026-10-28.' });
    await stepNotice('a', now + 5 * 3600_000);
    expect(h.hookCalls).toHaveLength(1);
    const lines = switchView(stored('a')).lines;
    expect(lines).toContain(`The bot posted no new switch notice for generation 5 on ${utcText(now)}: A notice for generation 5 was posted on 2026-10-28.`);
    expect(lines.join(' ')).not.toContain('was sent a switch notice');
  });
  it("N28: a 409 is refused with the bot's error, asked again after an hour, and replaced when the row rises", async () => {
    fake.dbs['a-pg'].generation = { generation: 5, machine: 'main.example', since: null };
    h.hook = () => ({ ok: false, status: 409, error: 'no writable database at generation 5 for main.example' });
    await stepNotice('a', now);
    expect(stored('a').fleetDb.switchNotice).toMatchObject({ state: 'refused', error: 'no writable database at generation 5 for main.example' });
    expect(switchView(stored('a')).lines).toContain('The bot did not post the switch notice for generation 5 (no writable database at generation 5 for main.example). The manager asks again every hour while this database holds that generation.');
    await stepNotice('a', now + 30 * 60_000);
    expect(h.hookCalls).toHaveLength(1);
    await stepNotice('a', now + 3600_000);
    expect(h.hookCalls).toHaveLength(2);
    fake.dbs['a-pg'].generation = { generation: 6, machine: 'main.example', since: null };
    h.hook = () => ({ ok: true, status: 200, body: { success: true, posted: true } });
    await stepNotice('a', now + 3600_000 + 10);
    expect(stored('a').fleetDb.switchNotice).toMatchObject({ generation: 6, state: 'sent' });
  });
  it("N6's line: unknown names the bot's error and says the bot posts it only once", async () => {
    fake.dbs['a-pg'].generation = { generation: 5, machine: 'main.example', since: null };
    h.hook = () => ({ ok: false, status: 502, unknown: true, error: 'Discord did not answer' });
    await stepNotice('a', now);
    expect(switchView(stored('a')).lines).toContain("Whether the switch notice for generation 5 was posted can't be confirmed (Discord did not answer); the manager asks again within an hour, and the bot posts it only if it finds no notice of that generation.");
  });
  it.each([
    ['replacedBy', { replacedBy: { machine: 'b', host: 'b', port: 1, generation: 9, own: 5, since: null, at: 'x' } }],
    ['mainConflict', { mainConflict: { machine: 'b', host: 'b', port: 1, generation: 5, at: 'x' } }],
  ])('N29: nothing is sent while %s stands, and the record stays as it was', async (_name, mark) => {
    const before = { generation: 4, machine: 'main.example', since: null, state: 'sent', triedAt: 1 };
    withDb({ ...mark, switchNotice: before });
    fake.dbs['a-pg'].generation = { generation: 5, machine: 'main.example', since: null };
    await stepNotice('a', now);
    expect(h.hookCalls.filter(c => c.action === 'switch-notice')).toEqual([]);
    expect(stored('a').fleetDb.switchNotice).toEqual(before);
  });
  it('N30: a not-owed record at the row generation sends nothing and shows no line', async () => {
    withDb({ switchNotice: { generation: 5, machine: 'a', since: null, state: 'not-owed' } });
    fake.dbs['a-pg'].generation = { generation: 5, machine: 'a', since: null };
    await switchTick(now);
    expect(h.hookCalls.filter(c => c.action === 'switch-notice')).toEqual([]);
    expect(switchView(stored('a')).lines).toEqual([]);
  });
  it('N38: the first pass 5 s after start, none before it, and none after the stop', async () => {
    vi.useFakeTimers();
    try {
      fake.dbs['a-pg'].generation = { generation: 5, machine: 'm', since: null };
      startFleetSwitchTick();
      await vi.advanceTimersByTimeAsync(4_900);
      expect(h.hookCalls).toEqual([]);
      await vi.advanceTimersByTimeAsync(200);
      await vi.waitFor(() => expect(h.hookCalls.map(c => c.action)).toContain('switch-notice'));
      const calls = h.hookCalls.length;
      stopFleetSwitchTick();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(h.hookCalls).toHaveLength(calls);
    } finally {
      vi.useRealTimers();
    }
    void SWITCH_TIMING;
    void claimFleetBackupBusy;
  });
});

describe('N31 to N37: a replaced main put in Off once it holds nothing it could not save (D36)', () => {
  const REPLACED = { machine: 'copy.example', host: 'copy.example', port: 5434, generation: 4, own: 3, since: '2026-10-28T14:00:00Z', at: '2026-10-28T14:05:00.000Z', cert: COPY_PEM, dm: { key: 'a:replaced:4', state: 'posted', place: 'dm', triedAt: 1 } };
  const rec = (state: string, over: Record<string, unknown> = {}) => ({ state, message: 'Back soon', orderedAt: '2026-10-28T00:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: 'maintenance', ...over });
  const setMaintenance = (m: Record<string, unknown>) => {
    const all = JSON.parse(fs.readFileSync(`${process.env.DATA_DIR}/instances.json`, 'utf-8'));
    all.instances.a.maintenance = m;
    fs.writeFileSync(`${process.env.DATA_DIR}/instances.json`, JSON.stringify(all, null, 2));
  };
  const replaced = (maint: Record<string, unknown>) => withDb({ replacedBy: { ...REPLACED } }, { maintenance: maint });
  const line = () => switchView(stored('a')).lines.find(l => l.startsWith('copy.example replaced this database'))!;
  const orders = () => h.events.filter(e => e.startsWith('order:'));
  it('N31: Running, then the Maintenance answer yes: Off in the same pass, logged once, the line says so', async () => {
    replaced(rec('running'));
    h.onOrder = to => setMaintenance(to === 'off' ? rec('off', { held: { state: 'yes' } }) : rec('maintenance', { held: { state: 'yes' } }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await switchTick(now);
    await switchTick(now + 60_000);
    const logs = log.mock.calls.map(c => String(c[0]));
    log.mockRestore();
    expect(orders()).toEqual(['order:maintenance', 'order:off']);
    expect(stored('a').fleetDb.replacedBy.off).toMatchObject({ state: 'off' });
    expect(logs.filter(l => l === "[Switch] A: the replaced main's bot is Off")).toHaveLength(1);
    expect(line()).toContain(` The bot is Off here: the manager stopped it on ${utcText(Date.parse(stored('a').fleetDb.replacedBy.off.at))}, after it answered that it holds no change it could not save.`);
  });
  it('N32: held no with counts: no Off, Maintenance stays; asked again after 5 minutes; Off once it answers yes', async () => {
    replaced(rec('maintenance', { held: { state: 'no', guilds: 2, files: 1 } }));
    h.onOrder = () => undefined;
    await switchTick(now);
    expect(orders()).toEqual(['order:maintenance']);
    expect(stored('a').fleetDb.replacedBy.off).toMatchObject({ state: 'held', held: { state: 'no', guilds: 2, files: 1 } });
    expect(line()).toContain(" The bot runs in Maintenance here with its login blocked: it reports 2 guild(s) and 1 file(s) of changes it could not save, and Off would drop them. It saves them on copy.example once it reaches that database; the manager asks it again every 5 minutes and puts it in Off once nothing is left. Choose Off to stop it now and drop them.");
    await switchTick(now + 4 * 60_000);
    expect(orders()).toEqual(['order:maintenance']);
    h.onOrder = to => setMaintenance(to === 'off' ? rec('off', { held: { state: 'yes' } }) : rec('maintenance', { held: { state: 'yes' } }));
    await switchTick(now + 5 * 60_000);
    expect(orders()).toEqual(['order:maintenance', 'order:maintenance', 'order:off']);
    expect(stored('a').fleetDb.replacedBy.off.state).toBe('off');
  });
  it('N33: held unknown (saved null, or a confirmed answer without saved): as N32, with the unsure line', async () => {
    replaced(rec('maintenance', { held: { state: 'unknown' } }));
    await switchTick(now);
    expect(orders()).toEqual(['order:maintenance']);
    expect(line()).toContain(" The bot runs in Maintenance here with its login blocked: it could not confirm that it saved every change it holds, and Off would drop what it holds. The manager asks it again every 5 minutes and puts it in Off once it confirms; choose Off to stop it now and drop what it holds.");
  });
  it.each(['missing', 'none'])('N34: the hook is %s: Off at once, with the no-hook line', async hook => {
    replaced(rec('maintenance', { hook, held: undefined }));
    h.onOrder = to => { if (to === 'off') setMaintenance(rec('off', { hook })); };
    await switchTick(now);
    expect(orders()).toEqual(['order:off']);
    expect(line()).toContain(" Its build has no maintenance hook, so the manager can't confirm whether it held changes it could not save; any it held were dropped at the stop.");
  });
  it('N35: the Maintenance order is not settled: failed, the login stays blocked, again next pass', async () => {
    replaced(rec('running'));
    h.order = { settled: false, text: 'The bot did not answer the maintenance order (no answer within 30 s).' };
    await switchTick(now);
    expect(stored('a').fleetDb.replacedBy.off).toMatchObject({ state: 'failed', error: 'The bot did not answer the maintenance order (no answer within 30 s).' });
    expect(line()).toContain(" The manager could not put the bot in Off yet (The bot did not answer the maintenance order (no answer within 30 s).); it tries again every minute, and the bot's database login stays blocked.");
    await switchTick(now + 60_000);
    expect(orders()).toEqual(['order:maintenance', 'order:maintenance']);
  });
  it('N36: the Off order is not settled: failed, again next pass', async () => {
    replaced(rec('maintenance', { held: { state: 'yes' } }));
    h.order = { settled: false, text: 'The stop failed (docker answered 500).' };
    await switchTick(now);
    expect(orders()).toEqual(['order:off']);
    expect(stored('a').fleetDb.replacedBy.off).toMatchObject({ state: 'failed', error: 'The stop failed (docker answered 500).' });
    await switchTick(now + 60_000);
    expect(orders()).toEqual(['order:off', 'order:off']);
  });
  it("N37 and G15: a settled Off (the tick's or the operator's) gets nothing", async () => {
    replaced(rec('off'));
    await switchTick(now);
    expect(orders()).toEqual([]);
  });
});

describe('N39 to N44: the owner messages carry a key and keep their outcome (D37)', () => {
  const tie = () => { h.peer = writable(3); };
  const replace = () => { h.peer = writable(4); };
  it.each([
    ['N39 posted', { dm: 'sent', posted: true, place: 'channel', note: 'pinned' }, { state: 'posted', place: 'channel', note: 'pinned' }, ' The owner was told on DATE (in the owner messages channel). pinned'],
    ['N40 repeat', { dm: 'sent', posted: false, note: 'This message was posted on 2026-10-28.' }, { state: 'repeat', note: 'This message was posted on 2026-10-28.' }, ' The bot had already posted this message: This message was posted on 2026-10-28.'],
    ['N41 failed', { dm: 'failed', dmError: 'Discord refused the message' }, { state: 'failed', error: 'Discord refused the message' }, ' The message to the owner was not posted (Discord refused the message); the manager tries again every hour.'],
    ['N42 unknown', { dm: 'unknown', dmError: 'notify-owner sent, no answer within 30 s' }, { state: 'unknown', error: 'notify-owner sent, no answer within 30 s' }, " Whether the message to the owner was posted can't be confirmed (notify-owner sent, no answer within 30 s); the manager sends it again within an hour, and the bot drops a repeat."],
    ['N43 no hook (404)', { dm: 'failed', dmError: 'notify-owner returned 404', notFound: true }, { state: 'unsupported' }, " This bot's build cannot message the owner, so the owner was not told."],
  ])('%s: N11 records the outcome on replacedBy, with the clause on its line', async (_n, outcome, dm, clause) => {
    replace();
    h.notifyOutcome = outcome;
    await switchTick(now);
    const r = stored('a').fleetDb.replacedBy;
    expect(r.dm).toMatchObject({ key: 'a:replaced:4', ...dm });
    expect(h.notified[0]).toEqual({ key: 'a:replaced:4', text: "The main database of A moved to copy.example on 2026-10-28 14:00 UTC, and the old main on main.example is running again. Its manager blocked the bot's login there and stops the bot there once it holds no change it could not save; rejoin it as a copy in that machine's manager." });
    expect(switchView(stored('a')).lines[0]).toContain(clause.replace('DATE', utcText(r.dm.triedAt)));
  });
  it('N39 and N40: posted or repeat is never sent again', async () => {
    replace();
    await switchTick(now);
    await switchTick(now + 2 * 3600_000);
    expect(h.notified).toHaveLength(1);
  });
  it('N41 and N42: N-i sends a failed or unknown message again after an hour with the same key', async () => {
    replace();
    h.notifyOutcome = { dm: 'unknown', dmError: 'x' };
    await switchTick(now);
    await switchTick(now + 30 * 60_000);
    expect(h.notified).toHaveLength(1);
    h.notifyOutcome = { dm: 'sent', posted: true, place: 'dm' };
    await switchTick(now + 3600_000);
    expect(h.notified.map(n => n.key)).toEqual(['a:replaced:4', 'a:replaced:4']);
    expect(stored('a').fleetDb.replacedBy.dm).toMatchObject({ state: 'posted', place: 'dm' });
  });
  it('N12 with N39: the tie message keeps its outcome on mainConflict, keyed by the generation', async () => {
    tie();
    h.notifyOutcome = { dm: 'failed', dmError: 'Discord refused' };
    await switchTick(now);
    expect(stored('a').fleetDb.mainConflict.dm).toMatchObject({ key: 'a:two-mains:3', state: 'failed', error: 'Discord refused' });
    await switchTick(now + 6 * 60_000);
    expect(h.notified).toHaveLength(1);
    expect(stored('a').fleetDb.mainConflict.dm).toMatchObject({ state: 'failed' });
    await switchTick(now + 3600_000 + 1);
    expect(h.notified).toHaveLength(2);
  });
  it('N44: after a manager restart, a posted message is not sent again and a failed one is retried', async () => {
    replace();
    await switchTick(now);
    resetSwitchState();
    await switchTick(now + 2 * 3600_000);
    expect(h.notified).toHaveLength(1);
    withDb({ replacedBy: { machine: 'copy.example', host: 'copy.example', port: 5434, generation: 4, own: 3, since: null, at: 'x', dm: { key: 'a:replaced:4', state: 'failed', error: 'x', triedAt: now } } });
    resetSwitchState();
    await switchTick(now + 3600_000);
    expect(h.notified).toHaveLength(2);
  });
});

describe('S13: N-f marks a finished restore within one tick', () => {
  const PENDING = { pending: true, file: 'old.dump', at: '2026-10-28T12:00:00Z', generation: 4, machine: 'main.example', since: null };
  it('pending true, no notice, no read-only layer: the tick sets pending false', async () => {
    fake.dbs['a-pg'].restoreState = { ...PENDING };
    await switchTick(now);
    expect(fake.dbs['a-pg'].restoreState?.pending).toBe(false);
  });
  it.each([
    ['a restore notice in memory', () => { h.memoryNotice = 'old.dump'; }],
    ['the read-only layer on', () => { h.fence = { ok: true, on: true, owner: 'restore:1', persisted: true }; }],
  ])('%s: pending stays', async (_n, set) => {
    fake.dbs['a-pg'].restoreState = { ...PENDING };
    set();
    await switchTick(now);
    expect(fake.dbs['a-pg'].restoreState?.pending).toBe(true);
  });
});

describe('N45 to N56 and V19 to V25 (the tick): receiving, two mains, the old main kept (round 1)', () => {
  const FORMER = (over: Record<string, unknown> = {}) => ({ code: fakeJoinCode({ host: 'old.example', port: 5500, machine: 'old.example' }), slot: 'slot_c', machine: 'old.example', host: 'old.example', port: 5500, generation: 2, at: '2026-10-28T12:00:00.000Z', ...over });
  const at = (host: string, p: () => any) => (h2: string) => (h2 === host ? p() : { kind: 'unreachable', reason: 'connection refused' });
  const spyOn = (level: 'log' | 'warn') => { const seen: string[] = []; return Object.assign(vi.spyOn(console, level).mockImplementation((m: unknown) => { seen.push(String(m)); }), { seen }); };
  const logs = () => spyOn('log');
  const warns = () => spyOn('warn');
  const lines = (spy: { seen: string[] }) => spy.seen;
  const ensureSent = () => fake.calls.some(c => c.input.includes('IF NOT pg_is_in_recovery()'));

  it.each([
    ['N45: a receive mark', { receive: { ...RECV, expiresAt: '2026-11-30T00:00:00.000Z' } }],
    ['N46: pushBroken', { pushBroken: { at: '2026-10-28T12:00:00.000Z', safetyDump: 'pre-receive-x.dump' } }],
  ])('%s: N-a writes nothing into the database', async (_n, mark) => {
    fake.dbs['a-pg'].generation = null;
    fake.dbs['a-pg'].tables = false;
    withDb(mark);
    await switchTick(now);
    expect(ensureSent()).toBe(false);
    expect(fake.dbs['a-pg'].generation).toBeNull();
  });

  it('V11, V22, V24: the received row of this push id ends receiving: the copies written back, pushBroken cleared, one save', async () => {
    const rows = [{ host: 'copy.example', port: 5434, slot: 'slot_c', cert: COPY_PEM, machine: 'copy.example' }];
    withDb({ receive: { ...RECV, copies: rows }, pushBroken: { at: 'x', safetyDump: 'pre-receive-old.dump' } });
    fake.dbs['a-pg'].addresses = [];
    fake.dbs['a-pg'].slots = { slot_c: { active: true, state: 'streaming', replay: '0/5000000' } };
    fake.dbs['a-pg'].received.push({ pushId: RECV.pushId, from: '9', machine: 'win.local', generation: 6 });
    const spy = vi.spyOn(containerManager, 'updateInstanceFleetDbSwitch');
    const log = logs();
    await switchTick(now);
    const calls = spy.mock.calls.filter(c => 'receive' in (c[1] as object)).map(c => c[1]);
    spy.mockRestore();
    log.mockRestore();
    expect(calls).toEqual([{ receive: null, pushBroken: null }]);
    expect(fake.dbs['a-pg'].addresses).toEqual([{ host: 'copy.example', port: 5434, slot: 'slot_c', cert: COPY_PEM, machine: 'copy.example' }]);
    expect(stored('a').fleetDb.pushBroken).toBeUndefined();
    expect(lines(log)).toContain('[Switch] A: received the main from win.local (generation 6); the receive login is removed');
  });
  it('V25: the copies write fails: logged, and receiving still ends', async () => {
    withDb({ receive: { ...RECV, copies: [{ host: 'copy.example', port: 5434, slot: 'slot_c', cert: COPY_PEM, machine: 'copy.example' }] } });
    fake.dbs['a-pg'].fail['copies-insert'] = 'ERROR:  relation "smdb_manager.addresses" does not exist';
    fake.dbs['a-pg'].received.push({ pushId: RECV.pushId, from: '9', machine: 'win.local', generation: 6 });
    const warn = warns();
    const log = logs();
    await switchTick(now);
    log.mockRestore();
    warn.mockRestore();
    expect(lines(warn)).toContain("[Switch] A: this machine's copies could not be listed again after the push (ERROR:  relation \"smdb_manager.addresses\" does not exist); they register again within an hour");
    expect(stored('a').fleetDb.receive).toBeUndefined();
  });
  it('V13 and V19: an expired code: unchanged database logs RV-LOG-EXPIRED; a replaced one writes pushBroken in the same save', async () => {
    withDb({ receive: { ...RECV } });
    fake.dbs['a-pg'].dbOid = '24576';
    const spy = vi.spyOn(containerManager, 'updateInstanceFleetDbSwitch');
    const log = logs();
    await switchTick(now);
    const calls = spy.mock.calls.map(c => c[1]);
    spy.mockRestore();
    log.mockRestore();
    expect(calls.filter(c => 'receive' in (c as object))).toEqual([{ receive: null, pushBroken: { at: expect.any(String), safetyDump: 'pre-receive-x.dump' } }]);
    expect(lines(log)).toContain('[Switch] A: the move code expired; a push replaced this database and did not finish, so the bot stays stopped until the dump pre-receive-x.dump is restored or a push finishes; the receive login is removed');
    expect(lines(log)).not.toContain('[Switch] A: the move code expired unused; the receive login is removed');
    expect(switchView(stored('a')).lines).toContain(`A push replaced this database on or before ${utcText(Date.parse(stored('a').fleetDb.pushBroken.at))} and did not finish, so the bot cannot run on it. Restore the dump pre-receive-x.dump (taken before receiving) with the bot in Maintenance or Off, or press Receive again so the other machine can push again.`);
    expect(switchView(stored('a')).badges).toContainEqual({ text: 'Push not finished', title: expect.stringMatching(/^A push replaced this database on or before /), danger: true });
  });
  it('V21: an expired code whose check cannot read: the login dropped, the mark kept; tried again next pass', async () => {
    withDb({ receive: { ...RECV } });
    fake.dbs['a-pg'].roles.smdb_receive = { password: 'p', until: 'x' };
    fake.dbs['a-pg'].fail['oid-read'] = 'psql: error: connection refused';
    await switchTick(now);
    expect(stored('a').fleetDb.receive).toBeDefined();
    expect(fake.dbs['a-pg'].roles.smdb_receive).toBeUndefined();
    delete fake.dbs['a-pg'].fail['oid-read'];
    const log = logs();
    await switchTick(now + 60_000);
    log.mockRestore();
    expect(stored('a').fleetDb.receive).toBeUndefined();
  });

  it('N47 and N56: the tie block fails: blockError kept, the line and the DM say so, blocked again at the next check', async () => {
    h.peer = writable(3);
    h.block = { ok: false, cls: 'other', error: 'permission denied to alter role' };
    await switchTick(now);
    expect(stored('a').fleetDb.mainConflict).toMatchObject({ blockError: 'permission denied to alter role' });
    expect(h.notified[0].text).toBe("Two databases of A are mains with the same generation: main.example and copy.example. The manager on main.example could not block the bot's database login there (permission denied to alter role) and tries again every 5 minutes; choose which one stays the main in either machine's manager (the bot's Database window).");
    expect(switchView(stored('a')).lines[0]).toContain(': this one and copy.example (copy.example:5434). The manager could not block the bot\'s database login here (permission denied to alter role) and tries again every 5 minutes, so bots may still write to this database. Keep this machine');
    h.events.length = 0;
    await switchTick(now + 6 * 60_000);
    expect(h.events).toContain('block');
  });
  it('N56: N11 with the block failed: the DM says the login could not be blocked', async () => {
    h.peer = writable(4);
    h.block = { ok: false, cls: 'other', error: 'permission denied to alter role' };
    await switchTick(now);
    expect(h.notified[0].text).toBe("The main database of A moved to copy.example on 2026-10-28 14:00 UTC, and the old main on main.example is running again. Its manager could not block the bot's login there (permission denied to alter role) and tries again every 5 minutes; it stops the bot there once it holds no change it could not save. Rejoin it as a copy in that machine's manager.");
  });
  it('N48: mainConflict stands and the login reads open: blocked again and logged', async () => {
    withDb({ mainConflict: { machine: 'copy.example', host: 'copy.example', port: 5434, generation: 3, at: 'x', cert: COPY_PEM, dm: { key: 'a:two-mains:3', state: 'posted', triedAt: 1 } } });
    h.login = { inRecovery: false, canLogin: true, sessions: 0 };
    h.peer = writable(3);
    const warn = warns();
    await switchTick(now);
    warn.mockRestore();
    expect(h.events.filter(e => e === 'block').length).toBeGreaterThanOrEqual(1);
    expect(lines(warn)).toContain("[Switch] A: the bot's database login was open while two mains stand; blocked it again");
  });
  it.each([
    ['in recovery, a settled Running: the login opened', () => ({ kind: 'in-recovery', systemId: '7001', timeline: 2, gen: null }), 'running', true],
    ['lower, Maintenance: the login stays blocked', writable(2), 'maintenance', false],
  ])('N49: the peer of the conflict now reads %s; the conflict cleared and logged', async (_n, p, state, opened) => {
    withDb({ mainConflict: { machine: 'copy.example', host: 'copy.example', port: 5434, generation: 3, at: 'x', cert: COPY_PEM } }, { maintenance: { state, message: '', orderedAt: 'x', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: state } });
    h.peer = p as any;
    const log = logs();
    await switchTick(now);
    log.mockRestore();
    expect(stored('a').fleetDb.mainConflict).toBeUndefined();
    expect(h.events.includes('open')).toBe(opened);
    expect(lines(log)).toContain('[Switch] A: copy.example no longer accepts writes as a main; this database is the only main');
  });
  it('N50: a main with formerMain and no replication probes it with its own code every 5 minutes', async () => {
    writeRegistry({ a: mainFixture({ fleetDb: { containerName: 'a-pg', user: 'app', db: 'app', volume: 'a-pgdata', formerMain: FORMER() } }) });
    await switchTick(now);
    expect(h.events.filter(e => e.startsWith('probe:'))).toEqual(['probe:old.example']);
    await switchTick(now + 60_000);
    expect(h.events.filter(e => e.startsWith('probe:'))).toEqual(['probe:old.example']);
    await switchTick(now + 6 * 60_000);
    expect(h.events.filter(e => e.startsWith('probe:'))).toEqual(['probe:old.example', 'probe:old.example']);
  });
  it('N51: formerMain writable at a higher generation: replaced, with its host and port and the certificate read', async () => {
    withDb({ formerMain: FORMER() });
    h.peer = at('old.example', () => ({ kind: 'writable', systemId: '7001', timeline: 3, gen: { generation: 5, machine: 'old.example', since: '2026-10-28T14:00:00Z' } })) as any;
    await switchTick(now);
    expect(stored('a').fleetDb.replacedBy).toMatchObject({ machine: 'old.example', host: 'old.example', port: 5500, generation: 5, own: 3 });
    expect(stored('a').fleetDb.replacedBy.cert).toBeTruthy();
    expect(h.events).toContain('block');
  });
  it('N52: formerMain at the same generation: the tie', async () => {
    withDb({ formerMain: FORMER() });
    h.peer = at('old.example', () => ({ kind: 'writable', systemId: '7001', timeline: 3, gen: { generation: 3, machine: 'old.example', since: null } })) as any;
    await switchTick(now);
    expect(stored('a').fleetDb.mainConflict).toMatchObject({ machine: 'old.example', host: 'old.example', port: 5500, generation: 3 });
  });
  it('N53: formerMain lower with replication: this machine registered on it with formerMain.slot, logged once per change', async () => {
    withDb({ formerMain: FORMER() });
    h.peer = at('old.example', () => ({ kind: 'writable', systemId: '7001', timeline: 3, gen: { generation: 2, machine: 'old.example', since: null } })) as any;
    const log = logs();
    await switchTick(now);
    await switchTick(now + 6 * 60_000);
    log.mockRestore();
    expect(h.registerCalls).toEqual([
      { host: 'old.example', port: 5500, row: { host: 'main.example', port: 5433, slot: 'slot_c', cert: COPY_PEM, machine: 'main.example' } },
      { host: 'old.example', port: 5500, row: { host: 'main.example', port: 5433, slot: 'slot_c', cert: COPY_PEM, machine: 'main.example' } },
    ]);
    expect(lines(log).filter(l => l === "[Switch] A: the old main old.example runs again as a main; this machine's address was added to its copy list")).toHaveLength(1);
    expect(stored('a').fleetDb.formerMain).toBeDefined();
  });
  it.each([
    ['in recovery', () => ({ kind: 'in-recovery', systemId: '7001', timeline: 3, gen: null })],
    ['another system id', () => ({ kind: 'writable', systemId: '8000', timeline: 1, gen: { generation: 9, machine: 'x', since: null } })],
  ])('N54: formerMain reads %s: cleared', async (_n, p) => {
    withDb({ formerMain: FORMER() });
    h.peer = at('old.example', p) as any;
    await switchTick(now);
    expect(stored('a').fleetDb.formerMain).toBeUndefined();
    expect(stored('a').fleetDb.replacedBy).toBeUndefined();
  });
  it('N55: the copies list is synced before the probes; a failure is logged once per change and the probes go on', async () => {
    fake.dbs['a-pg'].slots = { slot_c: { active: true, state: 'streaming', replay: '0/5000000', client: '10.0.0.2' } };
    await switchTick(now);
    const all = fake.calls.map(c => c.input);
    expect(all.findIndex(x => x.includes('INSERT INTO smdb_manager.copies AS c'))).toBeGreaterThanOrEqual(0);
    expect(fake.dbs['a-pg'].copies).toEqual([{ slot: 'slot_c', machine: 'copy.example', client: '10.0.0.2' }]);
    expect(h.events.indexOf('copies-sync')).toBeLessThan(h.events.indexOf('probe:copy.example'));
    fake.dbs['a-pg'].fail['copies-sync'] = 'ERROR:  cannot execute INSERT in a read-only transaction';
    const warn = warns();
    await switchTick(now + 6 * 60_000);
    await switchTick(now + 12 * 60_000);
    warn.mockRestore();
    expect(lines(warn).filter(l => l.includes('the list of this database\'s copies could not be written'))).toHaveLength(1);
    expect(h.events.filter(e => e === 'probe:copy.example')).toHaveLength(3);
  });
});

describe('N57 to N61 (D56): the old main kept, and a certificate it registered since', () => {
  const OLD_CODE = fakeJoinCode({ host: 'old.example', port: 5500, machine: 'old.example', fp: FIXTURE_FP });
  const FORMER = (over: Record<string, unknown> = {}) => ({ code: OLD_CODE, slot: 'slot_o', machine: 'old.example', host: 'old.example', port: 5500, generation: 2, at: '2026-10-28T12:00:00.000Z', ...over });
  const ROW = { host: 'old.example', port: 5500, slot: 'slot_o', machine: 'old.example', cert: COPY_PEM };
  const FP_FAIL = { ok: false, kind: 'fingerprint', reason: 'the server shows fingerprint 0f0f, not 53c2', text: 'x' };
  /** The old main shows COPY_PEM now: a code naming its fingerprint reads it, the kept code fails on the fingerprint. */
  const certByFp = () => {
    const fps: string[] = [];
    const spy = vi.spyOn(fleetJoin, 'mainCertificate').mockImplementation((async (code: { fp: string }) => {
      fps.push(code.fp);
      return code.fp === COPY_FP ? { ok: true, pem: COPY_PEM } : FP_FAIL;
    }) as any);
    return { fps, restore: () => spy.mockRestore() };
  };
  const seen = () => { const out: string[] = []; const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => { out.push(String(m)); }); const w = vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { out.push(String(m)); }); return { out, restore: () => { spy.mockRestore(); w.mockRestore(); } }; };
  const old = (g: number, machine = 'old.example') => (host: string) => (host === 'old.example'
    ? { kind: 'writable', systemId: '7001', timeline: 3, gen: { generation: g, machine, since: '2026-10-28T14:00:00Z' }, receiveMark: false }
    : { kind: 'unreachable', reason: 'connection refused' }) as any;

  it('N57: a copy row at the old main\'s host and port with a new certificate: composed, and the higher main recorded as replacedBy', async () => {
    fake.dbs['a-pg'].addresses = [ROW];
    withDb({ formerMain: FORMER() });
    h.peer = old(5);
    const cert = certByFp();
    await switchTick(now);
    cert.restore();
    expect(cert.fps[0]).toBe(COPY_FP);
    expect(stored('a').fleetDb.replacedBy).toMatchObject({ machine: 'old.example', host: 'old.example', port: 5500, generation: 5, own: 3 });
  });
  it('N58: the old main is listed as this main\'s copy: formerMain cleared before any probe with its code, logged', async () => {
    fake.dbs['a-pg'].addresses = [ROW];
    fake.dbs['a-pg'].slots = { slot_o: { active: true, state: 'streaming', replay: '0/5000000' } };
    withDb({ formerMain: FORMER() });
    const cert = certByFp();
    const log = seen();
    await switchTick(now);
    cert.restore();
    log.restore();
    expect(cert.fps).not.toContain(FIXTURE_FP);
    expect(stored('a').fleetDb.formerMain).toBeUndefined();
    expect(log.out).toContain('[Switch] A: the old main old.example is a copy of this database now; the manager no longer checks it as a former main');
  });
  it('N59: the kept code fails on the fingerprint and the old main is not listed: kept with checkError, FM-LINE, logged once; cleared by a later read', async () => {
    withDb({ formerMain: FORMER() });
    const cert = certByFp();
    const log = seen();
    await switchTick(now);
    await switchTick(now + 6 * 60_000);
    cert.restore();
    log.restore();
    expect(stored('a').fleetDb.formerMain).toMatchObject({ host: 'old.example', checkError: { kind: 'cert', reason: FP_FAIL.reason } });
    expect(stored('a').fleetDb.replacedBy).toBeUndefined();
    expect(log.out.filter(l => l.includes('shows another certificate'))).toEqual([`[Switch] A: the old main old.example shows another certificate than the join code kept here (${FP_FAIL.reason}); the manager can't check it`]);
    expect(switchView(stored('a')).lines).toContain(`The manager can't check the old main old.example any more: it shows another certificate than the join code kept here (${FP_FAIL.reason}), as it does after it was rebuilt as a copy or its certificate was replaced. If old.example runs again as a main, choose Off for the bot in its manager.`);
    h.peer = old(2);
    await switchTick(now + 12 * 60_000);
    expect(stored('a').fleetDb.formerMain).toBeDefined();
    expect(stored('a').fleetDb.formerMain.checkError).toBeUndefined();
  });
  it('N60: the kept code does not decode: kept with checkError, FM-LINE-CODE; peerCode composes for that host and port', async () => {
    withDb({ formerMain: FORMER({ code: '' }) });
    const log = seen();
    await switchTick(now);
    await switchTick(now + 6 * 60_000);
    log.restore();
    expect(stored('a').fleetDb.formerMain).toMatchObject({ checkError: { kind: 'code' } });
    expect(log.out.filter(l => l.includes('does not read'))).toHaveLength(1);
    expect(switchView(stored('a')).lines).toContain("The manager can't check the old main old.example: the join code kept from it does not read (it no longer decrypts or decodes). If old.example runs again as a main, choose Off for the bot in its manager.");
    withDb({ formerMain: FORMER({ code: '' }), replacedBy: { machine: 'old.example', host: 'old.example', port: 5500, generation: 5, own: 3, since: null, at: 'x', cert: COPY_PEM } });
    const { rejoinComposed } = await import('../../src/instance/fleetSwitch');
    expect(rejoinComposed('a')).toMatchObject({ success: true });
  });
  it('N61: N-e checks a stream mark whose target is at the old main\'s host and port with the certificate it shows: composed, no rejoinError', async () => {
    withDb({ formerMain: FORMER(), handover: { mode: 'stream', phase: 'stopped', slot: 'slot_o', machine: 'old.example', host: 'old.example', port: 5500, cert: COPY_PEM, generation: 4, at: '2026-10-28T12:00:00.000Z' } });
    h.sidecar['a-pg'] = false;
    h.peer = old(3);
    const cert = certByFp();
    await switchTick(now);
    expect(stored('a').fleetDb.handover.rejoinError).toBeUndefined();
    expect(stored('a').fleetDb.handover.lastCheck).toBe('old.example has generation 3');
    h.peer = old(4);
    await switchTick(now + 6 * 60_000);
    cert.restore();
    expect(cert.fps).toEqual([COPY_FP, COPY_FP]);
    expect(h.reseedCalls).toHaveLength(1);
  });
});

describe('N62 to N64 (D62): N-j removes a receive mark no record stands for', () => {
  const OFF = { state: 'off', message: '', orderedAt: '2026-10-30T00:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: 'maintenance' };
  const STALE = '[Switch] A: removed a receive mark that no receive or unfinished push on this machine stands for';
  const FAIL = (e: string) => `[Switch] A: a receive mark that no receive or unfinished push on this machine stands for could not be removed (${e}); the manager tries again every minute`;
  const seen = () => { const out: string[] = []; const a = vi.spyOn(console, 'log').mockImplementation((m: unknown) => { out.push(String(m)); }); const b = vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { out.push(String(m)); }); return { out, restore: () => { a.mockRestore(); b.mockRestore(); } }; };
  const stale = () => { fake.dbs['a-pg'].receiveMark = { markId: 'a1', pushIds: ['a1', 'b2'], dbOid: '16384' }; };
  const clears = () => fake.calls.filter(c => c.input.includes('DELETE FROM smdb_manager.receive_mark'));

  it('N62 (D62): a main with neither receive nor pushBroken: the row removed by its own mark id, logged once', async () => {
    stale();
    const log = seen();
    await switchTick(now);
    await switchTick(now + 60_000);
    log.restore();
    expect(fake.dbs['a-pg'].receiveMark).toBeNull();
    expect(clears()).toHaveLength(1);
    expect(clears()[0].input).toContain("mark_id = 'a1'");
    expect(clears()[0].args[clears()[0].args.indexOf('-d') + 1]).toBe('postgres');
    expect(log.out.filter(m => m === STALE)).toHaveLength(1);
  });
  it('N63 (D62): Receive writes its row between N-j\'s read and its delete: the delete matches nothing, Receive\'s row stays', async () => {
    withDb({}, { maintenance: OFF });
    stale();
    let held!: () => void;
    let release!: () => void;
    const reached = new Promise<void>(r => { held = r; });
    const gate = new Promise<void>(r => { release = r; });
    fake.dbs['a-pg'].beforeAnswer = async sql => {
      if (sql.includes('DELETE FROM smdb_manager.receive_mark')) { held(); await gate; }
    };
    const tick = switchTick(now);
    await Promise.race([reached, tick]);
    const r = await receive('a');
    expect(r.success).toBe(true);
    release();
    await tick;
    const id = stored('a').fleetDb.receive.pushId;
    expect(fake.dbs['a-pg'].receiveMark).toEqual({ markId: id, pushIds: [id], dbOid: '16384' });
    expect(clears()[0].input).toContain("mark_id = 'a1'");
  });
  it('N64 (D62): the read fails: nothing removed, logged once per change of the error, removed once the read answers', async () => {
    stale();
    const d = fake.dbs['a-pg'];
    d.fail['mark-read'] = 'ERROR:  canceling statement due to statement timeout';
    const log = seen();
    await switchTick(now);
    await switchTick(now + 60_000);
    d.fail['mark-read'] = 'ERROR:  out of shared memory';
    await switchTick(now + 120_000);
    delete d.fail['mark-read'];
    await switchTick(now + 180_000);
    log.restore();
    expect(log.out.filter(m => m.includes('could not be removed'))).toEqual([FAIL('ERROR:  canceling statement due to statement timeout'), FAIL('ERROR:  out of shared memory')]);
    expect(d.receiveMark).toBeNull();
  });
  it('N64 (D62): the delete fails: the row stays, logged once, removed on a later pass', async () => {
    stale();
    const d = fake.dbs['a-pg'];
    d.fail['mark-clear'] = 'ERROR:  canceling statement due to lock timeout';
    const log = seen();
    await switchTick(now);
    await switchTick(now + 60_000);
    expect(d.receiveMark).not.toBeNull();
    delete d.fail['mark-clear'];
    await switchTick(now + 120_000);
    log.restore();
    expect(log.out.filter(m => m.includes('could not be removed'))).toEqual([FAIL('ERROR:  canceling statement due to lock timeout')]);
    expect(d.receiveMark).toBeNull();
  });
  it.each([
    ['receive stands', { receive: { ...RECV, expiresAt: '2099-01-01T00:00:00.000Z' } }],
    ['pushBroken stands', { pushBroken: { at: '2026-10-28T12:00:00.000Z', safetyDump: 'pre-receive-x.dump' } }],
  ])('N64 (D62): %s: nothing read or removed; once it is gone, the next pass removes the row', async (_n, mark) => {
    stale();
    withDb(mark);
    await switchTick(now);
    expect(h.events).not.toContain('mark-read');
    expect(fake.dbs['a-pg'].receiveMark).not.toBeNull();
    withDb();
    await switchTick(now + 60_000);
    expect(fake.dbs['a-pg'].receiveMark).toBeNull();
  });
  it('N64 (D62): the bot turns busy after the read: no delete; the next pass removes the row', async () => {
    stale();
    const d = fake.dbs['a-pg'];
    let turn = true;
    const busy = vi.spyOn(containerManager, 'isBotBusy').mockImplementation(((id: string) => (turn && id === 'a' && h.events.includes('mark-read') ? 'backup' : null)) as any);
    await switchTick(now);
    turn = false;
    busy.mockRestore();
    expect(h.events).toContain('mark-read');
    expect(clears()).toEqual([]);
    expect(d.receiveMark).not.toBeNull();
    await switchTick(now + 60_000);
    expect(d.receiveMark).toBeNull();
  });
});
