/**
 * Manager-side wrapper over an app's own lifecycle decisions (PLAN_REPLICATION
 * 20.13/20.16/20.17, stage B4m-2a). Every DECISION here belongs to the app and
 * is reached through its hooks; this module only turns the operator's click into
 * a hook call, and performs the docker and data-directory work the app's own
 * recorded facts imply. It never decides who should be master.
 */
import * as containerManager from '../docker/containerManager';
import { getReplicaCopyBlock } from './fleetReplication';
import { callAppHook, hasAppHooks } from './appHookClient';
import { findAppCapabilities } from '../config/appCapabilities';
import { InstanceConfig } from '../types';

export interface AppFacts {
  running: boolean;
  initialized: boolean;
  role: string | null;
  nodeId: string | null;
  nodeName: string | null;
  term: number | null;
  standalone: boolean;
  backupMaster: boolean;
  /** The app's own verdict that this node is where the copy block belongs. */
  copyBlockTarget: boolean;
  superseded: { byNodeId: string; byNodeName: string; term: number; retireRequested: boolean; at: number; source: string; steppedDown: boolean } | null;
  promote: any;
  emptyStoreHold: any;
  takeoverHold: any;
  staleMasterPark: any;
  copyBlock: { dsn: string; cert: string; publishedAt: number } | null;
}

export interface ActionResult {
  success: boolean;
  error?: string;
  /** The app asked for an explicit confirmation before it will act. */
  needsConfirm?: boolean;
  /** The app wants the RPO acknowledged before promoting. */
  needsLagConfirm?: boolean;
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

/** Translate a hook result into the flat shape the routes and UI expect. */
function fromHook(result: { ok: boolean; body?: any; error?: string }): ActionResult {
  if (result.ok) return { success: true, ...(result.body ?? {}) };
  // A refusal carries the app's own named reason plus any confirm flags; a
  // transport failure has no body and only the error survives.
  const body = result.body ?? {};
  return { ...body, success: false, error: result.error || body.error || 'the app refused' };
}

/** The app's recorded facts, or a named reason they could not be read. */
export async function getAppFacts(instance: InstanceConfig): Promise<{ success: boolean; facts?: AppFacts; error?: string }> {
  if (!hasAppHooks(instance)) return { success: false, error: 'this app declares no lifecycle hooks' };
  const result = await callAppHook<AppFacts & { success: boolean }>(instance, 'facts', 'GET');
  if (!result.ok) return { success: false, error: result.error };
  return { success: true, facts: result.body as AppFacts };
}

/**
 * Deliver when what the app holds is missing or no longer names this machine's
 * endpoint. A promoted node inherits the OLD master's block, so "already has
 * one" is not "has the right one", and keying on the endpoint keeps a steady
 * fleet from paying a docker exec on every poll.
 *
 * It does NOT detect a rotated certificate behind an unchanged host and port:
 * the sites that rotate in place call deliverCopyBlock directly instead.
 */
export async function ensureCopyBlockCurrent(
  instance: InstanceConfig,
  held: { dsn: string } | null,
): Promise<ActionResult & { delivered: boolean }> {
  const replication = instance.fleetDb?.replication;
  if (!replication) return { success: true, delivered: false };
  if (held?.dsn) {
    try {
      const url = new URL(held.dsn);
      const port = url.port || '5432';
      if (url.hostname === replication.publicHost && port === String(replication.hostPort)) {
        return { success: true, delivered: false };
      }
    } catch { /* unparseable means stale by definition */ }
  }
  const published = await deliverCopyBlock(instance);
  return { ...published, delivered: published.success };
}

/**
 * Give this node's app the copy block for the database it hosts, so it can relay
 * it to designated backups on register (20.14). Only the manager can produce it:
 * the replicator password and the server certificate live in the sidecar it owns.
 * Safe to call repeatedly - the app just overwrites its copy.
 */
export async function deliverCopyBlock(instance: InstanceConfig): Promise<ActionResult> {
  if (!instance.fleetDb?.replication) return { success: false, error: 'replication is not enabled on this instance' };
  if (!hasAppHooks(instance)) return { success: false, error: 'this app declares no lifecycle hooks' };
  const block = await getReplicaCopyBlock(instance);
  if (!block.success || !block.dsn || !block.cert) {
    return { success: false, error: block.error || 'could not assemble the copy block' };
  }
  return fromHook(await callAppHook(instance, 'copy-block', 'POST', { dsn: block.dsn, cert: block.cert }));
}

/**
 * Promote this whole side. With the old master alive the app takes its zero-loss
 * transfer path; with it gone, the RPO-confirmed failover path. retireOldMaster
 * is [Transfer and retire]: the instruction is relayed to the old master's bot
 * for ITS manager to act on, never executed from here.
 */
export async function transfer(
  instance: InstanceConfig,
  opts: { confirmLag?: boolean; retireOldMaster?: boolean } = {},
): Promise<ActionResult> {
  const refusal = capabilityRefusal(instance);
  if (refusal) return { success: false, error: refusal };
  return fromHook(await callAppHook(instance, 'promote', 'POST', {
    confirmLag: opts.confirmLag === true,
    retireOldMaster: opts.retireOldMaster === true,
  }));
}

/** Demote this master (the 20.12a freeze warning rides needsConfirm). */
export async function demote(instance: InstanceConfig, confirm: boolean): Promise<ActionResult> {
  return fromHook(await callAppHook(instance, 'demote', 'POST', { confirm }));
}
