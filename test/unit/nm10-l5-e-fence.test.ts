import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NM10 L5 e: the migration fence's write and lift on the docker argv and replies, the backup scope guard, the
// database sharers and the restore remedy a migration names. A fake docker answers each call from h.
const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm10-l5e-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  type R = { out: string; err?: string };
  return {
    dir,
    urls: {} as Record<string, Record<string, string>>,
    corrupt: [] as string[],
    addrs: { ok: true, addresses: ['172.18.0.4'] } as { ok: boolean; addresses?: string[]; error?: string },
    deployed: {} as Record<string, Record<string, string>>,
    envAsks: [] as string[],
    lists: 0,
    listFail: false,
    inspectFail: [] as string[],
    calls: [] as string[][],
    settings: { out: '/var/lib/postgresql/data/pg_hba.conf|0|0\n' } as R,
    write: { out: 'fenced\n' } as R,
    reload: { out: 't\n' } as R,
    rejects: true,
    sweeps: [] as string[],
    left: '1\n',
    vol: { out: '' } as R,
    lift: { out: '' } as R,
    strip: { out: '' } as R,
    layers: 'off|0||',
  };
});

vi.mock('../../src/config/appCapabilities', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/config/appCapabilities')>();
  return { ...real, findAppCapabilities: () => ({ companionDb: { env: { url: 'DATABASE_URL' } } }) };
});
vi.mock('../../src/env/manager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/env/manager')>();
  return {
    ...real,
    getEnvVarsWithStatus: (id: string) => ({ vars: h.urls[id] ?? {}, corrupt: h.corrupt.includes(id), undecryptable: [], encrypted: [] }),
    getEnvVars: (id: string) => h.urls[id] ?? {},
  };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return {
    ...real,
    appContainerAddresses: async () => h.addrs,
    liveContainersNow: async () => {
      h.lists++;
      return h.listFail ? null : (b: any) => (h.deployed[b.id] ? [{ id: `${b.id}-id`, name: b.id, state: 'running', status: '', ports: [] }] : []);
    },
    containerEnv: async (id: string, keys: string[]) => {
      const bot = id.replace(/-id$/, '');
      h.envAsks.push(bot);
      if (h.inspectFail.includes(bot)) return { ok: false, error: 'No such object' };
      return { ok: true, env: Object.fromEntries(Object.entries(h.deployed[bot] ?? {}).filter(([k]) => keys.includes(k))) };
    },
  };
});
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = require('events') as typeof import('events');
  const answer = (args: string[]): { out: string; err?: string } => {
    const sql = args.join(' ');
    if (args[0] === 'volume' && args[1] === 'inspect') return h.vol;
    if (args[0] === 'run' && sql.includes('stripped-hba')) return h.strip;
    if (args[0] === 'inspect') return { out: 'true\n' };
    if (args[0] !== 'exec') return { out: '' };
    if (args[1] === '-u' && sql.includes('echo fenced')) return h.write;
    if (args[1] === '-u' && sql.includes('stripped-hba')) return h.lift;
    if (sql.includes("current_setting('default_transaction_read_only') ||")) return { out: `${h.layers}\n` };
    if (sql.includes("current_setting('hba_file')")) return h.settings;
    if (sql.includes('pg_reload_conf()')) return h.reload;
    if (args.includes('127.0.0.1') && args.includes('-w')) return h.rejects ? { out: '', err: 'psql: error: FATAL:  pg_hba.conf rejects connection for host "127.0.0.1"' } : { out: '1\n' };
    if (sql.includes('pg_terminate_backend')) return { out: h.sweeps.shift() ?? '' };
    if (sql.includes('WHERE pid IN (')) return { out: h.left };
    return { out: '' };
  };
  const execFile = (cmd: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (cmd === 'docker') h.calls.push(args);
    const r = cmd === 'docker' ? answer(args) : { out: '' };
    setTimeout(() => (r.err === undefined ? done(null, r.out, '') : done(Object.assign(new Error(r.err), { code: 1 }), r.out, r.err)), 1);
    return new EventEmitter();
  };
  return { ...real, execFile, default: { ...real, execFile } };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import { databaseSharers, fenceMigrateSource, fenceStartWarning, fenceTiming, isFleetBackupScoped, liftMigrateFence, liftMigrateFenceScript, migrateFenceHbaScript } from '../../src/instance/fleetBackup';

