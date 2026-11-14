import { describe, expect, it, vi } from 'vitest';

// NM20 part 2: the smdb_manager rows read as text from pg_restore's output (X1, Y1, Y2, Y5), the INSERTs written from
// them, the receive SQL naming both logins, the grants to dbm_work, and the move code's second login (R3.6, P2).
const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm20-code-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import {
  ensureGenerationSql, GENERATION_SCHEMA_SQL, MetaRows, MetaRowsReader, metaRowsSql, parseMetaRows, raiseSql, RECEIVE_DROP_SQL,
  RECEIVE_END_SQL, RECEIVE_NOLOGIN_SQL,
} from '../../src/instance/switchSql';
import { decodeMoveCode, encodeMoveCode } from '../../src/config/joinCode';
import { parseAddressRows } from '../../src/instance/fleetJoin';
import { COPY_PEM, FIXTURE_PEM, fakeJoin } from './join-fake';

// fleetJoin's validAddress, reached through its exported list parse.
const check = (row: unknown) => parseAddressRows(JSON.stringify([row]))[0] ?? null;

const PEM = FIXTURE_PEM.trim();
const PEM_COPY = COPY_PEM.trim();
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');

const HEAD = `--
-- PostgreSQL database dump
--

\\restrict Zk3v9QWm1bXo4TfLr8yHcN2sJpE6uAdG7hRiKqY5wVtB0nOlMxSaCzUeDgF

-- Dumped from database version 16.11
-- Dumped by pg_dump version 16.11

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

`;
const TAIL = `--
-- PostgreSQL database dump complete
--

\\unrestrict Zk3v9QWm1bXo4TfLr8yHcN2sJpE6uAdG7hRiKqY5wVtB0nOlMxSaCzUeDgF

`;
const COLS: Record<string, string> = {
  addresses: 'host, port, slot, cert, machine, updated_at',
  copies: 'slot, machine, client, seen_at',
  generation: 'one_row, machine, generation, since',
  handover: 'one_row, slot, machine, generation, at',
  received: 'push_id, from_system_id, from_machine, generation, at',
};
const entry = (t: string, lines: string[], cols = COLS[t]) => `--
-- Data for Name: ${t}; Type: TABLE DATA; Schema: smdb_manager; Owner: dbm_meta
--

COPY smdb_manager.${t} (${cols}) FROM stdin;
${lines.map(l => `${l}\n`).join('')}\\.


`;
const dump = (...entries: string[]) => `${HEAD}${entries.join('')}${TAIL}`;

const ADDR_MAIN = `main.example\t5433\t\\N\t${esc(PEM)}\tmain.example\t2026-11-13 10:20:30.123456+00`;
const ADDR_COPY = `copy.example\t5440\tsmdb_copy_a\t${esc(PEM_COPY)}\tcopy \\\\ 'one'\t2026-11-13 10:22:01+00`;
const REAL = dump(
  entry('addresses', [ADDR_MAIN, ADDR_COPY]),
  entry('copies', ['smdb_copy_a\tcopy.example\t172.18.0.5\t2026-11-13 10:22:03.25+00', 'smdb_copy_b\t\\N\t\\N\t2026-11-13 10:22:04+00']),
  entry('generation', ['t\tmain.example\t3\t2026-11-13 10:20:30.5+00']),
  entry('handover', []),
  entry('received', ['0123456789abcdef01234567\t7349081263451237\tm\\tab\\\\x \'q\' é\t2\t2026-11-12 09:00:00.000001+05:30']),
);
const parse = (text: string | Uint8Array) => parseMetaRows(text, check);
const problemOf = (text: string | Uint8Array) => {
  const r = parse(text);
  expect(r.ok, 'the parse did not refuse').toBe(false);
  return (r as { ok: false; problem: string }).problem;
};

