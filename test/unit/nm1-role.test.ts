import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm1-role-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, calls: [] as string[][], shell: [] as string[], notReady: false, notReadyLeft: 0, notReadyError: 'the database system is starting up', hang: false, execOpts: [] as any[],
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
    if (h.answer) return fenced(_f, args, opts, cb);
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
  const mod = { ...real, exec, execFile, execFileSync, execSync: () => '', spawn: (await import('./dump-fake')).withDumpHolder(spawn as any) };
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
import { fenceLinesRefusal } from '../../src/instance/fleetReplication';
import * as fleetReplica from '../../src/instance/fleetReplica';
import { fenceOwners } from './fence-fake';
import { MAINTAINED, TOC } from './restore-fake';
import * as containerManager from '../../src/docker/containerManager';
import * as dbLogin from '../../src/instance/dbLogin';
import { callAppHook } from '../../src/instance/appHookClient';
import { certSource } from '../../src/instance/fleetJoin';
import { codeFor, fixtureCert } from './join-fake';

beforeEach(() => { certSource.fetch = fixtureCert; });

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

describe('NM1: the manager logs in to the fleet database as dbm_admin', () => {
  it('runFleetDump runs pg_dump as dbm_admin', async () => {
    await fleetBackup.runFleetDump({ id: 'b1', fleetDb } as any);
    expect(h.calls.some(a => a.includes('pg_dump'))).toBe(true);
    expectManagerLogins();
  });

  it('fenceLayers reads the fence as dbm_admin', async () => {
    await fleetBackup.fenceLayers(fleetDb);
    expectManagerLogins();
  });

  it('applyWriteFence logs in as dbm_admin', async () => {
    await fleetBackup.applyWriteFence(fleetDb, fleetBackup.newFenceOwner('restore' as any), 'any' as any);
    expectManagerLogins();
  });

  it('probeClaims reads the claim numbers as dbm_admin', async () => {
    await fleetBackup.probeClaims(fleetDb);
    expectManagerLogins();
  });

  it('raiseClaims reads the tables and writes the claim numbers as dbm_admin', async () => {
    h.answer = args => {
      const sql = args.join(' ');
      if (sql.includes("to_regclass('smdb_data.claim_seq')")) return 't|t|t\n';
      if (sql.includes("setval('smdb_data.claim_seq'")) return 'seq|4\n';
      return '';
    };
    expect(await fleetBackup.raiseClaims(fleetDb, 3)).toEqual({ ok: true, seq: 4, guilds: [] });
    expect(h.calls.some(a => a.some(x => x.includes('setval')))).toBe(true);
    expectManagerLogins();
  });

  it("fleetReplication's enable path reads the fence lines as dbm_admin", async () => {
    await fenceLinesRefusal(fleetDb.containerName, fleetDb.db);
    expectManagerLogins();
  });

  const writeInstance = (record: Record<string, unknown>, id = 'b1') => {
    fs.mkdirSync(path.join(h.dir, 'bots', id), { recursive: true });
    fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances: {
      [id]: { id, displayName: id, sanitizedName: 'bot1', sourceUrl: 'https://example.invalid/fake/app', ...record },
    } }));
  };
  const copy = { containerName: 'bot1-fleet-postgres-replica', user: 'smdb', db: 'smdb', volume: 'bot1-fleet-postgres-replica-data', publicHost: 'standby.invalid', hostPort: 5440, primaryHost: 'primary.invalid', primaryPort: 5433 };
  const loginOf = (marker: string) => {
    const call = h.calls.find(a => a[0] === 'exec' && a.some(x => x.includes(marker)));
    expect(call, marker).toBeDefined();
    return call![call!.indexOf('-U') + 1];
  };

  const arrangeRestore = (pgRestore: string | { stderr: string }) => {
    const dir = path.join(h.dir, 'backups', 'b1', 'fleet-postgres');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'old.dump'), 'dump');
    writeInstance({ status: 'running', ...MAINTAINED, fleetDb, fleetBackup: { enabled: false, hour: 4, keep: 7 } });
    h.env = { DATABASE_URL: `postgres://${fleetDb.user}:pw@${fleetDb.containerName}:5432/${fleetDb.db}` };
    h.answer = args => {
      const sql = args.join(' ');
      if (args.includes('pg_restore') && args.includes('-l')) return TOC.claims;
      if (args.includes('pg_restore')) return pgRestore;
      if (args.includes('pg_dump')) return 'dump';
      if (args[0] === 'inspect') return 'true\n';
      if (sql.includes('ALTER SYSTEM SET default_transaction_read_only = on')) return '0\n';
      if (sql.includes('SHOW default_transaction_read_only')) return 'off\n';
      if (sql.includes('FROM pg_database WHERE datname')) return '1\n';
      if (sql.includes('rolcanlogin')) return 'false|false|0\n';
      if (sql.includes("to_regclass('smdb_data.claim_seq')")) return 't|t|t\n';
      if (sql.includes('SELECT coalesce(GREATEST(')) return '7\n';
      if (sql.includes("setval('smdb_data.claim_seq'")) return 'seq|8\nguild|g1\n';
      return '';
    };
    return [
      vi.spyOn(containerManager, 'runningInstanceContainers').mockImplementation(async () => []),
      vi.spyOn(containerManager, 'startFleetDbSidecar').mockImplementation(async () => ({ success: true })),
      vi.spyOn(containerManager, 'stopBot').mockImplementation(async () => ({ success: true }) as any),
      vi.spyOn(containerManager, 'startBot').mockImplementation(async () => ({ success: true }) as any),
    ];
  };

  it("restoreFleetBackup's recreate and pg_restore log in as dbm_admin, and the new database stays owned by the bot role", async () => {
    const spies = arrangeRestore('');
    try {
      const r = await fleetBackup.restoreFleetBackup('b1', 'old.dump');
      expect(r.success, r.error).toBe(true);
    } finally {
      spies.forEach(s => s.mockRestore());
    }
    const recreate = h.calls.find(a => a.some(x => x.startsWith('CREATE DATABASE')))!;
    expect(recreate[recreate.indexOf('-U') + 1]).toBe('dbm_admin');
    expect(recreate).toContain(`CREATE DATABASE "${fleetDb.db}" OWNER "${fleetDb.user}"`);
    expect(loginOf('--exit-on-error')).toBe('dbm_admin');
    expect(loginOf("setval('smdb_data.claim_seq'")).toBe('dbm_admin');
    expect(loginOf('127.0.0.1')).toBe('dbm_admin');
    expectManagerLogins();
  });

  it('a failed pg_restore ends the surviving sessions as dbm_admin', async () => {
    const spies = arrangeRestore({ stderr: 'pg_restore: error: broken dump' });
    try {
      const r = await fleetBackup.restoreFleetBackup('b1', 'old.dump');
      expect(r.success).toBe(false);
    } finally {
      spies.forEach(s => s.mockRestore());
    }
    expect(loginOf('count(pg_terminate_backend(pid))')).toBe('dbm_admin');
    expectManagerLogins();
  });

  it("the start's stuck-fence check reads the copy's recovery and the saved fence setting as dbm_admin", async () => {
    // Its own id: a failed restore above left b1's fence marked stuck, and the check skips a stuck database.
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
      await vi.waitFor(() => expect(h.calls.some(a => a.some(x => x.includes('pg_file_settings')))).toBe(true));
    } finally {
      fleetBackup.stopFleetBackupScheduler();
      fenceOwners.clear();
    }
    expect(loginOf('pg_is_in_recovery()')).toBe('dbm_admin');
    expect(loginOf('pg_file_settings')).toBe('dbm_admin');
    expectManagerLogins();
  });

  it("the replica probe of getFleetReplicaStatus logs in as dbm_admin", async () => {
    await fleetReplica.getFleetReplicaStatus({ id: 'b1', fleetDbReplica: copy } as any);
    expect(loginOf('pg_stat_wal_receiver')).toBe('dbm_admin');
    expectManagerLogins();
  });

  it("removeFleetReplica's copyHeld probe logs in as dbm_admin", async () => {
    writeInstance({ status: 'stopped', fleetDbReplica: copy });
    await fleetReplica.removeFleetReplica(containerManager.getBot('b1')!);
    expect(loginOf('SELECT pg_is_in_recovery();')).toBe('dbm_admin');
    expectManagerLogins();
  });

  it("reseedStalePrimary's identity read (reseedIdentityRefusal) logs in as dbm_admin", async () => {
    writeInstance({ status: 'stopped', fleetDb, fleetBackup: { enabled: false, hour: 4, keep: 7 } });
    h.env = { DATABASE_URL: `postgres://${fleetDb.user}:pw@${fleetDb.containerName}:5432/${fleetDb.db}` };
    h.answer = args => {
      const sql = args.join(' ');
      if (args[0] === 'volume' && args[1] === 'inspect') return String(args[args.length - 1]).endsWith('-replica-data') ? { stderr: 'Error: No such volume' } : '[]';
      if (args.includes('pg_dump')) return 'dump';
      if (args.includes('SELECT pg_is_in_recovery()')) return 'f\n';
      if (args.includes('IDENTIFY_SYSTEM')) return '9009|3|0/3000000|\n';
      if (args[0] === 'inspect') return 'true\n';
      if (sql.includes('ALTER SYSTEM SET default_transaction_read_only = on')) return '0\n';
      if (sql.includes('SHOW default_transaction_read_only')) return 'off\n';
      if (sql.includes('FROM pg_database WHERE datname')) return '1\n';
      if (sql.includes('pg_control_system()')) return '7001|2\n';
      if (sql.includes('to_regclass')) return 'f\n';
      return '';
    };
    const spies = [
      vi.spyOn(containerManager, 'runningNonSidecarContainers').mockImplementation(async () => []),
      vi.spyOn(containerManager, 'runningInstanceContainers').mockImplementation(async () => []),
      vi.spyOn(containerManager, 'deployedComposeExists').mockImplementation(() => true),
      vi.spyOn(containerManager, 'startFleetDbSidecar').mockImplementation(async () => ({ success: true })),
      vi.spyOn(containerManager, 'retireFleetDbSidecar').mockImplementation(async () => ({ success: true }) as any),
    ];
    try {
      const r = fleetReplica.reseedStalePrimary(containerManager.getBot('b1')!, codeFor('postgresql://replicator:fakepass@primary.invalid:5433/smdb'), 'standby.invalid', 5440, true);
      expect(r.success, r.error).toBe(true);
      await vi.waitFor(() => expect(containerManager.getBot('b1')?.fleetDbReplicaSeed?.parked).toBe(true), { timeout: 5000 });
    } finally {
      spies.forEach(s => s.mockRestore());
    }
    expect(containerManager.getBot('b1')?.fleetDbReplicaSeed?.lastError).toMatch(/is not a copy of this one/);
    expect(loginOf('pg_control_system()')).toBe('dbm_admin');
    expectManagerLogins();
  });

  it("adoptPromotedReplica's reset and reload, and the enable after it (psql and psqlScript), log in as dbm_admin", async () => {
    writeInstance({ status: 'stopped', fleetDbReplica: { ...copy, certHost: copy.publicHost } });
    h.env = { DATABASE_URL: `postgres://${copy.user}:pw@${copy.containerName}:5432/${copy.db}` };
    h.answer = args => {
      const sql = args.join(' ');
      if (args[0] === 'inspect') return 'true\n';
      if (sql.includes('pg_stat_wal_receiver')) return 'f|||\n';
      if (sql.includes("grep '^primary_conninfo'")) return "primary_conninfo = 'user=replicator password=rpw host=primary.invalid'\n";
      if (sql.includes('regexp_split_to_table') && sql.includes('count(*)')) return '0\n';
      if (sql.includes('FROM pg_roles WHERE rolname')) return '0\n';
      return '';
    };
    await fleetReplica.adoptPromotedReplica(containerManager.getBot('b1')!);
    for (const setting of ['primary_conninfo', 'primary_slot_name', 'synchronous_standby_names', 'default_transaction_read_only']) {
      expect(loginOf(`ALTER SYSTEM RESET ${setting};`)).toBe('dbm_admin');
    }
    expect(loginOf('SELECT pg_reload_conf();')).toBe('dbm_admin');
    expect(loginOf('FROM pg_roles WHERE rolname')).toBe('dbm_admin');
    const script = h.calls.find(a => a[0] === 'exec' && a.includes('-At') && a.includes('psql'));
    expect(script, 'psqlScript').toBeDefined();
    expect(script![script!.indexOf('-U') + 1]).toBe('dbm_admin');
    expectManagerLogins();
  });
});

