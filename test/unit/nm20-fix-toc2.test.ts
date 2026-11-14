// NM20 fix toc 2 (rule d): pg_restore -l -n smdb_manager decides which entries are the manager's, and restoreLists
// parses only entry ids and the schema's own entries. The restore harness is nm20-l5-fix-toc's; no row reaches docker.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm20-fix-toc2-'));
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
import { fenceOwners } from './fence-fake';
import { claimDb, resetClaimDb, MAINTAINED, writeDumpMeta, TOC, managerTocOf } from './restore-fake';
import { resetHolder } from './dump-fake';

const fb = fleetBackup as any;
const REGISTRY = path.join(tmp.dir, 'instances.json');
const DIR = path.join(tmp.dir, 'backups', 'a', 'fleet-postgres');
const C = 'bot-a-postgres';
const primary = { containerName: C, user: 'app', db: 'app', volume: 'bot-a-pgdata' };
const TS = '2026-11-13 11:32:24.265756+00';
const GEN_BLOCK = `--\n-- Data for Name: generation; Type: TABLE DATA; Schema: smdb_manager; Owner: dbm_meta\n--\n\nCOPY smdb_manager.generation (one_row, machine, generation, since) FROM stdin;\nt\tmain.example\t3\t${TS}\n\\.\n\n\n`;
const metaDump = (blocks: string) => `--\n-- PostgreSQL database dump\n--\n\nSET statement_timeout = 0;\nSET row_security = off;\n\n${blocks}--\n-- PostgreSQL database dump complete\n--\n\n`;

function writeRegistry(): void {
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: {
    a: { id: 'a', displayName: 'Bot A', sanitizedName: 'bot-a', status: 'running', sourceUrl: 'https://example.invalid/fake/app', createdAt: '2026-10-01T00:00:00.000Z', fleetDb: primary, fleetBackup: { enabled: false, hour: 4, keep: 7 }, ...MAINTAINED },
  } }, null, 2));
}
const registryA = () => JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')).instances.a;
const restore = (file = 'old.dump') => fleetBackup.restoreFleetBackup('a', file);

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
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterAll(() => { vi.restoreAllMocks(); fs.rmSync(tmp.dir, { recursive: true, force: true }); });

// pg_restore 16 -l of the dumps out/NM20/claim_toc.sh and claim_toc2.sh made (claim-toc.txt, claim-toc2.txt).
const HEAD = [';', '; Archive created at 2026-11-15 21:19:32 UTC', ';     dbname: bot', ';     TOC Entries: 25', ';     Compression: gzip', ';     Dump Version: 1.15-0',
  ';     Format: CUSTOM', ';     Integer: 4 bytes', ';     Offset: 8 bytes', ';     Dumped from database version: 16.16', ';     Dumped by pg_dump version: 16.16', ';', ';',
  '; Selected TOC Entries:', ';'];
const KEPT1 = [
  '7; 2615 16393 SCHEMA - - app',
  '8; 2615 16394 SCHEMA - ABC app',
  '9; 2615 16395 SCHEMA - DATA app',
  '10; 2615 16396 SCHEMA - my schema app',
  '221; 1259 16397 TABLE - SCHEMA smdb_manager',
  '222; 1259 16400 TABLE - smdb_manager app',
  '227; 1259 16415 SEQUENCE ABC s app',
  '223; 1259 16403 TABLE ABC smdb_manager app',
  '224; 1259 16406 TABLE DATA t app',
  '226; 1259 16412 TABLE my schema my table app',
  '225; 1259 16409 TABLE public TABLE DATA app',
  '3474; 0 16397 TABLE DATA - SCHEMA smdb_manager',
  '3475; 0 16400 TABLE DATA - smdb_manager app',
  '3476; 0 16403 TABLE DATA ABC smdb_manager app',
  '3477; 0 16406 TABLE DATA DATA t app',
  '3479; 0 16412 TABLE DATA my schema my table app',
  '3478; 0 16409 TABLE DATA public TABLE DATA app',
  '3487; 0 0 SEQUENCE SET ABC s app',
];
const SCHEMA1 = '6; 2615 16387 SCHEMA - smdb_manager postgres';
const TABLE1 = '220; 1259 16388 TABLE smdb_manager addresses postgres';
const DATA1 = '3473; 0 16388 TABLE DATA smdb_manager addresses postgres';
const lines = (entries: string[]) => `${[...HEAD, ...entries].join('\n')}\n`;
const FULL1 = lines([...KEPT1.slice(0, 4), SCHEMA1, ...KEPT1.slice(4, 11), TABLE1, ...KEPT1.slice(11, 17), DATA1, KEPT1[17]]);
const MANAGER1 = lines([TABLE1, DATA1]);

