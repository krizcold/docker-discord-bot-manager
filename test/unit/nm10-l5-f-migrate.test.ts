import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/docker/containerManager', async () => (await import('./migrate-fake')).cmMock());
vi.mock('../../src/env/manager', async (o) => (await import('./migrate-fake')).envMock(await o()));
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./migrate-fake')).dbLoginMock(await o()));
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./migrate-fake')).hookMock(await o()));
vi.mock('../../src/instance/maintenance', async (o) => (await import('./migrate-fake')).maintenanceMock(await o()));
vi.mock('../../src/instance/fleetBackup', async (o) => (await import('./migrate-fake')).fleetBackupMock(await o()));
vi.mock('../../src/instance/fleetReplica', async (o) => (await import('./migrate-fake')).fleetReplicaMock(await o()));
vi.mock('../../src/instance/fleetSwitch', async () => (await import('./migrate-fake')).fleetSwitchMock());

import {
  destinationPlan, getVerdict, hookAnswer, identityOf, interruptVerdict, keptClause, laneDone, pastSwitch, postVerdict, refusalVerdict, runMigration, sameDatabase, transientRefusal, MIGRATE_TIMING,
} from '../../src/instance/migrate';
import { fastTiming, getJob, m, noAnswer, resetMigrate, seedBot, COMPANION_URL, FLEET_DB, MG_FENCE_SOME, MG_NOT_AGAIN } from './migrate-fake';

const rv = (over: Record<string, unknown> = {}) => ({ to: 'file' as const, jobId: 'mgr-a', jobIds: ['mgr-a'], started: 1, kept: 0, posted: true, ...over });
const ans = (body: any, status = 200) => ({ kind: 'answer' as const, status, body });

describe('identityOf and sameDatabase', () => {
  it.each([
    ['  postgresql://u@h/db  ', 'h:5432/db'],
    ['host/postgres://db', 'host:5432/postgres://db'],
    ['postgres://u@h/db', 'h:5432/db'],
    [':h/db', null],
    ['h/db\nx', null],
    ['[::1]:5433/app', '::1:5433/app'],
    ['h/db', 'h:5432/db'],
    ['h:5433/db', 'h:5433/db'],
  ])('the string %j reads as %j', (s, want) => expect(identityOf(s)).toBe(want));
  it.each([
    [{ host: 'h', database: 'db' }, 'h:5432/db'],
    [{ host: 'h', port: null, database: 'db' }, 'h:5432/db'],
    [{ host: 'a[b', database: 'db' }, 'a[b:5432/db'],
    [{ host: 'a]b', database: 'db' }, 'a]b:5432/db'],
    [{ host: 'h', database: 'a/b' }, 'h:5432/a/b'],
    [{ host: 'h', database: 'app//' }, 'h:5432/app'],
    [{ host: '', database: 'x' }, null],
  ])('the object %j reads as %j', (d, want) => expect(identityOf(d as any)).toBe(want));
  it('two unreadable destinations are not the same database', () => expect(sameDatabase(null, null)).toBe(false));
});

describe('hookAnswer', () => {
  const r = (status: number | undefined, body: any, more: Record<string, unknown> = {}) => ({ ok: false, status, body, ...more }) as any;
  it('no status and no error reads as no answer', () => expect(hookAnswer(r(undefined, null), 'GET')).toEqual({ kind: 'noanswer', error: 'no answer', unknown: false }));
  it('a GET answer with no job key is unusable', () => expect(hookAnswer(r(200, { success: true }), 'GET')).toEqual({ kind: 'unusable', status: 200, error: 'the answer holds no readable job' }));
  it('a job that is a string is unusable', () => expect(hookAnswer(r(200, { success: true, job: 'x' }), 'GET')).toEqual({ kind: 'unusable', status: 200, error: 'the answer holds no readable job' }));
  it.each([
    [{}],
    [{ jobId: 'x', state: 'weird', to: 'file' }],
    [{ jobId: 1, state: 'running', to: 'file' }],
    [{ jobId: 'x', state: 'running', to: 'nope' }],
  ])('the job %j is not readable', job => expect(hookAnswer(r(200, { success: true, job }), 'GET').kind).toBe('unusable'));
  it('an error that is not a string falls back to the status text', () => expect(hookAnswer(r(500, { error: 5 }), 'GET')).toEqual({ kind: 'unusable', status: 500, error: 'the bot answered HTTP 500' }));
  it('a 401 with no body names the status', () => expect(hookAnswer(r(401, null), 'GET')).toEqual({ kind: 'auth', status: 401, error: 'the bot answered HTTP 401' }));
  it('a GET status 199 is not an answer', () => expect(hookAnswer(r(199, { success: true, job: null }), 'GET')).toEqual({ kind: 'unusable', status: 199, error: 'the bot answered HTTP 199' }));
  it('a GET status 500 with success is not an answer', () => expect(hookAnswer(r(500, { success: true, job: null }), 'GET').kind).toBe('unusable'));
  it('a POST status 300 is a refusal', () => expect(hookAnswer(r(300, { success: true }), 'POST')).toEqual({ kind: 'refusal', status: 300, error: 'the bot answered HTTP 300' }));
  it('a POST status 500 with success is a refusal', () => expect(hookAnswer(r(500, { success: true }), 'POST')).toEqual({ kind: 'refusal', status: 500, error: 'the bot answered HTTP 500' }));
  it('a POST 200 with success false and no error is a refusal by status', () => expect(hookAnswer(r(200, { success: false }), 'POST')).toEqual({ kind: 'refusal', status: 200, error: 'the bot answered HTTP 200' }));
  it('a POST 200 with an odd success and an error is refused by status', () => expect(hookAnswer(r(200, { success: 'x', error: 'boom' }), 'POST')).toEqual({ kind: 'refusal', status: 200, error: 'the bot answered HTTP 200' }));
  it("a GET success true carrying the can't-confirm text is an answer", () => expect(hookAnswer(r(200, { success: true, error: "can't confirm which store holds the data", job: null }), 'GET').kind).toBe('answer'));
});

