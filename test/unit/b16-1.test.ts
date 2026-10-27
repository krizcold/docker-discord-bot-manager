import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b16-1-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

// Every docker step the restore takes, in order, and the answers the fake database gives.
const pg = vi.hoisted(() => ({
  events: [] as string[],
  sql: [] as string[],
  urls: {} as Record<string, string>,
  live: {} as Record<string, string[] | null>,
  tables: 't|t' as string,
  probeFails: false,
  liveTerm: '7',
  guilds: 'g1\ng2\n',
  raiseFails: false,
  restoreCode: 0,
  saveFails: false,
  restoreGate: null as Promise<void> | null,
  noticeAtDrop: undefined as unknown,
  floorAtDrop: null as string | null,
}));

vi.mock('../../src/config/appCapabilities', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/config/appCapabilities')>();
  return { ...real, findAppCapabilities: () => ({ companionDb: { env: { url: 'DATABASE_URL' } } }) };
});
vi.mock('../../src/env/manager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/env/manager')>();
  return {
    ...real,
    getEnvVarsWithStatus: (id: string) => ({ vars: { DATABASE_URL: pg.urls[id] ?? '' }, corrupt: false, undecryptable: [] }),
    getEnvVars: (id: string) => ({ DATABASE_URL: pg.urls[id] ?? '' }),
  };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return {
    ...real,
    runningInstanceContainers: async (id: string) => (id in pg.live ? pg.live[id] : []),
    startFleetDbSidecar: async () => { pg.events.push('sidecar-up'); return { success: true }; },
    stopBot: async (id: string) => { pg.events.push(`stop:${id}`); pg.live[id] = []; return { success: true }; },
    startBot: async (id: string) => { pg.events.push(`start:${id}`); return { success: true }; },
    updateInstanceFleetRestoreError: (botId: string, notice: { file: string; text: string } | null) => {
      if (pg.saveFails) throw new Error('ENOSPC: no space left on device');
      return real.updateInstanceFleetRestoreError(botId, notice);
    },
  };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = require('events') as typeof import('events');
  const { PassThrough } = require('stream') as typeof import('stream');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const execFile = vi.fn((_cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (err: Error | null, stdout: string, stderr: string) => void;
    const sql = args.join(' ');
    pg.sql.push(sql);
    const fail = (text: string) => cb(new Error(text), '', `ERROR:  ${text}`);
    if (args[0] === 'inspect') return cb(null, 'true\n', '');
    if (args[0] === 'stop') { pg.events.push(`docker-stop:${args[1]}`); return cb(null, '', ''); }
    if (sql.includes('ALTER SYSTEM SET default_transaction_read_only = on')) { pg.events.push('fence'); return cb(null, '0\n', ''); }
    if (sql.includes('ALTER SYSTEM RESET')) { pg.events.push('lift'); return cb(null, '', ''); }
    if (sql.includes('SHOW default_transaction_read_only')) return cb(null, 'off\n', '');
    if (sql.includes('FROM pg_database WHERE datname')) return cb(null, '1\n', '');
    if (sql.includes("to_regclass('smdb_control.term')")) return pg.probeFails ? fail('connection reset') : cb(null, `${pg.tables}\n`, '');
    if (sql.includes('SELECT coalesce(GREATEST(')) return cb(null, `${pg.liveTerm}\n`, '');
    if (sql.includes("to_regclass('smdb_data.guild_ownership')")) return cb(null, 't\n', '');
    if (sql.includes('UPDATE smdb_data.guild_ownership')) {
      pg.events.push('raise');
      return pg.raiseFails ? fail('permission denied for table guild_ownership') : cb(null, pg.guilds, '');
    }
    if (sql.includes('UPDATE smdb_control.term')) { pg.events.push('term'); return cb(null, '1\n', ''); }
    if (sql.includes('DROP DATABASE')) {
      pg.events.push('drop');
      const registry = JSON.parse(nodeFs.readFileSync(nodePath.join(tmp.dir, 'instances.json'), 'utf-8'));
      pg.noticeAtDrop = registry.instances.a.fleetRestoreError;
      const floorFile = nodePath.join(tmp.dir, 'backups', 'a', 'fleet-postgres', 'term-floor.json');
      pg.floorAtDrop = nodeFs.existsSync(floorFile) ? nodeFs.readFileSync(floorFile, 'utf-8') : null;
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
    pg.events.push(isDump ? 'dump' : 'pg_restore');
    const code = isDump ? 0 : pg.restoreCode;
    void (async () => {
      if (!isDump && pg.restoreGate) await pg.restoreGate;
      setTimeout(() => {
        child.stdout.end(isDump ? 'dump' : '');
        child.stderr.end(code ? 'pg_restore: error: out of disk' : '');
        setTimeout(() => child.emit('close', code), 5);
      }, 5);
    })();
    return child;
  });
  const fencedExecFile = (await import('./fence-fake')).withFence(execFile as any);
  const heldSpawn = (await import('./dump-fake')).withDumpHolder(spawn as any);
  return { ...real, execFile: fencedExecFile, exec, spawn: heldSpawn, default: { ...real, execFile: fencedExecFile, exec, spawn: heldSpawn } };
});

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as fleetBackup from '../../src/instance/fleetBackup';
import * as fleetBackupGuards from '../../src/instance/fleetBackupGuards';