describe('X1: the smdb_manager rows of pg_restore -f - as text', () => {
  it('the five tables as pg_restore prints them: the script inserts each row with literals', () => {
    const r = parse(REAL);
    expect(r).toMatchObject({ ok: true, counts: { addresses: 2, copies: 2, generation: 1, handover: 0, received: 1 }, skipped: { check: 0, cap: 0 } });
    const script = (r as { script: string }).script;
    const statements = script.split(/;\n(?=INSERT|$)/).filter(Boolean);
    expect(statements).toHaveLength(6);
    expect(statements.every(l => l.startsWith('INSERT INTO smdb_manager.'))).toBe(true);
    expect(script).toContain("INSERT INTO smdb_manager.generation (one_row, machine, generation, since) VALUES (true, 'main.example', 3, '2026-11-13 10:20:30.5+00'::timestamptz);");
    expect(script).toContain("INSERT INTO smdb_manager.received (push_id, from_system_id, from_machine, generation, at) VALUES ('0123456789abcdef01234567', '7349081263451237', 'm\tab\\x ''q'' é', 2, '2026-11-12 09:00:00.000001+05:30'::timestamptz);");
    expect(script).toContain("INSERT INTO smdb_manager.copies (slot, machine, client, seen_at) VALUES ('smdb_copy_b', NULL, NULL, '2026-11-13 10:22:04+00'::timestamptz);");
    expect(script).toContain(`INSERT INTO smdb_manager.addresses (host, port, slot, cert, machine, updated_at) VALUES ('main.example', 5433, NULL, '${PEM}', 'main.example', '2026-11-13 10:20:30.123456+00'::timestamptz);`);
    expect(script).toContain(`VALUES ('copy.example', 5440, 'smdb_copy_a', '${PEM_COPY}', 'copy \\ ''one''', `);
    expect(script).not.toMatch(/COPY|ALTER|DROP|SET /);
  });

  it('a column list in another order maps each value to its column', () => {
    const r = parse(dump(entry('generation', ['main.example\t2026-11-13 10:20:30+00\t4\tt'], 'machine, since, generation, one_row'))) as { script: string };
    expect(r.script).toBe("INSERT INTO smdb_manager.generation (one_row, machine, generation, since) VALUES (true, 'main.example', 4, '2026-11-13 10:20:30+00'::timestamptz);\n");
  });

  it('no block at all: no rows and an empty script', () => {
    expect(parse(`${HEAD}${TAIL}`)).toEqual({ ok: true, script: '', counts: { generation: 0, handover: 0, received: 0, copies: 0, addresses: 0 }, skipped: { check: 0, cap: 0 } });
  });

  it.each([
    ['an extra column', dump(entry('generation', ['t\tm\t3\t2026-11-13 10:20:30+00\tx'], 'one_row, machine, generation, since, extra')), /line \d+: the COPY line of smdb_manager\.generation names the columns \(one_row, machine, generation, since, extra\), not \(one_row, machine, generation, since\)/],
    ['a missing column', dump(entry('generation', ['t\tm\t3'], 'one_row, machine, generation')), /names the columns \(one_row, machine, generation\), not/],
    ['a column named twice', dump(entry('generation', ['t\tm\t3\t3'], 'one_row, machine, generation, generation')), /names the columns/],
    ['a second block', dump(entry('received', []), entry('received', [])), /line \d+: smdb_manager\.received has a second block of rows/],
    ['a bad bigint', dump(entry('generation', ['t\tm\t3x\t2026-11-13 10:20:30+00'])), /line \d+: column generation of smdb_manager\.generation is not a whole number/],
    ['a bigint past the safe-integer range', dump(entry('received', ['p\ts\tm\t9007199254740993\t2026-11-13 10:20:30+00'])), /column generation of smdb_manager\.received is not a whole number in the safe-integer range/],
    ['an offset-less timestamp', dump(entry('generation', ['t\tm\t3\t2026-11-13 10:20:30'])), /line \d+: column since of smdb_manager\.generation is not a timestamp with an offset/],
    ['infinity as a timestamp', dump(entry('copies', ['s\t\\N\t\\N\tinfinity'])), /column seen_at of smdb_manager\.copies is not a timestamp with an offset/],
    ['a duplicate key', dump(entry('received', ['p\ts\tm\t1\t2026-11-13 10:20:30+00', 'p\ts2\tm2\t2\t2026-11-13 10:20:31+00'])), /line \d+: smdb_manager\.received has a second row with the same push_id/],
    ['a second generation row', dump(entry('generation', ['t\tm\t3\t2026-11-13 10:20:30+00', 't\tn\t4\t2026-11-13 10:20:30+00'])), /smdb_manager\.generation has more than one row/],
    ['a COPY line for another table in smdb_manager', `${HEAD}COPY smdb_manager.restore_state (one_row) FROM stdin;\nt\n\\.\n${TAIL}`, /line \d+: a COPY line that is not for one of the manager's five tables in smdb_manager/],
    ['a NULL in a NOT NULL column', dump(entry('handover', ['t\t\\N\tm\t3\t2026-11-13 10:20:30+00'])), /column slot of smdb_manager\.handover is NULL/],
    ['a row with too few values', dump(entry('copies', ['s\t\\N\t2026-11-13 10:20:30+00'])), /line \d+: a row of smdb_manager\.copies has 3 values for 4 columns/],
    ['a bool that is not t or f', dump(entry('generation', ['true\tm\t3\t2026-11-13 10:20:30+00'])), /column one_row of smdb_manager\.generation is not t or f/],
    ['the dump ends inside a block', `${HEAD}COPY smdb_manager.copies (${COLS.copies}) FROM stdin;\ns\t\\N\t\\N\t2026-11-13 10:20:30+00\n`, /the dump ends inside the rows of smdb_manager\.copies/],
  ])('%s refuses', (_n, text, why) => {
    expect(problemOf(text)).toMatch(why);
  });

  it('more than 10000 rows in one table refuses', () => {
    const rows = Array.from({ length: 10001 }, (_, i) => `slot_${i}\t\\N\t\\N\t2026-11-13 10:20:30+00`);
    expect(problemOf(dump(entry('copies', rows)))).toMatch(/smdb_manager\.copies has more than 10000 rows/);
    expect(parse(dump(entry('copies', rows.slice(0, 10000))))).toMatchObject({ ok: true, counts: { copies: 10000 } });
  });

  it('every other line is ignored, and nothing from it reaches the script', () => {
    const text = dump(entry('generation', ['t\tm\t3\t2026-11-13 10:20:30+00'])).replace('SET row_security = off;', "SET row_security = off;\nALTER ROLE smdb SUPERUSER;\nSELECT pg_terminate_backend(1);");
    const r = parse(text) as { ok: true; script: string };
    expect(r.ok).toBe(true);
    expect(r.script).not.toMatch(/SUPERUSER|pg_terminate_backend/);
  });

  it('chunks split anywhere, inside a line and inside a character, give the same answer', () => {
    const bytes = Buffer.from(REAL, 'utf-8');
    const whole = parse(bytes);
    for (const size of [1, 2, 3, 7, 64, 1000]) {
      const reader = new MetaRowsReader(check);
      for (let i = 0; i < bytes.length; i += size) reader.push(bytes.subarray(i, i + size));
      expect(reader.end()).toEqual(whole);
    }
  });

  it('the kept rows past 16 MiB refuse; skipped addresses rows do not count', () => {
    const big = 'x'.repeat(9 * 1024 * 1024);
    expect(problemOf(dump(entry('copies', [`a\t${big}\t\\N\t2026-11-13 10:20:30+00`, `b\t${big}\t\\N\t2026-11-13 10:20:30+00`])))).toMatch(/the smdb_manager rows are larger than 16 MiB/);
    const bad = Array.from({ length: 20 }, (_, i) => `h${i}.example\t5432\t\\N\t${'y'.repeat(1024 * 1024)}\tm\t2026-11-13 10:20:30+00`);
    expect(parse(dump(entry('addresses', [...bad, ADDR_MAIN])))).toMatchObject({ ok: true, counts: { addresses: 1 }, skipped: { check: 20, cap: 0 } });
  }, 60000);
});

describe('B1: no addresses row refuses the read by its size', () => {
  // A certificate validAddress accepts, padded after its END line: OpenSSL reads the first block only.
  const padded = (bytes: number) => `${PEM}\n${'A'.repeat(bytes)}\n${PEM}`;
  const row = (i: number, cert: string) => `h${i}.example\t${5000 + i}\t\\N\t${esc(cert)}\tm${i}\t2026-11-13 10:20:30+00`;
  const GEN = entry('generation', ['t\tm\t3\t2026-11-13 10:20:30+00']);

  it('a 17 MiB address line is skipped and counted, whole or fed in 64 KiB chunks, and the rows around it are kept', () => {
    const text = dump(entry('addresses', [row(1, padded(17 * 1024 * 1024)), ADDR_MAIN]), GEN);
    const want = { ok: true, counts: { addresses: 1, generation: 1 }, skipped: { check: 1, cap: 0 } };
    expect(parse(text)).toMatchObject(want);
    const bytes = Buffer.from(text, 'utf-8');
    const reader = new MetaRowsReader(check);
    for (let i = 0; i < bytes.length; i += 64 * 1024) reader.push(bytes.subarray(i, i + 64 * 1024));
    expect(reader.end()).toMatchObject(want);
  }, 60000);

  it('1000 valid rows padded to 17 KiB: kept up to 4 MiB in all, the rest skipped and counted', () => {
    expect(check({ host: 'h.example', port: 5432, slot: null, cert: padded(17 * 1024), machine: 'm' })).not.toBeNull();
    const rows = Array.from({ length: 1000 }, (_, i) => row(i, padded(17 * 1024)));
    let kept = 0;
    for (let total = 0; kept < rows.length && total + Buffer.byteLength(rows[kept]) + 1 <= 4 * 1024 * 1024; kept++) total += Buffer.byteLength(rows[kept]) + 1;
    const r = parse(dump(entry('addresses', rows), GEN));
    expect(r).toMatchObject({ ok: true, counts: { addresses: kept, generation: 1 }, skipped: { check: 1000 - kept, cap: 0 } });
    expect(kept).toBeGreaterThan(200);
  }, 60000);

  it('kept address rows do not count toward the other tables\' 16 MiB; those tables past 16 MiB still refuse', () => {
    const addresses = Array.from({ length: 150 }, (_, i) => row(i, padded(17 * 1024)));
    const copies = (mib: number) => [`a\t${'x'.repeat(mib * 1024 * 1024)}\t\\N\t2026-11-13 10:20:30+00`];
    expect(parse(dump(entry('addresses', addresses), entry('copies', copies(15))))).toMatchObject({ ok: true, counts: { addresses: 150, copies: 1 } });
    expect(problemOf(dump(entry('addresses', addresses), entry('copies', [...copies(9), ...copies(8).map(l => l.replace(/^a/, 'b'))])))).toMatch(/the smdb_manager rows are larger than 16 MiB/);
  }, 60000);
});

describe('Y1: addresses rows are skipped, never refused', () => {
  const good = (i: number) => `h${i}.example\t${5000 + (i % 1000)}\t${i % 2 ? `slot_${i}` : '\\N'}\t${esc(PEM)}\tm${i}\t2026-11-13 10:20:30+00`;
  it('port 0, updated_at infinity, a bad certificate and 1200 good rows: 1000 kept, 3 and 200 skipped', () => {
    const rows = [
      `bad1.example\t0\t\\N\t${esc(PEM)}\tm\t2026-11-13 10:20:30+00`,
      `bad2.example\t5432\t\\N\t${esc(PEM)}\tm\tinfinity`,
      `bad3.example\t5432\t\\N\t-----BEGIN CERTIFICATE-----\\nAAAA\\n-----END CERTIFICATE-----\tm\t2026-11-13 10:20:30+00`,
      ...Array.from({ length: 1200 }, (_, i) => good(i)),
    ];
    const r = parse(dump(entry('addresses', rows), entry('generation', ['t\tm\t3\t2026-11-13 10:20:30+00'])));
    expect(r).toMatchObject({ ok: true, counts: { addresses: 1000, generation: 1 }, skipped: { check: 3, cap: 200 } });
    const script = (r as { script: string }).script;
    expect(script).toContain("'h0.example', 5000");
    expect(script).toContain("'h999.example', 5999");
    expect(script).not.toContain("'h1000.example'");
    expect(script).not.toMatch(/bad[123]\.example/);
  });
  it('a repeated host and port, a NUL escape, the wrong number of values: skipped', () => {
    const r = parse(dump(entry('addresses', [
      ADDR_MAIN,
      ADDR_MAIN.replace('main.example\t5433', 'main.example\t5433'),
      `nul.example\t5432\t\\N\t${esc(PEM)}\tm\\000x\t2026-11-13 10:20:30+00`,
      `short.example\t5432\t\\N`,
    ])));
    expect(r).toMatchObject({ ok: true, counts: { addresses: 1 }, skipped: { check: 3, cap: 0 } });
  });
  it('a missing COPY line after the addresses entry still refuses (Y5)', () => {
    const text = `${HEAD}--\n-- Data for Name: addresses; Type: TABLE DATA; Schema: smdb_manager; Owner: dbm_meta\n--\n\nDELETE FROM smdb_manager.addresses;\n${TAIL}`;
    expect(problemOf(text)).toMatch(/line \d+: the table data entry addresses in smdb_manager is not followed by its COPY line/);
  });
});

describe('Y2: every check the DDL makes, before anything changes', () => {
  it.each([
    ['one_row f', dump(entry('generation', ['f\tm\t3\t2026-11-13 10:20:30+00'])), /column one_row of smdb_manager\.generation is not t/],
    ['handover one_row f', dump(entry('handover', ['f\ts\tm\t3\t2026-11-13 10:20:30+00'])), /column one_row of smdb_manager\.handover is not t/],
    ['generation 0', dump(entry('generation', ['t\tm\t0\t2026-11-13 10:20:30+00'])), /column generation of smdb_manager\.generation is below 1/],
    ['\\000 in machine', dump(entry('generation', ['t\tm\\000x\t3\t2026-11-13 10:20:30+00'])), /column machine of smdb_manager\.generation holds a NUL character/],
    ['\\x0 in machine', dump(entry('generation', ['t\tm\\x0\t3\t2026-11-13 10:20:30+00'])), /holds a NUL character/],
    ['\\400 in machine (the octal escape keeps the low byte)', dump(entry('generation', ['t\tm\\400\t3\t2026-11-13 10:20:30+00'])), /holds a NUL character/],
    ['2026-02-31', dump(entry('generation', ['t\tm\t3\t2026-02-31 10:20:30+00'])), /column since of smdb_manager\.generation is not a real calendar time/],
    ['hour 24', dump(entry('generation', ['t\tm\t3\t2026-11-13 24:00:00+00'])), /is not a real calendar time/],
    ['an offset past 15 hours', dump(entry('generation', ['t\tm\t3\t2026-11-13 10:00:00+15:30'])), /is not a real calendar time/],
    ['an escape that makes bytes that are not UTF-8', dump(entry('generation', ['t\tm\\377\t3\t2026-11-13 10:00:00+00'])), /column machine of smdb_manager\.generation is not valid UTF-8/],
    ['a backslash at the end of a line', dump(entry('generation', ['t\tm\t3\t2026-11-13 10:00:00+00\\'])), /column since of smdb_manager\.generation ends with a lone backslash/],
    ['an escaped tab joins two values into one', dump(entry('generation', ['t\tm\\\t3\t2026-11-13 10:00:00+00'])), /a row of smdb_manager\.generation has 3 values for 4 columns/],
  ])('%s refuses', (_n, text, why) => {
    expect(problemOf(text)).toMatch(why);
  });
  it('an invalid UTF-8 byte in the text refuses', () => {
    const bytes = Buffer.from(dump(entry('generation', ['t\tmX\t3\t2026-11-13 10:20:30+00'])), 'utf-8');
    bytes[bytes.indexOf('mX\t') + 1] = 0xff;
    expect(problemOf(bytes)).toMatch(/line \d+ is not valid UTF-8 text/);
  });
  it('29 February in a leap year, octal and hex escapes of real characters: accepted', () => {
    const r = parse(dump(entry('generation', ['t\t\\303\\251\\x41\\q\t3\t2024-02-29 23:59:59.999999-03:30']))) as { script: string };
    expect(r.script).toBe("INSERT INTO smdb_manager.generation (one_row, machine, generation, since) VALUES (true, 'éAq', 3, '2024-02-29 23:59:59.999999-03:30'::timestamptz);\n");
  });
});

describe('Y5: the entry headers', () => {
  it('a smdb_manager entry that is not table data refuses', () => {
    const text = `${HEAD}--\n-- Name: generation; Type: TABLE; Schema: smdb_manager; Owner: dbm_meta\n--\n\nCREATE TABLE smdb_manager.generation (x int);\n${TAIL}`;
    expect(problemOf(text)).toMatch(/line \d+: the entry generation in smdb_manager is TABLE, not table data/);
  });
  it("a table data entry whose COPY text is the hand-built ALTER refuses (PG17's archive)", () => {
    const text = `${HEAD}--\n-- Data for Name: generation; Type: TABLE DATA; Schema: smdb_manager; Owner: dbm_meta\n--\n\nALTER TABLE smdb_manager.generation ALTER COLUMN since SET DEFAULT smdb_data.f();\n${TAIL}`;
    expect(problemOf(text)).toMatch(/line \d+: the table data entry generation in smdb_manager is not followed by its COPY line/);
  });
  it('a table data entry followed by the COPY line of another table refuses', () => {
    const text = dump(entry('generation', [])).replace('Data for Name: generation', 'Data for Name: copies');
    expect(problemOf(text)).toMatch(/the table data entry copies in smdb_manager is not followed by its COPY line/);
  });
  it('a table data entry of a sixth table refuses', () => {
    const text = `${HEAD}--\n-- Data for Name: restore_state; Type: TABLE DATA; Schema: smdb_manager; Owner: dbm_meta\n--\n\nCOPY smdb_manager.restore_state (one_row) FROM stdin;\nt\n\\.\n${TAIL}`;
    expect(problemOf(text)).toMatch(/the table data entry restore_state in smdb_manager is not followed by its COPY line/);
  });
});

describe('metaRowsSql round trip', () => {
  let seed = Number(process.env.SMDB_TEST_SEED || 20261113);
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed; };
  const ALPHABET = ['a', 'Z', '0', ' ', "'", '\\', '\t', '\n', '\r', 'é', '€', '😀', '"', ';', '$', '|'];
  const text = () => Array.from({ length: rnd() % 12 }, () => ALPHABET[rnd() % ALPHABET.length]).join('');
  const time = () => `20${10 + (rnd() % 20)}-0${1 + (rnd() % 9)}-1${rnd() % 10} 0${rnd() % 10}:1${rnd() % 10}:2${rnd() % 10}${rnd() % 2 ? `.${rnd() % 999999}` : ''}${rnd() % 2 ? '+' : '-'}0${rnd() % 10}${rnd() % 2 ? ':30' : ''}`;
  const cell = (v: unknown) => (v === null ? '\\N' : typeof v === 'boolean' ? (v ? 't' : 'f') : esc(String(v)));
  const copyOf = (rows: MetaRows) => dump(...(Object.keys(COLS) as Array<keyof MetaRows>).map(t =>
    entry(t, rows[t].map(r => COLS[t].split(', ').map(c => cell(r[c])).join('\t')))));
  it(`200 seeded row sets (SMDB_TEST_SEED replays; ${seed}): the parse answers metaRowsSql of the same rows`, () => {
    for (let i = 0; i < 200; i++) {
      const n = (k: number) => Array.from({ length: rnd() % k }, (_, j) => j);
      const rows: MetaRows = {
        generation: n(2).map(() => ({ one_row: true, machine: text(), generation: 1 + (rnd() % 1e6), since: time() })),
        handover: n(2).map(() => ({ one_row: true, slot: text(), machine: text(), generation: rnd() - 2 ** 30, at: time() })),
        received: n(4).map(j => ({ push_id: `${j}${text()}`, from_system_id: text(), from_machine: text(), generation: rnd(), at: time() })),
        copies: n(4).map(j => ({ slot: `${j}${text()}`, machine: rnd() % 2 ? null : text(), client: rnd() % 2 ? null : text(), seen_at: time() })),
        addresses: n(3).map(j => ({ host: `h${j}.example`, port: 1 + (rnd() % 65535), slot: rnd() % 2 ? null : `slot_${j}`, cert: PEM, machine: `m ${j}`, updated_at: time() })),
      };
      const r = parse(copyOf(rows));
      expect(r, JSON.stringify(rows)).toMatchObject({ ok: true, script: metaRowsSql(rows) });
    }
  });
  it('metaRowsSql refuses a value that is not its column\'s kind, and a NUL', () => {
    const base: MetaRows = { generation: [], handover: [], received: [], copies: [], addresses: [] };
    expect(() => metaRowsSql({ ...base, generation: [{ one_row: true, machine: 'm', generation: 1.5, since: '2026-11-13 10:20:30+00' }] })).toThrow();
    expect(() => metaRowsSql({ ...base, generation: [{ one_row: true, machine: 'm\0', generation: 1, since: '2026-11-13 10:20:30+00' }] })).toThrow();
    expect(() => metaRowsSql({ ...base, generation: [{ one_row: true, machine: 'm', generation: 1, since: "now()'); DROP TABLE x; --" }] })).toThrow();
    expect(() => metaRowsSql({ ...base, generation: [{ one_row: true, machine: null, generation: 1, since: '2026-11-13 10:20:30+00' }] })).toThrow();
  });
});

