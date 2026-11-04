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
import { APP_CAPABILITIES } from '../../src/config/appCapabilities';
import { fastTiming, getJob, http, m, noAnswer, refusal, resetMigrate, seedBot, COMPANION_URL, EXTERNAL_URL, FLEET_DB, MG_FLEET_REPL_ON, MG_URL_FORM_A, URL_FORM_CLAUSE } from './migrate-fake';

beforeEach(() => { resetMigrate(); fastTiming(MIGRATE_TIMING); });

async function press(to: unknown, id = 'b1') {
  const a = await runMigration(id, to, 'press');
  await laneDone(id);
  return a;
}

/** Nothing changed: no record, no env write, no docker, no hook but the admission GET. */
function nothingChanged(getAllowed = false) {
  expect(m.migrateWrites).toEqual([]);
  expect(m.events.filter(e => e.startsWith('env:') || e.startsWith('stop') || e.startsWith('start') || e.startsWith('POST') || e === 'hook:maintenance' || e.startsWith('login') || e.startsWith('db-'))).toEqual([]);
  if (!getAllowed) expect(m.bot.gets).toBe(0);
}

describe('A: admission refusals change nothing', () => {
  const cases: Array<[string, () => void, unknown, number, RegExp]> = [
    ['A1 shutting down', () => { m.shuttingDown = true; }, 'postgres', 503, /shutting down/],
    ['A3 a bad target', () => {}, 'mysql', 400, /must be postgres or file/],
    ['A4 no companionDb', () => { m.bots.b1.sourceUrl = 'https://github.com/x/plain-bot'; }, 'postgres', 409, /no Data Backend setting/],
    ['A6 an op lock', () => { m.lock.b1 = 'build'; }, 'postgres', 409, /Operation 'build' already in progress/],
    ['A7 a database hold', () => { m.hold = true; }, 'postgres', 409, /Migrate is refused until it ends/],
    ['A7 a delete lane', () => { m.deleteLane = true; }, 'postgres', 409, /Delete of this instance did not finish/],
    ['A10 a corrupt env store', () => { m.envStatus.corrupt = true; }, 'postgres', 409, /env store for this instance cannot be read/],
    ['A10 the URL key undecryptable', () => { m.envStatus.undecryptable = ['DATA_BACKEND_URL']; }, 'postgres', 409, /env store/],
    ['A11 the same backend', () => {}, 'file', 409, /already JSON files/],
    ['A12 a list', () => { m.env.b1.DATA_BACKEND_URL = `${EXTERNAL_URL},postgresql://u:p@b.example:5432/app`; }, 'postgres', 409, /lists several database addresses/],
    ['A14 a bad URL', () => { m.env.b1.DATA_BACKEND_URL = 'mysql://x@y/z'; }, 'postgres', 409, /not a postgresql:\/\/ address/],
    ['A15 retiring', () => { m.bots.b1.fleetDb = { containerName: 'b1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'v', retiringAt: '2026-10-30' }; }, 'postgres', 409, /being removed/],
    ['A16 Running', () => { m.bots.b1.maintenance = { ...m.bots.b1.maintenance, state: 'running' }; }, 'postgres', 409, /choose Maintenance in State first/],
    ['A17 Off', () => { m.bots.b1.maintenance = { ...m.bots.b1.maintenance, state: 'off' }; }, 'postgres', 409, /The bot is Off/],
    ['A18 not settled', () => { m.bots.b1.maintenance = { ...m.bots.b1.maintenance, settled: false, lastError: 'the hook did not answer' }; }, 'postgres', 409, /not confirmed yet \(the hook did not answer\)/],
    ['A19 docker silent', () => { m.app.b1 = null; }, 'postgres', 409, /Docker did not say/],
    ['A20 stopped', () => { m.app.b1 = false; }, 'postgres', 409, /The bot is stopped/],
    ['A24 a seed', () => { m.seed = { startedAt: 'x' }; }, 'postgres', 409, /live copy seed is running/],
    ['A32 joined', () => { m.bots.b1.fleetJoin = { code: 'c' }; }, 'postgres', 409, /joined another machine's database/],
    ['A34 the tick on this bot', () => { m.tickOn = 'b1'; }, 'postgres', 409, /check of this bot's main database is running/],
  ];
  it.each(cases)('%s', async (_n, arrange, to, status, text) => {
    seedBot();
    arrange();
    const a = await press(to);
    expect(a).toMatchObject({ accepted: false, status });
    expect((a as any).error).toMatch(text);
    nothingChanged(_n.startsWith('A34'));
  });

  it('A5 an app with a companion database and no hooks: MG-NOHOOKS', async () => {
    APP_CAPABILITIES.unshift({ match: { urlContains: 'hookless-app' }, companionDb: APP_CAPABILITIES[0].companionDb });
    try {
      seedBot({ inst: { sourceUrl: 'https://github.com/x/hookless-app' } });
      const a = await press('postgres');
      expect(a).toEqual({ accepted: false, status: 409, error: 'This app declares no lifecycle hooks, so the manager cannot ask it to migrate its data; nothing was changed' });
      nothingChanged();
    } finally {
      APP_CAPABILITIES.shift();
    }
  });
  it('A2 no bot', async () => {
    expect(await press('postgres', 'zz')).toMatchObject({ accepted: false, status: 404, error: 'Bot not found' });
  });
  it('A13 a join code', async () => {
    seedBot({ url: 'smdbjoin1.' + 'A'.repeat(80) });
    expect(await press('postgres')).toMatchObject({ status: 409, error: expect.stringMatching(/holds a join code the manager has not checked/) });
    nothingChanged();
  });
  it('A21 a restore notice on the managed database', async () => {
    seedBot({ postgres: true });
    m.notice = 'pre-x.dump';
    expect(await press('file')).toMatchObject({ status: 409, error: expect.stringMatching(/A restore of pre-x.dump has not finished cleanly/) });
    nothingChanged();
  });
  it('A22 a read-only layer, and a fence read that fails', async () => {
    seedBot({ postgres: true });
    m.fence = { ok: true, on: true, owner: null, persisted: true };
    expect(await press('file')).toMatchObject({ status: 409, error: expect.stringMatching(/READ-ONLY/) });
    m.fence = { ok: false, cls: 'other', error: 'psql failed' };
    expect(await press('file')).toMatchObject({ status: 409, error: expect.stringMatching(/can't confirm whether the bot's database is READ-ONLY \(psql failed\)/) });
    nothingChanged();
  });
  it('A32 replication on refuses a move to JSON files', async () => {
    seedBot({ postgres: true });
    m.bots.b1.fleetDb.replication = { publicHost: 'pub.example', hostPort: 5433 };
    expect(await press('file')).toMatchObject({ status: 409, error: expect.stringMatching(/replication on/) });
  });

  const getCases: Array<[string, any, RegExp]> = [
    ['A25 404', http(404), /has no migrate hook/],
    ['A26 no answer', noAnswer('migrate unreachable: ECONNREFUSED'), /did not answer \(migrate unreachable: ECONNREFUSED\)/],
    ['A26b unusable', http(500, { success: false, error: 'boom' }), /answer the manager cannot use \(HTTP 500: boom\)/],
    ['A27 can\'t confirm', refusal("can't confirm which store holds the data: /data/.backend.json does not name file or postgres", 200), /can't confirm which store holds its data/],
    ['A28 another direction running', getJob({ jobId: 'mgr-x', to: 'file', state: 'running' }), /running migration mgr-x to JSON files, so a migration to Postgres was refused/],
    ['A33 token refused', http(401, { success: false, error: 'bad token' }), /refused the manager's token \(HTTP 401: bad token\)/],
  ];
  it.each(getCases)('%s', async (_n, answer, text) => {
    seedBot();
    m.bot.getQueue.push(answer);
    const a = await press('postgres');
    expect((a as any).error).toMatch(text);
    expect(m.bot.gets).toBe(1);
    nothingChanged(true);
  });

  it('A30 the record write fails', async () => {
    seedBot();
    m.failMigrateWrite = () => 'disk full';
    expect(await press('postgres')).toMatchObject({ accepted: false, status: 500, error: 'The migration could not be recorded (disk full), so nothing was changed' });
  });
});

describe('A: admitted', () => {
  it('A31 accepted; the record opens at preparing with a minted jobId', async () => {
    seedBot();
    const a = await runMigration('b1', 'postgres', 'press');
    expect(a).toEqual({ accepted: true });
    const first = m.migrateWrites[0].rec;
    expect(first).toMatchObject({ to: 'postgres', from: 'file', phase: 'preparing', started: 0, kept: 0, posted: false, jobIds: [] });
    expect(first.jobId).toMatch(/^mgr-[0-9a-f-]{36}$/);
    await laneDone('b1');
  });
  it('A29 a running job of this `to` is adopted: jobIds and posted in the opening save, then the lane follows it', async () => {
    seedBot();
    m.bot.journal.push({ jobId: 'mgr-run', to: 'postgres', state: 'running', stage: 'copying', destination: { host: 'b1-fleet-postgres', port: 5432, database: 'smdb' } });
    m.bot.script = [{}, { state: 'interrupted', stage: 'retire-source' }];
    for (let i = 0; i < 6; i++) m.bot.postQueue.push({ ok: false, status: 409, body: { success: false, error: 'no' }, error: 'no' });
    await press('postgres');
    expect(m.migrateWrites[0].rec).toMatchObject({ jobId: 'mgr-run', jobIds: ['mgr-run'], posted: true, phase: 'following', adoptedJob: 'mgr-run' });
    expect(m.events).not.toContain('hook:maintenance');
  });
  it('A9 a press on an open record of this `to` after G5 (stored = to) and after G10 (Running) is admitted', async () => {
    seedBot({ env: { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: 'postgresql://smdb:pw@b1-fleet-postgres:5432/smdb' } });
    m.bots.b1.fleetDb = { containerName: 'b1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'v' };
    m.bots.b1.maintenance = { ...m.bots.b1.maintenance, state: 'running' };
    m.bots.b1.migrate = { to: 'postgres', from: 'file', destination: 'b1-fleet-postgres:5432/smdb', companion: true, jobId: 'mgr-a', jobIds: ['mgr-a'], posted: true, started: 3, kept: 5, phase: 'waiting', resumeAt: 'finishing', finishing: 'confirmed', loginOpened: false, sharers: [], sharersStopped: [], openedAt: 'x' };
    const a = await press('postgres');
    expect(a).toEqual({ accepted: true });
    expect(m.migrateWrites[0].rec).toMatchObject({ phase: 'finishing', started: 0, kept: 0, jobId: 'mgr-a' });
    expect(m.events).toContain('order:running:migrate');
    expect(m.bots.b1.migrate).toBeUndefined();
  });
  it('A8 a record open with the other `to` refuses', async () => {
    seedBot();
    m.bots.b1.migrate = { to: 'file', phase: 'waiting', jobIds: [], sharers: [], sharersStopped: [] };
    expect(await press('postgres')).toMatchObject({ status: 409, error: expect.stringMatching(/A migration to JSON files is open on this bot; press Migrate to JSON files/) });
  });
});

describe('A: a Database URL that names another instance\'s managed database container (round 4)', () => {
  const S1_DB = { containerName: 's1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 's1-fleet-postgres-data' };
  const OWNER_HOSTED = (owner: string) => `The Database URL names a database in ${owner}'s managed database container, so the migration was refused: Migrate moves data only to or from this bot's own managed database or a database outside this manager's containers, and Migrate on ${owner} moves ${owner}'s own data; nothing was changed`;
  const s1 = () => {
    m.bots.s1 = { id: 's1', displayName: 'S1', sanitizedName: 's1', sourceUrl: m.bots.b1.sourceUrl, envVars: {}, status: 'running', createdAt: 'x', updatedAt: 'x', fleetDb: { ...S1_DB } };
    m.env.s1 = { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: 'postgresql://smdb:pw@s1-fleet-postgres:5432/smdb' };
  };
  it('A41 a move to file: MG-OWNER-HOSTED naming S1, nothing changed and no GET', async () => {
    seedBot({ external: true, url: 'postgresql://smdb:pw@s1-fleet-postgres:5432/smdb' });
    s1();
    expect(await press('file')).toEqual({ accepted: false, status: 409, error: OWNER_HOSTED('S1') });
    nothingChanged();
  });
  it('A41 a move to Postgres under another port and database name: MG-OWNER-HOSTED naming S1', async () => {
    seedBot({ url: 'postgresql://smdb:pw@s1-fleet-postgres:5433/b1data' });
    s1();
    expect(await press('postgres')).toEqual({ accepted: false, status: 409, error: OWNER_HOSTED('S1') });
    nothingChanged();
  });
  it('A32 (round 4) a move to Postgres onto a companion with replication on: MG-FLEET-REPL-ON', async () => {
    seedBot();
    m.bots.b1.fleetDb = { ...FLEET_DB, replication: { publicHost: 'pub.example', hostPort: 5433 } };
    expect(await press('postgres')).toEqual({ accepted: false, status: 409, error: MG_FLEET_REPL_ON });
    nothingChanged();
  });
  it('A32 (round 5) a move to Postgres onto an outside address with replication on: MG-FLEET-REPL-ON', async () => {
    seedBot({ url: EXTERNAL_URL });
    m.bots.b1.fleetDb = { ...FLEET_DB, replication: { publicHost: 'pub.example', hostPort: 5433 } };
    expect(await press('postgres')).toEqual({ accepted: false, status: 409, error: MG_FLEET_REPL_ON });
    nothingChanged();
  });
  it('A32 (round 5) a move to file from an outside database with replication on: MG-FLEET-REPL-ON', async () => {
    seedBot({ external: true });
    m.bots.b1.fleetDb = { ...FLEET_DB, replication: { publicHost: 'pub.example', hostPort: 5433 } };
    expect(await press('file')).toEqual({ accepted: false, status: 409, error: MG_FLEET_REPL_ON });
    nothingChanged();
  });
  it('A13 (round 5) the companion spelled in upper case meets A15: being removed', async () => {
    seedBot({ url: 'postgresql://smdb:pw@B1-FLEET-POSTGRES:5432/smdb' });
    m.bots.b1.fleetDb = { ...FLEET_DB, retiringAt: '2026-10-30' };
    expect(await press('postgres')).toMatchObject({ accepted: false, status: 409, error: expect.stringMatching(/being removed/) });
    nothingChanged();
  });
  it('A13 (round 5) the companion spelled in upper case meets A21: a restore notice', async () => {
    seedBot({ url: 'postgresql://smdb:pw@B1-FLEET-POSTGRES:5432/smdb' });
    m.bots.b1.fleetDb = { ...FLEET_DB };
    m.notice = 'pre-x.dump';
    expect(await press('postgres')).toMatchObject({ accepted: false, status: 409, error: expect.stringMatching(/A restore of pre-x.dump has not finished cleanly/) });
    nothingChanged();
  });
  it.each([
    ['postgresql://u:p@db.example.test:5432/app?host=s1-fleet-postgres', {}, 'param'],
    ['postgresql://u:p@pub.example:5432/x?port=5433', {}, 'param'],
    ['postgresql://u:p@s1%2Dfleet%2Dpostgres:5432/app', {}, 'encodedHost'],
    ['postgresql://u:p@db.example.test:5432', {}, 'noDatabase'],
    ['postgresql://u:p@db.example.test:5432/smdb/', {}, 'databaseName'],
    ['postgresql://u:p@db.example.test/app', { PGPORT: '5433' }, 'pgport'],
    ['postgresql://u:p@h1,h2:5432/db', {}, 'hosts'],
  ])('A42 (round 5) a move to Postgres with %s (%j): MG-URL-FORM-A for %s', async (url, env, form) => {
    seedBot({ url, env });
    s1();
    expect(await press('postgres')).toEqual({ accepted: false, status: 409, error: MG_URL_FORM_A(form) });
    nothingChanged();
  });
  it('A42 (round 5) a move to file with a host parameter: MG-URL-FORM-A', async () => {
    seedBot({ external: true, url: 'postgresql://u:p@db.example.test:5432/app?host=s1-fleet-postgres' });
    s1();
    expect(await press('file')).toEqual({ accepted: false, status: 409, error: MG_URL_FORM_A('param') });
    nothingChanged();
  });
});

describe('A: a bot another open record holds (round 2)', () => {
  const HELD = "S9's data migration to JSON files is open on the database this bot uses, so this bot cannot migrate until that migration ends; nothing was changed";
  const holder = () => {
    m.bots.s9 = { id: 's9', displayName: 'S9', sanitizedName: 's9', sourceUrl: m.bots.b1.sourceUrl, envVars: {}, status: 'running', createdAt: 'x', updatedAt: 'x',
      migrate: { to: 'file', from: 'postgres', destination: null, companion: false, jobId: 'mgr-s9', jobIds: ['mgr-s9'], posted: true, started: 1, kept: 0, phase: 'waiting', resumeAt: 'following', loginOpened: false, sharers: ['b1'], sharersStopped: ['b1'], openedAt: 'x', text: 't' } };
    m.env.s9 = { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: COMPANION_URL };
  };
  it('A36 another record lists b1 in sharers: MG-HELD-MIGRATE naming S9, nothing written', async () => {
    seedBot({ postgres: true });
    holder();
    expect(await press('file')).toEqual({ accepted: false, status: 409, error: HELD });
    nothingChanged();
  });
  it("A36 b1's own parked record does not take the press past the hold", async () => {
    seedBot({ postgres: true });
    holder();
    m.bots.b1.migrate = { to: 'file', from: 'postgres', destination: null, companion: false, jobId: 'mgr-b1', jobIds: ['mgr-b1'], posted: true, started: 1, kept: 0, phase: 'waiting', resumeAt: 'following', loginOpened: false, sharers: [], sharersStopped: [], openedAt: 'x', text: 't' };
    expect(await press('file')).toEqual({ accepted: false, status: 409, error: HELD });
    nothingChanged();
  });
});