const REGISTRY = path.join(tmp.dir, 'instances.json');
const DIR = path.join(tmp.dir, 'backups', 'a', 'fleet-postgres');
const FLOOR = path.join(DIR, 'term-floor.json');
const primary = { containerName: 'bot-a-postgres', user: 'app', db: 'app', volume: 'bot-a-pgdata' };

function writeRegistry(extraA: Record<string, unknown> = {}, wStatus = 'running'): void {
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: {
    a: { id: 'a', displayName: 'a', sanitizedName: 'bot-a', status: 'running', sourceUrl: 'https://example.invalid/fake/app', fleetDb: primary, fleetBackup: { enabled: false, hour: 4, keep: 7 }, ...extraA },
    w: { id: 'w', displayName: 'w', status: wStatus, sourceUrl: 'https://example.invalid/fake/app' },
  } }, null, 2));
}

beforeEach(() => {
  pg.events.length = 0;
  pg.sql.length = 0;
  pg.urls = { a: 'postgres://app:pw@bot-a-postgres/app', w: 'postgres://app:pw@bot-a-postgres:5432/app?sslmode=no-verify' };
  pg.live = { a: ['bot-a-app'], w: ['bot-w-app'] };
  pg.tables = 't|t';
  pg.probeFails = false;
  pg.liveTerm = '7';
  pg.guilds = 'g1\ng2\n';
  pg.raiseFails = false;
  pg.restoreCode = 0;
  pg.saveFails = false;
  pg.restoreGate = null;
  pg.noticeAtDrop = undefined;
  pg.floorAtDrop = null;
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, 'old.dump'), 'dump');
  fleetBackup.clearTermFloor('a');
  writeRegistry();
  fs.mkdirSync(path.join(tmp.dir, 'bots', 'a'), { recursive: true });
});
afterAll(() => { fs.rmSync(tmp.dir, { recursive: true, force: true }); });

const at = (event: string) => pg.events.indexOf(event);
const restore = () => fleetBackup.restoreFleetBackup('a', 'old.dump');

