import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/docker/containerManager', async () => (await import('./migrate-fake')).cmMock());
vi.mock('../../src/env/manager', async (o) => (await import('./migrate-fake')).envMock(await o()));
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./migrate-fake')).dbLoginMock(await o()));
vi.mock('../../src/instance/appHookClient', async (o) => {
  const f: any = (await import('./migrate-fake')).hookMock(await o());
  const call = f.callAppHook;
  return {
    ...f,
    callAppHook: (inst: unknown, action: string, method: string, body: unknown, ms: number) => {
      ((globalThis as any).__l5iCalls ??= []).push({ action, method, body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)) });
      return call(inst, action, method, body, ms);
    },
  };
});
vi.mock('../../src/instance/maintenance', async (o) => (await import('./migrate-fake')).maintenanceMock(await o()));
vi.mock('../../src/instance/fleetBackup', async (o) => (await import('./migrate-fake')).fleetBackupMock(await o()));
vi.mock('../../src/instance/fleetReplica', async (o) => (await import('./migrate-fake')).fleetReplicaMock(await o()));
vi.mock('../../src/instance/fleetSwitch', async () => (await import('./migrate-fake')).fleetSwitchMock());

import { laneDone, resumeMigrations, runMigration, setMigrateListener, MIGRATE_TIMING } from '../../src/instance/migrate';
import { fastTiming, getJob, http, m, noAnswer, postJob, refusal, resetMigrate, seedBot, seedSharer, unknownPost, COMPANION_URL, EXTERNAL_URL, FLEET_DB, MG_DONE_OPEN, MG_DONE_UNSURE } from './migrate-fake';

const P_DB = 'Starting the managed database';
const P_LOGIN = "Opening the bot's database login";
const P_SAVE = 'Asking the bot to save what it holds';
const P_RESTART = 'Restarting the bot into maintenance';
const P_POST = (id: string) => `Starting migration ${id}`;
const P_RUN = (id: string) => `Migration ${id} is running`;
const P_STAGE = (id: string, stage: string) => `Migration ${id}: ${stage}`;
const P_SESSION = (id: string, n: number) => `Migration ${id}: the bot waits for an earlier migration's database session to end (${n} seconds so far)`;
const DB_SETUP = (err: string) => `The migration did not start: the managed database could not be set up (${err}). Nothing was copied, and the bot stays in Maintenance.`;
const DB_START = (err: string) => `The migration did not start: the managed database did not start (${err}). Nothing was copied, and the bot stays in Maintenance.`;
const LOGIN = (reason: string) => `The migration did not start: the bot's database login could not be opened (${reason}). Nothing was copied, and the bot stays in Maintenance.`;
const UNSAVED_UNKNOWN = (reason: string) => `The migration did not start: the bot did not confirm that it saved every change it holds (${reason}). Nothing was copied, and the bot stays in Maintenance; press Migrate to try again.`;
const RESTART = (err: string, tail: string) => `The migration did not start: the restart into maintenance failed (${err}). Nothing was copied, and the bot's state stays Maintenance.${tail}`;
const FAILED = (jobId: string, stage: string, err: string, source: string) => `Migration ${jobId} failed at ${stage}: ${err}. Nothing was switched: the bot stays in Maintenance and keeps its data in ${source}.`;
const SPENT = (jobId: string, stage: string, err: string, source: string) => `Migration ${jobId} was interrupted at ${stage} (${err}), and the manager has started it three times. Nothing was switched: the bot stays in Maintenance and keeps its data in ${source}. Press Migrate to try again.`;
const NOT_REC = (err: string) => `The manager could not record the migration's progress (${err}), so it stopped here with the migration open. Press Migrate to go on.`;
const DB_WAIT = (jobId: string, err: string) => `Migration ${jobId} is not finished, and the bot's database did not accept connections within 30 seconds of the start (${err}). The bot stays in Maintenance with the migration open; press Migrate to try again.`;
const UNKNOWN_POST = (jobId: string) => `The manager can't confirm whether migration ${jobId} started: the bot did not answer within 30 seconds, three times. The bot stays in Maintenance; press Migrate to ask again.`;
const NOT_READY_DB = 'b1-fleet-postgres: it did not accept connections within 30 seconds of the restart';
const SESSION_REFUSAL = "can't confirm; migration mgr-old left its database session is still open";
const DEST = { host: 'b1-fleet-postgres', port: 5432, database: 'smdb' };

