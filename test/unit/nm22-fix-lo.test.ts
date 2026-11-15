// NM22 fix after the rebase: restoreLists leaves out a large object's entries by their fixed forms and refuses a dump
// whose entry cannot be told apart from one. The lines are pg_restore 16's (out/NM22/claim-lo.txt); the restore
// harness is nm20-fix-toc2's.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm22-fix-lo-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

const pg = vi.hoisted(() => ({
  events: [] as string[],
  exists: '1',
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
    setTimeout(() => {
      child.stdout.end(isDump ? 'dump' : '');
      child.stderr.end('');
      setTimeout(() => child.emit('close', 0), 5);
    }, 5);
    return child;
  });
  const fakes = await import('./restore-fake');
  const fenced = (await import('./fence-fake')).withFence(fakes.withRestoreFakes(execFile as any));
  const held = (await import('./dump-fake')).withDumpHolder(fakes.withTocFake(spawn as any));
  return { ...real, execFile: fenced, spawn: held, default: { ...real, execFile: fenced, spawn: held } };
});

import * as fs from 'fs';
import * as path from 'path';
import * as fleetBackup from '../../src/instance/fleetBackup';
import { fenceOwners } from './fence-fake';
import { claimDb, resetClaimDb, MAINTAINED, writeDumpMeta, TOC } from './restore-fake';
import { resetHolder } from './dump-fake';

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
  pg.exists = '1';
  pg.events.length = 0;
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

const HEAD = [';', '; Archive created at 2026-11-16 09:12:40 UTC', ';     dbname: bot', ';     TOC Entries: 17', ';     Compression: gzip', ';     Dump Version: 1.15-0',
  ';     Format: CUSTOM', ';     Integer: 4 bytes', ';     Offset: 8 bytes', ';     Dumped from database version: 16.16', ';     Dumped by pg_dump version: 16.16', ';', ';',
  '; Selected TOC Entries:', ';'];
const lines = (entries: string[]) => `${[...HEAD, ...entries].join('\n')}\n`;

// The first dump of claim-lo.txt (pg_dump -Fc of a bot holding one large object), its lines by entry number.
const L: Record<string, string> = {
  7: '7; 2615 16394 SCHEMA - - LARGE OBJECT 1 app',
  8: '8; 2615 16398 SCHEMA - LARGE app',
  6: '6; 2615 16388 SCHEMA - smdb_manager postgres',
  219: '219; 1259 16395 TABLE - LARGE OBJECT 1 t app',
  3465: '3465; 0 0 COMMENT - LARGE OBJECT 1 TABLE t app',
  3466: '3466; 0 0 ACL - LARGE OBJECT 1 TABLE t app',
  220: '220; 1259 16399 TABLE LARGE t app',
  3467: '3467; 0 0 COMMENT LARGE TABLE t app',
  218: '218; 1259 16389 TABLE smdb_manager addresses postgres',
  3457: '3457; 2613 16500 BLOB - 16500 app',
  3468: '3468; 0 0 COMMENT - LARGE OBJECT 16500 app',
  3469: '3469; 0 0 ACL - LARGE OBJECT 16500 app',
  3455: '3455; 0 16395 TABLE DATA - LARGE OBJECT 1 t app',
  3456: '3456; 0 16399 TABLE DATA LARGE t app',
  3454: '3454; 0 16389 TABLE DATA smdb_manager addresses postgres',
  3458: '3458; 0 0 BLOBS - BLOBS ',
};
const FIRST = [7, 8, 6, 219, 3465, 3466, 220, 3467, 218, 3457, 3468, 3469, 3455, 3456, 3454, 3458].map(n => L[n]);
const MANAGER = lines([L[218], L[3454]]);
// The second dump (pg_dump -B): the same bot without its large object, the entries numbered anew.
const SECOND = [
  '7; 2615 16394 SCHEMA - - LARGE OBJECT 1 app',
  '8; 2615 16398 SCHEMA - LARGE app',
  '6; 2615 16388 SCHEMA - smdb_manager postgres',
  '219; 1259 16395 TABLE - LARGE OBJECT 1 t app',
  '3463; 0 0 COMMENT - LARGE OBJECT 1 TABLE t app',
  '3464; 0 0 ACL - LARGE OBJECT 1 TABLE t app',
  '220; 1259 16399 TABLE LARGE t app',
  '3465; 0 0 COMMENT LARGE TABLE t app',
  '218; 1259 16389 TABLE smdb_manager addresses postgres',
  '3455; 0 16395 TABLE DATA - LARGE OBJECT 1 t app',
  '3456; 0 16399 TABLE DATA LARGE t app',
  '3454; 0 16389 TABLE DATA smdb_manager addresses postgres',
];
const LARGE_OBJECT = [L[3457], L[3468], L[3469], L[3458]];
const TOLD_APART = (n: string) => `entry ${n} of its table of contents cannot be told apart from a large object's entry`;

