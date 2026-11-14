import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';

// Each row runs dbm.sh or dbm.ps1 with a stand-in `docker` first on PATH that prints its arguments and exits 4. Folders
// that hold a real docker are left out of PATH, so a row can never reach it.
//
// Where the rows run:
// - dbm.sh piped: wherever bash is (Linux; Windows with Git for Windows, whose bash.exe is used so that WSL's is not).
// - dbm.ps1 piped: wherever powershell.exe (Windows) or pwsh is.
// - As a terminal: under node-pty from the terminal check's install (../tui-check), else under util-linux `script` on
//   Linux. On Windows ConPTY sits between the wrapper and the row and keeps the alternate screen to itself, so there the
//   rows see 2004 off but cannot see 1049; on Linux the rows see all three sequences in order.

vi.setConfig({ testTimeout: 30_000 });
const repo = path.resolve(__dirname, '..', '..');
const DBM_SH = path.join(repo, 'dbm.sh').replace(/\\/g, '/');
const DBM_PS1 = path.join(repo, 'dbm.ps1');
const RESET = '\x1b[?2004l\x1b[?25h\x1b[?1049l';
const win = process.platform === 'win32';

function gitRoot(): string | null {
  const r = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  return r.status === 0 ? path.resolve(r.stdout.trim(), '..', '..', '..') : null;
}

function findBash(): string | null {
  if (win) {
    const root = gitRoot();
    const bash = root ? path.join(root, 'usr', 'bin', 'bash.exe') : '';
    return bash && fs.existsSync(bash) ? bash : null;
  }
  return ['/bin/bash', '/usr/bin/bash'].find((b) => fs.existsSync(b)) ?? null;
}

function findPowerShell(): string | null {
  for (const p of win ? ['powershell.exe', 'pwsh'] : ['pwsh']) {
    if (spawnSync(p, ['-NoProfile', '-Command', 'exit 0']).status === 0) return p;
  }
  return null;
}

interface Pty {
  spawn(file: string, args: string[], opts: Record<string, unknown>): {
    onData(fn: (d: string) => void): void;
    onExit(fn: (e: { exitCode: number }) => void): void;
    kill(): void;
  };
}
function findPty(): Pty | null {
  const at = path.resolve(repo, '..', 'tui-check', 'node_modules', '@lydell', 'node-pty');
  try {
    return fs.existsSync(at) ? (createRequire(path.join(repo, 'package.json'))(at) as Pty) : null;
  } catch {
    return null;
  }
}

function findScript(): boolean {
  return !win && spawnSync('script', ['-qec', 'true', '/dev/null']).status === 0;
}

const bash = findBash();
const powershell = findPowerShell();
const nodePty = findPty();
const script = findScript();

function stubEnv(): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm6-docker-'));
  fs.writeFileSync(path.join(dir, 'docker'), '#!/bin/sh\nprintf \'arg:%s\\n\' "$@"\nexit 4\n');
  fs.chmodSync(path.join(dir, 'docker'), 0o755);
  fs.writeFileSync(path.join(dir, 'docker.cmd'), '@echo off\r\nfor %%a in (%*) do echo arg:%%a\r\nexit /b 4\r\n');
  const real = (d: string) => ['docker', 'docker.exe', 'docker.cmd', 'docker.bat'].some((n) => fs.existsSync(path.join(d, n)));
  const rest = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter((d) => d && !real(d));
  const env = { ...process.env };
  delete env.Path;
  delete env.DBM_LOCAL;
  delete env.DBM_CONTAINER;
  env.PATH = [dir, ...rest].join(path.delimiter);
  return env;
}

// ConPTY draws the output with cursor moves and titles between the lines; those are dropped before the lines are read.
const plain = (out: string) => out.replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '\n');
const args = (out: string) => plain(out).split(/\r?\n/).filter((l) => l.startsWith('arg:')).map((l) => l.slice(4).trim());
const PIPED_ARGS = ['exec', '-i', 'discordbotmanagerapp', 'node', '/app/dist/cli/dbm.js', 'bots', 'list'];
const TTY_ARGS = ['exec', '-it', 'discordbotmanagerapp', 'node', '/app/dist/cli/dbm.js', 'bots', 'list'];

function inPty(file: string, argv: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const p = nodePty!.spawn(file, argv, { name: 'xterm-256color', cols: 100, rows: 30, env: env as Record<string, string> });
    let out = '';
    const limit = setTimeout(() => {
      p.kill();
      reject(new Error(`no exit within 20 s; output so far: ${JSON.stringify(out)}`));
    }, 20_000);
    p.onData((d) => {
      out += d;
    });
    p.onExit(({ exitCode }) => {
      // ConPTY can deliver its last output after the exit.
      setTimeout(() => {
        clearTimeout(limit);
        resolve({ code: exitCode, out });
      }, 300);
    });
  });
}

