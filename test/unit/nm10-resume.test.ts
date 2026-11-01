import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/docker/containerManager', async () => (await import('./migrate-fake')).cmMock());
vi.mock('../../src/env/manager', async (o) => (await import('./migrate-fake')).envMock(await o()));
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./migrate-fake')).dbLoginMock(await o()));
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./migrate-fake')).hookMock(await o()));
vi.mock('../../src/instance/maintenance', async (o) => (await import('./migrate-fake')).maintenanceMock(await o()));
vi.mock('../../src/instance/fleetBackup', async (o) => (await import('./migrate-fake')).fleetBackupMock(await o()));
vi.mock('../../src/instance/fleetReplica', async (o) => (await import('./migrate-fake')).fleetReplicaMock(await o()));
vi.mock('../../src/instance/fleetSwitch', async () => (await import('./migrate-fake')).fleetSwitchMock());

import { laneDone, resumeMigrations, runMigration, MIGRATE_TIMING } from '../../src/instance/migrate';
import { fastTiming, http, m, resetMigrate, restart, seedBot, seedSharer, DOWN_F_R, DOWN_P_R, FLEET_DB, KillPoint, MG_FENCE_WAIT, MG_WHY_DB_DOWN } from './migrate-fake';

beforeEach(() => { resetMigrate(); fastTiming(MIGRATE_TIMING); });

const rec = () => m.bots.b1.migrate;
const last = () => m.bots.b1.migrateLast;
const FAILED_FILE = (jobId: string) => `Migration ${jobId} failed at copying: disk full. Nothing was switched: the bot stays in Maintenance and keeps its data in its database.`;
const DOWN_F = (err: string) => ` The manager can't confirm that the bot's database login, which the migration opened, is blocked again: the managed database is stopped and did not start (${err}). Once the database runs, the manager's maintenance check blocks the login while the bot's state is not Running.`;
const DOWN_P = (err: string) => ` The manager can't confirm that the login of the bot's managed database, which the migration opened, is blocked again: that database is stopped and did not start (${err}). The bot keeps its data in its JSON files, which do not use that login; a later migration to Postgres uses the login as it is.`;
const base = (over: Record<string, unknown> = {}) => ({ to: 'postgres', from: 'file', destination: 'b1-fleet-postgres:5432/smdb', companion: true, jobId: 'mgr-a', jobIds: ['mgr-a'], posted: true, started: 1, kept: 0, loginOpened: false, sharers: [], sharersStopped: [], openedAt: 'x', ...over });

async function resume() {
  resumeMigrations();
  await new Promise(r => setTimeout(r, 0));
  await laneDone('b1');
}

