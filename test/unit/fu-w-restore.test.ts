import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'fu-w-r-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

// The b20-3-restore fake. pg.fail names the one step whose docker call fails with a stderr that quotes the database
// password; every other step answers as a healthy database does.
const SECRET = 'Restore-Secret-0123456789';
const pg = vi.hoisted(() => ({
  fail: '' as '' | 'exists' | 'term' | 'drop' | 'pg_restore' | 'bump' | 'stop',
  stderr: '',
  liveOnce: [] as string[],
}));

vi.mock('../../src/config/appCapabilities', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/config/appCapabilities')>();
  return { ...real, findAppCapabilities: () => ({ companionDb: { env: { url: 'DATABASE_URL' } } }) };
});
vi.mock('../../src/env/manager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/env/manager')>();
  const url = 'postgres://app:Restore-Secret-0123456789@bot-a-postgres/app';
  return {
    ...real,
    getEnvVarsWithStatus: () => ({ vars: { DATABASE_URL: url }, corrupt: false, undecryptable: [] }),
    getEnvVars: () => ({ DATABASE_URL: url }),
  };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return {
    ...real,
    runningInstanceContainers: async () => pg.liveOnce.splice(0),
    startFleetDbSidecar: async () => ({ success: true }),
    stopBot: async () => ({ success: true }),
    startBot: async () => (pg.fail === 'stop' ? { success: false, error: `start failed: ${pg.stderr}` } : { success: true }),
  };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = require('events') as typeof import('events');
  const { PassThrough } = require('stream') as typeof import('stream');
  const execFile = vi.fn((_cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (err: Error | null, stdout: string, stderr: string) => void;
    const sql = args.join(' ');
    const failed = () => cb(Object.assign(new Error('docker failed'), { code: 1 }), '', pg.stderr);
    if (args[0] === 'inspect') return cb(null, 'true\n', '');
    if (sql.includes('ALTER SYSTEM SET default_transaction_read_only = on')) return cb(null, '0\n', '');
    if (sql.includes('SHOW default_transaction_read_only')) return cb(null, 'off\n', '');
    if (sql.includes('FROM pg_database WHERE datname')) return pg.fail === 'exists' ? failed() : cb(null, '1\n', '');
    if (sql.includes("to_regclass('smdb_control.term')")) return pg.fail === 'term' ? failed() : cb(null, 't|t\n', '');
    if (sql.includes('SELECT coalesce(GREATEST(')) return cb(null, '7\n', '');
    if (sql.includes("to_regclass('smdb_data.guild_ownership')")) return cb(null, 't\n', '');
    if (sql.includes('UPDATE smdb_data.guild_ownership')) return cb(null, 'g1\n', '');
    if (sql.includes('UPDATE smdb_control.term')) return pg.fail === 'bump' ? failed() : cb(null, '1\n', '');
    if (sql.includes('DROP DATABASE')) return pg.fail === 'drop' ? failed() : cb(null, '', '');
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
    const fails = kind === 'pg_restore' && pg.fail === 'pg_restore';
    setTimeout(() => {
      child.stdout.end(kind === 'dump' ? 'dump' : '');
      child.stderr.end(fails ? pg.stderr : '');
      setTimeout(() => child.emit('close', fails ? 1 : 0), 5);
    }, 5);
    return child;
  });
  const fencedExecFile = (await import('./fence-fake')).withFence(execFile as any);
  return { ...real, execFile: fencedExecFile, exec, spawn, default: { ...real, execFile: fencedExecFile, exec, spawn } };
});

import * as fs from 'fs';
import * as path from 'path';
import * as fleetBackup from '../../src/instance/fleetBackup';

const DIR = path.join(tmp.dir, 'backups', 'a', 'fleet-postgres');
const primary = { containerName: 'bot-a-postgres', user: 'app', db: 'app', volume: 'bot-a-pgdata' };
let logged: string[] = [];

beforeEach(() => {
  pg.fail = '';
  pg.liveOnce = [];
  pg.stderr = `psql: error: connection to "postgres://app:${SECRET}@bot-a-postgres/app" failed: FATAL: password authentication failed`;
  logged = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  }
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, 'old.dump'), 'dump');
  fleetBackup.clearTermFloor('a');
  fleetBackup.dismissFleetRestoreError('a');
  fs.writeFileSync(path.join(tmp.dir, 'instances.json'), JSON.stringify({ instances: {
    a: { id: 'a', displayName: 'a', sanitizedName: 'bot-a', status: 'running', sourceUrl: 'https://example.invalid/fake/app', fleetDb: primary, fleetBackup: { enabled: false, hour: 4, keep: 7 } },
  } }, null, 2));
  fs.mkdirSync(path.join(tmp.dir, 'bots', 'a'), { recursive: true });
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => { fs.rmSync(tmp.dir, { recursive: true, force: true }); });

async function restoreTexts() {
  const r = await fleetBackup.restoreFleetBackup('a', 'old.dump');
  return {
    r,
    texts: [r.error ?? '', r.warning ?? '', fleetBackup.getFleetRestoreError('a') ?? '', fleetBackup.getFleetFenceStuck('a') ?? '',
      fleetBackup.getFleetBackupError('a') ?? '', ...logged],
  };
}

describe('FU-W the restore passes every text built from docker stderr through the secret filter', () => {
  for (const step of ['exists', 'term', 'drop', 'pg_restore', 'bump', 'stop'] as const) {
    it(`a failed ${step} step names no secret in the reply, the notices or the logs`, async () => {
      pg.fail = step;
      if (step === 'stop') pg.liveOnce = ['bot-a-app'];
      const { r, texts } = await restoreTexts();
      const all = texts.join('\n');
      expect(all).toMatch(/password authentication failed/);
      expect(all).not.toContain(SECRET);
      expect(all).toMatch(/\*\*\*/);
      if (step !== 'bump' && step !== 'stop') expect(r.error ?? '').toMatch(/\*\*\*/);
    });
  }
});
