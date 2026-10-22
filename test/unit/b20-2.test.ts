import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b20-2-'));
  process.env.DATA_DIR = dir;
  return { dir };
});

const pg = vi.hoisted(() => ({
  fenced: new Map<string, boolean>(),
  down: new Set<string>(),
  liftWorks: false,
  onLift: null as null | ((container: string) => void),
  fenceFails: false,
  onRecreate: null as null | (() => void),
}));

vi.mock('../../src/config/appCapabilities', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/config/appCapabilities')>();
  return { ...real, findAppCapabilities: () => ({ companionDb: { env: { url: 'DATABASE_URL' } } }) };
});
vi.mock('../../src/env/manager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/env/manager')>();
  return {
    ...real,
    getEnvVarsWithStatus: () => ({ vars: { DATABASE_URL: 'postgres://h/app' }, corrupt: false, undecryptable: [] }),
    getEnvVars: () => ({ DATABASE_URL: 'postgres://h/app' }),
  };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return { ...real, runningNonSidecarContainers: async () => [], startFleetDbSidecar: async () => ({ success: true }) };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFile = vi.fn((_cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (err: Error | null, stdout: string, stderr: string) => void;
    const sql = args.join(' ');
    if (args[0] === 'inspect') return cb(null, pg.down.has(args[args.length - 1]) ? 'false\n' : 'true\n', '');
    if (args[0] === 'exec' && sql.includes('SHOW default_transaction_read_only')) return cb(null, pg.fenced.get(args[1]) ? 'on\n' : 'off\n', '');
    if (args[0] === 'exec' && sql.includes('ALTER SYSTEM RESET')) {
      pg.onLift?.(args[1]);
      if (pg.liftWorks) { pg.fenced.set(args[1], false); return cb(null, '', ''); }
      return cb(new Error('lift refused'), '', 'ERROR: lift refused');
    }
    if (args[0] === 'exec' && sql.includes('ALTER SYSTEM SET default_transaction_read_only = on')) {
      if (pg.fenceFails) return cb(new Error('fence refused'), '', 'ERROR: fence refused');
      pg.fenced.set(args[1], true); return cb(null, '0\n', '');
    }
    if (args[0] === 'exec' && sql.includes('FROM pg_database WHERE datname')) return cb(null, '0\n', '');
    // A manager restart during the restore: the recreate never answers.
    if (args[0] === 'exec' && sql.includes('DROP DATABASE')) { pg.onRecreate?.(); return; }
    if (args[0] === 'run') return cb(new Error('strip refused'), '', 'strip refused');
    return cb(null, '', '');
  });
  return { ...real, execFile, default: { ...real, execFile } };
});

import * as fs from 'fs';
import * as path from 'path';

const REGISTRY = path.join(tmp.dir, 'instances.json');
const primary = { containerName: 'bot-a-postgres', user: 'app', db: 'app', volume: 'bot-a-pgdata' };
const copy = { containerName: 'bot-a-postgres-replica', user: 'app', db: 'app', volume: 'bot-a-pgreplica' };

function seedRegistry(): void {
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { a: { id: 'a', displayName: 'a', fleetDb: primary, fleetDbReplica: copy, fleetBackup: { enabled: false, hour: 4, keep: 7 } } } }, null, 2));
}
const onDisk = () => JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')).instances.a;

// A fresh module graph is a manager restart: nothing held in memory survives it.
const blockSaves = () => fs.mkdirSync(`${REGISTRY}.tmp`);
const unblockSaves = () => fs.rmSync(`${REGISTRY}.tmp`, { recursive: true, force: true });

// Start the scheduler with its interval captured, so a test runs the tick by hand.
async function startedWithTick(fb: typeof import('../../src/instance/fleetBackup')): Promise<() => void> {
  let tick: () => void = () => {};
  const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void) => { tick = fn; return 0; }) as unknown as typeof setInterval);
  fb.startFleetBackupScheduler();
  spy.mockRestore();
  return tick;
}

async function restartedManager(): Promise<typeof import('../../src/instance/fleetBackup')> {
  vi.resetModules();
  return import('../../src/instance/fleetBackup');
}

beforeEach(() => {
  pg.fenced = new Map([[primary.containerName, true], [copy.containerName, true]]);
  pg.down = new Set();
  pg.liftWorks = false;
  pg.onLift = null;
  pg.fenceFails = false;
  pg.onRecreate = null;
  seedRegistry();
});
afterAll(() => { fs.rmSync(tmp.dir, { recursive: true, force: true }); });

