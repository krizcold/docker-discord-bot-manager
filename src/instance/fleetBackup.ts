/**
 * Fleet Postgres Sidecar Backup Scheduler
 *
 * Runs on a 1-minute tick. Daily pg_dump of manager-provisioned fleet Postgres
 * sidecars ONLY: an instance is in scope when it carries a fleetDb record AND
 * its stored DATA_BACKEND_URL still points at that sidecar container. External
 * databases are never dumped.
 *
 * Dumps stream to <DATA_DIR>/backups/<botId>/fleet-postgres/<ISO>.dump with a
 * keep-newest retention trim (pre-restore-*.dump files are exempt). Restore
 * stops every instance sharing the URL, takes a pre-restore safety dump, runs
 * pg_restore --clean --if-exists, then restarts the stopped instances.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, execFile } from 'child_process';
import * as containerManager from '../docker/containerManager';
import * as envManager from '../env/manager';
import { InstanceConfig, FleetBackupConfig } from '../types';

const TICK_INTERVAL_MS = 60 * 1000; // 1 minute
const REFIRE_GUARD_MS = 23 * 60 * 60 * 1000; // prevents double-fire within the hour window
const DUMP_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const STALE_AFTER_MS = 36 * 60 * 60 * 1000;

const DATA_DIR = process.env.DATA_DIR || '/data/data';

let intervalHandle: ReturnType<typeof setInterval> | null = null;

// Last dump attempt per instance (in-memory; persisted success lives on the record)
const lastAttempts: Map<string, number> = new Map();
// Last dump/restore error per instance (in-memory, surfaced on the bot card)
const lastErrors: Map<string, string> = new Map();
// Instances with a dump or restore in flight
const busy: Set<string> = new Set();

export function getFleetBackupError(botId: string): string | null {
  return lastErrors.get(botId) || null;
}

/**
 * Effective schedule for an instance; absent config means the defaults for
 * instances that have a fleetDb record.
 */
export function effectiveFleetBackup(instance: InstanceConfig): FleetBackupConfig {
  return instance.fleetBackup || { enabled: true, hour: 4, keep: 7 };
}

/**
 * Scope guard: dump only what the manager provisioned. True when the instance
 * has a fleetDb record AND the stored DATA_BACKEND_URL's hostname still equals
 * the sidecar container name.
 */
export function isFleetBackupScoped(instance: InstanceConfig): boolean {
  if (!instance.fleetDb) return false;
  const url = (envManager.getEnvVars(instance.id)['DATA_BACKEND_URL'] || '').trim();
  if (!url) return false;
  try {
    return new URL(url).hostname === instance.fleetDb.containerName;
  } catch {
    return false;
  }
}

/**
 * Stale when enabled + in scope and no successful dump within 36h. A never-
 * dumped instance is measured from its creation so a fresh install does not
 * warn before its first scheduled run.
 */
export function isFleetBackupStale(instance: InstanceConfig): boolean {
  if (!effectiveFleetBackup(instance).enabled) return false;
  if (!isFleetBackupScoped(instance)) return false;
  const baseline = instance.lastFleetBackupAt || Date.parse(instance.createdAt) || 0;
  return Date.now() - baseline > STALE_AFTER_MS;
}

function backupDir(botId: string): string {
  return path.join(DATA_DIR, 'backups', botId, 'fleet-postgres');
}

function isContainerRunning(containerName: string): Promise<boolean> {
  return new Promise(resolve => {
    execFile('docker', ['inspect', '-f', '{{.State.Running}}', containerName], (err, stdout) => {
      resolve(!err && String(stdout).trim() === 'true');
    });
  });
}

/**
 * List dump files for an instance, newest first.
 */
