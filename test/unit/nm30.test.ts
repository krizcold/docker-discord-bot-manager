import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm30-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

const pg = vi.hoisted(() => ({
  events: [] as string[],
  urls: {} as Record<string, string>,
  live: {} as Record<string, string[] | null>,
  sidecar: true,
  fenceFails: false,
  liftFails: false,
  dumpCode: 0,
  restoreCode: 0,
  at: {} as Record<string, () => void>,
  noticeAtDrop: undefined as unknown,
  volumeGone: false,
  failSave: null as RegExp | null,
}));

vi.mock('../../src/config/appCapabilities', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/config/appCapabilities')>();
  return { ...real, findAppCapabilities: () => ({ companionDb: { env: { url: 'DATABASE_URL' } } }) };
});
vi.mock('../../src/env/manager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/env/manager')>();
  return {
    ...real,
    getEnvVarsWithStatus: (id: string) => ({ vars: { DATABASE_URL: pg.urls[id] ?? '' }, corrupt: false, undecryptable: [], encrypted: [] }),
    getEnvVars: (id: string) => ({ DATABASE_URL: pg.urls[id] ?? '' }),
  };
});
vi.mock('../../src/instance/appHookClient', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/instance/appHookClient')>();
  return { ...real, callAppHook: async () => ({ ok: true, status: 200, body: { success: true } }) };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  const ev = (name: string) => { pg.events.push(name); pg.at[name]?.(); };
  return {
    ...real,
    runningInstanceContainers: async (id: string) => (id in pg.live ? pg.live[id] : []),
    startFleetDbSidecar: async () => { ev('sidecar-up'); pg.sidecar = true; return { success: true }; },
    stopBot: async (id: string) => { ev(`stop:${id}`); pg.live[id] = []; return { success: true }; },
    startBot: async (id: string) => { ev(`start:${id}`); return { success: true }; },
    stopBotInOp: async (id: string) => { ev(`stopInOp:${id}`); pg.live[id] = []; pg.sidecar = false; return { success: true }; },
    startBotInOp: async (id: string) => { ev(`startInOp:${id}`); return { success: true }; },
    updateInstanceFleetRestoreError: (botId: string, notice: { text: string } | null) => {
      if (notice && pg.failSave?.test(notice.text)) throw new Error('ENOSPC: no space left on device');
      real.updateInstanceFleetRestoreError(botId, notice as any);
    },
  };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = require('events') as typeof import('events');
  const { PassThrough } = require('stream') as typeof import('stream');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const ev = (name: string) => { pg.events.push(name); pg.at[name]?.(); };
  const execFile = vi.fn((_cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (err: Error | null, stdout: string, stderr: string) => void;
    const sql = args.join(' ');
    const fail = (text: string) => cb(new Error(text), '', `ERROR:  ${text}`);
    if (args[0] === 'inspect') return cb(null, args[args.length - 1] === 'bot-a-postgres' ? `${pg.sidecar}\n` : 'true\n', '');
    const readOnlyOn = ((globalThis as any).__fenceOwners as Map<string, string> | undefined)?.has('bot-a-postgres') === true;
    if (sql.includes('rolsuper')) return cb(null, 'true\n', '');
    if (sql.includes('ALTER ROLE') && !sql.includes('PGOPTIONS=-c default_transaction_read_only=off') && readOnlyOn) return fail('cannot execute ALTER ROLE in a read-only transaction');
    if (sql.endsWith("SELECT current_setting('default_transaction_read_only')")) return cb(null, readOnlyOn ? 'on\n' : 'off\n', '');
    if (args[0] === 'stop') return cb(null, '', '');
    if (args[0] === 'volume' && args[1] === 'inspect' && pg.volumeGone) return cb(new Error('exit 1'), '', 'Error response from daemon: get ' + args[2] + ': no such volume');
    if (sql.includes('ALTER SYSTEM SET default_transaction_read_only = on')) {
      if (pg.fenceFails) return fail('could not write auto.conf');
      ev('fence');
      return cb(null, '0\n', '');
    }
    if (sql.includes('ALTER SYSTEM RESET')) {
      ev('lift');
      return pg.liftFails ? fail('could not write auto.conf') : cb(null, '', '');
    }
    if (sql.includes('SHOW default_transaction_read_only')) return cb(null, 'off\n', '');
    if (sql.includes('FROM pg_database WHERE datname')) return cb(null, '1\n', '');
    if (sql.includes('DROP DATABASE')) {
      const registry = JSON.parse(nodeFs.readFileSync(nodePath.join(tmp.dir, 'instances.json'), 'utf-8'));
      pg.noticeAtDrop = registry.instances.a.fleetRestoreError;
      ev('drop');
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
    setTimeout(() => {
      child.stdout.end(isDump && !code ? 'dump' : '');
      child.stderr.end(code ? (isDump ? 'pg_dump: error: connection lost' : 'pg_restore: error: out of disk') : '');
      setTimeout(() => child.emit('close', code), 5);
    }, 5);
    return child;
  });
  const fakes = await import('./restore-fake');
  const fencedExecFile = (await import('./fence-fake')).withFence(fakes.withRestoreFakes(execFile as any));
  const heldSpawn = (await import('./dump-fake')).withDumpHolder(fakes.withTocFake(spawn as any));
  return { ...real, execFile: fencedExecFile, exec, spawn: heldSpawn, default: { ...real, execFile: fencedExecFile, exec, spawn: heldSpawn } };
});

