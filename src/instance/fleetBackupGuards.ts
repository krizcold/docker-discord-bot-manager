/**
 * The per-instance backup slot and the write fence's pg_hba mark. They live apart from fleetBackup so that
 * fleetReplication reads them without importing fleetBackup.
 */

import * as containerManager from '../docker/containerManager';

// Instances with a dump or restore in flight
export const busy: Set<string> = new Set();
/** The slots another module took through claimFleetBackupBusy; fleetBackup's own dumps and restores are not in it. */
export const externalClaims = new Set<string>();

/**
 * Cross-module claim of the per-instance backup-op slot, so a destructive
 * lane (decommission) and fleetBackup's own dump/restore can never
 * interleave: restore and the scheduled dump refuse while it is claimed,
 * and the claimer refuses while a dump or restore is in flight.
 */
export function claimFleetBackupBusy(botId: string): boolean {
  if (busy.has(botId) || containerManager.isShuttingDown()) return false;
  busy.add(botId);
  externalClaims.add(botId);
  return true;
}

export function releaseFleetBackupBusy(botId: string): void {
  busy.delete(botId);
  externalClaims.delete(botId);
}

export function isFleetBackupBusy(botId: string): boolean {
  return busy.has(botId);
}

/** Every pg_hba line the write fence writes ends with this; a lift removes each line that does. */
export const WRITE_FENCE_MARK = '# smdb-write-fence';

/** The count of pg_hba lines the write fence wrote, as the server reads its own pg_hba file. */
export const FENCE_HBA_COUNT_SQL = `SELECT count(*) FROM regexp_split_to_table(pg_read_file(current_setting('hba_file')), E'\\n') AS line WHERE line LIKE '%${WRITE_FENCE_MARK}'`;

/** Each fence line names its lane before the mark: `... reject # smdb-fence-owner=<lane>:<ms> # smdb-write-fence`. */
export const FENCE_OWNER_TAG = '# smdb-fence-owner=';

/** The owners the fence's pg_hba lines name, distinct and comma-joined; '-' stands for a line that names none. */
export const FENCE_HBA_OWNER_SQL = `SELECT coalesce(string_agg(DISTINCT coalesce(substring(line from 'smdb-fence-owner=([a-z]+:[0-9]+) '), '-'), ','), '') FROM regexp_split_to_table(pg_read_file(current_setting('hba_file')), E'\\n') AS line WHERE line LIKE '%${WRITE_FENCE_MARK}'`;

/** The read-only layer's owner lives in this file in PGDATA, written as root before the layer is set. */
export const FENCE_OWNER_FILE = 'smdb-fence-owner';

/** The owner file's content, '' when it is missing (the sidecar's superuser may read it). */
export const FENCE_OWNER_FILE_SQL = `coalesce(btrim(pg_read_file('${FENCE_OWNER_FILE}', true), E' \\n'), '')`;

/** The lanes that name themselves on a fence layer, as lane:<epoch ms>. */
export type FenceLane = 'restore' | 'reseed' | 'decommission';
const OWNER_RE = /^(restore|reseed|decommission):(\d+)$/;

/** An owner read back from a layer; null when the text names no lane (a promote's layer, a hand fence, or several owners). */
export function parseFenceOwner(text: string | null | undefined): string | null {
  const t = String(text ?? '').trim();
  return OWNER_RE.test(t) ? t : null;
}

export function fenceOwnerLane(owner: string | null): FenceLane | null {
  const m = owner ? OWNER_RE.exec(owner) : null;
  return m ? m[1] as FenceLane : null;
}

const LANE_WORDS: Record<FenceLane, string> = {
  restore: 'a restore', reseed: 'a re-seed', decommission: 'a decommission',
};

/** The owner as the operator reads it: the lane and when its run started; null names no lane of this manager. */
export function fenceOwnerText(owner: string | null): string {
  const m = owner ? OWNER_RE.exec(owner) : null;
  if (!m) return 'no lane of this manager (a promote by the bot, or a fence set by hand)';
  return `${LANE_WORDS[m[1] as FenceLane]} (started ${new Date(Number(m[2])).toISOString().slice(0, 16).replace('T', ' ')} UTC)`;
}