describe('NM1: the manager role and the hook status', () => {
  it('startFleetDbSidecar makes sure of the manager role once pg_isready answers', async () => {
    const appDir = path.join(h.dir, 'DATA', 'AppData', 'casaos', 'apps', 'bot1');
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'docker-compose.yml'), 'name: bot1\nservices:\n  fleet-postgres:\n    container_name: bot1-fleet-postgres\n    image: postgres:16\n');
    fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({
      instances: {
        b1: {
          id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'stopped',
          sourceType: 'docker-image', imageRef: 'example/bot:1', envVars: {}, containerIds: [], fleetDb,
          createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
        },
      },
    }));
    const r = await containerManager.startFleetDbSidecar('b1');
    expect(r.success).toBe(true);
    expect(h.shell.some(c => c.includes('pg_isready'))).toBe(true);
    expect((dbLogin as any).ensureManagerDbRole).toHaveBeenCalledWith({ container: fleetDb.containerName, user: fleetDb.user });
  });

  it('startBot ensures dbm_admin after a successful start of a bot with a database, and a failure is logged without failing the start', async () => {
    const appDir = path.join(h.dir, 'DATA', 'AppData', 'casaos', 'apps', 'bot1');
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'docker-compose.yml'), 'name: bot1\nservices:\n  fleet-postgres:\n    container_name: bot1-fleet-postgres\n    image: postgres:16\n');
    const writeRecord = () => fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({
      instances: {
        b1: {
          id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'stopped',
          sourceType: 'docker-image', imageRef: 'example/bot:1', envVars: {}, containerIds: [], fleetDb,
          createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
        },
      },
    }));
    const botDir = path.join(h.dir, 'bots', 'b1');
    fs.mkdirSync(botDir, { recursive: true });
    fs.writeFileSync(path.join(botDir, 'docker-compose.yml'), 'name: bot1\nservices:\n  app:\n    image: example/bot:1\n');
    const ensure = (dbLogin as any).ensureManagerDbRole;
    writeRecord();
    ensure.mockClear();
    const ok = await containerManager.startBot('b1');
    expect(ok.success).toBe(true);
    expect(ensure).toHaveBeenCalledWith({ container: fleetDb.containerName, user: fleetDb.user });

    writeRecord();
    ensure.mockClear();
    ensure.mockImplementationOnce(async () => ({ ok: false, error: 'role refused' }));
    const warned: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { warned.push(String(m)); });
    try {
      const failed = await containerManager.startBot('b1');
      expect(failed.success).toBe(true);
      expect(ensure).toHaveBeenCalledTimes(1);
      expect(warned).toContain("[ContainerManager] b1: the manager's database role dbm_admin could not be confirmed after the start: role refused");
    } finally {
      spy.mockRestore();
    }
  });

  it('callAppHook sets status 404 when the app answers HTTP 404', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'not found' }), { status: 404 }));
    try {
      const r: any = await callAppHook({ id: 'b1', sourceUrl: 'x', updateToken: 'tok', envVars: {} } as any, 'confirm-fresh');
      expect(r.ok).toBe(false);
      expect(r.status).toBe(404);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('F2: the Start fence warning', () => {
  it('warns when the fence cannot be read', async () => {
    fs.mkdirSync(h.dir, { recursive: true });
    fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({
      instances: {
        b1: {
          id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'stopped',
          sourceType: 'docker-image', imageRef: 'example/bot:1', envVars: {}, containerIds: [], fleetDb,
          createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
        },
      },
    }));
    expect(await fleetBackup.fenceStartWarning('b1')).toBe("The manager can't confirm the database has no write fence on it: its fence settings could not be read, and a fence left on refuses the bot's connections");
  });
});

