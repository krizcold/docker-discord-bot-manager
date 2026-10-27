import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b07-1-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    down: false,
    // docker ps -a listing rows: id|name|state|status|project|botId|service
    listing: [] as string[],
    appId: '' as string,
    restarts: 0,
    syncs: 0,
    stable: false,
    listDown: false,
    gone: [] as string[],
    projectIds: null as string[] | null,
  };
});

const fail = (stderr: string): Error => Object.assign(new Error(stderr), { stderr });
const answer = (args: string[]): string => {
  if (h.down) throw fail('Cannot connect to the Docker daemon');
  if (args[0] === 'ps' && args.includes('label=managed-by=discord-bot-manager')) {
    if (h.listDown) throw fail('Cannot connect to the Docker daemon');
    const rows = h.listing.map((r) => r.split('|'));
    const fmt = args[args.indexOf('--format') + 1];
    return rows.map((r) => (fmt.split('|').length >= 7 ? r.join('|') : r.slice(0, 6).join('|'))).join('\n');
  }
  if (args[0] === 'ps') return h.listing.map((r) => r.split('|')).map((r) => `${r[1]}|${r[2]}|${r[3]}`).join('\n');
  if (args[0] === 'inspect') {
    if (!h.stable) h.restarts++;
    return args.slice(3).map((n) => `/${n}|${h.restarts}|2026-10-22T00:00:0${h.restarts % 10}Z`).join('\n');
  }
  if ((args[0] === 'stats' || args[0] === 'logs') && h.gone.includes(args[args.length - 1])) throw fail(`Error response from daemon: No such container: ${args[args.length - 1]}`);
  if (args[0] === 'stats') return '1.50%|50MiB / 512MiB';
  if (args[0] === 'logs') return '2026-10-22T00:00:00.000Z hello';
  return '';
};

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFileSync = (_f: string, args: string[]) => answer(args);
  const execFile = (_f: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    try { done(null, { stdout: answer(args), stderr: '' }); } catch (e) { done(e); }
  };
  const execSync = () => '';
  const exec = (cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (h.down) { done(new Error('Cannot connect to the Docker daemon')); return; }
    if (cmd.startsWith('docker ps -q') && h.projectIds && !cmd.includes('compose.service')) done(null, { stdout: h.projectIds.join(String.fromCharCode(10)), stderr: '' });
    else if (cmd.startsWith('docker ps -q')) done(null, { stdout: h.appId ? `${h.appId}\n` : '', stderr: '' });
    else done(null, { stdout: '', stderr: '' });
  };
  // compose up and any other spawned docker call never reach a real daemon.
  const spawn = (_c: string, _a: string[], opts: any) => real.spawn(process.execPath, ['-e', ''], opts);
  const mod = { ...real, exec, execFile, execFileSync, execSync, spawn };
  return { ...mod, default: mod };
});
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  hasAppHooks: () => true,
}));
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return { ...real, syncContainerStates: async () => { h.syncs++; return real.syncContainerStates(); } };
});

import * as fs from 'fs';
import * as path from 'path';
import * as dockerClient from '../../src/docker/dockerClient';
import * as containerManager from '../../src/docker/containerManager';
import * as reconciler from '../../src/docker/stateReconciler';

const registryPath = path.join(h.dir, 'instances.json');
const statusOf = (id: string): string => JSON.parse(fs.readFileSync(registryPath, 'utf-8')).instances[id].status;

function writeRecord(fields: Record<string, unknown>): void {
  fs.writeFileSync(registryPath, JSON.stringify({
    instances: {
      b1: {
        id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'stopped',
        sourceType: 'docker-image', envVars: {}, containerIds: ['c-app', 'c-redis'],
        createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
        ...fields,
      },
    },
  }));
}

beforeEach(() => {
  h.down = false;
  h.listing = [];
  h.appId = '';
  h.restarts = 0;
  h.stable = false;
  h.listDown = false;
  h.gone = [];
  h.projectIds = null;
  const botDir = path.join(h.dir, 'bots', 'b1');
  fs.mkdirSync(botDir, { recursive: true });
  fs.writeFileSync(path.join(botDir, 'docker-compose.yml'), [
    'services:',
    '  app:',
    '    image: example/app:1',
    '  redis:',
    '    image: redis:7',
    '',
  ].join('\n'));
  writeRecord({});
});

