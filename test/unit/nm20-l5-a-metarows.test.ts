import { describe, expect, it } from 'vitest';
import { metaRowsSql, parseMetaRows, type MetaParse, type MetaRows } from '../../src/instance/switchSql';

const T0 = '2026-01-01 00:00:00+00';
const GEN_HEAD = '-- Data for Name: generation; Type: TABLE DATA; Schema: smdb_manager; Owner: -\n\n';
const GEN_COPY = 'COPY smdb_manager.generation (one_row, machine, generation, since) FROM stdin;\n';

/** Parses with a cap on regex runs, so a loop that never ends throws inside the row. */
function guarded(text: string, check: (row: unknown) => unknown = () => null): MetaParse {
  const exec = RegExp.prototype.exec;
  let calls = 0;
  RegExp.prototype.exec = function (this: RegExp, s: string) {
    if (++calls > 100000) throw new Error('the parser did not stop');
    return exec.call(this, s);
  };
  try {
    return parseMetaRows(text, check as never);
  } finally {
    RegExp.prototype.exec = exec;
  }
}

const gen = (line: string, copy = GEN_COPY) => guarded(`${GEN_HEAD}${copy}${line}\n\\.\n`);
const genRow = (fields: { one_row?: string; machine?: string; generation?: string; since?: string }) =>
  gen([fields.one_row ?? 't', fields.machine ?? 'm1', fields.generation ?? '5', fields.since ?? T0].join('\t'));
const problem = (col: string, why: string) => ({ ok: false, problem: `line 4: column ${col} of smdb_manager.generation ${why}` });

function okScript(r: MetaParse): string {
  expect(r.ok).toBe(true);
  return r.ok ? r.script : '';
}

describe('NM20 L5 a: the COPY and entry lines', () => {
  it('refuses a COPY line that holds the manager table only after other text', () => {
    const r = guarded(`COPY public.t COPY smdb_manager.generation (one_row, machine, generation, since) FROM stdin;\nt\tm1\t5\t${T0}\n\\.\n`);
    expect(r).toEqual({ ok: false, problem: "line 1: a COPY line that is not for one of the manager's five tables in smdb_manager" });
  });

  it('refuses a COPY line with text after FROM stdin;', () => {
    const r = guarded(`COPY smdb_manager.generation (one_row, machine, generation, since) FROM stdin; x\nt\tm1\t5\t${T0}\n\\.\n`);
    expect(r).toEqual({ ok: false, problem: "line 1: a COPY line that is not for one of the manager's five tables in smdb_manager" });
  });

  it('ignores an entry header that does not start the line', () => {
    const r = guarded('x -- Name: f; Type: FUNCTION; Schema: smdb_manager\n');
    expect(r).toEqual({ ok: true, script: '', counts: { generation: 0, handover: 0, received: 0, copies: 0, addresses: 0 }, skipped: { check: 0, cap: 0 } });
  });

  it('reads an entry header that ends at its schema', () => {
    const r = guarded('-- Name: f; Type: FUNCTION; Schema: smdb_manager\n');
    expect(r).toEqual({ ok: false, problem: 'line 1: the entry f in smdb_manager is FUNCTION, not table data' });
  });
});

describe('NM20 L5 a: timestamps', () => {
  const real = 'is not a real calendar time';
  const notTs = 'is not a timestamp with an offset';
  it.each([
    ['x2026-01-01 00:00:00+00', notTs],
    ['2026-01-01 00:00:00+00x', notTs],
    ['2025-02-29 00:00:00+00', real],
    ['1900-02-29 00:00:00+00', real],
    ['2026-01-00 00:00:00+00', real],
    ['0000-01-01 00:00:00+00', real],
    ['2026-01-01 00:60:00+00', real],
    ['2026-01-01 00:00:60+00', real],
    ['2026-01-01 00:00:00+05:60', real],
    ['2026-01-01 00:00:00+05:00:60', real],
    ['2026-01-01 00:00:00+15:00:01', real],
  ])('refuses %s', (since, why) => {
    expect(genRow({ since })).toEqual(problem('since', why));
  });

  it.each([
    '2026-01-01 00:00:00+05:30:15',
    '2000-02-29 00:00:00+00',
    '2024-02-29 00:00:00+00',
    '0001-01-01 00:00:00+00',
    '2026-01-01 00:00:00+15:00',
    '2026-01-01 00:00:00-15:00',
  ])('keeps %s', (since) => {
    expect(okScript(genRow({ since }))).toContain(`'${since}'::timestamptz`);
  });
});