const HBA = '/var/lib/postgresql/data/pg_hba.conf';
const fleetDb = { containerName: 'bot-a-postgres', user: 'smdb', db: 'app', volume: 'bot-a-postgres-data' };
const base = (id: string, extra: Record<string, unknown> = {}) => ({
  id, sanitizedName: `bot-${id}`, displayName: `Bot ${id.toUpperCase()}`, titleName: `Bot ${id.toUpperCase()}`, status: 'running',
  sourceType: 'git', sourceUrl: 'https://example.invalid/fake/app', envVars: {},
  createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', ...extra,
});
const record = (over: Record<string, unknown> = {}) => ({ to: 'file', from: 'postgres', destination: null, companion: false, jobId: 'mgr-a', jobIds: ['mgr-a'], posted: true, started: 1, kept: 0, phase: 'following', loginOpened: true, sharers: [], sharersStopped: [], openedAt: '2026-10-31T00:00:00.000Z', ...over });
const writeRegistry = (instances: Record<string, unknown>[]) => {
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances: Object.fromEntries(instances.map((i: any) => [i.id, i])) }));
};
const a = () => containerManager.getBot('a')!;
const execs = (re: RegExp) => h.calls.filter(c => re.test(c.join(' ')));

beforeEach(() => {
  writeRegistry([base('a', { fleetDb })]);
  Object.assign(h, {
    urls: {}, corrupt: [], addrs: { ok: true, addresses: ['172.18.0.4'] }, deployed: {}, envAsks: [], lists: 0, listFail: false, inspectFail: [], calls: [],
    settings: { out: `${HBA}|0|0\n` }, write: { out: 'fenced\n' }, reload: { out: 't\n' }, rejects: true, sweeps: [], left: '1\n',
    vol: { out: '' }, lift: { out: '' }, strip: { out: '' }, layers: 'off|0||',
  });
  fenceTiming.probeDeadlineMs = 15_000;
  fenceTiming.probeGapMs = 250;
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('isFleetBackupScoped', () => {
  it('a URL with no address is out of scope, and no throw', () => {
    h.urls.a = { DATABASE_URL: 'not a database url' };
    expect(isFleetBackupScoped(a())).toBe(false);
  });
  it("the replication posture's public address in brackets and capitals is in scope", () => {
    writeRegistry([base('a', { fleetDb: { ...fleetDb, replication: { publicHost: '[FD00::9]', hostPort: 15432 } } })]);
    h.urls.a = { DATABASE_URL: 'postgresql://smdb:x@[fd00::9]:15432/app' };
    expect(isFleetBackupScoped(a())).toBe(true);
  });
  it('with replication on, a URL naming another host is out of scope', () => {
    writeRegistry([base('a', { fleetDb: { ...fleetDb, replication: { publicHost: 'primary.example.test', hostPort: 15432 } } })]);
    h.urls.a = { DATABASE_URL: 'postgresql://smdb:x@db.example.test:5432/app' };
    expect(isFleetBackupScoped(a())).toBe(false);
  });
  it('with no replication, a URL naming another host is out of scope', () => {
    h.urls.a = { DATABASE_URL: 'postgresql://smdb:x@db.example.test:5432/app' };
    expect(isFleetBackupScoped(a())).toBe(false);
  });
});

describe('fenceMigrateSource', () => {
  it('with no managed database on record', async () => {
    writeRegistry([base('a')]);
    expect(await fenceMigrateSource(a(), 'migrate:1')).toBe('the bot has no managed database on record');
  });
  it('docker cannot list the addresses', async () => {
    h.addrs = { ok: false, error: 'docker did not answer' };
    expect(await fenceMigrateSource(a(), 'migrate:1')).toBe("docker did not say which addresses the bot's container has (docker did not answer)");
  });
  it('docker lists no address', async () => {
    h.addrs = { ok: true, addresses: [] };
    expect(await fenceMigrateSource(a(), 'migrate:1')).toBe("docker reports no address for the bot's container");
    expect(execs(/hba_file/)).toHaveLength(0);
  });
  it('the settings read fails', async () => {
    h.settings = { out: '', err: 'psql: error: connection refused' };
    expect(await fenceMigrateSource(a(), 'migrate:1')).toBe("the database's settings could not be read (psql: error: connection refused)");
  });
  const unknown = (out: string) => `the database's settings read back in an unknown form (${out})`;
  for (const [name, out] of [
    ['a timeout with a leading letter', `${HBA}|a1|0`],
    ['a timeout with a trailing letter', `${HBA}|1a|0`],
    ['a count with a leading letter', `${HBA}|0|a1`],
    ['a count with a trailing letter', `${HBA}|0|1a`],
  ] as const) {
    it(`an unknown form: ${name}`, async () => {
      h.settings = { out: `${out}\n` };
      expect(await fenceMigrateSource(a(), 'migrate:1')).toBe(unknown(out));
      expect(execs(/echo fenced/)).toHaveLength(0);
    });
  }
  it('two-digit fields read as numbers', async () => {
    h.settings = { out: `${HBA}|10|00\n` };
    fenceTiming.probeDeadlineMs = 50;
    h.rejects = false;
    expect(await fenceMigrateSource(a(), 'migrate:1')).toBe('the database still did not refuse a TCP connection 0.05 s after the reload of its rewritten pg_hba.conf');
  });
  it('an empty read names "empty", and a long one is cut at 200 characters', async () => {
    h.settings = { out: '\n' };
    expect(await fenceMigrateSource(a(), 'migrate:1')).toBe(unknown('empty'));
    const long = 'x'.repeat(300);
    h.settings = { out: `${long}\n` };
    expect(await fenceMigrateSource(a(), 'migrate:1')).toBe(unknown('x'.repeat(200)));
  });
  it('pg_hba in another file, or an unnamed one', async () => {
    h.settings = { out: '/etc/pg_hba.conf|0|0\n' };
    expect(await fenceMigrateSource(a(), 'migrate:1')).toBe(`the database reads its pg_hba from /etc/pg_hba.conf, not ${HBA}`);
    h.settings = { out: '|0|0\n' };
    expect(await fenceMigrateSource(a(), 'migrate:1')).toBe(`the database reads its pg_hba from an unnamed file, not ${HBA}`);
  });
  it('the write runs the script as root through sh -c', async () => {
    h.addrs = { ok: true, addresses: ['172.18.0.4', 'fd00::4'] };
    expect(await fenceMigrateSource(a(), 'migrate:1', { refresh: true })).toBeNull();
    expect(execs(/echo fenced/)).toEqual([['exec', '-u', 'root', 'bot-a-postgres', 'sh', '-c', migrateFenceHbaScript('migrate:1', ['172.18.0.4', 'fd00::4'])]]);
  });
  it('the write fails', async () => {
    h.write = { out: '', err: 'Error response from daemon: container is restarting' };
    expect(await fenceMigrateSource(a(), 'migrate:1')).toBe('pg_hba.conf could not be rewritten (Error response from daemon: container is restarting)');
  });
  it("another owner's lines are held", async () => {
    h.write = { out: 'held-hba restore:1700000000000\n' };
    expect(await fenceMigrateSource(a(), 'migrate:1')).toBe('a write fence of a restore (started 2023-11-14 22:13 UTC) stands in its pg_hba.conf');
  });
  it('a write that did not print fenced', async () => {
    h.write = { out: 'mv: cannot move\n' };
    expect(await fenceMigrateSource(a(), 'migrate:1')).toBe('pg_hba.conf could not be rewritten (mv: cannot move)');
    expect(execs(/pg_reload_conf/)).toHaveLength(0);
  });
  it('the reload fails', async () => {
    h.reload = { out: '', err: 'psql: error: server closed the connection' };
    expect(await fenceMigrateSource(a(), 'migrate:1')).toBe('the rewritten pg_hba.conf could not be reloaded (psql: error: server closed the connection)');
  });
  it('a first sweep that leaves a session answers its reason', async () => {
    h.sweeps = ['123|f\n'];
    expect(await fenceMigrateSource(a(), 'migrate:1')).toBe('1 open session(s) did not end within 5 s of being terminated');
  });
  it('the sweep names the admitted addresses and escapes the role', async () => {
    writeRegistry([base('a', { fleetDb: { ...fleetDb, user: "o'b" } })]);
    h.addrs = { ok: true, addresses: ['172.18.0.4', 'fd00::4'] };
    expect(await fenceMigrateSource(a(), 'migrate:1', { refresh: true })).toBeNull();
    const sweeps = execs(/pg_terminate_backend/).map(c => c.join(' '));
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]).toContain("host(client_addr) NOT IN ('172.18.0.4', 'fd00::4') AND (backend_type = 'walsender' OR usename IS DISTINCT FROM 'o''b')");
  });
  it('without refresh, the second sweep waits authentication_timeout seconds', async () => {
    h.settings = { out: `${HBA}|1|0\n` };
    const t0 = Date.now();
    expect(await fenceMigrateSource(a(), 'migrate:1')).toBeNull();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect(execs(/pg_terminate_backend/)).toHaveLength(2);
  });
});

