// NM20 L5 writer d: fleetBackup.ts survivors (loginExec, dumpDatabase, the restore list, the meta read, the list
// write, the row-security text, the counts and the restore). The harness is nm20-code5.test.ts's, with a spawn
// override per row, a log of dbLogin.noteLoginFault and a way to shorten the list write's timer.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm20-l5-d-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

const pg = vi.hoisted(() => ({
  events: [] as string[],
  exec: [] as string[][],
  exists: '1',
  dumpFail: null as string | null,
  override: null as null | ((args: string[]) => any),
  faults: [] as string[],
}));

vi.mock('../../src/instance/dbLogin', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/instance/dbLogin')>();
  return { ...real, noteLoginFault: (c: string) => { pg.faults.push(c); real.noteLoginFault(c); } };
});
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
    const failText = isDump ? pg.dumpFail : null;
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
  const loggedSpawn = ((cmd: string, args: string[], opts?: any) => {
    const own = cmd === 'docker' && pg.override ? pg.override(args) : null;
    return own ?? (held as any)(cmd, args, opts);
  }) as typeof held;
  return { ...real, execFile: loggedExec, spawn: loggedSpawn, default: { ...real, execFile: loggedExec, spawn: loggedSpawn } };
});

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as fleetBackup from '../../src/instance/fleetBackup';
import { fenceOwners } from './fence-fake';
import { claimDb, resetClaimDb, MAINTAINED, writeDumpMeta, COUNTS_OF, isListWrite, isMetaRead } from './restore-fake';
import { holder, resetHolder } from './dump-fake';

const fb = fleetBackup as any;
const REGISTRY = path.join(tmp.dir, 'instances.json');
const DIR = path.join(tmp.dir, 'backups', 'a', 'fleet-postgres');
const DUMP = path.join(DIR, 'old.dump');
const C = 'bot-a-postgres';
const primary = { containerName: C, user: 'app', db: 'app', volume: 'bot-a-pgdata' };
const TEN_MIN = 10 * 60 * 1000;
const SLOW = 'reading its smdb_manager rows took more than 10 minutes';
const RESET = "; only the database's own settings and its grants to dbm_meta and dbm_work were reset (its connection limit, its template and connection flags, its database-level settings and those grants)";
const LIST_REFUSED = `The restore list could not be written into the database container, so the restore was refused${RESET}: `;

const TS = '2026-11-13 11:32:24.265756+00';
const entry = (table: string) => `--\n-- Data for Name: ${table}; Type: TABLE DATA; Schema: smdb_manager; Owner: dbm_meta\n--\n\n`;
const GEN_BLOCK = `${entry('generation')}COPY smdb_manager.generation (one_row, machine, generation, since) FROM stdin;\nt\tmain.example\t3\t${TS}\n\\.\n\n\n`;
const metaDump = (blocks: string) => `--\n-- PostgreSQL database dump\n--\n\nSET statement_timeout = 0;\nSET row_security = off;\n\n${blocks}--\n-- PostgreSQL database dump complete\n--\n\n`;

function writeRegistry(fleetDb: Record<string, unknown> = primary): void {
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: {
    a: { id: 'a', displayName: 'Bot A', sanitizedName: 'bot-a', status: 'running', sourceUrl: 'https://example.invalid/fake/app', createdAt: '2026-10-01T00:00:00.000Z', fleetDb, fleetBackup: { enabled: false, hour: 4, keep: 7 }, ...MAINTAINED },
  } }, null, 2));
}
const registryA = () => JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')).instances.a;
const restore = (file = 'old.dump') => fleetBackup.restoreFleetBackup('a', file);

/** A docker exec child whose stdio the row drives; kill is counted and closes nothing. */
function child(): any {
  const c: any = new EventEmitter();
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.stdin = new PassThrough();
  c.stdin.resume();
  c.kill = vi.fn(() => true);
  return c;
}

