// NM20 L5 on fix toc 2 (writer i): a bot table whose name holds the manager schema's comment form mid-line. Harness: nm20-fix-toc2's.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm20-l5-i-toc2-'));
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
import { claimDb, resetClaimDb, MAINTAINED, writeDumpMeta, TOC } from './restore-fake';
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

const HEAD = [';', '; Archive created at 2026-11-15 21:19:32 UTC', ';     dbname: bot', ';     TOC Entries: 25', ';     Compression: gzip', ';     Dump Version: 1.15-0',
  ';     Format: CUSTOM', ';     Integer: 4 bytes', ';     Offset: 8 bytes', ';     Dumped from database version: 16.16', ';     Dumped by pg_dump version: 16.16', ';', ';',
  '; Selected TOC Entries:', ';'];
const lines = (entries: string[]) => `${[...HEAD, ...entries].join('\n')}\n`;
// pg_restore 16 prints the name as stored: public."5; 0 0 COMMENT - SCHEMA smdb_manager x" and its data.
const ODD_TABLE = '221; 1259 16397 TABLE public 5; 0 0 COMMENT - SCHEMA smdb_manager x app';
const ODD_DATA = '3474; 0 16397 TABLE DATA public 5; 0 0 COMMENT - SCHEMA smdb_manager x app';

describe('a bot table named like the manager schema\'s comment line', () => {
  it('restoreLists keeps the table and its data and refuses nothing', () => {
    const r = fb.restoreLists(lines([ODD_TABLE, ODD_DATA]), lines([]));
    expect(r.refused).toBeNull();
    expect(r.other.split('\n')).toEqual(expect.arrayContaining([ODD_TABLE, ODD_DATA]));
  });

  it('the restore writes the table and its data into its list', async () => {
    claimDb.tocText = `${TOC.claims}${[ODD_TABLE, ODD_DATA].join('\n')}\n`;
    claimDb.managerTocText = lines([]);
    const r = await restore();
    expect(r.error).toBeUndefined();
    const listed = claimDb.listText!.split('\n');
    expect(listed).toContain(ODD_TABLE);
    expect(listed).toContain(ODD_DATA);
  });
});
