import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm4-l5-b-'));
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
  return { ...real, execFile: fencedExecFile, exec, spawn: heldSpawn, default: { ...real, execFile: fencedExecFile, exec, spawn: heldSpawn } };
});


const fsHook = vi.hoisted(() => ({
  readThrow: undefined as { v: unknown } | undefined,
  rmThrow: undefined as { v: unknown } | undefined,
  writes: [] as Array<{ file: string; opts: unknown }>,
}));

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const isFloor = (p: unknown) => String(p).endsWith('claim-floor.json');
  const readFileSync = ((p: any, ...rest: any[]) => {
    if (fsHook.readThrow && isFloor(p)) throw fsHook.readThrow.v;
    return (real.readFileSync as any)(p, ...rest);
  }) as typeof real.readFileSync;
  const rmSync = ((p: any, ...rest: any[]) => {
    if (fsHook.rmThrow && isFloor(p)) throw fsHook.rmThrow.v;
    return (real.rmSync as any)(p, ...rest);
  }) as typeof real.rmSync;
  const writeFileSync = ((p: any, data: any, opts?: any) => {
    if (String(p).endsWith('claim-floor.json.tmp')) fsHook.writes.push({ file: String(p), opts });
    return real.writeFileSync(p, data, opts);
  }) as typeof real.writeFileSync;
  const over = { readFileSync, rmSync, writeFileSync };
  return { ...real, ...over, default: { ...real, ...over } };
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
const PENDING = /^Restore of old\.dump has not finished: if it is no longer running \(the manager restarted\), the database may be missing or hold a partial restore, and its write fence may still be on; restore a dump again before choosing Running \(/;
const FIRST_NOTICE = 'Restore of old.dump has not finished: if it is no longer running (the manager restarted), the database may be missing or hold a partial restore, and its write fence may still be on; restore a dump again before choosing Running';
const R13_FENCE = /^The bot's database is READ-ONLY under a write fence of a restore \(started \d{4}-\d\d-\d\d \d\d:\d\d UTC\), so Running was refused and nothing was changed; with the bot in Maintenance or Off, run a restore again to lift the fence$/;
const NEWER = 'A newer restore notice replaced the one shown, so it was kept; read it, then dismiss it again';
import { PRIVATE_FILE_MODE } from '../../src/config/fileModes';

afterEach(() => {
  fsHook.readThrow = undefined;
  fsHook.rmThrow = undefined;
  fsHook.writes.length = 0;
  vi.restoreAllMocks();
});

const errorLines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(c => String(c[0]));

describe('L5b the restore notice', () => {
  it('Dismiss names the operation that holds the bot', async () => {
    writeRegistry({ ...MAINTAINED, fleetRestoreError: { file: 'old.dump', text: 'x', at: '2026-10-27T10:00:00.000Z', doubt: true } });
    let release: () => void = () => {};
    const held = containerManager.withExternalBotOp('a', 'update', () => new Promise<void>(r => { release = r; }));
    const out = fleetBackup.dismissShownRestoreNotice('a', '2026-10-27T10:00:00.000Z');
    release();
    await held;
    expect(out).toEqual({ dismissed: false, error: "Operation 'update' is running on this bot; dismiss the restore notice when it ends" });
    expect(registryA().fleetRestoreError.text).toBe('x');
  });

  it('Dismiss with no notice standing answers not dismissed', () => {
    expect(fleetBackup.dismissShownRestoreNotice('a', '2026-10-27T10:00:00.000Z')).toEqual({ dismissed: false });
  });

  it('forgetRestoreNotice drops the notice held in memory', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    pg.at.pg_restore = () => { pg.saveFails = true; };
    pg.restoreCode = 1;
    await restore();
    pg.saveFails = false;
    expect(fleetBackup.getFleetRestoreError('a')).toMatch(/ \(this notice is not saved and a manager restart drops it\)$/);
    expect(errorLines(err)).toContain('[FleetBackup] Could not save the restore notice for a: ENOSPC: no space left on device');
    fleetBackup.forgetRestoreNotice('a');
    expect(fleetBackup.getFleetRestoreError('a')).toBe(registryA().fleetRestoreError.text);
    expect(fleetBackup.getFleetRestoreError('a')).not.toMatch(/is not saved/);
  });

  it('a saved notice is not logged or marked unsaved', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    pg.restoreCode = 1;
    await restore();
    expect(registryA().fleetRestoreError.text).toMatch(/^Restore of old\.dump failed: /);
    expect(fleetBackup.getFleetRestoreError('a')).toBe(registryA().fleetRestoreError.text);
    expect(errorLines(err).filter(l => l.includes('Could not save the restore notice'))).toEqual([]);
  });
});

