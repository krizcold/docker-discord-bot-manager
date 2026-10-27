import { describe, expect, it } from 'vitest';
import {
  alertStep, compareCounts, dailyBoundary, dumpDue, dumpFileName, hourSlot, parseCountLines, parseDumpName, testDue, trimVictims, validateDumpMeta,
  HOURLY_KEEP_MS, DAILY_KEEP_MS,
} from '../../src/instance/backupFiles';

const H = 3_600_000;
const D = 24 * H;

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const NOW = new Date(2026, 9, 27, 10, 30, 0, 0).getTime();

describe('NM2 file names', () => {
  it('dumpFileName and parseDumpName round trip for every family and kind (500 seeded cases)', () => {
    const r = lcg(1);
    for (let i = 0; i < 500; i++) {
      const at = Math.floor(NOW - r() * 400 * D);
      const family = r() < 0.5 ? 'main' : 'copy';
      const kind = r() < 0.5 ? 'hourly' : 'daily';
      const name = dumpFileName(family, kind, at);
      expect(name.startsWith(family === 'copy' ? 'copy-' : kind)).toBe(true);
      expect(parseDumpName(name)).toEqual({ file: name, family, kind, stamp: at });
    }
  });

  it('safety dumps are main and kind safety; any other name is kind other with no stamp', () => {
    expect(parseDumpName('pre-restore-2026-10-27T04-00-00-000Z.dump')).toMatchObject({ family: 'main', kind: 'safety', stamp: null });
    expect(parseDumpName('pre-decommission-x.dump')).toMatchObject({ kind: 'safety' });
    expect(parseDumpName('standin-2026-10-27T04-00-00-000Z.dump')).toMatchObject({ kind: 'other', stamp: null });
    expect(parseDumpName('2026-10-27T04-00-00-000Z.dump')).toMatchObject({ kind: 'other', stamp: null });
    expect(parseDumpName('hourly-2026-13-27T04-00-00-000Z.dump')).toMatchObject({ kind: 'other' });
  });
});

describe('NM2 the schedule', () => {
  it('dumpDue: daily when no daily since the boundary, else hourly when none in this slot, never twice in one attempted slot (500 seeded cases)', () => {
    const r = lcg(2);
    for (let i = 0; i < 500; i++) {
      const now = Math.floor(NOW + r() * 60 * D);
      const hour = Math.floor(r() * 24);
      const family = r() < 0.5 ? 'main' : 'copy';
      const names: string[] = [];
      const n = Math.floor(r() * 5);
      for (let k = 0; k < n; k++) names.push(dumpFileName(r() < 0.5 ? family : (family === 'main' ? 'copy' : 'main'), r() < 0.5 ? 'hourly' : 'daily', Math.floor(now - r() * 30 * H)));
      const boundary = dailyBoundary(now, hour);
      const slot = hourSlot(now);
      const mine = names.map(parseDumpName).filter(p => p.family === family && p.stamp !== null);
      const expected = !mine.some(p => p.kind === 'daily' && p.stamp! >= boundary) ? 'daily'
        : !mine.some(p => p.stamp! >= slot) ? 'hourly' : null;
      expect(dumpDue(names, family, now, hour)).toBe(expected);
      expect(dumpDue(names, family, now, hour, slot)).toBeNull();
    }
  });

  it('dumpDue ignores stamps more than 5 minutes ahead of now', () => {
    const ahead = [dumpFileName('main', 'daily', NOW + 6 * 60_000)];
    expect(dumpDue(ahead, 'main', NOW, 4)).toBe('daily');
    const near = [dumpFileName('main', 'daily', NOW + 4 * 60_000)];
    expect(dumpDue(near, 'main', NOW, 4)).toBeNull();
  });

  it('dailyBoundary is at the hour, at or before now, within a day, on every day of a year (DST days included)', () => {
    for (let day = 0; day < 366; day++) {
      for (const hour of [0, 2, 3, 4, 23]) {
        const now = new Date(2026, 0, 1 + day, 12, 17).getTime();
        const b = dailyBoundary(now, hour);
        expect(b).toBeLessThanOrEqual(now);
        expect(now - b).toBeLessThan(D + 2 * H);
        const local = new Date(b);
        expect(local.getMinutes()).toBe(0);
        const noon = (k: number) => new Date(local.getFullYear(), local.getMonth(), local.getDate() + k, 12).getTimezoneOffset();
        const shifts = noon(-1) !== noon(0) || noon(0) !== noon(1);
        if (!shifts) expect(local.getHours()).toBe(hour);
      }
    }
  });

  it('hour 0 and hour 23 boundaries', () => {
    expect(dailyBoundary(new Date(2026, 9, 27, 0, 10).getTime(), 0)).toBe(new Date(2026, 9, 27, 0, 0).getTime());
    expect(dailyBoundary(new Date(2026, 9, 27, 22, 59).getTime(), 23)).toBe(new Date(2026, 9, 26, 23, 0).getTime());
    expect(dailyBoundary(new Date(2026, 9, 27, 23, 0).getTime(), 23)).toBe(new Date(2026, 9, 27, 23, 0).getTime());
  });

  it('testDue: none yet, started before the boundary, or interrupted', () => {
    const b = dailyBoundary(NOW, 4);
    expect(testDue(undefined, NOW, 4)).toBe(true);
    expect(testDue({ file: 'x', startedAt: b - 1, result: 'passed' }, NOW, 4)).toBe(true);
    expect(testDue({ file: 'x', startedAt: b + 1, result: 'passed' }, NOW, 4)).toBe(false);
    expect(testDue({ file: 'x', startedAt: b + 1, result: 'failed' }, NOW, 4)).toBe(false);
    expect(testDue({ file: 'x', startedAt: b + 1, result: 'interrupted', cutShort: 1 }, NOW, 4)).toBe(true);
  });
});

