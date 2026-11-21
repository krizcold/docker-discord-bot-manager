import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm42-'));
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
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => undefined }));

import * as fs from 'fs';
import * as path from 'path';
import { encodeJoinCode } from '../../src/config/joinCode';
import { backupDir, utcText } from '../../src/instance/backupFiles';
import { MOVE_TIMING, moveOutByFile, receive, receiveStep, stopReceive } from '../../src/instance/fleetMove';
import { cancelHandOver, handOver, keepThisMain, resetSwitchState, runAgain, SWITCH_TIMING, switchTick, switchView, takeOverMain } from '../../src/instance/fleetSwitch';
import { noAddressRestoreRefusal, switchDbStartRefusal, switchStartRefusal, switchStateRefusal } from '../../src/instance/switchSql';
import { switchBadges } from '../../src/cli/tui/dbtext';
import type { Bot as TuiBot } from '../../src/cli/tui/api';
import { claimFleetBackupBusy, isFleetBackupBusy, releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import * as containerManager from '../../src/docker/containerManager';
import * as dbLogin from '../../src/instance/dbLogin';
import * as fleetBackup from '../../src/instance/fleetBackup';
import { collectHealthChanges, createBotRoutes } from '../../src/webui/routes/bots';
import { COPY, copyFixture, fake, fakeJoin, freshDb, h, mainFixture, resetHarness, seedDbs, stored, writeRegistry } from './switch-harness';
import { writeDumpMeta } from './restore-fake';

const NOTHING = '; nothing was changed';
const DUMP = 'pre-receive-2026-10-28T12-00-00-000Z.dump';
const PRE = 'pre-restore-2026-11-21T10-00-00-000Z.dump';
const { publicHost: _ph, hostPort: _hp, certHost: _ch, ...PORTLESS } = COPY;
const portlessCopy = () => copyFixture({ fleetDbReplica: { ...PORTLESS } });

const OUT = (below: string, equals: string) => `This manager cannot read slot_c's generation: slot_c's take-over wrote 4, and one restore on slot_c after it writes 5. If slot_c's generation is below ${below}, slot_c's manager blocks the bot's login there once it reaches this machine, and puts that bot in Off when it holds nothing it could not save. If it equals ${equals}, slot_c's manager blocks the bot's login there and asks the owner to choose; Keep this machine as the main on slot_c then makes two mains that no manager reports. If it is higher, or slot_c's manager lost the join code it kept at its take-over (its take-over said so), both machines run the bot as the main and no manager reports it. While this database's generation is at or above slot_c's, a push from slot_c is refused. If slot_c comes back as a copy that has not reconnected to this database, remove its copy there (Remove replica) instead of pressing Take over: while it cannot reach this machine, a take-over there asks nothing and runs the bot as a second main until slot_c's manager reaches this machine.`;
const CONFIRM = (at: string, gt = '5 or more') => `Run the main here again only if slot_c is lost for good. slot_c registered no address, so this manager cannot read it and can't confirm whether slot_c took over the main after the hand-over on ${at}. If it did, slot_c's database holds the bot's changes made there since, and this database lacks them: running the main here makes two mains with different data. The manager starts this database when it is stopped, raises its generation above 4 (the generation a take-over on slot_c writes) and ends the hand-over; the bot's login stays blocked until you choose Running. ${OUT(`this database's new generation, ${gt}`, 'it')} Run the main here again?`;
const CONFIRM_PB = `Run the main here again only if slot_c is lost for good. A push replaced this database and did not finish; the machine that pushed ran as the main, so its database holds changes this one lacks, and running the main here makes two mains with different data. The manager first restores the dump ${DUMP}, taken here before receiving, which holds this machine's data as they were then; when the push left a database, the restore dumps it first and keeps that dump with the backups. When a step after the restore fails and you press again, the manager runs the restore again only while the push is still recorded as not finished, and each restore it runs raises this database's generation once more. Then it raises this database's generation above 4 (the generation a take-over on slot_c writes) and ends the hand-over; the bot's login stays blocked until you choose Running. ${OUT("this database's new generation, 5 or more", 'it')} Run the main here again?`;
const R = (pre: string | null = PRE) => (pre ? ` The dump ${DUMP} was restored first; the database as the push left it is kept in ${pre}.` : ` The dump ${DUMP} was restored first; the push had left no database to keep.`);
const PUSH = " A push from slot_c is refused while this database's generation is at or above slot_c's.";
const LEAD = "The manager can't confirm whether slot_c took over.";
const LEAD_PB = 'The machine whose push did not finish ran as the main, so its database holds changes this one lacks.';
const EQ = (g: number) => `${g}${g === 5 ? ' (what one restore on slot_c after its take-over writes)' : ''}`;
const SUCCESS = (g: number, restored?: string | null) => `This machine runs the main again: the hand-over to slot_c is ended, and this database holds generation ${g}, above the 4 a take-over on slot_c writes.${restored === undefined ? '' : R(restored)} The bot's login stays blocked; choose Running in the State window to start the bot here. ${restored === undefined ? LEAD : LEAD_PB} ${OUT(`generation ${g}`, `generation ${EQ(g)}`)}`;
const STOPPED_AGAIN = ' This database is stopped again.';
const RA9_HEAD = (err: string) => `Running the main here again stopped at the restore of ${DUMP}: ${err}.`;
const WAY_OUT = `a readable copy of ${DUMP} and ${DUMP}.json put back in this bot's backups under the same names, or a push from another machine that finishes here (press Receive a main again), is the way out.`;
const REPEAT = " Pressing Run the main here again tries again and restores that dump again; each restore that gets as far as writing the generation raises this database's generation once more.";
const GEN_ONLY = " Each restore that gets as far as writing the generation raises this database's generation once more.";
const AGAIN_BACK = `press Run the main here again, which restores ${DUMP} again`;

function trackSaves(failWhen: (patch: any, n: number) => boolean = () => false) {
  const real = containerManager.updateInstanceFleetDbSwitch;
  const patches: any[] = [];
  vi.spyOn(containerManager, 'updateInstanceFleetDbSwitch').mockImplementation(((id: string, patch: any) => {
    patches.push(patch);
    if (failWhen(patch, patches.length)) throw new Error('disk full');
    return real(id, patch);
  }) as any);
  return patches;
}

/** Fails the first save matching `when`, once. */
const failOnce = (when: (patch: any) => boolean) => {
  let done = false;
  return (patch: any) => {
    if (done || !when(patch)) return false;
    done = true;
    return true;
  };
};
const isW3 = (p: any) => 'handover' in p && p.handover === null;
const isW1 = (p: any) => p.handover?.runAgainGeneration !== undefined;

/** The hand-over's own code run against a copy that registered no address; answers the record it stored. */
async function handedOver(opts: { registry?: Record<string, Record<string, unknown>>; addresses?: boolean } = {}): Promise<any> {
  writeRegistry(opts.registry ?? { a: mainFixture(), c: portlessCopy() });
  if (!opts.addresses) fake.dbs['a-pg'].addresses = [];
  const r = await handOver('a', 'slot_c');
  h.app = false;
  h.events.length = 0;
  return { r, record: stored('a').fleetDb.handover };
}

/** The hand-over with the save of phase 'stopped' failing: waiting, no address, both containers stopped (NM41 fix 1). */
async function handedOverWaiting(): Promise<any> {
  writeRegistry({ a: mainFixture(), c: portlessCopy() });
  fake.dbs['a-pg'].addresses = [];
  let writes = 0;
  const real = containerManager.updateInstanceFleetDbSwitch;
  const spy = vi.spyOn(containerManager, 'updateInstanceFleetDbSwitch').mockImplementation(((id: string, patch: any) => { if (++writes === 2) throw new Error('disk full'); return real(id, patch); }) as any);
  const r = await handOver('a', 'slot_c');
  spy.mockRestore();
  h.app = false;
  h.events.length = 0;
  return { r, record: stored('a').fleetDb.handover };
}

/** The hand-over row as the copy's database holds it once it replayed the main's. */
function copyReplayed(): void {
  fake.dbs['c-pg'] = freshDb({ recovery: true, generation: { ...fake.dbs['a-pg'].generation! }, handover: fake.dbs['a-pg'].handover ? { ...fake.dbs['a-pg'].handover } : null });
}

/** A push into the old main that broke off, through Receive, the push's drop and Stop receiving (NM41's writers). */
async function brokenPush(oid = '99999'): Promise<void> {
  const r = await receive('a');
  expect(r.success).toBe(true);
  fake.dbs['a-pg'].dbOid = oid;
  await stopReceive('a');
  expect(stored('a').fleetDb.pushBroken).toMatchObject({ safetyDump: DUMP });
  h.events.length = 0;
}

/** The pre-receive dump and its counts file in this bot's backups, as Receive's dump leaves them. */
function writeDump(dump = true, counts = true): void {
  const dir = backupDir('a');
  fs.mkdirSync(dir, { recursive: true });
  if (dump) fs.writeFileSync(path.join(dir, DUMP), 'dump');
  else fs.rmSync(path.join(dir, DUMP), { force: true });
  if (counts) writeDumpMeta(dir, DUMP);
  else fs.rmSync(path.join(dir, `${DUMP}.json`), { force: true });
}

const STEPS = (over: Record<string, unknown> = {}) => ({
  stopped: [], preRestoreDump: null, restored: false, claimFloor: null, guildsRaised: null, claimRaisedTo: null, shardClaimsRaised: null, shardClaimsExpired: null,
  botState: null, restarted: [], generation: null, counts: null, ...over,
}) as any;

/** restoreUnderLane spied: its calls, an event in h.events, and the answer `fn` gives. */
function spyRestore(fn: () => Promise<any> | any) {
  const calls: Array<[string, string]> = [];
  vi.spyOn(fleetBackup, 'restoreUnderLane').mockImplementation(async (_id: string, file: string, op: string) => {
    calls.push([file, op]);
    h.events.push('restore');
    return fn();
  });
  return calls;
}

/** The answer of a restore that ended lifted with its counts matched (fleetBackup.ts restoreLocked's last return), with its writes. */
const restoredTo = (g: number, clear = true) => async () => {
  fake.dbs['a-pg'].generation = { generation: g, machine: 'main.example', since: '2026-11-21T10:00:00Z' };
  if (clear) await fleetBackup.clearPushBrokenMark('a');
  return { success: true, steps: STEPS({ preRestoreDump: PRE, restored: true, generation: g }) };
};

const inst = () => containerManager.getBot('a')!;
const gen = () => fake.dbs['a-pg'].generation?.generation;
const order = (...names: string[]) => names.map(n => h.events.indexOf(n));
const ascending = (xs: number[]) => xs.every(i => i >= 0) && xs.every((x, i) => i === 0 || xs[i - 1] < x);
const NO_LAYERS = { readOnly: false, hba: false, readOnlyOwner: null, hbaOwner: null, ownerFile: '' };

let now = Date.parse('2026-11-21T10:00:00Z');

beforeEach(() => {
  vi.restoreAllMocks();
  resetHarness();
  resetSwitchState();
  releaseFleetBackupBusy('a');
  seedDbs();
  MOVE_TIMING.sessionPauseMs = 0;
  SWITCH_TIMING.catchUpMs = 60;
  SWITCH_TIMING.pollMs = 5;
  SWITCH_TIMING.replayWaitMs = 50;
  now += 60 * 60_000;
  tmp.join = { success: true, joinCode: encodeJoinCode(fakeJoin({ host: 'main.example', port: 5433 })) };
  fs.rmSync(backupDir('a'), { recursive: true, force: true });
  // fenceLayers' probe is not in the switch fake; its answer with no layer on (fleetBackup.ts fenceLayers, m[1] 'off', m[2] '0').
  vi.spyOn(fleetBackup, 'fenceLayers').mockResolvedValue(NO_LAYERS as any);
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

describe('NM42 rows 1, 1b, 2, 4: the question, then the raise and the end of the hand-over', () => {
  it('1: asks first and changes nothing', async () => {
    const { record } = await handedOver();
    const r = await runAgain('a');
    expect(r).toEqual({ success: false, needsConfirm: true, status: 409, confirmDump: '', text: CONFIRM(utcText(Date.parse(record.at))) });
    expect(h.events).toEqual([]);
    expect(stored('a').fleetDb.handover).toEqual(record);
    expect(gen()).toBe(3);
  });

  it('1b: after a broken push the question names the dump, and a confirm for another dump is asked again', async () => {
    const { record } = await handedOver();
    await brokenPush();
    writeDump();
    const r = await runAgain('a');
    expect(r).toEqual({ success: false, needsConfirm: true, status: 409, confirmDump: DUMP, text: CONFIRM_PB });
    const again = await runAgain('a', true, 'x');
    expect(again).toEqual(r);
    const none = await runAgain('a', true);
    expect(none).toEqual(r);
    expect(h.events).toEqual([]);
    expect(stored('a').fleetDb.handover).toEqual(record);
    expect(stored('a').fleetDb.pushBroken).toMatchObject({ safetyDump: DUMP });
  });

  it('2: accepted from the stopped record: started with the override, raised to 5, the record cleared, Running admitted', async () => {
    const { record } = await handedOver();
    expect(fake.dbs['a-pg'].handover).toMatchObject({ slot: 'slot_c', generation: 4 });
    const patches = trackSaves();
    const r = await runAgain('a', true);
    expect(r).toEqual({ success: true, text: SUCCESS(5) });
    expect(ascending(order('db-start:override', 'require-maintenance', 'fence-read', 'raise'))).toBe(true);
    expect(h.events).not.toContain('db-stop');
    expect(gen()).toBe(5);
    expect(fake.dbs['a-pg'].handover).toBeNull();
    expect(patches).toEqual([{ handover: { ...record, runAgainGeneration: 5 } }, { handover: null }]);
    expect(stored('a').fleetDb.handover).toBeUndefined();
    expect(switchStartRefusal(inst())).toBeNull();
    expect(switchStateRefusal(inst(), 'running')).toBeNull();
    expect(isFleetBackupBusy('a')).toBe(false);
  });

  it('4: the waiting record is accepted the same way; docker without an answer refuses with nothing run', async () => {
    const { record } = await handedOverWaiting();
    expect(record).toMatchObject({ phase: 'waiting' });
    h.sidecar['a-pg'] = null;
    const unread = await runAgain('a', true);
    expect(unread).toEqual({ success: false, status: 409, text: 'Running the main here again was refused and nothing was changed: docker did not say whether this database runs. Press Run the main here again.' });
    expect(h.events).toEqual([]);
    expect(stored('a').fleetDb.handover).toEqual(record);
    expect(isFleetBackupBusy('a')).toBe(false);
    h.sidecar['a-pg'] = false;
    const patches = trackSaves();
    const r = await runAgain('a', true);
    expect(r).toEqual({ success: true, text: SUCCESS(5) });
    expect(h.events[0]).toBe('db-start:override');
    expect(gen()).toBe(5);
    expect(patches).toEqual([{ handover: { ...record, runAgainGeneration: 5 } }, { handover: null }]);
  });
});

describe('NM42 row 3: the copy that took over reads the old main as higher', () => {
  /** The copy took over at 4; the old main ran again; the peer answers the old main's fake generation. */
  async function tookOverThenRanAgain(): Promise<void> {
    await handedOver();
    copyReplayed();
    expect((await takeOverMain('c')).success).toBe(true);
    expect(fake.dbs['c-pg'].generation).toMatchObject({ generation: 4 });
    expect(stored('c').fleetDb.formerMain).toBeDefined();
    h.sidecar['a-pg'] = false;
    expect((await runAgain('a', true)).success).toBe(true);
    h.peer = (host: string) => (host === COPY.primaryHost
      ? { kind: 'writable', systemId: '7001', timeline: 2, gen: { ...fake.dbs['a-pg'].generation! } }
      : { kind: 'unreachable', reason: 'connection refused' }) as any;
    h.events.length = 0;
  }

  it('3: below: replacedBy at 5 and the login blocked', async () => {
    await tookOverThenRanAgain();
    await switchTick(now);
    await switchTick(now + 6 * 60_000);
    expect(stored('c').fleetDb.replacedBy).toMatchObject({ generation: 5 });
    expect(h.events).toContain('block');
  });

  it('3: equal (one restore on the copy): a tie; Keep there raises it above, and then neither is recorded', async () => {
    await tookOverThenRanAgain();
    fake.dbs['c-pg'].generation = { generation: 5, machine: 'copy.example', since: '2026-11-21T11:00:00Z' };
    await switchTick(now);
    expect(stored('c').fleetDb.mainConflict).toBeDefined();
    expect(stored('c').fleetDb.replacedBy).toBeUndefined();
    expect((await keepThisMain('c')).success).toBe(true);
    expect(fake.dbs['c-pg'].generation?.generation).toBe(6);
    await switchTick(now + 6 * 60_000);
    expect(stored('c').fleetDb.replacedBy).toBeUndefined();
    expect(stored('c').fleetDb.mainConflict).toBeUndefined();
  });

  it('3: above: neither is recorded', async () => {
    await tookOverThenRanAgain();
    fake.dbs['c-pg'].generation = { generation: 6, machine: 'copy.example', since: '2026-11-21T11:00:00Z' };
    await switchTick(now);
    await switchTick(now + 6 * 60_000);
    expect(stored('c').fleetDb.replacedBy).toBeUndefined();
    expect(stored('c').fleetDb.mainConflict).toBeUndefined();
  });
});

describe('NM42 rows 5, 6, 11, 22: refused on stored facts, before any docker call', () => {
  it('5: under receive: the admission text', async () => {
    await handedOver();
    await receive('a');
    h.events.length = 0;
    const r = await runAgain('a', true);
    expect(r).toEqual({ success: false, status: 409, text: `This database is waiting to receive a main from another machine; Stop receiving first${NOTHING}` });
    expect(h.events).toEqual([]);
    expect(stored('a').fleetDb.receive).toBeDefined();
  });

  it.each([
    [false, false, `the dump ${DUMP} and its counts file ${DUMP}.json`, 'are'],
    [false, true, `the dump ${DUMP}`, 'is'],
    [true, false, `its counts file ${DUMP}.json`, 'is'],
  ])('6: dump %s, counts file %s: RA4, with and without confirm', async (dump, counts, missing, verb) => {
    const { record } = await handedOver();
    await brokenPush();
    if (dump || counts) writeDump(dump, counts);
    const pb = stored('a').fleetDb.pushBroken;
    const text = `Running the main here again was refused and nothing was changed: a push replaced this database and did not finish, and ${missing}, kept from before that push, ${verb} not in this bot's backups, so there is nothing to restore this machine's data from. If copies exist, put them back in the backups under the same names, then press Run the main here again.`;
    expect(await runAgain('a')).toEqual({ success: false, status: 409, text });
    expect(await runAgain('a', true, DUMP)).toEqual({ success: false, status: 409, text });
    expect(h.events).toEqual([]);
    expect(stored('a').fleetDb.handover).toEqual(record);
    expect(stored('a').fleetDb.pushBroken).toEqual(pb);
  });

  it('11: no main database, no record, a record with an address, a restore notice', async () => {
    writeRegistry({ a: { maintenance: mainFixture().maintenance } });
    expect((await runAgain('a', true)).text).toBe(`This instance holds no main database, so there is no main to run here${NOTHING}`);
    writeRegistry({ a: mainFixture() });
    expect((await runAgain('a', true)).text).toBe(`No hand-over to a machine without an address is recorded here, so there is nothing to run again${NOTHING}`);
    const { record } = await handedOver({ addresses: true });
    expect(record).toMatchObject({ host: 'copy.example', port: 5434 });
    expect((await runAgain('a', true)).text).toBe(`This machine handed its main database to copy.example, which registered an address, so this manager reads copy.example itself, and the Database window's lines say what ends the hand-over${NOTHING}`);
    expect(h.events).toEqual([]);
  });

  it('11: a restore notice without a broken push: RA3 for this record', async () => {
    await handedOver();
    h.memoryNotice = 'old.dump';
    const r = await runAgain('a', true);
    expect(r.text).toBe('Running the main here again was refused and nothing was changed: the restore of old.dump left a notice on the Database window. Dismiss it to keep the restored data, then press Run the main here again, which ends the hand-over without restoring again; to restore old.dump again or another dump instead, do the same, then restore with the bot in Maintenance or Off.');
    expect(h.events).toEqual([]);
  });

  it('22: a move by file (its real writer): RA1b-move', async () => {
    writeRegistry({ a: mainFixture() });
    expect((await moveOutByFile('a', true)).success).toBe(true);
    expect(stored('a').fleetDb.handover).toMatchObject({ mode: 'file' });
    h.events.length = 0;
    const r = await runAgain('a', true);
    expect(r.text).toBe(`This button is for a hand-over to a machine without an address, and the move recorded here (a backup made for a move) is not one${NOTHING}`);
    expect(h.events).toEqual([]);
  });
});

describe('NM42 rows 7, 7b, 8, 8b, 20, 25: the broken push: the restore first, then the raise', () => {
  it('7: restore first, then raise to 5; W3 fails once, the next press finishes with no second restore', async () => {
    const { record } = await handedOver();
    await brokenPush();
    writeDump();
    const calls = spyRestore(restoredTo(4));
    const patches = trackSaves(failOnce(isW3));
    const r = await runAgain('a', true, DUMP);
    expect(calls).toEqual([[DUMP, 'run-again']]);
    expect(ascending(order('db-start:override', 'require-maintenance', 'restore', 'raise'))).toBe(true);
    expect(r.text).toBe(`This database holds generation 5 now, above the 4 a take-over on slot_c writes, but the manager could not record that the hand-over ended (disk full), so it stays recorded and the bot does not start here. Press Run the main here again to finish recording it.${R()}${PUSH}${STOPPED_AGAIN}`);
    const w1 = patches.find(isW1);
    expect(w1).toEqual({ handover: { ...record, runAgainGeneration: 5 }, pushBroken: null });
    expect(gen()).toBe(5);
    expect(stored('a').fleetDb.pushBroken).toBeUndefined();
    h.events.length = 0;
    const second = await runAgain('a', true);
    expect(second).toEqual({ success: true, text: SUCCESS(5) });
    expect(calls).toHaveLength(1);
    expect(stored('a').fleetDb.handover).toBeUndefined();
  });

  it('7: the restore left generation 5: the target is 6, and the success names the dump kept', async () => {
    await handedOver();
    await brokenPush();
    writeDump();
    spyRestore(restoredTo(5));
    const r = await runAgain('a', true, DUMP);
    expect(r).toEqual({ success: true, text: SUCCESS(6, PRE) });
    expect(gen()).toBe(6);
    expect(stored('a').fleetDb.handover).toBeUndefined();
  });

  it('7: a push that left no database: [R] says so', async () => {
    await handedOver();
    await brokenPush();
    writeDump();
    spyRestore(async () => { fake.dbs['a-pg'].generation = { generation: 4, machine: 'main.example', since: null }; await fleetBackup.clearPushBrokenMark('a'); return { success: true, steps: STEPS({ restored: true, generation: 4 }) }; });
    const r = await runAgain('a', true, DUMP);
    expect(r).toEqual({ success: true, text: SUCCESS(5, null) });
  });

  it('7b: a stored target from a failed raise is dropped by the restore, and the press after a second broken push writes 7', async () => {
    await handedOver();
    await brokenPush();
    writeDump();
    spyRestore(restoredTo(4));
    fake.dbs['a-pg'].fail.raise = 'ERROR:  could not extend file';
    fake.dbs['a-pg'].failCodes = { raise: 3 };
    const failed = await runAgain('a', true, DUMP);
    expect(failed.text).toBe(`Running the main here again was refused: this database's generation could not be raised to 5 (ERROR:  could not extend file), so the hand-over to slot_c stays recorded. Press Run the main here again to end it.${R()}${PUSH}${STOPPED_AGAIN}`);
    expect(stored('a').fleetDb.handover.runAgainGeneration).toBe(5);
    delete fake.dbs['a-pg'].fail.raise;
    vi.restoreAllMocks();
    vi.spyOn(fleetBackup, 'fenceLayers').mockResolvedValue(NO_LAYERS as any);
    await brokenPush('99998');
    writeDump();
    spyRestore(restoredTo(6));
    const patches = trackSaves();
    const r = await runAgain('a', true, DUMP);
    expect(patches.find(isW1)?.handover.runAgainGeneration).toBe(7);
    expect(r).toEqual({ success: true, text: SUCCESS(7, PRE) });
    expect(gen()).toBe(7);
  });

  it('8: a failed restore keeps the record and pushBroken; the repeat sentence, without its first half when the error says it; [PUSH] only when the restore wrote the generation', async () => {
    const { record } = await handedOver();
    await brokenPush();
    writeDump();
    const pb = stored('a').fleetDb.pushBroken;
    const before = 'Could not fence the database for the restore: ERROR:  could not write auto.conf';
    spyRestore(() => ({ success: false, error: before, steps: STEPS() }));
    const r = await runAgain('a', true, DUMP);
    expect(r.text).toBe(`${RA9_HEAD(before)} The hand-over to slot_c stays recorded and the bot does not start here.${REPEAT}${STOPPED_AGAIN}`);
    expect(h.events.lastIndexOf('db-stop')).toBeGreaterThan(h.events.indexOf('restore'));
    expect(h.events).not.toContain('raise');
    expect(stored('a').fleetDb.handover).toEqual(record);
    expect(stored('a').fleetDb.pushBroken).toEqual(pb);
    vi.restoreAllMocks();
    vi.spyOn(fleetBackup, 'fenceLayers').mockResolvedValue(NO_LAYERS as any);
    const after = `The dump was restored, but X was started outside the manager during the restore and may act on what it read while the database was rebuilt; stop it. X runs now. The write fence stays on and the bot stays in maintenance, so nothing writes to the restored database from what was read mid-restore; the database is READ-ONLY and no longer refuses connections; ${AGAIN_BACK}: the pre-restore dump ${PRE} holds the database as it was`;
    spyRestore(() => ({ success: false, error: after, saysAgain: true, steps: STEPS({ preRestoreDump: PRE, restored: true, generation: 4 }) }));
    const pushed = await runAgain('a', true, DUMP);
    expect(pushed.text).toBe(`${RA9_HEAD(after)} The hand-over to slot_c stays recorded and the bot does not start here.${GEN_ONLY}${PUSH}${STOPPED_AGAIN}`);
    vi.restoreAllMocks();
    vi.spyOn(fleetBackup, 'fenceLayers').mockResolvedValue(NO_LAYERS as any);
    const unlifted = `Restored, but 1 table(s) differ from the counts recorded when the backup was taken: smdb_data.guild_ownership: 2 recorded, 5 restored, and the write fence could not be lifted live: the database is READ-ONLY, and may still refuse the bot's connections, until its container restarts (see manager logs). Restart the instance, then ${AGAIN_BACK} (the pre-restore dump ${PRE} holds the database as it was)`;
    spyRestore(() => ({ success: false, error: unlifted, saysAgain: true, steps: STEPS({ preRestoreDump: PRE, restored: true, generation: 5, counts: { result: 'differ', tables: 1, rows: 3, text: null } }) }));
    const doubtful = await runAgain('a', true, DUMP);
    expect(doubtful.text).toBe(`${RA9_HEAD(unlifted)} The hand-over to slot_c stays recorded and the bot does not start here.${GEN_ONLY}${PUSH}${STOPPED_AGAIN}`);
  });

  it('8b: a doubtful restore that cleared pushBroken: no repeat sentence; its notice refuses; dismissed, a press raises with no second restore', async () => {
    await handedOver();
    await brokenPush();
    writeDump();
    const doubt = `The dump ${DUMP} was restored, but 1 table(s) differ. The bot stays in maintenance, and Running and Run the main here again are refused while the notice on the Database window stands`;
    const calls = spyRestore(async () => {
      fake.dbs['a-pg'].generation = { generation: 4, machine: 'main.example', since: null };
      await fleetBackup.clearPushBrokenMark('a');
      h.memoryNotice = DUMP;
      return { success: false, error: doubt, steps: STEPS({ preRestoreDump: PRE, restored: true, generation: 4, counts: { result: 'differ', tables: 2, rows: 3, text: '1 table(s) differ' } }) };
    });
    const r = await runAgain('a', true, DUMP);
    expect(r.text).toBe(`${RA9_HEAD(doubt)} The hand-over to slot_c stays recorded and the bot does not start here.${PUSH}${STOPPED_AGAIN}`);
    h.events.length = 0;
    const gated = await runAgain('a', true);
    expect(gated.text).toMatch(new RegExp(`^Running the main here again was refused and nothing was changed: the restore of ${DUMP.replace(/\./g, '\\.')} left a notice on the Database window\\.`));
    expect(h.events).toEqual([]);
    h.memoryNotice = null;
    const done = await runAgain('a', true);
    expect(done).toEqual({ success: true, text: SUCCESS(5) });
    expect(calls).toHaveLength(1);
    expect(h.events).toContain('raise');
  });

  it('20: a restore that succeeds and leaves pushBroken: W1 clears it in the same save', async () => {
    await handedOver();
    await brokenPush();
    writeDump();
    spyRestore(restoredTo(4, false));
    const patches = trackSaves();
    const r = await runAgain('a', true, DUMP);
    expect(r.success).toBe(true);
    expect(patches.find(isW1)).toMatchObject({ pushBroken: null });
    expect(stored('a').fleetDb.pushBroken).toBeUndefined();
  });

  // The errors are the restore's own texts for each class (fleetBackup.ts readRestoreMeta, the term schema refusal, the fence's, pg_restore's).
  const ERRORS: Record<string, string> = {
    read: `The counts file of the dump ${DUMP} could not be read (it is not JSON), so the manager cannot check what it restores and the restore was refused (nothing was changed); Run the main here again restores only this dump`,
    shape: `The dump ${DUMP} was taken before the bot numbered its saves by claim, so the restore was refused, and nothing was changed: it has smdb_data.guild_ownership but no smdb_data.claim_seq, and the bot does not run on that schema`,
    neither: 'Could not fence the database for the restore: ERROR:  could not write auto.conf',
    dumpRead: `The dump ${DUMP} could not be read, so the restore was refused, and nothing was changed: pg_restore exited with code 1: pg_restore: error: could not read from input file: end of file`,
    pg_restore: `Restore failed: pg_restore exited with code 1: pg_restore: error: out of disk. The write fence stays on and the bot stays in maintenance, so nothing writes to a database that may be missing or partial; the database is READ-ONLY and no longer refuses connections; ${AGAIN_BACK}: the pre-restore dump ${PRE} holds the database as it was`,
  };
  it.each([
    ['read', { refusedAs: 'read' }, `The dump ${DUMP} or its counts file ${DUMP}.json could not be read, so this button cannot restore this machine's data until a readable copy of both is put back in this bot's backups under the same names; a push from another machine that finishes here (press Receive a main again) also ends the hand-over. The hand-over to slot_c stays recorded, and nothing else was changed.`],
    ['shape', { refusedAs: 'shape' }, "This button cannot restore that dump, so it cannot run the main here; a push from another machine that finishes here (press Receive a main again) ends the hand-over. The hand-over to slot_c stays recorded, and nothing else was changed."],
    ['neither', {}, `The hand-over to slot_c stays recorded and the bot does not start here.${REPEAT}`],
    ['dumpRead', { failedAt: 'dumpRead' }, `The hand-over to slot_c stays recorded and the bot does not start here.${REPEAT} If the same error repeats, ${WAY_OUT}`],
    ['pg_restore', { failedAt: 'pg_restore', saysAgain: true, steps: STEPS({ preRestoreDump: PRE }) }, `The hand-over to slot_c stays recorded and the bot does not start here.${GEN_ONLY} If the data fail to restore the same way again, ${WAY_OUT}`],
  ])('25: a W0 refusal classed %s names its way out', async (n, cls, body) => {
    await handedOver();
    await brokenPush();
    writeDump();
    spyRestore(() => ({ success: false, error: ERRORS[n], steps: STEPS(), ...cls }));
    const r = await runAgain('a', true, DUMP);
    expect(r.text).toBe(`${RA9_HEAD(ERRORS[n])} ${body}${STOPPED_AGAIN}`);
    expect(stored('a').fleetDb.pushBroken).toMatchObject({ safetyDump: DUMP });
  });

  // fleetBackup.ts restoreLocked, the doubtful lane branch whose pushBroken clear failed: its error and saysAgain.
  const COUNTS_TEXT = '1 table(s) differ from the counts recorded when the backup was taken: smdb_data.guild_ownership: 2 recorded, 5 restored';
  const STILL_ERROR = `The dump ${DUMP} was restored, but ${COUNTS_TEXT}. The bot stays in maintenance, and Running stays refused while the hand-over is recorded. The push is still recorded as not finished, so the next press of Run the main here again restores ${DUMP} again (the pre-restore dump ${PRE} holds the database as it was)`;
  it('25b: a doubtful restore whose push is still recorded: the reply says once that the next press restores the dump again', async () => {
    await handedOver();
    await brokenPush();
    writeDump();
    spyRestore(() => ({
      success: false, error: STILL_ERROR, saysAgain: true,
      steps: STEPS({ preRestoreDump: PRE, restored: true, generation: 6, counts: { result: 'differ', tables: 1, rows: 3, text: COUNTS_TEXT } }),
    }));
    const r = await runAgain('a', true, DUMP);
    expect(r.text).toBe(`${RA9_HEAD(STILL_ERROR)} The hand-over to slot_c stays recorded and the bot does not start here. Each restore that gets as far as writing the generation raises this database's generation once more.${PUSH}${STOPPED_AGAIN}`);
    expect(stored('a').fleetDb.pushBroken).toMatchObject({ safetyDump: DUMP });
  });

  // fleetBackup.ts restoreLocked, counts matched and the lift ended failed: its error and saysAgain (nm42-restore R4d).
  const LIFT_FAILED = 'Restored, but the write fence could not be lifted or stripped: the database stays READ-ONLY, a restart does not clear it, and pressing Run the main here again restores the dump again and retries the lift (see manager logs)';
  it('25c: a restore whose lift ended failed: the reply says once that the next press restores the dump again', async () => {
    await handedOver();
    await brokenPush();
    writeDump();
    spyRestore(() => ({
      success: false, error: LIFT_FAILED, saysAgain: true,
      steps: STEPS({ preRestoreDump: PRE, restored: true, generation: 6, counts: { result: 'matched', tables: 2, rows: 3, text: null } }),
    }));
    const r = await runAgain('a', true, DUMP);
    expect(r.text).toBe(`${RA9_HEAD(LIFT_FAILED)} The hand-over to slot_c stays recorded and the bot does not start here. Each restore that gets as far as writing the generation raises this database's generation once more.${PUSH}${STOPPED_AGAIN}`);
    expect(stored('a').fleetDb.pushBroken).toMatchObject({ safetyDump: DUMP });
  });

  it('23: the real lane restore with a counts file that names another dump: RA9u, pushBroken kept', async () => {
    const { record } = await handedOver();
    await brokenPush();
    writeDump();
    writeDumpMeta(backupDir('a'), DUMP, undefined, { file: 'other.dump' });
    const r = await runAgain('a', true, DUMP);
    expect(r.text).toBe(`${RA9_HEAD(`The counts file ${DUMP}.json names the dump other.dump, so it does not describe this dump and the restore was refused (nothing was changed); Run the main here again restores only this dump`)} The dump ${DUMP} or its counts file ${DUMP}.json could not be read, so this button cannot restore this machine's data until a readable copy of both is put back in this bot's backups under the same names; a push from another machine that finishes here (press Receive a main again) also ends the hand-over. The hand-over to slot_c stays recorded, and nothing else was changed.${STOPPED_AGAIN}`);
    expect(stored('a').fleetDb.pushBroken).toMatchObject({ safetyDump: DUMP });
    expect(stored('a').fleetDb.handover).toEqual(record);
  });
});

describe('NM42 rows 9, 17, 18, 26: reruns after each write', () => {
  it('9: W3 fails: RA14 at 5 with the target stored; the next press clears the record with one save', async () => {
    const { record } = await handedOver();
    trackSaves(failOnce(isW3));
    const r = await runAgain('a', true);
    expect(r.text).toBe(`This database holds generation 5 now, above the 4 a take-over on slot_c writes, but the manager could not record that the hand-over ended (disk full), so it stays recorded and the bot does not start here. Press Run the main here again to finish recording it.${PUSH}${STOPPED_AGAIN}`);
    expect(gen()).toBe(5);
    expect(stored('a').fleetDb.handover).toEqual({ ...record, runAgainGeneration: 5 });
    expect(h.events[h.events.length - 1]).toBe('db-stop');
    vi.restoreAllMocks();
    vi.spyOn(fleetBackup, 'fenceLayers').mockResolvedValue(NO_LAYERS as any);
    const patches = trackSaves();
    const again = await runAgain('a', true);
    expect(again).toEqual({ success: true, text: SUCCESS(5) });
    expect(gen()).toBe(5);
    expect(patches).toEqual([{ handover: null }]);
  });

  it('9: the raise fails on a statement error: RA13 at 3 with the target stored; the rerun raises to it without reading the generation', async () => {
    const { record } = await handedOver();
    fake.dbs['a-pg'].fail.raise = 'ERROR:  could not extend file';
    // psql with ON_ERROR_STOP exits 3 on a script's statement error.
    fake.dbs['a-pg'].failCodes = { raise: 3 };
    const r = await runAgain('a', true);
    expect(r.text).toBe(`Running the main here again was refused: this database's generation could not be raised to 5 (ERROR:  could not extend file), so the hand-over to slot_c stays recorded. Press Run the main here again to end it.${STOPPED_AGAIN}`);
    expect(gen()).toBe(3);
    expect(stored('a').fleetDb.handover).toEqual({ ...record, runAgainGeneration: 5 });
    delete fake.dbs['a-pg'].fail.raise;
    fake.dbs['a-pg'].fail['gen-read'] = 'ERROR:  connection reset by peer';
    const patches = trackSaves();
    expect(await runAgain('a', true)).toEqual({ success: true, text: SUCCESS(5) });
    expect(patches).toEqual([{ handover: null }]);
    expect(gen()).toBe(5);
  });

  it('9: the raise loses its connection: the manager can\'t confirm the raise, [PUSH], and the rerun raises to the stored target', async () => {
    const { record } = await handedOver();
    fake.dbs['a-pg'].fail.raise = 'psql: error: server closed the connection unexpectedly';
    fake.dbs['a-pg'].failCodes = { raise: 2 };
    const r = await runAgain('a', true);
    expect(r.text).toBe(`Running the main here again stopped: the manager can't confirm whether this database's generation was raised to 5 (server closed the connection unexpectedly), so the hand-over to slot_c stays recorded. Press Run the main here again to end it.${PUSH}${STOPPED_AGAIN}`);
    expect(stored('a').fleetDb.handover).toEqual({ ...record, runAgainGeneration: 5 });
    delete fake.dbs['a-pg'].fail.raise;
    const patches = trackSaves();
    expect(await runAgain('a', true)).toEqual({ success: true, text: SUCCESS(5) });
    expect(patches).toEqual([{ handover: null }]);
  });

  it('9: the generation read fails: RA11, nothing stored', async () => {
    const { record } = await handedOver();
    fake.dbs['a-pg'].fail['gen-read'] = 'ERROR:  connection reset by peer';
    const r = await runAgain('a', true);
    expect(r.text).toBe(`Running the main here again was refused: this database's generation could not be read (ERROR:  connection reset by peer).${STOPPED_AGAIN}`);
    expect(stored('a').fleetDb.handover).toEqual(record);
  });

  it('9: the W1 save fails after a restore: RA12 with [R] and [PUSH]; the next press makes no second restore', async () => {
    await handedOver();
    await brokenPush();
    writeDump();
    const calls = spyRestore(restoredTo(4));
    trackSaves(failOnce(isW1));
    const r = await runAgain('a', true, DUMP);
    expect(r.text).toBe(`Running the main here again was refused: the manager could not record the generation it writes (disk full).${R()}${PUSH}${STOPPED_AGAIN}`);
    expect(gen()).toBe(4);
    const again = await runAgain('a', true);
    expect(again).toEqual({ success: true, text: SUCCESS(5) });
    expect(calls).toHaveLength(1);
  });

  it('17: an answer of the raise that does not parse: RA13b, the record kept, the database stopped again', async () => {
    const { record } = await handedOver();
    fake.dbs['a-pg'].raiseAnswer = 'COMMIT';
    const r = await runAgain('a', true);
    expect(r.text).toBe(`Running the main here again stopped: the raise to 5 answered 'COMMIT', so the manager can't confirm this database's generation; the hand-over to slot_c stays recorded. Press Run the main here again to end it.${PUSH}${STOPPED_AGAIN}`);
    expect(stored('a').fleetDb.handover).toEqual({ ...record, runAgainGeneration: 5 });
    expect(h.events[h.events.length - 1]).toBe('db-stop');
  });

  it('18: G above T: RA14, then a press names 6 and has no equal clause', async () => {
    await handedOver();
    trackSaves(failOnce(isW3));
    const r = await runAgain('a', true);
    expect(r.text).toContain(PUSH);
    vi.restoreAllMocks();
    vi.spyOn(fleetBackup, 'fenceLayers').mockResolvedValue(NO_LAYERS as any);
    fake.dbs['a-pg'].generation = { generation: 6, machine: 'main.example', since: null };
    const again = await runAgain('a', true);
    expect(again).toEqual({ success: true, text: SUCCESS(6) });
    expect(again.text).not.toContain('(what one restore on slot_c after its take-over writes)');
  });

  it('26: PUSHED_UP from a stored target: RA8 after RA14 carries [PUSH]', async () => {
    await handedOver();
    trackSaves(failOnce(isW3));
    await runAgain('a', true);
    h.proof = { ok: false, error: "The manager can't confirm the bot's database login is blocked: connection refused" };
    const r = await runAgain('a', true);
    expect(r.text).toBe(`Running the main here again was refused: The manager can't confirm the bot's database login is blocked: connection refused.${PUSH}${STOPPED_AGAIN}`);
  });

  it('26: PUSHED_UP from a notice past the drop: RA8 carries [PUSH] only then', async () => {
    await handedOver();
    await brokenPush();
    writeDump();
    h.proof = { ok: false, error: "The manager can't confirm the bot's database login is blocked: connection refused" };
    const past = vi.spyOn(fleetBackup, 'restoreNoticePastDrop').mockReturnValue(true);
    const r = await runAgain('a', true, DUMP);
    expect(past).toHaveBeenCalledWith('a', DUMP);
    expect(r.text).toBe(`Running the main here again was refused: The manager can't confirm the bot's database login is blocked: connection refused.${PUSH}${STOPPED_AGAIN}`);
    past.mockReturnValue(false);
    const plain = await runAgain('a', true, DUMP);
    expect(plain.text).toBe(`Running the main here again was refused: The manager can't confirm the bot's database login is blocked: connection refused.${STOPPED_AGAIN}`);
  });
});

/** C3: a refusal of row 10 wrote nothing: the record as the hand-over left it, no save, no raise, generation 3. */
const unchanged = (record: any, patches: any[]) => {
  expect(stored('a').fleetDb.handover).toEqual(record);
  expect(patches).toEqual([]);
  expect(h.events).not.toContain('raise');
  expect(gen()).toBe(3);
};

describe('NM42 rows 10, 12, 24: start, maintenance, fence, slot, a throw', () => {
  it('10: the start fails and docker shows it stopped: RA7 with nothing changed', async () => {
    const { record } = await handedOver();
    h.dbStart = { success: false, error: 'compose failed' };
    const patches = trackSaves();
    const r = await runAgain('a', true);
    expect(r.text).toBe(`Running the main here again was refused: this database did not start (compose failed)${NOTHING}.`);
    expect(h.events).not.toContain('require-maintenance');
    unchanged(record, patches);
    expect(isFleetBackupBusy('a')).toBe(false);
  });

  it('10: the login open: RA8 and the database stopped again', async () => {
    const { record } = await handedOver();
    h.proof = { ok: false, error: "The manager can't confirm the bot's database login is blocked: connection refused" };
    const patches = trackSaves();
    const r = await runAgain('a', true);
    expect(r.text).toBe(`Running the main here again was refused: The manager can't confirm the bot's database login is blocked: connection refused.${STOPPED_AGAIN}`);
    expect(h.sidecar['a-pg']).toBe(false);
    unchanged(record, patches);
  });

  it('10: a database that ran before the press: RA8 says nothing was changed and leaves it running', async () => {
    const { record } = await handedOver();
    h.sidecar['a-pg'] = true;
    h.proof = { ok: false, error: "The manager can't confirm the bot's database login is blocked: connection refused" };
    const patches = trackSaves();
    const r = await runAgain('a', true);
    expect(r.text).toBe(`Running the main here again was refused: The manager can't confirm the bot's database login is blocked: connection refused${NOTHING}.`);
    expect(h.events).not.toContain('db-stop');
    unchanged(record, patches);
  });

  it('10: the fence on: RA10, the stop-again form 2 when the stop fails, form 3 when docker does not answer', async () => {
    const { record } = await handedOver();
    h.fence = { ok: true, on: true, owner: null, persisted: true };
    const patches = trackSaves();
    const r = await runAgain('a', true);
    expect(r.text).toMatch(/^The bot's database is READ-ONLY, and .*Running the main here again was refused and nothing was changed.* This database is stopped again\.$/);
    unchanged(record, patches);
    h.dbStop = { success: false, error: 'compose stop failed' };
    h.sidecar['a-pg'] = false;
    const form2 = await runAgain('a', true);
    expect(form2.text.endsWith(" It did not stop again (compose stop failed); it runs with the bot's login blocked, and the hand-over stays recorded.")).toBe(true);
    expect(form2.text).not.toContain('nothing was changed');
    unchanged(record, patches);
    h.sidecar['a-pg'] = false;
    vi.spyOn(containerManager, 'stopFleetDbSidecar').mockImplementation(async () => { h.events.push('db-stop'); h.sidecar['a-pg'] = null; return { success: false, error: 'compose stop failed' }; });
    const form3 = await runAgain('a', true);
    expect(form3.text.endsWith(" The manager can't confirm that it stopped again (compose stop failed); the hand-over stays recorded.")).toBe(true);
    unchanged(record, patches);
    expect(isFleetBackupBusy('a')).toBe(false);
  });

  it('10: the slot is held: SLOT_BUSY, no events', async () => {
    const { record } = await handedOver();
    expect(claimFleetBackupBusy('a')).toBe(true);
    const patches = trackSaves();
    const r = await runAgain('a', true);
    expect(r.text).toBe(`A backup or restore operation is in progress on this database; wait for it to finish${NOTHING}`);
    expect(h.events).toEqual([]);
    unchanged(record, patches);
  });

  it('12: a throw leaves a true reply: still recorded with the stop-again, or no longer recorded with no stop', async () => {
    const { record } = await handedOver();
    vi.spyOn(dbLogin, 'readWriteFence').mockRejectedValueOnce(new Error('socket closed'));
    const r = await runAgain('a', true);
    expect(r).toEqual({ success: false, status: 500, text: `Running the main here again stopped on an unexpected error (socket closed); the hand-over is still recorded.${STOPPED_AGAIN}` });
    expect(stored('a').fleetDb.handover).toEqual(record);
    h.events.length = 0;
    vi.spyOn(containerManager, 'broadcastBotUpdated').mockImplementation(() => { throw new Error('ws gone'); });
    const after = await runAgain('a', true);
    expect(after).toEqual({ success: false, status: 500, text: `Running the main here again stopped on an unexpected error (ws gone); the hand-over is no longer recorded.${PUSH}` });
    expect(stored('a').fleetDb.handover).toBeUndefined();
    expect(h.events.indexOf('db-stop')).toBe(-1);
    expect(isFleetBackupBusy('a')).toBe(false);
  });

  it('24: pg_hba lines of a fence stand: the hand-over ends and the reply says so; an unreadable fence refuses', async () => {
    await handedOver();
    vi.spyOn(fleetBackup, 'fenceLayers').mockResolvedValueOnce(null);
    const unread = await runAgain('a', true);
    expect(unread.text).toBe(`Running the main here again was refused: the manager can't confirm whether this database still refuses the bot's connections (its write fence could not be read).${STOPPED_AGAIN}`);
    expect(stored('a').fleetDb.handover).toBeDefined();
    expect(h.events[h.events.length - 1]).toBe('db-stop');
    vi.spyOn(fleetBackup, 'fenceLayers').mockResolvedValueOnce({ readOnly: false, hba: true, readOnlyOwner: null, hbaOwner: 'restore:1700000000000', ownerFile: '' } as any);
    const r = await runAgain('a', true);
    expect(r).toEqual({ success: true, text: `This machine runs the main again: the hand-over to slot_c is ended, and this database holds generation 5, above the 4 a take-over on slot_c writes. ${LEAD} This database still refuses the bot's connections: the lines of a write fence stand in its pg_hba.conf. Until a restore lifts them, which the end of the hand-over now allows (restore a dump with the bot in Maintenance or Off), the bot cannot connect here, and slot_c's manager cannot read this database's generation, so it does not stop the bot on slot_c. Once that fence is lifted: ${OUT('generation 5', `generation ${EQ(5)}`)}` });
    expect(stored('a').fleetDb.handover).toBeUndefined();
    expect(gen()).toBe(5);
  });
});

describe('NM42 rows 13, 19, 27: the lane restore and the clear', () => {
  it('13: the plain restore is refused under the record; the lane restore passes that line and refuses on the counts file', async () => {
    await handedOver();
    await brokenPush();
    writeDump(true, false);
    const plain = await fleetBackup.restoreFleetBackup('a', DUMP);
    expect(plain).toMatchObject({ success: false, error: `${noAddressRestoreRefusal(inst().fleetDb!)} (nothing was changed)` });
    const lane = await containerManager.withExternalBotOp('a', 'run-again', () => fleetBackup.restoreUnderLane('a', DUMP, 'run-again'));
    expect(lane).toMatchObject({ success: false, refusedAs: 'read', error: `The dump ${DUMP} has no counts file (${DUMP}.json), so the manager cannot check what it restores and the restore was refused (nothing was changed); Run the main here again restores only this dump` });
    expect(h.events).toEqual([]);
  });

  it('19: the restore retry step under the real writers\' records', async () => {
    await handedOverWaiting();
    expect(fleetBackup.restoreRetryRemedy(inst())).toBe('cancel the hand-over, move the main back, or press Run the main here again, then run a restore again with the bot in Maintenance or Off to retry the lift');
    await handedOver();
    expect(fleetBackup.restoreRetryRemedy(inst())).toBe('move the main back, or press Run the main here again, then run a restore again with the bot in Maintenance or Off to retry the lift');
    await brokenPush();
    expect(fleetBackup.restoreRetryRemedy(inst())).toBe('press Run the main here again, which restores the dump again and retries the lift');
  });

  it('27: the restore\'s clear drops a stored target in one save, and the next question says 5 or more', async () => {
    const { record } = await handedOver();
    fake.dbs['a-pg'].fail.raise = 'ERROR:  could not extend file';
    await runAgain('a', true);
    delete fake.dbs['a-pg'].fail.raise;
    expect(stored('a').fleetDb.handover.runAgainGeneration).toBe(5);
    await brokenPush();
    writeDump();
    const patches = trackSaves();
    await fleetBackup.clearPushBrokenMark('a');
    expect(patches).toEqual([{ pushBroken: null, handover: record }]);
    expect(stored('a').fleetDb.pushBroken).toBeUndefined();
    expect(stored('a').fleetDb.handover).toEqual(record);
    const q = await runAgain('a');
    expect(q.text).toBe(CONFIRM(utcText(Date.parse(record.at))));
  });
});

describe('NM42 row 14a: the texts of part A', () => {
  const STOPPED = "Handed over to slot_c, which has no address for other machines, so this machine does not rejoin it as a copy by itself. Its database stays stopped. To move the main back, press Receive a main here, then Push the main in slot_c's manager.";

  it('the hand-over reply and the stopped card line', async () => {
    const { r } = await handedOver();
    expect(r.text.endsWith(" The copy on slot_c has no address for other machines, so after it takes over it is the main only while it runs alone, and this machine does not rejoin it as a copy by itself. To move the main back later, press Receive a main here, then Push the main in slot_c's manager.")).toBe(true);
    const v = switchView(inst());
    expect(v.lines[0]).toBe(`${STOPPED} Cancel the hand-over only if slot_c never took over. If slot_c is lost for good, press Run the main here again.`);
    expect(v.badges[0]).toEqual({ text: 'Handed over', title: v.lines[0], danger: false });
    expect(v.noAddress).toBe(true);
  });

  it('the waiting card line and badge', async () => {
    await handedOverWaiting();
    const title = "The hand-over to slot_c did not finish, and slot_c has no address for other machines. Hand over again finishes it while slot_c's copy streams from this database; Receive a main takes the main back when slot_c's copy is not connected; Cancel the hand-over ends it when slot_c's copy receives the cancel; if slot_c is lost for good, press Run the main here again.";
    const v = switchView(inst());
    expect(v.lines).toEqual([title]);
    expect(v.badges).toEqual([{ text: 'Hand-over not finished', title, danger: true }]);
  });

  it('the receiving line and the broken push lines', async () => {
    await handedOver();
    await receive('a');
    expect(switchView(inst()).lines[0]).toBe("Handed over to slot_c, which has no address for other machines, so this machine does not rejoin it as a copy by itself. Its database runs to receive the main back; the hand-over stays recorded until a push from slot_c's manager finishes, or until you press Stop receiving and then Run the main here again if slot_c is lost for good.");
    fake.dbs['a-pg'].dbOid = '99999';
    await stopReceive('a');
    const v = switchView(inst());
    expect(v.lines[0]).toBe(`${STOPPED} If slot_c is lost for good, press Run the main here again.`);
    expect(v.lines[1]).toMatch(new RegExp(`a restore is refused while the hand-over is recorded\\. If slot_c is lost for good, press Run the main here again, which restores that dump first\\.$`));
  });

  it('Cancel\'s refusals name the button', async () => {
    await handedOver();
    fake.dbs['a-pg'].deleteLsn = '0/5000010';
    const r = await cancelHandOver('a', true);
    expect(r.text.endsWith('start that copy and press Cancel the hand-over again. If slot_c is lost for good, press Run the main here again.')).toBe(true);
    await brokenPush();
    expect((await cancelHandOver('a', true)).text).toBe(`A push replaced this database and did not finish, so it is no longer the database that was handed over; press Receive a main again so slot_c can push again. If slot_c is lost for good, press Run the main here again, which restores the dump ${DUMP} first.`);
  });

  it('the op name in the busy text and in the lane\'s unexpected error', async () => {
    await handedOver();
    const busy = await containerManager.withExternalBotOp('a', 'run-again', () => cancelHandOver('a'));
    expect(busy.text).toBe(`Operation 'running the main here again' is running on this bot; wait for it to finish${NOTHING}`);
    vi.spyOn(fleetBackup, 'shownRestoreNoticeFile').mockImplementation(() => { throw new Error('boom'); });
    expect(await runAgain('a', true)).toEqual({ success: false, status: 500, text: 'Running the main here again stopped on an unexpected error: boom' });
  });
});

describe('NM42 rows 16, 28: the route and the served flag', () => {
  const router = createBotRoutes({ clients: new Set() } as any);
  const post = async (body: unknown): Promise<{ status: number; body: any }> => {
    const layer = (router as any).stack.find((l: any) => l.route?.path === '/:id/fleet-run-again' && l.route.methods.post);
    const res: any = { statusCode: 200 };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    await layer.route.stack[layer.route.stack.length - 1].handle({ params: { id: 'a' }, query: {}, body }, res);
    return { status: res.statusCode, body: res.body };
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 50));

  it('16: the question is a 409 with needsConfirm and confirmDump; confirm with no dump runs the lane', async () => {
    const { record } = await handedOver();
    expect(await post({})).toEqual({ status: 409, body: { success: false, error: CONFIRM(utcText(Date.parse(record.at))), needsConfirm: true, confirmDump: '' } });
    const r = await post({ confirm: true });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, opId: expect.any(String) });
    await vi.waitFor(() => expect(stored('a').fleetDb.handover).toBeUndefined());
    await settle();
  });

  it('16: the route forwards confirmDump both ways', async () => {
    await handedOver();
    await brokenPush();
    writeDump();
    const q = await post({ confirm: true, confirmDump: 7 });
    expect(q).toEqual({ status: 409, body: { success: false, error: CONFIRM_PB, needsConfirm: true, confirmDump: DUMP } });
    spyRestore(restoredTo(4));
    const r = await post({ confirm: true, confirmDump: DUMP });
    expect(r.body).toEqual({ success: true, opId: expect.any(String) });
    await vi.waitFor(() => expect(stored('a').fleetDb.handover).toBeUndefined());
    await settle();
  });

  it('28: the change key carries noAddress', async () => {
    writeRegistry({ a: mainFixture(), c: portlessCopy() });
    const seen = new Map<string, string>();
    collectHealthChanges(seen);
    await handedOverWaiting();
    const pushes = collectHealthChanges(seen).filter(p => p.id === 'a');
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ noAddress: true, takeBack: false });
  });

  it('28b: the served runAgain flag is runAgainAdmission: true in both phases, false under a receive, a live copy, two mains and a notice', async () => {
    await handedOver();
    expect(switchView(inst())).toMatchObject({ noAddress: true, runAgain: true });
    h.memoryNotice = 'old.dump';
    expect(switchView(inst()).runAgain).toBe(false);
    h.memoryNotice = null;
    const a = stored('a');
    writeRegistry({ a: { ...a, fleetDbReplica: { ...PORTLESS } }, c: portlessCopy() });
    expect(switchView(inst())).toMatchObject({ noAddress: true, runAgain: false });
    writeRegistry({ a, c: portlessCopy() });
    containerManager.updateInstanceFleetDbSwitch('a', { mainConflict: { machine: 'other.example', host: 'other.example', port: 5433, generation: 3, at: '2026-11-21T10:00:00.000Z' } });
    expect(switchView(inst())).toMatchObject({ noAddress: true, runAgain: false });
    writeRegistry({ a, c: portlessCopy() });
    await receive('a');
    expect(switchView(inst())).toMatchObject({ noAddress: true, runAgain: false });
    await handedOverWaiting();
    expect(switchView(inst())).toMatchObject({ noAddress: true, takeBack: false, runAgain: true });
  });
});

