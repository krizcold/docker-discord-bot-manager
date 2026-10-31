import { describe, expect, it } from 'vitest';
import * as fleetBackup from '../../src/instance/fleetBackup';
import * as switchSql from '../../src/instance/switchSql';
import { TOC } from './restore-fake';

const fb = fleetBackup as any;
const sw = switchSql as any;

type Five = { seq: boolean; table: boolean; claim: boolean; shards: boolean; clock: boolean };
const FIVES: Five[] = [];
for (const seq of [true, false]) for (const table of [true, false]) for (const claim of [true, false]) for (const shards of [true, false]) for (const clock of [true, false]) FIVES.push({ seq, table, claim, shards, clock });
const tf = (b: boolean) => (b ? 't' : 'f');
const line = (t: Five) => [t.seq, t.table, t.claim, t.shards, t.clock].map(tf).join('|');

const CAP = 'expires_up_ms = LEAST(t.expires_up_ms, k.up_ms)';
const NM4_RAISE = (floor: number, table: boolean) => {
  const next = floor + 1;
  return table
    ? `WITH u AS (UPDATE smdb_data.guild_ownership SET claim = ${next}, updated_at = now() WHERE claim <= ${floor} RETURNING guild_id), s AS (SELECT setval('smdb_data.claim_seq', GREATEST(last_value, ${next})) AS v FROM smdb_data.claim_seq) SELECT 'seq|' || v FROM s UNION ALL SELECT 'guild|' || guild_id FROM u`
    : `SELECT 'seq|' || setval('smdb_data.claim_seq', GREATEST(last_value, ${next})) FROM smdb_data.claim_seq`;
};
const SHARD_RAISE = (F: number, table: boolean) => {
  const N = F + 1;
  const u = table ? `, u AS (UPDATE smdb_data.guild_ownership SET claim = ${N}, updated_at = now() WHERE claim <= ${F} AND EXISTS (SELECT 1 FROM k) RETURNING guild_id)` : '';
  const guildMax = table ? ', (SELECT coalesce(max(claim), 0) FROM smdb_data.guild_ownership)' : '';
  const guildLines = table ? " UNION ALL SELECT 'guild|' || guild_id FROM u" : '';
  return `WITH k AS (SELECT up_ms FROM smdb_data.claim_clock WHERE id = 1), r AS (SELECT shard_count, shard_id, ${F} + row_number() OVER (ORDER BY shard_count, shard_id) AS n FROM smdb_data.shard_claims WHERE claim <= ${F}), c AS (UPDATE smdb_data.shard_claims AS t SET claim = coalesce((SELECT r.n FROM r WHERE r.shard_count = t.shard_count AND r.shard_id = t.shard_id), t.claim), expires_up_ms = LEAST(t.expires_up_ms, k.up_ms) FROM k RETURNING t.shard_count, t.shard_id, t.claim)${u}, s AS (SELECT setval('smdb_data.claim_seq', GREATEST(q.last_value, ${N}, (SELECT coalesce(max(claim), 0) FROM c)${guildMax})) AS v FROM smdb_data.claim_seq AS q, k) SELECT 'seq|' || v FROM s UNION ALL SELECT 'clock|' || up_ms FROM k UNION ALL SELECT 'below|' || count(*) FROM r UNION ALL SELECT 'rows|' || count(*) FROM smdb_data.shard_claims UNION ALL SELECT 'capped|' || count(*) FROM c UNION ALL SELECT 'shard|' || c.shard_count || '|' || c.shard_id || '|' || c.claim FROM c JOIN r USING (shard_count, shard_id)${guildLines}`;
};
const CAP_SQL = "WITH k AS (SELECT up_ms FROM smdb_data.claim_clock WHERE id = 1), c AS (UPDATE smdb_data.shard_claims AS t SET expires_up_ms = LEAST(t.expires_up_ms, k.up_ms) FROM k RETURNING t.shard_count) SELECT 'clock|' || up_ms FROM k UNION ALL SELECT 'rows|' || count(*) FROM smdb_data.shard_claims UNION ALL SELECT 'capped|' || count(*) FROM c";
const DO_SQL = `DO $$ BEGIN
IF to_regclass('smdb_data.shard_claims') IS NOT NULL AND to_regclass('smdb_data.claim_clock') IS NOT NULL THEN
  EXECUTE 'UPDATE smdb_data.shard_claims AS t SET expires_up_ms = LEAST(t.expires_up_ms, k.up_ms) FROM smdb_data.claim_clock AS k WHERE k.id = 1';
END IF;
END $$;
`;

