import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/docker/containerManager', async () => (await import('./migrate-fake')).cmMock());
vi.mock('../../src/env/manager', async (o) => (await import('./migrate-fake')).envMock(await o()));
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./migrate-fake')).dbLoginMock(await o()));
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./migrate-fake')).hookMock(await o()));
vi.mock('../../src/instance/maintenance', async (o) => (await import('./migrate-fake')).maintenanceMock(await o()));
vi.mock('../../src/instance/fleetBackup', async (o) => (await import('./migrate-fake')).fleetBackupMock(await o()));
vi.mock('../../src/instance/fleetReplica', async (o) => (await import('./migrate-fake')).fleetReplicaMock(await o()));
vi.mock('../../src/instance/fleetSwitch', async () => (await import('./migrate-fake')).fleetSwitchMock());

import { getVerdict, hookAnswer, laneDone, postVerdict, refusalVerdict, resumeMigrations, runMigration, setMigrateListener, transientRefusal, MIGRATE_TIMING } from '../../src/instance/migrate';
import { fastTiming, m, refusal, resetMigrate, seedBot, unknownPost, COMPANION_URL, FLEET_DB } from './migrate-fake';

beforeEach(() => { resetMigrate(); fastTiming(MIGRATE_TIMING); });
afterEach(() => { setMigrateListener(null); vi.restoreAllMocks(); });

const RS2 = "The bot process is still starting; can't confirm whether it boots in maintenance; try again once it has started";
const RS4 = 'A start or restart of the bot is in progress; try again once it ends';
const FORM_A = (id: string) => `Migration ${id}'s database session is still open; the database ends it once it notices the connection is gone; run the migration again once it no longer shows`;
const FORM_B = (id: string) => `Migration ${id}, which is not this bot's last one, holds a session on this database; run this migration once it no longer shows`;
const FORM_C = "1 other session(s) of the bot's database role are connected (smdb-bot: 1); stop every bot on this database first";
const S2S = FORM_A('mgr-old');
const S2B = FORM_B('mgr-old');
const S0S = "can't confirm; migration mgr-old's database session is still open; the database ends it once it notices the connection is gone; run the migration again once it no longer shows";
const BOTS = "1 other session(s) of the bot's database role are connected (smdb-bot: 1); stop every bot on this database first. " + S2S;
const OTHER = FORM_B('mgr-x');
const STOP = 'Stop the bot first';
const FIRST = 'The job stopped at its first checks; nothing was changed';
const REFUSED = (e: string, src: string) => `The bot refused the migration: ${e}. Nothing was switched: the bot stays in Maintenance and keeps its data in ${src}.`;
const P_SESSION = (id: string, n: number) => `Migration ${id}: the bot waits for an earlier migration's database session to end (${n} seconds so far)`;
const S0S_REFUSAL = () => ({ ...refusal(S0S), body: { success: false, error: S0S, jobId: 'mgr-old', to: 'postgres' } });

const REC = { to: 'postgres' as const, jobId: 'mgr-a', jobIds: ['mgr-e', 'mgr-p', 'mgr-a'], started: 1, kept: 0, posted: true };
const got = (job: Record<string, unknown>) => hookAnswer({ ok: true, status: 200, body: { success: true, job } }, 'GET');
const failedJob = (jobId: string, stage: string, error: string) => ({ jobId, to: 'postgres', state: 'failed', stage, error });