describe('liftMigrateFence', () => {
  it('the live lift runs the script as root through sh -c', async () => {
    expect(await liftMigrateFence(fleetDb, 'migrate:1')).toEqual({ result: 'lifted' });
    expect(execs(/stripped-hba/)).toEqual([['exec', '-u', 'root', 'bot-a-postgres', 'sh', '-c', liftMigrateFenceScript('migrate:1')]]);
  });
  const down = { out: '', err: 'Error response from daemon: container bot-a-postgres is not running' };
  it('the volume is gone', async () => {
    h.lift = down;
    h.vol = { out: '', err: 'Error response from daemon: get bot-a-postgres-data: no such volume' };
    expect(await liftMigrateFence(fleetDb, 'migrate:1')).toEqual({ result: 'gone' });
    expect(execs(/^run /)).toHaveLength(0);
  });
  it('docker does not say whether the volume exists', async () => {
    h.lift = down;
    h.vol = { out: '', err: 'Cannot connect to the Docker daemon' };
    expect(await liftMigrateFence(fleetDb, 'migrate:1')).toEqual({ result: 'unknown' });
    expect(execs(/^run /)).toHaveLength(0);
  });
  it('the strip on the volume runs a throwaway postgres with the volume mounted', async () => {
    h.lift = down;
    h.strip = { out: 'stripped-hba\n' };
    expect(await liftMigrateFence(fleetDb, 'migrate:1')).toEqual({ result: 'stripped' });
    expect(execs(/^run /)).toEqual([['run', '--rm', '-v', 'bot-a-postgres-data:/pgdata', '--entrypoint', 'sh', 'postgres:16-alpine', '-c', liftMigrateFenceScript('migrate:1', '/pgdata')]]);
  });
  it("a strip that fails is locked, with docker's line", async () => {
    h.lift = down;
    h.strip = { out: '', err: 'Error response from daemon: volume is in use' };
    expect(await liftMigrateFence(fleetDb, 'migrate:1')).toEqual({ result: 'locked', detail: 'Error response from daemon: volume is in use' });
  });
});

