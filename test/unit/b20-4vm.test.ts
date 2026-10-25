import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b20-4vm-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    volumes: new Set<string>(),
    calls: [] as string[],
    // First matching rule answers an execFile docker call: [predicate, ok, stdout, stderr].
    rules: [] as Array<[(args: string[]) => boolean, boolean, string, string]>,
  };
});

const fail = (stderr: string): Error => Object.assign(new Error(stderr), { stderr });
const volumeAnswer = (args: string[]): string => {
  if (args[0] === 'volume' && args[1] === 'inspect') {
    const name = args[args.length - 1];
    if (!h.volumes.has(name)) throw fail(`Error: No such volume: ${name}`);
  }
  // docker run -v mints a named volume that does not exist, :ro or not.
  if (args[0] === 'run') {
    for (let i = 0; i < args.length - 1; i++) if (args[i] === '-v') h.volumes.add(args[i + 1].split(':')[0]);
  }
  return '';
};

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFileSync = (_f: string, args: string[]) => { h.calls.push(args.join(' ')); return volumeAnswer(args); };
  const execFile = (_f: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    h.calls.push(args.join(' '));
    const rule = h.rules.find(([match]) => match(args));
    if (rule) {
      const [, ok, stdout, stderr] = rule;
      if (args[0] === 'run') volumeAnswer(args);
      setImmediate(() => done(ok ? null : Object.assign(new Error('docker failed'), { code: 1 }), stdout, stderr));
      return { stdin: null };
    }
    try { const out = volumeAnswer(args); setImmediate(() => done(null, out, '')); } catch (e: any) { setImmediate(() => done(e, '', e.stderr)); }
    return { stdin: null };
  };
  const execSync = () => '';
  const exec = (cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    h.calls.push(cmd);
    done(null, { stdout: '', stderr: '' });
  };
  const mod = { ...real, exec, execFile: (await import('./fence-fake')).withFence(execFile as any), execFileSync, execSync };
  return { ...mod, default: mod };
});
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import { ensureRsyncDaemon } from '../../src/instance/recoveryControl';
import * as fleetBackup from '../../src/instance/fleetBackup';

const DB = 'bot1-fleet-postgres-data';
const DAEMON_DOWN = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock';
const registryPath = path.join(h.dir, 'instances.json');
const fleetDb = { containerName: 'bot1-fleet-postgres', user: 'smdb', db: 'smdb', volume: DB };
const record = (over: Record<string, unknown> = {}): any => ({
  id: 'b1', sanitizedName: 'bot1', displayName: 'Bot b1', titleName: 'Bot b1', status: 'stopped',
  sourceType: 'docker-image', envVars: {}, fleetDb,
  createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', ...over,
});
const writeBot = (over: Record<string, unknown> = {}) => {
  fs.writeFileSync(registryPath, JSON.stringify({ instances: { b1: record(over) } }));
  return containerManager.getBot('b1')!;
};
const stored = (): any => JSON.parse(fs.readFileSync(registryPath, 'utf-8')).instances.b1;
const runs = () => h.calls.filter((c) => c.startsWith('run'));
const isVolumeInspect = (a: string[]) => a[0] === 'volume' && a[1] === 'inspect' && a[a.length - 1] === DB;
const isLeftProbe = (a: string[]) => a[0] === 'run' && a.join(' ').includes('standby.signal');
const isRsyncdInspect = (a: string[]) => a[0] === 'inspect' && a[a.length - 1] === 'bot1-recovery-rsyncd';
const isUnfence = (a: string[]) => a[0] === 'exec' && a.join(' ').includes('ALTER SYSTEM RESET');
const isStrip = (a: string[]) => a[0] === 'run' && a.join(' ').includes('default_transaction_read_only');
const LEFT = { at: Date.UTC(2026, 9, 25), state: 'partial' };

