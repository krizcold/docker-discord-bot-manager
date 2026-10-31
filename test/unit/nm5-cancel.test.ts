import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-cancel-'));
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

import { cancelHandOver, SWITCH_TIMING } from '../../src/instance/fleetSwitch';
import * as containerManager from '../../src/docker/containerManager';
import { COPY_PEM, fake, h, mainFixture, resetHarness, seedDbs, stored, writeRegistry } from './switch-harness';

const MARK = { mode: 'stream', slot: 'slot_c', machine: 'copy.example', host: 'copy.example', port: 5434, cert: COPY_PEM, generation: 4, phase: 'stopped', at: '2026-10-28T12:00:00.000Z' };
const withMark = (mark: Record<string, unknown> | null) => writeRegistry({ a: mainFixture({ fleetDb: { ...mainFixture().fleetDb as object, ...(mark ? { handover: mark } : {}) } }) });
const peer = (kind: string, gen = 0) => () => (kind === 'writable' || kind === 'in-recovery'
  ? { kind, systemId: '7001', timeline: 2, gen: gen ? { generation: gen, machine: 'copy.example', since: '2026-10-28T13:00:00Z' } : null }
  : { kind, reason: 'connection refused' }) as any;

beforeEach(() => {
  resetHarness();
  seedDbs();
  fake.dbs['a-pg'].handover = { slot: 'slot_c', machine: 'copy.example', generation: 4 };
  withMark(MARK);
  h.sidecar['a-pg'] = false;
  SWITCH_TIMING.catchUpMs = 60;
  SWITCH_TIMING.pollMs = 5;
});
afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

const X_OK = "The hand-over is cancelled: this database runs again as the main, with the bot's login still blocked. Choose Running in the State window to start the bot here.";

describe('O2 Cancel', () => {
  it('X1: the target answers in recovery: database started with the override, row deleted, the copy replays the delete, mark cleared, login untouched', async () => {
    h.peer = peer('in-recovery');
    expect(await cancelHandOver('a')).toEqual({ success: true, text: X_OK });
    expect(h.events).toEqual(['probe:copy.example', 'db-start:override', 'handover-delete']);
    expect(fake.dbs['a-pg'].handover).toBeNull();
    expect(stored('a').fleetDb.handover).toBeUndefined();
    expect(stored('a').maintenance.state).toBe('maintenance');
  });
  it('X2: the target answers writable with the mark\'s generation', async () => {
    h.peer = peer('writable', 4);
    expect((await cancelHandOver('a')).text).toBe('copy.example took over as the main on 2026-10-28 13:00 UTC, so the hand-over can no longer be cancelled; this machine rejoins it as a copy.');
    expect(stored('a').fleetDb.handover).toBeDefined();
    expect(h.events).not.toContain('db-start:override');
  });
  it('X3 and X4: unreachable asks, and confirm cancels', async () => {
    const asked = await cancelHandOver('a');
    expect(asked).toMatchObject({ success: false, needsConfirm: true });
    expect(asked.text).toBe("The manager can't confirm whether copy.example took over (connection refused). Cancel only if copy.example's manager shows its copy still following this database. If copy.example does not receive the cancel, this database gets generation 4, the one a take-over there writes; if copy.example took over or takes over later, both databases then hold that generation, and each manager blocks the bot's login on its side once it finds the other, until you choose one. Cancel the hand-over?");
    expect(stored('a').fleetDb.handover).toBeDefined();
    expect(await cancelHandOver('a', true)).toEqual({ success: true, text: X_OK });
  });
  it('X3: a mark with no address asks without a probe', async () => {
    withMark({ ...MARK, host: undefined, port: undefined, cert: undefined });
    const r = await cancelHandOver('a');
    expect(r.text).toContain('(the copy registered no address)');
    expect(h.events).toEqual([]);
  });
  it('X5: the database does not start', async () => {
    h.peer = peer('in-recovery');
    h.dbStart = { success: false, error: 'compose failed' };
    expect((await cancelHandOver('a')).text).toBe('The database did not start (compose failed), so the hand-over is still recorded; try again.');
    expect(stored('a').fleetDb.handover).toBeDefined();
  });
  it('X6: the row delete fails', async () => {
    h.peer = peer('in-recovery');
    fake.dbs['a-pg'].fail['handover-delete'] = 'ERROR:  read-only';
    expect((await cancelHandOver('a')).text).toBe('The database runs, but the hand-over row could not be deleted (ERROR:  read-only), so the hand-over is still recorded; try again.');
    expect(stored('a').fleetDb.handover).toBeDefined();
  });
  it('X7: the mark clear throws', async () => {
    h.peer = peer('in-recovery');
    h.failSwitchWrite = 'disk full';
    expect((await cancelHandOver('a')).text).toBe(`${X_OK} The manager could not record this (disk full); press the same button again to finish recording it.`);
    expect(fake.dbs['a-pg'].handover).toBeNull();
  });
  it('X8 to X10: a push mark', async () => {
    withMark({ mode: 'push', machine: 'srv', host: 'srv', port: 5432, generation: 5, file: 'pre-push-x.dump', phase: 'pushing', at: 'x' });
    const asked = await cancelHandOver('a');
    expect(asked).toMatchObject({ needsConfirm: true, text: "The push to srv did not finish here. Cancel only if srv's manager does not show the database as received: cancelling keeps this machine's database as the main. Cancel the push?" });
    expect(await cancelHandOver('a', true)).toEqual({ success: true, text: 'The push is cancelled; this database was never changed by it. Choose Running in the State window to start the bot here, and Stop receiving on srv.' });
    expect(stored('a').fleetDb.handover).toBeUndefined();
    withMark({ mode: 'push', machine: 'srv', phase: 'done', at: 'x' });
    expect((await cancelHandOver('a', true)).text).toBe('The push finished: srv is the main. Rejoin this machine as a copy instead.');
    expect(stored('a').fleetDb.handover).toBeDefined();
  });
  it('X11: a file mark asks, then cancels', async () => {
    withMark({ mode: 'file', file: 'pre-move-x.dump', phase: 'done', at: 'x' });
    expect((await cancelHandOver('a')).text).toBe('Cancel the move only if the backup pre-move-x.dump was not restored on another machine: if it was, two machines would each run the bot as the main. Cancel the move?');
    expect(await cancelHandOver('a', true)).toEqual({ success: true, text: 'The move is cancelled; choose Running in the State window to start the bot here.' });
  });
  it('X12: no mark', async () => {
    withMark(null);
    expect(await cancelHandOver('a')).toEqual({ success: false, status: 409, text: 'No hand-over or move is recorded on this instance' });
  });
  it('X13: a database already running is not started again', async () => {
    h.peer = peer('in-recovery');
    h.sidecar['a-pg'] = true;
    expect((await cancelHandOver('a')).success).toBe(true);
    expect(h.events).not.toContain('db-start:override');
    void containerManager;
  });
});

