// NM20 part 5: the whole-bot restore with the three logins (design "The build parts", Part 5; R3.6, S2, X1, Y1, Y4,
// Y7, U1, Q2, P1). Every docker call is faked: execFile by restore-fake and fence-fake, spawn by the TOC, meta and
// dump fakes; no row reaches the docker CLI.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm20-code5-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

const pg = vi.hoisted(() => ({
  events: [] as string[],
  exec: [] as string[][],
  spawned: [] as string[][],
  exists: '1',
  restoreFail: null as string | null,
  dumpFail: null as string | null,
  restoreHang: false,
  atRestore: null as null | (() => void),
}));

vi.mock('../../src/config/appCapabilities', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/config/appCapabilities')>();
  return { ...real, findAppCapabilities: () => ({ companionDb: { env: { url: 'DATABASE_URL' } } }) };
});
vi.mock('../../src/env/manager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/env/manager')>();
  return {
    ...real,
    getEnvVarsWithStatus: () => ({ vars: { DATABASE_URL: 'postgres://app:pw@bot-a-postgres/app' }, corrupt: false, undecryptable: [], encrypted: [] }),
    getEnvVars: () => ({ DATABASE_URL: 'postgres://app:pw@bot-a-postgres/app' }),
  };
});
vi.mock('../../src/instance/appHookClient', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/instance/appHookClient')>();
  return { ...real, callAppHook: async () => ({ ok: true, status: 200, body: { success: true } }) };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return {
    ...real,
    isShuttingDown: () => false,
    appContainerRunning: async () => false,
    runningInstanceContainers: async () => [],
    startFleetDbSidecar: async () => ({ success: true }),
    stopBot: async () => ({ success: true }),
    startBot: async () => ({ success: true }),
    stopBotInOp: async () => ({ success: true }),
    startBotInOp: async () => ({ success: true }),
  };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = require('events') as typeof import('events');
  const { PassThrough } = require('stream') as typeof import('stream');
  const execFile = vi.fn((_cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (err: Error | null, stdout: string, stderr: string) => void;
    const sql = args.join(' ');
    if (args[0] === 'inspect') return cb(null, 'true\n', '');
    const readOnlyOn = ((globalThis as any).__fenceOwners as Map<string, string> | undefined)?.has('bot-a-postgres') === true;
    if (sql.endsWith("SELECT current_setting('default_transaction_read_only')") || sql.includes('SHOW default_transaction_read_only')) return cb(null, readOnlyOn ? 'on\n' : 'off\n', '');
    if (sql.includes('ALTER SYSTEM SET default_transaction_read_only = on')) { pg.events.push('fence'); return cb(null, '0\n', ''); }
    if (sql.includes('ALTER SYSTEM RESET')) { pg.events.push('lift'); return cb(null, '', ''); }
    if (sql.includes('FROM pg_database WHERE datname')) return cb(null, `${pg.exists}\n`, '');
    if (sql.includes('DROP DATABASE')) pg.events.push('drop');
    return cb(null, '', '');
  });
  const spawn = vi.fn((_cmd: string, args: string[]) => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.resume();
    child.kill = () => { setTimeout(() => child.emit('close', 137), 1); return true; };
    const isDump = args.includes('pg_dump');
    pg.events.push(isDump ? 'dump' : 'pg_restore');
    if (!isDump) pg.atRestore?.();
    if (!isDump && pg.restoreHang) return child;
    const failText = isDump ? pg.dumpFail : pg.restoreFail;
    const failing = failText !== null;
    setTimeout(() => {
      child.stdout.end(isDump ? 'dump' : '');
      child.stderr.end(failing ? failText : '');
      setTimeout(() => child.emit('close', failing ? 1 : 0), 5);
    }, 5);
    return child;
  });
  const fakes = await import('./restore-fake');
  const fenced = (await import('./fence-fake')).withFence(fakes.withRestoreFakes(execFile as any));
  const loggedExec = ((cmd: string, args: string[], a: unknown, b?: unknown) => { pg.exec.push([...args]); return (fenced as any)(cmd, args, a, b); }) as typeof fenced;
  const held = (await import('./dump-fake')).withDumpHolder(fakes.withTocFake(spawn as any));
  const loggedSpawn = ((cmd: string, args: string[], opts?: any) => { pg.spawned.push([...args]); return (held as any)(cmd, args, opts); }) as typeof held;
  return { ...real, execFile: loggedExec, spawn: loggedSpawn, default: { ...real, execFile: loggedExec, spawn: loggedSpawn } };
});

import * as fs from 'fs';
import * as path from 'path';
import * as fleetBackup from '../../src/instance/fleetBackup';
import { MANAGER_SESSION_OPTIONS } from '../../src/instance/dbLogin';
import { addressTableSql } from '../../src/instance/fleetReplication';
import { GENERATION_SCHEMA_SQL } from '../../src/instance/switchSql';
import { fenceOwners } from './fence-fake';
import { claimDb, resetClaimDb, MAINTAINED, writeDumpMeta, COUNTS_OF, TOC, managerTocOf } from './restore-fake';
import { holder, resetHolder } from './dump-fake';

