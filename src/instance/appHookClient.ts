/**
 * Typed client for an app's manager-facing lifecycle hooks (PLAN_REPLICATION
 * 20.16). The manager dials the app container by name over the shared network,
 * the same route recoveryRescue uses for the relay, and authenticates with the
 * per-instance token it already mints and injects.
 *
 * The app's browser API is authenticated at the deployment boundary and is
 * deliberately open inside the container, so it is never what this drives: the
 * hook surface takes the token instead.
 */
import * as containerManager from '../docker/containerManager';
import { fleetAppContainerName } from '../templates/pcsProcessing';
import { findAppCapabilities, AppHookAction, AppHooksSpec } from '../config/appCapabilities';
import { InstanceConfig } from '../types';

export interface AppHookResult<T = any> {
  ok: boolean;
  body?: T;
  error?: string;
}

/** Long enough for a promote's own phases; the app answers or it has failed. */
const HOOK_TIMEOUT_MS = 180_000;

interface ResolvedEndpoint {
  url: string;
  token: string;
}

/** The readable reason behind a fetch failure, parenthesised, or '' if there is none. */
function causeOf(err: Error): string {
  const cause = err.cause;
  if (!(cause instanceof Error)) return '';
  const aggregated = cause instanceof AggregateError && Array.isArray(cause.errors) ? cause.errors : [];
  const nested = aggregated
    .map((e: unknown) => (e instanceof Error ? e.message : ''))
    .filter(Boolean)
    .join('; ');
  const text = cause.message || nested;
  return text ? ` (${text})` : '';
}

/**
 * Where this instance serves its hooks, or a named reason it cannot be reached.
 * Every failure here is an operator-facing string, never a thrown error.
 */
function resolveEndpoint(instance: InstanceConfig, action: AppHookAction): ResolvedEndpoint | { error: string } {
  const caps = findAppCapabilities(instance.sourceUrl);
  const hooks: AppHooksSpec | undefined = caps?.hooks;
  if (!hooks) return { error: 'this app declares no lifecycle hooks' };

  // '' is the registry's key-loss scrub marker (a minted token is never
  // empty); undefined means the token was never minted.
  if (instance.updateToken === '') {
    return { error: 'the stored manager token no longer decrypts (the manager encryption key changed or was lost); restore the key' };
  }
  const token = (instance.updateToken || '').trim();
  if (!token) return { error: 'this instance has no manager token yet (start it once)' };

  const compose = containerManager.readDeployedCompose(instance.id);
  if (!compose) return { error: 'this instance has no deployed compose' };
  const containerName = fleetAppContainerName(compose);
  if (!containerName) return { error: 'could not resolve the app container name' };

  const declared = hooks.portEnvKey ? (instance.envVars?.[hooks.portEnvKey] || '').trim() : '';
  const port = /^\d+$/.test(declared) ? Number(declared) : hooks.port;

  const base = hooks.basePath.startsWith('/') ? hooks.basePath : `/${hooks.basePath}`;
  return { url: `http://${containerName}:${port}${base}/${action}`, token };
}

/**
 * Call one lifecycle hook. Answers {ok:false, error} for every failure mode
 * including transport, so callers never need a try/catch.
 */
export async function callAppHook<T = any>(
  instance: InstanceConfig,
  action: AppHookAction,
  method: 'GET' | 'POST' = 'POST',
  body?: unknown,
  timeoutMs: number = HOOK_TIMEOUT_MS,
): Promise<AppHookResult<T>> {
  const resolved = resolveEndpoint(instance, action);
  if ('error' in resolved) return { ok: false, error: resolved.error };

  try {
    const res = await fetch(resolved.url, {
      method,
      headers: {
        'x-bot-token': resolved.token,
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      // A direct container dial has no legitimate redirect; never replay the token.
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const parsed: any = await res.json().catch(() => null);
    if (!res.ok) {
      return { ok: false, error: String(parsed?.error || `${action} returned ${res.status}`) };
    }
    if (!parsed || parsed.success !== true) {
      // A refusal is a real answer, not a transport failure: the app's named
      // reason (and any needsConfirm) rides the body for the caller to surface.
      return { ok: false, body: parsed as T, error: String(parsed?.error || `${action} refused`) };
    }
    return { ok: true, body: parsed as T };
  } catch (err) {
    // fetch reports its real reason (an unexpected redirect, a refused socket)
    // in `cause`; without it every transport failure reads the same. A name that
    // resolves to several addresses fails as an AggregateError whose own message
    // is empty and whose reasons are in `errors`, so read that before giving up.
    const detail = err instanceof Error ? `${err.message}${causeOf(err)}` : String(err);
    return { ok: false, error: `${action} unreachable: ${detail}` };
  }
}

/** Whether this instance's app declares the lifecycle hook contract at all. */
export function hasAppHooks(instance: InstanceConfig): boolean {
  return !!findAppCapabilities(instance.sourceUrl)?.hooks;
}
