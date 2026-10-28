import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/instance/fleetReplica', () => ({}));

import { rebuildVerdict, VerdictAdmission, VerdictCopy, VerdictMain, verdictText, RETRY_AFTER_MS } from '../../src/instance/fleetCopyWatch';

const NOW = 1_800_000_000_000;
const admission = (over: Partial<VerdictAdmission> = {}): VerdictAdmission => ({
  copyCleared: false, heldAt: null, busy: null, parked: null, joinedSystemId: '7001', host: 'main.invalid', port: 15432, ...over,
});
const copy = (over: Partial<Extract<VerdictCopy, { answered: true }>> = {}): VerdictCopy => ({
  answered: true, inRecovery: true, streaming: false, systemId: '7001', timeline: 1, lsn: 100n, ...over,
});
const main = (over: Partial<Extract<VerdictMain, { answered: true }>> = {}): VerdictMain => ({
  answered: true, inRecovery: false, systemId: '7001', timeline: 1, lsn: 200n, slot: 'absent', ...over,
});

describe('rebuildVerdict: one row per rule', () => {
  it.each([
    ['C56 copy does not answer: unknown', admission(), { answered: false, reason: "the copy's database did not answer" } as VerdictCopy, main(), 'unknown'],
    ['copy streams: ok', admission(), copy({ streaming: true }), main(), 'ok'],
    ['copy promoted: ok, not a rebuild', admission(), copy({ inRecovery: false }), main(), 'ok'],
    ['main does not answer: unknown', admission(), copy(), { answered: false, reason: 'connection refused' } as VerdictMain, 'unknown'],
    ['slot kept: ok', admission(), copy(), main({ slot: 'kept' }), 'ok'],
    ['slot active: ok', admission(), copy(), main({ slot: 'active' }), 'ok'],
    ['main in recovery: held', admission(), copy(), main({ inRecovery: true }), 'held'],
    ['another system id: held', admission(), copy(), main({ systemId: '9' }), 'held'],
    ['another timeline: held', admission(), copy(), main({ timeline: 2 }), 'held'],
    ['main behind the copy: held', admission(), copy({ lsn: 300n }), main({ lsn: 200n }), 'held'],
    ['operator hold: held', admission({ heldAt: '2026-10-20T10:00:00.000Z' }), copy(), main(), 'held'],
    ['a parked operator run: wait', admission({ parked: { auto: false, cancelled: false, updatedAt: 0 } }), copy(), main(), 'wait'],
    ['a cancelled automatic run: wait', admission({ parked: { auto: true, cancelled: true, updatedAt: 0 } }), copy(), main(), 'wait'],
    ['a parked automatic run under 30 minutes: wait', admission({ parked: { auto: true, cancelled: false, updatedAt: NOW - RETRY_AFTER_MS + 1000 } }), copy(), main(), 'wait'],
    ['a parked automatic run past 30 minutes: rebuild', admission({ parked: { auto: true, cancelled: false, updatedAt: NOW - RETRY_AFTER_MS } }), copy(), main(), 'rebuild'],
    ['something busy: wait', admission({ busy: 'a backup or restore is running on this database' }), copy(), main(), 'wait'],
    ['slot absent and every fact safe: rebuild', admission(), copy(), main(), 'rebuild'],
    ['slot lost and inactive: rebuild', admission(), copy(), main({ slot: 'lost' }), 'rebuild'],
    ['main at the copy position: rebuild', admission(), copy({ lsn: 200n }), main({ lsn: 200n }), 'rebuild'],
  ])('%s', (_name, a, c, m, kind) => {
    expect(rebuildVerdict(a, c, m, NOW).kind).toBe(kind);
  });

  it('a held verdict names its reason in the T-33 line, an unknown one in T-34', () => {
    const held = rebuildVerdict(admission(), copy(), main({ timeline: 3 }), NOW);
    expect(verdictText(held)).toBe("The main no longer keeps this copy's place (its slot is gone or was invalidated), so the copy cannot catch up. It was not rebuilt automatically: the main is on timeline 3 and this copy on timeline 1, so the main changed since this copy was made. Press Re-seed to rebuild it.");
    const behind = rebuildVerdict(admission(), copy({ lsn: 0x1_00000010n }), main({ lsn: 0x1_00000001n }), NOW);
    expect(verdictText(behind)).toContain("the main is at position 1/1, behind this copy's 1/10, so this copy may hold changes the main lacks");
    const unknown = rebuildVerdict(admission(), copy(), { answered: false, reason: 'connection refused' }, NOW);
    expect(verdictText(unknown)).toBe("Can't confirm whether the main still keeps this copy's place: connection refused.");
    expect(verdictText(rebuildVerdict(admission({ heldAt: '2026-10-20T10:00:00.000Z' }), copy(), main(), NOW))).toContain('automatic rebuilding is off for this copy since a rebuild was cancelled or dismissed on 2026-10-20');
    expect(verdictText(rebuildVerdict(admission(), copy(), main({ systemId: '9' }), NOW))).toContain('the database at main.invalid:15432 (system id 9) is not the one this copy was made from (system id 7001)');
    expect(verdictText(rebuildVerdict(admission(), copy(), main({ inRecovery: true }), NOW))).toContain('the database at main.invalid:15432 follows another database itself');
    expect(verdictText({ kind: 'rebuild', slot: 'lost' })).toBeNull();
  });

  it('the rebuild names the slot state it found', () => {
    expect(rebuildVerdict(admission(), copy(), main({ slot: 'lost' }), NOW)).toEqual({ kind: 'rebuild', slot: 'lost' });
    expect(rebuildVerdict(admission(), copy(), main({ slot: 'absent' }), NOW)).toEqual({ kind: 'rebuild', slot: 'absent' });
  });
});

