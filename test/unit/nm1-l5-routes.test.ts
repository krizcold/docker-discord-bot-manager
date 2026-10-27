import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm1-l5-routes-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    broadcasts: [] as Array<{ type: string; payload: any }>,
    busy: null as string | null,
    shutting: false,
    mode: 'docker',
    dumps: [] as unknown[] | Error,
    status: { vars: {}, corrupt: false, undecryptable: [] as string[] } as any,
    env: {} as Record<string, string> | undefined,
    vault: { standalone: [], deletedBots: [] as any[] } as any,
    saves: [] as any[],
    saveError: null as Error | null,
    vaultBroken: false,
    deleteImpl: (async () => true) as () => Promise<boolean>,
    copies: [] as string[],
    statusImpl: (async () => ({ state: 'running' })) as () => Promise<unknown>,
    orderImpl: (async () => ({ accepted: true })) as () => Promise<any>,
  };
});

vi.mock('../../src/webui/server', () => ({ broadcastToClients: (_w: unknown, type: string, payload: unknown) => { h.broadcasts.push({ type, payload }); } }));
vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  isBotBusy: () => h.busy,
  isShuttingDown: () => h.shutting,
  deleteBot: () => h.deleteImpl(),
  botEnvCopies: () => h.copies,
  hostBotDirFor: (id: string) => `/host/bots/${id}`,
}));
vi.mock('../../src/env/manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/env/manager')>()),
  getEnvVarsWithStatus: () => h.status,
  getEnvVars: () => h.env,
}));
vi.mock('../../src/webui/routes/vault', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/webui/routes/vault')>()),
  loadVault: () => JSON.parse(JSON.stringify(h.vault)),
  saveVault: (v: unknown) => { if (h.saveError) throw h.saveError; h.saves.push(JSON.parse(JSON.stringify(v))); h.vault = JSON.parse(JSON.stringify(v)); },
  vaultFileBroken: () => h.vaultBroken,
}));
vi.mock('../../src/instance/fleetReplica', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetReplica')>()),
  instanceRemovalRefusal: async () => null,
}));
vi.mock('../../src/instance/fleetBackup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetBackup')>()),
  listFleetBackups: () => { if (h.dumps instanceof Error) throw h.dumps; return h.dumps; },
}));
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => h.mode,
}));
vi.mock('../../src/git/repoManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/git/repoManager')>()),
  getEnvPath: (id: string) => require('path').join(h.dir, 'envs', id),
}));
vi.mock('../../src/instance/maintenance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/maintenance')>()),
  orderMaintenance: () => h.orderImpl(),
  maintenanceStatus: () => h.statusImpl(),
  getMaintenanceDrift: () => null,
  setMaintenanceListener: () => {},
}));

import * as fs from 'fs';
import * as path from 'path';
import { createBotRoutes, collectHealthChanges } from '../../src/webui/routes/bots';
import { SHUTDOWN_REFUSAL } from '../../src/docker/containerManager';

const base = (id: string, over: Record<string, unknown> = {}) => ({
  id, displayName: id.toUpperCase(), sanitizedName: id, titleName: id, sourceUrl: 'https://github.com/x/y', sourceId: null, status: 'running', containerIds: [],
  envVars: {}, lastBuiltCommit: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...over,
});
const fleetDb = { containerName: 'db1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'v' };
const writeRegistry = (instances: Record<string, unknown>) =>
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances }, null, 2));
const storeDir = path.join(h.dir, 'envs', 'b1');

const router = createBotRoutes({ clients: new Set() } as any);
type Res = { status: number; body: any };
const call = async (method: string, routePath: string, id: string, query: Record<string, string> = {}, body: unknown = {}): Promise<Res> => {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
  const res: any = { statusCode: 200 };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  await layer.route.stack[layer.route.stack.length - 1].handle({ params: { id }, query, body }, res);
  return { status: res.statusCode, body: res.body };
};
const del = (query: Record<string, string> = {}) => call('delete', '/:id', 'b1', query);
const gate = (method: string, reqPath: string): { passed: boolean; status?: number; body?: any } => {
  const layer = (router as any).stack.find((l: any) => l.name === 'shutdownGate');
  let passed = false;
  const res: any = {};
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  layer.handle({ method, path: reqPath }, res, () => { passed = true; });
  return { passed, status: res.statusCode, body: res.body };
};

afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));
beforeEach(() => {
  h.broadcasts = []; h.busy = null; h.shutting = false; h.mode = 'docker'; h.dumps = [];
  h.status = { vars: {}, corrupt: false, undecryptable: [] }; h.env = {};
  h.vault = { standalone: [], deletedBots: [] }; h.saves = []; h.saveError = null; h.vaultBroken = false;
  h.deleteImpl = async () => true; h.copies = [];
  h.statusImpl = async () => ({ state: 'running' }); h.orderImpl = async () => ({ accepted: true });
  fs.rmSync(path.join(h.dir, 'envs'), { recursive: true, force: true });
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(storeDir, 'storage.json'), '{}');
  writeRegistry({ b1: base('b1') });
});

describe('collectHealthChanges lastAt', () => {
  it('carries the last backup time, or null when there is none', () => {
    writeRegistry({
      d1: base('d1', { fleetDb, lastFleetBackupAt: '2026-10-20T10:00:00.000Z' }),
      d2: base('d2', { fleetDb }),
    });
    const pushes = collectHealthChanges(new Map());
    expect(pushes.find(p => p.id === 'd1')!.fleetBackup!.lastAt).toBe('2026-10-20T10:00:00.000Z');
    expect(pushes.find(p => p.id === 'd2')!.fleetBackup!.lastAt).toBeNull();
  });
});

describe('the shutdown gate', () => {
  it('passes HEAD and a bot web-UI ping, and refuses other writes with the shutdown text', () => {
    h.shutting = true;
    expect(gate('HEAD', '/b1/logs').passed).toBe(true);
    expect(gate('POST', '/b1/webui-ready').passed).toBe(true);
    expect(gate('POST', '/x/b1/webui-ready').passed).toBe(false);
    expect(gate('POST', '/b1/webui-ready/x').passed).toBe(false);
    const refused = gate('POST', '/b1/start');
    expect(refused).toEqual({ passed: false, status: 503, body: { success: false, error: SHUTDOWN_REFUSAL } });
  });
});

