import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm2-start-'));
  process.env.DATA_DIR = dir;
  return { dir };
});

vi.mock('child_process', async (importOriginal) => (await import('./nm2-docker')).childProcessMock(await importOriginal()));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import { docker, resetDocker } from './nm2-docker';
import { PRIMARY, seedBot, clearRegistry, stored, dumpsDir, restartedManager, startedWithTick, logged } from './nm2-harness';

const put = (id: string, names: string[]) => {
  fs.mkdirSync(dumpsDir(id), { recursive: true });
  for (const n of names) fs.writeFileSync(path.join(dumpsDir(id), n), 'x');
};
const left = (id: string) => fs.readdirSync(dumpsDir(id)).sort();

beforeEach(async () => {
  // A scheduler start of the row before may still be listing leftovers.
  await new Promise(r => setTimeout(r, 50));
  resetDocker();
  fs.rmSync(path.join(h.dir, 'backups'), { recursive: true, force: true });
  clearRegistry();
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('NM2 F: the scheduler start', () => {
  it('F1 unfinished files are deleted in folders whose bot is not busy, and the count is logged', async () => {
    seedBot({ fleetDb: PRIMARY }, 'a');
    seedBot({ fleetDb: PRIMARY }, 'b');
    put('a', ['hourly-1.dump.tmp', 'hourly-1.dump.json.tmp', 'hourly-2.dump.json', 'hourly-3.dump', 'hourly-3.dump.json', 'term-floor.json', 'term-floor.json.tmp']);
    put('b', ['hourly-4.dump.tmp']);
    const fb = await restartedManager();
    const guards = await import('../../src/instance/fleetBackupGuards');
    expect(guards.claimFleetBackupBusy('b')).toBe(true);
    const { lines } = await logged(() => startedWithTick(fb));
    guards.releaseFleetBackupBusy('b');
    expect(left('a')).toEqual(['hourly-3.dump', 'hourly-3.dump.json', 'term-floor.json']);
    expect(left('b')).toEqual(['hourly-4.dump.tmp']);
    expect(lines.join('\n')).toContain(`[FleetBackup] Deleted 4 unfinished backup file(s) a stopped manager left in ${dumpsDir('a')}`);
  });

  it('F2 a folder that cannot be read is logged and the rest go on', async () => {
    fs.mkdirSync(path.join(h.dir, 'backups', 'c'), { recursive: true });
    fs.writeFileSync(dumpsDir('c'), 'not a folder');
    put('d', ['x.dump.tmp']);
    const fb = await restartedManager();
    const { lines } = await logged(() => startedWithTick(fb));
    expect(lines.join('\n')).toMatch(/\[FleetBackup\] .*fleet-postgres.* could not be read/);
    expect(left('d')).toEqual([]);
  });

  it('F3 a test record reading running becomes interrupted at start', async () => {
    seedBot({ fleetDb: PRIMARY, fleetBackupTests: { main: { last: { file: 'daily-x.dump', startedAt: 1, result: 'running' } } } });
    const fb = await restartedManager();
    startedWithTick(fb);
    expect(stored().fleetBackupTests.main.last).toMatchObject({ result: 'interrupted', cutShort: 1 });
  });

  it('F4 labelled throwaways are removed by exact name, only when the name matches', async () => {
    docker.orphans = { containers: ['smdb-testrestore-x1', 'smdb-testrestore-x;rm'], volumes: ['smdb-testrestore-y_2'] };
    const fb = await restartedManager();
    startedWithTick(fb);
    await vi.waitFor(() => expect(docker.calls.some(a => a[0] === 'volume' && a[1] === 'rm')).toBe(true));
    expect(docker.calls.filter(a => a[0] === 'rm' || (a[0] === 'volume' && a[1] === 'rm'))).toEqual([['rm', '-f', 'smdb-testrestore-x1'], ['volume', 'rm', 'smdb-testrestore-y_2']]);
    const list = docker.calls.find(a => a[0] === 'ps')!;
    expect(list).toEqual(['ps', '-a', '--filter', 'label=smdb.testrestore', '--format', '{{.Names}}']);
  });

  it('F4 a listing that fails is logged', async () => {
    docker.overrides.push({ match: a => a[0] === 'ps', answer: { ok: false, stderr: 'Cannot connect to the Docker daemon' } });
    const fb = await restartedManager();
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    try {
      startedWithTick(fb);
      await vi.waitFor(() => expect(lines.join('\n')).toContain('Cannot connect to the Docker daemon'));
    } finally { spy.mockRestore(); }
  });
});
