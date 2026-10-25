import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b08-5-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  // ps: what `docker ps -q` lists, or null when docker does not answer.
  return { dir, ps: '' as string | null, downFails: false, upFails: false, pullFails: false, imageState: 'absent' as string, cfgFails: false, cfgCorrupt: false };
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
vi.mock('../../src/templates/pcsProcessing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/templates/pcsProcessing')>()),
  redeliverDockerConfigFiles: () => { if (h.cfgFails) throw new Error('disk full'); },
  fixDockerBotOwnership: () => {},
}));
vi.mock('../../src/config/configFileManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/config/configFileManager')>()),
  getConfigFilesWithStatus: () => ({ files: [{ path: 'a.json', content: '{}' }], undecryptable: [], corrupt: h.cfgCorrupt }),
  getBuiltMounts: () => ['a.json:default'],
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';

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
  h.cfgFails = false;
  h.cfgCorrupt = false;
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(botDir, 'env'), { recursive: true });
  fs.writeFileSync(composePath, 'services:\n  app:\n    image: img:1\n');
  seed('running');
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('B08-5 a start says which changes it could not apply', () => {
  it('a start whose env sync fails says so and keeps pendingApply', async () => {
    seed('stopped');
    fs.rmSync(composePath);
    fs.mkdirSync(composePath);
    const res = await containerManager.startBot('b1');
    expect(res.success).toBe(true);
    expect(res.warning).toMatch(/not applied: environment variables/);
    expect(stored().pendingApply).toBe(true);
  });

  it('a start whose config re-delivery fails says so and keeps pendingApply', async () => {
    seed('stopped');
    h.cfgFails = true;
    const res = await containerManager.startBot('b1');
    expect(res.success).toBe(true);
    expect(res.warning).toMatch(/not applied: config files \(Error: disk full\)/);
    expect(stored().pendingApply).toBe(true);
  });

  it('a start whose config store is unreadable says so', async () => {
    seed('stopped');
    h.cfgCorrupt = true;
    const res = await containerManager.startBot('b1');
    expect(res.success).toBe(true);
    expect(res.warning).toMatch(/not applied: config files \(the config-file store cannot be read\)/);
  });

  it('a clean start has no warning and clears pendingApply', async () => {
    seed('stopped', { pendingApply: true });
    const res = await containerManager.startBot('b1');
    expect(res.success).toBe(true);
    expect(res.warning).toBeUndefined();
    expect(stored().pendingApply).toBeUndefined();
  });
});
