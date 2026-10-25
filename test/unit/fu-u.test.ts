import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The fu-w-update fake git and docker, with git config answers (h.sshConfig: null is unset, 'error' an unreadable
// config) and a spawn that records each pull with the fetches still open, then fails it.
const h = vi.hoisted(() => ({
  repo: '', head: '',
  git: [] as Array<{ args: string[]; opts: any }>,
  fetchWaiters: [] as Array<() => void>,
  fetchHangs: true,
  sshConfig: null as null | string,
  spawned: [] as Array<{ cmd: string; args: string[]; fetchesOpen: number }>,
  openFetches: 0,
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
  const dockerAnswer = (args: string[]): string => {
    if (args[0] === 'inspect' && args.length === 2) return JSON.stringify([{ Config: { Labels: labels, Image: 'dbm-manager' } }]);
    if (args[0] === 'compose' && args.includes('json')) return JSON.stringify({ services: { manager: { build: { context: '.' }, image: 'dbm-manager' } } });
    if (args[0] === 'compose' && args.includes('--hash')) return 'manager h1\n';
    if (args[0] === 'compose' && args.includes('ps')) return 'c0';
    if (args[0] === 'inspect' && args[1] === 'c0') return 'manager h1 sha256:m dbm-manager true';
    if (args[0] === 'image') return 'sha256:m';
    return '';
  };
  const execFile = (cmd: string, args: string[], opts: any, cb: (e: unknown, r?: unknown, r2?: unknown) => void) => {
    if (cmd === 'docker') {
      const out = dockerAnswer(args);
      queueMicrotask(() => cb(null, out, ''));
      return;
    }
    h.git.push({ args, opts });
    if (args.includes('fetch')) {
      let settled = false;
      h.openFetches++;
      const answer = (err: unknown) => { if (!settled) { settled = true; h.openFetches--; cb(err, { stdout: '', stderr: '' }); } };
      h.fetchWaiters.push(() => answer(null));
      if (!h.fetchHangs) setImmediate(() => answer(null));
      if (opts?.timeout) setTimeout(() => answer(Object.assign(new Error('Command failed: git fetch'), { killed: true, signal: 'SIGTERM' })), opts.timeout);
      return;
    }
    if (args.includes('config')) {
      const c = h.sshConfig;
      if (c === null) setImmediate(() => cb(Object.assign(new Error('Command failed: git config'), { code: 1 })));
      else if (c === 'error') setImmediate(() => cb(Object.assign(new Error('Command failed: git config'), { code: 3 })));
      else setImmediate(() => cb(null, { stdout: c + '\n', stderr: '' }));
      return;
    }
    let stdout = '';
    if (args.includes('--abbrev-ref')) stdout = 'main';
    else if (args.includes('rev-parse')) stdout = h.head;
    else if (args.includes('rev-list')) stdout = '3';
    setImmediate(() => cb(null, { stdout, stderr: '' }));
  };
  const spawn = (cmd: string, args: string[]) => {
    h.spawned.push({ cmd, args, fetchesOpen: h.openFetches });
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => child.emit('close', 1));
    return child;
  };
  return { ...real, execFile, spawn };
});

const A = 'a'.repeat(40);
let tmp: string;

async function load() {
  vi.resetModules();
  return import('../../src/manager/selfUpdate');
}

const clearSshEnv = () => { delete process.env.GIT_SSH_COMMAND; delete process.env.GIT_SSH; };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-u-'));
  h.repo = path.join(tmp, 'repo').replace(/\\/g, '/');
  fs.mkdirSync(path.join(h.repo, '.git'), { recursive: true });
  process.env.DATA_DIR = path.join(tmp, 'data');
  process.env.MANAGER_BUILD_COMMIT = A;
  clearSshEnv();
  h.head = A;
  h.git = [];
  h.fetchWaiters = [];
  h.fetchHangs = true;
  h.sshConfig = null;
  h.spawned = [];
  h.openFetches = 0;
});

