import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm9-l5-takeover-'));
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
import { SWITCH_TIMING, takeOverMain } from '../../src/instance/fleetSwitch';
import { COPY_PEM, copyFixture, fake, freshDb, resetHarness, stored, writeRegistry } from './switch-harness';

beforeEach(() => {
  resetHarness();
  fake.dbs['c-pg'] = freshDb({ recovery: true, generation: { generation: 3, machine: 'main.invalid', since: '2026-10-28T10:00:00Z' }, handover: null, addresses: [
    { host: 'main.invalid', port: 15432, slot: null, machine: 'main.invalid', cert: COPY_PEM },
    { host: 'copy.example', port: 5434, slot: 'slot_c', machine: 'copy.example', cert: COPY_PEM },
  ], copies: [{ slot: 'slot_c', machine: 'copy.example', client: '10.0.0.2' }] });
  writeRegistry({ c: copyFixture() });
  SWITCH_TIMING.replayWaitMs = 50;
  SWITCH_TIMING.pollMs = 5;
});
afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

const raises = () => fake.calls.map(c => c.input).filter(i => i.includes('INSERT INTO smdb_manager.generation AS g'));

describe('L5 an unplanned take-over press', () => {
  it('over an unfinished restore: the intent saved before the raise names the restore', async () => {
    fake.dbs['c-pg'].restoreState = { pending: true, file: 'old.dump', at: '2026-10-28T09:00:00Z', generation: 3, machine: 'main.invalid', since: null };
    fake.dbs['c-pg'].fail.raise = 'ERROR:  disk full';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = await takeOverMain('c', { confirm: true, start: false });
    warn.mockRestore();
    expect(r.text).toBe('The copy is promoted, but its generation could not be raised (ERROR:  disk full), so bots may not choose it over the old main. Press Take over again to finish.');
    expect(stored('c').fleetDbReplica.takeover).toMatchObject({ planned: false, generation: 4, inherit: { file: 'old.dump', at: '2026-10-28T09:00:00Z' } });
  });

  it('without the cap: the raise has nothing between the address rows and the generation read', async () => {
    const r = await takeOverMain('c', { confirm: true, start: false });
    expect(r.success).toBe(true);
    const [raise] = raises();
    const end = 'END $$;\n';
    expect(raise.slice(raise.lastIndexOf(end) + end.length)).toMatch(/^SELECT generation \|\| /);
  });
});
