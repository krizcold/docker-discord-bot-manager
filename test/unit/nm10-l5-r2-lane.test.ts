import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/docker/containerManager', async () => (await import('./migrate-fake')).cmMock());
// The real store decrypts every stored value on each read and logs each one that no longer decrypts (env/manager.ts).
vi.mock('../../src/env/manager', async (o) => {
  const f: any = (await import('./migrate-fake')).envMock(await o());
  const { m } = await import('./migrate-fake');
  const logUndecryptable = () => {
    for (const _k of m.envStatus.undecryptable) console.error('[EnvManager] Value is stored in the retired pre-v2 format and cannot be decrypted; re-enter it in the env editor');
  };
  return {
    ...f,
    getEnvVarsWithStatus: (id: string) => { logUndecryptable(); return f.getEnvVarsWithStatus(id); },
    getEnvVars: (id: string) => { logUndecryptable(); return f.getEnvVars(id); },
  };
});
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./migrate-fake')).dbLoginMock(await o()));
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./migrate-fake')).hookMock(await o()));
vi.mock('../../src/instance/maintenance', async (o) => (await import('./migrate-fake')).maintenanceMock(await o()));
vi.mock('../../src/instance/fleetBackup', async (o) => (await import('./migrate-fake')).fleetBackupMock(await o()));
vi.mock('../../src/instance/fleetReplica', async (o) => (await import('./migrate-fake')).fleetReplicaMock(await o()));
vi.mock('../../src/instance/fleetSwitch', async () => (await import('./migrate-fake')).fleetSwitchMock());

import { laneDone, runMigration, setMigrateListener, MIGRATE_TIMING } from '../../src/instance/migrate';
import { fastTiming, getJob, m, resetMigrate, seedBot, EXTERNAL_URL } from './migrate-fake';

const PENDING = Symbol('pending');
const settle = <T>(p: Promise<T>) => Promise.race([p, new Promise<typeof PENDING>(r => setTimeout(() => r(PENDING), 200))]);

let errors: string[] = [];
beforeEach(() => {
  resetMigrate();
  fastTiming(MIGRATE_TIMING);
  errors = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
});
afterEach(() => { setMigrateListener(null); vi.restoreAllMocks(); });

const envErrors = () => errors.filter(l => l.startsWith('[EnvManager]')).length;

describe('a shutdown begun during the admission GET', () => {
  it('the press is answered with the 503 shutdown refusal', async () => {
    seedBot({ url: EXTERNAL_URL });
    m.bot.getQueue.push(() => { m.shuttingDown = true; return getJob(null); });
    const a = await settle(runMigration('b1', 'postgres', 'press'));
    await laneDone('b1');
    expect(a).toEqual({ accepted: false, status: 503, error: 'The manager is shutting down' });
    expect(m.bot.posts).toHaveLength(0);
  });
});

describe('the repost of a move to Postgres', () => {
  it('a blank stored Database URL sends no url key', async () => {
    seedBot({ url: '' });
    m.bots.b1.migrate = {
      to: 'postgres', from: 'file', destination: 'db.example.test:5432/app', companion: false, jobId: 'mgr-a', jobIds: ['mgr-a'],
      posted: true, started: 1, kept: 0, phase: 'waiting', resumeAt: 'following', awaiting: 'destination', loginOpened: false,
      sharers: [], sharersStopped: [], openedAt: 'x', text: 't',
    };
    m.bot.getQueue.push(getJob(null));
    expect(await settle(runMigration('b1', 'postgres', 'press'))).toEqual({ accepted: true });
    await laneDone('b1');
    expect(m.bot.posts.length).toBeGreaterThan(0);
    expect(m.bot.posts[0]).toEqual({ jobId: 'mgr-a', to: 'postgres' });
  });
});

describe('the error lines an env store with a value that no longer decrypts logs', () => {
  it('a press to Postgres at an external URL logs as many lines as the code reads the env store, and no more', async () => {
    seedBot({ url: EXTERNAL_URL });
    m.env.b1.OLD_SECRET = '';
    m.envStatus.undecryptable = ['OLD_SECRET'];
    m.bot.script = [{ state: 'failed', stage: 'copying', error: 'stop here' }];
    expect(await settle(runMigration('b1', 'postgres', 'press'))).toEqual({ accepted: true });
    await laneDone('b1');
    expect(envErrors()).toBe(5);
  });
  it('a move to JSON files at posting reads no env store for its POST', async () => {
    seedBot({ postgres: true });
    m.env.b1.OLD_SECRET = '';
    m.envStatus.undecryptable = ['OLD_SECRET'];
    m.bots.b1.migrate = {
      to: 'file', from: 'postgres', destination: null, companion: false, jobId: 'mgr-a', jobIds: ['mgr-a'],
      posted: false, started: 0, kept: 0, phase: 'waiting', resumeAt: 'posting', loginOpened: true,
      sharers: [], sharersStopped: [], openedAt: 'x', text: 't', hbaFence: 'migrate:1', hbaFenceSet: true, isolated: true,
    };
    m.bot.script = [{ state: 'failed', stage: 'copying', error: 'stop here' }];
    expect(await settle(runMigration('b1', 'file', 'press'))).toEqual({ accepted: true });
    await laneDone('b1');
    expect(m.bot.posts.length).toBeGreaterThan(0);
    expect(envErrors()).toBe(4);
  });
});
