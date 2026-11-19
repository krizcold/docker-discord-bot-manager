import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-l5-q-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, reversed: new Set<string>() };
});

vi.mock('child_process', async (importOriginal) => (await import('./nm31-run')).childProcessMock(await importOriginal(), require('fs')));
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const m = (await import('./nm31-run')).fsMock(real) as Record<string, any>;
  // Lists a marked folder in reverse name order, as a file system with hashed directories can.
  const readdirSync = (p: import('fs').PathLike, o?: unknown) => {
    const out = (real.readdirSync as any)(p, o);
    return o === undefined && h.reversed.has(String(p)) ? [...out].sort().reverse() : out;
  };
  return { ...m, readdirSync, default: { ...m.default, readdirSync } };
});
vi.mock('../../src/docker/dockerClient', async (importOriginal) => {
  const { run } = await import('./nm31-run');
  return {
    ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
    volumeState: (name: string) => run.volumes[name] ?? 'absent',
    listBotContainersAsync: async () => [],
  };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { KEPT_TEXT, newStartNames, startOnNewDatabase } from '../../src/instance/keptData';
import { resetDocker } from './nm2-docker';
import { clearRegistry } from './nm2-harness';
import { resetRun, run } from './nm31-run';
import { answerDatabase, dataDirOf, patchRegistry, resetSeed, seedCopy, seedExternal, seedMain, stored } from './nm31-seed';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const names = () => newStartNames({ sanitizedName: 'bota' }, dataDirOf('a'), NOW);
const realSwap = containerManager.swapKeptData;
const press = () => startOnNewDatabase('a');
const lastError = (): string => stored().keptOp.lastError;

/** Runs `change` on the data folder right after the new folder is brought in (N6). */
function afterMoveIn(change: (dir: string) => void): void {
  run.afterRename = (from) => {
    if (from === names().inDir) change(dataDirOf('a'));
  };
}

/** Every swap built from the instance as stored with `drop` removed from it; the swaps built are kept. */
function swapWithout(drop: 'fleetDb' | 'fleetDbReplica' | null): containerManager.KeptSwap[] {
  const built: containerManager.KeptSwap[] = [];
  vi.spyOn(containerManager, 'swapKeptData').mockImplementation((id, key, build, step) => realSwap(id, key, (inst) => {
    const copy = { ...inst };
    if (drop) delete copy[drop];
    const s = build(copy);
    built.push(s);
    return s;
  }, step));
  return built;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  resetDocker();
  resetRun();
  clearRegistry();
  h.reversed.clear();
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  resetSeed();
});
afterEach(() => {
  releaseFleetBackupBusy('a');
  vi.restoreAllMocks();
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('nm31 l5 q: the folder brought in is checked before the folder save', () => {
  it('a foreign file beside maintenance.json, its .tmp and db-certs is the one name the refusal gives', async () => {
    await seedExternal('a', { certs: true });
    answerDatabase();
    afterMoveIn((dir) => {
      fs.writeFileSync(path.join(dir, 'x'), 'x');
      fs.writeFileSync(path.join(dir, 'maintenance.json.tmp'), '{}');
    });
    const answer = await press();
    expect(answer).toMatchObject({ success: false, open: true });
    expect(lastError()).toBe(KEPT_TEXT.nNotOurs(dataDirOf('a'), ['x']));
    expect(stored().keptOp.step).toBe('swapped');
  });

  it('two foreign files are named in sorted order when the folder lists them in reverse', async () => {
    await seedExternal('a', { certs: true });
    answerDatabase();
    h.reversed.add(dataDirOf('a'));
    afterMoveIn((dir) => {
      fs.writeFileSync(path.join(dir, 'a1'), 'x');
      fs.writeFileSync(path.join(dir, 'b2'), 'x');
    });
    await press();
    expect(lastError()).toBe(KEPT_TEXT.nNotOurs(dataDirOf('a'), ['a1', 'b2']));
  });

  it('a maintenance.json.tmp left in the folder brought in refuses, naming every file', async () => {
    await seedExternal('a', { certs: true });
    answerDatabase();
    afterMoveIn((dir) => fs.writeFileSync(path.join(dir, 'maintenance.json.tmp'), '{}'));
    await press();
    expect(lastError()).toBe(KEPT_TEXT.nNotOurs(dataDirOf('a'), ['db-certs', 'maintenance.json', 'maintenance.json.tmp']));
  });

  it('a db-certs folder the kept folder lacks refuses', async () => {
    await seedExternal('a');
    answerDatabase();
    afterMoveIn((dir) => fs.mkdirSync(path.join(dir, 'db-certs')));
    await press();
    expect(lastError()).toBe(KEPT_TEXT.nNotOurs(dataDirOf('a'), ['db-certs', 'maintenance.json']));
  });

  it('a certificate the kept folder lacks refuses', async () => {
    await seedExternal('a', { certs: true });
    answerDatabase();
    afterMoveIn((dir) => fs.writeFileSync(path.join(dir, 'db-certs', 'zz-extra.crt'), 'x'));
    await press();
    expect(lastError()).toBe(KEPT_TEXT.nNotOurs(dataDirOf('a'), ['db-certs', 'maintenance.json']));
  });

  it('a certificate whose bytes differ from the kept one refuses', async () => {
    await seedExternal('a', { certs: true });
    answerDatabase();
    afterMoveIn((dir) => {
      const certs = path.join(dir, 'db-certs');
      const first = fs.readdirSync(certs).filter(n => n.endsWith('.crt'))[0];
      fs.writeFileSync(path.join(certs, first), 'changed');
    });
    await press();
    expect(lastError()).toBe(KEPT_TEXT.nNotOurs(dataDirOf('a'), ['db-certs', 'maintenance.json']));
  });

  it('a file where the new folder should be is refused naming nothing, since it cannot be listed', async () => {
    await seedExternal('a', { certs: true });
    answerDatabase();
    let done = false;
    run.beforeRename = (from) => {
      if (!done && from === dataDirOf('a')) {
        done = true;
        throw Object.assign(new Error('EIO: stopped here'), { code: 'EIO' });
      }
    };
    expect(await press()).toMatchObject({ success: false, open: true });
    fs.rmSync(names().inDir, { recursive: true });
    fs.writeFileSync(names().inDir, 'x');
    await press();
    expect(lastError()).toBe(KEPT_TEXT.nNotOurs(names().inDir, []));
  });
});

describe('nm31 l5 q: the swap reads the instance as stored', () => {
  it('main: a database gone from the instance stops the swap with its reason', async () => {
    await seedMain();
    answerDatabase();
    swapWithout('fleetDb');
    await press();
    expect(lastError()).toBe('the record could not be saved (the instance no longer holds the database the record names)');
    expect(stored().keptSets ?? []).toEqual([]);
  });

  it('main: the restore notice goes into the kept set, and none is added when there is none', async () => {
    await seedMain();
    const notice = { file: 'f.dump', text: 'the restore failed', at: '2026-11-01T00:00:00.000Z' };
    patchRegistry('a', { fleetRestoreError: notice });
    answerDatabase();
    let built = swapWithout(null);
    await press();
    expect(built[0].add.restoreNotice).toEqual(notice);
    expect(stored().keptSets[0].restoreNotice).toEqual(notice);

    vi.restoreAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    resetDocker();
    resetRun();
    clearRegistry();
    fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
    resetSeed();
    await seedMain();
    answerDatabase();
    built = swapWithout(null);
    await press();
    expect(built).toHaveLength(1);
    expect('restoreNotice' in built[0].add).toBe(false);
  });

  it('copy: a live copy gone from the instance stops the swap with its reason', async () => {
    await seedCopy();
    answerDatabase();
    const built = swapWithout('fleetDbReplica');
    await press();
    expect(built).toHaveLength(0);
    expect(lastError()).toBe('the record could not be saved (the instance no longer holds the live copy the record names)');
  });
});
