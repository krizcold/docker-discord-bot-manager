import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm22-sites-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, loginFails: [] as string[], replFails: [] as string[], loginWrites: [] as Array<{ at: number; login: unknown }> };
});

vi.mock('child_process', async (importOriginal) => (await import('./nm22-lane-fake')).laneChildProcess(await importOriginal<typeof import('child_process')>()));
vi.mock('../../src/instance/fleetJoin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetJoin')>()),
  sendAddresses: async () => ({ state: 'applied' }),
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  const { lane } = await import('./nm22-lane-fake');
  return {
    ...real,
    updateInstanceFleetLogin: (id: string, login: any) => {
      h.loginWrites.push({ at: lane.calls.length, login });
      const fail = h.loginFails.shift();
      if (fail) throw new Error(fail);
      return (real as any).updateInstanceFleetLogin(id, login);
    },
    updateInstanceFleetDbReplication: (...a: any[]) => {
      const fail = h.replFails.shift();
      if (fail) throw new Error(fail);
      return (real as any).updateInstanceFleetDbReplication(...a);
    },
  };
});

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { QUIET_ROLE_SESSION_SQL, verifierAccepts } from '../../src/config/secretText';
import { decodeJoinCode, machineText } from '../../src/config/joinCode';
import {
  addressTableSql, disableFleetReplication, enableFleetReplication, getFleetReplicationStatus, getJoinCode, pgHbaContent, renewJoinCode,
} from '../../src/instance/fleetReplication';
import {
  ADDRESS_DDL_SQL, COPY_ROLES_SQL, MEMBERSHIP_REPAIR_SQL, OWN_ADDRESS_SQL, ROLE_SETTINGS_RESET_SQL, SETTINGS_REPAIR_SQL, copyLoginsLoopSql,
} from '../../src/instance/switchSql';
import * as fleetBackup from '../../src/instance/fleetBackup';
import { FIXTURE_PEM } from './join-fake';
import { lane, resetLane, sqlTexts } from './nm22-lane-fake';

