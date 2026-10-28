import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'fu-4-stop-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

// What docker runs (by instance), and every docker step the lanes take, in order.
const pg = vi.hoisted(() => ({
  events: [] as string[],
  live: {} as Record<string, string[] | null>,
  sticky: '',
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
    runningNonSidecarContainers: async (id: string) => (id in pg.live ? pg.live[id] : []),
    runningInstanceContainers: async (id: string) => (id in pg.live ? pg.live[id] : []),
    deployedComposeExists: () => true,
    startFleetDbSidecar: async () => { pg.events.push('sidecar-up'); return { success: true }; },
    // The real stop refuses an instance whose record is not running.
    stopBot: async (id: string) => {
      if (real.getBot(id)?.status !== 'running') return { success: false, error: 'Bot is not running' };
      pg.events.push(`stop:${id}`);
      pg.live[id] = [];
      return { success: true };
    },
    startBot: async (id: string) => { pg.events.push(`start:${id}`); return { success: true }; },
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
    if (args[0] === 'stop') {
      pg.events.push(`docker-stop:${args[args.length - 1]}`);
      for (const [id, names] of Object.entries(pg.live)) if (names) pg.live[id] = names.filter(n => n !== args[args.length - 1] || n === pg.sticky);
      return cb(null, '', '');
    }
    if (args[0] === 'inspect') return cb(null, 'true\n', '');
    if (args[0] === 'volume' && args[1] === 'inspect') {
      if (args[args.length - 1].endsWith('-fleet-postgres-replica-data')) return cb(new Error('fail'), '', 'Error: No such volume');
      return cb(null, '[]', '');
    }
    if (sql.includes('ALTER SYSTEM SET default_transaction_read_only = on')) { pg.events.push('fence'); return cb(null, '0\n', ''); }
    if (sql.includes('ALTER SYSTEM RESET')) { pg.events.push('lift'); return cb(null, '', ''); }
    if (sql.includes('SHOW default_transaction_read_only')) return cb(null, 'off\n', '');
    if (sql.includes('FROM pg_database WHERE datname')) return cb(null, '1\n', '');
    if (sql.includes('pg_control_system()')) return cb(null, '7001|2\n', '');
    if (sql.includes("to_regclass('smdb_control.term')")) return cb(null, 'f|f\n', '');
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
    setTimeout(() => {
      child.stdout.end(isDump ? 'dump' : args.includes('SELECT pg_is_in_recovery()') ? 'f\n' : args.includes('IDENTIFY_SYSTEM') ? '7001|3|0/3000000|\n' : '');
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
import * as fleetBackup from '../../src/instance/fleetBackup';
import { reseedStalePrimary } from '../../src/instance/fleetReplica';
import { certSource } from '../../src/instance/fleetJoin';
import { codeFor, fixtureCert } from './join-fake';

beforeEach(() => { certSource.fetch = fixtureCert; });

const REGISTRY = path.join(tmp.dir, 'instances.json');
const DIR = path.join(tmp.dir, 'backups', 'a', 'fleet-postgres');
const primary = { containerName: 'bot-a-postgres', user: 'app', db: 'app', volume: 'bot-a-pgdata' };

beforeEach(() => {
  pg.events.length = 0;
  pg.live = {};
  pg.sticky = '';
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, 'old.dump'), 'dump');
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: {
    a: { id: 'a', displayName: 'a', status: 'stopped', sourceUrl: 'https://example.invalid/fake/app', fleetDb: primary, fleetBackup: { enabled: false, hour: 4, keep: 7 } },
    w: { id: 'w', sanitizedName: 'bot-w', displayName: 'w', status: 'stopped', sourceUrl: 'https://example.invalid/fake/app' },
  } }, null, 2));
  fs.mkdirSync(path.join(tmp.dir, 'bots', 'a'), { recursive: true });
});
afterAll(() => { fs.rmSync(tmp.dir, { recursive: true, force: true }); });

const at = (event: string) => pg.events.indexOf(event);

describe('B14-2s: the restore stops what docker runs, whatever the record says', () => {
  it('stops a sharer whose record says stopped while docker runs it, before the fence, and starts it after', async () => {
    pg.live.w = ['bot-w-app'];
    const r = await fleetBackup.restoreFleetBackup('a', 'old.dump');
    expect(r.error).toBeUndefined();
    expect(r.success).toBe(true);
    expect(at('docker-stop:bot-w-app')).toBeGreaterThanOrEqual(0);
    expect(at('docker-stop:bot-w-app')).toBeLessThan(at('fence'));
    expect(r.steps.stopped).toEqual(['w']);
    expect(r.steps.restarted).toEqual(['w']);
  });

  it('refuses before the fence when docker still runs a container after the stop (bot-w-sticky survives)', async () => {
    pg.live.w = ['bot-w-app', 'bot-w-sticky'];
    pg.sticky = 'bot-w-sticky';
    const r = await fleetBackup.restoreFleetBackup('a', 'old.dump');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/bot-w-sticky/);
    expect(pg.events).not.toContain('fence');
    expect(pg.events).not.toContain('drop');
  });
});

describe('B14-2s: a stale-primary re-seed asks docker whether the instance runs', () => {
  const settled = async () => {
    for (let i = 0; i < 300 && !containerManager.getBot('a')?.fleetDbReplicaSeed?.parked; i++) await new Promise(r => setTimeout(r, 10));
    return containerManager.getBot('a')!;
  };
  const start = () => reseedStalePrimary(containerManager.getBot('a')!, codeFor('postgresql://replicator:fakepass@primary.invalid:5433/app'), 'standby.invalid', 5440, true);

  it('stops before the dump and the retire when docker runs the instance its record says is stopped', async () => {
    pg.live.a = ['bot-a-app'];
    expect(start()).toMatchObject({ success: true });
    const bot = await settled();
    expect(bot.fleetDbReplicaSeed?.lastError).toMatch(/bot-a-app/);
    expect(bot.fleetDbReplicaSeed?.lastError).toMatch(/nothing was destroyed/);
    expect(pg.events).not.toContain('sidecar-up');
    expect(pg.events).not.toContain('dump');
    expect(pg.events).not.toContain('retire');
  });

  it("says it can't confirm and destroys nothing when docker does not answer", async () => {
    pg.live.a = null;
    expect(start()).toMatchObject({ success: true });
    const bot = await settled();
    expect(bot.fleetDbReplicaSeed?.lastError).toMatch(/can't confirm/);
    expect(bot.fleetDbReplicaSeed?.lastError).toMatch(/nothing was destroyed/);
    expect(pg.events).not.toContain('dump');
    expect(pg.events).not.toContain('retire');
  });
});
