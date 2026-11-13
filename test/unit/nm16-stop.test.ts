import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// nm10-real.test.ts's harness: the real containerManager, maintenance, fleetBackup and bots router, with a fake at the
// docker boundary. The listing fakes derive every container from d.running: one per service, named as the compose's
// container_name (`<project>-<service>`), in State d.states[project][service] or 'running'.
const d = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm16-stop-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    repo: nodePath.join(dir, 'repo'),
    head: 'a'.repeat(40),
    exec: [] as string[],
    running: {} as Record<string, string[]>,
    states: {} as Record<string, Record<string, string>>,
    appEnv: {} as Record<string, Record<string, string>>,
    envOf: {} as Record<string, Record<string, string>>,
    inspectFail: [] as string[],
    inspect: [] as Array<Record<string, string>>,
    dbUpFail: null as string | null,
    downFail: null as string | null,
    listFail: false,
    mode: 'docker' as 'docker' | 'casaos',
    casaosDowns: [] as string[],
    sticky: '',
    onStop: null as (() => void) | null,
    lists: 0,
    syncLists: 0,
    seq: [] as string[],
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

function listing(): any[] | null {
  if (d.listFail) return null;
  return Object.entries(d.running).flatMap(([p, services]) => services.map(s => ({
    id: `${p}-${s}-id`, name: `${p}-${s}`, state: d.states[p]?.[s] ?? 'running', status: '', ports: [], project: p, service: s,
  })));
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
      if (d.inspectFail.includes(id)) throw fail('Error: No such object');
      const p = id.replace(/-[^-]+-id$/, '').replace(/-app$/, '');
      const env = d.envOf[id] ?? (d.inspect.length ? d.inspect.shift()! : d.appEnv[p] ?? d.appEnv[Object.keys(d.appEnv)[0]] ?? {});
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
  getDeploymentMode: async () => d.mode,
}));
vi.mock('../../src/casaos/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/api')>()),
  composeDown: async (appName: string) => {
    d.casaosDowns.push(appName);
    d.seq.push(`casaos-down:${appName}`);
    if (d.downFail) return { success: false, error: d.downFail };
    d.running[appName] = [];
    return { success: true };
  },
}));
vi.mock('../../src/docker/dockerClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
  pullImage: async () => {},
  buildImage: async () => { d.builds++; },
  composeUp: async (composePath: string, appName: string) => {
    d.ups.push(appName);
    d.seq.push(`up:${appName}`);
    const fs = require('fs') as typeof import('fs');
    const YAML = require('yaml');
    const services = Object.keys(YAML.parse(fs.readFileSync(composePath, 'utf-8'))?.services ?? {});
    d.running[appName] = services;
    d.appEnv[appName] = appServiceEnv(composePath);
  },
  composeDown: async (_composePath: string, appName: string) => {
    if (d.downFail) throw new Error(d.downFail);
    d.downs.push(appName);
    d.seq.push(`down:${appName}`);
    d.running[appName] = [];
  },
  stopContainer: async (name: string) => {
    d.seq.push(`stop:${name}`);
    d.onStop?.();
    if (name === d.sticky) return;
    for (const [p, services] of Object.entries(d.running)) {
      if (name.startsWith(`${p}-`)) d.running[p] = services.filter(s => `${p}-${s}` !== name);
    }
  },
  verifyComposeProjectRunning: async () => ({ allRunning: true, problems: [] }),
  listBotContainers: async () => { d.syncLists++; return listing(); },
  listBotContainersAsync: async () => { d.lists++; return listing(); },
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
import { fastTiming, m, resetMigrate, SMDB } from './migrate-fake';
import { runningDatabaseSharers } from '../../src/instance/fleetBackup';

const STOP_UNSEEN = 'Docker did not say whether the bot runs, so nothing was stopped';
const WORKER_COMPOSE = 'services:\n  app:\n    build: .\n  worker:\n    image: alpine:3.20\n';

const registryPath = () => path.join(d.dir, 'instances.json');
const stored = (id = 'b1'): any => JSON.parse(fs.readFileSync(registryPath(), 'utf-8')).instances[id];
const deployedCompose = (id: string) => path.join(d.dir, 'bots', id, 'docker-compose.yml');
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

/** A JSON bot built by the real buildBot, started, and put into a settled Maintenance by the real order. */
async function jsonBot(id = 'b1'): Promise<void> {
  const reg = fs.existsSync(registryPath()) ? JSON.parse(fs.readFileSync(registryPath(), 'utf-8')) : { instances: {} };
  reg.instances[id] = instance(id);
  fs.mkdirSync(path.join(d.dir, 'bots', id, 'env'), { recursive: true });
  fs.writeFileSync(registryPath(), JSON.stringify(reg));
  await containerManager.updateBot(id, { envVars: { DATA_BACKEND: 'file' } });
  expect((await containerManager.buildBot(id)).success).toBe(true);
  expect((await containerManager.startBot(id)).success).toBe(true);
  expect((await runMaintenanceOrder(id, 'maintenance', 'Back soon')).settled).toBe(true);
}

async function press(to: 'postgres' | 'file', id = 'b1') {
  const a = await runMigration(id, to, 'press');
  await laneDone(id);
  return a;
}

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

/** jsonBot, stopped by the real Stop, then its app started outside the manager. */
async function startedOutside(id = 's1'): Promise<void> {
  await jsonBot(id);
  expect((await containerManager.stopBot(id)).success).toBe(true);
  d.running[id] = ['app'];
}

const after = (from: number) => d.seq.slice(from);

beforeEach(() => {
  resetMigrate();
  fastTiming(MIGRATE_TIMING);
  Object.assign(d, {
    exec: [], running: {}, states: {}, appEnv: {}, envOf: {}, inspectFail: [], inspect: [], dbUpFail: null, downFail: null, listFail: false, mode: 'docker', casaosDowns: [], sticky: '', onStop: null,
    lists: 0, syncLists: 0, seq: [], image: () => 'present', builds: 0, ups: [], downs: [], broadcasts: [],
  });
  fs.rmSync(path.join(d.dir, 'bots'), { recursive: true, force: true });
  fs.rmSync(registryPath(), { force: true });
  fs.mkdirSync(d.repo, { recursive: true });
  fs.writeFileSync(path.join(d.repo, 'docker-compose.yml'), 'services:\n  app:\n    build: .\n');
  fs.writeFileSync(path.join(d.repo, 'Dockerfile'), 'FROM node:20\n');
  m.login = { inRecovery: false, canLogin: true, sessions: 0 };
});
afterEach(async () => {
  for (const id of ['b1', 's1', 's2', 's3']) await laneDone(id);
  vi.restoreAllMocks();
});
afterAll(() => fs.rmSync(d.dir, { recursive: true, force: true }));

describe('NM16: Stop reads docker when the status is not running', () => {
  it('S1 (G2, C2) Stop on a bot stored stopped whose app docker runs stops it', async () => {
    await jsonBot('s1');
    expect((await call('post', '/:id/stop', { id: 's1' })).status).toBe(200);
    d.running.s1 = ['app'];
    const r = await call('post', '/:id/stop', { id: 's1' });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(d.downs.filter(x => x === 's1')).toHaveLength(2);
    expect(d.running.s1).toEqual([]);
    expect(stored('s1').status).toBe('stopped');
    expect(d.broadcasts.filter(b => b.type === 'bot:stopped')).toHaveLength(2);
  });
  it("S2 (G3, C3, C6) Stop on a stopped bot docker runs nothing of answers 'Bot is not running'", async () => {
    await jsonBot('s1');
    expect((await call('post', '/:id/stop', { id: 's1' })).status).toBe(200);
    const r = await call('post', '/:id/stop', { id: 's1' });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ success: false, error: 'Bot is not running' });
    expect(d.downs.filter(x => x === 's1')).toHaveLength(1);
  });
  it('S3 (G4, C4) with the listing unanswered, Stop stops nothing and says so', async () => {
    await jsonBot('s1');
    expect((await call('post', '/:id/stop', { id: 's1' })).status).toBe(200);
    d.running.s1 = ['app'];
    d.listFail = true;
    const r = await call('post', '/:id/stop', { id: 's1' });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ success: false, error: STOP_UNSEEN });
    expect(d.downs.filter(x => x === 's1')).toHaveLength(1);
    expect(d.running.s1).toEqual(['app']);
    expect(stored('s1').status).toBe('stopped');
  });
  it('(pin) S4 (G1) a running bot is stopped without the listing', async () => {
    await jsonBot('s1');
    d.listFail = true;
    expect((await containerManager.stopBot('s1')).success).toBe(true);
    expect(d.downs.filter(x => x === 's1')).toHaveLength(1);
  });
  it("S5 (G2, G10) a crash loop the reconciler reads as 'error' is stopped", async () => {
    fs.writeFileSync(path.join(d.repo, 'docker-compose.yml'), WORKER_COMPOSE);
    await jsonBot('s1');
    d.running.s1 = ['app', 'worker'];
    d.states.s1 = { app: 'restarting' };
    await containerManager.syncContainerStates();
    expect(stored('s1').status).toBe('error');
    expect(containerManager.getReconcileRead('s1')?.containersLive).toEqual(['app', 'worker']);
    expect((await containerManager.stopBot('s1')).success).toBe(true);
    expect(d.running.s1).toEqual([]);
    expect(stored('s1').status).toBe('stopped');
  });
  it("S5b (G2) a crash loop the reconciler reads as 'stopped' is offered and stopped", async () => {
    await jsonBot('s1');
    d.states.s1 = { app: 'restarting' };
    await containerManager.syncContainerStates();
    expect(stored('s1').status).toBe('stopped');
    expect(containerManager.getReconcileRead('s1')?.containersLive).toEqual(['app']);
    expect((await containerManager.stopBot('s1')).success).toBe(true);
    expect(d.running.s1).toEqual([]);
  });
  it("S6 (G3) the bot's database running alone does not open the gate", async () => {
    await companionBot('s1');
    expect((await containerManager.stopBot('s1')).success).toBe(true);
    d.running.s1 = ['fleet-postgres'];
    expect(`s1-fleet-postgres`).toBe(stored('s1').fleetDb.containerName);
    const from = d.seq.length;
    expect(await containerManager.stopBot('s1')).toEqual({ success: false, error: 'Bot is not running' });
    expect(d.running.s1).toEqual(['fleet-postgres']);
    expect(after(from)).not.toContain('down:s1');
    await containerManager.syncContainerStates();
    expect(containerManager.getReconcileRead('s1')?.containersLive).toEqual([]);
  });
  it('S7 (G2, R4) a worker left running opens the gate and the log names it', async () => {
    fs.writeFileSync(path.join(d.repo, 'docker-compose.yml'), WORKER_COMPOSE);
    await jsonBot('s1');
    expect((await containerManager.stopBot('s1')).success).toBe(true);
    d.running.s1 = ['worker'];
    const log = vi.spyOn(console, 'log');
    const from = d.seq.length;
    expect((await containerManager.stopBot('s1')).success).toBe(true);
    expect(d.running.s1).toEqual([]);
    expect(d.downs.filter(x => x === 's1')).toHaveLength(2);
    expect(log.mock.calls.map(c => c[0])).toContain('[Stop] S1: the status reads stopped, but docker runs s1-worker; stopping the bot');
    expect(after(from).filter(e => e.startsWith('stop:'))).toEqual([]);
  });
  it('S8 (G2b) with no compose file the listed containers are stopped by name and the database is left', async () => {
    await companionBot('s1');
    expect((await containerManager.stopBot('s1')).success).toBe(true);
    fs.rmSync(deployedCompose('s1'));
    d.running.s1 = ['fleet-postgres', 'worker'];
    const from = d.seq.length;
    expect((await containerManager.stopBot('s1')).success).toBe(true);
    expect(after(from)).toContain('stop:s1-worker');
    expect(after(from)).not.toContain('down:s1');
    expect(d.running.s1).toEqual(['fleet-postgres']);
    expect(stored('s1').status).toBe('stopped');
  });
  it('S8b (G13) a by-name stop that leaves the container running fails the stop', async () => {
    await companionBot('s1');
    expect((await containerManager.stopBot('s1')).success).toBe(true);
    fs.rmSync(deployedCompose('s1'));
    d.running.s1 = ['fleet-postgres', 'worker'];
    d.sticky = 's1-worker';
    expect(await containerManager.stopBot('s1')).toEqual({ success: false, error: 'The stop failed: 1 container of the project still run' });
  });
  it('S8c (G8 on G2b) a by-name stop whose re-read docker does not answer finishes with a warning', async () => {
    await companionBot('s1');
    expect((await containerManager.stopBot('s1')).success).toBe(true);
    fs.rmSync(deployedCompose('s1'));
    d.running.s1 = ['fleet-postgres', 'worker'];
    d.onStop = () => { d.listFail = true; };
    expect(await containerManager.stopBot('s1')).toEqual({ success: true, warning: 'The stop finished, but docker could not confirm that no container still runs' });
    expect(stored('s1').status).toBe('stopped');
  });
  it('S9 (C8) Restart of a bot stored stopped whose app docker runs takes it down before the start', async () => {
    await startedOutside('s1');
    const from = d.seq.length;
    expect((await containerManager.restartBot('s1')).success).toBe(true);
    const seq = after(from);
    expect(seq.indexOf('down:s1')).toBeGreaterThanOrEqual(0);
    expect(seq.indexOf('down:s1')).toBeLessThan(seq.indexOf('up:s1'));
    expect(stored('s1').status).toBe('running');
  });
  it('S10 (C9) Restart with the listing unanswered starts nothing', async () => {
    await startedOutside('s1');
    d.listFail = true;
    const from = d.seq.length;
    expect(await containerManager.restartBot('s1')).toEqual({ success: false, error: STOP_UNSEEN });
    expect(after(from)).not.toContain('up:s1');
  });
  it('S11 (C10) Off on a bot stored stopped whose app docker runs settles', async () => {
    await startedOutside('s1');
    const r = await runMaintenanceOrder('s1', 'off', '');
    expect(r.settled).toBe(true);
    expect(d.downs.filter(x => x === 's1')).toHaveLength(2);
    expect(d.running.s1).toEqual([]);
  });
  it('S12 (C12 to C16, C18 to C23) the in-op stop reads docker as Stop does', async () => {
    await startedOutside('s1');
    const r = await containerManager.withExternalBotOp('s1', 'push', () => containerManager.stopBotInOp('s1', 'push'));
    expect(r.success).toBe(true);
    expect(d.downs.filter(x => x === 's1')).toHaveLength(2);
  });
  it("S14 (B44, B45, B46) liveContainerNames reads the gate's listing", async () => {
    await companionBot('s1');
    expect((await containerManager.stopBot('s1')).success).toBe(true);
    d.running.s1 = ['fleet-postgres'];
    expect(await containerManager.liveContainerNames('s1')).toEqual([]);
    d.running.s1 = ['fleet-postgres', 'worker'];
    expect(await containerManager.liveContainerNames('s1')).toEqual(['s1-worker']);
    d.listFail = true;
    expect(await containerManager.liveContainerNames('s1')).toBeNull();
    d.listFail = false;
    expect(await containerManager.liveContainerNames('none')).toBeNull();
  });
  it('S15 (G2c) a compose down that fails leaves the listed containers to a by-name pass', async () => {
    fs.writeFileSync(path.join(d.repo, 'docker-compose.yml'), WORKER_COMPOSE);
    await jsonBot('s1');
    expect((await containerManager.stopBot('s1')).success).toBe(true);
    d.running.s1 = ['worker'];
    d.downFail = 'compose down failed';
    const from = d.seq.length;
    expect((await containerManager.stopBot('s1')).success).toBe(true);
    expect(after(from)).toContain('stop:s1-worker');
    expect(d.running.s1).toEqual([]);
    expect(stored('s1').status).toBe('stopped');
  });
  it("S15b (G13 after G2c) a container the by-name pass cannot stop fails the stop with the down's error", async () => {
    fs.writeFileSync(path.join(d.repo, 'docker-compose.yml'), WORKER_COMPOSE);
    await jsonBot('s1');
    expect((await containerManager.stopBot('s1')).success).toBe(true);
    d.running.s1 = ['worker'];
    d.downFail = 'compose down failed';
    d.sticky = 's1-worker';
    expect(await containerManager.stopBot('s1')).toEqual({ success: false, error: 'The stop failed: 1 container of the project still run (compose down failed)' });
  });

  it('S8d (G2b, CasaOS) with no compose file the listed containers are stopped by name and the database is left', async () => {
    await companionBot('s1');
    expect((await containerManager.stopBot('s1')).success).toBe(true);
    fs.rmSync(deployedCompose('s1'));
    d.running.s1 = ['fleet-postgres', 'worker'];
    d.mode = 'casaos';
    const from = d.seq.length;
    expect((await containerManager.stopBot('s1')).success).toBe(true);
    expect(after(from)).toContain('stop:s1-worker');
    expect(d.casaosDowns).toEqual([]);
    expect(after(from)).not.toContain('down:s1');
    expect(d.running.s1).toEqual(['fleet-postgres']);
    expect(stored('s1').status).toBe('stopped');
  });
  it('S15c (G2c, CasaOS) a CasaOS compose down that fails leaves the listed containers to a by-name pass', async () => {
    fs.writeFileSync(path.join(d.repo, 'docker-compose.yml'), WORKER_COMPOSE);
    await jsonBot('s1');
    expect((await containerManager.stopBot('s1')).success).toBe(true);
    d.running.s1 = ['worker'];
    d.mode = 'casaos';
    d.downFail = 'compose down failed';
    const from = d.seq.length;
    expect((await containerManager.stopBot('s1')).success).toBe(true);
    const seq = after(from);
    expect(seq).toContain('casaos-down:s1');
    expect(seq.indexOf('casaos-down:s1')).toBeLessThan(seq.indexOf('stop:s1-worker'));
    expect(d.running.s1).toEqual([]);
    expect(stored('s1').status).toBe('stopped');
  });

  /** b1 on its companion; s2 with app and worker, stopped, its worker started outside the manager with b1's URL. */
  async function workerSharer(): Promise<string> {
    const url = await companionBot('b1');
    fs.writeFileSync(path.join(d.repo, 'docker-compose.yml'), WORKER_COMPOSE);
    await jsonBot('s2');
    expect((await containerManager.stopBot('s2')).success).toBe(true);
    d.running.s2 = ['worker'];
    d.envOf['s2-worker-id'] = { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: url };
    return url;
  }
  it("S16 (B47) the search finds a bot through a worker's deployed URL", async () => {
    const url = await workerSharer();
    const found = await runningDatabaseSharers(stored('b1'), url);
    expect(found.bots.map(b => b.id)).toContain('s2');
    expect(found.unchecked).toEqual([]);
    d.running.s2 = [];
    expect((await runningDatabaseSharers(stored('b1'), url)).bots.map(b => b.id)).not.toContain('s2');
    d.running.s2 = ['worker'];
    d.listFail = true;
    const unanswered = await runningDatabaseSharers(stored('b1'), url);
    expect(unanswered.unchecked).toEqual(['s2']);
    expect(unanswered.bots.map(b => b.id)).not.toContain('s2');
  });
  it('S17 (R11) one search reads one async listing and no blocking one', async () => {
    const url = await workerSharer();
    await jsonBot('s3');
    expect((await containerManager.stopBot('s3')).success).toBe(true);
    d.running.s3 = ['worker'];
    const lists = d.lists;
    const syncLists = d.syncLists;
    await runningDatabaseSharers(stored('b1'), url);
    expect(d.lists).toBe(lists + 1);
    expect(d.syncLists).toBe(syncLists);
  });
  it('S18 (R12) a failed inspect leaves the bot unchecked unless another of its containers names the database', async () => {
    const url = await workerSharer();
    d.inspectFail = ['s2-worker-id'];
    expect((await runningDatabaseSharers(stored('b1'), url)).unchecked).toEqual(['s2']);
    d.running.s2 = ['app', 'worker'];
    d.envOf['s2-app-id'] = { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: url };
    const found = await runningDatabaseSharers(stored('b1'), url);
    expect(found.bots.map(b => b.id)).toContain('s2');
    expect(found.unchecked).toEqual([]);
  });
});
