import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/docker/containerManager', async () => (await import('./migrate-fake')).cmMock());
vi.mock('../../src/env/manager', async (o) => (await import('./migrate-fake')).envMock(await o()));
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./migrate-fake')).dbLoginMock(await o()));
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./migrate-fake')).hookMock(await o()));
vi.mock('../../src/instance/maintenance', async (o) => (await import('./migrate-fake')).maintenanceMock(await o()));
vi.mock('../../src/instance/fleetBackup', async (o) => (await import('./migrate-fake')).fleetBackupMock(await o()));
vi.mock('../../src/instance/fleetReplica', async (o) => (await import('./migrate-fake')).fleetReplicaMock(await o()));
vi.mock('../../src/instance/fleetSwitch', async () => (await import('./migrate-fake')).fleetSwitchMock());

import { identityOf, laneDone, runMigration, setMigrateListener, MIGRATE_TEXT as T, MIGRATE_TIMING } from '../../src/instance/migrate';
import { fastTiming, m, refusal, resetMigrate, seedBot, COMPANION_URL } from './migrate-fake';

beforeEach(() => { resetMigrate(); fastTiming(MIGRATE_TIMING); });
afterEach(() => { setMigrateListener(null); vi.restoreAllMocks(); });

async function press(to: 'postgres' | 'file') {
  expect(await runMigration('b1', to, 'press')).toEqual({ accepted: true });
  await laneDone('b1');
}

describe('identityOf: the unbracketed IPv6 form (L5 k)', () => {
  it('a host after a bracket is unreadable', () => expect(identityOf(']::1:5432/db')).toBeNull());
  it('a database name broken by a line break is unreadable', () => expect(identityOf('::1:5432/db\nx')).toBeNull());
  it('a last group of two digits is read', () => expect(identityOf('fe80::12:5432/app')).toBe('fe80::12:5432/app'));
});

describe('the lane (L5 k)', () => {
  it('a move with no other bot on the database shows no line about stopping other bots', async () => {
    seedBot({ postgres: true });
    const texts: string[] = [];
    setMigrateListener((_id, ev) => texts.push(ev.text));
    await press('file');
    expect(m.bots.b1.migrateLast).toMatchObject({ outcome: 'done' });
    expect(texts.some(t => t.startsWith('Stopping the other bots'))).toBe(false);
  });

  it('a login open refused because the database is in recovery closes with the recovery words', async () => {
    seedBot({ postgres: true });
    m.openResult = { ok: false, cls: 'recovery', error: 'cannot execute ALTER ROLE in a read-only transaction' } as any;
    await press('file');
    expect(m.bots.b1.migrateLast.text).toContain(T.login('the database is a live copy in recovery'));
  });

  it('a transient refusal at the exact end of the window is not posted again', async () => {
    seedBot();
    let clock = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const still = () => refusal('The bot process is still starting');
    m.bot.postQueue.push(() => { clock += MIGRATE_TIMING.readyMs; return still(); }, () => { clock += 1; return still(); }, () => { clock += 1; return still(); });
    await press('postgres');
    expect(m.bot.posts.length).toBe(1);
  });

  it('a Data Backend read back as postgres after a move to JSON files parks the finish', async () => {
    seedBot({ postgres: true });
    m.containerEnv = { ok: true, env: { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: COMPANION_URL } };
    await press('file');
    expect(m.bots.b1.migrate).toMatchObject({ phase: 'waiting', resumeAt: 'finishing' });
    expect(m.bots.b1.migrate.text).toContain('postgres');
  });
});
