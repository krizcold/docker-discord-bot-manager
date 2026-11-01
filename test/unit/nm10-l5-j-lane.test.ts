import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/docker/containerManager', async () => (await import('./migrate-fake')).cmMock());
vi.mock('../../src/env/manager', async (o) => (await import('./migrate-fake')).envMock(await o()));
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./migrate-fake')).dbLoginMock(await o()));
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./migrate-fake')).hookMock(await o()));
vi.mock('../../src/instance/maintenance', async (o) => {
  const base = (await import('./migrate-fake')).maintenanceMock(await o()) as any;
  return {
    ...base,
    runOrderInOp: (id: string, to: string, msg: string, op: string) => {
      ((globalThis as any).__l5jOrderMsgs ??= []).push(msg);
      return base.runOrderInOp(id, to, msg, op);
    },
  };
});
vi.mock('../../src/instance/fleetBackup', async (o) => (await import('./migrate-fake')).fleetBackupMock(await o()));
vi.mock('../../src/instance/fleetReplica', async (o) => (await import('./migrate-fake')).fleetReplicaMock(await o()));
vi.mock('../../src/instance/fleetSwitch', async () => (await import('./migrate-fake')).fleetSwitchMock());

import { laneDone, resumeMigrations, runMigration, setMigrateListener, MIGRATE_TIMING } from '../../src/instance/migrate';
import { fastTiming, getJob, http, m, noAnswer, refusal, resetMigrate, seedBot, seedSharer, COMPANION_URL, EXTERNAL_URL, FLEET_DB } from './migrate-fake';

const DEST = { host: 'b1-fleet-postgres', port: 5432, database: 'smdb' };
const OWN = 'b1-fleet-postgres:5432/smdb';
const rec = () => m.bots.b1.migrate;
const last = () => m.bots.b1.migrateLast;
let heard: Array<{ text: string; final: boolean; gets: number }> = [];
let onText: ((text: string) => void) | null = null;

beforeEach(() => {
  resetMigrate();
  fastTiming(MIGRATE_TIMING);
  heard = [];
  onText = null;
  (globalThis as any).__l5jOrderMsgs = [];
  setMigrateListener((_id, ev) => { heard.push({ text: ev.text, final: !!ev.final, gets: m.bot.gets }); onText?.(ev.text); });
});
afterEach(() => { setMigrateListener(null); vi.restoreAllMocks(); });

function seedFollow(over: Record<string, unknown> = {}, to: 'postgres' | 'file' = 'postgres') {
  if (to === 'postgres') seedBot({ url: COMPANION_URL, inst: { fleetDb: { ...FLEET_DB } } });
  else seedBot({ postgres: true });
  m.bots.b1.migrate = {
    to, from: to === 'postgres' ? 'file' : 'postgres', destination: to === 'postgres' ? OWN : null, companion: to === 'postgres',
    jobId: 'mgr-a', jobIds: ['mgr-a'], posted: true, started: 1, kept: 0, phase: 'waiting', resumeAt: 'following', loginOpened: false, sharers: [], sharersStopped: [], openedAt: 'x',
    ...(to === 'file' ? { hbaFence: 'migrate:1', hbaFenceSet: true, isolated: true } : {}), ...over,
  };
}
async function pressLane(to: 'postgres' | 'file') {
  expect(await runMigration('b1', to, 'press')).toEqual({ accepted: true });
  await laneDone('b1');
}
async function resumeLane() {
  resumeMigrations();
  await new Promise(r => setTimeout(r, 0));
  await laneDone('b1');
}
const ours = (state: string, stage = 'copying', more: Record<string, unknown> = {}) => getJob({ jobId: 'mgr-a', to: 'postgres', state, stage, destination: DEST, ...more });
const CC = () => http(500, { success: false, error: "Can't confirm which store holds the data: the journal is unreadable" });
const posted = () => m.bot.posts[m.bot.posts.length - 1].jobId;

