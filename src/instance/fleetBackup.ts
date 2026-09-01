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
 * order: safety dump FIRST (the sidecar is a service of the instance's own
 * compose project, so stopping the host takes the database down with it),
 * courtesy stop of the managed instances this manager can see on the URL,
 * sidecar brought back alone, WRITE FENCE (read-only + terminate sessions -
 * the sweep cannot see a consumer whose DSN lives in the bot's own store, so
 * the fence is the actual protection), pg_restore --clean --if-exists with
 * the restoring session exempted, fence lifted, stopped instances restarted.
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
// A stuck restore write fence, tracked apart from lastErrors: a read-only
// database still DUMPS successfully, so the nightly dump's success would wipe
// a warning parked in the shared slot while the fence still stands.
const fenceStuck: Map<string, string> = new Map();
// Instances with a dump or restore in flight
const busy: Set<string> = new Set();

export function getFleetBackupError(botId: string): string | null {
  return fenceStuck.get(botId) || lastErrors.get(botId) || null;
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
    const host = new URL(url).hostname;
    // The replication posture's canonical URL points at the same sidecar
    // through the published port; it stays in dump scope.
    return host === instance.fleetDb.containerName
      || (!!instance.fleetDb.replication && host === instance.fleetDb.replication.publicHost);
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

function execDocker(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile('docker', args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

type RestoreFleetDb = { containerName: string; user: string; db: string; volume: string };

/**
 * Lift the restore write fence. ALTER SYSTEM persists in the volume's
 * auto.conf, so when the live lift fails the file is stripped instead (the
 * recovery channel's fallback): the LIVE state then stays read-only until the
 * container restarts, which is why 'stripped' is not 'lifted'.
 */
async function liftRestoreFence(fleetDb: RestoreFleetDb): Promise<'lifted' | 'stripped' | 'failed'> {
  const unfence = await execDocker(['exec', fleetDb.containerName, 'psql', '-U', fleetDb.user, '-d', fleetDb.db, '-tA', '-v', 'ON_ERROR_STOP=1',
    '-c', 'SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE',
    '-c', 'ALTER SYSTEM RESET default_transaction_read_only',
    '-c', 'SELECT pg_reload_conf()']);
  if (unfence.ok) return 'lifted';
  const strip = await execDocker(['run', '--rm', '-v', `${fleetDb.volume}:/pgdata`, '--entrypoint', 'sh', 'postgres:16-alpine',
    '-c', "sed -i '/^default_transaction_read_only/d' /pgdata/postgresql.auto.conf"]);
  return strip.ok ? 'stripped' : 'failed';
}

/** Lift and keep the per-bot stuck-fence warning truthful. */
async function liftAndTrack(botId: string, fleetDb: RestoreFleetDb): Promise<'lifted' | 'stripped' | 'failed'> {
  const result = await liftRestoreFence(fleetDb);
  if (result === 'lifted') fenceStuck.delete(botId);
  else fenceStuck.set(botId, 'The database is READ-ONLY (a restore write fence could not be lifted live); restart the instance to clear it');
  return result;
}

/**
 * Seed the stuck-fence warnings from OBSERVED live state at scheduler start,
 * so a manager restart does not silently forget a database a failed lift left
 * read-only. One probe per fleet-database host, once.
 */
async function seedStuckFences(): Promise<void> {
  for (const instance of containerManager.getAllBots()) {
    const db = instance.fleetDb;
    if (!db || fenceStuck.has(instance.id)) continue;
    if (!await isContainerRunning(db.containerName)) continue;
    const probe = await execDocker(['exec', db.containerName, 'psql', '-U', db.user, '-d', db.db, '-tA', '-c', 'SHOW default_transaction_read_only']);
    if (probe.ok && probe.stdout.trim() === 'on') {
      fenceStuck.set(instance.id, 'The database is READ-ONLY (a write fence was not lifted); restart the instance to clear it');
    }
  }
}

/**
 * Self-heal the stuck-fence warning: once the operator restarts the container
 * (the stripped auto.conf comes up clean) the live state is writable again and
 * the warning must go. Cheap - runs only while an entry exists.
 */
async function reprobeStuckFences(): Promise<void> {
  for (const id of Array.from(fenceStuck.keys())) {
    const db = containerManager.getBot(id)?.fleetDb;
    if (!db) { fenceStuck.delete(id); continue; }
    if (!await isContainerRunning(db.containerName)) continue;
    const probe = await execDocker(['exec', db.containerName, 'psql', '-U', db.user, '-d', db.db, '-tA', '-c', 'SHOW default_transaction_read_only']);
    if (probe.ok && probe.stdout.trim() === 'off') fenceStuck.delete(id);
  }
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
  await reprobeStuckFences();
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
 * Restore a dump into the instance's sidecar. In order: pre-restore safety
 * dump (refusing the restore if it fails), courtesy stop of the managed
 * instances this manager can see on the URL, sidecar brought back alone,
 * write fence, pg_restore of the chosen file with the restoring session
 * exempted, fence lifted, stopped instances restarted.
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
  let fenced = false;
  try {
    // 0. A restore must work on a DOWN fleet - that is exactly when it is
    // needed, and starting the whole instance first would boot the bot
    // against the bad data. Bring the database up alone when it is not up.
    if (!await isContainerRunning(fleetDb.containerName)) {
      const started = await containerManager.startFleetDbSidecar(botId);
      if (!started.success) {
        return { success: false, error: `Could not start the database for the restore: ${started.error}`, steps };
      }
    }

    // 1. Pre-restore safety dump FIRST, while the sidecar is up: the sidecar
    // is a service of the instance's own compose project, so the stop below
    // takes it down with the host. The old stop-then-dump order refused
    // every healthy-fleet restore, and returned before the restart loop.
    const safety = await runFleetDump(instance, 'pre-restore-');
    if (!safety.success) {
      lastErrors.set(botId, `Pre-restore dump failed: ${safety.error}`);
      return { success: false, error: `Pre-restore dump failed, restore refused: ${safety.error}`, steps };
    }
    steps.preRestoreDump = safety.file || null;

    // 2. Courtesy stop of every running managed instance this manager can see
    // on this exact URL. It cannot see them all (a worker's DSN lives in the
    // bot's own data/.env, and other machines' instances are out of reach
    // entirely), which is why the fence below is the actual protection.
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

    // 3. Stopping the host took its sidecar down with the compose project;
    // bring the database back alone.
    if (!await isContainerRunning(fleetDb.containerName)) {
      const started = await containerManager.startFleetDbSidecar(botId);
      if (!started.success) {
        for (const id of steps.stopped) {
          const start = await containerManager.startBot(id);
          if (start.success) steps.restarted.push(id);
        }
        return { success: false, error: `Could not start the database for the restore: ${started.error}`, steps };
      }
    }

    // 4. Write fence, the same one the recovery quiesce uses: writes off
    // cluster-wide and every other session terminated, so a consumer the
    // sweep could not see cannot write under pg_restore --clean.
    // ON_ERROR_STOP so a failed ALTER SYSTEM under a succeeding terminate
    // cannot read as a successful fence. fenced is set BEFORE the attempt so
    // a throw mid-fence still reaches the finally lift.
    fenced = true;
    const fence = await execDocker(['exec', fleetDb.containerName, 'psql', '-U', fleetDb.user, '-d', fleetDb.db, '-tA', '-v', 'ON_ERROR_STOP=1',
      '-c', 'SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE',
      '-c', 'ALTER SYSTEM SET default_transaction_read_only = on',
      '-c', 'SELECT pg_reload_conf()',
      '-c', "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND backend_type = 'client backend'"]);
    if (!fence.ok) {
      // A half-applied fence must not survive the refusal. Only a LIVE lift
      // clears it; 'stripped' cleans the persisted copy alone, so the finally
      // must keep retrying and the operator must hear about the read-only risk.
      const cleared = await liftAndTrack(botId, fleetDb);
      if (cleared === 'lifted') fenced = false;
      for (const id of steps.stopped) {
        const start = await containerManager.startBot(id);
        if (start.success) steps.restarted.push(id);
      }
      const fenceWarning = cleared === 'lifted' ? '' : '; the database may be READ-ONLY until its container restarts';
      return { success: false, error: `Could not fence the database for the restore: ${fence.stderr.trim().split('\n').pop()}${fenceWarning}`, steps };
    }

    // 5. pg_restore with the dump streamed to stdin. PGOPTIONS exempts this
    // one session from the fence; everyone else stays read-only. The
    // IN-CONTAINER timeout is load-bearing: killing the docker exec CLIENT
    // leaves the server-side pg_restore alive and fence-exempt, and it would
    // execute its queued DROPs after the lift below - the timeout kills the
    // actual process, and the Node timer is only the backstop behind it.
    const inContainerTimeoutSec = Math.floor(DUMP_TIMEOUT_MS / 1000);
    const restoreStartedAt = Date.now();
    const restore = await new Promise<{ success: boolean; error?: string }>(resolve => {
      const child = spawn('docker', ['exec', '-e', 'PGOPTIONS=-c default_transaction_read_only=off', '-i', fleetDb.containerName,
        'timeout', '-s', 'KILL', String(inContainerTimeoutSec),
        'pg_restore', '-U', fleetDb.user, '--clean', '--if-exists', '-d', fleetDb.db]);
      const input = fs.createReadStream(dumpPath);
      let stderr = '';
      let killed = false;
      let settled = false;

      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, DUMP_TIMEOUT_MS + 30_000);

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
        // 137 = the in-container timeout's KILL; the elapsed guard keeps a
        // genuine externally-killed pg_restore distinguishable.
        if (killed || (code === 137 && Date.now() - restoreStartedAt >= DUMP_TIMEOUT_MS)) {
          return finish({ success: false, error: `Restore timed out after ${DUMP_TIMEOUT_MS / 60000} minutes` });
        }
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

    // 6. On a failed restore, terminate any surviving session BEFORE lifting:
    // a timed-out pg_restore's server-side process is fence-exempt, and left
    // alive it would execute its queued DROPs against the unfenced database.
    if (!restore.success) {
      await execDocker(['exec', fleetDb.containerName, 'psql', '-U', fleetDb.user, '-d', fleetDb.db, '-tA',
        '-c', "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND backend_type = 'client backend'"]);
    }

    // 7. Lift the fence BEFORE the restarts, so instances come back to a
    // writable database. 'stripped' cleans only the persisted copy: the LIVE
    // cluster stays read-only until its container restarts.
    const lift = await liftAndTrack(botId, fleetDb);
    fenced = lift !== 'lifted';
    if (lift !== 'lifted') {
      console.error(`[FleetBackup] Restore fence on ${fleetDb.containerName}: ${lift === 'stripped'
        ? 'live lift failed; auto.conf stripped, the database stays read-only until its container restarts'
        : 'could not be lifted or stripped'}`);
    }
    const liftWarning = lift === 'lifted' ? '' : '; additionally the write fence could not be lifted live, so the database is READ-ONLY until its container restarts';

    // 8. Restart the instances stopped in step 2
    for (const id of steps.stopped) {
      const start = await containerManager.startBot(id);
      if (start.success) steps.restarted.push(id);
      else console.error(`[FleetBackup] Failed to restart ${id} after restore: ${start.error}`);
    }

    if (!restore.success) return { success: false, error: `${restore.error}${liftWarning}`, steps };
    if (lift !== 'lifted') return { success: false, error: 'Restored, but the write fence could not be lifted live: the database is READ-ONLY until its container restarts (see manager logs)', steps };
    return { success: true, steps };
  } finally {
    // The leftover-lift attempt must finish before the busy gate opens, or a
    // retry's fresh fence could be dissolved by this stale lift mid-restore.
    if (fenced) await liftAndTrack(botId, fleetDb);
    busy.delete(botId);
  }
}

/**
 * Start the fleet backup scheduler.
 */
export function startFleetBackupScheduler(): void {
  if (intervalHandle) return;

  console.log(`[FleetBackup] Started (tick: ${TICK_INTERVAL_MS / 1000}s)`);

  seedStuckFences().catch(err => {
    console.error('[FleetBackup] Stuck-fence seed error:', err);
  });

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
