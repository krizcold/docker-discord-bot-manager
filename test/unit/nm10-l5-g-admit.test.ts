import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/docker/containerManager', async () => (await import('./migrate-fake')).cmMock());
vi.mock('../../src/env/manager', async (o) => (await import('./migrate-fake')).envMock(await o()));
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./migrate-fake')).dbLoginMock(await o()));
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./migrate-fake')).hookMock(await o()));
vi.mock('../../src/instance/maintenance', async (o) => (await import('./migrate-fake')).maintenanceMock(await o()));
vi.mock('../../src/instance/fleetBackup', async (o) => (await import('./migrate-fake')).fleetBackupMock(await o()));
vi.mock('../../src/instance/fleetReplica', async (o) => (await import('./migrate-fake')).fleetReplicaMock(await o()));
vi.mock('../../src/instance/fleetSwitch', async () => (await import('./migrate-fake')).fleetSwitchMock());

import * as cm from '../../src/docker/containerManager';
import { laneDone, runMigration, setMigrateListener, MIGRATE_TEXT as T, MIGRATE_TIMING } from '../../src/instance/migrate';
import { fastTiming, getJob, m, resetMigrate, seedBot, seedSharer, COMPANION_URL, EXTERNAL_URL, FLEET_DB } from './migrate-fake';

beforeEach(() => { resetMigrate(); fastTiming(MIGRATE_TIMING); });
afterEach(() => { setMigrateListener(null); vi.restoreAllMocks(); });

const PENDING = Symbol('pending');
const settle = <T>(p: Promise<T>) => Promise.race([p, new Promise<typeof PENDING>(r => setTimeout(() => r(PENDING), 100))]);

async function press(to: unknown, id = 'b1') {
  const a = await settle(runMigration(id, to, 'press'));
  await laneDone(id);
  return a;
}

const CHANGED = "The bot's Data Backend or its Database URL changed while the migration was being admitted; press Migrate again; nothing was changed";
const openRec = (over: Record<string, unknown> = {}) => ({ to: 'postgres', from: 'file', destination: 'b1-fleet-postgres:5432/smdb', companion: true, jobId: 'mgr-a', jobIds: ['mgr-a'], posted: true, started: 1, kept: 0, phase: 'following', loginOpened: false, sharers: [], sharersStopped: [], openedAt: 'x', text: 't', ...over });
const adoptRunning = (to: 'postgres' | 'file') => {
  m.bot.journal.push({ jobId: 'mgr-run', to, state: 'running', stage: 'copying' });
  m.bot.script = [{}, { state: 'failed', stage: 'copying', error: 'stop here' }];
};

