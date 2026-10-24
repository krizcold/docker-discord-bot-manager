import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b22-4-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, snapshots: [] as any[], composeUps: 0, present: new Set<string>() };
});

const fail = (stderr: string): Error => Object.assign(new Error(stderr), { stderr });
const answer = (args: string[]): string => {
  const line = args.join(' ');
  if (line.startsWith('image inspect') && h.present.has(args[args.length - 1])) return '[{}]';
  if (line.startsWith('image inspect')) throw fail('Error: No such image: x');
  if (line.startsWith('volume inspect')) throw fail('Error: No such volume: x');
  if (line.startsWith('volume rm')) throw fail('Error: No such volume: x');
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
    if (cmd.startsWith('docker inspect')) done(new Error('Error: No such object'));
    else if (cmd.startsWith('docker rm')) done(new Error('Error: No such container'));
    else done(null, { stdout: '', stderr: '' });
  };
  const mod = { ...real, exec, execFile, execFileSync, execSync };
  return { ...mod, default: mod };
});
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const mod = {
    ...real,
    renameSync: (a: any, b: any) => {
      if (String(b).endsWith('instances.json')) h.snapshots.push(JSON.parse(real.readFileSync(a, 'utf-8')).instances?.b1);
      return real.renameSync(a, b);
    },
  };
  return { ...mod, default: mod };
});
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/docker/dockerClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
  pullImage: async () => {},
  composeUp: async () => { h.composeUps++; },
  verifyComposeProjectRunning: async () => ({ allRunning: true, problems: [] }),
  listBotContainers: async () => [],
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';

const botDir = path.join(h.dir, 'bots', 'b1');
const composePath = path.join(botDir, 'docker-compose.yml');
const stored = (): any => JSON.parse(fs.readFileSync(path.join(h.dir, 'instances.json'), 'utf-8')).instances.b1;

const seed = (extra: Record<string, unknown> = {}): void => {
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({
    instances: {
      b1: {
        id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'stopped',
        sourceType: 'docker-image', imageRef: 'img:1', envVars: {}, lastBuiltCommit: null,
        createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
        ...extra,
      },
    },
  }));
};
const cutDelete = { op: 'delete', wasRunning: true, keepData: true, startedAt: '2026-10-24T00:00:00.000Z' };

beforeEach(() => {
  h.snapshots.length = 0;
  h.composeUps = 0;
  h.present.clear();
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(botDir, 'env'), { recursive: true });
  seed();
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('B22-4 a delete is recorded before its first step', () => {
  it('the record holds the delete and its keepData before the bot is taken down', async () => {
    h.snapshots.length = 0;
    await containerManager.deleteBot('b1', true, true);
    const stopping = h.snapshots.findIndex(s => s?.status === 'stopping');
    expect(stopping).toBeGreaterThanOrEqual(0);
    expect(h.snapshots[stopping].lane).toMatchObject({ op: 'delete', keepData: true });
  });
});

describe('B22-4 a cut-short delete gates Start, Update and Build', () => {
  it('boot names the delete as interrupted and keeps it', () => {
    seed({ status: 'stopping', lane: cutDelete });
    containerManager.resetTransientStatuses();
    expect(stored().lane).toMatchObject({ op: 'delete', keepData: true, interrupted: true });
  });
  it('Start is refused and nothing is deployed', async () => {
    seed({ status: 'error', lane: cutDelete });
    fs.writeFileSync(composePath, 'services:\n  app:\n    image: img:1\n');
    const res = await containerManager.startBot('b1');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Delete of this instance \(keeping its data\) did not finish.*Start is refused/);
    expect(h.composeUps).toBe(0);
  });
  it('Update is refused', async () => {
    seed({ status: 'error', lane: cutDelete });
    const res = await containerManager.pullAndRebuild('b1');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Update is refused/);
    expect(fs.existsSync(composePath)).toBe(false);
  });
  it('Build is refused', async () => {
    seed({ status: 'error', lane: cutDelete });
    const res = await containerManager.buildBot('b1');
    expect(res.success).toBe(false);
    expect(fs.existsSync(composePath)).toBe(false);
  });
});