describe('NM20 L5 a: COPY field decoding', () => {
  it('keeps an escaped N that is not the whole field as the letter', () => {
    expect(okScript(genRow({ machine: '\\Nabc' }))).toContain("'Nabc'");
  });

  it('reads \\x not followed by a hex digit as the letter x', () => {
    expect(okScript(genRow({ machine: '\\xg4' }))).toContain("'xg4'");
  });

  it('decodes octal, hex and letter escapes', () => {
    expect(okScript(genRow({ machine: 'a\\101b' }))).toContain("'aAb'");
    expect(okScript(genRow({ machine: 'a\\x41b' }))).toContain("'aAb'");
    expect(okScript(genRow({ machine: 'a\\x4' }))).toContain("'a\x04'");
    expect(okScript(genRow({ machine: 'a\\nb' }))).toContain("'a\nb'");
  });

  it('refuses a carriage return that is not escaped', () => {
    expect(genRow({ machine: 'a\rb' })).toEqual(problem('machine', 'holds a carriage return that is not escaped'));
    expect(genRow({ machine: '\rb' })).toEqual(problem('machine', 'holds a carriage return that is not escaped'));
  });

  it('refuses a field that ends with a lone backslash', () => {
    const r = gen(`t\t5\t${T0}\tabc\\`, 'COPY smdb_manager.generation (one_row, generation, since, machine) FROM stdin;\n');
    expect(r).toEqual(problem('machine', 'ends with a lone backslash'));
  });
});

describe('NM20 L5 a: column values', () => {
  it('reads f as false, then refuses it for one_row', () => {
    expect(genRow({ one_row: 'f' })).toEqual(problem('one_row', 'is not t'));
  });

  it.each(['+5', '1e3'])('refuses the bigint %s', (generation) => {
    expect(genRow({ generation })).toEqual(problem('generation', 'is not a whole number in the safe-integer range'));
  });

  const addr = (port: string) => guarded(
    '-- Data for Name: addresses; Type: TABLE DATA; Schema: smdb_manager; Owner: -\n\n'
    + 'COPY smdb_manager.addresses (host, port, slot, cert, machine, updated_at) FROM stdin;\n'
    + `h.example\t${port}\t\\N\tCERT\tm1\t${T0}\n\\.\n`,
    (row) => row,
  );
  it.each(['2147483647', '-2147483648'])('keeps the port %s, the integer range ends', (port) => {
    const r = addr(port);
    expect(r.ok && [r.counts.addresses, r.skipped.check]).toEqual([1, 0]);
    expect(okScript(r)).toContain(`'h.example', ${port}, NULL`);
  });
  it.each(['2147483648', '-2147483649'])('skips the port %s, outside the integer range', (port) => {
    const r = addr(port);
    expect(r.ok && [r.counts.addresses, r.skipped.check]).toEqual([0, 1]);
  });
});

describe('NM20 L5 a: metaRowsSql', () => {
  const rows = (generation: MetaRows['generation']): MetaRows => ({ generation, handover: [], received: [], copies: [], addresses: [] });
  it('refuses a bool column holding text', () => {
    expect(() => metaRowsSql(rows([{ one_row: 'x', machine: 'm', generation: 1, since: T0 }])))
      .toThrow(new Error('column one_row of smdb_manager.generation is not a bool value'));
  });
  it('writes false for a false bool', () => {
    expect(metaRowsSql(rows([{ one_row: false, machine: 'm', generation: 1, since: T0 }])))
      .toBe(`INSERT INTO smdb_manager.generation (one_row, machine, generation, since) VALUES (false, 'm', 1, '${T0}'::timestamptz);\n`);
  });
  it('refuses a NULL or a missing value in a column that is not nullable', () => {
    expect(() => metaRowsSql(rows([{ one_row: true, machine: null, generation: 1, since: T0 }])))
      .toThrow(new Error('column machine of smdb_manager.generation is NULL'));
    expect(() => metaRowsSql(rows([{ one_row: true, generation: 1, since: T0 }])))
      .toThrow(new Error('column machine of smdb_manager.generation is NULL'));
  });
});
