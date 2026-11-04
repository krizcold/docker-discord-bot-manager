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
import { fastTiming, getJob, http, m, noAnswer, refusal, resetMigrate, seedBot, seedSharer, COMPANION_URL, UNREADABLE, FLEET_DB, MG_DONE_OPEN, MG_DONE_UNSURE, MG_FENCE_WAIT, MG_NOT_AGAIN, MG_P_FENCE, MG_P_OPEN, MG_SHARERS_RUN, MG_SHARERS_STAY, MG_SHARERS_UNSURE } from './migrate-fake';

beforeEach(() => { resetMigrate(); fastTiming(MIGRATE_TIMING); });

const DEST = { host: 'b1-fleet-postgres', port: 5432, database: 'smdb' };
const rec = () => m.bots.b1.migrate;
const last = () => m.bots.b1.migrateLast;

/** The bot and its record parked at following on job mgr-a (posted), as follow() writes them before its press. */
function seedFollow(over: Record<string, unknown> = {}, to: 'postgres' | 'file' = 'postgres', mode: 'press' | 'resume' = 'press') {
  if (to === 'postgres') seedBot({ url: COMPANION_URL, inst: { fleetDb: { ...FLEET_DB } } });
  else seedBot({ postgres: true });
  m.bots.b1.migrate = {
    to, from: to === 'postgres' ? 'file' : 'postgres', destination: to === 'postgres' ? 'b1-fleet-postgres:5432/smdb' : null, companion: to === 'postgres',
    jobId: 'mgr-a', jobIds: ['mgr-a'], posted: true, started: 1, kept: 0, phase: mode === 'press' ? 'waiting' : 'following', ...(mode === 'press' ? { resumeAt: 'following' } : {}), loginOpened: false, sharers: [], sharersStopped: [], openedAt: 'x',
    ...(to === 'file' ? { hbaFence: 'migrate:1', hbaFenceSet: true, isolated: true } : {}), ...over,
  };
}

/** A JSON bot with a record parked at following on job mgr-a (posted), pressed again. */
async function follow(gets: any[], over: Record<string, unknown> = {}, to: 'postgres' | 'file' = 'postgres', mode: 'press' | 'resume' = 'press') {
  seedFollow(over, to, mode);
  m.bot.getQueue.push(...gets);
  if (mode === 'press') expect(await runMigration('b1', to, 'press')).toEqual({ accepted: true });
  else { resumeMigrations(); await new Promise(r => setTimeout(r, 0)); }
  await laneDone('b1');
}
const ours = (state: string, stage = 'copying', more: Record<string, unknown> = {}) => getJob({ jobId: 'mgr-a', to: 'postgres', state, stage, destination: DEST, ...more });

