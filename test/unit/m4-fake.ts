import { ok, refused } from './m2-fake';
import { botRow } from './m3-fake';

// Bodies shaped as src/webui/routes/bots.ts sends them for the Database screen; each names the line it copies.

export const HOUR = 3_600_000;
// 2026-11-14 10:00 UTC.
export const T0 = Date.UTC(2026, 10, 14, 10, 0);

// One family of fleetBackupStatus (src/instance/fleetBackup.ts:1563 to 1569).
export const family = (over: Record<string, unknown> = {}) => ({
  family: 'main', role: 'the main database', enabled: true, hour: 4, paused: false,
  lastFile: 'hourly-2026-11-14T09-00-00-000Z.dump', lastAt: T0 - HOUR, dataAt: null, lastError: null, failingSince: null, listError: null,
  skip: null, test: { file: 'daily-2026-11-14T04-00-00-000Z.dump', startedAt: T0 - 6 * HOUR, finishedAt: T0 - 6 * HOUR + 60_000, result: 'passed', tables: 12, rows: 3400 },
  alerts: { dumps: null, test: null }, ...over,
});

// fleetBackupStatus (src/instance/fleetBackup.ts:1571 to 1577), as GET /api/bots carries it (bots.ts:66).
export const backupStatus = (over: Record<string, unknown> = {}) => ({
  enabled: true, hour: 4, scoped: true, restoreError: null, restoreErrorAt: null, main: family(), copy: null, ...over,
});

// GET /api/bots rows (bots.ts:200 to 228, botHealth :65, publicBot's maintenance and migrate at containerManager.ts:336).
export const mainBot = (over: Record<string, unknown> = {}) => botRow({
  status: 'running', fleetDb: { containerName: 'smdb-db-b1', replication: null }, fleetBackup: backupStatus(), fenceStuck: null,
  maintenanceDrift: null, maintenance: null, migrate: null, hasDbBackups: undefined, fleetWorker: false, appHooks: true, ...over,
});
export const copyBot = (over: Record<string, unknown> = {}) => botRow({
  status: 'running', fleetDb: null, fleetDbReplica: { containerName: 'smdb-replica-b1' }, fleetBackup: backupStatus({ main: null, copy: family({ family: 'copy' }) }),
  hasDbBackups: true, fleetWorker: true, appHooks: true, maintenance: null, migrate: null, ...over,
});
export const hooksBot = (over: Record<string, unknown> = {}) => botRow({ status: 'running', appHooks: true, hasDbBackups: false, fleetWorker: false, dataPlace: 'json', ...over });

// GET /api/bots/:id/maintenance (bots.ts:528 to 538, maintenance.ts:734).
export const maintenanceBody = (summary = 'State: Running.') => ok({
  success: true, state: 'running', message: '', settled: true, kind: 'database', orderedAt: '2026-11-14T08:00:00.000Z', lastError: null, summary, held: null,
});

// GET /api/bots/:id/memory (bots.ts:1009 to 1018, memoryRoom.ts:59).
export const memoryBody = (over: Record<string, unknown> = {}) => ok({
  success: true, memory: { running: true, room: true, useMb: 300, freeMb: 2048, at: '2026-11-14T10:00:00.000Z', ...over },
});

// GET /api/bots/:id/fleet-connections (bots.ts:1847 to 1856, fleetReplication.ts:1013).
export const connectionsBody = (connections: Record<string, unknown> = { state: 'none' }) => ok({ success: true, connections });

// GET /api/bots/:id/fleet-backups (bots.ts:1722 to 1742); BackupEntry of fleetBackup.ts:972.
export const entry = (file: string, over: Record<string, unknown> = {}) => ({
  file, size: 5_400_000, mtime: T0 - HOUR, kind: 'hourly', family: 'main', takenAt: T0 - HOUR, tables: 12, rows: 3400, dataAt: null, test: null, ...over,
});
export const backupsBody = (backups: unknown[]) => ok({ success: true, backups });

// GET /api/bots/:id/fleet-replica (bots.ts:1954 to 1971; fleetReplica.ts:447, fleetCopyWatch.ts:381 and :406).
export const replicaBody = (replica: Record<string, unknown> | null = { present: false }, over: Record<string, unknown> = {}) => ok({
  success: true, replica, copyBackup: null, join: null, rebuild: null, ...over,
});

// GET /api/bots/:id/fleet-replication (bots.ts:1832 to 1844, fleetReplication.ts:751).
export const replicationOff = () => ok({ success: true, replication: { enabled: false } });
export const replicationOn = (over: Record<string, unknown> = {}) => ok({
  success: true,
  replication: {
    enabled: true, publicHost: 'db.example.net', hostPort: 15432,
    live: {
      sslOn: true, standbys: [], slotWalKeep: '4096MB',
      slots: [{
        slot: 'smdb_copy_a', fleet: true, walStatus: 'reserved', active: true, retainedBytes: 1_048_576, clientAddr: '10.0.0.5', state: 'streaming',
        replayLagSeconds: 0.4, behindBytes: 0, machine: 'yundera', address: null,
      }],
    },
    reachability: { ok: true, ageSeconds: 12 },
    ...over,
  },
});

// GET /api/bots/:id/fleet-switch (bots.ts:2067 to 2078, fleetSwitch.ts:1690 and :1762).
export const switchBody = (over: Record<string, unknown> = {}) => ok({
  success: true, lines: [], badges: [], handover: null, receive: null, replacedBy: null, mainConflict: null, takeover: null, copies: [],
  generation: { machine: 'contabo', generation: 3, since: '2026-11-01T12:30:00.000Z' }, ...over,
});

// GET /api/bots/fleet/orphan-backups (bots.ts:1704 to 1717, fleetBackup.ts:1026).
export const orphansBody = (folders: unknown[] = []) => ok({ success: true, folders });
export const registryBroken = () => refused(503, { success: false, broken: true, error: 'instances.json cannot be read' });

// The 404 every :id route sends for an unknown bot, and the 500 of every catch.
export const notFound = () => refused(404, { success: false, error: 'Bot not found' });
export const failed500 = (text: string) => refused(500, { success: false, error: text });

// GET /api/bots/:id/maintenance with the record fields (maintenance.ts:747 to 751).
export const stateInfo = (over: Record<string, unknown> = {}) => ok({
  success: true, state: 'running', message: '', settled: true, kind: 'database', orderedAt: '2026-11-14T08:00:00.000Z', lastError: null,
  summary: 'State: Running.', held: null, ...over,
});

// PUT /api/bots/:id/maintenance (bots.ts:571 to 592): accepted with an opId; a refusal carries the admission's status.
export const stateAccepted = (opId: string) => ok({ success: true, opId });
export const stateBusy = () => refused(409, { success: false, error: "Operation 'update' already in progress" });

// GET /api/bots/:id/migrate (bots.ts:542 to 553), migrateView (migrate.ts:787 to 790).
export const migrateBody = (over: Record<string, unknown> = {}) => ok({
  success: true, hidden: false, to: 'postgres', refusal: null, record: null, last: null, sharers: [], fenced: false, destination: 'db:5432/bot', companion: true, ...over,
});
// POST /api/bots/:id/migrate (bots.ts:556 to 568).
export const migrateAccepted = () => ok({ success: true, opId: 'mig-1' });
