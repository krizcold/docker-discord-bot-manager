import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-l5-j-stale-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    mainVolumeAbsent: false,
    retireFail: false,
    seenDump: [] as unknown[],
    sidecarOpts: [] as unknown[],
    joinOpts: [] as unknown[],
  };
});

vi.mock('../../src/config/appCapabilities', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/config/appCapabilities')>();
  return { ...real, findAppCapabilities: () => ({ companionDb: { env: { url: 'DATABASE_URL' } } }) };
});
vi.mock('../../src/env/manager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/env/manager')>();
  return {
    ...real,
    getEnvVarsWithStatus: () => ({ vars: { DATABASE_URL: 'postgres://bot-a-postgres/app' }, corrupt: false, undecryptable: [] }),
    getEnvVars: () => ({ DATABASE_URL: 'postgres://bot-a-postgres/app' }),
  };
});
// As nm3-stale.test.ts, but the retire keeps the restore notice (the manager forgets it) and can fail.
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return {
    ...real,
    runningNonSidecarContainers: async () => [],
    runningInstanceContainers: async () => [],
    deployedComposeExists: () => true,
    startFleetDbSidecar: async (_id: string, opts: unknown) => { tmp.sidecarOpts.push(opts); return { success: true }; },
    retireFleetDbSidecar: async () => {
      const nodeFs = await import('fs');
      const file = (await import('path')).join(process.env.DATA_DIR!, 'instances.json');
      const reg = JSON.parse(nodeFs.readFileSync(file, 'utf-8'));
      tmp.seenDump.push(reg.instances.a.fleetDbReplicaSeed?.safetyDump);
      if (tmp.retireFail) return { success: false, error: 'docker rm refused' };
      delete reg.instances.a.fleetDb;
      nodeFs.writeFileSync(file, JSON.stringify(reg, null, 2));
      return { success: true };
    },
    applyFleetDbReplicaService: async () => ({ success: true }),
    markPendingApplyIfRunning: async () => undefined,
  };
});
vi.mock('../../src/instance/fleetReplication', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/instance/fleetReplication')>();
  const nodeFs = await import('fs');
  const nodePath = await import('path');
  return {
    ...real,
    generateCertPair: async (dir: string) => {
      for (const file of ['server.key', 'server.crt']) nodeFs.writeFileSync(nodePath.join(dir, file), 'fake');
      return { ok: true };
    },
  };
});
// The join after the rebuild succeeds and leaves a readable join code; the bot takes the new list.
vi.mock('../../src/instance/fleetJoin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetJoin')>()),
  joinFleet: async (_i: unknown, _code: string, opts: unknown) => { tmp.joinOpts.push(opts); return { success: true }; },
  storedJoin: () => ({ host: 'primary.invalid' }),
  registerOwnCopy: async () => null,
  writeEnvList: async () => ({ addresses: { state: 'applied' } }),
}));
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  capabilityRefusal: () => null,
}));

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = require('events') as typeof import('events');
  const { PassThrough } = require('stream') as typeof import('stream');
  const absent = (name: string) => name.endsWith('-fleet-postgres-replica-data') || (tmp.mainVolumeAbsent && name === 'bot-a-pgdata');
  const execFile = vi.fn((_cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (err: Error | null, stdout: string, stderr: string) => void;
    const sql = args.join(' ');
    if (args[0] === 'inspect') return cb(null, 'true\n', '');
    if (args[0] === 'volume' && args[1] === 'inspect') {
      return absent(args[args.length - 1]) ? cb(new Error('fail'), '', 'Error: No such volume') : cb(null, '[]', '');
    }
    if (sql.includes('ALTER SYSTEM SET default_transaction_read_only = on')) return cb(null, '0\n', '');
    if (sql.includes('SHOW default_transaction_read_only')) return cb(null, 'off\n', '');
    if (sql.includes('FROM pg_database WHERE datname')) return cb(null, '1\n', '');
    if (sql.includes('pg_control_system()')) return cb(null, '7001|2\n', '');
    if (sql.includes("to_regclass('smdb_control.term')")) return cb(null, 'f|f\n', '');
    if (sql.includes('to_regclass')) return cb(null, 'f\n', '');
    return cb(null, '', '');
  });
  const exec = (_cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    done(null, { stdout: '', stderr: '' });
  };
  const spawn = vi.fn((_cmd: string, args: string[]) => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.resume();
    child.kill = () => true;
    const isDump = args.includes('pg_dump');
    const identify = args.includes('IDENTIFY_SYSTEM');
    setTimeout(() => {
      child.stdout.end(isDump ? 'dump' : args.includes('SELECT pg_is_in_recovery()') ? 'f\n' : identify ? '7001|3|0/3000000|\n' : '');
      child.stderr.end('');
      setTimeout(() => child.emit('close', 0), 5);
    }, 5);
    return child;
  });
  const execFileSync = (cmd: string, args: string[], opts: any) => {
    if (cmd === 'docker' && args[0] === 'volume' && args[1] === 'inspect' && absent(args[args.length - 1])) throw new Error('Error: No such volume');
    return real.execFileSync(cmd, args, opts);
  };
  const fencedExecFile = (await import('./fence-fake')).withFence(execFile as any);
  const heldSpawn = (await import('./dump-fake')).withDumpHolder(spawn as any);
  return { ...real, execFile: fencedExecFile, execFileSync, exec, spawn: heldSpawn, default: { ...real, execFile: fencedExecFile, execFileSync, exec, spawn: heldSpawn } };
});

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as fleetBackup from '../../src/instance/fleetBackup';
import { getFleetReplicaStatus, reseedStalePrimary } from '../../src/instance/fleetReplica';
import { certSource } from '../../src/instance/fleetJoin';
import { codeFor, fixtureCert } from './join-fake';