describe('D: following the job', () => {
  it('D1 running: the stage is written when it changes; D2 done: G', async () => {
    await follow([ours('running', 'copying'), ours('running', 'verifying'), ours('done', 'switching')]);
    expect(m.migrateWrites.some(w => w.rec?.stage === 'verifying')).toBe(true);
    expect(last()).toMatchObject({ outcome: 'done', jobId: 'mgr-a' });
  });
  it('a press on a record parked at following keeps its jobId (review B1)', async () => {
    await follow([ours('done', 'switching')]);
    expect(m.migrateWrites[0].rec.jobId).toBe('mgr-a');
  });
  it('D3 failed: F', async () => {
    await follow([ours('failed', 'copying', { error: 'disk full' })]);
    expect(last().text).toMatch(/^Migration mgr-a failed at copying: disk full\./);
  });
  it('D4 interrupted before retire-source under the cap: a new jobId, and the earlier job reads failed in the journal', async () => {
    m.bot.journal.push({ jobId: 'mgr-a', to: 'postgres', state: 'running', stage: 'copying', destination: DEST });
    m.bot.script = [{ state: 'interrupted', stage: 'copying' }, { stage: 'copying' }, { state: 'done', stage: 'switching' }];
    await follow([]);
    expect(m.bot.posts[0].jobId).not.toBe('mgr-a');
    expect(m.bot.journal[0]).toMatchObject({ jobId: 'mgr-a', state: 'failed', error: 'The old store was not retired; nothing was switched' });
    expect(last()).toMatchObject({ outcome: 'done', jobId: m.bot.posts[0].jobId });
  });
  it('D5 the same with started >= 3: E closes with MG-SPENT', async () => {
    await follow([ours('interrupted', 'copying', { error: 'killed' }), ours('interrupted', 'copying', { error: 'killed' })], { started: 3 }, 'postgres', 'resume');
    expect(m.bot.posts).toHaveLength(0);
    expect(last().text).toMatch(/^Migration mgr-a was interrupted at copying \(killed\), and the manager has started it three times\./);
  });
  it.each([
    ['file', 'switching', 2, 'done', /the old database store is renamed aside and the switch to JSON files is not written/],
    ['file', 'retire-source', 2, 'done', /can't confirm whether the old database store was renamed aside/],
    ['file', 'retire-source', 3, 'new', /can't confirm whether the old database store was renamed aside/],
    ['postgres', 'switching', 3, 'new', /the copy in Postgres is committed and the switch to it is not written/],
    ['postgres', 'retire-source', 4, 'park', /reports stage retire-source, which a managed bot moving to Postgres does not reach/],
    ['postgres', 'env', 4, 'park', /reports stage env, which a managed bot moving to Postgres does not reach/],
    ['postgres', 'transmogrifying', 4, 'park', /reports stage transmogrifying, which this manager does not know/],
  ] as const)('D6/D7 %s interrupted at %s keeps with MG-KEPT and one keep POST; fact %i: %s', async (to, stage, fact, outcome, clause) => {
    const texts: string[] = [];
    (await import('../../src/instance/migrate')).setMigrateListener((_id, ev) => texts.push(ev.text));
    m.bot.journal.push({ jobId: 'mgr-a', to, state: 'running', stage: 'copying', ...(to === 'postgres' ? { destination: DEST } : {}), fact });
    m.bot.script = [{ state: 'interrupted', stage, error: 'cut' }, { stage: 'copying' }, { state: 'done', stage: 'switching' }];
    await follow([], { kept: 4 }, to, 'resume');
    expect(texts.some(t => clause.test(t))).toBe(true);
    expect(m.bot.posts).toHaveLength(1);
    if (outcome === 'done') {
      expect(last()).toMatchObject({ outcome: 'done', jobId: 'mgr-a' });
      expect(m.bot.journal).toHaveLength(1);
    } else if (outcome === 'new') {
      expect(m.bot.journal[0]).toMatchObject({ state: 'failed', error: 'The old store was not retired; nothing was switched' });
      expect(last()).toMatchObject({ outcome: 'done', jobId: m.bot.posts[0].jobId });
    } else {
      expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'posting' });
      expect(rec().text).toMatch(clause);
      expect(rec().text.endsWith('(cut). The bot stays in Maintenance; the manager asked five times and does not ask again; press Migrate to go on.')).toBe(true);
      expect(m.env.b1.DATA_BACKEND).toBe('file');
    }
  });
  it('T-F6 a move to JSON files cut at retire-source with the bot\'s own error; fact 4: MG-KEPT with the can\'t-confirm clause', async () => {
    m.bot.journal.push({ jobId: 'mgr-a', to: 'file', state: 'running', stage: 'copying', fact: 4 });
    m.bot.script = [{ state: 'interrupted', stage: 'retire-source', error: "can't confirm whether the old store was renamed aside" }];
    await follow([], { kept: 4 }, 'file', 'resume');
    expect(m.bot.posts).toHaveLength(1);
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'posting' });
    expect(rec().text).toBe(`Migration ${m.bot.posts[0].jobId} is not finished: the manager can't confirm whether the old database store was renamed aside, and until the migration finishes the bot refuses to boot on either store (can't confirm whether the old store was renamed aside). The bot stays in Maintenance; the manager asked five times and does not ask again; press Migrate to go on.`);
    expect(m.env.b1.DATA_BACKEND).toBe('postgres');
  });
  it('D8 another jobId done, same `to`: G with that jobId', async () => {
    await follow([getJob({ jobId: 'mgr-b', to: 'postgres', state: 'done', stage: 'switching', destination: DEST })]);
    expect(last()).toMatchObject({ outcome: 'done', jobId: 'mgr-b' });
  });
  it('D9 another jobId running, same `to`: followed', async () => {
    await follow([getJob({ jobId: 'mgr-b', to: 'postgres', state: 'running', destination: DEST }), getJob({ jobId: 'mgr-b', to: 'postgres', state: 'done', destination: DEST })]);
    expect(rec()).toBeUndefined();
    expect(m.migrateWrites.some(w => w.rec?.jobIds?.includes('mgr-b'))).toBe(true);
  });
  it('D10 another jobId, any other state: the record\'s jobId is POSTed again within the keep bound', async () => {
    await follow([getJob({ jobId: 'mgr-old', to: 'postgres', state: 'failed', stage: 'checking' })]);
    expect(m.bot.posts[0].jobId).toBe('mgr-a');
  });
  it('D10 spent: a park with MG-OTHERJOB', async () => {
    await follow([getJob({ jobId: 'mgr-old', to: 'postgres', state: 'failed', stage: 'checking' })], { kept: 5 }, 'postgres', 'resume');
    expect(rec().text).toMatch(/reports migration mgr-old to Postgres \(failed\)/);
  });
  it('D10b another jobId of the other `to`, running: a park', async () => {
    await follow([getJob({ jobId: 'mgr-o', to: 'file', state: 'running' })]);
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'following' });
    expect(m.bot.posts).toHaveLength(0);
  });
  it('D10c an earlier done job of the other `to` re-POSTs (R2-B1)', async () => {
    await follow([getJob({ jobId: 'mgr-back', to: 'file', state: 'done', stage: 'switching' })]);
    expect(m.bot.posts[0].jobId).toBe('mgr-a');
  });
  it('D11 job null: re-POST, and MG-NULL when spent', async () => {
    await follow([getJob(null)], { kept: 5 }, 'postgres', 'resume');
    expect(rec().text).toBe("The manager can't confirm the outcome of migration mgr-a: the bot reports no migration. The bot stays in Maintenance; press Migrate to ask again.");
  });
  it('D12 the can\'t-confirm answer keeps (E3)', async () => {
    m.bot.unreadable = UNREADABLE;
    await follow([], { kept: 4 });
    expect(rec().text).toMatch(/the bot can't confirm which store holds the data, and its boot refuses until that is settled/);
  });
  it('D13 to D15 an unusable answer (500, a refusal without the phrase): MG-UNUSABLE with the last status and error (R4-B2)', async () => {
    const bad = http(500, { success: false, error: 'boom' });
    await follow(Array(5000).fill(bad));
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'following' });
    expect(rec().text).toMatch(/^The manager can't confirm how migration mgr-a ends: for \d+ seconds the manager got no answer it could use \(last: HTTP 500: boom\)\./);
    m.bot.getQueue = [];
  });
  it('D14 a stopped app after the quiet window gets one start; D15 then parks with MG-NOANSWER', async () => {
    seedBot();
    m.bot.down = true;
    m.bots.b1.migrate = { to: 'postgres', from: 'file', destination: 'b1-fleet-postgres:5432/smdb', companion: true, jobId: 'mgr-a', jobIds: ['mgr-a'], posted: true, started: 1, kept: 0, phase: 'waiting', resumeAt: 'following', loginOpened: false, sharers: [], sharersStopped: [], openedAt: 'x' };
    let starts = 0;
    m.start = () => { starts++; return { success: true }; };
    const realRunning = m.app;
    m.app = new Proxy(realRunning, { get: (t, k) => (k === 'b1' ? starts === 0 && m.events.includes('GET') ? false : t[k as string] : t[k as string]) }) as any;
    await runMigration('b1', 'postgres', 'press');
    await laneDone('b1');
    expect(starts).toBe(1);
    expect(rec().text).toMatch(/has not answered for \d+ seconds \(migrate unreachable/);
  });
  it("X24 follow's one start on a fenced record (a move to file from the companion): the lines are renewed before the next GET", async () => {
    seedBot({ postgres: true });
    m.bot.getQueue.push(null, null, http(401, { success: false, error: 'bad token' }));
    expect(await runMigration('b1', 'file', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
    expect(m.bots.b1.migrate).toMatchObject({ phase: 'waiting', resumeAt: 'following' });
    expect(m.bots.b1.migrate.hbaFence).toMatch(/^migrate:\d+$/);
    const mark = m.events.length;
    m.bot.down = true;
    let starts = 0;
    m.start = () => { starts++; return { success: true }; };
    const realRunning = m.app;
    m.app = new Proxy(realRunning, { get: (t, k) => (k === 'b1' ? starts === 0 && m.events.slice(mark).includes('GET') ? false : t[k as string] : t[k as string]) }) as any;
    await runMigration('b1', 'file', 'press');
    await laneDone('b1');
    expect(starts).toBe(1);
    const e = m.events.slice(mark);
    const start = e.indexOf('start:migrate');
    expect(start).toBeGreaterThan(-1);
    const after = e.slice(start);
    expect(after.indexOf('hba-refresh')).toBeGreaterThan(-1);
    expect(after.indexOf('hba-refresh')).toBeLessThan(after.indexOf('GET'));
  });
  const adoptSeed = (opts: { postgres?: boolean; external?: boolean }) => {
    seedBot(opts);
    if (opts.postgres) seedSharer('s1');
    m.bot.journal = [{ jobId: 'cli-1', to: 'file', state: 'running', stage: 'copying' }];
    m.bot.script = [{ stage: 'copying' }, { state: 'done', stage: 'switching' }];
  };
  const listen = async () => {
    const texts: string[] = [];
    (await import('../../src/instance/migrate')).setMigrateListener((_id, ev) => texts.push(ev.text));
    return texts;
  };
  const unlisten = async () => (await import('../../src/instance/migrate')).setMigrateListener(null);
  const writes = () => m.migrateWrites.map(w => w.rec).filter(Boolean);
  it('X27 an adopted move with a running sharer is followed with no line: no stop, the sharer held and named open', async () => {
    adoptSeed({ postgres: true });
    const texts = await listen();
    expect(await runMigration('b1', 'file', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
    await unlisten();
    expect(m.events.some(x => x.startsWith('hba-'))).toBe(false);
    expect(m.events).not.toContain('stop-sharer:s1');
    expect(writes().some(r => JSON.stringify(r.sharers) === '["s1"]')).toBe(true);
    expect(writes().some(r => Object.keys(r).some(k => k.endsWith('Sharers')))).toBe(false);
    expect(writes()[0].adoptedJob).toBe('cli-1');
    expect(writes().every(r => r.adoptedJob === 'cli-1')).toBe(true);
    expect(writes().some(r => r.hbaFence)).toBe(false);
    expect(texts).toContain(MG_P_OPEN(['S1']));
    expect(last()).toMatchObject({ outcome: 'done', jobId: 'cli-1' });
    expect(last().text).toContain(MG_SHARERS_RUN('S1'));
    expect(last().text).toContain(MG_DONE_OPEN);
  });
  it('X27, every sharer stopped writes no line: the sharer is held, no stop, done with the copy named open', async () => {
    adoptSeed({ postgres: true });
    m.app.s1 = false;
    const texts = await listen();
    expect(await runMigration('b1', 'file', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
    await unlisten();
    expect(m.events.some(x => x.startsWith('hba-'))).toBe(false);
    expect(m.events).not.toContain('stop-sharer:s1');
    expect(writes().some(r => JSON.stringify(r.sharers) === '["s1"]')).toBe(true);
    expect(texts).toContain(MG_P_OPEN(['S1']));
    expect(last()).toMatchObject({ outcome: 'done', jobId: 'cli-1' });
    expect(last().text).toContain(MG_SHARERS_STAY('S1'));
    expect(last().text).toContain(MG_DONE_OPEN);
  });
  it('X27, docker silent for a sharer: followed with no line, the sharer named unsure and open', async () => {
    adoptSeed({ postgres: true });
    m.app.s1 = null;
    const texts = await listen();
    expect(await runMigration('b1', 'file', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
    await unlisten();
    expect(m.events.some(x => x.startsWith('hba-'))).toBe(false);
    expect(m.events).not.toContain('stop-sharer:s1');
    expect(writes().some(r => JSON.stringify(r.sharers) === '["s1"]')).toBe(true);
    expect(writes().some(r => Object.keys(r).some(k => k.endsWith('Sharers')))).toBe(false);
    expect(writes()[0].adoptedJob).toBe('cli-1');
    expect(writes().every(r => r.adoptedJob === 'cli-1')).toBe(true);
    expect(writes().some(r => r.hbaFence)).toBe(false);
    expect(texts).toContain(MG_P_OPEN(['S1']));
    expect(last()).toMatchObject({ outcome: 'done', jobId: 'cli-1' });
    expect(last().text).toContain(MG_SHARERS_UNSURE('S1'));
    expect(last().text).toContain(MG_DONE_OPEN);
  });
  it('X27, the hold before any docker read: the found sharer is saved held, and docker is read for it only at the close (Z1)', async () => {
    adoptSeed({ postgres: true });
    const real = m.app;
    m.app = new Proxy(real, { get: (t, k) => { if (k === 's1') m.events.push('app:s1'); return (t as any)[k]; } }) as any;
    expect(await runMigration('b1', 'file', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
    const fin = m.events.findIndex(x => x.startsWith('record:finishing'));
    expect(fin).toBeGreaterThan(-1);
    expect(m.events.indexOf('app:s1')).toBeGreaterThan(fin);
    const w = writes();
    expect(w.slice(0, w.findIndex(r => r.phase === 'finishing')).some(r => JSON.stringify(r.sharers) === '["s1"]')).toBe(true);
  });
  it('X27, a later pass with the sharer stopped writes no line (A-1 = C-1)', async () => {
    adoptSeed({ postgres: true });
    m.bot.getQueue.push(null, http(403, { success: false, error: 'bad token' }));
    expect(await runMigration('b1', 'file', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'following' });
    m.app.s1 = false;
    const mark = m.events.length;
    expect(await runMigration('b1', 'file', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
    expect(m.events.slice(mark).some(x => x.startsWith('hba-'))).toBe(false);
    expect(m.events.some(x => x.startsWith('hba-'))).toBe(false);
    expect(last()).toMatchObject({ outcome: 'done', jobId: 'cli-1' });
    expect(last().text).toContain(MG_SHARERS_STAY('S1'));
    expect(last().text).toContain(MG_DONE_OPEN);
  });
  it('X28, an interrupted adopted move stops the sharer and writes the lines before its POST', async () => {
    adoptSeed({ postgres: true });
    m.bot.script = [{ stage: 'copying' }, { state: 'interrupted', stage: 'copying' }, { stage: 'copying' }, { state: 'done', stage: 'switching' }];
    expect(await runMigration('b1', 'file', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
    const e = m.events;
    expect(e.indexOf('stop-sharer:s1')).toBeGreaterThan(-1);
    expect(e.indexOf('stop-sharer:s1')).toBeLessThan(e.indexOf('hba-fence'));
    expect(e.indexOf('hba-fence')).toBeLessThan(e.findIndex(x => x.startsWith('POST:')));
    expect(m.sharerStopOpts).toEqual([{ seen: true }]);
    const w = writes();
    const iso = w.findIndex(r => r.isolated === true);
    expect(iso).toBeGreaterThan(-1);
    expect(iso).toBeLessThan(w.findIndex(r => r.phase === 'posting'));
    expect(w[iso].adoptedJob).toBe('cli-1');
    expect(last().outcome).toBe('done');
    expect(last().jobId).not.toBe('cli-1');
    expect(last().text).toContain(MG_SHARERS_STAY('S1'));
    expect(last().text).not.toContain(MG_DONE_OPEN);
  });
  it('X28, a refusal of that step parks at posting with no job named', async () => {
    adoptSeed({ postgres: true });
    m.bot.script = [{ stage: 'copying' }, { state: 'interrupted', stage: 'copying' }, { stage: 'copying' }, { state: 'done', stage: 'switching' }];
    m.lock.s1 = 'build';
    expect(await runMigration('b1', 'file', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'posting' });
    expect(rec().text).toBe(MG_NOT_AGAIN("S1 uses the same database and is running 'build'"));
    expect(rec().jobIds).toEqual(['cli-1']);
    expect(m.events.some(x => x.startsWith('POST:'))).toBe(false);
    expect(rec().isolated).toBeUndefined();
  });
  it("G24, a keep's re-POST answered with the adopted job: done with that job, the copy named open", async () => {
    adoptSeed({ postgres: true });
    m.bot.script = [{ stage: 'copying' }, { state: 'interrupted', stage: 'switching' }];
    expect(await runMigration('b1', 'file', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
    const e = m.events;
    expect(e.indexOf('stop-sharer:s1')).toBeGreaterThan(-1);
    expect(e.indexOf('stop-sharer:s1')).toBeLessThan(e.indexOf('hba-fence'));
    expect(e.indexOf('hba-fence')).toBeLessThan(e.findIndex(x => x.startsWith('POST:')));
    expect(m.bot.posts).toHaveLength(1);
    expect(last()).toMatchObject({ outcome: 'done', jobId: 'cli-1' });
    expect(last().text).toContain(MG_SHARERS_STAY('S1'));
    expect(last().text).toContain(MG_DONE_OPEN);
  });
  it('X32, a resume of a record cut inside the step: no renewal and no MG-P-OPEN; the step writes the lines before the POST', async () => {
    adoptSeed({ postgres: true });
    m.bot.script = [{ stage: 'copying' }, { state: 'interrupted', stage: 'copying' }, { stage: 'copying' }, { state: 'done', stage: 'switching' }];
    m.failMigrateWrite = (_n, r) => (r?.isolated ? 'disk full' : null);
    expect(await runMigration('b1', 'file', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
    expect(rec()).toMatchObject({ phase: 'following', hbaFenceSet: true, sharersStopped: ['s1'] });
    expect(rec().isolated).toBeUndefined();
    expect(m.events.some(x => x.startsWith('POST:'))).toBe(false);
    m.failMigrateWrite = () => null;
    const texts = await listen();
    const mark = m.events.length;
    resumeMigrations();
    await new Promise(r => setTimeout(r, 0));
    await laneDone('b1');
    await unlisten();
    const e = m.events.slice(mark);
    expect(e).not.toContain('hba-refresh');
    expect(e.indexOf('hba-fence')).toBeGreaterThan(-1);
    expect(e.indexOf('hba-fence')).toBeLessThan(e.findIndex(x => x.startsWith('POST:')));
    expect(texts).not.toContain(MG_P_OPEN(['S1']));
    expect(texts).not.toContain(MG_P_OPEN([]));
    expect(last().outcome).toBe('done');
    expect(last().jobId).not.toBe('cli-1');
    expect(last().text).not.toContain(MG_DONE_OPEN);
    expect(last().text).not.toContain(MG_DONE_UNSURE);
  });
  const recordFor = (jobId: string, over: Record<string, unknown> = {}) => ({ to: 'file', from: 'postgres', destination: null, companion: false, jobId, jobIds: [jobId], posted: true, started: 1, kept: 0, phase: 'waiting', resumeAt: 'following', loginOpened: false, sharers: [], sharersStopped: [], openedAt: 'x', text: 't', ...over });
  const s9Holding = () => {
    m.bots.s9 = { id: 's9', displayName: 'S9', sanitizedName: 's9', sourceUrl: m.bots.b1.sourceUrl, envVars: {}, status: 'running', createdAt: 'x', updatedAt: 'x', migrate: recordFor('mgr-s9', { sharers: ['s1'], sharersStopped: ['s1'] }) };
    m.env.s9 = { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: COMPANION_URL };
  };
  it('G24, a later move the bot started itself on an adopted record: done with that job, the copy named open', async () => {
    adoptSeed({ postgres: true });
    m.bot.getQueue.push(null, getJob({ jobId: 'cli-2', to: 'file', state: 'running', stage: 'copying' }), getJob({ jobId: 'cli-2', to: 'file', state: 'done', stage: 'switching' }));
    expect(await runMigration('b1', 'file', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
    expect(m.events.some(x => x.startsWith('hba-'))).toBe(false);
    expect(m.events).not.toContain('stop-sharer:s1');
    expect(writes().find(r => r.phase === 'finishing')?.copyOpen).toBe('open');
    expect(last()).toMatchObject({ outcome: 'done', jobId: 'cli-2' });
    expect(last().text).toContain(MG_SHARERS_RUN('S1'));
    expect(last().text).toContain(MG_DONE_OPEN);
    expect(last().text).not.toContain(MG_DONE_UNSURE);
  });
  it('G25, a move the bot started itself on a record cut inside the step: done with the copy named unsure', async () => {
    adoptSeed({ postgres: true });
    m.bot.script = [{ stage: 'copying' }, { state: 'interrupted', stage: 'copying' }, { stage: 'copying' }, { state: 'done', stage: 'switching' }];
    m.failMigrateWrite = (_n, r) => (r?.isolated ? 'disk full' : null);
    expect(await runMigration('b1', 'file', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
    expect(rec()).toMatchObject({ phase: 'following', hbaFenceSet: true, sharersStopped: ['s1'] });
    expect(rec().isolated).toBeUndefined();
    expect(m.events.some(x => x.startsWith('POST:'))).toBe(false);
    m.failMigrateWrite = () => null;
    m.bot.getQueue.push(getJob({ jobId: 'cli-2', to: 'file', state: 'done', stage: 'switching' }));
    const mark = m.events.length;
    resumeMigrations();
    await new Promise(r => setTimeout(r, 0));
    await laneDone('b1');
    expect(m.events.slice(mark).some(x => x.startsWith('POST:'))).toBe(false);
    expect(last()).toMatchObject({ outcome: 'done', jobId: 'cli-2' });
    expect(last().text).toContain(MG_DONE_UNSURE);
    expect(last().text).not.toContain(MG_DONE_OPEN);
  });
  it('X27, the first write holds the bots the stored URLs name; one found by its container joins after the search', async () => {
    adoptSeed({ postgres: true });
    seedSharer('s2');
    m.sharers = ['s1'];
    m.liveSharers = ['s2'];
    const texts = await listen();
    expect(await runMigration('b1', 'file', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
    await unlisten();
    const w = writes();
    expect(w[0].sharers).toEqual(['s1']);
    expect(w.slice(0, w.findIndex(r => r.phase === 'finishing')).some(r => JSON.stringify(r.sharers) === '["s1","s2"]')).toBe(true);
    expect(texts).toContain(MG_P_OPEN(['S1', 'S2']));
  });
  it('X27, a found sharer whose own managed database has replication on is named and not held (Q8)', async () => {
    adoptSeed({ postgres: true });
    m.bots.s1.fleetDb = { ...FLEET_DB, containerName: 's1-fleet-postgres', replication: { publicHost: 'pub.example', hostPort: 5433 } };
    const texts = await listen();
    expect(await runMigration('b1', 'file', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
    await unlisten();
    expect(writes().some(r => r.sharers?.includes('s1'))).toBe(false);
    expect(m.events).not.toContain('stop-sharer:s1');
    expect(m.events.some(x => x.startsWith('hba-'))).toBe(false);
    expect(texts).toContain(MG_P_OPEN(['S1'], ['S1']));
    expect(last()).toMatchObject({ outcome: 'done', jobId: 'cli-1' });
    expect(last().text).toContain(MG_DONE_OPEN);
    expect(last().text).not.toContain('S1 use');
  });
  it("X27, a found sharer whose replication Enable is in flight (its op held as 'replication') is named and not held", async () => {
    adoptSeed({ postgres: true });
    m.lock.s1 = 'replication';
    const texts = await listen();
    expect(await runMigration('b1', 'file', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
    await unlisten();
    expect(writes().some(r => r.sharers?.includes('s1'))).toBe(false);
    expect(m.events).not.toContain('stop-sharer:s1');
    expect(texts).toContain(MG_P_OPEN(['S1'], ['S1']));
    expect(last()).toMatchObject({ outcome: 'done', jobId: 'cli-1' });
    expect(last().text).toContain(MG_DONE_OPEN);
    expect(last().text).not.toContain('S1 use');
  });
  it('X34, a found sharer another open record holds is held by this one too, and neither started nor stopped', async () => {
    adoptSeed({ postgres: true });
    s9Holding();
    m.app.s1 = false;
    const before = JSON.stringify(m.bots.s9.migrate);
    expect(await runMigration('b1', 'file', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
    expect(writes().some(r => JSON.stringify(r.sharers) === '["s1"]')).toBe(true);
    expect(m.events).not.toContain('start-sharer:s1');
    expect(m.events).not.toContain('stop-sharer:s1');
    expect(JSON.stringify(m.bots.s9.migrate)).toBe(before);
    expect(last().outcome).toBe('done');
    expect(last().text).toContain(MG_SHARERS_STAY('S1'));
    expect(last().text).toContain(MG_DONE_OPEN);
  });
  it('X27, a found sharer with its own open migration is named but not held (D135)', async () => {
    adoptSeed({ postgres: true });
    m.bots.s1.migrate = recordFor('mgr-s1');
    const texts = await listen();
    expect(await runMigration('b1', 'file', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
    await unlisten();
    expect(writes().some(r => r.sharers?.includes('s1'))).toBe(false);
    expect(texts).toContain(MG_P_OPEN(['S1']));
    expect(last().outcome).toBe('done');
    expect(last().text).not.toContain('S1 use');
  });
  it('X33, a sharer another record holds, at the step: the park releases it, and a press after that record ends goes on', async () => {
    adoptSeed({ postgres: true });
    s9Holding();
    m.app.s1 = false;
    m.bot.script = [{ stage: 'copying' }, { state: 'interrupted', stage: 'copying' }, { stage: 'copying' }, { state: 'done', stage: 'switching' }];
    expect(await runMigration('b1', 'file', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
    expect(writes()[0].sharers).toEqual(['s1']);
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'posting', sharers: [] });
    expect(rec().isolated).toBeUndefined();
    expect(rec().text).toBe(MG_NOT_AGAIN("S1 uses the same database, and S9's open migration to JSON files already holds it, so it was not stopped", 'press Migrate again once that migration ends'));
    expect(m.events).not.toContain('stop-sharer:s1');
    expect(m.events).not.toContain('hba-fence');
    expect(m.events.some(x => x.startsWith('POST:'))).toBe(false);
    delete m.bots.s9.migrate;
    const mark = m.events.length;
    const wmark = writes().length;
    expect(await runMigration('b1', 'file', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
    const e = m.events.slice(mark);
    expect(e.indexOf('hba-fence')).toBeGreaterThan(-1);
    expect(e.indexOf('hba-fence')).toBeLessThan(e.findIndex(x => x.startsWith('POST:')));
    expect(writes().slice(wmark).some(r => JSON.stringify(r.sharers) === '["s1"]')).toBe(true);
    expect(last().outcome).toBe('done');
    expect(last().jobId).not.toBe('cli-1');
    expect(last().text).toContain(MG_SHARERS_STAY('S1'));
    expect(last().text).not.toContain(MG_DONE_OPEN);
    expect(last().text).not.toContain(MG_DONE_UNSURE);
  });
  it("X32, the follow's one start on a record cut inside the step renews no line; the step writes them before the POST", async () => {
    adoptSeed({ postgres: true });
    m.bot.script = [{ stage: 'copying' }, { state: 'interrupted', stage: 'copying' }, { stage: 'copying' }, { state: 'done', stage: 'switching' }];
    m.failMigrateWrite = (_n, r) => (r?.isolated ? 'disk full' : null);
    expect(await runMigration('b1', 'file', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
    expect(rec()).toMatchObject({ phase: 'following', hbaFenceSet: true });
    expect(rec().isolated).toBeUndefined();
    m.failMigrateWrite = () => null;
    const mark = m.events.length;
    m.bot.down = true;
    let starts = 0;
    m.start = () => { starts++; m.bot.down = false; return { success: true }; };
    const real = m.app;
    m.app = new Proxy(real, { get: (t, k) => (k === 'b1' ? starts === 0 && m.events.slice(mark).includes('GET') ? false : t[k as string] : t[k as string]) }) as any;
    resumeMigrations();
    await new Promise(r => setTimeout(r, 0));
    await laneDone('b1');
    expect(starts).toBeGreaterThan(0);
    const e = m.events.slice(mark);
    expect(e).not.toContain('hba-refresh');
    expect(e.indexOf('hba-fence')).toBeGreaterThan(e.indexOf('start:migrate'));
    expect(e.indexOf('hba-fence')).toBeLessThan(e.findIndex(x => x.startsWith('POST:')));
    expect(last().outcome).toBe('done');
  });
  it('X31, a renewal that fails at a press on a record waiting at posting names no job', async () => {
    seedFollow({ resumeAt: 'posting' }, 'file');
    m.fenceUp = (refresh) => (refresh ? 'pg_hba.conf could not be rewritten (x)' : null);
    expect(await runMigration('b1', 'file', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'posting' });
    expect(rec().text).toBe(MG_FENCE_WAIT(null, 'pg_hba.conf could not be rewritten (x)'));
    expect(rec().text).not.toContain(rec().jobId);
  });
  it("X31, the bot's start fails at such a press: the text names the last posted job", async () => {
    seedFollow({ resumeAt: 'posting' }, 'postgres');
    m.app.b1 = false;
    m.start = { success: false, error: 'boom' };
    expect(await runMigration('b1', 'postgres', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
    expect(rec().text).toBe('Migration mgr-a is not finished, and the bot could not be started (boom). The bot stays in Maintenance with the migration open; press Migrate to try again.');
  });
  it("(pin) X27's scope: an adopted move to file from an outside database writes no lines", async () => {
    adoptSeed({ external: true });
    expect(await runMigration('b1', 'file', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
    expect(m.events.some(x => x.startsWith('hba-'))).toBe(false);
    expect(m.migrateWrites.some(w => w.rec?.hbaFence)).toBe(false);
  });
  it('D17 a GET 404: P with MG-NOHOOK-KEPT', async () => {
    await follow([http(404)]);
    expect(rec().text).toMatch(/now answers that it has no migrate hook \(404\)/);
  });
  it('D20 a 403 GET parks with MG-AUTH (R2-B4)', async () => {
    await follow([http(403, { success: false, error: 'bad token' })]);
    expect(rec().text).toMatch(/refused the manager's token \(HTTP 403: bad token\)/);
  });
  it('D16 a stage write that fails is logged and the poll goes on', async () => {
    m.failMigrateWrite = (_n, r) => (r?.stage === 'verifying' ? 'disk full' : null);
    await follow([ours('running', 'verifying'), ours('done', 'switching')]);
    expect(last().outcome).toBe('done');
  });
});

describe('E: the refusal rule', () => {
  const press = async (posts: any[], gets: any[]) => {
    seedBot();
    m.bot.postQueue.push(...posts);
    m.bot.getQueue.push(getJob(null), getJob(null), ...gets);
    expect(await runMigration('b1', 'postgres', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
  };
  it('E1 a done job of this `to` (any jobId) counts as done', async () => {
    await press([refusal('busy')], [getJob({ jobId: 'mgr-z', to: 'postgres', state: 'done', destination: DEST })]);
    expect(last()).toMatchObject({ outcome: 'done', jobId: 'mgr-z' });
  });
  it('E2 a running job of this `to` is followed', async () => {
    await press([refusal('busy')], [getJob({ jobId: 'mgr-z', to: 'postgres', state: 'running', destination: DEST }), getJob({ jobId: 'mgr-z', to: 'postgres', state: 'done', destination: DEST })]);
    expect(last()).toMatchObject({ outcome: 'done', jobId: 'mgr-z' });
  });
  it('E3 no answer keeps with the retry clause, then E4 once the GET reads a failed job', async () => {
    const texts: string[] = [];
    (await import('../../src/instance/migrate')).setMigrateListener((_id, ev) => texts.push(ev.text));
    await press([refusal('busy'), refusal('busy')], [noAnswer('migrate unreachable'), getJob({ jobId: 'mgr-q', to: 'postgres', state: 'failed', stage: 'checking' })]);
    expect(texts.some(t => /the bot did not answer, so the manager can't confirm which store holds the data \(migrate unreachable\)\. The bot stays in Maintenance; the manager asks again in 0 seconds\./.test(t))).toBe(true);
    expect(last().text).toMatch(/^The bot refused the migration: busy\./);
  });
  it('E4 a failed job of ours: F', async () => {
    await press([refusal('busy')], [getJob({ jobId: 'mgr-q', to: 'postgres', state: 'failed', stage: 'switching' })]);
    expect(last().outcome).toBe('failed');
  });
  it('E5 a refused token: P', async () => {
    await press([refusal('busy')], [http(401, { success: false, error: 'bad token' })]);
    expect(rec().text).toMatch(/refused the manager's token/);
  });
  it('an adopted job (A29) interrupted at retire-source, then a refused POST: E3 keeps, never F (R3-A1)', async () => {
    seedBot({ postgres: true });
    const cut = { jobId: 'mgr-run', to: 'file' as const, state: 'running', stage: 'reading' };
    m.bot.journal.push(cut);
    m.bot.script = [{}, { state: 'interrupted', stage: 'retire-source' }];
    for (let i = 0; i < 8; i++) m.bot.postQueue.push(refusal('the earlier job is unclassified'));
    expect(await runMigration('b1', 'file', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
    expect(m.bots.b1.migrateLast).toBeUndefined();
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'posting' });
    expect(rec().text).toMatch(/can't confirm whether the old database store was renamed aside/);
  });
  it('the cap and the keep bound reset at a press, and a press on E3\'s spent park mints a new jobId', async () => {
    seedBot();
    m.bots.b1.migrate = { to: 'postgres', from: 'file', destination: 'b1-fleet-postgres:5432/smdb', companion: true, jobId: 'mgr-spent', jobIds: ['mgr-spent'], posted: true, started: 3, kept: 5, phase: 'waiting', resumeAt: 'posting', loginOpened: false, sharers: [], sharersStopped: [], openedAt: 'x' };
    m.bot.getQueue.push(getJob(null));
    m.bots.b1.fleetDb = { ...FLEET_DB };
    m.env.b1.DATA_BACKEND_URL = COMPANION_URL;
    await runMigration('b1', 'postgres', 'press');
    await laneDone('b1');
    expect(m.migrateWrites[0].rec).toMatchObject({ started: 0, kept: 0, phase: 'posting' });
    expect(m.migrateWrites[0].rec.jobId).not.toBe('mgr-spent');
  });
});
