// NM33 L5 survivors in switchSql.ts lines 100 to 199: the order step's SQL, the parse of its last line, and the save read.
import { describe, expect, it } from 'vitest';
import { parseSaveOrderWritten, SAVE_READ_SQL, saveOrderSql } from '../../src/instance/switchSql';

const CUR = 'coalesce((SELECT generation FROM smdb_manager.generation), 0)';
const base = { newId: 'b'.repeat(24), message: 'Back soon', user: 'bot_one' };

describe('saveOrderSql: the kept row and the new row', () => {
  it('keeps only a current order row at maintenance with keepId, and writes the clock as given', () => {
    const sql = saveOrderSql({ ...base, keepId: 'a'.repeat(24), keepRestore: false, upMs: 123456 });
    const match = `order_id = 'aaaaaaaaaaaaaaaaaaaaaaaa' AND state = 'maintenance' AND generation = ${CUR} AND reason = 'order'`;
    const standing = `EXISTS (SELECT 1 FROM smdb_manager.save_order WHERE ${match})`;
    const lines = sql.split('\n');
    expect(lines[0]).toBe('BEGIN;');
    expect(lines).toContain(`UPDATE smdb_manager.save_order SET message = 'Back soon' WHERE ${match};`);
    expect(lines).toContain(`DELETE FROM smdb_manager.save_acks WHERE NOT ${standing};`);
    expect(lines).toContain(`  SELECT true, 'bbbbbbbbbbbbbbbbbbbbbbbb', 'maintenance', 'Back soon', ${CUR}, 'order', 123456, now() WHERE NOT ${standing}`);
    expect(lines).toContain('COMMIT;');
    expect(lines[lines.length - 2]).toBe(`SELECT order_id || '|' || CASE WHEN order_id = 'aaaaaaaaaaaaaaaaaaaaaaaa' THEN 't' ELSE 'f' END || '|' || generation || '|' || coalesce(up_ms::text, '') FROM smdb_manager.save_order;`);
  });

  it('keeps a restore row too when keepRestore, and writes NULL for no clock', () => {
    const sql = saveOrderSql({ ...base, keepId: 'a'.repeat(24), keepRestore: true, upMs: null });
    const match = `order_id = 'aaaaaaaaaaaaaaaaaaaaaaaa' AND state = 'maintenance' AND generation = ${CUR}`;
    const lines = sql.split('\n');
    expect(lines).toContain(`UPDATE smdb_manager.save_order SET message = 'Back soon' WHERE ${match};`);
    expect(lines).toContain(`DELETE FROM smdb_manager.save_acks WHERE NOT EXISTS (SELECT 1 FROM smdb_manager.save_order WHERE ${match});`);
    expect(lines.some(l => l.includes(`, 'order', NULL, now() WHERE NOT EXISTS`))).toBe(true);
  });

  it('writes a clock of 0 as 0, not NULL', () => {
    const sql = saveOrderSql({ ...base, keepId: null, keepRestore: false, upMs: 0 });
    expect(sql).toContain(`, 'order', 0, now() WHERE NOT EXISTS (SELECT 1 FROM smdb_manager.save_order WHERE order_id = NULL AND state = 'maintenance'`);
  });
});

describe('parseSaveOrderWritten: the last line psql -tA prints', () => {
  const out = (last: string) => `BEGIN\nCREATE SCHEMA\nUPDATE 0\nDELETE 0\nINSERT 0 1\nCOMMIT\n${last}\n`;

  it('reads an empty clock as null and a multi-digit generation', () => {
    expect(parseSaveOrderWritten(out('cccccccccccccccccccccccc|f|12|'))).toEqual({ orderId: 'cccccccccccccccccccccccc', kept: false, generation: 12, upMs: null });
    expect(parseSaveOrderWritten(out('cccccccccccccccccccccccc|t|7|98765'))).toEqual({ orderId: 'cccccccccccccccccccccccc', kept: true, generation: 7, upMs: 98765 });
  });

  it('refuses a generation or a clock past a safe integer (bigint holds them)', () => {
    expect(parseSaveOrderWritten(out('cccccccccccccccccccccccc|f|9223372036854775807|'))).toBeUndefined();
    expect(parseSaveOrderWritten(out('cccccccccccccccccccccccc|f|9223372036854775807|5'))).toBeUndefined();
    expect(parseSaveOrderWritten(out('cccccccccccccccccccccccc|f|3|9223372036854775807'))).toBeUndefined();
  });
});

describe('SAVE_READ_SQL', () => {
  const lines = SAVE_READ_SQL.split('\n');
  const ACKS = `'acks', coalesce((SELECT jsonb_agg(jsonb_build_object('process', process_id, 'order', order_id, 'saved', saved,
  'unsavedGuilds', unsaved_guilds, 'unsavedFiles', unsaved_files, 'unansweredGuilds', unanswered_guilds,
  'unconfirmedFiles', unconfirmed_files, 'unansweredFiles', unanswered_files) ORDER BY process_id) FROM smdb_manager.save_acks), '[]'::jsonb)`;
  const ORDER = `'order', (SELECT jsonb_build_object('id', order_id, 'state', state, 'message', message, 'current', generation = ${CUR},
  'reason', reason, 'upMs', up_ms) FROM smdb_manager.save_order)`;
  const STANDBY = " AND NOT EXISTS (SELECT 1 FROM smdb_data.reshard x WHERE x.state IN ('standby', 'flipped') AND x.to_count = c.shard_count)";
  const R = (standby: string) => `r AS (SELECT c.holder_process AS p, c.holder_name AS n, c.expires_up_ms AS e, c.renewed_at AS t FROM smdb_data.shard_claims c
  WHERE NOT c.released${standby} AND EXISTS (SELECT 1 FROM u)),`;
  const between = (from: string, to: string) => SAVE_READ_SQL.slice(SAVE_READ_SQL.indexOf(from), SAVE_READ_SQL.indexOf(to, SAVE_READ_SQL.indexOf(from) + 1));

  it('checks the three tables first, then reads the holders with standby left out only when reshard exists', () => {
    expect(lines[0]).toBe(`SELECT to_regclass('smdb_manager.save_order') IS NOT NULL AND to_regclass('smdb_manager.save_acks') IS NOT NULL AND to_regclass('smdb_manager.generation') IS NOT NULL AS nx5_order,`);
    const withReshard = between('\\if :nx5_reshard\n', '\\else\n');
    const without = between('\\else\n', '\\endif\n');
    expect(withReshard).toContain(R(STANDBY));
    expect(without).toContain(R(''));
    expect(without).not.toContain('smdb_data.reshard');
    for (const part of [withReshard, without]) {
      expect(part).toContain('WITH u AS (SELECT up_ms FROM smdb_manager.save_order WHERE up_ms IS NOT NULL),\n');
      expect(part).toContain(`SELECT jsonb_build_object(${ORDER}, 'claims', true,`);
      expect(part).toContain(`  ${ACKS})::text;`);
    }
  });

  it('answers the order and the acks when the claim tables are missing', () => {
    expect(SAVE_READ_SQL).toContain(`SELECT jsonb_build_object(${ORDER}, 'claims', false, 'expected', '[]'::jsonb, 'notSeen', '[]'::jsonb, ${ACKS})::text;`);
  });
});
