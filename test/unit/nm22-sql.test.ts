import { describe, expect, it } from 'vitest';
import {
  ADDRESS_DDL_SQL, BLOCKED_SESSIONS_SQL, COPY_GROUP, COPY_ROLES_READ_SQL, COPY_ROLES_SQL, FOREIGN_READ_SQL,
  FUNCTION_ACL_REPAIR_SQL, GEN_READ_SQL, LOGIN_RIGHTS_REPAIR_SQL, copyRolesStepSql,
  JOIN_LOGIN, LOBJ_SWEEP_SQL, LOGINS_READ_SQL, MEMBERSHIP_REPAIR_SQL, MINTER, NEW_LOGINS_READ_SQL, OWN_ADDRESS_SQL,
  RECEIVE_MARK_COUNT_SQL, REMOVE_BLOCK_SQL, ROLE_SETTINGS_RESET_SQL, SETTINGS_HOLDERS_SQL, SETTINGS_REPAIR_SQL,
  TAINTED_SLOT_SQL, copyGroupEnsureSql, copyLogin, copyLoginsLoopSql, copySlot, joinLoginSql, loginOfSlot, ownLoginSql,
  parseCopyRoles, parseForeignStreams, parseRemoveBlock,
} from '../../src/instance/switchSql';
import { COPY_SESSION_OPTIONS, MANAGER_SESSION_OPTIONS, botRoleRefusal, loginPsql } from '../../src/instance/dbLogin';

// A seeded generator in place of fast-check, which this repo's test folder does not install.
const seed = Number(process.env.SMDB_TEST_SEED) || 20261114;
function rng(s: number) {
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r: () => number, s: string) => s[Math.floor(r() * s.length)];
const hex = (r: () => number, n: number) => Array.from({ length: n }, () => pick(r, '0123456789abcdef')).join('');
const uuid = (r: () => number) => `${hex(r, 8)}-${hex(r, 4)}-${hex(r, 4)}-${hex(r, 4)}-${hex(r, 12)}`;

const V = 'SCRAM-SHA-256$4096:c2FsdHNhbHQ=$c3RvcmVka2V5c3RvcmVka2V5c3RvcmVrZXk=:c2VydmVya2V5c2VydmVya2V5c2VydmVya2V5';
const A = 'smdb_copy_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SLOT_A = 'fleet_standby_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'smdb_copy_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('names (3.2)', () => {
  it('the three role names', () => {
    expect([JOIN_LOGIN, COPY_GROUP, MINTER]).toEqual(['smdb_join', 'smdb_copies', 'smdb_minter']);
  });

  it(`copyLogin, copySlot and loginOfSlot over 2000 lowercase uuids (seed ${seed})`, () => {
    const r = rng(seed);
    for (let i = 0; i < 2000; i++) {
      const id = uuid(r);
      const login = copyLogin(id);
      const slot = copySlot(id);
      expect(login, id).toMatch(/^smdb_copy_[0-9a-f]{32}$/);
      expect(slot, id).toMatch(/^fleet_standby_[0-9a-f]{32}$/);
      expect(login.slice(10)).toBe(slot.slice(14));
      expect(loginOfSlot(slot), id).toBe(login);
    }
  });

  it(`loginOfSlot answers null for every other string (seed ${seed})`, () => {
    const r = rng(seed + 1);
    const alphabet = 'fleet_standby0123456789abcdefABCDEF-_ \n|';
    let checked = 0;
    for (let i = 0; i < 4000; i++) {
      const base = copySlot(uuid(r));
      const k = Math.floor(r() * (base.length + 1));
      const mode = Math.floor(r() * 4);
      const junk = pick(r, alphabet);
      const s = mode === 0 ? base.slice(0, k) + base.slice(k + 1)
        : mode === 1 ? base.slice(0, k) + junk + base.slice(k)
          : mode === 2 ? base.slice(0, k) + junk + base.slice(k + 1)
            : Array.from({ length: Math.floor(r() * 60) }, () => pick(r, alphabet)).join('');
      const answer = loginOfSlot(s);
      if (/^fleet_standby_[0-9a-f]{32}$/.test(s)) {
        expect(answer, s).toBe(`smdb_copy_${s.slice(14)}`);
      } else {
        expect(answer, JSON.stringify(s)).toBeNull();
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(3000);
  });

  it.each(['', 'fleet_standby', SLOT_A.toUpperCase(), `${SLOT_A}\n`, ` ${SLOT_A}`, `${SLOT_A}a`, A, 'fleet_standby_m'])('loginOfSlot(%j) is null', (s) => {
    expect(loginOfSlot(s)).toBeNull();
  });
});

