import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm18-restore-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

const pg = vi.hoisted(() => ({
  events: [] as string[],
  sql: [] as string[],
  urls: {} as Record<string, string>,
  live: {} as Record<string, string[] | null>,
  sidecar: true,
  sidecarStarts: [] as boolean[],
  shutdown: false,
  storeCorrupt: false,
  seed: null as unknown,
  exists: '1',
  existsFails: false,
  fenceFails: false,
  liftFails: false,
  dropFails: false,
  dumpCode: 0,
  restoreCode: 0,
  saveFails: false,
  clearFails: false,
  stopFails: {} as Record<string, string>,
  startFails: {} as Record<string, string>,
  stopInOpFails: null as string | null,
  stopInOpNotRunning: false,
  throwLive: null as string | null,
  throwAt: null as string | null,
  restoreGate: null as Promise<void> | null,
  at: {} as Record<string, () => void>,
  hooks: [] as string[],
  noticeAtDrop: undefined as unknown,
  floorAtDrop: null as string | null,
  volumeGone: false,
  showOn: false,
  countArgs: [] as string[][],
}));

const lc = vi.hoisted(() => ({ lifting: false, hba: null as null | 'fail' | 'held', reloadFails: false, volumeUnknown: false, stripFails: false }));

vi.mock('../../src/config/appCapabilities', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/config/appCapabilities')>();
  return { ...real, findAppCapabilities: () => ({ companionDb: { env: { url: 'DATABASE_URL' } } }) };
});
vi.mock('../../src/env/manager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/env/manager')>();
  return {
    ...real,
    getEnvVarsWithStatus: (id: string) => ({ vars: { DATABASE_URL: pg.urls[id] ?? '' }, corrupt: pg.storeCorrupt, undecryptable: [], encrypted: [] }),
    getEnvVars: (id: string) => ({ DATABASE_URL: pg.urls[id] ?? '' }),
  };
});
vi.mock('../../src/instance/fleetReplica', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/instance/fleetReplica')>();
  return { ...real, seedView: (inst: any) => (pg.seed && inst.id === 'a' ? pg.seed : real.seedView(inst)) };
});
vi.mock('../../src/instance/appHookClient', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/instance/appHookClient')>();
  return { ...real, callAppHook: async (inst: any) => { pg.hooks.push(inst.id); return { ok: true, status: 200, body: { success: true } }; } };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  const ev = (name: string) => { pg.events.push(name); pg.at[name]?.(); };
  return {
    ...real,
    isShuttingDown: () => pg.shutdown,
    runningInstanceContainers: async (id: string) => {
      if (pg.throwLive === id) throw new Error(`docker ps crashed for ${id}`);
      return id in pg.live ? pg.live[id] : [];
    },
    startFleetDbSidecar: async () => {
      ev('sidecar-up');
      const ok = pg.sidecarStarts.length > 0 ? pg.sidecarStarts.shift()! : true;
      if (!ok) return { success: false, error: 'port 5432 is in use' };
      pg.sidecar = true;
      return { success: true };
    },
    stopBot: async (id: string) => {
      ev(`stop:${id}`);
      if (pg.stopFails[id]) return { success: false, error: pg.stopFails[id] };
      pg.live[id] = [];
      return { success: true };
    },
    startBot: async (id: string) => {
      ev(`start:${id}`);
      if (pg.startFails[id]) return { success: false, error: pg.startFails[id] };
      return { success: true };
    },
    stopBotInOp: async (id: string, op: string) => {
      ev(`stopInOp:${id}`);
      if (real.isBotBusy(id) !== op) return { success: false, error: `the stop must run under the '${op}' operation, which is not held` };
      if (pg.stopInOpFails) return { success: false, error: pg.stopInOpFails };
      if (pg.stopInOpNotRunning) return { success: false, error: 'Bot is not running' };
      pg.live[id] = [];
      pg.sidecar = false;
      return { success: true };
    },
    startBotInOp: async (id: string) => { ev(`startInOp:${id}`); return { success: true }; },
    updateInstanceFleetRestoreError: (botId: string, notice: { file: string; text: string } | null) => {
      if (notice === null) pg.at.clear?.();
      if (notice && pg.saveFails) throw new Error('ENOSPC: no space left on device');
      if (!notice && pg.clearFails) throw new Error('EACCES: permission denied');
      real.updateInstanceFleetRestoreError(botId, notice as any);
      if (notice) pg.at.notice?.();
    },
  };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = require('events') as typeof import('events');
  const { PassThrough } = require('stream') as typeof import('stream');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const ev = (name: string) => {
    pg.events.push(name);
    pg.at[name]?.();
    if (pg.throwAt === name) { pg.throwAt = null; throw new Error(`docker crashed at ${name}`); }
  };
  const execFile = vi.fn((_cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (err: Error | null, stdout: string, stderr: string) => void;
    const sql = args.join(' ');
    pg.sql.push(sql);
    const fail = (text: string) => cb(new Error(text), '', `ERROR:  ${text}`);
    if (args[0] === 'inspect') return cb(null, args[args.length - 1] === 'bot-a-postgres' ? `${pg.sidecar}\n` : 'true\n', '');
    const readOnlyOn = ((globalThis as any).__fenceOwners as Map<string, string> | undefined)?.has('bot-a-postgres') === true;
    if (sql.includes('rolsuper')) return cb(null, 'true\n', '');
    if (sql.includes('ALTER ROLE') && !sql.includes('PGOPTIONS=-c default_transaction_read_only=off') && readOnlyOn) return fail('cannot execute ALTER ROLE in a read-only transaction');
    if (sql.endsWith("SELECT current_setting('default_transaction_read_only')")) return cb(null, readOnlyOn ? 'on\n' : 'off\n', '');
    if (args[0] === 'volume' && args[1] === 'inspect' && pg.volumeGone) return cb(new Error('exit 1'), '', `Error response from daemon: get ${args[2]}: no such volume`);
    if (args[0] === 'stop') {
      pg.events.push(`docker-stop:${args[1]}`);
      for (const id of Object.keys(pg.live)) pg.live[id] = pg.live[id]?.filter(n => n !== args[1]) ?? null;
      return cb(null, '', '');
    }
    if (sql.includes('ALTER SYSTEM SET default_transaction_read_only = on')) {
      if (pg.fenceFails) return fail('could not write auto.conf');
      ev('fence');
      return cb(null, '0\n', '');
    }
    if (sql.includes('ALTER SYSTEM RESET')) {
      ev('lift');
      return pg.liftFails ? fail('could not write auto.conf') : cb(null, '', '');
    }
    if (sql.includes('SHOW default_transaction_read_only')) return cb(null, pg.showOn ? 'on\n' : 'off\n', '');
    if (sql.includes('FROM pg_database WHERE datname')) return pg.existsFails ? fail('the database system is starting up') : cb(null, `${pg.exists}\n`, '');
    if (sql.includes('DROP DATABASE')) {
      const registry = JSON.parse(nodeFs.readFileSync(nodePath.join(tmp.dir, 'instances.json'), 'utf-8'));
      pg.noticeAtDrop = registry.instances.a.fleetRestoreError;
      const floorFile = nodePath.join(tmp.dir, 'backups', 'a', 'fleet-postgres', 'claim-floor.json');
      pg.floorAtDrop = nodeFs.existsSync(floorFile) ? nodeFs.readFileSync(floorFile, 'utf-8') : null;
      ev('drop');
      if (pg.dropFails) return fail('database "app" is being accessed by other users');
    }
    return cb(null, '', '');
  });
  const exec = (_cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    done(null, { stdout: '', stderr: '' });
  };
  const spawn = vi.fn((_cmd: string, args: string[]) => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.resume();
    child.kill = () => true;
    const isDump = args.includes('pg_dump');
    ev(isDump ? 'dump' : 'pg_restore');
    const code = isDump ? pg.dumpCode : pg.restoreCode;
    void (async () => {
      if (!isDump && pg.restoreGate) await pg.restoreGate;
      setTimeout(() => {
        child.stdout.end(isDump && !code ? 'dump' : '');
        child.stderr.end(code ? (isDump ? 'pg_dump: error: connection lost' : 'pg_restore: error: out of disk') : '');
        setTimeout(() => child.emit('close', code), 5);
      }, 5);
    })();
    return child;
  });
  const fakes = await import('./restore-fake');
  const fencedExecFile = (await import('./fence-fake')).withFence(fakes.withRestoreFakes(execFile as any));
  const heldSpawn = (await import('./dump-fake')).withDumpHolder(fakes.withTocFake(spawn as any));
  const liftExecFile = (cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (err: Error | null, stdout: string, stderr: string) => void;
    const sql = args.join(' ');
    if (sql.includes('SELECT count(*) AS c FROM')) pg.countArgs.push([...args]);
    if (args[0] === 'exec' && args[1] === '-u' && sql.includes('held-hba')) {
      lc.lifting = true;
      if (lc.hba === 'fail') return cb(new Error('exit 1'), '', 'Error response from daemon: container is not running');
      if (lc.hba === 'held') return cb(null, 'held-hba reseed:1700000000000\n', '');
    }
    if (lc.lifting && lc.reloadFails && args[0] === 'exec' && sql.endsWith('-c SELECT pg_reload_conf()') && !sql.includes('ALTER SYSTEM RESET')) return cb(new Error('reload'), '', 'psql: error: connection refused');
    if (lc.lifting && lc.volumeUnknown && args[0] === 'volume' && args[1] === 'inspect') return cb(new Error('docker'), '', 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock');
    if (lc.lifting && lc.stripFails && args[0] === 'run' && sql.includes(':/pgdata')) return cb(new Error('docker'), '', 'docker: Error response from daemon: no space left on device');
    return (fencedExecFile as any)(cmd, args, optsOrCb, maybeCb);
  };
  return { ...real, execFile: liftExecFile, exec, spawn: heldSpawn, default: { ...real, execFile: liftExecFile, exec, spawn: heldSpawn } };
});

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as fleetBackup from '../../src/instance/fleetBackup';
import * as maintenance from '../../src/instance/maintenance';
import { MANAGER_DB_ROLE } from '../../src/instance/dbLogin';
import { fenceOwners } from './fence-fake';
import { holder, resetHolder } from './dump-fake';
import { claimDb, resetClaimDb, writeDumpMeta, COUNTS_OF, TOC, MAINTAINED } from './restore-fake';

