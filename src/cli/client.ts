/**
 * HTTP/SSE/WS client for the dbm CLI, over loopback TCP or the manager's local socket.
 * Refuses any non-loopback target by construction: the console system talks only
 * to a manager running on this same host (direct in standalone, via docker exec on
 * a server, over the socket in DBM_SOCKET). Nothing here reaches across a network.
 */

import http from 'http';
import net from 'net';
import { WebSocket } from 'ws';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);
export const WS_HANDSHAKE_MS = 45000;

export type Target = { host: string; port: number } | { socketPath: string };

export interface CliResponse {
  status: number;
  ok: boolean;
  body: unknown;
}

export class LoopbackError extends Error {}

export function resolveTarget(opts: { url?: string; port?: string }): Target {
  if (opts.url) {
    let parsed: URL;
    try {
      parsed = new URL(opts.url);
    } catch {
      throw new LoopbackError(`invalid --url: ${opts.url}`);
    }
    if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
      throw new LoopbackError(`--url must be loopback (127.0.0.1/::1/localhost), got ${parsed.hostname}`);
    }
    return { host: parsed.hostname, port: parseInt(parsed.port || '8080', 10) };
  }
  if (opts.port) return { host: '127.0.0.1', port: parseInt(opts.port, 10) };
  if (process.env.DBM_SOCKET) return { socketPath: process.env.DBM_SOCKET };
  return { host: '127.0.0.1', port: parseInt(process.env.PORT || '8080', 10) };
}

export class Client {
  constructor(private target: Target) {}

  /** True when this client talks to the manager's local socket (DBM_SOCKET). */
  get onSocket(): boolean {
    return 'socketPath' in this.target;
  }

  private where(): Target {
    return 'socketPath' in this.target ? { socketPath: this.target.socketPath } : { host: this.target.host, port: this.target.port };
  }

  request(
    method: string,
    path: string,
    opts: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<CliResponse> {
    return new Promise((resolve, reject) => {
      const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
      const req = http.request(
        {
          ...this.where(),
          method,
          path,
          headers: {
            Accept: 'application/json',
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
            ...opts.headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let body: unknown = text;
            if (text) {
              try {
                body = JSON.parse(text);
              } catch {
                /* keep raw text */
              }
            }
            const status = res.statusCode || 0;
            resolve({ status, ok: status >= 200 && status < 300, body });
          });
        },
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** Stream a Server-Sent Events endpoint, invoking onFrame per parsed `data:` block. */
  sse(
    path: string,
    onFrame: (frame: { event: string; data: unknown }) => void,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<'end' | 'timeout'> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { ...this.where(), method: 'GET', path, headers: { Accept: 'text/event-stream' }, signal: opts.signal },
        (res) => {
          if ((res.statusCode || 0) >= 400) {
            reject(new Error(`SSE ${path} returned ${res.statusCode}`));
            res.resume();
            return;
          }
          let buf = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            buf += chunk;
            let sep: number;
            while ((sep = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, sep);
              buf = buf.slice(sep + 2);
              let event = 'message';
              const dataLines: string[] = [];
              for (const line of block.split('\n')) {
                if (line.startsWith('event:')) event = line.slice(6).trim();
                else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
              }
              if (dataLines.length === 0) continue;
              const raw = dataLines.join('\n');
              let data: unknown = raw;
              try {
                data = JSON.parse(raw);
              } catch {
                /* keep raw */
              }
              onFrame({ event, data });
            }
          });
          res.on('end', () => resolve('end'));
          res.on('close', () => resolve('end'));
        },
      );
      req.on('error', reject);
      if (opts.timeoutMs) {
        req.setTimeout(opts.timeoutMs, () => {
          resolve('timeout');
          req.destroy();
        });
      }
      req.end();
    });
  }

  /**
   * Open the /ws broadcast channel; onMessage fires per decoded frame. onClose fires
   * once when the channel fails or closes without the caller closing it. Returns a closer and
   * send, which answers false when the channel is not open. A manager that accepts the connection and does not
   * answer the handshake within handshakeMs counts as a failed channel.
   */
  openWs(
    onMessage: (msg: { type: string; data: unknown }) => void,
    onOpen?: () => void,
    onClose?: (reason: string) => void,
    handshakeMs: number = WS_HANDSHAKE_MS,
  ): { close: () => void; send: (msg: unknown) => boolean } {
    const target = this.target;
    // ws drops a socketPath option, and its ws+unix: URL splits the path at a colon. ws leaves the handshake timer
    // to whoever makes the socket, so the socket made here takes the timeout ws hands over.
    const ws = 'socketPath' in target
      ? new WebSocket('ws://localhost/ws', { handshakeTimeout: handshakeMs, createConnection: (o: { timeout?: number }) => net.connect({ path: target.socketPath, timeout: o.timeout }) })
      : new WebSocket(`ws://${target.host}:${target.port}/ws`, { handshakeTimeout: handshakeMs });
    let closing = false;
    const lost = (reason: string) => {
      if (closing) return;
      closing = true;
      onClose?.(reason);
    };
    ws.on('open', () => onOpen?.());
    ws.on('error', (err) => lost(err.message));
    ws.on('close', (code) => lost(`closed (code ${code})`));
    ws.on('message', (raw) => {
      try {
        const parsed = JSON.parse(raw.toString());
        if (parsed && typeof parsed.type === 'string') onMessage(parsed);
      } catch {
        /* ignore non-JSON frames */
      }
    });
    return {
      close: () => {
        closing = true;
        ws.close();
      },
      send: (msg) => {
        if (ws.readyState !== WebSocket.OPEN) return false;
        ws.send(JSON.stringify(msg));
        return true;
      },
    };
  }
}
