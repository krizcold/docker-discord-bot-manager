import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm10-l5-c-routes-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, viewThrows: false, runThrows: false };
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
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/instance/migrate', async (o) => {
  const real = await o<typeof import('../../src/instance/migrate')>();
  return {
    ...real,
    migrateView: (bot: any) => { if (h.viewThrows) throw new Error('view broke'); return real.migrateView(bot); },
    runMigration: async () => { if (h.runThrows) throw new Error('run broke'); return { accepted: false, status: 409, error: 'refused' }; },
    setMigrateListener: () => {},
  };
});

import * as fs from 'fs';
import * as path from 'path';
import { createBotRoutes } from '../../src/webui/routes/bots';
import { MIGRATE_GATE } from '../../src/docker/containerManager';

const SMDB = 'https://example.invalid/fake/super-modular-discord-bot';
const REGISTRY = path.join(h.dir, 'instances.json');
const RECORD = { to: 'postgres', from: 'file', destination: null, companion: true, jobId: 'mgr-c1', jobIds: ['mgr-c1'], posted: true, started: 1, kept: 0, phase: 'following', loginOpened: false, openedAt: 'x', text: 't' };
const inst = (id: string, over: Record<string, unknown> = {}) => ({
  id, sanitizedName: id, displayName: id.toUpperCase(), titleName: id.toUpperCase(), status: 'stopped', sourceType: 'git', sourceUrl: SMDB,
  envVars: {}, createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', ...over,
});
const writeRegistry = (instances: Record<string, unknown>) => fs.writeFileSync(REGISTRY, JSON.stringify({ instances }));

const router = createBotRoutes({ clients: new Set() } as any);
const call = async (method: 'get' | 'post' | 'put', routePath: string, id: string, body: unknown = {}) => {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
  const res: any = { statusCode: 200 };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  await layer.route.stack[layer.route.stack.length - 1].handle({ params: { id }, query: {}, body }, res);
  return { status: res.statusCode, body: res.body };
};

beforeEach(() => {
  h.viewThrows = false;
  h.runThrows = false;
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', 'b', 'env'), { recursive: true });
  writeRegistry({ b: inst('b') });
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('PUT /:id on a bot a migration touches', () => {
  it("a rename of a bot held by another bot's migration is not refused by that hold", async () => {
    writeRegistry({ b: inst('b'), s: inst('s', { migrate: { ...RECORD, sharers: ['b'], sharersStopped: ['b'] } }) });
    const r = await call('put', '/:id', 'b', { displayName: 'Other name' });
    expect(r.status).not.toBe(409);
    expect(r.body.error).not.toBe(MIGRATE_GATE.heldDb('S', 'Postgres'));
  });

  it('a save that keeps the name of a migrating bot is not refused', async () => {
    writeRegistry({ b: inst('b', { migrate: { ...RECORD } }) });
    const r = await call('put', '/:id', 'b', { displayName: 'B', description: 'kept name' });
    expect(r.status).toBe(200);
  });
});

describe('the migrate routes', () => {
  it('GET for an unknown bot answers 404', async () => {
    expect(await call('get', '/:id/migrate', 'nope')).toEqual({ status: 404, body: { success: false, error: 'Bot not found' } });
  });

  it('GET answers 500 with the error when the view throws', async () => {
    h.viewThrows = true;
    expect(await call('get', '/:id/migrate', 'b')).toEqual({ status: 500, body: { success: false, error: 'Error: view broke' } });
  });

  it('POST answers 500 with the error when the run throws', async () => {
    h.runThrows = true;
    expect(await call('post', '/:id/migrate', 'b', { to: 'postgres' })).toEqual({ status: 500, body: { success: false, error: 'Error: run broke' } });
  });
});

describe('PUT /:id/env without a vars object on a migrating bot', () => {
  for (const vars of [undefined, null, 'x']) {
    it(`vars ${JSON.stringify(vars)} with a held key removed answers that vars is required`, async () => {
      writeRegistry({ b: inst('b', { migrate: { ...RECORD } }) });
      expect(await call('put', '/:id/env', 'b', { vars, removed: ['DATA_BACKEND'] }))
        .toEqual({ status: 400, body: { success: false, error: 'vars object is required' } });
    });
  }

  it('the held key removed with a vars object is refused with MG-ENV-KEY', async () => {
    writeRegistry({ b: inst('b', { migrate: { ...RECORD } }) });
    expect(await call('put', '/:id/env', 'b', { vars: {}, removed: ['DATA_BACKEND'] }))
      .toEqual({ status: 409, body: { success: false, error: MIGRATE_GATE.envKey('Postgres', 'DATA_BACKEND', 'DATA_BACKEND_URL') } });
  });
});