describe('NM10F: the verdicts on a job failed at its first checks', () => {
  it.each([
    ['T-V1', 'mgr-a', 'checking', RS2, 'transient'],
    ['T-V2', 'mgr-a', 'checking', RS4, 'transient'],
    ['T-V3', 'mgr-a', 'checking', S2S, 'session'],
    ['T-V12', 'mgr-a', 'checking', FORM_B('mgr-e'), 'session'],
    ['T-V13', 'mgr-a', 'checking', S2B, 'session'],
    ['T-V14', 'mgr-a', 'checking', `${FORM_B('mgr-e')}. ${S2S}`, 'session'],
    ['T-V15', 'mgr-a', 'checking', `${S2S}. ${FORM_B('mgr-p')}`, 'session'],
  ])('%s getVerdict retries the record\'s own job', (_n, jobId, stage, error, why) => {
    const v = getVerdict(got(failedJob(jobId, stage, error)), REC, ['mgr-old']);
    expect(v).toEqual({ act: 'transient', why, job: expect.objectContaining({ jobId, state: 'failed', stage, error }) });
  });
  it.each([
    ['T-V4', 'mgr-a', 'checking', STOP, { act: 'failed' }],
    ['T-V5', 'mgr-a', 'checking', BOTS, { act: 'failed' }],
    ['T-V6', 'mgr-a', 'checking', OTHER, { act: 'failed' }],
    ['T-V7', 'mgr-a', 'checking', FIRST, { act: 'failed' }],
    ['T-V8', 'mgr-a', 'reading', S2S, { act: 'failed' }],
    ['T-V9', 'mgr-old', 'checking', RS2, { act: 'repost', why: 'other' }],
    ['T-V16', 'mgr-a', 'checking', S2B, { act: 'failed' }],
    ['T-V17', 'mgr-a', 'checking', `${FORM_B('mgr-e')}. ${OTHER}`, { act: 'failed' }],
  ])('%s getVerdict keeps its verdict', (_n, jobId, stage, error, want) => {
    expect(getVerdict(got(failedJob(jobId, stage, error)), REC)).toMatchObject(want);
  });
  it('T-V10 refusalVerdict closes on the record\'s job failed with RS-2', () => {
    expect(refusalVerdict(got(failedJob('mgr-a', 'checking', RS2)), REC)).toEqual({ act: 'close' });
  });
  it('T-V11 postVerdict retries S0\'s session refusal', () => {
    expect(postVerdict(hookAnswer(S0S_REFUSAL() as any, 'POST'), REC)).toEqual({ act: 'retry', why: 'session', error: S0S });
  });
  it.each([
    ['S2S', S2S, 'session'],
    ['BOTS', BOTS, null],
    ['OTHER', OTHER, null],
    ['STOP', STOP, null],
    ['RS2', RS2, 'transient'],
    ['S0S', S0S, 'session'],
    ['RS4', RS4, 'transient'],
    ['form A alone', FORM_A('mgr-z'), 'session'],
    ['form B in the set', FORM_B('mgr-a'), 'session'],
    ['form B outside the set', OTHER, null],
    ['form C alone', FORM_C, null],
    ['A then B, both allowed', `${FORM_A('mgr-a')}. ${FORM_B('mgr-b')}`, 'session'],
    ['B then A, both allowed', `${FORM_B('mgr-b')}. ${FORM_A('mgr-z')}`, 'session'],
    ['B outside then A', `${OTHER}. ${FORM_A('mgr-z')}`, null],
    ['C then A', `${FORM_C}. ${FORM_A('mgr-z')}`, null],
    ['A with a trailing word', `${FORM_A('mgr-z')} now`, null],
    ['unknown text', 'Migration mgr-a failed', null],
    ['empty', '', null],
  ])('transientRefusal(%s)', (_n, error, want) => {
    expect(transientRefusal(error, ['mgr-a', 'mgr-b'])).toBe(want);
  });
});

async function press() {
  expect(await runMigration('b1', 'postgres', 'press')).toEqual({ accepted: true });
  await laneDone('b1');
}
const posts = () => m.bot.posts;
const last = () => m.bots.b1.migrateLast;
const writes = () => m.migrateWrites.map(w => w.rec).filter(Boolean);
const OLD = { sessions: ['mgr-old'] };
/** The bot's last job is mgr-old, a migration to postgres that failed before this press. */
function seedOld() {
  seedBot();
  m.bot.journal = [{ jobId: 'mgr-old', to: 'postgres', state: 'failed', stage: 'reading', error: 'The job stopped before it finished; the old store still serves' }];
}
const parked = (over: Record<string, unknown>) => ({ to: 'postgres', from: 'file', destination: 'b1-fleet-postgres:5432/smdb', companion: true, jobId: 'mgr-a', jobIds: ['mgr-a'], posted: true, started: 1, kept: 0, phase: 'waiting', resumeAt: 'following', loginOpened: false, sharers: [], sharersStopped: [], openedAt: 'x', ...over });

