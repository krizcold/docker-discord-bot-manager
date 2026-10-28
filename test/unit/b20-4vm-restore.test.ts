import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b20-4vm-r-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

// Every step the restore takes, in order; live is what docker runs per instance, and onSpawn fires as pg_dump or pg_restore starts.
const pg = vi.hoisted(() => ({
  events: [] as string[],
  live: {} as Record<string, string[] | null>,
  onSpawn: null as ((kind: 'dump' | 'pg_restore') => void) | null,
  liftOk: true,
  strips: [] as boolean[],
  fenceOk: true,
  volume: 'exists' as 'exists' | 'absent' | 'unknown',
}));

vi.mock('../../src/config/appCapabilities', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/config/appCapabilities')>();
  return { ...real, findAppCapabilities: () => ({ companionDb: { env: { url: 'DATABASE_URL' } } }) };
});
vi.mock('../../src/env/manager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/env/manager')>();
  const urls: Record<string, string> = { a: 'postgres://app:pw@bot-a-postgres/app', w: 'postgres://app:pw@bot-a-postgres:5432/app' };
  return {
    ...real,
    getEnvVarsWithStatus: (id: string) => ({ vars: { DATABASE_URL: urls[id] ?? '' }, corrupt: false, undecryptable: [] }),
    getEnvVars: (id: string) => ({ DATABASE_URL: urls[id] ?? '' }),
  };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return {
    ...real,
    runningInstanceContainers: async (id: string) => (id in pg.live ? pg.live[id] : []),
    startFleetDbSidecar: async () => { pg.events.push('sidecar-up'); return { success: true }; },
    stopBot: async (id: string) => { pg.events.push(`stop:${id}`); pg.live[id] = []; return { success: true }; },
    startBot: async (id: string) => { pg.events.push(`start:${id}`); return { success: true }; },
  };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = require('events') as typeof import('events');
  const { PassThrough } = require('stream') as typeof import('stream');
  const execFile = vi.fn((_cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (err: Error | null, stdout: string, stderr: string) => void;
    const sql = args.join(' ');
    if (args[0] === 'inspect') return cb(null, 'true\n', '');
    if (args[0] === 'volume' && args[1] === 'inspect') {
      pg.events.push('volume');
      if (pg.volume === 'absent') return cb(new Error('docker'), '', `Error: No such volume: ${args[args.length - 1]}`);
      if (pg.volume === 'unknown') return cb(new Error('docker'), '', 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock');
      return cb(null, '[]\n', '');
    }
    if (sql.includes('ALTER SYSTEM SET default_transaction_read_only = on')) { pg.events.push('fence'); return pg.fenceOk ? cb(null, '0\n', '') : cb(new Error('fence'), '', 'Error response from daemon: No such container: bot-a-postgres'); }
    if (sql.includes('ALTER SYSTEM RESET')) { pg.events.push('lift'); return pg.liftOk ? cb(null, '', '') : cb(new Error('lift'), '', 'ERROR: lift'); }
    if (args[0] === 'run' && sql.includes('postgresql.auto.conf')) { pg.events.push('strip'); return pg.strips.shift() !== false ? cb(null, '', '') : cb(new Error('docker'), '', 'docker down'); }
    if (sql.includes('SHOW default_transaction_read_only')) return cb(null, 'off\n', '');
    if (sql.includes('FROM pg_database WHERE datname')) return cb(null, '1\n', '');
    if (sql.includes('SELECT coalesce(GREATEST(')) return cb(null, '7\n', '');
    if (sql.includes("to_regclass('smdb_data.guild_ownership')")) return cb(null, 't\n', '');
    if (sql.includes('UPDATE smdb_data.guild_ownership')) { pg.events.push('raise'); return cb(null, 'g1\n', ''); }
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
    const kind = args.includes('pg_dump') ? 'dump' : 'pg_restore';
    pg.events.push(kind);
    if (pg.onSpawn) pg.onSpawn(kind);
    setTimeout(() => {
      child.stdout.end(kind === 'dump' ? 'dump' : '');
      child.stderr.end('');
      setTimeout(() => child.emit('close', 0), 5);
    }, 5);
    return child;
  });
  const fencedExecFile = (await import('./fence-fake')).withFence((await import('./restore-fake')).withRestoreFakes(execFile as any));
  const heldSpawn = (await import('./dump-fake')).withDumpHolder((await import('./restore-fake')).withTocFake(spawn as any));
  return { ...real, execFile: fencedExecFile, exec, spawn: heldSpawn, default: { ...real, execFile: fencedExecFile, exec, spawn: heldSpawn } };
});

