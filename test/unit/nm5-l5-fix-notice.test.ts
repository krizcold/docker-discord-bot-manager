import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// A restore that fails while the registry's notice write fails (b11-4's R28-J9 harness) fills the held notice; the
// stale-primary re-seed (nm5-l5-j-stale's harness) then runs in the same module state.
const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-l5-fix-notice-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, mode: 'restore' as 'restore' | 'reseed', restoreCode: 0, saveFails: false, retireFail: false };
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
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return {
    ...real,
    runningNonSidecarContainers: async () => [],
    runningInstanceContainers: async () => [],
    deployedComposeExists: () => true,
    startFleetDbSidecar: async () => ({ success: true }),
    updateInstanceFleetRestoreError: (botId: string, notice: { file: string; text: string; at: string; doubt: boolean } | null) => {
      if (tmp.saveFails && notice?.text.includes(' failed: ')) throw new Error('ENOSPC: no space left on device');
      return real.updateInstanceFleetRestoreError(botId, notice);
    },
    retireFleetDbSidecar: async () => {
      if (tmp.retireFail) return { success: false, error: 'docker rm refused' };
      const nodeFs = await import('fs');
      const file = (await import('path')).join(process.env.DATA_DIR!, 'instances.json');
      const reg = JSON.parse(nodeFs.readFileSync(file, 'utf-8'));
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
vi.mock('../../src/instance/fleetJoin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetJoin')>()),
  joinFleet: async () => ({ success: true }),
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
  type Cb = (err: Error | null, stdout: string, stderr: string) => void;
  const cbOf = (optsOrCb: unknown, maybeCb?: unknown) => (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as Cb;
  const restoreExec = (_cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = cbOf(optsOrCb, maybeCb);
    const sql = args.join(' ');
    if (args[0] === 'inspect') return cb(null, 'true\n', '');
    if (sql.includes('SHOW default_transaction_read_only')) return cb(null, 'off\n', '');
    if (sql.includes('FROM pg_database WHERE datname')) return cb(null, '0\n', '');
    if (sql.includes('to_regclass')) return cb(null, 'f\n', '');
    return cb(null, '', '');
  };
  const reseedExec = (_cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = cbOf(optsOrCb, maybeCb);
    const sql = args.join(' ');
    if (args[0] === 'inspect') return cb(null, 'true\n', '');
    if (args[0] === 'volume' && args[1] === 'inspect') {
      return args[args.length - 1].endsWith('-fleet-postgres-replica-data') ? cb(new Error('fail'), '', 'Error: No such volume') : cb(null, '[]', '');
    }
    if (sql.includes('ALTER SYSTEM SET default_transaction_read_only = on')) return cb(null, '0\n', '');
    if (sql.includes('SHOW default_transaction_read_only')) return cb(null, 'off\n', '');
    if (sql.includes('FROM pg_database WHERE datname')) return cb(null, '1\n', '');
    if (sql.includes('pg_control_system()')) return cb(null, '7001|2\n', '');
    if (sql.includes("to_regclass('smdb_control.term')")) return cb(null, 'f|f\n', '');
    if (sql.includes('to_regclass')) return cb(null, 'f\n', '');
    return cb(null, '', '');
  };
  const spawnFake = (_cmd: string, args: string[]) => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.resume();
    child.kill = () => true;
    const isDump = args.includes('pg_dump');
    const reseed = tmp.mode === 'reseed';
    setTimeout(() => {
      if (reseed) child.stdout.end(isDump ? 'dump' : args.includes('SELECT pg_is_in_recovery()') ? 'f\n' : args.includes('IDENTIFY_SYSTEM') ? '7001|3|0/3000000|\n' : '');
      else child.stdout.end(isDump ? 'dump' : undefined);
      child.stderr.end(reseed || isDump || tmp.restoreCode === 0 ? '' : 'pg_restore: error: out of disk');
      setTimeout(() => child.emit('close', reseed || isDump ? 0 : tmp.restoreCode), 5);
    }, 5);
    return child;
  };
  const restoreFake = await import('./restore-fake');
  const { withFence } = await import('./fence-fake');
  const { withDumpHolder } = await import('./dump-fake');
  const restoreExecFile = withFence(restoreFake.withRestoreFakes(restoreExec as any));
  const reseedExecFile = withFence(reseedExec as any);
  const restoreSpawn = withDumpHolder(restoreFake.withTocFake(spawnFake as any));
  const reseedSpawn = withDumpHolder(spawnFake as any);
  const execFile = (...a: any[]) => (tmp.mode === 'reseed' ? (reseedExecFile as any) : (restoreExecFile as any))(...a);
  const spawn = (...a: any[]) => (tmp.mode === 'reseed' ? (reseedSpawn as any) : (restoreSpawn as any))(...a);
  const exec = (_cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    done(null, { stdout: '', stderr: '' });
  };
  const execFileSync = (cmd: string, args: string[], opts: any) => {
    if (cmd === 'docker' && args[0] === 'volume' && args[1] === 'inspect' && args[args.length - 1].endsWith('-fleet-postgres-replica-data')) throw new Error('Error: No such volume');
    return real.execFileSync(cmd, args, opts);
  };
  return { ...real, execFile, execFileSync, exec, spawn, default: { ...real, execFile, execFileSync, exec, spawn } };
});

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as fleetBackup from '../../src/instance/fleetBackup';
import { reseedStalePrimary } from '../../src/instance/fleetReplica';
import { certSource } from '../../src/instance/fleetJoin';
import { codeFor, fixtureCert } from './join-fake';
import { MAINTAINED, writeDumpMeta } from './restore-fake';