describe('DELETE /api/bots/:id', () => {
  it('an unknown bot answers 404 with the exact body', async () => {
    writeRegistry({});
    expect(await del()).toEqual({ status: 404, body: { success: false, error: 'Bot not found' } });
  });

  it('a busy bot answers 409 naming the operation', async () => {
    h.busy = 'start';
    expect(await del()).toEqual({ status: 409, body: { success: false, error: "Operation 'start' already in progress" } });
  });

  it('names the kept data folder only when data is kept in docker mode', async () => {
    expect((await del()).body.keptDataDir).toBe('/host/bots/b1');
    h.mode = 'casaos';
    expect('keptDataDir' in (await del()).body).toBe(false);
    h.mode = 'docker';
    expect('keptDataDir' in (await del({ keepData: 'false' })).body).toBe(false);
  });

  it('a corrupt env store refuses with the exact text', async () => {
    h.status = { vars: {}, corrupt: true, undecryptable: [] };
    expect(await del()).toEqual({ status: 409, body: { success: false, error: 'The env store for this bot cannot be read (a copy is kept beside it as storage.json.corrupt-<time> when it could be read), so its values cannot be vaulted. Restore the store first, or delete again without preserving env values to proceed.' } });
  });

  it('values that no longer decrypt refuse with their names', async () => {
    h.status = { vars: {}, corrupt: false, undecryptable: ['TOKEN', 'SECRET'] };
    expect(await del()).toEqual({ status: 409, body: { success: false, error: 'The env store for this bot holds values that no longer decrypt (TOKEN, SECRET), so they cannot be vaulted. Restoring the original encryption key would recover them; or delete again without preserving env values to proceed.' } });
  });

  it('vaults the env values without the manager keys and announces the deletion', async () => {
    h.env = { BOT_ID: 'b1', BOT_MANAGER_UPDATE_TOKEN: 't', TOKEN: 'abc' };
    const r = await del();
    expect(r.status).toBe(200);
    expect(r.body.vaulted).toBe(true);
    expect(h.saves).toHaveLength(1);
    expect(h.saves[0].deletedBots).toHaveLength(1);
    expect(h.saves[0].deletedBots[0]).toMatchObject({ botName: 'B1', sanitizedName: 'b1', entries: [{ key: 'TOKEN', value: 'abc' }] });
    expect(h.broadcasts).toEqual([{ type: 'bot:deleted', payload: { id: 'b1' } }]);
  });

  it('an empty env store saves no vault group', async () => {
    h.env = { BOT_ID: 'b1' };
    const r = await del();
    expect(r.body.vaulted).toBe(false);
    expect(h.saves).toHaveLength(0);
  });

  it('a broken vault file refuses with the exact text', async () => {
    h.env = { TOKEN: 'abc' };
    h.vaultBroken = true;
    expect(await del()).toEqual({ status: 409, body: { success: false, error: 'The credentials vault (vault.json) exists but cannot be read, so preserving this bot\'s env values would overwrite every previously vaulted group. Repair or remove vault.json first (a copy of the damaged file is kept beside it as vault.json.corrupt-<time> when it could be read), or delete again without preserving env values to proceed.' } });
    expect(h.saves).toHaveLength(0);
  });

  it('a failed vault write refuses with the exact text', async () => {
    h.env = { TOKEN: 'abc' };
    h.saveError = new Error('disk full');
    expect(await del()).toEqual({ status: 409, body: { success: false, error: 'Preserving the env values in the vault failed (Error: disk full), so nothing was deleted. Fix the vault write, or delete again without preserving env values to proceed.' } });
  });

  it('a delete that finds no bot rolls back only its own vault group and answers 404', async () => {
    h.env = { TOKEN: 'abc' };
    h.vault = { standalone: [], deletedBots: [{ id: 'old', botName: 'OLD', sanitizedName: 'old', deletedAt: 1, entries: [] }] };
    h.deleteImpl = async () => false;
    expect(await del()).toEqual({ status: 404, body: { success: false, error: 'Bot not found' } });
    expect(h.saves).toHaveLength(2);
    expect(h.saves[1].deletedBots.map((g: any) => g.id)).toEqual(['old']);
  });

  it('keeps the vault group when the env store is already gone, and says so', async () => {
    h.env = { TOKEN: 'abc' };
    fs.rmSync(path.join(storeDir, 'storage.json'));
    h.deleteImpl = async () => false;
    const warned: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { warned.push(String(m)); });
    try {
      expect((await del()).status).toBe(404);
    } finally { spy.mockRestore(); }
    expect(h.saves).toHaveLength(1);
    expect(warned).toContain('[API] Delete failed after the env store was destroyed; keeping the vault group as the only surviving copy');
  });

  it('a delete that throws rolls back the group and answers 500 with the error', async () => {
    h.env = { TOKEN: 'abc' };
    h.deleteImpl = async () => { throw new Error('boom'); };
    expect(await del()).toEqual({ status: 500, body: { success: false, error: 'Error: boom' } });
    expect(h.saves).toHaveLength(2);
    expect(h.saves[1].deletedBots).toEqual([]);
  });

  it('a failed rollback is logged with its error', async () => {
    h.env = { TOKEN: 'abc' };
    h.deleteImpl = async () => { h.saveError = new Error('read-only'); return false; };
    const warned: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { warned.push(String(m)); });
    try {
      expect((await del()).status).toBe(404);
    } finally { spy.mockRestore(); }
    expect(warned).toContain('[API] Failed to roll back vault group: Error: read-only');
  });

  it('without a vault group a failed delete touches no vault', async () => {
    h.deleteImpl = async () => false;
    expect((await del({ keepEnv: 'false' })).status).toBe(404);
    expect(h.saves).toHaveLength(0);
  });

  it('envDeleted is true only when env is not kept and every env copy is gone', async () => {
    const gone = path.join(h.dir, 'gone.env');
    const left = path.join(h.dir, 'left.env');
    fs.writeFileSync(left, 'x');
    h.copies = [gone];
    expect((await del({ keepEnv: 'false' })).body.envDeleted).toBe(true);
    expect((await del()).body.envDeleted).toBe(false);
    h.copies = [gone, left];
    expect((await del({ keepEnv: 'false' })).body.envDeleted).toBe(false);
  });

  it('names the kept database dumps only when there are some', async () => {
    expect('dbDumpsKept' in (await del()).body).toBe(false);
    h.dumps = [{}, {}];
    expect((await del()).body.dbDumpsKept).toEqual({ count: 2, folder: 'backups/b1/fleet-postgres' });
  });
});

describe('the maintenance routes', () => {
  it('GET answers 500 with the error when the status read throws', async () => {
    h.statusImpl = async () => { throw new Error('status failed'); };
    expect(await call('get', '/:id/maintenance', 'b1')).toEqual({ status: 500, body: { success: false, error: 'Error: status failed' } });
  });

  it('PUT refuses a message that is not text with the exact body', async () => {
    expect(await call('put', '/:id/maintenance', 'b1', {}, { state: 'maintenance', message: 5 })).toEqual({ status: 400, body: { success: false, error: 'The maintenance message must be text' } });
  });

  it('PUT answers 500 with the error when the order throws', async () => {
    h.orderImpl = async () => { throw new Error('order failed'); };
    expect(await call('put', '/:id/maintenance', 'b1', {}, { state: 'maintenance' })).toEqual({ status: 500, body: { success: false, error: 'Error: order failed' } });
  });
});
