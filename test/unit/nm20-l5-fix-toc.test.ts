// NM20 fix after L5 (the TOC list): restoreLists reads entries whose names hold U+2028, U+2029 or other whitespace,
// and an entry the -n smdb_manager read lists that the full read lacks refuses the restore before the fence. The harness
// is nm20-code5's: every docker call is faked; no row reaches the docker CLI.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm20-l5-fix-toc-'));
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

const LS = '\u2028';
const PS = '\u2029';
// An entry line whose type word holds a digit, which no type word of pg_restore 16 has.
const UNREAD_ENTRY = '230; 1259 16420 TABLE2 smdb_manager x dbm_meta';
const head = ';\n; Selected TOC Entries:\n;\n';
// CREATE SCHEMA " x": pg_restore keeps the space, so two spaces follow the type.
const LEADING_SPACE = '216; 1259 16386 TABLE  x t app';

describe('restoreLists reads names that hold a line or paragraph separator', () => {
  const listed = (lines: string[], manager: string[] = []) => (fb.restoreLists(`${head}${lines.join('\n')}\n`, `${head}${manager.join('\n')}\n`).other as string).split('\n');

  for (const [label, sep] of [['U+2028', LS], ['U+2029', PS]] as const) {
    it(`leaves out smdb_manager TABLE, TABLE DATA and SEQUENCE entries whose names hold ${label}`, () => {
      const drop = [
        `220; 1259 16400 TABLE smdb_manager a${sep}b dbm_meta`,
        `3368; 0 16400 TABLE DATA smdb_manager a${sep}b dbm_meta`,
        `221; 1259 16402 SEQUENCE smdb_manager s${sep}q dbm_meta`,
      ];
      const other = listed(['216; 1259 16386 TABLE smdb_data guild_ownership app', ...drop], drop);
      for (const line of drop) expect(other).not.toContain(line);
      expect(other).toContain('216; 1259 16386 TABLE smdb_data guild_ownership app');
    });
  }

  it('leaves out the schema\'s own entry whose owner holds U+2028', () => {
    const line = `6; 2615 16399 SCHEMA - smdb_manager dbm${LS}meta`;
    expect(listed([line])).not.toContain(line);
  });

  it('keeps an entry of another schema whose name holds U+2028', () => {
    const line = `216; 1259 16386 TABLE smdb_data guild${LS}ownership app`;
    expect(listed([line])).toContain(line);
    expect(fb.restoreLists(`${head}${line}\n`, head).refused).toBeNull();
  });

  for (const [label, sep] of [['a tab', '\t'], ['U+00A0', '\u00a0']] as const) {
    it(`keeps an entry of a schema whose name holds ${label}, and reports nothing`, () => {
      const line = `216; 1259 16386 TABLE my${sep}schema t app`;
      const r = fb.restoreLists(`${head}${line}\n`, head);
      expect(r.other.split('\n')).toContain(line);
      expect(r.refused).toBeNull();
    });
  }

  it('keeps an entry of a schema whose name starts with a space, and reports nothing', () => {
    const r = fb.restoreLists(`${head}${LEADING_SPACE}\n`, head);
    expect(r.other.split('\n')).toContain(LEADING_SPACE);
    expect(r.refused).toBeNull();
  });

  it('still leaves out smdb_manager TABLE DATA, SEQUENCE OWNED BY, DEFAULT ACL and the schema\'s own entry with an empty owner', () => {
    const drop = [
      '3368; 0 16400 TABLE DATA smdb_manager generation dbm_meta',
      '3208; 0 0 SEQUENCE OWNED BY smdb_manager s dbm_meta',
      '3407; 826 16413 DEFAULT ACL smdb_manager DEFAULT PRIVILEGES FOR TABLES dbm_meta',
      '6; 2615 16399 SCHEMA - smdb_manager ',
    ];
    const r = fb.restoreLists(`${head}${LEADING_SPACE}\n${drop.join('\n')}\n`, `${head}${drop.slice(0, 3).join('\n')}\n`);
    for (const line of drop) expect(r.other.split('\n')).not.toContain(line);
    expect(r.refused).toBeNull();
  });

  it('reports by its number the first entry the -n smdb_manager read lists that the full read lacks', () => {
    const toc = `${head}216; 1259 16386 TABLE smdb_data guild_ownership app\n`;
    const r = fb.restoreLists(toc, `${head}${UNREAD_ENTRY}\n231; garbled\n`);
    expect(r.refused).toBe(fb.unreadEntryText('230'));
  });

  it('keeps an entry line whose type word pg_restore 16 never prints when the -n smdb_manager read does not list it', () => {
    const toc = `${head}216; 1259 16386 TABLE smdb_data guild_ownership app\n${UNREAD_ENTRY}\n`;
    const r = fb.restoreLists(toc, head);
    expect(r.refused).toBeNull();
    expect(r.other).toBe(toc);
  });

  it('reports nothing on the landed fixtures', () => {
    expect(fb.restoreLists(TOC.shards, managerTocOf(TOC.shards)).refused).toBeNull();
    expect(fb.restoreLists(META_TOC, managerTocOf(META_TOC)).refused).toBeNull();
  });
});

describe('an entry the -n smdb_manager read lists that the full read lacks refuses the restore before the fence', () => {
  it('no fence, no reset, no meta read, no list, no drop and no pg_restore', async () => {
    claimDb.tocText = META_TOC;
    claimDb.managerTocText = `${managerTocOf(META_TOC)}\n${UNREAD_ENTRY}\n`;
    const r = await restore();
    expect(r.success).toBe(false);
    expect(r.error).toBe("The dump old.dump could not be read, so the restore was refused, and nothing was changed: pg_restore lists entry 230 in the manager's schema smdb_manager but not in the dump's full table of contents");
    expect(pg.events.filter(e => ['fence', 'drop', 'dump', 'pg_restore'].includes(e))).toEqual([]);
    expect(fenceOwners.has(C)).toBe(false);
    expect(claimDb.steps5).toEqual([]);
    expect(claimDb.resetArgs).toBeNull();
    expect(claimDb.listText).toBeNull();
    expect(registryA().fleetRestoreError).toBeUndefined();
  });

  it('a schema whose name holds a tab or U+00A0 is not refused', async () => {
    claimDb.tocText = `${META_TOC}240; 1259 16430 TABLE my\tschema t app\n241; 1259 16431 TABLE my\u00a0schema t app\n`;
    const r = await restore();
    expect(r.error).toBeUndefined();
    expect(r.success).toBe(true);
  });

  it('a schema whose name starts with a space is not refused', async () => {
    claimDb.tocText = `${META_TOC}${LEADING_SPACE}\n`;
    const r = await restore();
    expect(r.error).toBeUndefined();
    expect(r.success).toBe(true);
  });
});
