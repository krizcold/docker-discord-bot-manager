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
    startFleetDbSidecar: async () => ({ success: true }),
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
  const execFile = vi.fn((_cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (err: Error | null, stdout: string, stderr: string) => void;
    const sql = args.join(' ');
    if (args[0] === 'inspect') return cb(null, 'true\n', '');
    if (sql.includes('SHOW default_transaction_read_only')) return cb(null, 'off\n', '');
    if (sql.includes('FROM pg_database WHERE datname')) return cb(null, '0\n', '');
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
  return { ...real, execFile, spawn, default: { ...real, execFile, spawn } };
});

import * as fs from 'fs';
import * as path from 'path';

const REGISTRY = path.join(tmp.dir, 'instances.json');
const DIR = path.join(tmp.dir, 'backups', 'a', 'fleet-postgres');
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
  await vi.waitFor(() => expect(fs.readdirSync(DIR).filter(f => f.endsWith('.dump') && f !== 'old.dump' && f !== 'other.dump').length).toBeGreaterThan(0));
  await new Promise(r => setTimeout(r, 50));
}

beforeEach(() => {
  pg.recreateFails = false;
  pg.restoreCode = 0;
  pg.saveFails = false;
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const old = Date.now() / 1000 - 3600;
  fs.writeFileSync(path.join(DIR, 'old.dump'), 'dump');
  fs.utimesSync(path.join(DIR, 'old.dump'), old, old);
  fs.writeFileSync(path.join(DIR, 'other.dump'), 'dump');
  fs.utimesSync(path.join(DIR, 'other.dump'), old + 60, old + 60);
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { a: { id: 'a', displayName: 'a', fleetDb: primary, fleetBackup: { enabled: true, hour: new Date().getHours(), keep: 1 } } } }, null, 2));
});
afterAll(() => { fs.rmSync(tmp.dir, { recursive: true, force: true }); });

describe('R28-J9: a failed restore keeps its own notice', () => {
  it('a failed pg_restore sets a restore notice naming the dump and the partial database', async () => {
    const fb = await freshManager();
    pg.restoreCode = 1;
    const r = await fb.restoreFleetBackup('a', 'old.dump');
    expect(r.success).toBe(false);
    expect(fb.getFleetRestoreError('a')).toContain('old.dump');
    expect(fb.getFleetRestoreError('a')).toContain('partial restore');
  });

  it('a later successful scheduled dump neither clears the notice nor trims the targeted dump', async () => {
    const fb = await freshManager();
    pg.restoreCode = 1;
    await fb.restoreFleetBackup('a', 'old.dump');
    await scheduledDump(fb);
    expect(fb.getFleetBackupError('a')).toBeNull();
    expect(fb.getFleetRestoreError('a')).toContain('old.dump');
    expect(fs.existsSync(path.join(DIR, 'old.dump'))).toBe(true);
    expect(fs.existsSync(path.join(DIR, 'other.dump'))).toBe(false);
  });

  it('a failed recreate sets the restore notice too', async () => {
    const fb = await freshManager();
    pg.recreateFails = true;
    const r = await fb.restoreFleetBackup('a', 'old.dump');
    expect(r.success).toBe(false);
    expect(fb.getFleetRestoreError('a')).toContain('could not recreate the database');
  });

  it('a successful restore clears the notice', async () => {
    const fb = await freshManager();
    pg.restoreCode = 1;
    await fb.restoreFleetBackup('a', 'old.dump');
    pg.restoreCode = 0;
    const r = await fb.restoreFleetBackup('a', 'other.dump');
    expect(r.success).toBe(true);
    expect(fb.getFleetRestoreError('a')).toBeNull();
  });

  it('a dismiss clears the notice, and the dump trims normally afterwards', async () => {
    const fb = await freshManager();
    pg.restoreCode = 1;
    await fb.restoreFleetBackup('a', 'old.dump');
    expect(fb.dismissFleetRestoreError('a')).toBe(true);
    expect(fb.getFleetRestoreError('a')).toBeNull();
    expect(fb.dismissFleetRestoreError('a')).toBe(false);
    await scheduledDump(fb);
    expect(fs.existsSync(path.join(DIR, 'old.dump'))).toBe(false);
  });

  it('the notice and the trim exemption survive a manager restart until dismissed', async () => {
    let fb = await freshManager();
    pg.restoreCode = 1;
    await fb.restoreFleetBackup('a', 'old.dump');
    fb = await freshManager();
    expect(fb.getFleetRestoreError('a')).toContain('old.dump');
    pg.restoreCode = 0;
    await scheduledDump(fb);
    expect(fs.existsSync(path.join(DIR, 'old.dump'))).toBe(true);
    expect(fb.dismissFleetRestoreError('a')).toBe(true);
    fb = await freshManager();
    expect(fb.getFleetRestoreError('a')).toBeNull();
  });

  it('a failed recreate never claims a partial restore', async () => {
    const fb = await freshManager();
    pg.recreateFails = true;
    await fb.restoreFleetBackup('a', 'old.dump');
    const text = fb.getFleetRestoreError('a') || '';
    expect(text).not.toContain('partial restore');
    expect(text).toContain('may be missing, or unchanged if the drop itself failed');
  });
});

describe('R28-J9: a restore notice the registry could not save', () => {
  it('a later scheduled dump keeps the notice and the targeted dump, and only a restart drops them', async () => {
    let fb = await freshManager();
    pg.restoreCode = 1;
    pg.saveFails = true;
    await fb.restoreFleetBackup('a', 'old.dump');
    expect(fb.getFleetRestoreError('a')).toContain('a manager restart drops it');
    expect(fb.getFleetBackupError('a')).toBeNull();
    pg.restoreCode = 0;
    await scheduledDump(fb);
    expect(fb.getFleetRestoreError('a')).toContain('old.dump');
    expect(fs.existsSync(path.join(DIR, 'old.dump'))).toBe(true);
    expect(fb.dismissFleetRestoreError('a')).toBe(true);
    expect(fb.getFleetRestoreError('a')).toBeNull();
    pg.restoreCode = 1;
    await fb.restoreFleetBackup('a', 'old.dump');
    fb = await freshManager();
    expect(fb.getFleetRestoreError('a')).toBeNull();
  });

  it('a successful restore clears the unsaved notice', async () => {
    const fb = await freshManager();
    pg.restoreCode = 1;
    pg.saveFails = true;
    await fb.restoreFleetBackup('a', 'old.dump');
    pg.restoreCode = 0;
    expect((await fb.restoreFleetBackup('a', 'other.dump')).success).toBe(true);
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