import * as fs from 'fs';
import * as path from 'path';
import * as fleetBackup from '../../src/instance/fleetBackup';
import { parseGenRow, parseRestoreStateBefore } from '../../src/instance/switchSql';
import { fenceOwners } from './fence-fake';
import { claimDb, resetClaimDb, MAINTAINED, writeDumpMeta } from './restore-fake';

const REGISTRY = path.join(tmp.dir, 'instances.json');
const DIR = path.join(tmp.dir, 'backups', 'a', 'fleet-postgres');
const primary = { containerName: 'bot-a-postgres', user: 'app', db: 'app', volume: 'bot-a-pgdata' };

function writeRegistry(extraA: Record<string, unknown> = MAINTAINED): void {
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: {
    a: { id: 'a', displayName: 'a', sanitizedName: 'bot-a', status: 'running', sourceUrl: 'https://example.invalid/fake/app', createdAt: '2026-10-01T00:00:00.000Z', fleetDb: primary, fleetBackup: { enabled: false, hour: 4, keep: 7 }, ...extraA },
  } }, null, 2));
}
const registryA = () => JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')).instances.a;

beforeEach(() => {
  Object.assign(pg, { sidecar: true, fenceFails: false, liftFails: false, dumpCode: 0, restoreCode: 0, at: {}, noticeAtDrop: undefined, volumeGone: false, failSave: null });
  pg.events.length = 0;
  pg.urls = { a: 'postgres://app:pw@bot-a-postgres/app' };
  pg.live = { a: ['bot-a-app'] };
  resetClaimDb();
  fenceOwners.clear();
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  for (const file of ['old.dump', 'new.dump']) {
    fs.writeFileSync(path.join(DIR, file), 'dump');
    writeDumpMeta(DIR, file);
  }
  fleetBackup.clearClaimFloor('a');
  fleetBackup.dismissFleetRestoreError('a');
  writeRegistry();
  fs.mkdirSync(path.join(tmp.dir, 'bots', 'a'), { recursive: true });
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => { fs.rmSync(tmp.dir, { recursive: true, force: true }); });

const restore = (file = 'old.dump') => fleetBackup.restoreFleetBackup('a', file);
const quiet = () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
};

/** A restore of file cut by a manager restart while pg_restore ran: the registry keeps the notice it held then. */
async function cutAfterDrop(file = 'old.dump'): Promise<{ dump: string; notice: any }> {
  let notice: any;
  pg.at.pg_restore = () => { notice = registryA().fleetRestoreError; };
  pg.restoreCode = 1;
  const r = await restore(file);
  pg.at = {};
  pg.restoreCode = 0;
  expect(pg.events).toContain('drop');
  expect(notice).toBeDefined();
  writeRegistry({ ...MAINTAINED, fleetRestoreError: notice });
  pg.events.length = 0;
  return { dump: r.steps.preRestoreDump!, notice };
}

