import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-restore-'));
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
  switchWriteFails: null as string | null,
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
    updateInstanceFleetDbSwitch: (botId: string, patch: any) => {
      (globalThis as any).__claimDb?.genEvents.push(`switch:${Object.keys(patch).join(",")}`);
      if (pg.switchWriteFails) throw new Error(pg.switchWriteFails);
      return real.updateInstanceFleetDbSwitch(botId, patch);
    },
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

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as fleetBackup from '../../src/instance/fleetBackup';
import * as fleetBackupGuards from '../../src/instance/fleetBackupGuards';
import * as maintenance from '../../src/instance/maintenance';
import { fenceOwners } from './fence-fake';
import { claimDb, resetClaimDb, MAINTAINED, OFF, writeDumpMeta } from './restore-fake';
import { COPY_PEM } from './join-fake';

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
    stopInOpFails: null, stopInOpNotRunning: false, throwLive: null, throwAt: null, restoreGate: null, at: {}, hooks: [], noticeAtDrop: undefined, floorAtDrop: null, volumeGone: false, showOn: false, switchWriteFails: null,
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
const raisedTo = (g: number, machine = 'a') => `VALUES (true, '${machine}', ${g}, now())`;
const notice = () => registryA().fleetDb.switchNotice;

describe('S1, S4, S12, S16, S17: every restore raises the generation (D34)', () => {
  it('S1: an ordinary dump raises to max(live, restored) + 1 with this machine, and records not-owed first', async () => {
    claimDb.generation = LIVE;
    claimDb.restoredGeneration = { generation: 7, machine: 'x', since: null };
    const r = await restore();
    expect(r.success).toBe(true);
    expect(claimDb.genWrites).toHaveLength(1);
    expect(claimDb.genWrites[0]).toMatch(raisedTo(8));
    expect(r.steps?.generation).toBe(8);
    expect(notice()).toEqual({ generation: 8, machine: 'a', since: null, state: 'not-owed' });
    const ev = claimDb.genEvents;
    expect(ev.indexOf('gen-restored')).toBeLessThan(ev.indexOf('switch:switchNotice'));
    expect(ev.indexOf('switch:switchNotice')).toBeLessThan(ev.indexOf('gen-write'));
  });
  it('S4: no live row: the floor counts, and with neither the write is generation 1', async () => {
    claimDb.restoreState = { pending: false, file: 'x.dump', generation: 4, machine: 'f', since: null };
    let r = await restore();
    expect(r.success).toBe(true);
    expect(claimDb.genWrites[0]).toMatch(raisedTo(5));
    resetClaimDb({ onRaise: () => pg.events.push('raise') });
    r = await restore();
    expect(r.success).toBe(true);
    expect(claimDb.genWrites[0]).toMatch(raisedTo(1));
    expect(r.steps?.generation).toBe(1);
  });
  it('S12: a retry over a partial database writes above the floor, not the partial row', async () => {
    claimDb.generation = { generation: 2, machine: 'partial', since: null };
    claimDb.restoreState = { pending: true, file: 'old.dump', generation: 6, machine: 'm', since: null };
    claimDb.restoredGeneration = { generation: 3, machine: 'x', since: null };
    const r = await restore();
    expect(r.success).toBe(true);
    expect(claimDb.genWrites[0]).toMatch(raisedTo(7));
  });
  it('S16: the not-owed record stands at a generation the failed raise never reached; the notice and the fence stay', async () => {
    claimDb.generation = LIVE;
    claimDb.fail = 'genwrite';
    const r = await restore();
    expect(r.success).toBe(false);
    expect(notice()).toMatchObject({ generation: 6, state: 'not-owed' });
    expect(registryA().fleetRestoreError.text).toContain('the generation row could not be written back');
    expect(fenceOwners.has('bot-a-postgres')).toBe(true);
  });
  it('S17: the not-owed write throws: logged, and the raise goes on', async () => {
    claimDb.generation = LIVE;
    pg.switchWriteFails = 'EACCES: permission denied';
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = await restore();
    const logged = [...err.mock.calls, ...warn.mock.calls].map(c => String(c[0]));
    err.mockRestore();
    warn.mockRestore();
    expect(r.success).toBe(true);
    expect(claimDb.genWrites[0]).toMatch(raisedTo(6));
    expect(logged).toContain('[Switch] a: the manager could not record that this restore owes no switch notice (EACCES: permission denied); the bot may post one for generation 6');
  });
});

