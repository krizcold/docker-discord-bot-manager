import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vm from 'vm';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b14-3-'));
  process.env.DATA_DIR = dir;
  return {
    dir,
    recovery: 'f' as 't' | 'f' | 'fail',
    dumpedFrom: [] as string[],
    dumpFail: null as string | null,
    probes: 0,
  };
});

// A fake docker: every container runs, the copy answers pg_is_in_recovery with
// h.recovery, and a pg_dump writes a few bytes and exits 0.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const execFile = (_cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (err: Error | null, stdout: string, stderr: string) => void;
    if (args[0] === 'inspect') return cb(null, 'true\n', '');
    if (args.join(' ').includes('pg_is_in_recovery')) {
      h.probes++;
      return h.recovery === 'fail' ? cb(new Error('exit 2'), '', 'psql: error: connection refused') : cb(null, `${h.recovery}\n`, '');
    }
    return cb(null, '', '');
  };
  const spawn = (cmd: string, args: string[], opts?: any) => {
    if (cmd !== 'docker') return real.spawn(cmd, args, opts);
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    if (args.includes('pg_dump')) h.dumpedFrom.push(args[1]);
    const fail = args.includes('pg_dump') ? h.dumpFail : null;
    setTimeout(() => {
      child.stdout.end(fail ? '' : 'dump');
      child.stderr.end(fail ?? '');
      setTimeout(() => child.emit('close', fail ? 1 : 0), 5);
    }, 5);
    return child;
  };
  const heldSpawn = (await import('./dump-fake')).withDumpHolder(spawn as any);
  return { ...real, execFile, spawn: heldSpawn, default: { ...real, execFile, spawn: heldSpawn } };
});

vi.mock('../../src/config/appCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/config/appCapabilities')>()),
  findAppCapabilities: () => ({ companionDb: { env: { url: 'DATABASE_URL' } } }),
}));
vi.mock('../../src/env/manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/env/manager')>()),
  getEnvVars: () => ({ DATABASE_URL: 'postgresql://app:pw@bot-a-postgres:5432/app' }),
  getEnvVarsWithStatus: () => ({ vars: {}, undecryptable: [], corrupt: false }),
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/instance/fleetReplica', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetReplica')>()),
  getFleetReplicaStatus: async () => ({ present: true }),
}));

import * as fs from 'fs';
import * as path from 'path';

const REGISTRY = path.join(h.dir, 'instances.json');
const DUMPS = path.join(h.dir, 'backups', 'a', 'fleet-postgres');
const fleetDb = { containerName: 'bot-a-postgres', user: 'app', db: 'app', volume: 'bot-a-pgdata' };
const replica = {
  containerName: 'bot-a-replica', volume: 'bot-a-replica-data', user: 'app', db: 'app', slot: 's1',
  primaryHost: 'primary.example', primaryPort: 5432, publicHost: 'copy.example', hostPort: 15432, certHost: 'copy.example',
};
const hour = () => new Date().getHours();
const stampAgo = (hours: number) => new Date(Date.now() - hours * 3600000).toISOString().replace(/[:.]/g, '-');

function seed(record: Record<string, unknown>): void {
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { a: { id: 'a', displayName: 'a', sourceUrl: 'x', createdAt: new Date().toISOString(), ...record } } }, null, 2));
}

function seedDumps(names: string[], ageDays = 1): void {
  fs.mkdirSync(DUMPS, { recursive: true });
  names.forEach((name, i) => {
    const p = path.join(DUMPS, name);
    fs.writeFileSync(p, 'old');
    const t = (Date.now() - (ageDays + names.length - i) * 86400000) / 1000;
    fs.utimesSync(p, t, t);
  });
}
const dumpsNow = () => (fs.existsSync(DUMPS) ? fs.readdirSync(DUMPS).filter(f => f.endsWith('.dump')).sort() : []);

async function loadBackup(): Promise<typeof import('../../src/instance/fleetBackup')> {
  vi.resetModules();
  return import('../../src/instance/fleetBackup');
}

async function runOneTick(waitFor: string | null): Promise<{ fb: typeof import('../../src/instance/fleetBackup'); lines: string[]; again: (waitFor: string | null) => Promise<string[]> }> {
  const fb = await loadBackup();
  let tick: () => void = () => {};
  const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void) => { tick = fn; return 0; }) as unknown as typeof setInterval);
  fb.startFleetBackupScheduler();
  spy.mockRestore();
  fb.stopFleetBackupScheduler();
  const lines = await tickOnce(tick, waitFor);
  return { fb, lines, again: (w: string | null) => tickOnce(tick, w) };
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
  h.recovery = 'f';
  h.dumpedFrom = [];
  h.dumpFail = null;
  h.probes = 0;
  fs.rmSync(DUMPS, { recursive: true, force: true });
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('R9-12: the scheduled dump follows the database\'s live role', () => {
  it('dumps a promoted copy under a copy- name', async () => {
    seed({ fleetDbReplica: replica, fleetBackup: { enabled: true, hour: hour() } });
    await runOneTick('[FleetBackup] Dumped');
    expect(h.dumpedFrom).toEqual(['bot-a-replica']);
    const made = dumpsNow();
    expect(made.length).toBe(1);
    expect(made[0]).toMatch(/^copy-daily-.*\.dump$/);
  });

  it('does not dump a copy twice within the hour slot', async () => {
    seed({ fleetDbReplica: replica, fleetBackup: { enabled: true, hour: hour() } });
    seedDumps([`copy-daily-${stampAgo(0)}.dump`], 0);
    await runOneTick(null);
    expect(h.dumpedFrom).toEqual([]);
  });

  it('skips a copy whose schedule is off', async () => {
    seed({ fleetDbReplica: replica, fleetBackup: { enabled: false, hour: hour() } });
    await runOneTick(null);
    expect(h.dumpedFrom).toEqual([]);
  });
});