beforeEach(() => {
  h.volumes = new Set([DB]);
  h.calls = [];
  h.rules = [];
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('B20-4vm: rescueLeftoverRefusal probes only a volume docker proved exists', () => {
  it('keeps the mark, runs no probe and mints nothing when the volume is gone', async () => {
    h.volumes.delete(DB);
    writeBot({ recoveryRescueLeft: LEFT });
    const r = await containerManager.rescueLeftoverRefusal('b1');
    expect(runs()).toEqual([]);
    expect(h.volumes.has(DB)).toBe(false);
    expect(r?.success).toBe(false);
    expect(r?.error).toMatch(/A rescue cancelled on 2026-10-25 left a mark on this instance, and its database volume bot1-fleet-postgres-data is gone/);
    expect(r?.error).toMatch(/so it was not started/);
    expect(stored().recoveryRescueLeft).toEqual(LEFT);
  });

  it('says it cannot confirm and keeps the mark when docker does not answer the volume read', async () => {
    h.rules.push([isVolumeInspect, false, '', DAEMON_DOWN]);
    writeBot({ recoveryRescueLeft: LEFT });
    const r = await containerManager.rescueLeftoverRefusal('b1');
    expect(runs()).toEqual([]);
    expect(r?.error).toMatch(/can't confirm whether its database volume bot1-fleet-postgres-data exists/);
    expect(stored().recoveryRescueLeft).toEqual(LEFT);
  });

  it('probes an existing volume as before and clears the mark when it is clean', async () => {
    h.rules.push([isLeftProbe, true, 'clean\n', '']);
    writeBot({ recoveryRescueLeft: LEFT });
    expect(await containerManager.rescueLeftoverRefusal('b1')).toBeNull();
    expect(runs()).toHaveLength(1);
    expect(runs()[0]).toContain(`${DB}:/pgdata`);
    expect(stored().recoveryRescueLeft).toBeUndefined();
  });
});

describe('B20-4vm: ensureRsyncDaemon serves only a source volume docker proved exists', () => {
  beforeEach(() => {
    h.rules.push([isRsyncdInspect, false, '', 'Error: No such object: bot1-recovery-rsyncd']);
  });

  it('refuses to serve, runs no daemon and mints nothing when the source volume is gone', async () => {
    h.volumes.delete(DB);
    const r = await ensureRsyncDaemon(writeBot(), 'img', 'net');
    expect(runs()).toEqual([]);
    expect(h.volumes.has(DB)).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/the source database volume bot1-fleet-postgres-data is gone, so the rsync daemon was not started/);
  });

  it('says it cannot confirm when docker does not answer the volume read', async () => {
    h.rules.push([isVolumeInspect, false, '', DAEMON_DOWN]);
    const r = await ensureRsyncDaemon(writeBot(), 'img', 'net');
    expect(runs()).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/can't confirm whether the source database volume bot1-fleet-postgres-data exists \(docker did not answer\), so the rsync daemon was not started/);
  });

  it('starts the daemon on an existing volume as before', async () => {
    const r = await ensureRsyncDaemon(writeBot(), 'img', 'net');
    expect(r).toEqual({ ok: true });
    expect(runs()).toHaveLength(1);
    expect(runs()[0]).toContain(`${DB}:/pgdata:ro`);
  });
});

describe('B20-4vm: liftRestoreFence strips only a volume docker proved exists', () => {
  beforeEach(() => {
    h.rules.push([isUnfence, false, '', 'Error response from daemon: No such container: bot1-fleet-postgres']);
    writeBot();
  });

  it('runs no strip, mints nothing and says no fence remains when the volume is gone', async () => {
    h.volumes.delete(DB);
    const note = await fleetBackup.liftLaneFence('b1', fleetDb, 'reseed:1', 'a re-seed', 'retrying the re-seed retries the lift');
    expect(runs()).toEqual([]);
    expect(h.volumes.has(DB)).toBe(false);
    expect(note).toMatch(/the database volume bot1-fleet-postgres-data is gone, so no write fence remains on it/);
    expect(note).not.toMatch(/READ-ONLY/);
    expect(fleetBackup.getFleetFenceStuck('b1')).toBeNull();
  });

  it('says it cannot confirm when docker does not answer the volume read', async () => {
    h.rules.push([isVolumeInspect, false, '', DAEMON_DOWN]);
    const note = await fleetBackup.liftLaneFence('b1', fleetDb, 'reseed:1', 'a re-seed', 'retrying the re-seed retries the lift');
    expect(runs()).toEqual([]);
    expect(note).toMatch(/can't confirm whether the database is still READ-ONLY/);
    expect(fleetBackup.getFleetFenceStuck('b1')).toMatch(/can't confirm/);
  });

  it('strips the fence from an existing volume as before', async () => {
    h.rules.push([isStrip, true, '', '']);
    const note = await fleetBackup.liftLaneFence('b1', fleetDb, 'reseed:1', 'a re-seed', 'retrying the re-seed retries the lift');
    expect(runs()).toHaveLength(1);
    expect(runs()[0]).toContain(`${DB}:/pgdata`);
    expect(note).toMatch(/READ-ONLY, and may still refuse the bot's connections, until its container restarts/);
  });
});