describe('the texts an operator reads', () => {
  it('progress and parked texts read exactly', () => {
    expect(T.whyLiftVolume('v1')).toBe('docker did not answer whether the database volume v1 exists');
    expect(T.retryCap).toBe('the manager has started it three times and does not ask again; press Migrate to go on');
    expect(T.fenceF('x')).toBe("The migration closed before its copy: the manager could not close the bot's database to other connections (x), and a move to JSON files renames that database's data aside, which a bot or program the manager cannot see may be using. Nothing was copied, and the bot stays in Maintenance.");
    expect(T.whyDbDown('restarting')).toBe("docker shows the bot's managed database restarting after its start");
    expect(T.whyDbDown('stopped')).toBe("docker shows the bot's managed database stopped after its start");
    expect(T.whyDbDown(null)).toBe("docker did not say whether the bot's managed database runs after its start");
    expect(T.whyDbDown('running')).toBe("docker did not say whether the bot's managed database runs after its start");
    expect(T.env('mgr-1', 'JSON files', 'postgres', null, 'n')).toBe('Migration mgr-1 moved the data to JSON files, but after the restart the bot\'s container reads DATA_BACKEND=postgres (n). The bot stays in Maintenance; press Migrate to apply it again.');
    expect(T.env('mgr-1', 'JSON files', 'postgres', 'h:5432/d', 'n')).toBe('Migration mgr-1 moved the data to JSON files, but after the restart the bot\'s container reads DATA_BACKEND=postgres, and its Database URL names h:5432/d (n). The bot stays in Maintenance; press Migrate to apply it again.');
    expect(T.dbWait('mgr-1', 'e')).toBe("Migration mgr-1 is not finished, and the bot's database did not accept connections within 30 seconds of the start (e). The bot stays in Maintenance with the migration open; press Migrate to try again.");
    expect(T.envDb('mgr-1', 'd', null)).toBe('Migration mgr-1 moved the data to Postgres at d, but the managed database is not running after the restart, and docker did not say whether it runs. The bot stays in Maintenance; press Migrate to start it and apply again.');
    expect(T.envDb('mgr-1', 'd', 'stopped')).toBe('Migration mgr-1 moved the data to Postgres at d, but the managed database is not running after the restart. The bot stays in Maintenance; press Migrate to start it and apply again.');
    expect(T.destOwn('mgr-1', 'd', 'w')).toBe("Migration mgr-1 is done, and the bot names d, this bot's own managed database, as the database the copy went to, but w, so Migrate does not move the bot onto it: the migration was closed with the Data Backend unchanged, and the bot stays in Maintenance. The JSON files keep the data as it was before the copy, but after this migration the bot refuses to boot on them; it boots on the copy once its Data Backend is postgres and its Database URL names d.");
    expect(T.pDb).toBe('Starting the managed database');
    expect(T.pLogin).toBe("Opening the bot's database login");
    expect(T.pSave).toBe('Asking the bot to save what it holds');
    expect(T.pOpen([])).toBe('Following the move the bot was already running, with its database open to other connections');
    expect(T.pOpen(['S2'])).toBe('Following the move the bot was already running, with its database open to other connections; S2 uses it, and the manager does not stop it');
    expect(T.pOpen(['S2', 'S3'], ['S2', 'S3'])).toBe("Following the move the bot was already running, with its database open to other connections; S2, S3 use it, and the manager does not stop them; S2's own managed database has replication on, so this migration does not hold S2, and the manager can still start, update or build it; S3's own managed database has replication on, so this migration does not hold S3, and the manager can still start, update or build it");
    expect(T.pRestart).toBe('Restarting the bot into maintenance');
    expect(T.pPost('mgr-1')).toBe('Starting migration mgr-1');
    expect(T.pRun('mgr-1')).toBe('Migration mgr-1 is running');
    expect(T.pStage('mgr-1', 'copying')).toBe('Migration mgr-1: copying');
    expect(T.pAgain('mgr-1', 'copying')).toBe('Migration mgr-1 was interrupted at copying; starting it again');
    expect(T.pNoAnswer('mgr-1', 30)).toBe('Migration mgr-1: the bot has not answered for 30 seconds');
    expect(T.pUnusable('mgr-1', 30, 500, 'boom')).toBe('Migration mgr-1: for 30 seconds the manager got no answer it could use (last: HTTP 500: boom)');
    expect(T.pFinish('Postgres')).toBe('Storing the new Data Backend and restarting the bot on Postgres');
    expect(T.pBack).toBe('Taking the bot out of maintenance');
    expect(T.pClose('its database')).toBe('Setting the bot back on its database');
  });
});

describe('the progress broadcast', () => {
  it('progress events are not final', async () => {
    seedBot();
    const evs: Array<{ text: string; final: boolean }> = [];
    setMigrateListener((_id, ev) => evs.push(ev));
    await press('postgres');
    expect(evs.find(e => e.text === T.pDb)).toEqual({ text: T.pDb, final: false });
  });
  it('a listener that throws is logged and the lane goes on', async () => {
    seedBot();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    setMigrateListener(() => { throw new Error('socket gone'); });
    expect(await press('postgres')).toEqual({ accepted: true });
    expect(err).toHaveBeenCalledWith('[Migrate] b1: the progress broadcast failed: socket gone');
    expect(m.bots.b1.migrateLast).toBeDefined();
  });
});

describe('the closing text keeps an error that spans lines', () => {
  const failure = 'Migration mgr-f failed at copying: disk full. Nothing was switched: the bot stays in Maintenance and keeps its data in its database.';
  it.each([
    ['the env set back', ' The stored Data Backend could not be set back to Postgres (store\nlocked), so the migration stays open; press Migrate to set it again.'],
    ['the login block', " The bot's database login, which the migration opened, could not be blocked again (exec\nfailed), so the migration stays open with the login open; press Migrate to block it again."],
    ['the fence lift', " The lines the migration added to the database's pg_hba.conf, which refuse every connection but this bot's and the manager's, could not be removed (exec\nfailed), so the migration stays open; press Migrate to remove them again."],
  ])('%s: a tail with a line break stays whole', async (_n, tail) => {
    seedBot({ postgres: true });
    m.env.b1.DATA_BACKEND = 'file';
    m.bots.b1.migrate = openRec({ to: 'file', from: 'postgres', destination: null, companion: false, jobId: 'mgr-f', jobIds: ['mgr-f'], phase: 'waiting', resumeAt: 'closing', isolated: true, text: failure + tail });
    await press('file');
    expect(m.bots.b1.migrateLast.text).toBe(failure + tail);
  });
});