const KEYS = ['join-missing', 'join-rights', 'join-member', 'group-missing', 'group-rights', 'minter-missing', 'minter-rights',
  'minter-grant', 'minter-member', 'login-rights', 'login-member', 'login-admin', 'login-granted', 'group-member',
  'function-missing', 'function-owner', 'function-acl', 'function-path', 'function-definer', 'role-settings'];

describe('COPY_ROLES_READ_SQL and parseCopyRoles (3.6.4, C3, R18)', () => {
  it.each([
    ['E13 ok', 'copyroles|ok\n', []],
    ['E13 ok without the newline', 'copyroles|ok', []],
    ['E14 one finding', 'copyroles|function-acl\n', ['function-acl']],
    ['E14 several findings', 'copyroles|join-rights,login-admin,group-member,role-settings\n', ['join-rights', 'login-admin', 'group-member', 'role-settings']],
    ['E15 an error line', 'ERROR:  permission denied for table pg_authid\n', null],
    ['E15 empty', '', null],
    ['E15 an empty list', 'copyroles|\n', null],
    ['E15 an unknown key', 'copyroles|join-rights,replicator\n', null],
    ['E15 a repeated key', 'copyroles|join-rights,join-rights\n', null],
    ['E15 keys out of order', 'copyroles|role-settings,join-rights\n', null],
    ['E15 ok beside a key', 'copyroles|ok,join-rights\n', null],
    ['E15 two lines', 'copyroles|ok\ncopyroles|ok\n', null],
    ['E15 a space', 'copyroles| ok\n', null],
  ])('%s', (_name, out, want) => {
    expect(parseCopyRoles(out)).toEqual(want);
  });

  it('the read names every key, C3 and R18 included, in the parse order', () => {
    let at = -1;
    for (const key of KEYS) {
      const i = COPY_ROLES_READ_SQL.indexOf(`'${key}'`);
      expect(i, key).toBeGreaterThan(at);
      at = i;
    }
    expect(COPY_ROLES_READ_SQL).toContain("'copyroles|'");
    expect(COPY_ROLES_READ_SQL).toContain('m.grantor = 10');
    expect(COPY_ROLES_READ_SQL).toContain("ARRAY['search_path=pg_catalog, pg_temp']");
  });

  it(`every subset of the keys, in order, reads back; any other change of a valid line reads null or a valid line (seed ${seed})`, () => {
    const r = rng(seed + 2);
    const alphabet = 'copyrlesk|,-ijnmtgdafu \n';
    let nulls = 0;
    for (let i = 0; i < 3000; i++) {
      const keys = KEYS.filter(() => r() < 0.3);
      const line = `copyroles|${keys.length ? keys.join(',') : 'ok'}`;
      expect(parseCopyRoles(`${line}\n`), line).toEqual(keys);
      const k = Math.floor(r() * (line.length + 1));
      const mode = Math.floor(r() * 3);
      const junk = pick(r, alphabet);
      const bent = mode === 0 ? line.slice(0, k) + line.slice(k + 1) : mode === 1 ? line.slice(0, k) + junk + line.slice(k) : line.slice(0, k) + junk + line.slice(k + 1);
      const parsed = parseCopyRoles(bent);
      if (parsed === null) {
        nulls++;
        continue;
      }
      expect(`copyroles|${parsed.length ? parsed.join(',') : 'ok'}`, JSON.stringify(bent)).toBe(bent.replace(/\n$/, ''));
    }
    expect(nulls).toBeGreaterThan(1000);
  });
});