describe('S2, S3, S5 to S11, S13 to S15: the rest of the restore lane', () => {
  const MOVED = 'moved-2026-10-30T10-00-00-000Z.dump';
  const withA = (fleet: Record<string, unknown>, extra: Record<string, unknown> = MAINTAINED) => writeRegistry({ ...extra, fleetDb: { ...primary, ...fleet } });
  const PRIOR = { file: 'prev.dump', text: 'Restore of prev.dump failed: the copy was cut' };
  const PENDING = { pending: true, file: 'prev.dump', generation: 4, machine: 'm', since: null };

  it('S2, S7: a moved- file raises above both rows, cuts the addresses and the handover rows, and leaves the notice owed', async () => {
    fs.writeFileSync(path.join(DIR, MOVED), 'dump');
    claimDb.generation = LIVE;
    claimDb.restoredGeneration = { generation: 9, machine: 'other.example', since: null };
    const r = await restore(MOVED);
    expect(r.success).toBe(true);
    expect(r.steps?.generation).toBe(10);
    expect(claimDb.genWrites).toHaveLength(1);
    expect(claimDb.genWrites[0]).toMatch(raisedTo(10));
    expect(claimDb.genWrites[0]).toContain('DELETE FROM smdb_manager.handover;');
    expect(claimDb.genWrites[0]).toContain("EXECUTE format('DELETE FROM smdb_manager.addresses')");
    expect(notice()).toBeUndefined();
    const { noticeDue } = await import('../../src/instance/fleetSwitch');
    expect(noticeDue({ generation: 10, machine: 'a', since: null }, notice(), Date.now(), true)).toBe(true);
  });

  it('S3: the generation read fails: RS-GEN, the fence lifted, the prior notice put back, pending as it was, no drop', async () => {
    withA({}, { ...MAINTAINED, fleetRestoreError: PRIOR });
    claimDb.generation = LIVE;
    claimDb.restoreState = { ...PENDING };
    claimDb.fail = 'gen';
    const r = await restore();
    expect(r.success).toBe(false);
    expect(r.error).toBe("Could not read the database's generation before the restore, so the restore was refused, and nothing was changed: ERROR:  connection reset by peer");
    expect(claimDb.dropSeen).toBe(false);
    expect(claimDb.genEvents).not.toContain('state-upsert');
    expect(claimDb.restoreState).toEqual(PENDING);
    expect(fenceOwners.has('bot-a-postgres')).toBe(false);
    expect(registryA().fleetRestoreError).toMatchObject(PRIOR);
  });

  it('S5: the raise fails: RS-GENWRITE through setRestoreError and keepFenced, pending stays', async () => {
    claimDb.generation = LIVE;
    claimDb.fail = 'genwrite';
    const r = await restore();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^The dump was restored, but the generation row could not be written back \(ERROR: {2}cannot execute INSERT in a read-only transaction\)\. The write fence stays on, the bot stays in maintenance, and the other stopped instances stay stopped \(w\), so nothing writes to a database that may be missing or partial; the database is READ-ONLY and no longer refuses connections; with the bot in Maintenance or Off, restore a dump again: the pre-restore dump .*\.dump holds the database as it was$/);
    expect(registryA().fleetRestoreError.text).toMatch(/^Restore of old\.dump failed: the generation row could not be written back \(ERROR: {2}cannot execute INSERT in a read-only transaction\)\. Bots may take another database of this bot for the main while this one shows the dump's older generation, so the write fence stays on \(the pre-restore dump is pre-restore-.*\.dump\); restore a dump again before the bot relies on it/);
    expect(claimDb.restoreState?.pending).toBe(true);
    expect(claimDb.genEvents).not.toContain('state-clear');
    expect(fenceOwners.has('bot-a-postgres')).toBe(true);
  });

  const HANDOVER = { mode: 'stream', phase: 'waiting', at: '2026-10-29T10:00:00.000Z', slot: 'slot_c', machine: 'copy.example' };
  const RECEIVE = { startedAt: '2026-10-29T10:00:00.000Z', expiresAt: '2026-10-29T11:00:00.000Z', safetyDump: 'pre-receive.dump' };
  const REPLACED = { machine: 'new.example', host: 'new.example', port: 5434, generation: 9, own: 5, since: null, at: '2026-10-29T10:00:00.000Z' };
  it.each([
    ['S6 receive', { receive: RECEIVE }, 'This database is waiting to receive a main pushed from another machine; Stop receiving before restoring a dump (nothing was changed)'],
    ['S9 handover stream', { handover: HANDOVER }, 'A move of this database is recorded (a hand-over to copy.example); Cancel it in the Database window before restoring a dump (nothing was changed)'],
    ['S9 handover push, done', { handover: { ...HANDOVER, mode: 'push', phase: 'done' } }, 'A move of this database is recorded (a push to copy.example); Cancel it in the Database window before restoring a dump (nothing was changed)'],
    ['S9 handover file', { handover: { mode: 'file', phase: 'done', at: '2026-10-29T10:00:00.000Z', file: 'moved-x.dump' } }, 'A move of this database is recorded (a backup made for a move); Cancel it in the Database window before restoring a dump (nothing was changed)'],
    ['S10 replacedBy', { replacedBy: REPLACED }, 'new.example replaced this database as the main; rejoin this machine as a copy instead of restoring a dump (nothing was changed)'],
  ])('%s: refused at admission, nothing run', async (_n, fleet, text) => {
    withA(fleet);
    const r = await restore();
    expect(r).toMatchObject({ success: false, error: text });
    expect(pg.events).toEqual([]);
    expect(claimDb.genEvents).toEqual([]);
  });

  it.each(['handover', 'takeover', 'receive', 'push', 'move-out', 'keep-main'])('S11: a switch lane holding %s: NM4 busy text', async (op) => {
    const r = await containerManager.withExternalBotOp('a', op, () => restore());
    expect(r).toMatchObject({ success: false, error: `Operation '${op}' is running on this bot; wait for it before restoring a dump (nothing was changed)` });
    expect(pg.events).toEqual([]);
  });

  it('S8: the restore record upsert fails: RS-STATE, no drop, the fence lifted', async () => {
    claimDb.generation = LIVE;
    claimDb.fail = 'state';
    const r = await restore();
    expect(r.success).toBe(false);
    expect(r.error).toBe("The database's generation could not be kept before the drop, so the restore was refused, and nothing was changed: ERROR:  could not write to file");
    expect(claimDb.dropSeen).toBe(false);
    expect(claimDb.genWrites).toEqual([]);
    expect(fenceOwners.has('bot-a-postgres')).toBe(false);
  });

  it('S13: a clean end clears pending; a failed clear is logged and the restore still succeeds', async () => {
    claimDb.generation = LIVE;
    let r = await restore();
    expect(r.success).toBe(true);
    expect(claimDb.genEvents.at(-1)).toBe('state-clear');
    expect(claimDb.restoreState?.pending).toBe(false);
    resetClaimDb({ onRaise: () => pg.events.push('raise'), generation: LIVE, fail: 'clear' });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    r = await restore();
    const logged = err.mock.calls.map(c => String(c[0]));
    err.mockRestore();
    expect(r.success).toBe(true);
    expect(claimDb.restoreState?.pending).toBe(true);
    expect(logged).toContain("[FleetBackup] Could not mark the restore of old.dump finished for a's copies (ERROR:  connection reset by peer); the switch check marks it within a minute");
  });

  it('S14: the notice clear fails: pending stays', async () => {
    claimDb.generation = LIVE;
    pg.clearFails = true;
    const r = await restore();
    expect(r.success).toBe(true);
    expect(claimDb.genEvents).not.toContain('state-clear');
    expect(claimDb.restoreState?.pending).toBe(true);
  });
  it('S14: the lift is not lifted: pending stays while the notice stands', async () => {
    claimDb.generation = LIVE;
    pg.liftFails = true;
    const r = await restore();
    expect(r.success).toBe(false);
    expect(registryA().fleetRestoreError).toBeTruthy();
    expect(claimDb.genEvents).not.toContain('state-clear');
    expect(claimDb.restoreState?.pending).toBe(true);
  });

  it.each([
    ['handover', { handover: HANDOVER }, 'cancel the move, then run a restore again with the bot in Maintenance or Off to retry the lift'],
    ['receive', { receive: RECEIVE }, 'stop receiving, then run a restore again with the bot in Maintenance or Off to retry the lift'],
    ['replacedBy', { replacedBy: REPLACED }, 'rejoining this machine as a copy rebuilds the database without the fence'],
  ])('S15: a stuck restore fence under a %s mark names RS-STEP', async (_n, fleet, step) => {
    withA(fleet);
    pg.showOn = true;
    fenceOwners.set('bot-a-postgres', 'restore:1700000000000');
    vi.resetModules();
    const fb = await import('../../src/instance/fleetBackup');
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation((() => 0) as unknown as typeof setInterval);
    fb.startFleetBackupScheduler();
    spy.mockRestore();
    fb.stopFleetBackupScheduler();
    await vi.waitFor(() => expect(fb.getFleetFenceStuck('a')).not.toBeNull());
    expect(fb.getFleetFenceStuck('a')).toBe(`The database is READ-ONLY (a write fence was not lifted); whether a restart clears it could not be confirmed (its saved configuration could not be read); it belongs to a restore (started 2023-11-14 22:13 UTC), and ${step}`);
  });
});

