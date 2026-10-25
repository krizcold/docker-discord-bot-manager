import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'fu-5-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    running: false,
    head: null as string | null,
    registryHash: null as string | null,
    fetchFails: false,
  };
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
// The registry's hash and the checkout's HEAD are set apart, so a row can tell which one a check read.
vi.mock('../../src/source/sourceManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/source/sourceManager')>()),
  getSource: (id: string) => (id === 's1'
    ? { id: 's1', url: 'https://example.invalid/app', branch: 'main', lastCommitHash: tmp.registryHash, composeName: null, autoUpdate: true }
    : null),
  readSourceHead: async () => tmp.head,
  fetchSource: async () => {
    if (tmp.fetchFails) throw new Error('could not reach origin');
    return { hasUpdates: false, behindBy: 0 };
  },
  getCommitsBehind: async () => 3,
  getSourceRepoInfo: async () => null,
}));

import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { createBotRoutes } from '../../src/webui/routes/bots';
import { dispatch } from '../../src/cli/commands';

const A = 'a'.repeat(40);
const UPDATE_REASON = "The source checkout's current commit could not be read, so the manager can't confirm whether an update is available.";
const B = 'b'.repeat(40);

const writeCompose = (id: string, name: string, env: Record<string, string>): void => {
  fs.writeFileSync(path.join(tmp.dir, 'bots', id, 'docker-compose.yml'), YAML.stringify({
    services: { app: { image: 'fake/app:1', container_name: `${name}-app`, labels: { 'fleet.control-port': '9500' }, environment: env } },
  }));
};

const instance = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, sanitizedName: name, displayName: name, titleName: name, status: 'running',
  sourceType: 'git', sourceUrl: 'https://example.invalid/app', envVars: {},
  createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z', ...extra,
});

const writeInstances = (instances: Record<string, unknown>): void => {
  fs.writeFileSync(path.join(tmp.dir, 'instances.json'), JSON.stringify({ instances }));
};

beforeEach(() => {
  tmp.running = false;
  tmp.head = B;
  tmp.registryHash = A;
  tmp.fetchFails = false;
  fs.rmSync(path.join(tmp.dir, 'bots'), { recursive: true, force: true });
  for (const id of ['b1', 'b2']) fs.mkdirSync(path.join(tmp.dir, 'bots', id, 'env'), { recursive: true });
  writeInstances({ b1: instance('b1', 'bot1', { sourceId: 's1', lastBuiltCommit: A }) });
});

afterAll(() => {
  fs.rmSync(tmp.dir, { recursive: true, force: true });
});

const router = createBotRoutes({ clients: new Set() } as any);
const call = async (method: string, routePath: string, req: any): Promise<{ status: number; body: any }> => {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
  const out = { status: 200, body: undefined as any };
  const res = { status(code: number) { out.status = code; return res; }, json(body: any) { out.body = body; return res; } };
  await layer.route.stack[layer.route.stack.length - 1].handle({ query: {}, body: {}, params: {}, headers: {}, ...req }, res);
  return out;
};