let evs: Array<{ text: string; final: boolean }> = [];
let lines: string[] = [];
const calls = (): Array<{ action: string; method: string; body: any }> => (globalThis as any).__l5iCalls;

beforeEach(() => {
  resetMigrate();
  fastTiming(MIGRATE_TIMING);
  evs = [];
  lines = [];
  (globalThis as any).__l5iCalls = [];
  setMigrateListener((id, e) => { if (id === 'b1') evs.push({ ...e }); });
  for (const k of ['log', 'warn', 'error'] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { lines.push(`${k}: ${a.map(String).join(' ')}`); });
});
afterEach(() => {
  setMigrateListener(null);
  vi.restoreAllMocks();
});

const rec = () => m.bots.b1.migrate;
const last = () => m.bots.b1.migrateLast;
const texts = () => evs.map(e => e.text);
const writes = () => m.migrateWrites.map(w => w.rec);

async function press(to: 'postgres' | 'file' = 'postgres') {
  expect(await runMigration('b1', to, 'press')).toEqual({ accepted: true });
  await laneDone('b1');
}
async function resume() {
  resumeMigrations();
  await new Promise(r => setTimeout(r, 0));
  await laneDone('b1');
}
/** A record as post() and follow() leave it, for a resume at `phase`. */
function seedAt(phase: string, to: 'postgres' | 'file' = 'postgres', over: Record<string, unknown> = {}) {
  if (to === 'postgres') seedBot({ url: COMPANION_URL, inst: { fleetDb: { ...FLEET_DB } } });
  else seedBot({ postgres: true });
  m.bots.b1.migrate = {
    to, from: to === 'postgres' ? 'file' : 'postgres', destination: to === 'postgres' ? 'b1-fleet-postgres:5432/smdb' : null, companion: to === 'postgres',
    jobId: 'mgr-a', jobIds: ['mgr-a'], posted: true, started: 1, kept: 0, phase, loginOpened: false, sharers: [], sharersStopped: [], openedAt: 'x',
    ...(to === 'file' ? { hbaFence: 'migrate:1', hbaFenceSet: true, isolated: true } : {}), ...over,
  };
}
const ours = (state: string, stage = 'copying', to: 'postgres' | 'file' = 'postgres') => getJob({ jobId: 'mgr-a', to, state, stage, ...(to === 'postgres' ? { destination: DEST } : {}) });

describe('M1b: the restart after a Stop', () => {
  it('following on the companion, the bot stopped: its database not ready after the start parks with MG-DB-WAIT', async () => {
    seedAt('following');
    m.app.b1 = false;
    m.dbReady = false;
    await resume();
    expect(m.events).toContain('start:migrate');
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'following', text: DB_WAIT('mgr-a', NOT_READY_DB) });
  });
  it('following a move to JSON files, the bot stopped: the managed source not ready after the start parks with MG-DB-WAIT', async () => {
    seedAt('following', 'file');
    m.app.b1 = false;
    m.dbReady = false;
    await resume();
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'following', text: DB_WAIT('mgr-a', NOT_READY_DB) });
    expect(m.events).not.toContain('hba-refresh');
  });
  it('finishing a move to JSON files, the bot stopped: no wait for the old database and no renewal of its lines before G', async () => {
    seedAt('finishing', 'file');
    m.bot.journal.push({ jobId: 'mgr-a', to: 'file', state: 'done', stage: 'switching' });
    m.app.b1 = false;
    m.dbReady = false;
    await resume();
    expect(m.events).toContain('start:migrate');
    expect(m.events).not.toContain('hba-refresh');
    expect(m.events.filter(e => e.startsWith('db-ready'))).toEqual([]);
    expect(writes().some(r => r?.text === DB_WAIT('mgr-a', NOT_READY_DB))).toBe(false);
  });
});