describe('Q1 parseClaimTables takes exactly five fields', () => {
  const rows: Array<[string, unknown]> = [
    ...FIVES.map((t): [string, unknown] => [`${line(t)}\n`, t]),
    ['t|t|t', null], ['t|t|t|t|t|t', null], ['x|t|t|t|t', null], ['t|t|t|t|t\n\n', null], ['t|t|t|t|', null], ['', null],
  ];
  it.each(rows)('%j', (stdout, want) => {
    expect(fb.parseClaimTables(stdout)).toEqual(want);
  });
});

describe('Q2 claimFloorSql per quintuple', () => {
  it.each(FIVES)('seq=$seq table=$table claim=$claim shards=$shards clock=$clock', (t) => {
    const out = fb.claimFloorSql(t);
    if (t.table && !t.claim) return expect(out).toEqual({ old: true });
    if (!t.seq && !t.table && !t.shards) return expect(out).toEqual({ none: true });
    const sources = [
      ...(t.seq ? ['(SELECT last_value FROM smdb_data.claim_seq)'] : []),
      ...(t.table ? ['(SELECT max(claim) FROM smdb_data.guild_ownership)'] : []),
      ...(t.shards ? ['(SELECT max(claim) FROM smdb_data.shard_claims)'] : []),
    ];
    expect(out).toEqual({ sql: `SELECT coalesce(GREATEST(${sources.join(', ')}), -1)` });
  });
});

describe('Q3 claimRaiseSql per quintuple and floor', () => {
  const FLOORS = [0, 1, 7, 2 ** 53 - 2, 2 ** 53 - 1];
  const rows = FIVES.flatMap(t => FLOORS.map(floor => ({ ...t, floor })));
  it.each(rows)('seq=$seq table=$table claim=$claim shards=$shards clock=$clock floor=$floor', ({ floor, ...t }) => {
    const out = fb.claimRaiseSql(floor, t);
    if (!t.seq) return expect(out).toEqual({ error: 'the restored database has no smdb_data.claim_seq' });
    if (t.table && !t.claim) return expect(out).toEqual({ error: 'the restored smdb_data.guild_ownership has no claim column' });
    if (t.shards && !t.clock) return expect(out).toEqual({ error: 'the restored database has smdb_data.shard_claims but no smdb_data.claim_clock' });
    if (floor === 2 ** 53 - 1) return expect(out).toEqual({ error: 'the claim floor 9007199254740991 has no next whole number' });
    expect(out).toBe(t.shards ? SHARD_RAISE(floor, t.table) : NM4_RAISE(floor, t.table));
  });
});

