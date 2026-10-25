/**
 * The per-instance backup slot and the write fence's pg_hba mark. They live apart from fleetBackup so that
 * fleetReplication reads them without importing fleetBackup, which imports appLifecycle, which imports
 * fleetReplication.
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
