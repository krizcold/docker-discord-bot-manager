import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm41-'));
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
import { decodeMoveCode, encodeJoinCode } from '../../src/config/joinCode';
import { MOVE_TIMING, receive, receiveStep, stopReceive } from '../../src/instance/fleetMove';
import { cancelHandOver, handOver, mainAdmission, resetSwitchState, SWITCH_TIMING, switchTick, switchView, takeOverMain } from '../../src/instance/fleetSwitch';
import { switchDbStartRefusal, switchStartRefusal, switchStateRefusal } from '../../src/instance/switchSql';
import { claimFleetBackupBusy, releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import * as containerManager from '../../src/docker/containerManager';
import * as fleetBackup from '../../src/instance/fleetBackup';
import { COPY, copyFixture, fake, fakeJoin, freshDb, h, mainFixture, registryFile, resetHarness, seedDbs, stored, writeRegistry } from './switch-harness';

const NOTHING = '; nothing was changed';
const DUMP = 'pre-receive-2026-10-28T12-00-00-000Z.dump';
const OFF = { state: 'off', message: '', orderedAt: '2026-10-30T00:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: 'maintenance' };
const { publicHost: _ph, hostPort: _hp, certHost: _ch, ...PORTLESS } = COPY;
const portlessCopy = () => copyFixture({ fleetDbReplica: { ...PORTLESS } });

const READY = `Paste this move code into Push the main in the other machine's manager within 24 hours. It replaces this machine's database with the pushed one; a dump of this one is kept with the backups (${DUMP}). The code holds passwords: paste it only into your own managers.`;
const T3 = " This machine's database was started to receive it; the hand-over to slot_c stays recorded until the push finishes.";
const T4_TAIL = (error: string) => ` The database was started for Receive and did not stop again (${error}); it runs with the bot's login blocked, and the hand-over stays recorded.`;
const T5 = " This machine's database is stopped again; the hand-over to slot_c is still recorded.";
const T6 = (state: string, dbClause = 'and the database is stopped again') => `The manager can't confirm whether slot_c took over: slot_c registered no address, so this manager cannot read it, and its copy did not receive the cancel within 0 seconds (${state}). The hand-over stays recorded, the bot's login stays blocked, this database's generation was not changed, ${dbClause}. If slot_c's manager shows it as the main, move the main back: press Receive a main here, then Push the main there. If it shows its copy still following this database, start that copy and press Cancel the hand-over again. If slot_c is lost for good, press Run the main here again.`;
const T6_WAITING = (state: string, dbClause = 'and the database is stopped again') => `The manager can't confirm whether slot_c took over: slot_c registered no address, so this manager cannot read it, and its copy did not receive the cancel within 0 seconds (${state}). The hand-over stays recorded, the bot's login stays blocked, this database's generation was not changed, ${dbClause}. If slot_c's manager shows it as the main, move the main back: press Receive a main here, which first stops this database and the bot when slot_c's copy is not connected; then Push the main there. If it shows its copy still following this database, start that copy and press Cancel the hand-over again; while this database runs and the copy streams, Hand over again finishes the hand-over instead. If slot_c is lost for good, press Run the main here again.`;
const X_OK = "The hand-over is cancelled: this database runs again as the main, with the bot's login still blocked. Choose Running in the State window to start the bot here.";

function trackSaves() {
  const real = containerManager.updateInstanceFleetDbSwitch;
  const patches: any[] = [];
  const spy = vi.spyOn(containerManager, 'updateInstanceFleetDbSwitch').mockImplementation(((id: string, patch: any) => {
    patches.push(patch);
    return real(id, patch);
  }) as any);
  return { patches, restore: () => spy.mockRestore() };
}

/** The hand-over's own code run against a copy that registered no address; answers the record it stored. */
async function handedOver(opts: { registry?: Record<string, Record<string, unknown>>; addresses?: boolean } = {}): Promise<any> {
  writeRegistry(opts.registry ?? { a: mainFixture(), c: portlessCopy() });
  if (!opts.addresses) fake.dbs['a-pg'].addresses = [];
  const r = await handOver('a', 'slot_c');
  const events = [...h.events];
  // Docker shows the bot stopped after the hand-over stopped it.
  h.app = false;
  h.events.length = 0;
  return { r, events, record: stored('a').fleetDb.handover };
}

/** The hand-over row as the copy's database holds it once it replayed the main's. */
function copyReplayed(): void {
  fake.dbs['c-pg'] = freshDb({ recovery: true, generation: { ...fake.dbs['a-pg'].generation! }, handover: fake.dbs['a-pg'].handover ? { ...fake.dbs['a-pg'].handover } : null });
}

const inst = () => containerManager.getBot('a')!;
const unseen = () => { fake.dbs['a-pg'].deleteLsn = '0/5000010'; };

let now = Date.parse('2026-11-20T10:00:00Z');

beforeEach(() => {
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
});
afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

describe('NM41: the planned move to a copy that registered no address', () => {
  it('the hand-over leaves the record and a stopped database', async () => {
    const { r, events, record } = await handedOver();
    expect(r.success).toBe(true);
    expect(record).toMatchObject({ mode: 'stream', phase: 'stopped', slot: 'slot_c', machine: 'slot_c', generation: 4 });
    expect(record.host).toBeUndefined();
    expect(record.port).toBeUndefined();
    expect(record.cert).toBeUndefined();
    expect(events[events.length - 1]).toBe('db-stop');
    expect(r.text.endsWith(" The copy on slot_c has no address for other machines, so after it takes over it is the main only while it runs alone, and this machine does not rejoin it as a copy by itself. To move the main back later, press Receive a main here, then Push the main in slot_c's manager.")).toBe(true);
    const view = switchView(inst());
    expect(view.takeBack).toBe(true);
    expect(view.lines[0]).toBe("Handed over to slot_c, which has no address for other machines, so this machine does not rejoin it as a copy by itself. Its database stays stopped. To move the main back, press Receive a main here, then Push the main in slot_c's manager. Cancel the hand-over only if slot_c never took over. If slot_c is lost for good, press Run the main here again.");
  });

  it('the take-over leaves the copy alone with formerMain', async () => {
    await handedOver();
    copyReplayed();
    const r = await takeOverMain('c');
    expect(r.success).toBe(true);
    const db = stored('c').fleetDb;
    expect(db.replication).toBeUndefined();
    expect(db.formerMain).toMatchObject({ generation: 3 });
    expect(fake.dbs['c-pg'].generation).toMatchObject({ generation: 4 });
    expect(mainAdmission(containerManager.getBot('c')!, { replication: false, noun: 'push' })).toBeNull();
  });

  it('the old main learns nothing by itself', async () => {
    const { record } = await handedOver({ registry: { a: mainFixture() } });
    await switchTick(now);
    await switchTick(now + 6 * 60_000);
    h.sidecar['a-pg'] = true;
    await switchTick(now + 12 * 60_000);
    expect(h.events.filter(e => e.startsWith('probe'))).toEqual([]);
    expect(h.reseedCalls).toEqual([]);
    const db = stored('a').fleetDb;
    expect(db.replacedBy).toBeUndefined();
    expect(db.mainConflict).toBeUndefined();
    expect(db.handover).toEqual(record);
  });
});

describe('NM41: Receive takes the main back under the record', () => {
  it('Receive is admitted from Maintenance: the database started with the override, the dump, both records stored', async () => {
    const { record } = await handedOver();
    expect(stored('a').maintenance.state).toBe('maintenance');
    const r = await receive('a');
    expect(r).toMatchObject({ success: true, text: READY + T3 });
    const code = decodeMoveCode(r.moveCode!);
    expect(code.ok && code.code.recv.user).toBe('smdb_receive');
    const order = ['db-start:override', 'require-maintenance', 'dump:pre-receive-'].map(e => h.events.indexOf(e));
    expect(order.every(i => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(h.events).not.toContain('db-stop');
    expect(stored('a').fleetDb.receive).toMatchObject({ safetyDump: DUMP });
    expect(stored('a').fleetDb.handover).toEqual(record);
    const view = switchView(inst());
    expect(view.lines[0]).toBe("Handed over to slot_c, which has no address for other machines, so this machine does not rejoin it as a copy by itself. Its database runs to receive the main back; the hand-over stays recorded until a push from slot_c's manager finishes, or until you press Stop receiving and then Run the main here again if slot_c is lost for good.");
  });

  it.each([
    [true, "the bot runs here, and taking the main back needs docker to show it stopped. Press Stop on the bot's card, then Receive a main again."],
    [null, "the manager can't confirm that the bot is stopped here (docker did not say whether it runs). Press Receive a main again."],
  ])('Receive needs the bot stopped: docker answers %s', async (app, why) => {
    const { record } = await handedOver();
    h.app = app;
    const r = await receive('a');
    expect(r).toMatchObject({ success: false, text: `Receiving was refused and nothing was changed: ${why}` });
    expect(h.events.filter(e => e.startsWith('db-start'))).toEqual([]);
    expect(stored('a').fleetDb.receive).toBeUndefined();
    expect(stored('a').fleetDb.handover).toEqual(record);
  });

  it('the database does not start: refused, nothing changed', async () => {
    const { record } = await handedOver();
    h.dbStart = { success: false, error: 'compose failed' };
    const r = await receive('a');
    expect(r).toMatchObject({ success: false, text: `Receiving was refused: this machine's database did not start (compose failed)${NOTHING}` });
    expect(h.events).not.toContain('require-maintenance');
    expect(stored('a').fleetDb.handover).toEqual(record);
  });

  it('a refused Receive leaves the old main as it was: the database stopped again, no receive, the record kept', async () => {
    const { record } = await handedOver();
    h.dump = { success: false, error: 'pg_dump: connection lost' };
    const r = await receive('a');
    expect(r).toMatchObject({ success: false, text: 'The dump of this database failed (pg_dump: connection lost), so nothing was changed' });
    expect(h.events.indexOf('db-start:override')).toBeGreaterThanOrEqual(0);
    expect(h.events.lastIndexOf('db-stop')).toBeGreaterThan(h.events.indexOf('dump:pre-receive-'));
    expect(h.sidecar['a-pg']).toBe(false);
    expect(stored('a').fleetDb.receive).toBeUndefined();
    expect(stored('a').fleetDb.handover).toEqual(record);
  });

  it('a refused Receive whose stop fails says that the database still runs', async () => {
    await handedOver();
    h.dump = { success: false, error: 'pg_dump: connection lost' };
    h.dbStop = { success: false, error: 'compose stop failed' };
    const r = await receive('a');
    expect(r).toMatchObject({ success: false, text: `The dump of this database failed (pg_dump: connection lost).${T4_TAIL('compose stop failed')}` });
    expect(stored('a').fleetDb.handover).toBeDefined();
  });

  it('a Receive refused before the login was proven says so when the stop fails', async () => {
    await handedOver();
    h.proof = { ok: false, error: "The manager can't confirm the bot's database login is blocked: connection refused" };
    h.dbStop = { success: false, error: 'compose stop failed' };
    const r = await receive('a');
    expect(r.text).toBe("Receiving was refused: The manager can't confirm the bot's database login is blocked: connection refused. The database was started for Receive and did not stop again (compose stop failed); it runs, the manager can't confirm that the bot's login is blocked, and the hand-over stays recorded.");
  });

  it('a finished push clears the record in one save, and Running is admitted again', async () => {
    await handedOver();
    await receive('a');
    fake.dbs['a-pg'].received.push({ pushId: stored('a').fleetDb.receive.pushId, from: '7002', machine: 'slot_c', generation: 5 });
    h.events.length = 0;
    const saves = trackSaves();
    await receiveStep(inst(), Date.now());
    saves.restore();
    expect(saves.patches).toEqual([{ receive: null, pushBroken: null, handover: null }]);
    const db = stored('a').fleetDb;
    expect(db.receive).toBeUndefined();
    expect(db.handover).toBeUndefined();
    expect(h.events).not.toContain('db-stop');
    expect(switchStateRefusal(inst(), 'running')).toBeNull();
    expect(switchView(inst()).takeBack).toBe(false);
  });

  it('Stop receiving returns to the handed-over state', async () => {
    const { record } = await handedOver();
    await receive('a');
    h.events.length = 0;
    const r = await stopReceive('a');
    expect(r).toEqual({ success: true, text: `Receiving stopped; the move code no longer works.${T5}` });
    expect(stored('a').fleetDb.receive).toBeUndefined();
    expect(stored('a').fleetDb.handover).toEqual(record);
    expect(h.events).toContain('db-stop');
    expect(h.sidecar['a-pg']).toBe(false);
    expect(switchStartRefusal(inst())).toMatch(/^This machine handed its main database to slot_c, which has no address for other machines, so the bot does not start here while the hand-over is recorded: /);
  });

  it('Stop receiving whose stop fails says that the database still runs', async () => {
    await handedOver();
    await receive('a');
    h.dbStop = { success: false, error: 'compose stop failed' };
    const r = await stopReceive('a');
    expect(r).toEqual({ success: true, text: "Receiving stopped; the move code no longer works. This machine's database did not stop (compose stop failed); it still runs, and the hand-over to slot_c is still recorded." });
    expect(stored('a').fleetDb.handover).toBeDefined();
  });

  it('the expiry returns to the handed-over state and logs the stop', async () => {
    const { record } = await handedOver();
    await receive('a');
    h.events.length = 0;
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    await receiveStep(inst(), Date.parse(stored('a').fleetDb.receive.expiresAt) + 1);
    spy.mockRestore();
    expect(stored('a').fleetDb.receive).toBeUndefined();
    expect(stored('a').fleetDb.handover).toEqual(record);
    expect(h.events).toContain('db-stop');
    expect(logs).toContain('[Switch] A: the move code expired unused; the receive login is removed; the database is stopped again');
    expect(switchStartRefusal(inst())).not.toBeNull();
  });

  it('a broken push keeps the record; Receive again is admitted and takes no dump', async () => {
    const { record } = await handedOver();
    await receive('a');
    fake.dbs['a-pg'].dbOid = '99999';
    const stopped = await stopReceive('a');
    expect(stopped).toEqual({ success: true, text: `Receiving stopped; the move code no longer works. A push replaced this machine's database and did not finish, so the database is empty or holds data that was not checked, and the bot cannot run on it: press Receive a main again so slot_c can push again, or, if slot_c is lost for good, press Run the main here again, which restores the dump ${DUMP} (taken before receiving) first. That dump stays with the backups; a restore is refused while the hand-over to slot_c is recorded.${T5}` });
    expect(stored('a').fleetDb.pushBroken).toMatchObject({ safetyDump: DUMP });
    expect(stored('a').fleetDb.handover).toEqual(record);
    h.events.length = 0;
    const again = await receive('a');
    expect(again.success).toBe(true);
    expect(again.text!.endsWith(T3)).toBe(true);
    expect(h.events).toContain('db-start:override');
    expect(h.events.filter(e => e.startsWith('dump:'))).toEqual([]);
    expect(stored('a').fleetDb.receive).toMatchObject({ safetyDump: DUMP });
    expect(stored('a').fleetDb.handover).toEqual(record);
  });

  it('a copy with an address is unchanged: Receive is refused under its record', async () => {
    const { record } = await handedOver({ addresses: true });
    expect(record).toMatchObject({ phase: 'stopped', host: 'copy.example', port: 5434 });
    expect(switchView(inst()).takeBack).toBe(false);
    const r = await receive('a');
    expect(r).toMatchObject({ success: false, text: `A move of this database is already recorded (a hand-over to copy.example); finish it or Cancel it first${NOTHING}` });
    expect(h.events).toEqual([]);
  });
});

describe('NM41: Cancel under a record with no address', () => {
  it('Cancel succeeds on the replay proof: no question, no probe, no generation write', async () => {
    await handedOver();
    fake.dbs['a-pg'].deleteLsn = '0/5000010';
    let reads = 0;
    fake.dbs['a-pg'].onSlotRead = () => { if (++reads === 2) fake.dbs['a-pg'].slots.slot_c.replay = '0/5000010'; };
    SWITCH_TIMING.catchUpMs = 2000;
    expect(await cancelHandOver('a')).toEqual({ success: true, text: X_OK });
    expect(stored('a').fleetDb.handover).toBeUndefined();
    expect(fake.dbs['a-pg'].generation?.generation).toBe(3);
    expect(h.events).toEqual(['db-start:override', 'handover-delete']);
  });

  it.each([[false], [true]])('Cancel never writes the generation: not replayed, confirm %s', async (confirm) => {
    const { record } = await handedOver();
    unseen();
    const r = await cancelHandOver('a', confirm);
    expect(r).toEqual({ success: false, status: 409, text: T6('16 bytes behind, streaming') });
    expect(fake.dbs['a-pg'].generation).toMatchObject({ generation: 3, machine: 'main.example' });
    expect(stored('a').fleetDb.switchNotice).toBeUndefined();
    expect(stored('a').fleetDb.handover).toEqual(record);
    expect(h.events).toEqual(['db-start:override', 'handover-delete', 'db-stop']);
    expect(h.sidecar['a-pg']).toBe(false);
  });

  it('Cancel that cannot stop the database again says that it still runs', async () => {
    await handedOver();
    unseen();
    h.dbStop = { success: false, error: 'compose stop failed' };
    const r = await cancelHandOver('a', true);
    expect(r).toEqual({ success: false, status: 409, text: T6('16 bytes behind, streaming', 'and the database still runs (compose stop failed)') });
    expect(h.events).not.toContain('raise');
  });

  it('Cancel on a database that ran before the press leaves it running and says so', async () => {
    const { record } = await handedOver();
    unseen();
    h.sidecar['a-pg'] = true;
    const r = await cancelHandOver('a', true);
    expect(r).toEqual({ success: false, status: 409, text: T6('16 bytes behind, streaming', 'and the database runs as it did before this press') });
    expect(h.events).toEqual(['handover-delete']);
    expect(stored('a').fleetDb.handover).toEqual(record);
  });

  it('Cancel refuses beside a receive, and beside an unfinished push; nothing is started', async () => {
    await handedOver();
    await receive('a');
    h.events.length = 0;
    expect(await cancelHandOver('a', true)).toEqual({ success: false, status: 409, text: 'This database is waiting to receive a main; Stop receiving first, then cancel the hand-over.' });
    expect(h.events).toEqual([]);
    fake.dbs['a-pg'].dbOid = '99999';
    await stopReceive('a');
    expect(stored('a').fleetDb.pushBroken).toBeDefined();
    h.events.length = 0;
    expect(await cancelHandOver('a', true)).toEqual({ success: false, status: 409, text: `A push replaced this database and did not finish, so it is no longer the database that was handed over; press Receive a main again so slot_c can push again. If slot_c is lost for good, press Run the main here again, which restores the dump ${DUMP} first.` });
    expect(h.events).toEqual([]);
    expect(stored('a').fleetDb.handover).toBeDefined();
  });

  it('Cancel refuses when the hand-over table is gone', async () => {
    const { record } = await handedOver();
    fake.dbs['a-pg'].tables = false;
    const r = await cancelHandOver('a', true);
    expect(r).toEqual({ success: false, status: 409, text: T6('16 bytes behind, streaming').replace(', and its copy did not receive the cancel within 0 seconds (16 bytes behind, streaming).', ', and this database holds no hand-over table, so no cancel was sent to its copy.') });
    expect(r.text).toContain('so this manager cannot read it, and this database holds no hand-over table, so no cancel was sent to its copy. The hand-over stays recorded');
    expect(stored('a').fleetDb.handover).toEqual(record);
    expect(h.events).not.toContain('raise');
    expect(h.events[h.events.length - 1]).toBe('db-stop');
  });
});

describe('NM41: the switch by hand to a copy that registered no address', () => {
  it('the old main gets no record, and Receive on it in Off is admitted', async () => {
    writeRegistry({ a: mainFixture({ maintenance: OFF }), c: portlessCopy() });
    fake.dbs['a-pg'].addresses = [];
    const took = await takeOverMain('c', { confirm: true });
    expect(took.success).toBe(true);
    expect(stored('c').fleetDb.replication).toBeUndefined();
    await switchTick(now);
    await switchTick(now + 6 * 60_000);
    const db = stored('a').fleetDb;
    expect(db.replacedBy).toBeUndefined();
    expect(db.mainConflict).toBeUndefined();
    expect(db.handover).toBeUndefined();
    h.proof = { ok: true, state: 'off', enforcement: 'database', botConfirmed: true };
    h.events.length = 0;
    const r = await receive('a');
    expect(r).toMatchObject({ success: true, text: READY });
    expect(h.events.filter(e => e.startsWith('db-start'))).toEqual([]);
    expect(stored('a').fleetDb.receive).toBeDefined();
  });
});

describe('NM41 fix 1: a waiting record with no address (R1, Q1)', () => {
  /** The hand-over's own code with the save of phase 'stopped' failing: waiting, no address, both containers stopped. */
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
  const FINISHED = ' The hand-over to slot_c is now recorded as finished: docker showed this database and the bot stopped.';
  const NOT_FINISHED = (why: string) => `Receiving was refused and nothing was changed: the hand-over to slot_c did not finish, ${why}`;

  it('the writer leaves waiting, no address, the database stopped', async () => {
    const { r, record } = await handedOverWaiting();
    expect(r.success).toBe(true);
    expect(record).toMatchObject({ mode: 'stream', phase: 'waiting', slot: 'slot_c', generation: 4 });
    expect(record.host).toBeUndefined();
    expect(h.sidecar['a-pg']).toBe(false);
    expect(switchView(inst()).takeBack).toBe(false);
  });

  it('Cancel with confirm, not replayed: the record is finished and kept, no generation write, no notice', async () => {
    const { record } = await handedOverWaiting();
    unseen();
    const r = await cancelHandOver('a', true);
    expect(r).toEqual({ success: false, status: 409, text: T6('16 bytes behind, streaming') + FINISHED });
    expect(fake.dbs['a-pg'].generation).toMatchObject({ generation: 3, machine: 'main.example' });
    expect(h.events).toEqual(['db-start:override', 'handover-delete', 'db-stop']);
    expect(stored('a').fleetDb.switchNotice).toBeUndefined();
    expect(stored('a').fleetDb.handover).toEqual({ ...record, phase: 'stopped' });
  });

  it('Cancel with confirm while docker shows the bot running: the record stays waiting, no generation write', async () => {
    const { record } = await handedOverWaiting();
    h.app = true;
    unseen();
    const r = await cancelHandOver('a', true);
    expect(r).toEqual({ success: false, status: 409, text: T6_WAITING('16 bytes behind, streaming') });
    expect(fake.dbs['a-pg'].generation).toMatchObject({ generation: 3 });
    expect(h.events).toEqual(['db-start:override', 'handover-delete', 'db-stop']);
    expect(stored('a').fleetDb.switchNotice).toBeUndefined();
    expect(stored('a').fleetDb.handover).toEqual(record);
  });

  it('Cancel without confirm asks nothing and cancels on the replayed delete', async () => {
    await handedOverWaiting();
    expect(await cancelHandOver('a')).toEqual({ success: true, text: X_OK });
    expect(stored('a').fleetDb.handover).toBeUndefined();
    expect(fake.dbs['a-pg'].generation?.generation).toBe(3);
    expect(h.events.filter(e => e.startsWith('probe') || e === 'raise')).toEqual([]);
  });

  it('Receive finishes the record and is admitted', async () => {
    const { record } = await handedOverWaiting();
    const r = await receive('a');
    expect(r).toMatchObject({ success: true, text: READY + T3 + FINISHED });
    expect(stored('a').fleetDb.handover).toEqual({ ...record, phase: 'stopped' });
    expect(stored('a').fleetDb.receive).toMatchObject({ safetyDump: DUMP });
  });

  it.each([
    [true, 'and its copy is connected to this database (streaming). Press Hand over again to finish it, or Cancel the hand-over.'],
    [null, 'and docker did not say whether this database runs. Press Receive a main again.'],
  ])('Receive is refused, with nothing stopped, while docker answers %s for the database and the copy streams', async (running, dbText) => {
    const { record } = await handedOverWaiting();
    h.sidecar['a-pg'] = running;
    const r = await receive('a');
    expect(r).toEqual({ success: false, status: 409, text: NOT_FINISHED(dbText) });
    expect(h.events).toEqual([]);
    expect(stored('a').fleetDb.handover).toEqual(record);
  });

  it('the save of the finished record fails: Receive and Cancel refuse with nothing changed', async () => {
    const { record } = await handedOverWaiting();
    h.failSwitchWrite = 'disk full';
    expect(await receive('a')).toEqual({ success: false, status: 409, text: 'Receiving was refused and nothing was changed: docker shows this database and the bot stopped, but the manager could not save the hand-over to slot_c as finished (disk full); try again.' });
    expect(await cancelHandOver('a', true)).toEqual({ success: false, status: 409, text: 'The hand-over was not cancelled and nothing was changed: docker shows this database and the bot stopped, but the manager could not save the hand-over to slot_c as finished (disk full); try again.' });
    expect(h.events).toEqual([]);
    expect(stored('a').fleetDb.handover).toEqual(record);
  });
});

describe('NM41 fix 1: a database this press tried to start is stopped again (R2)', () => {
  const NOT_READY = 'database did not become ready within 30 seconds';
  it('Receive: the start fails with the container up: it is stopped, and then nothing was changed', async () => {
    const { record } = await handedOver();
    h.dbStart = { success: false, error: NOT_READY, ran: true };
    const r = await receive('a');
    expect(r).toEqual({ success: false, status: 409, text: `Receiving was refused: this machine's database did not start (${NOT_READY})${NOTHING}` });
    expect(h.events).toEqual(['db-start:override', 'db-stop']);
    expect(h.sidecar['a-pg']).toBe(false);
    expect(stored('a').fleetDb.handover).toEqual(record);
  });

  it('Receive: the start fails and the container does not stop: the reply says that it runs', async () => {
    await handedOver();
    h.dbStart = { success: false, error: NOT_READY, ran: true };
    h.dbStop = { success: false, error: 'compose stop failed' };
    const r = await receive('a');
    expect(r.text).toBe(`Receiving was refused: this machine's database did not start (${NOT_READY}). Its container did not stop again (compose stop failed); it runs, the manager can't confirm that the bot's login is blocked, and the hand-over stays recorded.`);
  });

  it("Receive: the start fails and docker does not say whether the container runs: can't confirm", async () => {
    await handedOver();
    h.sidecar['a-pg'] = null;
    h.dbStart = { success: false, error: NOT_READY };
    h.dbStop = { success: false, error: 'compose stop failed' };
    const r = await receive('a');
    expect(r.text).toBe(`Receiving was refused: this machine's database did not start (${NOT_READY}). The manager can't confirm that its container stopped again (compose stop failed); the hand-over stays recorded.`);
  });

  it('Receive: a throw after the start: the database is stopped again', async () => {
    const { record } = await handedOver();
    const spy = vi.spyOn(fleetBackup, 'runFleetDump').mockRejectedValueOnce(new Error('boom'));
    const r = await receive('a');
    spy.mockRestore();
    expect(r).toEqual({ success: false, status: 500, text: "Receiving stopped on an unexpected error (boom). This machine's database is stopped again, and the hand-over stays recorded." });
    expect(h.events[h.events.length - 1]).toBe('db-stop');
    expect(h.sidecar['a-pg']).toBe(false);
    expect(stored('a').fleetDb.handover).toEqual(record);
    expect(stored('a').fleetDb.receive).toBeUndefined();
  });

  it('Receive: a refusal whose stop-again fails no longer says that nothing was changed', async () => {
    await handedOver();
    h.fence = { ok: false, cls: 'other', error: 'connection refused' };
    h.dbStop = { success: false, error: 'compose stop failed' };
    const r = await receive('a');
    expect(r.text).toBe("The manager could not read whether the bot's database is READ-ONLY (connection refused), so receiving was refused. The database was started for Receive and did not stop again (compose stop failed); it runs with the bot's login blocked, and the hand-over stays recorded.");
  });

  it("Receive: a stop-again that docker does not confirm reads can't confirm", async () => {
    await handedOver();
    h.dump = { success: false, error: 'pg_dump: connection lost' };
    const real = containerManager.stopFleetDbSidecar;
    const spy = vi.spyOn(containerManager, 'stopFleetDbSidecar').mockImplementation((async () => { h.events.push('db-stop'); h.sidecar['a-pg'] = null; return { success: true }; }) as any);
    const r = await receive('a');
    spy.mockRestore();
    void real;
    expect(r.text).toBe("The dump of this database failed (pg_dump: connection lost). The database was started for Receive, and the manager can't confirm that it stopped again (docker did not say whether it still runs); the hand-over stays recorded.");
  });

  it('Cancel: the start fails with the container up: it is stopped again', async () => {
    const { record } = await handedOver();
    h.dbStart = { success: false, error: NOT_READY, ran: true };
    const r = await cancelHandOver('a');
    expect(r).toEqual({ success: false, status: 409, text: `The database did not start (${NOT_READY}), so the hand-over is still recorded; try again.` });
    expect(h.events).toEqual(['db-start:override', 'db-stop']);
    expect(h.sidecar['a-pg']).toBe(false);
    expect(stored('a').fleetDb.handover).toEqual(record);
  });

  it('Cancel: the start fails and the container does not stop: the reply says that it runs', async () => {
    await handedOver();
    h.dbStart = { success: false, error: NOT_READY, ran: true };
    h.dbStop = { success: false, error: 'compose stop failed' };
    const r = await cancelHandOver('a');
    expect(r.text).toBe(`The database did not start (${NOT_READY}), so the hand-over is still recorded, and its container still runs (compose stop failed); try again.`);
  });

  it('Cancel: the delete fails after its start: the database is stopped again', async () => {
    const { record } = await handedOver();
    fake.dbs['a-pg'].fail['handover-delete'] = 'ERROR:  read-only';
    const r = await cancelHandOver('a');
    expect(r).toEqual({ success: false, status: 409, text: 'The hand-over row could not be deleted (ERROR:  read-only), so the hand-over is still recorded, and the database is stopped again; try again.' });
    expect(h.events).toEqual(['db-start:override', 'db-stop']);
    expect(stored('a').fleetDb.handover).toEqual(record);
  });

  it('Cancel: the delete fails on a database that ran before the press: it is left running', async () => {
    await handedOver();
    h.sidecar['a-pg'] = true;
    fake.dbs['a-pg'].fail['handover-delete'] = 'ERROR:  read-only';
    const r = await cancelHandOver('a');
    expect(r.text).toBe('The database runs, but the hand-over row could not be deleted (ERROR:  read-only), so the hand-over is still recorded; try again.');
    expect(h.events).toEqual([]);
  });

  it("Cancel: a stop-again that docker does not confirm reads can't confirm", async () => {
    await handedOver();
    unseen();
    const spy = vi.spyOn(containerManager, 'stopFleetDbSidecar').mockImplementation((async () => { h.events.push('db-stop'); h.sidecar['a-pg'] = null; return { success: true }; }) as any);
    const r = await cancelHandOver('a', true);
    spy.mockRestore();
    expect(r.text).toBe(T6('16 bytes behind, streaming', "and the manager can't confirm whether the database still runs (docker did not say whether it still runs)"));
  });

  it('Cancel: the clear fails after the seen replay: cancelled, with the not-recorded tail', async () => {
    await handedOver();
    h.failSwitchWrite = 'disk full';
    expect(await cancelHandOver('a')).toEqual({ success: true, text: `${X_OK} The manager could not record this (disk full); press the same button again to finish recording it.` });
    expect(fake.dbs['a-pg'].handover).toBeNull();
  });
});

describe("NM41 fix 1: the tick's stop gives way to a lane and to a new receive (R4)", () => {
  const expired = () => Date.parse(stored('a').fleetDb.receive.expiresAt) + 1;
  const logged = () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
    return { lines, restore: () => spy.mockRestore() };
  };

  it('an operation holds the bot when the expiry reaches its stop: the database is not stopped', async () => {
    const { record } = await handedOver();
    await receive('a');
    const at = expired();
    h.events.length = 0;
    let release!: () => void;
    const held = containerManager.withExternalBotOp('a', 'receive', () => new Promise<void>(done => { release = done; }));
    const log = logged();
    await receiveStep(inst(), at);
    log.restore();
    const events = [...h.events];
    release();
    await held;
    expect(events).not.toContain('db-stop');
    expect(stored('a').fleetDb.receive).toBeUndefined();
    expect(stored('a').fleetDb.handover).toEqual(record);
    expect(log.lines).toContain('[Switch] A: the move code expired unused; the receive login is removed; the database was not stopped: an operation on this bot is running');
  });

  it('a receive stands again when the expiry reaches its stop: the database is not stopped', async () => {
    await handedOver();
    await receive('a');
    const receiveRecord = stored('a').fleetDb.receive;
    const at = expired();
    h.events.length = 0;
    fake.dbs['a-pg'].beforeAnswer = (sql: string) => {
      if (sql.includes('DELETE FROM smdb_manager.receive_mark')) containerManager.updateInstanceFleetDbSwitch('a', { receive: receiveRecord });
    };
    const log = logged();
    await receiveStep(inst(), at);
    log.restore();
    fake.dbs['a-pg'].beforeAnswer = null;
    expect(h.events).not.toContain('db-stop');
    expect(h.sidecar['a-pg']).toBe(true);
    expect(log.lines).toContain('[Switch] A: the move code expired unused; the receive login is removed; the database was not stopped: a new receive stands');
  });
});

describe('NM41 fix 1: branches no row pinned (R6)', () => {
  it("the tick over an expiry under the record stops the database and reads nothing after it", async () => {
    const { record } = await handedOver({ registry: { a: mainFixture() } });
    await receive('a');
    const at = Date.parse(stored('a').fleetDb.receive.expiresAt) + 1;
    h.events.length = 0;
    await switchTick(at);
    expect(stored('a').fleetDb.receive).toBeUndefined();
    expect(stored('a').fleetDb.handover).toEqual(record);
    expect(h.events).toContain('db-stop');
    expect(h.events.slice(h.events.lastIndexOf('db-stop') + 1)).toEqual([]);
  });

  it.each([
    ['Running', { state: 'running', settled: true }, 'Running'],
    ['a Maintenance that is not confirmed', { state: 'maintenance', settled: false }, 'Maintenance, not confirmed'],
  ])('Receive under the record refuses %s before it starts the database', async (_n, over, shown) => {
    await handedOver();
    const all = JSON.parse(fs.readFileSync(registryFile(), 'utf-8'));
    all.instances.a.maintenance = { ...all.instances.a.maintenance, ...over };
    fs.writeFileSync(registryFile(), JSON.stringify(all, null, 2));
    const r = await receive('a');
    expect(r).toEqual({ success: false, status: 409, text: `Receiving was refused and nothing was changed: taking the main back needs the bot in a confirmed Maintenance or Off, and its state is ${shown}` });
    expect(h.events).toEqual([]);
  });

  it('Receive finds that the push had finished, on a database it had to start: it stays running as the main', async () => {
    await handedOver();
    await receive('a');
    fake.dbs['a-pg'].received.push({ pushId: stored('a').fleetDb.receive.pushId, from: '7002', machine: 'slot_c', generation: 5 });
    h.sidecar['a-pg'] = false;
    h.events.length = 0;
    const r = await receive('a');
    expect(r).toEqual({ success: true, text: 'The push from slot_c had already finished (generation 5), so this database is the main now; receiving ended and no new move code was made.' });
    expect(h.events).toContain('db-start:override');
    expect(h.events).not.toContain('db-stop');
    expect(h.sidecar['a-pg']).toBe(true);
    expect(stored('a').fleetDb.handover).toBeUndefined();
    expect(stored('a').fleetDb.receive).toBeUndefined();
  });

  it('a new move code while receiving: the database ran before the press, and the reply says runs', async () => {
    await handedOver();
    await receive('a');
    h.events.length = 0;
    const r = await receive('a');
    expect(r.success).toBe(true);
    expect(r.text!.endsWith(" This machine's database runs to receive it; the hand-over to slot_c stays recorded until the push finishes.")).toBe(true);
    expect(h.events.filter(e => e.startsWith('db-'))).toEqual([]);
  });

  it('a refused Receive on a database that ran before the press leaves it running', async () => {
    await handedOver();
    h.sidecar['a-pg'] = true;
    h.dump = { success: false, error: 'pg_dump: connection lost' };
    const r = await receive('a');
    expect(r).toMatchObject({ success: false, text: 'The dump of this database failed (pg_dump: connection lost), so nothing was changed' });
    expect(h.events.filter(e => e.startsWith('db-'))).toEqual([]);
    expect(h.sidecar['a-pg']).toBe(true);
  });

  it('Stop receiving beside an earlier push that did not finish: the still-stands tail names Receive and Run the main here again, not a plain restore', async () => {
    await handedOver();
    await receive('a');
    fake.dbs['a-pg'].dbOid = '99999';
    await stopReceive('a');
    await receive('a');
    const r = await stopReceive('a');
    expect(r).toEqual({ success: true, text: `Receiving stopped; the move code no longer works. A push that did not finish earlier still stands: press Receive a main again so slot_c can push again, or, if slot_c is lost for good, press Run the main here again, which restores the dump ${DUMP} (taken before that push) first. That dump stays with the backups; a restore is refused while the hand-over to slot_c is recorded.${T5}` });
  });

  it('Stop receiving whose stop docker does not confirm, and one that fails: neither names the login', async () => {
    await handedOver();
    await receive('a');
    const spy = vi.spyOn(containerManager, 'stopFleetDbSidecar').mockImplementation((async () => { h.events.push('db-stop'); h.sidecar['a-pg'] = null; return { success: true }; }) as any);
    const r = await stopReceive('a');
    spy.mockRestore();
    expect(r).toEqual({ success: true, text: "Receiving stopped; the move code no longer works. The manager can't confirm that this machine's database stopped (docker did not say whether it still runs); the hand-over to slot_c is still recorded." });
  });

  it('the expiry after a broken push logs the way out under the record, and a stop that fails', async () => {
    await handedOver();
    await receive('a');
    const at = Date.parse(stored('a').fleetDb.receive.expiresAt) + 1;
    fake.dbs['a-pg'].dbOid = '99999';
    h.dbStop = { success: false, error: 'compose stop failed' };
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
    await receiveStep(inst(), at);
    spy.mockRestore();
    expect(stored('a').fleetDb.pushBroken).toMatchObject({ safetyDump: DUMP });
    expect(lines).toContain(`[Switch] A: the move code expired; a push replaced this database and did not finish, so the bot stays stopped until a push from slot_c finishes or Run the main here again ends the hand-over (the dump ${DUMP} stays with the backups; a restore is refused while the hand-over is recorded); the receive login is removed; the database did not stop (compose stop failed)`);
  });

  it('the card under the record beside a push that did not finish: Receive again, and no advice to cancel', async () => {
    await handedOver();
    await receive('a');
    fake.dbs['a-pg'].dbOid = '99999';
    await stopReceive('a');
    const view = switchView(inst());
    expect(view.lines[0]).toBe("Handed over to slot_c, which has no address for other machines, so this machine does not rejoin it as a copy by itself. Its database stays stopped. To move the main back, press Receive a main here, then Push the main in slot_c's manager. If slot_c is lost for good, press Run the main here again.");
    expect(view.lines[1]).toMatch(/^A push replaced this database on or before \d{4}-\d\d-\d\d \d\d:\d\d UTC and did not finish, so the bot cannot run on it\. Press Receive a main again so slot_c can push again\. The dump pre-receive-2026-10-28T12-00-00-000Z\.dump \(taken before receiving\) stays with the backups; a restore is refused while the hand-over is recorded\. If slot_c is lost for good, press Run the main here again, which restores that dump first\.$/);
    expect(view.badges.map(b => b.text)).toEqual(['Handed over', 'Push not finished']);
  });

  it('the refusals of a state order, a start and a database start name Receive under the record', async () => {
    await handedOver();
    expect(switchStateRefusal(inst(), 'off')).toBe("This machine handed its main database to slot_c, which has no address for other machines, so its state cannot change while the hand-over is recorded: the move back (Receive a main here, then Push the main in slot_c's manager), a Cancel the hand-over that slot_c's copy receives, or Run the main here again (if slot_c is lost for good) ends it; nothing was changed");
    expect(switchStartRefusal(inst())).toBe("This machine handed its main database to slot_c, which has no address for other machines, so the bot does not start here while the hand-over is recorded: the move back (Receive a main here, then Push the main in slot_c's manager), a Cancel the hand-over that slot_c's copy receives, or Run the main here again (if slot_c is lost for good) ends it");
    expect(switchDbStartRefusal(inst())).toBe('This machine handed its main database to slot_c, which has no address for other machines; the database stays stopped until Receive a main, Cancel the hand-over or Run the main here again starts it');
  });
});

describe('NM41 fix 2: Receive finishes an unfinished hand-over whose copy is not connected (F2, F3, F4)', () => {
  /** The writer's waiting record (the phase save failed), with both containers stopped. */
  async function waitingStopped(): Promise<any> {
    writeRegistry({ a: mainFixture(), c: portlessCopy() });
    fake.dbs['a-pg'].addresses = [];
    let writes = 0;
    const real = containerManager.updateInstanceFleetDbSwitch;
    const spy = vi.spyOn(containerManager, 'updateInstanceFleetDbSwitch').mockImplementation(((id: string, patch: any) => { if (++writes === 2) throw new Error('disk full'); return real(id, patch); }) as any);
    await handOver('a', 'slot_c');
    spy.mockRestore();
    h.app = false;
    h.events.length = 0;
    return stored('a').fleetDb.handover;
  }
  const NOT_STREAMING = 'The copy slot_c is not streaming from this database now (not connected), so it cannot prove it holds every change; start it on its machine and try again';
  /** Then the copy is gone and Hand over is pressed again: it starts the database, refuses, and its stop fails, so the database runs. */
  async function leftRunning(): Promise<any> {
    const record = await waitingStopped();
    fake.dbs['a-pg'].slots.slot_c = { active: false, state: '', replay: '0/5000000' };
    h.dbStop = { success: false, error: 'compose stop failed' };
    const again = await handOver('a', 'slot_c');
    h.dbStop = { success: true };
    h.events.length = 0;
    return { again, record };
  }
  const LEAD = 'Receiving was refused and nothing was changed: the hand-over to slot_c did not finish';
  const NOTE_UNCONNECTED = ' The hand-over to slot_c is now recorded as finished: its copy was not connected, and the manager stopped this database first.';
  const NOTE_STOPPED = ' The hand-over to slot_c is now recorded as finished: docker showed this database and the bot stopped.';

  it('Hand over again that started the database and refuses stops it again, so nothing was changed', async () => {
    const record = await waitingStopped();
    fake.dbs['a-pg'].slots.slot_c = { active: false, state: '', replay: '0/5000000' };
    const again = await handOver('a', 'slot_c');
    expect(again).toMatchObject({ success: false, text: `${NOT_STREAMING}${NOTHING}` });
    expect(h.events.filter(e => e.startsWith('db-'))).toEqual(['db-start:override', 'db-stop']);
    expect(h.sidecar['a-pg']).toBe(false);
    expect(stored('a').fleetDb.handover).toEqual(record);
  });

  it('Hand over again whose stop fails says that the database runs, and the writer leaves waiting with the database running', async () => {
    const { again, record } = await leftRunning();
    expect(again).toMatchObject({ success: false, text: `${NOT_STREAMING}. This database was started for the hand-over and did not stop again (compose stop failed); it runs.` });
    expect(h.sidecar['a-pg']).toBe(true);
    expect(stored('a').fleetDb.handover).toEqual(record);
    expect(record.phase).toBe('waiting');
    expect(switchView(inst())).toMatchObject({ noAddress: true, takeBack: false });
  });

  it('Receive stops the database, saves the record as finished, starts it with the override and is admitted; nothing else is written', async () => {
    const { record } = await leftRunning();
    const r = await receive('a');
    expect(r).toMatchObject({ success: true, text: READY + T3 + NOTE_UNCONNECTED });
    const order = ['db-stop', 'db-start:override', 'require-maintenance', 'dump:pre-receive-'].map(e => h.events.indexOf(e));
    expect(order.every(i => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(h.events.filter(e => e === 'handover-delete' || e === 'raise' || e.startsWith('stop-bot') || e.startsWith('probe'))).toEqual([]);
    expect(stored('a').fleetDb.handover).toEqual({ ...record, phase: 'stopped' });
    expect(stored('a').fleetDb.receive).toMatchObject({ safetyDump: DUMP });
    expect(stored('a').fleetDb.switchNotice).toBeUndefined();
    expect(fake.dbs['a-pg'].generation).toMatchObject({ generation: 3, machine: 'main.example' });
    expect(fake.dbs['a-pg'].handover).not.toBeNull();
  });

  it('the copy is connected: refused with nothing changed and no stop', async () => {
    const { record } = await leftRunning();
    fake.dbs['a-pg'].slots.slot_c = { active: true, state: 'streaming', replay: '0/5000000' };
    const r = await receive('a');
    expect(r).toEqual({ success: false, status: 409, text: `${LEAD}, and its copy is connected to this database (streaming). Press Hand over again to finish it, or Cancel the hand-over.` });
    expect(h.events.filter(e => e.startsWith('db-') || e.startsWith('stop-bot'))).toEqual([]);
    expect(h.sidecar['a-pg']).toBe(true);
    expect(stored('a').fleetDb.handover).toEqual(record);
  });

  it("the slot does not read: can't confirm, no stop", async () => {
    const { record } = await leftRunning();
    fake.dbs['a-pg'].fail['slot-read'] = 'psql: error: connection refused';
    const r = await receive('a');
    expect(r).toEqual({ success: false, status: 409, text: `${LEAD}, and the manager can't confirm whether its copy is connected to this database (connection refused). Press Receive a main again.` });
    expect(h.events.filter(e => e.startsWith('db-'))).toEqual([]);
    expect(stored('a').fleetDb.handover).toEqual(record);
  });

  it.each([
    ['open', { inRecovery: false, canLogin: true, sessions: 0 }, "the bot's database login reads open. The manager's maintenance check blocks it within 30 seconds; then press Receive a main again."],
    ['blocked with a session open', { inRecovery: false, canLogin: false, sessions: 2 }, "2 session(s) of the bot's database role are open. Press Receive a main again in a moment."],
    ['not found', { inRecovery: false, canLogin: null, sessions: 0 }, "the manager can't confirm that the bot's database login is blocked (the bot's role was not found). Press Receive a main again."],
  ])("the bot's login reads %s: refused with nothing changed and no stop", async (_n, login, why) => {
    const { record } = await leftRunning();
    h.login = login as any;
    const r = await receive('a');
    expect(r).toEqual({ success: false, status: 409, text: `${LEAD} and this database runs, and ${why}` });
    expect(h.events.filter(e => e.startsWith('db-') || e.startsWith('stop-bot'))).toEqual([]);
    expect(stored('a').fleetDb.handover).toEqual(record);
  });

  it('the stop fails: refused, the record still waiting, and the reply does not say that nothing was changed', async () => {
    const { record } = await leftRunning();
    h.dbStop = { success: false, error: 'compose stop failed' };
    const r = await receive('a');
    expect(r).toEqual({ success: false, status: 409, text: 'Receiving was refused: the hand-over to slot_c did not finish and its copy was not connected, so the manager sent a stop to this database to finish it, but the database still runs (compose stop failed). The hand-over stays recorded as not finished; press Receive a main again.' });
    expect(r.text).not.toContain('nothing was changed');
    expect(h.events.filter(e => e.startsWith('db-'))).toEqual(['db-stop']);
    expect(stored('a').fleetDb.handover).toEqual(record);
    expect(stored('a').fleetDb.receive).toBeUndefined();
  });

  it('the bot runs too: it is stopped under the receive operation before the database', async () => {
    const { record } = await leftRunning();
    h.app = true;
    const spy = vi.spyOn(containerManager, 'stopBotInOp').mockImplementation((async (_id: string, op: string) => { h.events.push(`stop-bot:${op}`); h.app = false; return { success: true }; }) as any);
    const r = await receive('a');
    spy.mockRestore();
    expect(r).toMatchObject({ success: true, text: READY + T3 + ' The hand-over to slot_c is now recorded as finished: its copy was not connected, and the manager stopped the bot and this database first.' });
    expect(h.events.indexOf('stop-bot:receive')).toBeGreaterThanOrEqual(0);
    expect(h.events.indexOf('stop-bot:receive')).toBeLessThan(h.events.indexOf('db-stop'));
    expect(stored('a').fleetDb.handover).toEqual({ ...record, phase: 'stopped' });
  });

  it('the bot does not stop: refused, the record still waiting', async () => {
    const { record } = await leftRunning();
    h.app = true;
    const r = await receive('a');
    expect(r).toEqual({ success: false, status: 409, text: 'Receiving was refused: the hand-over to slot_c did not finish and its copy was not connected, so the manager sent a stop to the bot and this database to finish it, but the bot still runs. The hand-over stays recorded as not finished; press Receive a main again.' });
    expect(h.events).toContain('stop-bot:receive');
    expect(stored('a').fleetDb.handover).toEqual(record);
  });

  it('the save after the stops fails: the reply says both were stopped; the next press finishes and is admitted', async () => {
    const { record } = await leftRunning();
    h.failSwitchWrite = 'disk full';
    const r = await receive('a');
    expect(r).toEqual({ success: false, status: 409, text: 'Receiving was refused: the manager stopped this database under the unfinished hand-over to slot_c, whose copy was not connected, and docker shows it and the bot stopped, but the hand-over could not be saved as finished (disk full). Press Receive a main again.' });
    expect(stored('a').fleetDb.handover).toEqual(record);
    expect(h.sidecar['a-pg']).toBe(false);
    h.failSwitchWrite = null;
    const next = await receive('a');
    expect(next).toMatchObject({ success: true, text: READY + T3 + NOTE_STOPPED });
    expect(stored('a').fleetDb.handover).toEqual({ ...record, phase: 'stopped' });
  });

  it('docker does not say whether the database runs: refused with nothing changed, and the next step is named', async () => {
    const record = await waitingStopped();
    h.sidecar['a-pg'] = null;
    expect(await receive('a')).toEqual({ success: false, status: 409, text: `${LEAD}, and docker did not say whether this database runs. Press Receive a main again.` });
    expect(h.events).toEqual([]);
    expect(stored('a').fleetDb.handover).toEqual(record);
  });

  it('F3: a press that finished the record says so when it is refused afterwards, and does not say that nothing was changed', async () => {
    const record = await waitingStopped();
    h.dump = { success: false, error: 'pg_dump: connection lost' };
    const r = await receive('a');
    expect(r).toMatchObject({ success: false, text: `The dump of this database failed (pg_dump: connection lost).${NOTE_STOPPED}` });
    expect(stored('a').fleetDb.handover).toEqual({ ...record, phase: 'stopped' });
    expect(h.sidecar['a-pg']).toBe(false);
  });

  it('F3: Receive refused for the running bot check after the finish cannot happen; a refused start after the finish says so', async () => {
    await waitingStopped();
    h.dbStart = { success: false, error: 'compose failed' };
    const r = await receive('a');
    expect(r.text).toBe(`Receiving was refused: this machine's database did not start (compose failed).${NOTE_STOPPED}`);
  });

  it('F4: Cancel under a waiting record after docker did not say whether the database ran: it is not stopped', async () => {
    const record = await waitingStopped();
    h.sidecar['a-pg'] = null;
    unseen();
    const r = await cancelHandOver('a', true);
    expect(r).toEqual({ success: false, status: 409, text: T6_WAITING('16 bytes behind, streaming', 'and the manager left the database as it is: docker did not say whether it ran before this press') });
    expect(h.events).not.toContain('db-stop');
    expect(stored('a').fleetDb.handover).toEqual(record);
  });
});

describe('NM41 text round: the general refusals under an unfinished hand-over with no address', () => {
  it('the state order, the start and the database start say what finishes and what ends the hand-over', async () => {
    writeRegistry({ a: mainFixture(), c: portlessCopy() });
    fake.dbs['a-pg'].addresses = [];
    let writes = 0;
    const real = containerManager.updateInstanceFleetDbSwitch;
    const save = vi.spyOn(containerManager, 'updateInstanceFleetDbSwitch').mockImplementation(((id: string, patch: any) => { if (++writes === 2) throw new Error('disk full'); return real(id, patch); }) as any);
    await handOver('a', 'slot_c');
    save.mockRestore();
    expect(stored('a').fleetDb.handover).toMatchObject({ phase: 'waiting' });
    const LEAD = "This machine's hand-over of its main database to slot_c did not finish, and slot_c has no address for other machines";
    const ENDS = "Hand over again finishes it while slot_c's copy streams from this database, and Cancel the hand-over, the move back (Receive a main here, then Push the main in slot_c's manager) or Run the main here again (if slot_c is lost for good) ends it";
    expect(switchStateRefusal(inst(), 'running')).toBe(`${LEAD}, so its state cannot change while the hand-over is recorded: ${ENDS}; nothing was changed`);
    expect(switchStartRefusal(inst())).toBe(`${LEAD}, so the bot does not start here while the hand-over is recorded: ${ENDS}`);
    expect(switchDbStartRefusal(inst())).toBe(`${LEAD}; Hand over again, Cancel the hand-over, Receive a main and Run the main here again start its database when they need it`);
  });

  it('a waiting record with an address keeps the general texts', async () => {
    writeRegistry({ a: mainFixture() });
    let writes = 0;
    const real = containerManager.updateInstanceFleetDbSwitch;
    const save = vi.spyOn(containerManager, 'updateInstanceFleetDbSwitch').mockImplementation(((id: string, patch: any) => { if (++writes === 2) throw new Error('disk full'); return real(id, patch); }) as any);
    await handOver('a', 'slot_c');
    save.mockRestore();
    expect(stored('a').fleetDb.handover).toMatchObject({ phase: 'waiting', host: 'copy.example' });
    expect(switchStartRefusal(inst())).toBe('This machine handed its main database to copy.example, so the bot does not start here; rejoin it as a copy, or cancel the move');
    expect(switchDbStartRefusal(inst())).toBe('This machine handed its main database to copy.example; the database stays stopped until it rejoins as a copy or the hand-over is cancelled');
  });
});

describe('NM41 fix 2: rows for branches that had none (F5)', () => {
  it('switchView serves noAddress for the record without an address and not for one with it', async () => {
    await handedOver();
    expect(switchView(inst())).toMatchObject({ noAddress: true, takeBack: true });
    resetHarness();
    seedDbs();
    const { record } = await handedOver({ addresses: true });
    expect(record.host).toBe('copy.example');
    expect(switchView(inst())).toMatchObject({ noAddress: false, takeBack: false });
  });

  it('beside a push that did not finish, the state order, the start and the database start name the move back and Run the main here again, not Cancel', async () => {
    await handedOver();
    await receive('a');
    fake.dbs['a-pg'].dbOid = '99999';
    await stopReceive('a');
    expect(stored('a').fleetDb.pushBroken).toBeDefined();
    expect(switchStateRefusal(inst(), 'off')).toBe(`This machine handed its main database to slot_c, which has no address for other machines, so its state cannot change while the hand-over is recorded: the move back (Receive a main here, then Push the main in slot_c's manager) or Run the main here again (if slot_c is lost for good; it restores the dump ${DUMP} first) ends it; nothing was changed`);
    expect(switchStartRefusal(inst())).toBe(`This machine handed its main database to slot_c, which has no address for other machines, so the bot does not start here while the hand-over is recorded: the move back (Receive a main here, then Push the main in slot_c's manager) or Run the main here again (if slot_c is lost for good; it restores the dump ${DUMP} first) ends it`);
    expect(switchDbStartRefusal(inst())).toBe('This machine handed its main database to slot_c, which has no address for other machines; the database stays stopped until Receive a main or Run the main here again starts it');
  });

  it('the database start refused while a receive stands says that only Receive starts it', async () => {
    await handedOver();
    await receive('a');
    expect(switchDbStartRefusal(inst())).toBe('This machine handed its main database to slot_c, which has no address for other machines; while it waits to receive the main back, only Receive a main starts its database');
  });

  it('a start that fails while a receive stands: receiving stays recorded, and nothing is stopped', async () => {
    await handedOver();
    await receive('a');
    const receiving = stored('a').fleetDb.receive;
    h.sidecar['a-pg'] = false;
    h.dbStart = { success: false, error: 'compose failed' };
    h.events.length = 0;
    const r = await receive('a');
    expect(r).toEqual({ success: false, status: 409, text: "Receiving was refused: this machine's database did not start (compose failed); receiving stays recorded. Press Receive a main again." });
    expect(h.events).toEqual(['db-start:override']);
    expect(stored('a').fleetDb.receive).toEqual(receiving);
  });

  it('Cancel that throws after its start stops the database again and says so', async () => {
    const { record } = await handedOver();
    const spy = vi.spyOn(containerManager, 'startFleetDbSidecar').mockImplementation((async () => { h.events.push('db-start:override'); h.sidecar['a-pg'] = true; throw new Error('boom'); }) as any);
    const r = await cancelHandOver('a', true);
    spy.mockRestore();
    expect(r).toEqual({ success: false, status: 500, text: 'The cancel stopped on an unexpected error (boom); the hand-over is still recorded, and the database is stopped again.' });
    expect(h.events).toEqual(['db-start:override', 'db-stop']);
    expect(h.sidecar['a-pg']).toBe(false);
    expect(stored('a').fleetDb.handover).toEqual(record);
  });

  it('Cancel under a waiting record whose database ran before the press leaves it running', async () => {
    writeRegistry({ a: mainFixture(), c: portlessCopy() });
    fake.dbs['a-pg'].addresses = [];
    let writes = 0;
    const real = containerManager.updateInstanceFleetDbSwitch;
    const save = vi.spyOn(containerManager, 'updateInstanceFleetDbSwitch').mockImplementation(((id: string, patch: any) => { if (++writes === 2) throw new Error('disk full'); return real(id, patch); }) as any);
    await handOver('a', 'slot_c');
    save.mockRestore();
    const record = stored('a').fleetDb.handover;
    h.app = false;
    h.sidecar['a-pg'] = true;
    h.events.length = 0;
    unseen();
    const r = await cancelHandOver('a', true);
    expect(r).toEqual({ success: false, status: 409, text: T6_WAITING('16 bytes behind, streaming', 'and the database runs as it did before this press') });
    expect(h.events).toEqual(['handover-delete']);
    expect(h.sidecar['a-pg']).toBe(true);
    expect(stored('a').fleetDb.handover).toEqual(record);
    expect(fake.dbs['a-pg'].generation?.generation).toBe(3);
  });

  describe("the tick's stop inside its own operation", () => {
    const logged = () => {
      const lines: string[] = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
      return { lines, restore: () => spy.mockRestore() };
    };
    const expiring = async () => {
      await handedOver();
      await receive('a');
      const receiving = stored('a').fleetDb.receive;
      h.events.length = 0;
      return { at: Date.parse(receiving.expiresAt) + 1, receiving };
    };

    it('a receive that stands again once the operation is held: the database is not stopped', async () => {
      const { at, receiving } = await expiring();
      const real = containerManager.withExternalBotOp;
      const spy = vi.spyOn(containerManager, 'withExternalBotOp').mockImplementation(((id: string, op: string, fn: () => Promise<unknown>) => {
        containerManager.updateInstanceFleetDbSwitch('a', { receive: receiving });
        return real(id, op, fn);
      }) as any);
      const log = logged();
      await receiveStep(inst(), at);
      log.restore();
      spy.mockRestore();
      expect(h.events).not.toContain('db-stop');
      expect(log.lines).toContain('[Switch] A: the move code expired unused; the receive login is removed; the database was not stopped: a new receive stands');
    });

    it('the record is gone once the operation is held: nothing is stopped and the log names no database', async () => {
      const { at } = await expiring();
      const real = containerManager.withExternalBotOp;
      const spy = vi.spyOn(containerManager, 'withExternalBotOp').mockImplementation(((id: string, op: string, fn: () => Promise<unknown>) => {
        containerManager.updateInstanceFleetDbSwitch('a', { handover: null });
        return real(id, op, fn);
      }) as any);
      const log = logged();
      await receiveStep(inst(), at);
      log.restore();
      spy.mockRestore();
      expect(h.events).not.toContain('db-stop');
      expect(log.lines).toContain('[Switch] A: the move code expired unused; the receive login is removed');
    });

    it('the operation cannot be taken: the log says the error', async () => {
      const { at } = await expiring();
      const spy = vi.spyOn(containerManager, 'withExternalBotOp').mockImplementation((() => Promise.reject(new Error("Operation 'stop' is already in progress for this bot"))) as any);
      const log = logged();
      await receiveStep(inst(), at);
      log.restore();
      spy.mockRestore();
      expect(h.events).not.toContain('db-stop');
      expect(log.lines).toContain("[Switch] A: the move code expired unused; the receive login is removed; the database was not stopped: the stop could not run (Operation 'stop' is already in progress for this bot)");
    });
  });
});

describe('NM41 fix 3', () => {
  /** The writer's waiting record (the phase save failed), with both containers stopped; address rows kept when asked. */
  async function waitingStopped(addresses = false): Promise<any> {
    writeRegistry({ a: mainFixture(), c: portlessCopy() });
    if (!addresses) fake.dbs['a-pg'].addresses = [];
    let writes = 0;
    const real = containerManager.updateInstanceFleetDbSwitch;
    const spy = vi.spyOn(containerManager, 'updateInstanceFleetDbSwitch').mockImplementation(((id: string, patch: any) => { if (++writes === 2) throw new Error('disk full'); return real(id, patch); }) as any);
    await handOver('a', 'slot_c');
    spy.mockRestore();
    h.app = false;
    h.events.length = 0;
    return stored('a').fleetDb.handover;
  }
  /** Then the copy is gone and Hand over again leaves the database running (its stop fails). */
  async function leftRunning(): Promise<any> {
    const record = await waitingStopped();
    fake.dbs['a-pg'].slots.slot_c = { active: false, state: '', replay: '0/5000000' };
    h.dbStop = { success: false, error: 'compose stop failed' };
    await handOver('a', 'slot_c');
    h.dbStop = { success: true };
    h.events.length = 0;
    return record;
  }
  const gone = () => { fake.dbs['a-pg'].slots.slot_c = { active: false, state: '', replay: '0/5000000' }; };
  const slotReads = () => { let n = 0; fake.dbs['a-pg'].onSlotRead = () => { n++; }; return () => n; };
  const LEAD = 'Receiving was refused and nothing was changed: the hand-over to slot_c did not finish';
  const KEPT = 'The hand-over stays recorded as not finished; press Receive a main again.';
  const NOTE = (what: string) => ` The hand-over to slot_c is now recorded as finished: its copy was not connected, and the manager stopped ${what} first.`;
  const dbEvents = () => h.events.filter(e => e.startsWith('db-') || e.startsWith('stop-bot'));

  describe('G1: a resumed Hand over that started the database waits for the copy to reconnect', () => {
    it.each([[false], [true]])('the slot inactive on the first reads and streaming on a later one: the hand-over finishes (address rows: %s)', async (addresses) => {
      const record = await waitingStopped(addresses);
      gone();
      let reads = 0;
      fake.dbs['a-pg'].onSlotRead = () => { if (++reads === 3) fake.dbs['a-pg'].slots.slot_c = { active: true, state: 'streaming', replay: '0/5000000' }; };
      SWITCH_TIMING.catchUpMs = 2000;
      const r = await handOver('a', 'slot_c');
      expect(r.success).toBe(true);
      expect(reads).toBeGreaterThanOrEqual(3);
      expect(stored('a').fleetDb.handover).toMatchObject({ phase: 'stopped', slot: 'slot_c', generation: record.generation });
      expect(dbEvents()[0]).toBe('db-start:override');
      expect(h.sidecar['a-pg']).toBe(false);
    });

    it('the slot inactive to the deadline: refused after more than one read, and the database stopped again', async () => {
      const record = await waitingStopped();
      gone();
      const reads = slotReads();
      const r = await handOver('a', 'slot_c');
      expect(r).toMatchObject({ success: false, text: `The copy slot_c is not streaming from this database now (not connected), so it cannot prove it holds every change; start it on its machine and try again${NOTHING}` });
      expect(reads()).toBeGreaterThan(1);
      expect(dbEvents()).toEqual(['db-start:override', 'db-stop']);
      expect(stored('a').fleetDb.handover).toEqual(record);
    });

    it('a press that did not start the database reads the slot once and stops nothing', async () => {
      const record = await waitingStopped();
      h.sidecar['a-pg'] = true;
      gone();
      const reads = slotReads();
      const r = await handOver('a', 'slot_c');
      expect(r.success).toBe(false);
      expect(reads()).toBe(1);
      expect(dbEvents()).toEqual([]);
      expect(stored('a').fleetDb.handover).toEqual(record);
    });

    it('docker did not say whether the database ran: started, one read, not stopped', async () => {
      await waitingStopped();
      h.sidecar['a-pg'] = null;
      gone();
      const reads = slotReads();
      const r = await handOver('a', 'slot_c');
      expect(r).toMatchObject({ success: false });
      expect(r.text!.endsWith(NOTHING)).toBe(true);
      expect(reads()).toBe(1);
      expect(dbEvents()).toEqual(['db-start:override']);
    });

    it.each([
      ['the start fails with the container up', () => { h.dbStart = { success: false, error: 'not ready', ran: true }; }, 'The hand-over was refused and nothing was changed: the database did not start (not ready)'],
      ['maintenance is not proven', () => { h.proof = { ok: false, error: 'This bot is not in maintenance; put it into Maintenance or Off first' }; }, 'The hand-over was refused and nothing was changed: This bot is not in maintenance; put it into Maintenance or Off first'],
      ['the slot read fails', () => { fake.dbs['a-pg'].fail['slot-read'] = 'psql: error: connection refused'; }, `The manager could not read this database's copies (connection refused)${NOTHING}`],
      ['the address read fails', () => { fake.dbs['a-pg'].fail['address-read'] = 'psql: error: connection refused'; }, `The manager could not read this database's copies (connection refused)${NOTHING}`],
      ['the slot read answers nothing', () => { fake.dbs['a-pg'].fail['slot-read-empty'] = ''; }, `The manager could not read this database's copies (the slot read answered '')${NOTHING}`],
      ['the slot is gone', () => { delete fake.dbs['a-pg'].slots.slot_c; }, `No copy uses the slot slot_c any more; reload the Database window and pick a copy that is streaming${NOTHING}`],
      ['the generation does not read', () => { fake.dbs['a-pg'].fail['gen-read'] = 'psql: error: connection refused'; }, `The manager could not read this database's copies (connection refused)${NOTHING}`],
      ['a left-over receive mark cannot be read', () => { fake.dbs['a-pg'].fail['mark-read'] = 'psql: error: connection refused'; }, 'A receive mark that no receive or unfinished push on this machine stands for could not be removed (connection refused), and slot_c would refuse to take over while it stands, so the hand-over was refused; nothing was changed'],
      ['the record cannot be saved', () => { h.failSwitchWrite = 'disk full'; }, 'The hand-over could not be recorded (disk full), so nothing was changed'],
    ])('a resumed press that started the database and is refused because %s stops it again', async (_n, set, text) => {
      const record = await waitingStopped();
      set();
      const r = await handOver('a', 'slot_c');
      expect(r).toMatchObject({ success: false, text });
      expect(dbEvents()).toEqual(['db-start:override', 'db-stop']);
      expect(h.sidecar['a-pg']).toBe(false);
      expect(stored('a').fleetDb.handover).toEqual(record);
    });
  });

  describe('G2: the backup slot around the stops of an unfinished hand-over', () => {
    it('the slot is held: refused with nothing changed and no stop', async () => {
      const record = await leftRunning();
      expect(claimFleetBackupBusy('a')).toBe(true);
      const r = await receive('a');
      releaseFleetBackupBusy('a');
      expect(r).toEqual({ success: false, status: 409, text: `A backup or restore operation is in progress on this database; wait for it to finish${NOTHING}` });
      expect(dbEvents()).toEqual([]);
      expect(stored('a').fleetDb.handover).toEqual(record);
    });

    it('the slot is free again after a refusal that follows the stops', async () => {
      await leftRunning();
      h.dbStop = { success: false, error: 'compose stop failed' };
      expect((await receive('a')).success).toBe(false);
      expect(claimFleetBackupBusy('a')).toBe(true);
      releaseFleetBackupBusy('a');
    });
  });

  describe('G4: Receive under a waiting record with the database stopped and the bot running', () => {
    it('stops the bot, saves the record as finished and is admitted', async () => {
      const record = await waitingStopped();
      h.app = true;
      const spy = vi.spyOn(containerManager, 'stopBotInOp').mockImplementation((async (_id: string, op: string) => { h.events.push(`stop-bot:${op}`); h.app = false; return { success: true }; }) as any);
      const r = await receive('a');
      spy.mockRestore();
      expect(r).toMatchObject({ success: true, text: READY + T3 + ' The hand-over to slot_c is now recorded as finished: the manager stopped the bot, and docker showed this database stopped.' });
      expect(dbEvents().slice(0, 2)).toEqual(['stop-bot:receive', 'db-start:override']);
      expect(stored('a').fleetDb.handover).toEqual({ ...record, phase: 'stopped' });
      expect(fake.dbs['a-pg'].generation).toMatchObject({ generation: 3 });
    });

    it('the bot does not stop: refused, the record still waiting, no claim that nothing was changed', async () => {
      const record = await waitingStopped();
      h.app = true;
      const r = await receive('a');
      expect(r).toEqual({ success: false, status: 409, text: `Receiving was refused: the hand-over to slot_c did not finish, so the manager sent a stop to the bot to finish it, but the bot still runs. ${KEPT}` });
      expect(dbEvents()).toEqual(['stop-bot:receive']);
      expect(stored('a').fleetDb.handover).toEqual(record);
    });

    it('docker does not say whether the bot runs and the stop does not run: nothing was changed', async () => {
      const record = await waitingStopped();
      h.app = null;
      h.stop = { success: false, error: 'Docker did not say whether the bot runs, so nothing was stopped' };
      const r = await receive('a');
      expect(r).toEqual({ success: false, status: 409, text: `${LEAD}, and the stop of the bot did not run (Docker did not say whether the bot runs, so nothing was stopped). Press Receive a main again.` });
      expect(stored('a').fleetDb.handover).toEqual(record);
    });

    it('the stop of the bot fails: refused, and the reply says so', async () => {
      await waitingStopped();
      h.app = true;
      h.stop = { success: false, error: 'compose down failed' };
      const r = await receive('a');
      expect(r.text).toBe(`Receiving was refused: the hand-over to slot_c did not finish, so the manager sent a stop to the bot to finish it, but that stop failed (compose down failed). ${KEPT}`);
    });
  });

  describe('G5: finishUnconnectedHandover, the branches that had no row', () => {
    it('the slot is absent: Receive goes on and is admitted', async () => {
      const record = await leftRunning();
      delete fake.dbs['a-pg'].slots.slot_c;
      const r = await receive('a');
      expect(r).toMatchObject({ success: true, text: READY + T3 + NOTE('this database') });
      expect(stored('a').fleetDb.handover).toEqual({ ...record, phase: 'stopped' });
    });

    it("a record that names no slot, and a slot read that answers nothing: can't confirm, no stop", async () => {
      const record = await leftRunning();
      fake.dbs['a-pg'].fail['slot-read-empty'] = '';
      expect(await receive('a')).toEqual({ success: false, status: 409, text: `${LEAD}, and the manager can't confirm whether its copy is connected to this database (the slot read answered 'no reason given'). Press Receive a main again.` });
      const all = JSON.parse(fs.readFileSync(registryFile(), 'utf-8'));
      delete all.instances.a.fleetDb.handover.slot;
      fs.writeFileSync(registryFile(), JSON.stringify(all, null, 2));
      expect(await receive('a')).toEqual({ success: false, status: 409, text: `${LEAD}, and the manager can't confirm whether its copy is connected to this database (the record names no slot). Press Receive a main again.` });
      expect(dbEvents()).toEqual([]);
      expect(record.slot).toBe('slot_c');
    });

    it.each([
      ['does not read', { fail: 'connection refused' }, "the manager can't confirm that the bot's database login is blocked (connection refused). Press Receive a main again."],
      ['reads in recovery', { inRecovery: true, canLogin: false, sessions: 0 }, "it is a live copy in recovery, so it is not this bot's main database."],
    ])("the bot's login %s: refused with nothing changed and no stop", async (_n, login, why) => {
      await leftRunning();
      h.login = login as any;
      expect(await receive('a')).toEqual({ success: false, status: 409, text: `${LEAD} and this database runs, and ${why}` });
      expect(dbEvents()).toEqual([]);
    });

    it('the bot runs and its stop answers that it is not running: tolerated, the database is stopped and Receive is admitted', async () => {
      await leftRunning();
      h.app = true;
      const spy = vi.spyOn(containerManager, 'stopBotInOp').mockImplementation((async (_id: string, op: string) => { h.events.push(`stop-bot:${op}`); h.app = false; return { success: false, error: 'Bot is not running' }; }) as any);
      const r = await receive('a');
      spy.mockRestore();
      expect(r).toMatchObject({ success: true, text: READY + T3 + NOTE('the bot and this database') });
    });

    it('the bot runs and its stop fails: refused before the database is stopped', async () => {
      const record = await leftRunning();
      h.app = true;
      h.stop = { success: false, error: 'compose down failed' };
      const r = await receive('a');
      expect(r).toEqual({ success: false, status: 409, text: `Receiving was refused: the hand-over to slot_c did not finish and its copy was not connected, so the manager sent a stop to the bot to finish it, but that stop failed (compose down failed). ${KEPT}` });
      expect(dbEvents()).toEqual(['stop-bot:receive']);
      expect(stored('a').fleetDb.handover).toEqual(record);
    });

    it('the stop of the bot does not run because docker did not say: nothing was changed', async () => {
      await leftRunning();
      h.app = null;
      h.stop = { success: false, error: 'Docker did not say whether the bot runs, so nothing was stopped' };
      const r = await receive('a');
      expect(r).toEqual({ success: false, status: 409, text: `${LEAD} and its copy was not connected, but the stop of the bot did not run (Docker did not say whether the bot runs, so nothing was stopped). Press Receive a main again.` });
      expect(dbEvents()).toEqual(['stop-bot:receive']);
    });

    it("the database stop that docker does not confirm: can't confirm, the record still waiting", async () => {
      const record = await leftRunning();
      const spy = vi.spyOn(containerManager, 'stopFleetDbSidecar').mockImplementation((async () => { h.events.push('db-stop'); h.sidecar['a-pg'] = null; return { success: true }; }) as any);
      const r = await receive('a');
      spy.mockRestore();
      expect(r).toEqual({ success: false, status: 409, text: `Receiving was refused: the hand-over to slot_c did not finish and its copy was not connected, so the manager sent a stop to this database to finish it, but the manager can't confirm that the database stopped (docker did not say whether it still runs). ${KEPT}` });
      expect(stored('a').fleetDb.handover).toEqual(record);
    });

    it('the bot read back as unknown after the stops: refused, the record still waiting', async () => {
      const record = await leftRunning();
      const spy = vi.spyOn(containerManager, 'stopFleetDbSidecar').mockImplementation((async () => { h.events.push('db-stop'); h.sidecar['a-pg'] = false; h.app = null; return { success: true }; }) as any);
      const r = await receive('a');
      spy.mockRestore();
      expect(r).toEqual({ success: false, status: 409, text: `Receiving was refused: the hand-over to slot_c did not finish and its copy was not connected, so the manager sent a stop to this database to finish it, but docker did not say whether the bot runs. ${KEPT}` });
      expect(stored('a').fleetDb.handover).toEqual(record);
    });
  });

  describe('G5: Cancel under a waiting record after docker did not say whether the database ran', () => {
    it('the start fails: the database is left as it is', async () => {
      const record = await waitingStopped();
      h.sidecar['a-pg'] = null;
      h.dbStart = { success: false, error: 'not ready' };
      const r = await cancelHandOver('a', true);
      expect(r).toEqual({ success: false, status: 409, text: 'The database did not start (not ready), so the hand-over is still recorded, and the manager left the database as it is: docker did not say whether it ran before this press; try again.' });
      expect(dbEvents()).toEqual(['db-start:override']);
      expect(stored('a').fleetDb.handover).toEqual(record);
    });

    it('the delete fails: the database is left as it is', async () => {
      await waitingStopped();
      h.sidecar['a-pg'] = null;
      fake.dbs['a-pg'].fail['handover-delete'] = 'ERROR:  read-only';
      const r = await cancelHandOver('a', true);
      expect(r).toEqual({ success: false, status: 409, text: 'The hand-over row could not be deleted (ERROR:  read-only), so the hand-over is still recorded, and the manager left the database as it is: docker did not say whether it ran before this press; try again.' });
      expect(dbEvents()).toEqual(['db-start:override']);
    });
  });
});