describe('B22-4 an update or restart cut short keeps its restart obligation', () => {
  it('a restart is recorded with wasRunning while the bot is down, and cleared once it runs', async () => {
    seed({ status: 'running' });
    fs.writeFileSync(composePath, 'services:\n  app:\n    image: img:1\n');
    const res = await containerManager.restartBot('b1');
    const down = h.snapshots.filter(s => s?.status === 'stopped');
    expect(down.length).toBeGreaterThan(0);
    for (const s of down) expect(s.lane).toMatchObject({ op: 'restart', wasRunning: true });
    expect(res.success).toBe(true);
    expect(stored().lane).toBeUndefined();
  });
  it('an update records wasRunning before it stops the bot', async () => {
    seed({ status: 'running' });
    fs.writeFileSync(composePath, 'services:\n  app:\n    image: img:1\n');
    await containerManager.pullAndRebuild('b1');
    const stopping = h.snapshots.find(s => s?.status === 'stopping');
    expect(stopping?.lane).toMatchObject({ op: 'update', wasRunning: true });
  });
  it('boot marks the update interrupted and the error card keeps it', () => {
    seed({ status: 'building', lane: { op: 'update', wasRunning: true, startedAt: '2026-10-24T00:00:00.000Z' } });
    containerManager.resetTransientStatuses();
    expect(stored().status).toBe('error');
    expect(stored().lane).toMatchObject({ op: 'update', wasRunning: true, interrupted: true });
  });
  it('the next Update takes wasRunning from the record and starts the bot again', async () => {
    seed({ status: 'error', lane: { op: 'update', wasRunning: true, startedAt: '2026-10-24T00:00:00.000Z', interrupted: true } });
    const res = await containerManager.pullAndRebuild('b1');
    expect(res.success).toBe(true);
    expect(h.composeUps).toBe(1);
    expect(stored().lane).toBeUndefined();
  });
  it('a Build after an interrupted restart keeps the restart record', async () => {
    seed({ status: 'error', lane: { op: 'restart', wasRunning: true, startedAt: '2026-10-24T00:00:00.000Z', interrupted: true } });
    const res = await containerManager.buildBot('b1');
    expect(res.success).toBe(true);
    expect(stored().lane).toMatchObject({ op: 'restart', wasRunning: true });
  });
});

describe('B22-4 Start builds when its image is missing', () => {
  it('a git instance with a compose and no image builds first instead of deploying a missing image', async () => {
    seed({ sourceType: 'git', sourceId: null, imageRef: undefined });
    fs.writeFileSync(composePath, 'services:\n  app:\n    image: bot1-b1:latest\n');
    const res = await containerManager.startBot('b1');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Build failed/);
    expect(h.composeUps).toBe(0);
  });
  it('a compose of per-service tags and pulled images that are present deploys without a build', async () => {
    seed({ sourceType: 'git', sourceId: null, imageRef: undefined });
    h.present.add('bot1-b1-app:latest');
    fs.writeFileSync(composePath, 'services:\n  app:\n    image: bot1-b1-app:latest\n  cache:\n    image: redis:7\n');
    const res = await containerManager.startBot('b1');
    expect(res.error).toBeUndefined();
    expect(res.success).toBe(true);
    expect(h.composeUps).toBe(1);
  });
});

describe('B22-4 a cleared lane reaches the browser', () => {
  it('the response copy carries lane null once the record is cleared', () => {
    const out = containerManager.withoutRecordSecrets({ id: 'b1' } as any) as any;
    expect('lane' in out).toBe(true);
    expect(out.lane).toBeNull();
  });
  it('a Build records wasRunning false, since it never stops the bot', async () => {
    seed({ status: 'running' });
    await containerManager.buildBot('b1');
    const rec = h.snapshots.find(s => s?.lane?.op === 'build');
    expect(rec?.lane.wasRunning).toBe(false);
  });
});
