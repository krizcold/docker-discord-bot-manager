import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b17-1l-'));
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
import { createBotRoutes } from '../../src/webui/routes/bots';

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

describe('B17-1 lanes: Start and Build apply what they report', () => {
  it('a casaos docker-image start writes a saved env value into the compose and the .env', async () => {
    writeRegistry({ sourceType: 'docker-image', imageRef: 'example/bot:1', envVars: { DB_PASSWORD: 'new$val' } });
    const r = await containerManager.startBot('b1');
    expect(r.success).toBe(true);
    const env = (parseDocument(fs.readFileSync(deployed, 'utf-8')).toJSON() as any).services.bot.environment;
    expect(env.DB_PASSWORD).toBe('new$$val');
    expect(fs.readFileSync(path.join(appDir, '.env'), 'utf-8')).toContain("DB_PASSWORD='new$val'");
  }, 20000);

  it('a build whose config file write fails fails and names the path', async () => {
    writeRegistry({ sourceType: 'docker-image', imageRef: 'example/bot:1' });
    configFileManager.setConfigFiles('b1', [{ path: '/app/settings.json', body: '{}' }]);
    // A folder where the config file goes makes its write fail.
    fs.mkdirSync(path.join(h.dir, 'DATA', 'AppData', 'bot1', 'config', 'settings.json'), { recursive: true });
    const r = await containerManager.buildBot('b1');
    expect(r.success).toBe(false);
    expect(r.error).toContain('/app/settings.json');
  }, 20000);

  it('a build that fails after delivery leaves no mount record, so the next start says so', async () => {
    writeRegistry({ sourceType: 'docker-image', imageRef: 'example/bot:1' });
    configFileManager.setConfigFiles('b1', [{ path: '/app/settings.json', body: '{}', readOnly: false }]);
    configFileManager.setBuiltMounts('b1', ['/app/settings.json:ro']);
    fs.mkdirSync(path.join(h.dir, 'DATA', 'AppData', 'bot1', 'config', 'settings.json'), { recursive: true });
    expect((await containerManager.buildBot('b1')).success).toBe(false);
    expect(fs.existsSync(path.join(botDir, 'env', 'builtMounts.json'))).toBe(false);
    fs.rmSync(path.join(h.dir, 'DATA', 'AppData', 'bot1', 'config', 'settings.json'), { recursive: true, force: true });
    writeRegistry({ sourceType: 'docker-image', imageRef: 'example/bot:1' });
    const r = await containerManager.startBot('b1');
    expect(r.warning).toContain('no record of the mounts the last build authored');
  }, 20000);

  it('a start with no mount record says it has none, not that the mounts changed', async () => {
    writeRegistry({ sourceType: 'docker-image', imageRef: 'example/bot:1' });
    configFileManager.setConfigFiles('b1', [{ path: '/app/config.json', body: '{}' }]);
    const r = await containerManager.startBot('b1');
    expect(r.warning).toContain('config file mounts (no record of the mounts the last build authored; press Build, then Restart, to be sure)');
    expect(r.warning).not.toContain('changed since the last build');
  }, 20000);

  it('a start of a bot that never had a config file reports nothing about mounts', async () => {
    writeRegistry({ sourceType: 'docker-image', imageRef: 'example/bot:1' });
    const r = await containerManager.startBot('b1');
    expect(r.success).toBe(true);
    expect(r.warning ?? '').not.toContain('config file mounts');
    expect(instance().pendingApply ?? null).toBeFalsy();
  }, 20000);

  it('a failed post-install runs again at the next start, even after a later running record', async () => {
    writeRegistry({ sourceType: 'git', repoUrl: 'https://example.invalid/r.git' });
    h.post = [false];
    const first = await containerManager.startBot('b1');
    expect(first.success).toBe(true);
    expect(first.warning).toContain('post-install');
    expect(h.postRuns).toBe(1);
    h.cid = 'c2';
    await containerManager.syncContainerStates();
    expect(instance().containerIds).toEqual(['c2']);
    const reg = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    reg.instances.b1.status = 'stopped';
    fs.writeFileSync(registryPath, JSON.stringify(reg));
    await containerManager.startBot('b1');
    expect(h.postRuns).toBe(2);
    expect(instance().hasBeenStarted).toBe(true);
  }, 30000);

  it('a start after a readOnly flip says the mounts wait for Update', async () => {
    writeRegistry({ sourceType: 'docker-image', imageRef: 'example/bot:1' });
    configFileManager.setConfigFiles('b1', [{ path: '/app/settings.json', body: '{}', readOnly: true }]);
    configFileManager.setBuiltMounts('b1', ['/app/settings.json:ro']);
    configFileManager.setConfigFiles('b1', [{ path: '/app/settings.json', body: '{}', readOnly: false }]);
    const r = await containerManager.startBot('b1');
    expect(r.success).toBe(true);
    expect(r.warning).toContain('config file mounts changed since the last build (press Build, then Restart)');
  }, 20000);

  it('a start names Build, not a bare Restart retry, for a config file added after the build', async () => {
    writeRegistry({ sourceType: 'docker-image', imageRef: 'example/bot:1' });
    configFileManager.setConfigFiles('b1', [{ path: '/app/new.json', body: '{}' }]);
    configFileManager.setBuiltMounts('b1', ['/app/new.json:ro']);
    const r = await containerManager.startBot('b1');
    expect(r.success).toBe(true);
    expect(r.warning).toContain('config files not mounted yet (press Build, then Restart, to mount): /app/new.json');
    expect(r.warning).not.toContain('Apply or Restart to retry');
  }, 20000);
});

describe('B17-1 PUT /config answers whether the mounts need a build', () => {
  const router = createBotRoutes({ clients: new Set() } as any);
  const put = async (files: unknown[]): Promise<any> => {
    const layer = (router as any).stack.find((l: any) => l.route?.path === '/:id/config' && l.route.methods.put);
    const res: any = { statusCode: 200 };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    await layer.route.stack[layer.route.stack.length - 1].handle({ params: { id: 'b1' }, query: {}, body: { files } }, res);
    return res.body;
  };

  it('a readOnly flip answers needsUpdate, a body edit does not', async () => {
    writeRegistry({ sourceType: 'docker-image', imageRef: 'example/bot:1' });
    configFileManager.setBuiltMounts('b1', ['/app/settings.json:ro']);
    expect((await put([{ path: '/app/settings.json', body: '{"a":1}', readOnly: true }])).needsUpdate).toBe(false);
    expect((await put([{ path: '/app/settings.json', body: '{"a":1}', readOnly: false }])).needsUpdate).toBe(true);
  });

  it('with no mount record it answers mountsUnknown, not needsUpdate', async () => {
    writeRegistry({ sourceType: 'docker-image', imageRef: 'example/bot:1' });
    const body = await put([{ path: '/app/config.json', body: '{}' }]);
    expect(body.needsUpdate).toBe(false);
    expect(body.mountsUnknown).toBe(true);
  });
});
