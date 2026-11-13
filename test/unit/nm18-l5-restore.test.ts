import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm18-l5-restore-'));
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
import { claimDb, resetClaimDb, writeDumpMeta, COUNTS_OF, TOC, MAINTAINED, OFF } from './restore-fake';

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

const addSharer = (id: string) => {
  const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf-8'));
  reg.instances[id] = { id, displayName: id, status: 'running', sourceUrl: 'https://example.invalid/fake/app' };
  fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2));
  pg.urls[id] = pg.urls.w;
  pg.live[id] = [`bot-${id}-app`];
};

describe('NM18 L5: the texts after a restore', () => {
  it('L1 a matched restore logs no count error', async () => {
    const r = await restore();
    expect(r.success).toBe(true);
    expect(logs.error.filter(l => l.startsWith('[FleetBackup] Restore of old.dump on'))).toEqual([]);
  });

  it('L2 two containers started meanwhile are named apart', async () => {
    claimDb.restoredCounts = DIFFER;
    claimDb.onRaise = () => { pg.events.push('raise'); pg.live.w = ['bot-w-app', 'bot-w-two']; };
    const r = await restore();
    expect(r.error).toContain('but bot-w-app, bot-w-two was started outside the manager during the restore');
  });

  it('L3 in Off the bot itself is not listed among the instances that stay stopped', async () => {
    writeRegistry(OFF);
    claimDb.restoredCounts = DIFFER;
    const r = await restore();
    const p = r.steps.preRestoreDump!;
    expect(r.steps.stopped).toContain('a');
    expect(r.error).toBe(E_COUNTS(CT, p).replace('The bot stays in maintenance', 'The bot stays off'));
    expect(registryA().fleetRestoreError.text).toBe(N_COUNTS(CT, p));
  });

  it('L4 no database before the restore: the texts say no pre-restore dump was taken', async () => {
    pg.exists = '0';
    claimDb.restoredCounts = DIFFER;
    const r = await restore();
    expect(r.steps.preRestoreDump).toBeNull();
    const back = 'no pre-restore dump was taken, because the database was missing';
    expect(r.error).toBe(E_COUNTS(CT, 'x').replace(BACK('x'), back));
    expect(registryA().fleetRestoreError.text).toBe(N_COUNTS(CT, 'x').replace(BACK('x'), back));
  });

  it('L5 no other instance stopped: no stay-stopped clause', async () => {
    pg.live.w = [];
    claimDb.restoredCounts = DIFFER;
    const r = await restore();
    const p = r.steps.preRestoreDump!;
    expect(r.steps.stopped).toEqual([]);
    expect(r.error).toBe(E_COUNTS(CT, p).replace(STOPPED, ''));
    expect(registryA().fleetRestoreError.text).toBe(N_COUNTS(CT, p).replace(', and the other instances stopped for the restore stay stopped (w)', ''));
  });

  it('L6 two other instances stopped are named apart', async () => {
    addSharer('v');
    claimDb.restoredCounts = DIFFER;
    const r = await restore();
    const p = r.steps.preRestoreDump!;
    const names = r.steps.stopped.filter((id: string) => id !== 'a').join(', ');
    expect(names).toMatch(/^[vw], [vw]$/);
    expect(r.error).toBe(E_COUNTS(CT, p).replace('stay stopped (w)', `stay stopped (${names})`));
    expect(registryA().fleetRestoreError.text).toBe(N_COUNTS(CT, p).replace('stay stopped (w)', `stay stopped (${names})`));
  });

  it('L7 exactly five gaps name all five and no more', async () => {
    const five = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`smdb_data.x${i + 1}`, 0]));
    writeDumpMeta(DIR, 'old.dump', { ...COUNTS_OF.claims, ...five });
    const r = await restore();
    atToc(r, `5 table(s) do not fit its table of contents: ${[1, 2, 3, 4, 5].map(i => `smdb_data.x${i}: no table in the dump`).join('; ')}`);
  });
});
