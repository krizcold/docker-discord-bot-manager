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
import { botGet, fastTiming, http, m, resetMigrate, seedBot, seedSharer, FLEET_DB, COMPANION_URL, EXTERNAL_URL, MG_FENCE_BACK_G, MG_FENCE_STRIPPED, MG_FENCE_UNCONFIRMED, MG_SHARERS_RUN, MG_SHARERS_STAY, MG_SHARERS_UNSURE, MG_WHY_RESTARTING, WHY_LIFT_LOCKED } from './migrate-fake';
import { fenceWords } from '../../src/instance/maintenance';

beforeEach(() => { resetMigrate(); fastTiming(MIGRATE_TIMING); });

const rec = () => m.bots.b1.migrate;
const last = () => m.bots.b1.migrateLast;
const at = (e: string) => m.events.findIndex(x => x.startsWith(e));

async function press(to: 'postgres' | 'file' = 'postgres') {
  expect(await runMigration('b1', to, 'press')).toEqual({ accepted: true });
  await laneDone('b1');
}

describe('G: done', () => {
  it('G1, G4 to G10, G14: D1 before D2 before D3 before D4, then the close', async () => {
    seedBot();
    await press();
    expect(at('record:finishing')).toBeGreaterThan(-1);
    expect(at('env-inop:{"DATA_BACKEND":"postgres"}')).toBeGreaterThan(-1);
    expect(at('env-inop:{"DATA_BACKEND":"postgres"}')).toBeLessThan(at('record:finishing:stored'));
    expect(at('record:finishing:stored')).toBeLessThan(m.events.lastIndexOf('stop:migrate'));
    expect(at('record:finishing:applied')).toBeLessThan(at('env-read'));
    expect(at('env-read')).toBeLessThan(at('record:finishing:confirmed'));
    expect(at('record:finishing:confirmed')).toBeLessThan(at('order:running:migrate'));
    expect(at('order:running:migrate')).toBeLessThan(at('record:closed'));
    expect(last().text).toBe(`The data moved to Postgres at b1-fleet-postgres:5432/smdb (migration ${last().jobId}), and the bot's Data Backend is now Postgres. The JSON files stay in the bot's data folder. The bot is running normally.`);
  });
  it('G6 attaches and starts the companion before the restart', async () => {
    seedBot();
    await press();
    const fin = at('record:finishing:stored');
    const attach = m.events.indexOf('attach', fin);
    const db = m.events.indexOf('db-start:b1', fin);
    const stop = m.events.indexOf('stop:migrate', fin);
    expect(attach).toBeGreaterThan(fin);
    expect(attach).toBeLessThan(db);
    expect(db).toBeLessThan(stop);
  });
  it('G2 the destination names the stored URL: on, with it', async () => {
    seedBot({ url: 'postgresql://u:p@db.example.test:5432/app' });
    m.bot.destination = { host: 'db.example.test', port: 5432, database: 'app' };
    await press();
    expect(last().outcome).toBe('done');
  });
  it('G3 neither: P with awaiting destination and MG-DEST; DATA_BACKEND unchanged', async () => {
    seedBot();
    m.bot.destination = { host: 'elsewhere.example', port: 5432, database: 'smdb' };
    await press();
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'following', awaiting: 'destination' });
    expect(rec().text).toBe(`Migration ${rec().jobId} is done, but the manager can't confirm which database the copy went to: the bot names elsewhere.example:5432/smdb, and the manager passed b1-fleet-postgres:5432/smdb. The bot stays in Maintenance and its Data Backend is unchanged. Set the Database URL to the database the copy went to, then press Migrate.`);
    expect(m.env.b1.DATA_BACKEND).toBe('file');
  });
  it('G4 the finishing write fails: the lane stops', async () => {
    seedBot();
    m.failMigrateWrite = (_n, r) => (r?.phase === 'finishing' && !r.finishing ? 'disk full' : null);
    await press();
    expect(m.env.b1.DATA_BACKEND).toBe('file');
    expect(rec().phase).toBe('following');
  });
  it('G5 the store write throws: P at finishing with MG-ENVSTORE', async () => {
    seedBot();
    m.failUpdateBot = 'store locked';
    await press();
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'finishing' });
    expect(rec().text).toMatch(/moved the data to Postgres at b1-fleet-postgres:5432\/smdb, but the new Data Backend could not be stored \(store locked\)/);
  });
  it('G6 the restart fails: MG-APPLY', async () => {
    seedBot();
    let n = 0;
    m.start = () => (++n === 2 ? { success: false, error: 'compose up failed' } : { success: true });
    await press();
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'finishing', finishing: 'stored' });
    expect(rec().text).toMatch(/the restart that applies it failed \(compose up failed\)/);
  });
  it('G7b the companion is not running after the restart: back to stored; no running hook', async () => {
    seedBot();
    m.dbStart = { success: true };
    const orig = m.sidecar;
    m.sidecar = new Proxy(orig, { get: (t, k) => (m.events.includes('env-read') ? false : t[k as string] ?? true) }) as any;
    await press();
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'finishing', finishing: 'stored' });
    expect(rec().text).toMatch(/but the managed database is not running after the restart\. The bot stays in Maintenance; press Migrate to start it and apply again\.$/);
    expect(m.events).not.toContain('order:running:migrate');
  });
  it('G8 a mismatch: MG-ENV with the value read; no running hook', async () => {
    seedBot();
    m.containerEnv = { ok: true, env: { DATA_BACKEND: 'file', DATA_BACKEND_URL: COMPANION_URL } };
    await press();
    expect(rec().text).toMatch(/after the restart the bot's container reads DATA_BACKEND=file, and its Database URL names b1-fleet-postgres:5432\/smdb \(the start reported no error\)/);
    expect(m.events).not.toContain('order:running:migrate');
  });
  it('G9 docker does not answer: MG-ENV-DOCKER', async () => {
    seedBot();
    m.containerEnv = { ok: false, error: 'docker inspect timed out' };
    await press();
    expect(rec().text).toMatch(/docker did not say what the bot's container reads after the restart \(docker inspect timed out\)/);
    expect(m.events).not.toContain('order:running:migrate');
  });
  it('G11 the order does not settle: the record closes anyway with its text', async () => {
    seedBot();
    m.order = { settled: false, text: 'Running is not confirmed: the hook did not answer.' };
    await press();
    expect(rec()).toBeUndefined();
    expect(last().text).toMatch(/ Running is not confirmed: the hook did not answer\.$/);
  });
  it('G12 the order refused: W-RUNNING', async () => {
    seedBot();
    m.order = { refused: true, error: 'A restore notice stands' };
    await press();
    expect(last().text).toMatch(/ The bot stays in Maintenance: A restore notice stands\. Choose Running in State\.$/);
  });
  it('G13 the close save fails: the record stays at confirmed; a press runs D4 again and closes', async () => {
    seedBot();
    m.failMigrateWrite = (_n, r) => (r === null ? 'disk full' : null);
    await press();
    expect(rec()).toMatchObject({ phase: 'finishing', finishing: 'confirmed' });
    m.failMigrateWrite = () => null;
    m.bots.b1.maintenance = { ...m.bots.b1.maintenance, state: 'running' };
    await press();
    expect(rec()).toBeUndefined();
    expect(m.events.filter(e => e === 'order:running:migrate')).toHaveLength(2);
  });
  it('G14 to file: the sharers stay stopped and are named', async () => {
    seedBot({ postgres: true });
    seedSharer('s1');
    await press('file');
    expect(last().text).toMatch(/^The data moved to JSON files \(migration .*\), and the bot's Data Backend is now JSON files\. The database keeps the old data, renamed aside\. S1 uses the old database and stays stopped/);
    expect(m.events).not.toContain('start-sharer:s1');
    expect(m.env.b1.DATA_BACKEND).toBe('file');
    expect(m.env.b1.DATA_BACKEND_URL).toBe(COMPANION_URL);
  });
  it('left out items are named', async () => {
    seedBot();
    m.bot.script = [{ state: 'done', stage: 'switching', leftOut: ['a', 'b'] }];
    await press();
    expect(last().text).toMatch(/The copy left out 2 item\(s\) it could not place/);
  });
  it('a finished move to JSON from the companion whose G6 start drops the companion closes without waiting for it (R3-A2)', async () => {
    seedBot({ postgres: true });
    m.dbReady = true;
    let afterStore = false;
    m.start = () => { if (m.env.b1.DATA_BACKEND === 'file') afterStore = true; return { success: true }; };
    const origReady = m.dbReady;
    await press('file');
    expect(afterStore).toBe(true);
    const fin = at('record:finishing:stored');
    expect(m.events.slice(fin).some(e => e.startsWith('db-ready'))).toBe(false);
    expect(last().outcome).toBe('done');
    expect(origReady).toBe(true);
    expect(FLEET_DB.containerName).toBe('b1-fleet-postgres');
  });
});

describe('G12: round 1', () => {
  const after = (x: string, y: string) => m.events.lastIndexOf(x) > m.events.lastIndexOf(y);
  it('R7 a move to file with the login M3 opened and Running refused: block, end, read back after the order, before the close', async () => {
    seedBot({ postgres: true });
    m.order = { refused: true, error: 'A restore notice stands' };
    await press('file');
    expect(m.events).toContain('login-open');
    const e = m.events;
    const order = e.indexOf('order:running:migrate');
    expect(e.indexOf('login-block', order)).toBeGreaterThan(order);
    expect(e.indexOf('login-end', order)).toBeGreaterThan(e.indexOf('login-block', order));
    expect(e.lastIndexOf('login-read')).toBeGreaterThan(e.indexOf('login-end', order));
    expect(e.indexOf('record:closed')).toBeGreaterThan(e.lastIndexOf('login-read'));
    expect(m.login.canLogin).toBe(false);
    expect(last()).toMatchObject({ outcome: 'done' });
    expect(last().text).toMatch(/ The bot stays in Maintenance: A restore notice stands\. Choose Running in State\.$/);
  });
  it('G12b the block fails: the record waits at finishing confirmed with MG-LOGIN-BACK-DONE; a press with Running admitted closes done with no block', async () => {
    seedBot({ postgres: true });
    m.order = { refused: true, error: 'A restore notice stands' };
    m.blockResult = { ok: false, cls: 'other', error: 'role locked' };
    await press('file');
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'finishing', finishing: 'confirmed' });
    expect(rec().text).toMatch(/^The data moved to JSON files \(migration mgr-[^)]+\), and the bot's Data Backend is now JSON files\. The database keeps the old data, renamed aside\. The bot stays in Maintenance: A restore notice stands\. The bot's database login, which the migration opened, could not be blocked again \(role locked\), so the migration stays open with the login open; press Migrate: it asks for Running again, and blocks the login again if Running is still refused\.$/);
    expect(rec().text).not.toMatch(/Choose Running in State/);
    m.blockResult = { ok: true };
    m.order = { settled: true, text: 'The bot is running normally.' };
    m.events = [];
    await press('file');
    expect(m.events).not.toContain('login-block');
    expect(rec()).toBeUndefined();
    expect(last()).toMatchObject({ outcome: 'done' });
  });
  it('G12b then a press whose Running is refused again and whose block passes closes done with W-RUNNING', async () => {
    seedBot({ postgres: true });
    m.order = { refused: true, error: 'A restore notice stands' };
    m.blockResult = { ok: false, cls: 'other', error: 'role locked' };
    await press('file');
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'finishing' });
    m.blockResult = { ok: true };
    m.events = [];
    await press('file');
    expect(rec()).toBeUndefined();
    expect(last()).toMatchObject({ outcome: 'done' });
    expect(last().text).toMatch(/ The bot stays in Maintenance: A restore notice stands\. Choose Running in State\.$/);
    expect(m.events.indexOf('login-block')).toBeGreaterThan(-1);
    expect(m.events.indexOf('login-block')).toBeLessThan(m.events.indexOf('record:closed'));
  });
  it('G10 and G11 with the login opened: no block', async () => {
    seedBot({ postgres: true });
    await press('file');
    expect(after('login-block', 'order:running:migrate')).toBe(false);
    resetMigrate(); fastTiming(MIGRATE_TIMING);
    seedBot({ postgres: true });
    m.order = { settled: false, text: 'Running is not confirmed: the hook did not answer.' };
    await press('file');
    expect(m.events.indexOf('login-block', m.events.indexOf('order:running:migrate'))).toBe(-1);
    expect(last()).toMatchObject({ outcome: 'done' });
  });
});

