import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b04-4-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const exec = (_cmd: string, opts: any, cb?: any) => (typeof opts === 'function' ? opts : cb)(null, { stdout: '', stderr: '' });
  return { ...real, exec, default: { ...real, exec } };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';

beforeEach(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(h.dir, 't-'));
  process.env.DATA_ROOT = path.join(process.env.DATA_DIR, 'DATA');
  delete process.env.ENV_ENCRYPTION_KEY;
  vi.resetModules();
});
afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));

const vaultRoutes = async () => {
  const mod = await import('../../src/webui/routes/vault');
  const router = mod.createVaultRoutes();
  const call = async (method: string, routePath: string, req: any) => {
    const layer = (router as any).stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
    const out = { status: 200, body: undefined as any };
    const res = { status(code: number) { out.status = code; return res; }, json(body: any) { out.body = body; return res; } };
    await layer.route.stack[layer.route.stack.length - 1].handle({ query: {}, body: {}, params: {}, ...req }, res);
    return out;
  };
  return { mod, call };
};

const seedGroup = (mod: any) => mod.saveVault({
  standalone: [],
  deletedBots: [{ id: 'g1', botName: 'Old', sanitizedName: 'old', deletedAt: 1, entries: [{ key: 'A', value: 'one' }, { key: 'B', value: 'two' }] }],
});

describe('vault keys stay unique within a group', () => {
  it('a standalone rename onto an existing key is refused and both entries stay', async () => {
    const { mod, call } = await vaultRoutes();
    await call('post', '/standalone', { body: { key: 'A', value: 'one' } });
    await call('post', '/standalone', { body: { key: 'B', value: 'two' } });
    const res = await call('put', '/standalone/:key', { params: { key: 'A' }, body: { newKey: 'B', value: 'changed' } });
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(mod.loadVault().standalone.map((e: any) => [e.key, e.value])).toEqual([['A', 'one'], ['B', 'two']]);
  });

  it('a deleted-group rename onto an existing key is refused and both entries stay', async () => {
    const { mod, call } = await vaultRoutes();
    seedGroup(mod);
    const res = await call('put', '/deleted/:key', { params: { key: 'A' }, query: { groupId: 'g1' }, body: { newKey: 'B' } });
    expect(res.status).toBe(409);
    expect(mod.loadVault().deletedBots[0].entries).toEqual([{ key: 'A', value: 'one' }, { key: 'B', value: 'two' }]);
  });

  it('an add onto an existing key is refused and the stored value stays', async () => {
    const { mod, call } = await vaultRoutes();
    await call('post', '/standalone', { body: { key: 'A', value: 'one' } });
    const res = await call('post', '/standalone', { body: { key: 'A', value: 'other' } });
    expect(res.status).toBe(409);
    expect(mod.loadVault().standalone).toEqual([{ key: 'A', value: 'one', hidden: true }]);
  });

  it('a blank add never writes an empty value over a stored one', async () => {
    const { mod, call } = await vaultRoutes();
    await call('post', '/standalone', { body: { key: 'A', value: 'one' } });
    const res = await call('post', '/standalone', { body: { key: 'A', value: '' } });
    expect(res.body.success).toBe(false);
    expect(mod.loadVault().standalone[0].value).toBe('one');
  });

  it('a rename to a blank key is refused', async () => {
    const { mod, call } = await vaultRoutes();
    await call('post', '/standalone', { body: { key: 'A', value: 'one' } });
    seedGroup(mod);
    expect((await call('put', '/deleted/:key', { params: { key: 'A' }, query: { groupId: 'g1' }, body: { newKey: ' ' } })).status).toBe(400);
    expect(mod.loadVault().deletedBots[0].entries[0].key).toBe('A');
  });

  it('a rename to a free key still works', async () => {
    const { mod, call } = await vaultRoutes();
    await call('post', '/standalone', { body: { key: 'A', value: 'one' } });
    const res = await call('put', '/standalone/:key', { params: { key: 'A' }, body: { newKey: 'C' } });
    expect(res.body.success).toBe(true);
    expect(mod.loadVault().standalone.map((e: any) => e.key)).toEqual(['C']);
  });
});
