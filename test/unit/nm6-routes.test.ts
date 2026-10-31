import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm6-routes-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

vi.mock('child_process', async (o) => (await import('./switch-harness')).childProcessMock(await o()));
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./switch-harness')).dbLoginMock(await o()));
vi.mock('../../src/instance/maintenance', async (o) => (await import('./switch-harness')).maintenanceMock(await o()));
vi.mock('../../src/docker/containerManager', async (o) => (await import('./switch-harness')).containerManagerMock(await o()));
vi.mock('../../src/instance/fleetBackup', async (o) => (await import('./switch-harness')).fleetBackupMock(await o()));
vi.mock('../../src/instance/fleetJoin', async (o) => (await import('./switch-harness')).fleetJoinMock(await o()));
vi.mock('../../src/instance/fleetReplica', async (o) => (await import('./switch-harness')).fleetReplicaMock(await o()));
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./switch-harness')).appHookMock(await o()));
vi.mock('../../src/instance/backupCheck', async (o) => (await import('./switch-harness')).backupCheckMock(await o()));
vi.mock('../../src/env/manager', async (o) => (await import('./switch-harness')).envMock(await o()));
vi.mock('../../src/config/appCapabilities', async (o) => (await import('./switch-harness')).capsMock(await o()));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import { createBotRoutes } from '../../src/webui/routes/bots';
import { copyFixture, fake, h, mainFixture, resetHarness, seedDbs, writeRegistry } from './switch-harness';

const router = createBotRoutes({ clients: new Set() } as any);
const view = async (id = 'a'): Promise<any> => {
  const layer = (router as any).stack.find((l: any) => l.route?.path === '/:id/fleet-switch' && l.route.methods.get);
  const res: any = { statusCode: 200 };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  await layer.route.stack[layer.route.stack.length - 1].handle({ params: { id }, query: {}, body: {} }, res);
  return res.body;
};

beforeEach(() => {
  resetHarness();
  seedDbs();
  writeRegistry({ a: mainFixture(), c: copyFixture() });
});
afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

describe('RG1: GET /:id/fleet-switch answers the main\'s generation', () => {
  it('a generation row: its machine, number and since', async () => {
    const got = await view();
    expect(got.success).toBe(true);
    expect(got.generation).toEqual({ machine: 'main.example', generation: 3, since: '2026-10-28T10:00:00Z' });
  });
  it('no row: null', async () => {
    fake.dbs['a-pg'].generation = null;
    expect((await view()).generation).toBeNull();
  });
  it('the read fails: its error', async () => {
    fake.dbs['a-pg'].fail['gen-read'] = 'ERROR:  permission denied';
    const g = (await view()).generation;
    expect(Object.keys(g)).toEqual(['error']);
    expect(g.error).toContain('permission denied');
  });
  it('the database stopped: no generation field', async () => {
    h.sidecar['a-pg'] = false;
    const got = await view();
    expect(got.success).toBe(true);
    expect('generation' in got).toBe(false);
  });
  it('docker did not answer about the database: can\'t confirm (fixer 1)', async () => {
    h.sidecar['a-pg'] = null;
    expect((await view()).generation).toEqual({ error: 'docker did not answer' });
  });
  it('a copy: no generation field', async () => {
    const got = await view('c');
    expect(got.success).toBe(true);
    expect('generation' in got).toBe(false);
  });
});

describe('RG2 (fixer 3): where a hooks bot without a managed database keeps its data', () => {
  const place = async (env: Record<string, string>, status: { corrupt?: boolean; undecryptable?: string[] } = {}, bot: Record<string, unknown> = {}) => {
    const { dataPlace } = await import('../../src/instance/dataPlace');
    const em = await import('../../src/env/manager');
    const spy = vi.spyOn(em, 'getEnvVarsWithStatus').mockReturnValue({ vars: env, encrypted: [], corrupt: !!status.corrupt, undecryptable: status.undecryptable ?? [] });
    try { return dataPlace({ id: 'j', sourceUrl: 'x', ...bot } as any); } finally { spy.mockRestore(); }
  };
  it('the app has no mode key (fixer 4): its companion database is Postgres, so outside', async () => {
    expect(await place({ DATA_BACKEND: 'file' })).toBe('outside');
  });
  it('the mode key `file` or empty: json (fixer 4)', async () => {
    h.capsMode = { key: 'DATA_BACKEND', value: 'postgres' };
    expect(await place({ DATA_BACKEND: 'file' })).toBe('json');
    expect(await place({ DATA_BACKEND: ' File ' })).toBe('json');
    expect(await place({})).toBe('json');
    expect(await place({ DATA_BACKEND: '' }, {}, { envVars: { DATA_BACKEND: 'postgres' } })).toBe('json');
  });
  it('the mode key `postgres`: outside (fixer 4)', async () => {
    h.capsMode = { key: 'DATA_BACKEND', value: 'postgres' };
    expect(await place({ DATA_BACKEND: 'Postgres' })).toBe('outside');
    expect(await place({}, {}, { envVars: { DATA_BACKEND: 'postgres' } })).toBe('outside');
  });
  it('the env store cannot be read: null', async () => {
    expect(await place({}, { corrupt: true })).toBeNull();
    expect(await place({}, { undecryptable: ['DATA_BACKEND'] })).toBeNull();
  });
  it('the store unreadable with a mode key: null (fixer 4)', async () => {
    h.capsMode = { key: 'DATA_BACKEND', value: 'postgres' };
    expect(await place({ DATA_BACKEND: 'file' }, { corrupt: true })).toBeNull();
    expect(await place({}, { undecryptable: ['DATA_BACKEND'] })).toBeNull();
  });
});

describe('RG3 (fixer 4): the bots list carries dataPlace for a hooks bot without fleetDb', () => {
  it('a bot on DATA_BACKEND file: dataPlace json', async () => {
    h.capsMode = { key: 'DATA_BACKEND', value: 'postgres' };
    const j = { ...copyFixture(), id: 'j', name: 'j', envVars: { DATA_BACKEND: 'file' } } as any;
    delete j.fleetDb; delete j.fleetDbReplica;
    writeRegistry({ j });
    const em = await import('../../src/env/manager');
    const spy = vi.spyOn(em, 'getEnvVarsWithStatus').mockReturnValue({ vars: { DATA_BACKEND: 'file' }, encrypted: [], corrupt: false, undecryptable: [] });
    try {
      const layer = (router as any).stack.find((l: any) => l.route?.path === '/' && l.route.methods.get);
      const res: any = { statusCode: 200 };
      res.status = (c: number) => { res.statusCode = c; return res; };
      res.json = (b: unknown) => { res.body = b; return res; };
      await layer.route.stack[layer.route.stack.length - 1].handle({ params: {}, query: {}, body: {} }, res);
      const list = Array.isArray(res.body) ? res.body : (res.body.bots ?? res.body.data);
      const got = list.find((b: any) => b.id === 'j');
      expect(got.appHooks).toBe(true);
      expect(got.dataPlace).toBe('json');
    } finally { spy.mockRestore(); }
  });
});