describe('N4: the database is still starting after compose up', () => {
  it('startBot waits for pg_isready until the deadline, then skips the role and says the fence could not be checked yet', async () => {
    const appDir = path.join(h.dir, 'DATA', 'AppData', 'casaos', 'apps', 'bot1');
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'docker-compose.yml'), 'name: bot1\nservices:\n  fleet-postgres:\n    container_name: bot1-fleet-postgres\n    image: postgres:16\n');
    fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({
      instances: {
        b1: {
          id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'stopped',
          sourceType: 'docker-image', imageRef: 'example/bot:1', envVars: {}, containerIds: [], fleetDb,
          createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
        },
      },
    }));
    const botDir = path.join(h.dir, 'bots', 'b1');
    fs.mkdirSync(botDir, { recursive: true });
    fs.writeFileSync(path.join(botDir, 'docker-compose.yml'), 'name: bot1\nservices:\n  app:\n    image: example/bot:1\n');
    Object.assign((containerManager as any).START_DB_READY, { deadlineMs: 30, pauseMs: 1 });
    const ensure = (dbLogin as any).ensureManagerDbRole;
    ensure.mockClear();
    h.notReady = true;
    const r = await containerManager.startBot('b1');
    expect(r.success).toBe(true);
    expect(h.shell.filter(c => c.includes('pg_isready')).length).toBeGreaterThan(1);
    expect(ensure).not.toHaveBeenCalled();
    expect(r.warning).not.toContain("can't confirm the database has no write fence");
    expect(r.warning).toContain("The database did not answer within 30 seconds of the start, so the manager could not check it for a write fence yet; the manager's own database role is created at its first login instead");
  });
});

