import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/docker/containerManager', async () => (await import('./migrate-fake')).cmMock());
vi.mock('../../src/env/manager', async (o) => (await import('./migrate-fake')).envMock(await o()));
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./migrate-fake')).dbLoginMock(await o()));
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./migrate-fake')).hookMock(await o()));
vi.mock('../../src/instance/maintenance', async (o) => (await import('./migrate-fake')).maintenanceMock(await o()));
vi.mock('../../src/instance/fleetBackup', async (o) => (await import('./migrate-fake')).fleetBackupMock(await o()));
vi.mock('../../src/instance/fleetReplica', async (o) => (await import('./migrate-fake')).fleetReplicaMock(await o()));
vi.mock('../../src/instance/fleetSwitch', async () => (await import('./migrate-fake')).fleetSwitchMock());

import { laneDone, runMigration, MIGRATE_TIMING } from '../../src/instance/migrate';
import { fastTiming, getJob, m, resetMigrate, seedBot, seedSharer, FLEET_DB, MG_FENCE_BACK, MG_FENCE_F, MG_FENCE_STRIPPED, MG_FENCE_UNCONFIRMED, WHY_LIFT_LOCKED } from './migrate-fake';

beforeEach(() => { resetMigrate(); fastTiming(MIGRATE_TIMING); });

const rec = () => m.bots.b1.migrate;
const last = () => m.bots.b1.migrateLast;
const failedJob = () => { m.bot.postQueue.push({ ok: true, status: 200, body: { success: true, jobId: 'mgr-f', to: 'file', state: 'failed', stage: 'copying', error: 'disk full' } }); };

async function press(to: 'postgres' | 'file' = 'file') {
  expect(await runMigration('b1', to, 'press')).toEqual({ accepted: true });
  await laneDone('b1');
}