describe("fenceStartWarning and the migration's own lines", () => {
  it('a read-only layer beside the open migration\'s own lines still warns', async () => {
    writeRegistry([base('a', { fleetDb, migrate: record({ hbaFence: 'migrate:1' }) })]);
    h.layers = 'on|4|migrate:1|migrate:1';
    expect(await fenceStartWarning('a')).toContain('the pg_hba lines of a write fence');
  });
  it("lines of another owner than the open migration's warn", async () => {
    writeRegistry([base('a', { fleetDb, migrate: record({ hbaFence: 'migrate:1' }) })]);
    h.layers = 'off|4||restore:5';
    expect(await fenceStartWarning('a')).toContain('the pg_hba lines of a write fence');
  });
});

describe('databaseSharers', () => {
  const other = (id: string, url: string, extra: Record<string, unknown> = {}) => { h.urls[id] = { DATABASE_URL: url }; return base(id, extra); };
  const ids = (url = '') => databaseSharers(a(), url).map(b => b.id);
  it("a bot naming the managed container in capitals' lower-case form shares it, and a blank url does not throw", () => {
    writeRegistry([base('a', { fleetDb: { ...fleetDb, containerName: 'Bot-A-Postgres' } }), other('b', 'postgresql://u:p@bot-a-postgres:5432/app')]);
    expect(ids()).toEqual(['a', 'b']);
  });
  it("a bot naming the replication address shares it", () => {
    writeRegistry([base('a', { fleetDb: { ...fleetDb, replication: { publicHost: '[FD00::9]', hostPort: 15432 } } }), other('b', 'postgresql://u:p@[fd00::9]:15432/app')]);
    expect(ids()).toEqual(['a', 'b']);
  });
  it('the instance itself is listed once, even when its own store cannot be read', () => {
    h.urls.a = { DATABASE_URL: 'postgresql://u:p@bot-a-postgres:5432/app' };
    expect(ids('postgresql://u:p@bot-a-postgres:5432/app')).toEqual(['a']);
    h.corrupt = ['a'];
    expect(ids('postgresql://u:p@bot-a-postgres:5432/app')).toEqual(['a']);
  });
  it('a bot whose store is corrupt is left out', () => {
    writeRegistry([base('a', { fleetDb }), other('b', 'postgresql://u:p@bot-a-postgres:5432/app')]);
    h.corrupt = ['b'];
    expect(ids()).toEqual(['a']);
  });
  it('a bot whose URL is in a form is left out', () => {
    writeRegistry([base('a', { fleetDb }), other('b', 'postgresql://u:p@bot-a-postgres:5432/app?host=db.example.test')]);
    expect(ids()).toEqual(['a']);
  });
});