beforeEach(() => {
  Object.assign(pg, { exists: '1', dumpFail: null, override: null });
  pg.events.length = 0;
  pg.exec.length = 0;
  pg.faults.length = 0;
  resetClaimDb();
  resetHolder();
  claimDb.metaText = metaDump(GEN_BLOCK);
  fenceOwners.clear();
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(DUMP, 'dump');
  writeDumpMeta(DIR, 'old.dump');
  fleetBackup.clearClaimFloor('a');
  fleetBackup.dismissFleetRestoreError('a');
  writeRegistry();
  fs.mkdirSync(path.join(tmp.dir, 'bots', 'a'), { recursive: true });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
afterAll(() => { fs.rmSync(tmp.dir, { recursive: true, force: true }); });

describe('loginExec: a failed dbm_work call, and only a failed one, drops the container from the confirmed set', () => {
  it('a claim probe that answers notes no fault', async () => {
    const r = await fb.probeClaims(primary);
    expect(r.ok).toBe(true);
    expect(pg.faults).toEqual([]);
  });

  it('a claim probe that fails notes the fault for its container', async () => {
    claimDb.fail = 'tables';
    const r = await fb.probeClaims(primary);
    expect(r.ok).toBe(false);
    expect(pg.faults).toEqual([C]);
  });
});

describe('dumpDatabase: a failed dump notes a login fault, a good one does not', () => {
  it('a dump that lands notes no fault', async () => {
    const r = await fb.runFleetDump(registryA(), 'pre-restore-');
    expect(r.success, r.error).toBe(true);
    expect(pg.faults).toEqual([]);
  });

  it('a dump whose holder fails notes the fault once', async () => {
    holder.failQueue = ['ERROR:  connection reset by peer'];
    const r = await fb.runFleetDump(registryA(), 'pre-restore-');
    expect(r.success).toBe(false);
    expect(pg.faults).toEqual([C]);
  });
});

describe('restoreLists: what the anchors leave in the list', () => {
  const HEAD = (db: string) => `;\n; Archive created at 2026-11-13 02:28:00 UTC\n;     dbname: ${db}\n;\n; Selected TOC Entries:\n;\n`;
  const NO_MANAGER = HEAD('app');

  it('a header line whose database name reads like a manager entry stays', () => {
    const toc = `${HEAD('x 1; 2 3 TABLE smdb_manager t')}5; 2615 16385 SCHEMA - smdb_data app\n`;
    expect(fb.restoreLists(toc, HEAD('x 1; 2 3 TABLE smdb_manager t')).other).toBe(toc);
  });

  it('a table named smdb_manager in another schema stays', () => {
    const toc = `${HEAD('app')}218; 1259 16410 TABLE smdb_data smdb_manager app\n3362; 0 16410 TABLE DATA smdb_data smdb_manager app\n`;
    expect(fb.restoreLists(toc, NO_MANAGER).other).toBe(toc);
  });

  it('a schema comment owned by a role named smdb_manager stays', () => {
    const toc = `${HEAD('app')}3402; 0 0 COMMENT - SCHEMA smdb_data smdb_manager\n`;
    expect(fb.restoreLists(toc, NO_MANAGER).other).toBe(toc);
  });
});

describe('readArchiveMeta: the meta read driven through its child', () => {
  let c: any;
  const start = (dumpPath = DUMP) => {
    c = child();
    pg.override = args => (isMetaRead(args) ? c : null);
    return fb.readArchiveMeta(C, dumpPath);
  };

  it('a spawn that throws answers its reason', async () => {
    pg.override = args => { if (isMetaRead(args)) throw new Error('spawn ENOMEM'); return null; };
    expect(await fb.readArchiveMeta(C, DUMP)).toEqual({ ok: false, error: 'Failed to run docker exec: spawn ENOMEM' });
  });

  it("the child's error event answers its message", async () => {
    const p = start();
    c.emit('error', new Error('spawn docker EACCES'));
    expect(await p).toEqual({ ok: false, error: 'Failed to run docker exec: spawn docker EACCES' });
  });

  it('an EPIPE on its stdin is caught, and the close answers the parse', async () => {
    const p = start();
    c.stdin.emit('error', new Error('write EPIPE'));
    expect(c.stdin.listenerCount('error')).toBe(1);
    c.stdout.end(metaDump(GEN_BLOCK));
    await new Promise(r => setTimeout(r, 5));
    c.emit('close', 0);
    expect((await p).ok).toBe(true);
  });

  it('stderr past 4000 characters is not kept', async () => {
    const p = start();
    c.stderr.write(' '.repeat(4000));
    await new Promise(r => setTimeout(r, 5));
    c.stderr.write('ERROR:  late');
    await new Promise(r => setTimeout(r, 5));
    c.emit('close', 1);
    expect(await p).toEqual({ ok: false, error: 'pg_restore exited with code 1: ' });
  });

  it('the stored stderr is trimmed and cut to 500 characters', async () => {
    const p = start();
    c.stderr.write(`\n${'x'.repeat(600)}\n`);
    await new Promise(r => setTimeout(r, 5));
    c.emit('close', 1);
    expect(await p).toEqual({ ok: false, error: `pg_restore exited with code 1: ${'x'.repeat(500)}` });
  });

  describe('the close codes against the clock', () => {
    let now = 1_800_000_000_000;
    beforeEach(() => { now = 1_800_000_000_000; vi.spyOn(Date, 'now').mockImplementation(() => now); });

    it('137 once the limit has passed exactly is the slow text', async () => {
      const p = start();
      now += TEN_MIN;
      c.emit('close', 137);
      expect(await p).toEqual({ ok: false, error: SLOW });
    });

    it('137 before the limit is an exit code', async () => {
      const p = start();
      now += 1000;
      c.emit('close', 137);
      expect(await p).toEqual({ ok: false, error: 'pg_restore exited with code 137: ' });
    });

    it('another code after the limit is an exit code', async () => {
      const p = start();
      now += TEN_MIN + 1000;
      c.emit('close', 1);
      expect(await p).toEqual({ ok: false, error: 'pg_restore exited with code 1: ' });
    });
  });

  it("the backstop kills the child 30 s past the in-container limit, not before, and answers the slow text", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const p = start();
    vi.advanceTimersByTime(TEN_MIN);
    expect(c.kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(c.kill).toHaveBeenCalledWith('SIGKILL');
    vi.useRealTimers();
    expect(await p).toEqual({ ok: false, error: SLOW });
  });

  it('a dump file that cannot be read kills the child and answers the read error', async () => {
    const missing = path.join(DIR, 'gone.dump');
    const p = start(missing);
    const r = await p;
    expect(c.kill).toHaveBeenCalledWith('SIGKILL');
    expect(r).toEqual({ ok: false, error: `Failed to read dump file: ENOENT: no such file or directory, open '${missing}'` });
  });
});

describe('writeInContainer: the restore list write', () => {
  const realSetTimeout = globalThis.setTimeout;
  let listTimers: Array<ReturnType<typeof setTimeout>> = [];
  let shorten = false;
  let armed = false;
  let cleared: unknown[] = [];

  beforeEach(() => {
    listTimers = [];
    cleared = [];
    shorten = false;
    armed = false;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...a: any[]) => void, ms?: number, ...rest: any[]) => {
      const take = armed && ms === 30_000;
      if (take) armed = false;
      const t = (realSetTimeout as any)(fn, take && shorten ? 1 : ms, ...rest);
      if (take) listTimers.push(t);
      return t;
    }) as any);
    const realClear = globalThis.clearTimeout;
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((t: any) => { cleared.push(t); return realClear(t); }) as any);
  });

  const listChild = (run: (c: any) => void) => {
    pg.override = args => {
      if (!isListWrite(args)) return null;
      const c = child();
      armed = true;
      c.stdin.on('finish', () => run(c));
      return c;
    };
  };

  it('a spawn that throws refuses with its reason', async () => {
    pg.override = args => { if (isListWrite(args)) throw new Error('spawn ENOMEM'); return null; };
    const r = await restore();
    expect(r.error).toBe(`${LIST_REFUSED}Failed to run docker exec: spawn ENOMEM`);
  });

  it('a list written in time clears its timer', async () => {
    listChild(c => realSetTimeout(() => c.emit('close', 0), 2));
    const r = await restore();
    expect(r.success, r.error).toBe(true);
    expect(listTimers.length).toBe(1);
    expect(cleared).toContain(listTimers[0]);
  });

  it('a list write that does not answer is killed and refused with the wait', async () => {
    shorten = true;
    let killed: any = null;
    listChild(c => { killed = c; });
    const r = await restore();
    expect(killed.kill).toHaveBeenCalledWith('SIGKILL');
    expect(r.error).toBe(`${LIST_REFUSED}docker did not answer within 30 s`);
  });

  it('stderr past 4000 characters is not kept; the last line kept is the answer', async () => {
    listChild(c => {
      c.stderr.write(`${' '.repeat(3994)}early\n`);
      realSetTimeout(() => { c.stderr.write('late\n'); realSetTimeout(() => c.emit('close', 1), 2); }, 2);
    });
    const r = await restore();
    expect(r.error).toBe(`${LIST_REFUSED}early`);
  });

  it("the child's error event refuses with its message", async () => {
    listChild(c => c.emit('error', new Error('spawn docker EACCES')));
    const r = await restore();
    expect(r.error).toBe(`${LIST_REFUSED}Failed to run docker exec: spawn docker EACCES`);
  });

  it('a blank stderr names the exit code', async () => {
    listChild(c => { c.stderr.write('  \n'); realSetTimeout(() => c.emit('close', 1), 2); });
    const r = await restore();
    expect(r.error).toBe(`${LIST_REFUSED}docker exec exited with code 1`);
  });
});

