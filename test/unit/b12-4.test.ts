import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b12-4-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, running: false };
});

// docker ps answers a container id while tmp.running is set; nothing else answers.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const exec = (cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (cmd.startsWith('docker inspect')) done(new Error('Error: No such object'));
    else if (cmd.startsWith('docker ps')) done(null, { stdout: tmp.running ? 'abc123\n' : '', stderr: '' });
    else done(null, { stdout: '', stderr: '' });
  };
  return { ...real, exec, default: { ...real, exec } };
});
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/config/appCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/config/appCapabilities')>()),
  findAppCapabilities: () => ({
    controlPlane: {
      groupSecretEnv: 'FLEET_SECRET',
      roleEnv: { key: 'FLEET_ROLE', default: 'leader', dialTargetOrder: ['leader', 'standby'], dialsOut: ['worker'] },
      urlScheme: { secure: 'wss', plain: 'ws' },
    },
  }),
}));

import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { createBotRoutes } from '../../src/webui/routes/bots';

const botDir = path.join(tmp.dir, 'bots', 'b1');
const composePath = path.join(botDir, 'docker-compose.yml');

const writeCompose = (env: Record<string, string>): void => {
  fs.writeFileSync(composePath, YAML.stringify({
    services: { app: { image: 'fake/app:1', container_name: 'bot1-app', labels: { 'fleet.control-port': '9500' }, environment: env } },
  }));
};

beforeEach(() => {
  tmp.running = false;
  fs.rmSync(path.join(tmp.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(botDir, 'env'), { recursive: true });
  fs.writeFileSync(path.join(tmp.dir, 'instances.json'), JSON.stringify({
    instances: {
      b1: {
        id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'running',
        sourceType: 'git', sourceUrl: 'https://example.invalid/app', envVars: {},
        createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
      },
    },
  }));
  envManager.setEnvVars('b1', { FLEET_SECRET: 'deployed-secret' });
  writeCompose({ FLEET_SECRET: 'deployed-secret' });
});

afterAll(() => {
  fs.rmSync(tmp.dir, { recursive: true, force: true });
});

const router = createBotRoutes({ clients: new Set() } as any);
const call = async (method: string, routePath: string, req: any): Promise<{ status: number; body: any }> => {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
  const out = { status: 200, body: undefined as any };
  const res = { status(code: number) { out.status = code; return res; }, json(body: any) { out.body = body; return res; } };
  await layer.route.stack[layer.route.stack.length - 1].handle({ query: {}, body: {}, params: {}, ...req }, res);
  return out;
};

describe('the wizard master list offers only the secret the master was deployed with', () => {
  it('fills the secret when the saved and deployed secrets agree', async () => {
    const res = await call('get', '/fleet/masters', {});
    expect(res.body.masters).toHaveLength(1);
    expect(res.body.masters[0]).toMatchObject({ secretSet: true, controlSecret: 'deployed-secret', secretUnfilled: null });
  });

  it('leaves the secret unfilled, with the reason, when the saved secret was never deployed', async () => {
    envManager.setEnvVars('b1', { FLEET_SECRET: 'saved-not-deployed' });
    const res = await call('get', '/fleet/masters', {});
    const m = res.body.masters[0];
    expect(m.controlSecret).toBe('');
    expect(m.secretUnfilled).toMatch(/not the one it was deployed with/);
    expect(m.secretUnfilled).toMatch(/Restart Bot 1/);
  });

  it('compares only the compose that is deployed, not a stale bot-dir copy', async () => {
    const casaDir = path.join(tmp.dir, 'DATA', 'AppData', 'casaos', 'apps', 'bot1');
    fs.mkdirSync(casaDir, { recursive: true });
    try {
      fs.writeFileSync(path.join(casaDir, 'docker-compose.yml'), YAML.stringify({
        services: { app: { image: 'fake/app:1', container_name: 'bot1-app', labels: { 'fleet.control-port': '9500' }, environment: { FLEET_SECRET: 'new-secret' } } },
      }));
      envManager.setEnvVars('b1', { FLEET_SECRET: 'new-secret' });
      const m = (await call('get', '/fleet/masters', {})).body.masters[0];
      expect(m).toMatchObject({ controlSecret: 'new-secret', secretUnfilled: null });
    } finally {
      fs.rmSync(path.join(tmp.dir, 'DATA'), { recursive: true, force: true });
    }
  });

  it('leaves the secret unfilled when the deployed compose does not set it', async () => {
    writeCompose({});
    const m = (await call('get', '/fleet/masters', {})).body.masters[0];
    expect(m.controlSecret).toBe('');
    expect(m.secretUnfilled).toBeTruthy();
  });
});

describe('an env save to a running bot is marked not applied', () => {
  it('sets pendingApply and says so in the reply', async () => {
    tmp.running = true;
    const res = await call('put', '/:id/env', { params: { id: 'b1' }, body: { vars: { FLEET_SECRET: 'new' } } });
    expect(res.body).toMatchObject({ success: true, notApplied: true });
    expect(containerManager.getBot('b1')?.pendingApply).toBe(true);
  });

  it('leaves a stopped bot unmarked', async () => {
    const res = await call('put', '/:id/env', { params: { id: 'b1' }, body: { vars: { FLEET_SECRET: 'new' } } });
    expect(res.body.success).toBe(true);
    expect(res.body.notApplied).toBeUndefined();
    expect(containerManager.getBot('b1')?.pendingApply).toBeUndefined();
  });
});