const REGISTRY = path.join(tmp.dir, 'instances.json');
const DIR = path.join(tmp.dir, 'backups', 'a', 'fleet-postgres');
const primary = { containerName: 'bot-a-postgres', user: 'app', db: 'app', volume: 'bot-a-pgdata' };
const MOVED = 'moved-2026-11-12T10-00-00-000Z.dump';

function writeRegistry(extraA: Record<string, unknown> = MAINTAINED): void {
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: {
    a: { id: 'a', displayName: 'a', sanitizedName: 'bot-a', status: 'running', sourceUrl: 'https://example.invalid/fake/app', createdAt: '2026-10-01T00:00:00.000Z', fleetDb: primary, fleetBackup: { enabled: false, hour: 4, keep: 7 }, ...extraA },
    w: { id: 'w', displayName: 'w', status: 'running', sourceUrl: 'https://example.invalid/fake/app' },
  } }, null, 2));
}
const registryA = () => JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')).instances.a;

const logs = { log: [] as string[], warn: [] as string[], error: [] as string[] };

function reset(): void {
  Object.assign(pg, {
    sidecar: true, sidecarStarts: [], shutdown: false, storeCorrupt: false, seed: null, exists: '1', existsFails: false, fenceFails: false,
    liftFails: false, dropFails: false, dumpCode: 0, restoreCode: 0, saveFails: false, clearFails: false, stopFails: {}, startFails: {},
    stopInOpFails: null, stopInOpNotRunning: false, throwLive: null, throwAt: null, restoreGate: null, at: {}, hooks: [], noticeAtDrop: undefined, floorAtDrop: null, volumeGone: false, showOn: false,
  });
  pg.events.length = 0;
  pg.sql.length = 0;
  pg.countArgs.length = 0;
  pg.urls = { a: 'postgres://app:pw@bot-a-postgres/app', w: 'postgres://app:pw@bot-a-postgres:5432/app?sslmode=no-verify' };
  pg.live = { a: ['bot-a-app'], w: ['bot-w-app'] };
  Object.assign(lc, { lifting: false, hba: null, reloadFails: false, volumeUnknown: false, stripFails: false });
  resetClaimDb({ onRaise: () => pg.events.push('raise'), onCount: () => pg.events.push('count') });
  resetHolder();
  fenceOwners.clear();
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, 'old.dump'), 'dump');
  writeDumpMeta(DIR, 'old.dump');
  fleetBackup.clearClaimFloor('a');
  fleetBackup.dismissFleetRestoreError('a');
  writeRegistry();
  fs.mkdirSync(path.join(tmp.dir, 'bots', 'a'), { recursive: true });
  for (const k of ['log', 'warn', 'error'] as const) logs[k].length = 0;
}