describe('restoreLists leaves out a large object\'s entries by their fixed forms', () => {
  it('refuses the first dump as pg_restore printed it: entry 3465 is a comment on the table t of the schema "- LARGE OBJECT 1"', () => {
    expect(fleetBackup.restoreLists(lines(FIRST), MANAGER).refused).toBe(TOLD_APART('3465'));
  });

  it('keeps the bot\'s lines and leaves out the large object\'s BLOB, COMMENT, ACL and BLOBS lines and the manager\'s entries', () => {
    const toc = lines([L[8], L[6], L[220], L[3467], L[218], L[3457], L[3468], L[3469], L[3456], L[3454], L[3458]]);
    expect(fleetBackup.restoreLists(toc, MANAGER)).toEqual({ other: lines([L[8], L[220], L[3467], L[3456]]), refused: null });
  });

  it('refuses the second dump (pg_dump -B) at its entry 3463', () => {
    expect(fleetBackup.restoreLists(lines(SECOND), MANAGER).refused).toBe(TOLD_APART('3463'));
  });

  it('refuses a large object\'s comment whose owner\'s name holds a space, and leaves out its security label', () => {
    expect(fleetBackup.restoreLists(lines([L[3457], '3468; 0 0 COMMENT - LARGE OBJECT 16500 app owner', L[3456]]), lines([])).refused).toBe(TOLD_APART('3468'));
    const label = '3470; 0 0 SECURITY LABEL - LARGE OBJECT 16500 app';
    expect(fleetBackup.restoreLists(lines([L[3457], label, L[3456]]), lines([]))).toEqual({ other: lines([L[3456]]), refused: null });
  });
});

const CLAIMS_PLUS = (entries: string[]) => `${TOC.claims}${entries.join('\n')}\n`;
const REFUSED = (detail: string) => `The dump old.dump could not be read, so the restore was refused, and nothing was changed: ${detail}`;

describe('the restore with a dump that holds a large object', () => {
  it('restores with none of the large object\'s entries in the -L list', async () => {
    claimDb.tocText = CLAIMS_PLUS([L[8], L[220], ...LARGE_OBJECT, L[3456]]);
    const r = await restore();
    expect(r.error).toBeUndefined();
    const listed = claimDb.listText!.split('\n');
    for (const line of LARGE_OBJECT) expect(listed).not.toContain(line);
    for (const line of [L[8], L[220], L[3456]]) expect(listed).toContain(line);
  });

  it('refuses a dump holding entry 3465 before the fence', async () => {
    claimDb.tocText = CLAIMS_PLUS(FIRST);
    claimDb.managerTocText = MANAGER;
    const r = await restore();
    expect(r.error).toBe(REFUSED(TOLD_APART('3465')));
    expect(pg.events.filter(e => ['fence', 'drop', 'dump', 'pg_restore'].includes(e))).toEqual([]);
    expect(fenceOwners.has(C)).toBe(false);
    expect(claimDb.listText).toBeNull();
    expect(registryA().fleetRestoreError).toBeUndefined();
  });
});