describe('COPY_ROLES_SQL (3.3, C3, R18, R22)', () => {
  const GRANT_MINTER = 'GRANT smdb_copies TO smdb_minter WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;';

  it('holds the function as a definer with the pinned path, owned by the minter, executable only by smdb_join', () => {
    expect(COPY_ROLES_SQL).toContain('CREATE OR REPLACE FUNCTION smdb_manager.add_copy_login(p_name text, p_verifier text) RETURNS text\nLANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$');
    expect(COPY_ROLES_SQL).toContain('ALTER FUNCTION smdb_manager.add_copy_login(text, text) OWNER TO smdb_minter;');
    expect(COPY_ROLES_SQL).toContain('GRANT EXECUTE ON FUNCTION smdb_manager.add_copy_login(text, text) TO smdb_join;');
    expect(COPY_ROLES_SQL).toContain('GRANT USAGE ON SCHEMA smdb_manager TO smdb_join;');
    expect(COPY_ROLES_SQL).toContain("p_verifier !~ '^SCRAM-SHA-256\\$[0-9]+:[A-Za-z0-9+/=]+\\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$'");
  });

  it('the repairs come right before the minter grant, membership first; the function answers blocked for a login outside the group', () => {
    const m = COPY_ROLES_SQL.indexOf(MEMBERSHIP_REPAIR_SQL);
    const s = COPY_ROLES_SQL.indexOf(SETTINGS_REPAIR_SQL);
    expect(m).toBeGreaterThan(COPY_ROLES_SQL.indexOf('ALTER ROLE smdb_minter NOLOGIN NOSUPERUSER NOCREATEDB CREATEROLE REPLICATION NOBYPASSRLS;'));
    expect(COPY_ROLES_SQL.slice(m + MEMBERSHIP_REPAIR_SQL.length, s)).toBe('');
    expect(COPY_ROLES_SQL.slice(s + SETTINGS_REPAIR_SQL.length).startsWith(LOGIN_RIGHTS_REPAIR_SQL + GRANT_MINTER)).toBe(true);
    expect(MEMBERSHIP_REPAIR_SQL).toContain("EXECUTE pg_catalog.format('REVOKE %I FROM %I GRANTED BY %I CASCADE', r.role, r.member, r.grantor);");
    expect(SETTINGS_REPAIR_SQL).toContain("IN ('smdb_join', 'smdb_minter', 'smdb_copies')");
    expect(COPY_ROLES_SQL).toContain("RETURN 'exists';\n    END IF;\n    RETURN 'blocked';");
    expect(COPY_ROLES_SQL).not.toContain("WHERE rolname = p_name) THEN RETURN 'exists'; END IF;");
  });

  it('code review 1 finding 3: the minter\'s row in smdb_copies granted by the bootstrap superuser stays out of the loop; its other rows there are revoked without CASCADE', () => {
    expect(MEMBERSHIP_REPAIR_SQL).toContain("            AND NOT (m.member = 'smdb_minter'::regrole AND m.grantor = 10))\n");
    expect(MEMBERSHIP_REPAIR_SQL).toContain("(m.member = 'smdb_minter'::regrole AND m.roleid = 'smdb_copies'::regrole) AS minter");
    expect(MEMBERSHIP_REPAIR_SQL).toContain("    ELSIF r.minter THEN\n      EXECUTE pg_catalog.format('REVOKE %I FROM %I GRANTED BY %I', r.role, r.member, r.grantor);\n");
    expect(MEMBERSHIP_REPAIR_SQL).not.toContain('m.admin_option AND NOT m.inherit_option AND NOT m.set_option AND m.grantor = 10');
  });

  it('G1: the login rights repair takes the four rights off every role on the machine-login pattern, and nothing else', () => {
    expect(LOGIN_RIGHTS_REPAIR_SQL).toContain('FROM pg_catalog.pg_roles');
    expect(LOGIN_RIGHTS_REPAIR_SQL).toContain("~ '^smdb_copy_[0-9a-f]{32}$'");
    expect(LOGIN_RIGHTS_REPAIR_SQL).toContain('rolsuper OR');
    expect(LOGIN_RIGHTS_REPAIR_SQL).toMatch(/rolcreatedb OR [a-z.]*rolcreaterole OR [a-z.]*rolbypassrls/);
    expect(LOGIN_RIGHTS_REPAIR_SQL).toContain("EXECUTE pg_catalog.format('ALTER ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', ");
    expect(LOGIN_RIGHTS_REPAIR_SQL).not.toMatch(/\bLOGIN\b|REPLICATION|pg_auth_members/);
    expect(LOGIN_RIGHTS_REPAIR_SQL.startsWith('DO $$')).toBe(true);
    expect(LOGIN_RIGHTS_REPAIR_SQL.endsWith('END $$;\n')).toBe(true);
  });

  it('G2: the function ACL repair replaces the PUBLIC revoke, after the owner line and before the GRANT EXECUTE', () => {
    const owner = 'ALTER FUNCTION smdb_manager.add_copy_login(text, text) OWNER TO smdb_minter;\n';
    const grant = 'GRANT EXECUTE ON FUNCTION smdb_manager.add_copy_login(text, text) TO smdb_join;';
    expect(COPY_ROLES_SQL).toContain(owner + FUNCTION_ACL_REPAIR_SQL + grant);
    expect(COPY_ROLES_SQL).not.toMatch(/^REVOKE ALL ON FUNCTION smdb_manager\.add_copy_login/m);
    expect(FUNCTION_ACL_REPAIR_SQL).toContain("pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner)))");
    expect(FUNCTION_ACL_REPAIR_SQL).toContain("pg_catalog.to_regprocedure('smdb_manager.add_copy_login(text, text)')");
    expect(FUNCTION_ACL_REPAIR_SQL).toContain('a.grantee <> p.proowner');
    expect(FUNCTION_ACL_REPAIR_SQL).toContain("'REVOKE ALL ON FUNCTION smdb_manager.add_copy_login(text, text) FROM PUBLIC CASCADE'");
    expect(FUNCTION_ACL_REPAIR_SQL).toContain("pg_catalog.format('REVOKE ALL ON FUNCTION smdb_manager.add_copy_login(text, text) FROM %I CASCADE', ");
    expect(FUNCTION_ACL_REPAIR_SQL).toMatch(/IF [a-z.]*grantee = 0 THEN/);
    expect(FUNCTION_ACL_REPAIR_SQL.endsWith('END $$;\n')).toBe(true);
  });

  it.each([['LOGIN_RIGHTS_REPAIR_SQL', () => LOGIN_RIGHTS_REPAIR_SQL], ['FUNCTION_ACL_REPAIR_SQL', () => FUNCTION_ACL_REPAIR_SQL]])('G1, G2: %s calls only pg_catalog functions', (_name, text) => {
    const names = calledNames(text());
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(n.startsWith('pg_catalog.') || ALLOWED.has(n.toUpperCase()), n).toBe(true);
  });

  it.each([[false, false], [true, true], [false, true], [true, false]])('G3: the role step with the join login present %s and the own login present %s: the join statement, COPY_ROLES_SQL, the own login, the loop', (joinExists, ownExists) => {
    const t = copyRolesStepSql({ joinExists, joinVerifier: V, ownLogin: A, ownExists, ownVerifier: V });
    const join = joinLoginSql(joinExists, V);
    const own = ownLoginSql(A, ownExists, V);
    const loop = copyLoginsLoopSql('LOGIN');
    expect(t).toBe(join + COPY_ROLES_SQL + own + loop);
    expect(t.indexOf(join)).toBeLessThan(t.indexOf('TO smdb_join;'));
    expect(t.indexOf(own)).toBeGreaterThan(t.indexOf(COPY_ROLES_SQL) + COPY_ROLES_SQL.length - 1);
    expect(t.endsWith(loop)).toBe(true);
    expect(t).not.toMatch(/^(BEGIN|COMMIT);/m);
  });

  it('G3: the role step refuses a bad verifier or login name', () => {
    expect(() => copyRolesStepSql({ joinExists: true, joinVerifier: 'x', ownLogin: A, ownExists: true, ownVerifier: V })).toThrow();
    expect(() => copyRolesStepSql({ joinExists: true, joinVerifier: V, ownLogin: 'smdb_join', ownExists: true, ownVerifier: V })).toThrow();
  });

  it('holds no BEGIN or COMMIT (part 4 wraps the role step)', () => {
    expect(COPY_ROLES_SQL).not.toMatch(/^(BEGIN|COMMIT);/m);
  });

  it('the role statements and the reopening loop as 3.3 gives them', () => {
    expect(joinLoginSql(false, V)).toBe(`CREATE ROLE smdb_join LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${V}';\n`);
    expect(joinLoginSql(true, V)).toBe(`ALTER ROLE smdb_join LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${V}';\n`);
    expect(ownLoginSql(A, false, V)).toBe(`CREATE ROLE ${A} LOGIN REPLICATION NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS INHERIT PASSWORD '${V}' IN ROLE smdb_copies;\n`);
    expect(ownLoginSql(A, true, V)).toBe(`ALTER ROLE ${A} LOGIN REPLICATION PASSWORD '${V}';\nGRANT smdb_copies TO ${A};\n`);
    expect(copyLoginsLoopSql('LOGIN')).toBe("DO $$ DECLARE r record; BEGIN FOR r IN SELECT m.member::regrole::text AS n FROM pg_catalog.pg_auth_members m WHERE m.roleid = 'smdb_copies'::regrole AND m.member::regrole::text ~ '^smdb_copy_[0-9a-f]{32}$' LOOP EXECUTE pg_catalog.format('ALTER ROLE %I LOGIN', r.n); END LOOP; END $$;\n");
    expect(copyLoginsLoopSql('NOLOGIN')).toContain("'ALTER ROLE %I NOLOGIN'");
  });

  it.each([
    ['a quote in the verifier', () => joinLoginSql(true, `${V}'`)],
    ['a plain password', () => ownLoginSql(A, true, 'secret')],
    ['a login that is not a machine login', () => ownLoginSql('smdb_join', true, V)],
  ])('refuses %s', (_name, call) => {
    expect(call).toThrow();
  });
});

