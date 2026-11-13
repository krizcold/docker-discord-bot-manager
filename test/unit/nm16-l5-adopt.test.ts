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
import { fastTiming, getJob, m, resetMigrate, seedBot } from './migrate-fake';

beforeEach(() => { resetMigrate(); fastTiming(MIGRATE_TIMING); });

describe('NM16 L5: the adoption search with no Database URL', () => {
  it('A1 a URL emptied before the adoption parks nothing as unchecked', async () => {
    seedBot({ postgres: true });
    m.bot.journal = [{ jobId: 'cli-1', to: 'file', state: 'running', stage: 'copying' }];
    m.bot.script = [{ stage: 'copying' }, { state: 'done', stage: 'switching' }];
    m.bot.getQueue.push(() => { m.env.b1.DATA_BACKEND_URL = ''; return getJob({ jobId: 'cli-1', to: 'file', state: 'running', stage: 'copying' }); });
    expect(await runMigration('b1', 'file', 'press')).toEqual({ accepted: true });
    await laneDone('b1');
    expect(m.bots.b1.migrate).toBeUndefined();
    expect(m.bots.b1.migrateLast).toMatchObject({ jobId: 'cli-1', outcome: 'done' });
  });
});
