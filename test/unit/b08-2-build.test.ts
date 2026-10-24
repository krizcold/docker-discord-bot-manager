import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b08-2b-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    repo: nodePath.join(dir, 'repo'),
    head: 'a'.repeat(40),
    events: [] as string[],
    duringUp: null as null | (() => void),
    upGate: null as null | Promise<void>,
  };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const answer = (args: string[]): string => {
    const line = args.join(' ');
    if (line.startsWith('image inspect')) throw Object.assign(new Error('No such image'), { stderr: 'No such image' });
    if (line.startsWith('volume')) throw Object.assign(new Error('No such volume'), { stderr: 'No such volume' });
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
  buildImage: async () => {
    h.events.push('build-start');
    h.duringUp?.();
    if (h.upGate) await h.upGate;
    h.events.push('build-end');
  },
  composeUp: async () => {},
  composeDown: async () => {},
  verifyComposeProjectRunning: async () => ({ allRunning: true, problems: [] }),
  listBotContainers: async () => [],
  listContainersByBotId: async () => [],
  listPublishedHostPorts: () => new Map(),
  checkDockerConnection: async () => true,
  imageState: async () => 'absent',
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('simple-git', () => {
  const make = () => {
    const client: any = {
      env: () => client,
      log: async () => ({ latest: { hash: h.head, message: 'm', date: 'd' } }),
      revparse: async (args: string[]) => (args[0] === 'HEAD' ? h.head : 'main'),
      raw: async () => '',
    };
    return client;
  };
  return { default: make, simpleGit: make };
});
vi.mock('../../src/source/sourceManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/source/sourceManager')>();
  const fetchSourceHeld = async () => {
    h.events.push('fetch-start');
    h.events.push('fetch-end');
    return { hasUpdates: false, behindBy: 0 };
  };
  return {
    ...real,
    getSource: (id: string) => ({ id, url: 'https://example.invalid/o/r.git', branch: 'main', lastCommitHash: h.head, lastChecked: 1 }),
    getSourceRepoPath: () => h.repo,
    readSourceHead: async () => h.head,
    fetchSourceHeld,
    fetchSource: (id: string) => real.withSourceLock(id, fetchSourceHeld),
  };
});

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as sourceManager from '../../src/source/sourceManager';
import { logCollectors } from '../../src/build/logCollector';

const stored = (): any => JSON.parse(fs.readFileSync(path.join(h.dir, 'instances.json'), 'utf-8')).instances.b1;

beforeEach(() => {
  h.head = 'a'.repeat(40);
  h.events.length = 0;
  h.duringUp = null;
  h.upGate = null;
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', 'b1', 'env'), { recursive: true });
  fs.mkdirSync(h.repo, { recursive: true });
  fs.writeFileSync(path.join(h.repo, 'docker-compose.yml'), 'services:\n  app:\n    build: .\n');
  fs.writeFileSync(path.join(h.repo, 'Dockerfile'), 'FROM node:20\n');
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({
    instances: {
      b1: {
        id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'stopped',
        sourceType: 'git', sourceId: 's1', envVars: {}, lastBuiltCommit: 'f'.repeat(40),
        createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
      },
    },
  }));
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});


describe('a git build on a source checkout', () => {
  it('records the commit it built when the source stayed put', async () => {
    const res = await containerManager.buildBot('b1');
    expect(res.success).toBe(true);
    expect(stored().lastBuiltCommit).toBe('a'.repeat(40));
  });

  it('records nothing and says so when the source moved during the build', async () => {
    h.duringUp = () => { h.head = 'b'.repeat(40); };
    const res: any = await containerManager.buildBot('b1');
    expect(res.success).toBe(true);
    expect(stored().lastBuiltCommit).toBe('f'.repeat(40));
    expect(res.warning).toContain('the source moved from aaaaaaa to bbbbbbb during the build; build again');
  });

  it('holds a fetch of the same source until the build ends', async () => {
    let open!: () => void;
    h.upGate = new Promise<void>(r => { open = r; });
    const build = containerManager.buildBot('b1');
    for (let i = 0; i < 50 && !h.events.includes('build-start'); i++) await new Promise(r => setTimeout(r, 10));
    const fetch = sourceManager.fetchSource('s1');
    await new Promise(r => setTimeout(r, 20));
    open();
    await Promise.all([build, fetch]);
    expect(h.events).toEqual(['fetch-start', 'fetch-end', 'build-start', 'build-end', 'fetch-start', 'fetch-end']);
  });
});