describe('ADDRESS_DDL_SQL and OWN_ADDRESS_SQL (3.4, R7, R10)', () => {
  it('grants only to smdb_copies and dbm_work, and no write on the table', () => {
    expect(ADDRESS_DDL_SQL).not.toContain('GRANT INSERT');
    expect(ADDRESS_DDL_SQL).not.toMatch(/GRANT [^;]*(UPDATE|DELETE)/);
    const grantees = [...ADDRESS_DDL_SQL.matchAll(/^GRANT [^;]* TO ([^;]+);$/gm)].flatMap(m => m[1].split(',').map((s: string) => s.trim()));
    expect(grantees.length).toBeGreaterThan(0);
    expect(new Set(grantees)).toEqual(new Set(['smdb_copies', 'dbm_work']));
    expect(ADDRESS_DDL_SQL).toContain('REVOKE ALL ON FUNCTION smdb_manager.set_copy_address(text, integer, text, text), smdb_manager.drop_copy_address() FROM PUBLIC;');
  });

  it('both functions are definers with the pinned path; set_copy_address names the holder (R10)', () => {
    expect(ADDRESS_DDL_SQL).toContain('CREATE OR REPLACE FUNCTION smdb_manager.set_copy_address(p_host text, p_port integer, p_cert text, p_machine text) RETURNS void\nLANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$');
    expect(ADDRESS_DDL_SQL).toContain('CREATE OR REPLACE FUNCTION smdb_manager.drop_copy_address() RETURNS integer\nLANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$');
    expect(ADDRESS_DDL_SQL).toContain('DECLARE v_login text := session_user; v_slot text; v_n integer; v_holder text;');
    expect(ADDRESS_DDL_SQL).toContain("RAISE EXCEPTION 'smdb-address-taken: %:% is listed as the main''s own address', p_host, p_port;");
    expect(ADDRESS_DDL_SQL).toContain("RAISE EXCEPTION 'smdb-address-taken: %:% is listed with the slot %', p_host, p_port, v_holder;");
    expect(ADDRESS_DDL_SQL).not.toContain('is listed for another machine');
  });

  it('holds no BEGIN or COMMIT, and ends with a newline so the own row can follow', () => {
    expect(ADDRESS_DDL_SQL).not.toMatch(/^(BEGIN|COMMIT);/m);
    expect(ADDRESS_DDL_SQL.endsWith(';\n')).toBe(true);
  });

  it('OWN_ADDRESS_SQL deletes the other main rows before its upsert, with the same literals', () => {
    const own = OWN_ADDRESS_SQL("o'host", 15432, 'PEM', 'machine a');
    expect(own).toBe(`DELETE FROM smdb_manager.addresses WHERE slot IS NULL AND NOT (host = 'o''host' AND port = 15432);
INSERT INTO smdb_manager.addresses (host, port, slot, cert, machine) VALUES ('o''host', 15432, NULL, 'PEM', 'machine a')
  ON CONFLICT (host, port) DO UPDATE SET slot = NULL, cert = EXCLUDED.cert, machine = EXCLUDED.machine, updated_at = now();
`);
  });

  it('copyGroupEnsureSql makes smdb_copies NOLOGIN and makes no login', () => {
    const t = copyGroupEnsureSql();
    expect(t).toContain('CREATE ROLE smdb_copies NOLOGIN');
    expect(t).not.toContain('LOGIN PASSWORD');
    expect(t).not.toMatch(/\bREPLICATION\b/);
  });
});

