/**
 * Typed client for an app's manager-facing lifecycle hooks (PLAN_REPLICATION
 * 20.16). The manager dials the app container by name over the shared network
 * and authenticates with the per-instance token it already mints and injects.
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
  /** The request went out and no answer came back in time: the app may have acted. */
  unknown?: boolean;
}

/** Long enough for a promote's own phases; past it the outcome is unknown, not failed. */
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
    if (err instanceof Error && err.name === 'TimeoutError') {
      if (method !== 'POST') return { ok: false, error: `${action} did not answer within ${Math.round(timeoutMs / 1000)} s` };
      return { ok: false, unknown: true, error: `${action} sent, no answer within ${Math.round(timeoutMs / 1000)} s; check the app's Fleet view before retrying` };
    }
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

export interface AppFacts {
  running: boolean;
  initialized: boolean;
  role: string | null;
  nodeId: string | null;
  nodeName: string | null;
  term: number | null;
  standalone: boolean;
  backupMaster: boolean;
  /** The running bot's consent to active backup mode, as it booted; the saved env may differ until the container is recreated. */
  activeCapable?: boolean;
  /** The app's own verdict that this node is where the copy block belongs. */
  copyBlockTarget: boolean;
  superseded: { byNodeId: string; byNodeName: string; term: number; retireRequested: boolean; at: number; source: string; steppedDown: boolean } | null;
  promote: any;
  emptyStoreHold: any;
  takeoverHold: any;
  staleMasterPark: { observedTerm: number; localTerm: number; peerUrl: string; at: number } | null;
  copyBlock: { dsn: string; cert: string; publishedAt: number } | null;
  /** The app's own verdict that the block names the database this node follows; null when it holds none or cannot tell. */
  copyBlockCurrent?: boolean | null;
  /** The app's own verdict that the block names the database it FOLLOWS while holding or after a step-down (B6 map F32): the source the failback re-seeds from. */
  copyBlockFollowed?: boolean | null;
  /** The app's container carries a standby endpoint (it learned its standby); null while the bot is down. */
  dbReplica?: boolean | null;
  /** The primary's last word on this node's standby slot, as the app recorded it (20.17); null when none. */
  standbySlot: {
    slotName: string; walStatus: string; active: boolean; retainedBytes: number | null;
    observedAt: number; receivedAt: number; fromNodeId: string; fromTerm: number; sourceIsCurrentMaster: boolean | null;
    sourceAt: number;
  } | null;
  /** The app's own verdict: the fact is fresh, the slot is lost, and it is on the master this copy follows. */
  standbySlotLost: boolean;
}

export interface ActionResult {
  success: boolean;
  error?: string;
  /** The app asked for an explicit confirmation before it will act. */
  needsConfirm?: boolean;
  /** role-reset: whether the app also dropped the store forms it had persisted (false where its environment pins none). */
  formsCleared?: boolean;
  /** The request went out and no answer came back in time: the app may have acted. */
  unknown?: boolean;
  /** The app wants the RPO acknowledged before promoting. */
  needsLagConfirm?: boolean;
  /** The app says another designated backup received further than this copy (20.19 F14). */
  needsLineageConfirm?: boolean;
  /** The app wants it acknowledged that other instances cannot reach this one once it is the primary side. */
  needsReachabilityConfirm?: boolean;
  lagMs?: number | null;
  restartRequired?: boolean;
  [key: string]: unknown;
}

/**
 * An instance hosting a companion database whose app declares no capability
 * record is a configuration hole, not a plain app: the manager would silently
 * treat it as having no companion and skip provisioning and retirement for a
 * database that really exists. Refuse loudly instead (PLAN_REPLICATION 20.16
 * carried-forward guard).
 */
export function capabilityRefusal(instance: InstanceConfig): string | null {
  const hasCompanion = !!instance.fleetDb || !!instance.fleetDbReplica;
  if (!hasCompanion) return null;
  if (findAppCapabilities(instance.sourceUrl)?.companionDb) return null;
  return 'This instance runs a managed database but its app declares no capability record, so the manager cannot tell how to provision or retire it. Add a record for this source before using the database lifecycle here.';
}

/** The app's recorded facts, or a named reason they could not be read. */
export async function getAppFacts(instance: InstanceConfig, timeoutMs?: number): Promise<{ success: boolean; facts?: AppFacts; error?: string }> {
  if (!hasAppHooks(instance)) return { success: false, error: 'this app declares no lifecycle hooks' };
  const result = await callAppHook<AppFacts & { success: boolean }>(instance, 'facts', 'GET', undefined, timeoutMs);
  if (!result.ok) return { success: false, error: result.error };
  return { success: true, facts: result.body as AppFacts };
}

/**
 * A container that just started serves its hooks only once its web server
 * listens; callers that start it and then need it wait here, bounded.
 */
export async function waitForAppHook(instance: InstanceConfig, deadlineMs: number): Promise<ActionResult> {
  const deadline = Date.now() + deadlineMs;
  let last = 'no answer yet';
  for (;;) {
    const facts = await getAppFacts(instance, 5_000);
    if (facts.success) return { success: true };
    last = facts.error || last;
    if (Date.now() >= deadline) {
      return { success: false, error: `the app did not answer its hooks within ${Math.round(deadlineMs / 1000)} s (${last})` };
    }
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
}
