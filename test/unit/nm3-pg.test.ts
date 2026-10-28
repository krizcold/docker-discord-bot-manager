import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm3-pg-'));
  // HOST_DATA_DIR stays unset, so the host path a probe mounts is this process's own path.
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, startCopy: (() => ({ success: false, error: 'not set' })) as () => { success: boolean; error?: string } };
});

// The compose service calls of a rebuild, which need a deployed compose project: here they remove and start the copy's
// container by its exact name.
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  const { spawnSync: sync } = require('child_process') as typeof import('child_process');
  return {
    ...real,
    markPendingApplyIfRunning: async () => undefined,
    removeFleetDbReplicaService: async (_id: string, name: string) => {
      const r = sync('docker', ['rm', '-f', '-v', name], { encoding: 'utf-8', timeout: 120000 });
      return r.status === 0 ? { success: true } : { success: false, error: r.stderr || 'docker rm failed' };
    },
    applyFleetDbReplicaService: async () => h.startCopy(),
  };
});

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { certFingerprint, encodeJoinCode, lsnToBigInt } from '../../src/config/joinCode';
import * as containerManager from '../../src/docker/containerManager';
import { ensureManagerDbRole } from '../../src/instance/dbLogin';
import { addressTableSql } from '../../src/instance/fleetReplication';
import { addressUpsertSql, fetchMainCertificate, mainProbe, readAddresses, readCopyFacts } from '../../src/instance/fleetJoin';
import { rebuildVerdict, runFleetCopyTick, VerdictCopy, VerdictMain } from '../../src/instance/fleetCopyWatch';
import { InstanceConfig } from '../../src/types';

const dockerRuns = (() => {
  try {
    return spawnSync('docker', ['version'], { stdio: 'ignore', timeout: 10000 }).status === 0;
  } catch {
    return false;
  }
})();

