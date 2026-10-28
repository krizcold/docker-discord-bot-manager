import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b20-4-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    volumes: new Set<string>(),
    calls: [] as string[],
    // A shell command whose text matches answers with this stderr as a failure.
    execFails: [] as Array<[RegExp, string]>,
    // First matching rule answers an execFile docker call: [predicate, ok, stdout, stderr].
    rules: [] as Array<[(args: string[]) => boolean, boolean, string, string]>,
    onExec: null as null | ((cmd: string) => void),
    onVolumeRm: null as null | (() => void),
    // The root execs the shared fence fake answers, failed as a down container fails them.
    rootFails: false,
    runs: [] as string[][],
  };
});

const fail = (stderr: string): Error => Object.assign(new Error(stderr), { stderr });
const volumeAnswer = (args: string[]): string => {
  if (args.join(' ').startsWith('image inspect')) throw fail('Error: No such image: x');
  if (args[0] === 'volume' && (args[1] === 'inspect' || args[1] === 'rm')) {
    const name = args[args.length - 1];
    if (!h.volumes.has(name)) throw fail(`Error: No such volume: ${name}`);
    if (args[1] === 'rm') { h.volumes.delete(name); h.onVolumeRm?.(); }
    return '';
  }
  return '';
};

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFileSync = (_f: string, args: string[]) => { h.calls.push(args.join(' ')); return volumeAnswer(args); };
  const execFile = (_f: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    h.calls.push(args.join(' '));
    const rule = h.rules.find(([match]) => match(args));
    if (rule) {
      const [, ok, stdout, stderr] = rule;
      setImmediate(() => done(ok ? null : Object.assign(new Error('docker failed'), { code: 1 }), stdout, stderr));
      return { stdin: null };
    }
    try { const out = volumeAnswer(args); setImmediate(() => done(null, out, '')); } catch (e: any) { setImmediate(() => done(e, '', e.stderr)); }
    return { stdin: null };
  };
  const execSync = () => '';
  const exec = (cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    h.calls.push(cmd);
    h.onExec?.(cmd);
    const failure = h.execFails.find(([re]) => re.test(cmd));
    if (failure) done(fail(failure[1]));
    else done(null, { stdout: '', stderr: '' });
  };
  const fenced = (await import('./fence-fake')).withFence(execFile as any);
  const outer = (f: string, args: string[], opts: any, cb?: any) => {
    if (args[0] === 'run') h.runs.push(args);
    if (args[0] === 'exec' && args[1] === '-u' && args[2] === 'root') {
      h.calls.push(args.join(' '));
      if (h.rootFails) {
        const done = typeof opts === 'function' ? opts : cb;
        setImmediate(() => done(Object.assign(new Error('docker failed'), { code: 1 }), '', 'Error response from daemon: container is not running'));
        return { stdin: null };
      }
    }
    return fenced(f, args, opts, cb);
  };
  const mod = { ...real, exec, execFile: outer, execFileSync, execSync };
  return { ...mod, default: mod };
});
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';

const DB = 'bot1-fleet-postgres-data';
const registryPath = path.join(h.dir, 'instances.json');
const botDir = path.join(h.dir, 'bots', 'b1');
const composePath = path.join(botDir, 'docker-compose.yml');
const fleetDb = { containerName: 'bot1-fleet-postgres', user: 'smdb', db: 'smdb', volume: DB };
const compose = `services:
  bot:
    image: x
  fleet-postgres:
    image: postgres:16
    container_name: bot1-fleet-postgres
    volumes:
      - fleet-postgres-data:/var/lib/postgresql/data
  fleet-postgres-replica:
    image: postgres:16
    container_name: bot1-fleet-postgres-replica
volumes:
  fleet-postgres-data:
    name: ${DB}
`;
const record = (over: Record<string, unknown> = {}): any => ({
  id: 'b1', sanitizedName: 'bot1', displayName: 'Bot b1', titleName: 'Bot b1', status: 'stopped',
  sourceType: 'docker-image', envVars: {},
  createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', ...over,
});
const writeRegistry = (inst: any): void => {
  fs.writeFileSync(registryPath, JSON.stringify({ instances: { b1: inst } }));
};
const stored = (): any => JSON.parse(fs.readFileSync(registryPath, 'utf-8')).instances.b1;