describe('the tick texts (R3)', () => {
  it('FOREIGN_READ_SQL, BLOCKED_SESSIONS_SQL, LOBJ_SWEEP_SQL and the new-logins read as R3 gives them', () => {
    expect(FOREIGN_READ_SQL).toBe(`SELECT s.slot_name || '|' || r.usename || '|' || r.pid
FROM pg_catalog.pg_replication_slots s JOIN pg_catalog.pg_stat_replication r ON r.pid = s.active_pid
WHERE s.slot_name ~ '^fleet_standby_[0-9a-f]{32}$'
  AND r.usename IS DISTINCT FROM 'smdb_copy_' || pg_catalog.substr(s.slot_name, 15);`);
    expect(BLOCKED_SESSIONS_SQL).toContain('a.client_addr IS NOT NULL');
    expect(BLOCKED_SESSIONS_SQL).toContain("m.roleid = pg_catalog.to_regrole('smdb_copies')");
    expect(LOBJ_SWEEP_SQL).toContain("SELECT 'unlinked|' || pg_catalog.count(pg_catalog.lo_unlink(l.oid)) FROM pg_catalog.pg_largeobject_metadata l;");
    expect(NEW_LOGINS_READ_SQL).toBe("SELECT string_agg(m.member::regrole::text, ',' ORDER BY 1) FROM pg_auth_members m WHERE m.roleid = to_regrole('smdb_copies')");
  });

  it('TAINTED_SLOT_SQL names the slot in each statement and refuses another name', () => {
    const t = TAINTED_SLOT_SQL(SLOT_A);
    expect(t.split(`slot_name = '${SLOT_A}'`).length - 1).toBe(3);
    expect(t).toContain('EXCEPTION WHEN object_in_use THEN NULL;');
    expect(() => TAINTED_SLOT_SQL("fleet_standby_x'; DROP")).toThrow();
  });

  it.each([
    ['Q23a line, a numeric pid', `${SLOT_A}|${B}|4711\n`, [{ slot: SLOT_A, user: B, pid: 4711 }], []],
    ['a role that is not a machine login', `${SLOT_A}|botrole|12\n`, [{ slot: SLOT_A, user: 'botrole', pid: 12 }], []],
    ['the run as printed, its pid masked', `${SLOT_A}|${B}|<pid>\n`, [], [`${SLOT_A}|${B}|<pid>`]],
    ['a fourth field', `${SLOT_A}|${B}|4711|true\n`, [], [`${SLOT_A}|${B}|4711|true`]],
    ['no line', '', [], []],
    ['two lines', `${SLOT_A}|${B}|1\n${SLOT_A}|${A}|2\n`, [{ slot: SLOT_A, user: B, pid: 1 }, { slot: SLOT_A, user: A, pid: 2 }], []],
  ])('parseForeignStreams: %s', (_name, out, streams, unread) => {
    expect(parseForeignStreams(out)).toEqual({ streams, unread });
  });
});

