import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm23-dump-'));
  process.env.DATA_DIR = dir;
  return {
    dir,
    url: 'postgresql://app:pw@bot-a-postgres:5432/app',
    seedView: null as null | ((instance: any) => any),
    freeBytes: null as number | null,
    failDirSync: false,
  };
});

vi.mock('child_process', async (importOriginal) => (await import('./nm2-docker')).childProcessMock(await importOriginal()));
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const statfsSync = (p: any, o?: any) => (h.freeBytes !== null ? { bavail: h.freeBytes / 4096, bsize: 4096 } : (real.statfsSync as any)(p, o));
  const openSync = (p: any, flags: any, mode?: any) => {
    if (h.failDirSync && flags === 'r' && String(p).endsWith('fleet-postgres')) throw new Error('EIO: folder sync refused');
    return real.openSync(p, flags, mode);
  };
  return { ...real, statfsSync, openSync, default: { ...real, statfsSync, openSync } };
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
vi.mock('../../src/instance/fleetReplica', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/instance/fleetReplica')>();
  return { ...real, seedView: (instance: any) => (h.seedView ? h.seedView(instance) : real.seedView(instance)) };
});

import * as fs from 'fs';
import * as path from 'path';
import { docker, resetDocker, callsWith } from './nm2-docker';
import { holder } from './dump-fake';
import { fenceOwners } from './fence-fake';
import {
  PRIMARY, REPLICA, seedBot, clearRegistry, stored, files, dumps, dumpsDir, putDump, stampText, restartedManager, startedWithTick, tickOnce, localAt, logged,
} from './nm2-harness';
import { setNow, realNow } from './nm2-harness';

const NOW = localAt(10, 30);
const mainBot = (extra: Record<string, unknown> = {}) => seedBot({ fleetDb: PRIMARY, ...extra });
const pgDumps = () => callsWith('pg_dump').filter(a => a.includes('pg_dump'));

async function ready() {
  const fb = await restartedManager();
  const tick = startedWithTick(fb);
  return { fb, tick, run: () => tickOnce(fb, tick) };
}

beforeEach(() => {
  setNow(NOW);
  resetDocker();
  fenceOwners.clear();
  h.url = 'postgresql://app:pw@bot-a-postgres:5432/app';
  h.seedView = null;
  h.freeBytes = null;
  h.failDirSync = false;
  fs.rmSync(path.join(h.dir, 'backups'), { recursive: true, force: true });
  clearRegistry();
});
afterEach(() => { realNow(); });

describe('NM23 a dump of a table whose name holds a line break', () => {
  it('D1 the holder prints the escaped name and the counts file keeps the exact name', async () => {
    mainBot();
    holder.counts = { '"public"."a"': 2, '"smdb_data"."x\\ny\\rz\\\\w"': 5 };
    const { run } = await ready();
    await run();
    const name = `daily-${stampText(NOW)}.dump`;
    expect(files()).toEqual([name, `${name}.json`]);
    const meta = JSON.parse(fs.readFileSync(path.join(dumpsDir(), `${name}.json`), 'utf-8'));
    expect(meta.counts).toEqual({ '"public"."a"': 2, '"smdb_data"."x\ny\rz\\w"': 5 });
    expect(meta.tables).toBe(2);
    expect(meta.rows).toBe(7);
  });

  it('D2 an escape the SQL never writes refuses the dump', async () => {
    mainBot();
    holder.counts = { '"public"."a\\q"': 2 };
    const { fb, run } = await ready();
    await run();
    expect(dumps()).toEqual([]);
    expect(fb.fleetBackupStatus(stored()).main?.lastError).toMatch(/a table count read back as count\|"public"\."a\\q"\|2/);
  });
});
