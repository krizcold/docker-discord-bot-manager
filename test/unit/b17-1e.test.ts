import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b17-1e-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
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
    if (cmd.startsWith('docker inspect')) done(new Error('Error: No such object'));
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
  pullImage: async () => {},
  composeUp: async () => {},
  composeDown: async () => {},
  verifyComposeProjectRunning: async () => ({ allRunning: true, problems: [] }),
  listBotContainers: async () => [],
  listContainersByBotId: async () => [],
  checkDockerConnection: async () => true,
  imageState: async () => 'present',
}));
vi.mock('../../src/templates/pcsProcessing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/templates/pcsProcessing')>()),
  redeliverDockerConfigFiles: () => {},
  fixDockerBotOwnership: () => {},
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';

const botDir = path.join(h.dir, 'bots', 'b1');
const composePath = path.join(botDir, 'docker-compose.yml');
const envPath = path.join(botDir, '.env');
const stored = (): any => JSON.parse(fs.readFileSync(path.join(h.dir, 'instances.json'), 'utf-8')).instances.b1;

const seed = (source: Record<string, unknown>, extra: Record<string, unknown> = {}): void => {
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({
    instances: {
      b1: {
        id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'stopped',
        envVars: { A: 'new' }, createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
        ...source, ...extra,
      },
    },
  }));
};

const lanes: Array<[string, Record<string, unknown>]> = [
  ['docker-image', { sourceType: 'docker-image', imageRef: 'img:1' }],
  ['git', { sourceType: 'git', gitUrl: 'https://example.invalid/bot.git', gitBranch: 'main' }],
];

beforeEach(() => {
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(botDir, 'env'), { recursive: true });
  fs.writeFileSync(composePath, 'services:\n  app:\n    image: img:1\n    env_file: .env\n');
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('B17-1e a start whose .env write fails says the .env was not applied', () => {
  for (const [lane, source] of lanes) {
    it(`${lane}: a failed .env write is listed as not applied and pendingApply stays`, async () => {
      seed(source, { pendingApply: true });
      fs.mkdirSync(envPath);
      const res = await containerManager.startBot('b1');
      expect(res.success).toBe(true);
      expect(res.warning).toMatch(/not applied: the \.env file \(/);
      expect(res.notApplied?.some(n => n.startsWith('the .env file ('))).toBe(true);
      expect(stored().pendingApply).toBe(true);
    });

    it(`${lane}: a successful .env write gives the plain success and writes the values`, async () => {
      seed(source, { pendingApply: true });
      fs.writeFileSync(envPath, 'A=old\n');
      const res = await containerManager.startBot('b1');
      expect(res.success).toBe(true);
      expect(res.warning).toBeUndefined();
      expect(fs.readFileSync(envPath, 'utf-8')).toMatch(/^A=.*new/m);
      expect(stored().pendingApply).toBeUndefined();
    });
  }
});