describe('transientRefusal', () => {
  it('the restart-in-progress refusal is transient', () => expect(transientRefusal('A start or restart of the bot is in progress; try again once it ends')).toBe('transient'));
  it('a session text without the migration prefix is no retry', () => expect(transientRefusal('x session is still open')).toBeNull());
});

describe('pastSwitch', () => {
  it('no job is not past the switch', () => expect(pastSwitch(null, rv())).toBe(false));
  it('a job of the other direction is not', () => expect(pastSwitch({ jobId: 'mgr-a', to: 'postgres', state: 'running', stage: 'env' }, rv())).toBe(false));
  it('a done job is not', () => expect(pastSwitch({ jobId: 'mgr-a', to: 'file', state: 'done', stage: 'env' }, rv())).toBe(false));
});

describe('postVerdict', () => {
  it('a job id that is not a string is a refusal naming the state', () => {
    expect(postVerdict(ans({ success: true, jobId: 1, state: 'started', to: 'file' }), rv())).toEqual({ act: 'refusal', error: 'the bot answered without a job it names (state started)' });
  });
  it('an unknown direction is a refusal', () => {
    expect(postVerdict(ans({ success: true, jobId: 'j', state: 'running', to: 'x' }), rv())).toEqual({ act: 'refusal', error: 'the bot answered without a job it names (state running)' });
  });
  it('a running job is followed as not started', () => expect(postVerdict(ans({ success: true, jobId: 'j', state: 'running', to: 'file' }), rv())).toEqual({ act: 'follow', jobId: 'j', started: false }));
  it('a stage or error that is not a string is dropped', () => {
    expect(postVerdict(ans({ success: true, jobId: 'j', state: 'failed', to: 'file', stage: 5, error: 7 }), rv())).toEqual({ act: 'failed', job: { jobId: 'j', state: 'failed', to: 'file', stage: undefined, error: undefined, destination: undefined, leftOut: undefined } });
  });
});

describe('interrupt, GET and refusal verdicts', () => {
  const keep = { act: 'keep', keep: { kind: 'stage', stage: '', error: 'the bot gave no error' } };
  it('an interrupted job with no stage keeps with an empty stage and the default error', () => expect(interruptVerdict({ jobId: 'mgr-a', to: 'file', state: 'interrupted' }, rv())).toEqual(keep));
  it('a GET naming an earlier job of the record past the switch keeps', () => {
    const a = ans({ success: true, job: { jobId: 'mgr-0', to: 'file', state: 'interrupted', stage: 'env' } });
    expect(getVerdict(a, rv({ jobIds: ['mgr-0', 'mgr-a'] }))).toEqual({ act: 'keep', keep: { kind: 'stage', stage: 'env', error: 'the bot gave no error' } });
  });
  it('a GET naming an earlier job with no stage keeps with an empty stage', () => {
    const a = ans({ success: true, job: { jobId: 'mgr-0', to: 'file', state: 'interrupted' } });
    expect(getVerdict(a, rv({ jobIds: ['mgr-0', 'mgr-a'] }))).toEqual(keep);
  });
  it('a refusal read whose job runs the other way closes', () => {
    expect(refusalVerdict(ans({ success: true, job: { jobId: 'mgr-o', to: 'postgres', state: 'running' } }), rv())).toEqual({ act: 'close' });
  });
  it('a refusal read of the record job with no stage keeps', () => {
    expect(refusalVerdict(ans({ success: true, job: { jobId: 'mgr-a', to: 'file', state: 'interrupted' } }), rv())).toEqual(keep);
  });
});

