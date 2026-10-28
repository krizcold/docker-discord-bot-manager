import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm4-claims-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

import * as fs from 'fs';
import * as path from 'path';
import * as fleetBackup from '../../src/instance/fleetBackup';
import { TOC } from './restore-fake';

const fb = fleetBackup as any;
const FLOOR = path.join(tmp.dir, 'backups', 'a', 'fleet-postgres', 'claim-floor.json');

afterAll(() => { fs.rmSync(tmp.dir, { recursive: true, force: true }); });

const TRIPLES: Array<[boolean, boolean, boolean]> = [];
for (const seq of [true, false]) for (const table of [true, false]) for (const claim of [true, false]) TRIPLES.push([seq, table, claim]);
const FLOORS = [0, 1, 7, 2 ** 53 - 2];
const K1 = TRIPLES.flatMap(([seq, table, claim]) => FLOORS.map(floor => ({ seq, table, claim, floor })));

describe('K1 the floor and raise statements per table shape', () => {
  it.each(K1)('claimFloorSql seq=$seq table=$table claim=$claim floor=$floor', ({ seq, table, claim }) => {
    const out = fb.claimFloorSql({ seq, table, claim });
    if (table && !claim) return expect(out).toEqual({ old: true });
    if (!seq && !table) return expect(out).toEqual({ none: true });
    const sources = [
      ...(seq ? ['(SELECT last_value FROM smdb_data.claim_seq)'] : []),
      ...(table ? ['(SELECT max(claim) FROM smdb_data.guild_ownership)'] : []),
    ];
    expect(out).toEqual({ sql: `SELECT coalesce(GREATEST(${sources.join(', ')}), -1)` });
  });

  it.each(K1)('claimRaiseSql seq=$seq table=$table claim=$claim floor=$floor', ({ seq, table, claim, floor }) => {
    const out = fb.claimRaiseSql(floor, { seq, table, claim });
    if (!seq) return expect(out).toEqual({ error: 'the restored database has no smdb_data.claim_seq' });
    if (table && !claim) return expect(out).toEqual({ error: 'the restored smdb_data.guild_ownership has no claim column' });
    const next = floor + 1;
    if (table) {
      return expect(out).toBe(`WITH u AS (UPDATE smdb_data.guild_ownership SET claim = ${next}, updated_at = now() WHERE claim <= ${floor} RETURNING guild_id), s AS (SELECT setval('smdb_data.claim_seq', GREATEST(last_value, ${next})) AS v FROM smdb_data.claim_seq) SELECT 'seq|' || v FROM s UNION ALL SELECT 'guild|' || guild_id FROM u`);
    }
    expect(out).toBe(`SELECT 'seq|' || setval('smdb_data.claim_seq', GREATEST(last_value, ${next})) FROM smdb_data.claim_seq`);
  });

  it('a floor whose next number is not a safe integer is an error', () => {
    expect(fb.claimRaiseSql(2 ** 53 - 1, { seq: true, table: true, claim: true })).toHaveProperty('error');
    expect(fb.claimRaiseSql(2 ** 53 - 1, { seq: true, table: false, claim: false })).toHaveProperty('error');
  });
});

describe('K2 parseClaimTables', () => {
  const rows: Array<[string, unknown]> = [
    ...TRIPLES.map(([s, t, c]): [string, unknown] => [`${s ? 't' : 'f'}|${t ? 't' : 'f'}|${c ? 't' : 'f'}\n`, { seq: s, table: t, claim: c }]),
    ['t|t', null], ['t|t|t|t', null], ['x|t|t', null], ['', null],
  ];
  it.each(rows)('%j', (stdout, want) => {
    expect(fb.parseClaimTables(stdout)).toEqual(want);
  });
});

describe('K3 parseClaimRaise', () => {
  const rows: Array<[string, string, number, unknown]> = [
    ['ok with guilds', 'seq|8\nguild|g1\nguild|g2\n', 7, { ok: true, seq: 8, guilds: ['g1', 'g2'] }],
    ['ok without guilds', 'seq|12\n', 7, { ok: true, seq: 12, guilds: [] }],
    ['no seq line', 'guild|g1\n', 7, false],
    ['two seq lines', 'seq|8\nseq|9\n', 7, false],
    ['seq at the floor', 'seq|7\n', 7, false],
    ['seq at floor+1', 'seq|8\n', 7, { ok: true, seq: 8, guilds: [] }],
    ['seq not a number', 'seq|x\n', 7, false],
    ['a line without a prefix', 'seq|8\ng1\n', 7, false],
  ];
  it.each(rows)('%s', (_name, stdout, floor, want) => {
    const out = fb.parseClaimRaise(stdout, floor);
    if (want === false) {
      expect(out.ok).toBe(false);
      expect(typeof out.error).toBe('string');
    } else expect(out).toEqual(want);
  });
});

describe('K4 dumpClaimShape', () => {
  const rows: Array<[string, string, unknown]> = [
    ['claims fixture', TOC.claims, 'claims'],
    ['terms fixture', TOC.terms, 'terms'],
    ['none fixture', TOC.none, 'none'],
    ['a SEQUENCE SET line alone', `${TOC.terms}3367; 0 0 SEQUENCE SET smdb_data claim_seq app\n`, 'terms'],
    ['mixed, sequence and table', `1; 1259 1 TABLE smdb_data guild_ownership app\n2; 1259 2 SEQUENCE smdb_data claim_seq app\n`, 'claims'],
    ['empty', '', null],
    ['not a TOC', 'pg_restore: error: input file does not appear to be a valid archive\n', null],
  ];
  it.each(rows)('%s', (_name, toc, want) => {
    expect(fb.dumpClaimShape(toc)).toBe(want);
  });
});

describe('K5 the claim floor file', () => {
  beforeEach(() => {
    fleetBackup.clearClaimFloor('a');
    fs.rmSync(path.dirname(FLOOR), { recursive: true, force: true });
  });

  it('round trip', () => {
    expect(fb.writeClaimFloor('a', 9)).toBeNull();
    expect(JSON.parse(fs.readFileSync(FLOOR, 'utf-8'))).toEqual({ claim: 9 });
    expect(fb.readClaimFloor('a')).toEqual({ ok: true, claim: 9, disk: 9 });
  });

  it('a lower value never replaces a higher one', () => {
    fb.writeClaimFloor('a', 9);
    expect(fb.writeClaimFloor('a', 4)).toBeNull();
    expect(JSON.parse(fs.readFileSync(FLOOR, 'utf-8'))).toEqual({ claim: 9 });
    expect(fb.readClaimFloor('a')).toEqual({ ok: true, claim: 9, disk: 9 });
  });

  const bad: Array<[string, string]> = [['a fraction', '{ "claim": 1.5 }'], ['the old term key', '{ "term": 3 }'], ['an array', '[]'], ['bad JSON', 'not json']];
  it.each(bad)('%s reads as an error', (_name, text) => {
    fs.mkdirSync(path.dirname(FLOOR), { recursive: true });
    fs.writeFileSync(FLOOR, text);
    const out = fb.readClaimFloor('a');
    expect(out.ok).toBe(false);
    expect(typeof out.error).toBe('string');
  });

  it('no file reads as null', () => {
    expect(fb.readClaimFloor('a')).toEqual({ ok: true, claim: null, disk: null });
  });
});
