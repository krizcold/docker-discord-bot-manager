import { describe, expect, it } from 'vitest';
import { dataMountStop, newDatabaseUnchecked } from '../../src/docker/containerManager';
import type { InstanceConfig, KeptOpKind, KeptStep } from '../../src/types';

// A seeded generator in place of fast-check, which this repo's test folder does not install.
const seed = Number(process.env.SMDB_TEST_SEED) || 20261119;
function rng(s: number) {
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length)];

const V = 'bota-fleet-postgres-data-2026-11-17T12-00-00-000Z';
const LINES = [`volume ${V}`, `volume ${V}-x`, 'volume other', 'bind /srv/pg', `bind ${V}`];
const ERRORS = ['Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?', 'spawnSync docker ETIMEDOUT'];

const OPS: KeptOpKind[] = ['new-start', 'put-back', 'delete'];
const PARTS: Array<'db' | 'copy' | 'folder'> = ['db', 'copy', 'folder'];
const STEPS: KeptStep[] = ['recorded', 'db-stopped', 'db-out', 'swapped', 'folder', 'db-in', 'db-up', 'login',
  'settled', 'copy-made', 'dumped', 'scratch-gone', 'checked', 'archived', 'archive-checked', 'removing'];

describe('nm37 props', () => {
  it('P1: dataMountStop answers null exactly for the one line volume V; a failure comes back as is; else the lines (3000 cases)', () => {
    const r = rng(seed);
    let passed = 0;
    let failures = 0;
    for (let i = 0; i < 3000; i++) {
      const kind = r();
      if (kind < 0.1) {
        const failure = r() < 0.5 ? { gone: true as const } : { error: pick(r, ERRORS) };
        failures++;
        expect(dataMountStop(failure, V)).toBe(failure);
        continue;
      }
      const mounts = Array.from({ length: Math.floor(r() * 4) }, () => pick(r, LINES));
      const want = mounts.length === 1 && mounts[0] === `volume ${V}`;
      if (want) passed++;
      const got = dataMountStop({ ok: true, mounts }, V);
      if (want) expect(got, JSON.stringify(mounts)).toBeNull();
      else expect(got, JSON.stringify(mounts)).toEqual({ mounts });
    }
    expect(passed).toBeGreaterThan(50);
    expect(failures).toBeGreaterThan(50);
  });

  it('P2: newDatabaseUnchecked is true exactly for a new-start with a database whose new volume is in use and whose step is before db-up (3000 cases)', () => {
    const r = rng(seed + 1);
    let trues = 0;
    for (let i = 0; i < 3000; i++) {
      const op = pick(r, OPS);
      const parts = PARTS.filter(() => r() < 0.5);
      const step = pick(r, STEPS);
      const hasDb = r() < 0.85;
      const same = r() < 0.6;
      const undo = r() < 0.3;
      const hasRecord = r() < 0.95;
      const inst = {
        id: 'a',
        ...(hasDb ? { fleetDb: { containerName: 'bota-fleet-postgres', user: 'u', db: 'd', password: 'p', volume: same ? V : 'bota-fleet-postgres-data' } } : {}),
        ...(hasRecord ? { keptOp: { op, set: 's', stamp: 's', startedAt: 'x', parts, dataDir: '/d', outDir: '/o', inDir: '/i', newVolume: V, offMessage: '', sharers: [], step, ...(undo ? { undo: true } : {}) } } : {}),
      } as unknown as InstanceConfig;
      const want = hasRecord && op === 'new-start' && parts.includes('db') && hasDb && same && step !== 'db-up' && step !== 'login';
      if (want) trues++;
      expect(newDatabaseUnchecked(inst), JSON.stringify({ op, parts, step, hasDb, same, undo, hasRecord })).toBe(want);
    }
    expect(trues).toBeGreaterThan(50);
    expect(newDatabaseUnchecked(null)).toBe(false);
    expect(newDatabaseUnchecked(undefined)).toBe(false);
  });
});