describe('F: the close after a failure', () => {
  it('F1 the closing write fails: the lane stops with the record open', async () => {
    seedBot({ postgres: true });
    failedJob();
    m.failMigrateWrite = (_n, r) => (r?.phase === 'closing' ? 'disk full' : null);
    await press();
    expect(rec().phase).toBe('posting');
    expect(last()).toBeUndefined();
  });
  it('F2 the stored backend already names the source: no env write', async () => {
    seedBot({ postgres: true });
    failedJob();
    await press();
    expect(m.events.filter(e => e.startsWith('env:') || e.startsWith('env-inop:'))).toEqual([]);
    expect(last()).toMatchObject({ outcome: 'failed', jobId: 'mgr-f' });
  });
  it('F3 the stored backend differs: set back; a throw parks at closing with MG-ENV-BACK', async () => {
    seedBot({ postgres: true });
    failedJob();
    m.bot.postQueue.unshift();
    m.failUpdateBot = 'store locked';
    m.saveAnswers.push(() => { m.env.b1.DATA_BACKEND = 'file'; return { ok: true, status: 200, body: { success: true, saved: true } }; });
    await press();
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'closing' });
    expect(rec().text).toMatch(/ The stored Data Backend could not be set back to Postgres \(store locked\), so the migration stays open; press Migrate to set it again\.$/);
  });
  it('F3 then a press sets it back and closes, with the failure text once', async () => {
    seedBot({ postgres: true });
    m.env.b1.DATA_BACKEND = 'file';
    m.bots.b1.migrate = { to: 'file', from: 'postgres', destination: null, companion: false, jobId: 'mgr-f', jobIds: ['mgr-f'], posted: true, started: 1, kept: 0, phase: 'waiting', resumeAt: 'closing', loginOpened: false, sharers: [], sharersStopped: [], isolated: true, openedAt: 'x', text: 'Migration mgr-f failed at copying: disk full. Nothing was switched: the bot stays in Maintenance and keeps its data in its database. The stored Data Backend could not be set back to Postgres (store locked), so the migration stays open; press Migrate to set it again.' };
    await press();
    expect(m.env.b1.DATA_BACKEND).toBe('postgres');
    expect(last().text).toBe('Migration mgr-f failed at copying: disk full. Nothing was switched: the bot stays in Maintenance and keeps its data in its database.');
  });
  it('F4 the login it opened is blocked again and read back before the close', async () => {
    seedBot({ postgres: true });
    failedJob();
    await press();
    const e = m.events;
    expect(e.indexOf('login-block')).toBeLessThan(e.indexOf('record:closed'));
    expect(m.login).toMatchObject({ canLogin: false, sessions: 0 });
  });
  it('F4 a block that fails parks with the login open, and keeps parking until it reads back', async () => {
    seedBot({ postgres: true });
    failedJob();
    m.blockResult = { ok: false, cls: 'other', error: 'database down' };
    await press();
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'closing', loginOpened: true });
    expect(rec().text).toMatch(/could not be blocked again \(database down\), so the migration stays open with the login open/);
    m.blockResult = { ok: true };
    await press();
    expect(rec()).toBeUndefined();
    expect(last().outcome).toBe('failed');
  });
  it('a failed move to Postgres whose kind is json: F4 still blocks the companion login it opened', async () => {
    seedBot();
    m.login = { inRecovery: false, canLogin: false, sessions: 0 };
    m.bot.postQueue.push({ ok: true, status: 200, body: { success: true, jobId: 'mgr-f', to: 'postgres', state: 'failed', stage: 'copying', error: 'x' } });
    await press('postgres');
    expect(m.events).toContain('login-open');
    expect(m.events).toContain('login-block');
    expect(m.env.b1.DATA_BACKEND).toBe('file');
  });
  it('a closing record after Stop: M1b starts the companion, then F4 blocks (R2-A5)', async () => {
    seedBot({ postgres: true });
    m.app.b1 = false;
    m.sidecar[FLEET_DB.containerName] = false;
    m.bots.b1.migrate = { to: 'file', from: 'postgres', destination: null, companion: false, jobId: 'mgr-f', jobIds: ['mgr-f'], posted: true, started: 1, kept: 0, phase: 'waiting', resumeAt: 'closing', loginOpened: true, sharers: [], sharersStopped: [], isolated: true, openedAt: 'x', text: 'Migration mgr-f failed.' };
    m.login.canLogin = true;
    await press();
    expect(m.events.indexOf('db-start:b1')).toBeLessThan(m.events.indexOf('login-block'));
    expect(m.events).not.toContain('start:migrate');
    expect(last().outcome).toBe('failed');
  });
  it('F5 the sharers start again before the save that releases them; a failed start appends W-SHARER', async () => {
    seedBot({ postgres: true });
    seedSharer('s1');
    seedSharer('s2');
    failedJob();
    m.sharerStart = (id: string) => (id === 's2' ? { success: false, error: 'port in use' } : { success: true });
    await press();
    const e = m.events;
    expect(e.indexOf('start-sharer:s1')).toBeLessThan(e.indexOf('record:closed'));
    expect(last().text).toMatch(/ S2 did not start again \(port in use\); start it by hand\.$/);
  });
  it('F7 closed: Maintenance unchanged, the env the source', async () => {
    seedBot({ postgres: true });
    failedJob();
    await press();
    expect(m.bots.b1.maintenance).toMatchObject({ state: 'maintenance', settled: true });
    expect(m.env.b1.DATA_BACKEND).toBe('postgres');
    expect(m.events).not.toContain('order:running:migrate');
  });
  it('the env is never set back after finishing', async () => {
    seedBot();
    m.bots.b1.migrate = { to: 'postgres', from: 'file', destination: 'b1-fleet-postgres:5432/smdb', companion: true, jobId: 'mgr-a', jobIds: ['mgr-a'], posted: true, started: 1, kept: 0, phase: 'waiting', resumeAt: 'finishing', finishing: 'stored', loginOpened: false, sharers: [], sharersStopped: [], openedAt: 'x' };
    m.env.b1.DATA_BACKEND = 'postgres';
    m.bots.b1.fleetDb = { ...FLEET_DB };
    m.env.b1.DATA_BACKEND_URL = 'postgresql://smdb:pw@b1-fleet-postgres:5432/smdb';
    m.stop = { success: false, error: 'compose down failed' };
    await press('postgres');
    expect(m.env.b1.DATA_BACKEND).toBe('postgres');
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'finishing' });
    expect(getJob).toBeDefined();
  });
});