export function listFleetBackups(botId: string): Array<{ file: string; size: number; mtime: number }> {
  const dir = backupDir(botId);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: Array<{ file: string; size: number; mtime: number }> = [];
  for (const name of names) {
    if (!name.endsWith('.dump')) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      out.push({ file: name, size: st.size, mtime: st.mtimeMs });
    } catch { /* raced deletion */ }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/**
 * Keep the newest `keep` dumps; pre-restore-*.dump safety dumps are exempt.
 */
function trimFleetBackups(botId: string, keep: number): void {
  const dir = backupDir(botId);
  const trimmable = listFleetBackups(botId).filter(f => !f.file.startsWith('pre-restore-'));
  for (const f of trimmable.slice(keep)) {
    try {
      fs.unlinkSync(path.join(dir, f.file));
    } catch (err) {
      console.warn(`[FleetBackup] Failed to trim ${f.file} for ${botId}:`, err);
    }
  }
}

/**
 * One pg_dump of the instance's sidecar, streamed to a .tmp then renamed.
 * `prefix` names safety dumps (pre-restore-). Skips when the container is not
 * running (scheduler) / fails hard for callers that need the dump.
 */
export async function runFleetDump(
  instance: InstanceConfig,
  prefix = ''
): Promise<{ success: boolean; file?: string; error?: string }> {
  const fleetDb = instance.fleetDb;
  if (!fleetDb) return { success: false, error: 'No fleet database record' };

  if (!await isContainerRunning(fleetDb.containerName)) {
    return { success: false, error: 'Database container is not running' };
  }

  const dir = backupDir(instance.id);
  fs.mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `${prefix}${stamp}.dump`;
  const finalPath = path.join(dir, fileName);
  const tmpPath = `${finalPath}.tmp`;

  return new Promise(resolve => {
    const child = spawn('docker', ['exec', fleetDb.containerName, 'pg_dump', '-U', fleetDb.user, '-Fc', fleetDb.db]);
    const out = fs.createWriteStream(tmpPath);
    let stderr = '';
    let killed = false;
    let settled = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, DUMP_TIMEOUT_MS);

    const fail = (error: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      out.destroy();
      try { fs.unlinkSync(tmpPath); } catch { /* already gone */ }
      resolve({ success: false, error });
    };

    child.stdout.pipe(out);
    child.stderr.on('data', d => { if (stderr.length < 4000) stderr += d.toString(); });
    child.on('error', err => fail(`Failed to run docker exec: ${err.message}`));
    out.on('error', err => {
      child.kill('SIGKILL');
      fail(`Failed to write dump file: ${err.message}`);
    });

    child.on('close', code => {
      if (settled) return;
      if (killed) return fail(`Dump timed out after ${DUMP_TIMEOUT_MS / 60000} minutes`);
      if (code !== 0) return fail(`pg_dump exited with code ${code}: ${stderr.trim().slice(0, 500)}`);
      out.end(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          fs.renameSync(tmpPath, finalPath);
          resolve({ success: true, file: fileName });
        } catch (err) {
          try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
          resolve({ success: false, error: `Failed to finalize dump file: ${err}` });
        }
      });
    });
  });
}

async function runScheduledDump(instance: InstanceConfig): Promise<void> {
  busy.add(instance.id);
  try {
    const result = await runFleetDump(instance);
    if (result.success) {
      lastErrors.delete(instance.id);
      containerManager.setLastFleetBackupAt(instance.id, Date.now());
      trimFleetBackups(instance.id, effectiveFleetBackup(instance).keep);
      console.log(`[FleetBackup] Dumped ${instance.displayName} (${instance.id}) -> ${result.file}`);
    } else {
      lastErrors.set(instance.id, result.error || 'unknown error');
      console.error(`[FleetBackup] Dump failed for ${instance.displayName} (${instance.id}): ${result.error}`);
    }
  } finally {
    busy.delete(instance.id);
  }
}

async function runFleetBackupTick(): Promise<void> {
  const currentHour = new Date().getHours();
  for (const instance of containerManager.getAllBots()) {
    if (!instance.fleetDb || busy.has(instance.id)) continue;
    const config = effectiveFleetBackup(instance);
    if (!config.enabled || currentHour !== config.hour) continue;
    if (!isFleetBackupScoped(instance)) continue;

    const last = Math.max(lastAttempts.get(instance.id) || 0, instance.lastFleetBackupAt || 0);
    if (Date.now() - last < REFIRE_GUARD_MS) continue;

    lastAttempts.set(instance.id, Date.now());
    await runScheduledDump(instance);
  }
}

/**
 * Restore a dump into the instance's sidecar. In order: stop every managed
 * instance whose stored DATA_BACKEND_URL is exactly this URL, take a
 * pre-restore safety dump (refusing the restore if it fails), pg_restore the
 * chosen file, restart the stopped instances.
 */