afterEach(() => {
  reconciler.stopStateReconciler();
  vi.useRealTimers();
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

const app = (state: string) => `c-app|bot1-app-1|${state}|x|bot1|b1|app`;
const redis = (state: string) => `c-redis|bot1-redis-1|${state}|x|bot1|b1|redis`;

describe('B07-1 docker readers: no answer is not empty or zero', () => {
  it('listBotContainers answers null when docker does not answer', async () => {
    h.down = true;
    expect(await dockerClient.listBotContainers()).toBeNull();
  });

  it('getContainerStats answers the docker error, not zeros, when docker does not answer', async () => {
    h.down = true;
    expect(await dockerClient.getContainerStats('c-app')).toEqual({ error: expect.stringMatching(/Cannot connect/) });
  });

  it('getContainerLogs answers the docker error, not an empty log, when docker does not answer', async () => {
    h.down = true;
    expect(await dockerClient.getContainerLogs('c-app')).toEqual({ error: expect.stringMatching(/Cannot connect/) });
  });

  it('a container docker says is gone reads as gone, not unanswered', async () => {
    h.gone = ['c-old'];
    expect(await dockerClient.getContainerStats('c-old')).toEqual({ gone: true });
    expect(await dockerClient.getContainerLogs('c-old')).toEqual({ gone: true });
  });
});

describe('B07-1 syncContainerStates keys on the app service and skips an unanswered listing', () => {
  it('an unanswered listing leaves a running record running', async () => {
    writeRecord({ status: 'running' });
    h.down = true;
    await containerManager.syncContainerStates();
    expect(statusOf('b1')).toBe('running');
  });

  it('an error record with the app restarting and redis running is not stamped running', async () => {
    writeRecord({ status: 'error' });
    h.listing = [app('restarting'), redis('running')];
    await containerManager.syncContainerStates();
    expect(statusOf('b1')).toBe('error');
  });

  it('a running record whose app exited while redis runs is no longer running', async () => {
    writeRecord({ status: 'running' });
    h.listing = [app('exited'), redis('running')];
    await containerManager.syncContainerStates();
    expect(statusOf('b1')).not.toBe('running');
  });

  it('a stopped record whose app runs is stamped running', async () => {
    h.listing = [app('running'), redis('running')];
    await containerManager.syncContainerStates();
    expect(statusOf('b1')).toBe('running');
  });
});

describe('B07-1 stats and logs ask docker', () => {
  it('a building record with the app running reads stats', async () => {
    writeRecord({ status: 'building' });
    h.appId = 'c-app';
    const res = await containerManager.getBotStats('b1');
    expect(res.success).toBe(true);
    expect(res.stats?.cpuPercent).toBeGreaterThan(0);
  });

  it('stats docker cannot read are a failure, not zeros', async () => {
    writeRecord({ status: 'running' });
    h.appId = 'c-app';
    const spy = vi.spyOn(dockerClient, 'getContainerStats').mockResolvedValue({ error: 'daemon busy' } as any);
    const res = await containerManager.getBotStats('b1');
    spy.mockRestore();
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/could not read stats from docker: daemon busy/);
  });

  it('stats during an in-place apply read the containers docker runs, not a removed recorded id', async () => {
    writeRecord({ status: 'starting', containerIds: ['c-old', 'c-redis'] });
    h.appId = 'c-new';
    h.projectIds = ['c-new', 'c-redis'];
    h.gone = ['c-old'];
    const res = await containerManager.getBotStats('b1');
    expect(res.success).toBe(true);
    expect(res.stats?.cpuPercent).toBeCloseTo(3);
  });

  it('a stale recorded id does not fail the logs of the live containers', async () => {
    writeRecord({ status: 'running', containerIds: ['c-old', 'c-app'] });
    h.gone = ['c-old'];
    const res = await containerManager.getBotLogs('b1');
    expect(res.success).toBe(true);
    expect(res.logs?.join(String.fromCharCode(10))).toMatch(/hello/);
  });

  it('logs read the containers docker runs when every recorded id is gone', async () => {
    writeRecord({ status: 'running', containerIds: ['c-old'] });
    h.gone = ['c-old'];
    h.projectIds = ['c-app'];
    const res = await containerManager.getBotLogs('b1');
    expect(res.success).toBe(true);
    expect(res.logs?.join(String.fromCharCode(10))).toMatch(/hello/);
  });

  it('logs whose recorded ids are all gone and nothing runs are a failure, not an empty log', async () => {
    writeRecord({ status: 'running', containerIds: ['c-old'] });
    h.gone = ['c-old'];
    const res = await containerManager.getBotLogs('b1');
    expect(res.success).toBe(false);
  });

  it('logs docker cannot read are a failure, not an empty log', async () => {
    writeRecord({ status: 'running' });
    h.down = true;
    const res = await containerManager.getBotLogs('b1');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/could not read logs from docker: (docker did not answer|.*Cannot connect)/);
  });
});