const fb = fleetBackup as any;
const REGISTRY = path.join(tmp.dir, 'instances.json');
const DIR = path.join(tmp.dir, 'backups', 'a', 'fleet-postgres');
const C = 'bot-a-postgres';
const primary = { containerName: C, user: 'app', db: 'app', volume: 'bot-a-pgdata' };
const REPL = { role: 'replicator', password: 'rpw', hostPort: 5433, publicHost: 'main.example', certHost: 'main.example' };
const EXEMPT = 'PGOPTIONS=-c default_transaction_read_only=off';
const PINNED = `PGOPTIONS=${MANAGER_SESSION_OPTIONS}`;
const PINNED_EXEMPT = `PGOPTIONS=${MANAGER_SESSION_OPTIONS} -c default_transaction_read_only=off`;

// A real certificate, as part 2's PG row printed it (linux-pg-part2.txt).
const CERT = ['-----BEGIN CERTIFICATE-----', 'MIIBnjCCAUSgAwIBAgIUCdC6jqTA0KJPSvixvqeQ7rZT39QwCgYIKoZIzj0EAwIw',
  'FzEVMBMGA1UEAwwMbWFpbi5pbnZhbGlkMCAXDTI2MTAyODAxMjY0MFoYDzIxMjYx', 'MDA0MDEyNjQwWjAXMRUwEwYDVQQDDAxtYWluLmludmFsaWQwWTATBgcqhkjOPQIB',
  'BggqhkjOPQMBBwNCAASRPbp3SsddkY9w48HQKxdKQm+KcdCJlurZZ7lMkAgxMu6O', 'oIMsl9m1l5cF4xWW6wTFcoaxLuPmM+Bru2l5IQKAo2wwajAdBgNVHQ4EFgQU9iRY',
  'ynGzhKuwX6ipxP7MRRWhY1swHwYDVR0jBBgwFoAU9iRYynGzhKuwX6ipxP7MRRWh', 'Y1swDwYDVR0TAQH/BAUwAwEB/zAXBgNVHREEEDAOggxtYWluLmludmFsaWQwCgYI',
  'KoZIzj0EAwIDSAAwRQIgCrtXiXXcBEWI6/0Pgmm/N7TKG5o4Ge7DfodRmtlYUcIC', 'IQCXClqYgouUKNSxR1ZTEAiDoJtJI8Spkz097udf4vHrKw==', '-----END CERTIFICATE-----'].join('\n');
const CERT_COPY = CERT.replace(/\n/g, '\\n');
const TS = '2026-11-13 11:32:24.265756+00';

const entry = (table: string) => `--\n-- Data for Name: ${table}; Type: TABLE DATA; Schema: smdb_manager; Owner: dbm_meta\n--\n\n`;
const GEN_BLOCK = `${entry('generation')}COPY smdb_manager.generation (one_row, machine, generation, since) FROM stdin;\nt\tmain.example\t3\t${TS}\n\\.\n\n\n`;
const addressRow = (host: string, port: number | string, cert = CERT_COPY, at = TS) => `${host}\t${port}\t\\N\t${cert}\tmain.example\t${at}\n`;
/** pg_restore --data-only -n smdb_manager -f - of a dump, in pg_restore 16's form. */
const metaDump = (blocks: string) => `--\n-- PostgreSQL database dump\n--\n\nSET statement_timeout = 0;\nSET row_security = off;\n\n${blocks}--\n-- PostgreSQL database dump complete\n--\n\n`;
/** The TOC of a dump that holds the manager's tables too. */
const META_TOC = `${TOC.claims}6; 2615 16399 SCHEMA - smdb_manager dbm_meta\n220; 1259 16400 TABLE smdb_manager generation dbm_meta\n`
  + '222; 1259 16404 TABLE smdb_manager addresses dbm_meta\n3368; 0 16400 TABLE DATA smdb_manager generation dbm_meta\n3370; 0 16404 TABLE DATA smdb_manager addresses dbm_meta\n';
const addressBlock = (rows: string[]) => `${entry('addresses')}COPY smdb_manager.addresses (host, port, slot, cert, machine, updated_at) FROM stdin;\n${rows.join('')}\\.\n\n\n`;

function writeRegistry(fleetDb: Record<string, unknown> = primary): void {
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: {
    a: { id: 'a', displayName: 'Bot A', sanitizedName: 'bot-a', status: 'running', sourceUrl: 'https://example.invalid/fake/app', createdAt: '2026-10-01T00:00:00.000Z', fleetDb, fleetBackup: { enabled: false, hour: 4, keep: 7 }, ...MAINTAINED },
  } }, null, 2));
}
const registryA = () => JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')).instances.a;
const restore = (file = 'old.dump') => fleetBackup.restoreFleetBackup('a', file);
const dropped = () => pg.events.includes('drop');
const execWith = (mark: string) => pg.exec.find(a => a.join(' ').includes(mark)) ?? null;
const lastArg = (a: string[] | null) => (a ? a[a.length - 1] : '');