describe('R9-12: the trim keeps each family apart', () => {
  const plain = [`hourly-${stampAgo(60)}.dump`, `hourly-${stampAgo(59)}.dump`, `hourly-${stampAgo(58)}.dump`];
  const copies = [`copy-hourly-${stampAgo(60)}.dump`, `copy-hourly-${stampAgo(59)}.dump`, `copy-hourly-${stampAgo(58)}.dump`];

  it('the copy\'s trim deletes its own dumps past their keep and every primary dump stays', async () => {
    seed({ fleetDbReplica: replica, fleetBackup: { enabled: true, hour: hour() } });
    seedDumps([...plain, ...copies], 2);
    await runOneTick('[FleetBackup] Dumped');
    await vi.waitFor(() => expect(dumpsNow().filter(f => f.startsWith('copy-')).length).toBe(1), { timeout: 3000 });
    const now = dumpsNow();
    for (const f of plain) expect(now).toContain(f);
    for (const f of copies) expect(now).not.toContain(f);
  });

  it('the primary\'s trim never deletes a copy- dump', async () => {
    seed({ fleetDb, fleetBackup: { enabled: true, hour: hour() } });
    seedDumps([...copies, ...plain], 2);
    await runOneTick('[FleetBackup] Dumped');
    await vi.waitFor(() => expect(dumpsNow().filter(f => !f.startsWith('copy-')).length).toBe(1), { timeout: 3000 });
    for (const f of copies) expect(dumpsNow()).toContain(f);
  });
});

describe('R9-12: the copy\'s last dump is reported', () => {
  it('names the newest copy- dump, never a primary one', async () => {
    const copyFile = `copy-daily-${stampAgo(30)}.dump`;
    seed({ fleetDbReplica: replica, fleetBackup: { enabled: true, hour: 4 } });
    seedDumps([copyFile, `daily-${stampAgo(2)}.dump`], 1);
    const fb = await loadBackup();
    const info = fb.fleetBackupStatus(JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')).instances.a).copy!;
    expect(info.lastFile).toBe(copyFile);
    expect(info.enabled).toBe(true);
  });

  it('GET /:id/fleet-replica carries the copy\'s backup info', async () => {
    const copyFile = `copy-daily-${stampAgo(30)}.dump`;
    seed({ fleetDbReplica: replica });
    seedDumps([copyFile], 1);
    vi.resetModules();
    const { createBotRoutes } = await import('../../src/webui/routes/bots');
    const router = createBotRoutes({ clients: new Set() } as any);
    const layer = (router as any).stack.find((l: any) => l.route?.path === '/:id/fleet-replica' && l.route.methods.get);
    const res: any = { statusCode: 200 };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    await layer.route.stack[layer.route.stack.length - 1].handle({ params: { id: 'a' }, query: {}, body: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.copyBackup?.lastFile).toBe(copyFile);
  });
});

describe('R9-12: the copy banner names its last dump', () => {
  const pageHtml = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
  const fn = (name: string): string => {
    const start = pageHtml.indexOf(`function ${name}(`);
    return start < 0 ? '' : pageHtml.slice(start, pageHtml.indexOf('\n    }\n', start) + 6);
  };
  const copyFamilyFns = ['backupTime', 'backupTestHtml', 'backupAlertHtml', 'backupStatusHtml', 'copyDumpHtml'].map(fn).join('\n');
  const run = (info: unknown): string =>
    vm.runInNewContext(`${copyFamilyFns}\ncopyDumpHtml(info)`, { info, escapeHtml: (s: string) => s });
  const info = (over: Record<string, unknown> = {}) => ({ family: 'copy', role: 'live copy', enabled: true, hour: 4, paused: false, lastFile: null, lastAt: null, dataAt: null, lastError: null, failingSince: null, listError: null, test: null, alerts: { dumps: null, test: null }, ...over });

  it('names a fresh last dump', () => {
    const out = run(info({ lastAt: Date.now() - 3600000, lastFile: 'copy-hourly-x.dump' }));
    expect(out).toMatch(/last backup of this copy: copy-hourly-x\.dump/i);
    expect(out).not.toContain('error-message');
  });

  it('says no dump exists yet', () => {
    expect(run(info())).toMatch(/no backup yet/i);
  });

  it('says scheduled dumps are off', () => {
    expect(run(info({ enabled: false }))).toMatch(/off/);
  });

  it('shows the last failure', () => {
    expect(run(info({ lastError: 'pg_dump exited with code 1' }))).toContain('pg_dump exited with code 1');
  });

  it('shows the last failure and an unreadable backup folder together', () => {
    const out = run(info({ lastError: 'pg_dump exited with code 1', listError: 'The backup folder for a could not be read: EACCES' }));
    expect(out).toContain('pg_dump exited with code 1');
    expect(out).toContain('EACCES');
    expect(out).not.toMatch(/no backup yet/i);
    const old = run(info({ listError: 'The backup folder for a could not be read: EIO' }));
    expect(old).not.toMatch(/no backup yet/i);
    expect(old).toContain('EIO');
  });
});
