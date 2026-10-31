import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// NM5's SQL and its database-level proofs against a real Postgres 16: a main with TLS on a test network, a streaming
// copy, a receiver. Skipped on Windows and without docker; the main session runs it with linux_pg.sh.
const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-pg-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { certFingerprint } from '../../src/config/joinCode';
import { CHECKSUM_SQL, COUNTS_SQL, compareChecksums, compareCounts, parseChecksumLines, parseCountLines } from '../../src/instance/backupFiles';
import { ensureManagerDbRole, MANAGER_DB_ROLE } from '../../src/instance/dbLogin';
import { addressTableSql } from '../../src/instance/fleetReplication';
import { fenceHbaScript } from '../../src/instance/fleetBackup';
import { peerProbe } from '../../src/instance/fleetJoin';
import {
  COPIES_READ_SQL, COPIES_SYNC_SQL, DB_OID_SQL, ensureGenerationSql, GEN_READ_SQL, pushBrokenOf, GENERATION_SCHEMA_SQL, generationAfterRestore, generationBefore, parseGenRow, parseRestoreState, raiseSql,
  missingTable, parseReceiveMark, RECEIVE_DROP_SQL, RECEIVE_END_SQL, RECEIVE_MARK_COUNT_SQL, RECEIVE_MARK_READ_SQL, RECEIVE_NOLOGIN_SQL, RECEIVED_OF_SQL, receiveMarkClearSql, receiveMarkSql,
  replicationRoleEnsureSql, RESTORE_STATE_CLEAR, RESTORE_STATE_READ, restoreStateUpsertSql, takeoverBlockScript, takeoverLiftScript,
} from '../../src/instance/switchSql';

const dockerRuns = (() => {
  try {
    return spawnSync('docker', ['version'], { stdio: 'ignore', timeout: 10000 }).status === 0;
  } catch {
    return false;
  }
})();

