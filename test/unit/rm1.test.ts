import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vm from 'vm';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'rm1-'));
  process.env.DATA_DIR = dir;
  return {
    dir,
    recovery: 't' as 't' | 'f',
    botRunning: true,
    dumpedFrom: [] as string[],
    retries: 0,
    fenced: new Map<string, boolean>(),
    liftWorks: false,
    onLift: null as null | ((container: string) => void),
    dumpFail: null as string | null,
    dumpHold: null as null | Promise<void>,
    seedView: null as null | ((instance: any) => any),
  };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const execFile = (_cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (err: Error | null, stdout: string, stderr: string) => void;
    const sql = args.join(' ');
    if (args[0] === 'inspect') {
      const name = String(args[args.length - 1]);
      return cb(null, name.includes('postgres') || name.includes('replica') || h.botRunning ? 'true\n' : 'false\n', '');
    }
    if (sql.includes('pg_is_in_recovery')) return cb(null, `${h.recovery}\n`, '');
    if (args[0] === 'exec' && sql.includes('SHOW default_transaction_read_only')) return cb(null, h.fenced.get(args[1]) ? 'on\n' : 'off\n', '');
    if (args[0] === 'exec' && sql.includes('ALTER SYSTEM RESET')) {
      h.onLift?.(args[1]);
      if (h.liftWorks) { h.fenced.set(args[1], false); return cb(null, '', ''); }
      return cb(new Error('lift refused'), '', 'ERROR: lift refused');
    }
    if (args[0] === 'run') return cb(new Error('strip refused'), '', 'strip refused');
    return cb(null, '', '');
  };
  const spawn = (cmd: string, args: string[], opts?: any) => {
    if (cmd !== 'docker') return real.spawn(cmd, args, opts);
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    if (args.includes('pg_dump')) h.dumpedFrom.push(args[1]);
    const fail = h.dumpFail;
    Promise.resolve(h.dumpHold).then(() => setTimeout(() => {
      child.stdout.end(fail ? '' : 'dump');
      child.stderr.end(fail || '');
      setTimeout(() => child.emit('close', fail ? 1 : 0), 5);
    }, 5));
    return child;
  };
  const fencedExecFile = (await import('./fence-fake')).withFence(execFile as any);
  return { ...real, execFile: fencedExecFile, spawn, default: { ...real, execFile: fencedExecFile, spawn } };
});

vi.mock('../../src/config/appCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/config/appCapabilities')>()),
  findAppCapabilities: () => ({ companionDb: { env: { url: 'DATABASE_URL' } } }),
}));
vi.mock('../../src/env/manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/env/manager')>()),
  getEnvVars: () => ({ DATABASE_URL: 'postgresql://app:pw@bot-a-postgres:5432/app' }),
  getEnvVarsWithStatus: () => ({ vars: { DATABASE_URL: 'postgresql://app:pw@bot-a-postgres:5432/app' }, undecryptable: [], corrupt: false }),
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/instance/fleetReplica', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/instance/fleetReplica')>();
  return {
    ...real,
    seedView: (instance: any) => (h.seedView ? h.seedView(instance) : real.seedView(instance)),
    getFleetReplicaStatus: async () => ({ present: true }),
    retryHeldSeedRecords: () => { h.retries++; },
  };
});

import * as fs from 'fs';
import * as path from 'path';
import { fenceOwners } from './fence-fake';

const REGISTRY = path.join(h.dir, 'instances.json');
const DUMPS = path.join(h.dir, 'backups', 'a', 'fleet-postgres');
const primary = { containerName: 'bot-a-postgres', user: 'app', db: 'app', volume: 'bot-a-pgdata' };
const replica = {
  containerName: 'bot-a-replica', volume: 'bot-a-replica-data', user: 'app', db: 'app', slot: 's1',
  primaryHost: 'primary.example', primaryPort: 5432, publicHost: 'copy.example', hostPort: 15432, certHost: 'copy.example',
};
const hour = () => new Date().getHours();

function seed(record: Record<string, unknown>): void {
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { a: { id: 'a', displayName: 'a', sourceUrl: 'x', createdAt: new Date().toISOString(), ...record } } }, null, 2));
}
const dumpsNow = () => (fs.existsSync(DUMPS) ? fs.readdirSync(DUMPS).filter(f => f.endsWith('.dump')).sort() : []);

