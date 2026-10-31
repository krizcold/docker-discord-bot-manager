import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-l5-d-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

// A psql run that printed the address rows and then exited 1 (the connection dropped after the output).
vi.mock('child_process', async (o) => {
  const base = (await import('./switch-harness')).childProcessMock(await o()) as any;
  const { fake: f } = await import('./switch-fake');
  const spawn = (cmd: string, args: string[], opts?: any) => {
    const c = base.spawn(cmd, args, opts);
    const entry = f.calls[f.calls.length - 1];
    if ((globalThis as { __dAddrExit1?: boolean }).__dAddrExit1) {
      const emit = c.emit.bind(c);
      c.emit = (ev: string, ...a: unknown[]) => (ev === 'close' && entry?.input.includes("SELECT 'addr|'") && entry.input.includes('WHERE slot IS NOT NULL') ? emit('close', 1) : emit(ev, ...a));
    }
    return c;
  };
  return { ...base, spawn, default: { ...base.default, spawn } };
});
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

import { keepMain, resetSwitchState, stepNotice, switchTick, SWITCH_TIMING } from '../../src/instance/fleetSwitch';
import { utcText } from '../../src/instance/backupFiles';
import * as containerManager from '../../src/docker/containerManager';
import * as backupCheck from '../../src/instance/backupCheck';
import * as fleetJoin from '../../src/instance/fleetJoin';
import * as fleetReplica from '../../src/instance/fleetReplica';
import { COPY_PEM, fake, freshDb, h, mainFixture, resetHarness, stored, writeRegistry } from './switch-harness';
import { fakeJoinCode } from './join-fake';

