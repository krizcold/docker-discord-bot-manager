import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b21-1r-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

// The stale-primary re-seed with a fake docker: this database's identity (system id|timeline) and the pasted primary's IDENTIFY_SYSTEM answer.
const pg = vi.hoisted(() => ({
  events: [] as string[],
  local: '7001|2',
  primary: '7001|3|0/3000000|',
}));

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
    startFleetDbSidecar: async () => { pg.events.push('sidecar-up'); return { success: true }; },
    retireFleetDbSidecar: async () => { pg.events.push('retire'); return { success: true }; },
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
      return args[args.length - 1].endsWith('-fleet-postgres-replica-data') ? cb(new Error('fail'), '', 'Error: No such volume') : cb(null, '[]', '');
    }
    if (sql.includes('ALTER SYSTEM SET default_transaction_read_only = on')) { pg.events.push('fence'); return cb(null, '0\n', ''); }
    if (sql.includes('ALTER SYSTEM RESET')) { pg.events.push('lift'); return cb(null, '', ''); }
    if (sql.includes('SHOW default_transaction_read_only')) return cb(null, 'off\n', '');
    if (sql.includes('FROM pg_database WHERE datname')) return cb(null, '1\n', '');
    if (sql.includes('pg_control_system()')) return pg.local ? cb(null, `${pg.local}\n`, '') : cb(new Error('down'), '', 'psql: error: connection refused');
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
    if (isDump) pg.events.push('dump');
    const identify = args.includes('IDENTIFY_SYSTEM');
    if (identify) pg.events.push('identify');
    setTimeout(() => {
      child.stdout.end(isDump ? 'dump' : args.includes('SELECT pg_is_in_recovery()') ? 'f\n' : identify ? `${pg.primary}\n` : '');
      child.stderr.end('');
      setTimeout(() => child.emit('close', 0), 5);
    }, 5);
    return child;
  });
  const execFileSync = (cmd: string, args: string[], opts: any) => {
    if (cmd === 'docker' && args[0] === 'volume' && args[1] === 'inspect' && args[args.length - 1].endsWith('-fleet-postgres-replica-data')) throw new Error('Error: No such volume');
    return real.execFileSync(cmd, args, opts);
  };
  const fencedExecFile = (await import('./fence-fake')).withFence(execFile as any);
  const heldSpawn = (await import('./dump-fake')).withDumpHolder(spawn as any);
  return { ...real, execFile: fencedExecFile, execFileSync, exec, spawn: heldSpawn, default: { ...real, execFile: fencedExecFile, execFileSync, exec, spawn: heldSpawn } };
});

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import { reseedStalePrimary } from '../../src/instance/fleetReplica';

const REGISTRY = path.join(tmp.dir, 'instances.json');
const primary = { containerName: 'bot-a-postgres', user: 'app', db: 'app', volume: 'bot-a-pgdata' };
const pem = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----';

beforeEach(() => {
  pg.events.length = 0;
  pg.local = '7001|2';
  pg.primary = '7001|3|0/3000000|';
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: {
    a: { id: 'a', displayName: 'a', status: 'stopped', sourceUrl: 'https://example.invalid/fake/app', fleetDb: primary, fleetBackup: { enabled: false, hour: 4, keep: 7 } },
  } }, null, 2));
  fs.mkdirSync(path.join(tmp.dir, 'bots', 'a'), { recursive: true });
});
afterAll(() => { fs.rmSync(tmp.dir, { recursive: true, force: true }); });

const settled = async () => {
  for (let i = 0; i < 300 && !containerManager.getBot('a')?.fleetDbReplicaSeed?.parked; i++) await new Promise(r => setTimeout(r, 10));
  return containerManager.getBot('a')!;
};
const start = () => reseedStalePrimary(containerManager.getBot('a')!, 'postgresql://replicator:fakepass@primary.invalid:5433/app', pem, 'standby.invalid', 5440, true);

describe('R23-J3: the stale-primary re-seed compares the pasted primary with this database before the delete', () => {
  it('a primary that is a copy of this database on a later timeline is retired over', async () => {
    expect(start()).toMatchObject({ success: true });
    await settled();
    expect(pg.events.indexOf('dump')).toBeLessThan(pg.events.indexOf('identify'));
    expect(pg.events.indexOf('identify')).toBeLessThan(pg.events.indexOf('retire'));
  });

  it('a primary of a different cluster is refused after the dump and nothing is retired', async () => {
    pg.primary = '9009|3|0/3000000|';
    expect(start()).toMatchObject({ success: true });
    const bot = await settled();
    expect(pg.events).toContain('dump');
    expect(pg.events).not.toContain('retire');
    expect(pg.events).toContain('lift');
    expect(bot.fleetDbReplicaSeed?.committed).not.toBe(true);
    expect(bot.fleetDbReplicaSeed?.lastError).toMatch(/the pasted primary's database \(system id 9009\) is not a copy of this one \(system id 7001\)/);
    expect(bot.fleetDbReplicaSeed?.lastError).toMatch(/nothing was destroyed/);
  });

  it('a primary on a lower timeline is refused and nothing is retired', async () => {
    pg.local = '7001|4';
    expect(start()).toMatchObject({ success: true });
    const bot = await settled();
    expect(pg.events).not.toContain('retire');
    expect(bot.fleetDbReplicaSeed?.lastError).toMatch(/on timeline 3, below this database's timeline 4/);
  });

  it('a primary whose identity cannot be read is refused and nothing is retired', async () => {
    pg.primary = '';
    expect(start()).toMatchObject({ success: true });
    const bot = await settled();
    expect(pg.events).not.toContain('retire');
    expect(bot.fleetDbReplicaSeed?.lastError).toMatch(/the pasted primary's identity could not be read/);
  });

  it('a database whose own identity cannot be read is refused and nothing is retired', async () => {
    pg.local = '';
    expect(start()).toMatchObject({ success: true });
    const bot = await settled();
    expect(pg.events).not.toContain('retire');
    expect(bot.fleetDbReplicaSeed?.lastError).toMatch(/this database's identity could not be read/);
  });
});
