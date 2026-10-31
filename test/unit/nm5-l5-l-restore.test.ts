import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-l5-l-restore-'));
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
  argv: [] as string[][],
  cert: '' as string,
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
    if (sql.includes('server.crt')) return cb(null, pg.cert, '');
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
  const innerExecFile = (await import('./fence-fake')).withFence(fakes.withRestoreFakes(execFile as any));
  const fencedExecFile = ((cmd: string, args: string[], a: unknown, b?: unknown) => { pg.argv.push([...args]); return (innerExecFile as any)(cmd, args, a, b); }) as any;
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
    stopInOpFails: null, stopInOpNotRunning: false, throwLive: null, throwAt: null, restoreGate: null, at: {}, hooks: [], noticeAtDrop: undefined, floorAtDrop: null, volumeGone: false, showOn: false, switchWriteFails: null, argv: [], cert: '',
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
const LIVE = { generation: 5, machine: 'old.example', since: '2026-10-20T10:00:00Z' };
const raisedTo = (g: number, machine = 'a') => `VALUES (true, '${machine}', ${g}, now())`;
const notice = () => registryA().fleetDb.switchNotice;

import { addressTableSql } from '../../src/instance/fleetReplication';
import { cutAddressesSql, GEN_READ_SQL, machineNameOf, OWN_COPIES_READ_SQL, raiseSql, RESTORE_STATE_CLEAR, receiveMarkClearSql } from '../../src/instance/switchSql';

const MOVED = 'moved-2026-10-30T12-00-00-000Z.dump';
const BROKEN = { pushBroken: { at: '2026-10-30T09:00:00.000Z', safetyDump: 'pre-receive-x.dump' } };
const REPL = { role: 'replicator', password: 'pw', hostPort: 5434, publicHost: 'main.example', certHost: 'main.example' };
const EXEMPT = ['exec', '-e', 'PGOPTIONS=-c default_transaction_read_only=off'];
const ON_POSTGRES = ['psql', '-U', 'dbm_admin', '-d', 'postgres', '-tAq', '-v', 'ON_ERROR_STOP=1', '-c'];
const ON_APP = ['bot-a-postgres', 'psql', '-U', 'dbm_admin', '-d', 'app', '-tA', '-v', 'ON_ERROR_STOP=1', '-c'];
const callsWith = (part: string) => pg.argv.filter(a => a.join(' ').includes(part));
const errors = async (run: () => Promise<unknown>) => {
  const seen: string[] = [];
  const err = vi.spyOn(console, 'error').mockImplementation((m: unknown) => { seen.push(String(m)); });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try { await run(); } finally { err.mockRestore(); warn.mockRestore(); }
  return seen;
};

describe('the restore lane calls psql with the argv it means', () => {
  it('the restore record is kept before the drop in the exempt session on postgres, and cleared on postgres after', async () => {
    claimDb.generation = LIVE;
    expect((await restore()).success).toBe(true);
    const upsert = callsWith('INSERT INTO smdb_manager.restore_state');
    expect(upsert).toHaveLength(1);
    expect(upsert[0].slice(0, -1)).toEqual([...EXEMPT, 'bot-a-postgres', ...ON_POSTGRES]);
    expect(callsWith('UPDATE smdb_manager.restore_state SET pending = false')).toEqual([['exec', 'bot-a-postgres', ...ON_POSTGRES, RESTORE_STATE_CLEAR]]);
  });
  it('both generation reads run outside the exempt session; the raise runs inside it', async () => {
    claimDb.generation = LIVE;
    expect((await restore()).success).toBe(true);
    const reads = pg.argv.filter(a => a[a.length - 1] === GEN_READ_SQL);
    expect(reads).toEqual([['exec', ...ON_APP, GEN_READ_SQL], ['exec', ...ON_APP, GEN_READ_SQL]]);
    const write = callsWith('INSERT INTO smdb_manager.generation');
    expect(write).toHaveLength(1);
    expect(write[0].slice(0, -1)).toEqual([...EXEMPT, ...ON_APP]);
  });
  it('a moved- restore reads its own copies outside the exempt session', async () => {
    fs.writeFileSync(path.join(DIR, MOVED), 'dump');
    claimDb.generation = LIVE;
    expect((await restore(MOVED)).success).toBe(true);
    expect(pg.argv.filter(a => a[a.length - 1] === OWN_COPIES_READ_SQL)).toEqual([['exec', ...ON_APP, OWN_COPIES_READ_SQL]]);
  });
  it('the receive mark is removed on postgres with no id after pushBroken is cleared', async () => {
    writeRegistry({ ...MAINTAINED, fleetDb: { ...primary, ...BROKEN } });
    claimDb.generation = LIVE;
    expect((await restore()).success).toBe(true);
    expect(callsWith('DELETE FROM smdb_manager.receive_mark')).toEqual([['exec', 'bot-a-postgres', ...ON_POSTGRES, receiveMarkClearSql(null)]]);
  });
});

