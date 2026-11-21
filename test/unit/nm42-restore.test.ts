import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm42-restore-'));
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
  stripFails: false,
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
  switchWriteFails: null as string | null,
  sidecarOpts: [] as unknown[],
  saveFailsWhen: null as null | ((text: string) => boolean),
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
    startFleetDbSidecar: async (_id: string, opts?: unknown) => {
      pg.sidecarOpts.push(opts ?? null);
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
    updateInstanceFleetDbSwitch: (botId: string, patch: any) => {
      (globalThis as any).__claimDb?.genEvents.push(`switch:${Object.keys(patch).join(",")}`);
      if (pg.switchWriteFails) throw new Error(pg.switchWriteFails);
      return real.updateInstanceFleetDbSwitch(botId, patch);
    },
    updateInstanceFleetRestoreError: (botId: string, notice: { file: string; text: string } | null) => {
      if (notice === null) pg.at.clear?.();
      if (notice && (pg.saveFails || pg.saveFailsWhen?.(notice.text))) throw new Error('ENOSPC: no space left on device');
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
    if (args[0] === 'run' && pg.stripFails) return cb(new Error('exit 1'), '', 'sed: /pgdata/postgresql.auto.conf: Read-only file system');
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

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as fleetBackup from '../../src/instance/fleetBackup';
import * as fleetBackupGuards from '../../src/instance/fleetBackupGuards';
import * as maintenance from '../../src/instance/maintenance';
import * as fleetSwitch from '../../src/instance/fleetSwitch';
import { fenceOwners } from './fence-fake';
import { claimDb, resetClaimDb, MAINTAINED, OFF, writeDumpMeta } from './restore-fake';

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
    liftFails: false, stripFails: false, dropFails: false, dumpCode: 0, restoreCode: 0, saveFails: false, clearFails: false, stopFails: {}, startFails: {},
    stopInOpFails: null, stopInOpNotRunning: false, throwLive: null, throwAt: null, restoreGate: null, at: {}, hooks: [], noticeAtDrop: undefined, floorAtDrop: null, volumeGone: false, showOn: false, switchWriteFails: null, sidecarOpts: [], saveFailsWhen: null,
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
  writeDumpMeta(DIR, 'old.dump');
  fleetBackup.clearClaimFloor('a');
  fleetBackup.dismissFleetRestoreError('a');
  writeRegistry();
  fs.mkdirSync(path.join(tmp.dir, 'bots', 'a'), { recursive: true });
});
afterAll(() => { fs.rmSync(tmp.dir, { recursive: true, force: true }); });

const at = (event: string) => pg.events.indexOf(event);
const restore = (file = 'old.dump') => fleetBackup.restoreFleetBackup('a', file);

const LIVE = { generation: 5, machine: 'old.example', since: '2026-10-20T10:00:00Z' };
const lane = (file = 'old.dump') => containerManager.withExternalBotOp('a', 'run-again', () => fleetBackup.restoreUnderLane('a', file, 'run-again'));
const HANDOVER = { mode: 'stream', slot: 'slot_c', machine: 'slot_c', generation: 4, phase: 'stopped', at: '2026-10-29T09:00:00.000Z' };
const PUSH_BROKEN = { at: '2026-10-30T09:00:00.000Z', safetyDump: 'old.dump', copies: [] };
const broken = (over: Record<string, unknown> = MAINTAINED, db: Record<string, unknown> = {}) => writeRegistry({ ...over, fleetDb: { ...primary, handover: HANDOVER, pushBroken: PUSH_BROKEN, ...db } });
const DIFFER = { 'smdb_data.guild_ownership': 5, 'smdb_data.meta': 1 };

