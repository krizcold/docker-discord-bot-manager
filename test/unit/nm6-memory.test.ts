import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm6-memory-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, down: false, appId: '', stats: '1.00%|300MiB / 7.5GiB', statsCalls: 0 };
});

const fail = (stderr: string): Error => Object.assign(new Error(stderr), { stderr });
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFileSync = (_f: string, args: string[]) => {
    if (h.down) throw fail('Cannot connect to the Docker daemon');
    if (args[0] === 'stats') { h.statsCalls++; return h.stats; }
    return '';
  };
  const exec = (cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (h.down) { done(new Error('Cannot connect to the Docker daemon')); return; }
    done(null, { stdout: cmd.startsWith('docker ps -q') && h.appId ? `${h.appId}\n` : '', stderr: '' });
  };
  const mod = { ...real, exec, execFileSync };
  return { ...mod, default: mod };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import { getContainerStats } from '../../src/docker/dockerClient';
import { MEMORY_FILES, memoryRoom, readHostMemory } from '../../src/instance/memoryRoom';
import { createBotRoutes } from '../../src/webui/routes/bots';

const meminfo = path.join(h.dir, 'meminfo');
const cgroupMax = path.join(h.dir, 'memory.max');
const cgroupV1 = path.join(h.dir, 'memory.limit_in_bytes');
const mountinfo = path.join(h.dir, 'mountinfo');
const PLAIN_MOUNTS = '22 1 0:21 / /proc rw,nosuid - proc proc rw\n';
const LXCFS_MOUNTS = `${PLAIN_MOUNTS}30 22 0:40 /proc/meminfo /proc/meminfo rw,nosuid - fuse.lxcfs lxcfs rw\n`;
const writeMeminfo = (lines: string[]) => fs.writeFileSync(meminfo, `${lines.join('\n')}\n`);
const STANDARD = ['MemTotal:       16384000 kB', 'MemFree:         1024000 kB', 'MemAvailable:    1024000 kB'];

const router = createBotRoutes({ clients: new Set() } as any);
const call = async (routePath: string, id = 'a'): Promise<{ status: number; body: any }> => {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath && l.route.methods.get);
  const res: any = { statusCode: 200 };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  await layer.route.stack[layer.route.stack.length - 1].handle({ params: { id }, query: {}, body: {} }, res);
  return { status: res.statusCode, body: res.body };
};

beforeEach(() => {
  h.down = false;
  h.appId = 'c-app';
  h.stats = '1.00%|300MiB / 7.5GiB';
  h.statsCalls = 0;
  writeMeminfo(STANDARD);
  fs.rmSync(cgroupMax, { force: true });
  fs.rmSync(cgroupV1, { force: true });
  fs.writeFileSync(mountinfo, PLAIN_MOUNTS);
  MEMORY_FILES.meminfo = meminfo;
  MEMORY_FILES.cgroupMax = cgroupMax;
  MEMORY_FILES.cgroupV1 = cgroupV1;
  MEMORY_FILES.mountinfo = mountinfo;
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances: {
    a: { id: 'a', sanitizedName: 'a', displayName: 'A', status: 'running', sourceUrl: 'https://example.invalid/x', createdAt: 'x', updatedAt: 'x' },
  } }));
});
afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));

describe('ME1: the /proc/meminfo reader', () => {
  it('MemAvailable present: its value in MB', () => {
    expect(readHostMemory()).toEqual({ ok: true, availableMb: 1000 });
  });
  it('MemAvailable absent or unparseable: an error, never a number', () => {
    writeMeminfo(['MemTotal:       16384000 kB', 'MemFree:         1024000 kB']);
    expect(readHostMemory()).toEqual({ ok: false, error: '/proc/meminfo has no MemAvailable line' });
    writeMeminfo(['MemTotal:       16384000 kB', 'MemAvailable:    lots kB']);
    expect(readHostMemory()).toEqual({ ok: false, error: '/proc/meminfo has no MemAvailable line' });
  });
  it('the file missing: an error naming the file', () => {
    fs.rmSync(meminfo);
    const got = readHostMemory();
    expect(got.ok).toBe(false);
    expect((got as { error: string }).error.startsWith('/proc/meminfo could not be read')).toBe(true);
  });
  it('lxcfs: MemTotal equal to the manager container\'s own limit gives no reading', () => {
    fs.writeFileSync(cgroupMax, `${16384000 * 1024}\n`);
    expect(readHostMemory()).toEqual({ ok: false, error: "this container sees its own memory limit, not the machine's" });
  });
  it('a cgroup limit of max, or a different one, keeps the reading', () => {
    fs.writeFileSync(cgroupMax, 'max\n');
    expect(readHostMemory()).toEqual({ ok: true, availableMb: 1000 });
    fs.writeFileSync(cgroupMax, `${1024 * 1048576}\n`);
    expect(readHostMemory()).toEqual({ ok: true, availableMb: 1000 });
  });
});