const named = (first: string, before: string, second: string, unfinished: string) =>
  `the pre-restore dump ${first} holds the database as it was before the restore of ${before}, and the pre-restore dump ${second} holds the database the unfinished restore of ${unfinished} left`;

describe('NM30 a retried restore names the dump of the database as it was', () => {
  it('the notice a cut restore leaves records its own pre-restore dump', async () => {
    quiet();
    const { dump, notice } = await cutAfterDrop();
    expect(dump).toMatch(/^pre-restore-/);
    expect(notice.asWas).toEqual({ dump, file: 'old.dump' });
  });

  it('a retry after a cut names the first dump as the database as it was and its own as the partial one', async () => {
    quiet();
    const { dump: first } = await cutAfterDrop();
    pg.restoreCode = 1;
    const r = await restore();
    const second = r.steps.preRestoreDump!;
    expect(second).toMatch(/^pre-restore-/);
    expect(second).not.toBe(first);
    const text = named(first, 'old.dump', second, 'old.dump');
    expect(r.success).toBe(false);
    expect(r.error).toContain(text);
    expect(r.error).not.toContain(`${second} holds the database as it was`);
    expect((pg.noticeAtDrop as any).text).toContain(text);
    expect((pg.noticeAtDrop as any).asWas).toEqual({ dump: first, file: 'old.dump' });
    const notice = registryA().fleetRestoreError;
    expect(notice.text).toContain(text);
    expect(notice.asWas).toEqual({ dump: first, file: 'old.dump' });
    expect(fleetBackup.getFleetFenceStuck('a')).toContain(text);
  });

  it('a third attempt after two cut ones still names the first dump, and the partial one by the last restore', async () => {
    quiet();
    const { dump: first } = await cutAfterDrop();
    const { notice } = await cutAfterDrop('new.dump');
    expect(notice.file).toBe('new.dump');
    expect(notice.asWas).toEqual({ dump: first, file: 'old.dump' });
    pg.restoreCode = 1;
    const r = await restore();
    expect(r.error).toContain(named(first, 'old.dump', r.steps.preRestoreDump!, 'new.dump'));
    expect(registryA().fleetRestoreError.asWas).toEqual({ dump: first, file: 'old.dump' });
  });

  it('a retry that succeeds says which dump holds the database as it was', async () => {
    quiet();
    const { dump: first } = await cutAfterDrop();
    const r = await restore();
    expect(r.success).toBe(true);
    expect(r.warning).toContain(named(first, 'old.dump', r.steps.preRestoreDump!, 'old.dump'));
    expect(registryA().fleetRestoreError).toBeUndefined();
  });

  it('a restore with no unfinished one before it names its own dump as now', async () => {
    quiet();
    pg.restoreCode = 1;
    const r = await restore();
    const own = r.steps.preRestoreDump!;
    expect(r.error).toContain(`restore a dump again: the pre-restore dump ${own} holds the database as it was`);
    expect(r.error).not.toMatch(/unfinished|did not finish before/);
    expect(registryA().fleetRestoreError.asWas).toEqual({ dump: own, file: 'old.dump' });
  });

  it('a successful restore with no unfinished one before it adds no warning', async () => {
    quiet();
    const r = await restore();
    expect(r.success).toBe(true);
    expect(r.warning).toBeUndefined();
  });

  it('a pending restore record with no notice says the dump of the database as it was is not recorded', async () => {
    quiet();
    claimDb.restoreState = { pending: true, file: 'gone.dump', generation: 0, machine: '', since: null };
    pg.restoreCode = 1;
    const r = await restore();
    const own = r.steps.preRestoreDump!;
    const text = `a restore of gone.dump did not finish before this one, and the manager has no record of which dump holds the database as it was before it; the pre-restore dump ${own} holds the database that restore left`;
    expect(r.error).toContain(text);
    expect(registryA().fleetRestoreError.text).toContain(text);
    expect(registryA().fleetRestoreError.asWas).toBeUndefined();
  });

  it('a finished restore record names nothing', async () => {
    quiet();
    claimDb.restoreState = { pending: false, file: 'gone.dump', generation: 0, machine: '', since: null };
    pg.restoreCode = 1;
    const r = await restore();
    expect(r.error).toContain(`the pre-restore dump ${r.steps.preRestoreDump} holds the database as it was`);
    expect(r.error).not.toContain('gone.dump');
  });

  it('a notice of an unfinished restore that holds no first dump says so', async () => {
    quiet();
    writeRegistry({ ...MAINTAINED, fleetRestoreError: { file: 'mid.dump', text: 'Restore of mid.dump failed: x. y', at: '2026-11-01T10:00:00.000Z', doubt: true } });
    pg.restoreCode = 1;
    const r = await restore();
    const own = r.steps.preRestoreDump!;
    expect(r.error).toContain(`a restore of mid.dump did not finish before this one, and the manager has no record of which dump holds the database as it was before it; the pre-restore dump ${own} holds the database that restore left`);
    expect(registryA().fleetRestoreError.asWas).toBeUndefined();
  });

  it('the first notice of a retry, saved before the fence, keeps the first dump', async () => {
    quiet();
    const { dump: first } = await cutAfterDrop();
    let atFence: any;
    pg.at.fence = () => { atFence = registryA().fleetRestoreError; };
    await restore();
    expect(atFence.asWas).toEqual({ dump: first, file: 'old.dump' });
  });

  it('the upsert answer is read as the record before and the kept floor', () => {
    expect(parseRestoreStateBefore('true|old.dump\n5|m|\n')).toEqual({ pending: true, file: 'old.dump' });
    expect(parseRestoreStateBefore('false|old.dump\n5|m|\n')).toEqual({ pending: false, file: 'old.dump' });
    expect(parseRestoreStateBefore('\n0||\n')).toBeNull();
    expect(parseGenRow('true|old.dump\n5|m|\n')).toEqual({ generation: 5, machine: 'm', since: null });
  });

  it('a retry refused before the drop whose fence stays on keeps the first dump in the notice', async () => {
    quiet();
    const { dump: first } = await cutAfterDrop();
    pg.dumpCode = 1;
    pg.liftFails = true;
    const r = await restore();
    expect(r.success).toBe(false);
    expect(pg.events).not.toContain('drop');
    const notice = registryA().fleetRestoreError;
    expect(notice.file).toBe('old.dump');
    expect(notice.asWas).toEqual({ dump: first, file: 'old.dump' });
  });
});

