import { describe, expect, it, vi } from 'vitest';

// NM20 L5 writer b: MetaRowsReader's line handling, its caps and its exact refusal texts.
vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm20-l5-b-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import { MetaRowsReader, parseMetaRows } from '../../src/instance/switchSql';
import { parseAddressRows } from '../../src/instance/fleetJoin';
import { FIXTURE_PEM } from './join-fake';

const check = (row: unknown) => parseAddressRows(JSON.stringify([row]))[0] ?? null;
const parse = (text: string | Uint8Array) => parseMetaRows(text, check);
const problemOf = (text: string) => {
  const r = parse(text);
  expect(r.ok, 'the parse did not refuse').toBe(false);
  return (r as { ok: false; problem: string }).problem;
};
const CAP = 16 * 1024 * 1024;
const PEM = FIXTURE_PEM.trim();
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
const head = (name: string, type = 'TABLE DATA', schema = 'smdb_manager') => `-- Data for Name: ${name}; Type: ${type}; Schema: ${schema}; Owner: dbm_meta`;
const COPY: Record<string, string> = {
  generation: 'COPY smdb_manager.generation (one_row, machine, generation, since) FROM stdin;',
  handover: 'COPY smdb_manager.handover (one_row, slot, machine, generation, at) FROM stdin;',
  copies: 'COPY smdb_manager.copies (slot, machine, client, seen_at) FROM stdin;',
  addresses: 'COPY smdb_manager.addresses (host, port, slot, cert, machine, updated_at) FROM stdin;',
};
const T = '2026-11-13 10:20:30+00';
const GEN_ROW = `t\tm\t3\t${T}`;
const lines = (...l: string[]) => l.map(x => `${x}\n`).join('');
const addr = (i: number, pad = 0) => `h${i}.example\t${5000 + i}\t\\N\t${esc(pad ? `${PEM}\n${'A'.repeat(pad)}\n${PEM}` : PEM)}\tm${i}\t${T}`;
// An address row of exactly `size` bytes, its certificate padded after its END line.
const addrOf = (i: number, size: number) => {
  const base = Buffer.byteLength(addr(i, 1)) - 1;
  const row = addr(i, size - base);
  expect(Buffer.byteLength(row)).toBe(size);
  return row;
};

describe('an entry header not followed by its COPY line', () => {
  it('at the end of the text refuses with the line and the entry', () => {
    expect(problemOf(lines('--', head('generation'), '--', ''))).toBe('line 4: the table data entry generation in smdb_manager is not followed by its COPY line');
  });

  it('a long entry name is cut to 64 characters', () => {
    expect(problemOf(lines(head('n'.repeat(100)), '--'))).toBe(`line 2: the table data entry ${'n'.repeat(64)} in smdb_manager is not followed by its COPY line`);
  });

  it('a second header right after the first refuses at the second', () => {
    expect(problemOf(lines(head('generation'), head('handover'), COPY.handover, '\\.'))).toBe('line 2: the table data entry generation in smdb_manager is not followed by its COPY line');
  });

  it('a statement line between the header and its COPY line refuses', () => {
    expect(problemOf(lines(head('generation'), 'SET x = 1;', COPY.generation, GEN_ROW, '\\.'))).toBe('line 2: the table data entry generation in smdb_manager is not followed by its COPY line');
  });

  it('a comment line between the header and its COPY line is ignored', () => {
    expect(parse(lines(head('generation'), '-- a comment', COPY.generation, GEN_ROW, '\\.'))).toMatchObject({ ok: true, counts: { generation: 1 } });
  });

  it('a header of another schema is ignored', () => {
    expect(parse(lines(head('t', 'TABLE DATA', 'public'), COPY.generation, GEN_ROW, '\\.'))).toMatchObject({ ok: true, counts: { generation: 1 } });
  });

  it('an entry that is not table data names its entry and type, cut to 64 and 32', () => {
    expect(problemOf(lines(head('n'.repeat(100), 'T'.repeat(50))))).toBe(`line 1: the entry ${'n'.repeat(64)} in smdb_manager is ${'T'.repeat(32)}, not table data`);
  });
});

