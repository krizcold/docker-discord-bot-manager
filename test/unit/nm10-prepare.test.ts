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
import { fastTiming, getJob, m, noAnswer, refusal, resetMigrate, seedBot, seedSharer, COMPANION_URL, EXTERNAL_URL, FLEET_DB, MG_DB_START, MG_FENCE_F, MG_P_FENCE, MG_SHARER_STILL } from './migrate-fake';

beforeEach(() => { resetMigrate(); fastTiming(MIGRATE_TIMING); });


async function press(to: 'postgres' | 'file') {
  const a = await runMigration('b1', to, 'press');
  expect(a).toEqual({ accepted: true });
  await laneDone('b1');
}

const closed = () => m.bots.b1.migrateLast;
const posted = () => m.events.some(e => e.startsWith('POST'));

/** F with nothing posted: the record closed failed, the stored backend the source, no POST. */
function closedBefore(text: RegExp, from = 'file') {
  expect(m.bots.b1.migrate).toBeUndefined();
  expect(closed()).toMatchObject({ outcome: 'failed', jobId: null });
  expect(closed().text).toMatch(text);
  expect(m.env.b1.DATA_BACKEND).toBe(from);
  expect(posted()).toBe(false);
}

describe('B: preparation closes with F and nothing posted', () => {
  it('B1 ensureFleetDataBackend throws (a kept volume)', async () => {
    seedBot();
    m.ensure = () => { throw new Error('The database volume b1-fleet-postgres-data already exists'); };
    await press('postgres');
    closedBefore(/^The migration did not start: the managed database could not be set up \(The database volume b1-fleet-postgres-data already exists\)\. Nothing was copied, and the bot stays in Maintenance\.$/);
  });
  it('B2 the compose service is not attached', async () => {
    seedBot();
    m.attach = { success: false, error: 'Deployed compose not found' };
    await press('postgres');
    closedBefore(/could not be set up \(Deployed compose not found\)/);
  });
  it('B3 the companion does not start', async () => {
    seedBot();
    m.dbStart = { success: false, error: 'database did not become ready within 30 seconds' };
    await press('postgres');
    closedBefore(/the managed database did not start \(database did not become ready within 30 seconds\)/);
  });
  it('B3 a role step that fails is only logged by the start, so the lane goes on to M3', async () => {
    seedBot();
    await press('postgres');
    expect(m.events.indexOf('db-start:b1')).toBeLessThan(m.events.indexOf('login-read'));
    expect(closed().outcome).toBe('done');
  });
  it('B4 a managed source whose sidecar does not start', async () => {
    seedBot({ postgres: true });
    m.sidecar[FLEET_DB.containerName] = false;
    m.dbStart = { success: false, error: 'compose up failed' };
    await press('file');
    closedBefore(/the managed database did not start \(compose up failed\)/, 'postgres');
  });
  it('B5 the login read fails', async () => {
    seedBot({ postgres: true });
    m.loginReadFail = 'psql: connection refused';
    await press('file');
    closedBefore(/login could not be opened \(psql: connection refused\)/, 'postgres');
  });
  it('B6 the database is in recovery', async () => {
    seedBot({ postgres: true });
    m.login.inRecovery = true;
    await press('file');
    closedBefore(/login could not be opened \(the database is a live copy in recovery\)/, 'postgres');
  });
  it('B7 the open refused by a write fence', async () => {
    seedBot({ postgres: true });
    m.openResult = { ok: false, cls: 'write-fence', error: 'read-only' };
    await press('file');
    closedBefore(/login could not be opened \(the database is READ-ONLY under a write fence\)/, 'postgres');
  });
  it('B8 the login reads back blocked after the open', async () => {
    seedBot({ postgres: true });
    m.openSticks = false;
    await press('file');
    closedBefore(/\(the login read back as blocked after it was opened\)/, 'postgres');
    expect(m.events).toContain('login-block');
  });
  it('B9 the loginOpened write fails: the lane stops with the login untouched', async () => {
    seedBot({ postgres: true });
    m.failMigrateWrite = (_n, rec) => (rec?.loginOpened ? 'disk full' : null);
    const texts: string[] = [];
    (await import('../../src/instance/migrate')).setMigrateListener((_id, ev) => texts.push(ev.text));
    await press('file');
    expect(m.events).not.toContain('login-open');
    expect(m.bots.b1.migrate).toBeDefined();
    expect(texts.pop()).toBe("The manager could not record the migration's progress (disk full), so it stopped here with the migration open. Press Migrate to go on.");
  });
  it('B10 saved: true is recorded and the lane goes on; loginOpened is written before the open', async () => {
    seedBot({ postgres: true });
    await press('file');
    expect(m.held).toEqual([{ state: 'yes' }]);
    const opened = m.migrateWrites.findIndex(w => w.rec?.loginOpened);
    expect(opened).toBeGreaterThanOrEqual(0);
    expect(m.events.indexOf('login-open')).toBeGreaterThan(m.events.findIndex(e => e === 'record:preparing'));
  });
  it('B11 saved: false through 6 tries names the counts of the last answer', async () => {
    seedBot();
    for (let i = 0; i < 6; i++) m.saveAnswers.push({ ok: true, status: 200, body: { success: true, saved: false, unsavedGuilds: ['g1', 'g2'], unsavedFiles: 1 } });
    await press('postgres');
    closedBefore(/reports changes it could not save \(2 guild\(s\), 1 file\(s\)\)/);
    expect(m.events.filter(e => e === 'hook:maintenance')).toHaveLength(6);
  });
  it('B12 saved null through 6 tries', async () => {
    seedBot();
    for (let i = 0; i < 6; i++) m.saveAnswers.push({ ok: true, status: 200, body: { success: true, saved: null } });
    await press('postgres');
    closedBefore(/did not confirm that it saved every change it holds \(it answered that it can't confirm\)/);
  });
  it('B13 refused through 6 tries gives the hook reason', async () => {
    seedBot();
    for (let i = 0; i < 6; i++) m.saveAnswers.push(refusal('busy', 500));
    await press('postgres');
    closedBefore(/\(the bot answered: busy\)/);
  });
  it('B13 unreachable through 6 tries', async () => {
    seedBot();
    for (let i = 0; i < 6; i++) m.saveAnswers.push(noAnswer('maintenance unreachable: ECONNREFUSED'));
    await press('postgres');
    closedBefore(/\(the bot could not be reached: maintenance unreachable: ECONNREFUSED\)/);
  });
  it('B14 the maintenance hook answers 404', async () => {
    seedBot();
    m.saveAnswers.push({ ok: false, status: 404, error: 'maintenance returned 404' });
    await press('postgres');
    closedBefore(/\(its build has no maintenance hook\)/);
    expect(m.events.filter(e => e === 'hook:maintenance')).toHaveLength(1);
  });
});

describe('B: sharers (M5)', () => {
  it('sharers are written before the stop; a running sharer is stopped', async () => {
    seedBot({ postgres: true });
    seedSharer('s1');
    await press('file');
    const write = m.migrateWrites.findIndex(w => w.rec?.sharers?.includes('s1'));
    const stopAt = m.events.indexOf('stop-sharer:s1');
    expect(write).toBeGreaterThanOrEqual(0);
    expect(stopAt).toBeGreaterThan(m.events.findIndex((e, i) => i > 0 && e === 'record:preparing'));
    expect(closed().text).toMatch(/S1 uses the old database and stays stopped/);
  });
  it('B15 a sharer holding an op lock', async () => {
    seedBot({ postgres: true });
    seedSharer('s1');
    m.lock.s1 = 'build';
    await press('file');
    closedBefore(/S1 uses the same database and is running 'build'/, 'postgres');
  });
  it('B16 a sharer whose stop fails: F5 starts again the ones docker shows stopped', async () => {
    seedBot({ postgres: true });
    seedSharer('s1');
    seedSharer('s2');
    m.app.s2 = null;
    await press('file');
    closedBefore(/S2 uses the same database and could not be stopped \(docker did not say whether it runs\)/, 'postgres');
    expect(m.events).toContain('start-sharer:s1');
  });

  const record = (over: Record<string, unknown>) => ({ to: 'file', from: 'postgres', destination: null, companion: false, jobId: 'mgr-x', jobIds: ['mgr-x'], posted: true, started: 1, kept: 0, phase: 'waiting', resumeAt: 'following', loginOpened: false, sharers: [], sharersStopped: [], openedAt: 'x', text: 't', ...over });
  const s9With = (over: Record<string, unknown>) => {
    m.bots.s9 = { id: 's9', displayName: 'S9', sanitizedName: 's9', sourceUrl: m.bots.b1.sourceUrl, envVars: {}, status: 'running', createdAt: 'x', updatedAt: 'x', migrate: record({ jobId: 'mgr-s9', ...over }) };
    m.env.s9 = { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: COMPANION_URL };
  };
  const listed = (id: string) => m.migrateWrites.some(w => w.rec?.sharers?.includes(id));

  it('B30 (T2) a sharer with its own open record: F with MG-SHARER-OPEN before any stop, sharers not written', async () => {
    seedBot({ postgres: true });
    seedSharer('s2');
    seedSharer('s1', { migrate: record({ jobId: 'mgr-s1' }) });
    await press('file');
    closedBefore(/^The migration did not start: S1 uses the same database and has its own data migration to JSON files open, so it was not stopped\. Nothing was copied, and the bot stays in Maintenance; press Migrate again once S1's migration ends\.$/, 'postgres');
    expect(m.events.filter(e => e.startsWith('stop-sharer:'))).toEqual([]);
    expect(listed('s1') || listed('s2')).toBe(false);
  });
  it('B31 a sharer another open record lists: F with MG-SHARER-SHARED naming that record, not stopped', async () => {
    seedBot({ postgres: true });
    seedSharer('s1');
    s9With({ sharers: ['s1'], sharersStopped: ['s1'] });
    await press('file');
    closedBefore(/^The migration did not start: S1 uses the same database, and S9's open migration to JSON files already holds it, so it was not stopped\. Nothing was copied, and the bot stays in Maintenance; press Migrate again once that migration ends\.$/, 'postgres');
    expect(m.events).not.toContain('stop-sharer:s1');
  });
});

describe('B: the restart into maintenance (M6)', () => {
  it('B17 the stop fails', async () => {
    seedBot();
    m.stop = { success: false, error: 'compose down failed' };
    await press('postgres');
    closedBefore(/restart into maintenance failed \(compose down failed\)\. Nothing was copied, and the bot's state stays Maintenance\.$/);
  });
  it('B18 the start fails: the stopped clause', async () => {
    seedBot();
    m.start = { success: false, error: 'compose up failed' };
    await press('postgres');
    closedBefore(/\(compose up failed\)\. Nothing was copied, and the bot's state stays Maintenance\. The bot is stopped; start it before pressing Migrate again\.$/);
  });
  it('B21 a start that would build refuses with MG-NEEDS-BUILD', async () => {
    seedBot();
    m.start = { success: false, error: "the bot's image or compose is missing, and a build in the middle of a migration would rewrite the compose, so the manager did not build it" };
    await press('postgres');
    closedBefore(/restart into maintenance failed \(the bot's image or compose is missing, .*did not build it\)\..* The bot is stopped/);
  });
  it('B19 no answer within the readiness window', async () => {
    seedBot();
    m.bot.getQueue.push(getJob(null));
    m.bot.down = true;
    await press('postgres');
    closedBefore(/did not answer within 180 seconds of its restart \(migrate unreachable: connect ECONNREFUSED\)/);
  });
  it('B22 a managed database that does not accept connections after the start', async () => {
    seedBot();
    m.dbReady = false;
    await press('postgres');
    closedBefore(/the managed database did not start \(b1-fleet-postgres: it did not accept connections within 30 seconds of the restart\)/);
  });
  it('B24 a switch mark written after M4: no stop, F, MG-SWITCH-LATE, the login blocked again', async () => {
    seedBot({ postgres: true });
    m.saveAnswers.push(() => {
      m.bots.b1.fleetDb = { ...m.bots.b1.fleetDb, replacedBy: { machine: 'other.example', generation: 3, at: 'x' } };
      return { ok: true, status: 200, body: { success: true, saved: true } };
    });
    await press('file');
    expect(m.events.filter(e => e.startsWith('stop:'))).toEqual([]);
    closedBefore(/^The migration did not start: other.example replaced this database as the main, so the bot does not start here; rejoin it as a copy, so the manager did not restart the bot into maintenance\./, 'postgres');
    expect(m.events).toContain('login-block');
    expect(m.login.canLogin).toBe(false);
  });
  it('the order of M2 to M6, and M6b before the POST', async () => {
    seedBot();
    await press('postgres');
    const e = m.events;
    const at = (x: string) => e.findIndex(v => v.startsWith(x));
    expect(at('ensure:forMigrate')).toBeLessThan(at('attach'));
    expect(at('attach')).toBeLessThan(at('db-start:b1'));
    expect(at('db-start:b1')).toBeLessThan(at('login-read'));
    expect(at('login-read')).toBeLessThan(at('hook:maintenance'));
    expect(at('hook:maintenance')).toBeLessThan(at('stop:migrate'));
    expect(at('stop:migrate')).toBeLessThan(at('start:migrate'));
    expect(at('start:migrate')).toBeLessThan(at('db-ready'));
    expect(at('db-ready')).toBeLessThan(at('POST'));
  });
});

describe('B: round 1', () => {
  /** docker's answers for the bot's app, read by read; after the list the stored value answers. */
  function appReads(id: string, answers: Array<boolean | null>): void {
    const orig = m.app;
    const left = [...answers];
    m.app = new Proxy(orig, { get: (t, k) => (k === id && left.length ? left.shift() : (t as any)[k]), has: (t, k) => k in t });
  }
  it('B25 the app stopped after M3: F with MG-PREP-STOPPED, no maintenance hook, the login M3 opened blocked again', async () => {
    seedBot({ postgres: true });
    appReads('b1', [true, false]);
    await press('file');
    expect(m.events).not.toContain('hook:maintenance');
    closedBefore(/^The migration did not start: the bot is stopped, and it has to run in its maintenance boot to save what it holds. Nothing was copied, and the bot stays in Maintenance; start it, then press Migrate again.$/, 'postgres');
    expect(m.events.indexOf('login-block')).toBeGreaterThan(m.events.indexOf('login-open'));
    expect(m.login.canLogin).toBe(false);
  });
  it('B26 the save hook unreachable on every try, the app stopped by the second answer: MG-PREP-STOPPED', async () => {
    seedBot();
    for (let i = 0; i < 6; i++) m.saveAnswers.push(() => { if (i === 1) m.app.b1 = false; return { ok: false, error: 'connect ECONNREFUSED' }; });
    await press('postgres');
    closedBefore(/^The migration did not start: the bot is stopped, and it has to run in its maintenance boot to save what it holds\./);
    expect(closed().text).not.toMatch(/did not confirm that it saved/);
  });
  it('B26 saved false on every try, the app stopped by the last answer: MG-PREP-STOPPED', async () => {
    seedBot();
    for (let i = 0; i < 6; i++) m.saveAnswers.push(() => { if (i === 5) m.app.b1 = false; return { ok: true, status: 200, body: { success: true, saved: false, unsavedGuilds: 1, unsavedFiles: 0 } }; });
    await press('postgres');
    closedBefore(/^The migration did not start: the bot is stopped, and it has to run in its maintenance boot to save what it holds\./);
  });
  it('B25 docker unsure (null) before M4: M4 runs', async () => {
    seedBot();
    appReads('b1', [true, null]);
    await press('postgres');
    expect(m.events).toContain('hook:maintenance');
    expect(closed().outcome).toBe('done');
  });
  it('R4 sharers s1 running, s2 stopped, s3 Off: only s1 stopped, and sharersStopped holds s1 before its stop', async () => {
    seedBot({ postgres: true });
    seedSharer('s1');
    seedSharer('s2');
    seedSharer('s3', { maintenance: { state: 'off', message: '', orderedAt: '2026-10-30T00:00:00.000Z', settled: true } });
    m.app.s2 = false;
    m.app.s3 = false;
    await press('file');
    expect(m.events.filter(e => e.startsWith('stop-sharer:'))).toEqual(['stop-sharer:s1']);
    const write = m.migrateWrites.findIndex(w => w.rec?.sharersStopped?.includes('s1'));
    expect(write).toBeGreaterThanOrEqual(0);
    expect(m.migrateWrites[write].rec.sharersStopped).toEqual(['s1']);
    const recordEvents = m.events.map((e, i) => [e, i] as const).filter(([e]) => e.startsWith('record:'));
    expect(recordEvents[write][1]).toBeLessThan(m.events.indexOf('stop-sharer:s1'));
  });
  it('A-5 s1 takes an op during its docker check: MG-SHARER-BUSY, never MG-NOTREC-LANE', async () => {
    seedBot({ postgres: true });
    seedSharer('s1');
    const orig = m.app;
    m.app = new Proxy(orig, { get: (t, k) => { if (k === 's1') m.lock.s1 = 'build'; return (t as any)[k]; }, has: (t, k) => k in t });
    const texts: string[] = [];
    (await import('../../src/instance/migrate')).setMigrateListener((_id, ev) => texts.push(ev.text));
    await press('file');
    m.app = orig;
    closedBefore(/^The migration did not start: S1 uses the same database and is running 'build'\./, 'postgres');
    expect(texts.join('\n')).not.toMatch(/could not record the migration's progress/);
    expect(m.events).not.toContain('stop-sharer:s1');
  });
  it('A-5 stopBot throwing closes MG-SHARER with its text', async () => {
    seedBot({ postgres: true });
    seedSharer('s1');
    m.sharerStop = () => { throw new Error("Operation 'x' is already in progress for this bot"); };
    await press('file');
    closedBefore(/^The migration did not start: S1 uses the same database and could not be stopped \(Operation 'x' is already in progress for this bot\)\./, 'postgres');
  });
});

describe('B: sharers M5 cannot read or may not stop (round 5)', () => {
  it("B34 (round 5) a sharer whose own managed database has replication on: F with MG-SHARER-REPL naming S1, not stopped, no POST", async () => {
    seedBot({ postgres: true });
    seedSharer('s1', { fleetDb: { ...FLEET_DB, containerName: 's1-fleet-postgres', replication: { publicHost: 'pub.example', hostPort: 5433 } } });
    await press('file');
    closedBefore(/^The migration did not start: S1 uses the same database, and S1's own managed database has replication on; the manager's check of that database as its fleet's main pauses while this migration holds S1, so S1 was not stopped\. Nothing was copied, and the bot stays in Maintenance; turn replication off on S1, then press Migrate again\.$/, 'postgres');
    expect(m.events).not.toContain('stop-sharer:s1');
  });
});

describe('B: the fence on a move to file from the bot\'s own managed database (round 6)', () => {
  /** The event index of the nth record write. */
  const writeEvent = (n: number) => { let seen = -1; return m.events.findIndex(e => e.startsWith('record:') && ++seen === n); };
  it("B35 the order: the sharers stopped, hbaFence recorded, then the lines before M6's stop, hbaFenceSet, renewed after the restart, lifted after the last GET", async () => {
    seedBot({ postgres: true });
    seedSharer('s1');
    const texts: string[] = [];
    (await import('../../src/instance/migrate')).setMigrateListener((_id, ev) => texts.push(ev.text));
    await press('file');
    (await import('../../src/instance/migrate')).setMigrateListener(null);
    const e = m.events;
    const w = m.migrateWrites.findIndex(x => x.rec?.hbaFence);
    expect(w).toBeGreaterThan(-1);
    expect(m.migrateWrites[w].rec.phase).toBe('preparing');
    expect(e.indexOf('stop-sharer:s1')).toBeGreaterThan(-1);
    expect(e.indexOf('stop-sharer:s1')).toBeLessThan(writeEvent(w));
    expect(writeEvent(w)).toBeLessThan(e.indexOf('hba-fence'));
    expect(e.indexOf('hook:maintenance')).toBeLessThan(e.indexOf('hba-fence'));
    expect(e.indexOf('hba-fence')).toBeLessThan(e.indexOf('stop:migrate'));
    expect(m.migrateWrites.some((x, n) => x.rec?.hbaFenceSet === true && writeEvent(n) > e.indexOf('hba-fence'))).toBe(true);
    const set = m.migrateWrites.findIndex(x => x.rec?.hbaFenceSet === true);
    expect(m.migrateWrites.some((x, n) => n > set && x.rec?.isolated === true && writeEvent(n) < e.indexOf('stop:migrate'))).toBe(true);
    expect(e.indexOf('start:migrate')).toBeLessThan(e.indexOf('hba-refresh'));
    expect(e.indexOf('hba-refresh')).toBeLessThan(e.findIndex(x => x.startsWith('POST:')));
    expect(e.indexOf('hba-lift')).toBeGreaterThan(e.lastIndexOf('GET'));
    expect(texts.indexOf('Stopping the other bots on this database (S1)')).toBeGreaterThan(-1);
    expect(texts.indexOf('Stopping the other bots on this database (S1)')).toBeLessThan(texts.indexOf(MG_P_FENCE));
    expect(closed().outcome).toBe('done');
  });
  it.each([
    ['a move to file from an outside database', () => seedBot({ external: true }), 'file'],
    ['a move to Postgres', () => seedBot(), 'postgres'],
  ] as Array<[string, () => void, 'file' | 'postgres']>)("(pin) B35's scope, %s: no fence", async (_n, arrange, to) => {
    arrange();
    await press(to);
    expect(m.events.some(e => e.startsWith('hba-'))).toBe(false);
    expect(m.migrateWrites.some(x => x.rec?.hbaFence)).toBe(false);
  });
  it("B36 the fence cannot stand: F with MG-FENCE-F after the sharers' stops, and F lifts what was written, then starts them again", async () => {
    seedBot({ postgres: true });
    seedSharer('s1');
    const why = 'a write fence of a restore (started 2026-10-31 00:00 UTC) stands in its pg_hba.conf';
    m.fenceUp = why;
    await press('file');
    expect(closed()).toMatchObject({ outcome: 'failed' });
    expect(closed().text).toBe(MG_FENCE_F(why));
    const e = m.events;
    expect(e.indexOf('stop-sharer:s1')).toBeGreaterThan(-1);
    expect(e.indexOf('stop-sharer:s1')).toBeLessThan(e.indexOf('hba-fence'));
    expect(e.indexOf('hba-lift')).toBeGreaterThan(e.indexOf('hba-fence'));
    expect(e.indexOf('start-sharer:s1')).toBeGreaterThan(e.indexOf('hba-lift'));
    expect(e).not.toContain('stop:migrate');
    expect(posted()).toBe(false);
  });
  it("B38 the renewal after M6's start fails: F with MG-FENCE-F, no POST", async () => {
    seedBot({ postgres: true });
    seedSharer('s1');
    const why = 'the database still did not refuse a TCP connection 15 s after the reload of its rewritten pg_hba.conf';
    m.fenceUp = (refresh) => (refresh ? why : null);
    await press('file');
    expect(closed()).toMatchObject({ outcome: 'failed' });
    expect(closed().text).toBe(MG_FENCE_F(why, true));
    expect(m.events).toContain('start:migrate');
    expect(m.events).toContain('hba-refresh');
    expect(posted()).toBe(false);
  });
  it('B37 a running bot whose deployed env names the database is stopped before the fence and named in the done text', async () => {
    seedBot({ postgres: true });
    m.bots.s4 = { id: 's4', displayName: 'S4', sanitizedName: 's4', sourceUrl: m.bots.b1.sourceUrl, envVars: {}, status: 'running', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' };
    m.env.s4 = { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: 'postgresql://u:p@db.example.test:5432/app' };
    m.app.s4 = true;
    m.liveSharers = ['s4'];
    await press('file');
    expect(m.events.indexOf('stop-sharer:s4')).toBeGreaterThan(-1);
    expect(m.events.indexOf('stop-sharer:s4')).toBeLessThan(m.events.indexOf('hba-fence'));
    expect(closed().text).toContain('S4 uses the old database and stays stopped');
  });
});

describe('B: round 8 (the step of M5 and B35, M6 order)', () => {
  const writeEvent = (n: number) => { let seen = -1; return m.events.findIndex(e => e.startsWith('record:') && ++seen === n); };
  it("B42, the database not ready after M6's start: F with MG-DB-START before any renewal", async () => {
    seedBot({ postgres: true });
    m.dbReady = false;
    await press('file');
    expect(closed()).toMatchObject({ outcome: 'failed' });
    expect(closed().text).toBe(MG_DB_START('b1-fleet-postgres: it did not accept connections within 30 seconds of the restart'));
    expect(m.events.indexOf('start:migrate')).toBeGreaterThan(-1);
    expect(m.events.indexOf('start:migrate')).toBeLessThan(m.events.indexOf('db-ready:b1-fleet-postgres'));
    expect(m.events).not.toContain('hba-refresh');
  });
  it("B42, the order: after M6's start the database's readiness, then the renewal, then the bot's readiness", async () => {
    seedBot({ postgres: true });
    m.dbReady = true;
    await press('file');
    expect(closed().outcome).toBe('done');
    const e = m.events.slice(m.events.indexOf('start:migrate'));
    expect(e.indexOf('db-ready:b1-fleet-postgres')).toBeGreaterThan(-1);
    expect(e.indexOf('db-ready:b1-fleet-postgres')).toBeLessThan(e.indexOf('hba-refresh'));
    expect(e.indexOf('hba-refresh')).toBeLessThan(e.indexOf('GET'));
  });
  it('B40, docker still shows the sharer after its stop: F with MG-SHARER-STILL, no fence, no restart', async () => {
    seedBot({ postgres: true });
    seedSharer('s1');
    m.sharerStop = { success: false, error: 'Bot is not running' };
    await press('file');
    expect(closed()).toMatchObject({ outcome: 'failed' });
    expect(closed().text).toBe(MG_SHARER_STILL('S1'));
    expect(m.events.filter(x => x === 'stop-sharer:s1')).toHaveLength(1);
    expect(m.events.some(x => x.startsWith('hba-'))).toBe(false);
    expect(m.events).not.toContain('stop:migrate');
    expect(posted()).toBe(false);
    expect(m.events).not.toContain('start-sharer:s1');
  });
  it('B40, docker silent after the stop: F with MG-SHARER naming it', async () => {
    seedBot({ postgres: true });
    seedSharer('s1');
    m.sharerStop = () => { m.app.s1 = null; return { success: false, error: 'Bot is not running' }; };
    await press('file');
    expect(closed().text).toBe('The migration did not start: S1 uses the same database and could not be stopped (docker did not say whether it runs). Nothing was copied, and the bot stays in Maintenance. S1 did not start again (docker did not say whether it runs); start it by hand.');
  });
  it("B41, M5's stop reads docker", async () => {
    seedBot({ postgres: true });
    seedSharer('s1');
    await press('file');
    expect(closed().outcome).toBe('done');
    expect(m.sharerStopOpts).toEqual([{ seen: true }]);
  });
  it("B35, the step's mark on an outside source: isolated after the sharer's stop and before M6, no line", async () => {
    seedBot({ external: true });
    seedSharer('s1', {}, { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: EXTERNAL_URL });
    await press('file');
    const e = m.events;
    const w = m.migrateWrites.findIndex(x => x.rec?.isolated === true);
    expect(w).toBeGreaterThan(-1);
    expect(writeEvent(w)).toBeGreaterThan(e.indexOf('stop-sharer:s1'));
    expect(e.indexOf('stop-sharer:s1')).toBeGreaterThan(-1);
    expect(writeEvent(w)).toBeLessThan(e.indexOf('stop:migrate'));
    expect(e.some(x => x.startsWith('hba-'))).toBe(false);
  });
});