describe('R6-J14 and R39-J3: the restore keeps the pre-restore term or refuses', () => {
  it('raises every restored guild lease above the kept term and names the guilds', async () => {
    pg.liveTerm = '9';
    const r = await restore();
    expect(r.success).toBe(true);
    expect(r.steps.guildsRaised).toEqual(['g1', 'g2']);
    expect(r.steps.leaseTerm).toBe(10);
    expect(r.steps.termReconciledTo).toBe(9);
    const raise = pg.sql.find(s => s.includes('UPDATE smdb_data.guild_ownership'))!;
    expect(raise).toContain('PGOPTIONS=-c default_transaction_read_only=off');
    expect(raise).toContain('SET term = 10');
    expect(raise).toContain('WHERE term <= 9');
    expect(at('raise')).toBeGreaterThan(at('pg_restore'));
    expect(at('raise')).toBeLessThan(at('lift'));
    expect(JSON.parse(fs.readFileSync(FLOOR, 'utf-8'))).toEqual({ term: 9 });
  });

  it('a floor that cannot be written refuses before the drop, lifts the fence and restarts the writers', async () => {
    fs.mkdirSync(`${FLOOR}.tmp`);
    const r = await restore();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/pre-restore control term 7 could not be kept on disk, so the restore was refused, and nothing was changed/);
    expect(pg.events).not.toContain('drop');
    expect(at('lift')).toBeGreaterThan(at('fence'));
    expect(r.steps.restarted).toEqual(['a', 'w']);
  });

  it('the floor held in memory is written to disk before a retry in the same process drops the database', async () => {
    fs.mkdirSync(`${FLOOR}.tmp`);
    await restore();
    fs.rmSync(`${FLOOR}.tmp`, { recursive: true, force: true });
    pg.events.length = 0;
    pg.sql.length = 0;
    pg.liveTerm = '3';
    fs.rmSync(FLOOR, { recursive: true, force: true });
    fs.writeFileSync(FLOOR, JSON.stringify({ term: 2 }));
    const r = await restore();
    expect(r.success).toBe(true);
    expect(r.steps.leaseTerm).toBe(8);
    expect(JSON.parse(pg.floorAtDrop ?? 'null')).toEqual({ term: 7 });
  });

  it('a retry whose held floor still cannot be written refuses before the drop', async () => {
    fs.mkdirSync(`${FLOOR}.tmp`);
    await restore();
    pg.events.length = 0;
    pg.liveTerm = '3';
    const r = await restore();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/pre-restore control term 7 could not be kept on disk/);
    expect(pg.events).not.toContain('drop');
  });

  it('an unreadable floor file refuses before anything is stopped', async () => {
    fs.writeFileSync(FLOOR, 'not json');
    const r = await restore();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/term floor file .* could not be read/);
    expect(r.error).toMatch(/nothing was changed/);
    expect(pg.events).toEqual([]);
  });

  it('a term probe that fails refuses before the drop', async () => {
    pg.probeFails = true;
    const r = await restore();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Could not read the control term before the restore/);
    expect(pg.events).not.toContain('drop');
  });

  it('a database without the term tables restores with no lease raise', async () => {
    pg.tables = 'f|f';
    const r = await restore();
    expect(r.success).toBe(true);
    expect(r.steps.guildsRaised).toBeNull();
    expect(pg.events).not.toContain('raise');
  });

  it('a lease raise that fails keeps the fence on and the instances stopped', async () => {
    pg.raiseFails = true;
    const r = await restore();
    expect(r.success).toBe(false);
    expect(r.steps.restored).toBe(true);
    expect(r.error).toMatch(/guild leases could not be raised above the pre-restore term 7/);
    expect(r.error).toMatch(/write fence stays on and the stopped instances stay stopped/);
    expect(pg.events.slice(at('raise'))).not.toContain('lift');
    expect(r.steps.restarted).toEqual([]);
    expect(fleetBackup.getFleetFenceStuck('a')).toMatch(/READ-ONLY/);
  });
});

describe('R9-J3 and R13-J15: a failure past the drop stays fenced and named', () => {
  it('a failed pg_restore keeps the fence on, keeps the instances stopped and names the pre-restore dump', async () => {
    pg.restoreCode = 1;
    const r = await restore();
    expect(r.success).toBe(false);
    expect(pg.events.slice(at('pg_restore'))).not.toContain('lift');
    expect(pg.events.filter(e => e.startsWith('start:'))).toEqual([]);
    expect(r.error).toMatch(/stopped instances stay stopped \(a, w\)/);
    expect(r.error).toContain(r.steps.preRestoreDump!);
    expect(fleetBackup.getFleetRestoreError('a')).toContain(r.steps.preRestoreDump!);
  });

  it('the restore is recorded before the drop, naming the pre-restore dump', async () => {
    const r = await restore();
    expect(r.success).toBe(true);
    const notice = pg.noticeAtDrop as { file: string; text: string };
    expect(notice.file).toBe('old.dump');
    expect(notice.text).toMatch(/^Restore of old\.dump has not finished/);
    expect(notice.text).toContain(r.steps.preRestoreDump!);
    expect(fleetBackup.getFleetRestoreError('a')).toBeNull();
  });

  it('a restore that cannot be recorded refuses before the drop', async () => {
    pg.saveFails = true;
    const r = await restore();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/could not be recorded before the database was dropped/);
    expect(pg.events).not.toContain('drop');
    expect(r.steps.restarted).toEqual(['a', 'w']);
  });
});

