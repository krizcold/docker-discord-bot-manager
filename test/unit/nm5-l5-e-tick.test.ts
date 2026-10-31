import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-l5-e-tick-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, reseedArgs: [] as unknown[][], failSlots: { on: false } };
});

vi.mock('child_process', async (o) => {
  const base = (await import('./switch-harness')).childProcessMock(await o()) as any;
  const { fake } = await import('./switch-fake');
  const spawn = (cmd: string, args: string[], opts?: any) => {
    const c = base.spawn(cmd, args, opts);
    const entry = fake.calls[fake.calls.length - 1];
    const emit = c.emit.bind(c);
    c.emit = (e: string, ...a: unknown[]) => (e === 'close' && tmp.failSlots.on && entry.input.includes("s.slot_type = 'physical'") ? emit('close', 1) : emit(e, ...a));
    return c;
  };
  return { ...base, spawn, default: { ...base.default, spawn } };
});
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./switch-harness')).dbLoginMock(await o()));
vi.mock('../../src/instance/maintenance', async (o) => (await import('./switch-harness')).maintenanceMock(await o()));
vi.mock('../../src/docker/containerManager', async (o) => (await import('./switch-harness')).containerManagerMock(await o()));
vi.mock('../../src/instance/fleetBackup', async (o) => (await import('./switch-harness')).fleetBackupMock(await o()));
vi.mock('../../src/instance/fleetJoin', async (o) => (await import('./switch-harness')).fleetJoinMock(await o()));
vi.mock('../../src/instance/fleetReplica', async (o) => {
  const m = (await import('./switch-harness')).fleetReplicaMock(await o()) as any;
  const inner = m.reseedStalePrimary;
  return { ...m, reseedStalePrimary: (...a: unknown[]) => { tmp.reseedArgs.push(a); return inner(...a); } };
});
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./switch-harness')).appHookMock(await o()));
vi.mock('../../src/instance/backupCheck', async (o) => (await import('./switch-harness')).backupCheckMock(await o()));
vi.mock('../../src/env/manager', async (o) => (await import('./switch-harness')).envMock(await o()));
vi.mock('../../src/config/appCapabilities', async (o) => (await import('./switch-harness')).capsMock(await o()));

import * as fs from 'fs';
import { rejoinComposed, resetSwitchState, streamingCopies, switchTick } from '../../src/instance/fleetSwitch';
import { beginShutdown, getBot } from '../../src/docker/containerManager';
import { COPY_PEM, MAIN, fake, freshDb, h, mainFixture, resetHarness, stored, writeRegistry } from './switch-harness';
import { fakeJoinCode } from './join-fake';

const withDb = (extra: Record<string, unknown> = {}) => writeRegistry({ a: mainFixture({ fleetDb: { ...MAIN, ...extra } }) });
const spy = (level: 'log' | 'warn' | 'error') => { const seen: string[] = []; const s = vi.spyOn(console, level).mockImplementation((m: unknown) => { seen.push(String(m)); }); return { seen, done: () => s.mockRestore() }; };
const inputs = (container = 'a-pg') => fake.calls.filter(c => c.args.includes(container)).map(c => c.input);
const MARK = { mode: 'stream', phase: 'stopped', slot: 'slot_c', machine: 'copy.example', host: 'copy.example', port: 5434, cert: COPY_PEM, generation: 4, at: '2026-10-30T09:00:00.000Z' };
const PENDING = { pending: true, file: 'r.dump', at: 'x', generation: 3, machine: 'm', since: null };
let now = Date.parse('2026-10-31T10:00:00Z');

beforeEach(() => {
  resetHarness();
  resetSwitchState();
  tmp.reseedArgs.length = 0;
  tmp.failSlots.on = false;
  fake.dbs['a-pg'] = freshDb();
  withDb();
  now += 31 * 60_000;
});
afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

describe('L5 e: rejoinComposed', () => {
  it('a bot without a main database: refused with the exact error', () => {
    writeRegistry({ a: mainFixture({ fleetDb: undefined }) });
    expect(rejoinComposed('a')).toEqual({ success: false, error: 'This instance holds no main database to rebuild' });
  });
  it('a push move recorded with an address is no rejoin target', () => {
    withDb({ handover: { ...MARK, mode: 'push' } });
    expect(rejoinComposed('a')).toEqual({ success: false, error: 'No main is recorded to rejoin; paste its join code instead' });
    expect(tmp.reseedArgs).toEqual([]);
  });
  it('a stream hand-over is the target, and the re-seed is not pre-confirmed', () => {
    withDb({ handover: MARK });
    expect(rejoinComposed('a')).toEqual({ success: true, started: true });
    expect(tmp.reseedArgs).toHaveLength(1);
    expect(tmp.reseedArgs[0].slice(2, 5)).toEqual(['main.example', 5433, false]);
  });
  it('a code that cannot be composed: refused naming why', () => {
    const { replication: _r, ...noRepl } = MAIN;
    writeRegistry({ a: mainFixture({ fleetDb: { ...noRepl, handover: MARK } }) });
    expect(rejoinComposed('a')).toEqual({ success: false, error: "The join code could not be composed (this machine's replication login is not stored); paste the main's join code instead" });
  });
});