describe('keptClause', () => {
  it('an unusable answer', () => expect(keptClause({ kind: 'unusable', status: 502, error: 'bad' }, 'file')).toBe("the bot gave an answer the manager cannot use (HTTP 502: bad), so the manager can't confirm which store holds the data"));
  it('a move to file at env', () => expect(keptClause({ kind: 'stage', stage: 'env', error: 'e' }, 'file')).toBe("the bot reports stage env, which a managed bot moving to JSON files does not reach, so the manager can't confirm which store holds the data"));
  it('no stage', () => expect(keptClause({ kind: 'stage', stage: '', error: 'e' }, 'file')).toBe("the bot reports stage none, which this manager does not know, so it can't confirm which store holds the data"));
});

describe('destinationPlan', () => {
  const inst = { sanitizedName: 'b1', fleetDb: { ...FLEET_DB } } as any;
  it('a blank URL to file reads no database', () => expect(destinationPlan(inst, '  ', 'file')).toEqual({ ok: true, companion: false, destination: null, url: '' }));
  it('the companion URL to file is no companion destination', () => expect(destinationPlan(inst, COMPANION_URL, 'file')).toEqual({ ok: true, companion: false, destination: null, url: COMPANION_URL }));
});

describe('lane texts', () => {
  beforeEach(() => { resetMigrate(); fastTiming(MIGRATE_TIMING); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('admission refuses a READ-ONLY database with no remedy', async () => {
    seedBot({ postgres: true });
    m.fence = { ok: true, on: true, owner: null, persisted: true };
    const a: any = await runMigration('b1', 'file', 'press');
    expect(a.text ?? a.error).toBe("The bot's database is READ-ONLY (this manager cannot tell which step left it so), so the migration was refused; nothing was changed");
  });
  it('admission refuses a READ-ONLY database and names the remedy', async () => {
    seedBot({ postgres: true });
    m.fence = { ok: true, on: true, owner: null, persisted: false };
    const a: any = await runMigration('b1', 'file', 'press');
    expect(a.text ?? a.error).toBe("The bot's database is READ-ONLY (this manager cannot tell which step left it so), so the migration was refused; nothing was changed; its read-only setting is not saved in the database's configuration, so restarting the instance clears it");
  });
  it('a failed start with docker silent ends with the unknown clause', async () => {
    seedBot();
    m.start = () => { m.app.b1 = null; return { success: false, error: 'compose up failed' }; };
    expect(await runMigration('b1', 'postgres', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
    expect(m.bots.b1.migrateLast.text).toBe("The migration did not start: the restart into maintenance failed (compose up failed). Nothing was copied, and the bot's state stays Maintenance. Docker did not say whether the bot runs.");
  });
  it('a re-POST whose fence fails parks with the fence clause and the meanwhile tail', async () => {
    seedBot({ postgres: true });
    m.bots.b1.migrate = {
      to: 'file', from: 'postgres', destination: null, companion: false, jobId: 'mgr-a', jobIds: ['mgr-a'], posted: true, started: 1, kept: 0,
      phase: 'waiting', resumeAt: 'posting', loginOpened: false, sharers: [], sharersStopped: [], openedAt: 'x',
    };
    m.fenceUp = 'psql failed';
    expect(await runMigration('b1', 'file', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
    expect(m.bots.b1.migrate.text).toBe(MG_NOT_AGAIN("the manager could not close the bot's database to other connections (psql failed), which a move to JSON files from that database needs before the bot renames its data aside") + MG_FENCE_SOME);
  });
  it('a bot naming an IPv6 database the manager did not pass names it in brackets', async () => {
    seedBot({ url: 'postgresql://u:p@db.example.test:5432/app' });
    m.bot.destination = { host: 'fd00::2', port: 5432, database: 'app' };
    expect(await runMigration('b1', 'postgres', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
    expect(m.bots.b1.migrate.text).toContain('the bot names [fd00::2]:5432/app, and the manager passed db.example.test:5432/app.');
  });
  it.each([
    [600_000, '10 minutes'],
    [1_000, '1 second'],
  ])('a silence of %i ms is named %s', async (ms, span) => {
    seedBot();
    Object.assign(MIGRATE_TIMING, { silentParkMs: ms, silentCheckMs: 10_000_000 });
    let clock = 1_000_000;
    let n = 0;
    const g = () => {
      if (!m.bot.posts.length) return getJob(null);
      if (++n === 1) vi.spyOn(Date, 'now').mockImplementation(() => clock);
      else clock += ms;
      return noAnswer('cut');
    };
    for (let k = 0; k < 10; k++) m.bot.getQueue.push(g);
    expect(await runMigration('b1', 'postgres', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
    expect(m.bots.b1.migrate.text).toContain(`the bot has not answered for ${span} (cut)`);
  });
});
