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
import { botGet, botPost, fastTiming, getJob, http, m, noAnswer, postJob, refusal, resetMigrate, seedBot, seedSharer, unknownPost, COMPANION_URL, EXTERNAL_URL, FLEET_DB, UNREADABLE } from './migrate-fake';

const RS2 = "The bot process is still starting; can't confirm whether it boots in maintenance; try again once it has started";
const S0S = "can't confirm; migration mgr-old's database session is still open; the database ends it once it notices the connection is gone; run the migration again once it no longer shows";
const GONE = 'The job stopped before it finished; the old store still serves';

beforeEach(() => { resetMigrate(); fastTiming(MIGRATE_TIMING); });

async function press(to: 'postgres' | 'file' = 'postgres') {
  expect(await runMigration('b1', to, 'press')).toEqual({ accepted: true });
  await laneDone('b1');
}
const rec = () => m.bots.b1.migrate;
const last = () => m.bots.b1.migrateLast;
const posts = () => m.bot.posts;

describe('C: the POST', () => {
  it('the POST body: the jobId form, `to`, and `url` only for postgres', async () => {
    seedBot();
    await press('postgres');
    expect(posts()[0]).toEqual({ jobId: expect.stringMatching(/^[A-Za-z0-9-]{8,40}$/), to: 'postgres', url: COMPANION_URL });
    resetMigrate(); fastTiming(MIGRATE_TIMING);
    seedBot({ postgres: true });
    await press('file');
    expect(posts()[0]).toEqual({ jobId: expect.any(String), to: 'file' });
  });
  it('an external destination is passed as the stored URL', async () => {
    seedBot({ url: EXTERNAL_URL });
    m.bot.destination = { host: 'db.example.test', port: 5432, database: 'app' };
    await press('postgres');
    expect(posts()[0].url).toBe(EXTERNAL_URL);
    expect(last()).toMatchObject({ outcome: 'done' });
    expect(m.events).not.toContain('attach');
  });
  it('C1 the posting write fails: the lane stops before the POST', async () => {
    seedBot();
    m.failMigrateWrite = (_n, r) => (r?.phase === 'posting' ? 'disk full' : null);
    await press();
    expect(posts()).toEqual([]);
    expect(rec().phase).toBe('preparing');
  });
  it('C2 started: started + 1 and the answered jobId, then follow', async () => {
    seedBot();
    await press();
    const w = m.migrateWrites.map(x => x.rec).find(r => r?.started === 1);
    expect(w).toBeTruthy();
    expect(last().outcome).toBe('done');
  });
  it('C3 running: the answer\'s jobId is followed', async () => {
    seedBot();
    m.bot.postQueue.push(postJob({ jobId: 'mgr-earlier', to: 'postgres', state: 'running' }));
    m.bot.journal.push({ jobId: 'mgr-earlier', to: 'postgres', state: 'running', stage: 'copying', destination: { host: 'b1-fleet-postgres', port: 5432, database: 'smdb' } });
    m.bot.script = [{ state: 'done' }];
    await press();
    expect(last()).toMatchObject({ outcome: 'done', jobId: 'mgr-earlier' });
  });
  it('C4 done: one GET, then G', async () => {
    seedBot();
    m.bot.journal.push({ jobId: 'mgr-earlier', to: 'postgres', state: 'done', stage: 'switching', destination: { host: 'b1-fleet-postgres', port: 5432, database: 'smdb' } });
    m.bot.postQueue.push(postJob({ jobId: 'mgr-earlier', to: 'postgres', state: 'done' }));
    await press();
    expect(last()).toMatchObject({ outcome: 'done', jobId: 'mgr-earlier' });
    expect(m.env.b1.DATA_BACKEND).toBe('postgres');
  });
  it('C5 failed: F', async () => {
    seedBot();
    m.bot.postQueue.push(postJob({ jobId: 'mgr-x', to: 'postgres', state: 'failed', stage: 'checking', error: 'the destination holds data' }));
    await press();
    expect(last().text).toMatch(/^Migration mgr-x failed at checking: the destination holds data\. Nothing was switched: the bot stays in Maintenance and keeps its data in its JSON files\.$/);
    expect(m.env.b1.DATA_BACKEND).toBe('file');
  });
  it('C6 interrupted: the answered jobId joins jobIds, then its D row', async () => {
    seedBot();
    m.bot.postQueue.push(postJob({ jobId: 'mgr-cut', to: 'postgres', state: 'interrupted', stage: 'switching', error: 'the process died' }));
    m.bot.getQueue.push(getJob({ jobId: 'mgr-cut', to: 'postgres', state: 'interrupted', stage: 'switching' }));
    MIGRATE_TIMING.keepDelaysMs = [0, 0, 0, 0, 0];
    m.bot.postQueue.push(refusal('nope'), refusal('nope'), refusal('nope'), refusal('nope'), refusal('nope'));
    for (let i = 0; i < 6; i++) m.bot.getQueue.push(getJob({ jobId: 'mgr-cut', to: 'postgres', state: 'interrupted', stage: 'switching' }));
    await press();
    expect(rec().jobIds).toContain('mgr-cut');
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'posting' });
    expect(rec().text).toMatch(/the copy in Postgres is committed and the switch to it is not written/);
    expect(rec().text).toMatch(/the manager asked five times and does not ask again; press Migrate to go on\.$/);
  });
  it('C7 success with the other `to` parks at following', async () => {
    seedBot();
    m.bot.postQueue.push(postJob({ jobId: 'mgr-o', to: 'file', state: 'running' }));
    await press();
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'following' });
    expect(rec().text).toMatch(/reports migration mgr-o to JSON files \(running\)/);
  });
  it('C8 no answer in 30 s: the same jobId three times, then a park at following', async () => {
    seedBot();
    m.bot.postQueue.push(unknownPost(), unknownPost(), unknownPost());
    await press();
    const ids = posts().map(p => p.jobId);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'following' });
    expect(rec().text).toMatch(/can't confirm whether migration .* started: the bot did not answer within 30 seconds, three times/);
  });
  it('C9 unreachable: again within the window, then a park', async () => {
    seedBot();
    MIGRATE_TIMING.readyMs = 0;
    for (let i = 0; i < 500; i++) m.bot.postQueue.push(noAnswer());
    await press();
    expect(posts().length).toBeGreaterThan(1);
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'following' });
    expect(rec().text).toMatch(/has not answered for/);
    m.bot.postQueue = [];
  });
  it('C10 a 404 on the first POST closes', async () => {
    seedBot();
    m.bot.postQueue.push(http(404));
    await press();
    expect(last().text).toMatch(/^The migration did not start: this bot's build has no migrate hook \(it answered 404\)/);
  });
  it('C10b a 404 after an earlier POST parks, whatever the press reset', async () => {
    seedBot();
    m.bots.b1.migrate = { to: 'postgres', from: 'file', destination: 'b1-fleet-postgres:5432/smdb', companion: true, jobId: 'mgr-a', jobIds: ['mgr-a'], posted: true, started: 2, kept: 0, phase: 'waiting', resumeAt: 'posting', loginOpened: false, sharers: [], sharersStopped: [], openedAt: 'x' };
    m.bot.postQueue.push(http(404));
    await press();
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'following' });
    expect(rec().text).toMatch(/now answers that it has no migrate hook \(404\)/);
  });
  it('C11 (NM10F) RS-2 at the job\'s first checks: a new jobId within the window, then E', async () => {
    seedBot();
    Object.assign(MIGRATE_TIMING, { readyMs: 0, windowMs: 200 });
    for (let i = 0; i < 1000; i++) m.bot.checks.push(RS2);
    await press();
    const ids = posts().map(p => p.jobId);
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
    expect(last().text).toBe(`The bot refused the migration: ${RS2}. Nothing was switched: the bot stays in Maintenance and keeps its data in its JSON files.`);
  });
  it('C12 any other refusal goes through E (null job: F)', async () => {
    seedBot();
    m.bot.postQueue.push(refusal('The destination database holds data', 400));
    await press();
    expect(posts()).toHaveLength(1);
    expect(last().text).toBe('The bot refused the migration: The destination database holds data. Nothing was switched: the bot stays in Maintenance and keeps its data in its JSON files.');
  });
  it('C13 the session refusal retries for its window with P-SESSION, then E', async () => {
    seedBot();
    const texts: string[] = [];
    (await import('../../src/instance/migrate')).setMigrateListener((_id, ev) => texts.push(ev.text));
    for (let i = 0; i < 300; i++) m.bot.postQueue.push(refusal("can't confirm; migration mgr-old's smdb-migrate: session is still open"));
    await press();
    expect(texts.some(t => /waits for an earlier migration's database session to end/.test(t))).toBe(true);
    expect(last().outcome).toBe('failed');
    m.bot.postQueue = [];
  });
  it('C15 401 on the first POST closes; later parks', async () => {
    seedBot();
    m.bot.postQueue.push(http(401, { success: false, error: 'bad token' }));
    await press();
    expect(last().text).toMatch(/^The migration did not start: the bot refused the manager's token \(HTTP 401: bad token\)/);
    resetMigrate(); fastTiming(MIGRATE_TIMING);
    seedBot();
    m.bots.b1.migrate = { to: 'postgres', from: 'file', destination: 'b1-fleet-postgres:5432/smdb', companion: true, jobId: 'mgr-a', jobIds: ['mgr-a'], posted: true, started: 0, kept: 0, phase: 'waiting', resumeAt: 'following', loginOpened: false, sharers: [], sharersStopped: [], openedAt: 'x' };
    m.bot.getQueue.push(getJob(null));
    m.bot.postQueue.push(http(403, { success: false, error: 'bad token' }));
    await press();
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'following' });
    expect(rec().text).toMatch(/refused the manager's token \(HTTP 403: bad token\), so the manager can't confirm how migration mgr-a stands/);
  });
  it('C14 M1b\'s start would build: P with MG-NEEDS-BUILD-WAIT', async () => {
    seedBot();
    m.app.b1 = false;
    m.bots.b1.migrate = { to: 'postgres', from: 'file', destination: 'b1-fleet-postgres:5432/smdb', companion: true, jobId: 'mgr-a', jobIds: ['mgr-a'], posted: true, started: 0, kept: 0, phase: 'waiting', resumeAt: 'following', loginOpened: false, sharers: [], sharersStopped: [], openedAt: 'x' };
    m.start = { success: false, error: "the bot's image or compose is missing, and a build in the middle of a migration would rewrite the compose, so the manager did not build it" };
    await press();
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'following' });
    expect(rec().text).toBe('Migration mgr-a is not finished, and the bot could not be started: its image or compose is missing. The bot stays in Maintenance with the migration open; press Build, then press Migrate.');
  });
});