beforeEach(() => {
  reset();
  for (const k of ['log', 'warn', 'error'] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logs[k].push(a.map(String).join(' ')); });
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => { fs.rmSync(tmp.dir, { recursive: true, force: true }); });

const at = (event: string) => pg.events.indexOf(event);
const restore = (file = 'old.dump') => fleetBackup.restoreFleetBackup('a', file);
const dropped = () => pg.events.includes('drop');
const metaPath = (file = 'old.dump') => path.join(DIR, `${file}.json`);
const writeMetaRaw = (text: string) => fs.writeFileSync(metaPath(), text);
const metaWith = (over: Record<string, unknown>) => writeMetaRaw(JSON.stringify({ ...JSON.parse(fs.readFileSync(metaPath(), 'utf-8')), ...over }));

const CT = '1 table(s) differ from the counts recorded when the backup was taken: smdb_data.meta: 1 recorded, 0 restored';
const CT_RE = CT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const DIFFER = { 'smdb_data.guild_ownership': 2, 'smdb_data.meta': 0 };
const UNREAD = (e: string) => `the restored tables could not be counted (${e}), so the manager can't confirm that the database holds what the backup held`;
const RESET = 'ERROR:  connection reset by peer';
const BACK = (p: string) => `the pre-restore dump ${p} holds the database as it was`;
const STOPPED = '. The other instances stopped for the restore stay stopped (w); start them by hand once the data is settled';
const N_COUNTS = (ct: string, p: string) => `Restore of old.dump ran, but ${ct}. The bot's login stays blocked, so the bot writes nothing, and the other instances stopped for the restore stay stopped (w). Running is refused until you restore a dump again (${BACK(p)}) or dismiss this notice to keep the restored data`;
const E_COUNTS = (ct: string, p: string) => `The dump old.dump was restored, but ${ct}. The bot stays in maintenance, and Running is refused while the notice on the Database window stands: restore a dump again (${BACK(p)}), or dismiss the notice to keep the restored data${STOPPED}`;
const NOTHING = 'so the manager cannot check what it restores and the restore was refused (nothing was changed); restore another dump';
const T11 = (f: string) => `The dump ${f} has no counts file (${f}.json), ${NOTHING}`;
const T12 = (e: string) => `The counts file of the dump old.dump could not be read (${e}), ${NOTHING}`;
const T14 = (detail: string) => `The counts file of the dump old.dump records tables the dump does not hold, so the restore was refused, and nothing was changed: ${detail}`;
const PENDING = /^Restore of old\.dump has not finished: .*restore a dump again before choosing Running \(the pre-restore dump is pre-restore-[^)]+\.dump\)$/;
const R13 = 'A restore of old.dump has not finished cleanly (its notice is on the Database window), so Running was refused and nothing was changed; restore a dump again, or dismiss the notice to choose Running anyway';
const RETRY = 'running a restore again with the bot in Maintenance or Off retries the lift';