describe('D: the quiet window while following', () => {
  const clock = () => vi.spyOn(Date, 'now').mockImplementation(() => 1_000_000 + 15 * m.bot.gets);
  beforeEach(() => { Object.assign(MIGRATE_TIMING, { silentCheckMs: 15, silentParkMs: 60 }); });

  it('the progress line starts at the check time, one per quiet poll, and the park comes at the park time exactly', async () => {
    seedFollow();
    m.bot.down = true;
    clock();
    await pressLane('postgres');
    const quiet = heard.filter(h => h.text === 'Migration mgr-a: the bot has not answered for 0 seconds');
    expect(quiet.map(h => h.gets)).toEqual([2, 3, 4]);
    expect(m.bot.gets).toBe(5);
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'following' });
    expect(rec().text).toBe("The manager can't confirm how migration mgr-a ends: the bot has not answered for 0 seconds (migrate unreachable: connect ECONNREFUSED). The bot stays in Maintenance with the migration open; press Migrate to ask again once the bot runs.");
    expect(m.events).not.toContain('start:migrate');
  });

  it('a stopped bot gets one start in the window, even when the start fails and docker still shows it stopped', async () => {
    seedFollow();
    m.bot.getQueue.push(() => { m.app.b1 = false; return noAnswer(); });
    m.bot.down = true;
    m.start = () => (m.bot.gets > 0 ? { success: false, error: 'port busy' } : { success: true });
    clock();
    await pressLane('postgres');
    expect(m.events.filter(e => e === 'start:migrate')).toHaveLength(1);
    expect(m.events.some(e => e.startsWith('db-ready:'))).toBe(false);
    expect(rec().text).toMatch(/^The manager can't confirm how migration mgr-a ends: the bot has not answered for 0 seconds/);
  });

  it("after that start, a move from the bot's managed database waits for that database", async () => {
    seedFollow({}, 'file');
    m.bot.getQueue.push(() => { m.app.b1 = false; return noAnswer(); });
    m.bot.down = true;
    m.start = () => {
      if (m.bot.gets > 0) m.sidecar[FLEET_DB.containerName] = 'restarting';
      return { success: true };
    };
    clock();
    await pressLane('file');
    expect(rec().text).toBe(`Migration mgr-a is not finished, and the bot's database did not accept connections within 30 seconds of the start (${FLEET_DB.containerName}: it did not accept connections within 30 seconds of the restart). The bot stays in Maintenance with the migration open; press Migrate to try again.`);
  });
});

describe('D10 and E3: the keep and re-POST counters', () => {
  it('a re-POST for another job counts one keep', async () => {
    seedFollow();
    m.bot.getQueue.push(getJob({ jobId: 'mgr-old', to: 'postgres', state: 'failed', stage: 'checking' }));
    await pressLane('postgres');
    expect(m.migrateWrites.some(w => w.rec?.kept === 1)).toBe(true);
    expect(m.bot.posts[0].jobId).toBe('mgr-a');
  });
  it('a keep under the bounds counts one keep and POSTs under a new jobId', async () => {
    seedFollow({ phase: 'following', resumeAt: undefined });
    m.bot.getQueue.push(CC());
    await resumeLane();
    expect(m.migrateWrites.some(w => w.rec?.kept === 1)).toBe(true);
    expect(m.bot.posts.length).toBeGreaterThan(0);
    expect(m.bot.posts[0].jobId).not.toBe('mgr-a');
  });
  it('a keep at three starts parks at posting with the cap clause', async () => {
    seedFollow({ phase: 'following', resumeAt: undefined, started: 3 });
    m.bot.getQueue.push(CC());
    await resumeLane();
    expect(m.bot.posts).toHaveLength(0);
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'posting' });
    expect(rec().text).toMatch(/ The bot stays in Maintenance; the manager has started it three times and does not ask again; press Migrate to go on\.$/);
  });
  it('a keep at five keeps parks at posting with the keep clause', async () => {
    seedFollow({ phase: 'following', resumeAt: undefined, kept: 5 });
    m.bot.getQueue.push(CC());
    await resumeLane();
    expect(m.bot.posts).toHaveLength(0);
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'posting' });
    expect(rec().text).toMatch(/ The bot stays in Maintenance; the manager asked five times and does not ask again; press Migrate to go on\.$/);
  });
  it('a shutdown during the keep wait mints no new jobId', async () => {
    seedFollow({ phase: 'following', resumeAt: undefined });
    m.bot.getQueue.push(CC());
    onText = t => { if (t.startsWith('Migration mgr-a is not finished:')) m.shuttingDown = true; };
    await resumeLane();
    expect(m.bot.posts).toHaveLength(0);
    expect(m.migrateWrites[m.migrateWrites.length - 1].rec.jobId).toBe('mgr-a');
  });
});

