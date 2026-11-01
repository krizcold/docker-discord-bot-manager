import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/docker/containerManager', async () => (await import('./migrate-fake')).cmMock());
vi.mock('../../src/env/manager', async (o) => (await import('./migrate-fake')).envMock(await o()));
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./migrate-fake')).dbLoginMock(await o()));
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./migrate-fake')).hookMock(await o()));
vi.mock('../../src/instance/maintenance', async (o) => (await import('./migrate-fake')).maintenanceMock(await o()));
vi.mock('../../src/instance/fleetBackup', async (o) => (await import('./migrate-fake')).fleetBackupMock(await o()));
vi.mock('../../src/instance/fleetReplica', async (o) => (await import('./migrate-fake')).fleetReplicaMock(await o()));
vi.mock('../../src/instance/fleetSwitch', async () => (await import('./migrate-fake')).fleetSwitchMock());

import { laneDone, runMigration, setMigrateListener, MIGRATE_TIMING } from '../../src/instance/migrate';
import { fastTiming, getJob, m, noAnswer, resetMigrate, seedBot, seedSharer, COMPANION_URL, EXTERNAL_URL, SMDB } from './migrate-fake';

let heard: Array<{ text: string; final: boolean }> = [];
beforeEach(() => {
  resetMigrate();
  fastTiming(MIGRATE_TIMING);
  heard = [];
  setMigrateListener((_id, ev) => heard.push(ev));
});
afterEach(() => { setMigrateListener(null); vi.restoreAllMocks(); });

const NOT_REC_LANE = (err: string) => `The manager could not record the migration's progress (${err}), so it stopped here with the migration open. Press Migrate to go on.`;
const P_SHARERS = (names: string) => `Stopping the other bots on this database (${names})`;
const base = (over: Record<string, unknown> = {}) => ({ to: 'postgres', from: 'file', destination: 'b1-fleet-postgres:5432/smdb', companion: true, jobId: 'mgr-a', jobIds: ['mgr-a'], posted: true, started: 1, kept: 0, loginOpened: true, sharers: [], sharersStopped: [], openedAt: '2026-10-31T00:00:00.000Z', text: 'Migration mgr-a is running', ...over });
const toFile = (over: Record<string, unknown> = {}) => base({ to: 'file', from: 'postgres', destination: null, companion: false, ...over });

/** A bot on the same database that the fleet search does not list as a sharer. */
function addBot(id: string, over: Record<string, unknown> = {}): void {
  m.bots[id] = { id, displayName: id.toUpperCase(), sanitizedName: id, sourceUrl: SMDB, envVars: {}, status: 'running', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...over };
  m.env[id] = { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: COMPANION_URL };
  m.app[id] = true;
}

async function press(to: 'postgres' | 'file') {
  expect(await runMigration('b1', to, 'press')).toEqual({ accepted: true });
  await laneDone('b1');
}
async function resume(rec: Record<string, unknown>) {
  m.bots.b1.migrate = rec;
  expect(await runMigration('b1', rec.to, 'resume')).toEqual({ accepted: true });
  await laneDone('b1');
}
const errors = (spy: { mock: { calls: unknown[][] } }): string[] => spy.mock.calls.map(c => String(c[0]));

