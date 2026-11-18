import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm34-delete-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, removed: [] as string[] };
});

vi.mock('child_process', async (importOriginal) => (await import('./nm31-run')).childProcessMock(await importOriginal(), require('fs')));
vi.mock('fs', async (importOriginal) => (await import('./nm31-run')).fsMock(await importOriginal()));
vi.mock('../../src/docker/dockerClient', async (importOriginal) => {
  const { run } = await import('./nm31-run');
  return {
    ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
    volumeState: (name: string) => run.volumes[name] ?? 'absent',
    removeVolume: (name: string) => {
      h.removed.push(name);
      run.volumes[name] = 'absent';
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
import { deleteKept, keepKept, KEPT_TEXT, keptDate, keptRunningOp } from '../../src/instance/keptData';
import { docker, resetDocker } from './nm2-docker';
import { holder } from './dump-fake';
import { clearRegistry, dumpsDir, registryPath } from './nm2-harness';
import { resetRun, run } from './nm31-run';
import { dataDirOf, resetSeed } from './nm31-seed';
import { fwd, keptAfterStart, LATER, resetBack, stored } from './nm31-back';

const OLD = 'bota-fleet-postgres-data';
const S = 'smdb-keptcopy-a';
const CK = 'smdb-keptcheck-a';
const SIZE = 'du -sk /from && df -Pk /to';
const LATER_ISO = new Date(LATER).toISOString();
const NO_WORK_STDERR = 'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  role "dbm_work" does not exist';
const NOWORK = ` The database has no dbm_work login: it was made before the manager's own logins existed, so the manager cannot dump it, and it stays under Kept data. To remove it by hand without changing it: choose Keep it, copy the volume ${OLD} to a new volume (mounting ${OLD} read-only), start Postgres on the copy only, dump the copy as the database's own superuser and check that dump, then remove the volume with docker volume rm ${OLD}; Delete then removes the rest of this kept data after its own checks.`;
const set = () => fwd().stamp;
const keptDir = () => fwd().outDir;
const backupsKept = () => path.join(h.dir, 'backups', 'a', 'kept');
const archiveName = () => `${set()}.tar`;

/** tar as an in-process copy: -cf keeps a snapshot of the folder and names it in the archive; -xf copies the snapshot out. */
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
    answer: () => ({ ok: true, stdout: `1000\t/from\nFilesystem 1024-blocks Used Available Capacity Mounted on\noverlay 100000000 10 ${50 * 1024 * 1024} 1% /to\n` }),
  });
  docker.overrides.push({
    match: a => a[0] === 'exec' && a[1] === CK && a.includes('psql'),
    answer: () => ({ ok: true, stdout: Object.entries(holder.counts).map(([k, v]) => `count|${k}|${v}\n`).join('') }),
  });
}

const changes = () => docker.calls
  .filter(a => a[0] === 'rm' || (a[0] === 'volume' && (a[1] === 'rm' || a[1] === 'create')) || a[0] === 'run' || a[0] === '-cf' || a[0] === '-xf')
  .map(a => (a[0] === 'run' ? `run ${a[a.indexOf('--name') + 1]} ${a[a.length - 1]}` : a[0] === '-cf' || a[0] === '-xf' ? `tar ${a[0]}` : a.join(' ')));

/** A kept main set as a forward run leaves it; `folder: false` makes it a set with no folder, as B5 (b) of NM31 does. */
async function kept(opts: { folder?: boolean } = {}): Promise<void> {
  await keptAfterStart('main', { off: false });
  if (opts.folder === false) {
    const reg = JSON.parse(fs.readFileSync(registryPath(), 'utf-8'));
    reg.instances.a.keptSets[0].folder = null;
    fs.writeFileSync(registryPath(), JSON.stringify(reg, null, 2));
  }
  docker.calls.length = 0;
  run.execCalls.length = 0;
}

/** XO1's Delete: the dump of the scratch copy meets a cluster with no dbm_work. */
async function deleteWithoutWork(): Promise<string> {
  holder.failQueue.push(NO_WORK_STDERR);
  const answer = await deleteKept('a', set());
  const error = (answer as { error: string }).error;
  expect(answer).toEqual({ success: false, status: expect.any(Number), open: true, error });
  return error;
}

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
  h.removed = [];
  tarFake();
  containerReads();
});
afterEach(() => {
  releaseFleetBackupBusy('a');
  vi.restoreAllMocks();
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('nm34 delete: a kept database with no dbm_work', () => {
  it('XO1: T-X-DUMP and T-X-NOWORK naming the volume and the manual path; the scratch removed; nothing deleted', async () => {
    await kept();
    const error = await deleteWithoutWork();
    expect(KEPT_TEXT.xNoWork(OLD)).toBe(NOWORK);
    expect(error.startsWith('The dump of the kept database failed (')).toBe(true);
    expect(error, "B2 (code review 1): T-X-DUMP's first sentence, then T-X-NOWORK, with no Run Delete again").toMatch(/^The dump of the kept database failed \(.*role "dbm_work" does not exist.*\), so nothing was deleted\. The database has no dbm_work login: /);
    expect(error.endsWith(`, so nothing was deleted.${NOWORK}`)).toBe(true);
    expect(error).not.toContain('Run Delete again');
    expect(stored().keptOp).toMatchObject({ op: 'delete', set: set(), step: 'copy-made', lastError: error });
    expect(h.removed).toEqual([]);
    expect(run.volumes[OLD]).toBe('exists');
    expect(fs.existsSync(keptDir())).toBe(true);
    expect(stored().keptSets.map((x: { id: string }) => x.id)).toEqual([set()]);
    expect(changes().slice(-2)).toEqual([`rm -f ${S}`, `volume rm ${S}`]);
    expect(fs.existsSync(dumpsDir()) ? fs.readdirSync(dumpsDir()).filter(f => f.includes('pre-delete')) : []).toEqual([]);
  });

  it('XO2 (1 of 2): Keep it, the volume removed by hand, then Delete: the part dropped and the folder archived, checked and removed', async () => {
    await kept();
    await deleteWithoutWork();
    expect(await keepKept('a')).toMatchObject({ success: true });
    expect(stored().keptOp).toBeUndefined();
    run.volumes[OLD] = 'absent';
    docker.calls.length = 0;
    const answer = await deleteKept('a', set());
    const text = KEPT_TEXT.xDone({ date: keptDate(set()), folder: keptDir(), archive: archiveName() })
      + ` The kept volume ${OLD} no longer existed (docker said no such volume), so only the folder was deleted.`;
    expect(answer).toEqual({ success: true, text });
    expect(stored().keptSets).toBeUndefined();
    expect(stored().keptOp).toBeUndefined();
    expect(stored().keptLast).toEqual({ op: 'delete', set: set(), outcome: 'done', text, at: LATER_ISO });
    expect(fs.existsSync(keptDir())).toBe(false);
    expect(fs.readdirSync(backupsKept())).toEqual([archiveName()]);
    expect(fs.existsSync(dataDirOf('a'))).toBe(true);
    expect(h.removed).toEqual([]);
    expect(changes()).toEqual(['tar -cf', 'tar -xf']);
    expect(keptRunningOp('a')).toBeNull();
  });

  it('XO2 (2 of 2): a set with no folder: Keep it, the volume removed by hand, then Delete removes the set from Kept data', async () => {
    await kept({ folder: false });
    await deleteWithoutWork();
    expect(await keepKept('a')).toMatchObject({ success: true });
    run.volumes[OLD] = 'absent';
    docker.calls.length = 0;
    const answer = await deleteKept('a', set());
    expect(answer).toEqual({
      success: true,
      text: `The kept volume ${OLD} no longer exists (docker says no such volume), and the set named nothing else, so it was removed from Kept data; nothing was deleted.`,
    });
    expect(stored().keptSets).toBeUndefined();
    expect(stored().keptOp).toBeUndefined();
    expect(h.removed).toEqual([]);
    expect(changes()).toEqual([]);
    expect(fs.existsSync(keptDir())).toBe(true);
  });
});