describe('NM42 rows 14c, 15c: the texts that name Run the main here again', () => {
  const RUN = "Run the main here again (if slot_c is lost for good)";
  const BACK = "the move back (Receive a main here, then Push the main in slot_c's manager)";
  const badgesOf = () => {
    const view = switchView(inst());
    return switchBadges({ ...inst(), fleetDb: stored('a').fleetDb, noAddress: view.noAddress, takeBack: view.takeBack } as unknown as TuiBot);
  };

  it('waiting: the refusals and the badge name the button', async () => {
    await handedOverWaiting();
    const lead = "This machine's hand-over of its main database to slot_c did not finish, and slot_c has no address for other machines";
    const ends = `Hand over again finishes it while slot_c's copy streams from this database, and Cancel the hand-over, ${BACK} or ${RUN} ends it`;
    expect(switchStartRefusal(inst())).toBe(`${lead}, so the bot does not start here while the hand-over is recorded: ${ends}`);
    expect(noAddressRestoreRefusal(stored('a').fleetDb)).toBe(`${lead}; a restore is refused while the hand-over is recorded: ${ends}`);
    expect(switchDbStartRefusal(inst())).toBe(`${lead}; Hand over again, Cancel the hand-over, Receive a main and Run the main here again start its database when they need it`);
    const title = "The hand-over to slot_c did not finish, and slot_c has no address for other machines. Hand over again finishes it while slot_c's copy streams from this database; Receive a main takes the main back when slot_c's copy is not connected; Cancel the hand-over ends it when slot_c's copy receives the cancel; if slot_c is lost for good, press Run the main here again.";
    expect(badgesOf()).toEqual([{ text: 'Hand-over not finished', title, danger: true }]);
    expect(switchView(inst()).badges[0].title).toBe(title);
    const unflagged = switchBadges({ ...inst(), fleetDb: stored('a').fleetDb } as unknown as TuiBot);
    expect(unflagged).toEqual([{ text: 'Hand-over not finished', title: 'Press Hand over again, or Cancel the hand-over', danger: true }]);
  });

  it('stopped: the refusals, and the terminal badges match switchView', async () => {
    await handedOver();
    const ends = `${BACK}, a Cancel the hand-over that slot_c's copy receives, or ${RUN} ends it`;
    expect(noAddressRestoreRefusal(stored('a').fleetDb)).toBe(`This machine handed its main database to slot_c, which has no address for other machines; a restore is refused while the hand-over is recorded: ${ends}`);
    expect(switchStateRefusal(inst(), 'running')).toContain(`so its state cannot change while the hand-over is recorded: ${ends}${NOTHING}`);
    expect(switchDbStartRefusal(inst())).toMatch(/the database stays stopped until Receive a main, Cancel the hand-over or Run the main here again starts it$/);
    const view = switchView(inst());
    expect(badgesOf().map(b => b.title)).toEqual(view.badges.map(b => b.title));
    expect(view.badges[0].title).toContain('does not rejoin it as a copy by itself');
    await receive('a');
    expect(badgesOf()[0].title).toBe(switchView(inst()).badges[0].title);
    expect(badgesOf()[0].title).toContain('or until you press Stop receiving and then Run the main here again if slot_c is lost for good.');
  });

  it('a broken push: Stop receiving, the expiry log, the refusals and the pushBroken badge', async () => {
    await handedOver();
    await receive('a');
    fake.dbs['a-pg'].dbOid = '99999';
    const r = await stopReceive('a');
    expect(r.text).toContain(`press Receive a main again so slot_c can push again, or, if slot_c is lost for good, press Run the main here again, which restores the dump ${DUMP} (taken before receiving) first. That dump stays with the backups;`);
    const ends = `${BACK} or Run the main here again (if slot_c is lost for good; it restores the dump ${DUMP} first) ends it`;
    expect(switchStartRefusal(inst())).toBe(`This machine handed its main database to slot_c, which has no address for other machines, so the bot does not start here while the hand-over is recorded: ${ends}`);
    expect(switchDbStartRefusal(inst())).toMatch(/the database stays stopped until Receive a main or Run the main here again starts it$/);
    const view = switchView(inst());
    expect(badgesOf().map(b => b.title)).toEqual(view.badges.map(b => b.title));
    expect(badgesOf()[1].title).toContain('If slot_c is lost for good, press Run the main here again, which restores that dump first.');
  });

  it('a broken push found at the expiry logs the button as a way out', async () => {
    await handedOver();
    await receive('a');
    const at = Date.parse(stored('a').fleetDb.receive.expiresAt) + 1;
    fake.dbs['a-pg'].dbOid = '99999';
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
    await receiveStep(inst(), at);
    spy.mockRestore();
    expect(lines.some(l => l.includes(`until a push from slot_c finishes or Run the main here again ends the hand-over (the dump`))).toBe(true);
  });
});
