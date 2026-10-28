import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vm from 'vm';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm2-l5b-restore-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

// Every docker and disk step the lanes take, in order.
const pg = vi.hoisted(() => ({
  events: [] as string[],
  fenceFails: false,
  dumpFails: false,
  retireFails: false,
  liftFails: false,
  startFails: false,
  volume: 'exists' as 'exists' | 'absent',
}));

// fsync of a folder cannot run on Windows, so a folder is synced through a stand-in file and logged under its own path.
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const opened = new Map<number, string>();
  const openSync = (file: any, ...rest: any[]) => {
    const target = String(file);
    let fd: number;
    if (real.existsSync(target) && real.statSync(target).isDirectory()) {
      const standIn = `${tmp.dir}/dir-stand-in`;
      real.writeFileSync(standIn, '');
      fd = real.openSync(standIn, 'r+');
    } else {
      fd = (real.openSync as any)(file, ...rest);
    }
    opened.set(fd, target);
    return fd;
  };
  const fsyncSync = (fd: number) => {
    pg.events.push(`fsync:${opened.get(fd)}`);
    return real.fsyncSync(fd);
  };
  const renameSync = (from: any, to: any) => {
    pg.events.push(`rename:${String(to)}`);
    return real.renameSync(from, to);
  };
  const patched = { openSync, fsyncSync, renameSync };
  return { ...real, ...patched, default: { ...real, ...patched } };
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
    runningInstanceContainers: async (id: string) => (real.getBot(id)?.status === 'running' && !pg.events.includes(`stop:${id}`) ? [`${id}-app`] : []),
    deployedComposeExists: () => true,
    startFleetDbSidecar: async () => { pg.events.push('sidecar-up'); return { success: true }; },
    stopBot: async (id: string) => { pg.events.push(`stop:${id}`); return { success: true }; },
    startBot: async (id: string) => {
      pg.events.push(`start:${id}`);
      if (pg.startFails) throw new Error('operation in progress');
      return { success: true };
    },
    retireFleetDbSidecar: async () => {
      pg.events.push('retire');
      return pg.retireFails ? { success: false, error: 'volume busy' } : { success: true };
    },
    applyFleetDbReplicaService: async () => ({ success: false, error: 'fake apply failure' }),
  };
});
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  capabilityRefusal: () => null,
}));

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = require('events') as typeof import('events');
  const { PassThrough } = require('stream') as typeof import('stream');
  const execFile = vi.fn((_cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (err: Error | null, stdout: string, stderr: string) => void;
    const sql = args.join(' ');
    if (args[0] === 'inspect') return cb(null, 'true\n', '');
    if (args[0] === 'volume' && args[1] === 'inspect') {
      if (args[args.length - 1].endsWith('-fleet-postgres-replica-data')) return cb(new Error('fail'), '', 'Error: No such volume');
      return pg.volume === 'exists' ? cb(null, '[]', '') : cb(new Error('fail'), '', 'Error: No such volume');
    }
    if (sql.includes('ALTER SYSTEM SET default_transaction_read_only = on')) {
      pg.events.push('fence');
      return pg.fenceFails ? cb(new Error('fence refused'), '', 'ERROR: fence refused') : cb(null, '0\n', '');
    }
    if (sql.includes('ALTER SYSTEM RESET')) { pg.events.push('lift'); return pg.liftFails ? cb(new Error('lift'), '', 'ERROR: lift refused') : cb(null, '', ''); }
    if (sql.includes('default_transaction_read_only/d')) return pg.liftFails ? cb(new Error('strip'), '', 'strip refused') : cb(null, '', '');
    if (sql.includes('SHOW default_transaction_read_only')) return cb(null, 'off\n', '');
    if (sql.includes('FROM pg_database WHERE datname')) return cb(null, '1\n', '');
    if (sql.includes('pg_control_system()')) return cb(null, '7001|2\n', '');
    if (sql.includes('to_regclass')) return cb(null, 'f\n', '');
    if (sql.includes('DROP DATABASE')) pg.events.push('drop');
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
    if (isDump) pg.events.push('dump');
    const code = isDump && pg.dumpFails ? 1 : 0;
    setTimeout(() => {
      child.stdout.end(isDump && !pg.dumpFails ? 'dump' : args.includes('SELECT pg_is_in_recovery()') ? 'f\n' : args.includes('IDENTIFY_SYSTEM') ? '7001|3|0/3000000|\n' : '');
      child.stderr.end(code ? 'pg_dump: error: connection lost' : '');
      setTimeout(() => child.emit('close', code), 5);
    }, 5);
    return child;
  });
  const execFileSync = (cmd: string, args: string[], opts: any) => {
    if (cmd === 'docker' && args[0] === 'volume' && args[1] === 'inspect' && args[args.length - 1].endsWith('-fleet-postgres-replica-data')) throw new Error('Error: No such volume');
    return real.execFileSync(cmd, args, opts);
  };
  const fencedExecFile = (await import('./fence-fake')).withFence((await import('./restore-fake')).withRestoreFakes(execFile as any));
  const heldSpawn = (await import('./dump-fake')).withDumpHolder((await import('./restore-fake')).withTocFake(spawn as any));
  return { ...real, execFile: fencedExecFile, execFileSync, exec, spawn: heldSpawn, default: { ...real, execFile: fencedExecFile, execFileSync, exec, spawn: heldSpawn } };
});

import * as fs from 'fs';
import { MAINTAINED } from './restore-fake';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as fleetBackup from '../../src/instance/fleetBackup';
import { decommissionFleetDb, getFleetReplicaStatus, reseedStalePrimary } from '../../src/instance/fleetReplica';

const REGISTRY = path.join(tmp.dir, 'instances.json');
const DIR = path.join(tmp.dir, 'backups', 'a', 'fleet-postgres');
const primary = { containerName: 'bot-a-postgres', user: 'app', db: 'app', volume: 'bot-a-pgdata' };
const pem = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----';

beforeEach(() => {
  pg.events.length = 0;
  pg.fenceFails = false;
  pg.dumpFails = false;
  pg.retireFails = false;
  pg.liftFails = false;
  pg.startFails = false;
  pg.volume = 'exists';
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, 'old.dump'), 'dump');
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: {
    a: { id: 'a', displayName: 'a', status: 'stopped', sourceUrl: 'https://example.invalid/fake/app', ...MAINTAINED, fleetDb: primary, fleetBackup: { enabled: false, hour: 4, keep: 7 } },
    w: { id: 'w', sanitizedName: 'bot-w', displayName: 'w', status: 'running', sourceUrl: 'https://example.invalid/fake/app' },
  } }, null, 2));
  fs.mkdirSync(path.join(tmp.dir, 'bots', 'a'), { recursive: true });
});
afterAll(() => { fs.rmSync(tmp.dir, { recursive: true, force: true }); });

describe('NM2 L5 b: a failed pre-restore dump', () => {
  it('stands as the main family error in the status', async () => {
    pg.dumpFails = true;
    const r = await fleetBackup.restoreFleetBackup('a', 'old.dump');
    expect(r.success).toBe(false);
    expect(fleetBackup.fleetBackupStatus(containerManager.getBot('a')!).main?.lastError).toMatch(/^Pre-restore dump failed: pg_dump exited with code 1: pg_dump: error: connection lost$/);
  });
});