describe('C: round 1', () => {
  it('R3 the first POST unknown, then 404: P with MG-NOHOOK-KEPT, no login block, the sharers kept', async () => {
    seedBot({ postgres: true });
    seedSharer('s1');
    m.bot.postQueue.push(unknownPost(), http(404));
    await press('file');
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'following', sharers: ['s1'] });
    expect(rec().text).toMatch(/now answers that it has no migrate hook \(404\)/);
    expect(m.events).not.toContain('login-block');
    expect(m.events).not.toContain('start-sharer:s1');
  });
  it.each([401, 403])('R3 the first POST unknown, then %i: P with MG-AUTH', async (status) => {
    seedBot();
    m.bot.postQueue.push(unknownPost(), http(status, { success: false, error: 'bad token' }));
    await press();
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'following' });
    expect(rec().text.startsWith(`The bot refused the manager's token (HTTP ${status}: bad token), so the manager can't confirm how migration `)).toBe(true);
  });
  it('R3 unreachable, then 404: P', async () => {
    seedBot();
    m.bot.postQueue.push(noAnswer(), http(404));
    await press();
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'following' });
    expect(rec().text).toMatch(/now answers that it has no migrate hook \(404\)/);
  });
  it('C-7 MG-NOANSWER names the seconds since the first unreachable POST, not the window', async () => {
    seedBot();
    Object.assign(MIGRATE_TIMING, { windowMs: 60_000, readyMs: 2_600, retryPauseMs: 50 });
    for (let i = 0; i < 500; i++) m.bot.postQueue.push(noAnswer());
    await press();
    m.bot.postQueue = [];
    const n = Number(/has not answered for (\d+) seconds?/.exec(rec().text)?.[1]);
    expect(Math.abs(n - (m.postAt[m.postAt.length - 1] - m.postAt[0]) / 1000)).toBeLessThanOrEqual(1);
    expect(n).not.toBe(60);
  });
  it('C9 (round 2, C-6) a session refusal ends the silence: MG-NOANSWER counts from the first unreachable POST after it', async () => {
    seedBot();
    Object.assign(MIGRATE_TIMING, { windowMs: 60_000, readyMs: 6_000, retryPauseMs: 1_500, sessionPauseMs: 1_500, sessionMs: 60_000 });
    m.bot.postQueue.push(noAnswer(), noAnswer(), { ...refusal(S0S), body: { success: false, error: S0S, jobId: 'mgr-old', to: 'postgres' } });
    for (let i = 0; i < 500; i++) m.bot.postQueue.push(noAnswer());
    await press();
    m.bot.postQueue = [];
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'following' });
    const n = Number(/has not answered for (\d+) seconds?/.exec(rec().text)?.[1]);
    const fromRefusal = (m.postAt[m.postAt.length - 1] - m.postAt[3]) / 1000;
    const fromFirst = (m.postAt[m.postAt.length - 1] - m.postAt[0]) / 1000;
    expect(fromFirst - fromRefusal).toBeGreaterThanOrEqual(4.5);
    expect(Math.abs(n - fromRefusal)).toBeLessThanOrEqual(1);
    expect(fromFirst - n).toBeGreaterThanOrEqual(3.5);
  }, 20_000);
  it('C-6 a parked record whose companion does not start parks with MG-DB-START-WAIT', async () => {
    seedBot();
    m.bot.postQueue.push(unknownPost(), unknownPost(), unknownPost());
    await press();
    const jobId = rec().jobId;
    expect(rec().text).toMatch(/can't confirm whether migration .* started/);
    m.sidecar[FLEET_DB.containerName] = false;
    m.attach = { success: false, error: 'Deployed compose not found' };
    await press();
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'following' });
    expect(rec().text).toBe(`Migration ${jobId} is not finished, and the bot's database could not be started (Deployed compose not found). The bot stays in Maintenance with the migration open; press Migrate to try again.`);
    expect(rec().text).not.toMatch(/30 seconds/);
  });
});