describe('G: the destination the job names (round 4)', () => {
  it('G18 a destination in another instance\'s managed database container: F with MG-DEST-HOSTED, nothing switched', async () => {
    seedBot({ url: EXTERNAL_URL });
    m.bots.s2 = { id: 's2', displayName: 'S2', sanitizedName: 's2', sourceUrl: m.bots.b1.sourceUrl, envVars: {}, status: 'running', createdAt: 'x', updatedAt: 'x', fleetDb: { containerName: 's2-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'v' } };
    m.env.s2 = { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: 'postgresql://smdb:pw@s2-fleet-postgres:5432/smdb' };
    m.bot.destination = { host: 's2-fleet-postgres', port: 5432, database: 'b1data' };
    await press('postgres');
    const jobId = m.bot.posts[0].jobId;
    expect(last()).toMatchObject({ outcome: 'failed' });
    expect(last().text).toBe(`Migration ${jobId} is done, and the bot names s2-fleet-postgres:5432/b1data as the database the copy went to, which is in S2's managed database container. Migrate does not move a bot onto another bot's managed database, so the migration was closed with the Data Backend unchanged, and the bot stays in Maintenance. The JSON files keep the data as it was before the copy, but after this migration the bot refuses to boot on them; it boots on the copy once its Data Backend is postgres and its Database URL names s2-fleet-postgres:5432/b1data.`);
    expect(m.events).not.toContain('env-inop:{"DATA_BACKEND":"postgres"}');
    expect(m.env.b1.DATA_BACKEND).toBe('file');
    expect(m.bots.b1.migrate).toBeUndefined();
  });
  it('G19 a destination in the bot\'s own container set at a park: the finishing save writes companion: true, and G6 starts and waits for it', async () => {
    seedBot({ url: EXTERNAL_URL });
    m.bots.b1.fleetDb = { ...FLEET_DB };
    m.bot.destination = { host: 'b1-fleet-postgres', port: 5432, database: 'smdb' };
    await press('postgres');
    expect(m.bots.b1.migrate).toMatchObject({ phase: 'waiting', awaiting: 'destination', companion: false });
    m.env.b1.DATA_BACKEND_URL = COMPANION_URL;
    const mark = m.events.length;
    const writes = m.migrateWrites.length;
    await press('postgres');
    expect(m.migrateWrites.slice(writes).some(w => w.rec?.phase === 'finishing' && w.rec.companion === true)).toBe(true);
    const e = m.events.slice(mark);
    const env = e.findIndex(x => x.startsWith('env-inop:'));
    expect(env).toBeGreaterThan(-1);
    const stop = e.indexOf('stop:migrate', env);
    expect(stop).toBeGreaterThan(env);
    for (const step of ['attach', 'db-start:b1']) {
      const i = e.indexOf(step, env);
      expect(i, step).toBeGreaterThan(env);
      expect(i, step).toBeLessThan(stop);
    }
    const start = e.indexOf('start:migrate', stop);
    expect(start).toBeGreaterThan(stop);
    expect(e.indexOf('db-ready:b1-fleet-postgres', start)).toBeGreaterThan(start);
    expect(last().outcome).toBe('done');
    expect(m.bots.b1.migrate).toBeUndefined();
  });
});

describe('G20: a destination in the bot\'s own managed database while the record has companion: false (round 5)', () => {
  const OWN = 'b1-fleet-postgres:5432/smdb';
  const DEST_OWN = (jobId: string, why: string, retiring = false) => `Migration ${jobId} is done, and the bot names ${OWN}, this bot's own managed database, as the database the copy went to, but ${why}, so Migrate does not move the bot onto it: the migration was closed with the Data Backend unchanged, and the bot stays in Maintenance.${retiring ? ' The JSON files keep the data as it was before the copy, but after this migration the bot refuses to boot on them, and no bot starts on a database whose removal did not finish; running the decommission or the re-seed again finishes the removal and deletes the copy.' : ` The JSON files keep the data as it was before the copy, but after this migration the bot refuses to boot on them; it boots on the copy once its Data Backend is postgres and its Database URL names ${OWN}.`}`;
  const FENCE = { ok: true, on: true, owner: null, persisted: true };
  const closedUnchanged = (why: string, retiring = false) => {
    expect(last()).toMatchObject({ outcome: 'failed' });
    expect(last().text).toBe(DEST_OWN(m.bot.posts[0].jobId, why, retiring));
    expect(m.events).not.toContain('attach');
    expect(m.events).not.toContain('env-inop:{"DATA_BACKEND":"postgres"}');
    expect(m.env.b1.DATA_BACKEND).toBe('file');
    expect(rec()).toBeUndefined();
  };
  const cases: Array<[string, () => void, () => string]> = [
    ['being removed', () => { m.bots.b1.fleetDb = { ...FLEET_DB, retiringAt: '2026-10-30T00:00:00.000Z' }; }, () => 'that database is being removed (since 2026-10-30T00:00:00.000Z)'],
    ['a restore notice', () => { m.bots.b1.fleetDb = { ...FLEET_DB }; m.notices.b1 = 'pre-x.dump'; }, () => 'a restore of pre-x.dump into that database has not finished cleanly'],
    ['READ-ONLY', () => { m.bots.b1.fleetDb = { ...FLEET_DB }; m.fence = { ...FENCE }; }, () => `that database is READ-ONLY (${fenceWords(FENCE as any).state})`],
  ];
  it.each(cases)('G20 (round 5) %s: F with MG-DEST-OWN, nothing switched', async (_n, arrange, why) => {
    seedBot({ url: EXTERNAL_URL });
    m.bot.destination = { host: 'b1-fleet-postgres', port: 5432, database: 'smdb' };
    arrange();
    await press('postgres');
    closedUnchanged(why(), _n === 'being removed');
  });
  it('W1, G20 restarting: F with MG-DEST-OWN and MG-WHY-RESTARTING, nothing switched', async () => {
    seedBot({ url: EXTERNAL_URL });
    m.bots.b1.fleetDb = { ...FLEET_DB };
    m.bot.destination = { host: 'b1-fleet-postgres', port: 5432, database: 'smdb' };
    m.sidecar[FLEET_DB.containerName] = 'restarting';
    await press('postgres');
    closedUnchanged(MG_WHY_RESTARTING);
  });
  it('G20 (round 5) replication on at a later press: F with MG-DEST-OWN and the replication reason', async () => {
    seedBot({ url: EXTERNAL_URL });
    m.bots.b1.fleetDb = { ...FLEET_DB };
    m.bot.destination = { host: 'b1-fleet-postgres', port: 5432, database: 'smdb' };
    m.bot.getQueue.push(null, null, http(401, { success: false, error: 'bad token' }));
    await press('postgres');
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'following' });
    m.bots.b1.fleetDb.replication = { publicHost: 'pub.example', hostPort: 5433 };
    m.bot.script = [{ state: 'done', stage: 'switching' }];
    await press('postgres');
    closedUnchanged("that database has replication on, and the manager's check of it as the fleet's main database pauses while a migration is open");
  });
  it('G20 (round 5) a fence read that fails parks at following with MG-DEST-FENCE-READ; a later press onto the companion URL closes done', async () => {
    seedBot({ url: EXTERNAL_URL });
    m.bots.b1.fleetDb = { ...FLEET_DB };
    m.bot.destination = { host: 'b1-fleet-postgres', port: 5432, database: 'smdb' };
    m.fence = { ok: false, cls: 'other', error: 'psql failed' };
    await press('postgres');
    const jobId = m.bot.posts[0].jobId;
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'following' });
    expect(rec().awaiting).toBeUndefined();
    expect(rec().text).toBe(`Migration ${jobId} is done, and the bot names ${OWN}, this bot's own managed database, as the database the copy went to, but the manager can't confirm whether that database is READ-ONLY (psql failed). The bot stays in Maintenance with the migration open; press Migrate to check again.`);
    m.fence = { ok: true, on: false };
    m.env.b1.DATA_BACKEND_URL = COMPANION_URL;
    const writes = m.migrateWrites.length;
    await press('postgres');
    expect(m.migrateWrites.slice(writes).some(w => w.rec?.phase === 'finishing' && w.rec.companion === true)).toBe(true);
    expect(last().outcome).toBe('done');
    expect(rec()).toBeUndefined();
  });
});