describe('X14 to X17: Cancel returns the main to service only once the copy replayed the delete (D43)', () => {
  const X_UNSEEN_Q = "This database runs again and the hand-over row is deleted here, but the copy copy.example has not received that within 0 seconds (16 bytes behind, streaming), so the hand-over is still recorded and the bot's login stays blocked. If copy.example's manager presses Take over before its copy receives the cancel, it takes over as if it held every change. If you cancel anyway, this database gets generation 4, the one that take-over would write, so both databases would hold it, and each manager blocks the bot's login on its side once it finds the other, until you choose one. Cancel the hand-over?";
  const X_RAISED = " The copy copy.example had not received the cancel, so this database now holds generation 4, the one a take-over there would write: if copy.example takes over, each manager blocks the bot's login on its side once it finds the other, until you choose one.";
  const unseen = () => { fake.dbs['a-pg'].deleteLsn = '0/5000010'; };
  it('X14: the copy replays the delete within the bound: mark cleared, state and blocked login unchanged, no raise', async () => {
    h.peer = peer('in-recovery');
    fake.dbs['a-pg'].deleteLsn = '0/5000010';
    let reads = 0;
    fake.dbs['a-pg'].onSlotRead = () => { if (++reads === 2) fake.dbs['a-pg'].slots.slot_c.replay = '0/5000010'; };
    SWITCH_TIMING.catchUpMs = 2000;
    expect(await cancelHandOver('a')).toEqual({ success: true, text: X_OK });
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(stored('a').fleetDb.handover).toBeUndefined();
    expect(stored('a').maintenance.state).toBe('maintenance');
    expect(h.events).not.toContain('raise');
    expect(h.events).not.toContain('open');
    expect(fake.dbs['a-pg'].generation?.generation).toBe(3);
  });
  it('X15: not replayed, no confirm: asks X-UNSEEN-Q; the row is deleted here, the mark kept, no raise', async () => {
    h.peer = peer('in-recovery');
    unseen();
    const r = await cancelHandOver('a');
    expect(r).toEqual({ success: false, status: 409, needsConfirm: true, text: X_UNSEEN_Q });
    expect(fake.dbs['a-pg'].handover).toBeNull();
    expect(stored('a').fleetDb.handover).toMatchObject({ mode: 'stream', phase: 'stopped' });
    expect(h.events).not.toContain('raise');
    expect(fake.dbs['a-pg'].generation?.generation).toBe(3);
  });
  it.each([
    ['this press (X15 confirmed)', () => { h.peer = peer('in-recovery'); }],
    ["X3's confirm", () => undefined],
  ])("X16: not replayed, with confirm from %s: the not-owed record, then the raise to the mark's generation, then the clear", async (_n, set) => {
    set();
    unseen();
    const seenAtRaise: unknown[] = [];
    const push = h.events.push.bind(h.events);
    h.events.push = (...e: string[]) => { if (e[0] === 'raise') seenAtRaise.push(structuredClone(stored('a').fleetDb)); return push(...e); };
    const r = await cancelHandOver('a', true);
    h.events.push = push;
    expect(r).toEqual({ success: true, text: X_OK + X_RAISED });
    expect(seenAtRaise).toHaveLength(1);
    expect((seenAtRaise[0] as any).switchNotice).toEqual({ generation: 4, machine: 'main.example', since: null, state: 'not-owed' });
    expect((seenAtRaise[0] as any).handover).toBeDefined();
    expect(fake.dbs['a-pg'].generation).toMatchObject({ generation: 4, machine: 'main.example' });
    expect(stored('a').fleetDb.handover).toBeUndefined();
  });
  it('X17: the raise fails: X-RAISE, the mark kept, the login blocked', async () => {
    unseen();
    fake.dbs['a-pg'].fail.raise = 'ERROR:  disk full';
    const r = await cancelHandOver('a', true);
    expect(r).toEqual({ success: false, status: 409, text: "This database runs and the hand-over row is deleted here, but its generation could not be raised (ERROR:  disk full), so the hand-over is still recorded and the bot's login stays blocked; try again." });
    expect(stored('a').fleetDb.handover).toBeDefined();
    expect(h.events).not.toContain('open');
  });
});
