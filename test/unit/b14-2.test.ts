import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vm from 'vm';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b14-2-'));
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
vi.mock('../../src/instance/appLifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appLifecycle')>()),
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
  return { ...real, execFile, execFileSync, exec, spawn, default: { ...real, execFile, execFileSync, exec, spawn } };
});

import * as fs from 'fs';
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
    a: { id: 'a', displayName: 'a', status: 'stopped', sourceUrl: 'https://example.invalid/fake/app', fleetDb: primary, fleetBackup: { enabled: false, hour: 4, keep: 7 } },
    w: { id: 'w', sanitizedName: 'bot-w', displayName: 'w', status: 'running', sourceUrl: 'https://example.invalid/fake/app' },
  } }, null, 2));
  fs.mkdirSync(path.join(tmp.dir, 'bots', 'a'), { recursive: true });
});
afterAll(() => { fs.rmSync(tmp.dir, { recursive: true, force: true }); });

const at = (event: string) => pg.events.indexOf(event);

describe('R1-J37: a safety dump is on disk before it is reported', () => {
  it('syncs the dump file before the rename and its folder after', async () => {
    const r = await fleetBackup.runFleetDump(containerManager.getBot('a')!, 'pre-restore-');
    expect(r.success).toBe(true);
    const final = path.join(DIR, r.file!);
    expect(pg.events).toContain(`fsync:${final}.tmp`);
    expect(at(`fsync:${final}.tmp`)).toBeLessThan(at(`rename:${final}`));
    expect(at(`fsync:${DIR}`)).toBeGreaterThan(at(`rename:${final}`));
  });
});

describe('R8-J6: the restore takes its safety dump under the write fence', () => {
  it('stops the writers, fences, dumps, then drops', async () => {
    const r = await fleetBackup.restoreFleetBackup('a', 'old.dump');
    expect(r.success).toBe(true);
    expect(r.steps.preRestoreDump).toMatch(/^pre-restore-/);
    expect(at('stop:w')).toBeGreaterThanOrEqual(0);
    expect(at('stop:w')).toBeLessThan(at('fence'));
    expect(at('fence')).toBeLessThan(at('dump'));
    expect(at('dump')).toBeLessThan(at('drop'));
  });

  it('a failed fence refuses before any dump or drop, and restarts the writers', async () => {
    pg.fenceFails = true;
    const r = await fleetBackup.restoreFleetBackup('a', 'old.dump');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/fence/);
    expect(pg.events).not.toContain('dump');
    expect(pg.events).not.toContain('drop');
    expect(r.steps.restarted).toEqual(['w']);
  });

  it('a failed dump under the fence refuses, lifts the fence and restarts the writers', async () => {
    pg.dumpFails = true;
    const r = await fleetBackup.restoreFleetBackup('a', 'old.dump');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Pre-restore dump failed, restore refused/);
    expect(at('fence')).toBeLessThan(at('dump'));
    expect(at('lift')).toBeGreaterThan(at('dump'));
    expect(pg.events).not.toContain('drop');
    expect(r.steps.restarted).toEqual(['w']);
    expect(fs.readdirSync(DIR).filter(f => f.startsWith('pre-restore-'))).toEqual([]);
  });

  it('a refusal that cannot restart a stopped instance names it and does not say nothing was changed', async () => {
    pg.dumpFails = true;
    pg.startFails = true;
    const r = await fleetBackup.restoreFleetBackup('a', 'old.dump');
    expect(r.success).toBe(false);
    expect(r.steps.restarted).toEqual([]);
    expect(r.error).not.toMatch(/nothing was changed/);
    expect(r.error).toMatch(/stopped and could not be restarted: w/);
  });

  it('a stuck fence after a refused restore names a restore as the retry', async () => {
    pg.dumpFails = true;
    pg.liftFails = true;
    const r = await fleetBackup.restoreFleetBackup('a', 'old.dump');
    expect(r.error).toMatch(/running a restore again retries the lift/);
    expect(fleetBackup.getFleetFenceStuck('a')).toMatch(/running the restore again retries the lift/);
  });
});

describe('R8-J6: the decommission takes its safety dump under the write fence', () => {
  it('fences, dumps, then retires', async () => {
    const r = await decommissionFleetDb('a');
    expect(r.success).toBe(true);
    expect(r.dumpFile).toMatch(/^pre-decommission-/);
    expect(at('fence')).toBeGreaterThan(at('sidecar-up'));
    expect(at('fence')).toBeLessThan(at('dump'));
    expect(at('dump')).toBeLessThan(at('retire'));
  });

  it('a failed fence refuses with nothing destroyed and nothing dumped', async () => {
    pg.fenceFails = true;
    const r = await decommissionFleetDb('a');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/nothing was destroyed/);
    expect(r.error).toMatch(/fence/);
    expect(pg.events).not.toContain('dump');
    expect(pg.events).not.toContain('retire');
  });

  it('a failed dump under the fence refuses and lifts the fence', async () => {
    pg.dumpFails = true;
    const r = await decommissionFleetDb('a');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/nothing was destroyed/);
    expect(at('lift')).toBeGreaterThan(at('dump'));
    expect(pg.events).not.toContain('retire');
  });

  it('a failed teardown lifts the fence from the database it left standing', async () => {
    pg.retireFails = true;
    const r = await decommissionFleetDb('a');
    expect(r.success).toBe(false);
    expect(r.dumpFile).toMatch(/^pre-decommission-/);
    expect(at('lift')).toBeGreaterThan(at('retire'));
  });

  it('a fence stuck after a failed dump names a decommission, not a restore, as the retry', async () => {
    pg.dumpFails = true;
    pg.liftFails = true;
    const r = await decommissionFleetDb('a');
    expect(r.error).toMatch(/running the decommission again retries the lift/);
    expect(r.error).not.toMatch(/restore/);
    expect(fleetBackup.getFleetFenceStuck('a')).toMatch(/running the decommission again retries the lift/);
    expect(fleetBackup.getFleetFenceStuck('a')).not.toMatch(/restore/);
  });

  it('a fence stuck after a failed teardown names a decommission as the retry', async () => {
    pg.retireFails = true;
    pg.liftFails = true;
    const r = await decommissionFleetDb('a');
    expect(r.error).toMatch(/running the decommission again retries the lift/);
    expect(r.error).not.toMatch(/restore/);
  });
});