describe('the lane after admission (L5 h)', () => {
  it('LH1 an unexpected throw inside the lane is logged and sent as the final progress line', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    seedBot({ postgres: true });
    m.liveSharers = ['gone'];
    await press('file');
    const why = "Cannot read properties of undefined (reading 'id')";
    expect(errors(err)).toContain(`[Migrate] b1: the migration stopped on an unexpected error: ${why}`);
    expect(heard[heard.length - 1]).toEqual({ text: NOT_REC_LANE(why), final: true });
  });

  it('LH2 a resumed record keeps the sharers it already holds and stops them', async () => {
    seedBot({ postgres: true });
    addBot('s2');
    await resume(toFile({ phase: 'preparing', jobIds: [], posted: false, started: 0, loginOpened: false, sharers: ['s2'] }));
    expect(m.events).toContain('stop-sharer:s2');
  });

  it('LH3 the sharers line names both bots and is saved as the record text, with no warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    seedBot({ postgres: true });
    seedSharer('s2');
    seedSharer('s3');
    await press('file');
    expect(heard.map(h => h.text)).toContain(P_SHARERS('S2, S3'));
    expect(m.migrateWrites.some(w => w.rec?.text === P_SHARERS('S2, S3'))).toBe(true);
    expect(errors(warn).filter(t => t.includes('progress line'))).toEqual([]);
  });

  it('LH4 a progress line that cannot be saved is warned with the write error and still sent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    seedBot({ postgres: true });
    seedSharer('s2');
    m.failMigrateWrite = (_n, rec) => (rec?.text === P_SHARERS('S2') ? 'disk full' : null);
    await press('file');
    expect(errors(warn)).toContain('[Migrate] B1: the progress line could not be recorded: disk full');
    expect(heard.map(h => h.text)).toContain(P_SHARERS('S2'));
  });

  it('LH5 a JSON bot moving to its companion is not fenced: its source is not a managed Postgres', async () => {
    seedBot();
    await press('postgres');
    expect(m.events.filter(e => e.startsWith('hba-'))).toEqual([]);
    expect(m.bots.b1.migrateLast.outcome).toBe('done');
  });

  it('LH6 at posting, a held sharer the record did not stop is released from the record; the other stays', async () => {
    seedBot({ postgres: true });
    addBot('s2', { migrate: base({ jobId: 'mgr-s', jobIds: ['mgr-s'] }) });
    addBot('s3');
    await resume(toFile({ phase: 'posting', jobIds: [], posted: false, started: 0, sharers: ['s2', 's3'] }));
    expect(m.bots.b1.migrate.phase).toBe('waiting');
    expect(m.bots.b1.migrate.sharers).toEqual(['s3']);
  });

  it('LH7 at preparing, a held sharer stays in the record until the close', async () => {
    seedBot({ postgres: true });
    addBot('s2', { migrate: base({ jobId: 'mgr-s', jobIds: ['mgr-s'] }) });
    await resume(toFile({ phase: 'preparing', jobIds: [], posted: false, started: 0, loginOpened: false, sharers: ['s2'] }));
    const open = m.migrateWrites.filter(w => w.rec);
    expect(open.length).toBeGreaterThan(0);
    for (const w of open) expect(w.rec.sharers).toEqual(['s2']);
    expect(m.bots.b1.migrateLast.text).toMatch(/^The migration did not start: S2 uses the same database and has its own data migration to Postgres open, so it was not stopped/);
  });

  it('LH8 a Database URL of blank spaces looks up no running sharers', async () => {
    seedBot({ postgres: true, url: '   ' });
    addBot('s3');
    m.liveSharers = ['s3'];
    await press('file');
    expect(m.events).not.toContain('stop-sharer:s3');
  });

  it('LH9 no Database URL looks up no running sharers', async () => {
    seedBot({ postgres: true });
    delete m.env.b1.DATA_BACKEND_URL;
    addBot('s3');
    m.liveSharers = ['s3'];
    await press('file');
    expect(m.events).not.toContain('stop-sharer:s3');
  });

  it('LH10 with no sharer, no sharers line is sent', async () => {
    seedBot({ postgres: true });
    await press('file');
    expect(heard.filter(h => h.text.startsWith('Stopping the other bots'))).toEqual([]);
    expect(m.bots.b1.migrateLast.outcome).toBe('done');
  });

  it('LH11 sharers the record already lists are not saved again before the sharers line', async () => {
    seedBot({ postgres: true });
    seedSharer('s2');
    await resume(toFile({ phase: 'preparing', jobIds: [], posted: false, started: 0, loginOpened: false, sharers: ['s2'] }));
    const w = m.migrateWrites.map(x => JSON.stringify(x.rec));
    const i = m.migrateWrites.findIndex(x => x.rec?.text === P_SHARERS('S2'));
    expect(i).toBeGreaterThan(1);
    expect(w[i - 1]).not.toBe(w[i - 2]);
  });

  it('LH12 a sharer whose stop fails with no error: the close says no reason was given', async () => {
    seedBot({ postgres: true });
    seedSharer('s2');
    m.sharerStop = { success: false };
    await press('file');
    expect(m.bots.b1.migrateLast.text).toBe('The migration did not start: S2 uses the same database and could not be stopped (no reason given). Nothing was copied, and the bot stays in Maintenance.');
  });

  it('LH13 a bot that answers on the second GET after the restart is ready: the lane goes on', async () => {
    seedBot();
    m.bot.getQueue = [null, noAnswer()];
    await press('postgres');
    expect(m.bots.b1.migrateLast.outcome).toBe('done');
  });

  it('LH14 with a readiness window of 0 ms, one unanswered GET ends the wait', async () => {
    seedBot();
    MIGRATE_TIMING.readyMs = 0;
    m.bot.getQueue = [null, noAnswer('migrate unreachable: connect ECONNREFUSED')];
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-01T00:00:00.000Z'));
    await press('postgres');
    expect(m.bots.b1.migrateLast.outcome).toBe('failed');
    expect(m.bots.b1.migrateLast.text).toContain('migrate unreachable: connect ECONNREFUSED');
    expect(m.bot.posts).toEqual([]);
  }, 5000);

  it('LH15 a shutdown that starts during the POST ends the lane before it follows the job', async () => {
    seedBot();
    setMigrateListener((_id, ev) => { heard.push(ev); if (m.events.some(e => e.startsWith('POST'))) m.shuttingDown = true; });
    await press('postgres');
    const at = m.events.findIndex(e => e.startsWith('POST'));
    expect(at).toBeGreaterThan(0);
    expect(m.events.slice(at + 1).filter(e => e === 'GET')).toEqual([]);
    expect(m.bots.b1.migrate.phase).toBe('posting');
  });

  it('LH16 a save that fails at posting stops the lane with the error logged and sent as final', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    seedBot();
    m.failMigrateWrite = (_n, rec) => (rec?.phase === 'posting' ? 'disk full' : null);
    await press('postgres');
    expect(errors(err)).toContain("[Migrate] B1: the migration's progress could not be recorded: disk full");
    expect(heard[heard.length - 1]).toEqual({ text: NOT_REC_LANE('disk full'), final: true });
  });
  it('LH24 a press on a record a stop left at following keeps its phase', async () => {
    seedBot({ postgres: true });
    m.bots.b1.migrate = base({ phase: 'following', text: NOT_REC_LANE('disk full') });
    m.bot.journal.push({ jobId: 'mgr-a', to: 'postgres', state: 'running', stage: 'copying' });
    await press('postgres');
    expect(m.migrateWrites[0].rec.phase).toBe('following');
  });
});

