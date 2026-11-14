import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChildProcess, spawn, spawnSync, SpawnOptions } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { readContainers } from '../../src/cli/tui/api';
import { PASTE_OFF } from '../../src/cli/tui/codes';
import { shellHandOff } from '../../src/cli/tui/run';
import {
  dockerProgram, NO_DOCKER, runningContainers, runShell, SHELL_RETURN, SHELL_WRAP, shellBanner, shellCommand,
} from '../../src/cli/tui/shell';
import { fake, noAnswer, ok, refused } from './m2-fake';

vi.setConfig({ testTimeout: 20_000 });
const FAKE_DOCKER = path.join(__dirname, 'm6-docker.cjs');
const ARGS = ['exec', '-it', 'mybot-bot-1', '/bin/sh', '-c', SHELL_WRAP];

function fakeDocker(code: number) {
  const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'm6-report-')), 'args.json');
  return { env: { DBM_TUI_CHECK_DOCKER: JSON.stringify([process.execPath, FAKE_DOCKER, String(code), report]) }, report };
}
const readArgs = (report: string) => JSON.parse(fs.readFileSync(report, 'utf8')) as string[];

async function within<T>(p: Promise<T>, ms: number): Promise<T | 'pending'> {
  const end = Date.now() + ms;
  let done: { v: T } | null = null;
  void p.then((v) => (done = { v }));
  while (!done && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return done ? (done as { v: T }).v : 'pending';
}

describe('m6 shell: the command', () => {
  it('is docker exec -it <container> /bin/sh -c with the page wrapper and no stty line', () => {
    expect(shellCommand('mybot-bot-1', {})).toEqual({ program: 'docker', args: ARGS });
    expect(SHELL_WRAP).toBe('if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi');
    expect(SHELL_WRAP).not.toContain('stty');
  });

  it('DBM_TUI_CHECK_DOCKER names a stand-in as a JSON list; anything else is refused', () => {
    expect(dockerProgram({ DBM_TUI_CHECK_DOCKER: JSON.stringify(['node', 'd.cjs']) })).toEqual({ program: 'node', args: ['d.cjs'] });
    expect(shellCommand('c', { DBM_TUI_CHECK_DOCKER: JSON.stringify(['node', 'd.cjs']) }).args).toEqual(['d.cjs', 'exec', '-it', 'c', '/bin/sh', '-c', SHELL_WRAP]);
    expect(() => dockerProgram({ DBM_TUI_CHECK_DOCKER: '"docker"' })).toThrow('DBM_TUI_CHECK_DOCKER must be a JSON list of strings');
    expect(() => dockerProgram({ DBM_TUI_CHECK_DOCKER: '[]' })).toThrow('DBM_TUI_CHECK_DOCKER must be a JSON list of strings');
  });

  // A POSIX sh runs the wrapper in a folder whose only programs are stubs; on Windows Git's sh.exe does, when Git is installed.
  function findSh(): string | null {
    if (process.platform !== 'win32') return fs.existsSync('/bin/sh') ? '/bin/sh' : null;
    const r = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    const sh = path.resolve(r.stdout.trim(), '..', '..', '..', 'usr', 'bin', 'sh.exe');
    return fs.existsSync(sh) ? sh : null;
  }
  const sh = findSh();

  it.skipIf(!sh)('the wrapper runs bash when the container has it, and sh when it does not', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm6-wrap-'));
    const stub = (name: string) => {
      fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho picked-${name}\n`);
      fs.chmodSync(path.join(dir, name), 0o755);
    };
    const run = () => spawnSync(sh!, ['-c', `cd "$1" && PATH=. && ${SHELL_WRAP}`, 'm6', dir.replace(/\\/g, '/')], { encoding: 'utf8', timeout: 10_000 });
    stub('bash');
    stub('sh');
    expect(run().stdout.trim()).toBe('picked-bash');
    fs.unlinkSync(path.join(dir, 'bash'));
    expect(run().stdout.trim()).toBe('picked-sh');
  });
});

describe('m6 shell: the banner', () => {
  it('names the container, the volume note and exit, and wraps at 80 columns without cutting', () => {
    const banner = shellBanner('mybot-bot-1', 80);
    expect(banner).toBe('Shell in mybot-bot-1.\nChanges to files outside mounted volumes are lost on rebuild.\nType exit to return to Bot Manager.\n\n');
    const long = 'a-very-long-compose-project-name-for-a-bot-with-many-words-bot-1';
    for (const cols of [80, 40]) {
      const lines = shellBanner(long, cols).split('\n').filter(Boolean);
      for (const l of lines) expect(l.length).toBeLessThan(cols);
      expect(lines.join('').replace(/\s+/g, '')).toBe(`Shell in ${long}. Changes to files outside mounted volumes are lost on rebuild. Type exit to return to Bot Manager.`.replace(/\s+/g, ''));
    }
  });
});

describe('m6 shell: runShell', () => {
  it('exit 0 returns to the frame at once with no notice, after running the command line', async () => {
    const { env, report } = fakeDocker(0);
    const out: string[] = [];
    const input = new PassThrough();
    expect(await runShell('mybot-bot-1', { env, input, write: (t) => out.push(t) })).toBeUndefined();
    expect(readArgs(report)).toEqual(ARGS);
    expect(out).toEqual([]);
  });

  it('a non-zero exit asks for Enter, waits for it, then names the code', async () => {
    const { env } = fakeDocker(3);
    const out: string[] = [];
    const input = new PassThrough();
    const p = runShell('mybot-bot-1', { env, input, write: (t) => out.push(t) });
    const end = Date.now() + 10_000;
    while (!out.join('').includes(SHELL_RETURN) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    expect(out.join('')).toBe(`\n${SHELL_RETURN}\n`);
    input.write('abc');
    expect(await within(p, 300)).toBe('pending');
    input.write('\r');
    expect(await within(p, 10_000)).toBe('The shell in mybot-bot-1 ended with exit code 3.');
  });

  it('a missing docker program gives the ENOENT text and no Enter wait', async () => {
    const missing = path.join(os.tmpdir(), 'm6-no-such-dir', 'docker');
    const out: string[] = [];
    const r = await runShell('mybot-bot-1', { env: { DBM_TUI_CHECK_DOCKER: JSON.stringify([missing]) }, input: new PassThrough(), write: (t) => out.push(t) });
    expect(r).toBe(NO_DOCKER);
    expect(NO_DOCKER).toBe('The docker command is not available where this terminal runs, so it cannot open a shell in a bot container.');
    expect(out).toEqual([]);
  });

  it('a bad check value is a notice, and nothing is started', async () => {
    const started = vi.fn();
    const r = await runShell('c', { env: { DBM_TUI_CHECK_DOCKER: 'docker' }, spawn: started as never, input: new PassThrough() });
    expect(r).toBe('Could not open a shell in c: DBM_TUI_CHECK_DOCKER must be a JSON list of strings');
    expect(started).not.toHaveBeenCalled();
  });
});

describe('m6 shell: the hand-off', () => {
  afterEach(() => vi.restoreAllMocks());

  it('turns bracketed paste off and writes the banner before docker starts, then enters the frame again', async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as never);
    const { env } = fakeDocker(0);
    let atSpawn = -1;
    const spawnSpy = (program: string, args: string[], options: SpawnOptions): ChildProcess => {
      atSpawn = writes.length;
      return spawn(program, args, { ...options, stdio: 'ignore' });
    };
    const notice = await shellHandOff('mybot-bot-1', { enter: '<enter>', leave: '<leave>' }, { env, spawn: spawnSpy, input: new PassThrough() });
    expect(notice).toBeUndefined();
    expect(writes[0]).toBe(PASTE_OFF);
    expect(atSpawn).toBe(2);
    expect(writes[1]).toContain('<leave>');
    expect(writes[1]).toContain('Shell in mybot-bot-1.');
    expect(writes.at(-1)).toBe('<enter>');
  });
});

describe('m6 shell: the containers read', () => {
  // GET /api/bots/:id/containers (bots.ts:928 to :945), rows from listProjectContainers (dockerClient.ts:791).
  const path1 = '/api/bots/b1/containers';
  const rows = [{ name: 'mybot-bot-1', state: 'running', status: 'Up 2 hours' }, { name: 'mybot-db-1', state: 'exited', status: 'Exited (0) 1 hour ago' }];

  it('success gives the rows; the running ones are those the page keeps', async () => {
    const f = fake().on('GET', path1, ok({ success: true, containers: rows, appName: 'mybot' }));
    const r = await readContainers(f.client, 'b1', 1000);
    expect(r).toEqual({ ok: true, value: rows });
    expect(runningContainers(rows).map((c) => c.name)).toEqual(['mybot-bot-1']);
  });

  it("a refusal gives the route's text (bots.ts:939, :931, :943)", async () => {
    const f = fake().on('GET', path1, refused(503, { success: false, error: 'Docker did not answer, so the containers of this bot could not be listed' }));
    expect(await readContainers(f.client, 'b1', 1000)).toEqual({ ok: false, text: 'Docker did not answer, so the containers of this bot could not be listed' });
  });

  it('a body that is not a JSON object, no answer and the time limit are no answer', async () => {
    const f = fake().on('GET', path1, { status: 502, ok: false, body: '<html>' });
    expect(await readContainers(f.client, 'b1', 1000)).toEqual({ ok: null, text: 'the reply was not JSON, HTTP 502' });
    const g = fake().on('GET', path1, noAnswer());
    expect(await readContainers(g.client, 'b1', 1000)).toEqual({ ok: null, text: 'connect ECONNREFUSED 127.0.0.1:8080' });
    const h = fake().on('GET', path1, () => new Promise(() => {}));
    expect(await readContainers(h.client, 'b1', 100)).toEqual({ ok: null, text: 'the manager did not answer within 100 ms' });
  });
});
