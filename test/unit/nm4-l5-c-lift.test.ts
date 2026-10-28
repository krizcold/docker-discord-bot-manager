import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm4-l5c-'));
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
import * as fleetBackupGuards from '../../src/instance/fleetBackupGuards';
import * as maintenance from '../../src/instance/maintenance';
import { fenceOwners } from './fence-fake';
import { claimDb, resetClaimDb, MAINTAINED, OFF } from './restore-fake';

const REGISTRY = path.join(tmp.dir, 'instances.json');
const OPS = path.join(tmp.dir, 'active-ops.json');
const DIR = path.join(tmp.dir, 'backups', 'a', 'fleet-postgres');
const FLOOR = path.join(DIR, 'claim-floor.json');
const primary = { containerName: 'bot-a-postgres', user: 'app', db: 'app', volume: 'bot-a-pgdata' };

function writeRegistry(extraA: Record<string, unknown> = MAINTAINED): void {
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: {
    a: { id: 'a', displayName: 'a', sanitizedName: 'bot-a', status: 'running', sourceUrl: 'https://example.invalid/fake/app', createdAt: '2026-10-01T00:00:00.000Z', fleetDb: primary, fleetBackup: { enabled: false, hour: 4, keep: 7 }, ...extraA },
    w: { id: 'w', displayName: 'w', status: 'running', sourceUrl: 'https://example.invalid/fake/app' },
  } }, null, 2));
}
const registryA = () => JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')).instances.a;
const floorFile = () => (fs.existsSync(FLOOR) ? JSON.parse(fs.readFileSync(FLOOR, 'utf-8')) : null);

beforeEach(() => {
  Object.assign(pg, {
    sidecar: true, sidecarStarts: [], shutdown: false, storeCorrupt: false, seed: null, exists: '1', existsFails: false, fenceFails: false,
    liftFails: false, dropFails: false, dumpCode: 0, restoreCode: 0, saveFails: false, clearFails: false, stopFails: {}, startFails: {},
    stopInOpFails: null, stopInOpNotRunning: false, throwLive: null, throwAt: null, restoreGate: null, at: {}, hooks: [], noticeAtDrop: undefined, floorAtDrop: null, volumeGone: false, showOn: false,
  });
  pg.events.length = 0;
  pg.sql.length = 0;
  pg.urls = { a: 'postgres://app:pw@bot-a-postgres/app', w: 'postgres://app:pw@bot-a-postgres:5432/app?sslmode=no-verify' };
  pg.live = { a: ['bot-a-app'], w: ['bot-w-app'] };
  resetClaimDb({ onRaise: () => pg.events.push('raise') });
  fenceOwners.clear();
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, 'old.dump'), 'dump');
  fleetBackup.clearClaimFloor('a');
  fleetBackup.dismissFleetRestoreError('a');
  writeRegistry();
  fs.mkdirSync(path.join(tmp.dir, 'bots', 'a'), { recursive: true });
});
afterAll(() => { fs.rmSync(tmp.dir, { recursive: true, force: true }); });

const at = (event: string) => pg.events.indexOf(event);
const restore = (file = 'old.dump') => fleetBackup.restoreFleetBackup('a', file);
const dropped = () => pg.events.includes('drop');

beforeEach(() => {
  Object.assign(lc, { lifting: false, hba: null, reloadFails: false, volumeUnknown: false, stripFails: false });
});

const RAN = 'Restore of old.dump ran, but ';
const RETRY = 'running a restore again with the bot in Maintenance or Off retries the lift';

describe('NM4 L5c: the notice a restore leaves for each lift that did not end lifted', () => {
  it('unknown: docker did not answer for the volume', async () => {
    pg.liftFails = true;
    lc.volumeUnknown = true;
    await restore();
    expect(dropped()).toBe(true);
    expect(registryA().fleetRestoreError.text).toBe(`${RAN}the write fence could not be lifted live, and docker did not answer whether the database volume bot-a-pgdata exists, so this manager can't confirm whether the database is still READ-ONLY or refusing the bot's connections; ${RETRY}`);
  });

  it('gone: the volume is gone, and the notice names the restored data', async () => {
    pg.liftFails = true;
    pg.at.drop = () => { pg.volumeGone = true; };
    await restore();
    expect(registryA().fleetRestoreError.text).toBe(`${RAN}the database volume bot-a-pgdata is gone now, so this manager can't confirm that the restored data exists; with the bot in Maintenance or Off, restore a dump again`);
  });

  it('locked: the pg_hba lines could not be removed live or from the volume', async () => {
    lc.hba = 'fail';
    lc.stripFails = true;
    await restore();
    expect(registryA().fleetRestoreError.text).toBe(`${RAN}the pg_hba lines of the write fence could not be removed: the database refuses every connection but the manager's, so the bot cannot reach it, a restart does not clear it, and ${RETRY}`);
  });

  it('unreloaded: the read-only layer stays and the reload failed', async () => {
    pg.liftFails = true;
    lc.reloadFails = true;
    lc.stripFails = true;
    await restore();
    expect(registryA().fleetRestoreError.text).toBe(`${RAN}the write fence could not be lifted or stripped: the database stays READ-ONLY, a restart does not clear it, and ${RETRY}; it may also refuse the bot's connections until it reloads or restarts`);
  });

  it('held: another lane owns the pg_hba lines', async () => {
    lc.hba = 'held';
    await restore();
    expect(registryA().fleetRestoreError.text).toBe(`${RAN}the database refuses every connection but the manager's, so the bot cannot reach it: the pg_hba lines of the write fence belong to a re-seed (started 2023-11-14 22:13 UTC), so the restore left them on; running that lane again lifts it; once the fence is lifted, dismiss this notice`);
  });
});

