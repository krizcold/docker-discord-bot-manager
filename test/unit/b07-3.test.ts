import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b07-3-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, daemonDown: false, unstatable: new Set<string>() };
});

const DOWN = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock';
const fail = (stderr: string): Error => Object.assign(new Error(stderr), { stderr });
const answer = (args: string[]): string => {
  if (h.daemonDown) throw fail(DOWN);
  const line = args.join(' ');
  if (line.startsWith('image inspect')) throw fail('Error: No such image: x');
  if (line.startsWith('volume inspect')) throw fail('Error: No such volume: x');
  if (line.startsWith('volume rm')) throw fail('Error: No such volume: x');
  return '';
};

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFileSync = (_f: string, args: string[]) => answer(args);
  const execFile = (_f: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    try { done(null, { stdout: answer(args), stderr: '' }); } catch (e) { done(e); }
  };
  const execSync = () => '';
  const exec = (cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (h.daemonDown) done(fail(DOWN));
    else if (cmd.startsWith('docker inspect')) done(new Error('Error: No such object'));
    else if (cmd.startsWith('docker rm')) done(new Error('Error: No such container'));
    else done(null, { stdout: '', stderr: '' });
  };
  const mod = { ...real, exec, execFile, execFileSync, execSync };
  return { ...mod, default: mod };
});
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const eacces = (p: unknown): Error => Object.assign(new Error(`EACCES: permission denied, stat '${p}'`), { code: 'EACCES' });
  const mod = {
    ...real,
    existsSync: (p: any) => (h.unstatable.has(String(p)) ? false : real.existsSync(p)),
    statSync: ((p: any, o?: any) => { if (h.unstatable.has(String(p))) throw eacces(p); return real.statSync(p, o); }) as typeof real.statSync,
    lstatSync: ((p: any, o?: any) => { if (h.unstatable.has(String(p))) throw eacces(p); return real.lstatSync(p, o); }) as typeof real.lstatSync,
    rmSync: (p: any, o?: any) => { if (!h.unstatable.has(String(p))) real.rmSync(p, o); },
  };
  return { ...mod, default: mod };
});
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as dockerClient from '../../src/docker/dockerClient';

const botDir = path.join(h.dir, 'bots', 'b1');
const registered = (): boolean =>
  'b1' in JSON.parse(fs.readFileSync(path.join(h.dir, 'instances.json'), 'utf-8')).instances;

beforeEach(() => {
  h.daemonDown = false;
  h.unstatable.clear();
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(botDir, 'env'), { recursive: true });
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({
    instances: {
      b1: {
        id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'stopped',
        sourceType: 'docker-image', envVars: {},
        createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
      },
    },
  }));
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('B07-3 docker listings tell none from no answer', () => {
  it('listProjectVolumes throws when docker does not answer', () => {
    h.daemonDown = true;
    expect(() => dockerClient.listProjectVolumes('bot1')).toThrow(/Docker daemon/);
  });

  it('listContainersByBotId rejects when docker does not answer', async () => {
    h.daemonDown = true;
    await expect(dockerClient.listContainersByBotId('b1')).rejects.toThrow(/Docker daemon/);
  });

  it('imageState is absent only on no such image', async () => {
    expect(await (dockerClient as any).imageState('x')).toBe('absent');
    h.daemonDown = true;
    expect(await (dockerClient as any).imageState('x')).toBe('unknown');
  });

  it('control: a clean docker and a clean disk delete and deregister', async () => {
    await expect(containerManager.deleteBot('b1', false, false)).resolves.toBe(true);
    expect(registered()).toBe(false);
  });
});

describe('B07-3 Remove never reports clean over what it could not verify', () => {
  it('a daemon that stops answering after the connection check keeps the bot registered', async () => {
    h.daemonDown = true;
    await expect(containerManager.deleteBot('b1', false, false)).rejects.toThrow(/uninstall incomplete/);
    expect(registered()).toBe(true);
  });

  it('a bot directory that cannot be stat-ed is a remnant', async () => {
    h.unstatable.add(botDir);
    await expect(containerManager.deleteBot('b1', false, false)).rejects.toThrow(new RegExp(`uninstall incomplete.*unverifiable`));
    expect(registered()).toBe(true);
  });

  it('an env copy that cannot be stat-ed is a remnant on a keep-data delete', async () => {
    const store = path.join(botDir, 'env', 'storage.json');
    h.unstatable.add(store);
    await expect(containerManager.deleteBot('b1', true, false)).rejects.toThrow(/uninstall incomplete.*storage\.json/);
    expect(registered()).toBe(true);
  });
});