describe('R7-J4 and R10-J1: who the restore stops comes from docker and the parsed URL', () => {
  it('stops itself and a sharer whose URL differs only in its query string', async () => {
    const r = await restore();
    expect(r.success).toBe(true);
    expect(r.steps.stopped.sort()).toEqual(['a', 'w']);
    expect(at('stop:a')).toBeLessThan(at('fence'));
  });

  it('a record that says running with nothing running in docker is neither stopped nor restarted', async () => {
    pg.live = { a: [], w: [] };
    const r = await restore();
    expect(r.success).toBe(true);
    expect(r.steps.stopped).toEqual([]);
    expect(pg.events.filter(e => e.startsWith('start:') || e.startsWith('stop:'))).toEqual([]);
  });

  it('docker that cannot answer refuses before the fence', async () => {
    pg.live = { a: ['bot-a-app'], w: null };
    const r = await restore();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Docker could not say whether instance w is running/);
    expect(pg.events).not.toContain('fence');
  });

  it('an op lock on a sharer refuses and names it', async () => {
    let release: () => void = () => {};
    const held = containerManager.withExternalBotOp('w', 'update', () => new Promise<void>(r => { release = r; }));
    const r = await restore();
    release();
    await held;
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Operation 'update' is running on w/);
    expect(pg.events).toEqual([]);
  });

  it('the preview names every instance the restore would stop and what docker shows running', async () => {
    pg.live.w = [];
    const p = await (fleetBackup as any).previewFleetRestore('a');
    expect(p).toEqual({ success: true, instances: [
      { id: 'a', displayName: 'a', running: true },
      { id: 'w', displayName: 'w', running: false },
    ] });
    pg.live.w = null;
    const unknown = await (fleetBackup as any).previewFleetRestore('a');
    expect(unknown.instances[1].running).toBeNull();
  });

  it('a sharer on another host is left alone', async () => {
    pg.urls.w = 'postgres://app:pw@other-host:5432/app';
    const r = await restore();
    expect(r.steps.stopped).toEqual(['a']);
  });
});

