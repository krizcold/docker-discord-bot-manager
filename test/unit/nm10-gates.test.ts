import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm10-gates-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, env: {} as Record<string, Record<string, string>>, hooks: [] as string[], logins: [] as string[] };
});

vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/env/manager', async (o) => ({
  ...(await o<typeof import('../../src/env/manager')>()),
  getEnvVarsWithStatus: (id: string) => ({ vars: { ...(h.env[id] || {}) }, undecryptable: [], encrypted: [], corrupt: false }),
  getEnvVars: (id: string) => ({ ...(h.env[id] || {}) }),
}));
vi.mock('../../src/instance/dbLogin', async (o) => ({
  ...(await o<typeof import('../../src/instance/dbLogin')>()),
  sidecarRunning: async () => true,
  readWriteFence: async () => ({ ok: true, on: false }),
  readBotLogin: async () => { h.logins.push('read'); return { ok: true, login: { inRecovery: false, canLogin: true, sessions: 0 } }; },
  blockBotLogin: async () => { h.logins.push('block'); return { ok: true }; },
  ensureManagerDbRole: async () => ({ ok: true }),
}));
vi.mock('../../src/instance/appHookClient', async (o) => ({
  ...(await o<typeof import('../../src/instance/appHookClient')>()),
  callAppHook: async (_i: unknown, action: string) => { h.hooks.push(action); return { ok: true, status: 200, body: { success: true } }; },
}));
vi.mock('../../src/docker/dockerClient', async (o) => ({
  ...(await o<typeof import('../../src/docker/dockerClient')>()),
  listComposeContainers: async () => [],
}));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import { runMaintenanceOrder, requireMaintenance, reconcileMaintenance, resetMaintenanceState } from '../../src/instance/maintenance';
import { createBotRoutes } from '../../src/webui/routes/bots';
import { restoreFleetBackup } from '../../src/instance/fleetBackup';
import { backupDir } from '../../src/instance/backupFiles';
import { getEnvPath } from '../../src/git/repoManager';
import { APP_CAPABILITIES } from '../../src/config/appCapabilities';
import { MG_URL_FORM } from './migrate-fake';

const SMDB = 'https://github.com/x/fully-modular-discord-bot';
const SETTLED = { state: 'maintenance', message: 'Back soon', orderedAt: '2026-10-30T00:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: 'maintenance' };
const FLEET_DB = { containerName: 'b1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'v' };
const record = (over: Record<string, unknown> = {}) => ({ to: 'file', from: 'postgres', destination: null, companion: false, jobId: 'mgr-a', jobIds: ['mgr-a'], posted: true, started: 1, kept: 0, phase: 'following', loginOpened: true, sharers: ['s1'], sharersStopped: [], openedAt: '2026-10-31T00:00:00.000Z', ...over });
const base = (id: string, over: Record<string, unknown> = {}) => ({
  id, displayName: id.toUpperCase(), sanitizedName: id, titleName: id, sourceUrl: SMDB, sourceId: null, status: 'stopped', containerIds: [],
  envVars: {}, lastBuiltCommit: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...over,
});
function writeRegistry(instances: Record<string, unknown>): void {
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances }, null, 2));
}
const stored = (id: string) => JSON.parse(fs.readFileSync(path.join(h.dir, 'instances.json'), 'utf-8')).instances[id];

const router = createBotRoutes({ clients: new Set() } as any);
const call = async (method: 'get' | 'put' | 'post' | 'delete', routePath: string, params: Record<string, string>, body: unknown = {}): Promise<{ status: number; body: any }> => {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`no route ${method} ${routePath}`);
  const res: any = { statusCode: 200 };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.send = (b: unknown) => { res.body = b; return res; };
  await layer.route.stack[layer.route.stack.length - 1].handle({ params, query: {}, body, headers: {} }, res);
  return { status: res.statusCode, body: res.body };
};