/** Refused at P0j: no lock, no TOC read, nothing run. */
const atAdmission = (r: any, error: string | RegExp) => {
  expect(r.success).toBe(false);
  if (typeof error === 'string') expect(r.error).toBe(error);
  else expect(r.error).toMatch(error);
  expect(claimDb.tocReads).toBe(0);
  expect(pg.events).toEqual([]);
  expect(r.steps.counts).toBeNull();
};
/** Refused at P7j: the TOC was read, nothing stopped, fenced, dropped or counted. */
const atToc = (r: any, detail: string) => {
  expect(r.success).toBe(false);
  expect(r.error).toBe(T14(detail));
  expect(claimDb.tocReads).toBe(1);
  expect(pg.events.filter(e => e.startsWith('stop') || e === 'fence' || e === 'drop' || e === 'count')).toEqual([]);
  expect(registryA().fleetRestoreError).toBeUndefined();
};
/** The doubtful lifted exit (Q27). */
const doubtful = (r: any, ct: string) => {
  expect(r.success).toBe(false);
  expect(r.error).toBe(E_COUNTS(ct, r.steps.preRestoreDump));
  expect(r.steps.restored).toBe(true);
  expect(r.steps.restarted).toEqual([]);
  expect(pg.events).not.toContain('start:w');
  expect(at('pg_restore')).toBeLessThan(at('count'));
  expect(at('count')).toBeLessThan(at('lift'));
  const notice = registryA().fleetRestoreError;
  expect(notice.text).toBe(N_COUNTS(ct, r.steps.preRestoreDump));
  expect(notice.doubt).toBe(true);
  expect(claimDb.genEvents).not.toContain('state-clear');
  expect(fenceOwners.has('bot-a-postgres')).toBe(false);
  expect(logs.error).toContain(`[FleetBackup] Restore of old.dump on bot-a-postgres: ${ct}`);
};
const succeeded = (r: any, counts: unknown) => {
  expect(r.success).toBe(true);
  expect(r.steps.counts).toEqual(counts);
  expect(registryA().fleetRestoreError).toBeUndefined();
  expect(at('lift')).toBeLessThan(at('start:w'));
};
const MATCHED = { result: 'matched', tables: 2, rows: 3, text: null };

type Row = { id: string; setup?: () => void; file?: string; check: (r: any) => void };

const metaBreaks: Array<[string, () => void]> = [
  ['the counts file holds no object', () => writeMetaRaw('null')],
  ['the counts file names no dump', () => metaWith({ file: 'old.txt' })],
  ['the counts file has no time it was taken', () => metaWith({ takenAt: null })],
  ['the counts file names no family', () => metaWith({ family: 'other' })],
  ['the counts file names no kind', () => metaWith({ kind: 'weekly' })],
  ['the counts file has no database state', () => metaWith({ inRecovery: 'no' })],
  ['the counts file has no counts', () => metaWith({ counts: [] })],
  ['a count in the counts file is not a whole number of 0 or more', () => metaWith({ counts: { 'smdb_data.meta': 1.5 } })],
  ['the totals in the counts file do not match its counts', () => metaWith({ tables: 9 })],
];

const seven = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`smdb_data.x${i + 1}`, 0]));
const noMetaData = TOC.claims.replace('3361; 0 16400 TABLE DATA smdb_data meta app\n', '');