describe('NM4 L5c: a seeded restore fence behind a standby seed', () => {
  it('names the seed step before the restore retry', async () => {
    pg.seed = { parked: false };
    pg.showOn = true;
    fenceOwners.set('bot-a-postgres', 'restore:1700000000000');
    vi.resetModules();
    const fb = await import('../../src/instance/fleetBackup');
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation((() => 0) as unknown as typeof setInterval);
    fb.startFleetBackupScheduler();
    spy.mockRestore();
    fb.stopFleetBackupScheduler();
    await vi.waitFor(() => expect(fb.getFleetFenceStuck('a')).not.toBeNull());
    expect(fb.getFleetFenceStuck('a')).toBe("The database is READ-ONLY (a write fence was not lifted); whether a restart clears it could not be confirmed (its saved configuration could not be read); it belongs to a restore (started 2023-11-14 22:13 UTC), and wait for the standby seed to finish, then run a restore again with the bot in Maintenance or Off to retry the lift");
  });
});

describe('NM4 L5c: the claim parsers', () => {
  it('parseClaimTables strips only a trailing newline', () => {
    expect(fleetBackup.parseClaimTables('t|t\n|t')).toBeNull();
  });

  it('claimRaiseSql names the floor with no next whole number', () => {
    expect(fleetBackup.claimRaiseSql(2 ** 53 - 1, { seq: true, table: true, claim: true })).toEqual({ error: 'the claim floor 9007199254740991 has no next whole number' });
  });

  const raise: Array<[string, number, unknown]> = [
    ['seq|8 \nguild|g1\n', 7, { ok: true, seq: 8, guilds: ['g1'] }],
    ['seq|8\nseq|9\n', 7, { ok: false, error: 'the raise answered two sequence values' }],
    ['seq|9007199254740993\n', 7, { ok: false, error: "the raise answered 'seq|9007199254740993'" }],
    ['seq|x\n', 7, { ok: false, error: "the raise answered 'seq|x'" }],
    ['seq|\t8\n', 7, { ok: false, error: "the raise answered 'seq|\t8'" }],
    ['seq|0x10\n', 7, { ok: false, error: "the raise answered 'seq|0x10'" }],
    ['seq|8\nfoo1234\n', 7, { ok: false, error: "the raise answered 'foo1234'" }],
    ['seq|8\nguild|\n', 7, { ok: false, error: "the raise answered 'guild|'" }],
    ['guild|g1\n', 7, { ok: false, error: 'the raise answered no sequence value' }],
    ['seq|7\n', 7, { ok: false, error: 'the sequence answered 7, which is not above 7' }],
  ];
  it.each(raise)('parseClaimRaise %j floor %d', (stdout, floor, want) => {
    expect(fleetBackup.parseClaimRaise(stdout, floor)).toEqual(want);
  });

  const toc: Array<[string, unknown]> = [
    ['x1; 2 3 TABLE public t app\n', null],
    ['12; 2 3 TABLE public t app\n', 'none'],
    ['5; 1 2 SCHEMA - public app\nx1; 2 3 SEQUENCE smdb_data claim_seq app\n', 'none'],
    ['5; 1 2 SCHEMA - public app\nx1; 2 3 TABLE smdb_data guild_ownership app\n', 'none'],
  ];
  it.each(toc)('dumpClaimShape %j', (text, want) => {
    expect(fleetBackup.dumpClaimShape(text)).toBe(want);
  });

  it('probeClaims answers the failed read with its error', async () => {
    resetClaimDb({ fail: 'tables' });
    expect(await fleetBackup.probeClaims(primary)).toEqual({ ok: false, error: 'ERROR:  connection reset by peer' });
  });

  it('probeClaims quotes a probe answer it cannot read, trimmed', async () => {
    resetClaimDb({ tables: 'bad' });
    expect(await fleetBackup.probeClaims(primary)).toEqual({ ok: false, error: "the claim probe answered 'bad'" });
  });
});
