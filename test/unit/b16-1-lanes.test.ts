import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// A lane already in flight that reaches the backup slot during SIGTERM's wait is refused for the shutdown, and must say so, not "busy".
const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b16-1-lanes-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, docker: [] as string[] };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const exec = (cmd: string, opts: any, cb?: any) => { tmp.docker.push(cmd); (typeof opts === 'function' ? opts : cb)(null, { stdout: '', stderr: '' }); };
  const execFile = (_c: string, args: string[], opts: any, cb?: any) => { tmp.docker.push(args.join(' ')); (typeof opts === 'function' ? opts : cb)(null, '', ''); };
  const spawn = () => { throw new Error('spawn called'); };
  return { ...real, exec, execFile, spawn, default: { ...real, exec, execFile, spawn } };
});
vi.mock('../../src/docker/dockerClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
  volumeState: () => 'absent',
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  runningNonSidecarContainers: async () => [],
  deployedComposeExists: () => true,
}));
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  capabilityRefusal: () => null,
}));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { enableFleetReplication, disableFleetReplication } from '../../src/instance/fleetReplication';
import { decommissionFleetDb, reseedStalePrimary } from '../../src/instance/fleetReplica';

const botDir = path.join(tmp.dir, 'bots', 'b1');
const pem = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----';

beforeEach(() => {
  fs.mkdirSync(path.join(botDir, 'env'), { recursive: true });
  fs.writeFileSync(path.join(tmp.dir, 'instances.json'), JSON.stringify({ instances: {
    b1: {
      id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'stopped',
      sourceType: 'git', sourceUrl: 'https://example.invalid/fake/super-modular-discord-bot',
      envVars: { DATA_BACKEND: 'postgres' },
      fleetDb: { containerName: 'bot1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'bot1-fleet-postgres-data',
        replication: { role: 'replicator', password: 'fake', hostPort: 5433, publicHost: 'h', certHost: 'h' } },
      createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
    },
  } }));
  envManager.setEnvVars('b1', { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: 'postgresql://smdb:fake-pass@bot1-fleet-postgres:5432/smdb' });
  tmp.docker.length = 0;
});

afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

describe('R13-J15: lanes in flight refused by the shutdown name the shutdown', () => {
  it('enable, disable, the stale-primary re-seed and the decommission answer the shutdown text, and nothing runs', async () => {
    containerManager.beginShutdown();
    const bot = () => containerManager.getBot('b1')!;
    const results = [
      await enableFleetReplication(bot(), 'standby.invalid', 5433),
      await disableFleetReplication(bot()),
      reseedStalePrimary(bot(), 'postgresql://replicator:fakepass@primary.invalid:5433/smdb', pem, 'standby.invalid', 5440, true, { dumpDone: true }),
      await decommissionFleetDb('b1'),
    ];
    for (const r of results) {
      expect(r.success).toBe(false);
      expect(r.error).toBe(containerManager.SHUTDOWN_REFUSAL);
    }
    expect(tmp.docker).toEqual([]);
    expect(bot().fleetDb?.replication?.publicHost).toBe('h');
    expect(bot().fleetDbReplicaSeed).toBeUndefined();
  });
});
