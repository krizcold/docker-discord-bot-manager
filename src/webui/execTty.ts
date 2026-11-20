/**
 * A shell under a pseudo-terminal, asked from the Docker daemon over its local socket (Engine API: exec create with
 * Tty, exec start with the connection upgraded to a raw stream, exec resize, exec inspect).
 */

import http from 'http';
import type { Duplex } from 'stream';

export interface ExecTtyOptions {
  socketPath: string;
  container: string;
  cmd: string[];
  cols: number;
  rows: number;
  onData: (chunk: Buffer) => void;
  /**
   * Called once when the stream ends by itself; code is null when the daemon did not give an exit code, and running
   * is true when the daemon reports the shell still running.
   */
  onExit: (code: number | null, running: boolean) => void;
  /** How long each call to the daemon may stay unanswered; 15 s when not given. */
  callTimeoutMs?: number;
}

export interface ExecTty {
  write(chunk: Buffer): void;
  resize(cols: number, rows: number): void;
  /** Stops reading the daemon's stream, so the daemon holds the output back. */
  pause(): void;
  resume(): void;
  /** Ends the stream; onExit is not called afterwards. */
  close(): void;
}

const CALL_TIMEOUT_MS = 15000;
const REFUSAL_BODY_MAX = 64 * 1024;

/** The daemon's local socket: DOCKER_HOST when it names one (unix:// or npipe://), else the platform's default. Null for any other DOCKER_HOST. */
export function dockerSocketPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const host = env.DOCKER_HOST;
  if (!host) return platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock';
  if (host.startsWith('unix://')) return host.slice('unix://'.length) || null;
  if (host.startsWith('npipe://')) return host.slice('npipe://'.length) || null;
  return null;
}

function whole(v: unknown): number | null {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 1000 ? n : null;
}

/** A terminal size as whole numbers the daemon and stty accept; 80 by 24 where a value is not one. */
export function termSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  return { cols: whole(cols) ?? 80, rows: whole(rows) ?? 24 };
}

/** A new size from a resize message, or null when either value is not a whole number from 1 to 1000. */
export function resizeSize(cols: unknown, rows: unknown): { cols: number; rows: number } | null {
  const c = whole(cols);
  const r = whole(rows);
  return c === null || r === null ? null : { cols: c, rows: r };
}

function daemonMessage(text: string): string {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.message === 'string' && parsed.message) return parsed.message;
  } catch { /* the body is not JSON */ }
  return text.trim();
}

function refusal(what: string, status: number, text: string): Error {
  const said = daemonMessage(text);
  return new Error(`the Docker daemon answered ${status} to ${what}${said ? `: ${said}` : ''}`);
}

function unreachable(socketPath: string, err: Error): Error {
  return new Error(`the Docker socket ${socketPath} did not answer (${err.message})`);
}

function call(socketPath: string, timeoutMs: number, method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath,
        method,
        path,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer within ${timeoutMs / 1000} s`)));
    req.on('error', reject);
    req.end(payload);
  });
}

function startStream(socketPath: string, timeoutMs: number, execId: string, size: { cols: number; rows: number }): Promise<{ stream: Duplex; head: Buffer }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ Detach: false, Tty: true, ConsoleSize: [size.rows, size.cols] });
    const req = http.request({
      socketPath,
      method: 'POST',
      path: `/exec/${execId}/start`,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Connection: 'Upgrade',
        Upgrade: 'tcp',
      },
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer within ${timeoutMs / 1000} s`)));
    req.on('upgrade', (_res, stream, head) => {
      stream.setTimeout(0);
      resolve({ stream, head });
    });
    req.on('response', (res) => {
      // An answer that is not the upgrade is an error message; one that goes on (a proxy passing the stream) is cut.
      const status = res.statusCode || 0;
      const chunks: Buffer[] = [];
      let size = 0;
      const cut = (how: string) => {
        clearTimeout(deadline);
        reject(new Error(`the Docker daemon answered ${status} to the exec start with an answer ${how}`));
        req.destroy();
      };
      const deadline = setTimeout(() => cut(`that did not end within ${timeoutMs / 1000} s`), timeoutMs);
      res.on('data', (c: Buffer) => {
        chunks.push(c);
        size += c.length;
        if (size > REFUSAL_BODY_MAX) cut(`longer than ${REFUSAL_BODY_MAX / 1024} KiB`);
      });
      res.on('end', () => {
        clearTimeout(deadline);
        reject(refusal('the exec start', status, Buffer.concat(chunks).toString('utf8')));
      });
      res.on('error', (err) => {
        clearTimeout(deadline);
        reject(unreachable(socketPath, err));
      });
    });
    req.on('error', (err) => reject(unreachable(socketPath, err)));
    req.end(payload);
  });
}

async function exitState(socketPath: string, timeoutMs: number, execId: string): Promise<{ code: number | null; running: boolean }> {
  const unknown = { code: null, running: false };
  try {
    const answer = await call(socketPath, timeoutMs, 'GET', `/exec/${execId}/json`);
    if (answer.status !== 200) return unknown;
    const parsed = JSON.parse(answer.text);
    if (!parsed) return unknown;
    if (parsed.Running === true) return { code: null, running: true };
    return typeof parsed.ExitCode === 'number' ? { code: parsed.ExitCode, running: false } : unknown;
  } catch {
    return unknown;
  }
}

/** Rejects with an Error whose message says which call the daemon refused, or that the socket did not answer. */
export async function openExecTty(opts: ExecTtyOptions): Promise<ExecTty> {
  const { socketPath } = opts;
  const timeoutMs = opts.callTimeoutMs ?? CALL_TIMEOUT_MS;
  let created: { status: number; text: string };
  try {
    created = await call(socketPath, timeoutMs, 'POST', `/containers/${encodeURIComponent(opts.container)}/exec`, {
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      ConsoleSize: [opts.rows, opts.cols],
      Cmd: opts.cmd,
    });
  } catch (err) {
    throw unreachable(socketPath, err as Error);
  }
  if (created.status !== 201) throw refusal('the exec create', created.status, created.text);
  let execId = '';
  try {
    const parsed = JSON.parse(created.text);
    if (parsed && typeof parsed.Id === 'string') execId = parsed.Id;
  } catch { /* handled below */ }
  if (!/^[A-Za-z0-9]+$/.test(execId)) throw new Error('the Docker daemon answered the exec create without an exec id');

  const { stream, head } = await startStream(socketPath, timeoutMs, execId, opts);
  let closed = false;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    stream.destroy();
    if (closed) return;
    void exitState(socketPath, timeoutMs, execId).then((state) => {
      if (!closed) opts.onExit(state.code, state.running);
    });
  };
  stream.on('data', (chunk: Buffer) => {
    if (!closed) opts.onData(chunk);
  });
  stream.on('end', end);
  stream.on('close', end);
  stream.on('error', end);
  if (head.length > 0) opts.onData(head);

  return {
    write: (chunk) => {
      if (!closed && !ended) stream.write(chunk);
    },
    resize: (cols, rows) => {
      if (closed || ended) return;
      // A resize that fails leaves the old size; nothing reports one.
      call(socketPath, timeoutMs, 'POST', `/exec/${execId}/resize?h=${rows}&w=${cols}`).catch(() => {});
    },
    pause: () => {
      if (!closed && !ended) stream.pause();
    },
    resume: () => {
      if (!closed && !ended) stream.resume();
    },
    close: () => {
      closed = true;
      stream.destroy();
    },
  };
}
