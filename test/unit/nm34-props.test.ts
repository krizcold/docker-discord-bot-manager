import { describe, expect, it } from 'vitest';
import { NO_ADMIN_OFF_REASON, noAdminOff } from '../../src/instance/maintenance';
import { parseOwnerClusterRead, parseOwnerCopyRead } from '../../src/instance/keptData';
import type { MaintenanceRecord } from '../../src/types';

// A seeded generator in place of fast-check, which this repo's test folder does not install.
const seed = Number(process.env.SMDB_TEST_SEED) || 20261117;
function rng(s: number) {
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const oneOf = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

const LINE_WORDS = ['t', 'f', 'T', 'true', 'false', ' t', 'tt', '', 'x', 'missing', 'r', '-', 'v', '0', '00', '01', '7', '-1', '1x', ' 3', '3 '];

/** One S1 answer: the valid lines, then each line kept, changed or dropped, and the order shuffled at times. */
function clusterText(r: () => number): { text: string; valid: boolean } {
  const kind = oneOf(r, ['-', 'r', 'v'] as const);
  const lines = [
    't', `recovery|${oneOf(r, ['true', 'false'])}`, `admin|${oneOf(r, ['missing', 'true', 'false'])}`, `sessions|${Math.floor(r() * 4)}`,
    `restorekind|${kind}`, ...(kind === 'r' ? [`restore|${oneOf(r, ['', 'false|f.dump|2026-11-16T10:00:00Z|2|m|', 'garbled'])}`] : []),
    '', `sessions2|${Math.floor(r() * 4)}`,
  ];
  if (r() < 0.3) return { text: lines.join('\n') + '\n', valid: true };
  const out = lines.map(l => {
    const p = r();
    if (p < 0.15) return null;
    if (p < 0.35) {
      const [head] = l.split('|');
      return l.includes('|') ? `${head}|${oneOf(r, LINE_WORDS)}` : oneOf(r, LINE_WORDS);
    }
    return l;
  }).filter((l): l is string => l !== null);
  if (r() < 0.3) out.sort(() => r() - 0.5);
  return { text: out.join('\n') + '\n', valid: false };
}

const nonEmpty = (text: string) => text.split('\n').map(l => l.trim()).filter(Boolean);

describe('nm34 props', () => {
  it(`noAdminOff is true exactly when state off, settled false, login unconfirmed and the reason is NO_ADMIN_OFF_REASON (seed ${seed})`, () => {
    const r = rng(seed);
    let hits = 0;
    for (let i = 0; i < 3000; i++) {
      const rec = {
        state: oneOf(r, ['off', 'running', 'maintenance'] as const),
        message: '', orderedAt: '2026-11-17T12:00:00.000Z',
        settled: r() < 0.5,
        hook: 'not-sent', savedByBot: null,
        login: oneOf(r, ['unconfirmed', 'blocked', 'open', 'not-managed'] as const),
        ...(r() < 0.8 ? { lastError: oneOf(r, [NO_ADMIN_OFF_REASON, `${NO_ADMIN_OFF_REASON} `, 'the stop failed (x)', '', NO_ADMIN_OFF_REASON.toUpperCase()]) } : {}),
      } as unknown as MaintenanceRecord;
      const want = rec.state === 'off' && rec.settled === false && rec.login === 'unconfirmed' && rec.lastError === NO_ADMIN_OFF_REASON;
      if (want) hits++;
      expect(noAdminOff(rec), JSON.stringify(rec)).toBe(want);
    }
    expect(hits).toBeGreaterThan(20);
  });

  it(`parseOwnerClusterRead: a superuser read needs 't' first, the lines in order, and sessions 0 only from exactly sessions|0 (seed ${seed})`, () => {
    const r = rng(seed + 1);
    let parsed = 0;
    for (let i = 0; i < 5000; i++) {
      const { text, valid } = clusterText(r);
      const read = parseOwnerClusterRead(text);
      const lines = nonEmpty(text);
      if (valid) expect(read, text).toBeDefined();
      if (!read) continue;
      parsed++;
      if (!read.superuser) {
        expect(lines).toEqual(['f']);
        continue;
      }
      expect(lines[0]).toBe('t');
      expect(lines[1]).toBe(`recovery|${read.recovery}`);
      expect(lines[2]).toBe(`admin|${read.admin === 'usable' ? 'true' : read.admin === 'unusable' ? 'false' : 'missing'}`);
      expect(lines[3]).toBe(`sessions|${read.sessions[0]}`);
      expect(lines[lines.length - 1]).toBe(`sessions2|${read.sessions[1]}`);
      expect(lines.length).toBe(/^restorekind\|r$/.test(lines[4]) ? 7 : 6);
      if (read.sessions[0] === 0) expect(lines[3]).toBe('sessions|0');
      if (read.sessions[1] === 0) expect(lines[lines.length - 1]).toBe('sessions2|0');
      const kind = lines[4].slice('restorekind|'.length);
      if (kind === '-') expect(read.restore).toBeNull();
      else if (kind !== 'r') expect(read.restore).toEqual({ notTable: kind });
    }
    expect(parsed).toBeGreaterThan(1000);
    for (const order of [[0, 2, 1, 3, 4, 5], [0, 1, 2, 5, 4, 3], [1, 0, 2, 3, 4, 5]]) {
      const valid = ['t', 'recovery|false', 'admin|missing', 'sessions|0', 'restorekind|-', 'sessions2|0'];
      expect(parseOwnerClusterRead(order.map(i => valid[i]).join('\n'))).toBeUndefined();
    }
  });

  it(`parseOwnerCopyRead: a superuser read needs exactly 't' and one copy line (seed ${seed})`, () => {
    const r = rng(seed + 2);
    let parsed = 0;
    for (let i = 0; i < 3000; i++) {
      const lines = [oneOf(r, LINE_WORDS), `${oneOf(r, ['copy', 'copy ', 'cop', 'restore'])}|${oneOf(r, ['true', 'false', 't', ''])}|${oneOf(r, ['streaming', '', 'stopping', 'a|b'])}`];
      const text = (r() < 0.2 ? [lines[0]] : r() < 0.2 ? [...lines, oneOf(r, LINE_WORDS)] : lines).join('\n');
      const read = parseOwnerCopyRead(text);
      if (!read) continue;
      parsed++;
      const got = nonEmpty(text);
      if (!read.superuser) {
        expect(got).toEqual(['f']);
        continue;
      }
      expect(got).toHaveLength(2);
      expect(got[0]).toBe('t');
      expect(got[1]).toBe(`copy|${read.recovery}|${read.status}`);
    }
    expect(parsed).toBeGreaterThan(20);
  });
});