describe('L5b the claim floor', () => {
  it('a file holding null is an error, not a crash', () => {
    fs.writeFileSync(FLOOR, 'null');
    expect(fleetBackup.readClaimFloor('a')).toEqual({ ok: false, error: 'it holds no whole-number claim' });
  });

  it('a read error that is not an Error object is named as text', () => {
    fsHook.readThrow = { v: null };
    expect(fleetBackup.readClaimFloor('a')).toEqual({ ok: false, error: 'null' });
  });

  it('a read error is named by its message', () => {
    fsHook.readThrow = { v: new Error('EIO: i/o error') };
    expect(fleetBackup.readClaimFloor('a')).toEqual({ ok: false, error: 'EIO: i/o error' });
  });

  it('a disk floor above the held one wins', () => {
    expect(fleetBackup.writeClaimFloor('a', 5)).toBeNull();
    fs.writeFileSync(FLOOR, JSON.stringify({ claim: 9 }));
    expect(fleetBackup.readClaimFloor('a')).toEqual({ ok: true, claim: 9, disk: 9 });
  });

  it('a lower write keeps the higher held floor', () => {
    expect(fleetBackup.writeClaimFloor('a', 9)).toBeNull();
    expect(fleetBackup.writeClaimFloor('a', 3)).toBeNull();
    fs.rmSync(FLOOR);
    expect(fleetBackup.readClaimFloor('a')).toEqual({ ok: true, claim: 9, disk: null });
  });

  it('a higher write raises the held floor', () => {
    expect(fleetBackup.writeClaimFloor('a', 3)).toBeNull();
    expect(fleetBackup.writeClaimFloor('a', 9)).toBeNull();
    fs.rmSync(FLOOR);
    expect(fleetBackup.readClaimFloor('a')).toEqual({ ok: true, claim: 9, disk: null });
  });

  it('a write equal to the disk floor does not rewrite it', () => {
    fs.writeFileSync(FLOOR, JSON.stringify({ claim: 4 }));
    fs.mkdirSync(`${FLOOR}.tmp`);
    expect(fleetBackup.writeClaimFloor('a', 4)).toBeNull();
    fs.rmSync(`${FLOOR}.tmp`, { recursive: true, force: true });
  });

  it('the floor file is written private, and a failed write is logged with its error', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(fleetBackup.writeClaimFloor('a', 6)).toBeNull();
    expect(fsHook.writes).toEqual([{ file: `${FLOOR}.tmp`, opts: { mode: PRIVATE_FILE_MODE } }]);
    fs.mkdirSync(`${FLOOR}.tmp`);
    const text = fleetBackup.writeClaimFloor('a', 7);
    fs.rmSync(`${FLOOR}.tmp`, { recursive: true, force: true });
    expect(typeof text).toBe('string');
    expect(errorLines(err)).toEqual([`[FleetBackup] Could not keep the claim floor for a on disk: ${text}`]);
  });

  it('clearing a floor that has no file logs nothing', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    fleetBackup.clearClaimFloor('a');
    expect(fs.existsSync(FLOOR)).toBe(false);
    expect(errorLines(err)).toEqual([]);
  });

  it('a failed clear is logged with its message', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    fsHook.rmThrow = { v: new Error('EACCES: permission denied') };
    fleetBackup.clearClaimFloor('a');
    expect(errorLines(err)).toEqual(['[FleetBackup] Could not clear the claim floor for a: EACCES: permission denied']);
  });

  it('a failed clear whose error is not an Error object is logged as text', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    fsHook.rmThrow = { v: null };
    fleetBackup.clearClaimFloor('a');
    expect(errorLines(err)).toEqual(['[FleetBackup] Could not clear the claim floor for a: null']);
  });
});
