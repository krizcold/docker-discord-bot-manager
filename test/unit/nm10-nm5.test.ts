import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm10-nm5-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, join: { success: true, joinCode: '' } as { success: boolean; joinCode?: string; error?: string } };
});

vi.mock('child_process', async (o) => (await import('./switch-harness')).childProcessMock(await o()));
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./switch-harness')).dbLoginMock(await o()));
vi.mock('../../src/instance/maintenance', async (o) => (await import('./switch-harness')).maintenanceMock(await o()));
vi.mock('../../src/docker/containerManager', async (o) => (await import('./switch-harness')).containerManagerMock(await o()));
vi.mock('../../src/instance/fleetBackup', async (o) => ({ ...(await import('./switch-harness')).fleetBackupMock(await o()), ...(await import('./migrate-fake')).fenceMock() }));
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
import { handOver, resetSwitchState, runLane, startLane, switchTick, SWITCH_TIMING } from '../../src/instance/fleetSwitch';
import { MOVE_TIMING, moveOutByFile, push, receive, stopReceive } from '../../src/instance/fleetMove';
import { sendAddresses } from '../../src/instance/fleetJoin';
import { encodeJoinCode, encodeMoveCode } from '../../src/config/joinCode';
import * as envManager from '../../src/env/manager';
import * as maintenance from '../../src/instance/maintenance';
import * as appCapabilities from '../../src/config/appCapabilities';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import * as containerManager from '../../src/docker/containerManager';
import * as dbLogin from '../../src/instance/dbLogin';
import * as fleetReplication from '../../src/instance/fleetReplication';
import { laneDone, runMigration, setMigrateListener, MIGRATE_TIMING } from '../../src/instance/migrate';
import { fake, fakeJoin, freshDb, h, mainFixture, resetHarness, scripts, seedDbs, stored, writeRegistry, ENV, SETTLED } from './switch-harness';
import { fastTiming, getJob, postJob } from './migrate-fake';

const RECORD = { to: 'file', from: 'postgres', destination: null, companion: false, jobId: 'mgr-a', jobIds: ['mgr-a'], posted: true, started: 1, kept: 0, phase: 'waiting', resumeAt: 'following', loginOpened: true, sharers: [], sharersStopped: [], openedAt: '2026-10-31T00:00:00.000Z', text: 'press Migrate' } as const;
const MG_DB = 'A data migration to JSON files is open on this bot, so its database setup cannot change until it ends; nothing was changed';

beforeEach(() => {
  resetHarness();
  resetSwitchState();
  seedDbs();
  writeRegistry({ a: mainFixture() });
  SWITCH_TIMING.catchUpMs = 60;
  SWITCH_TIMING.pollMs = 5;
  releaseFleetBackupBusy('a');
  MOVE_TIMING.sessionPauseMs = 0;
  fastTiming(MIGRATE_TIMING);
  setMigrateListener(null);
  tmp.join = { success: true, joinCode: encodeJoinCode(fakeJoin({ host: 'main.example', port: 5433 })) };
});
afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

async function press(to: string) {
  const a = await runMigration('a', to, 'press');
  await laneDone('a');
  return a;
}

