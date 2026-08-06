/**
 * The two async-observability primitives: block on a terminal WS broadcast (--wait
 * on lifecycle verbs) and poll a GET route until a condition holds (`wait --until`).
 */

import { Client } from './client';

export interface WaitOutcome {
  ok: boolean;
  event: { type: string; data: unknown };
}

/**
 * Subscribe to /ws, then run `trigger` (which fires the POST). Resolve with the
 * first broadcast whose type is in successTypes/failTypes and whose id matches.
 * Subscribing before triggering avoids missing a fast completion event.
 */
export function waitForEvent(
  client: Client,
  opts: { successTypes: string[]; failTypes: string[]; matchId?: string; timeoutMs: number },
  trigger: () => Promise<void>,
): Promise<WaitOutcome> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (r: WaitOutcome | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.close();
      if (r instanceof Error) reject(r);
      else resolve(r);
    };

    const timer = setTimeout(() => finish(new Error('timed out waiting for completion event')), opts.timeoutMs);

    const matches = (msg: { type: string; data: unknown }): 'ok' | 'fail' | null => {
      const isSuccess = opts.successTypes.includes(msg.type);
      const isFail = opts.failTypes.includes(msg.type);
      if (!isSuccess && !isFail) return null;
      if (opts.matchId) {
        const d = msg.data as { id?: string } | null;
        if (!d || d.id !== opts.matchId) return null;
      }
      return isSuccess ? 'ok' : 'fail';
    };

    const conn = client.openWs(
      (msg) => {
        const verdict = matches(msg);
        if (verdict) finish({ ok: verdict === 'ok', event: msg });
      },
      () => {
        trigger().catch((err) => finish(err instanceof Error ? err : new Error(String(err))));
      },
    );
  });
}

/** Evaluate a `--until` expression against a response body. `data` is the JSON body. */
function evalCondition(expr: string, data: unknown): boolean {
  // Test-tool only: the expression is operator-supplied, never untrusted input.
  const fn = new Function('data', `"use strict"; return (${expr});`) as (d: unknown) => unknown;
  return Boolean(fn(data));
}

export async function pollUntil(
  client: Client,
  opts: { path: string; expr: string; intervalMs: number; timeoutMs: number },
): Promise<{ ok: boolean; body: unknown }> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const res = await client.request('GET', opts.path);
    let matched = false;
    try {
      matched = evalCondition(opts.expr, res.body);
    } catch (err) {
      throw new Error(`--until expression error: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (matched) return { ok: true, body: res.body };
    if (Date.now() >= deadline) return { ok: false, body: res.body };
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
}