describe('NM42 R1, R2: the lane restore runs under the caller\'s op and slot', () => {
  it('R1: under run-again with the slot claimed, bot Off and live: the stop runs under that op, the start passes the hand-over refusal, the slot stays claimed', async () => {
    writeRegistry(OFF);
    claimDb.generation = LIVE;
    expect(fleetBackupGuards.claimFleetBackupBusy('a')).toBe(true);
    const r = await lane();
    expect(r.success).toBe(true);
    expect(pg.events).toContain('stopInOp:a');
    expect(pg.sidecarOpts.length).toBeGreaterThan(0);
    expect(pg.sidecarOpts.every(o => (o as any)?.handedOver === true)).toBe(true);
    expect(r.steps.preRestoreDump).toMatch(/^pre-restore-.*\.dump$/);
    expect(fleetBackupGuards.isFleetBackupBusy('a')).toBe(true);
    fleetBackupGuards.releaseFleetBackupBusy('a');
  });

  it('R2: the plain restore with the slot claimed is refused as before', async () => {
    expect(fleetBackupGuards.claimFleetBackupBusy('a')).toBe(true);
    const r = await restore();
    expect(r).toMatchObject({ success: false, error: 'A backup operation is already in progress' });
    fleetBackupGuards.releaseFleetBackupBusy('a');
  });
});

describe('NM42 R3, R5: a doubtful lane restore clears pushBroken only after its notice is saved', () => {
  it('R3: counts differ, the fence lifted: the notice is saved first, then pushBroken is cleared; the texts name the button', async () => {
    broken();
    claimDb.generation = LIVE;
    claimDb.restoredCounts = DIFFER;
    pg.at.notice = () => claimDb.genEvents.push('notice');
    const r = await lane();
    expect(r.success).toBe(false);
    expect(r.steps.counts?.result).toBe('differ');
    const ev = claimDb.genEvents;
    expect(ev).toContain('switch:pushBroken');
    expect(ev.lastIndexOf('notice')).toBeLessThan(ev.indexOf('switch:pushBroken'));
    expect(registryA().fleetDb.pushBroken).toBeUndefined();
    fleetBackup.forgetRestoreNotice('a');
    const text = fleetBackup.getFleetRestoreError('a') as string;
    expect(text).toMatch(CLEARED_NOTICE);
    expect(text).not.toContain('restore a dump again');
    expect(r.error).toMatch(/^The dump old\.dump was restored, but .*\. The bot stays in maintenance, and Running and Run the main here again are refused while the notice on the Database window stands: dismiss it to keep the restored data \(.*\), then press Run the main here again, which ends the hand-over without restoring again\. To restore old\.dump again or another dump instead, do the same, then restore with the bot in Maintenance or Off\. The other instances stopped for the restore stay stopped \(w\); start them by hand once the data is settled$/);
  });

  it('R5: only the doubtful notice fails to save: pushBroken stays', async () => {
    broken();
    claimDb.generation = LIVE;
    claimDb.restoredCounts = DIFFER;
    pg.saveFailsWhen = (t: string) => t.startsWith('Restore of ') && t.includes('ran, but');
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await lane();
    err.mockRestore();
    expect(r.steps.counts?.result).toBe('differ');
    expect(claimDb.genEvents).not.toContain('switch:pushBroken');
    expect(registryA().fleetDb.pushBroken).toBeDefined();
    expect(fleetBackup.getFleetRestoreError('a')).toMatch(STILL_NOTICE);
    expect(fleetBackup.getFleetRestoreError('a')).toMatch(/ \(this notice is not saved and a manager restart drops it\)$/);
    expect(r.error).toMatch(STILL_ERROR);
    expect(r.saysAgain).toBe(true);
  });

  it('R5b: the notice saves, the clear of pushBroken fails: the notice and the error say the next press restores again', async () => {
    broken();
    claimDb.generation = LIVE;
    claimDb.restoredCounts = DIFFER;
    pg.switchWriteFails = 'EACCES: permission denied';
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await lane();
    err.mockRestore();
    expect(r.steps.counts?.result).toBe('differ');
    expect(registryA().fleetDb.pushBroken).toBeDefined();
    expect(fleetBackup.getFleetRestoreError('a')).toMatch(STILL_NOTICE);
    expect(r.error).toMatch(STILL_ERROR);
    expect(r.saysAgain).toBe(true);
    fleetBackup.forgetRestoreNotice('a');
    expect(fleetBackup.getFleetRestoreError('a')).toMatch(STILL_NOTICE);
  });

  it('R5c: the notice saves, the clear of pushBroken fails, a second notice save fails: read back from the registry, the notice follows pushBroken', async () => {
    broken();
    claimDb.generation = LIVE;
    claimDb.restoredCounts = DIFFER;
    pg.switchWriteFails = 'EACCES: permission denied';
    pg.saveFailsWhen = (t: string) => t.includes('The push is still recorded');
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await lane();
    err.mockRestore();
    expect(r.steps.counts?.result).toBe('differ');
    expect(registryA().fleetDb.pushBroken).toBeDefined();
    expect(registryA().fleetRestoreError).toBeDefined();
    fleetBackup.forgetRestoreNotice('a');
    const still = fleetBackup.getFleetRestoreError('a');
    expect(still).toMatch(STILL_NOTICE);
    expect(still).not.toContain('(this notice is not saved');
    expect(still).not.toContain('without restoring again');
    pg.switchWriteFails = null;
    expect(await fleetBackup.clearPushBrokenMark('a')).toBe(true);
    expect(registryA().fleetDb.pushBroken).toBeUndefined();
    expect(fleetBackup.getFleetRestoreError('a')).toMatch(CLEARED_NOTICE);
  });

  it('R5d: Cancel under the notice a doubtful lane restore left, pushBroken cleared, is refused before any write; after Dismiss it runs as before', async () => {
    broken();
    claimDb.generation = LIVE;
    claimDb.restoredCounts = DIFFER;
    await lane();
    expect(registryA().fleetDb.pushBroken).toBeUndefined();
    const before = registryA().fleetDb.handover;
    const events = claimDb.genEvents.length;
    const sqlCount = pg.sql.length;
    const r = await fleetSwitch.cancelMove('a', true);
    expect(r.success).toBe(false);
    expect(r.text).toBe('A restore of old.dump has not finished cleanly (its notice is on the Database window), so the hand-over was not cancelled and nothing was changed: this database would run as the main in that state. Dismiss the notice to keep the restored data, then cancel the hand-over again.');
    expect(claimDb.genEvents.length).toBe(events);
    expect(pg.sql.length).toBe(sqlCount);
    expect(registryA().fleetDb.handover).toEqual(before);
    expect(fleetBackup.dismissFleetRestoreError('a')).toBe(true);
    const after = await fleetSwitch.cancelMove('a', true);
    expect(after.success).toBe(false);
    expect(after.text).toBe("The database runs, but the hand-over row could not be deleted (the delete answered 'no reason given'), so the hand-over is still recorded; try again.");
    expect(registryA().fleetDb.handover).toEqual(before);
  });
});

