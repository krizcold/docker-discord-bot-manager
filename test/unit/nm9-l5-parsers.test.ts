import { describe, expect, it } from 'vitest';
import * as fleetBackup from '../../src/instance/fleetBackup';
import { TOC } from './restore-fake';

const fb = fleetBackup as any;
const ok = (seq: number, guilds: string[], shards?: { raised: number; expired: number; clock: number }) => ({ ok: true, seq, guilds, ...(shards ? { shards } : {}) });
const bad = (error: string) => ({ ok: false, error });

describe('L5 parseClaimTables', () => {
  it('a newline inside the answer is no answer', () => {
    expect(fb.parseClaimTables('t|t|t\n|t|t')).toBeNull();
  });
});

describe('L5 parseClaimCap count lines', () => {
  const rows: Array<[string, string, unknown]> = [
    ['a count line with a character before its prefix', 'clock|1000\nrows|2\n#capped|2\n', bad("the cap answered '#capped|2'")],
    ['a count line with text after its value', 'clock|1000\nrows|2\ncapped|2x\n', bad("the cap answered 'capped|2x'")],
    ['CRLF line ends', 'clock|1000\r\nrows|2\r\ncapped|2\r\n', { ok: true, expired: 2, clock: 1000 }],
  ];
  it.each(rows)('%s', (_n, stdout, want) => {
    expect(fb.parseClaimCap(stdout)).toEqual(want);
  });
});

describe('L5 parseClaimRaise shard lines and the sequence', () => {
  const head = 'seq|8\nclock|1\nbelow|1\nrows|1\ncapped|1\n';
  const rows: Array<[string, string, boolean, unknown]> = [
    ['a shard line without the shard claims', 'seq|8\nshard|1|0|8\n', false, bad("the raise answered 'shard|1|0|8'")],
    ['a shard line with a character before shard', `${head}xshard|1|0|8\n`, true, bad("the raise answered 'xshard|1|0|8'")],
    ['a shard line with a fourth number', `${head}shard|1|0|8|9\n`, true, bad("the raise answered 'shard|1|0|8|9'")],
    ['a shard count of two digits', `${head}shard|12|0|8\n`, true, ok(8, [], { raised: 1, expired: 1, clock: 1 })],
    ['a shard id of two digits', `${head}shard|1|10|8\n`, true, ok(8, [], { raised: 1, expired: 1, clock: 1 })],
    ['a shard count above the safe integers', `${head}shard|99999999999999999999|0|8\n`, true, bad("the raise answered 'shard|99999999999999999999|0|8'")],
    ['m = 0 and the sequence at the floor', 'seq|7\nclock|1\nbelow|0\nrows|0\ncapped|0\n', true, bad('the sequence answered 7, which is not above 7')],
    ['m = 1 and the sequence at the floor', `${head.replace('seq|8', 'seq|7')}shard|1|0|8\n`, true, bad('the sequence answered 7, which is below the highest raised shard claim 8')],
  ];
  it.each(rows)('%s', (_n, stdout, shards, want) => {
    expect(fb.parseClaimRaise(stdout, 7, shards)).toEqual(want);
  });
});

describe('L5 dumpShardTables reads only the start of a line', () => {
  // pg_restore -l prints a table's name as it is, so another schema's table may hold the text of an entry line.
  const named = (name: string) => `${TOC.claims}220; 1259 16430 TABLE public note 1; 2 3 TABLE smdb_data ${name} app\n`;
  it.each(['shard_claims', 'claim_clock'])('a table in public whose name holds a %s entry', (name) => {
    expect(fb.dumpShardTables(named(name))).toEqual({ shards: false, clock: false });
  });
});

describe('L5 dumpClaimShape of the header alone', () => {
  const rows: Array<[string, string, unknown]> = [
    ['no Selected TOC Entries line, a database name that ends with that text', TOC.empty.replace('; Selected TOC Entries:\n', '').replace('dbname: app', 'dbname: app; Selected TOC Entries:'), null],
    ['a Selected TOC Entries line with text after it', TOC.empty.replace('; Selected TOC Entries:\n', '; Selected TOC Entries: 3\n'), null],
    ['no TOC Entries line, a database name that ends with that text', TOC.empty.replace(';     TOC Entries: 12\n', '').replace('dbname: app', 'dbname: app; TOC Entries: 3'), null],
    ['a TOC Entries line with text after its count', TOC.empty.replace('TOC Entries: 12', 'TOC Entries: 12 of 14'), null],
  ];
  it.each(rows)('%s', (_n, toc, want) => {
    expect(fb.dumpClaimShape(toc)).toBe(want);
  });
});
