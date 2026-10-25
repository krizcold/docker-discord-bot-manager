import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b20-4-lanes-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

const pg = vi.hoisted(() => ({
  events: [] as string[],
  retire: { success: true } as { success: boolean; error?: string; volumeRemoved?: boolean },
  volume: 'exists' as 'exists' | 'absent',
  createdAt: '2026-10-01T00:00:00Z',
}));

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
    deployedComposeExists: () => true,
    startFleetDbSidecar: async (_id: string, opts?: { retireRetry?: boolean }) => { pg.events.push(opts?.retireRetry ? 'sidecar-up-retry' : 'sidecar-up'); return { success: true }; },
    retireFleetDbSidecar: async () => { pg.events.push('retire'); return pg.retire; },
    applyFleetDbReplicaService: async () => ({ success: false, error: 'fake apply failure' }),
  };
});
vi.mock('../../src/instance/appLifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appLifecycle')>()),
  capabilityRefusal: () => null,
}));

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = require('events') as typeof import('events');
  const { PassThrough } = require('stream') as typeof import('stream');
  const execFile = (_cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (err: Error | null, stdout: string, stderr: string) => void;
    const sql = args.join(' ');
    if (args[0] === 'inspect') return cb(null, 'true\n', '');
    if (args[0] === 'volume' && args[1] === 'inspect') {
      if (pg.volume === 'absent' || args[args.length - 1].endsWith('-fleet-postgres-replica-data')) return cb(new Error('fail'), '', 'Error: No such volume');
      return cb(null, args.includes('{{.CreatedAt}}') ? `${pg.createdAt}\n` : '[]', '');
    }
    if (sql.includes('ALTER SYSTEM SET default_transaction_read_only = on')) { pg.events.push('fence'); return cb(null, '0\n', ''); }
    if (sql.includes('ALTER SYSTEM RESET')) { pg.events.push('lift'); return cb(null, '', ''); }
    if (sql.includes('SHOW default_transaction_read_only')) return cb(null, 'off\n', '');
    if (sql.includes('pg_control_system()')) return cb(null, '7001|2\n', '');
    return cb(null, '', '');
  };
  const exec = (_cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    done(null, { stdout: '', stderr: '' });
  };
  const spawn = (_cmd: string, args: string[]) => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.resume();
    child.kill = () => true;
    const isDump = args.includes('pg_dump');
    if (isDump) pg.events.push('dump');
    setTimeout(() => {
      child.stdout.end(isDump ? 'dump' : args.includes('SELECT pg_is_in_recovery()') ? 'f\n' : args.includes('IDENTIFY_SYSTEM') ? '7001|3|0/3000000|\n' : '');
      child.stderr.end('');
      setTimeout(() => child.emit('close', 0), 5);
    }, 5);
    return child;
  };
  const execFileSync = (cmd: string, args: string[], opts: any) => {
    if (cmd === 'docker' && args[0] === 'volume' && args[1] === 'inspect' && args[args.length - 1].endsWith('-fleet-postgres-replica-data')) throw new Error('Error: No such volume');
    return real.execFileSync(cmd, args, opts);
  };
  const fencedExecFile = (await import('./fence-fake')).withFence(execFile as any);
  return { ...real, execFile: fencedExecFile, execFileSync, exec, spawn, default: { ...real, execFile: fencedExecFile, execFileSync, exec, spawn } };
});

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import { decommissionFleetDb, reseedStalePrimary } from '../../src/instance/fleetReplica';

const REGISTRY = path.join(tmp.dir, 'instances.json');
const primary = { containerName: 'bot-a-postgres', user: 'app', db: 'app', volume: 'bot-a-pgdata' };
const pem = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----';
const RETIRING = '2026-10-20T00:00:00.000Z';

