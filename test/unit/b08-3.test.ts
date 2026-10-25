import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A fake git and docker: h.oldHead/h.newHead are HEAD before and after the pull,
// h.stack lists the running containers (service, config hash, image id, image ref,
// running), h.want the declared config hashes, and h.helper the helper's status.
const h = vi.hoisted(() => ({
  repo: '', head: '', newHead: '', fetchFails: false, calls: [] as string[][],
  want: '' as string, stack: [] as string[], imageIds: {} as Record<string, string>,
  helper: '' as string, helperExit: 0, build: true as boolean, hashArgs: [] as string[], runningImage: '', helperErr: '',
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
    if (cmd.startsWith('docker inspect')) return JSON.stringify([{ Config: { Labels: labels, Image: 'dbm-manager' } }]);
    if (cmd.startsWith('docker logs')) return 'Container dbm-caddy Recreate';
    if (cmd.includes('rev-parse HEAD')) return h.head;
    return '';
  };
  const execFile = (_cmd: string, args: string[], _opts: unknown, cb: (e: unknown, r?: unknown) => void) => {
    if (args.includes('fetch') && h.fetchFails) {
      const err: any = new Error('Command failed: git fetch');
      err.stderr = 'fatal: unable to access the remote: Could not resolve host\n';
      setImmediate(() => cb(err));
      return;
    }
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
  const spawnSync = (cmd: string, args: string[]) => {
    h.calls.push([cmd, ...args]);
    const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' });
    const no = { status: 1, stdout: '', stderr: 'No such object' };
    if (cmd !== 'docker') throw new Error(`unexpected ${cmd}`);
    if (args[0] === 'compose' && args.includes('--services')) return ok('manager\ncaddy\n');
    // Compose hashes binds as resolved; only the host's project dir reproduces
    // the hashes the running containers carry.
    if (args[0] === 'compose' && args.includes('--hash')) {
      const at = (f: string) => args[args.indexOf(f) + 1];
      const hostHash = at('--project-directory') === '/srv/dbm' && at('-f') === '/repo/docker-compose.remote.yml';
      h.hashArgs = args;
      return ok(hostHash ? h.want : h.want.replace(/ h/g, ' in-container-'));
    }
    if (args[0] === 'compose' && args.includes('json')) {
      return ok(JSON.stringify({ services: { manager: h.build ? { build: { context: '.' }, image: 'dbm-manager' } : { image: 'ghcr.io/x/dbm:latest' } } }));
    }
    if (args[0] === 'compose' && args.includes('ps')) return ok(h.stack.map((_, i) => `c${i}`).join('\n'));
    if (args[0] === 'container' && args[1] === 'inspect') {
      if (h.helperErr) return { status: 1, stdout: '', stderr: h.helperErr };
      if (!h.helper) return no;
      return ok(args.some((a) => a.includes('ExitCode')) ? `${h.helper} ${h.helperExit}` : h.helper);
    }
    if (args[0] === 'image') return ok(h.imageIds[args[2]] || 'sha256:none');
    if (args[0] === 'inspect' && args[1] === 'dbm-self-update') return ok(`${h.helper || 'exited'} ${h.helperExit}`);
    if (args[0] === 'inspect' && /^c\d+$/.test(args[1])) return ok(h.stack[Number(args[1].slice(1))]);
    if (args[0] === 'inspect') return ok(h.runningImage || h.imageIds['dbm-manager']);
    if (args[0] === 'run') return ok('id');
    return ok('');
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b08-3-'));
  h.repo = path.join(tmp, 'repo').replace(/\\/g, '/');
  fs.mkdirSync(path.join(h.repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(h.repo, 'authelia'));
  process.env.DATA_DIR = path.join(tmp, 'data');
  process.env.MANAGER_BUILD_COMMIT = A;
  h.head = A;
  h.newHead = A;
  h.fetchFails = false;
  h.calls = [];
  h.want = 'manager h1\ncaddy h2\n';
  h.stack = ['manager h1 sha256:m dbm-manager true', 'caddy h2 sha256:c caddy:2 true'];
  h.imageIds = { 'dbm-manager': 'sha256:m', 'caddy:2': 'sha256:c' };
  h.helper = '';
  h.helperExit = 0;
  h.build = true;
  h.hashArgs = [];
  h.runningImage = '';
  h.helperErr = '';
});

afterEach(() => {
  vi.useRealTimers();
  h.repo = '';
  delete process.env.DATA_DIR;
  delete process.env.MANAGER_BUILD_COMMIT;
  fs.rmSync(tmp, { recursive: true, force: true });
});

type Line = [string, string | undefined];
async function update(mod: Awaited<ReturnType<typeof load>>) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
  const lines: Line[] = [];
  let err: Error | null = null;
  let outcome: unknown = null;
  const done = mod.runManagerUpdate((m, l) => { lines.push([m, l]); }).then((o) => { outcome = o; }, (e) => { err = e; });
  for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(10000);
  await done;
  return { lines, err: err as Error | null, outcome: outcome as { state: string; message: string } | null };
}

const launched = () => h.calls.some((c) => c[1] === 'run');

describe('the version answer says what it could check', () => {
  it('a failed git fetch answers checked:false with the reason', async () => {
    h.fetchFails = true;
    const v = await (await load()).getManagerVersion();
    expect(v.checked).toBe(false);
    expect(v.fetchError).toContain('Could not resolve host');
  });

  it('a fetch that works answers checked:true', async () => {
    const v = await (await load()).getManagerVersion();
    expect(v.checked).toBe(true);
    expect(v.stamped).toBe(true);
    expect(v.updateInProgress).toBe(false);
  });

  it('a stack service on an older config reads as an update to apply', async () => {
    h.stack[1] = 'caddy h-old sha256:c caddy:2 true';
    const v = await (await load()).getManagerVersion();
    expect(v.stackPending).toBe(true);
    expect(v.updateAvailable).toBe(true);
  });

  it('an unstamped build says so', async () => {
    process.env.MANAGER_BUILD_COMMIT = '';
    const v = await (await load()).getManagerVersion();
    expect(v.stamped).toBe(false);
  });

  it('a manager service with no build section answers supported:false', async () => {
    h.build = false;
    const mod = await load();
    expect(mod.updateBlocker()).toContain('pulled image (dbm-manager)');
    const v = await mod.getManagerVersion();
    expect(v.supported).toBe(false);
  });
});

describe('nothing to apply is decided from the whole stack', () => {
  it('an unchanged HEAD with an older Caddy config still recreates the stack', async () => {
    h.stack[1] = 'caddy h-old sha256:c caddy:2 true';
    const { lines } = await update(await load());
    expect(launched()).toBe(true);
    expect(lines.some(([m]) => /up to date/i.test(m))).toBe(false);
  });

  it('a stopped service is not up to date', async () => {
    h.stack[1] = 'caddy h2 sha256:c caddy:2 false';
    await update(await load());
    expect(launched()).toBe(true);
  });

  it('a stack that matches and runs HEAD is a no-op and says what was compared', async () => {
    const { outcome } = await update(await load());
    expect(launched()).toBe(false);
    expect(outcome?.state).toBe('noop');
    expect(outcome?.message).toContain('every service in the stack');
  });

  it('a no-op whose build stamp is not HEAD says nothing was rebuilt', async () => {
    process.env.MANAGER_BUILD_COMMIT = B;
    const { err } = await update(await load());
    expect(launched()).toBe(false);
    expect(err?.message).toContain('Nothing was rebuilt: this stack runs a pulled image (dbm-manager)');
  });

  it('the hint names the whole stack, not one service', async () => {
    h.newHead = B;
    h.helperExit = 1;
    const { err } = await update(await load());
    expect(err?.message).toMatch(/docker compose -f docker-compose\.remote\.yml up -d$/);
  });
});

describe('the recreate helper', () => {
  it('a running helper refuses a new update and is never removed', async () => {
    h.helper = 'running';
    h.newHead = B;
    const mod = await load();
    expect(mod.isUpdateInProgress()).toBe(true);
    const { err } = await update(mod);
    expect(err?.message).toContain('still running');
    expect(h.calls.some((c) => c[1] === 'rm')).toBe(false);
    expect(launched()).toBe(false);
  });

  it('a helper still running at the deadline is reported as running, not as failed', async () => {
    h.newHead = B;
    const mod = await load();
    const orig = h.calls;
    // The helper starts running once launched.
    const realPush = orig.push.bind(orig);
    h.calls.push = (...items: string[][]) => { for (const c of items) if (c[1] === 'run') h.helper = 'running'; return realPush(...items); };
    const { err, outcome } = await update(mod);
    expect(err).toBeNull();
    expect(outcome?.state).toBe('pending');
    expect(outcome?.message).toContain('The recreate is still running (Container dbm-caddy Recreate)');
    expect(mod.readLastUpdate()?.state).toBe('pending');
  });
});

describe('the outcome of an update survives the restart', () => {
  const recorded = (state: string, target: string) => {
    fs.mkdirSync(process.env.DATA_DIR as string, { recursive: true });
    fs.writeFileSync(path.join(process.env.DATA_DIR as string, 'manager-update.json'),
      JSON.stringify({ opId: 'op1', state, target, at: '2026-10-24T00:00:00Z', bootId: 'earlier-process' }));
  };

  it('the target is recorded before the recreate', async () => {
    h.newHead = B;
    const mod = await load();
    const targets: string[] = [];
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const p = mod.runManagerUpdate(() => {}, (t) => { targets.push(t); expect(mod.readLastUpdate()).toMatchObject({ state: 'restarting', target: B }); }).catch(() => {});
    for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(10000);
    await p;
    expect(targets).toEqual([B]);
  });

  it('a restarted manager whose stamp equals the target reads applied', async () => {
    recorded('restarting', B);
    process.env.MANAGER_BUILD_COMMIT = B;
    expect((await load()).readLastUpdate()?.state).toBe('applied');
  });

  it('a restarted manager on another commit reads not-applied', async () => {
    recorded('restarting', B);
    expect((await load()).readLastUpdate()).toMatchObject({ state: 'not-applied' });
  });

  it('a restarted unstamped manager reads unknown, never applied', async () => {
    recorded('restarting', B);
    process.env.MANAGER_BUILD_COMMIT = '';
    const lu = (await load()).readLastUpdate();
    expect(lu?.state).toBe('unstamped');
    expect(lu?.message).toContain('whether the update applied is unknown');
  });

  it('the version answer carries the last update', async () => {
    recorded('restarting', B);
    process.env.MANAGER_BUILD_COMMIT = B;
    const v = await (await load()).getManagerVersion();
    expect(v.lastUpdate).toMatchObject({ opId: 'op1', state: 'applied' });
  });
});

describe('the stack hashes are computed the way the host computes them', () => {
  it('config --hash resolves binds against the host project directory', async () => {
    const v = await (await load()).getManagerVersion();
    expect(h.hashArgs).toEqual(expect.arrayContaining(['--project-directory', '/srv/dbm', '-f', '/repo/docker-compose.remote.yml']));
    expect(v.stackPending).toBe(false);
    expect(v.updateAvailable).toBe(false);
  });

  it('the repo .env is passed as the env file when it exists', async () => {
    fs.writeFileSync(path.join(h.repo, '.env'), 'X=1\n');
    await (await load()).getManagerVersion();
    const i = h.hashArgs.indexOf('--env-file');
    expect(h.hashArgs[i + 1]).toBe('/repo/.env');
  });
});

describe('a recreate still running at the deadline is judged when its helper exits', () => {
  const pendingUpdate = async () => {
    h.newHead = B;
    const mod = await load();
    const realPush = h.calls.push.bind(h.calls);
    h.calls.push = (...items: string[][]) => { for (const c of items) if (c[1] === 'run') h.helper = 'running'; return realPush(...items); };
    const { outcome } = await update(mod);
    expect(outcome?.state).toBe('pending');
    return mod;
  };
  const stored = () => JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR as string, 'manager-update.json'), 'utf8'));

  it('a helper still running keeps the update pending', async () => {
    const mod = await pendingUpdate();
    expect(mod.readLastUpdate()?.state).toBe('pending');
  });

  it('a helper that exits non-zero reads failed with the whole-stack hint, and the judgement is kept', async () => {
    const mod = await pendingUpdate();
    h.helper = 'exited';
    h.helperExit = 1;
    const lu = mod.readLastUpdate();
    expect(lu?.state).toBe('failed');
    expect(lu?.message).toContain('docker compose -f docker-compose.remote.yml up -d');
    expect(stored().state).toBe('failed');
  });

  it('a helper that exits 0 with the target image running reads applied', async () => {
    const mod = await pendingUpdate();
    h.helper = 'exited';
    expect(mod.readLastUpdate()).toMatchObject({ state: 'applied' });
    expect(stored().state).toBe('applied');
  });

  it('a helper that exits 0 while an older image runs reads failed', async () => {
    const mod = await pendingUpdate();
    h.helper = 'exited';
    h.runningImage = 'sha256:old';
    expect(mod.readLastUpdate()?.state).toBe('failed');
  });

  it('an inspect error other than a missing helper keeps the update pending and records nothing', async () => {
    const mod = await pendingUpdate();
    h.helperErr = 'error during connect: context deadline exceeded';
    expect(mod.readLastUpdate()?.state).toBe('pending');
    expect(stored().state).toBe('pending');
    h.helperErr = '';
    h.helper = 'exited';
    expect(mod.readLastUpdate()?.state).toBe('applied');
  });

  it('a helper confirmed missing reads unknown', async () => {
    const mod = await pendingUpdate();
    h.helperErr = 'Error response from daemon: No such container: dbm-self-update';
    expect(mod.readLastUpdate()?.state).toBe('unknown');
    expect(stored().state).toBe('unknown');
  });
});

