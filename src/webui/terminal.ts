/**
 * Per-bot Console + Files backend.
 *
 * Interactive terminal: spawns `docker exec -it <container> <shell>` via the docker
 * CLI and bridges its stdio to the browser over the existing /ws WebSocket
 * (multiplexed as terminal:* messages). Using the CLI (not the raw Engine socket)
 * keeps it cross-platform - it works on the Windows Docker Desktop named pipe too.
 *
 * File operations: against the bot's running container they run scoped `docker exec`
 * commands (argv arrays, never a shell string, so paths cannot inject). For the
 * "persistent data (host)" scope: in CasaOS mode they go through the casaos
 * container at /DATA/AppData/<app>; in plain docker mode they operate directly on
 * the bot's local data dir with Node fs (no casaos container exists).
 *
 * Everything is scoped per bot: the target container is validated to belong to the
 * bot's compose project, and host-folder access is jailed to that bot's data dir.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { WebSocket } from 'ws';
import { getBot } from '../docker/containerManager';
import { getDataPath } from '../git/repoManager';
import { getDeploymentMode } from '../casaos/detector';

const DATA_ROOT = process.env.DATA_ROOT || '/DATA';
const CASAOS_CONTAINER = 'casaos';

const MAX_FILE_BYTES = 1024 * 1024;        // 1 MB read/edit cap
const EXEC_TIMEOUT_MS = 15000;

// ─── Container resolution / validation ──────────────────────────────────────

function spawnCapture(
  cmd: string,
  args: string[],
  opts: { input?: Buffer; timeoutMs?: number } = {}
): Promise<{ stdout: Buffer; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, opts.timeoutMs || EXEC_TIMEOUT_MS);
    child.stdout.on('data', (d) => out.push(d as Buffer));
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', () => { clearTimeout(timer); resolve({ stdout: Buffer.concat(out), stderr: err || 'spawn failed', code: 1 }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout: Buffer.concat(out), stderr: err, code: code == null ? 1 : code }); });
    if (opts.input) { child.stdin.write(opts.input); }
    child.stdin.end();
  });
}

export interface BotContainer { name: string; state: string }

export async function getBotContainers(appName: string): Promise<BotContainer[]> {
  const { stdout } = await spawnCapture('docker', [
    'ps', '-a',
    '--filter', `label=com.docker.compose.project=${appName}`,
    '--format', '{{.Names}}\t{{.State}}',
  ]);
  return stdout.toString('utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => { const [name, state] = l.split('\t'); return { name, state: state || 'unknown' }; });
}

// ─── Filesystem scope resolution ────────────────────────────────────────────

type FsTarget =
  | { kind: 'container'; container: string; user?: string; base: string; jail: boolean }
  | { kind: 'local'; base: string; jail: boolean };

type ContainerTarget = Extract<FsTarget, { kind: 'container' }>;

/**
 * Resolve where file/exec ops run.
 * target === 'host' -> the bot's persistent data: the casaos container's
 * /DATA/AppData/<app> in CasaOS mode, or the bot's local data dir (Node fs) in
 * docker mode. Otherwise target is a container name validated to belong to the bot.
 */
async function resolveTarget(botId: string, target: string): Promise<FsTarget | { error: string }> {
  const bot = getBot(botId);
  if (!bot) return { error: 'Bot not found' };
  const appName = bot.sanitizedName;

  if (target === 'host') {
    const mode = await getDeploymentMode();
    if (mode === 'casaos') {
      return { kind: 'container', container: CASAOS_CONTAINER, user: 'ubuntu', base: `${DATA_ROOT}/AppData/${appName}`, jail: true };
    }
    return { kind: 'local', base: getDataPath(botId), jail: true };
  }

  const containers = await getBotContainers(appName);
  if (!containers.some((c) => c.name === target)) {
    return { error: 'Container does not belong to this bot' };
  }
  return { kind: 'container', container: target, base: '/', jail: false };
}

// Resolve a user path against the target, enforcing the jail for host scope.
// Accepts an absolute path (must stay within base when jailed) or a path
// relative to base. Returns null if it escapes the jail.
function resolveAbs(t: FsTarget, reqPath: string): string | null {
  let abs: string;
  if (!reqPath) {
    abs = t.base;
  } else if (reqPath.startsWith('/')) {
    abs = path.posix.normalize(reqPath);
  } else {
    abs = path.posix.normalize(path.posix.join(t.base, reqPath));
  }
  if (t.jail) {
    const root = t.base.replace(/\/+$/, '');
    if (abs !== root && !abs.startsWith(root + '/')) return null;
  }
  return abs;
}

function execArgs(t: ContainerTarget, argv: string[]): string[] {
  const base = ['exec'];
  if (t.user) base.push('--user', t.user);
  base.push(t.container, ...argv);
  return base;
}

// ─── Local (Node fs) file operations for the docker-mode host scope ─────────

function localList(abs: string): any {
  try {
    const entries = fs.readdirSync(abs, { withFileTypes: true })
      .map((e) => ({ name: e.name, isDir: e.isDirectory() }));
    return { success: true, path: abs, entries };
  } catch (e) {
    return { success: false, error: (e as Error).message || 'Failed to list directory', path: abs };
  }
}

