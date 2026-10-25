import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'fu-8-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

// A fake docker CLI. Every call is recorded with its options. h.answer decides each call: 'hang' never answers
// (a hung CLI), 'timeout' answers the way execFile does when its timeout killed the child, else ok with stdout.
const h = vi.hoisted(() => ({
  calls: [] as Array<{ args: string[]; opts: any }>,
  answer: (_args: string[]): 'hang' | 'timeout' | { stdout: string } => ({ stdout: '' }),
}));

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const util = await import('util');
  const run = (args: string[], opts: any, cb: (err: any, stdout: string, stderr: string) => void) => {
    h.calls.push({ args, opts });
    const a = h.answer(args);
    if (a === 'hang') return;
    if (a === 'timeout') {
      const err: any = new Error(`Command failed: docker ${args.join(' ')}`);
      err.killed = true;
      err.signal = 'SIGTERM';
      err.code = null;
      setImmediate(() => cb(err, '', ''));
      return;
    }
    setImmediate(() => cb(null, a.stdout, ''));
  };
  const execFile: any = (cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    if (cmd !== 'docker') return (real.execFile as any)(cmd, args, optsOrCb, maybeCb);
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as any;
    run(args, typeof optsOrCb === 'function' ? {} : optsOrCb, cb);
    return {} as any;
  };
  execFile[util.promisify.custom] = (cmd: string, args: string[], opts: any) => new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err: any, stdout: string, stderr: string) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); } else resolve({ stdout, stderr });
    });
  });
  return { ...real, execFile, default: { ...real, execFile } };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';

const REGISTRY = path.join(tmp.dir, 'instances.json');
const fleetDb = { containerName: 'bot-a-postgres', user: 'app', db: 'app', volume: 'bot-a-pgdata' };
const sourceDb = { containerName: 'bot-s-postgres', user: 'app', db: 'app', volume: 'bot-s-pgdata' };

function seedRegistry(extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: {
    a: { id: 'a', displayName: 'a', sanitizedName: 'bot-a', status: 'stopped', fleetDb, fleetBackup: { enabled: false, hour: 4, keep: 7 }, ...extra },
    s: { id: 's', displayName: 's', sanitizedName: 'bot-s', status: 'stopped', fleetDb: sourceDb, fleetBackup: { enabled: false, hour: 4, keep: 7 },
      recoveryChannel: { mode: 'source', containerName: 'bot-s-recovery', token: 't', createdAt: 1 }, recoverySwappedAway: { at: 1 } },
  } }, null, 2));
}

async function fresh<T>(load: () => Promise<T>): Promise<T> {
  vi.resetModules();
  return load();
}

const realSetTimeout = globalThis.setTimeout;
const settle = () => new Promise<void>((r) => { realSetTimeout(r, 30); });
const bounded = (opts: any) => typeof opts?.timeout === 'number' && opts.timeout > 0 && Number.isFinite(opts.timeout);

beforeEach(() => {
  h.calls.length = 0;
  h.answer = () => ({ stdout: '' });
  seedRegistry();
});
afterAll(() => { fs.rmSync(tmp.dir, { recursive: true, force: true }); });

describe('B20-4vt: a volume read has a bound, and a timed-out one is unknown', () => {
  it('docker volume inspect runs with a timeout', async () => {
    const fr = await fresh(() => import('../../src/instance/fleetReplica'));
    expect(await fr.dockerVolumeState('bot-a-pgdata')).toBe('exists');
    const call = h.calls.find(c => c.args[0] === 'volume' && c.args[1] === 'inspect');
    expect(call).toBeDefined();
    expect(bounded(call!.opts)).toBe(true);
  });

  it('a timed-out volume inspect answers unknown, never absent', async () => {
    const fr = await fresh(() => import('../../src/instance/fleetReplica'));
    h.answer = () => 'timeout';
    expect(await fr.dockerVolumeState('bot-a-pgdata')).toBe('unknown');
  });
});

describe('B20-1t, B11-2t: fleetBackup reads have a bound, its writes do not', () => {
  it('the fence read runs with a timeout and a timed-out one cannot be confirmed', async () => {
    const fb = await fresh(() => import('../../src/instance/fleetBackup'));
    const isRead = (args: string[]) => args.some(a => a.includes('pg_read_file'));
    h.answer = (args) => isRead(args) ? 'timeout' : { stdout: '' };
    expect(await fb.fenceLayers(fleetDb)).toBeNull();
    const call = h.calls.find(c => isRead(c.args));
    expect(bounded(call!.opts)).toBe(true);
  });

  it('the container inspect runs with a timeout, and a timed-out one refuses the dump as unknown', async () => {
    const fb = await fresh(() => import('../../src/instance/fleetBackup'));
    const cm = await import('../../src/docker/containerManager');
    h.answer = (args) => args[0] === 'inspect' ? 'timeout' : { stdout: '' };
    const r = await fb.runFleetDump(cm.getBot('a')!);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^Could not probe the database container/);
    const call = h.calls.find(c => c.args[0] === 'inspect');
    expect(bounded(call!.opts)).toBe(true);
  });

  it('the fence lift (a write) gets no timeout', async () => {
    const fb = await fresh(() => import('../../src/instance/fleetBackup'));
    // The read-only layer names the failback run that lifts it.
    h.answer = (args) => args.join(' ').includes("pg_read_file('smdb-fence-owner', true)") ? { stdout: 'on|failback:1\n' } : { stdout: '' };
    expect(await fb.liftConsentFence('a', fleetDb, 'failback:1', 'x')).toBe('lifted');
    const lift = h.calls.find(c => c.args.join(' ').includes('ALTER SYSTEM RESET'));
    expect(lift).toBeDefined();
    expect(lift!.opts?.timeout).toBeUndefined();
  });
});