let held: Array<Promise<unknown>> = [];
let release: () => void = () => {};
/** Holds the bot's op lock under `op` until release(). */
function hold(id: string, op: string): void {
  const gate = new Promise<void>(r => { release = r; });
  held.push(containerManager.withExternalBotOp(id, op, () => gate));
}

afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));
beforeEach(async () => {
  release();
  await Promise.all(held);
  held = [];
  h.hooks = []; h.logins = [];
  resetMaintenanceState();
  h.env = { b1: { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: 'postgresql://smdb:pw@b1-fleet-postgres:5432/smdb' }, s1: { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: 'postgresql://smdb:pw@b1-fleet-postgres:5432/smdb' } };
  writeRegistry({
    b1: base('b1', { fleetDb: FLEET_DB, maintenance: SETTLED, migrate: record() }),
    s1: base('s1', {}),
  });
});

describe('O: the gates while a record is open', () => {
  it('O4 a State order is refused with MG-ORDER (R16)', async () => {
    const r = await runMaintenanceOrder('b1', 'running', '');
    expect(r.text).toBe('A data migration to JSON files is open on this bot, so its state cannot change until the migration ends; nothing was changed');
    expect(stored('b1').maintenance).toEqual(SETTLED);
  });
  it('O5 Start is refused with MG-START, also while the migrate op holds the lock (round 1)', async () => {
    const text = 'A data migration to JSON files is open on this bot; it starts only through Migrate, so press Migrate to go on';
    expect(containerManager.startPreflightRefusal('b1')?.error).toBe(text);
    hold('b1', 'migrate');
    expect(containerManager.startPreflightRefusal('b1')?.error).toBe(text);
  });
  it('O7 Update and Build while the lane runs are refused with MG-BUILD', () => {
    const text = 'A data migration to JSON files is open on this bot; Update waits until it ends, and Build until the migration waits for you; nothing was changed';
    expect(containerManager.updatePreflightRefusal('b1')?.error).toBe(text);
    expect(containerManager.buildPreflightRefusal('b1')?.error).toBe(text);
  });
  it('O20 Build is admitted while the record waits; Update is not', () => {
    const r = stored('b1');
    writeRegistry({ b1: { ...r, migrate: record({ phase: 'waiting', resumeAt: 'following' }) }, s1: stored('s1') });
    expect(containerManager.buildPreflightRefusal('b1')).toBeNull();
    expect(containerManager.updatePreflightRefusal('b1')).not.toBeNull();
  });
  it('O18 a sharer\'s Start, Build and Update are refused while the record names it, even with the lane\'s lock (R2-A1)', () => {
    hold('b1', 'migrate');
    const text = "S1 is held by B1's open data migration to JSON files, since it uses the same database; try again once that migration ends; nothing was changed";
    expect(containerManager.startPreflightRefusal('s1')?.error).toBe(text);
    expect(containerManager.buildPreflightRefusal('s1')?.error).toBe(text);
    expect(containerManager.updatePreflightRefusal('s1')?.error).toBe(text);
  });
  it('O18 at closing with the migrate op held, the sharer may start (F5); its Build and Update stay refused (round 1)', () => {
    const r = stored('b1');
    writeRegistry({ b1: { ...r, migrate: record({ phase: 'closing' }) }, s1: stored('s1') });
    expect(containerManager.startPreflightRefusal('s1')?.error).toMatch(/is held by/);
    hold('b1', 'migrate');
    expect(containerManager.startPreflightRefusal('s1')).toBeNull();
    expect(containerManager.buildPreflightRefusal('s1')?.error).toMatch(/is held by/);
    expect(containerManager.updatePreflightRefusal('s1')?.error).toMatch(/is held by/);
  });
  it('X34 (pin) the closing start of the record that stopped a bot is refused while another record holds it', () => {
    const r = stored('b1');
    const b2 = { ...r, id: 'b2', displayName: 'B2', sanitizedName: 'b2', titleName: 'b2', migrate: record({ jobId: 'cli-1', jobIds: ['cli-1'], adoptedJob: 'cli-1' }) };
    writeRegistry({ b1: { ...r, migrate: record({ phase: 'closing', sharersStopped: ['s1'] }) }, b2, s1: stored('s1') });
    hold('b1', 'migrate');
    expect(containerManager.startPreflightRefusal('s1')?.error).toBe("S1 is held by B2's open data migration to JSON files, since it uses the same database; try again once that migration ends; nothing was changed");
    const { migrate: _gone, ...b2Free } = b2;
    writeRegistry({ b1: stored('b1'), b2: b2Free, s1: stored('s1') });
    expect(containerManager.startPreflightRefusal('s1')).toBeNull();
  });
  it('O12 the reconciler skips the bot: no hook, no block', async () => {
    const r = stored('b1');
    writeRegistry({ b1: { ...r, maintenance: { ...SETTLED, settled: false } }, s1: stored('s1') });
    await reconcileMaintenance();
    await reconcileMaintenance();
    expect(h.hooks).toEqual([]);
    expect(h.logins).toEqual([]);
  });
  it('O13 requireMaintenance refuses MG-GUARD whatever the caller\'s op (round 1)', async () => {
    const guard = { ok: false, error: 'A data migration to JSON files is open on this bot, and its database login is open for it, so this waits until the migration ends; nothing was changed' };
    hold('b1', 'restore');
    expect(await requireMaintenance('b1', 'database')).toEqual(guard);
    release();
    await Promise.all(held);
    held = [];
    hold('b1', 'migrate');
    expect(await requireMaintenance('b1', 'any')).toEqual(guard);
  });
  it('O10 a restore is refused with MG-RESTORE', async () => {
    const dir = backupDir('b1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'daily-x.dump'), 'x');
    const r = await restoreFleetBackup('b1', 'daily-x.dump');
    expect(r.error).toBe('A data migration of this bot is open; finish it before restoring a dump (nothing was changed)');
  });
  it('O16 a source change and O17 a project rename are refused with MG-SETUP; a display change is allowed', async () => {
    const setup = 'A data migration to JSON files is open on this bot, so its source and its project name cannot change until it ends; nothing was changed';
    expect(() => containerManager.reassignSource('b1', 'src-1')).toThrow(setup);
    await expect(containerManager.updateBot('b1', { displayName: 'Other Name' })).rejects.toThrow(setup);
    await expect(containerManager.updateBot('b1', { displayName: 'B1' })).resolves.toBeTruthy();
  });

  const routes: Array<[string, 'put' | 'post' | 'delete', string, Record<string, string>, unknown, RegExp]> = [
    ['PUT /:id envVars', 'put', '/:id', { id: 'b1' }, { envVars: { DATA_BACKEND: 'file' } }, /DATA_BACKEND and DATA_BACKEND_URL cannot change/],
    ['PUT /:id rename', 'put', '/:id', { id: 'b1' }, { displayName: 'New Project' }, /source and its project name cannot change/],
    ['PUT /:id/source', 'put', '/:id/source', { id: 'b1' }, { sourceId: 'x' }, /source and its project name cannot change/],
    ['PUT /:id/env', 'put', '/:id/env', { id: 'b1' }, { vars: { DATA_BACKEND_URL: 'postgresql://a@b/c' } }, /DATA_BACKEND and DATA_BACKEND_URL cannot change/],
    ['DELETE /:id/env/:key', 'delete', '/:id/env/:key', { id: 'b1', key: 'DATA_BACKEND' }, {}, /DATA_BACKEND and DATA_BACKEND_URL cannot change/],
    ['PUT /:id/config', 'put', '/:id/config', { id: 'b1' }, { files: [] }, /its files cannot change/],
    ['PUT /:id/fs/write', 'put', '/:id/fs/write', { id: 'b1' }, { path: 'a', content: 'b' }, /its files cannot change/],
    ['POST /:id/fs/create', 'post', '/:id/fs/create', { id: 'b1' }, { path: 'a' }, /its files cannot change/],
    ['POST /:id/fs/mkdir', 'post', '/:id/fs/mkdir', { id: 'b1' }, { path: 'a' }, /its files cannot change/],
    ['POST /:id/fs/delete', 'post', '/:id/fs/delete', { id: 'b1' }, { path: 'a' }, /its files cannot change/],
    ['POST /:id/fs/rename', 'post', '/:id/fs/rename', { id: 'b1' }, { from: 'a', to: 'b' }, /its files cannot change/],
    ['POST /:id/fleet-db/decommission', 'post', '/:id/fleet-db/decommission', { id: 'b1' }, {}, /database setup cannot change/],
    ['POST /:id/fleet-join', 'post', '/:id/fleet-join', { id: 'b1' }, { code: 'x' }, /database setup cannot change/],
    ['DELETE /:id/fleet-replication/slots/:slot', 'delete', '/:id/fleet-replication/slots/:slot', { id: 'b1', slot: 's' }, {}, /database setup cannot change/],
    ['POST /:id/fleet-replication', 'post', '/:id/fleet-replication', { id: 'b1' }, {}, /database setup cannot change/],
    ['POST /:id/fleet-replica', 'post', '/:id/fleet-replica', { id: 'b1' }, {}, /database setup cannot change/],
    ['DELETE /:id/fleet-replica', 'delete', '/:id/fleet-replica', { id: 'b1' }, {}, /database setup cannot change/],
    ['DELETE /:id/fleet-replica/seed', 'delete', '/:id/fleet-replica/seed', { id: 'b1' }, {}, /database setup cannot change/],
    ['POST /:id/fleet-replica/finish-retire', 'post', '/:id/fleet-replica/finish-retire', { id: 'b1' }, {}, /database setup cannot change/],
    ['POST /:id/fleet-replica/reseed', 'post', '/:id/fleet-replica/reseed', { id: 'b1' }, {}, /database setup cannot change/],
    ['POST /:id/fleet-reseed', 'post', '/:id/fleet-reseed', { id: 'b1' }, { replaced: true }, /database setup cannot change/],
  ];
  it.each(routes)('O8, O9, O11 %s is refused', async (_n, method, p, params, body, text) => {
    const before = fs.readFileSync(path.join(h.dir, 'instances.json'), 'utf-8');
    const r = await call(method, p, params, body);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(text);
    expect(fs.readFileSync(path.join(h.dir, 'instances.json'), 'utf-8')).toBe(before);
  });
  it('O38 PGPORT is held while a record stands: 409 MG-ENVKEY-PORT, the store as before; a blank PGPORT where none is stored passes', async () => {
    const storeFile = () => { try { return fs.readFileSync(path.join(getEnvPath('b1'), 'storage.json'), 'utf-8'); } catch { return null; } };
    const storeBefore = storeFile();
    expect(await call('put', '/:id/env', { id: 'b1' }, { vars: { PGPORT: '5433' } })).toEqual({ status: 409, body: { success: false, error: "A data migration to JSON files is open on this bot, so PGPORT, which the bot's Postgres driver reads for an address with no port, cannot change until it ends; nothing was changed" } });
    expect(storeFile()).toBe(storeBefore);
    expect((await call('put', '/:id/env', { id: 'b1' }, { vars: { PGPORT: '' } })).status).toBe(200);
  });
  it('O8 the DATA_BACKEND_URL exception holds only with awaiting destination', async () => {
    const r = stored('b1');
    writeRegistry({ b1: { ...r, migrate: record({ to: 'postgres', phase: 'waiting', resumeAt: 'following' }) }, s1: stored('s1') });
    expect((await call('put', '/:id/env', { id: 'b1' }, { vars: { DATA_BACKEND_URL: 'postgresql://a:b@c:5432/d' } })).status).toBe(409);
    writeRegistry({ b1: { ...r, migrate: record({ to: 'postgres', phase: 'waiting', resumeAt: 'following', awaiting: 'destination' }) }, s1: stored('s1') });
    expect((await call('put', '/:id/env', { id: 'b1' }, { vars: { DATA_BACKEND_URL: 'postgresql://a:b@c:5432/d', DATA_BACKEND: 'file' } })).status).toBe(409);
    expect((await call('put', '/:id/env', { id: 'b1' }, { vars: { DATA_BACKEND_URL: 'postgresql://a:b@c:5432/d' } })).status).not.toBe(409);
  });
  it('O8 updateBot refuses a DATA_BACKEND change while the record is open, with the lane\'s lock too; updateBotInOp passes (round 1)', async () => {
    const envKey = 'A data migration to JSON files is open on this bot, so DATA_BACKEND and DATA_BACKEND_URL cannot change until it ends; nothing was changed';
    await expect(containerManager.updateBot('b1', { envVars: { DATA_BACKEND: 'file' } })).rejects.toThrow(envKey);
    hold('b1', 'migrate');
    await expect(containerManager.updateBot('b1', { envVars: { DATA_BACKEND: 'file' } })).rejects.toThrow(envKey);
    await expect(containerManager.updateBot('b1', { envVars: { DATA_BACKEND: 'postgres' } })).resolves.toBeTruthy();
    await expect(containerManager.updateBotInOp('b1', { envVars: { NODE_NAME: 'x' } }, 'restore')).rejects.toThrow("the update must run under the 'restore' operation, which is not held");
    await expect(containerManager.updateBotInOp('b1', { envVars: { DATA_BACKEND: 'file' } }, 'migrate')).resolves.toBeTruthy();
  });
  describe('O34 a url key at a destination park that names another instance\'s managed database container (round 4)', () => {
    const DEST_URL = "A data migration to Postgres is open on this bot and waits for the Database URL of the database the copy went to; the URL given names a database in S1's managed database container, and Migrate does not move a bot onto another bot's managed database; nothing was changed";
    const storeFile = () => { try { return fs.readFileSync(path.join(getEnvPath('b1'), 'storage.json'), 'utf-8'); } catch { return null; } };
    beforeEach(() => {
      h.env.b1.DATA_BACKEND = 'file';
      const r = stored('b1');
      writeRegistry({
        b1: { ...r, migrate: record({ to: 'postgres', from: 'file', phase: 'waiting', resumeAt: 'following', awaiting: 'destination' }) },
        s1: base('s1', { fleetDb: { ...FLEET_DB, containerName: 's1-fleet-postgres', replication: { publicHost: 'pub.example', hostPort: 5433 } } }),
      });
    });
    const cases: Array<[string, number]> = [
      ['postgresql://u:p@s1-fleet-postgres:5433/other', 409],
      ['postgresql://u:p@S1-FLEET-POSTGRES/x', 409],
      ['postgresql://u:p@pub.example:5433/x', 409],
      ['postgresql://u:p@pub.example:5432/x', 200],
      ['postgresql://u:p@db.example.test:5432/app', 200],
      ['postgresql://u:p@b1-fleet-postgres:5432/x', 200],
    ];
    it.each(cases)('PUT /:id/env with %s answers %i', async (url, status) => {
      const before = fs.readFileSync(path.join(h.dir, 'instances.json'), 'utf-8');
      const storeBefore = storeFile();
      const r = await call('put', '/:id/env', { id: 'b1' }, { vars: { DATA_BACKEND_URL: url } });
      expect(r.status).toBe(status);
      if (status === 409) {
        expect(r.body.error).toBe(DEST_URL);
        expect(fs.readFileSync(path.join(h.dir, 'instances.json'), 'utf-8')).toBe(before);
        expect(storeFile()).toBe(storeBefore);
      }
    });
    it('O34 (round 5) a list whose second address names S1\'s container answers 409 MG-DEST-URL', async () => {
      const storeBefore = storeFile();
      const r = await call('put', '/:id/env', { id: 'b1' }, { vars: { DATA_BACKEND_URL: 'postgresql://u:p@db.example.test:5432/app?sslmode=x,postgresql://u:p@s1-fleet-postgres:5432/other' } });
      expect(r).toEqual({ status: 409, body: { success: false, error: DEST_URL } });
      expect(storeFile()).toBe(storeBefore);
    });
    it('O35 (round 5) at a destination park a host parameter answers 409 MG-URL-FORM', async () => {
      const storeBefore = storeFile();
      const r = await call('put', '/:id/env', { id: 'b1' }, { vars: { DATA_BACKEND_URL: 'postgresql://u:p@db.example.test:5432/app?host=s1-fleet-postgres' } });
      expect(r).toEqual({ status: 409, body: { success: false, error: MG_URL_FORM('param') } });
      expect(storeFile()).toBe(storeBefore);
    });
    it('O37 a value carried by a rename onto the url key meets O34: 409 MG-DEST-URL naming S1, the store unchanged', async () => {
      delete h.env.b1.DATA_BACKEND_URL;
      h.env.b1.OLD_URL = 'postgresql://u:p@s1-fleet-postgres:5432/other';
      const storeBefore = storeFile();
      const r = await call('put', '/:id/env', { id: 'b1' }, { vars: {}, renamed: { DATA_BACKEND_URL: 'OLD_URL' }, removed: ['OLD_URL'] });
      expect(r).toEqual({ status: 409, body: { success: false, error: DEST_URL } });
      expect(storeFile()).toBe(storeBefore);
    });
    it('(pin) O37 a carried host parameter answers 409 MG-URL-FORM', async () => {
      delete h.env.b1.DATA_BACKEND_URL;
      h.env.b1.OLD_URL = 'postgresql://u:p@db.example.test:5432/app?host=s1-fleet-postgres';
      const storeBefore = storeFile();
      const r = await call('put', '/:id/env', { id: 'b1' }, { vars: {}, renamed: { DATA_BACKEND_URL: 'OLD_URL' }, removed: ['OLD_URL'] });
      expect(r).toEqual({ status: 409, body: { success: false, error: MG_URL_FORM('param') } });
      expect(storeFile()).toBe(storeBefore);
    });
    it('PUT /:id with envVars naming S1\'s container answers 409 MG-DEST-URL, the store unchanged', async () => {
      const storeBefore = storeFile();
      const r = await call('put', '/:id', { id: 'b1' }, { envVars: { DATA_BACKEND_URL: 'postgresql://u:p@s1-fleet-postgres:5433/other' } });
      expect(r.status).toBe(409);
      expect(r.body.error).toBe(DEST_URL);
      expect(storeFile()).toBe(storeBefore);
    });
  });
  describe('W6 (round 6)', () => {
    const storeFile = () => { try { return fs.readFileSync(path.join(getEnvPath('b1'), 'storage.json'), 'utf-8'); } catch { return null; } };
    const HOST_PARAM = 'postgresql://u:p@db.example.test:5432/app?host=s1-fleet-postgres';
    beforeEach(() => {
      writeRegistry({ b1: base('b1', { fleetDb: FLEET_DB, maintenance: SETTLED }), s1: base('s1', {}) });
    });
    const saves: Array<[string, Record<string, string>, () => void]> = [
      [HOST_PARAM, { DATA_BACKEND_URL: HOST_PARAM }, () => {}],
      ['?hostaddr=', { DATA_BACKEND_URL: 'postgresql://u:p@db.example.test:5432/app?hostaddr=10.0.0.1' }, () => {}],
      ['?port=', { DATA_BACKEND_URL: 'postgresql://u:p@pub.example:5432/x?port=5433' }, () => {}],
      ['% codes in the host', { DATA_BACKEND_URL: 'postgresql://u:p@s1%2Dfleet%2Dpostgres:5432/app' }, () => {}],
      ['two hosts', { DATA_BACKEND_URL: 'postgresql://u:p@h1,h2:5432/db' }, () => {}],
      ['no database', { DATA_BACKEND_URL: 'postgresql://u:p@db.example.test:5432' }, () => {}],
      ['a / in the database name', { DATA_BACKEND_URL: 'postgresql://u:p@db.example.test:5432/smdb/' }, () => {}],
      ['mysql://', { DATA_BACKEND_URL: 'mysql://u:p@s1-fleet-postgres:5432/smdb' }, () => {}],
      ['no scheme', { DATA_BACKEND_URL: '//s1-fleet-postgres:5432/smdb' }, () => {}],
      ['an empty host with ?host=', { DATA_BACKEND_URL: 'postgresql://u:p@/smdb?host=s1-fleet-postgres' }, () => {}],
      ['PGPORT over a URL with no port', { PGPORT: '5433' }, () => { h.env.b1.DATA_BACKEND_URL = 'postgresql://u:p@db.example.test/app'; }],
    ];
    it.each(saves)('PUT /:id/env with %s answers 200 and saves', async (_n, vars, arrange) => {
      arrange();
      const storeBefore = storeFile();
      const r = await call('put', '/:id/env', { id: 'b1' }, { vars });
      expect(r.status).toBe(200);
      expect(storeFile()).not.toBe(storeBefore);
    });
    it('PUT /:id with a host parameter answers 200, and updateBot resolves', async () => {
      expect((await call('put', '/:id', { id: 'b1' }, { envVars: { DATA_BACKEND_URL: HOST_PARAM } })).status).toBe(200);
      await expect(containerManager.updateBot('b1', { envVars: { DATA_BACKEND_URL: HOST_PARAM } })).resolves.toBeTruthy();
    });
  });
  describe('migrateEnvRefusal keys on the app\'s companionDb.env (round 1)', () => {
    const STORE = 'https://github.com/x/store-app';
    beforeEach(() => {
      APP_CAPABILITIES.unshift({ match: { urlContains: 'store-app' }, companionDb: { ...APP_CAPABILITIES[0].companionDb!, env: { url: 'STORE_URL', mode: { key: 'STORE_MODE', value: 'postgres' } } }, hooks: APP_CAPABILITIES[0].hooks });
      h.env.c1 = { STORE_MODE: 'postgres', STORE_URL: 'postgresql://smdb:pw@c1-fleet-postgres:5432/smdb' };
      writeRegistry({ b1: stored('b1'), s1: stored('s1'), c1: base('c1', { sourceUrl: STORE, maintenance: SETTLED }) });
      containerManager.updateInstanceMigrate('c1', record({ sharers: [] }) as any);
    });
    afterEach(() => { APP_CAPABILITIES.shift(); });
    const text = 'A data migration to JSON files is open on this bot, so STORE_MODE and STORE_URL cannot change until it ends; nothing was changed';
    const envPut = (body: unknown) => call('put', '/:id/env', { id: 'c1' }, body);
    it('a blank STORE_MODE over a stored value is refused, naming STORE_MODE and STORE_URL', async () => {
      expect(await envPut({ vars: { STORE_MODE: '' } })).toEqual({ status: 409, body: { success: false, error: text } });
      await expect(containerManager.updateBot('c1', { envVars: { STORE_MODE: '' } })).rejects.toThrow(text);
    });
    it('a DATA_BACKEND change is refused too, and an unchanged STORE_URL passes', async () => {
      expect(await envPut({ vars: { DATA_BACKEND: 'postgres' } })).toEqual({ status: 409, body: { success: false, error: text } });
      expect((await envPut({ vars: { STORE_URL: h.env.c1.STORE_URL, NODE_NAME: 'x' } })).status).toBe(200);
    });
    it('a blank where nothing is stored passes (D50); a removal is refused', async () => {
      expect((await envPut({ vars: { DATA_BACKEND_URL: '' } })).status).toBe(200);
      expect(await envPut({ vars: {}, removed: ['STORE_URL'] })).toEqual({ status: 409, body: { success: false, error: text } });
    });
    it('S5 no STORE_MODE stored: its non-Postgres value passes (round 2)', async () => {
      delete h.env.c1.STORE_MODE;
      expect((await envPut({ vars: { STORE_MODE: 'file' } })).status).toBe(200);
    });
  });
  const s5: Array<[string, string | null, string, number]> = [
    ['no DATA_BACKEND stored, file passes', null, 'file', 200],
    ['no DATA_BACKEND stored, "FILE " passes', null, 'FILE ', 200],
    ['no DATA_BACKEND stored, postgres answers MG-ENVKEY', null, 'postgres', 409],
    ['DATA_BACKEND file stored, a blank answers MG-ENVKEY (R2)', 'file', '', 409],
    ['DATA_BACKEND postgres stored, Postgres passes', 'postgres', 'Postgres', 200],
    ['DATA_BACKEND file stored, " FILE" passes', 'file', ' FILE', 200],
    ['DATA_BACKEND file stored, postgres answers MG-ENVKEY', 'file', 'postgres', 409],
  ];
  it.each(s5)('S5 %s (round 3)', async (_n, storedValue, given, status) => {
    if (storedValue === null) delete h.env.b1.DATA_BACKEND;
    else h.env.b1.DATA_BACKEND = storedValue;
    const r = await call('put', '/:id/env', { id: 'b1' }, { vars: { DATA_BACKEND: given, NODE_NAME: 'x' } });
    expect(r.status).toBe(status);
    if (status === 409) expect(r.body.error).toBe('A data migration to JSON files is open on this bot, so DATA_BACKEND and DATA_BACKEND_URL cannot change until it ends; nothing was changed');
  });
  it('B-5 a restore of a bot another record lists only in sharers answers MG-HELD-RESTORE-S (round 2)', async () => {
    const r = stored('b1');
    h.env.s2 = { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: 'postgresql://smdb:pw@s2-fleet-postgres:5432/smdb' };
    writeRegistry({ b1: { ...r, migrate: record({ sharers: ['s2'] }) }, s1: stored('s1'), s2: base('s2', { fleetDb: { ...FLEET_DB, containerName: 's2-fleet-postgres', volume: 's2-v' } }) });
    const dir = backupDir('s2');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'daily-x.dump'), 'x');
    const res = await restoreFleetBackup('s2', 'daily-x.dump');
    expect(res.error).toMatch(/^B1's data migration to JSON files is open on the database this bot's Database URL names; finish it with Migrate on B1 before restoring a dump/);
  });
  it('O24 PUT /:id/env with a blank DATA_BACKEND over a stored value answers 409 MG-ENVKEY (round 1)', async () => {
    const before = fs.readFileSync(path.join(h.dir, 'instances.json'), 'utf-8');
    const r = await call('put', '/:id/env', { id: 'b1' }, { vars: { DATA_BACKEND: '', NODE_NAME: 'x' } });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('A data migration to JSON files is open on this bot, so DATA_BACKEND and DATA_BACKEND_URL cannot change until it ends; nothing was changed');
    expect(fs.readFileSync(path.join(h.dir, 'instances.json'), 'utf-8')).toBe(before);
  });
  it('B-6 the record texts are stored with the env store\'s URL password replaced by *** (round 1)', () => {
    h.env.b1.DATA_BACKEND_URL = 'postgresql://smdb:s3cretpass@b1-fleet-postgres:5432/smdb';
    containerManager.updateInstanceMigrate('b1', record({ text: 'failed: password s3cretpass refused' }) as any, { to: 'file', outcome: 'failed', jobId: 'mgr-a', text: 'Migration failed: s3cretpass', at: '2026-10-31T00:00:00.000Z' });
    expect(stored('b1').migrate.text).toBe('failed: password *** refused');
    expect(stored('b1').migrateLast.text).toBe('Migration failed: ***');
  });
  it('the gates lift once the record closes', () => {
    const r = stored('b1');
    delete r.migrate;
    writeRegistry({ b1: r, s1: stored('s1') });
    expect(containerManager.startPreflightRefusal('s1')).toBeNull();
    expect(containerManager.buildPreflightRefusal('b1')).toBeNull();
  });
});