describe('NM10F: the lane retries a job failed at its first checks', () => {
  let texts: string[] = [];
  beforeEach(() => { texts = []; setMigrateListener((_id, ev) => texts.push(ev.text)); });

  function clock(): { at: number } {
    const c = { at: 1_000_000 };
    vi.spyOn(Date, 'now').mockImplementation(() => c.at);
    return c;
  }

  it.each([['T-L1', RS2], ['T-L2', RS4]])('%s two refusals at checking: a new jobId each, then done', async (_n, error) => {
    seedBot();
    Object.assign(MIGRATE_TIMING, { readyMs: 0, windowMs: 60_000 });
    m.bot.checks.push(error, error);
    await press();
    const ids = posts().map(p => p.jobId);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    for (const j of m.bot.journal.slice(0, 2)) expect(j).toMatchObject({ state: 'failed', stage: 'checking', error });
    expect(last()).toMatchObject({ outcome: 'done', jobId: ids[2] });
    expect(writes().every(r => r.started <= 1)).toBe(true);
  });

  it('T-L3 two session refusals at checking: P-SESSION names the failed job, then done', async () => {
    seedOld();
    Object.assign(MIGRATE_TIMING, { readyMs: 0, windowMs: 60_000, sessionMs: 60_000 });
    m.bot.checks.push(OLD, OLD);
    await press();
    expect(posts()).toHaveLength(3);
    expect(texts).toContain(P_SESSION(posts()[0].jobId, 0));
    expect(last()).toMatchObject({ outcome: 'done' });
  });

  it('T-L4 the session refusal past its bound goes to E: MG-REFUSED', async () => {
    seedOld();
    for (let i = 0; i < 1000; i++) m.bot.checks.push(OLD);
    await press();
    expect(posts().length).toBeGreaterThanOrEqual(3);
    expect(last()).toMatchObject({ outcome: 'failed', text: REFUSED(S2B, 'its JSON files') });
  });

  it('T-L5 the window opened at the first POST carries: no POST past it', async () => {
    seedBot();
    const c = clock();
    Object.assign(MIGRATE_TIMING, { readyMs: 0, windowMs: 60_000 });
    m.bot.checks.push(() => { c.at += 59_999; return RS2; }, () => { c.at += 2; return RS2; }, () => RS2);
    await press();
    expect(posts()).toHaveLength(2);
    expect(last().text).toBe(REFUSED(RS2, 'its JSON files'));
  });

  it('T-L6 the session bound carries from the first session answer', async () => {
    seedOld();
    const c = clock();
    Object.assign(MIGRATE_TIMING, { readyMs: 0, windowMs: 60_000, sessionMs: 60_000 });
    m.bot.checks.push(() => OLD, () => { c.at += 60_000; return OLD; }, () => OLD);
    await press();
    expect(posts()).toHaveLength(2);
    expect(last().text).toBe(REFUSED(S2B, 'its JSON files'));
  });

  it('T-L7 post()\'s session bound carries into follow()', async () => {
    seedOld();
    m.bots.b1.migrate = parked({ jobId: 'mgr-old', jobIds: ['mgr-p', 'mgr-old'], resumeAt: 'posting' });
    const c = clock();
    Object.assign(MIGRATE_TIMING, { readyMs: 0, windowMs: 120_000, sessionMs: 60_000 });
    m.bot.postQueue.push(S0S_REFUSAL());
    m.bot.checks.push(() => { c.at += 60_000; return { sessions: ['mgr-p'] }; }, () => ({ sessions: ['mgr-p'] }));
    await press();
    expect(posts()).toHaveLength(2);
    expect(last().text).toBe(REFUSED(FORM_B('mgr-p'), 'its JSON files'));
  });

  it('T-L8 jobs failed at checking do not count against the cap', async () => {
    seedBot();
    Object.assign(MIGRATE_TIMING, { readyMs: 0, windowMs: 60_000 });
    m.bot.checks.push(RS2, RS2, RS2);
    m.bot.script = [{ state: 'interrupted', stage: 'copying', error: 'The job stopped before it finished; the old store still serves' }, { stage: 'copying' }, { state: 'done', stage: 'switching' }];
    await press();
    expect(posts()).toHaveLength(5);
    expect(last()).toMatchObject({ outcome: 'done', jobId: posts()[4].jobId });
    expect(Math.max(...writes().map(r => r.started))).toBe(2);
  });

  it('T-L9 the early GET falls through on the retry act: the database starts, then a new job', async () => {
    seedBot({ url: COMPANION_URL, inst: { fleetDb: { ...FLEET_DB } } });
    m.bots.b1.migrate = parked({});
    m.app.b1 = false;
    m.sidecar['b1-fleet-postgres'] = false;
    m.bot.journal = [{ jobId: 'mgr-a', to: 'postgres', state: 'failed', stage: 'checking', error: RS2 }];
    Object.assign(MIGRATE_TIMING, { readyMs: 0, windowMs: 60_000 });
    await press();
    const a = m.events.indexOf('start:migrate');
    expect(a).toBeGreaterThanOrEqual(0);
    expect(m.events.indexOf('db-start:b1')).toBeGreaterThan(a);
    expect(posts()).toHaveLength(1);
    expect(posts()[0].jobId).not.toBe('mgr-a');
    expect(last()).toMatchObject({ outcome: 'done', jobId: posts()[0].jobId });
  });

  it('T-L10 a resume at following opens its own window and takes back no count', async () => {
    seedBot({ url: COMPANION_URL, inst: { fleetDb: { ...FLEET_DB } } });
    m.bots.b1.migrate = parked({ phase: 'following', resumeAt: undefined });
    delete m.bots.b1.migrate.resumeAt;
    m.sidecar['b1-fleet-postgres'] = true;
    m.bot.journal = [{ jobId: 'mgr-a', to: 'postgres', state: 'failed', stage: 'checking', error: RS2 }];
    Object.assign(MIGRATE_TIMING, { readyMs: 0, windowMs: 60_000 });
    resumeMigrations();
    await new Promise(r => setTimeout(r, 0));
    await laneDone('b1');
    expect(posts()).toHaveLength(1);
    const id = posts()[0].jobId;
    expect(id).not.toBe('mgr-a');
    expect(writes().find(r => r.jobId === id)).toMatchObject({ started: 1 });
    expect(last()).toMatchObject({ outcome: 'done', jobId: id });
  });

  it('T-L11 an operator refusal at checking closes MG-FAILED', async () => {
    seedBot();
    m.bot.checks.push(STOP);
    await press();
    expect(posts()).toHaveLength(1);
    expect(last().text).toBe(`Migration ${posts()[0].jobId} failed at checking: Stop the bot first. Nothing was switched: the bot stays in Maintenance and keeps its data in its JSON files.`);
  });

  it('T-L12 the other-sessions refusal closes MG-FAILED', async () => {
    seedBot();
    m.bot.checks.push(BOTS);
    await press();
    expect(posts()).toHaveLength(1);
    expect(last().text.startsWith(`Migration ${posts()[0].jobId} failed at checking: 1 other session(s)`)).toBe(true);
  });

  it('T-L13 a lingering session of mgr-old: form A, then form B on the retries; the 5-minute bound ends MG-REFUSED', async () => {
    seedOld();
    for (let i = 0; i < 1000; i++) m.bot.checks.push(OLD);
    await press();
    expect(m.bot.journal[1].error).toBe(S2S);
    expect(m.bot.journal[2].error).toBe(S2B);
    expect(posts().length).toBeGreaterThanOrEqual(3);
    expect(texts.some(t => t.includes('failed at checking'))).toBe(false);
    expect(last()).toMatchObject({ outcome: 'failed', text: REFUSED(S2B, 'its JSON files') });
  });

  it('T-L14 form B naming a job outside the record and the episode closes MG-FAILED at once', async () => {
    seedOld();
    m.bot.checks.push({ sessions: ['mgr-x'] });
    await press();
    expect(posts()).toHaveLength(1);
    expect(last().text).toBe(`Migration ${posts()[0].jobId} failed at checking: ${OTHER}. Nothing was switched: the bot stays in Maintenance and keeps its data in its JSON files.`);
  });

  it('T-L15 a bot-sessions part beside form A closes MG-FAILED at once', async () => {
    seedOld();
    m.bot.checks.push({ sessions: ['mgr-old'], bots: 1 });
    await press();
    expect(posts()).toHaveLength(1);
    expect(m.bot.journal[1].error).toBe(`${FORM_C}. ${S2S}`);
    expect(last().text).toBe(`Migration ${posts()[0].jobId} failed at checking: ${FORM_C}. ${S2S}. Nothing was switched: the bot stays in Maintenance and keeps its data in its JSON files.`);
  });

  it('T-L16 a job post() did not count fails with form A: started is unchanged', async () => {
    seedBot();
    Object.assign(MIGRATE_TIMING, { readyMs: 0, windowMs: 60_000, sessionMs: 60_000 });
    m.bot.script = [{ state: 'interrupted', stage: 'reading', error: 'The job stopped before it finished; the old store still serves' }];
    m.bot.postQueue.push(null, () => {
      const n1 = posts()[0].jobId;
      m.bot.journal.push({ jobId: posts()[1].jobId, to: 'postgres', state: 'running', stage: 'checking' });
      m.bot.script = [{ state: 'failed', stage: 'checking', error: FORM_A(n1) }, { stage: 'copying' }, { state: 'done', stage: 'switching' }];
      return unknownPost();
    });
    await press();
    const ids = [...new Set(posts().map(p => p.jobId))];
    expect(ids).toHaveLength(3);
    expect(posts().filter(p => p.jobId === ids[1])).toHaveLength(2);
    expect(writes().find(r => r.jobId === ids[2])).toMatchObject({ started: 1 });
    expect(last()).toMatchObject({ outcome: 'done', jobId: ids[2] });
  });

  it('T-L17 a job post() counted fails with form A: started goes back by 1', async () => {
    seedOld();
    Object.assign(MIGRATE_TIMING, { readyMs: 0, windowMs: 60_000, sessionMs: 60_000 });
    m.bot.checks.push(OLD);
    await press();
    expect(posts()).toHaveLength(2);
    expect(Math.max(...writes().filter(r => r.jobId === posts()[0].jobId).map(r => r.started))).toBe(1);
    expect(writes().find(r => r.jobId === posts()[1].jobId)).toMatchObject({ started: 0 });
    expect(last()).toMatchObject({ outcome: 'done', jobId: posts()[1].jobId });
  });
});