describe('park: the wait recorded', () => {
  it('the wait written: one final broadcast of its text', async () => {
    seedBot();
    m.bot.postQueue.push(unknownPost(), unknownPost(), unknownPost());
    await press();
    const id = m.bot.posts[0].jobId;
    expect(rec()).toMatchObject({ phase: 'waiting', text: UNKNOWN_POST(id) });
    expect(evs[evs.length - 1]).toEqual({ text: UNKNOWN_POST(id), final: true });
  });
  it('the wait not written: the error line, and one final broadcast of the text with the not-recorded clause', async () => {
    seedBot();
    m.bot.postQueue.push(unknownPost(), unknownPost(), unknownPost());
    m.failMigrateWrite = (_n, r) => (r?.phase === 'waiting' ? 'disk full' : null);
    await press();
    const id = m.bot.posts[0].jobId;
    expect(rec().phase).toBe('posting');
    expect(lines).toContain('error: [Migrate] B1: the wait could not be recorded: disk full');
    expect(evs.filter(e => e.final)).toEqual([{ text: `${UNKNOWN_POST(id)} ${NOT_REC('disk full')}`, final: true }]);
    expect(lines.some(l => l.includes('waits for the operator'))).toBe(false);
  });
});

describe('M2 to M6: prepare', () => {
  it('a press to Postgres on the companion: its progress lines in order, its effects in order, and the save body', async () => {
    seedBot();
    await press();
    const id = m.bot.posts[0].jobId;
    expect(evs.filter(e => !e.final).map(e => e.text).slice(0, 6)).toEqual([P_DB, P_LOGIN, P_SAVE, P_RESTART, P_POST(id), P_RUN(id)]);
    expect(evs).toContainEqual({ text: P_POST(id), final: false });
    expect(m.events.slice(0, m.events.indexOf(`POST:${id}`) + 1)).toEqual(EXPECT_PG_PRESS(id));
    expect(writes().filter(r => r && 'isolated' in r)).toEqual([]);
    expect(calls().filter(c => c.action === 'maintenance')).toEqual([{ action: 'maintenance', method: 'POST', body: { state: 'maintenance', message: 'Back soon' } }]);
    expect(lines).toContain(`log: [Migrate] B1: migration ${id} to postgres: the bot answered started`);
    expect(last()).toMatchObject({ outcome: 'done' });
  });
  it('the companion URL names a database other than the one admission read: that destination is saved before the POST', async () => {
    seedBot();
    const url = 'postgresql://smdb:pw@b1-fleet-postgres:5432/botdata';
    m.ensure = () => {
      m.env.b1.DATA_BACKEND_URL = url;
      m.bots.b1.fleetDb = { ...FLEET_DB, db: 'botdata' };
      return { ...FLEET_DB, db: 'botdata', password: 'pw' };
    };
    await press();
    const at = m.events.indexOf('db-start:b1');
    expect(m.migrateWrites[m.events.slice(0, at).filter(e => e.startsWith('record:')).length].rec).toMatchObject({ destination: 'b1-fleet-postgres:5432/botdata' });
    expect(m.bot.posts[0].url).toBe(url);
    expect(last()).toMatchObject({ outcome: 'done' });
  });
  it('no managed database applies: MG-DB-SETUP names it', async () => {
    seedBot();
    m.ensure = () => null;
    await press();
    expect(last().text).toBe(DB_SETUP('no managed database applies to this bot'));
  });
  it('the attach fails with no error: MG-DB-SETUP says no reason was given', async () => {
    seedBot();
    m.attach = { success: false };
    await press();
    expect(last().text).toBe(DB_SETUP('no reason given'));
  });
  it('the companion does not start, with no error: MG-DB-START says no reason was given', async () => {
    seedBot();
    m.dbStart = { success: false };
    await press();
    expect(last().text).toBe(DB_START('no reason given'));
  });
  it('a JSON bot that keeps a stopped managed database moves to an external URL: that database is not started', async () => {
    seedBot({ url: EXTERNAL_URL, inst: { fleetDb: { ...FLEET_DB } } });
    m.sidecar[FLEET_DB.containerName] = false;
    m.bot.destination = { host: 'db.example.test', port: 5432, database: 'app' };
    await press();
    expect(m.events.filter(e => e.startsWith('db-start'))).toEqual([]);
    expect(texts()).not.toContain(P_DB);
    expect(last()).toMatchObject({ outcome: 'done' });
  });
  it('a move to JSON files from a running managed database: it is not started again', async () => {
    seedBot({ postgres: true });
    await press('file');
    expect(m.events.filter(e => e.startsWith('db-start'))).toEqual([]);
    expect(texts()).not.toContain(P_DB);
    expect(last()).toMatchObject({ outcome: 'done' });
  });
  it('a move to JSON files from a stopped managed database: it is started with its progress line, then the move goes on', async () => {
    seedBot({ postgres: true });
    m.sidecar[FLEET_DB.containerName] = false;
    await press('file');
    expect(m.events.filter(e => e.startsWith('db-start'))).toEqual(['db-start:b1']);
    expect(texts()[0]).toBe(P_DB);
    expect(last()).toMatchObject({ outcome: 'done' });
  });
  it('a move to JSON files from a stopped managed database that does not start, with no error: MG-DB-START', async () => {
    seedBot({ postgres: true });
    m.sidecar[FLEET_DB.containerName] = false;
    m.dbStart = { success: false };
    await press('file');
    expect(last().text).toBe(DB_START('no reason given'));
  });
  it('a shutdown while the companion starts: the lane ends before the login is read', async () => {
    seedBot();
    m.dbStart = { get success() { m.shuttingDown = true; return true; } } as any;
    await press();
    expect(m.events).not.toContain('login-read');
    expect(rec().phase).toBe('preparing');
  });
  it('a shutdown while the login is read: the lane ends before the save is asked for', async () => {
    seedBot();
    const login = { canLogin: true, sessions: 0 } as any;
    Object.defineProperty(login, 'inRecovery', { enumerable: true, get() { m.shuttingDown = true; return false; } });
    m.login = login;
    await press();
    expect(m.events).toContain('login-read');
    expect(texts()).not.toContain(P_SAVE);
    expect(m.events).not.toContain('hook:maintenance');
  });
  it('the bot role does not exist: MG-LOGIN names the role', async () => {
    seedBot();
    m.login = { inRecovery: false, canLogin: null, sessions: 0 };
    await press();
    expect(last().text).toBe(LOGIN('the role smdb does not exist'));
  });
  it('a login that can already log in is not opened', async () => {
    seedBot();
    await press();
    expect(m.events).not.toContain('login-open');
    expect(writes().some(r => r?.loginOpened === true)).toBe(false);
  });
  it('no try of the save hook at all: MG-UNSAVED says no answer came', async () => {
    seedBot();
    MIGRATE_TIMING.saveTries = 0;
    await press();
    expect(last().text).toBe(UNSAVED_UNKNOWN('no answer'));
  });
  it('the pause comes between the tries of the save hook, not before the first', async () => {
    seedBot();
    MIGRATE_TIMING.savePauseMs = 300;
    const at: number[] = [];
    m.saveAnswers.push(() => { at.push(Date.now()); return { ok: false, status: 500, error: 'busy' }; });
    m.saveAnswers.push(() => { at.push(Date.now()); return { ok: true, status: 200, body: { success: true, saved: true } }; });
    const t0 = Date.now();
    await press();
    expect(at).toHaveLength(2);
    expect(at[0] - t0).toBeLessThan(250);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(280);
    expect(last()).toMatchObject({ outcome: 'done' });
  });
  it('a shutdown during a failed try of the save hook: no further try', async () => {
    seedBot();
    m.saveAnswers.push(() => { m.shuttingDown = true; return { ok: false, status: 500, error: 'busy' }; });
    await press();
    expect(m.events.filter(e => e === 'hook:maintenance')).toHaveLength(1);
  });
  it('every try answered with an HTTP error and no text: MG-UNSAVED says no reason was given', async () => {
    seedBot();
    for (let i = 0; i < 6; i++) m.saveAnswers.push({ ok: false, status: 500 });
    await press();
    expect(last().text).toBe(UNSAVED_UNKNOWN('the bot answered: no reason given'));
  });
  it('every try left with no answer: MG-UNSAVED names the 30 seconds', async () => {
    seedBot();
    for (let i = 0; i < 6; i++) m.saveAnswers.push({ ok: false, unknown: true, error: 'timeout' });
    await press();
    expect(last().text).toBe(UNSAVED_UNKNOWN('no answer within 30 seconds'));
  });
  it('a shutdown during the save of a move to JSON files: the other bots are not searched and no line is written', async () => {
    seedBot({ postgres: true });
    m.saveAnswers.push(() => { m.shuttingDown = true; return { ok: true, status: 200, body: { success: true, saved: true } }; });
    await press('file');
    expect(m.events.filter(e => e.startsWith('hba-'))).toEqual([]);
    expect(writes().some(r => r?.hbaFence || r?.isolated)).toBe(false);
  });
  it('a shutdown while the lines are written: the bot is not restarted', async () => {
    seedBot({ postgres: true });
    m.fenceUp = () => { m.shuttingDown = true; return null; };
    await press('file');
    expect(m.events).toContain('hba-fence');
    expect(m.events.filter(e => e.startsWith('stop:') || e.startsWith('start:'))).toEqual([]);
  });
  it('the stop into maintenance fails with no error: MG-RESTART says no reason was given', async () => {
    seedBot();
    m.stop = { success: false };
    await press();
    expect(last().text).toBe(RESTART('no reason given', ''));
  });
  it('the start into maintenance fails with no error: MG-RESTART with the stopped clause', async () => {
    seedBot();
    m.start = { success: false };
    await press();
    expect(last().text).toBe(RESTART('no reason given', ' The bot is stopped; start it before pressing Migrate again.'));
  });
  it('the start fails and docker does not say whether the bot runs: MG-RESTART with the unknown clause', async () => {
    seedBot();
    m.start = (id: string) => { m.app[id] = null; return { success: false, error: 'boom' }; };
    await press();
    expect(last().text).toBe(RESTART('boom', ' Docker did not say whether the bot runs.'));
  });
});

