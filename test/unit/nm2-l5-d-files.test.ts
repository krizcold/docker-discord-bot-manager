import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  backupDir, compareCounts, dailyBoundary, dumpDue, dumpFileName, errorLine, holderStdin, hourSlot, isRecoveryConflict,
  newestScheduled, parseCountLines, parseDfFreeKb, parseDumpName, testDue, trimVictims, validateDumpMeta,
  COUNTS_SQL, SNAP_SQL, CLOCK_SLACK_MS, DAILY_KEEP_MS, HOURLY_KEEP_MS,
} from '../../src/instance/backupFiles';

const H = 3_600_000;
const NOW = new Date(2026, 9, 27, 10, 30, 0, 0).getTime();

function meta(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { file: 'hourly-x.dump', takenAt: 1, family: 'main', kind: 'hourly', inRecovery: false, dataAt: null, dbBytes: 10, tables: 2, rows: 5, counts: { a: 0, b: 5 }, ...over };
}
const err = (v: unknown) => { const r = validateDumpMeta(v); return r.ok ? 'ok' : r.error; };

describe('NM2 L5 d: keeps and folder', () => {
  it('keeps hourly dumps 48 hours and daily dumps 30 days', () => {
    expect(HOURLY_KEEP_MS).toBe(48 * H);
    expect(DAILY_KEEP_MS).toBe(30 * 24 * H);
  });

  it('puts backups under /data/data when DATA_DIR is unset', () => {
    const was = process.env.DATA_DIR;
    delete process.env.DATA_DIR;
    try {
      expect(backupDir('b1')).toBe(path.join('/data/data', 'backups', 'b1', 'fleet-postgres'));
    } finally {
      if (was !== undefined) process.env.DATA_DIR = was;
    }
  });
});

describe('NM2 L5 d: names', () => {
  it('a scheduled name with a prefix, a date that rolls over, or copy- elsewhere is not scheduled', () => {
    expect(parseDumpName('xhourly-2026-10-27T04-00-00-000Z.dump')).toEqual({ file: 'xhourly-2026-10-27T04-00-00-000Z.dump', family: 'main', kind: 'other', stamp: null });
    expect(parseDumpName('hourly-2026-02-30T04-00-00-000Z.dump')).toMatchObject({ kind: 'other', stamp: null });
    expect(parseDumpName('copy-standin.dump')).toMatchObject({ family: 'copy', kind: 'other' });
    expect(parseDumpName('standin-copy-.dump')).toMatchObject({ family: 'main', kind: 'other' });
  });

  it('newestScheduled ignores other files and keeps the first of equal stamps', () => {
    expect(newestScheduled(['copy-standin.dump', 'copy-foo.dump'], 'copy')).toBeNull();
    const a = dumpFileName('main', 'hourly', NOW);
    const b = dumpFileName('main', 'daily', NOW);
    expect(newestScheduled([a, b], 'main')!.file).toBe(a);
    expect(newestScheduled([b, a], 'main')!.file).toBe(b);
  });
});

describe('NM2 L5 d: due and trim edges', () => {
  const boundary = dailyBoundary(NOW, 4);
  const slot = hourSlot(NOW);

  it('a dump stamped exactly at the clock slack still counts', () => {
    expect(dumpDue([dumpFileName('main', 'daily', NOW + CLOCK_SLACK_MS)], 'main', NOW, 4)).toBeNull();
  });

  it('a daily stamped exactly at the boundary and an hourly exactly at the slot count', () => {
    expect(dumpDue([dumpFileName('main', 'daily', boundary), dumpFileName('main', 'hourly', slot)], 'main', NOW, 4)).toBeNull();
  });

  it('a stamp exactly at the clock slack is not ahead of the clock', () => {
    expect(trimVictims([dumpFileName('main', 'hourly', NOW + CLOCK_SLACK_MS)], 'main', NOW, [])).toEqual({ victims: [], clockAhead: false });
  });

  it('a dump exactly at its keep stays; victims come back sorted', () => {
    const newest = dumpFileName('main', 'hourly', NOW);
    const edge = dumpFileName('main', 'hourly', NOW - HOURLY_KEEP_MS);
    expect(trimVictims([newest, edge], 'main', NOW, []).victims).toEqual([]);
    const v1 = dumpFileName('main', 'hourly', NOW - 100 * H);
    const v2 = dumpFileName('main', 'daily', NOW - 40 * 24 * H);
    const names = [newest, v1, v2];
    expect(trimVictims(names, 'main', NOW, []).victims).toEqual([v1, v2].sort());
    expect(trimVictims([newest, ...[v1, v2].sort().reverse()], 'main', NOW, []).victims).toEqual([v1, v2].sort());
  });

  it('a test started exactly at the boundary is not due', () => {
    expect(testDue({ startedAt: boundary, result: 'good' } as never, NOW, 4)).toBe(false);
  });
});

