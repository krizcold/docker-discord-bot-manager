import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-receive-'));
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
import { encodeJoinCode, decodeMoveCode } from '../../src/config/joinCode';
import { MOVE_TIMING, receive, receiveStep, stopReceive } from '../../src/instance/fleetMove';
import { claimFleetBackupBusy, releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { utcText } from '../../src/instance/backupFiles';
import * as containerManager from '../../src/docker/containerManager';
import { COPY_PEM, fake, fakeJoin, freshDb, h, mainFixture, resetHarness, stored, writeRegistry } from './switch-harness';

const NOTHING = '; nothing was changed';
const OFF = { state: 'off', message: '', orderedAt: '2026-10-30T00:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: 'maintenance' };
const off = (over: Record<string, unknown> = {}) => writeRegistry({ a: mainFixture({ maintenance: OFF, ...over }) });
const roleCalls = () => fake.calls.filter(c => c.input.includes('smdb_receive'));
const STEPS = ['receive-nologin', 'receive-end', 'receive-drop', 'oid-read', 'received-read', 'copies-insert', 'save', 'mark-write', 'mark-clear'];
const steps = () => h.events.filter(e => STEPS.includes(e));
/** Records each registry save as the event 'save' and its patch; the save numbered `throwAt` throws. */
function trackSaves(throwAt?: number) {
  const real = containerManager.updateInstanceFleetDbSwitch;
  const patches: any[] = [];
  const spy = vi.spyOn(containerManager, 'updateInstanceFleetDbSwitch').mockImplementation(((id: string, patch: any) => {
    patches.push(patch);
    h.events.push('save');
    if (patches.length === throwAt) throw new Error('EACCES: permission denied');
    return real(id, patch);
  }) as any);
  return { patches, restore: () => spy.mockRestore() };
}

beforeEach(() => {
  resetHarness({ proof: { ok: true, state: 'off', enforcement: 'database', botConfirmed: true } });
  releaseFleetBackupBusy('a');
  fake.dbs['a-pg'] = freshDb();
  MOVE_TIMING.sessionPauseMs = 0;
  tmp.join = { success: true, joinCode: encodeJoinCode(fakeJoin({ host: 'main.example', port: 5433 })) };
  off();
});
afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

describe('O5 Receive', () => {
  it('V1: Off, dump, mark, role on stdin, the move code', async () => {
    const r = await receive('a');
    expect(r.success).toBe(true);
    expect(r.text).toBe("Paste this move code into Push the main in the other machine's manager within 24 hours. It replaces this machine's database with the pushed one; a dump of this one is kept with the backups (pre-receive-2026-10-28T12-00-00-000Z.dump). The code holds passwords: paste it only into your own managers.");
    const code = decodeMoveCode(r.moveCode!);
    expect(code.ok && code.code.recv.user).toBe('smdb_receive');
    const pw = code.ok ? code.code.recv.password : '';
    expect(fake.dbs['a-pg'].roles.smdb_receive.password).toBe(pw);
    for (const c of fake.calls) expect(c.args.join(' ')).not.toContain(pw);
    expect(roleCalls()[0].input).toContain('LOGIN SUPERUSER PASSWORD');
    expect(stored('a').fleetDb.receive).toMatchObject({ safetyDump: 'pre-receive-2026-10-28T12-00-00-000Z.dump' });
    expect(h.events).toContain('dump:pre-receive-');
  });
  it.each([
    ['no main', { fleetDb: undefined }, `This instance holds no main database to replace; install it with a blank Database URL first${NOTHING}`],
    ['replication off', { fleetDb: { containerName: 'a-pg', user: 'app', db: 'app', volume: 'v' } }, `Replication is not enabled, so the other machine has no address to push to; enable it first${NOTHING}`],
    ['a copy here', { fleetDbReplica: { containerName: 'c', volume: 'v', slot: 's', primaryHost: 'p', primaryPort: 1, certHost: 'c' } }, `This instance also holds a live copy; remove it before handing over the main${NOTHING}`],
  ])('V2: %s', async (_n, over, text) => {
    off(over);
    expect((await receive('a')).text).toBe(text);
    expect(roleCalls()).toEqual([]);
  });
  it('V3: not a settled Off', async () => {
    writeRegistry({ a: mainFixture() });
    expect((await receive('a')).text).toBe(`Receiving replaces this machine's database, so the bot must be Off first (its state is Maintenance); choose Off in the State window${NOTHING}`);
  });
  it('V4: the dump fails', async () => {
    h.dump = { success: false, error: 'pg_dump: connection lost' };
    expect((await receive('a')).text).toBe('The dump of this database failed (pg_dump: connection lost), so nothing was changed');
    expect(stored('a').fleetDb.receive).toBeUndefined();
  });
  it('V5: the mark write throws: the dump kept, nothing else', async () => {
    h.failSwitchWrite = 'ENOSPC';
    expect((await receive('a')).text).toBe('Receiving could not be recorded (ENOSPC); the dump pre-receive-2026-10-28T12-00-00-000Z.dump was kept and nothing else was changed');
    expect(roleCalls()).toEqual([]);
  });
  it('V6: the role script fails: the mark cleared, then the receive mark row removed by its id', async () => {
    fake.dbs['a-pg'].fail.role = 'ERROR:  permission denied to create role';
    const saves = trackSaves();
    const r = await receive('a');
    saves.restore();
    expect(r.text).toBe("The receive login could not be created (ERROR:  permission denied to create role); nothing else was changed");
    expect(stored('a').fleetDb.receive).toBeUndefined();
    expect(saves.patches[1]).toEqual({ receive: null });
    expect(steps()).toEqual(['oid-read', 'save', 'mark-write', 'save', 'mark-clear']);
    const clear = fake.calls.find(c => c.input.includes('DELETE FROM smdb_manager.receive_mark'))!;
    expect(clear.input).toContain(`mark_id = '${saves.patches[0].receive.pushId}'`);
    expect(fake.dbs['a-pg'].receiveMark).toBeNull();
  });
  it('V6 (round 3): the save that clears the record throws: RV-UNREC-TAIL, the row kept', async () => {
    fake.dbs['a-pg'].fail.role = 'ERROR:  permission denied to create role';
    const saves = trackSaves(2);
    const r = await receive('a');
    saves.restore();
    expect(r).toMatchObject({ success: false, status: 500, text: 'The receive login could not be created (ERROR:  permission denied to create role). The manager could not clear its record of receiving (EACCES: permission denied); press Stop receiving.' });
    expect(h.events).not.toContain('mark-clear');
    expect(fake.dbs['a-pg'].receiveMark).not.toBeNull();
  });
  it('V6 (round 3): the removal of the row fails: RV-MARKLEFT-TAIL', async () => {
    fake.dbs['a-pg'].fail.role = 'ERROR:  permission denied to create role';
    fake.dbs['a-pg'].fail['mark-clear'] = 'ERROR:  canceling statement due to lock timeout';
    const r = await receive('a');
    expect(r).toMatchObject({ success: false, status: 500, text: "The receive login could not be created (ERROR:  permission denied to create role). The mark that tells this database's copies a push may replace it could not be removed (ERROR:  canceling statement due to lock timeout); the manager removes it within a minute." });
    expect(stored('a').fleetDb.receive).toBeUndefined();
  });
  it('V6 (round 3): under pushBroken the row is kept (it reads the earlier failed push)', async () => {
    off({ fleetDb: { ...(mainFixture().fleetDb as object), pushBroken: { at: 'x', safetyDump: 'pre-receive-old.dump' } } });
    fake.dbs['a-pg'].fail.role = 'ERROR:  permission denied to create role';
    const r = await receive('a');
    expect(r.text).toBe("The receive login could not be created (ERROR:  permission denied to create role); nothing else was changed");
    expect(h.events).not.toContain('mark-clear');
    expect(fake.dbs['a-pg'].receiveMark).toMatchObject({ dbOid: '' });
  });
  it.each([
    ['getJoinCode fails', { success: false, error: 'the certificate could not be read' }, 'the certificate could not be read'],
    ['the code does not decode', { success: true, joinCode: 'not a join code' }, 'the join code did not decode'],
  ])('V7 (round 3, D65): %s: read before the mark, so no mark, no row, no role script; the dump kept', async (_n, join, error) => {
    tmp.join = join;
    const saves = trackSaves();
    const r = await receive('a');
    saves.restore();
    expect(r).toMatchObject({ success: false, status: 500, text: `The move code could not be made (${error}); the dump pre-receive-2026-10-28T12-00-00-000Z.dump was kept and nothing else was changed` });
    expect(saves.patches).toEqual([]);
    expect(h.events).toContain('dump:pre-receive-');
    expect(h.events).not.toContain('mark-write');
    expect(roleCalls()).toEqual([]);
    expect(stored('a').fleetDb.receive).toBeUndefined();
  });
  it('V8: Receive again rotates the password and the push id and moves expiresAt, keeping dbOid, copies and the dump', async () => {
    fake.dbs['a-pg'].slots = { slot_c: { active: true, state: 'streaming', replay: '0/5000000' } };
    fake.dbs['a-pg'].addresses = [{ host: 'copy.example', port: 5434, slot: 'slot_c', machine: 'copy.example', cert: COPY_PEM }];
    const firstCode = decodeMoveCode((await receive('a')).moveCode!);
    const first = { ...fake.dbs['a-pg'].roles.smdb_receive };
    const mark = stored('a').fleetDb.receive;
    fake.dbs['a-pg'].dbOid = '99999';
    fake.dbs['a-pg'].addresses = [];
    h.events.length = 0;
    await new Promise(r => setTimeout(r, 5));
    expect((await receive('a')).success).toBe(true);
    expect(fake.dbs['a-pg'].roles.smdb_receive.password).not.toBe(first.password);
    expect(stored('a').fleetDb.receive.startedAt).toBe(mark.startedAt);
    expect(stored('a').fleetDb.receive.expiresAt > mark.expiresAt).toBe(true);
    expect(h.events).not.toContain('dump:pre-receive-');
    const again = stored('a').fleetDb.receive;
    expect(again.pushId).toMatch(/^[0-9a-f]{24}$/);
    expect(again.pushId).not.toBe(mark.pushId);
    expect(firstCode.ok && firstCode.code.recv.id).toBe(mark.pushId);
    expect(again.dbOid).toBe('16384');
    expect(again.priorIds).toEqual([mark.pushId]);
    expect(again.copies).toEqual(mark.copies);
    expect(mark.copies).toEqual([{ host: 'copy.example', port: 5434, slot: 'slot_c', cert: COPY_PEM.trim(), machine: 'copy.example' }]);
  });
  it('V9: Stop receiving: NOLOGIN, the sessions ended and counted, the role dropped, then the check, then the mark cleared', async () => {
    await receive('a');
    h.events.length = 0;
    const saves = trackSaves();
    const r = await stopReceive('a');
    saves.restore();
    expect(r).toEqual({ success: true, text: 'Receiving stopped; the move code no longer works.' });
    expect(steps()).toEqual(['receive-nologin', 'receive-end', 'receive-drop', 'oid-read', 'received-read', 'save', 'mark-clear']);
    expect(saves.patches).toEqual([{ receive: null }]);
    expect(fake.dbs['a-pg'].roles.smdb_receive).toBeUndefined();
    expect(stored('a').fleetDb.receive).toBeUndefined();
  });
  it('V10: the drop fails: the mark kept', async () => {
    await receive('a');
    fake.dbs['a-pg'].fail.role = 'ERROR:  role "smdb_receive" cannot be dropped';
    expect((await stopReceive('a')).text).toBe('The receive login could not be removed (ERROR:  role "smdb_receive" cannot be dropped); try again.');
    expect(stored('a').fleetDb.receive).toBeDefined();
  });
  it('V14: a mark without its role (a crash between) is cleared by Stop receiving', async () => {
    off({ fleetDb: { ...(mainFixture().fleetDb as object), receive: { startedAt: 'x', expiresAt: '2026-11-30T00:00:00.000Z', safetyDump: 'd', pushId: '0123456789abcdef01234567', dbOid: '16384' } } });
    expect((await stopReceive('a')).success).toBe(true);
    expect(stored('a').fleetDb.receive).toBeUndefined();
  });
  it.each([
    ['in the registry', { fleetRestoreError: { file: 'old.dump', text: 'x', at: 'y', doubt: true } }, null],
    ['in memory only', {}, 'mem.dump'],
  ])('V16: a restore notice %s', async (_n, over, mem) => {
    off(over);
    h.memoryNotice = mem;
    expect((await receive('a')).text).toBe(`Receiving was refused and nothing was changed: a restore of ${mem ?? 'old.dump'} has not finished cleanly here (its notice is on the Database window), and a push would replace the database that notice is about. Dismiss the notice, or restore a dump again, then press Receive.`);
    expect(h.events).not.toContain('dump:pre-receive-');
  });
  it('V17: the read-only layer on, or its read failing', async () => {
    h.fence = { ok: false, cls: 'other', error: 'connection refused' };
    expect((await receive('a')).text).toBe("The manager could not read whether the bot's database is READ-ONLY (connection refused), so receiving was refused and nothing was changed");
    h.fence = { ok: true, on: true, owner: null, persisted: true };
    expect((await receive('a')).text).toMatch(/^The bot's database is READ-ONLY, and .*\. Receiving was refused and nothing was changed/);
    expect(h.events).not.toContain('dump:pre-receive-');
  });
  it('V15 is a guard row (nm5-guards G3); Receive while busy gives the busy text', async () => {
    await containerManager.withExternalBotOp('a', 'push', async () => {
      expect((await receive('a')).text).toBe(`Operation 'push' is running on this bot; wait for it to finish${NOTHING}`);
    });
  });
});

describe('V18 to V25 (Receive and Stop receiving): the push id, the oid and an unfinished push (D41, D42, D49)', () => {
  const BROKEN = "Receiving stopped; the move code no longer works. A push replaced this machine's database and did not finish, so the database is empty or holds data that was not checked, and the bot cannot run on it: restore the dump pre-receive-2026-10-28T12-00-00-000Z.dump (taken before receiving) with the bot in Maintenance or Off, or press Receive again so the other machine can push again.";
  it('V1 (round 1): the mark keeps a push id, the oid and the own copies; the move code carries the push id', async () => {
    const r = await receive('a');
    const code = decodeMoveCode(r.moveCode!);
    const mark = stored('a').fleetDb.receive;
    expect(mark).toMatchObject({ dbOid: '16384', copies: [], priorIds: [] });
    expect(mark.pushId).toMatch(/^[0-9a-f]{24}$/);
    expect(code.ok && code.code.recv.id).toBe(mark.pushId);
  });
  it('V23: the oid read fails: RV-OIDREAD, the dump kept, no mark and no role', async () => {
    fake.dbs['a-pg'].fail['oid-read'] = 'psql: error: connection refused';
    const r = await receive('a');
    expect(r).toMatchObject({ success: false, status: 500, text: "The manager could not read this database's identity before receiving (connection refused), so it could not tell later whether a push replaced it; the dump pre-receive-2026-10-28T12-00-00-000Z.dump was kept and nothing else was changed" });
    expect(h.events).toContain('dump:pre-receive-');
    expect(stored('a').fleetDb.receive).toBeUndefined();
    expect(roleCalls()).toEqual([]);
  });
  it.each([
    ['another oid', (d: any) => { d.dbOid = '24576'; }],
    ['the database missing', (d: any) => { d.botDbMissing = true; }],
  ])('V18: Stop receiving after a push replaced the database (%s) and did not finish: one save clears receive and writes pushBroken', async (_n, set) => {
    await receive('a');
    set(fake.dbs['a-pg']);
    const spy = vi.spyOn(containerManager, 'updateInstanceFleetDbSwitch');
    const r = await stopReceive('a');
    const calls = spy.mock.calls.map(c => c[1]);
    spy.mockRestore();
    expect(r).toEqual({ success: true, text: BROKEN });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ receive: null, pushBroken: { at: expect.any(String), safetyDump: 'pre-receive-2026-10-28T12-00-00-000Z.dump', copies: [] } });
    expect(stored('a').fleetDb.receive).toBeUndefined();
    expect(stored('a').fleetDb.pushBroken).toMatchObject({ safetyDump: 'pre-receive-2026-10-28T12-00-00-000Z.dump' });
    expect(fake.dbs['a-pg'].roles.smdb_receive).toBeUndefined();
  });
  it('V26: a received row of this push id means the push finished: RV-STOPPED-DONE, no pushBroken', async () => {
    await receive('a');
    fake.dbs['a-pg'].dbOid = '24576';
    fake.dbs['a-pg'].received.push({ pushId: stored('a').fleetDb.receive.pushId, from: '9', machine: 'win.local', generation: 6 });
    expect(await stopReceive('a')).toEqual({ success: true, text: 'Receiving stopped: the push from win.local had already finished (generation 6), so this database is the main now. The move code no longer works.' });
    expect(stored('a').fleetDb.pushBroken).toBeUndefined();
    expect(fake.dbs['a-pg'].receiveMark).toBeNull();
  });
  it('V20: the check cannot read: RV-STOPREAD, nothing changed', async () => {
    await receive('a');
    fake.dbs['a-pg'].fail['oid-read'] = 'psql: error: connection refused';
    const r = await stopReceive('a');
    expect(r).toMatchObject({ success: false, status: 500, text: 'The receive login was removed, so the move code no longer works, but the manager could not read whether a push replaced this database (connection refused), so receiving stays recorded; press Stop receiving again.' });
    expect(stored('a').fleetDb.receive).toBeDefined();
    expect(fake.dbs['a-pg'].roles.smdb_receive).toBeUndefined();
  });
  it('G20: Receive is admitted under pushBroken (a way out)', async () => {
    off({ fleetDb: { ...(mainFixture().fleetDb as object), pushBroken: { at: 'x', safetyDump: 'pre-receive-old.dump' } } });
    expect((await receive('a')).success).toBe(true);
  });
});

describe('Round 2 (D51 to D54, D59): Receive, Receive again, Stop receiving and N-c', () => {
  const DUMP = 'pre-receive-2026-10-28T12-00-00-000Z.dump';
  const ROW = { host: 'copy.example', port: 5434, slot: 'slot_c', cert: COPY_PEM.trim(), machine: 'copy.example' };
  const withCopy = () => {
    fake.dbs['a-pg'].slots = { slot_c: { active: true, state: 'streaming', replay: '0/5000000' } };
    fake.dbs['a-pg'].addresses = [{ ...ROW }];
  };
  const BROKEN = { at: '2026-10-29T08:00:00.000Z', safetyDump: 'pre-receive-old.dump', copies: [ROW] };
  const READY_BROKEN = (file: string) => `Paste this move code into Push the main in the other machine's manager within 24 hours. It replaces this machine's database with the pushed one. This database holds a push that did not finish, so no new dump was taken; the dump ${file}, taken before that push, stays with the backups. The code holds passwords: paste it only into your own managers.`;
  const later = () => Date.now() + 25 * 60 * 60_000;
  const step = (now = later()) => receiveStep(containerManager.getBot('a')!, now);

  it('V11: N-c finds the row: copies written back, the login ended, one save clearing receive and pushBroken', async () => {
    withCopy();
    await receive('a');
    off({ fleetDb: { ...stored('a').fleetDb, pushBroken: BROKEN } });
    fake.dbs['a-pg'].addresses = [];
    fake.dbs['a-pg'].received.push({ pushId: stored('a').fleetDb.receive.pushId, from: '9', machine: 'win.local', generation: 6 });
    h.events.length = 0;
    const saves = trackSaves();
    await step(Date.now());
    saves.restore();
    expect(steps()).toEqual(['received-read', 'copies-insert', 'receive-nologin', 'receive-end', 'receive-drop', 'save', 'mark-clear']);
    expect(saves.patches).toEqual([{ receive: null, pushBroken: null }]);
    expect(fake.dbs['a-pg'].addresses).toEqual([ROW]);
  });
  it('V13: N-c expiry, nothing received: the login ended before the check; the mark cleared, a standing pushBroken kept', async () => {
    await receive('a');
    off({ fleetDb: { ...stored('a').fleetDb, pushBroken: BROKEN } });
    h.events.length = 0;
    const saves = trackSaves();
    await step();
    saves.restore();
    expect(steps()).toEqual(['received-read', 'receive-nologin', 'receive-end', 'receive-drop', 'oid-read', 'received-read', 'save']);
    expect(saves.patches).toEqual([{ receive: null }]);
    expect(stored('a').fleetDb.pushBroken).toEqual(BROKEN);
  });
  it('V19: N-c expiry after a dropped and unfinished push: the login dropped first, pushBroken with the copies', async () => {
    withCopy();
    await receive('a');
    fake.dbs['a-pg'].dbOid = '24576';
    h.events.length = 0;
    const saves = trackSaves();
    await step();
    saves.restore();
    expect(steps().indexOf('receive-drop')).toBeLessThan(steps().indexOf('oid-read'));
    expect(saves.patches).toEqual([{ receive: null, pushBroken: { at: expect.any(String), safetyDump: DUMP, copies: [ROW] } }]);
  });
  it('V21: N-c expiry whose check cannot read: the login dropped, the mark kept', async () => {
    await receive('a');
    fake.dbs['a-pg'].fail['oid-read'] = 'psql: error: connection refused';
    await step();
    expect(fake.dbs['a-pg'].roles.smdb_receive).toBeUndefined();
    expect(stored('a').fleetDb.receive).toBeDefined();
  });
  it('V26: Stop after the push committed, with a standing pushBroken: copies written back before one save clearing both', async () => {
    withCopy();
    await receive('a');
    off({ fleetDb: { ...stored('a').fleetDb, pushBroken: BROKEN } });
    fake.dbs['a-pg'].addresses = [];
    fake.dbs['a-pg'].received.push({ pushId: stored('a').fleetDb.receive.pushId, from: '9', machine: 'win.local', generation: 6 });
    h.events.length = 0;
    const saves = trackSaves();
    const r = await stopReceive('a');
    saves.restore();
    expect(r).toEqual({ success: true, text: 'Receiving stopped: the push from win.local had already finished (generation 6), so this database is the main now. The move code no longer works.' });
    expect(saves.patches).toEqual([{ receive: null, pushBroken: null }]);
    expect(steps().indexOf('copies-insert')).toBeLessThan(steps().indexOf('save'));
    expect(steps().slice(-2)).toEqual(['save', 'mark-clear']);
    expect(fake.dbs['a-pg'].addresses).toEqual([ROW]);
    expect(stored('a').fleetDb.pushBroken).toBeUndefined();
  });
  it('V27: Receive under pushBroken, the database present: no dump, no slot, the carried dump and copies', async () => {
    off({ fleetDb: { ...(mainFixture().fleetDb as object), pushBroken: BROKEN } });
    expect(claimFleetBackupBusy('a')).toBe(true);
    const r = await receive('a');
    releaseFleetBackupBusy('a');
    expect(r).toMatchObject({ success: true, text: READY_BROKEN('pre-receive-old.dump') });
    expect(r.moveCode).toBeTruthy();
    expect(h.events).not.toContain('dump:pre-receive-');
    expect(stored('a').fleetDb.receive).toMatchObject({ safetyDump: 'pre-receive-old.dump', copies: [ROW], dbOid: '16384', priorIds: [] });
  });
  it('V28: Receive under pushBroken with the bot database missing: admitted with an empty oid', async () => {
    off({ fleetDb: { ...(mainFixture().fleetDb as object), pushBroken: { at: BROKEN.at, safetyDump: 'pre-receive-old.dump' } } });
    fake.dbs['a-pg'].botDbMissing = true;
    const r = await receive('a');
    expect(r).toMatchObject({ success: true, text: READY_BROKEN('pre-receive-old.dump') });
    expect(stored('a').fleetDb.receive).toMatchObject({ safetyDump: 'pre-receive-old.dump', dbOid: '', copies: [] });
  });
  it('V29: after V27 the push breaks again: pushBroken names the carried dump', async () => {
    off({ fleetDb: { ...(mainFixture().fleetDb as object), pushBroken: BROKEN } });
    await receive('a');
    fake.dbs['a-pg'].dbOid = '30000';
    const r = await stopReceive('a');
    expect(r.text).toContain('restore the dump pre-receive-old.dump (taken before receiving)');
    expect(stored('a').fleetDb.pushBroken).toMatchObject({ safetyDump: 'pre-receive-old.dump', copies: [ROW] });
  });
  it('V30: after V27 nothing was pushed: Stop gives RV-STOPPED with RV-STILLBROKEN, pushBroken kept', async () => {
    off({ fleetDb: { ...(mainFixture().fleetDb as object), pushBroken: BROKEN } });
    await receive('a');
    expect(await stopReceive('a')).toEqual({ success: true, text: 'Receiving stopped; the move code no longer works. A push that did not finish earlier still stands: restore the dump pre-receive-old.dump (taken before that push) with the bot in Maintenance or Off, or press Receive again.' });
    expect(stored('a').fleetDb.pushBroken).toEqual(BROKEN);
    expect(stored('a').fleetDb.receive).toBeUndefined();
  });
  it('V31: Receive again after the push finished: finishReceive, no new id, no code', async () => {
    withCopy();
    await receive('a');
    const mark = stored('a').fleetDb.receive;
    fake.dbs['a-pg'].addresses = [];
    fake.dbs['a-pg'].received.push({ pushId: mark.pushId, from: '9', machine: 'win.local', generation: 6 });
    h.events.length = 0;
    const saves = trackSaves();
    const r = await receive('a');
    saves.restore();
    expect(r).toEqual({ success: true, text: 'The push from win.local had already finished (generation 6), so this database is the main now; receiving ended and no new move code was made.' });
    expect(saves.patches).toEqual([{ receive: null, pushBroken: null }]);
    expect(steps().indexOf('copies-insert')).toBeLessThan(steps().indexOf('save'));
    expect(steps().slice(-2)).toEqual(['save', 'mark-clear']);
    expect(fake.dbs['a-pg'].receiveMark).toBeNull();
    expect(fake.dbs['a-pg'].roles.smdb_receive).toBeUndefined();
    expect(h.events).not.toContain('receive-role');
  });
  it('V32: Receive again whose received read fails: RV-AGAINREAD, nothing changed', async () => {
    await receive('a');
    const mark = stored('a').fleetDb.receive;
    const role = { ...fake.dbs['a-pg'].roles.smdb_receive };
    fake.dbs['a-pg'].fail['received-read'] = 'psql: error: connection refused';
    const r = await receive('a');
    expect(r).toMatchObject({ success: false, status: 500, text: 'The manager could not read whether a push with the current move code already finished (connection refused), so no new move code was made; nothing was changed' });
    expect(stored('a').fleetDb.receive).toEqual(mark);
    expect(fake.dbs['a-pg'].roles.smdb_receive).toEqual(role);
  });
  it('V33: Receive again whose role script fails: the mark read at the start is saved back', async () => {
    await receive('a');
    const mark = stored('a').fleetDb.receive;
    fake.dbs['a-pg'].fail['receive-role'] = 'ERROR:  out of shared memory';
    const r = await receive('a');
    expect(r).toMatchObject({ success: false, status: 500, text: `The receive login could not be changed (ERROR:  out of shared memory), so no new move code was made; the code shown before still works until ${utcText(Date.parse(mark.expiresAt))}.` });
    expect(stored('a').fleetDb.receive).toEqual(mark);
  });
  it('V33: the save back throws: its tail', async () => {
    await receive('a');
    const mark = stored('a').fleetDb.receive;
    fake.dbs['a-pg'].fail['receive-role'] = 'ERROR:  out of shared memory';
    const saves = trackSaves(2);
    const r = await receive('a');
    saves.restore();
    expect(r.text).toBe(`The receive login could not be changed (ERROR:  out of shared memory), so no new move code was made; the code shown before still works until ${utcText(Date.parse(mark.expiresAt))}. The manager could not put the earlier record back (EACCES: permission denied); a push made with the earlier code is still recognised.`);
  });
  it('V34: a push made with the earlier code commits after Receive again: N-c finds it through priorIds', async () => {
    await receive('a');
    const first = stored('a').fleetDb.receive.pushId;
    await receive('a');
    fake.dbs['a-pg'].received.push({ pushId: first, from: '9', machine: 'win.local', generation: 6 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await step(Date.now());
    const seen = log.mock.calls.map(c => c[0]);
    log.mockRestore();
    expect(seen).toContain('[Switch] A: received the main from win.local (generation 6); the receive login is removed');
    expect(stored('a').fleetDb.receive).toBeUndefined();
  });
  it('V35: a push session that runs its DROP and CREATE before it is ended: the check after the drop reads it', async () => {
    await receive('a');
    const d = fake.dbs['a-pg'];
    d.sessions.smdb_receive = 1;
    d.beforeAnswer = sql => { if (sql.includes('pg_terminate_backend')) d.dbOid = '24576'; };
    const r = await stopReceive('a');
    expect(r.text).toMatch(/^Receiving stopped; the move code no longer works. A push replaced this machine's database and did not finish/);
    expect(stored('a').fleetDb.pushBroken).toMatchObject({ safetyDump: DUMP });
    expect(d.roles.smdb_receive).toBeUndefined();
    expect(h.events).not.toContain('mark-clear');
    expect(d.receiveMark).not.toBeNull();
  });
  it('V36: sessions left after three rounds: RV-STOPSESS, NOLOGIN, mark kept', async () => {
    await receive('a');
    const d = fake.dbs['a-pg'];
    d.sessions.smdb_receive = 1;
    d.pinnedSessions.smdb_receive = true;
    h.events.length = 0;
    const r = await stopReceive('a');
    expect(r).toMatchObject({ success: false, status: 500, text: 'The receive login no longer accepts new sessions, but 1 of its session(s) did not end after three tries, so receiving was not stopped; press Stop receiving again.' });
    expect(h.events.filter(e => e === 'receive-end')).toHaveLength(3);
    expect(d.roles.smdb_receive.canLogin).toBe(false);
    expect(h.events).not.toContain('receive-drop');
    expect(stored('a').fleetDb.receive).toBeDefined();
  });
  it('V37: N-c expiry with sessions left: mark kept, RV-LOG-SESS once per change of the count', async () => {
    await receive('a');
    const d = fake.dbs['a-pg'];
    d.sessions.smdb_receive = 1;
    d.pinnedSessions.smdb_receive = true;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await step();
    await step();
    d.sessions.smdb_receive = 2;
    await step();
    const seen = log.mock.calls.map(c => c[0]).filter(m => String(m).includes('did not end'));
    log.mockRestore();
    expect(seen).toEqual([
      '[Switch] A: the move code expired, but 1 session(s) of the receive login did not end; the manager tries again every minute',
      '[Switch] A: the move code expired, but 2 session(s) of the receive login did not end; the manager tries again every minute',
    ]);
    expect(stored('a').fleetDb.receive).toBeDefined();
    expect(d.roles.smdb_receive.canLogin).toBe(false);
  });
  it.each(['receive-nologin', 'receive-end', 'receive-drop'])('V38: the step %s fails: RV-STOPFAIL on Stop, nothing on N-c, the mark kept', async (failing) => {
    await receive('a');
    fake.dbs['a-pg'].fail[failing] = 'ERROR:  canceling statement due to lock timeout';
    expect(await stopReceive('a')).toMatchObject({ success: false, status: 500, text: 'The receive login could not be removed (ERROR:  canceling statement due to lock timeout); try again.' });
    expect(stored('a').fleetDb.receive).toBeDefined();
    await step();
    expect(stored('a').fleetDb.receive).toBeDefined();
  });
  it('V39: the replication role ensure fails: RV-REPLROLE, no dump, nothing changed', async () => {
    fake.dbs['a-pg'].fail['role-ensure'] = 'ERROR:  permission denied to create role';
    const r = await receive('a');
    expect(r).toMatchObject({ success: false, status: 500, text: "The manager could not make sure the replication role exists in this database's cluster (ERROR:  permission denied to create role), and a pushed database that grants to it would not restore; nothing was changed" });
    expect(h.events).not.toContain('dump:pre-receive-');
    expect(stored('a').fleetDb.receive).toBeUndefined();
  });
  it('V39: the ensure runs on postgres before the dump, on both presses', async () => {
    fake.dbs['a-pg'].clusterRoles = ['app', 'dbm_admin'];
    await receive('a');
    expect(h.events.indexOf('role-ensure')).toBeLessThan(h.events.indexOf('dump:pre-receive-'));
    expect(fake.dbs['a-pg'].clusterRoles).toContain('replicator');
    const ensure = fake.calls.find(c => c.input.includes('NOLOGIN REPLICATION'))!;
    expect(ensure.args[ensure.args.indexOf('-d') + 1]).toBe('postgres');
    h.events.length = 0;
    await receive('a');
    expect(h.events).toContain('role-ensure');
  });
});

describe('Round 3 (D62, D65): the receive mark row and the move code made before the mark', () => {
  const DUMP = 'pre-receive-2026-10-28T12-00-00-000Z.dump';
  const later = () => Date.now() + 25 * 60 * 60_000;
  const step = (now = later()) => receiveStep(containerManager.getBot('a')!, now);
  const logs = () => {
    const out: string[] = [];
    const a = vi.spyOn(console, 'log').mockImplementation((m: unknown) => { out.push(String(m)); });
    const b = vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { out.push(String(m)); });
    return { out, restore: () => { a.mockRestore(); b.mockRestore(); } };
  };
  const LOG_MARK = "[Switch] A: the mark that tells this database's copies it is receiving could not be removed (ERROR:  canceling statement due to lock timeout); the manager tries again every minute";

  it('V40 (F1-1): Receive again while a push of id1 runs, and the move code cannot be made: nothing changed', async () => {
    await receive('a');
    const mark = stored('a').fleetDb.receive;
    const d = fake.dbs['a-pg'];
    const role = { ...d.roles.smdb_receive };
    d.sessions.smdb_receive = 1;
    d.pinnedSessions.smdb_receive = true;
    d.dbOid = '24576';
    tmp.join = { success: false, error: 'the certificate could not be read' };
    h.events.length = 0;
    const saves = trackSaves();
    const r = await receive('a');
    saves.restore();
    expect(r).toMatchObject({ success: false, status: 500, text: `The move code could not be made (the certificate could not be read), so no new move code was made; the code shown before still works until ${utcText(Date.parse(mark.expiresAt))}.` });
    expect(stored('a').fleetDb.receive).toEqual(mark);
    expect(stored('a').fleetDb.receive.pushId).toBe(mark.pushId);
    expect(d.roles.smdb_receive).toEqual(role);
    expect(h.events).not.toContain('receive-nologin');
    expect(h.events).not.toContain('receive-end');
    expect(h.events).not.toContain('receive-role');
    expect(saves.patches).toEqual([]);
    expect(d.sessions.smdb_receive).toBe(1);
  });
  it('V41: the first press saves the mark, then writes the row, then runs the role script', async () => {
    const saves = trackSaves();
    await receive('a');
    saves.restore();
    expect(h.events.filter(e => ['save', 'mark-write', 'receive-role'].includes(e))).toEqual(['save', 'mark-write', 'receive-role']);
    const id = stored('a').fleetDb.receive.pushId;
    expect(fake.dbs['a-pg'].receiveMark).toEqual({ markId: id, pushIds: [id], dbOid: '16384' });
    const w = fake.calls.find(c => c.input.includes('INSERT INTO smdb_manager.receive_mark'))!;
    expect(w.args[w.args.indexOf('-d') + 1]).toBe('postgres');
  });
  it('V41: Receive again keeps the mark id and lists both ids', async () => {
    await receive('a');
    const first = stored('a').fleetDb.receive.pushId;
    h.events.length = 0;
    const saves = trackSaves();
    await receive('a');
    saves.restore();
    expect(h.events.filter(e => ['save', 'mark-write', 'receive-role'].includes(e))).toEqual(['save', 'mark-write', 'receive-role']);
    const second = stored('a').fleetDb.receive.pushId;
    expect(fake.dbs['a-pg'].receiveMark).toEqual({ markId: first, pushIds: [first, second], dbOid: '16384' });
  });
  it('V41: under pushBroken the row carries an empty oid, on both presses', async () => {
    off({ fleetDb: { ...(mainFixture().fleetDb as object), pushBroken: { at: 'x', safetyDump: 'pre-receive-old.dump' } } });
    await receive('a');
    expect(stored('a').fleetDb.receive.dbOid).toBe('16384');
    expect(fake.dbs['a-pg'].receiveMark).toMatchObject({ dbOid: '' });
    await receive('a');
    expect(fake.dbs['a-pg'].receiveMark).toMatchObject({ dbOid: '' });
    expect(fake.dbs['a-pg'].receiveMark!.pushIds).toHaveLength(2);
  });
  it('V42: the first press, the row write fails: the mark cleared, no role script, the dump kept', async () => {
    fake.dbs['a-pg'].fail['mark-write'] = 'ERROR:  out of shared memory';
    const saves = trackSaves();
    const r = await receive('a');
    saves.restore();
    expect(r).toMatchObject({ success: false, status: 500, text: `Receiving was not started: the manager could not write the mark that tells this database's copies a push may replace it (ERROR:  out of shared memory). The dump ${DUMP} was kept; nothing else was changed.` });
    expect(saves.patches[1]).toEqual({ receive: null });
    expect(stored('a').fleetDb.receive).toBeUndefined();
    expect(roleCalls()).toEqual([]);
  });
  it('V42: the save that clears the record throws: RV-UNREC-TAIL', async () => {
    fake.dbs['a-pg'].fail['mark-write'] = 'ERROR:  out of shared memory';
    const saves = trackSaves(2);
    const r = await receive('a');
    saves.restore();
    expect(r.text).toBe(`Receiving was not started: the manager could not write the mark that tells this database's copies a push may replace it (ERROR:  out of shared memory). The dump ${DUMP} was kept. The manager could not clear its record of receiving (EACCES: permission denied); press Stop receiving.`);
    expect(roleCalls()).toEqual([]);
  });
  it('V43: Receive again, the row write fails: the mark read at the start saved back, no role script', async () => {
    await receive('a');
    const mark = stored('a').fleetDb.receive;
    const role = { ...fake.dbs['a-pg'].roles.smdb_receive };
    fake.dbs['a-pg'].fail['mark-write'] = 'ERROR:  out of shared memory';
    h.events.length = 0;
    const r = await receive('a');
    expect(r).toMatchObject({ success: false, status: 500, text: `The manager could not write the new move code's id into the mark that tells this database's copies a push may replace it (ERROR:  out of shared memory), so no new move code was made; the code shown before still works until ${utcText(Date.parse(mark.expiresAt))}.` });
    expect(stored('a').fleetDb.receive).toEqual(mark);
    expect(h.events).not.toContain('receive-role');
    expect(fake.dbs['a-pg'].roles.smdb_receive).toEqual(role);
  });
  it('V43: the save back throws: RV-ROLE-AGAIN\'s tail', async () => {
    await receive('a');
    const mark = stored('a').fleetDb.receive;
    fake.dbs['a-pg'].fail['mark-write'] = 'ERROR:  out of shared memory';
    h.events.length = 0;
    const saves = trackSaves(2);
    const r = await receive('a');
    saves.restore();
    expect(r.text).toBe(`The manager could not write the new move code's id into the mark that tells this database's copies a push may replace it (ERROR:  out of shared memory), so no new move code was made; the code shown before still works until ${utcText(Date.parse(mark.expiresAt))}. The manager could not put the earlier record back (EACCES: permission denied); a push made with the earlier code is still recognised.`);
    expect(h.events).not.toContain('receive-role');
  });
  it.each(['N-c', 'Stop', 'Receive again'])('V44: finishReceive (%s) removes the row by the first id after its save', async (via) => {
    await receive('a');
    const first = stored('a').fleetDb.receive.pushId;
    await receive('a');
    fake.dbs['a-pg'].received.push({ pushId: first, from: '9', machine: 'win.local', generation: 6 });
    h.events.length = 0;
    const saves = trackSaves();
    if (via === 'N-c') await step(Date.now());
    else if (via === 'Stop') expect((await stopReceive('a')).success).toBe(true);
    else expect((await receive('a')).success).toBe(true);
    saves.restore();
    expect(stored('a').fleetDb.receive).toBeUndefined();
    expect(steps().slice(-2)).toEqual(['save', 'mark-clear']);
    const clear = fake.calls.filter(c => c.input.includes('DELETE FROM smdb_manager.receive_mark')).pop()!;
    expect(clear.input).toContain(`mark_id = '${first}'`);
    expect(fake.dbs['a-pg'].receiveMark).toBeNull();
  });
  it('V44: the removal fails: RV-LOG-MARK, the finish stands', async () => {
    await receive('a');
    fake.dbs['a-pg'].received.push({ pushId: stored('a').fleetDb.receive.pushId, from: '9', machine: 'win.local', generation: 6 });
    fake.dbs['a-pg'].fail['mark-clear'] = 'ERROR:  canceling statement due to lock timeout';
    const seen = logs();
    const r = await stopReceive('a');
    seen.restore();
    expect(r).toEqual({ success: true, text: 'Receiving stopped: the push from win.local had already finished (generation 6), so this database is the main now. The move code no longer works.' });
    expect(seen.out).toContain(LOG_MARK);
    expect(stored('a').fleetDb.receive).toBeUndefined();
  });
  it.each(['Stop', 'expiry'])('V45: %s reads the database unchanged: the row removed by the first id after the save', async (via) => {
    await receive('a');
    const first = stored('a').fleetDb.receive.pushId;
    await receive('a');
    h.events.length = 0;
    const saves = trackSaves();
    if (via === 'Stop') expect(await stopReceive('a')).toEqual({ success: true, text: 'Receiving stopped; the move code no longer works.' });
    else await step();
    saves.restore();
    expect(stored('a').fleetDb.receive).toBeUndefined();
    expect(steps().slice(-2)).toEqual(['save', 'mark-clear']);
    expect(fake.calls.filter(c => c.input.includes('DELETE FROM smdb_manager.receive_mark')).pop()!.input).toContain(`mark_id = '${first}'`);
    expect(fake.dbs['a-pg'].receiveMark).toBeNull();
  });
  it.each(['Stop', 'expiry'])('V45: %s, the removal fails: RV-LOG-MARK, the reply unchanged', async (via) => {
    await receive('a');
    fake.dbs['a-pg'].fail['mark-clear'] = 'ERROR:  canceling statement due to lock timeout';
    const seen = logs();
    if (via === 'Stop') expect(await stopReceive('a')).toEqual({ success: true, text: 'Receiving stopped; the move code no longer works.' });
    else await step();
    seen.restore();
    expect(seen.out).toContain(LOG_MARK);
    expect(stored('a').fleetDb.receive).toBeUndefined();
  });
  it.each([
    ['Stop writes pushBroken', 'Stop', true],
    ['the expiry writes pushBroken', 'expiry', true],
    ['Stop under a standing pushBroken', 'Stop', false],
    ['the expiry under a standing pushBroken', 'expiry', false],
  ])('V46: %s: the row stays', async (_n, via, push) => {
    if (!push) off({ fleetDb: { ...(mainFixture().fleetDb as object), pushBroken: { at: 'x', safetyDump: 'pre-receive-old.dump' } } });
    await receive('a');
    if (push) fake.dbs['a-pg'].dbOid = '24576';
    h.events.length = 0;
    if (via === 'Stop') expect((await stopReceive('a')).success).toBe(true);
    else await step();
    expect(stored('a').fleetDb.receive).toBeUndefined();
    expect(stored('a').fleetDb.pushBroken).toBeDefined();
    expect(h.events).not.toContain('mark-clear');
    expect(fake.dbs['a-pg'].receiveMark).not.toBeNull();
  });
});
