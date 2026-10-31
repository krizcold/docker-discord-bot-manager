import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-keep-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

vi.mock('child_process', async (o) => (await import('./switch-harness')).childProcessMock(await o()));
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./switch-harness')).dbLoginMock(await o()));
vi.mock('../../src/instance/maintenance', async (o) => (await import('./switch-harness')).maintenanceMock(await o()));
vi.mock('../../src/docker/containerManager', async (o) => (await import('./switch-harness')).containerManagerMock(await o()));
vi.mock('../../src/instance/fleetBackup', async (o) => (await import('./switch-harness')).fleetBackupMock(await o()));
vi.mock('../../src/instance/fleetJoin', async (o) => (await import('./switch-harness')).fleetJoinMock(await o()));
vi.mock('../../src/instance/fleetReplica', async (o) => (await import('./switch-harness')).fleetReplicaMock(await o()));
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./switch-harness')).appHookMock(await o()));
vi.mock('../../src/instance/backupCheck', async (o) => (await import('./switch-harness')).backupCheckMock(await o()));
vi.mock('../../src/env/manager', async (o) => (await import('./switch-harness')).envMock(await o()));
vi.mock('../../src/config/appCapabilities', async (o) => (await import('./switch-harness')).capsMock(await o()));

import * as fs from 'fs';

import { keepThisMain } from '../../src/instance/fleetSwitch';
import { COPY_PEM, fake, h, mainFixture, resetHarness, seedDbs, stored, writeRegistry } from './switch-harness';

const CONFLICT = { machine: 'b.example', host: 'b.example', port: 5440, generation: 3, at: 'x', cert: COPY_PEM };
const withConflict = (c: Record<string, unknown> | null, extra: Record<string, unknown> = {}) =>
  writeRegistry({ a: mainFixture({ fleetDb: { ...mainFixture().fleetDb as object, ...(c ? { mainConflict: c } : {}) }, ...extra }) });
const writable = (g: number) => () => ({ kind: 'writable', systemId: '7001', timeline: 2, gen: { generation: g, machine: 'b.example', since: '2026-10-28T14:00:00Z' } }) as any;

beforeEach(() => {
  resetHarness();
  seedDbs();
  withConflict(CONFLICT);
});
afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

