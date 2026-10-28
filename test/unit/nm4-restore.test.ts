import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm4-restore-'));
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
const refusedBefore = (refused: string, detail: string) => `${refused}, and nothing was changed: ${detail}`;
const T2 = (detail: string) => refusedBefore('A restore runs only in maintenance, so it was refused', detail);

type Row = { id: string; setup?: () => void; file?: string; check: (r: any) => void };

const noStopNoFence = () => {
  expect(pg.events.filter(e => e.startsWith('stop') || e === 'fence')).toEqual([]);
  expect(dropped()).toBe(false);
};
const beforeFence = (r: any) => {
  expect(r.success).toBe(false);
  noStopNoFence();
  expect(registryA().fleetRestoreError).toBeUndefined();
};
const guardRow = (r: any, detail: string | RegExp) => {
  beforeFence(r);
  if (typeof detail === 'string') expect(r.error).toBe(T2(detail));
  else expect(r.error).toMatch(detail);
  expect(claimDb.tocReads).toBe(0);
  expect(r.steps.botState).toBeNull();
};
const afterFenceRefusal = (r: any) => {
  expect(r.success).toBe(false);
  expect(dropped()).toBe(false);
  expect(at('lift')).toBeGreaterThan(at('fence'));
  expect(registryA().fleetRestoreError).toBeUndefined();
  expect(r.steps.restarted).toEqual(['w']);
  expect(pg.events).not.toContain('start:a');
};
const keptFenced = (r: any) => {
  expect(r.success).toBe(false);
  expect(dropped()).toBe(true);
  expect(pg.events.filter(e => e.startsWith('start'))).toEqual([]);
  expect(fleetBackup.getFleetFenceStuck('a')).toMatch(/READ-ONLY/);
  expect(registryA().fleetRestoreError.text).toMatch(/^Restore of old\.dump failed: /);
};