beforeEach(() => {
  h.volumes = new Set([DB]);
  h.calls = [];
  h.execFails = [];
  h.rules = [];
  h.onExec = null;
  h.onVolumeRm = null;
  h.rootFails = false;
  (globalThis as { __fenceOwners?: Map<string, string> }).__fenceOwners?.clear();
  h.runs = [];
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(botDir, { recursive: true });
  fs.writeFileSync(composePath, compose);
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('R18-J4 and R7-J27: the fleet database retire', () => {
  it('NM4 N4: the write that drops the database record also drops the restore notice', async () => {
    writeRegistry(record({ fleetDb, fleetRestoreError: { file: 'old.dump', text: 'Restore of old.dump failed: x', at: '2026-10-28T10:00:00.000Z' } }));
    const res = await containerManager.retireFleetDbSidecar('b1');
    expect(res.success).toBe(true);
    expect(stored().fleetDb).toBeUndefined();
    expect(stored().fleetRestoreError).toBeUndefined();
  });

  it('stamps the retiring mark before the container is removed', async () => {
    writeRegistry(record({ fleetDb }));
    let markAtRm: unknown = 'not called';
    h.onExec = (cmd) => { if (cmd.startsWith('docker rm')) markAtRm = stored().fleetDb?.retiringAt; };
    const res = await containerManager.retireFleetDbSidecar('b1');
    expect(res.success).toBe(true);
    expect(typeof markAtRm).toBe('string');
    expect(stored().fleetDb).toBeUndefined();
  });

  it('refuses with everything kept when the deployed compose cannot be read', async () => {
    writeRegistry(record({ fleetDb }));
    fs.rmSync(composePath);
    fs.mkdirSync(composePath);
    const res = await containerManager.retireFleetDbSidecar('b1');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/nothing was removed/);
    expect(h.volumes.has(DB)).toBe(true);
    expect(h.calls.filter((c) => c.startsWith('docker rm'))).toEqual([]);
    expect(stored().fleetDb).toMatchObject({ volume: DB });
  });

  it('keeps the volume when the container rm fails for any reason but absence, and clears its own mark', async () => {
    writeRegistry(record({ fleetDb }));
    h.execFails = [[/^docker rm/, 'Error response from daemon: permission denied']];
    const res = await containerManager.retireFleetDbSidecar('b1');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/permission denied/);
    expect(h.volumes.has(DB)).toBe(true);
    expect(stored().fleetDb).toMatchObject({ volume: DB });
    expect(stored().fleetDb.retiringAt).toBeUndefined();
    expect(fs.readFileSync(composePath, 'utf-8')).toBe(compose);
  });

  it('tolerates a container that is already gone', async () => {
    writeRegistry(record({ fleetDb }));
    h.execFails = [[/^docker rm/, 'Error response from daemon: No such container: bot1-fleet-postgres']];
    const res = await containerManager.retireFleetDbSidecar('b1');
    expect(res.success).toBe(true);
    expect(h.volumes.has(DB)).toBe(false);
  });

  it('says the volume was removed when the compose write fails after it, keeps the mark, and a retry finishes', async () => {
    writeRegistry(record({ fleetDb }));
    h.onVolumeRm = () => fs.mkdirSync(`${composePath}.tmp`);
    const res: any = await containerManager.retireFleetDbSidecar('b1');
    expect(res.success).toBe(false);
    expect(res.volumeRemoved).toBe(true);
    expect(res.error).toMatch(/^the database volume bot1-fleet-postgres-data was removed, but its compose or record could not be updated/);
    expect(h.volumes.has(DB)).toBe(false);
    expect(typeof stored().fleetDb?.retiringAt).toBe('string');
    expect(containerManager.getBot('b1')?.fleetDb?.retiringAt).toBe(stored().fleetDb.retiringAt);

    const first = stored().fleetDb.retiringAt;
    h.onVolumeRm = null;
    fs.rmSync(`${composePath}.tmp`, { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 5));
    let markAtRetry: unknown;
    h.onExec = (cmd) => { if (cmd.startsWith('docker rm')) markAtRetry = stored().fleetDb?.retiringAt; };
    const again = await containerManager.retireFleetDbSidecar('b1');
    expect(again.success).toBe(true);
    expect(markAtRetry).toBe(first);
    expect(stored().fleetDb).toBeUndefined();
    expect(fs.readFileSync(composePath, 'utf-8')).not.toMatch(/fleet-postgres:/);
  });

  it('Start refuses while a retire is unfinished', async () => {
    writeRegistry(record({ fleetDb: { ...fleetDb, retiringAt: '2026-10-24T10:00:00.000Z' } }));
    const res = await containerManager.startBot('b1');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/fleet database of this instance was being removed/);
    expect(h.calls.filter((c) => c.includes('compose') && c.includes(' up'))).toEqual([]);
  });

  it('the database sidecar alone refuses to come up while a retire is unfinished', async () => {
    writeRegistry(record({ fleetDb: { ...fleetDb, retiringAt: '2026-10-24T10:00:00.000Z' } }));
    const res = await containerManager.startFleetDbSidecar('b1');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/was being removed .* and the removal did not finish/);
    expect(h.calls.filter((c) => c.includes('compose') && c.includes(' up'))).toEqual([]);
  });

  it('a retire retry that proved the volume predates the mark brings the sidecar up', async () => {
    writeRegistry(record({ fleetDb: { ...fleetDb, retiringAt: '2026-10-24T10:00:00.000Z' } }));
    const res = await containerManager.startFleetDbSidecar('b1', { retireRetry: true });
    expect(res.success).toBe(true);
    expect(h.calls.filter((c) => c.includes('compose') && c.includes(' up'))).toHaveLength(1);
  });
});