describe('E: the refusal rule', () => {
  const pressRefused = async (gets: any[]) => {
    seedBot();
    m.bot.postQueue.push(refusal('busy'));
    m.bot.getQueue.push(getJob(null), getJob(null), ...gets);
    await pressLane('postgres');
  };
  it('a running job of this `to` is saved before the follow starts', async () => {
    await pressRefused([getJob({ jobId: 'mgr-z', to: 'postgres', state: 'running', destination: DEST }), getJob({ jobId: 'mgr-z', to: 'postgres', state: 'done', destination: DEST })]);
    expect(m.migrateWrites.find(w => w.rec?.phase === 'following').rec.jobId).toBe('mgr-z');
  });
  it('a GET 404 parks with MG-NOHOOK-KEPT', async () => {
    await pressRefused([http(404)]);
    expect(rec().text).toBe(`Migration ${posted()} is not finished, and the bot now answers that it has no migrate hook (404), so the manager can't confirm which store holds the data. The bot stays in Maintenance with the migration open, since closing it now could leave the bot set to a store the migration already retired; press Migrate to ask again.`);
  });
  it('a spent job with no error is named as such', async () => {
    seedFollow({ phase: 'following', resumeAt: undefined, started: 3 });
    const cut = () => getJob({ jobId: 'mgr-a', to: 'postgres', state: 'interrupted', stage: 'copying', destination: DEST });
    m.bot.getQueue.push(cut(), cut());
    await resumeLane();
    expect(last().text).toBe('Migration mgr-a was interrupted at copying (the bot gave no error), and the manager has started it three times. Nothing was switched: the bot stays in Maintenance and keeps its data in its JSON files. Press Migrate to try again.');
  });
});

describe('G1 to G4: the done step', () => {
  const DEST_OWN = (jobId: string, why: string) => `Migration ${jobId} is done, and the bot names ${OWN}, this bot's own managed database, as the database the copy went to, but ${why}, so Migrate does not move the bot onto it: the migration was closed with the Data Backend unchanged, and the bot stays in Maintenance. The JSON files keep the data as it was before the copy, but after this migration the bot refuses to boot on them, and no bot starts on a database whose removal did not finish; running the decommission or the re-seed again finishes the removal and deletes the copy.`;
  it('a removal of its own database is the reason even while docker shows that database restarting', async () => {
    seedBot({ url: EXTERNAL_URL });
    m.bot.destination = DEST;
    m.bots.b1.fleetDb = { ...FLEET_DB, retiringAt: '2026-10-30T00:00:00.000Z' };
    m.sidecar[FLEET_DB.containerName] = 'restarting';
    await pressLane('postgres');
    expect(last().text).toBe(DEST_OWN(m.bot.posts[0].jobId, 'that database is being removed (since 2026-10-30T00:00:00.000Z)'));
  });
  it('its own database stopped: no fence read, and the destination is asked for', async () => {
    seedBot({ url: EXTERNAL_URL });
    m.bot.destination = DEST;
    m.bots.b1.fleetDb = { ...FLEET_DB };
    m.sidecar[FLEET_DB.containerName] = false;
    m.fence = { ok: false, error: 'psql failed' };
    await pressLane('postgres');
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'following', awaiting: 'destination' });
  });
  it('a stored URL changed meanwhile to another database parks with MG-DEST-URL (D141)', async () => {
    seedFollow();
    m.bot.getQueue.push(() => { m.env.b1.DATA_BACKEND_URL = 'postgresql://smdb:pw@other-host:5432/smdb'; return ours('done', 'switching'); });
    await pressLane('postgres');
    expect(m.migrateWrites.some(w => w.rec?.phase === 'finishing')).toBe(false);
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'following', awaiting: 'destination' });
    expect(rec().text).toMatch(/, but the Database URL names other-host:5432\/smdb\. The bot stays in Maintenance and its Data Backend is unchanged\. Set the Database URL to /);
  });
  it('a done job that names no database parks with MG-DEST', async () => {
    seedFollow();
    m.bot.getQueue.push(ours('done', 'switching', { destination: undefined }));
    await pressLane('postgres');
    expect(rec().text).toBe(`Migration mgr-a is done, but the manager can't confirm which database the copy went to: the bot names no database, and the manager passed ${OWN}. The bot stays in Maintenance and its Data Backend is unchanged. Set the Database URL to the database the copy went to, then press Migrate.`);
  });
  it('the finishing save is announced', async () => {
    seedBot();
    await pressLane('postgres');
    expect(heard.map(h => h.text)).toContain('Storing the new Data Backend and restarting the bot on Postgres');
  });
});

