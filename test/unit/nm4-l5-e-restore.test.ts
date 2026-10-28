import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm4-l5-e-'));
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

const ex = vi.hoisted(() => ({
  settingsFail: false,
  heldAtFence: false,
  hbaLiftFails: false,
  reloadFails: false,
  stripFail: false,
  strips: [] as boolean[],
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
  const outer = (cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (err: Error | null, stdout: string, stderr: string) => void;
    const sql = args.join(' ');
    if (ex.settingsFail && sql.includes("current_setting('hba_file') ||")) return cb(new Error('exit 2'), '', 'psql: error: connection refused');
    if (ex.heldAtFence && sql.includes('ALTER SYSTEM SET default_transaction_read_only = on')) {
      ((globalThis as any).__fenceOwners as Map<string, string>).set('bot-a-postgres', 'reseed:1793181600000');
      pg.showOn = true;
    }
    if (ex.hbaLiftFails && args[0] === 'exec' && args[1] === '-u' && sql.includes('smdb-write-fence') && !sql.includes('printf') && !sql.includes('grep -qx')) return cb(new Error('exit 1'), '', 'sh: pg_hba.conf: Read-only file system');
    if (args[0] === 'run') {
      const ok = ex.strips.length > 0 ? ex.strips.shift()! : !ex.stripFail;
      if (!ok) return cb(new Error('exit 125'), '', 'docker: Error response from daemon: volume is in use');
    }
    if (ex.reloadFails && sql.endsWith('SELECT pg_reload_conf()') && !sql.includes('ALTER SYSTEM')) return cb(new Error('exit 2'), '', 'ERROR:  could not reload');
    return (fencedExecFile as any)(cmd, args, optsOrCb, maybeCb);
  };
  return { ...real, execFile: outer, exec, spawn: heldSpawn, default: { ...real, execFile: outer, exec, spawn: heldSpawn } };
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

const RELOADS_ON_SUCCESS = 2;
const FENCE_E = 'Could not fence the database for the restore: ERROR:  could not write auto.conf';
const RETRY = 'running a restore again with the bot in Maintenance or Off retries the lift';
const RESEED = 'the read-only layer of the write fence belongs to a re-seed (started 2026-10-28 10:00 UTC)';
const STARTING = 'ERROR:  the database system is starting up';
const UNSTARTED = '; these instances were stopped and could not be restarted: w (start them by hand)';
const PRIOR_E = { file: 'older.dump', text: 'Restore of older.dump failed: pg_restore exited with code 1', at: '2026-10-27T10:00:00.000Z', doubt: true };

describe('NM4 L5 e: the restore lane past the admission', () => {
  let errors: { mock: { calls: unknown[][] }; mockRestore: () => void };
  let logs: { mock: { calls: unknown[][] }; mockRestore: () => void };
  beforeEach(() => {
    Object.assign(ex, { settingsFail: false, heldAtFence: false, hbaLiftFails: false, reloadFails: false, stripFail: false, strips: [] });
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    logs = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { errors.mockRestore(); logs.mockRestore(); });
  const errorLines = () => errors.mock.calls.map((c: unknown[]) => String(c[0]));

  it('a fence that changed nothing refuses, puts back the notice and says nothing was restored', async () => {
    ex.settingsFail = true;
    const r = await restore();
    expect(r.success).toBe(false);
    expect(r.error).toBe("Could not fence the database for the restore: the database's settings could not be read before the fence (psql: error: connection refused)");
    expect(r.steps.restored).toBe(false);
    expect(r.steps.restarted).toEqual(['w']);
    expect(registryA().fleetRestoreError).toBeUndefined();
  });

  it('a sharer that holds an op refuses with success false', async () => {
    let release: () => void = () => {};
    const held = containerManager.withExternalBotOp('w', 'update', () => new Promise<void>(r => { release = r; }));
    const r = await restore();
    release();
    await held;
    expect(r.success).toBe(false);
    expect(r.error).toBe("Operation 'update' is running on w, which shares this database; wait for it before restoring a dump (nothing was changed)");
  });

  it('a half-applied fence whose lift finds a layer held by another lane names the holder', async () => {
    pg.fenceFails = true;
    ex.heldAtFence = true;
    const r = await restore();
    expect(r.error).toBe(`${FENCE_E}; the database is READ-ONLY: ${RESEED}, so the restore left it on; running that lane again lifts it`);
    expect(fleetBackup.getFleetFenceStuck('a')).toBe(`The database is READ-ONLY: ${RESEED}, so a restore left it on; running that lane again lifts it`);
  });

  it('a half-applied fence whose pg_hba lines stay names the refused connections', async () => {
    pg.fenceFails = true;
    ex.hbaLiftFails = true;
    ex.stripFail = true;
    const r = await restore();
    expect(r.error).toBe(`${FENCE_E}; the database may refuse every connection but the manager's, so the bot cannot reach it (pg_hba lines that could not be removed survive a restart; ${RETRY})`);
  });

  it('a half-applied fence whose lift and reload fail names both', async () => {
    pg.fenceFails = true;
    pg.liftFails = true;
    ex.reloadFails = true;
    ex.stripFail = true;
    const r = await restore();
    expect(r.error).toBe(`${FENCE_E}; the database may stay READ-ONLY (a fence that could not be lifted or stripped survives a restart; ${RETRY}), and it may refuse the bot's connections until it reloads or restarts`);
  });

  it('a half-applied fence whose lift and strip fail says it may stay read-only, and the retry names a restore', async () => {
    pg.fenceFails = true;
    pg.liftFails = true;
    ex.stripFail = true;
    const r = await restore();
    expect(r.error).toBe(`${FENCE_E}; the database may stay READ-ONLY (a fence that could not be lifted or stripped survives a restart; ${RETRY})`);
    expect(fleetBackup.getFleetFenceStuck('a')).toBe(`The database is READ-ONLY (a restore write fence could not be lifted or stripped); ${RETRY}`);
  });

  it('a strip that landed and a retry that failed keep the stripped warning', async () => {
    pg.fenceFails = true;
    pg.liftFails = true;
    ex.strips = [true, false];
    const r = await restore();
    expect(r.error).toBe(`${FENCE_E}; the database may be READ-ONLY, and may still refuse the bot's connections, until its container restarts`);
    expect(fleetBackup.getFleetFenceStuck('a')).toBe("The database is READ-ONLY, and may still refuse the bot's connections, until it restarts (a restore write fence could not be lifted live); restart the instance to clear it");
  });

  it('a refusal past the fence whose lift is held names the holder in the reply', async () => {
    pg.existsFails = true;
    pg.at.fence = () => { fenceOwners.set('bot-a-postgres', 'reseed:1793181600000'); pg.showOn = true; };
    const r = await restore();
    expect(r.error).toBe(`Could not check the database before the restore, so the restore was refused, and nothing was changed: ${STARTING}; the database is READ-ONLY: ${RESEED}, so the restore left it on; running that lane again lifts it`);
  });

  it('a refusal past the fence whose lift was stripped keeps "nothing was changed" and no notice text', async () => {
    pg.existsFails = true;
    pg.liftFails = true;
    const r = await restore();
    expect(r.error).toBe(`Could not check the database before the restore, so the restore was refused, and nothing was changed: ${STARTING}; the write fence could not be lifted live, so the database is READ-ONLY, and may still refuse the bot's connections, until its container restarts`);
  });

  it('a refusal past the fence with a sharer that does not start drops "nothing was changed"', async () => {
    pg.existsFails = true;
    pg.startFails.w = 'no such image';
    const r = await restore();
    expect(r.error).toBe(`Could not check the database before the restore, so the restore was refused: ${STARTING}${UNSTARTED}`);
  });

  it('a refusal before the fence with a sharer that does not start drops "nothing was changed"', async () => {
    pg.saveFails = true;
    pg.startFails.w = 'no such image';
    const r = await restore();
    expect(r.error).toBe(`The restore could not be recorded before the database was fenced, so the restore was refused: ENOSPC: no space left on device${UNSTARTED}`);
  });

  it('a refusal before the drop whose lift finds the volume gone writes the gone notice', async () => {
    pg.existsFails = true;
    pg.liftFails = true;
    pg.volumeGone = true;
    await restore();
    expect(registryA().fleetRestoreError.text).toBe("Restore of old.dump was refused before the database was dropped, but the database volume bot-a-pgdata is gone now, so this manager can't confirm that the data exists; with the bot in Maintenance or Off, restore a dump again");
  });

  it('a merged notice for a volume gone before the drop does not call the data restored', async () => {
    writeRegistry({ ...MAINTAINED, fleetRestoreError: PRIOR_E });
    pg.existsFails = true;
    pg.liftFails = true;
    pg.volumeGone = true;
    await restore();
    expect(registryA().fleetRestoreError.text).toBe(`${PRIOR_E.text}. Then a restore of old.dump was refused before the database was dropped, but the database volume bot-a-pgdata is gone now, so this manager can't confirm that the data exists; with the bot in Maintenance or Off, restore a dump again`);
  });

  it('a failed put-back logs it', async () => {
    writeRegistry({ ...MAINTAINED, fleetRestoreError: PRIOR_E });
    pg.existsFails = true;
    pg.at.notice = () => { pg.saveFails = true; };
    await restore();
    expect(errorLines()).toContain('[FleetBackup] Could not put back the restore notice for a: Error: ENOSPC: no space left on device');
  });

  it('a failed put-back of an earlier unsaved notice keeps one unsaved mark', async () => {
    pg.at.pg_restore = () => { pg.saveFails = true; };
    pg.restoreCode = 1;
    await restore();
    const earlier = fleetBackup.getFleetRestoreError('a')!;
    expect(earlier.endsWith(' (this notice is not saved and a manager restart drops it)')).toBe(true);
    pg.at = {};
    pg.saveFails = false;
    pg.restoreCode = 0;
    pg.existsFails = true;
    pg.at.notice = () => { pg.saveFails = true; };
    await restore();
    pg.saveFails = false;
    expect(fleetBackup.getFleetRestoreError('a')).toBe(earlier);
  });

  it('two other instances kept stopped are named apart', async () => {
    fs.writeFileSync(REGISTRY, JSON.stringify({ instances: {
      ...JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')).instances,
      x: { id: 'x', displayName: 'x', status: 'running', sourceUrl: 'https://example.invalid/fake/app' },
    } }, null, 2));
    pg.urls.x = pg.urls.w;
    pg.live.x = ['bot-x-app'];
    pg.restoreCode = 1;
    const r = await restore();
    expect(r.error).toMatch(/, the bot stays in maintenance, and the other stopped instances stay stopped \(w, x\), so nothing writes to /);
  });

  it('the first notice and its rewrite leave the data in doubt', async () => {
    let atFence: any = null;
    pg.at.fence = () => { atFence = registryA().fleetRestoreError; };
    const r = await restore();
    expect(r.success).toBe(true);
    expect(atFence.doubt).toBe(true);
    expect((pg.noticeAtDrop as any).doubt).toBe(true);
  });

  it('the live claim above the file floor raises the floor', async () => {
    fs.writeFileSync(FLOOR, '{"claim":4}');
    const r = await restore();
    expect(r.success).toBe(true);
    expect(r.steps.claimFloor).toBe(7);
    expect(claimDb.raiseSql[0]).toContain('WHERE claim <= 7');
  });

  it('a success logs the raise and no rewrite failure; one lift ran', async () => {
    const r = await restore();
    expect(r.success).toBe(true);
    expect(logs.mock.calls.map((c: unknown[]) => String(c[0]))).toContain('[FleetBackup] Raised the claim numbers on bot-a-postgres above 7: 2 guild(s) to 8, claim_seq to 8');
    expect(errorLines().filter((l: string) => l.includes('safety dump'))).toEqual([]);
    expect(pg.sql.filter(s => s.endsWith('SELECT pg_reload_conf()') && !s.includes('ALTER SYSTEM')).length).toBe(RELOADS_ON_SUCCESS);
  });

  it('a failed rewrite logs it', async () => {
    pg.at.dump = () => { pg.saveFails = true; };
    await restore();
    expect(errorLines()).toContain("[FleetBackup] Could not add the safety dump's name to the restore notice for a: ENOSPC: no space left on device");
  });

  it('the sharers are released before the notice clear', async () => {
    let refusal: unknown = 'unread';
    pg.at.clear = () => { refusal = containerManager.databaseHoldRefusal('w', 'Start'); };
    expect((await restore()).success).toBe(true);
    expect(refusal).toBeNull();
  });

  it('a failed notice clear logs it', async () => {
    pg.clearFails = true;
    await restore();
    expect(errorLines()).toContain('[FleetBackup] Could not clear the restore notice for a: Error: EACCES: permission denied');
  });

  it('a stripped lift after the restore keeps a notice that leaves no doubt', async () => {
    pg.liftFails = true;
    await restore();
    expect(registryA().fleetRestoreError.doubt).toBe(false);
  });

  it('a lift that finds the volume gone after the restore says the restore ran', async () => {
    pg.liftFails = true;
    pg.at.pg_restore = () => { pg.volumeGone = true; };
    const r = await restore();
    expect(r.error).toBe("The restore ran, but the database volume bot-a-pgdata is gone now, so this manager can't confirm that the restored data exists (see manager logs)");
    expect(registryA().fleetRestoreError.text).toBe("Restore of old.dump ran, but the database volume bot-a-pgdata is gone now, so this manager can't confirm that the restored data exists; with the bot in Maintenance or Off, restore a dump again");
  });

  it('a throw before the drop lifts the fence and puts back the notice that stood before', async () => {
    pg.at.dump = () => { pg.throwLive = 'w'; };
    await expect(restore()).rejects.toThrow(/docker ps crashed for w/);
    expect(registryA().fleetRestoreError).toBeUndefined();
  });

  it('a throw whose leftover lift fails names a restore in the warning', async () => {
    pg.liftFails = true;
    ex.stripFail = true;
    pg.at.dump = () => { pg.throwLive = 'w'; };
    await expect(restore()).rejects.toThrow(/docker ps crashed for w/);
    expect(fleetBackup.getFleetFenceStuck('a')).toBe(`The database is READ-ONLY (a restore write fence could not be lifted or stripped); ${RETRY}`);
  });

  it('an op on the bot itself refuses with success false', async () => {
    let release: () => void = () => {};
    const held = containerManager.withExternalBotOp('a', 'start', () => new Promise<void>(r => { release = r; }));
    const r = await restore();
    release();
    await held;
    expect(r.success).toBe(false);
  });

  it('a refusal before the first notice writes no notice', async () => {
    claimDb.fail = 'toc';
    pg.clearFails = true;
    const r = await restore();
    expect(r.success).toBe(false);
    expect(errorLines().filter((l: string) => l.includes('restore notice'))).toEqual([]);
  });

  it('a merge onto an earlier notice that ends in a period keeps one period', async () => {
    writeRegistry({ ...MAINTAINED, fleetRestoreError: { ...PRIOR_E, text: `${PRIOR_E.text}.` } });
    pg.existsFails = true;
    pg.liftFails = true;
    await restore();
    expect(registryA().fleetRestoreError.text.startsWith(`${PRIOR_E.text}. Then a restore of old.dump was refused before the database was dropped, but `)).toBe(true);
  });

  it('a merge onto an earlier unsaved notice drops its unsaved mark', async () => {
    pg.at.pg_restore = () => { pg.saveFails = true; };
    pg.restoreCode = 1;
    await restore();
    const earlier = fleetBackup.getFleetRestoreError('a')!.replace(' (this notice is not saved and a manager restart drops it)', '');
    pg.at = {};
    pg.saveFails = false;
    pg.restoreCode = 0;
    pg.existsFails = true;
    pg.liftFails = true;
    await restore();
    expect(registryA().fleetRestoreError.text).toBe(`${earlier.replace(/\.$/, '')}. Then a restore of old.dump was refused before the database was dropped, but the write fence could not be lifted live: the database is READ-ONLY, and may still refuse the bot's connections, until its container restarts; restart the instance, then restore a dump again`);
  });
});