describe('S18 to S20: the copies of a moved- restore, and an unfinished push (D49, D42)', () => {
  const MOVED = 'moved-2026-10-30T11-00-00-000Z.dump';
  const ROW = { host: 'copy.example', port: 5434, slot: 'slot_c', cert: COPY_PEM, machine: 'copy.example' };
  it('S18: a moved- file reads this machine\'s copies before the drop and writes them back after the cut', async () => {
    fs.writeFileSync(path.join(DIR, MOVED), 'dump');
    claimDb.generation = LIVE;
    claimDb.ownCopies = JSON.stringify([ROW]);
    const r = await restore(MOVED);
    expect(r.success).toBe(true);
    expect(claimDb.genEvents.indexOf('own-copies')).toBeGreaterThanOrEqual(0);
    expect(claimDb.genEvents.indexOf('own-copies')).toBeLessThan(claimDb.genEvents.indexOf('state-upsert'));
    const write = claimDb.genWrites[0];
    const cut = write.indexOf("EXECUTE format('DELETE FROM smdb_manager.addresses");
    const back = write.indexOf("INSERT INTO smdb_manager.addresses (host, port, slot, cert, machine) SELECT 'copy.example', 5434, 'slot_c'");
    expect(cut).toBeGreaterThanOrEqual(0);
    expect(back).toBeGreaterThan(cut);
    expect(write.slice(back)).toContain("WHERE EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = 'slot_c') ON CONFLICT (host, port) DO NOTHING;");
  });
  it('S18: an ordinary file reads no copies', async () => {
    claimDb.generation = LIVE;
    expect((await restore()).success).toBe(true);
    expect(claimDb.genEvents).not.toContain('own-copies');
  });
  it('S19: the read fails: logged, and the restore goes on without the rows', async () => {
    fs.writeFileSync(path.join(DIR, MOVED), 'dump');
    claimDb.generation = LIVE;
    claimDb.fail = 'owncopies';
    const seen: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { seen.push(String(m)); });
    const r = await restore(MOVED);
    warn.mockRestore();
    expect(r.success).toBe(true);
    expect(seen).toContain("[Switch] a: this machine's copies could not be read before the restore (ERROR:  connection reset by peer); they register again within an hour");
    expect(claimDb.genWrites[0]).not.toContain('INSERT INTO smdb_manager.addresses (host, port, slot, cert, machine) SELECT');
  });
  it('S20: a restore that ends lifted clears pushBroken', async () => {
    writeRegistry({ ...MAINTAINED, fleetDb: { ...primary, pushBroken: { at: '2026-10-30T09:00:00.000Z', safetyDump: 'pre-receive-x.dump' } } });
    claimDb.generation = LIVE;
    const r = await restore();
    expect(r.success).toBe(true);
    expect(registryA().fleetDb.pushBroken).toBeUndefined();
  });
  const BROKEN = () => writeRegistry({ ...MAINTAINED, fleetDb: { ...primary, pushBroken: { at: '2026-10-30T09:00:00.000Z', safetyDump: 'pre-receive-x.dump' } } });
  it('S23 (D62): after the pushBroken clear is saved, the receive mark is removed with no id, on postgres', async () => {
    BROKEN();
    claimDb.generation = LIVE;
    expect((await restore()).success).toBe(true);
    const ev = claimDb.genEvents;
    expect(ev.indexOf('mark-clear')).toBeGreaterThan(ev.indexOf('switch:pushBroken'));
    expect(claimDb.markClears).toHaveLength(1);
    expect(claimDb.markClears[0]).toContain("to_regclass('smdb_manager.receive_mark')");
    expect(claimDb.markClears[0]).toContain('-d postgres');
    expect(claimDb.markClears[0]).not.toContain('WHERE');
  });
  it('S23: no pushBroken stood: no removal', async () => {
    claimDb.generation = LIVE;
    expect((await restore()).success).toBe(true);
    expect(claimDb.genEvents).not.toContain('mark-clear');
  });
  it('S23: the pushBroken save threw: no removal', async () => {
    BROKEN();
    claimDb.generation = LIVE;
    pg.switchWriteFails = 'EACCES: permission denied';
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await restore();
    err.mockRestore();
    expect(claimDb.genEvents).toContain('switch:pushBroken');
    expect(claimDb.genEvents).not.toContain('mark-clear');
  });
  it('S23: the removal fails: RS-LOG-MARK, the restore stands', async () => {
    BROKEN();
    claimDb.generation = LIVE;
    claimDb.fail = 'markclear';
    const seen: string[] = [];
    const err = vi.spyOn(console, 'error').mockImplementation((m: unknown) => { seen.push(String(m)); });
    const r = await restore();
    err.mockRestore();
    expect(r.success).toBe(true);
    expect(seen).toContain("[Switch] a: the restore finished, but the mark that tells this database's copies a push did not finish could not be removed (ERROR:  connection reset by peer); the switch check removes it within a minute");
    expect(registryA().fleetDb.pushBroken).toBeUndefined();
  });
});