describe('Q4 parseClaimRaise', () => {
  const ok = (seq: number, guilds: string[], shards?: { raised: number; expired: number; clock: number }) => ({ ok: true, seq, guilds, ...(shards ? { shards } : {}) });
  const bad = (error: string) => ({ ok: false, error });
  const rows: Array<[string, string, boolean, unknown]> = [
    ['ok m = 0', 'seq|8\nclock|1000\nbelow|0\nrows|2\ncapped|2\n', true, ok(8, [], { raised: 0, expired: 2, clock: 1000 })],
    ['ok m = 1 with a guild', 'seq|9\nclock|1000\nbelow|1\nrows|1\ncapped|1\nshard|2|0|8\nguild|g1\n', true, ok(9, ['g1'], { raised: 1, expired: 1, clock: 1000 })],
    ['ok m = 3 in another order, rows above m', 'guild|g2\nshard|2|2|10\ncapped|5\nrows|5\nshard|2|0|8\nbelow|3\nseq|12\nclock|40\nshard|2|1|9\n', true, ok(12, ['g2'], { raised: 3, expired: 5, clock: 40 })],
    ['ok m = 3 without guilds', 'seq|10\nclock|1\nbelow|3\nrows|3\ncapped|3\nshard|1|0|9\nshard|1|1|10\nshard|1|2|8\n', true, ok(10, [], { raised: 3, expired: 3, clock: 1 })],
    ['E2 no clock, no seq', 'below|0\nrows|2\ncapped|0\n', true, bad('the restored smdb_data.claim_clock has no row, so no claim number was raised')],
    ['E3 two clocks', 'seq|8\nclock|1\nclock|2\nbelow|0\nrows|0\ncapped|0\n', true, bad('the raise answered two clock values')],
    ['E4 below missing', 'seq|8\nclock|1\nrows|0\ncapped|0\n', true, bad("the raise answered no 'below' count")],
    ['E4 below doubled', 'seq|8\nclock|1\nbelow|0\nbelow|0\nrows|0\ncapped|0\n', true, bad("the raise answered two 'below' counts")],
    ['E4 rows missing', 'seq|8\nclock|1\nbelow|0\ncapped|0\n', true, bad("the raise answered no 'rows' count")],
    ['E4 rows doubled', 'seq|8\nclock|1\nbelow|0\nrows|0\nrows|0\ncapped|0\n', true, bad("the raise answered two 'rows' counts")],
    ['E4 capped missing', 'seq|8\nclock|1\nbelow|0\nrows|0\n', true, bad("the raise answered no 'capped' count")],
    ['E4 capped doubled', 'seq|8\nclock|1\nbelow|0\nrows|0\ncapped|0\ncapped|0\n', true, bad("the raise answered two 'capped' counts")],
    ['no seq with shards', 'clock|1\nbelow|0\nrows|0\ncapped|0\n', true, bad('the raise answered no sequence value')],
    ['E5 two shard lines for three below', 'seq|10\nclock|1\nbelow|3\nrows|3\ncapped|3\nshard|1|0|8\nshard|1|1|9\n', true, bad('the raise answered 2 raised shard claim(s) for 3 at or below 7')],
    ['E6 claim 7', 'seq|8\nclock|1\nbelow|1\nrows|1\ncapped|1\nshard|1|0|7\n', true, bad('the raise answered shard claim 7, which is not one of 8 to 8 once')],
    ['E6 claim 11 for m = 3', 'seq|11\nclock|1\nbelow|3\nrows|3\ncapped|3\nshard|1|0|8\nshard|1|1|9\nshard|1|2|11\n', true, bad('the raise answered shard claim 11, which is not one of 8 to 10 once')],
    ['E6 claim 8 twice', 'seq|9\nclock|1\nbelow|2\nrows|2\ncapped|2\nshard|1|0|8\nshard|1|1|8\n', true, bad('the raise answered shard claim 8, which is not one of 8 to 9 once')],
    ['E7 seq 9 for m = 3', 'seq|9\nclock|1\nbelow|3\nrows|3\ncapped|3\nshard|1|0|8\nshard|1|1|9\nshard|1|2|10\n', true, bad('the sequence answered 9, which is below the highest raised shard claim 10')],
    ['seq 10 for m = 3 is ok', 'seq|10\nclock|1\nbelow|3\nrows|3\ncapped|3\nshard|1|0|8\nshard|1|1|9\nshard|1|2|10\n', true, ok(10, [], { raised: 3, expired: 3, clock: 1 })],
    ['E8 rows 4, capped 3', 'seq|8\nclock|1\nbelow|0\nrows|4\ncapped|3\n', true, bad('the raise expired 3 of 4 restored shard claims')],
    ['a malformed shard line', 'seq|8\nclock|1\nbelow|1\nrows|1\ncapped|1\nshard|2|x|8\n', true, bad("the raise answered 'shard|2|x|8'")],
    ['a clock line without shards', 'seq|8\nclock|1\n', false, bad("the raise answered 'clock|1'")],
    ['K3 ok with guilds', 'seq|8\nguild|g1\nguild|g2\n', false, ok(8, ['g1', 'g2'])],
    ['K3 ok without guilds', 'seq|12\n', false, ok(12, [])],
    ['K3 no seq line', 'guild|g1\n', false, bad('the raise answered no sequence value')],
    ['K3 two seq lines', 'seq|8\nseq|9\n', false, bad('the raise answered two sequence values')],
    ['K3 seq at the floor', 'seq|7\n', false, bad('the sequence answered 7, which is not above 7')],
    ['K3 seq at floor+1', 'seq|8\n', false, ok(8, [])],
    ['K3 seq not a number', 'seq|x\n', false, bad("the raise answered 'seq|x'")],
    ['K3 a line without a prefix', 'seq|8\ng1\n', false, bad("the raise answered 'g1'")],
  ];
  it.each(rows)('%s', (_n, stdout, shards, want) => {
    expect(fb.parseClaimRaise(stdout, 7, shards)).toEqual(want);
  });
});

