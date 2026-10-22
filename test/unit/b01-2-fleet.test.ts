import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b01-2-fleet-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, refuseWrite: '' };
});

// A write to tmp.refuseWrite fails the way an unwritable file does, for root too.
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const writeFileSync = (file: any, ...rest: any[]) => {
    if (tmp.refuseWrite && String(file) === tmp.refuseWrite) {
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
  return { ...real, execFile, exec, spawn, default: { ...real, execFile, exec, spawn } };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  runningNonSidecarContainers: async () => [],
  startFleetDbSidecar: async () => ({ success: true }),
  retireFleetDbSidecar: async () => ({ success: true }),
  deployedComposeExists: () => true,
  applyFleetDbReplicaService: async () => ({ success: false, error: 'fake apply failure' }),
}));
vi.mock('../../src/instance/fleetBackup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetBackup')>()),
  claimFleetBackupBusy: () => true,
  releaseFleetBackupBusy: () => {},
  clearTermFloor: () => {},
  runFleetDump: async () => ({ success: true, file: 'fake.dump' }),
}));
vi.mock('../../src/instance/appLifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appLifecycle')>()),
  capabilityRefusal: () => null,
}));
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));

import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { disableFleetReplication } from '../../src/instance/fleetReplication';
import { cancelReplicaSeed, decommissionFleetDb, getFleetReplicaStatus, reseedStalePrimary } from '../../src/instance/fleetReplica';

const botDir = path.join(tmp.dir, 'bots', 'b1');
const composePath = path.join(botDir, 'docker-compose.yml');
const fakeUrl = 'postgresql://smdb:fake-pass@bot1-fleet-postgres:5432/smdb?sslmode=no-verify';

const writeRegistry = (extra: Record<string, unknown> = {}): void => {
  fs.writeFileSync(path.join(tmp.dir, 'instances.json'), JSON.stringify({
    instances: {
      b1: {
        id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'stopped',
        sourceType: 'git', sourceUrl: 'https://example.invalid/fake/super-modular-discord-bot',
        envVars: { DATA_BACKEND: 'postgres' },
        fleetDb: { containerName: 'bot1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'bot1-fleet-postgres-data' },
        createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
        ...extra,
      },
    },
  }));
};

beforeEach(() => {
  fs.rmSync(path.join(tmp.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(botDir, 'env'), { recursive: true });
  writeRegistry();
  envManager.setEnvVars('b1', { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: fakeUrl, DATA_BACKEND_PUBLIC_URL: 'postgresql://fake-public' });
});

afterAll(() => {
  fs.rmSync(tmp.dir, { recursive: true, force: true });
});

const unwritableCompose = (): void => { fs.mkdirSync(composePath, { recursive: true }); };

describe('disabling replication', () => {
  it('answers a named warning when the compose could not be edited', async () => {
    writeRegistry({ fleetDb: { containerName: 'bot1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'v', replication: { role: 'replicator', password: 'fake', hostPort: 5433, publicHost: 'h', certHost: 'h' } } });
    unwritableCompose();
    const res = await disableFleetReplication(containerManager.getBot('b1')!);
    expect(res.success).toBe(true);
    expect(res.warning).toContain(composePath);
    expect(res.warning).toContain('DATA_BACKEND_PUBLIC_URL');
  });

  it('answers no warning when the compose was edited', async () => {
    writeRegistry({ fleetDb: { containerName: 'bot1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'v', replication: { role: 'replicator', password: 'fake', hostPort: 5433, publicHost: 'h', certHost: 'h' } } });
    fs.writeFileSync(composePath, YAML.stringify({ services: { app: { image: 'fake/app:1', environment: { DATA_BACKEND_PUBLIC_URL: 'postgresql://fake-public' } } } }));
    const res = await disableFleetReplication(containerManager.getBot('b1')!);
    expect(res).toMatchObject({ success: true });
    expect(res.warning).toBeUndefined();
  });
});

describe('decommissioning the database', () => {
  it('answers a named warning when the compose could not be edited, and keeps it on the instance', async () => {
    unwritableCompose();
    const res = await decommissionFleetDb('b1');
    expect(res.success).toBe(true);
    expect(res.warning).toContain(composePath);
    const status = await getFleetReplicaStatus(containerManager.getBot('b1')!);
    expect(status.pinsWarning).toContain(composePath);
  });

  it('answers a warning when retiring the pins throws', async () => {
    fs.writeFileSync(path.join(botDir, 'env', 'storage.json'), 'not json');
    const res = await decommissionFleetDb('b1');
    expect(res.success).toBe(true);
    expect(res.warning).toContain('could not be removed');
  });
});

describe('re-seeding a stale primary', () => {
  it('keeps the unedited-pins warning past a Dismiss of the parked seed', async () => {
    unwritableCompose();
    const pem = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----';
    const started = reseedStalePrimary(containerManager.getBot('b1')!, 'postgresql://replicator:fakepass@primary.invalid:5433/smdb', pem, 'standby.invalid', 5440, true, { dumpDone: true });
    expect(started).toMatchObject({ success: true });
    for (let i = 0; i < 200 && !containerManager.getBot('b1')?.fleetDbReplicaSeed?.parked; i++) await new Promise((r) => setTimeout(r, 10));
    const parked = containerManager.getBot('b1')!;
    expect(parked.fleetDbReplicaSeed?.parked).toBe(true);
    expect((await getFleetReplicaStatus(parked)).pinsWarning).toContain(composePath);

    await cancelReplicaSeed(parked);
    const after = containerManager.getBot('b1')!;
    expect(after.fleetDbReplicaSeed?.parked && !after.fleetDbReplicaSeed?.cancelled).toBeFalsy();
    expect((await getFleetReplicaStatus(after)).pinsWarning).toContain(composePath);
  });
});

describe('the pins warning', () => {
  it('stays while a compose it could not edit sets a value the store does not hold', async () => {
    fs.writeFileSync(composePath, YAML.stringify({ services: { app: { image: 'fake/app:1', environment: { DATA_BACKEND_URL: fakeUrl } } } }));
    tmp.refuseWrite = composePath;
    try {
      const res = await decommissionFleetDb('b1');
      expect(res.warning).toContain(composePath);
      expect(YAML.parse(fs.readFileSync(composePath, 'utf8')).services.app.environment).toHaveProperty('DATA_BACKEND_URL', fakeUrl);
      envManager.setEnvVars('b1', { DATA_BACKEND_URL: 'postgresql://smdb:fake-new@elsewhere.invalid:5432/smdb' });
      expect((await getFleetReplicaStatus(containerManager.getBot('b1')!)).pinsWarning).toContain(composePath);
      envManager.setEnvVars('b1', { DATA_BACKEND_URL: fakeUrl });
      expect((await getFleetReplicaStatus(containerManager.getBot('b1')!)).pinsWarning).toBeUndefined();
    } finally {
      tmp.refuseWrite = '';
    }
  });
});