describe('F5: round 1', () => {
  function appReads(id: string, answers: Array<boolean | null>): void {
    const orig = m.app;
    const left = [...answers];
    m.app = new Proxy(orig, { get: (t, k) => (k === id && left.length ? left.shift() : (t as any)[k]), has: (t, k) => k in t });
  }
  const sharers = () => m.events.filter(e => e.startsWith('start-sharer:'));
  it('R4 F after M5 starts only the sharer M5 stopped, with no W-SHARER; the stopped and the Off ones are untouched', async () => {
    seedBot({ postgres: true });
    seedSharer('s1');
    seedSharer('s2');
    seedSharer('s3', { maintenance: { state: 'off', message: '', orderedAt: '2026-10-30T00:00:00.000Z', settled: true } });
    m.app.s2 = false;
    m.app.s3 = false;
    failedJob();
    await press();
    expect(sharers()).toEqual(['start-sharer:s1']);
    expect(last().text).not.toMatch(/did not start again/);
  });
  it('A-5 a sharer busy at F5 gives W-SHARER-BUSY, and the record closes', async () => {
    seedBot({ postgres: true });
    seedSharer('s1');
    m.sharerStop = (id: string) => { m.lock[id] = 'build'; return { success: true }; };
    failedJob();
    await press();
    expect(rec()).toBeUndefined();
    expect(last().text).toMatch(/ S1 was not started again: it is running 'build'; start it by hand once that ends\.$/);
    expect(sharers()).toEqual([]);
  });
  it('A-5 startBot throwing gives W-SHARER with its text', async () => {
    seedBot({ postgres: true });
    seedSharer('s1');
    m.sharerStart = () => { throw new Error('compose up crashed'); };
    failedJob();
    await press();
    expect(rec()).toBeUndefined();
    expect(last().text).toMatch(/ S1 did not start again \(compose up crashed\); start it by hand\.$/);
  });
  it('A-5 docker unsure at F5 gives W-SHARER naming it', async () => {
    seedBot({ postgres: true });
    seedSharer('s1');
    appReads('s1', [true, false, null]);
    failedJob();
    await press();
    expect(last().text).toMatch(/ S1 did not start again \(docker did not say whether it runs\); start it by hand\.$/);
    expect(sharers()).toEqual([]);
  });
});

describe('F10: the migration\'s pg_hba lines at F (round 6)', () => {
  const FAILED = 'Migration mgr-f failed at copying: disk full. Nothing was switched: the bot stays in Maintenance and keeps its data in its database.';
  it('F10 removed without a reload, and its order: after the login block, before the sharers start, with MG-FENCE-STRIPPED', async () => {
    seedBot({ postgres: true });
    seedSharer('s1');
    m.fenceLift = 'stripped';
    failedJob();
    await press();
    expect(last()).toMatchObject({ outcome: 'failed' });
    expect(last().text).toBe(FAILED + MG_FENCE_STRIPPED);
    expect(m.events.indexOf('login-block')).toBeGreaterThan(-1);
    expect(m.events.indexOf('login-block')).toBeLessThan(m.events.indexOf('hba-lift'));
    expect(m.events.indexOf('hba-lift')).toBeLessThan(m.events.indexOf('start-sharer:s1'));
  });
  it('F10 the lines stay: the record waits at closing with MG-FENCE-BACK, and a press that lifts closes with the failure alone', async () => {
    seedBot({ postgres: true });
    seedSharer('s1');
    m.fenceLift = 'locked';
    failedJob();
    await press();
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'closing' });
    expect(rec().text).toBe(FAILED + MG_FENCE_BACK(WHY_LIFT_LOCKED('Read-only file system')));
    expect(m.events.some(e => e.startsWith('start-sharer:'))).toBe(false);
    m.fenceLift = 'lifted';
    await press();
    expect(last()).toMatchObject({ outcome: 'failed' });
    expect(last().text).toBe(FAILED);
    expect(m.events).toContain('start-sharer:s1');
    expect(rec()).toBeUndefined();
  });
  it("(pin) F10's scope: a failed move to file from an outside database lifts nothing", async () => {
    seedBot({ external: true });
    failedJob();
    await press();
    expect(last()).toMatchObject({ outcome: 'failed' });
    expect(m.events).not.toContain('hba-lift');
  });
  it('F11 the lift finds no line and no reload lands: the close goes on with MG-FENCE-UNCONFIRMED, and the sharer starts again', async () => {
    seedBot({ postgres: true });
    seedSharer('s1');
    m.fenceLift = 'unconfirmed';
    failedJob();
    await press();
    expect(last()).toMatchObject({ outcome: 'failed' });
    expect(last().text).toBe(FAILED + MG_FENCE_UNCONFIRMED);
    expect(m.events.indexOf('start-sharer:s1')).toBeGreaterThan(m.events.indexOf('hba-lift'));
    expect(rec()).toBeUndefined();
  });
  it('A-4 B36 with no line written: the close names MG-FENCE-UNCONFIRMED, never MG-FENCE-STRIPPED', async () => {
    seedBot({ postgres: true });
    const why = "the database's settings could not be read (connection refused)";
    m.fenceUp = why;
    m.fenceLift = 'unconfirmed';
    await press();
    expect(last().text).toBe(MG_FENCE_F(why) + MG_FENCE_UNCONFIRMED);
    expect(last().text).not.toContain(MG_FENCE_STRIPPED);
  });
});
