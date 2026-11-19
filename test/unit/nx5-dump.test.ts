// NX5 review round 2 finding 1: a dump of a database where the save order ran holds smdb_manager.save_order and
// save_acks. The meta read passes over both blocks without writing them back, and the restore's counts compare leaves
// both tables out. The push's compare is nm20-code6's NX5 row; the real pg_dump is nx5-pg's.
import { afterAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nx5-dump-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import { parseMetaRows, parseSaveRows } from '../../src/instance/switchSql';
import { countsToCompare, unrecordedCounts } from '../../src/instance/fleetBackup';
import { compareCounts } from '../../src/instance/backupFiles';
import { parseAddressRows } from '../../src/instance/fleetJoin';

afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

const check = (row: unknown) => parseAddressRows(JSON.stringify([row]))[0] ?? null;
const TS = '2026-11-16 10:00:05.5+00';
const entry = (t: string, cols: string, rows: string[]) => `--\n-- Data for Name: ${t}; Type: TABLE DATA; Schema: smdb_manager; Owner: dbm_meta\n--\n\nCOPY smdb_manager.${t} (${cols}) FROM stdin;\n${rows.map(r => `${r}\n`).join('')}\\.\n\n\n`;
const dump = (...entries: string[]) => `--\n-- PostgreSQL database dump\n--\n\nSET statement_timeout = 0;\nSET row_security = off;\n\n${entries.join('')}--\n-- PostgreSQL database dump complete\n--\n\n`;
const ORDER_COLS = 'one_row, order_id, state, message, generation, reason, up_ms, at';
const ACK_COLS = 'process_id, order_id, node_id, node_name, saved, unsaved_guilds, unsaved_files, unanswered_guilds, unconfirmed_files, unanswered_files, resave_guilds, acked_at';
const ORDER_ROW = `t\tX\tmaintenance\tBack soon\\nat 10:00\t3\torder\t100000\t${TS}`;
// The third answer's process id (the bot writes it) reads as an entry header when its line is not passed over.
const ACK_ROWS = [`p1\tX\tn1\thost-a\tt\t0\t0\t0\t0\t0\t0\t${TS}`, `p2\tX\t\\N\t\\N\t\\N\t\\N\t\\N\t\\N\t\\N\t\\N\t0\t${TS}`,
  `-- Data for Name: generation; Type: TABLE DATA; Schema: smdb_manager;\tX\t\\N\t\\N\tt\t0\t0\t0\t0\t0\t0\t${TS}`];
const FIVE = [
  entry('copies', 'slot, machine, client, seen_at', [`smdb_copy_a\tcopy.example\t172.18.0.5\t${TS}`]),
  entry('generation', 'one_row, machine, generation, since', [`t\tmain.example\t3\t${TS}`]),
  entry('handover', 'one_row, slot, machine, generation, at', []),
  entry('received', 'push_id, from_system_id, from_machine, generation, at', [`0123456789abcdef01234567\t7349081263451237\tother.example\t2\t${TS}`]),
];

describe('the meta read of a dump with the save order tables', () => {
  it('passes over both blocks: the five tables come back as without them, and no save order row is written back', () => {
    const plain = parseMetaRows(dump(...FIVE), check);
    const r = parseMetaRows(dump(FIVE[0], FIVE[1], FIVE[2], FIVE[3], entry('save_acks', ACK_COLS, ACK_ROWS), entry('save_order', ORDER_COLS, [ORDER_ROW])), check);
    expect(plain.ok).toBe(true);
    expect(r).toEqual(plain);
    expect(r).toMatchObject({ ok: true, counts: { generation: 1, handover: 0, received: 1, copies: 1, addresses: 0 } });
    expect((r as { script: string }).script).not.toMatch(/save_order|save_acks/);
  });
  it('empty blocks of both tables, before the five tables, read the same', () => {
    const r = parseMetaRows(dump(entry('save_acks', ACK_COLS, []), entry('save_order', ORDER_COLS, []), ...FIVE), check);
    expect(r).toEqual(parseMetaRows(dump(...FIVE), check));
  });
  it('a dump that ends inside the save_acks block refuses', () => {
    const r = parseMetaRows(`${dump(...FIVE)}COPY smdb_manager.save_acks (${ACK_COLS}) FROM stdin;\n${ACK_ROWS[0]}\n`, check);
    expect(r).toEqual({ ok: false, problem: 'the dump ends inside the rows of smdb_manager.save_acks' });
  });
  it('a second save_order block refuses', () => {
    const r = parseMetaRows(dump(entry('save_order', ORDER_COLS, []), entry('save_order', ORDER_COLS, [])), check);
    expect(r.ok).toBe(false);
    expect((r as { problem: string }).problem).toMatch(/^line \d+: smdb_manager\.save_order has a second block of rows$/);
  });
});

describe('review 2 finding 4: the read keeps a NULL count as null (G8-5)', () => {
  it('a NULL or absent count parses as null, a number stays, and a negative count still fails the read', () => {
    const line = (ack: Record<string, unknown>) => JSON.stringify({ order: null, claims: true, expected: [], notSeen: [], acks: [{ process: 'p1', order: 'X', saved: false, ...ack }] });
    expect(parseSaveRows(line({ unsavedGuilds: null, unsavedFiles: 2, unansweredGuilds: 0, unconfirmedFiles: null }))!.acks[0]).toEqual({
      process: 'p1', order: 'X', saved: false, unsavedGuilds: null, unsavedFiles: 2, unansweredGuilds: 0, unconfirmedFiles: null, unansweredFiles: null,
    });
    expect(parseSaveRows(line({ unsavedGuilds: -1 }))).toBeUndefined();
  });
});

describe("the restore's counts compare", () => {
  const RECORDED = { '"public"."t"': 3, 'smdb_manager.generation': 1, 'smdb_manager.save_order': 1, 'smdb_manager.save_acks': 2 };
  it('the counts file holds both tables and the restored database has neither: the counts match', () => {
    const c = countsToCompare(RECORDED, { '"public"."t"': 3, 'smdb_manager.generation': 1 }, 0);
    expect(c.recorded).toEqual({ '"public"."t"': 3, 'smdb_manager.generation': 1 });
    expect(compareCounts(c.recorded, c.restored).ok).toBe(true);
  });
  it('the restored database holds the tables with other counts (the raise rewrote the order): the counts match', () => {
    const c = countsToCompare(RECORDED, { '"public"."t"': 3, 'smdb_manager.generation': 1, 'smdb_manager.save_order': 1, 'smdb_manager.save_acks': 0 }, 0);
    expect(compareCounts(c.recorded, c.restored).ok).toBe(true);
  });
  it('a dump without a counts file: the restored totals leave both tables out', () => {
    expect(unrecordedCounts({ '"public"."t"': 3, 'smdb_manager.save_order': 1, 'smdb_manager.save_acks': 0 }, '')).toEqual({ '"public"."t"': 3 });
  });
});
