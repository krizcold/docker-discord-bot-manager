import { describe, expect, it } from 'vitest';
import { CLAIM_CLOCK_READ_SQL, GENERATION_SCHEMA_SQL, parseClaimClock, SAVE_ORDER_DDL, saveOrderSql } from '../../src/instance/switchSql';

const GEN_TABLE = `CREATE TABLE IF NOT EXISTS smdb_manager.generation (
  one_row boolean PRIMARY KEY DEFAULT true CHECK (one_row), machine text NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 1), since timestamptz NOT NULL DEFAULT now());`;
const GEN_PUBLIC = 'GRANT SELECT ON smdb_manager.generation TO PUBLIC;';

describe('NM33 L5 d: the save order DDL', () => {
  it('makes the generation table and opens it to every role, in the ensure and in the save order DDL', () => {
    for (const sql of [GENERATION_SCHEMA_SQL, SAVE_ORDER_DDL('smdb_bot')]) {
      const lines = sql.split('\n');
      expect(sql).toContain(GEN_TABLE);
      expect(lines).toContain(GEN_PUBLIC);
      expect(sql.indexOf(GEN_TABLE)).toBeLessThan(sql.indexOf(GEN_PUBLIC));
    }
  });

  it('grants the bot role by its quoted name', () => {
    const sql = SAVE_ORDER_DDL('smdb_bot');
    expect(sql).toContain('GRANT USAGE ON SCHEMA smdb_manager TO "smdb_bot";');
    expect(sql).toContain('GRANT SELECT ON smdb_manager.save_order TO "smdb_bot";');
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE ON smdb_manager.save_acks TO "smdb_bot";');
  });

  it('refuses a role name that is not a plain identifier, with the reason', () => {
    expect(() => SAVE_ORDER_DDL('bot"; DROP SCHEMA x; --')).toThrow(new Error(`the bot's role name bot"; DROP SCHEMA x; -- is not a plain identifier`));
    expect(() => saveOrderSql({ keepId: null, keepRestore: false, newId: 'o1', message: 'm', user: 'a b', upMs: null }))
      .toThrow(new Error("the bot's role name a b is not a plain identifier"));
  });
});

describe('NM33 L5 d: the claim clock read', () => {
  it('reads the clock only when its table exists, as clock|<up_ms>', () => {
    const lines = CLAIM_CLOCK_READ_SQL.split('\n');
    expect(lines[0]).toBe("SELECT to_regclass('smdb_data.claim_clock') IS NOT NULL AS nx5_clock \\gset");
    expect(lines).toContain('\\if :nx5_clock');
    expect(lines).toContain("SELECT 'clock|' || coalesce((SELECT up_ms::text FROM smdb_data.claim_clock WHERE id = 1), '');");
    expect(lines).toContain("SELECT 'clock|';");
    expect(lines).toContain('\\endif');
  });

  it('parses the last line, trimmed, and only a whole clock line', () => {
    expect(parseClaimClock('clock|1234\n')).toBe(1234);
    expect(parseClaimClock('SET\n  clock|77  \n')).toBe(77);
    expect(parseClaimClock('clock|-5')).toBe(-5);
    expect(parseClaimClock('xclock|5')).toBeUndefined();
    expect(parseClaimClock('clock|5x')).toBeUndefined();
    expect(parseClaimClock('clock|5\nERROR: x')).toBeUndefined();
    expect(parseClaimClock('')).toBeUndefined();
  });

  it('reads an empty clock as none, never as 0', () => {
    expect(parseClaimClock('clock|\n')).toBeNull();
    expect(parseClaimClock('clock|0')).toBe(0);
  });
});

describe('NM33 L5 d: the order step guards its clock', () => {
  const base = { keepId: null, keepRestore: false, newId: 'o-new', message: 'saving', user: 'smdb_bot' };

  it('takes no clock and a whole clock, and refuses a fraction with the reason', () => {
    expect(() => saveOrderSql({ ...base, upMs: null })).not.toThrow();
    expect(() => saveOrderSql({ ...base, upMs: 5000 })).not.toThrow();
    expect(() => saveOrderSql({ ...base, upMs: 1.5 })).toThrow(new Error('the claim clock is not a whole number'));
    expect(() => saveOrderSql({ ...base, upMs: Number.MAX_SAFE_INTEGER + 2 })).toThrow(new Error('the claim clock is not a whole number'));
  });

  it('matches no standing order when none is kept: order_id = NULL', () => {
    const sql = saveOrderSql({ ...base, upMs: null });
    expect(sql).toContain("WHERE order_id = NULL AND state = 'maintenance' AND generation = ");
    expect(sql).toContain("CASE WHEN order_id = NULL THEN 't' ELSE 'f' END");
    const kept = saveOrderSql({ ...base, keepId: 'o-old', upMs: 9 });
    expect(kept).toContain("WHERE order_id = 'o-old' AND state = 'maintenance'");
  });
});
