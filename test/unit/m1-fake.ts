import type { Client, CliResponse } from '../../src/cli/client';

// Answers shaped as src/webui/routes/bots.ts sends them; each test sets the routes it needs.
export type Reply = CliResponse | Error;
export type Frame = { event: string; data: unknown };

export interface FakeScript {
  requests: Array<{ method: string; path: string }>;
  reply: (method: string, path: string) => Reply | Promise<Reply>;
  /** WS frames broadcast after a POST the route accepted, as broadcastToClients sends them. */
  events: (path: string, opId: string) => Array<{ type: string; data: unknown }>;
  wsFails?: string;
  wsClosesAfterPost?: string;
  streams: Record<string, { frames: Frame[]; then: 'end' | Error | 'hang' }>;
  sseOpened: string[];
  sseAborted: string[];
}

export function ok(body: unknown): CliResponse {
  return { status: 200, ok: true, body };
}

export function refused(status: number, body: unknown): CliResponse {
  return { status, ok: false, body };
}

export function bot(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'b1', displayName: 'mybot', status: 'running', sourceType: 'git', activeOp: null, fleetDb: null, fleetDbReplica: null,
    fleetBackup: null, updateAvailable: false, behindBy: 0, cutOp: null, ...over,
  };
}

export function listBody(bots: unknown[]): unknown {
  return { success: true, bots, deploymentMode: 'docker', portBind: { bind: '127.0.0.1', loopback: true } };
}

export function script(over: Partial<FakeScript> = {}): FakeScript {
  return {
    requests: [],
    reply: () => refused(404, { success: false, error: 'Bot not found' }),
    events: () => [],
    streams: {},
    sseOpened: [],
    sseAborted: [],
    ...over,
  };
}

let ops = 0;

export function fakeClient(s: FakeScript): Client {
  const listeners = new Set<(msg: { type: string; data: unknown }) => void>();
  const closers = new Set<(reason: string) => void>();
  const fake = {
    async request(method: string, path: string): Promise<CliResponse> {
      s.requests.push({ method, path });
      const r = await s.reply(method, path);
      if (r instanceof Error) throw r;
      const b = r.body as { opId?: string } | null;
      if (method === 'POST' && r.ok && b && typeof b.opId === 'string') {
        const opId = b.opId;
        setTimeout(() => {
          if (s.wsClosesAfterPost) {
            for (const c of [...closers]) c(s.wsClosesAfterPost);
            return;
          }
          for (const msg of s.events(path, opId)) for (const l of [...listeners]) l(msg);
        }, 5);
      }
      return r;
    },
    sse(path: string, onFrame: (f: Frame) => void, opts: { signal?: AbortSignal } = {}): Promise<'end' | 'timeout'> {
      s.sseOpened.push(path);
      const st = s.streams[path];
      return new Promise((resolve, reject) => {
        if (!st) {
          reject(new Error(`SSE ${path} returned 404`));
          return;
        }
        opts.signal?.addEventListener('abort', () => {
          s.sseAborted.push(path);
          reject(new Error('This operation was aborted'));
        });
        let i = 0;
        const next = () => {
          if (opts.signal?.aborted) return;
          if (i < st.frames.length) {
            onFrame(st.frames[i++]);
            setTimeout(next, 2);
            return;
          }
          if (st.then === 'end') resolve('end');
          else if (st.then instanceof Error) reject(st.then);
        };
        setTimeout(next, 2);
      });
    },
    openWs(onMessage: (msg: { type: string; data: unknown }) => void, onOpen?: () => void, onClose?: (reason: string) => void) {
      let open = true;
      const close = (reason: string) => {
        if (!open) return;
        open = false;
        listeners.delete(onMessage);
        closers.delete(close);
        onClose?.(reason);
      };
      setTimeout(() => {
        if (s.wsFails) close(s.wsFails);
        else {
          listeners.add(onMessage);
          closers.add(close);
          onOpen?.();
        }
      }, 1);
      return {
        close: () => {
          open = false;
          listeners.delete(onMessage);
          closers.delete(close);
        },
      };
    },
  };
  return fake as unknown as Client;
}

export function nextOpId(): string {
  ops++;
  return `op-${ops}`;
}