describe('R9-J3: Start, Restart, Update and Build refuse on an instance the restore holds', () => {
  it('refuses while the restore runs and admits once it ends', async () => {
    let open: () => void = () => {};
    pg.restoreGate = new Promise<void>(r => { open = r; });
    const running = restore();
    await vi.waitFor(() => expect(pg.events).toContain('pg_restore'));
    expect(containerManager.startPreflightRefusal('w')?.error).toMatch(/A database restore is running on this instance's database; Start is refused/);
    expect(containerManager.updatePreflightRefusal('w')?.error).toMatch(/Update is refused/);
    expect(containerManager.buildPreflightRefusal('a')?.error).toMatch(/Build is refused/);
    open();
    expect((await running).success).toBe(true);
    expect(containerManager.startPreflightRefusal('w')).toBeNull();
    expect(containerManager.buildPreflightRefusal('a')).toBeNull();
  });
});

describe('R13-J15: a manager self-update waits for a running lane', () => {
  it('names a running restore and an op lock, and nothing when all is quiet', async () => {
    expect(fleetBackup.databaseLaneBlocker()).toBeNull();
    expect(fleetBackupGuards.claimFleetBackupBusy('a')).toBe(true);
    expect(fleetBackup.databaseLaneBlocker()).toMatch(/dump, restore or replication change is running on a/);
    fleetBackupGuards.releaseFleetBackupBusy('a');
    let release: () => void = () => {};
    const held = containerManager.withExternalBotOp('w', 'build', () => new Promise<void>(r => { release = r; }));
    expect(fleetBackup.databaseLaneBlocker()).toMatch(/operation 'build' is running on w/);
    release();
    await held;
    expect(fleetBackup.databaseLaneBlocker()).toBeNull();
  });

  it('the update route refuses while a lane runs and starts nothing', async () => {
    vi.resetModules();
    let ran = false;
    vi.doMock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
    vi.doMock('../../src/casaos/detector', () => ({ getDeploymentMode: async () => 'docker' }));
    vi.doMock('../../src/manager/selfUpdate', () => ({
      getManagerVersion: async () => ({}), isUpdateInProgress: () => false, updateBlocker: () => null, updateRunning: () => false,
      updateLaneBlocker: () => 'a database dump, restore or replication change is running on a',
      runManagerUpdate: async () => { ran = true; return { state: 'noop', message: '' }; },
    }));
    const { createManagerRoutes } = await import('../../src/webui/routes/manager');
    const router: any = createManagerRoutes({} as any);
    const layer = router.stack.find((l: any) => l.route?.path === '/update');
    const res: any = { code: 200, body: null, status(c: number) { this.code = c; return this; }, json(b: unknown) { this.body = b; return this; } };
    await layer.route.stack[0].handle({}, res, () => {});
    vi.doUnmock('../../src/webui/server');
    vi.doUnmock('../../src/casaos/detector');
    vi.doUnmock('../../src/manager/selfUpdate');
    expect(res.code).toBe(409);
    expect(res.body.error).toMatch(/^The manager was not updated: a database dump, restore or replication change is running on a/);
    expect(ran).toBe(false);
  });
});

describe('R13-J15: the update scripts and a shutdown wait for a running lane', () => {
  it('a shutdown waits for the backup slot to clear, bounded', async () => {
    expect(fleetBackupGuards.claimFleetBackupBusy('a')).toBe(true);
    const waiting = (fleetBackup as any).waitForInFlightLanes(5_000, 10) as Promise<string | null>;
    setTimeout(() => fleetBackupGuards.releaseFleetBackupBusy('a'), 50);
    expect(await waiting).toBeNull();
    expect(fleetBackupGuards.claimFleetBackupBusy('a')).toBe(true);
    const bounded = await (fleetBackup as any).waitForInFlightLanes(50, 10);
    fleetBackupGuards.releaseFleetBackupBusy('a');
    expect(bounded).toMatch(/dump, restore or replication change is running on a/);
  });

  it('the lanes route answers what a recreate would cut short', async () => {
    vi.resetModules();
    const guards = await import('../../src/instance/fleetBackupGuards');
    const { createManagerRoutes } = await import('../../src/webui/routes/manager');
    const router: any = createManagerRoutes({} as any);
    const layer = router.stack.find((l: any) => l.route?.path === '/lanes' && l.route?.methods?.get);
    expect(layer).toBeDefined();
    const res: any = { code: 200, body: null, status(c: number) { this.code = c; return this; }, json(b: unknown) { this.body = b; return this; } };
    expect(guards.claimFleetBackupBusy('a')).toBe(true);
    await layer.route.stack[0].handle({}, res, () => {});
    guards.releaseFleetBackupBusy('a');
    expect(res.body).toEqual({ success: true, blocker: 'a database dump, restore or replication change is running on a' });
    await layer.route.stack[0].handle({}, res, () => {});
    expect(res.body).toEqual({ success: true, blocker: null });
  });

  const root = path.join(__dirname, '../..');
  const scripts: Array<[string, string]> = [
    ['update.sh', 'lane_check\n'],
    ['setup.sh', 'lane_check\n'],
    ['update.ps1', '/api/manager/lanes'],
  ];
  for (const [file, check] of scripts) {
    it(`${file} asks the manager before it recreates the stack`, () => {
      const text = fs.readFileSync(path.join(root, file), 'utf-8');
      const up = text.search(/docker compose -f "?\$\w+"? up -d/);
      expect(up).toBeGreaterThan(0);
      expect(text.lastIndexOf(check, up)).toBeGreaterThan(0);
      expect(text).not.toMatch(/up -d --build/);
    });
  }

  it.skipIf(process.platform === 'win32')('lane_check stops on a named lane and on no answer, and passes a quiet or absent manager', () => {
    const { spawnSync } = require('child_process') as typeof import('child_process');
    const text = fs.readFileSync(path.join(root, 'update.sh'), 'utf-8');
    const fn = text.slice(text.indexOf('lane_check() {'), text.indexOf('\n}\n', text.indexOf('lane_check() {')) + 3);
    const bin = fs.mkdtempSync(path.join(tmp.dir, 'bin-'));
    fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\ncase "$1" in ps) [ "$PS" = up ] && echo discordbotmanagerapp; exit 0;; exec) [ "$EXEC" = fail ] && exit 2; echo "$EXEC"; exit 0;; esac\n');
    fs.chmodSync(path.join(bin, 'docker'), 0o755);
    const run = (env: Record<string, string>) => spawnSync('sh', ['-c', `die() { echo "$*" >&2; exit 1; }\n${fn}\nlane_check && echo passed`],
      { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env }, encoding: 'utf-8' });
    const busy = run({ PS: 'up', EXEC: 'a database restore is running on a' });
    expect(busy.status).toBe(1);
    expect(busy.stderr).toMatch(/The stack was not recreated: a database restore is running on a/);
    const silent = run({ PS: 'up', EXEC: 'fail' });
    expect(silent.status).toBe(1);
    expect(silent.stderr).toMatch(/did not say whether a database lane is running/);
    expect(run({ PS: 'up', EXEC: '' }).stdout).toContain('passed');
    expect(run({ PS: 'down', EXEC: 'fail' }).stdout).toContain('passed');
  });
});
