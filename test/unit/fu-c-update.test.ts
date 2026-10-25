import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A fake git and docker (the b08-3 shape). h.syncGit records each git command run through execSync, h.asyncGit each
// git call through execFile with the options it passed.
const h = vi.hoisted(() => ({
  repo: '', head: '', newHead: '', calls: [] as string[][],
  syncGit: [] as string[], asyncGit: [] as Array<{ args: string[]; opts: any }>,
}));

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
    if (cmd.startsWith('git')) h.syncGit.push(cmd);
    if (cmd.startsWith('docker inspect')) return JSON.stringify([{ Config: { Labels: labels, Image: 'dbm-manager' } }]);
    if (cmd.startsWith('docker logs')) return 'Container dbm-caddy Recreate';
    if (cmd.includes('rev-parse HEAD')) return h.head;
    return '';
  };
  const spawnSync = (cmd: string, args: string[]) => {
    h.calls.push([cmd, ...args]);
    const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' });
    if (args[0] === 'compose' && args.includes('--services')) return ok('manager\n');
    if (args[0] === 'compose' && args.includes('--hash')) return ok('manager h1\n');
    if (args[0] === 'compose' && args.includes('json')) return ok(JSON.stringify({ services: { manager: { build: { context: '.' }, image: 'dbm-manager' } } }));
    if (args[0] === 'compose' && args.includes('ps')) return ok('c0');
    if (args[0] === 'container' && args[1] === 'inspect') return { status: 1, stdout: '', stderr: 'No such object' };
    if (args[0] === 'image') return ok('sha256:m');
    if (args[0] === 'inspect' && args[1] === 'dbm-self-update') return ok('exited 0');
    if (args[0] === 'inspect' && args[1] === 'c0') return ok('manager h1 sha256:m dbm-manager true');
    if (args[0] === 'inspect') return ok('sha256:m');
    if (args[0] === 'run') return ok('id');
    return ok('');
  };
  const execFile = (cmd: string, args: string[], opts: any, cb: (e: unknown, r?: unknown, r2?: unknown) => void) => {
    if (cmd === 'docker') {
      const viaExec = (args[0] === 'inspect' && args.length === 2) || args[0] === 'logs';
      const r = viaExec ? { status: 0, stdout: String(execSync(`docker ${args.join(' ')}`)), stderr: '' } : spawnSync(cmd, args);
      queueMicrotask(() => cb(r.status === 0 ? null : Object.assign(new Error(r.stderr), { stderr: r.stderr }), r.stdout, r.stderr));
      return;
    }
    h.asyncGit.push({ args, opts });
    let stdout = '';
    if (args.includes('--abbrev-ref')) stdout = 'main';
    else if (args.includes('rev-parse')) stdout = h.head;
    else if (args.includes('rev-list')) stdout = '0';
    setImmediate(() => cb(null, { stdout, stderr: '' }));
  };
  const spawn = (cmd: string, args: string[]) => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    if (cmd === 'git' && args.includes('pull')) h.head = h.newHead;
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  return { ...real, execSync, execFile, spawn, spawnSync };
});

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
let tmp: string;

async function load() {
  vi.resetModules();
  return import('../../src/manager/selfUpdate');
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-c-u-'));
  h.repo = path.join(tmp, 'repo').replace(/\\/g, '/');
  fs.mkdirSync(path.join(h.repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(h.repo, 'authelia'));
  process.env.DATA_DIR = path.join(tmp, 'data');
  process.env.MANAGER_BUILD_COMMIT = A;
  h.head = A;
  h.newHead = B;
  h.calls = [];
  h.syncGit = [];
  h.asyncGit = [];
});

afterEach(() => {
  vi.useRealTimers();
  h.repo = '';
  delete process.env.DATA_DIR;
  delete process.env.MANAGER_BUILD_COMMIT;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function update(mod: Awaited<ReturnType<typeof load>>) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
  let err: Error | null = null;
  const done = mod.runManagerUpdate(() => {}).then(() => {}, (e) => { err = e; });
  for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(10000);
  await done;
  return err as Error | null;
}

describe('FU-8c the update runs git off the event loop', () => {
  it('reads HEAD before and after the pull with no synchronous git call', async () => {
    const err = await update(await load());
    expect(err).toBeNull();
    expect(h.syncGit).toEqual([]);
    expect(h.calls.some((c) => c[1] === 'run')).toBe(true);
    const revParse = h.asyncGit.filter((g) => g.args.includes('rev-parse'));
    expect(revParse.length).toBe(2);
    for (const g of revParse) expect(g.opts?.timeout).toBeGreaterThan(0);
  });

  it('marks the users database skip-worktree with no timeout, since it writes the index', async () => {
    await update(await load());
    const mark = h.asyncGit.filter((g) => g.args.includes('update-index'));
    expect(mark.length).toBe(1);
    expect(mark[0].args).toEqual(expect.arrayContaining(['--skip-worktree', 'authelia/users_database.yml']));
    expect(mark[0].opts?.timeout).toBeUndefined();
  });
});