const REGISTRY = path.join(tmp.dir, 'instances.json');
const primary = { containerName: 'bot-a-postgres', user: 'app', db: 'app', volume: 'bot-a-pgdata' };
const CODE = codeFor('postgresql://replicator:fakepass@primary.invalid:5433/app');
const realWarn = console.warn;

const withNotice = () => {
  const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf-8'));
  reg.instances.a.fleetRestoreError = { file: 'old.dump', text: 'Restore of old.dump failed: the copy was cut', at: '2026-10-30T09:00:00.000Z', doubt: true };
  fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2));
};

beforeEach(() => {
  certSource.fetch = fixtureCert;
  tmp.mainVolumeAbsent = false;
  tmp.retireFail = false;
  tmp.seenDump = [];
  tmp.sidecarOpts = [];
  tmp.joinOpts = [];
  console.warn = () => {};
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: {
    a: { id: 'a', sanitizedName: 'a', displayName: 'a', status: 'stopped', sourceUrl: 'https://example.invalid/fake/app', fleetDb: primary, fleetBackup: { enabled: false, hour: 4, keep: 7 } },
  } }, null, 2));
  fs.mkdirSync(path.join(tmp.dir, 'bots', 'a'), { recursive: true });
});
afterAll(() => {
  console.warn = realWarn;
  fs.rmSync(tmp.dir, { recursive: true, force: true });
});

const finished = async () => {
  for (let i = 0; i < 500; i++) {
    const seed = containerManager.getBot('a')?.fleetDbReplicaSeed;
    if (!seed || seed.parked) return containerManager.getBot('a')!;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('the seed did not settle');
};
const noteOf = async () => (await getFleetReplicaStatus(await finished())).seedNote ?? '';

describe('the stale-primary re-seed, its join and its dump', () => {
  it('a dump taken before the run is named, the join holds the lock, and the bot answer follows', async () => {
    expect(reseedStalePrimary(containerManager.getBot('a')!, CODE, 'standby.invalid', 5440, true, { dumpDone: true, safetyDump: 'pre-reseed-given.dump' })).toMatchObject({ success: true });
    expect(await noteOf()).toBe("This machine's database was rebuilt as a copy of primary.invalid. A dump of the old database is kept with the backups (pre-reseed-given.dump). The running bot took the new database list.");
    expect(tmp.joinOpts).toEqual([{ inLock: true }]);
    expect(tmp.seenDump).toEqual(['pre-reseed-given.dump']);
    expect(tmp.sidecarOpts).toEqual([]);
  });

  it('a dump name without the done mark is not claimed when no dump was taken', async () => {
    tmp.mainVolumeAbsent = true;
    expect(reseedStalePrimary(containerManager.getBot('a')!, CODE, 'standby.invalid', 5440, true, { safetyDump: 'pre-reseed-given.dump' })).toMatchObject({ success: true });
    expect(await noteOf()).toBe("This machine's database was rebuilt as a copy of primary.invalid. The running bot took the new database list.");
  });

  it('the database comes up handed over for the safety dump, and the notice goes with it', async () => {
    withNotice();
    expect(reseedStalePrimary(containerManager.getBot('a')!, CODE, 'standby.invalid', 5440, true)).toMatchObject({ success: true });
    await finished();
    expect(tmp.sidecarOpts).toEqual([{ retireRetry: true, handedOver: true }]);
    expect(fleetBackup.shownRestoreNoticeFile('a')).toBeNull();
  });

  it('a failed retire keeps the restore notice', async () => {
    withNotice();
    tmp.retireFail = true;
    expect(reseedStalePrimary(containerManager.getBot('a')!, CODE, 'standby.invalid', 5440, true)).toMatchObject({ success: true });
    await finished();
    expect(tmp.seenDump.length).toBe(1);
    expect(fleetBackup.shownRestoreNoticeFile('a')).toBe('old.dump');
  });
});
