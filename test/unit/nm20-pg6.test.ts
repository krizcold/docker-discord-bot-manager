import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// NM20 part 6: the push between two provisioned clusters through pushMain, and the receiver's end through
// receiveStep and stopReceiving (R9's PG11, S12, Y3 with Z2, Z1). Skipped on Windows and without docker; the main
// session runs it on Linux. The client containers mount files from DATA_DIR (the probe certificate and the restore
// list), so the runner's temp folder must be visible to the docker host, as nm3-pg and nm5-pg need.
const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm20-pg6-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/instance/maintenance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/maintenance')>()),
  requireMaintenance: async () => ({ ok: true, state: 'maintenance', enforcement: 'database', botConfirmed: true, held: { state: 'yes' } }),
}));
vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  appContainerRunning: async () => false,
}));

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { certFingerprint, encodeMoveCode } from '../../src/config/joinCode';
import * as containerManager from '../../src/docker/containerManager';
import { provisionRoles } from '../../src/instance/dbLogin';
import { pushMain, receiveLoginsSql, receiveStep, stopReceiving } from '../../src/instance/fleetMove';
import { copyGroupEnsureSql, DB_OID_SQL, ensureGenerationSql, raiseSql } from '../../src/instance/switchSql';
import { type Cluster, docker, dockerRuns, provisionedCluster } from './pg-cluster';

