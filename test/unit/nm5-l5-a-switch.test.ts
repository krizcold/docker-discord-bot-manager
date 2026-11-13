import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-l5-a-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, hang: null as null | ((args: string[]) => boolean) };
});

vi.mock('child_process', async (o) => {
  const m = (await import('./switch-harness')).childProcessMock(await o()) as any;
  const { EventEmitter } = require('events') as typeof import('events');
  const { PassThrough } = require('stream') as typeof import('stream');
  const spawn = (cmd: string, args: string[], opts?: any) => {
    if (tmp.hang?.(args)) {
      const child: any = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = () => { setTimeout(() => child.emit('close', null), 1); return true; };
      return child;
    }
    return m.spawn(cmd, args, opts);
  };
  return { ...m, spawn, default: { ...m.default, spawn } };
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

import * as fs from 'fs';
import {
  SWITCH_TIMING, composeJoinCode, ensureMainGeneration, formerVerdict, handOverMain, heldVerdict, noticeDue, noticeState, peerCode, peerVerdict,
  rejoinDue, runLane, startLane, switchAdmissionNotice, takeOverMain,
} from '../../src/instance/fleetSwitch';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { COPY_PEM, copyFixture, fake, freshDb, h, mainFixture, resetHarness, writeRegistry } from './switch-harness';
import { fakeJoinCode } from './join-fake';

const TIMING = { ...SWITCH_TIMING };
beforeEach(() => {
  resetHarness();
  Object.assign(SWITCH_TIMING, TIMING, { replayWaitMs: 50, pollMs: 5 });
  tmp.hang = null;
  vi.restoreAllMocks();
  fake.dbs['c-pg'] = freshDb({ recovery: true, generation: { generation: 3, machine: 'main.invalid', since: '2026-10-28T10:00:00Z' }, handover: null, addresses: [
    { host: 'main.invalid', port: 15432, slot: null, machine: 'main.invalid', cert: COPY_PEM },
  ] });
  writeRegistry({ c: copyFixture(), a: mainFixture() });
});
afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

const blockedText = (e: string) => `The copy was not promoted: the bot's login to it could not be blocked first (${e}), and a copy promoted with that login open could be taken for the main before its generation is raised. The copy still follows the main; press Take over again.`;
const dbOf = (input: string) => { const c = fake.calls.find(x => x.input.includes(input))!; return c.args[c.args.indexOf('-d') + 1]; };

describe('the take-over block on the copy', () => {
  it('the TCP probe runs the exact argv, and the reload, hba_file and timeout reads go to postgres', async () => {
    h.login = { inRecovery: true, canLogin: true, sessions: 0 };
    fake.dbs['c-pg'].authTimeout = '0';
    expect((await takeOverMain('c', { confirm: true })).success).toBe(true);
    const probe = fake.calls.find(c => c.args.includes('127.0.0.1'))!;
    expect(probe.args).toEqual(['exec', 'c-pg', 'psql', '-h', '127.0.0.1', '-U', 'app', '-d', 'app', '-w', '-tAc', 'SELECT 1']);
    expect(dbOf('pg_reload_conf()')).toBe('postgres');
    expect(dbOf("current_setting('hba_file')")).toBe('postgres');
    expect(dbOf("name = 'authentication_timeout'")).toBe('postgres');
  });
  it('the proof polls again within blockProbeMs until the rejection shows', async () => {
    SWITCH_TIMING.blockProbeMs = 5000;
    SWITCH_TIMING.blockGapMs = 5;
    const d = fake.dbs['c-pg'];
    let n = 0;
    Object.defineProperty(d, 'hbaLive', { get: () => d.hbaFileBlock && ++n >= 3, set: () => undefined, configurable: true });
    expect((await takeOverMain('c', { confirm: true })).success).toBe(true);
  });
  it('with Date.now frozen and no probe time, one failed probe ends the proof', async () => {
    SWITCH_TIMING.blockProbeMs = 0;
    SWITCH_TIMING.blockGapMs = 5;
    const d = fake.dbs['c-pg'];
    let n = 0;
    Object.defineProperty(d, 'hbaLive', { get: () => d.hbaFileBlock && ++n >= 2, set: () => undefined, configurable: true });
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const r = await takeOverMain('c', { confirm: true });
    expect(r.text).toBe(blockedText('a login over TCP was still admitted after 0 seconds'));
  });
  it('a probe that hangs ends at readMs and reads as not rejected', async () => {
    SWITCH_TIMING.readMs = 40;
    SWITCH_TIMING.blockProbeMs = 0;
    tmp.hang = args => args.includes('127.0.0.1');
    const r = await takeOverMain('c', { confirm: true });
    expect(r.text).toBe(blockedText('a login over TCP was still admitted after 0 seconds'));
  });
  it('a block script that hangs ends at readMs', async () => {
    SWITCH_TIMING.readMs = 40;
    tmp.hang = args => args[1] === '-u' && args[2] === 'root';
    const r = await takeOverMain('c', { confirm: true });
    expect(r.text).toBe(blockedText('no answer within 0 seconds'));
  });
  it('a failed hba_file read answers its error', async () => {
    fake.dbs['c-pg'].fail['hba-file'] = 'ERROR:  permission denied to examine "hba_file"';
    const r = await takeOverMain('c', { confirm: true });
    expect(r.text).toBe(blockedText('ERROR:  permission denied to examine "hba_file"'));
  });
  it('an unreadable authentication_timeout refuses with its answer', async () => {
    h.login = { inRecovery: true, canLogin: true, sessions: 0 };
    fake.dbs['c-pg'].authTimeout = 'abc';
    const r = await takeOverMain('c', { confirm: true });
    expect(r.text).toBe(blockedText('authentication_timeout could not be read (abc)'));
  });
  it('a session end failure without a count answers its error', async () => {
    h.endSessions = { ok: false, cls: 'other', error: 'the session end timed out', left: undefined } as any;
    const r = await takeOverMain('c', { confirm: true });
    expect(r.text).toBe(blockedText('the session end timed out'));
  });
  it('a lift whose proof never clears names the seconds', async () => {
    SWITCH_TIMING.blockProbeMs = 600;
    SWITCH_TIMING.blockGapMs = 50;
    const d = fake.dbs['c-pg'];
    Object.defineProperty(d, 'hbaLive', { get: () => true, set: () => undefined, configurable: true });
    const r = await takeOverMain('c', { confirm: true });
    expect(r.text).toBe("This machine's database is the main now (generation 4), but the bot's login to it is still blocked (pg_hba still rejected the bot's login after 1 seconds): the line the take-over put in its pg_hba.conf could not be removed. Press Take over again to finish.");
  });
});

describe('ensureMainGeneration', () => {
  it('a main without a row gets one and logs nothing', async () => {
    fake.dbs['a-pg'] = freshDb({ generation: null });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await ensureMainGeneration('a');
    expect(fake.dbs['a-pg'].generation?.generation).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('handOverMain refuses a slot name that is not whole', () => {
  it.each(['Xslot_c', 'slot_c-'])('%s', async slot => {
    expect(await handOverMain('a', slot, false)).toEqual({ success: false, status: 409, text: `No copy uses the slot ${slot} any more; reload the Database window and pick a copy that is streaming` });
  });
});

describe('composeJoinCode and peerCode', () => {
  const target = { host: 'copy.example', port: 5434, cert: COPY_PEM, machine: 'copy.example' };
  const inst = (over: Record<string, unknown> = {}) => ({ ...(containerManager.getBot('a') as object), ...over }) as any;
  it("without the replication login", () => {
    expect(composeJoinCode(inst({ fleetDb: { ...(inst().fleetDb), replication: { ...inst().fleetDb.replication, password: '' } } }), target)).toEqual({ ok: false, error: "this machine's replication login is not stored" });
  });
  it('without the bot password on record (NM14 CJ-ABSENT, CJ-LOST)', () => {
    const { password: _p, ...absent } = inst().fleetDb;
    expect(composeJoinCode(inst({ fleetDb: absent }), target)).toEqual({ ok: false, error: "the managed database's password is not on record (a join code or Enable records it from a Database URL whose password this database accepts)" });
    expect(composeJoinCode(inst({ fleetDb: { ...inst().fleetDb, password: '' } }), target)).toEqual({ ok: false, error: "the managed database's password on record no longer decrypts" });
  });
  it('with a certificate that does not read', () => {
    expect(composeJoinCode(inst(), { ...target, cert: 'junk' })).toEqual({ ok: false, error: 'the registered certificate does not read' });
  });
  it("a former main's own code is not used when the recorded certificate does not read", () => {
    const code = fakeJoinCode({ host: 'copy.example', port: 5434 });
    const i = inst({ fleetDb: { ...inst().fleetDb, formerMain: { host: 'copy.example', port: 5434, code } } });
    expect(peerCode(i, { ...target, cert: 'junk' })).toEqual({ ok: false, error: 'the registered certificate does not read' });
  });
});

describe('the pure verdicts', () => {
  it('heldVerdict names its default reason, and the push question', () => {
    expect((heldVerdict(undefined, false) as { refuse: string }).refuse).toBe("The bot did not answer the maintenance order (it did not answer), so the manager can't confirm it saved the changes it holds; the hand-over was refused and nothing was changed. Choose Maintenance again while the bot runs, or choose Off.");
    expect((heldVerdict({ state: 'stopped' } as any, false, 'push') as { ask: string }).ask).toBe('The bot was stopped without confirming that it saved what it held. Whatever it had not saved was lost at that stop, not by this push, which loses nothing more. Push anyway?');
  });
  it('peerVerdict and formerVerdict without a system id compare generations', () => {
    const p = { kind: 'writable', systemId: '7001', timeline: 1, gen: { generation: 5, machine: 'm', since: null } } as any;
    expect(peerVerdict(3, p, null)).toBe('replaced');
    expect(formerVerdict(3, p, null)).toBe('replaced');
  });
  it('noticeDue', () => {
    const row = (g: number) => ({ generation: g, machine: 'm', since: null });
    expect(noticeDue(row(2), undefined, 0, true)).toBe(true);
    expect(noticeDue(row(3), { generation: 5, state: 'pending', triedAt: 0 } as any, 10 * 3_600_000, true)).toBe(false);
  });
  it('noticeState without an error says no reason given', () => {
    expect(noticeState({ ok: false, status: 409 })).toEqual({ state: 'refused', error: 'no reason given' });
    expect(noticeState({ ok: false, unknown: true })).toEqual({ state: 'unknown', error: 'no reason given' });
    expect(noticeState({ ok: false })).toEqual({ state: 'pending', error: 'no reason given' });
  });
  it('rejoinDue', () => {
    const mark = { mode: 'stream', phase: 'stopped', host: 'h', port: 1, cert: 'c', generation: 3, rejoinTriedAt: 1000 } as any;
    const probe = { kind: 'writable', systemId: '7001', timeline: 1, gen: { generation: 4, machine: 'm', since: null }, receiveMark: false } as any;
    expect(rejoinDue(mark, probe, 1000 + SWITCH_TIMING.rejoinRetryMs, '7001')).toBe(true);
    expect(rejoinDue({ ...mark, mode: 'dump' }, probe, 1000 + SWITCH_TIMING.rejoinRetryMs, '7001')).toBe(false);
  });
});

describe('the lanes', () => {
  const boom = async () => ({ success: true, text: 'x', after: async () => { throw new Error('boom'); } });
  it('both refuse while the manager shuts down', async () => {
    vi.spyOn(containerManager, 'isShuttingDown').mockReturnValue(true);
    const want = { success: false, text: containerManager.SHUTDOWN_REFUSAL, status: 503 };
    expect(await startLane('a', 'switch', boom, () => undefined)).toEqual(want);
    expect(await runLane('a', 'switch', boom)).toEqual(want);
  });
  it('an error before admit is the route answer', async () => {
    const done = vi.fn();
    expect(await startLane('a', 'switch', boom, done)).toEqual({ success: false, text: 'The switch stopped on an unexpected error: boom', status: 500 });
    expect(done).not.toHaveBeenCalled();
  });
  it('an error after admit goes to onDone', async () => {
    let got: unknown;
    const finished = new Promise<void>(r => { const t = setTimeout(r, 2000); (globalThis as any).__l5a = () => { clearTimeout(t); r(); }; });
    const r = await startLane('a', 'switch', async admit => { admit(); return boom(); }, x => { got = x; (globalThis as any).__l5a(); });
    expect(r).toEqual({ accepted: true });
    await finished;
    expect(got).toEqual({ success: false, text: 'The switch stopped on an unexpected error: boom', status: 500 });
  });
  it('runLane answers the error', async () => {
    expect(await runLane('a', 'switch', boom)).toEqual({ success: false, text: 'The switch stopped on an unexpected error: boom', status: 500 });
  });
});

describe('switchAdmissionNotice', () => {
  const NOTICE = 'A restore of x.dump has not finished cleanly (its notice is on the Database window), so the hand-over was refused and nothing was changed: the database would move in that state. Restore a dump again, or dismiss the notice, first.';
  it('a restore notice refuses unless skipped', async () => {
    h.memoryNotice = 'x.dump';
    expect(await switchAdmissionNotice('a', 'the hand-over was refused')).toBe(NOTICE);
    expect(await switchAdmissionNotice('a', 'the hand-over was refused', { skipNotice: true })).toBeNull();
  });
  it('without a notice the read-only layer is read', async () => {
    h.fence = { ok: false, cls: 'other', error: 'no answer' };
    expect(await switchAdmissionNotice('a', 'the hand-over was refused')).toBe("The manager could not read whether the bot's database is READ-ONLY (no answer), so the hand-over was refused and nothing was changed");
  });
});
