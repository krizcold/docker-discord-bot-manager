import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A fake git and docker (the fu-c-update shape). Every git call through execFile is recorded with its options. A
// git fetch answers only when one of h.fetchWaiters is called, or at once when h.fetchHangs is false; a call given a timeout is killed at it, as execFile does.
const h = vi.hoisted(() => ({
  repo: '', head: '',
  git: [] as Array<{ args: string[]; opts: any }>,
  fetchWaiters: [] as Array<() => void>,
  fetchHangs: true,
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
      const answer = (err: unknown) => { if (!settled) { settled = true; cb(err, { stdout: '', stderr: '' }); } };
      h.fetchWaiters.push(() => answer(null));
      if (!h.fetchHangs) setImmediate(() => answer(null));
      if (opts?.timeout) setTimeout(() => answer(Object.assign(new Error('Command failed: git fetch'), { killed: true, signal: 'SIGTERM' })), opts.timeout);
      return;
    }
    let stdout = '';
    if (args.includes('--abbrev-ref')) stdout = 'main';
    else if (args.includes('rev-parse')) stdout = h.head;
    else if (args.includes('rev-list')) stdout = '3';
    setImmediate(() => cb(null, { stdout, stderr: '' }));
  };
  return { ...real, execFile };
});

const A = 'a'.repeat(40);
let tmp: string;

async function load() {
  vi.resetModules();
  return import('../../src/manager/selfUpdate');
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-w-u-'));
  h.repo = path.join(tmp, 'repo').replace(/\\/g, '/');
  fs.mkdirSync(path.join(h.repo, '.git'), { recursive: true });
  process.env.DATA_DIR = path.join(tmp, 'data');
  process.env.MANAGER_BUILD_COMMIT = A;
  h.head = A;
  h.git = [];
  h.fetchWaiters = [];
  h.fetchHangs = true;
});

afterEach(() => {
  vi.useRealTimers();
  for (const release of h.fetchWaiters) release();
  h.repo = '';
  delete process.env.DATA_DIR;
  delete process.env.MANAGER_BUILD_COMMIT;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const fetches = () => h.git.filter((g) => g.args.includes('fetch'));

async function version(mod: Awaited<ReturnType<typeof load>>, waitMs: number) {
  let out: any = null;
  const done = mod.getManagerVersion().then((v) => { out = v; });
  for (let t = 0; t < waitMs && out === null; t += 1000) await vi.advanceTimersByTimeAsync(1000);
  await vi.advanceTimersByTimeAsync(0);
  void done;
  return out;
}

describe('FU-W the version read never kills a running git fetch early', () => {
  it('runs git fetch with stall limits and only a long SIGTERM bound', async () => {
    const mod = await load();
    const read = mod.getManagerVersion();
    for (let i = 0; i < 50 && fetches().length === 0; i++) await new Promise((r) => setImmediate(r));
    expect(fetches().length).toBe(1);
    const f = fetches()[0];
    expect(f.args).toEqual(expect.arrayContaining(['http.lowSpeedLimit=1000', 'http.lowSpeedTime=60']));
    expect(f.opts?.env?.GIT_SSH_COMMAND).toMatch(/ServerAliveInterval=15.*ServerAliveCountMax=4/);
    expect(f.opts?.timeout).toBeGreaterThanOrEqual(300000);
    expect(f.opts?.killSignal ?? 'SIGTERM').toBe('SIGTERM');
    h.fetchWaiters.shift()!();
    const v = await read;
    expect(v.checked).toBe(true);
    expect(v.behindBy).toBe(3);
  });

  it('answers within the bound while the fetch hangs, with the behind count unknown', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const mod = await load();
    const v = await version(mod, 40000);
    expect(v).not.toBeNull();
    expect(v.checked).toBe(false);
    expect(v.fetchError).toBeTruthy();
    expect(v.fetchError).not.toMatch(/can't confirm|:/);
    expect(v.fetchError).not.toMatch(/later check/);
    expect(v.behindBy ?? 0).toBe(0);
    expect(h.git.some((g) => g.args.includes('rev-list'))).toBe(false);
  });

  it('does not start a second fetch while the first still runs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const mod = await load();
    expect((await version(mod, 40000))?.checked).toBe(false);
    await vi.advanceTimersByTimeAsync(61000);
    const again = await version(mod, 40000);
    expect(again?.checked).toBe(false);
    expect(fetches().length).toBe(1);
  });

  it('reads the behind count once the fetch that outlived a read finishes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const mod = await load();
    expect((await version(mod, 40000))?.checked).toBe(false);
    h.fetchHangs = false;
    for (const release of h.fetchWaiters.splice(0)) release();
    await vi.advanceTimersByTimeAsync(61000);
    const fresh = await version(mod, 40000);
    expect(fresh?.checked).toBe(true);
    expect(fresh?.behindBy).toBe(3);
  });
  it('a fetch that never settles is ended at the outer bound, and a later read starts a fresh one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const mod = await load();
    expect((await version(mod, 40000))?.checked).toBe(false);
    await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
    h.fetchHangs = false;
    const fresh = await version(mod, 40000);
    expect(fetches().length).toBe(2);
    expect(fresh?.checked).toBe(true);
    expect(fresh?.behindBy).toBe(3);
  });
});
