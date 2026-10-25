import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The b16-1-update harness. h.onRm and h.onLogs run when the update removes the old helper or a read fetches its logs,
// so a row can start a lane or a new update inside that await.
const h = vi.hoisted(() => {
  const nodeOs = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const data = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'fu-8-recreate-'));
  process.env.DATA_DIR = data;
  return { data, repo: '', script: '', head: 'a'.repeat(40), helper: '', poll: 'exited 0', onRm: null as null | (() => void), onLogs: null as null | (() => void) };
});

vi.mock('../../src/casaos/detector', () => ({ getDeploymentMode: async () => 'docker' }));
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const map = (p: any) => {
    const s = String(p).replace(/\\/g, '/');
    return h.repo && (s === '/repo' || s.startsWith('/repo/')) ? h.repo + s.slice(5) : p;
  };
  const existsSync = (p: any) => real.existsSync(map(p));
  const readFileSync = (p: any, ...rest: any[]) => (real.readFileSync as any)(map(p), ...rest);
  return { ...real, default: { ...real, existsSync, readFileSync }, existsSync, readFileSync };
});
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const labels = {
    'com.docker.compose.project': 'dbm', 'com.docker.compose.service': 'manager',
    'com.docker.compose.project.working_dir': '/srv/dbm', 'com.docker.compose.project.config_files': '/srv/dbm/docker-compose.remote.yml',
  };
  const execSync = (cmd: string) => {
    if (cmd.startsWith('docker inspect')) return JSON.stringify([{ Config: { Labels: labels, Image: 'dbm-manager' } }]);
    if (cmd.includes('rev-parse HEAD')) return h.head;
    return '';
  };
  const spawn = (cmd: string, args: string[]) => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    if (cmd === 'git' && args.includes('pull')) h.head = 'b'.repeat(40);
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  const spawnSync = (cmd: string, args: string[]) => {
    const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' });
    if (cmd !== 'docker') throw new Error(`unexpected ${cmd}`);
    if (args[0] === 'compose' && args.includes('--services')) return ok('manager\n');
    if (args[0] === 'image') return ok('sha256:new');
    if (args[0] === 'container' && args[1] === 'inspect') return ok(h.helper);
    if (args[0] === 'inspect' && args[1] === 'dbm-self-update') return ok(h.poll);
    if (args[0] === 'inspect') return ok('sha256:new');
    if (args[0] === 'rm') h.onRm?.();
    if (args[0] === 'run') { h.script = args[args.length - 1]; return ok('id'); }
    return ok('');
  };
  const execFile = (cmd: string, args: string[], opts: any, cb: (e: unknown, r?: unknown, r2?: unknown) => void) => {
    if (cmd === 'docker') {
      if (args[0] === 'logs') h.onLogs?.();
      const viaExec = (args[0] === 'inspect' && args.length === 2) || args[0] === 'logs';
      const r = viaExec ? { status: 0, stdout: String(execSync(`docker ${args.join(' ')}`)), stderr: '' } : spawnSync(cmd, args);
      queueMicrotask(() => cb(r.status === 0 ? null : Object.assign(new Error(r.stderr), { stderr: r.stderr }), r.stdout, r.stderr));
      return;
    }
    return (real.execFile as any)(cmd, args, opts, cb);
  };
  return { ...real, execSync, execFile, spawn, spawnSync };
});

import * as fleetBackup from '../../src/instance/fleetBackup';
import * as selfUpdate from '../../src/manager/selfUpdate';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-8-recreate-repo-'));
  h.repo = path.join(tmp, 'repo').replace(/\\/g, '/');
  fs.mkdirSync(path.join(h.repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(h.repo, 'authelia'));
  fs.writeFileSync(path.join(h.repo, 'authelia', 'configuration.yml'), 'a: 1\n');
  fs.writeFileSync(path.join(h.repo, 'authelia', 'users_database.yml'), 'users: {}\n');
  h.script = '';
  h.head = 'a'.repeat(40);
  h.helper = '';
  h.poll = 'exited 0';
  h.onRm = null;
  h.onLogs = null;
});
afterEach(() => {
  vi.useRealTimers();
  h.repo = '';
  fs.rmSync(tmp, { recursive: true, force: true });
});
afterAll(() => { fs.rmSync(h.data, { recursive: true, force: true }); });

const updateFile = () => path.join(h.data, 'manager-update.json');

async function update(): Promise<Error | null> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
  let err: Error | null = null;
  const done = selfUpdate.runManagerUpdate(() => {}).catch((e) => { err = e; });
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(10000);
  await done;
  vi.useRealTimers();
  return err;
}

describe('FU-8: the recreate checks the lanes again after its last await', () => {
  it('a lane claimed while the old helper is removed stops the launch', async () => {
    h.onRm = () => { fleetBackup.claimFleetBackupBusy('x2'); };
    let err: Error | null;
    try {
      err = await update();
    } finally {
      fleetBackup.releaseFleetBackupBusy('x2');
    }
    expect(err?.message).toMatch(/^The images were rebuilt, but the stack was not recreated: .*x2/);
    expect(h.script).toBe('');
  });
});

describe('FU-8: a stale verdict does not overwrite a newer update record', () => {
  it('readLastUpdate leaves the file alone when a new update recorded itself during its awaits', async () => {
    h.poll = 'running 0';
    expect(await update()).toBeNull();
    const pending = JSON.parse(fs.readFileSync(updateFile(), 'utf-8'));
    expect(pending.state).toBe('pending');
    h.helper = 'exited 1';
    h.onLogs = () => {
      fs.writeFileSync(updateFile(), JSON.stringify({ ...pending, opId: 'newer', state: 'running' }));
      h.onLogs = null;
    };
    const last = await selfUpdate.readLastUpdate();
    expect(last).toMatchObject({ opId: pending.opId, state: 'failed' });
    expect(JSON.parse(fs.readFileSync(updateFile(), 'utf-8'))).toMatchObject({ opId: 'newer', state: 'running' });
  });

  it('with no newer record the verdict is written', async () => {
    h.poll = 'running 0';
    expect(await update()).toBeNull();
    const pending = JSON.parse(fs.readFileSync(updateFile(), 'utf-8'));
    h.helper = 'exited 1';
    await selfUpdate.readLastUpdate();
    expect(JSON.parse(fs.readFileSync(updateFile(), 'utf-8'))).toMatchObject({ opId: pending.opId, state: 'failed' });
  });
});
