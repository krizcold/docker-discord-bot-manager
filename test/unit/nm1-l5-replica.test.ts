import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Answer = string | { stderr: string } | { stdout: string; stderr: string } | undefined;

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm1-l5-replica-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, calls: [] as string[][], cmds: [] as string[], opts: [] as any[], env: null as Record<string, string> | null,
    answer: (_args: string[]): any => '' };
});

// Every docker call is recorded; h.answer decides it: a string is stdout with exit 0, { stdout, stderr } exit 0 with
// both, { stderr } a failure (stderr '' leaves docker's own error message), undefined a failure with 'refused'. The
// write fence's own calls are answered by fence-fake.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const raw = (_f: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    h.calls.push(args);
    h.cmds.push(_f);
    h.opts.push(typeof opts === 'function' ? undefined : opts);
    const a = h.answer(args);
    if (typeof a === 'string') setImmediate(() => done(null, a, ''));
    else if (a && 'stdout' in a) setImmediate(() => done(null, a.stdout, a.stderr));
    else setImmediate(() => done(Object.assign(new Error('docker failed'), { code: 1 }), '', a ? a.stderr : 'refused'));
    const child: any = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdin.resume();
    return child;
  };
  const execFile = (await import('./fence-fake')).withFence(raw as any);
  const spawn = (_cmd: string, args: string[]) => {
    h.calls.push(args);
    h.cmds.push(_cmd);
    h.opts.push(undefined);
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    child.stdin.resume();
    const a = h.answer(args) as Answer;
    const out = typeof a === 'string' ? a : a && 'stdout' in a ? a.stdout : '';
    const err = typeof a === 'string' ? '' : a ? a.stderr : 'refused';
    const code = typeof a === 'string' || (a && 'stdout' in a) ? 0 : 1;
    setTimeout(() => {
      child.stdout.end(out);
      child.stderr.end(err);
      setTimeout(() => child.emit('close', code), 1);
    }, 1);
    return child;
  };
  const execFileSync = (_f: string, args: string[]) => {
    const a = h.answer(args) as Answer;
    if (a !== undefined && typeof a !== 'string' && !('stdout' in a)) throw new Error(a.stderr);
    return typeof a === 'string' ? a : a?.stdout ?? '';
  };
  const mod = { ...real, execFile, execFileSync, execSync: () => '', spawn };
  return { ...mod, default: mod };
});
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/config/appCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/config/appCapabilities')>()),
  findAppCapabilities: () => ({ hooks: { port: 3000, basePath: '/hooks' }, companionDb: { env: { url: 'DATABASE_URL' } } }),
}));
vi.mock('../../src/env/manager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/env/manager')>();
  return {
    ...real,
    getEnvVars: (id: string) => (h.env ?? real.getEnvVars(id)),
    getEnvVarsWithStatus: (id: string) => (h.env ? { vars: h.env, corrupt: false, undecryptable: [] } : real.getEnvVarsWithStatus(id)),
  };
});

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as dbLogin from '../../src/instance/dbLogin';
import * as fleetReplica from '../../src/instance/fleetReplica';
import { disableFleetReplication, dropFleetSlot, enableFleetReplication, fenceLinesRefusal, getFleetReplicationStatus } from '../../src/instance/fleetReplication';

const MISSING = 'psql: error: connection to server on socket failed: FATAL:  role "dbm_admin" does not exist';
const SUPER = 'SELECT rolsuper::text FROM pg_roles WHERE rolname = current_user';
const fleetDb = { containerName: 'bot1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'bot1-fleet-postgres-data' };
const replication = { role: 'replicator', password: 'Repl-Secret-0123456789', hostPort: 15432, publicHost: 'primary.invalid', certHost: 'primary.invalid', slotWalKeepMb: 4096 };
const copy = { containerName: 'bot1-fleet-postgres-replica', user: 'smdb', db: 'smdb', volume: 'bot1-fleet-postgres-replica-data', publicHost: 'standby.invalid', hostPort: 5440, primaryHost: 'primary.invalid', primaryPort: 5433 };

const writeInstances = (records: Record<string, Record<string, unknown>>) => {
  const instances: Record<string, unknown> = {};
  for (const [id, record] of Object.entries(records)) {
    fs.mkdirSync(path.join(h.dir, 'bots', id, 'env'), { recursive: true });
    instances[id] = { id, displayName: id, sanitizedName: 'bot1', status: 'stopped', sourceUrl: 'https://example.invalid/fake/app',
      createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', ...record };
  }
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances }));
};
const writeInstance = (record: Record<string, unknown>) => writeInstances({ b1: record });
const callsWith = (marker: string) => h.calls.filter(a => a.some(x => x.includes(marker)));
/** The roles the manager's role was made over (CREATE ROLE runs as the bot role). */
const creators = () => callsWith('CREATE ROLE "dbm_admin"').map(a => a[a.indexOf('-U') + 1]);