describe('G24, G25: the copy the bot started itself on a record whose step began', () => {
  it('the lines written, isolated not: the copy is named unsure', async () => {
    seedAt('following', 'file', { isolated: undefined });
    m.bot.getQueue.push(ours('done', 'switching', 'file'));
    await resume();
    expect(writes().find(r => r?.phase === 'finishing')?.copyOpen).toBe('unsure');
    expect(last().text).toContain(MG_DONE_UNSURE);
  });
  it('a sharer stopped, no line written: the copy is named unsure', async () => {
    seedAt('following', 'file', { isolated: undefined, hbaFence: undefined, hbaFenceSet: undefined, sharers: ['s1'], sharersStopped: ['s1'] });
    seedSharer('s1');
    m.app.s1 = false;
    m.bot.getQueue.push(ours('done', 'switching', 'file'));
    await resume();
    expect(writes().find(r => r?.phase === 'finishing')?.copyOpen).toBe('unsure');
    expect(last().text).toContain(MG_DONE_UNSURE);
    expect(last().text).not.toContain(MG_DONE_OPEN);
  });
});

describe('M7: the POST', () => {
  it('a shutdown as posting is written: no POST', async () => {
    seedBot();
    m.failMigrateWrite = (_n, r) => { if (r?.phase === 'posting') m.shuttingDown = true; return null; };
    await press();
    expect(m.bot.posts).toEqual([]);
    expect(rec().phase).toBe('posting');
  });
  it('a stored URL with trailing spaces is sent trimmed', async () => {
    seedBot({ url: `${EXTERNAL_URL}  ` });
    m.bot.destination = { host: 'db.example.test', port: 5432, database: 'app' };
    await press();
    expect(m.bot.posts[0].url).toBe(EXTERNAL_URL);
  });
  it('the env unreadable at the POST: no url is sent', async () => {
    seedBot();
    m.failMigrateWrite = (_n, r) => { if (r?.phase === 'posting') m.envStatus.corrupt = true; return null; };
    await press();
    expect(m.bot.posts[0]).toEqual({ jobId: expect.any(String), to: 'postgres' });
  });
  it('the log line of a refusal names its error', async () => {
    seedBot();
    m.bot.postQueue.push(refusal('the bot is busy'));
    await press();
    const id = m.bot.posts[0].jobId;
    expect(lines).toContain(`log: [Migrate] B1: migration ${id} to postgres: the bot answered refused: the bot is busy`);
  });
  it('the log line of a POST to a bot with no hook says so', async () => {
    seedBot();
    m.bot.postQueue.push(http(404));
    await press();
    const id = m.bot.posts[0].jobId;
    expect(lines).toContain(`log: [Migrate] B1: migration ${id} to postgres: the bot answered refused: no hook`);
  });
  it('a done answer whose jobId cannot be recorded: the lane stops there, with no GET', async () => {
    seedBot();
    m.bot.journal.push({ jobId: 'mgr-earlier', to: 'postgres', state: 'done', stage: 'switching', destination: DEST });
    m.bot.postQueue.push(postJob({ jobId: 'mgr-earlier', to: 'postgres', state: 'done' }));
    m.failMigrateWrite = (_n, r) => (r?.jobIds?.includes('mgr-earlier') ? 'disk full' : null);
    await press();
    expect(m.events.slice(m.events.findIndex(e => e.startsWith('POST:')))).not.toContain('GET');
    expect(evs[evs.length - 1]).toEqual({ text: NOT_REC('disk full'), final: true });
  });
  it('a failed answer with no stage and no error: MG-FAILED says so', async () => {
    seedBot();
    m.bot.postQueue.push(postJob({ jobId: 'mgr-x', to: 'postgres', state: 'failed', stage: '' }));
    await press();
    expect(last().text.startsWith(FAILED('mgr-x', 'an unnamed stage', 'the bot gave no error', 'its JSON files'))).toBe(true);
  });
  it('unreachable when the window ends at that very millisecond: MG-NOANSWER', async () => {
    seedBot();
    MIGRATE_TIMING.windowMs = 0;
    MIGRATE_TIMING.readyMs = 0;
    m.failMigrateWrite = (_n, r) => {
      if (r?.phase === 'posting') { const t = Date.now() + 5; vi.spyOn(Date, 'now').mockReturnValue(t); m.bot.down = true; }
      return null;
    };
    await press();
    expect(m.bot.posts).toHaveLength(1);
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'following' });
  }, 3000);
  it('the session refusal when its five minutes end at that very millisecond: no second POST', async () => {
    seedBot();
    MIGRATE_TIMING.sessionMs = 0;
    m.failMigrateWrite = (_n, r) => {
      if (r?.phase === 'posting' && !m.bot.getQueue.length) {
        const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5);
        m.bot.getQueue.push(() => { spy.mockRestore(); return getJob(null); });
      }
      return null;
    };
    m.bot.postQueue.push(refusal(SESSION_REFUSAL));
    await press();
    expect(m.bot.posts).toHaveLength(1);
    expect(last().outcome).not.toBe('done');
  }, 3000);
  it('the session wait line counts the seconds since the first session refusal', async () => {
    seedBot();
    MIGRATE_TIMING.sessionMs = 5000;
    m.bot.postQueue.push(refusal(SESSION_REFUSAL));
    await press();
    const id = m.bot.posts[0].jobId;
    expect(texts()).toContain(P_SESSION(id, 0));
    expect(last()).toMatchObject({ outcome: 'done' });
  });
  it('an interrupted job started three times already: MG-SPENT, with no POST again', async () => {
    seedAt('posting', 'postgres', { started: 3 });
    m.bot.postQueue.push(postJob({ jobId: 'mgr-a', to: 'postgres', state: 'interrupted', stage: 'checking' }));
    await resume();
    expect(m.bot.posts).toHaveLength(1);
    expect(last().text.startsWith(SPENT('mgr-a', 'checking', 'the bot gave no error', 'its JSON files'))).toBe(true);
  });
});