describe('rebuildVerdict: every combination of safe and unsafe facts', () => {
  // Each key has one safe value and one or more unsafe ones; the oracle says rebuild only when all are safe.
  const keys: Array<[string, unknown[]]> = [
    ['copyAnswered', [true, false]],
    ['copyInRecovery', [true, false]],
    ['copyStreaming', [false, true]],
    ['mainAnswered', [true, false]],
    ['mainInRecovery', [false, true]],
    ['slot', ['absent', 'kept', 'active']],
    ['systemId', ['7001', '9']],
    ['timeline', [1, 2]],
    ['mainLsn', [200n, 50n]],
    ['heldAt', [null, '2026-10-20T00:00:00.000Z']],
    ['parked', [null, { auto: false, cancelled: false, updatedAt: 0 }, { auto: true, cancelled: false, updatedAt: NOW }]],
    ['busy', [null, 'busy']],
  ];
  const combos = (i: number): Array<Record<string, unknown>> => {
    if (i === keys.length) return [{}];
    const rest = combos(i + 1);
    return keys[i][1].flatMap(v => rest.map(r => ({ [keys[i][0]]: v, ...r })));
  };

  it('rebuilds only when every fact is safe, over all combinations', () => {
    const all = combos(0);
    expect(all.length).toBe(2 ** 10 * 3 * 3);
    let rebuilds = 0;
    for (const k of all) {
      const c: VerdictCopy = k.copyAnswered ? copy({ inRecovery: k.copyInRecovery as boolean, streaming: k.copyStreaming as boolean, lsn: 100n }) : { answered: false, reason: 'x' };
      const m: VerdictMain = k.mainAnswered
        ? main({ inRecovery: k.mainInRecovery as boolean, slot: k.slot as any, systemId: k.systemId as string, timeline: k.timeline as number, lsn: k.mainLsn as bigint })
        : { answered: false, reason: 'x' };
      const a = admission({ heldAt: k.heldAt as string | null, parked: k.parked as any, busy: k.busy as string | null });
      const safe = keys.every(([name, values]) => k[name] === values[0]);
      const v = rebuildVerdict(a, c, m, NOW);
      expect(v.kind === 'rebuild').toBe(safe);
      if (v.kind === 'rebuild') rebuilds++;
    }
    expect(rebuilds).toBe(1);
  });

  it('with the copy already cleared, the copy is not read and the recorded system id stands in for it', () => {
    const cleared = admission({ copyCleared: true });
    expect(rebuildVerdict(cleared, null, main(), NOW).kind).toBe('rebuild');
    expect(rebuildVerdict(cleared, null, main({ systemId: '9' }), NOW).kind).toBe('held');
    expect(rebuildVerdict(cleared, null, main({ slot: 'kept' }), NOW)).toEqual({ kind: 'rebuild', slot: 'kept' });
    expect(rebuildVerdict(cleared, null, { answered: false, reason: 'x' }, NOW).kind).toBe('unknown');
    expect(rebuildVerdict(admission({ copyCleared: true, joinedSystemId: null }), null, main(), NOW).kind).toBe('unknown');
    expect(rebuildVerdict(admission({ copyCleared: true, heldAt: '2026-10-20T00:00:00.000Z' }), null, main(), NOW).kind).toBe('held');
  });
});