const CLEARED_NOTICE =/^Restore of old\.dump ran, but .*\. The bot's login stays blocked, so the bot writes nothing, and the other instances stopped for the restore stay stopped \(w\)\. Running and Run the main here again are refused while this notice stands: dismiss it to keep the restored data \(the pre-restore dump pre-restore-.*\.dump holds the database as it was\); the next press of Run the main here again then ends the hand-over without restoring again\. To restore old\.dump again or another dump instead, dismiss this notice and run the main here again first, then restore with the bot in Maintenance or Off$/;
const STILL_NOTICE = /^Restore of old\.dump ran, but .*\. The bot's login stays blocked, so the bot writes nothing, and the other instances stopped for the restore stay stopped \(w\)\. Running stays refused while the hand-over is recorded\. The push is still recorded as not finished, so the next press of Run the main here again restores old\.dump again \(the pre-restore dump pre-restore-.*\.dump holds the database as it was\)/;
const STILL_ERROR = /^The dump old\.dump was restored, but .*\. The bot stays in maintenance, and Running stays refused while the hand-over is recorded\. The push is still recorded as not finished, so the next press of Run the main here again restores old\.dump again \(the pre-restore dump pre-restore-.*\.dump holds the database as it was\)\. The other instances stopped for the restore stay stopped \(w\); start them by hand once the data is settled$/;

