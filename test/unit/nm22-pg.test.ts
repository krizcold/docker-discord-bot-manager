import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// NM22 parts 4 and 5 against a real Postgres 16 (section 9's PG1 to PG14; PG15 and PG16 from code review 1). Skipped on Windows and
// without docker; the main session runs it on Linux.
const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm22-pg-'));
  // HOST_DATA_DIR stays unset, so the host path a probe mounts is this process's own path.
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  type Call = { login: string; args: string[]; input?: string };
  type Result = { ok: boolean; stdout: string; stderr: string; error?: string };
  return {
    dir,
    // A row's look at the module's psql calls: `pass` runs the call as given, `run` runs another call in its place.
    onCall: null as null | ((call: Call, pass: () => Promise<Result>, run: (c: Call) => Promise<Result>) => Promise<Result>),
  };
});

vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/instance/dbLogin', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/instance/dbLogin')>();
  return {
    ...real,
    runCall: (container: string, call: Parameters<typeof real.runCall>[1], timeoutMs?: number) => {
      const run = (c: typeof call) => real.runCall(container, c, timeoutMs);
      return h.onCall ? h.onCall(call, () => run(call), c => run(c as typeof call)) as ReturnType<typeof real.runCall> : run(call);
    },
  };
});

import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { certFingerprint, decodeJoinCode, sqlLiteral } from '../../src/config/joinCode';
import * as containerManager from '../../src/docker/containerManager';
import { clusterPsql, runCall } from '../../src/instance/dbLogin';
import {
  DROP_ADDRESS_SQL, addressTakenText, addressUpsertSql, ensureCopyLogin, joinBlockedText, mainProbe, parseAddressTaken, primarySql,
  readAddresses, registerAddress,
} from '../../src/instance/fleetJoin';
import { getJoinCode, pgHbaContent, removeCopyLogin, renewJoinCode } from '../../src/instance/fleetReplication';
import { scramSha256Verifier } from '../../src/config/secretText';
import { fenceHbaScript, metaTransactionSql, restoreLists, runFleetDump } from '../../src/instance/fleetBackup';
import { machineLoginsCheck, ownPeersSql } from '../../src/instance/fleetSwitch';
import { COPY_ROLES_READ_SQL, DISABLE_CLOSE_SQL, JOIN_LOGIN, REMOVE_BLOCK_SQL, copyGroupEnsureSql, copyLogin, copySlot } from '../../src/instance/switchSql';
import { InstanceConfig } from '../../src/types';
import { enableAddressStep, enableRoleStep } from './nm22-enable';
import { type Cluster, docker, dockerRuns, provisionedCluster } from './pg-cluster';