describe('S21, S22 (D59): step 7 makes sure the replication role exists before the drop', () => {
  it('S21: the recreate runs the role ensure as its first -c, in the exempt session, before DROP DATABASE', async () => {
    const r = await restore();
    expect(r.success).toBe(true);
    const args = claimDb.recreateArgs!;
    expect(args).not.toBeNull();
    expect(args.slice(0, 3)).toEqual(['exec', '-e', 'PGOPTIONS=-c default_transaction_read_only=off']);
    const cs = args.flatMap((a, i) => (a === '-c' ? [args[i + 1]] : []));
    expect(cs[0]).toBe("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'replicator') THEN CREATE ROLE replicator NOLOGIN REPLICATION; END IF; END $$;");
    expect(cs[1]).toMatch(/^DROP DATABASE IF EXISTS "app" WITH \(FORCE\)$/);
  });
  it('S22: the ensure fails: ON_ERROR_STOP ends the call before the DROP; the recreate failure keeps the notice and the fence', async () => {
    claimDb.fail = 'ensure';
    const r = await restore();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/could not recreate the database: ERROR: {2}permission denied to create role/);
    expect(claimDb.dropSeen).toBe(false);
    expect(registryA().fleetRestoreError).toMatchObject({ file: 'old.dump' });
  });
});