async function restartedManager(): Promise<typeof import('../../src/instance/fleetBackup')> {
  vi.resetModules();
  return import('../../src/instance/fleetBackup');
}

// Start the scheduler with its interval captured, so a test runs the tick by hand.
async function startedWithTick(fb: typeof import('../../src/instance/fleetBackup')): Promise<() => void> {
  let tick: () => void = () => {};
  const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void) => { tick = fn; return 0; }) as unknown as typeof setInterval);
  fb.startFleetBackupScheduler();
  spy.mockRestore();
  fb.stopFleetBackupScheduler();
  return tick;
}

async function tickOnce(tick: () => void, waitFor: string | null): Promise<string[]> {
  const lines: string[] = [];
  const spies = (['log', 'warn', 'error'] as const).map(k => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); }));
  try {
    tick();
    if (waitFor) await vi.waitFor(() => expect(lines.join('\n')).toContain(waitFor), { timeout: 3000 });
    else await new Promise(r => setTimeout(r, 150));
  } finally { spies.forEach(s => s.mockRestore()); }
  return lines;
}

beforeEach(() => {
  h.recovery = 't';
  h.botRunning = true;
  h.dumpedFrom = [];
  h.retries = 0;
  h.fenced = new Map();
  h.liftWorks = false;
  h.onLift = null;
  h.dumpFail = null;
  h.dumpHold = null;
  h.seedView = null;
  fenceOwners.clear();
  fs.rmSync(DUMPS, { recursive: true, force: true });
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('RM1 F1: a copy in recovery gets its scheduled dump', () => {
  it('a copy in recovery whose bot is stopped is dumped', async () => {
    h.botRunning = false;
    seed({ fleetDbReplica: replica, fleetBackup: { enabled: true, hour: hour(), keep: 7 } });
    const fb = await restartedManager();
    await tickOnce(await startedWithTick(fb), '[FleetBackup] Dumped the copy');
    expect(h.dumpedFrom).toEqual(['bot-a-replica']);
    expect(dumpsNow()).toEqual([expect.stringMatching(/^standin-.*\.dump$/)]);
  });

  it('a copy in recovery whose app answers is dumped', async () => {
    seed({ fleetDbReplica: replica, fleetBackup: { enabled: true, hour: hour(), keep: 7 } });
    const fb = await restartedManager();
    await tickOnce(await startedWithTick(fb), '[FleetBackup] Dumped the copy');
    expect(h.dumpedFrom).toEqual(['bot-a-replica']);
    const info = fb.copyBackupInfo(JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')).instances.a);
    expect(info?.lastFile).toMatch(/^standin-/);
    expect(info?.lastError).toBeNull();
  });

  const pageHtml = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
  const fn = (name: string): string => {
    const start = pageHtml.indexOf(`function ${name}(`);
    return start < 0 ? '' : pageHtml.slice(start, pageHtml.indexOf('\n    }\n', start) + 6);
  };
  const body = fn('copyDumpHtml');
  const line = (info: unknown): string =>
    vm.runInNewContext(`${body}\ncopyDumpHtml(info)`, { info, escapeHtml: (s: string) => s });
  const info = (over: Record<string, unknown> = {}) => ({ enabled: true, hour: 4, keep: 7, lastAt: null, lastFile: null, stale: false, lastError: null, listError: null, ...over });

  it('the modal shows the copy dump line for a copy in recovery', () => {
    expect(pageHtml).toContain('${copyDumpHtml(res.copyBackup)}');
    expect(body).not.toMatch(/inRecovery|since|mode/);
    expect(line(info({ lastAt: Date.now() - 3600000, lastFile: 'standin-x.dump' }))).toContain('Last dump of this copy');
    expect(line(info())).toMatch(/no dump of this copy yet/i);
    expect(line(info({ lastError: 'pg_dump exited with code 1' }))).toContain('pg_dump exited with code 1');
  });

  it('a copy dump that conflicts with recovery records the error and is retried the next night', async () => {
    h.dumpFail = 'pg_dump: error: ERROR:  canceling statement due to conflict with recovery';
    seed({ fleetDbReplica: replica, fleetBackup: { enabled: true, hour: hour(), keep: 7 } });
    const fb = await restartedManager();
    const tick = await startedWithTick(fb);
    await tickOnce(tick, '[FleetBackup] Dump of the copy failed');
    expect(dumpsNow()).toEqual([]);
    const regA = () => JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')).instances.a;
    const failed = fb.copyBackupInfo(regA())!;
    expect(failed.lastError).toContain('canceling statement due to conflict with recovery');
    expect(line(failed)).toContain('canceling statement due to conflict with recovery');
    h.dumpFail = null;
    const realNow = Date.now.bind(Date);
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 24 * 3600000);
    try { await tickOnce(tick, '[FleetBackup] Dumped the copy'); } finally { spy.mockRestore(); }
    expect(dumpsNow()).toEqual([expect.stringMatching(/^standin-.*\.dump$/)]);
    expect(fb.copyBackupInfo(regA())?.lastError).toBeNull();
  });

  it('dumps off with a kept dump names that dump', () => {
    const out = line(info({ enabled: false, lastAt: Date.now() - 3600000, lastFile: 'standin-night1.dump' }));
    expect(out).toContain('standin-night1.dump');
    expect(out).toMatch(/Last dump of this copy/);
    expect(out).not.toMatch(/in no dump/);
    expect(out).not.toMatch(/writes|took/i);
  });

  it('dumps off with an unreadable backup folder makes no no-dump claim', () => {
    const listError = 'The backup folder for a could not be read: EACCES';
    const out = line(info({ enabled: false, listError }));
    expect(out).toContain(listError);
    expect(out).toMatch(/Scheduled dumps are off for this instance, so no further dumps run/);
    expect(out).not.toMatch(/in no dump/);
    expect(line(info({ enabled: false }))).toMatch(/in no dump this manager keeps/);
  });

  it('a cleared copy shows no scheduled-dump line', async () => {
    seed({ fleetDbReplica: { ...replica, copyCleared: true }, fleetBackup: { enabled: true, hour: 4, keep: 7 } });
    const fb = await restartedManager();
    const got = fb.copyBackupInfo(JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')).instances.a);
    expect(line(got)).toBe('');
  });
});

describe('RM1 F2: the scheduler tick writes held seed records again', () => {
  it('each tick calls retryHeldSeedRecords', async () => {
    seed({ fleetDbReplica: replica, fleetBackup: { enabled: false, hour: hour(), keep: 7 } });
    const fb = await restartedManager();
    const tick = await startedWithTick(fb);
    await tickOnce(tick, null);
    expect(h.retries).toBe(1);
    await tickOnce(tick, null);
    expect(h.retries).toBe(2);
  });

  it('the next interval calls the retry while a tick is still running', async () => {
    let release: () => void = () => {};
    h.dumpHold = new Promise<void>(res => { release = res; });
    seed({ fleetDbReplica: replica, fleetBackup: { enabled: true, hour: hour(), keep: 7 } });
    const fb = await restartedManager();
    const tick = await startedWithTick(fb);
    await tickOnce(tick, null);
    expect(h.dumpedFrom).toEqual(['bot-a-replica']);
    await tickOnce(tick, null);
    try {
      expect(h.retries).toBe(2);
    } finally {
      release();
      await vi.waitFor(() => expect(dumpsNow().length).toBe(1));
    }
  });
});

describe('RM1 F3: the primary and its copy keep separate stuck-fence warnings', () => {
  const OWNER = 'reseed:1';
  const copy = { containerName: 'bot-a-postgres-replica', user: 'app', db: 'app', volume: 'bot-a-pgreplica' };

  beforeEach(() => {
    h.fenced = new Map([[primary.containerName, true], [copy.containerName, true]]);
    fenceOwners.set(primary.containerName, OWNER);
    fenceOwners.set(copy.containerName, OWNER);
    seed({ fleetDb: primary, fleetDbReplica: copy, fleetBackup: { enabled: false, hour: 4, keep: 7 } });
  });

  it('a stuck fence shows on its own reader, never as a backup failure', async () => {
    const fb = await restartedManager();
    expect(await fb.liftLaneFence('a', primary, OWNER, 'a re-seed', 'x')).not.toBe('');
    expect(fb.getFleetFenceStuck('a')).toContain('READ-ONLY');
    expect(fb.getFleetBackupError('a')).toBeNull();
  });

  it('a lift on the copy leaves the primary\'s stuck-fence warning in place', async () => {
    const fb = await restartedManager();
    expect(await fb.liftLaneFence('a', primary, OWNER, 'a re-seed', 'x')).not.toBe('');
    expect(await fb.liftLaneFence('a', copy, OWNER, 'a re-seed', 'reseed')).not.toBe('');
    h.liftWorks = true;
    h.onLift = (c) => { if (c === primary.containerName) throw new Error('the primary must not be lifted here'); };
    expect(await fb.liftLaneFence('a', copy, OWNER, 'a re-seed', 'reseed')).toBe('');
    expect(fb.getFleetFenceStuck('a')).toContain('READ-ONLY');
  });

  it('a lift on the primary leaves the copy\'s warning, whichever stuck first', async () => {
    const fb = await restartedManager();
    expect(await fb.liftLaneFence('a', copy, OWNER, 'a re-seed', 'reseed')).not.toBe('');
    expect(await fb.liftLaneFence('a', primary, OWNER, 'a re-seed', 'x')).not.toBe('');
    h.liftWorks = true;
    h.onLift = (c) => { if (c === copy.containerName) throw new Error('the copy must not be lifted here'); };
    expect(await fb.liftLaneFence('a', primary, OWNER, 'a re-seed', 'x')).toBe('');
    expect(fb.getFleetFenceStuck('a')).toContain('reseed');
  });

  it('at start a fenced copy does not hide a primary also fenced', async () => {
    const fb = await restartedManager();
    fb.startFleetBackupScheduler();
    fb.stopFleetBackupScheduler();
    await vi.waitFor(() => expect(fb.getFleetFenceStuck('a')).toContain('The copy is READ-ONLY'));
    await vi.waitFor(() => expect(fb.getFleetFenceStuck('a')).toContain('The database is READ-ONLY'));
    h.fenced.set(copy.containerName, false);
    const tick = await startedWithTick(fb);
    tick();
    await vi.waitFor(() => expect(fb.getFleetFenceStuck('a')).not.toContain('The copy is READ-ONLY'));
    expect(fb.getFleetFenceStuck('a')).toContain('The database is READ-ONLY');
  });
});

describe('RM1 S1: the scheduled copy dump reads the seed as the modal does', () => {
  const rawSeed = { startedAt: Date.now(), phase: 'seeding', purpose: 'seed', updatedAt: Date.now() };

  it('a seed whose park write was refused gets its copy dumped', async () => {
    seed({ fleetDbReplica: replica, fleetDbReplicaSeed: rawSeed, fleetBackup: { enabled: true, hour: hour(), keep: 7 } });
    h.seedView = (i) => ({ ...i.fleetDbReplicaSeed, parked: true });
    const fb = await restartedManager();
    await tickOnce(await startedWithTick(fb), '[FleetBackup] Dumped the copy');
    expect(h.dumpedFrom).toEqual(['bot-a-replica']);
  });

  it('a finished seed whose clear was refused gets its copy dumped', async () => {
    seed({ fleetDbReplica: replica, fleetDbReplicaSeed: rawSeed, fleetBackup: { enabled: true, hour: hour(), keep: 7 } });
    h.seedView = () => null;
    const fb = await restartedManager();
    await tickOnce(await startedWithTick(fb), '[FleetBackup] Dumped the copy');
    expect(h.dumpedFrom).toEqual(['bot-a-replica']);
  });

  it('a running seed still holds the copy dump', async () => {
    seed({ fleetDbReplica: replica, fleetDbReplicaSeed: { ...rawSeed, parked: true }, fleetBackup: { enabled: true, hour: hour(), keep: 7 } });
    h.seedView = (i) => ({ ...i.fleetDbReplicaSeed, parked: false });
    const fb = await restartedManager();
    await tickOnce(await startedWithTick(fb), null);
    expect(h.dumpedFrom).toEqual([]);
  });
});