// Every container, volume and network is named here and removed by exact name.
const ID = `nm3pg${process.pid}`;
const NET = `${ID}-net`;
const MAIN = `${ID}-main`;
const COPY = `${ID}-copy`;
const COPY2 = `${ID}-copy2`;
const COPY_VOL = `${ID}-copy-data`;
const COPY2_VOL = `${ID}-copy2-data`;
const SUBNET_OCTET = 100 + (process.pid % 100);
const SUBNET = `10.213.${SUBNET_OCTET}.0/24`;
const MAIN_IP = `10.213.${SUBNET_OCTET}.10`;
// The main's port published on the default bridge's gateway, where the manager's own clients (run without a network)
// reach it.
const PORT = 20000 + (process.pid % 20000);
const REPL_PW = 'replpass';
const APP_PW = 'app-pw';
const SLOT = 'fleet_standby_nm3pg';
const SLOT2 = 'fleet_standby_nm3pg2';
const SLOT_UNRESERVED = 'fleet_standby_nm3pg3';
const BOT = 'pgb';

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const run = (args: string[], input?: string, env?: NodeJS.ProcessEnv) => {
  const r = spawnSync('docker', args, { encoding: 'utf-8', timeout: 600000, input, env: env ? { ...process.env, ...env } : process.env });
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
const psql = (container: string, sql: string, user = 'smdb', db = 'smdb') =>
  run(['exec', '-i', container, 'psql', '-X', '-U', user, '-d', db, '-tA', '-v', 'ON_ERROR_STOP=1'], sql);
const waitReady = (container: string) => {
  for (let i = 0; i < 240; i++) {
    if (run(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-q']).status === 0) return;
    pause(500);
  }
  throw new Error(`${container} did not become ready`);
};
/** A libpq client on the test network, as the manager runs one: the password from the environment, the main's certificate mounted. */
const client = (certFile: string, script: string, ...args: string[]) =>
  run(['run', '--rm', '--network', NET, '-e', 'PGPASSWORD', '-v', `${certFile}:/primary-ca.crt:ro`, '--entrypoint', 'sh', 'postgres:16-alpine', '-c', script, 'sh', ...args], undefined, { PGPASSWORD: REPL_PW });
const replDsn = (host: string) => `postgresql://replicator@${host}:5432/smdb?sslmode=verify-full&sslrootcert=/primary-ca.crt`;

describe.skipIf(process.platform === 'win32' || !dockerRuns)('NM3 the join code against a real Postgres 16 (Linux with docker)', () => {
  let certFile = '';
  let pem = '';
  let gateway = '';
  const code = () => ({
    v: 1 as const, host: gateway, port: PORT, db: 'smdb', fp: certFingerprint(pem), machine: 'main',
    repl: { user: 'replicator', password: REPL_PW }, app: { user: 'smdb', password: APP_PW },
  });
  const copyRecord = { containerName: COPY, volume: COPY_VOL, slot: SLOT, primaryHost: MAIN, primaryPort: 5432, certHost: COPY, user: 'smdb', db: 'smdb', seededAt: 1 };
  const instance = (): InstanceConfig => containerManager.getBot(BOT)!;
  const copyVerdict = async (container: string): Promise<VerdictCopy> => {
    const r = await readCopyFacts({ containerName: container, user: 'smdb', db: 'smdb' });
    return r.ok ? { answered: true, ...r.facts } : { answered: false, reason: r.reason };
  };

  beforeAll(async () => {
    gateway = run(['network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}']).out;
    expect(gateway).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    certFile = path.join(h.dir, 'server.crt');
    const keyFile = path.join(h.dir, 'server.key');
    const gen = spawnSync('openssl', ['req', '-new', '-x509', '-days', '30', '-nodes', '-newkey', 'rsa:2048', '-subj', `/CN=${MAIN}`,
      '-addext', `subjectAltName=DNS:${MAIN},IP:${MAIN_IP},IP:${gateway}`, '-keyout', keyFile, '-out', certFile], { encoding: 'utf-8' });
    expect(gen.status, gen.stderr).toBe(0);
    pem = fs.readFileSync(certFile, 'utf-8');
    expect(run(['network', 'create', '--subnet', SUBNET, NET]).status).toBe(0);
    // Docker Desktop cannot bind a published port on the bridge gateway; all interfaces still reach it there.
    const publish = process.env.SMDB_PG_PUBLISH === 'all' ? `${PORT}:5432` : `${gateway}:${PORT}:5432`;
    const started = run(['run', '-d', '--name', MAIN, '--network', NET, '--ip', MAIN_IP, '-p', publish,
      '-e', 'POSTGRES_USER=smdb', '-e', `POSTGRES_PASSWORD=${APP_PW}`, '-e', 'POSTGRES_DB=smdb',
      'postgres:16-alpine', '-c', 'max_slot_wal_keep_size=64MB', '-c', 'max_wal_size=64MB', '-c', 'min_wal_size=32MB']);
    expect(started.status, started.err).toBe(0);
    waitReady(MAIN);
    for (const f of ['server.crt', 'server.key']) expect(run(['cp', path.join(h.dir, f), `${MAIN}:/var/lib/postgresql/data/${f}`]).status).toBe(0);
    expect(run(['exec', '-u', 'root', MAIN, 'sh', '-c', 'chown postgres:postgres /var/lib/postgresql/data/server.* && chmod 600 /var/lib/postgresql/data/server.key && printf "hostssl replication all 0.0.0.0/0 scram-sha-256\\nhostssl all all 0.0.0.0/0 scram-sha-256\\n" >> /var/lib/postgresql/data/pg_hba.conf']).status).toBe(0);
    expect(psql(MAIN, 'ALTER SYSTEM SET ssl = on;').status).toBe(0);
    expect(psql(MAIN, 'SELECT pg_reload_conf();').status).toBe(0);
    expect(psql(MAIN, `CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '${REPL_PW}';`).status).toBe(0);
    // NM1's manager role, made on the main before any copy is seeded, so every copy has it.
    expect(await ensureManagerDbRole({ container: MAIN, user: 'smdb' })).toEqual({ ok: true });
    const table = psql(MAIN, addressTableSql(MAIN_IP, 5432, pem.trim(), 'main', null));
    expect(table.status, table.err).toBe(0);
    fs.mkdirSync(path.join(h.dir, 'bots', BOT, 'env'), { recursive: true });
    fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances: { [BOT]: {
      id: BOT, sanitizedName: `${ID}b`, displayName: 'PGB', titleName: 'PGB', status: 'stopped', sourceType: 'git',
      sourceUrl: 'https://example.invalid/fake/super-modular-discord-bot', envVars: { DATA_BACKEND: 'postgres' },
      createdAt: '2026-10-27T00:00:00.000Z', updatedAt: '2026-10-27T00:00:00.000Z',
      fleetJoin: { code: encodeJoinCode(code()), host: gateway, port: PORT, db: 'smdb', fp: certFingerprint(pem), machine: 'main', joinedAt: '2026-10-27T00:00:00.000Z', addresses: [], addressesReadAt: Date.now() },
      fleetDbReplica: copyRecord,
    } } }, null, 2));
    h.startCopy = () => {
      const r = run(['run', '-d', '--name', COPY, '-v', `${COPY_VOL}:/var/lib/postgresql/data`, 'postgres:16-alpine']);
      return r.status === 0 ? { success: true } : { success: false, error: r.err };
    };
  }, 600000);

  afterAll(() => {
    for (const c of [MAIN, COPY, COPY2]) run(['rm', '-f', '-v', c]);
    for (const v of [COPY_VOL, COPY2_VOL]) run(['volume', 'rm', v]);
    run(['network', 'rm', NET]);
    fs.rmSync(h.dir, { recursive: true, force: true });
  }, 300000);

  it('L4-1 the replication login runs IDENTIFY_SYSTEM and reads the slots over verify-full, and the handshake fingerprint is server.crt\'s', async () => {
    const shown = await fetchMainCertificate(MAIN_IP, 5432);
    expect(shown).toMatchObject({ ok: true, fp: certFingerprint(pem) });
    const r = client(certFile, 'psql "$1&replication=true" -Atc IDENTIFY_SYSTEM && psql "$1" -v ON_ERROR_STOP=1 -Atc "SELECT count(*) FROM pg_replication_slots"', replDsn(MAIN));
    expect(r.status, r.err).toBe(0);
    expect(r.out.split('\n')[0]).toMatch(/^\d+\|1\|[0-9A-F]+\/[0-9A-F]+\|/);
  }, 300000);

  it('L4-7 mainProbe reads a slot made without reserving WAL, never used, as kept, and a missing one as absent', async () => {
    expect(psql(MAIN, `SELECT pg_create_physical_replication_slot('${SLOT_UNRESERVED}');`).status).toBe(0);
    expect(await mainProbe(instance(), code(), pem, SLOT_UNRESERVED)).toMatchObject({ ok: true, facts: { inRecovery: false, timeline: 1, slot: 'kept' } });
    expect(await mainProbe(instance(), code(), pem, 'fleet_standby_none')).toMatchObject({ ok: true, facts: { slot: 'absent' } });
    expect(psql(MAIN, `SELECT pg_drop_replication_slot('${SLOT_UNRESERVED}');`).status).toBe(0);
  }, 300000);

  it('L4-3 the granted replication login upserts and deletes rows, and the table reaches a copy', () => {
    const cert = pem.trim();
    const up = client(certFile, 'psql "$1" -v ON_ERROR_STOP=1 -Atc "$2"', replDsn(MAIN), addressUpsertSql({ host: 'gone.invalid', port: 1, slot: null, cert, machine: 'gone' }));
    expect(up.status, up.err).toBe(0);
    const del = client(certFile, 'psql "$1" -v ON_ERROR_STOP=1 -Atc "$2"', replDsn(MAIN), "DELETE FROM smdb_manager.addresses WHERE host = 'gone.invalid' AND port = 1;");
    expect(del.status, del.err).toBe(0);
    const reg = client(certFile, 'psql "$1" -v ON_ERROR_STOP=1 -Atc "$2"', replDsn(MAIN), addressUpsertSql({ host: 'copy.invalid', port: 15433, slot: SLOT, cert, machine: 'copy' }));
    expect(reg.status, reg.err).toBe(0);
    expect(psql(MAIN, `SELECT pg_create_physical_replication_slot('${SLOT}');`).status).toBe(0);
    const seed = run(['run', '--rm', '--network', NET, '-e', 'PGPASSWORD', '-v', `${COPY_VOL}:/var/lib/postgresql/data`, '-v', `${certFile}:/primary-ca.crt:ro`,
      '--entrypoint', 'pg_basebackup', 'postgres:16-alpine', '-d', replDsn(MAIN), '-D', '/var/lib/postgresql/data', '-X', 'stream', '-R', '-S', SLOT, '--checkpoint=fast'], undefined, { PGPASSWORD: REPL_PW });
    expect(seed.status, seed.err).toBe(0);
    expect(run(['run', '--rm', '-v', `${COPY_VOL}:/d`, 'postgres:16-alpine', 'chown', '-R', 'postgres:postgres', '/d']).status).toBe(0);
    expect(run(['run', '-d', '--name', COPY, '--network', NET, '-v', `${COPY_VOL}:/var/lib/postgresql/data`, '-v', `${certFile}:/primary-ca.crt:ro`, 'postgres:16-alpine']).status).toBe(0);
    waitReady(COPY);
    let rows = '';
    for (let i = 0; i < 60 && rows !== '1'; i++) {
      rows = psql(COPY, "SELECT count(*) FROM smdb_manager.addresses WHERE slot = 'fleet_standby_nm3pg';").out;
      if (rows !== '1') pause(500);
    }
    expect(rows).toBe('1');
    expect(psql(MAIN, "SELECT count(*) FROM smdb_manager.addresses a WHERE a.slot IS NULL OR EXISTS (SELECT 1 FROM pg_replication_slots s WHERE s.slot_name = a.slot);").out).toBe('2');
  }, 600000);

  it('L4-8 the manager\'s own readers: readCopyFacts as dbm_admin, mainProbe and readAddresses through the published port', async () => {
    let copy: VerdictCopy = { answered: false, reason: 'not read' };
    for (let i = 0; i < 60; i++) {
      copy = await copyVerdict(COPY);
      if (copy.answered && copy.streaming) break;
      await wait(500);
    }
    expect(copy).toMatchObject({ answered: true, inRecovery: true, streaming: true, timeline: 1 });
    const probe = await mainProbe(instance(), code(), pem, SLOT);
    expect(probe).toMatchObject({ ok: true, facts: { inRecovery: false, timeline: 1, slot: 'active' } });
    if (probe.ok && copy.answered) expect(probe.facts.systemId).toBe(copy.systemId);
    const noSlot = client(certFile, 'psql "$1" -v ON_ERROR_STOP=1 -Atc "$2"', replDsn(MAIN), addressUpsertSql({ host: 'noslot.invalid', port: 2, slot: 'fleet_standby_noslot', cert: pem.trim(), machine: 'x' }));
    expect(noSlot.status, noSlot.err).toBe(0);
    const listed = await readAddresses(instance(), code(), pem);
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.addresses.map(a => `${a.host}|${a.slot}`).sort()).toEqual([`${MAIN_IP}|null`, `copy.invalid|${SLOT}`].sort());
    expect(psql(MAIN, "DELETE FROM smdb_manager.addresses WHERE host = 'noslot.invalid';").status).toBe(0);
  }, 300000);

  it('L4-2 a stopped copy whose slot passed the bound reads lost through the manager\'s readers, does not stream again, and the verdict is a rebuild', async () => {
    expect(run(['stop', COPY]).status).toBe(0);
    for (let i = 0; i < 40; i++) {
      expect(psql(MAIN, 'CREATE TABLE IF NOT EXISTS nm3_fill (x text); INSERT INTO nm3_fill SELECT repeat(md5(random()::text), 64) FROM generate_series(1, 5000); SELECT pg_switch_wal();').status).toBe(0);
    }
    expect(psql(MAIN, 'CHECKPOINT;').status).toBe(0);
    let state = '';
    for (let i = 0; i < 60 && state !== 'lost'; i++) {
      state = psql(MAIN, `SELECT wal_status FROM pg_replication_slots WHERE slot_name = '${SLOT}';`).out;
      if (state !== 'lost') { psql(MAIN, 'SELECT pg_switch_wal(); CHECKPOINT;'); pause(500); }
    }
    expect(state).toBe('lost');
    expect(run(['start', COPY]).status).toBe(0);
    waitReady(COPY);
    await wait(5000);
    const copy = await copyVerdict(COPY);
    expect(copy).toMatchObject({ answered: true, inRecovery: true, streaming: false });
    const probe = await mainProbe(instance(), code(), pem, SLOT);
    expect(probe).toMatchObject({ ok: true, facts: { inRecovery: false, slot: 'lost' } });
    const main: VerdictMain = probe.ok ? { answered: true, ...probe.facts } : { answered: false, reason: probe.reason };
    const verdict = rebuildVerdict({ copyCleared: false, heldAt: null, busy: null, parked: null, joinedSystemId: null, host: gateway, port: PORT }, copy, main, Date.now());
    expect(verdict).toEqual({ kind: 'rebuild', slot: 'lost' });
  }, 900000);

  it('L4-4 pg_dump of the hot standby whose slot is lost succeeds', () => {
    const dump = run(['exec', COPY, 'pg_dump', '-U', 'smdb', '-Fc', '-f', '/tmp/nm3.dump', 'smdb']);
    expect(dump.status, dump.err).toBe(0);
  }, 300000);

  it('L4-9 the watcher rebuilds that copy end to end: safety dump, wipe, seed, and the copy streams again', async () => {
    await runFleetCopyTick(Date.now());
    let bot = containerManager.getBot(BOT)!;
    for (let i = 0; i < 600 && (bot.fleetDbReplicaSeed || !bot.fleetCopyAlerts?.rebuilt); i++) {
      await wait(1000);
      bot = containerManager.getBot(BOT)!;
    }
    expect(bot.fleetDbReplicaSeed).toBeUndefined();
    expect(bot.fleetDbReplica).toMatchObject({ containerName: COPY, slot: SLOT, primaryHost: gateway, primaryPort: PORT });
    expect(bot.fleetDbReplica?.copyCleared).toBeUndefined();
    expect(bot.fleetDbReplica?.rebuildDumps).toHaveLength(1);
    expect(bot.fleetCopyAlerts?.rebuilt?.text).toMatch(/ A backup of the old copy is kept on that machine as copy-pre-rebuild-[0-9TZ-]+\.dump\.$/);
    let copy: VerdictCopy = { answered: false, reason: 'not read' };
    for (let i = 0; i < 120; i++) {
      copy = await copyVerdict(COPY);
      if (copy.answered && copy.streaming) break;
      await wait(1000);
    }
    expect(copy).toMatchObject({ answered: true, inRecovery: true, streaming: true });
    expect(await mainProbe(instance(), code(), pem, SLOT)).toMatchObject({ ok: true, facts: { slot: 'active' } });
    expect(psql(COPY, 'SELECT count(*) > 0 FROM nm3_fill;').out).toBe('t');
  }, 1200000);

  const botModules = process.env.SMDB_BOT_NODE_MODULES;
  const pgRun = (script: string, host: string) => run(['run', '--rm', '--network', NET, '-v', `${botModules}:/x/node_modules:ro`, '-v', `${certFile}:/certs/main.crt:ro`, 'node:22-alpine', 'node', '-e', script, host]);
  const pgDsn = `'postgresql://smdb:${APP_PW}@' + host + ':5432/smdb?sslmode=verify-full&sslrootcert=/certs/main.crt'`;
  const pgTail = `await c.connect(); const r = await c.query('SELECT 1 AS one'); console.log(host, r.rows[0].one); await c.end(); })().catch(e => { console.error(e.message); process.exit(1); });`;
  it.skipIf(!botModules)('L4-5a node-postgres (the bot\'s) connects from the connection string alone by DNS name with verify-full and sslrootcert', () => {
    const script = `const { Client } = require('/x/node_modules/pg'); const host = process.argv[1];
      (async () => { const c = new Client({ connectionString: ${pgDsn} }); ${pgTail}`;
    const r = pgRun(script, MAIN);
    expect(r.status, r.err).toBe(0);
    expect(r.out).toBe(`${MAIN} 1`);
  }, 600000);
  it.skipIf(!botModules)('L4-5b by IP the connection string alone is refused on the altnames; ssl.host set to the IP connects', () => {
    const bare = `const { Client } = require('/x/node_modules/pg'); const host = process.argv[1];
      (async () => { const c = new Client({ connectionString: ${pgDsn} }); ${pgTail}`;
    const refused = pgRun(bare, MAIN_IP);
    expect(refused.status).not.toBe(0);
    expect(refused.err).toMatch(/does not match certificate's altnames/);
    const withHost = `const { Client } = require('/x/node_modules/pg'); const pcs = require('/x/node_modules/pg-connection-string');
      const parse = pcs.parse || pcs; const host = process.argv[1];
      (async () => { const cfg = parse(${pgDsn}); cfg.ssl = { ...cfg.ssl, host }; const c = new Client(cfg); ${pgTail}`;
    const r = pgRun(withHost, MAIN_IP);
    expect(r.status, r.err).toBe(0);
    expect(r.out).toBe(`${MAIN_IP} 1`);
  }, 600000);

  it('L4-6 a copy of the old timeline, judged against a promoted database\'s IDENTIFY_SYSTEM, is held, not rebuilt', async () => {
    expect(psql(MAIN, `SELECT pg_create_physical_replication_slot('${SLOT2}');`).status).toBe(0);
    const seed = run(['run', '--rm', '--network', NET, '-e', 'PGPASSWORD', '-v', `${COPY2_VOL}:/var/lib/postgresql/data`, '-v', `${certFile}:/primary-ca.crt:ro`,
      '--entrypoint', 'pg_basebackup', 'postgres:16-alpine', '-d', replDsn(MAIN), '-D', '/var/lib/postgresql/data', '-X', 'stream', '-R', '-S', SLOT2, '--checkpoint=fast'], undefined, { PGPASSWORD: REPL_PW });
    expect(seed.status, seed.err).toBe(0);
    expect(run(['run', '--rm', '-v', `${COPY2_VOL}:/d`, 'postgres:16-alpine', 'chown', '-R', 'postgres:postgres', '/d']).status).toBe(0);
    expect(run(['run', '-d', '--name', COPY2, '--network', NET, '-v', `${COPY2_VOL}:/var/lib/postgresql/data`, '-v', `${certFile}:/primary-ca.crt:ro`, 'postgres:16-alpine']).status).toBe(0);
    waitReady(COPY2);
    expect(psql(COPY, 'SELECT pg_promote();').status).toBe(0);
    await wait(3000);
    expect(psql(COPY, 'CHECKPOINT;').status).toBe(0);
    const copy2 = await copyVerdict(COPY2);
    expect(copy2).toMatchObject({ answered: true, inRecovery: true, timeline: 1 });
    const ident = run(['exec', COPY, 'psql', '-X', '-U', 'smdb', '-d', 'dbname=smdb replication=true', '-Atc', 'IDENTIFY_SYSTEM']);
    expect(ident.status, ident.err).toBe(0);
    const [systemId, timeline, xlogpos] = ident.out.split('|');
    expect(Number(timeline)).toBe(2);
    if (copy2.answered) expect(systemId).toBe(copy2.systemId);
    const main: VerdictMain = { answered: true, inRecovery: false, systemId, timeline: Number(timeline), lsn: lsnToBigInt(xlogpos)!, slot: 'absent' };
    const verdict = rebuildVerdict({ copyCleared: false, heldAt: null, busy: null, parked: null, joinedSystemId: null, host: COPY, port: 5432 }, { ...(copy2 as Extract<VerdictCopy, { answered: true }>), streaming: false }, main, Date.now());
    expect(verdict).toMatchObject({ kind: 'held', reason: expect.stringContaining('the main is on timeline 2 and this copy on timeline 1') });
  }, 900000);
});
