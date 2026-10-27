import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm1-l5-backup-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, raw: false, spawned: [] as string[], calls: [] as string[][], shell: [] as string[], notReady: false, notReadyLeft: 0, notReadyError: 'the database system is starting up', hang: false, execOpts: [] as any[],
    answer: null as ((args: string[]) => string | { stderr: string } | undefined) | null, env: null as Record<string, string> | null };
});

// docker says every container runs; every exec inside one fails, so each entry point stops after its first login. A row
// that sets h.answer gets its answers instead (a string is stdout, { stderr } a failure, undefined "refused"), with the
// write fence's own calls answered by fence-fake.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const refuse = (_f: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    const answer = h.answer?.(args);
    if (typeof answer === 'string') setImmediate(() => done(null, answer, ''));
    else setImmediate(() => done(Object.assign(new Error('docker failed'), { code: 1 }), '', answer?.stderr ?? 'refused'));
    return { stdin: null };
  };
  const fenced = (await import('./fence-fake')).withFence(refuse as any);
  const execFile = (_f: string, args: string[], opts: any, cb?: any) => {
    h.calls.push(args);
    if (h.answer) return (h.raw ? refuse : fenced)(_f, args, opts, cb);
    const done = typeof opts === 'function' ? opts : cb;
    if (args[0] === 'inspect') setImmediate(() => done(null, 'true\n', ''));
    else setImmediate(() => done(Object.assign(new Error('docker failed'), { code: 1 }), '', 'refused'));
    return { stdin: null };
  };
  const exec = (cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    h.shell.push(cmd);
    if (cmd.includes('pg_isready')) h.execOpts.push(typeof opts === 'function' ? undefined : opts);
    if (h.hang && cmd.includes('pg_isready')) {
      if (opts?.timeout) setTimeout(() => done(Object.assign(new Error('killed'), { killed: true })), opts.timeout);
    } else if ((h.notReady || h.notReadyLeft > 0) && cmd.includes('pg_isready')) {
      if (h.notReadyLeft > 0) h.notReadyLeft--;
      done(Object.assign(new Error(h.notReadyError), { code: 1 }));
    } else done(null, { stdout: '', stderr: '' });
  };
  const spawn = (_cmd: string, args: string[]) => {
    h.spawned.push(_cmd);
    h.calls.push(args);
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    child.stdin.resume();
    const answer = h.answer ? h.answer(args) ?? 'dump' : { stderr: 'refused' };
    setTimeout(() => {
      child.stdout.end(typeof answer === 'string' ? answer : '');
      child.stderr.end(typeof answer === 'string' ? '' : answer.stderr);
      setTimeout(() => child.emit('close', typeof answer === 'string' ? 0 : 1), 1);
    }, 2);
    return child;
  };
  const execFileSync = (_f: string, args: string[]) => {
    const answer = h.answer?.(args);
    if (answer !== undefined && typeof answer !== 'string') throw new Error(answer.stderr);
    return answer ?? '';
  };
  const mod = { ...real, exec, execFile, execFileSync, execSync: () => '', spawn };
  return { ...mod, default: mod };
});
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  readDeployedCompose: () => 'compose',
}));
vi.mock('../../src/docker/dockerClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
  composeUp: async () => {},
  verifyComposeProjectRunning: async () => ({ allRunning: true, problems: [] }),
  listBotContainers: async () => [],
}));
vi.mock('../../src/templates/pcsProcessing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/templates/pcsProcessing')>()),
  fleetAppContainerName: () => 'app-1',
}));
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
vi.mock('../../src/instance/dbLogin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/dbLogin')>()),
  ensureManagerDbRole: vi.fn(async () => ({ ok: true })),
}));

import * as fs from 'fs';
import * as path from 'path';
import * as fleetBackup from '../../src/instance/fleetBackup';
import { FENCE_SETTINGS, fenceOwners } from './fence-fake';
import * as containerManager from '../../src/docker/containerManager';

