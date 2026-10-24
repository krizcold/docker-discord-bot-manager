import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b04-3-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, saves: 0, allow: Infinity, refuseCompose: false, directComposeWrites: [] as string[], refuseStatus: '', containers: [] as any[] };
});

const fail = (stderr: string): Error => Object.assign(new Error(stderr), { stderr });
const answer = (args: string[]): string => {
  const line = args.join(' ');
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
// DATA_DIR refuses registry writes once h.allow saves have landed; a compose
// write can be refused too, and an in-place compose write is recorded.
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const enospc = (p: unknown): Error => Object.assign(new Error(`ENOSPC: no space left on device, write '${p}'`), { code: 'ENOSPC' });
  const mod = {
    ...real,
    renameSync: (a: any, b: any) => {
      if (String(b).endsWith('instances.json')) {
        if (h.saves >= h.allow) throw enospc(b);
        if (h.refuseStatus && JSON.parse(real.readFileSync(a, 'utf-8')).instances?.b1?.status === h.refuseStatus) throw enospc(b);
        if (h.refuseStatus === 'gone' && !JSON.parse(real.readFileSync(a, 'utf-8')).instances?.b1) throw enospc(b);
        h.saves++;
      }
      return real.renameSync(a, b);
    },
    writeFileSync: (p: any, d: any, o?: any) => {
      if (String(p).includes('docker-compose.yml')) {
        if (h.refuseCompose) throw enospc(p);
        if (String(p).endsWith('docker-compose.yml')) h.directComposeWrites.push(String(p));
      }
      return real.writeFileSync(p, d, o);
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
  composeUp: async () => {},
  verifyComposeProjectRunning: async () => ({ allRunning: true, problems: [] }),
  listBotContainers: async () => h.containers,
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
        sourceType: 'docker-image', imageRef: 'img:1', envVars: {},
        createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
        ...extra,
      },
    },
  }));
};

beforeEach(() => {
  h.saves = 0;
  h.allow = Infinity;
  h.refuseCompose = false;
  h.refuseStatus = '';
  h.containers = [];
  h.directComposeWrites.length = 0;
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(botDir, 'env'), { recursive: true });
  seed();
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('B04-3 a record write refused after the docker step', () => {
  it('a delete whose record clear is refused says what was removed and keeps a live Delete', async () => {
    h.refuseStatus = 'gone';
    await expect(containerManager.deleteBot('b1', false, false))
      .rejects.toThrow(/The containers, image, volumes, bot directory and data were removed, but its record could not be cleared.*ENOSPC/s);
    expect(fs.existsSync(botDir)).toBe(false);
    expect(stored()).toBeTruthy();
    expect(containerManager.getBot('b1')?.status).toBe('error');
  });

  it('a stop whose closing stamp is refused answers success with a warning and unlocks the card', async () => {
    seed({ status: 'running' });
    h.allow = 1; // the stopping stamp lands; the stopped stamp is refused
    const res = await containerManager.stopBot('b1');
    expect(res.success).toBe(true);
    expect((res as any).warning).toMatch(/containers were stopped, but the status could not be recorded.*ENOSPC/);
    expect(stored().status).toBe('stopping');
    expect(containerManager.getBot('b1')?.status).toBe('error');
  });

  it('a delete that keeps the data never says everything was removed', async () => {
    h.refuseStatus = 'gone';
    const err = await containerManager.deleteBot('b1', true, true).catch((e: Error) => e);
    expect(String(err)).not.toMatch(/Everything/);
    expect(String(err)).toMatch(/data and volumes were kept, env values kept[)].*but its record could not be cleared/s);
  });

  it('a start whose running stamp is refused answers success with a warning and serves error', async () => {
    fs.writeFileSync(composePath, 'services:\n  app:\n    image: img:1\n');
    h.refuseStatus = 'running';
    const res = await containerManager.startBot('b1');
    expect(res.success).toBe(true);
    expect((res as any).warning).toMatch(/running, but its status could not be recorded/);
    expect(containerManager.getBot('b1')?.status).toBe('error');
  });

  it('a build whose closing stamp is refused answers success with a warning', async () => {
    seed({ status: 'error' }); // the build lane record is written while the status is still error
    h.refuseStatus = 'stopped';
    const res = await containerManager.buildBot('b1');
    expect(res.success).toBe(true);
    expect((res as any).warning).toMatch(/build completed, but its outcome could not be recorded/);
  });

  it('the reconciler corrects a stuck transient record from docker once a write lands', async () => {
    seed({ status: 'starting' });
    h.containers = [{ id: 'c1', name: 'bot1', state: 'running', labels: { 'com.docker.compose.project': 'bot1' } }];
    await containerManager.syncContainerStates();
    expect(stored().status).toBe('running');
  });

  it('a stop whose first stamp is refused answers the refusal: nothing was stopped', async () => {
    seed({ status: 'running' });
    h.allow = 0;
    const res = await containerManager.stopBot('b1');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/ENOSPC/);
    expect(stored().status).toBe('running');
  });
});

describe('B04-3 boot passes survive a DATA_DIR that refuses writes', () => {
  it('the transient reset does not throw and the card is served as error', () => {
    seed({ status: 'starting' });
    h.allow = 0;
    expect(() => containerManager.resetTransientStatuses()).not.toThrow();
    expect(stored().status).toBe('starting');
    expect(containerManager.getBot('b1')?.status).toBe('error');
    expect(containerManager.getAllBots().find(b => b.id === 'b1')?.status).toBe('error');
  });

  it('the container sync does not throw on a refused correction', async () => {
    seed({ status: 'running' });
    h.allow = 0;
    await expect(containerManager.syncContainerStates()).resolves.toBeUndefined();
  });
});

describe('B04-3 deployed compose writes', () => {
  const replica = {
    containerName: 'bot1-fleet-postgres-replica', volume: 'bot1_replica', user: 'u', db: 'd', slot: 's',
    primaryHost: 'p', primaryPort: 5432, publicHost: 'h', hostPort: 15432, certHost: 'h',
  };

  it('a standby apply whose compose write is refused answers failure and leaves the compose as it was', async () => {
    seed({ fleetDbReplica: replica });
    fs.writeFileSync(composePath, 'services:\n  app:\n    image: img:1\n');
    h.refuseCompose = true;
    const res = await containerManager.applyFleetDbReplicaService('b1');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/nothing was started.*ENOSPC/);
    h.refuseCompose = false;
    expect(fs.readFileSync(composePath, 'utf-8')).toBe('services:\n  app:\n    image: img:1\n');
  });

  it('an env sync replaces the deployed compose whole, never writing it in place', () => {
    fs.writeFileSync(composePath, 'services:\n  app:\n    image: img:1\n    environment:\n      FOO: "0"\n');
    h.directComposeWrites.length = 0;
    containerManager.syncComposeEnvVars({ ...(containerManager.getBot('b1') as any), envVars: { FOO: '1' } }, composePath);
    const text = fs.readFileSync(composePath, 'utf-8');
    expect(text).toMatch(/FOO: "?1"?/);
    expect(text).not.toContain('FOO: "0"');
    expect(h.directComposeWrites).toEqual([]);
  });
});