describe('the env read', () => {
  it('an app without a companion setting reads DATA_BACKEND_URL as the URL key in a resumed close', async () => {
    seedBot({ postgres: true, inst: { sourceUrl: 'https://github.com/x/plain-bot' } });
    m.envStatus.undecryptable = ['DATA_BACKEND_URL'];
    m.bots.b1.migrate = openRec({ to: 'file', from: 'postgres', destination: null, companion: false, jobId: 'mgr-f', jobIds: ['mgr-f'], phase: 'closing', isolated: true, text: 'Migration mgr-f failed at copying: disk full.' });
    await settle(runMigration('b1', 'file', 'resume'));
    await laneDone('b1');
    expect(m.bots.b1.migrate.text).toContain("could not be set back to Postgres (The env store for this instance cannot be read, so the manager can't tell which database the bot uses; nothing was changed)");
  });
  it('the registry envVars stand under the env store', async () => {
    seedBot({ inst: { envVars: { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: EXTERNAL_URL } } });
    m.env.b1 = {};
    expect(await press('file')).toEqual({ accepted: true });
  });
  it('an undecryptable key reads as blank', async () => {
    seedBot({ url: 'postgresql://u:secret@db.example.test/app', env: { PGPORT: 'enc:v1:x' } });
    m.envStatus.undecryptable = ['PGPORT'];
    expect(await press('postgres')).toEqual({ accepted: true });
  });
});

describe('admission order and exact refusals', () => {
  it('an op lock refuses before a database hold', async () => {
    seedBot();
    m.lock.b1 = 'build';
    m.hold = true;
    expect(await press('postgres')).toEqual({ accepted: false, status: 409, error: "Operation 'build' already in progress" });
  });
  it('a running migrate op refuses a press with 409', async () => {
    seedBot();
    m.lock.b1 = 'migrate';
    expect(await press('postgres')).toEqual({ accepted: false, status: 409, error: "Operation 'migrate' already in progress" });
  });
  it('a delete lane names Migrate', async () => {
    seedBot();
    m.deleteLane = true;
    expect(await press('postgres')).toEqual({ accepted: false, status: 409, error: 'A Delete of this instance did not finish; Migrate is refused until Delete is run again' });
  });
  it('an unsettled order with no error says the order has not finished', async () => {
    seedBot();
    m.bots.b1.maintenance = { ...m.bots.b1.maintenance, settled: false };
    delete m.bots.b1.maintenance.lastError;
    expect(await press('postgres')).toEqual({ accepted: false, status: 409, error: T.unsettled('Maintenance', 'the order has not finished') });
  });
  it('a parked seed admits', async () => {
    seedBot();
    m.seed = { parked: true };
    expect(await press('postgres')).toEqual({ accepted: true });
  });
  it('replication on a managed source refuses a move to file with MG-FLEET-REPL', async () => {
    seedBot({ postgres: true });
    m.bots.b1.fleetDb.replication = { publicHost: 'pub.example', hostPort: 5433 };
    expect(await press('file')).toEqual({ accepted: false, status: 409, error: T.fleetRepl });
  });
  it('a stopped managed database is not asked for its fence', async () => {
    seedBot({ postgres: true });
    m.sidecar[FLEET_DB.containerName] = false;
    m.fence = { ok: false, cls: 'other', error: 'container is not running' };
    expect(await press('file')).toEqual({ accepted: true });
  });
});

describe('resume', () => {
  it('a resume goes past a database hold on its open record', async () => {
    seedBot();
    m.bots.b1.migrate = openRec();
    m.hold = true;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await settle(runMigration('b1', 'postgres', 'resume'))).toEqual({ accepted: true });
    await laneDone('b1');
    expect(log).toHaveBeenCalledWith('[Migrate] B1: the manager restarted during the migration to postgres (following); going on');
  });
  it('a resume under a running migrate op refuses with 409', async () => {
    seedBot();
    m.bots.b1.migrate = openRec();
    m.lock.b1 = 'migrate';
    expect(await settle(runMigration('b1', 'postgres', 'resume'))).toEqual({ accepted: false, status: 409, error: "Operation 'migrate' already in progress" });
  });
  it('a resume of a parked record refuses', async () => {
    seedBot();
    m.bots.b1.migrate = openRec({ phase: 'waiting', resumeAt: 'following' });
    expect(await settle(runMigration('b1', 'postgres', 'resume'))).toEqual({ accepted: false, status: 409, error: 'No migration to resume' });
    await laneDone('b1');
    expect(m.migrateWrites).toEqual([]);
  });
});

describe('a press on an open record', () => {
  it('a failing record write refuses with 500', async () => {
    seedBot();
    m.bots.b1.migrate = openRec({ phase: 'waiting', resumeAt: 'following' });
    m.failMigrateWrite = () => 'disk full';
    expect(await press('postgres')).toEqual({ accepted: false, status: 500, error: T.notRec('disk full') });
  });
});