let logs: string[] = [];
beforeEach(() => {
  Object.assign(pg, { exists: '1', restoreFail: null, dumpFail: null, restoreHang: false, atRestore: null });
  pg.events.length = 0;
  pg.exec.length = 0;
  pg.spawned.length = 0;
  resetClaimDb();
  resetHolder();
  claimDb.metaText = metaDump(GEN_BLOCK);
  fenceOwners.clear();
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, 'old.dump'), 'dump');
  writeDumpMeta(DIR, 'old.dump');
  fleetBackup.clearClaimFloor('a');
  fleetBackup.dismissFleetRestoreError('a');
  writeRegistry();
  fs.mkdirSync(path.join(tmp.dir, 'bots', 'a'), { recursive: true });
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((m: unknown) => { logs.push(String(m)); });
  vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { logs.push(String(m)); });
  vi.spyOn(console, 'error').mockImplementation((m: unknown) => { logs.push(String(m)); });
});
afterAll(() => { vi.restoreAllMocks(); fs.rmSync(tmp.dir, { recursive: true, force: true }); });

describe('restoreLists (S2, X1: only the other list)', () => {
  const HEAD = ';\n; Archive created at 2026-11-13 02:28:00 UTC\n;\n; Selected TOC Entries:\n;\n';
  const KEEP = [
    '5; 2615 16385 SCHEMA - smdb_data app',
    '216; 1259 16386 TABLE smdb_data guild_ownership app',
    '217; 1259 16392 SEQUENCE smdb_data claim_seq app',
    '3360; 0 16386 TABLE DATA smdb_data guild_ownership app',
    '3367; 0 0 SEQUENCE SET smdb_data claim_seq app',
    '3200; 2606 16391 CONSTRAINT smdb_data guild_ownership guild_ownership_pkey app',
    '3201; 2606 16393 FK CONSTRAINT smdb_data guild_ownership guild_ownership_fk app',
    '3202; 1259 16394 INDEX smdb_data guild_ownership_idx app',
    '3400; 0 0 COMMENT - EXTENSION plpgsql',
    '3401; 0 0 ACL - SCHEMA public pg_database_owner',
    '3402; 0 0 COMMENT - SCHEMA smdb_data app',
    '218; 1259 16410 TABLE smdb_data smdb_manager_notes app',
    '219; 1255 16411 FUNCTION public smdb_manager() app',
    '3403; 826 16412 DEFAULT ACL smdb_data DEFAULT PRIVILEGES FOR TABLES app',
  ];
  const DROP = [
    '6; 2615 16399 SCHEMA - smdb_manager dbm_meta',
    '220; 1259 16400 TABLE smdb_manager generation dbm_meta',
    '3368; 0 16400 TABLE DATA smdb_manager generation dbm_meta',
    '3210; 2606 16401 CONSTRAINT smdb_manager generation generation_pkey dbm_meta',
    '3404; 0 0 COMMENT - SCHEMA smdb_manager dbm_meta',
    '3405; 0 0 ACL - SCHEMA smdb_manager dbm_meta',
    '3406; 0 0 ACL smdb_manager TABLE generation dbm_meta',
    '3407; 826 16413 DEFAULT ACL smdb_manager DEFAULT PRIVILEGES FOR TABLES dbm_meta',
    '221; 1259 16402 SEQUENCE smdb_manager s dbm_meta',
    '3369; 0 0 SEQUENCE SET smdb_manager s dbm_meta',
  ];

  it('drops every smdb_manager entry, the schema with its comment and ACLs, and keeps the rest and the comments', () => {
    const toc = `${HEAD}${[...KEEP.slice(0, 7), ...DROP, ...KEEP.slice(7)].join('\n')}\n`;
    const managerToc = `${HEAD}${DROP.filter(line => !line.includes(' - SCHEMA smdb_manager ') && !line.includes(' SCHEMA - smdb_manager ')).join('\n')}\n`;
    const other = fb.restoreLists(toc, managerToc).other as string;
    for (const line of KEEP) expect(other.split('\n')).toContain(line);
    for (const line of DROP) expect(other.split('\n')).not.toContain(line);
    for (const line of HEAD.split('\n').filter(Boolean)) expect(other.split('\n')).toContain(line);
  });

  it('keeps the TOC fixtures of the landed restore rows whole', () => {
    expect(fb.restoreLists(TOC.shards, managerTocOf(TOC.shards)).other).toBe(TOC.shards);
  });
});

