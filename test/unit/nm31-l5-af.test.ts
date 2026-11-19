import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-l5-af-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    /** removeVolume: the names it was called with; `fail` answers false once; `throws` marks the volume gone and throws once. */
    remove: { calls: [] as string[], fail: false, throws: false },
  };
});

vi.mock('child_process', async (importOriginal) => (await import('./nm31-run')).childProcessMock(await importOriginal(), require('fs')));
vi.mock('fs', async (importOriginal) => (await import('./nm31-run')).fsMock(await importOriginal()));
vi.mock('../../src/docker/dockerClient', async (importOriginal) => {
  const { run } = await import('./nm31-run');
  return {
    ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
    volumeState: (name: string) => run.volumes[name] ?? 'absent',
    removeVolume: (name: string) => {
      h.remove.calls.push(name);
      if (h.remove.fail) {
        h.remove.fail = false;
        return false;
      }
      run.volumes[name] = 'absent';
      if (h.remove.throws) {
        h.remove.throws = false;
        throw new Error('the manager stopped here');
      }
      return true;
    },
    listBotContainersAsync: async () => [],
  };
});
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  callAppHook: async () => ({ ok: true, body: { saved: true } }),
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { deleteKept, KEPT_TEXT } from '../../src/instance/keptData';
import { docker, resetDocker } from './nm2-docker';
import { holder } from './dump-fake';
import { clearRegistry } from './nm2-harness';
import { resetRun, run } from './nm31-run';
import { resetSeed } from './nm31-seed';
import { fwd, keptAfterStart, resetBack, stored } from './nm31-back';

const OLD = 'bota-fleet-postgres-data';
const S = 'smdb-keptcopy-a';
const CP = 'smdb-keptcopy-a-cp';
const LABEL = 'smdb.testrestore=a';
const IMAGE = 'postgres:16-alpine';
const SIZE = 'du -sk /from && df -Pk /to';
const COPY = 'cp -a /from/. /to/';
const DF_HEAD = 'Filesystem 1024-blocks Used Available Capacity Mounted on';
const set = () => fwd().stamp;

/** What the size read answers; null prints the du and df lines from `size`. */
let sizeOut: { ok: boolean; stdout?: string; stderr?: string } | null = null;
const size = { kb: 1000, freeKb: 50 * 1024 * 1024 };

function tarFake(): void {
  let args: string[] = [];
  let n = 0;
  docker.overrides.push({
    match: a => {
      if (a[0] !== '-cf' && a[0] !== '-xf') return false;
      args = a;
      return true;
    },
    answer: () => {
      if (args[0] === '-cf') {
        const [, file, , parent, base] = args;
        const snap = path.join(h.dir, 'snaps', String(++n));
        fs.cpSync(path.join(parent, base), path.join(snap, base), { recursive: true, verbatimSymlinks: true });
        fs.writeFileSync(file, snap);
        return { ok: true };
      }
      const [, file, , dir] = args;
      fs.cpSync(fs.readFileSync(file, 'utf-8'), dir, { recursive: true, verbatimSymlinks: true });
      return { ok: true };
    },
  });
}

function containerReads(): void {
  docker.overrides.push({
    match: a => a[0] === 'run' && a.includes(SIZE),
    answer: () => sizeOut ?? { ok: true, stdout: `${size.kb}\t/from\n${DF_HEAD}\noverlay 100000000 10 ${size.freeKb} 1% /to\n` },
  });
  docker.overrides.push({
    match: a => a[0] === 'exec' && a[1] === 'smdb-keptcheck-a' && a.includes('psql'),
    answer: () => ({ ok: true, stdout: Object.entries(holder.counts).map(([k, v]) => `count|${k}|${v}\n`).join('') }),
  });
}

async function kept(): Promise<void> {
  await keptAfterStart('main', { off: false });
  docker.calls.length = 0;
  run.execCalls.length = 0;
}

function openWith(answer: unknown, error: string): void {
  expect(answer).toEqual({ success: false, status: expect.any(Number), open: true, error });
  expect(stored().keptOp).toMatchObject({ op: 'delete', set: set(), step: 'recorded', lastError: error });
  expect(h.remove.calls).toEqual([]);
  expect(run.volumes[OLD]).toBe('exists');
}