const writeRegistry = (fleetDb: Record<string, unknown>) => {
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: {
    a: { id: 'a', displayName: 'a', status: 'stopped', sourceUrl: 'https://example.invalid/fake/app', fleetDb, fleetBackup: { enabled: false, hour: 4, keep: 7 } },
  } }, null, 2));
};

beforeEach(() => {
  pg.events.length = 0;
  pg.retire = { success: true };
  pg.volume = 'exists';
  pg.createdAt = '2026-10-01T00:00:00Z';
  writeRegistry(primary);
  fs.mkdirSync(path.join(tmp.dir, 'bots', 'a'), { recursive: true });
});
afterAll(() => { fs.rmSync(tmp.dir, { recursive: true, force: true }); });

describe('R18-J4: a decommission after a partial retire', () => {
  it('refuses to dump a volume created after the retire first began', async () => {
    writeRegistry({ ...primary, retiringAt: RETIRING });
    pg.createdAt = '2026-10-21T00:00:00Z';
    const r = await decommissionFleetDb('a');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/nothing was destroyed/);
    expect(r.error).toMatch(/created after/);
    expect(pg.events).toEqual([]);
  });

  it('refuses when the volume creation time cannot be read', async () => {
    writeRegistry({ ...primary, retiringAt: RETIRING });
    pg.createdAt = 'garbage';
    const r = await decommissionFleetDb('a');
    expect(r.success).toBe(false);
    expect(pg.events).toEqual([]);
  });

  it('dumps and retires the volume the first attempt left standing', async () => {
    writeRegistry({ ...primary, retiringAt: RETIRING });
    const r = await decommissionFleetDb('a');
    expect(r.success).toBe(true);
    expect(pg.events).toContain('sidecar-up-retry');
    expect(pg.events).toContain('dump');
    expect(pg.events).toContain('retire');
  });

  it('a retire that removed the volume but failed after names that in the answer', async () => {
    pg.retire = { success: false, volumeRemoved: true, error: 'the database volume bot-a-pgdata was removed, but its compose or record could not be updated: EIO' };
    const r = await decommissionFleetDb('a');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/was removed, but its compose or record could not be updated/);
    expect(pg.events).not.toContain('lift');
  });
});

describe('R18-J4: a stale-primary re-seed after a partial retire', () => {
  const settled = async () => {
    for (let i = 0; i < 300 && !containerManager.getBot('a')?.fleetDbReplicaSeed?.parked; i++) await new Promise(r => setTimeout(r, 10));
    return containerManager.getBot('a')!;
  };
  const start = () => reseedStalePrimary(containerManager.getBot('a')!, 'postgresql://replicator:fakepass@primary.invalid:5433/app', pem, 'standby.invalid', 5440, true);

  it('marks the seed committed when the retire reports the volume gone', async () => {
    pg.retire = { success: false, volumeRemoved: true, error: 'the database volume bot-a-pgdata was removed, but its compose or record could not be updated: EIO' };
    expect(start()).toMatchObject({ success: true });
    const bot = await settled();
    expect(bot.fleetDbReplicaSeed?.committed).toBe(true);
    expect(bot.fleetDbReplicaSeed?.lastError).toMatch(/was removed, but its compose or record/);
  });

  it('refuses to dump a volume created after the retire first began', async () => {
    writeRegistry({ ...primary, retiringAt: RETIRING });
    pg.createdAt = '2026-10-21T00:00:00Z';
    expect(start()).toMatchObject({ success: true });
    const bot = await settled();
    expect(pg.events).toEqual([]);
    expect(bot.fleetDbReplicaSeed?.lastError).toMatch(/created after/);
    expect(bot.fleetDbReplicaSeed?.committed).not.toBe(true);
  });

  it('brings up the volume the first attempt left standing past the retiring mark', async () => {
    writeRegistry({ ...primary, retiringAt: RETIRING });
    expect(start()).toMatchObject({ success: true });
    await settled();
    expect(pg.events[0]).toBe('sidecar-up-retry');
  });
});