describe('G5 to G14: the finish', () => {
  const at = (e: string, from = 0) => m.events.findIndex((x, i) => i >= from && x.startsWith(e));
  const APPLY = (jobId: string, err: string) => `Migration ${jobId} moved the data to Postgres at ${OWN}, and the new Data Backend is stored, but the restart that applies it failed (${err}). The bot stays in Maintenance; press Migrate to apply it again.`;
  const onWrite = (finishing: string, fn: () => void) => { m.failMigrateWrite = (_n, r) => { if (r?.finishing === finishing) fn(); return null; }; };

  it('with no fence the store write follows the finishing save directly', async () => {
    seedBot();
    await pressLane('postgres');
    const fin = at('record:finishing');
    expect(m.events[fin]).toBe('record:finishing');
    expect(m.events[fin + 1]).toBe('env-inop:{"DATA_BACKEND":"postgres"}');
  });
  it('a shutdown after stored ends before the restart', async () => {
    seedBot();
    onWrite('stored', () => { m.shuttingDown = true; });
    await pressLane('postgres');
    expect(at('stop:migrate', at('record:finishing:stored'))).toBe(-1);
    expect(rec().finishing).toBe('stored');
  });
  it('a shutdown after applied ends before the env read', async () => {
    seedBot();
    onWrite('applied', () => { m.shuttingDown = true; });
    await pressLane('postgres');
    expect(m.events).not.toContain('env-read');
  });
  it('a shutdown after confirmed ends before the order', async () => {
    seedBot();
    onWrite('confirmed', () => { m.shuttingDown = true; });
    await pressLane('postgres');
    expect(m.events).not.toContain('order:running:migrate');
    expect(heard.map(h => h.text)).not.toContain('Taking the bot out of maintenance');
  });
  it('an attach that fails with no error parks with MG-APPLY', async () => {
    seedBot();
    onWrite('stored', () => { m.attach = { success: false }; });
    await pressLane('postgres');
    expect(rec().text).toBe(APPLY(m.bot.posts[0].jobId, 'no reason given'));
  });
  it('a stop that fails with no error parks with MG-APPLY', async () => {
    seedBot();
    onWrite('stored', () => { m.stop = { success: false }; });
    await pressLane('postgres');
    expect(rec().text).toBe(APPLY(m.bot.posts[0].jobId, 'no reason given'));
  });
  it('a start that fails with no error parks with MG-APPLY', async () => {
    seedBot();
    onWrite('stored', () => { m.start = { success: false }; });
    await pressLane('postgres');
    expect(rec().text).toBe(APPLY(m.bot.posts[0].jobId, 'no reason given'));
  });
  it('a container URL naming another database parks with MG-ENV', async () => {
    seedBot();
    m.containerEnv = { ok: true, env: { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: 'postgresql://smdb:pw@other-host:5432/smdb' } };
    await pressLane('postgres');
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'finishing', finishing: 'stored' });
    expect(rec().text).toBe(`Migration ${m.bot.posts[0].jobId} moved the data to Postgres at ${OWN}, but after the restart the bot's container reads DATA_BACKEND=postgres, and its Database URL names other-host:5432/smdb (the start reported no error). The bot stays in Maintenance; press Migrate to apply it again.`);
  });
  it('a container with no URL names no database', async () => {
    seedBot();
    m.containerEnv = { ok: true, env: { DATA_BACKEND: 'postgres' } };
    await pressLane('postgres');
    expect(rec().text).toBe(`Migration ${m.bot.posts[0].jobId} moved the data to Postgres at ${OWN}, but after the restart the bot's container reads DATA_BACKEND=postgres, and its Database URL names no database (the start reported no error). The bot stays in Maintenance; press Migrate to apply it again.`);
  });
  it('a container with no DATA_BACKEND reads nothing, with each setting the start left out', async () => {
    seedBot();
    m.start = { success: true, notApplied: ['DATA_BACKEND was not applied', 'the URL was not applied'] };
    m.containerEnv = { ok: true, env: {} };
    await pressLane('postgres');
    expect(rec().text).toBe(`Migration ${m.bot.posts[0].jobId} moved the data to Postgres at ${OWN}, but after the restart the bot's container reads DATA_BACKEND=nothing, and its Database URL names no database (DATA_BACKEND was not applied; the URL was not applied). The bot stays in Maintenance; press Migrate to apply it again.`);
  });
  it('a move to JSON files with a mismatch names no URL', async () => {
    seedBot({ postgres: true });
    m.containerEnv = { ok: true, env: { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: COMPANION_URL } };
    await pressLane('file');
    expect(rec().text).toBe(`Migration ${m.bot.posts[0].jobId} moved the data to JSON files, but after the restart the bot's container reads DATA_BACKEND=postgres (the start reported no error). The bot stays in Maintenance; press Migrate to apply it again.`);
  });
  it('the order for Running carries no message, and the step is announced', async () => {
    seedBot();
    await pressLane('postgres');
    expect((globalThis as any).__l5jOrderMsgs).toEqual(['']);
    expect(heard.map(h => h.text)).toContain('Taking the bot out of maintenance');
  });
  it('the close is logged and broadcast as final', async () => {
    seedBot();
    const log = vi.spyOn(console, 'log');
    await pressLane('postgres');
    const id = last().jobId;
    expect(log).toHaveBeenCalledWith(`[Migrate] B1: migration ${id} to postgres is done; the Data Backend is now postgres`);
    expect(heard[heard.length - 1]).toMatchObject({ text: last().text, final: true });
  });
  it('a close save that fails broadcasts no final text', async () => {
    seedBot();
    m.failMigrateWrite = (_n, r) => (r === null ? 'disk full' : null);
    await pressLane('postgres');
    expect(rec().finishing).toBe('confirmed');
    expect(heard.some(h => h.text.startsWith('The data moved to'))).toBe(false);
  });
});

