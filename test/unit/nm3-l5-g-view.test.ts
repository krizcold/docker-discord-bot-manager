import { afterAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm3-l5-g-view-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

import * as fs from 'fs';
import { getFleetReplicaStatus, seedPurposeLabel } from '../../src/instance/fleetReplica';

afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));

const inst = (seed: Record<string, unknown>) => ({ id: 'v', sanitizedName: 'v', displayName: 'V', fleetDbReplicaSeed: seed }) as any;

describe('seedPurposeLabel', () => {
  it('names a manual re-seed apart from an automatic rebuild', () => {
    expect(seedPurposeLabel('reseed-standby')).toBe('Re-seeding the standby');
    expect(seedPurposeLabel('reseed-standby', false, 'slot')).toBe('Re-seeding the standby');
    expect(seedPurposeLabel('provision', true, 'slot')).toBe('Provisioning the standby');
    expect(seedPurposeLabel('reseed-stale-primary', true)).toBe('Re-seeding this database as a standby');
    expect(seedPurposeLabel('reseed-standby', true)).toBe('Rebuilding the copy');
    expect(seedPurposeLabel('reseed-standby', true, 'slot')).toBe('Rebuilding the copy (the main no longer kept its place)');
  });
});

describe('getFleetReplicaStatus: the seed in flight and the parked seed', () => {
  it.each(['preparing', 'seeding'])('a running %s seed shows every field', async (phase) => {
    const startedAt = Date.now() - 5000;
    const s = await getFleetReplicaStatus(inst({ purpose: 'reseed-standby', phase, startedAt, updatedAt: startedAt, auto: true, rebuildCause: 'slot', cancelRequested: true, committed: true, safetyDump: 'd.dump' }));
    expect(s.provisioning).toEqual({ startedAt, phase, purpose: 'reseed-standby', auto: true, cause: 'slot', forSeconds: 5, cancelable: true, cancelRequested: true, committed: true, safetyDump: 'd.dump' });
  });

  it('a seed past its cancel point with no flags shows them false', async () => {
    const startedAt = Date.now() - 2000;
    const s = await getFleetReplicaStatus(inst({ purpose: 'provision', phase: 'starting', startedAt, updatedAt: startedAt }));
    expect(s.provisioning).toEqual({ startedAt, phase: 'starting', purpose: 'provision', auto: false, forSeconds: 2, cancelable: false, cancelRequested: false, committed: false });
  });

  it('a parked seed shows every field', async () => {
    const s = await getFleetReplicaStatus(inst({ purpose: 'reseed-standby', phase: 'seeding', startedAt: 10, updatedAt: 20, parked: true, auto: true, rebuildCause: 'cleared', committed: true, cancelled: true, safetyDump: 'd.dump', pinsUnretired: ['a.yml'], lastError: 'boom' }));
    expect(s.parkedSeed).toEqual({ startedAt: 10, purpose: 'reseed-standby', auto: true, cause: 'cleared', phase: 'seeding', lastError: 'boom', at: 20, committed: true, cancelled: true, copyWhole: false, safetyDump: 'd.dump', pinsUnretired: ['a.yml'] });
  });

  it('a parked seed with no flags and no error says stopped', async () => {
    const s = await getFleetReplicaStatus(inst({ purpose: 'provision', phase: 'preparing', startedAt: 10, updatedAt: 20, parked: true }));
    expect(s.parkedSeed).toEqual({ startedAt: 10, purpose: 'provision', auto: false, phase: 'preparing', lastError: 'stopped', at: 20, committed: false, cancelled: false, copyWhole: false });
  });
});
