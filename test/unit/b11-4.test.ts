import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vm from 'vm';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b11-4-'));
  process.env.DATA_DIR = dir;
  return { dir };
});

const pg = vi.hoisted(() => ({ recreateFails: false, restoreCode: 0, saveFails: false }));

vi.mock('../../src/config/appCapabilities', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/config/appCapabilities')>();
  return { ...real, findAppCapabilities: () => ({ companionDb: { env: { url: 'DATABASE_URL' } } }) };
});
vi.mock('../../src/env/manager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/env/manager')>();
  return {
    ...real,
    getEnvVarsWithStatus: () => ({ vars: { DATABASE_URL: 'postgres://bot-a-postgres/app' }, corrupt: false, undecryptable: [] }),
    getEnvVars: () => ({ DATABASE_URL: 'postgres://bot-a-postgres/app' }),
  };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return {
    ...real,
    runningNonSidecarContainers: async () => [],
    runningInstanceContainers: async () => [],
    startFleetDbSidecar: async () => ({ success: true }),
    updateInstanceFleetRestoreError: (botId: string, notice: { file: string; text: string } | null) => {
      if (pg.saveFails && notice?.text.includes(' failed: ')) throw new Error('ENOSPC: no space left on device');
      return real.updateInstanceFleetRestoreError(botId, notice);
    },
  };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = require('events') as typeof import('events');
  const { PassThrough } = require('stream') as typeof import('stream');
  const execFile = vi.fn((_cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (err: Error | null, stdout: string, stderr: string) => void;
    const sql = args.join(' ');
    if (args[0] === 'inspect') return cb(null, 'true\n', '');
    if (sql.includes('SHOW default_transaction_read_only')) return cb(null, 'off\n', '');
    if (sql.includes('FROM pg_database WHERE datname')) return cb(null, '0\n', '');
    if (sql.includes("to_regclass('smdb_control.term')")) return cb(null, 'f|f\n', '');
    if (sql.includes('to_regclass')) return cb(null, 'f\n', '');
    if (sql.includes('DROP DATABASE') && pg.recreateFails) return cb(new Error('recreate refused'), '', 'ERROR: disk full');
    return cb(null, '', '');
  });
  const spawn = vi.fn((_cmd: string, args: string[]) => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.resume();
    child.kill = () => true;
    const isDump = args.includes('pg_dump');
    setTimeout(() => {
      if (isDump) child.stdout.end('dump');
      else child.stdout.end();
      child.stderr.end(isDump || pg.restoreCode === 0 ? '' : 'pg_restore: error: out of disk');
      setTimeout(() => child.emit('close', isDump ? 0 : pg.restoreCode), 5);
    }, 5);
    return child;
  });
  const fencedExecFile = (await import('./fence-fake')).withFence(execFile as any);
  const heldSpawn = (await import('./dump-fake')).withDumpHolder(spawn as any);
  return { ...real, execFile: fencedExecFile, spawn: heldSpawn, default: { ...real, execFile: fencedExecFile, spawn: heldSpawn } };
});

import * as fs from 'fs';
import * as path from 'path';

const REGISTRY = path.join(tmp.dir, 'instances.json');
const backupError = (fb: typeof import('../../src/instance/fleetBackup'), id: string): string | null =>
  fb.fleetBackupStatus(JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR as string, 'instances.json'), 'utf-8')).instances[id]).main?.lastError ?? null;

const DIR = path.join(tmp.dir, 'backups', 'a', 'fleet-postgres');
// Hourly dumps past their 48-hour keep, so the trim deletes each one nothing protects.
const stampAgo = (h: number) => new Date(Date.now() - h * 3600000).toISOString().replace(/[:.]/g, '-');
const OLD = `hourly-${stampAgo(60)}.dump`;
const OTHER = `hourly-${stampAgo(59)}.dump`;
const primary = { containerName: 'bot-a-postgres', user: 'app', db: 'app', volume: 'bot-a-pgdata' };

async function freshManager(): Promise<typeof import('../../src/instance/fleetBackup')> {
  vi.resetModules();
  return import('../../src/instance/fleetBackup');
}

async function scheduledDump(fb: typeof import('../../src/instance/fleetBackup')): Promise<void> {
  let tick: () => void = () => {};
  const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void) => { tick = fn; return 0; }) as unknown as typeof setInterval);
  fb.startFleetBackupScheduler();
  spy.mockRestore();
  fb.stopFleetBackupScheduler();
  tick();
  await vi.waitFor(() => expect(fs.readdirSync(DIR).filter(f => f.endsWith('.dump') && f !== OLD && f !== OTHER).length).toBeGreaterThan(0));
  await new Promise(r => setTimeout(r, 50));
}

beforeEach(() => {
  pg.recreateFails = false;
  pg.restoreCode = 0;
  pg.saveFails = false;
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const old = Date.now() / 1000 - 3600;
  fs.writeFileSync(path.join(DIR, OLD), 'dump');
  fs.utimesSync(path.join(DIR, OLD), old, old);
  fs.writeFileSync(path.join(DIR, OTHER), 'dump');
  fs.utimesSync(path.join(DIR, OTHER), old + 60, old + 60);
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { a: { id: 'a', displayName: 'a', fleetDb: primary, fleetBackup: { enabled: true, hour: new Date().getHours() } } } }, null, 2));
});
afterAll(() => { fs.rmSync(tmp.dir, { recursive: true, force: true }); });

