import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b21-1s-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

// The answer of the volume check a start runs after a cancelled rescue; null: docker fails.
const st = vi.hoisted(() => ({ volume: 'partial' as string | null, checks: 0 }));

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFile = (cmd: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (cmd === 'docker' && args[0] === 'run' && args.join(' ').includes('standby.signal')) {
      st.checks++;
      setImmediate(() => (st.volume === null ? done(new Error('daemon down'), '', 'Cannot connect to the Docker daemon') : done(null, `${st.volume}\n`, '')));
      return { stdin: null };
    }
    return (real.execFile as any)(cmd, args, opts, cb);
  };
  return { ...real, execFile, default: { ...real, execFile } };
});

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';

const REGISTRY = path.join(tmp.dir, 'instances.json');
const onDisk = () => JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')).instances.a;

beforeEach(() => {
  st.volume = 'partial';
  st.checks = 0;
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: {
    a: { id: 'a', displayName: 'a', sanitizedName: 'a', status: 'stopped', sourceUrl: 'x', fleetDb: { containerName: 'a-db', user: 'u', db: 'd', volume: 'a-vol' } },
  } }, null, 2));
});
afterAll(() => { fs.rmSync(tmp.dir, { recursive: true, force: true }); });

describe('R9-J2 and R22-J12: a start refuses on what a cancelled rescue left', () => {
  it('a cancel records what it left in the same save that clears the record, and the mark survives a new rescue cancelled at preflight', () => {
    containerManager.updateInstanceRecoveryRescue('a', { phase: 'bulk', startedAt: 1, updatedAt: 1 });
    containerManager.updateInstanceRecoveryRescue('a', null, undefined, { at: Date.UTC(2026, 9, 25), state: 'partial' });
    expect(onDisk().recoveryRescue).toBeUndefined();
    expect(onDisk().recoveryRescueLeft).toEqual({ at: Date.UTC(2026, 9, 25), state: 'partial' });
    containerManager.updateInstanceRecoveryRescue('a', { phase: 'preflight', startedAt: 2, updatedAt: 2 });
    containerManager.updateInstanceRecoveryRescue('a', { phase: 'preflight', startedAt: 2, updatedAt: 3, parked: true });
    expect(onDisk().recoveryRescueLeft).toEqual({ at: Date.UTC(2026, 9, 25), state: 'partial' });
    containerManager.updateInstanceRecoveryRescue('a', null);
    expect(onDisk().recoveryRescue).toBeUndefined();
    expect(onDisk().recoveryRescueLeft).toEqual({ at: Date.UTC(2026, 9, 25), state: 'partial' });
  });

  it('a finished swap clears the mark with its last swap save', () => {
    containerManager.updateInstanceRecoveryRescue('a', null, undefined, { at: Date.UTC(2026, 9, 25), state: 'standby' });
    containerManager.updateInstanceRecoveryRescue('a', { phase: 'flip', startedAt: 2, updatedAt: 2 });
    containerManager.updateInstanceRecoveryRescue('a', null, { startedAt: 2, completedAt: 9 });
    expect(onDisk().recoveryLastSwap).toEqual({ startedAt: 2, completedAt: 9 });
    expect(onDisk().recoveryRescueLeft).toBeUndefined();
  });

  it('a partial copy on the volume refuses the start and names the remedy', async () => {
    containerManager.updateInstanceRecoveryRescue('a', null, undefined, { at: Date.UTC(2026, 9, 25), state: 'partial' });
    const r = await containerManager.startBot('a');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^A rescue cancelled on 2026-10-25 left a partial copy of the sender's database on this instance's volume, so it was not started/);
    expect(r.error).toMatch(/Start a rescue again to finish the copy, or decommission this database/);
    expect(onDisk().recoveryRescueLeft).toBeDefined();
  });

  it('a database left as a standby refuses the start, and so does a restart', async () => {
    st.volume = 'standby';
    containerManager.updateInstanceRecoveryRescue('a', null, undefined, { at: Date.UTC(2026, 9, 25), state: 'standby' });
    expect((await containerManager.startBot('a')).error).toMatch(/left this instance's database as a standby of the sender/);
    expect((await containerManager.restartBot('a')).error).toMatch(/left this instance's database as a standby of the sender/);
  });

  it('a volume docker cannot check refuses the start and keeps the mark', async () => {
    st.volume = null;
    containerManager.updateInstanceRecoveryRescue('a', null, undefined, { at: Date.UTC(2026, 9, 25), state: 'partial' });
    const r = await containerManager.rescueLeftoverRefusal('a');
    expect(r?.error).toMatch(/docker could not check it \(Cannot connect to the Docker daemon\), so the instance was not started/);
    expect(onDisk().recoveryRescueLeft).toBeDefined();
  });

  it('a volume that is clean again clears the mark and lets the start go on', async () => {
    st.volume = 'clean';
    containerManager.updateInstanceRecoveryRescue('a', null, undefined, { at: Date.UTC(2026, 9, 25), state: 'partial' });
    expect(await containerManager.rescueLeftoverRefusal('a')).toBeNull();
    expect(onDisk().recoveryRescueLeft).toBeUndefined();
    expect(containerManager.getBot('a')?.recoveryRescueLeft).toBeUndefined();
  });

  it('an instance with no mark is not checked', async () => {
    expect(await containerManager.rescueLeftoverRefusal('a')).toBeNull();
    expect(st.checks).toBe(0);
  });
});
