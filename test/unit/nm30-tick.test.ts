import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm30-tick-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, cleared: [] as string[] };
});

vi.mock('child_process', async (o) => (await import('./switch-harness')).childProcessMock(await o()));
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./switch-harness')).dbLoginMock(await o()));
vi.mock('../../src/instance/maintenance', async (o) => (await import('./switch-harness')).maintenanceMock(await o()));
vi.mock('../../src/docker/containerManager', async (o) => (await import('./switch-harness')).containerManagerMock(await o()));
vi.mock('../../src/instance/fleetBackup', async (o) => {
  const m = (await import('./switch-harness')).fleetBackupMock(await o()) as any;
  return { ...m, restoreRecordCleared: (id: string) => { tmp.cleared.push(id); m.restoreRecordCleared(id); } };
});
vi.mock('../../src/instance/fleetJoin', async (o) => (await import('./switch-harness')).fleetJoinMock(await o()));
vi.mock('../../src/instance/fleetReplica', async (o) => (await import('./switch-harness')).fleetReplicaMock(await o()));
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./switch-harness')).appHookMock(await o()));
vi.mock('../../src/instance/backupCheck', async (o) => (await import('./switch-harness')).backupCheckMock(await o()));
vi.mock('../../src/env/manager', async (o) => (await import('./switch-harness')).envMock(await o()));
vi.mock('../../src/config/appCapabilities', async (o) => (await import('./switch-harness')).capsMock(await o()));

import * as fs from 'fs';
import { resetSwitchState, switchTick } from '../../src/instance/fleetSwitch';
import { MAIN, fake, freshDb, mainFixture, resetHarness, writeRegistry } from './switch-harness';

const RECORD = { pending: true, file: 'r.dump', at: '2026-11-16T09:00:00Z', generation: 3, machine: 'm', since: null };
let now = Date.parse('2026-11-16T10:00:00Z');

beforeEach(() => {
  resetHarness();
  resetSwitchState();
  tmp.cleared.length = 0;
  fake.dbs['a-pg'] = freshDb();
  writeRegistry({ a: mainFixture({ fleetDb: { ...MAIN } }) });
  now += 31 * 60_000;
});
afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

describe('NM30 review 3: the switch check tells the restore lane when the record is finished', () => {
  it('a record read as not pending is reported cleared', async () => {
    fake.dbs['a-pg'].restoreState = { ...RECORD, pending: false };
    await switchTick(now);
    expect(tmp.cleared).toEqual(['a']);
  });
  it('a pending record the tick clears is reported cleared', async () => {
    fake.dbs['a-pg'].restoreState = { ...RECORD };
    await switchTick(now);
    expect(tmp.cleared).toEqual(['a']);
  });
  it('a pending record whose clear fails is not reported cleared', async () => {
    fake.dbs['a-pg'].restoreState = { ...RECORD };
    fake.dbs['a-pg'].fail['restore-clear'] = 'ERROR:  disk full';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await switchTick(now);
    expect(tmp.cleared).toEqual([]);
  });
});