describe('the fake bot answers a POST in contract 9\'s S0 order (C-9)', () => {
  const inst = { id: 'b1' };
  const job = (over: Record<string, unknown>) => ({ jobId: 'mgr-1', to: 'file', state: 'interrupted', stage: 'copying', ...over }) as any;
  beforeEach(() => seedBot({ postgres: true }));
  it.each([
    ['1 the last job running, the same `to`: that job', [job({ state: 'running' })], { jobId: 'mgr-2', to: 'file' }, { ok: true, state: 'running', jobId: 'mgr-1' }],
    ['1 the last job running, the other `to`: refused naming it', [job({ state: 'running' })], { jobId: 'mgr-2', to: 'postgres' }, { ok: false, error: 'Migration mgr-1 (--to file) is running' }],
    ['2 fact 1 (done): done with its jobId', [job({ state: 'done', stage: 'env' })], { jobId: 'mgr-2', to: 'file' }, { ok: true, state: 'done', jobId: 'mgr-1' }],
    ['2 fact 2 (file at switching): written done', [job({ stage: 'switching' })], { jobId: 'mgr-2', to: 'file' }, { ok: true, state: 'done', jobId: 'mgr-1' }],
    ['2 fact 3: the earlier job failed, a new job started', [job({})], { jobId: 'mgr-2', to: 'file' }, { ok: true, state: 'started', jobId: 'mgr-2' }],
    ['2 fact 4: can\'t confirm', [job({ stage: 'retire-source', fact: 4, error: "can't confirm whether the old store was renamed aside" })], { jobId: 'mgr-2', to: 'file' }, { ok: false, error: "can't confirm; the marker /data/.backend.json names file under no migration, not migration mgr-1" }],
    ['3 a known jobId of the other `to`: that job', [job({ jobId: 'mgr-9', to: 'file', state: 'failed', error: 'x' })], { jobId: 'mgr-9', to: 'postgres' }, { ok: true, state: 'failed', jobId: 'mgr-9' }],
    ['4 anything else: a new job, started at checking', [], { jobId: 'mgr-2', to: 'postgres' }, { ok: true, state: 'started', jobId: 'mgr-2' }],
  ])('case %s', (_n, journal, body, want) => {
    m.bot.journal = journal as any;
    const r = botPost(inst, body as any);
    const got: any = { ok: r.ok };
    if (r.ok) Object.assign(got, { state: r.body.state, jobId: r.body.jobId, ...('destination' in want ? { destination: r.body.destination } : {}) });
    else got.error = r.body?.error;
    expect(got).toEqual(want);
  });
  it('fact 3 writes the earlier job failed; fact 4 refuses naming the earlier job, whose GET goes on answering it', () => {
    m.bot.journal = [job({})];
    botPost(inst, { jobId: 'mgr-2', to: 'file' });
    expect(m.bot.journal[0]).toMatchObject({ state: 'failed', error: 'The old store was not retired; nothing was switched' });
    m.bot.journal = [job({ fact: 4, error: GONE })];
    const r = botPost(inst, { jobId: 'mgr-2', to: 'file' });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ success: false, error: "can't confirm; the marker /data/.backend.json names file under no migration, not migration mgr-1", jobId: 'mgr-1', to: 'file' });
    expect(botGet().body).toEqual({ success: true, job: expect.objectContaining({ jobId: 'mgr-1', state: 'interrupted', stage: 'copying' }) });
  });
  it('T-F1 a started answer holds only its fields; the destination shows once the job is past its checks', () => {
    m.bot.journal = [];
    m.bot.script = [{ stage: 'draining' }, { stage: 'copying' }];
    const r = botPost(inst, { jobId: 'mgr-2', to: 'postgres' });
    expect(Object.keys(r.body).sort()).toEqual(['jobId', 'stage', 'state', 'success', 'to']);
    expect('destination' in botGet().body.job).toBe(false);
    expect(botGet().body.job.destination).toEqual({ host: 'b1-fleet-postgres', port: 5432, database: 'smdb' });
  });
  it('T-F2 a running job of the same `to` answers running with no stage', () => {
    m.bot.journal = [job({ state: 'running' })];
    expect(botPost(inst, { jobId: 'mgr-2', to: 'file' }).body).toEqual({ success: true, jobId: 'mgr-1', to: 'file', state: 'running' });
  });
  it('T-F3 a jobId older than the last job starts a new job', () => {
    m.bot.journal = [job({ jobId: 'mgr-9', state: 'failed', error: 'x' }), job({ jobId: 'mgr-3', error: GONE })];
    expect(botPost(inst, { jobId: 'mgr-9', to: 'postgres' }).body).toMatchObject({ state: 'started', jobId: 'mgr-9' });
  });
  it('T-F4 a check refusal: the POST answers started and the journal holds the job failed at checking', () => {
    m.bot.checks = [RS2];
    expect(botPost(inst, { jobId: 'mgr-2', to: 'file' }).body.state).toBe('started');
    const want = { jobId: 'mgr-2', state: 'failed', stage: 'checking', error: RS2 };
    expect(m.bot.journal[m.bot.journal.length - 1]).toMatchObject(want);
    expect(botGet().body.job).toMatchObject(want);
  });
  it('T-F5 an unreadable journal: the POST refuses 409, the GET answers 200 with the same body', () => {
    m.bot.unreadable = UNREADABLE;
    m.bot.journal = [job({ error: GONE })];
    const p = botPost(inst, { jobId: 'mgr-2', to: 'file' });
    expect(p.status).toBe(409);
    expect(p.body).toEqual({ success: false, error: UNREADABLE });
    const g = botGet();
    expect(g.status).toBe(200);
    expect(g.body).toEqual({ success: false, error: UNREADABLE });
  });
});
