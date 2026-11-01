import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real containerManager, env store, maintenance, fleetBackup and bots router, with a fake at the docker boundary
// (b08-2-build.test.ts's pattern): the docker fake keeps per project which services run and the app's environment from
// the compose it was brought up with.
const d = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm10-real-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    repo: nodePath.join(dir, 'repo'),
    head: 'a'.repeat(40),
    exec: [] as string[],
    running: {} as Record<string, string[]>,
    appEnv: {} as Record<string, Record<string, string>>,
    inspect: [] as Array<Record<string, string>>,
    dbUpFail: null as string | null,
    image: (): 'present' | 'absent' => 'present',
    builds: 0,
    ups: [] as string[],
    downs: [] as string[],
    broadcasts: [] as Array<{ type: string; data: any }>,
  };
});

function appServiceEnv(composePath: string): Record<string, string> {
  const fs = require('fs') as typeof import('fs');
  const YAML = require('yaml');
  const compose = YAML.parse(fs.readFileSync(composePath, 'utf-8'));
  const services = compose?.services ?? {};
  const name = Object.keys(services).find(s => s !== 'fleet-postgres') ?? 'app';
  const env = services[name]?.environment ?? {};
  if (Array.isArray(env)) return Object.fromEntries(env.map((e: string) => [e.split('=')[0], e.slice(e.indexOf('=') + 1)]));
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)]));
}

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const fail = (msg: string) => Object.assign(new Error(msg), { stderr: msg });
  const answer = (line: string): string => {
    d.exec.push(line);
    const project = /com\.docker\.compose\.project=([^"\s]+)/.exec(line)?.[1] ?? /-p "([^"]+)"/.exec(line)?.[1] ?? '';
    const runs = d.running[project] ?? [];
    if (line.startsWith('docker ps -q')) {
      const service = /com\.docker\.compose\.service=([^"\s]+)/.exec(line)?.[1];
      const ids = runs.filter(s => !service || s === service).map(s => `${project}-${s}-id`);
      return ids.join('\n');
    }
    if (line.startsWith('docker ps')) return runs.map(s => `${project}-${s}-1`).join('\n');
    if (line.startsWith('docker inspect --format "{{json .Config.Env}}"')) {
      const id = line.split(' ').pop() ?? '';
      const p = id.replace(/-[^-]+-id$/, '').replace(/-app$/, '');
      const env = d.inspect.length ? d.inspect.shift()! : d.appEnv[p] ?? d.appEnv[Object.keys(d.appEnv)[0]] ?? {};
      return JSON.stringify(Object.entries(env).map(([k, v]) => `${k}=${v}`));
    }
    const up = /^docker compose -f "[^"]+" -p "([^"]+)" up -d (\S+)$/.exec(line);
    if (up) {
      if (d.dbUpFail) throw fail(d.dbUpFail);
      d.running[up[1]] = Array.from(new Set([...(d.running[up[1]] ?? []), up[2]]));
      return '';
    }
    if (/^docker exec "[^"]+" pg_isready/.test(line)) {
      if (!Object.values(d.running).some(r => r.includes('fleet-postgres'))) throw fail('no response');
      return '';
    }
    if (line.startsWith('image inspect')) {
      if (d.image() === 'absent') throw fail('No such image');
      return '[]';
    }
    if (line.startsWith('volume')) throw fail('No such volume');
    if (line.startsWith('docker inspect')) throw fail('Error: No such object');
    if (line.startsWith('docker rm')) throw fail('Error: No such container');
    return '';
  };
  const execFileSync = (_f: string, args: string[]) => answer(args.join(' '));
  const execFile = (_f: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    try { done(null, { stdout: answer(args.join(' ')), stderr: '' }); } catch (e) { done(e); }
  };
  const execSync = (cmd: string) => answer(cmd);
  const exec = (cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    try { done(null, { stdout: answer(cmd), stderr: '' }); } catch (e) { done(e); }
  };
  const mod = { ...real, exec, execFile, execFileSync, execSync };
  return { ...mod, default: mod };
});
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/docker/dockerClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
  pullImage: async () => {},
  buildImage: async () => { d.builds++; },
  composeUp: async (composePath: string, appName: string) => {
    d.ups.push(appName);
    const fs = require('fs') as typeof import('fs');
    const YAML = require('yaml');
    const services = Object.keys(YAML.parse(fs.readFileSync(composePath, 'utf-8'))?.services ?? {});
    d.running[appName] = services;
    d.appEnv[appName] = appServiceEnv(composePath);
  },
  composeDown: async (_composePath: string, appName: string) => { d.downs.push(appName); d.running[appName] = []; },
  verifyComposeProjectRunning: async () => ({ allRunning: true, problems: [] }),
  listBotContainers: async () => [],
  listContainersByBotId: async () => [],
  listPublishedHostPorts: () => new Map(),
  checkDockerConnection: async () => true,
  imageState: async () => d.image(),
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: (_w: unknown, type: string, data: any) => { d.broadcasts.push({ type, data }); } }));
vi.mock('simple-git', () => {
  const make = () => {
    const client: any = {
      env: () => client,
      log: async () => ({ latest: { hash: d.head, message: 'm', date: 'd' } }),
      revparse: async (args: string[]) => (args[0] === 'HEAD' ? d.head : 'main'),
      raw: async () => '',
    };
    return client;
  };
  return { default: make, simpleGit: make };
});
vi.mock('../../src/source/sourceManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/source/sourceManager')>();
  const fetchSourceHeld = async () => ({ hasUpdates: false, behindBy: 0 });
  return {
    ...real,
    getSource: (id: string) => ({ id, url: 'https://github.com/x/fully-modular-discord-bot', branch: 'main', lastCommitHash: d.head, lastChecked: 1 }),
    getSourceRepoPath: () => d.repo,
    readSourceHead: async () => d.head,
    fetchSourceHeld,
    fetchSource: (id: string) => real.withSourceLock(id, fetchSourceHeld),
  };
});
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./migrate-fake')).hookMock(await o()));
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./migrate-fake')).dbLoginMock(await o()));
vi.mock('../../src/instance/fleetBackup', async (o) => ({ ...(await o<typeof import('../../src/instance/fleetBackup')>()), ...(await import('./migrate-fake')).fenceMock() }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { runMaintenanceOrder } from '../../src/instance/maintenance';
import { laneDone, runMigration, MIGRATE_TIMING } from '../../src/instance/migrate';
import { createBotRoutes } from '../../src/webui/routes/bots';
import { fastTiming, getJob, m, resetMigrate, SMDB, MG_URL_FORM_A } from './migrate-fake';
import { fleetBackupScopeState, previewFleetRestore } from '../../src/instance/fleetBackup';
import * as maintenanceModule from '../../src/instance/maintenance';

const registryPath = () => path.join(d.dir, 'instances.json');
const stored = (id = 'b1'): any => JSON.parse(fs.readFileSync(registryPath(), 'utf-8')).instances[id];
const router = createBotRoutes({ clients: new Set() } as any);
const call = async (method: 'get' | 'put' | 'post' | 'delete', routePath: string, params: Record<string, string>, body: unknown = {}, query: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`no route ${method} ${routePath}`);
  const res: any = { statusCode: 200 };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.send = (b: unknown) => { res.body = b; return res; };
  res.setHeader = () => res;
  await layer.route.stack[layer.route.stack.length - 1].handle({ params, query, body, headers: {} }, res);
  return { status: res.statusCode, body: res.body };
};

function instance(id: string, over: Record<string, unknown> = {}) {
  return {
    id, sanitizedName: id, displayName: id.toUpperCase(), titleName: id.toUpperCase(), status: 'stopped',
    sourceType: 'git', sourceId: 'src1', sourceUrl: SMDB, envVars: {}, lastBuiltCommit: 'f'.repeat(40), updateToken: 'tok-' + id + '-0123456789',
    createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z', ...over,
  };
}

/** A JSON bot built by the real buildBot, started, and put into a settled Maintenance by the real order; with mode false the store holds no DATA_BACKEND. */
async function jsonBot(id = 'b1', opts: { mode?: boolean } = {}): Promise<void> {
  const reg = fs.existsSync(registryPath()) ? JSON.parse(fs.readFileSync(registryPath(), 'utf-8')) : { instances: {} };
  reg.instances[id] = instance(id);
  fs.mkdirSync(path.join(d.dir, 'bots', id, 'env'), { recursive: true });
  fs.writeFileSync(registryPath(), JSON.stringify(reg));
  if (opts.mode !== false) await containerManager.updateBot(id, { envVars: { DATA_BACKEND: 'file' } });
  expect((await containerManager.buildBot(id)).success).toBe(true);
  expect((await containerManager.startBot(id)).success).toBe(true);
  const order = await runMaintenanceOrder(id, 'maintenance', 'Back soon');
  expect(order.settled).toBe(true);
}

async function press(to: 'postgres' | 'file', id = 'b1') {
  const a = await runMigration(id, to, 'press');
  await laneDone(id);
  return a;
}

beforeEach(() => {
  resetMigrate();
  fastTiming(MIGRATE_TIMING);
  Object.assign(d, { exec: [], running: {}, appEnv: {}, inspect: [], dbUpFail: null, image: () => 'present', builds: 0, ups: [], downs: [], broadcasts: [] });
  fs.rmSync(path.join(d.dir, 'bots'), { recursive: true, force: true });
  fs.rmSync(registryPath(), { force: true });
  fs.mkdirSync(d.repo, { recursive: true });
  fs.writeFileSync(path.join(d.repo, 'docker-compose.yml'), 'services:\n  app:\n    build: .\n');
  fs.writeFileSync(path.join(d.repo, 'Dockerfile'), 'FROM node:20\n');
  m.login = { inRecovery: false, canLogin: true, sessions: 0 };
});
afterEach(async () => {
  await laneDone('b1');
});
afterAll(() => fs.rmSync(d.dir, { recursive: true, force: true }));

describe('the lane against the real start, compose and gates (B-7)', () => {
  it('RL1 a press to Postgres attaches fleet-postgres to the deployed compose and stores the companion URL; a failing up closes MG-DB-SETUP', async () => {
    await jsonBot();
    m.bot.script = [{ state: 'running', stage: 'copying' }, { state: 'done', stage: 'switching' }];
    const a = await press('postgres');
    expect(a).toEqual({ accepted: true });
    const db = stored().fleetDb;
    expect(db?.containerName).toBeTruthy();
    const compose = fs.readFileSync(path.join(d.dir, 'bots', 'b1', 'docker-compose.yml'), 'utf-8');
    expect(compose).toContain('fleet-postgres');
    expect(compose).toContain(db.containerName);
    expect(d.exec.some(l => /up -d fleet-postgres$/.test(l))).toBe(true);
    expect(envManager.getEnvVars('b1').DATA_BACKEND_URL).toContain(db.containerName);
    expect(stored().migrateLast).toMatchObject({ outcome: 'done' });
  });
  it('RL1 with the fleet-postgres up failing, the deployed compose reads as before and the record closes MG-DB-SETUP', async () => {
    await jsonBot();
    const composePath = path.join(d.dir, 'bots', 'b1', 'docker-compose.yml');
    const before = fs.readFileSync(composePath, 'utf-8');
    d.dbUpFail = 'port is already allocated';
    expect(await press('postgres')).toEqual({ accepted: true });
    expect(fs.readFileSync(composePath, 'utf-8')).toBe(before);
    expect(stored().migrateLast).toMatchObject({ outcome: 'failed' });
    expect(stored().migrateLast.text).toMatch(/^The migration did not start: the managed database could not be set up \(/);
  });

  /** A bot on its companion, moved there by a lane run, and put back into a settled Maintenance; answers its stored URL. */
  async function companionBot(id = 'b1'): Promise<string> {
    await jsonBot(id);
    m.bot.journal = [];
    m.bot.script = [{ state: 'done', stage: 'switching' }];
    expect(await press('postgres', id)).toEqual({ accepted: true });
    expect(stored(id).migrateLast).toMatchObject({ outcome: 'done' });
    expect((await runMaintenanceOrder(id, 'maintenance', 'Back soon')).settled).toBe(true);
    m.bot.journal = [];
    m.bot.script = [];
    m.events = [];
    const db = stored(id).fleetDb.containerName;
    Object.defineProperty(m.sidecar, db, { get: () => (d.running[id] ?? []).includes('fleet-postgres'), enumerable: true, configurable: true });
    return envManager.getEnvVars(id).DATA_BACKEND_URL;
  }
  /** A JSON bot whose Database URL, set through the real env route, names hostUrl. */
  async function hostOn(hostUrl: string, id: string): Promise<void> {
    await jsonBot(id);
    const r = await call('put', '/:id/env', { id }, { vars: { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: hostUrl } });
    expect(r.status).toBe(200);
  }
  /** b1 on its companion; s1 with a companion of its own, now reading b1's database; b2 reading s1's database. */
  async function chain(): Promise<void> {
    const b1Url = await companionBot('b1');
    const s1Url = await companionBot('s1');
    expect((await call('put', '/:id/env', { id: 's1' }, { vars: { DATA_BACKEND_URL: b1Url } })).status).toBe(200);
    expect((await containerManager.restartBot('s1')).success).toBe(true);
    await hostOn(s1Url, 'b2');
    expect(d.running.s1).toContain('fleet-postgres');
    expect(maintenanceModule.maintenanceKind(stored('s1'), envManager.getEnvVars('s1'))).toBe('external');
  }
  /** A press to JSON files parked by a 401 GET, as RL7 does. */
  async function parked(id: string): Promise<void> {
    m.bot.journal = [];
    m.bot.getQueue.push(null, null, { ok: false, status: 401, body: { success: false, error: 'bad token' }, error: 'bad token' });
    expect(await press('file', id)).toEqual({ accepted: true });
    expect(stored(id).migrate).toMatchObject({ phase: 'waiting' });
    m.bot.getQueue = [];
  }
  async function until(f: () => boolean) {
    const end = Date.now() + 5000;
    while (!f() && Date.now() < end) await new Promise(r => setTimeout(r, 5));
    expect(f()).toBe(true);
  }
  const files = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).sort() : []);

  const routes: Array<[string, 'put' | 'post' | 'delete', string, Record<string, string>, unknown, RegExp]> = [
    ['PUT /:id envVars', 'put', '/:id', { id: 'b1' }, { envVars: { DATA_BACKEND: 'file' } }, /DATA_BACKEND and DATA_BACKEND_URL cannot change/],
    ['PUT /:id rename', 'put', '/:id', { id: 'b1' }, { displayName: 'New Project' }, /source and its project name cannot change/],
    ['PUT /:id/source', 'put', '/:id/source', { id: 'b1' }, { sourceId: 'x' }, /source and its project name cannot change/],
    ['PUT /:id/env', 'put', '/:id/env', { id: 'b1' }, { vars: { DATA_BACKEND_URL: 'postgresql://a@b/c' } }, /DATA_BACKEND and DATA_BACKEND_URL cannot change/],
    ['DELETE /:id/env/:key', 'delete', '/:id/env/:key', { id: 'b1', key: 'DATA_BACKEND' }, {}, /DATA_BACKEND and DATA_BACKEND_URL cannot change/],
    ['PUT /:id/config', 'put', '/:id/config', { id: 'b1' }, { files: [] }, /its files cannot change/],
    ['PUT /:id/fs/write', 'put', '/:id/fs/write', { id: 'b1' }, { path: 'rl4-written.txt', body: 'b' }, /its files cannot change/],
    ['POST /:id/fs/create', 'post', '/:id/fs/create', { id: 'b1' }, { path: 'rl4-created.txt' }, /its files cannot change/],
    ['POST /:id/fs/mkdir', 'post', '/:id/fs/mkdir', { id: 'b1' }, { path: 'rl4-dir' }, /its files cannot change/],
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

  it('RL4, RL5, RL11 while the lane holds migrate at following, every gated route answers 409 and only the lane\'s own calls pass', async () => {
    await companionBot();
    expect(await runMigration('b1', 'file', 'press')).toEqual({ accepted: true });
    await until(() => stored().migrate?.phase === 'following' && containerManager.isBotBusy('b1') === 'migrate' && m.bot.gets > 2);
    const env = () => JSON.stringify(envManager.getEnvVars('b1'));
    const envBefore = env();
    const dataBefore = files(path.join(d.dir, 'bots', 'b1'));
    for (const [name, method, p, params, body, text] of routes) {
      const before = fs.readFileSync(registryPath(), 'utf-8');
      const r = await call(method, p, params, body);
      expect([name, r.status], name).toEqual([name, 409]);
      expect(r.body.error, name).toMatch(text);
      expect(fs.readFileSync(registryPath(), 'utf-8'), name).toBe(before);
    }
    expect(env()).toBe(envBefore);
    expect(files(path.join(d.dir, 'bots', 'b1'))).toEqual(dataBefore);
    // RL5: the record's own gates hold against the lane's lock too.
    expect(containerManager.startPreflightRefusal('b1')?.error).toBe('A data migration to JSON files is open on this bot; it starts only through Migrate, so press Migrate to go on');
    await expect(containerManager.updateBot('b1', { envVars: { DATA_BACKEND: 'file' } })).rejects.toThrow('A data migration to JSON files is open on this bot, so DATA_BACKEND and DATA_BACKEND_URL cannot change until it ends; nothing was changed');
    // RL11: an unchanged url is admitted, a changed one refused.
    const url = envManager.getEnvVars('b1').DATA_BACKEND_URL;
    expect((await call('put', '/:id', { id: 'b1' }, { envVars: { DATA_BACKEND_URL: url } })).status).toBe(200);
    expect((await call('put', '/:id', { id: 'b1' }, { envVars: { DATA_BACKEND_URL: `${url}x` } })).status).toBe(409);
    const ups = d.ups.length;
    m.bot.script.push({ state: 'done', stage: 'switching' });
    await laneDone('b1');
    expect(stored().migrateLast).toMatchObject({ outcome: 'done', to: 'file' });
    expect(envManager.getEnvVars('b1').DATA_BACKEND).toBe('file');
    expect(d.ups.length).toBeGreaterThan(ups);
    expect(stored().maintenance).toMatchObject({ state: 'running', settled: true });
    const written = await call('put', '/:id/fs/write', { id: 'b1' }, { path: 'rl4-written.txt', body: 'b' });
    expect(written.status).toBe(200);
    expect(written.body).toMatchObject({ success: true });
    expect(fs.existsSync(path.join(d.dir, 'bots', 'b1', 'data', 'rl4-written.txt'))).toBe(true);
  });
  it('RL6 a record the lane parked at finishing stored: a blank DATA_BACKEND is refused, a NODE_NAME beside the stored value saves, a press closes done', async () => {
    await jsonBot();
    m.bot.script = [{ state: 'done', stage: 'switching' }];
    d.inspect.push({ DATA_BACKEND: 'file' });
    expect(await press('postgres')).toEqual({ accepted: true });
    expect(stored().migrate).toMatchObject({ phase: 'waiting', resumeAt: 'finishing', finishing: 'stored' });
    const r = await call('put', '/:id/env', { id: 'b1' }, { vars: { DATA_BACKEND: '', NODE_NAME: 'x' } });
    expect(r).toEqual({ status: 409, body: { success: false, error: 'A data migration to Postgres is open on this bot, so DATA_BACKEND and DATA_BACKEND_URL cannot change until it ends; nothing was changed' } });
    expect(envManager.getEnvVars('b1').DATA_BACKEND).toBe('postgres');
    expect(envManager.getEnvVars('b1').NODE_NAME).toBeUndefined();
    expect((await call('put', '/:id/env', { id: 'b1' }, { vars: { DATA_BACKEND: 'postgres', NODE_NAME: 'x' } })).status).toBe(200);
    expect(envManager.getEnvVars('b1').NODE_NAME).toBe('x');
    expect(await press('postgres')).toEqual({ accepted: true });
    expect(stored().migrate).toBeUndefined();
    expect(stored().migrateLast).toMatchObject({ outcome: 'done', to: 'postgres' });
  });

  /** s1, a running bot whose Database URL names b1's companion. */
  async function sharerOn(hostId: string, id = 's1'): Promise<void> {
    await jsonBot(id);
    expect((await runMaintenanceOrder(id, 'running', '')).settled).toBe(true);
    await containerManager.updateBot(id, { envVars: { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: envManager.getEnvVars(hostId).DATA_BACKEND_URL } });
  }

  it('RL7 a sharer M5 stopped, with the record parked by a 401 GET: after loadOpRecords its Start, Build and Update answer MG-SHARER-HELD and docker builds and starts nothing for it', async () => {
    await companionBot();
    await sharerOn('b1');
    expect(d.running.s1).toContain('app');
    m.bot.getQueue.push(null, null, { ok: false, status: 401, body: { success: false, error: 'bad token' }, error: 'bad token' });
    expect(await press('file')).toEqual({ accepted: true });
    expect(stored().migrate).toMatchObject({ phase: 'waiting', sharers: ['s1'], sharersStopped: ['s1'] });
    expect(stored().migrate.text).toMatch(/refused the manager's token \(HTTP 401: bad token\)/);
    expect(d.running.s1 ?? []).toEqual([]);
    const s1State = JSON.stringify(stored('s1').maintenance);
    const off = await runMaintenanceOrder('s1', 'off', '');
    expect(off.text).toBe("B1's data migration to JSON files is open on the database this bot uses, so this bot's state cannot change until that migration ends; nothing was changed");
    expect(JSON.stringify(stored('s1').maintenance)).toBe(s1State);
    containerManager.loadOpRecords();
    const ups = d.ups.length;
    const builds = d.builds;
    const held = "S1 is held by B1's open data migration to JSON files, since it uses the same database; try again once that migration ends; nothing was changed";
    expect((await containerManager.startBot('s1')).error).toBe(held);
    expect((await containerManager.buildBot('s1')).error).toBe(held);
    expect((await containerManager.pullAndRebuild('s1')).error).toBe(held);
    expect(d.ups.length).toBe(ups);
    expect(d.builds).toBe(builds);
  });
  it('RL35 (pin, O48) an adopted move holds a running sharer: its Start, Restart, Build and Update answer MG-SHARER-HELD with nothing built, started or stopped', async () => {
    await companionBot();
    await sharerOn('b1');
    expect(d.running.s1).toContain('app');
    m.bot.journal = [{ jobId: 'cli-1', to: 'file', state: 'running', stage: 'copying' }];
    m.bot.getQueue.push(null, { ok: false, status: 401, body: { success: false, error: 'bad token' }, error: 'bad token' });
    expect(await press('file')).toEqual({ accepted: true });
    expect(stored().migrate).toMatchObject({ phase: 'waiting', resumeAt: 'following', adoptedJob: 'cli-1', sharers: ['s1'], sharersStopped: [] });
    m.bot.getQueue = [];
    const ups = d.ups.length;
    const builds = d.builds;
    const downs = count(d.downs, 's1');
    const held = "S1 is held by B1's open data migration to JSON files, since it uses the same database; try again once that migration ends; nothing was changed";
    expect((await containerManager.startBot('s1')).error).toBe(held);
    expect((await containerManager.restartBot('s1')).error).toBe(held);
    expect((await containerManager.buildBot('s1')).error).toBe(held);
    expect((await containerManager.pullAndRebuild('s1')).error).toBe(held);
    expect(d.ups.length).toBe(ups);
    expect(d.builds).toBe(builds);
    expect(count(d.downs, 's1')).toBe(downs);
    expect(d.running.s1).toContain('app');
  });

  const OWNER_HOSTED = (owner: string) => `The Database URL names a database in ${owner}'s managed database container, so the migration was refused: Migrate moves data only to or from this bot's own managed database or a database outside this manager's containers, and Migrate on ${owner} moves ${owner}'s own data; nothing was changed`;
  const ORDER_HELD = (other: string) => `${other}'s data migration to JSON files is open on the database this bot uses, so this bot's state cannot change until that migration ends; nothing was changed`;
  const DEST_HOSTED = (jobId: string, dest: string, owner: string) => `Migration ${jobId} is done, and the bot names ${dest} as the database the copy went to, which is in ${owner}'s managed database container. Migrate does not move a bot onto another bot's managed database, so the migration was closed with the Data Backend unchanged, and the bot stays in Maintenance. The JSON files keep the data as it was before the copy, but after this migration the bot refuses to boot on them; it boots on the copy once its Data Backend is postgres and its Database URL names ${dest}.`;
  const DEST_URL = (owner: string) => `A data migration to Postgres is open on this bot and waits for the Database URL of the database the copy went to; the URL given names a database in ${owner}'s managed database container, and Migrate does not move a bot onto another bot's managed database; nothing was changed`;
  const count = (list: string[], id: string) => list.filter(x => x === id).length;
  const withDatabase = (url: string, name: string) => { const u = new URL(url); u.pathname = `/${name}`; return u.toString(); };

  it('RL26 (A41, to file) b1 on s1\'s managed database, its URL set by the env route: MG-OWNER-HOSTED naming S1, no record, and s1 stops', async () => {
    const s1Url = await companionBot('s1');
    await hostOn(s1Url, 'b1');
    m.bot.journal = [];
    expect(await press('file')).toEqual({ accepted: false, status: 409, error: OWNER_HOSTED('S1') });
    expect(stored().migrate).toBeUndefined();
    expect((await call('post', '/:id/stop', { id: 's1' }, {})).status).toBe(200);
  });

  it('RL27 (A41, to Postgres) a JSON bot whose URL names s1\'s container under another database name: MG-OWNER-HOSTED, no record and no fleetDb', async () => {
    const s1Url = await companionBot('s1');
    await jsonBot('b1');
    expect((await call('put', '/:id/env', { id: 'b1' }, { vars: { DATA_BACKEND_URL: withDatabase(s1Url, 'b1data') } })).status).toBe(200);
    expect(await press('postgres')).toEqual({ accepted: false, status: 409, error: OWNER_HOSTED('S1') });
    expect(stored().migrate).toBeUndefined();
    expect(stored().fleetDb).toBeUndefined();
  });

  it('RL8 (round 4) s1, a sharer with a database of its own, after b1\'s M5: its restore, decommission, slot drop, Start, Build, Update, state orders and Migrate are refused; b2 on s1\'s container is refused by A41', async () => {
    await chain();
    await parked('b1');
    expect(stored('b1').migrate).toMatchObject({ sharers: ['s1'], sharersStopped: ['s1'] });
    expect(stored('b1').migrate.owner).toBeUndefined();
    const dir = (await import('../../src/instance/backupFiles')).backupDir('s1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'daily-x.dump'), 'x');
    const execBefore = d.exec.length;
    const restore = await (await import('../../src/instance/fleetBackup')).restoreFleetBackup('s1', 'daily-x.dump');
    expect(restore.error).toMatch(/^B1's data migration to JSON files is open on the database this bot's Database URL names; /);
    expect(d.exec.slice(execBefore).some(l => /DROP/i.test(l))).toBe(false);
    const heldDb = "B1's data migration to JSON files is open on the database this bot uses, so this bot's database setup cannot change until that migration ends; nothing was changed";
    expect((await call('post', '/:id/fleet-db/decommission', { id: 's1' }, {})).body.error).toBe(heldDb);
    expect((await call('delete', '/:id/fleet-replication/slots/:slot', { id: 's1', slot: 'x' }, {})).body.error).toBe(heldDb);
    const sharerHeld = "S1 is held by B1's open data migration to JSON files, since it uses the same database; try again once that migration ends; nothing was changed";
    expect((await containerManager.startBot('s1')).error).toBe(sharerHeld);
    expect((await containerManager.buildBot('s1')).error).toBe(sharerHeld);
    expect((await containerManager.pullAndRebuild('s1')).error).toBe(sharerHeld);
    expect((await runMaintenanceOrder('s1', 'off', '')).text).toBe(ORDER_HELD('B1'));
    expect(await runMigration('s1', 'file', 'press')).toEqual({ accepted: false, status: 409, error: "B1's data migration to JSON files is open on the database this bot uses, so this bot cannot migrate until that migration ends; nothing was changed" });
    expect(await runMigration('b2', 'file', 'press')).toEqual({ accepted: false, status: 409, error: OWNER_HOSTED('S1') });
  });

  it('RL20 (round 4, pin) b1 and s1 on an outside database, s1 with its own record: b1\'s press closes MG-SHARER-OPEN and s1 is not stopped', async () => {
    const outside = 'postgresql://u:p@db.example.test:5432/app';
    await hostOn(outside, 'b1');
    await jsonBot('s1');
    expect((await call('put', '/:id/env', { id: 's1' }, { vars: { DATA_BACKEND_URL: outside } })).status).toBe(200);
    m.bot.journal = [];
    m.bot.getQueue.push(null, null, { ok: false, status: 401, body: { success: false, error: 'bad token' }, error: 'bad token' });
    expect(await press('postgres', 's1')).toEqual({ accepted: true });
    expect(stored('s1').migrate).toMatchObject({ phase: 'waiting', resumeAt: 'following' });
    m.bot.getQueue = [];
    const r1 = JSON.stringify(stored('s1').migrate);
    const downs = count(d.downs, 's1');
    m.bot.journal = [];
    expect(await press('file', 'b1')).toEqual({ accepted: true });
    expect(stored('b1').migrateLast).toMatchObject({ outcome: 'failed' });
    expect(stored('b1').migrateLast.text).toMatch(/^The migration did not start: S1 uses the same database and has its own data migration to Postgres open, so it was not stopped\. Nothing was copied, and the bot stays in Maintenance; press Migrate again once S1's migration ends\./);
    expect(count(d.downs, 's1')).toBe(downs);
    expect(JSON.stringify(stored('s1').migrate)).toBe(r1);
  });

  it('RL28 (G18, an adopted job) the bot names a copy in s2\'s managed database container: F with MG-DEST-HOSTED, nothing switched, s2 stops', async () => {
    const outside = 'postgresql://u:p@db.example.test:5432/app';
    const s2Url = await companionBot('s2');
    const s2Db = stored('s2').fleetDb.containerName;
    await jsonBot('b1');
    expect((await call('put', '/:id/env', { id: 'b1' }, { vars: { DATA_BACKEND_URL: outside } })).status).toBe(200);
    m.bot.journal = [{ jobId: 'mgr-adopt', to: 'postgres', state: 'running', stage: 'copying', destination: { host: s2Db, port: 5432, database: 'b1data' } }];
    m.bot.script = [{ state: 'done', stage: 'switching' }];
    expect(await press('postgres')).toEqual({ accepted: true });
    expect(stored().migrate).toBeUndefined();
    expect(stored().migrateLast).toMatchObject({ outcome: 'failed' });
    expect(stored().migrateLast.text).toBe(DEST_HOSTED('mgr-adopt', `${s2Db}:5432/b1data`, 'S2'));
    expect(envManager.getEnvVars('b1')).toMatchObject({ DATA_BACKEND: 'file', DATA_BACKEND_URL: outside });
    expect((await call('post', '/:id/stop', { id: 's2' }, {})).status).toBe(200);
    const next = await call('put', '/:id/env', { id: 'b1' }, { vars: { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: withDatabase(s2Url, 'b1data') } });
    expect(next.status).toBe(200);
  });

  it('RL29 (O34) at a destination park the lane wrote, a URL naming s2\'s container is refused by PUT /:id/env and PUT /:id', async () => {
    const s2Url = await companionBot('s2');
    await jsonBot('b1');
    m.bot.journal = [];
    m.bot.destination = { host: 'db.example.test', port: 5432, database: 'app' };
    m.bot.script = [{ state: 'done', stage: 'switching' }];
    expect(await press('postgres')).toEqual({ accepted: true });
    expect(stored().migrate).toMatchObject({ phase: 'waiting', awaiting: 'destination' });
    const url = envManager.getEnvVars('b1').DATA_BACKEND_URL;
    expect(await call('put', '/:id/env', { id: 'b1' }, { vars: { DATA_BACKEND_URL: s2Url } })).toEqual({ status: 409, body: { success: false, error: DEST_URL('S2') } });
    expect(envManager.getEnvVars('b1').DATA_BACKEND_URL).toBe(url);
    const put = await call('put', '/:id', { id: 'b1' }, { envVars: { DATA_BACKEND_URL: s2Url } });
    expect(put.status).toBe(409);
    expect(put.body.error).toBe(DEST_URL('S2'));
    expect(envManager.getEnvVars('b1').DATA_BACKEND_URL).toBe(url);
  });

  /** The editor's save: every listed row as RL15 sends them, with the given values over them. */
  async function editorSave(over: Record<string, string>): Promise<number> {
    const rows = (await call('get', '/:id/env', { id: 'b1' }, {})).body.vars as Array<{ key: string; value: string; sensitive: boolean }>;
    const vars = { ...Object.fromEntries(rows.filter(v => !(v.sensitive && v.value === '')).map(v => [v.key, v.value])), ...over };
    return (await call('put', '/:id/env', { id: 'b1' }, { vars })).status;
  }

  it('RL23 (T4) a stored spelling Postgres: the editor\'s postgres and an API save of " postgres " pass and keep it; file is refused', async () => {
    await companionBot('b1');
    expect((await call('put', '/:id/env', { id: 'b1' }, { vars: { DATA_BACKEND: 'Postgres' } })).status).toBe(200);
    await parked('b1');
    expect(await editorSave({ DATA_BACKEND: 'postgres', DISCORD_TOKEN: 'new' })).toBe(200);
    expect(envManager.getEnvVars('b1')).toMatchObject({ DATA_BACKEND: 'Postgres', DISCORD_TOKEN: 'new' });
    expect((await call('put', '/:id', { id: 'b1' }, { envVars: { DATA_BACKEND: ' postgres ' } })).status).toBe(200);
    expect(envManager.getEnvVars('b1').DATA_BACKEND).toBe('Postgres');
    expect(await call('put', '/:id/env', { id: 'b1' }, { vars: { DATA_BACKEND: 'file' } })).toEqual({ status: 409, body: { success: false, error: 'A data migration to JSON files is open on this bot, so DATA_BACKEND and DATA_BACKEND_URL cannot change until it ends; nothing was changed' } });
    m.bot.script = [{ state: 'done', stage: 'switching' }];
    expect(await press('file')).toEqual({ accepted: true });
    expect(stored().migrateLast).toMatchObject({ outcome: 'done', to: 'file' });
    expect(envManager.getEnvVars('b1').DATA_BACKEND).toBe('file');
  });

  it('RL24 (T4) at a destination park, the editor\'s save of the URL with its file option passes and keeps FILE; postgres is refused', async () => {
    await jsonBot('b1');
    expect((await call('put', '/:id/env', { id: 'b1' }, { vars: { DATA_BACKEND: 'FILE' } })).status).toBe(200);
    m.bot.destination = { host: 'db.example.test', port: 5432, database: 'app' };
    m.bot.script = [{ state: 'done', stage: 'switching' }];
    expect(await press('postgres')).toEqual({ accepted: true });
    expect(stored().migrate).toMatchObject({ phase: 'waiting', awaiting: 'destination' });
    const url = 'postgresql://u:p@db.example.test:5432/app';
    expect(await editorSave({ DATA_BACKEND: 'file', DATA_BACKEND_URL: url })).toBe(200);
    expect(envManager.getEnvVars('b1')).toMatchObject({ DATA_BACKEND: 'FILE', DATA_BACKEND_URL: url });
    expect((await call('put', '/:id/env', { id: 'b1' }, { vars: { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: url } })).status).toBe(409);
  });

  it('RL14 (S1) the bot\'s own Database URL changes while the admission GET is out: MG-CHANGED, no record', async () => {
    await jsonBot('b1');
    let answer!: (v: unknown) => void;
    let asked = false;
    m.bot.getQueue.push(() => { asked = true; return new Promise(r => { answer = r; }) as any; });
    const pressed = runMigration('b1', 'postgres', 'press');
    await until(() => asked);
    expect((await call('put', '/:id/env', { id: 'b1' }, { vars: { DATA_BACKEND_URL: 'postgresql://u:p@db.example.test:5432/app' } })).status).toBe(200);
    answer(getJob(null));
    expect(await pressed).toEqual({ accepted: false, status: 409, error: "The bot's Data Backend or its Database URL changed while the migration was being admitted; press Migrate again; nothing was changed" });
    await laneDone('b1');
    expect(stored().migrate).toBeUndefined();
  });

  it('RL15 (S5) a mode key never stored: the editor\'s default file is saved beside another change while a record is open; postgres is refused', async () => {
    await jsonBot('b1', { mode: false });
    const list = await call('get', '/:id/env', { id: 'b1' }, {});
    const row = list.body.vars.find((v: any) => v.key === 'DATA_BACKEND');
    expect(row).toMatchObject({ value: 'file', isSet: false });
    m.bot.getQueue.push(null, null, { ok: false, status: 401, body: { success: false, error: 'bad token' }, error: 'bad token' });
    expect(await press('postgres')).toEqual({ accepted: true });
    expect(stored().migrate).toMatchObject({ phase: 'waiting', to: 'postgres' });
    m.bot.getQueue = [];
    const rows = (await call('get', '/:id/env', { id: 'b1' }, {})).body.vars as Array<{ key: string; value: string; sensitive: boolean }>;
    const vars = { ...Object.fromEntries(rows.filter(v => !(v.sensitive && v.value === '')).map(v => [v.key, v.value])), DISCORD_TOKEN: 'new' };
    const saved = await call('put', '/:id/env', { id: 'b1' }, { vars });
    expect(saved.status).toBe(200);
    expect(envManager.getEnvVars('b1').DISCORD_TOKEN).toBe('new');
    expect(envManager.getEnvVars('b1').DATA_BACKEND).toBeUndefined();
    const refused = await call('put', '/:id/env', { id: 'b1' }, { vars: { DATA_BACKEND: 'postgres' } });
    expect(refused).toEqual({ status: 409, body: { success: false, error: 'A data migration to Postgres is open on this bot, so DATA_BACKEND and DATA_BACKEND_URL cannot change until it ends; nothing was changed' } });
    m.bot.script = [{ state: 'done', stage: 'switching' }];
    expect(await press('postgres')).toEqual({ accepted: true });
    expect(stored().migrateLast).toMatchObject({ outcome: 'done', to: 'postgres' });
    expect(envManager.getEnvVars('b1').DATA_BACKEND).toBe('postgres');
  });

  it('RL10 a failed job whose error holds the stored URL\'s password: migrateLast.text and the bot:migrate broadcast hold *** in its place', async () => {
    await companionBot();
    const password = new URL(envManager.getEnvVars('b1').DATA_BACKEND_URL).password;
    expect(password.length).toBeGreaterThan(5);
    m.bot.script = [{ state: 'failed', stage: 'copying', error: `password authentication failed for ${password}` }];
    expect(await press('file')).toEqual({ accepted: true });
    const raw = fs.readFileSync(registryPath(), 'utf-8');
    expect(raw).not.toContain(password);
    expect(stored().migrateLast.text).toMatch(/password authentication failed for \*\*\*/);
    const finals = d.broadcasts.filter(b => b.type === 'bot:migrate' && b.data.final);
    expect(finals.at(-1)?.data.text).toMatch(/failed for \*\*\*/);
    expect(JSON.stringify(d.broadcasts.filter(b => b.type === 'bot:migrate'))).not.toContain(password);
  });

  it('RL16 (C-8) the console lines of the close and of a park hold *** in place of the stored URL\'s password', async () => {
    await companionBot();
    const password = new URL(envManager.getEnvVars('b1').DATA_BACKEND_URL).password;
    const lines: string[] = [];
    const spies = (['log', 'warn', 'error'] as const).map(k => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); }));
    try {
      m.bot.script = [{ state: 'failed', stage: 'copying', error: `password authentication failed for ${password}` }];
      expect(await press('file')).toEqual({ accepted: true });
      expect(stored().migrateLast).toMatchObject({ outcome: 'failed' });
      expect(lines.filter(l => l.includes(password))).toEqual([]);
      m.bot.journal = [];
      m.bot.getQueue.push(null, null, { ok: false, status: 401, body: { success: false, error: `bad token for ${password}` }, error: `bad token for ${password}` });
      expect(await press('file')).toEqual({ accepted: true });
      expect(stored().migrate).toMatchObject({ phase: 'waiting' });
      expect(lines.filter(l => l.includes(password))).toEqual([]);
      expect(lines.some(l => /waits for the operator: .*bad token for \*\*\*/.test(l))).toBe(true);
    } finally {
      for (const sp of spies) sp.mockRestore();
    }
  });

  it('RL2 the image absent from M6\'s stop on: MG-NEEDS-BUILD with no build, MG-RESTART with the stopped clause; absent at finishing: G6 builds once and G7 reads postgres', async () => {
    await jsonBot();
    let gone = false;
    d.image = () => (gone ? 'absent' : 'present');
    m.saveAnswers.push(() => { gone = true; return { ok: true, status: 200, body: { success: true, saved: true } }; });
    const builds = d.builds;
    expect(await press('postgres')).toEqual({ accepted: true });
    expect(d.builds).toBe(builds);
    expect(stored().migrateLast.text).toMatch(/^The migration did not start: the restart into maintenance failed \(the bot's image or compose is missing, and a build in the middle of a migration would rewrite the compose, so the manager did not build it\)\. Nothing was copied, and the bot's state stays Maintenance\. The bot is stopped; start it before pressing Migrate again\.$/);

    gone = false;
    expect((await containerManager.startBot('b1')).success).toBe(true);
    const at = d.builds;
    d.image = () => (stored().migrate?.phase === 'finishing' && d.builds === at ? 'absent' : 'present');
    m.bot.script = [{ state: 'done', stage: 'switching' }];
    expect(await press('postgres')).toEqual({ accepted: true });
    expect(d.builds).toBe(at + 1);
    expect(stored().migrateLast).toMatchObject({ outcome: 'done', to: 'postgres' });
    expect(d.appEnv.b1.DATA_BACKEND).toBe('postgres');
  });

  it('RL3 a record parked with MG-NEEDS-BUILD-WAIT: the operator\'s Build is admitted and keeps fleet-postgres with DATA_BACKEND file; a press goes on to done', async () => {
    await jsonBot();
    m.bot.getQueue.push(null, null, { ok: false, status: 401, body: { success: false, error: 'bad token' }, error: 'bad token' });
    expect(await press('postgres')).toEqual({ accepted: true });
    expect(stored().migrate).toMatchObject({ phase: 'waiting', resumeAt: 'following' });
    expect((await containerManager.stopBot('b1')).success).toBe(true);
    const at = d.builds;
    d.image = () => (d.builds > at ? 'present' : 'absent');
    expect(await press('postgres')).toEqual({ accepted: true });
    expect(stored().migrate.text).toMatch(/could not be started: its image or compose is missing\. The bot stays in Maintenance with the migration open; press Build, then press Migrate\.$/);
    expect((await containerManager.buildBot('b1')).success).toBe(true);
    expect(fs.readFileSync(path.join(d.dir, 'bots', 'b1', 'docker-compose.yml'), 'utf-8')).toContain('fleet-postgres');
    expect(envManager.getEnvVars('b1').DATA_BACKEND).toBe('file');
    m.bot.script = [{ state: 'done', stage: 'switching' }];
    expect(await press('postgres')).toEqual({ accepted: true });
    expect(stored().migrateLast).toMatchObject({ outcome: 'done', to: 'postgres' });
  });

  it('RL30 (A42, round 5; W6, round 6) a URL with a host parameter stored before: the press answers MG-URL-FORM-A, no record, s1 not stopped; the env route stores another form', async () => {
    await companionBot('s1');
    const s1Db = stored('s1').fleetDb.containerName;
    await jsonBot('b2');
    const before = 'postgresql://u:p@db.example.test:5432/smdb?host=' + s1Db;
    envManager.setEnvVars('b2', { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: before });
    m.bot.journal = [];
    const downs = count(d.downs, 's1');
    expect(await press('file', 'b2')).toEqual({ accepted: false, status: 409, error: MG_URL_FORM_A('param') });
    expect(stored('b2').migrate).toBeUndefined();
    expect(count(d.downs, 's1')).toBe(downs);
    expect((await call('put', '/:id/env', { id: 'b2' }, { vars: { DATA_BACKEND_URL: 'postgresql://u:p@pub.example:5432/x?port=5433' } })).status).toBe(200);
    expect(envManager.getEnvVars('b2').DATA_BACKEND_URL).toBe('postgresql://u:p@pub.example:5432/x?port=5433');
  });

  it("RL31 (W3, W5, round 6) s4 with a host parameter naming b1's companion is no sharer: the preview and the confirm leave it out, and the fenced move ends done without stopping it", async () => {
    await companionBot('b1');
    const b1Db = stored('b1').fleetDb.containerName;
    await jsonBot('s4');
    envManager.setEnvVars('s4', { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: 'postgresql://u:p@db.example.test:5432/smdb?host=' + b1Db });
    m.bot.journal = [];
    const preview = await previewFleetRestore('b1');
    expect(preview.success).toBe(true);
    expect((preview as any).instances.map((i: any) => i.displayName)).not.toContain('S4');
    const view = await call('get', '/:id/migrate', { id: 'b1' });
    expect(view.status).toBe(200);
    expect(view.body.sharers).not.toContain('S4');
    expect(view.body.fenced).toBe(true);
    const downs = count(d.downs, 's4');
    m.bot.script = [{ state: 'done', stage: 'switching' }];
    expect(await press('file', 'b1')).toEqual({ accepted: true });
    expect(stored('b1').migrateLast).toMatchObject({ outcome: 'done', to: 'file' });
    expect(m.events.indexOf('hba-fence')).toBeGreaterThan(-1);
    expect(m.events.indexOf('hba-fence')).toBeLessThan(m.events.indexOf('hba-lift'));
    expect(count(d.downs, 's4')).toBe(downs);
    expect(stored('b1').migrateLast.text).not.toContain('S4');
  });

  it('RL32 (W6, round 6) createInstance with a host parameter in the Database URL makes the instance and stores that value', async () => {
    const url = 'postgresql://u:p@db.example.test:5432/app?host=x';
    const inst: any = await containerManager.createInstance({ sourceId: 'src1', displayName: 'C1', envVars: { DATA_BACKEND_URL: url } } as any);
    expect(inst?.id).toBeTruthy();
    expect(envManager.getEnvVars(inst.id).DATA_BACKEND_URL).toBe(url);
  });

  it('RL34 (W4, round 6) s4 started with b1\'s URL and stored with another: M5 stops it by its deployed env and names it', async () => {
    const b1Url = await companionBot('b1');
    await jsonBot('s4');
    expect((await call('put', '/:id/env', { id: 's4' }, { vars: { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: b1Url } })).status).toBe(200);
    expect((await containerManager.stopBot('s4')).success).toBe(true);
    expect((await containerManager.startBot('s4')).success).toBe(true);
    expect((await call('put', '/:id/env', { id: 's4' }, { vars: { DATA_BACKEND_URL: 'postgresql://u:p@db.example.test:5432/app' } })).status).toBe(200);
    m.bot.journal = [];
    const downs = count(d.downs, 's4');
    m.bot.script = [{ state: 'done', stage: 'switching' }];
    expect(await press('file', 'b1')).toEqual({ accepted: true });
    expect(stored('b1').migrateLast).toMatchObject({ outcome: 'done', to: 'file' });
    expect(count(d.downs, 's4')).toBe(downs + 1);
    expect(stored('b1').migrateLast.text).toContain('S4 uses the old database and stays stopped');
  });

  it('RL33 (A13 and D86, round 5) the companion URL with its container in upper case: maintenance, the compose, the backup scope and admission read it as the companion', async () => {
    const url = await companionBot('b1');
    const db = stored().fleetDb.containerName;
    expect((await call('put', '/:id/env', { id: 'b1' }, { vars: { DATA_BACKEND_URL: url.replace(db, db.toUpperCase()) } })).status).toBe(200);
    expect(envManager.getEnvVars('b1').DATA_BACKEND_URL).toContain(db.toUpperCase());
    expect(maintenanceModule.maintenanceKind(stored(), envManager.getEnvVars('b1'))).toBe('database');
    expect(containerManager.ensureFleetDataBackend(stored())).toMatchObject({ containerName: db });
    expect(fleetBackupScopeState(stored())).toBe(true);
    m.fence = { ok: true, on: true, owner: null, persisted: true };
    expect(await press('file')).toMatchObject({ accepted: false, status: 409, error: expect.stringMatching(/READ-ONLY/) });
    expect(stored().migrate).toBeUndefined();
  });

  it('O43 (round 7) Delete with keep data lifts the lines from the kept volume; a lift that cannot change it stops the delete with the record kept', async () => {
    await companionBot('b1');
    await parked('b1');
    const owner = stored('b1').migrate.hbaFence;
    expect(owner).toMatch(/^migrate:\d+$/);
    const volume = stored('b1').fleetDb.volume;
    m.fenceLift = 'locked';
    const stopped = await call('delete', '/:id', { id: 'b1' }, {}, { keepData: 'true' });
    expect(stopped.status).toBe(500);
    expect(stopped.body.error).toContain('The delete stopped before it removed the instance record');
    expect(stopped.body.error).toContain(volume);
    expect(stopped.body.error).toContain('Read-only file system');
    expect(stored('b1').migrate.hbaFence).toBe(owner);
    expect(m.events).toContain('hba-lift');
    m.fenceLift = 'lifted';
    const done = await call('delete', '/:id', { id: 'b1' }, {}, { keepData: 'true' });
    expect(done.status).toBe(200);
    expect(stored('b1')).toBeUndefined();
    expect(m.events.filter(e => e === 'hba-lift')).toHaveLength(2);
  });
  it("(pin) O43's scope: Delete without keep data lifts nothing", async () => {
    await companionBot('b1');
    await parked('b1');
    await call('delete', '/:id', { id: 'b1' }, {}, { keepData: 'false', confirmFleetData: 'true' });
    expect(m.events).not.toContain('hba-lift');
  });
  it("B41, a stop that reads docker: a bot stored stopped whose app container docker shows running is stopped with seen", async () => {
    await jsonBot('s1');
    expect((await containerManager.stopBot('s1')).success).toBe(true);
    d.running.s1 = ['app'];
    expect(await containerManager.stopBot('s1')).toEqual({ success: false, error: 'Bot is not running' });
    expect((await containerManager.stopBot('s1', { seen: true })).success).toBe(true);
    expect(d.downs.filter(x => x === 's1')).toHaveLength(2);
    expect(d.running.s1).toEqual([]);
    expect(stored('s1').status).toBe('stopped');
  });
  it("(pin) B41's scope: with seen, a stored-stopped bot docker shows stopped answers 'Bot is not running'", async () => {
    await jsonBot('s1');
    expect((await containerManager.stopBot('s1')).success).toBe(true);
    expect(await containerManager.stopBot('s1', { seen: true })).toEqual({ success: false, error: 'Bot is not running' });
    expect(d.downs.filter(x => x === 's1')).toHaveLength(1);
  });
});