describe('the restore in its final order (Part 5)', () => {
  it('RS2: a clean dump runs the meta read, the reset, the list, the recreate, the meta transaction, pg_restore, counts, raise and generation in order', async () => {
    const r = await restore();
    expect(r.error).toBeUndefined();
    expect(r.success).toBe(true);
    expect(claimDb.steps5).toEqual(['meta-read', 'reset', 'list', 'meta-tx', 'pg_restore']);
    const order = pg.events.filter(e => ['fence', 'drop', 'dump'].includes(e));
    expect(order).toEqual(['fence', 'dump', 'drop']);
    expect(r.steps.counts?.result).toBe('matched');
    expect(claimDb.genEvents).toContain('gen-write');
  });

  it('the meta read is pg_restore with no database, the dump on stdin, killed in the container', async () => {
    await restore();
    expect(claimDb.metaReadArgs).toEqual(['exec', '-i', C, 'timeout', '-s', 'KILL', '600', 'pg_restore', '--data-only', '-n', 'smdb_manager', '-f', '-']);
  });

  it('A3 reset: dbm_admin on postgres, fence-exempt, the database statements and grants of step 4 (R3.6, U1)', async () => {
    await restore();
    const args = claimDb.resetArgs!;
    expect(args.slice(0, 3)).toEqual(['exec', '-e', EXEMPT]);
    expect(args).toEqual(expect.arrayContaining(['-U', 'dbm_admin', '-d', 'postgres']));
    const sql = lastArg(args);
    for (const s of ['ALTER DATABASE "app" IS_TEMPLATE false;', 'ALTER DATABASE "app" ALLOW_CONNECTIONS true;', 'ALTER DATABASE "app" CONNECTION LIMIT -1;',
      'ALTER DATABASE "app" RESET ALL;', 'GRANT CONNECT, CREATE ON DATABASE "app" TO dbm_meta;', 'GRANT CONNECT ON DATABASE "app" TO dbm_work;']) expect(sql).toContain(s);
  });

  it('no reset and no safety dump on a missing database', async () => {
    pg.exists = '0';
    const r = await restore();
    expect(r.success).toBe(true);
    expect(claimDb.resetArgs).toBeNull();
    expect(pg.events).not.toContain('dump');
  });

  it('RS1: a failed reset refuses the restore with RS-RESET and psql\'s last line; nothing dumped or dropped', async () => {
    claimDb.fail5 = 'reset';
    claimDb.fail5Text = 'WARNING:  something\nERROR:  permission denied to alter database';
    const r = await restore();
    expect(r.success).toBe(false);
    expect(r.error).toBe("Could not reset the database's own settings before the restore, so the restore was refused, and nothing was changed: ERROR:  permission denied to alter database");
    expect(pg.events).not.toContain('dump');
    expect(dropped()).toBe(false);
    expect(fenceOwners.has(C)).toBe(false);
  });

  it('the recreate grants step 4 after CREATE DATABASE, as dbm_admin on postgres', async () => {
    await restore();
    const args = claimDb.recreateArgs!;
    expect(args).toEqual(expect.arrayContaining(['-U', 'dbm_admin', '-d', 'postgres']));
    const joined = args.join(' ');
    expect(joined.indexOf('GRANT CONNECT, CREATE ON DATABASE "app" TO dbm_meta')).toBeGreaterThan(joined.indexOf('CREATE DATABASE "app" OWNER "app"'));
    expect(joined).toContain('GRANT CONNECT ON DATABASE "app" TO dbm_work');
  });

  it('the list is the other list of the TOC, written into the container before the drop', async () => {
    claimDb.toc = 'shards';
    writeDumpMeta(DIR, 'old.dump', COUNTS_OF.shards);
    await restore();
    expect(claimDb.listArgs).toEqual(['exec', '-i', C, 'sh', '-c', 'cat > /tmp/smdb-restore.list']);
    expect(claimDb.listText).toBe(fb.restoreLists(TOC.shards, managerTocOf(TOC.shards)).other);
  });

  it('a failed list write refuses before the drop', async () => {
    claimDb.fail5 = 'list';
    claimDb.fail5Text = 'sh: cannot create /tmp/smdb-restore.list: No space left on device';
    const r = await restore();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^The restore list could not be written into the database container, so the restore was refused; only the database's own settings and its grants to dbm_meta and dbm_work were reset \(its connection limit, its template and connection flags, its database-level settings and those grants\): sh: cannot create/);
    expect(dropped()).toBe(false);
  });

  it('the meta transaction: dbm_meta, pinned and fence-exempt, on stdin, its BEGIN and COMMIT in the script (X1, Y6, U1, fix 5b)', async () => {
    await restore();
    const args = claimDb.metaTxArgs!;
    expect(args.slice(0, 5)).toEqual(['exec', '-e', PINNED_EXEMPT, '-i', C]);
    expect(args).toEqual(expect.arrayContaining(['psql', '-U', 'dbm_meta', '-d', 'app', '-v', 'ON_ERROR_STOP=1']));
    expect(args).not.toContain('--single-transaction');
    expect(args).not.toContain('-1');
    for (const a of args) expect(a.length).toBeLessThan(4096);
    const script = claimDb.metaScript!;
    expect(script.startsWith('BEGIN;\nCREATE SCHEMA smdb_manager;\nGRANT USAGE ON SCHEMA smdb_manager TO PUBLIC, dbm_work;\nALTER DEFAULT PRIVILEGES IN SCHEMA smdb_manager GRANT SELECT ON TABLES TO dbm_work;\n')).toBe(true);
    expect(script).toContain(GENERATION_SCHEMA_SQL);
    expect(script).toContain('CREATE TABLE IF NOT EXISTS smdb_manager.addresses');
    expect(script).not.toContain('INSERT INTO smdb_manager.addresses');
    expect(script).toContain("INSERT INTO smdb_manager.generation (one_row, machine, generation, since) VALUES (true, 'main.example', 3, '2026-11-13 11:32:24.265756+00'::timestamptz);");
    expect(script.endsWith('GRANT SELECT ON ALL TABLES IN SCHEMA smdb_manager TO dbm_work;\nCOMMIT;\n')).toBe(true);
    expect(script.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(`BEGIN;\n${fb.metaTransactionSql('X;\n')}COMMIT;\n`).toBe(script.replace(/INSERT INTO smdb_manager\.generation[^\n]*\n/, 'X;\n'));
  });

  it('the pg_restore runs as dbm_work with the bot role, no owner, no privileges and the list (R3.6)', async () => {
    await restore();
    expect(claimDb.restoreArgs).toHaveLength(1);
    expect(claimDb.restoreArgs[0]).toEqual(['exec', '-e', PINNED_EXEMPT, '-i', C, 'timeout', '-s', 'KILL', '600',
      'pg_restore', '-U', 'dbm_work', '-d', 'app', '--role=app', '--no-owner', '--no-privileges', '--exit-on-error', '-L', '/tmp/smdb-restore.list']);
  });

  it('a failed meta transaction fails the restore past the drop, with no pg_restore and the fence kept', async () => {
    claimDb.fail5 = 'meta-tx';
    claimDb.fail5Text = 'ERROR:  could not extend file: No space left on device';
    const r = await restore();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^Restore failed: the manager's tables could not be written \(ERROR: {2}could not extend file: No space left on device\)\. /);
    expect(claimDb.restoreArgs).toEqual([]);
    expect(fleetBackup.getFleetFenceStuck('a')).toMatch(/READ-ONLY/);
  });

  it('U1: the probe, the counts and the generation read carry no exemption; the raise and the generation write do', async () => {
    await restore();
    const claimRead = execWith("to_regclass('smdb_data.claim_seq')")!;
    expect(claimRead.slice(0, 4)).toEqual(['exec', '-e', PINNED, C]);
    expect(claimRead).toEqual(expect.arrayContaining(['-U', 'dbm_work', '-d', 'app']));
    const floor = execWith('SELECT coalesce(GREATEST(')!;
    expect(floor.slice(0, 4)).toEqual(['exec', '-e', PINNED, C]);
    const count = execWith('SELECT count(*) AS c FROM')!;
    expect(count.slice(0, 4)).toEqual(['exec', '-e', PINNED, C]);
    expect(count).toEqual(expect.arrayContaining(['-U', 'dbm_work']));
    const raise = execWith("setval('smdb_data.claim_seq'")!;
    expect(raise.slice(0, 4)).toEqual(['exec', '-e', PINNED_EXEMPT, C]);
    expect(raise).toEqual(expect.arrayContaining(['-U', 'dbm_work', '-d', 'app']));
    const genRead = pg.exec.filter(a => a.join(' ').includes("FROM smdb_manager.generation), '0||')") && !a.join(' ').includes('INSERT INTO'));
    expect(genRead.length).toBe(2);
    for (const a of genRead) {
      expect(a.slice(0, 4)).toEqual(['exec', '-e', PINNED, C]);
      expect(a).toEqual(expect.arrayContaining(['-U', 'dbm_meta', '-d', 'app']));
    }
    const genWrite = execWith('INSERT INTO smdb_manager.generation')!;
    expect(genWrite.slice(0, 4)).toEqual(['exec', '-e', PINNED_EXEMPT, C]);
    expect(genWrite).toEqual(expect.arrayContaining(['-U', 'dbm_meta']));
  });

  it('S1: the restore record and the receive mark are written as dbm_admin on postgres', async () => {
    await restore();
    for (const mark of ['INSERT INTO smdb_manager.restore_state', 'UPDATE smdb_manager.restore_state SET pending = false']) {
      const a = execWith(mark)!;
      expect(a).toEqual(expect.arrayContaining(['-U', 'dbm_admin', '-d', 'postgres', '-q']));
    }
  });

  it('G1: no dbm_admin call of the whole restore names a database other than postgres', async () => {
    await restore();
    for (const a of [...pg.exec, ...pg.spawned]) {
      const u = a.indexOf('-U');
      if (u < 0 || a[u + 1] !== 'dbm_admin') continue;
      expect(a[a.indexOf('-d') + 1]).toBe('postgres');
    }
  });

  it('the safety dump and its snapshot holder run as dbm_work, pinned', async () => {
    await restore();
    const h = holder.spawned[0];
    expect(h.slice(0, 5)).toEqual(['exec', '-e', PINNED, '-i', C]);
    expect(h).toEqual(expect.arrayContaining(['psql', '-U', 'dbm_work', '-d', 'app', '-X', '-q']));
    const dump = pg.spawned.find(a => a.includes('pg_dump'))!;
    expect(dump).toEqual(['exec', '-e', PINNED, C, 'pg_dump', '-U', 'dbm_work', '-d', 'app', '-Fc', '--snapshot=00000003-0000001B-1']);
  });

  it('RS4: pg_restore refused as dbm_work fails with its message, the fence kept', async () => {
    pg.restoreFail = 'pg_restore: error: could not execute query: ERROR:  permission denied to create event trigger "et"';
    const r = await restore();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^Restore failed: pg_restore exited with code 1: pg_restore: error: could not execute query: ERROR: {2}permission denied to create event trigger "et"\. /);
    expect(fleetBackup.getFleetFenceStuck('a')).toMatch(/READ-ONLY/);
    expect(registryA().fleetRestoreError.text).toMatch(/^Restore of old\.dump failed: /);
  });

  it('W4: dump code that creates smdb_manager meets the schema dbm_meta made first, and fails through the existing text', async () => {
    pg.restoreFail = 'pg_restore: error: could not execute query: ERROR:  schema "smdb_manager" already exists';
    const r = await restore();
    expect(claimDb.steps5.indexOf('meta-tx')).toBeLessThan(claimDb.steps5.indexOf('pg_restore'));
    expect(r.error).toContain('ERROR:  schema "smdb_manager" already exists');
    expect(r.success).toBe(false);
  });

  it('RS6: while the pg_restore runs, the notice stands and the fence is on, as for a crash mid-restore', async () => {
    let seen: { notice: string | undefined; fenced: boolean } | null = null;
    pg.atRestore = () => { seen = { notice: registryA().fleetRestoreError?.text, fenced: fenceOwners.has(C) }; };
    await restore();
    expect(seen).not.toBeNull();
    expect(seen!.notice).toMatch(/^Restore of old\.dump has not finished/);
    expect(seen!.fenced).toBe(true);
  });
});