const REGISTRY = path.join(tmp.dir, 'instances.json');
const DIR = path.join(tmp.dir, 'backups', 'a', 'fleet-postgres');
const OLD = `hourly-${new Date(Date.now() - 60 * 3600000).toISOString().replace(/[:.]/g, '-')}.dump`;
const primary = { containerName: 'bot-a-postgres', user: 'app', db: 'app', volume: 'bot-a-pgdata' };
const CODE = codeFor('postgresql://replicator:fakepass@primary.invalid:5433/app');
const realWarn = console.warn;
const realError = console.error;
const readReg = () => JSON.parse(fs.readFileSync(REGISTRY, 'utf-8'));
const writeReg = (reg: unknown) => fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2));

beforeEach(() => {
  certSource.fetch = fixtureCert;
  tmp.mode = 'restore';
  tmp.restoreCode = 0;
  tmp.saveFails = false;
  tmp.retireFail = false;
  console.warn = () => {};
  console.error = () => {};
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, OLD), 'dump');
  writeDumpMeta(DIR, OLD);
  fs.mkdirSync(path.join(tmp.dir, 'bots', 'a'), { recursive: true });
  writeReg({ instances: { a: { id: 'a', sanitizedName: 'a', displayName: 'a', ...MAINTAINED, sourceUrl: 'https://example.invalid/fake/app', fleetDb: primary, fleetBackup: { enabled: false, hour: 4, keep: 7 } } } });
});
afterAll(() => {
  console.warn = realWarn;
  console.error = realError;
  fs.rmSync(tmp.dir, { recursive: true, force: true });
});

const holdNotice = async () => {
  tmp.restoreCode = 1;
  tmp.saveFails = true;
  await fleetBackup.restoreFleetBackup('a', OLD);
  expect(fleetBackup.getFleetRestoreError('a')).toContain('a manager restart drops it');
  tmp.saveFails = false;
  const reg = readReg();
  delete reg.instances.a.maintenance;
  reg.instances.a.status = 'stopped';
  writeReg(reg);
  tmp.mode = 'reseed';
};
const finished = async () => {
  for (let i = 0; i < 500; i++) {
    const seed = containerManager.getBot('a')?.fleetDbReplicaSeed;
    if (!seed || seed.parked) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('the seed did not settle');
};

describe('L5 fix: the held restore notice across a stale-primary re-seed', () => {
  it('a failed retire keeps the notice the registry could not save', async () => {
    await holdNotice();
    tmp.retireFail = true;
    expect(reseedStalePrimary(containerManager.getBot('a')!, CODE, 'standby.invalid', 5440, true)).toMatchObject({ success: true });
    await finished();
    expect(containerManager.getBot('a')?.fleetDb).toBeTruthy();
    expect(fleetBackup.getFleetRestoreError('a')).toContain('a manager restart drops it');
    expect(fleetBackup.shownRestoreNoticeFile('a')).toBe(OLD);
  });

  it('a retire that succeeds forgets the held notice, so a database record written back shows none', async () => {
    await holdNotice();
    expect(reseedStalePrimary(containerManager.getBot('a')!, CODE, 'standby.invalid', 5440, true)).toMatchObject({ success: true });
    await finished();
    const reg = readReg();
    expect(reg.instances.a.fleetDb).toBeUndefined();
    reg.instances.a.fleetDb = primary;
    delete reg.instances.a.fleetRestoreError;
    writeReg(reg);
    expect(fleetBackup.shownRestoreNoticeFile('a')).toBeNull();
    expect(fleetBackup.getFleetRestoreError('a')).toBeNull();
  });
});