describe('a restarted manager also reads the helper', () => {
  const recorded = (state: string, target: string) => {
    fs.mkdirSync(process.env.DATA_DIR as string, { recursive: true });
    fs.writeFileSync(path.join(process.env.DATA_DIR as string, 'manager-update.json'),
      JSON.stringify({ opId: 'op1', state, target, at: '2026-10-24T00:00:00Z', bootId: 'earlier-process', composeFile: 'docker-compose.remote.yml' }));
  };

  it('an Authelia restart that failed (exit 3) is a failure, though the stamp equals the target', async () => {
    recorded('restarting', B);
    process.env.MANAGER_BUILD_COMMIT = B;
    h.helper = 'exited';
    h.helperExit = 3;
    const lu = (await load()).readLastUpdate();
    expect(lu?.state).toBe('failed');
    expect(lu?.message).toContain('docker compose -f docker-compose.remote.yml restart authelia');
  });

  it('a compose failure on a later service is a failure with the logs and the up hint', async () => {
    recorded('restarting', B);
    process.env.MANAGER_BUILD_COMMIT = B;
    h.helper = 'exited';
    h.helperExit = 1;
    const lu = (await load()).readLastUpdate();
    expect(lu?.state).toBe('failed');
    expect(lu?.message).toContain('Container dbm-caddy Recreate');
    expect(lu?.message).toContain('up -d');
  });

  it('a helper still running keeps the update pending', async () => {
    recorded('restarting', B);
    process.env.MANAGER_BUILD_COMMIT = B;
    h.helper = 'running';
    expect((await load()).readLastUpdate()?.state).toBe('pending');
  });

  it('a helper that exited 0 leaves the judgement to the build stamp', async () => {
    recorded('restarting', B);
    process.env.MANAGER_BUILD_COMMIT = B;
    h.helper = 'exited';
    expect((await load()).readLastUpdate()?.state).toBe('applied');
  });
});

