import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// B08-3e: the version and update routes ask docker without blocking the event loop. The fake docker answers the
// same through every API; h.sync records each docker call made through spawnSync or execSync.
const h = vi.hoisted(() => ({ repo: '', sync: [] as string[], async: [] as Array<{ args: string[]; opts: any }> }));

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
  const util = await import('util');
  const labels = {
    'com.docker.compose.project': 'dbm', 'com.docker.compose.service': 'manager',
    'com.docker.compose.project.working_dir': '/srv/dbm', 'com.docker.compose.project.config_files': '/srv/dbm/docker-compose.remote.yml',
  };
  const docker = (args: string[]): { status: number; stdout: string; stderr: string } => {
    const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' });
    if (args[0] === 'inspect' && args.length === 2) return ok(JSON.stringify([{ Config: { Labels: labels, Image: 'dbm-manager' } }]));
    if (args[0] === 'container' && args[1] === 'inspect') return { status: 1, stdout: '', stderr: 'Error: No such object: dbm-self-update' };
    if (args[0] === 'compose' && args.includes('json')) return ok(JSON.stringify({ services: { manager: { build: { context: '.' }, image: 'dbm-manager' } } }));
    if (args[0] === 'compose' && args.includes('--hash')) return ok('manager h1\n');
    if (args[0] === 'compose' && args.includes('ps')) return ok('c0\n');
    if (args[0] === 'inspect' && args[1] === 'c0') return ok('manager h1 sha256:m dbm-manager true');
    if (args[0] === 'image') return ok('sha256:m');
    return ok('');
  };
  const spawnSync = (cmd: string, args: string[]) => {
    if (cmd === 'docker') { h.sync.push(args.join(' ')); return docker(args); }
    return real.spawnSync(cmd, args);
  };
  const execSync = (cmd: string) => {
    if (cmd.startsWith('docker ')) {
      h.sync.push(cmd);
      return docker(cmd.split(' ').slice(1)).stdout;
    }
    if (cmd.includes('rev-parse HEAD')) return 'a'.repeat(40);
    return '';
  };
  const execFile: any = (cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as any;
    const opts = typeof optsOrCb === 'function' ? {} : optsOrCb;
    if (cmd === 'docker') {
      h.async.push({ args, opts });
      const r = docker(args);
      setImmediate(() => cb(r.status === 0 ? null : Object.assign(new Error(r.stderr), { code: r.status, stderr: r.stderr }), r.stdout, r.stderr));
      return {} as any;
    }
    let stdout = '';
    if (args.includes('--abbrev-ref')) stdout = 'main';
    else if (args.includes('rev-parse')) stdout = 'a'.repeat(40);
    else if (args.includes('rev-list')) stdout = '0';
    setImmediate(() => cb(null, stdout, ''));
    return {} as any;
  };
  execFile[util.promisify.custom] = (cmd: string, args: string[], opts: any) => new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err: any, stdout: string, stderr: string) => (err ? reject(err) : resolve({ stdout, stderr })));
  });
  return { ...real, execSync, execFile, spawnSync };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-8-update-'));
  h.repo = path.join(tmp, 'repo').replace(/\\/g, '/');
  fs.mkdirSync(path.join(h.repo, '.git'), { recursive: true });
  process.env.DATA_DIR = path.join(tmp, 'data');
  process.env.MANAGER_BUILD_COMMIT = 'a'.repeat(40);
  h.sync.length = 0;
  h.async.length = 0;
});
afterEach(() => {
  h.repo = '';
  delete process.env.DATA_DIR;
  delete process.env.MANAGER_BUILD_COMMIT;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function route(method: 'get' | 'post', p: string): Promise<{ code: number; body: any }> {
  vi.resetModules();
  const { createManagerRoutes } = await import('../../src/webui/routes/manager');
  const router: any = createManagerRoutes({} as any);
  const layer = router.stack.find((l: any) => l.route?.path === p && l.route.methods[method]);
  const res: any = { code: 200, body: null, status(c: number) { this.code = c; return this; }, json(b: unknown) { this.body = b; return this; } };
  await layer.route.stack[0].handle({}, res, () => {});
  return { code: res.code, body: res.body };
}

describe('B08-3e: the self-update routes ask docker asynchronously', () => {
  it('GET /version reads the stack with no synchronous docker call, and every read has a bound', async () => {
    const { code, body } = await route('get', '/version');
    expect(code).toBe(200);
    expect(body).toMatchObject({ success: true, supported: true, stackPending: false });
    expect(h.sync).toEqual([]);
    expect(h.async.length).toBeGreaterThan(0);
    for (const c of h.async) expect(c.opts?.timeout).toBeGreaterThan(0);
  });

  it('updateBlocker and isUpdateInProgress make no synchronous docker call', async () => {
    vi.resetModules();
    const mod = await import('../../src/manager/selfUpdate');
    expect(await mod.updateBlocker()).toBeNull();
    expect(await mod.isUpdateInProgress()).toBe(false);
    expect(h.sync).toEqual([]);
  });
  it('two update requests that cross the awaited checks start one update', async () => {
    vi.resetModules();
    let running = false;
    let runs = 0;
    vi.doMock('../../src/manager/selfUpdate', () => ({
      getManagerVersion: async () => ({}), isUpdateInProgress: async () => running, updateLaneBlocker: () => null, updateRunning: () => running,
      updateBlocker: async () => { await new Promise((r) => setImmediate(r)); return null; },
      runManagerUpdate: () => { running = true; runs++; return new Promise(() => {}); },
    }));
    const { createManagerRoutes } = await import('../../src/webui/routes/manager');
    vi.doUnmock('../../src/manager/selfUpdate');
    const router: any = createManagerRoutes({} as any);
    const layer = router.stack.find((l: any) => l.route?.path === '/update');
    const call = async () => {
      const res: any = { code: 200, status(c: number) { this.code = c; return this; }, json() { return this; } };
      await layer.route.stack[0].handle({}, res, () => {});
      return res.code;
    };
    const codes = await Promise.all([call(), call()]);
    expect(codes.sort()).toEqual([200, 409]);
    expect(runs).toBe(1);
  });
});
