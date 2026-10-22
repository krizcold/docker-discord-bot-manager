/**
 * The two async-observability primitives: block on a terminal WS broadcast (--wait
 * on lifecycle verbs) and poll a GET route until a condition holds (`wait --until`).
 */

import { Client, CliResponse } from './client';

export interface WaitOutcome {
  ok: boolean;
  event: { type: string; data: unknown };
}

export class WaitTimeoutError extends Error {}

/**
 * Subscribe to /ws, then run `trigger` (which fires the POST and returns the op id the
 * route answered with). Resolve with the first broadcast whose type is in
 * successTypes/failTypes and whose opId is that op's. Frames that arrive before the
 * POST answers are held until the op id is known.
 */
export function waitForEvent(
  client: Client,
  opts: { successTypes: string[]; failTypes: string[]; timeoutMs: number },
  trigger: () => Promise<string>,
): Promise<WaitOutcome> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let opId: string | null = null;
    const held: Array<{ type: string; data: unknown }> = [];
    const finish = (r: WaitOutcome | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.close();
      if (r instanceof Error) reject(r);
      else resolve(r);
    };

    const timer = setTimeout(
      () => finish(new WaitTimeoutError(`no completion event within ${Math.round(opts.timeoutMs / 1000)} s`)),
      opts.timeoutMs,
    );

    const judge = (msg: { type: string; data: unknown }) => {
      const isSuccess = opts.successTypes.includes(msg.type);
      const isFail = opts.failTypes.includes(msg.type);
      if (!isSuccess && !isFail) return;
      const d = msg.data as { opId?: string } | null;
      if (!d || d.opId !== opId) return;
      finish({ ok: isSuccess, event: msg });
    };

    const conn = client.openWs(
      (msg) => {
        if (opId === null) held.push(msg);
        else judge(msg);
      },
      () => {
        trigger().then(
          (id) => {
            opId = id;
            for (const msg of held.splice(0)) judge(msg);
          },
          (err) => finish(err instanceof Error ? err : new Error(String(err))),
        );
      },
      (reason) => finish(new Error(`event channel closed before completion: ${reason}`)),
    );
  });
}

/** Evaluate a `--until` expression against a response body. `data` is the JSON body. */
function evalCondition(expr: string, data: unknown): boolean {
  // Test-tool only: the expression is operator-supplied, never untrusted input.
  const fn = new Function('data', `"use strict"; return (${expr});`) as (d: unknown) => unknown;
  return Boolean(fn(data));
}

/**
 * Poll until the expression holds. Only a successful answer is judged; a refused
 * connection or an error status is remembered and the poll goes on until the deadline.
 */
export async function pollUntil(
  client: Client,
  opts: { path: string; expr: string; intervalMs: number; timeoutMs: number },
): Promise<{ ok: boolean; body: unknown; lastError?: string }> {
  const deadline = Date.now() + opts.timeoutMs;
  let body: unknown = null;
  let lastError: string | undefined;
  for (;;) {
    let res: CliResponse | null = null;
    try {
      res = await client.request('GET', opts.path);
    } catch (err) {
      lastError = `GET ${opts.path} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (res && !res.ok) {
      const b = res.body as { error?: unknown } | null;
      const msg = b && typeof b === 'object' && 'error' in b ? String(b.error) : typeof res.body === 'string' ? res.body : '';
      lastError = `GET ${opts.path} answered ${res.status}: ${msg}`;
    } else if (res) {
      lastError = undefined;
      body = res.body;
      let matched = false;
      try {
        matched = evalCondition(opts.expr, res.body);
      } catch (err) {
        throw new Error(`--until expression error: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (matched) return { ok: true, body };
    }
    if (Date.now() >= deadline) return { ok: false, body, ...(lastError ? { lastError } : {}) };
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
}