const ROWS: Row[] = [
  { id: 'Q1 a valid counts file that names the dump', check: r => { expect(r.success).toBe(true); expect(claimDb.tocReads).toBe(1); } },
  { id: 'Q2 no counts file', setup: () => fs.rmSync(metaPath()), check: r => atAdmission(r, T11('old.dump')) },
  {
    id: 'Q3 an uploaded dump with no counts file goes on', file: MOVED, setup: () => fs.writeFileSync(path.join(DIR, MOVED), 'dump'),
    check: r => { expect(r.success).toBe(true); expect(dropped()).toBe(true); expect(r.steps.counts.result).toBe('unrecorded'); },
  },
  { id: 'Q4 the counts file cannot be read', setup: () => { fs.rmSync(metaPath()); fs.mkdirSync(metaPath()); }, check: r => atAdmission(r, /^The counts file of the dump old\.dump could not be read \(EISDIR: .*\), so the manager cannot check what it restores and the restore was refused \(nothing was changed\); restore another dump$/) },
  { id: 'Q5 the counts file is not JSON', setup: () => writeMetaRaw('{'), check: r => atAdmission(r, T12('it is not JSON')) },
  ...metaBreaks.map(([text, setup]): Row => ({ id: `Q6 ${text}`, setup, check: r => atAdmission(r, T12(text)) })),
  {
    id: 'Q7 the counts file names another dump', setup: () => writeDumpMeta(DIR, 'old.dump', undefined, { file: 'other.dump' }),
    check: r => atAdmission(r, 'The counts file old.dump.json names the dump other.dump, so it does not describe this dump and the restore was refused (nothing was changed); restore another dump'),
  },
  {
    id: 'Q8 an uploaded dump with a counts file is compared', file: MOVED, setup: () => { fs.writeFileSync(path.join(DIR, MOVED), 'dump'); writeDumpMeta(DIR, MOVED); },
    check: r => { expect(r.success).toBe(true); expect(r.steps.counts).toEqual(MATCHED); },
  },
  { id: 'Q9 every recorded table is listed with its data', check: r => { expect(r.success).toBe(true); expect(pg.events).toContain('fence'); } },
  {
    id: 'Q10 a recorded table the TOC does not list', setup: () => writeDumpMeta(DIR, 'old.dump', { ...COUNTS_OF.claims, 'smdb_data.extra': 0 }),
    check: r => atToc(r, '1 table(s) do not fit its table of contents: smdb_data.extra: no table in the dump'),
  },
  {
    id: 'Q11 a table recorded with rows and no data entry', setup: () => { claimDb.tocText = noMetaData; },
    check: r => atToc(r, '1 table(s) do not fit its table of contents: smdb_data.meta: 1 row(s) recorded, no data in the dump'),
  },
  {
    id: 'Q12 a header-only TOC under a counts file that records rows', setup: () => { claimDb.toc = 'empty'; writeDumpMeta(DIR, 'old.dump', COUNTS_OF.claims); },
    check: r => atToc(r, '2 table(s) do not fit its table of contents: smdb_data.guild_ownership: no table in the dump; smdb_data.meta: no table in the dump'),
  },
  {
    id: 'Q13 a header-only TOC under a counts file that records no table', setup: () => { claimDb.toc = 'empty'; claimDb.tables = 'f|f|f|f|f'; writeDumpMeta(DIR, 'old.dump'); },
    check: r => { expect(r.success).toBe(true); expect(r.steps.counts).toEqual({ result: 'matched', tables: 0, rows: 0, text: null }); },
  },
  {
    id: 'Q14 a table recorded with 0 rows needs only its TABLE entry', setup: () => { claimDb.tocText = noMetaData; writeDumpMeta(DIR, 'old.dump', { 'smdb_data.guild_ownership': 2, 'smdb_data.meta': 0 }); },
    check: r => { expect(r.success).toBe(true); expect(r.steps.counts).toEqual({ result: 'matched', tables: 2, rows: 2, text: null }); },
  },
  {
    id: 'Q15 a recorded name that is not two identifiers', setup: () => writeDumpMeta(DIR, 'old.dump', { 'a.b.c': 1 }),
    check: r => atToc(r, '1 table(s) do not fit its table of contents: a.b.c: not a schema and table name'),
  },
  {
    id: 'Q16 more than five gaps', setup: () => writeDumpMeta(DIR, 'old.dump', { ...COUNTS_OF.claims, ...seven }),
    check: r => atToc(r, `7 table(s) do not fit its table of contents: ${[1, 2, 3, 4, 5].map(i => `smdb_data.x${i}: no table in the dump`).join('; ')}, and 2 more`),
  },
  {
    id: 'Q17 a TOC at the read cap skips the check, and the comparison catches the table',
    setup: () => {
      claimDb.tocText = `${TOC.claims};`.padEnd(fleetBackup.TOC_MAX_CHARS - 1, 'x') + '\n';
      writeDumpMeta(DIR, 'old.dump', { ...COUNTS_OF.claims, 'smdb_data.extra': 1 });
      claimDb.restoredCounts = COUNTS_OF.claims;
    },
    check: r => {
      expect(logs.warn).toContain('[FleetBackup] The table of contents of old.dump is longer than 8 MB, so its counts file was checked only after the restore');
      expect(dropped()).toBe(true);
      expect(r.steps.counts).toEqual({ result: 'differ', tables: 2, rows: 3, text: '1 table(s) differ from the counts recorded when the backup was taken: smdb_data.extra: missing after the restore' });
      expect(r.success).toBe(false);
    },
  },
  {
    id: 'Q19 counts equal', check: r => {
      succeeded(r, MATCHED);
      expect(logs.log).toContain('[FleetBackup] Restore of old.dump on bot-a-postgres: 2 tables and 3 rows match its counts file');
    },
  },
  {
    id: 'Q20 a table has fewer rows', setup: () => { claimDb.restoredCounts = DIFFER; },
    check: r => {
      expect(r.steps.counts).toEqual({ result: 'differ', tables: 2, rows: 2, text: CT });
      expect(at('count')).toBeLessThan(at('raise'));
      expect(logs.error).toContain(`[FleetBackup] Restore of old.dump on bot-a-postgres: ${CT}`);
      expect(r.steps.claimRaisedTo).toBe(8);
      expect(r.steps.generation).not.toBeNull();
    },
  },
  {
    id: 'Q21 a recorded table missing after the restore', setup: () => { claimDb.restoredCounts = { 'smdb_data.meta': 1 }; },
    check: r => doubtful(r, '1 table(s) differ from the counts recorded when the backup was taken: smdb_data.guild_ownership: missing after the restore'),
  },
  {
    id: 'Q21 a restored table not recorded', setup: () => { claimDb.restoredCounts = { ...COUNTS_OF.claims, 'public.x': 1 }; },
    check: r => doubtful(r, '1 table(s) differ from the counts recorded when the backup was taken: public.x: not in the recorded counts'),
  },
  {
    id: 'Q22 the count fails', setup: () => { claimDb.fail = 'counts'; },
    check: r => { doubtful(r, UNREAD(RESET)); expect(r.steps.counts).toEqual({ result: 'unread', tables: null, rows: null, text: RESET }); },
  },
  {
    id: 'Q23 the count does not parse', setup: () => { claimDb.countRaw = 'count|smdb_data.meta|x\n'; },
    check: r => {
      doubtful(r, UNREAD('a table count read back as count|smdb_data.meta|x'));
      expect(r.steps.counts).toEqual({ result: 'unread', tables: null, rows: null, text: 'a table count read back as count|smdb_data.meta|x' });
    },
  },
  {
    id: 'Q24 an uploaded dump without a counts file: totals, not compared', file: MOVED, setup: () => fs.writeFileSync(path.join(DIR, MOVED), 'dump'),
    check: r => {
      succeeded(r, { result: 'unrecorded', tables: 2, rows: 3, text: null });
      expect(logs.log).toContain(`[FleetBackup] Restore of ${MOVED} on bot-a-postgres: the uploaded backup has no counts file, so the restored 2 tables and 3 rows were not compared`);
    },
  },
  {
    id: 'Q25 an uploaded dump without a counts file whose count fails', file: MOVED, setup: () => { fs.writeFileSync(path.join(DIR, MOVED), 'dump'); claimDb.fail = 'counts'; },
    check: r => {
      succeeded(r, { result: 'unrecorded', tables: null, rows: null, text: RESET });
      expect([...logs.log, ...logs.warn]).toContain(`[FleetBackup] Restore of ${MOVED} on bot-a-postgres: the uploaded backup has no counts file, and the restored tables could not be counted (${RESET})`);
    },
  },
  {
    id: 'Q26 the raise fails after a difference', setup: () => { claimDb.restoredCounts = DIFFER; claimDb.fail = 'raise'; },
    check: r => {
      expect(r.error).toMatch(new RegExp(`^The dump was restored, but the restored claim numbers could not be raised above 7 \\(ERROR:  permission denied for sequence claim_seq\\); ${CT_RE}\\. The write fence stays on`));
      expect(registryA().fleetRestoreError.text).toMatch(new RegExp(`^Restore of old\\.dump failed: the restored claim numbers could not be raised above 7 \\(ERROR:  permission denied for sequence claim_seq\\); ${CT_RE}\\. `));
      expect(fleetBackup.getFleetFenceStuck('a')).toContain(`; ${CT})`);
    },
  },
  {
    id: 'Q26 the cap fails after a difference', setup: () => { claimDb.restoredCounts = DIFFER; claimDb.tables = 'f|f|f|f|f'; claimDb.restoredTables = 't|t|t|t|t'; claimDb.fail = 'cap'; },
    check: r => {
      expect(r.error).toMatch(new RegExp(`^The dump was restored, but the restored shard claims could not be expired \\(ERROR:  permission denied for table shard_claims\\); ${CT_RE}\\. The write fence stays on`));
      expect(registryA().fleetRestoreError.text).toContain(`could not be expired (ERROR:  permission denied for table shard_claims); ${CT}. `);
    },
  },
  {
    id: 'Q26 the generation write fails after a difference', setup: () => { claimDb.restoredCounts = DIFFER; claimDb.fail = 'genwrite'; },
    check: r => {
      expect(r.error).toMatch(new RegExp(`^The dump was restored, but the generation row could not be written back \\(ERROR:  cannot execute INSERT in a read-only transaction\\); ${CT_RE}\\. The write fence stays on`));
      expect(registryA().fleetRestoreError.text).toContain(`(ERROR:  cannot execute INSERT in a read-only transaction); ${CT}. `);
    },
  },
  {
    id: 'Q26 a sharer started meanwhile after a difference', setup: () => { claimDb.restoredCounts = DIFFER; claimDb.onRaise = () => { pg.events.push('raise'); pg.live.w = ['bot-w-app']; }; },
    check: r => {
      expect(r.error).toMatch(new RegExp(`^The dump was restored, but bot-w-app was started outside the manager during the restore and may act on what it read while the database was rebuilt; stop it; ${CT_RE}\\. w runs now\\. The write fence stays on`));
      expect(registryA().fleetRestoreError.text).toContain(`stop it; ${CT}. `);
    },
  },
  { id: 'Q27 the lift ends lifted after a difference', setup: () => { claimDb.restoredCounts = DIFFER; }, check: r => doubtful(r, CT) },
  {
    id: 'Q27 a push mark stays after a difference', setup: () => { writeRegistry({ ...MAINTAINED, fleetDb: { ...primary, pushBroken: { at: '2026-11-12T09:00:00.000Z', safetyDump: 'pre-receive-x.dump' } } }); claimDb.restoredCounts = DIFFER; },
    check: r => { doubtful(r, CT); expect(registryA().fleetDb.pushBroken).toEqual({ at: '2026-11-12T09:00:00.000Z', safetyDump: 'pre-receive-x.dump' }); expect(claimDb.genEvents).not.toContain('mark-clear'); },
  },
  {
    id: 'Q29 the registry refuses the N-COUNTS write', setup: () => { claimDb.restoredCounts = DIFFER; claimDb.onCount = () => { pg.events.push('count'); pg.saveFails = true; }; },
    check: r => {
      expect(r.error).toBe(E_COUNTS(CT, r.steps.preRestoreDump));
      expect(registryA().fleetRestoreError.text).toMatch(PENDING);
      expect(fleetBackup.getFleetRestoreError('a')).toBe(`${N_COUNTS(CT, r.steps.preRestoreDump)} (this notice is not saved and a manager restart drops it)`);
      expect(pg.events).not.toContain('start:w');
    },
  },
  {
    id: 'Q30 the success row', check: r => {
      succeeded(r, MATCHED);
      expect(r.steps.restarted).toEqual(['w']);
      expect(claimDb.genEvents).toContain('state-clear');
    },
  },
];