const created = () => docker.calls.filter(a => a[0] === 'volume' && a[1] === 'create');
const copies = () => docker.calls.filter(a => a[0] === 'run' && a.includes(COPY));

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-17T12:00:00.000Z'));
  resetDocker();
  resetRun();
  clearRegistry();
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.rmSync(path.join(h.dir, 'backups'), { recursive: true, force: true });
  fs.rmSync(path.join(h.dir, 'snaps'), { recursive: true, force: true });
  resetSeed();
  resetBack();
  run.holderToBase = true;
  Object.assign(h.remove, { calls: [], fail: false, throws: false });
  Object.assign(size, { kb: 1000, freeKb: 50 * 1024 * 1024 });
  sizeOut = null;
  tarFake();
  containerReads();
});
afterEach(() => {
  releaseFleetBackupBusy('a');
  vi.restoreAllMocks();
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('nm31 l5 af: the scratch copy of a Delete (X1)', () => {
  it('a copy helper left behind that cannot be removed stops the run before the scratch volume is made', async () => {
    await kept();
    docker.overrides.unshift({ match: a => a[0] === 'rm' && a[2] === CP, answer: { ok: false, stderr: 'Error response from daemon: permission denied' } });
    const answer = await deleteKept('a', set());
    openWith(answer, KEPT_TEXT.xDump('the scratch copy left by an earlier run could not be removed (Error response from daemon: permission denied)'));
    expect(created()).toEqual([]);
  });

  it('the scratch volume cannot be made: T-X-DUMP with docker\'s last line, and no helper runs', async () => {
    await kept();
    docker.overrides.unshift({ match: a => a[0] === 'volume' && a[1] === 'create', answer: { ok: false, stderr: 'some warning\nError response from daemon: no space left on device\n' } });
    const answer = await deleteKept('a', set());
    openWith(answer, KEPT_TEXT.xDump('the scratch volume could not be made (Error response from daemon: no space left on device)'));
    expect(docker.calls.filter(a => a[0] === 'run')).toEqual([]);
  });

  it('the size read and the copy run in a removed, networkless helper with the kept volume read-only and the scratch writable', async () => {
    await kept();
    await deleteKept('a', set());
    const helper = (script: string) => ['run', '--rm', '--name', CP, '--label', LABEL, '--network', 'none',
      '-v', `${OLD}:/from:ro`, '-v', `${S}:/to`, '--entrypoint', 'sh', IMAGE, '-c', script];
    expect(docker.calls.filter(a => a[0] === 'run' && a.includes(CP))).toEqual([helper(SIZE), helper(COPY)]);
    expect(created().filter(a => a.includes(S))).toEqual([['volume', 'create', '--label', LABEL, S]]);
  });

  it('a kept database of 10000000 KiB is read whole: T-X-DISK names 10790 MB needed', async () => {
    await kept();
    Object.assign(size, { kb: 10_000_000, freeKb: 500 * 1024 });
    openWith(await deleteKept('a', set()), KEPT_TEXT.xDisk(500, 10790));
    expect(copies()).toEqual([]);
  });

  it('a kept database of 10000000 KiB does not fit in 5 GiB free: T-X-DISK', async () => {
    await kept();
    Object.assign(size, { kb: 10_000_000, freeKb: 5 * 1024 * 1024 });
    openWith(await deleteKept('a', set()), KEPT_TEXT.xDisk(5120, 10790));
    expect(copies()).toEqual([]);
  });

  it('free space equal to the size plus 1 GiB is enough: the copy runs', async () => {
    await kept();
    Object.assign(size, { kb: 1000, freeKb: 1000 + 1024 * 1024 });
    const answer = await deleteKept('a', set()) as { success: boolean };
    expect(answer.success).toBe(true);
    expect(copies().length).toBe(1);
  });

  it('a df line with no free number: T-X-DUMP with that line', async () => {
    await kept();
    sizeOut = { ok: true, stdout: `1000\t/from\n${DF_HEAD}\noverlay - - - - /to\n` };
    openWith(await deleteKept('a', set()), KEPT_TEXT.xDump('the size of the kept database could not be read (overlay - - - - /to)'));
    expect(copies()).toEqual([]);
  });

  it('a size read that prints nothing: T-X-DUMP says empty output', async () => {
    await kept();
    sizeOut = { ok: true, stdout: '' };
    openWith(await deleteKept('a', set()), KEPT_TEXT.xDump('the size of the kept database could not be read (empty output)'));
    expect(copies()).toEqual([]);
  });

  it('a size read that fails: T-X-DUMP with its error', async () => {
    await kept();
    sizeOut = { ok: false, stderr: 'du: /from: Permission denied\n' };
    openWith(await deleteKept('a', set()), KEPT_TEXT.xDump('the size of the kept database could not be read (du: /from: Permission denied)'));
    expect(copies()).toEqual([]);
  });
});