describe('REMOVE_BLOCK_SQL, ROLE_SETTINGS_RESET_SQL and the block answer (R4, R18, R31, R40)', () => {
  it('BEGIN, the GRANTED BY loop, NOLOGIN PASSWORD NULL, the settings reset, COMMIT, then the three-field read', () => {
    const t = REMOVE_BLOCK_SQL(A);
    const at = [
      t.indexOf('BEGIN;\n'),
      t.indexOf(`EXECUTE pg_catalog.format('REVOKE smdb_copies FROM %I GRANTED BY %I', '${A}', r.g);`),
      t.indexOf(`ALTER ROLE "${A}" NOLOGIN PASSWORD NULL;`),
      t.indexOf(ROLE_SETTINGS_RESET_SQL(A)),
      t.indexOf('COMMIT;\n'),
      t.indexOf("SELECT 'blocked|' ||"),
    ];
    expect(at.every(i => i >= 0), JSON.stringify(at)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    expect(t.startsWith('BEGIN;\n')).toBe(true);
    const read = t.slice(at[5]);
    expect(read.split("|| '|' ||").length).toBe(3);
    expect(read).toContain(`FROM pg_catalog.pg_authid r WHERE r.rolname = '${A}';`);
  });

  it('code review 1 finding 1: a 5 s lock limit first, then the login\'s sessions ended, before anything writes its role', () => {
    const t = REMOVE_BLOCK_SQL(A);
    expect(t.startsWith(`BEGIN;\nSET LOCAL lock_timeout = '5s';\nSELECT 'closed|' || pg_catalog.count(*) FILTER (WHERE pg_catalog.pg_terminate_backend(a.pid, 5000)) FROM pg_catalog.pg_stat_activity a WHERE a.usename IN ('${A}') AND a.pid <> pg_catalog.pg_backend_pid();\nDO $$ DECLARE r record; BEGIN\n`)).toBe(true);
  });

  it('ROLE_SETTINGS_RESET_SQL resets per database and role-wide', () => {
    expect(ROLE_SETTINGS_RESET_SQL(JOIN_LOGIN)).toBe(`DO $$ DECLARE d text; BEGIN
  FOR d IN SELECT db.datname FROM pg_catalog.pg_db_role_setting s JOIN pg_catalog.pg_database db ON db.oid = s.setdatabase
           WHERE s.setrole = pg_catalog.to_regrole('smdb_join') LOOP
    EXECUTE pg_catalog.format('ALTER ROLE %I IN DATABASE %I RESET ALL', 'smdb_join', d);
  END LOOP;
END $$;
ALTER ROLE "smdb_join" RESET ALL;
`);
  });

  it.each(['smdb_copy_x', "smdb_copy_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'", 'dbm_admin', 'replicator'])('REMOVE_BLOCK_SQL refuses %j', (name) => {
    expect(() => REMOVE_BLOCK_SQL(name)).toThrow();
  });

  it.each(['botrole', "smdb_join'", 'dbm_admin'])('ROLE_SETTINGS_RESET_SQL refuses %j', (name) => {
    expect(() => ROLE_SETTINGS_RESET_SQL(name)).toThrow();
  });

  it.each([
    ['Q30b: all true', 'blocked|true|true|true\n', { state: 'blocked', clean: true }],
    ['a password or setting written after the commit', 'blocked|true|true|false\n', { state: 'blocked', clean: false }],
    ['field 1 false', 'blocked|false|true|true\n', { state: 'again', line: 'blocked|false|true|true' }],
    ['field 2 false', 'blocked|true|false|false\n', { state: 'again', line: 'blocked|true|false|false' }],
    ['the old two-field form', 'blocked|true\n', { state: 'again', line: 'blocked|true' }],
    ['nothing at exit 0: the whole script ran, COMMIT included', '', { state: 'unconfirmed' }],
    ['command tags before the line', 'BEGIN\nDO\nALTER ROLE\nDO\nALTER ROLE\ncommitting\nCOMMIT\nblocked|true|true|true\n', { state: 'blocked', clean: true }],
  ])('parseRemoveBlock: %s', (_name, out, want) => {
    expect(parseRemoveBlock(out, { ok: true, stderr: '' })).toEqual(want);
  });

  const PSQL_STOP = 'psql:<stdin>:6: ERROR:  canceling statement due to lock timeout\n';
  const LOST = 'psql:<stdin>:14: server closed the connection unexpectedly\npsql:<stdin>:14: error: connection to server was lost\n';
  it.each([
    ['psql stopped on an ERROR before the marker: COMMIT never sent', 'BEGIN\nSET\nclosed|0\n', { ok: false, stderr: PSQL_STOP }, { state: 'none' }],
    ['psql lost the connection before the marker: COMMIT never sent', 'BEGIN\nSET\nclosed|0\nDO\nALTER ROLE\nDO\nALTER ROLE\n', { ok: false, stderr: LOST }, { state: 'none' }],
    ['the marker and no blocked line: COMMIT was sent, its outcome not read', 'BEGIN\nSET\nclosed|0\nDO\nALTER ROLE\nDO\nALTER ROLE\ncommitting\n', { ok: false, stderr: LOST }, { state: 'unconfirmed' }],
    ['a failure with no psql line (docker\'s own error)', '', { ok: false, stderr: 'Error response from daemon: container x is not running\n' }, { state: 'unconfirmed' }],
    ['only a psql WARNING line and exit 137 (killed, not by the time limit)', '', { ok: false, stderr: 'psql:<stdin>:6: WARNING:  PID 4242 is not a PostgreSQL backend process\n' }, { state: 'unconfirmed' }],
    ['a psql line, but the call timed out', 'BEGIN\n', { ok: false, stderr: PSQL_STOP, timedOut: true as const }, { state: 'unconfirmed' }],
  ])('parseRemoveBlock with no blocked line: %s', (_name, out, run, want) => {
    expect(parseRemoveBlock(out, run)).toEqual(want);
  });
});

describe('other reads (R4, R32)', () => {
  it('LOGINS_READ_SQL reads membership, login, slot and client per machine login', () => {
    expect(LOGINS_READ_SQL).toContain("'member', EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid AND m.roleid = pg_catalog.to_regrole('smdb_copies'))");
    expect(LOGINS_READ_SQL).toContain("WHERE r.rolname ~ '^smdb_copy_[0-9a-f]{32}$';");
  });

  it('SETTINGS_HOLDERS_SQL names the four kinds of holder', () => {
    expect(SETTINGS_HOLDERS_SQL).toContain("IN ('smdb_join', 'smdb_minter', 'smdb_copies')");
    expect(SETTINGS_HOLDERS_SQL).toContain("~ '^smdb_copy_[0-9a-f]{32}$';");
  });
});

/** Every word directly before '(' outside a string literal (R6). */
function calledNames(text: string): string[] {
  const bare = text.replace(/'(?:[^']|'')*'/g, "''");
  return [...bare.matchAll(/([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g)].map(m => m[1]);
}
const ALLOWED = new Set(['COALESCE', 'EXISTS', 'IN', 'VALUES', 'AND', 'OR', 'NOT', 'CASE', 'WHEN']);

describe('pg_catalog names in what a machine login or the join login runs (R6)', () => {
  it.each([['GEN_READ_SQL', GEN_READ_SQL], ['RECEIVE_MARK_COUNT_SQL', RECEIVE_MARK_COUNT_SQL]])('%s', (_name, text) => {
    const names = calledNames(text);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) {
      expect(n.startsWith('pg_catalog.') || n.startsWith('smdb_manager.') || ALLOWED.has(n.toUpperCase()), n).toBe(true);
    }
  });

  it('the check itself flags an unqualified call and passes a literal', () => {
    expect(calledNames("SELECT count(*) FROM t WHERE x = 'f(1)'")).toEqual(['count']);
  });

  it('GEN_READ_SQL still reads the row and falls back to 0||', () => {
    expect(GEN_READ_SQL).toContain("FROM smdb_manager.generation), '0||')");
    expect(RECEIVE_MARK_COUNT_SQL).toBe('SELECT pg_catalog.count(*) FROM smdb_manager.receive_mark');
  });
});

describe('dbLogin: COPY_SESSION_OPTIONS, loginPsql, botRoleRefusal (R18, R33, R4, 3.10)', () => {
  it('neither option set holds plpgsql.variable_conflict, which only a superuser may set', () => {
    expect(MANAGER_SESSION_OPTIONS).not.toContain('variable_conflict');
    expect(COPY_SESSION_OPTIONS).not.toContain('variable_conflict');
  });

  it('COPY_SESSION_OPTIONS is the manager options, then read-only off and role none', () => {
    const tail = ' -c default_transaction_read_only=off -c role=none';
    expect(COPY_SESSION_OPTIONS.endsWith(tail)).toBe(true);
    expect(COPY_SESSION_OPTIONS.slice(0, -tail.length)).toBe(MANAGER_SESSION_OPTIONS);
    expect(COPY_SESSION_OPTIONS.startsWith('-c search_path=pg_catalog,pg_temp ')).toBe(true);
  });

  it('loginPsql runs psql as the machine login over the socket with COPY_SESSION_OPTIONS', () => {
    expect(loginPsql(A, 'db-c', 'app', 'DROP OWNED BY CURRENT_USER')).toEqual({
      login: A,
      args: ['exec', '-e', `PGOPTIONS=${COPY_SESSION_OPTIONS}`, 'db-c', 'psql', '-U', A, '-d', 'app', '-tA', '-v', 'ON_ERROR_STOP=1', '-c', 'DROP OWNED BY CURRENT_USER'],
    });
  });

  it.each(['smdb_join', 'dbm_admin', 'smdb_copy_x', `${A} -c x`])('loginPsql refuses %j', (name) => {
    expect(() => loginPsql(name, 'db-c', 'app', 'SELECT 1')).toThrow();
  });

  const R14 = (u: string) => `The app's database role name ${u} cannot be used by the maintenance tool (it must be a plain lower-case name other than dbm_admin, dbm_meta, dbm_work, smdb_join, smdb_copies, smdb_minter, smdb_receive and smdb_receive_meta, and must not start with smdb_copy_); nothing was changed`;

  it.each(['smdb_join', 'smdb_copies', 'smdb_minter', A, 'smdb_copy_x', 'smdb_copy_', 'dbm_work'])('botRoleRefusal refuses %s', (u) => {
    expect(botRoleRefusal(u)).toBe(R14(u));
  });

  it.each(['replicator', 'smdb', 'smdb_copy', 'smdb_copies_x', 'smdb_joins', 'bot_1'])('botRoleRefusal accepts %s', (u) => {
    expect(botRoleRefusal(u)).toBeNull();
  });
});