describe('NM18 the restore lane, one row per cell', () => {
  it.each(ROWS)('$id', async (row) => {
    row.setup?.();
    const r = await restore(row.file);
    row.check(r);
    expect(containerManager.isBotBusy('a')).toBeNull();
    expect(pg.events).not.toContain('start:a');
  });
});

describe('NM18 Q28: a lift that does not end lifted after a difference', () => {
  const WAY = (p: string) => `restore a dump again (${BACK(p)}), or dismiss this notice to keep the restored data`;
  const ANSWER_WAY = (p: string) => `restore a dump again (${BACK(p)}), or dismiss the notice on the Database window to keep the restored data`;
  const HELD = "the database refuses every connection but the manager's, so the bot cannot reach it: the pg_hba lines of the write fence belong to a re-seed (started 2023-11-14 22:13 UTC), so the restore left them on; running that lane again lifts it";
  const FAILED = `the write fence could not be lifted or stripped: the database stays READ-ONLY, a restart does not clear it, and ${RETRY}`;
  const rows: Array<{ lift: string; drive: () => void; clause: string; tail: (p: string) => string; way: (p: string) => string }> = [
    {
      lift: 'stripped', drive: () => { pg.liftFails = true; },
      clause: "the write fence could not be lifted live: the database is READ-ONLY, and may still refuse the bot's connections, until its container restarts",
      tail: p => `; restart the instance, then ${WAY(p)}`, way: p => `Restart the instance, then ${ANSWER_WAY(p)}`,
    },
    { lift: 'held', drive: () => { lc.hba = 'held'; }, clause: HELD, tail: p => `; once the fence is lifted, ${WAY(p)}`, way: p => `Once the fence is lifted, ${ANSWER_WAY(p)}` },
    {
      lift: 'gone', drive: () => { pg.liftFails = true; pg.at.drop = () => { pg.volumeGone = true; }; },
      clause: "the database volume bot-a-pgdata is gone now, so this manager can't confirm that the restored data exists",
      tail: () => '; with the bot in Maintenance or Off, restore a dump again', way: () => 'With the bot in Maintenance or Off, restore a dump again',
    },
    { lift: 'failed', drive: () => { pg.liftFails = true; lc.stripFails = true; }, clause: FAILED, tail: p => `; restore a dump again (${BACK(p)})`, way: p => `Restore a dump again (${BACK(p)})` },
    {
      lift: 'locked', drive: () => { lc.hba = 'fail'; lc.stripFails = true; },
      clause: `the pg_hba lines of the write fence could not be removed: the database refuses every connection but the manager's, so the bot cannot reach it, a restart does not clear it, and ${RETRY}`,
      tail: p => `; restore a dump again (${BACK(p)})`, way: p => `Restore a dump again (${BACK(p)})`,
    },
    {
      lift: 'unreloaded', drive: () => { pg.liftFails = true; lc.reloadFails = true; lc.stripFails = true; },
      clause: `the write fence could not be lifted or stripped: the database stays READ-ONLY, a restart does not clear it, and ${RETRY}; it may also refuse the bot's connections until it reloads or restarts`,
      tail: p => `; restore a dump again (${BACK(p)})`, way: p => `Restore a dump again (${BACK(p)})`,
    },
    {
      lift: 'unknown', drive: () => { pg.liftFails = true; lc.volumeUnknown = true; },
      clause: `the write fence could not be lifted live, and docker did not answer whether the database volume bot-a-pgdata exists, so this manager can't confirm whether the database is still READ-ONLY or refusing the bot's connections; ${RETRY}`,
      tail: p => `; restore a dump again (${BACK(p)})`, way: p => `Restore a dump again (${BACK(p)})`,
    },
  ];

  it.each(rows)('Q28 $lift', async ({ lift, drive, clause, tail, way }) => {
    claimDb.restoredCounts = DIFFER;
    drive();
    const r = await restore();
    const p = r.steps.preRestoreDump!;
    expect(r.success).toBe(false);
    expect(r.error).toBe(`${lift === 'gone' ? 'The restore ran' : 'Restored'}, but ${CT}, and ${clause} (see manager logs). ${way(p)}${STOPPED}`);
    const notice = registryA().fleetRestoreError;
    expect(notice.text).toBe(`Restore of old.dump ran (${CT}), but ${clause}${tail(p)}`);
    expect(notice.doubt).toBe(true);
    expect(pg.events).not.toContain('start:w');
    expect(r.steps.restarted).toEqual([]);
    expect(containerManager.isBotBusy('a')).toBeNull();
  });

  it('Q28b a refusal before the drop merges onto the doubtful notice', async () => {
    claimDb.restoredCounts = DIFFER;
    pg.liftFails = true;
    await restore();
    const first = registryA().fleetRestoreError;
    pg.events.length = 0;
    claimDb.restoredCounts = null;
    claimDb.dropSeen = false;
    holder.failQueue = ['pg_dump: error: connection lost'];
    pg.dumpCode = 1;
    const r = await restore();
    expect(r.success).toBe(false);
    expect(dropped()).toBe(false);
    const notice = registryA().fleetRestoreError;
    expect(notice.text.startsWith(`${first.text.replace(/\.$/, '')}. Then a restore of old.dump was refused before the database was dropped, but `)).toBe(true);
    expect(notice.text).toContain(CT);
    expect(notice.doubt).toBe(true);
  });

  it('Q28c a matched restore whose lift ends stripped keeps its notice without doubt', async () => {
    pg.liftFails = true;
    const r = await restore();
    const notice = registryA().fleetRestoreError;
    expect(r.error).toBe("Restored, but the write fence could not be lifted live: the database is READ-ONLY, and may still refuse the bot's connections, until its container restarts (see manager logs)");
    expect(notice.text).toBe("Restore of old.dump ran, but the write fence could not be lifted live: the database is READ-ONLY, and may still refuse the bot's connections, until its container restarts; restart the instance, then dismiss this notice");
    expect(notice.doubt).toBe(false);
    expect(notice.text).not.toContain('pre-restore');
  });
});