describe('the COPY line and the rows', () => {
  it('a column of another name refuses with both lists', () => {
    expect(problemOf(lines('COPY smdb_manager.generation (one_row, machine, generation, wrong) FROM stdin;', '\\.')))
      .toBe('line 1: the COPY line of smdb_manager.generation names the columns (one_row, machine, generation, wrong), not (one_row, machine, generation, since)');
  });

  it('generation 1 is kept, and a handover row of generation 0 is kept', () => {
    expect(parse(lines(COPY.generation, `t\tm\t1\t${T}`, '\\.', COPY.handover, `t\tslot_a\tm\t0\t${T}`, '\\.')))
      .toMatchObject({ ok: true, counts: { generation: 1, handover: 1 } });
  });

  it('a second handover row refuses as more than one row', () => {
    expect(problemOf(lines(COPY.handover, `t\tslot_a\tm\t2\t${T}`, `t\tslot_b\tm\t3\t${T}`, '\\.'))).toBe('line 3: smdb_manager.handover has more than one row');
  });

  it('a text whose last line has no newline still reads that line', () => {
    expect(parse(`${lines(COPY.copies, `s\t\\N\t\\N\t${T}`)}\\.`)).toMatchObject({ ok: true, counts: { copies: 1 } });
  });

  it('chunks pushed after a refusal are dropped, not kept', () => {
    const r = new MetaRowsReader(check);
    r.push(Buffer.from('COPY smdb_manager.bogus (a) FROM stdin;\n'));
    r.push(Buffer.alloc(1 << 20, 0x41));
    const fields = r as unknown as { pending: Uint8Array[]; pendingSize: number };
    expect(fields.pending).toHaveLength(0);
    expect(fields.pendingSize).toBe(0);
    expect(r.end()).toEqual({ ok: false, problem: "line 1: a COPY line that is not for one of the manager's five tables in smdb_manager" });
  });

  it('a line counted after a skipped address line keeps its number', () => {
    expect(problemOf(lines(COPY.addresses, 'x'.repeat(70000), '\\.', 'COPY smdb_manager.other (a) FROM stdin;')))
      .toBe("line 4: a COPY line that is not for one of the manager's five tables in smdb_manager");
  });
});

describe('address lines past 64 KiB', () => {
  it('a valid row of exactly 64 KiB is kept; one of 100000 bytes is skipped', () => {
    expect(parse(lines(COPY.addresses, addrOf(1, 65536), '\\.'))).toMatchObject({ ok: true, counts: { addresses: 1 }, skipped: { check: 0, cap: 0 } });
    expect(parse(lines(COPY.addresses, addrOf(1, 100000), '\\.'))).toMatchObject({ ok: true, counts: { addresses: 0 }, skipped: { check: 1, cap: 0 } });
  });

  it('a line skipped at the end of one chunk stays skipped in the next', () => {
    const reader = new MetaRowsReader(check);
    reader.push(Buffer.from(`${COPY.addresses}\n${'x'.repeat(70000)}`));
    reader.push(Buffer.from(lines(addr(1), '\\.')));
    expect(reader.end()).toMatchObject({ ok: true, counts: { addresses: 0 }, skipped: { check: 1, cap: 0 } });
  });

  it('a short row split after a 40000-byte line is kept', () => {
    const row = addr(1);
    const reader = new MetaRowsReader(check);
    reader.push(Buffer.from(`${COPY.addresses}\n${'x'.repeat(40000)}\n${row.slice(0, 50)}`));
    reader.push(Buffer.from(lines(row.slice(50), '\\.')));
    expect(reader.end()).toMatchObject({ ok: true, counts: { addresses: 1 }, skipped: { check: 1, cap: 0 } });
  });

  it('kept address rows of exactly 4 MiB in all are all kept', () => {
    const rows = Array.from({ length: 128 }, (_, i) => addrOf(i, 32767));
    expect(parse(lines(COPY.addresses, ...rows, '\\.'))).toMatchObject({ ok: true, counts: { addresses: 128 }, skipped: { check: 0, cap: 0 } });
  }, 60000);
});

describe('the 16 MiB caps', () => {
  it('a last line of exactly 16 MiB is read; one byte more refuses with its line number', () => {
    expect(parse(`\n-- ${'x'.repeat(CAP - 3)}`)).toMatchObject({ ok: true });
    expect(problemOf(`\n-- ${'x'.repeat(CAP - 2)}`)).toBe('line 2 is longer than 16 MiB');
  }, 60000);

  it('kept rows of exactly 16 MiB are read; one byte more refuses', () => {
    const text = (total: number) => {
      const d = total - (COPY.copies.length + 1) - 1;
      const pre = `a\t`;
      const post = `\t\\N\t${T}`;
      return lines(COPY.copies, `${pre}${'x'.repeat(d - pre.length - post.length)}${post}`, '\\.');
    };
    expect(parse(text(CAP))).toMatchObject({ ok: true, counts: { copies: 1 } });
    expect(problemOf(text(CAP + 1))).toBe('the smdb_manager rows are larger than 16 MiB');
  }, 60000);
});
