import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm10-l5-r2-routes-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const execFile = (_cmd: string, _args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    setTimeout(() => done(new Error('fail'), '', 'Cannot connect to the Docker daemon'), 1);
    return new EventEmitter();
  };
  const exec = (_cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    done(new Error('Cannot connect to the Docker daemon'));
  };
  return { ...real, execFile, exec, default: { ...real, execFile, exec } };
});
vi.mock('../../src/docker/dockerClient', async (o) => ({
  ...(await o<typeof import('../../src/docker/dockerClient')>()),
  listComposeContainers: async () => [],
  listBotContainers: async () => [],
  listContainersByBotId: async () => [],
}));
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/instance/migrate', async (o) => ({
  ...(await o<typeof import('../../src/instance/migrate')>()),
  runMigration: async () => ({ accepted: false, status: 409, error: 'refused' }),
  setMigrateListener: () => {},
}));

import * as fs from 'fs';
import * as path from 'path';
import { createBotRoutes } from '../../src/webui/routes/bots';

const SMDB = 'https://example.invalid/fake/super-modular-discord-bot';
const ENV_DIR = path.join(h.dir, 'bots', 'b', 'env');
const RECORD = { to: 'postgres', from: 'file', destination: null, companion: true, jobId: 'mgr-c1', jobIds: ['mgr-c1'], posted: true, started: 1, kept: 0, phase: 'following', loginOpened: false, sharers: [], sharersStopped: [], openedAt: 'x', text: 't' };
const inst = (id: string, over: Record<string, unknown> = {}) => ({
  id, sanitizedName: id, displayName: id.toUpperCase(), titleName: id.toUpperCase(), status: 'stopped', sourceType: 'git', sourceUrl: SMDB,
  envVars: {}, createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', ...over,
});

const router = createBotRoutes({ clients: new Set() } as any);
const call = async (routePath: string, id: string, body: unknown) => {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath && l.route.methods.put);
  const res: any = { statusCode: 200 };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  await layer.route.stack[layer.route.stack.length - 1].handle({ params: { id }, query: {}, body }, res);
  return { status: res.statusCode, body: res.body };
};

let errors: string[] = [];
beforeEach(() => {
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(ENV_DIR, { recursive: true });
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances: { b: inst('b', { migrate: { ...RECORD } }) } }));
  errors = [];
  vi.restoreAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
});
afterAll(() => { vi.restoreAllMocks(); fs.rmSync(h.dir, { recursive: true, force: true }); });

const envErrors = () => errors.filter(l => l.startsWith('[EnvManager]')).length;

describe('PUT /:id renaming a migrating bot whose env store cannot be read', () => {
  for (const [name, extra] of [['no envVars', {}], ['envVars null', { envVars: null }], ['envVars 1', { envVars: 1 }]] as const) {
    it(`${name}: the refusal reads no env store`, async () => {
      fs.writeFileSync(path.join(ENV_DIR, 'storage.json'), 'not json');
      const r = await call('/:id', 'b', { ...extra, displayName: 'Other name' });
      expect(r.status).toBe(409);
      expect(envErrors()).toBe(0);
      expect(fs.readdirSync(ENV_DIR)).toEqual(['storage.json']);
    });
  }
});

describe('PUT /:id/env with no rename on a migrating bot', () => {
  it('a store holding a value that no longer decrypts logs no more lines than the code reads it', async () => {
    fs.writeFileSync(path.join(ENV_DIR, 'storage.json'), JSON.stringify({ vars: {}, encrypted: { OLD_SECRET: 'not-v2-ciphertext' } }));
    await call('/:id/env', 'b', { vars: { FOO: 'x' } });
    expect(envErrors()).toBe(7);
  });
});