describe('rowSecurityOf and its statement: quoted names and the matching FROM', () => {
  const RLS = (t: string) => `ERROR:  query would be affected by row-level security policy for table "${t}"`;
  const head = `Pre-restore dump failed, restore refused${RESET}: `;
  const how = (name: string, sqlName = name) => `row-level security is forced on ${name}, so the database cannot be dumped before the restore replaces it. `
    + `The manager has no SQL console; on this machine, run docker exec -it ${C} psql -U dbm_work -d app -c 'SET ROLE "app"; ALTER TABLE ${sqlName} NO FORCE ROW LEVEL SECURITY', then restore again`;

  it('a schema with a double quote in its name is read unquoted and quoted again', async () => {
    holder.failQueue = [`${RLS('t')}\nCONTEXT:  SQL statement "SELECT count(*) AS c FROM "s""x".t"`];
    const r = await restore();
    expect(r.error).toBe(`${head}${how('"s""x"."t"')}`);
  });

  it('the schema comes from the FROM that names the refused table, not the first FROM', async () => {
    holder.failQueue = [`${RLS('t')}\nCONTEXT:  SQL statement "SELECT count(*) FROM smdb_data.other WHERE EXISTS (SELECT 1 FROM public.t)"`];
    const r = await restore();
    expect(r.error).toBe(`${head}${how('"public"."t"')}`);
  });

  it("a single quote in the table's name is escaped for the shell", async () => {
    holder.failQueue = [`${RLS("it's")}\nCONTEXT:  SQL statement "SELECT count(*) AS c FROM public."it's""`];
    const r = await restore();
    expect(r.error).toBe(`${head}${how(`"public"."it's"`, `"public"."it'\\''s"`)}`);
  });
});