describe('L5 e: the restore record cleared by the tick', () => {
  const clears = () => inputs().filter(s => s.includes('UPDATE smdb_manager.restore_state SET pending = false'));
  it('no restore record: no clear is sent', async () => {
    await switchTick(now);
    expect(clears()).toEqual([]);
  });
  it('a pending record on a database in recovery: no clear is sent', async () => {
    fake.dbs['a-pg'].restoreState = { ...PENDING };
    h.login = { inRecovery: true, canLogin: false, sessions: 0 };
    await switchTick(now);
    expect(clears()).toEqual([]);
  });
  it('a pending record is cleared in the postgres database with no warning', async () => {
    fake.dbs['a-pg'].restoreState = { ...PENDING };
    const warn = spy('warn');
    await switchTick(now);
    warn.done();
    const call = fake.calls.find(c => c.input.includes('UPDATE smdb_manager.restore_state SET pending = false'))!;
    expect(call.args[call.args.indexOf('-d') + 1]).toBe('postgres');
    expect(warn.seen.filter(l => l.includes('restore record'))).toEqual([]);
  });
  it('a failed clear is logged', async () => {
    fake.dbs['a-pg'].restoreState = { ...PENDING };
    fake.dbs['a-pg'].fail['restore-clear'] = 'ERROR:  disk full';
    const warn = spy('warn');
    await switchTick(now);
    warn.done();
    expect(warn.seen.filter(l => l.startsWith('[Switch] A: the restore record could not be marked finished ('))).toHaveLength(1);
  });
});

describe('L5 e: the stale receive mark', () => {
  const removed = "[Switch] A: removed a receive mark that no receive or unfinished push on this machine stands for";
  const failed = (l: string) => l.startsWith('[Switch] A: a receive mark that no receive or unfinished push on this machine stands for could not be removed');
  it('no mark table, or no mark: nothing is logged as removed', async () => {
    const log = spy('log');
    fake.dbs['a-pg'].markTable = false;
    await switchTick(now);
    fake.dbs['a-pg'].markTable = true;
    await switchTick(now + 60_000);
    log.done();
    expect(log.seen).not.toContain(removed);
  });
  it('the mark is read in the postgres database', async () => {
    await switchTick(now);
    const call = fake.calls.find(c => c.input.includes("FROM smdb_manager.receive_mark), '')"))!;
    expect(call.args[call.args.indexOf('-d') + 1]).toBe('postgres');
  });
  it('a removal resets the logged failure, so the next failure is logged again', async () => {
    const warn = spy('warn');
    const log = spy('log');
    fake.dbs['a-pg'].fail['mark-read'] = 'ERROR:  boom';
    await switchTick(now);
    await switchTick(now + 60_000);
    delete fake.dbs['a-pg'].fail['mark-read'];
    fake.dbs['a-pg'].receiveMark = { markId: 'a1', pushIds: ['a1'], dbOid: '16384' };
    await switchTick(now + 120_000);
    fake.dbs['a-pg'].fail['mark-read'] = 'ERROR:  boom';
    await switchTick(now + 180_000);
    warn.done();
    log.done();
    expect(log.seen).toContain(removed);
    expect(warn.seen.filter(failed)).toHaveLength(2);
  });
  it('resetSwitchState forgets the logged failure', async () => {
    const warn = spy('warn');
    fake.dbs['a-pg'].fail['mark-read'] = 'ERROR:  boom';
    await switchTick(now);
    resetSwitchState();
    await switchTick(now + 60_000);
    warn.done();
    expect(warn.seen.filter(failed)).toHaveLength(2);
  });
});

