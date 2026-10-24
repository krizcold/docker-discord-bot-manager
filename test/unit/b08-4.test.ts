import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b08-4-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, ps: 'abc123\n' as string | null, downCalls: 0, fetchError: null as string | null, cloned: true, repo: nodePath.join(dir, 'repo') };
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
    if (cmd.startsWith('docker ps')) done(null, { stdout: h.ps, stderr: '' });
    else if (cmd.startsWith('docker inspect')) done(new Error('Error: No such object'));
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
  composeDown: async () => { h.downCalls++; },
  removeImage: async () => { throw new Error('the image must be kept'); },
  verifyComposeProjectRunning: async () => ({ allRunning: true, problems: [] }),
  listBotContainers: async () => [],
  listContainersByBotId: async () => [],
  checkDockerConnection: async () => true,
  imageExists: async () => true,
}));
vi.mock('../../src/source/sourceManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/source/sourceManager')>()),
  getSource: (id: string) => (id === 's1' ? { id: 's1', url: 'https://user:sekret@example.com/r.git', branch: 'main' } : null),
  getSourceRepoPath: () => h.repo,
  fetchSource: async () => { if (h.fetchError) throw new Error(h.fetchError); return { hasUpdates: false, behindBy: 0 }; },
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import { scanSourceForEnvVars } from '../../src/env/manager';
import { detectBotType } from '../../src/detection';
import { validateDiscordId } from '../../src/discord/validator';

const seed = (): void => {
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({
    instances: {
      b1: {
        id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'running',
        sourceType: 'git', sourceId: 's1', envVars: {},
        createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
      },
    },
  }));
};

beforeEach(() => {
  h.downCalls = 0; h.fetchError = null;
  fs.rmSync(h.repo, { recursive: true, force: true });
  fs.mkdirSync(path.join(h.repo, '.git'), { recursive: true });
  seed();
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('B08-4 Update checks the clone before it stops the bot', () => {
  it('a failed fetch refuses, names the git error without the credential, and never stops the bot', async () => {
    h.fetchError = 'fatal: unable to access https://user:sekret@example.com/r.git: Could not resolve host';
    const res = await containerManager.pullAndRebuild('b1');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Could not resolve host/);
    expect(res.error).toMatch(/the bot was not stopped and its image was kept/);
    expect(res.error).not.toMatch(/sekret/);
    expect(h.downCalls).toBe(0);
    expect(containerManager.getBot('b1')?.status).toBe('running');
  });

  it('a missing clone refuses and never stops the bot', async () => {
    fs.rmSync(path.join(h.repo, '.git'), { recursive: true, force: true });
    const res = await containerManager.pullAndRebuild('b1');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/no usable clone; the bot was not stopped/);
    expect(h.downCalls).toBe(0);
    expect(containerManager.getBot('b1')?.status).toBe('running');
  });
});

describe('B08-4 a source scan that stopped at its file cap says so', () => {
  const big = path.join(h.dir, 'big');
  const fill = (n: number, tokenFile = false): void => {
    fs.rmSync(big, { recursive: true, force: true });
    fs.mkdirSync(big, { recursive: true });
    for (let i = 0; i < n; i++) fs.writeFileSync(path.join(big, `f${String(i).padStart(4, '0')}.js`), 'x');
    if (tokenFile) fs.writeFileSync(path.join(big, 'zz.js'), 'process.env.FOO');
  };

  it('reports how many files it read of how many', () => {
    fill(405);
    const scan = scanSourceForEnvVars(big);
    expect(scan.scanned).toBe(400);
    expect(scan.total).toBe(405);
  });

  it('a complete scan reports every file read', () => {
    fill(3, true);
    const scan = scanSourceForEnvVars(big);
    expect(scan).toEqual({ vars: ['FOO'], scanned: 4, total: 4 });
  });

  it('the token fallback from a capped scan is marked not checked', () => {
    fill(405);
    const d = detectBotType(big);
    expect(d.tokenVarDetected).toBe(false);
    expect(d.tokenVarUnchecked).toEqual({ scanned: 400, total: 405 });
  });
});

describe('B08-4 the Discord validator names a rejected token and a refused read', () => {
  const realFetch = globalThis.fetch;
  afterAll(() => { globalThis.fetch = realFetch; });
  const answer = (status: number) => {
    globalThis.fetch = (async () => ({ status, json: async () => ({}) })) as unknown as typeof fetch;
  };

  it('no token is still "token"', async () => {
    expect((await validateDiscordId('', 'user', '123456789012')).reason).toBe('token');
  });
  it('a 401 is token_rejected, live and latched', async () => {
    answer(401);
    expect((await validateDiscordId('tok-a', 'user', '123456789012')).reason).toBe('token_rejected');
    expect((await validateDiscordId('tok-a', 'user', '123456789013')).reason).toBe('token_rejected');
  });
  it('a 403 on a guild read gives a reason', async () => {
    answer(403);
    const r = await validateDiscordId('tok-b', 'guild', '123456789012');
    expect(r).toEqual({ status: 'cannot_validate', reason: 'forbidden' });
  });
});