const T2 = {
  dash: '7; 2615 16395 SCHEMA - - app',
  dashSchema: '10; 2615 16407 SCHEMA - - SCHEMA smdb_manager app',
  abc: '8; 2615 16396 SCHEMA - ABC app',
  schema: '6; 2615 16388 SCHEMA - smdb_manager postgres',
  comment: '3476; 0 0 COMMENT - SCHEMA smdb_manager postgres',
  acl: '3477; 0 0 ACL - SCHEMA smdb_manager postgres',
  spaced: '9; 2615 16403 SCHEMA - smdb_manager x app',
  dashTable: '221; 1259 16397 TABLE - smdb_manager app',
  odd: '224; 1259 16408 TABLE - SCHEMA smdb_manager t app',
  oddComment: '3478; 0 0 COMMENT - SCHEMA smdb_manager TABLE t app',
  abcTable: '222; 1259 16400 TABLE ABC smdb_manager app',
  table: '220; 1259 16389 TABLE smdb_manager addresses postgres',
  tableComment: '3479; 0 0 COMMENT smdb_manager TABLE addresses postgres',
  tableAcl: '3480; 0 0 ACL smdb_manager TABLE addresses postgres',
  spacedTable: '223; 1259 16404 TABLE smdb_manager x t app',
  dashData: '3466; 0 16397 TABLE DATA - smdb_manager app',
  oddData: '3469; 0 16408 TABLE DATA - SCHEMA smdb_manager t app',
  abcData: '3467; 0 16400 TABLE DATA ABC smdb_manager app',
  data: '3465; 0 16389 TABLE DATA smdb_manager addresses postgres',
  spacedData: '3468; 0 16404 TABLE DATA smdb_manager x t app',
  defaultAcl: '2058; 826 16394 DEFAULT ACL smdb_manager DEFAULT PRIVILEGES FOR TABLES postgres',
};
const MANAGER2 = lines([T2.table, T2.tableComment, T2.tableAcl, T2.data, T2.defaultAcl]);
const FULL2 = (leave: string[]) => lines(Object.values(T2).filter(l => !leave.includes(l)));
const AMBIGUOUS = (n: string) => `entry ${n} of its table of contents cannot be told apart from the manager's own schema smdb_manager`;
const listOf = (r: { other: string }) => r.other.split('\n');

describe('restoreLists takes the manager\'s entries from pg_restore -l -n smdb_manager', () => {
  it('keeps every entry of the bot\'s schemas named "-", ABC, DATA and "my schema" and drops the manager\'s schema, table and data', () => {
    const r = fb.restoreLists(FULL1, MANAGER1);
    for (const line of KEPT1) expect(listOf(r)).toContain(line);
    for (const line of [SCHEMA1, TABLE1, DATA1]) expect(listOf(r)).not.toContain(line);
    for (const line of HEAD) expect(listOf(r)).toContain(line);
    expect(r.refused).toBeNull();
  });

  it('keeps the manager\'s table and data when the -n smdb_manager list does not name them', () => {
    const r = fb.restoreLists(FULL1, lines([]));
    expect(listOf(r)).toEqual(expect.arrayContaining([TABLE1, DATA1, ...KEPT1]));
    expect(listOf(r)).not.toContain(SCHEMA1);
    expect(r.refused).toBeNull();
  });

  it('refuses as unread an entry the -n smdb_manager list names that the full list lacks', () => {
    const r = fb.restoreLists(lines([...KEPT1, SCHEMA1]), MANAGER1);
    expect(r.refused).toBe(fb.unreadEntryText('220'));
  });

  it('drops the schema\'s comment and ACL and the default ACL, and keeps the schemas "smdb_manager x" and "- SCHEMA smdb_manager"', () => {
    const r = fb.restoreLists(FULL2([T2.spaced, T2.oddComment]), MANAGER2);
    for (const line of [T2.schema, T2.comment, T2.acl, T2.table, T2.tableComment, T2.tableAcl, T2.data, T2.defaultAcl]) expect(listOf(r)).not.toContain(line);
    for (const line of [T2.dash, T2.dashSchema, T2.abc, T2.dashTable, T2.odd, T2.abcTable, T2.spacedTable, T2.dashData, T2.oddData, T2.abcData, T2.spacedData]) {
      expect(listOf(r)).toContain(line);
    }
    expect(r.refused).toBeNull();
  });

  it('refuses the schema "smdb_manager x" as one it cannot tell apart from the manager\'s', () => {
    expect(fb.restoreLists(FULL2([T2.oddComment]), MANAGER2).refused).toBe(AMBIGUOUS('9'));
  });

  it('refuses the comment on a table of the schema "- SCHEMA smdb_manager" as one it cannot tell apart from the manager\'s', () => {
    expect(fb.restoreLists(FULL2([T2.spaced]), MANAGER2).refused).toBe(AMBIGUOUS('3478'));
  });

  it('drops the default ACL only through the -n smdb_manager list', () => {
    const r = fb.restoreLists(FULL2([T2.spaced, T2.oddComment]), lines([T2.table, T2.tableComment, T2.tableAcl, T2.data]));
    expect(listOf(r)).toContain(T2.defaultAcl);
    expect(r.refused).toBeNull();
  });
});

