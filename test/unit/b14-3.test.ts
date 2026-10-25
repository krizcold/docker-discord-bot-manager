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
    posture: { read: 'ok', posture: null } as unknown,
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
  return { ...real, execFile, spawn, default: { ...real, execFile, spawn } };
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
vi.mock('../../src/instance/appLifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appLifecycle')>()),
  readStandInPosture: async () => h.posture,
}));
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
  h.posture = { read: 'ok', posture: null };
  h.dumpFail = null;
  h.probes = 0;
  fs.rmSync(DUMPS, { recursive: true, force: true });
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('R9-12: the scheduled dump follows the database\'s live role', () => {
  it('dumps a promoted copy under a standin- name', async () => {
    seed({ fleetDbReplica: replica, fleetBackup: { enabled: true, hour: hour(), keep: 7 } });
    await runOneTick('[FleetBackup] Dumped');
    expect(h.dumpedFrom).toEqual(['bot-a-replica']);
    const made = dumpsNow();
    expect(made.length).toBe(1);
    expect(made[0]).toMatch(/^standin-.*\.dump$/);
  });

  it('leaves a copy that is still in recovery alone', async () => {
    h.recovery = 't';
    seed({ fleetDbReplica: replica, fleetBackup: { enabled: true, hour: hour(), keep: 7 } });
    const { fb } = await runOneTick(null);
    expect(h.dumpedFrom).toEqual([]);
    expect(dumpsNow()).toEqual([]);
    expect(fb.copyBackupInfo(JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')).instances.a)?.lastError).toBeNull();
  });

  it('says it could not read the copy\'s role and dumps nothing', async () => {
    h.recovery = 'fail';
    seed({ fleetDbReplica: replica, fleetBackup: { enabled: true, hour: hour(), keep: 7 } });
    const { fb } = await runOneTick('[FleetBackup] ');
    expect(dumpsNow()).toEqual([]);
    const info = fb.copyBackupInfo(JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')).instances.a);
    expect(info?.lastError).toMatch(/could not read whether this copy takes writes/);
    expect(info?.lastError).toMatch(/no scheduled dump of it ran/);
  });

  it('does not dump a copy twice within the refire window', async () => {
    seed({ fleetDbReplica: replica, fleetBackup: { enabled: true, hour: hour(), keep: 7 } });
    seedDumps(['standin-2026-01-01T04-00-00-000Z.dump'], 0);
    fs.utimesSync(path.join(DUMPS, 'standin-2026-01-01T04-00-00-000Z.dump'), new Date(), new Date());
    await runOneTick(null);
    expect(h.dumpedFrom).toEqual([]);
  });

  it('skips a copy whose schedule is off', async () => {
    seed({ fleetDbReplica: replica, fleetBackup: { enabled: false, hour: hour(), keep: 7 } });
    await runOneTick(null);
    expect(h.dumpedFrom).toEqual([]);
  });
});

describe('R9-12: the trim keeps each family under the same keep', () => {
  it('the copy\'s trim keeps the newest standin- dumps and every primary dump', async () => {
    seed({ fleetDbReplica: replica, fleetBackup: { enabled: true, hour: hour(), keep: 2 } });
    const plain = ['2026-01-01T04-00-00-000Z.dump', '2026-01-02T04-00-00-000Z.dump', '2026-01-03T04-00-00-000Z.dump'];
    const copies = ['standin-2026-01-01T04-00-00-000Z.dump', 'standin-2026-01-02T04-00-00-000Z.dump', 'standin-2026-01-03T04-00-00-000Z.dump'];
    seedDumps([...plain, ...copies], 2);
    await runOneTick('[FleetBackup] Dumped');
    await vi.waitFor(() => expect(dumpsNow().filter(f => f.startsWith('standin-')).length).toBe(2), { timeout: 3000 });
    const now = dumpsNow();
    for (const f of plain) expect(now).toContain(f);
    expect(now).toContain('standin-2026-01-03T04-00-00-000Z.dump');
  });

  it('the primary\'s trim never deletes a standin- dump', async () => {
    seed({ fleetDb, fleetBackup: { enabled: true, hour: hour(), keep: 2 } });
    const plain = ['2026-01-01T04-00-00-000Z.dump', '2026-01-02T04-00-00-000Z.dump', '2026-01-03T04-00-00-000Z.dump'];
    const copies = ['standin-2026-01-01T04-00-00-000Z.dump', 'standin-2026-01-02T04-00-00-000Z.dump', 'standin-2026-01-03T04-00-00-000Z.dump'];
    seedDumps([...copies, ...plain], 2);
    await runOneTick('[FleetBackup] Dumped');
    await vi.waitFor(() => expect(dumpsNow().filter(f => !f.startsWith('standin-')).length).toBe(2), { timeout: 3000 });
    for (const f of copies) expect(dumpsNow()).toContain(f);
  });
});

describe('R9-12: the copy\'s last dump is reported', () => {
  it('names the newest standin- dump and calls one older than 36 hours stale', async () => {
    seed({ fleetDbReplica: replica, fleetBackup: { enabled: true, hour: 4, keep: 7 } });
    seedDumps(['standin-2026-01-01T04-00-00-000Z.dump', '2026-01-05T04-00-00-000Z.dump'], 1);
    const fb = await loadBackup();
    const info = fb.copyBackupInfo(JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')).instances.a)!;
    expect(info.lastFile).toBe('standin-2026-01-01T04-00-00-000Z.dump');
    expect(info.stale).toBe(true);
    expect(info.enabled).toBe(true);
  });

  it('a recent copy dump is not stale', async () => {
    seed({ fleetDbReplica: replica });
    seedDumps(['standin-2026-01-01T04-00-00-000Z.dump'], 0);
    fs.utimesSync(path.join(DUMPS, 'standin-2026-01-01T04-00-00-000Z.dump'), new Date(), new Date());
    const fb = await loadBackup();
    const info = fb.copyBackupInfo(JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')).instances.a)!;
    expect(info.stale).toBe(false);
    expect(info.lastAt).not.toBeNull();
  });

  it('GET /:id/fleet-replica carries the copy\'s backup info', async () => {
    seed({ fleetDbReplica: replica });
    seedDumps(['standin-2026-01-01T04-00-00-000Z.dump'], 1);
    vi.resetModules();
    const { createBotRoutes } = await import('../../src/webui/routes/bots');
    const router = createBotRoutes({ clients: new Set() } as any);
    const layer = (router as any).stack.find((l: any) => l.route?.path === '/:id/fleet-replica' && l.route.methods.get);
    const res: any = { statusCode: 200 };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    await layer.route.stack[layer.route.stack.length - 1].handle({ params: { id: 'a' }, query: {}, body: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.copyBackup?.lastFile).toBe('standin-2026-01-01T04-00-00-000Z.dump');
  });
});

describe('R9-12: the copy banner says when its last dump is stale', () => {
  const pageHtml = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
  const start = pageHtml.indexOf('function copyDumpHtml(');
  const body = start < 0 ? '' : pageHtml.slice(start, pageHtml.indexOf('\n    }\n', start) + 6);
  const run = (info: unknown, since: number | null = null): string =>
    vm.runInNewContext(`${body}\ncopyDumpHtml(info, since)`, { info, since, escapeHtml: (s: string) => s });
  const day = 86400000;

  it('calls a stale last dump stale', () => {
    expect(body).not.toBe('');
    const out = run({ enabled: true, hour: 4, keep: 7, lastAt: Date.now() - 3 * day, lastFile: 'standin-x.dump', stale: true, lastError: null });
    expect(out).toContain('error-message');
    expect(out).toMatch(/last dump of this copy/i);
    expect(out).toMatch(/more than 36 hours ago/);
  });

  it('names a fresh last dump', () => {
    const out = run({ enabled: true, hour: 4, keep: 7, lastAt: Date.now() - 3600000, lastFile: 'standin-x.dump', stale: false, lastError: null });
    expect(out).toMatch(/last dump of this copy/i);
    expect(out).not.toContain('error-message');
  });

  it('says no dump exists yet, and stale once the copy has taken writes for 36 hours', () => {
    expect(run({ enabled: true, hour: 4, keep: 7, lastAt: null, lastFile: null, stale: false, lastError: null })).toMatch(/no dump of this copy yet/i);
    expect(run({ enabled: true, hour: 4, keep: 7, lastAt: null, lastFile: null, stale: false, lastError: null }, Date.now() - 2 * day)).toContain('error-message');
  });

  it('says scheduled dumps are off', () => {
    expect(run({ enabled: false, hour: 4, keep: 7, lastAt: null, lastFile: null, stale: false, lastError: null })).toMatch(/off/);
  });

  it('shows the last failure', () => {
    expect(run({ enabled: true, hour: 4, keep: 7, lastAt: null, lastFile: null, stale: false, lastError: 'pg_dump exited with code 1' })).toContain('pg_dump exited with code 1');
  });

  it('shows the last failure and an unreadable backup folder together', () => {
    const out = run({ enabled: true, hour: 4, keep: 7, lastAt: null, lastFile: null, stale: false, lastError: 'pg_dump exited with code 1', listError: 'The backup folder for a could not be read: EACCES' });
    expect(out).toContain('pg_dump exited with code 1');
    expect(out).toContain('EACCES');
    expect(out).not.toMatch(/no dump of this copy yet/i);
    expect(out).toContain('The next scheduled dump runs at 04:00.');
    const old = run({ enabled: true, hour: 4, keep: 7, lastAt: null, lastFile: null, stale: false, lastError: null, listError: 'The backup folder for a could not be read: EIO' }, Date.now() - 3 * day);
    expect(old).not.toMatch(/no dump of this copy yet|in no dump/i);
    expect(old).toContain('EIO');
  });
});

const standIn = (over: Record<string, unknown> = {}) => ({
  role: 'stand-in', live: true, standInNodeId: 'node-b', coveringNodeId: 'node-a', holdsWrites: false,
  since: Date.now() - 3 * 86400000, gate: null, disarmReason: null, holdReason: null, namesThisNode: null, followsDelivered: null, ...over,
});
const regA = () => JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')).instances.a;
const nextNight = () => {
  const realNow = Date.now.bind(Date);
  return vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 24 * 3600000);
};

const banner = (() => {
  const pageHtml = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
  const fn = (name: string): string => {
    const start = pageHtml.indexOf(`function ${name}(`);
    return start < 0 ? '' : pageHtml.slice(start, pageHtml.indexOf('\n    }\n', start) + 6);
  };
  const bodies = fn('copyDumpHtml') + '\n' + fn('copyDumpLineHtml');
  return {
    bodies,
    line: (r: unknown, standing: unknown, info: unknown): string =>
      vm.runInNewContext(`${bodies}\ncopyDumpLineHtml(r, standing, info)`, { r, standing, info, escapeHtml: (s: string) => s }),
  };
})();

describe('B14-3 ruling: a copy in recovery is dumped while it stands in or its role cannot be read', () => {
  it('a read-only stand-in that is not streaming gets one standin- dump, trimmed to keep, primary dumps untouched', async () => {
    h.recovery = 't';
    h.posture = { read: 'ok', posture: standIn() };
    seed({ fleetDbReplica: replica, fleetBackup: { enabled: true, hour: hour(), keep: 2 } });
    const plain = ['2026-01-01T04-00-00-000Z.dump', '2026-01-02T04-00-00-000Z.dump', '2026-01-03T04-00-00-000Z.dump'];
    const copies = ['standin-2026-01-01T04-00-00-000Z.dump', 'standin-2026-01-02T04-00-00-000Z.dump'];
    seedDumps([...plain, ...copies], 2);
    await runOneTick('[FleetBackup] Dumped');
    expect(h.dumpedFrom).toEqual(['bot-a-replica']);
    await vi.waitFor(() => expect(dumpsNow().filter(f => f.startsWith('standin-')).length).toBe(2), { timeout: 3000 });
    const now = dumpsNow();
    for (const f of plain) expect(now).toContain(f);
    expect(now).toContain('standin-2026-01-02T04-00-00-000Z.dump');
    expect(now).not.toContain('standin-2026-01-01T04-00-00-000Z.dump');
  });

  it('a stand-in refused writes is dumped every night it stays so, the newest keep kept', async () => {
    h.recovery = 't';
    h.posture = { read: 'ok', posture: standIn({ gate: 'taking writes was refused: the copy is behind' }) };
    seed({ fleetDbReplica: replica, fleetBackup: { enabled: true, hour: hour(), keep: 2 } });
    seedDumps(['standin-2026-01-01T04-00-00-000Z.dump', 'standin-2026-01-02T04-00-00-000Z.dump'], 2);
    const { again } = await runOneTick('[FleetBackup] Dumped');
    const spy = nextNight();
    try { await again('[FleetBackup] Dumped'); } finally { spy.mockRestore(); }
    expect(h.dumpedFrom).toEqual(['bot-a-replica', 'bot-a-replica']);
    await vi.waitFor(() => expect(dumpsNow().length).toBe(2), { timeout: 3000 });
    expect(dumpsNow().some(f => f.startsWith('standin-2026-01-0'))).toBe(false);
  });

  it('a plain standby gets no dump, no copy error, and is probed again on the next tick', async () => {
    h.recovery = 't';
    seed({ fleetDbReplica: replica, fleetBackup: { enabled: true, hour: hour(), keep: 7 } });
    const { fb, again } = await runOneTick(null);
    await again(null);
    expect(h.dumpedFrom).toEqual([]);
    expect(h.probes).toBe(2);
    expect(fb.copyBackupInfo(regA())?.lastError).toBeNull();
  });

  it.each([
    ['a peer', { read: 'ok', posture: standIn({ role: 'peer', standInNodeId: null, holdsWrites: null, since: null }) }],
    ['a covered database', { read: 'ok', posture: standIn({ role: 'covered', holdsWrites: true, holdReason: 'behind' }) }],
    ['a copy re-seeded after an ended lane', { read: 'ok', posture: standIn({ live: false, holdsWrites: true, disarmReason: 'demoted' }) }],
    ['an app with no hooks', { read: 'none' }],
  ])('%s in recovery gets no dump', async (_name, posture) => {
    h.recovery = 't';
    h.posture = posture;
    seed({ fleetDbReplica: replica, fleetBackup: { enabled: true, hour: hour(), keep: 7 } });
    const { fb } = await runOneTick(null);
    expect(h.dumpedFrom).toEqual([]);
    expect(dumpsNow()).toEqual([]);
    expect(fb.copyBackupInfo(regA())?.lastError).toBeNull();
  });

  it('a copy in recovery whose app does not answer is dumped', async () => {
    h.recovery = 't';
    h.posture = { read: 'unanswered', error: 'the bot process is not running' };
    seed({ fleetDbReplica: replica, fleetBackup: { enabled: true, hour: hour(), keep: 7 } });
    await runOneTick('[FleetBackup] Dumped');
    expect(dumpsNow()).toEqual([expect.stringMatching(/^standin-.*\.dump$/)]);
  });

  it('a copy in recovery whose app does not answer is dumped when the last posture said stand-in', async () => {
    h.recovery = 't';
    h.posture = { read: 'unanswered', error: 'the bot process is not running' };
    seed({ fleetDbReplica: replica, fleetBackup: { enabled: true, hour: hour(), keep: 7 }, fleetLastPosture: { posture: standIn(), readAt: Date.now() - 3600000 } });
    await runOneTick('[FleetBackup] Dumped');
    expect(dumpsNow()).toEqual([expect.stringMatching(/^standin-.*\.dump$/)]);
  });

  it('a copy out of recovery whose app does not answer is dumped', async () => {
    h.posture = { read: 'unanswered', error: 'the instance is not running' };
    seed({ fleetDbReplica: replica, fleetBackup: { enabled: true, hour: hour(), keep: 7 } });
    await runOneTick('[FleetBackup] Dumped');
    expect(dumpsNow()).toEqual([expect.stringMatching(/^standin-.*\.dump$/)]);
  });

  it('a read-only stand-in whose dump conflicts with recovery records the error and is retried the next night', async () => {
    h.recovery = 't';
    h.posture = { read: 'ok', posture: standIn() };
    h.dumpFail = 'pg_dump: error: ERROR:  canceling statement due to conflict with recovery';
    seed({ fleetDbReplica: replica, fleetBackup: { enabled: true, hour: hour(), keep: 7 } });
    const { fb, again } = await runOneTick('[FleetBackup] Dump of the copy failed');
    expect(dumpsNow()).toEqual([]);
    const info = fb.copyBackupInfo(regA())!;
    expect(info.lastError).toContain('canceling statement due to conflict with recovery');
    expect(banner.line({ live: { running: true, inRecovery: true } }, standIn(), info)).toContain('canceling statement due to conflict with recovery');
    h.dumpFail = null;
    const spy = nextNight();
    try { await again('[FleetBackup] Dumped'); } finally { spy.mockRestore(); }
    expect(dumpsNow()).toEqual([expect.stringMatching(/^standin-.*\.dump$/)]);
    expect(fb.copyBackupInfo(regA())?.lastError).toBeNull();
  });

  it('a failed recovery probe dumps nothing and its error shows on the card whatever the recovery state', async () => {
    h.recovery = 'fail';
    seed({ fleetDbReplica: replica, fleetBackup: { enabled: true, hour: hour(), keep: 7 } });
    const { fb } = await runOneTick('[FleetBackup] ');
    expect(dumpsNow()).toEqual([]);
    const info = fb.copyBackupInfo(regA())!;
    expect(info.lastError).toMatch(/could not read whether this copy takes writes/);
    for (const live of [{ running: false }, { running: true, inRecovery: true }, {}]) {
      const out = banner.line({ live }, null, info);
      expect(out).toContain('could not read whether this copy takes writes');
      expect(out).toContain('error-message');
      expect(out).not.toMatch(/no dump of this copy yet|next scheduled dump/i);
    }
    expect(banner.line({}, null, info)).toContain('could not read whether this copy takes writes');
  });
});

describe('B14-3 ruling: the copy banner', () => {
  const info = (over: Record<string, unknown> = {}) => ({ enabled: true, hour: 4, keep: 7, lastAt: null, lastFile: null, stale: false, lastError: null, listError: null, ...over });

  it('a read-only stand-in with a stale last dump shows an error that claims no writes', () => {
    expect(banner.bodies).toContain('function copyDumpLineHtml(');
    const out = banner.line({ live: { running: true, inRecovery: true } }, standIn(),
      info({ lastAt: Date.now() - 3 * 86400000, lastFile: 'standin-x.dump', stale: true }));
    expect(out).toContain('error-message');
    expect(out).toMatch(/more than 36 hours ago/);
    expect(out).toMatch(/the data this copy holds/);
    expect(out).not.toMatch(/writes|took/i);
  });

  it('a read-only stand-in with no dump yet, standing in for 36 hours, shows an error that claims no writes', () => {
    const out = banner.line({ live: { running: true, inRecovery: true } }, standIn(), info());
    expect(out).toContain('error-message');
    expect(out).toMatch(/the data this copy holds/);
    expect(out).not.toMatch(/writes|took/i);
    expect(banner.line({ live: { running: true, inRecovery: true } }, standIn(), info({ enabled: false }))).not.toMatch(/writes|took/i);
  });

  it('a read-only stand-in with dumps off but a kept dump names that dump', () => {
    const out = banner.line({ live: { running: true, inRecovery: true } }, standIn(),
      info({ enabled: false, lastAt: Date.now() - 3600000, lastFile: 'standin-night1.dump' }));
    expect(out).toContain('standin-night1.dump');
    expect(out).toMatch(/Last dump of this copy/);
    expect(out).not.toMatch(/in no dump/);
    expect(out).not.toMatch(/writes|took/i);
  });

  it('dumps off with an unreadable backup folder makes no no-dump claim', () => {
    const listError = 'The backup folder for a could not be read: EACCES';
    const data = banner.line({ live: { running: true, inRecovery: true } }, standIn(), info({ enabled: false, listError }));
    expect(data).toContain(listError);
    expect(data).toMatch(/Scheduled dumps are off for this instance, so no further dumps run/);
    expect(data).not.toMatch(/in no dump/);
    const writes = banner.line({ live: { running: true, inRecovery: false } }, null, info({ enabled: false, listError }));
    expect(writes).toContain(listError);
    expect(writes).not.toMatch(/in no dump/);
    expect(banner.line({ live: { running: true, inRecovery: true } }, standIn(), info({ enabled: false }))).toMatch(/in no dump this manager keeps/);
  });

  it('a plain standby with no copy error shows no copy dump line', () => {
    expect(banner.line({ live: { running: true, inRecovery: true } }, null, info())).toBe('');
    expect(banner.line({ live: { running: true, inRecovery: true } }, standIn({ live: false, holdsWrites: true }), info())).toBe('');
  });

  it('a copy out of recovery still shows the writes wording', () => {
    const out = banner.line({ live: { running: true, inRecovery: false } }, null, info({ lastAt: Date.now() - 3 * 86400000, lastFile: 'standin-x.dump', stale: true }));
    expect(out).toMatch(/writes it took/);
  });
});
