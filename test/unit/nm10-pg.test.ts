import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// NM10's database and docker cells against a real Postgres 16 and a real container. Skipped on Windows and without
// docker; the main session runs it.
const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm10-pg-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { blockBotLogin, endBotSessions, ensureManagerDbRole, MANAGER_DB_ROLE, openBotLogin, readBotLogin, sidecarRunning, sidecarState } from '../../src/instance/dbLogin';
import { fenceMigrateSource, liftMigrateFence } from '../../src/instance/fleetBackup';
import { readDatabaseUrl } from '../../src/config/databaseUrl';
import { ensureGenerationSql, GEN_READ_SQL, parseGenRow } from '../../src/instance/switchSql';
import { appContainerEnv, appContainerRunning, getBot } from '../../src/docker/containerManager';

const dockerRuns = (() => {
  try {
    return spawnSync('docker', ['version'], { stdio: 'ignore', timeout: 10000 }).status === 0;
  } catch {
    return false;
  }
})();

// Every container and volume is named here and removed by exact name.
const ID = `nm10pg${process.pid}`;
const PG = `${ID}-fleet-postgres`;
const PG_VOL = `${ID}-fleet-postgres-data`;
const APP = `${ID}-app`;
const NET = `${ID}-net`;
const OTHER = `${ID}-other`;
const LOOP = `${ID}-loop`;
const CRASH = `${ID}-crash`;
const FLEET_DB = { containerName: PG, user: 'smdb', db: 'smdb', volume: PG_VOL };

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const run = (args: string[], input?: string) => {
  const r = spawnSync('docker', args, { encoding: 'utf-8', timeout: 600000, input });
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
const ok = (sql: string) => {
  const r = run(['exec', '-i', PG, 'psql', '-X', '-U', 'smdb', '-d', 'smdb', '-tA', '-v', 'ON_ERROR_STOP=1'], sql);
  expect(r.status, r.err).toBe(0);
  return r.out;
};
const target = { container: PG, user: 'bot' };

describe.skipIf(process.platform === 'win32' || !dockerRuns)('NM10 against a real Postgres 16 and container (Linux with docker)', () => {
  beforeAll(() => {
    const n = run(['network', 'create', NET]);
    expect(n.status, n.err).toBe(0);
    const r = run(['run', '-d', '--name', PG, '--network', NET, '-v', `${PG_VOL}:/var/lib/postgresql/data`, '-e', 'POSTGRES_USER=smdb', '-e', 'POSTGRES_PASSWORD=pw', '-e', 'POSTGRES_DB=smdb', 'postgres:16-alpine']);
    expect(r.status, r.err).toBe(0);
    for (let i = 0; i < 240; i++) {
      if (run(['exec', PG, 'pg_isready', '-U', 'smdb', '-d', 'smdb']).status === 0) break;
      pause(500);
    }
    const a = run(['run', '-d', '--name', APP, '--network', NET, '--label', `com.docker.compose.project=${ID}`, '--label', 'com.docker.compose.service=app',
      '-e', 'DATA_BACKEND=postgres', '-e', 'DATA_BACKEND_URL=postgresql://smdb:pw@x-fleet-postgres:5432/smdb', '-e', 'OTHER=1', 'postgres:16-alpine', 'sleep', '600']);
    expect(a.status, a.err).toBe(0);
    expect(run(['network', 'connect', 'bridge', APP]).status).toBe(0);
    const o = run(['run', '-d', '--name', OTHER, '--network', NET, 'postgres:16-alpine', 'sleep', '600']);
    expect(o.status, o.err).toBe(0);
    fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances: {
      b1: { id: 'b1', displayName: 'B1', sanitizedName: ID, sourceUrl: 'x', status: 'running', containerIds: [], envVars: {}, createdAt: 'x', updatedAt: 'x', lastBuiltCommit: null, fleetDb: FLEET_DB },
      b9: { id: 'b9', displayName: 'B9', sanitizedName: `${ID}crash`, sourceUrl: 'x', status: 'running', containerIds: [], envVars: {}, createdAt: 'x', updatedAt: 'x', lastBuiltCommit: null },
    } }));
  }, 600_000);
  afterAll(() => {
    run(['rm', '-f', '-v', CRASH]);
    run(['rm', '-f', '-v', LOOP]);
    run(['rm', '-f', '-v', OTHER]);
    run(['rm', '-f', '-v', APP]);
    run(['rm', '-f', '-v', PG]);
    run(['volume', 'rm', '-f', PG_VOL]);
    run(['network', 'rm', NET]);
    fs.rmSync(h.dir, { recursive: true, force: true });
  });

  it('PG1 a new companion: its role and database answer, dbm_admin is made, and the generation row is written', async () => {
    expect(run(['exec', PG, 'pg_isready', '-U', 'smdb', '-d', 'smdb']).status).toBe(0);
    expect(await ensureManagerDbRole({ container: PG, user: 'smdb' })).toEqual({ ok: true });
    expect(ok(`SELECT rolname FROM pg_roles WHERE rolname = '${MANAGER_DB_ROLE}'`)).toBe(MANAGER_DB_ROLE);
    ok(ensureGenerationSql('machine-a'));
    expect(parseGenRow(ok(GEN_READ_SQL))).toMatchObject({ generation: 1, machine: 'machine-a' });
  });

  it('PG2 a blocked login opened by M3, a session of the role, then F4 blocks it with no session left', async () => {
    ok("CREATE ROLE bot LOGIN PASSWORD 'botpw'; ALTER ROLE bot NOLOGIN;");
    expect(await ensureManagerDbRole(target)).toEqual({ ok: true });
    const before = await readBotLogin(target);
    expect(before).toMatchObject({ ok: true, login: { canLogin: false } });
    expect(await openBotLogin(target)).toEqual({ ok: true });
    expect(await readBotLogin(target)).toMatchObject({ ok: true, login: { canLogin: true } });
    expect(run(['exec', '-d', '-e', 'PGPASSWORD=botpw', PG, 'psql', '-X', '-h', '127.0.0.1', '-U', 'bot', '-d', 'smdb', '-c', 'SELECT pg_sleep(120)']).status).toBe(0);
    for (let i = 0; i < 40; i++) {
      const r = await readBotLogin(target);
      if (r.ok && r.login.sessions > 0) break;
      pause(250);
    }
    expect(await blockBotLogin(target)).toEqual({ ok: true });
    expect(await endBotSessions(target, 500)).toEqual({ ok: true });
    expect(await readBotLogin(target)).toMatchObject({ ok: true, login: { canLogin: false, sessions: 0 } });
  });

  it('PG3 appContainerEnv reads the running container\'s env keys and leaves the others out', async () => {
    expect(await appContainerEnv('b1', ['DATA_BACKEND', 'DATA_BACKEND_URL', 'MISSING'])).toEqual({
      ok: true, env: { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: 'postgresql://smdb:pw@x-fleet-postgres:5432/smdb' },
    });
  });
  it("PG4 (W1) docker's restarting state: sidecarState reads restarting while sidecarRunning reads true, and exec is refused", async () => {
    const r = run(['run', '-d', '--name', LOOP, '--restart', 'always', 'alpine:3.20', 'sh', '-c', 'exit 1']);
    expect(r.status, r.err).toBe(0);
    try {
      let both = false;
      for (let i = 0; i < 60 && !both; i++) {
        const state = await sidecarState(LOOP);
        const running = await sidecarRunning(LOOP);
        both = state === 'restarting' && running === true;
        if (!both) pause(500);
      }
      expect(both).toBe(true);
      let refused = false;
      for (let i = 0; i < 60 && !refused; i++) {
        const e = run(['exec', LOOP, 'true']);
        refused = e.status !== 0 && /is restarting/.test(e.err);
        if (!refused) pause(250);
      }
      expect(refused).toBe(true);
    } finally {
      run(['rm', '-f', '-v', LOOP]);
    }
  }, 120_000);

  const hbaText = () => run(['exec', PG, 'cat', '/var/lib/postgresql/data/pg_hba.conf']).out;
  const ownerLines = (owner: string) => hbaText().split('\n').filter(l => l.endsWith(`# smdb-fence-owner=${owner} # smdb-write-fence`));
  const otherLogin = () => run(['exec', '-e', 'PGPASSWORD=pw', OTHER, 'psql', '-X', '-h', PG, '-U', 'smdb', '-d', 'smdb', '-tAc', 'SELECT 1']);
  const appAddresses = () => run(['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}', APP]).out.split(/\s+/).filter(Boolean);

  it('PG5 (D96) the fence on a real Postgres 16: other sessions end and other logins are refused, the bot and the manager pass, a renewal keeps the count, the lift reopens', async () => {
    expect(await ensureManagerDbRole({ container: PG, user: 'smdb' })).toEqual({ ok: true });
    ok("ALTER SYSTEM SET authentication_timeout = '1s'");
    ok('SELECT pg_reload_conf()');
    expect(run(['exec', '-d', '-e', 'PGPASSWORD=pw', '-e', 'PGAPPNAME=other-idle', OTHER, 'psql', '-X', '-h', PG, '-U', 'smdb', '-d', 'smdb', '-c', 'SELECT pg_sleep(120)']).status).toBe(0);
    let seen = false;
    for (let i = 0; i < 40 && !seen; i++) {
      seen = ok("SELECT count(*) FROM pg_stat_activity WHERE application_name = 'other-idle'") !== '0';
      if (!seen) pause(250);
    }
    expect(seen).toBe(true);
    try {
      ok("CREATE ROLE nm10other LOGIN PASSWORD 'pw'");
      ok('GRANT CONNECT ON DATABASE smdb TO nm10other');
      expect(run(['exec', '-d', '-e', 'PGPASSWORD=pw', '-e', 'PGAPPNAME=other-role', OTHER, 'psql', '-X', '-h', PG, '-U', 'nm10other', '-d', 'smdb', '-c', 'SELECT pg_sleep(120)']).status).toBe(0);
      let roleSeen = false;
      for (let i = 0; i < 40 && !roleSeen; i++) {
        roleSeen = ok("SELECT count(*) FROM pg_stat_activity WHERE application_name = 'other-role'") !== '0';
        if (!roleSeen) pause(250);
      }
      expect(roleSeen).toBe(true);
      expect(await fenceMigrateSource(getBot('b1')!, 'migrate:1')).toBeNull();
      expect(ok("SELECT count(*) FROM pg_stat_activity WHERE application_name = 'other-idle'")).toBe('1');
      expect(ok("SELECT count(*) FROM pg_stat_activity WHERE application_name = 'other-role'")).toBe('0');
      const roleLogin = run(['exec', '-e', 'PGPASSWORD=pw', OTHER, 'psql', '-X', '-h', PG, '-U', 'nm10other', '-d', 'smdb', '-tAc', 'SELECT 1']);
      expect(roleLogin.status).not.toBe(0);
      expect(roleLogin.err).toMatch(/pg_hba.conf rejects connection/);
      expect(await fenceMigrateSource(getBot('b1')!, 'migrate:1', { refresh: true })).toBeNull();
      expect(ok("SELECT count(*) FROM pg_stat_activity WHERE application_name = 'other-idle'")).toBe('1');
      ok("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'other-idle'");
    } finally {
      for (let i = 0; i < 40; i++) {
        if (ok("SELECT count(*) FROM pg_stat_activity WHERE usename = 'nm10other'") === '0') break;
        pause(250);
      }
      ok('DROP OWNED BY nm10other');
      ok('DROP ROLE IF EXISTS nm10other');
    }
    const refused = otherLogin();
    expect(refused.status).not.toBe(0);
    expect(refused.err).toMatch(/pg_hba.conf rejects connection/);
    const app = run(['exec', '-e', 'PGPASSWORD=pw', APP, 'psql', '-X', '-h', PG, '-U', 'smdb', '-d', 'smdb', '-tAc', 'SELECT 1']);
    expect(app.out, app.err).toBe('1');
    const mgr = run(['exec', PG, 'psql', '-X', '-U', MANAGER_DB_ROLE, '-d', 'postgres', '-tAc', 'SELECT 1']);
    expect(mgr.out, mgr.err).toBe('1');
    const addrs = appAddresses();
    expect(addrs.length).toBe(2);
    const lines = ownerLines('migrate:1');
    for (const a of addrs) expect(lines).toContain(`host all all ${a}/32 scram-sha-256 # smdb-fence-owner=migrate:1 # smdb-write-fence`);
    expect(lines).toContain('host replication all all reject # smdb-fence-owner=migrate:1 # smdb-write-fence');
    expect(lines).toContain('host all all all reject # smdb-fence-owner=migrate:1 # smdb-write-fence');
    expect(lines).toHaveLength(4);
    expect(await fenceMigrateSource(getBot('b1')!, 'migrate:1', { refresh: true })).toBeNull();
    expect(ownerLines('migrate:1')).toHaveLength(4);
    expect(await liftMigrateFence(FLEET_DB, 'migrate:1')).toEqual({ result: 'lifted' });
    expect(ownerLines('migrate:1')).toHaveLength(0);
    let back = false;
    for (let i = 0; i < 40 && !back; i++) {
      back = otherLogin().out === '1';
      if (!back) pause(250);
    }
    expect(back).toBe(true);
  }, 120_000);

  it('PG9 (B40) a crash loop reads as running: docker shows it restarting, and appContainerRunning answers true', async () => {
    const r = run(['run', '-d', '--name', CRASH, '--label', `com.docker.compose.project=${ID}crash`, '--label', 'com.docker.compose.service=app', '--restart', 'always', 'alpine:3.20', 'sh', '-c', 'exit 1']);
    expect(r.status, r.err).toBe(0);
    try {
      let both = false;
      for (let i = 0; i < 60 && !both; i++) {
        const state = await sidecarState(CRASH);
        both = state === 'restarting' && await appContainerRunning('b9') === true;
        if (!both) pause(500);
      }
      expect(both).toBe(true);
    } finally {
      run(['rm', '-f', '-v', CRASH]);
    }
  }, 120_000);

  it("PG6 (D100) another owner's line: the fence refuses with its owner, writes nothing of its own, and the row removes that line", async () => {
    const line = 'host all all all reject # smdb-fence-owner=restore:5 # smdb-write-fence';
    const f = '/var/lib/postgresql/data/pg_hba.conf';
    expect(run(['exec', '-u', 'root', PG, 'sh', '-c', `{ printf '%s\\n' '${line}'; cat ${f}; } > ${f}.new && chown postgres:postgres ${f}.new && chmod 600 ${f}.new && mv -f ${f}.new ${f}`]).status).toBe(0);
    ok('SELECT pg_reload_conf()');
    try {
      expect(await fenceMigrateSource(getBot('b1')!, 'migrate:2')).toMatch(/a write fence of a restore \(started 1970-01-01 00:00 UTC\) stands in its pg_hba\.conf/);
      expect(ownerLines('restore:5')).toEqual([line]);
      expect(ownerLines('migrate:2')).toHaveLength(0);
    } finally {
      run(['exec', '-u', 'root', PG, 'sh', '-c', `sed -i '/smdb-fence-owner=restore:5 # smdb-write-fence$/d' ${f}`]);
      ok('SELECT pg_reload_conf()');
    }
    expect(ownerLines('restore:5')).toHaveLength(0);
  }, 120_000);

  it('PG8 (B39) an enabled subscription: the fence refuses before any write, and writes once the subscription is gone', async () => {
    const sql = (text: string) => {
      const r = run(['exec', PG, 'psql', '-U', 'smdb', '-d', 'smdb', '-c', text]);
      expect(r.status, r.err).toBe(0);
    };
    try {
      sql("CREATE SUBSCRIPTION nm10s CONNECTION 'host=127.0.0.1 port=1 dbname=none' PUBLICATION nm10p WITH (connect = false, enabled = false, create_slot = false, slot_name = 'nm10s')");
      sql('ALTER SUBSCRIPTION nm10s ENABLE');
      expect(await fenceMigrateSource(getBot('b1')!, 'migrate:3')).toBe('the database has 1 enabled subscription(s), whose workers write past the fence; disable them (ALTER SUBSCRIPTION ... DISABLE) and retry');
      expect(ownerLines('migrate:3')).toHaveLength(0);
      sql('ALTER SUBSCRIPTION nm10s DISABLE');
      sql('ALTER SUBSCRIPTION nm10s SET (slot_name = NONE)');
      sql('DROP SUBSCRIPTION nm10s');
      expect(await fenceMigrateSource(getBot('b1')!, 'migrate:3')).toBeNull();
      expect(ownerLines('migrate:3').length).toBeGreaterThan(0);
      expect(await liftMigrateFence(FLEET_DB, 'migrate:3')).toEqual({ result: 'lifted' });
    } finally {
      run(['exec', PG, 'psql', '-U', 'smdb', '-d', 'smdb', '-c', 'ALTER SUBSCRIPTION nm10s DISABLE']);
      run(['exec', PG, 'psql', '-U', 'smdb', '-d', 'smdb', '-c', 'ALTER SUBSCRIPTION nm10s SET (slot_name = NONE)']);
      run(['exec', PG, 'psql', '-U', 'smdb', '-d', 'smdb', '-c', 'DROP SUBSCRIPTION IF EXISTS nm10s']);
    }
  }, 120_000);

  const botModules = process.env.SMDB_BOT_NODE_MODULES;
  it.skipIf(!botModules)("PG7 (B-5) the bot's pg-connection-string reads each value as D106 records, and the six readable ones as readDatabaseUrl does", () => {
    const values: Array<[string, [string | null, string | null, string | null]]> = [
      ['postgresql://smdb:pw@b1-fleet-postgres:5432/smdb', ['b1-fleet-postgres', '5432', 'smdb']],
      ['POSTGRESQL://u:p@Db.Example.Test:5432/app#frag', ['Db.Example.Test', '5432', 'app']],
      ['postgresql://u:p w@db.example.test:5432/app', ['db.example.test', '5432', 'app']],
      ['postgresql://u:p%zz@db.example.test:5432/app', ['db.example.test', '5432', 'app']],
      ['postgresql://u:p@db.example.test/app', ['db.example.test', '', 'app']],
      ['postgresql://u:p@[::1]:5433/db', ['[::1]', '5433', 'db']],
      ['postgresql://u:p@db.example.test:5432/app?host=s1-fleet-postgres', ['s1-fleet-postgres', '5432', 'app']],
      ['postgresql://u:p@db.example.test:5432/app?hostaddr=10.0.0.1', ['db.example.test', '5432', 'app']],
      ['postgresql://u:p@pub.example:5432/x?port=5433', ['pub.example', '5433', 'x']],
      ['postgresql://a:b@h1:5432/smdb?sslmode=x,postgresql://a:b@h2:5432/smdb&host=s1', ['s1', '5432', 'smdb']],
      ['postgresql://u:p@s1%2Dfleet%2Dpostgres:5432/app', ['s1-fleet-postgres', '5432', 'app']],
      ['postgresql://u:p@h1,h2:5432/db', ['h1,h2', '5432', 'db']],
      ['postgresql:///smdb', ['', '', 'smdb']],
      ['postgresql://u:p@db.example.test:5432', ['db.example.test', '5432', null]],
      ['postgresql://u:p@db.example.test:5432/', ['db.example.test', '5432', null]],
      ['postgresql://u:p@db.example.test:5432/smdb/', ['db.example.test', '5432', 'smdb/']],
      ['postgresql://u:p@db.example.test:5432/a%2Cb', ['db.example.test', '5432', 'a%2Cb']],
      ['postgresql://u:p@/smdb?host=s1-fleet-postgres', ['s1-fleet-postgres', '', 'smdb']],
      ['mysql://u:p@s1-fleet-postgres:5432/smdb', ['s1-fleet-postgres', '5432', 'smdb']],
      ['//s1-fleet-postgres:5432/smdb', ['//s1-fleet-postgres:5432/smdb', null, null]],
      ['s1-fleet-postgres:5432/smdb', ['', '', '432/smdb']],
    ];
    const script = `const pcs = require('/x/node_modules/pg-connection-string'); const parse = pcs.parse || pcs;
      for (const v of JSON.parse(process.argv[1])) { const c = parse(v); const s = (x) => (x === undefined || x === null ? null : String(x)); console.log(JSON.stringify([s(c.host), s(c.port), s(c.database)])); }`;
    const r = run(['run', '--rm', '-v', `${botModules}:/x/node_modules:ro`, 'node:22-alpine', 'node', '-e', script, JSON.stringify(values.map(v => v[0]))]);
    expect(r.status, r.err).toBe(0);
    const read = r.out.split('\n').map(l => JSON.parse(l));
    expect(read).toHaveLength(values.length);
    values.forEach(([value, expected], i) => expect(read[i], value).toEqual(expected));
    for (const [value, [host, port, db]] of values.slice(0, 6)) {
      const first = readDatabaseUrl(value, {}).addresses[0];
      expect(first, value).toBeTruthy();
      expect([first.host, String(first.port), first.db], value).toEqual([host!.toLowerCase().replace(/^\[|\]$/g, ''), port || '5432', db]);
    }
  }, 600_000);
});