describe('the receive SQL and the grants (R3.6, R8)', () => {
  it('RECEIVE_NOLOGIN_SQL, RECEIVE_END_SQL and RECEIVE_DROP_SQL name both receive logins', () => {
    for (const sql of [RECEIVE_NOLOGIN_SQL, RECEIVE_END_SQL, RECEIVE_DROP_SQL]) {
      expect(sql).toMatch(/\bsmdb_receive\b/);
      expect(sql).toContain('smdb_receive_meta');
    }
    expect(RECEIVE_NOLOGIN_SQL).toContain('ALTER ROLE smdb_receive_meta NOLOGIN');
    expect(RECEIVE_END_SQL.split(';').filter(s => s.trim()).every(s => s.includes("usename IN ('smdb_receive', 'smdb_receive_meta')"))).toBe(true);
    expect(RECEIVE_DROP_SQL).toBe('DROP ROLE IF EXISTS smdb_receive, smdb_receive_meta;');
  });
  it('the tables the generation SQL makes grant USAGE and SELECT to dbm_work', () => {
    for (const sql of [GENERATION_SCHEMA_SQL, ensureGenerationSql('m'), raiseSql('m', 2)]) {
      expect(sql).toContain('GRANT USAGE ON SCHEMA smdb_manager TO PUBLIC, dbm_work;');
      expect(sql).toContain('GRANT SELECT ON smdb_manager.generation, smdb_manager.handover, smdb_manager.received, smdb_manager.copies TO dbm_work;');
    }
  });
});