describe('NM18 named rows', () => {
  it('R-COUNT-ORDER: the count runs after pg_restore, before the raise and the lift, as the manager role in an ordinary session', async () => {
    const r = await restore();
    expect(r.success).toBe(true);
    const order = pg.events.filter(e => ['pg_restore', 'count', 'raise', 'lift'].includes(e));
    expect(order).toEqual(['pg_restore', 'count', 'raise', 'lift']);
    expect(pg.countArgs).toHaveLength(1);
    const argv = pg.countArgs[0];
    expect(argv[argv.indexOf('-U') + 1]).toBe(MANAGER_DB_ROLE);
    expect(argv[argv.indexOf('-d') + 1]).toBe('app');
    expect(argv.join(' ')).not.toContain('PGOPTIONS');
  });

  it('R-COUNT-ORDER: two dumps with different counts files each match their own', async () => {
    fs.writeFileSync(path.join(DIR, 'second.dump'), 'dump');
    writeDumpMeta(DIR, 'second.dump', { 'smdb_data.guild_ownership': 5, 'smdb_data.meta': 4 });
    const first = await restore();
    claimDb.dropSeen = false;
    const second = await restore('second.dump');
    expect(first.steps.counts).toEqual(MATCHED);
    expect(second.steps.counts).toEqual({ result: 'matched', tables: 2, rows: 9, text: null });
    expect(second.success).toBe(true);
  });

  it('R-NO-COUNT-BEFORE: refusals at P0j read no TOC, refusals at P7j stop, fence, drop and count nothing', async () => {
    const cases: Array<[() => void, (r: any) => void]> = [
      [() => fs.rmSync(metaPath()), r => atAdmission(r, T11('old.dump'))],
      [() => writeMetaRaw('{'), r => atAdmission(r, T12('it is not JSON'))],
      [() => writeDumpMeta(DIR, 'old.dump', undefined, { file: 'other.dump' }), r => expect(claimDb.tocReads).toBe(0)],
      [() => writeDumpMeta(DIR, 'old.dump', { ...COUNTS_OF.claims, 'smdb_data.extra': 0 }), r => atToc(r, '1 table(s) do not fit its table of contents: smdb_data.extra: no table in the dump')],
      [() => { claimDb.toc = 'empty'; }, r => atToc(r, '2 table(s) do not fit its table of contents: smdb_data.guild_ownership: no table in the dump; smdb_data.meta: no table in the dump')],
    ];
    for (const [setup, check] of cases) {
      reset();
      setup();
      const r = await restore();
      check(r);
      expect(claimDb.countReads).toBe(0);
      expect(dropped()).toBe(false);
    }
  });
});

