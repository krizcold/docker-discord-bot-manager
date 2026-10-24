import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b17-3l-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, cid: 'c1', post: [] as boolean[], postRuns: 0 };
});

// docker answers nothing; every command succeeds with empty output.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFileSync = () => '';
  const execFile = (_f: string, _a: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    done(null, { stdout: '', stderr: '' });
  };
  const exec = (_c: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    done(null, { stdout: '', stderr: '' });
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
  listBotContainers: async () => [{ id: h.cid, name: 'bot1', botId: 'b1', state: 'running' }],
  listContainersByBotId: async () => [],
  checkDockerConnection: async () => true,
}));
vi.mock('../../src/templates/pcsProcessing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/templates/pcsProcessing')>()),
  fixPostDeployOwnership: async () => {},
  grantToApp: () => {},
  executeInstallCommand: async (phase: string) => {
    if (phase !== 'post') return true;
    h.postRuns++;
    return h.post.shift() ?? true;
  },
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import { parseDocument } from 'yaml';
import * as containerManager from '../../src/docker/containerManager';
import * as configFileManager from '../../src/config/configFileManager';

const registryPath = path.join(h.dir, 'instances.json');
const appDir = path.join(h.dir, 'DATA', 'AppData', 'casaos', 'apps', 'bot1');
const deployed = path.join(appDir, 'docker-compose.yml');
const botDir = path.join(h.dir, 'bots', 'b1');

const writeRegistry = (b1: Record<string, unknown>): void => {
  fs.writeFileSync(registryPath, JSON.stringify({
    instances: {
      b1: {
        id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'stopped',
        envVars: {}, containerIds: [], createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
        ...b1,
      },
    },
  }));
};
const instance = (): any => JSON.parse(fs.readFileSync(registryPath, 'utf-8')).instances.b1;
const compose = 'name: bot1\nservices:\n  bot:\n    image: example/bot:1\n    environment:\n      DB_PASSWORD: old\nx-casaos:\n  main: bot\n';

beforeEach(() => {
  fs.rmSync(path.join(h.dir, 'DATA'), { recursive: true, force: true });
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(botDir, { recursive: true });
  fs.writeFileSync(deployed, compose);
  fs.writeFileSync(path.join(botDir, 'docker-compose.yml'), compose);
  h.cid = 'c1';
  h.post = [];
  h.postRuns = 0;
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('B17-3 lanes: a rebuild replaces only what the manager delivered', () => {
  const hostFile = () => path.join(h.dir, 'DATA', 'AppData', 'bot1', '.smdb-config', 'app', 'settings.json');

  it('a second build delivers an edited body over the file the first build wrote', async () => {
    writeRegistry({ sourceType: 'docker-image', imageRef: 'example/bot:1' });
    configFileManager.setConfigFiles('b1', [{ path: '/app/settings.json', body: '{"v":1}' }]);
    expect((await containerManager.buildBot('b1')).success).toBe(true);
    expect(fs.readFileSync(hostFile(), 'utf-8')).toBe('{"v":1}');
    configFileManager.setConfigFiles('b1', [{ path: '/app/settings.json', body: '{"v":2}' }]);
    writeRegistry({ sourceType: 'docker-image', imageRef: 'example/bot:1' });
    expect((await containerManager.buildBot('b1')).success).toBe(true);
    expect(fs.readFileSync(hostFile(), 'utf-8')).toBe('{"v":2}');
  }, 20000);

  it('a build over a host file changed since delivery keeps it and fails naming the path', async () => {
    writeRegistry({ sourceType: 'docker-image', imageRef: 'example/bot:1' });
    configFileManager.setConfigFiles('b1', [{ path: '/app/settings.json', body: '{"v":1}' }]);
    expect((await containerManager.buildBot('b1')).success).toBe(true);
    fs.writeFileSync(hostFile(), '{"operator":true}');
    configFileManager.setConfigFiles('b1', [{ path: '/app/settings.json', body: '{"v":2}' }]);
    writeRegistry({ sourceType: 'docker-image', imageRef: 'example/bot:1' });
    const r = await containerManager.buildBot('b1');
    expect(r.success).toBe(false);
    expect(r.error).toContain('/app/settings.json');
    expect(fs.readFileSync(hostFile(), 'utf-8')).toBe('{"operator":true}');
  }, 20000);

  it('a file turned off for one build keeps its delivery record, so turning it on with a new body replaces it', async () => {
    const other = path.join(h.dir, 'DATA', 'AppData', 'bot1', '.smdb-config', 'app', 'other.json');
    writeRegistry({ sourceType: 'docker-image', imageRef: 'example/bot:1' });
    configFileManager.setConfigFiles('b1', [{ path: '/app/settings.json', body: '{"v":1}' }, { path: '/app/other.json', body: '{"o":1}' }]);
    expect((await containerManager.buildBot('b1')).success).toBe(true);
    configFileManager.setConfigFiles('b1', [{ path: '/app/settings.json', body: '{"v":1}', enabled: false }, { path: '/app/other.json', body: '{"o":1}' }]);
    writeRegistry({ sourceType: 'docker-image', imageRef: 'example/bot:1' });
    expect((await containerManager.buildBot('b1')).success).toBe(true);
    configFileManager.setConfigFiles('b1', [{ path: '/app/settings.json', body: '{"v":2}' }, { path: '/app/other.json', body: '{"o":1}' }]);
    writeRegistry({ sourceType: 'docker-image', imageRef: 'example/bot:1' });
    const r = await containerManager.buildBot('b1');
    expect(r.error).toBeUndefined();
    expect(r.success).toBe(true);
    expect(fs.readFileSync(hostFile(), 'utf-8')).toBe('{"v":2}');
    expect(fs.readFileSync(other, 'utf-8')).toBe('{"o":1}');
  }, 30000);
});