afterEach(() => {
  vi.useRealTimers();
  for (const release of h.fetchWaiters) release();
  h.repo = '';
  delete process.env.DATA_DIR;
  delete process.env.MANAGER_BUILD_COMMIT;
  clearSshEnv();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const fetches = () => h.git.filter((g) => g.args.includes('fetch'));
const pulls = () => h.spawned.filter((s) => s.args.includes('pull'));
const flush = async (n = 60) => { for (let i = 0; i < n; i++) await vi.advanceTimersByTimeAsync(0); };

async function hungRead(mod: Awaited<ReturnType<typeof load>>) {
  let out: any = null;
  void mod.getManagerVersion().then((v) => { out = v; });
  for (let t = 0; t < 40000 && out === null; t += 1000) await vi.advanceTimersByTimeAsync(1000);
  return out;
}

async function firstFetch(mod: Awaited<ReturnType<typeof load>>) {
  const read = mod.getManagerVersion();
  for (let i = 0; i < 80 && fetches().length === 0; i++) await new Promise((r) => setImmediate(r));
  expect(fetches().length).toBe(1);
  h.fetchWaiters.shift()!();
  await read;
  return fetches()[0];
}

describe('FU-Wu the update pull waits for a fetch still running', () => {
  it('starts git pull only after the background fetch settles, and starts no fetch of its own', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const mod = await load();
    expect((await hungRead(mod))?.checked).toBe(false);
    let failed: unknown = null;
    const run = mod.runManagerUpdate(() => {}).catch((e) => { failed = e; });
    await flush();
    expect(pulls().length).toBe(0);
    for (const release of h.fetchWaiters.splice(0)) release();
    await flush();
    await run;
    expect(pulls().length).toBe(1);
    expect(pulls()[0].fetchesOpen).toBe(0);
    expect(fetches().length).toBe(1);
    expect(failed).toBeTruthy();
  });

  it('a version read already under way when the update starts runs no fetch beside the pull', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const mod = await load();
    let out: any = null;
    void mod.getManagerVersion().then((v) => { out = v; });
    const run = mod.runManagerUpdate(() => {}).catch(() => {});
    for (let i = 0; i < 40 && out === null; i++) await vi.advanceTimersByTimeAsync(1000);
    await run;
    expect(fetches().length).toBe(0);
    expect(out?.checked).toBe(false);
    expect(out?.behindBy ?? 0).toBe(0);
  });
});

describe('FU-Wk the ssh keepalive never replaces an operator ssh command', () => {
  it('adds the keepalive and the https stall limits when no ssh command is set', async () => {
    const f = await firstFetch(await load());
    expect(f.args).toEqual(expect.arrayContaining(['http.lowSpeedLimit=1000', 'http.lowSpeedTime=60']));
    expect(f.opts?.env?.GIT_SSH_COMMAND).toMatch(/ServerAliveInterval=15.*ServerAliveCountMax=4/);
  });

  it('keeps a GIT_SSH_COMMAND set in the manager env', async () => {
    process.env.GIT_SSH_COMMAND = 'ssh -i /keys/deploy';
    const f = await firstFetch(await load());
    expect(f.opts?.env?.GIT_SSH_COMMAND ?? process.env.GIT_SSH_COMMAND).toBe('ssh -i /keys/deploy');
    expect(f.args).toEqual(expect.arrayContaining(['http.lowSpeedLimit=1000']));
  });

  it('keeps a GIT_SSH program set in the manager env', async () => {
    process.env.GIT_SSH = '/keys/ssh-wrapper';
    const f = await firstFetch(await load());
    expect(f.opts?.env?.GIT_SSH_COMMAND).toBeUndefined();
  });

  it('keeps a core.sshCommand from the repo git config', async () => {
    h.sshConfig = 'ssh -i /keys/deploy';
    const f = await firstFetch(await load());
    expect(f.opts?.env?.GIT_SSH_COMMAND).toBeUndefined();
    expect(f.args).toEqual(expect.arrayContaining(['http.lowSpeedLimit=1000', 'http.lowSpeedTime=60']));
  });

  it('adds no keepalive when the git config cannot be read', async () => {
    h.sshConfig = 'error';
    const f = await firstFetch(await load());
    expect(f.opts?.env?.GIT_SSH_COMMAND).toBeUndefined();
  });
});
