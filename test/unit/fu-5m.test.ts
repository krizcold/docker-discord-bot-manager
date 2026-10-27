import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'fu-5m-'));
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
import * as containerManager from '../../src/docker/containerManager';
import { createBotRoutes } from '../../src/webui/routes/bots';
import { dispatch } from '../../src/cli/commands';

const A = 'a'.repeat(40);
const UPDATE_REASON = "The source checkout's current commit could not be read, so the manager can't confirm whether an update is available.";
const B = 'b'.repeat(40);

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
describe('the check-updates route with no recorded built commit', () => {
  it("answers can't confirm with a reason, not an update", async () => {
    writeInstances({ b1: instance('b1', 'bot1', { sourceId: 's1' }) });
    const res = await call('get', '/:id/updates', { params: { id: 'b1' } });
    expect(res.body).toMatchObject({ success: true, hasUpdates: false, behindBy: 0 });
    expect(res.body.cantConfirm).toMatch(/can't confirm/);
  });
});

describe('the bot list and detail with no recorded built commit', () => {
  it("the detail says can't confirm with a reason", async () => {
    writeInstances({ b1: instance('b1', 'bot1', { sourceId: 's1' }) });
    const detail = (await call('get', '/:id', { params: { id: 'b1' } })).body;
    expect(detail.updateAvailable).toBe(false);
    expect(detail.updateCantConfirm).toMatch(/no record of the commit/);
  });

  it("the list says can't confirm with a reason", async () => {
    writeInstances({ b1: instance('b1', 'bot1', { sourceId: 's1' }) });
    const list = (await call('get', '/', {})).body.bots[0];
    expect(list.updateAvailable).toBe(false);
    expect(list.updateCantConfirm).toMatch(/no record of the commit/);
  });
});
