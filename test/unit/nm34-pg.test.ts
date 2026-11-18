import { afterAll, describe, expect, it, vi } from 'vitest';

// NM34 against a real Postgres 16. Skipped on Windows and without docker; the main session runs it on Linux.
const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm34-pg-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import { spawn } from 'child_process';
import { ensureManagerDbRole, NO_ADMIN_ERROR, ownerReadArgs, resetManagerRoleCache } from '../../src/instance/dbLogin';
import { adminFailText, NO_ADMIN_OFF_REASON } from '../../src/instance/maintenance';
import { restoreStateUpsertSql } from '../../src/instance/switchSql';
import {
  generationRefusal, KEPT_TEXT, OWNER_CLUSTER_READ, ownerClusterRefusal, readOwnerCluster, readOwnerCopy, readOwnerGeneration,
} from '../../src/instance/keptData';
import { type Cluster, docker, dockerRuns, PG_IMAGE, startCluster } from './pg-cluster';

const ID = `nm34pg${process.pid}`;
const U = 'app';
const DB = 'app';
const PW = 'nm34-pg-bot-password';
const NO_ADMIN_STDERR = 'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  role "dbm_admin" does not exist';

const ok = (r: { status: number | null; out: string; err: string }) => {
  expect(r.status, r.err).toBe(0);
  return r.out;
};

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const record = (c: Cluster) => ({ containerName: c.name, user: c.user, db: c.db, volume: `${c.name}-data` });

/** A cluster as the pre-redesign manager made it (9434835 pcsProcessing.ts:1556-1579): POSTGRES_USER is the bot role, no command, no role added. */
function oldCluster(name: string, opts: { network?: string; image?: string } = {}): Cluster {
  return startCluster({ name, user: U, db: DB, password: PW, firstRole: U, serverArgs: [], ...(opts.network ? { network: opts.network } : {}), ...(opts.image ? { image: opts.image } : {}) });
}

/** The generation schema and raise as a manager built at 7985478 wrote them (nm31-pg's RAISE_7985478). */
const RAISE_7985478 = (target: number) => `BEGIN;
CREATE SCHEMA IF NOT EXISTS smdb_manager;
CREATE TABLE IF NOT EXISTS smdb_manager.generation (
  one_row boolean PRIMARY KEY DEFAULT true CHECK (one_row), machine text NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 1), since timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS smdb_manager.handover (
  one_row boolean PRIMARY KEY DEFAULT true CHECK (one_row), slot text NOT NULL, machine text NOT NULL,
  generation bigint NOT NULL, at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS smdb_manager.received (
  push_id text PRIMARY KEY, from_system_id text NOT NULL, from_machine text NOT NULL, generation bigint NOT NULL,
  at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS smdb_manager.copies (
  slot text PRIMARY KEY, machine text, client text, seen_at timestamptz NOT NULL DEFAULT now());
GRANT USAGE ON SCHEMA smdb_manager TO PUBLIC;
GRANT SELECT ON smdb_manager.generation TO PUBLIC;
INSERT INTO smdb_manager.generation AS g (one_row, machine, generation, since) VALUES (true, 'main.example', ${target}, now())
  ON CONFLICT (one_row) DO UPDATE SET machine = EXCLUDED.machine, generation = EXCLUDED.generation, since = now()
  WHERE g.generation < EXCLUDED.generation;
DELETE FROM smdb_manager.handover;
SELECT generation || '|' || machine || '|' || to_char(since AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') FROM smdb_manager.generation;
COMMIT;`;

/** A session of the bot role held open in the background for `seconds`; `env` goes to docker exec. */
function holdSession(c: Cluster, seconds: number, env: string[] = []): void {
  ok(docker(['exec', '-d', ...env.flatMap(e => ['-e', e]), c.name, 'psql', '-X', '-U', U, '-d', c.db, '-c', `SELECT pg_sleep(${seconds})`]));
  for (let i = 0; i < 40; i++) {
    const n = c.psql(U, `SELECT count(*) FROM pg_stat_activity WHERE usename = '${U}' AND query LIKE 'SELECT pg_sleep(${seconds})%'`, 'postgres', ['PGOPTIONS=-c role=none']).out;
    if (n === '1') return;
    pause(250);
  }
  throw new Error('the held session did not show in pg_stat_activity');
}