describe('an update check compares the built commit with the checkout HEAD', () => {
  it('the bot detail says an update is available when HEAD moved past the built commit', async () => {
    const res = await call('get', '/:id', { params: { id: 'b1' } });
    expect(res.body.updateAvailable).toBe(true);
  });

  it('the bot list says an update is available when HEAD moved past the built commit', async () => {
    const res = await call('get', '/', {});
    expect(res.body.bots[0]).toMatchObject({ updateAvailable: true, behindBy: 3 });
  });

  it('the check-updates route answers no update when the built commit is HEAD', async () => {
    writeInstances({ b1: instance('b1', 'bot1', { sourceId: 's1', lastBuiltCommit: B }) });
    const res = await call('get', '/:id/updates', { params: { id: 'b1' } });
    expect(res.body).toMatchObject({ success: true, hasUpdates: false, behindBy: 0 });
    expect(res.body.cantConfirm).toBeUndefined();
  });

  it("every answer says can't confirm when HEAD cannot be read", async () => {
    tmp.head = null;
    const check = (await call('get', '/:id/updates', { params: { id: 'b1' } })).body;
    expect(check).toMatchObject({ success: true, hasUpdates: false });
    expect(check.cantConfirm).toMatch(/can't confirm/);
    const detail = (await call('get', '/:id', { params: { id: 'b1' } })).body;
    expect(detail.updateAvailable).toBe(false);
    expect(detail.updateCantConfirm).toMatch(/can't confirm/);
    const list = (await call('get', '/', {})).body.bots[0];
    expect(list.updateAvailable).toBe(false);
    expect(list.updateCantConfirm).toMatch(/can't confirm/);
  });

  it("says can't confirm, not up to date, when the fetch failed and the built commit is HEAD", async () => {
    tmp.fetchFails = true;
    writeInstances({ b1: instance('b1', 'bot1', { sourceId: 's1', lastBuiltCommit: B }) });
    const res = await call('get', '/:id/updates', { params: { id: 'b1' } });
    expect(res.body.hasUpdates).toBe(false);
    expect(res.body.cantConfirm).toMatch(/can't confirm/);
  });
});

describe("an update check says can't confirm when the bot's source is not in the source list", () => {
  for (const [label, extra] of [['a deleted source', { sourceId: 'gone', lastBuiltCommit: A }], ['no source id', { lastBuiltCommit: A }]] as const) {
    it(`the list and the detail say can't confirm for ${label}`, async () => {
      writeInstances({ b1: instance('b1', 'bot1', extra) });
      const detail = (await call('get', '/:id', { params: { id: 'b1' } })).body;
      expect(detail.updateAvailable).toBe(false);
      expect(detail.updateCantConfirm).toMatch(/not in the source list/);
      const list = (await call('get', '/', {})).body.bots[0];
      expect(list.updateAvailable).toBe(false);
      expect(list.updateCantConfirm).toMatch(/not in the source list/);
    });
  }
});

describe('dbm bots list', () => {
  it("prints can't confirm in the update column when the manager can't confirm", async () => {
    let out = '';
    const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(((t: string) => { out += t; return true; }) as never);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    const client = { request: async () => ({ ok: true, status: 200, body: { success: true, bots: [
      { id: 'b1', displayName: 'bot1', status: 'running', updateAvailable: false, updateCantConfirm: UPDATE_REASON },
      { id: 'b2', displayName: 'bot2', status: 'running', updateAvailable: false },
    ] } }) };
    try {
      await expect(dispatch(client as any, ['bots', 'list'], {})).rejects.toThrow('exit');
    } finally {
      write.mockRestore();
      exit.mockRestore();
      if (tty) Object.defineProperty(process.stdout, 'isTTY', tty); else delete (process.stdout as any).isTTY;
    }
    const lines = out.split('\n');
    expect(lines.find(l => l.startsWith('b1'))).toMatch(/can't confirm$/);
    expect(lines.find(l => l.startsWith('b2'))).toMatch(/false$/);
  });
});

describe('deleting an env key on a running bot', () => {
  it('marks pendingApply and says Apply is needed', async () => {
    envManager.setEnvVars('b1', { OLD_FLAG: '1', KEEP: '2' });
    tmp.running = true;
    const res = await call('delete', '/:id/env/:key', { params: { id: 'b1', key: 'OLD_FLAG' } });
    expect(res.body).toMatchObject({ success: true, notApplied: true });
    expect(res.body.message).toMatch(/Apply or Restart/);
    expect(res.body.message).not.toMatch(/still has it/);
    expect(containerManager.getBot('b1')?.pendingApply).toBe(true);
  });

  it('leaves the bot unmarked and claims nothing when the key was never stored or deployed', async () => {
    envManager.setEnvVars('b1', { KEEP: '2' });
    writeCompose('b1', 'bot1', { KEEP: '2' });
    tmp.running = true;
    const res = await call('delete', '/:id/env/:key', { params: { id: 'b1', key: 'TYPO_KEY' } });
    expect(res.body.success).toBe(true);
    expect(res.body.notApplied).toBeUndefined();
    expect(res.body.message).toBeUndefined();
    expect(containerManager.getBot('b1')?.pendingApply).toBeUndefined();
  });

  it('leaves a stopped bot unmarked', async () => {
    envManager.setEnvVars('b1', { OLD_FLAG: '1', KEEP: '2' });
    const res = await call('delete', '/:id/env/:key', { params: { id: 'b1', key: 'OLD_FLAG' } });
    expect(res.body.success).toBe(true);
    expect(res.body.notApplied).toBeUndefined();
    expect(containerManager.getBot('b1')?.pendingApply).toBeUndefined();
  });
});

describe('the fleet master list pairs secondaries by the deployed secret', () => {
  beforeEach(() => {
    writeInstances({ b1: instance('b1', 'bot1'), b2: instance('b2', 'bot2') });
  });

  it('pairs a standby whose deployed secret is the master deployed secret, though its saved one differs', async () => {
    envManager.setEnvVars('b1', { FLEET_SECRET: 'run-secret' });
    writeCompose('b1', 'bot1', { FLEET_SECRET: 'run-secret' });
    envManager.setEnvVars('b2', { FLEET_ROLE: 'standby', FLEET_SECRET: 'saved-later' });
    writeCompose('b2', 'bot2', { FLEET_ROLE: 'standby', FLEET_SECRET: 'run-secret' });
    const m = (await call('get', '/fleet/masters', {})).body.masters[0];
    expect(m.localCandidates).toEqual(['ws://bot1-app:9500', 'ws://bot2-app:9500']);
  });

  it('does not pair a standby whose saved secret matches but whose deployed one does not', async () => {
    envManager.setEnvVars('b1', { FLEET_SECRET: 'run-secret' });
    writeCompose('b1', 'bot1', { FLEET_SECRET: 'run-secret' });
    envManager.setEnvVars('b2', { FLEET_ROLE: 'standby', FLEET_SECRET: 'run-secret' });
    writeCompose('b2', 'bot2', { FLEET_ROLE: 'standby', FLEET_SECRET: 'other-fleet' });
    const m = (await call('get', '/fleet/masters', {})).body.masters[0];
    expect(m.localCandidates).toEqual(['ws://bot1-app:9500']);
  });

  it('pairs by the master deployed secret when its saved one was changed and not applied', async () => {
    envManager.setEnvVars('b1', { FLEET_SECRET: 'saved-not-deployed' });
    writeCompose('b1', 'bot1', { FLEET_SECRET: 'run-secret' });
    envManager.setEnvVars('b2', { FLEET_ROLE: 'standby', FLEET_SECRET: 'run-secret' });
    writeCompose('b2', 'bot2', { FLEET_ROLE: 'standby', FLEET_SECRET: 'run-secret' });
    const m = (await call('get', '/fleet/masters', {})).body.masters[0];
    expect(m.controlSecret).toBe('');
    expect(m.localCandidates).toEqual(['ws://bot1-app:9500', 'ws://bot2-app:9500']);
  });
});
