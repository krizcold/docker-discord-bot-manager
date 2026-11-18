import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm35-l5-b-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

// The stale-primary re-seed with a fake docker: this database's identity (system id|timeline) and the pasted primary's IDENTIFY_SYSTEM answer.
const pg = vi.hoisted(() => ({
  events: [] as string[],
  identifyArgs: [] as string[][],
  local: '7001|2',
  primary: '7001|3|0/3000000|',
  retire: { success: true } as { success: boolean; error?: string; volumeRemoved?: boolean },
  spawned: [] as string[][],
  failBasebackup: false,
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
    runningInstanceContainers: async () => [],
    deployedComposeExists: () => true,
    startFleetDbSidecar: async () => { pg.events.push('sidecar-up'); return { success: true }; },
    retireFleetDbSidecar: async () => { pg.events.push('retire'); return pg.retire; },
    applyFleetDbReplicaService: async () => ({ success: false, error: 'fake apply failure' }),
  };
});
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  capabilityRefusal: () => null,
  hasAppHooks: () => false,
}));
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
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));

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
    if (sql.includes('ALTER SYSTEM SET default_transaction_read_only = on')) { pg.events.push('fence'); return cb(null, '0\n', ''); }
    if (sql.includes('ALTER SYSTEM RESET')) { pg.events.push('lift'); return cb(null, '', ''); }
    if (sql.includes('SHOW default_transaction_read_only')) return cb(null, 'off\n', '');
    if (sql.includes('FROM pg_database WHERE datname')) return cb(null, '1\n', '');
    if (sql.includes('pg_control_system()')) return pg.local ? cb(null, `${pg.local}\n`, '') : cb(new Error('down'), '', 'psql: error: connection refused');
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
    if (isDump) pg.events.push('dump');
    pg.spawned.push(args);
    const failSeed = pg.failBasebackup && args.includes('pg_basebackup');
    const identify = args.includes('IDENTIFY_SYSTEM');
    if (identify) { pg.events.push('identify'); pg.identifyArgs.push(args); }
    setTimeout(() => {
      child.stdout.end(isDump ? 'dump' : args.includes('SELECT pg_is_in_recovery()') ? 'f\n' : identify ? `${pg.primary}\n` : '');
      child.stderr.end('');
      setTimeout(() => child.emit('close', failSeed ? 2 : 0), 5);
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
import { provisionFleetReplica, reseedStalePrimary } from '../../src/instance/fleetReplica';
import { certSource } from '../../src/instance/fleetJoin';
import { codeFor, fixtureCert, joinRecordFor } from './join-fake';

beforeEach(() => { certSource.fetch = fixtureCert; });

const REGISTRY = path.join(tmp.dir, 'instances.json');
const primary = { containerName: 'bot-a-postgres', user: 'app', db: 'app', volume: 'bot-a-pgdata' };

beforeEach(() => {
  pg.spawned.length = 0;
  pg.failBasebackup = false;
  pg.events.length = 0;
  pg.identifyArgs.length = 0;
  pg.local = '7001|2';
  pg.primary = '7001|3|0/3000000|';
  pg.retire = { success: true };
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: {
    a: { id: 'a', displayName: 'a', status: 'stopped', sourceUrl: 'https://example.invalid/fake/app', fleetDb: primary, fleetBackup: { enabled: false, hour: 4, keep: 7 } },
  } }, null, 2));
  fs.mkdirSync(path.join(tmp.dir, 'bots', 'a'), { recursive: true });
});
afterAll(() => { fs.rmSync(tmp.dir, { recursive: true, force: true }); });

const settled = async () => {
  for (let i = 0; i < 300 && !containerManager.getBot('a')?.fleetDbReplicaSeed?.parked; i++) await new Promise(r => setTimeout(r, 10));
  return containerManager.getBot('a')!;
};
const start = () => reseedStalePrimary(containerManager.getBot('a')!, codeFor('postgresql://replicator:fakepass@primary.invalid:5433/app'), 'standby.invalid', 5440, true);