describe('ME2: room at the 256 MB reserve', () => {
  it('free minus 256 at or above the use is room; one MB less is not', () => {
    expect(memoryRoom(300, 556)).toBe(true);
    expect(memoryRoom(300, 555)).toBe(false);
  });
});

describe('ME3: getContainerStats reads every docker unit', () => {
  it('KiB, MiB, GiB and B convert to MB', async () => {
    h.stats = '0.50%|512KiB / 2GiB';
    expect(await getContainerStats('c-app')).toEqual({ cpuPercent: 0.5, memoryUsageMB: 0.5, memoryLimitMB: 2048 });
    h.stats = '0.50%|100MiB / 1.5GiB';
    expect(await getContainerStats('c-app')).toEqual({ cpuPercent: 0.5, memoryUsageMB: 100, memoryLimitMB: 1536 });
    h.stats = '0.00%|0B / 0B';
    expect(await getContainerStats('c-app')).toEqual({ cpuPercent: 0, memoryUsageMB: 0, memoryLimitMB: 0 });
    h.stats = '0.00%|1.5GiB / 1TiB';
    expect(await getContainerStats('c-app')).toEqual({ cpuPercent: 0, memoryUsageMB: 1536, memoryLimitMB: 1048576 });
  });
});

describe('ME4: GET /:id/memory', () => {
  it('a running bot with room', async () => {
    const got = await call('/:id/memory');
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ success: true, memory: { running: true, room: true, useMb: 300, freeMb: 1000 } });
    expect(got.body.memory.error).toBeUndefined();
    expect(typeof got.body.memory.at).toBe('string');
  });
  it('the app container\'s limit is smaller than the machine\'s free memory: the limit decides', async () => {
    h.stats = '1.00%|300MiB / 512MiB';
    expect((await call('/:id/memory')).body.memory).toMatchObject({ running: true, room: false, useMb: 300, freeMb: 212 });
  });
  it('a stopped bot: no reading', async () => {
    h.appId = '';
    expect((await call('/:id/memory')).body).toEqual({ success: true, memory: { running: false } });
    expect(h.statsCalls).toBe(0);
  });
  it('docker not answering: can\'t confirm', async () => {
    h.down = true;
    const m = (await call('/:id/memory')).body.memory;
    expect(m).toMatchObject({ running: null, room: null, useMb: null, freeMb: null, error: 'docker did not answer' });
  });
  it('the machine\'s memory unread: can\'t confirm, with the use kept', async () => {
    fs.rmSync(meminfo);
    const m = (await call('/:id/memory')).body.memory;
    expect(m).toMatchObject({ running: true, room: null, useMb: 300, freeMb: null });
    expect(m.error.startsWith('/proc/meminfo could not be read')).toBe(true);
  });
  it('an unknown bot is 404', async () => {
    expect(await call('/:id/memory', 'zz')).toEqual({ status: 404, body: { success: false, error: 'Bot not found' } });
  });
});

describe('ME5 (fixer 1): lxcfs and cgroup v1, and a zero memory use', () => {
  const OWN = { ok: false, error: "this container sees its own memory limit, not the machine's" };
  it('a mount at /proc/meminfo in mountinfo (lxcfs): no reading', () => {
    fs.writeFileSync(mountinfo, LXCFS_MOUNTS);
    expect(readHostMemory()).toEqual(OWN);
  });
  it('cgroup v1: MemTotal equal to memory.limit_in_bytes gives no reading', () => {
    fs.writeFileSync(cgroupV1, `${16384000 * 1024}\n`);
    expect(readHostMemory()).toEqual(OWN);
  });
  it('mountinfo unreadable: no reading, with its reason', () => {
    fs.rmSync(mountinfo);
    const got = readHostMemory();
    expect(got.ok).toBe(false);
    expect((got as { error: string }).error.startsWith('/proc/self/mountinfo could not be read')).toBe(true);
  });
  it('docker reports 0 use, or a MemUsage that does not parse: can\'t confirm, never 0 MB', async () => {
    for (const stats of ['0.00%|0B / 0B', '0.00%|--']) {
      h.stats = stats;
      const m = (await call('/:id/memory')).body.memory;
      expect(m).toMatchObject({ room: null, useMb: null, freeMb: null, error: "docker reported no memory use for the bot's container" });
    }
  });
});