describe('the meta read before the notice and the fence (Y4, P1)', () => {
  it('Y4: a refused parse refuses with RS-META before any stop, notice or fence', async () => {
    claimDb.metaText = metaDump(`${entry('generation')}COPY smdb_manager.generation (one_row, machine, generation, since) FROM stdin;\nf\tmain.example\t3\t${TS}\n\\.\n\n`);
    const r = await restore();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^The dump old\.dump holds smdb_manager rows the manager could not read, so the restore was refused, and nothing was changed: line \d+: /);
    expect(pg.events).not.toContain('fence');
    expect(registryA().fleetRestoreError).toBeUndefined();
    expect(claimDb.steps5).toEqual(['meta-read']);
  });

  it('a meta read that fails refuses as an unreadable dump, nothing changed', async () => {
    claimDb.fail5 = 'meta-read';
    claimDb.fail5Text = 'pg_restore: error: could not read input file: end of file';
    const r = await restore();
    expect(r.success).toBe(false);
    expect(r.error).toBe('The dump old.dump could not be read, so the restore was refused, and nothing was changed: pg_restore exited with code 1: pg_restore: error: could not read input file: end of file');
    expect(pg.events).not.toContain('fence');
  });

  it('P1: with replication set, an unreadable certificate refuses before the notice and the fence', async () => {
    writeRegistry({ ...primary, replication: REPL });
    claimDb.cert = 'not a certificate';
    const r = await restore();
    expect(r.success).toBe(false);
    expect(r.error).toBe("This database's certificate could not be read for its address row, so the restore was refused, and nothing was changed: server.crt in the database container did not read as a certificate");
    expect(pg.events).not.toContain('fence');
    expect(registryA().fleetRestoreError).toBeUndefined();
    expect(claimDb.steps5).toEqual(['meta-read', 'cert']);
  });

  it('P1: with replication unset, no certificate is read', async () => {
    claimDb.cert = CERT;
    const r = await restore();
    expect(r.success).toBe(true);
    expect(claimDb.steps5).not.toContain('cert');
  });

  it('Q2: an ordinary restore with replication writes this machine\'s own address row with the certificate read before the fence', async () => {
    writeRegistry({ ...primary, replication: REPL });
    claimDb.cert = CERT;
    const r = await restore();
    expect(r.error).toBeUndefined();
    expect(r.success).toBe(true);
    expect(claimDb.steps5.filter(s => s === 'cert')).toHaveLength(1);
    expect(claimDb.steps5.indexOf('cert')).toBeLessThan(claimDb.steps5.indexOf('reset'));
    expect(claimDb.genWrites).toHaveLength(1);
    expect(claimDb.genWrites[0]).toContain(addressTableSql('main.example', 5433, CERT, 'main.example', null));
    expect(claimDb.genWrites[0]).not.toContain('DELETE FROM smdb_manager.addresses');
  });
});

