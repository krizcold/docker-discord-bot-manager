import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b11-2-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  // inspect: what docker inspect answers; exec: whether docker exec (and psql through it) succeeds.
  return { dir, inspect: 'true' as 'true' | 'false' | 'gone' | 'daemon', execOk: true };
});

const DAEMON = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const inspectAnswer = (done: any) => {
    if (h.inspect === 'daemon') return done(new Error('exit 1'), '', DAEMON);
    if (h.inspect === 'gone') return done(new Error('exit 1'), '', 'Error: No such object: x');
    done(null, `${h.inspect}\n`, '');
  };
  const execFile = (_cmd: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (args[0] === 'inspect') return inspectAnswer(done);
    if (args[0] === 'exec' && !h.execOk) return done(new Error('exit 1'), '', h.inspect === 'daemon' ? DAEMON : 'Error response from daemon: container is not running');
    done(null, 'f||t|\n', '');
  };
  const spawn = () => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    setTimeout(() => {
      child.stdout.end('');
      child.stderr.end(h.execOk ? '' : DAEMON);
      setTimeout(() => child.emit('close', h.execOk ? 0 : 1), 1);
    }, 1);
    return child;
  };
  return { ...real, execFile, spawn, default: { ...real, execFile, spawn } };
});
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { dropFleetSlot, getFleetReplicationStatus } from '../../src/instance/fleetReplication';
import { adoptPromotedReplica, getFleetReplicaStatus, standbyDownText } from '../../src/instance/fleetReplica';
import { getFleetBackupError, getFleetFenceStuck, runFleetDump } from '../../src/instance/fleetBackup';

const fakeUrl = 'postgresql://smdb:fake-pass@bot1-fleet-postgres:5432/smdb?sslmode=no-verify';
const replication = { role: 'replicator', password: 'fake', hostPort: 5433, publicHost: 'h', certHost: 'h' };
const replica = { containerName: 'bot1-fleet-replica', user: 'smdb', db: 'smdb', volume: 'rv', publicHost: 'h', hostPort: 5434, primaryHost: 'p', primaryPort: 5433 };

const writeRegistry = (extra: Record<string, unknown>): void => {
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({
    instances: {
      b1: {
        id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'running',
        sourceType: 'git', sourceUrl: 'https://example.invalid/fake/app',
        envVars: { DATA_BACKEND: 'postgres' },
        createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
        ...extra,
      },
    },
  }));
};
const bot = () => containerManager.getBot('b1')!;

beforeEach(() => {
  h.inspect = 'true';
  h.execOk = true;
  fs.mkdirSync(path.join(h.dir, 'bots', 'b1', 'env'), { recursive: true });
  writeRegistry({ fleetDb: { containerName: 'bot1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'v', replication } });
  envManager.setEnvVars('b1', { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: fakeUrl });
});

afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('the standby probe', () => {
  beforeEach(() => { writeRegistry({ fleetDbReplica: replica }); });

  it('leaves live absent and carries the reason when docker could not be asked', async () => {
    h.execOk = false;
    h.inspect = 'daemon';
    const status = await getFleetReplicaStatus(bot());
    expect(status.live).toBeUndefined();
    expect(status.probeError).toContain('Cannot connect to the Docker daemon');
    expect(standbyDownText(status)).toContain('could not be probed');
  });

  it('leaves live absent when the container runs but psql failed', async () => {
    h.execOk = false;
    h.inspect = 'true';
    const status = await getFleetReplicaStatus(bot());
    expect(status.live).toBeUndefined();
    expect(status.probeError).toBeTruthy();
  });

  it('says not running only on docker\'s own false', async () => {
    h.execOk = false;
    h.inspect = 'false';
    const status = await getFleetReplicaStatus(bot());
    expect(status.live?.running).toBe(false);
    expect(standbyDownText(status)).toBe('the standby container is not running');
    h.inspect = 'gone';
    expect((await getFleetReplicaStatus(bot())).live?.running).toBe(false);
  });

  it('refuses an adopt it could not probe without saying the container is down', async () => {
    h.execOk = false;
    h.inspect = 'daemon';
    const res = await adoptPromotedReplica(bot());
    expect(res.success).toBe(false);
    expect(res.error).toContain('Could not read the standby');
    expect(res.error).not.toContain('not running');
  });
});

describe('the primary probe and refusals', () => {
  it('carries probeError on the status when docker could not be asked', async () => {
    h.inspect = 'daemon';
    const status = await getFleetReplicationStatus(bot(), { probeEndpoint: false });
    expect(status.live).toBeUndefined();
    expect(status.probeError).toContain('Cannot connect to the Docker daemon');
  });

  it('carries no probeError when docker says the container is stopped', async () => {
    h.inspect = 'false';
    const status = await getFleetReplicationStatus(bot(), { probeEndpoint: false });
    expect(status.live).toBeUndefined();
    expect(status.probeError).toBeUndefined();
  });

  it('refuses the slot drop with the probe failure, not "not running"', async () => {
    h.inspect = 'daemon';
    const drop = await dropFleetSlot(bot(), 'fleet_standby_x');
    expect(drop.error).toContain('Could not probe the database container');
    h.inspect = 'false';
    expect((await dropFleetSlot(containerManager.getBot('b1')!, 'fleet_standby_x')).error ?? '').toMatch(/not running|not enabled/);
  });

  it('fails a dump with the probe failure, not "not running"', async () => {
    h.inspect = 'daemon';
    const res = await runFleetDump(bot());
    expect(res.success).toBe(false);
    expect(res.error).toContain('Could not probe the database container');
  });
});

describe('the backup error and the fence', () => {
  it('reports no fence and no dump error by default, each on its own reader', () => {
    expect(getFleetBackupError('b1')).toBeNull();
    expect(getFleetFenceStuck('b1')).toBeNull();
  });
});