describe('Q5 dumpShardTables', () => {
  const rows: Array<[string, string, unknown]> = [
    ['claims', TOC.claims, { shards: false, clock: false }],
    ['terms', TOC.terms, { shards: false, clock: false }],
    ['shards', TOC.shards, { shards: true, clock: true }],
    ['shardsNoClock', TOC.shardsNoClock, { shards: true, clock: false }],
    ['TABLE DATA only', `${TOC.claims}3362; 0 16410 TABLE DATA smdb_data shard_claims app\n3363; 0 16420 TABLE DATA smdb_data claim_clock app\n`, { shards: false, clock: false }],
    ['mixed text', `some text\n218; 1259 16410 TABLE smdb_data shard_claims app\nmore text TABLE smdb_data claim_clock app\n`, { shards: true, clock: false }],
    ['no TOC', 'pg_restore: error: input file does not appear to be a valid archive', { shards: false, clock: false }],
  ];
  it.each(rows)('%s', (_n, toc, want) => {
    expect(fb.dumpShardTables(toc)).toEqual(want);
  });
});

describe('Q5e dumpClaimShape of a dump with no objects', () => {
  const rows: Array<[string, string, unknown]> = [
    ['the header alone, as pg_restore -l lists an empty database', TOC.empty, 'none'],
    ['the header without its Selected TOC Entries line', TOC.empty.replace('; Selected TOC Entries:\n', ''), null],
    ['the header alone with a negative TOC count', TOC.emptyNeg, null],
    ['the header alone with TOC Entries: 3', TOC.empty.replace('TOC Entries: 12', 'TOC Entries: 3'), 'none'],
    ['the header alone with TOC Entries: 0', TOC.empty.replace('TOC Entries: 12', 'TOC Entries: 0'), null],
    ['empty text', '', null],
    ['an error', 'pg_restore: error: input file does not appear to be a valid archive\n', null],
  ];
  it.each(rows)('%s', (_n, toc, want) => {
    expect(fb.dumpClaimShape(toc)).toBe(want);
  });
});

// A seeded generator, so a failing case can be replayed.
const rng = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