describe('M8: the follow', () => {
  it('a resume at following writes no phase again before its first GET', async () => {
    seedAt('following');
    await resume();
    const first = m.events.findIndex(e => e === 'GET');
    expect(m.events.slice(0, first).filter(e => e.startsWith('record:'))).toEqual([]);
    expect(last()).toMatchObject({ outcome: 'done' });
  });
  it('a shutdown during a GET: no further GET', async () => {
    seedAt('following');
    m.bot.journal.push({ jobId: 'mgr-a', to: 'postgres', state: 'running', stage: 'copying', destination: DEST });
    m.bot.getQueue.push(() => { m.shuttingDown = true; return ours('running'); });
    await resume();
    expect(m.bot.gets).toBe(1);
    expect(rec().phase).toBe('following');
  });
  it('a usable answer between silences starts the silence count again', async () => {
    seedAt('following');
    MIGRATE_TIMING.silentParkMs = 60;
    let mark = 0;
    m.bot.getQueue.push(noAnswer(), async () => {
      await new Promise(r => setTimeout(r, 120));
      m.bot.down = true;
      mark = m.bot.gets;
      return ours('running');
    });
    await resume();
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'following' });
    expect(m.bot.gets - mark).toBeGreaterThan(1);
  });
  it('a stage read twice is recorded and broadcast once', async () => {
    seedBot();
    m.bot.script = [{ stage: 'copying' }, { stage: 'copying' }, { state: 'done', stage: 'switching' }];
    await press();
    const id = m.bot.posts[0].jobId;
    expect(texts().filter(t => t === P_STAGE(id, 'copying'))).toHaveLength(1);
    expect(writes().filter(r => r?.text === P_STAGE(id, 'copying'))).toHaveLength(1);
    expect(lines.some(l => l.includes('the stage could not be recorded'))).toBe(false);
  });
  it('a stage that cannot be recorded: the warning line, and the broadcast still goes out', async () => {
    seedBot();
    m.failMigrateWrite = (_n, r) => (typeof r?.text === 'string' && r.text.endsWith(': copying') && r.stage === 'copying' ? 'disk full' : null);
    await press();
    const id = m.bot.posts[0].jobId;
    expect(lines).toContain('warn: [Migrate] B1: the stage could not be recorded: disk full');
    expect(texts()).toContain(P_STAGE(id, 'copying'));
    expect(last()).toMatchObject({ outcome: 'done' });
  });
  it('another running job of this move: its progress line, then it is followed to done', async () => {
    seedAt('following');
    m.bot.journal.push({ jobId: 'mgr-b', to: 'postgres', state: 'running', stage: 'copying', destination: DEST });
    await resume();
    expect(texts()).toContain(P_RUN('mgr-b'));
    expect(last()).toMatchObject({ outcome: 'done', jobId: 'mgr-b' });
  });
  it('another running job whose jobId cannot be recorded: the lane stops with no further GET', async () => {
    seedAt('following');
    m.bot.journal.push({ jobId: 'mgr-b', to: 'postgres', state: 'running', stage: 'copying', destination: DEST });
    m.failMigrateWrite = (_n, r) => (r?.jobIds?.includes('mgr-b') ? 'disk full' : null);
    await resume();
    expect(m.bot.gets).toBe(1);
    expect(texts()).not.toContain(P_RUN('mgr-b'));
    expect(evs[evs.length - 1]).toEqual({ text: NOT_REC('disk full'), final: true });
  });
  it('a failed job with no stage and no error: MG-FAILED says so', async () => {
    seedAt('following');
    m.bot.getQueue.push(getJob({ jobId: 'mgr-a', to: 'postgres', state: 'failed', stage: '', destination: DEST }));
    await resume();
    expect(last().text.startsWith(FAILED('mgr-a', 'an unnamed stage', 'the bot gave no error', 'its JSON files'))).toBe(true);
  });
});

/** The effects of a press to Postgres on the companion, up to its POST. */
function EXPECT_PG_PRESS(id: string): string[] {
  return ['GET', 'record:preparing', 'record:preparing', 'ensure:forMigrate', 'attach', 'db-start:b1', 'record:preparing', 'login-read', 'record:preparing', 'hook:maintenance',
    'record:preparing', 'stop:migrate', 'start:migrate', 'db-ready:b1-fleet-postgres', 'GET', 'record:posting', `POST:${id}`];
}
