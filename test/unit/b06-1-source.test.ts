import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b06-1-source-'));
  process.env.DATA_DIR = dir;
  return {
    dir,
    git: [] as Array<{ method: string; args: unknown[]; env: Record<string, string | undefined> | null }>,
    spawns: [] as Array<{ cmd: string; args: string[]; env: Record<string, string | undefined> }>,
    spawnStderr: '',
    spawnCode: 0,
  };
});

// A fake git client: every call is recorded with the environment it carries,
// and a clone makes an empty repo at its target.
vi.mock('simple-git', async () => {
  const nodeFs = await import('fs');
  const nodePath = await import('path');
  const make = (repoPath?: string) => {
    let env: Record<string, string | undefined> | null = null;
    const client: any = {
      env: (e: Record<string, string>) => { env = e; return client; },
      clone: async (url: string, target: string, opts: string[]) => {
        h.git.push({ method: 'clone', args: [url, target, opts], env });
        nodeFs.mkdirSync(nodePath.join(target, '.git'), { recursive: true });
      },
      fetch: async () => { h.git.push({ method: 'fetch', args: [], env }); },
      status: async () => ({ behind: 0, ahead: 0, files: [] }),
      revparse: async () => 'main',
      log: async () => ({ latest: null }),
      raw: async () => '',
      repoPath,
    };
    return client;
  };
  return { default: make, simpleGit: make };
});

// A fake docker: spawn records argv and environment, then exits with
// h.spawnCode and h.spawnStderr.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const spawn = (cmd: string, args: string[], opts?: any) => {
    if (cmd !== 'docker') return real.spawn(cmd, args, opts);
    h.spawns.push({ cmd, args, env: (opts && opts.env) || {} });
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    setTimeout(() => {
      child.stdout.end();
      child.stderr.end(h.spawnStderr);
      setTimeout(() => child.emit('close', args[0] === 'run' ? h.spawnCode : 0), 1);
    }, 2);
    return child;
  };
  const execSync = () => { throw new Error('no buildx in the fake'); };
  return { ...real, spawn, execSync, default: { ...real, spawn, execSync } };
});

vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  getBot: (id: string) => ({ id, sourceType: 'git', status: 'stopped' }) as any,
}));
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'standalone',
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as sourceManager from '../../src/source/sourceManager';
import * as dockerClient from '../../src/docker/dockerClient';
import { probeDatabaseUrl } from '../../src/webui/dbProbe';

const TOKEN = 'Tok-Secret-0123456789';