describe('Q6 the raise answer model', () => {
  it('200 seeded cases parse ok, and each with one line removed or doubled fails', () => {
    const rand = rng(9);
    const int = (n: number) => Math.floor(rand() * n);
    for (let i = 0; i < 200; i++) {
      const m = int(7);
      const kept = int(4);
      const guilds = int(5);
      const F = int(1000);
      const clock = int(100000);
      const seq = F + Math.max(1, m) + int(3);
      const lines = [`seq|${seq}`, `clock|${clock}`, `below|${m}`, `rows|${m + kept}`, `capped|${m + kept}`];
      for (let j = 0; j < m; j++) lines.push(`shard|2|${j}|${F + 1 + j}`);
      for (let j = 0; j < guilds; j++) lines.push(`guild|g${j}`);
      for (let j = lines.length - 1; j > 0; j--) {
        const k = int(j + 1);
        [lines[j], lines[k]] = [lines[k], lines[j]];
      }
      const got = fb.parseClaimRaise(`${lines.join('\n')}\n`, F, true);
      expect(got, lines.join(',')).toMatchObject({ ok: true, seq, shards: { raised: m, expired: m + kept, clock } });
      expect(got.guilds).toHaveLength(guilds);
      const essential = lines.filter(l => !l.startsWith('guild|'));
      const drop = essential[int(essential.length)];
      expect(fb.parseClaimRaise(lines.filter(l => l !== drop).join('\n'), F, true).ok, `without ${drop}`).toBe(false);
      const doubles = lines.filter(l => /^(shard|clock|seq|capped)\|/.test(l));
      const twice = doubles[int(doubles.length)];
      expect(fb.parseClaimRaise([...lines, twice].join('\n'), F, true).ok, `with ${twice} twice`).toBe(false);
    }
  });
});

describe('Q7 the cap with no floor', () => {
  it('claimCapSql is 7.2', () => {
    expect(fb.claimCapSql()).toBe(CAP_SQL);
  });
  const bad = (error: string) => ({ ok: false, error });
  const rows: Array<[string, string, unknown]> = [
    ['ok, rows 0', 'clock|1000\nrows|0\ncapped|0\n', { ok: true, expired: 0, clock: 1000 }],
    ['ok, rows 3', 'capped|3\nclock|5\nrows|3\n', { ok: true, expired: 3, clock: 5 }],
    ['E2', 'rows|2\ncapped|0\n', bad('the restored smdb_data.claim_clock has no row, so no shard claim was expired')],
    ['E3', 'clock|1\nclock|2\nrows|0\ncapped|0\n', bad('the cap answered two clock values')],
    ['E4 rows missing', 'clock|1\ncapped|0\n', bad("the cap answered no 'rows' count")],
    ['E4 rows doubled', 'clock|1\nrows|0\nrows|0\ncapped|0\n', bad("the cap answered two 'rows' counts")],
    ['E4 capped missing', 'clock|1\nrows|0\n', bad("the cap answered no 'capped' count")],
    ['E4 capped doubled', 'clock|1\nrows|0\ncapped|0\ncapped|0\n', bad("the cap answered two 'capped' counts")],
    ['E8', 'clock|1\nrows|3\ncapped|2\n', bad('the cap expired 2 of 3 restored shard claims')],
    ['a malformed line', 'clock|1\nrows|x\ncapped|0\n', bad("the cap answered 'rows|x'")],
    ['a seq line', 'clock|1\nrows|0\ncapped|0\nseq|5\n', bad("the cap answered 'seq|5'")],
  ];
  it.each(rows)('parseClaimCap %s', (_n, stdout, want) => {
    expect(fb.parseClaimCap(stdout)).toEqual(want);
  });
});

describe('Q8 the cap text lives once', () => {
  it('SHARD_CAP_DO_SQL is 7.5, and 7.1, 7.2 and 7.5 hold SHARD_CAP_SET', () => {
    expect(sw.SHARD_CAP_SET).toBe(CAP);
    expect(sw.SHARD_CAP_DO_SQL).toBe(DO_SQL);
    const all = { seq: true, table: true, claim: true, shards: true, clock: true };
    for (const sql of [fb.claimRaiseSql(7, all), fb.claimCapSql(), sw.SHARD_CAP_DO_SQL]) expect(sql).toContain(sw.SHARD_CAP_SET);
  });
});