const PEER = { host: 'copy.example', port: 5434, slot: 'slot_c', machine: 'copy.example', cert: COPY_PEM };
const NO_REPL = { containerName: 'a-pg', user: 'app', db: 'app', volume: 'a-pgdata' };
const withDb = (extra: Record<string, unknown> = {}, inst: Record<string, unknown> = {}) => writeRegistry({ a: mainFixture({ fleetDb: { ...mainFixture().fleetDb as object, ...extra }, ...inst }) });
const writable = (g: number, sys = '7001', receiveMark: boolean | null = false) => () => ({ kind: 'writable', systemId: sys, timeline: 2, gen: { generation: g, machine: 'copy.example', since: '2026-10-28T14:00:00Z' }, receiveMark }) as any;
const recovering = () => ({ kind: 'in-recovery', systemId: '7001', timeline: 2, gen: null }) as any;
const rec = (state: string, over: Record<string, unknown> = {}) => ({ state, message: 'Back soon', orderedAt: '2026-10-28T00:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: 'maintenance', ...over });
const editRegistry = (fn: (a: any) => void) => {
  const file = `${process.env.DATA_DIR}/instances.json`;
  const all = JSON.parse(fs.readFileSync(file, 'utf-8'));
  fn(all.instances.a);
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
};
const setMaintenance = (m: Record<string, unknown>) => editRegistry(a => { a.maintenance = m; });
const seen = () => {
  const log: string[] = []; const warn: string[] = []; const error: string[] = [];
  const s = [
    vi.spyOn(console, 'log').mockImplementation((m: unknown) => { log.push(String(m)); }),
    vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { warn.push(String(m)); }),
    vi.spyOn(console, 'error').mockImplementation((m: unknown) => { error.push(String(m)); }),
  ];
  return { log, warn, error, restore: () => s.forEach(x => x.mockRestore()) };
};
const probes = (host: string) => h.events.filter(e => e === `probe:${host}`).length;
let now = Date.parse('2026-10-28T15:00:00Z');
let first = true;

beforeEach(() => {
  resetHarness();
  if (!first) resetSwitchState();
  first = false;
  (globalThis as { __dAddrExit1?: boolean }).__dAddrExit1 = false;
  fake.dbs['a-pg'] = freshDb({ addresses: [PEER] });
  withDb();
  now += 6 * 60_000;
});
afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

describe('the tick before any reset', () => {
  it('the first pass of a fresh manager runs (no pass is marked running at start)', async () => {
    fake.dbs['a-pg'].generation = null;
    fake.dbs['a-pg'].tables = false;
    await switchTick(now);
    expect(fake.dbs['a-pg'].generation).toMatchObject({ generation: 1 });
  });
});

describe('N-b: the switch notice log line', () => {
  it('names the state and the error the bot gave', async () => {
    h.hook = () => ({ ok: false, status: 500, error: 'boom' });
    const s = seen();
    await stepNotice('a', now);
    s.restore();
    expect(s.log).toContain('[Switch] A: switch notice for generation 3: pending (boom)');
  });
  it('names only the state when there is no error', async () => {
    const s = seen();
    await stepNotice('a', now);
    s.restore();
    expect(s.log).toContain('[Switch] A: switch notice for generation 3: sent');
  });
});

describe('O11 Keep this machine as the main', () => {
  const CONFLICT = { machine: 'b.example', host: 'b.example', port: 5440, generation: 3, at: 'x', cert: COPY_PEM };
  const conflict = (c: Record<string, unknown>, inst: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => withDb({ mainConflict: c, ...extra }, inst);
  const tail = ". The manager can't confirm when b.example's manager reads this generation: it checks every 5 minutes while it can reach this machine, then blocks its bot's login there and puts the bot in Off once it holds nothing it could not save. Rejoin b.example as a copy in its manager afterwards; that keeps a dump of its database first.";
  it('an unknown bot: Bot not found', async () => {
    expect(await keepMain('nobody')).toMatchObject({ success: false, text: 'Bot not found' });
  });
  it('the own generation does not read: the refusal names the error', async () => {
    conflict(CONFLICT);
    fake.dbs['a-pg'].fail['gen-read'] = 'ERROR:  relation is locked';
    expect((await keepMain('a')).text).toBe('The generation could not be raised (ERROR:  relation is locked); nothing was changed');
  });
  it('a conflict without a certificate is not probed', async () => {
    const { cert: _c, ...noCert } = CONFLICT;
    conflict(noCert);
    h.peer = writable(5);
    const r = await keepMain('a');
    expect(r.success).toBe(true);
    expect(h.events.filter(e => e.startsWith('probe:'))).toEqual([]);
    expect(stored('a').fleetDb.replacedBy).toBeUndefined();
  });
  it('a peer below the recorded conflict: raised above the conflict, not above the peer', async () => {
    conflict(CONFLICT);
    h.peer = writable(2);
    expect((await keepMain('a')).text).toBe(`This machine is the main now (generation 4); the bot's state here is Maintenance, so its login stays blocked until you choose Running${tail}`);
  });
  it.each([
    ['an unsettled Running', rec('running', { settled: false }), 'Running'],
    ['Off', rec('off'), 'Off'],
  ])('the state %s is named in the reply', async (_n, m, name) => {
    conflict(CONFLICT, { maintenance: m });
    expect((await keepMain('a')).text).toBe(`This machine is the main now (generation 4); the bot's state here is ${name}, so its login stays blocked until you choose Running${tail}`);
  });
  it('replaced again at the generation already recorded: its Off state, message and date are kept, no new log line', async () => {
    const prior = { machine: 'b.example', host: 'b.example', port: 5440, generation: 5, own: 3, since: null, at: '2026-10-20T08:00:00.000Z', off: { state: 'held', askedAt: 1, at: 'y' }, dm: { key: 'a:replaced:5', state: 'posted', place: 'dm', triedAt: 1 } };
    conflict(CONFLICT, {}, { replacedBy: prior });
    h.peer = writable(5);
    const s = seen();
    await keepMain('a');
    s.restore();
    const r = stored('a').fleetDb.replacedBy;
    expect(r.off).toEqual(prior.off);
    expect(r.dm).toEqual(prior.dm);
    expect(r.at).toBe(prior.at);
    expect(s.warn.filter(l => l.includes('replaced as the main'))).toEqual([]);
    expect(h.notified).toEqual([]);
  });
  it('replaced at a new generation: the old Off state and message are dropped, the log line written, the owner told', async () => {
    const prior = { machine: 'b.example', host: 'b.example', port: 5440, generation: 4, own: 3, since: null, at: '2026-10-20T08:00:00.000Z', off: { state: 'held', askedAt: 1, at: 'y' }, dm: { key: 'a:replaced:4', state: 'posted', place: 'dm', triedAt: 1 } };
    conflict(CONFLICT, {}, { replacedBy: prior });
    h.peer = writable(5);
    const s = seen();
    await keepMain('a');
    s.restore();
    const r = stored('a').fleetDb.replacedBy;
    expect(r.off).toBeUndefined();
    expect(r.dm.key).toBe('a:replaced:5');
    expect(h.notified).toHaveLength(1);
    expect(s.warn).toContain("[Switch] A: replaced as the main by b.example (generation 5); the bot's database login is blocked");
  });
});

describe('N11: the replaced log line', () => {
  it('the login blocked', async () => {
    h.peer = writable(4);
    const s = seen();
    await switchTick(now);
    s.restore();
    expect(s.warn).toContain("[Switch] A: replaced as the main by copy.example (generation 4); the bot's database login is blocked");
  });
  it('the block failed', async () => {
    h.peer = writable(4);
    h.block = { ok: false, cls: 'other', error: 'permission denied to alter role' };
    const s = seen();
    await switchTick(now);
    s.restore();
    expect(s.warn).toContain("[Switch] A: replaced as the main by copy.example (generation 4); the bot's database login is not blocked (permission denied to alter role)");
  });
});

describe('ownPeers: the address list', () => {
  it('a list read that exits non-zero probes no copy, even with rows printed', async () => {
    (globalThis as { __dAddrExit1?: boolean }).__dAddrExit1 = true;
    h.peer = writable(4);
    await switchTick(now);
    expect(probes('copy.example')).toBe(0);
    expect(stored('a').fleetDb.replacedBy).toBeUndefined();
  });
  it('a row is read without its surrounding whitespace', async () => {
    fake.dbs['a-pg'].addresses = [{ ...PEER, cert: `${COPY_PEM} ` }];
    h.peer = writable(4);
    await switchTick(now);
    expect(stored('a').fleetDb.replacedBy.cert).toBe(COPY_PEM);
  });
});

describe('N-i: the owner message of a standing replacedBy', () => {
  const REPLACED = { machine: 'copy.example', host: 'copy.example', port: 5434, generation: 4, own: 3, since: null, at: '2026-10-20T08:00:00.000Z' };
  const standing = () => withDb({ replacedBy: { ...REPLACED } }, { maintenance: rec('off') });
  it('no takeover date: the message gives the date it was recorded', async () => {
    standing();
    await switchTick(now);
    expect(h.notified[0].text).toBe(`The main database of A moved to copy.example on ${utcText(Date.parse(REPLACED.at))}, and the old main on main.example is running again. Its manager blocked the bot's login there and stops the bot there once it holds no change it could not save; rejoin it as a copy in that machine's manager.`);
  });
  it('no takeover date and the block failed: the message gives the date it was recorded', async () => {
    withDb({ replacedBy: { ...REPLACED, blockError: 'permission denied' } }, { maintenance: rec('off') });
    await switchTick(now);
    expect(h.notified[0].text).toBe(`The main database of A moved to copy.example on ${utcText(Date.parse(REPLACED.at))}, and the old main on main.example is running again. Its manager could not block the bot's login there (permission denied) and tries again every 5 minutes; it stops the bot there once it holds no change it could not save. Rejoin it as a copy in that machine's manager.`);
  });
  it.each([
    ['a repeat keeps no place', { dm: 'sent', posted: false, place: 'dm', note: 'posted before' }, { state: 'repeat', note: 'posted before' }],
    ['unsupported without notFound', { dm: 'unsupported' }, { state: 'unsupported' }],
    ['failed without an error', { dm: 'failed' }, { state: 'failed', error: 'no reason given' }],
  ])('%s', async (_n, outcome, dm) => {
    standing();
    h.notifyOutcome = outcome;
    const s = seen();
    await switchTick(now);
    s.restore();
    expect(stored('a').fleetDb.replacedBy.dm).toEqual({ key: 'a:replaced:4', ...dm, triedAt: now });
    expect(s.error).toEqual([]);
  });
  it('replacedBy gone while the message was sent: nothing is written back', async () => {
    standing();
    const spy = vi.spyOn(backupCheck, 'notifyOwner').mockImplementation((async () => { editRegistry(a => { delete a.fleetDb.replacedBy; }); return { dm: 'sent', posted: true, place: 'dm' }; }) as any);
    await switchTick(now);
    spy.mockRestore();
    expect(stored('a').fleetDb.replacedBy).toBeUndefined();
  });
  it('replacedBy at another generation since: the outcome is not put on it', async () => {
    standing();
    const spy = vi.spyOn(backupCheck, 'notifyOwner').mockImplementation((async () => { editRegistry(a => { a.fleetDb.replacedBy.generation = 9; }); return { dm: 'sent', posted: true, place: 'dm' }; }) as any);
    await switchTick(now);
    spy.mockRestore();
    expect(stored('a').fleetDb.replacedBy).toMatchObject({ generation: 9 });
    expect(stored('a').fleetDb.replacedBy.dm).toBeUndefined();
  });
  it('the outcome write fails: logged', async () => {
    standing();
    const spy = vi.spyOn(backupCheck, 'notifyOwner').mockImplementation((async () => { h.failSwitchWrite = 'disk full'; return { dm: 'sent', posted: true, place: 'dm' }; }) as any);
    const s = seen();
    await switchTick(now);
    s.restore();
    spy.mockRestore();
    h.failSwitchWrite = null;
    expect(s.error).toContain('[Switch] A: the outcome of the message to the owner could not be recorded (disk full)');
  });
});

describe('N-g: the replaced main put in Off', () => {
  const REPLACED = { machine: 'copy.example', host: 'copy.example', port: 5434, generation: 4, own: 3, since: '2026-10-28T14:00:00Z', at: '2026-10-28T14:05:00.000Z', cert: COPY_PEM, dm: { key: 'a:replaced:4', state: 'posted', place: 'dm', triedAt: 1 } };
  const replaced = (maint: Record<string, unknown>) => withDb({ replacedBy: { ...REPLACED } }, { maintenance: maint });
  it('a held answer without a confirmed hook is not kept on Off', async () => {
    replaced(rec('maintenance', { hook: 'missing', held: { state: 'yes' } }));
    h.onOrder = to => { if (to === 'off') setMaintenance(rec('off', { hook: 'missing', held: { state: 'yes' } })); };
    await switchTick(now);
    expect(stored('a').fleetDb.replacedBy.off).toEqual({ state: 'off', at: new Date(now).toISOString() });
  });
  it('Off after the Maintenance answer keeps when it was asked', async () => {
    replaced(rec('running'));
    h.onOrder = to => setMaintenance(to === 'off' ? rec('off', { held: { state: 'yes' } }) : rec('maintenance', { held: { state: 'yes' } }));
    await switchTick(now);
    expect(stored('a').fleetDb.replacedBy.off).toEqual({ state: 'off', held: { state: 'yes' }, askedAt: now, at: new Date(now).toISOString() });
  });
  it('a failed Off after the Maintenance answer keeps when it was asked', async () => {
    replaced(rec('running'));
    h.onOrder = to => {
      if (to === 'maintenance') setMaintenance(rec('maintenance', { held: { state: 'yes' } }));
      else h.order = { settled: false, text: 'The stop failed.' };
    };
    await switchTick(now);
    expect(stored('a').fleetDb.replacedBy.off).toEqual({ state: 'failed', askedAt: now, at: new Date(now).toISOString(), error: 'The stop failed.' });
  });
  it('the state write fails: logged; a write that works logs no error', async () => {
    replaced(rec('maintenance', { held: { state: 'yes' } }));
    h.onOrder = to => { if (to === 'off') { setMaintenance(rec('off', { held: { state: 'yes' } })); h.failSwitchWrite = 'disk full'; } };
    const s = seen();
    await switchTick(now);
    s.restore();
    h.failSwitchWrite = null;
    expect(s.error).toContain("[Switch] A: the replaced main's state could not be recorded (disk full)");
    replaced(rec('maintenance', { held: { state: 'yes' } }));
    h.onOrder = to => { if (to === 'off') setMaintenance(rec('off', { held: { state: 'yes' } })); };
    const t = seen();
    await switchTick(now + 6 * 60_000);
    t.restore();
    expect(t.error).toEqual([]);
  });
  it('held: the Maintenance line is logged', async () => {
    replaced(rec('maintenance', { held: { state: 'no', guilds: 2, files: 1 } }));
    const s = seen();
    await switchTick(now);
    s.restore();
    expect(s.log).toContain("[Switch] A: the replaced main's bot stays in Maintenance: it holds changes it could not save");
  });
  it('failed twice: warned once', async () => {
    replaced(rec('running'));
    h.order = { settled: false, text: 'The bot did not answer the maintenance order (no answer within 30 s).' };
    const s = seen();
    await switchTick(now);
    await switchTick(now + 60_000);
    s.restore();
    const line = "[Switch] A: the replaced main's bot could not be put in Off: The bot did not answer the maintenance order (no answer within 30 s).";
    expect(s.warn.filter(l => l === line)).toHaveLength(1);
    expect(s.log).not.toContain(line);
  });
});

describe('N17: keepBlocked on a replaced main', () => {
  const REPLACED = { machine: 'b', host: 'b', port: 1, generation: 5, own: 3, since: null, at: 'x', dm: { key: 'a:replaced:5', state: 'posted', triedAt: 1 } };
  it('a blocked login is left as it is', async () => {
    withDb({ replacedBy: REPLACED }, { maintenance: rec('off') });
    await switchTick(now);
    expect(h.events).not.toContain('block');
  });
  it('an open login blocked again: sessions ended, logged', async () => {
    withDb({ replacedBy: REPLACED }, { maintenance: rec('off') });
    h.login = { inRecovery: false, canLogin: true, sessions: 0 };
    const s = seen();
    await switchTick(now);
    s.restore();
    expect(h.events).toContain('end-sessions');
    expect(s.warn).toContain("[Switch] A: the bot's database login was open on a replaced main; blocked it again");
  });
  it('the block fails: no sessions ended, the error logged', async () => {
    withDb({ replacedBy: REPLACED }, { maintenance: rec('off') });
    h.login = { inRecovery: false, canLogin: true, sessions: 0 };
    h.block = { ok: false, cls: 'other', error: 'permission denied' };
    const s = seen();
    await switchTick(now);
    s.restore();
    expect(h.events).not.toContain('end-sessions');
    expect(s.warn).toContain("[Switch] A: the bot's database login was open on a replaced main; it could not be blocked (permission denied)");
  });
});

describe('N12: markTie', () => {
  const PRIOR = { machine: 'copy.example', host: 'copy.example', port: 5434, generation: 3, at: '2026-10-01T00:00:00.000Z', cert: COPY_PEM, dm: { key: 'a:two-mains:3', state: 'posted', triedAt: 1 } };
  const TIE = "[Switch] A: copy.example also accepts writes as the main with generation 3; the bot's database login is blocked";
  it('a new tie: recorded with the certificate, logged', async () => {
    h.peer = writable(3);
    const s = seen();
    await switchTick(now);
    s.restore();
    expect(stored('a').fleetDb.mainConflict.cert).toBe(COPY_PEM);
    expect(s.warn).toContain(TIE);
  });
  it('a new tie with the block failed: logged with the error', async () => {
    h.peer = writable(3);
    h.block = { ok: false, cls: 'other', error: 'permission denied' };
    const s = seen();
    await switchTick(now);
    s.restore();
    expect(s.warn).toContain("[Switch] A: copy.example also accepts writes as the main with generation 3; the bot's database login is not blocked (permission denied)");
  });
  it('the same tie again: its date kept, no new log line', async () => {
    withDb({ mainConflict: PRIOR });
    h.peer = writable(3);
    const s = seen();
    await switchTick(now);
    s.restore();
    expect(stored('a').fleetDb.mainConflict.at).toBe(PRIOR.at);
    expect(s.warn).not.toContain(TIE);
  });
  it.each([
    ['generation', { generation: 2 }],
    ['host', { host: 'other.example' }],
    ['port', { port: 9999 }],
  ])('a prior conflict with another %s is a new tie', async (_n, over) => {
    withDb({ mainConflict: { ...PRIOR, ...over } });
    h.peer = writable(3);
    const s = seen();
    await switchTick(now);
    s.restore();
    expect(stored('a').fleetDb.mainConflict.at).toBe(new Date(now).toISOString());
    expect(s.warn).toContain(TIE);
  });
});

describe('N49: endTie', () => {
  const C = { machine: 'copy.example', host: 'copy.example', port: 5434, generation: 3, at: 'x', cert: COPY_PEM, dm: { key: 'a:two-mains:3', state: 'posted', triedAt: 1 } };
  it.each([
    ['host', { host: 'other.example' }],
    ['port', { port: 9999 }],
  ])('a conflict at another %s stays when this peer reads none', async (_n, over) => {
    withDb({ mainConflict: { ...C, ...over } });
    h.peer = recovering;
    await switchTick(now);
    expect(stored('a').fleetDb.mainConflict).toBeDefined();
  });
  it('the open fails: the conflict kept, logged', async () => {
    withDb({ mainConflict: C }, { maintenance: rec('running', { savedByBot: 'running' }) });
    h.peer = recovering;
    h.open = { ok: false, cls: 'other', error: 'connection reset' };
    const s = seen();
    await switchTick(now);
    s.restore();
    expect(stored('a').fleetDb.mainConflict).toBeDefined();
    expect(s.warn).toContain("[Switch] A: copy.example no longer accepts writes as a main, but the bot's database login could not be opened (connection reset); the manager tries again every 5 minutes");
  });
  it('an unreachable peer does not end the conflict', async () => {
    withDb({ mainConflict: C });
    await switchTick(now);
    expect(stored('a').fleetDb.mainConflict).toBeDefined();
  });
});

describe('N-d: peerCheck', () => {
  it('checked again exactly 5 minutes later', async () => {
    await switchTick(now);
    await switchTick(now + SWITCH_TIMING.peerEveryMs);
    expect(probes('copy.example')).toBe(2);
  });
  it('an open login on a main with no conflict is not blocked', async () => {
    h.login = { inRecovery: false, canLogin: true, sessions: 0 };
    await switchTick(now);
    expect(h.events).not.toContain('block');
  });
  it('a main without replication probes no copy from its address list', async () => {
    writeRegistry({ a: mainFixture({ fleetDb: { ...NO_REPL, formerMain: { code: fakeJoinCode({ host: 'old.example', port: 5500, machine: 'old.example' }), slot: 'slot_c', machine: 'old.example', host: 'old.example', port: 5500, generation: 2, at: 'x' } } }) });
    await switchTick(now);
    expect(probes('copy.example')).toBe(0);
    expect(h.events).not.toContain('copies-sync');
  });
  it('a main with pushBroken does not sync its copies list', async () => {
    withDb({ pushBroken: { at: '2026-10-28T10:00:00.000Z', safetyDump: 'pre-push-x.dump' } });
    await switchTick(now);
    expect(h.events).not.toContain('copies-sync');
  });
  it('a sync that works logs nothing', async () => {
    const s = seen();
    await switchTick(now);
    s.restore();
    expect(h.events).toContain('copies-sync');
    expect(s.warn.filter(l => l.includes('copies could not be written'))).toEqual([]);
  });
});

describe('N50 to N60: formerCheck', () => {
  const FORMER = (over: Record<string, unknown> = {}) => ({ code: fakeJoinCode({ host: 'old.example', port: 5500, machine: 'old.example' }), slot: 'slot_c', machine: 'old.example', host: 'old.example', port: 5500, generation: 2, at: '2026-10-28T12:00:00.000Z', ...over });
  const old = (g: number) => (host: string) => (host === 'old.example'
    ? { kind: 'writable', systemId: '7001', timeline: 3, gen: { generation: g, machine: 'old.example', since: null }, receiveMark: false }
    : { kind: 'unreachable', reason: 'connection refused' }) as any;
  const formerPatches = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter(c => 'formerMain' in (c[1] as object)).length;
  it('a main without replication does not read the copies list for the old main', async () => {
    fake.dbs['a-pg'].addresses = [{ host: 'old.example', port: 5500, slot: 'slot_o', machine: 'old.example', cert: COPY_PEM }];
    fake.dbs['a-pg'].slots = { slot_o: { active: true, state: 'streaming', replay: '0/5000000' } };
    writeRegistry({ a: mainFixture({ fleetDb: { ...NO_REPL, formerMain: FORMER() } }) });
    await switchTick(now);
    expect(stored('a').fleetDb.formerMain).toBeDefined();
  });
  it('an unreachable old main gets no checkError', async () => {
    withDb({ formerMain: FORMER() });
    h.cert = { ok: false, kind: 'unreachable', reason: 'connection refused', text: 'x' };
    await switchTick(now);
    expect(stored('a').fleetDb.formerMain.checkError).toBeUndefined();
  });
  it('no checkError recorded: formerMain is not written', async () => {
    withDb({ formerMain: FORMER() });
    const spy = vi.spyOn(containerManager, 'updateInstanceFleetDbSwitch');
    await switchTick(now);
    const n = formerPatches(spy);
    spy.mockRestore();
    expect(n).toBe(0);
  });
  it('the client image does not pull: the old main is not probed', async () => {
    withDb({ formerMain: FORMER() });
    const spy = vi.spyOn(fleetJoin, 'ensureClientImage').mockResolvedValue('the probe image could not be pulled');
    await switchTick(now);
    spy.mockRestore();
    expect(probes('old.example')).toBe(0);
  });
  it("the probe names the old main's purpose", async () => {
    withDb({ formerMain: FORMER() });
    const purposes: unknown[] = [];
    const spy = vi.spyOn(fleetJoin, 'peerProbe').mockImplementation((async (_i: unknown, code: { host: string; port: number }, _p: string, purpose: unknown) => { if (code.host === 'old.example') purposes.push(purpose); return h.peer(code.host, code.port); }) as any);
    await switchTick(now);
    spy.mockRestore();
    expect(purposes).toEqual(['former']);
  });
  it('an unreachable old main: no registration', async () => {
    withDb({ formerMain: FORMER() });
    await switchTick(now);
    expect(h.registerCalls).toEqual([]);
  });
  it("this database's certificate does not read: not registered, logged", async () => {
    withDb({ formerMain: FORMER() });
    h.peer = old(2);
    const spy = vi.spyOn(fleetJoin, 'readCopyCert').mockResolvedValue(null as any);
    const s = seen();
    await switchTick(now);
    s.restore();
    spy.mockRestore();
    expect(h.registerCalls).toEqual([]);
    expect(s.warn).toContain("[Switch] A: the old main old.example runs again as a main; this machine's address could not be added to its copy list (this database's certificate could not be read)");
  });
  it('the registration fails: logged with the error', async () => {
    withDb({ formerMain: FORMER() });
    h.peer = old(2);
    h.register = 'connection refused';
    const s = seen();
    await switchTick(now);
    s.restore();
    expect(s.warn).toContain("[Switch] A: the old main old.example runs again as a main; this machine's address could not be added to its copy list (connection refused)");
  });
  it('a success then any error: both logged', async () => {
    withDb({ formerMain: FORMER() });
    h.peer = old(2);
    const s = seen();
    await switchTick(now);
    h.register = 'Stryker was here!';
    await switchTick(now + 6 * 60_000);
    s.restore();
    expect(s.log).toContain("[Switch] A: the old main old.example runs again as a main; this machine's address was added to its copy list");
    expect(s.warn).toContain("[Switch] A: the old main old.example runs again as a main; this machine's address could not be added to its copy list (Stryker was here!)");
  });
  it('a checkError of the same kind with another reason is replaced', async () => {
    withDb({ formerMain: FORMER({ code: '', checkError: { kind: 'code', reason: 'an older reason' } }) });
    await switchTick(now);
    expect(stored('a').fleetDb.formerMain.checkError.kind).toBe('code');
    expect(stored('a').fleetDb.formerMain.checkError.reason).not.toBe('an older reason');
  });
});

describe('N-e: rejoinCheck', () => {
  const MARK = { mode: 'stream', phase: 'stopped', slot: 'slot_c', machine: 'copy.example', host: 'copy.example', port: 5434, cert: COPY_PEM, generation: 4, at: '2026-10-30T09:00:00.000Z' };
  const handedOver = (mark: Record<string, unknown> = MARK) => writeRegistry({ a: mainFixture({ fleetDb: { ...(mainFixture().fleetDb as object), handover: mark } }) });
  beforeEach(() => {
    fake.dbs['a-pg'] = freshDb();
    h.sidecar['a-pg'] = false;
    handedOver();
  });
  it.each([
    ['mode', { mode: 'file' }],
    ['phase', { phase: 'streaming' }],
  ])('a mark of another %s is not checked', async (_n, over) => {
    handedOver({ ...MARK, ...over });
    await switchTick(now);
    expect(probes('copy.example')).toBe(0);
  });
  it('checked at most every 5 minutes, and again exactly at 5', async () => {
    await switchTick(now);
    await switchTick(now + 60_000);
    expect(probes('copy.example')).toBe(1);
    await switchTick(now + SWITCH_TIMING.peerEveryMs);
    expect(probes('copy.example')).toBe(2);
  });
  it('the texts name the machine, not the host', async () => {
    handedOver({ ...MARK, machine: 'copyname' });
    h.cert = { ok: false, kind: 'fingerprint', reason: 'fp differs', text: 'x' };
    await switchTick(now);
    expect(stored('a').fleetDb.handover.rejoinError).toBe("copyname shows another certificate than the one it registered (fp differs), so this machine did not rejoin it. Copy copyname's join code and paste it into Rejoin as a copy.");
  });
  it('a receive mark below the mark generation is not the reason', async () => {
    h.peer = writable(3, '7001', true);
    await switchTick(now);
    expect(stored('a').fleetDb.handover.lastCheck).toBe('copy.example has generation 3');
  });
  it('the same reason twice is written once', async () => {
    const spy = vi.spyOn(containerManager, 'updateInstanceFleetDbSwitch');
    await switchTick(now);
    await switchTick(now + 6 * 60_000);
    const n = spy.mock.calls.filter(c => 'handover' in (c[1] as object)).length;
    spy.mockRestore();
    expect(n).toBe(1);
  });
  it('the rejoin starts: logged with the machine, the re-seed asked without a confirm, no rejoinError', async () => {
    handedOver({ ...MARK, machine: 'copyname' });
    h.peer = writable(4);
    const args: unknown[][] = [];
    const spy = vi.spyOn(fleetReplica, 'reseedStalePrimary').mockImplementation(((...a: unknown[]) => { args.push(a); return h.reseed; }) as any);
    const s = seen();
    await switchTick(now);
    s.restore();
    spy.mockRestore();
    expect(s.log).toContain("[Switch] A: copyname is the main now (generation 4); rebuilding this machine's database as its copy after a dump of it");
    expect(args).toHaveLength(1);
    expect(args[0][4]).toBe(false);
    expect(stored('a').fleetDb.handover.rejoinError).toBeUndefined();
  });
});