describe('the update route', () => {
  const route = async (stub: Record<string, unknown>) => {
    vi.resetModules();
    const events: [string, any][] = [];
    vi.doMock('../../src/webui/server', () => ({ broadcastToClients: (_w: unknown, type: string, data: unknown) => events.push([type, data]) }));
    vi.doMock('../../src/manager/selfUpdate', () => ({
      getManagerVersion: async () => ({}), isUpdateInProgress: () => false, updateBlocker: () => null, updateLaneBlocker: () => null,
      runManagerUpdate: async () => ({ state: 'noop', message: 'nothing' }), ...stub,
    }));
    const { createManagerRoutes } = await import('../../src/webui/routes/manager');
    const router: any = createManagerRoutes({} as any);
    const layer = router.stack.find((l: any) => l.route?.path === '/update');
    const res: any = { code: 200, body: null, status(c: number) { this.code = c; return this; }, json(b: unknown) { this.body = b; return this; } };
    await layer.route.stack[0].handle({}, res, () => {});
    await new Promise((r) => setImmediate(r));
    vi.doUnmock('../../src/webui/server');
    vi.doUnmock('../../src/manager/selfUpdate');
    return { res, events };
  };

  it('a running update answers 409 inProgress', async () => {
    const { res } = await route({ isUpdateInProgress: () => true });
    expect(res.code).toBe(409);
    expect(res.body).toMatchObject({ success: false, inProgress: true });
  });

  it('a blocker answers 400 with its reason before anything starts', async () => {
    let ran = false;
    const { res } = await route({ updateBlocker: () => 'no build section', runManagerUpdate: async () => { ran = true; return { state: 'noop', message: '' }; } });
    expect(res.code).toBe(400);
    expect(res.body.error).toBe('no build section');
    expect(ran).toBe(false);
  });

  it('every event carries the answered opId', async () => {
    const { res, events } = await route({});
    expect(typeof res.body.opId).toBe('string');
    expect(events.map(([t]) => t)).toEqual(['manager:update-started', 'manager:update-complete']);
    for (const [, d] of events) expect(d.opId).toBe(res.body.opId);
    expect(events[1][1].state).toBe('noop');
  });
});