function localRead(abs: string): any {
  try {
    if (fs.statSync(abs).size > MAX_FILE_BYTES) return { success: false, error: 'File too large to edit (over 1 MB)', path: abs, tooLarge: true };
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return { success: false, error: 'Binary file (not editable here)', path: abs, binary: true };
    return { success: true, path: abs, body: buf.toString('utf8') };
  } catch (e) {
    return { success: false, error: (e as Error).message || 'Failed to read file', path: abs };
  }
}

function localWrite(abs: string, body: string): any {
  try {
    fs.mkdirSync(path.posix.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
    return { success: true, path: abs };
  } catch (e) {
    return { success: false, error: (e as Error).message || 'Failed to write file' };
  }
}

function localMkdir(abs: string): any {
  try { fs.mkdirSync(abs, { recursive: true }); return { success: true, path: abs }; }
  catch (e) { return { success: false, error: (e as Error).message || 'Failed to create directory' }; }
}

function localDelete(abs: string): any {
  try { fs.rmSync(abs, { recursive: true, force: true }); return { success: true, path: abs }; }
  catch (e) { return { success: false, error: (e as Error).message || 'Failed to delete' }; }
}

function localRename(absFrom: string, absTo: string): any {
  try { fs.renameSync(absFrom, absTo); return { success: true, from: absFrom, to: absTo }; }
  catch (e) { return { success: false, error: (e as Error).message || 'Failed to rename' }; }
}

// ─── File operations ────────────────────────────────────────────────────────

export async function fsList(botId: string, target: string, reqPath: string): Promise<any> {
  const t = await resolveTarget(botId, target);
  if ('error' in t) return { success: false, error: t.error };
  const abs = resolveAbs(t, reqPath);
  if (!abs) return { success: false, error: 'Path outside allowed scope' };

  if (t.kind === 'local') return localList(abs);

  const { stdout, stderr, code } = await spawnCapture('docker', execArgs(t, ['ls', '-Ap1', '--', abs]));
  if (code !== 0) return { success: false, error: stderr.trim() || 'Failed to list directory', path: abs };

  const entries = stdout.toString('utf8').split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean).map((name) => {
    const isDir = name.endsWith('/');
    return { name: isDir ? name.slice(0, -1) : name, isDir };
  });
  return { success: true, path: abs, entries };
}

export async function fsRead(botId: string, target: string, reqPath: string): Promise<any> {
  const t = await resolveTarget(botId, target);
  if ('error' in t) return { success: false, error: t.error };
  const abs = resolveAbs(t, reqPath);
  if (!abs) return { success: false, error: 'Path outside allowed scope' };

  if (t.kind === 'local') return localRead(abs);

  const { stdout, stderr, code } = await spawnCapture('docker', execArgs(t, ['head', '-c', String(MAX_FILE_BYTES + 1), '--', abs]));
  if (code !== 0) return { success: false, error: stderr.trim() || 'Failed to read file', path: abs };
  if (stdout.length > MAX_FILE_BYTES) return { success: false, error: 'File too large to edit (over 1 MB)', path: abs, tooLarge: true };
  if (stdout.includes(0)) return { success: false, error: 'Binary file (not editable here)', path: abs, binary: true };
  return { success: true, path: abs, body: stdout.toString('utf8') };
}

export async function fsWrite(botId: string, target: string, reqPath: string, body: string): Promise<any> {
  const t = await resolveTarget(botId, target);
  if ('error' in t) return { success: false, error: t.error };
  const abs = resolveAbs(t, reqPath);
  if (!abs) return { success: false, error: 'Path outside allowed scope' };

  // Guard against accidentally truncating a file to nothing (a blank editor save
  // would erase a config). Deleting is the explicit way to remove a file.
  if (body.length === 0) {
    return { success: false, error: 'Refusing to save an empty file (this would erase its contents). Use delete if you mean to remove it.' };
  }

  if (t.kind === 'local') return localWrite(abs, body);

  // Pass the path as $1 (argv), never interpolated into the shell.
  const { stderr, code } = await spawnCapture(
    'docker',
    execArgs(t, ['sh', '-c', 'cat > "$1"', 'sh', abs]),
    { input: Buffer.from(body, 'utf8') }
  );
  if (code !== 0) return { success: false, error: stderr.trim() || 'Failed to write file' };
  return { success: true, path: abs };
}

export async function fsMkdir(botId: string, target: string, reqPath: string): Promise<any> {
  const t = await resolveTarget(botId, target);
  if ('error' in t) return { success: false, error: t.error };
  const abs = resolveAbs(t, reqPath);
  if (!abs) return { success: false, error: 'Path outside allowed scope' };
  if (t.kind === 'local') return localMkdir(abs);
  const { stderr, code } = await spawnCapture('docker', execArgs(t, ['mkdir', '-p', '--', abs]));
  if (code !== 0) return { success: false, error: stderr.trim() || 'Failed to create directory' };
  return { success: true, path: abs };
}