describe('NM42 R4, R6: the lane texts name the button', () => {
  it('R4e: Cancel under pushBroken and the notice of a lane restore that failed past the drop answers with its pushBroken refusal, writing nothing', async () => {
    broken();
    claimDb.generation = LIVE;
    pg.restoreCode = 1;
    await lane();
    expect(registryA().fleetDb.pushBroken).toBeDefined();
    expect(fleetBackup.shownRestoreNoticeFile('a')).toBe('old.dump');
    const before = registryA().fleetDb;
    const events = claimDb.genEvents.length;
    const sqlCount = pg.sql.length;
    const r = await fleetSwitch.cancelMove('a', true);
    expect(r.success).toBe(false);
    expect(r.text).toBe('A push replaced this database and did not finish, so it is no longer the database that was handed over; press Receive a main again so slot_c can push again. If slot_c is lost for good, press Run the main here again, which restores the dump old.dump first.');
    expect(claimDb.genEvents.length).toBe(events);
    expect(pg.sql.length).toBe(sqlCount);
    expect(registryA().fleetDb).toEqual(before);
  });

  it('R4: a failure past the drop names Run the main here again, and no other restore', async () => {
    broken();
    claimDb.generation = LIVE;
    pg.restoreCode = 1;
    const r = await lane();
    expect(r.success).toBe(false);
    expect(r.failedAt).toBe('pg_restore');
    expect(r.error).toContain('press Run the main here again, which restores old.dump again');
    expect(r.error).not.toContain('restore a dump again');
    expect(r.saysAgain).toBe(true);
    expect(registryA().fleetDb.pushBroken).toBeDefined();
  });

  it('R4b: a doubtful restore whose fence did not lift says the next press restores again, and carries saysAgain', async () => {
    broken();
    claimDb.generation = LIVE;
    claimDb.restoredCounts = DIFFER;
    pg.liftFails = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await lane();
    err.mockRestore();
    expect(r.success).toBe(false);
    expect(r.steps.counts?.result).toBe('differ');
    expect(r.error).toMatch(/\(see manager logs\)\. Restart the instance, then press Run the main here again, which restores old\.dump again \(the pre-restore dump pre-restore-.*\.dump holds the database as it was\)\. The other instances stopped for the restore stay stopped \(w\); start them by hand once the data is settled$/);
    expect(r.saysAgain).toBe(true);
    expect(registryA().fleetDb.pushBroken).toBeDefined();
  });

  it('R4d: a restore whose counts match and whose lift ends failed says the next press restores again, and carries saysAgain', async () => {
    broken();
    claimDb.generation = LIVE;
    pg.liftFails = true;
    pg.stripFails = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await lane();
    err.mockRestore();
    expect(r.success).toBe(false);
    expect(r.error).toBe("Restored, but the write fence could not be lifted or stripped: the database stays READ-ONLY, a restart does not clear it, and pressing Run the main here again restores the dump again and retries the lift (see manager logs)");
    expect(r.saysAgain).toBe(true);
    expect(registryA().fleetDb.pushBroken).toBeDefined();
  });

  it('R4c: the plain restore carries no saysAgain', async () => {
    pg.restoreCode = 1;
    const r = await restore();
    expect(r.success).toBe(false);
    expect('saysAgain' in r).toBe(false);
  });

  it('R6: a counts file naming another dump, the notice at the drop, and the notice of a failure past the drop', async () => {
    writeDumpMeta(DIR, 'old.dump', undefined, { file: 'other.dump' });
    const meta = await lane();
    expect(meta.error).toBe('The counts file old.dump.json names the dump other.dump, so it does not describe this dump and the restore was refused (nothing was changed); Run the main here again restores only this dump');
    writeDumpMeta(DIR, 'old.dump');
    claimDb.generation = LIVE;
    pg.dropFails = true;
    await lane();
    expect((pg.noticeAtDrop as any).text).toMatch(/^Restore of old\.dump has not finished: .*; press Run the main here again before choosing Running, which restores old\.dump again \(the pre-restore dump is pre-restore-.*\.dump\)$/);
    expect(registryA().fleetRestoreError.text).toMatch(/; press Run the main here again, which restores old\.dump again, before the bot relies on it$/);
  });
});

