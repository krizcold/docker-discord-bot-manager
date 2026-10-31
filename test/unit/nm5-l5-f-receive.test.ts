import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-l5-f-receive-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, join: { success: true, joinCode: '' } as { success: boolean; joinCode?: string; error?: string } };
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
  getJoinCode: async () => tmp.join,
}));

import * as fs from 'fs';
import { encodeJoinCode } from '../../src/config/joinCode';
import { MOVE_TIMING, receive, receiveMain, receiveStep, stopReceive, stopReceiving } from '../../src/instance/fleetMove';
import { claimFleetBackupBusy, releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import * as containerManager from '../../src/docker/containerManager';
import * as maintenance from '../../src/instance/maintenance';
import { COPY_PEM, fake, fakeJoin, freshDb, h, mainFixture, resetHarness, stored, writeRegistry } from './switch-harness';

const NOTHING = '; nothing was changed';
const DUMP = 'pre-receive-2026-10-28T12-00-00-000Z.dump';
const OFF = { state: 'off', message: '', orderedAt: '2026-10-30T00:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: 'maintenance' };
const off = (over: Record<string, unknown> = {}, id = 'a') => writeRegistry({ [id]: mainFixture({ maintenance: OFF, ...over }) });
const ROW = { host: 'copy.example', port: 5434, slot: 'slot_c', cert: COPY_PEM.trim(), machine: 'copy.example' };
const withCopy = () => {
  fake.dbs['a-pg'].slots = { slot_c: { active: true, state: 'streaming', replay: '0/5000000' } };
  fake.dbs['a-pg'].addresses = [{ ...ROW }];
};
const later = () => Date.now() + 25 * 60 * 60_000;
const step = (id = 'a', now = later()) => receiveStep(containerManager.getBot(id)!, now);
const pushed = (id = 'a') => fake.dbs['a-pg'].received.push({ pushId: stored(id).fleetDb.receive.pushId, from: '9', machine: 'win.local', generation: 6 });
const dbOf = (args: string[]) => args[args.indexOf('-d') + 1];
const callsWith = (text: string) => fake.calls.filter(c => c.args[0] === 'exec' && c.input.includes(text));
const capture = (kind: 'log' | 'warn') => {
  const out: string[] = [];
  const spy = vi.spyOn(console, kind).mockImplementation((m: unknown) => { out.push(String(m)); });
  return { out, restore: () => spy.mockRestore() };
};

beforeEach(() => {
  resetHarness({ proof: { ok: true, state: 'off', enforcement: 'database', botConfirmed: true } });
  releaseFleetBackupBusy('a');
  fake.dbs['a-pg'] = freshDb();
  MOVE_TIMING.sessionPauseMs = 0;
  tmp.join = { success: true, joinCode: encodeJoinCode(fakeJoin({ host: 'main.example', port: 5433 })) };
  off();
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

describe('L5 f: Receive', () => {
  it('the mark lasts 24 hours from now, has no prior ids, and the backup slot is free again', async () => {
    const r = await receive('a');
    expect(r.success).toBe(true);
    const rec = stored('a').fleetDb.receive;
    const span = Date.parse(rec.expiresAt) - Date.parse(rec.startedAt);
    expect(span).toBeGreaterThanOrEqual(24 * 60 * 60_000);
    expect(span).toBeLessThan(24 * 60 * 60_000 + 5_000);
    expect(rec.priorIds).toEqual([]);
    expect(claimFleetBackupBusy('a')).toBe(true);
    releaseFleetBackupBusy('a');
  });
  it('the identity read and the mark row go to the postgres database', async () => {
    await receive('a');
    const oid = callsWith('oid::text FROM pg_database WHERE datname');
    const mark = callsWith('INSERT INTO smdb_manager.receive_mark');
    const role = callsWith('CREATE ROLE smdb_receive');
    expect(oid.length).toBe(1);
    expect(mark.length).toBe(1);
    expect(role.length).toBe(1);
    for (const c of [...oid, ...mark, ...role]) expect(dbOf(c.args)).toBe('postgres');
  });
  it('the backup slot busy: SLOT_BUSY', async () => {
    expect(claimFleetBackupBusy('a')).toBe(true);
    const r = await receiveMain('a');
    expect(r).toMatchObject({ success: false, status: 409, text: `A backup or restore operation is in progress on this database; wait for it to finish${NOTHING}` });
    expect(h.events).not.toContain('dump:pre-receive-');
  });
  it('the dump failing without a reason', async () => {
    h.dump = { success: false };
    expect((await receive('a')).text).toBe('The dump of this database failed (no reason given), so nothing was changed');
    expect(claimFleetBackupBusy('a')).toBe(true);
  });
  it.each([
    ['Running', { ...OFF, state: 'running' }, 'Running'],
    ['an unsettled Off', { ...OFF, settled: false }, 'Off, not confirmed'],
  ])('not a settled Off: %s', async (_n, rec, shown) => {
    off({ maintenance: rec });
    expect((await receive('a')).text).toBe(`Receiving replaces this machine's database, so the bot must be Off first (its state is ${shown}); choose Off in the State window${NOTHING}`);
  });
  it('maintenance not proven: its error', async () => {
    h.proof = { ok: false, error: 'the bot did not confirm its maintenance' };
    expect((await receive('a')).text).toBe('Receiving was refused and nothing was changed: the bot did not confirm its maintenance');
  });
  it('the fence check skips the notice read (a notice shown after the first read does not refuse)', async () => {
    vi.spyOn(maintenance, 'requireMaintenance').mockImplementation(async () => { h.memoryNotice = 'restore-x.dump'; return h.proof as any; });
    const r = await receive('a');
    expect(r.success).toBe(true);
  });
  it('under pushBroken with no mark: admitted', async () => {
    off({ fleetDb: { ...(mainFixture().fleetDb as object), pushBroken: { at: '2026-10-29T08:00:00.000Z', safetyDump: 'pre-receive-old.dump' } } });
    const r = await receive('a');
    expect(r.success).toBe(true);
    expect(stored('a').fleetDb.receive.safetyDump).toBe('pre-receive-old.dump');
  });
  it('the identity read fails', async () => {
    fake.dbs['a-pg'].fail['oid-read'] = 'ERROR:  out of memory';
    expect((await receive('a')).text).toBe(`The manager could not read this database's identity before receiving (ERROR:  out of memory), so it could not tell later whether a push replaced it; the dump ${DUMP} was kept and nothing else was changed`);
    expect(stored('a').fleetDb.receive).toBeUndefined();
  });
  it('the bot database missing (an empty oid line)', async () => {
    fake.dbs['a-pg'].botDbMissing = true;
    expect((await receive('a')).text).toBe(`The manager could not read this database's identity before receiving (the database is missing), so it could not tell later whether a push replaced it; the dump ${DUMP} was kept and nothing else was changed`);
    expect(stored('a').fleetDb.receive).toBeUndefined();
  });
  it('a join code that does not decode', async () => {
    tmp.join = { success: true, joinCode: 'smdbjoin1.notacode' };
    expect((await receive('a')).text).toBe(`The move code could not be made (the join code did not decode); the dump ${DUMP} was kept and nothing else was changed`);
  });
  it('the join code not read, with no error given', async () => {
    tmp.join = { success: false };
    expect((await receive('a')).text).toBe(`The move code could not be made (the join code did not decode); the dump ${DUMP} was kept and nothing else was changed`);
  });
  it('Receive again on a mark without priorIds: the new mark lists only the earlier id', async () => {
    off({ fleetDb: { ...(mainFixture().fleetDb as object), receive: { startedAt: '2026-10-30T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', safetyDump: DUMP, pushId: 'p1', dbOid: '16384' } } });
    const r = await receive('a');
    expect(r.success).toBe(true);
    expect(stored('a').fleetDb.receive.priorIds).toEqual(['p1']);
  });
  it.each([
    ['the smdb_manager tables missing', (d: any) => { d.tables = false; }],
    ['the bot database missing', (d: any) => { d.fail['received-read'] = 'psql: error: FATAL:  database "app" does not exist'; }],
  ])('Receive again, the received read says %s: no push finished, a new code', async (_n, set) => {
    await receive('a');
    const first = stored('a').fleetDb.receive;
    set(fake.dbs['a-pg']);
    const r = await receive('a');
    expect(r.success).toBe(true);
    expect(r.moveCode).toBeTruthy();
    expect(stored('a').fleetDb.receive.priorIds).toEqual([first.pushId]);
  });
  it('Receive again after the push finished, with 12 sessions left: three rounds, two pauses, RV-STOPFAIL with the count', async () => {
    await receive('a');
    pushed();
    const d = fake.dbs['a-pg'];
    d.sessions.smdb_receive = 12;
    d.pinnedSessions.smdb_receive = true;
    MOVE_TIMING.sessionPauseMs = 7;
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const r = await receive('a');
    const pauses = spy.mock.calls.filter(c => c[1] === 7).length;
    spy.mockRestore();
    expect(r).toMatchObject({ success: false, status: 500, text: 'The receive login could not be removed (12 session(s) did not end); try again.' });
    expect(pauses).toBe(2);
  });
  it('Receive again after the push finished, the save throws: NOT_MARKED', async () => {
    await receive('a');
    pushed();
    h.failSwitchWrite = 'ENOSPC';
    expect(await receive('a')).toMatchObject({ success: false, status: 500, text: 'The receive login was removed, but receiving could not be marked stopped (ENOSPC); try again.' });
  });
});

describe('L5 f: Stop receiving', () => {
  it('unknown bot, and no mark', async () => {
    expect(await receiveMain('zz')).toEqual({ success: false, status: 404, text: 'Bot not found' });
    expect(await stopReceiving('zz')).toEqual({ success: false, status: 404, text: 'Bot not found' });
    expect(await stopReceiving('a')).toEqual({ success: false, status: 409, text: 'This database is not waiting to receive a main' });
  });
  it('every step of the login end, the check and the mark removal go to the postgres database; no warning', async () => {
    await receive('a');
    fake.calls.length = 0;
    const warn = capture('warn');
    const r = await stopReceive('a');
    warn.restore();
    expect(r.success).toBe(true);
    for (const text of ['ALTER ROLE smdb_receive NOLOGIN', 'pg_terminate_backend', 'DROP ROLE', 'oid::text FROM pg_database WHERE datname', 'DELETE FROM smdb_manager.receive_mark']) {
      const calls = callsWith(text);
      expect(calls.length, text).toBeGreaterThan(0);
      for (const c of calls) expect(dbOf(c.args), text).toBe('postgres');
    }
    expect(warn.out).toEqual([]);
  });
  it('a session count that does not read as an integer: RV-STOPFAIL with that reason', async () => {
    await receive('a');
    fake.dbs['a-pg'].sessions.smdb_receive = 1.5;
    fake.dbs['a-pg'].pinnedSessions.smdb_receive = true;
    expect(await stopReceive('a')).toMatchObject({ success: false, status: 500, text: 'The receive login could not be removed (the count of its sessions did not read); try again.' });
    expect(h.events).not.toContain('receive-drop');
  });
  it('the bot database gone after the drop: no received read', async () => {
    await receive('a');
    fake.dbs['a-pg'].botDbMissing = true;
    h.events.length = 0;
    await stopReceive('a');
    expect(h.events).toContain('oid-read');
    expect(h.events).not.toContain('received-read');
  });
});

describe('L5 f: N-c and finishReceive', () => {
  it('the received read lists only the mark id when priorIds is absent', async () => {
    off({ fleetDb: { ...(mainFixture().fleetDb as object), receive: { startedAt: '2026-10-30T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', safetyDump: DUMP, pushId: 'p1', dbOid: '16384' } } });
    await step('a', Date.now());
    const read = callsWith('FROM smdb_manager.received WHERE push_id IN (');
    expect(read.length).toBe(1);
    expect(/push_id IN \(([^)]*)\)/.exec(read[0].input)![1]).toBe("'p1'");
  });
  it('the copies write-back fails: its warning names the error line', async () => {
    withCopy();
    await receive('a');
    pushed();
    fake.dbs['a-pg'].fail['copies-insert'] = 'ERROR:  duplicate key\nDETAIL:  Key (host)=(x) exists.';
    const warn = capture('warn');
    await step();
    warn.restore();
    expect(warn.out).toEqual(["[Switch] A: this machine's copies could not be listed again after the push (ERROR:  duplicate key); they register again within an hour"]);
  });
  it('the copies written back: no warning, the bot broadcast once', async () => {
    withCopy();
    await receive('a');
    pushed();
    const cast = vi.spyOn(containerManager, 'broadcastBotUpdated');
    const warn = capture('warn');
    await step();
    warn.restore();
    expect(warn.out).toEqual([]);
    expect(cast.mock.calls).toEqual([['a']]);
    expect(stored('a').fleetDb.receive).toBeUndefined();
  });
  it('expiry unused: the bot broadcast once', async () => {
    await receive('a');
    const cast = vi.spyOn(containerManager, 'broadcastBotUpdated');
    await step();
    expect(cast.mock.calls).toEqual([['a']]);
  });
  it('expiry exactly at expiresAt ends receiving', async () => {
    await receive('a');
    const at = Date.parse(stored('a').fleetDb.receive.expiresAt);
    await step('a', at);
    expect(stored('a').fleetDb.receive).toBeUndefined();
  });
  it('a push that commits while the login ends: finishReceive, not the expiry', async () => {
    await receive('a');
    const d = fake.dbs['a-pg'];
    const id = stored('a').fleetDb.receive.pushId;
    d.beforeAnswer = (sql: string) => { if (sql.includes('pg_terminate_backend') && !d.received.length) d.received.push({ pushId: id, from: '9', machine: 'win.local', generation: 6 }); };
    const log = capture('log');
    await step();
    log.restore();
    expect(log.out).toEqual(['[Switch] A: received the main from win.local (generation 6); the receive login is removed']);
  });
  const LOGGED = '[Switch] B: the move code expired, but 1 session(s) of the receive login did not end; the manager tries again every minute';
  const sessionRow = async (id: string, end: () => Promise<unknown>) => {
    off({}, id);
    const d = fake.dbs['a-pg'];
    const log = capture('log');
    await receive(id);
    d.sessions.smdb_receive = 1;
    d.pinnedSessions.smdb_receive = true;
    await step(id);
    d.pinnedSessions.smdb_receive = false;
    await end();
    expect(stored(id).fleetDb.receive).toBeUndefined();
    await receive(id);
    d.sessions.smdb_receive = 1;
    d.pinnedSessions.smdb_receive = true;
    await step(id);
    log.restore();
    const shown = (s: string) => s.replace(`[Switch] ${id.toUpperCase()}:`, '[Switch] B:');
    expect(log.out.filter(m => m.includes('did not end')).map(shown)).toEqual([LOGGED, LOGGED]);
  };
  it('the sessions count logged is forgotten when a push finishes', async () => {
    await sessionRow('b1', async () => { fake.dbs['a-pg'].received.push({ pushId: stored('b1').fleetDb.receive.pushId, from: '9', machine: 'win.local', generation: 6 }); await step('b1'); });
  });
  it('the sessions count logged is forgotten when Stop receiving ends it', async () => {
    await sessionRow('b2', () => stopReceive('b2'));
  });
  it('the sessions count logged is forgotten when the code expires unused', async () => {
    await sessionRow('b3', () => step('b3'));
  });
});