const fleetDb = { containerName: 'bot1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'bot1-fleet-postgres-data' };

/** Every psql, pg_dump and pg_restore the fake saw run inside a container, with the role it logged in as. */
const logins = () => h.calls
  .filter(a => a[0] === 'exec' && a.some(x => x === 'psql' || x === 'pg_dump' || x === 'pg_restore') && a.includes('-U'))
  .map(a => a[a.indexOf('-U') + 1]);

const expectManagerLogins = () => {
  const roles = logins();
  expect(roles.length).toBeGreaterThan(0);
  expect(roles.every(r => r === 'dbm_admin')).toBe(true);
};

beforeEach(() => {
  h.calls.length = 0;
  h.raw = false;
  h.spawned.length = 0;
  h.shell.length = 0;
  h.notReady = false;
  h.notReadyLeft = 0;
  h.notReadyError = 'the database system is starting up';
  h.hang = false;
  h.execOpts.length = 0;
  h.answer = null;
  h.env = null;
  Object.assign((containerManager as any).START_DB_READY, { deadlineMs: 30_000, tryMs: 5_000, pauseMs: 1000 });
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

const MISSING = 'psql: error: FATAL:  role "dbm_admin" does not exist';
const writeInstance = (record: Record<string, unknown>, id = 'b1') => {
  fs.mkdirSync(path.join(h.dir, 'bots', id), { recursive: true });
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances: {
    [id]: { id, displayName: id, sanitizedName: 'bot1', sourceUrl: 'https://example.invalid/fake/app', ...record },
  } }));
};
const roleChecks = () => h.calls.filter(a => a.some(x => x.includes('rolsuper'))).length;
// The dump's snapshot holder: a psql session fed on stdin that prints the snapshot, the counts and the end marker.
const isHolder = (args: string[]) => args[0] === 'exec' && args[1] === '-i' && args.includes('psql') && args.includes('-X');
const HOLDER = 'snap|00000003-1|f|1000|-1\ncount|"public"."t"|2\nend|\n';
const holderArgv = ['exec', '-i', 'bot1-fleet-postgres', 'psql', '-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-U', 'dbm_admin', '-d', 'smdb'];
const callWith = (marker: string) => h.calls.filter(a => a.some(x => x.includes(marker)));
const C = fleetDb.containerName;
const raw = async <T>(f: () => Promise<T>): Promise<T> => {
  h.raw = true;
  try { return await f(); } finally { h.raw = false; }
};

