import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// nm10-real.test.ts's harness: the real containerManager, maintenance, fleetBackup and bots router, with a fake at the
// docker boundary. The listing fakes derive every container from d.running: one per service, named as the compose's
// container_name (`<project>-<service>`), in State d.states[project][service] or 'running'.
const d = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm16-l5-stop-'));
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

const companionCompose = () => fs.rmSync(deployedCompose('s1'));
const nameOf = (id: string) => `[ContainerManager] Failed to stop container ${id}:`;

describe('NM16 L5: the gate, the by-name pass and the reconcile read', () => {
  it('P1 a paused app opens the gate and is stopped', async () => {
    await jsonBot('s1');
    expect((await containerManager.stopBot('s1')).success).toBe(true);
    d.running.s1 = ['app'];
    d.states.s1 = { app: 'paused' };
    expect((await containerManager.stopBot('s1')).success).toBe(true);
    expect(d.downs.filter(x => x === 's1')).toHaveLength(2);
  });
  it('P2 the log names every container docker runs, comma separated', async () => {
    fs.writeFileSync(path.join(d.repo, 'docker-compose.yml'), WORKER_COMPOSE);
    await jsonBot('s1');
    expect((await containerManager.stopBot('s1')).success).toBe(true);
    d.running.s1 = ['app', 'worker'];
    const log = vi.spyOn(console, 'log');
    expect((await containerManager.stopBot('s1')).success).toBe(true);
    expect(log.mock.calls.map(c => c[0])).toContain('[Stop] S1: the status reads stopped, but docker runs s1-app, s1-worker; stopping the bot');
  });
  it('P3 with no compose file a container the by-name pass leaves running is stopped once', async () => {
    await companionBot('s1');
    expect((await containerManager.stopBot('s1')).success).toBe(true);
    companionCompose();
    d.running.s1 = ['fleet-postgres', 'worker'];
    d.sticky = 's1-worker';
    const from = d.seq.length;
    expect((await containerManager.stopBot('s1')).success).toBe(false);
    expect(after(from).filter(e => e === 'stop:s1-worker')).toHaveLength(1);
  });
  it("P4 a by-name stop that throws fails the stop with docker's error and logs the container", async () => {
    await companionBot('s1');
    expect((await containerManager.stopBot('s1')).success).toBe(true);
    companionCompose();
    d.running.s1 = ['fleet-postgres', 'worker'];
    d.onStop = () => { throw new Error('daemon gone'); };
    const warn = vi.spyOn(console, 'warn');
    expect(await containerManager.stopBot('s1')).toEqual({ success: false, error: 'The stop failed: 1 container of the project still run (daemon gone)' });
    expect(warn.mock.calls.map(c => c[0])).toContain(nameOf('s1-worker'));
  });
  it('P5 (CasaOS) with no compose file the listed containers are stopped by name, no compose down', async () => {
    await companionBot('s1');
    expect((await containerManager.stopBot('s1')).success).toBe(true);
    companionCompose();
    d.running.s1 = ['fleet-postgres', 'worker'];
    d.mode = 'casaos';
    const from = d.seq.length;
    expect((await containerManager.stopBot('s1')).success).toBe(true);
    expect(after(from)).toEqual(['stop:s1-worker']);
    expect(d.casaosDowns).toEqual([]);
  });
  it('P6 (CasaOS) with the compose file the compose down runs, and a container it leaves is stopped by name', async () => {
    fs.writeFileSync(path.join(d.repo, 'docker-compose.yml'), WORKER_COMPOSE);
    await jsonBot('s1');
    expect((await containerManager.stopBot('s1')).success).toBe(true);
    d.running.s1 = ['worker'];
    d.mode = 'casaos';
    d.downFail = 'compose down failed';
    const from = d.seq.length;
    expect((await containerManager.stopBot('s1')).success).toBe(true);
    expect(after(from)).toEqual(['casaos-down:s1', 'stop:s1-worker']);
  });
  it('P7 (docker) a stop whose compose down leaves nothing reads the listing twice', async () => {
    await jsonBot('s1');
    expect((await containerManager.stopBot('s1')).success).toBe(true);
    d.running.s1 = ['app'];
    const lists = d.lists;
    expect((await containerManager.stopBot('s1')).success).toBe(true);
    expect(d.lists - lists).toBe(2);
  });
  it('P8 the bot list carries null docker fields before a check and the check after one', async () => {
    await jsonBot('s1');
    const before = (await call('get', '/', {})).body.bots.find((b: any) => b.id === 's1');
    expect(before).toMatchObject({ statusCheckedAt: null, servicesUp: null, containersLive: null });
    await containerManager.syncContainerStates();
    const read = containerManager.getReconcileRead('s1');
    expect(read?.containersLive).toEqual(['app']);
    const later = (await call('get', '/', {})).body.bots.find((b: any) => b.id === 's1');
    expect(later).toMatchObject(read!);
  });
});

describe('NM16 L5: the search with no Database URL', () => {
  it('M1 a URL emptied during the save leaves no bot unchecked', async () => {
    await companionBot('b1');
    m.saveAnswers = [() => { envManager.deleteEnvVar('b1', 'DATA_BACKEND_URL'); return { ok: true, status: 200, body: { success: true, saved: true } } as any; }];
    m.bot.script = [{ state: 'done', stage: 'switching' }];
    await press('file', 'b1');
    expect(stored('b1').migrateLast).toMatchObject({ to: 'file', outcome: 'done' });
  });
});
