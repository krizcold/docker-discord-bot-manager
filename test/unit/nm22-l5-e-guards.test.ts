import { describe, expect, it } from 'vitest';
import {
  ROLE_SETTINGS_RESET_SQL, TAINTED_SLOT_SQL, closedCount, joinLoginSql, lockedRoleWriteSql, ownLoginSql,
  parseForeignStreams, parseRemoveBlock,
} from '../../src/instance/switchSql';
import { loginPsql } from '../../src/instance/dbLogin';

const HEX = '0123456789abcdef0123456789abcdef';
const LOGIN = `smdb_copy_${HEX}`;
const VERIFIER = 'SCRAM-SHA-256$4096:c2FsdA==$c3RvcmVk:c2VydmVy';

describe('NM22 L5 e: name and verifier guards', () => {
  it('loginPsql refuses a name with text before the machine login', () => {
    expect(() => loginPsql(`x${LOGIN}`, 'c', 'db', 'SELECT 1')).toThrow(new Error(`x${LOGIN} is not a machine login name`));
    expect(loginPsql(LOGIN, 'c', 'db', 'SELECT 1').login).toBe(LOGIN);
  });

  it('ownLoginSql refuses a name with text before the machine login', () => {
    expect(() => ownLoginSql(`x${LOGIN}`, false, VERIFIER)).toThrow(new Error(`x${LOGIN} is not a machine login name`));
    expect(ownLoginSql(LOGIN, false, VERIFIER)).toContain(LOGIN);
  });

  it('joinLoginSql refuses a verifier with text before SCRAM-SHA-256', () => {
    expect(() => joinLoginSql(false, `x${VERIFIER}`)).toThrow(new Error('the password is not a SCRAM-SHA-256 verifier'));
    expect(joinLoginSql(false, VERIFIER)).toContain(VERIFIER);
  });

  it('TAINTED_SLOT_SQL refuses a name that is not a machine slot', () => {
    expect(() => TAINTED_SLOT_SQL('other_slot')).toThrow(new Error("other_slot is not a machine's slot name"));
  });

  it('ROLE_SETTINGS_RESET_SQL takes smdb_minter and smdb_copies and refuses another role', () => {
    expect(ROLE_SETTINGS_RESET_SQL('smdb_minter')).toContain('ALTER ROLE "smdb_minter" RESET ALL;');
    expect(ROLE_SETTINGS_RESET_SQL('smdb_copies')).toContain('ALTER ROLE "smdb_copies" RESET ALL;');
    expect(() => ROLE_SETTINGS_RESET_SQL('postgres')).toThrow(new Error('postgres is not a role whose settings the manager clears'));
  });

  it('lockedRoleWriteSql refuses a login that is neither smdb_join nor a machine login', () => {
    expect(() => lockedRoleWriteSql(['postgres'])).toThrow(new Error('postgres is not a machine login name'));
    expect(lockedRoleWriteSql(['smdb_join', LOGIN])).toContain(`'smdb_join', '${LOGIN}'`);
  });
});

describe('NM22 L5 e: answer parsers', () => {
  it('parseForeignStreams leaves a line with text before the slot unread', () => {
    const line = `xfleet_standby_${HEX}|smdb_copy_x|42`;
    expect(parseForeignStreams(line)).toEqual({ streams: [], unread: [line] });
  });

  it('closedCount reads only a whole closed line of digits', () => {
    expect(closedCount('closed|12')).toBe(12);
    expect(closedCount('xclosed|3')).toBe(0);
    expect(closedCount('closed|3x')).toBe(0);
  });

  it('parseRemoveBlock reads only a whole blocked line', () => {
    expect(parseRemoveBlock('blocked|blocked|true|true|true')).toEqual({ state: 'again', line: 'blocked|blocked|true|true|true' });
    expect(parseRemoveBlock('blocked|true|true|truex')).toEqual({ state: 'again', line: 'blocked|true|true|truex' });
    expect(parseRemoveBlock('blocked|true|true|false')).toEqual({ state: 'blocked', clean: false });
  });
});
