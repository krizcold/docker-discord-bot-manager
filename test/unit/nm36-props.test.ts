import { describe, expect, it } from 'vitest';
import { parseKeptSsl } from '../../src/instance/keptData';

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

const LINES = ['on', 'off', 'ON', 'true', '', ' on', 'ssl|on', 'ssl|off', 'ssl|', 'x'];

/** One stdout: zero to four lines from LINES joined by newlines, blank lines among them, at times a final newline. */
function stdoutOf(r: () => number): string {
  const n = Math.floor(r() * 5);
  const lines = Array.from({ length: n }, () => LINES[Math.floor(r() * LINES.length)]);
  return lines.join('\n') + (r() < 0.5 ? '\n' : '');
}

/** The model: exactly one non-empty trimmed line, and it is `on` or `off`; then true exactly for `on`. */
function model(stdout: string, on: string, off: string): boolean | undefined {
  const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length !== 1 || (lines[0] !== on && lines[0] !== off)) return undefined;
  return lines[0] === on;
}

describe('nm36 props: parseKeptSsl', () => {
  it('P1: the admin read is defined exactly for one line on or off, and true exactly for on (3000 cases)', () => {
    const r = rng(seed);
    let defined = 0;
    for (let i = 0; i < 3000; i++) {
      const s = stdoutOf(r);
      const want = model(s, 'on', 'off');
      if (want !== undefined) defined++;
      expect(parseKeptSsl(s, 'admin'), JSON.stringify(s)).toBe(want);
    }
    expect(defined).toBeGreaterThan(50);
  });

  it('P2: the read as the bot role (S4) is defined exactly for one line ssl|on or ssl|off, and true exactly for ssl|on (3000 cases)', () => {
    const r = rng(seed + 1);
    let defined = 0;
    for (let i = 0; i < 3000; i++) {
      const s = stdoutOf(r);
      const want = model(s, 'ssl|on', 'ssl|off');
      if (want !== undefined) defined++;
      expect(parseKeptSsl(s, 'owner'), JSON.stringify(s)).toBe(want);
    }
    expect(defined).toBeGreaterThan(50);
  });
});