describe('a change while the admission GET runs', () => {
  it('a database hold that starts refuses with its own text', async () => {
    seedBot();
    m.bot.getQueue.push(() => { m.hold = true; return getJob(null); });
    expect(await press('postgres')).toEqual({ accepted: false, status: 409, error: 'A fleet restore is running on this instance\'s database; Migrate is refused until it ends' });
  });
  it('another destination refuses with MG-CHANGED', async () => {
    seedBot({ url: EXTERNAL_URL });
    m.bot.getQueue.push(() => { m.env.b1.DATA_BACKEND_URL = 'postgresql://u:secret@db2.example.test:5432/app'; return getJob(null); });
    expect(await press('postgres')).toEqual({ accepted: false, status: 409, error: CHANGED });
  });
  it('the URL now naming the managed database refuses with MG-CHANGED', async () => {
    seedBot({ url: COMPANION_URL });
    m.bot.getQueue.push(() => { m.bots.b1.fleetDb = { ...FLEET_DB }; return getJob(null); });
    expect(await press('postgres')).toEqual({ accepted: false, status: 409, error: CHANGED });
  });
  it('a managed source turning external refuses with MG-CHANGED', async () => {
    seedBot({ postgres: true });
    m.bot.getQueue.push(() => { m.env.b1.DATA_BACKEND_URL = EXTERNAL_URL; return getJob(null); });
    expect(await press('file')).toEqual({ accepted: false, status: 409, error: CHANGED });
  });
});

describe('an adopted move to file lists its sharers', () => {
  it('no Database URL: no sharers', async () => {
    seedBot({ postgres: true });
    delete m.env.b1.DATA_BACKEND_URL;
    seedSharer('s2');
    adoptRunning('file');
    expect(await press('file')).toEqual({ accepted: true });
    expect(m.migrateWrites[0].rec).toMatchObject({ adoptedJob: 'mgr-run', sharers: [] });
  });
  it('a blank Database URL: no sharers', async () => {
    seedBot({ postgres: true });
    m.env.b1.DATA_BACKEND_URL = '   ';
    seedSharer('s2');
    adoptRunning('file');
    expect(await press('file')).toEqual({ accepted: true });
    expect(m.migrateWrites[0].rec).toMatchObject({ adoptedJob: 'mgr-run', sharers: [] });
  });
  it('a sharer read that throws: no sharers', async () => {
    seedBot({ postgres: true });
    m.sharers = ['gone'];
    adoptRunning('file');
    expect(await press('file')).toEqual({ accepted: true });
    expect(m.migrateWrites[0].rec).toMatchObject({ adoptedJob: 'mgr-run', sharers: [] });
  });
});

describe('the opening and unexpected errors', () => {
  it('the opening is logged', async () => {
    seedBot();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await press('postgres');
    expect(log).toHaveBeenCalledWith('[Migrate] B1: migration to postgres opened');
  });
  it('an error before admission answers 500 with its text', async () => {
    seedBot({ postgres: true });
    m.fence = null;
    const a = await press('file');
    expect(a).toEqual({ accepted: false, status: 500, error: expect.stringMatching(/^The migration stopped on an unexpected error: \S/) });
  });
  const grabbedBy = (op: string) => {
    const store: Record<string, string> = {};
    m.lock = new Proxy(store, { deleteProperty: (t, k) => { t[k as string] = op; return true; } });
  };
  it('an error before admission with another op taking the lock answers 409', async () => {
    seedBot({ postgres: true });
    m.fence = null;
    grabbedBy('build');
    expect(await press('file')).toEqual({ accepted: false, status: 409, error: "Operation 'build' already in progress" });
  });
  it('an error before admission with a migrate op taking the lock answers 500', async () => {
    seedBot({ postgres: true });
    m.fence = null;
    grabbedBy('migrate');
    expect(await press('file')).toMatchObject({ accepted: false, status: 500 });
  });
  it('an error after admission is logged and broadcast as final', async () => {
    seedBot();
    const real = (cm as any).getBot;
    let n = 0;
    vi.spyOn(cm as any, 'getBot').mockImplementation((id: unknown) => { if (++n === 4) throw new Error('registry gone'); return real(id); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const evs: Array<{ text: string; final: boolean }> = [];
    setMigrateListener((_id, ev) => evs.push(ev));
    expect(await press('postgres')).toEqual({ accepted: true });
    expect(err).toHaveBeenCalledWith('[Migrate] b1: the migration stopped on an unexpected error: registry gone');
    expect(evs.at(-1)).toEqual({ text: T.notRecLane('registry gone'), final: true });
  });
});