describe('m6 wrappers: piped', () => {
  it.skipIf(!bash)('dbm.sh keeps -i, prints no terminal sequence and passes docker exit code on', () => {
    const r = spawnSync(bash!, [DBM_SH, 'bots', 'list'], { env: stubEnv(), encoding: 'utf8', timeout: 20_000 });
    expect(args(r.stdout)).toEqual(PIPED_ARGS);
    expect(r.stdout).not.toContain('\x1b');
    expect(r.status).toBe(4);
  });

  it.skipIf(!bash)('dbm.sh takes the container name from DBM_CONTAINER', () => {
    const r = spawnSync(bash!, [DBM_SH, 'bots', 'list'], { env: { ...stubEnv(), DBM_CONTAINER: 'other' }, encoding: 'utf8', timeout: 20_000 });
    expect(args(r.stdout)[2]).toBe('other');
  });

  it.skipIf(!powershell)('dbm.ps1 keeps -i, prints no terminal sequence and passes docker exit code on', () => {
    const r = spawnSync(powershell!, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DBM_PS1, 'bots', 'list'], { env: stubEnv(), encoding: 'utf8', timeout: 20_000 });
    expect(args(r.stdout)).toEqual(PIPED_ARGS);
    expect(r.stdout).not.toContain('\x1b');
    expect(r.status).toBe(4);
  });

  it.skipIf(!powershell)('dbm.ps1 exits 1 when docker is not on PATH', () => {
    const env = stubEnv();
    env.PATH = (env.PATH ?? '').split(path.delimiter).slice(1).join(path.delimiter);
    for (const argv of [['bots', 'list'], []]) {
      const r = spawnSync(powershell!, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DBM_PS1, ...argv], { env, encoding: 'utf8', timeout: 20_000 });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('[Error] docker is not on PATH, so dbm cannot reach the manager container.');
    }
  });
});

// An exported `[` function answers `-t` with true, so dbm.sh takes its terminal branch while its output stays a pipe and
// every byte it writes can be read. It runs wherever bash imports the function (checked first).
const TTY_FN = 'if builtin [ "$1" = -t ]; then return 0; fi; builtin [ "$@";';
function ttyEnv(): NodeJS.ProcessEnv {
  return { ...stubEnv(), 'BASH_FUNC_[%%': `() { ${TTY_FN} }` };
}
const fnImported = !!bash && spawnSync(bash, ['-c', '[ -t 0 ]'], { env: ttyEnv(), stdio: ['pipe', 'pipe', 'pipe'] }).status === 0;

describe('m6 wrappers: the terminal branch read byte for byte', () => {
  it.skipIf(!fnImported)('dbm.sh with a verb turns paste mode off and shows the cursor, and leaves no alternate screen', () => {
    const r = spawnSync(bash!, [DBM_SH, 'bots', 'list'], { env: ttyEnv(), encoding: 'utf8', timeout: 20_000 });
    expect(args(r.stdout)).toEqual(TTY_ARGS);
    expect(r.stdout.endsWith('arg:list\n\x1b[?2004l\x1b[?25h')).toBe(true);
    expect(r.stdout).not.toContain('\x1b[?1049l');
    expect(r.status).toBe(4);
  });

  it.skipIf(!fnImported)('dbm.sh with no verb also leaves the alternate screen', () => {
    const r = spawnSync(bash!, [DBM_SH], { env: ttyEnv(), encoding: 'utf8', timeout: 20_000 });
    expect(args(r.stdout)).toEqual(TTY_ARGS.slice(0, 5));
    expect(r.stdout.endsWith(`/app/dist/cli/dbm.js\n${RESET}`)).toBe(true);
    expect(r.status).toBe(4);
  });
});

describe('m6 wrappers: as a terminal', () => {
  it.skipIf(!bash || !(nodePty || script))('dbm.sh adds -t, resets the terminal after docker returns and passes its exit code on', async () => {
    const env = stubEnv();
    let r: { code: number; out: string };
    if (nodePty) r = await inPty(bash!, [DBM_SH, 'bots', 'list'], env);
    else {
      const s = spawnSync('script', ['-qec', `${bash} ${DBM_SH} bots list`, '/dev/null'], { env, encoding: 'utf8', timeout: 20_000 });
      r = { code: s.status ?? -1, out: s.stdout };
    }
    expect(args(r.out)).toEqual(TTY_ARGS);
    expect(r.code).toBe(4);
    if (win) expect(r.out).toContain('\x1b[?2004l');
    else {
      // After a verb only paste mode and the cursor are reset; the alternate screen belongs to the run with no verb.
      expect(r.out.slice(r.out.lastIndexOf('arg:list'))).toContain('\x1b[?2004l\x1b[?25h');
      expect(r.out).not.toContain('\x1b[?1049l');
    }
  });

  it.skipIf(!powershell || !nodePty)('dbm.ps1 adds -t, resets the terminal after docker returns and passes its exit code on', async () => {
    const r = await inPty(powershell!, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DBM_PS1, 'bots', 'list'], stubEnv());
    expect(args(r.out)).toEqual(TTY_ARGS);
    expect(r.code).toBe(4);
    if (win) expect(r.out).toContain('\x1b[?2004l');
    else {
      // After a verb only paste mode and the cursor are reset; the alternate screen belongs to the run with no verb.
      expect(r.out.slice(r.out.lastIndexOf('arg:list'))).toContain('\x1b[?2004l\x1b[?25h');
      expect(r.out).not.toContain('\x1b[?1049l');
    }
  });
});