describe('countsToCompare', () => {
  it('rows left out of a backup that recorded no addresses add no entry', () => {
    const r = fb.countsToCompare({ 'smdb_data.meta': 1 }, { 'smdb_data.meta': 1 }, 2);
    expect(r.recorded).toEqual({ 'smdb_data.meta': 1 });
  });
});

describe('the restore lane', () => {
  const MOVED = 'moved-2026-11-12T10-00-00-000Z.dump';

  it('a manager table the dump did not hold, with rows restored into it, stays in the totals', async () => {
    fs.writeFileSync(path.join(DIR, MOVED), 'dump');
    claimDb.restoredCounts = { ...COUNTS_OF.claims, 'smdb_manager.handover': 2 };
    const r = await restore(MOVED);
    expect(r.success, r.error).toBe(true);
    expect(r.steps.counts).toEqual({ result: 'unrecorded', tables: 3, rows: 5, text: null });
  });

  it('a failed meta transaction leaves a notice that the database holds none of the dump', async () => {
    claimDb.fail5 = 'meta-tx';
    const r = await restore();
    expect(r.success).toBe(false);
    expect(registryA().fleetRestoreError.text).toContain("The database holds none of the bot's data from the dump; its write fence stays on (the pre-restore dump is pre-restore-");
  });

  it('a clean restore notes one login fault, after the pg_restore ran as dbm_work', async () => {
    claimDb.generation = { generation: 3, machine: 'main.example', since: null };
    claimDb.restoredGeneration = { generation: 3, machine: 'main.example', since: null };
    const r = await restore();
    expect(r.success, r.error).toBe(true);
    expect(pg.faults).toEqual([C]);
  });
});