describe('F2: a cleared copy is rebuilt whatever its slot reads, while a run is not in use on it', () => {
  const cleared = (over: Partial<VerdictAdmission> = {}) => admission({ copyCleared: true, ...over });
  it.each([
    ['slot kept, no parked run: rebuild', cleared(), main({ slot: 'kept' }), 'rebuild'],
    ['slot lost: rebuild', cleared(), main({ slot: 'lost' }), 'rebuild'],
    ['slot in use: wait', cleared(), main({ slot: 'active' }), 'wait'],
    ['slot kept, a parked automatic run past 30 minutes: rebuild', cleared({ parked: { auto: true, cancelled: false, updatedAt: NOW - RETRY_AFTER_MS } }), main({ slot: 'kept' }), 'rebuild'],
    ['slot kept, a parked automatic run under 30 minutes: wait', cleared({ parked: { auto: true, cancelled: false, updatedAt: NOW - 1000 } }), main({ slot: 'kept' }), 'wait'],
    ['slot kept, a parked operator run: wait (C82)', cleared({ parked: { auto: false, cancelled: false, updatedAt: 0 } }), main({ slot: 'kept' }), 'wait'],
    ['slot kept, a cancelled automatic run: wait', cleared({ parked: { auto: true, cancelled: true, updatedAt: 0 } }), main({ slot: 'kept' }), 'wait'],
    ['slot kept, an operator hold: held', cleared({ heldAt: '2026-10-20T00:00:00.000Z' }), main({ slot: 'kept' }), 'held'],
  ])('%s', (_name, a, m, kind) => {
    expect(rebuildVerdict(a, null, m, NOW).kind).toBe(kind);
  });
});

describe('F3: three safety dumps within 24 hours hold the copy', () => {
  const DAY = 24 * 3600_000;
  it('the fourth run that would dump is held, with the date of the first dump', () => {
    const dumps = [Date.parse('2026-10-25T01:00:00.000Z'), Date.parse('2026-10-25T09:00:00.000Z'), Date.parse('2026-10-25T20:00:00.000Z')];
    const v = rebuildVerdict(admission({ rebuildDumps: dumps }), copy(), main(), NOW);
    expect(v).toEqual({ kind: 'held', reason: '3 automatic rebuilds took a safety dump of this copy since 2026-10-25, and no more start until a Re-seed in its manager' });
  });
  it("N3: the hold names the last run's stored error when there is one, and no cause the manager did not read", () => {
    const dumps = [Date.parse('2026-10-25T01:00:00.000Z'), Date.parse('2026-10-25T09:00:00.000Z'), Date.parse('2026-10-25T20:00:00.000Z')];
    const v = rebuildVerdict(admission({ rebuildDumps: dumps, lastRunError: 'could not prepare the replication slot on the primary: ERROR:  all replication slots are in use' }), copy(), main(), NOW);
    expect(v).toEqual({ kind: 'held', reason: '3 automatic rebuilds took a safety dump of this copy since 2026-10-25, and no more start until a Re-seed in its manager; the last one stopped: could not prepare the replication slot on the primary: ERROR:  all replication slots are in use' });
  });
  it("the hold does not lapse with time; only the operator's Re-seed clears the times", () => {
    const dumps = [NOW - 40 * DAY, NOW - 40 * DAY + 1000, NOW - 40 * DAY + 2000];
    expect(rebuildVerdict(admission({ rebuildDumps: dumps }), copy(), main(), NOW).kind).toBe('held');
  });
  it('three dumps spread over more than 24 hours do not hold', () => {
    expect(rebuildVerdict(admission({ rebuildDumps: [NOW - 3 * DAY, NOW - 2 * DAY, NOW - DAY] }), copy(), main(), NOW).kind).toBe('rebuild');
  });
  it('two dumps do not hold', () => {
    expect(rebuildVerdict(admission({ rebuildDumps: [NOW - 2000, NOW - 1000] }), copy(), main(), NOW).kind).toBe('rebuild');
  });
  it('a cleared copy takes no dump, so its retries are not held by the count', () => {
    expect(rebuildVerdict(admission({ copyCleared: true, rebuildDumps: [NOW - 3000, NOW - 2000, NOW - 1000] }), null, main(), NOW).kind).toBe('rebuild');
  });
});

describe('N2: the held line names the slot only when the slot read says so', () => {
  it('a cleared copy with its slot kept says the copy was deleted by a run that stopped', () => {
    const v = rebuildVerdict(admission({ copyCleared: true, heldAt: '2026-10-20T00:00:00.000Z' }), null, main({ slot: 'kept' }), NOW);
    expect(v).toEqual({ kind: 'held', reason: 'automatic rebuilding is off for this copy since a rebuild was cancelled or dismissed on 2026-10-20', cleared: true });
    expect(verdictText(v)).toBe('This copy was deleted by a rebuild or Re-seed that stopped, and it was not rebuilt automatically: automatic rebuilding is off for this copy since a rebuild was cancelled or dismissed on 2026-10-20. The manager waits for a Re-seed here: press Re-seed to rebuild it.');
  });
  it('a whole copy, held while its slot reads gone, keeps the slot line', () => {
    const v = rebuildVerdict(admission({ heldAt: '2026-10-20T00:00:00.000Z' }), copy(), main({ slot: 'lost' }), NOW);
    expect(verdictText(v)).toMatch(/^The main no longer keeps this copy's place \(its slot is gone or was invalidated\)/);
  });
});
