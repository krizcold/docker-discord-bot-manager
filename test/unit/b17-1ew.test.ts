import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b17-1ew-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    repo: nodePath.join(dir, 'repo'),
    head: 'a'.repeat(40),
    torn: false,
    failRename: false,
    modes: [] as number[],
  };
});

const MARK = 'B17_MARK';

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const text = (data: unknown): string => (typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf-8') : '');
  const fdPaths = new Map<number, string>();
  const envTarget = (target: any): boolean => /[\\/]\.env(\.tmp\.[^\\/]*)?$/.test(typeof target === 'number' ? fdPaths.get(target) ?? '' : String(target));
  const openSync = (p: any, ...rest: any[]) => {
    const fd = (real.openSync as any)(p, ...rest);
    fdPaths.set(fd, String(p));
    return fd;
  };
  const modeOf = (target: any): number => (typeof target === 'number' ? real.fstatSync(target).mode : real.statSync(target).mode);
  const writeFileSync = (target: any, data: any, opts?: any) => {
    if (envTarget(target) && text(data).includes(MARK)) {
      if (h.torn) {
        real.writeFileSync(target, text(data).slice(0, 5), opts);
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      }
      real.writeFileSync(target, data, opts);
      h.modes.push(modeOf(target) & 0o777);
      return;
    }
    return real.writeFileSync(target, data, opts);
  };
  const writeSync = (fd: number, data: any, ...rest: any[]) => {
    if (envTarget(fd) && text(data).includes(MARK)) {
      if (h.torn) {
        real.writeSync(fd, text(data).slice(0, 5));
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      }
      const n = (real.writeSync as any)(fd, data, ...rest);
      h.modes.push(real.fstatSync(fd).mode & 0o777);
      return n;
    }
    return (real.writeSync as any)(fd, data, ...rest);
  };
  const renameSync = (a: any, b: any) => {
    if (h.failRename && String(b).endsWith('.env')) {
      throw Object.assign(new Error(`EIO: i/o error, rename '${a}' -> '${b}'`), { code: 'EIO' });
    }
    return real.renameSync(a, b);
  };
  const mod = { ...real, openSync, writeFileSync, writeSync, renameSync };
  return { ...mod, default: mod };
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
  const exec = (cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (cmd.startsWith('docker inspect')) done(new Error('Error: No such object'));
    else if (cmd.startsWith('docker rm')) done(new Error('Error: No such container'));
    else done(null, { stdout: '', stderr: '' });
  };
  const mod = { ...real, exec, execFile, execFileSync, execSync: () => '' };
  return { ...mod, default: mod };
});
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'casaos',
}));
vi.mock('../../src/casaos/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/api')>()),
  deployApp: async () => ({ success: true }),
}));
vi.mock('../../src/docker/dockerClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
  pullImage: async () => {},
  buildImage: async () => {},
  composeUp: async () => {},
  composeDown: async () => {},
  verifyComposeProjectRunning: async () => ({ allRunning: true, problems: [] }),
  listBotContainers: async () => [{ id: 'c1', name: 'bot1', botId: 'b1', state: 'running' }],
  listContainersByBotId: async () => [],
  listPublishedHostPorts: () => new Map(),
  checkDockerConnection: async () => true,
  imageState: async () => 'present',
}));
vi.mock('../../src/templates/pcsProcessing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/templates/pcsProcessing')>()),
  fixPostDeployOwnership: async () => {},
  executeInstallCommand: async () => true,
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
  return {
    ...real,
    getSource: (id: string) => ({ id, url: 'https://example.invalid/o/r.git', branch: 'main', lastCommitHash: h.head, lastChecked: 1 }),
    getSourceRepoPath: () => h.repo,
    readSourceHead: async () => h.head,
    fetchSourceHeld: async () => ({ hasUpdates: false, behindBy: 0 }),
  };
});

import * as fs from 'fs';
import * as path from 'path';
import { writeComposeEnvFile } from '../../src/templates/pcsProcessing';
import * as containerManager from '../../src/docker/containerManager';

const appDir = path.join(h.dir, 'DATA', 'AppData', 'casaos', 'apps', 'bot1');
const envPath = path.join(appDir, '.env');
const botDir = path.join(h.dir, 'bots', 'b1');
const OLD = 'A=old\nB=kept\n';
const compose = 'name: bot1\nservices:\n  bot:\n    image: example/bot:1\nx-casaos:\n  main: bot\n';
const leftovers = (): string[] => fs.readdirSync(appDir).filter(n => n !== '.env' && n.startsWith('.env'));

const writeRegistry = (b1: Record<string, unknown>): void => {
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({
    instances: {
      b1: {
        id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'stopped',
        envVars: { A: MARK }, containerIds: [], lastBuiltCommit: 'f'.repeat(40),
        createdAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-25T00:00:00.000Z',
        ...b1,
      },
    },
  }));
};

