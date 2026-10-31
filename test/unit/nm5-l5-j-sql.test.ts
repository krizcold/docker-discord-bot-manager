import { describe, expect, it } from 'vitest';
import {
  copiesInsertSql, cutAddressesSql, generationBefore, handoverMachine, parseGenRow, parseReceiveMark, parseRestoreState,
  pushBrokenOf, raiseSql, RECEIVE_MARK_COUNT_SQL, receiveMarkClearSql, restoreStateUpsertSql, switchStateRefusal, takeoverBlockScript,
} from '../../src/instance/switchSql';

const SINCE = `to_char(since AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

describe('raiseSql', () => {
  it('ends with the hand-over delete and the row read, with no extra text', () => {
    expect(raiseSql('m1', 3)).toContain(`DELETE FROM smdb_manager.handover;\nSELECT generation || '|' || machine || '|' || ${SINCE} FROM smdb_manager.generation;\nCOMMIT;`);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2])('refuses the target %s', (target) => {
    expect(() => raiseSql('m1', target)).toThrow(new Error('the target generation is not a positive whole number'));
  });

  it('takes the target 1', () => {
    expect(raiseSql('m1', 1)).toContain("VALUES (true, 'm1', 1, now())");
  });
});

describe('the take-over block', () => {
  it('writes the pg_hba file of the data directory', () => {
    expect(takeoverBlockScript('smdb').startsWith('f=/var/lib/postgresql/data/pg_hba.conf; ')).toBe(true);
  });

  it('refuses a role name that is not a plain identifier', () => {
    expect(() => takeoverBlockScript('a b')).toThrow(new Error("the bot's role name a b is not a plain identifier"));
  });
});

describe('cutAddressesSql', () => {
  it('keeps the own row', () => {
    expect(cutAddressesSql({ host: 'h.invalid', port: 5433 })).toContain("EXECUTE format('DELETE FROM smdb_manager.addresses WHERE NOT (host = %L AND port = 5433)', 'h.invalid');");
  });
});

describe('copiesInsertSql', () => {
  it('names the empty slot for a row without one', () => {
    expect(copiesInsertSql([{ host: 'c.invalid', port: 5440, cert: 'pem', machine: 'c' } as any])).toBe(
      "INSERT INTO smdb_manager.addresses (host, port, slot, cert, machine) SELECT 'c.invalid', 5440, '', 'pem', 'c' WHERE EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = '') ON CONFLICT (host, port) DO NOTHING;\n",
    );
  });

  it('joins two rows with nothing between them', () => {
    const row = { host: 'c.invalid', port: 5440, slot: 's', cert: 'p', machine: 'c' } as any;
    const one = copiesInsertSql([row]);
    expect(copiesInsertSql([row, row])).toBe(one + one);
  });
});

describe('the receive mark', () => {
  it('counts the mark rows', () => {
    expect(RECEIVE_MARK_COUNT_SQL).toBe('SELECT count(*) FROM smdb_manager.receive_mark');
  });

  it('clears every row when no mark id is named', () => {
    expect(receiveMarkClearSql(null)).toContain('  DELETE FROM smdb_manager.receive_mark;\n');
  });

  it('reads a last line with leading spaces', () => {
    expect(parseReceiveMark('x\n   ab|cd,ef|12')).toEqual({ markId: 'ab', pushIds: ['cd', 'ef'], dbOid: '12' });
  });

  it('refuses a line with text before the mark id', () => {
    expect(parseReceiveMark('g|ab|cd|1')).toBeUndefined();
  });
});

describe('pushBrokenOf', () => {
  it('a missing database is broken even when the mark held no oid', () => {
    expect(pushBrokenOf('', '', false)).toBe(true);
  });
});

describe('parseGenRow', () => {
  it('reads a last line with leading spaces', () => {
    expect(parseGenRow('x\n  5|m|s')).toEqual({ generation: 5, machine: 'm', since: 's' });
  });

  it('refuses text before the generation', () => {
    expect(parseGenRow('x5|m|s')).toBeUndefined();
  });

  it('refuses a fourth field', () => {
    expect(parseGenRow('5|m|s|t')).toBeUndefined();
  });

  it('reads a generation of two digits', () => {
    expect(parseGenRow('12|m|')).toEqual({ generation: 12, machine: 'm', since: null });
  });

  it('refuses a generation past the safe integers', () => {
    expect(parseGenRow('99999999999999999999|m|')).toBeUndefined();
  });
});

describe('restoreStateUpsertSql', () => {
  it('writes the live row', () => {
    expect(restoreStateUpsertSql('f.dump', { generation: 5, machine: 'm', since: '2026-10-30T00:00:00Z' }))
      .toContain("VALUES (true, true, 'f.dump', now(), 5, 'm', '2026-10-30T00:00:00Z'::timestamptz)");
  });

  it('writes generation 0 with no machine and no time when there is no live row', () => {
    expect(restoreStateUpsertSql('f.dump', null)).toContain("VALUES (true, true, 'f.dump', now(), 0, '', NULL::timestamptz)");
  });
});

describe('parseRestoreState', () => {
  it('reads a last line with leading spaces', () => {
    expect(parseRestoreState('x\n  false|f|a|1|m|')).toEqual({ pending: false, file: 'f', at: 'a', floor: { generation: 1, machine: 'm', since: null } });
  });

  it('refuses seven fields', () => {
    expect(parseRestoreState('true|f|a|1|m|s|x')).toBeUndefined();
  });
});

describe('generationBefore', () => {
  it('answers the live row on a tie', () => {
    const live = { generation: 4, machine: 'live', since: null };
    expect(generationBefore(live, { generation: 4, machine: 'floor', since: null })).toBe(live);
  });
});

describe('the guards', () => {
  it('names another machine when the hand-over names none', () => {
    expect(handoverMachine({ machine: '' } as any)).toBe('another machine');
  });

  it('a replaced main may still be stopped', () => {
    const instance = { id: 'a', fleetDb: { containerName: 'c', user: 'u', db: 'd', volume: 'v', replacedBy: { machine: 'b', generation: 3 } } } as any;
    expect(switchStateRefusal(instance, 'off')).toBeNull();
  });
});
