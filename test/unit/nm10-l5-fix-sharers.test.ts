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
import { botGet, fastTiming, m, resetMigrate, seedBot, seedSharer } from './migrate-fake';

beforeEach(() => { resetMigrate(); fastTiming(MIGRATE_TIMING); });

const head = (jobId: string) => `The data moved to JSON files (migration ${jobId}), and the bot's Data Backend is now JSON files. The database keeps the old data, renamed aside.`;

const TAIL = ' The bot is running normally.';

async function close(ids: string[], app: boolean | null): Promise<string> {
  seedBot({ postgres: true });
  for (const id of ids) seedSharer(id);
  m.bot.getQueue.push(null, () => { for (const id of ids) m.app[id] = app; return botGet(); });
  expect(await runMigration('b1', 'file', 'press')).toEqual({ accepted: true });
  await laneDone('b1');
  const last = m.bots.b1.migrateLast;
  expect(last.outcome).toBe('done');
  expect(last.text.startsWith(head(last.jobId))).toBe(true);
  expect(last.text.endsWith(TAIL)).toBe(true);
  return last.text.slice(head(last.jobId).length, -TAIL.length);
}

describe('the sharers texts at the close', () => {
  it('one bot stays stopped', async () => {
    expect(await close(['s1'], false)).toBe(' S1 uses the old database and stays stopped: its data is renamed aside, so that bot cannot load it.');
  });
  it('two bots stay stopped', async () => {
    expect(await close(['s1', 's2'], false)).toBe(' S1, S2 use the old database and stay stopped: its data is renamed aside, so they cannot load it.');
  });
  it('one bot runs', async () => {
    expect(await close(['s1'], true)).toBe(" S1 uses the old database and runs: its data is renamed aside, so that bot cannot load it, and that bot's writes to it fail.");
  });
  it('two bots run', async () => {
    expect(await close(['s1', 's2'], true)).toBe(' S1, S2 use the old database and run: its data is renamed aside, so they cannot load it, and their writes to it fail.');
  });
  it('docker is silent for one bot', async () => {
    expect(await close(['s1'], null)).toBe(' S1 uses the old database, and docker did not say whether it runs: its data is renamed aside, so that bot cannot load it.');
  });
  it('docker is silent for two bots', async () => {
    expect(await close(['s1', 's2'], null)).toBe(' S1, S2 use the old database, and docker did not say whether they run: its data is renamed aside, so they cannot load it.');
  });
});
