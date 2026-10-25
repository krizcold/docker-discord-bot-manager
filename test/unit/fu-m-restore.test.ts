import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'fu-m-r-'));
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
  lifts: [] as boolean[],
  strips: [] as boolean[],
  existsFail: false,
  sweepFail: false,
  dropFail: "",
  refuseFailedNotice: false,
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
    updateInstanceFleetRestoreError: (id: string, notice: { file: string; text: string } | null) => {
      if (pg.refuseFailedNotice && notice && / failed: /.test(notice.text)) throw new Error("EACCES: instances.json");
      return real.updateInstanceFleetRestoreError(id, notice);
    },
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
    if (sql.includes('ALTER SYSTEM RESET')) { pg.events.push('lift'); return (pg.lifts.length > 0 ? pg.lifts.shift() : pg.liftOk) ? cb(null, '', '') : cb(new Error('lift'), '', 'ERROR: lift'); }
    if (args[0] === 'run' && sql.includes('postgresql.auto.conf')) { pg.events.push('strip'); return pg.strips.shift() !== false ? cb(null, '', '') : cb(new Error('docker'), '', 'docker down'); }
    if (sql.includes('SHOW default_transaction_read_only')) return cb(null, 'off\n', '');
    if (sql.includes('FROM pg_database WHERE datname')) return pg.existsFail ? cb(new Error('psql'), '', 'psql: error: server closed the connection') : cb(null, '1\n', '');
    if (sql.includes("to_regclass('smdb_control.term')")) return cb(null, 't|t\n', '');
    if (sql.includes('SELECT coalesce(GREATEST(')) return cb(null, '7\n', '');
    if (sql.includes("to_regclass('smdb_data.guild_ownership')")) return cb(null, 't\n', '');
    if (sql.includes('UPDATE smdb_data.guild_ownership')) { pg.events.push('raise'); return cb(null, 'g1\n', ''); }
    if (sql.includes('UPDATE smdb_control.term')) return cb(null, '1\n', '');
    if (sql.includes('DROP DATABASE')) { pg.events.push('drop'); if (pg.dropFail) return cb(new Error('psql'), '', pg.dropFail); }
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
  const withFence = (await import('./fence-fake')).withFence(execFile as any);
  const fencedExecFile = (cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (err: Error | null, stdout: string, stderr: string) => void;
    if (pg.sweepFail && args.join(' ').includes('pg_terminate_backend')) return cb(new Error('psql'), '', 'psql: error: the session sweep failed');
    return withFence(cmd, args, optsOrCb, maybeCb);
  };
  return { ...real, execFile: fencedExecFile, exec, spawn, default: { ...real, execFile: fencedExecFile, exec, spawn } };
});

import * as fs from 'fs';
import * as path from 'path';
import * as fleetBackup from '../../src/instance/fleetBackup';

const SECRET = 'tok-S3CRET-fu-m';
const DIR = path.join(tmp.dir, 'backups', 'a', 'fleet-postgres');
const primary = { containerName: 'bot-a-postgres', user: 'app', db: 'app', volume: 'bot-a-pgdata' };

beforeEach(() => {
  pg.events.length = 0;
  pg.live = { a: ['bot-a-app'], w: ['bot-w-app'] };
  pg.onSpawn = null;
  pg.liftOk = true;
  pg.lifts = [];
  pg.strips = [];
  pg.existsFail = false;
  pg.sweepFail = false;
  pg.dropFail = "";
  pg.refuseFailedNotice = false;
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, 'old.dump'), 'dump');
  fleetBackup.clearTermFloor('a');
  fleetBackup.dismissFleetRestoreError('a');
  fs.writeFileSync(path.join(tmp.dir, 'instances.json'), JSON.stringify({ instances: {
    a: { id: 'a', displayName: 'a', sanitizedName: 'bot-a', status: 'running', updateToken: SECRET, sourceUrl: 'https://example.invalid/fake/app', fleetDb: primary, fleetBackup: { enabled: false, hour: 4, keep: 7 } },
    w: { id: 'w', displayName: 'w', status: 'running', sourceUrl: 'https://example.invalid/fake/app' },
  } }, null, 2));
  fs.mkdirSync(path.join(tmp.dir, 'bots', 'a'), { recursive: true });
});
afterAll(() => { fs.rmSync(tmp.dir, { recursive: true, force: true }); });

describe('FU-M: a failed restore shows its notice with the record secrets as ***', () => {
  for (const refused of [false, true]) {
    it(refused ? 'when the registry refuses the notice' : 'when the registry saves the notice', async () => {
      pg.dropFail = `psql: error: password authentication failed for postgres://app:${SECRET}@bot-a-postgres/app`;
      pg.refuseFailedNotice = refused;
      const r = await fleetBackup.restoreFleetBackup('a', 'old.dump');
      expect(r.success).toBe(false);
      const card = fleetBackup.getFleetRestoreError('a')!;
      expect(card).toMatch(/^Restore of old.dump failed: could not recreate the database/);
      expect(card).toContain('***');
      expect(card).not.toContain(SECRET);
      if (refused) expect(card).toMatch(/this notice is not saved/);
    });
  }
});
