import { describe, expect, it } from 'vitest';
import { parseOwnerClusterRead } from '../../src/instance/keptData';

/** S1's stdout as psql -X -q -tA prints it: pg_sleep's void result is an empty line. */
const s1 = (restoreRow: string | null, sessions2 = 0) => [
  't', 'recovery|false', 'admin|missing', 'sessions|0', `restorekind|${restoreRow === null ? '-' : 'r'}`,
  ...(restoreRow === null ? [] : [`restore|${restoreRow}`]), '', `sessions2|${sessions2}`, '',
].join('\n');

describe('nm34 l5 b: parseOwnerClusterRead on the lines S1 prints', () => {
  it('reads a plain restore record and both session counts', () => {
    expect(parseOwnerClusterRead(s1('false|f.dump|2026-11-16T10:00:00Z|2|m|', 1))).toEqual({
      superuser: true, recovery: false, admin: 'missing', sessions: [0, 1],
      restore: { pending: false, file: 'f.dump', at: '2026-11-16T10:00:00Z', floor: { generation: 2, machine: 'm', since: null } },
    });
  });

  it('a restore file name holding a newline and a sessions2 line makes the read unusable, not a count of 3', () => {
    const text = s1('false|x\nsessions2|3\ny|2026-11-16T10:00:00Z|2|m|', 0);
    expect(parseOwnerClusterRead(text)).toBeUndefined();
  });

  it('a restore file name holding a CR makes the read unusable', () => {
    expect(parseOwnerClusterRead(s1('false|a\rb.dump|2026-11-16T10:00:00Z|2|m|'))).toBeUndefined();
  });

  it('a restore file name holding a CR and a second restore| is not read as that second record', () => {
    expect(parseOwnerClusterRead(s1('false|a\rrestore|true|b.dump|2026-11-16T10:00:00Z|2|m|'))).toBeUndefined();
  });
});