describe('round 3: the wait for the database after Start', () => {
  const NO_ANSWER = "The database did not answer within 30 seconds of the start, so the manager could not check it for a write fence yet; the manager's own database role is created at its first login instead";
  const arrange = () => {
    const appDir = path.join(h.dir, 'DATA', 'AppData', 'casaos', 'apps', 'bot1');
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'docker-compose.yml'), 'name: bot1\nservices:\n  fleet-postgres:\n    container_name: bot1-fleet-postgres\n    image: postgres:16\n');
    fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({
      instances: {
        b1: {
          id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'stopped',
          sourceType: 'docker-image', imageRef: 'example/bot:1', envVars: {}, containerIds: [], fleetDb,
          createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
        },
      },
    }));
    const botDir = path.join(h.dir, 'bots', 'b1');
    fs.mkdirSync(botDir, { recursive: true });
    fs.writeFileSync(path.join(botDir, 'docker-compose.yml'), 'name: bot1\nservices:\n  app:\n    image: example/bot:1\n');
  };
  it('R3 each pg_isready exec has a 5 s timeout, and the wait stops at the 30 s clock deadline', async () => {
    vi.useFakeTimers();
    try {
      h.hang = true;
      let result: boolean | undefined;
      void (containerManager as any).databaseReady(fleetDb).then((r: boolean) => { result = r; });
      await vi.advanceTimersByTimeAsync(24_000);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(6_001);
      expect(result).toBe(false);
      expect(h.execOpts.length).toBeGreaterThan(1);
      expect(h.execOpts.every(o => o?.timeout > 0 && o.timeout <= 5_000)).toBe(true);
      expect(h.execOpts[0].timeout).toBe(5_000);
      const tries = h.execOpts.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.execOpts.length).toBe(tries);
    } finally {
      vi.useRealTimers();
    }
  });
  it('R4 a database container that is not running gets the no-answer text, not "still starting"', async () => {
    arrange();
    Object.assign((containerManager as any).START_DB_READY, { deadlineMs: 30, pauseMs: 1 });
    h.notReady = true;
    h.notReadyError = 'Error response from daemon: container bot1-fleet-postgres is not running';
    const r = await containerManager.startBot('b1');
    expect(r.success).toBe(true);
    expect(r.warning).toContain(NO_ANSWER);
    expect(r.warning).not.toContain('still starting');
  });
  it('R5 starting up three times, then ready: four calls, the role ensured once, no warning about the wait', async () => {
    arrange();
    Object.assign((containerManager as any).START_DB_READY, { pauseMs: 1 });
    const ensure = (dbLogin as any).ensureManagerDbRole;
    ensure.mockClear();
    h.notReadyLeft = 3;
    const r = await containerManager.startBot('b1');
    expect(r.success).toBe(true);
    expect(h.shell.filter(c => c.includes('pg_isready')).length).toBe(4);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(r.warning ?? '').not.toContain('still starting');
    expect(r.warning ?? '').not.toContain('did not answer');
  });
});