describe('NM30 review 1', () => {
  it('a retry after a restart during the first pre-restore dump names its own dump as the database as it was', async () => {
    quiet();
    let notice: any;
    pg.at.dump = () => { notice ??= registryA().fleetRestoreError; };
    pg.restoreCode = 1;
    await restore();
    pg.at = {};
    expect(notice).toBeDefined();
    expect(notice.asWas).toBeUndefined();
    writeRegistry({ ...MAINTAINED, fleetRestoreError: notice });
    claimDb.restoreState = null;
    const r = await restore();
    const own = r.steps.preRestoreDump!;
    expect(r.error).toContain(`restore a dump again: the pre-restore dump ${own} holds the database as it was`);
    expect(r.error).not.toMatch(/did not finish|no record|unfinished/);
    expect(registryA().fleetRestoreError.asWas).toEqual({ dump: own, file: 'old.dump' });
  });

  it('a pending record under a notice of a good restore whose lift failed names nothing unfinished', async () => {
    quiet();
    writeRegistry({ ...MAINTAINED, fleetRestoreError: { file: 'old.dump', text: 'Restore of old.dump ran, but the fence stays on', at: '2026-11-01T10:00:00.000Z', doubt: false } });
    claimDb.restoreState = { pending: true, file: 'old.dump', generation: 0, machine: '', since: null };
    pg.restoreCode = 1;
    const r = await restore();
    expect(r.error).toContain(`restore a dump again: the pre-restore dump ${r.steps.preRestoreDump} holds the database as it was`);
    expect(r.error).not.toMatch(/did not finish|no record|unfinished/);
  });

  it('a refusal after the record was written puts it back, so a retry names nothing unfinished', async () => {
    quiet();
    claimDb.fail5 = 'list';
    const refused = await restore();
    expect(refused.success).toBe(false);
    expect(pg.events).not.toContain('drop');
    expect(claimDb.restoreState?.pending).toBe(false);
    claimDb.fail5 = null;
    pg.restoreCode = 1;
    const r = await restore();
    expect(r.error).toContain(`restore a dump again: the pre-restore dump ${r.steps.preRestoreDump} holds the database as it was`);
    expect(r.error).not.toMatch(/did not finish|no record|unfinished/);
  });

  it('a refusal after the record was written keeps an earlier unfinished restore recorded', async () => {
    quiet();
    claimDb.restoreState = { pending: true, file: 'gone.dump', generation: 0, machine: '', since: null };
    claimDb.fail5 = 'list';
    await restore();
    expect(claimDb.restoreState).toMatchObject({ pending: true, file: 'gone.dump' });
  });

  it('a good restore whose volume is gone keeps the first dump in its notice', async () => {
    quiet();
    const { dump: first } = await cutAfterDrop();
    pg.liftFails = true;
    pg.volumeGone = true;
    const r = await restore();
    expect(r.steps.restored).toBe(true);
    const notice = registryA().fleetRestoreError;
    expect(notice.doubt).toBe(true);
    expect(notice.asWas).toEqual({ dump: first, file: 'old.dump' });
  });

  it('a refusal before the drop whose volume is gone keeps the dump it took in its notice', async () => {
    quiet();
    claimDb.fail5 = 'list';
    pg.liftFails = true;
    pg.volumeGone = true;
    const r = await restore();
    expect(pg.events).not.toContain('drop');
    const own = r.steps.preRestoreDump!;
    expect(own).toMatch(/^pre-restore-/);
    const notice = registryA().fleetRestoreError;
    expect(notice.doubt).toBe(true);
    expect(notice.asWas).toEqual({ dump: own, file: 'old.dump' });
  });
});