describe('B07-1 a start reports running only after a settle', () => {
  it('a container restarting between looks is not reported running', async () => {
    h.listing = [app('running')];
    const res = await (dockerClient.verifyComposeProjectRunning as any)('bot1', 800, 400);
    expect(res.allRunning).toBe(false);
  });

  it('a project that holds its start across the settle window is reported running', async () => {
    h.listing = [app('running'), redis('running')];
    h.stable = true;
    const t0 = Date.now();
    const res = await (dockerClient.verifyComposeProjectRunning as any)('bot1', 2000, 400);
    expect(res.allRunning).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
  });

  it('a start whose container listing went unanswered keeps the ids and says the count is unknown', async () => {
    h.listing = [app('running'), redis('running')];
    h.stable = true;
    writeRecord({ imageRef: 'example/app:1' });
    h.listDown = true;
    const spy = vi.spyOn(console, 'log');
    const res = await containerManager.startBot('b1');
    const printed = spy.mock.calls.map((c) => String(c[0])).join(String.fromCharCode(10));
    spy.mockRestore();
    expect(res.success).toBe(true);
    expect(printed).toMatch(/container count unknown: docker did not answer/);
    expect(printed).not.toMatch(/[(][0-9]+ containers[)]/);
    const rec = JSON.parse(fs.readFileSync(registryPath, 'utf-8')).instances.b1;
    expect(rec.status).toBe('running');
    expect(rec.containerIds).toEqual(['c-app', 'c-redis']);
  }, 30_000);

  it('an unanswered probe on a running record answers could not confirm, not already running', async () => {
    writeRecord({ status: 'running' });
    h.down = true;
    const res = await containerManager.startBot('b1');
    expect(res.error).toMatch(/could not confirm/);
  });
});

describe('B07-1 the reconciler runs with no web UI client connected', () => {
  it('ticks while no client is connected', async () => {
    vi.useFakeTimers();
    h.syncs = 0;
    reconciler.startStateReconciler(() => 0);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(h.syncs).toBeGreaterThan(0);
  });
});

describe('B07-1 health readers and the status stamp', () => {
  it('a building record whose app docker says runs reads as running for the health readers', async () => {
    writeRecord({ status: 'building' });
    h.appId = 'c-app';
    const rec = containerManager.getBot('b1')!;
    expect((await (containerManager as any).withServingStatus(rec)).instance.status).toBe('running');
    h.appId = '';
    expect((await (containerManager as any).withServingStatus(rec)).instance.status).toBe('error');
    h.down = true;
    expect((await (containerManager as any).withServingStatus(rec)).unanswered).toBe(true);
  });

  it('the reconciler broadcasts each read so an open card follows it', async () => {
    writeRecord({ status: 'running' });
    h.listing = [app('running'), redis('running')];
    const sent: any[] = [];
    containerManager.setContainerBroadcast((type, data) => { if (type === 'bots:checked') sent.push(data); });
    await containerManager.syncContainerStates();
    containerManager.setContainerBroadcast(() => {});
    expect(sent.length).toBe(1);
    expect(sent[0].b1.servicesUp).toEqual(['app', 'redis']);
    expect(typeof sent[0].b1.statusCheckedAt).toBe('string');
  });

  it('the reconciler stamps when it read the record and which services are up, and an unanswered read keeps the old stamp', async () => {
    writeRecord({ status: 'running' });
    h.listing = [app('running'), redis('running')];
    await containerManager.syncContainerStates();
    const read = (containerManager as any).getReconcileRead('b1');
    expect(read.servicesUp).toEqual(['app', 'redis']);
    expect(Date.now() - Date.parse(read.statusCheckedAt)).toBeLessThan(5000);
    h.down = true;
    await containerManager.syncContainerStates();
    expect((containerManager as any).getReconcileRead('b1').statusCheckedAt).toBe(read.statusCheckedAt);
  });
});