describe('Y1: addresses rows never refuse a restore', () => {
  it('a dump with 1200 good rows and three bad ones lands with 1000, logs 3 and 200, and the counts compare', async () => {
    const rows = [addressRow('main.example', 0), addressRow('main.example', 5999, CERT_COPY, 'infinity'), addressRow('main.example', 5998, 'not a cert')];
    for (let i = 1; i <= 1200; i++) rows.push(addressRow('copy.example', i));
    claimDb.metaText = metaDump(`${addressBlock(rows)}${GEN_BLOCK}`);
    claimDb.tocText = META_TOC;
    writeDumpMeta(DIR, 'old.dump', { ...COUNTS_OF.claims, 'smdb_manager.addresses': 1203, 'smdb_manager.generation': 1 });
    claimDb.restoredCounts = { ...COUNTS_OF.claims, 'smdb_manager.addresses': 1000, 'smdb_manager.generation': 1, 'smdb_manager.copies': 0, 'smdb_manager.handover': 0, 'smdb_manager.received': 0 };
    const r = await restore();
    expect(r.error).toBeUndefined();
    expect(r.success).toBe(true);
    expect(r.steps.counts?.result).toBe('matched');
    expect(claimDb.metaScript!.match(/INSERT INTO smdb_manager\.addresses/g)).toHaveLength(1000);
    expect(logs).toContain('[Restore] Bot A: left out 203 row(s) of smdb_manager.addresses from old.dump (3 failed the address check or were over the size limit, 200 past the 1000-row cap)');
  });

  it('a manager table the dump did not hold, made empty by the manager\'s DDL, is not a difference', async () => {
    claimDb.restoredCounts = { ...COUNTS_OF.claims, 'smdb_manager.addresses': 0, 'smdb_manager.generation': 1, 'smdb_manager.copies': 0 };
    claimDb.tocText = META_TOC;
    writeDumpMeta(DIR, 'old.dump', { ...COUNTS_OF.claims, 'smdb_manager.generation': 1 });
    const r = await restore();
    expect(r.steps.counts?.result).toBe('matched');
    expect(logs.some(l => l.startsWith('[Restore] '))).toBe(false);
  });

  it('a restored row in a manager table the dump did not record is still a difference', async () => {
    claimDb.restoredCounts = { ...COUNTS_OF.claims, 'smdb_manager.copies': 2 };
    const r = await restore();
    expect(r.steps.counts?.result).toBe('differ');
  });
});

