import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b20-1-'));
  process.env.DATA_DIR = dir;
  return { dir };
});

const pg = vi.hoisted(() => ({
  fenced: new Map<string, boolean>(),
  down: new Set<string>(),
  liftWorks: false,
  onLift: null as null | ((container: string) => void),
}));

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
    if (args[0] === 'exec' && sql.includes('ALTER SYSTEM SET default_transaction_read_only = on')) { pg.fenced.set(args[1], true); return cb(null, '0\n', ''); }
    if (args[0] === 'run') return cb(new Error('strip refused'), '', 'strip refused');
    return cb(null, '', '');
  });
  const fencedExecFile = (await import('./fence-fake')).withFence(execFile as any);
  return { ...real, execFile: fencedExecFile, default: { ...real, execFile: fencedExecFile } };
});

import * as fs from 'fs';
import * as path from 'path';
import { fenceOwners } from './fence-fake';

// The owner a failback run that started at 1 names on the layers it sets.
const OWNER = 'failback:1';
const rec = (db: { containerName: string }) => ({ containerName: db.containerName, owner: OWNER });

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
  fenceOwners.clear();
  fenceOwners.set(primary.containerName, OWNER);
  fenceOwners.set(copy.containerName, OWNER);
  seedRegistry();
});
afterAll(() => { fs.rmSync(tmp.dir, { recursive: true, force: true }); });

describe('X15: a failback run\'s stuck consent fence survives a manager restart', () => {
  it('a re-armed run after a restart still owns the fence a failback left stuck', async () => {
    const before = await restartedManager();
    expect(await before.liftConsentFence('a', primary, OWNER, 'its next restore retries the lift')).toBe('failed');
    expect(before.failbackFenceLeft('a', primary.containerName)).toBe(true);

    const after = await restartedManager();
    expect(after.failbackFenceLeft('a', primary.containerName)).toBe(true);
    expect(after.failbackFenceLeft('a', copy.containerName)).toBe(false);
  });

  it('no record is saved before a lift; one is saved once the lift did not land', async () => {
    const fb = await restartedManager();
    let seenAtLift: unknown = 'unset';
    pg.onLift = () => { seenAtLift = onDisk().fleetConsentFenceLeft ?? null; };
    await fb.liftConsentFence('a', copy, OWNER, 're-seeding this copy on its Database modal clears it');
    expect(seenAtLift).toBeNull();
    expect(onDisk().fleetConsentFenceLeft).toEqual([rec(copy)]);
  });

  it('a refused clear does not claim a later fence, and the clear is retried until it lands', async () => {
    const fb = await restartedManager();
    await fb.liftConsentFence('a', primary, OWNER, 'x');
    pg.liftWorks = true;
    blockSaves();
    try {
      expect(await fb.liftConsentFence('a', primary, OWNER, 'x')).toBe('lifted');
    } finally { unblockSaves(); }
    expect(onDisk().fleetConsentFenceLeft).toEqual([rec(primary)]);
    // Another lane fences the database: this process must not take it for the failback's.
    pg.fenced.set(primary.containerName, true);
    fenceOwners.set(primary.containerName, 'restore:2');
    expect(fb.failbackFenceLeft('a', primary.containerName)).toBe(false);
    const tick = await startedWithTick(fb);
    fb.stopFleetBackupScheduler();
    tick();
    await vi.waitFor(() => expect(onDisk().fleetConsentFenceLeft).toBeUndefined());
    expect(fb.failbackFenceLeft('a', primary.containerName)).toBe(false);
  });

  it('a record kept at start for a stopped database is reprobed and cleared once it reads unfenced', async () => {
    const first = await restartedManager();
    await first.liftConsentFence('a', primary, OWNER, 'x');
    pg.down.add(primary.containerName);
    const after = await restartedManager();
    const tick = await startedWithTick(after);
    after.stopFleetBackupScheduler();
    await new Promise(r => setTimeout(r, 50));
    expect(onDisk().fleetConsentFenceLeft).toEqual([rec(primary)]);
    expect(after.failbackFenceLeft('a', primary.containerName)).toBe(true);
    // It comes up clean (its restart dropped the stripped setting).
    pg.down.delete(primary.containerName);
    pg.fenced.set(primary.containerName, false);
    tick();
    await vi.waitFor(() => expect(onDisk().fleetConsentFenceLeft).toBeUndefined());
    expect(after.failbackFenceLeft('a', primary.containerName)).toBe(false);
  });

  it('a lift that lands on the primary leaves the copy stuck-fence warning in place', async () => {
    const fb = await restartedManager();
    await fb.liftConsentFence('a', copy, OWNER, 'reseed');
    expect(fb.getFleetFenceStuck('a')).toContain('READ-ONLY');
    pg.liftWorks = true;
    pg.fenced.set(copy.containerName, true);
    pg.onLift = (c) => { if (c === copy.containerName) throw new Error('the copy must not be lifted here'); };
    expect(await fb.liftConsentFence('a', primary, OWNER, 'x')).toBe('lifted');
    expect(fb.getFleetFenceStuck('a')).toContain('READ-ONLY');
    expect(onDisk().fleetConsentFenceLeft).toEqual([rec(copy)]);
  });

  it('a lifted fence clears the record, so a restarted manager does not claim a later fence there', async () => {
    const first = await restartedManager();
    await first.liftConsentFence('a', primary, OWNER, 'x');
    pg.liftWorks = true;
    expect(await first.liftConsentFence('a', primary, OWNER, 'x')).toBe('lifted');
    expect(onDisk().fleetConsentFenceLeft).toBeUndefined();
    const after = await restartedManager();
    expect(after.failbackFenceLeft('a', primary.containerName)).toBe(false);
  });

  it('at start a recorded fence that reads off is cleared, so a stale record cannot claim another lane\'s fence', async () => {
    const first = await restartedManager();
    await first.liftConsentFence('a', primary, OWNER, 'x');
    // Lifted outside this manager (its container restarted on a stripped auto.conf).
    pg.fenced.set(primary.containerName, false);
    const after = await restartedManager();
    after.startFleetBackupScheduler();
    after.stopFleetBackupScheduler();
    await vi.waitFor(() => expect(onDisk().fleetConsentFenceLeft).toBeUndefined());
    expect(after.failbackFenceLeft('a', primary.containerName)).toBe(false);
  });

  it('each tick rechecks every record, not only the one the warning names', async () => {
    const fb = await restartedManager();
    await fb.liftConsentFence('a', primary, OWNER, 'x');
    await fb.liftConsentFence('a', copy, OWNER, 'reseed');
    expect(onDisk().fleetConsentFenceLeft).toEqual([rec(primary), rec(copy)]);
    const tick = await startedWithTick(fb);
    fb.stopFleetBackupScheduler();
    await new Promise(r => setTimeout(r, 50));
    pg.fenced.set(primary.containerName, false);
    tick();
    await vi.waitFor(() => expect(onDisk().fleetConsentFenceLeft).toEqual([rec(copy)]));
    expect(fb.failbackFenceLeft('a', primary.containerName)).toBe(false);
    expect(fb.failbackFenceLeft('a', copy.containerName)).toBe(true);
  });

  it('a record that could not be saved is held in this process', async () => {
    const fb = await restartedManager();
    // A directory where the temp file goes refuses the save on every platform.
    blockSaves();
    try {
      expect(await fb.liftConsentFence('a', primary, OWNER, 'x')).toBe('failed');
      expect(fb.getFleetFenceStuck('a')).toContain('READ-ONLY');
      expect(fb.failbackFenceLeft('a', primary.containerName)).toBe(true);
    } finally {
      unblockSaves();
    }
  });
});