// Every container, volume and network is named here and removed by exact name.
const ID = `nm5pg${process.pid}`;
const NET = `${ID}-net`;
const MAIN = `${ID}-main`;
const COPY = `${ID}-copy`;
const RECV = `${ID}-recv`;
const MAIN_VOL = `${ID}-main-data`;
const COPY_VOL = `${ID}-copy-data`;
const RECV_VOL = `${ID}-recv-data`;
const R13 = `${ID}-r13`;
const R13_VOL = `${ID}-r13-data`;
const OCTET = 100 + (process.pid % 100);
const SUBNET = `10.214.${OCTET}.0/24`;
const MAIN_IP = `10.214.${OCTET}.10`;
const COPY_IP = `10.214.${OCTET}.11`;
const RECV_IP = `10.214.${OCTET}.12`;
const R13_IP = `10.214.${OCTET}.13`;
const PORT = 20000 + (process.pid % 20000);
const REPL_PW = 'replpass';
const APP_PW = 'app-pw';
const BOT_PW = 'bot-pw';
const SLOT = 'fleet_standby_nm5pg';
const BOT = 'nm5bot';

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const run = (args: string[], input?: string | Buffer, env?: NodeJS.ProcessEnv) => {
  const r = spawnSync('docker', args, { encoding: 'utf-8', timeout: 600000, input, env: env ? { ...process.env, ...env } : process.env });
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
const psql = (container: string, sql: string, db = 'smdb', user = 'smdb') =>
  run(['exec', '-i', container, 'psql', '-X', '-U', user, '-d', db, '-tA', '-v', 'ON_ERROR_STOP=1'], sql);
const ok = (container: string, sql: string, db = 'smdb') => {
  const r = psql(container, sql, db);
  expect(r.status, r.err).toBe(0);
  return r.out;
};
const waitReady = (container: string) => {
  for (let i = 0; i < 240; i++) {
    if (run(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-q']).status === 0) return;
    pause(500);
  }
  throw new Error(`${container} did not become ready`);
};
const until = (what: string, test: () => boolean, tries = 120) => {
  for (let i = 0; i < tries; i++) {
    if (test()) return;
    pause(500);
  }
  throw new Error(`${what} did not happen in ${tries / 2} seconds`);
};
/** One -c string in its own transaction, command tags off, as fleetBackup.ts runs the restore record's upsert. */
const okQuiet = (container: string, sql: string, db = 'smdb') => {
  const r = run(['exec', container, 'psql', '-X', '-q', '-U', 'smdb', '-d', db, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
  expect(r.status, r.err).toBe(0);
  return r.out;
};
/** The bot role logging in over TCP inside a container, as a bot on another machine would. */
const botTcp = (container: string, sql = 'SELECT 1') => run(['exec', '-e', `PGPASSWORD=${BOT_PW}`, container, 'psql', '-X', '-h', '127.0.0.1', '-U', 'bot', '-d', 'smdb', '-w', '-tAc', sql]);
const genOf = (container: string) => parseGenRow(ok(container, GEN_READ_SQL));
const replDsn = (host: string) => `postgresql://replicator@${host}:5432/smdb?sslmode=verify-full&sslrootcert=/primary-ca.crt`;

describe.skipIf(process.platform === 'win32' || !dockerRuns)('NM5 switch and move against a real Postgres 16 (Linux with docker)', () => {
  let certFile = '';
  let pem = '';
  let gateway = '';

  const startPg = (name: string, ip: string, vol: string, extra: string[] = []) => {
    const r = run(['run', '-d', '--name', name, '--network', NET, '--ip', ip, '-v', `${vol}:/var/lib/postgresql/data`, ...extra,
      '-e', 'POSTGRES_USER=smdb', '-e', `POSTGRES_PASSWORD=${APP_PW}`, '-e', 'POSTGRES_DB=smdb', 'postgres:16-alpine']);
    expect(r.status, r.err).toBe(0);
    waitReady(name);
  };
  const tls = (name: string) => {
    for (const f of ['server.crt', 'server.key']) expect(run(['cp', path.join(h.dir, f), `${name}:/var/lib/postgresql/data/${f}`]).status).toBe(0);
    expect(run(['exec', '-u', 'root', name, 'sh', '-c', 'chown postgres:postgres /var/lib/postgresql/data/server.* && chmod 600 /var/lib/postgresql/data/server.key && printf "hostssl replication all 0.0.0.0/0 scram-sha-256\\nhostssl all all 0.0.0.0/0 scram-sha-256\\n" >> /var/lib/postgresql/data/pg_hba.conf']).status).toBe(0);
    ok(name, 'ALTER SYSTEM SET ssl = on;');
    ok(name, 'SELECT pg_reload_conf();');
  };
  const code = () => ({
    v: 1 as const, host: gateway, port: PORT, db: 'smdb', fp: certFingerprint(pem), machine: 'main',
    repl: { user: 'replicator', password: REPL_PW }, app: { user: 'smdb', password: APP_PW },
  });
  const publishOf = (port: number) => process.env.SMDB_PG_PUBLISH === 'all' ? `${port}:5432` : `${gateway}:${port}:5432`;
  /** Whether a TCP login over loopback inside MAIN is accepted: the fence's reject lines come before the trust line. */
  const loopbackOpen = () => run(['exec', MAIN, 'psql', '-X', '-h', '127.0.0.1', '-U', 'smdb', '-d', 'smdb', '-tAc', 'SELECT 1']).status === 0;
  const hbaFacts = () => {
    const login = run(['exec', MAIN, 'psql', '-X', '-h', '127.0.0.1', '-U', 'smdb', '-d', 'smdb', '-tAc', 'SELECT 1']);
    const rules = psql(MAIN, 'SELECT line_number, type, database, user_name, address, auth_method, error FROM pg_hba_file_rules;');
    const files = run(['exec', '-u', 'root', MAIN, 'ls', '-l', '/var/lib/postgresql/data/pg_hba.conf', '/tmp/hba.keep']);
    return `\nloopback login: status ${login.status} ${login.err}\npg_hba_file_rules (status ${rules.status}):\n${rules.out}\n${rules.err}\nls: ${files.out}\n${files.err}`;
  };
  const untilHba = (what: string, cond: () => boolean, tries: number) => {
    try { until(what, cond, tries); } catch (e) { throw new Error(`${(e as Error).message}${hbaFacts()}`); }
  };
  const instance = () => ({ id: BOT, sanitizedName: ID, displayName: 'NM5', sourceUrl: 'https://example.invalid/x', status: 'stopped', createdAt: 'x', updatedAt: 'x' }) as any;

  beforeAll(async () => {
    gateway = run(['network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}']).out;
    expect(gateway).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    certFile = path.join(h.dir, 'server.crt');
    const gen = spawnSync('openssl', ['req', '-new', '-x509', '-days', '30', '-nodes', '-newkey', 'rsa:2048', '-subj', `/CN=${MAIN}`,
      '-addext', `subjectAltName=DNS:${MAIN},DNS:${COPY},DNS:${RECV},IP:${MAIN_IP},IP:${COPY_IP},IP:${RECV_IP},IP:${gateway}`,
      '-keyout', path.join(h.dir, 'server.key'), '-out', certFile], { encoding: 'utf-8' });
    expect(gen.status, gen.stderr).toBe(0);
    pem = fs.readFileSync(certFile, 'utf-8');
    expect(run(['network', 'create', '--subnet', SUBNET, NET]).status).toBe(0);
    startPg(MAIN, MAIN_IP, MAIN_VOL, ['-p', publishOf(PORT)]);
    tls(MAIN);
    ok(MAIN, `CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '${REPL_PW}'; CREATE ROLE bot LOGIN PASSWORD '${BOT_PW}'; GRANT CONNECT ON DATABASE smdb TO bot;`);
    expect(await ensureManagerDbRole({ container: MAIN, user: 'smdb' })).toEqual({ ok: true });
    ok(MAIN, addressTableSql(MAIN_IP, 5432, pem.trim(), 'main', null));
    ok(MAIN, ensureGenerationSql('main'));
    ok(MAIN, 'CREATE TABLE public.t (id int PRIMARY KEY, v text); ALTER TABLE public.t OWNER TO smdb; INSERT INTO public.t SELECT g, md5(g::text) FROM generate_series(1, 50) g;');
    ok(MAIN, `SELECT pg_create_physical_replication_slot('${SLOT}');`);
    const seed = run(['run', '--rm', '--network', NET, '-e', 'PGPASSWORD', '-v', `${COPY_VOL}:/var/lib/postgresql/data`, '-v', `${certFile}:/primary-ca.crt:ro`,
      '--entrypoint', 'pg_basebackup', 'postgres:16-alpine', '-d', replDsn(MAIN), '-D', '/var/lib/postgresql/data', '-X', 'stream', '-R', '-S', SLOT, '--checkpoint=fast'], undefined, { PGPASSWORD: REPL_PW });
    expect(seed.status, seed.err).toBe(0);
    expect(run(['run', '--rm', '-v', `${COPY_VOL}:/d`, 'postgres:16-alpine', 'chown', '-R', 'postgres:postgres', '/d']).status).toBe(0);
    const copy = run(['run', '-d', '--name', COPY, '--network', NET, '--ip', COPY_IP, '-v', `${COPY_VOL}:/var/lib/postgresql/data`, '-v', `${certFile}:/primary-ca.crt:ro`, 'postgres:16-alpine']);
    expect(copy.status, copy.err).toBe(0);
    waitReady(COPY);
    until('the copy streams', () => ok(MAIN, `SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming'`) === '1');
  }, 900000);

  afterAll(() => {
    for (const c of [MAIN, COPY, RECV, R13]) run(['rm', '-f', '-v', c]);
    for (const v of [MAIN_VOL, COPY_VOL, RECV_VOL, R13_VOL]) run(['volume', 'rm', '-f', v]);
    run(['network', 'rm', NET]);
    fs.rmSync(h.dir, { recursive: true, force: true });
  }, 300000);

  it('PG2 the raise twice gives g + 1 once; every role reads the row, replicator cannot write it; the row reaches the copy', () => {
    expect(genOf(MAIN)!.generation).toBe(1);
    ok(MAIN, raiseSql('main', 2));
    ok(MAIN, raiseSql('main', 2));
    expect(genOf(MAIN)).toMatchObject({ generation: 2, machine: 'main' });
    expect(psql(MAIN, 'SELECT generation FROM smdb_manager.generation', 'smdb', 'bot').out).toBe('2');
    const repl = run(['exec', '-i', '-e', `PGPASSWORD=${REPL_PW}`, MAIN, 'psql', '-X', '-h', '127.0.0.1', '-U', 'replicator', '-d', 'smdb', '-tA', '-v', 'ON_ERROR_STOP=1'], 'SELECT generation FROM smdb_manager.generation;');
    expect(repl.out).toBe('2');
    const write = run(['exec', '-i', '-e', `PGPASSWORD=${REPL_PW}`, MAIN, 'psql', '-X', '-h', '127.0.0.1', '-U', 'replicator', '-d', 'smdb', '-tA', '-v', 'ON_ERROR_STOP=1'], 'UPDATE smdb_manager.generation SET generation = 99;');
    expect(write.status).not.toBe(0);
    until('the row reaches the copy', () => psql(COPY, GEN_READ_SQL).out.startsWith('2|'));
  }, 300000);

  it('PG9 the restore record: upserted under the read-only setting in the exempt session, kept higher, left by a drop, replicated, cleared', () => {
    ok(MAIN, 'CREATE DATABASE scratch OWNER smdb;');
    ok(MAIN, 'ALTER SYSTEM SET default_transaction_read_only = on; SELECT pg_reload_conf();', 'postgres');
    try {
      const up = run(['exec', '-i', '-e', 'PGOPTIONS=-c default_transaction_read_only=off', MAIN, 'psql', '-X', '-U', MANAGER_DB_ROLE, '-d', 'postgres', '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', restoreStateUpsertSql('a.dump', { generation: 5, machine: 'main', since: null })]);
      expect(up.status, up.err).toBe(0);
      expect(up.out.split('\n').pop()).toBe('5|main|');
      const lower = run(['exec', '-i', '-e', 'PGOPTIONS=-c default_transaction_read_only=off', MAIN, 'psql', '-X', '-U', MANAGER_DB_ROLE, '-d', 'postgres', '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', restoreStateUpsertSql('b.dump', { generation: 3, machine: 'x', since: null })]);
      expect(lower.out.split('\n').pop()).toBe('5|main|');
      expect(run(['exec', '-i', '-e', 'PGOPTIONS=-c default_transaction_read_only=off', MAIN, 'psql', '-X', '-U', 'smdb', '-d', 'postgres', '-c', 'DROP DATABASE scratch WITH (FORCE)']).status).toBe(0);
    } finally {
      ok(MAIN, 'ALTER SYSTEM RESET default_transaction_read_only; SELECT pg_reload_conf();', 'postgres');
    }
    expect(parseRestoreState(ok(MAIN, RESTORE_STATE_READ, 'postgres'))).toMatchObject({ pending: true, file: 'b.dump', floor: { generation: 5 } });
    until('the record reaches the copy', () => parseRestoreState(psql(COPY, RESTORE_STATE_READ, 'postgres').out)?.pending === true);
    ok(MAIN, RESTORE_STATE_CLEAR, 'postgres');
    until('the clear reaches the copy', () => parseRestoreState(psql(COPY, RESTORE_STATE_READ, 'postgres').out)?.pending === false);
  }, 300000);

  it('PG8 a restore raises above both: g + 2 after a dump at g into a row at g + 1, then above the floor after a failed drop', () => {
    const g = genOf(MAIN)!.generation;
    ok(MAIN, 'DROP TABLE IF EXISTS smdb_manager.restore_state;', 'postgres');
    ok(MAIN, 'CREATE DATABASE pg8 OWNER smdb;');
    ok(MAIN, ensureGenerationSql('main'), 'pg8');
    ok(MAIN, raiseSql('main', g), 'pg8');
    expect(run(['exec', MAIN, 'pg_dump', '-U', 'smdb', '-Fc', '-f', '/tmp/pg8.dump', 'pg8']).status).toBe(0);
    ok(MAIN, raiseSql('main', g + 1), 'pg8');
    const before = genOf(MAIN)!;
    ok(MAIN, 'DROP DATABASE pg8 WITH (FORCE); CREATE DATABASE pg8 OWNER smdb;', 'postgres');
    expect(run(['exec', MAIN, 'pg_restore', '-U', 'smdb', '-d', 'pg8', '/tmp/pg8.dump']).status).toBe(0);
    const restored = parseGenRow(ok(MAIN, GEN_READ_SQL, 'pg8'));
    const target = generationAfterRestore({ ...before, generation: g + 1 }, restored ?? null, 'here', 'x');
    expect(target.generation).toBe(g + 2);
    ok(MAIN, raiseSql('here', target.generation), 'pg8');
    expect(parseGenRow(ok(MAIN, GEN_READ_SQL, 'pg8'))).toMatchObject({ generation: g + 2, machine: 'here' });
    const floor = parseGenRow(okQuiet(MAIN, restoreStateUpsertSql('pg8b.dump', { generation: g + 2, machine: 'here', since: null }), 'postgres'));
    ok(MAIN, 'DROP DATABASE pg8 WITH (FORCE); CREATE DATABASE pg8 OWNER smdb;', 'postgres');
    const none = psql(MAIN, GEN_READ_SQL, 'pg8');
    expect(none.status).not.toBe(0);
    const again = generationAfterRestore(generationBefore(null, floor ?? null), null, 'here', 'x');
    expect(again.generation).toBe(g + 3);
    ok(MAIN, raiseSql('here', again.generation), 'pg8');
    expect(parseGenRow(ok(MAIN, GEN_READ_SQL, 'pg8'))).toMatchObject({ generation: g + 3, machine: 'here' });
    ok(MAIN, 'DROP DATABASE pg8 WITH (FORCE);', 'postgres');
  }, 300000);

  it('PG12 the list of copies: one row per physical slot, named by its address row or its client; a dropped slot leaves the list; the copy reads the others', () => {
    ok(MAIN, `DELETE FROM smdb_manager.addresses WHERE slot = '${SLOT}'; INSERT INTO smdb_manager.addresses (host, port, slot, cert, machine) VALUES ('${COPY_IP}', 5432, '${SLOT}', 'x', 'copy');`);
    ok(MAIN, "SELECT pg_create_physical_replication_slot('nm5pg_other');");
    ok(MAIN, COPIES_SYNC_SQL);
    ok(MAIN, COPIES_SYNC_SQL);
    expect(ok(MAIN, 'SELECT slot || \'|\' || coalesce(machine, \'\') || \'|\' || coalesce(client, \'\') FROM smdb_manager.copies ORDER BY slot')).toBe(`${SLOT}|copy|${COPY_IP}\nnm5pg_other||`);
    until('the list reaches the copy', () => psql(COPY, COPIES_READ_SQL('nm5pg_other')).out === `copy|${COPY_IP}`);
    expect(psql(COPY, COPIES_READ_SQL(SLOT)).out).toBe('|');
    ok(MAIN, "SELECT pg_drop_replication_slot('nm5pg_other');");
    ok(MAIN, COPIES_SYNC_SQL);
    expect(ok(MAIN, 'SELECT string_agg(slot, \',\') FROM smdb_manager.copies')).toBe(SLOT);
    until('the drop reaches the copy', () => psql(COPY, COPIES_READ_SQL(SLOT)).out === '');
    ok(MAIN, `DELETE FROM smdb_manager.addresses WHERE slot = '${SLOT}';`);
  }, 300000);

  it('PG14 the receive mark: written on the main\'s postgres database, replicated, readable by the replication login on both, left by a drop of the bot database, replaced in place, removed only by its own id, and a removal before the hand-over row covered by the slot\'s replay proof', () => {
    // A database of its own stands for the bot database, so the rows after this one keep smdb.
    const BOTDB = 'nm5pg14';
    const BARE = 'nm5pg14bare';
    ok(MAIN, `DROP DATABASE IF EXISTS ${BOTDB}`, 'postgres');
    ok(MAIN, `CREATE DATABASE ${BOTDB}`, 'postgres');
    const oid = ok(MAIN, DB_OID_SQL(BOTDB), 'postgres');
    expect(oid).toMatch(/^\d+$/);
    const id = 'a1b2c3';
    const id2 = 'd4e5f6';
    const asAdmin = (sql: string, container = MAIN) => {
      const r = psql(container, sql, 'postgres', MANAGER_DB_ROLE);
      expect(r.status, r.err).toBe(0);
      return r.out;
    };
    asAdmin(receiveMarkSql(id, [id], oid));
    until('the mark reaches the copy', () => psql(COPY, RECEIVE_MARK_READ_SQL, 'postgres').out === `${id}|${id}|${oid}`);
    expect(parseReceiveMark(psql(COPY, RECEIVE_MARK_READ_SQL, 'postgres').out)).toEqual({ markId: id, pushIds: [id], dbOid: oid });
    const replCount = (ip: string) => run(['run', '--rm', '--network', NET, '-e', 'PGPASSWORD', '-v', `${certFile}:/primary-ca.crt:ro`, '--entrypoint', 'psql', 'postgres:16-alpine',
      `postgresql://replicator@${ip}:5432/postgres?sslmode=verify-full&sslrootcert=/primary-ca.crt`, '-X', '-v', 'ON_ERROR_STOP=1', '-Atc', RECEIVE_MARK_COUNT_SQL], undefined, { PGPASSWORD: REPL_PW });
    for (const ip of [MAIN_IP, COPY_IP]) {
      const r = replCount(ip);
      expect(r.status, `${ip}: ${r.err}`).toBe(0);
      expect(r.out).toBe('1');
    }
    ok(MAIN, `DROP DATABASE ${BOTDB}`, 'postgres');
    ok(MAIN, `CREATE DATABASE ${BOTDB}`, 'postgres');
    expect(asAdmin(RECEIVE_MARK_READ_SQL)).toBe(`${id}|${id}|${oid}`);
    until('the new oid reaches the copy', () => { const now = psql(COPY, DB_OID_SQL(BOTDB), 'postgres').out; return /^\d+$/.test(now) && now !== oid; });
    asAdmin(receiveMarkSql(id, [id, id2], oid));
    expect(asAdmin(RECEIVE_MARK_COUNT_SQL)).toBe('1');
    expect(asAdmin(RECEIVE_MARK_READ_SQL)).toBe(`${id}|${id},${id2}|${oid}`);
    asAdmin(receiveMarkClearSql('ffff00'));
    expect(asAdmin(RECEIVE_MARK_COUNT_SQL)).toBe('1');
    until('the second write reaches the copy', () => psql(COPY, RECEIVE_MARK_READ_SQL, 'postgres').out === `${id}|${id},${id2}|${oid}`);
    asAdmin(receiveMarkClearSql(id));
    expect(asAdmin(RECEIVE_MARK_READ_SQL)).toBe('');
    until('the removal reaches the copy', () => psql(COPY, RECEIVE_MARK_READ_SQL, 'postgres').out === '');
    // D66: Hand over removes a left-over mark in postgres, then writes its row in the bot database; the slot's proof of L covers the removal.
    asAdmin(receiveMarkSql(id2, [id2], oid));
    until('the left-over mark reaches the copy', () => psql(COPY, RECEIVE_MARK_READ_SQL, 'postgres').out === `${id2}|${id2}|${oid}`);
    asAdmin(receiveMarkClearSql(id2));
    const L = ok(MAIN, `BEGIN;\n${GENERATION_SCHEMA_SQL}\nDELETE FROM smdb_manager.handover;\nINSERT INTO smdb_manager.handover (slot, machine, generation) VALUES ('${SLOT}', 'copy', 2);\nCOMMIT;\nSELECT pg_current_wal_lsn();`, BOTDB).split('\n').pop()!;
    expect(L).toMatch(/^[0-9A-F]+\/[0-9A-F]+$/);
    const slotReplayed = `SELECT coalesce((SELECT coalesce((r.replay_lsn >= '${L}'::pg_lsn)::text, '') FROM pg_replication_slots s LEFT JOIN pg_stat_replication r ON r.pid = s.active_pid WHERE s.slot_name = '${SLOT}'), 'absent')`;
    until('the slot reads replay_lsn >= L', () => psql(MAIN, slotReplayed).out === 'true');
    expect(psql(COPY, RECEIVE_MARK_READ_SQL, 'postgres').out).toBe('');
    // The catalog is per database: one without the smdb_manager schema stands for a cluster that never received.
    ok(MAIN, `DROP DATABASE IF EXISTS ${BARE}`, 'postgres');
    ok(MAIN, `CREATE DATABASE ${BARE}`, 'postgres');
    const bare = (sql: string) => psql(MAIN, sql, BARE, MANAGER_DB_ROLE);
    expect(bare(receiveMarkClearSql(null)).status).toBe(0);
    const read = bare(RECEIVE_MARK_READ_SQL);
    expect(read.status).not.toBe(0);
    expect(missingTable(read.err), read.err).toBe(true);
    const count = bare(RECEIVE_MARK_COUNT_SQL);
    expect(count.status).not.toBe(0);
    expect(count.err).toContain('smdb_manager');
    ok(MAIN, `DROP DATABASE ${BARE}`, 'postgres');
    ok(MAIN, `DROP DATABASE ${BOTDB}`, 'postgres');
  }, 600000);

  it('PG11 the take-over block on a streaming copy: a bot TCP login refused before and after the promotion and a restart, open after the lift', () => {
    until('the bot role reaches the copy', () => botTcp(COPY).status === 0);
    const held = run(['exec', '-d', '-e', `PGPASSWORD=${BOT_PW}`, COPY, 'psql', '-X', '-h', '127.0.0.1', '-U', 'bot', '-d', 'smdb', '-c', 'SELECT pg_sleep(600)']);
    expect(held.status).toBe(0);
    until('the held session opens', () => psql(COPY, "SELECT count(*) FROM pg_stat_activity WHERE usename = 'bot'").out === '1');
    expect(run(['exec', '-u', 'root', COPY, 'sh', '-c', takeoverBlockScript('bot')]).status).toBe(0);
    expect(run(['exec', '-u', 'root', COPY, 'sh', '-c', takeoverBlockScript('bot')]).status).toBe(0);
    expect(run(['exec', COPY, 'grep', '-c', 'smdb-takeover-block', '/var/lib/postgresql/data/pg_hba.conf']).out).toBe('1');
    ok(COPY, 'SELECT pg_reload_conf();');
    expect(botTcp(COPY).err).toContain('pg_hba.conf rejects connection');
    expect(psql(COPY, 'SELECT 1').status).toBe(0);
    expect(ok(MAIN, `SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming'`)).toBe('1');
    ok(COPY, "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'bot' AND backend_type = 'client backend';");
    until('the held session ends', () => psql(COPY, "SELECT count(*) FROM pg_stat_activity WHERE usename = 'bot'").out === '0');
    expect(run(['stop', MAIN]).status).toBe(0);
    expect(ok(COPY, 'SELECT pg_promote(true, 60);')).toBe('t');
    expect(botTcp(COPY).err).toContain('pg_hba.conf rejects connection');
    expect(run(['restart', COPY]).status).toBe(0);
    waitReady(COPY);
    expect(botTcp(COPY).err).toContain('pg_hba.conf rejects connection');
    ok(COPY, raiseSql('copy', 3));
    expect(run(['exec', '-u', 'root', COPY, 'sh', '-c', takeoverLiftScript()]).status).toBe(0);
    expect(run(['exec', '-u', 'root', COPY, 'sh', '-c', takeoverLiftScript()]).status).toBe(0);
    ok(COPY, 'SELECT pg_reload_conf();');
    expect(botTcp(COPY, 'SELECT generation FROM smdb_manager.generation').out).toBe('3');
  }, 600000);

  it('PG3 the old main started again is writable at its old generation, and the peer read from it sees the new main higher with the same system id', async () => {
    expect(run(['start', MAIN]).status).toBe(0);
    waitReady(MAIN);
    expect(genOf(MAIN)!.generation).toBeLessThan(3);
    ok(COPY, `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'replicator') THEN CREATE ROLE replicator REPLICATION LOGIN PASSWORD '${REPL_PW}'; END IF; END $$;`);
    tls(COPY);
    // The probe runs on the default bridge, which reaches another network's container only on a published port (as MAIN's).
    expect(run(['rm', '-f', COPY]).status).toBe(0);
    const copy = run(['run', '-d', '--name', COPY, '--network', NET, '--ip', COPY_IP, '-p', publishOf(PORT + 1), '-v', `${COPY_VOL}:/var/lib/postgresql/data`, '-v', `${certFile}:/primary-ca.crt:ro`, 'postgres:16-alpine']);
    expect(copy.status, copy.err).toBe(0);
    waitReady(COPY);
    const probe = await peerProbe(instance(), { ...code(), host: COPY_IP, port: 5432 }, pem, 'pg3');
    expect(probe, JSON.stringify(probe)).toMatchObject({ kind: 'writable', gen: { generation: 3 } });
    expect((probe as any).systemId).toBe(ok(MAIN, 'SELECT system_identifier FROM pg_control_system();'));
    ok(MAIN, 'ALTER ROLE bot NOLOGIN;');
    expect(botTcp(MAIN).status).not.toBe(0);
  }, 600000);

  it('PG10 the fenced probe: the restore fence lines on a main answer replication and refuse the SQL session; after the lift, writable', async () => {
    const hba = run(['exec', '-u', 'root', MAIN, 'sh', '-c', `cp /var/lib/postgresql/data/pg_hba.conf /tmp/hba.keep && ${fenceHbaScript(true, 'nm5-pg')}`]);
    expect(hba.status, hba.err).toBe(0);
    ok(MAIN, 'SELECT pg_reload_conf();');
    untilHba('the fence lines are loaded', () => !loopbackOpen(), 30);
    const probe = await peerProbe(instance(), { ...code(), host: MAIN_IP, port: 5432 }, pem, 'pg10');
    expect(probe.kind, JSON.stringify(probe)).toBe('fenced');
    expect(run(['exec', '-u', 'root', MAIN, 'sh', '-c', 'cp /tmp/hba.keep /var/lib/postgresql/data/pg_hba.conf && chown postgres:postgres /var/lib/postgresql/data/pg_hba.conf && chmod 600 /var/lib/postgresql/data/pg_hba.conf']).status).toBe(0);
    ok(MAIN, 'SELECT pg_reload_conf();');
    untilHba('the kept lines are loaded', () => loopbackOpen(), 30);
    const lifted = await peerProbe(instance(), { ...code(), host: MAIN_IP, port: 5432 }, pem, 'pg10b');
    expect(lifted.kind, JSON.stringify(lifted)).toBe('writable');
  }, 300000);

  it('PG4 and PG5 the push: the replication role ensured NOLOGIN, a receive login over verify-full, drop, create and restore, counts and checksums equal, the commit as the manager role and its received rows; an expired login refused; the receive login ended and dropped', async () => {
    startPg(RECV, RECV_IP, RECV_VOL);
    tls(RECV);
    expect(await ensureManagerDbRole({ container: RECV, user: 'smdb' })).toEqual({ ok: true });
    // PG-2 (D59): the receiver never had the replication role; Receive makes it NOLOGIN before the push.
    expect(ok(RECV, "SELECT count(*) FROM pg_roles WHERE rolname = 'replicator'", 'postgres')).toBe('0');
    ok(RECV, replicationRoleEnsureSql('replicator'), 'postgres');
    ok(RECV, replicationRoleEnsureSql('replicator'), 'postgres');
    expect(ok(RECV, "SELECT rolcanlogin::text FROM pg_roles WHERE rolname = 'replicator'", 'postgres')).toBe('false');
    const until1 = new Date(Date.now() + 3600_000).toISOString();
    ok(RECV, `CREATE ROLE smdb_receive LOGIN SUPERUSER PASSWORD 'recvpw' VALID UNTIL '${until1}';`, 'postgres');
    ok(RECV, ensureGenerationSql('recv'));
    const oidBefore = ok(RECV, DB_OID_SQL('smdb'), 'postgres');
    expect(oidBefore).toMatch(/^\d+$/);
    expect(ok(COPY, "SELECT count(*) FROM information_schema.role_table_grants WHERE grantee = 'replicator'")).not.toBe('0');
    expect(run(['exec', COPY, 'pg_dump', '-U', 'smdb', '-Fc', '-f', '/tmp/push.dump', 'smdb']).status).toBe(0);
    expect(run(['cp', `${COPY}:/tmp/push.dump`, path.join(h.dir, 'push.dump')]).status).toBe(0);
    const dsn = (db: string) => `postgresql://smdb_receive@${RECV_IP}:5432/${db}?sslmode=verify-full&sslrootcert=/primary-ca.crt`;
    const script = `psql "$1" -v ON_ERROR_STOP=1 -c 'DROP DATABASE IF EXISTS "smdb" WITH (FORCE)' -c 'CREATE DATABASE "smdb" OWNER "smdb"' && pg_restore --exit-on-error --single-transaction -d "$2"`;
    const pushed = run(['run', '--rm', '-i', '--network', NET, '-e', 'PGPASSWORD', '-v', `${certFile}:/primary-ca.crt:ro`, '--entrypoint', 'sh', 'postgres:16-alpine', '-c', script, 'sh', dsn('postgres'), dsn('smdb')],
      fs.readFileSync(path.join(h.dir, 'push.dump')), { PGPASSWORD: 'recvpw' });
    expect(pushed.status, pushed.err).toBe(0);
    expect(ok(RECV, "SELECT rolcanlogin::text FROM pg_roles WHERE rolname = 'replicator'", 'postgres')).toBe('false');
    const oidAfter = ok(RECV, DB_OID_SQL('smdb'), 'postgres');
    expect(oidAfter).toMatch(/^\d+$/);
    expect(oidAfter).not.toBe(oidBefore);
    expect(pushBrokenOf(oidBefore, oidAfter, false)).toBe(true);
    expect(ok(RECV, DB_OID_SQL('nosuchdb'), 'postgres')).toBe('');
    expect(ok(RECV, "SELECT tableowner FROM pg_tables WHERE tablename = 't'")).toBe('smdb');
    const counts = (c: string) => { const p = parseCountLines(ok(c, COUNTS_SQL)); if (!p.ok) throw new Error(p.error); return p.counts; };
    expect(compareCounts(counts(COPY), counts(RECV)).ok).toBe(true);
    const sums = (c: string) => { const p = parseChecksumLines(ok(c, CHECKSUM_SQL)); if (!p.ok) throw new Error(p.error); return p.sums; };
    expect(compareChecksums(sums(COPY), sums(RECV)).ok).toBe(true);
    // P25 (D59): a pusher that never enabled replication sends neither table, so the commit creates them, as the manager role.
    ok(RECV, 'DROP TABLE IF EXISTS smdb_manager.addresses, smdb_manager.received;');
    const PUSH = '0123456789abcdef01234567';
    const PUSH2 = 'fedcba9876543210fedcba98';
    const commitOf = (id: string, g: number) => `SET ROLE ${MANAGER_DB_ROLE};\n${raiseSql('recv', g, `${addressTableSql(RECV_IP, 5432, pem.trim(), 'recv', null)}
DELETE FROM smdb_manager.addresses WHERE NOT (host = '${RECV_IP}' AND port = 5432);
INSERT INTO smdb_manager.received (push_id, from_system_id, from_machine, generation) VALUES ('${id}', '1', 'copy', ${g}) ON CONFLICT (push_id) DO NOTHING;
`)}`;
    const asReceive = (sql: string) => run(['run', '--rm', '--network', NET, '-e', 'PGPASSWORD', '-v', `${certFile}:/primary-ca.crt:ro`, '--entrypoint', 'psql', 'postgres:16-alpine', dsn('smdb'), '-v', 'ON_ERROR_STOP=1', '-tAq', '-c', sql], undefined, { PGPASSWORD: 'recvpw' });
    for (const [id, g] of [[PUSH, 4], [PUSH, 4], [PUSH2, 5]] as const) {
      const c = asReceive(commitOf(id, g));
      expect(c.status, c.err).toBe(0);
    }
    expect(ok(RECV, 'SELECT count(*) FROM smdb_manager.received')).toBe('2');
    expect(ok(RECV, `SELECT count(*) FROM smdb_manager.received WHERE push_id = '${PUSH}'`)).toBe('1');
    expect(ok(RECV, RECEIVED_OF_SQL([PUSH]))).toBe('copy|4');
    expect(ok(RECV, RECEIVED_OF_SQL(['ffffffffffffffffffffffff', PUSH2]))).toBe('copy|5');
    expect(ok(RECV, RECEIVED_OF_SQL(['ffffffffffffffffffffffff']))).toBe('');
    expect(ok(RECV, "SELECT count(*) FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname = 'smdb_receive'")).toBe('0');
    expect(ok(RECV, "SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.relname = 'received'")).toBe(MANAGER_DB_ROLE);
    expect(pushBrokenOf(oidBefore, oidAfter, true)).toBe(false);
    ok(RECV, `ALTER ROLE smdb_receive VALID UNTIL '${new Date(Date.now() - 60_000).toISOString()}';`, 'postgres');
    const expired = run(['run', '--rm', '--network', NET, '-e', 'PGPASSWORD', '-v', `${certFile}:/primary-ca.crt:ro`, '--entrypoint', 'psql', 'postgres:16-alpine', dsn('postgres'), '-c', 'SELECT 1'], undefined, { PGPASSWORD: 'recvpw' });
    expect(expired.status).not.toBe(0);
    expect(expired.err).toMatch(/password authentication failed|28P01|28000/);
    // PG5 (D54): a session held open, NOLOGIN refuses a new one, the round ends it and reads 0 left, then the drop.
    ok(RECV, `ALTER ROLE smdb_receive VALID UNTIL '${until1}';`, 'postgres');
    const recvLogin = (sql: string, detach = false) => run(['exec', ...(detach ? ['-d'] : []), '-e', 'PGPASSWORD=recvpw', RECV, 'psql', '-X', '-h', '127.0.0.1', '-U', 'smdb_receive', '-d', 'postgres', '-tAc', sql]);
    expect(recvLogin('SELECT pg_sleep(600)', true).status).toBe(0);
    until('the receive session runs', () => ok(RECV, "SELECT count(*) FROM pg_stat_activity WHERE usename = 'smdb_receive'", 'postgres') === '1');
    ok(RECV, RECEIVE_NOLOGIN_SQL, 'postgres');
    const refused = recvLogin('SELECT 1');
    expect(refused.status).not.toBe(0);
    expect(refused.err).toMatch(/is not permitted to log in/);
    expect(ok(RECV, RECEIVE_END_SQL, 'postgres').split('\n').pop()).toBe('0');
    ok(RECV, RECEIVE_DROP_SQL, 'postgres');
    expect(ok(RECV, "SELECT count(*) FROM pg_roles WHERE rolname = 'smdb_receive'", 'postgres')).toBe('0');
  }, 900000);

  it('PG13 a restore into a cluster that never had the replication role: step 7 ensures it NOLOGIN in the exempt session, the dump restores, the role logs in only after Enable', async () => {
    startPg(R13, R13_IP, R13_VOL);
    expect(await ensureManagerDbRole({ container: R13, user: 'smdb' })).toEqual({ ok: true });
    expect(ok(R13, "SELECT count(*) FROM pg_roles WHERE rolname = 'replicator'", 'postgres')).toBe('0');
    expect(run(['exec', '-u', 'root', R13, 'sh', '-c', 'printf "host replication all 127.0.0.1/32 trust\\n" >> /var/lib/postgresql/data/pg_hba.conf']).status).toBe(0);
    expect(ok(MAIN, "SELECT count(*) FROM information_schema.role_table_grants WHERE grantee = 'replicator'")).not.toBe('0');
    expect(run(['exec', MAIN, 'pg_dump', '-U', 'smdb', '-Fc', '-f', '/tmp/pg13.dump', 'smdb']).status).toBe(0);
    expect(run(['cp', `${MAIN}:/tmp/pg13.dump`, path.join(h.dir, 'pg13.dump')]).status).toBe(0);
    ok(R13, 'ALTER SYSTEM SET default_transaction_read_only = on;', 'postgres');
    ok(R13, 'SELECT pg_reload_conf();', 'postgres');
    until('the read-only setting is loaded', () => ok(R13, 'SHOW default_transaction_read_only', 'postgres') === 'on', 30);
    const EXEMPT = ['-e', 'PGOPTIONS=-c default_transaction_read_only=off'];
    const recreate = run(['exec', ...EXEMPT, R13, 'psql', '-X', '-U', 'smdb', '-d', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1',
      '-c', replicationRoleEnsureSql('replicator'), '-c', 'DROP DATABASE IF EXISTS "smdb" WITH (FORCE)', '-c', 'CREATE DATABASE "smdb" OWNER "smdb"']);
    expect(recreate.status, recreate.err).toBe(0);
    const restored = run(['exec', '-i', ...EXEMPT, R13, 'pg_restore', '-U', 'smdb', '--exit-on-error', '-d', 'smdb'], fs.readFileSync(path.join(h.dir, 'pg13.dump')));
    expect(restored.status, restored.err).toBe(0);
    expect(ok(R13, "SELECT rolcanlogin::text FROM pg_roles WHERE rolname = 'replicator'", 'postgres')).toBe('false');
    const tcp = () => run(['exec', '-e', 'PGPASSWORD=r13pw', R13, 'psql', '-X', '-h', '127.0.0.1', '-U', 'replicator', '-d', 'smdb', '-tAc', 'SELECT 1']);
    const replication = () => run(['exec', '-e', 'PGPASSWORD=r13pw', R13, 'psql', '-X', '-d', 'host=127.0.0.1 user=replicator dbname=smdb replication=database', '-c', 'IDENTIFY_SYSTEM']);
    for (const r of [tcp(), replication()]) {
      expect(r.status).not.toBe(0);
      expect(r.err).toMatch(/is not permitted to log in/);
    }
    const enable = run(['exec', ...EXEMPT, R13, 'psql', '-X', '-U', 'smdb', '-d', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1', '-c', "ALTER ROLE replicator WITH REPLICATION LOGIN PASSWORD 'r13pw'"]);
    expect(enable.status, enable.err).toBe(0);
    const after = tcp();
    expect(after.status, after.err).toBe(0);
  }, 600000);

  // PG1, PG6 and PG7 on a second main and its copy, so the rows above keep their own: the planned move, the old main
  // rebuilt as a copy of the new one, then the unplanned take-over when that new main is killed.
  describe('the planned move, the stale-primary rejoin and the unplanned take-over', () => {
    const M2 = `${ID}-m2`;
    const C2 = `${ID}-c2`;
    const M2B = `${ID}-m2b`;
    const M2_VOL = `${ID}-m2-data`;
    const C2_VOL = `${ID}-c2-data`;
    const M2B_VOL = `${ID}-m2b-data`;
    const M2_IP = `10.214.${OCTET}.20`;
    const C2_IP = `10.214.${OCTET}.21`;
    const M2B_IP = `10.214.${OCTET}.22`;
    const plainDsn = (ip: string) => `postgresql://replicator@${ip}:5432/smdb?sslmode=disable`;
    const seedFrom = (ip: string, vol: string, slot: string) => {
      const seed = run(['run', '--rm', '--network', NET, '-e', 'PGPASSWORD', '-v', `${vol}:/var/lib/postgresql/data`, '--entrypoint', 'pg_basebackup', 'postgres:16-alpine',
        '-d', plainDsn(ip), '-D', '/var/lib/postgresql/data', '-X', 'stream', '-R', '-S', slot, '--checkpoint=fast'], undefined, { PGPASSWORD: REPL_PW });
      expect(seed.status, seed.err).toBe(0);
      expect(run(['run', '--rm', '-v', `${vol}:/d`, 'postgres:16-alpine', 'chown', '-R', 'postgres:postgres', '/d']).status).toBe(0);
    };
    const startCopy = (name: string, ip: string, vol: string) => {
      const r = run(['run', '-d', '--name', name, '--network', NET, '--ip', ip, '-v', `${vol}:/var/lib/postgresql/data`, 'postgres:16-alpine']);
      expect(r.status, r.err).toBe(0);
      waitReady(name);
    };
    const streaming = (main: string) => ok(main, "SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming'");
    let g = 0;

    beforeAll(() => {
      startPg(M2, M2_IP, M2_VOL);
      expect(run(['exec', '-u', 'root', M2, 'sh', '-c', 'printf "host replication all 0.0.0.0/0 scram-sha-256\\n" >> /var/lib/postgresql/data/pg_hba.conf']).status).toBe(0);
      ok(M2, 'SELECT pg_reload_conf();');
      ok(M2, `CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '${REPL_PW}'; CREATE ROLE bot LOGIN PASSWORD '${BOT_PW}'; GRANT CONNECT ON DATABASE smdb TO bot;`);
      ok(M2, ensureGenerationSql('m2'));
      ok(M2, 'CREATE TABLE public.t (id int PRIMARY KEY, v text); INSERT INTO public.t SELECT g, md5(g::text) FROM generate_series(1, 50) g;');
      ok(M2, "SELECT pg_create_physical_replication_slot('nm5pg_c2');");
      seedFrom(M2_IP, C2_VOL, 'nm5pg_c2');
      startCopy(C2, C2_IP, C2_VOL);
      until('the copy streams', () => streaming(M2) === '1');
      g = genOf(M2)!.generation;
    }, 900000);
    afterAll(() => {
      for (const c of [M2, C2, M2B]) run(['rm', '-f', '-v', c]);
      for (const v of [M2_VOL, C2_VOL, M2B_VOL]) run(['volume', 'rm', '-f', v]);
    }, 300000);

    it("PG1 the planned move: the row and L reach the copy, the main's fast shutdown sends its last WAL, the promoted copy keeps the bot NOLOGIN", () => {
      ok(M2, 'ALTER ROLE bot NOLOGIN;');
      expect(ok(M2, "SELECT count(*) FROM pg_stat_activity WHERE usename = 'bot'")).toBe('0');
      const L = ok(M2, `BEGIN;\n${GENERATION_SCHEMA_SQL}\nDELETE FROM smdb_manager.handover;\nINSERT INTO smdb_manager.handover (slot, machine, generation) VALUES ('nm5pg_c2', 'c2', ${g + 1});\nCOMMIT;\nSELECT pg_current_wal_lsn();`).split('\n').pop()!;
      expect(L).toMatch(/^[0-9A-F]+\/[0-9A-F]+$/);
      until('the copy replays L', () => psql(C2, `SELECT pg_last_wal_replay_lsn() >= '${L}'::pg_lsn`).out === 't');
      expect(run(['stop', M2]).status).toBe(0);
      expect(ok(C2, 'SELECT slot || \'|\' || generation FROM smdb_manager.handover')).toBe(`nm5pg_c2|${g + 1}`);
      until('the copy replays all it received', () => psql(C2, 'SELECT pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn()').out === 't');
      expect(ok(C2, 'SELECT pg_promote(true, 60);')).toBe('t');
      ok(C2, raiseSql('c2', g + 1));
      expect(genOf(C2)).toMatchObject({ generation: g + 1, machine: 'c2' });
      expect(ok(C2, 'SELECT count(*) FROM smdb_manager.handover')).toBe('0');
      expect(ok(C2, "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'bot'")).toBe('f');
      expect(ok(C2, 'SELECT count(*) FROM public.t')).toBe('50');
    }, 600000);

    it('PG6 the old main reads the same system id and a lower timeline than the new main, and a seed from the new main streams', () => {
      expect(run(['start', M2]).status).toBe(0);
      waitReady(M2);
      const identity = 'SELECT (SELECT system_identifier FROM pg_control_system()), (SELECT timeline_id FROM pg_control_checkpoint())';
      const [oldId, oldTl] = ok(M2, identity).split('|');
      const ident = run(['run', '--rm', '--network', NET, '-e', 'PGPASSWORD', '--entrypoint', 'psql', 'postgres:16-alpine', `${plainDsn(C2_IP)}&replication=true`, '-Atc', 'IDENTIFY_SYSTEM'], undefined, { PGPASSWORD: REPL_PW });
      expect(ident.status, ident.err).toBe(0);
      const [newId, newTl] = ident.out.split('|');
      expect(newId).toBe(oldId);
      expect(Number(newTl)).toBeGreaterThan(Number(oldTl));
      expect(run(['rm', '-f', '-v', M2]).status).toBe(0);
      ok(C2, "SELECT pg_create_physical_replication_slot('nm5pg_m2b');");
      seedFrom(C2_IP, M2B_VOL, 'nm5pg_m2b');
      startCopy(M2B, M2B_IP, M2B_VOL);
      until('the rebuilt old main streams from the new main', () => streaming(C2) === '1');
      until('the raised row reaches it', () => genOf(M2B)?.generation === g + 1);
    }, 900000);

    it('PG7 the unplanned take-over: the main killed, the last replay time read on the copy, then promote and raise', () => {
      ok(C2, 'INSERT INTO public.t VALUES (51, \'last\');');
      until('the last write reaches the copy', () => psql(M2B, 'SELECT count(*) FROM public.t').out === '51');
      expect(run(['kill', C2]).status).toBe(0);
      expect(ok(M2B, 'SELECT pg_last_xact_replay_timestamp() IS NOT NULL')).toBe('t');
      expect(ok(M2B, 'SELECT pg_is_in_recovery()')).toBe('t');
      expect(ok(M2B, 'SELECT pg_promote(true, 60);')).toBe('t');
      ok(M2B, raiseSql('m2b', g + 2));
      expect(genOf(M2B)).toMatchObject({ generation: g + 2, machine: 'm2b' });
    }, 600000);
  });
});