describe('Y7: the raise and the cap carry psql\'s ERROR line, not its CONTEXT line', () => {
  const RLS = 'ERROR:  query would be affected by row-level security policy for table "shard_claims"\nCONTEXT:  SQL statement "UPDATE smdb_data.shard_claims"\nPL/pgSQL function inline_code_block line 3 at EXECUTE';

  it('raiseClaims answers the ERROR line', async () => {
    Object.assign(claimDb, { fail: 'raise', failText: RLS, dropSeen: true });
    const r = await fleetBackup.raiseClaims(primary, 7);
    expect(r).toEqual({ ok: false, error: 'ERROR:  query would be affected by row-level security policy for table "shard_claims"' });
  });

  it('capClaims answers the ERROR line, and its call runs as dbm_work, fence-exempt', async () => {
    Object.assign(claimDb, { fail: 'cap', failText: RLS, dropSeen: true, restoredTables: 't|t|t|t|t' });
    const r = await fleetBackup.capClaims(primary);
    expect(r).toEqual({ ok: false, error: 'ERROR:  query would be affected by row-level security policy for table "shard_claims"' });
    const cap = execWith('SET expires_up_ms = LEAST(')!;
    expect(cap.slice(0, 4)).toEqual(['exec', '-e', PINNED_EXEMPT, C]);
    expect(cap).toEqual(expect.arrayContaining(['-U', 'dbm_work', '-d', 'app']));
  });

  it('the restore\'s text carries it when the raise fails', async () => {
    Object.assign(claimDb, { fail: 'raise', failText: RLS });
    const r = await restore();
    expect(r.error).toMatch(/^The dump was restored, but the restored claim numbers could not be raised above 7 \(ERROR: {2}query would be affected by row-level security policy for table "shard_claims"\)/);
  });
});

describe('the TOC read cap', () => {
  it('a table of contents at the 8 MB cap refuses before the fence: the restore list could miss an entry', async () => {
    claimDb.tocText = TOC.claims + `;${'x'.repeat(fb.TOC_MAX_CHARS)}\n`;
    const r = await restore();
    expect(r.success).toBe(false);
    expect(r.error).toBe('The table of contents of the dump old.dump is longer than 8 MB, so the restore was refused, and nothing was changed: the restore list made from it could miss an entry');
    expect(pg.events).not.toContain('fence');
  });
});

