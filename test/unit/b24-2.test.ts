import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The route reads the repo at /repo: the fake fs maps it to h.repo, and the fake
// git/docker CLIs act on it. `git pull` writes h.pulled into the Authelia config;
// the helper container runs its script through sh with a fake docker on PATH
// whose `restart` exits h.restartCode.
const h = vi.hoisted(() => ({ repo: '', bin: '', pulled: '', restartCode: 0, script: '', helperExit: -1, head: 'a'.repeat(40) }));

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
    if (cmd.startsWith('docker logs')) return 'helper output';
    if (cmd.includes('rev-parse HEAD')) return h.head;
    return '';
  };
  const spawn = (cmd: string, args: string[]) => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    if (cmd === 'git' && args.includes('pull')) {
      real.execFileSync(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1], process.argv[2])', path.join(h.repo, 'authelia', 'configuration.yml'), h.pulled]);
      h.head = 'b'.repeat(40);
    }
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  const spawnSync = (cmd: string, args: string[]) => {
    const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' });
    if (cmd !== 'docker') throw new Error(`unexpected ${cmd}`);
    if (args[0] === 'compose' && args.includes('--services')) return ok('manager\ncaddy\nauthelia\n');
    if (args[0] === 'image') return ok('sha256:new');
    if (args[0] === 'inspect' && args[1] === 'dbm-self-update') {
      if (h.helperExit < 0) {
        const env = { ...process.env, PATH: h.bin + path.delimiter + process.env.PATH, RESTART_CODE: String(h.restartCode) };
        h.helperExit = real.spawnSync('sh', ['-c', h.script.replace(/^sleep 2; /, '')], { env, encoding: 'utf-8' }).status ?? 99;
      }
      return ok(`exited ${h.helperExit}`);
    }
    if (args[0] === 'inspect') return ok('sha256:new');
    if (args[0] === 'run') { h.script = args[args.length - 1]; return ok('id'); }
    return ok('');
  };
  return { ...real, execSync, spawn, spawnSync };
});

import * as selfUpdate from '../../src/manager/selfUpdate';

const root = path.join(__dirname, '../..');
const mod = selfUpdate as any;
let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b24-2-'));
  h.repo = path.join(tmp, 'repo').replace(/\\/g, '/');
  fs.mkdirSync(path.join(h.repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(h.repo, 'authelia'));
  fs.writeFileSync(path.join(h.repo, 'authelia', 'configuration.yml'), 'a: 1\n');
  fs.writeFileSync(path.join(h.repo, 'authelia', 'users_database.yml'), 'users: {}\n');
  h.bin = path.join(tmp, 'bin');
  fs.mkdirSync(h.bin);
  fs.writeFileSync(path.join(h.bin, 'docker'), '#!/bin/sh\ncase "$*" in *restart*) exit "$RESTART_CODE";; esac\nexit 0\n');
  fs.chmodSync(path.join(h.bin, 'docker'), 0o755);
  h.pulled = 'a: 1\n';
  h.restartCode = 0;
  h.script = '';
  h.helperExit = -1;
  h.head = 'a'.repeat(40);
});

afterEach(() => {
  vi.useRealTimers();
  h.repo = '';
  fs.rmSync(tmp, { recursive: true, force: true });
});

type Line = [string, string | undefined];
async function update(): Promise<{ lines: Line[]; err: Error | null }> {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  const lines: Line[] = [];
  let err: Error | null = null;
  const done = selfUpdate.runManagerUpdate((m, l) => { lines.push([m, l]); }).catch((e) => { err = e; });
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(10000);
  await done;
  return { lines, err };
}

const warned = (lines: Line[]) => lines.some(([m, l]) => l === 'warning' && m.includes('restart authelia'));