describe('R28-J9: a failed restore keeps its own notice', () => {
  it('a failed pg_restore sets a restore notice naming the dump and the partial database', async () => {
    const fb = await freshManager();
    pg.restoreCode = 1;
    const r = await fb.restoreFleetBackup('a', OLD);
    expect(r.success).toBe(false);
    expect(fb.getFleetRestoreError('a')).toContain(OLD);
    expect(fb.getFleetRestoreError('a')).toContain('partial restore');
  });

  it('a later successful scheduled dump neither clears the notice nor trims the targeted dump', async () => {
    const fb = await freshManager();
    pg.restoreCode = 1;
    await fb.restoreFleetBackup('a', OLD);
    await scheduledDump(fb);
    expect(backupError(fb, 'a')).toBeNull();
    expect(fb.getFleetRestoreError('a')).toContain(OLD);
    expect(fs.existsSync(path.join(DIR, OLD))).toBe(true);
    expect(fs.existsSync(path.join(DIR, OTHER))).toBe(false);
  });

  it('a failed recreate sets the restore notice too', async () => {
    const fb = await freshManager();
    pg.recreateFails = true;
    const r = await fb.restoreFleetBackup('a', OLD);
    expect(r.success).toBe(false);
    expect(fb.getFleetRestoreError('a')).toContain('could not recreate the database');
  });

  it('a successful restore clears the notice', async () => {
    const fb = await freshManager();
    pg.restoreCode = 1;
    await fb.restoreFleetBackup('a', OLD);
    pg.restoreCode = 0;
    const r = await fb.restoreFleetBackup('a', OTHER);
    expect(r.success).toBe(true);
    expect(fb.getFleetRestoreError('a')).toBeNull();
  });

  it('a dismiss clears the notice, and the dump trims normally afterwards', async () => {
    const fb = await freshManager();
    pg.restoreCode = 1;
    await fb.restoreFleetBackup('a', OLD);
    expect(fb.dismissFleetRestoreError('a')).toBe(true);
    expect(fb.getFleetRestoreError('a')).toBeNull();
    expect(fb.dismissFleetRestoreError('a')).toBe(false);
    await scheduledDump(fb);
    expect(fs.existsSync(path.join(DIR, OLD))).toBe(false);
  });

  it('the notice and the trim exemption survive a manager restart until dismissed', async () => {
    let fb = await freshManager();
    pg.restoreCode = 1;
    await fb.restoreFleetBackup('a', OLD);
    fb = await freshManager();
    expect(fb.getFleetRestoreError('a')).toContain(OLD);
    pg.restoreCode = 0;
    await scheduledDump(fb);
    expect(fs.existsSync(path.join(DIR, OLD))).toBe(true);
    expect(fb.dismissFleetRestoreError('a')).toBe(true);
    fb = await freshManager();
    expect(fb.getFleetRestoreError('a')).toBeNull();
  });

  it('a failed recreate never claims a partial restore', async () => {
    const fb = await freshManager();
    pg.recreateFails = true;
    await fb.restoreFleetBackup('a', OLD);
    const text = fb.getFleetRestoreError('a') || '';
    expect(text).not.toContain('partial restore');
    expect(text).toContain('may be missing, or unchanged if the drop itself failed');
  });
});

describe('R28-J9: a restore notice the registry could not save', () => {
  it('a later scheduled dump keeps the notice and the targeted dump, and a restart shows the saved unfinished-restore notice', async () => {
    let fb = await freshManager();
    pg.restoreCode = 1;
    pg.saveFails = true;
    await fb.restoreFleetBackup('a', OLD);
    expect(fb.getFleetRestoreError('a')).toContain('a manager restart drops it');
    expect(backupError(fb, 'a')).toBeNull();
    pg.restoreCode = 0;
    await scheduledDump(fb);
    expect(fb.getFleetRestoreError('a')).toContain(OLD);
    expect(fs.existsSync(path.join(DIR, OLD))).toBe(true);
    expect(fb.dismissFleetRestoreError('a')).toBe(true);
    expect(fb.getFleetRestoreError('a')).toBeNull();
    pg.restoreCode = 1;
    await fb.restoreFleetBackup('a', OLD);
    fb = await freshManager();
    expect(fb.getFleetRestoreError('a')?.startsWith(`Restore of ${OLD} has not finished`)).toBe(true);
  });

  it('a successful restore clears the unsaved notice', async () => {
    const fb = await freshManager();
    pg.restoreCode = 1;
    pg.saveFails = true;
    await fb.restoreFleetBackup('a', OLD);
    pg.restoreCode = 0;
    expect((await fb.restoreFleetBackup('a', OTHER)).success).toBe(true);
    expect(fb.getFleetRestoreError('a')).toBeNull();
  });
});

describe("R28-J9: the standby's 'caught up' only while streaming", () => {
  const pageHtml = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
  const start = pageHtml.indexOf('const lagText = live.caughtUp');
  const expr = pageHtml.slice(start, pageHtml.indexOf(';\n', start) + 1);
  const lagText = (live: Record<string, unknown>): string => vm.runInNewContext(`${expr} lagText`, { live });

  it('streaming and caught up says caught up', () => {
    expect(lagText({ receiverStatus: 'streaming', caughtUp: true, replayLagSeconds: 0 })).toBe(', caught up');
  });

  it('a dropped link never says caught up', () => {
    const text = lagText({ receiverStatus: null, caughtUp: true, replayLagSeconds: 3 });
    expect(text).not.toContain('caught up');
    expect(text).toContain('replayed everything received before the link dropped');
  });
});