describe('X: the manager restarted', () => {
  /** Presses, freezes the lane at the kill point, then restarts the manager: the record stays as the lane wrote it. */
  async function cutAt(kill: KillPoint, to: 'postgres' | 'file' = 'postgres'): Promise<void> {
    m.kill = kill;
    expect(await runMigration('b1', to, 'press')).toEqual({ accepted: true });
    const end = Date.now() + 2000;
    while (Date.now() < end && m.killSeen < (kill.nth ?? 1)) await new Promise(r => setTimeout(r, 2));
    expect(m.killSeen).toBe(kill.nth ?? 1);
    await new Promise(r => setTimeout(r, 10));
    restart();
    mark = m.events.length;
  }
  let mark = 0;
  const since = () => m.events.slice(mark);
  const failedJob = () => { m.bot.postQueue.push({ ok: true, status: 200, body: { success: true, jobId: 'mgr-f', to: 'file', state: 'failed', stage: 'copying', error: 'disk full' } }); };

  it('X2 cut before the maintenance hook (preparing): M2 to M6 again, the stored URL reused, then a POST', async () => {
    seedBot();
    await cutAt({ at: 'hook:maintenance', when: 'before' });
    expect(rec()).toMatchObject({ phase: 'preparing', posted: false });
    const url = m.env.b1.DATA_BACKEND_URL;
    await resume();
    expect(m.env.b1.DATA_BACKEND_URL).toBe(url);
    expect(since()).toContain('hook:maintenance');
    expect(since().filter(e => e.startsWith('POST'))).toHaveLength(1);
    expect(last().outcome).toBe('done');
  });
  it('X3 cut after the POST (posting): M7 with the same jobId', async () => {
    seedBot();
    await cutAt({ at: 'POST:', when: 'after' });
    expect(rec().phase).toBe('posting');
    await resume();
    expect(m.bot.posts.map(p => p.jobId)).toEqual([rec0Job(), rec0Job()]);
    expect(since()).not.toContain('hook:maintenance');
    expect(last().outcome).toBe('done');
  });
  it('X4 cut after a GET while following: M8, no POST', async () => {
    seedBot();
    m.bot.script = [{ stage: 'copying' }, { stage: 'verifying' }, { state: 'done', stage: 'switching' }];
    await cutAt({ at: 'GET', nth: 3, when: 'after' });
    expect(rec().phase).toBe('following');
    await resume();
    expect(since().filter(e => e.startsWith('POST'))).toEqual([]);
    expect(last()).toMatchObject({ outcome: 'done' });
  });
  it('X5 cut after a POST the bot answered started: the resume follows that job, no new job', async () => {
    seedBot();
    await cutAt({ at: 'POST:', when: 'after' });
    expect(m.bot.journal).toHaveLength(1);
    expect(rec().started).toBe(0);
    await resume();
    expect(m.bot.journal).toHaveLength(1);
    expect(last()).toMatchObject({ outcome: 'done', jobId: m.bot.journal[0].jobId });
  });
  it('X6 cut before the env write (finishing): D1 once, then done', async () => {
    seedBot();
    await cutAt({ at: 'env-inop:', when: 'before' });
    expect(rec()).toMatchObject({ phase: 'finishing' });
    expect(rec().finishing).toBeUndefined();
    await resume();
    expect(m.events.filter(e => e.startsWith('env-inop:'))).toEqual(['env-inop:{"DATA_BACKEND":"postgres"}']);
    expect(last().outcome).toBe('done');
  });
  it('X7 cut before the second stop (stored): D2 again, then done', async () => {
    seedBot();
    await cutAt({ at: 'stop:migrate', nth: 2, when: 'before' });
    expect(rec()).toMatchObject({ phase: 'finishing', finishing: 'stored' });
    await resume();
    expect(since()).toContain('stop:migrate');
    expect(since().filter(e => e.startsWith('env-inop:'))).toEqual([]);
    expect(last().outcome).toBe('done');
  });
  it('X8 cut before the env read (applied): D3, then done', async () => {
    seedBot();
    await cutAt({ at: 'env-read', when: 'before' });
    expect(rec()).toMatchObject({ phase: 'finishing', finishing: 'applied' });
    await resume();
    expect(since().filter(e => e.startsWith('stop:'))).toEqual([]);
    expect(since()).toContain('env-read');
    expect(last().outcome).toBe('done');
  });
  it('X9 cut before the Running order (confirmed): D4 again, then the close', async () => {
    seedBot();
    await cutAt({ at: 'order:running:migrate', when: 'before' });
    expect(rec()).toMatchObject({ phase: 'finishing', finishing: 'confirmed' });
    await resume();
    expect(since()).not.toContain('env-read');
    expect(since()).toContain('order:running:migrate');
    expect(last().outcome).toBe('done');
  });
  it('X10 a failed job, cut before the login block (closing): F2 to F6 again', async () => {
    seedBot({ postgres: true });
    failedJob();
    await cutAt({ at: 'login-block', when: 'before' }, 'file');
    expect(rec()).toMatchObject({ phase: 'closing', loginOpened: true });
    await resume();
    expect(last()).toMatchObject({ outcome: 'failed', jobId: 'mgr-f' });
    expect(last().text).toMatch(/^Migration mgr-f failed at copying: disk full\./);
    expect(m.login.canLogin).toBe(false);
  });
  it('X17 cut between M6\'s stop and start: the resume closes with MG-PREP-STOPPED, no hook, the login blocked; then a press is admitted', async () => {
    seedBot({ postgres: true });
    await cutAt({ at: 'stop:migrate', when: 'after' }, 'file');
    expect(rec()).toMatchObject({ phase: 'preparing', loginOpened: true });
    expect(m.app.b1).toBe(false);
    await resume();
    expect(since()).not.toContain('hook:maintenance');
    expect(rec()).toBeUndefined();
    expect(last().text).toBe('The migration did not start: the bot is stopped, and it has to run in its maintenance boot to save what it holds. Nothing was copied, and the bot stays in Maintenance; start it, then press Migrate again.');
    expect(m.login.canLogin).toBe(false);
    m.app.b1 = true;
    expect(await runMigration('b1', 'file', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
  });
  it('X18 cut after the env write (finishing, the store holds `to`): one more identical write, then done', async () => {
    seedBot();
    await cutAt({ at: 'env-inop:', when: 'after' });
    expect(m.env.b1.DATA_BACKEND).toBe('postgres');
    expect(rec().finishing).toBeUndefined();
    await resume();
    expect(m.events.filter(e => e.startsWith('env-inop:'))).toEqual(['env-inop:{"DATA_BACKEND":"postgres"}', 'env-inop:{"DATA_BACKEND":"postgres"}']);
    expect(last().outcome).toBe('done');
  });
  it('X19 cut between the sharersStopped write and the sharer\'s stop: the resume stops it, listed once', async () => {
    seedBot({ postgres: true });
    seedSharer('s1');
    await cutAt({ at: 'stop-sharer:s1', when: 'before' }, 'file');
    expect(rec()).toMatchObject({ phase: 'preparing', sharers: ['s1'], sharersStopped: ['s1'] });
    expect(m.app.s1).toBe(true);
    const writes = m.migrateWrites.length;
    await resume();
    expect(since().filter(e => e === 'stop-sharer:s1')).toHaveLength(1);
    const after = m.migrateWrites.slice(writes).map(w => w.rec).filter(Boolean);
    expect(after.every(r => JSON.stringify(r.sharersStopped) === '["s1"]')).toBe(true);
    expect(last().outcome).toBe('done');
  });
  /** A move to file of b1's own managed database parked at following by a 401 GET; then its database is down and its start fails. */
  const parkOwn = async () => {
    seedBot({ postgres: true });
    m.bot.getQueue.push(null, null, http(401, { success: false, error: 'bad token' }));
    expect(await runMigration('b1', 'file', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'following' });
    m.sidecar[FLEET_DB.containerName] = false;
    m.dbStart = { success: false, error: 'volume damaged' };
    mark = m.events.length;
  };
  const pressFile = async () => {
    expect(await runMigration('b1', 'file', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
  };
  it('X21 a press at following whose job is done: the GET comes first, G, and no database start', async () => {
    await parkOwn();
    m.bot.script = [{ state: 'done', stage: 'switching' }];
    await pressFile();
    expect(last().outcome).toBe('done');
    expect(since()).toContain('GET');
    expect(since()).not.toContain('db-start:b1');
  });
  it('X21 a press at following whose job failed: F with MG-FAILED and MG-LOGIN-DOWN-F, the GET before F9\'s start, no block (round 5)', async () => {
    await parkOwn();
    const jobId = rec().jobId;
    m.bot.script = [{ state: 'failed', stage: 'copying', error: 'disk full' }];
    await pressFile();
    expect(last().outcome).toBe('failed');
    expect(last().text).toBe(FAILED_FILE(jobId) + DOWN_F('volume damaged'));
    const e = since();
    expect(e.indexOf('GET')).toBeGreaterThan(-1);
    expect(e.indexOf('GET')).toBeLessThan(e.indexOf('db-start:b1'));
    expect(e).not.toContain('login-block');
    expect(rec()).toBeUndefined();
  });
  it('F9 (round 5) a record parked at closing by round 4\'s lane: the database start fails, the record closes with MG-LOGIN-DOWN-F, no block', async () => {
    seedBot({ postgres: true });
    m.bots.b1.migrate = { to: 'file', from: 'postgres', destination: null, companion: false, jobId: 'mgr-f', jobIds: ['mgr-f'], posted: true, started: 1, kept: 0, phase: 'waiting', resumeAt: 'closing', loginOpened: true, sharers: [], sharersStopped: [], isolated: true, openedAt: 'x',
      text: FAILED_FILE('mgr-f') + " The bot's database login, which the migration opened, could not be blocked again (container is not running), so the migration stays open with the login open; press Migrate to block it again." };
    m.sidecar[FLEET_DB.containerName] = false;
    m.dbStart = { success: false, error: 'volume damaged' };
    m.login.canLogin = true;
    await pressFile();
    expect(last()).toMatchObject({ outcome: 'failed' });
    expect(last().text).toBe(FAILED_FILE('mgr-f') + DOWN_F('volume damaged'));
    expect(m.events).toContain('db-start:b1');
    expect(m.events).not.toContain('login-block');
    expect(rec()).toBeUndefined();
  });
  it('F9 (round 5) a move to Postgres: the job failed and the companion does not start: MG-LOGIN-DOWN-P, the GET, attach and start in order, no block', async () => {
    seedBot();
    m.login = { inRecovery: false, canLogin: false, sessions: 0 };
    m.bot.getQueue.push(null, null, http(401, { success: false, error: 'bad token' }));
    expect(await runMigration('b1', 'postgres', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'following', loginOpened: true });
    const jobId = rec().jobId;
    m.sidecar[FLEET_DB.containerName] = false;
    m.dbStart = { success: false, error: 'volume damaged' };
    mark = m.events.length;
    m.bot.script = [{ state: 'failed', stage: 'copying', error: 'disk full' }];
    expect(await runMigration('b1', 'postgres', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
    expect(last()).toMatchObject({ outcome: 'failed' });
    expect(last().text).toBe(`Migration ${jobId} failed at copying: disk full. Nothing was switched: the bot stays in Maintenance and keeps its data in its JSON files.` + DOWN_P('volume damaged'));
    const e = since();
    expect(e.indexOf('GET')).toBeGreaterThan(-1);
    expect(e.indexOf('GET')).toBeLessThan(e.indexOf('attach'));
    expect(e.indexOf('attach')).toBeLessThan(e.indexOf('db-start:b1'));
    expect(e).not.toContain('login-block');
    expect(m.env.b1.DATA_BACKEND).toBe('file');
  });
  it('X22 (round 5) a press at following with the bot stopped and its job done: the bot starts before the first GET, then G with no database start', async () => {
    await parkOwn();
    m.app.b1 = false;
    m.bot.down = true;
    m.start = () => { m.bot.down = false; return { success: true }; };
    m.bot.script = [{ state: 'done', stage: 'switching' }];
    await pressFile();
    expect(last().outcome).toBe('done');
    const e = since();
    expect(e.indexOf('start:migrate')).toBeGreaterThan(-1);
    expect(e.indexOf('start:migrate')).toBeLessThan(e.indexOf('GET'));
    expect(e).not.toContain('db-start:b1');
  });
  it('X22 (round 5) a press at following with the bot stopped and its job running: start, GET, then the database start parks with MG-DB-START-WAIT', async () => {
    await parkOwn();
    m.app.b1 = false;
    m.bot.down = true;
    m.start = () => { m.bot.down = false; return { success: true }; };
    m.bot.script = [{ stage: 'copying' }];
    await pressFile();
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'following' });
    expect(rec().text).toBe(`Migration ${rec().jobId} is not finished, and the bot's database could not be started (volume damaged). The bot stays in Maintenance with the migration open; press Migrate to try again.`);
    const e = since();
    expect(e.indexOf('start:migrate')).toBeGreaterThan(-1);
    expect(e.indexOf('start:migrate')).toBeLessThan(e.indexOf('GET'));
    expect(e.indexOf('GET')).toBeLessThan(e.indexOf('db-start:b1'));
  });
  it('X21 a press at following whose job runs: the GET before the start, and a failed start parks with MG-DB-START-WAIT', async () => {
    await parkOwn();
    m.bot.script = [{ stage: 'copying' }];
    await pressFile();
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'following' });
    expect(rec().text).toBe(`Migration ${rec().jobId} is not finished, and the bot's database could not be started (volume damaged). The bot stays in Maintenance with the migration open; press Migrate to try again.`);
    const e = since();
    expect(e.indexOf('GET')).toBeGreaterThan(-1);
    expect(e.indexOf('GET')).toBeLessThan(e.indexOf('db-start:b1'));
  });
  it('X21 a resume at posting whose job is done: G, and no database start', async () => {
    seedBot({ postgres: true });
    await cutAt({ at: 'POST:', when: 'after' }, 'file');
    expect(rec().phase).toBe('posting');
    m.sidecar[FLEET_DB.containerName] = false;
    m.dbStart = { success: false, error: 'volume damaged' };
    m.bot.script = [{ state: 'done', stage: 'switching' }];
    await resume();
    expect(last().outcome).toBe('done');
    expect(since()).not.toContain('db-start:b1');
  });
  /** parkOwn with docker showing the database restarting (D102) and its start failing. */
  const parkOwnR = async () => {
    await parkOwn();
    m.sidecar[FLEET_DB.containerName] = 'restarting';
    m.dbStart = { success: false, error: 'database did not become ready within 30 seconds' };
  };
  const NOT_READY = 'database did not become ready within 30 seconds';
  it('W1, X21 failed (restarting twin): F9 starts the restarting database, and the record closes with the restarting tail, no block', async () => {
    await parkOwnR();
    const jobId = rec().jobId;
    m.bot.script = [{ state: 'failed', stage: 'copying', error: 'disk full' }];
    await pressFile();
    expect(last().outcome).toBe('failed');
    expect(last().text).toBe(FAILED_FILE(jobId) + DOWN_F_R(NOT_READY));
    const e = since();
    expect(e.indexOf('GET')).toBeGreaterThan(-1);
    expect(e.indexOf('GET')).toBeLessThan(e.indexOf('db-start:b1'));
    expect(e).not.toContain('login-block');
    expect(rec()).toBeUndefined();
  });
  it('W1, F9 at closing (restarting twin): a record parked at closing closes with the restarting tail, no block', async () => {
    seedBot({ postgres: true });
    m.bots.b1.migrate = { to: 'file', from: 'postgres', destination: null, companion: false, jobId: 'mgr-f', jobIds: ['mgr-f'], posted: true, started: 1, kept: 0, phase: 'waiting', resumeAt: 'closing', loginOpened: true, sharers: [], sharersStopped: [], isolated: true, openedAt: 'x',
      text: FAILED_FILE('mgr-f') + " The bot's database login, which the migration opened, could not be blocked again (container is not running), so the migration stays open with the login open; press Migrate to block it again." };
    m.sidecar[FLEET_DB.containerName] = 'restarting';
    m.dbStart = { success: false, error: NOT_READY };
    m.login.canLogin = true;
    await pressFile();
    expect(last()).toMatchObject({ outcome: 'failed' });
    expect(last().text).toBe(FAILED_FILE('mgr-f') + DOWN_F_R(NOT_READY));
    expect(m.events).toContain('db-start:b1');
    expect(m.events).not.toContain('login-block');
    expect(rec()).toBeUndefined();
  });
  it('W1, F9 a move to Postgres (restarting twin): the restarting tail, the GET, attach and start in order, no block', async () => {
    seedBot();
    m.login = { inRecovery: false, canLogin: false, sessions: 0 };
    m.bot.getQueue.push(null, null, http(401, { success: false, error: 'bad token' }));
    expect(await runMigration('b1', 'postgres', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'following', loginOpened: true });
    const jobId = rec().jobId;
    m.sidecar[FLEET_DB.containerName] = 'restarting';
    m.dbStart = { success: false, error: NOT_READY };
    mark = m.events.length;
    m.bot.script = [{ state: 'failed', stage: 'copying', error: 'disk full' }];
    expect(await runMigration('b1', 'postgres', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
    expect(last()).toMatchObject({ outcome: 'failed' });
    expect(last().text).toBe(`Migration ${jobId} failed at copying: disk full. Nothing was switched: the bot stays in Maintenance and keeps its data in its JSON files.` + DOWN_P_R(NOT_READY));
    const e = since();
    expect(e.indexOf('GET')).toBeGreaterThan(-1);
    expect(e.indexOf('GET')).toBeLessThan(e.indexOf('attach'));
    expect(e.indexOf('attach')).toBeLessThan(e.indexOf('db-start:b1'));
    expect(e).not.toContain('login-block');
  });
  it('W1, X22 with the bot stopped and its job failing (restarting): the bot starts before the first GET, and F closes with the restarting tail', async () => {
    await parkOwnR();
    m.app.b1 = false;
    m.bot.down = true;
    m.start = () => { m.bot.down = false; return { success: true }; };
    m.bot.script = [{ stage: 'copying' }, { state: 'failed', stage: 'copying', error: 'disk full' }];
    await pressFile();
    const e = since();
    expect(e.indexOf('start:migrate')).toBeGreaterThan(-1);
    expect(e.indexOf('start:migrate')).toBeLessThan(e.indexOf('GET'));
    expect(last().outcome).toBe('failed');
    expect(last().text).toBe(FAILED_FILE(rec0Job()) + DOWN_F_R(NOT_READY));
  });
  it('W1, F9 on a restarting database that comes up: the start, then the block and the session end, and the failure text alone', async () => {
    await parkOwnR();
    m.dbStart = { success: true };
    const jobId = rec().jobId;
    m.bot.script = [{ state: 'failed', stage: 'copying', error: 'disk full' }];
    await pressFile();
    const e = since();
    expect(e.indexOf('db-start:b1')).toBeGreaterThan(-1);
    expect(e.indexOf('db-start:b1')).toBeLessThan(e.indexOf('login-block'));
    expect(e.indexOf('login-block')).toBeLessThan(e.indexOf('login-end'));
    expect(last().text).toBe(FAILED_FILE(jobId));
  });
  it('(pin) W1, X21 done with the database restarting: G, and no database start', async () => {
    await parkOwnR();
    m.bot.script = [{ state: 'done', stage: 'switching' }];
    await pressFile();
    expect(last().outcome).toBe('done');
    expect(since()).not.toContain('db-start:b1');
  });
  it('(pin) W1, X22 done with the database restarting: G, and no database start', async () => {
    await parkOwnR();
    m.app.b1 = false;
    m.bot.down = true;
    m.start = () => { m.bot.down = false; return { success: true }; };
    m.bot.script = [{ state: 'done', stage: 'switching' }];
    await pressFile();
    expect(last().outcome).toBe('done');
    expect(since()).not.toContain('db-start:b1');
  });
  it('(pin) W1, X21 at posting done with the database restarting: G, and no database start', async () => {
    seedBot({ postgres: true });
    await cutAt({ at: 'POST:', when: 'after' }, 'file');
    expect(rec().phase).toBe('posting');
    m.sidecar[FLEET_DB.containerName] = 'restarting';
    m.dbStart = { success: false, error: NOT_READY };
    m.bot.script = [{ state: 'done', stage: 'switching' }];
    await resume();
    expect(last().outcome).toBe('done');
    expect(since()).not.toContain('db-start:b1');
  });
  it('X26 a running job on a restarting database: the GET, then the start, whose failure parks with MG-DB-START-WAIT, and no renewal', async () => {
    await parkOwnR();
    const jobId = rec().jobId;
    m.bot.script = [{ stage: 'copying' }];
    await pressFile();
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'following' });
    expect(rec().text).toBe(`Migration ${jobId} is not finished, and the bot's database could not be started (database did not become ready within 30 seconds). The bot stays in Maintenance with the migration open; press Migrate to try again.`);
    const e = since();
    expect(e.indexOf('GET')).toBeGreaterThan(-1);
    expect(e.indexOf('GET')).toBeLessThan(e.indexOf('db-start:b1'));
    expect(e).not.toContain('hba-refresh');
  });
  it('X26 the database comes up on its start: the GET, the start, the renewal, then the follow, done', async () => {
    await parkOwnR();
    m.dbStart = { success: true };
    m.bot.script = [{ stage: 'copying' }, { state: 'done', stage: 'switching' }];
    await pressFile();
    const e = since();
    expect(e.indexOf('GET')).toBeGreaterThan(-1);
    expect(e.indexOf('GET')).toBeLessThan(e.indexOf('db-start:b1'));
    expect(e.indexOf('db-start:b1')).toBeLessThan(e.indexOf('hba-refresh'));
    expect(e.indexOf('hba-refresh')).toBeLessThan(e.lastIndexOf('GET'));
    expect(last().outcome).toBe('done');
  });
  it('X26 docker still shows the database restarting after its start: the record waits with MG-FENCE-WAIT naming MG-WHY-DB-DOWN, no renewal', async () => {
    await parkOwnR();
    const jobId = rec().jobId;
    Object.defineProperty(m.sidecar, FLEET_DB.containerName, { get: () => 'restarting', set: () => {}, enumerable: true, configurable: true });
    m.dbStart = { success: true };
    m.bot.script = [{ stage: 'copying' }];
    await pressFile();
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'following' });
    expect(rec().text).toBe(MG_FENCE_WAIT(jobId, MG_WHY_DB_DOWN('restarting')));
    expect(since()).toContain('db-start:b1');
    expect(since()).not.toContain('hba-refresh');
  });
  it('X23 a press on a fenced record at following with the bot running: the lines renewed before the first GET, never written anew', async () => {
    await parkOwn();
    m.sidecar[FLEET_DB.containerName] = true;
    m.bot.script = [{ state: 'done', stage: 'switching' }];
    await pressFile();
    const e = since();
    expect(e.indexOf('hba-refresh')).toBeGreaterThan(-1);
    expect(e.indexOf('hba-refresh')).toBeLessThan(e.indexOf('GET'));
    expect(e).not.toContain('hba-fence');
  });
  it("X23 after M1b's start: the start, then the renewal, then the follow's GET", async () => {
    await parkOwn();
    m.sidecar[FLEET_DB.containerName] = true;
    m.app.b1 = false;
    m.bot.down = true;
    m.start = () => { m.bot.down = false; return { success: true }; };
    m.bot.script = [{ state: 'done', stage: 'switching' }];
    await pressFile();
    expect(last().outcome).toBe('done');
    const e = since();
    expect(e.indexOf('start:migrate')).toBeGreaterThan(-1);
    expect(e.indexOf('start:migrate')).toBeLessThan(e.indexOf('hba-refresh'));
    expect(e.lastIndexOf('GET')).toBeGreaterThan(e.indexOf('hba-refresh'));
  });
  it('X23 the renewal fails: the record waits at following with MG-FENCE-WAIT, and no GET after it', async () => {
    await parkOwn();
    m.sidecar[FLEET_DB.containerName] = true;
    const why = 'pg_hba.conf could not be rewritten (Read-only file system)';
    m.fenceUp = (refresh) => (refresh ? why : null);
    m.bot.script = [{ stage: 'copying' }];
    await pressFile();
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'following' });
    expect(rec().text).toBe(MG_FENCE_WAIT(rec().jobId, why));
    const e = since();
    expect(e.indexOf('hba-refresh')).toBeGreaterThan(-1);
    expect(e.slice(e.indexOf('hba-refresh'))).not.toContain('GET');
  });
  it("X25 a crash before the fence's lines: the resume writes the same owner's lines once, and the lane lifts them", async () => {
    seedBot({ postgres: true });
    await cutAt({ at: 'hba-fence', when: 'before' }, 'file');
    expect(rec().phase).toBe('preparing');
    expect(rec().hbaFence).toMatch(/^migrate:\d+$/);
    const owner = rec().hbaFence;
    await resume();
    expect(last().outcome).toBe('done');
    expect(since().filter(e => e === 'hba-fence')).toHaveLength(1);
    const owners = m.migrateWrites.map(w => w.rec?.hbaFence).filter(Boolean);
    expect(owners.length).toBeGreaterThan(0);
    expect(owners.every(o => o === owner)).toBe(true);
    expect(since()).toContain('hba-lift');
  });
  it("X25 a crash after G21's lift: the resume lifts once more, then stores the Data Backend, and the lane ends done", async () => {
    seedBot({ postgres: true });
    m.bot.script = [{ state: 'done', stage: 'switching' }];
    await cutAt({ at: 'hba-lift', when: 'after' }, 'file');
    expect(rec().phase).toBe('finishing');
    expect(rec().hbaFence).toMatch(/^migrate:\d+$/);
    await resume();
    const e = since();
    expect(e.filter(x => x === 'hba-lift')).toHaveLength(1);
    expect(e.indexOf('hba-lift')).toBeLessThan(e.indexOf('env-inop:{"DATA_BACKEND":"file"}'));
    expect(last().outcome).toBe('done');
  });
  const rec0Job = () => m.bot.posts[0].jobId;
  it('X11 waiting: no resume', async () => {
    seedBot();
    m.bots.b1.migrate = base({ phase: 'waiting', resumeAt: 'following' });
    await resume();
    expect(m.events).toEqual([]);
  });
  it('X15 shutting down mid-lane: the lane returns with the record as last written', async () => {
    seedBot();
    m.saveAnswers.push(() => { m.shuttingDown = true; return { ok: true, status: 200, body: { success: true, saved: true } }; });
    await runMigration('b1', 'postgres', 'press');
    await laneDone('b1');
    expect(rec().phase).toBe('preparing');
    expect(m.bot.posts).toEqual([]);
  });
  it('a crash at each durable point leaves a record the resume finishes', async () => {
    const points = ['record:preparing', 'record:posting', 'record:following', 'record:finishing', 'record:finishing:stored', 'record:finishing:applied', 'record:finishing:confirmed'];
    for (const point of points) {
      resetMigrate(); fastTiming(MIGRATE_TIMING);
      seedBot();
      let crashed = false;
      m.failMigrateWrite = (_n, r) => {
        const tag = r ? `record:${r.phase}${r.finishing ? `:${r.finishing}` : ''}` : 'record:closed';
        if (!crashed && m.events.includes(point) && tag !== point) { crashed = true; m.shuttingDown = true; }
        return null;
      };
      await runMigration('b1', 'postgres', 'press');
      await laneDone('b1');
      m.shuttingDown = false;
      m.failMigrateWrite = () => null;
      if (rec()?.phase && rec().phase !== 'waiting') await resume();
      expect(last()?.outcome, point).toBe('done');
      expect(m.env.b1.DATA_BACKEND, point).toBe('postgres');
    }
  });
});

describe('Y: the bot', () => {
  it('Y3 the bot answers a POST for an earlier job: its jobId is followed (case 1 of the fake S0 order)', async () => {
    seedBot();
    m.bot.journal.push({ jobId: 'mgr-old', to: 'postgres', state: 'done', stage: 'switching', destination: { host: 'b1-fleet-postgres', port: 5432, database: 'smdb' } });
    await runMigration('b1', 'postgres', 'press');
    await laneDone('b1');
    expect(last()).toMatchObject({ outcome: 'done', jobId: 'mgr-old' });
    expect(m.bot.journal).toHaveLength(1);
  });
  it('Y4 the bot is down at M4: MG-UNSAVED-UNKNOWN', async () => {
    seedBot();
    for (let i = 0; i < 6; i++) m.saveAnswers.push({ ok: false, error: 'maintenance unreachable' });
    await runMigration('b1', 'postgres', 'press');
    await laneDone('b1');
    expect(last().text).toMatch(/did not confirm that it saved every change it holds \(the bot could not be reached: maintenance unreachable\)/);
  });
});
