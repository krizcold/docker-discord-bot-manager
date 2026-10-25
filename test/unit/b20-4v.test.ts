import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b20-4v-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    volumes: new Set<string>(),
    calls: [] as string[],
    // First matching rule answers an execFile docker call: [predicate, ok, stdout, stderr].
    rules: [] as Array<[(args: string[]) => boolean, boolean, string, string]>,
  };
});

const fail = (stderr: string): Error => Object.assign(new Error(stderr), { stderr });
const volumeAnswer = (args: string[]): string => {
  if (args[0] === 'volume' && args[1] === 'inspect') {
    const name = args[args.length - 1];
    if (!h.volumes.has(name)) throw fail(`Error: No such volume: ${name}`);
  }
  // docker run -v mints a named volume that does not exist.
  if (args[0] === 'run') {
    for (let i = 0; i < args.length - 1; i++) if (args[i] === '-v') h.volumes.add(args[i + 1].split(':')[0]);
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
    done(null, { stdout: '', stderr: '' });
  };
  const mod = { ...real, exec, execFile, execFileSync, execSync };
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
import { disarmRecoveryChannel } from '../../src/instance/recoveryChannel';

const DB = 'bot1-fleet-postgres-data';
const registryPath = path.join(h.dir, 'instances.json');
const fleetDb = { containerName: 'bot1-fleet-postgres', user: 'smdb', db: 'smdb', volume: DB };
const channel = { mode: 'source', containerName: 'bot1-recovery-relay', token: 't', createdAt: 1, endpointHost: 'h', endpointPort: 15433, pinCert: 'c' };
const record = (over: Record<string, unknown> = {}): any => ({
  id: 'b1', sanitizedName: 'bot1', displayName: 'Bot b1', titleName: 'Bot b1', status: 'stopped',
  sourceType: 'docker-image', envVars: {},
  createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', ...over,
});
const sourceBot = () => {
  fs.writeFileSync(registryPath, JSON.stringify({ instances: { b1: record({ fleetDb, recoveryChannel: channel }) } }));
  return containerManager.getBot('b1')!;
};
const stored = (): any => JSON.parse(fs.readFileSync(registryPath, 'utf-8')).instances.b1;
const isUnfence = (a: string[]) => a[0] === 'exec' && a.join(' ').includes('ALTER SYSTEM RESET');
const isStrip = (a: string[]) => a[0] === 'run' && a.join(' ').includes('default_transaction_read_only');
const isDbInspect = (a: string[]) => a[0] === 'inspect' && a[a.length - 1] === fleetDb.containerName;
const isVolumeInspect = (a: string[]) => a[0] === 'volume' && a[1] === 'inspect' && a[a.length - 1] === DB;

beforeEach(() => {
  h.volumes = new Set([DB]);
  h.calls = [];
  h.rules = [
    [isUnfence, false, '', 'Error response from daemon: No such container: bot1-fleet-postgres'],
    [isDbInspect, false, '', 'Error: No such object: bot1-fleet-postgres'],
  ];
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('B20-4v: the disarm fence strip mounts only a volume docker proved exists', () => {
  it('runs no docker run and mints no volume when the database volume is gone', async () => {
    h.volumes.delete(DB);
    const res = await disarmRecoveryChannel(sourceBot());
    expect(h.calls.filter((c) => c.startsWith('run'))).toEqual([]);
    expect(h.volumes.has(DB)).toBe(false);
    expect(res.error ?? '').not.toMatch(/READ-ONLY|fence/);
  });

  it('says it cannot confirm the fence when docker does not answer the volume read', async () => {
    h.rules.unshift([isVolumeInspect, false, '', 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock']);
    const res = await disarmRecoveryChannel(sourceBot());
    expect(h.calls.filter((c) => c.startsWith('run'))).toEqual([]);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/can't confirm whether the database is still fenced READ-ONLY/);
    expect(res.error).toMatch(/Cannot connect to the Docker daemon/);
    expect(stored().recoveryChannel?.disarmLeft).toMatch(/can't confirm/);
  });

  it('strips the fence from the volume as before when the volume exists', async () => {
    h.rules.unshift([isStrip, true, 'stripped\n', '']);
    const res = await disarmRecoveryChannel(sourceBot());
    expect(h.calls.filter((c) => c.startsWith('run'))).toHaveLength(1);
    expect(h.calls.find((c) => c.startsWith('run'))).toContain(`${DB}:/pgdata`);
    expect(res.error ?? '').not.toMatch(/fence/);
  });

  it('reports a failed strip on an existing volume as before', async () => {
    h.rules.unshift([isStrip, false, '', 'Error response from daemon: mount denied']);
    const res = await disarmRecoveryChannel(sourceBot());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/write fence on bot1-fleet-postgres could not be lifted \(Error response from daemon: mount denied\)/);
  });
});