import * as fs from 'fs';
import { MAINTAINED } from './restore-fake';
import * as path from 'path';
import * as fleetBackup from '../../src/instance/fleetBackup';

const DIR = path.join(tmp.dir, 'backups', 'a', 'fleet-postgres');
const primary = { containerName: 'bot-a-postgres', user: 'app', db: 'app', volume: 'bot-a-pgdata' };

beforeEach(() => {
  pg.events.length = 0;
  pg.live = { a: ['bot-a-app'], w: ['bot-w-app'] };
  pg.onSpawn = null;
  pg.liftOk = true;
  pg.strips = [];
  pg.fenceOk = true;
  pg.volume = 'exists';
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, 'old.dump'), 'dump');
  fleetBackup.clearClaimFloor('a');
  fleetBackup.dismissFleetRestoreError('a');
  fs.writeFileSync(path.join(tmp.dir, 'instances.json'), JSON.stringify({ instances: {
    a: { id: 'a', displayName: 'a', sanitizedName: 'bot-a', status: 'running', sourceUrl: 'https://example.invalid/fake/app', ...MAINTAINED, fleetDb: primary, fleetBackup: { enabled: false, hour: 4, keep: 7 } },
    w: { id: 'w', displayName: 'w', status: 'running', sourceUrl: 'https://example.invalid/fake/app' },
  } }, null, 2));
  fs.mkdirSync(path.join(tmp.dir, 'bots', 'a'), { recursive: true });
});
afterAll(() => { fs.rmSync(tmp.dir, { recursive: true, force: true }); });

const restore = () => fleetBackup.restoreFleetBackup('a', 'old.dump');

describe('B20-4vm: a restore whose fence could not be applied names the volume state the lift found', () => {
  beforeEach(() => {
    pg.fenceOk = false;
    pg.liftOk = false;
  });

  it('says the volume is gone and no fence remains, with no stuck warning, when the volume is gone', async () => {
    pg.volume = 'absent';
    const r = await restore();
    expect(r.success).toBe(false);
    expect(pg.events).not.toContain('strip');
    expect(r.error).toMatch(/^Could not fence the database for the restore: /);
    expect(r.error).toMatch(/the database volume bot-a-pgdata is gone, so no write fence remains on it/);
    expect(r.error).not.toMatch(/READ-ONLY|stripped/);
    expect(fleetBackup.getFleetFenceStuck('a')).toBeNull();
  });

  it('says it cannot confirm, and names no strip, when docker does not answer the volume read', async () => {
    pg.volume = 'unknown';
    const r = await restore();
    expect(r.success).toBe(false);
    expect(pg.events).not.toContain('strip');
    expect(r.error).toMatch(/docker did not answer whether the database volume bot-a-pgdata exists, so this manager can't confirm whether the database is still READ-ONLY/);
    expect(r.error).not.toMatch(/could not be lifted or stripped/);
    expect(fleetBackup.getFleetFenceStuck('a')).toMatch(/can't confirm/);
  });

  it('keeps the strip-failed text when the volume exists and the strip fails', async () => {
    pg.strips = [false, false];
    const r = await restore();
    expect(r.error).toMatch(/the database may stay READ-ONLY \(a fence that could not be lifted or stripped survives a restart/);
  });
});
