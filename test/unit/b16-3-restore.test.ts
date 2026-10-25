import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b16-3r-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

// Every step the restore takes, in order; live is what docker runs per instance, and onSpawn fires as pg_dump or pg_restore starts.
const pg = vi.hoisted(() => ({
  events: [] as string[],
  live: {} as Record<string, string[] | null>,
  onSpawn: null as ((kind: 'dump' | 'pg_restore') => void) | null,
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
    if (sql.includes('ALTER SYSTEM SET default_transaction_read_only = on')) { pg.events.push('fence'); return cb(null, '0\n', ''); }
    if (sql.includes('ALTER SYSTEM RESET')) { pg.events.push('lift'); return cb(null, '', ''); }
    if (sql.includes('SHOW default_transaction_read_only')) return cb(null, 'off\n', '');
    if (sql.includes('FROM pg_database WHERE datname')) return cb(null, '1\n', '');
    if (sql.includes("to_regclass('smdb_control.term')")) return cb(null, 't|t\n', '');
    if (sql.includes('SELECT coalesce(GREATEST(')) return cb(null, '7\n', '');
    if (sql.includes("to_regclass('smdb_data.guild_ownership')")) return cb(null, 't\n', '');
    if (sql.includes('UPDATE smdb_data.guild_ownership')) { pg.events.push('raise'); return cb(null, 'g1\n', ''); }
    if (sql.includes('UPDATE smdb_control.term')) return cb(null, '1\n', '');
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
  return { ...real, execFile, exec, spawn, default: { ...real, execFile, exec, spawn } };
});

import * as fs from 'fs';
import * as path from 'path';
import * as fleetBackup from '../../src/instance/fleetBackup';

const DIR = path.join(tmp.dir, 'backups', 'a', 'fleet-postgres');
const primary = { containerName: 'bot-a-postgres', user: 'app', db: 'app', volume: 'bot-a-pgdata' };

beforeEach(() => {
  pg.events.length = 0;
  pg.live = { a: ['bot-a-app'], w: ['bot-w-app'] };
  pg.onSpawn = null;
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, 'old.dump'), 'dump');
  fleetBackup.clearTermFloor('a');
  fleetBackup.dismissFleetRestoreError('a');
  fs.writeFileSync(path.join(tmp.dir, 'instances.json'), JSON.stringify({ instances: {
    a: { id: 'a', displayName: 'a', sanitizedName: 'bot-a', status: 'running', sourceUrl: 'https://example.invalid/fake/app', fleetDb: primary, fleetBackup: { enabled: false, hour: 4, keep: 7 } },
    w: { id: 'w', displayName: 'w', status: 'running', sourceUrl: 'https://example.invalid/fake/app' },
  } }, null, 2));
  fs.mkdirSync(path.join(tmp.dir, 'bots', 'a'), { recursive: true });
});
afterAll(() => { fs.rmSync(tmp.dir, { recursive: true, force: true }); });

const restore = () => fleetBackup.restoreFleetBackup('a', 'old.dump');

describe('R11-J7: a restore notices an instance started outside the manager while it runs', () => {
  it('a restore with nothing started meanwhile lifts the fence and restarts what it stopped', async () => {
    const r = await restore();
    expect(r.success).toBe(true);
    expect(pg.events).toContain('lift');
    expect(r.steps.restarted).toEqual(['a', 'w']);
  });

  it('an instance started before the drop refuses the restore, lifts the fence and drops nothing', async () => {
    pg.onSpawn = kind => { if (kind === 'dump') pg.live.w = ['bot-w-app']; };
    const r = await restore();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^An instance sharing the database was started outside the manager during the restore, so the restore was refused/);
    expect(r.error).toMatch(/bot-w-app runs now; stop it and keep it stopped \(also from CasaOS\) until the restore ends/);
    expect(pg.events).not.toContain('drop');
    expect(pg.events.lastIndexOf('lift')).toBeGreaterThan(pg.events.indexOf('fence'));
  });

  it('an instance started during pg_restore keeps the write fence on and says the dump was restored', async () => {
    pg.onSpawn = kind => { if (kind === 'pg_restore') pg.live.w = ['bot-w-app']; };
    const r = await restore();
    expect(r.success).toBe(false);
    expect(r.steps.restored).toBe(true);
    expect(r.error).toMatch(/^The dump was restored, but bot-w-app was started outside the manager during the restore/);
    expect(r.error).toMatch(/The write fence stays on .*so nothing writes to the restored database from what was read mid-restore/);
    expect(r.error).toMatch(/w runs now\. The write fence stays on and the stopped instances stay stopped \(a\)/);
    expect(r.error).not.toMatch(/stay stopped \([^)]*\bw\b/);
    expect(pg.events).not.toContain('lift');
    expect(pg.events.some(e => e.startsWith('start:'))).toBe(false);
    expect(fleetBackup.getFleetRestoreError('a')).toMatch(/bot-w-app was started outside the manager/);
  });

  it("docker not answering after pg_restore keeps the fence on and says it can't confirm", async () => {
    pg.onSpawn = kind => { if (kind === 'pg_restore') pg.live.w = null; };
    const r = await restore();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/can't confirm that none read it while it was rebuilt/);
    expect(pg.events).not.toContain('lift');
  });
});