describe('runningDatabaseSharers', () => {
  it('asks docker only about bots not already sharing, and leaves out a deployed url that PGPORT puts in a form', async () => {
    const { runningDatabaseSharers } = await import('../../src/instance/fleetBackup');
    h.urls.b = { DATABASE_URL: 'postgresql://u:p@bot-a-postgres:5432/app' };
    writeRegistry([base('a', { fleetDb }), base('b'), base('c'), base('d')]);
    h.deployed.c = { DATABASE_URL: 'postgresql://u:p@bot-a-postgres:5432/app' };
    h.deployed.d = { DATABASE_URL: 'postgresql://u:p@bot-a-postgres/app', PGPORT: '5432' };
    const found = await runningDatabaseSharers(a(), '');
    expect(found.bots.map(b => b.id)).toEqual(['a', 'b', 'c']);
    expect(found.unchecked).toEqual([]);
    expect(h.envAsks).toEqual(['c', 'd']);
    expect(h.lists).toBe(1);
  });
  const registry = () => {
    h.urls.b = { DATABASE_URL: 'postgresql://u:p@bot-a-postgres:5432/app' };
    writeRegistry([base('a', { fleetDb }), base('b'), base('c'), base('d')]);
    h.deployed.c = { DATABASE_URL: 'postgresql://u:p@bot-a-postgres:5432/app' };
    h.deployed.d = { DATABASE_URL: 'postgresql://u:p@bot-a-postgres/app', PGPORT: '5432' };
  };
  it('(NM16) with no listing, the bots it could not check are named unchecked', async () => {
    const { runningDatabaseSharers } = await import('../../src/instance/fleetBackup');
    registry();
    h.listFail = true;
    const found = await runningDatabaseSharers(a(), '');
    expect(found.bots.map(b => b.id)).toEqual(['a', 'b']);
    expect(found.unchecked).toEqual(['c', 'd']);
    expect(h.envAsks).toEqual([]);
  });
  it('(NM16) an inspect that fails names its bot unchecked', async () => {
    const { runningDatabaseSharers } = await import('../../src/instance/fleetBackup');
    registry();
    h.inspectFail = ['c'];
    const found = await runningDatabaseSharers(a(), '');
    expect(found.bots.map(b => b.id)).toEqual(['a', 'b']);
    expect(found.unchecked).toEqual(['c']);
  });
  it('(NM16) with no candidate the listing is not read', async () => {
    const { runningDatabaseSharers } = await import('../../src/instance/fleetBackup');
    h.urls.b = { DATABASE_URL: 'postgresql://u:p@bot-a-postgres:5432/app' };
    writeRegistry([base('a', { fleetDb }), base('b')]);
    expect((await runningDatabaseSharers(a(), '')).bots.map(b => b.id)).toEqual(['a', 'b']);
    expect(h.lists).toBe(0);
  });
});

describe("the remedy a seeded restore fence names while a migration holds the database", () => {
  const seeded = async () => {
    vi.resetModules();
    const fb = await import('../../src/instance/fleetBackup');
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation((() => 0) as unknown as typeof setInterval);
    fb.startFleetBackupScheduler();
    spy.mockRestore();
    fb.stopFleetBackupScheduler();
    await vi.waitFor(() => expect(fb.getFleetFenceStuck('a')).not.toBeNull());
    return fb.getFleetFenceStuck('a')!;
  };
  it("this bot's own open migration", async () => {
    writeRegistry([base('a', { fleetDb, migrate: record() })]);
    h.layers = 'on|0|restore:1700000000000|';
    expect(await seeded()).toContain('it belongs to a restore (started 2023-11-14 22:13 UTC), and finish the migration with Migrate, then run a restore again with the bot in Maintenance or Off to retry the lift');
  });
  it("another bot's open migration that names this bot", async () => {
    writeRegistry([base('a', { fleetDb }), base('b', { migrate: record({ sharers: ['a'] }) })]);
    h.layers = 'on|0|restore:1700000000000|';
    expect(await seeded()).toContain("and finish Bot B's migration with Migrate, then run a restore again with the bot in Maintenance or Off to retry the lift");
  });
});
