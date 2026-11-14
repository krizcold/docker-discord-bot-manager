import { describe, expect, it } from 'vitest';
import { Bot } from '../../src/cli/tui/api';
import { innerWidth } from '../../src/cli/tui/app';
import { listHeader, listRow } from '../../src/cli/tui/format';

const LONG = 'a-bot-name-that-is-much-longer-than-any-column';
// What GET /api/bots sends for a busy bot whose env store and backup folder cannot be read.
const busy = {
  id: 'b1', displayName: LONG, status: 'running', activeOp: 'replica-remove', dataPlace: null,
  fleetDbReplicaSeed: { phase: 'preparing' },
  fleetBackup: { main: { lastAt: null, listError: 'EACCES: permission denied, so the last backup cannot be named' }, copy: null },
} as unknown as Bot;

describe('m1 fix 1b: the list fits the terminal', () => {
  for (const columns of [80, 100]) {
    it(`shows every fixed column whole at ${columns} columns`, () => {
      const inner = innerWidth(columns);
      const row = listRow(busy, true, 0, inner);
      const header = listHeader(inner);
      expect(row.length).toBeLessThanOrEqual(inner);
      expect(header.length).toBeLessThanOrEqual(inner);
      expect(row.endsWith("can't confirm")).toBe(true);
      expect(row).toContain(" replica-remove ");
      expect(row).toContain(" can't confirm ");
      expect(row).toContain(' seed preparing ');
      expect(header).toMatch(/Status\s+Data\s+Copy\s+Last backup$/);
      expect(row.startsWith('> a-bot-name')).toBe(true);
      expect(row).not.toContain(LONG);
    });
  }

  it('gives the extra width to Bots and keeps the fixed columns where they are relative to the end', () => {
    const at80 = listRow(busy, false, 0, innerWidth(80));
    const at100 = listRow(busy, false, 0, innerWidth(100));
    expect(at100.length - at80.length).toBe(20);
    expect(at100.indexOf('replica-remove') - at80.indexOf('replica-remove')).toBe(20);
    const shortName = listRow({ ...busy, displayName: 'mybot' } as Bot, false, 0, innerWidth(80));
    expect(shortName.startsWith('  mybot ')).toBe(true);
  });

  it('keeps a floor for Bots on a narrow terminal and never passes the edge', () => {
    const inner = innerWidth(40);
    const row = listRow(busy, false, 0, inner);
    expect(row.startsWith('  a-bot-name-')).toBe(true);
    expect(row.length).toBeLessThanOrEqual(inner);
    expect(listHeader(inner).length).toBeLessThanOrEqual(inner);
  });

  for (const columns of [76, 62]) {
    it(`leaves out Copy at ${columns} columns so Last backup stays whole`, () => {
      const inner = innerWidth(columns);
      const row = listRow(busy, true, 0, inner);
      const header = listHeader(inner);
      expect(row.length).toBeLessThanOrEqual(inner);
      expect(header.length).toBeLessThanOrEqual(inner);
      expect(header).toMatch(/Status\s+Data\s+Last backup$/);
      expect(header).not.toContain('Copy');
      expect(row).not.toContain('seed');
      expect(row.endsWith(" can't confirm")).toBe(true);
      expect(row).toContain(' replica-remove ');
    });
  }

  for (const columns of [77, 80]) {
    it(`keeps Copy at ${columns} columns`, () => {
      const inner = innerWidth(columns);
      expect(listHeader(inner)).toMatch(/Status\s+Data\s+Copy\s+Last backup$/);
      expect(listRow(busy, true, 0, inner)).toContain(' seed preparing ');
      expect(listRow(busy, true, 0, inner).length).toBeLessThanOrEqual(inner);
    });
  }
});