describe('fix 5b: the texts after the reset, the row-security refusal and the recreate notice (C2, C6, C7)', () => {
  const RESET = "; only the database's own settings and its grants to dbm_meta and dbm_work were reset (its connection limit, its template and connection flags, its database-level settings and those grants)";

  it('C6: a refusal after the reset names the reset in place of "nothing was changed"', async () => {
    holder.failQueue = ['ERROR:  connection reset by peer'];
    const r = await restore();
    expect(r.success).toBe(false);
    expect(r.error).toBe(`Pre-restore dump failed, restore refused${RESET}: the dump's snapshot and table counts could not be taken (ERROR:  connection reset by peer)`);
    expect(dropped()).toBe(false);
  });

  it('C6: a refusal before the reset still says nothing was changed', async () => {
    claimDb.fail5 = 'reset';
    const r = await restore();
    expect(r.error).toMatch(/so the restore was refused, and nothing was changed: /);
  });

  // Fix 5c, C2-1: Postgres 16's lines. The holder's COUNTS_SQL error carries SPI's CONTEXT with the query format(%I.%I)
  // built; pg_dump's carries "Command was: COPY <schema>.<table> ..."; the ERROR line names the table only.
  const RLS = (t: string) => `ERROR:  query would be affected by row-level security policy for table "${t}"`;
  const how = (name: string) => `row-level security is forced on ${name}, so the database cannot be dumped before the restore replaces it. `
    + `The manager has no SQL console; on this machine, run docker exec -it ${C} psql -U dbm_work -d app -c 'SET ROLE "app"; ALTER TABLE ${name} NO FORCE ROW LEVEL SECURITY', then restore again`;

  it('C2, C2-1: a table in smdb_data, read from the holder\'s CONTEXT line, names the schema and quotes both names', async () => {
    holder.failQueue = [`${RLS('shard_claims')}\nCONTEXT:  SQL statement "SELECT count(*) AS c FROM smdb_data.shard_claims"`];
    const r = await restore();
    expect(r.success).toBe(false);
    expect(r.error).toBe(`Pre-restore dump failed, restore refused${RESET}: ${how('"smdb_data"."shard_claims"')}`);
    expect(dropped()).toBe(false);
  });

  it('C2-1: a table in public names public, not smdb_data', async () => {
    holder.failQueue = [`${RLS('x')}\nCONTEXT:  SQL statement "SELECT count(*) AS c FROM public.x"`];
    const r = await restore();
    expect(r.error).toBe(`Pre-restore dump failed, restore refused${RESET}: ${how('"public"."x"')}`);
  });

  it('C2-1: a mixed-case name keeps its quotes', async () => {
    holder.failQueue = [`${RLS('Odd T')}\nCONTEXT:  SQL statement "SELECT count(*) AS c FROM "My Schema"."Odd T""`];
    const r = await restore();
    expect(r.error).toBe(`Pre-restore dump failed, restore refused${RESET}: ${how('"My Schema"."Odd T"')}`);
  });

  it('C2, C2-1: pg_dump\'s own failure: the schema from its Command was line', async () => {
    pg.dumpFail = 'pg_dump: error: Dumping the contents of table "zz" failed: PQgetResult() failed.\npg_dump: detail: Error message from server: '
      + `${RLS('zz')}\npg_dump: detail: Command was: COPY public.zz (x) TO stdout;`;
    const r = await restore();
    expect(r.error).toBe(`Pre-restore dump failed, restore refused${RESET}: ${how('"public"."zz"')}`);
  });

  it('C2-1: when no line names the schema, the table is named alone', async () => {
    holder.failQueue = [RLS('zz')];
    const r = await restore();
    expect(r.error).toBe(`Pre-restore dump failed, restore refused${RESET}: ${how('"zz"')}`);
  });

  it('C7: a failed recreate leaves a notice that says the database may be missing or empty', async () => {
    claimDb.fail = 'ensure';
    const r = await restore();
    expect(r.success).toBe(false);
    expect(registryA().fleetRestoreError.text).toContain('The database may be missing or empty, or unchanged if the drop itself failed; its write fence stays on');
  });
});

describe('the totals of a dump without a counts file count the tables a counts file would (NM18 Q24, X1)', () => {
  const MOVED = 'moved-2026-11-12T10-00-00-000Z.dump';
  const EMPTY_MANAGER = { 'smdb_manager.addresses': 0, 'smdb_manager.copies': 0, 'smdb_manager.generation': 0, 'smdb_manager.handover': 0, 'smdb_manager.received': 0 };

  it('the manager tables the restore made empty, and the dump did not hold, are not in the totals', async () => {
    fs.writeFileSync(path.join(DIR, MOVED), 'dump');
    claimDb.restoredCounts = { ...COUNTS_OF.claims, ...EMPTY_MANAGER };
    const r = await restore(MOVED);
    expect(r.success, r.error).toBe(true);
    expect(r.steps.counts).toEqual({ result: 'unrecorded', tables: 2, rows: 3, text: null });
  });

  it('the manager tables the dump holds stay in the totals, empty or not', async () => {
    fs.writeFileSync(path.join(DIR, MOVED), 'dump');
    claimDb.tocText = META_TOC;
    claimDb.restoredCounts = { ...COUNTS_OF.claims, ...EMPTY_MANAGER, 'smdb_manager.generation': 1 };
    const r = await restore(MOVED);
    expect(r.success, r.error).toBe(true);
    expect(r.steps.counts).toEqual({ result: 'unrecorded', tables: 4, rows: 4, text: null });
  });
});