const ID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const OWN = 'smdb_copy_0f1e2d3c4b5a49688776655443322110';
const OWN_SLOT = 'fleet_standby_0f1e2d3c4b5a49688776655443322110';
const OTHER = 'smdb_copy_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OWN_PW = 'Own-Machine-Secret-01';
const JOIN_PW = 'Join-Secret-0123456789';
const REGISTRY = path.join(h.dir, 'instances.json');
const dbUrl = 'postgresql://smdb:Db-Secret%2C%25x@m-fleet-postgres:5432/smdb?sslmode=no-verify';
const fleetDb = { containerName: 'm-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'm-fleet-postgres-data', password: 'Db-Secret,%x' };
const replication = { role: 'smdb_join', password: JOIN_PW, hostPort: 15432, publicHost: 'main.invalid', certHost: 'main.invalid', slotWalKeepMb: 4096 };
const switchRecord = { machine: 'copy.invalid', host: 'copy.invalid', port: 15433, generation: 3, own: 2, since: null, at: '2026-11-01T00:00:00.000Z' };

const writeRegistry = (db: Record<string, unknown> = { ...fleetDb, replication }, ownPassword: string | null = OWN_PW): void => {
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { [ID]: {
    id: ID, sanitizedName: 'm', displayName: 'M', titleName: 'M', status: 'running', sourceType: 'git',
    sourceUrl: 'https://example.invalid/fake/super-modular-discord-bot', envVars: { DATA_BACKEND: 'postgres' },
    createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', fleetDb: db,
  } } }));
  // The real writer encrypts the password; the reads below decrypt it.
  if (ownPassword !== null) (containerManager as any).updateInstanceFleetLogin(ID, { password: ownPassword });
  h.loginWrites = [];
};
const bot = () => containerManager.getBot(ID)!;
const stdinOf = (needle: string) => lane.calls.find(c => c.stdin.includes(needle))?.stdin ?? '';
const verifierAfter = (text: string, prefix: string) => new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^']*'(SCRAM-SHA-256\\$[^']+)'`).exec(text)?.[1] ?? '';

beforeEach(() => {
  resetLane();
  h.loginFails = [];
  h.replFails = [];
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', ID, 'env'), { recursive: true });
  writeRegistry();
  envManager.setEnvVars(ID, { DATA_BACKEND_URL: dbUrl });
});
afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));

describe('NM22 the managed pg_hba (R2, R28)', () => {
  it('holds both reject lines before its first host line, the database quoted, and +smdb_copies on the replication line', () => {
    const text = pgHbaContent('smdb', ['10.1.2.3']);
    const lines = text.split('\n');
    const firstHost = lines.findIndex(l => /^host\s+all\s/.test(l));
    const tpl = lines.findIndex(l => l === 'host    template1       smdb_join,+smdb_copies  all             reject');
    const db = lines.findIndex(l => l === 'host    "smdb"          smdb_join               all             reject');
    expect(tpl).toBeGreaterThan(0);
    expect(db).toBe(tpl + 1);
    expect(firstHost).toBeGreaterThan(db);
    expect(lines).toContain('hostssl replication     +smdb_copies    0.0.0.0/0               scram-sha-256');
    expect(text).not.toMatch(/replication\s+all\s/);
    expect(text).toContain('host    all             all             10.1.2.3/32             scram-sha-256');
  });

  it('Enable writes the file with the bot\'s database name', async () => {
    writeRegistry({ ...fleetDb });
    expect((await enableFleetReplication(bot(), 'main.invalid', 15432)).success).toBe(true);
    expect(stdinOf('# Managed by discord-bot-manager')).toBe(pgHbaContent('smdb', []));
  });
});

describe('NM22 Enable (O4 E1 to E9, E21, E25, E27, E30; R7, R11, R13)', () => {
  it('E1 no own password stored: one is made and saved before any docker call, and the role step sets the own login with it', async () => {
    writeRegistry({ ...fleetDb }, null);
    expect((await enableFleetReplication(bot(), 'main.invalid', 15432)).success).toBe(true);
    expect(h.loginWrites).toHaveLength(1);
    expect(h.loginWrites[0].at).toBe(0);
    const saved = bot().fleetLogin!.password;
    expect(saved).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const step = stdinOf('smdb_manager.add_copy_login');
    expect(await verifierAccepts(verifierAfter(step, `ALTER ROLE ${OWN} LOGIN REPLICATION PASSWORD`), saved, OWN)).toBe(true);
  });

  it('E2 the save fails: EN-SAVE, and no docker call ran', async () => {
    writeRegistry({ ...fleetDb }, null);
    h.loginFails = ['the registry is read-only'];
    expect(await enableFleetReplication(bot(), 'main.invalid', 15432)).toEqual({ success: false, error: "The password of this machine's own login could not be saved (the registry is read-only); replication was not set up" });
    expect(lane.dockerCalls).toBe(0);
    expect(bot().fleetDb!.replication).toBeUndefined();
  });

  it('E3 a password saved by an Enable that failed later is the one the next Enable uses', async () => {
    writeRegistry({ ...fleetDb }, null);
    lane.rules.push({ match: 'smdb_manager.add_copy_login', code: 3, err: 'psql:<stdin>:9: ERROR:  out of shared memory\n', once: true });
    expect((await enableFleetReplication(bot(), 'main.invalid', 15432)).success).toBe(false);
    const saved = bot().fleetLogin!.password;
    lane.calls = [];
    expect((await enableFleetReplication(bot(), 'main.invalid', 15432)).success).toBe(true);
    expect(h.loginWrites).toHaveLength(1);
    expect(await verifierAccepts(verifierAfter(stdinOf('smdb_manager.add_copy_login'), `ALTER ROLE ${OWN} LOGIN REPLICATION PASSWORD`), saved, OWN)).toBe(true);
  });

  it('E4 and E25 a stored own password is reused and never renewed', async () => {
    expect((await enableFleetReplication(bot(), 'main.invalid', 15432)).success).toBe(true);
    expect(h.loginWrites).toHaveLength(0);
    expect(bot().fleetLogin!.password).toBe(OWN_PW);
    expect(await verifierAccepts(verifierAfter(stdinOf('smdb_manager.add_copy_login'), `ALTER ROLE ${OWN} LOGIN REPLICATION PASSWORD`), OWN_PW, OWN)).toBe(true);
  });

  it('E5, E7, R7 the role step is one transaction: the join login, COPY_ROLES_SQL, the own login and the reopening loop', async () => {
    writeRegistry({ ...fleetDb });
    lane.joinExists = false;
    lane.ownExists = false;
    expect((await enableFleetReplication(bot(), 'main.invalid', 15432)).success).toBe(true);
    const step = stdinOf('smdb_manager.add_copy_login');
    expect(step.startsWith(`BEGIN;\nSET LOCAL lock_timeout = '5s';\n${QUIET_ROLE_SESSION_SQL}CREATE ROLE smdb_join LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'SCRAM-SHA-256$`)).toBe(true);
    expect(step.endsWith(`${copyLoginsLoopSql('LOGIN')}COMMIT;\n`)).toBe(true);
    const roles = step.indexOf(COPY_ROLES_SQL);
    const own = step.indexOf(`CREATE ROLE ${OWN} LOGIN REPLICATION NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS INHERIT PASSWORD 'SCRAM-SHA-256$`);
    expect(roles).toBeGreaterThan(step.indexOf('CREATE ROLE smdb_join'));
    expect(own).toBeGreaterThan(roles + COPY_ROLES_SQL.length - 1);
    for (const part of ['CREATE OR REPLACE FUNCTION smdb_manager.add_copy_login', 'ALTER FUNCTION smdb_manager.add_copy_login(text, text) OWNER TO smdb_minter', 'REVOKE ALL ON FUNCTION smdb_manager.add_copy_login(text, text) FROM PUBLIC CASCADE', 'GRANT EXECUTE ON FUNCTION smdb_manager.add_copy_login(text, text) TO smdb_join']) {
      expect(step.indexOf(part)).toBeGreaterThan(step.indexOf('BEGIN;'));
      expect(step.indexOf(part)).toBeLessThan(step.lastIndexOf('COMMIT;'));
    }
    expect(step).not.toContain(JOIN_PW);
    expect(step).not.toContain(OWN_PW);
  });

  it('E5 with both logins present: ALTER for each, and the own login rejoins the group', async () => {
    expect((await enableFleetReplication(bot(), 'main.invalid', 15432)).success).toBe(true);
    const step = stdinOf('smdb_manager.add_copy_login');
    expect(step).toContain("ALTER ROLE smdb_join LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'SCRAM-SHA-256$");
    expect(step).toContain(`GRANT smdb_copies TO ${OWN};\n`);
    expect(await verifierAccepts(verifierAfter(step, 'ALTER ROLE smdb_join LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD'), JOIN_PW, 'smdb_join')).toBe(true);
  });

  it('E21 and E27 the role step holds the membership, settings and rights repairs before the own login', async () => {
    expect((await enableFleetReplication(bot(), 'main.invalid', 15432)).success).toBe(true);
    const step = stdinOf('smdb_manager.add_copy_login');
    expect(step.indexOf(MEMBERSHIP_REPAIR_SQL)).toBeGreaterThan(0);
    expect(step.indexOf(SETTINGS_REPAIR_SQL)).toBeGreaterThan(step.indexOf(MEMBERSHIP_REPAIR_SQL));
    expect(step.indexOf(`ALTER ROLE ${OWN} LOGIN`)).toBeGreaterThan(step.indexOf(SETTINGS_REPAIR_SQL));
  });

  it('E6 the role step fails: its reason, and nothing after it ran', async () => {
    lane.rules.push({ match: 'smdb_manager.add_copy_login', code: 3, err: 'NOTICE:  schema "smdb_manager" already exists, skipping\npsql:<stdin>:40: ERROR:  permission denied to create role\n' });
    expect(await enableFleetReplication(bot(), 'main.invalid', 15432)).toEqual({ success: false, certRotated: false, error: 'setting up the machine logins failed: permission denied to create role' });
    expect(sqlTexts().some(t => t.includes('ALTER SYSTEM'))).toBe(false);
    expect(bot().fleetDb!.replication).toEqual(replication);
  });

  it('code review 2 finding 2: the role step opens with the 5 s lock limit and ends no session', async () => {
    expect((await enableFleetReplication(bot(), 'main.invalid', 15432)).success).toBe(true);
    const step = stdinOf('smdb_manager.add_copy_login');
    expect(step.startsWith(`BEGIN;\nSET LOCAL lock_timeout = '5s';\n${QUIET_ROLE_SESSION_SQL}`)).toBe(true);
    expect(step).not.toContain('pg_terminate_backend');
  });

  it('code review 2 finding 2: the role step stops on the lock limit: its reason; on the call\'s own time limit: can\'t confirm', async () => {
    lane.rules.push({ match: 'smdb_manager.add_copy_login', code: 3, err: 'psql:<stdin>:30: ERROR:  canceling statement due to lock timeout\n', once: true });
    expect(await enableFleetReplication(bot(), 'main.invalid', 15432)).toEqual({ success: false, certRotated: false, error: 'setting up the machine logins failed: canceling statement due to lock timeout' });
    lane.rules.push({ match: 'smdb_manager.add_copy_login', hang: true });
    vi.useFakeTimers();
    try {
      const pending = enableFleetReplication(bot(), 'main.invalid', 15432);
      await vi.advanceTimersByTimeAsync(31_000);
      expect(await pending).toEqual({ success: false, certRotated: false, error: "the manager can't confirm whether the machine logins were set up: the database did not answer within 30 s, and the change may still be applied there; press Enable replication again" });
    } finally {
      vi.useRealTimers();
    }
    expect(sqlTexts().some(t => t.includes('ALTER SYSTEM'))).toBe(false);
  });

  it('E8 the reopening loop opens every member of the group', async () => {
    expect((await enableFleetReplication(bot(), 'main.invalid', 15432)).success).toBe(true);
    expect(stdinOf('smdb_manager.add_copy_login')).toContain(copyLoginsLoopSql('LOGIN'));
  });

  it('E9 and R7 the address step is the DDL, the functions and the own row in one transaction, as dbm_meta', async () => {
    expect((await enableFleetReplication(bot(), 'main.invalid', 15432)).success).toBe(true);
    const call = lane.calls.find(c => c.stdin.includes('CREATE OR REPLACE FUNCTION smdb_manager.set_copy_address'))!;
    expect(call.args).toContain('-U dbm_meta -d smdb');
    expect(call.stdin).toBe(`BEGIN;\n${ADDRESS_DDL_SQL}${OWN_ADDRESS_SQL('main.invalid', 15432, FIXTURE_PEM.trim(), machineText('main.invalid'))}COMMIT;\n`);
  });

  it('addressTableSql is ADDRESS_DDL_SQL followed by OWN_ADDRESS_SQL', () => {
    expect(addressTableSql('h.invalid', 5432, 'PEM', 'h')).toBe(`${ADDRESS_DDL_SQL}${OWN_ADDRESS_SQL('h.invalid', 5432, 'PEM', 'h')}`);
  });

  it('the record names the join login', async () => {
    writeRegistry({ ...fleetDb });
    expect((await enableFleetReplication(bot(), 'main.invalid', 15432)).success).toBe(true);
    expect(bot().fleetDb!.replication!.role).toBe('smdb_join');
  });

  it("R11 Enable's save failure names what the database already has", async () => {
    h.replFails = ['disk full'];
    const r = await enableFleetReplication(bot(), 'main.invalid', 15432);
    expect(r.error).toBe("The database URL or the replication record could not be saved (disk full); the database already has the join login, this machine's own login, ssl, the WAL settings, the server certificate and the managed pg_hba. Press Enable again once the store can be written");
  });

  it('E30 Enable with a join password that no longer decrypts: R23\'s text, no role step', async () => {
    writeRegistry({ ...fleetDb, replication: { ...replication, password: '' } });
    expect(await enableFleetReplication(bot(), 'main.invalid', 15432)).toEqual({ success: false, error: 'The stored join password no longer decrypts (the manager encryption key changed or was lost). Restore the key, or press New join code to make a new one (machines that joined keep their own logins), then press Enable replication again.' });
    expect(lane.calls.some(c => c.stdin.includes('add_copy_login'))).toBe(false);
  });
});