describe('NM18 XQ rows: the durable state a manager restart would read', () => {
  const snapshot = () => ({ notice: registryA().fleetRestoreError?.text ?? null, doubt: registryA().fleetRestoreError?.doubt, fence: fenceOwners.has('bot-a-postgres') });

  it('XQ2 between pg_restore and the count answer', async () => {
    let snap: ReturnType<typeof snapshot> | null = null;
    claimDb.onCount = () => { snap = snapshot(); };
    await restore();
    expect(snap).toMatchObject({ fence: true, doubt: true });
    expect(snap!.notice).toMatch(PENDING);
  });

  it('XQ3 between a differing count and the lift', async () => {
    claimDb.restoredCounts = DIFFER;
    let snap: ReturnType<typeof snapshot> | null = null;
    claimDb.onRaise = () => { snap = snapshot(); };
    const r = await restore();
    expect(r.success).toBe(false);
    expect(snap).toMatchObject({ fence: true, doubt: true });
    expect(snap!.notice).toMatch(PENDING);
  });
});

describe('NM18 YQ rows: the operator after a difference', () => {
  const differ = async () => {
    claimDb.restoredCounts = DIFFER;
    const r = await restore();
    expect(r.error).toBe(E_COUNTS(CT, r.steps.preRestoreDump!));
    return r;
  };

  it('YQ1 Running is refused with R13', async () => {
    await differ();
    const before = JSON.stringify(registryA().maintenance);
    const admission = await maintenance.orderMaintenance('a', 'running', '', () => {});
    expect(admission).toEqual({ accepted: false, status: 409, error: R13 });
    expect(JSON.stringify(registryA().maintenance)).toBe(before);
  });

  it('YQ2 the pre-restore dump the notice names restores with matched counts and clears the notice', async () => {
    holder.counts = { ...COUNTS_OF.claims };
    const first = await differ();
    const pre = first.steps.preRestoreDump!;
    expect(fs.existsSync(metaPath(pre))).toBe(true);
    claimDb.restoredCounts = null;
    claimDb.dropSeen = false;
    pg.events.length = 0;
    const r = await restore(pre);
    expect(r.success).toBe(true);
    expect(r.steps.counts).toEqual(MATCHED);
    expect(registryA().fleetRestoreError).toBeUndefined();
    expect(pg.events).not.toContain('start:w');
  });

  it('YQ3 Dismiss lets Running past R13', async () => {
    await differ();
    expect(fleetBackup.dismissShownRestoreNotice('a', registryA().fleetRestoreError.at)).toEqual({ dismissed: true });
    const admission = await maintenance.orderMaintenance('a', 'running', '', () => {});
    expect((admission as any).error ?? '').not.toMatch(/has not finished cleanly/);
  });

  it('YQ4 the same restore again after an unread count matches', async () => {
    claimDb.fail = 'counts';
    const first = await restore();
    expect(first.success).toBe(false);
    claimDb.fail = null;
    claimDb.dropSeen = false;
    const r = await restore();
    expect(r.success).toBe(true);
    expect(r.steps.counts).toEqual(MATCHED);
    expect(registryA().fleetRestoreError).toBeUndefined();
  });
});