describe('the fake\'s -n smdb_manager answer reads only the plain forms', () => {
  it('lists the plain table and data lines, leaves out the schema\'s own line and throws on the lines it cannot place', () => {
    expect(managerTocOf(lines([SCHEMA1, TABLE1, DATA1]))).toBe([...HEAD, TABLE1, DATA1].join('\n'));
    for (const line of [KEPT1[4], KEPT1[5], KEPT1[7], T2.spacedData]) expect(() => managerTocOf(lines([line]))).toThrow(/give the row managerTocText/);
  });
});

const CLAIMS_PLUS = (entries: string[]) => `${TOC.claims}${entries.join('\n')}\n`;
const REFUSED = (detail: string) => `The dump old.dump could not be read, so the restore was refused, and nothing was changed: ${detail}`;
const nothingChanged = () => {
  expect(pg.events.filter(e => ['fence', 'drop', 'dump', 'pg_restore'].includes(e))).toEqual([]);
  expect(fenceOwners.has(C)).toBe(false);
  expect(claimDb.steps5).toEqual([]);
  expect(claimDb.listText).toBeNull();
  expect(registryA().fleetRestoreError).toBeUndefined();
};

describe('the restore reads the table of contents in full and with -n smdb_manager before its fence', () => {
  it('runs pg_restore -l twice, the second with -n smdb_manager', async () => {
    const r = await restore();
    expect(r.error).toBeUndefined();
    expect(claimDb.tocArgs).toEqual([
      ['exec', '-i', C, 'timeout', '-s', 'KILL', '60', 'pg_restore', '-l'],
      ['exec', '-i', C, 'timeout', '-s', 'KILL', '60', 'pg_restore', '-l', '-n', 'smdb_manager'],
    ]);
  });

  it('a failed -n smdb_manager read refuses before the fence', async () => {
    claimDb.fail = 'managerToc';
    const r = await restore();
    expect(r.success).toBe(false);
    expect(r.error).toBe(REFUSED('pg_restore exited with code 1: pg_restore: error: input file does not appear to be a valid archive'));
    nothingChanged();
  });

  it('writes the list without the manager\'s entries and with every bot entry', async () => {
    claimDb.tocText = CLAIMS_PLUS([...KEPT1, SCHEMA1, TABLE1, DATA1]);
    claimDb.managerTocText = MANAGER1;
    const r = await restore();
    expect(r.error).toBeUndefined();
    const listed = claimDb.listText!.split('\n');
    for (const line of KEPT1) expect(listed).toContain(line);
    for (const line of [SCHEMA1, TABLE1, DATA1]) expect(listed).not.toContain(line);
  });

  it('refuses a schema it cannot tell apart from the manager\'s before the fence', async () => {
    claimDb.tocText = CLAIMS_PLUS([T2.spaced, T2.spacedTable, T2.spacedData]);
    claimDb.managerTocText = lines([]);
    const r = await restore();
    expect(r.error).toBe(REFUSED(AMBIGUOUS('9')));
    nothingChanged();
  });

  it('refuses as unread an entry the -n smdb_manager list names that the full list lacks', async () => {
    claimDb.managerTocText = lines([TABLE1]);
    const r = await restore();
    expect(r.error).toBe(REFUSED("pg_restore lists entry 220 in the manager's schema smdb_manager but not in the dump's full table of contents"));
    nothingChanged();
  });
});
