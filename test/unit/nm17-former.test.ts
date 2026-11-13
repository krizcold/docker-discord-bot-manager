import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/docker/containerManager', async () => (await import('./migrate-fake')).cmMock());
vi.mock('../../src/env/manager', async (o) => (await import('./migrate-fake')).envMock(await o()));
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./migrate-fake')).dbLoginMock(await o()));
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./migrate-fake')).hookMock(await o()));
vi.mock('../../src/instance/maintenance', async (o) => (await import('./migrate-fake')).maintenanceMock(await o()));
vi.mock('../../src/instance/fleetBackup', async (o) => (await import('./migrate-fake')).fleetBackupMock(await o()));
vi.mock('../../src/instance/fleetReplica', async (o) => (await import('./migrate-fake')).fleetReplicaMock(await o()));
vi.mock('../../src/instance/fleetSwitch', async () => (await import('./migrate-fake')).fleetSwitchMock());

import { laneDone, runMigration, MIGRATE_TIMING } from '../../src/instance/migrate';
import { fastTiming, m, resetMigrate, seedBot, FLEET_DB } from './migrate-fake';

const FORMER = { code: 'join-code', slot: 'slot1', machine: 'old-box', host: 'old.example.test', port: 5433, generation: 3, at: '2026-11-01T00:00:00.000Z' };
const rec = () => m.bots.b1.migrate;
const last = () => m.bots.b1.migrateLast;
const at = (e: string) => m.events.findIndex(x => x.startsWith(e));
const switches = () => m.events.filter(e => e.startsWith('switch:'));

let logs: string[] = [];
beforeEach(() => {
  resetMigrate();
  fastTiming(MIGRATE_TIMING);
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
});
afterEach(() => { vi.restoreAllMocks(); });

async function press(to: 'postgres' | 'file') {
  expect(await runMigration('b1', to, 'press')).toEqual({ accepted: true });
  await laneDone('b1');
}

function seedFormer(postgres = true): void {
  if (postgres) {
    seedBot({ postgres: true });
    m.bots.b1.fleetDb.formerMain = { ...FORMER };
  } else {
    seedBot({ inst: { fleetDb: { ...FLEET_DB, formerMain: { ...FORMER } } } });
  }
}

describe('NM17: a move to JSON files clears formerMain', () => {
  it('case 1: the clear runs after the store and before finishing stored, and is logged', async () => {
    seedFormer();
    await press('file');
    expect(last().outcome).toBe('done');
    const clear = at('switch:{"formerMain":null}');
    expect(clear).toBeGreaterThan(at('env-inop:{"DATA_BACKEND":"file"}'));
    expect(clear).toBeLessThan(at('record:finishing:stored'));
    expect(switches()).toEqual(['switch:{"formerMain":null}']);
    expect(m.bots.b1.fleetDb.formerMain).toBeUndefined();
    expect(logs).toContain('[Migrate] B1: this bot keeps its data in JSON files now, so the manager no longer checks the old main old-box');
  });
  it('case 2: the clear throws: park with the exact text, formerMain kept; a second press closes done with it gone', async () => {
    seedFormer();
    m.failSwitch = 'disk full';
    await press('file');
    const jobId = m.bot.posts[0].jobId;
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'finishing' });
    expect(rec().text).toBe(`Migration ${jobId} moved the data to JSON files and stored the new Data Backend, but the old main's join code kept on this bot could not be deleted (disk full). The bot stays in Maintenance; press Migrate to finish.`);
    expect(m.bots.b1.fleetDb.formerMain).toEqual(FORMER);
    m.failSwitch = null;
    await press('file');
    expect(last().outcome).toBe('done');
    expect(m.bots.b1.fleetDb.formerMain).toBeUndefined();
  });
  it('case 3: to JSON files with no formerMain, no switch write', async () => {
    seedBot({ postgres: true });
    await press('file');
    expect(last().outcome).toBe('done');
    expect(switches()).toEqual([]);
  });
  it('case 4: to Postgres with formerMain, it is kept', async () => {
    seedFormer(false);
    await press('postgres');
    expect(last().outcome).toBe('done');
    expect(switches()).toEqual([]);
    expect(m.bots.b1.fleetDb.formerMain).toEqual(FORMER);
  });
  it('a failed store parks with MG-ENVSTORE and keeps formerMain', async () => {
    seedFormer();
    m.failUpdateBot = 'store locked';
    await press('file');
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'finishing' });
    expect(rec().text).toMatch(/but the new Data Backend could not be stored \(store locked\)/);
    expect(switches()).toEqual([]);
    expect(m.bots.b1.fleetDb.formerMain).toEqual(FORMER);
  });
});
