/**
 * Per-bot Console + Files backend.
 *
 * Interactive terminal: talks to the Docker Engine API over the unix socket to
 * create a TTY exec inside a bot's container and bridges the raw stream to the
 * browser over the existing /ws WebSocket (multiplexed as terminal:* messages).
 *
 * File operations: run scoped `docker exec` commands (argv arrays, never a shell
 * string, so paths cannot inject) against either the bot's running container or,
 * when the bot is stopped, its persistent host folder /DATA/AppData/<app> via the
 * casaos container (the same mechanism saveToCasaOSMetadata/writeStatusPage use).
 *
 * Everything is scoped per bot: the target container is validated to belong to the
 * bot's compose project, and host-folder access is jailed to that bot's AppData dir.
 */

import * as http from 'http';
import * as path from 'path';
import { spawn } from 'child_process';
import { Socket } from 'net';
import { WebSocket } from 'ws';
import { getBot } from '../docker/containerManager';

const DOCKER_SOCK = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const DATA_ROOT = process.env.DATA_ROOT || '/DATA';
const CASAOS_CONTAINER = 'casaos';

const MAX_FILE_BYTES = 1024 * 1024;        // 1 MB read/edit cap
const EXEC_TIMEOUT_MS = 15000;

// ─── Docker Engine API over the unix socket ────────────────────────────────

function dockerApi(method: string, urlPath: string, body?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request(
      {
        socketPath: DOCKER_SOCK,
        path: urlPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode || 500) >= 400) {
            reject(new Error(`Docker API ${method} ${urlPath} -> ${res.statusCode}: ${text}`));
            return;
          }
          try {
            resolve(text ? JSON.parse(text) : {});
          } catch {
            resolve({});
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// POST /exec/{id}/start with a hijacked bidirectional stream (Tty mode).
function dockerHijack(urlPath: string, body: unknown): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      socketPath: DOCKER_SOCK,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Connection: 'Upgrade',
        Upgrade: 'tcp',
      },
    });
    let settled = false;
    req.on('upgrade', (_res, socket) => {
      if (!settled) { settled = true; resolve(socket as Socket); }
    });
    // Fallback: some daemons reply 200 and stream over the response socket.
    req.on('response', (res) => {
      if (!settled) { settled = true; resolve(res.socket as Socket); }
    });
    req.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
    req.write(payload);
    req.end();
  });
}

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

interface FsTarget { container: string; user?: string; base: string; jail: boolean }

/**
 * Resolve which container the file/exec ops run against.
 * target === 'host' -> the bot's persistent /DATA/AppData/<app> via the casaos
 * container (jailed). Otherwise target is a container name validated to belong
 * to the bot.
 */
async function resolveTarget(botId: string, target: string): Promise<FsTarget | { error: string }> {
  const bot = getBot(botId);
  if (!bot) return { error: 'Bot not found' };
  const appName = bot.sanitizedName;

  if (target === 'host') {
    return { container: CASAOS_CONTAINER, user: 'ubuntu', base: `${DATA_ROOT}/AppData/${appName}`, jail: true };
  }

  const containers = await getBotContainers(appName);
  if (!containers.some((c) => c.name === target)) {
    return { error: 'Container does not belong to this bot' };
  }
  return { container: target, base: '/', jail: false };
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

function execArgs(t: FsTarget, argv: string[]): string[] {
  const base = ['exec'];
  if (t.user) base.push('--user', t.user);
  base.push(t.container, ...argv);
  return base;
}

// ─── File operations ────────────────────────────────────────────────────────

export async function fsList(botId: string, target: string, reqPath: string): Promise<any> {
  const t = await resolveTarget(botId, target);
  if ('error' in t) return { success: false, error: t.error };
  const abs = resolveAbs(t, reqPath);
  if (!abs) return { success: false, error: 'Path outside allowed scope' };

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
  const { stderr, code } = await spawnCapture('docker', execArgs(t, ['mkdir', '-p', '--', abs]));
  if (code !== 0) return { success: false, error: stderr.trim() || 'Failed to create directory' };
  return { success: true, path: abs };
}

export async function fsDelete(botId: string, target: string, reqPath: string): Promise<any> {
  const t = await resolveTarget(botId, target);
  if ('error' in t) return { success: false, error: t.error };
  const abs = resolveAbs(t, reqPath);
  if (!abs || (t.jail && abs === t.base)) return { success: false, error: 'Path outside allowed scope' };
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
  const { stderr, code } = await spawnCapture('docker', execArgs(t, ['mv', '--', absFrom, absTo]));
  if (code !== 0) return { success: false, error: stderr.trim() || 'Failed to rename' };
  return { success: true, from: absFrom, to: absTo };
}

// ─── Interactive terminal (multiplexed over the /ws connection) ─────────────

interface TermSession { socket: Socket; execId: string }

function send(ws: WebSocket, type: string, extra: Record<string, unknown> = {}): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...extra }));
}

export function closeTerminal(ws: WebSocket): void {
  const sess = (ws as any).__term as TermSession | undefined;
  if (sess?.socket) { try { sess.socket.destroy(); } catch { /* ignore */ } }
  (ws as any).__term = undefined;
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

  try {
    const created = await dockerApi('POST', `/containers/${target}/exec`, {
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Cmd: ['/bin/sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi'],
    });
    const execId = created.Id;
    if (!execId) { send(ws, 'terminal:error', { message: 'Failed to create exec' }); return; }

    const socket = await dockerHijack(`/exec/${execId}/start`, { Detach: false, Tty: true });
    (ws as any).__term = { socket, execId } as TermSession;

    socket.on('data', (d: Buffer) => send(ws, 'terminal:data', { data: d.toString('base64') }));
    socket.on('close', () => { send(ws, 'terminal:exit', {}); (ws as any).__term = undefined; });
    socket.on('error', () => { send(ws, 'terminal:exit', {}); (ws as any).__term = undefined; });

    const cols = Number(msg.cols) || 80;
    const rows = Number(msg.rows) || 24;
    await dockerApi('POST', `/exec/${execId}/resize?h=${rows}&w=${cols}`).catch(() => { /* non-fatal */ });
    send(ws, 'terminal:ready', { container: target });
  } catch (err) {
    send(ws, 'terminal:error', { message: `Failed to open terminal: ${err instanceof Error ? err.message : String(err)}` });
  }
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
      if (sess?.socket) sess.socket.write(Buffer.from(String(msg.data || ''), 'base64'));
      break;
    case 'terminal:resize':
      if (sess?.execId) {
        const cols = Number(msg.cols) || 80;
        const rows = Number(msg.rows) || 24;
        void dockerApi('POST', `/exec/${sess.execId}/resize?h=${rows}&w=${cols}`).catch(() => { /* ignore */ });
      }
      break;
    case 'terminal:stop':
      closeTerminal(ws);
      break;
  }
  return true;
}