describe('dbm manager update --wait', () => {
  class Exit extends Error { constructor(public code: number) { super(`exit ${code}`); } }
  type Ws = { onMessage: (m: { type: string; data: unknown }) => void; onOpen?: () => void; onClose?: (r: string) => void };
  const run = async (opts: { versions: unknown[]; open: boolean; dropAfterPost?: boolean; postHangs?: boolean; pending?: boolean }) => {
    const posts: string[] = [];
    const out: string[] = [];
    let ws: Ws | null = null;
    const versions = [...opts.versions];
    const client = {
      request: async (method: string, p: string) => {
        if (method === 'POST') {
          posts.push(p);
          if (opts.postHangs) return new Promise(() => {});
          return { ok: true, status: 200, body: { success: true, opId: 'op1' } };
        }
        const body = versions.length > 1 ? versions.shift() : versions[0];
        return { ok: true, status: 200, body };
      },
      openWs: (onMessage: Ws['onMessage'], onOpen?: () => void, onClose?: (r: string) => void) => {
        ws = { onMessage, onOpen, onClose };
        if (!opts.open) onClose?.('connect ECONNREFUSED');
        return { close: () => {} };
      },
    };
    const exit = vi.spyOn(process, 'exit').mockImplementation(((c: number) => { throw new Exit(c); }) as any);
    const wout = vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out.push(s); return true; }) as any);
    const werr = vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => { out.push(s); return true; }) as any);
    try {
      vi.resetModules();
      const { managerUpdate } = await import('../../src/cli/commands');
      const p = managerUpdate({ client: client as any, args: [], flags: { wait: true, timeout: '5' } }, 1);
      if (opts.open) {
        await new Promise((r) => setImmediate(r));
        (ws as Ws | null)?.onOpen?.();
        await new Promise((r) => setTimeout(r, 5));
        if (opts.pending) (ws as Ws | null)?.onMessage({ type: 'manager:update-pending', data: { opId: 'op1', state: 'pending' } });
        if (opts.dropAfterPost || opts.postHangs) {
          // A real exit ends the process inside the ws close handler.
          try { (ws as Ws | null)?.onClose?.('closed (code 1006)'); } catch (e) {
            if (!(e instanceof Exit)) throw e;
            p.catch(() => {});
            return { code: e.code, posts, out: out.join('') };
          }
        }
      }
      let code = -1;
      try { await p; } catch (e) { if (e instanceof Exit) code = e.code; else throw e; }
      return { code, posts, out: out.join('') };
    } finally {
      exit.mockRestore();
      wout.mockRestore();
      werr.mockRestore();
    }
  };

  it('a drop, a new bootId and lastUpdate applied exit 0', async () => {
    const r = await run({ open: true, dropAfterPost: true, versions: [{ bootId: 'b1' }, { bootId: 'b2', lastUpdate: { opId: 'op1', state: 'applied', message: 'Updated' } }] });
    expect(r.code).toBe(0);
    expect(r.posts).toEqual(['/api/manager/update']);
  });

  it('a new bootId whose lastUpdate is not-applied exits 1', async () => {
    const r = await run({ open: true, dropAfterPost: true, versions: [{ bootId: 'b1' }, { bootId: 'b2', lastUpdate: { opId: 'op1', state: 'not-applied' } }] });
    expect(r.code).toBe(1);
  });

  it('update-pending, then a same-bootId lastUpdate failed, exits 1', async () => {
    const r = await run({ open: true, pending: true, versions: [{ bootId: 'b1' }, { bootId: 'b1', lastUpdate: { opId: 'op1', state: 'failed', message: 'recreate failed' } }] });
    expect(r.code).toBe(1);
    expect(r.out).toContain('manager:failed');
  });

  it('update-pending, then a same-bootId lastUpdate applied, exits 0', async () => {
    const r = await run({ open: true, pending: true, versions: [{ bootId: 'b1' }, { bootId: 'b1', lastUpdate: { opId: 'op1', state: 'applied' } }] });
    expect(r.code).toBe(0);
  });

  it('update-pending, then a same-bootId lastUpdate unknown, exits 1', async () => {
    const r = await run({ open: true, pending: true, versions: [{ bootId: 'b1' }, { bootId: 'b1', lastUpdate: { opId: 'op1', state: 'unknown' } }] });
    expect(r.code).toBe(1);
  });

  it('an event stream that never opens sends no POST and says no update was started', async () => {
    const r = await run({ open: false, versions: [{ bootId: 'b1' }] });
    expect(r.posts).toEqual([]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('no update was started');
    expect(r.out).not.toContain('timeout');
  });

  it('a drop while the POST is unanswered says the start cannot be confirmed', async () => {
    const r = await run({ open: true, postHangs: true, versions: [{ bootId: 'b1' }] });
    expect(r.code).toBe(1);
    expect(r.out).toContain('cannot be confirmed');
  });
});