describe('a manager update that changes Authelia config restarts Authelia', () => {
  it('the config hash changes when either Authelia file changes', () => {
    const dir = h.repo;
    const h0 = mod.autheliaConfigHash(dir);
    expect(mod.autheliaConfigHash(dir)).toBe(h0);
    fs.writeFileSync(path.join(dir, 'authelia', 'configuration.yml'), 'a: 2\n');
    const h1 = mod.autheliaConfigHash(dir);
    expect(h1).not.toBe(h0);
    fs.writeFileSync(path.join(dir, 'authelia', 'users_database.yml'), 'users: {x: 1}\n');
    expect(mod.autheliaConfigHash(dir)).not.toBe(h1);
  });

  it('a pull that changes the Authelia config restarts Authelia after the recreate and warns', async () => {
    h.pulled = 'a: 2\n';
    const { lines, err } = await update();
    expect(err).toBeNull();
    expect(h.script).toMatch(/up -d --remove-orphans && \{ docker compose -p 'dbm' -f 'docker-compose.remote.yml' restart authelia \|\| exit 3; \}$/);
    expect(warned(lines)).toBe(true);
    expect(lines.at(-1)).toEqual(['[Update] Applied without a manager restart.', 'success']);
  });

  it('a pull that leaves the Authelia config alone neither restarts it nor warns', async () => {
    const { lines, err } = await update();
    expect(err).toBeNull();
    expect(h.script).toContain('up -d --remove-orphans');
    expect(h.script).not.toContain('restart');
    expect(warned(lines)).toBe(false);
  });

  it('a failed Authelia restart is reported as that, with the restart command, not as a failed recreate', async () => {
    h.pulled = 'a: 2\n';
    h.restartCode = 1;
    const { err } = await update();
    expect(h.helperExit).toBe(3);
    expect(err).not.toBeNull();
    const msg = (err as unknown as Error).message;
    expect(msg).toContain('restarting Authelia failed');
    expect(msg).toContain('docker compose -f docker-compose.remote.yml restart authelia');
    expect(msg).not.toContain('did not take effect');
    expect(msg).not.toContain('up -d manager');
  });

  it('the README says when Authelia is restarted', () => {
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    expect(readme).not.toContain('so the auth layer is patched too');
    expect(readme).toMatch(/restart[s]? Authelia/i);
    const ps = fs.readFileSync(path.join(root, 'update.ps1'), 'utf8');
    expect(ps).toMatch(/restart authelia/);
  });
});

// update.sh needs bash, sha256sum and a POSIX PATH: Linux only.
describe.skipIf(process.platform === 'win32')('update.sh', () => {
  // child_process is mocked above; update.sh needs the real one.
  const run = async (changeConfig: boolean): Promise<string[]> => {
    const { spawnSync: realSpawnSync } = await vi.importActual<typeof import('child_process')>('child_process');
    const repo = path.join(tmp, 'clone');
    fs.mkdirSync(path.join(repo, 'authelia'), { recursive: true });
    fs.copyFileSync(path.join(root, 'update.sh'), path.join(repo, 'update.sh'));
    fs.writeFileSync(path.join(repo, 'docker-compose.remote.yml'), 'services: {}\n');
    fs.writeFileSync(path.join(repo, '.env'), 'PUBLIC_HOST=x\n');
    fs.writeFileSync(path.join(repo, 'authelia', 'configuration.yml'), 'a: 1\n');
    fs.writeFileSync(path.join(repo, 'authelia', 'users_database.yml'), 'users: {}\n');
    const log = path.join(tmp, 'sh-calls');
    fs.writeFileSync(log, '');
    fs.writeFileSync(path.join(h.bin, 'docker'), `#!/bin/sh\necho "docker $*" >> '${log}'\ncase "$*" in *--services*) printf 'manager\\nauthelia\\n';; esac\nexit 0\n`);
    fs.writeFileSync(path.join(h.bin, 'git'), `#!/bin/sh\ncase "$*" in *pull*) ${changeConfig ? "echo 'a: 2' > authelia/configuration.yml" : ':'};; *rev-parse*) echo abc;; esac\nexit 0\n`);
    fs.chmodSync(path.join(h.bin, 'git'), 0o755);
    const r = realSpawnSync('bash', [path.join(repo, 'update.sh')], { cwd: repo, env: { ...process.env, PATH: h.bin + ':' + process.env.PATH }, encoding: 'utf-8' });
    expect(r.status, r.stderr).toBe(0);
    return fs.readFileSync(log, 'utf8').split('\n');
  };

  it('restarts Authelia only when the pull changed its config', async () => {
    expect((await run(true)).some((l) => /compose .*restart authelia/.test(l))).toBe(true);
    fs.rmSync(path.join(tmp, 'clone'), { recursive: true, force: true });
    expect((await run(false)).some((l) => /restart authelia/.test(l))).toBe(false);
  });
});