beforeEach(() => {
  h.torn = false;
  h.failRename = false;
  h.modes.length = 0;
  fs.rmSync(path.join(h.dir, 'DATA'), { recursive: true, force: true });
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(path.join(botDir, 'env'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'docker-compose.yml'), compose);
  fs.writeFileSync(path.join(botDir, 'docker-compose.yml'), compose);
  fs.mkdirSync(h.repo, { recursive: true });
  fs.writeFileSync(path.join(h.repo, 'docker-compose.yml'), 'services:\n  app:\n    build: .\n');
  fs.writeFileSync(path.join(h.repo, 'Dockerfile'), 'FROM node:20\n');
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('B17-1ew writeComposeEnvFile replaces the .env whole', () => {
  it('a write that fails half way leaves the old .env byte for byte and no temp file', async () => {
    fs.writeFileSync(envPath, OLD);
    h.torn = true;
    const err = await writeComposeEnvFile('bot1', { A: MARK }, () => {}).then(() => null, (e: Error) => e);
    expect(fs.readFileSync(envPath, 'utf-8')).toBe(OLD);
    expect(err?.message).toMatch(/could not be written/);
    expect(leftovers()).toEqual([]);
  });

  it('a failed rename leaves the old .env byte for byte and no temp file', async () => {
    fs.writeFileSync(envPath, OLD);
    h.failRename = true;
    const err = await writeComposeEnvFile('bot1', { A: MARK }, () => {}).then(() => null, (e: Error) => e);
    expect(fs.readFileSync(envPath, 'utf-8')).toBe(OLD);
    expect(err?.message).toMatch(/could not be written/);
    expect(leftovers()).toEqual([]);
  });

  it('a directory at the .env path is kept and the write fails', async () => {
    fs.mkdirSync(path.join(envPath, 'inner'), { recursive: true });
    const err = await writeComposeEnvFile('bot1', { A: MARK }, () => {}).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/could not be written/);
    expect(fs.existsSync(path.join(envPath, 'inner'))).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  it('a successful write replaces the .env and removes a temp file a killed write left', async () => {
    fs.writeFileSync(envPath, OLD);
    fs.writeFileSync(path.join(appDir, `.env.tmp.4242.0123abcd`), 'A=half');
    await writeComposeEnvFile('bot1', { A: MARK }, () => {});
    expect(fs.readFileSync(envPath, 'utf-8')).toBe(`A=${MARK}\n`);
    expect(leftovers()).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('the new values are never readable beyond mode 600 (Linux)', async () => {
    fs.writeFileSync(envPath, OLD);
    fs.chmodSync(envPath, 0o644);
    await writeComposeEnvFile('bot1', { A: MARK }, () => {});
    expect(h.modes.length).toBeGreaterThan(0);
    for (const m of h.modes) expect(m & 0o077).toBe(0);
    expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
  });
});

describe('B17-1ew the git start and the build report a failed .env write', () => {
  it('a casaos git start lists the .env as not applied instead of failing', async () => {
    writeRegistry({ sourceType: 'git', repoUrl: 'https://example.invalid/r.git', pendingApply: true });
    fs.writeFileSync(envPath, OLD);
    h.torn = true;
    const r = await containerManager.startBot('b1');
    expect(r.error).toBeUndefined();
    expect(r.success).toBe(true);
    expect(r.warning).toMatch(/not applied: the \.env file \(could not be written/);
    expect(r.notApplied?.some(n => n.startsWith('the .env file ('))).toBe(true);
    expect(fs.readFileSync(envPath, 'utf-8')).toBe(OLD);
  }, 20000);

  it('a casaos image start keeps reporting the .env as not applied', async () => {
    writeRegistry({ sourceType: 'docker-image', imageRef: 'example/bot:1' });
    fs.writeFileSync(envPath, OLD);
    h.torn = true;
    const r = await containerManager.startBot('b1');
    expect(r.success).toBe(true);
    expect(r.warning).toMatch(/not applied: the \.env file \(could not be written/);
    expect(fs.readFileSync(envPath, 'utf-8')).toBe(OLD);
  }, 20000);

  it('a casaos git build finishes and names the .env as not written', async () => {
    writeRegistry({ sourceType: 'git', sourceId: 's1' });
    fs.writeFileSync(envPath, OLD);
    h.torn = true;
    const r: any = await containerManager.buildBot('b1');
    expect(r.error).toBeUndefined();
    expect(r.success).toBe(true);
    expect(r.warning).toMatch(/the \.env file \(could not be written/);
    expect(r.notApplied?.some((n: string) => n.startsWith('the .env file ('))).toBe(true);
    expect(fs.readFileSync(envPath, 'utf-8')).toBe(OLD);
  }, 20000);

  it('a casaos git build with a writable .env writes it and gives no warning about it', async () => {
    writeRegistry({ sourceType: 'git', sourceId: 's1' });
    fs.writeFileSync(envPath, OLD);
    const r: any = await containerManager.buildBot('b1');
    expect(r.success).toBe(true);
    expect(r.warning ?? '').not.toContain('.env');
    expect(fs.readFileSync(envPath, 'utf-8')).toMatch(new RegExp(`^A=${MARK}$`, 'm'));
  }, 20000);
});