describe('the restore lane logs only what failed', () => {
  it('a clean restore over pushBroken logs no failed clear and no failed mark removal', async () => {
    writeRegistry({ ...MAINTAINED, fleetDb: { ...primary, ...BROKEN } });
    claimDb.generation = LIVE;
    const seen = await errors(async () => expect((await restore()).success).toBe(true));
    expect(seen.filter(m => m.includes('Could not mark the restore') || m.includes('the restore finished, but'))).toEqual([]);
  });
  it('the pushBroken clear throws: the operator reads why in the log', async () => {
    writeRegistry({ ...MAINTAINED, fleetDb: { ...primary, ...BROKEN } });
    claimDb.generation = LIVE;
    pg.switchWriteFails = 'EACCES: permission denied';
    const seen = await errors(() => restore());
    expect(seen).toContain('[Switch] a: the restore finished, but the mark of an unfinished push could not be cleared (EACCES: permission denied)');
    expect(claimDb.genEvents).not.toContain('mark-clear');
  });
});

describe('a generation row that does not parse is quoted trimmed', () => {
  it('the live row before the drop', async () => {
    claimDb.generation = { generation: 'x' as unknown as number, machine: 'm', since: null };
    const r = await restore();
    expect(r.error).toBe("Could not read the database's generation before the restore, so the restore was refused, and nothing was changed: it answered 'x|m|'");
    expect(claimDb.dropSeen).toBe(false);
  });
  it('the restore record the upsert answers', async () => {
    claimDb.generation = LIVE;
    claimDb.restoreState = { pending: false, file: 'p.dump', generation: NaN, machine: 'm', since: null };
    const r = await restore();
    expect(r.error).toBe("The database's generation could not be kept before the drop, so the restore was refused, and nothing was changed: it answered 'NaN|m|'");
    expect(claimDb.dropSeen).toBe(false);
  });
  it('the restored row after the drop', async () => {
    claimDb.generation = LIVE;
    claimDb.restoredGeneration = { generation: 'x' as unknown as number, machine: 'm', since: null };
    const r = await restore();
    expect(r.success).toBe(false);
    expect(r.error).toContain("The dump was restored, but the generation row could not be written back (the restored row read back as 'x|m|').");
    expect(claimDb.genWrites).toEqual([]);
  });
});

describe('the address rows a moved- restore writes', () => {
  const machine = () => machineNameOf(containerManager.getBot('a')!);
  const lastWrite = () => { const w = callsWith('INSERT INTO smdb_manager.generation'); return w[w.length - 1][w[w.length - 1].length - 1]; };
  it('without replication: the cut alone', async () => {
    fs.writeFileSync(path.join(DIR, MOVED), 'dump');
    claimDb.generation = LIVE;
    const r = await restore(MOVED);
    expect(r.success).toBe(true);
    expect(lastWrite()).toBe(raiseSql(machine(), 6, cutAddressesSql(null)));
  });
  it('with replication: the cut keeps this machine and its address row is written back with its certificate', async () => {
    fs.writeFileSync(path.join(DIR, MOVED), 'dump');
    writeRegistry({ ...MAINTAINED, fleetDb: { ...primary, replication: REPL } });
    claimDb.generation = LIVE;
    pg.cert = COPY_PEM;
    const r = await restore(MOVED);
    expect(r.success).toBe(true);
    const own = { host: 'main.example', port: 5434 };
    expect(lastWrite()).toBe(raiseSql(machine(), 6, `${cutAddressesSql(own)}${addressTableSql(own.host, own.port, COPY_PEM.trim(), machine(), null)}`));
  });
  it('with replication and no readable certificate: the generation write is refused with the reason', async () => {
    fs.writeFileSync(path.join(DIR, MOVED), 'dump');
    writeRegistry({ ...MAINTAINED, fleetDb: { ...primary, replication: REPL } });
    claimDb.generation = LIVE;
    const r = await restore(MOVED);
    expect(r.success).toBe(false);
    expect(r.error).toContain("The dump was restored, but the generation row could not be written back (this database's certificate could not be read for its address row).");
    expect(claimDb.genWrites).toEqual([]);
  });
});