function endHeld(c: Cluster, seconds: number): void {
  ok(c.psql(U, `SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE usename = '${U}' AND query LIKE 'SELECT pg_sleep(${seconds})%' AND pid <> pg_backend_pid()`, 'postgres', ['PGOPTIONS=-c role=none']));
  for (let i = 0; i < 40; i++) {
    if (c.psql(U, `SELECT count(*) FROM pg_stat_activity WHERE usename = '${U}' AND query LIKE 'SELECT pg_sleep(${seconds})%' AND pid <> pg_backend_pid()`, 'postgres', ['PGOPTIONS=-c role=none']).out === '0') return;
    pause(250);
  }
  throw new Error('the held session did not end');
}

const catalogOf = (c: Cluster) => [
  ok(c.psql(U, 'SELECT string_agg(rolname, \',\' ORDER BY rolname) FROM pg_roles', 'postgres')),
  ok(c.psql(U, "SELECT coalesce(to_regnamespace('smdb_manager')::text, 'none')", 'postgres')),
  ok(c.psql(U, "SELECT coalesce(to_regnamespace('smdb_manager')::text, 'none')", DB)),
];

const clusters: Cluster[] = [];
afterAll(() => {
  for (const c of clusters) c.remove();
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32' || !dockerRuns)('NM34: the reads as the bot role on a cluster with no dbm_admin (Linux with docker)', () => {
  it('PG1: ensureManagerDbRole answers missing-role with NO_ADMIN_ERROR; psql\'s stderr is NO_ADMIN_STDERR; the Off\'s reason is adminFailText of it', async () => {
    const c = oldCluster(`${ID}-pg1`);
    clusters.push(c);
    resetManagerRoleCache();
    expect(await ensureManagerDbRole({ container: c.name, user: U })).toEqual({ ok: false, cls: 'missing-role', error: NO_ADMIN_ERROR });
    const r = docker(['exec', '-i', c.name, 'psql', '-U', 'dbm_admin', '-d', 'postgres', '-tA', '-c', 'SELECT 1']);
    expect(r.status).not.toBe(0);
    expect(r.err).toBe(NO_ADMIN_STDERR);
    expect(adminFailText(NO_ADMIN_ERROR)).toBe(NO_ADMIN_OFF_REASON);
  }, 240_000);

  it('PG2: S1 reads a superuser, no dbm_admin, no session, no restore record; S2 reads no table; A20-NA passes; the catalog reads the same after', async () => {
    const c = oldCluster(`${ID}-pg2`);
    clusters.push(c);
    const before = catalogOf(c);
    expect(await readOwnerCluster(c.name, U)).toMatchObject({ ok: true, read: { superuser: true, recovery: false, admin: 'missing', sessions: [0, 0], restore: null } });
    expect(await readOwnerGeneration(c.name, U, DB)).toEqual({ ok: true, row: null });
    expect(await generationRefusal(record(c), { noAdmin: true })).toBeNull();
    expect(catalogOf(c)).toEqual(before);
    expect(before[1]).toBe('none');
  }, 240_000);

  it('PG3: a session of the bot role held for the whole S1 reads 1 in both counts (T-A-NA-SESSIONS); once it ends, both read 0', async () => {
    const c = oldCluster(`${ID}-pg3`);
    clusters.push(c);
    holdSession(c, 60);
    const held = await readOwnerCluster(c.name, U);
    expect(held).toMatchObject({ ok: true, read: { superuser: true, sessions: [1, 1] } });
    expect(ownerClusterRefusal(U, held)).toBe(KEPT_TEXT.aNaSessions(U, 1, 1));
    endHeld(c, 60);
    const after = await readOwnerCluster(c.name, U);
    expect(after).toMatchObject({ ok: true, read: { sessions: [0, 0] } });
    expect(ownerClusterRefusal(U, after)).toBeNull();
  }, 240_000);

  it('PG4: generation 2 written as the bot role: S2 reads 2 and A20-NA answers T-A-GEN', async () => {
    const c = oldCluster(`${ID}-pg4`);
    clusters.push(c);
    ok(c.psql(U, RAISE_7985478(2)));
    expect(await readOwnerGeneration(c.name, U, DB)).toMatchObject({ ok: true, row: { generation: 2, machine: 'main.example' } });
    expect(await generationRefusal(record(c), { noAdmin: true })).toBe(KEPT_TEXT.aGen(2));
  }, 240_000);

  it('PG5: a restore floor of 2 written as the bot role in postgres: S1 reads floor 2 and A20-NA answers T-A-GEN', async () => {
    const c = oldCluster(`${ID}-pg5`);
    clusters.push(c);
    ok(c.psql(U, restoreStateUpsertSql('daily-2026-11-01T00-00-00-000Z.dump', { generation: 2, machine: 'main.example', since: null }), 'postgres'));
    const s1 = await readOwnerCluster(c.name, U);
    expect(s1).toMatchObject({ ok: true, read: { superuser: true, restore: { pending: true, floor: { generation: 2 } } } });
    expect(await generationRefusal(record(c), { noAdmin: true })).toBe(KEPT_TEXT.aGen(2));
  }, 240_000);

  it('PG6: on its own cluster, a write through ownerReadArgs is refused even with a role default of read-only off, and role=none keeps the login against a role setting', async () => {
    const c = oldCluster(`${ID}-pg6`);
    try {
      ok(c.psql(U, `ALTER ROLE "${U}" SET default_transaction_read_only = off`, 'postgres'));
      const w = docker(ownerReadArgs(c.name, U, DB), 'CREATE TABLE nm34_w (i int);');
      expect(w.status).toBe(3);
      expect(w.err).toContain('read-only transaction');
      expect(ok(c.psql(U, "SELECT coalesce(to_regclass('nm34_w')::text, 'null')"))).toBe('null');
      ok(c.psql(U, 'CREATE ROLE nm34_other NOLOGIN', 'postgres'));
      ok(c.psql(U, `ALTER ROLE "${U}" SET role = 'nm34_other'`, 'postgres'));
      expect(ok(c.psql(U, 'SELECT current_user'))).toBe('nm34_other');
      holdSession(c, 60, ['PGOPTIONS=-c role=none']);
      const s1 = await readOwnerCluster(c.name, U);
      expect(s1).toMatchObject({ ok: true, read: { superuser: true, sessions: [1, 1] } });
      expect(ownerClusterRefusal(U, s1)).toBe(KEPT_TEXT.aNaSessions(U, 1, 1));
    } finally {
      c.remove();
    }
  }, 240_000);

  it('PG7: a cluster whose bot role is a plain login: S1 as that role answers one line, f, and T-A-NA-NOTSUPER', async () => {
    const c = startCluster({ name: `${ID}-pg7`, user: U, db: DB, password: PW, firstRole: 'owner', serverArgs: [] });
    clusters.push(c);
    ok(c.psql('owner', `CREATE ROLE "${U}" LOGIN PASSWORD '${PW}'`, 'postgres'));
    ok(c.psql('owner', `ALTER DATABASE ${DB} OWNER TO "${U}"`, 'postgres'));
    expect(ok(docker(ownerReadArgs(c.name, U, 'postgres'), OWNER_CLUSTER_READ))).toBe('f');
    const s1 = await readOwnerCluster(c.name, U);
    expect(s1).toMatchObject({ ok: true, read: { superuser: false } });
    expect(ownerClusterRefusal(U, s1)).toBe(KEPT_TEXT.aNaNotSuper(U));
  }, 240_000);

  it('PG8: a pg_basebackup copy of the old cluster in recovery: S1 answers T-A-NA-STANDBY, S3 reads a superuser in recovery', async () => {
    const net = `${ID}-net8`;
    docker(['network', 'create', net]);
    const main = oldCluster(`${ID}-pg8main`, { network: net });
    const copyName = `${ID}-pg8copy`;
    const copyVolume = `${copyName}-data`;
    clusters.push(main, {
      name: copyName, user: U, db: DB, password: PW, psql: () => ({ status: 1, out: '', err: '' }),
      remove: () => { docker(['rm', '-f', copyName]); docker(['volume', 'rm', '-f', copyVolume]); docker(['network', 'rm', net]); },
    });
    ok(docker(['exec', main.name, 'sh', '-c', `echo "host replication ${U} samenet trust" >> "$PGDATA/pg_hba.conf"`]));
    ok(main.psql(U, 'SELECT pg_reload_conf()', 'postgres'));
    ok(docker(['run', '--rm', '--network', net, '-v', `${copyVolume}:/var/lib/postgresql/data`, '--entrypoint', 'pg_basebackup', PG_IMAGE,
      '-h', main.name, '-U', U, '-D', '/var/lib/postgresql/data', '-X', 'stream', '-R', '--checkpoint=fast'], undefined, 300000));
    ok(docker(['run', '-d', '--name', copyName, '--network', net, '-v', `${copyVolume}:/var/lib/postgresql/data`, PG_IMAGE, 'postgres']));
    let ready = false;
    for (let i = 0; i < 240 && !ready; i++) {
      ready = docker(['exec', copyName, 'pg_isready', '-h', '127.0.0.1', '-q']).status === 0;
      if (!ready) pause(500);
    }
    expect(ready).toBe(true);
    const s1 = await readOwnerCluster(copyName, U);
    expect(s1).toMatchObject({ ok: true, read: { superuser: true, recovery: true } });
    expect(ownerClusterRefusal(U, s1)).toBe(KEPT_TEXT.aNaStandby);
    expect(await readOwnerCopy(copyName, U)).toMatchObject({ ok: true, read: { superuser: true, recovery: true } });
  }, 600_000);

  it('PG9: a statement through ownerReadArgs is cancelled by the server\'s statement timeout within 25 s', async () => {
    const c = oldCluster(`${ID}-pg9`);
    clusters.push(c);
    const started = Date.now();
    const r = docker(ownerReadArgs(c.name, U, DB), 'SELECT pg_sleep(30);', 60000);
    expect(Date.now() - started).toBeLessThan(25000);
    expect(r.status).not.toBe(0);
    expect(r.err).toContain('canceling statement due to statement timeout');
  }, 240_000);

  it('PG11 (A1, code review 1): a superuser dbm_admin with NOLOGIN reads unusable (T-A-NA-ADMINPLAIN); with LOGIN it reads usable (T-A-NA-ADMIN)', async () => {
    const c = oldCluster(`${ID}-pg11`);
    clusters.push(c);
    ok(c.psql(U, 'CREATE ROLE dbm_admin SUPERUSER NOLOGIN', 'postgres'));
    const plain = await readOwnerCluster(c.name, U);
    expect(plain).toMatchObject({ ok: true, read: { superuser: true, recovery: false, admin: 'unusable' } });
    expect(ownerClusterRefusal(U, plain)).toBe(KEPT_TEXT.aNaAdminPlain);
    ok(c.psql(U, 'ALTER ROLE dbm_admin LOGIN', 'postgres'));
    const usable = await readOwnerCluster(c.name, U);
    expect(usable).toMatchObject({ ok: true, read: { superuser: true, recovery: false, admin: 'usable' } });
    expect(ownerClusterRefusal(U, usable)).toBe(KEPT_TEXT.aNaAdmin);
  }, 240_000);

  it('PG12 (A2, code review 1): on postgres:16.0-alpine, S1 and S2 as the bot role read what PG2 reads, and A20-NA passes', async () => {
    const c = oldCluster(`${ID}-pg12`, { image: 'postgres:16.0-alpine' });
    clusters.push(c);
    expect(ok(c.psql(U, 'SHOW server_version', 'postgres'))).toMatch(/^16[.]0([^0-9]|$)/);
    const before = catalogOf(c);
    expect(await readOwnerCluster(c.name, U)).toMatchObject({ ok: true, read: { superuser: true, recovery: false, admin: 'missing', sessions: [0, 0], restore: null } });
    expect(await readOwnerGeneration(c.name, U, DB)).toEqual({ ok: true, row: null });
    expect(await generationRefusal(record(c), { noAdmin: true })).toBeNull();
    expect(catalogOf(c)).toEqual(before);
  }, 600_000);

  for (const [label, input] of [['inside a transaction', 'BEGIN TRANSACTION READ ONLY;\nSELECT 1;\n'], ['outside a transaction', 'SELECT 1;\n']] as const) {
    it(`PG10 (${label}): a session from ownerReadArgs left with its input open is gone from pg_stat_activity within 15 s`, async () => {
      const c = oldCluster(`${ID}-pg10${label.startsWith('inside') ? 'a' : 'b'}`);
      clusters.push(c);
      const child = spawn('docker', ownerReadArgs(c.name, U, DB), { stdio: ['pipe', 'pipe', 'pipe'] });
      try {
        let out = '';
        child.stdout.on('data', d => { out += String(d); });
        child.stdin.write(`${input}SELECT pg_backend_pid();\n`);
        let pid = '';
        for (let i = 0; i < 40 && !pid; i++) {
          await new Promise(r => setTimeout(r, 250));
          pid = out.split('\n').map(l => l.trim()).filter(l => /^\d+$/.test(l) && l !== '1').pop() ?? '';
        }
        expect(pid).toMatch(/^\d+$/);
        const opened = Date.now();
        let gone = false;
        while (!gone && Date.now() - opened < 15000) {
          await new Promise(r => setTimeout(r, 1000));
          gone = ok(c.psql(U, `SELECT count(*) FROM pg_stat_activity WHERE pid = ${pid}`, 'postgres')) === '0';
        }
        expect(gone).toBe(true);
      } finally {
        child.kill('SIGKILL');
      }
    }, 240_000);
  }
});
