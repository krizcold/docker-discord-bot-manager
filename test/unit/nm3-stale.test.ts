import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm3-stale-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, logs: [] as string[] };
});

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
    deployedComposeExists: () => true,
    startFleetDbSidecar: async () => ({ success: true }),
    retireFleetDbSidecar: async () => {
      const nodeFs = await import('fs');
      const file = (await import('path')).join(process.env.DATA_DIR!, 'instances.json');
      const reg = JSON.parse(nodeFs.readFileSync(file, 'utf-8'));
      delete reg.instances.a.fleetDb;
      delete reg.instances.a.fleetRestoreError;
      nodeFs.writeFileSync(file, JSON.stringify(reg, null, 2));
      return { success: true };
    },
    applyFleetDbReplicaService: async () => ({ success: true }),
    markPendingApplyIfRunning: async () => undefined,
  };
});
vi.mock('../../src/instance/fleetReplication', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/instance/fleetReplication')>();
  const nodeFs = await import('fs');
  const nodePath = await import('path');
  return {
    ...real,
    generateCertPair: async (dir: string) => {
      for (const file of ['server.key', 'server.crt']) nodeFs.writeFileSync(nodePath.join(dir, file), 'fake');
      return { ok: true };
    },
  };
});
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  capabilityRefusal: () => null,
}));

// A fake docker: this database and the pasted primary are the same cluster, the primary on a later timeline.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = require('events') as typeof import('events');
  const { PassThrough } = require('stream') as typeof import('stream');
  const execFile = vi.fn((_cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (err: Error | null, stdout: string, stderr: string) => void;
    const sql = args.join(' ');
    if (args[0] === 'inspect') return cb(null, 'true\n', '');
    if (args[0] === 'volume' && args[1] === 'inspect') {
      return args[args.length - 1].endsWith('-fleet-postgres-replica-data') ? cb(new Error('fail'), '', 'Error: No such volume') : cb(null, '[]', '');
    }
    if (sql.includes('ALTER SYSTEM SET default_transaction_read_only = on')) return cb(null, '0\n', '');
    if (sql.includes('SHOW default_transaction_read_only')) return cb(null, 'off\n', '');
    if (sql.includes('FROM pg_database WHERE datname')) return cb(null, '1\n', '');
    if (sql.includes('pg_control_system()')) return cb(null, '7001|2\n', '');
    if (sql.includes("to_regclass('smdb_control.term')")) return cb(null, 'f|f\n', '');
    if (sql.includes('to_regclass')) return cb(null, 'f\n', '');
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
    const identify = args.includes('IDENTIFY_SYSTEM');
    setTimeout(() => {
      child.stdout.end(isDump ? 'dump' : args.includes('SELECT pg_is_in_recovery()') ? 'f\n' : identify ? '7001|3|0/3000000|\n' : '');
      child.stderr.end('');
      setTimeout(() => child.emit('close', 0), 5);
    }, 5);
    return child;
  });
  const execFileSync = (cmd: string, args: string[], opts: any) => {
    if (cmd === 'docker' && args[0] === 'volume' && args[1] === 'inspect' && args[args.length - 1].endsWith('-fleet-postgres-replica-data')) throw new Error('Error: No such volume');
    return real.execFileSync(cmd, args, opts);
  };
  const fencedExecFile = (await import('./fence-fake')).withFence(execFile as any);
  const heldSpawn = (await import('./dump-fake')).withDumpHolder(spawn as any);
  return { ...real, execFile: fencedExecFile, execFileSync, exec, spawn: heldSpawn, default: { ...real, execFile: fencedExecFile, execFileSync, exec, spawn: heldSpawn } };
});

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import { getFleetReplicaStatus, reseedStalePrimary } from '../../src/instance/fleetReplica';
import { certSource } from '../../src/instance/fleetJoin';
import { codeFor, fixtureCert } from './join-fake';

const REGISTRY = path.join(tmp.dir, 'instances.json');
const primary = { containerName: 'bot-a-postgres', user: 'app', db: 'app', volume: 'bot-a-pgdata' };
const realWarn = console.warn;

beforeEach(() => {
  certSource.fetch = fixtureCert;
  tmp.logs = [];
  console.warn = (...args: unknown[]) => { tmp.logs.push(args.join(' ')); };
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: {
    a: { id: 'a', sanitizedName: 'a', displayName: 'a', status: 'stopped', sourceUrl: 'https://example.invalid/fake/app', fleetDb: primary, fleetBackup: { enabled: false, hour: 4, keep: 7 } },
  } }, null, 2));
  fs.mkdirSync(path.join(tmp.dir, 'bots', 'a'), { recursive: true });
});
afterAll(() => {
  console.warn = realWarn;
  fs.rmSync(tmp.dir, { recursive: true, force: true });
});

const finished = async () => {
  for (let i = 0; i < 500; i++) {
    const seed = containerManager.getBot('a')?.fleetDbReplicaSeed;
    if (!seed || seed.parked) return containerManager.getBot('a')!;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('the seed did not settle');
};

describe('F8 (NM5 J9): the stale-primary re-seed joins the main it was rebuilt from', () => {
  it('a join that fails after the copy runs keeps no join code, and the note names the rebuild, its dump and the failed join', async () => {
    const started = reseedStalePrimary(containerManager.getBot('a')!, codeFor('postgresql://replicator:fakepass@primary.invalid:5433/app'), 'standby.invalid', 5440, true);
    expect(started).toMatchObject({ success: true });
    const bot = await finished();
    expect(bot.fleetDbReplicaSeed).toBeUndefined();
    expect(bot.fleetJoin).toBeUndefined();
    const note = (await getFleetReplicaStatus(bot)).seedNote ?? '';
    expect(note).toMatch(/^This machine's database was rebuilt as a copy of primary\.invalid\. A dump of the old database is kept with the backups \(pre-reseed-[^)]+\.dump\)\. The copy runs, but the join code could not be saved \(.+\), so the bot's database list was not written; press Join with primary\.invalid's code\.$/);
  });
});

describe('NM5 J12: the operator Rejoin of a main holding a restore notice', () => {
  it('the notice goes with the old database, and the seed note says so after J-DONE', async () => {
    const fb = await import('../../src/instance/fleetBackup');
    const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf-8'));
    reg.instances.a.fleetRestoreError = { file: 'old.dump', text: 'Restore of old.dump failed: the copy was cut', at: '2026-10-30T09:00:00.000Z', doubt: true };
    fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2));
    expect(fb.shownRestoreNoticeFile('a')).toBe('old.dump');
    const started = reseedStalePrimary(containerManager.getBot('a')!, codeFor('postgresql://replicator:fakepass@primary.invalid:5433/app'), 'standby.invalid', 5440, true);
    expect(started).toMatchObject({ success: true });
    const bot = await finished();
    expect(fb.shownRestoreNoticeFile('a')).toBeNull();
    const note = (await getFleetReplicaStatus(bot)).seedNote ?? '';
    expect(note).toMatch(/^This machine's database was rebuilt as a copy of primary\.invalid\. A dump of the old database is kept with the backups \(pre-reseed-[^)]+\.dump\)\. The restore notice of old\.dump was about the old database and went with it; that dump holds the old database as it was\. The copy runs, but /);
  });
});