describe('NM2 L5 d: SQL', () => {
  it('the holder reads the exact snapshot and counts statements', () => {
    expect(COUNTS_SQL).toBe("SELECT 'count|' || format('%I.%I', n.nspname, c.relname) || '|' || "
      + "(xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text "
      + 'FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace '
      + "WHERE c.relkind = 'r' AND c.relpersistence = 'p' AND n.nspname NOT IN ('pg_catalog', 'information_schema') "
      + "AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%' "
      + "AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e') "
      + 'ORDER BY n.nspname, c.relname');
    expect(SNAP_SQL).toBe("SELECT 'snap|' || pg_export_snapshot() || '|' || (CASE WHEN pg_is_in_recovery() THEN 't' ELSE 'f' END) || '|' || "
      + "pg_database_size(current_database()) || '|' || "
      + "coalesce((extract(epoch FROM (CASE WHEN pg_is_in_recovery() THEN pg_last_xact_replay_timestamp() ELSE now() END)) * 1000)::bigint::text, '-1')");
    expect(holderStdin(30)).toBe(`SET idle_in_transaction_session_timeout = '30s';\nBEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n${SNAP_SQL};\n${COUNTS_SQL};\nSELECT 'end|';\n`);
  });
});

describe('NM2 L5 d: parsers', () => {
  it('only a trailing carriage return is cut', () => {
    expect(parseCountLines('count|a\rb|5\r\ncount|c|7\r')).toEqual({ ok: true, counts: { 'a\rb': 5, c: 7 } });
  });

  it('refuses an empty name, a signed or partly numeric count, and quotes at most 200 characters', () => {
    expect(parseCountLines('count||5')).toEqual({ ok: false, error: 'a table count read back as count||5' });
    expect(parseCountLines('count|a|-5')).toEqual({ ok: false, error: 'a table count read back as count|a|-5' });
    expect(parseCountLines('count|a|x5').ok).toBe(false);
    expect(parseCountLines('count|a|5x').ok).toBe(false);
    expect(parseCountLines('count|a|5e2').ok).toBe(false);
    const long = `count|${'t'.repeat(300)}|x`;
    expect(parseCountLines(long)).toEqual({ ok: false, error: `a table count read back as ${long.slice(0, 200)}` });
  });

  it('df: trims, splits on runs of spaces, and wants a whole number', () => {
    expect(parseDfFreeKb('\nFilesystem 1024-blocks Used Available Capacity\n/dev/x  100  50  42  50% /d\n')).toBe(42);
    expect(parseDfFreeKb('h\n/dev/x 100 50 abc 50% /d')).toBeNull();
    expect(parseDfFreeKb('h\n/dev/x 100 50 x5 50% /d')).toBeNull();
    expect(parseDfFreeKb('h\n/dev/x 100 50 5x 50% /d')).toBeNull();
  });

  it('stderr past the kept length is not read; lines are trimmed', () => {
    expect(isRecoveryConflict(`${'x'.repeat(4000)}conflict with recovery`)).toBe(false);
    expect(errorLine('  first\n  last  ')).toBe('last');
  });
});

describe('NM2 L5 d: compareCounts', () => {
  it('same counts give an empty text; extras are listed by name', () => {
    expect(compareCounts({ a: 1 }, { a: 1 })).toEqual({ ok: true, text: '' });
    expect(compareCounts({}, { b: 1, a: 1 }).text).toBe('2 table(s) differ from the counts recorded when the backup was taken: a: not in the recorded counts; b: not in the recorded counts');
  });

  it('five differences have no tail; six list five and say one more', () => {
    const five = { a: 1, b: 1, c: 1, d: 1, e: 1 };
    expect(compareCounts(five, {}).text).toBe('5 table(s) differ from the counts recorded when the backup was taken: a: missing after the restore; b: missing after the restore; c: missing after the restore; d: missing after the restore; e: missing after the restore');
    expect(compareCounts({ ...five, f: 1 }, {}).text).toBe('6 table(s) differ from the counts recorded when the backup was taken: a: missing after the restore; b: missing after the restore; c: missing after the restore; d: missing after the restore; e: missing after the restore, and 1 more');
  });
});

describe('NM2 L5 d: validateDumpMeta', () => {
  it('accepts a zero count, a null dataAt and every kind', () => {
    expect(err(meta())).toBe('ok');
    for (const kind of ['hourly', 'daily', 'safety', 'other']) expect(err(meta({ kind }))).toBe('ok');
  });

  it('names each fault in the operator text', () => {
    expect(err(5)).toBe('the counts file holds no object');
    expect(err(null)).toBe('the counts file holds no object');
    expect(err(meta({ file: 'x.json' }))).toBe('the counts file names no dump');
    expect(err(meta({ file: 5 }))).toBe('the counts file names no dump');
    expect(err(meta({ takenAt: 'x' }))).toBe('the counts file has no time it was taken');
    expect(err(meta({ family: 'x' }))).toBe('the counts file names no family');
    expect(err(meta({ kind: 'bogus' }))).toBe('the counts file names no kind');
    expect(err(meta({ inRecovery: 'yes' }))).toBe('the counts file has no database state');
    expect(err(meta({ dataAt: 'x' }))).toBe('the counts file has no database state');
    expect(err(meta({ dbBytes: -1 }))).toBe('the counts file has no database state');
    expect(err(meta({ dataAt: 5 }))).toBe('ok');
    expect(err(meta({ counts: null }))).toBe('the counts file has no counts');
    expect(err(meta({ counts: 'str' }))).toBe('the counts file has no counts');
    expect(err(meta({ counts: [] }))).toBe('the counts file has no counts');
    expect(err(meta({ counts: { a: -1, b: 6 } }))).toBe('a count in the counts file is not a whole number of 0 or more');
    expect(err(meta({ rows: 4 }))).toBe('the totals in the counts file do not match its counts');
  });
});