const ID = `nm20pg6${process.pid}`;
const NET = `${ID}-net`;
const SEND = `${ID}-send`;
const RECV = `${ID}-recv`;
const U = 'smdb';
const DB = 'smdb';
const PW = 'nm20-pg6-bot-password';
const PORT = 20000 + ((process.pid + 7) % 20000);
const PUSH_ID = '0123456789abcdef01234567';
const PUSH_ID2 = '0123456789abcdef01234568';
const SETTLED = { state: 'maintenance', message: 'Back soon', orderedAt: '2026-11-13T00:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: 'maintenance', held: { state: 'yes' } };
const OFF = { state: 'off', message: '', orderedAt: '2026-11-13T00:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: 'maintenance' };

const ok = (r: { status: number | null; out: string; err: string }) => {
  expect(r.status, r.err).toBe(0);
  return r.out;
};

// The bot's own objects on the sender, as the bot role makes them (S12, Z2). planted_log is UNLOGGED, so COUNTS_SQL
// and CHECKSUM_SQL (permanent tables only) leave out the rows the planted code writes on the receiver.
const BOT_SQL = `CREATE SCHEMA smdb_data;
CREATE UNLOGGED TABLE smdb_data.planted_log (object text NOT NULL, su text NOT NULL, cu text NOT NULL);
CREATE FUNCTION smdb_data.plant(obj text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN INSERT INTO smdb_data.planted_log VALUES (obj, session_user, current_user); RETURN true; END $$;
CREATE TABLE smdb_data.checked (x int CHECK (smdb_data.plant('check')));
-- C3 (fix 5b): the bot role owns the row type, so it may cast it; CHECKSUM_SQL's t::text calls this on both machines.
CREATE FUNCTION smdb_data.checked_text(c smdb_data.checked) RETURNS text LANGUAGE plpgsql AS $$
BEGIN PERFORM smdb_data.plant('cast'); RETURN c.x::text; END $$;
CREATE CAST (smdb_data.checked AS text) WITH FUNCTION smdb_data.checked_text(smdb_data.checked);
CREATE TABLE smdb_data.shard_claims (shard int PRIMARY KEY, expires_up_ms bigint NOT NULL);
CREATE TABLE smdb_data.claim_clock (id int PRIMARY KEY, up_ms bigint NOT NULL);
CREATE FUNCTION smdb_data.on_shard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM smdb_data.plant('trigger');
  -- C4 (fix 5b): with smdb_test.fail_last on the receive login, the cap leaves it a table and a read-only default,
  -- so the push's last step (smdb_receive's REASSIGN OWNED and PASSWORD NULL) fails.
  IF current_setting('smdb_test.fail_last', true) = 'on' THEN
    CREATE TABLE IF NOT EXISTS smdb_data.recv_owned (x int);
    EXECUTE 'ALTER ROLE smdb_receive SET default_transaction_read_only = on';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER planted AFTER UPDATE ON smdb_data.shard_claims FOR EACH ROW EXECUTE FUNCTION smdb_data.on_shard();
-- Z2: on the receiver, as smdb_receive, a grant to that login, then RESET ROLE and a default ACL it defines.
CREATE FUNCTION smdb_data.leave() RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  IF session_user = 'smdb_receive' THEN
    EXECUTE 'GRANT SELECT ON smdb_data.checked TO smdb_receive';
    RESET ROLE;
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE smdb_receive GRANT SELECT ON TABLES TO PUBLIC';
    PERFORM smdb_data.plant('leave');
  END IF;
  RETURN true;
END $$;
-- Named to sort last: pg_dump writes the data blocks by name, and the RESET ROLE lasts for the rest of the session.
CREATE TABLE smdb_data.zz_left (x int CHECK (smdb_data.leave()));
INSERT INTO smdb_data.checked VALUES (1);
INSERT INTO smdb_data.shard_claims VALUES (1, 9000);
INSERT INTO smdb_data.claim_clock VALUES (1, 100);
INSERT INTO smdb_data.zz_left VALUES (1);
DELETE FROM smdb_data.planted_log;`;

describe.skipIf(process.platform === 'win32' || !dockerRuns)('NM20 part 6: the push and the receiver\'s end against a real Postgres 16 (Linux with docker)', () => {
  let send: Cluster;
  let recv: Cluster;
  let gateway = '';
  let pem = '';
  const certFile = path.join(h.dir, 'server.crt');
  const admin = (c: Cluster, sql: string, db = 'postgres') => ok(c.psql('dbm_admin', sql, db));
  const publishOf = (port: number) => (process.env.SMDB_PG_PUBLISH === 'all' ? `${port}:5432` : `${gateway}:${port}:5432`);
  const record = (container: string, over: Record<string, unknown> = {}) => ({
    containerName: container, user: U, db: DB, volume: `${container}-data`, password: PW, image: 'postgres:16-alpine', ...over,
  });
  const bot = (id: string, fleetDb: Record<string, unknown>, maintenance: Record<string, unknown>) => ({
    id, displayName: `NM20 ${id}`, sanitizedName: `${ID}-${id}`, sourceUrl: 'https://example.invalid/fake/app', status: 'stopped',
    createdAt: '2026-11-13T00:00:00.000Z', updatedAt: '2026-11-13T00:00:00.000Z', containerIds: [], fleetDb, fleetBackup: { enabled: false, hour: 4, keep: 7 }, maintenance,
  });
  const register = (receive: Record<string, unknown>) => {
    fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances: {
      snd: bot('snd', record(SEND), SETTLED),
      rcv: bot('rcv', record(RECV, { receive }), OFF),
    } }));
  };
  const receiving = (password: string, metaPassword: string, pushId = PUSH_ID) => {
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    admin(recv, receiveLoginsSql(U, password, metaPassword, expiresAt));
    ok(recv.psql('dbm_meta', ensureGenerationSql('rcv.example'), DB));
    const dbOid = admin(recv, DB_OID_SQL(DB));
    register({ startedAt: new Date().toISOString(), expiresAt, safetyDump: 'none.dump', pushId, priorIds: [], dbOid, copies: [] });
  };
  const logins = () => admin(recv, "SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname IN ('smdb_receive', 'smdb_receive_meta')");

  beforeAll(async () => {
    gateway = docker(['network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}']).out;
    expect(gateway).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    const gen = spawnSync('openssl', ['req', '-new', '-x509', '-days', '30', '-nodes', '-newkey', 'rsa:2048', '-subj', `/CN=${RECV}`,
      '-addext', `subjectAltName=DNS:${RECV},IP:${gateway}`, '-keyout', path.join(h.dir, 'server.key'), '-out', certFile], { encoding: 'utf-8' });
    expect(gen.status, gen.stderr).toBe(0);
    pem = fs.readFileSync(certFile, 'utf-8');
    docker(['network', 'create', NET]);
    send = await provisionedCluster({ name: SEND, user: U, db: DB, password: PW, network: NET });
    recv = await provisionedCluster({ name: RECV, user: U, db: DB, password: PW, network: NET, dockerArgs: ['-p', publishOf(PORT)] });
    for (const f of ['server.crt', 'server.key']) ok(docker(['cp', path.join(h.dir, f), `${RECV}:/var/lib/postgresql/data/${f}`]));
    ok(docker(['exec', '-u', 'root', RECV, 'sh', '-c', 'chown postgres:postgres /var/lib/postgresql/data/server.* && chmod 600 /var/lib/postgresql/data/server.key && printf "hostssl all all 0.0.0.0/0 scram-sha-256\\n" >> /var/lib/postgresql/data/pg_hba.conf']));
    admin(recv, 'ALTER SYSTEM SET ssl = on;');
    admin(recv, 'SELECT pg_reload_conf();');
    admin(recv, copyGroupEnsureSql());
    ok(send.psql(U, BOT_SQL, DB));
    ok(send.psql('dbm_meta', ensureGenerationSql('snd.example'), DB));
  }, 900000);

  afterAll(() => {
    send?.remove();
    recv?.remove();
    docker(['network', 'rm', NET]);
    fs.rmSync(h.dir, { recursive: true, force: true });
  }, 300000);

  it.each([
    ['ALLOW_CONNECTIONS false', (c: Cluster) => ok(c.psql(U, `ALTER DATABASE ${DB} ALLOW_CONNECTIONS false`, 'postgres'))],
    ['CONNECTION LIMIT 0', (c: Cluster) => ok(c.psql(U, `ALTER DATABASE ${DB} CONNECTION LIMIT 0`, 'postgres'))],
    ['a read-only default on smdb_receive', (c: Cluster) => ok(c.psql('smdb_receive', 'ALTER ROLE smdb_receive SET default_transaction_read_only = on', 'postgres'))],
  ])('Z1 with %s planted, the first Stop receiving drops both logins and what they own', async (_n, plant) => {
    receiving('z1-receive-pw', 'z1-meta-pw');
    ok(recv.psql('smdb_receive', 'CREATE TABLE public.z1_owned (x int);', DB));
    plant(recv);
    const r = await stopReceiving('rcv');
    expect(r, JSON.stringify(r)).toMatchObject({ success: true });
    expect(logins()).toBe('0');
    expect(admin(recv, `SELECT datallowconn::text || '|' || datconnlimit FROM pg_catalog.pg_database WHERE datname = '${DB}'`)).toBe('true|-1');
    expect(admin(recv, "SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE relname = 'z1_owned'", DB)).toBe(U);
    admin(recv, 'DROP TABLE public.z1_owned;', DB);
  }, 300000);

  it.each([
    ['succeeds', false, PUSH_ID],
    ['fails (C4, fix 5b)', true, PUSH_ID2],
  ] as const)('PG11, S12, Y3 with Z2: the push runs each step as its login; its last step %s; the receiver keeps Invariant A, and finishReceive drops both logins', async (_n, failLast, pushId) => {
    receiving(`pg11-receive-pw-${pushId}`, `pg11-meta-pw-${pushId}`, pushId);
    // The first row left the receiver at generation 2; the sender is raised above it so the push is not refused.
    if (failLast) ok(send.psql('dbm_meta', raiseSql('snd.example', 3), DB));
    if (failLast) admin(recv, "ALTER ROLE smdb_receive SET smdb_test.fail_last = 'on'");
    const code = encodeMoveCode({
      v: 1, host: gateway, port: PORT, db: DB, fp: certFingerprint(pem), machine: 'rcv.example',
      repl: { user: 'replicator', password: 'unused' }, app: { user: U, password: PW },
      recv: { user: 'smdb_receive', password: `pg11-receive-pw-${pushId}`, id: pushId }, recvMeta: { user: 'smdb_receive_meta', password: `pg11-meta-pw-${pushId}` },
    });
    const warn = vi.spyOn(console, 'warn');
    const pushed = await pushMain('snd', code, true);
    const warnings = warn.mock.calls.map(c => String(c[0]));
    console.log(`[nm20-pg6] the push answered: ${JSON.stringify(pushed)}\n[nm20-pg6] warnings: ${JSON.stringify(warnings)}`);
    warn.mockRestore();
    expect(pushed.success, pushed.text).toBe(true);

    // Z2: the push committed: the received row and the raised generation.
    expect(admin(recv, `SELECT count(*) FROM smdb_manager.received WHERE push_id = '${pushId}'`, DB)).toBe('1');
    expect(Number(admin(recv, 'SELECT generation FROM smdb_manager.generation', DB))).toBeGreaterThanOrEqual(2);
    const log = admin(recv, "SELECT object || '|' || su || '|' || cu FROM smdb_data.planted_log ORDER BY 1", DB).split('\n');
    console.log(`[nm20-pg6] planted_log on the receiver:\n${log.join('\n')}`);
    expect(log).toContain(`check|smdb_receive|${U}`);
    expect(log).toContain('trigger|smdb_receive|smdb_receive');
    expect(log).toContain('leave|smdb_receive|smdb_receive');
    // C3: the cast through the receiver's checksum read as smdb_receive, and through the sender's checksumsOf as dbm_work.
    expect(log).toContain('cast|smdb_receive|smdb_receive');
    const sent = admin(send, "SELECT DISTINCT object || '|' || su || '|' || cu FROM smdb_data.planted_log WHERE object = 'cast'", DB);
    console.log(`[nm20-pg6] the cast rows of planted_log on the sender:\n${sent}`);
    expect(sent).toBe('cast|dbm_work|dbm_work');
    // W6, S3: smdb_manager and every table in it are dbm_meta's; the bot role is plain.
    expect(admin(recv, "SELECT pg_catalog.pg_get_userbyid(nspowner) FROM pg_catalog.pg_namespace WHERE nspname = 'smdb_manager'", DB)).toBe('dbm_meta');
    expect(admin(recv, "SELECT DISTINCT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE relnamespace = 'smdb_manager'::regnamespace AND relkind = 'r'", DB)).toBe('dbm_meta');
    expect(admin(recv, `SELECT rolsuper::text FROM pg_catalog.pg_roles WHERE rolname = '${U}'`)).toBe('false');
    const owned = "SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE relname = 'recv_owned'";
    const password = "SELECT (rolpassword IS NULL)::text FROM pg_catalog.pg_authid WHERE rolname = 'smdb_receive'";
    if (!failLast) {
      // The bot's tables stay the bot role's; the last step: smdb_receive has no password once the commit is in.
      expect(admin(recv, "SELECT DISTINCT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE relnamespace = 'smdb_data'::regnamespace AND relkind = 'r'", DB)).toBe(U);
      expect(admin(recv, password)).toBe('true');
    } else {
      // Y3, ruling 4: the failed last step is logged, smdb_receive keeps its password and what the cap made stays its.
      expect(warnings.filter(w => w.includes("the receive login's password could not be removed after the push"))).toHaveLength(1);
      expect(admin(recv, password)).toBe('false');
      expect(admin(recv, owned, DB)).toBe('smdb_receive');
    }

    await receiveStep(containerManager.getBot('rcv')!, Date.now());
    expect(logins()).toBe('0');
    expect(containerManager.getBot('rcv')!.fleetDb!.receive).toBeUndefined();
    if (failLast) expect(admin(recv, owned, DB)).toBe(U);
    expect(admin(recv, "SELECT DISTINCT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE relnamespace = 'smdb_data'::regnamespace AND relkind = 'r'", DB)).toBe(U);
    const again = await provisionRoles({ container: RECV, user: U, db: DB, botId: 'rcv', password: PW, candidates: [] }, { reread: true });
    expect(again, JSON.stringify(again)).toMatchObject({ ok: true, wrote: [] });
  }, 900000);
});