describe('the restart after a Stop, by phase (L5 h)', () => {
  const pg = 'b1-fleet-postgres';
  it('LH17 at finishing, the stopped database starts before the bot, with no GET first', async () => {
    seedBot({ postgres: true });
    m.app.b1 = false;
    m.sidecar[pg] = false;
    await resume(base({ phase: 'finishing' }));
    const ev = m.events;
    expect(ev.indexOf('db-start:b1')).toBeGreaterThanOrEqual(0);
    expect(ev.indexOf('start:migrate')).toBeGreaterThan(ev.indexOf('db-start:b1'));
    expect(ev.slice(0, ev.indexOf('db-start:b1')).filter(e => e === 'GET')).toEqual([]);
  });

  it('LH18 at finishing a move to JSON files, the bot starts before anything starts its old database', async () => {
    seedBot({ postgres: true });
    m.env.b1.DATA_BACKEND = 'file';
    m.app.b1 = false;
    m.sidecar[pg] = false;
    await resume(toFile({ phase: 'finishing' }));
    const ev = m.events;
    expect(ev.indexOf('start:migrate')).toBeGreaterThanOrEqual(0);
    expect(ev.slice(0, ev.indexOf('start:migrate')).filter(e => e.startsWith('db-start'))).toEqual([]);
  });

  it('LH19 at following, a start that fails with no error parks naming the record job and no reason given', async () => {
    seedBot({ postgres: true });
    m.app.b1 = false;
    m.start = { success: false };
    await resume(base({ phase: 'following', jobIds: ['mgr-a', 'mgr-b'] }));
    expect(m.bots.b1.migrate.phase).toBe('waiting');
    expect(m.bots.b1.migrate.text).toBe('Migration mgr-a is not finished, and the bot could not be started (no reason given). The bot stays in Maintenance with the migration open; press Migrate to try again.');
  });

  it('LH20 at following, after the bot starts, a database that does not accept connections parks', async () => {
    seedBot({ postgres: true });
    m.app.b1 = false;
    m.dbReady = false;
    await resume(base({ phase: 'following' }));
    expect(m.bots.b1.migrate.phase).toBe('waiting');
    expect(m.bots.b1.migrate.text).toBe("Migration mgr-a is not finished, and the bot's database did not accept connections within 30 seconds of the start (b1-fleet-postgres: it did not accept connections within 30 seconds of the restart). The bot stays in Maintenance with the migration open; press Migrate to try again.");
  });

  it('LH22 at following with the database down, a failed job with no stage or error closes with the default words', async () => {
    seedBot({ postgres: true });
    m.sidecar[pg] = false;
    m.bot.getQueue = [getJob({ jobId: 'mgr-a', to: 'postgres', state: 'failed', stage: '' })];
    await resume(base({ phase: 'following' }));
    expect(m.bots.b1.migrateLast.text).toMatch(/^Migration mgr-a failed at an unnamed stage: the bot gave no error\. Nothing was switched/);
  });

  it('LH23 at following, a database start that fails with no error parks with no reason given', async () => {
    seedBot({ postgres: true });
    m.sidecar[pg] = false;
    m.dbStart = { success: false };
    m.bot.journal.push({ jobId: 'mgr-a', to: 'postgres', state: 'running', stage: 'copying' });
    await resume(base({ phase: 'following' }));
    expect(m.bots.b1.migrate.text).toBe("Migration mgr-a is not finished, and the bot's database could not be started (no reason given). The bot stays in Maintenance with the migration open; press Migrate to try again.");
  });
  it('LH25 at finishing after the apply, a container that reads the wrong backend parks saying the start reported no error', async () => {
    seedBot({ postgres: true });
    m.containerEnv = { ok: true, env: { DATA_BACKEND: 'file', DATA_BACKEND_URL: '' } };
    await resume(base({ phase: 'finishing', finishing: 'applied' }));
    expect(m.bots.b1.migrate.phase).toBe('waiting');
    expect(m.bots.b1.migrate.text).toContain('(the start reported no error)');
  });
  it('LH26 at finishing after the apply, a stopped bot is started again before its container is read', async () => {
    seedBot({ postgres: true });
    m.app.b1 = false;
    await resume(base({ phase: 'finishing', finishing: 'applied' }));
    expect(m.events.indexOf('start:migrate')).toBeGreaterThanOrEqual(0);
    expect(m.events.indexOf('start:migrate')).toBeLessThan(m.events.indexOf('env-read'));
  });
  it('LH27 at following, a bot that docker shows stopped again after its start is started once', async () => {
    seedBot({ postgres: true });
    Object.defineProperty(m.app, 'b1', { get: () => false, set: () => {}, enumerable: true, configurable: true });
    await resume(base({ phase: 'following' }));
    expect(m.events.slice(0, m.events.findIndex(e => e.startsWith('POST'))).filter(e => e === 'start:migrate')).toEqual(['start:migrate']);
  });
});
