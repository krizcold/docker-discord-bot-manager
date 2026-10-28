import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm4-l5-a-decom-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, refuseWrite: '', calls: [] as string[] };
});

// A write to tmp.refuseWrite fails the way an unwritable file does, for root too.
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const writeFileSync = (file: any, ...rest: any[]) => {
    if (tmp.refuseWrite && (String(file) === tmp.refuseWrite || String(file) === `${tmp.refuseWrite}.tmp`)) {
      throw Object.assign(new Error(`EACCES: permission denied, open '${file}'`), { code: 'EACCES' });
    }
    return (real.writeFileSync as any)(file, ...rest);
  };
  return { ...real, writeFileSync, default: { ...real, writeFileSync } };
});

// A fake docker: containers run, volumes are absent, every exec and run exits
// 0 with no output, and the primary probe answers "not in recovery".
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const execFile = (_cmd: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (args[0] === 'inspect') return done(null, 'true\n', '');
    if (args[0] === 'volume' && args[1] === 'inspect') return done(new Error('fail'), '', 'Error: No such volume');
    done(null, '', '');
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
    child.kill = () => {};
    setTimeout(() => {
      child.stdout.end(args.includes('SELECT pg_is_in_recovery()') ? 'f\n' : '');
      child.stderr.end();
      setTimeout(() => child.emit('close', 0), 1);
    }, 1);
    return child;
  };
  const execFileSync = (cmd: string, args: string[], opts: any) => {
    if (cmd === 'docker' && args[0] === 'volume' && args[1] === 'inspect' && args[args.length - 1].endsWith('-fleet-postgres-replica-data')) throw new Error('Error: No such volume');
    return real.execFileSync(cmd, args, opts);
  };
  const heldSpawn = (await import('./dump-fake')).withDumpHolder(spawn as any);
  return { ...real, execFile, execFileSync, exec, spawn: heldSpawn, default: { ...real, execFile, execFileSync, exec, spawn: heldSpawn } };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  runningNonSidecarContainers: async () => [],
  startFleetDbSidecar: async () => ({ success: true }),
  retireFleetDbSidecar: async () => ({ success: true }),
  deployedComposeExists: () => true,
  applyFleetDbReplicaService: async () => ({ success: false, error: 'fake apply failure' }),
}));
vi.mock('../../src/instance/fleetBackupGuards', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetBackupGuards')>()),
  claimFleetBackupBusy: () => true,
  releaseFleetBackupBusy: () => {},
}));
vi.mock('../../src/instance/fleetBackup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetBackup')>()),
  clearClaimFloor: (id: string) => { tmp.calls.push(`clear:${id}`); },
  forgetRestoreNotice: (id: string) => { tmp.calls.push(`forget:${id}`); },
  runFleetDump: async () => ({ success: true, file: 'fake.dump' }),
}));
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  capabilityRefusal: () => null,
}));
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));


import * as fs from 'fs';
import * as path from 'path';
import * as envManager from '../../src/env/manager';
import { decommissionFleetDb } from '../../src/instance/fleetReplica';

const botDir = path.join(tmp.dir, 'bots', 'b1');
const fakeUrl = 'postgresql://smdb:fake-pass@bot1-fleet-postgres:5432/smdb?sslmode=no-verify';

beforeEach(() => {
  tmp.calls = [];
  fs.rmSync(path.join(tmp.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(botDir, 'env'), { recursive: true });
  fs.writeFileSync(path.join(tmp.dir, 'instances.json'), JSON.stringify({
    instances: {
      b1: {
        id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'stopped',
        sourceType: 'git', sourceUrl: 'https://example.invalid/fake/super-modular-discord-bot',
        envVars: { DATA_BACKEND: 'postgres' },
        fleetDb: { containerName: 'bot1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'bot1-fleet-postgres-data' },
        createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
      },
    },
  }));
  envManager.setEnvVars('b1', { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: fakeUrl });
});

afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

describe('NM4 L5 survivors in fleetReplica.ts (writer a)', () => {
  it('a finished decommission clears the claim floor and forgets the unsaved restore notice', async () => {
    const res = await decommissionFleetDb('b1');
    expect(res.success).toBe(true);
    expect(tmp.calls).toEqual(['clear:b1', 'forget:b1']);
  });
});