describe('NM22 Disable (O4 E10 to E12; R4, R11)', () => {
  it('E10 a machine login streams without a slot: DIS-SENDERS, read over members and the machine-login pattern', async () => {
    lane.rules.push({ match: 'FROM pg_stat_replication r WHERE', out: '10.0.0.5\n' });
    expect(await disableFleetReplication(bot())).toEqual({ success: false, error: 'Machine logins have replication connections open from 10.0.0.5 (a standby streaming without a slot, or a seed copying the database); stop or remove them first (nothing was disabled)' });
    const read = sqlTexts().find(t => t.includes('FROM pg_stat_replication r WHERE'))!;
    expect(read).toContain("r.usename ~ '^smdb_copy_[0-9a-f]{32}$' OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.usesysid AND m.roleid = pg_catalog.to_regrole('smdb_copies'))");
  });

  it('E11 the join login and every member are closed', async () => {
    expect((await disableFleetReplication(bot())).success).toBe(true);
    expect(sqlTexts()).toContain(`BEGIN;\nSET LOCAL lock_timeout = '5s';\nSELECT 'closed|' || pg_catalog.count(*) FILTER (WHERE pg_catalog.pg_terminate_backend(a.pid, 5000)) FROM pg_catalog.pg_stat_activity a WHERE a.usename IN ('smdb_join') AND a.pid <> pg_catalog.pg_backend_pid();\nALTER ROLE smdb_join NOLOGIN;\n${copyLoginsLoopSql('NOLOGIN')}COMMIT;\n`);
  });

  it.each([
    ['1', "; smdb_join's open session was ended"],
    ['3', "; smdb_join's 3 open sessions were ended"],
    ['0', ''],
  ])('code review 3 finding 1: the close ended %s of smdb_join\'s sessions before it failed: DIS-REVOKE says so', async (n, ended) => {
    lane.rules.push({ match: 'ALTER ROLE smdb_join NOLOGIN', code: 3, out: `BEGIN\nSET\nclosed|${n}\n`, err: 'psql:<stdin>:4: ERROR:  canceling statement due to lock timeout\n' });
    expect(await disableFleetReplication(bot())).toEqual({ success: false, error: `revoking the join login and the machine logins failed (the slots are dropped; retry to finish disabling): canceling statement due to lock timeout${ended}` });
  });

  it('code review 2 finding 2: the close ends on the call\'s own time limit: can\'t confirm, never "failed"', async () => {
    lane.rules.push({ match: 'ALTER ROLE smdb_join NOLOGIN', hang: true });
    vi.useFakeTimers();
    try {
      const pending = disableFleetReplication(bot());
      await vi.advanceTimersByTimeAsync(31_000);
      expect(await pending).toEqual({ success: false, error: "the manager can't confirm whether the join login and the machine logins were closed: the database did not answer within 30 s, and the change may still be applied there (the slots are dropped); press Disable replication again to finish it" });
    } finally {
      vi.useRealTimers();
    }
  });

  it('E12 the close fails: DIS-REVOKE with the reason', async () => {
    lane.rules.push({ match: 'ALTER ROLE smdb_join NOLOGIN', code: 1, err: 'ERROR:  role "smdb_copies" does not exist\n' });
    expect(await disableFleetReplication(bot())).toEqual({ success: false, error: 'revoking the join login and the machine logins failed (the slots are dropped; retry to finish disabling): role "smdb_copies" does not exist' });
  });

  it('R11 the save failure after the close', async () => {
    h.replFails = ['', 'disk full'];
    expect((await disableFleetReplication(bot())).error).toBe("Replication is off on the database (the slots are dropped and the join login and the machines' logins are closed), but the database URL or the replication record could not be saved (disk full); press Disable replication again to finish it");
  });
});