/** The manager role's check: missing until it is made, then a superuser. */
let roleMade = false;
const roleAnswer = (args: string[]): Answer | null => {
  if (args.includes(SUPER)) return roleMade ? 'true\n' : { stderr: MISSING };
  if (args.some(x => x.startsWith('CREATE ROLE "dbm_admin"'))) { roleMade = true; return ''; }
  return null;
};
const answerWith = (rest: (args: string[]) => Answer) => (args: string[]): Answer => {
  const role = roleAnswer(args);
  if (role !== null) return role;
  return rest(args);
};
/** The first login matching `marker` fails with dbm_admin missing; later ones get `then`. */
const missingOnce = (marker: (args: string[]) => boolean, then: () => Answer, rest: (args: string[]) => Answer) => {
  let first = true;
  return answerWith(args => {
    if (marker(args)) {
      if (first) { first = false; return { stderr: MISSING }; }
      return then();
    }
    return rest(args);
  });
};
const base = (args: string[]): Answer => (args[0] === 'inspect' ? 'true\n' : '');

beforeEach(() => {
  h.calls.length = 0;
  h.opts.length = 0;
  h.cmds.length = 0;
  h.env = null;
  roleMade = false;
  h.answer = answerWith(base);
  dbLogin.resetManagerRoleCache();
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('NM1 L5: fleetReplica logins as dbm_admin', () => {
  it("getFleetReplicaStatus's probe runs psql -d <db> -Atc, and a missing dbm_admin is made and the probe runs once more", async () => {
    h.answer = missingOnce(a => a.some(x => x.includes('pg_stat_wal_receiver')), () => 't|streaming||\n', base);
    await fleetReplica.getFleetReplicaStatus({ id: 'b1', fleetDbReplica: copy } as any);
    const probes = callsWith('pg_stat_wal_receiver');
    expect(probes.length).toBe(2);
    expect(probes[0].slice(0, 8)).toEqual(['exec', copy.containerName, 'psql', '-U', 'dbm_admin', '-d', 'smdb', '-Atc']);
    expect(creators()).toEqual(['smdb']);
  });

  it("getFleetReplicaStatus's probe that fails for another reason runs once and makes no role", async () => {
    h.answer = answerWith(args => (args.some(x => x.includes('pg_stat_wal_receiver')) ? { stderr: 'could not connect' } : base(args)));
    await fleetReplica.getFleetReplicaStatus({ id: 'b1', fleetDbReplica: copy } as any);
    expect(callsWith('pg_stat_wal_receiver').length).toBe(1);
    expect(callsWith(SUPER).length).toBe(0);
  });

  it("removeFleetReplica's copyHeld probe runs psql -d <db> -Atc", async () => {
    writeInstance({ fleetDbReplica: copy });
    await fleetReplica.removeFleetReplica(containerManager.getBot('b1')!);
    expect(callsWith('SELECT pg_is_in_recovery();')[0]).toEqual(['exec', copy.containerName, 'psql', '-U', 'dbm_admin', '-d', 'smdb', '-Atc', 'SELECT pg_is_in_recovery();']);
  });

  it("adoptPromotedReplica's resets and reload run psql -d <db> -Atc", async () => {
    writeInstance({ fleetDbReplica: { ...copy, certHost: copy.publicHost } });
    h.env = { DATABASE_URL: `postgres://${copy.user}:pw@${copy.containerName}:5432/${copy.db}` };
    h.answer = answerWith(args => {
      const sql = args.join(' ');
      if (args[0] === 'inspect') return 'true\n';
      if (sql.includes('pg_stat_wal_receiver')) return 'f|||\n';
      if (sql.includes("grep '^primary_conninfo'")) return "primary_conninfo = 'user=replicator password=rpw host=primary.invalid'\n";
      if (sql.includes('regexp_split_to_table') && sql.includes('count(*)')) return '0\n';
      if (sql.includes('FROM pg_roles WHERE rolname')) return '0\n';
      return '';
    });
    await fleetReplica.adoptPromotedReplica(containerManager.getBot('b1')!);
    for (const setting of ['primary_conninfo', 'primary_slot_name', 'synchronous_standby_names', 'default_transaction_read_only']) {
      expect(callsWith(`ALTER SYSTEM RESET ${setting};`)[0]).toEqual(['exec', copy.containerName, 'psql', '-U', 'dbm_admin', '-d', 'smdb', '-Atc', `ALTER SYSTEM RESET ${setting};`]);
    }
    expect(callsWith('SELECT pg_reload_conf();')[0]).toEqual(['exec', copy.containerName, 'psql', '-U', 'dbm_admin', '-d', 'smdb', '-Atc', 'SELECT pg_reload_conf();']);
  });
});

describe("NM1 L5: reseedStalePrimary's identity read", () => {
  const IDENTITY_SQL = 'SELECT (SELECT system_identifier FROM pg_control_system()), (SELECT timeline_id FROM pg_control_checkpoint())';
  const rest = (args: string[]): Answer => {
    const sql = args.join(' ');
    if (args[0] === 'volume' && args[1] === 'inspect') return String(args[args.length - 1]).endsWith('-replica-data') ? { stderr: 'Error: No such volume' } : '[]';
    if (args.includes('pg_dump')) return 'dump';
    if (args.includes('SELECT pg_is_in_recovery()')) return 'f\n';
    if (args.includes('IDENTIFY_SYSTEM')) return '9009|3|0/3000000|\n';
    if (args[0] === 'inspect') return 'true\n';
    if (sql.includes('ALTER SYSTEM SET default_transaction_read_only = on')) return '0\n';
    if (sql.includes('SHOW default_transaction_read_only')) return 'off\n';
    if (sql.includes('FROM pg_database WHERE datname')) return '1\n';
    if (sql.includes("to_regclass('smdb_control.term')")) return 'f|f\n';
    if (sql.includes('to_regclass')) return 'f\n';
    return '';
  };
  const run = async (answer: (args: string[]) => Answer) => {
    writeInstance({ fleetDb, fleetBackup: { enabled: false, hour: 4, keep: 7 } });
    h.env = { DATABASE_URL: `postgres://${fleetDb.user}:pw@${fleetDb.containerName}:5432/${fleetDb.db}` };
    h.answer = answer;
    const spies = [
      vi.spyOn(containerManager, 'runningNonSidecarContainers').mockImplementation(async () => []),
      vi.spyOn(containerManager, 'runningInstanceContainers').mockImplementation(async () => []),
      vi.spyOn(containerManager, 'deployedComposeExists').mockImplementation(() => true),
      vi.spyOn(containerManager, 'startFleetDbSidecar').mockImplementation(async () => ({ success: true })),
      vi.spyOn(containerManager, 'retireFleetDbSidecar').mockImplementation(async () => ({ success: true }) as any),
    ];
    try {
      const r = fleetReplica.reseedStalePrimary(containerManager.getBot('b1')!, 'postgresql://replicator:fakepass@primary.invalid:5433/smdb',
        '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----', 'standby.invalid', 5440, true);
      expect(r.success, r.error).toBe(true);
      await vi.waitFor(() => expect(containerManager.getBot('b1')?.fleetDbReplicaSeed?.parked).toBe(true), { timeout: 5000 });
    } finally {
      spies.forEach(s => s.mockRestore());
    }
    return containerManager.getBot('b1')!.fleetDbReplicaSeed!.lastError!;
  };
  const isIdentity = (args: string[]) => args.includes(IDENTITY_SQL);
  const reads = () => h.calls.map((a, i) => ({ a, o: h.opts[i], c: h.cmds[i] })).filter(c => isIdentity(c.a));

  it('runs docker exec psql -d <db> -tA -c with the probe timeout, and a missing dbm_admin is made and the read runs once more', async () => {
    const err = await run(missingOnce(isIdentity, () => '7001|2\n', rest));
    expect(err).toMatch(/is not a copy of this one/);
    const r = reads();
    expect(r.length).toBe(2);
    expect(r[0].a).toEqual(['exec', fleetDb.containerName, 'psql', '-U', 'dbm_admin', '-d', 'smdb', '-tA', '-c', IDENTITY_SQL]);
    expect(r[0].o?.timeout).toBeGreaterThan(0);
    expect(r[0].c).toBe('docker');
    expect(creators()).toEqual(['smdb']);
  });

  it("a read that fails for another reason runs once, and the error names psql's stderr", async () => {
    const err = await run(answerWith(args => (isIdentity(args) ? { stderr: 'FATAL:  the database system is shutting down' } : rest(args))));
    expect(reads().length).toBe(1);
    expect(err).toContain("this database's identity could not be read (FATAL:  the database system is shutting down), so it cannot be compared with the pasted primary's");
  });

  it("a read that fails with no stderr names docker's own error", async () => {
    const err = await run(answerWith(args => (isIdentity(args) ? { stderr: '' } : rest(args))));
    expect(err).toContain("this database's identity could not be read (docker failed), so it cannot be compared with the pasted primary's");
  });
});

describe('NM1 L5: fleetReplication logins as dbm_admin', () => {
  const isFenceRead = (args: string[]) => args.includes('psql') && !args.includes(SUPER) && !args.some(x => x.startsWith('CREATE ROLE'));

  it("fenceLinesRefusal's psql runs -d <db> -v ON_ERROR_STOP=1 -Atc, and a missing dbm_admin is made over the bot role on record and the read runs once more", async () => {
    writeInstances({ b0: { fleetDb: { ...fleetDb, containerName: 'other-db', user: 'otherrole' } }, b1: { fleetDb } });
    h.answer = missingOnce(isFenceRead, () => '0\n', base);
    expect(await fenceLinesRefusal(fleetDb.containerName, 'smdb')).toBeNull();
    const reads = h.calls.filter(isFenceRead);
    expect(reads.length).toBe(2);
    expect(reads[0].slice(0, 10)).toEqual(['exec', fleetDb.containerName, 'psql', '-U', 'dbm_admin', '-d', 'smdb', '-v', 'ON_ERROR_STOP=1', '-Atc']);
    expect(creators()).toEqual(['smdb']);
  });

  it('a psql that fails for another reason runs once and makes no role', async () => {
    writeInstance({ fleetDb });
    h.answer = answerWith(args => (isFenceRead(args) ? { stderr: 'could not connect' } : base(args)));
    expect(await fenceLinesRefusal(fleetDb.containerName, 'smdb')).toBe('whether a write fence stands in pg_hba.conf could not be read (could not connect)');
    expect(h.calls.filter(isFenceRead).length).toBe(1);
    expect(callsWith(SUPER).length).toBe(0);
  });
});

describe('NM1 L5: the SQL fleetReplication sends', () => {
  const PSQL = ['exec', fleetDb.containerName, 'psql', '-U', 'dbm_admin', '-d', 'smdb', '-v', 'ON_ERROR_STOP=1', '-Atc'];
  const psqlCall = (sql: string) => h.calls.find(a => a.includes('psql') && a[a.length - 1] === sql);

  it('enable sets wal_log_hints and the WAL retention bound, reloads, and makes the replication role through psql -At on stdin', async () => {
    writeInstance({ status: 'running', fleetDb: { ...fleetDb, replication } });
    h.env = { DATABASE_URL: `postgres://${fleetDb.user}:pw@${fleetDb.containerName}:5432/${fleetDb.db}` };
    h.answer = answerWith(args => (args.some(x => x.includes('regexp_split_to_table')) ? '0\n' : base(args)));
    const r = await enableFleetReplication(containerManager.getBot('b1')!, 'primary.invalid', 15432, 2048);
    expect(r.success, r.error).toBe(true);
    for (const sql of ['ALTER SYSTEM SET wal_log_hints = on;', "ALTER SYSTEM SET max_slot_wal_keep_size = '2048MB';", 'SELECT pg_reload_conf();']) {
      expect(psqlCall(sql), sql).toEqual([...PSQL, sql]);
    }
    expect(h.calls.find(a => a[0] === 'exec' && a[1] === '-i' && a.includes('psql'))).toEqual(
      ['exec', '-i', fleetDb.containerName, 'psql', '-U', 'dbm_admin', '-d', 'smdb', '-v', 'ON_ERROR_STOP=1', '-At']);
  });

  it('disable reads the active fleet slots and, after the drop, every fleet slot left', async () => {
    writeInstance({ status: 'running', fleetDb: { ...fleetDb, replication } });
    h.env = { DATABASE_URL: `postgres://${fleetDb.user}:pw@${fleetDb.containerName}:5432/${fleetDb.db}` };
    const r = await disableFleetReplication(containerManager.getBot('b1')!);
    expect(r.success, r.error).toBe(true);
    const slots = "SELECT COALESCE(string_agg(slot_name, ', ' ORDER BY slot_name), '') FROM pg_replication_slots WHERE starts_with(slot_name, 'fleet_standby')";
    expect(psqlCall(`${slots} AND active;`)).toEqual([...PSQL, `${slots} AND active;`]);
    expect(psqlCall(`${slots};`)).toEqual([...PSQL, `${slots};`]);
  });

  it("status reads ssl and the replication rows, and a slot drop names the slot in its DO block", async () => {
    writeInstance({ status: 'running', fleetDb: { ...fleetDb, replication } });
    await getFleetReplicationStatus(containerManager.getBot('b1')!);
    const status = h.calls.find(a => a.includes('psql'))!;
    expect(status.slice(0, 10)).toEqual(PSQL);
    expect(status[10]).toMatch(/^SELECT current_setting\('ssl'\),\s+\(SELECT json_agg\(json_build_object\(/);
    h.calls.length = 0;
    const r = await dropFleetSlot(containerManager.getBot('b1')!, 'fleet_standby_b9');
    expect(r.success).toBe(true);
    const drop = h.calls.find(a => a.includes('psql'))!;
    expect(drop.slice(0, 10)).toEqual(PSQL);
    expect(drop[10]).toContain("SELECT active INTO s FROM pg_replication_slots WHERE slot_name = 'fleet_standby_b9';");
    expect(drop[10]).toContain("PERFORM pg_drop_replication_slot('fleet_standby_b9');");
  });
});
