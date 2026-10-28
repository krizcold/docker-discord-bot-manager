import http from 'http';
import { AddressInfo } from 'net';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'fu-m-'));
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
  // docker run -v mints a named volume that does not exist, :ro or not.
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
      if (args[0] === 'run') volumeAnswer(args);
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
  const mod = { ...real, exec, execFile: (await import('./fence-fake')).withFence(execFile as any), execFileSync, execSync };
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
import * as fleetBackup from '../../src/instance/fleetBackup';
import { Client } from '../../src/cli/client';
import { dispatch } from '../../src/cli/commands';

const DB = 'bot1-fleet-postgres-data';
const DAEMON_DOWN = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock';
const registryPath = path.join(h.dir, 'instances.json');
const fleetDb = { containerName: 'bot1-fleet-postgres', user: 'smdb', db: 'smdb', volume: DB };
const record = (over: Record<string, unknown> = {}): any => ({
  id: 'b1', sanitizedName: 'bot1', displayName: 'Bot b1', titleName: 'Bot b1', status: 'stopped',
  sourceType: 'docker-image', envVars: {}, fleetDb,
  createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', ...over,
});
const writeBot = (over: Record<string, unknown> = {}) => {
  fs.writeFileSync(registryPath, JSON.stringify({ instances: { b1: record(over) } }));
  return containerManager.getBot('b1')!;
};
const stored = (): any => JSON.parse(fs.readFileSync(registryPath, 'utf-8')).instances.b1;
const isVolumeInspect = (a: string[]) => a[0] === 'volume' && a[1] === 'inspect' && a[a.length - 1] === DB;
const isUnfence = (a: string[]) => a[0] === 'exec' && a.join(' ').includes('ALTER SYSTEM RESET');
const SECRET = 'tok-S3CRET-fu-m';

beforeEach(() => {
  h.volumes = new Set([DB]);
  h.calls = [];
  h.rules = [];
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('FU-M: stored fence and restore notices carry the record secrets as ***', () => {
  it('a stuck-fence warning a lane hands in with a secret is stored scrubbed', async () => {
    writeBot({ updateToken: SECRET });
    h.rules.push([isUnfence, false, '', 'Error response from daemon: No such container: bot1-fleet-postgres']);
    h.rules.push([isVolumeInspect, false, '', DAEMON_DOWN]);
    await fleetBackup.liftLaneFence('b1', fleetDb, 'reseed:1', 'a re-seed', `retry with postgres://smdb:${SECRET}@host/smdb`);
    const card = fleetBackup.getFleetFenceStuck('b1');
    expect(card).toMatch(/can't confirm/);
    expect(card).not.toContain(SECRET);
    expect(card).toContain('***');
  });

  it('a restore notice saved with a secret is stored and shown scrubbed', () => {
    writeBot({ updateToken: SECRET });
    containerManager.updateInstanceFleetRestoreError('b1', { file: 'd.sql', text: `Restore of d.sql failed: pg_restore said ${SECRET}`, at: '2026-10-28T10:00:00.000Z', doubt: true });
    expect(JSON.stringify(stored().fleetRestoreError)).not.toContain(SECRET);
    expect(stored().fleetRestoreError.text).toContain('***');
    expect(fleetBackup.getFleetRestoreError('b1')).not.toContain(SECRET);
    expect(fleetBackup.getFleetRestoreError('b1')).toContain('Restore of d.sql failed');
  });
});

class Exit extends Error {
  constructor(public code: number) { super(`exit ${code}`); }
}

describe('FU-M: bots build-logs exits apart on an idle frame that carries cutOp', () => {
  let server: http.Server;
  let frames: object[] = [];
  beforeEach(async () => {
    server = http.createServer((_q, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Exit(code ?? 0); }) as never);
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const run = async (): Promise<number> => {
    const client = new Client({ host: '127.0.0.1', port: (server.address() as AddressInfo).port });
    try { await dispatch(client, ['bots', 'build-logs', 'b1'], { json: true }); } catch (e) { if (e instanceof Exit) return e.code; throw e; }
    throw new Error('no exit');
  };

  it('an idle frame with cutOp exits 3', async () => {
    frames = [{ type: 'idle', status: 'stopped', cutOp: { op: 'update', startedAt: 1 } }];
    expect(await run()).toBe(3);
  });

  it('an idle frame whose cut record was unreadable exits 3', async () => {
    frames = [{ type: 'idle', status: 'stopped', cutOp: { unknown: true } }];
    expect(await run()).toBe(3);
  });

  it('an idle frame without cutOp still exits 0', async () => {
    frames = [{ type: 'idle', status: 'stopped' }];
    expect(await run()).toBe(0);
  });
});