describe('X26: one stuck-fence warning per database, and a foreign fence is not the failback\'s', () => {
  it('a lift on the copy leaves the primary\'s stuck-fence warning in place', async () => {
    const fb = await restartedManager();
    expect(await fb.liftConsentFence('a', primary, 'x')).toBe('failed');
    expect(await fb.liftConsentFence('a', copy, 'reseed')).toBe('failed');
    pg.liftWorks = true;
    pg.onLift = (c) => { if (c === primary.containerName) throw new Error('the primary must not be lifted here'); };
    expect(await fb.liftConsentFence('a', copy, 'reseed')).toBe('lifted');
    expect(fb.getFleetBackupError('a')).toContain('READ-ONLY');
  });

  it('a lift on the primary leaves the copy\'s warning, whichever stuck first', async () => {
    const fb = await restartedManager();
    expect(await fb.liftConsentFence('a', copy, 'reseed')).toBe('failed');
    expect(await fb.liftConsentFence('a', primary, 'x')).toBe('failed');
    pg.liftWorks = true;
    pg.onLift = (c) => { if (c === copy.containerName) throw new Error('the copy must not be lifted here'); };
    expect(await fb.liftConsentFence('a', primary, 'x')).toBe('lifted');
    expect(fb.getFleetBackupError('a')).toContain('reseed');
  });

  it('at start a fenced copy does not hide a primary also fenced', async () => {
    const fb = await restartedManager();
    fb.startFleetBackupScheduler();
    fb.stopFleetBackupScheduler();
    await vi.waitFor(() => expect(fb.getFleetBackupError('a')).toContain('The copy is READ-ONLY'));
    await vi.waitFor(() => expect(fb.getFleetBackupError('a')).toContain('The database is READ-ONLY'));
    // The copy comes back writable; the primary's warning stays.
    pg.fenced.set(copy.containerName, false);
    const tick = await startedWithTick(fb);
    fb.stopFleetBackupScheduler();
    tick();
    await vi.waitFor(() => expect(fb.getFleetBackupError('a')).not.toContain('The copy is READ-ONLY'));
    expect(fb.getFleetBackupError('a')).toContain('The database is READ-ONLY');
  });

  it('a foreign fence over a failback\'s stuck one passes it to that lane, so the re-armed run does not lift it', async () => {
    const fb = await restartedManager();
    expect(await fb.liftConsentFence('a', primary, 'x')).toBe('failed');
    expect(fb.failbackFenceLeft('a', primary.containerName)).toBe(true);
    fb.foreignFenceSet('a', primary.containerName);
    expect(fb.failbackFenceLeft('a', primary.containerName)).toBe(false);
    expect(onDisk().fleetConsentFenceLeft).toBeUndefined();
    const after = await restartedManager();
    expect(after.failbackFenceLeft('a', primary.containerName)).toBe(false);
  });

  it('a foreign fence whose record clear is refused still is not the failback\'s, and the clear lands later', async () => {
    const fb = await restartedManager();
    expect(await fb.liftConsentFence('a', primary, 'x')).toBe('failed');
    blockSaves();
    try { fb.foreignFenceSet('a', primary.containerName); } finally { unblockSaves(); }
    expect(fb.failbackFenceLeft('a', primary.containerName)).toBe(false);
    expect(onDisk().fleetConsentFenceLeft).toEqual([primary.containerName]);
    const tick = await startedWithTick(fb);
    fb.stopFleetBackupScheduler();
    tick();
    await vi.waitFor(() => expect(onDisk().fleetConsentFenceLeft).toBeUndefined());
  });

  it("a restore over a failback's stuck fence owns it from the moment it is set, not only from its lift", async () => {
    const fb = await restartedManager();
    expect(await fb.liftConsentFence('a', primary, 'x')).toBe('failed');
    expect(onDisk().fleetConsentFenceLeft).toEqual([primary.containerName]);
    const dir = path.join(tmp.dir, 'backups', 'a', 'fleet-postgres');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'x.dump'), 'dump');
    let atRecreate: { left: boolean; onDisk: unknown } | null = null;
    pg.onRecreate = () => { atRecreate = { left: fb.failbackFenceLeft('a', primary.containerName), onDisk: onDisk().fleetConsentFenceLeft }; };
    void fb.restoreFleetBackup('a', 'x.dump');
    await vi.waitFor(() => expect(atRecreate).not.toBeNull());
    expect(atRecreate).toEqual({ left: false, onDisk: undefined });
    const after = await restartedManager();
    expect(after.failbackFenceLeft('a', primary.containerName)).toBe(false);
  });

  async function quiesce(): Promise<{ fb: typeof import('../../src/instance/fleetBackup'); status: number }> {
    const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf-8'));
    reg.instances.a.recoveryChannel = { mode: 'source', token: 'tok' };
    fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2));
    const fb = await restartedManager();
    expect(await fb.liftConsentFence('a', primary, 'x')).toBe('failed');
    expect(fb.failbackFenceLeft('a', primary.containerName)).toBe(true);
    const rc = await import('../../src/instance/recoveryControl');
    rc.startRecoveryControlServer();
    await new Promise(r => setTimeout(r, 100));
    try {
      const res = await fetch(`http://127.0.0.1:${rc.RECOVERY_CONTROL_PORT}/control/quiesce`, { method: 'POST', headers: { 'x-recovery-token': 'tok' } });
      await res.text();
      return { fb, status: res.status };
    } finally { rc.stopRecoveryControlServer(); }
  }

  it('a recovery quiesce whose fence is set clears the failback record', async () => {
    const { fb } = await quiesce();
    expect(pg.fenced.get(primary.containerName)).toBe(true);
    expect(fb.failbackFenceLeft('a', primary.containerName)).toBe(false);
    expect(onDisk().fleetConsentFenceLeft).toBeUndefined();
  });

  it('a recovery quiesce whose fence fails keeps the failback record', async () => {
    pg.fenceFails = true;
    const { fb, status } = await quiesce();
    expect(status).toBe(500);
    expect(fb.failbackFenceLeft('a', primary.containerName)).toBe(true);
    expect(onDisk().fleetConsentFenceLeft).toEqual([primary.containerName]);
  });
});