describe('NM1 L5: fleetBackup argv and the missing-role retry', () => {
  it('runFleetDump spawns pg_dump with the exact argv and checks no role on success', async () => {
    h.answer = args => (args[0] === 'inspect' ? 'true\n' : isHolder(args) ? HOLDER : args.includes('pg_dump') ? 'dump' : '');
    const r = await fleetBackup.runFleetDump({ id: 'b1', fleetDb } as any);
    expect(r.success, r.error).toBe(true);
    expect(h.calls.filter(isHolder)).toEqual([holderArgv]);
    expect(callWith('pg_dump')).toEqual([['exec', C, 'pg_dump', '-U', 'dbm_admin', '-Fc', '--snapshot=00000003-1', 'smdb']]);
    expect(roleChecks()).toBe(0);
  });

  it('runFleetDump makes a missing role and dumps once more', async () => {
    let n = 0;
    h.answer = args => {
      if (args[0] === 'inspect') return 'true\n';
      if (args.some(x => x.includes('rolsuper'))) return 'true\n';
      if (isHolder(args)) return HOLDER;
      if (args.includes('pg_dump')) return n++ === 0 ? { stderr: MISSING } : 'dump';
      return '';
    };
    const r = await fleetBackup.runFleetDump({ id: 'b1', fleetDb } as any);
    expect(r.success, r.error).toBe(true);
    expect(callWith('pg_dump').length).toBe(2);
    expect(h.calls.filter(isHolder).length).toBe(2);
    expect(roleChecks()).toBe(1);
  });

  it('a pg_dump that fails for another reason is not retried, and its error is the trimmed stderr cut at 500', async () => {
    h.answer = args => (args[0] === 'inspect' ? 'true\n' : isHolder(args) ? HOLDER : args.includes('pg_dump') ? { stderr: `  ${'x'.repeat(600)}  ` } : '');
    const r = await fleetBackup.runFleetDump({ id: 'b1', fleetDb } as any);
    expect(r).toEqual({ success: false, error: `pg_dump exited with code 1: ${'x'.repeat(500)}` });
    expect(callWith('pg_dump').length).toBe(1);
    expect(roleChecks()).toBe(0);
  });

  it('fenceLayers reads with the exact argv; a missing role is made and the read runs once more', async () => {
    let n = 0;
    h.answer = args => {
      if (args.some(x => x.includes('rolsuper'))) return 'true\n';
      if (args.some(x => x.includes('regexp_split_to_table'))) return n++ === 0 ? { stderr: MISSING } : 'off|0||\n';
      return '';
    };
    expect(await raw(() => fleetBackup.fenceLayers(fleetDb))).toEqual({ readOnly: false, hba: false, readOnlyOwner: null, hbaOwner: null, ownerFile: '' });
    const reads = callWith('regexp_split_to_table');
    expect(reads.length).toBe(2);
    expect(reads[0].slice(0, 9)).toEqual(['exec', C, 'psql', '-U', 'dbm_admin', '-d', 'postgres', '-tA', '-c']);
    expect(reads[0].length).toBe(10);
    expect(roleChecks()).toBe(1);
  });

  it('fenceLayers checks no role after a success or after another failure', async () => {
    h.answer = args => (args.some(x => x.includes('regexp_split_to_table')) ? 'off|0||\n' : '');
    expect(await raw(() => fleetBackup.fenceLayers(fleetDb))).not.toBeNull();
    h.answer = () => ({ stderr: 'could not connect' });
    expect(await raw(() => fleetBackup.fenceLayers(fleetDb))).toBeNull();
    expect(callWith('regexp_split_to_table').length).toBe(2);
    expect(roleChecks()).toBe(0);
  });

  it('probeLiveTerm and raiseGuildTerms run psql with the exact argv', async () => {
    h.answer = args => {
      const sql = args.join(' ');
      if (sql.includes("to_regclass('smdb_control.term')")) return 't|f\n';
      if (sql.includes('GREATEST')) return '7\n';
      if (sql.includes('UPDATE smdb_data.guild_ownership')) return 'g1\n';
      if (sql.includes("to_regclass('smdb_data.guild_ownership') IS NOT NULL")) return 't\n';
      return '';
    };
    expect(await raw(() => fleetBackup.probeLiveTerm(fleetDb))).toEqual({ ok: true, term: 7 });
    const head = ['exec', C, 'psql', '-U', 'dbm_admin', '-d', 'smdb', '-tA', '-v', 'ON_ERROR_STOP=1', '-c'];
    expect(h.calls).toEqual([
      [...head, "SELECT to_regclass('smdb_control.term') IS NOT NULL, to_regclass('smdb_data.guild_ownership') IS NOT NULL"],
      [...head, 'SELECT coalesce(GREATEST((SELECT max(term) FROM smdb_control.term)), -1)'],
    ]);
    h.calls.length = 0;
    expect(await raw(() => fleetBackup.raiseGuildTerms(fleetDb, 3))).toEqual({ ok: true, guilds: ['g1'] });
    const ex = ['exec', '-e', 'PGOPTIONS=-c default_transaction_read_only=off', C, 'psql', '-U', 'dbm_admin', '-d', 'smdb', '-tA', '-v', 'ON_ERROR_STOP=1', '-c'];
    expect(h.calls[0]).toEqual([...ex, "SELECT to_regclass('smdb_data.guild_ownership') IS NOT NULL"]);
    expect(h.calls[1].slice(0, -1)).toEqual(ex);
  });

  it('applyWriteFence runs psql, the TCP probe and the left-session count with the exact argv', async () => {
    let sweeps = 0;
    h.answer = args => {
      const sql = args.join(' ');
      if (sql.includes("current_setting('hba_file') ||")) return `${FENCE_SETTINGS}\n`;
      if (args.includes('127.0.0.1')) return { stderr: 'psql: error: FATAL:  pg_hba.conf rejects connection for host "127.0.0.1"' };
      if (sql.includes('pg_terminate_backend(pid, 5000)')) return sweeps++ === 0 ? '11|f\n12|f\n' : '';
      if (sql.includes('WHERE pid IN')) return '0\n';
      return '';
    };
    const r = await raw(() => fleetBackup.applyWriteFence(fleetDb, fleetBackup.newFenceOwner('restore' as any), 'any' as any));
    expect(r.ok, r.stderr).toBe(true);
    const psql = ['exec', C, 'psql', '-U', 'dbm_admin', '-d', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1'];
    expect(h.calls).toContainEqual([...psql, '-c', 'SELECT pg_reload_conf()']);
    expect(h.calls).toContainEqual(['exec', C, 'psql', '-h', '127.0.0.1', '-U', 'dbm_admin', '-d', 'postgres', '-w', '-tAc', 'SELECT 1']);
    expect(h.calls).toContainEqual([...psql, '-c', 'SELECT count(*) FROM pg_stat_activity WHERE pid IN (11, 12)']);
  });

  it("the start's stuck-fence check reads recovery and the saved setting with the exact argv", async () => {
    const copy = { containerName: 'bot1-fleet-postgres-replica', user: 'smdb', db: 'smdb', volume: 'v' };
    writeInstance({ status: 'stopped', fleetDb, fleetDbReplica: copy }, 'b2');
    const owner = fleetBackup.newFenceOwner('restore' as any);
    fenceOwners.set(fleetDb.containerName, owner);
    fenceOwners.set(copy.containerName, owner);
    h.answer = args => {
      const sql = args.join(' ');
      if (args[0] === 'inspect') return 'true\n';
      if (sql.includes('SHOW default_transaction_read_only')) return 'on\n';
      if (sql.includes('pg_is_in_recovery()')) return 't\n';
      if (sql.includes('pg_file_settings')) return '1\n';
      return '';
    };
    try {
      fleetBackup.startFleetBackupScheduler();
      await vi.waitFor(() => expect(callWith('pg_file_settings').length).toBeGreaterThan(0));
    } finally {
      fleetBackup.stopFleetBackupScheduler();
      fenceOwners.clear();
    }
    expect(callWith('pg_is_in_recovery()')[0]).toEqual(['exec', copy.containerName, 'psql', '-U', 'dbm_admin', '-d', 'postgres', '-tA', '-c', 'SELECT pg_is_in_recovery()']);
    expect(callWith('pg_file_settings')[0]).toEqual(['exec', C, 'psql', '-U', 'dbm_admin', '-d', 'postgres', '-tA', '-c', "SELECT count(*) FROM pg_file_settings WHERE name = 'default_transaction_read_only'"]);
  });
});

describe('NM1 L5: restoreFleetBackup argv', () => {
  const odd = { containerName: C, user: 'sm"u', db: `sm'"db`, volume: 'bot1-fleet-postgres-data' };
  const arrange = (pgRestore: () => string | { stderr: string }, db: typeof odd) => {
    const dir = path.join(h.dir, 'backups', 'b1', 'fleet-postgres');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'old.dump'), 'dump');
    writeInstance({ status: 'running', fleetDb: db, fleetBackup: { enabled: false, hour: 4, keep: 7 } });
    h.env = { DATABASE_URL: `postgres://smdb:pw@${C}:5432/smdb` };
    h.answer = args => {
      const sql = args.join(' ');
      if (args.includes('pg_restore')) return pgRestore();
      if (isHolder(args)) return HOLDER;
      if (args.includes('pg_dump')) return 'dump';
      if (args[0] === 'inspect') return 'true\n';
      if (sql.includes('rolsuper')) return 'true\n';
      if (sql.includes('ALTER SYSTEM SET default_transaction_read_only = on')) return '0\n';
      if (sql.includes('SHOW default_transaction_read_only')) return 'off\n';
      if (sql.includes('FROM pg_database WHERE datname')) return '1\n';
      if (sql.includes("to_regclass('smdb_control.term')")) return 't|t\n';
      if (sql.includes('SELECT coalesce(GREATEST(')) return '7\n';
      if (sql.includes("to_regclass('smdb_data.guild_ownership')")) return 't\n';
      if (sql.includes('UPDATE smdb_data.guild_ownership')) return 'g1\n';
      if (sql.includes('UPDATE smdb_control.term')) return '1\n';
      return '';
    };
    return [
      vi.spyOn(containerManager, 'runningInstanceContainers').mockImplementation(async () => []),
      vi.spyOn(containerManager, 'startFleetDbSidecar').mockImplementation(async () => ({ success: true })),
      vi.spyOn(containerManager, 'stopBot').mockImplementation(async () => ({ success: true }) as any),
      vi.spyOn(containerManager, 'startBot').mockImplementation(async () => ({ success: true }) as any),
    ];
  };
  const run = async (pgRestore: () => string | { stderr: string }, db = odd) => {
    const spies = arrange(pgRestore, db);
    try {
      return await fleetBackup.restoreFleetBackup('b1', 'old.dump');
    } finally {
      spies.forEach(s => s.mockRestore());
    }
  };
  const psql = (db: string) => ['psql', '-U', 'dbm_admin', '-d', db, '-tA', '-v', 'ON_ERROR_STOP=1'];
  const ex = ['exec', '-e', 'PGOPTIONS=-c default_transaction_read_only=off', C];
  const pgRestoreArgv = ['exec', '-e', 'PGOPTIONS=-c default_transaction_read_only=off', '-i', C, 'timeout', '-s', 'KILL', '600', 'pg_restore', '-U', 'dbm_admin', '--exit-on-error', '-d', `sm'"db`];

  it('a restore runs the existence check, the recreate, pg_restore and the term bump with the exact argv', async () => {
    const r = await run(() => '');
    expect(r.success, r.error).toBe(true);
    expect(h.calls).toContainEqual(['exec', C, ...psql('postgres'), '-c', `SELECT count(*) FROM pg_database WHERE datname = 'sm''"db'`]);
    expect(h.calls).toContainEqual([...ex, ...psql('postgres'), '-c', `DROP DATABASE IF EXISTS "sm'""db" WITH (FORCE)`, '-c', `CREATE DATABASE "sm'""db" OWNER "sm""u"`]);
    expect(callWith('pg_restore')).toEqual([pgRestoreArgv]);
    expect(h.calls).toContainEqual([...ex, ...psql(`sm'"db`), '-c', 'WITH u AS (UPDATE smdb_control.term SET term = GREATEST(term, 7) RETURNING 1) SELECT count(*) FROM u']);
    expect(roleChecks()).toBe(0);
  });

  it('a restore that succeeds or fails for another reason runs docker once and checks no role', async () => {
    const ok = await run(() => '', fleetDb);
    expect(ok.success, ok.error).toBe(true);
    expect(callWith('pg_restore').length).toBe(1);
    expect(h.spawned.every(c => c === 'docker')).toBe(true);
    expect(h.spawned.length).toBeGreaterThan(1);
    const bad = await run(() => ({ stderr: 'pg_restore: error: broken dump' }), fleetDb);
    expect(bad.success).toBe(false);
    expect(callWith('pg_restore').length).toBe(2);
    expect(roleChecks()).toBe(0);
  });

  it('a pg_restore refused for a missing role makes the role and restores once more', async () => {
    let n = 0;
    const r = await run(() => (n++ === 0 ? { stderr: MISSING } : ''), fleetDb);
    expect(r.success, r.error).toBe(true);
    expect(callWith('pg_restore').length).toBe(2);
    expect(roleChecks()).toBe(1);
  });

  it('a failed pg_restore is not retried, names the trimmed stderr cut at 500 and ends the sessions with the exact argv', async () => {
    const r = await run(() => ({ stderr: `  ${'y'.repeat(600)}  ` }));
    expect(r.success).toBe(false);
    expect(r.error).toContain(`pg_restore exited with code 1: ${'y'.repeat(500)}`);
    expect(r.error).not.toContain('y'.repeat(501));
    expect(callWith('pg_restore').length).toBe(1);
    expect(roleChecks()).toBe(0);
    expect(h.calls).toContainEqual(['exec', C, 'psql', '-U', 'dbm_admin', '-d', 'postgres', '-tA', '-c', "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND backend_type = 'client backend'"]);
  });
});