export async function fsDelete(botId: string, target: string, reqPath: string): Promise<any> {
  const t = await resolveTarget(botId, target);
  if ('error' in t) return { success: false, error: t.error };
  const abs = resolveAbs(t, reqPath);
  if (!abs || (t.jail && abs === t.base)) return { success: false, error: 'Path outside allowed scope' };
  if (t.kind === 'local') return localDelete(abs);
  const { stderr, code } = await spawnCapture('docker', execArgs(t, ['rm', '-rf', '--', abs]));
  if (code !== 0) return { success: false, error: stderr.trim() || 'Failed to delete' };
  return { success: true, path: abs };
}

export async function fsRename(botId: string, target: string, fromPath: string, toPath: string): Promise<any> {
  const t = await resolveTarget(botId, target);
  if ('error' in t) return { success: false, error: t.error };
  const absFrom = resolveAbs(t, fromPath);
  const absTo = resolveAbs(t, toPath);
  if (!absFrom || !absTo) return { success: false, error: 'Path outside allowed scope' };
  if (t.kind === 'local') return localRename(absFrom, absTo);
  const { stderr, code } = await spawnCapture('docker', execArgs(t, ['mv', '--', absFrom, absTo]));
  if (code !== 0) return { success: false, error: stderr.trim() || 'Failed to rename' };
  return { success: true, from: absFrom, to: absTo };
}

// ─── Interactive terminal (multiplexed over the /ws connection) ─────────────

interface TermSession { child: ChildProcess }

function send(ws: WebSocket, type: string, extra: Record<string, unknown> = {}): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...extra }));
}

export function closeTerminal(ws: WebSocket): void {
  const sess = (ws as any).__term as TermSession | undefined;
  if (sess?.child) { try { sess.child.kill('SIGKILL'); } catch { /* ignore */ } }
  (ws as any).__term = undefined;
}

// `docker exec` args for an interactive shell. The wrapper sets the initial TTY
// size, then execs bash if present else sh.
function buildExecArgs(container: string, useTty: boolean, cols: number, rows: number): string[] {
  const args = ['exec', '-i'];
  if (useTty) args.push('-t');
  const wrap = `stty rows ${rows} cols ${cols} 2>/dev/null; if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi`;
  args.push(container, '/bin/sh', '-c', wrap);
  return args;
}

async function startTerminal(ws: WebSocket, msg: any): Promise<void> {
  const bot = getBot(msg.botId);
  if (!bot) { send(ws, 'terminal:error', { message: 'Bot not found' }); return; }

  const containers = await getBotContainers(bot.sanitizedName);
  const target = String(msg.container || '');
  const match = containers.find((c) => c.name === target);
  if (!match) { send(ws, 'terminal:error', { message: 'Container does not belong to this bot' }); return; }
  if (match.state !== 'running') { send(ws, 'terminal:error', { message: 'Container is not running' }); return; }

  closeTerminal(ws);

  const cols = Number(msg.cols) || 80;
  const rows = Number(msg.rows) || 24;
  let retried = false;

  // Node's stdin is a pipe, so some daemons refuse `-t` ("the input device is not
  // a TTY"). On that error, retry once without a TTY (line-buffered but usable).
  const launch = (useTty: boolean): void => {
    const child = spawn('docker', buildExecArgs(target, useTty, cols, rows), { windowsHide: true });
    (ws as any).__term = { child } as TermSession;

    const forward = (d: Buffer) => send(ws, 'terminal:data', { data: d.toString('base64') });
    child.stdout?.on('data', forward);
    child.stderr?.on('data', (d: Buffer) => {
      if (useTty && !retried && /not a TTY/i.test(d.toString())) {
        retried = true;
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        launch(false);
        return;
      }
      forward(d);
    });
    child.on('exit', () => {
      if (retried && useTty) return;   // this is the TTY attempt we replaced
      if (((ws as any).__term as TermSession | undefined)?.child === child) (ws as any).__term = undefined;
      send(ws, 'terminal:exit', {});
    });
    child.on('error', (err) => {
      if (retried && useTty) return;
      send(ws, 'terminal:error', { message: err instanceof Error ? err.message : String(err) });
    });
  };

  launch(true);
  send(ws, 'terminal:ready', { container: target });
}

/**
 * Handle a terminal:* control message on the shared /ws socket.
 * Returns true if the message was a terminal message (handled), false otherwise.
 */
export function handleTerminalMessage(ws: WebSocket, raw: string): boolean {
  let msg: any;
  try { msg = JSON.parse(raw); } catch { return false; }
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('terminal:')) return false;

  const sess = (ws as any).__term as TermSession | undefined;
  switch (msg.type) {
    case 'terminal:start':
      void startTerminal(ws, msg);
      break;
    case 'terminal:input':
      if (sess?.child?.stdin) sess.child.stdin.write(Buffer.from(String(msg.data || ''), 'base64'));
      break;
    case 'terminal:resize':
      // Live resize needs a real PTY (node-pty follow-up); initial size is set by
      // buildExecArgs. No-op here to keep the CLI path dependency-free.
      break;
    case 'terminal:stop':
      closeTerminal(ws);
      break;
  }
  return true;
}