const ROWS: Row[] = [
  { id: 'C1 shutting down', setup: () => { pg.shutdown = true; }, check: r => { expect(r.error).toBe(containerManager.SHUTDOWN_REFUSAL); expect(pg.events).toEqual([]); } },
  { id: 'C2 bad name', file: '../x.dump', check: r => { expect(r.error).toBe('Invalid dump file name'); expect(pg.events).toEqual([]); } },
  { id: 'C2 no record', setup: () => writeRegistry({ ...MAINTAINED, fleetDb: undefined }), check: r => expect(r.error).toBe('No fleet database record') },
  { id: 'C2 no dump', file: 'missing.dump', check: r => expect(r.error).toBe('Dump file not found') },
  { id: 'C2 store unreadable', setup: () => { pg.storeCorrupt = true; }, check: r => expect(r.error).toMatch(/^The env store for this instance cannot be read/) },
  { id: 'C2 no URL', setup: () => { pg.urls.a = ''; }, check: r => expect(r.error).toBe('Instance has no stored database URL') },
  { id: 'C2 seed running', setup: () => { pg.seed = { parked: false }; }, check: r => { expect(r.error).toBe('A standby seed is running on this instance; wait for it before restoring a dump (nothing was changed)'); expect(pg.events).toEqual([]); } },
  {
    id: 'C3 claim floor file unreadable', setup: () => fs.writeFileSync(FLOOR, '{ "term": 3 }'),
    check: r => { expect(r.error).toBe(`The claim floor file ${FLOOR} could not be read (it holds no whole-number claim), so the highest claim number the bot used before is unknown and the restore was refused (nothing was changed); repair the file, then retry`); expect(pg.events).toEqual([]); },
  },
  { id: 'C5 a sharer holds an op', check: r => { expect(r.error).toBe("Operation 'update' is running on w, which shares this database; wait for it before restoring a dump (nothing was changed)"); expect(pg.events).toEqual([]); } },
  { id: 'C6 a dump of this bot runs', setup: () => { fleetBackupGuards.claimFleetBackupBusy('a'); }, check: r => { fleetBackupGuards.releaseFleetBackupBusy('a'); expect(r.error).toBe('A backup operation is already in progress'); expect(pg.events).toEqual([]); } },
  {
    id: 'C7 sidecar does not start', setup: () => { pg.sidecar = false; pg.sidecarStarts = [false]; },
    check: r => { expect(r.error).toBe('Could not start the database for the restore: port 5432 is in use'); noStopNoFence(); },
  },
  { id: 'C8 G1 state Running', setup: () => writeRegistry({}), check: r => guardRow(r, 'This bot is not in maintenance; put it into Maintenance or Off first') },
  {
    id: 'C8 G1 sidecar stopped again', setup: () => { writeRegistry({}); pg.sidecar = false; },
    check: r => { guardRow(r, 'This bot is not in maintenance; put it into Maintenance or Off first'); expect(pg.events).toEqual(['sidecar-up', 'docker-stop:bot-a-postgres']); },
  },
  {
    id: 'C9 G2 not settled', setup: () => writeRegistry({ maintenance: { ...MAINTAINED.maintenance, settled: false } }),
    check: r => guardRow(r, "The bot's change to Maintenance is not confirmed yet (the order has not finished), so it does not count as maintenance"),
  },
  {
    id: 'C10 G3 external database', setup: () => { pg.urls.a = 'postgres://app:pw@db.elsewhere.test:5432/app'; },
    check: r => guardRow(r, "The bot's database is not run by this manager, so this manager cannot confirm its login is blocked"),
  },
  { id: 'C11 G4 login read fails', setup: () => { claimDb.fail = 'login'; }, check: r => guardRow(r, /^A restore runs only in maintenance, so it was refused, and nothing was changed: The manager can't confirm the bot's database login is blocked: /) },
  { id: 'C11 role missing', setup: () => { claimDb.login = 'false|missing|0'; }, check: r => guardRow(r, "The manager can't confirm the bot's database login is blocked: the role app does not exist") },
  { id: 'C12 G5 login open', setup: () => { claimDb.login = 'false|true|0'; }, check: r => guardRow(r, "The bot's database login is open although the state is Maintenance; the manager blocks it again within 30 seconds, then retry") },
  { id: 'C13 G6 sessions open', setup: () => { claimDb.login = 'false|false|2'; }, check: r => guardRow(r, "2 session(s) of the bot's database role are open although its login is blocked; retry in a moment") },
  { id: 'C14 G7 in recovery', setup: () => { claimDb.login = 'true|false|0'; }, check: r => guardRow(r, "The database is a live copy in recovery, so it is not this bot's main database") },
  {
    id: 'C15 settled Maintenance', check: r => {
      expect(r.success).toBe(true);
      expect(r.steps.botState).toBe('maintenance');
      expect(pg.events.filter(e => e.endsWith(':a'))).toEqual([]);
    },
  },
  {
    id: 'C16 settled Off', setup: () => { writeRegistry(OFF); pg.live.a = []; },
    check: r => { expect(r.success).toBe(true); expect(r.steps.botState).toBe('off'); expect(r.steps.stopped).toEqual(['w']); },
  },
  {
    id: 'C17 TOC read fails', setup: () => { claimDb.fail = 'toc'; },
    check: r => { beforeFence(r); expect(r.error).toBe(refusedBefore('The dump old.dump could not be read, so the restore was refused', 'pg_restore exited with code 1: pg_restore: error: input file does not appear to be a valid archive')); expect(r.steps.botState).toBe('maintenance'); },
  },
  {
    id: 'C17 not a TOC', setup: () => { claimDb.fail = 'toc'; claimDb.tocCode = 0; },
    check: r => { beforeFence(r); expect(r.error).toBe(refusedBefore('The dump old.dump could not be read, so the restore was refused', 'it is not a pg_dump archive')); },
  },
  {
    id: 'C18 dump on the term schema', setup: () => { claimDb.toc = 'terms'; },
    check: r => { beforeFence(r); expect(r.error).toBe(refusedBefore('The dump old.dump was taken before the bot numbered its saves by claim, so the restore was refused', 'it has smdb_data.guild_ownership but no smdb_data.claim_seq, and the bot does not run on that schema')); },
  },
  { id: 'C19 shape claims continues', check: r => { expect(r.success).toBe(true); expect(claimDb.tocReads).toBe(1); expect(claimDb.tocInput).toBeGreaterThan(0); } },
  {
    id: 'C20 docker does not answer for a sharer', setup: () => { pg.live.w = null; },
    check: r => { expect(r.error).toBe('Docker could not say whether instance w is running, so the restore was refused and nothing was changed'); expect(pg.events).not.toContain('fence'); },
  },
  {
    id: 'C21 Maintenance, self runs', check: r => {
      expect(r.success).toBe(true);
      expect(pg.events.filter(e => /^(stop|start|stopInOp|startInOp):a$/.test(e))).toEqual([]);
      expect(r.steps.stopped).toEqual(['w']);
      expect(r.steps.restarted).toEqual(['w']);
    },
  },
  {
    id: 'C22 Maintenance, self not running', setup: () => { pg.live.a = []; },
    check: r => { expect(r.success).toBe(true); expect(pg.events.filter(e => e.endsWith(':a'))).toEqual([]); },
  },
  {
    id: 'C23 Off, self runs', setup: () => writeRegistry(OFF),
    check: r => {
      expect(r.success).toBe(true);
      expect(r.steps.stopped).toEqual(['a', 'w']);
      expect(r.steps.restarted).toEqual(['w']);
      expect(at('stopInOp:a')).toBeLessThan(at('fence'));
      expect(pg.events.filter(e => /^(start|startInOp|stop):a$/.test(e))).toEqual([]);
    },
  },
  {
    id: 'C24 Off, self stop fails', setup: () => { writeRegistry(OFF); pg.stopInOpFails = 'compose down failed'; },
    check: r => { expect(r.error).toBe('Could not stop instance a: compose down failed'); expect(pg.events).not.toContain('fence'); expect(pg.events.filter(e => e.startsWith('start'))).toEqual([]); },
  },
  {
    id: 'C25 a sharer stop fails', setup: () => { pg.stopFails.w = 'timeout'; },
    check: r => { expect(r.error).toBe('Could not stop instance w: timeout'); expect(pg.events).not.toContain('fence'); },
  },
  {
    id: 'C26 sidecar does not come back', setup: () => { writeRegistry(OFF); pg.sidecarStarts = [false]; },
    check: r => { expect(r.error).toBe('Could not start the database for the restore: port 5432 is in use'); expect(pg.events).not.toContain('fence'); expect(pg.events).not.toContain('start:a'); },
  },
  { id: 'C27 fence not applied', setup: () => { pg.fenceFails = true; }, check: r => { expect(r.error).toMatch(/^Could not fence the database for the restore: /); expect(dropped()).toBe(false); expect(r.steps.restarted).toEqual(['w']); } },
  { id: 'C28 exists probe fails', setup: () => { pg.existsFails = true; }, check: r => { afterFenceRefusal(r); expect(r.error).toBe('Could not check the database before the restore, so the restore was refused, and nothing was changed: ERROR:  the database system is starting up'); } },
  { id: 'C29 safety dump fails', setup: () => { pg.dumpCode = 1; }, check: r => { afterFenceRefusal(r); expect(r.error).toMatch(/^Pre-restore dump failed, restore refused, and nothing was changed: /); } },
  {
    id: 'C30 claim probe fails', setup: () => { claimDb.fail = 'floor'; },
    check: r => { afterFenceRefusal(r); expect(r.error).toBe('Could not read the claim numbers before the restore, so the restore was refused, and nothing was changed: ERROR:  connection reset by peer'); },
  },
  {
    id: 'C31 live schema on terms', setup: () => { claimDb.tables = 't|t|f'; },
    check: r => { afterFenceRefusal(r); expect(r.error).toBe("The bot's database numbers its saves by term, which this manager no longer reads, so the restore was refused, and nothing was changed: smdb_data.guild_ownership has no claim column"); },
  },
  {
    id: 'C32 neither table nor sequence, file floor', setup: () => { claimDb.tables = 'f|f|f'; fs.writeFileSync(FLOOR, '{"claim":4}'); claimDb.raise = 'seq|5\n'; },
    check: r => { expect(r.success).toBe(true); expect(r.steps.claimFloor).toBe(4); expect(r.steps.claimRaisedTo).toBe(5); expect(pg.sql.some(s => s.includes('SELECT coalesce(GREATEST('))).toBe(false); },
  },
  {
    id: 'C33 database missing', setup: () => { pg.exists = '0'; fs.writeFileSync(FLOOR, '{"claim":5}'); claimDb.raise = 'seq|6\nguild|g1\n'; },
    check: r => {
      expect(r.success).toBe(true);
      expect(r.steps.preRestoreDump).toBeNull();
      expect(pg.events).not.toContain('dump');
      expect(r.steps.claimFloor).toBe(5);
      expect(claimDb.raiseSql[0]).toContain('SET claim = 6');
    },
  },
  {
    id: 'C34 dump without claims, floor known', setup: () => { claimDb.toc = 'none'; },
    check: r => { afterFenceRefusal(r); expect(r.error).toBe('The dump old.dump holds no claim numbers, so the restore was refused, and nothing was changed: the bot has used claim numbers up to 7, and without smdb_data.claim_seq in the dump a process that ran before the restore could save over the restored data'); },
  },
  {
    id: 'C35 dump without claims, no floor', setup: () => { claimDb.toc = 'none'; claimDb.tables = 'f|f|f'; },
    check: r => { expect(r.success).toBe(true); expect(pg.events).not.toContain('raise'); expect(r.steps.claimFloor).toBeNull(); expect(r.steps.guildsRaised).toBeNull(); },
  },
  {
    id: 'C36 floor not written', setup: () => { fs.mkdirSync(`${FLOOR}.tmp`); },
    check: r => { afterFenceRefusal(r); expect(r.error).toMatch(/^The claim floor 7 could not be kept on disk, so the restore was refused, and nothing was changed: .*; free space under .* and retry \(this manager holds the number in memory until it restarts\)$/); },
  },
  {
    id: 'C37 a sharer started outside', setup: () => { pg.at.dump = () => { pg.live.w = ['bot-w-app']; }; },
    check: r => { expect(r.success).toBe(false); expect(r.error).toMatch(/^An instance sharing the database was started outside the manager during the restore, so the restore was refused, and nothing was changed: bot-w-app runs now/); expect(dropped()).toBe(false); },
  },
  {
    id: 'C38 docker does not answer at P16', setup: () => { pg.at.dump = () => { pg.live.w = null; }; },
    check: r => { expect(r.error).toMatch(/^Docker could not say whether an instance sharing the database was started during the restore, so the restore was refused/); expect(dropped()).toBe(false); },
  },
  {
    id: 'C39 notice not saved', setup: () => { pg.saveFails = true; },
    check: r => {
      expect(r.error).toMatch(/^The restore could not be recorded before the database was fenced, so the restore was refused, and nothing was changed: ENOSPC/);
      expect(pg.events).not.toContain('fence');
      expect(dropped()).toBe(false);
      expect(registryA().fleetRestoreError).toBeUndefined();
      expect(r.steps.restarted).toEqual(['w']);
    },
  },
  { id: 'C40 drop fails', setup: () => { pg.dropFails = true; }, check: r => { keptFenced(r); expect(r.error).toMatch(/^Restore failed: could not recreate the database: /); expect(pg.hooks).toEqual([]); } },
  { id: 'C41 pg_restore fails', setup: () => { pg.restoreCode = 1; }, check: r => {
      keptFenced(r);
      expect(r.error).toMatch(/^Restore failed: pg_restore exited with code 1: pg_restore: error: out of disk\. The write fence stays on, the bot stays in maintenance, and the other stopped instances stay stopped \(w\), so nothing writes to /);
      expect(r.error).toMatch(/; with the bot in Maintenance or Off, restore a dump again: the pre-restore dump /);
      expect(fleetBackup.getFleetFenceStuck('a')).toMatch(/; with the bot in Maintenance or Off, restore a dump again \(/);
    } },
  {
    id: 'C41 Off: the bot stays off, and only the other instances are named', setup: () => { writeRegistry(OFF); pg.restoreCode = 1; },
    check: r => {
      keptFenced(r);
      expect(r.steps.stopped).toEqual(['a', 'w']);
      expect(r.error).toMatch(/\. The write fence stays on, the bot stays off, and the other stopped instances stay stopped \(w\), so nothing writes to /);
    },
  },
  {
    id: 'C41 no other instance stopped: no sharers clause', setup: () => { pg.live.w = []; pg.restoreCode = 1; },
    check: r => {
      keptFenced(r);
      expect(r.error).toMatch(/\. The write fence stays on and the bot stays in maintenance, so nothing writes to /);
      expect(r.error).not.toMatch(/none were running/);
    },
  },
  {
    id: 'C42 F null', setup: () => { claimDb.tables = 'f|f|f'; },
    check: r => { expect(r.success).toBe(true); expect(r.steps.claimFloor).toBeNull(); expect(r.steps.guildsRaised).toBeNull(); expect(r.steps.claimRaisedTo).toBeNull(); expect(claimDb.raiseSql).toEqual([]); },
  },
  { id: 'C43 restored probe fails', setup: () => { claimDb.fail = 'restored'; }, check: r => { keptFenced(r); expect(r.error).toMatch(/^The dump was restored, but the restored claim numbers could not be raised above 7 \(/); } },
  { id: 'C43 restored without claim_seq', setup: () => { claimDb.restoredTables = 'f|t|t'; }, check: r => { keptFenced(r); expect(r.error).toMatch(/^The dump was restored, but the restored claim numbers could not be raised above 7 \(the restored database has no smdb_data\.claim_seq\)/); } },
  { id: 'C43 restored without claim column', setup: () => { claimDb.restoredTables = 't|t|f'; }, check: r => { keptFenced(r); expect(r.error).toMatch(/\(the restored smdb_data\.guild_ownership has no claim column\)/); } },
  {
    id: 'C44 raise fails', setup: () => { claimDb.fail = 'raise'; },
    check: r => {
      keptFenced(r);
      expect(r.error).toMatch(/^The dump was restored, but the restored claim numbers could not be raised above 7 \(ERROR:  permission denied for sequence claim_seq\)\. The write fence stays on/);
      expect(registryA().fleetRestoreError.text).toMatch(/A process of the bot that ran before the restore could save over the restored rows, so the write fence stays on \(the pre-restore dump is /);
    },
  },
  { id: 'C45 raise answers no seq line', setup: () => { claimDb.raise = 'guild|g1\n'; }, check: r => { keptFenced(r); expect(r.error).toMatch(/could not be raised above 7/); } },
  { id: 'C45 raise answers below F+1', setup: () => { claimDb.raise = 'seq|7\n'; }, check: r => { keptFenced(r); expect(r.error).toMatch(/could not be raised above 7/); } },
  {
    id: 'C46 raise ok', check: r => {
      expect(r.success).toBe(true);
      expect(r.steps.claimFloor).toBe(7);
      expect(r.steps.guildsRaised).toEqual(['g1', 'g2']);
      expect(r.steps.claimRaisedTo).toBe(8);
      expect(claimDb.raiseSql[0]).toContain('PGOPTIONS=-c default_transaction_read_only=off');
    },
  },
  {
    id: 'C47 a sharer started meanwhile', setup: () => { pg.at.pg_restore = () => { pg.live.w = ['bot-w-app']; }; },
    check: r => { expect(r.success).toBe(false); expect(r.error).toMatch(/^The dump was restored, but bot-w-app was started outside the manager during the restore/); expect(pg.events.slice(at('pg_restore'))).not.toContain('lift'); },
  },
  { id: 'C48 lift lifted', check: r => { expect(r.success).toBe(true); expect(fleetBackup.getFleetFenceStuck('a')).toBeNull(); } },
  {
    id: 'C49 lift not lifted', setup: () => { pg.liftFails = true; },
    check: r => {
      expect(r.success).toBe(false);
      expect(r.steps.restored).toBe(true);
      expect(r.error).toMatch(/^Restored, but /);
      expect(registryA().fleetRestoreError.text).toMatch(/^Restore of old\.dump ran, but the write fence could not be /);
      expect(registryA().fleetRestoreError.text).toContain(r.error.slice('Restored, but '.length, r.error.indexOf(' (see manager logs)')));
      expect(pg.events).toContain('start:w');
    },
  },
  {
    id: 'C54 notice clear fails', setup: () => { pg.clearFails = true; },
    check: r => { expect(r.success).toBe(true); expect(r.warning).toMatch(/the notice that this restore had not finished could not be cleared/); expect(registryA().fleetRestoreError.text).toMatch(PENDING); },
  },
  {
    id: 'C56 a sharer does not start', setup: () => { pg.startFails.w = 'no such image'; },
    check: r => { expect(r.success).toBe(true); expect(r.warning).toBe('these instances were stopped and could not be restarted: w (start them by hand)'); },
  },
];

describe('the restore lane, one row per cell', () => {
  it.each(ROWS)('$id', async (row) => {
    let release: () => void = () => {};
    let held: Promise<void> | null = null;
    if (row.id.startsWith('C5 ')) held = containerManager.withExternalBotOp('w', 'update', () => new Promise<void>(r => { release = r; }));
    row.setup?.();
    const r = await restore(row.file);
    release();
    await held;
    row.check(r);
    expect(containerManager.isBotBusy('a')).toBeNull();
    expect(fleetBackupGuards.isFleetBackupBusy('a')).toBe(false);
    expect(pg.events).not.toContain('startInOp:a');
    expect(pg.events).not.toContain('start:a');
  });

  it('C4 self holds another op: T1, nothing changed', async () => {
    let release: () => void = () => {};
    const held = containerManager.withExternalBotOp('a', 'start', () => new Promise<void>(r => { release = r; }));
    const r = await restore();
    release();
    await held;
    expect(r.error).toBe("Operation 'start' is running on this bot; wait for it before restoring a dump (nothing was changed)");
    expect(pg.events).toEqual([]);
  });

  it('C57 a throw inside the lane lifts the fence, releases and ends the lock', async () => {
    pg.at.dump = () => { pg.throwLive = 'w'; };
    await expect(restore()).rejects.toThrow(/docker ps crashed for w/);
    expect(at('lift')).toBeGreaterThan(at('fence'));
    expect(containerManager.isBotBusy('a')).toBeNull();
    expect(fleetBackupGuards.isFleetBackupBusy('a')).toBe(false);
    expect(containerManager.databaseHoldRefusal('w', 'Start')).toBeNull();
  });
});

describe('the named rows', () => {
  it('R-ORDER: guard, fence, dump, drop, restore, raise, lift, notice clear, sharer start; self untouched', async () => {
    let noticeAtLift: unknown = 'unread';
    pg.at.lift = () => { noticeAtLift = registryA().fleetRestoreError?.text; };
    const r = await restore();
    expect(r.success).toBe(true);
    const order = pg.events.filter(e => ['fence', 'dump', 'drop', 'pg_restore', 'raise', 'lift', 'start:w'].includes(e));
    expect(order).toEqual(['fence', 'dump', 'drop', 'pg_restore', 'raise', 'lift', 'start:w']);
    for (const e of ['stop:a', 'stopInOp:a', 'startInOp:a', 'start:a']) expect(pg.events).not.toContain(e);
    expect(noticeAtLift).toMatch(PENDING);
    expect(registryA().fleetRestoreError).toBeUndefined();
    expect(r.steps.botState).toBe('maintenance');
    expect(r.steps.claimRaisedTo).toBe(8);
    expect(JSON.parse(pg.floorAtDrop ?? 'null')).toEqual({ claim: 7 });
    expect((pg.noticeAtDrop as any).text).toMatch(PENDING);
    expect((pg.noticeAtDrop as any).text).toContain(`the pre-restore dump is ${r.steps.preRestoreDump}`);
  });

  it('R-FLOOR: F is the higher of the file and the live database', async () => {
    fs.writeFileSync(FLOOR, '{"claim":9}');
    claimDb.raise = 'seq|10\nguild|g1\n';
    const r = await restore();
    expect(r.success).toBe(true);
    expect(claimDb.raiseSql[0]).toContain('SET claim = 10');
    expect(claimDb.raiseSql[0]).toContain('WHERE claim <= 9');
    expect(r.steps.claimFloor).toBe(9);
    expect(floorFile()).toEqual({ claim: 9 });
  });

  it('R-RUNNING-NOTICE: after a failed pg_restore, Running is refused with R13', async () => {
    pg.restoreCode = 1;
    await restore();
    const before = JSON.stringify(registryA().maintenance);
    const admission = await maintenance.orderMaintenance('a', 'running', '', () => {});
    expect(admission).toEqual({ accepted: false, status: 409, error: 'A restore of old.dump has not finished cleanly (its notice is on the Database window), so Running was refused and nothing was changed; restore a dump again, or dismiss the notice to choose Running anyway' });
    expect(JSON.stringify(registryA().maintenance)).toBe(before);
  });

  it('R-OFF: an Off bot that runs is stopped under the lock and never started', async () => {
    writeRegistry(OFF);
    const r = await restore();
    expect(r.success).toBe(true);
    expect(r.steps.botState).toBe('off');
    expect(r.steps.stopped).toContain('a');
    expect(r.steps.restarted).not.toContain('a');
    expect(pg.events).toContain('stopInOp:a');
    expect(pg.events.filter(e => /^(start|startInOp):a$/.test(e))).toEqual([]);
  });

  it('R-OFF: a record that says stopped while docker runs it is stopped by name', async () => {
    writeRegistry(OFF);
    pg.stopInOpNotRunning = true;
    const r = await restore();
    expect(r.success).toBe(true);
    expect(pg.events).toContain('docker-stop:bot-a-app');
    expect(r.steps.stopped).toContain('a');
  });

  it('R-STAYS (M1): the maintenance record, the login and the bot are left as they were', async () => {
    const r = await restore();
    expect(r.success).toBe(true);
    expect(JSON.stringify(registryA().maintenance)).toBe(JSON.stringify(MAINTAINED.maintenance));
    expect(pg.sql.filter(s => /ALTER ROLE/.test(s))).toEqual([]);
    expect(claimDb.loginReads).toBe(1);
    expect(pg.hooks).toEqual([]);
  });

  it('a refusal at the guard on an Off bot whose sidecar this lane started stops it again', async () => {
    writeRegistry({ ...OFF, maintenance: { ...OFF.maintenance, settled: false } });
    pg.sidecar = false;
    const r = await restore();
    expect(r.success).toBe(false);
    expect(pg.events).toEqual(['sidecar-up', 'docker-stop:bot-a-postgres']);
  });
});

describe('R-NOTICE: a throw past the notice leaves N-PENDING in the registry', () => {
  it.each(['drop', 'pg_restore', 'raise', 'lift'])('throw at %s', async (point) => {
    if (point === 'raise') claimDb.onRaise = () => { throw new Error('docker crashed at raise'); };
    else pg.throwAt = point;
    await restore().catch(() => {});
    expect(registryA().fleetRestoreError.text).toMatch(PENDING);
    expect(containerManager.isBotBusy('a')).toBeNull();
  });
});

describe('X rows: the durable state a manager restart would read between durable effects', () => {
  type Snap = { lock: boolean; fence: boolean; notice: string | null; floor: unknown; dropped: boolean; restored: boolean; raised: boolean };
  const snapshot = (): Snap => ({
    lock: fs.existsSync(OPS) && /"restore"/.test(fs.readFileSync(OPS, 'utf-8')),
    fence: fenceOwners.has('bot-a-postgres'),
    notice: registryA().fleetRestoreError?.text ?? null,
    floor: floorFile(),
    dropped: dropped(),
    restored: pg.events.includes('pg_restore'),
    raised: claimDb.raiseSql.length > 0,
  });
  const rows: Array<[string, (take: () => void) => void, Partial<Snap>]> = [
    ['X1 between the lock record and the fence', take => { claimDb.onToc = take; }, { lock: true, fence: false, notice: null, dropped: false }],
    ['X1b between the first notice and the fence', take => { let once = false; pg.at.notice = () => { if (!once) { once = true; take(); } }; }, { lock: true, fence: false, dropped: false }],
    ['X2 between the fence and the notice rewrite', take => { pg.at.dump = take; }, { lock: true, fence: true, dropped: false }],
    ['X3 between the notice and the restore', take => { pg.at.drop = take; }, { fence: true, floor: { claim: 7 }, restored: false }],
    ['X4 between the restore and the raise', take => { claimDb.onRaise = take; }, { fence: true, restored: true, raised: false }],
    ['X5 between the raise and the lift', take => { pg.at.lift = take; }, { fence: true, raised: true }],
    ['X6 between the lift and the notice clear', take => { pg.at.clear = take; }, { fence: false, raised: true }],
    ['X8 between the notice clear and the sharer starts', take => { pg.at['start:w'] = take; }, { lock: true, fence: false, notice: null }],
  ];
  it.each(rows)('%s', async (name, hook, want) => {
    let snap: Snap | null = null;
    hook(() => { snap = snapshot(); });
    const r = await restore();
    expect(r.success).toBe(true);
    expect(snap).toMatchObject(want);
    if (['X3', 'X4', 'X5', 'X6'].includes(name.slice(0, 2))) expect(snap!.notice).toMatch(PENDING);
    if (name.startsWith('X1b') || name.startsWith('X2 ')) expect(snap!.notice).toBe(FIRST_NOTICE);
  });
});

describe('NM4 round 1 fixes', () => {
  const PRIOR = { file: 'older.dump', text: 'Restore of older.dump failed: pg_restore exited with code 1', at: '2026-10-27T10:00:00.000Z' };

  it('N1: after a failed pg_restore, Maintenance settles under the kept fence and a retry restores and lifts it', async () => {
    pg.restoreCode = 1;
    expect((await restore()).success).toBe(false);
    pg.restoreCode = 0;
    const order = await maintenance.runMaintenanceOrder('a', 'maintenance', 'new');
    expect(order.text).not.toMatch(/live copy in recovery/);
    expect(order.settled).toBe(true);
    expect(registryA().maintenance).toMatchObject({ state: 'maintenance', message: 'new', settled: true, login: 'blocked' });
    expect(pg.sql.filter(s => s.includes('ALTER ROLE "app" NOLOGIN')).every(s => s.includes('PGOPTIONS=-c default_transaction_read_only=off'))).toBe(true);
    const retry = await restore();
    expect(retry.success).toBe(true);
    expect(fenceOwners.has('bot-a-postgres')).toBe(false);
  });

  it('N1: Running is refused while the read-only layer is on, even with the notice dismissed', async () => {
    pg.restoreCode = 1;
    await restore();
    fleetBackup.dismissFleetRestoreError('a');
    const before = JSON.stringify(registryA().maintenance);
    const admission = await maintenance.orderMaintenance('a', 'running', '', () => {});
    expect(admission).toMatchObject({ accepted: false, status: 409 });
    expect((admission as any).error).toMatch(R13_FENCE);
    expect(JSON.stringify(registryA().maintenance)).toBe(before);
  });

  it('N2: a lift that does not end lifted keeps a notice, and Running is refused', async () => {
    pg.liftFails = true;
    const r = await restore();
    expect(r.steps.restored).toBe(true);
    expect(registryA().fleetRestoreError.text).toMatch(/^Restore of old\.dump ran, but /);
    const admission = await maintenance.orderMaintenance('a', 'running', '', () => {});
    expect(admission).toMatchObject({ accepted: false, status: 409 });
  });

  it('N2: a refusal before the drop whose lift does not end lifted keeps a notice for the stuck fence', async () => {
    pg.existsFails = true;
    pg.liftFails = true;
    const r = await restore();
    expect(r.success).toBe(false);
    expect(dropped()).toBe(false);
    expect(registryA().fleetRestoreError.text).toMatch(/^Restore of old\.dump was refused before the database was dropped, so its data is unchanged, but the write fence could not be /);
  });

  it('N2: a refusal before the drop whose lift ends lifted puts back the notice that stood before', async () => {
    writeRegistry({ ...MAINTAINED, fleetRestoreError: PRIOR });
    pg.existsFails = true;
    const r = await restore();
    expect(r.success).toBe(false);
    expect(registryA().fleetRestoreError).toEqual(PRIOR);
  });

  it('N2: a failed rewrite at P17 keeps the first notice and does not refuse', async () => {
    pg.at.dump = () => { pg.saveFails = true; };
    const r = await restore();
    expect(r.success).toBe(true);
    expect((pg.noticeAtDrop as any).text).toBe(FIRST_NOTICE);
  });

  it('N3: every notice carries the time it was written', async () => {
    let first: any = null;
    pg.at.notice = () => { first ??= registryA().fleetRestoreError; };
    pg.restoreCode = 1;
    await restore();
    expect(first.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect((pg.noticeAtDrop as any).at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(registryA().fleetRestoreError.at).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('N3: Dismiss refuses while the bot holds an op, and keeps a newer notice than the one shown', async () => {
    writeRegistry({ ...MAINTAINED, fleetRestoreError: PRIOR });
    let release: () => void = () => {};
    const held = containerManager.withExternalBotOp('a', 'restore', () => new Promise<void>(r => { release = r; }));
    const busy = fleetBackup.dismissShownRestoreNotice('a', PRIOR.at);
    release();
    await held;
    expect(busy).toEqual({ dismissed: false, error: 'A restore of this bot is running; dismiss its notice when it ends' });
    expect(fleetBackup.dismissShownRestoreNotice('a', '2026-10-26T10:00:00.000Z')).toEqual({ dismissed: false, error: NEWER });
    expect(registryA().fleetRestoreError).toEqual(PRIOR);
    expect(fleetBackup.dismissShownRestoreNotice('a', PRIOR.at)).toEqual({ dismissed: true });
    expect(registryA().fleetRestoreError).toBeUndefined();
  });

  it('N4: a notice the registry could not save is dropped once the bot has no database record', async () => {
    pg.at.pg_restore = () => { pg.saveFails = true; };
    pg.restoreCode = 1;
    await restore();
    expect(fleetBackup.getFleetRestoreError('a')).toMatch(/is not saved and a manager restart drops it/);
    pg.saveFails = false;
    writeRegistry({ ...MAINTAINED, fleetDb: undefined });
    expect(fleetBackup.getFleetRestoreError('a')).toBeNull();
    writeRegistry();
    expect(fleetBackup.getFleetRestoreError('a')).toBeNull();
  });
});

describe('NM4 round 2 fixes', () => {
  const PRIOR = { file: 'older.dump', text: 'Restore of older.dump failed: pg_restore exited with code 1', at: '2026-10-27T10:00:00.000Z', doubt: true };

  it('R1: a refusal before the drop whose lift does not end lifted adds its text to the notice that stood before', async () => {
    writeRegistry({ ...MAINTAINED, fleetRestoreError: PRIOR });
    pg.existsFails = true;
    pg.liftFails = true;
    const r = await restore();
    expect(r.success).toBe(false);
    expect(dropped()).toBe(false);
    const notice = registryA().fleetRestoreError;
    expect(notice.text).toMatch(/^Restore of older\.dump failed: pg_restore exited with code 1\. Then a restore of old\.dump was refused before the database was dropped, but the write fence could not be lifted live: /);
    expect(notice.text).not.toMatch(/unchanged/);
    expect(notice.text).not.toMatch(/dismiss this notice/);
    expect(notice.text).toMatch(/; restart the instance, then restore a dump again$/);
    expect(notice.file).toBe(PRIOR.file);
  });

  it('R1: a refusal before the drop whose lift is held by another lane gives no dismissal step on the notice that stood before', async () => {
    writeRegistry({ ...MAINTAINED, fleetRestoreError: PRIOR });
    pg.existsFails = true;
    pg.at.fence = () => { fenceOwners.set('bot-a-postgres', 'reseed:1793181600000'); pg.showOn = true; };
    expect((await restore()).success).toBe(false);
    const notice = registryA().fleetRestoreError;
    expect(notice.text).toMatch(/^Restore of older\.dump failed: pg_restore exited with code 1\. Then a restore of old\.dump was refused before the database was dropped, but .* re-seed/);
    expect(notice.text).not.toMatch(/dismiss this notice/);
  });

  it('R1: the merged notice takes a new time, so a Dismiss of the earlier notice is refused and the notice stays', async () => {
    writeRegistry({ ...MAINTAINED, fleetRestoreError: PRIOR });
    pg.existsFails = true;
    pg.liftFails = true;
    await restore();
    const notice = registryA().fleetRestoreError;
    expect(notice.at).not.toBe(PRIOR.at);
    expect(fleetBackup.dismissShownRestoreNotice('a', PRIOR.at)).toEqual({ dismissed: false, error: 'A newer restore notice replaced the one shown, so it was kept; read it, then dismiss it again' });
    expect(registryA().fleetRestoreError).toEqual(notice);
  });

  it('R1: the earlier notice held in memory is kept too, without its unsaved mark once it is saved', async () => {
    pg.at.pg_restore = () => { pg.saveFails = true; };
    pg.restoreCode = 1;
    await restore();
    const earlier = fleetBackup.getFleetRestoreError('a')!;
    expect(earlier).toMatch(/ \(this notice is not saved and a manager restart drops it\)$/);
    pg.at = {};
    pg.saveFails = false;
    pg.restoreCode = 0;
    pg.existsFails = true;
    pg.liftFails = true;
    expect((await restore()).success).toBe(false);
    const notice = registryA().fleetRestoreError;
    expect(notice.text.startsWith(`${earlier.replace(' (this notice is not saved and a manager restart drops it)', '')}. Then a restore of old.dump was refused before the database was dropped, but `)).toBe(true);
    expect(notice.text).not.toMatch(/unchanged|is not saved/);
  });

  it('T1: a second refusal before the drop after one that left no doubt writes its own notice with one last step', async () => {
    pg.existsFails = true;
    pg.liftFails = true;
    expect((await restore()).success).toBe(false);
    expect(registryA().fleetRestoreError.doubt).toBe(false);
    expect((await restore()).success).toBe(false);
    const notice = registryA().fleetRestoreError;
    expect(notice.text).toMatch(/^Restore of old.dump was refused before the database was dropped, so its data is unchanged, but /);
    expect(notice.text).not.toMatch(/Then a restore/);
    expect(notice.text).not.toMatch(/dismiss this notice.*restore a dump again/);
    expect(notice.text.match(/; restart the instance, then /g)).toHaveLength(1);
    expect(notice.doubt).toBe(false);
  });

  it('T1: a notice that is itself a merge merges again on the next refusal before the drop', async () => {
    writeRegistry({ ...MAINTAINED, fleetRestoreError: PRIOR });
    pg.existsFails = true;
    pg.liftFails = true;
    await restore();
    const merged = registryA().fleetRestoreError;
    expect(merged.doubt).toBe(true);
    await restore();
    const notice = registryA().fleetRestoreError;
    expect(notice.text.startsWith(`${merged.text}. Then a restore of old.dump was refused before the database was dropped, but `)).toBe(true);
    expect(notice.text).not.toMatch(/dismiss this notice/);
    expect(notice.doubt).toBe(true);
  });

  it('R3: a refusal before the drop whose lift finds the volume gone does not say the data is unchanged', async () => {
    pg.existsFails = true;
    pg.liftFails = true;
    pg.volumeGone = true;
    expect((await restore()).success).toBe(false);
    expect(registryA().fleetRestoreError.text).toBe("Restore of old.dump was refused before the database was dropped, but the database volume bot-a-pgdata is gone now, so this manager can't confirm that the data exists; with the bot in Maintenance or Off, restore a dump again");
  });

  it('R4: Dismiss of a notice that has no time clears it, whatever the page sent', () => {
    const { at: _at, ...old } = PRIOR;
    writeRegistry({ ...MAINTAINED, fleetRestoreError: old });
    expect(fleetBackup.dismissShownRestoreNotice('a', '')).toEqual({ dismissed: true });
    expect(registryA().fleetRestoreError).toBeUndefined();
    writeRegistry({ ...MAINTAINED, fleetRestoreError: old });
    expect(fleetBackup.dismissShownRestoreNotice('a', '2026-10-26T10:00:00.000Z')).toEqual({ dismissed: true });
    expect(registryA().fleetRestoreError).toBeUndefined();
  });
});

describe('NM4 round 5 fixes', () => {
  const PRIOR = { file: 'older.dump', text: 'Restore of older.dump failed: pg_restore exited with code 1', at: '2026-10-27T10:00:00.000Z' };

  it('U1: a notice with no doubt field is merged onto by a refusal before the drop and gives no dismissal step', async () => {
    writeRegistry({ ...MAINTAINED, fleetRestoreError: PRIOR });
    pg.existsFails = true;
    pg.liftFails = true;
    expect((await restore()).success).toBe(false);
    const notice = registryA().fleetRestoreError;
    expect(notice.text).toMatch(/^Restore of older\.dump failed: pg_restore exited with code 1\. Then a restore of old\.dump was refused before the database was dropped, but /);
    expect(notice.text).not.toMatch(/unchanged|dismiss this notice/);
    expect(notice.file).toBe(PRIOR.file);
    expect(notice.doubt).toBe(true);
  });

  it('U2: a notice from a refusal whose lift found the volume gone is merged onto by a later refusal', async () => {
    pg.existsFails = true;
    pg.liftFails = true;
    pg.volumeGone = true;
    await restore();
    const first = registryA().fleetRestoreError;
    expect(first.doubt).toBe(true);
    pg.volumeGone = false;
    await restore();
    const notice = registryA().fleetRestoreError;
    expect(notice.text.startsWith(`${first.text.replace(/\.$/, '')}. Then a restore of old.dump was refused before the database was dropped, but `)).toBe(true);
    expect(notice.text).not.toMatch(/unchanged|dismiss this notice/);
  });

  it('U2: a notice from a restore that ran with the volume gone at the lift is merged onto by a later refusal', async () => {
    pg.liftFails = true;
    pg.at.pg_restore = () => { pg.volumeGone = true; };
    await restore();
    const first = registryA().fleetRestoreError;
    expect(first.text).toMatch(/^Restore of old\.dump ran, but .*gone/);
    expect(first.doubt).toBe(true);
    pg.at = {};
    pg.volumeGone = false;
    pg.existsFails = true;
    await restore();
    const notice = registryA().fleetRestoreError;
    expect(notice.text.startsWith(`${first.text.replace(/\.$/, '')}. Then a restore of old.dump was refused before the database was dropped, but `)).toBe(true);
    expect(notice.text).not.toMatch(/unchanged|dismiss this notice/);
  });
});

describe('NM4 round 6 fixes', () => {
  const PRIOR = { file: 'older.dump', text: 'Restore of older.dump failed: pg_restore exited with code 1', at: '2026-10-27T10:00:00.000Z', doubt: true };

  it('V2: a failed put-back keeps the notice that stood before in memory, and a Dismiss of the pending notice does not admit Running', async () => {
    writeRegistry({ ...MAINTAINED, fleetRestoreError: PRIOR });
    pg.existsFails = true;
    pg.at.notice = () => { pg.saveFails = true; };
    const r = await restore();
    pg.at = {};
    pg.saveFails = false;
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/; the earlier restore notice is shown, but only this manager's memory holds it: after a manager restart, the notice that this restore of old.dump had not finished stands instead$/);
    const pending = registryA().fleetRestoreError;
    expect(pending.at).not.toBe(PRIOR.at);
    expect(fleetBackup.getFleetRestoreError('a')).toBe(`${PRIOR.text} (this notice is not saved and a manager restart drops it)`);
    expect(fleetBackup.dismissShownRestoreNotice('a', pending.at)).toMatchObject({ dismissed: false });
    const admission = await maintenance.orderMaintenance('a', 'running', '', () => {});
    expect(admission).toMatchObject({ accepted: false, status: 409 });
  });

  it('W1: after a failed put-back with the earlier notice standing, the Running refusal names its file', async () => {
    writeRegistry({ ...MAINTAINED, fleetRestoreError: PRIOR });
    pg.existsFails = true;
    pg.at.notice = () => { pg.saveFails = true; };
    await restore();
    pg.at = {};
    pg.saveFails = false;
    const admission = await maintenance.orderMaintenance('a', 'running', '', () => {});
    expect(admission).toEqual({ accepted: false, status: 409, error: 'A restore of older.dump has not finished cleanly (its notice is on the Database window), so Running was refused and nothing was changed; restore a dump again, or dismiss the notice to choose Running anyway' });
  });

  it('W2: after a failed put-back the reply names the notice a manager restart brings back', async () => {
    writeRegistry({ ...MAINTAINED, fleetRestoreError: PRIOR });
    pg.existsFails = true;
    pg.at.notice = () => { pg.saveFails = true; };
    const r = await restore();
    pg.at = {};
    pg.saveFails = false;
    expect(r.error).toMatch(/; the earlier restore notice is shown, but only this manager's memory holds it: after a manager restart, the notice that this restore of old\.dump had not finished stands instead$/);
    expect(r.error).not.toMatch(/again/);
  });

  it('V2: with no notice before the restore, a failed put-back keeps its current reply', async () => {
    pg.existsFails = true;
    pg.clearFails = true;
    const r = await restore();
    pg.clearFails = false;
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/; the notice that this restore had not finished could not be removed \(dismiss it on the Database window\)$/);
  });
});

describe('Y rows: actions while a restore is held at pg_restore', () => {
  const holdAtRestore = async () => {
    let open: () => void = () => {};
    pg.restoreGate = new Promise<void>(r => { open = r; });
    const running = restore();
    await vi.waitFor(() => expect(pg.events).toContain('pg_restore'));
    return { running, open };
  };

  it('Y2 a second restore answers T1 with the op restore', async () => {
    const { running, open } = await holdAtRestore();
    const second = await restore();
    open();
    expect((await running).success).toBe(true);
    expect(second.error).toBe("Operation 'restore' is running on this bot; wait for it before restoring a dump (nothing was changed)");
  });

  it('Y3 a state order is refused with the restore named', async () => {
    const { running, open } = await holdAtRestore();
    const admission = await maintenance.orderMaintenance('a', 'running', '', () => {});
    open();
    await running;
    expect(admission).toEqual({ accepted: false, status: 409, error: "Operation 'restore' already in progress" });
  });

  it('Y6 the reconciler skips the bot', async () => {
    const { running, open } = await holdAtRestore();
    const reads = claimDb.loginReads;
    await maintenance.reconcileMaintenance();
    const after = claimDb.loginReads;
    open();
    await running;
    expect(after).toBe(reads);
    expect(pg.hooks).toEqual([]);
  });

  it('Y7 the scheduled dump finds the backup slot taken', async () => {
    const { running, open } = await holdAtRestore();
    const claimed = fleetBackupGuards.claimFleetBackupBusy('a');
    open();
    await running;
    expect(claimed).toBe(false);
  });
});