describe('the page finishes a reconnect from lastUpdate', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../src/webui/public/index.html'), 'utf8');
  const pageFunction = (name: string): string => {
    let start = html.indexOf(`function ${name}(`);
    if (html.slice(start - 6, start) === 'async ') start -= 6;
    let i = html.indexOf('{', html.indexOf(')', start));
    for (let depth = 0; ; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
    }
  };
  const page = (version: unknown) => {
    const els: Record<string, any> = {};
    const el = () => ({ textContent: '', disabled: false, classList: { add() {}, remove() {}, contains: () => true } });
    for (const id of ['manager-update-log', 'manager-update-title', 'manager-update-close', 'manager-updating-pill', 'manager-update-reload']) els[id] = el();
    const toasts: string[] = [];
    const ctx = vm.createContext({
      managerUpdating: true, managerUpdatePoll: null, managerUpdateBaseline: { bootId: '1', opId: 'op1' },
      api: async () => version, showMessage: (_t: string, m: string) => toasts.push(m), clearInterval: () => {},
      reloadWhenSafe: () => {}, document: { getElementById: (id: string) => els[id] || null },
    });
    vm.runInContext(['appendManagerLog', 'finishManagerUpdate', 'finishFromLastUpdate', 'resolveManagerReconnect'].map(pageFunction).join('\n'), ctx);
    return { ctx, els, toasts };
  };
  const after = async (version: unknown) => {
    const p = page(version);
    await p.ctx.resolveManagerReconnect(true);
    return { updating: vm.runInContext('managerUpdating', p.ctx), title: p.els['manager-update-title'].textContent, toasts: p.toasts };
  };

  it('a new bootId with the target applied reads updated', async () => {
    const r = await after({ success: true, bootId: '2', lastUpdate: { opId: 'op1', state: 'applied', message: 'Updated' } });
    expect(r.title).toBe('Bot Manager updated');
  });

  it('a new bootId on another commit reads did not apply', async () => {
    const r = await after({ success: true, bootId: '2', lastUpdate: { opId: 'op1', state: 'not-applied', message: 'x' } });
    expect(r.title).toBe('Update did not apply');
  });

  it('a new bootId whose recreate is still running keeps following it', async () => {
    const r = await after({ success: true, bootId: '2', lastUpdate: { opId: 'op1', state: 'pending' } });
    expect(r.updating).toBe(true);
    expect(r.toasts).toEqual([]);
  });

  it('an outcome that cannot be confirmed is never titled a failure', async () => {
    const r = await after({ success: true, bootId: '1', updateInProgress: false, lastUpdate: { opId: 'op1', state: 'unknown', message: 'x' } });
    expect(r.title).toBe('Update outcome unknown');
  });
});
