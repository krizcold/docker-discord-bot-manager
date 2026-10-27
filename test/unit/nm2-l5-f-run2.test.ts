import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm2-l5f2-'));
  process.env.DATA_DIR = dir;
  return {
    dir,
    url: 'postgresql://app:pw@bot-a-postgres:5432/app',
    rmThrowsNull: false,
    restoreThrowsNull: false,
    holderThrowsNull: false,
    dumpThrowsNull: false,
    readThrowsNull: false,
    failDirSync: false,
  };
});

vi.mock('child_process', async (importOriginal) => {
  const base: any = await (await import('./nm2-docker')).childProcessMock(await importOriginal());
  const { isHolder } = await import('./dump-fake');
  const execFile = (cmd: string, args: string[], opts: any, cb: any) => {
    if (h.rmThrowsNull && args[0] === 'rm' && args[1] === '-f') { h.rmThrowsNull = false; throw null; }
    return base.execFile(cmd, args, opts, cb);
  };
  const spawn = (cmd: string, args: string[], ...rest: any[]) => {
    if (h.restoreThrowsNull && args.includes('pg_restore')) throw null;
    if (h.holderThrowsNull && cmd === 'docker' && isHolder(args)) throw null;
    if (h.dumpThrowsNull && cmd === 'docker' && args.includes('pg_dump')) throw null;
    return base.spawn(cmd, args, ...rest);
  };
  return { ...base, execFile, spawn, default: { ...base.default, execFile, spawn } };
});
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const createReadStream = (p: any, o?: any) => {
    if (h.readThrowsNull) throw null;
    return (real.createReadStream as any)(p, o);
  };
  const openSync = (p: any, flags: any, mode?: any) => {
    if (h.failDirSync && flags === 'r' && String(p).endsWith('fleet-postgres')) throw new Error('EIO: folder sync refused');
    return real.openSync(p, flags, mode);
  };
  const over = { createReadStream, openSync };
  return { ...real, ...over, default: { ...real, ...over } };
});
vi.mock('../../src/config/appCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/config/appCapabilities')>()),
  findAppCapabilities: () => ({ companionDb: { env: { url: 'DATABASE_URL' } } }),
}));
vi.mock('../../src/env/manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/env/manager')>()),
  getEnvVars: () => ({ DATABASE_URL: h.url }),
  getEnvVarsWithStatus: () => ({ vars: { DATABASE_URL: h.url }, undecryptable: [], corrupt: false }),
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import { docker, resetDocker } from './nm2-docker';
import { PRIMARY, seedBot, clearRegistry, stored, dumps, putDump, stampText, restartedManager, localAt, setNow, realNow } from './nm2-harness';

const NOW = localAt(10, 30);
const FILE = `daily-${stampText(localAt(4, 10))}.dump`;
const COUNTS = { '"public"."t"': 3 };
const T = 'smdb-testrestore-a';
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;

async function testText(): Promise<string | undefined> {
  vi.resetModules();
  const bc = await import('../../src/instance/backupCheck');
  const cm = await import('../../src/docker/containerManager');
  return (await bc.runTestRestore(cm.getBot('a')!, 'main', FILE))?.text;
}

async function dumpNow() {
  const fb = await restartedManager();
  return fb.runFleetDump(stored(), 'pre-restore-');
}

beforeEach(() => {
  setNow(NOW);
  resetDocker();
  docker.restoredCounts = { ...COUNTS };
  Object.assign(h, { rmThrowsNull: false, restoreThrowsNull: false, holderThrowsNull: false, dumpThrowsNull: false, readThrowsNull: false, failDirSync: false });
  fs.rmSync(path.join(h.dir, 'backups'), { recursive: true, force: true });
  clearRegistry();
  seedBot({ fleetDb: PRIMARY });
  putDump(FILE, { counts: COUNTS });
});
afterEach(() => { realNow(); Object.defineProperty(process, 'platform', platform); });
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('NM2 L5 f run 2: the confirming gate survivors', () => {
  it('a docker call that throws a non-Error value is a failed docker line', async () => {
    h.rmThrowsNull = true;
    expect(await testText()).toBe(`the throwaway container or volume ${T} from an earlier test could not be removed (Failed to run docker exec: null)`);
  });

  it('a restore spawn that throws a non-Error value fails the test with that value', async () => {
    h.restoreThrowsNull = true;
    expect(await testText()).toBe('Failed to run docker exec: null');
  });

  it('a test that stops on a non-Error value names it', async () => {
    h.readThrowsNull = true;
    expect(await testText()).toBe('the test stopped on an error: null');
  });

  it('a snapshot holder spawn that throws a non-Error value fails the dump', async () => {
    h.holderThrowsNull = true;
    expect(await dumpNow()).toEqual({ success: false, error: 'Failed to run docker exec: null' });
  });

  it('a pg_dump spawn that throws a non-Error value fails the dump', async () => {
    h.dumpThrowsNull = true;
    expect(await dumpNow()).toEqual({ success: false, error: 'Failed to run docker exec: null' });
    expect(dumps()).toEqual([FILE]);
  });

  it('a folder sync that fails on Linux is a failed dump with the file kept', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    h.failDirSync = true;
    const r = await dumpNow();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^The dump pre-restore-.*\.dump was written, but its folder could not be synced to disk/);
    expect(dumps()).toEqual([FILE, `pre-restore-${stampText(NOW)}.dump`]);
  });
});