describe('F: the close', () => {
  const failedJob = () => { m.bot.postQueue.push({ ok: true, status: 200, body: { success: true, jobId: 'mgr-f', to: 'file', state: 'failed', stage: 'copying', error: 'disk full' } }); };
  const FAILED = 'Migration mgr-f failed at copying: disk full. Nothing was switched: the bot stays in Maintenance and keeps its data in its database.';

  it('the close is logged with its text', async () => {
    seedBot({ postgres: true });
    failedJob();
    const log = vi.spyOn(console, 'log');
    await pressLane('file');
    expect(last().text).toBe(FAILED);
    expect(log).toHaveBeenCalledWith(`[Migrate] B1: migration to file closed: ${FAILED}`);
  });
  it('a close save that fails broadcasts no final text', async () => {
    seedBot({ postgres: true });
    failedJob();
    m.failMigrateWrite = (_n, r) => (r === null ? 'disk full' : null);
    await pressLane('file');
    expect(heard.some(h => h.text === FAILED)).toBe(false);
    expect(rec().phase).toBe('closing');
  });
  it('a stopped sharer whose state is off is not started again', async () => {
    seedBot({ postgres: true });
    seedSharer('s1');
    failedJob();
    m.sharerStop = (id: string) => { m.bots[id].maintenance = { state: 'off' }; return { success: true }; };
    await pressLane('file');
    expect(m.events).toContain('stop-sharer:s1');
    expect(m.events).not.toContain('start-sharer:s1');
    expect(last().text).toBe(FAILED);
  });
  it("a sharer start answering 'Bot is already running' adds no warning", async () => {
    seedBot({ postgres: true });
    seedSharer('s1');
    failedJob();
    m.sharerStart = { success: false, error: 'Bot is already running' };
    await pressLane('file');
    expect(m.events).toContain('start-sharer:s1');
    expect(last().text).toBe(FAILED);
  });
  it('a sharer start that fails with no error is named with no reason', async () => {
    seedBot({ postgres: true });
    seedSharer('s1');
    failedJob();
    m.sharerStart = { success: false };
    await pressLane('file');
    expect(last().text).toBe(`${FAILED} S1 did not start again (no reason given); start it by hand.`);
  });
  const loginStays = (login: { canLogin: boolean; sessions: number }) => {
    onText = t => {
      if (!t.startsWith('Setting the bot back on')) return;
      m.login = { inRecovery: false, get canLogin() { return login.canLogin; }, set canLogin(_v) {}, get sessions() { return login.sessions; }, set sessions(_v) {} } as any;
    };
  };
  it('a login that reads open after its block keeps the migration open', async () => {
    seedBot({ postgres: true });
    failedJob();
    loginStays({ canLogin: true, sessions: 0 });
    await pressLane('file');
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'closing' });
    expect(rec().text).toBe(`${FAILED} The bot's database login, which the migration opened, could not be blocked again (the login read back as open after it was blocked), so the migration stays open with the login open; press Migrate to block it again.`);
  });
  it('sessions left open after the block keep the migration open', async () => {
    seedBot({ postgres: true });
    failedJob();
    loginStays({ canLogin: false, sessions: 2 });
    await pressLane('file');
    expect(rec().text).toBe(`${FAILED} The bot's database login, which the migration opened, could not be blocked again (2 session(s) of the bot's role are still open), so the migration stays open with the login open; press Migrate to block it again.`);
  });
  it('a stopped database that does not start, with no error, is named with no reason', async () => {
    seedBot({ postgres: true });
    m.app.b1 = false;
    m.sidecar[FLEET_DB.containerName] = false;
    m.dbStart = { success: false };
    m.bots.b1.migrate = { to: 'file', from: 'postgres', destination: null, companion: false, jobId: 'mgr-f', jobIds: ['mgr-f'], posted: true, started: 1, kept: 0, phase: 'waiting', resumeAt: 'closing', loginOpened: true, sharers: [], sharersStopped: [], isolated: true, openedAt: 'x', text: 'Migration mgr-f failed.' };
    await pressLane('file');
    expect(last().text).toBe("Migration mgr-f failed. The manager can't confirm that the bot's database login, which the migration opened, is blocked again: the managed database is stopped and did not start (no reason given). Once the database runs, the manager's maintenance check blocks the login while the bot's state is not Running.");
  });
  it('fence lines already gone close the migration', async () => {
    seedBot({ postgres: true });
    failedJob();
    m.fenceLift = 'gone';
    await pressLane('file');
    expect(m.events).toContain('hba-lift');
    expect(rec()).toBeUndefined();
    expect(last().text).toBe(FAILED);
  });
});