describe('L5 e: resetSwitchState forgets the other logged states', () => {
  it('the generation row failure is logged again after a reset', async () => {
    fake.dbs['a-pg'].generation = null;
    fake.dbs['a-pg'].tables = false;
    fake.dbs['a-pg'].fail.ensure = 'ERROR:  boom';
    const warn = spy('warn');
    await switchTick(now);
    resetSwitchState();
    await switchTick(now + 60_000);
    warn.done();
    expect(warn.seen.filter(l => l.includes('the generation row could not be written'))).toHaveLength(2);
  });
  it('the copies list failure is logged again after a reset', async () => {
    fake.dbs['a-pg'].fail['copies-sync'] = 'ERROR:  boom';
    const warn = spy('warn');
    await switchTick(now);
    resetSwitchState();
    await switchTick(now + 60_000);
    warn.done();
    expect(warn.seen.filter(l => l.includes("the list of this database's copies could not be written"))).toHaveLength(2);
  });
  it('the old main registration failure is logged again after a reset', async () => {
    withDb({ formerMain: { code: fakeJoinCode({ host: 'old.example', port: 5500, machine: 'old.example' }), slot: 'slot_c', machine: 'old.example', host: 'old.example', port: 5500, generation: 2, at: '2026-10-28T12:00:00.000Z' } });
    h.peer = (host: string) => (host === 'old.example' ? { kind: 'writable', systemId: '7001', timeline: 3, gen: { generation: 2, machine: 'old.example', since: null } } : { kind: 'unreachable', reason: 'connection refused' }) as any;
    h.register = 'refused';
    const warn = spy('warn');
    await switchTick(now);
    resetSwitchState();
    await switchTick(now + 60_000);
    warn.done();
    expect(warn.seen.filter(l => l.includes('runs again as a main') && l.includes('(refused)'))).toHaveLength(2);
  });
  it('the rejoin check runs again right after a reset', async () => {
    withDb({ handover: MARK });
    h.sidecar['a-pg'] = false;
    await switchTick(now);
    resetSwitchState();
    await switchTick(now + 1000);
    expect(h.events.filter(e => e === 'probe:copy.example')).toHaveLength(2);
  });
});

describe('L5 e: the tick', () => {
  it('a main with neither replication nor a former main is not peer-checked', async () => {
    const { replication: _r, ...noRepl } = MAIN;
    writeRegistry({ a: mainFixture({ fleetDb: noRepl }) });
    await switchTick(now);
    expect(inputs().some(s => s.includes('pg_control_system()'))).toBe(false);
  });
  it('a tick that finds one running does nothing', async () => {
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    let first = true;
    fake.dbs['a-pg'].beforeAnswer = () => { if (first) { first = false; return held; } };
    const p1 = switchTick(now);
    await new Promise(r => setTimeout(r, 50));
    const n = fake.calls.length;
    const p2 = switchTick(now + 1);
    await new Promise(r => setTimeout(r, 50));
    expect(fake.calls.length).toBe(n);
    release();
    await Promise.all([p1, p2]);
  });
  it('a bot whose check throws: the error is logged and the tick goes on', async () => {
    Object.defineProperty(h.sidecar, 'a-pg', { enumerable: true, configurable: true, get: () => { throw new Error('boom'); } });
    const err = spy('error');
    await switchTick(now);
    err.done();
    expect(err.seen).toContain('[Switch] A: the switch check failed: boom');
  });
  it('streamingCopies: the physical slots, parsed and filtered', async () => {
    fake.dbs['a-pg'] = freshDb({
      slots: {
        slot_a: { active: true, state: 'streaming', replay: '0/1' },
        slot_b: { active: false, state: '', replay: '0/1' },
        ' slot_d': { active: true, state: 'streaming', replay: '0/1' },
        BAD: { active: true, state: 'streaming', replay: '0/1' },
        slot_e: { active: true, state: 'streaming', replay: '0/1' },
      },
      addresses: [
        { host: 'c', port: 1, slot: 'slot_a', machine: 'copy.example', cert: 'x' },
        { host: 'd', port: 1, slot: ' slot_d', machine: 'd.example', cert: 'x' },
        { host: 'e', port: 1, slot: 'slot_e', machine: 'x|y', cert: 'x' },
      ],
    });
    const inst = getBot('a')!;
    expect(await streamingCopies(inst)).toEqual([
      { slot: 'slot_a', streaming: true, machine: 'copy.example' },
      { slot: 'slot_b', streaming: false, machine: 'slot_b' },
      { slot: 'slot_d', streaming: true, machine: 'd.example' },
    ]);
    tmp.failSlots.on = true;
    expect(await streamingCopies(inst)).toEqual([]);
    tmp.failSlots.on = false;
    h.sidecar['a-pg'] = false;
    expect(await streamingCopies(inst)).toEqual([]);
  });
  it('a shutdown that starts during one bot skips the next bot', async () => {
    writeRegistry({ a: mainFixture(), b: mainFixture({ fleetDb: { ...MAIN, containerName: 'b-pg' } }) });
    fake.dbs['b-pg'] = freshDb();
    fake.dbs['a-pg'].beforeAnswer = () => beginShutdown();
    fake.dbs['b-pg'].beforeAnswer = () => beginShutdown();
    await switchTick(now);
    const a = inputs('a-pg').length;
    const b = inputs('b-pg').length;
    expect(a > 0 && b > 0).toBe(false);
    expect(stored('a')).toBeDefined();
  });
});