describe('R1-J38 and R7-J27: the standby service removal', () => {
  // Linux answers ENOTDIR here; Windows answers ENOENT, which is a compose never deployed.
  it.skipIf(process.platform === 'win32')('fails, and keeps the container, when the deployed compose cannot be read', async () => {
    fs.rmSync(botDir, { recursive: true, force: true });
    fs.writeFileSync(botDir, 'a file where the bot folder should be');
    const res = await containerManager.removeFleetDbReplicaService('b1', 'bot1-fleet-postgres-replica');
    expect(res.success).toBe(false);
    expect(h.calls.filter((c) => c.startsWith('docker rm'))).toEqual([]);
  });

  it('fails, and keeps the container, when the deployed compose is a folder', async () => {
    fs.rmSync(composePath);
    fs.mkdirSync(composePath);
    const res = await containerManager.removeFleetDbReplicaService('b1', 'bot1-fleet-postgres-replica');
    expect(res.success).toBe(false);
    expect(h.calls.filter((c) => c.startsWith('docker rm'))).toEqual([]);
  });

  it('fails when the container rm fails for any reason but absence', async () => {
    h.execFails = [[/^docker rm/, 'Error response from daemon: permission denied']];
    const res = await containerManager.removeFleetDbReplicaService('b1', 'bot1-fleet-postgres-replica');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/permission denied/);
  });

  it('succeeds over a container that is already gone and a compose that was never deployed', async () => {
    fs.rmSync(composePath);
    h.execFails = [[/^docker rm/, 'Error: No such container: bot1-fleet-postgres-replica']];
    const res = await containerManager.removeFleetDbReplicaService('b1', 'bot1-fleet-postgres-replica');
    expect(res.success).toBe(true);
  });
});
