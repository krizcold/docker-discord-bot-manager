import { describe, it, expect } from 'vitest';
import { restoreLists } from '../../src/instance/fleetBackup';
import { hasPsqlStopLine, stoppedBeforeCommit } from '../../src/instance/switchSql';

describe('NM22 L5 i: large-object entries match only at the line start', () => {
  it('keeps a table whose quoted name holds the text of a large object data entry', () => {
    const table = '215; 1259 16386 TABLE public x1; 2 3 BLOBS y postgres';
    const toc = `;\n${table}\n216; 0 16386 TABLE DATA public t postgres`;
    const res = restoreLists(toc, '');
    expect(res.refused).toBeNull();
    expect(res.other.split('\n')).toContain(table);
  });

  it('keeps a table whose quoted name holds the text of a large object comment entry', () => {
    const table = '215; 1259 16386 TABLE public x1; 0 0 COMMENT - LARGE OBJECT 5 y postgres';
    const toc = `;\n${table}`;
    const res = restoreLists(toc, '');
    expect(res.refused).toBeNull();
    expect(res.other.split('\n')).toContain(table);
  });
});

describe('NM22 L5 i: hasPsqlStopLine counts a stop line only where it starts the line', () => {
  const warning = (inner: string) => `psql:<stdin>:3: WARNING:  role "${inner}" has no settings`;

  it('pins the rule: a server stop text past the line start is no stop line', () => {
    const stderr = warning('psql:x: ERROR: y');
    expect(hasPsqlStopLine(stderr)).toBe(false);
    expect(stoppedBeforeCommit('', { ok: false, stderr })).toBe(false);
  });

  it('pins the rule: psql\'s own error text past the line start is no stop line', () => {
    const stderr = warning('psql: error: y');
    expect(hasPsqlStopLine(stderr)).toBe(false);
    expect(stoppedBeforeCommit('', { ok: false, stderr })).toBe(false);
  });

  it('takes the real stop lines', () => {
    expect(hasPsqlStopLine('psql:<stdin>:3: ERROR:  permission denied')).toBe(true);
    expect(hasPsqlStopLine('psql: error: connection to server failed')).toBe(true);
  });
});