export async function restoreFleetBackup(
  botId: string,
  file: string
): Promise<{ success: boolean; error?: string; steps: { stopped: string[]; preRestoreDump: string | null; restored: boolean; restarted: string[] } }> {
  const steps: { stopped: string[]; preRestoreDump: string | null; restored: boolean; restarted: string[] } = {
    stopped: [], preRestoreDump: null, restored: false, restarted: [],
  };

  if (file.includes('/') || file.includes('\\') || file.includes('..') || !file.endsWith('.dump')) {
    return { success: false, error: 'Invalid dump file name', steps };
  }

  const instance = containerManager.getBot(botId);
  const fleetDb = instance?.fleetDb;
  if (!instance || !fleetDb) return { success: false, error: 'No fleet database record', steps };

  const dumpPath = path.join(backupDir(botId), file);
  if (!fs.existsSync(dumpPath)) return { success: false, error: 'Dump file not found', steps };

  const url = (envManager.getEnvVars(botId)['DATA_BACKEND_URL'] || '').trim();
  if (!url) return { success: false, error: 'Instance has no stored database URL', steps };

  if (busy.has(botId)) return { success: false, error: 'A backup operation is already in progress', steps };
  busy.add(botId);
  try {
    // 1. Stop every running managed instance on this exact URL
    const sharing = containerManager.getAllBots().filter(b =>
      (envManager.getEnvVars(b.id)['DATA_BACKEND_URL'] || '').trim() === url
    );
    for (const b of sharing) {
      if (b.status !== 'running') continue;
      const stop = await containerManager.stopBot(b.id);
      if (!stop.success) {
        // Nothing was restored yet: bring back what we already stopped and refuse.
        for (const id of steps.stopped) {
          const start = await containerManager.startBot(id);
          if (start.success) steps.restarted.push(id);
        }
        return { success: false, error: `Could not stop instance ${b.displayName}: ${stop.error}`, steps };
      }
      steps.stopped.push(b.id);
    }

    // 2. Pre-restore safety dump; a failure refuses the whole restore
    const safety = await runFleetDump(instance, 'pre-restore-');
    if (!safety.success) {
      lastErrors.set(botId, `Pre-restore dump failed: ${safety.error}`);
      return { success: false, error: `Pre-restore dump failed, restore refused: ${safety.error}`, steps };
    }
    steps.preRestoreDump = safety.file || null;

    // 3. pg_restore with the dump streamed to stdin
    const restore = await new Promise<{ success: boolean; error?: string }>(resolve => {
      const child = spawn('docker', ['exec', '-i', fleetDb.containerName, 'pg_restore', '-U', fleetDb.user, '--clean', '--if-exists', '-d', fleetDb.db]);
      const input = fs.createReadStream(dumpPath);
      let stderr = '';
      let killed = false;
      let settled = false;

      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, DUMP_TIMEOUT_MS);

      const finish = (result: { success: boolean; error?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.destroy();
        resolve(result);
      };

      input.pipe(child.stdin);
      input.on('error', err => {
        child.kill('SIGKILL');
        finish({ success: false, error: `Failed to read dump file: ${err.message}` });
      });
      child.stdin.on('error', () => { /* EPIPE when the child dies first; close handles it */ });
      child.stderr.on('data', d => { if (stderr.length < 4000) stderr += d.toString(); });
      child.on('error', err => finish({ success: false, error: `Failed to run docker exec: ${err.message}` }));
      child.on('close', code => {
        if (killed) return finish({ success: false, error: `Restore timed out after ${DUMP_TIMEOUT_MS / 60000} minutes` });
        if (code !== 0) return finish({ success: false, error: `pg_restore exited with code ${code}: ${stderr.trim().slice(0, 500)}` });
        finish({ success: true });
      });
    });

    if (restore.success) {
      steps.restored = true;
      lastErrors.delete(botId);
    } else {
      lastErrors.set(botId, `Restore failed: ${restore.error}`);
    }

    // 4. Restart the instances stopped in step 1
    for (const id of steps.stopped) {
      const start = await containerManager.startBot(id);
      if (start.success) steps.restarted.push(id);
      else console.error(`[FleetBackup] Failed to restart ${id} after restore: ${start.error}`);
    }

    if (!restore.success) return { success: false, error: restore.error, steps };
    return { success: true, steps };
  } finally {
    busy.delete(botId);
  }
}

/**
 * Start the fleet backup scheduler.
 */
export function startFleetBackupScheduler(): void {
  if (intervalHandle) return;

  console.log(`[FleetBackup] Started (tick: ${TICK_INTERVAL_MS / 1000}s)`);

  intervalHandle = setInterval(() => {
    runFleetBackupTick().catch(err => {
      console.error('[FleetBackup] Tick error:', err);
    });
  }, TICK_INTERVAL_MS);
}

/**
 * Stop the fleet backup scheduler.
 */
export function stopFleetBackupScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[FleetBackup] Stopped');
  }
}