const OFF = { state: 'off', message: '', orderedAt: '2026-10-30T00:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: 'maintenance' };
const OFF_TEXT = /The bot is Off/;
const DUMP = 'pre-receive-2026-10-28T12-00-00-000Z.dump';
const noReplication = () => mainFixture({ fleetDb: { ...mainFixture().fleetDb as object, replication: undefined } });
const writable = (g: number) => () => ({ kind: 'writable', systemId: '7001', timeline: 2, gen: { generation: g, machine: 'copy.example', since: '2026-10-28T14:00:00Z' }, receiveMark: false }) as any;
const settle = () => containerManager.updateInstanceMaintenance('a', { ...SETTLED } as any);
const NO_JOB = { ok: true, status: 200, body: { success: true, job: null } };
const calls = (action: string) => h.hookCalls.filter(c => c.action === action).length;

async function until(f: () => boolean) {
  for (let i = 0; i < 2000 && !f(); i++) await new Promise(r => setTimeout(r, 1));
  expect(f()).toBe(true);
}

function held<T>() {
  let release!: (v: T) => void;
  const promise = new Promise<T>(r => { release = r; });
  return { promise, release };
}

/** The bot's login as the harness reads it, opened and blocked by the lane's own calls. */
function liveLogin() {
  const login = { inRecovery: false, canLogin: false as boolean | null, sessions: 0 };
  h.login = login;
  const open = vi.spyOn(dbLogin, 'openBotLogin').mockImplementation((async () => { h.events.push('open'); login.canLogin = true; return { ok: true }; }) as any);
  const block = vi.spyOn(dbLogin, 'blockBotLogin').mockImplementation((async () => { h.events.push('block'); login.canLogin = false; return { ok: true }; }) as any);
  return { login, restore: () => { open.mockRestore(); block.mockRestore(); } };
}

/** A refused press, with the registry as it was before it. */
async function refused(to: string, text: string | RegExp) {
  const before = JSON.stringify(stored('a'));
  const a = await press(to) as any;
  expect(a).toMatchObject({ accepted: false, status: 409 });
  if (typeof text === 'string') expect(a.error).toBe(text); else expect(a.error).toMatch(text);
  expect(JSON.stringify(stored('a'))).toBe(before);
}

describe('N: NM10 against NM5', () => {
  it('N1 a handover mark written by Hand over refuses MG-SWITCH-H with the mode text', async () => {
    expect((await handOver('a', 'slot_c', false)).success).toBe(true);
    expect(stored('a').fleetDb.handover).toBeTruthy();
    containerManager.updateInstanceMaintenance('a', { ...SETTLED } as any);
    const before = JSON.stringify(stored('a'));
    const a = await press('file');
    expect(a).toEqual({ accepted: false, status: 409, error: 'A move of this database is recorded (a hand-over to copy.example); finish it or cancel it in the Database window before migrating; nothing was changed' });
    expect(JSON.stringify(stored('a'))).toBe(before);
  });
  it('N2 a receive mark written by Receive: A17 refuses while Off, MG-SWITCH-V once in Maintenance', async () => {
    writeRegistry({ a: mainFixture({ maintenance: OFF }) });
    fake.dbs['a-pg'] = freshDb();
    expect((await receive('a')).success).toBe(true);
    expect(stored('a').fleetDb.receive).toMatchObject({ safetyDump: DUMP });
    await refused('file', OFF_TEXT);
    settle();
    await refused('file', 'This database is waiting to receive a main from another machine; stop receiving before migrating; nothing was changed');
  });
  it('N11 a pushBroken mark written by Stop receiving after a push replaced the database: A17 while Off, then MG-SWITCH-P', async () => {
    writeRegistry({ a: mainFixture({ maintenance: OFF }) });
    fake.dbs['a-pg'] = freshDb();
    expect((await receive('a')).success).toBe(true);
    fake.dbs['a-pg'].dbOid = '24576';
    expect((await stopReceive('a')).success).toBe(true);
    expect(stored('a').fleetDb.receive).toBeUndefined();
    expect(stored('a').fleetDb.pushBroken).toMatchObject({ safetyDump: DUMP });
    await refused('file', OFF_TEXT);
    settle();
    await refused('file', `A push into this database did not finish, so it may hold no data or data no one checked; restore the dump ${DUMP} or receive a push again before migrating; nothing was changed`);
  });
  it('N3 a replacedBy mark written by the tick\'s peer check refuses MG-SWITCH-R, before A32', async () => {
    h.peer = writable(4);
    await switchTick(Date.now());
    expect(stored('a').fleetDb.replacedBy).toMatchObject({ machine: 'copy.example', generation: 4, own: 3 });
    settle();
    await refused('file', 'copy.example replaced this database as the main; rejoin this machine as a copy before migrating; nothing was changed');
  });
  it('N3 a mainConflict mark written by the tick\'s peer check refuses MG-SWITCH-C', async () => {
    h.peer = writable(3);
    await switchTick(Date.now());
    expect(stored('a').fleetDb.mainConflict).toMatchObject({ machine: 'copy.example', generation: 3 });
    settle();
    await refused('file', 'Two main databases with the same generation are recorded; settle which one stays the main before migrating; nothing was changed');
  });
  it('A34 and N13 a press while a real tick pass is on the bot: MG-TICK, nothing written; admitted once the pass ends; a pass after the record write skips the bot', async () => {
    writeRegistry({ a: noReplication() });
    const notice = held<unknown>();
    const save = held<unknown>();
    h.hook = ((action: string) => action === 'switch-notice' ? notice.promise : action === 'migrate' ? NO_JOB : action === 'maintenance' ? save.promise : { ok: false, status: 500, error: 'boom' }) as any;
    const tick = switchTick(Date.now());
    await until(() => calls('switch-notice') === 1);
    const before = JSON.stringify(stored('a'));
    const a = await press('file');
    expect(a).toEqual({ accepted: false, status: 409, error: "The manager's check of this bot's main database is running right now; press Migrate again in a minute; nothing was changed" });
    expect(calls('migrate')).toBe(1);
    expect(h.hookCalls.map(c => c.action)).toEqual(['switch-notice', 'migrate']);
    expect(JSON.stringify(stored('a'))).toBe(before);
    expect(h.events.filter(e => e === 'open' || e.startsWith('stop-bot') || e.startsWith('db-'))).toEqual([]);
    notice.release({ ok: true, status: 200 });
    await tick;
    const login = liveLogin();
    try {
      expect(await runMigration('a', 'file', 'press')).toEqual({ accepted: true });
      expect(stored('a').migrate).toMatchObject({ to: 'file', from: 'postgres' });
      await until(() => calls('maintenance') === 1);
      fake.dbs['a-pg'].generation = { generation: 6, machine: 'main.example', since: '2026-10-31T00:00:00Z' };
      const scriptsBefore = scripts('a-pg').length;
      await switchTick(Date.now());
      expect(calls('switch-notice')).toBe(1);
      expect(scripts('a-pg').length).toBe(scriptsBefore);
      save.release({ ok: false, status: 404, error: 'Not found' });
      await laneDone('a');
    } finally {
      login.restore();
    }
    expect(stored('a').migrate).toBeUndefined();
  });
  it('N14 an addressesPush offer written pending by sendAddresses from a 502 unknown is not repeated while a record is open', async () => {
    h.hook = ((action: string) => action === 'addresses' ? { ok: false, status: 502, unknown: true, error: 'addresses sent, no answer within 10 s' } : { ok: true, status: 200 }) as any;
    expect((await sendAddresses('a')).state).toBe('pending');
    expect(stored('a').addressesPush).toMatchObject({ state: 'pending' });
    containerManager.updateInstanceMigrate('a', { ...RECORD } as any);
    await switchTick(Date.now());
    expect(calls('addresses')).toBe(1);
    expect(stored('a').addressesPush).toMatchObject({ state: 'pending' });
    containerManager.updateInstanceMigrate('a', null);
    await switchTick(Date.now() + 3_600_000);
    expect(calls('addresses')).toBe(2);
  });
  it('B24 replacedBy written by updateInstanceFleetDbSwitch after M4 and before M6: no stop, F with MG-SWITCH-LATE, the login blocked again', async () => {
    writeRegistry({ a: noReplication() });
    const events: Array<{ text: string; final: boolean }> = [];
    setMigrateListener((_id, ev) => { events.push(ev); });
    h.hook = ((action: string) => {
      if (action === 'migrate') return NO_JOB;
      if (action === 'maintenance') {
        containerManager.updateInstanceFleetDbSwitch('a', { replacedBy: { machine: 'other.example', host: 'other.example', port: 5432, generation: 4, own: 3, since: null, at: '2026-10-31T00:00:00.000Z' } } as any);
        return { ok: true, status: 200, body: { success: true, saved: true } };
      }
      return { ok: false, status: 500, error: 'boom' };
    }) as any;
    const login = liveLogin();
    try {
      expect(await press('file')).toEqual({ accepted: true });
    } finally {
      login.restore();
    }
    expect(h.events.filter(e => e.startsWith('stop-bot') || e === 'start-bot')).toEqual([]);
    expect(calls('migrate')).toBe(1);
    expect(h.events.filter(e => e === 'open' || e === 'block')).toEqual(['open', 'block']);
    expect(login.login.canLogin).toBe(false);
    expect(stored('a').migrate).toBeUndefined();
    const last = stored('a').migrateLast;
    expect(last).toMatchObject({ to: 'file', outcome: 'failed', jobId: null });
    expect(last.text).toMatch(/^The migration did not start: other\.example replaced this database as the main, so the bot does not start here; rejoin it as a copy, so the manager did not restart the bot into maintenance\. Nothing was copied, and the bot stays in Maintenance\./);
    expect(events.at(-1)).toEqual({ text: last.text, final: true });
    expect(stored('a').fleetDb.replacedBy).toMatchObject({ machine: 'other.example' });
  });
  it.each(['handover', 'takeover', 'receive', 'push', 'move-out', 'keep-main'])('N5 %s: startLane and runLane refuse MG-DB while a record is open', async (op) => {
    containerManager.updateInstanceMigrate('a', { ...RECORD } as any);
    let ran = 0;
    const fn = async () => { ran++; return { success: true, text: 'x' }; };
    expect(await runLane('a', op, fn)).toEqual({ success: false, text: MG_DB, status: 409 });
    expect(await startLane('a', op, fn, () => undefined)).toEqual({ success: false, text: MG_DB, status: 409 });
    expect(ran).toBe(0);
  });
  it('N6 the tick skips a bot with a parked record: no hook, no login, no generation write', async () => {
    containerManager.updateInstanceMigrate('a', { ...RECORD } as any);
    const generation = fake.dbs['a-pg'].generation;
    await switchTick(Date.now() + 3_600_000);
    expect(h.hookCalls).toEqual([]);
    expect(h.events.filter(e => e === 'block' || e === 'end-sessions')).toEqual([]);
    expect(scripts('a-pg')).toEqual([]);
    expect(fake.dbs['a-pg'].generation).toEqual(generation);
  });
  it('N6 without a record the same tick runs its pass (the skip is the record)', async () => {
    await switchTick(Date.now() + 3_600_000);
    expect(scripts('a-pg').length).toBeGreaterThan(0);
  });
  it('N10 after a done move to JSON files, written by the lane: Hand over and Receive refused by mainAdmission, Push and Move out by the file kind', async () => {
    writeRegistry({ a: noReplication() });
    const env: Record<string, string> = { ...ENV };
    let job: Record<string, unknown> | null = null;
    h.hook = ((action: string, body: any) => {
      if (action === 'maintenance') return { ok: true, status: 200, body: { success: true, saved: true } };
      if (action !== 'migrate') return { ok: false, status: 500, error: 'boom' };
      if (body) {
        job = { jobId: body.jobId, to: body.to, state: 'running', stage: 'checking' };
        return postJob({ ...job, state: 'started' } as any);
      }
      return getJob(job ? { ...job, state: 'done', stage: 'done' } as any : null);
    }) as any;
    const real = await vi.importActual<typeof import('../../src/instance/maintenance')>('../../src/instance/maintenance');
    const caps = { companionDb: { env: { url: 'DATABASE_URL', mode: { key: 'DATA_BACKEND', value: 'postgres' } }, user: 'app', database: 'app' }, hooks: { port: 3000, basePath: '/hooks' } };
    const spies: Array<{ mockRestore: () => void }> = [
      vi.spyOn(appCapabilities, 'findAppCapabilities').mockImplementation((() => caps) as any),
      vi.spyOn(envManager, 'getEnvVars').mockImplementation((() => ({ ...env })) as any),
      vi.spyOn(envManager, 'getEnvVarsWithStatus').mockImplementation((() => ({ vars: { ...env }, corrupt: false, undecryptable: [] })) as any),
      vi.spyOn(containerManager, 'updateBotInOp').mockImplementation((async (_id: string, u: any) => { Object.assign(env, u.envVars); h.events.push(`env:${JSON.stringify(u.envVars)}`); return stored('a'); }) as any),
      vi.spyOn(containerManager, 'startBotInOp').mockImplementation((async (_id: string, op: string) => { h.events.push(`start-bot:${op}`); return { success: true }; }) as any),
      vi.spyOn(containerManager, 'databaseReady').mockImplementation((async () => true) as any),
      vi.spyOn(containerManager, 'appContainerEnv').mockImplementation((async () => ({ ok: true, env: { DATA_BACKEND: env.DATA_BACKEND, DATABASE_URL: env.DATABASE_URL } })) as any),
      vi.spyOn(maintenance, 'runOrderInOp').mockImplementation((async () => { h.events.push('order:running'); return { settled: true, text: 'The bot is running normally.' }; }) as any),
    ];
    const login = liveLogin();
    try {
      expect(await press('file')).toEqual({ accepted: true });
      expect(stored('a').migrate).toBeUndefined();
      expect(stored('a').migrateLast).toMatchObject({ to: 'file', outcome: 'done' });
      expect(env.DATA_BACKEND).toBe('file');
      expect(stored('a').fleetDb).toMatchObject({ containerName: 'a-pg' });
      const requireSpy = vi.spyOn(maintenance, 'requireMaintenance').mockImplementation(real.requireMaintenance);
      spies.push(requireSpy);
      const before = JSON.stringify(stored('a'));
      const events = h.events.length;
      expect(await handOver('a', 'slot_c', false)).toMatchObject({ success: false, text: 'Replication is not enabled on this database, so no copy follows it; enable it and add a live copy first; nothing was changed' });
      expect(await receive('a')).toMatchObject({ success: false, text: 'Replication is not enabled, so the other machine has no address to push to; enable it first; nothing was changed' });
      const code = encodeMoveCode({ ...fakeJoin({ host: 'win.example', port: 5440, machine: 'win.example', db: 'app', app: { user: 'app', password: 'apppw' } }), recv: { user: 'smdb_receive', password: 'recvpw', id: '0123456789abcdef01234567' } } as any);
      const FILES = 'This bot keeps its data in files, so the manager cannot hold its database in maintenance';
      expect(await push('a', code)).toMatchObject({ success: false, text: `The push was refused and nothing was changed: ${FILES}` });
      expect(await moveOutByFile('a')).toMatchObject({ success: false, text: `The move was refused and nothing was changed: ${FILES}` });
      expect(requireSpy).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(stored('a'))).toBe(before);
      expect(h.events.slice(events).filter(e => e.startsWith('dump:') || e.startsWith('stop-bot') || e.startsWith('db-'))).toEqual([]);
    } finally {
      login.restore();
      for (const s of spies) s.mockRestore();
    }
  });
  it('N12 a copy whose take-over was cut keeps fleetJoin: MG-FLEET-JOIN', async () => {
    writeRegistry({ a: mainFixture({ fleetDb: { ...mainFixture().fleetDb as object, replication: undefined }, fleetJoin: { code: 'smdbjoin1.x', at: 'x' } }) });
    expect((await press('file') as any).error).toMatch(/joined another machine's database with a join code/);
  });
  it('A32 replication on refuses a move to JSON files on a main', async () => {
    expect((await press('file') as any).error).toMatch(/replication on/);
  });
});

describe('N: a Database URL that names another bot\'s container (round 4)', () => {
  /** `a` hosts the database; `b` names a's container in its URL and sits in settled Maintenance. */
  function withB(a: Record<string, unknown> = mainFixture()): void {
    writeRegistry({ a, b: { maintenance: { ...SETTLED } } });
  }
  async function pressB(to = 'file') {
    const r = await runMigration('b', to, 'press');
    await laneDone('b');
    return r;
  }
  async function refusedB(text: string | RegExp) {
    const before = fs.readFileSync(registryPath(), 'utf-8');
    const r = await pressB() as any;
    expect(r).toMatchObject({ accepted: false, status: 409 });
    if (typeof text === 'string') expect(r.error).toBe(text); else expect(r.error).toMatch(text);
    expect(fs.readFileSync(registryPath(), 'utf-8')).toBe(before);
  }
  const registryPath = () => `${process.env.DATA_DIR}/instances.json`;

  it('A41 (round 4) from the real writer\'s main: MG-OWNER-HOSTED naming A, the registry unchanged', async () => {
    withB();
    await refusedB("The Database URL names a database in A's managed database container, so the migration was refused: Migrate moves data only to or from this bot's own managed database or a database outside this manager's containers, and Migrate on A moves A's own data; nothing was changed");
  });
});

describe('N: a sharer another record holds (round 5, A-4 = B-3)', () => {
  const holding = () => writeRegistry({ a: mainFixture(), b1: { maintenance: { ...SETTLED }, migrate: { ...RECORD, sharers: ['a'], sharersStopped: ['a'] } } });
  it('N15 (round 5, pin) the tick skips a sharer another record lists: no hook, no script', async () => {
    holding();
    await switchTick(Date.now() + 3_600_000);
    expect(h.hookCalls).toEqual([]);
    expect(scripts('a-pg')).toEqual([]);
  });
  it.each(['handover', 'takeover', 'receive', 'push', 'move-out', 'keep-main'])('O23 (round 5, pin) %s: startLane and runLane refuse MG-HELD-DB on a sharer another record lists', async (op) => {
    holding();
    const text = "B1's data migration to JSON files is open on the database this bot uses, so this bot's database setup cannot change until that migration ends; nothing was changed";
    let ran = 0;
    const fn = async () => { ran++; return { success: true, text: 'x' }; };
    expect(await runLane('a', op, fn)).toEqual({ success: false, text, status: 409 });
    expect(await startLane('a', op, fn, () => undefined)).toEqual({ success: false, text, status: 409 });
    expect(ran).toBe(0);
  });
});
