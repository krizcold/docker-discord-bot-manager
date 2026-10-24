import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b07-2-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  // ps: what `docker ps -q` lists, or null when docker does not answer.
  return { dir, ps: '' as string | null, downFails: false, upFails: false, pullFails: false, imageState: 'absent' as string };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const fail = (stderr: string): Error => Object.assign(new Error(stderr), { stderr });
  const answer = (args: string[]): string => {
    const line = args.join(' ');
    if (line.startsWith('image inspect')) throw fail('Error: No such image: x');
    if (line.startsWith('volume')) throw fail('Error: No such volume: x');
    return '';
  };
  const execFileSync = (_f: string, args: string[]) => answer(args);
  const execFile = (_f: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    try { done(null, { stdout: answer(args), stderr: '' }); } catch (e) { done(e); }
  };
  const execSync = () => '';
  const exec = (cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (cmd.startsWith('docker ps')) {
      if (h.ps === null) done(new Error('Cannot connect to the Docker daemon'));
      else done(null, { stdout: h.ps, stderr: '' });
    } else if (cmd.startsWith('docker inspect')) done(new Error('Error: No such object'));
    else if (cmd.startsWith('docker rm')) done(new Error('Error: No such container'));
    else done(null, { stdout: '', stderr: '' });
  };
  const mod = { ...real, exec, execFile, execFileSync, execSync };
  return { ...mod, default: mod };
});
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/docker/dockerClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
  pullImage: async () => { if (h.pullFails) throw new Error('pull failed'); },
  composeUp: async () => { if (h.upFails) throw new Error('compose up timed out'); },
  composeDown: async () => { if (h.downFails) throw new Error('compose down timed out'); },
  verifyComposeProjectRunning: async () => ({ allRunning: true, problems: [] }),
  listBotContainers: async () => (h.ps ? [{ id: h.ps.trim(), name: 'bot1', state: 'running', labels: { 'com.docker.compose.project': 'bot1', 'smdb.bot-id': 'b1' } }] : []),
  listContainersByBotId: async () => (h.ps ? [{ id: h.ps.trim(), name: 'bot1', state: 'running', labels: {} }] : []),
  checkDockerConnection: async () => true,
  imageState: async () => h.imageState,
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import { logCollectors } from '../../src/build/logCollector';

const botDir = path.join(h.dir, 'bots', 'b1');
const composePath = path.join(botDir, 'docker-compose.yml');
const stored = (): any => JSON.parse(fs.readFileSync(path.join(h.dir, 'instances.json'), 'utf-8')).instances.b1;

const seed = (status: string, extra: Record<string, unknown> = {}): void => {
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({
    instances: {
      b1: {
        id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status,
        sourceType: 'docker-image', imageRef: 'img:1', envVars: {},
        createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z', ...extra,
      },
    },
  }));
};

beforeEach(() => {
  h.ps = '';
  h.downFails = false;
  h.upFails = false;
  h.pullFails = false;
  h.imageState = 'absent';
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(botDir, 'env'), { recursive: true });
  fs.writeFileSync(composePath, 'services:\n  app:\n    image: img:1\n');
  seed('running');
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('B07-2 a stop answers from docker, not from its intent', () => {
  it('a failed compose down with containers still running answers failure and keeps running', async () => {
    h.downFails = true;
    h.ps = 'abc123\n';
    const res = await containerManager.stopBot('b1');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/stop failed: 1 container of the project still run.*compose down timed out/);
    expect(stored().status).toBe('running');
  });

  it('a failed compose down that docker cannot confirm answers failure and keeps running', async () => {
    h.downFails = true;
    h.ps = null;
    const res = await containerManager.stopBot('b1');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/could not confirm whether the containers still run/);
    expect(stored().status).toBe('running');
  });

  it('a failed compose down that left nothing running is a stop', async () => {
    h.downFails = true;
    const res = await containerManager.stopBot('b1');
    expect(res.success).toBe(true);
    expect(stored().status).toBe('stopped');
  });

  it('a compose down docker cannot confirm afterwards stops with a warning', async () => {
    h.ps = null;
    const res = await containerManager.stopBot('b1');
    expect(res.success).toBe(true);
    expect((res as any).warning).toMatch(/could not confirm that no container still runs/);
  });

  it('a restart whose stop left containers running never starts and says so', async () => {
    h.downFails = true;
    h.ps = 'abc123\n';
    const res = await containerManager.restartBot('b1');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/still run/);
    expect(stored().status).toBe('running');
  });
});

describe('B07-2 a failed start or delete stamps what docker says', () => {
  it('a failed start whose app container runs keeps running, not error', async () => {
    seed('stopped');
    h.upFails = true;
    h.ps = 'abc123\n';
    const res = await containerManager.startBot('b1');
    expect(res.success).toBe(false);
    expect(stored().status).toBe('running');
  });

  it('a failed start with the project down stamps error', async () => {
    seed('stopped');
    h.upFails = true;
    const res = await containerManager.startBot('b1');
    expect(res.success).toBe(false);
    expect(stored().status).toBe('error');
  });

  it('a failed start docker cannot read keeps the prior status', async () => {
    seed('stopped');
    h.upFails = true;
    h.ps = null;
    const res = await containerManager.startBot('b1');
    expect(res.success).toBe(false);
    expect(stored().status).toBe('stopped');
  });

  it('a failed delete whose container still runs stamps running and names it', async () => {
    h.downFails = true;
    h.ps = 'abc123\n';
    h.imageState = 'unknown';
    const err = await containerManager.deleteBot('b1', true, true).catch((e: Error) => e);
    expect(String(err)).toMatch(/still present: .*container bot1/);
    expect(stored().status).toBe('running');
  });
});

describe('B07-2 a build and an update stamp from docker', () => {
  it('a build docker cannot check afterwards keeps error and pendingApply', async () => {
    seed('error', { pendingApply: true });
    h.ps = null;
    const res = await containerManager.buildBot('b1');
    expect(res.success).toBe(true);
    expect(stored().status).toBe('error');
    expect(stored().pendingApply).toBe(true);
  });

  it('a build that throws while the app runs keeps running, not error', async () => {
    h.pullFails = true;
    h.ps = 'abc123\n';
    const res = await containerManager.buildBot('b1');
    expect(res.success).toBe(false);
    expect(stored().status).toBe('running');
  });

  it('an update whose stop failed never rebuilds', async () => {
    h.downFails = true;
    h.ps = 'abc123\n';
    const res = await containerManager.pullAndRebuild('b1');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/^Update stopped before rebuilding/);
    expect(logCollectors.get('b1').getLogs().some(e => /^\[(Build|Pull)\]/.test(e.message))).toBe(false);
    expect(stored().status).toBe('running');
  });
});