beforeEach(() => {
  h.git.length = 0;
  h.spawns.length = 0;
  h.spawnStderr = '';
  h.spawnCode = 0;
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('a source with a credentialed URL', () => {
  it('clones a URL without the credential and hands it to git by environment', async () => {
    const url = `https://someone:${TOKEN}@example.invalid/owner/repo.git`;
    const source = await sourceManager.createSource({ url, branch: 'main' });
    const clone = h.git.find(c => c.method === 'clone')!;
    expect(String(clone.args[0])).toBe('https://example.invalid/owner/repo.git');
    expect(JSON.stringify(clone.args)).not.toContain(TOKEN);
    expect(clone.env?.GIT_CONFIG_COUNT).toBe('1');
    expect(clone.env?.GIT_CONFIG_KEY_0).toBe('http.https://example.invalid/.extraHeader');
    expect(clone.env?.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${Buffer.from(`someone:${TOKEN}`).toString('base64')}`);

    await sourceManager.fetchSource(source.id);
    const fetch = h.git.find(c => c.method === 'fetch')!;
    expect(fetch.env?.GIT_CONFIG_VALUE_0).toBe(clone.env?.GIT_CONFIG_VALUE_0);
  });

  it('clones a URL with no credential as it is, with no extra environment', async () => {
    await sourceManager.createSource({ url: 'https://example.invalid/owner/public.git', branch: 'main' });
    const clone = h.git.find(c => c.method === 'clone')!;
    expect(clone.args[0]).toBe('https://example.invalid/owner/public.git');
    expect(clone.env).toBeNull();
  });
});

describe('the image build log', () => {
  it('names each build arg without its value', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
    try {
      await dockerClient.buildImage('/ctx', 'img:1', undefined, { NPM_TOKEN: TOKEN, BUILD_MODE: 'managed' });
    } finally {
      spy.mockRestore();
    }
    const log = lines.find(l => l.includes('Building image'))!;
    expect(log).toContain('--build-arg NPM_TOKEN');
    expect(lines.join('\n')).not.toContain(TOKEN);
  });
});

describe('the database URL test', () => {
  it('gives psql the URL without its password and the password by environment', async () => {
    const res = await probeDatabaseUrl(`postgresql://smdb:${TOKEN}@db.invalid:5432/smdb?sslmode=no-verify`, 'smdb-net');
    expect(res.ok).toBe(true);
    const run = h.spawns.find(sp => sp.args[0] === 'run')!;
    expect(run.args.join(' ')).not.toContain(TOKEN);
    expect(run.args).toContain('postgresql://smdb@db.invalid:5432/smdb?sslmode=require');
    expect(run.args).toContain('PGPASSWORD');
    expect(run.env.PGPASSWORD).toBe(TOKEN);
  });

  it('the validate-db route gives psql no password in argv and the password by environment', async () => {
    const { createBotRoutes } = await import('../../src/webui/routes/bots');
    const router = createBotRoutes({ clients: new Set() } as any);
    const layer = (router as any).stack.find((l: any) => l.route?.path === '/:id/validate-db' && l.route.methods.post);
    const out = { status: 200, body: undefined as any };
    const res = { status(code: number) { out.status = code; return res; }, json(b: any) { out.body = b; return res; } };
    await layer.route.stack[layer.route.stack.length - 1].handle(
      { params: { id: 'b1' }, query: {}, body: { url: `postgresql://smdb:${TOKEN}@db.invalid:5432/smdb` } }, res);
    expect(out.body).toEqual({ success: true, ok: true });
    expect(h.spawns.map(sp => sp.args[0])).toEqual(['image', 'run']);
    expect(JSON.stringify(h.spawns.map(sp => sp.args))).not.toContain(TOKEN);
    expect(h.spawns[1].env.PGPASSWORD).toBe(TOKEN);
  });

  it('reports a failure with the password redacted', async () => {
    h.spawnCode = 2;
    h.spawnStderr = `psql: error: connection to server failed for postgresql://smdb:${TOKEN}@db.invalid:5432/smdb (password ${TOKEN})`;
    const res = await probeDatabaseUrl(`postgresql://smdb:${TOKEN}@db.invalid:5432/smdb`, null);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('connection to server failed');
    expect(res.error).not.toContain(TOKEN);
  });

  it('refuses a text it cannot read as a URL, and runs nothing', async () => {
    const res = await probeDatabaseUrl(`host=db.invalid password=${TOKEN}`, null);
    expect(res.ok).toBe(false);
    expect(h.spawns).toEqual([]);
  });
});

// Runs setup.sh's gen_hash under sh with a fake docker on PATH that runs the
// container script locally, where fake apk, argon2 and authelia log their argv.
describe('the setup admin password hash', () => {
  const sh = spawnSync('sh', ['-c', 'echo ok'], { encoding: 'utf8' });
  it.skipIf(sh.stdout?.trim() !== 'ok')('never puts the password in an argv', () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'b06-1-setup-'));
    try {
      const bin = path.join(work, 'bin');
      fs.mkdirSync(bin);
      const argvLog = path.join(work, 'argv.log');
      const fake = (name: string, body: string) => {
        fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nprintf '%s ' "${name}" "$@" >> "${argvLog.replace(/\\/g, '/')}"; echo >> "${argvLog.replace(/\\/g, '/')}"\n${body}\n`);
        fs.chmodSync(path.join(bin, name), 0o755);
      };
      // docker run -i --rm --entrypoint sh IMAGE -c SCRIPT: run SCRIPT here.
      fake('docker', 'while [ "$1" != "-c" ]; do shift; done; shift; exec sh -c "$1"');
      fake('apk', 'exit 0');
      fake('argon2', 'cat > /dev/null; echo \'$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA\'');
      fake('authelia', "echo 'Digest: $argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA'");
      const setup = fs.readFileSync(process.env.B06_SETUP || path.resolve(__dirname, '../../setup.sh'), 'utf8');
      const fn = /^gen_hash\(\) \{[\s\S]*?^\}/m.exec(setup)![0];
      const image = /^ARGON2_IMAGE=.*$/m.exec(setup)?.[0] || '';
      const script = `${image}\nAUTHELIA_IMAGE=fake/authelia:1\n${fn}\ngen_hash 'Admin-Secret-0123456789'\n`;
      const pathSep = process.platform === 'win32' ? ':' : path.delimiter;
      const binPath = process.platform === 'win32' ? `/${bin[0].toLowerCase()}${bin.slice(2).replace(/\\/g, '/')}` : bin;
      const run = spawnSync('sh', ['-c', `PATH="${binPath}${pathSep}$PATH"; ${script}`], { encoding: 'utf8' });
      expect(run.stdout.trim()).toBe('$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA');
      const argv = fs.readFileSync(argvLog, 'utf8');
      expect(argv).toContain('docker');
      expect(argv).not.toContain('Admin-Secret-0123456789');
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  // The argon2 CLI reads at most 128 bytes of password and then fails, so the
  // prompt must refuse such a password before hashing.
  it.skipIf(sh.stdout?.trim() !== 'ok')('asks again for a password of 128 bytes or more', () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'b06-1-prompt-'));
    try {
      const inputs = path.join(work, 'inputs');
      const long = 'x'.repeat(128);
      fs.writeFileSync(inputs, [long, long, 'short-pw', 'short-pw', ''].join('\n'));
      const setup = fs.readFileSync(process.env.B06_SETUP || path.resolve(__dirname, '../../setup.sh'), 'utf8');
      const loop = /^  while :; do\n    read_secret ADMIN_PW [\s\S]*?^  done$/m.exec(setup)![0];
      const script = 'exec 3< "$1"\n'
        + 'read_secret() { IFS= read -r v <&3 || exit 3; eval "$1=\\$v"; }\n'
        + 'warn() { printf "%s\\n" "$*" >&2; }\n'
        + loop + '\nprintf "%s" "$ADMIN_PW"\n';
      const run = spawnSync('sh', ['-c', script, 'sh', inputs.replace(/\\/g, '/')], { encoding: 'utf8' });
      expect(run.status).toBe(0);
      expect(run.stdout).toBe('short-pw');
      expect(run.stderr).toMatch(/under 128 bytes/);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});