// Every container and volume is removed by its exact name; the module's own client containers are named after each
// instance's sanitizedName, so every name starts with nm22-pg-.
const MAIN = 'nm22-pg-main';
const FRESH = 'nm22-pg-fresh';
const COPY = 'nm22-pg-copy';
const COPY_SEED = 'nm22-pg-copy-seed';
const COPY_VOL = 'nm22-pg-copy-data';
const U = 'app';
const APP_PW = 'nm22-pg-app-password';
const JOIN_PW = 'nm22-pg-join-password';
const PORT = 40000 + (process.pid % 20000);
const HBA = '/var/lib/postgresql/data/pg_hba.conf';
const uid = (c: string) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const MAIN_ID = uid('e');
const MAIN_OWN_PW = 'nm22-pg-own-main';
const COPIES: Record<string, string> = { a: uid('a'), b: uid('b'), c: uid('c'), d: uid('d'), f: uid('f') };
const A = copyLogin(COPIES.a);
const B = copyLogin(COPIES.b);
const C = copyLogin(COPIES.c);
const D = copyLogin(COPIES.d);
const P = copyLogin(COPIES.f);
const CLIENT_SUFFIXES = ['fleet-join-probe', 'fleet-join-login', 'fleet-join-list', 'fleet-join-register', 'fleet-join-unregister', 'fleet-join-sql'];
const OFF = { state: 'off', message: '', orderedAt: '2026-11-15T00:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: 'maintenance' };

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const ok = (r: { status: number | null; out: string; err: string }) => {
  expect(r.status, r.err).toBe(0);
  return r.out;
};
const callText = (call: { args: string[]; input?: string }) => [...call.args, call.input ?? ''].join('\n');
const endSessionsText = (login: string) => `pg_catalog.count(pg_catalog.pg_terminate_backend(pid, 5000)) FROM pg_catalog.pg_stat_activity WHERE usename = '${login}'`;
const doneText = (login: string) => `Removed the login ${login}: its sessions were ended, its slot dropped, its address taken off the list and what it owned dropped. A machine that holds this database's join code can join again; New join code stops that.`;

/** A session of `login` over the container's socket, held open; `send` runs SQL in it and waits for the mark line. */
function heldSession(login: string, db: string) {
  const child = spawn('docker', ['exec', '-i', MAIN, 'psql', '-X', '-U', login, '-d', db, '-tA'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout!.on('data', d => { out += d; });
  child.stderr!.on('data', d => { out += d; });
  const send = (sql: string, mark: string) => new Promise<void>((resolve, reject) => {
    const start = Date.now();
    child.stdin!.write(`${sql}SELECT '${mark}';\n`);
    const tick = () => {
      if (out.split('\n').some(l => l.trim() === mark)) return resolve();
      if (Date.now() - start > 30000) return reject(new Error(`the session of ${login} did not print ${mark}: ${out}`));
      setTimeout(tick, 100);
    };
    tick();
  });
  const close = () => {
    try { child.stdin!.end(); } catch { /* closed */ }
    try { child.kill('SIGKILL'); } catch { /* gone */ }
  };
  return { send, output: () => out, close };
}

describe.skipIf(process.platform === 'win32' || !dockerRuns)('NM22 the machine logins against a real Postgres 16 (Linux with docker)', () => {
  let main: Cluster;
  let gateway = '';
  let pem = '';
  const admin = (sql: string, db = 'postgres') => ok(main.psql('dbm_admin', sql, db));
  const bot = (id: string): InstanceConfig => containerManager.getBot(id)!;
  const code = () => ({
    v: 1 as const, host: gateway, port: PORT, db: U, fp: certFingerprint(pem), machine: 'main',
    repl: { user: JOIN_LOGIN, password: JOIN_PW }, app: { user: U, password: APP_PW },
  });
  const copyRoles = async () => {
    const r = await runCall(MAIN, clusterPsql(MAIN, COPY_ROLES_READ_SQL));
    expect(r.ok, r.stderr).toBe(true);
    return r.stdout.trim();
  };
  const roleStep = async () => {
    const r = await enableRoleStep(MAIN, { joinPassword: JOIN_PW, ownId: MAIN_ID, ownPassword: MAIN_OWN_PW });
    expect(r.ok, r.stderr).toBe(true);
  };
  const writeHba = (content: string) => {
    ok(docker(['exec', '-i', MAIN, 'sh', '-c', `cat > ${HBA}.new && chown postgres:postgres ${HBA}.new && chmod 600 ${HBA}.new && mv -f ${HBA}.new ${HBA}`], content));
    admin('SELECT pg_reload_conf();');
    pause(1000);
  };
  const roleAttrs = (name: string) => admin(`SELECT rolcanlogin || '|' || rolsuper || '|' || rolcreatedb || '|' || rolcreaterole || '|' || rolreplication || '|' || rolbypassrls FROM pg_roles WHERE rolname = '${name}';`);
  const memberships = (name: string) => admin(`SELECT pg_get_userbyid(roleid) || '|' || admin_option || '|' || inherit_option || '|' || set_option || '|' || pg_get_userbyid(grantor) FROM pg_auth_members WHERE member = '${name}'::regrole ORDER BY 1;`);
  // Member of smdb_copies, LOGIN, no password and no setting (pg_authid).
  const blockState = (login: string) => admin(`SELECT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid AND m.roleid = 'smdb_copies'::regrole) || '|' || r.rolcanlogin || '|' || (r.rolpassword IS NULL AND NOT EXISTS (SELECT 1 FROM pg_db_role_setting s WHERE s.setrole = r.oid)) FROM pg_authid r WHERE r.rolname = '${login}';`);
  const fnAcl = (fn: string, db: string, run: (sql: string, db: string) => string = admin) => run(`SELECT pg_get_userbyid(p.proowner) || '|' || p.prosecdef || '|' || array_to_string(p.proconfig, ';') || '|' || (SELECT string_agg(pg_get_userbyid(a.grantee) || ':' || a.privilege_type, ',' ORDER BY pg_get_userbyid(a.grantee) COLLATE "C", a.privilege_type) FROM aclexplode(p.proacl) a) FROM pg_proc p WHERE p.oid = '${fn}'::regprocedure;`, db);
  const addressRows = () => admin("SELECT host || '|' || port || '|' || coalesce(slot, '') || '|' || machine FROM smdb_manager.addresses ORDER BY 1;", U).split('\n').filter(Boolean);
  const asLogin = (login: string, password: string, args: string[], container = MAIN) => {
    const r = spawnSync('docker', ['exec', '-e', 'PGPASSWORD', container, ...args], { encoding: 'utf-8', timeout: 120000, env: { ...process.env, PGPASSWORD: password } });
    return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
  };
  const ownPassword = (letter: string) => `nm22-pg-own-${letter}`;
  const replConn = (login: string) => `host=127.0.0.1 port=5432 user=${login} sslmode=require`;

  beforeAll(async () => {
    gateway = docker(['network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}']).out;
    expect(gateway).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    const certFile = path.join(h.dir, 'server.crt');
    const keyFile = path.join(h.dir, 'server.key');
    const gen = spawnSync('openssl', ['req', '-new', '-x509', '-days', '30', '-nodes', '-newkey', 'rsa:2048', '-subj', `/CN=${MAIN}`,
      '-addext', `subjectAltName=DNS:${MAIN},IP:${gateway}`, '-keyout', keyFile, '-out', certFile], { encoding: 'utf-8' });
    expect(gen.status, gen.stderr).toBe(0);
    pem = fs.readFileSync(certFile, 'utf-8');
    // Docker Desktop cannot bind a published port on the bridge gateway; all interfaces still reach it there.
    const publish = process.env.SMDB_PG_PUBLISH === 'all' ? `${PORT}:5432` : `${gateway}:${PORT}:5432`;
    main = await provisionedCluster({ name: MAIN, user: U, db: U, password: APP_PW, dockerArgs: ['-p', publish] });
    for (const f of ['server.crt', 'server.key']) ok(docker(['cp', path.join(h.dir, f), `${MAIN}:/var/lib/postgresql/data/${f}`]));
    ok(docker(['exec', '-u', 'root', MAIN, 'sh', '-c', 'chown postgres:postgres /var/lib/postgresql/data/server.* && chmod 600 /var/lib/postgresql/data/server.key']));
    admin('ALTER SYSTEM SET ssl = on;');
    await roleStep();
    writeHba(pgHbaContent(U));
    const addresses = await enableAddressStep(MAIN, U, gateway, PORT, pem.trim(), 'main');
    expect(addresses.ok, addresses.stderr).toBe(true);
    const copy = (letter: string) => ({
      id: COPIES[letter], sanitizedName: `nm22-pg-${letter}`, displayName: `NM22 ${letter}`, titleName: `NM22 ${letter}`, status: 'stopped',
      sourceType: 'git', sourceUrl: 'https://example.invalid/fake/super-modular-discord-bot', envVars: {},
      createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:00.000Z', fleetLogin: { password: ownPassword(letter) },
    });
    const instances: Record<string, unknown> = {
      [MAIN_ID]: {
        id: MAIN_ID, sanitizedName: 'nm22-pg-m', displayName: 'NM22 main', titleName: 'NM22 main', status: 'stopped', sourceType: 'git',
        sourceUrl: 'https://example.invalid/fake/super-modular-discord-bot', envVars: {}, createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:00.000Z',
        fleetDb: {
          containerName: MAIN, user: U, db: U, volume: `${MAIN}-data`, password: APP_PW, image: 'postgres:16-alpine',
          replication: { role: JOIN_LOGIN, password: JOIN_PW, hostPort: PORT, publicHost: gateway, certHost: gateway, slotWalKeepMb: 64 },
        },
        fleetLogin: { password: MAIN_OWN_PW }, fleetBackup: { enabled: false, hour: 4, keep: 7 }, maintenance: OFF,
      },
    };
    for (const letter of Object.keys(COPIES)) instances[COPIES[letter]] = copy(letter);
    fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances }, null, 2));
  }, 600000);

  afterAll(() => {
    h.onCall = null;
    for (const letter of Object.keys(COPIES)) for (const s of CLIENT_SUFFIXES) docker(['rm', '-f', `nm22-pg-${letter}-${s}`]);
    for (const c of [COPY_SEED, COPY, FRESH, MAIN]) docker(['rm', '-f', '-v', c]);
    for (const v of [COPY_VOL, `${FRESH}-data`, `${MAIN}-data`]) docker(['volume', 'rm', '-f', v]);
    fs.rmSync(h.dir, { recursive: true, force: true });
  }, 300000);

  it('PG1 (Invariant L): after Enable\'s role and address steps every field reads back, the read answers ok, and each planted finding gives its key', async () => {
    const own = copyLogin(MAIN_ID);
    expect(roleAttrs(JOIN_LOGIN)).toBe('true|false|false|false|false|false');
    expect(memberships(JOIN_LOGIN)).toBe('');
    expect(roleAttrs('smdb_copies')).toBe('false|false|false|false|false|false');
    expect(memberships('smdb_copies')).toBe('');
    expect(roleAttrs('smdb_minter')).toBe('false|false|false|true|true|false');
    expect(memberships('smdb_minter')).toBe('smdb_copies|true|false|false|dbm_admin');
    expect(roleAttrs(own)).toBe('true|false|false|false|true|false');
    expect(memberships(own)).toBe('smdb_copies|false|true|true|dbm_admin');
    expect(admin("SELECT count(*) FROM pg_roles WHERE rolname LIKE 'smdb\\_copy\\_%' AND rolname !~ '^smdb_copy_[0-9a-f]{32}$';")).toBe('0');
    expect(fnAcl('smdb_manager.add_copy_login(text, text)', 'postgres')).toBe('smdb_minter|true|search_path=pg_catalog, pg_temp|smdb_join:EXECUTE,smdb_minter:EXECUTE');
    expect(fnAcl('smdb_manager.set_copy_address(text, integer, text, text)', U)).toBe('dbm_meta|true|search_path=pg_catalog, pg_temp|dbm_meta:EXECUTE,smdb_copies:EXECUTE');
    expect(fnAcl('smdb_manager.drop_copy_address()', U)).toBe('dbm_meta|true|search_path=pg_catalog, pg_temp|dbm_meta:EXECUTE,smdb_copies:EXECUTE');
    expect(admin("SELECT string_agg(a.privilege_type, ',') FROM pg_namespace n, aclexplode(n.nspacl) a WHERE n.nspname = 'smdb_manager' AND a.grantee = 'smdb_copies'::regrole;", U)).toBe('USAGE');
    expect(admin("SELECT string_agg(c.relname || ':' || a.privilege_type, ',') FROM pg_class c, aclexplode(c.relacl) a WHERE c.relnamespace = 'smdb_manager'::regnamespace AND a.grantee = 'smdb_copies'::regrole;", U)).toBe('addresses:SELECT');
    expect(await copyRoles()).toBe('copyroles|ok');

    const plants: Array<[string, string]> = [
      ['ALTER ROLE smdb_join REPLICATION;', 'join-rights'],
      ['GRANT EXECUTE ON FUNCTION smdb_manager.add_copy_login(text, text) TO PUBLIC;', 'function-acl'],
      ['CREATE ROLE x NOLOGIN;\nGRANT smdb_copies TO x;', 'group-member'],
    ];
    for (const [plant, key] of plants) {
      admin(plant);
      expect(await copyRoles()).toBe(`copyroles|${key}`);
      await roleStep();
      expect(await copyRoles()).toBe('copyroles|ok');
    }
    expect(admin("SELECT count(*) FROM pg_auth_members WHERE member = 'x'::regrole;")).toBe('0');
    admin('DROP ROLE x;');
  }, 600000);

  it('PG9 (E21, G1, G2): stray memberships, a right on a machine login and a passed-on EXECUTE are read, and one role step clears them all', async () => {
    const minted = await ensureCopyLogin(bot(COPIES.f), code(), pem);
    expect(minted, JSON.stringify(minted)).toMatchObject({ ok: true, minted: { kind: 'created' } });
    admin(`SET ROLE smdb_minter;
GRANT smdb_copies TO ${U};
GRANT smdb_copies TO ${P} WITH ADMIN TRUE;
RESET ROLE;
GRANT dbm_work TO ${P};
ALTER ROLE ${P} CREATEDB;
GRANT USAGE ON SCHEMA smdb_manager TO dbm_work;
GRANT EXECUTE ON FUNCTION smdb_manager.add_copy_login(text, text) TO dbm_work WITH GRANT OPTION;
SET ROLE dbm_work;
GRANT EXECUTE ON FUNCTION smdb_manager.add_copy_login(text, text) TO ${U};
RESET ROLE;`);
    expect(await copyRoles()).toBe('copyroles|login-rights,login-member,login-admin,group-member,function-acl');
    await roleStep();
    expect(await copyRoles()).toBe('copyroles|ok');
    expect(admin(`SELECT count(*) FROM pg_auth_members WHERE roleid = 'smdb_copies'::regrole AND member = '${U}'::regrole;`)).toBe('0');
    expect(admin(`SELECT count(*) FROM pg_auth_members WHERE roleid = 'smdb_copies'::regrole AND member = '${P}'::regrole AND admin_option;`)).toBe('0');
    expect(admin(`SELECT count(*) FROM pg_auth_members WHERE roleid = 'dbm_work'::regrole AND member = '${P}'::regrole;`)).toBe('0');
    expect(memberships(P)).toBe('smdb_copies|false|true|true|smdb_minter');
    expect(roleAttrs(P)).toBe('true|false|false|false|true|false');
    expect(admin("SELECT proacl::text FROM pg_proc WHERE oid = 'smdb_manager.add_copy_login(text, text)'::regprocedure;")).toBe('{smdb_minter=X/smdb_minter,smdb_join=X/smdb_minter}');
    // The schema grant was the plant's way in; the role step does not read it.
    admin('REVOKE USAGE ON SCHEMA smdb_manager FROM dbm_work;');
  }, 600000);

  it('PG14 (L25, E27, E31): the join login\'s own settings do not stop a mint, the code comes with JC-SETTINGS, Enable clears them, and Remove blocks a login that set its role', async () => {
    ok(main.psql(JOIN_LOGIN, "ALTER ROLE CURRENT_USER SET default_transaction_read_only = on;\nALTER ROLE CURRENT_USER IN DATABASE postgres SET statement_timeout = 1;\n", 'postgres'));
    expect(admin("SELECT count(*) FROM pg_db_role_setting WHERE setrole = 'smdb_join'::regrole;")).toBe('2');
    const minted = await ensureCopyLogin(bot(COPIES.d), code(), pem);
    expect(minted, JSON.stringify(minted)).toMatchObject({ ok: true, minted: { kind: 'created' } });
    expect(await copyRoles()).toBe('copyroles|role-settings');
    const given = await getJoinCode(bot(MAIN_ID));
    expect(given).toMatchObject({ success: true, note: "Some logins carry session settings of their own, which the manager's sessions override: smdb_join (press New join code)." });
    const decoded = decodeJoinCode(given.joinCode ?? '');
    expect(decoded.ok && decoded.code.repl).toEqual({ user: JOIN_LOGIN, password: JOIN_PW });
    await roleStep();
    expect(await copyRoles()).toBe('copyroles|ok');
    expect(admin("SELECT count(*) FROM pg_db_role_setting WHERE setrole = 'smdb_join'::regrole;")).toBe('0');

    const lo = ok(main.psql(D, "SELECT lo_from_bytea(0, '\\x00'::bytea);", U));
    expect(lo).toMatch(/^\d+$/);
    ok(main.psql(D, "ALTER ROLE CURRENT_USER SET role = 'smdb_copies';", 'postgres'));
    expect(admin(`SELECT count(*) FROM pg_db_role_setting WHERE setrole = '${D}'::regrole;`)).toBe('1');
    let afterBlock = '';
    h.onCall = (call, pass) => {
      if (callText(call).includes(endSessionsText(D))) afterBlock = blockState(D);
      return pass();
    };
    try {
      expect(await removeCopyLogin(bot(MAIN_ID), D, false)).toEqual({ success: true, text: doneText(D) });
    } finally {
      h.onCall = null;
    }
    expect(afterBlock).toBe('false|false|true');
    expect(admin(`SELECT count(*) FROM pg_largeobject_metadata WHERE oid = ${lo};`, U)).toBe('0');
    expect(admin(`SELECT count(*) FROM pg_roles WHERE rolname = '${D}';`)).toBe('0');
  }, 600000);

  it('PG2 (Invariant R, R1 to R8): two minted logins log in over TLS with their passwords and write only their own rows', async () => {
    for (const letter of ['a', 'b']) {
      const minted = await ensureCopyLogin(bot(COPIES[letter]), code(), pem);
      expect(minted, JSON.stringify(minted)).toMatchObject({ ok: true, minted: { kind: 'created' } });
      expect(await mainProbe(bot(COPIES[letter]), code(), pem)).toMatchObject({ ok: true, facts: { inRecovery: false, timeline: 1, slot: 'absent' } });
    }
    const cert = pem.trim();
    const mainRow = `${gateway}|${PORT}||main`;
    const rowA = `a.example|15432|${copySlot(COPIES.a)}|machine a`;
    // R1
    expect(await registerAddress(bot(COPIES.a), code(), pem, { host: 'a.example', port: 15432, cert, machine: 'machine a' })).toBeNull();
    expect(addressRows()).toEqual([mainRow, rowA]);
    // R2, R3
    expect(await registerAddress(bot(COPIES.b), code(), pem, { host: 'a.example', port: 15432, cert, machine: 'machine b' }))
      .toBe(addressTakenText({ host: 'a.example', port: 15432, holder: A }));
    expect(await registerAddress(bot(COPIES.b), code(), pem, { host: gateway, port: PORT, cert, machine: 'machine b' }))
      .toBe(addressTakenText({ host: gateway, port: PORT, main: true }));
    expect(addressRows()).toEqual([mainRow, rowA]);
    // R4
    for (const sql of [
      "INSERT INTO smdb_manager.addresses (host, port, slot, cert, machine) VALUES ('evil', 1, NULL, 'x', 'x')",
      "UPDATE smdb_manager.addresses SET machine = 'x'",
      'DELETE FROM smdb_manager.addresses',
    ]) {
      const r = await primarySql(bot(COPIES.a), code(), pem, 'sql', sql);
      expect(r.ok).toBe(false);
      expect(r.stderr).toContain('ERROR:  permission denied for table addresses');
    }
    // R5
    for (const role of [JOIN_LOGIN, U, 'dbm_work']) {
      const r = main.psql(role, `SELECT smdb_manager.set_copy_address('b.example', 1, ${sqlLiteral(cert)}, 'x');`, U);
      expect(r.status).not.toBe(0);
      expect(r.err).toContain('ERROR:  permission denied for function set_copy_address');
    }
    // R6
    for (const [args, error] of [
      [`'bad host', 15432, ${sqlLiteral(cert)}, 'a'`, 'smdb-address: the host is not a bare hostname or IPv4 address'],
      [`'a.example', 0, ${sqlLiteral(cert)}, 'a'`, 'smdb-address: the port is not a port number'],
      ["'a.example', 15432, 'not a cert', 'a'", 'smdb-address: the certificate is not a PEM certificate block'],
      [`'a.example', 15432, ${sqlLiteral(cert)}, ''`, 'smdb-address: the machine name is not 1 to 64 printable characters'],
    ]) {
      const r = await primarySql(bot(COPIES.a), code(), pem, 'sql', `SELECT smdb_manager.set_copy_address(${args})`);
      expect(r.ok).toBe(false);
      expect(r.stderr).toContain(`ERROR:  ${error}`);
    }
    expect(addressRows()).toEqual([mainRow, rowA]);
    // R7: 998 rows as a restore writes them fill the list to 1000.
    admin("INSERT INTO smdb_manager.addresses (host, port, slot, cert, machine) SELECT 'fill' || g || '.example', 1, NULL, 'x', 'fill' FROM generate_series(1, 998) g;", U);
    expect(await registerAddress(bot(COPIES.b), code(), pem, { host: 'b.example', port: 15432, cert, machine: 'machine b' }))
      .toContain('smdb-address: the address list already holds 1000 rows');
    expect(await registerAddress(bot(COPIES.a), code(), pem, { host: 'a.example', port: 15432, cert, machine: 'machine a' })).toBeNull();
    admin("DELETE FROM smdb_manager.addresses WHERE machine = 'fill';", U);
    // R8
    const dropB = await primarySql(bot(COPIES.b), code(), pem, 'sql', DROP_ADDRESS_SQL);
    expect([dropB.ok, dropB.stdout.trim()]).toEqual([true, '0']);
    const dropA = await primarySql(bot(COPIES.a), code(), pem, 'sql', DROP_ADDRESS_SQL);
    expect([dropA.ok, dropA.stdout.trim()]).toEqual([true, '1']);
    expect(addressRows()).toEqual([mainRow]);
    expect(await registerAddress(bot(COPIES.a), code(), pem, { host: 'a.example', port: 15432, cert, machine: 'machine a' })).toBeNull();
    expect(await registerAddress(bot(COPIES.b), code(), pem, { host: 'b.example', port: 15432, cert, machine: 'machine b' })).toBeNull();
    const rowB = `b.example|15432|${copySlot(COPIES.b)}|machine b`;
    expect(addressRows()).toEqual([mainRow, rowA, rowB]);
    // S7: registering at a new address removes the login's old row in the same statement.
    expect(await registerAddress(bot(COPIES.a), code(), pem, { host: 'a2.example', port: 15432, cert, machine: 'machine a' })).toBeNull();
    expect(addressRows()).toEqual([mainRow, `a2.example|15432|${copySlot(COPIES.a)}|machine a`, rowB]);
    expect(await registerAddress(bot(COPIES.a), code(), pem, { host: 'a.example', port: 15432, cert, machine: 'machine a' })).toBeNull();
    expect(addressRows()).toEqual([mainRow, rowA, rowB]);
  }, 900000);

  it('PG12 (S6, S8): a taken address names its holder\'s slot or the main, and the module\'s parse names B\'s login and the main', async () => {
    const before = addressRows();
    const cert = pem.trim();
    const onB = await primarySql(bot(COPIES.a), code(), pem, 'sql', addressUpsertSql({ host: 'b.example', port: 15432, cert, machine: 'machine a' }));
    expect(onB.ok).toBe(false);
    expect(onB.stderr).toContain(`ERROR:  smdb-address-taken: b.example:15432 is listed with the slot ${copySlot(COPIES.b)}`);
    expect(parseAddressTaken(onB.stderr)).toEqual({ host: 'b.example', port: 15432, holder: B });
    const onMain = await primarySql(bot(COPIES.a), code(), pem, 'sql', addressUpsertSql({ host: gateway, port: PORT, cert, machine: 'machine a' }));
    expect(onMain.ok).toBe(false);
    expect(onMain.stderr).toContain(`ERROR:  smdb-address-taken: ${gateway}:${PORT} is listed as the main's own address`);
    expect(parseAddressTaken(onMain.stderr)).toEqual({ host: gateway, port: PORT, main: true });
    expect(await registerAddress(bot(COPIES.a), code(), pem, { host: 'b.example', port: 15432, cert, machine: 'machine a' }))
      .toBe(addressTakenText({ host: 'b.example', port: 15432, holder: B }));
    expect(addressRows()).toEqual(before);
  }, 600000);

  it('PG11 (R6, R11): an aggregate the bot\'s role puts in a schema named after login A shadows json_agg, and readAddresses as A still reads the real rows', async () => {
    const created = asLogin(A, ownPassword('a'), ['pg_receivewal', '--create-slot', '-S', copySlot(COPIES.a), '-d', replConn(A)]);
    expect(created.status, created.err).toBe(0);
    ok(main.psql(U, `CREATE SCHEMA "${A}";
GRANT USAGE ON SCHEMA "${A}" TO PUBLIC;
CREATE FUNCTION "${A}".shadow_step(json, json) RETURNS json LANGUAGE sql AS $$ SELECT '"shadowed"'::json $$;
CREATE AGGREGATE "${A}".json_agg(json) (SFUNC = "${A}".shadow_step, STYPE = json);`, U));
    try {
      expect(ok(main.psql(A, "SELECT json_agg(json_build_object('h', 1))::text;", U))).toBe('"shadowed"');
      const listed = await readAddresses(bot(COPIES.a), code(), pem);
      expect(listed.ok).toBe(true);
      if (listed.ok) expect(listed.addresses.map(a => `${a.host}|${a.slot}`).sort()).toEqual([`${gateway}|null`, `a.example|${copySlot(COPIES.a)}`].sort());
    } finally {
      main.psql(U, `DROP SCHEMA "${A}" CASCADE;`, U);
    }
  }, 600000);

  it('PG13 (E26): a pg_hba line asking a cleartext password for a machine login is refused by mainProbe\'s require_auth; with scram the login opens', async () => {
    const lines = pgHbaContent(U).split('\n');
    expect(lines[1]).toMatch(/^local\s+all\s+all\s+trust$/);
    lines.splice(2, 0, `host    replication     ${B} 0.0.0.0/0 password`, `host    all             ${B} 0.0.0.0/0 password`);
    writeHba(lines.join('\n'));
    try {
      const refused = await mainProbe(bot(COPIES.b), code(), pem);
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.reason).toContain('authentication method requirement "scram-sha-256" failed: server requested a cleartext password');
    } finally {
      writeHba(pgHbaContent(U));
    }
    expect(await mainProbe(bot(COPIES.b), code(), pem)).toMatchObject({ ok: true, facts: { inRecovery: false } });
  }, 600000);

  it('PG4 (O5, R22, R31): Remove of a streaming login that owns a large object, a run stopped after step 1, an open session\'s writes, and RM-LEFT', async () => {
    const slotA = copySlot(COPIES.a);
    ok(docker(['exec', MAIN, 'mkdir', '-p', '/tmp/nm22-wal-a']));
    const stream = spawnSync('docker', ['exec', '-d', '-e', 'PGPASSWORD', MAIN, 'pg_receivewal', '-S', slotA, '-D', '/tmp/nm22-wal-a', '--no-loop', '-d', replConn(A)],
      { encoding: 'utf-8', timeout: 120000, env: { ...process.env, PGPASSWORD: ownPassword('a') } });
    expect(stream.status, stream.stderr).toBe(0);
    let active = '';
    for (let i = 0; i < 120 && active !== 'true'; i++) {
      active = admin(`SELECT coalesce((SELECT active::text FROM pg_replication_slots WHERE slot_name = '${slotA}'), 'absent');`);
      if (active !== 'true') pause(500);
    }
    expect(active).toBe('true');
    const lo = ok(main.psql(A, "SELECT lo_from_bytea(0, '\\x00'::bytea);", U));
    expect(lo).toMatch(/^\d+$/);
    const held = heldSession(A, 'postgres');
    try {
      await held.send('', 'ready');

      const asked = await removeCopyLogin(bot(MAIN_ID), A, false);
      expect(asked).toMatchObject({ success: false, needsConfirm: true });
      expect(asked.error).toContain(`The machine with the login ${A} streams from this database now (machine a).`);
      expect(blockState(A)).toBe('true|true|false');

      // Run 1: step 2 fails once, so the login is left blocked.
      let failed = false;
      h.onCall = (call, pass) => {
        if (!failed && callText(call).includes(endSessionsText(A))) {
          failed = true;
          return Promise.resolve({ ok: false, stdout: '', stderr: 'ERROR:  planted failure of step 2\n', error: 'ERROR:  planted failure of step 2' });
        }
        return pass();
      };
      try {
        expect(await removeCopyLogin(bot(MAIN_ID), A, true)).toEqual({ success: false, error: `The login ${A} was not removed completely: ending its sessions failed (planted failure of step 2). It is blocked: it cannot log in, other machines stop listing it within an hour, and this database ends its open sessions within 5 minutes. Press Remove again to finish.` });
      } finally {
        h.onCall = null;
      }
      expect(failed).toBe(true);
      expect(blockState(A)).toBe('false|false|true');
      // Step 1 ended the login's sessions inside its transaction: the held one and the stream.
      expect(admin(`SELECT count(*) FROM pg_stat_activity WHERE usename = '${A}';`)).toBe('0');
      const listed = await readAddresses(bot(COPIES.b), code(), pem);
      expect(listed.ok).toBe(true);
      if (listed.ok) expect(listed.addresses.map(a => `${a.host}|${a.slot}`)).toEqual([`${gateway}|null`]);
      expect(await ensureCopyLogin(bot(COPIES.a), code(), pem)).toEqual({ ok: false, error: joinBlockedText(gateway, PORT, A) });
      await roleStep();
      expect(blockState(A)).toBe('false|false|true');

      // Run 2: a password and a setting written on the login between step 1's commit and its check (by the superuser,
      // since step 1 ended the login's own sessions); 5b opens the login with neither.
      let blockLine = '';
      let opened = '';
      h.onCall = async (call, pass, run) => {
        if (call.input === REMOVE_BLOCK_SQL(A)) {
          const cut = call.input.indexOf('COMMIT;\n') + 'COMMIT;\n'.length;
          const first = await run({ ...call, input: call.input.slice(0, cut) });
          admin(`ALTER ROLE "${A}" PASSWORD 'x';\nALTER ROLE "${A}" SET work_mem = '8MB';`);
          const second = await run({ ...call, input: call.input.slice(cut) });
          blockLine = second.stdout.trim();
          return { ...second, ok: first.ok && second.ok, stdout: `${first.stdout}${second.stdout}`, stderr: `${first.stderr}${second.stderr}` };
        }
        if (call.login === A) {
          opened = admin(`SELECT r.rolcanlogin || '|' || (r.rolpassword IS NULL) || '|' || (SELECT count(*) FROM pg_db_role_setting s WHERE s.setrole = r.oid) FROM pg_authid r WHERE r.rolname = '${A}';`);
        }
        return pass();
      };
      try {
        expect(await removeCopyLogin(bot(MAIN_ID), A, true)).toEqual({ success: true, text: doneText(A) });
      } finally {
        h.onCall = null;
      }
      expect(blockLine).toBe('blocked|true|true|false');
      expect(opened).toBe('true|true|0');
    } finally {
      held.close();
    }
    expect(admin(`SELECT count(*) FROM pg_stat_activity WHERE usename = '${A}';`)).toBe('0');
    expect(admin(`SELECT count(*) FROM pg_replication_slots WHERE slot_name = '${slotA}';`)).toBe('0');
    expect(admin(`SELECT count(*) FROM smdb_manager.addresses WHERE slot = '${slotA}';`, U)).toBe('0');
    expect(admin(`SELECT count(*) FROM pg_largeobject_metadata WHERE oid = ${lo};`, U)).toBe('0');
    expect(admin(`SELECT count(*) FROM pg_roles WHERE rolname = '${A}';`)).toBe('0');

    // RM-LEFT: a right the bot's role granted login C stops the DROP ROLE; once revoked, Remove again finishes.
    const mintedC = await ensureCopyLogin(bot(COPIES.c), code(), pem);
    expect(mintedC, JSON.stringify(mintedC)).toMatchObject({ ok: true, minted: { kind: 'created' } });
    ok(main.psql(U, `CREATE TABLE public.nm22_left (x int);\nGRANT SELECT ON public.nm22_left TO ${C};`, U));
    expect(await removeCopyLogin(bot(MAIN_ID), C, false)).toEqual({ success: false, error: `The login ${C} is blocked (it cannot log in, and other machines stop listing it within an hour), but it was not dropped: Postgres still records 1 object in database ${U}. That is a right the bot's own login granted it in the bot's database, as a grant or a default privilege, which only the bot's login can take back. Press Remove again once it is revoked.` });
    expect(blockState(C)).toBe('false|false|true');
    ok(main.psql(U, `REVOKE SELECT ON public.nm22_left FROM ${C};\nDROP TABLE public.nm22_left;`, U));
    expect(await removeCopyLogin(bot(MAIN_ID), C, false)).toEqual({ success: true, text: doneText(C) });
    expect(admin(`SELECT count(*) FROM pg_roles WHERE rolname = '${C}';`)).toBe('0');
  }, 900000);

  // Part 5's rows run after PG4, which removed A and C: A and C are minted again where a row needs them.
  const slotOf = (login: string) => admin(`SELECT coalesce((SELECT r.usename FROM pg_replication_slots s JOIN pg_stat_replication r ON r.pid = s.active_pid WHERE s.slot_name = '${copySlot(COPIES.a)}'), '')`) === login;
  const waitFor = (what: string, check: () => boolean) => {
    for (let i = 0; i < 120; i++) {
      if (check()) return;
      pause(500);
    }
    throw new Error(`${what} did not happen within 60 seconds`);
  };
  const streamOnA = (login: string, password: string, dir: string) => {
    ok(docker(['exec', MAIN, 'mkdir', '-p', dir]));
    const r = spawnSync('docker', ['exec', '-d', '-e', 'PGPASSWORD', MAIN, 'pg_receivewal', '-S', copySlot(COPIES.a), '-D', dir, '--no-loop', '-d', replConn(login)],
      { encoding: 'utf-8', timeout: 120000, env: { ...process.env, PGPASSWORD: password } });
    expect(r.status, r.stderr).toBe(0);
    waitFor(`${login}'s stream on A's slot`, () => slotOf(login));
  };
  const sqlConn = (login: string) => `host=127.0.0.1 port=5432 user=${login} sslmode=require dbname=postgres`;
  const quietWarns = () => {
    const seen: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { seen.push(String(m)); });
    return { seen, restore: () => spy.mockRestore() };
  };
  const tick = () => machineLoginsCheck(bot(MAIN_ID), { container: MAIN, user: U });

  it('PG3 (Invariant S, W1, W2): B cannot drop or end A\'s stream; B\'s stream on A\'s slot is blocked, ended and the slot dropped by one tick; A\'s own stream is left by the next', async () => {
    const slotA = copySlot(COPIES.a);
    const mintedA = await ensureCopyLogin(bot(COPIES.a), code(), pem);
    expect(mintedA, JSON.stringify(mintedA)).toMatchObject({ ok: true, minted: { kind: 'created' } });
    ok(asLogin(A, ownPassword('a'), ['pg_receivewal', '--create-slot', '-S', slotA, '-d', replConn(A)]));
    streamOnA(A, ownPassword('a'), '/tmp/nm22-pg3-a');
    const dropped = asLogin(B, ownPassword('b'), ['psql', '-qAt', '-d', sqlConn(B), '-c', `SELECT pg_drop_replication_slot('${slotA}')`]);
    expect(dropped.status).not.toBe(0);
    expect(dropped.err).toContain(`ERROR:  replication slot "${slotA}" is active for PID`);
    const droppedRepl = asLogin(B, ownPassword('b'), ['psql', '-d', `${replConn(B)} replication=true`, '-c', `DROP_REPLICATION_SLOT ${slotA}`]);
    expect(droppedRepl.status).not.toBe(0);
    expect(droppedRepl.err).toContain(`ERROR:  replication slot "${slotA}" is active for PID`);
    const ended = asLogin(B, ownPassword('b'), ['psql', '-qAt', '-d', sqlConn(B), '-c', `SELECT pg_terminate_backend(active_pid) FROM pg_replication_slots WHERE slot_name = '${slotA}'`]);
    expect(ended.status).not.toBe(0);
    expect(ended.err).toContain('ERROR:  permission denied to terminate process');
    expect(slotOf(A)).toBe(true);

    admin(`SELECT pg_terminate_backend(active_pid, 5000) FROM pg_replication_slots WHERE slot_name = '${slotA}';`);
    waitFor("A's stream to end", () => slotOf(''));
    streamOnA(B, ownPassword('b'), '/tmp/nm22-pg3-b');
    const warns = quietWarns();
    try {
      await tick();
    } finally {
      warns.restore();
    }
    expect(blockState(B)).toBe('false|false|true');
    expect(admin(`SELECT count(*) FROM pg_replication_slots WHERE slot_name = '${slotA}';`)).toBe('0');
    expect(warns.seen).toContain(`[Switch] NM22 main: the login ${B} streamed on the slot ${slotA}, which belongs to another machine. The login is now blocked (it cannot log in, and other machines stop listing its machine within an hour); its stream was ended when the login was blocked; the slot was dropped, so its machine rebuilds its copy. Remove the login in the Database window.`);

    ok(asLogin(A, ownPassword('a'), ['pg_receivewal', '--create-slot', '-S', slotA, '-d', replConn(A)]));
    streamOnA(A, ownPassword('a'), '/tmp/nm22-pg3-a2');
    const second = quietWarns();
    try {
      await tick();
    } finally {
      second.restore();
    }
    expect(slotOf(A)).toBe(true);
    expect(second.seen.filter(l => l.includes('streamed on the slot'))).toEqual([]);
    admin(`SELECT pg_terminate_backend(active_pid, 5000) FROM pg_replication_slots WHERE slot_name = '${slotA}';`);
    waitFor("A's stream to end", () => slotOf(''));
  }, 900000);

  it('PG5 (Invariant U, R5): the list as A leaves out the rows of a NOLOGIN, slotless or dropped login; ownPeers\' SQL as dbm_meta keeps the slotless row', async () => {
    const mintedC = await ensureCopyLogin(bot(COPIES.c), code(), pem);
    expect(mintedC, JSON.stringify(mintedC)).toMatchObject({ ok: true, minted: { kind: 'created' } });
    const slotB = copySlot(COPIES.b);
    admin(`SELECT pg_catalog.pg_create_physical_replication_slot('${slotB}') WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = '${slotB}');`);
    expect(admin(`SELECT count(*) FROM pg_replication_slots WHERE slot_name = '${copySlot(COPIES.a)}';`)).toBe('1');
    expect(admin(`SELECT count(*) FROM pg_roles WHERE rolname = '${D}';`)).toBe('0');
    const cert = sqlLiteral(pem.trim());
    admin(`DELETE FROM smdb_manager.addresses WHERE slot IS NOT NULL;
INSERT INTO smdb_manager.addresses (host, port, slot, cert, machine) VALUES
  ('a.example', 15432, '${copySlot(COPIES.a)}', ${cert}, 'machine a'),
  ('b.example', 15432, '${slotB}', ${cert}, 'machine b'),
  ('c.example', 15432, '${copySlot(COPIES.c)}', ${cert}, 'machine c'),
  ('d.example', 15432, '${copySlot(COPIES.d)}', ${cert}, 'machine d');`, U);
    const listed = await readAddresses(bot(COPIES.a), code(), pem);
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.addresses.map(a => `${a.host}|${a.slot}`).sort()).toEqual([`${gateway}|null`, `a.example|${copySlot(COPIES.a)}`].sort());
    const peerCert = pem.trim().replace(/\n/g, '~');
    expect(ok(main.psql('dbm_meta', ownPeersSql(copySlot(MAIN_ID)), U))).toBe(`addr|a.example|15432|machine a|${peerCert}\naddr|c.example|15432|machine c|${peerCert}`);
    admin(`SELECT pg_catalog.pg_drop_replication_slot('${slotB}');`);
  }, 600000);

  it('PG10 (R2): large objects in the bot\'s database do not stop the module\'s dump; the tick unlinks smdb_join\'s in postgres and logs LOG-LOBJ', async () => {
    const lo = ok(main.psql(A, "SELECT lo_from_bytea(0, '\\x00'::bytea);", U));
    expect(lo).toMatch(/^\d+$/);
    const joinLo = asLogin(JOIN_LOGIN, JOIN_PW, ['psql', '-qAt', '-d', sqlConn(JOIN_LOGIN), '-c', "SELECT lo_from_bytea(0, '\\x00'::bytea)"]);
    expect(joinLo.status, joinLo.err).toBe(0);
    const dump = await runFleetDump(bot(MAIN_ID), 'nm22-pg10-');
    expect(dump.success, dump.error).toBe(true);
    const warns = quietWarns();
    try {
      await tick();
    } finally {
      warns.restore();
    }
    expect(warns.seen).toContain('[Switch] NM22 main: removed 1 large objects that smdb_join made in the postgres database; the manager keeps none there');
    expect(admin('SELECT count(*) FROM pg_largeobject_metadata;')).toBe('0');
    admin(`SELECT lo_unlink(${lo});`, U);
  }, 900000);

  it('PG6 (O8, B1, B3): the dump\'s list read through restoreLists keeps no smdb_manager entry; the meta transaction on a fresh database makes both functions as dbm_meta with EXECUTE only to smdb_copies, on a cluster without smdb_copies after copyGroupEnsureSql', async () => {
    ok(docker(['exec', MAIN, 'sh', '-c', `pg_dump -Fc -U dbm_admin -d ${U} -f /tmp/nm22-pg6.dump`]));
    const toc = ok(docker(['exec', MAIN, 'pg_restore', '-l', '/tmp/nm22-pg6.dump']));
    expect(toc).toContain('FUNCTION smdb_manager set_copy_address(text, integer, text, text)');
    const lists = restoreLists(toc, ok(docker(['exec', MAIN, 'pg_restore', '-l', '-n', 'smdb_manager', '/tmp/nm22-pg6.dump'])));
    expect(lists.refused).toBeNull();
    expect(lists.other.split('\n').filter(l => /^\d+; \d+ \d+ /.test(l) && l.includes('smdb_manager'))).toEqual([]);
    admin('CREATE DATABASE nm22_pg6 OWNER app;');
    try {
      admin('GRANT CONNECT, CREATE ON DATABASE nm22_pg6 TO dbm_meta; GRANT CONNECT ON DATABASE nm22_pg6 TO dbm_work;');
      ok(main.psql('dbm_meta', `BEGIN;\n${metaTransactionSql('')}COMMIT;\n`, 'nm22_pg6'));
      expect(fnAcl('smdb_manager.set_copy_address(text, integer, text, text)', 'nm22_pg6')).toBe('dbm_meta|true|search_path=pg_catalog, pg_temp|dbm_meta:EXECUTE,smdb_copies:EXECUTE');
      expect(fnAcl('smdb_manager.drop_copy_address()', 'nm22_pg6')).toBe('dbm_meta|true|search_path=pg_catalog, pg_temp|dbm_meta:EXECUTE,smdb_copies:EXECUTE');
    } finally {
      admin('DROP DATABASE IF EXISTS nm22_pg6 WITH (FORCE);');
    }

    // A cluster that never had smdb_copies: the meta transaction alone fails on the GRANT; the recreate's ensure first.
    const fresh = await provisionedCluster({ name: FRESH, user: U, db: U, password: APP_PW });
    try {
      const onFresh = (sql: string, db: string) => ok(fresh.psql('dbm_admin', sql, db));
      expect(onFresh("SELECT count(*) FROM pg_roles WHERE rolname = 'smdb_copies';", 'postgres')).toBe('0');
      onFresh('CREATE DATABASE nm22_pg6 OWNER app;', 'postgres');
      onFresh('GRANT CONNECT, CREATE ON DATABASE nm22_pg6 TO dbm_meta; GRANT CONNECT ON DATABASE nm22_pg6 TO dbm_work;', 'postgres');
      const alone = fresh.psql('dbm_meta', `BEGIN;\n${metaTransactionSql('')}COMMIT;\n`, 'nm22_pg6');
      expect(alone.status).not.toBe(0);
      expect(alone.err).toContain('ERROR:  role "smdb_copies" does not exist');
      expect(onFresh("SELECT count(*) FROM pg_namespace WHERE nspname = 'smdb_manager';", 'nm22_pg6')).toBe('0');
      onFresh(copyGroupEnsureSql(), 'postgres');
      expect(onFresh("SELECT rolcanlogin::text FROM pg_roles WHERE rolname = 'smdb_copies';", 'postgres')).toBe('false');
      ok(fresh.psql('dbm_meta', `BEGIN;\n${metaTransactionSql('')}COMMIT;\n`, 'nm22_pg6'));
      expect(fnAcl('smdb_manager.set_copy_address(text, integer, text, text)', 'nm22_pg6', onFresh)).toBe('dbm_meta|true|search_path=pg_catalog, pg_temp|dbm_meta:EXECUTE,smdb_copies:EXECUTE');
      expect(fnAcl('smdb_manager.drop_copy_address()', 'nm22_pg6', onFresh)).toBe('dbm_meta|true|search_path=pg_catalog, pg_temp|dbm_meta:EXECUTE,smdb_copies:EXECUTE');
    } finally {
      fresh.remove();
    }
  }, 900000);

  it('PG7 (B5): under the real fence script\'s lines on the TLS cluster, login A\'s replication IDENTIFY_SYSTEM over hostssl is admitted and a REPLICATION role outside smdb_copies is refused', async () => {
    const outside = 'nm22_pg7_outside';
    const outsidePw = 'nm22-pg7-outside';
    admin(`CREATE ROLE ${outside} LOGIN REPLICATION PASSWORD '${outsidePw}';`);
    try {
      ok(docker(['exec', '-u', 'root', MAIN, 'sh', '-c', fenceHbaScript(true, 'nm22-pg7')]));
      admin('SELECT pg_reload_conf();');
      pause(1000);
      const first = ok(docker(['exec', MAIN, 'head', '-n', '1', HBA]));
      expect(first).toMatch(/^hostssl replication \+smdb_copies all scram-sha-256 /);
      const admitted = asLogin(A, ownPassword('a'), ['psql', '-X', '-At', '-d', `${replConn(A)} replication=true`, '-c', 'IDENTIFY_SYSTEM']);
      expect(admitted.status, admitted.err).toBe(0);
      expect(admitted.out).toMatch(/^\d+\|1\|[0-9A-F]+\/[0-9A-F]+\|/);
      const refused = asLogin(outside, outsidePw, ['psql', '-X', '-At', '-d', `${replConn(outside)} replication=true`, '-c', 'IDENTIFY_SYSTEM']);
      expect(refused.status).not.toBe(0);
      expect(refused.err).toContain(`pg_hba.conf rejects replication connection for host "127.0.0.1", user "${outside}"`);
    } finally {
      writeHba(pgHbaContent(U));
      admin(`DROP ROLE IF EXISTS ${outside};`);
    }
  }, 600000);

  it('PG8 (X2, X4): a copy seeded by its own login and promoted holds the old main\'s own login, which runs IDENTIFY_SYSTEM and creates its own slot on it', async () => {
    const own = copyLogin(MAIN_ID);
    const slotF = copySlot(COPIES.f);
    const certFile = path.join(h.dir, 'server.crt');
    const onCopy = (sql: string) => ok(docker(['exec', '-i', COPY, 'psql', '-X', '-U', 'dbm_admin', '-d', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1'], sql));
    const madeSlot = asLogin(P, ownPassword('f'), ['psql', '-qAt', '-d', sqlConn(P), '-c', `SELECT pg_catalog.pg_create_physical_replication_slot('${slotF}')`]);
    expect(madeSlot.status, madeSlot.err).toBe(0);
    try {
      const seedDsn = `postgresql://${P}@${gateway}:${PORT}/${U}?sslmode=verify-full&sslrootcert=/primary-ca.crt`;
      const seed = spawnSync('docker', ['run', '--rm', '--name', COPY_SEED, '-e', 'PGPASSWORD', '-v', `${COPY_VOL}:/var/lib/postgresql/data`, '-v', `${certFile}:/primary-ca.crt:ro`,
        '--entrypoint', 'pg_basebackup', 'postgres:16-alpine', '-d', seedDsn, '-D', '/var/lib/postgresql/data', '-X', 'stream', '-R', '-S', slotF, '--checkpoint=fast'],
      { encoding: 'utf-8', timeout: 600000, env: { ...process.env, PGPASSWORD: ownPassword('f') } });
      expect(seed.status, seed.stderr).toBe(0);
      ok(docker(['run', '--rm', '--name', COPY_SEED, '-v', `${COPY_VOL}:/d`, 'postgres:16-alpine', 'chown', '-R', 'postgres:postgres', '/d']));
      ok(docker(['run', '-d', '--name', COPY, '-v', `${COPY_VOL}:/var/lib/postgresql/data`, '-v', `${certFile}:/primary-ca.crt:ro`, 'postgres:16-alpine']));
      waitFor('the copy to answer', () => docker(['exec', COPY, 'pg_isready', '-h', '127.0.0.1', '-q']).status === 0);
      expect(onCopy('SELECT pg_is_in_recovery();')).toBe('t');
      expect(onCopy('SELECT pg_promote();')).toBe('t');
      expect(onCopy('SELECT pg_is_in_recovery();')).toBe('f');
      expect(onCopy(`SELECT rolcanlogin || '|' || rolreplication FROM pg_roles WHERE rolname = '${own}';`)).toBe('true|true');
      expect(onCopy(`SELECT count(*) FROM pg_auth_members WHERE member = '${own}'::regrole AND roleid = 'smdb_copies'::regrole;`)).toBe('1');
      const ident = asLogin(own, MAIN_OWN_PW, ['psql', '-X', '-At', '-d', `${replConn(own)} replication=true`, '-c', 'IDENTIFY_SYSTEM'], COPY);
      expect(ident.status, ident.err).toBe(0);
      const [systemId, timeline] = ident.out.split('|');
      expect(timeline).toBe('2');
      expect(systemId).toBe(admin('SELECT system_identifier FROM pg_control_system();'));
      const created = asLogin(own, MAIN_OWN_PW, ['pg_receivewal', '--create-slot', '-S', copySlot(MAIN_ID), '-d', replConn(own)], COPY);
      expect(created.status, created.err).toBe(0);
      expect(onCopy(`SELECT count(*) FROM pg_replication_slots WHERE slot_name = '${copySlot(MAIN_ID)}';`)).toBe('1');
    } finally {
      docker(['rm', '-f', '-v', COPY]);
      docker(['volume', 'rm', '-f', COPY_VOL]);
      main.psql('dbm_admin', `SELECT pg_catalog.pg_drop_replication_slot('${slotF}') WHERE EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = '${slotF}' AND NOT active);`);
    }
  }, 900000);

  const lockWaiters = () => admin("SELECT count(*) FROM pg_stat_activity WHERE usename = 'dbm_admin' AND wait_event_type = 'Lock';");
  /** Runs `call` while a session of `login` holds an open ALTER ROLE on itself; the holder is ended in finally. */
  const underHeldAlter = async <T>(login: string, call: () => Promise<T>) => {
    const held = heldSession(login, 'postgres');
    try {
      await held.send(`BEGIN;\nALTER ROLE CURRENT_USER PASSWORD '${scramSha256Verifier('nm22-pg15-held')}';\n`, 'held');
      const start = Date.now();
      const answer = await call();
      const ms = Date.now() - start;
      return { answer, within30s: ms < 30000, ms, waiting: lockWaiters(), sessions: admin(`SELECT count(*) FROM pg_stat_activity WHERE usename = '${login}';`) };
    } finally {
      held.close();
      waitFor('the waiting manager sessions to end', () => lockWaiters() === '0');
    }
  };

  it('PG15 (finding 1): an open ALTER ROLE by the join login or a machine login on itself does not hold New join code or Remove past 30 seconds', async () => {
    const before = admin(`SELECT rolpassword FROM pg_authid WHERE rolname = '${JOIN_LOGIN}';`);
    const renew = await underHeldAlter(JOIN_LOGIN, () => renewJoinCode(bot(MAIN_ID)));
    const verifier = admin(`SELECT rolpassword FROM pg_authid WHERE rolname = '${JOIN_LOGIN}';`);
    const given = await getJoinCode(bot(MAIN_ID));
    const decoded = decodeJoinCode(given.joinCode ?? '');
    const newPassword = decoded.ok ? decoded.code.repl.password : '';
    const opens = newPassword !== JOIN_PW && asLogin(JOIN_LOGIN, newPassword, ['psql', '-qAt', '-d', sqlConn(JOIN_LOGIN), '-c', 'SELECT 1']).status === 0;

    expect(blockState(C)).toBe('true|true|false');
    const remove = await underHeldAlter(C, () => removeCopyLogin(bot(MAIN_ID), C, false));
    const left = admin(`SELECT count(*) FROM pg_roles WHERE rolname = '${C}';`) === '0' ? 'dropped' : blockState(C);

    expect({
      renew: { success: renew.answer.success, within30s: renew.within30s, holder: renew.sessions, waiting: renew.waiting, newVerifier: verifier !== before, opens },
      remove: { answer: remove.answer.success && remove.answer.text === doneText(C) ? 'success' : remove.answer.error ?? remove.answer.text, within30s: remove.within30s, waiting: remove.waiting, stepOne: left === 'dropped' || /^false\|false\|/.test(left) },
    }).toEqual({
      renew: { success: true, within30s: true, holder: '0', waiting: '0', newVerifier: true, opens: true },
      remove: { answer: 'success', within30s: true, waiting: '0', stepOne: true },
    });
  }, 120000);

  const minterInCopies = () => admin("SELECT pg_get_userbyid(roleid) || '|' || admin_option || '|' || inherit_option || '|' || set_option || '|' || pg_get_userbyid(grantor) FROM pg_auth_members WHERE member = 'smdb_minter'::regrole AND roleid = 'smdb_copies'::regrole ORDER BY 1;");

  it('PG16 (finding 3): a superuser\'s INHERIT grant to smdb_minter is repaired by the role step without revoking the logins smdb_minter granted', async () => {
    expect(memberships(A)).toBe('smdb_copies|false|true|true|smdb_minter');
    admin('GRANT smdb_copies TO smdb_minter WITH INHERIT TRUE;');
    expect(minterInCopies()).toBe('smdb_copies|true|true|false|dbm_admin');
    expect(await copyRoles()).toBe('copyroles|minter-grant');
    await roleStep();
    expect({
      member: admin(`SELECT count(*) FROM pg_auth_members WHERE roleid = 'smdb_copies'::regrole AND member = '${A}'::regrole;`),
      a: memberships(A),
      minter: minterInCopies(),
    }).toEqual({ member: '1', a: 'smdb_copies|false|true|true|smdb_minter', minter: 'smdb_copies|true|false|false|dbm_admin' });
    expect(await copyRoles()).toBe('copyroles|ok');
  }, 600000);

  it('PG17 (code review 2, finding 2): a machine login\'s open ALTER ROLE on itself stops Enable\'s role step and Disable\'s close on the 5 s lock limit, and no session is ended', async () => {
    expect(blockState(A)).toBe('true|true|false');
    const read = (r: { answer: { ok: boolean; stderr: string }; within30s: boolean; waiting: string; sessions: string }) => ({
      failed: !r.answer.ok, lockTimeout: r.answer.stderr.includes('ERROR:  canceling statement due to lock timeout'), within30s: r.within30s, waiting: r.waiting, holder: r.sessions,
    });
    const enable = await underHeldAlter(A, () => enableRoleStep(MAIN, { joinPassword: JOIN_PW, ownId: MAIN_ID, ownPassword: MAIN_OWN_PW }));
    const disable = await underHeldAlter(A, () => runCall(MAIN, clusterPsql(MAIN, DISABLE_CLOSE_SQL, { stdin: true })));
    const expected = { failed: true, lockTimeout: true, within30s: true, waiting: '0', holder: '1' };
    expect({ enable: read(enable), disable: read(disable), a: blockState(A), join: roleAttrs(JOIN_LOGIN).split('|')[0] })
      .toEqual({ enable: expected, disable: expected, a: 'true|true|false', join: 'true' });
    // The closed line's count form leaves out a session that was gone already (pg_terminate_backend answers false).
    expect(admin("SELECT 'closed|' || pg_catalog.count(*) FILTER (WHERE pg_catalog.pg_terminate_backend(p, 1)) FROM (VALUES (2147483000)) v(p);")).toBe('closed|0');
  }, 120000);
});
