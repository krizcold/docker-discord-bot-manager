import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/instance/fleetReplica', () => ({}));

import {
  heldText, rebuildVerdict, reseedStoppedMessage, stoppedMessage, VerdictAdmission, VerdictCopy, VerdictMain, watchTiming,
} from '../../src/instance/fleetCopyWatch';
import { InstanceConfig } from '../../src/types';

const NOW = 1_800_000_000_000;
const HOUR = 3600_000;
const admission = (over: Partial<VerdictAdmission> = {}): VerdictAdmission => ({
  copyCleared: false, heldAt: null, busy: null, parked: null, joinedSystemId: '7001', host: 'main.invalid', port: 15432, ...over,
});
const copy = (): VerdictCopy => ({ answered: true, inRecovery: true, streaming: false, systemId: '7001', timeline: 1, lsn: 100n });
const main = (over: Partial<Extract<VerdictMain, { answered: true }>> = {}): VerdictMain => ({
  answered: true, inRecovery: false, systemId: '7001', timeline: 1, lsn: 200n, slot: 'absent', ...over,
});
const instance = { id: 'b', displayName: 'B', fleetDbReplica: { publicHost: 'copy.invalid' } } as unknown as InstanceConfig;

describe('the watcher timing', () => {
  it('checks every 5 minutes', () => {
    expect(watchTiming.everyMs).toBe(300_000);
  });
});

describe('the three-dump hold', () => {
  it('reads only the last three dumps', () => {
    const dumps = [NOW - 40 * HOUR, NOW - 20 * HOUR, NOW - 10 * HOUR, NOW - HOUR];
    expect(rebuildVerdict(admission({ rebuildDumps: dumps }), copy(), main(), NOW)).toEqual({
      kind: 'held', reason: `3 automatic rebuilds took a safety dump of this copy since ${new Date(NOW - 20 * HOUR).toISOString().slice(0, 10)}, and no more start until a Re-seed in its manager`,
    });
  });
  it('holds when the three dumps span exactly 24 hours', () => {
    expect(rebuildVerdict(admission({ rebuildDumps: [NOW - 25 * HOUR, NOW - 10 * HOUR, NOW - HOUR] }), copy(), main(), NOW).kind).toBe('held');
  });
});

describe('the verdict reasons', () => {
  it.each([
    ['a copy not read', admission(), null, main(), { kind: 'unknown', reason: "the copy's database did not answer" }],
    ['a main not read', admission(), copy(), null, { kind: 'unknown', reason: 'the main was not read' }],
    ['a cleared copy whose slot is in use', admission({ copyCleared: true }), null, main({ slot: 'active' }), { kind: 'wait', reason: "the main shows this copy's slot in use" }],
    ['a cleared copy with no system id on record', admission({ copyCleared: true, joinedSystemId: null }), null, main(), { kind: 'unknown', reason: 'the system id the copy was made from is not on record' }],
    ['a parked operator run', admission({ parked: { auto: false, cancelled: false, updatedAt: 0 } }), copy(), main(), { kind: 'wait', reason: 'a stopped re-seed is on record; the operator decides it' }],
    ['a recent automatic run', admission({ parked: { auto: true, cancelled: false, updatedAt: NOW - 1000 } }), copy(), main(), { kind: 'wait', reason: 'the last automatic rebuild stopped less than 30 minutes ago' }],
  ])('%s', (_n, a, c, m, want) => {
    expect(rebuildVerdict(a, c, m, NOW)).toEqual(want);
  });
});

describe('the texts', () => {
  it('a held line without the cleared flag names the slot', () => {
    expect(heldText('why')).toBe("The main no longer keeps this copy's place (its slot is gone or was invalidated), so the copy cannot catch up. It was not rebuilt automatically: why. Press Re-seed to rebuild it.");
  });
  it('a stopped rebuild with no safety dump ends at the retry sentence', () => {
    expect(stoppedMessage(instance, 'why')).toBe("The automatic rebuild of the live database copy on copy.invalid stopped after the old copy was deleted: why. That machine holds no copy of the database until a rebuild finishes; its manager tries again every 30 minutes, and Re-seed in that machine's manager starts one now.");
  });
  it('a stopped Re-seed names its safety dump', () => {
    expect(reseedStoppedMessage(instance, 'why', 'copy-x.dump')).toBe('A Re-seed of the live database copy on copy.invalid stopped after the old copy was deleted: why. That machine holds no copy of the database until a Re-seed in its manager finishes. A backup of the old copy is kept on that machine as copy-x.dump.');
  });
});
