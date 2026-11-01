import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/docker/containerManager', async () => (await import('./migrate-fake')).cmMock());
vi.mock('../../src/env/manager', async (o) => (await import('./migrate-fake')).envMock(await o()));
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./migrate-fake')).dbLoginMock(await o()));
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./migrate-fake')).hookMock(await o()));
vi.mock('../../src/instance/maintenance', async (o) => (await import('./migrate-fake')).maintenanceMock(await o()));
vi.mock('../../src/instance/fleetBackup', async (o) => (await import('./migrate-fake')).fleetBackupMock(await o()));
vi.mock('../../src/instance/fleetReplica', async (o) => (await import('./migrate-fake')).fleetReplicaMock(await o()));
vi.mock('../../src/instance/fleetSwitch', async () => (await import('./migrate-fake')).fleetSwitchMock());

import { identityOf, laneDone, runMigration, sameDatabase, MIGRATE_TIMING } from '../../src/instance/migrate';
import { fastTiming, m, resetMigrate, seedBot } from './migrate-fake';

beforeEach(() => { resetMigrate(); fastTiming(MIGRATE_TIMING); });

const V6_URL = 'postgresql://u:p@[FD00::1]:5432/app';
const V6_ID = 'fd00::1:5432/app';

async function press() {
  expect(await runMigration('b1', 'postgres', 'press')).toEqual({ accepted: true });
  await laneDone('b1');
}

describe('identityOf on an IPv6 host', () => {
  it('reads the URL, the bracketed form, the object form and its own output to one identity', () => {
    expect(identityOf(V6_URL)).toBe(V6_ID);
    expect(identityOf('[fd00::1]:5432/app')).toBe(V6_ID);
    expect(identityOf({ host: 'fd00::1', port: 5432, database: 'app' })).toBe(V6_ID);
    expect(identityOf(V6_ID)).toBe(V6_ID);
    expect(identityOf(identityOf(V6_URL))).toBe(V6_ID);
  });
  it('sameDatabase holds between the identity and the URL', () => {
    expect(sameDatabase(V6_ID, V6_URL)).toBe(true);
    expect(sameDatabase(V6_URL, V6_ID)).toBe(true);
    expect(sameDatabase('fd00::2:5432/app', V6_URL)).toBe(false);
  });
  it('IPv4 and named hosts read as before', () => {
    expect(identityOf('postgresql://u:p@10.0.0.5:6543/app')).toBe('10.0.0.5:6543/app');
    expect(identityOf('10.0.0.5:6543/app')).toBe('10.0.0.5:6543/app');
    expect(identityOf('10.0.0.5/app')).toBe('10.0.0.5:5432/app');
    expect(identityOf('DB.Example.test:5432/app/')).toBe('db.example.test:5432/app');
    expect(identityOf('db.example.test/app')).toBe('db.example.test:5432/app');
    expect(identityOf('db.example.test:x/app')).toBeNull();
    expect(sameDatabase('db.example.test:5432/app', 'postgresql://u:p@db.example.test/app')).toBe(true);
  });
});

describe('a move to Postgres at an IPv6 URL', () => {
  it('done() reaches finishing with no MG-DEST park, and the finishing check confirms', async () => {
    seedBot({ url: V6_URL });
    m.bot.destination = { host: 'fd00::1', port: 5432, database: 'app' };
    m.containerEnv = { ok: true, env: { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: V6_URL } };
    await press();
    expect(m.events).toContain('record:finishing');
    expect(m.events).toContain('record:finishing:confirmed');
    expect(m.bots.b1.migrateLast.outcome).toBe('done');
    expect(m.bots.b1.migrateLast.text).not.toMatch(/can't confirm which database/);
    expect(m.env.b1.DATA_BACKEND).toBe('postgres');
  });
  it('the finishing check reads the IPv6 URL in the bot env as the recorded destination and confirms', async () => {
    seedBot({ url: V6_URL });
    m.bots.b1.migrate = { to: 'postgres', from: 'file', destination: V6_ID, companion: false, jobId: 'mgr-a', jobIds: ['mgr-a'], posted: true, started: 1, kept: 0, phase: 'waiting', resumeAt: 'finishing', finishing: 'stored', loginOpened: false, sharers: [], sharersStopped: [], openedAt: 'x' };
    m.env.b1.DATA_BACKEND = 'postgres';
    m.containerEnv = { ok: true, env: { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: V6_URL } };
    await press();
    expect(m.events).toContain('record:finishing:confirmed');
    expect(m.bots.b1.migrate).toBeUndefined();
    expect(m.bots.b1.migrateLast.outcome).toBe('done');
  });
});

describe('identityOf reads a colon host only when it is IPv6', () => {
  it('a host with no port and a credentials prefix read null', () => {
    expect(identityOf('fd00::1/app')).toBeNull();
    expect(identityOf('user:pw@host:5432/db')).toBeNull();
  });
});