describe('NM22 the join code (O4 E13 to E15, E30, E31; R23, R32, R41, R43)', () => {
  it('E13 the read answers ok: the code carries the join login and no note', async () => {
    const r = await getJoinCode(bot());
    expect(r.success).toBe(true);
    expect(r.note).toBeUndefined();
    expect((decodeJoinCode(r.joinCode!) as any).code.repl).toEqual({ user: 'smdb_join', password: JOIN_PW });
    expect(sqlTexts().some(t => t.includes("'copyroles|'") && t.includes('-U dbm_admin -d postgres'))).toBe(true);
  });

  it('E14 a finding refuses with JC-COPYROLES', async () => {
    lane.copyRoles = 'copyroles|join-rights,role-settings';
    expect(await getJoinCode(bot())).toEqual({ success: false, error: 'The logins that machines get with the join code are not set up as the manager needs (join-rights, role-settings), so no join code was made; press Enable replication to set them up again' });
  });

  it('E15 an answer of another shape refuses with the text as read', async () => {
    lane.copyRoles = 'copyroles|bogus';
    expect((await getJoinCode(bot())).error).toBe('The logins that machines get with the join code are not set up as the manager needs (copyroles|bogus), so no join code was made; press Enable replication to set them up again');
  });

  it('a failed read refuses and says the logins could not be checked', async () => {
    lane.rules.push({ match: "'copyroles|'", code: 2, err: 'psql: error: connection to server on socket failed\n' });
    expect((await getJoinCode(bot())).error).toBe('The logins that machines get with the join code could not be checked (connection to server on socket failed), so no join code was made');
  });

  const holders: Array<[string, Record<string, unknown>, string, string]> = [
    ['another machine\'s login', {}, OTHER, `${OTHER} (remove it in the Machine logins list)`],
    ['the join login', {}, 'smdb_join', 'smdb_join (press New join code)'],
    ['the own login', {}, OWN, `${OWN} (press New join code)`],
    ['the own login while replacedBy', { replacedBy: switchRecord }, OWN, `${OWN} (press Enable replication)`],
    ['the own login while mainConflict', { mainConflict: switchRecord }, OWN, `${OWN} (press Enable replication)`],
    ['the own login while formerMain', { formerMain: { ...switchRecord, code: 'x', slot: OWN_SLOT } }, OWN, `${OWN} (press Enable replication)`],
    ['the minter', {}, 'smdb_minter', 'smdb_minter (press Enable replication)'],
    ['the group', {}, 'smdb_copies', 'smdb_copies (press Enable replication)'],
  ];
  it.each(holders)('E31 role-settings on %s: the code with JC-SETTINGS and its step', async (_name, extra, holder, entry) => {
    writeRegistry({ ...fleetDb, replication, ...extra });
    lane.copyRoles = 'copyroles|role-settings';
    lane.holders = holder;
    const r = await getJoinCode(bot());
    expect(r.success).toBe(true);
    expect(r.joinCode).toBeTruthy();
    expect(r.note).toBe(`Some logins carry session settings of their own, which the manager's sessions override: ${entry}.`);
  });

  it('E31 several holders in the read\'s order, joined by semicolons', async () => {
    lane.copyRoles = 'copyroles|role-settings';
    lane.holders = `smdb_copies,${OTHER},smdb_join`;
    expect((await getJoinCode(bot())).note).toBe(`Some logins carry session settings of their own, which the manager's sessions override: smdb_copies (press Enable replication); ${OTHER} (remove it in the Machine logins list); smdb_join (press New join code).`);
  });

  it('E31 the holders read fails: the note without names', async () => {
    lane.copyRoles = 'copyroles|role-settings';
    lane.rules.push({ match: 'string_agg(DISTINCT pg_catalog.pg_get_userbyid(s.setrole)', code: 1, err: 'ERROR:  x\n' });
    const r = await getJoinCode(bot());
    expect(r.success).toBe(true);
    expect(r.note).toBe("Some logins carry session settings of their own, which the manager's sessions override; Enable replication clears them.");
  });

  it('E31 after New join code, the fetch of the code carries the note', async () => {
    lane.copyRoles = 'copyroles|role-settings';
    lane.holders = 'smdb_join';
    expect((await renewJoinCode(bot())).success).toBe(true);
    expect((await getJoinCode(bot())).note).toBe("Some logins carry session settings of their own, which the manager's sessions override: smdb_join (press New join code).");
  });

  it('E30 the join password no longer decrypts: R23\'s text', async () => {
    writeRegistry({ ...fleetDb, replication: { ...replication, password: '' } });
    expect(await getJoinCode(bot())).toEqual({ success: false, error: 'The stored join password no longer decrypts (the manager encryption key changed or was lost). Restore the key, or press New join code to make a new one; machines that joined keep their own logins.' });
  });

  it('R23 an unfinished Disable', async () => {
    writeRegistry({ ...fleetDb, replication: { ...replication, disablingSince: '2026-11-01T00:00:00.000Z' } });
    expect((await getJoinCode(bot())).error).toBe("A Disable of replication did not finish, so the join login and the machines' logins may already be closed: press Disable replication to finish it");
  });
});