describe('R1-J37 and R8-J6: a stale-primary re-seed destroys only after a fenced dump', () => {
  const settled = async () => {
    for (let i = 0; i < 300 && !containerManager.getBot('a')?.fleetDbReplicaSeed?.parked; i++) await new Promise(r => setTimeout(r, 10));
    return containerManager.getBot('a')!;
  };
  const start = () => reseedStalePrimary(containerManager.getBot('a')!, 'postgresql://replicator:fakepass@primary.invalid:5433/app', pem, 'standby.invalid', 5440, true);

  it('fences, dumps, then retires, and the seed names the dump', async () => {
    expect(start()).toMatchObject({ success: true });
    const bot = await settled();
    expect(at('fence')).toBeLessThan(at('dump'));
    expect(at('dump')).toBeLessThan(at('retire'));
    const dump = bot.fleetDbReplicaSeed?.safetyDump;
    expect(dump).toMatch(/^pre-reseed-/);
    expect((await getFleetReplicaStatus(bot)).parkedSeed?.safetyDump).toBe(dump);
  });

  it('a failed dump parks the seed with the failure named and nothing retired', async () => {
    pg.dumpFails = true;
    expect(start()).toMatchObject({ success: true });
    const bot = await settled();
    expect(pg.events).not.toContain('retire');
    expect(at('lift')).toBeGreaterThan(at('dump'));
    expect(bot.fleetDbReplicaSeed?.committed).not.toBe(true);
    expect(bot.fleetDbReplicaSeed?.lastError).toMatch(/safety dump/);
    expect(bot.fleetDbReplicaSeed?.lastError).toMatch(/nothing was destroyed/);
  });

  it('a failed fence parks the seed before any dump or retire', async () => {
    pg.fenceFails = true;
    expect(start()).toMatchObject({ success: true });
    const bot = await settled();
    expect(pg.events).not.toContain('dump');
    expect(pg.events).not.toContain('retire');
    expect(bot.fleetDbReplicaSeed?.lastError).toMatch(/fence/);
  });

  it('a failed retire lifts the fence from the database it left standing', async () => {
    pg.retireFails = true;
    expect(start()).toMatchObject({ success: true });
    const bot = await settled();
    expect(at('lift')).toBeGreaterThan(at('retire'));
    expect(bot.fleetDbReplicaSeed?.lastError).toMatch(/could not retire/);
  });

  it('a fence stuck after a failed dump names a re-seed, not a restore, as the retry', async () => {
    pg.dumpFails = true;
    pg.liftFails = true;
    expect(start()).toMatchObject({ success: true });
    const bot = await settled();
    expect(bot.fleetDbReplicaSeed?.lastError).toMatch(/retrying the re-seed retries the lift/);
    expect(bot.fleetDbReplicaSeed?.lastError).not.toMatch(/restore/);
    expect(fleetBackup.getFleetFenceStuck('a')).toMatch(/retrying the re-seed retries the lift/);
    expect(fleetBackup.getFleetFenceStuck('a')).not.toMatch(/restore/);
  });
});

describe('R1-J37: the seed banner names the safety dump', () => {
  const pageHtml = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
  const start = pageHtml.indexOf('function seedDumpHtml(');
  const body = start < 0 ? '' : pageHtml.slice(start, pageHtml.indexOf('\n    }\n', start) + 6);
  const run = (seed: Record<string, unknown>): string => vm.runInNewContext(`${body}\nseedDumpHtml(seed)`, { seed, escapeHtml: (s: string) => s });

  it('names the dump kept with the backups', () => {
    expect(body).not.toBe('');
    expect(run({ safetyDump: 'pre-reseed-x.dump' })).toContain('pre-reseed-x.dump');
  });

  it('says nothing when no dump was taken', () => {
    expect(body).not.toBe('');
    expect(run({})).toBe('');
  });
});

describe('R8-J6: the confirms name the fenced dump', () => {
  const pageHtml = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
  const fn = (name: string) => pageHtml.slice(pageHtml.indexOf(`function ${name}(`), pageHtml.indexOf('\n    }\n', pageHtml.indexOf(`function ${name}(`)));
  for (const name of ['restoreFleetBackupFile', 'decommissionFleetDb', 'reseedStalePrimary']) {
    it(`${name} says the dump is taken under the write fence`, () => {
      expect(fn(name)).toMatch(/under a write fence/);
    });
  }
});
