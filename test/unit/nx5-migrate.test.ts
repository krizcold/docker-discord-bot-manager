// NX5 decision 4: Migrate's M3 finds or makes the bot's login open while the state is Maintenance, so it drops the
// record's save-order block mark (`fleet.blockedAt`) before the open.
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
import { fastTiming, m, resetMigrate, seedBot, SETTLED } from './migrate-fake';

beforeEach(() => { resetMigrate(); fastTiming(MIGRATE_TIMING); });

const FLEET = { orderId: 'X', askedBlocked: false, blockedAt: '2026-11-16T10:00:05.000Z' };

async function press(): Promise<void> {
  expect(await runMigration('b1', 'file', 'press')).toEqual({ accepted: true });
  await laneDone('b1');
}

describe("M3 drops blockedAt (decision 4)", () => {
  it('the login read blocked: the mark is dropped before M3 opens it, and the id stays', async () => {
    seedBot({ postgres: true, inst: { maintenance: { ...SETTLED, fleet: { ...FLEET } } } });
    await press();
    expect(m.events).toContain('login-open');
    expect(m.events.indexOf('maintenance-write')).toBeGreaterThanOrEqual(0);
    expect(m.events.indexOf('maintenance-write')).toBeLessThan(m.events.indexOf('login-open'));
    expect(m.bots.b1.maintenance.fleet).toEqual({ orderId: 'X', askedBlocked: false });
  });
  it('the login already read open: the mark is dropped too', async () => {
    seedBot({ postgres: true, inst: { maintenance: { ...SETTLED, fleet: { ...FLEET } } } });
    m.login.canLogin = true;
    await press();
    expect(m.events).not.toContain('login-open');
    expect(m.events).toContain('maintenance-write');
    expect(m.bots.b1.maintenance.fleet).toEqual({ orderId: 'X', askedBlocked: false });
  });
  it('guard: a record without the mark is not written', async () => {
    seedBot({ postgres: true });
    await press();
    expect(m.events).toContain('login-open');
    expect(m.events).not.toContain('maintenance-write');
  });
});