const RUNNING = { state: 'running', message: '', orderedAt: '2026-10-28T00:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: 'running' };
const KM_OK = (lead: string) => `This machine is the main now (${lead}. The manager can't confirm when b.example's manager reads this generation: it checks every 5 minutes while it can reach this machine, then blocks its bot's login there and puts the bot in Off once it holds nothing it could not save. Rejoin b.example as a copy in its manager afterwards; that keeps a dump of its database first.`;

describe('O11 Keep this machine as the main', () => {
  it('K1: the peer still ties, the state a settled Running: own generation max + 1, the login opened, conflict cleared', async () => {
    h.peer = writable(3);
    withConflict(CONFLICT, { maintenance: RUNNING });
    expect(await keepThisMain('a')).toEqual({ success: true, text: KM_OK("generation 4), and the bot's login is open here again") });
    expect(fake.dbs['a-pg'].generation?.generation).toBe(4);
    expect(stored('a').fleetDb.mainConflict).toBeUndefined();
    expect(h.events.indexOf('raise')).toBeLessThan(h.events.indexOf('open'));
  });
  it('K1: the peer unreachable still raises above the recorded tie', async () => {
    expect((await keepThisMain('a')).success).toBe(true);
    expect(fake.dbs['a-pg'].generation?.generation).toBe(4);
  });
  it('K2: the peer is higher now: replaced, login blocked', async () => {
    h.peer = writable(5);
    expect((await keepThisMain('a')).text).toBe('b.example has a higher generation now, so it is the main; this database\'s login is blocked. Rejoin this machine as a copy.');
    expect(stored('a').fleetDb.replacedBy).toMatchObject({ machine: 'b.example', generation: 5, own: 3 });
    expect(h.events).toContain('block');
    expect(fake.dbs['a-pg'].generation?.generation).toBe(3);
  });
  it('K3: no conflict recorded', async () => {
    withConflict(null);
    expect((await keepThisMain('a')).text).toBe('No second main is recorded');
  });
  it('K4: the raise fails', async () => {
    fake.dbs['a-pg'].fail.raise = 'ERROR:  disk full';
    expect((await keepThisMain('a')).text).toBe('The generation could not be raised (ERROR:  disk full); nothing was changed');
    expect(stored('a').fleetDb.mainConflict).toBeDefined();
  });
  it('K5: a restore notice stands', async () => {
    withConflict(CONFLICT, { fleetRestoreError: { file: 'r.dump', text: 'x', at: 'y', doubt: true } });
    expect((await keepThisMain('a')).text).toBe('A restore of r.dump has not finished cleanly here (its notice is on the Database window), so this machine was not kept as the main and nothing was changed. Restore a dump again or dismiss the notice first, or rejoin this machine as a copy of b.example.');
    expect(fake.dbs['a-pg'].generation?.generation).toBe(3);
  });
  it('K6: the read-only layer on, or unread', async () => {
    h.fence = { ok: true, on: true, owner: null, persisted: true };
    expect((await keepThisMain('a')).text).toBe("The bot's database is READ-ONLY, and this manager cannot tell which step left it so. This machine was not kept as the main and nothing was changed");
    h.fence = { ok: false, cls: 'other', error: 'timeout' };
    expect((await keepThisMain('a')).text).toBe("The manager could not read whether the bot's database is READ-ONLY (timeout), so this machine was not kept as the main and nothing was changed");
  });
});

describe('K7 to K10: the login after Keep (D44, D45)', () => {
  it('K7: the state is Maintenance: raised, conflict cleared, the login stays blocked (KM-STATE)', async () => {
    h.peer = writable(3);
    expect(await keepThisMain('a')).toEqual({ success: true, text: KM_OK("generation 4); the bot's state here is Maintenance, so its login stays blocked until you choose Running") });
    expect(h.events).not.toContain('open');
    expect(stored('a').fleetDb.mainConflict).toBeUndefined();
  });
  it('K8: the peer is higher and the block fails: KM-LOST-FAIL with the error', async () => {
    h.peer = writable(5);
    h.block = { ok: false, cls: 'other', error: 'permission denied to alter role' };
    expect((await keepThisMain('a')).text).toBe("b.example has a higher generation now, so it is the main; this database's login could not be blocked (permission denied to alter role), and the manager tries again every 5 minutes. Rejoin this machine as a copy.");
    expect(stored('a').fleetDb.replacedBy).toMatchObject({ blockError: 'permission denied to alter role' });
  });
  it('K9: a main without replication: KM-OK-ALONE', async () => {
    writeRegistry({ a: mainFixture({ fleetDb: { containerName: 'a-pg', user: 'app', db: 'app', volume: 'a-pgdata', mainConflict: CONFLICT }, maintenance: RUNNING }) });
    expect(await keepThisMain('a')).toEqual({ success: true, text: "This machine is the main now (generation 4), and the bot's login is open here again. This machine has no address for other machines, so b.example's manager cannot learn of this choice: choose Off for the bot in that machine's manager." });
    expect(stored('a').fleetDb.mainConflict).toBeUndefined();
  });
  it('K10: the open fails: raised, the conflict kept; Keep again skips the raise, opens, clears', async () => {
    h.peer = writable(3);
    withConflict(CONFLICT, { maintenance: RUNNING });
    h.open = { ok: false, cls: 'other', error: 'connection reset by peer' };
    expect((await keepThisMain('a')).text).toBe("This machine is the main now (generation 4), but the bot's login here could not be opened (connection reset by peer), so two mains are still recorded here; press Keep this machine as the main again to open it.");
    expect(fake.dbs['a-pg'].generation?.generation).toBe(4);
    expect(stored('a').fleetDb.mainConflict).toBeDefined();
    h.open = { ok: true };
    expect((await keepThisMain('a')).text).toBe(KM_OK('generation 4), and the bot\'s login is open here again'));
    expect(h.events.filter(e => e === 'raise')).toEqual(['raise']);
    expect(fake.dbs['a-pg'].generation?.generation).toBe(4);
    expect(stored('a').fleetDb.mainConflict).toBeUndefined();
  });
});