describe('NM2 retention', () => {
  it('trimVictims keeps the newest, the protected names, safety and other files and the other family, and deletes only past their keep (500 seeded cases)', () => {
    const r = lcg(3);
    for (let i = 0; i < 500; i++) {
      const family = r() < 0.5 ? 'main' : 'copy';
      const names = new Set<string>();
      const n = 1 + Math.floor(r() * 12);
      for (let k = 0; k < n; k++) names.add(dumpFileName(r() < 0.6 ? family : (family === 'main' ? 'copy' : 'main'), r() < 0.7 ? 'hourly' : 'daily', Math.floor(NOW - r() * 40 * D)));
      names.add('pre-restore-2020-01-01T00-00-00-000Z.dump');
      names.add('standin-old.dump');
      const list = [...names];
      const lastGood = list[Math.floor(r() * list.length)];
      const target = list[Math.floor(r() * list.length)];
      const { victims, clockAhead } = trimVictims(list, family, NOW, [lastGood, target, null]);
      expect(clockAhead).toBe(false);
      const mine = list.map(parseDumpName).filter(p => p.family === family && (p.kind === 'hourly' || p.kind === 'daily'));
      const newest = mine.reduce<typeof mine[number] | null>((a, p) => (!a || p.stamp! > a.stamp! ? p : a), null);
      for (const v of victims) {
        const p = parseDumpName(v);
        expect(p.family).toBe(family);
        expect(['hourly', 'daily']).toContain(p.kind);
        expect(v).not.toBe(newest?.file);
        expect(v).not.toBe(lastGood);
        expect(v).not.toBe(target);
        expect(NOW - p.stamp!).toBeGreaterThan(p.kind === 'hourly' ? HOURLY_KEEP_MS : DAILY_KEEP_MS);
      }
      for (const p of mine) {
        const past = NOW - p.stamp! > (p.kind === 'hourly' ? HOURLY_KEEP_MS : DAILY_KEEP_MS);
        if (past && p.file !== newest?.file && p.file !== lastGood && p.file !== target) expect(victims).toContain(p.file);
      }
    }
  });

  it('trimVictims deletes nothing when a stamp of the family is ahead of the clock', () => {
    const list = [dumpFileName('main', 'hourly', NOW - 50 * H), dumpFileName('main', 'hourly', NOW + 10 * 60_000), dumpFileName('main', 'hourly', NOW - H)];
    expect(trimVictims(list, 'main', NOW, [])).toEqual({ victims: [], clockAhead: true });
  });
});