describe('NM22 New join code (O4 E16 to E29; R1, R18, R25)', () => {
  const renewCall = () => lane.calls.find(c => c.stdin.includes("SELECT 'renewed'"))!;

  it('E16 the own password saved first, both ALTERs and both resets in one transaction, then the cleanup, the row and the join password', async () => {
    const r = await renewJoinCode(bot());
    expect(r).toEqual({ success: true, text: "Made a new join code and gave this machine's own login a new password. The old code no longer adds machines; machines that joined before keep their logins." });
    expect(h.loginWrites).toHaveLength(1);
    expect(h.loginWrites[0].at).toBe(0);
    const own = bot().fleetLogin!.password;
    const join = bot().fleetDb!.replication!.password;
    expect(own).not.toBe(OWN_PW);
    expect(join).not.toBe(JOIN_PW);
    const call = renewCall();
    expect(call.args).toContain('-i m-fleet-postgres psql -X -U dbm_admin -d postgres');
    const s = call.stdin;
    expect(s.startsWith(`${QUIET_ROLE_SESSION_SQL}BEGIN;\nSET LOCAL lock_timeout = '5s';\nSELECT 'closed|' || pg_catalog.count(*) FILTER (WHERE pg_catalog.pg_terminate_backend(a.pid, 5000)) FROM pg_catalog.pg_stat_activity a WHERE a.usename IN ('smdb_join', '${OWN}') AND a.pid <> pg_catalog.pg_backend_pid();\nALTER ROLE smdb_join LOGIN PASSWORD '`)).toBe(true);
    expect(await verifierAccepts(verifierAfter(s, 'ALTER ROLE smdb_join LOGIN PASSWORD'), join, 'smdb_join')).toBe(true);
    expect(await verifierAccepts(verifierAfter(s, `ALTER ROLE "${OWN}" LOGIN PASSWORD`), own, OWN)).toBe(true);
    const commit = s.indexOf('COMMIT;');
    expect(s.indexOf(ROLE_SETTINGS_RESET_SQL('smdb_join'))).toBeLessThan(commit);
    expect(s.indexOf(ROLE_SETTINGS_RESET_SQL(OWN))).toBeLessThan(commit);
    expect(s.slice(commit)).toBe(`COMMIT;
SELECT 'renewed';
SELECT 'ended|' || pg_catalog.count(pg_catalog.pg_terminate_backend(a.pid, 5000)) FROM pg_catalog.pg_stat_activity a WHERE a.usename IN ('smdb_join', '${OWN}') AND a.pid <> pg_catalog.pg_backend_pid();
SELECT 'unlinked|' || pg_catalog.count(pg_catalog.lo_unlink(l.oid)) FROM pg_catalog.pg_largeobject_metadata l;
DO $$ BEGIN
  PERFORM pg_catalog.pg_drop_replication_slot(slot_name) FROM pg_catalog.pg_replication_slots WHERE slot_name = '${OWN_SLOT}' AND NOT active;
EXCEPTION WHEN object_in_use THEN NULL;
END $$;
`);
    for (const secret of [own, join, OWN_PW, JOIN_PW]) expect(s).not.toContain(secret);
    const row = lane.calls.find(c => c.args.includes(`DELETE FROM smdb_manager.addresses WHERE slot = '${OWN_SLOT}';`))!;
    expect(row.args).toContain('-U dbm_meta -d smdb');
    expect(lane.calls.indexOf(row)).toBeGreaterThan(lane.calls.indexOf(call));
  });

  it('E17 the transaction fails: the own password is written back, RENEW-FAIL, the join password kept', async () => {
    lane.rules.push({ match: "SELECT 'renewed'", code: 3, out: 'SET\nSET\nSET\nBEGIN\n', err: `psql:<stdin>:6: ERROR:  role "${OWN}" does not exist\n` });
    expect(await renewJoinCode(bot())).toEqual({ success: false, error: `The join code was not renewed (role "${OWN}" does not exist); the current code still works, and nothing was changed.` });
    expect(bot().fleetLogin!.password).toBe(OWN_PW);
    expect(bot().fleetDb!.replication!.password).toBe(JOIN_PW);
    expect(h.loginWrites.map(w => w.login)).toEqual([expect.objectContaining({ password: expect.any(String) }), { password: OWN_PW }]);
  });

  it('E17 the own password save fails: RENEW-FAIL before any call', async () => {
    h.loginFails = ['the registry is read-only'];
    expect(await renewJoinCode(bot())).toEqual({ success: false, error: 'The join code was not renewed (the registry is read-only); the current code still works, and nothing was changed.' });
    expect(lane.calls.some(c => c.stdin.includes("SELECT 'renewed'"))).toBe(false);
  });

  it('E18 the join password save fails after the commit: RENEW-UNSAVED', async () => {
    h.replFails = ['disk full'];
    expect(await renewJoinCode(bot())).toEqual({ success: false, error: 'The old join code no longer adds machines, but the new password could not be saved (disk full), so no code can be shown for it; press New join code again.' });
  });

  it('E19 and E20 a second press makes new passwords that the record and the database agree on', async () => {
    expect((await renewJoinCode(bot())).success).toBe(true);
    const first = bot().fleetDb!.replication!.password;
    lane.calls = [];
    expect((await renewJoinCode(bot())).success).toBe(true);
    const join = bot().fleetDb!.replication!.password;
    expect(join).not.toBe(first);
    expect(await verifierAccepts(verifierAfter(renewCall().stdin, 'ALTER ROLE smdb_join LOGIN PASSWORD'), join, 'smdb_join')).toBe(true);
    expect(await verifierAccepts(verifierAfter(renewCall().stdin, `ALTER ROLE "${OWN}" LOGIN PASSWORD`), bot().fleetLogin!.password, OWN)).toBe(true);
  });

  it.each([
    ['replacedBy', { replacedBy: switchRecord }],
    ['mainConflict', { mainConflict: switchRecord }],
    ['formerMain', { formerMain: { ...switchRecord, code: 'x', slot: OWN_SLOT } }],
    ['handover with mode stream (R48)', { handover: { mode: 'stream', phase: 'stopped', machine: 'copy.invalid', host: 'copy.invalid', port: 15433, generation: 4, at: '2026-11-01T00:00:00.000Z' } }],
  ])('E22 %s on the record: only the join login is renewed, RENEW-DONE-KEPT names that machine', async (_name, extra) => {
    writeRegistry({ ...fleetDb, replication, ...extra });
    expect(await renewJoinCode(bot())).toEqual({ success: true, text: "Made a new join code. The old code no longer adds machines; machines that joined before keep their logins. This machine's own login kept its password, because the database on copy.invalid still holds it for this machine." });
    const s = renewCall().stdin;
    expect(s).not.toContain(OWN);
    expect(s).toContain("a.usename IN ('smdb_join') AND");
    expect(s).not.toContain('DO $$ BEGIN\n  PERFORM');
    expect(h.loginWrites).toHaveLength(0);
    expect(bot().fleetLogin!.password).toBe(OWN_PW);
    expect(lane.calls.some(c => c.args.includes('DELETE FROM smdb_manager.addresses'))).toBe(false);
  });

  it('E23 the transaction fails and the write-back fails: RENEW-FAIL-OWN', async () => {
    h.loginFails = ['', 'the registry is read-only'];
    lane.rules.push({ match: "SELECT 'renewed'", code: 3, out: 'SET\nSET\nSET\nBEGIN\n', err: 'psql:<stdin>:5: ERROR:  canceling statement due to lock timeout\n' });
    expect(await renewJoinCode(bot())).toEqual({ success: false, error: "The join code was not renewed (canceling statement due to lock timeout), and the manager could not put back this machine's own password on record (the registry is read-only), so this machine's own login does not open with it now; press New join code again." });
  });

  it('code review 1 finding 1: only the join login\'s sessions are ended in the transaction when the own login keeps its password', async () => {
    writeRegistry({ ...fleetDb, replication, replacedBy: switchRecord });
    expect((await renewJoinCode(bot())).success).toBe(true);
    expect(renewCall().stdin).toContain(`BEGIN;\nSET LOCAL lock_timeout = '5s';\nSELECT 'closed|' || pg_catalog.count(*) FILTER (WHERE pg_catalog.pg_terminate_backend(a.pid, 5000)) FROM pg_catalog.pg_stat_activity a WHERE a.usename IN ('smdb_join') AND a.pid <> pg_catalog.pg_backend_pid();\nALTER ROLE smdb_join LOGIN PASSWORD '`);
  });

  it('code review 2 finding 1: the transaction stops on the lock limit after ending sessions: the text says how many were ended', async () => {
    lane.rules.push({ match: "SELECT 'renewed'", code: 3, out: 'SET\nSET\nSET\nBEGIN\nSET\nclosed|2\n', err: 'psql:<stdin>:7: ERROR:  canceling statement due to lock timeout\n', once: true });
    expect(await renewJoinCode(bot())).toEqual({ success: false, error: `The join code was not renewed (canceling statement due to lock timeout); the current code still works. The 2 open sessions of smdb_join and ${OWN} were ended; nothing else was changed.` });
    expect(bot().fleetLogin!.password).toBe(OWN_PW);
    lane.rules.push({ match: "SELECT 'renewed'", code: 3, out: 'SET\nSET\nSET\nBEGIN\nSET\nclosed|1\n', err: 'psql:<stdin>:7: ERROR:  canceling statement due to lock timeout\n' });
    expect(await renewJoinCode(bot())).toEqual({ success: false, error: `The join code was not renewed (canceling statement due to lock timeout); the current code still works. One open session of smdb_join or ${OWN} was ended; nothing else was changed.` });
  });

  it('code review 1 finding 1: the call ends on its own time limit: RENEW-UNCONFIRMED, never "nothing was changed"; no join password saved', async () => {
    lane.rules.push({ match: "SELECT 'renewed'", hang: true });
    vi.useFakeTimers();
    try {
      const pending = renewJoinCode(bot());
      await vi.advanceTimersByTimeAsync(31_000);
      expect(await pending).toEqual({ success: false, error: "The manager can't confirm whether the join code was renewed: the database did not answer within 30 s, and the change may still be applied there. Press New join code again." });
    } finally {
      vi.useRealTimers();
    }
    expect(bot().fleetDb!.replication!.password).toBe(JOIN_PW);
  });

  it('E24 renewed, then the session end fails: the renewal stands with RENEW-NOTE', async () => {
    lane.rules.push({ match: "SELECT 'renewed'", code: 3, out: 'SET\nSET\nSET\nBEGIN\nALTER ROLE\ncommitting\nCOMMIT\nrenewed\n', err: 'psql:<stdin>:12: ERROR:  out of memory\n' });
    const r = await renewJoinCode(bot());
    expect(r).toEqual({ success: true, text: "Made a new join code and gave this machine's own login a new password. The old code no longer adds machines; machines that joined before keep their logins. The renewal stands, but ending the old sessions failed (out of memory)." });
    expect(bot().fleetDb!.replication!.password).not.toBe(JOIN_PW);
  });

  it('E24 renewed, then the large objects fail, and the row delete fails', async () => {
    lane.rules.push({ match: "SELECT 'renewed'", code: 3, out: 'committing\nCOMMIT\nrenewed\nended|1\n', err: 'psql:<stdin>:13: ERROR:  large object 16400 does not exist\n' });
    lane.rules.push({ match: 'DELETE FROM smdb_manager.addresses WHERE slot', code: 1, err: 'ERROR:  relation "smdb_manager.addresses" does not exist\n' });
    expect((await renewJoinCode(bot())).text).toBe("Made a new join code and gave this machine's own login a new password. The old code no longer adds machines; machines that joined before keep their logins. The renewal stands, but removing large objects from the postgres database failed (large object 16400 does not exist). The renewal stands, but removing a slot or address of this machine's own login failed (relation \"smdb_manager.addresses\" does not exist).");
  });

  it('E29 the join password no longer decrypts: New join code makes and saves a new one', async () => {
    writeRegistry({ ...fleetDb, replication: { ...replication, password: '' } });
    expect((await renewJoinCode(bot())).success).toBe(true);
    expect(bot().fleetDb!.replication!.password).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it('refuses like the join code: no replication, an unfinished Disable, a database that is down', async () => {
    writeRegistry({ ...fleetDb });
    expect((await renewJoinCode(bot())).error).toBe('Replication is not enabled, so there is no join code.');
    writeRegistry({ ...fleetDb, replication: { ...replication, disablingSince: '2026-11-01T00:00:00.000Z' } });
    expect((await renewJoinCode(bot())).error).toBe("A Disable of replication did not finish, so the join login and the machines' logins may already be closed: press Disable replication to finish it");
    writeRegistry();
    lane.running = 'false';
    expect((await renewJoinCode(bot())).error).toBe('The database container is not running, so the join code was not renewed');
    expect(h.loginWrites).toHaveLength(0);
  });
});

describe('NM22 the status read lists the machine logins (3.11, R4)', () => {
  it('maps each login to its line state, its row and this machine\'s own', async () => {
    lane.logins = JSON.stringify([
      { login: OWN, member: true, canLogin: true, slot: null, active: null, walStatus: null, client: null },
      { login: OTHER, member: true, canLogin: true, slot: 'fleet_standby_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', active: true, walStatus: 'reserved', client: '10.0.0.7' },
      { login: 'smdb_copy_cccccccccccccccccccccccccccccccc', member: false, canLogin: false, slot: 'fleet_standby_cccccccccccccccccccccccccccccccc', active: false, walStatus: 'lost', client: null },
      { login: 'smdb_copy_dddddddddddddddddddddddddddddddd', member: true, canLogin: false, slot: 'fleet_standby_dddddddddddddddddddddddddddddddd', active: false, walStatus: 'reserved', client: null },
    ]);
    lane.addresses = JSON.stringify([{ slot: 'fleet_standby_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', machine: 'copy-b', host: 'b.invalid', port: 15433 }]);
    const s = await getFleetReplicationStatus(bot(), { probeEndpoint: false });
    expect(s.live!.logins).toEqual([
      { login: OWN, own: true, member: true, canLogin: true, slot: null, slotState: 'absent', machine: null, address: null, client: null },
      { login: OTHER, own: false, member: true, canLogin: true, slot: 'fleet_standby_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', slotState: 'active', machine: 'copy-b', address: 'b.invalid:15433', client: '10.0.0.7' },
      { login: 'smdb_copy_cccccccccccccccccccccccccccccccc', own: false, member: false, canLogin: false, slot: 'fleet_standby_cccccccccccccccccccccccccccccccc', slotState: 'lost', machine: null, address: null, client: null },
      { login: 'smdb_copy_dddddddddddddddddddddddddddddddd', own: false, member: true, canLogin: false, slot: 'fleet_standby_dddddddddddddddddddddddddddddddd', slotState: 'kept', machine: null, address: null, client: null },
    ]);
    expect(sqlTexts().some(t => t.includes("'member', EXISTS") && t.includes('-U dbm_admin -d postgres'))).toBe(true);
  });

  it('a failed or unreadable logins read leaves the list out', async () => {
    lane.rules.push({ match: "'member', EXISTS", code: 1, err: 'ERROR:  x\n', once: true });
    expect((await getFleetReplicationStatus(bot(), { probeEndpoint: false })).live!.logins).toBeUndefined();
    lane.logins = '[{"login":"replicator"}]';
    expect((await getFleetReplicationStatus(bot(), { probeEndpoint: false })).live!.logins).toBeUndefined();
  });
});

describe('NM22 restore readers (R2, C4, 3.10): B1, B3, B8', () => {
  const DATA = '3401; 1259 16500 TABLE smdb_data guild_state botrole';
  it('B8: restoreLists leaves out the large-object entries in run 5\'s forms; refused stays null', () => {
    const toc = [
      `3451; 2613 16430 BLOB - 16430 smdb_copy_ffffffffffffffffffffffffffffffff`,
      '3452; 0 0 BLOBS - BLOBS ',
      '3453; 0 0 ACL - LARGE OBJECT 16430 smdb_copy_ffffffffffffffffffffffffffffffff',
      '3454; 0 0 COMMENT - LARGE OBJECT 16430 smdb_copy_ffffffffffffffffffffffffffffffff',
      '3455; 0 0 BLOB METADATA - 16430 smdb_copy_ffffffffffffffffffffffffffffffff',
      DATA,
    ].join('\n');
    expect(fleetBackup.restoreLists(toc, '')).toEqual({ other: DATA, refused: null });
  });
  it('B3, C4: the functions\' entries and the schema ACL are left out, verbatim from the claims run', () => {
    const functions = [
      '228; 1255 16406 FUNCTION smdb_manager set_copy_address(text, integer, text, text) dbm_meta',
      '229; 1255 16407 FUNCTION smdb_manager drop_copy_address() dbm_meta',
      '3459; 0 0 ACL smdb_manager FUNCTION set_copy_address(p_host text, p_port integer, p_cert text, p_machine text) dbm_meta',
      '3460; 0 0 ACL smdb_manager FUNCTION drop_copy_address() dbm_meta',
    ];
    const toc = [...functions, '3457; 0 0 ACL - SCHEMA smdb_manager dbm_meta', DATA].join('\n');
    expect(fleetBackup.restoreLists(toc, functions.join('\n'))).toEqual({ other: DATA, refused: null });
  });
  it('a table whose name starts with BLOB is not a large object', () => {
    const toc = ['3401; 1259 16501 TABLE smdb_data BLOBS_x botrole', '3402; 1259 16502 TABLE smdb_data blob botrole'].join('\n');
    expect(fleetBackup.restoreLists(toc, '')).toEqual({ other: toc, refused: null });
  });
  it('B1: the restore\'s meta transaction makes the address table and both functions from ADDRESS_DDL_SQL', () => {
    expect(fleetBackup.metaTransactionSql('')).toContain(ADDRESS_DDL_SQL);
  });
});
