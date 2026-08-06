/**
 * Loopback-only HTTP/SSE/WS client for the dbm CLI.
 * Refuses any non-loopback target by construction: the console system talks only
 * to a manager running on this same host (direct in standalone, via docker exec on
 * a server). Nothing here reaches across a network.
 */

import http from 'http';
import { WebSocket } from 'ws';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);

export interface Target {
  host: string;
  port: number;
}

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
  const port = opts.port ? parseInt(opts.port, 10) : parseInt(process.env.PORT || '8080', 10);
  return { host: '127.0.0.1', port };
}

export class Client {
  constructor(private target: Target) {}

  request(
    method: string,
    path: string,
    opts: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<CliResponse> {
    return new Promise((resolve, reject) => {
      const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
      const req = http.request(
        {
          host: this.target.host,
          port: this.target.port,
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
    opts: { timeoutMs?: number } = {},
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: this.target.host, port: this.target.port, method: 'GET', path, headers: { Accept: 'text/event-stream' } },
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
          res.on('end', () => resolve());
        },
      );
      req.on('error', reject);
      if (opts.timeoutMs) {
        req.setTimeout(opts.timeoutMs, () => {
          req.destroy();
          resolve();
        });
      }
      req.end();
    });
  }

  /** Open the /ws broadcast channel; onMessage fires per decoded frame. Returns a closer. */
  openWs(onMessage: (msg: { type: string; data: unknown }) => void, onOpen?: () => void): { close: () => void } {
    const ws = new WebSocket(`ws://${this.target.host}:${this.target.port}/ws`);
    ws.on('open', () => onOpen?.());
    ws.on('message', (raw) => {
      try {
        const parsed = JSON.parse(raw.toString());
        if (parsed && typeof parsed.type === 'string') onMessage(parsed);
      } catch {
        /* ignore non-JSON frames */
      }
    });
    return { close: () => ws.close() };
  }
}