describe('G: round 6', () => {
  it('W1, G22: the companion restarting after G\'s restart parks with MG-ENV-DB naming it, not Running', async () => {
    seedBot();
    Object.defineProperty(m.sidecar, FLEET_DB.containerName, { get: () => (m.events.includes('env-read') ? 'restarting' : true), set: () => {}, enumerable: true, configurable: true });
    m.bot.script = [{ state: 'done', stage: 'switching' }];
    await press('postgres');
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'finishing', finishing: 'stored' });
    expect(rec().text).toMatch(/is not running after the restart: docker shows it restarting\. The bot stays in Maintenance; press Migrate to start it and apply again\.$/);
    expect(m.events).not.toContain('order:running:migrate');
  });
  it('G21 the lift fails: the record waits at finishing with MG-FENCE-BACK-G, and a press that lifts goes on to done', async () => {
    seedBot({ postgres: true });
    m.fenceLift = 'locked';
    await press('file');
    const jobId = m.bot.posts[0].jobId;
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'finishing' });
    expect(rec().finishing).toBeUndefined();
    expect(rec().text).toBe(MG_FENCE_BACK_G(jobId, 'JSON files', WHY_LIFT_LOCKED('Read-only file system')));
    expect(m.events.some(e => e.startsWith('env-inop:'))).toBe(false);
    m.fenceLift = 'lifted';
    const mark = m.events.length;
    const writes = m.migrateWrites.length;
    await press('file');
    const e = m.events.slice(mark);
    expect(e.indexOf('hba-lift')).toBeGreaterThan(-1);
    expect(e.indexOf('hba-lift')).toBeLessThan(e.indexOf('env-inop:{"DATA_BACKEND":"file"}'));
    const lift = e.indexOf('hba-lift');
    const nextWrite = e.slice(0, lift).filter(x => x.startsWith('record:')).length;
    const w = m.migrateWrites.slice(writes)[nextWrite];
    expect(w.rec).toBeTruthy();
    expect('hbaFence' in w.rec).toBe(false);
    expect(last().outcome).toBe('done');
  });
  /** The record writes before and after G6's stop (the last stop:migrate). */
  const aroundG6 = () => {
    const stop = m.events.lastIndexOf('stop:migrate');
    const before = m.events.slice(0, stop).filter(x => x.startsWith('record:')).length;
    return { before: m.migrateWrites.slice(0, before).map(w => w.rec), next: m.migrateWrites[before]?.rec };
  };
  it("G21 removed without a reload: done, and G6's stop that answered success drops fenceLift, so no MG-FENCE-STRIPPED tail", async () => {
    seedBot({ postgres: true });
    m.fenceLift = 'stripped';
    await press('file');
    expect(last().outcome).toBe('done');
    expect(last().text).not.toContain(MG_FENCE_STRIPPED);
    const g6 = aroundG6();
    expect(g6.before.some(r => r?.fenceLift === 'stripped')).toBe(true);
    expect(g6.next).toBeTruthy();
    expect('fenceLift' in g6.next).toBe(false);
  });
  it('G23 the stripped tail across a G park: the record keeps fenceLift, and a later press ends with MG-FENCE-STRIPPED', async () => {
    seedBot({ postgres: true });
    m.fenceLift = 'stripped';
    m.failUpdateBot = 'disk full';
    await press('file');
    const jobId = m.bot.posts[0].jobId;
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'finishing', fenceLift: 'stripped' });
    expect(rec().hbaFence).toBeUndefined();
    expect(rec().hbaFenceSet).toBeUndefined();
    expect(rec().text).toBe(`Migration ${jobId} moved the data to JSON files, but the new Data Backend could not be stored (disk full). The bot stays in Maintenance; press Migrate to store it again.`);
    m.failUpdateBot = null;
    await press('file');
    expect(last().outcome).toBe('done');
    expect(last().text).not.toContain(MG_FENCE_STRIPPED);
    expect(m.events.filter(e => e === 'hba-lift')).toHaveLength(1);
  });
  it("(pin) G23, G6's stop answers 'Bot is not running': the stripped tail stays", async () => {
    seedBot({ postgres: true });
    m.stop = { success: false, error: 'Bot is not running' };
    m.fenceLift = 'stripped';
    m.failUpdateBot = 'disk full';
    await press('file');
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'finishing', fenceLift: 'stripped' });
    m.failUpdateBot = null;
    await press('file');
    expect(last().outcome).toBe('done');
    expect(last().text).toContain(`The database keeps the old data, renamed aside.${MG_FENCE_STRIPPED}`);
  });
  it("(pin) G21 unconfirmed, G6's stop answers 'Bot is not running': the unconfirmed tail stays", async () => {
    seedBot({ postgres: true });
    m.stop = { success: false, error: 'Bot is not running' };
    m.fenceLift = 'unconfirmed';
    await press('file');
    expect(last().outcome).toBe('done');
    expect(last().text).toContain(`The database keeps the old data, renamed aside.${MG_FENCE_UNCONFIRMED}`);
  });
  it('G14, a sharer started outside the manager during the move: named as running at the close', async () => {
    seedBot({ postgres: true });
    seedSharer('s1');
    m.bot.getQueue.push(null, () => { m.app.s1 = true; return botGet(); });
    await press('file');
    expect(last().outcome).toBe('done');
    expect(last().text).toContain(MG_SHARERS_RUN('S1'));
    expect(last().text).not.toContain(MG_SHARERS_STAY('S1'));
  });
  it('G14 (NM16), a worker of a sharer runs at the close: named as running', async () => {
    seedBot({ postgres: true });
    seedSharer('s1');
    m.bot.getQueue.push(null, () => { m.live.s1 = ['s1-worker']; return botGet(); });
    await press('file');
    expect(m.app.s1).toBe(false);
    expect(last().text).toContain(MG_SHARERS_RUN('S1'));
    expect(last().text).not.toContain(MG_SHARERS_STAY('S1'));
  });
  it('G14 (NM16), docker silent at the close: named unsure', async () => {
    seedBot({ postgres: true });
    seedSharer('s1');
    m.bot.getQueue.push(null, () => { m.live.s1 = null; return botGet(); });
    await press('file');
    expect(last().text).toContain(MG_SHARERS_UNSURE('S1'));
  });
  it('G14 (NM16), a held sharer deleted before the close is left out of the done text', async () => {
    seedBot({ postgres: true });
    seedSharer('s1');
    m.bot.getQueue.push(null, () => { delete m.bots.s1; m.live.s1 = null; return botGet(); });
    await press('file');
    expect(last().outcome).toBe('done');
    expect(last().text).not.toMatch(/s1 /i);
    expect(last().text).not.toContain('old database and');
  });
  it("G21 unconfirmed: done, and G6's stop that answered success drops the tail, so no MG-FENCE-UNCONFIRMED", async () => {
    seedBot({ postgres: true });
    m.fenceLift = 'unconfirmed';
    await press('file');
    expect(last().outcome).toBe('done');
    expect(last().text).not.toContain(MG_FENCE_UNCONFIRMED);
  });
});