describe('X27 and X31: the adoption search and the fence at the follow', () => {
  const P_OPEN = /^Following the move the bot was already running/;
  const adopt = (url: string | undefined) => {
    seedBot({ postgres: true });
    if (url === undefined) delete m.env.b1.DATA_BACKEND_URL;
    else m.env.b1.DATA_BACKEND_URL = url;
    m.bots.s2 = { id: 's2', displayName: 'S2', sanitizedName: 's2', sourceUrl: m.bots.b1.sourceUrl, envVars: {}, status: 'running', createdAt: 'x', updatedAt: 'x' };
    m.env.s2 = { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: COMPANION_URL };
    m.app.s2 = true;
    m.liveSharers = ['s2'];
    m.bot.journal = [{ jobId: 'cli-1', to: 'file', state: 'running', stage: 'copying' }];
    m.bot.script = [{ stage: 'copying' }, { state: 'done', stage: 'switching' }];
  };
  it.each([['no URL', undefined], ['a blank URL', '   ']])('an adopted move with %s searches for no sharer', async (_n, url) => {
    adopt(url);
    await pressLane('file');
    expect(m.migrateWrites.some(w => w.rec?.sharers?.includes('s2'))).toBe(false);
  });
  it('an adopted move with no sharer writes the record no twice in a row', async () => {
    seedBot({ postgres: true });
    m.bot.journal = [{ jobId: 'cli-1', to: 'file', state: 'running', stage: 'copying' }];
    m.bot.script = [{ stage: 'copying' }, { state: 'done', stage: 'switching' }];
    await pressLane('file');
    const recs = m.migrateWrites.map(w => JSON.stringify(w.rec));
    expect(recs.some((r, i) => i > 0 && r === recs[i - 1])).toBe(false);
  });
  it('a move to Postgres is followed with no open-database line', async () => {
    seedFollow();
    m.bot.getQueue.push(ours('done', 'switching'));
    await pressLane('postgres');
    expect(heard.some(h => P_OPEN.test(h.text))).toBe(false);
    expect(last().outcome).toBe('done');
  });
  const unisolated = (over: Record<string, unknown>) => {
    seedBot({ postgres: true });
    seedSharer('s1');
    m.bots.b1.migrate = { to: 'file', from: 'postgres', destination: null, companion: false, jobId: 'mgr-a', jobIds: ['mgr-a'], posted: true, started: 1, kept: 0, phase: 'following', loginOpened: false, sharers: ['s1'], sharersStopped: [], openedAt: 'x', ...over };
  };
  it('a resume at posting of a record cut before the step names no open database', async () => {
    unisolated({ phase: 'posting', posted: false });
    await resumeLane();
    expect(heard.some(h => P_OPEN.test(h.text))).toBe(false);
  });
  it('a resume at following of a record cut after its lines were written names no open database', async () => {
    unisolated({ hbaFence: 'migrate:1', hbaFenceSet: true });
    m.app.s1 = false;
    m.bot.journal = [{ jobId: 'mgr-a', to: 'file', state: 'running', stage: 'copying' }];
    await resumeLane();
    expect(heard.some(h => P_OPEN.test(h.text))).toBe(false);
  });
  it('a resume at following of a record cut after a sharer stopped names no open database', async () => {
    unisolated({ sharersStopped: ['s1'] });
    m.app.s1 = false;
    m.bot.journal = [{ jobId: 'mgr-a', to: 'file', state: 'running', stage: 'copying' }];
    await resumeLane();
    expect(heard.some(h => P_OPEN.test(h.text))).toBe(false);
  });
  it('a move to Postgres with no fence lines renews none at the follow, even with its database restarting after its start', async () => {
    seedFollow();
    m.sidecar = new Proxy({}, {
      get: () => (m.events.includes('db-start:b1') ? 'restarting' : false),
      set: () => true,
      has: () => true,
    }) as any;
    m.bot.getQueue.push(ours('running'));
    await pressLane('postgres');
    expect(rec()?.text ?? '').not.toMatch(/could not renew the lines/);
  });
});