describe('NM2 counts', () => {
  it('compareCounts is ok only on equal maps (500 seeded cases)', () => {
    const r = lcg(4);
    for (let i = 0; i < 500; i++) {
      const a: Record<string, number> = {};
      for (let k = 0; k < 1 + Math.floor(r() * 6); k++) a[`"public"."t${k}"`] = Math.floor(r() * 5);
      const b = { ...a };
      const change = r();
      if (change < 0.25) b[Object.keys(b)[0]] += 1;
      else if (change < 0.5) delete b[Object.keys(b)[0]];
      else if (change < 0.75) b['"public"."extra"'] = 1;
      const equal = JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
      expect(compareCounts(a, b).ok).toBe(equal);
    }
  });

  it('compareCounts names up to 5 differences and the rest as a number', () => {
    const rec: Record<string, number> = {};
    const res: Record<string, number> = {};
    for (let k = 0; k < 7; k++) { rec[`"public"."t${k}"`] = k; res[`"public"."t${k}"`] = k + 1; }
    rec['"public"."gone"'] = 1;
    const out = compareCounts(rec, res);
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/^8 table\(s\) differ from the counts recorded when the backup was taken: /);
    expect(out.text).toContain('"public"."gone": missing after the restore');
    expect(out.text).toContain(', and 3 more');
    expect(compareCounts({}, { '"public"."new"': 2 }).text).toContain('"public"."new": not in the recorded counts');
    expect(compareCounts({ '"public"."t"': 4 }, { '"public"."t"': 5 }).text).toContain('"public"."t": 4 recorded, 5 restored');
  });

  it('a counts line for a table named with | takes the count after the last |', () => {
    const parsed = parseCountLines('count|"public"."a|b"|12\ncount|"public"."c"|0\n');
    expect(parsed).toEqual({ ok: true, counts: { '"public"."a|b"': 12, '"public"."c"': 0 } });
    expect(parseCountLines('count|"public"."c"|x\n').ok).toBe(false);
  });

  it('validateDumpMeta refuses a negative count, a non-integer one, and totals that disagree with the counts', () => {
    const good = { file: 'hourly-x.dump', takenAt: NOW, family: 'main', kind: 'hourly', inRecovery: false, dataAt: NOW, dbBytes: 10, tables: 2, rows: 5, counts: { '"a"."b"': 2, '"a"."c"': 3 } };
    expect(validateDumpMeta(good)).toEqual({ ok: true, meta: good });
    expect(validateDumpMeta({ ...good, counts: { '"a"."b"': -1, '"a"."c"': 6 } }).ok).toBe(false);
    expect(validateDumpMeta({ ...good, counts: { '"a"."b"': 2.5, '"a"."c"': 2.5 } }).ok).toBe(false);
    expect(validateDumpMeta({ ...good, rows: 6 }).ok).toBe(false);
    expect(validateDumpMeta({ ...good, tables: 3 }).ok).toBe(false);
    expect(validateDumpMeta(null).ok).toBe(false);
    expect(validateDumpMeta({ ...good, family: 'x' }).ok).toBe(false);
  });
});

describe('NM2 the alert step', () => {
  it('sends at most once per alert, except pending and failed an hour apart (500 seeded cases)', () => {
    const r = lcg(5);
    const states = ['pending', 'sent', 'failed', 'unknown', 'unsupported'] as const;
    for (let i = 0; i < 500; i++) {
      const dm = states[Math.floor(r() * states.length)];
      const dmAt = r() < 0.3 ? undefined : NOW - Math.floor(r() * 3 * H);
      const prev = { kind: 'dumps' as const, text: 'old', since: NOW - 5 * H, dm, ...(dmAt !== undefined ? { dmAt } : {}) };
      const on = r() < 0.8;
      const step = alertStep(prev, on, 'dumps', 'new', NOW);
      if (!on) { expect(step).toEqual({ next: null, send: false }); continue; }
      expect(step.next).toEqual({ ...prev, text: 'new' });
      const expected = (dm === 'pending' || dm === 'failed') && NOW - (dmAt ?? 0) >= H;
      expect(step.send).toBe(expected);
    }
  });

  it('a new alert is saved pending and sent; an absent one stays absent', () => {
    expect(alertStep(undefined, true, 'test', 'x', NOW)).toEqual({ next: { kind: 'test', text: 'x', since: NOW, dm: 'pending' }, send: true });
    expect(alertStep(undefined, false, 'test', 'x', NOW)).toEqual({ next: null, send: false });
  });
});