describe('P2: the move code carries the second receive login (R3.6, R10)', () => {
  const recv = { user: 'smdb_receive', password: 'p', id: '0123456789abcdef01234567' };
  const recvMeta = { user: 'smdb_receive_meta', password: 'q' };
  const enc = (o: Record<string, unknown>) => `smdbmove1.${Buffer.from(JSON.stringify(o)).toString('base64url')}`;
  it('round trips with recvMeta', () => {
    const code = { ...fakeJoin(), recv, recvMeta };
    expect(decodeMoveCode(encodeMoveCode(code))).toEqual({ ok: true, code });
  });
  it('a move code without recvMeta is refused at decode', () => {
    expect(decodeMoveCode(enc({ ...fakeJoin(), recv }))).toEqual({ ok: false, old: true, why: 'This move code was made before the receive logins had a second login; make a new one with Receive.' });
  });
  it('a malformed recvMeta is refused naming the field', () => {
    expect(decodeMoveCode(enc({ ...fakeJoin(), recv, recvMeta: { user: 'a b', password: 'q' } }))).toEqual({ ok: false, why: 'it names no valid second receive login user' });
    expect(decodeMoveCode(enc({ ...fakeJoin(), recv, recvMeta: { user: 'u', password: 'q q' } }))).toEqual({ ok: false, why: 'it names no valid second receive login password' });
    expect(decodeMoveCode(enc({ ...fakeJoin(), recv, recvMeta: 'x' }))).toEqual({ ok: false, why: 'it names no valid second receive login' });
  });
});

void h;
