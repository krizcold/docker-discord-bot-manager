import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'fu-c-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    execs: [] as Array<{ cmd: string; opts: any }>,
    psFails: '' as string,
    onMode: null as null | (() => void),
  };
});

// exec answers every docker ps with one running container unless h.psFails names the failure; a killed child
// carries killed: true, as node's exec reports a timeout.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const execFile = (_f: string, _a: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    done(null, { stdout: '', stderr: '' });
  };
  const exec = (cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    h.execs.push({ cmd, opts: typeof opts === 'function' ? undefined : opts });
    if (cmd.startsWith('docker ps') && h.psFails) {
      done(Object.assign(new Error(h.psFails), { killed: true, signal: 'SIGTERM' }));
      return;
    }
    done(null, { stdout: cmd.startsWith('docker ps') ? 'bot1-bot-1\nbot1-fleet-postgres\n' : '', stderr: '' });
  };
  const spawn = () => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    setTimeout(() => { child.stdout.end(''); child.stderr.end(''); setTimeout(() => child.emit('close', 0), 1); }, 2);
    return child;
  };
  const mod = { ...real, exec, execFile: (await import('./fence-fake')).withFence(execFile as any), execFileSync: () => '', execSync: () => '', spawn };
  return { ...mod, default: mod };
});
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => {
    h.onMode?.();
    return 'docker';
  },
}));
vi.mock('../../src/docker/dockerClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
  pullImage: async () => {},
  composeUp: async () => {},
  verifyComposeProjectRunning: async () => ({ allRunning: true, problems: [] }),
  listBotContainers: async () => [{ id: 'c1', name: 'bot1', botId: 'b1', state: 'running' }],
  listContainersByBotId: async () => [],
  checkDockerConnection: async () => true,
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';

const registryPath = path.join(h.dir, 'instances.json');
const botDir = path.join(h.dir, 'bots', 'b1');
const compose = 'name: bot1\nservices:\n  bot:\n    image: example/bot:1\n    environment:\n      FOO: old\n';
const fleetDb = { containerName: 'bot1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'bot1-fleet-postgres-data' };

function writeRegistry(extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(registryPath, JSON.stringify({
    instances: {
      b1: {
        id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'stopped',
        sourceType: 'docker-image', imageRef: 'example/bot:1',
        envVars: { FOO: 'old' }, containerIds: [],
        createdAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-25T00:00:00.000Z',
        ...extra,
      },
    },
  }));
}

beforeEach(() => {
  fs.rmSync(path.join(h.dir, 'DATA'), { recursive: true, force: true });
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(botDir, 'env'), { recursive: true });
  writeRegistry();
  h.execs.length = 0;
  h.psFails = '';
  h.onMode = null;
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('FU-8c the instance container listings are bounded reads', () => {
  it('runningInstanceContainers runs docker ps with a timeout', async () => {
    expect(await containerManager.runningInstanceContainers('b1')).toEqual(['bot1-bot-1', 'bot1-fleet-postgres']);
    const ps = h.execs.filter(e => e.cmd.startsWith('docker ps'));
    expect(ps.length).toBe(1);
    expect(ps[0].opts?.timeout).toBeGreaterThan(0);
  });

  it('runningNonSidecarContainers runs docker ps with a timeout', async () => {
    writeRegistry({ fleetDb });
    expect(await containerManager.runningNonSidecarContainers('b1')).toEqual(['bot1-bot-1']);
    const ps = h.execs.filter(e => e.cmd.startsWith('docker ps'));
    expect(ps.length).toBe(1);
    expect(ps[0].opts?.timeout).toBeGreaterThan(0);
  });

  it('reads a timed-out listing as unknown, never as no containers', async () => {
    h.psFails = 'Command failed: docker ps';
    expect(await containerManager.runningInstanceContainers('b1')).toBeNull();
    writeRegistry({ fleetDb });
    expect(await containerManager.runningNonSidecarContainers('b1')).toBeNull();
  });

  it('the app container read behind withServingStatus runs docker ps with a timeout and reads a timeout as unanswered', async () => {
    h.psFails = 'Command failed: docker ps';
    writeRegistry({ status: 'starting' });
    const instance = JSON.parse(fs.readFileSync(registryPath, 'utf-8')).instances.b1;
    const r = await containerManager.withServingStatus(instance);
    expect(r.unanswered).toBe(true);
    const ps = h.execs.filter(e => e.cmd.startsWith('docker ps'));
    expect(ps.length).toBe(1);
    expect(ps[0].opts?.timeout).toBeGreaterThan(0);
  });

  it('the project container read behind getBotLogs runs docker ps with a timeout and reads a timeout as unanswered', async () => {
    h.psFails = 'Command failed: docker ps';
    const r = await containerManager.getBotLogs('b1');
    expect(r.unanswered).toBe(true);
    const ps = h.execs.filter(e => e.cmd.startsWith('docker ps'));
    expect(ps.length).toBe(1);
    expect(ps[0].opts?.timeout).toBeGreaterThan(0);
  });
});

describe('FU-6s the docker image start lane syncs env from the instance as it is now', () => {
  it('writes the env a change made inside the lane left on the record', async () => {
    fs.writeFileSync(path.join(botDir, 'docker-compose.yml'), compose);
    h.onMode = () => {
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
      registry.instances.b1.envVars = { FOO: 'new' };
      fs.writeFileSync(registryPath, JSON.stringify(registry));
    };
    const r = await containerManager.startBot('b1');
    expect(r.success).toBe(true);
    const dotenv = fs.readFileSync(path.join(botDir, '.env'), 'utf-8');
    expect(dotenv).toMatch(/^FOO=new$/m);
    expect(fs.readFileSync(path.join(botDir, 'docker-compose.yml'), 'utf-8')).toMatch(/FOO: new/);
  }, 20000);
});

describe('FU-5mx deployedComposeEnvValues tells a missing compose from a missing value', () => {
  it('answers null when no compose copy exists', () => {
    expect(containerManager.deployedComposeEnvValues('b1', ['FOO'])).toBeNull();
    expect(containerManager.deployedComposeEnvValues('b1', ['FOO'], true)).toBeNull();
  });

  it('answers null for an instance that is not on record', () => {
    expect(containerManager.deployedComposeEnvValues('nope', ['FOO'])).toBeNull();
  });

  it('answers an empty list when a compose exists and sets no value for the key', () => {
    fs.writeFileSync(path.join(botDir, 'docker-compose.yml'), compose);
    expect(containerManager.deployedComposeEnvValues('b1', ['BAR'])).toEqual([]);
    expect(containerManager.deployedComposeEnvValues('b1', ['FOO'])).toEqual([{ key: 'FOO', value: 'old' }]);
  });

  it('answers undefined when a compose copy exists but cannot be read', () => {
    fs.mkdirSync(path.join(botDir, 'docker-compose.yml'));
    expect(containerManager.deployedComposeEnvValues('b1', ['FOO'])).toBeUndefined();
  });
});