// From the cert mount through the options, for the one run whose argv holds needle.
const primaryRun = (needle: string) => {
  const runs = pg.spawned.filter(a => a[0] === 'run' && a.includes(needle));
  expect(runs.length).toBeGreaterThan(0);
  return runs.map(a => {
    const e = a.indexOf('--entrypoint');
    return { mount: a.slice(e - 2, e), tail: a.slice(e, e + 4), opts: a.slice(e + 5, e + 8), last: a[a.length - 1] };
  });
};

describe('NM35 L5: the psql runs on the primary pass their whole argv', () => {
  it('the identity read mounts the cert and runs psql -X <dsn> -Atc IDENTIFY_SYSTEM', async () => {
    expect(await start()).toMatchObject({ success: true });
    await settled();
    for (const r of primaryRun('IDENTIFY_SYSTEM')) {
      expect(r.mount[0]).toBe('-v');
      expect(r.mount[1]).toMatch(/:\/primary-ca\.crt:ro$/);
      expect(r.tail).toEqual(['--entrypoint', 'psql', 'postgres:16-alpine', '-X']);
      const a = pg.identifyArgs[0];
      expect(a.slice(a.indexOf('-X') + 2)).toEqual(['-Atc', 'IDENTIFY_SYSTEM']);
    }
  });

  it('the recovery probe, the slot reset and the slot drop after a failed pg_basebackup', async () => {
    pg.failBasebackup = true;
    const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf-8'));
    reg.instances = {}; reg.instances.b1 = {
      id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'running',
      sourceType: 'git', sourceUrl: 'https://example.invalid/fake/super-modular-discord-bot', envVars: {},
      fleetJoin: joinRecordFor('postgresql://replicator:fakepass@primary.invalid:5433/smdb'),
      createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
    };
    fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2));
    fs.mkdirSync(path.join(tmp.dir, 'bots', 'b1', 'env'), { recursive: true });
    expect(provisionFleetReplica(containerManager.getBot('b1')!, 'standby.invalid', 5440, true)).toMatchObject({ success: true });
    for (let i = 0; i < 300 && containerManager.isBotBusy('b1') === null; i++) await new Promise(r => setTimeout(r, 2));
    for (let i = 0; i < 300 && containerManager.isBotBusy('b1') !== null; i++) await new Promise(r => setTimeout(r, 10));
    for (const needle of ['SELECT pg_is_in_recovery()']) {
      for (const r of primaryRun(needle)) {
        expect(r.mount[0]).toBe('-v');
        expect(r.mount[1]).toMatch(/.+:\/primary-ca\.crt:ro$/);
        expect(r.tail).toEqual(['--entrypoint', 'psql', 'postgres:16-alpine', '-X']);
        expect(r.opts).toEqual(['-v', 'ON_ERROR_STOP=1', '-Atc']);
        expect(r.last).toBe(needle);
      }
    }
    const byText = (t: string) => pg.spawned.filter(a => a[0] === 'run' && a[a.length - 1].includes(t));
    for (const t of ['wal_status INTO s', 'pg_drop_replication_slot(slot_name)']) {
      const runs = byText(t);
      expect(runs.length).toBeGreaterThan(0);
      for (const a of runs) {
        const e = a.indexOf('--entrypoint');
        expect(a[e - 2]).toBe('-v');
        expect(a[e - 1]).toMatch(/.+:\/primary-ca\.crt:ro$/);
        expect(a.slice(e, e + 4)).toEqual(['--entrypoint', 'psql', 'postgres:16-alpine', '-X']);
        expect(a.slice(e + 5, e + 8)).toEqual(['-v', 'ON_ERROR_STOP=1', '-Atc']);
        expect(a.length).toBe(e + 9);
      }
    }
  });
});