describe('NM42 R7: the lane restore classes its refusals', () => {
  it.each([
    ['a toc that reads but does not parse as an archive (TOC Entries: -3)', () => { claimDb.toc = 'emptyNeg'; }, 'read', undefined],
    ['the term schema', () => { claimDb.toc = 'terms'; }, 'shape', undefined],
    ['shard claims without a clock', () => { claimDb.toc = 'shardsNoClock'; }, 'shape', undefined],
    ['the toc read failing', () => { claimDb.fail = 'toc'; }, undefined, 'dumpRead'],
    ['the smdb_manager toc read failing', () => { claimDb.fail = 'managerToc'; }, undefined, 'dumpRead'],
  ])('%s', async (_n, set, cls, failedAt) => {
    set();
    writeDumpMeta(DIR, 'old.dump');
    const r = await lane();
    expect(r.success).toBe(false);
    expect(r.refusedAs).toBe(cls);
    expect(r.failedAt).toBe(failedAt);
    expect(claimDb.dropSeen).toBe(false);
  });

  it('a counts file naming another dump is read; pg_restore failing is failedAt', async () => {
    writeDumpMeta(DIR, 'old.dump', undefined, { file: 'other.dump' });
    expect((await lane()).refusedAs).toBe('read');
    writeDumpMeta(DIR, 'old.dump');
    claimDb.generation = LIVE;
    pg.restoreCode = 1;
    const r = await lane();
    expect(r.refusedAs).toBeUndefined();
    expect(r.failedAt).toBe('pg_restore');
  });

  it('the plain restore carries neither field', async () => {
    claimDb.toc = 'terms';
    const r = await restore();
    expect(r.success).toBe(false);
    expect('refusedAs' in r).toBe(false);
  });
});

describe('NM42 C16: the lane restore is admitted only under a hand-over to a copy without an address', () => {
  it.each([
    ['a hand-over to a copy with an address', { handover: { ...HANDOVER, host: 'copy.example', port: 5433, cert: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n' } }, 'A move of this database is recorded ('],
    ['a receive', { receive: { startedAt: '2026-10-30T08:00:00.000Z', expiresAt: '2026-10-30T09:00:00.000Z', safetyDump: 'old.dump', pushId: 'p1', dbOid: '16384', copies: [] } }, 'This database is waiting to receive a main pushed from another machine; Stop receiving before restoring a dump (nothing was changed)'],
    ['a replacement by another main', { replacedBy: { machine: 'other.example', host: 'other.example', port: 5433, generation: 6, own: 5, since: null, at: '2026-10-30T10:00:00.000Z' } }, 'other.example replaced this database as the main; rejoin this machine as a copy instead of restoring a dump (nothing was changed)'],
  ])('refused under %s, before anything stops', async (_n, db, text) => {
    broken(MAINTAINED, db);
    const before = registryA().fleetDb;
    const r = await lane();
    expect(r.success).toBe(false);
    expect(r.error).toContain(text);
    expect(pg.events).toEqual([]);
    expect(claimDb.dropSeen).toBe(false);
    expect(registryA().fleetDb).toEqual(before);
  });
});

describe('NM42 R8: restoreNoticePastDrop', () => {
  it('true after a lane restore that failed past the drop; false after a refusal before it', async () => {
    broken();
    claimDb.generation = LIVE;
    pg.dropFails = true;
    await lane();
    expect(fleetBackup.restoreNoticePastDrop('a', 'old.dump')).toBe(true);
    expect(fleetBackup.restoreNoticePastDrop('a', 'other.dump')).toBe(false);
    fleetBackup.dismissFleetRestoreError('a');
    pg.dropFails = false;
    pg.existsFails = true;
    await lane();
    expect(fleetBackup.restoreNoticePastDrop('a', 'old.dump')).toBe(false);
  });

  it('false after a refusal under the fence whose lift did not end lifted: that notice is saved as before the drop', async () => {
    broken();
    claimDb.generation = LIVE;
    pg.existsFails = true;
    pg.liftFails = true;
    pg.stripFails = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await lane();
    err.mockRestore();
    expect(r.success).toBe(false);
    expect(claimDb.dropSeen).toBe(false);
    expect(registryA().fleetRestoreError.text).toMatch(/^Restore of old\.dump was refused before the database was dropped, so its data is unchanged, but the write fence could not be lifted or stripped: the database stays READ-ONLY/);
    expect(fleetBackup.restoreNoticePastDrop('a', 'old.dump')).toBe(false);
  });
});