describe('NM30 review 2', () => {
  it('a named notice the registry cannot save refuses the restore before the drop and puts the record back', async () => {
    quiet();
    pg.failSave = /before choosing Running \(/;
    const r = await restore();
    expect(r.success).toBe(false);
    expect(pg.events).not.toContain('drop');
    expect(r.error).toMatch(/^The restore could not record the name of its safety dump before dropping the database, so the restore was refused/);
    expect(r.error).toContain('ENOSPC: no space left on device');
    expect(claimDb.restoreState?.pending).toBe(false);
    expect(registryA().fleetRestoreError).toBeUndefined();
  });

  it('a retry right after a good restore whose record clear failed names its own dump as the database as it was', async () => {
    quiet();
    claimDb.fail = 'clear';
    const good = await restore();
    expect(good.success).toBe(true);
    expect(claimDb.restoreState?.pending).toBe(true);
    claimDb.fail = null;
    pg.restoreCode = 1;
    const r = await restore();
    const own = r.steps.preRestoreDump!;
    expect(r.error).toContain(`restore a dump again: the pre-restore dump ${own} holds the database as it was`);
    expect(r.error).not.toMatch(/did not finish|no record|unfinished/);
    expect(registryA().fleetRestoreError.asWas).toEqual({ dump: own, file: 'old.dump' });
  });

  it('a successful clear forgets the failed one, so a later pending record counts again', async () => {
    quiet();
    claimDb.fail = 'clear';
    await restore();
    claimDb.fail = null;
    expect((await restore()).success).toBe(true);
    expect(claimDb.restoreState?.pending).toBe(false);
    claimDb.restoreState = { pending: true, file: 'old.dump', generation: 0, machine: '', since: null };
    pg.restoreCode = 1;
    const r = await restore();
    expect(r.error).toContain('a restore of old.dump did not finish before this one');
  });
});

describe('NM30 review 3', () => {
  it('a failed restore after a good one whose clear failed, its notice dismissed: a retry names no dump as the database as it was', async () => {
    quiet();
    claimDb.fail = 'clear';
    expect((await restore()).success).toBe(true);
    claimDb.fail = null;
    pg.restoreCode = 1;
    await restore();
    expect(pg.events).toContain('drop');
    expect(fleetBackup.dismissFleetRestoreError('a')).toBe(true);
    const r = await restore();
    const own = r.steps.preRestoreDump!;
    expect(r.error).toContain(`a restore of old.dump did not finish before this one, and the manager has no record of which dump holds the database as it was before it; the pre-restore dump ${own} holds the database that restore left`);
    expect(r.error).not.toContain(`${own} holds the database as it was`);
  });
});