describe('B11-2t: fleetReplication reads the container state with a bound', () => {
  it('a timed-out inspect reads as a probe error, not as a stopped database', async () => {
    seedRegistry({ fleetDb: { ...fleetDb, replication: { publicHost: 'db.example.invalid', hostPort: 15432 } } });
    const repl = await fresh(() => import('../../src/instance/fleetReplication'));
    const cm = await import('../../src/docker/containerManager');
    h.answer = (args) => args[0] === 'inspect' ? 'timeout' : { stdout: '' };
    const status = await repl.getFleetReplicationStatus(cm.getBot('a')!);
    expect(status.probeError).toBeTruthy();
    const call = h.calls.find(c => c.args[0] === 'inspect');
    expect(bounded(call!.opts)).toBe(true);
  });
});

describe('B20-1t: the backup tick skips while its previous run is in flight', () => {
  it('a second tick during a hung first one starts nothing', async () => {
    seedRegistry({ fleetConsentFenceLeft: [{ containerName: fleetDb.containerName, owner: 'failback:1' }] });
    const fb = await fresh(() => import('../../src/instance/fleetBackup'));
    h.answer = (args) => args[0] === 'inspect' ? 'hang' : { stdout: '' };
    let tick: () => void = () => {};
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void) => { tick = fn; return 0; }) as unknown as typeof setInterval);
    fb.startFleetBackupScheduler();
    spy.mockRestore();
    try {
      await settle();
      const afterSeed = h.calls.length;
      tick();
      await settle();
      const afterFirst = h.calls.length;
      expect(afterFirst).toBe(afterSeed + 1);
      tick();
      await settle();
      expect(h.calls.length).toBe(afterFirst);
    } finally {
      fb.stopFleetBackupScheduler();
    }
  });
});

describe('B16-1w: a manager stop does not wait on the slot a quiesced recovery source holds', () => {
  it('the shutdown wait passes a quiesced source slot at once, and a self-update still refuses on it', async () => {
    const fb = await fresh(() => import('../../src/instance/fleetBackup'));
    const guards = await import('../../src/instance/fleetBackupGuards');
    expect(guards.claimFleetBackupBusy('s')).toBe(true);
    try {
      const began = Date.now();
      expect(await fb.waitForInFlightLanes(2_000, 10)).toBeNull();
      expect(Date.now() - began).toBeLessThan(1_000);
      expect(fb.databaseLaneBlocker()).toMatch(/running on s$/);
    } finally {
      guards.releaseFleetBackupBusy('s');
    }
  });

  it('a slot held on any other instance is still waited on', async () => {
    const fb = await fresh(() => import('../../src/instance/fleetBackup'));
    const guards = await import('../../src/instance/fleetBackupGuards');
    expect(guards.claimFleetBackupBusy('a')).toBe(true);
    try {
      expect(await fb.waitForInFlightLanes(50, 10)).toMatch(/running on a$/);
    } finally {
      guards.releaseFleetBackupBusy('a');
    }
  });

  it('a quiesced source whose op lock is held is still waited on', async () => {
    const fb = await fresh(() => import('../../src/instance/fleetBackup'));
    const guards = await import('../../src/instance/fleetBackupGuards');
    const cm = await import('../../src/docker/containerManager');
    expect(guards.claimFleetBackupBusy('s')).toBe(true);
    let release: () => void = () => {};
    const op = cm.withExternalBotOp('s', 'quiesce', () => new Promise<void>((r) => { release = r; }));
    try {
      expect(await fb.waitForInFlightLanes(50, 10)).toMatch(/running on s$/);
    } finally {
      release();
      await op;
      guards.releaseFleetBackupBusy('s');
    }
  });
});

describe('B07-1l: a project listing docker did not answer is not an empty list', () => {
  it('listProjectContainers answers null on a timeout, with a bound on the call', async () => {
    const dc = await fresh(() => import('../../src/docker/dockerClient'));
    h.answer = () => 'timeout';
    expect(await dc.listProjectContainers('bot-a')).toBeNull();
    expect(bounded(h.calls[0].opts)).toBe(true);
  });
});
